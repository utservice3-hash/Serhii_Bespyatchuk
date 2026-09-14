import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #399h — ДИМОВИЙ ПРОГІН СПІЛЬНОЇ ЗАДАЧІ: обробники ВИКОНУЮТЬСЯ проти бази з нуля.
 *
 * 🔴 НАВІЩО, ЯКЩО Є #399 І #399d. Ті перевіряють ПРАВИЛО (чисті функції) і УМОВУ
 * СКОУПУ (один SQL). А цей прохід додав ~13 нових роутів, у кожному свій запит —
 * і SQL у шаблонному рядку **не типізується взагалі**. Саме так у проєкт уже
 * їхали `d.id = e.deal_id` (пройшло tsc і 240 тестів, упало б на першому кліку)
 * і псевдонім `day` без `AS` (роут віддавав 500, гейти були зелені). Тут кожен
 * новий обробник кликається В ПРОЦЕСІ з мок-`req`/`res` — без сервера, без
 * мережі, проти одноразового кластера.
 *
 * ⚠️ ЧОМУ НЕ ДРУГИМ СЕРВЕРОМ ПРОТИ ПРОДА (спокуса, від якої застерігає правило):
 * копія застосунку — це другий працівник у бойовій базі; заміряно, що така копія
 * за хвилину життя переписала 1608 рядків і надіслала фальшиву тривогу.
 *
 * 🧨 Червоніє від будь-якої помилки в новому SQL, від зламаної межі (404/403/400)
 * і від зникнення лічильників чи бейджа у видачі.
 */
