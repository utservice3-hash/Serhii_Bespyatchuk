import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { MIRROR_NOTE } from "./legacyLimits.js";
import { clientQuery, limitOfClient } from "./shared/clientLimits.js";

/**
 * 🔎 «＋ ДОДАТИ КЛІЄНТА» у «Лімітах клієнтів» (задача 7137; Сергій, UTS TOP Weekly 26.10: «сюди попадають тільки ті, хто в
 * активній дебіторці… додати всіх клієнтів, які в нас є в нашій базі… по назві або по коду»). Окремий файл, а не
 * `counterparty.test.ts`: наскрізний `#2791` піднімає свою scratch-БД, а пул `db/pool.js` — один на процес і вже закритий `#2409`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/**
 * #2790 — «＋ ДОДАТИ КЛІЄНТА» (задача 7137): що шукати і чи вже є ліміт. Рівно 8 або 10 цифр — код, а не частина назви
 * (9 цифр — назва); менше 2 знаків — нічого. Ліміт клієнта бази знаходиться і за ключем, і за кодом юрособи — те саме
 * правило, що ліміт ↔ боржник. 🧨 Червоніє, якщо код стане шукатись як назва (або навпаки), якщо порожній запит піде в
 * базу, або якщо дубль за кодом під іншим ключем не впізнається — тоді Сергій заведе клієнту другий ліміт.
 */
test("#2790 ДОДАТИ КЛІЄНТА: 8/10 цифр — код, коротше 2 — нічого; наявний ліміт — і за ключем, і за кодом", () => {
  assert.deepEqual(clientQuery("32025230"), { code: "32025230" });
  assert.deepEqual(clientQuery(" 3202523012 "), { code: "3202523012" });
  assert.deepEqual(clientQuery("320252301"), { text: "320252301" }, "9 цифр — не код");
  assert.deepEqual(clientQuery(" юмо "), { text: "юмо" });
  assert.deepEqual(clientQuery("юм"), { text: "юм" });
  assert.equal(clientQuery("ю"), null, "один знак пішов у пошук");
  assert.equal(clientQuery("   "), null);
  const L = [{ id: "1", debtorKey: "юмо", members: [] }, { id: "2", debtorKey: null, members: [{ code: "55555555", name: "Крем" }] }];
  assert.equal(limitOfClient(L, { key: "юмо", codes: [] }), "1", "ліміт за ключем не впізнано");
  assert.equal(limitOfClient(L, { key: "kcrm", codes: ["55555555"] }), "2", "ліміт під іншим ключем, але з тим самим кодом, не впізнано — буде другий ліміт");
  assert.equal(limitOfClient(L, { key: "інший", codes: ["11111111"] }), null, "чужий ліміт приписано клієнту");
  assert.equal(limitOfClient([], { key: "юмо", codes: ["55555555"] }), null);
});

/**
 * #2791 — 🪞 «＋ ДОДАТИ КЛІЄНТА» НАСКРІЗНО через наш вхід (scratch-БД). Пошук: за назвою — по нормалізованому ключу
 * («ТОВ «ЮМО»» = «юмо», точний збіг першим), за кодом — з компаній CRM і з рахунків 1С; службовий ключ «названиенеуказано»
 * не шукається; назва — компанія CRM, а не імʼя контакту в угоді; відповідальний — з останньої угоди; позначка «ліміт уже є».
 * Права: шукає й додає ЛИШЕ Сергій (менеджер, інший адмін, HR — 403). Додавання: клієнт без боргу → ліміт `set` з кодами
 * юрособ і подією «боргу зараз немає»; повтор / чужий код / вигаданий ключ / службовий ключ / без причини — 409/404/400.
 * Дзеркало пише ліміт клієнта без боргу в `client_credit_limits`, а коли він стане боржником під ІНШИМ ключем 1С —
 * дебіторка підхоплює ліміт за кодом. 🧨 Червоніє на кожному з цих відступів.
 */
