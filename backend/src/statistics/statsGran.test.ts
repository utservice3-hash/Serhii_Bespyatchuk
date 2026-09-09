import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 📅 #370–#370b — КАТЕГОРІЯ БЕЗ МЕТРИК НЕ КЛАДЕ ЕКРАН СТАТИСТИК.
 *
 * 🔴 БАГ, ЩО ЦЕ ПОРОДИВ (прод, 08.09.2026). Вкладка «Реклама» малює власний блок,
 * тож у неї `metrics: []`. Компонент брав `cat.metrics.find(...) ?? cat.metrics[0]`
 * — тобто `undefined` — і одразу читав `metric.monthOnly` поза будь-якою умовою.
 * Клік по вкладці валив ВЕСЬ розділ: `undefined is not an object (evaluating
 * 'l.monthOnly')`. Викотили зеленим: `tsc -b` тут сліпий за побудовою (без
 * `noUncheckedIndexedAccess` `cat.metrics[0]` має тип `Metric`), а жоден гейт
 * фронт не виконує.
 *
 * 🪞 ЧОМУ ДВА ГЕЙТИ, А НЕ ОДИН. `#370` доводить, що ФУНКЦІЯ витримує `undefined`.
 * Сама по собі вона нічого не варта, якщо компонент її не кличе — тоді правило
 * живе в модулі, а екран падає по-старому. Тому `#370b` звіряє ДЖЕРЕЛО: у тілі
 * компонента немає безумовного `metric.` без `?.`, а `effGranOf` справді
 * викликається. Без другої половини перша була б зеленою на зламаному екрані.
 */

const FE_GRAN = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/statsGran.ts", import.meta.url));
const FE_SECTION = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/StatisticsChartsSection.tsx", import.meta.url));
const FE_REPORT = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/ReportPlanSection.tsx", import.meta.url));
const FE_RULES = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/periodRules.ts", import.meta.url));

/**
 * Тіло гілки «Реклама» — від умови до ЗАКРИТТЯ її фрагмента.
 *
 * 🔴 МЕЖА БУЛА «ДО НАСТУПНОЇ ГІЛКИ», І ЦЕ КОШТУВАЛО ПРОДА (09.09.2026). Елемент,
 * приклеєний ВПРИТУЛ перед `{cat.manualForm &&`, потрапляв усередину зрізу — тобто
 * гейт рахував його «в гілці Реклама» і лишався зеленим. Саме так залишок саботажу
 * (`<QuickPeriods active={null} onSelect={() => {}} />`) пройшов повз обидві перевірки
 * й поїхав у прод: він малював мертвий ряд кнопок на КОЖНІЙ вкладці Статистик.
 * Тепер межа — `</>`, яким гілка закінчується: приклеєне ззовні лишається ззовні.
 */
function adsBranch(src: string): string {
  const a = src.indexOf('cat.custom === "ads" &&');
  const b = src.indexOf("</>", a);
  if (a < 0 || b < 0) throw new Error("не знайшов гілку «Реклама» у StatisticsChartsSection — перевірка стала б порожньою");
  return src.slice(a, b);
}

async function loadGran() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE_GRAN, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/** Той самий прийом, що `loadGran`: правило фронту виконується, а не читається очима. */
async function loadRules() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE_RULES, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

test("#370 КАТЕГОРІЯ БЕЗ МЕТРИК: effGranOf(undefined) віддає вибір користувача, а не падає", async () => {
  const { effGranOf } = await loadGran();

  // ① Власне випадок «Реклами»: метрики немає — лишається те, що обрали.
  assert.equal(effGranOf(undefined, "week"), "week");
  assert.equal(effGranOf(undefined, "day"), "day");
  assert.equal(effGranOf(undefined, "month"), "month");

  // ② 🪞 ДЗЕРКАЛО: з метрикою правило працює по обидва боки межі — інакше гейт
  //    зеленів би й на функції, що завжди повертає аргумент.
  assert.equal(effGranOf({ monthOnly: true }, "day"), "month");
  assert.equal(effGranOf({ weekOnly: true }, "day"), "week");
  assert.equal(effGranOf({}, "day"), "day");
});

test("#370b 🪞 КОМПОНЕНТ СПРАВДІ КЛИЧЕ ФУНКЦІЮ, і metric читається лише опційно", async () => {
  const src = readFileSync(FE_SECTION, "utf8");

  // ① Функція не лежить мертвим модулем — компонент її імпортує і викликає.
  assert.match(src, /import \{ effGranOf \}/, "🔴 компонент більше не імпортує effGranOf — правило лишилось у модулі, а екран знову рахує сам");
  assert.match(src, /effGranOf\(metric, gran\)/, "🔴 виклик effGranOf зник — гранулярність знову рахується інлайн, тобто без захисту від undefined");

  // ② Тіло компонента (до JSX) не має БЕЗУМОВНИХ звернень `metric.` — лише `metric?.`.
  //    Межа змістова, а не за довжиною: беремо все до відкриття розмітки (правило 9).
  const body = src.slice(src.indexOf("const metric:"), src.indexOf("return ("));
  const naked = body.split("\n").filter((l) => /(^|[^?.\w])metric\.[a-zA-Z]/.test(l));
  assert.deepEqual(naked, [],
    "🔴 у тілі компонента звертаються до `metric.` без `?.` — категорія без метрик (custom-вкладка) знову покладе розділ");
});

