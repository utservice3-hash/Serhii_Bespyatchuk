import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildOrg, tgNick, labelKey, type UnitRow, type PersonRow } from "./orgTree.js";

/**
 * 🏢 ОРГ СТРУКТУРА (задача 7062, ТЗ Даші 23.10.2026; рішення Романа 27.10.2026). Окремий файл: живі гейти підключають
 * власну одноразову базу (правило про scratch-кластер і спільний пул, testing.md).
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", p), "utf8");
const FE = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src");
const FSRC = (p: string) => readFileSync(path.join(FE, p), "utf8");

const unit = (o: Partial<UnitRow> & { id: number; name: string }): UnitRow => ({
  parentId: null, dept: "sales", teamId: null, teamName: null, dashTeamId: null, dashTeamName: null, dashLinkedKommoId: null,
  label: null, headEmployeeId: null, teamLeadEmployeeId: null, side: false, sort: 0, ...o,
});
const person = (o: Partial<PersonRow> & { id: number; name: string }): PersonRow => ({
  position: null, teamLabel: null, telegram: null, phone: null, photoV: null, userId: null, teamName: null,
  kommoTeamId: null, cardTeamId: null, dashTeamId: null, dashLinkedKommoId: null, ...o,
});

/**
 * #2850 — ЯДРО ЗА КОМАНДОЮ (27.10.2026): кожен працюючий рівно в ОДНОМУ місці; людина потрапляє в блок своєї СПРАВЖНЬОЇ
 * команди: група в Kommo перемагає вибір у картці; без Kommo — команда Kommo з картки або команда дашборду; зʼєднана
 * команда дашборду живе в блоці своєї команди Kommo; без команди / без блоку — «Без блоку» з назвою чи старим текстом
 * («9»); керівник ручний > тімлід, і керівник стоїть у своєму блоці, хоч яка в нього команда.
 * 🧨 Червоніє, якщо картка переможе Kommo, загубиться зʼєднання, людина без команди зникне замість «Без блоку», або
 * блок знову розставлятиме людей за текстом «Команди».
 */
test("#2850 ЯДРО ЗА КОМАНДОЮ: Kommo > картка, зʼєднана команда в блоці Kommo, кожен рівно раз, «Без блоку» з причиною", () => {
  const units = [
    unit({ id: 1, name: "Керівництво", dept: "top", dashTeamId: 101, dashTeamName: "Керівництво", label: "Керівництво", headEmployeeId: 10 }),
    unit({ id: 2, name: "Команда Б", parentId: 1, teamId: 13, teamName: "РНК - Б", teamLeadEmployeeId: 20, sort: 1 }),
    unit({ id: 3, name: "Команда Х", parentId: 1, teamId: 14, teamName: "Хомік Team Lead", teamLeadEmployeeId: 30, headEmployeeId: 31, sort: 2 }),
    unit({ id: 4, name: "Контейнер", parentId: 1, sort: 3 }),
    unit({ id: 5, name: "Бухгалтерія", parentId: 1, dept: "fin", dashTeamId: 102, dashTeamName: "Бухгалтерія", sort: 4 }),
    unit({ id: 6, name: "Фінвідділ", parentId: 1, dept: "fin", dashTeamId: 103, dashTeamName: "Фінвідділ", dashLinkedKommoId: 15, sort: 5 }),
    // Блок із ВЛАСНИМ текстом «Команди», але без команди: текст людей більше не розставляє.
    unit({ id: 7, name: "Старий текст", parentId: 1, dept: "top", label: "9", sort: 6 }),
  ];
  const people = [
    person({ id: 10, name: "Керівник", teamLabel: "0" }),
    person({ id: 20, name: "Тімлід Б", kommoTeamId: 13, teamName: "РНК - Б" }),
    person({ id: 21, name: "Менеджер Б", kommoTeamId: 13, dashTeamId: 102, teamName: "РНК - Б", teamLabel: "Бухгалтерія" }),
    person({ id: 30, name: "Тімлід Х", kommoTeamId: 14, teamName: "Хомік Team Lead" }),
    person({ id: 31, name: "Хомік", kommoTeamId: 13, teamName: "РНК - Б" }),
    person({ id: 40, name: "Без Kommo в команді Х", cardTeamId: 14, teamName: "Хомік Team Lead" }),
    person({ id: 41, name: "Бухгалтер", dashTeamId: 102, teamName: "Бухгалтерія" }),
    person({ id: 42, name: "Фінансист", dashTeamId: 103, dashLinkedKommoId: 15, teamName: "Финансовый отдел" }),
    person({ id: 43, name: "Самостійний", kommoTeamId: 16, teamName: "Самостійні" }),
    person({ id: 44, name: "Код", teamLabel: "9" }),
    person({ id: 45, name: "Порожній", photoV: 5, userId: 7 }),
  ];
  const t = buildOrg(units, people, 7);
  const where = new Map(t.people.map((p) => [p.id, p]));
  // Кожен — рівно раз: суму місць рахуємо з блоків, а не з `people`, інакше рівність була б тавтологією.
  const spots = [...t.units.flatMap((u) => [...(u.headId != null ? [u.headId] : []), ...u.memberIds]), ...t.unassigned];
  const headsElsewhere = t.units.filter((u) => u.headId != null && where.get(u.headId)!.unitId !== u.id).length;
  assert.equal(spots.length - headsElsewhere, people.length, "🔴 сума місць на схемі ≠ кількості працюючих");
  assert.deepEqual([...new Set(spots)].sort((a, b) => a - b), people.map((p) => p.id).sort((a, b) => a - b), "🔴 хтось загубився або зʼявився двічі");
  const at = (id: number) => t.units.find((u) => u.id === id)!;
  assert.equal(at(1).headId, 10); assert.equal(at(2).headId, 20); assert.equal(at(2).headSource, "team");
  assert.equal(at(3).headId, 31, "🔴 тімлід переписав ручного керівника"); assert.equal(where.get(31)!.unitId, 3, "🔴 керівник не в своєму блоці");
  assert.deepEqual(at(2).memberIds, [21], "🔴 картка («Бухгалтерія») перемогла групу Kommo");
  assert.equal(where.get(21)!.teamLocked, true, "🔴 команда з Kommo не позначена як заблокована");
  assert.deepEqual(at(3).memberIds.sort(), [30, 40], "🔴 людина без Kommo з командою Kommo в картці не в блоці команди");
  assert.equal(where.get(40)!.teamLocked, false, "дзеркало: вибір у картці не заблокований");
  assert.deepEqual(at(5).memberIds, [41], "🔴 команда дашборду не несе людей у свій блок");
  assert.equal(at(6).teamKey, "k:15", "🔴 зʼєднана команда дашборду не має ключа своєї команди Kommo");
  assert.deepEqual(at(6).memberIds, [42], "🔴 людина зʼєднаної команди не в її блоці");
  assert.deepEqual(at(7).memberIds, [], "🔴 блок розставив людей за текстом «Команди»");
  assert.equal(at(7).teamKey, null); assert.equal(at(4).label, null, "блок без команди — контейнер");
  assert.deepEqual(t.unassigned.sort((a, b) => a - b), [43, 44, 45], "🔴 людина без команди чи без блоку не в «Без блоку»");
  assert.deepEqual(t.unknownLabels.map((x) => x.label).sort(), ["«9» — команду не вибрано", "Команду не вибрано", "Самостійні — блоку немає"].sort(),
    "🔴 «Без блоку» не називає причини (назва команди / старий текст / нічого)");
  assert.equal(where.get(45)!.isMe, true); assert.deepEqual(where.get(45)!.photo, { id: 45, v: 5 });
  // Дзеркало пріоритету: та сама людина БЕЗ групи в Kommo йде за карткою — отже вище перемогла саме група Kommo.
  const t2 = buildOrg(units, people.map((p) => (p.id === 21 ? { ...p, kommoTeamId: null } : p)), null);
  assert.equal(t2.people.find((p) => p.id === 21)!.unitId, 5, "🔴 без Kommo картка не спрацювала — пріоритет не доведено");
  assert.equal(labelKey(" А  Б’в "), labelKey("а бʼв"));
});

