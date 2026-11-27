import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codeOf, codeGroupsOf, isCollectiveKey, GENERIC_KEYS, COLLECTIVE_SAMPLE, CODE_GROUPS_FROM, type CodePairRow } from "./clientCodes.js";
import { parsePayments } from "./dealLedger.js";

/**
 * 🧾 #11255–#11258 — КОД ЄДРПОУ ЯК ДОКАЗ «ЦЕ ОДИН КЛІЄНТ» (задача 11225, прохід 1; Роман 27.11.2026: «давай робити як
 * ідентифікатор - код єдрпоу», план затверджено того ж дня). Прохід лише ПОКАЗУЄ кандидатів, нічого не зливає.
 * Назви й коди у фікстурах вигадані. Живий SQL — `#11259` у `core/dealLedger.test.ts` (там уже є кластер).
 */
const SRC = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), "utf8");
const FE = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url)), "utf8");

const pair = (key: string, code: string | null, o: Partial<CodePairRow> = {}): CodePairRow => ({
  key, code_raw: code, payments: 1, last_paid: "2026-05-10", kontragent: code ? `Платник ${code}` : null, paid_deals: 1, name: null, ...o });

/**
 * #11255 — КОД НЕ ГУБИТЬСЯ І НЕ ВГАДУЄТЬСЯ. Парсер оплат 1С несе поле `ERPOU` сирим; що це за код, вирішує `codeOf`:
 * 8 цифр — ЄДРПОУ, 10 або 12 — ІПН, усе інше (7, 9, 11 цифр, літери) — `other`, порожнє й самі нулі — не код.
 * 🧨 Червоніє, якщо парсер знову викидатиме `ERPOU`, якщо «вичищати» літери з коду (VAT нерезидента став би ІПН чужої
 * фірми) або приймати нулі за код.
 */
test("#11255 КОД З ОПЛАТИ 1С: парсер несе ERPOU сирим; 8 цифр — ЄДРПОУ, 10 і 12 — ІПН, інше — окремо, нулі й порожнє — не код", () => {
  const pay = parsePayments([
    { Organization: "О", Kontragent: "ТОВ Приклад", ERPOU: " 00000001 ", Data: "21.10.2026 0:00:00", Sum: 100, Currency: "грн", Deal: "62767427" },
    { Organization: "О", Kontragent: "ФОП Зразок", Data: "21.10.2026 0:00:00", Sum: 100, Currency: "грн", Deal: "62767428" },
    { Organization: "О", Kontragent: "Без угоди", ERPOU: "00000009", Data: "21.10.2026", Sum: 100, Deal: "" },
  ]);
  assert.deepEqual(pay.map((p) => [p.deal, p.edrpou]), [[62767427, "00000001"], [62767428, null]],
    "🔴 код платника загубився, зʼявився там, де 1С його не дала, або рядок без угоди пройшов через код");

  // межа з обох боків кожної довжини
  assert.deepEqual(codeOf("12345678"), { code: "12345678", kind: "edrpou" });
  assert.deepEqual(codeOf("1234567890"), { code: "1234567890", kind: "ipn" });
  assert.deepEqual(codeOf("123456789012"), { code: "123456789012", kind: "ipn" });
  for (const odd of ["1234567", "123456789", "12345678901", "1234567890123"])
    assert.equal(codeOf(odd)?.kind, "other", `🔴 «${odd}» (${odd.length} цифр) прийнято за ЄДРПОУ чи ІПН`);
  assert.deepEqual(codeOf("12 345 678"), { code: "12345678", kind: "edrpou" }, "🔴 пробіли в коді зробили з нього інший код");
  assert.deepEqual(codeOf("PL1234567890"), { code: "PL1234567890", kind: "other" }, "🔴 з коду з літерами вирізано цифри: чужий VAT став би ІПН");
  for (const empty of [null, undefined, "", "   ", "0", "00000000", "0000000000"])
    assert.equal(codeOf(empty), null, `🔴 «${String(empty)}» прийнято за код`);
});

