import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 📤 «СПІЛЬНІ → ПОСТАВЛЕНІ МНОЮ» (задача 9711, Юлія Левентова 16.11.2026; макет погоджено Романом 17.11.2026).
 *
 * Юлія ставить задачі менеджерам і тімлідам і не бачить їх ніде: «Спільні» показували лише вхідні, тож
 * вона робила собі копії в групах. Тепер у «Спільних» два напрямки, і «Поставлені мною» групуються по
 * виконавцю або команді. Однаково для всіх ролей.
 *
 * `#7850`, `#7851`, `#7853` ВИКОНУЮТЬ чистий модуль фронта `pages/dashboard/tasksFocus.ts` (як `#1960`–`#1964`);
 * `#7852` читає джерело екрана, бо гілку вибірки й перемикач без браузера інакше не побачити.
 */
const spec = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/tasksFocus.ts", import.meta.url).href.replace("/dist/", "/src/"));
type T = {
  id: number; status: string; deadline?: string | null; doneAt?: string | null;
  createdById?: number | null; assigneeId: number | null; assigneeUserId?: number | null;
  assigneeName?: string | null; assigneeTeamId?: number | null; taskType?: string;
};
type G = { key: string; label: string; team: string | null; items: T[]; active: number; late: number; review: number };
type Mod = {
  isSetByMe: (t: T, me: { userId?: number | null; managerId?: number | null }) => boolean;
  ownerGroups: (tasks: T[], by: "person" | "team", today: string, teamName: (id: number) => string | null | undefined) => G[];
  OWNER_NO_TEAM: string;
  readOwnerGroupBy: (s: unknown) => "person" | "team";
  writeOwnerGroupBy: (s: unknown, v: "person" | "team") => void;
  OWNER_GROUP_KEY: string;
};
const load = async () => (await import(spec)) as Mod;

/**
 * #7850 — «ПОСТАВЛЕНІ МНОЮ» = АВТОР Я, ВИКОНАВЕЦЬ ІНШИЙ. Фікстури по обидва боки кожної умови:
 * моя задача менеджеру й акаунту — так; моя собі (як менеджеру, як акаунту) — ні; моя без виконавця — ні;
 * чужа — ні; прихований день KPI — ні; глядач без акаунта — ні (інакше `undefined === undefined`).
 * 🧨 Червоніє, якщо прибрати умову «виконавець не я» (задача собі стане «поставленою іншому»), умову
 * «автор я» (вкладка покаже чужі), або перевірку, що виконавець узагалі є.
 */
test("#7850 ПОСТАВЛЕНІ МНОЮ: автор я, виконавець інший (менеджер чи акаунт); собі, без виконавця, чуже й дні KPI — ні", async () => {
  const R = await load();
  const me = { userId: 47, managerId: 300 };
  const t = (o: Partial<T>): T => ({ id: 1, status: "not_started", assigneeId: null, createdById: 47, ...o });
  assert.equal(R.isSetByMe(t({ assigneeId: 301 }), me), true, "🔴 задача, яку я поставив менеджеру, не потрапила в «Поставлені мною»");
  assert.equal(R.isSetByMe(t({ assigneeUserId: 52 }), me), true, "🔴 задача, поставлена АКАУНТУ (бухгалтерія, HR), загубилась");
  assert.equal(R.isSetByMe(t({ assigneeId: 300 }), me), false, "🔴 задача САМОМУ СОБІ (як менеджеру) стала «поставленою іншому»");
  assert.equal(R.isSetByMe(t({ assigneeUserId: 47 }), me), false, "🔴 задача самому собі (як акаунту) стала «поставленою іншому»");
  assert.equal(R.isSetByMe(t({}), me), false, "🔴 задача без виконавця (моя власна) потрапила в «Поставлені мною»");
  assert.equal(R.isSetByMe(t({ createdById: 1, assigneeId: 301 }), me), false, "🔴 ЧУЖА задача (автор не я) потрапила в «Поставлені мною»");
  assert.equal(R.isSetByMe(t({ createdById: null, assigneeId: 301 }), me), false, "🔴 задача без автора стала моєю");
  assert.equal(R.isSetByMe(t({ assigneeId: 301, taskType: "daily_kpi" }), me), false, "🔴 прихований день KPI виліз у список");
  assert.equal(R.isSetByMe(t({ assigneeId: 301, taskType: "kpi_period" }), me), true, "🔴 план KPI тімліда загубився (він іде окремою групою, але він «поставлений мною»)");
  assert.equal(R.isSetByMe(t({ createdById: undefined, assigneeId: 301 }), { userId: undefined, managerId: null }), false,
    "🔴 глядач без акаунта отримав чужі задачі: undefined === undefined");
  // Глядач без картки менеджера (КВП, бухгалтерія): задача будь-якому менеджеру — поставлена іншому.
  assert.equal(R.isSetByMe(t({ assigneeId: 300 }), { userId: 47, managerId: null }), true,
    "🔴 у глядача без картки менеджера задача менеджеру не рахується поставленою іншому");
});

