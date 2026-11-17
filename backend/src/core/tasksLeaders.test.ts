import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 👔 ЗАДАЧА КЕРІВНИКУ ЗА 3 КЛІКИ (задача 9377, Юлія 16.11.2026; Роман 17.11.2026: «роби»). Щоб поставити задачу
 * Андрію, Дарині, Василю, Віці, Лілі, Дмитру, треба було гортати список із 60 людей, обирати дедлайн окремо й
 * тиснути Ctrl+Enter. Тепер: «Поставити задачу» → текст → керівник (ряд кнопок) → Enter, дедлайн підставлено.
 * Керівник — роль «Тимлид» у Kommo (`managers.is_team_lead`), тож список — дзеркало CRM.
 *
 * Гейти `#7880`–`#7882` виконують чистий модуль фронта `taskCreateRules.ts`; `#7883` звіряє, що діалог і роут
 * справді ним користуються.
 */
const spec = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/taskCreateRules.ts", import.meta.url).href.replace("/dist/", "/src/"));
type P = { id: number; name: string };
type M = P & { isTeamLead?: boolean };
type K = { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean; isComposing?: boolean };
type Mod = {
  LEADERS_TITLE: string;
  withLeaders: (g: [string, P[]][], o: M[], selfId?: number | null) => [string, P[]][];
  leadersOf: (o: M[], selfId?: number | null) => P[];
  pickGroups: (g: [string, P[]][], a: P[], q: string) => [string, (P & { kind: string })[]][];
  defaultSharedDeadline: (today: string) => string;
  plainEnterSubmits: (e: K, o: { sharedIntent: boolean }) => boolean;
};
const load = async () => (await import(spec)) as Mod;
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
const root = path.join(import.meta.dirname, "..", "..", "..");
const read = (...p: string[]) => strip(readFileSync(path.join(root, ...p), "utf8"));

/**
 * #7880 — «КЕРІВНИКИ» ПЕРШОЮ ГРУПОЮ, І ЛИШЕ ТІМЛІДИ. За абеткою, без мене; людина лишається і в своїй команді;
 * немає жодного тімліда — групи немає; пошук працює і в ній.
 * 🧨 Червоніє, якщо в «Керівники» потрапить не-тімлід (Юрко поруч із Безпамʼятним), якщо група стане не першою,
 * якщо тімлід зникне зі своєї команди, якщо я буду серед керівників сам собі, або якщо без тімлідів лишиться
 * порожній заголовок.
 */
