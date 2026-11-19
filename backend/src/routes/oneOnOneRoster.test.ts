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
 * #3420b — ПРОВОДКА: «кого можна провести» в 1×1 (список, запис, задачі) бере стан менеджера, а не голий Kommo-прапорець.
 * Червоніє, якщо в `conductSubjectScope` повернеться `m.is_active` замість правила стану.
 */
test("#3420b 1×1 · ПРОВОДКА: скоуп «провести» — за станом менеджера, не за голим Kommo-прапорцем", () => {
  const src = SRC("routes/oneOnOnes.ts");
  const fn = src.slice(src.indexOf("function conductSubjectScope"), src.indexOf("/** WHERE-фрагмент для VIEW-скоупу"));
  assert.ok(fn.length > 0, "🔴 conductSubjectScope не знайдено");
  assert.doesNotMatch(fn, /m\.is_active/, "🔴 скоуп 1×1 знову дивиться лише на Kommo — звільнені повернуться в ростер");
  // 19.11.2026: люди 1×1 — з Найму (`oneOnOne/roster.ts`), а стан менеджера став другим запобіжником усередині
  // ростера. Кожна гілка скоупу (A, B, V, наскрізний) бере список ЛИШЕ з ростера — тобто й зі стану.
  assert.match(fn, /const roster = await rosterFor\(type\)/, "🔴 скоуп 1×1 не бере ростер");
  assert.equal((fn.match(/m\.id = ANY\(\$\d::int\[\]\)/g) ?? []).length, 2, "🔴 не кожна гілка скоупу обмежена ростером");
  const roster = SRC("oneOnOne/roster.ts");
  assert.match(roster, /export const SUBJECT_WORKS = inOwnWorkListsSql\("m", activeManagerSql\("m"\)\)/, "🔴 стан для 1×1 — не той, що в ростері аналітики");
  assert.match(roster, /\(m\.id IS NOT NULL AND \$\{SUBJECT_WORKS\}\) AS works/, "🔴 ростер 1×1 не дивиться на стан менеджера");
});

/**
 * #9994 🪞 — ХТО В ЯКОМУ ТИПІ 1×1, ЗА КАТЕГОРІЄЮ В НАЙМ (Сергій 19.11.2026; Роман: лідоген — у «A», тім-лід лідогену — у «Б»).
 * Обидва боки межі: бухгалтер, фінансист, директор — НЕ в «Тімлід→Менеджер»; менеджер продажу й лідогенератор — у ньому;
 * тім-лід — лише в «КВП→Тімлід»; у «HR→Всі» — усі. Без пари в Kommo — сірим, а не зникає; звільнений накладкою — сірим.
 * Червоніє, якщо правило категорій пустить у «A» не-продажника, або загубить менеджера, або сховає людину без Kommo.
 */
