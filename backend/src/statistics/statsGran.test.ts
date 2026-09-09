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
const FE_DASH = fileURLToPath(new URL("../../../frontend/src/pages/Dashboard.tsx", import.meta.url));

/** Тіло гілки «Реклама» — від умови до наступної гілки. Межа ЗМІСТОВА (правило 9). */
function adsBranch(src: string): string {
  const a = src.indexOf('cat.custom === "ads" &&');
  const b = src.indexOf("{cat.manualForm &&", a);
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
 * 📅 #393–#393b — ЕКРАН, ЩО ЖИВЕ ПЕРІОДОМ, МУСИТЬ ДАВАТИ ЙОГО ЗМІНИТИ.
 *
 * 🔴 БАГ, ЩО ЦЕ ПОРОДИВ (прод, 09.09.2026). Вкладка «Реклама» — єдина в Статистиках,
 * що фільтрується періодом: решта показують часовий ряд із власною гранулярністю й
 * повзунком по всій історії. Довезли її БЕЗ перемикача: `from`/`to` приходили з
 * спільного `dateRange`, а рендерять `QuickPeriods` лише Огляд, Звіт, Команди й
 * Ван-ту-ван. Значення ще й переживає перезавантаження через `localStorage`, тож
 * людина застрягала на періоді, поставленому колись на іншому екрані. Заміряно на
 * проді: 14.07–14.07, у смузі днів рівно один день, і жодного способу це виправити,
 * не пішовши в інший розділ. Читалось як «дані не завантажились».
 *
 * 🪞 ЧОМУ ДВА ГЕЙТИ. `#393` доводить, що перемикач Є і його вибір ЗАСТОСОВУЄТЬСЯ.
 * Цього замало: контейнер може не передати сеттери, і тоді компонент або не збереться,
 * або (якби вони були `?`) мовчки нічого не робив би — рівно та обіцянка, якої
 * інтерфейс не виконує. Тому `#393b` звіряє ПРОВОДКУ в `Dashboard.tsx` і другим боком
 * стверджує, що на вкладках із метриками перемикача НЕМА: без цієї половини гейт
 * зеленів би й на контролі, підвішеному над усім розділом, де він нічого не робить.
 */

test("#393 ВКЛАДКА «РЕКЛАМА» МАЄ ВИБІР ПЕРІОДУ, і вибір справді застосовується", () => {
  const src = readFileSync(FE_SECTION, "utf8");
  const ads = adsBranch(src);

  assert.match(src, /import \{ DateRangeFilter, QuickPeriods \}/,
    "🔴 компонент більше не імпортує перемикач періодів — вкладка знову залежить від того, що поставили на іншому екрані");

  assert.match(ads, /<QuickPeriods\b/,
    "🔴 у вкладці «Реклама» немає швидких періодів — смуга днів знову показуватиме те, що лишилось у localStorage");
  assert.match(ads, /<DateRangeFilter\b/,
    "🔴 зник вибір довільного діапазону — швидких пресетів мало: «з 1 по 12» ними не задати");

  // Головне: вибір мусить ЗАСТОСОВУВАТИСЬ. Намальований перемикач, що нічого не
  // змінює, гірший за його відсутність — його крутять і не розуміють, чому тиша.
  assert.match(ads, /onSelect=\{\(id, range\) => \{ setDatePreset\(id\); setDateRange\(range\)/,
    "🔴 onSelect більше не кличе setDateRange — перемикач малюється, але період не змінює");
  assert.match(ads, /onChange=\{\(r\) => \{ setDateRange\(r\); setDatePreset\(null\)/,
    "🔴 довільний діапазон не скидає пресет — підсвіченою лишиться кнопка періоду, який уже не діє");
});

test("#393b 🪞 ПРОВОДКА Є, А НА ВКЛАДКАХ ІЗ МЕТРИКАМИ ПЕРЕМИКАЧА НЕМА", () => {
  const dash = readFileSync(FE_DASH, "utf8");
  const src = readFileSync(FE_SECTION, "utf8");

  // ① Контейнер справді віддає сеттери — інакше перемикач нікуди не пише.
  const call = dash.slice(dash.indexOf("<StatisticsChartsSection"), dash.indexOf("{section === \"bank\""));
  assert.ok(call.length > 80, "не знайшов виклик StatisticsChartsSection — перевірка стала б порожньою");
  for (const prop of ["datePreset=", "setDatePreset=", "setDateRange="]) {
    assert.ok(call.includes(prop),
      "🔴 Dashboard не передає " + prop + " — вкладка «Реклама» знову лише ЧИТАЄ період");
  }

  // ② 🪞 Друга половина: перемикач живе ВСЕРЕДИНІ гілки «Реклама», а не над розділом.
  //    Решта вкладок періодом не керується, і контрол там означав би «крути — нічого
  //    не буде». Рахуємо входження: скільки їх у файлі, стільки ж має бути в гілці.
  const all = (src.match(/<QuickPeriods\b/g) ?? []).length;
  const inAds = (adsBranch(src).match(/<QuickPeriods\b/g) ?? []).length;
  assert.equal(all, inAds,
    "🔴 QuickPeriods стоїть поза вкладкою «Реклама» — на вкладках із метриками він нічого не змінює, "
    + "а мовчазний перемикач читається як зламаний екран");
  assert.ok(inAds > 0, "🔴 у гілці «Реклама» перемикача немає — перевірка вище зеленіла б на порожнечі");
});
