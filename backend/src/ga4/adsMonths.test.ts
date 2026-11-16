import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAdDays, mergeAdMonths } from "./report.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { adCampaignTagSql, dealCampaignSql, GENERIC_CLIENT_KEYS_SQL, LEAD_PARENT_JOIN, NOT_A_CAMPAIGN } from "../core/adCampaign.js";
import { adClientGroupOf, foldAdClients } from "../core/adClientsFold.js";

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

/**
 * #3316b — ЗГОРТКА КЛІЄНТІВ З РЕКЛАМИ (#8709): постійний — `qualified` ядра, тип — `segment` ядра; маржа й лічильники
 * не губляться між кампаніями й плитками. 🧨 Червоніє, якщо постійних почнуть рахувати своїм правилом (не `qualified`),
 * «ще без типу» потрапить у ВІП/регулярні/епізодичні, або Σ кампаній розійдеться з плиткою.
 */
test("#3316b КЛІЄНТИ З РЕКЛАМИ: постійний = qualified ядра, типи — segment ядра, Σ кампаній == плитці", () => {
  const c = (key: string, campaign: string | null, qualified: boolean, segment: "vip" | "regular" | "episodic" | "unknown", margin: number) =>
    ({ clientKey: key, name: key, campaign, firstLead: "2026-10-01", segment, state: null, qualified, deals: qualified ? 3 : 1, margin, firstMargin: 1000 });
  const r = foldAdClients([
    c("a", "S", true, "vip", 50000), c("b", "S", true, "unknown", 7000), c("c", "S", false, "unknown", 2000),
    c("d", null, true, "episodic", 9000), c("e", "P", false, "regular", 4000),
  ], "2026-01-01", "2026-11-11");
  const S = r.campaigns.find((x) => x.campaign === "S")!;
  assert.deepEqual([S.clients, S.regular, S.vip, S.regularSeg, S.episodic, S.margin, S.regularMargin], [3, 2, 1, 0, 0, 59000, 57000],
    "🔴 кампанія S: лічильники чи маржа не ті («ще без типу» не має йти в типи)");
  const P = r.campaigns.find((x) => x.campaign === "P")!;
  assert.equal(P.regular, 0, "🔴 непостійний (qualified=false) з сегментом «regular» зарахований у постійні");
  assert.deepEqual([r.totals.clients, r.totals.margin, r.clients.filter((x) => x.qualified).length], [5, 72000, 3], "🔴 плитки не сходяться з кампаніями");
  assert.equal(r.campaigns.reduce((s, x) => s + x.clients, 0), r.totals.clients);
});

/**
 * #3316c — КАМПАНІЯ КЛІЄНТА. 🧨 Червоніє, якщо «(referral)» знову стане кампанією, власна мітка угоди перестане
 * перебивати кампанію клієнта, або копія ключів-заглушок розійдеться з `metrics.GENERIC_CLIENT_KEYS`.
 */
test("#3316c КАМПАНІЯ КЛІЄНТА: (referral) не кампанія, власна мітка перша, заглушки клієнтів = metrics", () => {
  assert.ok(NOT_A_CAMPAIGN.includes("(referral)"), "🔴 «(referral)» рахується кампанією");
  const sql = dealCampaignSql("d");
  assert.ok(sql.indexOf("par.utm_campaign") < sql.indexOf("FROM deals cd"), "🔴 кампанія клієнта перебиває власну мітку угоди");
  const metricsSrc = readFileSync(path.join(import.meta.dirname, "..", "core", "metrics.js"), "utf8");
  const m = metricsSrc.match(/GENERIC_CLIENT_KEYS = \[([^\]]*)\]/);
  assert.ok(m, "🔴 не знайдено GENERIC_CLIENT_KEYS у metrics.js");
  const keys = m![1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
  assert.equal(GENERIC_CLIENT_KEYS_SQL, `ARRAY[${keys.map((k) => `'${k}'`).join(",")}]`, "🔴 копія ключів-заглушок розійшлась із metrics");
});

/**
 * #3317b — ПОВТОРНІ ЗАМОВЛЕННЯ, ГРУПИ Й КОГОРТИ (#8704, зустріч 12.11.2026: «скільки постійні принесли після першого
 * замовлення», «скільки разів у середньому замовляє», «як у лідгенів»). 🧨 Червоніє, якщо повторні почнуть включати
 * першу угоду, групи розійдуться з блоком LTV лідгенів (постійний × «активний»), або когорта візьме не місяць першого ліда.
 */
test("#3317b ПОВТОРНІ ЗАМОВЛЕННЯ: повторні = LTV − перша угода, групи як у лідгенів, когорта — місяць першого ліда", () => {
  const c = (key: string, ym: string, qualified: boolean, state: "active" | "sleeping" | "lost" | null, deals: number, margin: number, first: number) =>
    ({ clientKey: key, name: key, campaign: "S", firstLead: `${ym}-05`, segment: "unknown" as const, state, qualified, deals, margin, firstMargin: first });
  const r = foldAdClients([
    c("a", "2026-03", true, "active", 6, 30000, 4000), c("b", "2026-03", true, "sleeping", 2, 9000, 5000),
    c("c", "2026-04", false, "active", 1, 3000, 3000), c("d", "2026-04", false, "lost", 1, 2000, 2000),
  ], "2026-01-01", "2026-11-16");
  assert.deepEqual([r.totals.repeatMargin, r.totals.deals, r.totals.regularDeals, r.totals.active], [30000, 10, 8, 2],
    "🔴 повторні не дорівнюють LTV мінус першу угоду, або угоди/«працюють зараз» пораховано не так");
  assert.deepEqual(r.totals.mix, { rw: 1, rs: 1, ow: 1, os: 1 }, "🔴 групи складу розійшлись із блоком LTV лідгенів");
  assert.equal(adClientGroupOf({ qualified: true, state: null }), "rs", "🔴 постійний без стану має бути «не замовляє», а не «працює»");
  assert.deepEqual(r.cohorts.map((x) => [x.ym, x.clients, x.regular]), [["2026-03", 2, 2], ["2026-04", 2, 0]], "🔴 когорта — не місяць першого ліда");
  assert.deepEqual(r.clients.map((x) => x.repeatMargin), [26000, 4000, 0, 0], "🔴 повторні по клієнту пораховано не так");
});
