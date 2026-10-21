/**
 * 🧾 ФАКТ ВИТРАТ ІЗ ТАБЛИЦІ «UTS Утверждение оплат» (задача Тетяни #5607). 20.10.2026 — тестова вкладка поруч із ручним
 * фактом; 21.10.2026 — джерело «План/факт» і операційних з жовтня; того ж дня Тетяна: «авто тепер основний, ручний
 * прибирати» — тестову вкладку й порівняння з ручним прибрано. Цей модуль лише ЧИТАЄ (пише `core/approvalsSync.ts`).
 *
 * Правило — зі слів Тетяни на зустрічі 13.10.2026 (відео з 16-ї хв):
 *  · беремо Категорію, Суму, Напрямок і ДАТУ ОПЛАТИ (колонка «Дата» — дата внесення, її не беремо);
 *  · лише напрямок «UA»; решта — окремим числом, не губиться. До жовтня 2026 той самий напрямок писали «Украина»
 *    (вересень — 171 рядок «Украина», жодного «UA»), тож «Украина» / «Україна» = UA — на екрані це підписано;
 *  · категорія = назва статті «План/факт» (з жовтня назви однакові); розділ — зі статті;
 *  · стаття без розділу (Податки ТОВ) — у «План/факт» факт є, а в операційні («Тиждень і місяць») не йде:
 *    «якщо немає розділу — пропускаємо»;
 *  · «ЗП - Комерційні / Адміністративні / Загальні» статті не мають — розділ за назвою.
 *  · «лише для статистики» (Тетяна 21.10.2026): категорія без статті, що йде в операційні, але не в «План/факт» —
 *    «Консалтинг СЕО» → Комерційні (`STATS_ONLY`); «Дивіденди» — нікуди, лише в «Не потрапило» для інформації.
 * З ЖОВТНЯ 2026 це не тест, а джерело: факт «План/факт» і операційні «Тиждень і місяць» (`FACT_AUTO_FROM`); таблицю
 * синхронізує `jobs/syncApprovals.ts` у `fin_approvals` (запис — `core/approvalsSync.ts`, цей модуль лише читає).
 * Кошик, що не підпадає під правило, називає себе (не розпізнано / кілька статей / не UA / сума не число /
 * дата оплати не дата) — щоб гроші не зникали мовчки. Реквізити й отримувача не читаємо взагалі.
 */
import type { Db } from "./finance.js";
import type { OpexSection } from "./financeKpi.js";

/** Колонки, без яких правило не працює. Шапку звіряємо за назвою: таблицю правлять руками, позиція може зсунутись. */
export const APPROVALS_COLUMNS = { entryDate: "Дата", what: "Що купити?", category: "Категорія", amount: "Сума", direction: "Напрямок", paid: "Оплачено", payDate: "Дата оплати" } as const;
type ColKey = keyof typeof APPROVALS_COLUMNS;

export function locateColumns(head: readonly string[]): Record<ColKey, number> {
  const at = new Map(head.map((h, i) => [String(h ?? "").trim(), i] as const));
  const out = {} as Record<ColKey, number>;
  const missing: string[] = [];
  for (const [k, name] of Object.entries(APPROVALS_COLUMNS) as [ColKey, string][]) {
    const i = at.get(name);
    if (i == null) missing.push(name); else out[k] = i;
  }
  if (missing.length) throw new Error(`Таблиця «Утверждение оплат»: немає колонок ${missing.map((m) => `«${m}»`).join(", ")} — шапку змінили?`);
  return out;
}

