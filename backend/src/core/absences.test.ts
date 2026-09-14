import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsBackendEnv } from "../testMode.js";
import { skipReason } from "../db/scratchDb.js";
import { calendarAccountsSql, absencesSql, isMine, ownScopeSql, resolveOwner } from "./absences.js";

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/**
 * #394 — ВЛАСНИК ВІДСУТНОСТІ ЗВОДИТЬСЯ ДО ДВОХ КЛЮЧІВ, і ручний акаунт без менеджера —
 * повноправний власник. Чиста частина: розвʼязання власника й «моє / не моє».
 * Червоніє, якщо `resolveOwner` знов вимагатиме менеджера або `isMine` дивитиметься лише
 * на `manager_id` (тоді Дарʼя не бачила б власних відміток як своїх).
 */
test("#394 ВЛАСНИК ВІДСУТНОСТІ: акаунт без менеджера — власник; «моє» — по будь-якому з двох ключів", () => {
  // Дарʼя: акаунт є, менеджера немає.
  assert.deepEqual(resolveOwner({ byUser: { user_id: 52, manager_id: null, team_id: null }, byManager: null }),
    { userId: 52, managerId: null, teamId: null });
  // Менеджер з акаунтом: обидва ключі.
  assert.deepEqual(resolveOwner({ byUser: { user_id: 7, manager_id: 104, team_id: 15 }, byManager: null }),
    { userId: 7, managerId: 104, teamId: 15 });
  // Стара збірка шле managerId; менеджер без акаунта → user_id NULL, manager_id є.
  assert.deepEqual(resolveOwner({ byUser: null, byManager: { manager_id: 33, user_id: null, team_id: 5 } }),
    { userId: null, managerId: 33, teamId: 5 });
  assert.equal(resolveOwner({ byUser: null, byManager: null }), null);

  const auth = { managerId: null, userId: 52 };
  assert.equal(isMine({ manager_id: null, user_id: 52 }, auth), true, "ручний акаунт мусить бачити свою відмітку як свою");
  assert.equal(isMine({ manager_id: 104, user_id: 7 }, auth), false);
  assert.equal(isMine({ manager_id: 104, user_id: null }, { managerId: 104, userId: 9 }), true, "історичний рядок без user_id лишається «моїм» для менеджера");
  // 🪞 NULL == NULL не має бути «моїм»: акаунт без менеджера проти рядка без менеджера.
  assert.equal(isMine({ manager_id: null, user_id: 60 }, auth), false);
  assert.match(ownScopeSql("a", 3, 4), /a\.manager_id = \$3 OR a\.user_id = \$4/);
});

/**
 * #394b 🪞 — НА ПОРОЖНЬОМУ КЛАСТЕРІ: схема з нуля дозволяє відсутність без менеджера, забороняє
 * без жодного власника, перелік акаунтів і календар бачать Дарʼю з імʼям із `full_name`,
 * і — дзеркало — відпустка МЕНЕДЖЕРА далі зменшує його робочі дні в планах.
 * Червоніє, якщо повернути NOT NULL на manager_id, зняти CHECK, або джойнити календар
 * лише на `managers` (Дарʼя зникне з переліку).
 */
