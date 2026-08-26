import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tabsForPath, hasTabBoundary } from "./routeTab.js";
import { MOUNTS } from "./routeInventory.js";
import {
  ROUTE_BOUNDARY_EXEMPTIONS, CORE_BYPASS_EXEMPTIONS, ROW_SPREAD_EXEMPTIONS,
  CREATED_COHORT_EXEMPTIONS, CLIENT_KEY_WRITERS, classifySql, METRIC_SQL, exemptionsWithoutReason,
  KNOWN_SQL_DEBT, knownDebtFor, normSql,
} from "./gates.js";
import { lexTemplates, queryCallOffsets } from "./sqlLex.js";

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

/**
 * SQL-блоки файлу — ШАБЛОННІ ЛІТЕРАЛИ, розібрані сканером (`sqlLex.ts`).
 *
 * 🔴 Було `/`([^`]{20,8000})`/g`, і воно бачило 50 із 358 запитів. Регулярка не знає,
 * який бектик відкривальний: літерал із `${…}` вона ріже навпіл, а підстановки має
 * 386 із 659 літералів. Гірше — з 20 блоків, які `#17c` класифікував, ШІСТЬ не були
 * літералами взагалі (обрізки й чистий JS): ворота рахували керуючий потік як SQL.
 *
 * ⚠️ Сирий текст, БЕЗ `strip()`. Сканер знає, що таке коментар, сам — а `strip`
 * псував розбір (у `training.js` давав дві помилки синтаксису). Числа з ним і без
 * нього однакові до одиниці (заміряно 26.08.2026: 52 · 38 · 2 · 5 · 7).
 */
function sqlBlocks(src: string): { q: string; at: number }[] {
  return lexTemplates(src).blocks;
}
const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

test("#17c ВОРОТА · метрика мимо ядра не проходить", () => {
  const exempt = new Set(CORE_BYPASS_EXEMPTIONS.map((e) => e.file));
  const offenders: string[] = [];
  const unnamedCohorts: string[] = [];
  let scanned = 0, lifetime = 0, cohorts = 0, debt = 0;
  const unparsed: string[] = [];
  for (const f of routeFiles()) {
    const rel = `routes/${f.replace(/\.js$/, ".ts")}`;
    if (exempt.has(rel)) continue;
    const src = readFileSync(path.join(ROUTES, f), "utf8");
    // 🔴 СПЕРШУ «чи я взагалі розібрав», і лише потім «чи є порушення». Порожній
    // результат зламаного розбору читається як «порушень немає» — а це найгірша з
    // відповідей: ворота зеленіють саме тоді, коли осліпли.
    for (const u of lexTemplates(src).unterminated) unparsed.push(`${rel}:${lineOf(src, u.at)} — ${u.kind}`);
    for (const { q, at } of sqlBlocks(src)) {
      const cls = classifySql(q);
      if (!cls) continue;
      scanned++;
      if (cls === "lifetime") { lifetime++; continue; }
      const where = `${rel}:${lineOf(src, at)}`;
      // ВІДОМИЙ БОРГ — названий поіменно, з якорем і датою. Не дозвіл: чекає на власника.
      if (knownDebtFor(rel, q, cls)) { debt++; continue; }
      if (cls === "money-period") { offenders.push(`${where} — ${normSql(q).slice(0, 110)}`); continue; }
      // created-cohort: законно, але має бути НАЗВАНА
      const named = CREATED_COHORT_EXEMPTIONS.some((e) => e.file === rel && q.includes(e.frag));
      if (named) cohorts++;
      else unnamedCohorts.push(`${where} — ${normSql(q).slice(0, 110)}`);
    }
  }
  assert.deepEqual(unparsed, [],
    "🔴 НЕ ЗМІГ РОЗІБРАТИ. Сканер дійшов до кінця файла з незакритою конструкцією — отже "
    + "частина запитів у ньому НЕ перевірена, і зелений колір тут означав би «ми не дивились», "
    + "а не «порушень немає». Лагодь `sqlLex.ts` або джерело, але не читай цей файл як чистий:\n  "
    + unparsed.join("\n  "));
  assert.ok(scanned > 10, `детектор знайшов лише ${scanned} блоків — розбір зламався`);
  assert.equal(debt, KNOWN_SQL_DEBT.length,
    `🔴 РЕЄСТР БОРГУ РОЗІЙШОВСЯ З КОДОМ: у ньому ${KNOWN_SQL_DEBT.length} записів, а в коді `
    + `знайшлось ${debt}. Запис, під який більше немає порушення, глушив би справжнє — прибери його; `
    + "якщо ж порушень стало більше, вони мали б бути в offenders, а не тут.");
  assert.deepEqual(offenders, [],
    "🔴 ГРОШІ ЗА ПЕРІОД ПОВЗ ЯДРО. У запиті є фільтр по ГРОШОВОМУ анкері (closed_at/"
    + "changed_at) і сума/стадія — отже це метрика проміжку, а її рахує ЛИШЕ core/money.ts "
    + "(анкер по даті входу + дедуп 9∪10). Свій SQL обходить обидва правила, і розбіжність "
    + "спливає через місяці як «дашборд бреше». Якщо це НОВЕ місце — переписуй на ядро; якщо "
    + "старе, якого ще ніхто не чіпав, — рядок у KNOWN_SQL_DEBT із якорем, роутом і причиною "
    + "(це БОРГ, а не дозвіл):\n  " + offenders.join("\n  "));
  assert.deepEqual(unnamedCohorts, [],
    "🔴 НЕНАЗВАНА КОГОРТА СТВОРЕННЯ. Фільтр періоду тут по `created_at` — це законно "
    + "(«скільки завели»), але саме в такому запиті колись і сховався грошовий анкер: "
    + "«Історія за 3 місяці» рахувала виручку по місяцю СТВОРЕННЯ і давала −27% у "
    + "поточному місяці. Тому кожна когорта має бути названа в CREATED_COHORT_EXEMPTIONS "
    + "з причиною:\n  " + unnamedCohorts.join("\n  "));
  assert.ok(lifetime + cohorts > 0,
    "жоден блок не класифіковано як законний — детектор, схоже, нічого не бачить");
});

