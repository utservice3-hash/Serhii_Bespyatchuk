/**
 * 💰 ФІНАНСИ, прохід 2а (01.10.2026): «Тиждень і місяць» — аркуш «ФМ» книги «UTS Щотижневі плани ROP HR CОО».
 *
 * Розділи й показники (як рядки аркуша) і їхні значення за тиждень (Пн–Нд за Києвом) або календарний місяць.
 * Правила, на яких стоїть вкладка (кожне тримає гейт):
 *  1. **Періоди — за Києвом**, тиждень з понеділка (#940). Значення лежить на ПЕРШОМУ дні періоду.
 *  2. **Обчислювані показники не зберігаються** (#941): «Комісійні» = дохід − витрати, «Разом» = сума решти
 *     ручних показників розділу. Порожнє ≠ нуль: якщо доданків немає взагалі — результат «не внесено».
 *  3. **Закритий період незмінний** (#942): 409 на будь-який запис; відкривається тією ж кнопкою, з історією.
 *  4. **Довідка CRM / 1С лише ПОРУЧ** (#943): число Тетяни не підміняється; при збереженні довідка
 *     запамʼятовується, бо дебіторка в дашборді — знімок без історії.
 *  5. **Перенесення з аркуша — разове** (#946): тиждень бере ФІНАЛЬНЕ значення (колонка «минулого тижня»
 *     наступного блоку), а якщо його немає — проміжне з власного блоку, і це видно.
 */
import { FinError, parseAmount, type Db } from "./finance.js";

export type PeriodKind = "week" | "month";
export type RefSource = "delivered_income" | "delivered_expense" | "unloaded_income" | "unloaded_expense" | "receivables"
  | "opex_commercial" | "opex_general" | "opex_admin" | "opex_payroll" | "receivables_fx" | "bank_in" | "bank_out";
export const REF_SOURCES: readonly RefSource[] = ["delivered_income", "delivered_expense", "unloaded_income", "unloaded_expense", "receivables",
  "opex_commercial", "opex_general", "opex_admin", "opex_payroll", "receivables_fx", "bank_in", "bank_out"];
/**
 * Розділ статті «План/факт» → рядок «Операційних витрат» (прохід 2в, прохання Тетяни 05.10.2026). Факт у «План/факт»
 * лише ПОМІСЯЧНИЙ, тож із нього рахується тільки МІСЯЦЬ; тиждень лишається ручним. Розділ без жодної статті — теж
 * ручний (інакше «ЗП + Податки», для яких статей ще немає, не можна було б внести взагалі).
 */
export const OPEX_SECTIONS = ["commercial", "general", "admin", "payroll"] as const;
export type OpexSection = (typeof OPEX_SECTIONS)[number];
export const OPEX_REF: Record<OpexSection, RefSource> = { commercial: "opex_commercial", general: "opex_general", admin: "opex_admin", payroll: "opex_payroll" };
const isOpexRef = (r: unknown) => typeof r === "string" && r.startsWith("opex_");
/**
 * Рядки, які вночі НЕ фіксуються, а лише закриттям періоду (і відкриття знову робить їх живими): їхнє джерело
 * дописують ПІСЛЯ кінця періоду — факт «План/факт» і ручний Сейф у «Виписці» (прохід 2г). Рядки з Kommo — навпаки,
 * фіксуються вночі, бо CRM змінюється заднім числом сама.
 */
const isCloseOnlyRef = (r: unknown) => typeof r === "string" && (r.startsWith("opex_") || r.startsWith("bank_"));

// ── Дати й періоди (чисті функції, UTC-арифметика над 'YYYY-MM-DD') ──────────────

const d2s = (d: Date) => d.toISOString().slice(0, 10);
const s2d = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => { const d = s2d(s); d.setUTCDate(d.getUTCDate() + n); return d2s(d); };

/** Київська дата моменту. `sv-SE` дає рівно YYYY-MM-DD. */
export const kyivDate = (now: Date = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

/** Понеділок тижня, до якого належить дата. */
export function weekStart(date: string): string {
  const dow = (s2d(date).getUTCDay() + 6) % 7; // 0 = понеділок
  return addDays(date, -dow);
}
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** Будь-яка дата → початок її періоду. Невалідне — 400. */
export function periodStart(kindArg: unknown, dateArg: unknown): { kind: PeriodKind; start: string } {
  const kind = kindArg === "week" || kindArg === "month" ? kindArg : null;
  if (!kind) throw new FinError(400, "Період — тиждень або місяць");
  const m = typeof dateArg === "string" ? /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(dateArg.trim()) : null;
  if (!m) throw new FinError(400, "Дата — у форматі РРРР-ММ-ДД");
  const s = `${m[1]}-${m[2]}-${m[3] ?? "01"}`;
  if (Number.isNaN(s2d(s).getTime()) || d2s(s2d(s)) !== s) throw new FinError(400, "Невалідна дата");
  return { kind, start: kind === "week" ? weekStart(s) : monthStart(s) };
}
export function periodEnd(kind: PeriodKind, start: string): string {
  if (kind === "week") return addDays(start, 6);
  const d = s2d(start); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d2s(d);
}
export function shiftPeriod(kind: PeriodKind, start: string, n: number): string {
  if (kind === "week") return addDays(start, 7 * n);
  const d = s2d(start); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d2s(d);
}
/** Поточний період за Києвом. */
export const currentPeriod = (kind: PeriodKind, now: Date = new Date()) => (kind === "week" ? weekStart(kyivDate(now)) : monthStart(kyivDate(now)));

/**
 * Дебіторка — знімок «зараз» без історії. Вона пасує періоду, лише якщо це поточний період або (для фіксації) не
 * пізніше доби після його кінця; інакше минулий тиждень отримав би сьогоднішній борг.
 */
export function receivablesSnapshotFits(kind: PeriodKind, start: string, now: Date, forFreeze: boolean): boolean {
  const today = kyivDate(now), end = periodEnd(kind, start);
  return start === currentPeriod(kind, now) || (forFreeze && today > end && today <= addDays(end, 1));
}
/**
 * 🗓 СТАРТ АВТОМАТИКИ «ФМ» (рішення Романа 01.10.2026: «суми з цього тижня, бекфіл по таблиці, фільтри тільки з нового
 * тижня»). Періоди ДО старту — числа з таблиці Тетяни: авто-рядок там поводиться як ручний (вноситься, не
 * фіксується, без CRM поруч). З тижня 05.10 і з жовтня — рахується за фільтрами й фіксується.
 */
export const FM_AUTO_FROM: Readonly<Record<PeriodKind, string>> = { week: "2026-10-05", month: "2026-10-01" };
export const autoActive = (kind: PeriodKind, start: string) => start >= FM_AUTO_FROM[kind];
/**
 * 🗓 Рядки з ФІЛЬТРІВ KOMMO («Поставлені», «Вигрузка») рахуються з CRM уже з ВЕРЕСНЯ (зустріч з Тетяною 05.10.2026:
 * «вересень не сходиться» — бо на екрані стояло її проміжне число з таблиці). Звірено того ж дня: CRM за вересень
 * 26 725 166 / 21 851 027 — рівно її фільтр (26 725 165 і 21 846 527 + «4 500, що десь випали»). Решта авто-рядків
 * (Виписка, «План/факт», дебіторка) — з `FM_AUTO_FROM`: у вересні там немає Сейфу, карток і зарплат.
 */
export const FM_KOMMO_FROM: Readonly<Record<PeriodKind, string>> = { week: "2026-08-31", month: "2026-09-01" };
const isKommoRef = (r: unknown) => typeof r === "string" && (r.startsWith("delivered_") || r.startsWith("unloaded_"));
export const kommoActive = (kind: PeriodKind, start: string) => start >= FM_KOMMO_FROM[kind];
/** Чи діє автоматика для рядка з цим джерелом у цьому періоді. */
export const autoActiveFor = (ref: unknown, kind: PeriodKind, start: string) => (isKommoRef(ref) ? kommoActive(kind, start) : autoActive(kind, start));
/**
 * Чи рахується авто-рядок сам у ЦЬОМУ періоді. До старту — ні (число з таблиці). Операційні витрати — лише місяць і
 * лише коли в розділі є статті (`refs` несе ключ розділу тільки тоді). Решта авто-рядків — завжди після старту.
 */
export function isAutoIn(x: { kind: string; ref_source?: string | null }, kind: PeriodKind, start: string, refs: RefValues): boolean {
  if (x.kind !== "auto" || !autoActiveFor(x.ref_source, kind, start)) return false;
  if (isOpexRef(x.ref_source)) return kind === "month" && (x.ref_source as string) in refs;
  return true;
}
export const isActiveIn = (offFrom: string | null, start: string) => offFrom == null || start < offFrom;

// ── Обчислювані показники ─────────────────────────────────────────────────────

export interface KpiDef { id: number; sectionId: number; kind: "manual" | "sum" | "diff" | "auto"; argA: number | null; argB: number | null; active: boolean }
/** Значення, що надходять «ззовні» обчислень: ручні й автоматичні (за фільтрами CRM). */
const isInput = (k: string) => k === "manual" || k === "auto";
const cents = (v: number) => Math.round(v * 100);

/**
 * Значення обчислюваних показників із ручних. «sum» — сума ДІЮЧИХ ручних показників свого розділу;
 * «diff» — arg_a − arg_b. Порожнє ≠ нуль: немає жодного доданка → null; для різниці — потрібні обидва.
 */
export function computeValues(defs: readonly KpiDef[], manual: ReadonlyMap<number, number | null>): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const d of defs) if (isInput(d.kind)) out.set(d.id, manual.get(d.id) ?? null);
  for (const d of defs) {
    if (d.kind === "sum") {
      const parts = defs.filter((x) => x.sectionId === d.sectionId && isInput(x.kind) && x.active).map((x) => out.get(x.id) ?? null);
      const present = parts.filter((v): v is number => v != null);
      out.set(d.id, present.length ? present.reduce((a, v) => a + cents(v), 0) / 100 : null);
    }
  }
  for (const d of defs) {
    if (d.kind === "diff") {
      const a = d.argA != null ? out.get(d.argA) ?? null : null, b = d.argB != null ? out.get(d.argB) ?? null : null;
      out.set(d.id, a != null && b != null ? (cents(a) - cents(b)) / 100 : null);
    }
  }
  return out;
}

