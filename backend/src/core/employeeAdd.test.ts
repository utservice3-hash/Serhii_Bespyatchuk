import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { matchFilesToEmployees } from "./employeeAdd.js";

/**
 * 👤 «+ СПІВРОБІТНИК», ЗАПИС ІЗ НАЙМУ, 📎 РОЗКЛАДАННЯ ФАЙЛІВ ПО ЛЮДЯХ (22.09.2026) — гейти `#646`–`#649`.
 * Номери з запасом над `#645` — борг 17: перед мержем перемірити перетин.
 */

async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const hr = (await c.query(`INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ('ivan@uts.ua','x','manager','hr','Іван') RETURNING id`)).rows[0].id as number;
  await c.query("INSERT INTO teams(id,name) VALUES (3,'РПК · Дмитрук') ON CONFLICT DO NOTHING");
  const db = c as unknown as import("./hiring.js").Db;
  return { c, db, hr, add: await import("./employeeAdd.js"), h: await import("./hiring.js"), done: async () => { await c.end(); s.dispose(); } };
}
const bad = (st: number) => (e: unknown) => (e as { status?: number }).status === st;

/**
 * #646 — «+ СПІВРОБІТНИК»: прізвище й імʼя обовʼязкові; погана дата — 400; та сама людина вже є — 409 з її id;
 * повторний імпорт таблиці з цією людиною знаходить ТОЙ САМИЙ запис (спільний ключ ПІБ), а не створює другий.
 * 🧨 Червоніє, якщо ключ ручного запису розійдеться з ключем імпорту або дубль пройде.
 */
test("#646 ЖИВИЙ SQL: «+ Співробітник» — ПІБ обовʼязкове, дубль 409 з id, імпорт знаходить ту саму людину", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  try {
    await assert.rejects(s.add.createEmployee(s.db, s.hr, { full_name: "Коваленко" }), bad(400), "🔴 без імені прийнято");
    await assert.rejects(s.add.createEmployee(s.db, s.hr, { full_name: "Коваленко Олена", hired_at: "31.02.2026" }), bad(400), "🔴 неіснуючу дату прийнято");
    const { id } = await s.add.createEmployee(s.db, s.hr, { full_name: "  Коваленко   Олена  Петрівна ", position: "менеджер", team_label: "3", hired_at: "22.09.2026" });
    const row = (await s.c.query(`SELECT full_name, status, source, hired_at::text AS h FROM employees WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { full_name: "Коваленко Олена Петрівна", status: "active", source: "manual", h: "2026-09-22" });
    try { await s.add.createEmployee(s.db, s.hr, { full_name: "коваленко олена петрівна" }); assert.fail("🔴 дубль прийнято"); }
    catch (e) { assert.equal((e as { status?: number; existingId?: number }).status, 409); assert.equal((e as { existingId?: number }).existingId, id, "🔴 у 409 немає id наявної людини"); }
    const { randomBytes } = await import("node:crypto");
    await emp.commitImport(s.db as never, randomBytes(32), s.hr, "ПІБ,Телефон\nКоваленко Олена Петрівна,0501112233\n", ["full_name", "phone"], "active");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 1, "🔴 імпорт створив другу людину");
    assert.equal((await s.c.query(`SELECT phone FROM employees WHERE id = $1`, [id])).rows[0].phone, "0501112233", "дзеркало: імпорт знайшов саме цей запис");
  } finally { await s.done(); }
});

/**
 * #647 — КАНДИДАТ СТАВ «МЕНЕДЖЕР» → У РЕЄСТРІ: із командою кандидата, посадою з вакансії, датою прийому сьогодні, привʼязкою
 * до кандидата; другий раз — без дубля. Та сама людина вже в реєстрі — привʼязується, не дублюється. Повернення з
 * «Менеджер» прибирає щойно створений запис; якщо до нього вже прикріпили документ — запис лишається.
 * 🧨 Червоніє, якщо «Менеджер» не пише в реєстр, дублює або повернення стирає людину з даними.
 */
test("#647 ЖИВИЙ SQL: «Менеджер» у наймі → людина в реєстрі; без дублів; повернення прибирає лише порожній запис", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    const vac = await s.h.createVacancy(s.db, null, { title: "Менеджер з продажу", position: "менеджер з продажу" });
    const mk = async (name: string, phone: string) => {
      const id = await s.h.createCandidate(s.db, null, { fullName: name, phone, vacancyId: vac });
      await s.c.query(`UPDATE hiring_candidates SET status = 'training', team_id = 3 WHERE id = $1`, [id]);
      return id;
    };
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
    const a = await mk("Нова Марія", "0501110001");
    await s.h.changeStatus(s.db, s.hr, a, { to: "manager", comment: "прийнята" }, "edit", null);
    const e = (await s.c.query(`SELECT id, full_name, status, team_label, position, hired_at::text AS h, source, candidate_id FROM employees`)).rows;
    assert.equal(e.length, 1, "🔴 «Менеджер» не записав людину в реєстр");
    assert.deepEqual({ ...e[0], id: undefined }, { id: undefined, full_name: "Нова Марія", status: "active", team_label: "РПК · Дмитрук", position: "менеджер з продажу", h: today, source: "hiring", candidate_id: a });
    // Повернення з «Менеджер» — порожній запис зникає; знову «Менеджер» — зʼявляється, без дубля.
    await s.h.changeStatus(s.db, s.hr, a, { to: "training", comment: "назад" }, "edit", null);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 0, "🔴 повернення лишило щойно створений запис");
    await s.h.changeStatus(s.db, s.hr, a, { to: "manager", comment: "таки так" }, "edit", null);
    const eid = (await s.c.query(`SELECT id FROM employees WHERE candidate_id = $1`, [a])).rows[0].id;
    await s.add.ensureEmployeeFromCandidate(s.db, s.hr, a);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 1, "🔴 другий виклик задублював людину");
    // До запису прикріпили документ — повернення людину НЕ стирає.
    await s.c.query(`INSERT INTO doc_files (name, stored_name, section, employee_id, created_by) VALUES ('NDA.pdf','n.pdf','personal',$1,$2)`, [eid, s.hr]);
    await s.h.changeStatus(s.db, s.hr, a, { to: "training", comment: "ще раз назад" }, "edit", null);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees WHERE id = $1`, [eid])).rows[0].n, 1, "🔴 повернення стерло людину з документом");
    // Людина вже в реєстрі (імпорт) — кандидат із тим самим ПІБ привʼязується, не дублюється.
    await s.c.query(`INSERT INTO employees (full_name, import_key, status) VALUES ('Стара Ольга', 'стара ольга', 'active')`);
    const b = await mk("Стара Ольга", "0501110002");
    await s.h.changeStatus(s.db, s.hr, b, { to: "manager", comment: "прийнята" }, "edit", null);
    assert.deepEqual((await s.c.query(`SELECT count(*)::int n, max(candidate_id) AS cid FROM employees WHERE import_key = 'стара ольга'`)).rows[0], { n: 1, cid: b }, "🔴 наявну людину задубльовано або не привʼязано");
  } finally { await s.done(); }
});

