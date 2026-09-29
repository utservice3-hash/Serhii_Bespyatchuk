import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #917 — ПРАВКИ ПІСЛЯ ЗНІМКА ДО ПʼЯТНИЦІ 23:59 І «ЗАФІКСУВАТИ ОСТАТОЧНО» (29.09.2026, рішення Романа) — проти бази з
 * нуля. Та сама фікстура, що #666 (тиждень 14–20.09.2026, знімок вт 22.09 15:00). Годинник роуту підміняється.
 * 🧨 Червоніє, якщо: після знімка «свої дані» не приймаються чи не лягають поверх; у пт 23:59:59 правку відхилено
 * або в сб 00:00 прийнято (для менеджерів, лідогенераторів чи конверсії); тімлід може зафіксувати остаточно;
 * фіксація остаточно не закриває будь-чого з трьох; рядок фіксації можна змінити.
 */
test("#917 ДИМ: після знімка свої дані до пт 23:59, «Зафіксувати остаточно» закриває все — проти бази з нуля", async (t) => {
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

    const { nominationsRouter, nominationClock } = await import("./nominations.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    const { freezeWeek } = await import("../core/nominations.js");
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
    const cell = (b: any, team: number, n: string) => b.teams.find((x: any) => x.teamId === team).cells.find((x: any) => x.nomination === n);
    const at = (iso: string) => { nominationClock.now = () => new Date(iso); };
    const own = (who: string, teamId: number, nomination: string, ids: number[], value: number) =>
      call("POST", "/review", { who, body: { weekFrom: WEEK, teamId, nomination, action: "override", overrideManagerIds: ids, overrideValue: value, reason: "угода внесена після неділі" } });
    const conv = (who: string) => call("POST", "/rnk-conv", { who, body: { weekFrom: WEEK, action: "set", managerId: 101, taken: 5, won: 2 } });

    // Знімок — вт 22.09 15:00 Києва (12:00Z); о 14:59 ще чернетка.
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T11:59:00Z")), "not-due", "🔴 знімок раніше за вт 15:00");
    assert.equal(await freezeWeek(WEEK, new Date("2026-09-22T12:00:00Z")), "frozen");

    // ── Середа: «свої дані» лягають поверх знімка; «Погоджуюсь» після знімка — ні.
    at("2026-09-23T10:00:00Z");
    const w1 = await own("lead", 13, "cars", [102], 7);
    assert.equal(w1.status, 200, JSON.stringify(w1.body));
    assert.deepEqual([cell(w1.body, 13, "cars").final.status, cell(w1.body, 13, "cars").final.winners, cell(w1.body, 13, "cars").final.value],
      ["overridden", [102], 7], "🔴 поправка після знімка не лягла поверх");
    assert.equal(w1.body.state, "frozen", "🔴 поправка розморозила тиждень");
    assert.equal((await call("POST", "/review", { who: "lead", body: { weekFrom: WEEK, teamId: 13, nomination: "maxDeal", action: "confirm" } })).status, 409, "🔴 після знімка пройшло «Погоджуюсь»");
    assert.equal((await own("lg", 11, "lgMaxDeal", [301], 15000)).status, 200, "🔴 лідогенераторів не можна внести до пт");
    assert.equal((await conv("lead")).status, 200, "🔴 конверсію РНК не можна поправити до пт");

    // ── Межа пт 23:59 Києва: 23:59:59 — так; сб 00:00 — ні (менеджери, лідогенератори, конверсія).
    at("2026-09-25T20:59:59Z");
    assert.equal((await own("lead", 13, "marginPct", [101], 90)).status, 200, "🔴 у пт 23:59:59 правку відхилено");
    at("2026-09-25T21:00:00Z");
    assert.equal((await own("lead", 13, "cars", [101], 3)).status, 409, "🔴 у сб 00:00 правку менеджерів прийнято");
    assert.equal((await own("lg", 11, "lgCars", [301], 2)).status, 409, "🔴 у сб 00:00 правку лідогенераторів прийнято");
    assert.equal((await conv("admin")).status, 409, "🔴 у сб 00:00 правку конверсії прийнято");
    const sat = (await call("GET", "/week", { who: "lead", query: { weekFrom: WEEK } })).body;
    assert.equal(cell(sat, 13, "cars").canReview, false, "🔴 після пт екран ще пропонує правити");
    assert.equal(cell(sat, 13, "cars").final.value, 7, "🔴 після закриття вікна поправка зникла");

    // ── «Зафіксувати остаточно» (четвер, вікно ще відкрите): тімлід — ні; чернетку — ні; керівництво — так.
    at("2026-09-24T09:00:00Z");
    assert.equal((await call("POST", "/lock", { who: "lead", body: { weekFrom: WEEK } })).status, 403, "🔴 тімлід зафіксував остаточно");
    assert.equal((await call("POST", "/lock", { body: { weekFrom: "2026-09-21" } })).status, 409, "🔴 зафіксовано остаточно тиждень без знімка");
    const lk = await call("POST", "/lock", { body: { weekFrom: WEEK } });
    assert.equal(lk.status, 200, JSON.stringify(lk.body));
    assert.equal(lk.body.locked?.by, "Адмін", "🔴 не видно, хто зафіксував остаточно");
    assert.equal((await own("admin", 13, "cars", [101], 3)).status, 409, "🔴 після «Зафіксувати остаточно» правку менеджерів прийнято");
    assert.equal((await own("lg", 11, "lgCars", [301], 2)).status, 409, "🔴 після «Зафіксувати остаточно» правку лідогенераторів прийнято");
    assert.equal((await conv("admin")).status, 409, "🔴 після «Зафіксувати остаточно» правку конверсії прийнято");
    await assert.rejects(() => c.query(`DELETE FROM nomination_week_locks`), /заборонено/, "🔴 остаточну фіксацію можна прибрати");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
