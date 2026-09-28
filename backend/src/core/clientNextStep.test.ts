import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stepState, phoneState, stepVerdict, STEP_TEXT_MAX } from "./clientNextStep.js";

/**
 * #693 — СТАН КРОКУ ВІД КИЇВСЬКОГО «СЬОГОДНІ», по обидва боки кожної межі: вчора → прострочено,
 * сьогодні → сьогодні, завтра → план; без дати — `none`, не прострочено; виконаний — `done`
 * незалежно від дати. «Нема номера» — стан при нулі номерів, і 🪞 `has` при одному.
 * Червоніє, якщо порівняння дат зрушити (≤ замість <) або зробити крок без дати простроченим.
 */
test("#693 stepState/phoneState: межі вчора/сьогодні/завтра, без дати ≠ прострочено, done понад усе", () => {
  const T = "2026-09-24";
  assert.equal(stepState("2026-09-23", null, T), "overdue");
  assert.equal(stepState("2026-09-24", null, T), "today");
  assert.equal(stepState("2026-09-25", null, T), "planned");
  assert.equal(stepState(null, null, T), "none", "крок без дати не буває простроченим");
  assert.equal(stepState("2026-01-01", "2026-09-20T10:00:00Z", T), "done", "🪞 виконаний не прострочений, хоч дата давно минула");
  assert.equal(phoneState(0), "none"); assert.equal(phoneState(1), "has");
  assert.deepEqual(stepVerdict("  передзвонити  ", "2026-09-25"), { ok: true, text: "передзвонити", due: "2026-09-25" });
  assert.deepEqual(stepVerdict("надіслати КП", ""), { ok: true, text: "надіслати КП", due: null });
  assert.equal(stepVerdict("   ", null).ok, false, "порожній крок не приймається");
  assert.equal(stepVerdict("x".repeat(STEP_TEXT_MAX + 1), null).ok, false);
  assert.equal(stepVerdict("x", "25.09.2026").ok, false, "дата лише YYYY-MM-DD");
});

/**
 * #693b — ПРОВОДКА: обидва роути кроку стоять за `canSeeClient` ПЕРШИМ оператором, новий крок
 * закриває попередній у транзакції; рядок плану і картка несуть `nextStep` через `stepState` і
 * `phone` через `phoneState`; матриця знає обидва роути. Читає джерело, межа слова.
 */
test("#693b РОУТИ кроку за canSeeClient, новий крок закриває старий, рядок і картка несуть крок і стан номера", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const d = readFileSync(path.join(src, "routes", "dashboard.ts"), "utf8");
  for (const route of ['dashboardRouter.post("/client-next-step"', 'dashboardRouter.post("/client-next-step/done"']) {
    const i = d.indexOf(route); assert.ok(i > 0, `${route} не знайдено`);
    const body = d.slice(i, d.indexOf("\n});", i));
    assert.ok(body.indexOf("canSeeClient(") < body.indexOf("status(400)"), `${route}: скоуп мусить стояти ДО валідації`);
  }
  const post = d.slice(d.indexOf('dashboardRouter.post("/client-next-step"'), d.indexOf('dashboardRouter.post("/client-next-step/done"'));
  assert.match(post, /UPDATE client_next_steps SET done_at = now\(\)[\s\S]*INSERT INTO client_next_steps/, "новий крок не закриває попередній");
  assert.match(post, /"BEGIN"[\s\S]*"COMMIT"/, "закриття й вставка не в одній транзакції");
  assert.equal((d.match(/state: stepState\(/g) ?? []).length, 2, "стан кроку рахується stepState і в рядку плану, і в картці");
  assert.equal((d.match(/phone: phoneState\(/g) ?? []).length, 2, "стан номера — phoneState і в рядку, і в картці");
  const m = readFileSync(path.join(src, "auth", "accessMatrix.ts"), "utf8");
  assert.match(m, /path: "\/api\/dashboard\/client-next-step", cls: "deny-only"/);
  assert.match(m, /path: "\/api\/dashboard\/client-next-step\/done", cls: "deny-only"/);
  assert.match(readFileSync(path.join(src, "auth", "routeTab.ts"), "utf8"), /pre\("\/api\/dashboard\/client-next-step"\), tabs: \["loyalty"\]/);
});
