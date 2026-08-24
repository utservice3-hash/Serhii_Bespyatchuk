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
    created: 30, new: 10, rep: 20, srcAd: 1, srcLeadgen: 2, srcOther: 27, srcNoChannel: 0,
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
  // 🔴 БЕРЕМО ВЕСЬ КОМПОНЕНТ, А НЕ ПЕРШІ N СИМВОЛІВ. Перша редакція різала 2200
  // символів — і щойно `HelpDot` виріс (портал, пін), `onMouseEnter` виїхав за межу,
  // тож гейт червонів на цілком робочому коді. Межа за розміром файлу — це таймер
  // на хибну тривогу, а не перевірка.
  //
  // 🔴 МЕЖА — «наступна функція», а НЕ початок коментаря. Літерал з двох зірочок
  // усередині рядка маніфест приймає за відкриття блочного коментаря і зрізає все
  // до наступного закриття — разом із оголошеннями тестів, що йдуть нижче. Спіймано
  // дією: #91/#91b мовчки зникли з набору, хоча у файлі стояли.
  const dot = s.split("function HelpDot")[1]?.split("\nfunction ")[0] ?? "";
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

// ─────────────────── #92 · один менеджер → повна картка ───────────────────

test("#92 ПРИ ВИБОРІ ОДНОГО МЕНЕДЖЕРА РЕНДЕРИТЬСЯ ТА САМА КАРТКА, а не її копія", () => {
  const t = readFileSync(TABLE_TSX, "utf8");
  const r = readFileSync(REPORT_TSX, "utf8");
  assert.ok(/mgrFilter !== "" && renderCard && rows\[0\]/.test(t),
    "🔴 таблиця більше не показує повну картку при виборі одного менеджера");
  assert.ok(/renderCard=\{\(m\) => \(\s*<MgrStrip/.test(r),
    "🔴 контейнер не віддає `MgrStrip` — або картка зникла, або таблиця малює власну копію");
  /**
   * 🔴 ЦИКЛ МОДУЛІВ. `MgrStrip` живе в `ReportPlanSection`, який імпортує цю таблицю.
   * Прямий імпорт назад замкнув би цикл: у ESM він «якось працює», але ламається в
   * рантаймі, а не на збірці. Тому картка приходить рендерером.
   */
  assert.equal(/from "\.\/ReportPlanSection"/.test(t), false,
    "🔴 таблиця імпортує з ReportPlanSection — це цикл модулів, який упаде в браузері, а не на tsc");
  // Картка розгорнута: вибір одного менеджера і Є запитом «покажи все про нього».
  const call = r.split("renderCard={(m) => (")[1]?.slice(0, 700) ?? "";
  assert.ok(/\bopen\b/.test(call), "🔴 картка обраного менеджера не розгорнута");
});

test("#92b КАРТКА Й РЯДОК — ОДИН І ТОЙ САМИЙ ОБʼЄКТ МЕНЕДЖЕРА", () => {
  const t = readFileSync(TABLE_TSX, "utf8");
  // `rows[0]` — уже відфільтрований і відсортований рядок таблиці; передаємо саме
  // його, тож числа картки не можуть розійтися з числами рядка над нею.
  assert.ok(/renderCard\(rows\[0\]\)/.test(t),
    "🔴 у картку йде не той самий обʼєкт, що в рядку таблиці — два джерела для одних чисел");
  const r = readFileSync(REPORT_TSX, "utf8");
  const call = r.split("renderCard={(m) => (")[1]?.slice(0, 700) ?? "";
  assert.ok(/m=\{m\}/.test(call), "🔴 `MgrStrip` отримує не переданий рядок");
  assert.ok(/mWeek=\{weekByMgr\.get\(m\.managerId\)\}/.test(call),
    "🔴 тижневий зріз картки береться не з того самого `weekByMgr`, що в картковому вигляді");
});

// ─────────────────── #96 · «прийнято» ≠ «зі створених» ───────────────────

test("#96 КАНАЛЬНІ КОЛОНКИ НАЗВАНІ «ПРИЙНЯТО» І ПОПЕРЕДЖАЮТЬ, що це не частина «Створено»", async () => {
  const { REPORT_COLS } = await loadCols();
  const ads = REPORT_COLS.find((c: any) => c.key === "ads");
  const lg = REPORT_COLS.find((c: any) => c.key === "leadgen");
  /**
   * 🔴 ЗАМІРЯНО НА ПРОДІ (тиждень 10–16.08, увесь відділ): «Прийнято реклами» = 248,
   * а створених із каналом `ad` = 228 — різні множини, різниця 8.8%. Поки колонка
   * звалась просто «Реклама» і стояла поруч зі «Створено», рівність «15 = 13+0+2»
   * читалась як розклад, хоч була збігом.
   */
  assert.ok(/^Прийнято /.test(ads.title), `🔴 колонка реклами знову зветься «${ads.title}» — читається як частина «Створено»`);
  assert.ok(/^Прийнято /.test(lg.title), `🔴 колонка лідогену знову зветься «${lg.title}»`);
  for (const c of [ads, lg])
    assert.ok(/не підмножина|ОКРЕМА метрика/i.test(c.help),
      `🔴 у «${c.title}» зникло застереження, що це не частина колонки «Створено»`);
});

/**
 * 🔴 ПЕРЕПИСАНО 24.08.2026 (Е1 моделі каналів): сімʼя стала ПАРТИЦІЄЮ.
 *
 * Гейт вимагав, щоб кожна колонка розкладу звалась «накладкою» і щоб їхня сума
 * була ≤ «Створено». Тоді це була правда: віддавались дві гілки `dealSourceCase`
 * з чотирьох, тож 43.2% створених угод не мали імені на екрані взагалі. Е1 додав
 * решту дві, і сімʼя тепер покриває набір — вимога «назви це накладкою» стала
 * вимогою применшити те, що колонки насправді роблять.
 *
 * 🔴 ЩО ЛИШИЛОСЬ НЕДОТОРКАНИМ, бо саме воно й було уроком інциденту: розклад
 * створених ≠ «Прийнято реклами/лідоген» (заміряно 248 проти 228 за тиждень).
 * Ця межа стереже далі й посилена — тепер обидві сімʼї названі в `help` явно.
 * Числа `srcAd`/`srcLeadgen` не зрушили ні на одиницю: перевіряємо це прямо.
 *
 * 🧨 САБОТАЖ: прибрати `srcOther` з реєстру → партиція неповна, червоніє;
 * зробити будь-яку з колонок `core` або ввімкненою за замовчуванням → червоніє.
 */
test("#96b РОЗКЛАД СТВОРЕНИХ — ПАРТИЦІЯ джерела, і підписаний саме так", async () => {
  const { REPORT_COLS, DEFAULT_OPT_ON } = await loadCols();
  const KEYS = ["srcAd", "srcLeadgen", "srcOther", "srcNoChannel"];
  const cols = KEYS.map((k) => REPORT_COLS.find((c: any) => c.key === k));
  for (const [i, c] of cols.entries()) {
    assert.ok(c, `🔴 у реєстрі немає колонки розкладу «${KEYS[i]}» — партиція неповна, `
      + "а неповна партиція читається як повна: людина складе три числа й недоотримає четверте");
    assert.equal(c.core, false, `🔴 «${c.title}» стала обовʼязковою — власник просив опційну`);
    assert.equal(DEFAULT_OPT_ON[c.key], false, `🔴 «${c.title}» увімкнена за замовчуванням`);
    assert.ok(/партиці/i.test(c.help), `🔴 «${c.title}» не підписана як частина партиції джерела`);
    assert.ok(/Прийнято|ОКРЕМА метрика|канал не заповнен/i.test(c.help),
      `🔴 «${c.title}» більше не розводить себе з «Прийнято реклами/лідоген» — саме на цьому `
      + "збігу «15 = 13+0+2» колись прочиталось як розклад");
  }
  // ПАРТИЦІЯ: Σ чотирьох == створених (на живих даних це тримає #174).
  const { sortRows } = await loadCols();
  const rows = [mgr({ created: 30, srcAd: 12, srcLeadgen: 5, srcOther: 13, srcNoChannel: 0 })];
  const vals = KEYS.map((k) => REPORT_COLS.find((c: any) => c.key === k).val(rows[0]));
  assert.deepEqual(vals, [12, 5, 13, 0], "🔴 колонки читають не ті поля рядка");
  assert.equal(vals.reduce((a: number, b: number) => a + b, 0), rows[0].created,
    "🔴 Σ розкладу ≠ «Створено» — сімʼя перестала бути партицією");
  assert.ok(sortRows(rows, "srcAd", -1).length === 1, "🔴 сортування по колонці розкладу зламане");
});

// ─────────────────── #95 / #97 · підписи не брешуть про період ───────────────────

test("#95 ПІДСУМОК УГОРІ ПІДПИСАНИЙ ОБРАНИМ ПЕРІОДОМ, а не завжди «за місяць»", () => {
  const s = readFileSync(REPORT_TSX, "utf8");
  const g = s.split("function Glance(")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(g.length > 0, "🔴 компонента Glance немає — розбір зламався");
  // 🔴 `Glance` отримує periodData (числа ЗА ПЕРІОД), тож зашитий «за місяць» над
  // тижневою сумою — це підпис, що суперечить величині. Уже ловили тричі.
  assert.ok(/Команда · \{periodLabel\}/.test(g),
    "🔴 заголовок підсумку знову не залежить від обраного періоду");
  assert.ok(/авто · \{periodLabel\}/.test(g),
    "🔴 підпис «авто» знову прибитий до місяця");
  assert.ok(/periodLabel: string/.test(g),
    "🔴 Glance більше не приймає підпис періоду — він не може бути правдивим сам по собі");
  // Проза не рахується: коментарі зрізаємо, інакше гейт червонітиме на власному поясненні.
  const code = g.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(/за місяць/.test(code.replace(/цей міс/g, "")), false,
    "🔴 у Glance лишився зашитий підпис «за місяць»");
});

test("#95b ДЗЕРКАЛО: форвардна плитка лишається календарно-місячною", () => {
  const s = readFileSync(REPORT_TSX, "utf8");
  const g = s.split("function Glance(")[1]?.split("\nfunction ")[0] ?? "";
  // 🔴 Без цієї пари #95 зеленів би й тоді, коли «полагодили» все підряд: плитка
  // «ОЧІКУЄМО … цей міс» справді про КАЛЕНДАРНИЙ місяць (планова дата оплати) і від
  // обраного періоду не залежить. Перевести її на periodLabel = збрехати навпаки.
  assert.ok(/цей міс/.test(g),
    "🔴 з форвардної плитки зник підпис «цей міс» — очікування за плановою датою "
    + "прочитаються як число обраного періоду, хоч воно календарно-місячне");
  assert.ok(/expectThisMonth/.test(g), "🔴 форвардна плитка більше не читає expectThisMonth");
});

test("#97 ЗВУЖЕННЯ ДО МЕНЕДЖЕРА ПІДПИСАНЕ, бо підсумок угорі не звужується", () => {
  const s = readFileSync(TABLE_TSX, "utf8");
  const block = s.split('{mgrFilter !== "" && (')[1]?.slice(0, 700) ?? "";
  assert.ok(block.length > 0,
    "🔴 немає підпису для випадку «обрано менеджера» — верхній підсумок лишається по відділу "
    + "і мовчки читається як підсумок обраного");
  assert.ok(/по всьому відділу/.test(block), "🔴 підпис не називає, що саме показує верхній підсумок");
  // 🔴 Другий обчислювач glance на фронті заводити ЗАБОРОНЕНО: це і є те роздвоєння
  // джерела, від якого береже #81. Рішення власника — підпис, а не перерахунок.
  const code = s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(/glance\s*[:=]/.test(code), false,
    "🔴 у таблиці зʼявився власний розрахунок glance — верхній підсумок став другим джерелом");
});

// ─────────────────── #91 · обсяг і надійність підказки ───────────────────

test("#91 СЕЛЕКТОР «ОБСЯГ» НАЗИВАЄ РОЗМІР, а не лише назву", () => {
  const s = readFileSync(TABLE_TSX, "utf8");
  /**
   * 🔄 ПЕРЕПИСАНО 21.08.2026 РАЗОМ ІЗ МУЛЬТИВИБОРОМ, і саме цей гейт його спіймав.
   * `<select>` замінено на попап із галочками (нативний мультиселект вимагає
   * Ctrl+клік і мовчки скидає попередній вибір). Твердження лишились ТІ САМІ —
   * лічильники, «нуля не домальовуємо», згруповані секції, відмінювання; змінилось
   * лише те, ДЕ вони живуть. Послаблень немає: кожен рядок нижче має саботаж.
   */
  const call = s.split("<ScopePicker")[1]?.split("/>")[0] ?? "";
  assert.ok(call.length > 0, "🔴 контрол «Обсяг» зник — розбір зламався");
  const pick = s.split("function ScopePicker(")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(pick.length > 0, "🔴 компонента ScopePicker немає");

  // «Весь відділ» мусить казати, скільки людей у цьому зрізі: без числа опція не
  // відрізняється від будь-якої іншої, і людина не бачить, що саме обирає.
  assert.ok(/Весь відділ · \$\{data\.managers\.length\}/.test(call),
    "🔴 «Весь відділ» без лічильника менеджерів");
  // Команда — так само; `byTeam` рахується з уже завантаженого набору, без запиту.
  assert.ok(/byTeam\.get\(t\.id\)/.test(pick) && /\{n\}/.test(pick),
    "🔴 у команд зник лічильник — опції знову лише назви");
  // 🔴 І САМЕ ТАК, А НЕ «· 0»: коли завантажено зріз однієї команди, склад решти
  // невідомий, тож число там не пишеться взагалі. Нуль читався б як «команда порожня».
  assert.ok(/n != null \?/.test(pick),
    "🔴 команді без даних домальовується число — це твердження, якого ми не робили");
  // Секції: без них список із 30+ рядків зливається в суцільну стрічку.
  for (const g of ["Команди — можна кілька", "Один менеджер"])
    assert.ok(pick.includes(g), `🔴 немає секції «${g}» у списку`);
  assert.ok(/const mgrWord = /.test(s), "🔴 зникло відмінювання — буде «1 менеджерів»");

  /**
   * 🔴 НОВЕ ТВЕРДЖЕННЯ, ЯКОГО РАНІШЕ НЕ БУЛО Й НЕ МОГЛО БУТИ: три режими взаємно
   * СКИДАЮТЬСЯ. Без цього галочка команди й вибраний менеджер лишились би обидва
   * активними, екран показав би їх перетин, а порожній результат читався б як
   * «немає даних» замість «фільтри бʼються».
   */
  // 🔴 РІВНО В ТІЛІ `toggleTeam`, а не «десь у компоненті». Перша редакція шукала
  // патерн будь-де — і лишалась зеленою, коли я прибрав скидання з `toggleTeam`:
  // той самий виклик стоїть у рядку «Весь відділ» і задовольняв умову. Саботаж
  // показав це одразу — третій випадок «гейт стеріг слово, а не поведінку» за прохід.
  const toggle = pick.split("const toggleTeam =")[1]?.split("};")[0] ?? "";
  assert.ok(toggle.length > 0, "🔴 у ScopePicker немає `toggleTeam`");
  assert.ok(/onMgrFilter\(""\)/.test(toggle),
    "🔴 галочка команди не скидає обраного менеджера — екран покаже перетин двох фільтрів");
  assert.ok(/onTeamIds\(\[\]\);\s*onMgrFilter\(m\.managerId\)/.test(pick),
    "🔴 вибір менеджера не скидає обраних команд");
});

test("#91b ПІДКАЗКА НЕ ОБРІЗАЄТЬСЯ КОНТЕЙНЕРОМ І НЕ ЗНИКАЄ, ПОКИ ЧИТАЮТЬ", () => {
  const s = readFileSync(TABLE_TSX, "utf8");
  const dot = s.split("function HelpDot")[1]?.split("\nfunction ")[0] ?? "";
  assert.ok(dot.length > 0, "🔴 компонента HelpDot немає");

  /**
   * 🔴 ПОРТАЛ — НЕ ПРИКРАСА. Таблиця лежить у контейнері з `overflow-x:auto`, а це
   * за специфікацією робить не-visible і ВЕРТИКАЛЬНУ вісь: вікно, намальоване
   * усередині, обрізається — найдужче на крайніх правих колонках, куди ще й треба
   * доскролити. Тому воно виноситься в `document.body` з `position:fixed`.
   */
  assert.ok(/createPortal\(/.test(dot) && /document\.body/.test(dot),
    "🔴 поп-ап знову малюється всередині таблиці — контейнер зі скролом його обріже");
  const pop = dot.split('role="tooltip"')[1]?.slice(0, 900) ?? "";
  assert.ok(pop.length > 0, "🔴 у HelpDot немає елемента з role=\"tooltip\"");
  assert.ok(/position: "fixed"/.test(pop),
    "🔴 вікно не `position:fixed` — у порталі воно поїде від свого заголовка");
  assert.equal(/position: "absolute"/.test(pop), false,
    "🔴 вікно повернулось на `absolute` — тобто знову прив'язане до обрізаного контейнера");
  // Координати беруться від кнопки і перераховуються, інакше підказка «відклеїться».
  assert.ok(/getBoundingClientRect\(\)/.test(dot), "🔴 позиція не міряється від кнопки");
  assert.ok(/addEventListener\("scroll"/.test(dot), "🔴 позиція не перераховується на скролі");

  // Пін: клік лишає вікно відкритим, наведення — ні.
  assert.ok(/const \[pinned, setPinned\]/.test(dot), "🔴 стану «пришпилено» немає");
  assert.ok(/if \(!pinned\) setOpen\(false\)/.test(dot),
    "🔴 `hide` закриває вікно навіть пришпилене — воно зникатиме, поки людина читає");
  assert.ok(/setPinned\(true\)/.test(dot), "🔴 клік більше не пришпилює");
  for (const [needle, why] of [
    ['e.key === "Escape"', "Escape не закриває — пришпилене вікно нічим прибрати"],
    ['addEventListener("mousedown"', "клік поза вікном не закриває"],
  ] as [string, string][])
    assert.ok(dot.includes(needle), `🔴 ${why}`);
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
