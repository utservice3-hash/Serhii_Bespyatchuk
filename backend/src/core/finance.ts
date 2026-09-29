/**
 * 💰 ФІНАНСИ, прохід 1 (29.09.2026): «План/факт витрат» і «Статті».
 *
 * Те, що фінансист вела в Excel-таблиці «Витрати План/Факт», вноситься тут: дерево
 * «відповідальний → група → стаття» і по кожній статті план, факт і коментар на місяць.
 * Макет затверджено 28.09.2026 (artifact TjMcb2LTWjpGjojH1sAMwv).
 *
 * Чотири правила, на яких стоїть розділ (кожне тримає гейт):
 *  1. **Підсумок — лише сума рядків** (#930). Своїх «підсумкових» чисел розділ не зберігає: в Excel
 *     підсумок лютого розійшовся з сумою статей на 100 000, і такого тут статись не може за побудовою.
 *     Порожня клітинка — «не внесено», а не нуль: план NULL і план 0 — різні стани.
 *  2. **Вимкнути ≠ видалити** (#932). Вимкнена стаття зникає з місяців ПІСЛЯ своєї останньої цифри,
 *     тож жоден минулий підсумок від вимкнення не рухається. Видалення мʼяке й повертається тією ж
 *     кнопкою; стаття з цифрами без підтвердження не видаляється (409).
 *  3. **Зберігається все або нічого** (#931): одна клітинка «не число» — жодна не записана.
 *  4. **Кожна зміна — в історії тим самим викликом**: хто, коли, було → стало.
 */

export interface Db {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export class FinError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

// ── Чисті правила ────────────────────────────────────────────────────────────

/**
 * Сума з клітинки: «1 000,50» → 1000.5, «−12 000» → -12000, «» → null. Текст — помилка (400),
 * а не нуль: нуль, що підмінив «не зрозумів», тихо зменшив би підсумок.
 */
export function parseAmount(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new FinError(400, "Сума має бути числом");
    return Math.round(v * 100) / 100;
  }
  if (typeof v !== "string") throw new FinError(400, "Сума має бути числом");
  const s = v.replace(/[\s  ]/g, "").replace(/[−–]/g, "-").replace(",", ".");
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new FinError(400, `«${v}» — не число`);
  const n = Math.round(Number(s) * 100) / 100;
  if (Math.abs(n) >= 1e12) throw new FinError(400, "Сума завелика");
  return n;
}

/** 'YYYY-MM' або 'YYYY-MM-DD' → перше число місяця 'YYYY-MM-01'. */
export function parseMonth(v: unknown): string {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(v.trim()) : null;
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 2000 || Number(m[1]) > 2100)
    throw new FinError(400, "Місяць — у форматі РРРР-ММ");
  return `${m[1]}-${m[2]}-01`;
}

export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}

/** Поточний місяць за Києвом ('YYYY-MM-01'). `sv-SE` дає рівно YYYY-MM-DD. */
export function kyivMonth(now: Date = new Date()): string {
  return `${now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7)}-01`;
}

export type RowState = "empty" | "noplan" | "nofact" | "over" | "ok";

/**
 * Стан рядка: «понад план» — строго факт > план; «без плану» — факт є, плану немає (чи 0);
 * «факту ще немає» — план є, факт не внесено. Межа «over» — рівно f > p: f = p — це ще «ок».
 */
export function rowState(plan: number | null, fact: number | null): RowState {
  if (plan == null || plan === 0) return fact != null && fact > 0 ? "noplan" : "empty";
  if (fact == null) return "nofact";
  return fact > plan ? "over" : "ok";
}

/** Стаття діє в місяці, якщо не вимкнена або вимкнена ПІЗНІШЕ за нього. */
export const isActiveIn = (offFrom: string | null, month: string): boolean => offFrom == null || month < offFrom;

/**
 * З якого місяця вимикати: не раніше поточного і не раніше місяця ПІСЛЯ останньої цифри.
 * Так вимкнення не прибирає жодного внесеного числа з жодного підсумку (#932).
 */
