/**
 * 📅 КАЛЕНДАР ОПЛАТ («Фінанси», Тетяна — задача #6369, 27.10.2026; макет «Г» затвердив Роман): нагадування про періодичні
 * витрати (оренда, сервіси, податки, страховки). ОКРЕМО від Плану/факту, Результату місяця й Каси — нічого не рахує в
 * результаті, лише нагадує, що й коли платити, і памʼятає, що вже оплачено.
 *
 * Три правила, на яких усе стоїть:
 *  1. «День оплати» (`anchor_day`) береться з першої дати й НЕ зʼїжджає: 31.01 → 28.02 → 31.03. Наступна дата рахується
 *     від якоря, а не від попередньої дати (інакше лютий назавжди перетворив би 31-ше на 28-ме; той самий клас, що
 *     `monthKeys`, борг 19).
 *  2. «Оплачено» позначає рівно поточну дату (`next_due`) і зсуває її на один період; повторне натискання чи застаріла
 *     сторінка — 409, а не друга оплата.
 *  3. Історія не стирається: оплату вимикають (`active`), позначку скасовують (`cancelled_at`) — рядок лишається.
 *     Видалення з цих таблиць у коді немає взагалі (тримає гейт).
 */
import { FinError, type Db } from "./finance.js";
import { xlsxBook } from "./xlsx.js";

export type Period = "month" | "quarter" | "year";
export const STEP: Record<Period, number> = { month: 1, quarter: 3, year: 12 };
export const PERIOD_LABEL: Record<Period, string> = { month: "щомісяця", quarter: "щокварталу", year: "раз на рік" };
/** Перше нагадування — за стільки днів до оплати (Роман 27.10.2026: «3 дні»); друге — у день оплати; прострочене — щодня. */
export const LEAD_DAYS = 3;
/** «Скоро» на екрані — жовтим (тиждень), окремо від нагадування. */
export const SOON_DAYS = 7;
/** Платить і бачить — те саме право, що «Оплати перевізникам» і Сейф (Адмін, фінансист). */
export const PAYER_PERM = "view_private_finance";
/** Смуга місяців: назад — до першої оплати, але не менше 6 міс.; уперед — 18 міс. */
export const BACK_MIN = 6, AHEAD = 18;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const P = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const isPeriod = (v: unknown): v is Period => v === "month" || v === "quarter" || v === "year";

export function kyivToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((P(to) - P(from)) / 864e5);
}
/** `ym` + n місяців — завжди від 1-го числа (без переповнення 31-го). */
export function shiftYm(ym: string, n: number): string {
  return iso(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).slice(0, 7);
}
const lastDay = (ym: string) => iso(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0));

/** Наступна дата: + період від місяця `date`, день — якір, обрізаний до кінця місяця. */
export function addPeriod(date: string, period: Period, anchorDay: number): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1 + STEP[period];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m, Math.min(anchorDay, last)));
}
/** Дати оплати від `next` (включно) у вікні [from; to]. */
export function occurrences(next: string, period: Period, anchorDay: number, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = next, g = 0; d <= to && g < 240; d = addPeriod(d, period, anchorDay), g++) if (d >= from) out.push(d);
  return out;
}

export interface RecItem {
  id: number; name: string; amount: number; period: Period; anchorDay: number; next: string;
  payerId: number | null; payer: string | null; note: string | null; active: boolean;
}
export interface PaidRow {
  id: number; recurringId: number; name: string; due: string; amount: number; planned: number;
  by: string | null; at: string; cancelledBy: string | null; cancelledAt: string | null;
}
export type EventKind = "paid" | "overdue" | "soon" | "plan";
export interface CalEvent {
  recurringId: number; date: string; amount: number; kind: EventKind;
  /** Саме цю дату можна позначити «Оплачено» (це `next_due` увімкненої оплати). */
  due: boolean;
  paidId: number | null; planned: number | null; by: string | null; at: string | null; canUndo: boolean;
}
export interface CalMonth { ym: string; offset: number; sum: number; paid: number; overdue: number; events: CalEvent[] }

/** Позначка, яку ще можна скасувати: жива й остання — саме від неї пораховано поточну дату. */
export function undoable(p: PaidRow, items: Map<number, RecItem>): boolean {
  const it = items.get(p.recurringId);
  return !p.cancelledAt && !!it && addPeriod(p.due, it.period, it.anchorDay) === it.next;
}

