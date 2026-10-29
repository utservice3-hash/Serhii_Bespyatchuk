import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💳 «Виписка» — «↺ Скинути №» (28.10.2026, погодив Сергій): менеджер вписав не той номер → фінансист скидає, платіж знову
 * «Чекає №», і правильний номер вписують заново. Окремий файл — свій процес і свій scratch-кластер (пул — синглтон процесу).
 */
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/**
 * #2917 — СКИДАННЯ ВПИСАНОГО №:
 *  - фінансист скидає з причиною → «Чекає №» → менеджер вписує правильний (201); в історії «зафіксовано → скинуто → зафіксовано»;
 *  - без причини — 400; із застарілим номером — 409; менеджер, тімлід, СЕО, ОД, КВП — 403 (дзеркало: фінансист і адмін — так);
 *  - після строку — 409 «Строк минув»: «Неідентифікований за строком» лишається остаточним;
 *  - `can.reset` у стані — лише тому, хто має право, лише на вписаному і лише до строку;
 *  - склад права після схеми — рівно фінансист і адмін (синки ролей не розтягли);
 *  - кнопка «↺ Скинути №» у рядку фронту є і веде на /reset.
 * 🧨 Червоніє, якщо зняти перевірку права, строку, `expected` чи причини, або дати право ще комусь.
 */