export function offFromFor(current: string, lastDataMonth: string | null): string {
  const after = lastDataMonth ? addMonths(lastDataMonth, 1) : current;
  return after > current ? after : current;
}

const cents = (v: number | null) => (v == null ? 0 : Math.round(v * 100));

export interface TotalsRow { plan: number | null; fact: number | null; active: boolean }
/** Підсумок місяця — ЛИШЕ з рядків, що діють у ньому. Гроші складаються в копійках. */
export function monthTotals(rows: readonly TotalsRow[]) {
  let p = 0, f = 0, over = 0, overC = 0, noplan = 0, count = 0;
  for (const r of rows) {
    if (!r.active) continue;
    count++;
    p += cents(r.plan); f += cents(r.fact);
    const s = rowState(r.plan, r.fact);
    if (s === "over") { over++; overC += cents(r.fact) - cents(r.plan); }
    if (s === "noplan") noplan++;
  }
  return { plan: p / 100, fact: f / 100, items: count, over, noplan, overSum: overC / 100 };
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
const fmtUah = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));

/** Порушення унікальності назви — зрозумілою відповіддю, а не 500. */
async function uniqueName<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new FinError(409, "Така назва тут уже є");
    throw e;
  }
}

async function log(db: Db, actor: number | null, kind: "resp" | "group" | "item" | "month", targetId: number | null, what: string,
  extra: { month?: string | null; field?: "plan" | "fact" | "note"; old?: number | null; new?: number | null } = {}) {
  await db.query(`INSERT INTO fin_log (actor_id, kind, target_id, month, field, old_value, new_value, what)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [actor, kind, targetId, extra.month ?? null, extra.field ?? null, extra.old ?? null, extra.new ?? null, what]);
}

const ACTOR = `COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1))`;

// ── Читання ──────────────────────────────────────────────────────────────────

export interface FinItemRow {
  id: number; name: string; offFrom: string | null; active: boolean;
  plan: number | null; fact: number | null; note: string | null; state: RowState; dataMonths: number;
}
export interface FinGroupRow { id: number; name: string; items: FinItemRow[] }
export interface FinRespRow { id: number; name: string; groups: FinGroupRow[] }

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Дерево на місяць: усі невидалені статті (вимкнені — з `active: false`), підсумок, погодження. */
export async function loadMonth(db: Db, monthArg: unknown, now: Date = new Date()) {
  const month = parseMonth(monthArg);
  const r = await db.query(`
    SELECT r.id AS resp_id, r.name AS resp_name, g.id AS group_id, g.name AS group_name,
           i.id AS item_id, i.name AS item_name, i.off_from::text AS off_from,
           v.plan::text AS plan, v.fact::text AS fact, v.note,
           (SELECT count(*) FROM fin_values h WHERE h.item_id = i.id
              AND (COALESCE(h.plan, 0) <> 0 OR COALESCE(h.fact, 0) <> 0))::int AS data_months
      FROM fin_resps r
      LEFT JOIN fin_groups g ON g.resp_id = r.id AND g.deleted_at IS NULL
      LEFT JOIN fin_items i ON i.group_id = g.id AND i.deleted_at IS NULL
      LEFT JOIN fin_values v ON v.item_id = i.id AND v.month = $1::date
     WHERE r.deleted_at IS NULL
     ORDER BY r.sort, r.id, g.sort, g.id, i.sort, i.id`, [month]);
  const tree: FinRespRow[] = [];
  const all: FinItemRow[] = [];
  for (const x of r.rows) {
    let resp = tree[tree.length - 1];
    if (!resp || resp.id !== x.resp_id) { resp = { id: x.resp_id, name: x.resp_name, groups: [] }; tree.push(resp); }
    if (x.group_id == null) continue;
    let grp = resp.groups[resp.groups.length - 1];
    if (!grp || grp.id !== x.group_id) { grp = { id: x.group_id, name: x.group_name, items: [] }; resp.groups.push(grp); }
    if (x.item_id == null) continue;
    const plan = num(x.plan), fact = num(x.fact);
    const it: FinItemRow = { id: x.item_id, name: x.item_name, offFrom: x.off_from, active: isActiveIn(x.off_from, month),
      plan, fact, note: x.note ?? null, state: rowState(plan, fact), dataMonths: x.data_months };
    grp.items.push(it); all.push(it);
  }
  const ap = await db.query(`
    SELECT a.approved_at AS at, a.note, ${ACTOR} AS actor,
           (SELECT count(*) FROM fin_log l WHERE l.kind = 'item' AND l.field = 'plan' AND l.month = a.month AND l.at > a.approved_at)::int AS changed_after
      FROM fin_plan_approvals a LEFT JOIN users u ON u.id = a.approved_by WHERE a.month = $1::date`, [month]);
  const im = await db.query(`SELECT source, file_plan::text AS file_plan, file_fact::text AS file_fact,
      rows_plan::text AS rows_plan, rows_fact::text AS rows_fact FROM fin_import_months WHERE month = $1::date`, [month]);
  const a = ap.rows[0], i = im.rows[0];
  return {
    month, currentMonth: kyivMonth(now), tree,
    totals: monthTotals(all),
    approval: a ? { at: a.at, by: a.actor ?? null, note: a.note ?? null, changedAfter: a.changed_after } : null,
    imported: i ? { source: i.source, filePlan: num(i.file_plan), fileFact: num(i.file_fact), rowsPlan: num(i.rows_plan), rowsFact: num(i.rows_fact) } : null,
  };
}

/** Картка статті: цифри за рік, історія змін. Видалена стаття теж відкривається (щоб її повернути). */
export async function itemCard(db: Db, id: number, yearArg: unknown) {
  const year = Number(yearArg);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new FinError(400, "Некоректний рік");
  const r = await db.query(`SELECT i.id, i.name, i.off_from::text AS off_from, i.deleted_at, g.id AS group_id, g.name AS group_name,
      r.id AS resp_id, r.name AS resp_name FROM fin_items i JOIN fin_groups g ON g.id = i.group_id JOIN fin_resps r ON r.id = g.resp_id
     WHERE i.id = $1`, [id]);
  const it = r.rows[0];
  if (!it) throw new FinError(404, "Статтю не знайдено");
  const v = await db.query(`SELECT month::text AS month, plan::text AS plan, fact::text AS fact, note FROM fin_values
     WHERE item_id = $1 AND month >= make_date($2, 1, 1) AND month < make_date($2 + 1, 1, 1) ORDER BY month`, [id, year]);
  const byMonth = new Map(v.rows.map((x: any) => [x.month, x]));
  const months = Array.from({ length: 12 }, (_, k) => {
    const m = `${year}-${String(k + 1).padStart(2, "0")}-01`;
    const x: any = byMonth.get(m);
    return { month: m, plan: num(x?.plan), fact: num(x?.fact), note: x?.note ?? null, active: isActiveIn(it.off_from, m) };
  });
  const lg = await db.query(`SELECT l.at, l.month::text AS month, l.field, l.old_value::text AS old, l.new_value::text AS new, l.what, ${ACTOR} AS actor
      FROM fin_log l LEFT JOIN users u ON u.id = l.actor_id WHERE l.kind = 'item' AND l.target_id = $1 ORDER BY l.at DESC, l.id DESC LIMIT 50`, [id]);
  return {
    id: it.id, name: it.name, offFrom: it.off_from, deleted: it.deleted_at != null,
    group: { id: it.group_id, name: it.group_name }, resp: { id: it.resp_id, name: it.resp_name },
    months,
    log: lg.rows.map((l: any) => ({ at: l.at, month: l.month, field: l.field, old: num(l.old), new: num(l.new), what: l.what, actor: l.actor ?? null })),
  };
}

// ── Структура: відповідальні, групи, статті ──────────────────────────────────

export async function createResp(db: Db, actor: number, body: any): Promise<number> {
  const name = cleanName(body?.name, "відповідального");
  const r = await uniqueName(db.query(`INSERT INTO fin_resps (name, sort, created_by)
    VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM fin_resps), 0), $2) RETURNING id`, [name, actor]));
  await log(db, actor, "resp", r.rows[0].id, `Додано відповідального «${name}»`);
  return r.rows[0].id;
}

async function liveRow(db: Db, table: "fin_resps" | "fin_groups" | "fin_items", id: number, what: string) {
  const r = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const row = r.rows[0];
  if (!row || row.deleted_at) throw new FinError(404, `${what} не знайдено`);
  return row;
}

export async function renameResp(db: Db, actor: number, id: number, body: any) {
  const row = await liveRow(db, "fin_resps", id, "Відповідального");
  const name = cleanName(body?.name, "відповідального");
  if (name === row.name) return;
  await uniqueName(db.query(`UPDATE fin_resps SET name = $2 WHERE id = $1`, [id, name]));
  await log(db, actor, "resp", id, `Перейменовано: «${row.name}» → «${name}»`);
}

/** Відповідального з групами не видаляємо: групи спершу переносять (у макеті — той самий діалог). */
export async function deleteResp(db: Db, actor: number, id: number) {
  const row = await liveRow(db, "fin_resps", id, "Відповідального");
  const g = await db.query(`SELECT count(*)::int AS n FROM fin_groups WHERE resp_id = $1 AND deleted_at IS NULL`, [id]);
  if (g.rows[0].n > 0)
    throw new FinError(409, `У «${row.name}» є груп: ${g.rows[0].n}. Спершу перенесіть їх до іншого відповідального або видаліть.`, { groups: g.rows[0].n });
  await db.query(`UPDATE fin_resps SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actor]);
  await log(db, actor, "resp", id, `Видалено відповідального «${row.name}»`);
}

