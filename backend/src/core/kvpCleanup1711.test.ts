import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ✂️ ПРАВКИ ЗУСТРІЧІ 17.11.2026 — Звіт КВП (нотатки Романа `fixes_uts 17-11.pages`, «роби» 20.11.2026).
 *
 * Що вирішили: зі Звіту КВП прибрати аналітику (Сигнали, Тримають, двигуни Реклама/Лідген, Структура виручки,
 * Ризики/retention, лідгени-постійні, Логістика з дебіторкою, маржею, швидкістю й концентрацією, розбір по командах,
 * таблицю-дубль «Першого дотику»), шкалу плану підняти нагору й показувати суми повністю, ЗАЛИШИТИ короткий перелік
 * показників, а «Повну таблицю» з виставленням планів перенести в «Плани».
 *
 * Гейти тут стережуть саме ці рішення — і кожна заборона має дзеркальний дозвіл: прибране зі Звіту КВП мусить
 * ЛИШИТИСЬ там, куди переїхало (екран AI, «Плани»), інакше «прибрали» непомітно стало б «видалили зовсім».
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "routes/dashboard.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const BE = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(SRC, "../../frontend/src", rel), "utf8");
const KVP = "pages/dashboard/sections/KvpReportSection.tsx";
/** Тіло головного компонента екрана — від його оголошення до наступного верхньорівневого компонента. */
const screenBody = (): string => {
  const fe = FE(KVP);
  const a = fe.indexOf("export function KvpReportSection(");
  const b = fe.indexOf("\nfunction ", a + 10);
  assert.ok(a > 0 && b > a, "🔴 компонент Звіту КВП не знайдено — перевіряти нема що");
  return fe.slice(a, b);
};

/**
 * #9501 — ПРИБРАНЕ ЗІ ЗВІТУ КВП НЕ ПОВЕРТАЄТЬСЯ. Червоніє, якщо в екран Звіту КВП повернеться будь-який із прибраних
 * блоків: Сигнали, Тримають, двигуни (ROMI, «Лідген (3 якорі)»), Структура виручки, Ризики/retention, лідгени-постійні,
 * Логістика, «Повна таблиця», розбір по командах.
 */
test("#9501 ЗВІТ КВП БЕЗ АНАЛІТИКИ: Сигнали, Тримають, двигуни, структура, ризики, логістика, повна таблиця й розбір по командах прибрані", () => {
  const body = screenBody();
  const gone: [RegExp, string][] = [
    [/rep\.signals\b/, "Сигнали"],
    [/rep\.topPerformers\b/, "Тримають"],
    [/rep\.engines\.(rpk|rnk)\b/, "двигуни «Повний цикл / Реклама»"],
    [/ROMI|rep\.engines\.leadgen\b/, "двигуни «Реклама ROMI / Лідген (3 якорі)»"],
    [/StructureBlock|revenueStructure/, "Структура виручки"],
    [/RetentionBlock|rep\.retention\b/, "Ризики / retention"],
    [/LeadgenRegularsCard/, "лідгени-постійні"],
    [/LogisticsSection|rep\.logistics\b/, "Логістика"],
    [/<KvpPlanTable\b|<FullTable\b/, "Повна таблиця"],
    [/<ReviewByTeamBlock\b/, "розбір по командах"],
  ];
  const back = gone.filter(([re]) => re.test(body)).map(([, n]) => n);
  assert.deepEqual(back, [], `🔴 у Звіт КВП повернулось прибране 17.11.2026: ${back.join(", ")}`);
  // Дзеркало: ядро екрана на місці — інакше «нічого з прибраного немає» було б правдою й про порожній екран.
  for (const [re, n] of [[/💰 Гроші за/, "Гроші"], [/🏅 Команди — план \/ факт/, "Команди"], [/<KvpFirstTouchBlock\b/, "Перший дотик"], [/<MonthMetrics\b/, "Показники місяця"]] as const) {
    assert.match(body, re, `🔴 зник блок «${n}», якого прибирати не вирішували`);
  }
});

/**
 * #9502 — 🪞 ДЗЕРКАЛО #9501: ПРИБРАНЕ ПЕРЕЇХАЛО, А НЕ ЗНИКЛО. Розбір по командах лишається на екрані AI (і там
 * перечитується після розбору); повна таблиця з ✎ — у «Плани» → «Плани КВП», збереження йде тим самим `saveKvpPlan`
 * через `commitOptimistic`. Червоніє, якщо разом зі Звітом КВП блок прибрали й звідти.
 */