test("#2917 СКИНУТИ № РАХУНКУ: фінансист з причиною → знову «Чекає №» → вписують правильний; після строку й без права — ні", async (t) => {
  const line = FRONT("bankIdent/client/bankIdent/identLineMount.ts");
  assert.match(line, /s\.can\.reset \? B\('reset', '↺ Скинути №', '', ui\) : ''/, "🔴 кнопки «↺ Скинути №» немає в рядку");
  assert.match(FRONT("bankIdent/client/bankIdent/api.ts"), /call<\{ state: IdentState \}>\('POST', `\/\$\{id\(txId\)\}\/reset`, \{ reason, expected \}\)/, "🔴 клієнт не шле /reset");
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  process.env.DATABASE_URL = scratch.url;
  for (const k of ["JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  process.env.BANK_IDENT_ACCOUNT_IDS = "9001,9002,9003";
  process.env.BANK_OUT_COMMENT_ACCOUNT_IDS = "9001,9002";
  process.env.BANK_IDENT_FROM = new Date(Date.now() - 30 * 864e5).toISOString();
  const { pool } = await import("../db/pool.js");
  const { default: express } = await import("express");
  let server: import("node:http").Server | null = null;
  try {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await pool.query(schema);
    await pool.query(schema); // другий прогін — як на проді: склад права має пережити синки ролей
    const holders = (await pool.query<{ key: string }>(`SELECT key FROM roles WHERE (permissions->>'reset_bank_invoice')::boolean ORDER BY key`)).rows.map((r) => r.key);
    assert.deepEqual(holders, ["admin", "financier"], "🔴 «Скинути №» — не рівно фінансист і адмін");
    await pool.query(`INSERT INTO bank_accounts (id, company, bank, label, currency) VALUES (9001, 'fop_privat', 'privat', 'ФОП (Приват)', 'UAH')`);
    const h = (n: number) => `now() - interval '${n} hours'`;
    await pool.query(`INSERT INTO bank_transactions (id, account_id, direction, external_tx_id, booked_at, created_at, counterparty_name, purpose, amount, currency, amount_uah) VALUES
      (771, 9001, 'in', 'z771', ${h(2)}, ${h(2)}, 'Клієнт Помилка', 'оплата', 1000, 'UAH', 1000),
      (772, 9001, 'in', 'z772', ${h(2)}, ${h(2)}, 'Клієнт Другий', 'оплата', 1000, 'UAH', 1000)`);
    await pool.query(`INSERT INTO users (id, email, password_hash, role, role_override, team_id, full_name, is_active) VALUES
      (971, 'm@r', 'x', 'manager', NULL, NULL, 'Вікторія Менеджер', true),
      (972, 'f@r', 'x', 'manager', 'financier', NULL, 'Олена Фінансист', true),
      (973, 'c@r', 'x', 'manager', 'ceo', NULL, 'СЕО', true),
      (974, 'a@r', 'x', 'admin', 'admin', NULL, 'Адмін', true)`);
    const { refreshRoles } = await import("../auth/rbac.js"); await refreshRoles();
    const { signToken } = await import("../auth/auth.js");
    const tok = (userId: number, roleKey: string, role: "admin" | "manager" | "company") => signToken({ userId, role, roleKey, managerId: null, teamId: null });
    const M = tok(971, "manager", "manager"), F = tok(972, "financier", "company"), C = tok(973, "ceo", "company"), A = tok(974, "admin", "admin");
    const { bankIdentRouter } = await import("../routes/bankIdent.js");
    const app = express(); app.use("/api/bank-ident", bankIdentRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server!.address() as import("node:net").AddressInfo).port;
    const call = async (token: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/bank-ident${url}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };

    assert.equal((await call(M, "POST", "/771/invoice", { no: "8981" })).status, 201);
    const stM = (await call(M, "POST", "/state", { ids: [771] })).json.states["771"];
    const stF = (await call(F, "POST", "/state", { ids: [771] })).json.states["771"];
    assert.deepEqual([!!stM.can.reset, !!stF.can.reset], [false, true], "🔴 «Скинути №» показано не тому (менеджер / фінансист)");
    for (const [who, T] of [["менеджер", M], ["СЕО", C]] as const) {
      assert.equal((await call(T, "POST", "/771/reset", { reason: "помилка", expected: "8981" })).status, 403, `🔴 ${who} скинув номер`);
    }
    assert.equal((await call(F, "POST", "/771/reset", { reason: "", expected: "8981" })).status, 400, "🔴 скинуто без причини");
    assert.equal((await call(F, "POST", "/771/reset", { reason: "помилка", expected: "1111" })).status, 409, "🔴 скинуто за застарілим номером");
    const r1 = await call(F, "POST", "/771/reset", { reason: "менеджер помилилась", expected: "8981" });
    assert.deepEqual([r1.status, r1.json.state?.status, r1.json.state?.can?.set], [200, "wait", true], JSON.stringify(r1.json));
    assert.equal((await call(M, "POST", "/771/invoice", { no: "8990" })).status, 201, "🔴 після скидання менеджер не може вписати правильний");
    const hist = ((await call(M, "GET", "/771/history")).json.events as Array<{ act: string; fromNo: string | null; toNo: string | null; reason: string | null }>).map((e) => [e.act, e.fromNo, e.toNo, e.reason]);
    assert.deepEqual(hist, [["set", null, "8981", null], ["reset", "8981", null, "менеджер помилилась"], ["set", null, "8990", null]], "🔴 історія не «зафіксовано → скинуто → зафіксовано»");
    assert.equal((await call(A, "POST", "/771/reset", { reason: "ще раз", expected: "8990" })).status, 200, "🔴 адмін не може скинути");

    // після строку — не можна: «Неідентифікований за строком» остаточний
    assert.equal((await call(M, "POST", "/772/invoice", { no: "777" })).status, 201);
    await pool.query(`UPDATE bank_tx_ident SET deadline_at = now() - interval '1 minute' WHERE tx_id = 772`);
    const late = await call(F, "POST", "/772/reset", { reason: "помилка", expected: "777" });
    assert.deepEqual([late.status, late.json.error], [409, "Строк минув — скинути номер уже не можна: платіж став би «Неідентифікованим»."], "🔴 скинуто після строку");
    assert.equal((await call(F, "POST", "/state", { ids: [772] })).json.states["772"].can.reset, false, "🔴 кнопку показано після строку");
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
