import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectFrom, runCases } from "../cargo/testkit/shim.js";
import type { BankTx } from "./txSource.js";

/**
 * 💳 «ВИПИСКА» — № РАХУНКУ НА ВХІДНИХ ФОП І КОМЕНТАРІ ДО ВИХІДНИХ (27.10.2026) — пакет Сергія `UTS_vypyska_nomer_rakhunku`.
 *
 * #2910–#2911 — ПОРТ його vitest-файлів (строк 48 роб. год; правила, статуси, тексти, розмітка рядка) ДОСЛІВНО через
 * прокладку; клієнтські модулі — з джерела фронту (`testkit/frontMods.ts`).
 * #2912 — справжній роут на тимчасовій базі через HTTP із токенами ролей: увесь цикл і всі межі прав (ТЗ §5, §9).
 * #2913 — межа видимості = межа стрічки «Виписки»: видалене, «лише фінанси», вихідні картки, приховані отримувачі.
 * #2914 — таблиці закрито від моделі. #2915 — фронт: копії спільного коду, один чанк, стиль на змінних дашборда, бейдж.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

async function cases(load: () => Promise<unknown>, min: number, what: string) {
  const list = await collectFrom(load);
  assert.ok(list.length >= min, `🔴 ${what}: випадків ${list.length} < ${min} — перевірці нічого проганяти`);
  const bad = await runCases(list);
  assert.deepEqual(bad, [], `🔴 ${what}: впали ${bad.length} із ${list.length}`);
}

/**
 * #2910 — СТРОК 48 РОБОЧИХ ГОДИН: пт 15:00 → вт 15:00; сб/нд → кінець вівторка; чт 17:30 → пн 17:30; «банк пт, у виписці
 * сб» → кінець вт; літній/зимовий час; свята — лише у форматі РРРР-ММ-ДД.
 * 🧨 Червоніє, якщо порахувати суботу чи неділю або взяти ранній із «банк» і «у виписці».
 */
test("#2910 СТРОК № РАХУНКУ: 48 роб. год за Києвом, без сб і нд, від пізнішого з «банк» і «у виписці»", async () => {
  await cases(() => import("./testkit/identDeadline.cases.js"), 7, "строк");
});

/**
 * #2911 — ПРАВИЛА І РЯДОК: під правилом лише вхідні ФОП / картки після запуску; свій переказ — без номера; прострочений —
 * «неідентифікований» назавжди; хто що може; перевірки вводу (хоча б одна цифра); тексти відмов; розмітка рядка «№ рахунку»,
 * фільтра й коментарів — з джерела фронту.
 * 🧨 Червоніє, якщо пустити номер без цифр, дати менеджеру «змінити» чи показати поле на прострочених.
 */
test("#2911 ПРАВИЛА «ВИПИСКИ»: статуси, права, перевірки вводу, тексти; рядок, фільтр і коментарі — з джерела фронту", async () => {
  await cases(() => import("./testkit/bankIdent.cases.js"), 16, "правила й екран");
});

/**
 * #2912 — ЖИВИЙ ЦИКЛ через HTTP на тимчасовій базі (ТЗ §9):
 *  - менеджер вписує № один раз → 201; удруге й іншому менеджеру — 409 «Номер уже зафіксовано … — імʼя»; без цифри — 400;
 *  - прострочений — 409 «Строк минув» навіть адміну; свій переказ — без рядка дій, 409; ЮТС — не під правилом (400);
 *  - СЕО: бачить історію, вписати не може (403); бухгалтерія: «не оплата клієнта» — так, номер — ні (403);
 *  - фінансист: зміна без причини — 400, з чужим `expected` — 409, з причиною — 200, історія «a → b · причина»;
 *  - коментарі до вихідних ФОП: менеджеру, фінансисту, СЕО — 403; бухгалтерії — 201; не ФОП — 400; прихований — 404;
 *  - лічильник: бейдж — лише тим, хто вписує; фільтр «Чекають №» не віддає видаленого рядка;
 *  - пошук стрічки «Виписки» знаходить платіж за № рахунку;
 *  - фіналізатор фіксує прострочене, якого ніхто не відкривав, і повторно — нуль;
 *  - склад прав після схеми — рівно за ТЗ (синки ролей не розтягли їх на СЕО / КВП / фінансиста).
 * 🧨 Червоніє, якщо зняти будь-яку перевірку прав, `ON CONFLICT`, `expected` чи межу видимості.
 */
