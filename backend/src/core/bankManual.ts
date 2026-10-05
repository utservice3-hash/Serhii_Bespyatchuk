import { randomUUID } from "node:crypto";
import { FinError, parseAmount, type Db } from "./finance.js";
import { weekStart, addDays } from "./financeKpi.js";

/**
 * 💰 РУЧНИЙ РАХУНОК «ВИПИСКИ» (Сейф) — прохід 2г фінансів, рішення Романа 05.10.2026: «давай можливість по
 * операції і так само окремо по тижнях». Записи лягають у ту саму `bank_transactions`, тож «Виписка», кешфлоу й
 * «Надходження / Витрати загальні» бачать їх без окремого коду.
 *
 * Правила (тримає гейт):
 *  1. **Рахунок лише `bank = 'manual'`** — у банківський рахунок руками не пишемо.
 *  2. **Тиждень — АБО операції, АБО підсумок**, не обидва: інакше той самий тиждень порахувався б двічі. Межа —
 *     тиждень Пн–Нд за Києвом. Підсумок тижня — один на тиждень.
 *  3. **Видалення скасовне** («Повернути»), і повернення перевіряє правило 2 знову.
 *  4. Сума — додатна; напрямок окремо. Підсумок тижня лягає на понеділок, тож у місяць він іде за місяцем понеділка.
 */
export type ManualKind = "op" | "week";
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Полудень за Києвом — щоб день не зʼїхав від часового поясу ні в UTC, ні в Києві. */
const kyivNoon = (day: string) => `${day} 12:00:00 Europe/Kyiv`;

async function manualAccount(db: Db, id: unknown) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new FinError(400, "Некоректний рахунок");
  const r = await db.query(`SELECT id, label, bank, is_active FROM bank_accounts WHERE id = $1`, [n]);
  const a = r.rows[0];
  if (!a) throw new FinError(404, "Рахунок не знайдено");
  if (a.bank !== "manual") throw new FinError(400, `«${a.label}» — банківський рахунок, його виписка приходить із банку`);
  if (!a.is_active) throw new FinError(409, `Рахунок «${a.label}» вимкнено`);
  return a as { id: number; label: string };
}

/** Що вже є в тижні цього рахунку (лише живі записи). */
async function weekHas(db: Db, accountId: number, monday: string, exceptId: number | null = null) {
  const r = await db.query(`SELECT manual_kind, count(*)::int AS n FROM bank_transactions
     WHERE account_id = $1 AND deleted_at IS NULL AND manual_kind IS NOT NULL AND ($4::int IS NULL OR id <> $4)
       AND (booked_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date GROUP BY 1`, [accountId, monday, addDays(monday, 6), exceptId]);
  const m = new Map(r.rows.map((x: any) => [x.manual_kind, x.n]));
  return { op: m.get("op") ?? 0, week: m.get("week") ?? 0 };
}

function guardMix(kind: ManualKind, has: { op: number; week: number }, monday: string) {
  const label = `${monday.slice(8, 10)}.${monday.slice(5, 7)}`;
  if (kind === "op" && has.week) throw new FinError(409, `Для тижня з ${label} уже внесено підсумок — операції в нього не додаються (інакше тиждень порахується двічі)`);
  if (kind === "week" && has.op) throw new FinError(409, `У тижні з ${label} уже є операції (${has.op}) — підсумок поверх них порахував би тиждень двічі`);
  if (kind === "week" && has.week) throw new FinError(409, `Підсумок тижня з ${label} уже є — змініть його, видаливши й внісши знову`);
}

async function insertRow(db: Db, actor: number, accountId: number, kind: ManualKind, day: string, amount: number, name: string, purpose: string | null) {
  const r = await db.query(`INSERT INTO bank_transactions (account_id, direction, external_tx_id, booked_at, processed_at, counterparty_name,
      purpose, amount, currency, fx_rate, amount_uah, manual_kind, entered_by)
    VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5, $6, $7, 'UAH', 1, $7, $8, $9) RETURNING id`,
  [accountId, amount >= 0 ? "in" : "out", `manual:${accountId}:${randomUUID()}`, kyivNoon(day), name, purpose, amount, kind, actor]);
  return r.rows[0].id as number;
}

/**
 * Додати запис. `kind = 'op'`: дата, напрямок (`in`/`out`), сума, призначення. `kind = 'week'`: будь-який день тижня
 * (нормалізується до понеділка), «прийшло» і «пішло» — хоч одне з двох. Повертає id створених рядків.
 */