/** «06.10.2026» або «06.10.2026 9:41:00» → 2026-10-06; «дубль», «-», 31.02 — null. */
export function parseUaDate(raw: unknown): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** «9192,83», «1 745,64», «-1745,64» → число; «#NUM!», порожньо — null. */
export function parseSheetAmount(raw: unknown): number | null {
  const s = String(raw ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}

/** Номер картки чи рахунку, вписаний у текст (12+ цифр, можна з пробілами) → ••••1234. */
export const maskDigits = (s: string) => s.replace(/\d(?:[\d  -]{10,})\d/g, (m) => {
  const d = m.replace(/\D/g, "");
  return d.length >= 12 ? `••••${d.slice(-4)}` : m;
});

/** Назва для зіставлення категорії зі статтею: регістр, зайві пробіли й різні апострофи не мають значення. */
export const normName = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’'`ʹ]/g, "ʼ").replace(/\s+/g, " ").trim();

/** Напрямок «Україна»: «UA», а до жовтня 2026 — «Украина» / «Україна». USA, «Экспорт», порожньо — ні. */
export const isUaDirection = (d: string) => /^(ua|украина|україна)$/i.test(d.trim());

/** «ЗП - Комерційні» → commercial; «ЗП» без розділу — null (не вгадуємо). */
export function payrollSection(category: string): Exclude<OpexSection, "payroll"> | null {
  const m = /^зп\s*[-–—]\s*(комерц|адмін|загальн)/.exec(normName(category));
  return !m ? null : m[1] === "комерц" ? "commercial" : m[1] === "адмін" ? "admin" : "general";
}

export interface ApprovalLine {
  row: number; entryDate: string | null; payDate: string | null; payRaw: string;
  what: string; category: string; amount: number | null; direction: string; paid: boolean;
}

/** Рядки вкладки → лінії (рядок 1 — шапка; порожні рядки пропускаються). Реквізити й отримувача не беремо. */
export function parseApprovalRows(rows: readonly (readonly string[])[]): ApprovalLine[] {
  if (!rows.length) throw new Error("Таблиця «Утверждение оплат»: вкладка порожня");
  const c = locateColumns(rows[0] as string[]);
  const out: ApprovalLine[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (k: ColKey) => String(r[c[k]] ?? "").trim();
    if (!get("category") && !get("amount") && !get("payDate")) return;
    out.push({
      row: i + 2, entryDate: parseUaDate(get("entryDate")), payDate: parseUaDate(get("payDate")), payRaw: get("payDate"),
      what: maskDigits(get("what")), category: get("category"), amount: parseSheetAmount(get("amount")),
      direction: get("direction"), paid: /^(true|так|да|1)$/i.test(get("paid")),
    });
  });
  return out;
}

export interface PlanItem { id: number; name: string; section: OpexSection | null; resp: string; group: string; off: boolean }
type OpexSec = Exclude<OpexSection, "payroll">;
/** З якого місяця факт «План/факт» і операційні «Тиждень і місяць» — із таблиці оплат (Тетяна 20.10.2026: «лиш з жовтня»). */
export const FACT_AUTO_FROM = "2026-10-01";
export const factIsAuto = (month: string) => month >= FACT_AUTO_FROM;
/**
 * «Лише для статистики» (Тетяна 21.10.2026): категорія без статті «План/факт», яка все одно йде в операційні —
 * у розділ, названий тут. У «План/факт» не потрапляє.
 */
export const STATS_ONLY: Readonly<Record<string, OpexSec>> = { "консалтинг сео": "commercial" };
export type Bucket =
  | { kind: "item"; itemId: number }
  | { kind: "statsOnly"; section: OpexSec }
  | { kind: "payroll"; section: OpexSec }
  | { kind: "ambiguous"; category: string }
  | { kind: "unrecognized"; category: string };

/** Куди йде рядок: стаття (рівно одна з такою назвою) → «лише для статистики» → ЗП за назвою → інакше названий кошик. */
export function classify(category: string, byName: ReadonlyMap<string, readonly PlanItem[]>): Bucket {
  const hits = byName.get(normName(category)) ?? [];
  if (hits.length > 1) return { kind: "ambiguous", category };
  if (hits.length === 1) return { kind: "item", itemId: hits[0].id };
  const so = STATS_ONLY[normName(category)];
  if (so) return { kind: "statsOnly", section: so };
  const p = payrollSection(category);
  return p ? { kind: "payroll", section: p } : { kind: "unrecognized", category };
}

/** Рядок для розкриття — лише ці поля (без реквізитів, отримувача, коментаря). */
export interface ShownLine { payDate: string | null; what: string; amount: number | null; direction: string; paid: boolean }
export const toShownLine = (l: ApprovalLine): ShownLine => ({ payDate: l.payDate, what: l.what, amount: l.amount, direction: l.direction, paid: l.paid });

export interface Pot { key: string; label: string; sum: number; rows: number; unpaid: number; lines: ShownLine[] }
const r2 = (n: number) => Math.round(n * 100) / 100;
function add(map: Map<string, Pot>, key: string, label: string, l: ApprovalLine) {
  const p = map.get(key) ?? { key, label, sum: 0, rows: 0, unpaid: 0, lines: [] };
  p.sum = r2(p.sum + (l.amount ?? 0)); p.rows++; if (!l.paid) p.unpaid++;
  p.lines.push(toShownLine(l));
  map.set(key, p);
}