// ── Журнал ────────────────────────────────────────────────────────────────────

const ACTOR = `COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1))`;
const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));
const pLabel = (kind: PeriodKind, start: string) =>
  kind === "week" ? `${start.slice(8, 10)}.${start.slice(5, 7)}–${periodEnd(kind, start).slice(8, 10)}.${periodEnd(kind, start).slice(5, 7)}.${start.slice(0, 4)}` : `${start.slice(5, 7)}.${start.slice(0, 4)}`;

async function log(db: Db, actor: number | null, target: "section" | "kpi" | "period", targetId: number | null, what: string,
  x: { kind?: PeriodKind; start?: string; field?: "value" | "note"; old?: number | null; new?: number | null } = {}) {
  await db.query(`INSERT INTO fin_kpi_log (actor_id, target, target_id, period_kind, period_start, field, old_value, new_value, what)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [actor, target, targetId, x.kind ?? null, x.start ?? null, x.field ?? null, x.old ?? null, x.new ?? null, what]);
}
async function uniqueName<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new FinError(409, "Така назва тут уже є");
    throw e;
  }
}
const cleanName = (v: unknown, what: string): string => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) throw new FinError(400, `Вкажіть назву ${what}`);
  if (s.length > 200) throw new FinError(400, "Назва задовга (до 200 символів)");
  return s;
};
const idArg = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new FinError(400, `Некоректний ${what}`);
  return n;
};
const num = (v: unknown): number | null => (v == null ? null : Number(v));

// ── Читання періоду ───────────────────────────────────────────────────────────

/** Довідкові числа, які роут рахує ядром грошей / дебіторки для цього періоду (live). */
export type RefValues = Partial<Record<RefSource, number | null>>;

/**
 * `prevRefs` — числа джерел для ПОПЕРЕДНЬОГО періоду (стовпець «минулий»). Без них минулий незафіксований авто-рядок
 * показав би збережене число з таблиці, а не CRM (спіймано на проді 05.10.2026: «минулий тиждень» 2 973 228 замість
 * 4 821 254). Тижні тепер не фіксуються, тож без цього стовпець брехав би щотижня.
 */
export async function loadPeriod(db: Db, kindArg: unknown, dateArg: unknown, refs: RefValues = {}, now: Date = new Date(), prevRefs: RefValues | null = null) {
  const { kind, start } = periodStart(kindArg, dateArg);
  const prev = shiftPeriod(kind, start, -1);
  const k = await db.query(`
    SELECT s.id AS section_id, s.name AS section_name, f.id, f.name, f.unit, f.kind, f.arg_a, f.arg_b, f.ref_source, f.off_from::text AS off_from
      FROM fin_kpi_sections s LEFT JOIN fin_kpis f ON f.section_id = s.id AND f.deleted_at IS NULL
     WHERE s.deleted_at IS NULL ORDER BY s.sort, s.id, f.sort, f.id`);
  const v = await db.query(`SELECT kpi_id, period_start::text AS p, value::text AS value, note, ref_value::text AS ref_value, ref_at, frozen_at
      FROM fin_kpi_values WHERE period_kind = $1 AND period_start IN ($2::date, $3::date)`, [kind, start, prev]);
  const cls = await db.query(`SELECT period_start::text AS p FROM fin_kpi_closes WHERE period_kind = $1 AND period_start IN ($2::date, $3::date)`, [kind, start, prev]);
  const closedSet = new Set(cls.rows.map((x: any) => x.p));
  const cur = new Map<number, any>(), old = new Map<number, any>();
  for (const x of v.rows) (x.p === start ? cur : old).set(x.kpi_id, x);
  // До старту автоматики авто-рядок — ручний (число з таблиці); `kind` у відповіді — уже з поправкою на період.
  const refsOf = (period: string): RefValues => (period === start ? refs : prevRefs ?? {});
  const kindIn = (x: any, period: string) => (x.kind === "auto" && !isAutoIn(x, kind, period, refsOf(period)) ? "manual" : x.kind);
  const defs: KpiDef[] = k.rows.filter((x: any) => x.id != null).map((x: any) => ({
    id: x.id, sectionId: x.section_id, kind: x.kind, argA: x.arg_a, argB: x.arg_b, active: isActiveIn(x.off_from, start) }));
  const prevDefs = defs.map((d) => ({ ...d, active: isActiveIn(k.rows.find((x: any) => x.id === d.id).off_from, prev) }));
  // «Авто»: зафіксоване (джобою або закритий період) — з бази; інакше — живе число ядра для ЦЬОГО періоду.
  // Незафіксоване збережене значення (напр. проміжне з «ФМ») автоматичного рядка не перекриває живого.
  const kindOf = new Map(k.rows.filter((x: any) => x.id != null).map((x: any) => [x.id, x]));
  // «saved» — живого числа для періоду немає (дебіторка минулого тижня, попередній період), а збережене є: показуємо
  // його, а не порожнечу; підпис на екрані каже, що воно не з ядра зараз.
  const hasLive = (x: any, period: string) => x.ref_source in refsOf(period);
  const autoSource = (row: any, period: string, liveOk: boolean): "frozen" | "closed" | "saved" | null =>
    row?.frozen_at ? "frozen" : closedSet.has(period) && row?.value != null ? "closed" : !liveOk && row?.value != null ? "saved" : null;
  const pick = (map: Map<number, any>, period: string) => new Map([...kindOf.keys()].map((id) => {
    const x: any = kindOf.get(id), row = map.get(id);
    if (kindIn(x, period) !== "auto") return [id, num(row?.value)];
    if (autoSource(row, period, hasLive(x, period))) return [id, num(row.value)];
    return [id, hasLive(x, period) ? refsOf(period)[x.ref_source as RefSource] ?? null : null];
  }));
  const curVals = computeValues(defs, pick(cur, start));
  const prevVals = computeValues(prevDefs, pick(old, prev));
  const sections: { id: number; name: string; kpis: any[] }[] = [];
  for (const x of k.rows) {
    let s = sections[sections.length - 1];
    if (!s || s.id !== x.section_id) { s = { id: x.section_id, name: x.section_name, kpis: [] }; sections.push(s); }
    if (x.id == null) continue;
    const c = cur.get(x.id);
    s.kpis.push({
      id: x.id, name: x.name, unit: x.unit, kind: kindIn(x, start), argA: x.arg_a, argB: x.arg_b, refSource: x.ref_source,
      offFrom: x.off_from, active: isActiveIn(x.off_from, start),
      value: curVals.get(x.id) ?? null, prevValue: prevVals.get(x.id) ?? null, note: c?.note ?? null,
      savedRef: c?.ref_value != null ? { value: Number(c.ref_value), at: c.ref_at } : null,
      autoState: kindIn(x, start) === "auto" ? (autoSource(c, start, hasLive(x, start)) ?? (hasLive(x, start) ? "live" : null)) : null,
      liveRef: x.ref_source && x.ref_source in refs && !(x.kind === "auto" && !isAutoIn(x, kind, start, refs)) ? refs[x.ref_source as RefSource] ?? null : null,
    });
  }
  const cl = await db.query(`SELECT c.closed_at AS at, c.note, ${ACTOR} AS actor FROM fin_kpi_closes c LEFT JOIN users u ON u.id = c.closed_by
     WHERE c.period_kind = $1 AND c.period_start = $2::date`, [kind, start]);
  const im = await db.query(`SELECT detail FROM fin_kpi_imports WHERE key = 'fm-2026'`);
  const imp = im.rows[0]?.detail;
  const interim = Array.isArray(imp?.interim?.[kind]) && imp.interim[kind].includes(start);
  return {
    kind, start, end: periodEnd(kind, start), prev, label: pLabel(kind, start), prevLabel: pLabel(kind, prev),
    current: currentPeriod(kind, now), sections,
    closed: cl.rows[0] ? { at: cl.rows[0].at, by: cl.rows[0].actor ?? null, note: cl.rows[0].note ?? null } : null,
    importedInterim: interim,
  };
}

/** Картка показника: значення за останні 12 періодів і історія. */
export async function kpiCard(db: Db, id: number, kindArg: unknown) {
  const { kind } = periodStart(kindArg, "2000-01-03");
  const r = await db.query(`SELECT f.id, f.name, f.unit, f.kind, f.ref_source, f.off_from::text AS off_from, f.deleted_at, s.name AS section
      FROM fin_kpis f JOIN fin_kpi_sections s ON s.id = f.section_id WHERE f.id = $1`, [id]);
  const k = r.rows[0];
  if (!k) throw new FinError(404, "Показник не знайдено");
  const v = await db.query(`SELECT period_start::text AS p, value::text AS value, note, ref_value::text AS ref FROM fin_kpi_values
     WHERE kpi_id = $1 AND period_kind = $2 ORDER BY period_start DESC LIMIT 12`, [id, kind]);
  const lg = await db.query(`SELECT l.at, l.period_kind, l.period_start::text AS p, l.what, ${ACTOR} AS actor FROM fin_kpi_log l
      LEFT JOIN users u ON u.id = l.actor_id WHERE l.target = 'kpi' AND l.target_id = $1 ORDER BY l.at DESC, l.id DESC LIMIT 50`, [id]);
  return {
    id: k.id, name: k.name, unit: k.unit, kind: k.kind, refSource: k.ref_source, offFrom: k.off_from, deleted: k.deleted_at != null, section: k.section,
    periods: v.rows.map((x: any) => ({ start: x.p, value: num(x.value), note: x.note ?? null, ref: num(x.ref) })),
    log: lg.rows.map((x: any) => ({ at: x.at, what: x.what, actor: x.actor ?? null })),
  };
}

// ── Значення, нотатки, закриття ───────────────────────────────────────────────

async function assertOpen(db: Db, kind: PeriodKind, start: string) {
  const c = await db.query(`SELECT 1 FROM fin_kpi_closes WHERE period_kind = $1 AND period_start = $2::date`, [kind, start]);
  if (c.rows.length) throw new FinError(409, `Період ${pLabel(kind, start)} закрито — спершу відкрийте його`);
}

/**
 * Зберегти значення ручних показників за період. Усе або нічого; обчислюваний показник — 400; вимкнений
 * у цьому періоді — 409; закритий період — 409. Довідка CRM/1С (якщо є) запамʼятовується поруч.
 */
export async function saveKpiValues(db: Db, actor: number, kindArg: unknown, dateArg: unknown, cells: unknown, refs: RefValues = {}) {
  const { kind, start } = periodStart(kindArg, dateArg);
  if (!Array.isArray(cells) || !cells.length) throw new FinError(400, "Немає змін");
  if (cells.length > 500) throw new FinError(400, "Забагато клітинок за раз");
  const parsed: { kpiId: number; value: number | null }[] = [];
  const bad: number[] = [];
  const seen = new Set<number>();
  for (const c of cells as any[]) {
    const kpiId = Number(c?.kpiId);
    if (!Number.isInteger(kpiId) || kpiId <= 0) throw new FinError(400, "Некоректна клітинка");
    if (seen.has(kpiId)) throw new FinError(400, "Один показник двічі в одному збереженні");
    seen.add(kpiId);
    try { parsed.push({ kpiId, value: parseAmount(c.value) }); } catch { bad.push(kpiId); }
  }
  if (bad.length) throw new FinError(400, `У клітинках (${bad.length}) не число — нічого не збережено`, { bad });
  await assertOpen(db, kind, start);
  const ids = parsed.map((c) => c.kpiId);
  const k = await db.query(`SELECT id, name, kind, ref_source, off_from::text AS off_from, deleted_at FROM fin_kpis WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
  const kpis = new Map(k.rows.map((x: any) => [x.id, x]));
  for (const id of ids) {
    const x: any = kpis.get(id);
    if (!x || x.deleted_at) throw new FinError(404, "Показник не знайдено — нічого не збережено");
    if (isAutoIn(x, kind, start, refs)) throw new FinError(400, `«${x.name}» рахується сам${isOpexRef(x.ref_source) ? " зі статей «План/факт»" : String(x.ref_source).startsWith("bank_") ? " з «Виписки»" : " за фільтрами Kommo"} — його не вносять`);
    if (x.kind !== "manual" && x.kind !== "auto") throw new FinError(400, `«${x.name}» рахується сам — його не вносять`);
    if (!isActiveIn(x.off_from, start)) throw new FinError(409, `Показник «${x.name}» вимкнений у цьому періоді — нічого не збережено`);
  }
  const cur = await db.query(`SELECT kpi_id, value::text AS value FROM fin_kpi_values WHERE period_kind = $1 AND period_start = $2::date AND kpi_id = ANY($3::int[]) FOR UPDATE`, [kind, start, ids]);
  const old = new Map(cur.rows.map((x: any) => [x.kpi_id, num(x.value)]));
  let changed = 0;
  for (const c of parsed) {
    const was = old.get(c.kpiId) ?? null;
    if (was === c.value) continue;
    const x: any = kpis.get(c.kpiId);
    const ref = x.ref_source && x.ref_source in refs ? refs[x.ref_source as RefSource] ?? null : null;
    await db.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value, ref_value, ref_at, updated_by, updated_at)
      VALUES ($1, $2, $3::date, $4, $5, CASE WHEN $5::numeric IS NULL THEN NULL ELSE now() END, $6, now())
      ON CONFLICT (kpi_id, period_kind, period_start) DO UPDATE SET value = EXCLUDED.value,
        ref_value = COALESCE(EXCLUDED.ref_value, fin_kpi_values.ref_value), ref_at = COALESCE(EXCLUDED.ref_at, fin_kpi_values.ref_at),
        updated_by = EXCLUDED.updated_by, updated_at = now()`, [c.kpiId, kind, start, c.value, ref, actor]);
    await log(db, actor, "kpi", c.kpiId, `${x.name} · ${pLabel(kind, start)}: ${fmt(was)} → ${fmt(c.value)}`, { kind, start, field: "value", old: was, new: c.value });
    changed++;
  }
  return { changed };
}

export async function setKpiNote(db: Db, actor: number, kpiId: number, kindArg: unknown, dateArg: unknown, textArg: unknown) {
  const { kind, start } = periodStart(kindArg, dateArg);
  await assertOpen(db, kind, start);
  const k = await db.query(`SELECT name, deleted_at FROM fin_kpis WHERE id = $1`, [kpiId]);
  if (!k.rows[0] || k.rows[0].deleted_at) throw new FinError(404, "Показник не знайдено");
  const text = typeof textArg === "string" ? textArg.trim().slice(0, 2000) : "";
  const cur = await db.query(`SELECT note FROM fin_kpi_values WHERE kpi_id = $1 AND period_kind = $2 AND period_start = $3::date`, [kpiId, kind, start]);
  const was = cur.rows[0]?.note ?? null, next = text || null;
  if (was === next) return;
  await db.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, note, updated_by, updated_at) VALUES ($1, $2, $3::date, $4, $5, now())
    ON CONFLICT (kpi_id, period_kind, period_start) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [kpiId, kind, start, next, actor]);
  await log(db, actor, "kpi", kpiId, next ? `Нотатка ${pLabel(kind, start)}: «${next.slice(0, 120)}»` : `Нотатку ${pLabel(kind, start)} прибрано`, { kind, start, field: "note" });
}

/** Закрити / відкрити період. Обидві дії — в історії; повторне закриття чи відкриття відкритого — 409. */
/**
 * Закрити / відкрити період. Закриття ФІКСУЄ авто-рядки, що рахуються в цьому періоді, числом на цей момент (`refs`):
 * закритий період незмінний, а «План/факт» і далі правлять. Відкриття знімає фіксацію лише з операційних витрат —
 * вони знову йдуть за «План/факт»; рядки з Kommo лишаються зафіксованими (CRM змінюється заднім числом, #977).
 */
export async function setPeriodClosed(db: Db, actor: number, kindArg: unknown, dateArg: unknown, closed: boolean, refs: RefValues = {}) {
  const { kind, start } = periodStart(kindArg, dateArg);
  if (closed) {
    const r = await db.query(`INSERT INTO fin_kpi_closes (period_kind, period_start, closed_by) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING RETURNING 1`, [kind, start, actor]);
    if (!r.rows.length) throw new FinError(409, "Період уже закрито");
    await log(db, actor, "period", null, `Закрито ${kind === "week" ? "тиждень" : "місяць"} ${pLabel(kind, start)}`, { kind, start });
    const k = await db.query(`SELECT f.id, f.name, f.kind, f.ref_source, f.off_from::text AS off_from, v.frozen_at
        FROM fin_kpis f LEFT JOIN fin_kpi_values v ON v.kpi_id = f.id AND v.period_kind = $1 AND v.period_start = $2::date
       WHERE f.kind = 'auto' AND f.deleted_at IS NULL`, [kind, start]);
    for (const x of k.rows as any[]) {
      // Немає числа для періоду (дебіторка минулого тижня) — не фіксуємо порожнечу поверх збереженого.
      if (x.frozen_at || !isActiveIn(x.off_from, start) || !isAutoIn(x, kind, start, refs) || !(x.ref_source in refs)) continue;
      const v = refs[x.ref_source as RefSource] ?? null;
      await db.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value, frozen_at, updated_by, updated_at) VALUES ($1, $2, $3::date, $4, now(), $5, now())
        ON CONFLICT (kpi_id, period_kind, period_start) DO UPDATE SET value = EXCLUDED.value, frozen_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [x.id, kind, start, v, actor]);
      await log(db, actor, "kpi", x.id, `${x.name} · ${pLabel(kind, start)}: зафіксовано при закритті ${fmt(v)}`, { kind, start, field: "value", new: v });
    }
  } else {
    const r = await db.query(`DELETE FROM fin_kpi_closes WHERE period_kind = $1 AND period_start = $2::date RETURNING 1`, [kind, start]);
    if (!r.rows.length) throw new FinError(409, "Період і так відкритий");
    await log(db, actor, "period", null, `Відкрито ${kind === "week" ? "тиждень" : "місяць"} ${pLabel(kind, start)}`, { kind, start });
    await db.query(`UPDATE fin_kpi_values v SET frozen_at = NULL FROM fin_kpis f
       WHERE f.id = v.kpi_id AND f.kind = 'auto' AND (f.ref_source LIKE 'opex\\_%' OR f.ref_source LIKE 'bank\\_%') AND v.period_kind = $1 AND v.period_start = $2::date AND v.frozen_at IS NOT NULL`, [kind, start]);
  }
}

// ── Структура: розділи й показники ────────────────────────────────────────────

async function liveRow(db: Db, table: "fin_kpi_sections" | "fin_kpis", id: number, what: string) {
  const r = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rows[0] || r.rows[0].deleted_at) throw new FinError(404, `${what} не знайдено`);
  return r.rows[0];
}

export async function createSection(db: Db, actor: number, body: any): Promise<number> {
  const name = cleanName(body?.name, "розділу");
  const r = await uniqueName(db.query(`INSERT INTO fin_kpi_sections (name, sort, created_by)
    VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM fin_kpi_sections), 0), $2) RETURNING id`, [name, actor]));
  await log(db, actor, "section", r.rows[0].id, `Додано розділ «${name}»`);
  return r.rows[0].id;
}
export async function renameSection(db: Db, actor: number, id: number, body: any) {
  const row = await liveRow(db, "fin_kpi_sections", id, "Розділ");
  const name = cleanName(body?.name, "розділу");
  if (name === row.name) return;
  await uniqueName(db.query(`UPDATE fin_kpi_sections SET name = $2 WHERE id = $1`, [id, name]));
  await log(db, actor, "section", id, `Перейменовано: «${row.name}» → «${name}»`);
}
/** Розділ із показниками не видаляємо — показники спершу переносять або видаляють. */
export async function deleteSection(db: Db, actor: number, id: number) {
  const row = await liveRow(db, "fin_kpi_sections", id, "Розділ");
  const c = await db.query(`SELECT count(*)::int AS n FROM fin_kpis WHERE section_id = $1 AND deleted_at IS NULL`, [id]);
  if (c.rows[0].n > 0) throw new FinError(409, `У розділі «${row.name}» є показників: ${c.rows[0].n}. Спершу перенесіть або видаліть їх.`, { kpis: c.rows[0].n });
  await db.query(`UPDATE fin_kpi_sections SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actor]);
  await log(db, actor, "section", id, `Видалено розділ «${row.name}»`);
}

