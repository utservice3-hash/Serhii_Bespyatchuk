import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { inOwnWorkListsSql } from "../core/managerState.js";
import { activeManagerSql } from "../core/activeManager.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");

/**
 * #3420 🪞 — РОСТЕР 1×1 БЕЗ ЗВІЛЬНЕНИХ (задача 8249), предикат на порожньому кластері.
 * Обидва боки межі: звільнений накладкою адміна, але активний у Kommo (Шевчук Назар) — НІ; вимкнений у Kommo — НІ;
 * «завершує» — ТАК (ще працює); звичайний — ТАК; без логіна — ТАК (логіна не заводили — не звільнення).
 * Червоніє, якщо предикат знову дивиться лише на Kommo, або почне прибирати «завершує».
 */
test("#3420 🪞 1×1 · РОСТЕР: звільнений у дашборді (хоч активний у Kommo) — ні; «завершує» й звичайний — так", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Яцик Team lead') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Звичайний',5,true),(2,'Звільнений, активний у Kommo',5,true),(3,'Завершує',5,true),(4,'Вимкнений у Kommo',5,false),(5,'Без логіна',5,true)`);
    await c.query(`INSERT INTO users(id,email,password_hash,role,manager_id,team_id,is_active) VALUES
      (11,'a@uts.ua','x','manager',1,5,true),(12,'b@uts.ua','x','manager',2,5,true),(13,'c@uts.ua','x','manager',3,5,true),(14,'d@uts.ua','x','manager',4,5,true)`);
    await c.query(`INSERT INTO manager_work_state(manager_id,state,since) VALUES (2,'dismissed','2026-09-08'),(3,'finishing','2026-11-01')`);
    const ids = (await c.query<{ id: number }>(
      `SELECT m.id FROM managers m WHERE ${inOwnWorkListsSql("m", activeManagerSql("m"))} ORDER BY m.id`)).rows.map((r) => r.id);
    assert.deepEqual(ids, [1, 3, 5], "🔴 ростер 1×1: звільнений або вимкнений лишився, чи зник «завершує» / людина без логіна");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #3420b — ПРОВОДКА: «кого можна провести» в 1×1 (список, запис, задачі) бере ростер Найму зі станом дашборду, а не
 * голий Kommo-прапорець. Червоніє, якщо в `conductSubjects` повернеться `m.is_active` або скоуп піде повз ростер,
 * або ростер перестане відсіювати звільнених накладкою дашборду.
 */
test("#3420b 1×1 · ПРОВОДКА: скоуп «провести» — за станом менеджера, не за голим Kommo-прапорцем", () => {
  const src = SRC("routes/oneOnOnes.ts");
  const fn = src.slice(src.indexOf("async function conductSubjects"), src.indexOf("/** WHERE-фрагмент для VIEW-скоупу"));
  assert.ok(fn.length > 0, "🔴 conductSubjects не знайдено");
  assert.doesNotMatch(fn, /m\.is_active/, "🔴 скоуп 1×1 знову дивиться лише на Kommo — звільнені повернуться в ростер");
  // 19.11.2026: люди 1×1 — з Найму (`oneOnOne/roster.ts`), стан менеджера в дашборді — другий запобіжник у ростері.
  assert.match(fn, /const roster = await rosterFor\(type\);/, "🔴 скоуп 1×1 не бере ростер");
  // Запис, задача, відкриті задачі й рев'ю беруть субʼєкта ЛИШЕ зі скоупу: кожен із чотирьох входів.
  assert.equal((src.match(/\(await conductSubjects\(auth, type\)\)\.get\(subjectId\)/g) ?? []).length, 2,
    "🔴 запис або `taskSubject` бере субʼєкта повз скоуп");
  assert.equal((src.match(/await taskSubject\(/g) ?? []).length, 3, "🔴 задача, відкриті задачі чи рев'ю — повз скоуп");
  const roster = SRC("oneOnOne/roster.ts");
  assert.match(roster, /export const DASHBOARD_DISMISSED = `EXISTS \(SELECT 1 FROM manager_work_state w WHERE w\.manager_id = m\.id AND w\.state = 'dismissed'\)`/,
    "🔴 стан «звільнений» дашборду — не той");
  assert.match(roster, /\(m\.id IS NOT NULL AND \$\{DASHBOARD_DISMISSED\}\) AS dismissed/, "🔴 ростер 1×1 не дивиться на стан менеджера");
  assert.match(roster, /if \(r\.dismissed\) continue;/, "🔴 звільнений накладкою дашборду лишається в ростері");
});

/**
 * #9994 🪞 — ХТО В ЯКОМУ ТИПІ 1×1, ЗА КАТЕГОРІЄЮ В НАЙМ (Сергій 19.11.2026; Роман: лідоген — у «A», тім-лід лідогену — у «Б»).
 * Обидва боки межі: бухгалтер, фінансист, директор — НЕ в «Тімлід→Менеджер»; менеджер продажу й лідогенератор — у ньому;
 * тім-лід — лише в «КВП→Тімлід»; у «HR→Всі» — усі. Без пари в Kommo — ЗВИЧАЙНИЙ рядок (записи на картці Найму), а задача
 * йде на активний акаунт; без акаунта (чи з вимкненим) задачу поставити нікому. Звільнений накладкою — немає ніде.
 * Червоніє, якщо правило категорій пустить у «A» не-продажника, загубить людину без Kommo, або задачу поведе на
 * вимкнений акаунт / на акаунт поруч із Kommo.
 */
test("#9994 🪞 1×1 · ХТО В ТИПІ: «A» — менеджери й лідоген, «Б» — тім-ліди, «В» — усі; без Kommo — звичайний рядок", async () => {
  const { rosterOf, o2oTypesOf, canTakeTask } = await import("../oneOnOne/roster.js");
  const row = (employee_id: number, full_name: string, position: string | null, manager_id: number | null,
    o: { category?: string | null; user_id?: number | null; account_active?: boolean; dismissed?: boolean } = {}) => ({
    employee_id, full_name, position, manager_id, category: o.category ?? null, status: "active",
    user_id: o.user_id ?? null, account_active: o.account_active ?? o.user_id != null,
    team_id: 5, team_name: "Команда", dismissed: o.dismissed ?? false });
  const rows = [
    row(1, "Менеджер Продажу", "Менеджер з продажу", 101, { user_id: 201 }),
    row(2, "Лідоген Перший", "Лідогенератор", 102),
    row(3, "Тім Лід", "Тімлід", 103),
    row(4, "Бухгалтер Одна", "Бухгалтер", 104),
    row(5, "Фінансист Один", "Фінансист", 105),
    row(6, "Директор Операційний", "Операційний директор", 106),
    row(7, "Ручна Категорія", "Бухгалтер", 107, { category: "manager" }),
    row(8, "Без Kommo Менеджер", "Менеджер з продажу", null, { user_id: 208 }),
    row(9, "Без Kommo Бухгалтер", "Бухгалтер", null),
    row(10, "Звільнений Накладкою", "Менеджер з продажу", 110, { dismissed: true }),
    row(11, "Акаунт Вимкнено", "Бухгалтер", null, { user_id: 211, account_active: false }),
  ];
  const ids = (t: "A" | "B" | "V") => rosterOf(rows, t).map((s) => s.employeeId);
  assert.deepEqual(ids("A"), [1, 2, 7, 8], "🔴 «Тімлід→Менеджер»: не-продажник пройшов, менеджер/лідоген чи людина без Kommo загубились");
  assert.deepEqual(ids("B"), [3], "🔴 «КВП→Тімлід» — лише тім-ліди");
  assert.deepEqual(ids("V"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11], "🔴 «HR→Всі» — усі працюючі, і без Kommo теж; звільненого накладкою немає");
  const v = new Map(rosterOf(rows, "V").map((s) => [s.employeeId, s]));
  assert.equal(v.get(1)?.fullName, "Менеджер Продажу", "🔴 ім'я — з Найму");
  assert.deepEqual([1, 8, 9, 11].map((id) => [v.get(id)?.managerId, v.get(id)?.taskUserId, canTakeTask(v.get(id)!)]),
    [[101, null, true], [null, 208, true], [null, null, false], [null, null, false]],
    "🔴 задача: з Kommo — менеджеру (не акаунту), без Kommo — на активний акаунт, без акаунта чи з вимкненим — нікому");
  assert.deepEqual(o2oTypesOf(null), ["V"], "🔴 без категорії — лише «HR→Всі», не вгадуємо");
});

/**
 * #9995 🪞 — РОСТЕР 1×1 НА СПРАВЖНІЙ СХЕМІ: `ROSTER_SQL` + `rosterOf` (19.11.2026).
 * Звільнений у Найм, хоч активний у Kommo, — НІ; працюючий у Найм — ТАК (напряму й через акаунт), і вимкнений у Kommo
 * теж (працює людина чи ні, каже Найм); «завершує» — ТАК; без Kommo — ТАК, з командою з картки й акаунтом під задачу;
 * звільнений накладкою дашборду — НІ (другий запобіжник `#3420`).
 * Червоніє, якщо ростер знову візьме людей з Kommo, загубить зв'язок через акаунт, «завершує» або людину без Kommo.
 */
