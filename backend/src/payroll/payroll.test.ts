import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * 💰 «ЗАРПЛАТА» (пакет Сергія 03.11.2026; Роман 04.11: «роби всі етапи і викочуй»).
 * #2600 — рушій пакета байт у байт: його 63 тести (40 «золотих» звірок з макетом v6 + 23 правила) проходять у нас.
 * #2601 — карти: у БД лише шифр; Лун; той самий номер — той самий хеш; без ключа — зрозуміла відмова, не падіння.
 * #2602 — 🪞 наскрізно через НАШ вхід і ролі на scratch-БД: додати людей → кабінет → закриття місяця → перевірка
 *          (свою — ні; без коментаря — ні) → незгода → рішення ОД → згода → форма (не сходиться — ні) → відомість →
 *          виплата → аванс → звільнення й обхідний лист → сповіщення («потрібна дія» закривається сама).
 * #2603 — права-ключі ТЗ §2 у схемі: хто що отримує; адмін сум не бачить; кандидату вкладки немає.
 * #2604 — фронт: пункт меню без зашитих ролей, розділ рендериться, дзвіночок у шапці, вкладки — за правами з сервера,
 *          один чанк (#225), без alert/confirm/prompt; посилання сповіщень рушія ведуть на наявні вкладки.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

test("#2600 РУШІЙ ЗАРПЛАТИ: 63 тести пакета (40 золотих звірок з макетом + 23 правила) — байт у байт у нас", () => {
  const dir = path.join(import.meta.dirname, "engine");
  // NODE_TEST_CONTEXT прибрано: інакше дочірній `node --test` звітує батькові бінарним протоколом, а не текстом
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/golden.test.mjs", "test/rules.test.mjs"], { cwd: dir, encoding: "utf8", env });
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? -1), fail = Number(/^# fail (\d+)/m.exec(r.stdout)?.[1] ?? -1);
  assert.equal(fail, 0, `🔴 тести рушія впали:\n${r.stdout.split("\n").filter((l) => /^not ok|✖/.test(l)).join("\n")}`);
  assert.equal(pass, 63, `🔴 тестів рушія ${pass}, а не 63 — файл загубив кейси або не зібрався в dist`);
  // 🔒 «байт у байт» — хешем, а не словами: фікстура пакета несе СВОЇ налаштування, тож правку дефолтів рушія (утримання ТТН,
  // драбина KPI) його тести не бачать (заміряно саботажем: hold 3000 → 2000 лишав їх зеленими). Змінити рушій — свідомо, як lock-файл:
  // новий хеш сюди + запис чому. Хеші — файлів архіву «UTS_Zarplata_dlya_Romana_03.11.zip».
  const PKG: Record<string, string> = {
    "zarplata-engine.mjs": "eafed8b8900df21bfbbece22aaa6cf53425e16321ecb933e8775e2f0c2ec63bb",
    "notify.mjs": "413661dcd19936ff1a084b95133bdeb3561569a9f99504971b5f3ab74d699223",
    "format.mjs": "c22786b4978d87e582b076e6712eb1986b1d9f0ed61aa32de875eca3e6b6d7d2",
    "test/golden.test.mjs": "c18e2fbcd0e4f61da8c6a631d04377521981450b39f4bcf714717ac1d7128ef2",
    "test/rules.test.mjs": "1b153325de8ad5849aab7cdec38a8dc902ca497b20c41595367b814f6188fdbd",
    "test/fixtures/maket-v6.json": "532ddf5bd02a73613b01e549861e3fa23cfc80912058ed916ee7bf58cf96bf4a",
  };
  for (const [f, want] of Object.entries(PKG)) {
    for (const where of ["src", "dist"]) {
      const got = createHash("sha256").update(readFileSync(path.join(import.meta.dirname, "..", "..", where, "payroll", "engine", f))).digest("hex");
      assert.equal(got, want, `🔴 ${where}/payroll/engine/${f} не той, що в пакеті`);
    }
  }
});

test("#2601 КАРТИ: шифр у БД, Лун, стабільний хеш, без ключа — відмова з поясненням", async () => {
  const prev = process.env.PAYROLL_CARD_KEY;
  try {
    const C = await import("./cards.js");
    delete process.env.PAYROLL_CARD_KEY;
    assert.equal(C.cardsAvailable(), false);
    assert.throws(() => C.encryptCard("4111111111111111"), C.CardKeyMissing);
    process.env.PAYROLL_CARD_KEY = "a".repeat(64);
    assert.equal(C.validateCard("4111 1111 1111 1111", "Іван"), null);
    assert.match(C.validateCard("4111111111111112", "Іван") ?? "", /контрольна сума/);
    assert.match(C.validateCard("411111111111", "Іван") ?? "", /16–19/);
    assert.match(C.validateCard("4111111111111111", " ") ?? "", /ПІБ/);
    const a = C.encryptCard("4111 1111 1111 1111"), b = C.encryptCard("4111111111111111");
    assert.equal(a.last4, "1111");
    assert.ok(!a.enc.toString("utf8").includes("4111111111111111") && !a.enc.toString("hex").includes(Buffer.from("4111111111111111").toString("hex")), "🔴 номер лежить відкрито");
    assert.notDeepEqual(a.enc, b.enc, "🔴 той самий номер шифрується однаково — видно повтори");
    assert.equal(a.hash, b.hash, "🔴 хеш нестабільний — дубль карти не зловиться");
    assert.equal(C.decryptCard(a.enc), "4111111111111111");
  } finally { if (prev === undefined) delete process.env.PAYROLL_CARD_KEY; else process.env.PAYROLL_CARD_KEY = prev; }
});

test("#2603 ПРАВА «ЗАРПЛАТИ» (ТЗ §2): ключі в каталозі, видача ролям парна, адмін сум не бачить, кандидату вкладки немає", () => {
  const sql = SRC("db/schema.sql"), cat = SRC("auth/permGrant.ts");
  const want: Record<string, string[]> = {
    payroll_view_all: ["financier", "opdir", "ceo"], payroll_edit: ["financier", "opdir"], payroll_settings: ["financier", "opdir"],
    payroll_final_word: ["opdir"], payroll_export_cards: ["financier", "opdir"], payroll_clearance: ["____________", "business_assistant"],
    payroll_offer_tasks: ["hr"], notify_rules: ["opdir", "admin"],
  };
  for (const [k, roles] of Object.entries(want)) {
    assert.ok(cat.includes(`"${k}",`), `🔴 ${k} немає в PERMISSION_CATALOG`);
    const list = roles.map((r) => `'${r}'`).join(", ");
    assert.ok(sql.includes(`UPDATE roles SET permissions = permissions || '{"${k}":true}'::jsonb WHERE key IN (${list});`), `🔴 ${k}: видача не ${roles.join(", ")}`);
    assert.ok(sql.includes(`UPDATE roles SET permissions = permissions - '${k}' WHERE key NOT IN (${list});`), `🔴 ${k}: немає парного зняття з решти ролей`);
    if (k.startsWith("payroll_") && k !== "payroll_clearance") assert.ok(!roles.includes("admin"), `🔴 ${k} у адміна — ТЗ §2 «доступ admin до сум — питання»`);
  }
  assert.match(sql, /UPDATE roles SET screen_access = screen_access \|\| '\{"payroll":false\}'::jsonb\s+WHERE key = 'candidate'/);
  const routes = SRC("routes/payroll.ts");
  assert.match(routes, /const viewer = \(req: Request\): P\.Viewer => \{\s+const a = req\.auth!;\s+return \{ userId: a\.userId,/, "🔴 «self» береться не з сесії");
  assert.ok(!/req\.(query|params|body)[^\n]*userId[^\n]*P\.(cabinet|agree|dispute|submitForm|requestAdvance|myGoal)/.test(routes), "🔴 кабінет читає userId із запиту");
});

test("#2602 🪞 ЗАРПЛАТА НАСКРІЗНО: вхід і ролі, закриття, перевірка, незгода й ОД, форма, відомість, виплата, аванс, обхідний лист, сповіщення", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  process.env.PAYROLL_CARD_KEY = "b".repeat(64);
  process.env.PAYROLL_OD_USER_ID = "1";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query(`INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions) VALUES
      ('____________', 'Бухгалтерія', false, 'company', '{"payroll":true}'::jsonb, '{"payroll_clearance":true}'::jsonb),
      ('business_assistant', 'Бізнес-асистент', false, 'own', '{"payroll":true}'::jsonb, '{"payroll_clearance":true}'::jsonb) ON CONFLICT (key) DO NOTHING`);
    await c.query(SRC("db/schema.sql").slice(SRC("db/schema.sql").indexOf("UPDATE roles SET screen_access = screen_access || '{\"payroll\":true}'")));
    await c.query(`INSERT INTO teams (id, name) VALUES (1, 'Нові клієнти') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id) VALUES (10, 'Марина Коваль', 1), (11, 'Ірина Савчук', 1)`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, role_override, full_name, is_active, manager_id) VALUES
      (1, 'od@t', 'x', 'admin', 'opdir', 'Сергій', true, NULL), (2, 'fin@t', 'x', 'admin', 'financier', 'Олена Шевчук', true, NULL),
      (3, 'mar@t', 'x', 'manager', NULL, 'Марина Коваль', true, 10), (4, 'iry@t', 'x', 'team_lead', NULL, 'Ірина Савчук', true, 11),
      (5, 'hr@t', 'x', 'manager', 'hr', 'Катерина Руденко', true, NULL), (6, 'ba@t', 'x', 'manager', 'business_assistant', 'Юлія Мороз', true, NULL),
      (7, 'acc@t', 'x', 'manager', '____________', 'Бухгалтерія', true, NULL), (8, 'nat@t', 'x', 'manager', 'kvp', 'Наталія Бойко', true, NULL),
      (9, 'cand@t', 'x', 'manager', 'candidate', 'Кандидат', true, NULL), (12, 'oleh@t', 'x', 'manager', NULL, 'Олег Ткачук', true, NULL)`);
    await c.query(`INSERT INTO payroll_teams (code, name, dept_code, offer_code, kommo_team_id) VALUES ('t1', 'Нові клієнти', 'sales', 'std', 1) ON CONFLICT DO NOTHING`);

    const { kyivNow } = await import("./state.js");
    const { prevMonth, nextMonth } = await import("./engine/zarplata-engine.mjs");
    const live = kyivNow().slice(0, 7), pm = prevMonth(live);
    // угоди «Успішно реалізовано»: Марина — у минулому місяці 2 (маржа 30 000), у поточному 1 (5 000)
    await c.query(`INSERT INTO deals (kommo_id, name, status_id, pipeline_id, manager_id, price, client_name, client_key, closed_at_kommo, ttn_files) VALUES
      (900001, 'Київ – Львів', 142, 8921932, 10, 18000, 'ТОВ «Альфа»', 'альфа', ($1 || '-05 12:00')::timestamp AT TIME ZONE 'Europe/Kyiv', 1),
      (900002, 'Київ – Одеса', 142, 8921932, 10, 12000, 'ТОВ «Бета»', 'бета', ($1 || '-10 12:00')::timestamp AT TIME ZONE 'Europe/Kyiv', 0),
      (900003, 'Дніпро – Київ', 142, 8921932, 10, 5000, 'ТОВ «Альфа»', 'альфа', ($2 || '-01 09:00')::timestamp AT TIME ZONE 'Europe/Kyiv', 0)`, [pm, live]);
    await c.query(`INSERT INTO plans (manager_id, plan_date, metric, planned_value) VALUES (10, $1::date, 'payment_amount', 40000)`, [`${pm}-01`]);

    await import("../lib/asyncRoutes.js");
    const { default: express } = await import("express");
    const { payrollRouter } = await import("../routes/payroll.js");
    const { notificationsRouter } = await import("../routes/notifications.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { signToken } = await import("../auth/auth.js");
    const { pool } = await import("../db/pool.js");
    const S = await import("./service.js");
    await refreshRoles();
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use("/api/payroll", payrollRouter);
    app.use("/api/notifications", notificationsRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api`;
    const tok = (id: number, role: string, roleKey: string, managerId: number | null = null) => signToken({ userId: id, role, roleKey, managerId, teamId: null } as never);
    const T: Record<string, string> = {
      od: tok(1, "admin", "opdir"), fin: tok(2, "admin", "financier"), mar: tok(3, "manager", "manager", 10), iry: tok(4, "team_lead", "team_lead", 11),
      hr: tok(5, "company", "hr"), ba: tok(6, "manager", "business_assistant"), acc: tok(7, "company", "____________"), nat: tok(8, "admin", "kvp"), cand: tok(9, "manager", "candidate"), oleh: tok(12, "manager", "manager"),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (who: string, method: string, p: string, body?: unknown): Promise<{ s: number; j: any }> => {
      const r = await fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${T[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      const txt = await r.text(); let j: unknown = txt; try { j = JSON.parse(txt); } catch { /* xlsx / html */ }
      return { s: r.status, j };
    };

    // ---------- люди в зарплаті ----------
    assert.equal((await call("mar", "POST", "/payroll/employees", { userId: 3 })).s, 403, "менеджер додає людей у зарплату");
    let r = await call("fin", "POST", "/payroll/employees", { userId: 3, role: "manager", title: "Менеджер з продажу", dept: "sales", team: "t1", startDate: "2025-01-10", birthday: "07-14", level: "start", from: pm });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    for (const b of [
      { userId: 4, role: "lead", title: "Тім-лід", dept: "sales", team: "t1", leadsTeam: "t1", startDate: "2024-01-01", rate: 10000, from: pm },
      { userId: 2, role: "staff", title: "Фінансист", dept: "fin", startDate: "2024-01-01", rate: 20000, isFinance: true, from: pm },
      { userId: 8, role: "staff", title: "Логіст", dept: "log", startDate: "2024-01-01", rate: 12000, from: pm, official: { amount: 8000, deduct: true } },
      { userId: 6, role: "staff", title: "Бізнес-асистент", dept: "ba", startDate: "2024-01-01", rate: 12000, from: pm, pct: { base: "company", value: 0.5 } },
    ]) { r = await call("fin", "POST", "/payroll/employees", b); assert.equal(r.s, 201, JSON.stringify(r.j)); }

    // ---------- кабінет: лише свої; кандидату вкладки немає ----------
    assert.equal((await call("cand", "GET", "/payroll/me")).s, 403, "кандидат бачить «Зарплату»");
    r = await call("oleh", "GET", "/payroll/me");
    assert.equal(r.j.enrolled, false, "людина без запису в зарплаті має кабінет");
    r = await call("mar", "GET", "/payroll/me");
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(r.j.live.calc.kind, "manager"); assert.equal(r.j.live.calc.margin, 5000, "маржа поточного місяця не з угод ядра");
    r = await call("iry", "GET", "/payroll/me");
    assert.equal(r.j.live.calc.kind, "lead");
    assert.ok(r.j.live.calc.members.every((m: Record<string, unknown>) => !("now" in m) && !("atPlan" in m)), "🔴 тім-лід бачить чужі зарплати");
    assert.equal((await call("mar", "GET", `/payroll/months/${live}/accruals`)).s, 403, "менеджер бачить нарахування всіх");
    assert.equal((await call("nat", "GET", `/payroll/months/${live}/accruals`)).s, 403, "КВП бачить нарахування всіх");
    r = await call("fin", "GET", `/payroll/months/${live}/accruals`);
    assert.equal(r.s, 200); assert.equal(r.j.length, 5);

    // ---------- закриття минулого місяця ----------
    const closed = await S.closeMonth(pool, pm);
    assert.deepEqual(closed, { closed: true, records: 5 });
    assert.deepEqual(await S.closeMonth(pool, pm), { closed: false, records: 0 }, "🔴 повторне закриття щось змінило");
    r = await call("fin", "GET", `/payroll/months/${pm}/queue`);
    const q = Object.fromEntries(r.j.rows.map((x: Record<string, unknown>) => [x.userId, x]));
    assert.equal(q["3"].group, "action"); assert.equal(q["2"].group, "od", "ЗП фінансиста — не в черзі ОД");
    assert.equal(q["2"].canEdit, false, "🔴 фінансист може перевірити свою ЗП");
    // ТТН: 1 з 2 угод → < 70 % → утримання 3 000; сповіщення ttn.hold менеджеру
    const marRec = await call("fin", "GET", `/payroll/records/${pm}/3`);
    assert.deepEqual(marRec.j.settlement.ttnLines.map((x: Record<string, unknown>) => [x.kind, x.amount]), [["hold", -3000]]);

    // ---------- перевірка ----------
    assert.equal((await call("fin", "PATCH", `/payroll/records/${pm}/2`, {})).s, 403, "🔴 фінансист перевіряє свою ЗП");
    r = await call("fin", "PATCH", `/payroll/records/${pm}/3`, { overrides: { margin: 28000 } });
    assert.equal(r.s, 422, "зміна без внутрішнього коментаря пройшла");
    r = await call("fin", "PATCH", `/payroll/records/${pm}/3`, { overrides: { margin: 28000 }, notes: { margin: "Угода 900002 частково повернута" } });
    assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "verified"); assert.equal(r.j.settlement.values.margin, 28000);
    let me = await call("mar", "GET", "/payroll/me");
    assert.equal(me.j.closed.status, "verified");
    assert.ok(!("notes" in me.j.closed) && !JSON.stringify(me.j.closed).includes("частково повернута"), "🔴 працівник бачить внутрішній коментар");
    let badge = await call("mar", "GET", "/notifications/badge");
    assert.ok(badge.j.needAction >= 2, `сповіщень «потрібна дія» менеджеру ${JSON.stringify(badge.j)} (ver.ready + ttn.hold)`);

    // ---------- незгода → рішення ОД → згода ----------
    assert.equal((await call("mar", "POST", `/payroll/me/records/${pm}/payout-form`, { cash: 1 })).s, 409, "🔴 форма до згоди");
    r = await call("mar", "POST", `/payroll/me/records/${pm}/dispute`, { text: "У кабінеті маржа була 30 000" });
    assert.equal(r.j.status, "disputed");
    assert.equal((await call("fin", "POST", `/payroll/records/${pm}/3/resolve`, { decision: "keep" })).s, 403, "🔴 фінансист вирішує незгоду замість ОД");
    r = await call("od", "POST", `/payroll/records/${pm}/3/resolve`, { decision: "keep", reply: "Повернення угоди підтверджено" });
    assert.equal(r.s, 200); assert.equal(r.j.status, "verified");
    r = await call("mar", "POST", `/payroll/me/records/${pm}/agree`);
    assert.equal(r.j.status, "agreed");
    const verN = await c.query(`SELECT done_at FROM notifications WHERE type = 'ver.ready' ORDER BY id`);
    assert.ok(verN.rows.length >= 2 && verN.rows.every((x) => x.done_at), "🔴 «потрібна дія» ver.ready не закрилась після згоди");

    // ---------- форма на виплату ----------
    const due = Math.round(r.j.settlement.pay);
    r = await call("mar", "POST", `/payroll/me/records/${pm}/payout-form`, { cash: 0, lines: [{ newCard: { number: "4111111111111111", holder: "Марина Коваль" }, amount: due - 100 }] });
    assert.equal(r.s, 422); assert.match(r.j.error, /Не сходиться на 100/);
    r = await call("mar", "POST", `/payroll/me/records/${pm}/payout-form`, { cash: 0, lines: [{ newCard: { number: "4111111111111112", holder: "Марина" }, amount: due }] });
    assert.equal(r.s, 422, "карта не за Луном прийнята");
    r = await call("mar", "POST", `/payroll/me/records/${pm}/payout-form`, { cash: 100, lines: [{ newCard: { number: "4111 1111 1111 1111", holder: "Марина Коваль" }, amount: due - 100 }] });
    assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "submitted");
    const enc = await c.query(`SELECT number_enc, last4 FROM payroll_cards WHERE user_id = 3`);
    assert.equal(enc.rows[0].last4, "1111"); assert.ok(!Buffer.from(enc.rows[0].number_enc).toString("utf8").includes("4111111111111111"), "🔴 номер карти в БД відкрито");

    // ---------- відомість і виплата ----------
    r = await call("fin", "GET", `/payroll/statement?month=${pm}`);
    const st = r.j.filter((x: Record<string, unknown>) => x.userId === "3");
    assert.deepEqual(st.map((x: Record<string, unknown>) => [x.cash, x.card, x.cardLast4, x.cardNo]), [[100, 0, null, null], [0, due - 100, "1111", null]], "відомість — рядок на карту, готівка окремо, без повного номера");
    assert.equal((await call("od", "GET", `/payroll/statement/export?month=${pm}`)).s, 200);
    assert.equal((await call("nat", "GET", `/payroll/statement/export?month=${pm}`)).s, 403, "🔴 Excel з номерами карт — КВП");
    r = await call("fin", "POST", "/payroll/statement/mark-paid", { month: pm, userIds: [3, 4] });
    assert.deepEqual(r.j.paid, ["3"]); assert.equal(r.j.skipped[0].userId, "4");
    const paidRec = await c.query(`SELECT status, paid_snapshot FROM payroll_records WHERE user_id = 3`);
    assert.equal(paidRec.rows[0].status, "paid"); assert.equal(Math.round(paidRec.rows[0].paid_snapshot.pay), due);

    // ---------- «Нагадати» про аванс: до відкриття — записується; відкрилось — джоба шле сповіщення adv.open ----------
    const winOpen = (await call("mar", "GET", "/payroll/me")).j.live.advance.open;
    const rem = await call("mar", "POST", "/payroll/me/advance-remind");
    if (winOpen) assert.equal(rem.s, 409, "нагадування, коли заявки вже відкрито");
    else { assert.equal(rem.s, 200, JSON.stringify(rem.j)); assert.equal(rem.j.on, true); assert.equal((await call("mar", "GET", "/payroll/me")).j.advanceRemind, true); }
    assert.equal(await S.remindersTick(pool), 0, "🔴 нагадування пішло до відкриття заявок");

    // ---------- аванс ----------
    await c.query(`INSERT INTO payroll_settings_versions (valid_from, settings, reason) VALUES ($1::date, '{"advance":{"fromDay":1}}', 'тест: аванс з 1-го')`, [`${live}-01`]);
    S.invalidate();
    if (!winOpen) {
      assert.equal(await S.remindersTick(pool), 1, "🔴 заявки відкрито, а нагадування не пішло");
      assert.equal(await S.remindersTick(pool), 0, "🔴 нагадування пішло двічі");
      const n = await c.query(`SELECT n.title FROM notifications n JOIN notification_recipients r ON r.notification_id = n.id WHERE n.type = 'adv.open' AND r.user_id = 3`);
      assert.equal(n.rowCount, 1); assert.equal(n.rows[0].title, "Заявки на аванс відкрито");
    }
    me = await call("mar", "GET", "/payroll/me");
    const lim = me.j.live.advance.limit.amount;
    assert.ok(me.j.live.advance.open && lim > 0, `ліміт авансу ${JSON.stringify(me.j.live.advance)}`);
    const cardId = me.j.cards[0].id;
    assert.equal((await call("mar", "POST", "/payroll/me/advances", { lines: [{ cardId, amount: lim + 1 }] })).s, 422, "🔴 аванс понад ліміт");
    r = await call("mar", "POST", "/payroll/me/advances", { lines: [{ cardId, amount: lim }] });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    assert.equal((await call("mar", "POST", "/payroll/me/advances", { cash: 1 })).s, 409, "друга заявка того ж місяця");
    const advs = await call("fin", "GET", `/payroll/advances?month=${live}`);
    const adv = advs.j.requests.find((x: Record<string, unknown>) => x.userId === "3");
    assert.equal((await call("mar", "POST", `/payroll/advances/${adv.id}/pay`)).s, 403);
    assert.equal((await call("fin", "POST", `/payroll/advances/${adv.id}/pay`)).s, 200);
    assert.ok((await c.query(`SELECT 1 FROM notifications WHERE type = 'adv.req' AND done_at IS NOT NULL`)).rowCount, "🔴 «Заявка на аванс» не закрилась після виплати");

    // ---------- звільнення й обхідний лист ----------
    r = await call("fin", "POST", "/payroll/employees/3/leave", { date: `${live}-28`, type: "own", reason: "за власним бажанням" });
    assert.equal(r.s, 201, JSON.stringify(r.j));
    const signN = await c.query(`SELECT r.user_id FROM notifications n JOIN notification_recipients r ON r.notification_id = n.id WHERE n.type = 'clr.sign' ORDER BY r.user_id`);
    assert.deepEqual(signN.rows.map((x) => x.user_id), [4, 5, 6, 7], "відповідальні за пункти: тім-лід, HR, БА, бухгалтерія — кожному одне сповіщення");
    assert.equal((await call("mar", "POST", "/payroll/clearances/3/items/crm/sign", { data: [true, true] })).s, 403, "🔴 підписує не відповідальний");
    assert.equal((await call("ba", "POST", "/payroll/clearances/3/items/crm/sign", { data: [true, false] })).s, 409, "підпис без усіх позначок");
    r = await call("ba", "POST", "/payroll/clearances/3/items/crm/sign", { data: [true, true] });
    assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.done, 1);
    assert.equal((await call("od", "POST", "/payroll/clearances/3/items/pay/sign", { data: [] })).s, 409, "🔴 п. 9 до пп. 1–8");
    r = await call("acc", "GET", "/payroll/clearances");
    assert.equal(r.j.length, 1, "бухгалтерія не бачить обхідного листа");
    assert.equal((await call("nat", "GET", "/payroll/clearances")).j.length, 0, "🔴 КВП бачить чужий обхідний лист");
    // п. 1 «клієнти»: передача — тим самим механізмом, що екран «Клієнти» (закріплення + історія, з 1-го наступного місяця)
    assert.equal((await call("iry", "POST", "/payroll/clearances/3/items/clients/sign", { data: { "ТОВ «Альфа»": "4" } })).s, 409, "підпис п. 1, коли не всім клієнтам призначено");
    r = await call("iry", "POST", "/payroll/clearances/3/items/clients/sign", { data: { "ТОВ «Альфа»": "4", "ТОВ «Бета»": "4" } });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    const pins = await c.query(`SELECT client_key, pinned_manager_id, to_char(pinned_from_month, 'YYYY-MM') AS mk FROM loyalty_overrides ORDER BY client_key`);
    assert.deepEqual(pins.rows.map((x) => [x.client_key, x.pinned_manager_id, x.mk]), [["альфа", 11, nextMonth(live)], ["бета", 11, nextMonth(live)]], "🔴 клієнти не передані новому відповідальному");
    const hist = await c.query(`SELECT client_key, to_manager_id, kind FROM client_manager_history ORDER BY client_key`);
    assert.deepEqual(hist.rows.map((x) => [x.client_key, x.to_manager_id, x.kind]), [["альфа", 11, "transfer"], ["бета", 11, "transfer"]], "🔴 передача без історії");
    // п. 9: ОД бачить суму фінального розрахунку; КВП — ні (немає права бачити зарплати)
    const odSheet = await call("od", "GET", "/payroll/clearances/3");
    assert.ok(odSheet.j.finalPay && odSheet.j.finalPay.month === live, `ОД не бачить суми п. 9: ${JSON.stringify(odSheet.j.finalPay)}`);
    assert.equal((await call("ba", "GET", "/payroll/clearances/3")).j.finalPay, null, "🔴 бізнес-асистент бачить суму ЗП у п. 9");

    // ---------- прогноз / аналітика / люди: нові поля ----------
    const fc = await call("od", "GET", `/payroll/forecast?month=${live}`);
    assert.equal(fc.j.closedPay.month, pm); assert.equal(fc.j.closedPay.byStatus.paid.n, 1, JSON.stringify(fc.j.closedPay));
    assert.ok(Array.isArray(fc.j.disputes));
    const an = await call("od", "GET", `/payroll/analytics?month=${pm}`);
    const t1 = an.j.teams.find((t: { k: string }) => t.k === "t1");
    assert.ok(t1 && t1.people.some((x: { id: string; pay: number }) => x.id === "3" && x.pay > 0), `люди в аналітиці без суми: ${JSON.stringify(t1?.people)}`);
    assert.ok(an.j.rowSeries.teams.t1?.length >= 1, "немає тренду рядка команди");
    assert.equal(t1.lead, "Ірина Савчук");

    // ---------- сповіщення: лише свої, прочитано ----------
    const mine = await call("ba", "GET", "/notifications");
    assert.ok(mine.j.some((n: Record<string, unknown>) => n.type === "clr.sign"));
    const before = (await call("ba", "GET", "/notifications/badge")).j.unread;
    await call("ba", "POST", "/notifications/read", { all: true });
    assert.equal((await call("ba", "GET", "/notifications/badge")).j.unread, 0); assert.ok(before > 0);
    assert.equal((await call("mar", "GET", "/notifications")).j.some((n: { type: string; title: string }) => n.type === "clr.sign" && n.title.includes("ваші пункти")), false, "🔴 менеджер бачить чужі сповіщення");
  } finally {
    await new Promise((res) => (server ? server.close(() => res(null)) : res(null)));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

test("#2604 ФРОНТ «ЗАРПЛАТИ»: пункт меню, розділ, дзвіночок у шапці, вкладки за правами з сервера, один чанк, посилання сповіщень", () => {
  const layout = FRONT("components/Layout.tsx"), dash = FRONT("pages/Dashboard.tsx"), sec = FRONT("payroll/PayrollSection.tsx"), bell = FRONT("components/NotificationBell.tsx");
  assert.match(layout, /\{ key: "payroll", label: "Зарплата", icon: "💰" \},/, "🔴 пункту «Зарплата» немає або в ньому зашиті ролі — видимість має вирішувати screen_access");
  assert.match(dash, /\{section === "payroll" && <PayrollSection \/>\}/, "🔴 розділ «Зарплата» не рендериться");
  assert.match(layout, /<NotificationBell onGo=/, "🔴 дзвіночка сповіщень немає в шапці");
  // права для вкладок — з відповіді сервера (у JWT вони старі до перелогіну)
  assert.match(sec, /me\?\.perms as string\[\]/, "🔴 вкладки беруться не з /payroll/me → perms");
  assert.ok(!/getAuthPayload\(\)\?\.perms/.test(sec), "🔴 вкладки «Зарплати» читають права з токена");
  // один чанк і жодних системних діалогів — у всій папці розділу й у дзвіночку
  const dir = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "payroll");
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.length >= 13, `🔴 файлів розділу ${files.length} — перелік загубив екрани`);
  for (const f of [...files.map((x) => `payroll/${x}`), "components/NotificationBell.tsx"]) {
    const code = FRONT(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    assert.ok(!/\blazy\(|\bimport\(/.test(code), `🔴 ${f}: lazy/import() — другий чанк (#225)`);
    assert.ok(!/\b(window\.)?(alert|confirm|prompt)\(/.test(code), `🔴 ${f}: системний діалог замість тосту (#1498)`);
    assert.ok(!/TODO-STUB/.test(FRONT(f)), `🔴 ${f}: заглушка екрана поїхала в прод`);
  }
  // кожне `go: { tab: '…' }` рушія сповіщень має вкладку в дзвіночку
  const tabs = new Set([...SRC("payroll/engine/notify.mjs").matchAll(/tab: '([a-z]+)'/g)].map((m) => m[1]));
  const map = /const ZP_TABS: Record<string, string> = \{([^}]+)\}/.exec(bell)?.[1] ?? "";
  for (const t of tabs) assert.match(map, new RegExp(`\\b${t}: "`), `🔴 сповіщення з go.tab='${t}' ведуть у нікуди`);
  assert.ok(tabs.size >= 7, `🔴 вкладок у сповіщеннях ${tabs.size} — регулярка нічого не знайшла`);
});

test("#2605 EMAIL-КАНАЛ СПОВІЩЕНЬ: без SMTP_URL вимкнено; лист — UTF-8 base64, тема encoded-word, відправник з імені", async () => {
  const M = await import("./mailer.js");
  assert.equal(M.mailConfig({}), null, "🔴 без SMTP_URL канал вважається налаштованим");
  assert.equal(M.mailConfig({ SMTP_URL: "smtp://u:p@h:587" }), null, "🔴 прийнято порт без TLS — пароль пішов би відкрито");
  const cfg = M.mailConfig({ SMTP_URL: "smtps://bot%40uts.ua:p%40ss@smtp.example.com:465", SMTP_FROM: "UTS Dashboard <noreply@uts.ua>" })!;
  assert.deepEqual(cfg, { host: "smtp.example.com", port: 465, user: "bot@uts.ua", pass: "p@ss", from: "UTS Dashboard <noreply@uts.ua>" });
  const msg = M.buildMessage(cfg.from, "a@b.ua", "Заявки на аванс відкрито", "Можна взяти до 5 010 ₴.\n.\nкрапка", new Date("2026-11-25T07:00:00Z"));
  const [head, body] = msg.split("\r\n\r\n");
  assert.match(head, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <noreply@uts\.ua>$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  assert.equal(Buffer.from(/Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head)![1], "base64").toString("utf8"), "Заявки на аванс відкрито");
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Можна взяти до 5 010 ₴.\n.\nкрапка");
  assert.ok(body.split("\r\n").every((l) => l.length <= 76 && !l.startsWith(".")), "🔴 рядок тіла довший за 76 або з крапки — SMTP обріже лист");
});

