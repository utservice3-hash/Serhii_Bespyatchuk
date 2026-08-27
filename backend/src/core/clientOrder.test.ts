import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAID_DEAL_JOIN, PAID_DEAL_WHERE, lastOrderCte, daysSinceOrderSql } from "./clientOrder.js";
import { inReactivationTab } from "./reactivationRules.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "core");
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

/**
 * 🛒 #233–#233b — «ЗАМОВИВ» ЖИВЕ В ОДНОМУ МІСЦІ.
 *
 * ⚠️ МЕЖА СВІДОМА, І ВОНА ВУЖЧА ЗА ПЕРШЕ ФОРМУЛЮВАННЯ ПЛАНУ. `funnel_stage='paid'`
 * трапляється **67 разів у 13 файлах**, зокрема 9 разів у грошовому ядрі — це слово
 * СЛОВНИКА, а не дубльоване правило. Гейт стереже КЛІЄНТСЬКИЙ агрегат («коли
 * востаннє», «скільки разів»), бо саме там жила пастка з `MAX` і `NULL`, і саме він
 * відповідає на питання екрана.
 */
test("#233 КЛІЄНТСЬКИЙ АГРЕГАТ не заводиться повторно поза ядром", () => {
  for (const f of ["clientArchive.ts", "reactivation.ts"]) {
    const src = read(f);
    /**
     * ⚠️ Заборона — на КЛІЄНТСЬКИЙ агрегат (`GROUP BY client_key`). `reactivation`
     * має ЩЕ ОДИН `MAX(closed_at_kommo)` — у `per_cm`, згрупованому по КЛІЄНТУ Й
     * МЕНЕДЖЕРУ. Це інше питання («хто основний менеджер»), і зливати його з
     * «коли востаннє замовляв» було б помилкою протилежного боку: одна назва на дві
     * різні величини. Тому шукаємо `AS last_paid`/`AS last_order_at`, а не голий MAX.
     */
    assert.ok(!/MAX\([^)]*closed_at_kommo[^)]*\)\s+AS last_(paid|order_at)/.test(src),
      `🔴 ${f} знову рахує «коли востаннє» власним MAX(d.closed_at_kommo) — це третя копія, `
      + "а копії згоджуються одна з одною, а не з правдою (0 із 639 розбіжностей були саме таким збігом)");
    assert.ok(/lastOrderCte|PAID_DEAL_JOIN|PAID_DEAL_WHERE|daysSinceOrderSql/.test(src),
      `🔴 ${f} більше не кличе ядро — означення роз'їхалось`);
  }
  // Дзеркало: ядро справді віддає обидві величини ОКРЕМО, а не одну замість другої.
  const cte = lastOrderCte();
  assert.match(cte, /COUNT\(\*\)::int\s+AS orders/, "🔴 «скільки разів» зникло");
  assert.match(cte, /COUNT\(d\.closed_at_kommo\)::int\s+AS orders_dated/, "🔴 «із них із датою» зникло");
  assert.match(cte, /MAX\(d\.closed_at_kommo\)\s+AS last_order_at/, "🔴 «коли востаннє» зникло");
});

