/**
 * 🧪 «ПЛАН/ФАКТ · АВТО (ТЕСТ)» — факт витрат із таблиці «UTS Утверждение оплат» поруч із ручним (Роман 20.10.2026:
 * «паралельна таблиця план-факту, щоб розуміти різницю і що виправляти»). НІЧОГО НЕ ПИШЕ: ні в базу, ні в таблицю, —
 * лише показує, що дало б правило, і де воно розходиться з тим, що Тетяна внесла руками.
 *
 * Правило — зі слів Тетяни на зустрічі 13.10.2026 (відео з 16-ї хв):
 *  · беремо Категорію, Суму, Напрямок і ДАТУ ОПЛАТИ (колонка «Дата» — дата внесення, її не беремо);
 *  · лише напрямок «UA»; решта — окремим числом, не губиться. До жовтня 2026 той самий напрямок писали «Украина»
 *    (вересень — 171 рядок «Украина», жодного «UA»), тож «Украина» / «Україна» = UA — на екрані це підписано;
 *  · категорія = назва статті «План/факт» (з жовтня назви однакові); розділ — зі статті;
 *  · стаття без розділу (Податки ТОВ) — у «План/факт» факт є, а в операційні («Тиждень і місяць») не йде:
 *    «якщо немає розділу — пропускаємо»;
 *  · «ЗП - Комерційні / Адміністративні / Загальні» статті не мають — розділ за назвою.
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
export type Bucket =
  | { kind: "item"; itemId: number }
  | { kind: "payroll"; section: Exclude<OpexSection, "payroll"> }
  | { kind: "ambiguous"; category: string }
  | { kind: "unrecognized"; category: string };

/** Куди йде рядок: стаття (рівно одна з такою назвою) → ЗП за назвою → інакше названий кошик. */
export function classify(category: string, byName: ReadonlyMap<string, readonly PlanItem[]>): Bucket {
  const hits = byName.get(normName(category)) ?? [];
  if (hits.length > 1) return { kind: "ambiguous", category };
  if (hits.length === 1) return { kind: "item", itemId: hits[0].id };
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
  items: Map<number, Pot>; payroll: Map<string, Pot>; ambiguous: Map<string, Pot>; unrecognized: Map<string, Pot>;
  notUa: Map<string, Pot>; badSum: Map<string, Pot>; badPayDate: Map<string, Pot>; noPayDate: Map<string, Pot>;
}
/**
 * Розкладає рядки по кошиках МІСЯЦЯ за датою оплати. Рядок без дати оплати / з не-датою потрапляє в інформаційний кошик
 * за датою внесення (щоб його було видно в тому місяці, де його внесли), у факт — ніколи.
 */
export function bucketMonth(lines: readonly ApprovalLine[], month: string, items: readonly PlanItem[]): MonthBuckets {
  const ym = month.slice(0, 7);
  const byName = new Map<string, PlanItem[]>();
  for (const it of items) byName.set(normName(it.name), [...(byName.get(normName(it.name)) ?? []), it]);
  const b: MonthBuckets = { items: new Map(), payroll: new Map(), ambiguous: new Map(), unrecognized: new Map(),
    notUa: new Map(), badSum: new Map(), badPayDate: new Map(), noPayDate: new Map() };
  const itemsById = new Map<string, Pot>();
  for (const l of lines) {
    if (!l.payDate) {
      if (l.entryDate?.slice(0, 7) !== ym) continue;
      if (l.payRaw) add(b.badPayDate, l.payRaw, `«${l.payRaw}»`, l); else add(b.noPayDate, "none", "ще без дати оплати", l);
      continue;
    }
    if (l.payDate.slice(0, 7) !== ym) continue;
    if (l.amount == null) { add(b.badSum, l.category || "—", l.category || "без категорії", l); continue; }
    if (!isUaDirection(l.direction)) { add(b.notUa, l.direction || "—", l.direction || "напрямок не вказано", l); continue; }
    const k = classify(l.category, byName);
    if (k.kind === "item") add(itemsById, String(k.itemId), String(k.itemId), l);
    else if (k.kind === "payroll") add(b.payroll, k.section, l.category, l);
    else add(b[k.kind], normName(k.category) || "—", k.category || "без категорії", l);
  }
  for (const [id, p] of itemsById) b.items.set(Number(id), p);
  return b;
}

export interface CompareItem { id: number; respId: number; groupId: number; resp: string; group: string; name: string; section: OpexSection | null; off: boolean; plan: number | null; manual: number | null; auto: number; diff: number; rows: number; unpaid: number; lines: ShownLine[] }
export interface CompareSection { section: Exclude<OpexSection, "payroll">; manualArticles: number; autoArticles: number; autoPayroll: number; autoTotal: number; manualOpex: number | null }
export interface ApprovalsCompare {
  month: string; fetchedAt: string; sheetLines: number;
  items: CompareItem[]; sections: CompareSection[];
  payroll: Pot[]; ambiguous: Pot[]; unrecognized: Pot[]; notUa: Pot[]; badSum: Pot[]; badPayDate: Pot[]; noPayDate: Pot[];
  /** Статті без розділу (Податки ТОВ): у «План/факт» є, в операційні не йдуть. */
  withoutSection: { manual: number; auto: number; names: string[] };
  totals: { plan: number; manual: number; autoArticles: number; autoPayroll: number; outside: number; diffItems: number };
}
const SECTIONS = ["commercial", "admin", "general"] as const;
const OPEX_REF = { commercial: "opex_commercial", admin: "opex_admin", general: "opex_general" } as const;

