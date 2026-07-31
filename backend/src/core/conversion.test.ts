import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

/**
 * ІНВАРІАНТИ КОНВЕРСІЙ (пункт C — зведення `scripts/gateStepV.ts` у той самий набір;
 * скрипт видалено, щоб не лишалось навіть залишкової другої культури).
 *
 * Що тримаємо:
 *  • стеля ≤100% — чисельник ⊆ знаменник за побудовою (когортна версія);
 *  • дозрівання: поточний місяць НЕ може бути mature (когорта не догорнулась);
 *  • детермінізм: два виклики поспіль дають те саме;
 *  • крос-екран: Σ per-manager == загальне по відділу (розрізи можна класти поруч).
 */

const load = async () => ({
  metrics: await import("./metrics.js"),
  getSettings: (await import("../routes/settings.js")).getSettings,
});

const MATURE_YM = process.env.TEST_CONV_MONTH ?? "2026-02"; // зрілий місяць
const kyivYm = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
const monthRange = (ym: string) => ({
  from: `${ym}-01`,
  to: new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10),
});

test("C.1 конверсія реклами: ≤100%, знаменник не порожній", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  assert.ok(adSources.length > 0, "adSources порожній — конфіг-помилка, рекламні метрики були б нулями");
  const rows = await metrics.conversionAdsByMonth({}, adSources);
  assert.ok(rows.length > 0, "конверсія реклами порожня — порожній результат це ПРОВАЛ");
  const bad = rows.filter((r) => r.cohortPct != null && r.cohortPct > 100);
  assert.deepEqual(bad.map((r) => `${r.ym}=${r.cohortPct}%`), [],
    "когортна конверсія >100% — чисельник вийшов за межі знаменника");
  const empty = rows.filter((r) => Number(r.entered) === 0);
  assert.ok(empty.length < rows.length, "у ВСІХ місяців знаменник нульовий — рекламна воронка не рахується");
});

test("C.2 ДОЗРІВАННЯ: поточний місяць не може бути mature", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const rows = await metrics.conversionAdsByMonth({}, adSources);
  const cur = rows.find((r) => r.ym === kyivYm());
  if (!cur) return; // поточного місяця ще немає в ряді — нічого перевіряти
  assert.equal(cur.mature, false,
    `поточний місяць ${cur.ym} позначено дозрілим — когорта ще догортається, цифра буде заниженою`);
});

test("C.3 ДЕТЕРМІНІЗМ: два виклики поспіль дають те саме", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const a = await metrics.conversionAdsByMonth({}, adSources);
  const b = await metrics.conversionAdsByMonth({}, adSources);
  assert.deepEqual(b, a, "той самий виклик дав інший результат — недетермінована метрика");
});

test("C.4 КРОС-ЕКРАН: Σ per-manager == загальне по відділу (зрілий місяць)", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const range = monthRange(MATURE_YM);
  const mgr = await metrics.conversionAdsByManager(range, adSources);
  assert.ok(mgr.length > 0, `per-manager конверсія за ${MATURE_YM} порожня — провал`);
  const sumEntered = mgr.reduce((s, m) => s + Number(m.entered ?? 0), 0);
  const monthly = (await metrics.conversionAdsByMonth({}, adSources)).find((r) => r.ym === MATURE_YM);
  assert.ok(monthly, `місяця ${MATURE_YM} немає в помісячному ряді`);
  assert.ok(sumEntered > 0, "Σ per-manager знаменник = 0 — розріз порожній");
  // Σ per-manager рахує лише угоди з manager_id; відділ бере всі → Σ ≤ відділ.
  assert.ok(sumEntered <= Number(monthly!.entered),
    `Σ per-manager ${sumEntered} БІЛЬШЕ за відділ ${monthly!.entered} — так бути не може`);
  assert.ok(sumEntered >= Number(monthly!.entered) * 0.9,
    `Σ per-manager ${sumEntered} проти відділу ${monthly!.entered} — >10% угод без менеджера, розрізи не сходяться`);
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});
