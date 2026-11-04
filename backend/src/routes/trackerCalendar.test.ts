import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

// Окремий файл від `integrations.test.ts` свідомо: `#1807` там закриває спільний `pool`, а роут календаря ходить через нього ж.
const KEY = "test-vacations-key";
const SSO = "test-sso-key";

/** Приклад для трекера — він же очікувана відповідь `#3352`/`#3352b` (`docs/TRACKER_CALENDAR_API.md`). */
const CALENDAR_FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "docs", "tracker-calendar.example.json");

/**
 * #3352 🪞 — КАЛЕНДАР ДЛЯ ТАЙМ-ТРЕКЕРА (04.11.2026), через роут на порожньому кластері.
 * Межа — той самий ключ, що й `vacations`: без ключа, з SSO-ключем, з чужим → 401; поганий період → 400; ключа в .env
 * немає → 503. Зміст — рівно фікстура для трекера: усі чотири kind, три shift, approved і pending зі `status`,
 * звільнений з `active:false`, відпустка через межу періоду з повними датами, email у нижньому регістрі, рядок лише
 * з manager_id — через акаунт. НЕ потрапляють: відхилена, людина без акаунта, поза періодом (і чергування, і свято).
 * Червоніє, якщо віддати rejected, загубити pending, обрізати дати, втратити `until` вечора, віддати hours не
 * скороченому дню, сховати звільненого або прийняти SSO-ключ.
 */
