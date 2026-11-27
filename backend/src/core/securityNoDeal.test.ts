import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseInvoices, parsePayments, parseNoDeal } from "./dealLedger.js";
import { noDealTotals, noDealView, nonClientReason, parseNoDealFilter, INTERNAL_ORGS, NO_FILTER, SCREEN_SCOPE, NO_DEAL_ROWS_SQL, NO_DEAL_UNPAID_SQL, type NoDealDoc, type NoDealFilter } from "./securityNoDeal.js";
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
  assert.match(body, /res\.json\(await loadNoDeal\(pool as unknown as LedgerDb, parsed\.filter\)\);/, "🔴 роут не віддає звіт ядра");
  assert.match(FE("components/Layout.tsx"), /\{ key: "security", label: "Безпека", icon: "🛡", roles: \["admin"\] \}/, "🔴 пункту меню «Безпека» немає");
  assert.match(FE("pages/Dashboard.tsx"), /\{section === "security" && <SecuritySection \/>\}/, "🔴 екран «Безпека» не підключено");
  const screen = FE("pages/dashboard/sections/SecuritySection.tsx");
  assert.match(screen, /data\.lists\[l\.key\]\.totals/, "🔴 плитка бере число не з підсумку сервера");
  assert.match(screen, /Порожньо зараз не означає, що таких документів немає/, "🔴 порожній список до першого синку читається як «документів немає»");
});

/** Документ для фікстур фільтра: організація «О1», гривня, названий платник — усе, що не задано явно. */
const D = (o: Partial<NoDealDoc>): NoDealDoc => ({ number: null, organization: "О1", kontragent: "ТОВ Приклад", edrpou: null, date: "2026-03-10", sum: 100, currency: "грн",
  dealRaw: "", manager: null, comment: null, ...o });
const F = (o: Partial<NoDealFilter>): NoDealFilter => ({ ...NO_FILTER, ...o });
const nums = (docs: readonly NoDealDoc[]) => docs.map((d) => d.number).sort();

/**
 * #11260 — ПЕРІОД ВКЛЮЧНО З ОБОМА КІНЦЯМИ, І ПЛИТКА ПІД ФІЛЬТРОМ = СУМА ТОГО САМОГО СПИСКУ (Роман 27.11.2026: «таку саму
 * шапку, як і у звіті»). Документи рівно на межі входять, сусідні дні ні. Документ без дати не належить жодному періоду:
 * під фільтром періоду його немає, без періоду він є — інакше він або зникав би назавжди, або стояв у кожному місяці.
 * 🧨 Червоніє, якщо межу зробити строгою (зникне перший чи останній день періоду), якщо документ без дати проходить фільтр
 * періоду, чи якщо підсумок рахувати не з відфільтрованих рядків.
 */
test("#11260 «БЕЗПЕКА» · ПЕРІОД: обидві межі включно, документ без дати поза будь-яким періодом, плитка = Σ списку під фільтром", () => {
  const docs = [
    D({ number: "до", date: "2026-02-28", sum: 1 }), D({ number: "перший", date: "2026-03-01", sum: 10 }), D({ number: "середина", date: "2026-03-15", sum: 100, currency: "EUR" }),
    D({ number: "останній", date: "2026-03-31", sum: 1000 }), D({ number: "після", date: "2026-04-01", sum: 10000 }), D({ number: "без дати", date: null, sum: 100000 }),
  ];
  const v = noDealView(docs, F({ from: "2026-03-01", to: "2026-03-31" }));
  assert.deepEqual(nums(v.docs), ["останній", "перший", "середина"], "🔴 період: межа не включно або пройшов документ поза періодом чи без дати");
  assert.deepEqual([v.totals.docs, v.totals.uah, v.totals.fx], [3, 1010, [{ currency: "EUR", sum: 100, docs: 1 }]], "🔴 плитка під фільтром не дорівнює сумі списку");
  assert.deepEqual(nums(noDealView(docs, F({ from: "2026-03-31" })).docs), ["останній", "після"], "🔴 відкритий період «від»: межа чи документ без дати");
  assert.deepEqual(nums(noDealView(docs, F({ to: "2026-03-01" })).docs), ["до", "перший"], "🔴 відкритий період «до»: межа чи документ без дати");
  const whole = noDealView(docs, NO_FILTER);
  assert.equal(whole.docs.length, docs.length, "🔴 без періоду документ без дати зник зі списку");
  assert.deepEqual([v.all, whole.all], [docs.length, docs.length], "🔴 «усього в списку» залежить від фільтра");
});