test("#17d ДЗЕРКАЛО: детектор РОЗРІЗНЯЄ три класи, а не червоніє на все", () => {
  // Без цієї пари #17c зеленів би й тоді, коли класифікатор вважає геть усе законним —
  // або, навпаки, став би параноїком і його б вимкнули через тиждень.
  assert.equal(classifySql("SELECT name FROM managers ORDER BY name"), null,
    "🔴 нешкідливий SQL позначено як грошовий — ворота стануть шумом");
  assert.equal(
    classifySql("SELECT SUM(d.price) FROM deals d WHERE d.status_id = 142 AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2"),
    "money-period", "🔴 гроші за період по closed_at не впізнані — #17c пропустив би саме те, що ловить");
  assert.equal(
    classifySql("SELECT date_trunc('month', d.created_at_kommo) m, COUNT(*) FILTER (WHERE d.status_id = 142) FROM deals d"),
    "created-cohort", "🔴 когорта створення не впізнана — вона мовчки поїхала б у money-period");
  assert.equal(
    // Реальна форма з коду: `status_id` тут — умова JOIN до мапи стадій, а не фільтр
    // періоду. Саме такі 16 блоків і тримали весь `dashboard.ts` у винятку.
    classifySql("SELECT DISTINCT d.client_key FROM deals d JOIN pipeline_stage_map psm"
      + " ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id WHERE psm.funnel_stage = 'paid'"),
    "lifetime", "🔴 lifetime-предикат прийнято за метрику — ворота почервоніли б на сегментах");
  assert.ok(METRIC_SQL.test("SELECT SUM(d.price) FROM deals WHERE status_id = 142"),
    "🔴 базова грошова ознака не спрацьовує — класифікувати немає чого");
});

/**
 * Чи ПИШЕ цей SQL-блок у `deals.client_key`. Дивимось у МЕЖАХ ОДНОГО блоку —
 * перша версія брала вікно в 400 символів по файлу й перестрибувала з `UPDATE deals`
 * на `client_key =` СУСІДНЬОГО запиту (`UPDATE receivables …`). Хибне спрацювання
 * на чесному файлі гірше за пропуск: його швидко навчаться глушити.
 */
