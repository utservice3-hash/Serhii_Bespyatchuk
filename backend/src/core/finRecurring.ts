/**
 * 📅 КАЛЕНДАР ОПЛАТ («Фінанси», Тетяна — задача #6369; макет «Г» затвердив Роман 27.10.2026): періодичні витрати (оренда,
 * сервіси, податки, страховки) — що й коли платити, і що вже оплачено.
 *
 * Прохід 2 (Тетяна 27.10.2026): оплата — це СТАТТЯ «План/факту» і МІСЯЦЬ (без дня), без «хто платить». Нагадування — не
 * повідомлення, а підказка біля статті в «План/факті» потрібного місяця з кнопкою «додати в план» (Роман: бачать «Таня +
 * керівництво», тобто всі, кому відкрито «Фінанси»; кнопка додає суму ДО наявного плану).
 *
 * Правила, на яких усе стоїть:
 *  1. Дата — завжди 1-ше число місяця; наступна — + період (`addPeriod` від якоря, без «зʼїзду» — борг 19, `monthKeys`).
 *  2. «Оплачено» позначає рівно поточний місяць (`next_due`) і зсуває його на один період; застаріла сторінка — 409.
 *  3. Історія не стирається: оплату вимикають (`active`), позначку скасовують (`cancelled_at`) — рядок лишається.
 *  4. План календар пише ЛИШЕ через `saveValues` ядра «Фінансів» — з тим самим замком погодженого місяця, перевіркою
 *     вимкненої статті й журналом змін; що вже додано — `fin_recurring_planned`, тож двічі одну суму не додати.
 */
import { FinError, saveValues, type Db } from "./finance.js";
import { xlsxBook } from "./xlsx.js";

/**
 * Як часто. «Раз на пів року» й «одноразово» — Тетяна 29.10.2026 («в календарі оплат треба додати: раз на пів року,
 * одноразова оплата — і для неї лише плановий місяць оплати»). Одноразова має рівно одну дату; «Оплачено» її закриває
 * (`active = false`), «Скасувати» — відкриває знову; графіка далі немає.
 */
export type Period = "month" | "quarter" | "halfyear" | "year" | "once";
export const STEP: Record<Period, number> = { month: 1, quarter: 3, halfyear: 6, year: 12, once: 0 };
export const PERIOD_LABEL: Record<Period, string> = { month: "щомісяця", quarter: "щокварталу", halfyear: "раз на пів року", year: "раз на рік", once: "одноразово" };
/** Смуга місяців: назад — до першої оплати, але не менше 6 міс.; уперед — 18 міс. */
export const BACK_MIN = 6, AHEAD = 18;

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const isPeriod = (v: unknown): v is Period => typeof v === "string" && v in STEP;

export function kyivToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
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
  if (period === "once") return next >= from && next <= to ? [next] : [];
  const out: string[] = [];
  for (let d = next, g = 0; d <= to && g < 240; d = addPeriod(d, period, anchorDay), g++) if (d >= from) out.push(d);
  return out;
}

export interface RecItem {
  id: number; itemId: number; name: string; amount: number; period: Period; anchorDay: number; next: string;
  note: string | null; active: boolean;
}
export interface PaidRow {
  id: number; recurringId: number; name: string; due: string; amount: number; planned: number;
  by: string | null; at: string; cancelledBy: string | null; cancelledAt: string | null;
}
/** Місяць минув, а не позначено — «overdue»; поточний — «soon»; майбутній — «plan». */
export type EventKind = "paid" | "overdue" | "soon" | "plan";
export interface CalEvent {
  recurringId: number; date: string; amount: number; kind: EventKind;
  /** Саме цей місяць можна позначити «Оплачено» (це `next_due` увімкненої оплати). */
  due: boolean;
  paidId: number | null; planned: number | null; by: string | null; at: string | null; canUndo: boolean;
}
export interface CalMonth { ym: string; offset: number; sum: number; paid: number; overdue: number; events: CalEvent[] }

