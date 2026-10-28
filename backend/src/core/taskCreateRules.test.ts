import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🆕 ФОРМА СТВОРЕННЯ ЗАДАЧІ — варіант А (рішення Романа 26.10.2026: «роби А»). Гейти виконують чистий модуль
 * фронта `pages/dashboard/taskCreateRules.ts`, а `#2393` звіряє, що діалог шле ті самі поля, що й стара форма.
 */
const spec = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/taskCreateRules.ts", import.meta.url).href.replace("/dist/", "/src/"));
type In = { title: string; strategic: boolean; goalResult: string; assigneeId: number | ""; assigneeUserId: number | "" };
type Mod = {
  formMissing: (f: In, o: { sharedIntent: boolean }) => string[];
  quickDates: (today: string) => { label: string; date: string }[];
  pickGroups: (g: [string, { id: number; name: string }[]][], a: { id: number; name: string }[], q: string) => [string, { kind: string; id: number; name: string }[]][];
};
const load = async () => (await import(spec)) as Mod;
const code = (...p: string[]) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", ...p), "utf8")
  .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");

/**
 * #2390 — «ЧОГО БРАКУЄ» СЛОВАМИ (26.10.2026: Роман тиснув «Створити» на цілі без результату, і нічого не
 * відбувалось). Назва — завжди; результат — лише для цілі; «кому ставите» — лише зі «Спільних». Повна форма —
 * порожній список (дзеркало: правило не блокує зайвого).
 * 🧨 Червоніє, якщо ціль без результату пройде, якщо результат вимагатимуть у звичайної задачі, або якщо зі
 * «Спільних» можна буде створити без виконавця (тобто собі, мовчки).
 */
test("#2390 ФОРМА: «бракує» — опис завжди, результат лише для цілі, «кому ставите» лише зі «Спільних»; повна форма — порожньо", async () => {
  const R = await load();
  const f: In = { title: "Замінити віджет", strategic: false, goalResult: "", assigneeId: "", assigneeUserId: "" };
  assert.deepEqual(R.formMissing(f, { sharedIntent: false }), [], "🔴 звичайна задача без виконавця заблокована — це особиста, вона дозволена");
  assert.deepEqual(R.formMissing({ ...f, title: "  " }, { sharedIntent: false }), ["опис задачі"]);
  assert.deepEqual(R.formMissing({ ...f, strategic: true }, { sharedIntent: false }), ["результат стратегічної задачі"], "🔴 ціль без результату пройде");
  assert.deepEqual(R.formMissing({ ...f, strategic: true, goalResult: "≥ 3 млн" }, { sharedIntent: false }), []);
  assert.deepEqual(R.formMissing({ ...f, goalResult: "" }, { sharedIntent: false }), [], "🔴 результат вимагають у звичайної задачі");
  assert.deepEqual(R.formMissing(f, { sharedIntent: true }), ["кому ставите"], "🔴 зі «Спільних» можна створити без виконавця");
  assert.deepEqual(R.formMissing({ ...f, assigneeUserId: 7 }, { sharedIntent: true }), [], "🔴 акаунт-виконавець не рахується як «кому»");
  assert.deepEqual(R.formMissing({ title: "", strategic: true, goalResult: "", assigneeId: "", assigneeUserId: "" }, { sharedIntent: true }),
    ["опис задачі", "результат стратегічної задачі", "кому ставите"], "🔴 порядок «бракує» не той, у якому людина заповнює форму");
});

/**
 * #2391 — ШВИДКІ ДАТИ ВІД КИЇВСЬКОГО «СЬОГОДНІ». «Пʼятниця» — найближча ПІСЛЯ сьогодні (у пʼятницю й вихідні —
 * наступного тижня), «Наст. тиждень» — понеділок наступного тижня; межі з обох боків.
 * 🧨 Червоніє, якщо у пʼятницю «Пʼятниця» дасть сьогодні (дедлайн «на зараз» замість кінця тижня), якщо в суботу
 * — минулу пʼятницю, або якщо в понеділок «наступний тиждень» дасть цей самий понеділок.
 */
