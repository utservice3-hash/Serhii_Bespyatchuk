import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #3466 — ЛЮДИ ТИЖНЯ ДЛЯ ПРЕЗЕНТАЦІЇ ПРОТИ БАЗИ З НУЛЯ (прохід 2, 04.11.2026). `/presentation-extras` — лише керівництву;
 * ДР і «новий у команді» — з «Найму», звільнені не потрапляють; авто новачка — від дати прийому ядром; «Нова посада» —
 * лише з обраним співробітником, порожній текст прибирає.
 * 🧨 Червоніє, якщо тімлід отримає дані, звільнений іменинник потрапить на слайд, авто новачка рахуватимуться не від
 * прийому, або «Нова посада» збережеться без людини.
 */
test("#3466 ДИМ: події тижня — ДР і новачки з «Найму», авто від прийому, нова посада лише з людиною; лише керівництво", async (t) => {
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
    await c.query(`INSERT INTO teams (id,name) VALUES (13,'РНК - Тест')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (101,'Новачок',13,true),(103,'Тімлід РНК',13,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'), (3,'lead@uts.ua','x','team_lead',103,13,'Тімлід РНК')`);
    await c.query(`INSERT INTO employees (id,full_name,import_key,status,birth_date,hired_at,manager_id) VALUES
        (1,'Іменинниця Тест','k1','active','1990-09-16','2020-01-10',NULL),
        (2,'Новачок Тест','k2','active','1995-03-03','2026-09-01',101),
        (3,'Звільнений Іменинник','k3','dismissed','1991-09-17','2019-01-01',NULL),
        (4,'Давній Тест','k4','active','1992-05-05','2026-08-01',NULL),
        (5,'Бухгалтерка Тест','k5','active','1993-06-06','2026-09-01',NULL)`);
    // Авто новачка: до прийому (не рахується), після прийому до кінця тижня (2), після тижня (не рахується).
    await c.query(`INSERT INTO deals (kommo_id,manager_id,pipeline_id,status_id,price,created_at_kommo,load_at) VALUES
        (1,101,8921932,142,1000,'2026-08-20','2026-08-25T08:00Z'),(2,101,8921932,142,1000,'2026-09-01','2026-09-05T08:00Z'),
        (3,101,8921932,142,1000,'2026-09-10','2026-09-16T08:00Z'),(4,101,8921932,142,1000,'2026-09-20','2026-09-22T08:00Z')`);
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
        };
        handler({ auth: AUTH[o.who ?? "admin"], query: o.query ?? {}, body: o.body ?? {}, params: {}, headers: {} }, res);
      });
      return { status, body };
    }
    const WEEK = "2026-09-14";
    assert.equal((await call("GET", "/presentation-extras", { who: "lead", query: { weekFrom: WEEK } })).status, 403, "🔴 тімлід отримав дані презентації");
    const a = await call("GET", "/presentation-extras", { query: { weekFrom: WEEK } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.birthdays.map((x: any) => [x.name, x.date]), [["Іменинниця Тест", "2026-09-16"]], "🔴 ДР не з «Найму» або звільнений потрапив на слайд");
    assert.deepEqual(a.body.newcomers.map((x: any) => [x.name, x.day, x.cars]), [["Новачок Тест", "2026-09-15", 2]],
      "🔴 новачок не той, авто не від дати прийому, або на слайд потрапив не менеджер відділу (бухгалтерка)");
    assert.deepEqual(a.body.adaptingManagerIds, [101], "🔴 менеджер на адаптації (перший місяць) не позначений — потрапить у «Прорив тижня»");
    assert.deepEqual(a.body.rookies.map((x: any) => [x.employeeId, x.cars]), [[2, 2]], "🔴 новачок для відзнаки не той (людина з прийомом 01.08 — уже не новачок)");
    assert.equal(a.body.employees.some((x: any) => x.id === 3), false, "🔴 звільнений у виборі «Нової посади»");
    /**
     * #3472 — ВИБІР «НОВОЇ ПОСАДИ» ЛИШЕ З КОМЕРЦІЙНОГО ВІДДІЛУ (рішення Романа 09.11.2026): той самий ростер тижня, що й
     * «новий у команді». 🧨 Червоніє, якщо в списку знову бухгалтерка чи людина без привʼязки до Kommo, або якщо менеджер
     * відділу зник зі списку (фільтр, що відсікає всіх, теж зламаний).
     */
    await t.test("#3472 «Нова посада»: вибір лише з комерційного відділу — бухгалтерії й людей поза Kommo немає, менеджер відділу є", () => {
      const ids = a.body.employees.map((x: any) => x.id);
      assert.ok(ids.includes(2), "🔴 менеджера відділу немає у виборі «Нової посади»");
      assert.equal(ids.includes(5), false, "🔴 бухгалтерка у виборі «Нової посади»");
      assert.equal(ids.includes(1), false, "🔴 людина без привʼязки до Kommo у виборі «Нової посади»");
    });
    // «Нова посада»: без людини — 400, неіснуюча — 404, з людиною — є, порожній текст — прибрано.
    assert.equal((await call("POST", "/texts", { body: { weekFrom: WEEK, kind: "new_position", text: "Тімлід" } })).status, 400, "🔴 нова посада без людини");
    assert.equal((await call("POST", "/texts", { body: { weekFrom: WEEK, kind: "new_position", employeeId: 999, text: "Тімлід" } })).status, 404, "🔴 нова посада неіснуючої людини");
    assert.equal((await call("POST", "/texts", { who: "lead", body: { weekFrom: WEEK, kind: "new_position", employeeId: 4, text: "Тімлід" } })).status, 403, "🔴 тімлід вніс нову посаду");
    const p1 = await call("POST", "/texts", { body: { weekFrom: WEEK, kind: "new_position", employeeId: 4, text: "Тімлід РНК" } });
    assert.deepEqual(p1.body.extras.newPositions.map((x: any) => [x.name, x.position]), [["Давній Тест", "Тімлід РНК"]], "🔴 нова посада не дійшла до слайда");
    const p2 = await call("POST", "/texts", { body: { weekFrom: WEEK, kind: "new_position", employeeId: 4, text: "" } });
    assert.deepEqual(p2.body.extras.newPositions, [], "🔴 порожній текст не прибрав нову посаду");
    assert.equal((await call("GET", "/week", { query: { weekFrom: WEEK } })).body.texts.focus, undefined, "🔴 нова посада просочилась у фокус тижня");
  } finally {
    await c.end();
    const { pool } = await import("../db/pool.js");
    await pool.end().catch(() => undefined);
    scratch.dispose();
  }
});