test("#9995 🪞 1×1 · РОСТЕР З НАЙМУ: звільнений у Найм (хоч активний у Kommo) — ні; працюючий — так, і через акаунт", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const { ROSTER_SQL, rosterOf } = await import("../oneOnOne/roster.js");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Яцик Team lead'),(6,'Бек-офіс') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Kommo Один',5,true),(2,'Kommo Два',5,true),(3,'Kommo Три',5,true),(4,'Kommo Чотири',5,true),(5,'Kommo Пʼять',5,true),
      (6,'Kommo Вимкнений',5,false)`);
    await c.query(`INSERT INTO users(id,email,password_hash,role,manager_id,team_id,is_active) VALUES
      (12,'b@uts.ua','x','manager',2,5,true),(16,'f@uts.ua','x','manager',NULL,NULL,true)`);
    await c.query(`INSERT INTO manager_work_state(manager_id,state,since) VALUES (5,'dismissed','2026-11-01')`);
    await c.query(`INSERT INTO employees(id,full_name,import_key,position,status,manager_id,user_id,team_id) VALUES
      (21,'Працює Напряму','k21','Менеджер з продажу','active',1,NULL,NULL),
      (22,'Працює Через Акаунт','k22','Менеджер з продажу','active',NULL,12,NULL),
      (23,'Завершує Роботу','k23','Менеджер з продажу','finishing',3,NULL,NULL),
      (24,'Звільнений У Наймі','k24','Менеджер з продажу','dismissed',4,NULL,NULL),
      (25,'Звільнений Накладкою','k25','Менеджер з продажу','active',5,NULL,NULL),
      (26,'Без Kommo','k26','Бухгалтер','active',NULL,16,6),
      (27,'Вимкнений У Kommo','k27','Менеджер з продажу','active',6,NULL,NULL)`);
    const rows = (await c.query(ROSTER_SQL)).rows;
    assert.deepEqual(rosterOf(rows, "A").map((s) => `${s.employeeId}:${s.managerId}:${s.fullName}`),
      ["21:1:Працює Напряму", "22:2:Працює Через Акаунт", "23:3:Завершує Роботу", "27:6:Вимкнений У Kommo"],
      "🔴 ростер 1×1: звільнений у Найм чи накладкою лишився, або загубився працюючий (через акаунт, «завершує», вимкнений у Kommo)");
    const noKommo = rosterOf(rows, "V").find((s) => s.employeeId === 26);
    assert.deepEqual(noKommo && [noKommo.managerId, noKommo.taskUserId, noKommo.teamId, noKommo.teamName],
      [null, 16, 6, "Бек-офіс"], "🔴 людина без Kommo: немає в ростері, або без команди з картки, або без акаунта під задачу");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/** Повернути таблицю 1×1 у стан ДО 19.11.2026: ключ на менеджері Kommo, колонка картки ще порожня. */
const OLD_KEY_SQL = `ALTER TABLE one_on_ones DROP CONSTRAINT one_on_ones_pkey;
  ALTER TABLE one_on_ones ALTER COLUMN subject_employee_id DROP NOT NULL;
  ALTER TABLE one_on_ones ALTER COLUMN subject_manager_id SET NOT NULL;
  ALTER TABLE one_on_ones ADD PRIMARY KEY (subject_manager_id, type, meeting_date);`;
const PK_SQL = `SELECT string_agg(a.attname, ',' ORDER BY array_position(c.conkey, a.attnum)) AS cols
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
 WHERE c.conrelid = 'one_on_ones'::regclass AND c.contype = 'p'`;

/**
 * #9996 🪞 — ПЕРЕНОС ЗАПИСІВ 1×1 НА КАРТКУ НАЙМУ (міграція в `schema.sql`, 19.11.2026), на справжній схемі.
 * Обидва боки межі: менеджер із рівно однією карткою (напряму чи через акаунт) — запис і задача переїжджають, ключ стає
 * `(subject_employee_id, type, meeting_date)`, повторний прогін нічого не ламає; менеджер із ДВОМА картками чи БЕЗ
 * картки — міграція зупиняється й називає його, а не вгадує.
 * Червоніє, якщо перенос загубить зв'язок через акаунт, не поміняє ключ, або мовчки візьме одну з двох карток.
 */
test("#9996 🪞 1×1 · ПЕРЕНОС НА НАЙМ: одна картка — запис і задача переїжджають; дві чи жодної — стоп з іменем", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(schema);
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Команда') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Напряму',5,true),(2,'Через Акаунт',5,true),(3,'Дві Картки',5,true),(4,'Без Картки',5,true)`);
    await c.query(`INSERT INTO users(id,email,password_hash,role,manager_id,team_id,is_active) VALUES
      (12,'b@uts.ua','x','manager',2,5,true),(13,'c@uts.ua','x','manager',3,5,true)`);
    await c.query(`INSERT INTO employees(id,full_name,import_key,position,status,manager_id,user_id) VALUES
      (21,'Картка Напряму','k21','Менеджер з продажу','active',1,NULL),
      (22,'Картка Через Акаунт','k22','Менеджер з продажу','dismissed',NULL,12),
      (23,'Перша Картка','k23','Менеджер з продажу','active',3,NULL),
      (24,'Друга Картка','k24','Менеджер з продажу','active',NULL,13)`);
    await c.query(OLD_KEY_SQL);
    await c.query(`INSERT INTO one_on_ones(subject_manager_id,type,meeting_date,overall) VALUES
      (1,'A','2026-10-01',4),(1,'V','2026-10-02',NULL),(2,'A','2026-10-03',3)`);
    await c.query(`INSERT INTO tasks(id,title,status,assignee_id,task_type,o2o_type,o2o_meeting_date) VALUES
      (901,'Задача з 1×1','not_started',2,'oneonone','A','2026-10-03')`);
    await c.query(schema);
    await c.query(schema); // повторний прогін — як кожен викат
    const recs = (await c.query(`SELECT subject_manager_id AS m, subject_employee_id AS e FROM one_on_ones ORDER BY meeting_date`)).rows;
    assert.deepEqual(recs.map((r) => `${r.m}→${r.e}`), ["1→21", "1→21", "2→22"],
      "🔴 запис 1×1 не переїхав на свою картку (зв'язок через акаунт, звільнений у Найм — історія лишається)");
    assert.equal((await c.query("SELECT o2o_employee_id AS e FROM tasks WHERE id=901")).rows[0].e, 22, "🔴 задача з 1×1 не переїхала");
    assert.equal((await c.query(PK_SQL)).rows[0].cols, "subject_employee_id,type,meeting_date", "🔴 ключ запису 1×1 — не картка Найму");
    await c.query(`INSERT INTO employees(id,full_name,import_key,position,status) VALUES (25,'Без Kommo','k25','Бухгалтер','active')`);
    await c.query(`INSERT INTO one_on_ones(subject_employee_id,type,meeting_date) VALUES (25,'V','2026-11-19')`); // без менеджера — можна

    await c.query("DELETE FROM one_on_ones WHERE subject_manager_id IS NULL");
    await c.query(OLD_KEY_SQL);
    await c.query(`INSERT INTO one_on_ones(subject_manager_id,type,meeting_date) VALUES (3,'A','2026-10-05'),(4,'A','2026-10-06')`);
    await assert.rejects(c.query(schema), (e: Error) => {
      assert.match(e.message, /перенос зупинено/);
      assert.match(e.message, /Дві Картки \(карток: 2\)/, "🔴 менеджер із двома картками не зупинив перенос");
      assert.match(e.message, /Без Картки \(карток: 0\)/, "🔴 менеджер без картки не зупинив перенос");
      return true;
    }, "🔴 неоднозначний перенос пройшов мовчки");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #9997 🪞 — 1×1 ЛЮДИНИ БЕЗ KOMMO ЧЕРЕЗ СПРАВЖНІЙ РОУТ (scratch-БД, 19.11.2026). HR («HR→Всі», наскрізний):
 * бухгалтер без Kommo є в списку; запис зберігається, після «перезавантаження» читається тим самим, повторне збереження
 * оновлює той самий запис; задача йде на його акаунт і видна на зустрічі; задача менеджеру з Kommo — менеджеру.
 * ДЗЕРКАЛО: людина без акаунта — 400 словами (а не задача-сирота); звільнений у Найм — 403; тімлід у «A» — своя команда
 * так, бухгалтер — 403.
 * Червоніє, якщо запис знову піде на менеджера Kommo, задача без Kommo піде в нікуди, або скоуп пропустить звільненого.
 */
