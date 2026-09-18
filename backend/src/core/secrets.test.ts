import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  parseKey, seal, unseal, aadFor, normalizeCard, verifyRevealCode, hashCode, SecretKeyMissing, revealCodeMessage,
} from "./secretBox.js";

/**
 * 🔐 СЕЙФ ДОСТУПІВ (18.09.2026) — гейти `#550`–`#556`.
 * Номери з запасом над `#547` (прохід 2b) — борг 17: перед мержем перемірити перетин.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const KEY = randomBytes(32);
const code = (s: number) => (e: { status?: number }) => e.status === s;

/**
 * #550 — ШИФР: туди й назад; шифр ≠ текст; підміна рядка (інша людина чи сервіс), тегу чи ключа —
 * помилка, а не чужий пароль; без ключа — зрозуміла відмова; ключ лише 32 байти.
 * 🧨 Червоніє, якщо прибрати AAD, перевірку тегу або прийняти ключ не тієї довжини.
 */
test("#550 ШИФР: AES-GCM з привʼязкою до людини й сервісу, підміна — помилка", () => {
  const aad = aadFor(7, "password", "kommo");
  const box = seal(KEY, "Kx7!q2Lm-пароль", aad);
  assert.equal(unseal(KEY, box, aad), "Kx7!q2Lm-пароль");
  assert.ok(!Buffer.from(box.cipher, "base64").toString("utf8").includes("Kx7!q2Lm"), "🔴 шифр містить пароль");
  assert.notEqual(seal(KEY, "Kx7!q2Lm-пароль", aad).cipher, box.cipher, "🔴 однаковий шифр для однакового пароля — IV не випадковий");
  assert.throws(() => unseal(KEY, box, aadFor(8, "password", "kommo")), "🔴 шифр Олени розшифрувався в рядку Андрія");
  assert.throws(() => unseal(KEY, box, aadFor(7, "password", "mail")), "🔴 шифр Kommo розшифрувався як пошта");
  const bad = { ...box, tag: Buffer.alloc(16).toString("base64") };
  assert.throws(() => unseal(KEY, bad, aad), "🔴 підроблений тег пройшов");
  assert.throws(() => unseal(randomBytes(32), box, aad), "🔴 чужий ключ розшифрував");
  assert.throws(() => seal(null, "x", aad), SecretKeyMissing);
  assert.equal(parseKey(KEY.toString("base64"))?.length, 32);
  assert.equal(parseKey(randomBytes(16).toString("base64")), null, "🔴 прийнято ключ 16 байт");
  assert.equal(parseKey(""), null);
  assert.equal(normalizeCard("4149 4990 1234 4521"), "4149499012344521");
  assert.equal(normalizeCard("4149"), null);
});