export async function createKpi(db: Db, actor: number, body: any): Promise<number> {
  const sectionId = idArg(body?.sectionId, "розділ");
  await liveRow(db, "fin_kpi_sections", sectionId, "Розділ");
  const name = cleanName(body?.name, "показника");
  const unit = body?.unit ?? "UAH";
  if (!["UAH", "USD", "EUR"].includes(unit)) throw new FinError(400, "Валюта — UAH, USD або EUR");
  const kind = body?.kind ?? "manual";
  if (!["manual", "sum", "diff"].includes(kind)) throw new FinError(400, "Тип — вручну, сума розділу або різниця");
  let argA: number | null = null, argB: number | null = null;
  if (kind === "diff") {
    argA = idArg(body?.argA, "показник «від»"); argB = idArg(body?.argB, "показник «мінус»");
    if (argA === argB) throw new FinError(400, "Різниця двох однакових показників");
    for (const a of [argA, argB]) await liveRow(db, "fin_kpis", a, "Показник для різниці");
  }
  const r = await uniqueName(db.query(`INSERT INTO fin_kpis (section_id, name, unit, kind, arg_a, arg_b, sort, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT max(sort) + 1 FROM fin_kpis WHERE section_id = $1), 0), $7) RETURNING id`,
  [sectionId, name, unit, kind, argA, argB, actor]));
  await log(db, actor, "kpi", r.rows[0].id, `Додано показник «${name}»`);
  return r.rows[0].id;
}
export async function updateKpi(db: Db, actor: number, id: number, body: any) {
  const row = await liveRow(db, "fin_kpis", id, "Показник");
  if (body?.name !== undefined) {
    const name = cleanName(body.name, "показника");
    if (name !== row.name) {
      await uniqueName(db.query(`UPDATE fin_kpis SET name = $2 WHERE id = $1`, [id, name]));
      await log(db, actor, "kpi", id, `Перейменовано: «${row.name}» → «${name}»`);
    }
  }
  if (body?.sectionId !== undefined) {
    const sectionId = idArg(body.sectionId, "розділ");
    if (sectionId !== row.section_id) {
      const to = await liveRow(db, "fin_kpi_sections", sectionId, "Розділ");
      await uniqueName(db.query(`UPDATE fin_kpis SET section_id = $2, sort = COALESCE((SELECT max(sort) + 1 FROM fin_kpis WHERE section_id = $2), 0) WHERE id = $1`, [id, sectionId]));
      await log(db, actor, "kpi", id, `Перенесено до розділу «${to.name}»`);
    }
  }
}
/** Вимкнути з періоду ПІСЛЯ останнього значення (не раніше поточного тижня) — минулі періоди не рухаються. */
export async function setKpiOff(db: Db, actor: number, id: number, off: boolean, now: Date = new Date()) {
  const row = await liveRow(db, "fin_kpis", id, "Показник");
  if (!off) {
    if (row.off_from == null) return { offFrom: null };
    await db.query(`UPDATE fin_kpis SET off_from = NULL WHERE id = $1`, [id]);
    await log(db, actor, "kpi", id, "Показник увімкнено");
    return { offFrom: null };
  }
  const last = await db.query(`SELECT max(CASE period_kind WHEN 'week' THEN period_start + 7 ELSE (period_start + interval '1 month')::date END)::text AS m
      FROM fin_kpi_values WHERE kpi_id = $1 AND value IS NOT NULL`, [id]);
  const cur = currentPeriod("week", now);
  const after = last.rows[0].m ?? cur;
  const from = after > cur ? after : cur;
  await db.query(`UPDATE fin_kpis SET off_from = $2 WHERE id = $1`, [id, from]);
  await log(db, actor, "kpi", id, `Показник вимкнено з ${from.slice(8, 10)}.${from.slice(5, 7)}.${from.slice(0, 4)} — минулі періоди не змінились`);
  return { offFrom: from };
}
/** Показник зі значеннями — лише з `confirm`; показник, на який спирається «різниця», — 409. */
export async function deleteKpi(db: Db, actor: number, id: number, confirm: boolean) {
  const row = await liveRow(db, "fin_kpis", id, "Показник");
  const dep = await db.query(`SELECT name FROM fin_kpis WHERE deleted_at IS NULL AND (arg_a = $1 OR arg_b = $1)`, [id]);
  if (dep.rows.length) throw new FinError(409, `На цей показник спирається «${dep.rows[0].name}» — спершу видаліть або змініть його`);
  const c = await db.query(`SELECT count(*)::int AS n FROM fin_kpi_values WHERE kpi_id = $1 AND value IS NOT NULL`, [id]);
  const periods = c.rows[0].n;
  if (periods > 0 && !confirm) throw new FinError(409, `У показника є значення за ${periods} періодів. Краще вимкнути.`, { periods });
  await db.query(`UPDATE fin_kpis SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actor]);
  await log(db, actor, "kpi", id, `Видалено показник «${row.name}»${periods ? ` (значень: ${periods})` : ""}`);
}
export async function restoreKpiThing(db: Db, actor: number, targetArg: unknown, id: number) {
  const target = targetArg === "section" || targetArg === "kpi" ? targetArg : null;
  if (!target) throw new FinError(400, "Невідомий тип");
  const table = target === "section" ? "fin_kpi_sections" : "fin_kpis";
  const r = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const row = r.rows[0];
  if (!row) throw new FinError(404, "Не знайдено");
  if (!row.deleted_at) throw new FinError(409, "Уже на місці");
  if (target === "kpi") {
    const p = await db.query(`SELECT deleted_at FROM fin_kpi_sections WHERE id = $1`, [row.section_id]);
    if (p.rows[0]?.deleted_at) throw new FinError(409, "Спершу поверніть розділ цього показника");
  }
  await uniqueName(db.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]));
  await log(db, actor, target, id, `Повернуто «${row.name}»`);
}

// ── Разове перенесення аркуша «ФМ» ────────────────────────────────────────────

/** Рядки аркуша (номер рядка CSV-вивантаження) → показник. `w` — рядок тижневої секції, `m` — місячної. */
export const FM_LAYOUT: { section: string; kpis: { key: string; name: string; kind: "manual" | "sum" | "diff" | "auto"; w?: number; m?: number; ref?: RefSource; diff?: [string, string] }[] }[] = [
  { section: "Гроші", kpis: [
    { key: "in", name: "Надходження загальні", kind: "auto", w: 3, m: 21, ref: "bank_in" },
    { key: "out", name: "Витрати загальні", kind: "auto", w: 4, m: 22, ref: "bank_out" },
  ] },
  { section: "Поставлені авто (за датою загрузки)", kpis: [
    { key: "d_inc", name: "Дохід", kind: "auto", w: 5, m: 23, ref: "delivered_income" },
    { key: "d_exp", name: "Витрати", kind: "auto", w: 6, m: 24, ref: "delivered_expense" },
    { key: "d_com", name: "Комісійні", kind: "diff", w: 7, m: 25, diff: ["d_inc", "d_exp"] },
  ] },
  { section: "По даті вигрузки (дата акту)", kpis: [
    { key: "a_inc", name: "Дохід", kind: "auto", w: 8, m: 26, ref: "unloaded_income" },
    { key: "a_exp", name: "Витрати", kind: "auto", w: 9, m: 27, ref: "unloaded_expense" },
    { key: "a_com", name: "Комісійні", kind: "diff", w: 10, m: 28, diff: ["a_inc", "a_exp"] },
  ] },
  { section: "Операційні витрати", kpis: [
    { key: "op", name: "Разом", kind: "sum", w: 11, m: 29 },
    { key: "op_com", name: "Комерційні витрати", kind: "auto", w: 13, m: 31, ref: "opex_commercial" },
    { key: "op_gen", name: "Загальні витрати", kind: "auto", w: 14, m: 32, ref: "opex_general" },
    { key: "op_adm", name: "Адміністративні витрати", kind: "auto", w: 15, m: 33, ref: "opex_admin" },
    { key: "op_pay", name: "ЗП + Податки на ЗП", kind: "auto", ref: "opex_payroll" },
  ] },
  { section: "Залишки на дату", kpis: [
    { key: "deb", name: "Дебіторка 1С", kind: "auto", w: 16, m: 34, ref: "receivables" },
    { key: "tender", name: "Тендерна дебіторка", kind: "manual", w: 17, m: 35 },
    { key: "val", name: "Валютна дебіторка", kind: "auto", m: 36, ref: "receivables_fx" },
  ] },
];

export interface FmBlock { b: number; label: string; rows: Record<string, [string, string, string]> }
export interface FmFile { blocks: FmBlock[] }

/** «28.09-04.10.2026» → понеділок. Рік у підписі — рік КІНЦЯ; «29.12-04.01.2025» (помилка року у файлі) дає 2025-12-29. */
export function blockMonday(label: string): string {
  const m = /^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$/.exec(label.trim());
  if (!m) throw new FinError(400, `Не розпізнано тиждень «${label}»`);
  let endYear = Number(m[5]);
  // Перехід року: кінець у січні, початок у грудні — рік кінця мусить бути більшим за рік початку.
  if (m[2] === "12" && m[4] === "01" && Number(m[3]) < Number(m[1])) {
    const asWritten = `${endYear}-01-${m[3]}`;
    if (s2d(asWritten).getUTCDay() !== 0) endYear += 1; // кінець тижня — неділя; інакше рік у підписі хибний
  }
  const end = `${endYear}-${m[4]}-${m[3]}`;
  return addDays(end, -6);
}

/**
 * План перенесення (чиста функція, #946): для кожного тижня — ФІНАЛЬНЕ значення з колонки «минулого тижня»
 * наступного блоку, інакше проміжне з власного блоку (тиждень потрапляє в `interim`). Місяць блоку — місяць
 * його понеділка (так у файлі: блок 28.09–04.10 несе вересень поточним, серпень — минулим); фінал місяця —
 * «минулий місяць» найпізнішого блоку, інакше «поточний» найпізнішого блоку цього місяця.
 * Обчислювані рядки не переносяться, а звіряються: розбіжність файлу йде у `mismatches`, а не мовчки.
 */
export function planFmImport(file: FmFile, fromMonday: string) {
  const blocks = file.blocks.map((b) => ({ ...b, monday: blockMonday(b.label) })).sort((a, b) => (a.monday < b.monday ? 1 : -1));
  const val = (b: FmBlock, row: number | undefined, col: 0 | 2) => (row == null ? null : parseAmount((b.rows[String(row)]?.[col] ?? "").trim() || null));
  const flat = FM_LAYOUT.flatMap((s) => s.kpis);
  type Rec = Record<string, number | null>;
  const weeks = new Map<string, { values: Rec; final: boolean }>();
  for (const b of blocks) {
    const prevMonday = addDays(b.monday, -7);
    const fin: Rec = {}; for (const k of flat) fin[k.key] = val(b, k.w, 0);
    if (Object.values(fin).some((v) => v != null)) weeks.set(prevMonday, { values: fin, final: true });
  }
  for (const b of blocks) {
    if (weeks.get(b.monday)?.final) continue;
    const g: Rec = {}; for (const k of flat) g[k.key] = val(b, k.w, 2);
    if (Object.values(g).some((v) => v != null)) weeks.set(b.monday, { values: g, final: false });
  }
  // Місяць блоку визначаємо ДАНИМИ, а не календарем: Тетяна перемикає місяць, коли починає новий блок, — блок
  // 31.08–06.09 уже несе вересень, а 29.06–05.07 ще червень. Блоки поспіль з однаковим «минулим місяцем» — одна
  // група; її поточний місяць — той, де більшість днів її тижнів. Групи мусять іти місяць за місяцем — інакше
  // це розбіжність файлу (`mismatches`), а не здогад.
  const groups: { blocks: typeof blocks; month: string }[] = [];
  // Ознака групи — «Надходження загальні» минулого місяця (рядок 21): дрібна виправка в іншому рядку не розриває групу.
  const sig = (b: FmBlock) => (b.rows["21"]?.[0] ?? "").trim() || FM_LAYOUT.flatMap((x) => x.kpis).map((k) => (k.m != null ? (b.rows[String(k.m)]?.[0] ?? "") : "")).join("|");
  for (const b of blocks) {
    const g = groups[groups.length - 1];
    if (g && sig(g.blocks[0]) === sig(b)) g.blocks.push(b); else groups.push({ blocks: [b], month: "" });
  }
  // Найсвіжішій групі — місяць більшості днів її тижнів; кожній старшій — на місяць раніше (так перемикає Тетяна:
  // блок 29.12–04.01 — ще грудень, хоча більшість днів у січні). Відхід від календаря більше ніж на місяць — розбіжність.
  const majority = (g: { blocks: typeof blocks }) => {
    const days = new Map<string, number>();
    for (const b of g.blocks) for (let i = 0; i < 7; i++) { const m = monthStart(addDays(b.monday, i)); days.set(m, (days.get(m) ?? 0) + 1); }
    return [...days].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1))[0][0];
  };
  const calendarIssues: string[] = [];
  groups.forEach((g, i) => {
    g.month = i === 0 ? majority(g) : shiftPeriod("month", groups[i - 1].month, -1);
    const m = majority(g);
    if (m !== g.month && m !== shiftPeriod("month", g.month, 1) && m !== shiftPeriod("month", g.month, -1))
      calendarIssues.push(`блоки ${g.blocks.map((b) => b.label).join(", ")}: за порядком ${g.month.slice(0, 7)}, за календарем ${m.slice(0, 7)}`);
  });
  const months = new Map<string, { values: Rec; final: boolean; notes: Record<string, string> }>();
  const groupIssues: string[] = calendarIssues;
  groups.forEach((g, i) => {
    const latest = g.blocks[0];
    const prev = shiftPeriod("month", g.month, -1);
    if (!months.has(prev)) {
      const e: Rec = {}; for (const k of flat) e[k.key] = val(latest, k.m, 0);
      const notes: Record<string, string> = {};
      for (const k of flat) { const n = (latest.rows[String(k.m)]?.[1] ?? "").trim(); if (k.m != null && n) notes[k.key] = n; }
      if (Object.values(e).some((v) => v != null)) months.set(prev, { values: e, final: true, notes });
    }
    if (!months.has(g.month)) {
      const withG = g.blocks.find((b) => flat.some((k) => k.m != null && (b.rows[String(k.m)]?.[2] ?? "").trim()));
      if (withG) { const gv: Rec = {}; for (const k of flat) gv[k.key] = val(withG, k.m, 2); months.set(g.month, { values: gv, final: false, notes: {} }); }
    }
  });
  const mismatches: string[] = [...groupIssues];
  const check = (what: string, rec: Rec) => {
    for (const k of flat) {
      if (isInput(k.kind)) continue;
      const file = rec[k.key];
      if (file == null) continue;
      let calc: number | null = null;
      if (k.kind === "diff") { const a = rec[k.diff![0]], b2 = rec[k.diff![1]]; calc = a != null && b2 != null ? (cents(a) - cents(b2)) / 100 : null; }
      else { const parts = flat.filter((x) => isInput(x.kind) && FM_LAYOUT.find((s) => s.kpis.includes(x))!.section === FM_LAYOUT.find((s) => s.kpis.includes(k))!.section).map((x) => rec[x.key]).filter((v): v is number => v != null); calc = parts.length ? parts.reduce((a, v) => a + cents(v), 0) / 100 : null; }
      if (calc == null || Math.abs(cents(calc) - cents(file)) >= 1) mismatches.push(`${what} · ${k.name}: у файлі ${file}, з рядків ${calc ?? "—"}`);
    }
  };
  const wOut = [...weeks].filter(([m]) => m >= fromMonday).sort(([a], [b]) => (a < b ? -1 : 1));
  const mOut = [...months].filter(([m]) => m >= monthStart(fromMonday) || m >= fromMonday).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [m, w] of wOut) check(`тиждень ${m}`, w.values);
  for (const [m, x] of mOut) check(`місяць ${m.slice(0, 7)}`, x.values);
  return { weeks: wOut, months: mOut, mismatches };
}

/** Записати перенесення: структура з `FM_LAYOUT`, значення ручних показників, закриття фінальних періодів. Повтор — 409. */
export async function importFm(db: Db, actor: number | null, file: FmFile, fromMonday: string, now: Date = new Date()) {
  const done = await db.query(`SELECT 1 FROM fin_kpi_imports WHERE key = 'fm-2026'`);
  const busy = await db.query(`SELECT count(*)::int AS n FROM fin_kpi_sections`);
  if (done.rows.length || busy.rows[0].n > 0) throw new FinError(409, "«Тиждень і місяць» уже не порожні — повторне перенесення заборонене");
  const plan = planFmImport(file, fromMonday);
  const ids = new Map<string, number>();
  for (const s of FM_LAYOUT) {
    const sid = (await db.query(`INSERT INTO fin_kpi_sections (name, sort, created_by) VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM fin_kpi_sections), 0), $2) RETURNING id`, [s.section, actor])).rows[0].id;
    for (const k of s.kpis.filter((x) => x.kind !== "diff")) {
      const id = (await db.query(`INSERT INTO fin_kpis (section_id, name, kind, ref_source, sort, created_by)
        VALUES ($1, $2, $3, $4, COALESCE((SELECT max(sort) + 1 FROM fin_kpis WHERE section_id = $1), 0), $5) RETURNING id`, [sid, k.name, k.kind, k.ref ?? null, actor])).rows[0].id;
      ids.set(k.key, id);
    }
    for (const k of s.kpis.filter((x) => x.kind === "diff")) {
      const id = (await db.query(`INSERT INTO fin_kpis (section_id, name, kind, arg_a, arg_b, sort, created_by)
        VALUES ($1, $2, 'diff', $3, $4, COALESCE((SELECT max(sort) + 1 FROM fin_kpis WHERE section_id = $1), 0), $5) RETURNING id`, [sid, k.name, ids.get(k.diff![0]), ids.get(k.diff![1]), actor])).rows[0].id;
      ids.set(k.key, id);
    }
  }
  const manual = FM_LAYOUT.flatMap((s) => s.kpis).filter((k) => isInput(k.kind));
  let values = 0;
  const write = async (kind: PeriodKind, start: string, rec: Record<string, number | null>, notes: Record<string, string> = {}) => {
    for (const k of manual) {
      const v = rec[k.key] ?? null, n = notes[k.key] ?? null;
      if (v == null && !n) continue;
      await db.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value, note, updated_by) VALUES ($1, $2, $3::date, $4, $5, $6)`,
        [ids.get(k.key), kind, start, v, n, actor]);
      values++;
    }
  };
  const curW = currentPeriod("week", now), curM = currentPeriod("month", now);
  const interim: { week: string[]; month: string[] } = { week: [], month: [] };
  for (const [start, w] of plan.weeks) {
    await write("week", start, w.values);
    if (w.final && start < curW) await db.query(`INSERT INTO fin_kpi_closes (period_kind, period_start, closed_by, note) VALUES ('week', $1::date, $2, 'перенесено з «ФМ»')`, [start, actor]);
    if (!w.final) interim.week.push(start);
  }
  for (const [start, m] of plan.months) {
    await write("month", start, m.values, m.notes);
    if (m.final && start < curM) await db.query(`INSERT INTO fin_kpi_closes (period_kind, period_start, closed_by, note) VALUES ('month', $1::date, $2, 'перенесено з «ФМ»')`, [start, actor]);
    if (!m.final) interim.month.push(start);
  }
  await db.query(`INSERT INTO fin_kpi_imports (key, detail) VALUES ('fm-2026', $1::jsonb)`, [JSON.stringify({ interim, mismatches: plan.mismatches, weeks: plan.weeks.length, months: plan.months.length })]);
  return { weeks: plan.weeks.length, months: plan.months.length, values, interim, mismatches: plan.mismatches };
}

