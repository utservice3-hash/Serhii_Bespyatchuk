import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseInvoices, parsePayments, parseNoDeal } from "./dealLedger.js";
import { noDealTotals, NO_DEAL_ROWS_SQL, NO_DEAL_UNPAID_SQL } from "./securityNoDeal.js";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import { tabsForPath } from "../auth/routeTab.js";

/**
 * 🛡 «БЕЗПЕКА» · ОПЕРАЦІЇ 1С БЕЗ УГОДИ (задача 11231; Роман 27.11.2026: «давай додамо вкладку безпека тільки для адмінів і оп
 * дира, де будемо це рахувати»). Гейти `#11247`–`#11249` тут, живий SQL (`#11250`, `#11251`) — у `dealLedger.test.ts`,
 * бо порожній кластер уже піднімає той файл. Назви контрагентів у фікстурах вигадані: репозиторій публічний.
 */
const SRC = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");
const FE = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url)), "utf8");

/**
 * #11247 — РЯДОК ІЗ СУМОЮ ЙДЕ АБО В УГОДИ, АБО У «БЕЗ УГОДИ», і ніколи в обидва; рядок без суми — нікуди. Поле «угода» у
 * «без угоди» буває трьох видів (порожнє, текст, число іншої довжини) — усі три мусять дійти до екрана, з тим, що там стоїть.
 * 🧨 Червоніє, якщо «без угоди» бере лише порожнє поле (число іншої довжини зникає, як зникало до 27.11.2026), якщо рядок з
 * угодою потрапляє в обидва списки, чи якщо загубити коментар, за яким документ шукають у 1С.
 */
test("#11247 РОЗБІР «БЕЗ УГОДИ»: рядок із сумою йде або в угоди, або у «без угоди», ніколи в обидва; без суми — нікуди", () => {
  const rows = [
    { Number: "0001", Organization: "О1", Kontragent: "ТОВ Приклад", Data: "05.03.2026 0:00:00", Sum: "12 500,5", Currency: "грн", Deal: "62700001" },
    { Number: "0002", Organization: "О1", Kontragent: "ТОВ Приклад", Data: "06.03.2026 0:00:00", Sum: 4000, Currency: "грн", Deal: "" },
    { Number: "0003", Organization: "О2", Kontragent: "", Data: "07.03.2026 0:00:00", Sum: 950, Currency: "EUR", Deal: "1234567", Koment: " без договору " },
    { Number: "0004", Organization: "О2", Kontragent: "ФОП Зразок", Data: "01.01.2001 0:00:00", Sum: 300, Deal: "уточнити", ERPOU: "00000000", Manager: "Менеджер" },
    { Number: "0005", Organization: "О2", Kontragent: "ФОП Зразок", Data: "08.03.2026", Sum: "", Deal: "" },
  ];
  for (const [kind, withDeal] of [["invoice", parseInvoices(rows)], ["payment", parsePayments(rows)]] as const) {
    const no = parseNoDeal(kind, rows);
    assert.deepEqual(withDeal.map((x) => x.deal), [62700001], `🔴 ${kind}: у «з угодою» не той склад`);
    assert.deepEqual(no.map((x) => x.number), ["0002", "0003", "0004"], `🔴 ${kind}: рядок без 8-значної угоди зник або зайвий у «без угоди»`);
    assert.equal(withDeal.length + no.length, rows.length - 1, `🔴 ${kind}: рядок із сумою не потрапив нікуди або потрапив двічі`);
    assert.ok(no.every((x) => x.kind === kind), `🔴 ${kind}: вид документа переплутано`);
    assert.deepEqual(no.map((x) => x.dealRaw), ["", "1234567", "уточнити"], `🔴 ${kind}: не видно, що саме стоїть у полі «угода»`);
  }
  const [, fx, odd] = parseNoDeal("payment", rows);
  assert.deepEqual([fx.kontragent, fx.currency, fx.sum, fx.docOn, fx.comment], ["", "EUR", 950, "2026-03-07", "без договору"], "🔴 валютний рядок без назви контрагента");
  assert.deepEqual([odd.docOn, odd.edrpou, odd.manager, odd.currency], [null, "00000000", "Менеджер", "грн"], "🔴 сентинел дати 1С прочитано як дату або загублено код");
  // номер документа оплати — з `ID`, коли `Number` немає (так віддає `paydata`)
  assert.equal(parseNoDeal("payment", [{ ID: "000004512", Sum: 1, Deal: "" }])[0].number, "000004512", "🔴 номер оплати не взято з ID");
});

