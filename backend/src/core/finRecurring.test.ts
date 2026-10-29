import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { addPeriod, occurrences, shiftYm, buildMonths, planHintsOf, undoable, type RecItem, type PaidRow } from "./finRecurring.js";

/**
 * 📅 «Календар оплат» (задача Тетяни #6369, 27.10.2026; макет «Г» — Роман). Гейти `#1291`–`#1291f` (прохід 1) і
 * `#1292`–`#1292e` (прохід 2: стаття й місяць, підказка в «План/факті»; `#1291c`/`#1291d`/`#1291f` знято — RETIRED_GATES).
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const item = (o: Partial<RecItem>): RecItem => ({ id: 1, itemId: 101, name: "Оренда", amount: 45000, period: "month", anchorDay: 1, next: "2026-11-01", note: null, active: true, ...o });
const paid = (o: Partial<PaidRow>): PaidRow => ({ id: 1, recurringId: 1, name: "Оренда", due: "2026-10-01", amount: 45000, planned: 45000, by: "Тетяна", at: "2026-10-05T09:00:00Z", cancelledBy: null, cancelledAt: null, ...o });

/**
 * #1291 — «ДЕНЬ ОПЛАТИ» НЕ ЗʼЇЖДЖАЄ. Наступна дата рахується від ЯКОРЯ, а не від попередньої: 31.01 → 28.02 → 31.03;
 * квартал з 30.11 → 28.02 → 30.05; рік з 29.02 → 28.02 → … → знову 29.02 у високосний. Місяць смуги — від 1-го числа
 * (31.08 + 1 = вересень, а не жовтень — борг 19, `monthKeys`). Вікно дат — включно з обох кінців.
 * 🧨 Червоніє, якщо дата піде від попередньої (лютий назавжди зробить 31-ше 28-м) чи місяць перескочить через переповнення.
 */
test("#1291 ДЕНЬ ОПЛАТИ НЕ ЗʼЇЖДЖАЄ: 31.01 → 28.02 → 31.03, квартал і рік від якоря, місяць смуги від 1-го, вікно включно", () => {
  assert.equal(addPeriod("2026-01-31", "month", 31), "2026-02-28", "🔴 31.01 + місяць");
  assert.equal(addPeriod("2026-02-28", "month", 31), "2026-03-31", "🔴 після лютого день зʼїхав");
  assert.equal(addPeriod("2026-03-31", "month", 31), "2026-04-30", "🔴 31.03 + місяць");
  assert.equal(addPeriod("2026-12-05", "month", 5), "2027-01-05", "🔴 перехід року");
  assert.deepEqual([addPeriod("2026-11-30", "quarter", 30), addPeriod("2027-02-28", "quarter", 30)], ["2027-02-28", "2027-05-30"], "🔴 квартал від якоря");
  assert.deepEqual([addPeriod("2028-02-29", "year", 29), addPeriod("2031-02-28", "year", 29)], ["2029-02-28", "2032-02-29"], "🔴 рік від якоря");
  assert.deepEqual([shiftYm("2026-08", 1), shiftYm("2026-01", -1), shiftYm("2026-10", 18)], ["2026-09", "2025-12", "2028-04"], "🔴 місяць смуги перескочив");
  assert.deepEqual(occurrences("2026-01-31", "month", 31, "2026-01-31", "2026-03-31"), ["2026-01-31", "2026-02-28", "2026-03-31"], "🔴 вікно не включно");
  assert.deepEqual(occurrences("2026-01-31", "month", 31, "2026-02-01", "2026-03-30"), ["2026-02-28"], "🔴 дата поза вікном потрапила");
});

/**
 * #1291b — СМУГА МІСЯЦІВ. Ліворуч — минуле аж до першої живої оплати (не менше 6 міс.), праворуч — 18 міс. Минуле — лише
 * реально оплачене (графік у минуле не малюється), майбутнє — з графіка увімкнених оплат; скасована позначка в смугу не
 * йде; вимкнена оплата — не планується, але її оплати лишаються; минулий неоплачений місяць — «overdue», поточний —
 * «soon»; «Оплачено» — лише на поточному місяці; «Скасувати» — лише на останній позначці.
 * 🧨 Червоніє, якщо смуга обріже історію, намалює графік у минуле, покаже скасоване чи дасть скасувати не останню.
 */
