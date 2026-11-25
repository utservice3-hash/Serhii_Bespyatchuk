import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🧭 Задача 10723, прохід 3 (план §Д, «роби» Романа 25.11.2026): відділи й команди «Найму» → «Зарплати».
 * Блок «Оргструктури» → відділ «Зарплати» за таблицею відповідності (рядка немає — за відділом блоку), команда — за командою Kommo блоку.
 * Розбіжність — рядок «Перевести» в «Змінах з «Найму»»; сама «Зарплата» не переписується. Гейти `#10930`–`#10933`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

const KNOWN = new Set(["sales", "log", "ops", "hr", "fin", "ba", "mgmt"]);
const UNITS = [
  { id: 1, parentId: null, name: "Керівництво", dept: "top", teamKey: null },
  { id: 2, parentId: 1, name: "Операційне управління", dept: "top", teamKey: null },
  { id: 3, parentId: 2, name: "Бізнес-асистент", dept: "top", teamKey: null },
  { id: 4, parentId: 2, name: "Відділ персоналу", dept: "hr", teamKey: null },
  { id: 5, parentId: 2, name: "Бухгалтерія", dept: "fin", teamKey: null },
  { id: 6, parentId: 2, name: "IT-відділ", dept: "it", teamKey: null },
  { id: 7, parentId: 2, name: "Комерційний відділ", dept: "sales", teamKey: null },
  { id: 8, parentId: 7, name: "Команда Яцика", dept: "sales", teamKey: "k:335511" },
  { id: 9, parentId: 7, name: "Команда Лілії", dept: "sales", teamKey: "k:691208" },
  { id: 10, parentId: 7, name: "Команда без зарплати", dept: "sales", teamKey: "k:999" },
  { id: 11, parentId: 2, name: "Логістика (своя)", dept: "top", teamKey: null },
];
const MAP = new Map<number, string | null>([[3, "ba"], [2, null], [11, "log"]]);
const TEAMS = [{ code: "t335511", kommoTeamId: 335511 }, { code: "t691208", kommoTeamId: 691208 }, { code: "tx", kommoTeamId: null }];

/**
 * #10930 — ВІДДІЛ І КОМАНДА З БЛОКУ: за відділом блоку (hr→HR, fin→Фінанси, продажі→Продажі, top→Керівництво, IT — ні),
 * свій рядок перекриває (БА → «Бізнес-асистент», NULL → не зіставляти, свій «log»), невідомий код — ні; команда — за командою Kommo блоку.
 * 🧨 Червоніє, якщо свій рядок не перекриватиме відділ блоку, NULL читатиметься як «за замовчуванням» або команду братимуть не з Kommo.
 */
test("#10930 НАЙМ → ЗАРПЛАТА: відділ за блоком і таблицею (свій рядок головний, NULL — не зіставляти), команда — за командою Kommo блоку", async () => {
  const { naimPlacement, unitDept } = await import("./naimSync.js");
  const d = (id: number, map = MAP) => unitDept(UNITS.find((u) => u.id === id)!, map, KNOWN);
  assert.equal(d(1), "mgmt", "🔴 блок керівництва — «Керівництво» за відділом блоку");
  assert.equal(d(4), "hr", "🔴 відділ персоналу — HR");
  assert.equal(d(5), "fin", "🔴 бухгалтерія — «Фінанси й бухгалтерія»");
  assert.equal(d(8), "sales", "🔴 команда продажу — відділ продажу");
  assert.equal(d(6), null, "🔴 IT у «Зарплаті» відділу не має — не зіставляємо");
  assert.equal(d(3), "ba", "🔴 свій рядок перекриває відділ блоку: БА — «Бізнес-асистент», не «Керівництво»");
  assert.equal(d(2), null, "🔴 свій рядок NULL — не зіставляти, а не «за відділом блоку»");
  assert.equal(d(11), "log", "🔴 свій рядок з відділом «Зарплати», якого в «Наймі» немає");
  assert.equal(d(11, new Map([[11, "nope"]])), null, "🔴 відділу, якого в «Зарплаті» немає, не пропонуємо");
  const pl = naimPlacement(UNITS, [{ id: 100, unitId: 8 }, { id: 101, unitId: 10 }, { id: 102, unitId: 3 }, { id: 103, unitId: null }], MAP, TEAMS, KNOWN);
  assert.deepEqual(pl.get(100), { dept: "sales", team: "t335511", unit: "Команда Яцика" }, "🔴 команда — за командою Kommo блоку");
  assert.deepEqual(pl.get(101), { dept: "sales", team: null, unit: "Команда без зарплати" }, "🔴 команди Kommo без команди «Зарплати» — команди не пропонуємо");
  assert.deepEqual(pl.get(102), { dept: "ba", team: null, unit: "Бізнес-асистент" });
  assert.equal(pl.has(103), false, "🔴 людина без блоку — без підказки");
});

