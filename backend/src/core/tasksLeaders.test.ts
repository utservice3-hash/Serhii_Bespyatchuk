import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 👔 ЗАДАЧА КЕРІВНИКУ ЗА 3 КЛІКИ (задача 9377, Юлія 16.11.2026; Роман 17.11.2026: «роби»). Щоб поставити задачу
 * Андрію, Дарині, Василю, Віці, Лілі, Дмитру, треба було гортати список із 60 людей, обирати дедлайн окремо й
 * тиснути Ctrl+Enter. Тепер: «Поставити задачу» → текст → «Кому ставите» → керівник першою групою → Enter,
 * дедлайн підставлено. Роман 17.11.2026: «спочатку керівники (тімліди, Сергій, я, Даша і т.д.), потім менеджери
 * і інші». Керівник — роль «Тимлид» у Kommo (`managers.is_team_lead`) або роль акаунта з `LEADER_ROLES`.
 *
 * Гейти `#7880`–`#7882` виконують чистий модуль фронта `taskCreateRules.ts`; `#7883` звіряє, що діалог і роут
 * справді ним користуються.
 */
const spec = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/taskCreateRules.ts", import.meta.url).href.replace("/dist/", "/src/"));
type P = { id: number; name: string };
type M = P & { isTeamLead?: boolean };
type K = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean; isComposing?: boolean };
type A = { id: number; name: string; managerId: number | null; role?: string | null };
type Mod = {
  LEADERS_TITLE: string;
  LEADER_ROLES: readonly string[];
  pickGroupsLeadersFirst: (g: [string, P[]][], m: M[], a: A[], q: string) => [string, (P & { kind: string })[]][];
  defaultSharedDeadline: (today: string) => string;
  plainEnterSubmits: (e: K, o: { sharedIntent: boolean }) => boolean;
};
const load = async () => (await import(spec)) as Mod;
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
const root = path.join(import.meta.dirname, "..", "..", "..");
const read = (...p: string[]) => strip(readFileSync(path.join(root, ...p), "utf8"));

/**
 * #7880 — СПОЧАТКУ КЕРІВНИКИ, ПОТІМ УСІ ІНШІ. Керівники = тімліди з Kommo + акаунти з ролями адмін/КВП/СЕО/ОД
 * (і менеджер, привʼязаний до такого акаунта). Одна група першою, за абеткою; з команд і «Акаунтів» прибрані —
 * нікого двічі; команди далі в тому самому порядку; бухгалтерія/HR/фінансист/менеджер — не керівники;
 * пошук працює і в «Керівниках»; без керівників групи немає.
 * 🧨 Червоніє, якщо в «Керівники» потрапить менеджер без ролі (Юрко) чи бухгалтерія, якщо Сергій-акаунт або
 * Роман-менеджер (через роль акаунта) не потраплять, якщо керівник лишиться ще й у команді, або якщо група
 * стане не першою.
 */