/**
 * #11261 — «КЛІЄНТСЬКИЙ» ДОКУМЕНТ: є платник, організація не внутрішня, сума не нуль, платник не тестовий (Роман 27.11.2026:
 * «рахунки, які не підкріплені до угоди, які міг виставити менеджер або бухгалтерія»; на проді з 46,3 млн ₴ оплат
 * клієнтських 3,7 млн). Приклад по ОБИДВА боки кожної з чотирьох умов. Причина одна на документ, тому «клієнтські + інші =
 * усі» і «Σ причин = інші»: правило по чужому тексту завжди їде разом із числом того, що воно не визнало.
 * 🧨 Червоніє, якщо прибрати будь-яку з чотирьох умов, порахувати документ у двох причинах, сховати «інші» без числа чи
 * визнати тестовим платника чи внутрішньою організацію, у яких назва лише схожа.
 */
test("#11261 «БЕЗПЕКА» · КЛІЄНТСЬКИЙ ДОКУМЕНТ: по обидва боки кожної з чотирьох умов, причина одна, клієнтські + інші = усі", () => {
  const [safe, contractor] = INTERNAL_ORGS;
  assert.ok(safe && contractor, "🔴 перелік внутрішніх організацій порожній: гейт не має чого перевіряти");
  const docs = [
    D({ number: "клієнт", sum: 500 }), D({ number: "клієнт-валюта", sum: 70, currency: "EUR" }), D({ number: "схожа-назва", kontragent: "Тест Інтеграціями ТОВ", sum: 40 }),
    D({ number: "сейф", organization: safe, sum: 3000 }), D({ number: "підрядник", organization: contractor, kontragent: "", sum: 2000 }),
    D({ number: "схожа-організація", organization: `${safe} 2`, sum: 60 }),
    D({ number: "без платника", kontragent: "  ", sum: 900 }), D({ number: "нуль", sum: 0 }), D({ number: "нуль-без-платника", kontragent: "", sum: 0 }),
    D({ number: "тест", kontragent: "ТЕСТ ІНТЕГРАЦІЯ CLAUDE", sum: 12 }), D({ number: "тест-нуль", kontragent: "тест  інтеграція", organization: safe, sum: 0 }),
  ];
  const reason = (n: string) => nonClientReason(docs.find((d) => d.number === n)!);
  assert.deepEqual(["клієнт", "клієнт-валюта", "схожа-назва", "схожа-організація"].map(reason), [null, null, null, null], "🔴 клієнтський документ відсіяно");
  assert.deepEqual(["сейф", "підрядник", "без платника", "нуль", "нуль-без-платника", "тест", "тест-нуль"].map(reason),
    ["internal", "internal", "unnamed", "zero", "zero", "test", "test"], "🔴 причина «не клієнтський» не та або не одна на документ");
  const client = noDealView(docs, F({ scope: "client" })), other = noDealView(docs, F({ scope: "other" })), all = noDealView(docs, NO_FILTER);
  assert.deepEqual(nums(client.docs), ["клієнт", "клієнт-валюта", "схожа-назва", "схожа-організація"].sort(), "🔴 вид «клієнтські»: не той склад");
  assert.equal(client.docs.length + other.docs.length, all.docs.length, "🔴 клієнтські + інші не дорівнюють усім: документ зник або стоїть двічі");
  assert.deepEqual(nums([...client.docs, ...other.docs]), nums(all.docs), "🔴 клієнтські та інші разом не той самий набір, що «усі»");
  assert.equal(client.totals.uah, 600, "🔴 плитка «клієнтські» не Σ клієнтських гривневих рядків");
  for (const v of [client, other, all]) {
    assert.deepEqual(v.scopes, { client: { docs: 4, uah: 600 }, other: { docs: 7, uah: 5912 } }, "🔴 числа на кнопках виду залежать від вибраного виду");
    assert.deepEqual(v.reasons, [{ reason: "test", docs: 2, uah: 12 }, { reason: "zero", docs: 2, uah: 0 }, { reason: "internal", docs: 2, uah: 5000 }, { reason: "unnamed", docs: 1, uah: 900 }],
      "🔴 причини «інших» не сходяться");
    assert.equal(v.reasons.reduce((n, r) => n + r.docs, 0), v.scopes.other.docs, "🔴 Σ причин не дорівнює «іншим»");
  }
  assert.deepEqual(noDealView([], F({ scope: "client" })).scopes, { client: { docs: 0, uah: 0 }, other: { docs: 0, uah: 0 } }, "🔴 порожній список: числа виду не нулі");
});

