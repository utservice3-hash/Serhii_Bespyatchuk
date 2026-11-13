import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatBreakdown, inFilter, isOutOwn, nextAct, normLine, outStatus, parseBreakdown, sumLines, type OutLine, type OutRow } from "./outBreakdown.js";

const D = (deal: number, amount: number): OutLine => ({ kind: "deal", ref: String(deal), amount });

/**
 * 💳 «Виписка» — розшифровка вихідних ФОП і картки (задача Тетяни 03.11.2026; хто бачить — Сергій 03.11, варіант «б»).
 * Окремий файл — свій процес і свій scratch-кластер (пул — синглтон процесу), як #2917.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/**
 * #3380 — РОЗБІР ВСТАВЛЕНОГО ТЕКСТУ: формат Тані «62788851 3000» рядками; «3 000», «3000,50 грн», тире й «;» — ті самі
 * пари; сміття, угода двічі й завелика кількість рядків — відмова з номером рядка. «Скопіювати» дає той самий формат.
 * 🧨 Червоніє, якщо дозволити дубль угоди, сміттєвий рядок чи загубити копійки.
 */
test("#3380 РОЗШИФРОВКА ВИХІДНИХ: «№ угоди сума» рядками розбирається; дубль і сміття — відмова з номером рядка", () => {
  const p = parseBreakdown("62788851 3000\n62793349 8000\n62791843 5000");
  assert.ok(p.ok && sumLines(p.lines) === 16000 && p.lines.length === 3, "🔴 формат Тані не розібрано");
  const v = parseBreakdown(" 62788851 - 3 000 грн ; 62793349: 8000,50\n\n62791843\t5000.5 ");
  assert.deepEqual(v.ok && v.lines, [D(62788851, 3000), D(62793349, 8000.5), D(62791843, 5000.5)], "🔴 варіанти запису розібрано не так");
  const bad = parseBreakdown("62788851 3000\nоплата за рейс");
  assert.ok(!bad.ok && /Рядок 2/.test(bad.error), "🔴 сміттєвий рядок пропущено");
  const dup = parseBreakdown("62788851 3000\n62788851 1000");
  assert.ok(!dup.ok && /двічі/.test(dup.error), "🔴 угода двічі пропущена — сума подвоїлась би");
  assert.ok(!parseBreakdown(Array.from({ length: 51 }, (_, i) => `${62700000 + i} 10`).join("\n")).ok, "🔴 понад 50 рядків прийнято");
  assert.equal(formatBreakdown([D(62788851, 3000), D(62793349, 8000.5)]), "62788851 3000\n62793349 8000.50", "🔴 «Скопіювати» не в форматі вставки");
});

/**
 * #3380b — СТАН І ФІЛЬТРИ: розписано до копійки — «З номером»; не зійшлось — у «Чекають», а не в «З номером»;
 * «Змінити» вимагає причину й позначає «відкориговано»; перше вписування — без причини. По обидва боки межі суми.
 * 🧨 Червоніє, якщо «не зійшлось» рахувати «з номером» чи пустити зміну без причини.
 */
test("#3380b РОЗШИФРОВКА ВИХІДНИХ: «не зійшлось» — у «Чекають»; «Змінити» — з причиною і в «Відкориговані»", () => {
  const row = (amount: number, corrected = false): OutRow => ({ status: "identified", lines: [D(62788851, amount)], corrected });
  assert.equal(outStatus(row(16000), -16000), "ok", "🔴 повна розшифровка — не «з номером»");
  assert.equal(outStatus(row(15999.99), 16000), "mismatch", "🔴 копійка різниці не помічена");
  assert.equal(outStatus(null, 16000), "wait");
  assert.deepEqual([inFilter("ok", row(14000), 16000), inFilter("wait", row(14000), 16000)], [false, true], "🔴 «не зійшлось» потрапило в «З номером»");
  assert.deepEqual([inFilter("corrected", row(16000, true), 16000), inFilter("corrected", row(16000), 16000)], [true, false], "🔴 фільтр «Відкориговані»");
  assert.deepEqual(nextAct(null, "lines"), { act: "set", needsReason: false, corrected: false }, "🔴 перше вписування вимагає причину");
  assert.deepEqual(nextAct(row(1), "lines"), { act: "change", needsReason: true, corrected: true }, "🔴 зміна без причини або не позначена");
  assert.equal(nextAct(null, "unidentify").needsReason, true, "🔴 «неідентифікований» без причини");
});

