import test from "node:test";
import assert from "node:assert/strict";
import { normalizePrivat } from "./privat.js";
import { needsBackendEnv } from "../testMode.js";

/**
 * Фікстура — РЕАЛЬНА пара з API Привату за 28.08.2026 (рахунок ЮТС), лише скорочена:
 * платіж ГУТА-ТРАНС і комісія за нього. Спільний `REF`, різні `ID`.
 */
const PAY = {
  ID: "JBKLQ8SOEM47D6128082026140600D", REF: "JBKLQ8SOEM47D6", TRANTYPE: "D" as const, CCY: "UAH",
  SUM: "41666.67", SUM_E: "41666.67", OSND: "оплата за транспортні послуги 62628123 згідно рахунку № 633",
  AUT_CNTR_NAM: 'ТОВ, ТЗОВ "ГУТА-ТРАНС"', AUT_CNTR_ACC: "UA393253650000002600801730434",
  DAT_KL: "28.08.2026", DAT_OD: "28.08.2026", TIM_P: "14:06",
};
const FEE = {
  ID: "JBKLQ8SOEM47D6Y28082026140600D", REF: "JBKLQ8SOEM47D6", TRANTYPE: "D" as const, CCY: "UAH",
  SUM: "3", SUM_E: "3", OSND: "Комiсiя за виконання платежiв в нацiональнiй валютi",
  AUT_CNTR_NAM: "ЗА ДЕБЕТУВАННЯ РАХУНКУ(UAH)", AUT_CNTR_ACC: "UA693052990000026009035008866",
  DAT_KL: "28.08.2026", DAT_OD: "28.08.2026", TIM_P: "14:06",
};

/**
 * 🔗 #367 — платіж і його комісія ділять `REF`, і мусять лишитись ДВОМА рядками.
 * Якщо зробити ключ за `REF` — обидва дадуть один ключ, і upsert затре платіж комісією
 * (рівно те, що зʼїло 370 платежів за 30 днів). Червоніє на `it.REF ?? it.ID`.
 */
test("#367 ПЛАТІЖ І КОМІСІЯ З ОДНИМ REF — два різні ключі, платіж не затирається", () => {
  const pay = normalizePrivat(PAY, "UAH");
  const fee = normalizePrivat(FEE, "UAH");
  assert.equal(pay.raw && (pay.raw as typeof PAY).REF, (fee.raw as typeof FEE).REF, "фікстура: REF спільний");
  assert.notEqual(pay.externalTxId, fee.externalTxId, "один ключ на двох = комісія затирає платіж");
  assert.equal(pay.externalTxId, "privat:JBKLQ8SOEM47D6128082026140600D");
  assert.equal(pay.amount, -41666.67);
  assert.equal(fee.amount, -3);
});

/**
 * 🪞 #367b — дзеркало: запис БЕЗ `ID` не лишається без ключа. Запасний шлях — `REF`.
 * Без дзеркала фікс «просто бери ID» зеленів би й тоді, коли запасний шлях зламано і
 * записи без `ID` падали б у `privat:undefined` — один ключ на всіх. Червоніє, якщо
 * прибрати `?? it.REF`.
 */
test("#367b 🪞 ДЗЕРКАЛО: без ID ключ береться з REF, і два різних REF — два ключі", () => {
  // Другий запис навмисно ТОЙ САМИЙ платіж (сума, дата, рахунок) з іншим REF: тоді
  // третій, найгрубший запасний ключ (дата-сума-рахунок) у них збігається, і різнить їх
  // РІВНО `REF`. Прибрати `?? it.REF` — ключі стануть однакові, і гейт червоніє по суті.
  const { ID: _a, ...payNoId } = PAY;
  const { ID: _b, ...otherNoId } = { ...PAY, REF: "ZZZZ0000OTHER1" };
  const a = normalizePrivat(payNoId, "UAH");
  const b = normalizePrivat(otherNoId, "UAH");
  assert.equal(a.externalTxId, "privat:JBKLQ8SOEM47D6");
  assert.equal(b.externalTxId, "privat:ZZZZ0000OTHER1");
  assert.notEqual(a.externalTxId, b.externalTxId);
  assert.ok(!a.externalTxId.includes("undefined"), "запасний шлях не дає privat:undefined");
});

/**
 * 🔗 #367c ЖИВИЙ — у базі не лишилось жодного рядка Привату з ключем за `REF` там, де є `ID`.
 * Стереже не код, а ДАНІ після `tools/rekeyPrivat.ts`: гейти вище зеленіють одразу після
 * правки, а платежі повертаються на виписку лише після перезаведення. Без цього гейта
 * «викотили» читалось би як «полагодили», хоча 370 платежів лишались би затертими.
 * Червоніє, якщо інструмент не запускали або він пропустив рахунок.
 */
test("#367c ЖИВИЙ: рядків Привату з ключем за REF при наявному ID — нуль",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { rows: [r] } = await pool.query<{ ref_keyed: number; total: number }>(`
    SELECT count(*) FILTER (WHERE t.external_tx_id = 'privat:' || (t.raw_json->>'REF')
                              AND t.raw_json->>'ID' IS NOT NULL
                              AND t.raw_json->>'ID' <> t.raw_json->>'REF')::int AS ref_keyed,
           count(*)::int AS total
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
     WHERE a.bank = 'privat'`);
  assert.ok(r.total > 0, "простір порожній — перевірці нема що знаходити");
  assert.equal(r.ref_keyed, 0, `рядків із ключем за REF: ${r.ref_keyed} із ${r.total} — rekeyPrivat не відпрацював`);
});