/**
 * #11262 — ПЕРЕЛІК ВАРІАНТІВ НЕ ЗВУЖУЄТЬСЯ ВЛАСНИМ ФІЛЬТРОМ, АЛЕ ЗВУЖУЄТЬСЯ РЕШТОЮ. Чипи організацій рахуються без фільтра
 * організації, стовпчики місяців без періоду — інакше вибраний чип чи місяць прибирав би решту варіантів, і їх не було б
 * чим вибрати. Водночас чипи чесні щодо періоду й виду: число на чипі = скільки документів дасть клік.
 * 🧨 Червоніє, якщо рахувати перелік під власним фільтром (лишається один варіант) або без чужих фільтрів (число на чипі
 * не збігається з тим, що покаже список).
 */
test("#11262 «БЕЗПЕКА» · ПЕРЕЛІКИ ВАРІАНТІВ: організації без фільтра організації, місяці без періоду, і обидва під рештою фільтрів", () => {
  const docs = [
    D({ number: "1", organization: "О1", date: "2026-03-05", sum: 100 }), D({ number: "2", organization: "О1", date: "2026-04-05", sum: 200 }),
    D({ number: "3", organization: "О2", date: "2026-03-06", sum: 400 }), D({ number: "4", organization: null, date: "2026-03-07", sum: 800 }),
    D({ number: "5", organization: "О2", date: "2026-03-08", sum: 1600, kontragent: "" }), D({ number: "6", organization: "О3", date: null, sum: 3200 }),
  ];
  const v = noDealView(docs, F({ from: "2026-03-01", to: "2026-03-31", orgs: ["О1"], scope: "client" }));
  assert.deepEqual(nums(v.docs), ["1"], "🔴 три фільтри разом: не той список");
  assert.deepEqual(v.orgs, [{ name: "", docs: 1, uah: 800 }, { name: "О2", docs: 1, uah: 400 }, { name: "О1", docs: 1, uah: 100 }],
    "🔴 чипи організацій: звужені власним фільтром, або не звужені періодом і видом, або порожня назва загубилась");
  assert.deepEqual(v.months, [{ ym: "2026-03", docs: 1, uah: 100 }, { ym: "2026-04", docs: 1, uah: 200 }], "🔴 місяці: звужені періодом або не звужені організацією й видом");
  assert.deepEqual(v.scopes, { client: { docs: 1, uah: 100 }, other: { docs: 0, uah: 0 } }, "🔴 числа виду не під періодом і організацією");
  // число на чипі = те, що покаже список після кліку по ньому
  for (const o of v.orgs) assert.equal(noDealView(docs, F({ from: "2026-03-01", to: "2026-03-31", orgs: [o.name], scope: "client" })).docs.length, o.docs, `🔴 чип «${o.name}» обіцяє не стільки, скільки покаже список`);
  assert.deepEqual(nums(noDealView(docs, F({ orgs: ["О2", ""] })).docs), ["3", "4", "5"], "🔴 кілька організацій разом або документ без організації");
});

/**
 * #11263 — НА ВКЛАДЦІ ЛИШЕ КЛІЄНТСЬКІ ДОКУМЕНТИ, І ЗАПИТОМ ЦЬОГО НЕ РОЗШИРИТИ (рішення Романа 27.11.2026, картка «Лише
 * клієнтські»: внутрішні, без платника, нульові й тестові з вкладки зникають зовсім). Вид екрана заданий сталою й із
 * запиту не читається; у відповіді від відсіяного лишаються тільки числа. Нерозбірлива дата й перевернутий період дають
 * відмову кодом 400, а не «фільтр мовчки не застосовано». Дзеркало: правильні параметри доходять до фільтра як є.
 * Екран: шапка з тих самих компонентів, що у Звіті; перемикача виду немає; число відсіяних стоїть під «?».
 * 🧨 Червоніє, якщо `?scope=all` поверне на екран прибране, якщо прийняти «2026-02-30» чи «31.03.2026», загубити
 * організацію з параметрів, прибрати 400 у роуті, чи якщо екран отримає кнопку «показати все» або втратить шапку періоду.
 */
