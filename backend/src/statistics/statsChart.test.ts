import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 📈 #10900–#10904 — ВИГЛЯД РОЗГОРНУТОГО ГРАФІКА «СТАТИСТИК» (огляд графіків за методом dataviz, Роман 23.11.2026:
 * «роби фікси і викочуй»). Правила — у чистому модулі фронту `statsChart.ts`, і гейти їх ВИКОНУЮТЬ (транспіляція, як
 * `statsMulti.ts` / `statsCards.ts`); друга половина кожного гейта звіряє, що екран їх кличе.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SEC = "frontend/src/pages/dashboard/sections";
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

type Row = { period: string } & Record<string, unknown>;
async function loadChart(): Promise<{
  splitCurrent: (rows: Row[], keys: string[], curStart: string) => Row[];
  teamKeys: (s: { scopeKey: string; scopeType?: string; archived?: boolean; benchmark?: boolean }[], showArchived: boolean) => string[];
  periodTick: (p: string, g: "day" | "week" | "month") => string;
  periodTitle: (p: string, g: "day" | "week" | "month") => string;
  fmt: (n: number, unit?: string) => string;
  FULL_SUFFIX: string; CUR_SUFFIX: string;
}> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(read("frontend/src/pages/dashboard/statsChart.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #10900 — ВІКНО ГРАФІКА НЕ РОЗʼЇЖДЖАЄТЬСЯ З КНОПКОЮ ПЕРІОДУ. На проді 23.11: «12 міс» натиснуто, а після довантаження
 * команд графік показував усе від 06.2025. recharts 3.8 на зміні `data` скидає вікно брашу на весь ряд і не застосовує
 * `startIndex`/`endIndex` повторно (пропси ті самі). Заміряно окремим стендом на справжньому recharts 3.8.1: дані
 * підмінили через 300 мс — без ключа вікно p06–p17 стало p00–p17, з ключем лишилось p06–p17.
 * ⚠️ Гейт читає джерело (поведінку recharts у node не виконати): ключ графіка = версія рядків, і вона росте на кожні
 * нові рядки. 🧨 Червоніє, якщо прибрати `key` з графіка або зробити версію сталою.
 */
test("#10900 ВІКНО ГРАФІКА: нові рядки — новий графік (key = версія рядків), тож брашу не скидає на весь ряд", () => {
  const fe = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  assert.match(fe, /<LineChart data=\{rows\} key=\{chartVer\}/, "🔴 графік не перемонтовується на нових рядках — вікно скинеться на весь ряд");
  assert.match(fe, /const chartVer = useMemo\(\(\) => \+\+chartVerRef\.current, \[rows\]\);/, "🔴 версія графіка не росте з рядками");
  assert.match(fe, /<Brush [\s\S]{0,300}?startIndex=\{eff\.lo\} endIndex=\{eff\.hi\}/, "🪞 браш і далі бере вікно з кнопки періоду");
});

/**
 * #10901 — «УСІ КОМАНДИ» — ЦЕ КОМАНДИ, БЕЗ ЛІНІЇ КОМПАНІЇ (заміняє `#1763`). Компанія (~3 млн) на одній осі з командами
 * (0,1–1 млн) притискала їх до нуля. Обидва боки: компанія й бенчмарк — ні; команди — так (дзеркальний дозвіл:
 * функція, що повертає порожнечу, теж «не вмикає компанію»); розформована — лише з «показати архівні». Екран:
 * кнопка вмикає `teamKeys`, другий клік — назад до дефолту (лише компанія), дефолт не змінився.
 * 🧨 Червоніє, якщо `teamKeys` пропустить компанію чи бенчмарк, загубить команду або розформовану без галочки.
 */
test("#10901 «УСІ КОМАНДИ» — КОМАНДИ БЕЗ КОМПАНІЇ: компанія й бенчмарк — ні, команди — так, розформовані — лише з галочкою", async () => {
  const { teamKeys } = await loadChart();
  const series = [
    { scopeKey: "company", scopeType: "company" },
    { scopeKey: "bench", scopeType: "company", benchmark: true },
    { scopeKey: "11", scopeType: "team" },
    { scopeKey: "12", scopeType: "team" },
    { scopeKey: "36283", scopeType: "team", archived: true },
  ];
  assert.deepEqual(teamKeys(series, false), ["11", "12"], "🔴 «Усі команди» вмикає не рівно живі команди");
  assert.deepEqual(teamKeys(series, true), ["11", "12", "36283"], "🔴 з «показати архівні» розформована не вмикається");
  assert.deepEqual(teamKeys([], false), []);
  const fe = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  assert.match(fe, /const teams = teamKeys\(seriesList, showArchived\);/, "🔴 кнопка бере не правило `teamKeys`");
  assert.match(fe, /const allShown = teams\.length > 1 && teams\.every\(\(k\) => visibleKeys\.has\(k\)\);/, "🔴 кнопка не знає, чи вже ввімкнено всі команди");
  assert.match(fe, /const toggleAll = \(\) => setShown\(allShown \? null : new Set\(teams\)\);/, "🔴 другий клік не повертає дефолт — лише компанію");
  assert.match(fe, /<button type="button" onClick=\{toggleAll\}[\s\S]{0,300}\{allShown \? "Лише компанія" : "Усі команди"\}/, "🔴 кнопки «Усі команди» немає в легенді");
  assert.match(fe, /return new Set<string>\(first \? \[first\.scopeKey\] : \[\]\);/, "🪞 за замовчуванням уже не лише компанія");
});

/**
 * #10902 — ПЕРІОД, ЩО ЙДЕ, НЕ МАЛЮЄТЬСЯ ОБВАЛОМ. Розгорнутий графік: суцільна лінія лише по повних періодах, пунктир —
 * від останнього повного до того, що йде; вихідні ключі не чіпаються (таблиця, вісь, аномалії). Обидва боки межі:
 * день, рівний початку періоду, — уже «іде»; день перед ним — повний. Малий графік картки — лише повні періоди.
 * 🧨 Червоніє, якщо поточний період потрапить у суцільну лінію, пунктир не почнеться з останнього повного, вихідне
 * значення зникне з рядка або малий графік знову візьме неповний період.
 */
test("#10902 НЕПОВНИЙ ПЕРІОД: суцільна — лише повні, пунктир — від останнього повного; малий графік — лише повні", async () => {
  const { splitCurrent, FULL_SUFFIX: F, CUR_SUFFIX: C } = await loadChart();
  const rows: Row[] = [
    { period: "2026-09-01", s0: 10, s1: 1 },
    { period: "2026-10-01", s0: 20 },             // s1 у жовтні немає — місток s1 бере вересень
    { period: "2026-11-01", s0: 5, s1: 3 },
  ];
  const out = splitCurrent(rows, ["s0", "s1"], "2026-11-01");
  assert.deepEqual(out.map((r) => r.s0), [10, 20, 5], "🔴 вихідне значення зникло з рядка — таблиця й вісь його втратять");
  assert.deepEqual(out.map((r) => r[`s0${F}`]), [10, 20, undefined], "🔴 період, що йде (рівно curStart), потрапив у суцільну лінію");
  assert.deepEqual(out.map((r) => r[`s0${C}`]), [undefined, 20, 5], "🔴 пунктир не з останнього повного до того, що йде");
  assert.deepEqual(out.map((r) => r[`s1${C}`]), [1, undefined, 3], "🔴 місток пунктиру не з останньої точки серії");
  assert.equal(rows[2][`s0${F}`], undefined, "🔴 вихідні рядки змінено на місці");
  // Інший бік межі: поточного періоду в рядах немає — пунктиру немає, суцільна — до кінця.
  const closed = splitCurrent(rows.slice(0, 2), ["s0"], "2026-11-01");
  assert.deepEqual(closed.map((r) => r[`s0${C}`]), [undefined, undefined]);
  assert.deepEqual(closed.map((r) => r[`s0${F}`]), [10, 20]);
  const fe = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  assert.match(fe, /const rows: any\[\] = useMemo\(\(\) => splitCurrent\(baseRows, drawKeys, curStart\)/, "🔴 графік малює рядки не через `splitCurrent`");
  assert.match(fe, /dataKey=\{`s\$\{i\}\$\{FULL_SUFFIX\}`\}/, "🔴 суцільна лінія серії — не з повних періодів");
  assert.match(fe, /dataKey=\{`s\$\{i\}\$\{CUR_SUFFIX\}`\}[^>]*strokeDasharray=\{s\.benchmark \? "2 3" : "5 4"\}/, "🔴 період, що йде, не пунктиром");
  assert.match(fe, /dataKey=\{l\.dataKey \+ FULL_SUFFIX\}/, "🔴 кілька показників: суцільна — не з повних періодів");
  const mini = codeOnly(read(`${SEC}/StatsMiniChart.tsx`));
  assert.match(mini, /const rows = points\.filter\(\(p\) => p\.period < currentStart\)/, "🔴 малий графік картки знову бере неповний період");
  assert.equal((mini.match(/<Line\b/g) ?? []).length, 1, "🔴 на малому графіку знову друга лінія (пунктир неповного періоду)");
});

/** sRGB → OKLab (Björn Ottosson), ×100 — та сама метрика, що валідатор палітр dataviz. */
const lin = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
function oklab(h: string): number[] {
  const [r, g, b] = lin(h);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const dE = (a: string, b: string) => { const x = oklab(a), y = oklab(b); return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const lum = (h: string) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/**
 * #10903 — ПАЛІТРА ЛІНІЙ РОЗРІЗНЮВАНА Й ЧИТАЄТЬСЯ В ОБОХ ТЕМАХ. Сусідні слоти — ΔE ≥ 15 (OKLab ×100, звичайний зір;
 * було 5,7 між салатовим і зеленим), кожен колір — ≥ 3:1 до фону картки світлої й темної теми (фони — з `index.css`,
 * а не літерали; було 2,95:1 у фіолетового на темному). Зеленого й червоного карток («краще / гірше») серед кольорів
 * команд немає. Перевірено також повним валідатором dataviz (обидві теми, з дальтонізмом) — тут його нормальна частина.
 * 🧨 Червоніє, якщо поставити поруч два близькі кольори, взяти тьмяний для темної теми чи колір статусу.
 */
test("#10903 ПАЛІТРА: сусіди ΔE ≥ 15, контраст ≥ 3:1 на світлій і темній картці, без кольорів «краще / гірше»", () => {
  const fe = read(`${SEC}/StatisticsChartsSection.tsx`);
  const raw = /export const COLORS = \[([^\]]+)\]/.exec(fe)?.[1] ?? "";
  const colors = [...raw.matchAll(/"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
  assert.equal(colors.length, 8, `🔴 у палітрі ${colors.length} кольорів замість 8 — зріз зламався або слот зник`);
  assert.equal(colors[0], "#2f6fdb", "🔴 компанія більше не синя — перефарбовано всі екрани, що її знають");
  const css = read("frontend/src/index.css");
  const light = /:root\s*\{[\s\S]*?--card-bg:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
  const dark = /:root\[data-theme="dark"\]\s*\{[\s\S]*?--card-bg:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
  assert.ok(light && dark, "🔴 не знайшов фони карток у index.css — перевіряти контраст нема з чим");
  const close = colors.slice(1).map((c, i) => [colors[i], c, dE(colors[i], c)] as const).filter(([, , d]) => d < 15);
  assert.deepEqual(close.map(([a, b, d]) => `${a}↔${b} ${d.toFixed(1)}`), [], "🔴 сусідні кольори ліній злипаються");
  for (const bg of [light!, dark!]) {
    const dim = colors.filter((c) => contrast(c, bg) < 3).map((c) => `${c} ${contrast(c, bg).toFixed(2)}`);
    assert.deepEqual(dim, [], `🔴 кольори ліній тьмяні на фоні ${bg}`);
  }
  const status = [...fe.matchAll(/dl\?\.tone === "(?:good|bad)" \? "(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
  assert.equal(status.length, 2, "🔴 не знайшов кольорів «краще / гірше» картки — перевірка стала б порожньою");
  assert.deepEqual(colors.filter((c) => status.includes(c)), [], "🔴 колір команди збігається з кольором «краще / гірше»");
  // 🪞 Межа живе: метрика розрізняє очевидно близькі й очевидно різні.
  assert.ok(dE("#65a30d", "#16a34a") < 15 && dE("#2f6fdb", "#ea580c") > 15);
});

/**
 * #10904 — ПІДПИСИ Й ДРІБНИЦІ ГРАФІКА. Місяць на осі — «лис 26», а не «01.11.26»; тиждень у підказці й таблиці —
 * «тиждень 17.11–23.11.26» (через межу року теж); мільйони — через кому, як на осі. Екран: вісь і браш підписані
 * `periodTick`, підказка не фарбує текст кольором лінії, сітка суцільна, лінії прямі, таблиця не ріже рядків.
 * 🧨 Червоніє, якщо повернути дату першого числа місяця на вісь, крапку в «млн», колір лінії на текст підказки,
 * пунктирну сітку, згладжування або обрізання таблиці.
 */
test("#10904 ПІДПИСИ: місяць — «лис 26», тиждень — діапазоном, «3,14 млн ₴»; текст підказки — не кольором лінії; сітка суцільна; лінії прямі", async () => {
  const { periodTick, periodTitle, fmt } = await loadChart();
  assert.equal(periodTick("2026-11-01", "month"), "лис 26");
  assert.equal(periodTick("2026-01-01", "month"), "січ 26");
  assert.equal(periodTick("2026-11-17", "week"), "17.11.26");
  assert.equal(periodTitle("2026-11-01", "month"), "листопад 2026");
  assert.equal(periodTitle("2026-11-17", "week"), "тиждень 17.11–23.11.26");
  assert.equal(periodTitle("2026-12-28", "week"), "тиждень 28.12–03.01.27", "🔴 тиждень через межу року підписано не тим кінцем");
  assert.equal(periodTitle("2026-11-17", "day"), "17.11.26");
  assert.equal(fmt(3_140_000, "₴"), "3,14 млн ₴", "🔴 мільйони знову з крапкою");
  assert.match(fmt(950_000, "₴"), /^950\s000 ₴$/u, "🪞 менше мільйона — цілим із пробілом");
  assert.equal(fmt(4.25, "%"), "4,3%");
  const fe = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  assert.match(fe, /<XAxis dataKey="period" tickFormatter=\{\(p\) => periodTick\(String\(p\), effGran\)\}/, "🔴 вісь X підписана не `periodTick`");
  assert.match(fe, /<Brush [^\n]*tickFormatter=\{\(p\) => periodTick\(String\(p\), effGran\)\}/, "🔴 браш підписаний не `periodTick`");
  assert.doesNotMatch(fe, /color: p\.stroke/, "🔴 текст підказки знову кольором лінії");
  assert.match(fe, /<CartesianGrid stroke="var\(--border\)" vertical=\{false\} \/>/, "🔴 сітка знову пунктирна");
  assert.doesNotMatch(fe, /type="monotone"/, "🔴 лінії знову згладжені — крива вигадує проміжні значення");
  assert.doesNotMatch(fe, /\.reverse\(\)\.slice\(0, \d+\)/, "🔴 таблиця значень знову мовчки обрізана");
  assert.doesNotMatch(fe, /^const fmt = /m, "🔴 у компоненті знову своя копія `fmt`");
});
