/**
 * 📋 АНКЕТА КЛІЄНТА (задача 11221; зустріч по дашборду 25.11.2026).
 *
 * На зустрічі: «у постійного клієнта має бути створено описання… пʼять питань, і один раз обовʼязково менеджер має
 * дізнатися» — чим займається, як часто і скільки возить, яку частку возимо ми, чи є міжнародні, чи є авіа / море.
 * Це дає зрозуміти, наскільки клієнт потенційно цінний. Анкета — у картці клієнта, одна на клієнта; відповіді —
 * текст словами менеджера (варіантів на зустрічі не називали — не вигадуємо).
 *
 *   · Питань рівно пʼять, і їхній перелік — ТУТ: сервер віддає його картці (`fields`), екран лише малює.
 *   · Зберігається вся анкета одним записом (усі пʼять полів разом) — часткового оновлення немає.
 *   · Хто заповнює: той, хто бачить клієнта (`canSeeClient` у роуті) — менеджер свого, тімлід своєї команди,
 *     КВП / ОД / адмін — будь-якого. Та сама межа, що «наступний крок» і «Проблемний».
 *   · Ключ — канонічний `client_key`. ⚠️ Обʼєднання клієнтів анкету НЕ переносить (як і `repeat_client_plans`):
 *     анкета приєднаного запису лишається на старому ключі.
 *
 * Чисті правила — вгорі; запити — нижче, з явним `db`.
 */
export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Пʼять питань із зустрічі 25.11.2026. `column` — колонка в `client_profiles`. */
export const PROFILE_FIELDS = [
  { key: "business", column: "business", label: "Чим займається клієнт", hint: "що виробляє або продає, що саме возить" },
  { key: "volume", column: "volume", label: "Як часто і який обʼєм возить", hint: "скільки машин на тиждень або місяць, які напрямки" },
  { key: "share", column: "share", label: "Яку частку возимо ми; якщо не 100% — чому", hint: "хто ще возить і чому не ми" },
  { key: "international", column: "international", label: "Чи є міжнародні перевезення", hint: "куди, як часто, хто возить зараз" },
  { key: "airSea", column: "air_sea", label: "Чи є авіа / море", hint: "які вантажі, хто везе зараз" },
] as const;
export type ProfileKey = (typeof PROFILE_FIELDS)[number]["key"];
export type ProfileAnswers = Record<ProfileKey, string>;
export const PROFILE_TOTAL = PROFILE_FIELDS.length;
export const PROFILE_ANSWER_MAX = 1000;

/**
 * Відповіді з тіла запиту: лише пʼять відомих полів, лише рядки; пробіли по краях зрізано, довге — обрізано.
 * Усе інше (число, обʼєкт, зайве поле) — порожня відповідь, а не помилка: анкету зберігають цілою.
 */
export function cleanProfile(body: unknown): ProfileAnswers {
  const src = (body != null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out = {} as ProfileAnswers;
  for (const f of PROFILE_FIELDS) {
    const v = src[f.key];
    out[f.key] = typeof v === "string" ? v.trim().slice(0, PROFILE_ANSWER_MAX) : "";
  }
  return out;
}

/** Скільки питань мають відповідь. `null` — анкети немає взагалі: нуль. */
export function filledCount(a: Partial<Record<ProfileKey, string | null>> | null | undefined): number {
  if (!a) return 0;
  return PROFILE_FIELDS.filter((f) => (a[f.key] ?? "").trim() !== "").length;
}

export interface ClientProfile {
  answers: ProfileAnswers;
  filled: number;
  /** День останньої зміни за Києвом `YYYY-MM-DD` і хто змінив. */
  updatedDay: string;
  updatedBy: string | null;
}

/** Анкети по ключах. Клієнта без анкети в мапі НЕМАЄ — «не заповнено» і «заповнено порожнім» не плутаються. */
export async function profilesFor(db: Db, keys: string[]): Promise<Map<string, ClientProfile>> {
  const out = new Map<string, ClientProfile>();
  if (!keys.length) return out;
  const r = await db.query<{ client_key: string; business: string; volume: string; share: string; international: string; air_sea: string; day: string; by_name: string | null }>(
    `SELECT p.client_key, p.business, p.volume, p.share, p.international, p.air_sea,
            to_char(p.updated_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day,
            COALESCE(um.name, u.full_name, u.email) AS by_name
       FROM client_profiles p
       LEFT JOIN users u ON u.id = p.updated_by
       LEFT JOIN managers um ON um.id = u.manager_id
      WHERE p.client_key = ANY($1)`, [keys]);
  for (const x of r.rows) {
    const answers: ProfileAnswers = { business: x.business, volume: x.volume, share: x.share, international: x.international, airSea: x.air_sea };
    out.set(x.client_key, { answers, filled: filledCount(answers), updatedDay: x.day, updatedBy: x.by_name });
  }
  return out;
}

/** Зберегти анкету цілком (усі пʼять полів одним записом). Повертає, скільки питань мають відповідь. */
export async function saveProfile(db: Db, a: { clientKey: string; userId: number | null; answers: ProfileAnswers }): Promise<number> {
  await db.query(
    `INSERT INTO client_profiles (client_key, business, volume, share, international, air_sea, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (client_key) DO UPDATE SET business = EXCLUDED.business, volume = EXCLUDED.volume, share = EXCLUDED.share,
       international = EXCLUDED.international, air_sea = EXCLUDED.air_sea, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [a.clientKey, a.answers.business, a.answers.volume, a.answers.share, a.answers.international, a.answers.airSea, a.userId]);
  return filledCount(a.answers);
}
