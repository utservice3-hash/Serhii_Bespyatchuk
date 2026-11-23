import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 👥 ЗАДАЧА 10752 (23.11.2026, ручний список правок Романа): у Звіті — «Менеджери · N з M», вибір рядків так само, як
 * «Колонки · N з M» вибирає колонки. Логіка — у чистому `frontend/src/pages/dashboard/mgrPick.ts`; тут вона ВИКОНУЄТЬСЯ
 * (транспіляцією), а проводка в таблицю й картки перевіряється по джерелу.
 *
 * Що стережемо, і чому саме це:
 *  - зберігаються ПРИХОВАНІ, а не обрані — інакше новий менеджер мовчки не зʼявився б у Звіті ніколи;
 *  - зіпсований запис у сховищі = «видно всіх», а не порожній Звіт;
 *  - вибір особистий (ключ з userId), як у колонок;
 *  - звужений список читається як звужений: підсумок «Обрані рядки», а не «Весь відділ» над частиною людей.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "routes/dashboard.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const FE = (rel: string): string => readFileSync(path.join(SRC, "../../frontend/src", rel), "utf8");
const PICK = "pages/dashboard/mgrPick.ts";
const TABLE = "pages/dashboard/sections/ReportTableSection.tsx";
const PLAN = "pages/dashboard/sections/ReportPlanSection.tsx";

async function loadPick(): Promise<any> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE(PICK), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}
/** Сховище-фікстура з тим самим інтерфейсом, що localStorage. */
const memStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, dump: () => Object.fromEntries(m) };
};
const R = (id: number, name = `M${String(id)}`, teamName: string | null = "Команда А") => ({ managerId: id, name, teamName });

/**
 * #10752 — ФІЛЬТР ХОВАЄ РІВНО ПРИХОВАНИХ, НОВИЙ МЕНЕДЖЕР ВИДНО САМ.
 * Фікстура по обидва боки: прихований зникає, неприхований і НОВИЙ (якого в збереженому списку немає) лишаються, порядок
 * не змінюється; прихований поза поточними даними список не звужує; перемикач команди ховає всю, а частково сховану — показує.
 * 🧨 Червоніє, якщо фільтр почне лишати лише «перелічених» (тоді новий менеджер зникне), чи звуження рахуватиметься
 * за прихованими, яких на екрані немає.
 */
test("#10752 ВИБІР МЕНЕДЖЕРІВ: ховає рівно прихованих, новий менеджер видно, звуження — лише серед показаних", async () => {
  const p = await loadPick();
  const rows = [R(1), R(2), R(3), R(99, "Новий")];
  assert.deepEqual(p.pickManagers(rows, [2]).map((m: { managerId: number }) => m.managerId), [1, 3, 99], "🔴 прихований не зник або зник новий менеджер");
  assert.deepEqual(p.pickManagers(rows, []).map((m: { managerId: number }) => m.managerId), [1, 2, 3, 99], "🔴 без прихованих показано не всіх");
  assert.deepEqual(p.pickManagers(rows, [3, 1]).map((m: { managerId: number }) => m.managerId), [2, 99], "🔴 фільтр змінив порядок рядків або сховав не тих");
  assert.equal(p.isPickNarrowed(rows, [2]), true, "🔴 прихований серед показаних — а список не вважається звуженим");
  assert.equal(p.isPickNarrowed(rows, [555]), false, "🔴 прихований з іншої команди (його на екрані немає) звужує список");
  assert.equal(p.isPickNarrowed(rows, []), false, "🔴 нікого не приховано — а список вважається звуженим");
  // Перемикач групи: усі видимі → сховати всіх; частково сховані → показати всіх.
  assert.deepEqual([...p.toggleMany([], [1, 2])].sort(), [1, 2], "🔴 галочка команди не ховає всю команду");
  assert.deepEqual(p.toggleMany([1], [1, 2]), [], "🔴 галочка частково схованої команди не показує всіх");
  assert.deepEqual(p.toggleMany([7], [1]), [7, 1], "🔴 галочка менеджера зачепила чужих прихованих");
  const g = p.pickGroups([R(3, "Яцик", "Б"), R(1, "Антипенко", "Б"), R(2, "Возович", null)]);
  assert.deepEqual(g.map((x: { team: string }) => x.team), ["Б", "Поза командами"], "🔴 групи меню не за абеткою або менеджер без команди без підпису");
  assert.deepEqual(g[0].rows.map((m: { name: string }) => m.name), ["Антипенко", "Яцик"], "🔴 люди в групі не за абеткою");
});