test("#2791 🪞 ДОДАТИ КЛІЄНТА НАСКРІЗНО: пошук по базі, лише Сергій, ліміт без боргу → дзеркало, підхоплення за кодом", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  delete process.env.MINUS_APPROVER_IDS; delete process.env.CP_APPROVER_IDS;
  delete process.env.YOUCONTROL_API_KEY; delete process.env.YOUSCORE_API_KEY;
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query(`INSERT INTO teams (id, name) VALUES (1, 'Команда Ірини') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (10, 'Марина Коваль', 1), (11, 'Олег Ткачук', 1)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active, manager_id) VALUES
      (1, 'utservice3@gmail.com', 'x', 'admin', 'opdir', 'Сергій', true, NULL),
      (2, 'marina@t', 'x', 'manager', NULL, 'Марина Коваль', true, 10), (3, 'oleh@t', 'x', 'manager', NULL, 'Олег Ткачук', true, 11),
      (4, 'hr@t', 'x', 'manager', 'hr', 'HR', true, NULL), (5, 'admin2@t', 'x', 'admin', NULL, 'Інший адмін', true, NULL)`);
    await c.query(`INSERT INTO deals (kommo_id, client_key, client_name, manager_id, created_at_kommo) VALUES
      (101, 'юмо', 'ЮМО ТОВ', 10, '2026-07-01'), (102, 'юмо', 'Іван, контакт', 11, '2026-07-11'),
      (103, 'алюмотрейд', 'АЛЮМОТРЕЙД', 10, '2026-08-01'), (104, 'названиенеуказано', 'Название не указано', 10, '2026-09-01'),
      (105, 'kcrm', 'ТОВ Крем', 11, '2026-06-01')`);
    await c.query(`INSERT INTO kommo_companies (company_id, name, edrpou) VALUES (1, 'ЮМО ТОВ', '32025230'), (2, 'ТОВ Крем', '55555555'), (3, 'Нічия', '32025230')`);
    await c.query(`INSERT INTO deal_companies (deal_kommo_id, company_id) VALUES (102, 1), (105, 2), (104, 3)`);
    await c.query(`INSERT INTO receivables (client_key, client_name, manager_id, amount, limit_days, overdue_days) VALUES ('львівтрейд', 'ТОВ Львів Трейд', 10, 100000, 14, 20)`);
    await c.query(`INSERT INTO receivable_invoices (client_key, client_name, manager_id, invoice_no, invoice_date, amount, edrpou) VALUES
      ('львівтрейд', 'ТОВ Львів Трейд', 10, 'L-1', CURRENT_DATE - 20, 100000, '31234567')`);
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note, set_by) VALUES ('львівтрейд', 14, 200000, 'стара', 1)`);

    await import("../lib/asyncRoutes.js");
    const { default: express } = await import("express");
    const { buildClientLimitsRouter } = await import("./mount.js");
    const { migrateLegacyLimits, mirrorToReceivables } = await import("./legacyLimits.js");
    const { receivablesDebtSource } = await import("./debtSourceDb.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    const { pool } = await import("../db/pool.js");
    await refreshRoles();
    assert.deepEqual(await migrateLegacyLimits(pool), { inserted: 1, skipped: 0 });
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/client-limits", buildClientLimitsRouter());
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/client-limits`;
    const TOK: Record<string, string> = {
      serhii: signToken({ userId: 1, role: "admin", roleKey: "opdir", managerId: null, teamId: null } as never),
      marina: signToken({ userId: 2, role: "manager", roleKey: "manager", managerId: 10, teamId: 1 } as never),
      hr: signToken({ userId: 4, role: "company", roleKey: "hr", managerId: null, teamId: null } as never),
      admin2: signToken({ userId: 5, role: "admin", roleKey: "admin", managerId: null, teamId: null } as never),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (who: string, method: string, p: string, body?: unknown): Promise<{ s: number; j: any }> => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOK[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      let j: unknown = null; try { j = await r.json(); } catch { /* порожньо */ }
      return { s: r.status, j };
    };
    const find = (q: string) => call("serhii", "GET", `/search?q=${encodeURIComponent(q)}`);
    const body = { limit: 100000, days: 10, from: "inv", reason: "погодили на зустрічі" };

    // ---------- права: лише Сергій ----------
    for (const who of ["marina", "admin2", "hr"]) {
      assert.equal((await call(who, "GET", "/search?q=юмо")).s, 403, `${who} шукає по базі`);
      assert.equal((await call(who, "POST", "/add", { ...body, clientKey: "юмо" })).s, 403, `${who} додає клієнта`);
    }

    // ---------- пошук ----------
    let r = await find("ТОВ «ЮМО»");
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.hits.map((h: { key: string }) => h.key), ["юмо", "алюмотрейд"], "назва не нормалізована або точний збіг не першим");
    const yumo = r.j.hits[0];
    assert.equal(yumo.name, "ЮМО ТОВ", "назва — імʼя контакту з угоди, а не компанія CRM");
    assert.deepEqual(yumo.codes, ["32025230"]);
    assert.deepEqual([yumo.managerId, yumo.managerName, yumo.deals, yumo.debtor, yumo.limitId], ["3", "Олег Ткачук", 2, false, null], "відповідальний не з останньої угоди або лічильники хибні");
    r = await find("32025230");
    assert.deepEqual(r.j.hits.map((h: { key: string }) => h.key), ["юмо"], "пошук за кодом CRM зачепив службовий ключ або не знайшов клієнта");
    r = await find("31234567");
    assert.deepEqual(r.j.hits.map((h: { key: string; debtor: boolean }) => [h.key, h.debtor]), [["львівтрейд", true]], "код із рахунків 1С не шукається");
    assert.ok(r.j.hits[0].limitId, "боржник із лімітом без позначки «ліміт уже є»");
    assert.deepEqual((await find("названиенеуказано")).j.hits, [], "службовий ключ знаходиться");
    assert.deepEqual((await find("ю")).j.hits, [], "один знак пішов у базу");

    // ---------- додавання ----------
    assert.equal((await call("serhii", "POST", "/add", { ...body, clientKey: "юмо", reason: " " })).s, 400, "ліміт без причини");
    assert.equal((await call("serhii", "POST", "/add", { ...body, clientKey: "вигаданий" })).s, 404, "ліміт вигаданому клієнту");
    assert.equal((await call("serhii", "POST", "/add", { ...body, clientKey: "названиенеуказано" })).s, 404, "ліміт службовому ключу");
    assert.equal((await call("serhii", "POST", "/add", { ...body, clientKey: "львівтрейд" })).s, 409, "другий ліміт клієнту, що вже має ліміт");
    r = await call("serhii", "POST", "/add", { ...body, clientKey: "юмо" });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    assert.deepEqual([r.j.src, r.j.debtorKey, r.j.debt, r.j.limit, r.j.days, r.j.from, r.j.managerId], ["set", "юмо", 0, 100000, 10, "inv", "3"]);
    assert.deepEqual(r.j.members.map((m: { code: string }) => m.code), ["32025230"], "юрособи клієнта не перенеслись — суди й звʼязок за кодом не працюватимуть");
    assert.match(r.j.hist.find((h: { type: string }) => h.type === "limitSet")?.note ?? "", /Додано з бази клієнтів — боргу зараз немає\nПричина: погодили на зустрічі/);
    assert.equal((await call("serhii", "POST", "/add", { ...body, clientKey: "юмо" })).s, 409, "повтор завів другий ліміт");
    assert.ok((await find("юмо")).j.hits[0].limitId, "після додавання пошук не каже «ліміт уже є»");
    r = await call("serhii", "GET", "");
    assert.ok(r.j.rows.some((x: { debtorKey: string; debt: number }) => x.debtorKey === "юмо" && x.debt === 0), "доданого клієнта немає у вкладці");

    // ---------- дзеркало і підхоплення ----------
    assert.equal((await call("serhii", "POST", "/add", { ...body, clientKey: "kcrm", limit: 50000, days: 7 })).s, 201);
    const src = receivablesDebtSource(pool);   // без кешу пакета: боржник зʼявляється посеред тесту
    await mirrorToReceivables(pool, src);
    const ccl = (k: string) => c.query(`SELECT limit_days, limit_amount::numeric::float8 AS amt, note FROM client_credit_limits WHERE client_key = $1`, [k]).then((q) => q.rows[0]);
    assert.deepEqual(await ccl("юмо"), { limit_days: 10, amt: 100000, note: MIRROR_NOTE }, "ліміт клієнта без боргу не дійшов до дебіторки");
    await c.query(`INSERT INTO receivables (client_key, client_name, manager_id, amount, overdue_days) VALUES ('k-1c', 'КРЕМ ТОВ', 11, 70000, 3)`);
    await c.query(`INSERT INTO receivable_invoices (client_key, client_name, manager_id, invoice_no, invoice_date, amount, edrpou) VALUES ('k-1c', 'КРЕМ ТОВ', 11, 'K-1', CURRENT_DATE - 3, 70000, '55555555')`);
    await mirrorToReceivables(pool, src);
    assert.deepEqual((await c.query(`SELECT limit_days, limit_amount::numeric::float8 AS amt FROM receivables WHERE client_key = 'k-1c'`)).rows[0],
      { limit_days: 7, amt: 50000 }, "боржник під іншим ключем 1С не підхопив ліміт за кодом");
  } finally {
    await new Promise((res) => (server ? server.close(() => res(null)) : res(null)));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
  }
});

