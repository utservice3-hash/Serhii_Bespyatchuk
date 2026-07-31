import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tabsForPath, hasTabBoundary } from "./routeTab.js";
import { MOUNTS } from "./routeInventory.js";
import {
  ROUTE_BOUNDARY_EXEMPTIONS, CORE_BYPASS_EXEMPTIONS, ROW_SPREAD_EXEMPTIONS,
  exemptionsWithoutReason,
} from "./gates.js";

/**
 * #17 — АРХІТЕКТУРНІ ВОРОТА. Правила, які раніше жили в промтах власника.
 *
 * Усі троє працюють БЕЗ БД і БЕЗ мережі: читають зібраний код. Це навмисно — ворота
 * мають спрацьовувати в кожному `npm test`, а не лише в прод-режимі. Скіп, який
 * ніколи не виконується, ми вже проходили на #8.
 */

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = path.join(DIST, "routes");

const routeFiles = () => readdirSync(ROUTES).filter((f) => f.endsWith(".js") && !f.includes(".test."));
/** Код без коментарів — інакше приклад у документації рахувався б порушенням. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ─────────────────────── B2 · межа обовʼязкова ───────────────────────

/** Оголошені роути з ЗІБРАНОГО коду + мапа монтування. Без БД — див. заголовок файлу. */
function declaredRoutes(): { method: string; path: string; suffix: string }[] {
  const out: { method: string; path: string; suffix: string }[] = [];
  for (const m of MOUNTS) {
    const f = path.join(ROUTES, m.module.replace("../routes/", ""));
    const src = strip(readFileSync(f, "utf8"));
    for (const d of src.matchAll(/\w+Router\.(get|post|put|delete|patch)\("([^"]+)"/g)) {
      const suffix = d[2] === "/" ? "" : d[2];
      out.push({ method: d[1].toUpperCase(), path: `${m.mount}${suffix}`, suffix: d[2] });
    }
  }
  return out;
}

