import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseCsv, parseDate, guessTarget, validateMapping, ImportError, detectHeaderRow, headersAt, buildRows, cardsIn } from "./employeeImport.js";

/**
 * 🗂 РЕЄСТР СПІВРОБІТНИКІВ + ІМПОРТ «UTS Співробітники УКР» (18.09.2026, задача №3898) — гейти `#560`–`#564`.
 * Номери з запасом над `#556` (сейф) — борг 17: перед мержем перемірити перетин.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const KEY = randomBytes(32);

/**
 * #560 — CSV ЯК ЙОГО ВІДДАЄ GOOGLE: BOM, CRLF, коми й переноси в лапках, подвоєні лапки, `;`.
 * Дати — лише справжні (31.02 — ні). 🧨 Червоніє, якщо ламати рядок на переносі всередині лапок.
 */
test("#560 CSV: лапки, переноси й BOM як у Google; дати лише справжні", () => {
  const t = parseCsv('\uFEFFПІБ,Примітка,Телефон\r\n"Коваленко Олена","Має ""двох"" дітей,\nпереїхала",+380501112233\r\n,,\r\n');
  assert.deepEqual(t, [["ПІБ", "Примітка", "Телефон"], ["Коваленко Олена", 'Має "двох" дітей,\nпереїхала', "+380501112233"]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]], "🔴 роздільник «;» не розпізнано");
  assert.equal(parseDate("05.03.1994"), "1994-03-05");
  assert.equal(parseDate("5/3/24"), "2024-03-05");
  assert.equal(parseDate("2024-03-05"), "2024-03-05");
  assert.equal(parseDate("31.02.2024"), null, "🔴 неіснуючу дату прийнято");
  assert.equal(parseDate("вересень"), null);
});

/**
 * #561 — МЕЖА: колонка, схожа на пароль чи картку, НЕ МОЖЕ піти в реєстр чи «як є» — лише в сейф
 * або «пропустити». Вирішує сервер. Дзеркало: звичайні колонки йдуть у свої поля.
 * 🧨 Червоніє, якщо зняти перевірку в `validateMapping` або здогад поставить пароль у поле реєстру.
 */
test("#561 МЕЖА: пароль і картка — лише в сейф або «пропустити», сервер відмовляє інакше", () => {
  assert.equal(guessTarget("Пароль Kommo"), "secret:password:kommo");
  assert.equal(guessTarget("Логін Kommo"), "secret:login:kommo");
  assert.equal(guessTarget("Пароль пошта"), "secret:password:mail");
  assert.equal(guessTarget("Номер картки"), "secret:card");
  assert.equal(guessTarget("Банківська карта"), "secret:card");
  assert.equal(guessTarget("Ringostat pass"), "secret:password:ringostat");
  assert.equal(guessTarget("ПІБ"), "full_name");
  assert.equal(guessTarget("Дата народження"), "birth_date");
  assert.equal(guessTarget("Телефон"), "phone");
  assert.equal(guessTarget("Пошта"), "email");
  assert.equal(guessTarget("Щось незрозуміле"), "skip", "🔴 невідома колонка має бути «пропустити», а не «як є»");
  const h = ["ПІБ", "Пароль Kommo", "Номер картки"];
  for (const bad of ["extra", "note", "phone"]) {
    assert.throws(() => validateMapping(h, ["full_name", bad, "skip"]), (e: unknown) => e instanceof ImportError && e.status === 400, `🔴 пароль пустили в «${bad}»`);
    assert.throws(() => validateMapping(h, ["full_name", "skip", bad]), (e: unknown) => e instanceof ImportError, `🔴 картку пустили в «${bad}»`);
  }
  validateMapping(h, ["full_name", "secret:password:kommo", "secret:card"]);
  validateMapping(h, ["full_name", "skip", "skip"]);
  assert.throws(() => validateMapping(["Телефон"], ["phone"]), /ПІБ/, "🔴 імпорт без імені");
  assert.throws(() => validateMapping(["ПІБ", "Тел", "Моб"], ["full_name", "phone", "phone"]), /одне поле/);
});

