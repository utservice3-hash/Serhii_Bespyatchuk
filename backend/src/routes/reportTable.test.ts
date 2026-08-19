import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * #81…#88 — ТАБЛИЧНИЙ ВИГЛЯД ЗВІТУ (19.08.2026).
 *
 * 🔴 ЧОМУ ЧАСТИНА ГЕЙТІВ ВИКОНУЄ ФРОНТОВИЙ КОД, А НЕ ЧИТАЄ ЙОГО ТЕКСТОМ.
 * Реєстр колонок (`reportTableCols.ts`) — ЧИСТИЙ модуль: жодного React, жодного
 * імпорту, окрім `import type`. Тому його можна транспілювати і ВИКЛИКАТИ прямо
 * звідси, тобто перевіряти поведінку (сортування, підсумки), а не наявність
 * потрібних слів у файлі. Текстова перевірка «у коді написано ratio» зеленіла б
 * і тоді, коли функція рахує щось інше.
 *
 * Там, де перевіряти треба ВЕРСТКУ (що колонка справді рендериться, що таблиця не
 * робить власного запиту), лишається читання джерела — браузера в прийманні немає,
 * і це чесна межа, та сама, що в #79.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const FE = path.join(ROOT, "frontend", "src", "pages", "dashboard");
const COLS_TS = path.join(FE, "reportTableCols.ts");
const TABLE_TSX = path.join(FE, "sections", "ReportTableSection.tsx");
const REPORT_TSX = path.join(FE, "sections", "ReportPlanSection.tsx");
const CSS = path.join(ROOT, "frontend", "src", "index.css");

