import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { mirrorPlan } from "./legacyLimits.js";

/**
 * 🛑 ПРАВИЛА ЛІМІТІВ КЛІЄНТІВ (Роман 03.11.2026): призупинений ліміт справді зупиняє оплату перевізнику; змінився власник /
 * директор → ліміт зупиняється до переузгодження Сергієм; 3 місяці без угод (і без боргу) → ліміт скидається, потрібен
 * новий запит. Окремий файл: наскрізні гейти піднімають свою scratch-БД, а пул `db/pool.js` — один на процес.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

/**
 * #3362 — ДЗЕРКАЛО: призупинений ліміт = знятий, і сильніший за активний на тому самому ключі (у будь-якому порядку).
 * Дзеркальна половина: активний НЕ призупинений лишається з днями й сумою. 🧨 Червоніє, якщо дзеркало знову перестане
 * бачити призупинення (тоді «призупинено» — лише напис, а оплата перевізнику йде «у межах ліміту»), або якщо активний
 * ліміт перебʼє призупинений, або якщо зникне звичайний ліміт.
 */
test("#3362 ДЗЕРКАЛО: призупинений ліміт знімається з дебіторки й сильніший за активний; звичайний лишається", () => {
  const debtors = [{ key: "rivne", codes: ["41234567"] }, { key: "lviv", codes: [] }];
  const L = (o: Partial<Parameters<typeof mirrorPlan>[0][number]>) => ({ id: "1", debtorKey: null, active: true, limit: 300000, days: 30, from: "inv" as const, members: [], ...o });
  assert.deepEqual(mirrorPlan([L({ debtorKey: "lviv" })], debtors).get("lviv"), { days: 30, amount: 300000 }, "звичайний активний ліміт зник з дебіторки");
  assert.deepEqual(mirrorPlan([L({ debtorKey: "lviv", suspended: false })], debtors).get("lviv"), { days: 30, amount: 300000 }, "suspended:false зняв ліміт");
  const p = mirrorPlan([L({ debtorKey: "lviv", suspended: true })], debtors);
  assert.ok(p.has("lviv") && p.get("lviv") === null, "призупинений ліміт лишився в дебіторці — оплата перевізнику піде «у межах ліміту»");
  assert.equal(mirrorPlan([L({ members: [{ code: "41234567" }], suspended: true })], debtors).get("rivne"), null, "призупинення не дійшло до боржника за ЄДРПОУ");
  const both = [L({ id: "1", debtorKey: "lviv", suspended: true }), L({ id: "2", debtorKey: "lviv", days: 7 })];
  assert.equal(mirrorPlan(both, debtors).get("lviv"), null, "активний ліміт перебив призупинений");
  assert.equal(mirrorPlan([...both].reverse(), debtors).get("lviv"), null, "активний ліміт перебив призупинений (інший порядок)");
  assert.deepEqual(mirrorPlan([L({ id: "1", debtorKey: "lviv", active: false, suspended: true }), L({ id: "2", debtorKey: "lviv", days: 7 })], debtors).get("lviv"),
    { days: 7, amount: 300000 }, "ЗНЯТИЙ (не активний) ліміт з позначкою перебив чинний");
});

/**
 * #3362b — ДЗЕРКАЛО НАСКРІЗНО (scratch-БД): SQL дзеркала читає обидва види призупинення — позначку на ліміті (debt / set) і
 * запит, повернутий «На погодження» з позначкою (req). Після переузгодження (позначку знято / запит погоджено) ліміт
 * повертається в `client_credit_limits`. 🧨 Червоніє, якщо SQL не передасть `suspended` у план або пропустить один із видів.
 */
test("#3362b 🪞 ДЗЕРКАЛО НАСКРІЗНО: позначка й повернутий запит знімають ліміт з дебіторки, переузгодження — повертає", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(SRC("db/schema.sql"));
    await c.query(`INSERT INTO receivables (client_key, client_name, amount) VALUES ('a', 'А', 1000), ('b', 'Б', 1000), ('c', 'В', 1000)`);
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note) VALUES ('b', 14, 50000, 'стара')`);
    await c.query(`INSERT INTO cp_requests (id, resident, code, name, kind, status, terms, flag, rates, created_by, created_by_name) VALUES
      (1, true, '41234567', 'В', 'ТОВ', 'pending', '{}', '{"what":"змінився власник"}', '{}', '2', 'Марина')`);
    await c.query(`INSERT INTO client_limits (id, src, request_id, debtor_key, name, limit_sum, days, count_from, manager_id, flag) VALUES
      (1, 'set', NULL, 'a', 'А', 100000, 10, 'inv', '2', NULL),
      (2, 'debt', NULL, 'b', 'Б', 50000, 14, 'inv', '2', '{"what":"нова справа"}'),
      (3, 'req', 1, 'c', 'В', 70000, 20, 'inv', '2', NULL)`);
    const { pool } = await import("../db/pool.js");
    const { mirrorToReceivables } = await import("./legacyLimits.js");
    const { receivablesDebtSource } = await import("./debtSourceDb.js");
    const debts = receivablesDebtSource(pool);
    const ccl = async () => Object.fromEntries((await c.query(`SELECT client_key, limit_days FROM client_credit_limits ORDER BY client_key`)).rows.map((r) => [r.client_key, r.limit_days]));

    await mirrorToReceivables(pool, debts);
    assert.deepEqual(await ccl(), { a: 10 }, "призупинений (позначка на ліміті / запит «На погодженні» з позначкою) лишився в дебіторці, або зник звичайний");
    await c.query(`UPDATE client_limits SET flag = NULL WHERE id = 2`);
    await c.query(`UPDATE cp_requests SET status = 'approved', flag = NULL WHERE id = 1`);
    await mirrorToReceivables(pool, debts);
    assert.deepEqual(await ccl(), { a: 10, b: 14, c: 20 }, "після переузгодження ліміт не повернувся в дебіторку");
  } finally {
    await c.end().catch(() => undefined);
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
  }
});