/**
 * #11256 — ЗБІРНЕ ІМʼЯ НЕ ПОТРАПЛЯЄ В ЖОДНУ ГРУПУ І НЕ СКЛЕЮЄ ЧУЖИХ. Заміряно 27.11.2026: через «Название не указано»
 * (71 код) групи за спільним кодом злиплись ланцюжком у «клієнта» з 26 записів. Тут: дві різні фірми, кожна має спільний
 * код лише зі збірним ключем; групи між ними бути не може. Дзеркало: ті самі пари зі звичайним ключем на місці збірного
 * ГРУПУЮТЬСЯ (інакше «не склеїлось» зеленіло б і тоді, коли групування зламане зовсім).
 * 🧨 Червоніє, якщо прибрати виключення збірних ключів до групування (`isCollectiveKey` завжди `false`).
 */
test("#11256 ЗБІРНЕ ІМʼЯ: «Название не указано» й імʼя людини не входять у групи і не склеюють різні фірми ланцюжком", () => {
  assert.ok(GENERIC_KEYS.includes("названиенеуказано") && GENERIC_KEYS.includes(""), "🔴 заглушки CRM не дочитались із джерела");
  assert.equal(isCollectiveKey("названиенеуказано"), true);
  assert.equal(isCollectiveKey("сергій"), true);
  assert.equal(isCollectiveKey("замовник"), true);
  assert.equal(isCollectiveKey("сергійтов"), false, "🔴 порівняння стало «містить»: фірма з іменем у назві зникла б зі списку дублів");
  assert.equal(isCollectiveKey("прикладтов"), false);

  const chain = (hub: string) => [
    pair("альфа", "11111111", { paid_deals: 5 }), pair(hub, "11111111", { paid_deals: 600 }),
    pair(hub, "22222222"), pair("бета", "22222222", { paid_deals: 3 }),
  ];
  for (const hub of ["названиенеуказано", "сергій"]) {
    const g = codeGroupsOf(chain(hub));
    assert.deepEqual([g.clean.length, g.multi.length], [0, 0], `🔴 «${hub}» склеїв дві різні фірми в одну групу`);
    assert.deepEqual(g.collective.map((e) => [e.key, e.codes, e.shared, e.paidDeals]), [[hub, 2, 2, 600]],
      "🔴 збірне імʼя не показане окремим рядком із числом кодів і числом клієнтів, чиї коди під ним лежать");
  }
  // 🪞 дзеркало: звичайний ключ на тому самому місці — група є, і вона «кілька юросіб» (два коди)
  const plain = codeGroupsOf(chain("гамма"));
  assert.deepEqual([plain.clean.length, plain.multi.length, plain.collective.length], [0, 1, 0], "🔴 групування зламане зовсім: «не склеїлось» нічого не доводить");
  assert.deepEqual(plain.multi[0].keys.map((k) => k.key), ["гамма", "альфа", "бета"]);

  // збірне імʼя з ОДНИМ кодом, якого більше ні в кого немає, — не подія: у список не йде
  assert.equal(codeGroupsOf([pair("роман", "33333333")]).collective.length, 0);
  // прикладів під збірним іменем не більше COLLECTIVE_SAMPLE, решта названа числом `codes`
  const many = codeGroupsOf(Array.from({ length: COLLECTIVE_SAMPLE + 3 }, (_, i) => pair("замовник", String(40000000 + i))));
  assert.deepEqual([many.collective[0].codes, many.collective[0].sample.length], [COLLECTIVE_SAMPLE + 3, COLLECTIVE_SAMPLE]);
});

