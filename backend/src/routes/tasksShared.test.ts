import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #400h — ДИМОВИЙ ПРОГІН СПІЛЬНОЇ ЗАДАЧІ: обробники ВИКОНУЮТЬСЯ проти бази з нуля.
 *
 * 🔴 НАВІЩО, ЯКЩО Є #400 І #400d. Ті перевіряють ПРАВИЛО (чисті функції) і УМОВУ
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
test("#400h ДИМ: усі роути спільної задачі виконуються проти бази з нуля, межі віддають свої коди", async (t) => {
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

    // ── 7. МЕЖА КІЛЬКОСТІ ВКЛАДЕНЬ — В КІНЦІ, бо вона МІНЯЄ склад файлів ──
    /**
     * 🔴 МЕЖА КІЛЬКОСТІ — ПО ОБИДВА БОКИ, інакше перевіряється лише те, що функція
     * щось повертає. Ліміт 2 (рішення Романа 14.09): ДРУГИЙ файл мусить лягти,
     * ТРЕТІЙ — отримати 409. Перевірка лише на 409 зеленіла б і при ліміті 1,
     * тобто при зламаній фічі.
     */
    const second = await call("POST", "/:id/files", { params: { id },
      body: { filename: "друге.txt", dataBase64: Buffer.from("другий").toString("base64") } });
    assert.equal(second.code, 201, `🔴 ДРУГИЙ файл не прийнято — ліміт звузився: ${JSON.stringify(second.payload)}`);
    const third = await call("POST", "/:id/files", { params: { id },
      body: { filename: "третє.txt", dataBase64: Buffer.from("третій").toString("base64") } });
    assert.equal(third.code, 409, "🔴 ТРЕТІЙ файл прийнято — ліміт 2 не тримається");
    // Прибрали один → знову можна. Інакше межа була б пасткою без виходу.
    const list2 = (await call("GET", "/:id/files", { params: { id } })).payload as unknown as { files: { id: number }[] };
    assert.equal(list2.files.length, 2, "у переліку не два файли");
    await call("DELETE", "/:id/files/:fileId", { params: { id, fileId: String(list2.files[1].id) } });
    const again = await call("POST", "/:id/files", { params: { id },
      body: { filename: "знову.txt", dataBase64: Buffer.from("знову").toString("base64") } });
    assert.equal(again.code, 201, "🔴 після прибирання файла додати новий не вдається — межа стала пасткою");
    // Мʼяке видалення не рахується в ліміті й не видно в переліку.
    const afterList = (await call("GET", "/:id/files", { params: { id } })).payload as unknown as { files: unknown[] };
    assert.equal(afterList.files.length, 2, "🔴 прибране вкладення повернулось у перелік");

    // ── 8. ЖИВА МЕЖА ВЛАСНИКА НА ВКЛАДЕННЯХ — ПО ОБИДВА БОКИ ──
    /**
     * 🔴 ЦЕ ТА САМА ДІРКА, ЩО РОБИЛА ГЕЙТ ЗЕЛЕНИМ (знайдено рецензією 14.09.2026).
     * Усі попередні файлові виклики робить `admin`, який САМ і створив задачу —
     * тобто завжди власник. Отже жоден живий виклик не виконував гілку НЕ-власника,
     * і саботаж самого застосування межі (`if (mode === "own" && …)` → `if (false
     * && …)`) давав повний зелений прогін. «Зелений завдяки дірці» (правило 7).
     *
     * Тому тут окрема задача, де `admin` — НЕ власник: автор `lead`, виконавець
     * `mgr`. Перевіряються всі ЧОТИРИ файлові роути й лічильник у списку, і
     * обовʼязково ОБИДВА боки: не-власнику 403, власникові — його код. Односторонній
     * тест зеленів би й тоді, коли вкладення зламані для ВСІХ.
     */
    const foreign = await call("POST", "/", { who: "lead",
      body: { title: "Чужа для адміна", assigneeId: 40 } });
    assert.equal(foreign.code, 201, `🔴 фікстура не створилась: ${JSON.stringify(foreign.payload)}`);
    const fid = String((foreign.payload as unknown as { id: number }).id);

    // Власник (виконавець) кладе файл — це його право.
    const byOwner = await call("POST", "/:id/files", { who: "mgr", params: { id: fid },
      body: { filename: "акт.txt", dataBase64: Buffer.from("акт").toString("base64") } });
    assert.equal(byOwner.code, 201, `🔴 ВИКОНАВЕЦЬ НЕ МОЖЕ ПРИКРІПИТИ ФАЙЛ до своєї задачі: ${JSON.stringify(byOwner.payload)}`);
    const ownerList = (await call("GET", "/:id/files", { who: "mgr", params: { id: fid } }));
    assert.equal(ownerList.code, 200, "🔴 виконавець не бачить переліку вкладень своєї задачі");
    const ownerFileId = String(((ownerList.payload as unknown as { files: { id: number }[] }).files)[0].id);

    // Не-власник, який задачу БАЧИТЬ: усі чотири роути мусять відмовити.
    for (const [method, route, extra] of [
      ["GET", "/:id/files", {}],
      ["POST", "/:id/files", { body: { filename: "чуже.txt", dataBase64: Buffer.from("x").toString("base64") } }],
      ["GET", "/:id/files/:fileId", { params: { id: fid, fileId: ownerFileId } }],
      ["DELETE", "/:id/files/:fileId", { params: { id: fid, fileId: ownerFileId } }],
    ] as [string, string, Record<string, unknown>][]) {
      const r = await call(method, route, { who: "admin", params: { id: fid }, ...extra });
      assert.equal(r.code, 403,
        `🔴 ${method} ${route} ВІДДАВ ВКЛАДЕННЯ НЕ-ВЛАСНИКУ (код ${r.code}): наскрізний адмін не автор і не `
        + `виконавець цієї задачі, а рішення власника 14.09.2026 — «файли тільки для власників». `
        + `Відповідь: ${JSON.stringify(r.payload)}`);
    }
    // 🪞 І дзеркало на задачу, яку адмін БАЧИТЬ: межа саме на вкладеннях, а не на задачі.
    const stillSees = await call("GET", "/:id/comments", { who: "admin", params: { id: fid } });
    assert.equal(stillSees.code, 200,
      "🔴 МЕЖА З'ЇЛА ЗАБАГАТО: разом із вкладеннями наглядач втратив обговорення, яке має право читати");

    // Лічильник у списку: власнику — число, наглядачеві — `null`, а НЕ нуль.
    const listOwner = (await call("GET", "/", { who: "mgr" })).payload as unknown as { tasks: { id: number; fileCount: number | null }[] };
    const listAdmin = (await call("GET", "/", { who: "admin" })).payload as unknown as { tasks: { id: number; fileCount: number | null }[] };
    const ownerRow = listOwner.tasks.find((t) => String(t.id) === fid);
    const viewerRow = listAdmin.tasks.find((t) => String(t.id) === fid);
    assert.equal(ownerRow?.fileCount, 1, `🔴 власник не бачить кількості своїх вкладень: ${JSON.stringify(ownerRow)}`);
    assert.ok(viewerRow, "🔴 наглядач узагалі не бачить задачі — фікстура не про те");
    assert.equal(viewerRow!.fileCount, null,
      `🔴 ЛІЧИЛЬНИК ВКЛАДЕНЬ У НАГЛЯДАЧА = ${viewerRow!.fileCount}, А МУСИТЬ БУТИ null. `
      + "Нуль читався б на екрані як «файлів немає» — пряма неправда про задачу, у якої файл є.");

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #400i — ЛІМІТИ ВКЛАДЕНЬ ОДНАКОВІ НА СЕРВЕРІ Й НА ЕКРАНІ.
 *
 * 🔴 Два числа в двох файлах розходяться МОВЧКИ, і розходження тут не косметичне:
 * якщо екран обіцяє більше, ніж пускає сервер, людина тисне «Додати файл» і
 * отримує «нічого не сталось» без причини; якщо навпаки — кнопка зникає раніше,
 * ніж межа настала. Той самий клас, що дві копії `MONEY_ZONE` і правило
 * класифікації, яке існувало тричі.
 *
 * 🧨 Червоніє, якщо змінити число в одному файлі й забути другий.
 */
test("#400i ЛІМІТИ ВКЛАДЕНЬ: сервер і екран називають ОДНІ Й ТІ САМІ числа", () => {
  const be = readFileSync(path.join(import.meta.dirname, "tasks.js"), "utf8");
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "api.ts"), "utf8");

  const num = (src: string, re: RegExp, what: string): string => {
    const m = src.match(re);
    assert.ok(m, `🔴 не знайдено ${what} — гейт втратив предмет`);
    return m![1].replace(/[\s_]/g, "");
  };
  // Сервер: `const FILES_PER_TASK = 2;` і `5 * 1024 * 1024`.
  const beCount = num(be, /FILES_PER_TASK\s*=\s*(\d+)/, "FILES_PER_TASK на сервері");
  const beBytes = num(be, /FILE_MAX_BYTES\s*=\s*([\d\s*]+?);/, "FILE_MAX_BYTES на сервері");
  const feCount = num(fe, /TASK_FILES_PER_TASK\s*=\s*(\d+)/, "TASK_FILES_PER_TASK на екрані");
  const feBytes = num(fe, /TASK_FILE_MAX_BYTES\s*=\s*([\d\s*]+?);/, "TASK_FILE_MAX_BYTES на екрані");

  assert.equal(feCount, beCount,
    `🔴 КІЛЬКІСТЬ ФАЙЛІВ РОЗІЙШЛАСЬ: сервер ${beCount}, екран ${feCount}`);
  assert.equal(feBytes, beBytes,
    `🔴 РОЗМІР ФАЙЛА РОЗІЙШОВСЯ: сервер ${beBytes}, екран ${feBytes}`);
  // Дзеркало: числа справді ті, що вирішив власник 14.09.2026 — інакше гейт
  // доводив би лише рівність двох однаково зламаних копій.
  assert.equal(beCount, "2", "🔴 ліміт кількості не 2 — рішення Романа 14.09.2026");
  assert.equal(beBytes, "5*1024*1024", "🔴 ліміт розміру не 5 МБ — рішення Романа 14.09.2026");
});

