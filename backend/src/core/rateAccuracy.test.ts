import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pairsOf, groupAccuracy, distanceBand, accuracyReport, SOURCE_LABEL } from "./rateAccuracy.js";
import { parseFeedback, RateFeedbackError, type FeedbackRow } from "./rateFeedback.js";

/**
 * 📐 #2807–#2811 — «ПОРАХУВАЛИ → ВИЙШЛО» (Роман 30.10.2026): пари «що порахував калькулятор / на що домовились»,
 * групи «де помиляємось» з медіаною, друга погоджена ставка (перевізнику). Чисті функції + джерела текстом.
 */
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SCHEMA = SRC("../db/schema.sql");
const RATES = SRC("../../src/routes/rates.ts");
const SCREEN = SRC("../../../frontend/src/pages/dashboard/sections/RatesSimple.tsx");
const STATS = SRC("../../../frontend/src/pages/dashboard/sections/RateFeedbackStats.tsx");

const row = (p: Partial<FeedbackRow> & { day?: number }): FeedbackRow => ({
  rating: "low", agreed: null, agreedCarrier: null, comment: null, at: new Date(Date.UTC(2026, 9, p.day ?? 30)), author: "Тест",
  frm: "Київ", tox: "Львів", calc: { client_min: 40000, client_max: 44000, carrier_min: 35000, carrier_max: 37000, tonnage: "20 т (фура)", distance_km: 540, zone: "green", price_source: "market" },
  ...p,
});

test("#2807 ПАРА: відхилення від СЕРЕДИНИ діапазону зі знаком по обидва боки; без ціни чи без знімка — не пара; перевізнику — окремо", () => {
  const rows = [
    row({ agreed: 50400, day: 28 }),                              // +20% від 42 000
    row({ agreed: 33600, day: 29 }),                              // −20%
    row({ day: 27 }),                                             // оцінка без ціни — не пара
    row({ agreed: 50000, calc: null, day: 26 }),                  // ціна без знімка — порівнювати нема з чим
    row({ agreedCarrier: 39600, day: 30 }),                       // лише перевізнику: +10% від 36 000
  ];
  const pairs = pairsOf(rows);
  assert.deepEqual(pairs.map((p) => [p.at.slice(0, 10), p.dev_pct, p.dev_carrier_pct]),
    [["2026-10-30", null, 10], ["2026-10-29", -20, null], ["2026-10-28", 20, null]],
    "🔴 пари: знак/величина відхилення або порядок (найновіші зверху) не ті");
  assert.deepEqual([pairs[2].client_min, pairs[2].client_max, pairs[2].agreed, pairs[2].source, pairs[2].km, pairs[2].route],
    [40000, 44000, 50400, "market", 540, "Київ → Львів"], "🔴 у парі немає того, що порахували, або звідки");
});

test("#2808 ГРУПА РАХУЄ МЕДІАНУ, НЕ СЕРЕДНЄ: один викид +300% не рухає відповідь; оцінки — за всіма, медіани — за тими, де є ціна", () => {
  const devs = [10, 12, 11, 9, 300];
  const rows = devs.map((d, i) => row({ agreed: 42000 * (1 + d / 100), rating: i === 0 ? "ok" : "low", day: 20 + i }));
  rows.push(row({ rating: "no", day: 26 }));                      // без ціни — лише в оцінки
  const [g] = groupAccuracy(rows, () => "фура");
  assert.deepEqual([g.n, g.priced, g.median_dev, g.median_abs, g.ok, g.low, g.no, g.high], [6, 5, 11, 11, 1, 4, 1, 0],
    "🔴 група: медіана не 11 (середнє дало б 68,4) або лічильники оцінок не ті");
});

test("#2809 СМУГИ ВІДСТАНІ: 199 → до 200, 200 і 500 → 200–500, 501 → понад 500, невідомо — окремо", () => {
  assert.deepEqual([199, 200, 500, 501, null].map(distanceBand), ["до 200 км", "200–500 км", "200–500 км", "понад 500 км", "км невідомі"]);
});

test("#2810 СТАВКА ПЕРЕВІЗНИКУ У ВІДГУКУ: порожньо → null, «38 000» → 38000, нуль чи текст — 400; колонка в схемі, у вставці й у формі", () => {
  const ok = parseFeedback({ usageId: 7, rating: "ok", agreed: "", agreedCarrier: "38 000" });
  assert.deepEqual([ok.agreed, ok.agreedCarrier], [null, 38000]);
  assert.equal(parseFeedback({ usageId: 7, rating: "ok" }).agreedCarrier, null, "🔴 відсутнє поле мусить бути null, а не помилкою");
  for (const bad of ["0", "abc", "-5"]) {
    assert.throws(() => parseFeedback({ usageId: 7, rating: "ok", agreedCarrier: bad }), (e) => e instanceof RateFeedbackError && e.status === 400, `🔴 прийнято «${bad}»`);
  }
  assert.match(SCHEMA, /ALTER TABLE rate_feedback ADD COLUMN IF NOT EXISTS agreed_carrier NUMERIC\(12,2\) CHECK \(agreed_carrier IS NULL OR agreed_carrier > 0\);/, "🔴 колонки в схемі немає");
  assert.match(RATES, /INSERT INTO rate_feedback \(usage_id, user_id, rating, agreed_rate, agreed_carrier, comment\)/, "🔴 роут не пише ставку перевізнику");
  assert.match(RATES, /f\.agreed_carrier/, "🔴 зведення не читає ставку перевізнику");
  assert.match(SCREEN, /sendRateFeedback\(\{ usageId: data\.usage_id, rating: pick, agreed, agreedCarrier, comment: note \}\)/, "🔴 форма не шле ставку перевізнику");
  assert.match(SCREEN, /Ставка перевізнику, яку погодили/, "🔴 у формі немає поля ставки перевізнику");
});

test("#2811 НАЙГІРША ГРУПА — ПЕРША, без ціни — останні; звіт віддає пари й усі чотири розрізи; екран малює «Порахували → вийшло»", () => {
  const rows = [
    row({ agreed: 44100, calc: { ...row({}).calc, tonnage: "до 5 т" } }),                   // +5%
    row({ agreed: 54600, calc: { ...row({}).calc, tonnage: "20 т (фура)" } }),               // +30%
    row({ calc: { ...row({}).calc, tonnage: "до 10 т" } }),                                  // без ціни
  ];
  assert.deepEqual(groupAccuracy(rows, (r) => r.calc?.tonnage ?? "?").map((g) => [g.key, g.median_abs]),
    [["20 т (фура)", 30], ["до 5 т", 5], ["до 10 т", null]], "🔴 порядок груп: найгірша має стояти першою, без ціни — останньою");
  const rep = accuracyReport(rows);
  assert.deepEqual([rep.priced, rep.median_dev, rep.pairs.length, rep.bySource[0].key, rep.byDistance[0].key, rep.byZone[0].key],
    [2, 17.5, 2, SOURCE_LABEL.market, "понад 500 км", "green"]);
  for (const need of ["Порахували → вийшло", "Де помиляємось", "const a = d.accuracy", "a.pairs", "median_dev", "dev_pct"]) {
    assert.ok(STATS.includes(need), `🔴 на екрані статистики немає «${need}»`);
  }
});