/** Схема з нуля, три акаунти (двоє — однофамільці), CSV зі справжніми на вигляд секретами. */
async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  const ins = async (email: string, role: string, name: string) => (await c.query(
    `INSERT INTO users (email, password_hash, role, role_override, full_name) VALUES ($1,'x','manager',$2,$3) RETURNING id`,
    [email, role, name])).rows[0].id as number;
  const ivan = await ins("ivan@uts.ua", "hr", "Іван Романов");
  const olena = await ins("olena@uts.ua", "manager", "Коваленко Олена");
  const andrii = await ins("andrii@uts.ua", "manager", "Бондар Андрій");
  await ins("bondar2@uts.ua", "manager", "Андрій Бондар");
  return { c, url: s.url, db: c as unknown as import("./secrets.js").Db, ivan, olena, andrii, done: async () => { await c.end(); s.dispose(); } };
}

const PASS = "Qz8!mK2-Uniq", MAILPASS = "Mail-9x!Pw", CARD = "5168742012345678";
const HEAD = "ПІБ,Посада,Пошта,Телефон,Дата народження,Логін Kommo,Пароль Kommo,Пароль пошта,Номер картки,Хобі";
const MAP = ["full_name", "position", "email", "phone", "birth_date", "secret:login:kommo", "secret:password:kommo", "secret:password:mail", "secret:card", "extra"];
const CSV = [HEAD,
  `Коваленко Олена Петрівна,Менеджер,olena@uts.ua,+380501112233,05.03.1994,o.kovalenko,${PASS},${MAILPASS},${CARD},риболовля`,
  `Сидоренко Марія,Бухгалтер,,+380671112233,,,,SomeMail-1!,,`,
  `Бондар Андрій,Менеджер,,,,,Pw-Bondar-1,,,`,
  `Коваленко Олена Петрівна,Менеджер,,,,,,,,`,
].join("\n");

/**
 * #562 — ІМПОРТ КЛАДЕ ПАРОЛЬ ЛИШЕ В СЕЙФ: реєстр, «як є», прев'ю й аудит не містять жодного значення;
 * шифр розшифровується в те, що було в таблиці; логін Kommo пристає до пароля Kommo, логін пошти — пошта людини.
 * 🧨 Червоніє, якщо писати значення в `extra`/аудит/прев'ю або зберігати без шифру.
 */
test("#562 ЖИВИЙ SQL: імпорт — пароль і картка лише шифром у сейфі, в реєстрі й аудиті їх немає", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  const { unseal, aadFor } = await import("./secretBox.js");
  try {
    const pv = await emp.previewImport(s.db, CSV, MAP);
    assert.equal(pv.mappingError, null);
    const c = await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    assert.deepEqual([c.rows, c.created, c.duplicate, c.linked, c.secretsCreated, c.secretsNoAccount],
      [3, 3, 1, 1, 5, 2], "🔴 лічильники імпорту не ті");
    const everything = JSON.stringify([pv, c,
      (await s.c.query(`SELECT * FROM employees`)).rows, (await s.c.query(`SELECT * FROM access_audit`)).rows,
      (await s.c.query(`SELECT id, user_id, kind, service, label, login, last4 FROM employee_secrets`)).rows]);
    for (const v of [PASS, MAILPASS, CARD, "SomeMail-1!", "Pw-Bondar-1"]) assert.ok(!everything.includes(v), `🔴 значення «${v.slice(0, 3)}…» видно поза сейфом`);
    const rows = (await s.c.query(`SELECT kind, service, login, last4, cipher, iv, tag FROM employee_secrets WHERE user_id=$1 ORDER BY kind, service`, [s.olena])).rows;
    assert.deepEqual(rows.map((r) => [r.kind, r.service, r.login, r.last4]),
      [["card", "card", null, "5678"], ["password", "kommo", "o.kovalenko", null], ["password", "mail", "olena@uts.ua", null]]);
    const kommo = rows.find((r) => r.service === "kommo")!;
    assert.equal(unseal(KEY, kommo, aadFor(s.olena, "password", "kommo")), PASS, "🔴 у сейфі не той пароль");
    const o = (await s.c.query(`SELECT user_id, position, phone, birth_date::text AS b, extra FROM employees WHERE import_key = 'коваленко олена петрівна'`)).rows[0];
    assert.deepEqual([o.user_id, o.position, o.phone, o.b, o.extra], [s.olena, "Менеджер", "+380501112233", "1994-03-05", { "Хобі": "риболовля" }]);
    const bondar = (await s.c.query(`SELECT user_id FROM employees WHERE import_key = 'бондар андрій'`)).rows[0];
    assert.equal(bondar.user_id, null, "🔴 однофамільців привʼязано навмання — «рівно один» серед УСІХ акаунтів");
  } finally { await s.done(); }
});