export async function addManual(db: Db, actor: number, body: any): Promise<{ ids: number[]; monday: string }> {
  const acc = await manualAccount(db, body?.accountId);
  const kind: ManualKind = body?.kind === "week" ? "week" : body?.kind === "op" ? "op" : (() => { throw new FinError(400, "Вид запису — операція або підсумок тижня"); })();
  if (!isDay(body?.date)) throw new FinError(400, "Дата — РРРР-ММ-ДД");
  const monday = weekStart(body.date);
  const purpose = typeof body?.purpose === "string" && body.purpose.trim() ? body.purpose.trim().slice(0, 500) : null;
  guardMix(kind, await weekHas(db, acc.id, monday), monday);
  if (kind === "op") {
    const amount = parseAmount(body?.amount);
    if (amount == null || amount <= 0) throw new FinError(400, "Сума — додатне число");
    if (body?.direction !== "in" && body?.direction !== "out") throw new FinError(400, "Напрямок — надходження або витрата");
    const id = await insertRow(db, actor, acc.id, "op", body.date, body.direction === "in" ? amount : -amount, purpose ?? "Операція", purpose);
    return { ids: [id], monday };
  }
  const inA = parseAmount(body?.inAmount), outA = parseAmount(body?.outAmount);
  if ((inA != null && inA < 0) || (outA != null && outA < 0)) throw new FinError(400, "Суми тижня — додатні");
  if (!inA && !outA) throw new FinError(400, "Підсумок тижня порожній — внесіть «прийшло» або «пішло»");
  const ids: number[] = [];
  if (inA) ids.push(await insertRow(db, actor, acc.id, "week", monday, inA, "Підсумок тижня · прийшло", purpose));
  if (outA) ids.push(await insertRow(db, actor, acc.id, "week", monday, -outA, "Підсумок тижня · пішло", purpose));
  return { ids, monday };
}

/** Видалити / повернути ручний запис. Повернення знову перевіряє «тиждень — або операції, або підсумок». */
export async function setManualDeleted(db: Db, actor: number, idArg: unknown, deleted: boolean): Promise<void> {
  const id = Number(idArg);
  if (!Number.isInteger(id) || id <= 0) throw new FinError(400, "Некоректний запис");
  const r = await db.query(`SELECT t.id, t.account_id, t.manual_kind, t.deleted_at, (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date::text AS day
      FROM bank_transactions t WHERE t.id = $1 FOR UPDATE`, [id]);
  const x = r.rows[0];
  if (!x || !x.manual_kind) throw new FinError(404, "Ручний запис не знайдено");
  if (deleted === (x.deleted_at != null)) throw new FinError(409, deleted ? "Уже видалено" : "Уже на місці");
  if (!deleted) {
    const monday = weekStart(x.day);
    const has = await weekHas(db, x.account_id, monday, id);
    // Повертаємо рядок підсумку: другий рядок того самого підсумку (прийшло/пішло) — не конфлікт.
    if (x.manual_kind === "week") { if (has.op) guardMix("week", { op: has.op, week: 0 }, monday); }
    else guardMix("op", has, monday);
  }
  await db.query(`UPDATE bank_transactions SET deleted_at = ${deleted ? "now()" : "NULL"}, deleted_by = ${deleted ? "$2" : "NULL"} WHERE id = $1`,
    deleted ? [id, actor] : [id]);
}

/** Записи ручного рахунку за період (живі й видалені — видалені для «Повернути»). */
export async function listManual(db: Db, accountArg: unknown, from: string, to: string) {
  const acc = await manualAccount(db, accountArg);
  if (!isDay(from) || !isDay(to) || from > to) throw new FinError(400, "Період — РРРР-ММ-ДД, від ≤ до");
  const r = await db.query(`SELECT t.id, (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date::text AS day, t.direction, t.amount::text AS amount,
      t.manual_kind AS kind, t.counterparty_name AS name, t.purpose, t.deleted_at IS NOT NULL AS deleted,
      COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS entered_by
      FROM bank_transactions t LEFT JOIN users u ON u.id = t.entered_by
     WHERE t.account_id = $1 AND (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date
     ORDER BY t.booked_at DESC, t.id DESC`, [acc.id, from, to]);
  return { account: acc, rows: r.rows.map((x: any) => ({ ...x, amount: Number(x.amount) })) };
}