test("#7880 КЕРІВНИКИ: першою групою, лише тімліди з Kommo, за абеткою, без мене; у своїй команді лишаються; нема — групи нема", async () => {
  const R = await load();
  const opts: M[] = [
    { id: 1, name: "Шаврова Лілія", isTeamLead: true },
    { id: 2, name: "Юрко Дмитро", isTeamLead: false },
    { id: 3, name: "Безпамятний Андрій", isTeamLead: true },
    { id: 4, name: "Пехньо Олександра" },
    { id: 5, name: "Я Тімлід", isTeamLead: true },
  ];
  const teams: [string, P[]][] = [["Шаврова team lead", [{ id: 1, name: "Шаврова Лілія" }, { id: 4, name: "Пехньо Олександра" }]], ["Михальчевська", [{ id: 2, name: "Юрко Дмитро" }]]];
  const g = R.withLeaders(teams, opts, 5);
  assert.equal(g[0][0], R.LEADERS_TITLE, "🔴 «Керівники» не першою групою");
  assert.deepEqual(g[0][1].map((p) => p.id), [3, 1], "🔴 у «Керівниках» не-тімлід, я сам, або не за абеткою");
  assert.deepEqual(g.slice(1).map(([t, ps]) => [t, ps.map((p) => p.id)]), [["Шаврова team lead", [1, 4]], ["Михальчевська", [2]]],
    "🔴 тімлід зник зі своєї команди або команди переставились");
  assert.deepEqual(R.withLeaders(teams, opts.map((m) => ({ ...m, isTeamLead: false }))).map(([t]) => t), ["Шаврова team lead", "Михальчевська"],
    "🔴 без тімлідів лишився порожній заголовок «Керівники»");
  assert.deepEqual(R.leadersOf([...opts, { id: 3, name: "Безпамятний Андрій", isTeamLead: true }]).map((p) => p.id), [3, 1, 5], "🔴 дубль тімліда в ряду кнопок");
  const q = R.pickGroups(R.withLeaders(teams, opts, 5), [], "безп");
  assert.deepEqual(q.map(([t, ps]) => [t, ps.map((p) => p.id)]), [[R.LEADERS_TITLE, [3]]], "🔴 пошук не працює в «Керівниках»");
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
 * #7883 — ДІАЛОГ І РОУТ СПРАВДІ ЦИМ КОРИСТУЮТЬСЯ. `/teams/managers` віддає `isTeamLead` з `is_team_lead`; вибір
 * виконавця будує групи через `withLeaders`; ряд керівників — лише в «Спільній задачі», клік обирає й повертає
 * курсор в опис; Enter в описі йде через `plainEnterSubmits` у той самий `submit` (з перевіркою «бракує»);
 * дедлайн підставляється лише в «Спільній» і не перетирає обраний.
 * 🧨 Червоніє, якщо роут перестане віддавати ознаку (блок мовчки зникне), якщо ряд керівників зʼявиться у звичайній
 * формі, якщо після кліку курсор не повернеться (Enter натисне кнопку вдруге), якщо Enter обійде `submit`, або якщо
 * дедлайн перетре вже обраний.
 */
test("#7883 КЕРІВНИКИ: роут віддає isTeamLead; діалог — withLeaders, ряд лише в «Спільній» з фокусом в опис, Enter через submit, дедлайн не перетирає", () => {
  const route = read("backend", "src", "routes", "teams.ts");
  assert.match(route, /SELECT m\.id, m\.name, m\.team_id AS "teamId", t\.name AS "teamName", m\.is_team_lead AS "isTeamLead"/, "🔴 /teams/managers не віддає isTeamLead — блок «Керівники» мовчки порожній");
  const dlg = read("frontend", "src", "pages", "dashboard", "sections", "TaskCreateDialog.tsx");
  assert.match(dlg, /const groups = useMemo\(\(\) => pickGroups\(withLeaders\(teamGroups\(managerOptions, myTeamId\), managerOptions, selfManagerId\), plainAccounts, query\)/, "🔴 вибір виконавця без «Керівників»");
  assert.match(dlg, /\{sharedIntent && leaders\.length > 0 && \( <div className="tc-chips tc-leads"/, "🔴 ряд керівників не лише в «Спільній задачі»");
  assert.match(dlg, /pick\(\{ kind: "manager", id: l\.id, name: l\.name \}\); titleRef\.current\?\.focus\(\);/, "🔴 клік по керівнику не обирає або не повертає курсор в опис");
  assert.match(dlg, /if \(plainEnterSubmits\(\{[^}]*isComposing: e\.nativeEvent\.isComposing \}, \{ sharedIntent \}\)\) \{ e\.preventDefault\(\); submit\(\); \}/, "🔴 Enter в описі обходить submit або правило");
  assert.match(dlg, /const submit = \(\) => \{ if \(missing\.length === 0\) onSubmit\(\); \};/, "🔴 submit не перевіряє, чого бракує");
  assert.match(dlg, /if \(sharedIntent\) setForm\(\(f\) => \(f\.deadline \? f : \{ \.\.\.f, deadline: defaultSharedDeadline\(kyivDate\(new Date\(\)\)\) \}\)\);/,
    "🔴 дедлайн не підставляється в «Спільній» або перетирає обраний");
});