test("#394b 🪞 СХЕМА З НУЛЯ: ручний акаунт ставить відпустку, CHECK тримає власника, плани менеджера не зрушили", async (t) => {
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
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (15,'РНК - Михальчевської') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active,kommo_user_id) VALUES (104,'Михальчевська Дарина',15,true,'104') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id) VALUES (7,'mdo@uts.ua','x','team_lead',104,15)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,full_name) VALUES (52,'utservice62@gmail.com','x','admin','Дарʼя Протас')`);

    // Дарʼя: user_id є, manager_id NULL — рядок приймається.
    await c.query(`INSERT INTO team_calendar_absences (manager_id,user_id,team_id,kind,start_date,end_date,status)
                   VALUES (NULL,52,NULL,'vacation','2026-09-14','2026-09-18','approved')`);
    // Без жодного власника — CHECK мусить відмовити.
    await assert.rejects(
      c.query(`INSERT INTO team_calendar_absences (manager_id,user_id,kind,start_date,end_date) VALUES (NULL,NULL,'day_off','2026-09-14','2026-09-14')`),
      /absence_has_owner/, "рядок без власника пройшов — CHECK знято");

    // Перелік акаунтів (адмін, без фільтра команди): обидві, Дарʼя з full_name.
    const acc = await c.query<{ user_id: number; manager_id: number | null; name: string }>(calendarAccountsSql([]));
    const names = acc.rows.map((r) => r.name);
    assert.ok(names.includes("Дарʼя Протас"), `Дарʼї немає в переліку: ${names.join(", ")}`);
    assert.ok(names.includes("Михальчевська Дарина"));
    assert.equal(acc.rows.find((r) => r.user_id === 52)?.manager_id, null);

    // Календар: рядок Дарʼї повертається з імʼям власника (LEFT JOIN, не JOIN).
    const abs = await c.query<{ owner_name: string; manager_id: number | null; user_id: number | null }>(absencesSql(""), ["2026-09-01", "2026-09-30"]);
    assert.equal(abs.rows.length, 1);
    assert.equal(abs.rows[0].owner_name, "Дарʼя Протас");
    assert.equal(abs.rows[0].user_id, 52);

    // 🪞 Дзеркало: відпустка МЕНЕДЖЕРА з обома ключами далі зменшує робочі дні плану.
    await c.query(`INSERT INTO team_calendar_absences (manager_id,user_id,team_id,kind,start_date,end_date,status)
                   VALUES (104,7,15,'vacation','2026-09-14','2026-09-18','approved')`);
    const { presentWorkingDaysByManager } = await import("./plans.js");
    const days = await presentWorkingDaysByManager([104], "2026-09-01", "2026-09-30");
    // Вересень 2026: 22 будні (без свят у порожній базі) мінус 5 днів відпустки = 17.
    assert.equal(days.get(104), 17, "відпустка менеджера перестала зменшувати робочі дні плану");
    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #394c — СКОУП ТІМЛІДА НЕ БАЧИТЬ БЕЗКОМАНДНИХ. Умова команди `a.team_id = $3` на рядку з
 * `team_id NULL` хибна, тож відпустка Дарʼї не потрапляє в календар тімліда й у його
 * погодження — безкомандних погоджує адмін. Червоніє, якщо скоуп тімліда розширити
 * (наприклад `team_id IS NULL OR …`).
 */
test("#394c СКОУП ТІМЛІДА: безкомандний акаунт не потрапляє в календар команди", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (15,'РНК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,full_name) VALUES (52,'d@x','x','admin','Дарʼя Протас')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active,kommo_user_id) VALUES (104,'Тімлід',15,true,'104')`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id) VALUES (7,'t@x','x','team_lead',104,15)`);
    await c.query(`INSERT INTO team_calendar_absences (user_id,team_id,kind,start_date,end_date) VALUES (52,NULL,'vacation','2026-09-14','2026-09-18')`);
    await c.query(`INSERT INTO team_calendar_absences (manager_id,user_id,team_id,kind,start_date,end_date) VALUES (104,7,15,'day_off','2026-09-15','2026-09-15')`);
    const team = await c.query(absencesSql(" AND a.team_id = $3"), ["2026-09-01", "2026-09-30", 15]);
    assert.equal(team.rows.length, 1, "тімлід побачив безкомандну відсутність");
    assert.equal(team.rows[0].manager_id, 104);
    const all = await c.query(absencesSql(""), ["2026-09-01", "2026-09-30"]);
    assert.equal(all.rows.length, 2, "🪞 адмін мусить бачити обидві");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #394d ЖИВИЙ — БЕКФІЛ ВІДПРАЦЮВАВ: у проді не лишилось рядка з `user_id NULL`, чий менеджер
 * має активний акаунт. Стереже дані, а не код: гейти вище зелені й до міграції на проді.
 * Червоніє, якщо міграцію не застосували або бекфіл не покрив усі рядки.
 */
test("#394d ЖИВИЙ: рядків без user_id при наявному акаунті менеджера — нуль",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { rows: [r] } = await pool.query<{ orphans: number; total: number }>(`
    SELECT count(*) FILTER (WHERE a.user_id IS NULL AND u.id IS NOT NULL)::int AS orphans, count(*)::int AS total
      FROM team_calendar_absences a LEFT JOIN users u ON u.manager_id = a.manager_id AND u.is_active`);
  assert.ok(r.total > 0, "простір порожній — перевірці нема що знаходити");
  assert.equal(r.orphans, 0, `${r.orphans} із ${r.total} рядків без user_id, хоча акаунт менеджера є — бекфіл не відпрацював`);
});
