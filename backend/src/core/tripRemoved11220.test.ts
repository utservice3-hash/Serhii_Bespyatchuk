import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { lastOrderDate, colorOf, daysBetween } from "./clientLeadRules.js";
import { inReact } from "./reactCycleRules.js";

/**
 * 🧾 «ПОЇЗДКУ ПОЗА CRM» ПРИБРАНО ПОВНІСТЮ (задача 11220; рішення зустрічі по дашборду 25.11.2026 — Сергій, Юля, Саша,
 * Роман). Функція 9045 (тімлід підтверджує поїздку, якої немає в Kommo, і клієнт зеленіє) знята: замовлення — лише те,
 * що є в CRM (рахунок або оплата). Гейти `#9045*` зняті записом у `RETIRED_GATES`; тут — що стоїть на їх місці.
 * Таблиця `client_trip_confirms` лишається історією поданого: код її не читає і не пише.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * #11220 🪞 — ЗАМОВЛЕННЯ = СВІЖІШЕ З ОПЛАТИ Й РАХУНКУ, І БІЛЬШЕ НІЧОГО. Епізодичний (ритм 60 дн.): оплата 109 днів тому —
 * жовтий; свіжий рахунок робить зеленим; рахунок 62 дні тому — знову жовтий; 59 — зелений. Третього аргументу правило
 * не має: передана «поїздка» дату не рухає.
 * 🧨 Червоніє, якщо `lastOrderDate` знову читатиме третю дату або перестане читати рахунок чи оплату.
 */
test("#11220 🪞 ЗАМОВЛЕННЯ — ЛИШЕ З CRM: колір від оплати й рахунку в обидва боки; третьої дати правило не приймає", () => {
  const today = "2026-11-18", paid = "2026-08-01";
  const color = (inv: string | null) => {
    const d = lastOrderDate(paid, inv);
    return colorOf("episodic", d ? daysBetween(d, today) : null);
  };
  assert.equal(color("2026-07-25"), "yellow", "фікстура: оплата 109 днів тому, рахунок ще давніший — жовтий");
  assert.equal(color("2026-11-05"), "green", "🔴 свіжий рахунок не зробив клієнта зеленим");
  assert.equal(color("2026-09-17"), "yellow", "🔴 рахунок поза ритмом (62 дн.) лишив клієнта зеленим");
  assert.equal(color("2026-09-20"), "green", "рахунок у межах ритму (59 дн.) — зелений");
  assert.equal(lastOrderDate(paid, null), paid, "🔴 без рахунку дата замовлення — не оплата");
  assert.equal(lastOrderDate(null, "2026-07-25"), "2026-07-25", "🔴 без оплати дата замовлення — не рахунок");
  assert.equal(lastOrderDate(null, null), null, "🔴 без жодної дати зʼявилась дата замовлення");
  assert.equal(lastOrderDate("2026-08-01T10:00:00Z", "2026-07-25"), paid, "дата з часом — по дню");
  // 🧾 Те, заради чого гейт: третя дата (колишня «поїздка») більше нічого не рухає.
  const anyArgs = lastOrderDate as unknown as (...a: (string | null)[]) => string | null;
  assert.equal(lastOrderDate.length, 2, "🔴 у правила знову три аргументи — повернулась третя дата замовлення");
  assert.equal(anyArgs(paid, "2026-07-25", "2026-11-05"), paid, "🔴 третя дата знову рахується замовленням («поїздка поза CRM» повернулась)");
  // 🔁 Цикл реактивації читає рахунок: рахунок 25.07 → у листопаді клієнт у вкладці, свіжий рахунок знімає.
  assert.equal(inReact("2026-07-25", "2026-11"), true, "фікстура: давній рахунок — клієнт у реактивації");
  assert.equal(inReact("2026-11-05", "2026-11"), false, "🔴 свіжий рахунок не зняв клієнта з реактивації");
});

/**
 * #11220b — ПРОВОДКА ПРИБИРАННЯ: модуля, роутів, записів матриці й вкладки, кнопки й типів на фронті немає; а колір,
 * «Проблемний» і цикл (список, картка, нічний добір) читають рахунок з ядра грошей — парне твердження «а де воно ТЕПЕР».
 * 🧨 Червоніє, якщо будь-який шматок 9045 повернеться, або разом із поїздкою з кольору чи циклу випаде рахунок.
 */
