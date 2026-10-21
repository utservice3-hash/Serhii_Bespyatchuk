import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipReason } from "../db/scratchDb.js";

/**
 * 🎯 НОВИЙ ЕКРАН ЗАДАЧНИКА «ЩО ГОРИТЬ» (№6379 / №5998, рішення Романа 20.10.2026: варіант Б, без цілі,
 * галочка ставить «Готово», новий дизайн за замовчуванням, старий — кнопкою, вибір у браузері).
 *
 * Гейти `#1960`–`#1962`, `#1964` ВИКОНУЮТЬ чистий модуль фронта `pages/dashboard/tasksFocus.ts`, а не
 * читають його текст. Шлях будується змінною: статичний `import "…/frontend/…"` не пройшов би збірку
 * бекенду, а рантайм Node знімає типи сам. `#1963` кличе обробник `/tasks` проти бази з нуля.
 */
const spec = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/tasksFocus.ts", import.meta.url).href.replace("/dist/", "/src/"));
type T = { id: number; status: string; deadline?: string | null; doneAt?: string | null };
type Bucket = "late" | "today" | "week" | "later" | "none";
type Groups = Record<Bucket | "doneWeek" | "doneEarlier", T[]>;
type Mod = {
  kyivDate: (now: Date) => string;
  weekOf: (day: string) => { start: string; end: string };
  bucketOf: (t: T, today: string) => Bucket;
  doneThisWeek: (t: T, today: string) => boolean;
  focusGroups: (tasks: T[], today: string) => Groups;
  focusCounts: (g: Groups) => { active: number; late: number; thisWeek: number; review: number; doneWeek: number };
  chipKeeps: (chip: string | null, bucket: string, status: string) => boolean;
  FOCUS_BUCKETS: { key: Bucket; label: string }[];
  readDesign: (s: unknown) => "new" | "old";
  writeDesign: (s: unknown, v: "new" | "old") => void;
  TASKS_DESIGN_KEY: string;
};
const load = async () => (await import(spec)) as Mod;

/**
 * #1960 — ГРУПА ЗА ДЕДЛАЙНОМ, МЕЖІ З ОБОХ БОКІВ. Дедлайн — останній день, коли ще вчасно: прострочена лише
 * та, чий день УЖЕ минув; «До кінця тижня» — до неділі включно; понеділок наступного — «Пізніше».
 * 🧨 Червоніє, якщо `<` стане `<=` (задача з дедлайном сьогодні вже «прострочена»), якщо неділя випаде
 * з тижня, або якщо тиждень почнеться не з понеділка.
 */
test("#1960 ЗАДАЧНИК «ЩО ГОРИТЬ»: група за дедлайном — вчора прострочено, сьогодні — сьогодні, неділя — цей тиждень, понеділок — пізніше", async () => {
  const R = await load();
  const tue = "2026-10-20";
  const at = (deadline: string | null, today = tue) => R.bucketOf({ id: 1, status: "not_started", deadline }, today);
  assert.equal(at("2026-10-19"), "late", "🔴 вчорашній дедлайн не прострочений");
  assert.equal(at("2026-10-20"), "today", "🔴 дедлайн сьогодні вже «прострочений» — людина ще має весь день");
  assert.equal(at("2026-10-21"), "week");
  assert.equal(at("2026-10-25"), "week", "🔴 неділя випала з поточного тижня");
  assert.equal(at("2026-10-26"), "later", "🔴 понеділок наступного тижня потрапив у «цей тиждень»");
  assert.equal(at(null), "none", "🔴 задача без дедлайну кудись поділась");
  // Сьогодні неділя: «до кінця тижня» порожньо, понеділок — уже «пізніше».
  assert.equal(at("2026-10-25", "2026-10-25"), "today");
  assert.equal(at("2026-10-26", "2026-10-25"), "later", "🔴 у неділю понеділок вважається «цим тижнем»");
  // Сьогодні понеділок: неділя ЦЬОГО тижня — шість днів попереду.
  assert.equal(at("2026-10-25", "2026-10-19"), "week");
  assert.equal(at("2026-10-18", "2026-10-19"), "late");
});

/**
 * #1961 — ЛІЧИЛЬНИК = СПИСОК (вимога №5998 «цифри збігаються зі списком»). Кожна задача рівно в одній
 * групі; «Активні» — сума груп активних; і для КОЖНОЇ плитки число дорівнює кількості рядків, які лишає
 * її фільтр. Тобто клацнув на «2» — побачив рівно два рядки.
 * 🧨 Червоніє, якщо плитка порахує щось не з груп (напр. «цей тиждень» без «сьогодні»), якщо задача
 * загубиться чи потрапить у дві групи, або якщо фільтр плитки розійдеться з її числом.
 */
