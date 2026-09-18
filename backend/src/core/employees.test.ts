import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseCsv, parseDate, guessTarget, validateMapping, ImportError } from "./employeeImport.js";

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
  return { c, db: c as unknown as import("./secrets.js").Db, ivan, olena, andrii, done: async () => { await c.end(); s.dispose(); } };
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
      [3, 3, 1, 1, 3, 2], "🔴 лічильники імпорту не ті");
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
    assert.deepEqual([again.created, again.updated, again.secretsCreated, again.secretsExisting], [0, 3, 0, 3]);
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