test("#2391 ФОРМА: швидкі дати — завтра, найближча пʼятниця після сьогодні, понеділок наступного тижня; межі з обох боків", async () => {
  const R = await load();
  const at = (d: string) => Object.fromEntries(R.quickDates(d).map((q) => [q.label, q.date]));
  assert.deepEqual(at("2026-10-26"), { "Сьогодні": "2026-10-26", "Завтра": "2026-10-27", "Пʼятниця": "2026-10-30", "Наст. тиждень": "2026-11-02" });
  assert.equal(at("2026-10-29")["Пʼятниця"], "2026-10-30", "🔴 у четвер «Пʼятниця» — не завтра");
  assert.equal(at("2026-10-30")["Пʼятниця"], "2026-11-06", "🔴 у пʼятницю «Пʼятниця» — сьогодні");
  assert.equal(at("2026-10-31")["Пʼятниця"], "2026-11-06", "🔴 у суботу «Пʼятниця» — минула");
  assert.equal(at("2026-11-01")["Наст. тиждень"], "2026-11-02", "🔴 у неділю «наступний тиждень» — не завтрашній понеділок");
  assert.equal(at("2026-11-02")["Наст. тиждень"], "2026-11-09", "🔴 у понеділок «наступний тиждень» — цей самий понеділок");
  assert.equal(at("2026-12-31")["Завтра"], "2027-01-01", "🔴 завтра через Новий рік зламалось");
});

/**
 * #2392 — ВИБІР ВИКОНАВЦЯ З ПОШУКОМ: групи менеджерів у порядку `teamGroups` (моя команда першою), потім акаунти;
 * пошук без регістру по частині імені; порожні групи зникають.
 * 🧨 Червоніє, якщо акаунти стануть перед командою, якщо пошук стане чутливим до регістру або загубить
 * збіг посеред імені, або якщо порожні групи лишатимуться заголовками без людей.
 */
test("#2392 ФОРМА: виконавці — моя команда першою, акаунти в кінці, пошук без регістру, порожні групи зникають", async () => {
  const R = await load();
  const teams: [string, { id: number; name: string }[]][] = [
    ["★ Моя команда · РПК", [{ id: 1, name: "Шаврова Лілія" }, { id: 2, name: "Левентова Юлія" }]],
    ["РНК", [{ id: 4, name: "Пехньо Олександра" }]],
  ];
  const acc = [{ id: 101, name: "Бухгалтерія" }];
  const all = R.pickGroups(teams, acc, "");
  assert.deepEqual(all.map(([t]) => t), ["★ Моя команда · РПК", "РНК", "Акаунти (HR, бухгалтерія — кого немає в CRM)"], "🔴 порядок груп не той");
  assert.equal(all[2][1][0].kind, "account");
  const q = R.pickGroups(teams, acc, "ЛІЛ");
  assert.deepEqual(q.map(([t, ps]) => [t, ps.map((p) => p.id)]), [["★ Моя команда · РПК", [1]]], "🔴 пошук чутливий до регістру, не знаходить посеред імені, або лишає порожні групи");
  assert.deepEqual(R.pickGroups(teams, acc, "немаєтакого"), [], "🔴 «нікого не знайдено» показує порожні заголовки");
});

/**
 * #2393 — ДІАЛОГ ШЛЕ ТЕ САМЕ, ЩО СТАРА ФОРМА. Діалог змінює вигляд, а не запит: стан — той самий `TaskForm`,
 * подання — той самий `handleSubmitTaskModal`, і кожне поле має свій контрол (виконавець-менеджер або акаунт,
 * другий виконавець, «Приймає», дедлайн, пріоритет, департамент, коментар, ціль і результат, підзадача).
 * KPI-план і Реактивація відкривають свої форми. Ctrl/⌘+Enter створює, лише коли нічого не бракує.
 * 🧨 Червоніє, якщо загубити будь-яке поле, якщо діалог подаватиме форму в обхід `handleSubmitTaskModal`, якщо
 * Ctrl+Enter створить неповну форму, або якщо перемикач перестане відкривати KPI-план.
 */