/**
 * #7851 — ГРУПИ ПО ВИКОНАВЦЮ / КОМАНДІ. Ключ — ID, не імʼя: двоє тезок — дві групи. Хто без команди —
 * «Поза командами», а не порожній заголовок. Прострочені й «чекає прийняття» пораховані в групі; виконані
 * раніше цього тижня в групи не йдуть (вони у «Виконано раніше»); групи з простроченими — зверху.
 * 🧨 Червоніє, якщо групувати за імʼям (тезки зіллються), якщо безкомандні отримають порожню назву чи
 * загубляться, якщо прострочені рахуватимуться з `<=` (дедлайн сьогодні — ще не прострочено), або якщо
 * виконане місяць тому опиниться в групі людини.
 */
test("#7851 ПОСТАВЛЕНІ МНОЮ: групи по людині (за ID) і команді, «Поза командами», прострочені й прийняття пораховані, давнє виконане — поза групами", async () => {
  const R = await load();
  const today = "2026-11-17"; // вівторок; тиждень 16–22.11
  const teams: Record<number, string> = { 5: "Безпамятний Team lead", 6: "Михальчевська Team Lead" };
  const tn = (id: number) => teams[id];
  const base = { createdById: 47, assigneeUserId: null };
  const tasks: T[] = [
    { ...base, id: 1, status: "in_progress", deadline: "2026-11-12", assigneeId: 10, assigneeName: "Безпамятний Андрій", assigneeTeamId: 5 },
    { ...base, id: 2, status: "not_started", deadline: "2026-11-17", assigneeId: 10, assigneeName: "Безпамятний Андрій", assigneeTeamId: 5 },
    { ...base, id: 3, status: "done", deadline: "2026-11-16", doneAt: "2026-11-16", assigneeId: 10, assigneeName: "Безпамятний Андрій", assigneeTeamId: 5 },
    { ...base, id: 4, status: "done", deadline: "2026-10-01", doneAt: "2026-10-01", assigneeId: 10, assigneeName: "Безпамятний Андрій", assigneeTeamId: 5 },
    { ...base, id: 5, status: "ready_for_approval", deadline: "2026-11-20", assigneeId: 11, assigneeName: "Зейдан Максим", assigneeTeamId: 5 },
    // Тезка Андрія з іншої команди — мусить бути ОКРЕМОЮ групою.
    { ...base, id: 6, status: "not_started", deadline: null, assigneeId: 12, assigneeName: "Безпамятний Андрій", assigneeTeamId: 6 },
    // Акаунт без команди й без імені.
    { ...base, id: 7, status: "in_progress", deadline: "2026-11-25", assigneeId: null, assigneeUserId: 52, assigneeName: "Бухгалтер Анастасія", assigneeTeamId: null },
    { ...base, id: 8, status: "in_progress", deadline: "2026-11-25", assigneeId: 13, assigneeName: null, assigneeTeamId: 6 },
  ];

  const person = R.ownerGroups(tasks, "person", today, tn);
  const ids = (g: G) => g.items.map((t) => t.id);
  const andrii = person.filter((g) => g.label === "Безпамятний Андрій");
  assert.equal(andrii.length, 2, "🔴 ТЕЗКИ ЗЛИЛИСЬ: групу зібрано за імʼям, а не за ID виконавця");
  const a10 = person.find((g) => g.key === "m:10")!;
  assert.deepEqual(ids(a10), [1, 2, 3], "🔴 у групі людини: активні за дедлайном, далі виконане цього тижня; давнє виконане (#4) — поза групою");
  assert.equal(a10.active, 2);
  assert.equal(a10.late, 1, "🔴 прострочених не 1: дедлайн сьогодні ще не прострочений, позавчорашній — прострочений");
  assert.equal(a10.team, "Безпамятний Team lead");
  assert.equal(person[0].key, "m:10", "🔴 група з простроченими не зверху");
  const acc = person.find((g) => g.key === "u:52")!;
  assert.ok(acc, "🔴 задача акаунту загубилась із груп");
  assert.equal(acc.team, R.OWNER_NO_TEAM, "🔴 безкомандний виконавець без підпису «Поза командами»");
  assert.equal(person.find((g) => g.key === "m:13")!.label, "Без імені", "🔴 виконавець без імені дав порожній заголовок");
  assert.equal(person.find((g) => g.key === "m:11")!.review, 1, "🔴 «чекає прийняття» не пораховано");
  assert.equal(person.flatMap(ids).length, 7, "🔴 кожна задача (крім давно виконаної) мусить бути рівно в одній групі");

  const team = R.ownerGroups(tasks, "team", today, tn);
  const t5 = team.find((g) => g.key === "t:5")!;
  assert.equal(t5.label, "Безпамятний Team lead");
  assert.deepEqual(ids(t5).sort(), [1, 2, 3, 5], "🔴 команда зібрала не своїх або загубила своїх");
  assert.equal(t5.team, null);
  assert.equal(team.find((g) => g.key === "t:none")!.label, R.OWNER_NO_TEAM, "🔴 безкомандні в групі без назви");
  assert.equal(R.ownerGroups(tasks, "team", today, () => undefined).find((g) => g.key === "t:5")!.label, "Команда #5",
    "🔴 невідома команда дала порожню назву групи");
});

