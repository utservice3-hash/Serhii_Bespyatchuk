import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 📈 #2447–#2449 — КІЛЬКА ПОКАЗНИКІВ НА ОДНОМУ ГРАФІКУ «СТАТИСТИК» (задача 5707, п.2 ТЗ Юлії 14.10.2026).
 *
 * Правила — у чистому модулі фронту `statsMulti.ts`, і гейти їх ВИКОНУЮТЬ (транспіляція, як `#370` для `statsGran.ts`),
 * а не читають очима. Друга половина кожного гейта звіряє ДЖЕРЕЛО компонента: правило в модулі нічого не варте, якщо
 * екран його не кличе.
 */
const FE_MULTI = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/statsMulti.ts", import.meta.url));
const FE_SECTION = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/StatisticsChartsSection.tsx", import.meta.url));

type M = { key: string; label: string; unit?: string; unitScope?: string; monthOnly?: boolean; weekOnly?: boolean };
async function loadMulti(): Promise<{
  MAX_METRICS: number; MAX_UNITS: number;
  canAdd: (sel: M[], c: M) => { ok: true } | { ok: false; reason: string };
  drawnScopes: (n: number, order: string[], visible: Set<string>) => string[];
  multiLines: (ms: M[]) => { dataKey: string; metricKey: string; unit: string; yAxisId: "left" | "right" }[];
  multiRows: (resps: unknown[], scopeKey: string | null) => Record<string, number | string>[];
}> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE_MULTI, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}
const money = (key: string): M => ({ key, label: key, unit: "₴" });
const pcs = (key: string): M => ({ key, label: key });
const pct = (key: string): M => ({ key, label: key, unit: "%" });

/**
 * #2447 — НЕ БІЛЬШЕ 3 ПОКАЗНИКІВ І НЕ БІЛЬШЕ 2 ОДИНИЦЬ. Обидва боки кожної межі: третій показник — можна, четвертий — ні;
 * друга одиниця — можна, третя — ні (і причина називає обидві осі); та сама одиниця третім показником — можна. Напрямок
 * (власний розріз) і показник з одним кроком — не поєднуються. Екран кличе `canAdd` і вимикає галочку з причиною.
 * 🧨 Червоніє, якщо підняти `MAX_METRICS`, пропустити третю одиницю або прибрати `canAdd` із меню.
 */
test("#2447 ЛІМІТИ: не більше 3 показників і не більше 2 одиниць; напрямок і показник з одним кроком — не поєднуються", async () => {
  const { MAX_METRICS, MAX_UNITS, canAdd } = await loadMulti();
  assert.deepEqual([MAX_METRICS, MAX_UNITS], [3, 2], "🔴 ліміти не ті, що в постановці (3 показники, 2 осі)");
  assert.equal(canAdd([money("a"), pcs("b")], money("c")).ok, true, "🔴 третій показник у наявній одиниці не додається");
  const fourth = canAdd([money("a"), pcs("b"), money("c")], pcs("d"));
  assert.equal(fourth.ok, false, "🔴 додався четвертий показник");
  assert.match(fourth.ok ? "" : fourth.reason, /не більше 3 показників/);
  assert.equal(canAdd([money("a")], pcs("b")).ok, true, "🔴 друга одиниця (права вісь) не додається");
  const third = canAdd([money("a"), pcs("b")], pct("c"));
  assert.equal(third.ok, false, "🔴 додалась третя одиниця — осей лише дві");
  assert.match(third.ok ? "" : third.reason, /«%».*«₴».*«шт»/, "🔴 причина не називає третю одиницю й обидві осі");
  assert.equal(canAdd([money("a")], money("a")).ok, false, "🔴 той самий показник додається двічі");
  assert.equal(canAdd([money("a")], { ...pcs("dir"), unitScope: "Міжнародка" }).ok, false, "🔴 напрямок поєднується з компанією/командою");
  assert.equal(canAdd([money("a")], { ...pcs("w"), weekOnly: true }).ok, false, "🔴 показник лише з тижнями поєднується з будь-яким кроком");
  const src = readFileSync(FE_SECTION, "utf8");
  assert.match(src, /import \{ MAX_METRICS, canAdd, drawnScopes, multiLines, multiRows \} from "\.\.\/statsMulti";/, "🔴 екран не бере правила з statsMulti");
  assert.match(src, /const verdict = on \? null : canAdd\(chosen, m\);/, "🔴 меню «＋ Показник» не питає canAdd");
  assert.match(src, /<input type="checkbox" checked=\{on\} disabled=\{off\}/, "🔴 недоступна галочка не вимкнена");
});