test("#11220b «ПОЇЗДКУ ПОЗА CRM» ПРИБРАНО ВСЮДИ: роути, матриця, вкладка, джоба, фронт; колір і цикл читають рахунок", () => {
  assert.equal(existsSync(path.join(ROOT, "backend/src/core/clientTripConfirm.ts")), false, "🔴 модуль поїздки поза CRM повернувся");
  const dashRaw = read("backend/src/routes/dashboard.ts");
  const dash = codeOnly(dashRaw);
  assert.ok(dash.includes('dashboardRouter.get("/client-plans"') && dash.includes('dashboardRouter.get("/client-card"'),
    "🔴 перевіряти нічого: роутів списку й картки у файлі немає");
  assert.doesNotMatch(dash, /client-trip-confirm|clientTripConfirm|tripsFor\(|reactInvoiceDate\(|canConfirmTrip|tripDayOf|cardTripDay/,
    "🔴 у роутах лишився шматок «поїздки поза CRM»");
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'), dash.indexOf('dashboardRouter.post("/client-plans/submit"'));
  assert.equal((plans.match(/clientLeadRules\.lastOrderDate\(c\.last_paid, lastInvByKey\.get\(c\.client_key\) \?\? null\)/g) ?? []).length, 2,
    "🔴 колір і «Проблемний» у списку не від оплати й рахунку (два виклики з двома аргументами)");
  assert.match(plans, /const reactInv = \(key: string\) => lastInvByKey\.get\(key\) \?\? null;/, "🔴 цикл у списку читає не останній рахунок");
  assert.match(plans, /reactCycleRules\.inReact\(reactInv\(key\), nowYm\)/, "🔴 вкладка «Реактивація» не від рахунку");
  assert.match(plans, /money\.lastInvoiceByClientKey\(clientKeys\)/, "🔴 дата рахунку в списку не з ядра грошей");
  const card = dash.slice(dash.indexOf('dashboardRouter.get("/client-card"'));
  assert.match(card, /lastOrderDate\(h\?\.last_paid \?\? null, cardLastInv\)/, "🔴 картка: «Проблемний» не від оплати й рахунку");
  assert.match(card, /const cardReactInv = cardLastInvoice;/, "🔴 картка: цикл читає не останній рахунок");
  const sweep = codeOnly(read("backend/src/jobs/reactCycleSweep.ts"));
  assert.doesNotMatch(sweep, /clientTripConfirm|tripsFor|reactInvoiceDate/, "🔴 нічний добір знову читає поїздки");
  assert.match(sweep, /lastInvoice: inv\.get\(r\.client_key\) \?\? null,/, "🔴 нічний добір реактивації читає не останній рахунок");

  const mx = read("backend/src/auth/accessMatrix.ts");
  assert.match(mx, /path: "\/api\/dashboard\/client-problem", cls: "deny-only"/, "🔴 перевіряти нічого: сусіднього запису матриці немає");
  assert.doesNotMatch(mx, /client-trip-confirm/, "🔴 у матриці доступу лишився роут, якого немає");
  const tabs = read("backend/src/auth/routeTab.ts");
  assert.match(tabs, /pre\("\/api\/dashboard\/client-problem"\), tabs: \["loyalty"\]/, "🔴 перевіряти нічого: сусідньої межі вкладки немає");
  assert.doesNotMatch(tabs, /client-trip-confirm/, "🔴 межа вкладки для роуту, якого немає");
  assert.doesNotMatch(read("backend/src/testRunGate.ts"), /#9045/, "🔴 дозвіл на скіп гейта, якого більше немає");
  for (const f of ["backend/src/core/money.ts", "backend/src/core/metrics.ts"]) {
    assert.doesNotMatch(read(f), /client_trip_confirms|clientTripConfirm/, `🔴 поїздка поза CRM у грошах (${f})`);
  }
  // 🗄 Таблиця лишається історією — CREATE на місці, але жоден файл коду її не називає.
  assert.match(read("backend/src/db/schema.sql"), /CREATE TABLE IF NOT EXISTS client_trip_confirms \(/, "🔴 таблицю історії прибрано зі схеми");
  assert.doesNotMatch(dashRaw.replace(/\/\/.*$/gm, ""), /client_trip_confirms/, "🔴 роути знову читають таблицю поїздок");

  const feRaw = read("frontend/src/pages/dashboard/sections/ClientLeadSection.tsx");
  const fe = codeOnly(feRaw);
  assert.match(fe, /не замовляв \$\{L\.orderDays\} дн\./, "🔴 перевіряти нічого: клітинки «Замовлення» у файлі немає");
  assert.doesNotMatch(fe, /TripBox|confirmClientTrip|clearClientTrip|canConfirmTrip|lead\.trip/, "🔴 на «З ким говорити» лишилась кнопка чи позначка поїздки");
  assert.doesNotMatch(feRaw, /поза CRM/, "🔴 на екрані лишився текст про поїздку поза CRM");
  const api = codeOnly(read("frontend/src/api.ts"));
  assert.doesNotMatch(api, /client-trip-confirm|TripConfirm|canConfirmTrip/, "🔴 у клієнті API лишились типи чи виклики поїздки");
});