export function writesDealsClientKey(q: string): boolean {
  const isDeals = /UPDATE\s+deals\b|INSERT\s+INTO\s+deals\s*\(/i.test(q);
  if (!isDeals) return false;
  // `client_key_raw` — саме те, що ми ВИМАГАЄМО писати, тож воно не порушення.
  // `\b` між `client_key` і `_raw` немає (підкреслення — символ слова), але
  // прибираємо явно, щоб намір читався без знання регулярок.
  const withoutRaw = q.replace(/client_key_raw/gi, "«raw»");
  return /\bclient_key\s*=/.test(withoutRaw)
      || /INSERT\s+INTO\s+deals\s*\([^)]*\bclient_key\b/i.test(withoutRaw);
}

test("#17h ВОРОТА · у deals.client_key пише лише перерахунок", () => {
  // 🔴 Канонічний ключ — ПОХІДНА від `client_key_raw` + реєстру псевдонімів. Запис
  // сирого значення напряму в `client_key` мовчки скасовує аліас для цієї угоди —
  // і саме для тих угод, які синк оновлює найчастіше.
  const SRC = path.resolve(DIST, "..", "src");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) files.push(p);
    }
  };
  walk(SRC);
  const allowed = new Set(CLIENT_KEY_WRITERS.map((w) => w.file));
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of files) {
    const rel = f.slice(SRC.length + 1).replace(/\\/g, "/");
    const src = readFileSync(f, "utf8");   // сире: сканер сам знає коментарі
    for (const { q } of sqlBlocks(src)) {
      if (!writesDealsClientKey(q)) continue;
      scanned++;
      if (allowed.has(rel)) continue;
      offenders.push(`${rel} — ${q.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  assert.ok(scanned > 0,
    "жодного запису в deals.client_key не знайдено — детектор осліп, а не код чистий");
  assert.deepEqual(offenders, [],
    "🔴 ЗАПИС У deals.client_key ПОВЗ ПЕРЕРАХУНОК. Канонічний ключ — похідна від "
    + "`client_key_raw` і реєстру псевдонімів; пряме присвоєння мовчки скасує аліас "
    + "для цих угод. Пиши в `client_key_raw`, а канонічний лиши джобі "
    + "`recomputeClientKeys` — або назви місце в CLIENT_KEY_WRITERS з причиною:\n  "
    + offenders.join("\n  "));
});

test("#17i ДЗЕРКАЛО: детектор запису в client_key ВМІЄ спрацювати", () => {
  // Без пари #17h зеленів би й тоді, коли детектор не бачить узагалі нічого.
  assert.ok(writesDealsClientKey("UPDATE deals SET client_name = $2, client_key = $3 WHERE kommo_id = $1"),
    "🔴 не бачить прямого UPDATE — ворота були б декорацією");
  assert.ok(writesDealsClientKey("INSERT INTO deals (kommo_id, client_key) VALUES ($1,$2)"),
    "🔴 не бачить INSERT зі стовпцем client_key");
  assert.ok(!writesDealsClientKey("SELECT client_key FROM deals WHERE manager_id = $1"),
    "🔴 спрацьовує на ЧИТАННІ — ворота почервоніли б на ~359 законних місцях");
  assert.ok(!writesDealsClientKey("UPDATE deals SET client_key_raw = $3 WHERE kommo_id = $1"),
    "🔴 спрацьовує на записі в RAW — а це саме те, що ми вимагаємо робити");
  // 🔴 Регресія, яку я сам і зробив: вікно по файлу перестрибувало з `UPDATE deals`
  // на `client_key =` СУСІДНЬОГО запиту по іншій таблиці.
  assert.ok(!writesDealsClientKey("UPDATE deals SET client_key_raw = replace(client_key_raw,' ','')"),
    "🔴 нормалізація сирого ключа прийнята за запис канонічного");
  assert.ok(CLIENT_KEY_WRITERS.length >= 1, "реєстр дозволених порожній — перевірка нічого не робить");
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
    + ROW_SPREAD_EXEMPTIONS.length + CREATED_COHORT_EXEMPTIONS.length > 0,
    "усі реєстри порожні — перевірка причин нічого не робить");
  // Дзеркало до дзеркала: перевірка мусить УМІТИ побачити порожню причину. Інакше
  // «0 записів без причини» означало б лише «ми туди не дивимось» — той самий
  // хибно-зелений, що й скіп, який ніколи не виконувався.
  assert.deepEqual(
    [{ file: "x", frag: "y", why: "  " }].filter((e) => !e.why.trim()).map((e) => e.file),
    ["x"], "🔴 детектор порожньої причини не працює");
});