/**
 * #400k — ПРИВʼЯЗАТИ ЗАДАЧУ ДО ПАПКИ МОЖНА ЗІ СПИСКУ, А НЕ ЛИШЕ З КАРТКИ.
 *
 * 🔴 ПРИВІД — ВІДГУК ВЛАСНИКА ПІСЛЯ ВИКАТУ, дослівно: «немає системи привязки
 * задачі до групи». Код був цілий, роути живі (`/api/tasks/groups` віддавав 401,
 * тобто існував), інтерфейс у бандлі — але покласти задачу в папку можна було
 * ТІЛЬКИ відкривши її картку. Розкласти двадцять задач означало двадцять
 * відкриттів, і з погляду людини фічі просто не було.
 *
 * ⚠️ УРОК ШИРШИЙ ЗА ВИПАДОК: «поле є в API, селект є в картці» — не те саме, що
 * «людина може цим скористатись». Той самий клас, що «клік не розгортає деталь»
 * при 202 зелених тестах: перевірялось те, що легко перевірити, а не те, чим
 * користуються. Тому гейт стереже НАЯВНІСТЬ ОБОХ ШЛЯХІВ.
 *
 * 🧨 Червоніє, якщо прибрати селектор групи з рядка списку (лишивши в картці) —
 * і якщо навпаки.
 */
