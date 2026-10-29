import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { monthRow, monthsBetween, type ChurnPerson } from "./churn.js";

/**
 * 📉 ПЛИННІСТЬ, EXIT, KOMMO (18.09.2026, етапи 4–5) — гейти `#583`–`#585`.
 * Номери з запасом над `#582` — борг 17: перед мержем перемірити перетин.
 */
const P = (hired: string | null, dismissed: string | null, reason: string | null = null): ChurnPerson =>
  ({ hired_at: hired, dismissed_at: dismissed, dismiss_reason: reason, position: "менеджер", team_label: "3" });

/**
 * #583 — ПЛИННІСТЬ ЯК У ТАБЛИЦІ: звільнено за місяць ÷ усіх, хто ПРАЦЮВАВ у місяці; прийнятий і звільнений
 * в одному місяці — і в «працював», і в «звільнено»; звільнений 1-го числа — ще працював у тому місяці;
 * без дати прийому — рахується й видно окремим числом; «ранні» — до 90 днів.
 * 🧨 Червоніє, якщо знаменник — лише ті, хто на кінець місяця, або межі місяця не включні.
 */
test("#583 ПЛИННІСТЬ: звільнені ÷ усі, хто працював у місяці; межі включно; без дати прийому — видно", () => {
  const ppl = [
    P("2025-01-10", null), P("2025-02-01", "2026-03-01", "ставка"), P("2026-03-05", "2026-03-20", "не підійшов"),
    P("2026-04-01", null), P(null, null), P("2024-06-01", "2026-02-28"),
  ];
  const m = monthRow(ppl, "2026-03");
  assert.deepEqual([m.headcount, m.hired, m.dismissed, m.early, m.noHireDate], [4, 1, 2, 1, 1], "🔴 не ті числа березня: " + JSON.stringify(m));
  assert.equal(m.turnover, 50, "🔴 плинність не 2 із 4");
  assert.equal(monthRow(ppl, "2026-02").headcount, 4, "🔴 звільнений 28.02 не працював у лютому");
  assert.equal(monthRow([], "2026-03").turnover, null, "🔴 порожній місяць дав число замість «немає»");
  assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван') RETURNING id`)).rows[0].id as number;
  return { c, db: c as unknown as import("./secrets.js").Db, hr, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #584 — ПРИВʼЯЗКА ДО KOMMO: за «ID Kommo» з таблиці; інакше — за ЄДИНИМ збігом прізвища й імені;
 * однофамільців не вгадуємо; один менеджер — одна людина; повторний запуск нічого не міняє.
 * 🧨 Червоніє, якщо брати першого з однофамільців або привʼязати менеджера двічі.
 */
test("#584 ЖИВИЙ SQL: привʼязка до Kommo — за ID, за єдиним ПІБ, однофамільців не вгадує, повтор без змін", async (t) => {
  const s = await scratch(t); if (!s) return;
  const ch = await import("./churn.js");
  try {
    await s.c.query(`INSERT INTO managers (id, name, kommo_user_id) VALUES (1,'Коваленко Олена',111),(2,'Бондар Андрій',222),(3,'Андрій Бондар',333),(4,'Сидоренко Марія',444)`);
    await s.c.query(`INSERT INTO employees (full_name, import_key, extra) VALUES
      ('Хтось Інший Зовсім','a','{"ID Kommo":"111"}'), ('Бондар Андрій Петрович','b','{}'), ('Сидоренко Марія Іванівна','c','{}'), ('Сидоренко Марія','d','{}')`);
    const r = await ch.linkKommo(s.db);
    const got = Object.fromEntries((await s.c.query(`SELECT import_key, manager_id FROM employees`)).rows.map((x) => [x.import_key, x.manager_id]));
    assert.equal(got.a, 1, "🔴 не привʼязано за ID Kommo");
    assert.equal(got.b, null, "🔴 однофамільців привʼязано навмання");
    assert.equal([got.c, got.d].filter((x) => x === 4).length, 1, "🔴 один менеджер на двох людях");
    assert.deepEqual([r.byId, r.ambiguous], [1, 1]);
    const again = await ch.linkKommo(s.db);
    assert.equal(again.linked, 0, "🔴 повторний запуск щось змінив");
  } finally { await s.done(); }
});

/**
 * #585 — EXIT-ІНТЕРВʼЮ: без ПІБ чи дати — 400; оцінка лише 1–10; зведення (середня оцінка, «порадив би»,
 * причини) рахується з записів; видалення скасовне; таблиця закрита для AI-помічника.
 * 🧨 Червоніє, якщо прийняти оцінку 0/11, рахувати видалені або прибрати REVOKE.
 */
test("#585 ЖИВИЙ SQL: Exit-інтервʼю — валідація, зведення, скасовне видалення, закрито для AI", async (t) => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "db", "schema.sql"), "utf8");
  assert.ok(sql.indexOf("REVOKE ALL ON exit_interviews FROM ai_readonly;") > sql.indexOf("CREATE TABLE IF NOT EXISTS exit_interviews ("), "🔴 REVOKE немає або вище за CREATE");
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", "ai", "metricTools.ts"), "utf8"), /"exit_interviews",/, "🔴 немає у FORBIDDEN_TABLES");
  const s = await scratch(t); if (!s) return;
  const ch = await import("./churn.js");
  try {
    const bad = (e: unknown) => (e as { status?: number }).status === 400;
    await assert.rejects(ch.createExit(s.db, s.hr, { interview_date: "2026-09-01" }), bad, "🔴 без ПІБ");
    await assert.rejects(ch.createExit(s.db, s.hr, { full_name: "А", interview_date: "2026-09-01", rating: 11 }), bad, "🔴 оцінку 11 прийнято");
    const a = await ch.createExit(s.db, s.hr, { full_name: "Коваленко Олена", interview_date: "2026-09-01", reason: "ставка", rating: 8, recommend: "Так" });
    await ch.createExit(s.db, s.hr, { full_name: "Бондар Андрій", interview_date: "2026-09-02", reason: "ставка", rating: 4, recommend: "Ні" });
    const c = await ch.createExit(s.db, s.hr, { full_name: "Сидоренко Марія", interview_date: "2026-09-03", reason: "переїзд", rating: 10, recommend: "так" });
    let l = await ch.listExits(s.db);
    assert.deepEqual([l.stats.total, l.stats.avgRating, l.stats.recommendPct, l.stats.reasons[0]], [3, 7.3, 67, { label: "ставка", n: 2 }]);
    await ch.updateExit(s.db, a, { rating: 2 });
    await ch.setExitDeleted(s.db, c, true);
    l = await ch.listExits(s.db);
    assert.deepEqual([l.stats.total, l.stats.avgRating], [2, 3], "🔴 видалене пораховано або зміна не лягла");
    await ch.setExitDeleted(s.db, c, false);
    assert.equal((await ch.listExits(s.db)).stats.total, 3, "🔴 відновлення не повернуло запис");
  } finally { await s.done(); }
});

