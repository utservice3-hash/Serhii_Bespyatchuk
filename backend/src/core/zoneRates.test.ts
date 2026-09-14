import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ZONE_RATES } from "./zoneRates.js";
import { CLOSE_REASON_KEYS } from "./reactivationRules.js";

/**
 * #397 — ТАРИФИ КАЛЬКУЛЯТОРА == ПОВІДОМЛЕННЯ КВП, дослівно.
 * Фікстура переписана з повідомлення Дарини Михальчевської (04.09.2026): «2т зелена 30,
 * помаранчева 35, червона 35-40; 5т 40-45 / 45-50 / 50-55; 10т 55-60 / 60-65 / 65-70;
 * 20т 70-75 / 75-85 / 85-90». Червоніє на зміні будь-якого числа в коді без зміни фікстури.
 */
test("#397 ТАРИФИ КАЛЬКУЛЯТОРА == повідомлення КВП 04.09.2026, число в число", () => {
  const expected = [
    { label: "до 2,5 т", green: [30, 30], yellow: [35, 35], red: [35, 40] },
    { label: "до 5 т", green: [40, 45], yellow: [45, 50], red: [50, 55] },
    { label: "до 10 т", green: [55, 60], yellow: [60, 65], red: [65, 70] },
    { label: "20 т (фура)", green: [70, 75], yellow: [75, 85], red: [85, 90] },
  ];
  assert.deepEqual(ZONE_RATES.map((b) => ({ label: b.label, ...b.rates })), expected);
  // 🪞 У кожному брекеті мін ≤ макс і зони зростають: зелена ≤ жовта ≤ червона по нижній межі.
  for (const b of ZONE_RATES) {
    for (const z of ["green", "yellow", "red"] as const) assert.ok(b.rates[z][0] <= b.rates[z][1], `${b.label} ${z}: мін > макс`);
    assert.ok(b.rates.green[0] <= b.rates.yellow[0] && b.rates.yellow[0] <= b.rates.red[0], `${b.label}: зони не зростають`);
  }
});

/**
 * #397b — СЛОВНИК ПРИЧИН У КОДІ == CHECK У СХЕМІ. Два переліки, які легко розійти:
 * додав ключ у код і забув схему → архівація з новою причиною падає на CHECK у проді.
 * Читає `schema.sql` як текст і вимагає кожен ключ словника всередині CHECK-у, і навпаки.
 * Червоніє, якщо прибрати ключ з будь-якого боку.
 */
test("#397b СЛОВНИК ПРИЧИН == CHECK loyalty_overrides_archive_reason_chk, в обидва боки", () => {
  const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  const m = schema.match(/loyalty_overrides_archive_reason_chk[\s\S]*?archive_reason IN\s*\(([^)]*)\)/);
  assert.ok(m, "CHECK на archive_reason не знайдено в schema.sql");
  const inSchema = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(inSchema, [...CLOSE_REASON_KEYS].sort(), "словник у коді й CHECK у схемі розійшлися");
  assert.ok(inSchema.includes("carrier") && inSchema.includes("one_off"), "нові причини 10.09 не доїхали до CHECK");
});