/**
 * #11257 — ТРИ ВИДИ РОЗДІЛЕНІ ПО ОБИДВА БОКИ. Один код на два записи — чистий дубль; щойно в групі зʼявляється другий
 * код (навіть у одного запису, навіть нічий більше) — це «кілька юросіб», і рішення за людиною. Запис сам-один групи не
 * утворює; код «іншого вигляду» нічого не звʼязує і рахується окремим числом; покриття (скільки клієнтів узагалі мають
 * код) їде разом зі списком.
 * 🧨 Червоніє, якщо вважати чистим дублем групу з двома кодами, групувати за кодом іншого вигляду, загубити оплати без
 * коду з покриття або рахувати «стане менше» групами, а не записами.
 */
test("#11257 ТРИ ВИДИ ГРУП: один код — чистий дубль, другий код у групі — «кілька юросіб»; одинак і чужий код груп не дають", () => {
  const g = codeGroupsOf([
    // чистий дубль із трьох записів: назва, одруківка і запис за телефоном
    pair("прикладтов", "10000001", { paid_deals: 48, payments: 30, last_paid: "2026-11-20", name: "ТОВ Приклад", kontragent: "ПРИКЛАД ТОВ" }),
    pair("прикладкиїв", "10000001", { paid_deals: 7, payments: 4, last_paid: "2026-03-01", kontragent: "Приклад (стара назва)" }),
    pair("380670000000", "10000001", { paid_deals: 2, payments: 1, last_paid: "2026-02-01" }),
    // кілька юросіб: спільний код 20000002, а в «демо» ще й свій 20000003
    pair("демо", "20000002", { paid_deals: 31 }), pair("демо", "20000003"), pair("демологістик", "20000002", { paid_deals: 9 }),
    // одинак з кодом, одинак без коду
    pair("сам", "30000003", { paid_deals: 4 }), pair("готівка", null, { payments: 6 }),
    // код іншого вигляду однаковий у двох записів: НЕ група
    pair("нерезидент1", "PL5260250995", { payments: 2 }), pair("нерезидент2", "PL5260250995", { payments: 3 }),
  ]);
  assert.deepEqual([g.clean.length, g.multi.length, g.collective.length], [1, 1, 0], "🔴 види груп переплутані, або код іншого вигляду утворив групу");
  const [c] = g.clean, [m] = g.multi;
  assert.deepEqual(c.codes, [{ code: "10000001", kind: "edrpou", kontragent: "ПРИКЛАД ТОВ" }], "🔴 назва платника взята не з найсвіжішої оплати");
  assert.deepEqual(c.keys.map((k) => [k.key, k.paidDeals, k.payments, k.lastPaid, k.phoneKey]),
    [["прикладтов", 48, 30, "2026-11-20", false], ["прикладкиїв", 7, 4, "2026-03-01", false], ["380670000000", 2, 1, "2026-02-01", true]],
    "🔴 записи групи: порядок (найбільший зверху), числа або позначка запису за телефоном");
  assert.equal(c.keys[0].name, "ТОВ Приклад");
  assert.equal(c.paidDeals, 57);
  assert.deepEqual(m.codes.map((x) => x.code), ["20000002", "20000003"], "🔴 другий код запису не показаний: група виглядала б чистим дублем");
  assert.equal(m.kind, "multi");
  assert.equal(g.minusClean, 2, "🔴 «стане менше» рахує групи, а не записи: три записи одного клієнта — це мінус два");
  assert.deepEqual({ clients: g.clients, withCode: g.withCode, payments: g.payments, codedPayments: g.codedPayments, otherCodes: g.otherCodes, otherPayments: g.otherPayments },
    { clients: 9, withCode: 6, payments: 50, codedPayments: 39, otherCodes: 1, otherPayments: 5 },
    "🔴 покриття: клієнти без коду чи оплати з кодом іншого вигляду зникли з рахунку або пораховані як код");

  // межа «чистий / кілька юросіб» з другого боку: ті самі два записи без зайвого коду — чистий дубль
  const two = codeGroupsOf([pair("демо", "20000002"), pair("демологістик", "20000002")]);
  assert.deepEqual([two.clean.length, two.multi.length], [1, 0]);
  // порожній вхід — порожні списки й нулі, а не помилка; `codedPayments = 0` фронт читає як «синк ще не приніс кодів»
  const none = codeGroupsOf([pair("а", null), pair("б", null)]);
  assert.deepEqual([none.clean.length, none.multi.length, none.clients, none.withCode, none.codedPayments, none.payments], [0, 0, 2, 0, 0, 2]);
});

