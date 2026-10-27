import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversions, conversionsCsv, kyivTime, GADS_DEAL_WON, GADS_SEND_FORM, GADS_LEADS_SQL, GADS_WINS_SQL,
} from "./googleAdsConversions.js";

const NOW = new Date("2026-10-27T10:00:00Z");
const D = (s: string) => new Date(s);

/**
 * #2480 — ОФЛАЙН-КОНВЕРСІЇ GOOGLE ADS: ПРАВИЛА ВІДБОРУ Й ФОРМАТ ШАБЛОНУ (27.10.2026).
 *
 * 🧨 Червоніє, якщо: у рядку заявки зʼявиться сума; продаж піде без маржі або з нульовою/мінусовою;
 * пройде продаж, закритий пізніше 90 днів від заявки (Google його однаково відхилить); угода без
 * gclid потрапить у файл; час піде не київський; формат розійдеться з шаблоном рекламниці.
 */
test("#2480 GOOGLE ADS: заявка без суми, продаж = маржа в межах 90 днів, формат шаблону", () => {
  const rows = buildConversions(
    [
      { kommoId: 1, gclid: "G1", createdAt: D("2026-10-24T09:00:00Z") },
      { kommoId: 2, gclid: "", createdAt: D("2026-10-24T09:00:00Z") },          // без gclid — геть
      { kommoId: 3, gclid: "G3", createdAt: D("2026-06-01T09:00:00Z") },        // старше 90 днів — геть
      { kommoId: 1, gclid: "G1", createdAt: D("2026-10-24T09:00:00Z") },        // дубль — один раз
    ],
    [
      { kommoId: 1, gclid: "G1", leadAt: D("2026-10-24T09:00:00Z"), wonAt: D("2026-10-26T12:30:00Z"), price: 5600 },
      { kommoId: 5, gclid: "G5", leadAt: D("2026-10-20T09:00:00Z"), wonAt: D("2026-10-25T09:00:00Z"), price: 0 },     // маржа 0 — геть
      { kommoId: 6, gclid: "G6", leadAt: D("2026-10-20T09:00:00Z"), wonAt: D("2026-10-25T09:00:00Z"), price: -900 },  // мінусова — геть
      { kommoId: 7, gclid: "G7", leadAt: D("2026-07-01T09:00:00Z"), wonAt: D("2026-10-26T09:00:00Z"), price: 1000 },  // 117 днів — геть
    ],
    NOW,
  );
  assert.deepEqual(rows.map((r) => [r.name, r.transactionId]), [[GADS_SEND_FORM, 1], [GADS_DEAL_WON, 1]],
    "🔴 відбір не той: мали лишитись заявка 1 і продаж 1");
  assert.equal(rows[0].value, null, "🔴 у рядку заявки зʼявилась сума — у мить заявки її не знати");
  assert.equal(rows[1].value, 5600, "🔴 сума продажу не маржа угоди");

  const csv = conversionsCsv(rows).split("\n");
  assert.equal(csv[0], "Parameters:TimeZone=Europe/Kiev", "🔴 немає рядка TimeZone — Google візьме час не того поясу");
  assert.equal(csv[1], "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Transaction ID");
  assert.equal(csv[2], "G1,CRM Send_form,2026-10-24 12:00:00,,UAH,1", "🔴 рядок заявки не за шаблоном або час не київський");
  assert.equal(csv[3], "G1,CRM Deal Won,2026-10-26 14:30:00,5600,UAH,1", "🔴 рядок продажу не за шаблоном");
  assert.equal(kyivTime(D("2026-07-15T21:30:00Z")), "2026-07-16 00:30:00", "🔴 літній час Києва (UTC+3) пораховано не так");
});

/**
 * #2480b — SQL ОФЛАЙН-КОНВЕРСІЙ: продаж — лише «Успішно» (142), час — із журналу етапів, gclid копії — від батька.
 * 🧨 Червоніє, якщо зникне умова 142, час продажу почне братись не з `deal_stage_events`, а дочірня угода
 * перестане успадковувати gclid через `lead_child_links`.
 */
test("#2480b GOOGLE ADS SQL: продаж = 142, час із журналу етапів, gclid копії — від батька", () => {
  assert.match(GADS_WINS_SQL, /d\.status_id = 142/, "🔴 у продажі потрапить не лише «Успішно»");
  assert.match(GADS_WINS_SQL, /deal_stage_events e[\s\S]*e\.status_id = 142/, "🔴 час продажу не з журналу етапів");
  assert.match(GADS_WINS_SQL, /lead_child_links l ON l\.child_id = d\.kommo_id/, "🔴 копія не бере gclid батька");
  assert.match(GADS_WINS_SQL, /COALESCE\(d\.gclid, p\.gclid\)/);
  assert.match(GADS_LEADS_SQL, /d\.gclid IS NOT NULL/, "🔴 у заявки потраплять угоди без gclid");
});
