import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ⚡ ЗАДАЧА 10989 (26.11.2026): «Пришвидшити завантаження звітів, тімлідам довго завантажує».
 *
 * 📐 Заміряно на проді 26.11 у Chrome Романа: клік «‹» у режимі «Тиждень» — 10-11 с. Причина на
 * фронті: один ефект тягнув місяць → тиждень → день і перезапускався на будь-яку зміну, тож клік
 * тижня перетягував той самий місяць (3-5 с), тиждень чекав на нього, а перший клік робив місяць
 * двічі. Рішення Романа того ж дня: ціль < 3 с; памʼять відповідей 80 с від ОСТАННЬОГО перегляду.
 *
 * Що тут стережеться:
 *  - #10989 / #10989b / #10989c / #10989d / #10989h — проводка в `ReportPlanSection.tsx` (по джерелу:
 *    поведінку React без браузера тут не відтворити, а Playwright-перевірка — у прийманні);
 *  - #10989e / #10989f / #10989g — сама памʼять `reportPlanCache.ts`, ВИКОНАННЯМ (транспіляцією),
 *    з годинником-фікстурою по обидва боки межі 80 с.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "routes/dashboard.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const FE = (rel: string): string => readFileSync(path.join(SRC, "../../frontend/src", rel), "utf8");
const CACHE = "pages/dashboard/reportPlanCache.ts";
const PLAN = "pages/dashboard/sections/ReportPlanSection.tsx";

/** Код без коментарів: гейт читає код, а не прозу (пояснення в коментарях цитують стару поломку). */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Усі `useEffect(() => { … }, [deps]);` компонента: тіло + рядок залежностей. */
function effects(src: string): { body: string; deps: string }[] {
  const out: { body: string; deps: string }[] = [];
  const parts = src.split("useEffect(() => {").slice(1);
  for (const p of parts) {
    const m = /\n\s*\}, \[([^\]]*)\]\);/.exec(p);
    if (!m) continue;
    out.push({ body: p.slice(0, m.index), deps: m[1] });
  }
  return out;
}
const plan = () => codeOnly(FE(PLAN));
const effectWith = (needle: RegExp) => {
  const hits = effects(plan()).filter((e) => needle.test(e.body));
  assert.equal(hits.length, 1, `🔴 очікувався рівно один ефект із ${needle} — знайдено ${hits.length}`);
  return hits[0];
};
const MONTH = /fetchScoped\(monthPeriod\)/;
const WEEK = /fetchScoped\(weekPeriod\)/;
const DAY = /fetchScoped\(\{ from: focusDay, to: focusDay \}\)/;
const depList = (d: string) => d.split(",").map((x) => x.trim()).filter(Boolean);

async function loadCache(): Promise<any> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE(CACHE), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}
/** Годинник-фікстура: час рухає тест, а не реальне очікування. */
const fakeClock = () => { let t = 0; return { now: () => t, set: (v: number) => { t = v; } }; };

test("#10989 ЗМІНА ТИЖНЯ НЕ ТЯГНЕ МІСЯЦЬ: запит місяця — лише в режимі «Місяць» і лише від меж місяця", () => {
  const m = effectWith(MONTH);
  const deps = depList(m.deps);
  for (const bad of ["weekPeriod.from", "weekPeriod.to", "focusDay", "dayShown"])
    assert.ok(!deps.includes(bad), `🔴 ефект місяця перезапускається від «${bad}» — клік тижня знову тягне місяць (було 3-5 с зайвих)`);
  assert.ok(deps.includes("monthPeriod.from") && deps.includes("monthPeriod.to"),
    "🔴 дзеркало: ефект місяця мусить перезапускатись від меж місяця, інакше новий місяць не завантажиться");
  assert.match(m.body, /^\s*if \(mode !== "month"\) return;/,
    "🔴 місяць тягнеться і в режимах, де його не читає ніхто («Тиждень»/«День»)");
  // Дзеркало: periodData у режимі «Місяць» досі читає monthData — тобто вимкнення в інших режимах не осліпило місяць.
  assert.match(plan(), /: monthData;/, "🔴 режим «Місяць» більше не показує monthData");
});