test("#9502 ПЕРЕЇХАЛО, А НЕ ЗНИКЛО: розбір по командах — на екрані AI, повна таблиця з ✎ — у «Плани КВП»", () => {
  const ai = FE("pages/dashboard/sections/AiCallsSection.tsx");
  assert.match(ai, /\{d\.canReview && <ReviewByTeamBlock variant="ftd" refresh=\{reload\} \/>\}/, "🔴 розбору по командах немає й на екрані AI");
  const tab = FE("pages/dashboard/sections/KvpPlansTab.tsx");
  assert.match(tab, /<KvpPlanTable rep=\{rep\} plans=\{plans\} onSave=\{onSave\} \/>/, "🔴 у «Плани КВП» немає таблиці планів");
  assert.match(tab, /save: \(\) => saveKvpPlan\(month, \{ \[k\]: val \}\)/, "🔴 план КВП зберігається не через commitOptimistic");
  assert.match(FE(KVP), /export function KvpPlanTable\(\{ rep, plans, onSave \}/, "🔴 таблиця планів не та сама, що була на Звіті КВП");
  const tabs = FE("pages/dashboard/sections/PlansTabs.tsx");
  assert.match(tabs, /\{canKvp && tab\("kvp", "🎯 Плани КВП"\)\}/, "🔴 вкладки «Плани КВП» немає в «Плани»");
  assert.match(tabs, /view === "kvp" && canKvp \? <KvpPlansTab \/>/, "🔴 вкладка є, а таблиця не показується (або показується без права)");
});

/**
 * #9503 — «ПЛАНИ КВП» БАЧИТЬ РІВНО ТОЙ, КОМУ СЕРВЕР ДАСТЬ ДАНІ. `/kvp-plan` і `/kvp-report` гейтяться екраном «Звіт КВП»
 * (`roleHasTab(..., "kvp")`), тому вкладку вмикає саме цей екран. Червоніє, якщо вкладку покажуть без екрана (людина
 * отримає 403 замість таблиці) або сервер почне гейтити план інакше, ніж вкладку.
 */
test("#9503 ВКЛАДКА «ПЛАНИ КВП» = ЕКРАН «ЗВІТ КВП»: та сама межа, що в сервера", () => {
  assert.match(FE("pages/Dashboard.tsx"), /<PlansTabs auth=\{[^}]*\}\} teams=\{teams\} canKvp=\{!!screens\?\.includes\("kvp"\)\} \/>/,
    "🔴 вкладка «Плани КВП» вмикається не екраном «Звіт КВП»");
  const be = BE("routes/dashboard.ts");
  for (const m of ["get", "post"] as const) {
    const at = be.indexOf(`dashboardRouter.${m}("/kvp-plan"`);
    assert.ok(at > 0, `🔴 ${m.toUpperCase()} /kvp-plan не знайдено — перевірка стала б порожньою`);
    assert.match(be.slice(at, at + 600), /if \(!roleHasTab\(auth\.roleKey, "kvp"\)\) return res\.status\(403\)/, `🔴 ${m.toUpperCase()} /kvp-plan гейтиться не екраном «Звіт КВП»`);
  }
});

/**
 * #9504 — «ПОКАЗНИКИ МІСЯЦЯ» — РІВНО ТЕ, ЩО ЗУСТРІЧ ВЕЛІЛА ЛИШИТИ. Одинадцять рядків, у цьому порядку. 16.11 «перенеси
 * всі показники» загубило частину без жодного червоного — тому перелік зашитий поіменно. Червоніє, якщо рядок зникне,
 * зʼявиться зайвий або порядок зміниться.
 */