test("#9997 🪞 1×1 ЧЕРЕЗ РОУТ: без Kommo — зберегти, прочитати, задача на акаунт; без акаунта — 400; звільнений — 403", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Команда Яцика') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'Kommo Менеджер',5,true)`);
    await c.query(`INSERT INTO users(id,email,password_hash,role,role_override,full_name,manager_id,team_id,is_active) VALUES
      (1,'hr@t','x','manager','hr','HR Іван',NULL,NULL,true),
      (2,'lead@t','x','team_lead',NULL,'Тімлід',NULL,5,true),
      (30,'buh@t','x','manager',NULL,'Бухгалтер',NULL,NULL,true)`);
    await c.query(`INSERT INTO employees(id,full_name,import_key,position,status,manager_id,user_id) VALUES
      (21,'Менеджер З Kommo','k21','Менеджер з продажу','active',1,NULL),
      (22,'Бухгалтер Без Kommo','k22','Бухгалтер','active',NULL,30),
      (23,'Без Акаунта','k23','Бухгалтер','active',NULL,NULL),
      (24,'Звільнений У Наймі','k24','Менеджер з продажу','dismissed',NULL,NULL)`);

    await import("../lib/asyncRoutes.js");
    const { default: express } = await import("express");
    const { oneOnOnesRouter } = await import("./oneOnOnes.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    await refreshRoles();
    const app = express();
    app.use(express.json());
    app.use("/api/one-on-ones", oneOnOnesRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/one-on-ones`;
    const TOK: Record<string, string> = {
      hr: signToken({ userId: 1, role: "company", roleKey: "hr", managerId: null, teamId: null } as never),
      lead: signToken({ userId: 2, role: "team_lead", roleKey: "team_lead", managerId: null, teamId: 5 } as never),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (who: string, method: string, p: string, body?: unknown): Promise<{ s: number; j: any }> => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOK[who]}` },
        body: body === undefined ? undefined : JSON.stringify(body) });
      let j: unknown = null; try { j = await r.json(); } catch { /* порожньо */ }
      return { s: r.status, j };
    };

    const list = await call("hr", "GET", "/subjects?type=V&month=2026-11");
    assert.equal(list.s, 200, JSON.stringify(list.j));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = new Map<number, any>(list.j.subjects.map((s: { id: number }) => [s.id, s]));
    assert.deepEqual([...byId.keys()].sort(), [21, 22, 23], "🔴 «HR→Всі»: людина без Kommo зникла або звільнений у Найм лишився");
    assert.deepEqual([22, 23].map((id) => [byId.get(id).has_kommo, byId.get(id).can_take_task]), [[false, true], [false, false]],
      "🔴 список не каже, кому задачу поставити не можна");

    const save = (body: object) => call("hr", "POST", "/record", { type: "V", meetingDate: "2026-11-19", answers: {}, ...body });
    assert.equal((await save({ subjectId: 22, enpsScore: 6 })).s, 200, "🔴 запис людини без Kommo не зберігся");
    assert.equal((await save({ subjectId: 22, enpsScore: 8 })).s, 200);
    const rec = await call("hr", "GET", "/record/V/22?date=2026-11-19");
    assert.deepEqual([rec.s, rec.j.subject_id, rec.j.enps_score], [200, 22, 8], "🔴 після «перезавантаження» запис не той");
    assert.deepEqual((await c.query("SELECT subject_employee_id AS e, subject_manager_id AS m, enps_score AS s FROM one_on_ones")).rows,
      [{ e: 22, m: null, s: 8 }], "🔴 повторне збереження — другий запис, а не оновлення того самого");
    assert.equal((await save({ subjectId: 24, enpsScore: 5 })).s, 403, "🔴 звільнений у Найм пройшов скоуп");

    const task = (subjectId: number, title: string) => call("hr", "POST", "/task", { type: "V", subjectId, title, meetingDate: "2026-11-19" });
    assert.equal((await task(22, "Звірити акти")).s, 201, "🔴 задача людині без Kommo не поставилась");
    assert.equal((await task(21, "Обдзвонити базу")).s, 201);
    const orphan = await task(23, "Нікому");
    assert.equal(orphan.s, 400, "🔴 людині без акаунта поставилась задача-сирота");
    assert.match(String(orphan.j?.error), /Без Акаунта.*немає ні Kommo, ні акаунта/, "🔴 відмова без слів");
    assert.deepEqual((await c.query(`SELECT title, assignee_id AS a, assignee_user_id AS u, o2o_employee_id AS e FROM tasks ORDER BY id`)).rows,
      [{ title: "Звірити акти", a: null, u: 30, e: 22 }, { title: "Обдзвонити базу", a: 1, u: null, e: 21 }],
      "🔴 задача з 1×1: без Kommo — не на акаунт, з Kommo — не менеджеру, або без картки Найму");
    const again = await call("hr", "GET", "/record/V/22?date=2026-11-19");
    assert.deepEqual(again.j.tasks_set.map((x: { title: string }) => x.title), ["Звірити акти"], "🔴 задача, поставлена на зустрічі, не видна");
    const open = await call("hr", "GET", "/open-tasks/V/22?before=2026-11-20");
    assert.equal(open.s, 200);
    assert.deepEqual(open.j.tasks.map((x: { title: string }) => x.title), ["Звірити акти"], "🔴 відкриті задачі людини без Kommo загубились");

    const lead = (subjectId: number) => call("lead", "POST", "/record", { type: "A", subjectId, meetingDate: "2026-11-19", answers: {} });
    assert.equal((await lead(21)).s, 200, "🔴 тімлід не може провести «A» своєму менеджеру");
    assert.equal((await lead(22)).s, 403, "🔴 тімлід провів «A» бухгалтеру");
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    const { pool } = await import("../db/pool.js").catch(() => ({ pool: null }));
    await pool?.end().catch(() => undefined);
    await c.end();
    scratch.dispose();
  }
});