export async function createGroup(db: Db, actor: number, body: any): Promise<number> {
  const respId = idArg(body?.respId, "відповідальний");
  await liveRow(db, "fin_resps", respId, "Відповідального");
  const name = cleanName(body?.name, "групи");
  const r = await uniqueName(db.query(`INSERT INTO fin_groups (resp_id, name, sort, created_by)
    VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM fin_groups WHERE resp_id = $1), 0), $3) RETURNING id`, [respId, name, actor]));
  await log(db, actor, "group", r.rows[0].id, `Додано групу «${name}»`);
  return r.rows[0].id;
}

/** Перейменувати й/або перенести до іншого відповідального. */
export async function updateGroup(db: Db, actor: number, id: number, body: any) {
  const row = await liveRow(db, "fin_groups", id, "Групу");
  if (body?.name !== undefined) {
    const name = cleanName(body.name, "групи");
    if (name !== row.name) {
      await uniqueName(db.query(`UPDATE fin_groups SET name = $2 WHERE id = $1`, [id, name]));
      await log(db, actor, "group", id, `Перейменовано: «${row.name}» → «${name}»`);
    }
  }
  if (body?.respId !== undefined) {
    const respId = idArg(body.respId, "відповідальний");
    if (respId !== row.resp_id) {
      const to = await liveRow(db, "fin_resps", respId, "Відповідального");
      await uniqueName(db.query(`UPDATE fin_groups SET resp_id = $2, sort = COALESCE((SELECT max(sort) + 1 FROM fin_groups WHERE resp_id = $2), 0) WHERE id = $1`, [id, respId]));
      await log(db, actor, "group", id, `Перенесено до «${to.name}»`);
    }
  }
}