// ── Фіксація автоматичних рядків (прохід 2б) ─────────────────────────────────

/**
 * Зафіксувати автоматичні показники періоду: число ядра на цей момент лягає в базу з `frozen_at`. Ідемпотентно:
 * закритий період і вже зафіксоване не чіпає; `refs` без ключа (напр. дебіторка, коли знімок уже не того дня) —
 * показник лишається незафіксованим, а не отримує чуже число. Повертає, скільки зафіксовано.
 */
export async function freezeAutoKpis(db: Db, kindArg: unknown, dateArg: unknown, refs: RefValues): Promise<{ frozen: number; skipped: string | null }> {
  const { kind, start } = periodStart(kindArg, dateArg);
  if (!autoActive(kind, start)) return { frozen: 0, skipped: "до старту автоматики — число з таблиці" };
  const cl = await db.query(`SELECT 1 FROM fin_kpi_closes WHERE period_kind = $1 AND period_start = $2::date`, [kind, start]);
  if (cl.rows.length) return { frozen: 0, skipped: "період закрито" };
  const k = await db.query(`SELECT f.id, f.name, f.ref_source, f.off_from::text AS off_from, v.frozen_at, v.value::text AS value
      FROM fin_kpis f LEFT JOIN fin_kpi_values v ON v.kpi_id = f.id AND v.period_kind = $1 AND v.period_start = $2::date
     WHERE f.kind = 'auto' AND f.deleted_at IS NULL`, [kind, start]);
  let frozen = 0;
  for (const x of k.rows as any[]) {
    // Операційні витрати вночі не фіксуються: факт у «План/факт» вносять ПІСЛЯ кінця місяця. Їх фіксує закриття місяця.
    if (x.frozen_at || isCloseOnlyRef(x.ref_source) || !isActiveIn(x.off_from, start) || !(x.ref_source in refs)) continue;
    const v = refs[x.ref_source as RefSource] ?? null;
    if (v == null) continue;
    await db.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value, frozen_at, updated_at) VALUES ($1, $2, $3::date, $4, now(), now())
      ON CONFLICT (kpi_id, period_kind, period_start) DO UPDATE SET value = EXCLUDED.value, frozen_at = now(), updated_at = now()`, [x.id, kind, start, v]);
    await log(db, null, "kpi", x.id, `${x.name} · ${pLabel(kind, start)}: зафіксовано автоматично ${fmt(v)}${x.value != null ? ` (було ${fmt(num(x.value))})` : ""}`,
      { kind, start, field: "value", old: num(x.value), new: v });
    frozen++;
  }
  return { frozen, skipped: null };
}

// ── Дотягування окремих періодів із «ФМ» (прохід 2б, 01.10.2026) ───────────────

/**
 * «Бекфіл по таблиці»: ФІНАЛЬНІ числа названих періодів з аркуша «ФМ» лягають у базу, період закривається
 * («перенесено з «ФМ»»), як при разовому перенесенні. Лише періоди ДО старту автоматики і лише незакриті —
 * закрите незмінне, а після старту число рахує CRM. Проміжне (ще не фінальне у файлі) — відмова, а не здогад.
 * Усе або нічого; що змінилось — у журнал з «було → стало».
 */
export async function importFmPeriods(db: Db, actor: number | null, file: FmFile, targets: { kind: PeriodKind; start: string }[]) {
  if (!targets.length) throw new FinError(400, "Не названо жодного періоду");
  const plan = planFmImport(file, "2000-01-03");
  const src = { week: new Map(plan.weeks), month: new Map(plan.months) };
  const flat = FM_LAYOUT.flatMap((sec) => sec.kpis.map((k) => ({ ...k, section: sec.section }))).filter((k) => isInput(k.kind));
  const ids = new Map<string, number>();
  for (const k of flat) {
    const r = await db.query(`SELECT f.id FROM fin_kpis f JOIN fin_kpi_sections s ON s.id = f.section_id
       WHERE s.name = $1 AND f.name = $2 AND f.deleted_at IS NULL AND s.deleted_at IS NULL`, [k.section, k.name]);
    if (r.rows.length !== 1) throw new FinError(409, `Рядок «${k.section} · ${k.name}» не знайдено однозначно — нічого не записано`);
    ids.set(k.key, r.rows[0].id);
  }
  // Спершу перевірити ВСІ періоди, потім писати: погана назва в кінці списку не лишає першого записаним.
  const ready: { kind: PeriodKind; start: string; p: { values: Record<string, number | null>; final: boolean } }[] = [];
  for (const t of targets) {
    const { kind, start } = periodStart(t.kind, t.start);
    if (autoActive(kind, start)) throw new FinError(409, `${pLabel(kind, start)} — після старту автоматики, його рахує CRM`);
    await assertOpen(db, kind, start);
    const p = src[kind].get(start);
    if (!p) throw new FinError(409, `${pLabel(kind, start)}: у файлі немає чисел`);
    if (!p.final) throw new FinError(409, `${pLabel(kind, start)}: у файлі ще проміжне число — фінал з'явиться з наступним блоком`);
    ready.push({ kind, start, p });
  }
  const out: { kind: PeriodKind; start: string; changed: string[] }[] = [];
  for (const { kind, start, p } of ready) {
    const notes = (p as { notes?: Record<string, string> }).notes ?? {};
    const changed: string[] = [];
    for (const k of flat) {
      // Рядки з фільтрів Kommo в цьому періоді вже рахує CRM — число з таблиці їх не перекриває (звірено 05.10.2026).
      if (k.kind === "auto" && k.ref && isKommoRef(k.ref) && kommoActive(kind, start)) continue;
      const v = p.values[k.key] ?? null, n = notes[k.key] ?? null, id = ids.get(k.key)!;
      const cur = await db.query(`SELECT value::text AS value, note FROM fin_kpi_values WHERE kpi_id = $1 AND period_kind = $2 AND period_start = $3::date`, [id, kind, start]);
      const was = num(cur.rows[0]?.value);
      if (v == null && !n && was == null) continue; // порожня фінальна клітинка стирає проміжне: правда — файл
      await db.query(`INSERT INTO fin_kpi_values (kpi_id, period_kind, period_start, value, note, updated_by, updated_at) VALUES ($1, $2, $3::date, $4, $5, $6, now())
        ON CONFLICT (kpi_id, period_kind, period_start) DO UPDATE SET value = EXCLUDED.value, note = COALESCE(EXCLUDED.note, fin_kpi_values.note),
          updated_by = EXCLUDED.updated_by, updated_at = now()`, [id, kind, start, v, n, actor]);
      if (was !== v) {
        await log(db, actor, "kpi", id, `${k.name} · ${pLabel(kind, start)}: ${fmt(was)} → ${fmt(v)} (фінал з «ФМ»)`, { kind, start, field: "value", old: was, new: v });
        changed.push(`${k.section} · ${k.name}: ${fmt(was)} → ${fmt(v)}`);
      }
    }
    await db.query(`INSERT INTO fin_kpi_closes (period_kind, period_start, closed_by, note) VALUES ($1, $2::date, $3, 'перенесено з «ФМ»')`, [kind, start, actor]);
    await db.query(`UPDATE fin_kpi_imports SET detail = jsonb_set(detail, ARRAY['interim', $1::text],
        COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(detail->'interim'->$1::text) x WHERE x <> to_jsonb($2::text)), '[]'::jsonb))
      WHERE key = 'fm-2026' AND detail->'interim' ? $1::text`, [kind, start]);
    out.push({ kind, start, changed });
  }
  return out;
}

