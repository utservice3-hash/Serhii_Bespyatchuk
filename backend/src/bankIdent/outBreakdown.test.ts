import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatBreakdown, inFilter, nextAct, outStatus, parseBreakdown, sumLines, type OutRow } from "./outBreakdown.js";

/**
 * 💳 «Виписка» — розшифровка вихідних ФОП і картки (задача Тетяни 03.11.2026; хто бачить — Сергій 03.11, варіант «б»).
 * Окремий файл — свій процес і свій scratch-кластер (пул — синглтон процесу), як #2917.
 */
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/**
 * #3360 — РОЗБІР ВСТАВЛЕНОГО ТЕКСТУ: формат Тані «62788851 3000» рядками; «3 000», «3000,50 грн», тире й «;» — ті самі
 * пари; сміття, угода двічі й завелика кількість рядків — відмова з номером рядка. «Скопіювати» дає той самий формат.
 * 🧨 Червоніє, якщо дозволити дубль угоди, сміттєвий рядок чи загубити копійки.
 */
test("#3360 РОЗШИФРОВКА ВИХІДНИХ: «№ угоди сума» рядками розбирається; дубль і сміття — відмова з номером рядка", () => {
  const p = parseBreakdown("62788851 3000\n62793349 8000\n62791843 5000");
  assert.ok(p.ok && sumLines(p.lines) === 16000 && p.lines.length === 3, "🔴 формат Тані не розібрано");
  const v = parseBreakdown(" 62788851 - 3 000 грн ; 62793349: 8000,50\n\n62791843\t5000.5 ");
  assert.deepEqual(v.ok && v.lines, [{ deal: 62788851, amount: 3000 }, { deal: 62793349, amount: 8000.5 }, { deal: 62791843, amount: 5000.5 }], "🔴 варіанти запису розібрано не так");
  const bad = parseBreakdown("62788851 3000\nоплата за рейс");
  assert.ok(!bad.ok && /Рядок 2/.test(bad.error), "🔴 сміттєвий рядок пропущено");
  const dup = parseBreakdown("62788851 3000\n62788851 1000");
  assert.ok(!dup.ok && /двічі/.test(dup.error), "🔴 угода двічі пропущена — сума подвоїлась би");
  assert.ok(!parseBreakdown("123 3000").ok, "🔴 короткий номер прийнято за угоду");
  assert.ok(!parseBreakdown(Array.from({ length: 51 }, (_, i) => `${62700000 + i} 10`).join("\n")).ok, "🔴 понад 50 рядків прийнято");
  assert.equal(formatBreakdown([{ deal: 62788851, amount: 3000 }, { deal: 62793349, amount: 8000.5 }]), "62788851 3000\n62793349 8000.50", "🔴 «Скопіювати» не в форматі вставки");
});

/**
 * #3360b — СТАН І ФІЛЬТРИ: розписано до копійки — «З номером»; не зійшлось — у «Чекають», а не в «З номером»;
 * «Змінити» вимагає причину й позначає «відкориговано»; перше вписування — без причини. По обидва боки межі суми.
 * 🧨 Червоніє, якщо «не зійшлось» рахувати «з номером» чи пустити зміну без причини.
 */
test("#3360b РОЗШИФРОВКА ВИХІДНИХ: «не зійшлось» — у «Чекають»; «Змінити» — з причиною і в «Відкориговані»", () => {
  const row = (amount: number, corrected = false): OutRow => ({ status: "identified", lines: [{ deal: 62788851, amount }], corrected });
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
 * #3361 — ЖИВИЙ SQL І ПРАВА: після двох прогонів схеми право бачити й писати мають рівно адмін, фінансист, Бухгалтерія,
 * тімлід; менеджер і СЕО — 403 (дзеркало: тімлід — так); вписати → «З номером»; змінити без причини — 400, з причиною →
 * «Відкориговані», в історії «розписано → змінено»; вхідний і ТОВ-платіж — 400; свій переказ у лічильник не падає.
 * 🧨 Червоніє, якщо зняти перевірку права, причини, межі рахунків чи запису історії.
 */
test("#3361 ЖИВИЙ SQL: розшифровка вихідних — права «б», вписати → змінити з причиною → «Відкориговані», історія, межі", async (t) => {
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
      (885, 9102, 'out', 'o885', now() - interval '4 hours', now(), 'Свій рахунок', 'UA000000000000000000000009101', 'переказ між власними рахунками', -1000, 'UAH', -1000)`);
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
    assert.deepEqual([c0.all, c0.wait, c0.ok], [2, 2, 0], `🔴 лічильник до вписування (свій переказ і ТОВ не рахуються): ${JSON.stringify(c0)}`);
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
    const c1 = (await call(T, "GET", "/out/counts")).json.counts;
    assert.deepEqual([c1.ok, c1.wait, c1.corrected], [1, 1, 1], `🔴 «не зійшлось» (4000 з 5000) пішло не в «Чекають»: ${JSON.stringify(c1)}`);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #3362 — ФРОНТ: фільтр і рядок розшифровки є лише на «Вихідних» і лише з правом view_bank_out_breakdown; змінена
 * розшифровка підсвічена фіолетовою смугою; «Скопіювати» копіює серверний текст у форматі вставки.
 * 🧨 Червоніє, якщо показати розшифровку без права, прибрати підсвітку чи кнопку «Скопіювати».
 */
test("#3362 ФРОНТ «Виписки»: розшифровка вихідних — лише з правом і на «Вихідних», змінені підсвічено, «Скопіювати»", () => {
  const bank = FRONT("pages/dashboard/sections/BankSection.tsx");
  assert.match(bank, /const canSeeOut = perms\.includes\(OUT_VIEW_PERM\) && mode === "out";/, "🔴 розшифровку показано без права або не лише на «Вихідних»");
  assert.match(bank, /out\?\.state\.corrected \? `3px solid \$\{OUT_CORRECTED_COLOR\}`/, "🔴 змінені не підсвічено");
  assert.match(bank, /\{canSeeOut && <OutFilterBar counts=\{outCounts\} value=\{outF\} onChange=\{setOutF\} \/>\}/, "🔴 немає фільтра «З номером · Чекають · … · Відкориговані»");
  const ui = FRONT("bankIdent/OutBreakdown.tsx");
  assert.match(ui, /navigator\.clipboard\.writeText\(state\.text\)/, "🔴 «Скопіювати» не копіює текст розшифровки");
  assert.match(ui, /\["corrected", "Відкориговані"\]/, "🔴 немає фільтра «Відкориговані»");
});