/**
 * #648 — ЧИЙ ФАЙЛ: у назві мусять бути прізвище І імʼя людини (будь-який порядок, «_», «-», «.» — роздільники);
 * лише ЄДИНИЙ збіг; однофамільці — «неоднозначно»; лише прізвище — «не впізнано»; той самий ПІБ у працюючого й
 * звільненого — перевага працюючому.
 * 🧨 Червоніє, якщо брати першого з однофамільців або впізнавати за самим прізвищем.
 */
test("#648 ЧИЙ ФАЙЛ: прізвище й імʼя в назві, лише єдиний збіг, однофамільців не вгадує", () => {
  const people = [
    { id: 1, full_name: "Коваленко Олена Петрівна", status: "active" },
    { id: 2, full_name: "Бондар Андрій", status: "active" },
    { id: 3, full_name: "Бондар Андрій Іванович", status: "active" },
    { id: 4, full_name: "Шевчук Назар", status: "dismissed" },
    { id: 5, full_name: "Шевчук Назар", status: "active" },
    { id: 6, full_name: "Мельник Ірина", status: "dismissed" },
  ];
  const r = matchFilesToEmployees([
    "Офер_Коваленко_Олена.pdf", "olena.pdf", "NDA - Олена Коваленко.docx", "Бондар Андрій NDA.pdf",
    "Коваленко.pdf", "Шевчук.Назар.офер.pdf", "мельник_ірина_заява.PDF",
  ], people);
  assert.deepEqual(r.map((x) => [x.employeeId, x.how]), [
    [1, "name"], [null, "none"], [1, "name"], [null, "ambiguous"], [null, "none"], [5, "name"], [6, "name"],
  ], "🔴 розкладання не те: " + JSON.stringify(r.map((x) => [x.file, x.employeeId, x.how])));
  assert.deepEqual(r[3].candidates.sort(), [2, 3], "однофамільці названі обидва, щоб обрати вручну");
});

/**
 * #649 — ЖИВИЙ SQL: прев'ю розкладання бере людей із реєстру і не пише нічого; порожній пакет — 400.
 * 🧨 Червоніє, якщо прев'ю щось записує або пускає порожній пакет.
 */
