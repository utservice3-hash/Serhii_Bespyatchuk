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
  const projectId = env.NEON_PROJECT_ID;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    // Без явного project_id беремо перший проєкт акаунта — у нас він один.
    const listRes = projectId ? null : await fetch(`${API}/projects`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: ctrl.signal,
    });
    const pid = projectId ?? (await listRes?.json().catch(() => null))?.projects?.[0]?.id;
    if (!pid) { clearTimeout(t); return null; }
    const res = await fetch(`${API}/projects/${pid}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json() as { project?: Record<string, unknown> };
    const p = j.project ?? {};
    const seconds = Number(p.compute_time_seconds ?? 0);
    return {
      computeTimeHours: seconds / 3600,
      storageBytes: Number(p.synthetic_storage_size ?? p.data_storage_bytes_hour ?? 0),
      periodStart: (p.consumption_period_start as string) ?? null,
      periodEnd: (p.consumption_period_end as string) ?? null,
    };
  } catch {
    // Мовчки: спостережність не валить джобу. Ключ у повідомлення не потрапляє.
    return null;
  }
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