test("#399h ДИМ: усі роути спільної задачі виконуються проти бази з нуля, межі віддають свої коди", async (t) => {
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
    await c.query(`INSERT INTO teams (id,name) VALUES (7,'РПК-7')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (30,'Тімлід',7,true),(40,'Менеджер',7,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,NULL,'Адмін'),
        (3,'lead@uts.ua','x','team_lead',30,7,'Тімлід'),
        (4,'mgr@uts.ua','x','manager',40,7,'Менеджер')`);

    const { tasksRouter } = await import("./tasks.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    // Роль-кеш fail-closed: без цього виклику будь-яка перевірка прав відмовила б,
    // і «403 з обох боків» читалось би як «межа працює».
    await refreshRoles();

    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (tasksRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const AUTH: Record<string, unknown> = {
      admin: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null },
      lead: { userId: 3, role: "team_lead", roleKey: "team_lead", managerId: 30, teamId: 7 },
      mgr: { userId: 4, role: "manager", roleKey: "manager", managerId: 40, teamId: 7 },
    };

    /** Кличемо ОСТАННІЙ шар роута — тобто сам обробник, минаючи requireAuth. */
    async function call(method: string, p: string, o: { who?: string; params?: Record<string, string>; body?: unknown } = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p} — перелік роутів змінився, гейт втратив предмет`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as
        (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
      const req = { auth: AUTH[o.who ?? "admin"], params: o.params ?? {}, body: o.body ?? {}, query: {}, headers: {}, originalUrl: p };
      let code = 200;
      let payload: unknown;
      const res = {
        headersSent: false,
        status(x: number) { code = x; return res; },
        json(b: unknown) { payload = b; return res; },
        send(b: unknown) { payload = b; return res; },
        type() { return res; },
        setHeader() { /* стрім файла в димовому прогоні не потрібен */ },
        sendFile(_f: string, cb?: (e: Error) => void) { cb?.(new Error("no file")); },
      };
      await handler(req, res, (e?: unknown) => { if (e) throw e; });
      return { code, payload: payload as Record<string, never> };
    }

    // ── 1. ВИДАЧА: головний запит із новими джойнами й підзапитами, по всіх ролях ──
    for (const who of ["admin", "lead", "mgr"]) {
      const r = await call("GET", "/", { who });
      assert.equal(r.code, 200, `🔴 GET /tasks (${who}) віддав ${r.code}: ${JSON.stringify(r.payload).slice(0, 200)}`);
      assert.ok(Array.isArray((r.payload as unknown as { tasks: unknown[] }).tasks), "видача без масиву задач");
    }

    // ── 2. ГРУПИ: особисті, дубль назви — відмова, чужі не видно ──
    const g = await call("POST", "/groups", { body: { name: "Дашборд" } });
    assert.equal(g.code, 201, `створення групи: ${JSON.stringify(g.payload)}`);
    const dup = await call("POST", "/groups", { body: { name: "дашборд" } });
    assert.equal(dup.code, 409, "🔴 дубль назви групи прийнято — межа лише в індексі, і вона дає 500");
    const mine = await call("GET", "/groups");
    assert.equal((mine.payload as unknown as { groups: unknown[] }).groups.length, 1);
    const alien = await call("GET", "/groups", { who: "mgr" });
    assert.equal((alien.payload as unknown as { groups: unknown[] }).groups.length, 0,
      "🔴 чужі групи видно — групи перестали бути особистими");

    // ── 3. ЗАДАЧА Й СУПУТНИКИ ──
    const created = await call("POST", "/", { body: { title: "Спільна задача", assigneeId: 40 } });
    assert.equal(created.code, 201);
    const id = String((created.payload as unknown as { id: number }).id);

    assert.equal((await call("PATCH", "/:id", { params: { id }, body: { status: "in_progress" } })).code, 204);
    const h1 = await call("GET", "/:id/history", { params: { id } });
    const hist = (h1.payload as unknown as { history: { toStatus: string; changedByName: string }[] }).history;
    assert.equal(hist.length, 1, "🔴 зміна статусу не лишила рядка в історії");
    assert.equal(hist[0].toStatus, "in_progress");
    assert.equal(hist[0].changedByName, "Адмін", "історія не знає, ХТО рухав");
    // 🪞 Той самий статус удруге — НЕ подія. Інакше історія заростає шумом і
    // перестає відповідати на питання «коли це насправді зрушило».
    await call("PATCH", "/:id", { params: { id }, body: { status: "in_progress" } });
    const h2 = await call("GET", "/:id/history", { params: { id } });
    assert.equal((h2.payload as unknown as { history: unknown[] }).history.length, 1,
      "🔴 повторний той самий статус додав рядок у лог");

    assert.equal((await call("POST", "/:id/comments", { params: { id }, body: { body: "перше доповнення" } })).code, 201);
    const cs = await call("GET", "/:id/comments", { params: { id } });
    const comments = (cs.payload as unknown as { comments: { authorName: string; body: string }[] }).comments;
    assert.equal(comments.length, 1);
    assert.equal(comments[0].authorName, "Адмін", "🔴 доповнення без автора — стрічка не відрізняється від поля comments");

    const up = await call("POST", "/:id/files", { params: { id },
      body: { filename: "акт.pdf", mime: "application/pdf", dataBase64: Buffer.from("PDF-байти").toString("base64") } });
    assert.equal(up.code, 201, `завантаження вкладення: ${JSON.stringify(up.payload)}`);
    assert.equal((await call("GET", "/:id/files", { params: { id } })).payload
      && ((await call("GET", "/:id/files", { params: { id } })).payload as unknown as { files: unknown[] }).files.length, 1);
    assert.equal((await call("POST", "/:id/seen", { params: { id } })).code, 204);

    // ── 4. ПЕРЕЛІК АКАУНТІВ — БЕЗ EMAIL ──
    const as = await call("GET", "/assignees");
    assert.equal(as.code, 200);
    assert.equal((as.payload as unknown as { assignees: unknown[] }).assignees.length, 3);
    assert.ok(!JSON.stringify(as.payload).includes("@uts.ua"),
      "🔴 у переліку виконавців поїхав email — це логін, а не імʼя");

    // ── 5. МЕЖІ: кожна віддає СВІЙ код, а не 500 ──
    assert.equal((await call("GET", "/:id/comments", { who: "mgr", params: { id: "999999" } })).code, 404,
      "🔴 неіснуюча задача не 404 — приватність підтверджує саме існування");
    assert.equal((await call("GET", "/:id/comments", { params: { id: "abc" } })).code, 400,
      "🔴 сміття в шляху йде в БД замість 400");
    assert.equal((await call("PATCH", "/:id", { params: { id }, body: { assigneeUserId: 3 } })).code, 400,
      "🔴 два виконавці разом дали не 400 — CHECK віддасть 500 і людина побачить «нічого не сталось»");
    assert.equal((await call("POST", "/:id/files", { params: { id },
      body: { filename: "b.bin", dataBase64: Buffer.alloc(6 * 1024 * 1024).toString("base64") } })).code, 413,
      "🔴 файл понад 5 МБ прийнято");
    assert.equal((await call("PATCH", "/:id", { who: "mgr", params: { id }, body: { groupId: 1 } })).code, 403,
      "🔴 задачу покладено в ЧУЖУ групу — вона зникла б з екрана колеги незрозумілим чином");

    // ── 6. ЛІЧИЛЬНИКИ Й БЕЙДЖ ДОЇЖДЖАЮТЬ У ВИДАЧУ ──
    const rowFor = async (who: string) => {
      const list = await call("GET", "/", { who });
      const r = (list.payload as unknown as { tasks: Record<string, unknown>[] }).tasks
        .find((x) => String(x.id) === id);
      assert.ok(r, `задача зникла з видачі (${who})`);
      return r!;
    };
    const first = await rowFor("mgr");
    assert.equal(Number(first.commentCount), 1, "🔴 лічильник доповнень не доїхав");
    assert.equal(Number(first.fileCount), 1, "🔴 лічильник вкладень не доїхав");

    /**
     * 🔴 БЕЙДЖ ПЕРЕВІРЯЄТЬСЯ ПО ПІВНИКАХ І В ОБИДВА БОКИ — інакше він беззубий.
     *
     * Перша редакція цього гейта стверджувала рівно «hasUnseen === true» після
     * доповнення І зміни статусу. Саботаж це спіймав, а гейт — ні: у SQL два
     * `EXISTS` через `OR`, і зламавши перевірку АВТОРА доповнення
     * (`author_id <> me` → `= me`), другий `EXISTS` (лог статусу) однаково
     * піднімав бейдж. Гейт лишався зеленим на зламаному коді — рівно «зелений
     * завдяки дірці». Тому нижче: кожна половина окремо, і обовʼязково ВНИЗ
     * (бейдж, що не гасне, пройшов би перевірку «true»).
     */
    // ⬇️ Виконавець ПОДИВИВСЯ → бейдж мусить ЗГАСНУТИ.
    assert.equal((await call("POST", "/:id/seen", { who: "mgr", params: { id } })).code, 204);
    assert.equal((await rowFor("mgr")).hasUnseen, false,
      "🔴 бейдж не гасне після перегляду — «є нове» стверджує неправду назавжди");
    // ⬆️ ПОЛОВИНА ПЕРША: нове лише ДОПОВНЕННЯ (від іншого акаунта).
    await call("POST", "/:id/comments", { params: { id }, body: { body: "друге доповнення" } });
    assert.equal((await rowFor("mgr")).hasUnseen, true,
      "🔴 доповнення КОЛЕГИ не піднімає бейдж — половина «стрічка» мертва");
    // ⬇️ Знову подивився → згасло.
    await call("POST", "/:id/seen", { who: "mgr", params: { id } });
    assert.equal((await rowFor("mgr")).hasUnseen, false, "бейдж не згас перед другою половиною");
    // ⬆️ ПОЛОВИНА ДРУГА: нове лише СТАТУС (рухав інший акаунт).
    await call("PATCH", "/:id", { params: { id }, body: { status: "ready_for_approval" } });
    assert.equal((await rowFor("mgr")).hasUnseen, true,
      "🔴 зміна статусу КОЛЕГОЮ не піднімає бейдж — половина «статус» мертва");
    // 🪞 І ВЛАСНА дія бейджа не піднімає: інакше людина бачила б «є нове» на своєму ж записі.
    await call("POST", "/:id/seen", { who: "mgr", params: { id } });
    await call("POST", "/:id/comments", { who: "mgr", params: { id }, body: { body: "моє власне" } });
    assert.equal((await rowFor("mgr")).hasUnseen, false,
      "🔴 власне доповнення підняло бейдж собі ж — умова автора не працює");

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});