test("#2393 ФОРМА: діалог шле ті самі поля тим самим шляхом; KPI і Реактивація — свої форми; Ctrl+Enter лише без «бракує»", () => {
  const sec = code("pages", "dashboard", "sections", "TasksSection.tsx");
  assert.match(sec, /\{taskModalOpen && taskForm\.taskType === "simple" && \( <TaskCreateDialog form=\{taskForm\} setForm=\{setTaskForm\}/, "🔴 звичайна задача не відкриває діалог");
  assert.match(sec, /onSubmit=\{handleSubmitTaskModal\}/, "🔴 діалог подає форму в обхід handleSubmitTaskModal");
  assert.match(sec, /onKind=\{\(k\) => setTaskForm\(\(f\) => \(\{ \.\.\.f, taskType: k === "kpi" \? "weekly_kpi" : "reactivation"/, "🔴 перемикач не відкриває KPI-план / Реактивацію");
  assert.match(sec, /\{taskModalOpen && taskForm\.taskType !== "simple" && \(/, "🔴 форми KPI-плану й Реактивації зникли");
  const dlg = code("pages", "dashboard", "sections", "TaskCreateDialog.tsx");
  for (const [field, what] of [
    ["assigneeId: p.id", "виконавець-менеджер"], ["assigneeUserId: p.id", "виконавець-акаунт"], ["assigneeId2: p.id", "другий виконавець"],
    ["reviewerId: p.id", "«Приймає»"], ["deadline: q.date", "швидка дата"], ["deadline: e.target.value", "дата з календаря"],
    ["priority: p", "пріоритет"], ["department: e.target.value", "департамент"], ["comments: e.target.value", "коментар"],
    ["goalResult: e.target.value", "результат стратегічної задачі"], ["strategic: k === \"goal\"", "тип «Ціль»"], ["title: e.target.value", "опис"],
  ] as const) {
    assert.ok(dlg.includes(field), `🔴 у діалозі немає контрола «${what}» (${field})`);
  }
  assert.match(dlg, /const submit = \(\) => \{ if \(missing\.length === 0\) onSubmit\(\); \};/, "🔴 подання не перевіряє, чого бракує");
  assert.match(dlg, /if \(e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)\) \{ e\.preventDefault\(\); submit\(\); \}/, "🔴 Ctrl/⌘+Enter не створює або обходить перевірку");
  // Подання те саме: контейнер шле поля стратегічної й підзадачі.
  const dash = code("pages", "Dashboard.tsx");
  assert.match(dash, /strategic: taskForm\.strategic, goalResult: taskForm\.goalResult, goalId: taskForm\.goalId === "" \? null : Number\(taskForm\.goalId\),/,
    "🔴 стратегічна й підзадача не доїжджають до сервера");
});

/**
 * #2394 — ВИКОНАВЕЦЬ «Я» ПІДПИСАНО ІМЕНЕМ, А НЕ НОМЕРОМ КАРТКИ (26.10.2026: пігулка показувала «№387273» — моя
 * картка менеджера неактивна й не входить у список). Діалог отримує мою картку й імʼя від `TasksSection`.
 * 🧨 Червоніє, якщо діалог знову підпише мене номером, або якщо `TasksSection` перестане передавати картку чи імʼя.
 */
test("#2394 ФОРМА: виконавець «я» — «Я (імʼя)», навіть коли моєї картки немає серед активних менеджерів", () => {
  const dlg = code("pages", "dashboard", "sections", "TaskCreateDialog.tsx");
  assert.match(dlg, /: id === selfManagerId \? `Я\$\{selfName \? ` \(\$\{selfName\}\)` : ""\}`/, "🔴 «я» знову підписано номером картки");
  const at = dlg.indexOf("id === selfManagerId"), byOptions = dlg.indexOf("managerOptions.find((m) => m.id === id)?.name");
  assert.ok(at > 0 && at < byOptions, "🔴 «я» перевіряється ПІСЛЯ пошуку серед активних — неактивна картка знову дасть номер");
  const sec = code("pages", "dashboard", "sections", "TasksSection.tsx");
  assert.match(sec, /selfManagerId=\{currentManagerId \?\? null\} selfName=\{accounts\.find\(\(a\) => a\.id === currentUserId\)\?\.name \|\| accountName\}/,
    "🔴 задачник не передає діалогу мою картку чи імʼя");
});