// ── Джерела проходу 2в: «План/факт» за розділами, валютна дебіторка з 1С ─────

/**
 * Операційні витрати МІСЯЦЯ за розділами статей «План/факт»: Σ факту невидалених статей, що діють у місяці.
 * Ключ розділу є лише тоді, коли в ньому є хоч одна стаття (інакше рядок лишається ручним, `isAutoIn`); статей є,
 * а фактів ще немає — `null` («не внесено», а не нуль). `unassigned` — друге число до предиката: статті БЕЗ розділу
 * з фактом цього місяця, щоб їхні гроші не зникали мовчки.
 */
export async function opexMonth(db: Db, month: string): Promise<{ refs: RefValues; unassigned: { items: number; fact: number } }> {
  const r = await db.query(`SELECT i.section, count(*)::int AS items, sum(v.fact)::text AS fact, count(v.fact)::int AS facts
      FROM fin_items i JOIN fin_groups g ON g.id = i.group_id AND g.deleted_at IS NULL
      JOIN fin_resps rr ON rr.id = g.resp_id AND rr.deleted_at IS NULL
      LEFT JOIN fin_values v ON v.item_id = i.id AND v.month = $1::date
     WHERE i.deleted_at IS NULL AND (i.off_from IS NULL OR $1::date < i.off_from)
     GROUP BY i.section`, [month]);
  const refs: RefValues = {};
  let unassigned = { items: 0, fact: 0 };
  for (const x of r.rows as any[]) {
    if (x.section == null) { unassigned = { items: x.facts, fact: Math.round(Number(x.fact ?? 0) * 100) / 100 }; continue; }
    refs[OPEX_REF[x.section as OpexSection]] = x.facts ? Math.round(Number(x.fact) * 100) / 100 : null;
  }
  return { refs, unassigned };
}