test("#10989b ТИЖДЕНЬ І ДЕНЬ НЕ ЧЕКАЮТЬ МІСЯЦЯ: окремі ефекти, без запиту місяця всередині", () => {
  const w = effectWith(WEEK);
  const d = effectWith(DAY);
  for (const [name, e] of [["тижня", w], ["дня", d]] as const) {
    assert.ok(!MONTH.test(e.body), `🔴 ефект ${name} знову тягне місяць — він чекатиме 3-5 с чужого запиту`);
    assert.ok(!depList(e.deps).includes("monthPeriod.from"), `🔴 ефект ${name} перезапускається від місяця`);
  }
  assert.ok(depList(w.deps).includes("weekPeriod.from") && depList(w.deps).includes("weekPeriod.to"),
    "🔴 дзеркало: тиждень не перезапускається від своїх меж — новий тиждень не завантажиться");
  // Дубль першого кліку: день не тягнеться, поки focusDay не дійшов до dayShown.
  assert.match(d.body, /^\s*if \(mode !== "day" && focusDay !== dayShown\) return;/,
    "🔴 перший клік знову тягне проміжний день (синк dayShown за мить його замінить)");
});

test("#10989c ТРИ ЕФЕКТИ — ОДИН ШЛЯХ: через fetchScoped (злиття команд + памʼять), зі scopeKey і retryNonce", () => {
  const s = plan();
  for (const [name, re] of [["місяця", MONTH], ["тижня", WEEK], ["дня", DAY]] as const) {
    const deps = depList(effectWith(re).deps);
    assert.ok(deps.includes("scopeKey"), `🔴 ефект ${name} без scopeKey — зміна набору команд не перезапустить запит`);
    assert.ok(deps.includes("retryNonce"), `🔴 ефект ${name} без retryNonce — «Спробувати знову» його не перезапустить`);
    assert.ok(deps.includes("fetchScoped"), `🔴 ефект ${name} не залежить від fetchScoped`);
  }
  // Розвилка «одна / кілька команд» — у fetchScopedRaw, і памʼять ходить саме через неї.
  assert.match(s, /teamIds\.length >= 2\)\s*\n\s*return mergeReportPlans\(/, "🔴 злиття 2+ команд зникло зі спільного шляху");
  assert.match(s, /reportPlanMemory\.load\(keyOf\(period\), \(\) => fetchScopedRaw\(period\)\)/,
    "🔴 памʼять тягне не тим самим шляхом, що й без неї — тиждень може показати інший набір людей");
  assert.match(s, /reportPlanKey\(\{ userId: memUser, teamIds, from: period\.from, to: period\.to \}\)/,
    "🔴 ключ памʼяті в екрані будується не з користувача, команд і дат запиту");
});

test("#10989d «ВАНТАЖИТЬСЯ» ЗА ПОКАЗАНИМ: у режимі «Тиждень» чекаємо тиждень, а не місяць", () => {
  const s = plan();
  const m = /const busy = ([\s\S]*?);\n/.exec(s);
  assert.ok(m, "🔴 немає const busy");
  const b = m[1].replace(/\s+/g, " ");
  assert.match(b, /mode === "week" \? weekLoading/, "🔴 у режимі «Тиждень» індикатор завантаження не на тижні");
  assert.match(b, /mode === "day" \? dayLoading/, "🔴 у режимі «День» індикатор завантаження не на дні");
  assert.match(b, /mode === "range" \? rangeLoading/, "🔴 у режимі «Період» індикатор завантаження не на діапазоні");
  assert.match(b, /: monthLoading$/, "🔴 дзеркало: у режимі «Місяць» індикатор не на місяці");
});