test("#9504 ПОКАЗНИКИ МІСЯЦЯ: 11 рядків зустрічі 17.11, поіменно й по порядку", () => {
  const fe = FE(KVP);
  const a = fe.indexOf("function MonthMetrics(");
  const b = fe.indexOf("  return (", a);
  assert.ok(a > 0 && b > a, "🔴 блоку «Показники місяця» немає");
  const labels = [...fe.slice(a, b).matchAll(/\{ label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    "Поставлені авто (план-факт)", "Ліди з реклами", "Ліди з лідогену", "Ліди з LinkedIn", "Ліди з Prozorro", "Втрачені",
    "Середній чек", "Середній чек нових", "Вартість клієнта", "Середній цикл угоди", "Конверсія реклами",
  ], "🔴 перелік «Показників місяця» розійшовся з рішенням зустрічі 17.11");
  // Пояснення «що це таке» до втрачених — пряма вимога зустрічі («втрачені залишити і розписати, що це таке»).
  assert.match(fe.slice(a, b), /label: "Втрачені", hint: "Що це: [^"]{40,}"/, "🔴 «Втрачені» без пояснення, що це");
});

/**
 * #9505 — У «ПОКАЗНИКАХ МІСЯЦЯ» СВОЇХ ФОРМУЛ НЕМАЄ. LinkedIn і Prozorro — кошики партиції «Створено» з 9230 (те саме
 * число, що колонки Звіту), решта — поля `/kvp-report`, якими жила повна таблиця. Червоніє, якщо блок почне рахувати
 * сам (свій фільтр по угодах, своє ділення грошей) замість читати відповідь ядра.
 */
test("#9505 ПОКАЗНИКИ МІСЯЦЯ ЧИТАЮТЬ ЯДРО: LinkedIn/Prozorro — з партиції 9230, чеки — з newMetrics", () => {
  const fe = FE(KVP);
  const a = fe.indexOf("function MonthMetrics(");
  const blk = fe.slice(a, fe.indexOf("\n}\n", a));
  assert.match(blk, /const nm = rep\.newMetrics, en = rep\.engines, cs = rep\.createdSplit\.totals;/, "🔴 джерела блоку змінились");
  assert.match(blk, /fact: fmtNum\(cs\.linkedin\)/, "🔴 LinkedIn не з партиції «Створено» (9230)");
  assert.match(blk, /fact: fmtNum\(cs\.prozorro\)/, "🔴 Prozorro не з партиції «Створено» (9230)");
  assert.match(blk, /fact: money\(nm\.avgCheck\)/, "🔴 середній чек не з ядра");
  assert.match(blk, /fact: money\(nm\.avgCheckNew\)/, "🔴 середній чек нових не з ядра");
  // Жодного ділення грошей у браузері: чек рахує сервер.
  assert.doesNotMatch(blk, /revenue\s*\/|\/\s*[a-zA-Z.]*deals\b/, "🔴 блок ділить гроші сам — чек мусить приходити з ядра");
});

/**
 * #9506 — ЧЕК ФАКТИЧНИЙ ЗА СЛОВНИКОМ §5. `avgCheck` = отримані кошти ÷ угоди ТІЄЇ САМОЇ множини; `avgCheckNew` — та
 * сама формула над сегментом нових тієї ж каси. Ділення на нуль — `null`, а не 0 (нуль читався б як «чек нульовий»).
 * Червоніє, якщо чисельник і знаменник візьмуть із різних множин (напр. успішні ÷ отримані) або нуль стане числом.
 */
test("#9506 СЕРЕДНІЙ ЧЕК і ЧЕК НОВИХ: каса ÷ угоди тієї самої множини, без угод — null", () => {
  const be = BE("routes/dashboard.ts");
  assert.match(be, /avgCheck: received\.deals > 0 \? Math\.round\(received\.revenue \/ received\.deals\) : null,/,
    "🔴 середній чек рахується не за словником §5 (каса ÷ угоди каси) або нуль угод дає число");
  assert.match(be, /avgCheckNew: receivedSeg\.newSeg\.deals > 0 \? Math\.round\(receivedSeg\.newSeg\.revenue \/ receivedSeg\.newSeg\.deals\) : null,/,
    "🔴 чек нових не з сегмента нових тієї ж каси");
});

/**
 * #9507 — ШКАЛА ПЛАНУ НАГОРІ, І ЛИШЕ ОДНА. Зустріч: «шкалу записати наверх і прибрати її знизу». Червоніє, якщо смуга
 * виконання плану опиниться в «Детальному звіті» або їх стане дві; і якщо в підписі смуги суми знову скоротяться до
 * «3.1M» (там же: «менше заокруглення»), а прогноз перестане бути названим числом.
 */
test("#9507 ШКАЛА ПЛАНУ — ОДНА, У ЯДРІ, СУМИ ПОВНІСТЮ, ПРОГНОЗ ЧИСЛОМ", () => {
  const body = screenBody();
  const bars = [...body.matchAll(/<PlanBar factPct=\{v\.planPct\}/g)].map((m) => m.index ?? -1);
  assert.equal(bars.length, 1, `🔴 шкал виконання плану відділу ${String(bars.length)}, а має бути одна`);
  const details = body.indexOf("📂 Детальний звіт");
  assert.ok(details > 0, "🔴 межу «Детальний звіт» не знайдено — порядок перевірити нема по чому");
  assert.ok(bars[0] < details, "🔴 шкала плану стоїть у «Детальному звіті», а не нагорі");
  assert.ok(bars[0] > body.indexOf("💰 Гроші за"), "🔴 шкала плану вище за картку грошей — не там, де вирішили");
  assert.match(body, /▉ факт \{fmtFull\(v\.received\.revenue\)\} · ▨ очікуємо \{fmtFull\(v\.projection\.expectedThisMonth\)\} за план\. датою = прогноз <b[^>]*>\{fmtFull\(v\.projection\.projected\)\}<\/b>/,
    "🔴 підпис шкали знову скорочує суми або не називає прогноз");
});

/**
 * #9508 — «ПЕРШИЙ ДОТИК» У ЗВІТІ КВП: ЛИШЕ КАРТКИ, ЯКІ ВЕДУТЬ НА ЕКРАН AI. Таблицю «Команда / менеджер» прибрано як
 * дубль екрана AI; цифри карток — та сама `firstTouchSummary` / `tileStats().decision`, що на екрані (свого розрахунку
 * немає); клік по картці відкриває екран AI з цим фільтром; фінансист без вкладки AI блоку не бачить.
 * Червоніє, якщо таблиця повернеться, картка перестане вести на екран AI або блок почне рахувати сам.
 */
test("#9508 ПЕРШИЙ ДОТИК У ЗВІТІ КВП: великі цифри без таблиці, клік → екран AI, розрахунок спільний", () => {
  const kvp = FE("pages/dashboard/sections/KvpFirstTouchBlock.tsx");
  assert.doesNotMatch(kvp, /<table\b|<th\b|<select\b/, "🔴 у Звіт КВП повернулась таблиця «Першого дотику» — дубль екрана AI");
  assert.match(kvp, /onClick=\{\(\) => open\(\{ tile: k \}\)\}/, "🔴 клік по картці не веде на екран AI з цим фільтром");
  assert.match(kvp, /firstTouchSummary\(d\.rows\)/, "🔴 блок рахує не спільною функцією");
  assert.doesNotMatch(kvp, /\btileStats\(|\bmanagerChecklist\(/, "🔴 у блоці своя копія розрахунку");
  assert.match(kvp, /card\(ts\.decision\.of \? "agreed" : null, "Клієнт погодився", pctStr\(ts\.decision\.pct\)/, "🔴 «Клієнт погодився» не з tileStats().decision");
  for (const lbl of ["Ціна озвучена", "Обіцяли — дзвінка в телефонії немає", "Заперечення опрацьовано", "Клієнт погодився", "Поїхало", "Втрачені ліди"]) {
    assert.ok(kvp.includes(`"${lbl}"`), `🔴 зникла картка «${lbl}» — великі цифри якості й кількості вирішили лишити`);
  }
  assert.match(FE("pages/Dashboard.tsx"), /<KvpReportSection canSeeFirstTouch=\{!!screens\?\.includes\("ai-calls"\)\} \/>/, "🔴 блок бачить роль без вкладки «Перший дотик · AI»");
  assert.match(FE(KVP), /\{canSeeFirstTouch && <KvpFirstTouchBlock from=\{rep\.scope\.from\} to=\{rep\.scope\.to\} \/>\}/, "🔴 блок не стоїть у Звіті КВП або бере інший період");
  // Екран AI читає перехід зі Звіту КВП — інакше клік по картці відкриє екран без фільтра.
  assert.match(FE("pages/dashboard/sections/AiCallsSection.tsx"), /parseAiLink\(window\.location\.search\)/, "🔴 екран AI не читає перехід зі Звіту КВП");
});

// ───────────── 📅 Навігація періодом у стилі Звіту на Звіті КВП і в «Плани КВП» (Роман 20.11.2026) ─────────────

/** Транспілює чистий фронтовий модуль без імпортів і повертає його експорти. */
async function loadFe(rel: string): Promise<any> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #9512 — ПЕРІОД ЗВІТУ КВП З НАВІГАТОРА: місяць іде пресетом із 1-го числа (сервер тоді віддає тижні Т1–Т5 і «з
 * очікуваннями»), довільний період — межами; план — місяця, де період починається. Якір дня й тижня тримає `K5`.
 * 🧨 Червоніє, якщо місяць піде межами замість пресета (зникнуть тижні й «з очікуваннями»), довільний період —
 * пресетом, або план візьметься не з того місяця.
 */
test("#9512 ПЕРІОД ЗВІТУ КВП: місяць — пресет з 1-го числа, довільний період — межі; план — місяця початку", async () => {
  const r = await loadFe("pages/dashboard/kvpCoreRules.ts");
  const st = (mode: string, over: Record<string, string> = {}) => ({ mode, anchor: "2026-08-20", focusDay: "2026-08-12", rangeFrom: "2026-07-28", rangeTo: "2026-08-03", ...over });
  assert.deepEqual(r.kvpReportParams(st("month")), { preset: "month", date: "2026-08-01" }, "🔴 місяць іде не пресетом з 1-го числа");
  assert.deepEqual(r.kvpReportParams(st("range")), { from: "2026-07-28", to: "2026-08-03" }, "🔴 довільний період іде не межами");
  assert.deepEqual([r.kvpPlanMonth(st("month")), r.kvpPlanMonth(st("week")), r.kvpPlanMonth(st("range"))], ["2026-08", "2026-08", "2026-07"], "🔴 план береться не з місяця початку періоду");
});

/**
 * #9513 — ОДИН НАВІГАТОР ПЕРІОДУ НА ЗВІТІ, ЗВІТІ КВП І В «ПЛАНИ КВП». Усі три малюють `PeriodStepper`; своїх кнопок
 * «День/Тиждень/…» і полів дат на Звіті КВП більше немає; «Плани КВП» — лише місяць і з майбутніми місяцями;
 * Звіт кличе контрол без нових параметрів (його поведінка не змінилась).
 * 🧨 Червоніє, якщо Звіт КВП поверне власні кнопки періоду чи `DatePicker`, запит піде повз `kvpReportParams`,
 * «Плани КВП» втратять майбутні місяці, або Звіт отримає `allowFuture`.
 */
test("#9513 ОДИН НАВІГАТОР ПЕРІОДУ: Звіт КВП і «Плани КВП» малюють PeriodStepper; Звіт — без нових параметрів", () => {
  const kvp = FE(KVP);
  assert.match(kvp, /<PeriodStepper state=\{nav\} onPatch=\{\(patch\) => setNav\(\(st\) => \(\{ \.\.\.st, \.\.\.patch \}\)\)\} today=\{today\} \/>/, "🔴 Звіт КВП малює не навігатор Звіту");
  assert.doesNotMatch(kvp, /DatePicker|"quarter"|kvpDPreset|setPresetP/, "🔴 на Звіті КВП лишились старі кнопки періоду або поля дат");
  assert.match(kvp, /fetchKvpReport\(kvpReportParams\(nav\)\)/, "🔴 запит Звіту КВП збирається повз kvpReportParams");
  assert.match(kvp, /const planMonth = kvpPlanMonth\(nav\);/, "🔴 місяць плану не з навігатора");
  const tab = FE("pages/dashboard/sections/KvpPlansTab.tsx");
  assert.match(tab, /<PeriodStepper state=\{nav\} onPatch=\{[^\n]*\} today=\{today\} modes=\{\["month"\]\} allowFuture \/>/, "🔴 «Плани КВП»: не місячний навігатор або без майбутніх місяців");
  assert.doesNotMatch(tab, /DatePicker/, "🔴 у «Плани КВП» лишився старий вибір місяця");
  // 🪞 Дзеркало: Звіт кличе той самий контрол БЕЗ нових параметрів — майбутнє там закрите, довжин чотири.
  const rep = FE("pages/dashboard/sections/ReportPlanSection.tsx");
  assert.match(rep, /<PeriodStepper state=\{navState\} onPatch=\{applyNav\} today=\{today\} \/>/, "🔴 Звіт кличе навігатор інакше, ніж до 20.11");
});