test("#7880 КЕРІВНИКИ: першими — тімліди Kommo й акаунти адмін/КВП/СЕО/ОД, за абеткою, без дублів у командах; далі команди й акаунти", async () => {
  const R = await load();
  assert.deepEqual([...R.LEADER_ROLES].sort(), ["admin", "ceo", "kvp", "opdir"], "🔴 склад ролей-керівників змінився мовчки");
  const mgrs: M[] = [
    { id: 1, name: "Шаврова Лілія", isTeamLead: true }, { id: 2, name: "Юрко Дмитро", isTeamLead: false },
    { id: 3, name: "Безпамятний Андрій", isTeamLead: true }, { id: 4, name: "Пехньо Олександра" },
    { id: 5, name: "Денисюк Роман" },
  ];
  const teams: [string, P[]][] = [
    ["★ Моя команда · Шаврова", [{ id: 1, name: "Шаврова Лілія" }, { id: 4, name: "Пехньо Олександра" }]],
    ["Михальчевська", [{ id: 2, name: "Юрко Дмитро" }]], ["Безпамятний", [{ id: 3, name: "Безпамятний Андрій" }]],
    ["Без команди", [{ id: 5, name: "Денисюк Роман" }]],
  ];
  const acc: A[] = [
    { id: 50, name: "Денисюк Роман", managerId: 5, role: "admin" },
    { id: 1, name: "Сергій", managerId: null, role: "admin" },
    { id: 52, name: "Дарʼя Протас", managerId: null, role: "kvp" },
    { id: 60, name: "Бухгалтер Анастасія", managerId: null, role: "____________" },
    { id: 61, name: "Іван Романов", managerId: null, role: "hr" },
    { id: 62, name: "Тищенко Олександр", managerId: null, role: "financier" },
    { id: 63, name: "Юрко акаунт", managerId: 2, role: "manager" },
  ];
  const g = R.pickGroupsLeadersFirst(teams, mgrs, acc, "");
  const ids = g.map(([t, ps]) => [t, ps.map((p) => `${p.kind[0]}${p.id}`)]);
  assert.deepEqual(ids[0], [R.LEADERS_TITLE, ["m3", "a52", "m5", "a1", "m1"]], "🔴 «Керівники» не першою групою, не той склад або не за абеткою");
  assert.deepEqual(ids.slice(1), [
    ["★ Моя команда · Шаврова", ["m4"]], ["Михальчевська", ["m2"]],
    ["Акаунти (HR, бухгалтерія — кого немає в CRM)", ["a60", "a61", "a62"]],
  ], "🔴 керівник лишився ще й у команді/акаунтах, порожня команда не зникла, порядок команд змінився або бухгалтерія/HR/фінансист стали керівниками");
  const q = R.pickGroupsLeadersFirst(teams, mgrs, acc, "ДАР");
  assert.deepEqual(q.map(([t, ps]) => [t, ps.map((p) => p.id)]), [[R.LEADERS_TITLE, [52]]], "🔴 пошук не працює в «Керівниках» або регістр");
  const none = R.pickGroupsLeadersFirst(teams, mgrs.map((m) => ({ ...m, isTeamLead: false })), acc.map((a) => ({ ...a, role: "manager" })), "");
  assert.notEqual(none[0][0], R.LEADERS_TITLE, "🔴 без керівників лишився порожній заголовок");
  assert.equal(none.flatMap(([, ps]) => ps).length, 10, "🔴 без керівників хтось загубився");
});

/**
 * #7881 — ДЕДЛАЙН ЗА ЗАМОВЧУВАННЯМ — «ЗАВТРА» ВІД КИЇВСЬКОГО СЬОГОДНІ (9377: «Enter — задача створена з дедлайном»).
 * 🧨 Червоніє, якщо дедлайн стане «сьогодні» (задача прострочиться того ж вечора), або якщо зламається межа місяця чи року.
 */
test("#7881 КЕРІВНИКИ: дедлайн за замовчуванням — завтра, через межу місяця й року", async () => {
  const R = await load();
  assert.equal(R.defaultSharedDeadline("2026-11-17"), "2026-11-18", "🔴 дедлайн за замовчуванням не завтра");
  assert.equal(R.defaultSharedDeadline("2026-11-30"), "2026-12-01", "🔴 межа місяця");
  assert.equal(R.defaultSharedDeadline("2026-12-31"), "2027-01-01", "🔴 межа року");
});

/**
 * #7882 — ЗВИЧАЙНИЙ ENTER СТВОРЮЄ ЛИШЕ В «СПІЛЬНІЙ ЗАДАЧІ». Дзеркало: у звичайній «+ Додати» Enter — новий рядок.
 * 🧨 Червоніє, якщо Enter почне створювати звичайну задачу (обріже довгий опис), якщо Shift+Enter перестане
 * переносити рядок, якщо Enter під час набору IME створить задачу, або якщо в «Спільній» Enter не створюватиме.
 */