test("#400k ПРИВʼЯЗКА ДО ПАПКИ: доступна і зі СПИСКУ, і з КАРТКИ задачі", () => {
  const src = readFileSync(
    path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages",
      "dashboard", "sections", "TasksSection.tsx"), "utf8",
  ).replace(/\s+/g, " ");

  // Рядок списку працює з `task.id`, картка — з `openTask.id`. Два різні шляхи,
  // і саме тому їх видно порізно, а не одним збігом.
  assert.match(src, /commitTask\( *task\.id, *\{ *groupId *\} *\)/,
    "🔴 У РЯДКУ СПИСКУ НЕМА ПРИВʼЯЗКИ ДО ПАПКИ. Людина мусить відкривати картку "
    + "кожної задачі — саме це власник назвав «немає системи привязки».");
  assert.match(src, /commitTask\( *openTask\.id, *\{ *groupId *\} *\)/,
    "🔴 у картці задачі зникла привʼязка до папки");


  // 🪞 Порожній стан НАЗИВАЄ СЕБЕ: «+ група» при нулі груп читалось би як
  // зламаний контрол, а не як «спершу створіть папку».
  assert.match(src, /\+ група \(спершу створіть\)/,
    "🔴 селект групи не пояснює порожнього стану — вимкнений вигляд без причини читається як поломка");
  // І дзеркало до самого гейта: предмет справді у файлі, а не вигаданий.
  assert.match(src, /groupChip/, "🔴 смуга груп зникла з екрана — гейт втратив предмет");
});

/**
 * #400l — ПРИКРІПИТИ ФАЙЛ МОЖНА ЗІ СПИСКУ, А БЛОК ВКЛАДЕНЬ ВИДНО БЕЗ ПРОКРУТКИ.
 *
 * 🔴 ПРИВІД — ДРУГИЙ ВІДГУК ВЛАСНИКА ПІСЛЯ ВИКАТУ, дослівно: «тако не можна
 * прикріпляти файли до задач». Заміряно в його браузері: кнопка в картці
 * ПРАЦЮВАЛА (клік доходив до інпута), блок рендерився — але лежав у самому низу
 * прокручуваної картки, ПІД стрічкою доповнень. Контрол є, людина його не бачить,
 * отже фічі немає.
 *
 * ⚠️ ЧОМУ ЦЕ ОКРЕМИЙ НОМЕР, А НЕ УТОЧНЕНА НАЗВА #400k. Спершу я саме уточнив
 * назву — і крок `test` ланцюга викату доповів «зник 1 гейт, додався 1», бо
 * реєстр звіряє ІМʼЯ (правило 13). Твердження змінилось — отже новий номер, а
 * старий лишається зі своїм. Ціна уточнення: обірваний викат.
 *
 * 🧨 Червоніє, якщо прибрати прикріплення з рядка списку (лишивши в картці), якщо
 * навпаки, якщо схований інпут отримає `display:none`, або якщо блок вкладень
 * знову опуститься під стрічку.
 */