/** Схема з нуля, дві людини, фальшивий бот, що запамʼятовує надіслане. */
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
  const yulia = await ins("yulia@uts.ua", "kvp", "Левентова Юлія");
  const sent: { chat: string | number; text: string }[] = [];
  const send = async (chat: string | number, text: string) => { sent.push({ chat, text }); return true; };
  return { c, db: c as unknown as import("./secrets.js").Db, ivan, olena, yulia, sent, send, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #551 — ЗНАЧЕННЯ НЕ ВИТІКАЄ НІКУДИ, КРІМ ПОКАЗУ: список людей, картка людини, журнал, аудит і
 * сирі колонки бази не містять ні пароля, ні повного номера картки.
 * 🧨 Червоніє, якщо вибрати шифр/значення в картку, покласти значення в аудит чи зберегти текстом.
 */
test("#551 ЖИВИЙ SQL: пароль і номер картки не з'являються ні в списку, ні в картці, ні в аудиті, ні в базі", async (t) => {
  const s = await scratch(t); if (!s) return;
  const sec = await import("./secrets.js");
  try {
    const PASS = "Kx7!q2Lm-Sekret", CARD = "4149499012344521";
    await sec.createSecret(s.db, KEY, s.ivan, s.olena, { kind: "password", service: "kommo", login: "o.kovalenko@uts.ua", value: PASS });
    const cardId = await sec.createSecret(s.db, KEY, s.ivan, s.olena, { kind: "card", value: "4149 4990 1234 4521" });
    await sec.updateSecret(s.db, KEY, s.ivan, cardId, { value: "4149 4990 1234 4521" });
    const everything = JSON.stringify([
      await sec.listPeople(s.db), await sec.personVault(s.db, s.olena),
      (await s.c.query(`SELECT * FROM access_audit`)).rows,
      (await s.c.query(`SELECT * FROM employee_secrets`)).rows,
    ]);
    assert.ok(!everything.includes(PASS), "🔴 пароль видно поза показом");
    assert.ok(!everything.includes(CARD) && !everything.includes("4149 4990 1234 4521"), "🔴 повний номер картки видно поза показом");
    const v = await sec.personVault(s.db, s.olena);
    assert.deepEqual(v.items.filter((i) => !i.deleted_at).map((i) => [i.kind, i.service, i.login, i.last4]).sort(),
      [["card", "card", null, "4521"], ["password", "kommo", "o.kovalenko@uts.ua", null]], "🔴 картка людини показує не те");
    assert.ok(v.journal.some((j) => j.action === "secret.update"), "🔴 зміну не записано в журнал");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM employee_secrets WHERE superseded_at IS NOT NULL`)).rows[0].n, 1, "🔴 стара версія не лишилась в історії");
  } finally { await s.done(); }
});

/**
 * #552 — ПОКАЗ ЛИШЕ З КОДОМ, ЛИШЕ ЙОМУ, ОДИН РАЗ. Без привʼязаного Telegram — ні; код у повідомленні,
 * пароля в повідомленні немає; хибний код зʼїдає спробу, три — спалюють; правильний — значення й
 * запис в аудиті з причиною; той самий код удруге — ні; чужий код — ні.
 * 🧨 Червоніє, якщо пустити без коду, дати код повторно, покласти пароль у повідомлення або не записати показ.
 */
test("#552 ЖИВИЙ SQL: «Показати» — код у Telegram, три спроби, один раз, запис в аудиті", async (t) => {
  const s = await scratch(t); if (!s) return;
  const sec = await import("./secrets.js");
  try {
    const PASS = "Demo-Ml9%xQ4e";
    const id = await sec.createSecret(s.db, KEY, s.ivan, s.olena, { kind: "password", service: "mail", login: "olena@uts.ua", value: PASS });
    await assert.rejects(sec.sendRevealCode(s.db, s.ivan, id, s.send), (e: { status?: number; extra?: { needLink?: boolean } }) => e.status === 409 && e.extra?.needLink === true, "🔴 код пішов без привʼязаного Telegram");
    await s.c.query(`UPDATE users SET vault_chat_id = 555, vault_linked_at = now() WHERE id = ANY($1)`, [[s.ivan, s.yulia]]);
    await assert.rejects(sec.revealSecret(s.db, KEY, s.ivan, id, { code: "000000" }), code(400), "🔴 показ без надісланого коду");

    await sec.sendRevealCode(s.db, s.ivan, id, s.send);
    const msg = s.sent.at(-1)!.text;
    const sentCode = /(\d{6})/.exec(msg)![1];
    assert.ok(!msg.includes(PASS), "🔴 пароль потрапив у Telegram");
    assert.match(msg, /«Пошта» · Коваленко Олена/, "🔴 у повідомленні не сказано, що саме відкривається");
    const wrong = sentCode === "111111" ? "222222" : "111111";
    await assert.rejects(sec.revealSecret(s.db, KEY, s.ivan, id, { code: wrong }), code(403));
    await assert.rejects(sec.revealSecret(s.db, KEY, s.yulia, id, { code: sentCode }), code(400), "🔴 чужий код відкрив пароль Юлі");
    const out = await sec.revealSecret(s.db, KEY, s.ivan, id, { code: sentCode, reason: "видача ноутбука" });
    assert.deepEqual([out.value, out.login, out.seconds], [PASS, "olena@uts.ua", 30], "🔴 правильний код не показав пароль");
    await assert.rejects(sec.revealSecret(s.db, KEY, s.ivan, id, { code: sentCode }), code(410), "🔴 той самий код спрацював удруге");
    const a = (await s.c.query(`SELECT actor_user_id, target_id, details FROM access_audit WHERE action = 'secret.reveal'`)).rows;
    assert.deepEqual(a.map((r) => [r.actor_user_id, r.target_id, r.details.reason]), [[s.ivan, String(s.olena), "видача ноутбука"]], "🔴 показ не записано в аудит");

    await sec.sendRevealCode(s.db, s.ivan, id, s.send);
    for (let i = 0; i < 3; i++) await assert.rejects(sec.revealSecret(s.db, KEY, s.ivan, id, { code: "99999" + i }), code(i < 3 ? 403 : 410));
    const last = /(\d{6})/.exec(s.sent.at(-1)!.text)![1];
    await assert.rejects(sec.revealSecret(s.db, KEY, s.ivan, id, { code: last }), code(410), "🔴 після трьох помилок код ще працює");
    assert.equal(verifyRevealCode({ codeHash: hashCode("123456", "s"), salt: "s", attempts: 0, expiresAt: new Date(Date.now() - 1), usedAt: null }, "123456", new Date()).ok, false, "🔴 прострочений код прийнято");
    assert.ok(!revealCodeMessage("123456", "Kommo", "X").includes("пароль:"));
  } finally { await s.done(); }
});

/**
 * #553 — ПРАВО НА РІВНІ РОУТЕРА, СКЛАД — РІВНО ПʼЯТЬ РОЛЕЙ (рішення Романа 18.09.2026).
 * Дзеркало: КВП і HR — так; тімлід, менеджер, фінансист, бухгалтерія, кандидат — ні.
 * 🧨 Червоніє, якщо зняти гейт із роутера, розширити чи звузити склад або забути каталог прав.
 */
test("#553 ПРАВО: сейф за view_employee_secrets на роутері; видано рівно admin, ceo, opdir, kvp, hr", async () => {
  assert.match(SRC("routes/secrets.ts"), /secretsRouter\.use\(requireAuth, requirePerm\("view_employee_secrets"\)\);/, "🔴 сейф без права на рівні роутера");
  const sql = SRC("db/schema.sql");
  const give = /UPDATE roles SET permissions = permissions \|\| '\{"view_employee_secrets": true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/.exec(sql);
  assert.ok(give, "🔴 у схемі немає видачі права");
  assert.deepEqual(give[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort(), ["admin", "ceo", "hr", "kvp", "opdir"], "🔴 склад ролей змінився");
  assert.match(sql, /UPDATE roles SET permissions = permissions - 'view_employee_secrets'\s*\n\s*WHERE key NOT IN \('admin', 'ceo', 'opdir', 'kvp', 'hr'\)/, "🔴 зняття в решти ролей прибрано");
  const { PERMISSION_CATALOG } = await import("../auth/permGrant.js");
  assert.ok((PERMISSION_CATALOG as readonly string[]).includes("view_employee_secrets"), "🔴 права немає в каталозі");
  assert.match(SRC("auth/routeTab.ts"), /\{ test: pre\("\/api\/secrets"\), tabs: \["hiring"\] \}/, "🔴 сейф без вкладки");
});

/** #554 — таблиці сейфу закриті для AI-помічника: REVOKE після GRANT і CREATE + FORBIDDEN_TABLES. */
test("#554 СЕЙФ: employee_secrets, secret_reveal_codes, vault_link_codes відібрані в ai_readonly і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  for (const table of ["employee_secrets", "secret_reveal_codes", "vault_link_codes"]) {
    const createAt = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    assert.ok(grantAt > 0 && createAt > 0, `🔴 немає GRANT або CREATE ${table}`);
    const ok = [...sql.matchAll(/REVOKE ALL ON ([^;]*?) FROM ai_readonly;/g)]
      .some((m) => new RegExp(`\\b${table}\\b`).test(m[1]) && m.index! > grantAt && m.index! > createAt);
    assert.ok(ok, `🔴 ${table} не відібрана в ai_readonly після GRANT і CREATE`);
    assert.ok(list && list[1].includes(`"${table}"`), `🔴 ${table} не в FORBIDDEN_TABLES`);
  }
});

/**
 * #555 — БЕЗ КЛЮЧА СЕЙФ ВІДМОВЛЯЄ (503), А СЕРВЕР СТАРТУЄ. Ключ не читається конфігом як обовʼязковий
 * (інакше падав би весь дашборд), і ні запис, ні показ без нього не проходять.
 * 🧨 Червоніє, якщо зробити ключ обовʼязковим на старті або шифрувати «без ключа».
 */
test("#555 КЛЮЧ: без ключа — 503 на запис і показ, сервер при цьому стартує", async (t) => {
  assert.doesNotMatch(SRC("config.ts"), /EMPLOYEE_SECRETS_KEY/, "🔴 ключ сейфу став обовʼязковим для старту");
  const r = SRC("routes/secrets.ts");
  assert.match(r, /if \(e instanceof SecretKeyMissing\) return res\.status\(503\)/, "🔴 відсутній ключ не дає 503");
  assert.match(r, /const key = \(\) => parseKey\(process\.env\.EMPLOYEE_SECRETS_KEY\);/);
  const s = await scratch(t); if (!s) return;
  const sec = await import("./secrets.js");
  try {
    await assert.rejects(sec.createSecret(s.db, null, s.ivan, s.olena, { kind: "password", service: "kommo", value: "x" }), SecretKeyMissing, "🔴 запис без ключа");
    const id = await sec.createSecret(s.db, KEY, s.ivan, s.olena, { kind: "password", service: "kommo", value: "x" });
    await assert.rejects(sec.revealSecret(s.db, null, s.ivan, id, { code: "123456" }), SecretKeyMissing, "🔴 показ без ключа");
  } finally { await s.done(); }
});

/**
 * #556 — БОТ «UTS Сейф»: окремий секрет вебхука (не той, що в бота підпису); вебхук першим ділом
 * звіряє секрет; код привʼязки одноразовий і привʼязує рівно його власника.
 * 🧨 Червоніє, якщо вебхук прийме оновлення без секрету, секрети ботів збіжуться або код спрацює двічі.
 */
test("#556 БОТ СЕЙФУ: свій секрет вебхука, код привʼязки одноразовий", async (t) => {
  const { vaultWebhookSecret } = await import("../bot/vaultBot.js");
  const { webhookSecret } = await import("../bot/signBot.js");
  const keep = [process.env.TELEGRAM_VAULT_BOT_TOKEN, process.env.TELEGRAM_SIGN_BOT_TOKEN];
  process.env.TELEGRAM_VAULT_BOT_TOKEN = process.env.TELEGRAM_SIGN_BOT_TOKEN = "123:same-token";
  try { assert.notEqual(vaultWebhookSecret(), webhookSecret(), "🔴 секрет вебхука сейфу == секрету бота підпису"); }
  finally { process.env.TELEGRAM_VAULT_BOT_TOKEN = keep[0]; process.env.TELEGRAM_SIGN_BOT_TOKEN = keep[1]; }
  const route = SRC("routes/vaultBot.ts");
  const body = route.slice(route.indexOf('vaultBotRouter.post("/webhook"'));
  assert.match(body, /^[^\n]*\n\s*const secret = vaultWebhookSecret\(\);\n\s*if \(!secret \|\| req\.header\("X-Telegram-Bot-Api-Secret-Token"\) !== secret\) return res\.status\(401\)/, "🔴 вебхук не звіряє секрет першим");

  const s = await scratch(t); if (!s) return;
  const sec = await import("./secrets.js");
  try {
    const { code: linkCode } = await sec.createVaultLink(s.db, s.yulia);
    assert.match(await sec.linkVaultChat(s.db, "000001", 900), /не підійшов/);
    assert.match(await sec.linkVaultChat(s.db, `/start ${linkCode}`, 777), /Привʼязано: Левентова Юлія/);
    assert.equal((await s.c.query(`SELECT vault_chat_id FROM users WHERE id=$1`, [s.yulia])).rows[0].vault_chat_id, "777");
    assert.match(await sec.linkVaultChat(s.db, linkCode, 888), /не підійшов/, "🔴 код привʼязки спрацював двічі");
    assert.equal((await s.c.query(`SELECT count(*)::int n FROM users WHERE vault_chat_id = 888`)).rows[0].n, 0, "🔴 чужий чат перехопив привʼязку");
  } finally { await s.done(); }
});