/**
 * #9999 🪞 — ВІДКАТ КЛЮЧА (`docs/sql/1x1-employee-rollback.sql`) НА СПРАВЖНІЙ СХЕМІ. Обидва боки межі: записи лише людей
 * із Kommo — ключ повертається на менеджера, дані цілі, і наступний викат знову переносить; є запис людини без Kommo —
 * відкат зупиняється з її іменем і нічого не міняє.
 * Червоніє, якщо відкат мовчки видалить чи загубить запис людини без Kommo, або не поверне старий ключ.
 */
test("#9999 🪞 1×1 · ВІДКАТ КЛЮЧА: лише з Kommo — старий ключ і дані цілі; є людина без Kommo — стоп з іменем", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  const rollback = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "docs", "sql", "1x1-employee-rollback.sql"), "utf8");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(schema);
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Команда') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'Kommo Один',5,true)`);
    await c.query(`INSERT INTO employees(id,full_name,import_key,position,status,manager_id) VALUES
      (21,'З Kommo','k21','Менеджер з продажу','active',1),(22,'Бухгалтер Без Kommo','k22','Бухгалтер','active',NULL)`);
    await c.query(`INSERT INTO one_on_ones(subject_employee_id,subject_manager_id,type,meeting_date) VALUES (21,1,'A','2026-11-02')`);
    await c.query(rollback);
    assert.equal((await c.query(PK_SQL)).rows[0].cols, "subject_manager_id,type,meeting_date", "🔴 відкат не повернув старий ключ");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM one_on_ones")).rows[0].n, 1, "🔴 відкат загубив запис");
    await c.query(schema);
    assert.equal((await c.query(PK_SQL)).rows[0].cols, "subject_employee_id,type,meeting_date", "🔴 після відкату викат не переносить знову");

    await c.query(`INSERT INTO one_on_ones(subject_employee_id,type,meeting_date) VALUES (22,'V','2026-11-19')`);
    await assert.rejects(c.query(rollback), /відкат ключа 1×1 зупинено.*Бухгалтер Без Kommo · V · 2026-11-19/,
      "🔴 відкат пройшов, хоча старий ключ не вмістить людину без Kommo");
    await c.query("ROLLBACK");
    assert.equal((await c.query(PK_SQL)).rows[0].cols, "subject_employee_id,type,meeting_date", "🔴 зупинений відкат таки поміняв ключ");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM one_on_ones")).rows[0].n, 2, "🔴 зупинений відкат зачепив дані");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