test("#400l ПРИКРІПЛЕННЯ ФАЙЛА: зі СПИСКУ і з КАРТКИ, інпут не display:none, вкладення вище стрічки", () => {
  const raw = readFileSync(
    path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages",
      "dashboard", "sections", "TasksSection.tsx"), "utf8",
  );
  /**
   * 🔴 КОМЕНТАРІ ЗРІЗАЮТЬСЯ ДО ПОШУКУ — І САМЕ ЦЕ КУПИЛА АВАРІЯ 14.09.2026.
   *
   * Перша редакція шукала мітки `📎 ВКЛАДЕННЯ` і `💬 СТРІЧКА ДОПОВНЕНЬ` — а вони в
   * `TasksSection.tsx` є JSX-КОМЕНТАРЯМИ, підписами розділів коду. Гейт був зелений,
   * бо коментарі стоять у правильному порядку; на екран вони не потрапляють ЖОДНОГО
   * разу. 📐 Заміряно на живому бандлі прода: обидві мітки ×0 при «Дебіторка» ×5,
   * тобто простір не порожній — vite просто видаляє коментарі. Твердження про
   * ПОРЯДОК БЛОКІВ трималось на тексті, якого користувач не бачить: правило 10,
   * «через проксі падає від рефакторингу й мовчить від дефекту».
   *
   * Тепер анкер — ВИДИМИЙ заголовок блоку (`📎 Вкладення`, `💬 Стрічка доповнень`):
   * він їде разом зі своїм блоком, і коментар його не підмінить, бо коментаря тут
   * уже немає. Регістр теж розрізняє: коментар кричить капсом, заголовок ні.
   */
  const src = raw
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ")
    .replace(/\s+/g, " ");

  /**
   * 📎 ПРИКРІПИТИ ФАЙЛ — ТЕЖ ЗІ СПИСКУ, І ЦЕ ДРУГИЙ ВІДГУК ТОГО САМОГО КЛАСУ.
   * Власник: «не можна прикріпляти файли до задач». Заміряно в його браузері:
   * кнопка в картці ПРАЦЮВАЛА (клік доходив до інпута), але блок вкладень лежав
   * у самому низу прокручуваної картки, під стрічкою. Контрол є — людина його не
   * бачить — отже фічі немає. Тепер прикріплення живе і в рядку, і в картці, а
   * блок вкладень стоїть ВИЩЕ стрічки (стрічка росте, вкладення ні).
   *
   * 🔴 І ОКРЕМО: інпут не сміє бути `display:none`. Такий елемент у частині
   * рушіїв не отримує кліку від мітки — кнопка виглядає живою, діалог не
   * відкривається, і це неможливо відрізнити від «нічого не сталось».
   */
  assert.match(src, /pickFileFor\( *task\.id *\)/,
    "🔴 У РЯДКУ СПИСКУ НЕМА ПРИКРІПЛЕННЯ ФАЙЛА — власник назвав це «не можна прикріпляти файли до задач»");
  assert.match(src, /pickFileFor\( *openTask\.id *\)/,
    "🔴 у картці задачі зникло прикріплення файла");
  assert.doesNotMatch(src, /type="file"[\s\S]{0,400}?display: *"none"/,
    "🔴 файловий інпут схований через `display:none` — у частині рушіїв мітка не доносить до нього клік");
  /**
   * Вкладення мусять стояти ВИЩЕ стрічки: стрічка росте, вкладення ні, і під нею
   * їх не видно без прокрутки — саме там їх і не побачив власник.
   *
   * 🔴 СПЕРШУ ІСНУВАННЯ, ПОТІМ ПОРІВНЯННЯ. Перша редакція порівнювала просто
   * `indexOf(a) < indexOf(b)` — і саботаж це пробив: перейменована мітка дає −1,
   * а −1 «менше» за будь-що, тож гейт лишався ЗЕЛЕНИМ на зламаному екрані.
   * Відсутність, прочитана як вимір, — той самий клас, що «порожній результат =
   * правдоподібне число».
   */
  const posFiles = src.indexOf("📎 Вкладення");
  const posFeed = src.indexOf("💬 Стрічка доповнень");
  assert.ok(posFiles > 0, "🔴 ВИДИМОГО заголовка «📎 Вкладення» у картці немає — гейт втратив предмет (мітка в коментарі не рахується: vite її зрізає)");
  assert.ok(posFeed > 0, "🔴 ВИДИМОГО заголовка «💬 Стрічка доповнень» у картці немає — гейт втратив предмет");
  assert.ok(posFiles < posFeed,
    "🔴 блок вкладень знову опустився під стрічку — саме там його не побачив власник");
});

/**
 * 📖 ДЖЕРЕЛО ФРОНТУ БЕЗ КОМЕНТАРІВ — один хелпер на всі гейти нижче.
 *
 * 🔴 КУПЛЕНО АВАРІЄЮ 14.09.2026 (див. доккоментар `#400l`): перевірка анкерилась на
 * текст, який виявився JSX-КОМЕНТАРЕМ, і була зелена на зламаному екрані — vite
 * коментарі зрізає, у бандлі їх ×0. Тому кожен новий гейт читає КОД, а не файл:
 * задовольнити його коментарем фізично нічим.
 */
