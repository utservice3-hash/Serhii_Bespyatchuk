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

/**
 * #397c — ДОВАНТАЖ == повідомлення Андрія Безпамʼятного 11.09.2026, число в число:
 * «до 2 м 15-18-20, до 3 м 20-22-25 за км по зонах». 🪞 Чотири тоннажі при цьому не
 * рухаються (той самий expected, що в #397). Червоніє на зміні будь-якого числа.
 */
test("#397c ДОВАНТАЖ == повідомлення КВП 11.09.2026 (2 м 15/18/20, 3 м 20/22/25), тоннажі на місці", async () => {
  const { PARTIAL_RATES } = await import("./zoneRates.js");
  assert.deepEqual(PARTIAL_RATES.map((b) => ({ label: b.label, ...b.rates })), [
    { label: "Довантаж до 2 м", green: [15, 15], yellow: [18, 18], red: [20, 20] },
    { label: "Довантаж до 3 м", green: [20, 20], yellow: [22, 22], red: [25, 25] },
  ]);
  assert.equal(ZONE_RATES.length, 4, "тоннажів має лишитись рівно чотири");
  assert.deepEqual(ZONE_RATES[0].rates, { green: [30, 30], yellow: [35, 35], red: [35, 40] });
});

/**
 * #397d — У ВІДПОВІДІ КАЛЬКУЛЯТОРА довантаж іде окремою групою: рівно 4 vehicle + 2 partial,
 * partial ніколи не selected, «Клієнту» для нього null (маржі КВП не називав — не вигадуємо),
 * а грн/км несе коротке плече ×1.5 так само, як авто. Червоніє, якщо довантаж зникне з
 * options, стане selected, отримає вигадану маржу або втратить коефіцієнт.
 */
test("#397d ОПЦІЇ: 4 авто + 2 довантажі, довантаж не обирається і без вигаданої маржі", async () => {
  const { zoneRecommendation } = await import("./zoneRates.js");
  const r = zoneRecommendation("Київська область", "Львівська область", 3, 80)!;
  assert.ok(r, "зона не розпізналась — перевірці нема що знаходити");
  const vehicles = r.options.filter((o) => o.kind === "vehicle");
  const partial = r.options.filter((o) => o.kind === "partial");
  assert.equal(vehicles.length, 4); assert.equal(partial.length, 2);
  assert.equal(vehicles.filter((o) => o.selected).length, 1, "рівно один тоннаж обраний");
  assert.ok(partial.every((o) => !o.selected && o.client_min === null && o.margin === null));
  const two = partial[0];
  const perKm = { green: 15, yellow: 18, red: 20 }[r.zone as "green" | "yellow" | "red"];
  assert.equal(two.per_km_min, Math.round(perKm * 1.5), "коротке плече ×1.5 не застосовано");
  assert.equal(two.total_min, Math.round(perKm * 1.5 * 80));
  // 🪞 На довгому плечі коефіцієнта немає.
  const far = zoneRecommendation("Київська область", "Львівська область", 3, 500)!;
  assert.equal(far.options.find((o) => o.kind === "partial")!.per_km_min, perKm);
});
