import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { emptyPeriodSkip, needsBackendEnv } from "../testMode.js";
import { mirrorPlan } from "./legacyLimits.js";

/**
 * 🛑 ПРАВИЛА ЛІМІТІВ КЛІЄНТІВ (Роман 03.11.2026): призупинений ліміт справді зупиняє оплату перевізнику; змінився власник /
 * директор → ліміт зупиняється до переузгодження Сергієм; 3 місяці без угод (і без боргу) → ліміт скидається, потрібен
 * новий запит. Окремий файл: наскрізні гейти піднімають свою scratch-БД, а пул `db/pool.js` — один на процес.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

/**
 * Одна scratch-БД на файл: пул `db/pool.js` — один на процес і привʼязаний до першої адреси, тож кожен наскрізний гейт отримує
 * ту саму базу, очищену від попереднього. Немає бінарів PostgreSQL — `skip` з причиною через `skipReason`.
 */
let shared: Promise<{ c: import("pg").Client } | { skip: string }> | null = null;
async function scratchDb(): Promise<{ c: import("pg").Client } | { skip: string }> {
  shared ??= (async () => {
    const { provisionScratch } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return { skip: skipReason(scratch) };
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "test";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(SRC("db/schema.sql"));
    return { c };
  })();
  const s = await shared;
  if ("c" in s) await s.c.query(`TRUNCATE client_limits, client_limit_members, client_limit_events, cp_requests, cp_events, cp_checks, cl_court_seen,
    receivables, client_credit_limits, deals RESTART IDENTITY CASCADE`);
  return s;
}
after(async () => {
  const s = shared ? await shared : null;
  if (!s || !("c" in s)) return;
  await s.c.end().catch(() => undefined);
  const { pool } = await import("../db/pool.js");
  await pool.end().catch(() => undefined);
});

/**
 * #3372 — ДЗЕРКАЛО: призупинений ліміт = знятий, і сильніший за активний на тому самому ключі (у будь-якому порядку).
 * Дзеркальна половина: активний НЕ призупинений лишається з днями й сумою. 🧨 Червоніє, якщо дзеркало знову перестане
 * бачити призупинення (тоді «призупинено» — лише напис, а оплата перевізнику йде «у межах ліміту»), або якщо активний
 * ліміт перебʼє призупинений, або якщо зникне звичайний ліміт.
 */
test("#3372 ДЗЕРКАЛО: призупинений ліміт знімається з дебіторки й сильніший за активний; звичайний лишається", () => {
  const debtors = [{ key: "rivne", codes: ["41234567"] }, { key: "lviv", codes: [] }];
  const L = (o: Partial<Parameters<typeof mirrorPlan>[0][number]>) => ({ id: "1", debtorKey: null, active: true, limit: 300000, days: 30, from: "inv" as const, members: [], ...o });
  assert.deepEqual(mirrorPlan([L({ debtorKey: "lviv" })], debtors).get("lviv"), { days: 30, amount: 300000 }, "звичайний активний ліміт зник з дебіторки");
  assert.deepEqual(mirrorPlan([L({ debtorKey: "lviv", suspended: false })], debtors).get("lviv"), { days: 30, amount: 300000 }, "suspended:false зняв ліміт");
  const p = mirrorPlan([L({ debtorKey: "lviv", suspended: true })], debtors);
  assert.ok(p.has("lviv") && p.get("lviv") === null, "призупинений ліміт лишився в дебіторці — оплата перевізнику піде «у межах ліміту»");
  assert.equal(mirrorPlan([L({ members: [{ code: "41234567" }], suspended: true })], debtors).get("rivne"), null, "призупинення не дійшло до боржника за ЄДРПОУ");
  const both = [L({ id: "1", debtorKey: "lviv", suspended: true }), L({ id: "2", debtorKey: "lviv", days: 7 })];
  assert.equal(mirrorPlan(both, debtors).get("lviv"), null, "активний ліміт перебив призупинений");
  assert.equal(mirrorPlan([...both].reverse(), debtors).get("lviv"), null, "активний ліміт перебив призупинений (інший порядок)");
  assert.deepEqual(mirrorPlan([L({ id: "1", debtorKey: "lviv", active: false, suspended: true }), L({ id: "2", debtorKey: "lviv", days: 7 })], debtors).get("lviv"),
    { days: 7, amount: 300000 }, "ЗНЯТИЙ (не активний) ліміт з позначкою перебив чинний");
});

