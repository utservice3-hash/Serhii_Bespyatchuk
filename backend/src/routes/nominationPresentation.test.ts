import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #3463 — НОВА ПРЕЗЕНТАЦІЯ ПРОТИ БАЗИ З НУЛЯ (04.11.2026, макет Даші). Фікстура — та сама, що #666 (+ рекламний лід РПК).
 * Топ-3 відділу віддається лише керівництву, рахується над усіма командами, і «Свої дані» тімліда прибирають з топу людину
 * його команди з більшим числом CRM. Конверсія — на весь відділ: людина з РПК у таблиці, тімлід РПК бачить лише свою
 * команду, тімлід лідогену — нічого. Фокус тижня й фото команди — лише керівництво, обидва лише дописуються.
 * 🧨 Червоніє, якщо тімлід отримає топ-3, правка тімліда не діятиме на топ, РПК випаде з конверсії або тімлід зможе
 * змінити фокус чи фото.
 */
test("#3463 ДИМ: презентація — топ-3 відділу лише керівництву і з правкою тімліда, конверсія на весь відділ, фокус і фото — лише керівництво", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.DOCS_DIR = mkdtempSync(path.join(tmpdir(), "nom-pres-"));
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
    // Конверсія РНК «як у Kommo» (#919): рекламне «Источник клиента», створені в тижні; успіх — за «Датою загрузки».
    // 101: 2 цільові, 1 успіх; 102: 1 цільовий, 0. Контроль: угода 101 без джерела і угода поза тижнем — не входять.
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,client_source,load_at) VALUES
        (801,101,8921932,142,1000,'2026-09-15T09:00Z','uts.ua','2026-09-16T08:00Z'),(802,101,8921932,69693668,0,'2026-09-16T09:00Z','uts.ua',NULL),
        (803,102,8921932,69693668,0,'2026-09-16T09:00Z','Дзвінок з uts.ua',NULL),(804,101,8921932,142,500,'2026-09-15T09:00Z',NULL,'2026-09-16T08:00Z'),
        (805,101,8921932,142,700,'2026-09-10T09:00Z','uts.ua',NULL),(806,150,8921932,142,900,'2026-09-17T09:00Z','uts.ua','2026-09-18T08:00Z'),
        (807,201,8921932,69693668,0,'2026-09-16T09:00Z','uts.ua',NULL)`);
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
          // Файлові відповіді (фото, музика): тіло = шлях, байти й заголовки — щоб звірити, ЩО саме віддано.
          sendFile(f: string, opts: { headers?: Record<string, string> }, cb: (e?: unknown) => void) {
            try { body = { file: f, bytes: readFileSync(f), headers: opts?.headers ?? {} }; res.headersSent = true; resolve(); }
            catch (e) { cb(e); }
          },
        };
        handler({ auth: AUTH[o.who ?? "admin"], query: o.query ?? {}, body: o.body ?? {}, params: {}, headers: {} }, res);
      });
      return { status, body };
    }
    const WEEK = "2026-09-14";
    const q = { weekFrom: WEEK };
    // ── Топ-3 відділу: керівництву — над усіма командами; тімліду — ні.
    const a = await call("GET", "/week", { query: q });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(a.body.companyTop && Array.isArray(a.body.companyTop.revenue), "🔴 керівництво не отримало топ-3 відділу");
    assert.equal("marginPct" in a.body.companyTop, false, "🔴 у топ-3 повернулась прихована «% маржі»");
    const rev0 = a.body.companyTop.revenue as { managerId: number; teamId: number; value: number; place: number; manual: boolean }[];
    const lead13Best = rev0.find((r) => r.teamId === 13)!;
    assert.ok(lead13Best, "🔴 у топ-3 результату немає команди 13 — фікстура не перевіряє правку");
    assert.equal((await call("GET", "/week", { who: "lead", query: q })).body.companyTop, null, "🔴 тімлід отримав топ-3 відділу");
    // ── «Свої дані» тімліда (керівництво за нього) на команді 13: переможець 102 з 1 ₴ — усі з команди 13 з більшим числом зникають.
    const ov = await call("POST", "/review", { body: { weekFrom: WEEK, teamId: 13, nomination: "revenue", action: "override", overrideManagerIds: [102], overrideValue: 1, reason: "угода внесена після неділі" } });
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    const rev1 = ov.body.companyTop.revenue as typeof rev0;
    assert.equal(rev1.some((r) => r.teamId === 13 && r.managerId !== 102), false, "🔴 правка тімліда лишила в топі людину його команди з більшим числом");
    assert.ok(rev1.some((r) => r.teamId === 5), "🔴 топ-3 не над усіма командами: після правки команди 13 у топ мала зайти РПК");
    assert.ok(rev1.some((r) => r.managerId === 102 && r.value === 1 && r.manual), "🔴 правка тімліда не стала числом людини в топі (з ✎)");
    // ── Конверсія на весь відділ.
    const rows = (a.body.rnkConv.rows as { managerId: number; teamId: number }[]);
    assert.ok(rows.some((r) => r.managerId === 201 && r.teamId === 5), "🔴 людина РПК з рекламним лідом випала з конверсії відділу");
    const rpkRows = (await call("GET", "/week", { who: "rpk", query: q })).body.rnkConv.rows as { teamId: number }[];
    assert.ok(rpkRows.length > 0 && rpkRows.every((r) => r.teamId === 5), "🔴 тімлід РПК бачить чужі рядки конверсії або не бачить своїх");
    assert.equal((await call("GET", "/week", { who: "lg", query: q })).body.rnkConv, null, "🔴 тімлід лідогену бачить конверсію відділу");
    // ── Фокус тижня — лише керівництво; лише дописування.
    assert.equal((await call("POST", "/texts", { who: "lead", body: { weekFrom: WEEK, kind: "focus", text: "x" } })).status, 403, "🔴 тімлід змінив фокус тижня");
    const tx = await call("POST", "/texts", { body: { weekFrom: WEEK, kind: "focus", text: "10 нових клієнтів" } });
    assert.equal(tx.body.texts.focus.text, "10 нових клієнтів", "🔴 фокус тижня не зберігся");
    assert.equal((await call("GET", "/week", { query: q })).body.texts.focus.text, "10 нових клієнтів", "🔴 фокус не дійшов до тижня");
    await assert.rejects(() => c.query(`UPDATE nomination_week_texts SET text = 'y'`), /заборонено/, "🔴 фокус тижня переписується");
    // ── Фото команди — лише керівництво; не-фото — відмова; лише дописування.
    const jpg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("team")]).toString("base64")}`;
    assert.equal((await call("POST", "/team-photo", { who: "lead", body: { dataBase64: jpg } })).status, 403, "🔴 тімлід завантажив фото команди");
    assert.equal((await call("POST", "/team-photo", { body: { dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") } })).status, 400, "🔴 PDF прийнято як фото команди");
    const ph = await call("POST", "/team-photo", { body: { dataBase64: jpg } });
    assert.equal(ph.status, 201, JSON.stringify(ph.body));
    assert.ok(ph.body.teamPhoto?.v > 0, "🔴 фото команди не зберіглось");
    assert.equal((await call("GET", "/week", { query: q })).body.teamPhoto?.v, ph.body.teamPhoto.v, "🔴 тиждень не знає про фото команди");
    await assert.rejects(() => c.query(`DELETE FROM nomination_team_photos`), /заборонено/, "🔴 фото команди можна стерти з історії");

    /**
     * #3470 — МУЗИКА НА ТИТУЛІ (09.11.2026): завантажує й читає лише керівництво; тип — за байтами (PDF під «.mp3» —
     * відмова), понад 20 МБ — відмова; адмін отримує РІВНО ті байти, що завантажив, з типом аудіо; «прибрати» — новий
     * рядок, історію стерти не можна; тімліду тиждень музики не віддає. 🧨 Червоніє, якщо зняти перевірку ролі, приймати
     * не-аудіо, віддати чужий файл чи дозволити стерти історію.
     */
    await t.test("#3470 ДИМ: музика презентації — лише керівництво, тип за байтами, до 20 МБ, ті самі байти назад, історія незмінна", async () => {
      const { checkMusic } = await import("../core/nominationMusic.js");
      const id3 = (n: number) => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(n, 7)]);
      // Розпізнавання за байтами — обидва боки межі.
      assert.equal(checkMusic(new Uint8Array(id3(100))).ok, true, "🔴 MP3 з тегом ID3 не прийнято");
      assert.equal(checkMusic(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(100)]))).ok, true, "🔴 MP3 без тегу не прийнято");
      assert.equal(checkMusic(new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(40)]))).ok, true, "🔴 M4A не прийнято");
      assert.equal(checkMusic(new Uint8Array(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40)]))).ok, true, "🔴 OGG не прийнято");
      assert.equal(checkMusic(new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(40)]))).ok, false, "🔴 PDF прийнято як музику");
      assert.equal(checkMusic(new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]))).ok, false, "🔴 PNG прийнято як музику");
      const b64 = (b: Buffer) => `data:audio/mpeg;base64,${b.toString("base64")}`;
      // Нічого не завантажено — 404, у тижні музики немає.
      assert.equal((await call("GET", "/music")).status, 404, "🔴 музика є до завантаження");
      assert.equal((await call("GET", "/week", { query: q })).body.music, null, "🔴 тиждень бачить музику до завантаження");
      // Межа ролі: тімлід і менеджер — ні завантажити, ні прочитати.
      assert.equal((await call("POST", "/music", { who: "lead", body: { dataBase64: b64(id3(100)), name: "x.mp3" } })).status, 403, "🔴 тімлід завантажив музику");
      assert.equal((await call("POST", "/music", { who: "mgr", body: { remove: true } })).status, 403, "🔴 менеджер прибрав музику");
      // Не-аудіо й завеликий файл — відмова.
      assert.equal((await call("POST", "/music", { body: { dataBase64: b64(Buffer.from("%PDF-1.4 xxxxxxxxxxxx")), name: "трек.mp3" } })).status, 400, "🔴 PDF під іменем .mp3 прийнято");
      assert.equal((await call("POST", "/music", { body: { dataBase64: b64(id3(20 * 1024 * 1024)), name: "довгий.mp3" } })).status, 400, "🔴 файл понад 20 МБ прийнято");
      // Дзеркало: адмін завантажує — і отримує рівно ті байти, з типом аудіо.
      const track = id3(4096);
      const up = await call("POST", "/music", { body: { dataBase64: b64(track), name: "C:\\fakepath\\Збір команди.mp3" } });
      assert.equal(up.status, 201, JSON.stringify(up.body));
      assert.ok(up.body.music?.v > 0, "🔴 музика не збереглась");
      assert.equal(up.body.music.title, "Збір команди.mp3", "🔴 назва треку з шляхом або загублена");
      const wk = await call("GET", "/week", { query: q });
      assert.deepEqual(wk.body.music, up.body.music, "🔴 тиждень не знає про музику");
      assert.equal((await call("GET", "/week", { who: "lead", query: q })).body.music, null, "🔴 тімлід бачить музику презентації");
      const got = await call("GET", "/music");
      assert.equal(got.status, 200);
      assert.ok(Buffer.compare(got.body.bytes, track) === 0, "🔴 віддано не ті байти, що завантажено");
      assert.equal(got.body.headers["Content-Type"], "audio/mpeg", "🔴 музика віддається без типу аудіо");
      assert.equal((await call("GET", "/music", { who: "lead" })).status, 403, "🔴 тімлід читає музику");
      // «Прибрати» — новий рядок: музики немає, а історія лишилась.
      const rm = await call("POST", "/music", { body: { remove: true } });
      assert.equal(rm.status, 201); assert.equal(rm.body.music, null, "🔴 музику не прибрано");
      assert.equal((await call("GET", "/music")).status, 404, "🔴 прибрана музика далі віддається");
      assert.equal((await call("GET", "/week", { query: q })).body.music, null, "🔴 тиждень бачить прибрану музику");
      assert.equal(Number((await c.query(`SELECT count(*) FROM nomination_music`)).rows[0].count), 2, "🔴 «прибрати» стерло історію замість дописати");
      await assert.rejects(() => c.query(`DELETE FROM nomination_music`), /заборонено/, "🔴 історію музики можна стерти");
    });
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