test("#7882 КЕРІВНИКИ: Enter створює лише в «Спільній задачі»; Shift/Ctrl/⌘/Alt+Enter і набір IME — ні; у «+ Додати» — новий рядок", async () => {
  const R = await load();
  const k = (o: Partial<K> = {}): K => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...o });
  const shared = { sharedIntent: true }, plain = { sharedIntent: false };
  assert.equal(R.plainEnterSubmits(k(), shared), true, "🔴 у «Спільній задачі» Enter не створює");
  assert.equal(R.plainEnterSubmits(k(), plain), false, "🔴 Enter створює звичайну задачу — довгий опис обріжеться");
  assert.equal(R.plainEnterSubmits(k({ shiftKey: true }), shared), false, "🔴 Shift+Enter не переносить рядок");
  assert.equal(R.plainEnterSubmits(k({ isComposing: true }), shared), false, "🔴 Enter під час набору IME створює задачу");
  assert.equal(R.plainEnterSubmits(k({ ctrlKey: true }), shared), false, "🔴 Ctrl+Enter спрацює двічі (тут і в діалозі)");
  assert.equal(R.plainEnterSubmits(k({ metaKey: true }), shared), false, "🔴 ⌘+Enter спрацює двічі");
  assert.equal(R.plainEnterSubmits(k({ altKey: true }), shared), false);
  assert.equal(R.plainEnterSubmits(k({ key: "a" }), shared), false, "🔴 створює будь-яка клавіша");
});

/**
 * #7883 — РОУТИ ВІДДАЮТЬ ОЗНАКИ, ДІАЛОГ НИМИ КОРИСТУЄТЬСЯ. `/teams/managers` → `isTeamLead`, `/tasks/assignees` →
 * ефективна `role`; вибір виконавця будує групи через `pickGroupsLeadersFirst`; після вибору людини курсор
 * повертається в опис (щоб Enter створив); Enter в описі — через `plainEnterSubmits` у той самий `submit`;
 * дедлайн підставляється лише в «Спільній» і не перетирає обраний.
 * 🧨 Червоніє, якщо роут перестане віддавати ознаку (блок мовчки зникне), якщо вибір виконавця піде в обхід
 * правила, якщо курсор не повернеться, якщо Enter обійде `submit`, або якщо дедлайн перетре вже обраний.
 */
test("#7883 КЕРІВНИКИ: роути віддають isTeamLead і role; діалог — pickGroupsLeadersFirst, курсор в опис після вибору, Enter через submit, дедлайн не перетирає", () => {
  const route = read("backend", "src", "routes", "teams.ts");
  assert.match(route, /SELECT m\.id, m\.name, m\.team_id AS "teamId", t\.name AS "teamName", m\.is_team_lead AS "isTeamLead"/, "🔴 /teams/managers не віддає isTeamLead — тімліди мовчки зникнуть із «Керівників»");
  const tasks = read("backend", "src", "routes", "tasks.ts");
  assert.match(tasks, /u\.manager_id AS "managerId", COALESCE\(u\.role_override, u\.role\) AS role FROM users u/, "🔴 /tasks/assignees не віддає ефективну роль — керівництво мовчки зникне з «Керівників»");
  const dlg = read("frontend", "src", "pages", "dashboard", "sections", "TaskCreateDialog.tsx");
  assert.match(dlg, /const groups = useMemo\(\(\) => pickGroupsLeadersFirst\(teamGroups\(managerOptions, myTeamId\), managerOptions, accounts, query\)/, "🔴 вибір виконавця без «Керівників» першими");
  assert.match(dlg, /setPop\(null\); setQuery\(""\); titleRef\.current\?\.focus\(\); \};/, "🔴 після вибору людини курсор не повертається в опис — Enter нічого не створить");
  assert.match(dlg, /if \(plainEnterSubmits\(\{[^}]*isComposing: e\.nativeEvent\.isComposing \}, \{ sharedIntent \}\)\) \{ e\.preventDefault\(\); submit\(\); \}/, "🔴 Enter в описі обходить submit або правило");
  assert.match(dlg, /const submit = \(\) => \{ if \(missing\.length === 0\) onSubmit\(\); \};/, "🔴 submit не перевіряє, чого бракує");
  assert.match(dlg, /if \(sharedIntent\) setForm\(\(f\) => \(f\.deadline \? f : \{ \.\.\.f, deadline: defaultSharedDeadline\(kyivDate\(new Date\(\)\)\) \}\)\);/,
    "🔴 дедлайн не підставляється в «Спільній» або перетирає обраний");
});