/**
 * Валютна дебіторка з 1С на КІНЕЦЬ періоду: останній підсумок синку не пізніше кінця останнього дня періоду (або
 * «зараз», якщо період ще йде). Підсумок старший за добу від цієї межі — немає числа (синк мовчав), а не старе число.
 */
export async function receivablesFxAt(db: Db, end: string, now: Date): Promise<{ uah: number; val: number; zeroUah: number; at: string;
  usd: number | null; eur: number | null; unknownVal: number | null } | null> {
  const r = await db.query(`WITH cut AS (SELECT LEAST($2::timestamptz, (($1::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')) AS t)
    SELECT total_uah::text AS uah, total_val::text AS val, zero_uah, synced_at, usd::text AS usd, eur::text AS eur, unknown_val::text AS unk
      FROM receivables_fx_totals, cut
     WHERE synced_at <= cut.t AND synced_at > cut.t - interval '1 day' ORDER BY synced_at DESC LIMIT 1`, [end, now.toISOString()]);
  const x = r.rows[0];
  // usd / eur / unknownVal — null у підсумках ДО проходу 2г (тоді валюту ще не визначали), а не нуль.
  return x ? { uah: Number(x.uah), val: Number(x.val), zeroUah: x.zero_uah, at: new Date(x.synced_at).toISOString(),
    usd: num(x.usd), eur: num(x.eur), unknownVal: num(x.unk) } : null;
}

