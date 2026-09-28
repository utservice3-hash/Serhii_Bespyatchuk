import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 📞 #685–#688 — ЕКРАН «ЛІДОГЕНЕРАЦІЯ» ПЕРЕНЕСЕНО З МАКЕТА (22.09.2026), І ЛИШЕ ЙОГО.
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

/**
 * `public` vite копіює в докрут ЯК Є, тож його ВМІСТ — такий самий продукт, як `src`. Читаємо всі
 * текстові типи (svg теж: `<script>` усередині svg виконується); png/ico — байти, маркерів там не буває.
 */
const PUBLIC_TEXT = /\.(js|mjs|cjs|html?|svg|json|css|txt|xml|webmanifest)$/i;

test("#685 МАКЕТ НЕ ПОТРАПИВ У ПРОДУКТ: у frontend/src, index.html і public немає __MAKET, HashRouter, maket*.js", () => {
  const files = walk(path.join(FE, "src"), /\.(ts|tsx|js|jsx|mjs|css|html|json|svg)$/)
    .concat(path.join(FE, "index.html"))
    .concat(walk(path.join(FE, "public"), PUBLIC_TEXT));
  // Порожній простір — провал, а не «чисто»: спершу доводимо, що перевірці БУЛО що читати.
  assert.ok(files.length > 100, `🔴 обхід знайшов лише ${files.length} файлів фронта — шукали не там`);
  for (const must of ["src/main.tsx", "src/api.ts", "src/pages/Dashboard.tsx", "src/pages/dashboard/sections/LeadgenSection.tsx", "index.html", "public/favicon.svg"])
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

/** Аргументи КОЖНОГО виклику `name(…)` — з урахуванням вкладених дужок (а не «до першої `)`»). */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}
const ID = "[A-Za-z_$][\\w$]*";

/**
 * Твердження — про ПОТІК ДАНИХ, а не про текст рядка: змінна навігатора (та, що в `<PeriodNav state=…>`)
 * → `periodOf(неї)` → межі `from`/`to` → аргумент запиту. Імена змінних беруться з самого коду, порядок
 * деструктуризації й обгортка `useMemo` — байдужі: рефакторинг, що не міняє потоку, гейт не червонить.
 */
test("#686b 🪞 ДЗЕРКАЛО: період у екрана СВІЙ — навігатор на екрані, запит іде з його періоду", () => {
  const sec = stripComments(readFileSync(path.join(FE, "src", "pages", "dashboard", "sections", "LeadgenSection.tsx"), "utf8"));
  assert.match(sec, new RegExp(`export\\s+(?:function\\s+LeadgenSection\\s*\\(\\s*\\)|const\\s+LeadgenSection\\s*=\\s*\\(\\s*\\)\\s*=>)`),
    "🔴 екран знову приймає пропси — період прийде ззовні");
  assert.doesNotMatch(sec, /\bdateRange\b/, "🔴 екран читає спільний dateRange");

  const nav = sec.match(new RegExp(`<PeriodNav\\b[^>]*?\\bstate=\\{\\s*(${ID})\\s*\\}`))?.[1];
  assert.ok(nav, "🔴 на екрані немає навігатора <PeriodNav state={…}> — період нема звідки змінити");
  const esc = (s: string): string => s.replace(/\$/g, "\\$");
  // Усі змінні, що тримають periodOf(навігатора): таких буває кілька (у comparisonOf — своя `cur`).
  const periods = [...sec.matchAll(new RegExp(`\\bconst\\s+(${ID})\\s*=\\s*(?:useMemo\\(\\s*\\(\\)\\s*=>\\s*)?periodOf\\(\\s*${esc(nav)}\\s*\\)`, "g"))]
    .map((m) => m[1]);
  assert.ok(periods.length > 0, `🔴 період екрана береться не з навігатора: немає \`const … = periodOf(${nav})\``);
  const bound = periods.flatMap((p) => [...sec.matchAll(new RegExp(`\\bconst\\s*\\{([^}]*)\\}\\s*=\\s*${esc(p)}\\b(?!\\s*\\.)`, "g"))]
    .flatMap((m) => m[1].split(",").map((s) => s.trim())));
  assert.ok(bound.includes("from") && bound.includes("to"),
    `🔴 межі запиту — не з періоду навігатора: \`from\` і \`to\` не деструктуровано з ${periods.map((p) => `\`${p}\``).join(" / ")} (знайдено: ${bound.join(", ") || "нічого"})`);

  const calls = callArgs(sec, "fetchLeadgenStats");
  assert.ok(calls.length > 0, "🔴 екран не кличе fetchLeadgenStats — перевіряти нема що");
  for (const a of calls)
    assert.doesNotMatch(a, /["'`]|\b\d/, `🔴 у запиті екрана зашитий літерал (дата чи число): fetchLeadgenStats(${a.trim()})`);
  assert.ok(calls.some((a) => /\bfrom\b/.test(a) && /\bto\b/.test(a)),
    `🔴 основний запит екрана іде не з меж навігатора: жоден із ${calls.length} викликів fetchLeadgenStats не бере from і to`);
});