test("#649 ЖИВИЙ SQL: прев'ю пакета — лише читання, люди з реєстру, порожній пакет 400", async (t) => {
  const s = await scratch(t); if (!s) return;
  try {
    await s.c.query(`INSERT INTO employees (full_name, import_key, status) VALUES ('Коваленко Олена', 'коваленко олена', 'active')`);
    const before = (await s.c.query(`SELECT count(*)::int n FROM doc_files`)).rows[0].n;
    const r = await s.add.matchFiles(s.db, ["Офер Коваленко Олена.pdf", "хтось.pdf"]);
    assert.deepEqual(r.map((x) => x.how), ["name", "none"]);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM doc_files`)).rows[0].n, before, "🔴 прев'ю записало документ");
    await assert.rejects(s.add.matchFiles(s.db, []), bad(400));
  } finally { await s.done(); }
});

/**
 * #2270 — ЖИВИЙ SQL: ДЖЕРЕЛО АКАУНТА Й КАРТКИ БЕЗ АКАУНТА (прохід 3 «один акаунт», 22.10.2026). `USER_SOURCE_SQL` — той
 * самий вираз, що в `GET /settings/users`: кандидат (роль «Кандидат») · Kommo (є менеджер) · Найм (привʼязаний до
 * кандидата, без Kommo) · вручну. `cardsWithoutAccount` — лише картки без акаунта, працюючі першими.
 * 🧨 Червоніє, якщо переплутати порядок гілок (кандидат із Kommo став би «Kommo»), загубити «Найм» або показати
 * в списку вибору картку, що вже має акаунт.
 */
test("#2270 ЖИВИЙ SQL: джерело акаунта — кандидат / Kommo / Найм / вручну; у виборі лише картки без акаунта", async (t) => {
  const s = await scratch(t); if (!s) return;
  const { USER_SOURCE_SQL, cardsWithoutAccount } = await import("./employeeAdd.js");
  try {
    await s.c.query("INSERT INTO managers (id,name,team_id,is_active,kommo_user_id) VALUES (7001,'Кмо',3,true,7001),(7002,'Кандидат Кмо',3,true,7002)");
    const mk = async (email: string, override: string | null, mgr: number | null) => (await s.c.query(
      "INSERT INTO users (email,password_hash,role,role_override,manager_id) VALUES ($1,'x','manager',$2,$3) RETURNING id", [email, override, mgr])).rows[0].id as number;
    const cand = await mk("cand@x.ua", "candidate", 7002); // кандидат, до якого вже привʼязано Kommo, — усе ще «кандидат»
    const kommo = await mk("k@x.ua", null, 7001);
    const hired = await mk("h@x.ua", null, null);
    await s.c.query("INSERT INTO hiring_candidates (full_name, phone, phone_norm, status, user_id) VALUES ('Найм Людина','0970002270','380970002270','manager',$1)", [hired]);
    const manual = await mk("m@x.ua", "hr", null);
    const src = Object.fromEntries((await s.c.query(`SELECT u.id, ${USER_SOURCE_SQL} AS src FROM users u WHERE u.id = ANY($1)`, [[cand, kommo, hired, manual]])).rows.map((r) => [r.id, r.src]));
    assert.deepEqual([src[cand], src[kommo], src[hired], src[manual]], ["candidate", "kommo", "hiring", "manual"], "🔴 джерело акаунта підписано хибно");

    await s.c.query("INSERT INTO employees (full_name, import_key, status, user_id) VALUES ('Зайнята Картка','зайнята картка','active',$1)", [manual]);
    await s.c.query("INSERT INTO employees (full_name, import_key, status) VALUES ('Білоус Сергій','білоус сергій','active'),('Архівна Людина','архівна людина','dismissed')");
    const free = (await cardsWithoutAccount(s.db)).map((c) => c.full_name);
    assert.deepEqual(free, ["Білоус Сергій", "Архівна Людина"], "🔴 у виборі картка з акаунтом або звільнені не в кінці");
  } finally { await s.done(); }
});

/**
 * #2271 — ЖИВИЙ SQL: ПРИВʼЯЗАТИ → ВІДВʼЯЗАТИ → ПРИВʼЯЗАТИ ЗНОВУ (скасовність — властивість ЦИКЛУ, правило 06.08.2026).
 * Заборони: картка з іншим акаунтом — 409; акаунт, що вже має картку, — 409; відвʼязати акаунт без картки — 409.
 * Кожна дія — у журналі доступу. Kommo картки не чіпається (рішення 22.10 «без Kommo»).
 * 🧨 Червоніє, якщо відвʼязка не звільняє картку для повтору, якщо пускає на чужу картку чи другу картку акаунту,
 * якщо дія не пишеться в журнал або чіпає Kommo.
 */
test("#2271 ЖИВИЙ SQL: привʼязати → відвʼязати → привʼязати знову; чужа картка, друга картка, порожня відвʼязка — 409", async (t) => {
  const s = await scratch(t); if (!s) return;
  const { linkUserCard } = await import("./employeeAdd.js");
  try {
    const u = (await s.c.query("INSERT INTO users (email,password_hash,role) VALUES ('buh@uts.ua','x','manager') RETURNING id")).rows[0].id as number;
    const other = (await s.c.query("INSERT INTO users (email,password_hash,role) VALUES ('o@uts.ua','x','manager') RETURNING id")).rows[0].id as number;
    await s.c.query("INSERT INTO managers (id,name,team_id,is_active,kommo_user_id) VALUES (7101,'Kommo картки',3,true,7101)");
    const card = (await s.c.query("INSERT INTO employees (full_name, import_key, status, manager_id) VALUES ('Зубрицька Катерина','зубрицька катерина','active',7101) RETURNING id")).rows[0].id as number;
    const taken = (await s.c.query("INSERT INTO employees (full_name, import_key, status, user_id) VALUES ('Чужа Картка','чужа картка','active',$1) RETURNING id", [other])).rows[0].id as number;
    const cardOf = async () => (await s.c.query("SELECT user_id, manager_id FROM employees WHERE id=$1", [card])).rows[0];

    await assert.rejects(linkUserCard(s.db, s.hr, u, null), bad(409), "🔴 відвʼязано акаунт, у якого картки немає");
    await assert.rejects(linkUserCard(s.db, s.hr, u, taken), bad(409), "🔴 акаунт сів на картку з іншим акаунтом");
    await linkUserCard(s.db, s.hr, u, card);
    assert.deepEqual(await cardOf(), { user_id: u, manager_id: 7101 }, "🔴 не привʼязано або зачеплено Kommo картки");
    const second = (await s.c.query("INSERT INTO employees (full_name, import_key, status) VALUES ('Друга Картка','друга картка','active') RETURNING id")).rows[0].id as number;
    await assert.rejects(linkUserCard(s.db, s.hr, u, second), bad(409), "🔴 у акаунта стало дві картки");
    await linkUserCard(s.db, s.hr, u, null);
    assert.deepEqual(await cardOf(), { user_id: null, manager_id: 7101 }, "🔴 відвʼязка не звільнила картку або зняла Kommo");
    await linkUserCard(s.db, s.hr, u, card);
    assert.equal((await cardOf()).user_id, u, "🔴 повторна привʼязка після відвʼязки не працює — дія не скасовна циклом");
    const log = (await s.c.query("SELECT action FROM access_audit WHERE action LIKE 'employees.%link_user' ORDER BY id")).rows.map((r) => r.action);
    assert.deepEqual(log, ["employees.link_user", "employees.unlink_user", "employees.link_user"], "🔴 дії не записані в журнал доступу");
  } finally { await s.done(); }
});

/**
 * #2272 — ПРОВОДКА НАЛАШТУВАНЬ (читає джерело роутів): `GET /users` віддає джерело через `USER_SOURCE_SQL` і картку,
 * плюс `freeCards`; `PATCH /users/:id` з `employeeId` іде в `linkUserCard`; `POST /users` перевіряє картку ДО
 * створення акаунта і привʼязує ПІСЛЯ. Усі три — за `requireManageUsers` (адмін, СЕО, ОД; HR і тімлід — 403).
 * 🧨 Червоніє, якщо прибрати джерело чи картку зі списку, перевірку картки поставити після INSERT (лишиться
 * акаунт без картки), обійти `linkUserCard` або зняти межу `manage_users`.
 */
test("#2272 Налаштування: список із джерелом і карткою, PATCH/POST привʼязують через linkUserCard, межа manage_users", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "settings.ts"), "utf8");
  const handler = (sig: string) => { const i = src.indexOf(sig); assert.ok(i >= 0, `🔴 немає обробника ${sig}`); return src.slice(i, src.indexOf("\n});", i)); };
  const get = handler(`settingsRouter.get("/users",`);
  assert.match(get, /^settingsRouter\.get\("\/users", async \(req, res\) => \{\s*if \(!requireManageUsers\(req, res\)\) return;/, "🔴 список без межі manage_users");
  assert.match(get, /\$\{USER_SOURCE_SQL\} AS source,\s*e\.id AS card_id, e\.full_name AS card_name/, "🔴 список без джерела або картки");
  assert.match(get, /freeCards: await cardsWithoutAccount\(/, "🔴 немає карток для вибору");
  const patch = handler(`settingsRouter.patch("/users/:id",`);
  assert.match(patch, /^settingsRouter\.patch\("\/users\/:id", async \(req, res\) => \{\s*if \(!requireManageUsers\(req, res\)\) return;/, "🔴 PATCH без межі manage_users");
  assert.match(patch, /"employeeId" in \(req\.body \?\? \{\}\)\)[\s\S]{0,200}linkUserCard\(pool as unknown as SecretsDb, req\.auth!\.userId, id, req\.body\.employeeId\)/, "🔴 PATCH привʼязує не через linkUserCard");
  const post = handler(`settingsRouter.post("/users",`);
  assert.match(post, /^settingsRouter\.post\("\/users", async \(req, res\) => \{\s*if \(!requireManageUsers\(req, res\)\) return;/, "🔴 POST без межі manage_users");
  const check = post.indexOf("Ця картка вже має акаунт"), insert = post.indexOf("INSERT INTO users"), link = post.indexOf("await linkUserCard(");
  assert.ok(check > 0 && insert > 0 && link > 0, "🔴 POST: немає перевірки картки, створення або привʼязки");
  assert.ok(check < insert && insert < link, "🔴 POST: картку перевірено після створення акаунта або привʼязано до нього");
});

/**
 * #2273 — ФРОНТ: КАНДИДАТИ СХОВАНІ ЗА ЗАМОВЧУВАННЯМ (рішення Романа 22.10) — і в «Користувачах», і в «Архіві»; перемикач
 * їх показує. Колонки «Джерело» й «Картка» є; «немає картки» — словом із вибором, а не порожньо.
 * 🧨 Червоніє, якщо кандидатів показати за замовчуванням, прибрати перемикач чи фільтр в одній із вкладок або колонку.
 */
test("#2273 Налаштування (фронт): кандидати сховані за замовчуванням в обох вкладках, колонки «Джерело» й «Картка»", () => {
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "SettingsSection.tsx"), "utf8");
  for (const tab of ["function UsersTab(", "function ArchiveTab("]) {
    const i = fe.indexOf(tab); assert.ok(i >= 0, `🔴 немає ${tab}`);
    const body = fe.slice(i, fe.indexOf("\n}\n", i));
    assert.match(body, /const \[showCand, setShowCand\] = useState\(false\);/, `🔴 ${tab}: кандидати не сховані за замовчуванням`);
    // Прохід 5 додав у «Користувачах» другу умову (`showAll || !u.card_id`) — кандидатська частина та сама.
    assert.match(body, /const shown = users\.filter\(\(u\) => \(?showCand \|\| u\.source !== "candidate"\)?/, `🔴 ${tab}: немає фільтра кандидатів`);
    assert.match(body, /\{shown\.map\(\(u\) =>/, `🔴 ${tab}: таблиця малює всіх, а не відфільтрованих`);
    assert.match(body, /onChange=\{\(e\) => setShowCand\(e\.target\.checked\)\} \/> показати кандидатів/, `🔴 ${tab}: немає перемикача`);
  }
  assert.match(fe, /<th style=\{TH\}[^>]*>ДЖЕРЕЛО<\/th><th style=\{TH\}[^>]*>КАРТКА<\/th>/, "🔴 немає колонок «Джерело» / «Картка»");
  assert.match(fe, /<option value="">немає картки — привʼязати…<\/option>/, "🔴 відсутність картки не названа словом");
});

/**
 * #2274 — ПЕРЕХІД З «НАЛАШТУВАННЯ → КОРИСТУВАЧІ» НА КАРТКУ (зауваження Романа 23.10: «я не можу в налаштуваннях перейти
 * на карточку»). Імʼя картки в списку — посилання `/hiring?tab=emp&employee=<id>`; «Найм» відкривається на вкладці
 * «Співробітники»; реєстр відкриває картку з `employee` одразу і прибирає параметр з адреси.
 * 🧨 Червоніє, якщо зламати адресу посилання, не читати `tab` чи `employee` або не відкривати картку.
 */
test("#2274 Налаштування → картка: посилання /hiring?tab=emp&employee=<id>, Найм відкриває вкладку й картку", () => {
  const FE = (f: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", f), "utf8");
  assert.match(FE("SettingsSection.tsx"), /<a href=\{`\/hiring\?tab=emp&employee=\$\{u\.card_id\}`\}[^>]*>\{u\.card_name\}<\/a>/, "🔴 імʼя картки в Налаштуваннях не веде на картку");
  assert.match(FE("HiringSection.tsx"), /new URLSearchParams\(window\.location\.search\)\.get\("tab"\) === "emp" \? "emp"/, "🔴 «Найм» не відкриває «Співробітників» з адреси");
  const emp = FE("HiringEmployees.tsx");
  assert.match(emp, /const id = Number\(new URLSearchParams\(window\.location\.search\)\.get\("employee"\)\);\s*return Number\.isInteger\(id\) && id > 0 \? \{ id, tab: "profile" \} : null;/,
    "🔴 реєстр не відкриває картку з адреси");
  assert.match(emp, /u\.searchParams\.delete\("employee"\)/, "🔴 параметр лишається в адресі — оновлення знову відкриє картку");
});

/**
 * #2280 — ХТО ЩО МОЖЕ З АКАУНТОМ (рішення Романа 23.10.2026). `accountVerdict` — одне правило для кнопок картки й
 * сервера. HR (`manage_sales_accounts`): пароль і трекер — ЛИШЕ менеджеру й тімліду; кандидату, КВП, бухгалтерії,
 * адміну — ні; роль і вхід — ніколи. Адмін/СЕО/ОД (`manage_users` + `reset_passwords`) — усе й усім. Без прав — нічого.
 * 🧨 Червоніє, якщо HR дістане не-менеджера, роль чи вхід, або адмін втратить будь-яку дію.
 */
test("#2280 accountVerdict: HR — пароль і трекер лише менеджеру й тімліду; роль і вхід — лише адмін/СЕО/ОД", async () => {
  const { accountVerdict } = await import("./employeeAccount.js");
  const HR = { manageUsers: false, resetPasswords: false, manageSales: true };
  const ADMIN = { manageUsers: true, resetPasswords: true, manageSales: false };
  const NONE = { manageUsers: false, resetPasswords: false, manageSales: false };
  const ok = (p: typeof HR, a: "password" | "tracker" | "role" | "active", r: string) => accountVerdict(p, a, r).ok;
  for (const r of ["manager", "team_lead"]) {
    assert.equal(ok(HR, "password", r), true, `🔴 HR не скидає пароль: ${r}`);
    assert.equal(ok(HR, "tracker", r), true, `🔴 HR не вмикає трекер: ${r}`);
    assert.equal(ok(HR, "role", r), false, `🔴 HR міняє роль: ${r}`);
    assert.equal(ok(HR, "active", r), false, `🔴 HR вимикає вхід: ${r}`);
  }
  for (const r of ["candidate", "kvp", "____________", "admin", "ceo", "opdir", "hr"]) {
    assert.equal(ok(HR, "password", r), false, `🔴 HR скидає пароль не менеджеру: ${r}`);
    assert.equal(ok(HR, "tracker", r), false, `🔴 HR чіпає трекер не менеджера: ${r}`);
  }
  assert.match((accountVerdict(HR, "password", "admin") as { error: string }).error, /лише акаунтами менеджерів і тімлідів/);
  for (const a of ["password", "tracker", "role", "active"] as const) {
    for (const r of ["manager", "admin", "candidate"]) assert.equal(ok(ADMIN, a, r), true, `🔴 адмін втратив «${a}» для ${r}`);
    assert.equal(ok(NONE, a, "manager"), false, `🔴 без прав дозволено «${a}»`);
  }
});

/**
 * #2281 — ЖИВИЙ SQL: HR СКИДАЄ ПАРОЛЬ МЕНЕДЖЕРУ, НЕ ЧІПАЄ КВП. Новий хеш, значення — у сейфі картки, у відповіді — один
 * раз; той самий виклик для акаунта з ручною роллю КВП — 403 і хеш не змінився; трекер — в обидва боки; картка без
 * акаунта — 409. І сид: право `manage_sales_accounts` має рівно роль hr.
 * 🧨 Червоніє, якщо HR скине пароль КВП, пароль не ляже в сейф, трекер не вимикається або право дістанеться не тій ролі.
 */
test("#2281 ЖИВИЙ SQL: HR скидає пароль і трекер менеджеру (пароль у сейфі), КВП — 403; право лише в hr", async (t) => {
  const s = await scratch(t); if (!s) return;
  const acc = await import("./employeeAccount.js");
  const { randomBytes } = await import("node:crypto");
  const bcrypt = (await import("bcryptjs")).default;
  const key = randomBytes(32);
  const HR = { manageUsers: false, resetPasswords: false, manageSales: true };
  try {
    const roles = (await s.c.query("SELECT key FROM roles WHERE (permissions->>'manage_sales_accounts')::boolean ORDER BY key")).rows.map((r) => r.key);
    assert.deepEqual(roles, ["hr"], "🔴 право керувати акаунтами менеджерів не лише в hr");
    const mk = async (email: string, override: string | null) => (await s.c.query(
      "INSERT INTO users (email,password_hash,role,role_override) VALUES ($1,$2,'manager',$3) RETURNING id", [email, await bcrypt.hash("old", 4), override])).rows[0].id as number;
    const mgr = await mk("mgr@uts.ua", null), kvp = await mk("kvp@uts.ua", "kvp");
    const card = async (name: string, uid: number | null) => (await s.c.query("INSERT INTO employees (full_name, import_key, status, user_id) VALUES ($1,$2,'active',$3) RETURNING id", [name, name.toLowerCase(), uid])).rows[0].id as number;
    const em = await card("Менеджер Один", mgr), ek = await card("Квп Одна", kvp), en = await card("Без Акаунта", null);

    const r = await acc.resetEmployeePassword(s.db, key, s.hr, em, HR);
    assert.equal(r.login, "mgr@uts.ua");
    assert.ok(await bcrypt.compare(r.password, (await s.c.query("SELECT password_hash FROM users WHERE id=$1", [mgr])).rows[0].password_hash), "🔴 новий пароль не діє");
    assert.equal((await s.c.query("SELECT count(*)::int n FROM employee_secrets WHERE user_id=$1 AND service='dashboard' AND superseded_at IS NULL", [mgr])).rows[0].n, 1, "🔴 пароль не ліг у сейф картки");

    const before = (await s.c.query("SELECT password_hash FROM users WHERE id=$1", [kvp])).rows[0].password_hash;
    await assert.rejects(acc.resetEmployeePassword(s.db, key, s.hr, ek, HR), bad(403), "🔴 HR скинув пароль КВП");
    assert.equal((await s.c.query("SELECT password_hash FROM users WHERE id=$1", [kvp])).rows[0].password_hash, before, "🔴 хеш КВП змінився попри 403");
    await assert.rejects(acc.setEmployeeTracker(s.db, s.hr, ek, true, HR), bad(403), "🔴 HR чіпає трекер КВП");

    await acc.setEmployeeTracker(s.db, s.hr, em, true, HR);
    assert.equal((await s.c.query("SELECT tracker_enabled FROM users WHERE id=$1", [mgr])).rows[0].tracker_enabled, true);
    await acc.setEmployeeTracker(s.db, s.hr, em, false, HR);
    assert.equal((await s.c.query("SELECT tracker_enabled FROM users WHERE id=$1", [mgr])).rows[0].tracker_enabled, false, "🔴 трекер не вимикається тим самим шляхом");
    await assert.rejects(acc.resetEmployeePassword(s.db, key, s.hr, en, HR), bad(409), "🔴 картка без акаунта — не 409");
    assert.equal((await acc.employeeAccount(s.db, en)), null);
  } finally { await s.done(); }
});

/**
 * #2282 — ПРОВОДКА РОУТІВ (читає джерело): стан, пароль і трекер у `routes/secrets.ts` беруть права з ролі
 * (`manage_users`, `reset_passwords`, `manage_sales_accounts`) і кличуть ядро; усі три роути — у матриці доступу.
 * 🧨 Червоніє, якщо роут обійде `accountPerms`/ядро або зникне з матриці.
 */
test("#2282 роути акаунта в картці: права з ролі → ядро; усі в матриці доступу", () => {
  const SRC = (f: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", f), "utf8");
  const r = SRC("routes/secrets.ts");
  assert.match(r, /manageUsers: roleHasPerm\(r, "manage_users"\), resetPasswords: roleHasPerm\(r, "reset_passwords"\), manageSales: roleHasPerm\(r, "manage_sales_accounts"\)/, "🔴 права беруться не з ролі");
  assert.match(r, /secretsRouter\.post\("\/employees\/:id\/account\/reset-password"[\s\S]{0,200}resetEmployeePassword\(db, key\(\), me\(req\), num\(req\.params\.id, "id співробітника"\), accountPerms\(req\)\)/, "🔴 скидання пароля в обхід ядра");
  assert.match(r, /secretsRouter\.patch\("\/employees\/:id\/account\/tracker"[\s\S]{0,200}setEmployeeTracker\(db, me\(req\), num\(req\.params\.id, "id співробітника"\), req\.body\?\.on, accountPerms\(req\)\)/, "🔴 трекер в обхід ядра");
  const m = SRC("auth/accessMatrix.ts");
  for (const [method, p] of [["GET", "/api/secrets/employees/:id/account"], ["POST", "/api/secrets/employees/:id/account/reset-password"], ["PATCH", "/api/secrets/employees/:id/account/tracker"]])
    assert.ok(m.includes(`{ method: "${method}", path: "${p}"`), `🔴 ${method} ${p} немає в матриці доступу`);
});

/**
 * #2283 — ФРОНТ: БЛОК «АКАУНТ ДАШБОРДА» В КАРТЦІ. Стоїть у «Профілі»; кожна кнопка — лише за `can` від сервера
 * (пароль, трекер, роль, вхід, створення); роль/вхід/створення — наявними роутами Налаштувань.
 * 🧨 Червоніє, якщо прибрати блок з картки або показувати кнопку без `can`.
 */
test("#2283 картка: блок «Акаунт дашборда» у «Профілі», кнопки лише за can від сервера", () => {
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "HiringEmployees.tsx"), "utf8");
  assert.match(fe, /<PhotoPanel [^\n]*\/>\s*<AccountPanel employeeId=\{row\.id\} email=\{row\.email\} toast=\{toast\} onChanged=\{onSaved\} \/>/, "🔴 блоку «Акаунт» немає в «Профілі»");
  const i = fe.indexOf("function AccountPanel("); assert.ok(i > 0);
  const body = fe.slice(i);
  assert.match(body, /\{can\.password && <button/, "🔴 «Скинути пароль» без can.password");
  assert.match(body, /disabled=\{busy \|\| !can\.tracker\}/, "🔴 трекер без can.tracker");
  assert.match(body, /\{can\.role\s*\?/, "🔴 роль без can.role");
  assert.match(body, /\{can\.active\s*\?/, "🔴 вхід без can.active");
  assert.match(body, /can\.create \? \(/, "🔴 створення без can.create");
});

/**
 * #2290 — «ПУЛ НІЧИЙНИХ» У КАРТЦІ — ЛИШЕ АДМІН, СЕО, ОД (рішення Романа 23.10.2026, прохід 5): пул відкриває менеджеру
 * телефони чужих клієнтів. HR (`manage_sales_accounts`) — ні навіть менеджеру; адмін — так.
 * 🧨 Червоніє, якщо дати пул HR або забрати в адміна.
 */
test("#2290 accountVerdict: «пул нічийних» лише manage_users (адмін/СЕО/ОД), HR — ні", async () => {
  const { accountVerdict } = await import("./employeeAccount.js");
  assert.equal(accountVerdict({ manageUsers: false, resetPasswords: false, manageSales: true }, "pool", "manager").ok, false, "🔴 HR відкриває пул нічийних");
  assert.equal(accountVerdict({ manageUsers: true, resetPasswords: true, manageSales: false }, "pool", "manager").ok, true, "🔴 адмін не може відкрити пул");
});

/**
 * #2291 — ЖИВИЙ SQL: СТАН АКАУНТА В КАРТЦІ ВІДДАЄ ПУЛ І СТАН МЕНЕДЖЕРА (прохід 5) — те, що раніше було видно лише в
 * Налаштуваннях. Менеджер зі станом «завершує» і відкритим пулом — так і в картці; без запису стану — null (активний).
 * 🧨 Червоніє, якщо поле загубиться або стан візьметься не з `manager_work_state`.
 */
test("#2291 ЖИВИЙ SQL: акаунт у картці — пул нічийних і стан менеджера", async (t) => {
  const s = await scratch(t); if (!s) return;
  const acc = await import("./employeeAccount.js");
  try {
    await s.c.query("INSERT INTO managers (id,name,team_id,is_active,kommo_user_id) VALUES (7201,'Менеджер Пулу',3,true,7201),(7202,'Менеджер Без Стану',3,true,7202)");
    const u1 = (await s.c.query("INSERT INTO users (email,password_hash,role,manager_id,orphan_pool) VALUES ('p1@uts.ua','x','manager',7201,true) RETURNING id")).rows[0].id;
    const u2 = (await s.c.query("INSERT INTO users (email,password_hash,role,manager_id) VALUES ('p2@uts.ua','x','manager',7202) RETURNING id")).rows[0].id;
    await s.c.query("INSERT INTO manager_work_state (manager_id, state, note) VALUES (7201,'finishing','гейт #2291')");
    const e1 = (await s.c.query("INSERT INTO employees (full_name, import_key, status, user_id) VALUES ('Менеджер Пулу','менеджер пулу','active',$1) RETURNING id", [u1])).rows[0].id;
    const e2 = (await s.c.query("INSERT INTO employees (full_name, import_key, status, user_id) VALUES ('Менеджер Без Стану','менеджер без стану','active',$1) RETURNING id", [u2])).rows[0].id;
    const a1 = await acc.employeeAccount(s.db, e1), a2 = await acc.employeeAccount(s.db, e2);
    assert.deepEqual([a1?.orphanPool, a1?.workState], [true, "finishing"], "🔴 картка не бачить пул або стан менеджера");
    assert.deepEqual([a2?.orphanPool, a2?.workState], [false, null], "🔴 без запису стану — не «активний»");
  } finally { await s.done(); }
});

/**
 * #2294 — «КОРИСТУВАЧІ» В НАЛАШТУВАННЯХ — УСІ, З ПОВНИМ КЕРУВАННЯМ (рішення Романа 23.10.2026, скасовує прохід 5:
 * «користувачі (CRM і дашборду) мають залишатися в налаштуваннях; кожен користувач може мати картку, а може не мати»).
 * За замовчуванням видно всіх, крім кандидатів (ними керує Найм, рішення 22.10); у рядку з карткою — ті самі кнопки,
 * що й без неї (роль, пароль, деактивація, стан, трекер, пул); картка — лише колонка з посиланням.
 * 🧨 Червоніє, якщо знову сховати людей із карткою або прибрати кнопки з їхнього рядка.
 */
test("#2294 Налаштування: «Користувачі» — усі (крім кандидатів), у рядку з карткою повне керування", () => {
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "SettingsSection.tsx"), "utf8");
  const i = fe.indexOf("function UsersTab("); const body = fe.slice(i, fe.indexOf("\n}\n", i));
  assert.match(body, /const shown = users\.filter\(\(u\) => showCand \|\| u\.source !== "candidate"\);/, "🔴 «Користувачі» ховають когось, крім кандидатів");
  assert.doesNotMatch(body, /showAll|керувати в картці/, "🔴 повернувся фільтр «лише без картки» або «керувати в картці» замість кнопок");
  assert.match(body, /<td style=\{\{ whiteSpace: "nowrap" \}\}>\s*<button onClick=\{\(\) => reset\(u\.id\)\} style=\{btn\}>↺ Пароль<\/button>\s*<button onClick=\{\(\) => deactivate\(u\)\}/,
    "🔴 у рядку немає «Пароль» / «Деактивувати» для всіх");
  assert.match(body, /<td>\s*<select value=\{u\.role_override \?\? "__synced__"\}/, "🔴 роль міняється не в кожному рядку");
  assert.match(body, /\{u\.card_id\s*\? <><a href=\{`\/hiring\?tab=emp&employee=\$\{u\.card_id\}`\}/, "🔴 колонка «Картка» без посилання на картку");
});

/**
 * #2293 — КАРТКА (фронт, прохід 5): стан менеджера показано; галочка «пул нічийних» лише за `can.pool`.
 * 🧨 Червоніє, якщо прибрати стан чи пул із картки або дати галочку без права.
 */
test("#2293 картка: стан менеджера й «пул нічийних» (лише за can.pool)", () => {
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "HiringEmployees.tsx"), "utf8");
  const body = fe.slice(fe.indexOf("function AccountPanel("));
  assert.match(body, /<span className="hr-muted">Стан менеджера<\/span>/, "🔴 стану менеджера немає в картці");
  assert.match(body, /checked=\{a\.orphanPool\} disabled=\{busy \|\| !can\.pool\}/, "🔴 пул у картці без can.pool");
  assert.match(body, /updateUser\(a\.userId, \{ orphanPool: e\.target\.checked \}\)/, "🔴 пул у картці нічого не змінює");
});