/** Транспілює чистий фронтовий модуль і повертає його справжні експорти. */
async function loadCols(source?: string): Promise<any> {
  const ts = (await import("typescript")).default;
  const src = source ?? readFileSync(COLS_TS, "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), "rptcols-"));
  const file = path.join(dir, "cols.mjs");
  writeFileSync(file, js);
  return import(file);
}

/** Мінімальний рядок менеджера — рівно ті поля, які читає реєстр. */
function mgr(over: Record<string, any> = {}): any {
  return {
    managerId: 1, name: "Тест", teamId: 5, teamName: "РПК", tag: "rpk",
    plan: 100000, fact: 50000, pct: 50, expect: 0, factSuccess: 50000, factPaid: 0,
    factSuccessDeals: 5, factPaidDeals: 0, talks: 10, attempts: 3,
    expectNoDate: 0, expectNoDateDeals: 0, jam: 7000, jamDeals: 2,
    byPace: 0, byPaceEarly: false, expectThisMonth: 20000, expectNextMonth: 0, dobir: 1000,
    cohort: { deals: 0, sum: 0, paidDeals: 0, paidSum: 0, awaitDeals: 0, awaitSum: 0, awaitDatedSum: 0, awaitNoDateSum: 3000 },
    week: {} as any, projected: 70000, monthInProgress: true,
    created: 30, new: 10, rep: 20, srcAd: 1, srcLeadgen: 2,
    status: "a", needPerDay: 5000, remainingWorkdays: 10, spark: [],
    kpi: {
      ads: { fact: 4, target: 0 }, leadgen: { fact: 3, target: 0 },
      dispatch: { fact: 12, target: 10, revenue: 90000 },
      avgCheck: { fact: 3000, target: 0, revenue: 30000, deals: 10 },
      conversion: { fact: 20, target: 0, taken: 50, won: 10 },
    },
    ...over,
  };
}

// ──────────────────────────── #81 · одне джерело ────────────────────────────

test("#81 ТАБЛИЦЯ НЕ МАЄ ВЛАСНОГО ДЖЕРЕЛА ДАНИХ — той самий об'єкт, що картки", () => {
  const s = readFileSync(TABLE_TSX, "utf8");
  // 🔴 Найдешевший спосіб розсинхронити дві подачі — дати таблиці власний фетч.
  // Тоді «картки кажуть 0, таблиця 23 632» стає питанням часу, а не помилки.
  for (const bad of ["fetchReportPlan", "api.get(", "useEffect(() => {\n    fetch"])
    assert.equal(s.includes(bad), false,
      `🔴 таблиця сама тягне дані (${bad}) — це друге джерело для тих самих чисел`);
  assert.ok(/data,\s*teams,\s*auth/.test(s) && /data: ReportPlan;/.test(s),
    "🔴 таблиця більше не отримує ReportPlan пропсом — значить бере його десь інде");
  const rp = readFileSync(REPORT_TSX, "utf8");
  assert.ok(/<ReportTableSection\s+[\s\S]{0,400}?data=\{data\}/.test(rp),
    "🔴 контейнер передає в таблицю не `data` (той самий periodData, що й картки)");
});

test("#81b РЕЄСТР І ВЕРСТКА ЗБІГАЮТЬСЯ: кожна колонка має і опис, і рендер", async () => {
  const { REPORT_COLS } = await loadCols();
  const s = readFileSync(TABLE_TSX, "utf8");
  const missing = REPORT_COLS.filter((c: any) => !new RegExp(`case "${c.key}"`).test(s)).map((c: any) => c.key);
  assert.deepEqual(missing, [],
    "🔴 колонка оголошена в реєстрі, але не рендериться — у таблиці буде порожній стовпчик "
    + "із заголовком, тобто «даних немає» під виглядом даних");
  assert.ok(REPORT_COLS.length >= 20, `реєстр згорнувся до ${REPORT_COLS.length} колонок — розбір зламався`);
});

// ──────────────────────────── #90 · пояснення колонок ────────────────────────────

test("#90 КОЖНА КОЛОНКА ПОЯСНЮЄ СЕБЕ: що показує і звідки береться", async () => {
  const { REPORT_COLS, NO_HELP_COLS } = await loadCols();
  const exempt = new Set(NO_HELP_COLS);
  const naked = REPORT_COLS
    .filter((c: any) => !exempt.has(c.key))
    // Поріг ловить ЗАГЛУШКУ («—», «TODO»), а не стислість: «Отримано ÷ план.» —
    // повне пояснення, і карати його за довжину означало б вимагати води.
    .filter((c: any) => typeof c.help !== "string" || c.help.trim().length < 12)
    .map((c: any) => `${c.key} («${c.title}»)`);
  assert.deepEqual(naked, [],
    "🔴 КОЛОНКА БЕЗ ПОЯСНЕННЯ. Заголовок на кшталт «Затор (рах.)» або «Ліди >1год» "
    + "нічого не каже людині, яка бачить його вперше, а вгадане значення гірше за "
    + "відсутнє: за ним ухвалюють рішення. Додай `help` у reportTableCols.ts:\n  "
    + naked.join("\n  "));

  // Пояснення мусить казати ЗВІДКИ, а не лише що: без джерела його неможливо перевірити.
  const noSource = REPORT_COLS
    .filter((c: any) => !exempt.has(c.key) && typeof c.help === "string")
    // Ознака джерела — або слово «джерело», або формула (÷), або назва функції
    // ядра у формі `модуль.функція`. Перша редакція шукала лише «Джерело:» і
    // червоніла на «Факт — metrics.dispatchedByManager (за подіями)», де джерело
    // назване ПРЯМІШЕ, ніж у решти. Гейт має ловити відсутність джерела, а не
    // відхилення від однієї формули підпису.
    .filter((c: any) => !/джерел|÷|[a-zA-Z]+\.[a-zA-Z]{3,}/i.test(c.help))
    .map((c: any) => c.key);
  assert.deepEqual(noSource, [],
    "🔴 пояснення не називає джерела (функцію ядра або формулу) — його нема з чим звірити");

  // Список винятків НЕ має розповзатись: інакше «колонка без help» стане нормою.
  assert.deepEqual([...NO_HELP_COLS].sort(), ["name", "rank"],
    "🔴 перелік колонок без пояснення змінився — це рішення, а не дрібниця");
});

test("#90b ПОЯСНЕННЯ ДОХОДИТЬ ДО ЕКРАНА, і не лише через title", async () => {
  const { REPORT_COLS } = await loadCols();
  const s = readFileSync(TABLE_TSX, "utf8");
  // Шапка мусить рендерити саме `help`, і саме компонентом, а не атрибутом.
  assert.ok(/\{c\.help && <HelpDot text=\{c\.help\}/.test(s),
    "🔴 шапка більше не рендерить `help` — тексти є в реєстрі й не видні на екрані");
  const dot = s.split("function HelpDot")[1]?.slice(0, 2200) ?? "";
  assert.ok(dot.length > 0, "🔴 компонента HelpDot немає");
  // 🔴 ТРИ СПОСОБИ ВІДКРИТИ, бо в кожного своя аудиторія: миша, клавіатура, палець.
  for (const [needle, why] of [
    ["onMouseEnter", "наведення (десктоп)"],
    ["onFocus", "клавіатурний фокус — без нього підказка недоступна з Tab"],
    ["onClick", "тап (мобільний) — title на тачі не показується взагалі"],
    ["tabIndex={0}", "елемент не потрапляє у Tab-порядок"],
  ] as [string, string][])
    assert.ok(dot.includes(needle), `🔴 у HelpDot немає ${needle}: ${why}`);
  // Клік по заголовку сортує таблицю — підказка не має цього робити.
  assert.ok(/stopPropagation/.test(dot),
    "🔴 HelpDot не зупиняє клік — читання пояснення перевертало б сортування");
  // 🔴 ТОКЕНИ ПЕРЕВІРЯЄМО САМЕ В ПОП-АПІ, а не в усьому компоненті. Перша редакція
  // шукала їх будь-де в `HelpDot` — і лишалась зеленою, коли вікно захардкодили
  // на #ffffff, бо токени є на кнопці «?» поруч. Саботаж це й показав: гейт
  // «перевіряв» те, чого не стеріг.
  const pop = dot.split('role="tooltip"')[1]?.slice(0, 900) ?? "";
  assert.ok(pop.length > 0, "🔴 у HelpDot немає елемента з role=\"tooltip\"");
  for (const tok of ["var(--card-bg)", "var(--text)", "var(--border)"])
    assert.ok(pop.includes(tok),
      `🔴 поп-ап не бере ${tok} — у темній темі це світла пляма на темному тлі`);
  assert.ok(REPORT_COLS.some((c: any) => c.help?.includes("Джерело:")),
    "🔴 у реєстрі не лишилось жодного пояснення з джерелом — розбір зламався");
});

// ──────────────────────────── #82 · підсумки ────────────────────────────

test("#82 ЧАСТКИ В ПІДСУМКУ НЕ СКЛАДАЮТЬСЯ (сер.чек, викон.%, конв.)", async () => {
  const { footValue } = await loadCols();
  // Два менеджери з РІЗНОЮ вагою: наївна Σ і чесна частка дають різні числа, тож
  // тест здатний їх розрізнити (однакова вага зробила б його беззубим).
  const rows = [
    mgr({ managerId: 1, fact: 90000, plan: 100000, kpi: { ...mgr().kpi, avgCheck: { fact: 9000, target: 0, revenue: 90000, deals: 10 }, conversion: { fact: 50, target: 0, taken: 100, won: 50 } } }),
    mgr({ managerId: 2, fact: 1000, plan: 100000, kpi: { ...mgr().kpi, avgCheck: { fact: 1000, target: 0, revenue: 1000, deals: 1 }, conversion: { fact: 10, target: 0, taken: 10, won: 1 } } }),
  ];
  const ac = footValue("avgCheck", rows);
  assert.equal(ac.value, Math.round(91000 / 11),
    "🔴 сер.чек у підсумку рахується не як Σмаржі÷Σугод — «середнє середніх» уже коштувало нам 87 955 ₴");
  assert.notEqual(ac.value, 9000 + 1000, "🔴 сер.чек просто склали — це не величина, яку можна додавати");

  const pc = footValue("pct", rows);
  assert.equal(pc.value, Math.round((91000 / 200000) * 100),
    "🔴 виконання рахується не як Σфакт÷Σплан");
  assert.notEqual(pc.value, 90 + 1, "🔴 відсотки склали між собою");

  const cv = footValue("conv", rows);
  assert.equal(cv.value, Math.round((51 / 110) * 1000) / 10,
    "🔴 конверсія в підсумку рахується не як Σвиграних÷Σузятих — менеджер із 10 угодами "
    + "отримав таку саму вагу, як менеджер зі 100");
});

test("#82b ДЗЕРКАЛО: адитивні колонки таки сумуються", async () => {
  const { footValue } = await loadCols();
  // Без цієї пари #82 зеленів би й у світі, де підсумків немає взагалі.
  const rows = [mgr({ fact: 10000, created: 5, jam: 1000 }), mgr({ managerId: 2, fact: 25000, created: 7, jam: 500 })];
  assert.equal(footValue("fact", rows).value, 35000, "🔴 «Отримано» не сумується — підсумок мертвий");
  assert.equal(footValue("created", rows).value, 12, "🔴 «Створено» не сумується");
  assert.equal(footValue("jam", rows).value, 1500, "🔴 «Затор ₴» не сумується");
  // Частка від часток не є часткою, тож у «Ліди >1год» підсумку немає ЗА ПОБУДОВОЮ:
  // чесний підсумок вимагав би Σ повільних ÷ Σ лідів, а цих величин у рядку немає.
  assert.equal(footValue("responseTime", rows).value, null,
    "🔴 у частки повільних лідів зʼявився підсумок — складати частки не можна");
});

// ──────────────────────────── #83 · сортування ────────────────────────────

test("#83 NULL ЗАВЖДИ ВНИЗУ — В ОБИДВА БОКИ, і це не «нуль»", async () => {
  const { sortRows } = await loadCols();
  const rows = [
    mgr({ managerId: 1, kpi: { ...mgr().kpi, conversion: { fact: null, target: 0, taken: 3, won: 1 } } }),
    mgr({ managerId: 2, kpi: { ...mgr().kpi, conversion: { fact: 40, target: 0, taken: 50, won: 20 } } }),
    mgr({ managerId: 3, kpi: { ...mgr().kpi, conversion: { fact: 5, target: 0, taken: 50, won: 2 } } }),
  ];
  const desc = sortRows(rows, "conv", -1).map((m: any) => m.managerId);
  const asc = sortRows(rows, "conv", 1).map((m: any) => m.managerId);
  assert.equal(desc[desc.length - 1], 1,
    "🔴 менеджер без конверсії не внизу при спаданні");
  assert.equal(asc[asc.length - 1], 1,
    "🔴 при зростанні `null` виплив нагору — «даних немає» прочиталось як «найгірший результат». "
    + "Це рівно те зʼїжджання невідомого в конкретну відповідь, від якого береже правило про підписи");
  assert.deepEqual(asc.slice(0, 2), [3, 2], "🔴 звичайне зростання зламалось");
});

// ──────────────────────────── #84 · прогноз ────────────────────────────

test("#84 ПРОГНОЗ ІСНУЄ ЛИШЕ ДЛЯ ПОВНОГО ПОТОЧНОГО МІСЯЦЯ", async () => {
  const { REPORT_COLS } = await loadCols();
  const col = REPORT_COLS.find((c: any) => c.key === "projected");
  assert.equal(col.val(mgr({ monthInProgress: false, projected: 70000 })), null,
    "🔴 поза повним поточним місяцем `projected` дорівнює ФАКТУ — показати його як «прогноз» "
    + "означає підписати факт чужим словом");
  assert.equal(col.val(mgr({ monthInProgress: true, projected: 70000 })), 70000,
    "🔴 у поточному місяці прогноз зник — колонка стала завжди порожньою");
  const s = readFileSync(TABLE_TSX, "utf8");
  assert.ok(/m\.monthInProgress \? `\$\{money\(m\.projected\)\}/.test(s),
    "🔴 клітинка малює прогноз без перевірки monthInProgress");
});

// ──────────────────────────── #86 · статус ────────────────────────────

test("#86 СВІТЛОФОР — ВІД ТЕМПУ (m.status), А НЕ ВІД ВІДСОТКА", async () => {
  const { REPORT_COLS } = await loadCols();
  const col = REPORT_COLS.find((c: any) => c.key === "status");
  // 20% плану на початку місяця — це «в нормі» за темпом. Якби колонка читала pct,
  // такий рядок став би «зривом», і екран сперечався б сам із собою.
  const early = mgr({ pct: 20, status: "g" });
  const late = mgr({ pct: 95, status: "r" });
  assert.ok(col.val(early) > col.val(late),
    "🔴 порядок статусів більше не відповідає m.status — колонку перевели на відсоток");
  const s = readFileSync(TABLE_TSX, "utf8");
  assert.ok(/background: `var\(\$\{TOKEN\[m\.status\]\}\)`/.test(s),
    "🔴 крапка фарбується не за m.status");
  // Бейдж «Викон.%» мусить лишатись нейтральним — інакше два різні вердикти в рядку.
  const badge = s.split("function pctBadge")[1]?.slice(0, 420) ?? "";
  for (const tok of ["--ok", "--danger", "--warn"])
    assert.equal(badge.includes(tok), false,
      `🔴 бейдж «Викон.%» фарбується статусним токеном (${tok}) — поруч із крапкою від темпу `
      + "це два вердикти про одну людину в одному рядку");
});

// ──────────────────────────── #87 · дзвінки ────────────────────────────

test("#87 РОЗМОВИ Й СПРОБИ НЕ СКЛАДАЮТЬСЯ В ОДНЕ ЧИСЛО", async () => {
  const { footValue } = await loadCols();
  const rows = [mgr({ talks: 10, attempts: 4 }), mgr({ managerId: 2, talks: 6, attempts: 5 })];
  assert.equal(footValue("talks", rows).value, 16,
    "🔴 підсумок «Дзвінки» більше не Σ розмов");
  assert.notEqual(footValue("talks", rows).value, 25,
    "🔴 розмови склали зі спробами — це відповіді на різні питання (рішення власника 04.08.2026)");
  const s = readFileSync(TABLE_TSX, "utf8");
  assert.equal(/m\.talks \+ m\.attempts/.test(s), false,
    "🔴 у клітинці складено talks+attempts");
});

// ──────────────────────────── #88 · темна тема ────────────────────────────

test("#88 ТОКЕНИ СТАТУСІВ ВИЗНАЧЕНІ В ТЕМНІЙ ТЕМІ, а не лише їхні підкладки", () => {
  const css = readFileSync(CSS, "utf8");
  const dark = css.split(':root[data-theme="dark"]')[1]?.split("}")[0] ?? "";
  assert.ok(dark.length > 0, "🔴 dark-блоку в index.css немає — розбір зламався");
  for (const tok of ["--ok:", "--warn:", "--danger:"])
    assert.ok(dark.includes(tok),
      `🔴 ${tok} не перевизначено в темній темі. Таблиця малює світлофор саме цими токенами, `
      + "тож у темній темі він лишиться світлотемним і нечитабельним — тихо, без жодної помилки");
  // Дзеркало: підкладки нікуди не поділись (інакше «полагодили» б, знісши половину).
  for (const tok of ["--ok-bg:", "--danger-bg:"])
    assert.ok(dark.includes(tok), `🔴 ${tok} зник із темної теми`);
});