/**
 * 🗓 #687 — ДОПОВНЕННЯ ДО `#239` ДЛЯ ІНШОЇ ФОРМИ ТОГО САМОГО ДЕФЕКТУ.
 * `#239` ловить день у шаблоні (`${ym}-31`), але не конкатенацію: у макеті екрана стояло
 * `r.ym + "-31"`, і `#239` його не бачив. Ознака та сама — день 29/30/31, дописаний до
 * змінного місяця. Обхід — усе дерево, як у `#239`.
 *
 * ЩО ЛОВИТЬСЯ (кожна форма — у дзеркалі `#687b`):
 *   • `+ "-31"`, `|| '-31'` (SQL), `.concat("-31")` — і з хвостом після дня (`"-31T23:59:59"`);
 *   • `"-" + "31"` / `'-' || '31'` — день окремим доданком;
 *   • перенос рядка між `+` і літералом: текст читається ЦІЛИМ, а не рядок за рядком.
 * ЧОГО НЕ ЛОВИТЬСЯ (свідомо, назване тут, щоб «зелено» не читалось ширше): `[ym, "31"].join("-")`,
 * день змінною (`ym + "-" + last`) і день у шаблоні — останнє стереже `#239`.
 */
const CONCAT_DAY: RegExp[] = [
  /(?:\+|\|\||\.concat\()\s*(["'`])-(29|30|31)(?!\d)/g,
  /(["'`])-\1\s*(?:\+|\|\|)\s*(["'`]?)(29|30|31)(?!\d)/g,
];
/** Коментар — не код (межа та сама, що в `#239`, і так само груба). */
const isComment = (line: string): boolean => /^\s*(\*|\/\/|--|\/\*)/.test(line);
/** Номери рядків (з 1), де стоїть ознака. Рядки-коментарі гасяться, але лишаються — нумерація не зсувається. */
function concatDayLines(text: string): number[] {
  const code = text.split("\n").map((l) => (isComment(l) ? "" : l)).join("\n");
  const lines = new Set<number>();
  for (const re of CONCAT_DAY)
    for (const m of code.matchAll(re)) lines.add(code.slice(0, m.index).split("\n").length);
  return [...lines].sort((a, b) => a - b);
}

test("#687 день місяця не дописується рядком до місяця (ym + «-31») — ні на екрані лідогену, ні деінде в дереві", () => {
  const exts = /\.(ts|tsx|js|mjs|sql)$/;
  const files = walk(path.join(ROOT, "backend", "src"), exts).concat(walk(path.join(FE, "src"), exts));
  assert.ok(files.length > 300, `🔴 обхід дерева знайшов лише ${files.length} файлів — шукали не там`);
  for (const must of ["LeadgenCharts.tsx", "LeadgenSection.tsx"])
    assert.ok(files.includes(path.join(FE, "src", "pages", "dashboard", "sections", must)), `🔴 ${must} не потрапив у простір пошуку`);

  const hits: string[] = [];
  for (const f of files) {
    if (f.endsWith("leadgenScreen.test.ts")) continue; // сам гейт містить зразки
    const text = readFileSync(f, "utf8");
    const lines = text.split("\n");
    for (const ln of concatDayLines(text)) hits.push(`${rel(f)}:${ln}: ${lines[ln - 1].trim().slice(0, 100)}`);
  }
  assert.deepEqual(hits, [],
    `🔴 КІНЕЦЬ МІСЯЦЯ ДОПИСАНО РЯДКОМ (перевірено ${files.length} файлів). У вересні 30 днів, у лютому 28 — `
    + "беріть межу з календаря (`monthEnd` у periodRules):\n  " + hits.join("\n  "));
});

test("#687b 🪞 ДЗЕРКАЛО: ознака ловить рядок макета дослівно — і пропускає законне", () => {
  const caught = (s: string): boolean => concatDayLines(s).length > 0;
  assert.ok(caught('const sel = rows.filter((r) => r.ym + "-01" <= period.to && period.from <= r.ym + "-31").map((r) => r.label);'),
    "🔴 не спіймано рядок макета `r.ym + \"-31\"`");
  assert.ok(caught("const to = ym+'-30';"), "🔴 не спіймано `-30` в одинарних лапках без пробілів");
  assert.ok(caught("const to = m + `-29`;"), "🔴 не спіймано `-29` у зворотних лапках");
  assert.ok(caught("WHERE d <= (ym || '-31')::date"), "🔴 не спіймано SQL-конкатенацію `|| '-31'`");
  assert.ok(caught('period.from <= r.ym + "-31T23:59:59"'), "🔴 не спіймано день із хвостом часу `\"-31T23:59:59\"`");
  assert.ok(caught('const to = ym.concat("-31");'), "🔴 не спіймано `.concat(\"-31\")`");
  assert.ok(caught('const to = ym + "-" + "30";'), "🔴 не спіймано день окремим доданком `\"-\" + \"30\"`");
  assert.deepEqual(concatDayLines('const x = 1;\nconst to = r.ym +\n  "-31";'), [2], "🔴 не спіймано перенос рядка між `+` і `\"-31\"` (або не той номер рядка)");
  // 🪞 Законне: перше число є в кожному місяці; грудень має 31 день; не день (`-310`); коментар — не код.
  assert.equal(caught('months.filter((ym) => ym + "-01" <= today)'), false, "🔴 `-01` оголошено дефектом");
  assert.equal(caught('const dec = y + "-12-31";'), false, "🔴 фіксований грудень оголошено дефектом");
  assert.equal(caught('const d = monthEnd(ym + "-01");'), false, "🔴 виправлений рядок оголошено дефектом");
  assert.equal(caught('const code = prefix + "-310";'), false, "🔴 `-310` (не день) оголошено дефектом");
  assert.equal(caught('  // було r.ym + "-31"'), false, "🔴 коментар прийнято за код");
  assert.equal(isComment('  const x = r.ym + "-31";'), false, "🔴 живий рядок оголошено коментарем");
});

/**
 * 📜 #688 — `#685` шукає ОЗНАКИ макета, і перейменований підкладений скрипт (`lg-data.js` замість
 * `maket-data.js`) не несе жодної з них. Тому окреме твердження — про СТРУКТУРУ, а не про слова:
 * `index.html` вантажить РІВНО ОДИН скрипт — вхід застосунку `/src/main.tsx` (`type="module"`),
 * а `public`, який vite копіює в докрут як є, скриптів не несе. Порядок атрибутів — байдужий.
 */
const PUBLIC_SCRIPTS_ALLOWED: string[] = []; // свідомий скрипт у public — лише записом сюди, як у lock-файлі
function scriptProblems(html: string): string[] {
  const tags = [...html.replace(/<!--[\s\S]*?-->/g, " ").matchAll(/<script\b([^>]*)>/gi)];
  if (tags.length !== 1) return [`скриптів ${tags.length}, а має бути рівно один: ${tags.map((t) => t[0]).join(" ") || "жодного"}`];
  const attrs = Object.fromEntries([...tags[0][1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4]]));
  return attrs.src === "/src/main.tsx" && attrs.type === "module" ? [] : [`єдиний скрипт — не вхід застосунку: ${tags[0][0]}`];
}

test("#688 index.html вантажить рівно один скрипт — вхід застосунку /src/main.tsx, а public не несе скриптів", () => {
  const html = readFileSync(path.join(FE, "index.html"), "utf8");
  assert.match(html, /<div id="root">/, "🔴 frontend/index.html не схожий на сторінку застосунку — читаємо не той файл");
  assert.deepEqual(scriptProblems(html), [],
    "🔴 index.html вантажить щось, крім застосунку — так у макеті їхали maket-data.js і maket.js ДО main.tsx");
  const pub = walk(path.join(FE, "public"), /./);
  assert.ok(pub.includes(path.join(FE, "public", "favicon.svg")), `🔴 обхід public не знайшов favicon.svg (усього ${pub.length}) — шукали не там`);
  const scripts = pub.map((f) => path.relative(path.join(FE, "public"), f)).filter((f) => /\.(m?js|cjs)$/i.test(f) && !PUBLIC_SCRIPTS_ALLOWED.includes(f));
  assert.deepEqual(scripts, [], `🔴 у frontend/public є скрипти (перевірено ${pub.length} файлів): vite покладе їх у докрут як є. `
    + "Свідомий — внесіть у PUBLIC_SCRIPTS_ALLOWED цього гейта.");
});

test("#688b 🪞 ДЗЕРКАЛО: index.html макета й перейменований підкладений скрипт — спіймано; вхід із переставленими атрибутами — ні", () => {
  const entry = '<script type="module" src="/src/main.tsx"></script>';
  // index.html макета — дослівно три скрипти.
  assert.equal(scriptProblems(`<div id="root"></div>\n<script src="./maket-data.js"></script>\n<script src="./maket.js"></script>\n${entry}`).length, 1,
    "🔴 index.html макета не спійманий");
  assert.equal(scriptProblems(`<script src="./lg-data.js"></script>\n${entry}`).length, 1, "🔴 перейменований підкладений скрипт не спійманий");
  assert.equal(scriptProblems(`<script>window.__X = 1</script>\n${entry}`).length, 1, "🔴 вбудований скрипт не спійманий");
  assert.equal(scriptProblems('<script type="module" src="/src/other.tsx"></script>').length, 1, "🔴 чужий єдиний вхід не спійманий");
  assert.equal(scriptProblems("<div></div>").length, 1, "🔴 сторінка без входу застосунку оголошена чистою");
  // 🪞 Законне: той самий вхід з іншим порядком атрибутів; закоментований скрипт — не скрипт.
  assert.deepEqual(scriptProblems(entry), [], "🔴 вхід застосунку оголошено сторонньою вставкою");
  assert.deepEqual(scriptProblems("<script src='/src/main.tsx' type=\"module\"></script>"), [], "🔴 переставлені атрибути оголошено дефектом");
  assert.deepEqual(scriptProblems(`<!-- <script src="./maket.js"></script> -->\n${entry}`), [], "🔴 закоментований скрипт прийнято за живий");
});