function codeOf(...rel: string[]): string {
  return readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", ...rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * #400m — ВКЛАДКА «СПІЛЬНІ ЗАДАЧІ»: те, що поставив ХТОСЬ ІНШИЙ.
 *
 * 🔴 ВИМОГА ВЛАСНИКА 14.09.2026, дослівно: «хочу щоб хтось міг назначити задачу для
 * когось, наприклад директор для мене, і мені світилося в дашборді, що є задача…
 * біля задач зʼявляється СВОЇ ЗАДАЧІ, СПІЛЬНІ ЗАДАЧІ, УСІ ЗАДАЧІ».
 *
 * 🧨 ТРИ САБОТАЖІ, І ТРЕТІЙ — ГОЛОВНИЙ:
 *  ① прибрати кнопку → червоніє (вкладки немає);
 *  ② прибрати з предиката умову «автор не я» → червоніє (вкладка показувала б і те,
 *    що я поставив сам собі, тобто не відповідала б на своє питання);
 *  ③ прибрати ГІЛКУ фільтра → червоніє. Саме вона найнебезпечніша: умова написана як
 *    «якщо mine — звузь», тож будь-яке інше значення означає «показати ВСЕ». Третя
 *    вкладка без гілки виглядала б активною й показувала повний список — відмова,
 *    яку неможливо відрізнити від роботи.
 *
 * 🪞 І дзеркало проти регресії: гілка «mine» мусить лишитись під умовою ролі. Без
 * неї менеджер, що створив задачу колезі, побачив би, як вона зникла з його екрана —
 * рівно те зникнення, яке лікували 14.09 (`taskVisibility.ts`).
 */
test("#400m ВКЛАДКА «СПІЛЬНІ»: кнопка, предикат «автор не я» і ВЛАСНА гілка фільтра", () => {
  const src = codeOf("pages", "dashboard", "sections", "TasksSection.tsx");

  assert.match(src, /useState<"mine" \| "shared" \| "all">/,
    "🔴 стан вкладок не знає значення «shared» — третьої вкладки немає в принципі");
  assert.match(src, /setAdminTab\("shared"\)/,
    "🔴 КНОПКИ «СПІЛЬНІ ЗАДАЧІ» НЕМА: людина не може перемкнутись на те, що їй поставили");
  assert.match(src, /Спільні задачі/,
    "🔴 підпис вкладки зник — вкладка є, але називає себе інакше, ніж просив власник");

  // ② Предикат: обидві умови, і саме ОБИДВІ роблять його відповіддю на питання.
  assert.match(src, /const isSharedWithMe = \(t: Task\) =>/, "🔴 предиката спільної задачі немає");
  const pred = src.slice(src.indexOf("const isSharedWithMe"), src.indexOf("const isSharedWithMe") + 400);
  assert.ok(/createdById !== currentUserId/.test(pred),
    "🔴 ПРЕДИКАТ НЕ ВІДРІЗНЯЄ ЧУЖОГО АВТОРА: вкладка «Спільні» показувала б і те, що я поставив сам собі");
  assert.ok(/assigneeId === currentManagerId/.test(pred) && /assigneeUserId/.test(pred),
    "🔴 предикат не перевіряє, що задача НА МЕНІ (менеджер або акаунт)");

  // ③ Гілка фільтра — і вона мусить кликати саме цей предикат.
  assert.match(src, /else if \(adminTab === "shared"\) \{ base = base\.filter\(isSharedWithMe\)/,
    "🔴 ВКЛАДКА БЕЗ ГІЛКИ ФІЛЬТРА: «shared» провалюється в «показати все», бо умова звужує лише «mine». "
    + "Кнопка активна, список повний — відмова, яку неможливо відрізнити від роботи.");

  // 🪞 Дзеркало: «mine» лишається під роллю, інакше менеджер втрачає створене колезі.
  assert.match(src, /adminTab === "mine" && canSeeAllTab/,
    "🔴 ФІЛЬТР «СВОЇ» ЗАСТОСУВАВСЯ ДО МЕНЕДЖЕРА: його задачі, створені колезі, зникнуть з екрана — "
    + "те саме зникнення, що лікували 14.09.2026");

  /**
   * 🔴 СМУГА ВКЛАДОК — ПОЗА УМОВОЮ РОЛІ, і саме це виконує вимогу власника.
   * Доти її бачили лише admin/team_lead/company, тобто менеджер не мав способу
   * побачити, що йому поставили задачу. Роль-умова лишається РІВНО на кнопці
   * «Усі / Командні». Твердження позитивне (де воно ТЕПЕР), а не «немає обгортки»:
   * перевірка на відсутність винагороджує зникнення (правило 8).
   */
  assert.match(src, /\{\(isAdmin \|\| role === "team_lead" \|\| role === "company"\) && \( <button style=\{tabBtn\(adminTab === "all"\)\}/,
    "🔴 УМОВА РОЛІ НЕ НА СВОЄМУ МІСЦІ: вона мусить обмежувати лише кнопку «Усі/Командні». "
    + "Якщо нею знову накрити всю смугу, менеджер втратить вкладку «Спільні» — тобто саме те, що просив власник.");

  // Лічильник — це і є «щоб світилося».
  assert.match(src, /sharedOpen\.length > 0 \? ` · \$\{sharedOpen\.length\}`/,
    "🔴 на вкладці немає числа — «світиться» нічим");
  assert.match(src, /sharedNew > 0 &&/,
    "🔴 немає ознаки НОВОГО серед спільних: число без неї не відрізняє «прийшло щойно» від «лежить тиждень»");
});

/**
 * #400n — ФАЙЛ ПРИКРІПЛЮЄТЬСЯ ЩЕ НА ЕТАПІ СТВОРЕННЯ ЗАДАЧІ.
 *
 * 🔴 ВИМОГА ВЛАСНИКА 14.09.2026: «прикріплення файлу має бути на етапі при створенні
 * задачі». Доти вкладення жило лише на вже створеній задачі: «створи → знайди в
 * списку → прикріпи».
 *
 * 🔴 ПОРЯДОК ТУТ — ЧАСТИНА ТВЕРДЖЕННЯ, А НЕ СТИЛЬ. Вкладення привʼязується до
 * `task_id`, якого до `POST /tasks` не існує; завантаження ПЕРЕД створенням не
 * «трохи неправильне», воно неможливе. Тому гейт міряє послідовність викликів.
 *
 * 🧨 Червоніє, якщо: прибрати `pendingFile` з типу або з `emptyTaskForm` (файл
 * потік би в наступну задачу); перенести завантаження перед `createTask`; забути
 * повернути `id` з `addTask` (прикріпляти стало б нікуди).
 */
test("#400n ФАЙЛ ПРИ СТВОРЕННІ: форма несе файл, і він їде ПІСЛЯ того, як сервер назвав id", () => {
  const form = codeOf("pages", "dashboard", "taskForm.ts");
  assert.match(form, /pendingFile: File \| null;/, "🔴 форма створення не має поля для файла");
  // 🪞 Друга половина обовʼязкова: тип БЕЗ дефолту означає, що файл від попередньої
  // задачі лишається у формі й тихо їде в наступну.
  assert.match(form, /pendingFile: null,/,
    "🔴 `emptyTaskForm` не скидає файл — вкладення попередньої задачі поїде в наступну");

  const cont = codeOf("pages", "Dashboard.tsx");
  assert.match(cont, /async function attachPendingFile\(ids: number\[\]\)/, "🔴 немає докладання файла після створення");
  assert.match(cont, /await uploadTaskFile\(id, file\)/, "🔴 файл нікуди не вантажиться");
  assert.match(cont, /return id;/, "🔴 `addTask` не віддає id — прикріпляти файл нема до чого");

  /**
   * ПОРЯДОК — В КОЖНІЙ ГІЛЦІ ОКРЕМО, І ЦЕ ВИПРАВЛЕННЯ ПО РЕЦЕНЗІЇ 14.09.2026.
   *
   * 🔴 Перша редакція брала ПЕРШІ входження `createTask(` і `attachPendingFile(`
   * у хвості файла — а в гілці «двоє виконавців» створення стоїть першим завжди.
   * Тобто нерівність виконувалась НАЗАВЖДИ, що б не сталося з гілкою одного
   * виконавця (найчастішою). Гейт міряв не те твердження, яке проголошував.
   *
   * Тепер кожна гілка перевіряється своїм якорем: `made = await createTask` для
   * кількох виконавців, `newId = await addTask` для одного.
   */
  for (const [branch, create, attach] of [
    ["кілька виконавців", "const made = await createTask(", "attachPendingFile(made.ids"],
    ["один виконавець", "const newId = await addTask(", "attachPendingFile(newId"],
  ]) {
    const posCreate = cont.indexOf(create);
    const posAttach = cont.indexOf(attach);
    assert.ok(posCreate > 0, `🔴 гейт втратив предмет: гілки «${branch}» немає — якір «${create}» не знайдено`);
    assert.ok(posAttach > 0, `🔴 у гілці «${branch}» файл не докладається взагалі (якір «${attach}»)`);
    assert.ok(posCreate < posAttach,
      `🔴 ГІЛКА «${branch}»: ФАЙЛ ЇДЕ ДО СТВОРЕННЯ ЗАДАЧІ — прикріпляти нема до чого, task_id ще не існує`);
  }
  // Після успішного докладання список мусять перечитати: інакше нова колонка
  // «Файли» покаже «—» на задачі, до якої файл щойно доклали.
  assert.match(cont, /if \(failed\.length < ids\.length\) setTasks\(await fetchTasks\(\)\);/,
    "🔴 СПИСОК НЕ ПЕРЕЧИТУЄТЬСЯ: щойно прикріплений файл не видно в колонці до фонового опитування");

  // Окремий інпут: секційний вантажить НЕГАЙНО, формі потрібно лише запамʼятати.
  const sec = codeOf("pages", "dashboard", "sections", "TasksSection.tsx");
  assert.match(sec, /createFileRef/, "🔴 у форми немає власного файлового інпута");
  assert.match(sec, /setTaskForm\(\(cur\) => \(\{ \.\.\.cur, pendingFile: f \}\)\)/,
    "🔴 інпут форми не запамʼятовує файл (або вантажить його одразу — а задачі ще немає)");
  assert.match(sec, /f\.size > TASK_FILE_MAX_BYTES/,
    "🔴 межа розміру не перевіряється у формі: задача створилась би, а файл відлітав із 413 — «створилось, але не все»");
});

/**
 * #400o — ПЕРЕГЛЯД ВКЛАДЕНЬ СТОЇТЬ ПРАВОРУЧ ВІД КОМЕНТАРЯ.
 *
 * 🔴 ВИМОГА ВЛАСНИКА 14.09.2026, дослівно: «І також немає перегляду файлів. Він має
 * бути праворуч від коментаря». Доти файл відкривався лише з розгорнутої картки і
 * то `window.open` — окремою вкладкою браузера, яку міг проглинути блокувальник.
 *
 * 🔴 ЧИСЛА КОЛОНОК — ЦЕ НЕ ПЕДАНТИЗМ. Вставка колонки в цю таблицю чіпає ПʼЯТЬ
 * місць (`col`, `th`, `td` задачі, `td` синтетичної парасольки KPI, `colSpan`
 * порожнього стану). Забути одне — і рядок поїде на клітинку вбік: дані стануть
 * під чужими підписами, і жоден тип цього не побачить.
 *
 * 🧨 Червоніє, якщо: прибрати колонку; поставити її НЕ праворуч від коментаря;
 * забути `col`/`colSpan`/`td` синтетичного рядка; прибрати `revokeObjectURL`.
 */
test("#400o ПЕРЕГЛЯД ВКЛАДЕНЬ: колонка праворуч від «Коментар», і всі пʼять місць збігаються", () => {
  const src = codeOf("pages", "dashboard", "sections", "TasksSection.tsx");

  // Порядок підписів: «Файли» стоїть САМЕ після «Коментар» у шапці.
  assert.match(src, /<th>Коментар<\/th> <th>Файли<\/th>/,
    "🔴 КОЛОНКА ФАЙЛІВ НЕ ПРАВОРУЧ ВІД КОМЕНТАРЯ — власник просив саме це місце");

  // Числа: colgroup == thead == colSpan порожнього стану.
  const head = src.slice(src.indexOf("<colgroup>"), src.indexOf("</thead>"));
  const cols = (head.match(/<col /g) ?? []).length;
  const ths = (head.match(/<th[ >]/g) ?? []).length;
  assert.ok(cols > 0 && ths > 0, "🔴 гейт втратив предмет: шапку таблиці задач не знайдено");
  assert.equal(cols, ths, `🔴 ШИРИНИ Й ПІДПИСИ РОЗІЙШЛИСЬ: ${cols} <col> проти ${ths} <th> — таблиця поїде вбік`);
  assert.match(src, new RegExp(`<td colSpan=\\{${ths}\\} className="loading-text"`),
    `🔴 порожній стан розтягнутий не на всі ${ths} колонки — рядок «Завантаження» поїде`);

  // Синтетична парасолька KPI — окремий рядок, і в неї стільки ж клітинок.
  const synth = src.slice(src.indexOf("const renderSynthRow"), src.indexOf("const renderSynthRow") + 3000);
  const synthEnd = synth.indexOf("</tr>");
  const synthTds = ((synthEnd > 0 ? synth.slice(0, synthEnd) : synth).match(/<td[ >]/g) ?? []).length;
  assert.equal(synthTds, ths,
    `🔴 РЯДОК ПАРАСОЛЬКИ KPI МАЄ ${synthTds} КЛІТИНОК ПРОТИ ${ths} ПІДПИСІВ — його дані стануть під чужими заголовками`);

  /**
   * 🔴 РЯДОК СПРАВЖНЬОЇ ЗАДАЧІ — ПʼЯТЕ МІСЦЕ, І ПЕРША РЕДАКЦІЯ ЙОГО НЕ МІРЯЛА.
   * Назва гейта обіцяла «всі пʼять місць», а перевірялось чотири: найважливіший
   * рядок — той, у якому лежать дані, — не рахувався (знайдено рецензією 14.09).
   *
   * ⚠️ Наївний підрахунок `<td` тут дає не те: УСЕРЕДИНІ рядка є вкладені таблиці
   * (парасолька KPI, підзадачі, реактивація). Тому рахуємо клітинки ВЕРХНЬОГО
   * рівня: заходимо у вкладену таблицю — перестаємо рахувати.
   */
  const rowStart = src.indexOf("<tr key={task.id}>");
  assert.ok(rowStart > 0, "🔴 гейт втратив предмет: рядка задачі «<tr key={task.id}>» у джерелі немає");
  let depth = 0, taskTds = 0, i = rowStart + 18, guard = 0;
  while (i < src.length && guard++ < 200000) {
    if (src.startsWith("<table", i)) { depth++; i += 6; continue; }
    if (src.startsWith("</table>", i)) { depth--; i += 8; continue; }
    if (depth === 0 && src.startsWith("</tr>", i)) break;
    if (depth === 0 && src.startsWith("<td", i)) taskTds++;
    i++;
  }
  assert.equal(taskTds, ths,
    `🔴 РЯДОК ЗАДАЧІ МАЄ ${taskTds} КЛІТИНОК ПРОТИ ${ths} ПІДПИСІВ — дані поїдуть під чужі заголовки. `
    + "Це найдорожчий бік вставки колонки: тип цього не бачить, і на екрані «Коментар» опиниться під «Файли».");

  // Сам перегляд: кнопка в рядку, переглядач, і відкликання blob-URL.
  assert.match(src, /setFilesViewer\(task\.id\)/, "🔴 з рядка списку не можна відкрити вкладення");
  assert.match(src, /function TaskFilesViewer\(/, "🔴 переглядача вкладень немає");
  assert.match(src, /<TaskFilesViewer/, "🔴 переглядач оголошений, але НЕ рендериться — мертвий код");
  assert.match(src, /URL\.revokeObjectURL\(u\)/,
    "🔴 blob-URL не відкликається: кожен перегляд лишає копію байтів у памʼяті вкладки");
  // Гілки за типом: картинка й PDF мусять показуватись НА МІСЦІ, а не качатись.
  assert.match(src, /mime\?\.startsWith\("image\/"\)/, "🔴 картинка не показується на місці");
  assert.match(src, /mime === "application\/pdf"/, "🔴 PDF не показується на місці");
  // 🪞 І невідомий тип називає себе, а не лишається порожнім вікном.
  assert.match(src, /Цей тип файла браузер не показує/,
    "🔴 непідтримуваний тип дає порожню модалку — вона читається як «файлів немає»");
});

/**
 * #400q — ЗАКОННА ВІДМОВА ОДНОГО БЛОКУ НЕ ГАСИТЬ КАРТКУ ЗАДАЧІ.
 *
 * 🔴 АВАРІЯ, ЯКА ЦЕ КУПИЛА — 14.09.2026, І ВОНА БУЛА МОЯ. Того ж дня, коли
 * вкладення звузили до власників, `GET /:id/files` почав законно віддавати 403
 * наглядачеві. Картка тягнула трьох супутників ОДНИМ `Promise.all`, а той
 * відхиляється ПЕРШОЮ відмовою — тож разом із вкладеннями з екрана зникали
 * СТРІЧКА ДОПОВНЕНЬ та ІСТОРІЯ СТАТУСУ, які сервер віддав зі статусом 200.
 *
 * Найгірше в цьому: рядок `Promise.all` НЕ ЗМІНЮВАВСЯ. Зміна на сервері
 * перетворила робочий код на шлях утрати даних — тобто це не «забули поправити»,
 * а «прибрали інваріанту, на яку хтось спирався»: доти жоден із трьох запитів не
 * міг відмовити окремо.
 *
 * 🧨 Червоніє, якщо: злити три запити назад в один `Promise.all`; прибрати окремий
 * `catch` у будь-якого з трьох; вивести відмову вкладень у загальний банер
 * (`detailErr`) замість власного стану; перестати показувати текст СЕРВЕРА.
 */
test("#400q КАРТКА ЗАДАЧІ: три супутники — три незалежні відмови, і вкладення не гасять стрічку", () => {
  const src = codeOf("pages", "dashboard", "sections", "TasksSection.tsx");

  // Кожен супутник має ВЛАСНИЙ then і ВЛАСНИЙ catch.
  for (const [what, fetcher, setter] of [
    ["обговорення", "fetchTaskComments", "setComments"],
    ["історію", "fetchTaskHistory", "setHistory"],
    ["вкладення", "fetchTaskFiles", "setFiles"],
  ]) {
    const re = new RegExp(`void ${fetcher}\\(id\\) \\.then\\(\\([a-z]\\) => \\{ if \\(alive\\) ${setter}`);
    assert.match(src, re,
      `🔴 ${what} тягнуться НЕ окремим запитом: законна відмова сусіда забере їх із собою`);
    const from = src.indexOf(`void ${fetcher}(id)`);
    const seg = src.slice(from, from + 420);
    assert.ok(seg.includes(".catch("),
      `🔴 у запиту «${what}» немає власного catch — відмова піде в спільний обробник і погасить решту`);
  }

  // 🪞 Парне твердження до позитивних вище: спільного Promise.all БІЛЬШЕ НЕМА.
  // Саме по собі «немає» нічого не значить (правило 8), тому воно стоїть ПІСЛЯ
  // перевірки, що три окремі запити на місці.
  assert.doesNotMatch(src, /Promise\.all\(\[ ?fetchTaskComments/,
    "🔴 ТРИ ЗАПИТИ ЗНОВУ ЗЛИТІ В ОДИН Promise.all: 403 на вкладеннях знесе стрічку доповнень та історію статусу");

  // Відмова вкладень має ВЛАСНИЙ стан і власне місце на екрані.
  assert.match(src, /setFilesErr\(errText\(e, "вкладення не відкрились"\)\)/,
    "🔴 відмова вкладень не має власного стану — вона або зникне, або погасить усю картку");
  assert.match(src, /filesErr \? \(/,
    "🔴 `filesErr` нікуди не рендериться: законна відмова перетворюється на «Файлів ще немає» — пряму неправду");

  // Текст відмови — СЕРВЕРА, а не англійські слова axios.
  assert.match(src, /function errText\(e: unknown, fallback: string\): string \{/,
    "🔴 немає читача серверного тексту відмови");
  assert.match(src, /\?\.response\?\.data\?\.error/,
    "🔴 причина відмови не дістається з тіла відповіді — людина побачить «Request failed with status code 403»");
});

/**
 * #400r — ВКЛАДЕННЯ МАЮТЬ ОДИН ВИГЛЯД І ОДНЕ МІСЦЕ В РЯДКУ.
 *
 * 🔴 ПРИВІД — ВІДГУК ВЛАСНИКА 14.09.2026 зі скріншотом: «i still dont like the look of
 * the card. unclear file attaching». На скріншоті скріпка з числом стояла ТРИЧІ в одному
 * рядку (лічильник під назвою, кнопка між селектами, колонка «Файли»), і жодна не
 * казала «сюди можна кинути файл». Три індикатори однієї речі — це не «багато
 * інформації», це шум, який ховає єдину дію.
 *
 * Рішення — зразок, який у дашборді ВЖЕ Є (drop-зона «Документів»): одна зона з
 * перетягуванням у картці й у формі, і одне місце в рядку — колонка «Файли».
 *
 * 🧨 Червоніє, якщо: повернути лічильник «📎 N» під назву; додати другу кнопку
 * прикріплення поза колонкою «Файли»; прибрати `onDrop` із зони; малювати у формі чи
 * картці щось інше замість `AttachmentZone`.
 */
test("#400r ВКЛАДЕННЯ: одна зона з перетягуванням у картці й формі, і одне місце в рядку списку", () => {
  const src = codeOf("pages", "dashboard", "sections", "TasksSection.tsx");

  // Одна зона — і вона справді приймає drop, а не лише клік.
  assert.match(src, /function AttachmentZone\(/, "🔴 спільної зони вкладень немає — картка й форма знову розійдуться виглядом");
  const zone = src.slice(src.indexOf("function AttachmentZone("), src.indexOf("export function TasksSection("));
  assert.match(zone, /onDrop=\{\(e\) => \{ e\.preventDefault\(\);/, "🔴 зона не приймає перетягування — «Перетягніть файл сюди» стало б неправдою");
  assert.match(zone, /onDragOver=\{/, "🔴 без onDragOver браузер не дасть кинути файл у зону (drop не спрацює)");
  assert.match(zone, /Перетягніть файл сюди або натисніть, щоб обрати/, "🔴 зона не каже, що з нею робити");
  // 🪞 Ліміт показується ТЕКСТОМ у зоні, а не вимкненою рамкою.
  assert.match(zone, /ще \{remaining\} із \{TASK_FILES_PER_TASK\}/, "🔴 зона не називає, скільки ще можна докласти");

  // Обидва місця малюють САМЕ її — рівно два вживання: картка + форма.
  const uses = (src.match(/<AttachmentZone/g) ?? []).length;
  assert.equal(uses, 2, `🔴 <AttachmentZone> вжито ${uses} рази, а мусить 2 (картка задачі + форма створення)`);

  // Одне місце в рядку: жодного «📎 N» під назвою, і рівно одна кнопка прикріплення зі списку.
  assert.doesNotMatch(src, /title="вкладень"/, "🔴 лічильник «📎 N» повернувся під назву — скріпка знову подвоюється");
  const listPicks = (src.match(/pickFileFor\(task\.id\)/g) ?? []).length;
  assert.equal(listPicks, 1, `🔴 кнопок прикріплення в рядку ${listPicks}, а мусить бути одна — у колонці «Файли»`);
  // І вона стоїть у тій самій клітинці, що й перегляд (сусіди в одному контейнері).
  const cell = src.slice(src.indexOf("setFilesViewer(task.id)") - 600, src.indexOf("setFilesViewer(task.id)") + 900);
  assert.ok(cell.includes("pickFileFor(task.id)"), "🔴 кнопка «+» не в колонці «Файли» — файли знову розкидані по рядку");
});