/**
 * #10931 — РЯДОК «ПЕРЕВЕСТИ»: інший відділ — рядок; інша команда — рядок; усе як є — без рядка; «Найм» команди не знає — команду
 * не порівнюємо; тім-ліду порівнюємо команду, яку він веде; звільненим у «Зарплаті» — без рядка.
 * 🧨 Червоніє, якщо порівнювати з порожньою командою «Найму» (кожного продажника назве «поза командою») або тім-ліду — його team.
 */
test("#10931 ПЕРЕВЕСТИ: інший відділ чи команда — рядок; однакове, невідома команда, звільнений — без рядка; тім-лід — за командою, яку веде", async () => {
  const { naimChanges } = await import("./naimSync.js");
  const P = (userId: string, o: Record<string, unknown>) => ({ userId, name: `Л${userId}`, role: "staff", level: null, levelChange: null, leave: null, dept: "ops", team: null, leadsTeam: null, ...o });
  const N = (id: number, userId: string) => ({ employeeId: id, userId, userActive: true, candidateRole: false, name: `Л${userId}`, position: null, status: "active", dismissedAt: null, isSalesManager: false, level: null });
  const place = new Map([
    [1, { dept: "fin", team: null, unit: "Бухгалтерія" }],            // інший відділ
    [2, { dept: "sales", team: "t691208", unit: "Команда Лілії" }],    // інша команда
    [3, { dept: "sales", team: "t335511", unit: "Команда Яцика" }],    // усе однакове
    [4, { dept: "sales", team: null, unit: "Команда без зарплати" }],  // команди «Найм» не знає
    [5, { dept: "sales", team: "t691208", unit: "Команда Лілії" }],    // тім-лід веде t691208
    [6, { dept: "fin", team: null, unit: "Бухгалтерія" }],            // звільнений у «Зарплаті»
    [7, { dept: null, team: null, unit: "IT-відділ" }],               // не зіставляється
  ]);
  const pay = [P("1", {}), P("2", { role: "manager", dept: "sales", team: "t335511" }), P("3", { role: "manager", dept: "sales", team: "t335511" }),
    P("4", { role: "manager", dept: "sales", team: "t335511" }), P("5", { role: "lead", dept: "sales", team: null, leadsTeam: "t691208" }),
    P("6", { leave: { date: "2026-11-10" } }), P("7", {})];
  const rows = naimChanges(pay, [1, 2, 3, 4, 5, 6, 7].map((i) => N(i, String(i))), place).filter((r) => r.kind === "move");
  assert.deepEqual(rows.map((r) => r.userId), ["1", "2"], "🔴 рядок «Перевести» — рівно в того, у кого інший відділ (1) чи команда (2)");
  assert.deepEqual([rows[0].payrollDept, rows[0].naimDept, rows[0].unit], ["ops", "fin", "Бухгалтерія"], "🔴 відділ: було → у «Наймі», і блок");
  assert.deepEqual([rows[1].payrollTeam, rows[1].naimTeam, rows[1].naimDept], ["t335511", "t691208", "sales"], "🔴 команда: було → у «Наймі»; відділ лишається");
  assert.equal(naimChanges(pay, [N(1, "1")]).length, 0, "🪞 без підказки з «Оргструктури» — нічого не порівнюємо");
});