/**
 * #2448 — КІЛЬКА ПОКАЗНИКІВ — ОДИН СКОУП (компанія АБО одна команда). Один показник — усі вибрані скоупи, як було;
 * кілька — рівно один (перший вибраний у порядку легенди, або перший у легенді). Рядки графіка беруть значення ОДНОГО
 * скоупу; кнопки «Усі команди» в цьому режимі немає, клік по скоупу лише перемикає.
 * 🧨 Червоніє, якщо в режимі кількох показників малювати всі вибрані скоупи або повернути «Усі команди».
 */
test("#2448 СКОУП: один показник — усі вибрані; кілька — рівно один; рядки з одного скоупу; «Усі команди» сховано", async () => {
  const { drawnScopes, multiRows } = await loadMulti();
  const order = ["company", "13", "5"];
  assert.deepEqual(drawnScopes(1, order, new Set(["company", "5"])), ["company", "5"], "🔴 один показник: зникли вибрані команди");
  assert.deepEqual(drawnScopes(2, order, new Set(["13", "5"])), ["13"], "🔴 кілька показників — скоуп не одиничний");
  assert.deepEqual(drawnScopes(3, order, new Set()), ["company"], "🔴 кілька показників без вибору — не компанія");
  const resp = (v: number) => ({ series: [{ scopeKey: "company", points: [{ period: "2026-10-05", value: v }] }, { scopeKey: "13", points: [{ period: "2026-10-05", value: v + 1 }] }] });
  assert.deepEqual(multiRows([resp(10), resp(20)], "13"), [{ period: "2026-10-05", m0: 11, m1: 21 }], "🔴 рядки графіка змішують скоупи");
  const src = readFileSync(FE_SECTION, "utf8");
  assert.match(src, /const multiScope = multi \? \(drawnScopes\(chosen\.length, legendKeys, visibleKeys\)\[0\] \?\? null\) : null;/, "🔴 скоуп кількох показників не з drawnScopes");
  assert.match(src, /multiRows\(chosen\.map\(\(m, j\) => \(j === 0 \? resp : extraResp\[m\.key\]\)\), multiScope\)/, "🔴 рядки кількох показників не з одного скоупу");
  assert.match(src, /\{!multi && legendKeys\.length > 1 && \(/, "🔴 «Усі команди» доступне при кількох показниках");
  assert.match(src, /\{!multi && visibleSeries\.map\(/, "🔴 при кількох показниках малюються лінії скоупів");
  assert.match(src, /onClick=\{\(\) => \(multi \? isolate\(s\.scopeKey\) : toggle\(s\.scopeKey\)\)\}/, "🔴 клік по скоупу в режимі кількох показників додає другий скоуп");
});

/**
 * #2449 — КОЖНА ЛІНІЯ МАЄ СВІЙ `yAxisId` ЗА ОДИНИЦЕЮ: перша одиниця — ліва вісь, друга — права; два показники в гривнях
 * ділять ліву, хоч би де стояли в списку. На екрані — дві осі з тими самими id, підпис «ліва/права вісь» і застереження
 * «Збіг ліній не доводить, що один показник впливає на інший».
 * 🧨 Червоніє, якщо вісь лінії рахувати за її порядком, лінію намалювати без `yAxisId` або прибрати застереження.
 */
test("#2449 ОСІ: yAxisId лінії — за одиницею (₴ ліва, шт права, ₴ знову ліва); на екрані дві осі й застереження під графіком", async () => {
  const { multiLines } = await loadMulti();
  const ls = multiLines([money("revenue"), pcs("cars"), money("check")]);
  assert.deepEqual(ls.map((l) => [l.dataKey, l.yAxisId]), [["m0", "left"], ["m1", "right"], ["m2", "left"]], "🔴 вісь лінії не за одиницею");
  assert.deepEqual(multiLines([pcs("a"), pcs("b")]).map((l) => l.yAxisId), ["left", "left"], "🔴 однакова одиниця розʼїхалась по двох осях");
  const src = readFileSync(FE_SECTION, "utf8");
  assert.match(src, /\{multi && lines\.map\(\(l, j\) => \(\s*<Line key=\{l\.dataKey\} yAxisId=\{l\.yAxisId\}/, "🔴 лінія кількох показників без yAxisId своєї одиниці");
  assert.match(src, /<YAxis key="yl" yAxisId="left"/, "🔴 немає лівої осі");
  assert.match(src, /<YAxis key="yr" yAxisId="right" orientation="right"/, "🔴 немає правої осі");
  assert.ok(src.includes(`const MULTI_NOTE = "Збіг ліній не доводить, що один показник впливає на інший.";`), "🔴 застереження змінено або прибрано");
  assert.match(src, /\{multi && <div[^>]*>\{MULTI_NOTE\}<\/div>\}/, "🔴 застереження не показано під графіком кількох показників");
});