/**
 * #2701 — НІК У TELEGRAM: `@nick`, `nick`, `t.me/nick`, `https://t.me/nick` → `@nick`; сентинел «-», два ніки в
 * одному полі (заміряно на проді 27.10), кирилиця, коротше 5 — «не вказано», а не посилання в нікуди.
 * 🧨 Червоніє, якщо пропускати «-» чи «@a    @b» далі як нік — кнопка «Telegram» вела б на t.me/-.
 */
test("#2701 НІК: @/без @/t.me → @nick; «-», два ніки, кирилиця, коротке → не вказано", () => {
  for (const ok of ["@ivan_uts", "ivan_uts", " t.me/ivan_uts ", "https://t.me/ivan_uts", "http://telegram.me/ivan_uts"])
    assert.equal(tgNick(ok), "@ivan_uts", `🔴 «${ok}» не розпізнано`);
  for (const bad of [null, "", " ", "-", "@", "@a    @b_second", "@іван_ютс", "@abcd", "1ivan_uts", "ivan uts"])
    assert.equal(tgNick(bad), null, `🔴 «${bad}» прийнято за нік`);
  const t = buildOrg([], [person({ id: 1, name: "А", telegram: "-" }), person({ id: 2, name: "Б", telegram: null })], null);
  assert.deepEqual(t.people.map((p) => [p.telegram, p.telegramInvalid]), [[null, true], [null, false]], "некоректне ≠ порожнє");
});

/** Одна scratch-база на файл: схема двічі (другий прогін — як наступний викат). */
async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  process.env.DATABASE_URL = s.url;
  process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  const schema = SRC("db/schema.sql");
  return { c, s, schema, done: async () => { await c.end(); s.dispose(); } };
}

const code = (n: number) => (e: { status?: number }) => e.status === n;
const byUkSort = (a: string[]) => [...a].sort((x, y) => x.localeCompare(y, "uk"));

/**
 * #2712 (було #2851) — ЖИВИЙ SQL МІГРАЦІЇ КОМАНД: офісні блоки сіду (8) стають командами дашборду й привʼязуються; блоки продажів
 * лишаються на командах Kommo; `teams` не змінюється ні на рядок; людям БЕЗ групи в Kommo команда ставиться з тексту
 * лише за ТОЧНИМ збігом (регістр і пробіли — не різниця), «0»/«1» — ні з чим; з Kommo (і через акаунт) — не чіпаються;
 * повторний викат нічого не дублює, а кому HR команду зняв — не повертає. Дерево віддає людину поіменно: телефон — так
 * (одним виглядом, рішення Романа 28.10.2026), пошти й дат — ні.
 * 🧨 Червоніє, якщо команди дашборду покласти в `teams`, ставити команду людям із Kommo, зіставляти «приблизно» або
 * повертати зняту команду наступним викатом.
 */
test("#2712 ЖИВИЙ SQL: офісні блоки → команди дашборду, команда з тексту лише без Kommo й точно, двічі — те саме, телефон без пошти й дат", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    await c.query(`INSERT INTO teams (id, name, kommo_group_id) VALUES (901, 'РНК - Безпамʼятного Андрія', 588532), (902, 'Финансовый отдел', NULL)`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_team_lead) VALUES (801, 'Безпамятний Андрій', 901, true), (802, 'Менеджер Акаунтом', 901, false)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, manager_id) VALUES (91, 'm@x.ua', 'x', 'manager', 802), (92, 'hr@x.ua', 'x', 'manager', NULL)`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status, position, team_label, phone, email, birth_date, manager_id, user_id) VALUES
      (1, 'Ступаківський Олександр Олександрович', 'k1', 'active', 'Власники компанії', '0', '+380501112233', 'a@x.ua', '1980-01-01', NULL, NULL),
      (5, 'Безпамʼятний Андрій', 'k5', 'active', 'TeamLead', '1', NULL, NULL, NULL, 801, NULL),
      (7, 'Завершує Тест', 'k7', 'finishing', 'бухгалтерія', ' бухгалтерія ', NULL, NULL, NULL, NULL, NULL),
      (8, 'Фін Без Kommo', 'k8', 'active', 'фінансист', 'финансовый  отдел', NULL, NULL, NULL, NULL, NULL),
      (9, 'Менеджер Акаунтом', 'k9', 'active', 'менеджер', 'Бухгалтерія', NULL, NULL, NULL, NULL, 91)`);
    const kommoBefore = (await c.query(`SELECT count(*)::int AS n FROM teams`)).rows[0].n as number;
    // Наступний викат: сід блоків знову (тепер із командами Kommo) — як у бойовій базі, де блоки продажів уже на командах.
    await c.query(`DELETE FROM org_units; DELETE FROM org_migrations`);
    await c.query(x.schema);
    const dash = async () => (await c.query(`SELECT id, name FROM dashboard_teams`)).rows as { id: number; name: string }[];
    assert.deepEqual(byUkSort((await dash()).map((r) => r.name)),
      byUkSort(["Керівництво", "Співвласник", "Операційне управління", "Бізнес-асистент", "Відділ персоналу", "Фінансист", "Бухгалтерія", "IT-відділ"]),
      "🔴 офісні блоки сіду не стали рівно вісьмома командами дашборду");
    const units = new Map((await c.query(`SELECT seed_key, team_id, dashboard_team_id FROM org_units`)).rows.map((r) => [r.seed_key, r]));
    for (const k of ["ceo", "owner2", "ops", "ba", "hr", "fin1", "fin2", "it"])
      assert.ok(units.get(k)!.dashboard_team_id != null && units.get(k)!.team_id == null, `🔴 офісний блок «${k}» не привʼязано до команди дашборду`);
    for (const k of ["sales", "lid", "rnk1"])
      assert.ok(units.get(k)!.team_id != null && units.get(k)!.dashboard_team_id == null, `🔴 блок продажів «${k}» зійшов з команди Kommo`);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM teams`)).rows[0].n, kommoBefore, "🔴 таблиця команд Kommo змінилась — це побачать Звіт і КВП");
    const buh = (await dash()).find((d) => d.name === "Бухгалтерія")!.id;
    const team = async (id: number) => (await c.query(`SELECT team_id, dashboard_team_id FROM employees WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(await team(7), { team_id: null, dashboard_team_id: buh }, "🔴 « бухгалтерія » (регістр/пробіли) не стала командою «Бухгалтерія»");
    assert.deepEqual(await team(8), { team_id: 902, dashboard_team_id: null }, "🔴 людині без Kommo не поставлено команду Kommo за текстом");
    assert.deepEqual(await team(9), { team_id: null, dashboard_team_id: null }, "🔴 людині з Kommo (через акаунт) поставлено команду з тексту");
    assert.deepEqual(await team(5), { team_id: null, dashboard_team_id: null }, "🔴 тімліду з Kommo поставлено команду з тексту «1»");
    assert.deepEqual(await team(1), { team_id: null, dashboard_team_id: null }, "🔴 «0» зіставлено з якоюсь командою");
    // Наступний викат — нічого не дублюється; HR зняв команду — викат її не повертає.
    await c.query(x.schema);
    assert.equal((await dash()).length, 8, "🔴 повторний прогін задублював команди дашборду");
    const tm = await import("./teams.js");
    await tm.setEmployeeTeam(c as never, 92, 7, null);
    await c.query(x.schema);
    assert.deepEqual(await team(7), { team_id: null, dashboard_team_id: null }, "🔴 наступний викат повернув команду, яку HR зняв");

    const { loadOrg } = await import("./orgTree.js");
    const tree = await loadOrg(c as never, null);
    assert.deepEqual(tree.people.map((p) => p.id).sort((a, b) => a - b), [1, 5, 7, 8, 9], "🔴 у схемі звільнений або немає того, хто «завершує»");
    const keys = [...new Set(tree.people.flatMap((p) => Object.keys(p)))].sort();
    assert.deepEqual(keys, ["id", "isHead", "isMe", "name", "phone", "photo", "position", "teamLabel", "teamLocked", "teamName", "telegram", "telegramInvalid", "unitId"],
      `🔴 у відповіді схеми зайві поля людини: ${keys.join(", ")}`);
    const raw = JSON.stringify(tree);
    for (const leak of ["a@x.ua", "1980-01-01"]) assert.ok(!raw.includes(leak), `🔴 у відповіді схеми є «${leak}»`);
    assert.deepEqual(tree.people.find((p) => p.id === 1)!.phone, { text: "+380 50 111 22 33", tel: "+380501112233" }, "🔴 телефон з «Найму» не дійшов до картки одним виглядом");
    assert.equal(tree.people.find((p) => p.id === 5)!.phone, null, "дзеркало: порожній телефон — «не вказано», а не порожній рядок");
    const idOf = async (k: string) => (await c.query(`SELECT id FROM org_units WHERE seed_key = $1`, [k])).rows[0].id as number;
    const rnk1 = await idOf("rnk1");
    assert.equal(tree.units.find((u) => u.id === rnk1)?.headId, 5, "🔴 тімлід команди не став керівником її блоку");
    const nine = tree.people.find((p) => p.id === 9)!;
    assert.deepEqual([nine.unitId, nine.teamLocked, nine.teamName], [rnk1, true, "РНК - Безпамʼятного Андрія"], "🔴 менеджер із Kommo (через акаунт) не в блоці своєї команди Kommo");
    assert.equal(tree.people.find((p) => p.id === 8)!.unitId, null, "команда Kommo без блоку — «Без блоку», а не чужий блок");
    assert.ok(tree.unknownLabels.some((u) => u.label === "Финансовый отдел — блоку немає"), "🔴 «Без блоку» не каже, що в команди немає блоку");
  } finally { await x.done(); }
});

