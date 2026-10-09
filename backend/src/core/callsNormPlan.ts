import { pool } from "../db/pool.js";
import { CALLS_NORM_BOUNDS } from "./callNorm.js";

/**
 * 📞 НОРМА ДЗВІНКІВ НА ДЕНЬ — У «ПЛАНАХ» (ТЗ 4632 п.2.5; Юля 10.10.2026: «рахуємо розмови + спроби, як у новій
 * мотивації з 01.10; норма одна на всіх менеджерів — 45 на день»; Роман 10.10.2026: «в Планах», «КВП сама ставить
 * норму», «до наступної зміни»).
 *
 * Норма діє З МІСЯЦЯ й ДО НАСТУПНОЇ ЗМІНИ. Кожна зміна — новий рядок (історія не затирається), тож минулий місяць
 * завжди читається зі СВОЄЮ нормою: нова норма не переписує те, за що людям уже порахували дні з нормою.
 * До 10.10.2026 норма жила в «Налаштуваннях» (`callsDailyNorm`) і так і не була задана — переносити нічого.
 */

export interface CallsNormRow { fromMonth: string; norm: number; setBy: string | null; setAt: string }

/** Чинна норма місяця `month` (YYYY-MM-01): найпізніша зміна з `fromMonth ≤ month`. Немає — `null` («не задано»). */
export function effectiveNorm(rows: readonly Pick<CallsNormRow, "fromMonth" | "norm" | "setAt">[], month: string): number | null {
  let best: Pick<CallsNormRow, "fromMonth" | "norm" | "setAt"> | null = null;
  for (const r of rows) {
    if (r.fromMonth > month) continue;
    if (!best || r.fromMonth > best.fromMonth || (r.fromMonth === best.fromMonth && r.setAt > best.setAt)) best = r;
  }
  return best ? best.norm : null;
}

/**
 * Хто ставить: КВП (рішення Романа 10.10.2026) і адмін. Тімлід і менеджер — ні: норма одна на всіх, і ставити її
 * собі той, кого нею міряють, не може.
 */
export function canSetCallsNorm(auth: { role?: string; roleKey?: string | null }): boolean {
  return auth.roleKey === "kvp" || auth.roleKey === "admin";
}

/** Перевірка вводу. Місяць — не раніше поточного: нова норма не переписує минулі місяці. */
export function callsNormVerdict(body: unknown, currentMonth: string): { ok: true; norm: number; fromMonth: string } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const norm = Number(b.norm);
  if (!Number.isInteger(norm) || norm < CALLS_NORM_BOUNDS.min || norm > CALLS_NORM_BOUNDS.max) {
    return { ok: false, error: `Норма — ціле число від ${CALLS_NORM_BOUNDS.min} до ${CALLS_NORM_BOUNDS.max} дзвінків на день` };
  }
  const fm = String(b.fromMonth ?? "");
  if (!/^\d{4}-\d{2}$/.test(fm)) return { ok: false, error: "Місяць, з якого діє норма, — у форматі YYYY-MM" };
  const fromMonth = `${fm}-01`;
  if (fromMonth < currentMonth) return { ok: false, error: "Норму не можна поставити заднім числом — минулі місяці лишаються зі своєю нормою" };
  return { ok: true, norm, fromMonth };
}

export async function callsNormHistory(): Promise<CallsNormRow[]> {
  const r = await pool.query<{ from_month: string; norm: number; set_by: string | null; set_at: string }>(
    `SELECT to_char(n.from_month, 'YYYY-MM-DD') AS from_month, n.norm, COALESCE(u.full_name, u.email) AS set_by,
            to_char(n.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS set_at
       FROM calls_norm_plan n LEFT JOIN users u ON u.id = n.set_by
      ORDER BY n.from_month DESC, n.set_at DESC, n.id DESC`);
  return r.rows.map((x) => ({ fromMonth: x.from_month, norm: Number(x.norm), setBy: x.set_by, setAt: x.set_at }));
}

/** Чинна норма на місяць дати `day` (YYYY-MM-DD). Одне джерело для Звіту, Статистик і «Налаштувань». */
export async function callsNormFor(day: string): Promise<number | null> {
  return effectiveNorm(await callsNormHistory(), `${day.slice(0, 7)}-01`);
}

export async function setCallsNorm(norm: number, fromMonth: string, userId: number | null): Promise<void> {
  await pool.query(`INSERT INTO calls_norm_plan (from_month, norm, set_by) VALUES ($1, $2, $3)`, [fromMonth, norm, userId]);
}