/**
 * #3372b — ДЗЕРКАЛО НАСКРІЗНО (scratch-БД): SQL дзеркала читає обидва види призупинення — позначку на ліміті (debt / set) і
 * запит, повернутий «На погодження» з позначкою (req). Після переузгодження (позначку знято / запит погоджено) ліміт
 * повертається в `client_credit_limits`. 🧨 Червоніє, якщо SQL не передасть `suspended` у план або пропустить один із видів.
 */
test("#3372b 🪞 ДЗЕРКАЛО НАСКРІЗНО: позначка й повернутий запит знімають ліміт з дебіторки, переузгодження — повертає", async (t) => {
  const db = await scratchDb();
  if ("skip" in db) return t.skip(db.skip);
  const { c } = db;
  {
    await c.query(`INSERT INTO receivables (client_key, client_name, amount) VALUES ('a', 'А', 1000), ('b', 'Б', 1000), ('c', 'В', 1000)`);
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note) VALUES ('b', 14, 50000, 'стара')`);
    await c.query(`INSERT INTO cp_requests (id, resident, code, name, kind, status, terms, flag, rates, created_by, created_by_name) VALUES
      (1, true, '41234567', 'В', 'ТОВ', 'pending', '{}', '{"what":"змінився власник"}', '{}', '2', 'Марина')`);
    await c.query(`INSERT INTO client_limits (id, src, request_id, debtor_key, name, limit_sum, days, count_from, manager_id, flag) VALUES
      (1, 'set', NULL, 'a', 'А', 100000, 10, 'inv', '2', NULL),
      (2, 'debt', NULL, 'b', 'Б', 50000, 14, 'inv', '2', '{"what":"нова справа"}'),
      (3, 'req', 1, 'c', 'В', 70000, 20, 'inv', '2', NULL)`);
    const { pool } = await import("../db/pool.js");
    const { mirrorToReceivables } = await import("./legacyLimits.js");
    const { receivablesDebtSource } = await import("./debtSourceDb.js");
    const debts = receivablesDebtSource(pool);
    const ccl = async () => Object.fromEntries((await c.query(`SELECT client_key, limit_days FROM client_credit_limits ORDER BY client_key`)).rows.map((r) => [r.client_key, r.limit_days]));

    await mirrorToReceivables(pool, debts);
    assert.deepEqual(await ccl(), { a: 10 }, "призупинений (позначка на ліміті / запит «На погодженні» з позначкою) лишився в дебіторці, або зник звичайний");
    await c.query(`UPDATE client_limits SET flag = NULL WHERE id = 2`);
    await c.query(`UPDATE cp_requests SET status = 'approved', flag = NULL WHERE id = 1`);
    await mirrorToReceivables(pool, debts);
    assert.deepEqual(await ccl(), { a: 10, b: 14, c: 20 }, "після переузгодження ліміт не повернувся в дебіторку");
  }
});

// ---------- фікстури перевірки ----------
type Subj = import("./shared/cpCheck.js").CheckSubject;
type Own = NonNullable<Subj["own"]>;
const person = (name: string, share: number | null = 50) => ({ name, code: null, kind: "person" as const, share, ben: false, companies: null });
const own = (o: Partial<Own> = {}): Own => ({
  capital: 1000, owners: [person("Іваненко Іван"), person("Петренко Петро")], bens: [], benNote: "",
  director: { name: "Іваненко Іван", since: "2020-01-01" }, ownersAt: null, ownersWhat: "", dirAt: null, dirWhat: "", peopleAt: null, ...o,
});
const subj = (o: Own | null, extra: Partial<Subj> = {}): Subj => ({
  code: "11111111", kind: "ТОВ", name: "ТОВ Тест", reg: "2015-01-01", head: "Іваненко Іван", addr: "", fop: false, state: "зареєстровано", own: o,
  yc: { cases: [], other: 0, enf: 0, express: [], index: null, checkedAt: "2026-11-03T06:00:00Z", archived: false }, ...extra,
});

/**
 * #3370 — ХТО «ЗМІНИВСЯ» (Роман 03.11.2026): з попередньою перевіркою — новий / зниклий засновник, бенефіціар чи інший
 * директор; зміна частки в тих самих людей — НЕ зміна; порожній список власників у свіжій перевірці — «не віддали», а не «всі
 * вийшли»; ФОП — ніколи. Перша перевірка — лише якщо дата зміни ЛЮДЕЙ (не часток) / директора пізніша за дату ліміту.
 * 🧨 Червоніє, якщо зміна частки почне зупиняти ліміт, якщо новий засновник / бенефіціар / директор не помітиться, або якщо
 * перша перевірка зупинить ліміт за зміною, з якою Сергій уже погоджував.
 */
test("#3370 ВЛАСНИК / ДИРЕКТОР: нова чи зникла людина або інший директор — зміна; частка, порожня відповідь, ФОП — ні", async () => {
  const { peopleChange } = await import("./limitRules.js");
  const prev = subj(own());
  const AT = "2026-06-01T00:00:00Z";
  assert.equal(peopleChange(prev, subj(own()), AT), null, "без змін — зміна");
  assert.equal(peopleChange(prev, subj(own({ owners: [person("Іваненко Іван", 70), person("Петренко Петро", 30)] })), AT), null, "зміна частки зупиняє ліміт");
  assert.match(peopleChange(prev, subj(own({ owners: [person("Іваненко Іван"), person("Петренко Петро"), person("Сидоренко Сидір", 10)] })), AT) ?? "",
    /власники: увійшов Сидоренко Сидір/, "новий засновник не помічений");
  assert.match(peopleChange(prev, subj(own({ owners: [person("Іваненко Іван", 100)] })), AT) ?? "", /власники: вийшов Петренко Петро/, "зниклий засновник не помічений");
  assert.match(peopleChange(prev, subj(own({ bens: ["Коваль Ольга"] })), AT) ?? "", /бенефіціари: увійшов Коваль Ольга/, "новий бенефіціар не помічений");
  assert.match(peopleChange(prev, subj(own({ director: { name: "Петренко Петро", since: "2026-10-01" } })), AT) ?? "", /директор: Іваненко Іван → Петренко Петро/, "новий директор не помічений");
  assert.equal(peopleChange(prev, subj(own({ director: { name: "іваненко іван ", since: null } })), AT), null, "регістр і пробіл у імені директора — зміна");
  assert.equal(peopleChange(prev, subj(own({ owners: [] })), AT), null, "YouScore не віддав власників — «усі вийшли»");
  assert.equal(peopleChange(subj(null, { fop: true }), subj(null, { fop: true }), AT), null, "ФОП — зміна");
  // перша перевірка коду (попередньої немає)
  assert.equal(peopleChange(null, subj(own()), AT), null);
  assert.match(peopleChange(null, subj(own({ peopleAt: "2026-07-01", ownersWhat: "увійшов Сидоренко Сидір" })), AT) ?? "", /власники: увійшов Сидоренко Сидір/, "нові люди після ліміту не помічені");
  assert.equal(peopleChange(null, subj(own({ peopleAt: "2026-05-01", ownersWhat: "увійшов Сидоренко Сидір" })), AT), null, "зміна ДО погодження ліміту зупиняє його");
  assert.equal(peopleChange(null, subj(own({ ownersAt: "2026-07-01", ownersWhat: "змінено частку Іваненко Іван" })), AT), null, "перша перевірка: зміна частки зупиняє ліміт");
  assert.match(peopleChange(null, subj(own({ dirAt: "2026-07-01", dirWhat: "Іваненко Іван → Петренко Петро" })), AT) ?? "", /директор: Іваненко Іван → Петренко Петро/);
  assert.equal(peopleChange(null, subj(own({ dirAt: "2026-05-01", dirWhat: "Іваненко Іван → Петренко Петро" })), AT), null, "директор, змінений ДО ліміту, зупиняє його");
});

/**
 * #3371 — ЗМІНА ЛЮДЕЙ → ПРИЗУПИНЕННЯ НАСКРІЗНО (scratch-БД, `afterCheck`): новий засновник у заданому ліміті → позначка kind
 * 'people' + подія; новий директор у ліміті з запиту → запит «На погодження» з позначкою + подія запиту; зміна частки → лише
 * «зміни в YouControl», ліміт діє. Призупинені зникають з дебіторки (дзеркало #3372), звичайний лишається.
 * 🧨 Червоніє, якщо зміна людей перестане зупиняти ліміт, якщо зупинить його зміна частки, або якщо призупинення не дійде до дзеркала.
 */
test("#3371 🪞 ЗМІНА ЛЮДЕЙ НАСКРІЗНО: новий засновник / директор зупиняють ліміт до Сергія, зміна частки — лише позначка", async (t) => {
  const db = await scratchDb();
  if ("skip" in db) return t.skip(db.skip);
  const { c } = db;
  {
    await c.query(`INSERT INTO receivables (client_key, client_name, amount) VALUES ('a', 'А', 1000), ('b', 'Б', 1000), ('c', 'В', 1000)`);
    await c.query(`INSERT INTO cp_requests (id, resident, code, name, kind, status, terms, rates, created_by, created_by_name) VALUES
      (1, true, '33333333', 'В', 'ТОВ', 'approved', '{}', '{}', '2', 'Марина')`);
    await c.query(`INSERT INTO client_limits (id, src, request_id, debtor_key, name, limit_sum, days, count_from, manager_id, at) VALUES
      (1, 'set', NULL, 'a', 'А', 100000, 10, 'inv', '2', '2026-06-01'), (2, 'debt', NULL, 'b', 'Б', 50000, 14, 'inv', '2', '2026-06-01'),
      (3, 'req', 1, 'c', 'В', 70000, 20, 'inv', '2', '2026-06-01')`);
    await c.query(`INSERT INTO client_limit_members (limit_id, code, name) VALUES (1, '11111111', 'А'), (2, '22222222', 'Б'), (3, '33333333', 'В')`);
    const { pool } = await import("../db/pool.js");
    const { afterCheck } = await import("./server/limitFindings.js");
    const { mirrorToReceivables } = await import("./legacyLimits.js");
    const { receivablesDebtSource } = await import("./debtSourceDb.js");
    const now = new Date("2026-11-03T06:15:00Z");
    const check = async (code: string, s: Subj, src: "planned" | "tool") => {
      const id = String((await c.query(`INSERT INTO cp_checks (code, src, status, subj, done_at) VALUES ($1, $2, 'done', $3, now()) RETURNING id`, [code, src, JSON.stringify(s)])).rows[0].id);
      return { id, code, at: now.toISOString(), by: null, byName: null, src, status: "done" as const, error: null, tx: 4, pdf: false, base: null, subj: s };
    };
    const run = async (code: string, before: Own, after: Own) => {
      const p = await check(code, subj(before, { code }), "tool");
      return afterCheck(pool, await check(code, subj(after, { code }), "planned"), p, now);
    };
    assert.equal((await run("11111111", own(), own({ owners: [...own().owners, person("Сидоренко Сидір", 10)] }))).flagged, 1, "новий засновник не зупинив ліміт");
    assert.equal((await run("22222222", own(), own({ owners: [person("Іваненко Іван", 70), person("Петренко Петро", 30)], ownersAt: "2026-11-03", ownersWhat: "змінено частку Іваненко Іван: 50 → 70 %" }))).flagged, 0, "зміна частки зупинила ліміт");
    assert.equal((await run("33333333", own(), own({ director: { name: "Петренко Петро", since: "2026-10-01" } }))).flagged, 1, "новий директор не зупинив ліміт із запиту");

    const lim = Object.fromEntries((await c.query(`SELECT id, flag, notice FROM client_limits ORDER BY id`)).rows.map((r) => [r.id, r]));
    assert.equal(lim[1].flag?.kind, "people", "позначка без виду — на екрані буде «нова справа в суді»");
    assert.match(lim[1].flag?.what ?? "", /Сидоренко Сидір/);
    assert.equal(lim[2].flag, null, "зміна частки поставила позначку");
    assert.match(lim[2].notice?.what ?? "", /частк/, "зміна частки не дійшла навіть до «зміни в YouControl»");
    const req = (await c.query(`SELECT status, flag FROM cp_requests WHERE id = 1`)).rows[0];
    assert.deepEqual([req.status, req.flag?.kind], ["pending", "people"], "запит не повернувся Сергію з позначкою «змінився власник / директор»");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM cp_events WHERE request_id = 1 AND type = 'suspended'`)).rows[0].n, 1, "у запиті немає події призупинення");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM client_limit_events WHERE limit_id = 1 AND type = 'limSuspended'`)).rows[0].n, 1, "у ліміті немає події призупинення");
    assert.equal((await run("11111111", own(), own({ owners: [...own().owners, person("Ще Один", 5)] }))).flagged, 0, "уже призупинений призупинився вдруге");

    await mirrorToReceivables(pool, receivablesDebtSource(pool));
    const ccl = (await c.query(`SELECT client_key FROM client_credit_limits ORDER BY client_key`)).rows.map((r) => r.client_key);
    assert.deepEqual(ccl, ["b"], "призупинені лишились у дебіторці, або зник ліміт зі зміною частки");
  }
});

/**
 * #3373 — КОГО СКИДАТИ (Роман 03.11.2026): 3 календарні місяці без угод (від останньої непрограної; немає — від дати ліміту),
 * боргу немає, клієнта зіставлено з CRM. Межа — день: 3 міс. і 1 день тому — скидаємо, рівно 3 міс. — ні. 31-ше число не
 * переповнюється в наступний місяць. 🧨 Червоніє, якщо скинеться клієнт з боргом, незіставлений, свіжий — або не скинеться
 * старий без боргу.
 */
test("#3373 КОГО СКИДАТИ: 3 міс. без угод і без боргу; борг, свіжа угода, незіставлений — лишаються; межа — день", async () => {
  const { resetDue, monthsAgo } = await import("./limitRules.js");
  const now = new Date("2026-11-03T06:30:00Z");
  const X = { matched: true, lastDealAt: "2026-08-02T10:00:00Z", limitAt: "2026-01-01T00:00:00Z", debt: 0 };
  assert.equal(resetDue(X, now), true, "3 міс. і день без угод — не скинуто");
  assert.equal(resetDue({ ...X, lastDealAt: "2026-08-04T10:00:00Z" }, now), false, "угода 3 міс. мінус день тому — скинуто");
  assert.equal(resetDue({ ...X, debt: 1 }, now), false, "скинуто клієнта з боргом");
  assert.equal(resetDue({ ...X, matched: false }, now), false, "скинуто незіставленого з CRM");
  assert.equal(resetDue({ ...X, lastDealAt: null }, now), true, "угод немає, ліміт старий — не скинуто");
  assert.equal(resetDue({ ...X, lastDealAt: null, limitAt: "2026-10-01T00:00:00Z" }, now), false, "угод немає, ліміт свіжий — скинуто");
  assert.equal(monthsAgo(new Date("2026-05-31T12:00:00Z"), 3).toISOString(), "2026-02-28T12:00:00.000Z", "31-ше переповнилось у наступний місяць");
  assert.equal(monthsAgo(new Date("2027-01-15T00:00:00Z"), 3).toISOString(), "2026-10-15T00:00:00.000Z", "перехід через рік");
});

/**
 * #3373b — СКИДАННЯ НАСКРІЗНО (scratch-БД, `resetInactiveLimits`): старий без боргу (заданий) і старий із запиту — скинуто
 * (запит повертається менеджеру, подія з причиною й старими умовами); з боргом, зі свіжою угодою, незіставлений (угод немає) —
 * лишаються; програна угода не рахується «останньою»; скинуті — у «Скинуто» і зникають з дебіторки; новий діючий ліміт на ту
 * саму юрособу прибирає рядок зі «Скинуто». Порожня дебіторка — СТОП, а не «боргу ні в кого».
 * 🧨 Червоніє на кожному з цих відступів.
 */
test("#3373b 🪞 СКИДАННЯ НАСКРІЗНО: 3 міс. без угод → новий запит; борг, свіжа угода, незіставлений — лишаються", async (t) => {
  const db = await scratchDb();
  if ("skip" in db) return t.skip(db.skip);
  const { c } = db;
  {
    const now = new Date("2026-11-03T06:30:00Z");
    // 1 старий без боргу · 2 старий з боргом · 3 свіжа угода · 4 незіставлений · 5 старий із запиту · 6 остання непрограна стара, програна свіжа
    await c.query(`INSERT INTO deals (kommo_id, client_key, client_name, status_id, created_at_kommo) VALUES
      (101, 'a', 'А', 142, '2026-07-01T12:00Z'), (102, 'b', 'Б', 142, '2026-06-01T12:00Z'), (103, 'c', 'В', 142, '2026-09-20T12:00Z'),
      (105, 'e', 'Д', 142, '2026-05-01T12:00Z'), (106, 'f', 'Е', 142, '2026-06-01T12:00Z'), (107, 'f', 'Е', 143, '2026-10-20T12:00Z')`);
    await c.query(`INSERT INTO receivables (client_key, client_name, amount) VALUES ('b', 'Б', 5000), ('zz', 'Інший боржник', 1)`);
    await c.query(`INSERT INTO cp_requests (id, resident, code, name, kind, status, terms, rates, created_by, created_by_name) VALUES
      (1, true, '55555555', 'Д', 'ТОВ', 'approved', '{}', '{}', '2', 'Марина')`);
    await c.query(`INSERT INTO client_limits (id, src, request_id, debtor_key, name, limit_sum, days, count_from, manager_id, at) VALUES
      (1, 'set', NULL, 'a', 'А', 100000, 10, 'inv', '2', '2026-03-01'), (2, 'debt', NULL, 'b', 'Б', 50000, 14, 'inv', '2', '2026-03-01'),
      (3, 'set', NULL, 'c', 'В', 70000, 20, 'inv', '2', '2026-03-01'), (4, 'debt', NULL, 'nodeals', 'Г', 30000, 7, 'inv', '2', '2026-03-01'),
      (5, 'req', 1, 'e', 'Д', 90000, 30, 'orig', '2', '2026-03-01'), (6, 'set', NULL, 'f', 'Е', 40000, 5, 'inv', '2', '2026-03-01')`);
    await c.query(`INSERT INTO client_limit_members (limit_id, code, name) VALUES (1, '11111111', 'А'), (5, '55555555', 'Д')`);
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note) VALUES ('a', 10, 100000, 'x'), ('e', 40, 90000, 'x')`);
    const { pool } = await import("../db/pool.js");
    const { resetInactiveLimits, listResetLimits } = await import("./limitRulesDb.js");
    const { receivablesDebtSource } = await import("./debtSourceDb.js");
    const { staticDebtSource } = await import("./server/debtSource.js");
    const { mirrorToReceivables } = await import("./legacyLimits.js");
    const debts = receivablesDebtSource(pool);

    await assert.rejects(resetInactiveLimits(pool, staticDebtSource(now.toISOString(), []), now), /дебіторка порожня/, "порожня дебіторка не зупинила скидання");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM client_limits WHERE NOT active`)).rows[0].n, 0, "порожня дебіторка все одно щось скинула");

    const r = await resetInactiveLimits(pool, debts, now);
    assert.deepEqual(r.reset.sort(), ["1", "5", "6"], "скинуто не тих: борг / свіжа угода / незіставлений мусять лишитись, програна угода — не «остання»");
    const ev = (await c.query(`SELECT note, data FROM client_limit_events WHERE limit_id = 1 AND type = 'ended'`)).rows[0];
    assert.equal(ev?.data?.reason, "inactive", "у події скидання немає причини — «Скинуто» її не знайде");
    assert.match(ev.note, /3 місяці без угод.*01\.07\.2026.*100\s000 грн, 10 дн\./s, "у підписі немає дати останньої угоди чи старих умов");
    const req = (await c.query(`SELECT status FROM cp_requests WHERE id = 1`)).rows[0];
    assert.equal(req.status, "returned", "запит не повернувся менеджеру — новий на той самий код подати не можна");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM cp_events WHERE request_id = 1 AND type = 'returned'`)).rows[0].n, 1);
    assert.deepEqual((await resetInactiveLimits(pool, debts, now)).reset, [], "повторний прохід скинув ще раз");

    let list = await listResetLimits(pool);
    assert.deepEqual(list.map((x) => x.id).sort(), ["1", "5", "6"]);
    const one = list.find((x) => x.id === "1")!;
    assert.deepEqual([one.limit, one.days, one.from, one.lastDealAt?.slice(0, 10)], [100000, 10, "inv", "2026-07-01"], "у «Скинуто» немає старих умов для підказки");
    await mirrorToReceivables(pool, debts);
    assert.deepEqual((await c.query(`SELECT client_key FROM client_credit_limits ORDER BY client_key`)).rows.map((x) => x.client_key), ["b", "c", "nodeals"],
      "скинутий ліміт (a, e) лишився в дебіторці, або зник чинний (b, c, nodeals)");
    await c.query(`INSERT INTO client_limits (id, src, name, limit_sum, days, count_from, manager_id) VALUES (7, 'set', 'А новий', 80000, 7, 'inv', '2')`);
    await c.query(`INSERT INTO client_limit_members (limit_id, code, name) VALUES (7, '11111111', 'А')`);
    list = await listResetLimits(pool);
    assert.deepEqual(list.map((x) => x.id).sort(), ["5", "6"], "новий ліміт на ту саму юрособу не прибрав рядок зі «Скинуто»");
  }
});

