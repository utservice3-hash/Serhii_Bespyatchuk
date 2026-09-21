import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #604 — НОМІНАЦІЇ ПРОТИ БАЗИ З НУЛЯ: обробники ВИКОНУЮТЬСЯ, знімок НЕЗМІННИЙ після фіксації.
 *
 * 🔴 НАВІЩО. SQL у шаблонному рядку не типізується, а числа номінацій ідуть через три функції
 * ядра й ростер — тож прогін на справжній схемі єдиний, що доводить, що вони взагалі
 * виконуються. І головне твердження задачі — «знімок, знятий у вівторок, у четвер показує тих
 * самих переможців» — перевіряється тут ДІЄЮ: після фіксації CRM змінюється, а відповідь ні.
 *
 * 🧨 Червоніє від: помилки в SQL; межі київської доби (угода о 00:30 пн не в тижні); нічиєї, що
 * загубила когось; тімліда, що підтвердив чужу команду чи рядок про себе; виправлення без причини;
 * фіксації до вівторка 08:00; другої фіксації, що щось змінила; UPDATE/DELETE знімка.
 */
test("#604 ДИМ: номінації тижня проти бази з нуля — межі, рішення тімліда, фіксація й незмінність знімка", async (t) => {
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
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
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
    const { freezeWeek } = await import("../core/nominations.js");
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

    // ── чернетка: числа з ядра, межі тижня, нічия, порожньо ──
    const a = await call("GET", "/week", { query: { weekFrom: WEEK } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.state, "draft");
    assert.deepEqual(a.body.teams.map((x: any) => x.teamId).sort((p: number, q: number) => p - q), [5, 13], "🔴 у залік потрапив лідоген або зникла команда");
    assert.ok(!a.body.teams.find((x: any) => x.teamId === 13).members.some((m: any) => m.id === 104), "🔴 звільнена змагається");
    assert.deepEqual(cell(a.body, 13, "revenue").crm, { state: "ok", value: 50000, winners: [103] });
    assert.deepEqual(cell(a.body, 13, "maxDeal").crm, { state: "ok", value: 50000, winners: [103] });
    assert.deepEqual(cell(a.body, 13, "cars").crm, { state: "ok", value: 2, winners: [101, 102] }, "🔴 нічия загубила переможця");
    assert.deepEqual(cell(a.body, 13, "marginPct").crm, { state: "ok", value: 1200, winners: [101] });
    assert.deepEqual(cell(a.body, 13, "marginPct").deal, { id: 2, price: 12000, cost: 1000 });
    assert.deepEqual(cell(a.body, 13, "intl").crm, { state: "ok", value: 1, winners: [101] });
    // Нд 23:30 Києва — у тижні; пн 00:30 Києва — ні (угода на 99 999 не має перемогти).
    assert.deepEqual(cell(a.body, 5, "revenue").crm, { state: "ok", value: 777, winners: [202] }, "🔴 межа київської доби зсунулась");
    assert.deepEqual(cell(a.body, 5, "cars").crm, { state: "empty" }, "🔴 порожня номінація мусить бути порожньою, а не «0»");
    assert.equal(a.body.teams.find((x: any) => x.teamId === 13).noCostDeals, 1, "🔴 угоди без «Расходу 1» не пораховані");

    // ── межі: хто бачить і хто підтверджує ──
    const l = await call("GET", "/week", { who: "lead", query: { weekFrom: WEEK } });
    assert.deepEqual(l.body.teams.map((x: any) => x.teamId), [13], "🔴 тімлід бачить чужу команду");
    assert.equal(cell(l.body, 13, "revenue").canReview, false, "🔴 тімлід може підтвердити рядок про себе");
    assert.equal(cell(l.body, 13, "cars").canReview, true);
    assert.equal((await call("GET", "/week", { who: "mgr", query: { weekFrom: WEEK } })).status, 403, "🔴 менеджер бачить номінації тижня");
    const conf = (who: string, team: number, n: string) => call("POST", "/review", { who, body: { weekFrom: WEEK, teamId: team, nomination: n, action: "confirm" } });
    assert.equal((await conf("lead", 5, "revenue")).status, 403, "🔴 тімлід підтвердив чужу команду");
    assert.equal((await conf("lead", 13, "revenue")).status, 403, "🔴 тімлід підтвердив рядок про себе");
    const ok = await conf("lead", 13, "cars");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(cell(ok.body, 13, "cars").final.status, "confirmed");
    assert.equal((await conf("admin", 13, "revenue")).status, 200, "🔴 керівництво не може підтвердити рядок тімліда");
    const noReason = await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, nomination: "intl", action: "override", overrideManagerIds: [102], overrideValue: 2 } });
    assert.equal(noReason.status, 400, "🔴 виправлення без причини прийнято");
    const ov = await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, nomination: "intl", action: "override", overrideManagerIds: [102], overrideValue: 2, reason: "в CRM не вказано тип запиту" } });
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    assert.deepEqual([cell(ov.body, 13, "intl").final.status, cell(ov.body, 13, "intl").final.winners], ["overridden", [102]]);

    // ── підтвердження протухає, коли CRM змінився ──
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,load_at) VALUES (11,101,8921932,69716300,1,'2026-09-10','2026-09-19T08:00Z')`);
    const moved = cell((await call("GET", "/week", { query: { weekFrom: WEEK } })).body, 13, "cars");
    assert.deepEqual([moved.final.status, moved.final.stale, moved.crm.winners], ["unconfirmed", true, [101]],
      "🔴 підтвердження пережило зміну CRM — тімлід «підтвердив» те, чого не бачив");
    assert.equal((await conf("lead", 13, "cars")).status, 200);

    // ── фіксація: не раніше вівторка 08:00, один раз, і далі нічого не рухається ──
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T04:59:00Z")), "not-due", "🔴 зафіксовано до вівторка 08:00");
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T05:00:00Z")), "frozen");
    const before = (await call("GET", "/week", { query: { weekFrom: WEEK } })).body;
    assert.equal(before.state, "frozen");
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T06:00:00Z")), "already", "🔴 друга фіксація не розпізнала першу");
    // «Четвер»: CRM змінився після фіксації — зафіксоване не рухається.
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,closed_at_kommo) VALUES (12,102,8921932,142,999999,'2026-09-10','2026-09-18T10:00Z')`);
    const after = (await call("GET", "/week", { query: { weekFrom: WEEK } })).body;
    assert.deepEqual(after.teams, before.teams, "🔴 зафіксований тиждень змінився разом із CRM");
    assert.deepEqual(after.depts, before.depts);
    assert.deepEqual([cell(after, 13, "intl").final.status, cell(after, 13, "intl").final.winners, cell(after, 13, "intl").crm.winners, cell(after, 13, "intl").final.reason],
      ["overridden", [102], [101], "в CRM не вказано тип запиту"], "🔴 знімок втратив число CRM або причину виправлення");
    assert.deepEqual(cell(after, 13, "cars").final.winners, [101]);
    assert.equal((await conf("admin", 13, "maxDeal")).status, 409, "🔴 рішення прийнято після фіксації");
    for (const sql of [`UPDATE nomination_snapshot SET value = 1`, `DELETE FROM nomination_snapshot`, `UPDATE nomination_weeks SET rule_version = 'x'`,
      `DELETE FROM nomination_weeks`, `UPDATE nomination_reviews SET reason = 'x'`]) {
      await assert.rejects(() => c.query(sql), /зафіксоване не змінюється/, `🔴 БД дозволила: ${sql}`);
    }
    // 🪞 Дзеркало тригера: наступний тиждень фіксується нормально (тригер не блокує ВСЕ підряд).
    assert.equal(await freezeWeek("2026-09-21", new Date("2026-09-29T06:00:00Z")), "frozen");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});