/**
 * #2852 — ЖИВИЙ SQL КОМАНД ДАШБОРДУ: живуть окремо — `teams` (Звіт, КВП, плани) не росте ні на рядок, а синк Kommo й
 * роут команд Звіту `dashboard_teams` не читають; назва не повторює ні команду Kommo, ні живу команду дашборду; з однією
 * командою Kommo зʼєднана лише одна; архів — лише порожньої (без людей і без блоку), повернення з архіву — лише коли
 * назва вільна; нова назва переписується людям як вітрина; в архівну людину не поставити.
 * 🧨 Червоніє, якщо покласти команду дашборду в `teams`, пустити дубль назви чи друге зʼєднання, архівувати команду з
 * людьми чи з блоком.
 */
test("#2852 ЖИВИЙ SQL КОМАНД ДАШБОРДУ: окремо від teams, назва не дублює Kommo, одне зʼєднання, архів лише порожньої", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    await c.query(`INSERT INTO teams (id, name) VALUES (911, 'РПК - Тест'), (912, 'Финансовый отдел')`);
    await c.query(`INSERT INTO users (id, email, password_hash, role) VALUES (81, 'hr@x.ua', 'x', 'manager')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status) VALUES (21, 'Склад Один', 'k21', 'active')`);
    const tm = await import("./teams.js");
    const db = c as never;
    const kommoBefore = (await c.query(`SELECT count(*)::int AS n FROM teams`)).rows[0].n as number;
    const sklad = await tm.createDashboardTeam(db, 81, { name: " Склад " });
    await assert.rejects(tm.createDashboardTeam(db, 81, { name: "склад" }), code(409), "🔴 дубль живої команди дашборду");
    await assert.rejects(tm.createDashboardTeam(db, 81, { name: "рпк -  тест" }), code(409), "🔴 назва повторює команду Kommo");
    await assert.rejects(tm.createDashboardTeam(db, 81, { name: "  " }), code(400));
    const fin = await tm.createDashboardTeam(db, 81, { name: "Фінвідділ", kommoTeamId: 912 });
    await assert.rejects(tm.createDashboardTeam(db, 81, { name: "Фін два", kommoTeamId: 912 }), code(409), "🔴 дві команди дашборду зʼєднані з однією командою Kommo");
    await assert.rejects(tm.createDashboardTeam(db, 81, { name: "Нема", kommoTeamId: 99999 }), code(400));
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM teams`)).rows[0].n, kommoBefore, "🔴 команда дашборду потрапила в teams — її побачать Звіт, КВП і плани");
    for (const f of ["routes/teams.ts", "jobs/syncKommo.ts", "core/plans.ts", "core/metrics.ts"])
      assert.doesNotMatch(SRC(f), /\bdashboard_teams\b/, `🔴 ${f} читає команди дашборду`);
    let list = await tm.listTeams(db);
    assert.ok(!list.kommo.some((k) => k.name === "Склад"), "🔴 команда дашборду в групі Kommo");
    const finRow = list.dashboard.find((d) => d.id === fin)!;
    assert.deepEqual([finRow.linkedKommoId, finRow.linkedKommoName, finRow.key], [912, "Финансовый отдел", `d:${fin}`]);
    assert.equal(list.dashboard.find((d) => d.id === sklad)!.name, "Склад", "назва без зайвих пробілів");

    await tm.setEmployeeTeam(db, 81, 21, { kind: "dashboard", id: sklad });
    list = await tm.listTeams(db);
    assert.equal(list.dashboard.find((d) => d.id === sklad)!.members, 1);
    await assert.rejects(tm.updateDashboardTeam(db, 81, sklad, { archived: true }), code(409), "🔴 архівовано команду з людьми");
    await tm.updateDashboardTeam(db, 81, sklad, { name: "Склад ЮТС" });
    assert.equal((await c.query(`SELECT team_label FROM employees WHERE id = 21`)).rows[0].team_label, "Склад ЮТС", "🔴 нова назва не переписана людям як вітрина");
    await tm.setEmployeeTeam(db, 81, 21, null);
    const ceo = (await c.query(`SELECT id FROM org_units WHERE seed_key = 'ceo'`)).rows[0].id;
    const blk = (await c.query(`INSERT INTO org_units (parent_id, name, dept, dashboard_team_id) VALUES ($1, 'Склад', 'top', $2) RETURNING id`, [ceo, sklad])).rows[0].id;
    await assert.rejects(tm.updateDashboardTeam(db, 81, sklad, { archived: true }), code(409), "🔴 архівовано команду, привʼязану до блоку");
    await c.query(`DELETE FROM org_units WHERE id = $1`, [blk]);
    await tm.updateDashboardTeam(db, 81, sklad, { archived: true });
    await assert.rejects(tm.setEmployeeTeam(db, 81, 21, { kind: "dashboard", id: sklad }), code(400), "🔴 людину поставлено в архівну команду");
    // Назва архівної вільна; повернути архівну, поки назва зайнята, — 409; цикл «архів → повернути» проходить.
    const twin = await tm.createDashboardTeam(db, 81, { name: "Склад ЮТС" });
    await assert.rejects(tm.updateDashboardTeam(db, 81, sklad, { archived: false }), code(409), "🔴 повернуто з архіву команду, чия назва зайнята");
    await tm.updateDashboardTeam(db, 81, twin, { archived: true });
    await tm.updateDashboardTeam(db, 81, sklad, { archived: false });
    assert.equal((await tm.listTeams(db)).dashboard.find((d) => d.id === sklad)!.archived, false, "🔴 повернення з архіву не спрацювало");
    await tm.updateDashboardTeam(db, 81, fin, { kommoTeamId: null });
    assert.equal((await tm.listTeams(db)).dashboard.find((d) => d.id === fin)!.linkedKommoId, null, "🔴 відʼєднати від Kommo не вийшло");
    const acts = (await c.query(`SELECT action FROM org_log WHERE action LIKE 'team.%' ORDER BY id`)).rows.map((r) => r.action);
    assert.deepEqual(acts.filter((a) => a === "team.create").length, 3, `🔴 журнал створення команд: ${acts.join(", ")}`);
    assert.ok(acts.includes("team.update"));
  } finally { await x.done(); }
});

/**
 * #2853 — ЖИВИЙ SQL «МОЄ» І ПЕРЕТЯГУВАННЯ: нік — у СВІЙ рядок реєстру (за акаунтом), без рядка — 404, сміття — 400 без
 * запису; перемістити людину = поставити їй команду блоку (дашборду або Kommo) з аудитом реєстру й рядком журналу;
 * людину з групою в Kommo не перемістити — 409 без запису; блок без команди — 409; «Без блоку» — команда знімається.
 * 🧨 Червоніє, якщо нік піде в чужий рядок, переміщення змінить команду людини з Kommo, обійде аудит або не лишить журналу.
 */
test("#2853 ЖИВИЙ SQL: свій нік — у свій рядок; перетягнути = команда блоку + аудит + журнал; людину з Kommo — 409", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    await c.query(`INSERT INTO teams (id, name) VALUES (921, 'РПК - Тест')`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (821, 'Менеджер Kommo', 921)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role) VALUES (71, 'hr@x.ua', 'x', 'manager'), (72, 'me@x.ua', 'x', 'manager'), (73, 'no@x.ua', 'x', 'manager')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status, team_label, telegram, user_id, manager_id) VALUES
      (11, 'Я Сам', 'k11', 'active', '3', NULL, 72, NULL), (12, 'Інший', 'k12', 'active', NULL, '@other_uts', NULL, NULL),
      (13, 'Менеджер Kommo', 'k13', 'active', NULL, NULL, NULL, 821)`);
    const o = await import("./orgTree.js");
    const db = c as never;
    assert.equal(await o.setMyTelegram(db, 72, " https://t.me/sam_uts "), "@sam_uts");
    const tg = async (id: number) => (await c.query(`SELECT telegram FROM employees WHERE id = $1`, [id])).rows[0].telegram;
    assert.equal(await tg(11), "@sam_uts"); assert.equal(await tg(12), "@other_uts", "🔴 нік записано не в свій рядок");
    await assert.rejects(o.setMyTelegram(db, 72, "@a    @b"), code(400), "🔴 сміття прийнято за нік");
    assert.equal(await tg(11), "@sam_uts", "🔴 відмова все одно переписала нік");
    await assert.rejects(o.setMyTelegram(db, 73, "@nobody_uts"), code(404), "🔴 акаунт без рядка «Найму» щось записав");
    assert.equal(await o.setMyTelegram(db, 72, ""), null, "порожньо — прибрати свій нік");

    const id = async (k: string) => (await c.query(`SELECT id FROM org_units WHERE seed_key = $1`, [k])).rows[0].id as number;
    const fin2 = await id("fin2"), ceo = await id("ceo"), sales = await id("sales");
    const buh = (await c.query(`SELECT dashboard_team_id FROM org_units WHERE id = $1`, [fin2])).rows[0].dashboard_team_id as number;
    const bare = (await c.query(`INSERT INTO org_units (parent_id, name, dept) VALUES ($1, 'Без команди', 'top') RETURNING id`, [ceo])).rows[0].id as number;
    const rpk = (await c.query(`INSERT INTO org_units (parent_id, name, dept, team_id) VALUES ($1, 'РПК Тест', 'sales', 921) RETURNING id`, [sales])).rows[0].id as number;
    const team = async (eid: number) => (await c.query(`SELECT team_id, dashboard_team_id, team_label FROM employees WHERE id = $1`, [eid])).rows[0];
    await o.moveEmployee(db, 71, 12, fin2);
    assert.deepEqual(await team(12), { team_id: null, dashboard_team_id: buh, team_label: "Бухгалтерія" }, "🔴 переміщення не поставило команду блоку");
    const audit = (await c.query(`SELECT action, details FROM access_audit WHERE target_id = 'e12' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(audit?.action, "employees.update", "🔴 переміщення обійшло аудит реєстру");
    assert.deepEqual(audit.details, { changed: ["dashboard_team_id", "team_label"] }, "в аудиті — назви полів, без значень (правило реєстру)");
    const lg = (await c.query(`SELECT action, actor_id, before, after FROM org_log WHERE employee_id = 12 ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.deepEqual([lg.action, lg.actor_id, lg.before, lg.after], ["move", 71, { team_label: null }, { team_label: "Бухгалтерія" }], "🔴 журнал без старого значення");
    await assert.rejects(o.moveEmployee(db, 71, 12, bare), code(409), "🔴 переміщення в блок без команди");
    await o.moveEmployee(db, 71, 12, rpk);
    assert.deepEqual(await team(12), { team_id: 921, dashboard_team_id: null, team_label: "РПК - Тест" }, "🔴 людину без Kommo не поставлено в команду Kommo");
    await assert.rejects(o.moveEmployee(db, 71, 13, fin2), code(409), "🔴 перетягнуто людину, чия команда — з Kommo");
    assert.deepEqual(await team(13), { team_id: null, dashboard_team_id: null, team_label: null }, "🔴 відмова все одно змінила команду людини з Kommo");
    await o.moveEmployee(db, 71, 12, null);
    assert.deepEqual(await team(12), { team_id: null, dashboard_team_id: null, team_label: null }, "«Без блоку» — команда знімається");
    const tree = await o.loadOrg(db, 72);
    assert.equal(tree.people.find((p) => p.id === 11)!.isMe, true);
    assert.equal(tree.people.find((p) => p.id === 12)!.unitId, null);
    assert.deepEqual([tree.people.find((p) => p.id === 13)!.unitId, tree.people.find((p) => p.id === 13)!.teamLocked], [rpk, true], "🔴 людина з Kommo не в блоці своєї команди");
  } finally { await x.done(); }
});