test("#2912 ЖИВИЙ API «ВИПИСКИ» через HTTP: № один раз, строк, свої перекази, фінансист з причиною, бухгалтерія, коментарі, права", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  process.env.DATABASE_URL = scratch.url;
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  // Власні рахунки тесту: схема з нуля сама засіває bank_accounts, тож id 3/4/11 тут можуть бути чужими.
  process.env.BANK_IDENT_ACCOUNT_IDS = "9001,9002,9003";
  process.env.BANK_OUT_COMMENT_ACCOUNT_IDS = "9001,9002";
  process.env.BANK_IDENT_FROM = new Date(Date.now() - 30 * 864e5).toISOString();
  const { pool } = await import("../db/pool.js");
  const { default: express } = await import("express");
  let server: import("node:http").Server | null = null;
  try {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await pool.query(schema);
    // «Бухгалтерія» заведена на проді через інтерфейс (ключ — 12 підкреслень), схема її не створює → як на проді,
    // і ДРУГИЙ прогін схеми — щоб права видались тим самим блоком, що поїде у викат.
    await pool.query(`INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions)
      VALUES ('____________', 'Бухгалтерія', false, 'company', '{"bank": true}', '{}') ON CONFLICT (key) DO NOTHING`);
    await pool.query(schema);
    const perms = async (k: string) => (await pool.query<{ key: string }>(`SELECT key FROM roles WHERE (permissions->>$1)::boolean ORDER BY key`, [k])).rows.map((r) => r.key);
    assert.deepEqual(await perms("tag_bank_invoice"), ["admin", "manager", "team_lead"], "🔴 вписувати № — не рівно менеджер, тімлід, адмін");
    assert.deepEqual(await perms("fix_bank_invoice"), ["admin", "financier"], "🔴 змінювати № — не рівно фінансист і адмін");
    assert.deepEqual(await perms("mark_bank_not_client"), ["____________", "admin"], "🔴 «не оплата клієнта» — не рівно бухгалтерія й адмін");
    assert.deepEqual(await perms("bank_out_comments"), ["____________", "admin"], "🔴 коментарі — не рівно бухгалтерія й адмін");

    await pool.query(`INSERT INTO bank_accounts (id, company, bank, label, currency, iban, out_private) VALUES
      (9001, 'fop_privat', 'privat', 'ФОП Беспятчук (Приват)', 'UAH', 'UA000000000000000000000009001', false),
      (9002, 'fop_mono', 'mono', 'ФОП Беспятчук (Моно)', 'UAH', 'UA000000000000000000000009002', false),
      (9003, 'staff', 'mono', 'Картка робоча', 'UAH', NULL, true),
      (9004, 'uts', 'privat', 'ТОВ ЮТС', 'UAH', 'UA000000000000000000000009004', false)`);
    await pool.query(`INSERT INTO bank_hidden_payees (pattern, match_type) VALUES ('Таємний Отримувач', 'exact')`);
    const h = (n: number) => `now() - interval '${n} hours'`;
    await pool.query(`INSERT INTO bank_transactions (id, account_id, direction, external_tx_id, booked_at, created_at, counterparty_name, counterparty_iban, purpose, amount, currency, amount_uah) VALUES
      (701, 9001, 'in',  'x701', ${h(1)},   ${h(1)},   'ТОВ Клієнт Один', NULL, 'оплата перевезення', 5000, 'UAH', 5000),
      (702, 9002, 'in',  'x702', ${h(2)},   ${h(2)},   'ТОВ Клієнт Два',  NULL, 'оплата', 3000, 'UAH', 3000),
      (703, 9003, 'in',  'x703', ${h(3)},   ${h(3)},   'Клієнт Три',      NULL, 'переказ', 1000, 'UAH', 1000),
      (704, 9001, 'in',  'x704', ${h(240)}, ${h(240)}, 'ТОВ Запізно',     NULL, 'оплата', 7000, 'UAH', 7000),
      (705, 9001, 'in',  'x705', ${h(4)},   ${h(4)},   'ФОП Беспятчук Сергій', NULL, 'поповнення', 9000, 'UAH', 9000),
      (706, 9004, 'in',  'x706', ${h(1)},   ${h(1)},   'ТОВ Клієнт ЮТС',  NULL, 'оплата', 4000, 'UAH', 4000),
      (707, 9001, 'in',  'x707', ${h(1)},   ${h(1)},   'ТОВ Видалений',   NULL, 'оплата', 100, 'UAH', 100),
      (708, 9002, 'in',  'x708', ${h(300)}, ${h(300)}, 'ТОВ Ніхто Не Дивився', NULL, 'оплата', 200, 'UAH', 200),
      (709, 9001, 'in',  'x709', ${h(5)},   ${h(5)},   'ТОВ Повернення',  NULL, 'повернення', 300, 'UAH', 300),
      (801, 9001, 'out', 'x801', ${h(1)},   ${h(1)},   'Перевізник Один', NULL, 'оплата перевезення', -2000, 'UAH', -2000),
      (802, 9001, 'out', 'x802', ${h(1)},   ${h(1)},   'Таємний Отримувач', NULL, 'виплата', -500, 'UAH', -500),
      (803, 9004, 'out', 'x803', ${h(1)},   ${h(1)},   'Постачальник ЮТС', NULL, 'оплата', -800, 'UAH', -800)`);
    await pool.query(`UPDATE bank_transactions SET deleted_at = now() WHERE id = 707`);

    await pool.query(`INSERT INTO teams (id, name) VALUES (9401, 'Тест Виписки') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO users (id, email, password_hash, role, role_override, team_id, full_name, is_active) VALUES
      (941, 'm1@b', 'x', 'manager', NULL, 9401, 'Марина Коваль', true),
      (942, 'm2@b', 'x', 'manager', NULL, 9401, 'Андрій Мельник', true),
      (943, 'tl@b', 'x', 'team_lead', NULL, 9401, 'Тарас Лід', true),
      (944, 'fin@b', 'x', 'manager', 'financier', NULL, 'Олена Фінансист', true),
      (945, 'acc@b', 'x', 'manager', '____________', NULL, 'Людмила Бухгалтер', true),
      (946, 'ad@b', 'x', 'admin', 'admin', NULL, 'Адмін', true),
      (947, 'ceo@b', 'x', 'manager', 'ceo', NULL, 'СЕО', true),
      (948, 'cand@b', 'x', 'manager', 'candidate', NULL, 'Кандидат', true)`);
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    const { signToken } = await import("../auth/auth.js");
    const tok = (userId: number, roleKey: string, role: "admin" | "team_lead" | "manager" | "company" = "manager") =>
      signToken({ userId, role, roleKey, managerId: null, teamId: roleKey === "team_lead" ? 9401 : null });
    const M1 = tok(941, "manager"), M2 = tok(942, "manager"), FIN = tok(944, "financier", "company"),
      ACC = tok(945, "____________", "company"), AD = tok(946, "admin", "admin"), CEO = tok(947, "ceo", "company"), CAND = tok(948, "candidate");
    const { bankIdentRouter, bankIdentFinalizeOnce } = await import("../routes/bankIdent.js");
    const app = express(); app.use("/api/bank-ident", bankIdentRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server!.address() as import("node:net").AddressInfo).port;
    const call = async (token: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/bank-ident${url}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const txt = await r.text(); let json: any = null; try { json = JSON.parse(txt); } catch { json = txt; } // eslint-disable-line @typescript-eslint/no-explicit-any
      return { status: r.status, json };
    };

    // ── вкладка й стани ──
    // межа вкладки: кандидат «Виписки» не має (HR на базі з нуля вкладку `bank` отримує — див. access-roles: на проді свідомо ні)
    assert.equal((await call(CAND, "POST", "/state", { ids: [701] })).status, 403, "🔴 кандидат без вкладки «Виписка» дістав стани");
    const st = await call(M1, "POST", "/state", { ids: [701, 703, 704, 705, 706, 707, 801] });
    assert.equal(st.status, 200, JSON.stringify(st.json));
    assert.deepEqual(Object.keys(st.json.states).sort(), ["701", "703", "704", "705"], "🔴 під правилом не рівно вхідні ФОП / картки (без ЮТС, вихідних і видаленого)");
    assert.equal(st.json.states["701"].status, "wait");
    assert.equal(st.json.states["701"].can.set, true, "🔴 менеджер не може вписати № на тому, що чекає");
    assert.equal(st.json.states["704"].status, "unidentified", "🔴 прострочений не став «неідентифікованим»");
    assert.equal(st.json.states["705"].status, "own", "🔴 переказ власника ФОП вимагає номер");

    // ── менеджер: один раз ──
    assert.equal((await call(M1, "POST", "/701/invoice", { no: "ок" })).status, 400, "🔴 номер без жодної цифри прийнято");
    const set = await call(M1, "POST", "/701/invoice", { no: "  РФ-8568 " });
    assert.equal(set.status, 201, JSON.stringify(set.json));
    assert.deepEqual([set.json.state.status, set.json.state.invoiceNo, set.json.state.firstBy?.name], ["identified", "РФ-8568", "Марина Коваль"]);
    const again = await call(M2, "POST", "/701/invoice", { no: "999" });
    assert.equal(again.status, 409, "🔴 другий менеджер переписав зафіксований номер");
    assert.match(again.json.error, /Номер уже зафіксовано: № РФ-8568 — Марина Коваль/);
    assert.equal(again.json.state.invoiceNo, "РФ-8568", "🔴 409 не несе актуального стану");
    assert.equal((await call(M1, "PATCH", "/701/invoice", { no: "1", reason: "x", expected: "РФ-8568" })).status, 403, "🔴 менеджер змінив номер");
    const late = await call(AD, "POST", "/704/invoice", { no: "123" });
    assert.deepEqual([late.status, late.json.error], [409, "Строк минув — номер уже не вписати."], "🔴 прострочений прийняв номер (адмін)");
    assert.equal((await call(M1, "POST", "/705/invoice", { no: "123" })).status, 409, "🔴 свій переказ прийняв номер");
    assert.equal((await call(M1, "POST", "/706/invoice", { no: "123" })).status, 400, "🔴 платіж ЮТС потрапив під правило");
    assert.equal((await call(M1, "POST", "/707/invoice", { no: "123" })).status, 404, "🔴 видалений рядок виписки існує для правила");

    // ── СЕО бачить, не діє; бухгалтерія — «не оплата», не номер ──
    assert.equal((await call(CEO, "POST", "/702/invoice", { no: "123" })).status, 403, "🔴 СЕО вписав номер");
    assert.equal((await call(CEO, "GET", "/701/history")).status, 200, "🔴 СЕО не бачить історії");
    assert.equal((await call(ACC, "POST", "/702/invoice", { no: "123" })).status, 403, "🔴 бухгалтерія вписала номер");
    assert.equal((await call(M1, "POST", "/709/not-client", { reason: "Повернення коштів" })).status, 403, "🔴 менеджер позначив «не оплата клієнта»");
    assert.equal((await call(ACC, "POST", "/709/not-client", { reason: "Інше", note: "" })).status, 400, "🔴 «Інше» без коментаря прийнято");
    const nc = await call(ACC, "POST", "/709/not-client", { reason: "Повернення коштів", note: "" });
    assert.deepEqual([nc.status, nc.json.state?.status], [201, "not_client"], JSON.stringify(nc.json));

    // ── фінансист: лише з причиною і за тим номером, що бачив ──
    assert.equal((await call(FIN, "PATCH", "/701/invoice", { no: "РФ-8569", reason: "", expected: "РФ-8568" })).status, 400, "🔴 зміна без причини");
    assert.equal((await call(FIN, "PATCH", "/701/invoice", { no: "РФ-8569", reason: "одруківка", expected: "РФ-1" })).status, 409, "🔴 зміна за застарілим номером");
    const fix = await call(FIN, "PATCH", "/701/invoice", { no: "РФ-8569", reason: "одруківка", expected: "РФ-8568" });
    assert.deepEqual([fix.status, fix.json.state?.invoiceNo, fix.json.state?.changed], [200, "РФ-8569", true], JSON.stringify(fix.json));
    const hist = (await call(M2, "GET", "/701/history")).json.events as Array<{ act: string; fromNo: string | null; toNo: string | null; reason: string | null }>;
    assert.deepEqual(hist.map((e) => [e.act, e.fromNo, e.toNo, e.reason]), [["set", null, "РФ-8568", null], ["change", "РФ-8568", "РФ-8569", "одруківка"]], "🔴 історія не «зафіксовано → змінено a → b · причина»");

    // ── коментарі до вихідних ФОП ──
    for (const [who, T] of [["менеджер", M1], ["фінансист", FIN], ["СЕО", CEO]] as const) {
      assert.equal((await call(T, "POST", "/comments/summary", { ids: [801] })).status, 403, `🔴 ${who} бачить коментарі до вихідних`);
      assert.equal((await call(T, "POST", "/801/comments", { body: "x" })).status, 403, `🔴 ${who} написав коментар`);
    }
    const cm = await call(ACC, "POST", "/801/comments", { body: "оплата за рейс 12.10" });
    assert.deepEqual([cm.status, cm.json.summary?.count], [201, 1], JSON.stringify(cm.json));
    assert.equal((await call(ACC, "POST", "/803/comments", { body: "x" })).status, 400, "🔴 коментар до вихідного не-ФОП");
    assert.equal((await call(ACC, "GET", "/802/comments")).status, 404, "🔴 бухгалтерія бачить прихованого отримувача");
    assert.equal((await call(AD, "GET", "/802/comments")).status, 200, "🔴 адмін не бачить прихованого отримувача");
    const sum = await call(AD, "POST", "/comments/summary", { ids: [801, 802, 803, 701] });
    assert.deepEqual(Object.keys(sum.json.summaries).sort(), ["801", "802"], "🔴 коментарі не лише до вихідних ФОП");

    // ── фіналізатор: 708 ніхто не відкривав (ДО /counts і /list — вони теж фіксують прострочені) ──
    const f1 = await bankIdentFinalizeOnce();
    assert.ok("expired" in f1 && f1.expired >= 1, `🔴 фіналізатор не зафіксував прострочене: ${JSON.stringify(f1)}`);
    const row708 = (await pool.query(`SELECT status, unid_kind FROM bank_tx_ident WHERE tx_id = 708`)).rows[0];
    assert.deepEqual(row708, { status: "unidentified", unid_kind: "expired" });
    const f2 = await bankIdentFinalizeOnce();
    assert.ok("expired" in f2 && f2.expired === 0, "🔴 фіналізатор не ідемпотентний");
    // ── лічильники, фільтр, пошук ──
    const cM = (await call(M1, "GET", "/counts")).json, cC = (await call(CEO, "GET", "/counts")).json;
    assert.deepEqual([cM.wait, cM.badge, cC.wait, cC.badge], [2, 2, 2, 0], "🔴 «чекають» ≠ 702 і 703, або бейдж не лише тим, хто вписує");
    const waitList = (await call(M1, "GET", "/list?status=wait")).json;
    assert.deepEqual(waitList.ids.sort(), [702, 703], "🔴 фільтр «Чекають №» не рівно ті, що чекають (видалений / свій / ЮТС просочились)");
    assert.ok(!("finance_only" in waitList.rows[0]) && !("seen_at" in waitList.rows[0]), "🔴 /list віддає службові поля");
    const { feedPage } = await import("../core/bankReport.js");
    const found = await feedPage("in", { q: "РФ-8569", canSeePrivate: false }, [], true);
    assert.deepEqual(found.rows.map((r) => r.id), [701], "🔴 пошук «Виписки» не знаходить платіж за № рахунку");

    void M2;
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #2913 — ВИДИМІСТЬ = ВИДИМІСТЬ СТРІЧКИ «ВИПИСКИ» (`canSeeTxRow`), по обидва боки кожної межі: рахунок «лише фінанси» і
 * неактивний — лише з `view_private_finance`; вихідні робочої картки — теж; прихований отримувач — лише з
 * `view_hidden_payments`; надходження картки бачать усі.
 * 🧨 Червоніє, якщо прибрати будь-яку з умов або пустити приховане без права.
 */
test("#2913 ВИДИМІСТЬ «ВИПИСКИ» для № і коментарів = стрічка: «лише фінанси», вихідні картки, приховані — по обидва боки", async () => {
  // ліниво: txSource → core/bankReport → db/pool, а пул кидає на імпорті без DATABASE_URL (правило зони testing)
  process.env.DATABASE_URL ??= "postgres://unused/none";
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  const { canSeeTxRow } = await import("./txSource.js");
  const base: BankTx = { id: 1, account_id: 1, direction: "in", booked_at: "2026-10-27T10:00:00Z", counterparty_name: "Хтось", finance_only: false, out_private: false, account_active: true };
  const none = { privateFinance: false, hiddenPayments: false }, all = { privateFinance: true, hiddenPayments: true };
  const P = [{ pattern: "Таємний", match_type: "exact" as const }];
  assert.equal(canSeeTxRow(base, none, P), true);
  assert.equal(canSeeTxRow({ ...base, finance_only: true }, none, P), false, "🔴 «лише фінанси» без права");
  assert.equal(canSeeTxRow({ ...base, finance_only: true }, all, P), true);
  assert.equal(canSeeTxRow({ ...base, account_active: false }, none, P), false, "🔴 неактивний рахунок без права");
  assert.equal(canSeeTxRow({ ...base, out_private: true }, none, P), true, "🔴 надходження картки сховано");
  assert.equal(canSeeTxRow({ ...base, direction: "out", out_private: true }, none, P), false, "🔴 витрати картки без права");
  assert.equal(canSeeTxRow({ ...base, direction: "out", out_private: true }, all, P), true);
  assert.equal(canSeeTxRow({ ...base, direction: "out", counterparty_name: "Таємний" }, none, P), false, "🔴 прихований отримувач без права");
  assert.equal(canSeeTxRow({ ...base, direction: "out", counterparty_name: "Таємний" }, { privateFinance: false, hiddenPayments: true }, P), true);
  assert.equal(canSeeTxRow({ ...base, counterparty_name: "Таємний" }, none, P), true, "🔴 приховування зачепило вхідні");
});

/**
 * #2914 — ХТО ЩО ВПИСАВ І КОМЕНТАРІ — ЗАКРИТО ВІД МОДЕЛІ: чотири таблиці — REVOKE після GRANT і CREATE, і в FORBIDDEN_TABLES.
 * 🧨 Червоніє, якщо прибрати REVOKE, поставити його вище GRANT/CREATE або прибрати таблицю з переліку.
 */
test("#2914 таблиці «Виписки» (№ рахунку, історія, коментарі) відібрані в ai_readonly після GRANT і CREATE і є в FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const grantAt = sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;");
  const revokeAt = sql.indexOf("REVOKE ALL ON bank_ident_settings, bank_tx_ident, bank_tx_ident_events, bank_tx_comments FROM ai_readonly;");
  const list = /FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/.exec(SRC("ai/metricTools.ts"));
  for (const tbl of ["bank_ident_settings", "bank_tx_ident", "bank_tx_ident_events", "bank_tx_comments"]) {
    const createAt = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${tbl} (`);
    assert.ok(grantAt > 0 && createAt > 0, `🔴 не знайдено GRANT чи CREATE ${tbl}`);
    assert.ok(revokeAt > grantAt && revokeAt > createAt, `🔴 REVOKE ${tbl} немає або він вище GRANT/CREATE`);
    assert.ok(list && list[1].includes(`"${tbl}"`), `🔴 ${tbl} не в FORBIDDEN_TABLES`);
  }
});

/**
 * #2915 — ФРОНТ «ВИПИСКИ» (ТЗ «Стиль», §6):
 *  - спільні правила у фронті — БАЙТ У БАЙТ бекендівські (інакше #2911 нічого не каже про екран);
 *  - жодного `lazy(`/`import(` у коді пакета й вставках (#225 — один чанк);
 *  - CSS пакета — лише на змінних дашборда (голий колір — тільки синій активного фільтра, як чипи рахунків);
 *  - «Виписка» вставляє рядок № під платежем, фільтр, інфо-рядок, коментарі; меню — бейдж «чекають №».
 * 🧨 Червоніє, якщо розвести копію правил, повернути лінивий імпорт, ввести свій колір чи прибрати бейдж.
 */
test("#2915 ФРОНТ «ВИПИСКИ»: правила = бекенд байт у байт, один чанк, CSS на змінних дашборда, вставки й бейдж на місці", () => {
  for (const f of ["bankIdent", "identDeadline"]) {
    assert.equal(FRONT(`bankIdent/shared/${f}.ts`), SRC(`bankIdent/${f}.ts`), `🔴 ${f}.ts у фронті розійшовся з бекендом`);
  }
  const files = ["IdentFilter.tsx", "IdentLine.tsx", "OutComments.tsx", "api.ts", "format.ts", "identFilterMount.ts", "identLineMount.ts", "index.ts",
    "outCommentsMount.ts", "types.ts", "useBankIdent.ts"].map((f) => `bankIdent/client/bankIdent/${f}`)
    .concat(["bankIdent/dashboard.ts", "pages/dashboard/sections/BankSection.tsx", "components/Layout.tsx"]);
  for (const f of files) {
    const s = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    assert.ok(!/\blazy\(|\bimport\(/.test(s), `🔴 ${f}: динамічний імпорт — другий чанк (#225)`);
  }
  const css = FRONT("bankIdent/client/bankIdent/bankIdent.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/var\(--text\b/.test(css) && /var\(--border\b/.test(css), "🔴 CSS пакета не на змінних дашборда — перевірці нічого перевіряти");
  const bare = [...css.replace(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]+\)/g, "").matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  assert.deepEqual([...new Set(bare)], ["#2f6fdb"], "🔴 у CSS пакета свій колір поза змінними дашборда");
  const sec = FRONT("pages/dashboard/sections/BankSection.tsx");
  assert.match(sec, /<IdentLine state=\{ident\.state\} api=\{bankIdentApi\}/, "🔴 рядок «№ рахунку» не вставлено під платежем");
  assert.match(sec, /<OutComments txId=\{r\.id\} summary=\{oc\.summary\}/, "🔴 коментарі до вихідних не вставлено");
  assert.match(sec, /\{mode === "in" && <IdentFilter counts=\{identCounts\} value=\{identF\} onChange=\{setIdentF\} \/>\}/, "🔴 фільтр «Чекають №» не поруч із «Валюта»");
  assert.match(sec, /alignItems: ident \|\| oc \? "flex-start" : "center"/, "🔴 рядок із блоком № не притиснуто до верху — дата зʼїде");
  const lay = FRONT("components/Layout.tsx");
  assert.match(lay, /: item\.key === "bank" \? bankIdentCount : 0;/, "🔴 бейдж «чекають №» біля «Виписка» не підключено");
  assert.match(FRONT("bankIdent/dashboard.ts"), /if \(token\) headers\.set\("Authorization", `Bearer \$\{token\}`\);/, "🔴 клієнт пакета без нашого токена");
});