/**
 * #3374 — ЖИВА БД (лише читання): кого скинула б функція (`crmOfLimits` + борг з дебіторки через `matches` + `resetDue`) ==
 * незалежний SQL (ключі — ключ боржника й ЄДРПОУ юросіб напряму, борг — сума рядків дебіторки з валютою, межа — `interval
 * '3 months'` Postgres). Дзеркало: діючих лімітів не нуль (інакше рівність порожніх множин нічого не доводить) і хоч один ліміт
 * зіставлено з CRM. 🧨 Червоніє, якщо функція й SQL розійдуться в зіставленні, боргу чи межі — тобто екран «Скинуто» почне
 * показувати не тих, кого видно в даних.
 */
test("#3374 ЖИВА БД: кандидати на скидання за функцією == незалежний SQL; діючі ліміти є і зіставлені", needsBackendEnv(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { listLimits } = await import("./server/limitsStore.js");
  const { receivablesDebtSource } = await import("./debtSourceDb.js");
  const { crmOfLimits } = await import("./limitRulesDb.js");
  const { resetDue } = await import("./limitRules.js");
  const { matches } = await import("./shared/clientLimits.js");
  const { FX_UAH_SQL } = await import("../core/receivablesFxSql.js");
  const now = new Date();
  const limits = await listLimits(pool, now);
  const skip = emptyPeriodSkip("діючих лімітів клієнтів", limits.length, "зараз");
  if (skip) return t.skip(skip);
  const d = await receivablesDebtSource(pool).debtors();
  const crm = await crmOfLimits(pool, limits, d.list);
  assert.ok([...crm.values()].some((x) => x.matched), "жоден ліміт не зіставлено з CRM — функція осліпла, рівність нічого не доведе");
  const byFn = limits.filter((l) => resetDue({ ...(crm.get(l.id) ?? { matched: false, lastDealAt: null }), limitAt: l.at,
    debt: d.list.filter((x) => matches(l, x)).reduce((a, x) => a + x.debt, 0) }, now)).map((l) => l.id).sort();
  const bySql = (await pool.query<{ id: string }>(`
    WITH lim AS (SELECT l.id, l.at, l.debtor_key FROM client_limits l WHERE l.active),
    keys AS (
      SELECT id, debtor_key AS key FROM lim WHERE debtor_key IS NOT NULL
      UNION SELECT l.id, d.client_key FROM lim l JOIN client_limit_members m ON m.limit_id = l.id
         JOIN kommo_companies kc ON (kc.edrpou = m.code OR kc.ipn = m.code)
         JOIN deal_companies dc ON dc.company_id = kc.company_id JOIN deals d ON d.kommo_id = dc.deal_kommo_id
      UNION SELECT l.id, ri.client_key FROM lim l JOIN client_limit_members m ON m.limit_id = l.id JOIN receivable_invoices ri ON ri.edrpou = m.code),
    k AS (SELECT DISTINCT id, key FROM keys WHERE key IS NOT NULL AND key NOT IN ('названиенеуказано', 'companynamenotspecified', ''))
    SELECT l.id::text FROM lim l
     WHERE EXISTS (SELECT 1 FROM deals d JOIN k ON k.key = d.client_key WHERE k.id = l.id)
       AND COALESCE((SELECT sum(r.amount + ${FX_UAH_SQL("r")}) FROM receivables r WHERE r.client_key IN (SELECT key FROM k WHERE k.id = l.id)
                       AND r.amount + ${FX_UAH_SQL("r")} > 0), 0) <= 0
       AND COALESCE((SELECT max(d.created_at_kommo) FROM deals d JOIN k ON k.key = d.client_key WHERE k.id = l.id AND d.status_id <> 143), l.at)
           < now() - interval '3 months'
     ORDER BY 1`)).rows.map((r) => r.id).sort();
  assert.deepEqual(byFn, bySql, `🔴 функція скинула б ${JSON.stringify(byFn)}, а дані кажуть ${JSON.stringify(bySql)} (діючих лімітів ${String(limits.length)})`);
});