/**
 * Група з живими статтями видаляється лише з `confirm` — разом зі статтями, однією міткою часу,
 * щоб «Повернути» повернуло рівно ті статті, що пішли з нею.
 */
export async function deleteGroup(db: Db, actor: number, id: number, confirm: boolean) {
  const row = await liveRow(db, "fin_groups", id, "Групу");
  const c = await db.query(`SELECT count(*)::int AS items,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fin_values v WHERE v.item_id = i.id AND (COALESCE(v.plan, 0) <> 0 OR COALESCE(v.fact, 0) <> 0)))::int AS with_data
      FROM fin_items i WHERE i.group_id = $1 AND i.deleted_at IS NULL`, [id]);
  const { items, with_data } = c.rows[0];
  if (items > 0 && !confirm)
    throw new FinError(409, `У групі статей: ${items}, з цифрами: ${with_data}. Підтвердіть видалення разом зі статтями.`, { items, withData: with_data });
  // Одна мітка на групу й її статті — навіть поза транзакцією (`now()` у кожного оператора своя).
  const at = (await db.query(`SELECT clock_timestamp()::text AS t`)).rows[0].t;
  await db.query(`UPDATE fin_items SET deleted_at = $3::timestamptz, deleted_by = $2 WHERE group_id = $1 AND deleted_at IS NULL`, [id, actor, at]);
  await db.query(`UPDATE fin_groups SET deleted_at = $3::timestamptz, deleted_by = $2 WHERE id = $1`, [id, actor, at]);
  await log(db, actor, "group", id, `Видалено групу «${row.name}»${items ? ` разом зі статтями: ${items}` : ""}`);
}