test("#9994 🪞 1×1 · ХТО В ТИПІ: «A» — менеджери й лідоген, «Б» — тім-ліди, «В» — усі; без Kommo — сірим", async () => {
  const { rosterOf, o2oTypesOf } = await import("../oneOnOne/roster.js");
  const row = (employee_id: number, full_name: string, position: string | null, manager_id: number | null,
    category: string | null = null, works = true) => ({ employee_id, full_name, position, manager_id, category, team_id: 5, works });
  const rows = [
    row(1, "Менеджер Продажу", "Менеджер з продажу", 101),
    row(2, "Лідоген Перший", "Лідогенератор", 102),
    row(3, "Тім Лід", "Тімлід", 103),
    row(4, "Бухгалтер Одна", "Бухгалтер", 104),
    row(5, "Фінансист Один", "Фінансист", 105),
    row(6, "Директор Операційний", "Операційний директор", 106),
    row(7, "Ручна Категорія", "Бухгалтер", 107, "manager"),
    row(8, "Без Kommo Менеджер", "Менеджер з продажу", null),
    row(9, "Без Kommo Бухгалтер", "Бухгалтер", null),
    row(10, "Звільнений Накладкою", "Менеджер з продажу", 110, null, false),
    row(11, "Дубль Менеджера", "Менеджер з продажу", 101),
  ];
  const ids = (t: "A" | "B" | "V") => rosterOf(rows, t).subjects.map((s) => s.managerId);
  const grey = (t: "A" | "B" | "V") => rosterOf(rows, t).unlinked.map((u) => `${u.employeeId}:${u.reason}`);
  assert.deepEqual(ids("A"), [101, 102, 107], "🔴 «Тімлід→Менеджер»: не-продажник пройшов або менеджер/лідоген загубився");
  assert.deepEqual(ids("B"), [103], "🔴 «КВП→Тімлід» — лише тім-ліди");
  assert.deepEqual(ids("V"), [101, 102, 103, 104, 105, 106, 107], "🔴 «HR→Всі» — усі працюючі з парою в Kommo, кожен раз");
  assert.deepEqual(grey("A"), ["8:no_kommo", "10:kommo_off"], "🔴 менеджер без Kommo чи звільнений накладкою зник, а не сірий");
  assert.deepEqual(grey("V"), ["8:no_kommo", "9:no_kommo", "10:kommo_off"], "🔴 у «HR→Всі» люди без Kommo мусять бути сірими");
  assert.equal(rosterOf(rows, "A").subjects.find((s) => s.managerId === 101)?.fullName, "Менеджер Продажу", "🔴 ім'я — з Найму, перша картка");
  assert.deepEqual(o2oTypesOf(null), ["V"], "🔴 без категорії — лише «HR→Всі», не вгадуємо");
});

/**
 * #9995 🪞 — РОСТЕР 1×1 НА СПРАВЖНІЙ СХЕМІ: `ROSTER_SQL` + `rosterOf` (19.11.2026).
 * Звільнений у Найм, хоч активний у Kommo, — НІ; працюючий у Найм — ТАК (напряму й через акаунт); «завершує» — ТАК;
 * працює в Найм без Kommo — сірим; звільнений накладкою дашборду — сірим (другий запобіжник `#3420`).
 * Червоніє, якщо ростер знову візьме людей з Kommo, загубить зв'язок через акаунт або «завершує».
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
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Яцик Team lead') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES
      (1,'Kommo Один',5,true),(2,'Kommo Два',5,true),(3,'Kommo Три',5,true),(4,'Kommo Чотири',5,true),(5,'Kommo Пʼять',5,true)`);
    await c.query(`INSERT INTO users(id,email,password_hash,role,manager_id,team_id,is_active) VALUES
      (12,'b@uts.ua','x','manager',2,5,true)`);
    await c.query(`INSERT INTO manager_work_state(manager_id,state,since) VALUES (5,'dismissed','2026-11-01')`);
    await c.query(`INSERT INTO employees(id,full_name,import_key,position,status,manager_id,user_id) VALUES
      (21,'Працює Напряму','k21','Менеджер з продажу','active',1,NULL),
      (22,'Працює Через Акаунт','k22','Менеджер з продажу','active',NULL,12),
      (23,'Завершує Роботу','k23','Менеджер з продажу','finishing',3,NULL),
      (24,'Звільнений У Наймі','k24','Менеджер з продажу','dismissed',4,NULL),
      (25,'Звільнений Накладкою','k25','Менеджер з продажу','active',5,NULL),
      (26,'Без Kommo','k26','Бухгалтер','active',NULL,NULL)`);
    const rows = (await c.query(ROSTER_SQL)).rows;
    const a = rosterOf(rows, "A"), v = rosterOf(rows, "V");
    assert.deepEqual(a.subjects.map((s) => `${s.managerId}:${s.fullName}`),
      ["1:Працює Напряму", "2:Працює Через Акаунт", "3:Завершує Роботу"],
      "🔴 ростер 1×1: звільнений у Найм лишився, або загубився працюючий (через акаунт чи «завершує»)");
    assert.deepEqual(v.unlinked.map((u) => `${u.employeeId}:${u.reason}`), ["25:kommo_off", "26:no_kommo"],
      "🔴 працює в Найм, але 1×1 не зберегти — мусить бути сірим, а не зникнути");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
