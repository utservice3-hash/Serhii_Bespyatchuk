import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #666 — ЛІДОГЕНЕРАТОРИ Й КОНВЕРСІЯ РНК ПРОТИ БАЗИ З НУЛЯ (22.09.2026, слайди 4–5 Даші).
 * Лідогенератори: «прорахунки» — з CRM (Продзвін → «Кваліфіковано»), лише активні; зазор — лише свої дані: тімлід
 * лідогену вносить про іншого, про себе — ні, тімлід РНК — ні; ЖИВІ — правляться й після фіксації тижня.
 * Конверсія РНК: число CRM = «Конв. реклама» (лише рекламні угоди, створені в тижні); керівництво правит будь-який
 * рядок і пише коментар; тімлід РНК бачить і правит лише свою команду (друга команда РНК — поза його відповіддю);
 * тімлід РПК таблиці не бачить; «Як у CRM» повертає справжнє (ненульове) число; вибір «на слайд» — окремо від чисел.
 */
test("#666 ДИМ: лідогенератори (живі, дані тімліда) і конверсія РНК (CRM, правки, межі команд) — проти бази з нуля", async (t) => {
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
    await c.query(`INSERT INTO teams (id,name) VALUES (15,'РНК - Друга')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (302,'Тімлід лідогену',11,true),(303,'Звільнений лідген',11,false),(150,'Друга РНК',15,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'),
        (3,'lead@uts.ua','x','team_lead',103,13,'Тімлід РНК'),
        (4,'lg@uts.ua','x','team_lead',302,11,'Тімлід лідогену'),
        (5,'rpk@uts.ua','x','team_lead',201,5,'Тімлід РПК')`);
    // Лідогенерація: входи в «Кваліфіковано» (142) воронки Продзвону 8921936 — прорахунки тижня (301 → 2, 302 → 1).
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo) VALUES
        (901,301,8921936,142,0,'2026-09-10'),(902,301,8921936,142,0,'2026-09-10'),(903,302,8921936,142,0,'2026-09-10'),(904,303,8921936,142,0,'2026-09-10')`);
    await c.query(`INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at) VALUES
        (901,142,8921936,'2026-09-15T10:00Z'),(902,142,8921936,'2026-09-16T10:00Z'),(903,142,8921936,'2026-09-17T10:00Z'),
        (904,142,8921936,'2026-09-17T11:00Z'),(905,142,8921936,'2026-09-17T12:00Z')`);
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo) VALUES (905,303,8921936,142,0,'2026-09-10')`);
    // Конверсія РНК: рекламні угоди (lead_channel='ad'), створені в тижні. 101: 2 ліди, 1 успіх; 102: 1 лід, 0.
    // Контроль: лідгенівська угода 101 у тижні і рекламна поза тижнем — у «Конв. реклама» не входять.
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,lead_channel) VALUES
        (801,101,8921932,142,1000,'2026-09-15T09:00Z','ad'),(802,101,8921932,69693668,0,'2026-09-16T09:00Z','ad'),
        (803,102,8921932,69693668,0,'2026-09-16T09:00Z','ad'),(804,101,8921932,142,500,'2026-09-15T09:00Z','leadgen'),
        (805,101,8921932,142,700,'2026-09-10T09:00Z','ad'),(806,150,8921932,142,900,'2026-09-17T09:00Z','ad')`);
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
    assert.equal(lg.members.some((m: any) => m.id === 303), false, "🔴 неактивний лідген у заліку");

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

    // ── Конверсія РНК: число CRM, межі команд і правки.
    assert.equal(a.body.rnkConv.canComment, true);
    const adm = (id: number) => a.body.rnkConv.rows.find((r: any) => r.managerId === id);
    assert.deepEqual([adm(101).crm, adm(101).pct, adm(102).crm], [{ taken: 2, won: 1 }, 50, { taken: 1, won: 0 }],
      "🔴 число CRM конверсії не «Конв. реклама» тижня (зайшла лідгенівська угода чи угода поза тижнем?)");
    assert.ok(adm(150), "🔴 керівництво не бачить другу команду РНК");
    const rows13 = (await call("GET", "/week", { who: "lead", query: q })).body.rnkConv.rows;
    assert.ok(rows13.length > 0 && rows13.every((r: any) => r.teamId === 13 && r.canEditRow === true), "🔴 тімлід РНК бачить чужі рядки конверсії");
    assert.equal(rows13.some((r: any) => r.managerId === 150), false, "🔴 тімлід РНК бачить рядок другої команди РНК");
    assert.equal((await call("POST", "/rnk-conv", { who: "lead", body: { weekFrom: WEEK, action: "set", managerId: 150, taken: 5, won: 1 } })).status, 403, "🔴 тімлід РНК правит чужу команду РНК");
    assert.equal((await call("GET", "/week", { who: "rpk", query: q })).body.rnkConv, null, "🔴 тімлід РПК бачить конверсію РНК");
    const conv = (who: string, body: object) => call("POST", "/rnk-conv", { who, body: { weekFrom: WEEK, ...body } });
    assert.equal((await conv("rpk", { action: "set", managerId: 101, taken: 24, won: 4, onSlide: true })).status, 403, "🔴 тімлід РПК правит конверсію РНК");
    assert.equal((await conv("lead", { action: "comment", comment: "x" })).status, 403, "🔴 коментар пише не керівництво");
    const s1 = await conv("lead", { action: "set", managerId: 101, taken: 24, won: 4 });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const r101 = s1.body.rnkConv.rows.find((r: any) => r.managerId === 101);
    assert.deepEqual([r101.taken, r101.won, r101.pct, r101.own.by], [24, 4, 16.67, "Тімлід РНК"], "🔴 правка тімліда не лягла");
    // Галочка «на слайд» — окремо: не робить рядок «своїм» і не чіпає інших.
    const sl = await conv("admin", { action: "slide", managerId: 102, onSlide: false });
    const r102 = sl.body.rnkConv.rows.find((r: any) => r.managerId === 102);
    assert.deepEqual([r102.onSlide, r102.own, r102.taken], [false, null, 1], "🔴 галочка заморозила числа рядка");
    const cm = await conv("admin", { action: "comment", comment: "реклама зросла" });
    assert.equal(cm.body.rnkConv.comment.text, "реклама зросла");
    const rs = await conv("admin", { action: "reset", managerId: 101 });
    const b101 = rs.body.rnkConv.rows.find((r: any) => r.managerId === 101);
    assert.deepEqual([b101.taken, b101.won, b101.own], [2, 1, null], "🔴 «Як у CRM» не повернуло справжнє число CRM");
    await assert.rejects(() => c.query(`INSERT INTO nomination_conv_edits (week_from,manager_id,action,taken,won) VALUES ('2026-09-14',101,'set',3,4)`), /check/i, "🔴 БД прийняла успіх > ліди");
    await assert.rejects(() => c.query(`INSERT INTO nomination_conv_edits (week_from,manager_id,action) VALUES ('2026-09-14',101,'slide')`), /check/i, "🔴 БД прийняла вибір слайда без так/ні");
    await assert.rejects(() => c.query(`UPDATE nomination_conv_edits SET taken = 1`), /заборонено/, "🔴 правки конверсії переписуються");

    // ── Фіксація: лідогенератори НЕ в знімку, живі — видно й можна правити після вівторка; команди — заморожені.
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T06:00:00Z")), "frozen");
    const lgRows = await c.query(`SELECT COUNT(*)::int AS n FROM nomination_snapshot WHERE week_from = '2026-09-14' AND team_id = 11`);
    assert.equal(lgRows.rows[0].n, 0, "🔴 лідогенератори потрапили у знімок");
    const fz = await frozenWeek(WEEK);
    const fzMax = fz!.leadgen!.cells.find((x) => x.nomination === "lgMaxDeal")!;
    assert.deepEqual([fzMax.final.status, fzMax.final.value, fzMax.final.winners], ["overridden", 15000, [301]], "🔴 зафіксований тиждень загубив дані лідогенераторів");
    const after = await call("POST", "/review", { who: "lg", body: { weekFrom: WEEK, teamId: 11, nomination: "lgIntl", action: "override", overrideManagerIds: [301], overrideValue: 1, reason: "один рейс у Польщу" } });
    assert.equal(after.status, 200, "🔴 лідогенераторів не можна внести після фіксації");
    assert.equal((await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, nomination: "cars", action: "confirm" } })).status, 409, "🔴 команду можна правити після фіксації");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