test("#10989e КЛЮЧ ПАМʼЯТІ = КОРИСТУВАЧ + НАБІР КОМАНД + ДАТИ; той самий запит — той самий запис", async () => {
  const C = await loadCache();
  const base = { userId: 50, teamIds: [6], from: "2026-11-16", to: "2026-11-22" };
  const k = C.reportPlanKey(base);
  assert.notEqual(C.reportPlanKey({ ...base, teamIds: [14] }), k, "🔴 дві команди ділять один запис — тімлід побачить числа іншої");
  assert.notEqual(C.reportPlanKey({ ...base, teamIds: [] }), k, "🔴 «усі команди» і одна команда ділять запис");
  assert.notEqual(C.reportPlanKey({ ...base, userId: 47 }), k, "🔴 два користувачі ділять запис (вихід/вхід у тій самій вкладці)");
  assert.notEqual(C.reportPlanKey({ ...base, from: "2026-11-09" }), k, "🔴 різні початки періоду — один запис");
  assert.notEqual(C.reportPlanKey({ ...base, to: "2026-11-16" }), k, "🔴 тиждень і його перший день — один запис");
  // Дзеркало: ключ не має бути «унікальним завжди» — тоді памʼять ніколи б не влучала.
  assert.equal(C.reportPlanKey({ ...base }), k, "🔴 той самий запит дає інший ключ — памʼять ніколи не влучить");
  assert.equal(C.reportPlanKey({ ...base, teamIds: [6, 14] }), C.reportPlanKey({ ...base, teamIds: [14, 6] }),
    "🔴 порядок вибору команд змінює ключ — той самий набір не влучає в памʼять");
  // І памʼять справді розводить записи за ключем (а не лише функція ключа).
  const clk = fakeClock();
  const M = new C.ReportPlanMemory(80_000, clk.now);
  await M.load(k, async () => "A");
  let calls = 0;
  const v = await M.load(C.reportPlanKey({ ...base, teamIds: [14] }), async () => { calls++; return "B"; });
  assert.equal(v, "B"); assert.equal(calls, 1, "🔴 запит іншої команди отримав чужий запис");
  assert.equal(await M.load(k, async () => "НЕ МАЄ"), "A", "🔴 дзеркало: свій запис не влучив");
});

test("#10989f 80 с ВІД ОСТАННЬОГО ПЕРЕГЛЯДУ: на екрані таймер стоїть, вихід — відлік, повернення й вихід — відлік заново", async () => {
  const C = await loadCache();
  assert.equal(C.REPORT_PLAN_KEEP_MS, 80_000, "🔴 тривалість не та, що ухвалив Роман 26.11 (80 с)");
  const clk = fakeClock();
  const M = new C.ReportPlanMemory(C.REPORT_PLAN_KEEP_MS, clk.now);
  const k = "тиждень";
  // На екрані 10 хвилин — не старіє.
  M.setOnScreen([k]);
  await M.load(k, async () => "W");
  clk.set(600_000);
  assert.equal(M.peek(k), "W", "🔴 запис протух, поки тиждень був на екрані");
  // Пішов на 600 с: живий на +79 с.
  M.setOnScreen([]);
  clk.set(679_000);
  assert.equal(M.peek(k), "W", "🔴 запис помер раніше 80 с після виходу");
  // Повернувся на 679 с і лишився на екрані до 800 с (121 с після ПЕРШОГО виходу) — запис живий:
  // поки тиждень знову на екрані, таймер стоїть, а не догорає від першого виходу.
  M.setOnScreen([k]);
  clk.set(800_000);
  assert.equal(M.peek(k), "W", "🔴 після повернення таймер догорає від першого виходу — тиждень на екрані «протух»");
  // Пішов на 800 с — відлік від ДРУГОГО виходу.
  M.setOnScreen([]);
  clk.set(879_000);
  assert.equal(M.peek(k), "W", "🔴 повернення не продовжило життя запису ще на 80 с (таймер від першого виходу або від завантаження)");
  clk.set(881_000);
  assert.equal(M.peek(k), undefined, "🔴 дзеркало: запис живий понад 80 с після останнього виходу");
  // Фонове довантаження (ніколи не було на екрані): 80 с від ПРИХОДУ відповіді.
  clk.set(1_000_000);
  let resolve!: (v: string) => void;
  const p = M.load("фон", () => new Promise<string>((r) => { resolve = r; }));
  clk.set(1_003_000); resolve("P"); await p;
  clk.set(1_082_000);
  assert.equal(M.peek("фон"), "P", "🔴 фоновий запис рахує 80 с від старту запиту, а не від приходу");
  clk.set(1_084_000);
  assert.equal(M.peek("фон"), undefined, "🔴 непереглянутий фоновий запис живе понад 80 с");
});

