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