/** Смуга місяців і події кожного: майбутнє — з графіка увімкнених оплат, минуле — лише те, що реально оплачено. */
export function buildMonths(items: RecItem[], paid: PaidRow[], today: string): CalMonth[] {
  const cur = today.slice(0, 7);
  const live = paid.filter((p) => !p.cancelledAt);
  const first = live.reduce((a, p) => (p.due < a ? p.due : a), today).slice(0, 7);
  const back = Math.max(BACK_MIN, (+cur.slice(0, 4) - +first.slice(0, 4)) * 12 + (+cur.slice(5, 7) - +first.slice(5, 7)));
  const byId = new Map(items.map((i) => [i.id, i]));
  const from = shiftYm(cur, -back) + "-01", to = lastDay(shiftYm(cur, AHEAD));
  const ev: CalEvent[] = [];
  for (const i of items) {
    if (!i.active) continue;
    for (const d of occurrences(i.next, i.period, i.anchorDay, from, to)) {
      const n = daysBetween(today, d);
      ev.push({ recurringId: i.id, date: d, amount: i.amount, kind: n < 0 ? "overdue" : n <= SOON_DAYS ? "soon" : "plan", due: d === i.next,
        paidId: null, planned: null, by: null, at: null, canUndo: false });
    }
  }
  for (const p of live) if (p.due >= from && p.due <= to)
    ev.push({ recurringId: p.recurringId, date: p.due, amount: p.amount, kind: "paid", due: false, paidId: p.id, planned: p.planned, by: p.by, at: p.at, canUndo: undoable(p, byId) });
  ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.recurringId - b.recurringId));
  const months: CalMonth[] = [];
  for (let k = -back; k <= AHEAD; k++) {
    const ym = shiftYm(cur, k);
    const e = ev.filter((x) => x.date.slice(0, 7) === ym);
    const sum = (f: (x: CalEvent) => boolean) => Math.round(e.filter(f).reduce((a, x) => a + x.amount, 0) * 100) / 100;
    months.push({ ym, offset: k, sum: sum(() => true), paid: sum((x) => x.kind === "paid"), overdue: sum((x) => x.kind === "overdue"), events: e });
  }
  return months;
}

export interface Reminder { id: number; name: string; amount: number; next: string; days: number }
/** Кому що нагадати сьогодні: лише тому, хто платить; за `lead` днів, у день оплати і щодня після. */
export function remindersFor(items: RecItem[], userId: number, today: string, lead = LEAD_DAYS): Reminder[] {
  return items
    .filter((i) => i.active && i.payerId === userId && daysBetween(today, i.next) <= lead)
    .map((i) => ({ id: i.id, name: i.name, amount: i.amount, next: i.next, days: daysBetween(today, i.next) }))
    .sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : a.id - b.id));
}

const num = (v: unknown): number => Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
function text(v: unknown, max: number, what: string): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new FinError(400, `${what} — текст`);
  const s = v.trim();
  if (s.length > max) throw new FinError(400, `${what} задовга (до ${max} символів)`);
  return s || null;
}
function validDate(v: unknown): string {
  if (typeof v !== "string" || !ISO.test(v) || iso(P(v)) !== v) throw new FinError(400, "Вкажіть дату оплати");
  return v;
}
function amountOf(v: unknown): number {
  const a = Math.round(num(v) * 100) / 100;
  if (!(a > 0) || a > 1e11) throw new FinError(400, "Сума має бути більшою за нуль");
  return a;
}

// ── База ─────────────────────────────────────────────────────────────────────
const WHO = (col: string) => `(SELECT COALESCE(NULLIF(btrim(u.full_name), ''), mm.name, u.email) FROM users u LEFT JOIN managers mm ON mm.id = u.manager_id WHERE u.id = ${col})`;