test("#17 ВОРОТА · кожен роут має МЕЖУ (tab, право) або запис у реєстрі", () => {
  const routes = declaredRoutes();
  assert.ok(routes.length > 150,
    `розбір дав ${routes.length} роутів — він зламався, і ворота нічого не перевіряють`);

  // Perm-гейт шукаємо в ТІЛІ роута: від його оголошення до наступного.
  const permGated = new Set<string>();
  for (const f of routeFiles()) {
    const src = strip(readFileSync(path.join(ROUTES, f), "utf8"));
    const decls = [...src.matchAll(/\w+Router\.(get|post|put|delete|patch)\("([^"]+)"/g)];
    for (let i = 0; i < decls.length; i++) {
      const body = src.slice(decls[i].index, i + 1 < decls.length ? decls[i + 1].index : src.length);
      if (/requirePerm\(|roleHasPerm\(|roleHasPermStrict\(/.test(body)) {
        permGated.add(`${decls[i][1].toUpperCase()} ${decls[i][2]}`);
      }
    }
  }

  const exempt = new Set(ROUTE_BOUNDARY_EXEMPTIONS.map((e) => `${e.method} ${e.path}`));
  const naked: string[] = [];
  for (const r of routes) {
    if (hasTabBoundary(r.path)) continue;                    // межа = вкладка
    if (permGated.has(`${r.method} ${r.suffix}`)) continue;   // межа = право
    if (exempt.has(`${r.method} ${r.path}`)) continue;        // виняток, названий вголос
    naked.push(`${r.method} ${r.path}`);
  }

  assert.deepEqual(naked, [],
    "🔴 РОУТ БЕЗ ЯВНОЇ МЕЖІ. Дефолт «немає межі → дозволено» вже коштував нам інциденту: "
    + "три оглядові ендпоінти трималися лише на scope-клампі й відкрились HR, щойно роль "
    + "стала company. Постав ROUTE_TAB або requirePerm — або, якщо межі свідомо не буде, "
    + "додай рядок у ROUTE_BOUNDARY_EXEMPTIONS з ПРИЧИНОЮ:\n  " + naked.join("\n  "));
});

test("#17b ДЗЕРКАЛО: ворота межі ВМІЮТЬ спрацювати", () => {
  // Без цієї пари #17 зеленів би й тоді, якби детектор вважав межею геть усе.
  assert.equal(tabsForPath("/api/dashboard/__вигаданий_роут__"), null,
    "🔴 tabsForPath знаходить вкладку для неіснуючого шляху — детектор межі несправний");
  assert.ok(hasTabBoundary("/api/settings"), "детектор не бачить очевидної вкладки — він мертвий");
});

test("#17g ПОРЯДОК ПРЕФІКСІВ: специфічний шлях виграє в загального", () => {
  // 🔴 Перший збіг виграє, тож `kvp-report/manager-detail` мусить стояти ПЕРЕД
  // `kvp-report`. Помилишся порядком — роут тихо звузиться до однієї вкладки, і
  // тімлід зі «report» втратить екран, який бачив. Мовчки: коди 403, не 500.
  assert.deepEqual(tabsForPath("/api/dashboard/kvp-report/manager-detail"), ["kvp", "report"],
    "🔴 загальний префікс перехопив специфічний — переставляй рядки, а не права ролей");
  assert.deepEqual(tabsForPath("/api/dashboard/kvp-report"), ["kvp"]);
  // Дзеркало для дефіса: `pre()` матчить по слешу, тож сусід через дефіс — ІНШИЙ роут.
  // Саме це й давало «kvp-report виглядає покритим, а насправді ні».
  assert.deepEqual(tabsForPath("/api/dashboard/reactivation"), ["loyalty"]);
  assert.deepEqual(tabsForPath("/api/dashboard/reactivation-candidates"), ["tasks"],
    "🔴 дефісного сусіда накрив загальний префікс — значить `pre()` змінив семантику");
});

// ─────────────────────── B3 · метрика лише через ядро ───────────────────────

/** Ознаки грошової/стадійної метрики в сирому SQL. */
const METRIC_SQL = /\b(SUM|AVG)\s*\(\s*[a-z_.]*price|status_id\s*(=|IN)|closed_at\s+BETWEEN|'142'|\b142\b\s*\)/i;

test("#17c ВОРОТА · метрика мимо ядра не проходить", () => {
  const exempt = new Set(CORE_BYPASS_EXEMPTIONS.map((e) => e.file));
  const offenders: string[] = [];
  for (const f of routeFiles()) {
    const rel = `routes/${f.replace(/\.js$/, ".ts")}`;
    if (exempt.has(rel)) continue;
    const src = strip(readFileSync(path.join(ROUTES, f), "utf8"));
    if (METRIC_SQL.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "🔴 СИРИЙ SQL ІЗ ГРОШИМА/СТАДІЯМИ В РОУТІ. Гроші рахує ЛИШЕ core/money.ts: анкер по даті "
    + "входу в етап + дедуплікація 9∪10. Свій SQL обходить обидва правила, і розбіжність "
    + "спливає через місяці як «дашборд бреше». Клич ядро — або назви виняток у "
    + "CORE_BYPASS_EXEMPTIONS:\n  " + offenders.join("\n  "));
});

test("#17d ДЗЕРКАЛО: детектор метрик ловить справжній зразок", () => {
  assert.ok(METRIC_SQL.test("SELECT SUM(d.price) FROM deals WHERE status_id = 142"),
    "🔴 детектор не бачить очевидного грошового SQL — #17c зеленів би завжди");
  assert.ok(!METRIC_SQL.test("SELECT name FROM managers ORDER BY name"),
    "🔴 детектор спрацьовує на нешкідливому SQL — ворота стануть шумом");
});

// ─────────────────────── B4 · рядок БД не віддається спредом ───────────────────────

test("#17e ВОРОТА · у роутах немає `SELECT *`", () => {
  // 🔴 Це КОРІНЬ витоку реквізитів, а не спред: `{ ...a }` віддав усе лише тому, що
  // SELECT приніс усе. Там, де колонки названі поіменно, спред безпечний за побудовою.
  // Зараз у роутах `SELECT *` = 0 — ворота тримають цей стан на майбутнє.
  const offenders: string[] = [];
  for (const f of routeFiles()) {
    const src = strip(readFileSync(path.join(ROUTES, f), "utf8"));
    if (/SELECT\s+\*/i.test(src)) offenders.push(`routes/${f.replace(/\.js$/, ".ts")}`);
  }
  assert.deepEqual(offenders, [],
    "🔴 `SELECT *` У РОУТІ. Нова колонка в таблиці поїде у відповідь САМА, без правки "
    + "коду — саме так назовні вийшли IBAN і ключ-карта. Перелічуй колонки:\n  "
    + offenders.join("\n  "));
});

test("#17e2 ВОРОТА · спред обʼєкта у відповіді — лише з реєстру", () => {
  const offenders: string[] = [];
  for (const f of routeFiles()) {
    const rel = `routes/${f.replace(/\.js$/, ".ts")}`;
    const src = strip(readFileSync(path.join(ROUTES, f), "utf8"));
    for (const m of src.matchAll(/\{\s*\.\.\.\s*(\w+)[,\s}]/g)) {
      const frag = src.slice(Math.max(0, m.index - 70), m.index + 45).replace(/\s+/g, " ");
      const known = ROW_SPREAD_EXEMPTIONS.some((e) =>
        e.file === rel && frag.includes(e.frag.replace(/\s+/g, " ").slice(0, 16)));
      if (!known) offenders.push(`${rel}: …${frag.trim()}…`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    "🔴 НЕЗАРЕЄСТРОВАНИЙ СПРЕД. Кожен має бути названий: або це обчислений обʼєкт, або "
    + "рядок БД з ЯВНИМ SELECT. Додай рядок у ROW_SPREAD_EXEMPTIONS з причиною:\n  "
    + [...new Set(offenders)].join("\n  "));
});

test("#17f ДЗЕРКАЛО: жоден реєстр винятків не порожній на причину", () => {
  // Реєстр без причини — це «зробив зелено», а не рішення. Мертвий запис ще й глушив
  // би справжнє порушення, що випадково збіглося формою.
  assert.deepEqual(exemptionsWithoutReason(), [],
    "🔴 у реєстрі є виняток без причини — назви її або прибери запис");
  assert.ok(ROUTE_BOUNDARY_EXEMPTIONS.length + CORE_BYPASS_EXEMPTIONS.length
    + ROW_SPREAD_EXEMPTIONS.length > 0, "усі реєстри порожні — перевірка причин нічого не робить");
});
