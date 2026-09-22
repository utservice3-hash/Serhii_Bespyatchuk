import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #657 — ЗРУЧНА ВКЛАДКА ПРОТИ БАЗИ З НУЛЯ (22.09.2026): «Погодитись з рештою», «Скасувати», хто вирішив,
 * рейтинг у знімку. Та сама фікстура, що #604 (тімлід 103 сам виграє «результат» і «зазор»).
 * 🧨 Червоніє, якщо: масове погодження зачепить рядок про тімліда; «Скасувати» не поверне рядок у «чекає»;
 * CHECK не пустить `retract` (або пустить виправлення без причини); схема не накотиться вдруге; знімок
 * загубить рейтинг.
 */
test("#657 ДИМ: погодитись з рештою, скасувати, хто вирішив, рейтинг у знімку — проти бази з нуля", async (t) => {
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
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
    await c.query(schema);
    await c.query(schema); // міграцію CHECK накочують на кожному викаті — вона мусить бути ідемпотентною
    await c.query(`INSERT INTO teams (id,name) VALUES (13,'РНК - Тест'),(5,'РПК - Тест'),(11,'Лідоген')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES
        (101,'Андрусенко',13,true),(102,'Цалко',13,true),(103,'Тімлід РНК',13,true),
        (201,'Семенюк',5,true),(202,'Хомік',5,true),(301,'Лідогенератор',11,true),(104,'Звільнена',13,false)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'),
        (3,'lead@uts.ua','x','team_lead',103,13,'Тімлід РНК')`);
    // Угоди тижня 14–20.09.2026 (FC 8921932). 142 = «успішно реалізовано», 69716460 = «оплата отримана».
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,closed_at_kommo,load_at,request_type,carrier_obligation) VALUES
        (1,101,8921932,142,24580,'2026-09-10','2026-09-15T10:00Z','2026-09-14T08:00Z',NULL,5000),
        (2,101,8921932,142,12000,'2026-09-10','2026-09-16T10:00Z','2026-09-15T08:00Z','Міжнародні',1000),
        (3,102,8921932,142,30000,'2026-09-10','2026-09-17T10:00Z','2026-09-16T08:00Z',NULL,NULL),
        (4,102,8921932,69716300,5000,'2026-09-10',NULL,'2026-09-18T08:00Z',NULL,NULL),
        (5,103,8921932,142,50000,'2026-09-10','2026-09-19T10:00Z',NULL,NULL,49000),
        (6,201,8921932,142,99999,'2026-09-10','2026-09-20T21:30Z',NULL,NULL,NULL),
        (7,202,8921932,142,777,'2026-09-10','2026-09-20T20:30Z',NULL,NULL,NULL),
        (8,201,8921932,69716460,100,'2026-09-10',NULL,NULL,NULL,NULL),
        (9,301,8921932,142,88888,'2026-09-10','2026-09-16T10:00Z','2026-09-16T08:00Z',NULL,NULL),
        (10,104,8921932,142,77777,'2026-09-10','2026-09-16T10:00Z','2026-09-16T08:00Z',NULL,NULL)`);
    await c.query(`INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at) VALUES (8,69716460,8921932,'2026-09-16T10:00Z')`);

    const { nominationsRouter } = await import("./nominations.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { freezeWeek, frozenWeek } = await import("../core/nominations.js");
    await refreshRoles();

    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (nominationsRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const AUTH: Record<string, unknown> = {
      admin: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null },
      lead: { userId: 3, role: "team_lead", roleKey: "team_lead", managerId: 103, teamId: 13 },
      mgr: { userId: 0, role: "manager", roleKey: "manager", managerId: 101, teamId: 13 },
    };
    async function call(method: "GET" | "POST", p: string, o: { who?: string; query?: Record<string, string>; body?: unknown } = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p}`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as (req: unknown, res: unknown) => void;
      let status = 200;
      let body: any = undefined;
      await new Promise<void>((resolve) => {
        const res = {
          headersSent: false,
          status(s: number) { status = s; return res; },
          json(b: unknown) { body = b; res.headersSent = true; resolve(); return res; },
        };
        handler({ auth: AUTH[o.who ?? "admin"], query: o.query ?? {}, body: o.body ?? {}, params: {}, headers: {} }, res);
      });
      return { status, body };
    }
    const WEEK = "2026-09-14";
    const cell = (b: any, team: number, n: string) => b.teams.find((x: any) => x.teamId === team).cells.find((x: any) => x.nomination === n);

    // ── CHECK таблиці рішень: `retract` без полів — так; невідома дія і виправлення без причини — ні.
    await c.query(`INSERT INTO nomination_reviews (week_from,team_id,nomination,action,crm_fingerprint) VALUES ('2026-09-07',13,'cars','retract','x')`);
    await assert.rejects(() => c.query(`INSERT INTO nomination_reviews (week_from,team_id,nomination,action,crm_fingerprint) VALUES ('2026-09-07',13,'cars','undo','x')`), /check/i, "🔴 БД прийняла невідому дію");
    await assert.rejects(() => c.query(`INSERT INTO nomination_reviews (week_from,team_id,nomination,action,crm_fingerprint,override_manager_ids,override_value) VALUES ('2026-09-07',13,'cars','override','x','{101}',3)`), /check/i, "🔴 БД прийняла свої дані без причини");

    // ── «Погодитись з рештою» від тімліда: лише те, що чекає і що йому можна (не «результат» і «зазор» про нього).
    const b = await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, action: "confirm", nominations: ["maxDeal", "cars", "revenue", "marginPct", "intl"] } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual([...b.body.bulk.confirmed].sort(), ["cars", "intl", "marginPct"], "🔴 масове погодження зачепило рядок про тімліда або пропустило свій");
    assert.equal(cell(b.body, 13, "revenue").final.status, "unconfirmed", "🔴 рядок про тімліда погоджено ним самим");
    assert.equal(cell(b.body, 13, "cars").final.status, "confirmed");
    assert.equal(cell(b.body, 13, "cars").review.by, "Тімлід РНК", "🔴 не видно, хто погодив");
    assert.equal(b.body.viewer.managerId, 103, "🔴 екран не знає, хто «ви»");
    // Повтор — нічого нового (усе, що можна, уже погоджено).
    assert.deepEqual((await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, action: "confirm", nominations: ["cars"] } })).body.bulk.confirmed, []);

    // ── «Скасувати»: рядок знову чекає; скасовувати вдруге нічого — 409.
    const r = await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, nomination: "cars", action: "retract" } });
    assert.equal(cell(r.body, 13, "cars").final.status, "unconfirmed", "🔴 «Скасувати» не повернуло рядок у «чекає»");
    assert.equal((await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, nomination: "cars", action: "retract" } })).status, 409, "🔴 повторне скасування мало сказати, що нічого скасовувати");

    // ── Свої дані керівництва на рядку про тімліда → «Повернути пропозицію системи» = погодження CRM.
    const o = await call("POST", "/review", { body: { weekFrom: WEEK, teamId: 13, nomination: "revenue", action: "override", overrideManagerIds: [101], overrideValue: 40000, reason: "угода внесена після неділі" } });
    assert.equal(cell(o.body, 13, "revenue").final.status, "overridden");
    const back = await call("POST", "/review", { body: { weekFrom: WEEK, teamId: 13, nomination: "revenue", action: "confirm" } });
    assert.deepEqual([cell(back.body, 13, "revenue").final.status, cell(back.body, 13, "revenue").final.winners], ["confirmed", [103]], "🔴 «Повернути пропозицію» не повернуло CRM");

    // ── Рейтинг і тімліди в чернетці; той самий рейтинг — у знімку після фіксації.
    const a = await call("GET", "/week", { query: { weekFrom: WEEK } });
    const t13 = a.body.teams.find((x: any) => x.teamId === 13);
    assert.deepEqual(t13.leads, [{ managerId: 103, name: "Тімлід РНК" }], "🔴 керівництво не бачить, хто тімлід команди");
    assert.deepEqual(cell(a.body, 13, "cars").ranking.map((x: any) => x.managerId), [101, 102, 103], "🔴 рейтинг «авто» не той");
    const draftRanking = cell(a.body, 13, "marginPct").ranking;
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T06:00:00Z")), "frozen");
    const fz = await frozenWeek(WEEK);
    assert.deepEqual(fz!.teams.find((x) => x.teamId === 13)!.cells.find((x) => x.nomination === "marginPct")!.ranking, draftRanking, "🔴 знімок загубив рейтинг");
    assert.equal((await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, action: "confirm", nominations: ["cars"] } })).status, 409, "🔴 масове погодження пройшло в зафіксований тиждень");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