export async function loadItems(db: Db): Promise<RecItem[]> {
  const r = await db.query(`SELECT r.id, r.name, r.amount::float8 AS amount, r.period, r.anchor_day AS anchor, r.next_due::text AS next,
      r.payer_id, ${WHO("r.payer_id")} AS payer, r.note, r.active
    FROM fin_recurring r ORDER BY r.active DESC, r.next_due, r.id`);
  return (r.rows as any[]).map((x) => ({ id: x.id, name: x.name, amount: x.amount, period: x.period, anchorDay: x.anchor, next: x.next,
    payerId: x.payer_id ?? null, payer: x.payer ?? null, note: x.note ?? null, active: !!x.active }));
}
export async function loadPaid(db: Db): Promise<PaidRow[]> {
  const r = await db.query(`SELECT p.id, p.recurring_id, r.name, p.due_date::text AS due, p.amount::float8 AS amount, p.planned::float8 AS planned,
      ${WHO("p.paid_by")} AS by, p.paid_at, ${WHO("p.cancelled_by")} AS cancelled_by, p.cancelled_at
    FROM fin_recurring_paid p JOIN fin_recurring r ON r.id = p.recurring_id ORDER BY p.due_date DESC, p.id DESC`);
  return (r.rows as any[]).map((x) => ({ id: x.id, recurringId: x.recurring_id, name: x.name, due: x.due, amount: x.amount, planned: x.planned,
    by: x.by ?? null, at: new Date(x.paid_at).toISOString(), cancelledBy: x.cancelled_by ?? null, cancelledAt: x.cancelled_at ? new Date(x.cancelled_at).toISOString() : null }));
}
/** Хто може платити — активні користувачі з правом `view_private_finance` (Тетяна й адміни). */
export async function loadPayers(db: Db): Promise<{ id: number; name: string }[]> {
  const r = await db.query(`SELECT u.id, COALESCE(NULLIF(btrim(u.full_name), ''), mm.name, u.email) AS name
    FROM users u JOIN roles ro ON ro.key = COALESCE(u.role_override, u.role) LEFT JOIN managers mm ON mm.id = u.manager_id
    WHERE u.is_active AND (ro.permissions ->> '${PAYER_PERM}') = 'true' ORDER BY 2`);
  return (r.rows as any[]).map((x) => ({ id: x.id, name: x.name }));
}

export interface Calendar {
  today: string; leadDays: number; items: (RecItem & { upcoming: string[] })[]; months: CalMonth[];
  history: (PaidRow & { canUndo: boolean })[]; payers: { id: number; name: string }[];
}
export async function loadCalendar(db: Db, today: string): Promise<Calendar> {
  const [items, paid, payers] = [await loadItems(db), await loadPaid(db), await loadPayers(db)];
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    today, leadDays: LEAD_DAYS,
    items: items.map((i) => {
      const upcoming: string[] = [];
      for (let d = i.next; upcoming.length < 4; d = addPeriod(d, i.period, i.anchorDay)) upcoming.push(d);
      return { ...i, upcoming };
    }),
    months: buildMonths(items, paid, today),
    history: paid.map((p) => ({ ...p, canUndo: undoable(p, byId) })),
    payers,
  };
}

async function payerOk(db: Db, v: unknown): Promise<number> {
  const id = Number(v);
  if (!Number.isInteger(id) || !(await loadPayers(db)).some((p) => p.id === id)) throw new FinError(400, "Оберіть, хто платить (Тетяна чи адмін)");
  return id;
}