export async function createItem(db: Db, actor: number, body: any): Promise<number> {
  const groupId = idArg(body?.groupId, "група");
  await liveRow(db, "fin_groups", groupId, "Групу");
  const name = cleanName(body?.name, "статті");
  const plan = parseAmount(body?.plan);
  const month = plan != null ? parseMonth(body?.month) : null;
  const r = await uniqueName(db.query(`INSERT INTO fin_items (group_id, name, sort, created_by)
    VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM fin_items WHERE group_id = $1), 0), $3) RETURNING id`, [groupId, name, actor]));
  const id = r.rows[0].id;
  await log(db, actor, "item", id, `Додано статтю «${name}»`);
  if (plan != null && month) await saveValues(db, actor, month, [{ itemId: id, field: "plan", value: plan }]);
  return id;
}

/** Перейменувати й/або перенести до іншої групи. Цифри й історія їдуть разом зі статтею. */
export async function updateItem(db: Db, actor: number, id: number, body: any) {
  const row = await liveRow(db, "fin_items", id, "Статтю");
  if (body?.name !== undefined) {
    const name = cleanName(body.name, "статті");
    if (name !== row.name) {
      await uniqueName(db.query(`UPDATE fin_items SET name = $2 WHERE id = $1`, [id, name]));
      await log(db, actor, "item", id, `Перейменовано: «${row.name}» → «${name}»`);
    }
  }
  if (body?.groupId !== undefined) {
    const groupId = idArg(body.groupId, "група");
    if (groupId !== row.group_id) {
      const to = await liveRow(db, "fin_groups", groupId, "Групу");
      await uniqueName(db.query(`UPDATE fin_items SET group_id = $2, sort = COALESCE((SELECT max(sort) + 1 FROM fin_items WHERE group_id = $2), 0) WHERE id = $1`, [id, groupId]));
      await log(db, actor, "item", id, `Перенесено до групи «${to.name}»`);
    }
  }
}

/** Вимкнути / увімкнути. Вимкнення — з місяця ПІСЛЯ останньої цифри (не раніше поточного). */
export async function setItemOff(db: Db, actor: number, id: number, off: boolean, now: Date = new Date()) {
  const row = await liveRow(db, "fin_items", id, "Статтю");
  if (!off) {
    if (row.off_from == null) return { offFrom: null };
    await db.query(`UPDATE fin_items SET off_from = NULL WHERE id = $1`, [id]);
    await log(db, actor, "item", id, "Статтю увімкнено");
    return { offFrom: null };
  }
  const last = await db.query(`SELECT max(month)::text AS m FROM fin_values WHERE item_id = $1 AND (plan IS NOT NULL OR fact IS NOT NULL)`, [id]);
  const from = offFromFor(kyivMonth(now), last.rows[0].m ?? null);
  await db.query(`UPDATE fin_items SET off_from = $2 WHERE id = $1`, [id, from]);
  await log(db, actor, "item", id, `Статтю вимкнено з ${from.slice(5, 7)}.${from.slice(0, 4)} — попередні місяці не змінились`);
  return { offFrom: from };
}