/**
 * #2960 — КАТЕГОРІЯ ЗА ПОСАДОЮ (28.10.2026, ТЗ Івана). Справжні написання з реєстру (замір 28.10: 62 працюючі,
 * 18 написань) лягають у свою категорію; порядок правил тримає «офіс-менеджер» в офісі, «керівник групи» — у
 * тім-лідах; невпізнане — null, а не здогадка; ручна категорія перемагає правило.
 * 🧨 Червоніє, якщо переставити «manager» перед «office», прибрати «мен» чи ігнорувати ручну.
 */
test("#2960 КАТЕГОРІЯ: посада → категорія за правилом, невпізнане — null, ручна перемагає", async () => {
  const { categoryOf, effectiveCategory } = await import("./employeeCategory.js");
  const cases: [string | null, string | null][] = [
    ["віддалений менеджер", "manager"], ["Віддаленний менеджер", "manager"], ["Менеджер з продажу в логістичну компанію", "manager"],
    ["мен по орг груз перев", "manager"], ["менеджер по тендерам", "manager"],
    ["TeamLead", "teamlead"], ["Тім-Лід", "teamlead"], ["керівник групи продажу", "teamlead"],
    ["віддалений лідген", "leadgen"], ["лідогенератор", "leadgen"],
    ["бухгалтерія", "accounting"], ["помічник бухгалтера", "accounting"], ["Фінансист", "finance"],
    ["операційний директор", "management"], ["CEO", "management"], ["Власники компанії", "management"], ["керівника відділу продажів", "management"],
    ["рекрутер", "office"], ["офіс-менеджер", "office"], ["HR-менеджер", "office"], ["HRD", "office"], ["IT відділ", "it"],
    ["бізнес ассистент", null], ["логіст", null], ["", null], [null, null], ["менторка", null],
  ];
  for (const [pos, want] of cases) assert.equal(categoryOf(pos), want, `🔴 «${pos}» → ${categoryOf(pos)}, а мало бути ${want}`);
  assert.equal(effectiveCategory("finance", "віддалений менеджер"), "finance", "🔴 ручна категорія не перемогла правило");
  assert.equal(effectiveCategory(null, "віддалений менеджер"), "manager", "🔴 без ручної — не за посадою");
  assert.equal(effectiveCategory("щось", "TeamLead"), "teamlead", "🔴 невідоме значення в колонці стало категорією");
});

