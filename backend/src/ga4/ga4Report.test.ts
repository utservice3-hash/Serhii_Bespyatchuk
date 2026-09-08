import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGa4Report, totalCost, GA4_NOT_CONFIGURED, syncWindow, LOOKBACK_DAYS } from "./report.js";
import { classifyJobError } from "../health/jobErrorKind.js";

/**
 * 📊 #369…#369d — РОЗБІР ВІДПОВІДІ GA4 (08.09.2026).
 *
 * 🔴 ЧОМУ ФІКСТУРА, А НЕ ЖИВИЙ ВИКЛИК. Живий GA4 потребує ключа, мережі й відповідає
 * різними числами щодня — гейт на ньому червонів би не з нашої вини й за два тижні
 * його почали б гортати очима (той самий урок, що `#137e`). Розбір — чиста функція,
 * тож перевіряється без жодного оточення й виконується ЗАВЖДИ, а не «де вийде».
 *
 * 🔴 МЕТРИКИ У ФІКСТУРІ ПЕРЕСТАВЛЕНІ НАВМИСНО. У реальній відповіді порядок метрик
 * контрактом не гарантований, а найтиповіша помилка розбору — «третє значення = cost».
 * Тут `advertiserAdCost` стоїть ПЕРШИМ, а `sessions` — третім: розбір за позицією дасть
 * витрати замість сесій, і #369 почервоніє саме на цьому.
 */

/** Дві кампанії × два дні + органічний рядок. Порядок метрик НЕ збігається з запитом. */
const FIXTURE = {
  dimensionHeaders: [
    { name: "date" }, { name: "sessionCampaignName" }, { name: "sessionDefaultChannelGroup" },
  ],
  metricHeaders: [
    { name: "advertiserAdCost" }, { name: "advertiserAdClicks" },
    { name: "sessions" }, { name: "conversions" },
  ],
  rows: [
    { dimensionValues: [{ value: "20260825" }, { value: "Пошук · Логістика" }, { value: "Paid Search" }],
      metricValues: [{ value: "9452.5" }, { value: "120" }, { value: "310" }, { value: "12" }] },
    { dimensionValues: [{ value: "20260825" }, { value: "КМС · Ретаргет" }, { value: "Display" }],
      metricValues: [{ value: "1200" }, { value: "40" }, { value: "95" }, { value: "3" }] },
    { dimensionValues: [{ value: "20260826" }, { value: "Пошук · Логістика" }, { value: "Paid Search" }],
      metricValues: [{ value: "7781" }, { value: "101" }, { value: "288" }, { value: "9" }] },
    { dimensionValues: [{ value: "20260826" }, { value: "(organic)" }, { value: "Organic Search" }],
      metricValues: [{ value: "0" }, { value: "0" }, { value: "140" }, { value: "6" }] },
  ],
};

test("#369 РОЗБІР GA4: рядки день×кампанія з правильними cost/clicks (метрики не за позицією)", () => {
  const rows = parseGa4Report(FIXTURE);
  assert.equal(rows.length, 4, "розбір втратив або вигадав рядки");

  const a = rows[0];
  assert.equal(a.day, "2026-08-25", "день не переведено з YYYYMMDD у YYYY-MM-DD — не зіставиться з БД");
  assert.equal(a.campaign, "Пошук · Логістика");
  assert.equal(a.channelGroup, "Paid Search");
  assert.equal(a.cost, 9452.5,
    "🔴 cost узято не з `advertiserAdCost` — розбір поїхав за позицією, і на екрані буде чуже число");
  assert.equal(a.clicks, 120, "🔴 clicks не з `advertiserAdClicks`");
  assert.equal(a.sessions, 310, "🔴 sessions не з `sessions` — саме тут ловиться розбір за позицією");
  assert.equal(a.conversions, 12);

  // Σ витрат — одне місце для екрана й гейта.
  assert.equal(totalCost(rows), 9452.5 + 1200 + 7781, "Σ витрат не збігається з сумою рядків");
});

test("#369b 🪞 ОРГАНІКА: cost 0 і НЕ роздуває суму витрат", () => {
  const rows = parseGa4Report(FIXTURE);
  const organic = rows.find((r) => r.campaign === "(organic)");
  assert.ok(organic, "органічний рядок зник із розбору — фільтр каналу зʼїв те, чого не мав");
  assert.equal(organic!.cost, 0,
    "🔴 в органіки ненульові витрати — розбір підставив під cost іншу метрику (напр. sessions)");
  assert.ok(organic!.sessions > 0,
    "🔴 в органіки нуль сесій — тоді рядок не доводить нічого: перевірці не було що знаходити");

  // Дзеркало по суті: Σ по ВСІХ рядках == Σ лише по платних, бо органіка додає рівно 0.
  const paidOnly = rows.filter((r) => r.cost > 0);
  assert.equal(totalCost(rows), totalCost(paidOnly),
    "🔴 органіка змінює суму витрат — вона потрапила в гроші, хоч коштує нуль");
  assert.ok(paidOnly.length < rows.length, "у фікстурі немає безкоштовного рядка — дзеркало порожнє");
});

test("#369c Σ ВИТРАТ ПО ДНЯХ == Σ ПО КАМПАНІЯХ (інваріант групування)", () => {
  const rows = parseGa4Report(FIXTURE);
  const sumBy = (key: (r: { day: string; campaign: string }) => string) => {
    const m = new Map<string, number>();
    for (const r of parseGa4Report(FIXTURE)) m.set(key(r), (m.get(key(r)) ?? 0) + r.cost);
    return Math.round([...m.values()].reduce((s, v) => s + v, 0) * 100) / 100;
  };
  assert.equal(sumBy((r) => r.day), sumBy((r) => r.campaign),
    "🔴 Σ по днях ≠ Σ по кампаніях — при групуванні загубився рядок");
  assert.equal(sumBy((r) => r.day), totalCost(rows),
    "🔴 жодне з групувань не дорівнює загальній сумі — екран показуватиме три різні числа");
});

test("#369d НЕНАЛАШТОВАНА ІНТЕГРАЦІЯ — вид помилки `config`, а не `data`/`unknown`", () => {
  assert.equal(classifyJobError(GA4_NOT_CONFIGURED), "config",
    "🔴 відсутній ключ читається як інший вид — тривога пошле шукати поломку даних замість .env");
  // Вікно синку захоплює минуле: GA4 доуточнює дані до ~72 год.
  const w = syncWindow(new Date("2026-09-08T10:00:00Z"));
  assert.equal(w.to, "2026-09-08");
  assert.equal(w.from, "2026-09-04", `вікно ${w.from}..${w.to} не покриває ${LOOKBACK_DAYS} днів доуточнення GA4`);
});