/** Позначка, яку ще можна скасувати: жива й остання — саме від неї пораховано поточний місяць. */
export function undoable(p: PaidRow, items: Map<number, RecItem>): boolean {
  const it = items.get(p.recurringId);
  if (p.cancelledAt || !it) return false;
  // Одноразова: остання (і єдина) жива позначка — та, що закрила її на тій самій даті.
  if (it.period === "once") return !it.active && p.due === it.next;
  return addPeriod(p.due, it.period, it.anchorDay) === it.next;
}
const kindOf = (date: string, cur: string): EventKind => (date.slice(0, 7) < cur ? "overdue" : date.slice(0, 7) === cur ? "soon" : "plan");

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
    for (const d of occurrences(i.next, i.period, i.anchorDay, from, to))
      ev.push({ recurringId: i.id, date: d, amount: i.amount, kind: kindOf(d, cur), due: d === i.next, paidId: null, planned: null, by: null, at: null, canUndo: false });
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

export interface PlanHint {
  recurringId: number; itemId: number; name: string; note: string | null; amount: number; period: Period;
  /** Оплачено в цьому місяці (жива позначка) — сума фактична. */
  paid: boolean;
  added: { amount: number; by: string | null; at: string } | null;
}
/**
 * Підказки «План/факту» місяця `ym`: увімкнені оплати, що за графіком припадають на цей місяць, і ті, що в ньому вже
 * оплачено (навіть якщо оплату потім вимкнули). Кілька оплат на одну статтю — окремими підказками.
 */
export function planHintsOf(items: RecItem[], paid: PaidRow[], added: Map<string, PlanHint["added"]>, ym: string): PlanHint[] {
  const from = `${ym}-01`, to = lastDay(ym);
  const out: PlanHint[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const hint = (i: RecItem, amount: number, isPaid: boolean): PlanHint =>
    ({ recurringId: i.id, itemId: i.itemId, name: i.name, note: i.note, amount, period: i.period, paid: isPaid, added: added.get(`${i.id}@${ym}`) ?? null });
  for (const p of paid) {
    const i = byId.get(p.recurringId);
    if (i && !p.cancelledAt && p.due >= from && p.due <= to) out.push(hint(i, p.amount, true));
  }
  for (const i of items) if (i.active && occurrences(i.next, i.period, i.anchorDay, from, to).length && !out.some((h) => h.recurringId === i.id)) out.push(hint(i, i.amount, false));
  return out.sort((a, b) => a.itemId - b.itemId || a.recurringId - b.recurringId);
}

const num = (v: unknown): number => Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
function text(v: unknown, max: number, what: string): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new FinError(400, `${what} — текст`);
  const s = v.trim();
  if (s.length > max) throw new FinError(400, `${what} задовга (до ${max} символів)`);
  return s || null;
}
function monthOf(v: unknown): string {
  if (typeof v !== "string" || !YM.test(v.trim().slice(0, 7)) || (v.trim().length !== 7 && v.trim().length !== 10)) throw new FinError(400, "Вкажіть місяць оплати");
  return `${v.trim().slice(0, 7)}-01`;
}
function amountOf(v: unknown): number {
  const a = Math.round(num(v) * 100) / 100;
  if (!(a > 0) || a > 1e11) throw new FinError(400, "Сума має бути більшою за нуль");
  return a;
}

// ── База ─────────────────────────────────────────────────────────────────────
const WHO = (col: string) => `(SELECT COALESCE(NULLIF(btrim(u.full_name), ''), mm.name, u.email) FROM users u LEFT JOIN managers mm ON mm.id = u.manager_id WHERE u.id = ${col})`;