test("#11263 «БЕЗПЕКА» · ЛИШЕ КЛІЄНТСЬКІ: вид не читається із запиту, крива дата й перевернутий період дають 400, шапка як у Звіті", () => {
  assert.equal(SCREEN_SCOPE, "client", "🔴 вкладка показує не лише клієнтські документи: це рішення власника, а не налаштування");
  for (const wide of [{ scope: "all" }, { scope: "other" }, { scope: ["all"] }, { scope: "щось" }]) {
    const r = parseNoDealFilter(wide);
    assert.ok("filter" in r && r.filter.scope === "client", `🔴 параметр ${JSON.stringify(wide)} змінив вид екрана`);
  }
  for (const bad of [{ from: "31.03.2026" }, { to: "2026-3-1" }, { from: "2026-02-30" }, { from: "2026-13-01" }, { from: "2026-04-01", to: "2026-03-31" }])
    assert.ok("error" in parseNoDealFilter(bad), `🔴 прийнято нерозбірливий параметр ${JSON.stringify(bad)}`);
  assert.deepEqual(parseNoDealFilter({}), { filter: { ...NO_FILTER, scope: "client" } }, "🔴 без параметрів: не «увесь період, усі організації, клієнтські»");
  assert.deepEqual(parseNoDealFilter({ from: "2026-03-01", to: "2026-03-01", org: "О1" }),
    { filter: { from: "2026-03-01", to: "2026-03-01", orgs: ["О1"], scope: "client" } }, "🔴 правильні параметри (один день, одна організація) не дійшли до фільтра");
  assert.deepEqual(parseNoDealFilter({ to: "2028-02-29", org: ["О1", "", "О 2"] }),
    { filter: { from: null, to: "2028-02-29", orgs: ["О1", "О 2"], scope: "client" } }, "🔴 кілька організацій, відкритий період або 29 лютого високосного року");
  // від відсіяного у відповіді лишаються числа, а не документи
  const v = noDealView([D({ number: "клієнт" }), D({ number: "без платника", kontragent: "", sum: 900 })], { ...NO_FILTER, scope: SCREEN_SCOPE });
  assert.deepEqual([nums(v.docs), v.scopes.other, v.orgs.map((o) => o.docs)], [["клієнт"], { docs: 1, uah: 900 }, [1]], "🔴 відсіяний документ дійшов до списку чи чипа, або його число загубилось");

  const route = SRC("routes/dashboard.ts");
  const body = route.slice(route.indexOf('dashboardRouter.get("/security/no-deal"'), route.indexOf('dashboardRouter.get("/security/no-deal"') + 700);
  assert.match(body, /const parsed = parseNoDealFilter\(req\.query as Record<string, unknown>\);\s+if \("error" in parsed\) return res\.status\(400\)\.json\(\{ error: parsed\.error \}\);/,
    "🔴 роут не відмовляє кодом 400 на нерозбірливий параметр");
  const api = FE("api.ts");
  const call = api.slice(api.indexOf("export const fetchSecurityNoDeal"), api.indexOf("export const fetchSecurityNoDeal") + 600);
  assert.match(call, /params: \{ \.\.\.\(f\.from \? \{ from: f\.from \} : \{\}\), \.\.\.\(f\.to \? \{ to: f\.to \} : \{\}\), \.\.\.\(f\.orgs\?\.length \? \{ org: \[\.\.\.f\.orgs\] \} : \{\}\) \}/,
    "🔴 запит екрана не несе період чи організації");
  assert.match(call, /paramsSerializer: \{ indexes: null \}/, "🔴 кілька організацій поїдуть як org[]=…, а сервер читає org=…");
  const screen = FE("pages/dashboard/sections/SecuritySection.tsx");
  assert.match(screen, /import \{ DateRangeFilter, QuickPeriods \} from "\.\.\/\.\.\/\.\.\/components\/DateRangeFilter";/, "🔴 шапка періоду не з тих самих компонентів, що у Звіті");
  assert.match(screen, /<QuickPeriods active=\{preset\}/, "🔴 швидких періодів на екрані немає");
  assert.match(screen, /<DateRangeFilter value=\{range\}/, "🔴 довільного періоду на екрані немає");
  assert.match(screen, /fetchSecurityNoDeal\(\{ from: range\.from, to: range\.to, orgs \}\)/, "🔴 екран не передає серверу фільтр шапки");
  assert.doesNotMatch(screen.replace(/\/\*[\s\S]*?\*\//g, ""), /\bscope\s*[:=]|setScope/, "🔴 на екрані зʼявився перемикач виду: «показати все» прибрано рішенням власника");
  assert.match(screen, /view\.scopes\.other\.docs[\s\S]{0,200}view\.reasons\.map\(/, "🔴 екран не називає, скільки документів відсіяно як не клієнтські й чому");
});
