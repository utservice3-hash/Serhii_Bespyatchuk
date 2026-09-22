import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 📞 #685–#687 — ЕКРАН «ЛІДОГЕНЕРАЦІЯ» ПЕРЕНЕСЕНО З МАКЕТА (22.09.2026), І ЛИШЕ ЙОГО.
 *
 * Макет жив на тій самій кодовій базі, але з макетними хуками: адаптер, що підкладав
 * відповіді API (`window.__MAKET_ADAPTER__`), `HashRouter` для відкриття з файла, вхід без
 * логіна, `maket.js` у `index.html`, порівняльна «стара» вкладка. Переносився ДИФ, а не файли,
 * і ці гейти стережуть саме межу переносу: у продукт їде екран, а не макет.
 *
 * Джерело фронта читається ТЕКСТОМ (прийом `missedCallsTab.test.ts`): жодного імпорту фронта
 * в збірку бекенда, і гейт працює без БД і без зібраного бандла — тобто в КОЖНОМУ оточенні.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FE = path.join(ROOT, "frontend");
const rel = (p: string): string => path.relative(ROOT, p);

/** Усе дерево каталогу, а не «файли, які я згадав»: новий файл інакше — сліпа зона гейта. */
function walk(dir: string, exts: RegExp, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, acc);
    else if (exts.test(e)) acc.push(p);
  }
  return acc;
}

const stripComments = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/**
 * Ознаки макета — ТІ САМІ, що в ньому були (не «слово макет»: кирилична «МАКЕТ» у коментарі
 * законна й лишається пам'яттю). `maket[\w-]*\.js` ловить і `maket.js`, і `maket-data.js`.
 */
const MOCK_MARKERS: { name: string; re: RegExp }[] = [
  { name: "__MAKET (адаптер відповідей / режим / фільтр меню макета)", re: /__MAKET/ },
  { name: "HashRouter (маршрутизація макета для відкриття з файла)", re: /\bHashRouter\b/ },
  { name: "maket*.js (підкладені відповіді й дані макета)", re: /maket[\w-]*\.js/i },
];
const mockHits = (text: string): string[] => MOCK_MARKERS.filter((m) => m.re.test(text)).map((m) => m.name);