/**
 * 📅 #393 (+ дзеркало #395c) — ЕКРАН, ЩО ЖИВЕ ПЕРІОДОМ, МУСИТЬ ДАВАТИ ЙОГО ЗМІНИТИ —
 * ТИМ САМИМ КОНТРОЛОМ, ЩО Й СУСІДНІ ЕКРАНИ.
 *
 * ⚠️ `#393b` ЗНЯТО, А НЕ ПЕРЕЙМЕНОВАНО (правило 13). Він стверджував, що контейнер
 * передає в Статистики `datePreset`/сеттери — а цих пропсів більше НЕМАЄ: період став
 * власним станом вкладки. Твердження зникло разом зі своїм предметом, тож уточнювати
 * назву було б неправильно: реєстр звіряє ІМʼЯ, і «те саме імʼя про інше» — це тихо
 * підмінений гейт. Нове твердження живе під новим номером.
 *
 * 🔴 БАГ, ЩО ЦЕ ПОРОДИВ (прод, 09.09.2026). Вкладка «Реклама» — єдина в Статистиках,
 * що фільтрується періодом, і довезли її БЕЗ перемикача: `from`/`to` приходили зі
 * спільного `dateRange`, який ставлять на Звіті чи Огляді й який переживає
 * перезавантаження в `localStorage`. Заміряно на проді: 14.07–14.07, у смузі днів
 * рівно один день, і жодного способу це виправити, не пішовши в інший розділ.
 *
 * 🔴 І ДРУГИЙ БАГ, ДОРОЖЧИЙ ЗА ПЕРШИЙ: контрол двічі поставили НЕ ТОЙ. Спершу
 * `QuickPeriods` із власним підписом «ПЕРІОД», потім він же на спільних класах — тобто
 * той самий вибір періоду мав у продукті три різні вигляди. Тому гейт стереже не
 * «якийсь вибір періоду є», а «стоїть РІВНО той компонент, що й на Звіті».
 *
 * 🪞 ЧОМУ ДВА. `#393` — контрол на місці й підключений до стану. `#395c` — дзеркало з
 * двох половин: (а) Звіт малює ТОЙ САМИЙ компонент, тобто вигляд не може розійтись;
 * (б) поза гілкою «Реклама» навігатора немає — інакше він з\'явився б на восьми
 * вкладках, де період не змінює нічого, і читався б як зламаний.
 */