/**
 * #2854 — ЖИВИЙ SQL БЛОКІВ: люди належать КОМАНДІ — перейменування блоку їх не рухає; зміна команди блоку з людьми — 409
 * (інакше вони мовчки випали б у «Без блоку»); одна команда — один блок, і зʼєднана команда дашборду рахується як своя
 * команда Kommo; коло — 400; «збоку» без батька — 400; непорожній і з підпорядкованими не видаляються; кривий ключ — 400.
 * 🧨 Червоніє, якщо дозволити змінити команду блоку з людьми, пустити два блоки на одну команду (зокрема через
 * зʼєднання) або прибрати перевірку кола чи непорожнього видалення.
 */
test("#2854 ЖИВИЙ SQL: блок за командою — перейменування не рухає людей, зміна команди з людьми 409, одна команда — один блок", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    await c.query(`INSERT INTO teams (id, name) VALUES (911, 'РПК - Тест'), (912, 'Финансовый отдел')`);
    await c.query(`INSERT INTO users (id, email, password_hash, role) VALUES (81, 'ba@x.ua', 'x', 'manager')`);
    await c.query(`INSERT INTO employees (id, full_name, import_key, status, team_label) VALUES
      (21, 'Бухгалтер Один', 'k21', 'active', 'бухгалтерія'), (22, 'Бухгалтер Два', 'k22', 'active', 'Бухгалтерія'),
      (23, 'Звільнений', 'k23', 'dismissed', 'Бухгалтерія')`);
    await c.query(x.schema); // викат розставляє команди за текстом
    const o = await import("./orgTree.js");
    const tm = await import("./teams.js");
    const db = c as never;
    const id = async (k: string) => (await c.query(`SELECT id FROM org_units WHERE seed_key = $1`, [k])).rows[0].id as number;
    const fin2 = await id("fin2"), ops = await id("ops"), ceo = await id("ceo"), sales = await id("sales");
    const buh = (await c.query(`SELECT dashboard_team_id FROM org_units WHERE id = $1`, [fin2])).rows[0].dashboard_team_id as number;
    const members = async (uid: number) => (await o.loadOrg(db, null)).units.find((u) => u.id === uid)!.memberIds.sort((a, b) => a - b);
    assert.deepEqual(await members(fin2), [21, 22], "передумова: бухгалтери в блоці «Бухгалтерія»");
    await o.updateUnit(db, 81, fin2, { name: "Бухгалтерія ЮТС" });
    assert.deepEqual(await members(fin2), [21, 22], "🔴 перейменування блоку зрушило людей");
    await assert.rejects(o.updateUnit(db, 81, fin2, { team: null }), code(409), "🔴 блок із людьми лишився без команди");
    await assert.rejects(o.updateUnit(db, 81, fin2, { team: "k:911" }), code(409), "🔴 блок із людьми змінив команду");
    await assert.rejects(o.updateUnit(db, 81, ops, { team: `d:${buh}` }), code(409), "🔴 одна команда дашборду — у двох блоках");
    const linked = await tm.createDashboardTeam(db, 81, { name: "Фінвідділ", kommoTeamId: 912 });
    await o.createUnit(db, 81, { name: "Фін Kommo", parentId: ops, dept: "fin", team: "k:912" });
    await assert.rejects(o.createUnit(db, 81, { name: "Фін зʼєднаний", parentId: ops, dept: "fin", team: `d:${linked}` }), code(409),
      "🔴 зʼєднана команда дашборду отримала другий блок для тих самих людей");
    const a = await o.createUnit(db, 81, { name: "Нова команда", parentId: sales, dept: "sales", team: "k:911" });
    await assert.rejects(o.createUnit(db, 81, { name: "Двійник", parentId: sales, dept: "sales", teamId: 911 }), code(409), "🔴 одна команда — у двох блоках");
    await assert.rejects(o.createUnit(db, 81, { name: "Кривий", parentId: sales, dept: "sales", team: "x:1" }), code(400));
    await assert.rejects(o.createUnit(db, 81, { name: "Збоку", dept: "top", side: true }), code(400), "🔴 «збоку» без батька");
    await assert.rejects(o.updateUnit(db, 81, ceo, { parentId: fin2 }), code(400), "🔴 коло підпорядкування");
    await assert.rejects(o.deleteUnit(db, 81, fin2), code(409), "🔴 видалено блок із людьми");
    await assert.rejects(o.deleteUnit(db, 81, sales), code(409), "🔴 видалено блок із підпорядкованими");
    await o.deleteUnit(db, 81, a);
    assert.equal((await c.query(`SELECT 1 FROM org_units WHERE id = $1`, [a])).rowCount, 0, "порожній блок видаляється");
    const acts = (await c.query(`SELECT action FROM org_log WHERE action LIKE 'unit.%' ORDER BY id`)).rows.map((r) => r.action);
    assert.deepEqual(acts, ["unit.update", "unit.create", "unit.create", "unit.delete"], `🔴 журнал блоків: ${acts.join(", ")}`);
  } finally { await x.done(); }
});

