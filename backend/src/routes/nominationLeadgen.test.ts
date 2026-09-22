import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #662 — ЛІДОГЕНЕРАТОРИ Й КОНВЕРСІЯ РНК ПРОТИ БАЗИ З НУЛЯ (22.09.2026, слайди 4–5 Даші).
 * Лідогенератори: «прорахунки» — з CRM (Продзвін → «Кваліфіковано»); зазор — лише свої дані: тімлід лідогену
 * вносить про іншого, про себе — ні, тімлід РНК — ні; знімок фіксує 'lg'. Конверсія РНК: керівництво правит будь-
 * який рядок і пише коментар; тімлід РНК — лише свою команду; тімлід РПК таблиці не бачить і не правит; «Як у CRM»
 * повертає число; CHECK не пускає успіх > ліди; правки лише дописуються.
 */
test("#662 ДИМ: лідогенератори (прорахунки з CRM, зазор — свої дані) і конверсія РНК (правки, межі) — проти бази з нуля", async (t) => {
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
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (302,'Тімлід лідогену',11,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'),
        (3,'lead@uts.ua','x','team_lead',103,13,'Тімлід РНК'),
        (4,'lg@uts.ua','x','team_lead',302,11,'Тімлід лідогену'),
        (5,'rpk@uts.ua','x','team_lead',201,5,'Тімлід РПК')`);
    // Лідогенерація: входи в «Кваліфіковано» (142) воронки Продзвону 8921936 — прорахунки тижня (301 → 2, 302 → 1).
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo) VALUES
        (901,301,8921936,142,0,'2026-09-10'),(902,301,8921936,142,0,'2026-09-10'),(903,302,8921936,142,0,'2026-09-10')`);
    await c.query(`INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at) VALUES
        (901,142,8921936,'2026-09-15T10:00Z'),(902,142,8921936,'2026-09-16T10:00Z'),(903,142,8921936,'2026-09-17T10:00Z')`);
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
      lg: { userId: 4, role: "team_lead", roleKey: "team_lead", managerId: 302, teamId: 11 },
      rpk: { userId: 5, role: "team_lead", roleKey: "team_lead", managerId: 201, teamId: 5 },
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
    const q = { weekFrom: WEEK };

    // ── Лідогенератори: прорахунки з CRM; зазор система не пропонує.
    const a = await call("GET", "/week", { query: q });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const lg = a.body.leadgen;
    assert.ok(lg, "🔴 керівництво не бачить рейтингу лідогенераторів");
    const lgCell = (b: any, k: string) => b.leadgen.cells.find((c: any) => c.nomination === k);
    assert.deepEqual(lgCell(a.body, "lgQuotes").crm, { state: "ok", value: 2, winners: [301] }, "🔴 прорахунки не з CRM");
    assert.deepEqual(lgCell(a.body, "lgMaxDeal").crm, { state: "empty" }, "🔴 система вдає зазор лідогенератора, якого в CRM немає");
    assert.ok(a.body.leadgenDefs.find((d: any) => d.key === "lgMaxDeal").noCrm);
    assert.equal(a.body.teams.some((x: any) => x.teamId === 11), false, "🔴 лідоген потрапив у звичайні команди (і в переможців відділу)");

    // Тімлід лідогену: бачить лише лідогенераторів; вносить про іншого — так, про себе — ні. Тімлід РНК — ні.
    const g = await call("GET", "/week", { who: "lg", query: q });
    assert.deepEqual([g.body.teams.length, !!g.body.leadgen, g.body.rnkConv], [0, true, null], "🔴 тімлід лідогену бачить не своє");
    const own = (who: string, ids: number[]) => call("POST", "/review", { who, body: { weekFrom: WEEK, teamId: 11, nomination: "lgMaxDeal", action: "override", overrideManagerIds: ids, overrideValue: 15000, reason: "з таблиці лідгену" } });
    assert.equal((await own("lg", [302])).status, 403, "🔴 тімлід лідогену вніс зазор про себе");
    assert.equal((await own("lead", [301])).status, 403, "🔴 тімлід РНК вніс дані лідогенераторів");
    const ok = await own("lg", [301]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([lgCell(ok.body, "lgMaxDeal").final.status, lgCell(ok.body, "lgMaxDeal").final.value], ["overridden", 15000]);
    assert.equal((await call("POST", "/review", { who: "lg", body: { weekFrom: WEEK, teamId: 11, nomination: "cars", action: "confirm" } })).status, 400, "🔴 у лідогену номінація менеджерів");

    // ── Конверсія РНК: межі й правки.
    assert.equal(a.body.rnkConv.canComment, true);
    const rows13 = (await call("GET", "/week", { who: "lead", query: q })).body.rnkConv.rows;
    assert.ok(rows13.length > 0 && rows13.every((r: any) => r.teamId === 13), "🔴 тімлід РНК бачить чужі рядки конверсії");
    assert.equal((await call("GET", "/week", { who: "rpk", query: q })).body.rnkConv, null, "🔴 тімлід РПК бачить конверсію РНК");
    const conv = (who: string, body: object) => call("POST", "/rnk-conv", { who, body: { weekFrom: WEEK, ...body } });
    assert.equal((await conv("rpk", { action: "set", managerId: 101, taken: 24, won: 4, onSlide: true })).status, 403, "🔴 тімлід РПК правит конверсію РНК");
    assert.equal((await conv("lead", { action: "comment", comment: "x" })).status, 403, "🔴 коментар пише не керівництво");
    const s1 = await conv("lead", { action: "set", managerId: 101, taken: 24, won: 4, onSlide: true });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const r101 = s1.body.rnkConv.rows.find((r: any) => r.managerId === 101);
    assert.deepEqual([r101.taken, r101.won, r101.pct, r101.onSlide, r101.own.by], [24, 4, 16.67, true, "Тімлід РНК"], "🔴 правка тімліда не лягла");
    const cm = await conv("admin", { action: "comment", comment: "реклама зросла" });
    assert.equal(cm.body.rnkConv.comment.text, "реклама зросла");
    const rs = await conv("admin", { action: "reset", managerId: 101 });
    const b101 = rs.body.rnkConv.rows.find((r: any) => r.managerId === 101);
    assert.deepEqual([b101.taken, b101.won, b101.own], [b101.crm.taken, b101.crm.won, null], "🔴 «Як у CRM» не повернуло число");
    await assert.rejects(() => c.query(`INSERT INTO nomination_conv_edits (week_from,manager_id,action,taken,won,on_slide) VALUES ('2026-09-14',101,'set',3,4,true)`), /check/i, "🔴 БД прийняла успіх > ліди");
    await assert.rejects(() => c.query(`UPDATE nomination_conv_edits SET taken = 1`), /заборонено/, "🔴 правки конверсії переписуються");

    // ── Фіксація: лідогенератори в знімку (dept 'lg'), зі своїми даними.
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T06:00:00Z")), "frozen");
    const fz = await frozenWeek(WEEK);
    const fzMax = fz!.leadgen!.cells.find((x) => x.nomination === "lgMaxDeal")!;
    assert.deepEqual([fzMax.final.status, fzMax.final.value, fzMax.final.winners], ["overridden", 15000, [301]], "🔴 знімок загубив дані лідогенераторів");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