/** Стаття з цифрами без `confirm` не видаляється: 409 і кількість місяців, які зникнуть із підсумків. */
export async function deleteItem(db: Db, actor: number, id: number, confirm: boolean) {
  const row = await liveRow(db, "fin_items", id, "Статтю");
  const c = await db.query(`SELECT count(*)::int AS n FROM fin_values WHERE item_id = $1 AND (COALESCE(plan, 0) <> 0 OR COALESCE(fact, 0) <> 0)`, [id]);
  const months = c.rows[0].n;
  if (months > 0 && !confirm)
    throw new FinError(409, `У статті є цифри за ${months} міс. — з видаленням вони зникнуть і з минулих підсумків. Краще вимкнути.`, { months });
  await db.query(`UPDATE fin_items SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actor]);
  await log(db, actor, "item", id, `Видалено статтю «${row.name}»${months ? ` (цифри за ${months} міс.)` : ""}`);
}

/** «Повернути» — пара до кожного видалення. Група повертається разом зі статтями, що пішли з нею. */
export async function restore(db: Db, actor: number, kindArg: unknown, id: number) {
  const kind = kindArg === "resp" || kindArg === "group" || kindArg === "item" ? kindArg : null;
  if (!kind) throw new FinError(400, "Невідомий тип");
  const table = kind === "resp" ? "fin_resps" : kind === "group" ? "fin_groups" : "fin_items";
  const r = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  const row = r.rows[0];
  if (!row) throw new FinError(404, "Не знайдено");
  if (!row.deleted_at) throw new FinError(409, "Уже на місці");
  if (kind === "group") {
    const p = await db.query(`SELECT deleted_at FROM fin_resps WHERE id = $1`, [row.resp_id]);
    if (p.rows[0]?.deleted_at) throw new FinError(409, "Спершу поверніть відповідального цієї групи");
  }
  if (kind === "item") {
    const p = await db.query(`SELECT deleted_at FROM fin_groups WHERE id = $1`, [row.group_id]);
    if (p.rows[0]?.deleted_at) throw new FinError(409, "Спершу поверніть групу цієї статті");
  }
  if (kind === "group")
    await uniqueName(db.query(`UPDATE fin_items SET deleted_at = NULL, deleted_by = NULL
      WHERE group_id = $1 AND deleted_at = (SELECT deleted_at FROM fin_groups WHERE id = $1)`, [id]));
  await uniqueName(db.query(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]));
  await log(db, actor, kind, id, `Повернуто «${row.name}»`);
}

// ── Цифри, коментарі, погодження ─────────────────────────────────────────────

export interface Cell { itemId: unknown; field: unknown; value: unknown }

/**
 * Зберегти клітинки місяця. Спершу перевіряється ВСЕ, потім пишеться: одна помилка — нічого не
 * записано (#931). Факт майбутнього місяця не приймається; вимкнена в цьому місяці стаття — теж.
 */
export async function saveValues(db: Db, actor: number, monthArg: unknown, cells: readonly Cell[], now: Date = new Date()) {
  const month = parseMonth(monthArg);
  if (!Array.isArray(cells) || !cells.length) throw new FinError(400, "Немає змін");
  if (cells.length > 5000) throw new FinError(400, "Забагато клітинок за раз");
  const parsed: { itemId: number; field: "plan" | "fact"; value: number | null }[] = [];
  const bad: { itemId: unknown; field: unknown }[] = [];
  const seen = new Set<string>();
  for (const c of cells) {
    const itemId = Number(c?.itemId);
    const field = c?.field === "plan" || c?.field === "fact" ? c.field : null;
    if (!Number.isInteger(itemId) || itemId <= 0 || !field) throw new FinError(400, "Некоректна клітинка");
    const key = `${itemId}:${field}`;
    if (seen.has(key)) throw new FinError(400, "Одна клітинка двічі в одному збереженні");
    seen.add(key);
    try { parsed.push({ itemId, field, value: parseAmount(c.value) }); } catch { bad.push({ itemId, field }); }
  }
  if (bad.length) throw new FinError(400, `У клітинках (${bad.length}) не число — нічого не збережено`, { bad });
  if (parsed.some((c) => c.field === "fact") && month > kyivMonth(now)) throw new FinError(400, "Факт майбутнього місяця внести не можна");

  const ids = [...new Set(parsed.map((c) => c.itemId))];
  const it = await db.query(`SELECT id, name, off_from::text AS off_from, deleted_at FROM fin_items WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
  const items = new Map(it.rows.map((x: any) => [x.id, x]));
  for (const id of ids) {
    const x: any = items.get(id);
    if (!x || x.deleted_at) throw new FinError(404, "Статтю не знайдено — нічого не збережено");
    if (!isActiveIn(x.off_from, month)) throw new FinError(409, `Стаття «${x.name}» вимкнена в цьому місяці — нічого не збережено`);
  }
  const cur = await db.query(`SELECT item_id, plan::text AS plan, fact::text AS fact FROM fin_values WHERE month = $1::date AND item_id = ANY($2::int[]) FOR UPDATE`, [month, ids]);
  const old = new Map(cur.rows.map((x: any) => [x.item_id, { plan: num(x.plan), fact: num(x.fact) }]));
  let changed = 0;
  for (const c of parsed) {
    const was = old.get(c.itemId)?.[c.field] ?? null;
    if (was === c.value) continue;
    await db.query(`INSERT INTO fin_values (item_id, month, ${c.field}, updated_by, updated_at) VALUES ($1, $2::date, $3, $4, now())
      ON CONFLICT (item_id, month) DO UPDATE SET ${c.field} = EXCLUDED.${c.field}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [c.itemId, month, c.value, actor]);
    const label = c.field === "plan" ? "План" : "Факт";
    await log(db, actor, "item", c.itemId, `${label} ${month.slice(5, 7)}.${month.slice(0, 4)}: ${fmtUah(was)} → ${fmtUah(c.value)}`,
      { month, field: c.field, old: was, new: c.value });
    const o = old.get(c.itemId) ?? { plan: null, fact: null };
    o[c.field] = c.value; old.set(c.itemId, o);
    changed++;
  }
  return { changed };
}

/** Коментар «чому» до статті в місяці. Порожній текст — коментар прибрано (і це теж в історії). */
export async function setNote(db: Db, actor: number, itemId: number, monthArg: unknown, textArg: unknown) {
  const month = parseMonth(monthArg);
  await liveRow(db, "fin_items", itemId, "Статтю");
  const text = typeof textArg === "string" ? textArg.trim().slice(0, 2000) : "";
  const cur = await db.query(`SELECT note FROM fin_values WHERE item_id = $1 AND month = $2::date`, [itemId, month]);
  const was = cur.rows[0]?.note ?? null;
  const next = text || null;
  if (was === next) return;
  await db.query(`INSERT INTO fin_values (item_id, month, note, updated_by, updated_at) VALUES ($1, $2::date, $3, $4, now())
    ON CONFLICT (item_id, month) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`, [itemId, month, next, actor]);
  await log(db, actor, "item", itemId, next ? `Коментар ${month.slice(5, 7)}.${month.slice(0, 4)}: «${next.slice(0, 120)}»` : `Коментар ${month.slice(5, 7)}.${month.slice(0, 4)} прибрано`,
    { month, field: "note" });
}

/** Погодити план місяця або зняти погодження (право `approve_finance_plan` — у роуті). */
export async function setApproval(db: Db, actor: number, monthArg: unknown, approved: boolean) {
  const month = parseMonth(monthArg);
  if (approved) {
    const r = await db.query(`INSERT INTO fin_plan_approvals (month, approved_by) VALUES ($1::date, $2) ON CONFLICT (month) DO NOTHING RETURNING month`, [month, actor]);
    if (!r.rows.length) throw new FinError(409, "План цього місяця вже погоджено");
    await log(db, actor, "month", null, `План ${month.slice(5, 7)}.${month.slice(0, 4)} погоджено`, { month });
  } else {
    const r = await db.query(`DELETE FROM fin_plan_approvals WHERE month = $1::date RETURNING month`, [month]);
    if (!r.rows.length) throw new FinError(409, "План цього місяця не погоджено");
    await log(db, actor, "month", null, `Погодження плану ${month.slice(5, 7)}.${month.slice(0, 4)} знято`, { month });
  }
}

// ── Разове перенесення з Excel ───────────────────────────────────────────────

export interface ImportRow { k: "r" | "g" | "i"; n: string; row?: number; v?: [number | null, number | null][] }
export interface ImportFile { rows: ImportRow[]; tot?: [number | null, number | null][] }

/**
 * Перенесення таблиці «Витрати План/Факт» (рядки: відповідальний → група → стаття; у статті — [план, факт]
 * по місяцях від січня). Одна транзакція; повторно не запускається (409), якщо розділ уже не порожній.
 * Підсумок кожного місяця = СУМА РЯДКІВ; підсумок файлу зберігається поруч лише як довідка (#935).
 */
export async function importHistory(db: Db, actor: number | null, file: ImportFile, year: number, source: string) {
  if (!file || !Array.isArray(file.rows) || !file.rows.length) throw new FinError(400, "Порожній файл");
  const busy = await db.query(`SELECT (SELECT count(*) FROM fin_resps)::int + (SELECT count(*) FROM fin_import_months)::int AS n`);
  if (busy.rows[0].n > 0) throw new FinError(409, "Розділ уже не порожній — повторне перенесення заборонене");
  const nMonths = Math.max(0, ...file.rows.filter((r) => r.k === "i").map((r) => r.v?.length ?? 0));
  if (!nMonths || nMonths > 12) throw new FinError(400, "У статтях немає місяців");
  const rowsP = Array(nMonths).fill(0), rowsF = Array(nMonths).fill(0);
  let respId: number | null = null, groupId: number | null = null, items = 0;
  for (const r of file.rows) {
    const name = cleanName(r.n, r.k === "r" ? "відповідального" : r.k === "g" ? "групи" : "статті");
    if (r.k === "r") {
      respId = (await uniqueName(db.query(`INSERT INTO fin_resps (name, sort, created_by) VALUES ($1, COALESCE((SELECT max(sort) + 1 FROM fin_resps), 0), $2) RETURNING id`, [name, actor]))).rows[0].id;
      groupId = null;
    } else if (r.k === "g") {
      if (respId == null) throw new FinError(400, `Група «${name}» без відповідального`);
      groupId = (await uniqueName(db.query(`INSERT INTO fin_groups (resp_id, name, sort, created_by) VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM fin_groups WHERE resp_id = $1), 0), $3) RETURNING id`, [respId, name, actor]))).rows[0].id;
    } else if (r.k === "i") {
      if (groupId == null) throw new FinError(400, `Стаття «${name}» без групи`);
      const id = (await uniqueName(db.query(`INSERT INTO fin_items (group_id, name, sort, created_by) VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM fin_items WHERE group_id = $1), 0), $3) RETURNING id`, [groupId, name, actor]))).rows[0].id;
      items++;
      for (let m = 0; m < nMonths; m++) {
        const [p, f] = r.v?.[m] ?? [null, null];
        const plan = p == null ? null : parseAmount(p), fact = f == null ? null : parseAmount(f);
        if (plan == null && fact == null) continue;
        rowsP[m] += cents(plan); rowsF[m] += cents(fact);
        await db.query(`INSERT INTO fin_values (item_id, month, plan, fact, updated_by) VALUES ($1, make_date($2, $3, 1), $4, $5, $6)`,
          [id, year, m + 1, plan, fact, actor]);
      }
      await log(db, actor, "item", id, `Перенесено з таблиці «${source}»`);
    } else throw new FinError(400, "Невідомий тип рядка");
  }
  const months = [];
  for (let m = 0; m < nMonths; m++) {
    const [fp, ff] = file.tot?.[m] ?? [null, null];
    const out = { month: `${year}-${String(m + 1).padStart(2, "0")}-01`, rowsPlan: rowsP[m] / 100, rowsFact: rowsF[m] / 100,
      filePlan: fp == null ? null : parseAmount(fp), fileFact: ff == null ? null : parseAmount(ff) };
    await db.query(`INSERT INTO fin_import_months (month, source, file_plan, file_fact, rows_plan, rows_fact, imported_by)
      VALUES ($1::date, $2, $3, $4, $5, $6, $7)`, [out.month, source, out.filePlan, out.fileFact, out.rowsPlan, out.rowsFact, actor]);
    months.push(out);
  }
  return { items, months };
}
