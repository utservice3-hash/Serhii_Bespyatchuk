import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MOUNTS } from "./routeInventory.js";
import { ACCESS_MATRIX } from "./accessMatrix.js";

/**
 * 🗺 #280–#280b — КОЖЕН ОГОЛОШЕНИЙ РОУТ Є У ЗЛІПКУ ДОСТУПУ.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ 01.09.2026. Я прибрав рядок роута з `ACCESS_MATRIX` і прогнав
 * швидкий набір: **усі 14 гейтів лишились зеленими**. `#17` цього не бачить — він дивиться
 * в ІНШИЙ реєстр (`ROUTE_BOUNDARY_EXEMPTIONS`); `#11` бачить, але лише в режимі
 * `test:matrix`, який на кожен деплой не ганяють. Тобто наша віра «зникнення рядка матриці
 * хтось спіймає» трималась на одному щасливому випадку, а не на механізмі.
 *
 * 🔴 І ДІРА БУЛА НЕ ГІПОТЕТИЧНОЮ. Перший же прогін цього гейта показав, що трьох роутів —
 * `/api/auth/tracker-sso`, `/api/auth/tracker-assertion`, `/api/auth/tracker-identity` —
 * у матриці НЕМАЄ ВЗАГАЛІ, і вони вже викочені в прод. Їх додано тим самим комітом.
 *
 * ⚠️ ЧОМУ САМЕ ПОКРИТТЯ, А НЕ ЗМІСТ. Що написано в рядку (які ролі дозволені) — предмет
 * `#11`, і перевірити це без живого API не можна. А от ЧИ Є рядок — структурний факт,
 * і він мусить перевірятись у швидкому наборі, бо саме він зникає мовчки.
 */

/**
 * ⚠️ Читаємо ЗІБРАНІ `dist/routes/*.js`, а не джерело. Гейт біжить із `dist`, і саме там
 * лежить те, що справді монтує `index.js`; спроба читати `src/*.ts` дала 0 роутів —
 * спіймала це перевірка на порожній скоуп, а не уважність (02.09.2026).
 */
const ROUTES_DIR = path.resolve(import.meta.dirname, "..", "routes");
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Усі роути, оголошені в модулях, які index.ts справді монтує. */
export function declaredRoutes(): string[] {
  const out: string[] = [];
  for (const m of MOUNTS) {
    const file = path.join(ROUTES_DIR, m.module.replace("../routes/", ""));
    let src: string;
    try { src = strip(readFileSync(file, "utf8")); } catch { continue; }
    for (const d of src.matchAll(/\w+Router\.(get|post|put|delete|patch)\("([^"]+)"/g)) {
      const suffix = d[2] === "/" ? "" : d[2];
      out.push(`${d[1].toUpperCase()} ${m.mount}${suffix}`);
    }
  }
  return [...new Set(out)];
}

/** Ключі зліпка. Query-рядок відрізаємо: він частина ПРОБИ, а не адреси роута. */
export function matrixKeys(rows: readonly { method: string; path: string }[]): Set<string> {
  return new Set(rows.map((r) => `${r.method} ${r.path.split("?")[0]}`));
}

/**
 * 🔴 ПОРІВНЯННЯ — ОДНА ФУНКЦІЯ НА ОБИДВА ГЕЙТИ, І ЦЕ НЕ ОХАЙНІСТЬ.
 * Перша редакція дзеркала рахувала різницю СВОЄЮ копією `routes.filter(...)`. Саботаж
 * 02.09.2026 осліпив предикат у `#280` — і **обидва лишились зеленими**: дзеркало
 * доводило лише те, що два вирази, написані поруч, дають однакове. Клас `#214c`.
 * Тепер ліворуч у обох стоїть ОДИН виклик, тож осліплення червонить саме дзеркало.
 */
export function uncovered(routes: readonly string[], covered: ReadonlySet<string>): string[] {
  return routes.filter((r) => !covered.has(r)).sort();
}

test("#280 кожен оголошений роут має рядок у ACCESS_MATRIX", () => {
  const routes = declaredRoutes();
  // Порожній скоуп = ПРОВАЛ: без цього «нуль непокритих» зійшовся б на порожньому переліку.
  assert.ok(routes.length > 150,
    `🔴 розбір дав ${routes.length} роутів — він зламався, і гейт нічого не перевіряє`);

  const covered = matrixKeys(ACCESS_MATRIX);
  const missing = uncovered(routes, covered);
  // Твердження і текст — з ОДНОГО набору (урок S1 від 31.08.2026).
  assert.deepEqual(missing, [],
    `🔴 роути є, а рядка у зліпку доступу НЕМАЄ: ${missing.join(", ")}.\n`
    + "   Зникнення рядка не ловить ні #17 (він дивиться в ROUTE_BOUNDARY_EXEMPTIONS), ні\n"
    + "   швидкий набір: #11 працює лише в test:matrix. Саме так три роути SSO трекера\n"
    + "   поїхали в прод узагалі без запису у зліпку.");
});

test("#280b 🪞 ДЗЕРКАЛО: гейт ловить ПІДКИНУТЕ зникнення, а на цілому зліпку мовчить", () => {
  const routes = declaredRoutes();
  const full = matrixKeys(ACCESS_MATRIX);

  // На цілому — порожньо. Інакше гейт червонів би завжди й його почали б гортати очима.
  assert.deepEqual(uncovered(routes, full), [], "🔴 на цілому зліпку гейт мусить мовчати");

  // Приберемо ОДИН реальний рядок — гейт мусить назвати саме його, і лише його.
  const victim = routes[0];
  const holed = new Set(full); holed.delete(victim);
  assert.deepEqual(uncovered(routes, holed), [victim],
    "🔴 підкинуте зникнення не спіймано або спіймано не те — предикат не розрізняє покриття");

  // І навпаки: зайвий рядок у зліпку гейт НЕ вважає порушенням (мертві записи ловить #19h).
  const extra = matrixKeys([...ACCESS_MATRIX, { method: "GET", path: "/api/НЕМАЄ" }]);
  assert.deepEqual(uncovered(routes, extra), [],
    "🔴 зайвий рядок зробив гейт червоним — це не його предмет");
});