test("#1291b СМУГА: минуле — лише оплачене аж до першої оплати, майбутнє — графік, скасоване й вимкнене — не плануються", () => {
  const items = [item({ id: 1, next: "2026-11-01" }), item({ id: 2, name: "Хостинг", amount: 1200, next: "2026-09-01" }), item({ id: 3, name: "Старе", active: false, next: "2026-08-01" })];
  const p = [paid({ id: 1, due: "2025-12-01" }), paid({ id: 2, due: "2026-10-01" }), paid({ id: 3, recurringId: 2, name: "Хостинг", due: "2026-08-01", amount: 1200, planned: 1200, cancelledAt: "2026-09-21T10:00:00Z", cancelledBy: "Роман" }),
    paid({ id: 4, recurringId: 3, name: "Старе", due: "2026-07-01", amount: 700, planned: 700 })];
  const m = buildMonths(items, p, "2026-10-27");
  assert.deepEqual([m[0].ym, m[0].offset, m.at(-1)!.ym], ["2025-12", -10, "2028-04"], "🔴 смуга не від першої оплати чи не на 18 міс.");
  assert.equal(buildMonths(items, [], "2026-10-27")[0].ym, "2026-04", "🔴 без історії — не 6 міс. назад");
  const sep = m.find((x) => x.ym === "2026-09")!, oct = m.find((x) => x.ym === "2026-10")!;
  assert.deepEqual(sep.events.map((e) => [e.recurringId, e.kind, e.due]), [[2, "overdue", true]], "🔴 неоплачений минулий місяць не «прострочено»");
  assert.deepEqual(oct.events.map((e) => [e.recurringId, e.kind, e.due]), [[1, "paid", false], [2, "soon", false]], "🔴 жовтень");
  assert.deepEqual([oct.sum, oct.paid, sep.overdue], [46200, 45000, 1200], "🔴 суми місяців");
  assert.deepEqual(m.find((x) => x.ym === "2026-08")!.events, [], "🔴 скасоване чи графік у минуле потрапили в серпень");
  assert.deepEqual(m.find((x) => x.ym === "2026-07")!.events.map((e) => e.recurringId), [3], "🔴 оплата вимкненої зникла з історії");
  assert.ok(m.every((x) => x.events.every((e) => e.recurringId !== 3 || e.kind === "paid")), "🔴 вимкнена оплата планується");
  assert.deepEqual(m.find((x) => x.ym === "2026-11")!.events.map((e) => [e.recurringId, e.kind, e.due]), [[1, "plan", true], [2, "plan", false]], "🔴 «Оплачено» не лише на поточному місяці");
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.deepEqual([undoable(p[1], byId), undoable(p[0], byId), undoable(p[2], byId)], [true, false, false], "🔴 скасувати можна не лише останню живу");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  // Кластер уже піднятий: впало підключення чи схема — зупинити його, інакше тест висить вічно на живому postgres.
  try {
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  } catch (e) { await c.end().catch(() => undefined); scratch.dispose(); throw e; }
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}
/** Відповідальний → група → дві статті (друга видалена); користувачі Тетяна (8) і Роман (50). */
async function seed(c: import("pg").Client): Promise<{ rent: number; gone: number }> {
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active, full_name) VALUES (8, 'fin@test', 'x', 'admin', true, 'Тетяна'), (50, 'adm@test', 'x', 'admin', true, 'Роман')`);
  const r = (await c.query(`INSERT INTO fin_resps (name) VALUES ('Тетяна') RETURNING id`)).rows[0].id;
  const g = (await c.query(`INSERT INTO fin_groups (resp_id, name) VALUES ($1, 'Офіс') RETURNING id`, [r])).rows[0].id;
  const rent = (await c.query(`INSERT INTO fin_items (group_id, name) VALUES ($1, 'Оренда офісу') RETURNING id`, [g])).rows[0].id;
  const gone = (await c.query(`INSERT INTO fin_items (group_id, name, deleted_at) VALUES ($1, 'Стара стаття', now()) RETURNING id`, [g])).rows[0].id;
  return { rent, gone };
}

/**
 * #1292 — ЖИВИЙ SQL: ОПЛАТА — СТАТТЯ Й МІСЯЦЬ. Без статті / видалена стаття / нульова сума / без місяця — 400 і нічого не
 * пишеться; місяць — завжди 1-ше; назва — назва статті (з приміткою в історії); «Оплачено» — лише поточний місяць (інший
 * чи повторно — 409 без запису), фактична сума окремо від планової; «Скасувати» — лише останню, рядок лишається
 * «скасовано»; після скасування можна оплатити знову; вимкнену — не оплатити. Рядків історії ніколи не меншає.
 * 🧨 Червоніє, якщо подвійне натискання дасть дві оплати, скасування зітре рядок, а видалена стаття стане оплатою.
 */
test("#1292 ЖИВИЙ SQL: оплата — стаття й місяць, «Оплачено» лише поточного місяця, скасування лишає рядок, історія не меншає", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { createRecurring, payRecurring, undoPaid, updateRecurring, loadCalendar } = await import("./finRecurring.js");
  const db = c as unknown as import("./finance.js").Db;
  const rows = async () => (await c.query(`SELECT count(*)::int AS n FROM fin_recurring_paid`)).rows[0].n as number;
  try {
    const { rent, gone } = await seed(c);
    const body = { itemId: rent, amount: "45 000", period: "month", month: "2026-01", note: "ФОП Коваль" };
    for (const [why, b] of [["видалена стаття", { ...body, itemId: gone }], ["без статті", { ...body, itemId: null }], ["нульова сума", { ...body, amount: "0" }], ["без місяця", { ...body, month: "2026-13" }]] as const)
      await assert.rejects(createRecurring(db, 50, b), (e: any) => e?.status === 400, `🔴 пройшло: ${why}`);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_recurring`)).rows[0].n, 0, "🔴 відмова щось записала");
    const id = await createRecurring(db, 50, body);
    assert.deepEqual((await c.query(`SELECT name, next_due::text AS d, anchor_day AS a FROM fin_recurring WHERE id = $1`, [id])).rows[0], { name: "Оренда офісу", d: "2026-01-01", a: 1 }, "🔴 не стаття чи не 1-ше");
    await assert.rejects(payRecurring(db, 8, id, { due: "2026-02-01" }), (e: any) => e?.status === 409, "🔴 оплачено не поточний місяць");
    const p1 = await payRecurring(db, 8, id, { due: "2026-01-01", amount: "45 500" });
    assert.equal(p1.next, "2026-02-01", "🔴 місяць не зсунувся");
    await assert.rejects(payRecurring(db, 8, id, { due: "2026-01-01" }), (e: any) => e?.status === 409, "🔴 подвійне натискання дало другу оплату");
    const p2 = await payRecurring(db, 50, id, { due: "2026-02-01" });
    await assert.rejects(undoPaid(db, 50, p1.paidId), (e: any) => e?.status === 409, "🔴 скасовано не останню");
    assert.equal((await undoPaid(db, 50, p2.paidId)).next, "2026-02-01", "🔴 місяць не повернувся");
    assert.equal(await rows(), 2, "🔴 скасування стерло рядок");
    await payRecurring(db, 8, id, { due: "2026-02-01", amount: "44 000" });
    assert.equal(await rows(), 3, "🔴 після скасування не можна оплатити знову");
    await updateRecurring(db, 50, id, { active: false });
    await assert.rejects(payRecurring(db, 8, id, { due: "2026-03-01" }), (e: any) => e?.status === 400, "🔴 оплачено вимкнене");
    const cal = await loadCalendar(db, "2026-04-10");
    assert.deepEqual(cal.history.map((h) => [h.due, h.amount, h.planned, h.by, !!h.cancelledAt, h.name]),
      [["2026-02-01", 44000, 45000, "Тетяна", false, "Оренда офісу · ФОП Коваль"], ["2026-02-01", 45000, 45000, "Роман", true, "Оренда офісу · ФОП Коваль"], ["2026-01-01", 45500, 45000, "Тетяна", false, "Оренда офісу · ФОП Коваль"]], "🔴 історія");
    assert.deepEqual(cal.articles.map((a) => a.name), ["Оренда офісу"], "🔴 у списку статей видалена чи немає живої");
  } finally { await s.dispose(); }
});

