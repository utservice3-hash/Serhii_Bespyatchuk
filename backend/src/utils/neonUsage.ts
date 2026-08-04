/**
 * 📊 ВИТРАТИ КОМПУТУ NEON — спостережність важких джоб. БЕЗ імпортів проєкту.
 *
 * 🔴 НАВІЩО. Бекфіл 35 тис. угод (КРОК 1.4) з'їв compute за годину й поклав прод —
 * і ми дізналися про це ПОСТФАКТУМ, з наслідків. Хелпер дає цифру ДО і ПІСЛЯ
 * важкої джоби, тож «скільки це коштувало» перестає бути здогадом.
 *
 * ⚠️ Стеля квоти на плані Launch знята (оплата за фактом), тож це вже НЕ стоп-
 * умова, а вимірювання. Різниця важлива: ми не блокуємо роботу, ми знаємо ціну.
 *
 * 🔴 МЕЖА, ЗАМІРЯНА 04.08.2026 — ЧИТАТИ ПЕРЕД ТИМ, ЯК «ЛАГОДИТИ» ЦЕЙ ФАЙЛ.
 * На плані **Launch** CU-години через API НЕ ДІСТАТИ:
 *   • `GET /consumption_history/projects` → **403** «included with Scale plans and above»;
 *   • `GET /projects/{id}` віддає `compute_time_seconds: 0` і `active_time: 0`
 *     (для org-керованих проєктів лічильники не наповнюються), хоча білінг за
 *     той самий період показує 42.83 CU-год.
 * Тобто цифра існує лише в консолі Neon. Хелпер лишається робочим і поверне
 * реальні значення, щойно план підніметься до Scale або Neon почне наповнювати
 * лічильники проєкту, — але ЗАРАЗ він чесно віддає нулі, і видавати їх за
 * «бекфіл нічого не з'їв» НЕ МОЖНА.
 * Що працює вже: `periodStart`/`periodEnd` (звірено з білінгом: Aug 1 → Sep 1).
 *
 * 🔒 Змінна оточення — `NEON_API_KEY`. Ключ НІДЕ не друкується: ні в логах, ні в
 * помилках (повідомлення нижче навмисно не містять ані ключа, ані заголовків).
 * Немає ключа — хелпер повертає `null` і мовчить: спостережність не має права
 * валити джобу, заради якої її й додали.
 */

export interface NeonUsage {
  /** CU-години за поточний розрахунковий період. */
  computeTimeHours: number;
  /** Байти сховища (може бути 0, якщо Neon не віддав). */
  storageBytes: number;
  periodStart: string | null;
  periodEnd: string | null;
}

const API = "https://console.neon.tech/api/v2";

/**
 * Поточне споживання проєкту. `null` — коли ключа немає або Neon не відповів:
 * це НЕ помилка виконання, а відсутність вимірювання, і викликач має її пережити.
 */
export async function fetchNeonUsage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NeonUsage | null> {
  const key = env.NEON_API_KEY;
  if (!key) return null;
  const H = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // 🔴 `org_id` ОБОВʼЯЗКОВИЙ. Перша версія кликала `GET /projects` без нього і
    // отримувала 400 «org_id is required» — а хелпер, за побудовою мовчазний,
    // повертав null, і це виглядало як «ключа немає». Тому org дістаємо явно.
    let orgId = env.NEON_ORG_ID;
    if (!orgId) {
      const o = await fetch(`${API}/users/me/organizations`, { headers: H, signal: ctrl.signal });
      if (!o.ok) return null;
      const oj = await o.json() as { organizations?: { id?: string }[] };
      orgId = oj.organizations?.[0]?.id;
    }
    if (!orgId) return null;

    const pid = env.NEON_PROJECT_ID ?? await (async () => {
      const r = await fetch(`${API}/projects?org_id=${encodeURIComponent(orgId!)}`, { headers: H, signal: ctrl.signal });
      if (!r.ok) return undefined;
      const j = await r.json() as { projects?: { id?: string }[] };
      return j.projects?.[0]?.id;
    })();
    if (!pid) return null;

    const res = await fetch(`${API}/projects/${pid}`, { headers: H, signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json() as { project?: Record<string, unknown> };
    const p = j.project ?? {};
    return {
      computeTimeHours: Number(p.compute_time_seconds ?? 0) / 3600,
      storageBytes: Number(p.synthetic_storage_size ?? 0),
      periodStart: (p.consumption_period_start as string) ?? null,
      periodEnd: (p.consumption_period_end as string) ?? null,
    };
  } catch {
    // Мовчки: спостережність не валить джобу. Ключ у повідомлення не потрапляє.
    return null;
  } finally { clearTimeout(t); }
}

/** Різниця CU-годин між двома замірами. `null`, якщо хоч один відсутній. */
export function usageDelta(before: NeonUsage | null, after: NeonUsage | null): number | null {
  if (!before || !after) return null;
  return Number((after.computeTimeHours - before.computeTimeHours).toFixed(4));
}

/**
 * Обгортка «заміряй до і після». Повертає результат джоби разом із ціною.
 * Не змінює поведінку джоби і не кидає, якщо вимірювання недоступне.
 */
export async function withUsage<T>(fn: () => Promise<T>): Promise<{ result: T; cuHours: number | null }> {
  const before = await fetchNeonUsage();
  const result = await fn();
  const after = await fetchNeonUsage();
  return { result, cuHours: usageDelta(before, after) };
}