/**
 * #10752b — СХОВИЩЕ: ОСОБИСТЕ, А ЗІПСОВАНИЙ ЗАПИС = «ВИДНО ВСІХ».
 * 🧨 Червоніє, якщо ключ стане спільним (вибір людини 42 почне діяти на 43), або сміття зі сховища потрапить у фільтр.
 */
test("#10752b ВИБІР МЕНЕДЖЕРІВ — ОСОБИСТИЙ, ЗІПСОВАНИЙ ЗАПИС ДАЄ «ВИДНО ВСІХ»", async () => {
  const p = await loadPick();
  const st = memStore();
  assert.equal(p.writeHiddenMgrs(st, 42, [5, 7, 5]), true, "🔴 запис у доступне сховище не вдався");
  assert.deepEqual(p.readHiddenMgrs(st, 42), [5, 7], "🔴 свій вибір не прочитався (або не зняті дублі)");
  assert.deepEqual(p.readHiddenMgrs(st, 43), [], "🔴 вибір людини 42 діє на людину 43 — ключ спільний");
  assert.ok(Object.keys(st.dump()).every((k) => k === "rptHiddenMgrs:42"), "🔴 записано не в особистий ключ");
  for (const bad of ["{oops", "{\"a\":1}", "\"5\"", "[\"5\",null,-3,2.5,0,{}]"]) {
    assert.deepEqual(p.readHiddenMgrs(memStore({ "rptHiddenMgrs:1": bad }), 1), [], `🔴 сміття у сховищі (${bad}) потрапило у фільтр`);
  }
  assert.deepEqual(p.readHiddenMgrs(memStore({ "rptHiddenMgrs:1": "[\"x\",8]" }), 1), [8], "🔴 разом зі сміттям загубився справжній запис");
  assert.deepEqual(p.readHiddenMgrs(null, 1), [], "🔴 без сховища (приватне вікно) — не «видно всіх»");
  assert.equal(p.writeHiddenMgrs(null, 1, [1]), false, "🔴 запис без сховища вдає успіх");
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(p.readHiddenMgrs(throwing, 1), [], "🔴 заблоковане сховище кидає замість «видно всіх»");
});

/**
 * #10752c — ЗВУЖЕНИЙ СПИСОК ЧИТАЄТЬСЯ ЯК ЗВУЖЕНИЙ. Підпис підсумку — «Обрані рядки», коли рядки звужено вибором чи
 * чипом стану; інакше як було («Весь відділ» / «Команда»). І таблиця справді бере цей підпис, а «загальні» числа
 * підсумку (план звільнених, медіана передзвону, рядок «Пропущених усього») вимикає від БУДЬ-ЯКОГО звуження.
 * 🧨 Червоніє, якщо підпис дивитиметься лише на чип стану — тоді «Весь відділ» стоятиме над частиною людей.
 */
