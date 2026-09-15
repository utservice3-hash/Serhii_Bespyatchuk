import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveManager, effectiveFromFor, effectiveManagerSql, monthLiteralSql } from "./effectiveManager.js";
import { clientsListSql } from "./clientPlansList.js";

/**
 * #420 — ХТО ВЕДЕ КЛІЄНТА НА МІСЯЦЬ M: закріплений діє з `pinned_from_month`, до нього —
 * основний за оплатами; без дати — одразу. Фікстури по ОБИДВА боки межі місяця.
 * Червоніє, якщо повернути `COALESCE(pinned, primary)` (дата перестане важити) або
 * трактувати «без дати» як «ніколи».
 */
test("#420 ЕФЕКТИВНИЙ МЕНЕДЖЕР: до pinned_from_month — основний, з нього — закріплений, без дати — одразу", () => {
  assert.equal(effectiveManager(87, "2026-10-01", 8, "2026-09"), 8, "вересень до дати дії — ще основний");
  assert.equal(effectiveManager(87, "2026-10-01", 8, "2026-10"), 87, "жовтень — уже закріплений");
  assert.equal(effectiveManager(87, "2026-09-01", 8, "2026-09"), 87, "виправлення з 1-го поточного діє в поточному");
  assert.equal(effectiveManager(87, null, 8, "2026-01"), 87, "старе закріплення без дати чинне завжди");
  assert.equal(effectiveManager(null, null, 8, "2026-09"), 8, "без закріплення — основний");
});

/**
 * #420b — ДАТА ДІЇ ЗА ВИДОМ ЗМІНИ: `fix` → 1-ше ПОТОЧНОГО, `transfer` → 1-ше НАСТУПНОГО,
 * включно з переходом через рік і з 31-м числом (JS не мусить перескочити місяць).
 */
test("#420b effectiveFromFor: fix — поточний місяць, transfer — наступний, 31-ше не перескакує", () => {
  assert.equal(effectiveFromFor("fix", "2026-09-15"), "2026-09-01");
  assert.equal(effectiveFromFor("transfer", "2026-09-15"), "2026-10-01");
  assert.equal(effectiveFromFor("transfer", "2026-12-31"), "2027-01-01");
  assert.equal(effectiveFromFor("transfer", "2026-08-31"), "2026-09-01", "31.08 + місяць = вересень, не жовтень");
  assert.equal(effectiveFromFor("fix", "2026-08-31"), "2026-08-01");
});

/**
 * #420c — SQL-вираз несе ту саму межу, що чиста функція, і список клієнтів бере САМЕ його
 * (двічі: колонка `manager_id` і JOIN менеджера), а `COALESCE(lo.pinned_manager_id` у ядрі
 * більше не зустрічається. 🪞 Скоуп менеджера в роуті — за `b.manager_id`, не за
 * `b.primary_manager_id` (інакше переданий клієнт зникає для нового менеджера).
 */
test("#420c СПИСОК і ЧИТАЧІ беруть ефективного менеджера; скоуп роуту — по ньому ж", () => {
  const sql = clientsListSql("", "2026-10");
  assert.match(sql, /pinned_from_month, DATE '1970-01-01'\) <= DATE '2026-10-01'/, "місяць списку не дійшов до правила");
  assert.equal((sql.match(/pinned_from_month/g) ?? []).length, 2, "правило має стояти і в колонці, і в JOIN менеджера");
  assert.doesNotMatch(sql, /COALESCE\(lo\.pinned_manager_id/, "стара форма без дати повернулась");
  assert.throws(() => monthLiteralSql("2026-13"), /не місяць/);
  assert.throws(() => monthLiteralSql("2026-10-01'; DROP"), /не місяць/);
  assert.match(effectiveManagerSql("lo", "pm"), /date_trunc\('month', \(now\(\) AT TIME ZONE 'Europe\/Kyiv'\)\)/, "дефолт — поточний місяць по Києву");
  const src = path.join(import.meta.dirname, "..", "..", "src");
  for (const f of ["core/reactivation.ts", "core/reactivationClose.ts", "routes/clientPlanRules.ts", "routes/dashboard.ts"]) {
    const t = readFileSync(path.join(src, f), "utf8");
    assert.doesNotMatch(t, /COALESCE\(lo\.pinned_manager_id,\s*pm\.manager_id\)/, `${f}: копія старого правила без дати`);
  }
  const route = readFileSync(path.join(src, "routes", "dashboard.ts"), "utf8");
  assert.match(route, /mgrCond = `AND b\.manager_id = \$/, "скоуп менеджера не за ефективним менеджером");
  assert.doesNotMatch(route, /mgrCond = `AND b\.primary_manager_id/, "скоуп знову за основним по оплатах");
  assert.match(route, /clientsListSql\(mgrCond, monthStr\)/, "список не отримує місяць екрана");
});