test("#10989g «СПРОБУВАТИ ЗНОВУ» ЙДЕ ПОВЗ ПАМʼЯТЬ: кнопка чистить її, а відповідь старого запиту в неї не повертається", async () => {
  assert.match(plan(), /onClick=\{\(\) => \{ reportPlanMemory\.clear\(\); setRetryNonce\(\(n\) => n \+ 1\); \}\}/,
    "🔴 «Спробувати знову» не чистить памʼять — повтор покаже ті самі числа з памʼяті");
  const C = await loadCache();
  const clk = fakeClock();
  const M = new C.ReportPlanMemory(80_000, clk.now);
  await M.load("k", async () => "старе");
  M.clear();
  let calls = 0;
  assert.equal(await M.load("k", async () => { calls++; return "нове"; }), "нове");
  assert.equal(calls, 1, "🔴 після clear() запит не пішов на сервер");
  // Запит, що стартував ДО clear(), у памʼять не повертається.
  let resolve!: (v: string) => void;
  const old = M.load("x", () => new Promise<string>((r) => { resolve = r; }));
  M.clear();
  resolve("до-повтору"); await old;
  assert.equal(M.peek("x"), undefined, "🔴 відповідь запиту, що стартував до «Спробувати знову», осіла в памʼяті");
  // Дзеркало: без clear() памʼять працює.
  await M.load("y", async () => "Y");
  assert.equal(M.peek("y"), "Y", "🔴 дзеркало: памʼять не зберігає взагалі");
});

test("#10989h ФОН — ПІСЛЯ ПОКАЗАНОГО: попередній тиждень довантажується лише після приходу поточного, і клік ділить із ним один запит", async () => {
  const e = effectWith(/addDays\(weekPeriod\.from, -1\)/);
  assert.match(e.body, /^\s*if \(mode !== "week" \|\| weekLoading \|\| !weekData\) return;/,
    "🔴 фонове довантаження стартує разом із поточним тижнем або поза режимом «Тиждень» — воно гальмує показане (2,8 → 6,3 с)");
  assert.match(e.body, /await fetchScoped\(prevWeek\);[\s\S]*await fetchScoped\(\{ from: prevSun, to: prevSun \}\);/,
    "🔴 фон тягне не попередній тиждень і його день послідовно");
  assert.ok(!/fetchScoped\(\{ from: addDays\(weekPeriod\.to, 1\)/.test(e.body), "🔴 фон тягне ще й наступний тиждень");
  // Single-flight: фон і клік на той самий тиждень — один запит.
  const C = await loadCache();
  const M = new C.ReportPlanMemory(80_000, fakeClock().now);
  let calls = 0; let resolve!: (v: string) => void;
  const bg = M.load("prev", () => { calls++; return new Promise<string>((r) => { resolve = r; }); });
  const click = M.load("prev", async () => { calls++; return "ДРУГИЙ"; });
  resolve("ОДИН");
  assert.deepEqual([await bg, await click], ["ОДИН", "ОДИН"]);
  assert.equal(calls, 1, "🔴 клік під час фонового запиту пішов на сервер удруге");
});