test("#393 ВКЛАДКА «РЕКЛАМА» МАЄ ВИБІР ПЕРІОДУ, і вибір справді застосовується", () => {
  const src = readFileSync(FE_SECTION, "utf8");
  const ads = adsBranch(src);

  assert.match(src, /import \{ PeriodNav \} from "\.\.\/PeriodNav"/,
    "🔴 компонент більше не імпортує PeriodNav — вкладка або лишилась без вибору періоду, або завела власний");

  assert.match(ads, /<PeriodNav\b/,
    "🔴 у гілці «Реклама» немає навігатора періоду — смуга днів знову показуватиме те, що приїхало ззовні");

  // Вибір мусить ЗАСТОСОВУВАТИСЬ: намальований контрол, що нічого не міняє, гірший
  // за його відсутність — його крутять і не розуміють, чому тиша.
  assert.match(ads, /onPatch=\{\(patch\) => setNav\(/,
    "🔴 onPatch більше не пише в стан — навігатор малюється, але період не змінює");
  assert.match(ads, /<AdsSection from=\{adsPeriod\.from\} to=\{adsPeriod\.to\}/,
    "🔴 AdsSection бере період не з навігатора — контрол і дані розійшлись");
});

test("#395c 🪞 ТОЙ САМИЙ КОНТРОЛ, ЩО НА ЗВІТІ, І ПОЗА ВКЛАДКОЮ ЙОГО НЕМА", () => {
  const src = readFileSync(FE_SECTION, "utf8");
  const rpt = readFileSync(FE_REPORT, "utf8");

  // ① Звіт малює ТОЙ САМИЙ компонент. Це і є гарантія «як у звіті»: не схожий
  //    вигляд, а один модуль. Скопійована розмітка розійшлась би на першій правці.
  assert.match(rpt, /<PeriodNav\b/,
    "🔴 Звіт більше не малює PeriodNav — з'явився другий навігатор, і два вигляди почнуть розходитись");
  assert.match(rpt, /from "\.\.\/PeriodNav"/,
    "🔴 Звіт відвʼязався від спільного навігатора");

  // ② 🪞 Поза гілкою «Реклама» навігатора немає: на вкладках із метриками період
  //    не змінює нічого, і контрол там читався б як зламаний.
  const all = (src.match(/<PeriodNav\b/g) ?? []).length;
  const inAds = (adsBranch(src).match(/<PeriodNav\b/g) ?? []).length;
  assert.equal(inAds, 1, "🔴 у гілці «Реклама» рівно одного навігатора немає — або зник, або їх два");
  assert.equal(all, inAds,
    "🔴 PeriodNav стоїть і поза вкладкою «Реклама» — на решті вкладок він нічого не змінює");

  // ③ І ЖОДНОГО чужого перемикача періодів: саме так у прод поїхав мертвий
  //    `<QuickPeriods active={null} onSelect={() => {}} />` — залишок саботажу.
  assert.doesNotMatch(src, /<QuickPeriods\b/,
    "🔴 у Статистиках зʼявився QuickPeriods — це другий контрол періоду поруч із PeriodNav");
});

/**
 * 📅 #395–#395b — ПРАВИЛО ПЕРІОДУ ОДНЕ НА ДВА ЕКРАНИ.
 *
 * 🔴 ЧОМУ ЦЕ ГЕЙТ, А НЕ ДОМОВЛЕНІСТЬ. «Тиждень рахується від фокус-дня, місяць від
 * якоря» — правило, а не деталь. Поки воно жило локальними константами Звіту, другий
 * екран мусив або тягнутись до них, або завести копію; копія збігалася б із копією,
 * а не з правилом — той самий клас, що чип «новий/постійний», який розходився з
 * лічильником на 12.6% угод.
 */

test("#395 ПЕРІОД РАХУЄТЬСЯ ОДНАКОВО В УСІХ ЧОТИРЬОХ РЕЖИМАХ", async () => {
  const { periodOf, periodLabelOf, navBy } = await loadRules();
  const st = { mode: "month", anchor: "2026-09-09", focusDay: "2026-09-09", rangeFrom: "2026-09-01", rangeTo: "2026-09-09" };

  assert.deepEqual(periodOf({ ...st, mode: "day" }), { from: "2026-09-09", to: "2026-09-09" });
  assert.deepEqual(periodOf({ ...st, mode: "month" }), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(periodOf({ ...st, mode: "range" }), { from: "2026-09-01", to: "2026-09-09" });
  /* Тиждень — від ФОКУС-ДНЯ, а не від якоря, і перевірити це можна ЛИШЕ там, де вони
     різні. У фікстурі вище `anchor === focusDay`, тож на ній підміна одного одним
     лишилась би непоміченою — рівно та беззуба фікстура, від якої стереже правило 11.
     Тут якір у тижні 07–13, а фокус — у наступному. */
  assert.deepEqual(periodOf({ ...st, mode: "week" }), { from: "2026-09-07", to: "2026-09-13" });
  assert.deepEqual(periodOf({ ...st, mode: "week", focusDay: "2026-09-16" }), { from: "2026-09-14", to: "2026-09-20" },
    "тиждень мусить іти за фокус-днем; якір (09.09) лишився в попередньому тижні");

  // 🪞 Межі, на яких така арифметика й ламається: неділя й останній день місяця.
  assert.deepEqual(periodOf({ ...st, mode: "week", focusDay: "2026-09-13" }), { from: "2026-09-07", to: "2026-09-13" },
    "неділя належить ТОМУ САМОМУ тижню, а не наступному");
  assert.deepEqual(periodOf({ ...st, mode: "month", anchor: "2026-02-15" }), { from: "2026-02-01", to: "2026-02-28" },
    "лютий не має 30 днів");

  // Крок ←/→ у «Періоді» — на ВЛАСНУ довжину діапазону, без дірки й перекриття.
  assert.deepEqual(navBy({ ...st, mode: "range" }, -1), { rangeFrom: "2026-08-23", rangeTo: "2026-08-31" });
  assert.equal(periodLabelOf({ ...st, mode: "month" }), "вер 2026");
});

test("#395b 🪞 ОБИДВА ЕКРАНИ БЕРУТЬ ПРАВИЛО З МОДУЛЯ, а не тримають свою копію", () => {
  const rpt = readFileSync(FE_REPORT, "utf8");
  const src = readFileSync(FE_SECTION, "utf8");

  for (const [name, file] of [["Звіт", rpt], ["Статистики", src]] as const) {
    assert.match(file, /from "\.\.\/periodRules"/,
      "🔴 " + name + " більше не бере період із periodRules — правило роздвоїлось");
    // Копія примітивів у файлі означає, що модуль обійшли «на місці».
    assert.doesNotMatch(file, /const mondayOf =/,
      "🔴 у " + name + " знову зʼявилась власна копія mondayOf — саме так дві копії починають збігатись одна з одною");
  }
  assert.match(rpt, /periodOf\(\{ mode, anchor, focusDay, rangeFrom, rangeTo \}\)/,
    "🔴 Звіт рахує обраний період не через periodOf — а це той вираз, що живить і тіло, і розгортку");
});
