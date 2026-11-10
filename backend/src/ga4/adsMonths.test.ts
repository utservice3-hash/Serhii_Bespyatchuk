import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAdDays, mergeAdMonths } from "./report.js";
import { adCampaignTagSql, LEAD_PARENT_JOIN, NOT_A_CAMPAIGN } from "../core/adCampaign.js";

/**
 * #3315 — ОКУПНІСТЬ ПО МІСЯЦЯХ І «ЗАРОБИЛИ ЛІДИ ДНЯ» (задача #8702, зустріч 09.11.2026).
 * 🧨 Червоніє, якщо: «дозріло» перестане бути «узято − у роботі»; місяць, де є лише гроші (ліди давно), зникне;
 * «надійшло» місяця рахуватиметься не сумою днів; день, де є лише «заробили ліди», випаде з таблиці днів.
 */
test("#3315 ОКУПНІСТЬ ПО МІСЯЦЯХ: дозріло = узято − у роботі, місяць лише з грошима живий, день лише з «заробили» живий", () => {
  const months = mergeAdMonths(
    new Map([["2026-09", 136953.44], ["2026-10", 120477.1]]),
    [{ day: "2026-09-03", entered: 10, inWork: 1 }, { day: "2026-09-20", entered: 5, inWork: 0 }, { day: "2026-10-02", entered: 8, inWork: 6 }],
    new Map([["2026-09", { revenue: 41000, deals: 9 }], ["2026-08", { revenue: 5000, deals: 1 }]]),
    [{ day: "2026-10-05", revenue: 1500 }, { day: "2026-10-31", revenue: 3500 }],
  );
  assert.deepEqual(months.map((m) => m.month), ["2026-08", "2026-09", "2026-10"], "🔴 місяць, де лише гроші, зник");
  const sep = months[1];
  assert.deepEqual([sep.leads, sep.settled, sep.earned, sep.earnedDeals, sep.cost], [15, 14, 41000, 9, 136953.44],
    "🔴 вересень: ліди/дозріло/заробили не ті");
  assert.equal(months[2].settled, 2, "🔴 «дозріло» — не «узято − у роботі»");
  assert.equal(months[2].received, 5000, "🔴 «надійшло в місяці» — не сума днів");

  const days = mergeAdDays([], new Map(), new Map(), new Map(), new Map([["2026-10-14", { revenue: 16900, deals: 3 }]]));
  assert.deepEqual(days.map((d) => [d.day, d.earned, d.earnedDeals]), [["2026-10-14", 16900, 3]],
    "🔴 день, де є лише «заробили ліди», випав або гроші не дійшли");
});

/**
 * #3315b — МІТКА КАМПАНІЇ ЛІДА. 🧨 Червоніє, якщо «(organic)/(direct)/(not set)» стануть кампаніями, мітка дитини
 * переб'є батьківську, або батька почнуть приєднувати звичайним JOIN (дитина з двома батьками подвоїть гроші).
 */
test("#3315b МІТКА КАМПАНІЇ: не-кампанії → NULL, спершу батько, батько — LATERAL LIMIT 1", () => {
  const tag = adCampaignTagSql("d");
  for (const v of NOT_A_CAMPAIGN) assert.ok(tag.includes(`'${v}'`), `🔴 ${v} рахується кампанією`);
  assert.ok(tag.indexOf("par.utm_campaign") < tag.indexOf("d.utm_campaign"), "🔴 мітка копії перебиває мітку батька");
  assert.match(LEAD_PARENT_JOIN("d"), /LEFT JOIN LATERAL[\s\S]*LIMIT 1\) par ON true/, "🔴 батько приєднується без LIMIT 1 — гроші подвояться");
});
