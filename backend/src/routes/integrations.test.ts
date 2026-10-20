import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { trackerPeriodError } from "../core/vacationRules.js";

const KEY = "test-vacations-key";
const SSO = "test-sso-key";

/**
 * #1807 🪞 — ВІДПУСТКИ ДЛЯ ТАЙМ-ТРЕКЕРА (5149, етап 3), через роут на порожньому кластері.
 * Межа: без ключа, з SSO-ключем замість свого, з чужим ключем → 401; ключа в .env немає → 503. Дзеркало: свій ключ → 200.
 * Зміст: рівно погоджені відпустки, що перетинають період, з ПОВНИМИ датами (не обрізаними); людина — id акаунта,
 * зокрема для рядка, записаного лише з manager_id; вимкнений акаунт — так (історія); лікарняний, «на погодженні»,
 * людина без акаунта й відпустка поза періодом — ні. Формат — обгортка `{ vacations: [...] }`.
 * Червоніє, якщо прибрати перевірку ключа, прийняти SSO-ключ, віддати непогоджене/не-відпустку, обрізати дати
 * або загубити рядок без user_id.
 */
test("#1807 🪞 ТРЕКЕР · ВІДПУСТКИ: свій ключ — погоджені відпустки періоду з повними датами; без ключа чи з SSO — 401", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  process.env.TRACKER_VACATIONS_KEY = KEY;
  process.env.TRACKER_SSO_KEY = SSO;
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  let server: import("node:http").Server | null = null;
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id, name) VALUES (13, 'РНК - Тест') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id, name, team_id, is_active, kommo_user_id) VALUES
      (101, 'Перша', 13, true, '101'), (102, 'Друга', 13, true, '102'), (103, 'Без акаунта', 13, true, '103'), (104, 'Звільнена', 13, false, '104')`);
    await c.query(`INSERT INTO users (id, email, password_hash, role, manager_id, team_id, is_active) VALUES
      (8, 'first@uts.ua', 'x', 'manager', 101, 13, true), (9, 'second@uts.ua', 'x', 'manager', 102, 13, true),
      (10, 'gone@uts.ua', 'x', 'manager', 104, 13, false)`);
    await c.query(`INSERT INTO team_calendar_absences (manager_id, user_id, team_id, kind, start_date, end_date, status) VALUES
      (101, 8,    13, 'vacation', '2026-09-28', '2026-10-02', 'approved'),  -- перетинає початок періоду: дати повні
      (102, NULL, 13, 'vacation', '2026-10-12', '2026-10-16', 'approved'),  -- лише manager_id: людина через users.manager_id
      (104, 10,   13, 'vacation', '2026-10-20', '2026-10-24', 'approved'),  -- вимкнений акаунт: історія лишається
      (101, 8,    13, 'sick',     '2026-10-05', '2026-10-07', 'approved'),  -- не відпустка
      (102, 9,    13, 'vacation', '2026-10-26', '2026-10-30', 'pending'),   -- не погоджена
      (103, NULL, 13, 'vacation', '2026-10-05', '2026-10-09', 'approved'),  -- без акаунта
      (101, 8,    13, 'vacation', '2026-09-01', '2026-09-05', 'approved')   -- поза періодом`);

    const { default: express } = await import("express");
    const { integrationsRouter } = await import("./integrations.js");
    const app = express();
    app.use(express.json());
    app.use("/api/integrations", integrationsRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/integrations/tracker/vacations`;
    const get = async (qs: string, key?: string) => {
      const r = await fetch(base + qs, { headers: key ? { "X-Tracker-Vacations-Key": key } : {} });
      return { status: r.status, body: await r.json() as any };
    };
    const OCT = "?from=2026-10-01&to=2026-10-31";

    assert.equal((await get(OCT)).status, 401, "без ключа віддано відпустки");
    assert.equal((await get(OCT, SSO)).status, 401, "SSO-ключ відкриває відпустки — ключі мусять бути окремі");
    assert.equal((await get(OCT, KEY + "x")).status, 401, "чужий ключ прийнято");
    assert.equal((await get("?from=2026-10-31&to=2026-10-01", KEY)).status, 400, "період задом наперед прийнято");
    assert.equal((await get("?from=2026-01-01&to=2027-01-02", KEY)).status, 400, "період довший за рік прийнято");
    assert.equal((await get("?from=2026-02-30&to=2026-03-01", KEY)).status, 400, "неіснуючу дату прийнято");

    const ok = await get(OCT, KEY);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { vacations: [
      { dashboardUserId: 8, email: "first@uts.ua", from: "2026-09-28", until: "2026-10-02", type: "vacation" },
      { dashboardUserId: 9, email: "second@uts.ua", from: "2026-10-12", until: "2026-10-16", type: "vacation" },
      { dashboardUserId: 10, email: "gone@uts.ua", from: "2026-10-20", until: "2026-10-24", type: "vacation" },
    ] }, "склад або формат відпусток для трекера не той");

    // Ключа в .env немає → 503, а не відкритий запит.
    const { config } = await import("../config.js");
    const saved = config.tracker.vacationsKey;
    config.tracker.vacationsKey = "";
    try {
      assert.equal((await get(OCT, KEY)).status, 503, "без налаштованого ключа запит не відповідає 503");
      assert.equal((await get(OCT, "")).status, 503);
    } finally { config.tracker.vacationsKey = saved; }
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/** #1807b — ПЕРІОД ЗАПИТУ: межі по обидва боки (рік = 366 днів — так, 367 — ні; той самий день — так; формат). */
test("#1807b ТРЕКЕР · ВІДПУСТКИ: період — справжні дати, from ≤ to, не довше 366 днів", () => {
  assert.equal(trackerPeriodError("2026-10-01", "2026-10-01"), null, "один день — законний період");
  assert.equal(trackerPeriodError("2026-01-01", "2027-01-01"), null, "366 днів — у межах");
  assert.match(trackerPeriodError("2026-01-01", "2027-01-02") ?? "", /366/, "367 днів пройшло");
  assert.match(trackerPeriodError("2026-10-02", "2026-10-01") ?? "", /пізніше/);
  for (const bad of ["2026-02-30", "2026-13-01", "01.10.2026", "", undefined, ["2026-10-01"]]) {
    assert.ok(trackerPeriodError(bad, "2026-10-31"), `прийнято «${String(bad)}» як дату`);
  }
});
