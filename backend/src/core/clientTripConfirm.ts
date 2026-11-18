/**
 * 🧾 ПОЇЗДКА ПОЗА CRM, ПІДТВЕРДЖЕНА ТІМЛІДОМ (задача 9045; ТЗ Юлі 16.11.2026; Роман 18.11.2026 «роби»).
 *
 * Привід: ЕйВіДіПі їздив за готівку (рахунок №8996), угоди в Kommo немає, і на «З ким говорити» клієнт жовтий —
 * «мінус», хоча по факту працював. Тімлід підтверджує, що поїздка була: дата поїздки + обовʼязковий коментар
 * (№ рахунку, як оплачено) → «Подати». Після цього:
 *   · дата поїздки рахується ЗАМОВЛЕННЯМ для кольору (`clientLeadRules.lastOrderDate`): клієнт зелений, поки поїздка
 *     в межах його ритму, а потім жовтіє сам — як після звичайного замовлення;
 *   · і для циклу реактивації — рахунком (`reactInvoiceDate`, вимикач `TRIP_CLEARS_REACT`);
 *   · у гроші НЕ йде нічого: ні факт, ні «± до середнього», ні Звіт. Гроші рахує лише `core/money.ts`.
 * Видно, хто й коли подав; «зняти» лишає рядок в історії (`revoked_at`).
 *
 * 🔒 ХТО ПОДАЄ — ЛИШЕ ТІМЛІД, і лише клієнта своєї команди (ТЗ: «для тімліда»). КВП / ОД / адмін — ні: рішення про
 * доступ керівництву за Сергієм (18.11.2026 питання відкрите). Розширити — `canConfirmTrip`, один рядок.
 *
 * Чисті правила — вгорі; запити — нижче, з явним `db`.
 */
export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Мінімальна довжина коментаря: «№8996» уже 5 символів, а порожнє «ок» нічого не пояснює. */
export const TRIP_NOTE_MIN = 5;
/** Наскільки давню поїздку можна подати. Старша за пів року колір уже не змінить (втрачений — 180 днів). */
export const TRIP_MAX_AGE_DAYS = 180;

/**
 * 🔁 ЧИ ЗНІМАЄ ПІДТВЕРДЖЕНА ПОЇЗДКА КЛІЄНТА З «РЕАКТИВАЦІЇ». ТЗ про це мовчить; варіант із плану 18.11.2026 — так:
 * інакше клієнт зелений і водночас «чекає рішення» на передачу лідгенам. Поїздка тоді рахується рахунком для циклу
 * (`inReact` і вигляд циклу на екрані, нічний добір `reactCandidates`). Вимкнути — `false`, більше нічого не міняти.
 */
export const TRIP_CLEARS_REACT = true;

/** Хто може подавати й знімати: лише тімлід (своєї команди — це вже межа `canSeeClient` у роуті). */
export function canConfirmTrip(role: string): boolean {
  return role === "team_lead";
}

/** Коментар із тіла: обрізаний; коротший за мінімум — `null` (роут відповість 400). */
export function cleanTripNote(x: unknown): string | null {
  const s = typeof x === "string" ? x.trim().slice(0, 1000) : "";
  return s.length >= TRIP_NOTE_MIN ? s : null;
}

const dayMs = 86_400_000;
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);

/**
 * Дата поїздки з тіла (`YYYY-MM-DD`, київська) проти київського «сьогодні». Повертає текст помилки або `null`.
 * Майбутня — ні (поїздка, якої ще не було, не замовлення); старша за `TRIP_MAX_AGE_DAYS` — ні.
 */
export function tripDayError(day: unknown, today: string): string | null {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(toMs(day))
    || new Date(toMs(day)).toISOString().slice(0, 10) !== day) return "Вкажіть дату поїздки";
  if (day > today) return "Дата поїздки не може бути в майбутньому";
  if ((toMs(today) - toMs(day)) / dayMs > TRIP_MAX_AGE_DAYS) return `Поїздка старша за ${TRIP_MAX_AGE_DAYS} днів колір уже не змінить`;
  return null;
}

/** Останній рахунок для циклу реактивації: з вимикачем — свіжіший із рахунку й підтвердженої поїздки. */
export function reactInvoiceDate(lastInvoice: string | null, tripDay: string | null | undefined): string | null {
  if (!TRIP_CLEARS_REACT || !tripDay) return lastInvoice;
  if (!lastInvoice) return tripDay;
  return tripDay > lastInvoice.slice(0, 10) ? tripDay : lastInvoice;
}

export interface TripConfirm {
  /** День поїздки, київський `YYYY-MM-DD`. */
  day: string;
  note: string;
  /** Хто подав і коли (київський день подачі). */
  byName: string | null;
  at: string;
}

/** Діюче підтвердження по кожному ключу — найсвіжіша поїздка серед незнятих. Ключа без підтвердження в мапі немає. */
export async function tripsFor(db: Db, keys: readonly string[]): Promise<Map<string, TripConfirm>> {
  const out = new Map<string, TripConfirm>();
  if (!keys.length) return out;
  const r = await db.query<{ client_key: string; day: string; note: string; by_name: string | null; at: string }>(
    `SELECT DISTINCT ON (t.client_key) t.client_key, to_char(t.trip_day, 'YYYY-MM-DD') AS day, t.note,
            COALESCE(m.name, u.full_name, u.email) AS by_name,
            to_char(t.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS at
       FROM client_trip_confirms t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN managers m ON m.id = u.manager_id
      WHERE t.revoked_at IS NULL AND t.client_key = ANY($1)
      ORDER BY t.client_key, t.trip_day DESC, t.created_at DESC`, [keys]);
  for (const x of r.rows) out.set(x.client_key, { day: x.day, note: x.note, byName: x.by_name, at: x.at });
  return out;
}

/** Подати поїздку. Дата й коментар уже перевірені роутом. */
export async function confirmTrip(db: Db, a: { clientKey: string; userId: number; day: string; note: string }): Promise<void> {
  await db.query(
    `INSERT INTO client_trip_confirms (client_key, trip_day, note, created_by) VALUES ($1, $2::date, $3, $4)`,
    [a.clientKey, a.day, a.note, a.userId]);
}

/** Зняти всі діючі підтвердження клієнта. `false` — знімати нічого. */
export async function clearTrips(db: Db, clientKey: string, userId: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE client_trip_confirms SET revoked_at = now(), revoked_by = $2 WHERE client_key = $1 AND revoked_at IS NULL`,
    [clientKey, userId]);
  return (r.rowCount ?? 0) > 0;
}