/** Назва оплати — назва СТАТТІ зараз (перейменували статтю — перейменувалась і оплата). */
export async function loadItems(db: Db): Promise<RecItem[]> {
  const r = await db.query(`SELECT r.id, r.item_id, i.name, r.amount::float8 AS amount, r.period, r.anchor_day AS anchor, r.next_due::text AS next, r.note, r.active
    FROM fin_recurring r JOIN fin_items i ON i.id = r.item_id ORDER BY r.active DESC, r.next_due, r.id`);
  return (r.rows as any[]).map((x) => ({ id: x.id, itemId: x.item_id, name: x.name, amount: x.amount, period: x.period, anchorDay: x.anchor, next: x.next,
    note: x.note ?? null, active: !!x.active }));
}
export async function loadPaid(db: Db): Promise<PaidRow[]> {
  const r = await db.query(`SELECT p.id, p.recurring_id, i.name, r.note, p.due_date::text AS due, p.amount::float8 AS amount, p.planned::float8 AS planned,
      ${WHO("p.paid_by")} AS by, p.paid_at, ${WHO("p.cancelled_by")} AS cancelled_by, p.cancelled_at
    FROM fin_recurring_paid p JOIN fin_recurring r ON r.id = p.recurring_id JOIN fin_items i ON i.id = r.item_id ORDER BY p.due_date DESC, p.id DESC`);
  return (r.rows as any[]).map((x) => ({ id: x.id, recurringId: x.recurring_id, name: x.note ? `${x.name} · ${x.note}` : x.name, due: x.due, amount: x.amount, planned: x.planned,
    by: x.by ?? null, at: new Date(x.paid_at).toISOString(), cancelledBy: x.cancelled_by ?? null, cancelledAt: x.cancelled_at ? new Date(x.cancelled_at).toISOString() : null }));
}
/** Статті для списку «Назва»: усі неудалені, з відповідальним і групою; вимкнені — з місяцем вимкнення. */
export async function loadArticles(db: Db): Promise<{ id: number; name: string; group: string; resp: string; offFrom: string | null }[]> {
  const r = await db.query(`SELECT i.id, i.name, g.name AS grp, rs.name AS resp, i.off_from::text AS off_from
    FROM fin_items i JOIN fin_groups g ON g.id = i.group_id JOIN fin_resps rs ON rs.id = g.resp_id
    WHERE i.deleted_at IS NULL AND g.deleted_at IS NULL AND rs.deleted_at IS NULL ORDER BY rs.sort, rs.id, g.sort, g.id, i.sort, i.id`);
  return (r.rows as any[]).map((x) => ({ id: x.id, name: x.name, group: x.grp, resp: x.resp, offFrom: x.off_from ?? null }));
}

export interface Calendar {
  today: string; items: (RecItem & { upcoming: string[] })[]; months: CalMonth[];
  history: (PaidRow & { canUndo: boolean })[]; articles: Awaited<ReturnType<typeof loadArticles>>;
}
export async function loadCalendar(db: Db, today: string): Promise<Calendar> {
  const [items, paid, articles] = [await loadItems(db), await loadPaid(db), await loadArticles(db)];
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    today,
    items: items.map((i) => {
      const upcoming: string[] = [];
      if (i.period === "once") upcoming.push(i.next);
      else for (let d = i.next; upcoming.length < 4; d = addPeriod(d, i.period, i.anchorDay)) upcoming.push(d);
      return { ...i, upcoming };
    }),
    months: buildMonths(items, paid, today),
    history: paid.map((p) => ({ ...p, canUndo: undoable(p, byId) })),
    articles,
  };
}
async function loadAdded(db: Db, ym: string): Promise<Map<string, PlanHint["added"]>> {
  const r = await db.query(`SELECT a.recurring_id, a.amount::float8 AS amount, ${WHO("a.added_by")} AS by, a.added_at
    FROM fin_recurring_planned a WHERE a.month = $1::date`, [`${ym}-01`]);
  return new Map((r.rows as any[]).map((x) => [`${x.recurring_id}@${ym}`, { amount: x.amount, by: x.by ?? null, at: new Date(x.added_at).toISOString() }]));
}
/** Підказки «План/факту» за місяць `m` (`РРРР-ММ`). */
export async function loadPlanHints(db: Db, m: unknown): Promise<PlanHint[]> {
  const ym = monthOf(m).slice(0, 7);
  return planHintsOf(await loadItems(db), await loadPaid(db), await loadAdded(db, ym), ym);
}

