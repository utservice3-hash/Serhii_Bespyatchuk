import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyInvoice, foldFacts, type RawInvoiceRow } from "./receivablesFacts.js";
import { counterpartyBreakdown, reconcileBreakdown, COUNTERPARTY_UNKNOWN } from "./receivablesCounterparty.js";

/**
 * 🏢 #252–#252c — РОЗКЛАД «ЮРОСОБА → СУМА» У ЗГОРНУТОМУ РЯДКУ.
 *
 * 📐 Заміряно 01.09.2026 на живому проді за скаргою власника «коли обʼєднуємо
 * клієнтів, в загальному списку не зрозуміло стає по якій компанії борг»:
 *   рядків у списку 63 · злитих канонічних у списку 3 · із них із >1 юрособою 2
 *   смартекс      — СМАР ТЕКС 2 325 150 · КУР'ЄР УКРАЇНИ 92 850 · ТЕКСГРУП 42 000
 *   автострадавк  — АВТОСТРАДА ВК 1 465 700 · ГРУПА КОМПАНІЙ АВТОСТРАДА 176 400
 *
 * 🔴 ФІКСТУРИ ТУТ ВЛАСНІ, А НЕ ЖИВІ ДАНІ. Гейт, привʼязаний до сьогоднішнього
 * складу бази, червонітиме від злиття, оплати чи списання — тобто від чужої
 * роботи, а не від регресу. Живі числа лишаються в доккоментарі як походження
 * правила; перевіряється ВЛАСТИВІСТЬ, істинна і при двох таких клієнтах, і при
 * нулі (пастка `#220`/`#221`).
 */

const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const FE_SPEC = (p: string) => srcOf(`../../../frontend/src/${p}`);

const inv = (p: Partial<RawInvoiceRow>): RawInvoiceRow => ({
  clientKey: "канон", clientName: "КАНОН ТОВ", amount: 100, invoiceDate: "2026-08-01",
  invoiceNo: "1", edrpou: null, dealId: null, dealFound: false, paymentType: null,
  statusId: null, pipelineId: null, stageMapped: false, writtenOff: false,
  carrierPayAmount: null, carrierPayType: null, earned: null, clientPay: null,
  carrierObligation: null, ageDays: 5, counterpartyKey: "канон", ...p,
});

/** Клієнт, склеєний із трьох юросіб — форма «смартекса», числа власні. */
const merged = () => foldFacts([
  inv({ invoiceNo: "1", amount: 600, counterpartyKey: "канон", clientName: "КАНОН ТОВ" }),
  inv({ invoiceNo: "2", amount: 300, counterpartyKey: "псевдо-а", clientName: "ПСЕВДО-А ТОВ" }),
  inv({ invoiceNo: "3", amount: 100, counterpartyKey: "псевдо-б", clientName: "ПСЕВДО-Б ТОВ" }),
].map((r) => classifyInvoice(r))).byClient.get("канон")!;

/** Звичайний незлитий клієнт — усі рахунки під одним ключем. */
const plain = () => foldFacts([
  inv({ invoiceNo: "1", amount: 600 }),
  inv({ invoiceNo: "2", amount: 400 }),
].map((r) => classifyInvoice(r))).byClient.get("канон")!;

test("#252 розклад по юрособах є, коли їх БІЛЬШЕ ОДНІЄЇ — з назвою, сумою і порядком", () => {
  const parts = counterpartyBreakdown(merged());

  assert.equal(parts.length, 3, "🔴 три юрособи в рахунках дали не три позиції розкладу");
  assert.deepEqual(parts.map((p) => p.key), ["канон", "псевдо-а", "псевдо-б"],
    "🔴 порядок не за спаданням суми — рядок стрибатиме від перезавантаження");
  assert.deepEqual(parts.map((p) => p.amount), [600, 300, 100]);
  assert.deepEqual(parts.map((p) => p.name), ["КАНОН ТОВ", "ПСЕВДО-А ТОВ", "ПСЕВДО-Б ТОВ"],
    "🔴 назва юрособи загубилась — «ключ 300 ₴» людині нічого не каже");

  const r = reconcileBreakdown(1000, parts);
  assert.equal(r.show, true, "🔴 розклад НЕ показується там, де юросіб кілька — заявку не закрито");

  // ⚖️ Повний порядок: рівні суми не мають права мінятись місцями.
  const tie = counterpartyBreakdown(foldFacts([
    inv({ invoiceNo: "1", amount: 500, counterpartyKey: "бета", clientName: "БЕТА" }),
    inv({ invoiceNo: "2", amount: 500, counterpartyKey: "альфа", clientName: "АЛЬФА" }),
  ].map((x) => classifyInvoice(x))).byClient.get("канон")!);
  assert.deepEqual(tie.map((p) => p.key), ["альфа", "бета"],
    "🔴 нічия за сумою розвʼязана випадково — порядок рядка не відтворюваний");

  // 🏷 Рахунок без юрособи має ВЛАСНИЙ підпис, а не тихо зливається з іншими.
  const unknown = counterpartyBreakdown(foldFacts([
    inv({ invoiceNo: "1", amount: 10, counterpartyKey: null, clientName: null }),
    inv({ invoiceNo: "2", amount: 20, counterpartyKey: "канон" }),
  ].map((x) => classifyInvoice(x))).byClient.get("канон")!);
  assert.equal(unknown.length, 2, "🔴 рахунок без юрособи злився з іншою — це вигадана атрибуція");
  assert.equal(COUNTERPARTY_UNKNOWN, "юрособу не вказано");
});

