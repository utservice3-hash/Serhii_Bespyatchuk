import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  buildConversions, conversionsCsv, kyivTime, e164, GADS_DEAL_WON, GADS_SEND_FORM, GADS_LEAD_VALUE,
  GADS_DEAL_STAGES, GADS_CHAIN_INFLIGHT, GADS_LEADS_SQL, GADS_WINS_SQL,
} from "./googleAdsConversions.js";

const NOW = new Date("2026-10-27T10:00:00Z");
const D = (s: string) => new Date(s);

/**
 * #2510 — ОФЛАЙН-КОНВЕРСІЇ GOOGLE ADS: ПРАВИЛА ВІДБОРУ Й ФОРМАТ (27.10.2026, рішення Юлі й Романа).
 *
 * 🧨 Червоніє, якщо: заявка піде не з фіксованою цінністю 1 900; продаж піде без маржі або з нульовою/
 * мінусовою; пройде продаж пізніше 90 днів від заявки; рядок без gclid І без телефону потрапить у файл;
 * заявка без gclid, але з телефоном (дзвінок з реклами) випаде; телефон піде не в E.164; час — не київський.
 */
test("#2510 GOOGLE ADS: заявка = 1 900, продаж = маржа «Авто працює» в межах 90 днів, телефон E.164", () => {
  const rows = buildConversions(
    [
      { kommoId: 1, gclid: "G1", phone: "380671112233", createdAt: D("2026-10-24T09:00:00Z") },
      { kommoId: 2, gclid: null, phone: null, createdAt: D("2026-10-24T09:00:00Z") },          // ні gclid, ні телефону — геть
      { kommoId: 3, gclid: "G3", phone: null, createdAt: D("2026-06-01T09:00:00Z") },          // старше 90 днів — геть
      { kommoId: 4, gclid: null, phone: "380501234567", createdAt: D("2026-10-25T09:00:00Z") }, // дзвінок з реклами — лишається
      { kommoId: 1, gclid: "G1", phone: "380671112233", createdAt: D("2026-10-24T09:00:00Z") }, // дубль — один раз
    ],
    [
      { kommoId: 1, gclid: "G1", phone: "380671112233", leadAt: D("2026-10-24T09:00:00Z"), wonAt: D("2026-10-26T12:30:00Z"), price: 5600 },
      { kommoId: 5, gclid: "G5", phone: null, leadAt: D("2026-10-20T09:00:00Z"), wonAt: D("2026-10-25T09:00:00Z"), price: 0 },     // маржа 0 — геть
      { kommoId: 6, gclid: "G6", phone: null, leadAt: D("2026-10-20T09:00:00Z"), wonAt: D("2026-10-25T09:00:00Z"), price: -900 },  // мінусова — геть
      { kommoId: 7, gclid: "G7", phone: null, leadAt: D("2026-07-01T09:00:00Z"), wonAt: D("2026-10-26T09:00:00Z"), price: 1000 },  // 117 днів — геть
    ],
    NOW,
  );
  assert.deepEqual(rows.map((r) => [r.name, r.transactionId]), [[GADS_SEND_FORM, 1], [GADS_SEND_FORM, 4], [GADS_DEAL_WON, 1]],
    "🔴 відбір не той: мали лишитись заявки 1 і 4 та продаж 1");
  assert.equal(GADS_LEAD_VALUE, 1900, "🔴 цінність заявки не 1 900 (рішення Юлі 27.10)");
  assert.equal(rows[0].value, 1900, "🔴 заявка пішла не з фіксованою цінністю");
  assert.equal(rows[2].value, 5600, "🔴 сума продажу не маржа угоди");
  assert.equal(e164("380671112233"), "+380671112233");
  assert.equal(e164(null), "");

  const csv = conversionsCsv(rows).split("\n");
  assert.equal(csv[0], "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Transaction ID,Phone Number,Ad User Data,Ad Personalization",
    "🔴 файл не починається із заголовка — Google прочитає перший рядок як назви стовпців (рекламниця 28.10)");
  assert.ok(!csv.some((l) => l.startsWith("Parameters:")), "🔴 повернувся рядок Parameters");
  assert.equal(csv[1], "G1,CRM Send_form,2026-10-24 12:00:00+03:00,1900,UAH,1,+380671112233,Granted,Granted", "🔴 рядок заявки не за форматом");
  assert.equal(csv[2], ",CRM Send_form,2026-10-25 11:00:00+02:00,1900,UAH,4,+380501234567,Granted,Granted",
    "🔴 дзвінок без gclid не за форматом або зсув не перейшов на зимовий час (+02:00 з 25.10)");
  assert.equal(csv[3], "G1,CRM Deal Won,2026-10-26 14:30:00+02:00,5600,UAH,1,+380671112233,Granted,Granted", "🔴 рядок продажу не за форматом");
  assert.equal(kyivTime(D("2026-07-15T21:30:00Z")), "2026-07-16 00:30:00+03:00", "🔴 літній час Києва (UTC+3) пораховано не так");
});