async function itemOk(db: Db, v: unknown): Promise<{ id: number; name: string }> {
  const id = Number(v);
  const r = Number.isInteger(id) && id > 0 ? (await db.query(`SELECT id, name FROM fin_items WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0] : null;
  if (!r) throw new FinError(400, "Оберіть статтю зі списку");
  return r;
}

/** Нова періодична оплата: стаття, сума, як часто, перший місяць, примітка. */
export async function createRecurring(db: Db, actor: number, b: any): Promise<number> {
  const item = await itemOk(db, b?.itemId);
  const amount = amountOf(b?.amount);
  if (!isPeriod(b?.period)) throw new FinError(400, "Оберіть, як часто платити");
  const month = monthOf(b?.month);
  const note = text(b?.note, 500, "Примітка");
  const r = await db.query(`INSERT INTO fin_recurring (item_id, name, amount, period, anchor_day, next_due, note, created_by)
    VALUES ($1, $2, $3, $4, 1, $5, $6, $7) RETURNING id`, [item.id, item.name, amount, b.period, month, note, actor]);
  return r.rows[0].id;
}

/**
 * Змінити оплату: стаття / сума / примітка; графік (`period` + `month`) — новий найближчий місяць; `active` — вимкнути /
 * увімкнути. Не передане поле лишається як було. Історію не чіпає.
 */
export async function updateRecurring(db: Db, actor: number, id: number, b: any): Promise<void> {
  const cur = (await db.query(`SELECT id, period FROM fin_recurring WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new FinError(404, "Оплату не знайдено");
  const set: string[] = [], vals: unknown[] = [];
  const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
  if (b?.itemId !== undefined) { const it = await itemOk(db, b.itemId); put("item_id", it.id); put("name", it.name); }
  if (b?.amount !== undefined) put("amount", amountOf(b.amount));
  if (b?.note !== undefined) put("note", text(b.note, 500, "Примітка"));
  if (b?.active !== undefined) { if (typeof b.active !== "boolean") throw new FinError(400, "Некоректний стан"); put("active", b.active); }
  if (b?.period !== undefined) { if (!isPeriod(b.period)) throw new FinError(400, "Оберіть, як часто платити"); put("period", b.period); }
  if (b?.month !== undefined) put("next_due", monthOf(b.month));
  if (!set.length) throw new FinError(400, "Нічого не змінено");
  put("updated_by", actor);
  vals.push(id);
  await db.query(`UPDATE fin_recurring SET ${set.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
}

/**
 * «Оплачено»: лише поточний місяць (`due` = `next_due`) увімкненої оплати; сума — фактична (за замовчуванням — планова).
 * Пише рядок історії й зсуває місяць на один період. Сторінка застаріла / двічі натиснули — 409.
 */
export async function payRecurring(db: Db, actor: number, id: number, b: any): Promise<{ next: string; paidId: number }> {
  const it = (await db.query(`SELECT id, amount::float8 AS amount, period, anchor_day AS anchor, next_due::text AS next, active
    FROM fin_recurring WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!it) throw new FinError(404, "Оплату не знайдено");
  if (!it.active) throw new FinError(400, "Нагадування вимкнене — спершу увімкніть");
  if (b?.due !== it.next) throw new FinError(409, "Цю оплату вже позначили або місяць змінили — оновіть сторінку");
  const amount = b?.amount == null || b.amount === "" ? it.amount : amountOf(b.amount);
  const ins = await db.query(`INSERT INTO fin_recurring_paid (recurring_id, due_date, amount, planned, paid_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [id, it.next, amount, it.amount, actor]);
  if (it.period === "once") {
    // Одноразова закривається: дата та сама, нагадувань і планування далі немає; «Скасувати» відкриє її знову.
    await db.query(`UPDATE fin_recurring SET active = false, updated_by = $1, updated_at = now() WHERE id = $2`, [actor, id]);
    return { next: it.next, paidId: ins.rows[0].id };
  }
  const next = addPeriod(it.next, it.period, it.anchor);
  await db.query(`UPDATE fin_recurring SET next_due = $1, updated_by = $2, updated_at = now() WHERE id = $3`, [next, actor, id]);
  return { next, paidId: ins.rows[0].id };
}

/** Скасувати позначку: лише останню (від якої пораховано поточний місяць); рядок лишається в історії як «скасовано». */
export async function undoPaid(db: Db, actor: number, paidId: number): Promise<{ next: string }> {
  const p = (await db.query(`SELECT id, recurring_id, due_date::text AS due, cancelled_at FROM fin_recurring_paid WHERE id = $1 FOR UPDATE`, [paidId])).rows[0];
  if (!p) throw new FinError(404, "Позначку не знайдено");
  if (p.cancelled_at) throw new FinError(409, "Цю позначку вже скасовано");
  const it = (await db.query(`SELECT period, anchor_day AS anchor, next_due::text AS next, active FROM fin_recurring WHERE id = $1 FOR UPDATE`, [p.recurring_id])).rows[0];
  const latest = it && (it.period === "once" ? !it.active && p.due === it.next : addPeriod(p.due, it.period, it.anchor) === it.next);
  if (!latest) throw new FinError(409, "Скасувати можна лише останню позначку цієї оплати");
  await db.query(`UPDATE fin_recurring_paid SET cancelled_at = now(), cancelled_by = $1 WHERE id = $2`, [actor, paidId]);
  await db.query(`UPDATE fin_recurring SET next_due = $1, active = true, updated_by = $2, updated_at = now() WHERE id = $3`, [p.due, actor, p.recurring_id]);
  return { next: p.due };
}

/**
 * «Додати в план»: сума оплати ДОДАЄТЬСЯ до наявного плану статті цього місяця (Роман 27.10.2026). Лише якщо оплата
 * справді припадає на цей місяць і ще не додавалась; запис — через `saveValues` (замок погодженого місяця, вимкнена
 * стаття, журнал змін — ті самі, що в ручного «Зберегти»).
 */
export async function addToPlan(db: Db, actor: number, b: any): Promise<{ before: number | null; after: number }> {
  const ym = monthOf(b?.month).slice(0, 7);
  const id = Number(b?.recurringId);
  if (!Number.isInteger(id) || id <= 0) throw new FinError(400, "Некоректна оплата");
  await db.query(`SELECT id FROM fin_recurring WHERE id = $1 FOR UPDATE`, [id]);
  const h = (await loadPlanHints(db, ym)).find((x) => x.recurringId === id);
  if (!h) throw new FinError(400, "Ця оплата не припадає на цей місяць");
  if (h.added) throw new FinError(409, `Уже додано в план (${h.added.by ?? "?"}) — вдруге не додається`);
  const cur = (await db.query(`SELECT plan::float8 AS plan FROM fin_values WHERE item_id = $1 AND month = $2::date`, [h.itemId, `${ym}-01`])).rows[0];
  const before = cur?.plan ?? null;
  const after = Math.round(((before ?? 0) + h.amount) * 100) / 100;
  await saveValues(db, actor, ym, [{ itemId: h.itemId, field: "plan", value: after }]);
  await db.query(`INSERT INTO fin_recurring_planned (recurring_id, month, amount, plan_before, added_by) VALUES ($1, $2, $3, $4, $5)`, [id, `${ym}-01`, h.amount, before, actor]);
  return { before, after };
}

const dmy = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const kyivAt = (s: string) => new Date(s).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** Excel історії: усі позначки, разом зі скасованими (з тим, хто й коли скасував). */
export function historyXlsx(rows: PaidRow[]): Buffer {
  return xlsxBook([{ name: "Історія оплат", rows: [
    ["Місяць", "Оплата", "Сплачено", "План", "Різниця", "Позначив", "Коли позначив", "Скасовано"],
    ...rows.map((p) => [dmy(p.due).slice(3), p.name, p.amount, p.planned, Math.round((p.amount - p.planned) * 100) / 100, p.by ?? "", kyivAt(p.at),
      p.cancelledAt ? `${p.cancelledBy ?? "?"}, ${kyivAt(p.cancelledAt)}` : ""]),
  ] }]);
}
