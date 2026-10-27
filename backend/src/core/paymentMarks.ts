/**
 * ✋ «ПОГОДЖЕНО» І КОМЕНТАР НА ЗАПИТІ «ОПЛАТИ ПЕРЕВІЗНИКАМ» (Тетяна 26.10.2026: «кнопку „погоджено“, при натисканні якої
 * угода буде переноситись в „до оплати“ — саме для тих „перевірити“… та мб можливість додавати коментар»; Роман: коментар
 * необовʼязковий, погоджують і Тетяна, і адмін).
 *
 * Погодження — рішення ЛЮДИНИ поверх рішення системи: система лишає свою причину видимою, а рядок іде в «До оплати» з
 * позначкою «погоджено вручну». Погодження ПРИВʼЯЗАНЕ ДО СУМИ: змінили суму запиту в Kommo — воно не діє, і рядок каже
 * «погодьте знову» (інакше згода на 3 000 пішла б в оплату як 30 000). У журналі дня (`payment_file_log`) лежить рішення
 * разом із погодженням (`paid_by = 'вручну'`), а на екрані — ЗАВЖДИ поточне: скасоване після прогону погодження одразу
 * повертає рядок у «перевірити» (`systemOf`). У Kommo нічого не пишемо.
 */
import { FinError, type Db } from "./finance.js";

export const MANUAL = "вручну";
export interface PayMark { requestId: number; approved: boolean; amount: number | null; by: string | null; at: string | null; comment: string | null; commentBy: string | null }
export interface PayDecision { ok: boolean; paidBy: string | null; reasons: string[]; notes: string[] }
export interface MarkedDecision extends PayDecision { manual: { by: string | null; at: string | null } | null; stale: boolean; comment: string | null; commentBy: string | null }

const sameAmount = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.01;
const fmt = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ");
const when = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Рішення журналу без погодження: рядок, погоджений вручну, за системою — «перевірити» (причини система лишила). */
export function systemOf(d: PayDecision): PayDecision {
  return d.paidBy === MANUAL ? { ...d, ok: false, paidBy: null } : d;
}

/**
 * Рішення системи + позначка людини. Погоджено й сума та сама — «до оплати» (`paidBy = 'вручну'`), причини системи
 * лишаються; сума інша — «перевірити» з причиною «погодьте знову»; система й так «до оплати» — погодження нічого не міняє.
 * Коментар — примітка з автором, рішення не міняє.
 */
export function applyMark(sys: PayDecision, amount: number | null, m: PayMark | null): MarkedDecision {
  const base: MarkedDecision = { ...sys, reasons: [...sys.reasons], notes: [...sys.notes], manual: null, stale: false, comment: m?.comment ?? null, commentBy: m?.commentBy ?? null };
  if (!m) return base;
  if (m.approved && !sys.ok) {
    if (sameAmount(amount, m.amount)) return { ...base, ok: true, paidBy: MANUAL, manual: { by: m.by, at: m.at } };
    base.stale = true;
    base.reasons.push(`сума змінилась після погодження (було ${m.amount == null ? "—" : fmt(m.amount)}, зараз ${amount == null ? "—" : fmt(amount)}) — погодьте знову`);
  }
  return base;
}

/** Підпис погодження й коментаря для файлу «Перевірити» / Excel. */
export function markNote(d: MarkedDecision): string[] {
  const out: string[] = [];
  if (d.manual) out.push(`погоджено вручну — ${d.manual.by ?? "?"}${d.manual.at ? `, ${when(d.manual.at)}` : ""}`);
  if (d.comment) out.push(`коментар${d.commentBy ? ` (${d.commentBy})` : ""}: ${d.comment}`);
  return out;
}

/** Позначки запитів (з автором). */
export async function loadMarks(db: Db, ids: readonly number[]): Promise<Map<number, PayMark>> {
  if (!ids.length) return new Map();
  const who = (a: string) => `(SELECT COALESCE(NULLIF(btrim(u.full_name), ''), mm.name, u.email) FROM users u LEFT JOIN managers mm ON mm.id = u.manager_id WHERE u.id = ${a})`;
  const r = await db.query(`SELECT m.request_id::text AS id, m.approved, m.amount::float8 AS amount, m.approved_at, m.comment,
      ${who("m.approved_by")} AS by, ${who("m.comment_by")} AS comment_by
    FROM payment_request_marks m WHERE m.request_id = ANY($1)`, [ids]);
  return new Map((r.rows as any[]).map((x) => [Number(x.id), { requestId: Number(x.id), approved: !!x.approved, amount: x.amount, by: x.by ?? null,
    at: x.approved_at ? new Date(x.approved_at).toISOString() : null, comment: x.comment ?? null, commentBy: x.comment_by ?? null }]));
}

/**
 * Поставити / зняти погодження чи коментар. Погодити можна лише запит, який система ВЖЕ перевірила й відправила в
 * «перевірити» (ще не перевірений чи вже «до оплати» — 400): погоджується конкретна сума `amountNow` (живий Kommo).
 * `approved` / `comment` не передано — лишаються як були; ні погодження, ні коментаря — рядок видаляється.
 */
export async function setMark(db: Db, actor: number, body: any, ctx: { system: PayDecision | null; amountNow: number | null }): Promise<{ approved: boolean; comment: string | null }> {
  const id = Number(body?.requestId);
  if (!Number.isInteger(id) || id <= 0) throw new FinError(400, "Некоректний запит");
  const prev = (await db.query(`SELECT approved, amount::float8 AS amount, approved_by, approved_at, comment, comment_by, comment_at FROM payment_request_marks WHERE request_id = $1`, [id])).rows[0];
  let approved: boolean = prev?.approved ?? false;
  let amount: number | null = prev?.amount ?? null;
  let approvedBy: number | null = prev?.approved_by ?? null, approvedAt: Date | null = prev?.approved_at ?? null;
  if (body?.approved === true) {
    if (!ctx.system) throw new FinError(400, "Запит ще не перевірено — спершу «↻ Перевірити зараз»");
    if (systemOf(ctx.system).ok) throw new FinError(400, "Система вже віднесла цей запит до оплати — погоджувати нема чого");
    if (ctx.amountNow == null) throw new FinError(400, "У запиті немає суми — погоджувати нема чого");
    approved = true; amount = ctx.amountNow; approvedBy = actor; approvedAt = new Date();
  } else if (body?.approved === false) { approved = false; amount = null; approvedBy = null; approvedAt = null; }
  let comment: string | null = prev?.comment ?? null;
  let commentBy: number | null = prev?.comment_by ?? null, commentAt: Date | null = prev?.comment_at ?? null;
  if (body?.comment !== undefined) {
    if (body.comment !== null && typeof body.comment !== "string") throw new FinError(400, "Коментар — текст");
    const c = String(body.comment ?? "").trim();
    if (c.length > 500) throw new FinError(400, "Коментар задовгий (до 500 символів)");
    if ((c || null) !== comment) { comment = c || null; commentBy = comment ? actor : null; commentAt = comment ? new Date() : null; }
  }
  if (!approved && !comment) await db.query(`DELETE FROM payment_request_marks WHERE request_id = $1`, [id]);
  else await db.query(`INSERT INTO payment_request_marks (request_id, approved, amount, approved_by, approved_at, comment, comment_by, comment_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (request_id) DO UPDATE SET approved = EXCLUDED.approved, amount = EXCLUDED.amount, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
      comment = EXCLUDED.comment, comment_by = EXCLUDED.comment_by, comment_at = EXCLUDED.comment_at`,
  [id, approved, amount, approvedBy, approvedAt, comment, commentBy, commentAt]);
  return { approved, comment };
}