/**
 * #3381 — ЖИВИЙ SQL І ПРАВА: після двох прогонів схеми право бачити й писати мають рівно адмін, фінансист, Бухгалтерія,
 * тімлід; менеджер і СЕО — 403 (дзеркало: тімлід — так); вписати → «З номером»; змінити без причини — 400, з причиною →
 * «Відкориговані», в історії «розписано → змінено»; вхідний і ТОВ-платіж — 400; свій переказ у лічильник не падає.
 * 🧨 Червоніє, якщо зняти перевірку права, причини, межі рахунків чи запису історії.
 */
test("#3381 ЖИВИЙ SQL: розшифровка вихідних — права «б», вписати → змінити з причиною → «Відкориговані», історія, межі", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  process.env.DATABASE_URL = scratch.url;
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  process.env.BANK_IDENT_ACCOUNT_IDS = "9101,9102";
  process.env.BANK_IDENT_FROM = new Date(Date.now() - 30 * 864e5).toISOString();
  const { pool } = await import("../db/pool.js");
  const { default: express } = await import("express");
  let server: import("node:http").Server | null = null;
  try {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await pool.query(schema);
    // «Бухгалтерія» на проді створена в інтерфейсі (у schema.sql її немає) — як там: роль є до наступного прогону схеми
    await pool.query(`INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions)
      VALUES ('____________', 'Бухгалтерія', false, 'company', '{"bank":true}'::jsonb, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`);
    await pool.query(schema);
    for (const perm of ["view_bank_out_breakdown", "edit_bank_out_breakdown"]) {
      const holders = (await pool.query<{ key: string }>(`SELECT key FROM roles WHERE (permissions->>$1)::boolean ORDER BY key`, [perm])).rows.map((r) => r.key);
      assert.deepEqual(holders, ["____________", "admin", "financier", "team_lead"], `🔴 ${perm} — не рівно фінанси й тімліди`);
    }
    await pool.query(`INSERT INTO bank_accounts (id, company, bank, label, currency, iban) VALUES
      (9101, 'fop_privat', 'privat', 'ФОП (Приват)', 'UAH', 'UA000000000000000000000009101'),
      (9102, 'fop_mono', 'mono', 'ФОП (Моно)', 'UAH', NULL), (9103, 'uts', 'privat', 'ЮТС', 'UAH', NULL)`);
    await pool.query(`INSERT INTO bank_transactions (id, account_id, direction, external_tx_id, booked_at, created_at, counterparty_name, counterparty_iban, purpose, amount, currency, amount_uah) VALUES
      (881, 9101, 'out', 'o881', now() - interval '2 hours', now(), 'ФОП Перевізник', NULL, 'оплата за послуги', -16000, 'UAH', -16000),
      (882, 9102, 'out', 'o882', now() - interval '3 hours', now(), 'ТОВ Перевізник', NULL, 'оплата', -5000, 'UAH', -5000),
      (883, 9101, 'in',  'i883', now() - interval '3 hours', now(), 'Клієнт', NULL, 'оплата', 7000, 'UAH', 7000),
      (884, 9103, 'out', 'o884', now() - interval '3 hours', now(), 'ТОВ Перевізник', NULL, 'оплата', -9000, 'UAH', -9000),
      (885, 9102, 'out', 'o885', now() - interval '4 hours', now(), 'Свій рахунок', 'UA000000000000000000000009101', 'переказ між власними рахунками', -1000, 'UAH', -1000),
      (886, 9102, 'out', 'o886', now() - interval '5 hours', now(), 'Беспятчук Сергій', NULL, 'Переказ на картку', -20453, 'UAH', -20453)`);
    await pool.query(`INSERT INTO deals (kommo_id, name, price, pipeline_id, status_id) VALUES (62788851, 'Київ – Львів', 7000, 8921932, 142) ON CONFLICT DO NOTHING`).catch(() => undefined);
    await pool.query(`INSERT INTO users (id, email, password_hash, role, role_override, team_id, full_name, is_active) VALUES
      (981, 'm@o', 'x', 'manager', NULL, NULL, 'Менеджер', true),
      (982, 't@o', 'x', 'team_lead', 'team_lead', NULL, 'Тімлід Яцик', true),
      (983, 'c@o', 'x', 'manager', 'ceo', NULL, 'СЕО', true)`);
    const { refreshRoles } = await import("../auth/rbac.js"); await refreshRoles();
    const { signToken } = await import("../auth/auth.js");
    const tok = (userId: number, roleKey: string, role: "admin" | "manager" | "team_lead" | "company") => signToken({ userId, role, roleKey, managerId: null, teamId: null });
    const M = tok(981, "manager", "manager"), T = tok(982, "team_lead", "team_lead"), C = tok(983, "ceo", "company");
    const { bankIdentRouter } = await import("../routes/bankIdent.js");
    const app = express(); app.use("/api/bank-ident", bankIdentRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server!.address() as import("node:net").AddressInfo).port;
    const call = async (token: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/bank-ident${url}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };

    for (const [who, X] of [["менеджер", M], ["СЕО", C]] as const) {
      assert.equal((await call(X, "GET", "/out/counts")).status, 403, `🔴 ${who} бачить розшифровку`);
      assert.equal((await call(X, "POST", "/out/881", { text: "62788851 16000" })).status, 403, `🔴 ${who} вписав розшифровку`);
    }
    const c0 = (await call(T, "GET", "/out/counts")).json.counts;
    assert.deepEqual([c0.all, c0.wait, c0.ok], [3, 3, 0], `🔴 лічильник до вписування (свій переказ і ТОВ не рахуються; «Переказ на картку» власнику — рахується): ${JSON.stringify(c0)}`);
    assert.equal((await call(T, "POST", "/out/883", { text: "62788851 7000" })).status, 400, "🔴 розписано вхідний");
    assert.equal((await call(T, "POST", "/out/884", { text: "62788851 9000" })).status, 400, "🔴 розписано вихідний ТОВ");

    const s1 = await call(T, "POST", "/out/881", { text: "62788851 3000\n62793349 13000" });
    assert.deepEqual([s1.status, s1.json.state?.status, s1.json.state?.lines?.[0]?.name], [201, "ok", "Київ – Львів"], JSON.stringify(s1.json));
    assert.equal((await call(T, "POST", "/out/881", { text: "62788851 16000" })).status, 400, "🔴 змінено без причини");
    const s2 = await call(T, "POST", "/out/881", { text: "62788851 16000", reason: "Таня уточнила" });
    assert.deepEqual([s2.status, s2.json.state?.corrected], [201, true], "🔴 зміна не позначена «відкориговано»");
    const corr = (await call(T, "GET", "/out/list?status=corrected")).json;
    assert.deepEqual(corr.rows.map((r: { id: number }) => Number(r.id)), [881], "🔴 «Відкориговані» не показують змінений платіж");
    const hist = ((await call(T, "GET", "/out/881/history")).json.events as Array<{ act: string; reason: string | null }>).map((e) => [e.act, e.reason]);
    assert.deepEqual(hist, [["change", "Таня уточнила"], ["set", null]], "🔴 історія не «розписано → змінено»");

    assert.equal((await call(T, "POST", "/out/882", { text: "62793349 4000" })).status, 201);
    const mix = await call(T, "POST", "/out/886", { text: "4445 20000 (Операційний запит)\nDigitalOcean 453" });
    assert.deepEqual([mix.status, mix.json.state?.status, mix.json.state?.lines?.map((l: { kind: string; known: boolean }) => `${l.kind}:${l.known}`)],
      [201, "ok", ["op:true", "text:true"]], `🔴 запит + категорія не розписали платіж: ${JSON.stringify(mix.json)}`);
    const c1 = (await call(T, "GET", "/out/counts")).json.counts;
    assert.deepEqual([c1.ok, c1.wait, c1.corrected], [2, 1, 1], `🔴 «не зійшлось» (4000 з 5000) пішло не в «Чекають»: ${JSON.stringify(c1)}`);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #3383 — ТРИ ВИДИ РЯДКІВ (Тетяна 03.11, 18:56): 8–9 цифр — угода, до 7 — операційний запит, текст із літерою —
 * категорія; хвіст у дужках — примітка; сума звіряється так само. Межа по обидва боки: «4445» — НЕ угода,
 * «62821719» — угода, «DigitalOcean» — категорія, «оплата за рейс» без суми — відмова. Старі записи `{deal}` — угода.
 * 🧨 Червоніє, якщо повернути «лише № угоди», сплутати запит з угодою чи загубити примітку при «Скопіювати».
 */
test("#3383 РОЗШИФРОВКА ВИХІДНИХ: угода · операційний запит · категорія текстом — сума звіряється, примітка в дужках", () => {
  const p = parseBreakdown("62821719 - 3000 (витрата по угоді)\n4445 - 5 000 (Операційний запит)\nзп Іванов 20000\nDigitalOcean 9.88 USD 453,50");
  assert.ok(p.ok, `🔴 змішана розшифровка не розібрана: ${!p.ok && p.error}`);
  assert.deepEqual(p.ok && p.lines, [
    { kind: "deal", ref: "62821719", amount: 3000, note: "витрата по угоді" },
    { kind: "op", ref: "4445", amount: 5000, note: "Операційний запит" },
    { kind: "text", ref: "зп Іванов", amount: 20000 },
    { kind: "text", ref: "DigitalOcean 9.88 USD", amount: 453.5 },
  ], "🔴 вид рядка, № чи сума розібрані не так");
  assert.equal(p.ok && sumLines(p.lines), 28453.5, "🔴 сума змішаної розшифровки");
  assert.ok(p.ok && parseBreakdown(formatBreakdown(p.lines)).ok && formatBreakdown(p.lines).includes("4445 5000 (Операційний запит)"), "🔴 «Скопіювати» не розбирається назад або губить примітку");
  assert.ok(!parseBreakdown("оплата за рейс").ok, "🔴 рядок без суми прийнято");
  const dup = parseBreakdown("зп 100\nЗП 200");
  assert.ok(!dup.ok && /двічі/.test(dup.error), "🔴 категорія двічі — сума подвоїлась би");
  assert.ok(parseBreakdown("4445 100\n62804445 100").ok, "🔴 запит і угода з однаковим хвостом сплутані");
  assert.deepEqual(normLine({ deal: 62788851, amount: 3000 }), D(62788851, 3000), "🔴 старий запис `{deal}` прочитано не як угоду");
});

/**
 * #3970 — «СВІЙ ПЕРЕКАЗ» ДЛЯ ВИХІДНИХ (змінено 13.11.2026, наступник #3383b): «Переказ на картку» Беспятчуку з ФОП Моно —
 * свій (розшифровка — на робочій картці), і стан рядка «свій» навіть тоді, коли переказ уже розписали; той самий переказ із
 * ФОП Приват, переказ на картку іншій людині, інша підстава й вхідний — ні. Наш IBAN і «між власними» — свої, як були.
 * 🧨 Червоніє, якщо переказ на картку знову вимагатиме розшифровки, правило зачепить інший рахунок чи іншу людину, або вже
 * розписаний переказ лишиться розписаним (гроші двічі: на ФОП і на картці).
 */
test("#3970 РОЗШИФРОВКА ВИХІДНИХ: «Переказ на картку» Беспятчуку з ФОП Моно — свій (і вже розписаний); з інших рахунків і іншим людям — ні", () => {
  const r = { ownIbans: new Set(["UA000000000000000000000009101"]) };
  const tx = (name: string, iban: string | null, purpose: string, accountId = 4, incoming = false) => ({ id: 1, accountId, incoming, bookedAt: 0, seenAt: null, counterpartyName: name, counterpartyIban: iban, purpose });
  assert.equal(isOutOwn(tx("Беспятчук Сергій", null, "Переказ на картку"), r), true, "🔴 переказ на картку власнику з ФОП Моно вимагає розшифровки");
  assert.equal(isOutOwn(tx("Беспятчук Сергій", null, "Переказ на картку", 3), r), false, "🔴 правило зачепило ФОП Приват");
  assert.equal(isOutOwn(tx("Іваненко Петро", null, "Переказ на картку"), r), false, "🔴 переказ на картку іншій людині — «свій»");
  assert.equal(isOutOwn(tx("Беспятчук Сергій", null, "Оплата послуг"), r), false, "🔴 інша підстава — «свій»");
  assert.equal(isOutOwn(tx("Беспятчук Сергій", null, "Переказ на картку", 4, true), r), false, "🔴 вхідний — «свій» за правилом вихідних");
  assert.equal(isOutOwn(tx("ФОП Беспятчук Сергій Степанович", "UA000000000000000000000009101", "Переказ"), r), true, "🔴 переказ на наш рахунок — не «свій»");
  assert.equal(isOutOwn(tx("Хтось", null, "Переказ між власними рахунками"), r), true, "🔴 «між власними рахунками» — не «свій»");
  assert.match(SRC("routes/bankIdent.ts"), /const ownNow = own\.has\(id\) && \(!row \|\| isFopMonoToOwnerCard\(toLite\(t\)\)\);[\s\S]{0,200}own: ownNow, status: ownNow \? "own"/,
    "🔴 уже розписаний переказ на картку лишився розписаним — гроші двічі");
  const fe = FRONT("bankIdent/OutBreakdown.tsx");
  assert.match(fe, /4445 5000/, "🔴 підказка над полем не показує операційний запит");
  assert.match(fe, /зп 20000/, "🔴 підказка над полем не показує категорію");
});

/**
 * #3382 — ФРОНТ: фільтр і рядок розшифровки є лише на «Вихідних» і лише з правом view_bank_out_breakdown; змінена
 * розшифровка підсвічена фіолетовою смугою; «Скопіювати» копіює серверний текст у форматі вставки.
 * 🧨 Червоніє, якщо показати розшифровку без права, прибрати підсвітку чи кнопку «Скопіювати».
 */
test("#3382 ФРОНТ «Виписки»: розшифровка вихідних — лише з правом і на «Вихідних», змінені підсвічено, «Скопіювати»", () => {
  const bank = FRONT("pages/dashboard/sections/BankSection.tsx");
  assert.match(bank, /const canSeeOut = perms\.includes\(OUT_VIEW_PERM\) && mode === "out";/, "🔴 розшифровку показано без права або не лише на «Вихідних»");
  assert.match(bank, /out\?\.state\.corrected \? `3px solid \$\{OUT_CORRECTED_COLOR\}`/, "🔴 змінені не підсвічено");
  assert.match(bank, /\{canSeeOut && <OutFilterBar counts=\{outCounts\} value=\{outF\} onChange=\{setOutF\} \/>\}/, "🔴 немає фільтра «З номером · Чекають · … · Відкориговані»");
  const ui = FRONT("bankIdent/OutBreakdown.tsx");
  assert.match(ui, /navigator\.clipboard\.writeText\(state\.text\)/, "🔴 «Скопіювати» не копіює текст розшифровки");
  assert.match(ui, /\["corrected", "Відкориговані"\]/, "🔴 немає фільтра «Відкориговані»");
});