/**
 * #1292b — ЖИВИЙ SQL: «ДОДАТИ В ПЛАН». Сума ДОДАЄТЬСЯ до наявного плану статті (порожній — стає сумою); дві оплати на одну
 * статтю — кожна своєю кнопкою; вдруге та сама — 409, план не змінюється; місяць, на який оплата не припадає, — 400;
 * погоджений місяць — 409 і нічого не записано (ні план, ні «додано»); запис іде в журнал змін «Фінансів».
 * 🧨 Червоніє, якщо кнопка перепише план замість додати, додасть двічі чи обійде замок погодженого місяця.
 */
test("#1292b ЖИВИЙ SQL: «додати в план» — сума до наявного плану, двічі — 409, не той місяць — 400, погоджений — 409 без запису, журнал є", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { createRecurring, addToPlan, loadPlanHints } = await import("./finRecurring.js");
  const db = c as unknown as import("./finance.js").Db;
  const plan = async (itemId: number, m: string) => (await c.query(`SELECT plan::float8 AS p FROM fin_values WHERE item_id = $1 AND month = $2::date`, [itemId, m])).rows[0]?.p ?? null;
  try {
    const { rent } = await seed(c);
    const a = await createRecurring(db, 50, { itemId: rent, amount: "45000", period: "month", month: "2026-11" });
    const b = await createRecurring(db, 50, { itemId: rent, amount: "5000", period: "quarter", month: "2026-11", note: "склад" });
    await c.query(`INSERT INTO fin_values (item_id, month, plan) VALUES ($1, '2026-11-01', 10000)`, [rent]);
    assert.deepEqual(await addToPlan(db, 8, { recurringId: a, month: "2026-11" }), { before: 10000, after: 55000 }, "🔴 не додало до наявного плану");
    await assert.rejects(addToPlan(db, 8, { recurringId: a, month: "2026-11" }), (e: any) => e?.status === 409, "🔴 додано вдруге");
    assert.equal(await plan(rent, "2026-11-01"), 55000, "🔴 повторна спроба змінила план");
    assert.deepEqual(await addToPlan(db, 50, { recurringId: b, month: "2026-11" }), { before: 55000, after: 60000 }, "🔴 друга оплата статті");
    await assert.rejects(addToPlan(db, 8, { recurringId: b, month: "2026-12" }), (e: any) => e?.status === 400, "🔴 квартальна додалась у місяць без оплати");
    assert.deepEqual((await addToPlan(db, 8, { recurringId: a, month: "2026-12" })), { before: null, after: 45000 }, "🔴 порожній план не став сумою");
    await c.query(`INSERT INTO fin_plan_approvals (month, approved_by) VALUES ('2027-01-01', 50)`);
    await assert.rejects(addToPlan(db, 8, { recurringId: a, month: "2027-01" }), (e: any) => e?.status === 409, "🔴 обійдено замок погодженого місяця");
    assert.deepEqual([await plan(rent, "2027-01-01"), (await c.query(`SELECT count(*)::int AS n FROM fin_recurring_planned WHERE month = '2027-01-01'`)).rows[0].n], [null, 0], "🔴 погоджений місяць щось записав");
    const h = await loadPlanHints(db, "2026-11");
    assert.deepEqual(h.map((x) => [x.recurringId, x.note, x.added?.amount, x.added?.by]), [[a, null, 45000, "Тетяна"], [b, "склад", 5000, "Роман"]], "🔴 підказки не кажуть, що й хто додав");
    assert.ok((await c.query(`SELECT count(*)::int AS n FROM fin_log WHERE target_id = $1 AND field = 'plan'`, [rent])).rows[0].n >= 3, "🔴 «додати в план» не в журналі змін");
  } finally { await s.dispose(); }
});