test("#252b 🪞 ДЗЕРКАЛО: у звичайного клієнта розкладу НЕМАЄ", () => {
  // Односторонній гейт тут коштує дорого: «розклад завжди» проходить #252 і
  // засмічує 61 рядок із 63 підписом «сам про себе».
  const one = counterpartyBreakdown(plain());
  assert.equal(one.length, 1, "🔴 один ключ юрособи дав не одну позицію");
  assert.equal(reconcileBreakdown(1000, one).show, false,
    "🔴 розклад показується там, де юрособа ОДНА — це шпалери, а не сигнал");

  assert.equal(reconcileBreakdown(0, []).show, false,
    "🔴 клієнт без рахунків отримав розклад — показувати нема чого");
});

test("#252c Σ розкладу звіряється з сумою рядка, а нерознесений залишок НАЗВАНО ЧИСЛОМ", async () => {
  const parts = counterpartyBreakdown(merged());

  // ① Сходиться — залишку немає.
  const ok = reconcileBreakdown(1000, parts);
  assert.equal(ok.ok, true, "🔴 рівні суми оголошено розбіжністю");
  assert.equal(ok.remainder, 0);

  // ② НЕ сходиться — і це не гіпотеза: сума рядка приходить із `receivables`,
  // розклад — із `receivable_invoices`. Заміряно 01.09.2026: із 63 рядків
  // розходяться 11, від 3 ₴ до 60 000 ₴.
  const bad = reconcileBreakdown(1250, parts);
  assert.equal(bad.ok, false, "🔴 розбіжність 250 ₴ оголошено збігом");
  assert.equal(bad.remainder, 250, "🔴 залишок порахований неправильно");

  // ③ Залишок мусить ДОЇХАТИ ДО ЕКРАНА числом, а не лишитись у полі відповіді.
  const { breakdownLine } = await import(FE_SPEC("pages/dashboard/receivablesView.ts"));
  const shown = breakdownLine(bad);
  assert.ok(shown, "🔴 розклад не подається на екран узагалі");
  assert.ok(/250/.test(String(shown.remainderLabel)),
    `🔴 залишок не названий числом: ${JSON.stringify(shown.remainderLabel)} — доданки під сумою, якій вони не дорівнюють, і є «гарна неправда»`);
  assert.equal(breakdownLine(ok)!.remainderLabel, null,
    "🔴 підпис залишку висить там, де розклад сходиться");

  // ④ 🪞 І дзеркало до ③: коли показувати не треба, не показується нічого.
  assert.equal(breakdownLine(reconcileBreakdown(1000, counterpartyBreakdown(plain()))), null,
    "🔴 звичайний клієнт отримав рядок розкладу");

  // ⑤ Відʼємний залишок — теж залишок. Нуль falsy, і «немає» з «нуль» плутати
  // не можна: рахунків може бути БІЛЬШЕ, ніж каже фід 1С.
  const neg = reconcileBreakdown(900, parts);
  assert.equal(neg.ok, false);
  assert.ok(/100/.test(String(breakdownLine(neg)!.remainderLabel)),
    "🔴 відʼємний залишок мовчки проковтнуто");
});

test("#252d розклад НЕ рахує списані рахунки — інакше він розійшовся б із сумою рядка", () => {
  // Списане не входить у `amount` клієнта; якби воно входило в розклад,
  // Σ доданків стала б більшою за суму, під якою вони стоять.
  const c = foldFacts([
    inv({ invoiceNo: "1", amount: 600, counterpartyKey: "канон" }),
    inv({ invoiceNo: "2", amount: 300, counterpartyKey: "псевдо-а", clientName: "ПСЕВДО-А ТОВ" }),
    inv({ invoiceNo: "3", amount: 999, counterpartyKey: "псевдо-б", clientName: "ПСЕВДО-Б ТОВ", writtenOff: true }),
  ].map((r) => classifyInvoice(r))).byClient.get("канон")!;

  const parts = counterpartyBreakdown(c);
  assert.equal(parts.reduce((a, p) => a + p.amount, 0), c.amount,
    "🔴 Σ розкладу ≠ `amount` клієнта — списане потрапило в один бік і не потрапило в інший");
  assert.equal(parts.some((p) => p.key === "псевдо-б"), false,
    "🔴 повністю списана юрособа лишилась у розкладі як живий борг");

  // 🪞 І дзеркало: ЧАСТКОВО списаний клієнт лишається в розкладі — але лише
  // живою частиною. Без цієї половини «відсіювати все підряд» було б зеленим.
  const partial = counterpartyBreakdown(foldFacts([
    inv({ invoiceNo: "1", amount: 600, counterpartyKey: "канон" }),
    inv({ invoiceNo: "2", amount: 300, counterpartyKey: "псевдо-а", clientName: "ПСЕВДО-А ТОВ" }),
    inv({ invoiceNo: "3", amount: 50, counterpartyKey: "псевдо-а", clientName: "ПСЕВДО-А ТОВ", writtenOff: true }),
  ].map((r) => classifyInvoice(r))).byClient.get("канон")!);
  assert.equal(partial.find((p) => p.key === "псевдо-а")?.amount, 300,
    "🔴 частково списана юрособа або зникла цілком, або принесла списану суму");
});
