import test from "node:test";
import assert from "node:assert/strict";
import { normalizePrivat } from "./privat.js";
import { needsBackendEnv } from "../testMode.js";

/**
 * Фікстура — РЕАЛЬНА пара з API Привату за 28.08.2026 (рахунок ЮТС), лише скорочена:
 * платіж ГУТА-ТРАНС і комісія за нього. Спільний `REF`, різні `ID` і `NUM_DOC`
 * (`NUM_DOC` комісії похідний від `REF` — так і в базі, заміряно 22.09.2026).
 */
const PAY = {
  ID: "JBKLQ8SOEM47D6128082026140600D", REF: "JBKLQ8SOEM47D6", NUM_DOC: "62636490",
  TECHNICAL_TRANSACTION_ID: "JBKLQ8SOEM47D6128082026140600D", TRANTYPE: "D" as const, CCY: "UAH",
  SUM: "41666.67", SUM_E: "41666.67", OSND: "оплата за транспортні послуги 62628123 згідно рахунку № 633",
  AUT_CNTR_NAM: 'ТОВ, ТЗОВ "ГУТА-ТРАНС"', AUT_CNTR_ACC: "UA393253650000002600801730434",
  DAT_KL: "28.08.2026", DAT_OD: "28.08.2026", TIM_P: "14:06",
};
const FEE = {
  ID: "JBKLQ8SOEM47D6Y28082026140600D", REF: "JBKLQ8SOEM47D6", NUM_DOC: "8SOEM47D6Y",
  TECHNICAL_TRANSACTION_ID: "JBKLQ8SOEM47D6Y28082026140600D", TRANTYPE: "D" as const, CCY: "UAH",
  SUM: "3", SUM_E: "3", OSND: "Комiсiя за виконання платежiв в нацiональнiй валютi",
  AUT_CNTR_NAM: "ЗА ДЕБЕТУВАННЯ РАХУНКУ(UAH)", AUT_CNTR_ACC: "UA693052990000026009035008866",
  DAT_KL: "28.08.2026", DAT_OD: "28.08.2026", TIM_P: "14:06",
};
/**
 * ТОЙ САМИЙ платіж, яким Приват віддав його ВДРУГЕ 13.09.2026 (форма за рядком 770174 бази):
 * числовий `ID`, `TECHNICAL_TRANSACTION_ID` із суфіксом `_online`, ті самі `REF` і `NUM_DOC`.
 */
const PAY_ONLINE = { ...PAY, ID: "5262285678", TECHNICAL_TRANSACTION_ID: "5262285678_online" };

/**
 * 🔗 #367 — платіж і його комісія ділять `REF`, і мусять лишитись ДВОМА рядками.
 * Якщо зробити ключ за `REF` — обидва дадуть один ключ, і upsert затре платіж комісією
 * (рівно те, що зʼїло 370 платежів за 30 днів). Червоніє на ключі з самого `REF`.
 */
test("#367 ПЛАТІЖ І КОМІСІЯ З ОДНИМ REF — два різні ключі, платіж не затирається", () => {
  const pay = normalizePrivat(PAY, "UAH");
  const fee = normalizePrivat(FEE, "UAH");
  assert.equal(pay.raw && (pay.raw as typeof PAY).REF, (fee.raw as typeof FEE).REF, "фікстура: REF спільний");
  assert.notEqual(pay.externalTxId, fee.externalTxId, "один ключ на двох = комісія затирає платіж");
  assert.equal(pay.externalTxId, "privat:JBKLQ8SOEM47D6#62636490");
  assert.equal(pay.amount, -41666.67);
  assert.equal(fee.amount, -3);
});

/**
 * 🔗 #659 — ОДИН платіж у ДВОХ формах видачі мусить дати ОДИН ключ.
 * Ключ за `ID` (редакція 08.09.2026) тут давав два: `ID` у другій формі інший, і 13–14.09
 * так задвоїлись 109 платежів на ≈3,8 млн ₴. Червоніє, якщо ключ повернути на `ID` або
 * додати в нього щось, чого нема в обох формах.
 */
test("#659 ТОЙ САМИЙ ПЛАТІЖ У ФОРМІ «_online» — той самий ключ, двійник не заводиться", () => {
  const a = normalizePrivat(PAY, "UAH");
  const b = normalizePrivat(PAY_ONLINE, "UAH");
  assert.notEqual((a.raw as typeof PAY).ID, (b.raw as typeof PAY).ID, "фікстура: ID справді різні");
  assert.equal(a.externalTxId, b.externalTxId, "дві форми одного платежу мусять сходитись в один рядок");
  assert.equal(a.amount, b.amount);
  // І дзеркало в тому ж місці: `_online`-форма КОМІСІЇ теж не має ставати платежем.
  const feeOnline = normalizePrivat({ ...FEE, ID: "5262285679", TECHNICAL_TRANSACTION_ID: "5262285679_online" }, "UAH");
  assert.notEqual(feeOnline.externalTxId, b.externalTxId, "комісія в `_online`-формі не збігається з платежем");
});