/**
 * «Надходження / Витрати загальні» з «Виписки» за період (прохід 2г, 05.10.2026): усі АКТИВНІ рахунки, разом із
 * рахунками «лише фінанси» (картки, Сейф), без видалених ручних записів; дати — за Києвом, обидва кінці. Витрати —
 * без банківських комісій (так само, як кешфлоу). Перекази між НАШИМИ рахунками — окремим числом (`ownIn`/`ownOut`):
 * чи виключати їх, ВІДКРИТЕ ПИТАННЯ до Тетяни (рішення Романа 05.10.2026 «залиш відкрите»), тож рахуємо все й
 * показуємо, скільки з цього — свої. «Свій» = IBAN контрагента збігається з IBAN нашого рахунку.
 */
export async function bankTotals(db: Db, from: string, to: string): Promise<{ in: number; out: number; ownIn: number; ownOut: number; rows: number }> {
  const r = await db.query(`SELECT
      COALESCE(sum(abs(t.amount_uah)) FILTER (WHERE t.direction = 'in'), 0)::text AS inc,
      COALESCE(sum(abs(t.amount_uah)) FILTER (WHERE t.direction = 'out' AND NOT COALESCE(t.is_bank_fee, false)), 0)::text AS outg,
      COALESCE(sum(abs(t.amount_uah)) FILTER (WHERE t.direction = 'in' AND own.iban IS NOT NULL), 0)::text AS own_in,
      COALESCE(sum(abs(t.amount_uah)) FILTER (WHERE t.direction = 'out' AND NOT COALESCE(t.is_bank_fee, false) AND own.iban IS NOT NULL), 0)::text AS own_out,
      count(*)::int AS rows
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      LEFT JOIN LATERAL (SELECT b.iban FROM bank_accounts b WHERE b.iban IS NOT NULL AND b.iban = t.counterparty_iban LIMIT 1) own ON true
     WHERE a.is_active AND t.deleted_at IS NULL
       AND (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date`, [from, to]);
  const x = r.rows[0];
  const m = (v: string) => Math.round(Number(v) * 100) / 100;
  return { in: m(x.inc), out: m(x.outg), ownIn: m(x.own_in), ownOut: m(x.own_out), rows: x.rows };
}
