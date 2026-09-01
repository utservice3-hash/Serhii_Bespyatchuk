import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

/**
 * Гейти писаря `finance.receivables` (01.09.2026).
 *
 * Три РІЗНІ твердження, і це навмисно — інакше другий і третій були б переказом
 * першого:
 *   #24v — число дорівнює тому, що дає ЯДРО (а не власна копія SQL);
 *   #24w — закриті періоди не чіпаються (тому їхнє число незмінне);
 *   #24y — джоба справді кличе писаря, і саме з ПОТОЧНИМИ анкерами.
 *
 * 🔴 ЧОМУ #24w ДОВОДИТЬСЯ ПОБУДОВОЮ, А НЕ ДВОМА ПРОГОНАМИ. Буквальна перевірка
 * «прогнати писаря двічі й подивитись на серпень» вимагала б ЗАПИСУ в бойову
 * `statistics_values`, а проти прода набір ходить лише read-only. Тому гейт
 * стверджує сильніше й дешевше: закритий бакет не зʼявляється у виводі ВЗАГАЛІ,
 * отже його число не може змінитись жодним прогоном.
 */

const M = "2026-09-01", W = "2026-08-31"; // анкери-приклади; значення беруться з ядра

/**
 * 🪤 САБОТУВАТИ ТУТ ТРЕБА ПИСАРЯ, А НЕ ЯДРО — інакше зелене збреше.
 *
 * Обидві сторони рівності нижче приходять із `receivablesTotal`: ліва через
 * `computeFinanceSnapshot`, права напряму. Саботаж САМОГО ядра зсуває їх
 * ОДНАКОВО (синфазно), рівність цього не бачить, і гейт лишається зеленим —
 * заміряно 01.09.2026: `SUM(r.amount) * 2` у `receivablesTotal` дав pass 3/3.
 *
 * 🔴 Це НЕ означає «гейт беззубий» — це означає «саботаж не в те місце»
 * (правило 6 у CLAUDE.md). Плутати ці два висновки не можна: перший веде
 * переписувати робочий гейт.
 *
 * Правильний саботаж — замінити в `computeFinanceSnapshot` виклик ядра на
 * ВЛАСНИЙ SQL, що губить частину означення (напр. `source='cash'`). Заміряно:
 * гейт червоніє з «писар дав 9 617 738.94, ядро — 9 665 155.94» — рівно та
 * розбіжність, заради якої він існує.
 */
test("#24v ЧИСЛО З ЯДРА, а не власна копія SQL", needsDb(), async () => {
  const { computeFinanceSnapshot } = await import("./computeAuto.js");
  const metrics = await import("../core/metrics.js");

  const core = await metrics.receivablesTotal({});
  const got = await computeFinanceSnapshot(M, W);

  // ⚠️ Спершу доводимо, що ПРЕДМЕТ існує. Нуль тут зробив би збіг порожнім:
  // «своя копія» теж повернула б 0, і гейт зеленів би, нічого не перевіривши.
  assert.ok(core > 0,
    `🔴 ядро віддало ${core} — дебіторки в базі немає, і збіг ні про що не свідчить`);

  assert.equal(got.size, 2, `🔴 очікував рівно 2 записи (місяць+тиждень), отримав ${got.size}`);
  for (const [pt, ps] of [["month", M], ["week", W]] as const) {
    const key = `finance|${pt}|${ps}|receivables`;
    assert.ok(got.has(key), `🔴 немає запису «${key}» — писар пише не туди`);
    assert.equal(got.get(key), core,
      `🔴 ${pt}: писар дав ${got.get(key)}, ядро — ${core}. Розбіжність означає, що `
      + "число рахується ВЛАСНИМ SQL; така копія зійдеться з копією, а не з правилом, "
      + "і розійдеться з екраном «Дебіторка» через місяці");
  }
});

test("#24w ЗАКРИТІ ПЕРІОДИ НЕ ЧІПАЮТЬСЯ — тому їхнє число незмінне", needsDb(), async () => {
  const { computeFinanceSnapshot } = await import("./computeAuto.js");
  const got = await computeFinanceSnapshot(M, W);

  const starts = [...got.keys()].map((k) => k.split("|")[2]);
  assert.ok(starts.length > 0, "🔴 писар не віддав жодного запису — перевіряти нема чого");

  // 🔴 Головне: у виводі НЕМАЄ жодного бакета, крім переданих анкерів. Писар із
  // вікном «останні 40 днів» (як у сусідніх відділових метрик) вписав би
  // СЬОГОДНІШНІЙ борг у минулі місяці й мовчки переписав історію — а історії
  // боргу в базі немає взагалі, тож відновити затерте не було б з чого.
  const allowed = new Set([M, W]);
  const strays = starts.filter((ps) => !allowed.has(ps));
  assert.deepEqual(strays, [],
    `🔴 писар зачепив бакети поза поточними анкерами: ${strays.join(", ")}. `
    + "Це і є мовчазне переписування закритих періодів");

  // Дзеркало: обидва анкери справді присутні — інакше «немає зайвих» було б
  // істинним і для порожнього виводу.
  for (const ps of allowed)
    assert.ok(starts.includes(ps), `🔴 анкер ${ps} у виводі відсутній — вивід порожніший, ніж має бути`);

  // Ключі стабільні між викликами: повторний прогін адресує ТІ САМІ рядки, тож
  // жоден інший період фізично не може бути перезаписаний.
  const again = await computeFinanceSnapshot(M, W);
  assert.deepEqual([...again.keys()].sort(), [...got.keys()].sort(),
    "🔴 два прогони адресують РІЗНІ рядки — тоді «закритий місяць незмінний» не гарантовано");
});

test("#24y ДЖОБА КЛИЧЕ ПИСАРЯ — і саме з поточними анкерами", async () => {
  const fs = await import("node:fs/promises");
  const url = await import("node:url");
  const src = await fs.readFile(
    url.fileURLToPath(new URL("../../src/jobs/recomputeStatistics.ts", import.meta.url)), "utf8");

  // 🔴 Межа зрізу СЕМАНТИЧНА, не «N символів»: від відділових auto-метрик до
  // їхнього ж INSERT-у. Зріз по довжині вже одного разу зробив гейт беззубим —
  // саботаж просто не потрапляв у вікно.
  const from = src.indexOf("const dept = await computeDeptAuto(");
  assert.ok(from > 0, "🔴 не знайдено початок відділового блоку — гейт втратив предмет");
  const to = src.indexOf("const dRows = [...dept.entries()];", from);
  assert.ok(to > from, "🔴 не знайдено кінець блоку — зріз розповзся");
  const block = src.slice(from, to);

  assert.match(block, /computeFinanceSnapshot\(\s*curMonth\s*,\s*curWeek\s*\)/,
    "🔴 джоба не кличе computeFinanceSnapshot(curMonth, curWeek) — або писар не доїхав, "
    + "або йому передають ІНШІ анкери, і тоді сьогоднішній борг ляже в чужий місяць");
  assert.match(block, /dept\.set\(/,
    "🔴 результат писаря не потрапляє в мапу відділових метрик — а саме її INSERT "
    + "пише team_lead = NULL і source = 'auto'");

  // Анкери мусять походити з ОДНОГО запиту `now()`, а не з другого «сьогодні».
  const anchors = src.indexOf("const curMonth = anchors.rows[0].m, curWeek = anchors.rows[0].w;");
  assert.ok(anchors > 0 && anchors < from,
    "🔴 curMonth/curWeek більше не беруться з єдиного запиту now() ДО цього блоку — "
    + "у проході завелось два різні «сьогодні»");
});
