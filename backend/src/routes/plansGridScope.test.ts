import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 💵 #742–#742b — «СІТКА ПЛАНІВ» ЛИШЕ ДЛЯ ПРОДАЖНИХ МЕНЕДЖЕРІВ (запит 25.09.2026: «з вкладки Плани прибрати Фін. відділ»).
 *
 * `/plans-grid` брав УСІХ активних менеджерів: фінвідділ, лідгенів без команди, людей без команди —
 * і всім пропонував грошовий план. Тепер — те саме правило «комерційний менеджер», що в Звіті й
 * застряглих (`metrics.commercialManagerSql`, єдине джерело), а випадайка команд ховає некомерційні
 * (фронтовий `NON_COMMERCIAL_TEAM_IDS`). Джерела читаються текстом — без БД, у кожному оточенні.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Тіло роуту `/plans-grid` — до наступного оголошення роуту (змістова межа, а не довжина). */
function routeBody(src: string): string {
  const i = src.indexOf('dashboardRouter.get("/plans-grid"');
  if (i < 0) return "";
  const j = src.indexOf("dashboardRouter.", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}
export function plansGridDrift(dashboard: string, plansSection: string): string[] {
  const out: string[] = [];
  const body = routeBody(dashboard);
  if (!body) return ["🔴 роут /plans-grid не знайдено"];
  if (!/\bcommercialManagerSql\("m"\)/.test(body)) out.push("🔴 /plans-grid без commercialManagerSql — у сітці знову фінвідділ і люди без команди");
  if (!/teamOptions\(teams\.filter\(\(t\) => !NON_COMMERCIAL_TEAM_IDS\.has\(t\.id\)\)\)/.test(plansSection)) out.push("🔴 випадайка команд у «Планах» показує некомерційні команди");
  return out;
}

test("#742 «Сітка планів» лише для продажних менеджерів: роут фільтрує commercialManagerSql, випадайка ховає некомерційні команди", () => {
  assert.deepEqual(plansGridDrift(read("backend/src/routes/dashboard.ts"), read("frontend/src/pages/dashboard/sections/PlansSection.tsx")), []);
});

test("#742b 🪞 ДЗЕРКАЛО: зняти фільтр у роуті чи у випадайці — спіймано", () => {
  const d = read("backend/src/routes/dashboard.ts"), p = read("frontend/src/pages/dashboard/sections/PlansSection.tsx");
  const dBad = d.replace('AND ${metrics.commercialManagerSql("m")} ${teamCond}', "${teamCond}");
  const pBad = p.replace("teamOptions(teams.filter((t) => !NON_COMMERCIAL_TEAM_IDS.has(t.id)))", "teamOptions(teams)");
  assert.notEqual(dBad, d, "🔴 підміна в роуті не застосувалась"); assert.notEqual(pBad, p, "🔴 підміна у випадайці не застосувалась");
  assert.ok(plansGridDrift(dBad, p).length > 0, "🔴 не спіймано: роут без фільтра");
  assert.ok(plansGridDrift(d, pBad).length > 0, "🔴 не спіймано: випадайка без фільтра");
});