/**
 * #2960b — ОДИН ПЕРЕЛІК КАТЕГОРІЙ: ядро, CHECK у схемі й дзеркало фронта (`api.ts`) збігаються поіменно й за порядком.
 * 🧨 Червоніє, якщо додати категорію в одне місце й забути інше.
 */
test("#2960b КАТЕГОРІЇ: ядро = CHECK схеми = дзеркало фронта", async () => {
  const { EMP_CATEGORIES } = await import("./employeeCategory.js");
  const keys = EMP_CATEGORIES.map(([k]) => k);
  const sql = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  const chk = sql.match(/employees_category_check\s+CHECK \(category IS NULL OR category IN \(([^)]*)\)\)/);
  assert.ok(chk, "🔴 CHECK employees_category_check не знайдено");
  assert.deepEqual(chk![1].split(",").map((x) => x.trim().replace(/'/g, "")), keys, "🔴 CHECK схеми розійшовся з ядром");
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "api.ts"), "utf8");
  const block = fe.slice(fe.indexOf("export const EMP_CATEGORIES"), fe.indexOf("] as const;", fe.indexOf("export const EMP_CATEGORIES")));
  const feKeys = [...block.matchAll(/\["([a-z]+)", "([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(feKeys, EMP_CATEGORIES.map(([k, l]) => [k, l]), "🔴 дзеркало фронта розійшлось із ядром");
});

/**
 * #2961 — ПЛИННІСТЬ ЗА ДОВІЛЬНИЙ ПЕРІОД І КАТЕГОРІЮ: тиждень пн–нд включно з обома кінцями; не цілі місяці →
 * помісячної плинності немає (null, а не вигадане число); ціли місяці — як було; фільтр категорії звужує список,
 * а `byCategory` рахується по всіх і в сумі дає «усі»; «дата невідома» поза розрахунком; стаж — від дати початку.
 * 🧨 Червоніє, якщо межі тижня не включні, рахувати плинність тижня або фільтрувати `byCategory`.
 */
test("#2961 ЖИВИЙ SQL ПЛИННОСТІ: тиждень пн–нд, категорія звужує список, byCategory — по всіх, тиждень без %", async (t) => {
  const s = await scratch(t); if (!s) return;
  const ch = await import("./churn.js");
  try {
    await s.c.query(`INSERT INTO employees (full_name, import_key, status, position, category, hired_at, dismissed_at, dismiss_date_unknown) VALUES
      ('Неділя Менеджер','a','dismissed','віддалений менеджер',NULL,'2026-10-05','2026-10-25',false),
      ('Понеділок Наступний','b','dismissed','віддалений менеджер',NULL,'2026-10-01','2026-10-26',false),
      ('Понеділок Тижня','c','dismissed','помічник бухгалтера',NULL,'2026-01-10','2026-10-19',false),
      ('Вручну Фінансист','d','dismissed','віддалений менеджер','finance',NULL,'2026-10-22',false),
      ('Дата Невідома','e','dismissed','віддалений менеджер',NULL,'2025-01-01','2026-10-21',true),
      ('Працює','f','active','TeamLead',NULL,'2025-05-01',NULL,false)`);
    const w = await ch.churnReport(s.db, "2026-10-19", "2026-10-25");
    assert.deepEqual(w.people.map((p) => p.full_name), ["Неділя Менеджер", "Вручну Фінансист", "Понеділок Тижня"], "🔴 не той склад тижня 19–25.10");
    assert.equal(w.total.avgTurnover, null, "🔴 для тижня вигадано помісячну плинність");
    assert.deepEqual([w.wholeMonths, w.months.length], [false, 0]);
    assert.deepEqual(w.byCategory, { manager: 1, finance: 1, accounting: 1 }, "🔴 кількості категорій тижня");
    assert.equal(w.people.find((p) => p.full_name === "Неділя Менеджер")!.tenure_days, 20, "🔴 стаж не від дати початку");
    assert.equal(w.people.find((p) => p.full_name === "Вручну Фінансист")!.tenure_days, null, "🔴 без дати початку стаж мусить бути невідомим");
    assert.deepEqual([w.total.early, w.total.noHireDate, w.total.avgTenureDays], [1, 1, Math.round((20 + 282) / 2)]);
    assert.equal(w.total.unknownDate, 1, "🔴 «дата невідома» не видно окремим числом");
    const wm = await ch.churnReport(s.db, "2026-10-19", "2026-10-25", "manager");
    assert.deepEqual(wm.people.map((p) => p.full_name), ["Неділя Менеджер"], "🔴 фільтр категорії не звузив список");
    assert.deepEqual(wm.byCategory, w.byCategory, "🔴 byCategory залежить від вибраної категорії");
    const m = await ch.churnReport(s.db, "2026-10", "2026-10");
    assert.deepEqual([m.wholeMonths, m.months.length, m.total.dismissed], [true, 1, 4], "🔴 місяць як було");
    assert.equal(Object.values(m.byCategory).reduce((a, n) => a + n, 0), m.total.dismissed, "🔴 сума категорій ≠ усі");
    assert.notEqual(m.total.avgTurnover, null, "🔴 для цілого місяця плинність зникла");
    await assert.rejects(ch.churnReport(s.db, "2026-10-25", "2026-10-19"), /пізніше/);
    await assert.rejects(ch.churnReport(s.db, "2026-10", "2026-10", "кухарі"), /категорія/);
  } finally { await s.done(); }
});

/**
 * #2962 — ПРАВКА СТАЖУ ДАТАМИ І РУЧНА КАТЕГОРІЯ: «Змінити» править дату початку разом із датою звільнення, коментар
 * обовʼязковий, обидві зміни — в одному записі журналу; початок пізніше за звільнення — 400. Ручна категорія
 * пишеться через картку, невідома — 400, скидання повертає правило.
 * 🧨 Червоніє, якщо дата початку не зберігається, журнал її не бачить або CHECK/перевірку категорії прибрати.
 */
test("#2962 ЖИВИЙ SQL: «Змінити» правка дат з коментарем у журнал; ручна категорія і скидання", async (t) => {
  const s = await scratch(t); if (!s) return;
  const off = await import("./offboarding.js");
  const emp = await import("./employees.js");
  try {
    const id = (await s.c.query(`INSERT INTO employees (full_name, import_key, status, position, hired_at, dismissed_at)
      VALUES ('Сікора Яна','s','dismissed','віддалений менеджер','2026-09-21','2026-10-09') RETURNING id`)).rows[0].id as number;
    await assert.rejects(off.setDismissDate(s.db, s.hr, id, { date: "2026-10-09", hiredAt: "2026-09-15" }), /Коментар/);
    await assert.rejects(off.setDismissDate(s.db, s.hr, id, { date: "2026-10-09", hiredAt: "2026-10-20", comment: "x" }), /пізніше/);
    await off.setDismissDate(s.db, s.hr, id, { date: "2026-10-10", hiredAt: "2026-09-15", comment: "стажування раніше" });
    const row = (await s.c.query(`SELECT hired_at::text AS h, dismissed_at::text AS d FROM employees WHERE id = $1`, [id])).rows[0];
    assert.deepEqual([row.h, row.d], ["2026-09-15", "2026-10-10"], "🔴 дати не збереглись");
    const a = (await s.c.query(`SELECT details FROM access_audit WHERE action = 'employees.dismiss_date' ORDER BY id DESC LIMIT 1`)).rows[0].details;
    assert.deepEqual([a.hiredFrom, a.hiredTo, a.comment], ["2026-09-21", "2026-09-15", "стажування раніше"], "🔴 журнал не бачить зміни дати початку");
    await off.setDismissDate(s.db, s.hr, id, { date: "2026-10-10", comment: "лише звільнення" });
    assert.equal((await s.c.query(`SELECT hired_at::text AS h FROM employees WHERE id = $1`, [id])).rows[0].h, "2026-09-15", "🔴 без hiredAt дату початку зачепило");

    await assert.rejects(emp.updateEmployee(s.db, s.hr, id, { category: "кухарі" }), /категорія/);
    await emp.updateEmployee(s.db, s.hr, id, { category: "office" });
    let r = (await emp.listEmployees(s.db)).find((x) => x.id === id)!;
    assert.deepEqual([r.category, r.category_manual], ["office", true], "🔴 ручна категорія не дійшла до списку");
    await emp.updateEmployee(s.db, s.hr, id, { category: "" });
    r = (await emp.listEmployees(s.db)).find((x) => x.id === id)!;
    assert.deepEqual([r.category, r.category_manual], ["manager", false], "🔴 скидання не повернуло правило за посадою");
  } finally { await s.done(); }
});