test("#1961 ЗАДАЧНИК «ЩО ГОРИТЬ»: кожна плитка дорівнює кількості рядків, які лишає її фільтр, кожна задача — в одній групі", async () => {
  const R = await load();
  const today = "2026-10-20";
  const tasks: T[] = [
    { id: 1, status: "not_started", deadline: "2026-10-14" },
    { id: 2, status: "in_progress", deadline: "2026-10-18" },
    { id: 3, status: "ready_for_approval", deadline: "2026-10-20" },
    { id: 4, status: "not_started", deadline: "2026-10-22" },
    { id: 5, status: "ready_for_approval", deadline: "2026-10-25" },
    { id: 6, status: "deferred", deadline: "2026-10-31" },
    { id: 7, status: "ball_on_executor", deadline: null },
    { id: 8, status: "ready_for_approval", deadline: null },
    { id: 9, status: "done", deadline: "2026-10-10", doneAt: "2026-10-20" },
    { id: 10, status: "done", deadline: null, doneAt: "2026-10-19" },
    { id: 11, status: "done", deadline: null, doneAt: "2026-10-12" },
    { id: 12, status: "done", deadline: null, doneAt: null },
  ];
  const g = R.focusGroups(tasks, today);
  const all = (Object.keys(g) as (keyof Groups)[]).flatMap((k) => g[k].map((t) => t.id)).sort((a, b) => a - b);
  assert.deepEqual(all, tasks.map((t) => t.id), "🔴 задача загубилась або потрапила у дві групи");
  const c = R.focusCounts(g);
  assert.deepEqual(c, { active: 8, late: 2, thisWeek: 3, review: 3, doneWeek: 2 });
  const active = R.FOCUS_BUCKETS.reduce((n, b) => n + g[b.key].length, 0);
  assert.equal(c.active, active, "🔴 «Активні» не дорівнює сумі заголовків груп");
  // Плитка ↔ фільтр: стільки рядків, скільки написано на плитці.
  const kept = (chip: string) => (Object.keys(g) as (keyof Groups)[])
    .reduce((n, k) => n + g[k].filter((t) => R.chipKeeps(chip, k, t.status)).length, 0);
  for (const [chip, n] of [["late", c.late], ["thisWeek", c.thisWeek], ["review", c.review], ["doneWeek", c.doneWeek]] as const) {
    assert.equal(kept(chip), n, `🔴 плитка «${chip}» каже ${n}, а фільтр лишає ${kept(chip)} рядків`);
  }
  assert.equal(R.chipKeeps(null, "doneEarlier", "done"), true, "без фільтра видно все");
});

/**
 * #1962 — ТИЖДЕНЬ І «СЬОГОДНІ» ЗА КИЄВОМ. 01:30 ночі понеділка за Києвом — це ще неділя за UTC; задача,
 * закрита в неділю, належить ТОМУ тижню, а не наступному. Без дати виконання — не «цього тижня», а
 * «не знаємо коли».
 * 🧨 Червоніє, якщо «сьогодні» рахувати за UTC чи поясом браузера, якщо неділя виконання поїде в
 * наступний тиждень, або якщо виконаною цього тижня стане задача без дати.
 */
test("#1962 ЗАДАЧНИК «ЩО ГОРИТЬ»: сьогодні й тиждень — за Києвом, виконане в неділю — у своєму тижні, без дати — ні", async () => {
  const R = await load();
  assert.equal(R.kyivDate(new Date("2026-10-18T22:30:00Z")), "2026-10-19", "🔴 «сьогодні» рахується не за Києвом (за UTC тут ще неділя)");
  assert.equal(R.kyivDate(new Date("2026-10-19T20:59:00Z")), "2026-10-19");
  assert.deepEqual(R.weekOf("2026-10-25"), { start: "2026-10-19", end: "2026-10-25" }, "🔴 неділя не в своєму тижні");
  assert.deepEqual(R.weekOf("2026-10-19"), { start: "2026-10-19", end: "2026-10-25" });
  assert.deepEqual(R.weekOf("2026-11-01"), { start: "2026-10-26", end: "2026-11-01" }, "🔴 тиждень через перехід на зимовий час зсунувся");
  const done = (doneAt: string | null, status = "done") => R.doneThisWeek({ id: 1, status, doneAt }, "2026-10-21");
  assert.equal(done("2026-10-19"), true);
  assert.equal(done("2026-10-25"), true);
  assert.equal(done("2026-10-18"), false, "🔴 закрите в неділю минулого тижня зараховано в цей");
  assert.equal(done(null), false, "🔴 «не знаємо коли» зараховано в «цього тижня»");
  assert.equal(done("2026-10-20", "in_progress"), false, "🔴 повернута в роботу задача лишилась «виконаною»");
});