test("#233b ДВА ПИТАННЯ РОЗДІЛЕНІ: недатована оплата рахується, але дати не вигадує", () => {
  // 🔴 325 недатованих оплачених угод у 98 клієнтів (замір 27.08.2026, і за день
  // він зрушив із 324/97 — число живе). Нульова
  // розбіжність між копіями була НЕ доказом узгодженості, а наслідком того, що `MAX`
  // ігнорує NULL однаково в обох.
  const cte = lastOrderCte();
  assert.notEqual(/COUNT\(\*\)/.exec(cte)?.index, /COUNT\(d\.closed_at_kommo\)/.exec(cte)?.index,
    "🔴 «скільки разів» і «скільки з датою» — той самий вираз, тобто одне тихо означує друге");
  assert.match(PAID_DEAL_WHERE, /funnel_stage = 'paid'/);
  assert.match(PAID_DEAL_JOIN, /pipeline_stage_map/);
  // Днів без замовлення: NULL не має ставати «сьогодні» — він має ставати нулем ЯВНО.
  assert.match(daysSinceOrderSql("x"), /COALESCE\(/,
    "🔴 без COALESCE відсутня дата дала б NULL, і споживач прочитав би його як завгодно");
  assert.match(daysSinceOrderSql("x"), /Europe\/Kyiv/, "🔴 зона зникла — дати поїдуть на добу");
});

// ─────────────── #233c–#233d · ВИКЛЮЧНІСТЬ ВКЛАДОК ───────────────
type Facts = Parameters<typeof inReactivationTab>[0];
/**
 * ⚠️ ФІКСТУРА ВУЖЧА ЗА `ClientSegmentRow` НАВМИСНО. `inReactivationTab` читає РІВНО
 * чотири поля; подавати їй `payments`/`daysSince` означало б удавати, що вона їх
 * бачить, — і тест виглядав би як перевірка правила про недатовані оплати, не будучи
 * нею. Кваліфікація рахується ВИЩЕ (`qualifiesAsRepeat`), і перевіряється там.
 */
const F = (o: Partial<Facts>): Facts => ({
  qualified: true, phoneKey: false, paymentType: "Безнал з ПДВ", state: "sleeping", ...o,
});

test("#233c ВИКЛЮЧНІСТЬ: активний клієнт у вкладку реактивації НЕ потрапляє", () => {
  // 🔴 До 27.08.2026 фільтра стану тут не було ВЗАГАЛІ: 134 клієнти, які замовляють
  // прямо зараз, висіли у вкладці — 21% її складу. «Вихід» не був зламаний, його не
  // існувало.
  assert.equal(inReactivationTab(F({ state: "active" })), false,
    "🔴 клієнт, який щойно замовив, лишається у вкладці «Реактивація» — виходу знову немає");
  assert.equal(inReactivationTab(F({ state: "sleeping" })), true, "🔴 сплячий випав із реактивації");
  assert.equal(inReactivationTab(F({ state: "lost" })), true, "🔴 втрачений випав із реактивації");
});

test("#233d ДЗЕРКАЛО: вкладка не спорожніла — виключність не стала фільтром «нікого»", () => {
  // Без цієї пари «нікого немає в обох вкладках» зеленіло б і на ПОРОЖНЬОМУ екрані:
  // достатньо було б відсіяти всіх. Тому окремо стверджуємо, що інші межі цілі.
  assert.equal(inReactivationTab(F({ qualified: false })), false, "🔴 разовий пройшов у реактивацію");
  assert.equal(inReactivationTab(F({ phoneKey: true, paymentType: "" })), false,
    "🔴 телефонний дженерик пройшов — межа 05.08.2026 зникла");
  assert.equal(inReactivationTab(F({ phoneKey: true, paymentType: "Безнал без ПДВ" })), true,
    "🔴 безготівковий із ключем-телефоном ВИКИНУТО — це вже пересушений список");
  /**
   * 🔴 ЧОГО ЦЕЙ ГЕЙТ НЕ ПЕРЕВІРЯЄ, І ЦЕ СКАЗАНО ВГОЛОС. Правило «недатована оплата
   * рахується для кваліфікації» (рішення власника 27.08.2026) живе в
   * `qualifiesAsRepeat`, який бере `payments`. Сюди приходить уже готовий `qualified`,
   * тож звідси його не видно. Твердження «142 не зрушили» — це ЗАМІР на живих даних у
   * прийманні, а не юніт: тут воно було б декорацією.
   */
  assert.equal(inReactivationTab(F({ qualified: true, state: "lost" })), true,
    "🔴 кваліфікований втрачений випав із реактивації");
});