/**
 * 🪞 #659b — запис БЕЗ `NUM_DOC` не лишається без ключа й не клеїться з чужими.
 * Драбина: `ID` → `REF` → дата-сума-рахунок. Без дзеркала «бери REF#NUM_DOC» зеленів би й
 * тоді, коли для записів без `NUM_DOC` усі падали б у `privat:undefined#undefined`.
 * Фікстура по ОБИДВА боки межі: (1) є `ID` — ключ `ID`; (2) немає ні `ID`, ні `NUM_DOC` —
 * ключ `REF`, і два різні `REF` — два ключі.
 */
test("#659b 🪞 ДЗЕРКАЛО: без NUM_DOC драбина ID → REF жива, privat:undefined не буває", () => {
  const { NUM_DOC: _n, ...payNoDoc } = PAY;
  const withId = normalizePrivat(payNoDoc, "UAH");
  assert.equal(withId.externalTxId, "privat:JBKLQ8SOEM47D6128082026140600D", "без NUM_DOC — ключ за ID");
  const { ID: _a, ...payNoIdNoDoc } = payNoDoc;
  const { ID: _b, ...otherNoIdNoDoc } = { ...payNoDoc, REF: "ZZZZ0000OTHER1" };
  const a = normalizePrivat(payNoIdNoDoc, "UAH");
  const b = normalizePrivat(otherNoIdNoDoc, "UAH");
  assert.equal(a.externalTxId, "privat:JBKLQ8SOEM47D6", "без ID і NUM_DOC — ключ за REF");
  assert.equal(b.externalTxId, "privat:ZZZZ0000OTHER1");
  assert.notEqual(a.externalTxId, b.externalTxId);
  for (const k of [withId, a, b]) assert.ok(!k.externalTxId.includes("undefined"), "запасний шлях не дає privat:undefined");
});

/**
 * 🔗 #367c ЖИВИЙ — у базі не лишилось жодного рядка Привату з ключем за `REF` там, де є `ID`.
 * Стереже не код, а ДАНІ після `tools/rekeyPrivat.ts` (редакція ② ключа): гейти вище
 * зеленіють одразу після правки, а платежі повертаються на виписку лише після перезаведення.
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

/**
 * 🔗 #659c ЖИВИЙ — після `tools/dedupePrivat.ts` у базі (1) немає двох рядків Привату з
 * однією парою `(рахунок, REF, NUM_DOC)` і (2) ключ КОЖНОГО рядка дорівнює тому, що
 * `normalizePrivat` рахує з його ж `raw_json`. Друге — не копія формули в SQL (правило
 * «дві копії, написані в тесті, доводять лише одна одну»), а виклик ядра по кожному рядку.
 * Без (2) гейт не помітив би, що дублі згорнули, а ключі лишили старі — і синк завів би
 * двійників знову. Червоніє, якщо інструмент не запускали, пропустив рахунок або
 * переписав ключі не тією формулою.
 */
test("#659c ЖИВИЙ: двійників (рахунок, REF, NUM_DOC) — нуль, і ключ кожного рядка == normalizePrivat(raw_json)",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { rows: [g] } = await pool.query<{ dup_groups: number; total: number }>(`
    SELECT count(*) FILTER (WHERE n > 1)::int AS dup_groups, coalesce(sum(n), 0)::int AS total
      FROM (SELECT count(*) AS n
              FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
             WHERE a.bank = 'privat'
             GROUP BY t.account_id, t.raw_json->>'REF', t.raw_json->>'NUM_DOC') s`);
  assert.ok(g.total > 0, "простір порожній — перевірці нема що знаходити");
  assert.equal(g.dup_groups, 0, `груп із двійниками: ${g.dup_groups} — dedupePrivat не відпрацював`);
  const { rows } = await pool.query<{ id: number; external_tx_id: string; amount: string; currency: string; raw_json: Record<string, unknown> }>(`
    SELECT t.id, t.external_tx_id, t.amount, t.currency, t.raw_json
      FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
     WHERE a.bank = 'privat'`);
  const wrong = rows.filter((r) => normalizePrivat(r.raw_json as object, r.currency).externalTxId !== r.external_tx_id);
  assert.equal(wrong.length, 0,
    `ключ ≠ normalizePrivat(raw_json) у ${wrong.length} із ${rows.length} рядків, напр. id=${wrong[0]?.id} «${wrong[0]?.external_tx_id}»`);
});