/**
 * #563 — ПОВТОРНИЙ ІМПОРТ НЕ ДУБЛЮЄ І НЕ ЗАТИРАЄ: люди оновлюються за ПІБ, порожня клітинка не стирає
 * заповнене, пароль, що вже є в сейфі (або змінений у дашборді), не перезаписується; аркуш звільнених
 * ставить статус. 🧨 Червоніє, якщо upsert за іншим ключем, COALESCE прибрати або писати секрет щоразу.
 */
test("#563 ЖИВИЙ SQL: повторний імпорт — без дублів, без затирання, сейф не перезаписує", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  try {
    await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    const n0 = (await s.c.query(`SELECT count(*)::int n FROM employee_secrets`)).rows[0].n;
    const again = await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    assert.deepEqual([again.created, again.updated, again.secretsCreated, again.secretsExisting], [0, 3, 0, 5]);
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 3, "🔴 повторний імпорт задублював людей");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employee_secrets`)).rows[0].n, n0, "🔴 повторний імпорт задублював паролі");
    const thin = [HEAD, "Коваленко Олена Петрівна,,,,,,,,,"].join("\n");
    await emp.commitImport(s.db, KEY, s.ivan, thin, MAP, "dismissed");
    const o = (await s.c.query(`SELECT status, phone, position FROM employees WHERE import_key = 'коваленко олена петрівна'`)).rows[0];
    assert.deepEqual([o.status, o.phone, o.position], ["dismissed", "+380501112233", "Менеджер"], "🔴 порожня клітинка стерла заповнене або статус не той");
    const pv = await emp.previewImport(s.db, CSV, ["full_name", "position", "email", "phone", "birth_date", "secret:login:kommo", "extra", "secret:password:mail", "secret:card", "extra"]);
    assert.match(pv.mappingError ?? "", /схожа на пароль/, "🔴 прев'ю прийняло пароль у «як є»");
    assert.equal(pv.rows.length, 0);
  } finally { await s.done(); }
});

/** #564 — реєстр закритий для AI-помічника: REVOKE після GRANT і CREATE + FORBIDDEN_TABLES. */
test("#564 РЕЄСТР: employees відібрана в ai_readonly і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const create = sql.indexOf("CREATE TABLE IF NOT EXISTS employees (");
  const revoke = sql.indexOf("REVOKE ALL ON employees FROM ai_readonly;");
  const grant = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  assert.ok(grant > 0 && create > 0, "🔴 немає GRANT або CREATE employees");
  assert.ok(revoke > create && revoke > grant, "🔴 REVOKE немає або він вище за CREATE/GRANT");
  assert.match(SRC("ai/metricTools.ts"), /"employees",/, "🔴 employees немає у FORBIDDEN_TABLES");
});

/**
 * Фікстура — БУДОВА аркуша «Укр NEW» (дані вигадані): рядок фільтра «ч=», порожній, обʼєднана
 * клітинка компанії й «Kommo» над логіном/паролем, заголовки з переносами в 4-му рядку, колонка №
 * без назви, порожній 5-й, далі люди; посеред — рядок іншої компанії й повтор шапки.
 */
const SHEET = [
  '"ч=",,,,,,,,,,,',
  ",Примітка: оновлювати щопонеділка,,,,,,,,,,",
  ',"ЮТ-СЕРВІС\n40389341",,,,,,,,,Kommo,',
  ',ПІБ,Посада,№ команди,"Дата\nнародження",Телефон,"Дата\nприйому","Дата\nзвільнення","Документи (паспорт,код, договори), посилання на гугл диск",банківські картки,Логін,Пароль',
  ",,,,,,,,,,,",
  '1,Коваленко Олена Петрівна,віддалений менеджер,3,26.02.2003,0661112233,02.09.2026,,,"Приват 4149 4990 1234 4521; моно 5375414112345678",o.kovalenko,Kx-Fixture-1',
  ',ТОВ ІНША КОМПАНІЯ 12345678,,,,,,,,,,',
  ',ПІБ,Посада,№ команди,"Дата\nнародження",Телефон,"Дата\nприйому","Дата\nзвільнення","Документи (паспорт,код, договори), посилання на гугл диск",банківські картки,Логін,Пароль',
  "2,Сидоренко Марія,бухгалтер,,01.01.1990,0671112233,,,,,,",
].join("\n");

/**
 * #565 — АРКУШ ЯК У ЖИТТІ: заголовки не в першому рядку, двоповерхова шапка, кілька карток в одній
 * клітинці, службові рядки й повтор шапки посеред аркуша не стають людьми; колонку без назви не
 * можна «зберегти як є». 🧨 Червоніє, якщо брати заголовки з 1-го рядка, не склеювати «Kommo»,
 * брати лише першу картку або пропустити службовий рядок у реєстр.
 */
test("#565 АРКУШ: рядок заголовків знаходиться сам, «Kommo» над паролем, кілька карток, службові рядки — не люди", () => {
  const t = parseCsv(SHEET);
  const best = detectHeaderRow(t)[0];
  assert.equal(best.row, 3, "🔴 рядок заголовків не знайдено (очікували 4-й)");
  assert.ok(!JSON.stringify(detectHeaderRow(t)).includes("Kx-Fixture"), "🔴 кандидати рядка заголовків несуть вміст клітинок");
  const h = headersAt(t, 3);
  assert.deepEqual(h.map(guessTarget), ["skip", "full_name", "position", "team_label", "birth_date", "phone", "hired_at", "dismissed_at", "skip",
    "secret:card", "secret:login:kommo", "secret:password:kommo"], "🔴 колонки впізнано не так: " + h.join(" | "));
  assert.deepEqual([h[1], h[2], h[5]], ["ПІБ", "Посада", "Телефон"], "🔴 назву компанії приклеєно до впізнаних колонок");
  assert.deepEqual(cardsIn("Приват 4149 4990 1234 4521; моно 5375414112345678"), ["4149499012344521", "5375414112345678"]);
  assert.deepEqual(cardsIn("тел 0661112233"), [], "🔴 телефон прийнято за картку");
  const rows = buildRows(t, h.map(guessTarget), 3);
  assert.deepEqual(rows.map((r) => r.full_name), ["Коваленко Олена Петрівна", "Сидоренко Марія"], "🔴 службовий рядок чи повтор шапки став людиною");
  const o = rows[0];
  assert.deepEqual([o.line, o.fields.birth_date, o.fields.hired_at, o.fields.team_label], [6, "2003-02-26", "2026-09-02", "3"]);
  assert.deepEqual(o.secrets.map((x) => [x.kind, x.service, x.label, x.login]),
    [["card", "card", null, null], ["card", "card", "картка 2", null], ["password", "kommo", null, "o.kovalenko"]], "🔴 друга картка загубилась або пароль без логіна");
  assert.throws(() => validateMapping(h, h.map((x, i) => (i === 0 ? "extra" : guessTarget(x)))), /без назви/, "🔴 колонку без назви пустили в «як є»");
  // Пари «сервіс → Пароль» (так побудовано «Укр NEW»): логін у колонці сервісу, пароль праворуч.
  const pairs = headersAt([["ПІБ", "Пошта", "Пароль", "Kommo СРМ", "Пароль", "UTS", "Пароль", "Лінія в телефонії", "Замітки", "ПІ"]], 0);
  assert.deepEqual(pairs.map(guessTarget), ["full_name", "email", "secret:password:mail", "secret:login:kommo", "secret:password:kommo",
    "extra", "secret:password:other", "extra", "secret:password:other", "extra"], "🔴 пари «сервіс → Пароль» розпізнано не так: " + pairs.join(" | "));
  assert.throws(() => validateMapping(pairs, pairs.map((x) => (x === "Замітки" ? "note" : guessTarget(x)))), /схожа на пароль/, "🔴 замітки (з паролями всередині) пустили в реєстр текстом");
  // Решта колонок «Укр NEW» (прохання Романа «перероби»): нічого не губиться, «ПД - ИНН» — лише в сейф.
  assert.deepEqual(["Yaware", "Кількість днів працює", "#REF!", "ПД - ИНН"].map(guessTarget), ["extra", "extra", "extra", "secret:password:other"]);
  const twoRef = buildRows([["ПІБ", "#REF!", "#REF!"], ["Коваленко Олена", "1", "2"]], ["full_name", "extra", "extra"]);
  assert.deepEqual(twoRef[0].extra, { "#REF!": "1", "#REF! (колонка 3)": "2" }, "🔴 дві колонки з однаковою назвою перетерли одна одну");
});

/**
 * #566 — ЖИВИЙ SQL: той самий аркуш через прев'ю й імпорт — рядок заголовків 4 сам, два люди,
 * два службові рядки пропущено й пораховано, обидві картки в сейфі.
 * 🧨 Червоніє, якщо імпорт візьме інший рядок заголовків, ніж прев'ю, або загубить картку.
 */
test("#566 ЖИВИЙ SQL: аркуш «як у житті» — прев'ю й імпорт беруть той самий рядок заголовків", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  try {
    const pv = await emp.previewImport(s.db, SHEET, undefined);
    assert.equal(pv.headerRow, 4);
    assert.equal(pv.mappingError, null);
    assert.deepEqual([pv.totals?.rows, pv.totals?.skipped, pv.totals?.withAccount], [2, 2, 1], "🔴 прев'ю порахувало не тих людей");
    const c = await emp.commitImport(s.db, KEY, s.ivan, SHEET, pv.columns.map((x) => x.target), "active", pv.headerRow);
    assert.deepEqual([c.created, c.secretsCreated, c.secretsNoAccount], [2, 3, 0]);
    const cards = (await s.c.query(`SELECT last4, label FROM employee_secrets WHERE user_id=$1 AND kind='card' ORDER BY id`, [s.olena])).rows;
    assert.deepEqual(cards.map((r) => [r.last4, r.label]), [["4521", null], ["5678", "картка 2"]], "🔴 друга картка не лягла в сейф");
    assert.ok(!JSON.stringify([pv, (await s.c.query(`SELECT * FROM employees`)).rows]).includes("Kx-Fixture-1"), "🔴 пароль видно поза сейфом");
  } finally { await s.done(); }
});

/**
 * #567 — СЕЙФ ДЛЯ ЛЮДИНИ БЕЗ АКАУНТА (рішення Романа 18.09.2026: «додати усіх з таблиці»): пароль лягає
 * на людину реєстру, видно її в «Доступах», відкривається лише кодом; шифр не підставити іншій людині.
 * 🧨 Червоніє, якщо імпорт пропускає паролі людей без акаунта, AAD не різнить `e<id>` чи показ обходить код.
 */
test("#567 ЖИВИЙ SQL: людина без акаунта — пароль у сейфі на ній, показ лише з кодом, чужим AAD не відкривається", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  const sec = await import("./secrets.js");
  const { unseal, aadFor } = await import("./secretBox.js");
  try {
    await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    const maria = (await s.c.query(`SELECT id FROM employees WHERE import_key = 'сидоренко марія'`)).rows[0].id as number;
    const row = (await s.c.query(`SELECT id, user_id, employee_id, kind, service, cipher, iv, tag FROM employee_secrets WHERE employee_id = $1`, [maria])).rows;
    assert.equal(row.length, 1, "🔴 пароль людини без акаунта не ліг у сейф");
    assert.equal(row[0].user_id, null);
    const people = await sec.listPeople(s.db);
    const m = people.find((p) => p.ref === `e${maria}`) as { has_account: boolean; passwords: number } | undefined;
    assert.ok(m && m.has_account === false && m.passwords === 1, "🔴 людини без акаунта немає в «Доступах»");
    assert.equal((await sec.personVault(s.db, `e${maria}`)).items.length, 1);
    assert.throws(() => unseal(KEY, row[0], aadFor(s.olena, "password", "mail")), "🔴 шифр людини реєстру відкрився як шифр акаунта");
    // Підміна в базі: шифр Бондаря (теж без акаунта — однофамільці) переписано на Марію. Не має відкритись.
    const bondar = (await s.c.query(`SELECT s.user_id, s.employee_id, s.kind, s.service, s.cipher, s.iv, s.tag FROM employee_secrets s
      JOIN employees e ON e.id = s.employee_id WHERE e.import_key = 'бондар андрій'`)).rows[0];
    assert.equal(unseal(KEY, bondar, sec.aadOfRow(bondar)), "Pw-Bondar-1", "дзеркало: свій шифр відкривається");
    assert.throws(() => unseal(KEY, bondar, sec.aadOfRow({ ...bondar, employee_id: maria })), "🔴 шифр однієї людини реєстру відкрився як шифр іншої");
    await s.c.query(`UPDATE users SET vault_chat_id = 555 WHERE id = $1`, [s.ivan]);
    const sent: string[] = [];
    await sec.sendRevealCode(s.db, s.ivan, row[0].id, async (_c, text) => { sent.push(text); return true; });
    await assert.rejects(sec.revealSecret(s.db, KEY, s.ivan, row[0].id, { code: "000000" }), "🔴 показ без правильного коду");
    const code = /(\d{6})/.exec(sent[0])![1];
    const shown = await sec.revealSecret(s.db, KEY, s.ivan, row[0].id, { code, reason: "перевірка" });
    assert.equal(shown.value, "SomeMail-1!", "🔴 показано не той пароль");
    assert.match(sent[0], /Сидоренко Марія/, "🔴 у коді не названо, чий це доступ");
    assert.ok((await s.c.query(`SELECT 1 FROM access_audit WHERE action = 'secret.reveal' AND target_id = $1`, [`e${maria}`])).rowCount, "🔴 показ не записано в журнал людини");
  } finally { await s.done(); }
});

/**
 * #568 — ПОВТОРНИЙ ПРИЙОМ: людина двічі в аркуші (у «Укр NEW» таких 9) — один рядок у реєстрі, паролі з ОБОХ
 * рядків у сейфі, «працює» бере гору над давнім звільненням. Дати «4/15/2024» і числом Excel читаються.
 * 🧨 Червоніє, якщо другий рядок відкидати (паролі губляться) або старе звільнення перетирає поточний статус.
 */
test("#568 ЖИВИЙ SQL: повтор людини — обʼєднання з паролями обох рядків; дати US і Excel", async (t) => {
  assert.equal(parseDate("4/15/2024"), "2024-04-15");
  assert.equal(parseDate("45292"), "2024-01-01", "🔴 число Sheets читається не від 30.12.1899");
  assert.equal(parseDate("38130"), "2004-05-23");
  assert.equal(parseDate("5/3/24"), "2024-03-05", "🔴 день/місяць переплутано там, де обидва ≤ 12");
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  try {
    const csv = [HEAD,
      "Коваленко Олена Петрівна,Менеджер,,,,,,Mail-Now-1,,",
      `Коваленко Олена Петрівна,Стажер,,+380501112233,,o.old,Kommo-Old-1,Mail-Old-1,,`,
    ].join("\n");
    const map = ["full_name", "position", "email", "phone", "dismissed_at", "secret:login:kommo", "secret:password:kommo", "secret:password:mail", "secret:card", "extra"];
    const csv2 = csv.replace("o.old,Kommo-Old-1", "o.old,Kommo-Old-1").replace(",+380501112233,,", ",+380501112233,03.01.2023,");
    const c = await emp.commitImport(s.db, KEY, s.ivan, csv2, map, "active");
    assert.deepEqual([c.rows, c.duplicate, c.secretsCreated], [1, 1, 3], "🔴 другий рядок відкинуто разом із паролями");
    const o = (await s.c.query(`SELECT status, position, phone FROM employees`)).rows;
    assert.deepEqual(o, [{ status: "active", position: "Менеджер", phone: "+380501112233" }], "🔴 давнє звільнення перетерло поточний статус");
    const labels = (await s.c.query(`SELECT service, label FROM employee_secrets ORDER BY service, id`)).rows.map((r) => `${r.service}:${r.label ?? ""}`);
    assert.deepEqual(labels, ["kommo:", "mail:", "mail:рядок 3"], "🔴 пароль того самого сервісу з другого рядка не ліг окремо");
  } finally { await s.done(); }
});

/**
 * #569 — РЕДАГУВАННЯ ЛЮДИНИ: поля міняються, «працює» стирає дату звільнення, нова дата звільнення ставить
 * «звільнений»; погана дата й порожнє ПІБ — 400; після перейменування повторний імпорт НЕ дублює людину.
 * 🧨 Червоніє, якщо дозволити порожнє ПІБ, не узгодити статус із датою або переписувати `import_key`.
 */
test("#569 ЖИВИЙ SQL: редагування — статус узгоджено з датою звільнення, імпорт після перейменування без дубля", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  try {
    await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    const id = (await s.c.query(`SELECT id FROM employees WHERE import_key = 'сидоренко марія'`)).rows[0].id as number;
    const bad = (e: unknown) => (e as { status?: number }).status === 400;
    await assert.rejects(emp.updateEmployee(s.db, s.ivan, id, { full_name: "  " }), bad, "🔴 порожнє ПІБ прийнято");
    await assert.rejects(emp.updateEmployee(s.db, s.ivan, id, { hired_at: "31.02.2024" }), bad, "🔴 неіснуючу дату прийнято");
    const r1 = await emp.updateEmployee(s.db, s.ivan, id, { team_label: "РПК · Дмитрук", dismissed_at: "01.09.2026", full_name: "Сидоренко Марія Іванівна" });
    assert.deepEqual(r1.changed.sort(), ["dismissed_at", "full_name", "status", "team_label"]);
    let row = (await s.c.query(`SELECT status, dismissed_at::text AS d, team_label FROM employees WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { status: "dismissed", d: "2026-09-01", team_label: "РПК · Дмитрук" }, "🔴 дата звільнення не поставила статус");
    await emp.updateEmployee(s.db, s.ivan, id, { status: "active" });
    row = (await s.c.query(`SELECT status, dismissed_at FROM employees WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { status: "active", dismissed_at: null }, "🔴 «працює» лишило дату звільнення");
    assert.deepEqual((await emp.updateEmployee(s.db, s.ivan, id, { status: "active" })).changed, [], "🔴 зміна без змін записана");
    await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 3, "🔴 після перейменування імпорт задублював людину");
    assert.ok((await s.c.query(`SELECT 1 FROM access_audit WHERE action = 'employees.update' AND target_id = $1`, [`e${id}`])).rowCount, "🔴 зміну не записано в журнал");
  } finally { await s.done(); }
});

/**
 * #570 — ІМПОРТ ПАКЕТАМИ: 1554 паролі поштучно йшли 3 хв, і браузер не дочікувався відповіді (18.09.2026).
 * Тепер на людину — upsert + одне вставлення записів + одне аудиту; наявні записи — одним запитом на весь імпорт.
 * Результат той самий: лічильники, шифр розшифровується, повтор нічого не додає.
 * 🧨 Червоніє, якщо повернути перевірку й запис по одному паролю (запитів стане ~5 на пароль).
 */
test("#570 ЖИВИЙ SQL: імпорт пакетами — запитів ≈ 3 на людину, а не 5 на пароль; результат той самий", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  const { unseal, aadFor } = await import("./secretBox.js");
  try {
    const people = Array.from({ length: 30 }, (_, i) => `Тестовий${String.fromCharCode(1040 + i)} Іван,Менеджер,,+38050111${String(1000 + i)},,log${i},Pk-${i},Pm-${i},41494990123${String(10000 + i)},`);
    const csv = [HEAD, `Коваленко Олена Петрівна,Менеджер,olena@uts.ua,,,o.k,${PASS},${MAILPASS},${CARD},`, ...people].join("\n");
    let n = 0;
    const counted = { query: (sql: string, params?: unknown[]) => { n++; return s.db.query(sql, params); } } as typeof s.db;
    const c = await emp.commitImport(counted, KEY, s.ivan, csv, MAP, "active");
    assert.deepEqual([c.rows, c.secretsCreated, c.secretsInvalid], [31, 93, 0]);
    const perPerson = n / 31;
    assert.ok(perPerson <= 4, `🔴 запитів ${n} на 31 людину й 93 паролі (${perPerson.toFixed(1)} на людину) — запис знову поштучний`);
    const k = (await s.c.query(`SELECT cipher, iv, tag FROM employee_secrets WHERE user_id = $1 AND service = 'kommo'`, [s.olena])).rows[0];
    assert.equal(unseal(KEY, k, aadFor(s.olena, "password", "kommo")), PASS, "🔴 пакетний шифр не розшифровується");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM access_audit WHERE action = 'secret.create'`)).rows[0].n, 93, "🔴 не кожен запис має рядок аудиту");
    const again = await emp.commitImport(s.db, KEY, s.ivan, csv, MAP, "active");
    assert.deepEqual([again.secretsCreated, again.secretsExisting], [0, 93]);
  } finally { await s.done(); }
});

/**
 * #571 — ОДИН ІМПОРТ ЗА РАЗ: другий, поки перший не завершив транзакцію, отримує 409 і нічого не пише.
 * 🧨 Червоніє, якщо прибрати `pg_try_advisory_xact_lock`.
 */
test("#571 ЖИВИЙ SQL: другий імпорт під час першого — 409, нічого не записано", async (t) => {
  const s = await scratch(t); if (!s) return;
  const emp = await import("./employees.js");
  const { default: pg } = await import("pg");
  const other = new pg.Client({ connectionString: s.url });
  await other.connect();
  try {
    await other.query("BEGIN");
    await other.query(`SELECT pg_advisory_xact_lock(hashtext('employees.import'))`);
    await assert.rejects(emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active"), (e: unknown) => (e as { status?: number }).status === 409, "🔴 другий імпорт пішов паралельно");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employees`)).rows[0].n, 0, "🔴 другий імпорт щось записав");
    await other.query("ROLLBACK");
    const c = await emp.commitImport(s.db, KEY, s.ivan, CSV, MAP, "active");
    assert.equal(c.rows, 3, "дзеркало: після завершення першого імпорт іде");
  } finally { await other.end(); await s.done(); }
});