test("#685 МАКЕТ НЕ ПОТРАПИВ У ПРОДУКТ: у frontend/src, index.html і public немає __MAKET, HashRouter, maket*.js", () => {
  const files = walk(path.join(FE, "src"), /\.(ts|tsx|js|jsx|mjs|css|html|json|svg)$/).concat(path.join(FE, "index.html"));
  // Порожній простір — провал, а не «чисто»: спершу доводимо, що перевірці БУЛО що читати.
  assert.ok(files.length > 100, `🔴 обхід знайшов лише ${files.length} файлів фронта — шукали не там`);
  for (const must of ["src/main.tsx", "src/api.ts", "src/pages/Dashboard.tsx", "src/pages/dashboard/sections/LeadgenSection.tsx", "index.html"])
    assert.ok(files.includes(path.join(FE, must)), `🔴 у простір пошуку не потрапив frontend/${must} — саме там жили хуки макета`);

  const hits: string[] = [];
  for (const f of files) {
    const found = mockHits(readFileSync(f, "utf8"));
    if (found.length) hits.push(`${rel(f)}: ${found.join("; ")}`);
  }
  // Файли макета за ІМЕНЕМ: maket.js/maket-data.js лежали в public, звідки vite кладе їх у бандл як є.
  const named = walk(FE, /maket/i).filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`)).map((f) => `${rel(f)}: файл макета`);
  assert.deepEqual(hits.concat(named), [],
    `🔴 У ПРОДУКТ ПРОСОЧИВСЯ МАКЕТ (перевірено ${files.length} файлів фронта):\n  ` + hits.concat(named).join("\n  ")
    + "\n   Адаптер підмінив би відповіді API, HashRouter зламав би посилання, maket.js поїхав би в докрут.");
});

test("#685b 🪞 ДЗЕРКАЛО: ознаки ловлять рядки макета дослівно — і не чіпають продукту", () => {
  // Рядки, що справді стояли в макеті (база fcb4562 → макет): кожен мусить бути спійманий.
  assert.equal(mockHits("const __maket = (window as unknown as { __MAKET_ADAPTER__?: unknown }).__MAKET_ADAPTER__;").length, 1,
    "🔴 адаптер відповідей макета не спійманий");
  assert.equal(mockHits("import { HashRouter } from 'react-router-dom'").length, 1, "🔴 HashRouter не спійманий");
  assert.equal(mockHits('    <script src="./maket.js"></script>').length, 1, "🔴 maket.js не спійманий");
  assert.equal(mockHits('    <script src="./maket-data.js"></script>').length, 1, "🔴 maket-data.js не спійманий");
  // 🪞 Продукт: справжній роутер на місці, і кирилична згадка «МАКЕТ» у коментарі — не ознака.
  assert.deepEqual(mockHits("import { BrowserRouter } from 'react-router-dom'"), [], "🔴 BrowserRouter оголошено макетом");
  assert.deepEqual(mockHits("// МАКЕТ: так було в макеті, тут — продукт"), [], "🔴 кириличний коментар оголошено макетом");
  const main = readFileSync(path.join(FE, "src", "main.tsx"), "utf8");
  assert.match(main, /<BrowserRouter>/, "🔴 у продукті немає BrowserRouter — перевіряти відсутність HashRouter нема на чому");
});

test("#686 Dashboard рендерить <LeadgenSection /> БЕЗ пропсів — спільний dateRange у вкладку не їде", () => {
  const dash = stripComments(readFileSync(path.join(FE, "src", "pages", "Dashboard.tsx"), "utf8"));
  const tags = dash.match(/<LeadgenSection\b[^>]*>/g) ?? [];
  assert.equal(tags.length, 1, `🔴 <LeadgenSection …> у Dashboard знайдено ${tags.length} раз(ів), а має бути рівно один`);
  assert.match(tags[0], /^<LeadgenSection\s*\/>$/,
    `🔴 вкладці знову передають пропси: ${tags[0]} — період екрана застигне на чужому dateRange`);
  assert.doesNotMatch(dash, /\bLeadgenSectionLegacy\b/, "🔴 у Dashboard повернулась порівняльна «стара» вкладка макета");
});

test("#686b 🪞 ДЗЕРКАЛО: період у екрана СВІЙ — навігатор на екрані, запит іде з його періоду", () => {
  const sec = stripComments(readFileSync(path.join(FE, "src", "pages", "dashboard", "sections", "LeadgenSection.tsx"), "utf8"));
  assert.match(sec, /export function LeadgenSection\(\s*\)/, "🔴 екран знову приймає пропси — період прийде ззовні");
  assert.doesNotMatch(sec, /\bdateRange\b/, "🔴 екран читає спільний dateRange");
  assert.match(sec, /<PeriodNav\b/, "🔴 на екрані немає навігатора — період нема звідки змінити");
  assert.match(sec, /const period = useMemo\(\(\) => periodOf\(nav\)/, "🔴 період екрана береться не з навігатора");
  assert.match(sec, /const \{ from, to \} = period;/, "🔴 межі запиту — не з періоду навігатора");
  assert.match(sec, /fetchLeadgenStats\(grain \? \{ from, to, grain \} : \{ from, to \}\)/, "🔴 основний запит екрана іде не з періоду навігатора");
});

/**
 * 🗓 #687 — ДОПОВНЕННЯ ДО `#239` ДЛЯ ІНШОЇ ФОРМИ ТОГО САМОГО ДЕФЕКТУ.
 * `#239` ловить день у шаблоні (`${ym}-31`), але не конкатенацію: у макеті екрана стояло
 * `r.ym + "-31"`, і `#239` його не бачив. Ознака та сама — день 29/30/31, дописаний до
 * змінного місяця, — тут через `+` (TS) або `||` (SQL). Обхід — усе дерево, як у `#239`.
 */
const CONCAT_DAY = /(\+|\|\|)\s*(["'`])-(29|30|31)\2/;
/** Коментар — не код (межа та сама, що в `#239`, і так само груба). */
const isComment = (line: string): boolean => /^\s*(\*|\/\/|--|\/\*)/.test(line);

test("#687 день місяця не дописується рядком до місяця (ym + «-31») — ні на екрані лідогену, ні деінде в дереві", () => {
  const exts = /\.(ts|tsx|js|mjs|sql)$/;
  const files = walk(path.join(ROOT, "backend", "src"), exts).concat(walk(path.join(FE, "src"), exts));
  assert.ok(files.length > 300, `🔴 обхід дерева знайшов лише ${files.length} файлів — шукали не там`);
  for (const must of ["LeadgenCharts.tsx", "LeadgenSection.tsx"])
    assert.ok(files.includes(path.join(FE, "src", "pages", "dashboard", "sections", must)), `🔴 ${must} не потрапив у простір пошуку`);

  const hits: string[] = [];
  for (const f of files) {
    if (f.endsWith("leadgenScreen.test.ts")) continue; // сам гейт містить зразки
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!isComment(line) && CONCAT_DAY.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [],
    `🔴 КІНЕЦЬ МІСЯЦЯ ДОПИСАНО РЯДКОМ (перевірено ${files.length} файлів). У вересні 30 днів, у лютому 28 — `
    + "беріть межу з календаря (`monthEnd` у periodRules):\n  " + hits.join("\n  "));
});

test("#687b 🪞 ДЗЕРКАЛО: ознака ловить рядок макета дослівно — і пропускає законне", () => {
  assert.ok(CONCAT_DAY.test('const sel = rows.filter((r) => r.ym + "-01" <= period.to && period.from <= r.ym + "-31").map((r) => r.label);'),
    "🔴 не спіймано рядок макета `r.ym + \"-31\"`");
  assert.ok(CONCAT_DAY.test("const to = ym+'-30';"), "🔴 не спіймано `-30` в одинарних лапках без пробілів");
  assert.ok(CONCAT_DAY.test("const to = m + `-29`;"), "🔴 не спіймано `-29` у зворотних лапках");
  assert.ok(CONCAT_DAY.test("WHERE d <= (ym || '-31')::date"), "🔴 не спіймано SQL-конкатенацію `|| '-31'`");
  // 🪞 Законне: перше число є в кожному місяці; грудень має 31 день; коментар — не код.
  assert.equal(CONCAT_DAY.test('months.filter((ym) => ym + "-01" <= today)'), false, "🔴 `-01` оголошено дефектом");
  assert.equal(CONCAT_DAY.test('const dec = y + "-12-31";'), false, "🔴 фіксований грудень оголошено дефектом");
  assert.equal(CONCAT_DAY.test('const d = monthEnd(ym + "-01");'), false, "🔴 виправлений рядок оголошено дефектом");
  assert.equal(isComment('  // було r.ym + "-31"'), true, "🔴 коментар прийнято за код");
  assert.equal(isComment('  const x = r.ym + "-31";'), false, "🔴 живий рядок оголошено коментарем");
});