/**
 * #3375 — ПРОВОДКА СКИДАННЯ: джоба в розкладі незалежно від CP_BACKGROUND_CHECKS (транзакцій не витрачає), під наглядом із
 * частотою свого крону (раз на добу, за Києвом). 🧨 Червоніє, якщо джобу сховати під перемикач перевірок, зняти з нагляду чи
 * розвести частоти.
 */
test("#3375 ПРОВОДКА СКИДАННЯ: щодня за Києвом, поза перемикачем перевірок, під наглядом із частотою крону", async () => {
  const src = SRC("index.ts");
  const call = src.indexOf('runJob("clientLimitsReset", () => clientLimitsReset())');
  assert.ok(call > 0, "🔴 скидання не запускається з крону");
  const gate = src.indexOf("if (CP_BACKGROUND_ON())");
  assert.ok(gate > 0 && call < gate, "🔴 скидання опинилось під перемикачем фонових перевірок — без них воно не працюватиме");
  const tail = src.slice(call, call + 200);
  assert.match(tail, /timezone: "Europe\/Kyiv"/, "🔴 крон скидання не за Києвом");
  const spec = [...src.slice(0, call).matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  assert.equal(spec, "30 6 * * *", "🔴 крон скидання не той");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  const row = MONITORED_JOBS.find((j) => j.name === "clientLimitsReset");
  assert.ok(row, "🔴 скидання не під наглядом — його мовчання ніхто не побачить");
  assert.equal(row.everyMin, 1440, "🔴 нагляд чекає не раз на добу");
  assert.match(SRC("jobs/counterpartyJobs.ts"), /resetInactiveLimits\(pool, debts\)/, "🔴 джоба не кличе спільне скидання");
});