/**
 * #11248 — ПІДСУМОК ПЛИТКИ = СУМА РЯДКІВ СПИСКУ. Гривня — лише гривневі рядки; валюта стоїть окремим рядком зі своєю сумою
 * й кількістю і в гривню не додається; документи без назви контрагента — окремим числом (їх на проді 199 із 322 оплат).
 * 🧨 Червоніє, якщо додати валютний рядок у гривневу суму, загубити його з кількості документів чи порахувати порожню
 * назву як окремого контрагента.
 */
test("#11248 ПІДСУМОК ПЛИТКИ = СУМА РЯДКІВ: валюта окремо й у гривню не йде, документи без назви контрагента — окремим числом", () => {
  const docs = [
    { kontragent: "ТОВ Приклад", sum: 1000.4, currency: "грн" }, { kontragent: "ТОВ Приклад ", sum: 500.2, currency: "UAH" },
    { kontragent: "", sum: 300, currency: "" }, { kontragent: "  ", sum: 200, currency: "грн" },
    { kontragent: "ФОП Зразок", sum: 950, currency: "EUR" }, { kontragent: "", sum: 50, currency: "EUR" }, { kontragent: "ФОП Зразок", sum: 20, currency: "USD" },
  ];
  const t = noDealTotals(docs);
  assert.equal(t.docs, docs.length, "🔴 кількість документів не дорівнює кількості рядків (валютні чи безіменні загублено)");
  assert.equal(t.uah, 2000.6, "🔴 гривнева сума: у неї потрапила валюта або загубився гривневий рядок");
  assert.deepEqual(t.fx, [{ currency: "EUR", sum: 1000, docs: 2 }, { currency: "USD", sum: 20, docs: 1 }], "🔴 валюта не окремо за видами");
  assert.deepEqual(t.unnamed, { docs: 3, uah: 500 }, "🔴 документи без назви контрагента: кількість усіх, гривня лише гривневих");
  assert.equal(t.kontragents, 2, "🔴 порожня назва порахована контрагентом або одна назва двічі");
  assert.deepEqual(noDealTotals([]), { docs: 0, uah: 0, fx: [], kontragents: 0, unnamed: { docs: 0, uah: 0 } }, "🔴 порожній список — не нулі");
  // проводка: сервер рахує підсумок із ТИХ САМИХ рядків, що віддає списком, а не окремим запитом суми
  const core = SRC("core/securityNoDeal.ts");
  assert.match(core, /const block = \(docs: NoDealDoc\[\]\): NoDealBlock => \(\{ totals: noDealTotals\(docs\), docs \}\);/, "🔴 підсумок і список більше не з одних рядків");
  assert.doesNotMatch(core.replace(/\/\*[\s\S]*?\*\//g, ""), /\bSUM\s*\(/i, "🔴 у ядрі зʼявився окремий SQL-підсумок: плитка й список можуть розійтись");
  assert.match(NO_DEAL_UNPAID_SQL, /FROM onec_unpaid_invoices WHERE deal_id IS NULL\b/, "🔴 неоплачені рахунки беруться не лише без угоди");
  assert.match(NO_DEAL_ROWS_SQL, /FROM onec_no_deal_rows\b(?!_)/, "🔴 реалізації й оплати беруться не зі знімка");
});

/**
 * #11249 — «БЕЗПЕКУ» БАЧАТЬ ЛИШЕ АДМІНІСТРАТОР І ОПЕРАЦІЙНИЙ ДИРЕКТОР (рішення Романа 27.11.2026). Чотири ланки: сид вкладки
 * двом ролям; зняття в гендиректора, КВП і фінансиста ПІСЛЯ останнього синку «екрани = екрани адміна» (інакше другий прогін
 * схеми роздасть вкладку всім трьом); межа роута = вкладка `security`; рядок зліпка — дозвіл рівно двом і відмова решті.
 * Дзеркало: дозвіл не порожній — «закрито всім» теж зеленіло б на самій лише відмові.
 * 🧨 Червоніє, якщо додати роль у сид без рішення, прибрати зняття чи поставити його перед синком, зняти межу роута,
 * розширити `allow` у зліпку або прибрати пункт меню чи екран.
 */
test("#11249 «БЕЗПЕКА» ЛИШЕ АДМІНУ Й ОД: сид двом ролям, зняття після синків екранів, межа роута, зліпок і екран проведені", () => {
  const schema = SRC("db/schema.sql");
  const seed = /UPDATE roles SET screen_access = screen_access \|\| '\{"security":true\}'::jsonb\n\s+WHERE key IN \(([^)]*)\)\n\s+AND NOT \(screen_access \? 'security'\);/.exec(schema);
  assert.ok(seed, "🔴 сиду вкладки security у схемі немає: екрана не побачить ніхто");
  assert.deepEqual(seed[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort(), ["admin", "opdir"], "🔴 вкладку security отримує не той склад ролей");
  assert.equal([...schema.matchAll(/"security":\s*true/g)].length, 1, "🔴 вкладку security видають ще десь у схемі");
  const strip = schema.indexOf("UPDATE roles SET screen_access = screen_access - 'security'\n WHERE key IN ('ceo', 'kvp', 'financier');");
  const lastSync = schema.lastIndexOf("screen_access = (SELECT screen_access FROM roles WHERE key='admin')");
  assert.ok(lastSync > 0, "🔴 синків «екрани = екрани адміна» у схемі немає: гейт міряє не те");
  assert.ok(strip > 0, "🔴 зняття security у гендиректора, КВП і фінансиста немає: другий прогін схеми роздасть їм вкладку");
  assert.ok(strip > lastSync, "🔴 зняття стоїть ПЕРЕД синком екранів: синк перекриє його тим самим прогоном");
  assert.ok(strip > seed.index, "🔴 зняття стоїть перед сидом");

  assert.deepEqual(tabsForPath("/api/dashboard/security/no-deal"), ["security"], "🔴 роут «Безпеки» без межі вкладки security");
  const row = ACCESS_MATRIX.filter((r) => r.path.startsWith("/api/dashboard/security"));
  assert.equal(row.length, 1, "🔴 у зліпку не рівно один роут «Безпеки»: новий роут без рядка або рядок зник");
  assert.deepEqual([row[0].method, row[0].cls, [...row[0].allow].sort()], ["GET", "GET", ["admin", "opdir"]], "🔴 зліпок: дозвіл не рівно адміну й ОД");
  assert.deepEqual([...row[0].deny].sort(), ["ceo", "financier", "hr", "kvp", "manager", "team_lead"], "🔴 зліпок: відмова не всім іншим ролям");

  const route = SRC("routes/dashboard.ts");
  const body = route.slice(route.indexOf('dashboardRouter.get("/security/no-deal"'));
  assert.match(body, /res\.json\(await loadNoDeal\(pool as unknown as LedgerDb\)\);/, "🔴 роут не віддає звіт ядра");
  assert.match(FE("components/Layout.tsx"), /\{ key: "security", label: "Безпека", icon: "🛡", roles: \["admin"\] \}/, "🔴 пункту меню «Безпека» немає");
  assert.match(FE("pages/Dashboard.tsx"), /\{section === "security" && <SecuritySection \/>\}/, "🔴 екран «Безпека» не підключено");
  const screen = FE("pages/dashboard/sections/SecuritySection.tsx");
  assert.match(screen, /data\.lists\[l\.key\]\.totals/, "🔴 плитка бере число не з підсумку сервера");
  assert.match(screen, /Порожньо зараз не означає, що таких документів немає/, "🔴 порожній список до першого синку читається як «документів немає»");
});