/** Порівняння місяця: ручний факт «План/факт» і ручні операційні «Тиждень і місяць» проти правила над таблицею. */
export async function approvalsCompare(db: Db, month: string, lines: readonly ApprovalLine[], fetchedAt: Date): Promise<ApprovalsCompare> {
  const items = (await db.query(`SELECT i.id, i.name, i.section, r.id AS resp_id, g.id AS group_id, r.name AS resp, g.name AS grp, v.plan::text AS plan, (i.off_from IS NOT NULL AND i.off_from <= $1::date) AS off,
        v.fact::text AS fact
      FROM fin_items i JOIN fin_groups g ON g.id = i.group_id AND g.deleted_at IS NULL
      JOIN fin_resps r ON r.id = g.resp_id AND r.deleted_at IS NULL
      LEFT JOIN fin_values v ON v.item_id = i.id AND v.month = $1::date
     WHERE i.deleted_at IS NULL ORDER BY r.sort, r.id, g.sort, g.id, i.sort, i.id`, [month])).rows as { id: number; name: string; section: OpexSection | null; resp_id: number; group_id: number; resp: string; grp: string; plan: string | null; off: boolean; fact: string | null }[];
  const plan: PlanItem[] = items.map((x) => ({ id: x.id, name: x.name, section: x.section, resp: x.resp, group: x.grp, off: x.off }));
  const b = bucketMonth(lines, month, plan);
  const opex = new Map(((await db.query(`SELECT k.ref_source, v.value::text AS value FROM fin_kpis k
      LEFT JOIN fin_kpi_values v ON v.kpi_id = k.id AND v.period_kind = 'month' AND v.period_start = $1::date
     WHERE k.deleted_at IS NULL AND k.ref_source = ANY($2)`, [month, Object.values(OPEX_REF)])).rows as { ref_source: string; value: string | null }[])
    .map((x) => [x.ref_source, x.value == null ? null : Number(x.value)] as const));
  const outItems: CompareItem[] = items
    .map((x) => {
      const p = b.items.get(x.id), manual = x.fact == null ? null : Number(x.fact), auto = p?.sum ?? 0;
      return { id: x.id, respId: x.resp_id, groupId: x.group_id, resp: x.resp, group: x.grp, name: x.name, section: x.section, off: x.off,
        plan: x.plan == null ? null : Number(x.plan), manual, auto, diff: r2(auto - (manual ?? 0)),
        rows: p?.rows ?? 0, unpaid: p?.unpaid ?? 0, lines: p?.lines ?? [] };
    })
    .filter((x) => !x.off || x.plan != null || x.manual != null || x.rows > 0);
  const sumBy = (pred: (x: CompareItem) => boolean, f: (x: CompareItem) => number) => r2(outItems.filter(pred).reduce((s, x) => s + f(x), 0));
  const sections: CompareSection[] = SECTIONS.map((s) => {
    const autoArticles = sumBy((x) => x.section === s, (x) => x.auto), autoPayroll = b.payroll.get(s)?.sum ?? 0;
    return { section: s, manualArticles: sumBy((x) => x.section === s, (x) => x.manual ?? 0), autoArticles, autoPayroll,
      autoTotal: r2(autoArticles + autoPayroll), manualOpex: opex.get(OPEX_REF[s]) ?? null };
  });
  const list = (m: Map<string, Pot>) => [...m.values()].sort((a, z) => z.sum - a.sum);
  const outside = [b.ambiguous, b.unrecognized, b.notUa].flatMap(list).reduce((s, p) => s + p.sum, 0);
  return {
    month, fetchedAt: fetchedAt.toISOString(), sheetLines: lines.length, items: outItems, sections,
    payroll: list(b.payroll), ambiguous: list(b.ambiguous), unrecognized: list(b.unrecognized),
    notUa: list(b.notUa), badSum: list(b.badSum), badPayDate: list(b.badPayDate), noPayDate: list(b.noPayDate),
    withoutSection: { manual: sumBy((x) => !x.section, (x) => x.manual ?? 0), auto: sumBy((x) => !x.section, (x) => x.auto),
      names: outItems.filter((x) => !x.section && (x.manual != null || x.rows > 0)).map((x) => x.name) },
    totals: { plan: sumBy(() => true, (x) => x.plan ?? 0), manual: sumBy(() => true, (x) => x.manual ?? 0), autoArticles: sumBy(() => true, (x) => x.auto),
      autoPayroll: r2(list(b.payroll).reduce((s, p) => s + p.sum, 0)), outside: r2(outside), diffItems: outItems.filter((x) => Math.abs(x.diff) >= 0.005).length },
  };
}
