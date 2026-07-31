import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNamedMonth, guardFuturePeriod, parseMonth } from "./period.js";

/**
 * Крайні випадки розв'язання періоду. Дата «сьогодні» ПІДСТАВЛЯЄТЬСЯ, а не береться
 * з годинника — інакше «грудень у січні» можна було б перевірити лише в січні.
 */

test("місяць без року → найближче МИНУЛЕ входження", () => {
  // сьогодні липень 2026, питають червень → червень 2026 (цього року, вже минув)
  const a = resolveNamedMonth("червень", "2026-07-31")!;
  assert.equal(a.from, "2026-06-01");
  assert.equal(a.to, "2026-06-30");
  assert.equal(a.label, "червень 2026");
  assert.equal(a.incomplete, false);
});

test("🔴 грудень у січні → ГРУДЕНЬ МИНУЛОГО року, не майбутній", () => {
  const d = resolveNamedMonth("грудень", "2027-01-15")!;
  assert.equal(d.from, "2026-12-01", "грудень має бути торішній, інакше період у майбутньому");
  assert.equal(d.to, "2026-12-31");
  assert.equal(d.label, "грудень 2026");
});

test("поточний місяць → поточний, позначений неповним", () => {
  const c = resolveNamedMonth("липень", "2026-07-31")!;
  assert.equal(c.from, "2026-07-01");
  assert.equal(c.incomplete, true, "поточний місяць ще не завершився");
});

test("будь-який пізніший місяць відкочується на рік назад", () => {
  // сьогодні лютий 2026; «жовтень» ще не настав цього року → жовтень 2025
  const o = resolveNamedMonth("жовтень", "2026-02-10")!;
  assert.equal(o.label, "жовтень 2025");
  // а «січень» цього року вже минув
  const j = resolveNamedMonth("січень", "2026-02-10")!;
  assert.equal(j.label, "січень 2026");
});

test("високосний лютий рахується правильно", () => {
  assert.equal(resolveNamedMonth("лютий", "2028-06-01")!.to, "2028-02-29");
  assert.equal(resolveNamedMonth("лютий", "2027-06-01")!.to, "2027-02-28");
});

test("форми назви: називний, родовий, англійська, число", () => {
  for (const v of ["червень", "червня", "June", "june", "6", "06"]) {
    assert.equal(parseMonth(v), 6, `не розпізнано «${v}»`);
  }
  assert.equal(parseMonth("хрюнь"), null);
  assert.equal(parseMonth(13), null);
});

test("страхувальна сітка: період цілком у майбутньому зсувається на рік і ГУЧНО", () => {
  const g = guardFuturePeriod("2027-12-01", "2027-12-31", "2027-01-15")!;
  assert.equal(g.from, "2026-12-01");
  assert.equal(g.to, "2026-12-31");
  assert.ok(g.correction && g.correction.includes("майбутньому"), "правка має бути ПОМІТНОЮ, не мовчазною");
});

test("страхувальна сітка НЕ чіпає нормальний період", () => {
  assert.equal(guardFuturePeriod("2026-06-01", "2026-06-30", "2026-07-31"), null);
  // поточний місяць: почався в минулому, кінець у майбутньому — не чіпаємо
  assert.equal(guardFuturePeriod("2026-07-01", "2026-07-31", "2026-07-15"), null);
});