/**
 * #7852 — ЕКРАН: перемикач «Мені поставили / Поставлені мною» у «Спільних», ВЛАСНА гілка вибірки, що кличе
 * саме `isSetByMe`, і стоїть вона ПЕРЕД гілкою вхідних. Умова написана ланцюгом `else if`, тож гілка, що
 * стоїть ПІСЛЯ `adminTab === "shared"`, не спрацює ніколи: перемикач клацається, а список лишається вхідним.
 * Новий дизайн отримує групування лише в «Поставлених мною».
 * 🪞 Дзеркало: вхідна гілка `#400m` лишилась дослівно, а число на вкладці — це досі вхідні (`sharedOpen`).
 * 🧨 Червоніє, якщо прибрати гілку, переставити її після вхідної, підмінити предикат або прибрати перемикач.
 */
test("#7852 ЕКРАН «СПІЛЬНІ»: перемикач напрямку, гілка «Поставлені мною» перед вхідною й кличе isSetByMe, групування лише в ній", () => {
  const code = (...rel: string[]) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", ...rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
  const src = code("pages", "dashboard", "sections", "TasksSection.tsx");

  assert.match(src, /const isSetByMeT = \(t: Task\) => isSetByMe\(t, \{ userId: currentUserId, managerId: currentManagerId \}\)/,
    "🔴 екран не кличе правило `isSetByMe` з tasksFocus.ts — отже рахує «поставлені мною» інакше, ніж перевіряє #7850");
  const byMe = src.indexOf('else if (adminTab === "shared" && sharedSide === "byMe") { base = base.filter(isSetByMeT); synths = []; }');
  const toMe = src.indexOf('else if (adminTab === "shared") { base = base.filter(isSharedWithMe); synths = []; }');
  assert.ok(byMe >= 0, "🔴 НЕМАЄ ГІЛКИ «ПОСТАВЛЕНІ МНОЮ»: перемикач клацається, а список лишається вхідним");
  assert.ok(toMe >= 0, "🔴 зникла вхідна гілка «Спільних» (#400m)");
  assert.ok(byMe < toMe, "🔴 ГІЛКА «ПОСТАВЛЕНІ МНОЮ» ПІСЛЯ ВХІДНОЇ: ланцюг else-if зупиниться на вхідній, і вона не спрацює ніколи");

  assert.match(src, /onClick=\{\(\) => setSharedSide\("toMe"\)\}/, "🔴 немає кнопки «Мені поставили» — повернутись до вхідних нема як");
  assert.match(src, /onClick=\{\(\) => setSharedSide\("byMe"\)\}/, "🔴 немає кнопки «Поставлені мною»");
  assert.match(src, /📤 Поставлені мною/, "🔴 підпис не той, що погоджено («Поставлені мною»)");
  assert.match(src, /useState<"toMe" \| "byMe">\("toMe"\)/, "🔴 за замовчуванням мусять бути вхідні — так «Спільні» працювали завжди");
  assert.match(src, /const byMeView = adminTab === "shared" && sharedSide === "byMe";/, "🔴 новий дизайн не знає, що це «Поставлені мною»");
  assert.match(src, /owner=\{byMeView \? \{ by: ownerBy, teamName: teamNameOf \} : null\}/,
    "🔴 групування по виконавцю/команді не передано в новий дизайн — або передано й ВХІДНИМ");
  // 🪞 Число на вкладці — досі вхідні.
  assert.match(src, /🤝 Спільні задачі\{sharedOpen\.length > 0 \? ` · \$\{sharedOpen\.length\}` : ""\}/,
    "🔴 число на вкладці «Спільні» перестало бути числом вхідних");

  const view = code("pages", "dashboard", "sections", "TasksFocusView.tsx");
  assert.match(view, /const groups = owner \? ownerGroups\(rows, owner\.by, today, owner\.teamName\)\.map\(ownerGroup\)/,
    "🔴 новий дизайн не будує групи по людині, коли їх просять");
  assert.match(view, /\{!owner && group\("doneWeek"/, "🔴 виконане цього тижня показано двічі: і в групі людини, і окремою групою");
});

/**
 * #7853 — ВИБІР ГРУПУВАННЯ ПАМʼЯТАЄ БРАУЗЕР; за замовчуванням — «по виконавцю»; зламане сховище екран не валить.
 * 🧨 Червоніє, якщо за замовчуванням стане «по команді», якщо збережене «team» не прочитається, або якщо
 * сховище, що кидає (приватне вікно), кине й тут.
 */
test("#7853 ПОСТАВЛЕНІ МНОЮ: групування за замовчуванням по виконавцю, обране запамʼятовується, зламане сховище не валить", async () => {
  const R = await load();
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(R.readOwnerGroupBy(store), "person", "🔴 за замовчуванням не «по виконавцю»");
  R.writeOwnerGroupBy(store, "team");
  assert.equal(mem.get(R.OWNER_GROUP_KEY), "team");
  assert.equal(R.readOwnerGroupBy(store), "team", "🔴 обране «по команді» не запамʼяталось");
  const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.equal(R.readOwnerGroupBy(broken), "person", "🔴 зламане сховище не дало значення за замовчуванням");
  assert.doesNotThrow(() => R.writeOwnerGroupBy(broken, "team"), "🔴 зламане сховище валить екран при перемиканні");
  assert.equal(R.readOwnerGroupBy(null), "person");
});
