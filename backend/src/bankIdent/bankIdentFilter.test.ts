import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💳 «Виписка» — фільтр № рахунку за вибраним рахунком (28.10.2026). Окремий файл, бо `#2912` у bankIdent.test.ts закриває
 * спільний пул БД у своєму `finally`, а пул — синглтон процесу (правило зони тестів: один scratch-кластер на процес).
 */
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/**
 * #2916 — ФІЛЬТР № РАХУНКУ ЙДЕ ЗА ВИБРАНИМ РАХУНКОМ (28.10.2026, знайдено на проді: чип «ФОП (Моно)» + «З номером» показав
 * платіж ФОП (Приват)). `/list` і `/counts` з `company` — лише рахунки цієї компанії, по ОБИДВА боки; без `company` — усі;
 * бейдж у меню від компанії не залежить. Фронт передає вибраний чип (`bankIdentApiFor(companyFilter)`) у фільтр і лічильники.
 * 🧨 Червоніє, якщо `/list` чи `/counts` знову візьмуть усі рахунки правила або фронт перестане передавати компанію.
 */
test("#2916 ФІЛЬТР № РАХУНКУ ЗА ВИБРАНИМ РАХУНКОМ: /list і /counts з company — лише ця компанія, без неї — усі, бейдж загальний", async (t) => {
  const sec = FRONT("pages/dashboard/sections/BankSection.tsx");
  assert.match(sec, /const identApi = useMemo\(\(\) => bankIdentApiFor\(companyFilter\), \[companyFilter\]\);/, "🔴 «Виписка» не передає вибраний рахунок у фільтр № рахунку");
  assert.match(sec, /useBankIdentCounts\(identApi\)/, "🔴 лічильники фільтра — не за вибраним рахунком");
  assert.match(sec, /identApi\.list\(identKey, 200\)/, "🔴 рядки фільтра — не за вибраним рахунком");
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
    await pool.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await pool.query(`INSERT INTO bank_accounts (id, company, bank, label, currency) VALUES
      (9001, 'fop_privat', 'privat', 'ФОП (Приват)', 'UAH'), (9002, 'fop_mono', 'mono', 'ФОП (Моно)', 'UAH'), (9004, 'uts', 'privat', 'ТОВ ЮТС', 'UAH')`);
    const h = (n: number) => `now() - interval '${n} hours'`;
    await pool.query(`INSERT INTO bank_transactions (id, account_id, direction, external_tx_id, booked_at, created_at, counterparty_name, purpose, amount, currency, amount_uah) VALUES
      (751, 9001, 'in', 'y751', ${h(1)}, ${h(1)}, 'Клієнт Приват 1', 'оплата', 100, 'UAH', 100),
      (752, 9001, 'in', 'y752', ${h(2)}, ${h(2)}, 'Клієнт Приват 2', 'оплата', 100, 'UAH', 100),
      (753, 9002, 'in', 'y753', ${h(1)}, ${h(1)}, 'Клієнт Моно', 'оплата', 100, 'UAH', 100)`);
    await pool.query(`INSERT INTO users (id, email, password_hash, role, role_override, team_id, full_name, is_active) VALUES (961, 'm@f', 'x', 'manager', NULL, NULL, 'Менеджер', true)`);
    const { refreshRoles } = await import("../auth/rbac.js"); await refreshRoles();
    const { signToken } = await import("../auth/auth.js");
    const M = signToken({ userId: 961, role: "manager", roleKey: "manager", managerId: null, teamId: null });
    const { bankIdentRouter } = await import("../routes/bankIdent.js");
    const app = express(); app.use("/api/bank-ident", bankIdentRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server!.address() as import("node:net").AddressInfo).port;
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/bank-ident${url}`, { method, headers: { Authorization: `Bearer ${M}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    assert.equal((await call("POST", "/751/invoice", { no: "Р-1" })).status, 201);
    const ids = async (q: string) => ((await call("GET", `/list?${q}`)).json.ids as number[]).sort();
    assert.deepEqual(await ids("status=identified&company=fop_mono"), [], "🔴 на чипі «ФОП (Моно)» «З номером» показав платіж Приват");
    assert.deepEqual(await ids("status=identified&company=fop_privat"), [751]);
    assert.deepEqual(await ids("status=identified"), [751], "🔴 без компанії фільтр не по всіх рахунках");
    assert.deepEqual(await ids("status=wait&company=fop_mono"), [753], "🔴 «Чекають №» на «ФОП (Моно)» — не рівно Моно");
    assert.deepEqual(await ids("status=wait&company=fop_privat"), [752]);
    assert.deepEqual(await ids("status=wait"), [752, 753]);
    const c = async (q: string) => { const j = (await call("GET", `/counts${q}`)).json; return [j.wait, j.identified, j.badge]; };
    assert.deepEqual(await c("?company=fop_mono"), [1, 0, 2], "🔴 лічильники «ФОП (Моно)» не свої, або бейдж залежить від компанії");
    assert.deepEqual(await c("?company=fop_privat"), [1, 1, 2]);
    assert.deepEqual(await c("?company=uts"), [0, 0, 2], "🔴 ЮТС не під правилом, а лічильник не нуль");
    assert.deepEqual(await c(""), [2, 1, 2]);
    assert.equal((await call("GET", "/counts?company=x;drop")).status, 400, "🔴 довільний рядок компанії пройшов у запит");
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