/**
 * #11258 — ПРОВОДКА. Роут лише читає і стоїть за правом `merge_clients` ПЕРШИМ оператором; має вкладкову межу й рядок у
 * матриці (тімлід у відмові); синк справді пише код у базу, а колонка оголошена в схемі; на екрані число плитки береться
 * з довжини того самого списку, що під нею (одним викликом), а порожня база кодів підписана як «ще не рахували».
 * 🧨 Червоніє, якщо прибрати гейт права, пустити тімліда, перестати писати `edrpou`, рахувати плитку окремим числом
 * або показати нуль груп до першого синку як «дублів немає».
 */
test("#11258 ПРОВОДКА: роут за правом обʼєднання, код пишеться синком, плитка = довжина списку, «ще не рахували» ≠ «дублів немає»", () => {
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/client-code-groups"');
  assert.ok(at > 0, "🔴 роут зник");
  const body = route.slice(at, route.indexOf("\n});", at));
  const gate = body.indexOf('if (!roleHasPerm(auth.roleKey, "merge_clients")) return res.status(403)');
  assert.ok(gate > 0 && gate < body.indexOf("clientCodeGroups("), "🔴 право `merge_clients` не перевіряється ДО читання списку");
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(body), "🔴 роут списку щось пише");
  assert.ok(SRC("auth/routeTab.ts").includes('pre("/api/dashboard/client-code-groups"), tabs: ["loyalty"]'), "🔴 роут без вкладкової межі");
  const cell = SRC("auth/accessMatrix.ts").split("\n").find((l, i, a) => a[i - 1]?.includes('path: "/api/dashboard/client-code-groups"'));
  assert.ok(cell && /allow: \["admin", "kvp", "opdir", "ceo"\], deny: \["hr", "manager", "team_lead", "financier"\]/.test(cell), "🔴 клітинка матриці: тімлід чи менеджер більше не у відмові");

  assert.ok(/ALTER TABLE onec_deal_payments ADD COLUMN IF NOT EXISTS edrpou TEXT;/.test(SRC("db/schema.sql")), "🔴 колонку коду не оголошено в схемі");
  const sync = SRC("core/onecSync.ts");
  assert.ok(/INSERT INTO onec_deal_payments \([^)]*\bedrpou\)/.test(sync) && sync.includes("p.map((x) => x.edrpou ?? null)"), "🔴 синк не пише код платника");
  assert.equal(CODE_GROUPS_FROM, "2026-01-01", "🔴 період за замовчуванням зрушив: плитки перестануть звірятись із заміром 27.11.2026");

  const fe = FE("pages/dashboard/sections/ClientCodeGroupsPanel.tsx");
  for (const k of ["clean", "multi", "collective"])
    assert.ok(fe.includes(`n: data?.${k}.length ?? null`), `🔴 плитка «${k}» рахується не з довжини свого списку`);
  assert.ok(fe.includes("data.codedPayments === 0") && fe.includes('data-code-empty="sync"'), "🔴 порожня база кодів показується як «груп немає»");
  assert.ok(fe.includes('=== 403 ? "denied"') && /if \(state === "denied"\) return null;/.test(fe), "🔴 відмова сервера малюється як помилка чи порожній список");
  assert.ok(!/mergeClients|client-merge/.test(fe), "🔴 у списку кандидатів зʼявилась дія обʼєднання: це прохід 2, разом із переносом планів і коментарів");
  assert.ok(FE("pages/dashboard/sections/LoyaltySection.tsx").includes("<ClientCodeGroupsPanel />"), "🔴 блок нікуди не вставлений");
});