/**
 * #2510b — SQL ОФЛАЙН-КОНВЕРСІЙ: продаж = перший вхід у «Авто працює» і далі; копія бере дані батька.
 * 🧨 Червоніє, якщо зникне «Авто працює» (69716300) чи «Успішно» (142) з етапів, час почне братись не як
 * ПЕРШИЙ вхід із журналу етапів, копія перестане успадковувати gclid/телефон, а дзвінок з реклами без gclid
 * перестане проходити за телефоном.
 */
test("#2510b GOOGLE ADS SQL: «Авто працює» і далі, перший вхід із журналу, дані батька, дзвінок за телефоном", () => {
  assert.ok(GADS_DEAL_STAGES.includes(69716300), "🔴 «Авто працює» випало з етапів продажу");
  assert.ok(GADS_DEAL_STAGES.includes(142), "🔴 «Успішно» випало з етапів продажу");
  const money = readFileSync(path.join(import.meta.dirname, "money.js"), "utf8");
  const m = money.match(/CHAIN_INFLIGHT = \[([^\]]*)\]/);
  assert.ok(m, "🔴 не знайдено CHAIN_INFLIGHT у money.js");
  assert.deepEqual([...GADS_CHAIN_INFLIGHT], m![1].split(",").map((x) => Number(x.trim())).filter((x) => x),
    "🔴 копія етапів «Авто працює і далі» розійшлась із CHAIN_INFLIGHT ядра грошей");
  assert.match(GADS_WINS_SQL, /min\(e\.changed_at\)[\s\S]*deal_stage_events e/, "🔴 час продажу не перший вхід у ланцюг");
  assert.match(GADS_WINS_SQL, /lead_child_links l ON l\.child_id = d\.kommo_id/, "🔴 копія не бере даних батька");
  assert.match(GADS_WINS_SQL, /COALESCE\(d\.gclid, p\.gclid\)/);
  assert.match(GADS_WINS_SQL, /COALESCE\(ph_d\.phone, ph_p\.phone\)/, "🔴 копія не бере телефону батька");
  assert.match(GADS_LEADS_SQL, /d\.gclid IS NOT NULL OR \(lower\(coalesce\(d\.utm_source, ''\)\) LIKE 'google%' AND ph_d\.phone IS NOT NULL\)/,
    "🔴 дзвінок з реклами Google без gclid більше не проходить за телефоном");
  assert.match(GADS_LEADS_SQL, /contact_phones cp/, "🔴 телефон береться не з контактів угоди");
  assert.match(GADS_LEADS_SQL, /NOT EXISTS \(SELECT 1 FROM lead_child_links AS lc WHERE lc\.child_id = d\.kommo_id\)/,
    "🔴 копія угоди знову рахується окремою заявкою — одна людина дасть дві конверсії");
});