/**
 * #1963 — ВИДАЧА ЗАДАЧ ЗНАЄ, КОЛИ ЗАДАЧУ ВИКОНАНО. Ручне «Готово» дати закриття не пише, тож дата —
 * останній перехід у done із журналу статусів (київська дата), а автозакритим — `closed_at`. Активна
 * задача — NULL. Виконується обробник `GET /tasks` у процесі проти бази з нуля.
 * 🧨 Червоніє, якщо прибрати поле, брати ПЕРШЕ закриття замість останнього, рахувати дату за UTC,
 * загубити автозакриті (без журналу) або лишити дату на задачі, яку повернули в роботу.
 */
test("#1963 ЗАДАЧНИК: видача віддає дату виконання — останнє «Готово» з журналу за Києвом, автозакриті — з дати закриття", async (t) => {
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
    await c.query(`INSERT INTO managers (id,name,is_active) VALUES (40,'Виконавець',true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,full_name) VALUES
        (1,'admin@uts.ua','x','admin',NULL,'Адмін'),(4,'exec@uts.ua','x','manager',40,NULL)`);
    const { tasksRouter } = await import("../routes/tasks.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (tasksRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const admin = { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null };
    async function call(method: string, p: string, params: Record<string, string> = {}, body: unknown = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p}`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as
        (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
      let code = 200; let payload: unknown;
      const res = { headersSent: false, status(x: number) { code = x; return res; }, json(b: unknown) { payload = b; return res; },
        send(b: unknown) { payload = b; return res; }, type() { return res; }, setHeader() { /* не потрібно */ } };
      await handler({ auth: admin, params, body, query: {}, headers: {}, originalUrl: p }, res, (e?: unknown) => { if (e) throw e; });
      return { code, payload: payload as Record<string, unknown> };
    }
    const doneAtOf = async (id: number) => {
      const rows = ((await call("GET", "/")).payload as unknown as { tasks: { id: number; doneAt?: string | null }[] }).tasks;
      const r = rows.find((x) => x.id === id);
      assert.ok(r, `задачі №${id} немає у видачі`);
      assert.ok("doneAt" in r!, "🔴 у видачі задач немає поля doneAt — новий екран не знатиме «виконано цього тижня»");
      return r!.doneAt ?? null;
    };
    const todayKyiv = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

    // 1. Ручне «Готово» через PATCH: дата — сьогодні за Києвом, з журналу (closed_at PATCH не пише).
    const made = await call("POST", "/", {}, { title: "Ручне закриття", assigneeId: 40 });
    const id = (made.payload as unknown as { id: number }).id;
    assert.equal(await doneAtOf(id), null, "🔴 активна задача має дату виконання");
    assert.equal((await call("PATCH", "/:id", { id: String(id) }, { status: "done" })).code, 204);
    assert.equal(await doneAtOf(id), todayKyiv, "🔴 ручне «Готово» не дало дати виконання");

    // 2. Закривали двічі — береться ОСТАННЄ «Готово», і за Києвом (21:30Z 15.10 = 00:30 16.10 у Києві).
    const twice = await c.query<{ id: number }>(`INSERT INTO tasks (title,status,assignee_id,created_by) VALUES ('Двічі','done',40,1) RETURNING id`);
    const tw = twice.rows[0].id;
    await c.query(`INSERT INTO task_status_log (task_id,from_status,to_status,changed_by,changed_at) VALUES
        ($1,'in_progress','done',1,'2026-10-01T10:00:00Z'),($1,'done','in_progress',1,'2026-10-05T10:00:00Z'),
        ($1,'in_progress','done',1,'2026-10-15T21:30:00Z')`, [tw]);
    assert.equal(await doneAtOf(tw), "2026-10-16", "🔴 дата виконання — не останнє «Готово» за Києвом");

    // 3. Автозакрита (як пропущений дзвінок): журналу немає, є closed_at — 22:30Z 18.10 = 19.10 у Києві.
    const auto = await c.query<{ id: number }>(
      `INSERT INTO tasks (title,status,assignee_id,created_by,closed_at) VALUES ('Авто','done',40,NULL,'2026-10-18T22:30:00Z') RETURNING id`);
    assert.equal(await doneAtOf(auto.rows[0].id), "2026-10-19", "🔴 автозакрита задача без журналу загубила дату виконання");

    // 4. 🪞 Повернули в роботу — дата зникає, хоч журнал її памʼятає.
    assert.equal((await call("PATCH", "/:id", { id: String(id) }, { status: "in_progress" })).code, 204);
    assert.equal(await doneAtOf(id), null, "🔴 повернута в роботу задача лишилась «виконаною»");

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #1964 — ВИБІР ДИЗАЙНУ В БРАУЗЕРІ. За замовчуванням — новий; старий — лише коли людина сама обрала;
 * вибір переживає перезавантаження. Сховище, що КИДАЄ (приватне вікно, заблоковані дані), — новий
 * дизайн і жодного падіння: інакше задачник відкривався б білим екраном.
 * 🧨 Червоніє, якщо прибрати `try`, якщо за замовчуванням стане старий, або якщо вибір «старий»
 * не запамʼятовується (дзеркало: функція, що завжди віддає «новий», теж пройшла б перші перевірки).
 */
test("#1964 ЗАДАЧНИК: дизайн за замовчуванням новий, обраний старий запамʼятовується, зламане сховище не валить екран", async () => {
  const R = await load();
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(R.readDesign(store), "new", "🔴 за замовчуванням не новий дизайн");
  assert.equal(R.readDesign(null), "new");
  R.writeDesign(store, "old");
  assert.equal(mem.get(R.TASKS_DESIGN_KEY), "old");
  assert.equal(R.readDesign(store), "old", "🔴 обраний старий дизайн не запамʼятовується");
  R.writeDesign(store, "new");
  assert.equal(R.readDesign(store), "new");
  mem.set(R.TASKS_DESIGN_KEY, "сміття");
  assert.equal(R.readDesign(store), "new", "🔴 невідоме значення в сховищі — не новий дизайн");
  const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.equal(R.readDesign(broken), "new", "🔴 зламане сховище не дало дизайн за замовчуванням");
  assert.doesNotThrow(() => R.writeDesign(broken, "old"), "🔴 запис у зламане сховище валить екран");
});

/**
 * #1965 — ОДНА ВИБІРКА НА ОБИДВА ДИЗАЙНИ, КНОПКА ПОВЕРНЕННЯ НА ВИДУ. Новий екран отримує задачі з тієї ж
 * `pickRows`, що й стара таблиця (вкладка, виконавець, група, пошук), — інакше лічильники рахували б
 * інший список, ніж показує сусідня вкладка. Кнопка «Старий дизайн» стоїть у смузі вкладок.
 * 🧨 Червоніє, якщо новому екрану передати сирий `tasks` замість `pickRows(tasks, false)`, якщо стара
 * таблиця перестане брати ту саму `pickRows`, або якщо зникне кнопка повернення.
 */
test("#1965 ЗАДАЧНИК: новий екран бере ту саму вибірку, що й таблиця, кнопка «Старий дизайн» — у смузі вкладок", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "TasksSection.tsx"), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
  const branch = src.slice(src.indexOf('if (design === "new") {'), src.indexOf("return renderTable(tasks);"));
  assert.ok(branch.length > 0, "🔴 гілки нового дизайну немає");
  assert.match(branch, /const \{ base \} = pickRows\(tasks, false\);/, "🔴 новий екран рахує не ту вибірку, що таблиця");
  assert.match(branch, /<TasksFocusView rows=\{rows\}/);
  assert.match(branch, /const rows = base\.filter\(/, "🔴 рядки нового екрана не з pickRows");
  assert.match(src, /const \{ base, synths \} = pickRows\(src, true\);/, "🔴 стара таблиця перестала брати спільну вибірку");
  assert.match(src, /readDesign\(browserStorage\(\)\)/, "🔴 вибір дизайну не читається з браузера");
  assert.match(src, /setDesign\(design === "new" \? "old" : "new"\)/, "🔴 кнопки перемикання дизайну немає");
  assert.match(src, /"↩ Старий дизайн" : "✨ Новий дизайн"/, "🔴 кнопка повернення до старого дизайну без підпису");
});

/**
 * #1966 — ВИПАДКОВЕ ЗАКРИТТЯ ВИПРАВЛЯЄТЬСЯ ОДНИМ КЛІКОМ (20.10.2026: галочкою випадково закрилась №5887).
 * Після галочки — сповіщення «Задачу закрито» з кнопкою «Скасувати», що повертає САМЕ попередній статус;
 * сповіщення — подія (8 с за `toastRules`, а не до закриття). На виконаній задачі — «↩ У роботу».
 * 🧨 Червоніє, якщо прибрати «Скасувати», якщо скасування ставить фіксований статус замість попереднього,
 * якщо сповіщення перестане бути подією, або якщо зникне «↩ У роботу».
 */
test("#1966 ЗАДАЧНИК: після галочки — «Скасувати» повертає попередній статус, на виконаній — «↩ У роботу»", () => {
  const read = (...p: string[]) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", ...p), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
  const sec = read("TasksSection.tsx");
  const done = sec.slice(sec.indexOf("onDone={(t) => {"), sec.indexOf("onReopen={(t) => {"));
  assert.ok(done.length > 0, "🔴 обробника галочки немає");
  assert.match(done, /const prev = t\.status;/, "🔴 попередній статус не запамʼятовується — скасувати нема куди");
  assert.match(done, /commitTask\(t\.id, \{ status: "done" \}\);/);
  assert.match(done, /action: \{ label: "Скасувати", run: \(\) => \{ patchTaskLocal\(t\.id, \{ status: prev, doneAt: null \}\); commitTask\(t\.id, \{ status: prev \}\); \} \}/,
    "🔴 «Скасувати» немає або воно повертає не попередній статус");
  assert.match(done, /event: true/, "🔴 сповіщення про закриття не подія — висітиме до ручного закриття");
  assert.match(sec, /onReopen=\{\(t\) => \{ patchTaskLocal\(t\.id, \{ status: "in_progress", doneAt: null \}\); commitTask\(t\.id, \{ status: "in_progress" \}\);/,
    "🔴 «↩ У роботу» не повертає задачу в роботу");
  const view = read("TasksFocusView.tsx");
  assert.match(view, /onClick=\{\(\) => onReopen\(t\)\}/, "🔴 кнопки «↩ У роботу» в рядку виконаної задачі немає");
  assert.match(view, /↩ У роботу/);
});

/**
 * #1967 — СТАТУС ЗМІНЮЄТЬСЯ З РЯДКА (Роман 21.10.2026: «змінювати статус задач з головного екрану»).
 * Плашка статусу в рядку — те саме меню, що в таблиці й картці (`StatusPicker`), з правами задачі від
 * сервера; «Готово» з меню йде через галочку, тобто разом зі «Скасувати».
 * 🧨 Червоніє, якщо повернути статичну плашку, загубити права (меню пустить «Готово» без права), або
 * якщо «Готово» з меню закриватиме задачу повз «Скасувати».
 */
test("#1967 ЗАДАЧНИК: статус змінюється з рядка тим самим меню з правами, «Готово» з меню — через «Скасувати»", () => {
  const read = (...p: string[]) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", ...p), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
  const view = read("TasksFocusView.tsx");
  assert.match(view, /<StatusPicker value=\{t\.status\} rights=\{t\.statusRights\} reviewerName=\{t\.reviewerName\}/,
    "🔴 у рядку немає меню статусу з правами задачі");
  assert.match(view, /onChange=\{\(st\) => \(st === "done" \? onDone\(t\) : onStatus\(t, st\)\)\}/,
    "🔴 «Готово» з меню йде повз «Скасувати»");
  const sec = read("TasksSection.tsx");
  assert.match(sec, /onStatus=\{\(t, status\) => \{ patchTaskLocal\(t\.id, \{ status \}\); commitTask\(t\.id, \{ status \}\); \}\}/,
    "🔴 зміна статусу з рядка не зберігається тим самим шляхом, що в таблиці");
});

/**
 * #1968 — СВОГО ІМЕНІ В РЯДКУ НЕ ПИШЕМО (Роман 21.10.2026: «не треба писати Денисюк Роман — це і так ясно,
 * бо це мій задачник»). Ім'я виконавця — лише на ЧУЖІЙ задачі; колонка зʼявляється, лише коли у списку є чужі.
 * 🧨 Червоніє, якщо ім'я знову друкуватиметься на моїх задачах або колонка стоятиме при списку лише з моїх.
 */
test("#1968 ЗАДАЧНИК: на моїх задачах свого імені немає, на чужих — ім'я виконавця", () => {
  const read = (...p: string[]) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", ...p), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
  const view = read("TasksFocusView.tsx");
  assert.match(view, /\{showAssignee && \(isMine\(t\) \? <span className="tf-who" \/> : <span className="tf-who"/,
    "🔴 ім'я виконавця друкується і на моїх задачах");
  const sec = read("TasksSection.tsx");
  assert.match(sec, /showAssignee=\{rows\.some\(\(t\) => !isMine\(t\)\)\} isMine=\{isMine\}/,
    "🔴 колонка імен не залежить від того, чи є в списку чужі задачі");
});