export interface MonthBuckets {
  items: Map<number, Pot>; payroll: Map<string, Pot>; statsOnly: Map<string, Pot>; ambiguous: Map<string, Pot>; unrecognized: Map<string, Pot>;
  notUa: Map<string, Pot>; badSum: Map<string, Pot>; badPayDate: Map<string, Pot>; noPayDate: Map<string, Pot>;
}
const monthEnd = (month: string) => { const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
/** Кошики МІСЯЦЯ — `bucketRange` від першого до останнього дня. */
export const bucketMonth = (lines: readonly ApprovalLine[], month: string, items: readonly PlanItem[]): MonthBuckets =>
  bucketRange(lines, `${month.slice(0, 7)}-01`, monthEnd(month), items);
/**
 * Розкладає рядки по кошиках ПЕРІОДУ [from, to] за датою оплати (тиждень чи місяць). Рядок без дати оплати / з не-датою
 * потрапляє в інформаційний кошик за датою внесення (щоб його було видно там, де його внесли), у факт — ніколи.
 */
export function bucketRange(lines: readonly ApprovalLine[], from: string, to: string, items: readonly PlanItem[]): MonthBuckets {
  const inP = (d: string | null | undefined) => d != null && d >= from && d <= to;
  const byName = new Map<string, PlanItem[]>();
  for (const it of items) byName.set(normName(it.name), [...(byName.get(normName(it.name)) ?? []), it]);
  const b: MonthBuckets = { items: new Map(), payroll: new Map(), statsOnly: new Map(), ambiguous: new Map(), unrecognized: new Map(),
    notUa: new Map(), badSum: new Map(), badPayDate: new Map(), noPayDate: new Map() };
  const itemsById = new Map<string, Pot>();
  for (const l of lines) {
    if (!l.payDate) {
      if (!inP(l.entryDate)) continue;
      if (l.payRaw) add(b.badPayDate, l.payRaw, `«${l.payRaw}»`, l); else add(b.noPayDate, "none", "ще без дати оплати", l);
      continue;
    }
    if (!inP(l.payDate)) continue;
    if (l.amount == null) { add(b.badSum, l.category || "—", l.category || "без категорії", l); continue; }
    if (!isUaDirection(l.direction)) { add(b.notUa, l.direction || "—", l.direction || "напрямок не вказано", l); continue; }
    const k = classify(l.category, byName);
    if (k.kind === "item") add(itemsById, String(k.itemId), String(k.itemId), l);
    else if (k.kind === "payroll") add(b.payroll, k.section, l.category, l);
    else if (k.kind === "statsOnly") add(b.statsOnly, normName(l.category), l.category, l);
    else add(b[k.kind], normName(k.category) || "—", k.category || "без категорії", l);
  }
  for (const [id, p] of itemsById) b.items.set(Number(id), p);
  return b;
}

const SECTIONS = ["commercial", "admin", "general"] as const;
/** Σ «лише для статистики» розділу. */
const statsSum = (b: MonthBuckets, s: OpexSec) => [...b.statsOnly.entries()].reduce((a, [k, p]) => a + (STATS_ONLY[k] === s ? p.sum : 0), 0);

// ─────────────── 🗄 ДЖЕРЕЛО З ЖОВТНЯ 2026: таблиця `fin_approvals` (дзеркало вкладки «На оплату») ───────────────

/** Рядки таблиці з бази: оплачені в [from, to] і (для інформаційних кошиків) внесені в [from, to] без дати оплати. */
export async function loadApprovalLines(db: Db, from: string, to: string): Promise<ApprovalLine[]> {
  const r = await db.query(`SELECT row_no, entry_date::text AS entry_date, pay_date::text AS pay_date, pay_raw, what, category, amount::text AS amount, direction, paid
      FROM fin_approvals WHERE pay_date BETWEEN $1::date AND $2::date OR (pay_date IS NULL AND entry_date BETWEEN $1::date AND $2::date)
     ORDER BY pay_date NULLS LAST, row_no`, [from, to]);
  return (r.rows as any[]).map((x) => ({ row: x.row_no, entryDate: x.entry_date, payDate: x.pay_date, payRaw: x.pay_raw, what: x.what,
    category: x.category, amount: x.amount == null ? null : Number(x.amount), direction: x.direction, paid: x.paid }));
}

/** Стан синку: коли таблицю востаннє прочитано, скільки рядків, остання відмова. Не синхронізовано ні разу — `syncedAt: null`. */
export async function approvalsState(db: Db): Promise<{ syncedAt: string | null; rows: number | null; error: string | null; errorAt: string | null }> {
  const s = (await db.query(`SELECT synced_at, rows, error, error_at FROM fin_approvals_state WHERE id = 1`)).rows[0];
  return { syncedAt: s?.synced_at ? new Date(s.synced_at).toISOString() : null, rows: s?.rows ?? null, error: s?.error ?? null, errorAt: s?.error_at ? new Date(s.error_at).toISOString() : null };
}

/** Статті «План/факт» (невидалені) — для зіставлення категорій. */
export async function planItems(db: Db, month: string): Promise<PlanItem[]> {
  const r = await db.query(`SELECT i.id, i.name, i.section, r.name AS resp, g.name AS grp, (i.off_from IS NOT NULL AND i.off_from <= $1::date) AS off
      FROM fin_items i JOIN fin_groups g ON g.id = i.group_id AND g.deleted_at IS NULL JOIN fin_resps r ON r.id = g.resp_id AND r.deleted_at IS NULL
     WHERE i.deleted_at IS NULL`, [month]);
  return (r.rows as any[]).map((x) => ({ id: x.id, name: x.name, section: x.section, resp: x.resp, group: x.grp, off: x.off }));
}

export interface OutsidePots { payroll: Pot[]; statsOnly: Pot[]; ambiguous: Pot[]; unrecognized: Pot[]; notUa: Pot[]; badSum: Pot[]; badPayDate: Pot[]; noPayDate: Pot[] }
const outsideOf = (b: MonthBuckets): OutsidePots => {
  const list = (m: Map<string, Pot>) => [...m.values()].sort((a, z) => z.sum - a.sum);
  return { payroll: list(b.payroll), statsOnly: list(b.statsOnly), ambiguous: list(b.ambiguous), unrecognized: list(b.unrecognized),
    notUa: list(b.notUa), badSum: list(b.badSum), badPayDate: list(b.badPayDate), noPayDate: list(b.noPayDate) };
};

/** Факт місяця «План/факт» із таблиці: стаття → її рядки; решта — кошики «Не потрапило у статті». */
export async function autoFactMonth(db: Db, month: string): Promise<{ byItem: Map<number, Pot>; outside: OutsidePots; state: Awaited<ReturnType<typeof approvalsState>> }> {
  const m = `${month.slice(0, 7)}-01`;
  const b = bucketMonth(await loadApprovalLines(db, m, monthEnd(m)), m, await planItems(db, m));
  return { byItem: b.items, outside: outsideOf(b), state: await approvalsState(db) };
}

/**
 * Операційні «Тиждень і місяць» за ПЕРІОД із таблиці: статті розділу + ЗП за назвою + «лише для статистики». Ключі
 * `opex_*` з'являються лише тоді, коли таблицю хоч раз синхронізовано: нуль без синку — не нуль, а «не знаємо».
 * `unassigned` — статті без розділу (Податки ТОВ): у «План/факт» є, в операційні не йдуть.
 */
export async function opexFromApprovals(db: Db, from: string, to: string): Promise<{ refs: Partial<Record<"opex_commercial" | "opex_admin" | "opex_general" | "opex_payroll", number>>; unassigned: { items: number; fact: number } }> {
  if (!(await approvalsState(db)).syncedAt) return { refs: {}, unassigned: { items: 0, fact: 0 } };
  const items = await planItems(db, from);
  const b = bucketRange(await loadApprovalLines(db, from, to), from, to, items);
  const sec = new Map(items.map((x) => [x.id, x.section]));
  const sum: Record<OpexSection, number> = { commercial: 0, admin: 0, general: 0, payroll: 0 };
  let un = 0, unItems = 0;
  for (const [id, p] of b.items) {
    const s = sec.get(id);
    if (s) sum[s] += p.sum; else { un += p.sum; unItems++; }
  }
  for (const s of SECTIONS) sum[s] += (b.payroll.get(s)?.sum ?? 0) + statsSum(b, s);
  // «ЗП + Податки на ЗП» (розділ статті «payroll») — лише якщо такі статті справді є: інакше рядок лишається ручним.
  const hasPayrollItems = items.some((x) => x.section === "payroll");
  return { refs: { opex_commercial: r2(sum.commercial), opex_admin: r2(sum.admin), opex_general: r2(sum.general), ...(hasPayrollItems ? { opex_payroll: r2(sum.payroll) } : {}) }, unassigned: { items: unItems, fact: r2(un) } };
}
