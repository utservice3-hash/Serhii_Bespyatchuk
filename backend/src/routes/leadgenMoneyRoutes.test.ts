import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import { tabsForPath } from "../auth/routeTab.js";

/**
 * #677…#678b — РОУТИ ГРОШЕЙ З ПЕРЕДАЧ: одне джерело числа і списку, доступ як у `/leadgen-stats`,
 * відмова менеджеру — першим оператором.
 *
 * Читаємо ДЖЕРЕЛО роуту, а не HTTP: для проби потрібні живий сервер, ролі й дані — три
 * умови, кожна з яких дала б `skip`, і гейт мовчки не виконувався б. А стереже він рішення
 * власника, тож мусить триматись у звичайному `npm test`.
 */

const DASH = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts"), "utf8");

/** Тіло обробника: від оголошення до закривної `});` у нульовій колонці. */
function handlerBody(src: string, route: string): string {
  const i = src.indexOf(`dashboardRouter.get("${route}"`);
  assert.ok(i > 0, `🔴 обробника ${route} у dashboard.ts немає — гейту нема що перевіряти`);
  const end = src.indexOf("\n});", i);
  assert.ok(end > i, `🔴 кінець обробника ${route} не знайдено`);
  return src.slice(i, end);
}

/** Перший оператор тіла — без коментарів і порожніх рядків. */
function firstStatement(body: string): string {
  const inner = body.slice(body.indexOf("=> {") + 4).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return inner.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

const MANAGER_FIRST = /^if \(req\.auth!\.role === "manager"\) return res\.status\(403\)/;

/**
 * #677 — ЧИСЛО В РЯДКУ І СПИСОК БЕРУТЬ ГРОШІ З ОДНІЄЇ ФУНКЦІЇ ЯДРА.
 *
 * `/leadgen-stats` → `handoffMoney` і `/leadgen-handoff-deals` → `totals` мусять збігатися за
 * той самий період і скоуп; екран порівнює їх і кричить «список не збігся». Гарантія —
 * не арифметика в роуті, а ОДИН виклик `leadgenHandoffMoney(` в обох (межа слова: сусід
 * `leadgenHandoffMoneyV2(` не зарахується), і жодного власного підсумку в роуті.
 * 🧨 САБОТАЖ: у `/leadgen-handoff-deals` рахувати `totals` через `aggregateHandoffMoney(hm.deals)` → червоніє.
 */
test("#677 ДЖЕРЕЛО: /leadgen-stats і /leadgen-handoff-deals беруть гроші з ОДНІЄЇ функції ядра", () => {
  for (const route of ["/leadgen-stats", "/leadgen-handoff-deals"]) {
    const body = handlerBody(DASH, route);
    assert.match(body, /\bleadgenHandoffMoney\(from, to, /, `🔴 ${route} не кличе спільну функцію ядра`);
    assert.doesNotMatch(body, /\b(aggregateHandoffMoney|handoffView|classifyHandoffs|pickHandoffs)\(/,
      `🔴 ${route} рахує підсумок САМ — список і число рядка розійдуться`);
  }
  assert.match(handlerBody(DASH, "/leadgen-stats"), /totals: handoffMoneyWire\(hm\.totals\)/);
  assert.match(handlerBody(DASH, "/leadgen-handoff-deals"), /totals: handoffMoneyWire\(hm\.totals\)/,
    "🔴 totals списку не з результату ядра");
  // 🪞 Дзеркало: детектор власного підсумку спрацьовує на підкинутому.
  assert.match("totals: aggregateHandoffMoney(hm.deals)", /\b(aggregateHandoffMoney|handoffView)\(/);
  assert.doesNotMatch("x = leadgenHandoffMoneyV2(from, to, s)", /\bleadgenHandoffMoney\(from, to, /,
    "🔴 межа слова не працює — перейменований двійник зарахувався б");
});

/**
 * #678 — ДОСТУП НОВИХ РОУТІВ РІВНО ЯК У `/leadgen-stats` (рішення власника 22.09.2026).
 *
 * Обидва боки: дозволені ролі ті самі, заборонені ті самі; вкладка — `leadgen`, прописана
 * ЯВНО (дефісного сусіда `pre()` не накриває, і роут без рядка лишився б без межі).
 * 🧨 САБОТАЖ: додати `"manager"` в allow рядка `/leadgen-trend` → червоніє.
 */
test("#678 ДОСТУП: нові роути — рядки матриці й вкладка як у /leadgen-stats", () => {
  const row = (p: string) => {
    const rs = ACCESS_MATRIX.filter((r) => r.method === "GET" && r.path === p);
    assert.equal(rs.length, 1, `🔴 рядок матриці для ${p}: ${rs.length} замість 1`);
    return rs[0];
  };
  const base = row("/api/dashboard/leadgen-stats");
  assert.ok(base.allow.includes("team_lead") && base.deny.includes("manager"), "еталон не той — порівнювати нема з чим");
  for (const p of ["/api/dashboard/leadgen-trend", "/api/dashboard/leadgen-handoff-deals"]) {
    const r = row(p);
    assert.deepEqual([...r.allow].sort(), [...base.allow].sort(), `🔴 ${p}: дозволені ролі не як у /leadgen-stats`);
    assert.deepEqual([...r.deny].sort(), [...base.deny].sort(), `🔴 ${p}: заборонені ролі не як у /leadgen-stats`);
    assert.equal(r.cls, "GET");
    assert.deepEqual(tabsForPath(p), ["leadgen"], `🔴 ${p} без вкладкової межі — дефісний сусід не накритий`);
  }
  // 🪞 Дзеркало: роут, якого не прописали, межі НЕ має — тобто перевірка вище не порожня.
  assert.equal(tabsForPath("/api/dashboard/leadgen-__nemaye"), null, "🔴 `pre()` накрив дефісного сусіда — перевірка беззуба");
});

/**
 * #678b — ПЕРШИЙ ОПЕРАТОР НОВОГО ОБРОБНИКА — ВІДМОВА МЕНЕДЖЕРУ (403 раніше за будь-який 400).
 * Інакше менеджер, що прийшов без параметрів, дізнавався б про існування й форму роуту з 400.
 * 🧨 САБОТАЖ: переставити `const auth = req.auth!;` вище перевірки → червоніє.
 */
test("#678b ПЕРШИЙ ОПЕРАТОР нового обробника — відмова менеджеру (403 раніше за 400)", () => {
  for (const route of ["/leadgen-trend", "/leadgen-handoff-deals"]) {
    const first = firstStatement(handlerBody(DASH, route));
    assert.match(first, MANAGER_FIRST, `🔴 ${route}: перший оператор — «${first}», а не відмова менеджеру`);
  }
  // 🪞 Дзеркало: детектор бачить неправильний порядок, а не зеленіє на все.
  const bad = 'dashboardRouter.get("/x", async (req, res) => {\n  // коментар\n  const to = dateParam(req.query.to);\n'
    + '  if (req.auth!.role === "manager") return res.status(403).json({});\n});';
  assert.doesNotMatch(firstStatement(bad), MANAGER_FIRST, "🔴 детектор першого оператора не бачить порядку");
});
