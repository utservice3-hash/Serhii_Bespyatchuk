/**
 * 📅 ЯКА ГРАНУЛЯРНІСТЬ НАСПРАВДІ ПІДЕ В ЗАПИТ — і чому це окремий модуль.
 *
 * 🔴 КУПЛЕНО 08.09.2026 БІЛИМ ЕКРАНОМ НА ПРОДІ. Категорія «Реклама» — перша в
 * `CATS` без жодної метрики (`metrics: []`), бо вона малює власний блок, а не
 * графік. Через це `cat.metrics.find(...) ?? cat.metrics[0]` віддав `undefined`,
 * а наступний рядок читав `metric.monthOnly` БЕЗУМОВНО — до будь-якої JSX-умови.
 * Клік по вкладці клав увесь екран Статистик: `undefined is not an object`.
 *
 * ⚠️ ЧОМУ ЦЕ ПРОПУСТИЛИ ВСІ ВОРОТА. `tsc -b` мовчить за побудовою: без
 * `noUncheckedIndexedAccess` вираз `cat.metrics[0]` має тип `Metric`, а не
 * `Metric | undefined`. Бекендні гейти фронт не виконують, а той, що читає це
 * джерело (`#363b`), стереже ЗОВСІМ інше твердження — вхід вкладки «Ручні».
 * Тобто дефект жив саме в проміжку між «типи зійшлись» і «хтось клікнув».
 *
 * ✅ ТОМУ ПРАВИЛО ЖИВЕ ФУНКЦІЄЮ, А НЕ ТЕРНАРНИМ ВИРАЗОМ У КОМПОНЕНТІ: функцію
 * можна викликати з `undefined` у гейті (`#370`), а вираз усередині JSX — ні.
 */

export type Gran = "day" | "week" | "month";

/** Рівно ті поля метрики, від яких залежить гранулярність. */
export type GranMetric = { monthOnly?: boolean; weekOnly?: boolean };

/**
 * `metric` НАВМИСНО приймає `undefined`: категорія без метрик — законний стан
 * екрана, а не помилка. У цьому разі лишається те, що обрав користувач.
 */
export function effGranOf(metric: GranMetric | undefined, chosen: Gran): Gran {
  if (!metric) return chosen;
  if (metric.monthOnly) return "month";
  if (metric.weekOnly) return "week";
  return chosen;
}