test("#10752c ПІДСУМОК ПРИ ВИБОРІ МЕНЕДЖЕРІВ: «Обрані рядки», загальні числа вимкнено; без вибору — як було", async () => {
  const p = await loadPick();
  assert.equal(p.rowsScopeLabel({ role: "admin", statusFiltered: false, pickNarrowed: true }), "Обрані рядки", "🔴 вибір менеджерів, а підсумок — «Весь відділ»");
  assert.equal(p.rowsScopeLabel({ role: "admin", statusFiltered: true, pickNarrowed: false }), "Обрані рядки", "🔴 фільтр стану перестав давати «Обрані рядки»");
  assert.equal(p.rowsScopeLabel({ role: "admin", statusFiltered: false, pickNarrowed: false }), "Весь відділ", "🔴 без звуження підпис не «Весь відділ»");
  assert.equal(p.rowsScopeLabel({ role: "manager", statusFiltered: false, pickNarrowed: false }), "Команда", "🔴 менеджер без звуження бачить не «Команда»");
  const t = FE(TABLE);
  assert.match(t, /const pickNarrowed = isPickNarrowed\(data\.managers, hiddenMgrs\);/, "🔴 таблиця не рахує звуження вибором менеджерів");
  assert.match(t, /const filtered = statusFilter != null \|\| pickNarrowed;/, "🔴 «звужено» в таблиці не враховує вибір менеджерів");
  assert.match(t, /const scopeLabel = rowsScopeLabel\(\{ role: auth\.role, statusFiltered: statusFilter != null, pickNarrowed \}\);/, "🔴 підпис підсумку рахується не rowsScopeLabel");
  assert.match(t, /planGone=\{filtered \? 0 :/, "🔴 «план звільнених» лишається в підсумку обраних рядків");
  assert.match(t, /callbackMedian=\{filtered \? null :/, "🔴 медіана передзвону всього відділу лишається в підсумку обраних рядків");
  assert.match(t, /<MissedOutside data=\{data\} rows=\{rows\} filtered=\{filtered\} \/>/, "🔴 «Пропущених усього» рахує «поза таблицею» і тих, кого просто сховали");
});

/**
 * #10752d — ПРОВОДКА: ВИБІР ДІЄ І НА ТАБЛИЦЮ, І НА КАРТКИ, КНОПКА Є В ОБОХ ВИГЛЯДАХ, ВИБІР ЗБЕРІГАЄТЬСЯ.
 * 🧨 Червоніє, якщо один вигляд перестане фільтрувати (картки показують сховану людину), кнопка зникне з одного
 * вигляду, плашка «лише обрані менеджери ×» перестане показуватись або вибір перестане записуватись.
 */
test("#10752d ВИБІР МЕНЕДЖЕРІВ У ТАБЛИЦІ Й КАРТКАХ: один стан, кнопка в обох, плашка з «×», запис у сховище", () => {
  const t = FE(TABLE), pl = FE(PLAN);
  assert.match(t, /const picked = pickManagers\(statusFilter \? data\.managers\.filter\(\(m\) => m\.status === statusFilter\) : data\.managers, hiddenMgrs\);/, "🔴 таблиця не фільтрує рядки вибором менеджерів");
  assert.match(t, /<span style=\{\{ flex: 1 \}\} \/>\s*\{mgrPicker\}\s*<ColumnPicker/, "🔴 у таблиці немає кнопки «Менеджери» перед «Колонки»");
  assert.match(pl, /const shownManagers = pickManagers\(\(data\?\.managers \?\? \[\]\)\.filter\(\(m\) => !statusFilter \|\| m\.status === statusFilter\), hiddenMgrs\);/, "🔴 картки не фільтруються вибором менеджерів");
  assert.match(pl, /hiddenMgrs=\{hiddenMgrs\} mgrPicker=\{mgrPicker \|\| null\}/, "🔴 таблиця не отримує вибір менеджерів від контейнера");
  assert.match(pl, /<div className="rv-bar">\{toolbar\}<span style=\{\{ flex: 1 \}\} \/>\{mgrPicker\}<\/div>/, "🔴 у картках немає кнопки «Менеджери»");
  assert.match(pl, /\{pickNarrowed && \(\s*<span className="rv-fpill">лише обрані менеджери\s*<button type="button" aria-label="Показати всіх менеджерів" onClick=\{\(\) => applyHidden\(\[\]\)\}>×<\/button><\/span>/, "🔴 звужений список без плашки «лише обрані менеджери ×»");
  assert.match(pl, /const applyHidden = \(next: number\[\]\) => \{ setHiddenMgrs\(next\); writeHiddenMgrs\(pickStore\(\), pickUser, next\); \};/, "🔴 вибір менеджерів не записується у сховище");
  assert.match(pl, /useState<number\[\]>\(\(\) => readHiddenMgrs\(pickStore\(\), pickUser\)\)/, "🔴 вибір менеджерів не читається зі сховища при відкритті");
});