test("#3352 🪞 ТРЕКЕР · КАЛЕНДАР: свій ключ — відсутності (approved і pending), чергування й свята періоду рівно як у фікстурі", async (t) => {
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
      (8, 'first@uts.ua', 'x', 'manager', 101, 13, true), (9, 'Second@UTS.ua', 'x', 'manager', 102, 13, true),
      (10, 'gone@uts.ua', 'x', 'manager', 104, 13, false)`);
    await c.query(`INSERT INTO team_calendar_absences (id, manager_id, user_id, team_id, kind, start_date, end_date, hours, status) VALUES
      (51, 101, 8,    13, 'vacation',  '2026-09-28', '2026-10-02', NULL, 'approved'),  -- через початок періоду: дати повні
      (52, 102, NULL, 13, 'sick',      '2026-10-05', '2026-10-07', NULL, 'approved'),  -- лише manager_id → акаунт 9
      (53, 101, 8,    13, 'day_off',   '2026-10-09', '2026-10-09', 2,    'approved'),  -- години не скороченому дню → null
      (54, 102, 9,    13, 'short_day', '2026-10-14', '2026-10-14', 3,    'pending'),   -- на погодженні: так, зі status
      (55, 101, 8,    13, 'day_off',   '2026-10-15', '2026-10-15', NULL, 'rejected'),  -- відхилена: ні
      (56, 104, 10,   13, 'vacation',  '2026-10-20', '2026-10-24', NULL, 'approved'),  -- звільнена: active=false
      (57, 103, NULL, 13, 'day_off',   '2026-10-21', '2026-10-21', NULL, 'approved'),  -- без акаунта: ні
      (58, 101, 8,    13, 'vacation',  '2026-09-01', '2026-09-05', NULL, 'approved')   -- поза періодом: ні`);
    await c.query(`INSERT INTO duty_schedule (id, duty_date, manager_id, team_id, shift) VALUES
      (77, '2026-10-03', 101, 13, 'day'),      -- субота зміною day: так і віддаємо
      (78, '2026-10-06', 102, 13, 'evening'),  -- until 21:00
      (79, '2026-10-11', 104, 13, 'weekend'),  -- звільнена: active=false
      (80, '2026-10-07', 103, 13, 'day'),      -- без акаунта: ні
      (81, '2026-11-01', 101, 13, 'day')       -- поза періодом: ні`);
    await c.query(`INSERT INTO company_holidays (holiday_date, name) VALUES
      ('2026-10-14', 'День захисників і захисниць'), ('2026-12-25', 'Різдво')`);

    const { default: express } = await import("express");
    const { integrationsRouter } = await import("./integrations.js");
    const app = express();
    app.use(express.json());
    app.use("/api/integrations", integrationsRouter);
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${(server!.address() as import("node:net").AddressInfo).port}/api/integrations/tracker/calendar`;
    const get = async (qs: string, key?: string) => {
      const r = await fetch(base + qs, { headers: key ? { "X-Tracker-Vacations-Key": key } : {} });
      return { status: r.status, body: await r.json() as any };
    };
    const OCT = "?from=2026-10-01&to=2026-10-31";

    assert.equal((await get(OCT)).status, 401, "без ключа віддано календар");
    assert.equal((await get(OCT, SSO)).status, 401, "SSO-ключ відкриває календар — ключі мусять бути окремі");
    assert.equal((await get(OCT, KEY + "x")).status, 401, "чужий ключ прийнято");
    assert.equal((await get("?from=2026-10-31&to=2026-10-01", KEY)).status, 400, "період задом наперед прийнято");
    assert.equal((await get("?from=2026-01-01&to=2027-01-02", KEY)).status, 400, "період довший за рік прийнято");

    const ok = await get(OCT, KEY);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, JSON.parse(readFileSync(CALENDAR_FIXTURE, "utf8")), "календар для трекера розійшовся з фікстурою");

    const { config } = await import("../config.js");
    const saved = config.tracker.vacationsKey;
    config.tracker.vacationsKey = "";
    try {
      assert.equal((await get(OCT, KEY)).status, 503, "без налаштованого ключа запит не відповідає 503");
    } finally { config.tracker.vacationsKey = saved; }
  } finally {
    if (server) await new Promise((r) => server!.close(r));
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

/**
 * #3352b — КОНТРАКТ: рядки бази → відповідь трекеру, БАЙТ У БАЙТ як файл-приклад, який отримує трекер. Без бази,
 * тож біжить і в `test:prod`. Межі по обидва боки: години — лише скороченому дню (у day_off вони є в рядку, але не
 * у відповіді), `until` — лише вечірній зміні (day і weekend → null), звільнений — `active:false`.
 * Червоніє, якщо перейменувати, переставити чи додати поле, або порушити будь-яку з цих меж.
 */
test("#3352b ТРЕКЕР · КАЛЕНДАР: контракт — відповідь байт у байт як приклад для трекера; hours лише скороченому, until лише вечору", async () => {
  const { trackerCalendarFrom } = await import("../core/trackerCalendar.js");
  const A = (id: number, user_id: number, email: string, kind: string, status: string, from_date: string, until_date: string, hours: string | null, is_active = true) =>
    ({ id, user_id, email, is_active, kind, status, from_date, until_date, hours });
  const D = (id: number, user_id: number, email: string, duty_date: string, shift: string, is_active = true) => ({ id, user_id, email, is_active, duty_date, shift });
  const out = trackerCalendarFrom([
    A(51, 8, "first@uts.ua", "vacation", "approved", "2026-09-28", "2026-10-02", null),
    A(52, 9, "second@uts.ua", "sick", "approved", "2026-10-05", "2026-10-07", null),
    A(53, 8, "first@uts.ua", "day_off", "approved", "2026-10-09", "2026-10-09", "2"),
    A(54, 9, "second@uts.ua", "short_day", "pending", "2026-10-14", "2026-10-14", "3"),
    A(56, 10, "gone@uts.ua", "vacation", "approved", "2026-10-20", "2026-10-24", null, false),
  ], [
    D(77, 8, "first@uts.ua", "2026-10-03", "day"),
    D(78, 9, "second@uts.ua", "2026-10-06", "evening"),
    D(79, 10, "gone@uts.ua", "2026-10-11", "weekend", false),
  ], [{ holiday_date: "2026-10-14", name: "День захисників і захисниць" }]);
  assert.equal(JSON.stringify(out, null, 2) + "\n", readFileSync(CALENDAR_FIXTURE, "utf8"), "відповідь трекеру розійшлась із файлом-прикладом");
  assert.deepEqual(new Set(out.absences.map((a) => a.kind)), new Set(["vacation", "sick", "day_off", "short_day"]), "у прикладі не всі kind");
  assert.deepEqual(new Set(out.duty.map((d) => d.shift)), new Set(["day", "evening", "weekend"]), "у прикладі не всі shift");
});