/**
 * #2792 — ФРОНТ «＋ ДОДАТИ КЛІЄНТА»: кнопка лише погоджувачу (сервер однаково відповість 403 — але кнопка, що веде в 403,
 * для решти — шум); пошук іде через наш api з відкладенням і відкидає застарілі відповіді (інакше повільна відповідь на
 * «ю» перезапише свіжу на «юмо»); помилка додавання не стирає введену форму. 🧨 Червоніє на кожному з цих відступів.
 */
test("#2792 ФРОНТ ДОДАТИ КЛІЄНТА: кнопка лише Сергію, пошук через api без застарілих відповідей, помилка не стирає форму", () => {
  const f = FRONT("minusRegistry/client/clientLimits/limits.ts");
  assert.match(f, /\$\('add'\)!\.innerHTML = u\.role === 'approver' \? '<button type="button" class="cp-btn cp-pri" data-add>＋ Додати клієнта<\/button>' : '';/,
    "кнопку «＋ Додати клієнта» бачить не лише погоджувач");
  assert.match(f, /searchTimer = setTimeout\(\(\) => \{\s*const my = \+\+searchSeq;\s*o\.api\.search\(q\)\.then\(j => \{ if \(adding && my === searchSeq\)/, "пошук без відкладення або без відсіву застарілих відповідей");
  assert.match(f, /\.catch\(e => \{ if \(adding && my === searchSeq\)/, "застаріла помилка пошуку перезаписує свіжий результат");
  const go = f.slice(f.indexOf("async function addGo()"), f.indexOf("// ---------- дії ----------"));
  assert.ok(go.length > 200, "addGo не знайдено — гейт нічого не перевіряє");
  assert.match(go, /o\.api\.add\(h\.key, v\)/);
  assert.ok(!/renderAdd\(\)/.test(go), "addGo перемальовує панель — на помилці форма втратить ліміт, дні й причину");
  assert.match(FRONT("minusRegistry/client/counterparty/api.ts"), /search: q => call\(api\.get\(`\$\{CL\}\/search`, \{ params: \{ q \} \}\)\),\s*add: \(clientKey, b\) => call\(api\.post\(`\$\{CL\}\/add`, \{ \.\.\.b, clientKey \}\)\),/);
});