/**
 * #1292c — ПІДКАЗКИ МІСЯЦЯ. Що за графіком припадає на місяць (квартальна — лише в свої місяці), що в ньому вже оплачено
 * (фактична сума; і тоді, коли оплату потім вимкнули), скасоване — ні, вимкнене без оплати — ні; кілька оплат на статтю —
 * окремо; «додано» — з тим, хто додав.
 * 🧨 Червоніє, якщо підказка зʼявиться не в той місяць, сховає оплачене чи покаже скасоване.
 */
test("#1292c ПІДКАЗКИ МІСЯЦЯ: графік і оплачене в місяці, скасоване й вимкнене — ні, кілька на статтю — окремо, «додано» з автором", () => {
  const items = [item({ id: 1, next: "2026-11-01" }), item({ id: 2, amount: 5000, period: "quarter", next: "2026-11-01", note: "склад" }), item({ id: 3, itemId: 102, active: false, next: "2026-11-01" })];
  const p = [paid({ id: 1, recurringId: 1, due: "2026-10-01", amount: 45500 }), paid({ id: 2, recurringId: 3, due: "2026-10-01", amount: 700 }), paid({ id: 3, recurringId: 2, due: "2026-08-01", cancelledAt: "2026-08-02T00:00:00Z" })];
  const added = new Map([["1@2026-11", { amount: 45000, by: "Тетяна", at: "2026-10-27T10:00:00Z" }]]);
  assert.deepEqual(planHintsOf(items, p, added, "2026-11").map((h) => [h.recurringId, h.amount, h.paid, h.added?.by ?? null]), [[1, 45000, false, "Тетяна"], [2, 5000, false, null]], "🔴 листопад");
  assert.deepEqual(planHintsOf(items, p, new Map(), "2026-12").map((h) => h.recurringId), [1], "🔴 квартальна в чужому місяці");
  assert.deepEqual(planHintsOf(items, p, new Map(), "2027-02").map((h) => h.recurringId), [1, 2], "🔴 квартальна не у свій місяць");
  assert.deepEqual(planHintsOf(items, p, new Map(), "2026-10").map((h) => [h.recurringId, h.amount, h.paid]), [[1, 45500, true], [3, 700, true]], "🔴 оплачене (і вимкнене потім) не показано");
  assert.deepEqual(planHintsOf(items, p, new Map(), "2026-08"), [], "🔴 скасоване показано");
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

/**
 * #1291e — ОКРЕМО Й БЕЗ ВИДАЛЕННЯ. SQL по таблицях календаря (`FROM` / `JOIN` / `INTO` / `UPDATE`) є лише в
 * `core/finRecurring.ts` («План/факт» отримує підказки ЧЕРЕЗ нього, а не власним запитом); видалення з них (`DELETE` /
 * `TRUNCATE`) немає ніде в коді. Перевірка обходить УСІ файли `backend/src` (не лише ті, де є слово); файлів має бути понад сотню.
 * 🧨 Червоніє, якщо хтось почне читати календар власним SQL чи додасть видалення історії.
 */
test("#1291e ІЗОЛЯЦІЯ: таблиці календаря — лише в ядрі календаря, видалення з них немає ніде", () => {
  const root = path.join(import.meta.dirname, "..", "..", "src");
  const files = walk(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 100, `🔴 обійдено лише ${files.length} файлів — простір пошуку неповний`);
  const users = files.filter((f) => /(FROM|JOIN|INTO|UPDATE)\s+fin_recurring/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  assert.deepEqual(users, [path.join("core", "finRecurring.ts")], "🔴 таблиці календаря читає чи пише ще хтось");
  for (const f of [...walk(root).filter((x) => x.endsWith(".ts")), path.join(root, "db", "schema.sql")])
    assert.doesNotMatch(readFileSync(f, "utf8"), /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+fin_recurring/i, `🔴 видалення історії в ${path.relative(root, f)}`);
});

/**
 * #1292d — ПЛАН ЛИШЕ ЧЕРЕЗ `saveValues`. Календар не пише `fin_values` власним SQL (лише читає поточний план), а
 * «додати в план» кличе `saveValues` ДО запису «додано» — тож замок погодженого місяця, вимкнена стаття й журнал змін ті
 * самі, що в ручного «Зберегти», і відмова не лишає «додано» без плану.
 * 🧨 Червоніє, якщо хтось запише план напряму чи поміняє порядок.
 */
test("#1292d ПЛАН ЛИШЕ ЧЕРЕЗ saveValues: жодного запису fin_values у календарі, «додано» — після збереження плану", () => {
  const src = SRC("core/finRecurring.ts");
  assert.doesNotMatch(src, /(INSERT\s+INTO|UPDATE)\s+fin_values/i, "🔴 календар пише план напряму");
  const fn = src.slice(src.indexOf("export async function addToPlan"), src.indexOf("const dmy ="));
  assert.ok(fn.length > 100, "🔴 не знайдено addToPlan");
  const save = fn.indexOf(`await saveValues(db, actor, ym, [{ itemId: h.itemId, field: "plan", value: after }]);`);
  assert.ok(save > 0 && save < fn.indexOf("INSERT INTO fin_recurring_planned"), "🔴 «додано» пишеться не після збереження плану через saveValues");
});

/**
 * #1292e — МЕЖА Й ПРОВОДКА. Шість роутів календаря, кожен — `view_private_finance` ПЕРШИМ middleware, змонтовані ДО
 * `/api/finance`; підказки й «додати в план» — у межі «Фінансів» (`onlyFinance` / `canEdit` першим: бачать «Таня +
 * керівництво»); у матриці — дзеркала; таблиці закриті від AI; нагадувань у меню більше немає; форма — стаття зі списку й
 * місяць, без «хто платить»; у «План/факті» підказка біля статті, кнопка — лише з правом і на непогодженому плані.
 * 🧨 Червоніє, якщо відкрити календар СЕО/ОД/КВП, сховати підказки від керівництва чи повернути «хто платить».
 */
test("#1292e МЕЖА: шість роутів календаря під view_private_finance, підказки — межа «Фінансів», форма — стаття й місяць, кнопка лише з правом", async () => {
  const r = SRC("routes/financeCalendar.ts");
  const handlers = [...r.matchAll(/financeCalendarRouter\.(get|post|put|patch|delete)\("([^"]+)",\s*([^,]+),/g)];
  assert.equal(handlers.length, 6, "🔴 обробників не рівно шість — гейт не бачить нового роута");
  for (const [, m, p, first] of handlers) assert.equal(first.trim(), `requirePerm("view_private_finance")`, `🔴 ${m.toUpperCase()} ${p}: першим стоїть «${first.trim()}»`);
  const idx = SRC("index.ts");
  assert.ok(idx.indexOf(`app.use("/api/finance/calendar", financeCalendarRouter);`) > 0 && idx.indexOf(`app.use("/api/finance/calendar", financeCalendarRouter);`) < idx.indexOf(`app.use("/api/finance", financeRouter);`), "🔴 роутер не змонтовано до /api/finance");
  const fin = SRC("routes/finance.ts");
  assert.match(fin, /financeRouter\.get\("\/plan-hints", async \(req, res\) => \{\n\s*try \{\n\s*onlyFinance\(req\);/, "🔴 підказки не в межі «Фінансів»");
  assert.match(fin, /financeRouter\.post\("\/plan-hints\/add", async \(req, res\) => \{\n\s*try \{\n\s*canEdit\(req\);/, "🔴 «додати в план» не за правом вносити");
  const { ACCESS_MATRIX } = await import("../auth/accessMatrix.js");
  const row = (method: string, p: string) => ACCESS_MATRIX.find((x) => x.method === method && x.path === p);
  for (const p of ["/api/finance/calendar", "/api/finance/calendar/history.xlsx"]) {
    assert.deepEqual([...(row("GET", p)?.allow ?? [])].sort(), ["admin", "financier"], `🔴 ${p}: дозвіл не рівно Адмін і фінансист`);
    for (const role of ["ceo", "opdir", "kvp", "manager"]) assert.ok(row("GET", p)!.deny.includes(role), `🔴 ${p}: ${role} не в забороні`);
  }
  assert.equal(row("GET", "/api/finance/calendar/due"), undefined, "🔴 у матриці лишився знятий роут нагадувань");
  assert.deepEqual([...(row("GET", "/api/finance/plan-hints?m=2026-11")?.allow ?? [])].sort(), ["admin", "ceo", "financier", "kvp", "opdir"], "🔴 підказки не «Таня + керівництво»");
  assert.deepEqual(row("POST", "/api/finance/plan-hints/add")?.deny, ["hr", "team_lead", "manager"], "🔴 «додати в план» не в матриці");
  for (const t of ["fin_recurring", "fin_recurring_paid", "fin_recurring_planned"]) {
    assert.match(SRC("db/schema.sql"), new RegExp(`REVOKE ALL ON ${t} FROM ai_readonly;`), `🔴 ${t} відкрита для AI`);
    assert.match(SRC("ai/metricTools.ts"), new RegExp(`"${t}"`), `🔴 ${t} не в заборонених AI`);
  }
  const tab = FE("pages/dashboard/sections/FinanceCalendarTab.tsx"), sec = FE("pages/dashboard/sections/FinanceSection.tsx");
  assert.match(tab, /if \(!canView\) return;\n\s*fetchFinCalendar\(\)/, "🔴 без права вкладка все одно просить дані");
  assert.match(tab, /<select className="hr-inp"[^>]*value=\{form\.itemId\}/, "🔴 «Назва» — не список статей");
  assert.match(tab, /type="month" value=\{form\.month\}/, "🔴 замість місяця — дата");
  assert.doesNotMatch(tab, /Хто платить|payerId/, "🔴 повернувся «хто платить»");
  assert.doesNotMatch(FE("components/Layout.tsx"), /useFinanceReminders/, "🔴 нагадування в меню повернулось");
  assert.match(sec, /<PlanHints hints=\{hints\.get\(it\.id\)\}/, "🔴 підказки немає в рядку статті");
  assert.match(sec, /const canAdd = data\.canEdit && !planLocked;/, "🔴 кнопка без права чи на погодженому плані");
});

/**
 * #1295 — «РАЗ НА ПІВ РОКУ» І «ОДНОРАЗОВО» (Тетяна 29.10.2026). Пів року — +6 місяців від якоря; одноразова — рівно одна дата
 * (поза вікном — нічого), у смузі — лише свій місяць, підказка «План/факту» — лише в ньому; оплачена (закрита) одноразова
 * більше не планується, а її оплата лишається; «Скасувати» можна саме ту позначку, що її закрила.
 * 🧨 Червоніє, якщо одноразова повториться наступного місяця, пів року стане кварталом чи закрита одноразова й далі нагадуватиме.
 */
test("#1295 ПІВ РОКУ Й ОДНОРАЗОВА: +6 міс. від якоря, одноразова — одна дата, закрита — не планується, оплата лишається", () => {
  assert.deepEqual([addPeriod("2026-11-01", "halfyear", 1), addPeriod("2026-08-31", "halfyear", 31)], ["2027-05-01", "2027-02-28"], "🔴 пів року");
  assert.deepEqual(occurrences("2026-11-01", "once", 1, "2026-01-01", "2028-12-31"), ["2026-11-01"], "🔴 одноразова повторюється");
  assert.deepEqual(occurrences("2026-11-01", "once", 1, "2026-12-01", "2027-12-31"), [], "🔴 одноразова поза вікном");
  const once = item({ id: 9, itemId: 109, name: "Ремонт", amount: 12000, period: "once", next: "2026-11-01" });
  const m = buildMonths([once], [], "2026-10-27");
  assert.deepEqual(m.filter((x) => x.events.length).map((x) => [x.ym, x.events.length, x.events[0].due]), [["2026-11", 1, true]], "🔴 одноразова не лише в своєму місяці");
  assert.deepEqual([planHintsOf([once], [], new Map(), "2026-11").length, planHintsOf([once], [], new Map(), "2026-12").length], [1, 0], "🔴 підказка одноразової не в своєму місяці");
  const closed = { ...once, active: false }, p = paid({ id: 5, recurringId: 9, due: "2026-11-01", amount: 12500, planned: 12000 });
  const mc = buildMonths([closed], [p], "2026-11-15");
  assert.deepEqual(mc.filter((x) => x.events.length).map((x) => x.events.map((e) => e.kind)), [["paid"]], "🔴 закрита одноразова й далі планується чи оплата зникла");
  assert.deepEqual([undoable(p, new Map([[9, closed]])), undoable(p, new Map([[9, once]]))], [true, false], "🔴 скасування одноразової");
});

/**
 * #1295b — ЖИВИЙ SQL: ОДНОРАЗОВА. «Оплачено» — та сама дата й закриття (`active = false`), повторно — 400 (закрита);
 * «Скасувати» — відкриває знову з тією самою датою; рядок оплати лишається «скасовано»; «пів року» зсуває на 6 міс.;
 * невідомий період — 400.
 * 🧨 Червоніє, якщо одноразова після оплати перескочить на наступну дату чи не закриється.
 */
test("#1295b ЖИВИЙ SQL: одноразова закривається оплатою й відкривається скасуванням, пів року — +6 міс., чужий період — 400", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { createRecurring, payRecurring, undoPaid } = await import("./finRecurring.js");
  const db = c as unknown as import("./finance.js").Db;
  const row = async (id: number) => (await c.query(`SELECT next_due::text AS d, active FROM fin_recurring WHERE id = $1`, [id])).rows[0];
  try {
    const { rent } = await seed(c);
    await assert.rejects(createRecurring(db, 50, { itemId: rent, amount: "100", period: "weekly", month: "2026-11" }), (e: any) => e?.status === 400, "🔴 чужий період пройшов");
    const once = await createRecurring(db, 50, { itemId: rent, amount: "12000", period: "once", month: "2026-11" });
    const p = await payRecurring(db, 8, once, { due: "2026-11-01", amount: "12500" });
    assert.deepEqual([p.next, await row(once)], ["2026-11-01", { d: "2026-11-01", active: false }], "🔴 одноразова не закрилась чи перескочила");
    await assert.rejects(payRecurring(db, 8, once, { due: "2026-11-01" }), (e: any) => e?.status === 400, "🔴 закриту одноразову оплачено вдруге");
    assert.equal((await undoPaid(db, 50, p.paidId)).next, "2026-11-01", "🔴 скасування змінило дату");
    assert.deepEqual(await row(once), { d: "2026-11-01", active: true }, "🔴 скасування не відкрило одноразову");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_recurring_paid WHERE recurring_id = $1 AND cancelled_at IS NOT NULL`, [once])).rows[0].n, 1, "🔴 скасована оплата зникла з історії");
    const half = await createRecurring(db, 50, { itemId: rent, amount: "6000", period: "halfyear", month: "2026-11" });
    assert.equal((await payRecurring(db, 8, half, { due: "2026-11-01" })).next, "2027-05-01", "🔴 пів року не +6 міс.");
  } finally { await s.dispose(); }
});