/**
 * #2705 — ДОСТУП: вкладка `org` — УСІМ ролям, включно з кандидатом; право `edit_org` — рівно admin, HR, БА, і після
 * ДРУГОГО прогону схеми теж (синк копіює права адміна керівництву й фінансисту — без зняття воно б розтеклось).
 * Роутер: вкладка ще раз першим middleware, кожен запис у схему — під `edit_org`, «моє» не читає id із запиту.
 * 🧨 Червоніє, якщо поставити видачу права вище синків без зняття, забути `requirePerm` на одному роуті, або дати
 * «моєму» роуту `req.params`.
 */
test("#2705 ДОСТУП: org — усім, edit_org — admin/HR/БА після двох прогонів, запис — під правом, «моє» — без id", async (t) => {
  const tab = SRC("auth/routeTab.ts");
  assert.match(tab, /\{ test: pre\("\/api\/org"\), tabs: \["org"\] \}/, "🔴 немає межі вкладки для /api/org");
  const r = SRC("routes/org.ts");
  assert.match(r, /orgRouter\.use\(requireAuth\);\s*\norgRouter\.use\(\(req, res, next\) => \{\s*\n\s*if \(!req\.auth \|\| !roleHasTab\(req\.auth\.roleKey, "org"\)\)/, "🔴 друга лінія (вкладка на роутері) зникла");
  const routes = [...r.matchAll(/orgRouter\.(get|post|put|patch|delete)\("([^"]+)"(, requirePerm\("edit_org"\))?/g)].map((m) => ({ m: m[1], p: m[2], perm: !!m[3] }));
  assert.equal(routes.length, 8, `🔴 роутів орг-структури ${routes.length}, а не 8 — матриця й гейт розійдуться`);
  for (const x of routes) {
    const mine = x.p.startsWith("/me/") || x.p === "/tree";
    assert.equal(x.perm, !mine, `🔴 ${x.m.toUpperCase()} ${x.p}: ${mine ? "«моє»/перегляд під правом редагування" : "запис без edit_org"}`);
  }
  for (const p of ["/me/telegram", "/me/photo"]) {
    const body = r.slice(r.indexOf(`"${p}"`), r.indexOf("});", r.indexOf(`"${p}"`)));
    assert.ok(!/req\.params|req\.body\??\.(employeeId|id)\b/.test(body), `🔴 ${p} читає id людини з запиту`);
  }
  const schema = SRC("db/schema.sql");
  assert.match(schema, /UPDATE roles SET screen_access = screen_access \|\| '\{"org":true\}'::jsonb\s*\n\s*WHERE NOT \(screen_access \? 'org'\);/, "🔴 вкладка org — не всім ролям");
  const x = await scratch(t); if (!x) return;
  try {
    await x.c.query(x.schema);
    await x.c.query(x.schema);
    const rows = (await x.c.query(`SELECT key, (screen_access->>'org')::boolean AS tab, COALESCE((permissions->>'edit_org')::boolean, false) AS edit FROM roles ORDER BY key`)).rows;
    assert.ok(rows.length >= 9, "ролей мало — сід не відпрацював");
    assert.deepEqual(rows.filter((x) => !x.tab).map((x) => x.key), [], "🔴 ролі без вкладки «Орг структура»");
    assert.ok(rows.some((x) => x.key === "candidate" && x.tab), "🔴 кандидат не бачить схеми (рішення Романа 27.10)");
    assert.deepEqual(rows.filter((x) => x.edit).map((x) => x.key), ["admin", "business_assistant", "hr"], "🔴 edit_org розтеклось або загубилось");
  } finally { await x.done(); }
});

/**
 * #2855 — ДОСТУП ДО КОМАНД: список — усім, хто бачить орг-структуру (вкладка `org`, межа `pre("/api/org")` і друга
 * лінія на роутері); КОЖЕН запис — право `manage_teams`, і воно рівно в admin, СЕО, ОД, HR (рішення Романа 27.10, п.1)
 * після ДРУГОГО прогону схеми. Роутер змонтовано ДО `orgRouter`, інакше `/api/org/teams` ловив би той.
 * 🧨 Червоніє, якщо забути `requirePerm` на одному роуті запису, роздати право ширше чи загубити його в HR, або змонтувати
 * роутер після `orgRouter`.
 */
test("#2855 ДОСТУП ДО КОМАНД: список — вкладка org, запис — manage_teams = admin/СЕО/ОД/HR після двох прогонів", async (t) => {
  const r = SRC("routes/orgTeams.ts");
  assert.match(r, /orgTeamsRouter\.use\(requireAuth\);\s*\norgTeamsRouter\.use\(\(req, res, next\) => \{\s*\n\s*if \(!req\.auth \|\| !roleHasTab\(req\.auth\.roleKey, "org"\)\)/, "🔴 друга лінія (вкладка на роутері) зникла");
  const routes = [...r.matchAll(/orgTeamsRouter\.(get|post|put|patch|delete)\("([^"]+)"(, requirePerm\("manage_teams"\))?/g)].map((m) => ({ m: m[1], p: m[2], perm: !!m[3] }));
  assert.equal(routes.length, 4, `🔴 роутів команд ${routes.length}, а не 4 — матриця й гейт розійдуться`);
  for (const x of routes) assert.equal(x.perm, x.m !== "get", `🔴 ${x.m.toUpperCase()} ${x.p}: ${x.m === "get" ? "перегляд під правом" : "запис без manage_teams"}`);
  const idx = SRC("index.ts");
  const at = (s: string) => idx.indexOf(s);
  assert.ok(at(`app.use("/api/org/teams", orgTeamsRouter)`) > 0 && at(`app.use("/api/org/teams", orgTeamsRouter)`) < at(`app.use("/api/org", orgRouter)`),
    "🔴 роутер команд змонтовано не перед orgRouter (або не змонтовано)");
  assert.match(SRC("auth/permGrant.ts"), /\n\s*"manage_teams",\n/, "🔴 права manage_teams немає в каталозі");
  assert.match(FSRC("pages/dashboard/sections/SettingsSection.tsx"), /\{ key: "manage_teams", label:/, "🔴 тумблера manage_teams немає в «Ролях»");
  const x = await scratch(t); if (!x) return;
  try {
    await x.c.query(x.schema);
    await x.c.query(x.schema);
    const rows = (await x.c.query(`SELECT key, COALESCE((permissions->>'manage_teams')::boolean, false) AS m FROM roles ORDER BY key`)).rows;
    assert.ok(rows.length >= 9, "ролей мало — сід не відпрацював");
    assert.deepEqual(rows.filter((r) => r.m).map((r) => r.key), ["admin", "ceo", "hr", "opdir"], "🔴 manage_teams розтеклось або загубилось");
  } finally { await x.done(); }
});


/**
 * #2714 (було #2710) — ФРОНТ: «Компанія → Орг структура» групою меню ОДРАЗУ ПІД «Роботою» (Роман 27.10.2026: «на низ … під роботою»;
 * до того — першою, гейт `#2706` у відставці) з позначкою «НОВЕ» до дати; статичний імпорт (#225);
 * стартова вкладка ролі НЕ стає «org» (бухгалтерія й БА без «Звіту» лишаються на своїй першій вкладці); дат у секції немає,
 * а ТЕЛЕФОН — лише в картці людини, посиланням `tel:` (рішення Романа 28.10.2026), не в списку й не на блоках.
 * 🧨 Червоніє, якщо повернути групу першою (чи будь-куди, крім місця під «Роботою»), дозволити homeSection обрати «org»,
 * лінивий імпорт секції, показати дату народження, прибрати телефон з картки або винести його в список.
 */
test("#2714 ФРОНТ: група «Компанія» одразу під «Роботою», НОВЕ до дати, статичний імпорт, стартова вкладка не «org», телефон лише в картці", async () => {
  const lay = FSRC("components/Layout.tsx");
  const navSrc = lay.slice(lay.indexOf("export const NAV_GROUPS = ["), lay.indexOf("\n];", lay.indexOf("export const NAV_GROUPS = [")));
  const groups = [...navSrc.matchAll(/^    label: "([^"]+)",$/gm)].map((m) => m[1]);
  assert.ok(groups.length >= 5 && groups.includes("Робота"), `🔴 групи меню не прочитались: ${groups.join(", ")}`);
  assert.equal(groups[groups.indexOf("Робота") + 1], "Компанія", `🔴 «Компанія» не одразу під «Роботою»: ${groups.join(" → ")}`);
  const company = navSrc.slice(navSrc.indexOf('label: "Компанія"'));
  assert.match(company.slice(0, company.indexOf("],")), /key: "org", label: "Орг структура"/, "🔴 «Орг структура» не в групі «Компанія»");
  assert.match(lay, /const ORG_NEW_UNTIL = "\d{4}-\d{2}-\d{2}"/, "🔴 позначка «НОВЕ» без кінцевої дати");
  const dash = FSRC("pages/Dashboard.tsx");
  assert.match(dash, /import \{ OrgSection \} from "\.\/dashboard\/sections\/OrgSection";/, "🔴 секція не статичним імпортом (#225)");
  assert.match(dash, /\{section === "org" && <OrgSection \/>\}/);
  const ts = await import("typescript");
  const js = ts.transpileModule(FSRC("pages/dashboard/homeSection.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { homeSection } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const nav = ["org", "report", "receivables", "ba", "bank"];
  assert.equal(homeSection({ roleKey: "business_assistant", screens: ["org", "ba"], navKeys: nav }), "ba", "🔴 БА стартує на орг-структурі");
  assert.equal(homeSection({ roleKey: "____________", screens: ["org", "bank", "receivables"], navKeys: nav }), "receivables", "🔴 бухгалтерія стартує на орг-структурі");
  assert.equal(homeSection({ roleKey: "manager", screens: ["org", "report"], navKeys: nav }), "report", "дзеркало: «Звіт» лишається");
  assert.equal(homeSection({ roleKey: "x", screens: ["org"], navKeys: nav }), "org", "дзеркало: якщо більше нічого — схема");
  const sec = FSRC("pages/dashboard/sections/OrgSection.tsx");
  assert.ok(!/birth|народж/i.test(sec), "🔴 у секції орг-структури дата народження");
  const card = sec.slice(sec.indexOf("function PersonCard("), sec.indexOf("function UnitDialog("));
  assert.match(card, /p\.phone\.tel \? <a className="org-tel" href=\{`tel:\$\{p\.phone\.tel\}`\}>\{p\.phone\.text\}<\/a>/, "🔴 у картці немає телефону посиланням tel:");
  assert.match(card, /!p\.phone \? <span className="hr-muted">не вказано<\/span>/, "🔴 порожній телефон не підписаний «не вказано»");
  const outside = sec.slice(0, sec.indexOf("function PersonCard("));
  assert.ok(!/phone/.test(outside), "🔴 телефон вийшов за межі картки (список чи блоки дерева)");
  assert.match(sec, /href=\{`https:\/\/t\.me\/\$\{/, "🔴 немає кнопки «Telegram» на t.me/<нік>");
});

/**
 * #2716 (було #2711) — ПЛАВНІСТЬ 2 (Роман 28.10.2026: «не дуже плавні згортання і розгортання дерева»): картка виїжджає й
 * ховається; люди блоку і гілки дерева РОЗГОРТАЮТЬСЯ висотою від нуля (`org-open`) і так само ЗГОРТАЮТЬСЯ (`org-close`) —
 * згорнуте лишається в DOM рівно на час анімації (`FOLD_MS` == тривалість `org-close` у CSS), а не зникає ривком;
 * «менше руху» вимикає все — і в CSS, і в згортанні (тоді блок закривається одразу, без таймера).
 * 🧨 Червоніє, якщо згортання знову миттєве (немає стану `closing` чи таймера), тривалості в коді й CSS розійдуться,
 * люди блоку зʼявлятимуться без обгортки згортання або зникне повага до «менше руху».
 */
test("#2716 ПЛАВНІСТЬ 2: картка й згортання дерева в обидва боки, таймер = CSS, «менше руху» вимикає все", () => {
  const sec = FSRC("pages/dashboard/sections/OrgSection.tsx");
  const card = sec.slice(sec.indexOf("function PersonCard("), sec.indexOf("function UnitDialog("));
  assert.match(card, /const close = \(\) => \{ if \(calm\(\)\) return onClose\(\); setLeaving\(true\); window\.setTimeout\(onClose, CARD_OUT_MS\); \};/, "🔴 картка закривається без анімації або ігнорує «менше руху»");
  assert.match(card, /useEscape\(close\)/, "🔴 Esc закриває картку ривком, повз анімацію");
  assert.ok(!/onClick=\{onClose\}/.test(card.slice(0, card.indexOf("photoDlg &&"))), "🔴 фон чи «Закрити» обривають анімацію (onClose напряму)");
  assert.match(sec, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/, "🔴 закриття не питає систему про «менше руху»");
  assert.match(sec, /const toggle = \(id: number\) => fold\(\[id\], opened\.has\(id\) && !closing\.has\(id\)\);/, "🔴 «Згорнути» обходить плавне згортання");
  const fold = sec.slice(sec.indexOf("const fold = "), sec.indexOf("const toggle = "));
  assert.match(fold, /if \(calm\(\)\) return drop\(ids\);/, "🔴 при «менше руху» згортання все одно чекає анімацію");
  assert.match(fold, /setClosing\(\(c\) => new Set\(\[\.\.\.c, \.\.\.ids\]\)\);[\s\S]*window\.setTimeout\([\s\S]*drop\(\[id\]\)[\s\S]*FOLD_MS\)/, "🔴 згорнуте зникає одразу, а не після анімації");
  assert.match(fold, /window\.clearTimeout\(foldTimers\.current\.get\(id\)\)/, "🔴 повторне розгортання під час згортання не скасовує таймер — блок закриється сам");
  assert.match(sec, /<div className=\{`org-fold \$\{out \? "out" : ""\}`\}><div className="org-fold-in"><div className="org-members">/, "🔴 люди блоку зʼявляються без обгортки згортання");
  assert.match(sec, /<div className=\{`org-fold sub \$\{out \? "out" : ""\}`\}><div className="org-fold-in">\{sub\}<\/div><\/div>/, "🔴 гілки дерева розгортаються без обгортки згортання");
  const css = FSRC("pages/dashboard/sections/org.css");
  assert.match(css, /@keyframes org-open \{ from \{ grid-template-rows: 0fr;/, "🔴 розгортання не від нульової висоти");
  assert.match(css, /@keyframes org-close \{ from \{ grid-template-rows: 1fr; opacity: 1; \} to \{ grid-template-rows: 0fr;/, "🔴 згортання не до нульової висоти");
  const ms = Number(/const FOLD_MS = (\d+);/.exec(sec)?.[1]);
  const cssMs = Math.round(Number(/\.org-fold\.out \{ animation: org-close ([\d.]+)s/.exec(css)?.[1]) * 1000);
  assert.ok(ms > 0 && ms === cssMs, `🔴 таймер згортання ${ms} мс ≠ анімація ${cssMs} мс — вміст зникне посеред анімації або повисить порожнім`);
  assert.match(css, /\.org-drawer \{ animation: org-slide/, "🔴 картка не виїжджає");
  assert.match(css, /\.org-drawer\.out \{ transform: translateX\(100%\); \}/, "🔴 картка не ховається");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.org \*, \.org-scrim, \.org-drawer \{ animation: none !important; transition: none !important; \}/, "🔴 «менше руху» не вимикає анімацій");
});

/**
 * #2713 — ТЕЛЕФОН ОДНИМ ВИГЛЯДОМ (рішення Романа 28.10.2026: «номери телефонів мають бути також в карточках»). У «Наймі»
 * шість форматів (заміряно на проді 28.10: 0XXXXXXXXX ×41, +380… ×7, 380… ×5, з пробілами й дефісами ×5, 9 цифр ×3) —
 * у картці один «+380 XX XXX XX XX» і `tel:`. Нерозпізнане (два номери, закордонний, текст) — як записано, без посилання;
 * порожнє й сентинел («-») — `null`.
 * 🧨 Червоніє, якщо загубити +380, приклеїти зайвий нуль, зробити посилання з нерозпізнаного або сховати його.
 */
test("#2713 ТЕЛЕФОН: шість форматів «Найму» → +380 XX XXX XX XX і tel:, нерозпізнане — як записано, порожнє — null", async () => {
  const { phoneView } = await import("./orgTree.js");
  const ok = { text: "+380 50 111 22 33", tel: "+380501112233" };
  for (const raw of ["0501112233", "+380501112233", "380501112233", "050 111-22-33", "(050) 111 22 33", "501112233", "501 112 233", " 0501112233 "])
    assert.deepEqual(phoneView(raw), ok, `🔴 «${raw}» не зведено до одного вигляду`);
  for (const raw of ["0501112233, 0671112233", "+48 601 234 567", "05011122", "0050111223344", "дзвонити Ользі"])
    assert.deepEqual(phoneView(raw), { text: raw, tel: null }, `🔴 нерозпізнане «${raw}» перекручене або стало посиланням`);
  for (const raw of [null, undefined, "", "   ", "-", "—"]) assert.equal(phoneView(raw), null, `🔴 порожнє чи сентинел «${raw}» не стало «не вказано»`);
});

/**
 * #2715 — РОЗКЛАДКА: ВІДДІЛ ОКРЕМОЮ ГІЛКОЮ (рішення Романа 28.10.2026: «лідогени окремо, над ними напис „маркетинговий
 * відділ“, але теж від КВП тягнуться»). Прості команди під блоком — сіткою по чотири, якщо їх більше чотирьох; дитина з
 * власними блоками — окремою гілкою від того самого блоку, поруч із сіткою. Чотири й менше простих — усі гілками, як було
 * (саме так стоїть «Операційне управління»: 4 відділи + Комерційний).
 * 🧨 Червоніє, якщо відділ із власними блоками знову потрапить у сітку команд, сітка перестане ділитись по чотири або межа
 * «більше чотирьох» зсунеться.
 */
test("#2715 РОЗКЛАДКА: відділ із власними блоками — окремою гілкою, команди — сіткою по чотири, межа 4/5", async () => {
  const ts = await import("typescript");
  const js = ts.transpileModule(FSRC("pages/dashboard/sections/orgLayout.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { splitKids } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const deep = new Set(["mk", "sales"]);
  const has = (c: string) => deep.has(c);
  assert.deepEqual(splitKids(["mk", "t1", "t2", "t3", "t4", "t5", "t6"], has), { branches: ["mk"], rows: [["t1", "t2", "t3", "t4"], ["t5", "t6"]] },
    "🔴 «Маркетинговий відділ» не окремою гілкою або команди не сіткою по чотири");
  assert.deepEqual(splitKids(["hr", "fin1", "fin2", "it", "sales"], has), { branches: ["hr", "fin1", "fin2", "it", "sales"], rows: [] },
    "🔴 «Операційне управління» (4 відділи + Комерційний) розкладено інакше, ніж було");
  assert.deepEqual(splitKids(["t1", "t2", "t3", "t4", "t5"], has), { branches: [], rows: [["t1", "t2", "t3", "t4"], ["t5"]] }, "🔴 пʼять команд не сіткою");
  assert.deepEqual(splitKids(["t1", "t2", "t3", "t4"], has).rows, [], "дзеркало: чотири команди — рядом, без сітки");
  const sec = FSRC("pages/dashboard/sections/OrgSection.tsx");
  const br = sec.slice(sec.indexOf("const branch = "), sec.indexOf("const unitName = "));
  assert.match(br, /splitKids\(ch, \(c\) => kids\(c\.id\)\.length > 0\)/, "🔴 дерево не бере розкладку з splitKids");
  assert.match(br, /branches\.length \? <ul>\{branches\.map\(branch\)\}<li key="grid" className="org-gridli">\{grid\}<\/li><\/ul>/, "🔴 окрема гілка й сітка не поруч від одного блоку");
  assert.match(FSRC("pages/dashboard/sections/org.css"), /\.org-gridli > \.org-vgrid \{ padding-top: 0; \}/, "🔴 сітка під гілкою з подвійним стовбуром");
});

/**
 * #2717 — ЛІНІЇ ВИДНО (Роман 28.10.2026: «лінії трошки сірі і вузькі, нічого не видно»): усі зʼєднання дерева — однією
 * парою змінних `--org-lw` (2px) і `--org-line` (колір підписів теми, а не рамки), у світлій і темній темі однаково.
 * 🧨 Червоніє, якщо повернути 1.5px чи колір рамки хоч в одному зʼєднанні або звузити лінію.
 */
test("#2717 ЛІНІЇ: зʼєднання дерева 2px кольором підписів, жодного 1.5px чи кольору рамки", () => {
  const css = FSRC("pages/dashboard/sections/org.css");
  assert.match(css, /\.org \{[^}]*--org-line: var\(--text-muted\); --org-lw: 2px; \}/, "🔴 лінії знову тонкі або кольору рамки");
  const lines = css.split("\n").filter((l) => /^\.org-(tree|vgrid|vrow|side)[^{]*\{[^}]*border-(top|left|right):/.test(l));
  assert.ok(lines.length >= 8, `🔴 правил зʼєднань знайдено ${lines.length} — гейту нема що перевіряти`);
  for (const l of lines) assert.match(l, /border-(top|left|right): var\(--org-lw\) (solid|dashed) var\(--org-line\)/, `🔴 зʼєднання не на змінних: ${l}`);
  assert.ok(!/(?<![\d.])1\.5px/.test(css), "🔴 у стилях орг-структури лишилось 1.5px");
});

/**
 * #2718 — ЖИВИЙ SQL «МАРКЕТИНГОВИЙ ВІДДІЛ» (рішення Романа 28.10.2026): разово під «Комерційним відділом» зʼявляється
 * блок-контейнер без команди, і Лідогенерація переходить у нього — лише якщо досі стоїть під КВП; у журнал — один рядок.
 * Повторний викат нічого не дублює; видалений руками блок не повертається; Лідогенерацію, яку вже перенесли деінде, не
 * чіпає.
 * 🧨 Червоніє, якщо прибрати позначку разовості, переносити Лідогенерацію безумовно або дати блоку команду.
 */
test("#2718 ЖИВИЙ SQL: «Маркетинговий відділ» разово під КВП, Лідогенерація в нього, видалене не повертається", async (t) => {
  const x = await scratch(t); if (!x) return;
  const { c } = x;
  try {
    await c.query(x.schema);
    const u = async (k: string) => (await c.query(`SELECT id, parent_id, name, team_id, dashboard_team_id, label FROM org_units WHERE seed_key = $1`, [k])).rows[0];
    const logN = async () => (await c.query(`SELECT count(*)::int AS n FROM org_log WHERE action = 'migration' AND summary LIKE '%Маркетинговий відділ%'`)).rows[0].n as number;
    const sales = await u("sales"), mk = await u("marketing");
    assert.ok(mk, "🔴 блоку «Маркетинговий відділ» немає");
    assert.deepEqual([mk.parent_id, mk.name, mk.team_id, mk.dashboard_team_id, mk.label], [sales.id, "Маркетинговий відділ", null, null, null],
      "🔴 «Маркетинговий відділ» не контейнером під «Комерційним відділом»");
    assert.equal((await u("lid")).parent_id, mk.id, "🔴 Лідогенерація не перейшла в «Маркетинговий відділ»");
    assert.equal(await logN(), 1, "🔴 у журналі не рівно один запис про новий блок");
    await c.query(x.schema);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM org_units WHERE name = 'Маркетинговий відділ'`)).rows[0].n, 1, "🔴 повторний викат задублював блок");
    assert.equal(await logN(), 1, "🔴 повторний викат задублював запис у журналі");
    // Руками: Лідогенерацію повернули під КВП, блок видалили — наступний викат цього не відкочує.
    await c.query(`UPDATE org_units SET parent_id = $1 WHERE seed_key = 'lid'`, [sales.id]);
    await c.query(`DELETE FROM org_units WHERE seed_key = 'marketing'`);
    await c.query(x.schema);
    assert.equal(await u("marketing"), undefined, "🔴 видалений руками блок повернувся наступним викатом");
    assert.equal((await u("lid")).parent_id, sales.id, "🔴 викат знову переніс Лідогенерацію");
    // Дзеркало: база, де разовий крок ще не йшов, але Лідогенерацію вже перенесли деінде, — блок є, Лідогенерація лишається.
    const ops = await u("ops");
    await c.query(`UPDATE org_units SET parent_id = $1 WHERE seed_key = 'lid'`, [ops.id]);
    await c.query(`DELETE FROM org_migrations WHERE key = 'marketing-2026-10-28'`);
    await c.query(x.schema);
    assert.ok(await u("marketing"), "дзеркало: без позначки крок виконується");
    assert.equal((await u("lid")).parent_id, ops.id, "🔴 Лідогенерацію, перенесену руками, крок забрав у маркетинг");
  } finally { await x.done(); }
});

/**
 * #2709 — ЕТАП 2 = ЛИШЕ ВІДКРИТИ TELEGRAM (рішення Романа 27.10.2026: «не можна слати повідомлення … тільки відкривання
 * телеграма»). «Написати» є і в картці, і в кожному рядку списку — посиланням на t.me/<нік>, лише коли нік є; поля
 * повідомлення, кнопки «Надіслати» й виклику месенджера в секції немає.
 * 🧨 Червоніє, якщо прибрати «Написати» зі списку, показати його без ніка або додати відправку повідомлення.
 */
test("#2709 ЕТАП 2: «Написати» в картці й у списку відкриває t.me/<нік>, лише з ніком; надсилання з дашборда немає", () => {
  const sec = FSRC("pages/dashboard/sections/OrgSection.tsx");
  const list = sec.slice(sec.indexOf('<table className="org-list">'), sec.indexOf("</table>"));
  assert.ok(list.length > 0, "🔴 таблицю списку не знайдено — гейту нема що перевіряти");
  assert.match(list, /\{p\.telegram && <a [^>]*href=\{`https:\/\/t\.me\/\$\{p\.telegram\.slice\(1\)\}`\}[^>]*>Написати<\/a>\}/, "🔴 у рядку списку немає «Написати» на t.me/<нік> під умовою ніка");
  assert.match(list, /colSpan=\{5\}/, "🔴 колонку додано, а порожній рядок «Нікого не знайдено» не розтягнуто на неї");
  const card = sec.slice(sec.indexOf("function PersonCard("), sec.indexOf("function UnitDialog("));
  assert.match(card, /\{p\.telegram && \([\s\S]*?href=\{`https:\/\/t\.me\/\$\{p\.telegram\.slice\(1\)\}`\}[\s\S]*?>Написати в Telegram<\/a>/, "🔴 у картці немає «Написати в Telegram» під умовою ніка");
  assert.ok(!/<textarea|Надіслати|sendMessage|\/api\/messenger/.test(sec), "🔴 у секції зʼявилось надсилання повідомлення з дашборда");
});

/**
 * #2856 — ФРОНТ КОМАНД: команду обирають ЗІ СПИСКУ двох груп («Продажі (Kommo)» і «Відділи дашборду»), а не вписують
 * текстом — ні в блоці орг-структури, ні в картці співробітника; людині з Kommo команду не змінити ні там, ні там (лише
 * показ «з Kommo»); архівний відділ не пропонується, якщо він не поточний; «Відділи дашборду» є і в «Налаштуваннях →
 * Команди», і в режимі «Редагувати» орг-структури (рішення Романа 27.10, п.2 «обидва»).
 * 🧨 Червоніє, якщо повернути текстове поле «Команда», дати змінити команду людині з Kommo або прибрати одне з двох місць.
 */
test("#2856 ФРОНТ КОМАНД: вибір зі списку двох груп, людині з Kommo — лише показ, відділи і в Налаштуваннях, і на схемі", () => {
  const ot = FSRC("pages/dashboard/sections/OrgTeams.tsx");
  const opts = ot.slice(ot.indexOf("export function TeamOptions"), ot.indexOf("export function useTeams"));
  assert.match(opts, /<optgroup label="Продажі \(Kommo\)">[\s\S]*<optgroup label="Відділи дашборду">/, "🔴 немає двох груп команд");
  assert.match(opts, /filter\(\(d\) => !d\.archived \|\| d\.key === current\)/, "🔴 архівні відділи пропонуються для вибору");
  const org = FSRC("pages/dashboard/sections/OrgSection.tsx");
  const dlg = org.slice(org.indexOf("function UnitDialog"), org.indexOf("function TeamsDialog"));
  assert.match(dlg, /<TeamOptions data=\{teams\} current=\{f\.team\} \/>/, "🔴 блок не обирає команду зі списку");
  assert.doesNotMatch(dlg, /id="ou-label"/, "🔴 повернулось текстове поле «Команда» блоку");
  const card = org.slice(org.indexOf("function PersonCard"), org.indexOf("function UnitDialog"));
  assert.match(card, /\{p\.teamLocked \? \([\s\S]*?\) : \([\s\S]*?<select/, "🔴 людині з Kommo дають обрати блок на схемі");
  assert.match(org, /onClick=\{\(\) => setTeamsOpen\(true\)\}>Відділи<\/button>/, "🔴 у режимі «Редагувати» немає «Відділів»");
  const emp = FSRC("pages/dashboard/sections/HiringEmployees.tsx");
  const tf = emp.slice(emp.indexOf("function TeamField"), emp.indexOf("const FIELDS"));
  assert.match(tf, /if \(row\.team_locked\) return \(/, "🔴 картка дає змінити команду людині з Kommo");
  assert.ok(tf.indexOf("if (row.team_locked) return (") < tf.indexOf("<select"), "🔴 вибір команди стоїть ДО перевірки «з Kommo»");
  assert.match(tf, /<TeamOptions data=\{teams\} current=\{row\.team_ref\} \/>/, "🔴 картка не обирає команду зі списку");
  const fields = emp.slice(emp.indexOf("const FIELDS"), emp.indexOf("];", emp.indexOf("const FIELDS")));
  assert.doesNotMatch(fields, /"team_label"/, "🔴 «Команда» знову текстове поле форми картки");
  assert.match(emp, /<TeamField row=\{row\} toast=\{toast\} onSaved=\{onSaved\} \/>/, "🔴 поле команди не показане в картці");
  const set = FSRC("pages/dashboard/sections/SettingsSection.tsx");
  assert.match(set, /\{sub === "Команди" && <OrgTeamsBlock \/>\}/, "🔴 «Відділів дашборду» немає в «Налаштуваннях → Команди»");
});