/** Нова періодична оплата: назва, сума, як часто, найближча дата (з неї — «день оплати»), хто платить, примітка. */
export async function createRecurring(db: Db, actor: number, b: any): Promise<number> {
  const name = text(b?.name, 200, "Назва");
  if (!name) throw new FinError(400, "Вкажіть назву оплати");
  const amount = amountOf(b?.amount);
  if (!isPeriod(b?.period)) throw new FinError(400, "Оберіть, як часто платити");
  const date = validDate(b?.date);
  const payer = await payerOk(db, b?.payerId);
  const note = text(b?.note, 500, "Примітка");
  const r = await db.query(`INSERT INTO fin_recurring (name, amount, period, anchor_day, next_due, payer_id, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [name, amount, b.period, +date.slice(8, 10), date, payer, note, actor]);
  return r.rows[0].id;
}

/**
 * Змінити оплату: назва / сума / хто платить / примітка; графік (`period` + `date`) — нова найближча дата і новий «день
 * оплати»; `active` — вимкнути / увімкнути нагадування. Не передане поле лишається як було. Історію не чіпає.
 */
export async function updateRecurring(db: Db, actor: number, id: number, b: any): Promise<void> {
  const cur = (await db.query(`SELECT id, period, next_due::text AS next FROM fin_recurring WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new FinError(404, "Оплату не знайдено");
  const set: string[] = [], vals: unknown[] = [];
  const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  if (b?.name !== undefined) { const n = text(b.name, 200, "Назва"); if (!n) throw new FinError(400, "Вкажіть назву оплати"); put("name", n); }
  if (b?.amount !== undefined) put("amount", amountOf(b.amount));
  if (b?.payerId !== undefined) put("payer_id", await payerOk(db, b.payerId));
  if (b?.note !== undefined) put("note", text(b.note, 500, "Примітка"));
  if (b?.active !== undefined) { if (typeof b.active !== "boolean") throw new FinError(400, "Некоректний стан"); put("active", b.active); }
  if (b?.period !== undefined || b?.date !== undefined) {
    const period = b?.period ?? cur.period;
    if (!isPeriod(period)) throw new FinError(400, "Оберіть, як часто платити");
    put("period", period);
    // Нова дата — новий «день оплати»; лише період — якір той самий (інакше 28.02 зʼїло б 31-ше).
    if (b?.date !== undefined) { const date = validDate(b.date); put("next_due", date); put("anchor_day", +date.slice(8, 10)); }
  }
  if (!set.length) throw new FinError(400, "Нічого не змінено");
  put("updated_by", actor);
  vals.push(id);
  await db.query(`UPDATE fin_recurring SET ${set.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
}

/**
 * «Оплачено»: лише поточна дата (`due` = `next_due`) увімкненої оплати; сума — фактична (за замовчуванням — планова).
 * Пише рядок історії й зсуває дату на один період. Сторінка застаріла / двічі натиснули — 409.
 */
export async function payRecurring(db: Db, actor: number, id: number, b: any): Promise<{ next: string; paidId: number }> {
  const it = (await db.query(`SELECT id, amount::float8 AS amount, period, anchor_day AS anchor, next_due::text AS next, active
    FROM fin_recurring WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!it) throw new FinError(404, "Оплату не знайдено");
  if (!it.active) throw new FinError(400, "Нагадування вимкнене — спершу увімкніть");
  if (b?.due !== it.next) throw new FinError(409, "Цю оплату вже позначили або дату змінили — оновіть сторінку");
  const amount = b?.amount == null || b.amount === "" ? it.amount : amountOf(b.amount);
  const ins = await db.query(`INSERT INTO fin_recurring_paid (recurring_id, due_date, amount, planned, paid_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [id, it.next, amount, it.amount, actor]);
  const next = addPeriod(it.next, it.period, it.anchor);
  await db.query(`UPDATE fin_recurring SET next_due = $1, updated_by = $2, updated_at = now() WHERE id = $3`, [next, actor, id]);
  return { next, paidId: ins.rows[0].id };
}

/** Скасувати позначку: лише останню (від якої пораховано поточну дату); рядок лишається в історії як «скасовано». */
export async function undoPaid(db: Db, actor: number, paidId: number): Promise<{ next: string }> {
  const p = (await db.query(`SELECT id, recurring_id, due_date::text AS due, cancelled_at FROM fin_recurring_paid WHERE id = $1 FOR UPDATE`, [paidId])).rows[0];
  if (!p) throw new FinError(404, "Позначку не знайдено");
  if (p.cancelled_at) throw new FinError(409, "Цю позначку вже скасовано");
  const it = (await db.query(`SELECT period, anchor_day AS anchor, next_due::text AS next FROM fin_recurring WHERE id = $1 FOR UPDATE`, [p.recurring_id])).rows[0];
  if (!it || addPeriod(p.due, it.period, it.anchor) !== it.next) throw new FinError(409, "Скасувати можна лише останню позначку цієї оплати");
  await db.query(`UPDATE fin_recurring_paid SET cancelled_at = now(), cancelled_by = $1 WHERE id = $2`, [actor, paidId]);
  await db.query(`UPDATE fin_recurring SET next_due = $1, updated_by = $2, updated_at = now() WHERE id = $3`, [p.due, actor, p.recurring_id]);
  return { next: p.due };
}

const dmy = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const kyivAt = (s: string) => new Date(s).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** Excel історії: усі позначки, разом зі скасованими (з тим, хто й коли скасував). */
export function historyXlsx(rows: PaidRow[]): Buffer {
  return xlsxBook([{ name: "Історія оплат", rows: [
    ["Дата оплати", "Оплата", "Сплачено", "План", "Різниця", "Позначив", "Коли позначив", "Скасовано"],
    ...rows.map((p) => [dmy(p.due), p.name, p.amount, p.planned, Math.round((p.amount - p.planned) * 100) / 100, p.by ?? "", kyivAt(p.at),
      p.cancelledAt ? `${p.cancelledBy ?? "?"}, ${kyivAt(p.cancelledAt)}` : ""]),
  ] }]);
}