/**
 * #10932 — СЕРВЕР: таблиця відповідності закрита від AI і заповнена наперед (БА, «Операційне управління» — не зіставляти);
 * `employeesView` віддає підказки в «Зміни з «Найму»», таблицю й відділ у «Додати в зарплату»; правка — з правом payroll_settings.
 * 🧨 Червоніє, якщо не передати підказки в `naimChanges` (рядків «Перевести» не буде ніколи) або відкрити маршрут ширше.
 */
test("#10932 СЕРВЕР: payroll_dept_map не для AI, заповнена наперед; employeesView передає підказки, таблицю й відділ кандидата; маршрут — payroll_settings", () => {
  const schema = SRC("db/schema.sql"), svc = SRC("payroll/service.ts"), rt = SRC("routes/payroll.ts");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS payroll_dept_map \(\s*unit_id\s+INTEGER PRIMARY KEY REFERENCES org_units\(id\) ON DELETE CASCADE,\s*dept_code\s+TEXT REFERENCES payroll_departments\(code\),/, "🔴 таблиця відповідності");
  assert.match(schema, /VALUES \('ba', 'ba'\), \('ops', NULL\)\) AS v\(k, dept\) JOIN org_units u ON u\.seed_key = v\.k/, "🔴 заповнено наперед: БА і «Операційне управління»");
  assert.match(schema, /payroll_adjustments, payroll_dept_map(, [a-z_]+)* FROM ai_readonly;/, "🔴 таблиця має бути закрита від AI-запитів");
  assert.match(SRC("ai/metricTools.ts"), /"payroll_dept_map"/, "🔴 дзеркало FORBIDDEN_TABLES не знає таблиці");
  assert.match(svc, /await loadNaim\(db\), place\);/, "🔴 підказки «Найму» мають дійти до naimChanges");
  assert.match(svc, /deptMap: deptMapRows\(units, dmap, known\)/, "🔴 таблиця відповідності — в employeesView");
  assert.match(svc, /dept: pl\?\.dept \?\? null, team: pl\?\.team \?\? teams\.find/, "🔴 «Додати в зарплату» має підставляти відділ і команду з «Найму»");
  assert.match(rt, /payrollRouter\.post\("\/dept-map", h\(\["payroll_settings"\],/, "🔴 таблицю править лише той, хто веде оргструктуру зарплати");
});

/**
 * #10933 — ЕКРАН: у «Змінах з «Найму»» є кнопка «Перевести» і текст «було → у Наймі»; тім-ліду переводимо команду, яку веде;
 * «Оргструктура» показує таблицю відповідності; «Додати в зарплату» бере відділ кандидата.
 * 🧨 Червоніє, якщо кнопка зникне, тім-ліду писатиметься `team` замість `leadsTeam` або таблицю не передадуть на екран.
 */
test("#10933 ЕКРАН: «Перевести» в «Змінах з Найму», тім-ліду — leadsTeam; таблиця відповідності в «Оргструктурі»; відділ кандидата", () => {
  const ps = FRONT("payroll/system/PeopleSettings.tsx"), os = FRONT("payroll/system/OrgSettings.tsx"), st = FRONT("payroll/system/SettingsTab.tsx");
  assert.match(ps, /r\.kind === "move" \? <button className="zp-btn zp-btn--sm" onClick=\{\(\) => onMove\(r\)\}>Перевести<\/button>/, "🔴 немає кнопки «Перевести»");
  assert.match(ps, /body\[lead \? "leadsTeam" : "team"\] = r\.naimTeam/, "🔴 тім-ліду треба міняти команду, яку він веде");
  assert.match(ps, /dept: c\.dept \?\? \(c\.role === "staff"/, "🔴 «Додати в зарплату» не бере відділ з «Найму»");
  assert.match(os, /<DeptMap rows=\{deptMap\} depts=\{depts\} canEdit=\{canEdit\} onChanged=\{onChanged\} \/>/, "🔴 немає таблиці відповідності в «Оргструктурі»");
  assert.match(st, /deptMap=\{\(data\.emp\.deptMap \?\? \[\]\) as Obj\[\]\}/, "🔴 таблицю не передано на екран");
});
