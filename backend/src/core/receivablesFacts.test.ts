import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Тести біжать із `dist`, а звіряти треба ДЖЕРЕЛО — той самий приймач, що в сусідніх гейтах. */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
import { needsDb } from "../testMode.js";
import {
  CARRIER_PAID_STAGES, agingBucket, classifyCarrierPaid, classifyInvoice, classifyLink,
  foldFacts, fromKommoPaymentType, type EntityResolver, type RawInvoiceRow,
} from "./receivablesFacts.js";

const row = (p: Partial<RawInvoiceRow> = {}): RawInvoiceRow => ({
  clientKey: "к", clientName: "К", amount: 100, invoiceDate: "2026-08-01", invoiceNo: "1",
  dealId: 1, dealFound: true, paymentType: "Безнал с НДС", statusId: 69716304,
  pipelineId: 8921932, stageMapped: true, ageDays: 10, ...p,
});

/**
 * #150 — Σ ПО ЕКРАНУ == Σ ПО `receivables`.
 *
 * Твердження, що НЕ залежить від жодної нашої класифікації: скільки б категорій
 * ми не завели, разом вони мусять дати ту саму суму, що й таблиця. Саме це
 * ловить помилку скоупу (факти по `ri.manager_id` замість ключів клієнтів) —
 * вона не міняє жодного окремого числа, лише розводить два підсумки.
 */
test("#150 Σ фактів == Σ рахунків клієнта (жодна категорія не загубила грошей)", async () => {
  const facts = [
    row({ clientKey: "a", amount: 10 }), row({ clientKey: "a", amount: 20, dealId: null }),
    row({ clientKey: "b", amount: 30, dealFound: false }), row({ clientKey: "b", amount: 40, stageMapped: false }),
  ].map((r) => classifyInvoice(r));
  const { byClient, totals } = foldFacts(facts);
  assert.equal(totals.amount, 100, "🔴 Σ підсумків розійшлась із Σ рахунків");
  assert.equal(byClient.get("a")!.amount + byClient.get("b")!.amount, 100);
  // Кожен зріз ОКРЕМО теж мусить давати ту саму суму — інакше категорія «з'їла» рядок.
  for (const dim of ["link", "entity", "carrier"] as const) {
    const s = Object.values(totals[dim]).reduce((x, v) => x + v.amount, 0);
    assert.equal(s, 100, `🔴 зріз «${dim}» дає ${s} замість 100 — рядок випав із категорій`);
  }
});

/**
 * #151 — ТРИ `linkState` ПОКРИВАЮТЬ УСЕ, жодного рахунку без категорії.
 * Саботаж: прибрати гілку `broken_link` — і рахунок із № угоди, якої немає,
 * лишиться некласифікованим (або тихо поїде в `kommo`).
 */
test("#151 три linkState покривають усі випадки, і вони РІЗНІ", () => {
  assert.equal(classifyLink(row({ dealId: 1, dealFound: true })), "kommo");
  assert.equal(classifyLink(row({ dealId: null })), "one_c");
  assert.equal(classifyLink(row({ dealId: 777, dealFound: false })), "broken_link");
  // 🪞 ДЗЕРКАЛО: «1С» і «битий лінк» мусять лишатись РІЗНИМИ станами. Якби їх
  // звели в один, обидва повернули б однакове — і гейт вище лишався б зеленим.
  assert.notEqual(classifyLink(row({ dealId: null })), classifyLink(row({ dealId: 777, dealFound: false })),
    "🔴 «виставлено через 1С» і «лінк не веде на угоду» злиплись в один стан");
});

/**
 * #152 — ВІДСУТНІСТЬ УГОДИ НІКОЛИ НЕ Є ФАКТОМ НЕОПЛАТИ.
 * Заміряно на проді 24.08.2026: `one_c` — 1 589 000 ₴. Назви це «не оплачено»,
 * і фінансист побачить 28% фальшивої неоплати зверху до справжніх 5 663 227 ₴.
 */
test("#152 «1С» / битий лінк / воронка поза мапою дають н/д, а НЕ «не оплачено»", () => {
  for (const [label, r] of [
    ["виставлено через 1С", row({ dealId: null })],
    ["лінк не веде на угоду", row({ dealId: 5, dealFound: false })],
    ["воронка поза мапою", row({ stageMapped: false, statusId: 69355700, pipelineId: 8868280 })],
  ] as const) {
    const got = classifyCarrierPaid(r);
    assert.equal(got.state, "na", `🔴 «${label}» дало «${got.state}» — це видає неоплату там, де ми просто не знаємо`);
    assert.ok(got.reason, `🔴 «${label}» дало н/д БЕЗ причини — невідоме мусить читатись як невідоме`);
  }
  // 🪞 ДЗЕРКАЛО: там, де ми ЗНАЄМО, гейт не має права мовчати «н/д» — інакше
  // «нічого не оплачено ніколи» теж було б зеленим.
  assert.equal(classifyCarrierPaid(row({ pipelineId: 8921932, statusId: 69716312 })).state, "paid");
  assert.equal(classifyCarrierPaid(row({ pipelineId: 8921932, statusId: 69716304 })).state, "unpaid");
  // 🔴 ТОЙ САМИЙ СТАТУС В ІНШІЙ ВОРОНЦІ — НЕ «оплачено». 142 у Продзвіні
  // (8921936) означає «КВАЛІФІКОВАНО», а не виграну угоду.
  assert.equal(classifyCarrierPaid(row({ pipelineId: 8921932, statusId: 142 })).state, "paid");
  assert.notEqual(classifyCarrierPaid(row({ pipelineId: 8921936, statusId: 142 })).state, "paid",
    "🔴 142 у Продзвіні зарахувався як «перевізник оплачений» — звірка йде по статусу, а не по парі");
});

/**
 * #153 — СПИСОК `status_id` ЗВІРЯЄТЬСЯ З `seedKommoMapping.sql`.
 * І, головне, доводить, ЧОМУ список потрібен: `funnel_stage` цієї межі не
 * виражає. Заміряно: під `invoiced` шість статусів, зокрема «перевізник
 * оплачений» (118 рах. / 3.09 млн) і ще неоплачений (66 / 2.53 млн).
 */
test("#153 пари (воронка, статус) «перевізник оплачений» звірені з seedKommoMapping і НЕ зводяться до funnel_stage", () => {
  const sql = readFileSync(srcOf("../db/seedKommoMapping.sql"), "utf8");
  const rows = [...sql.matchAll(/\((\d+),\s*(\d+),\s*'(\w+)'\)/g)]
    .map((m) => ({ pipeline: Number(m[1]), status: Number(m[2]), stage: m[3] }));
  assert.ok(rows.length > 20, "🔴 сид не розібрався — гейту не було б що звіряти");

  for (const st of CARRIER_PAID_STAGES) {
    const hit = rows.find((r) => r.pipeline === st.pipelineId && r.status === st.statusId);
    assert.ok(hit, `🔴 пари (${st.pipelineId}, ${st.statusId}) НЕМАЄ в seedKommoMapping.sql`);
    assert.ok(["invoiced", "paid"].includes(hit!.stage),
      `🔴 (${st.pipelineId}, ${st.statusId}) мапиться в «${hit!.stage}» — не той бік воронки`);
  }

  // 🔴 ЧОМУ ПАРА, А НЕ СТАТУС: той самий `status_id` в іншій воронці означає
  // ІНШЕ. Заміряно в сиді: 142 у Продзвіні (8921936) — це `quote_requested`.
  const sameIdElsewhere = rows.filter((r) =>
    CARRIER_PAID_STAGES.some((st) => st.statusId === r.status)
    && !CARRIER_PAID_STAGES.some((st) => st.statusId === r.status && st.pipelineId === r.pipeline));
  assert.ok(sameIdElsewhere.length > 0,
    "🔴 жоден із наших status_id не трапляється в ІНШІЙ воронці — тоді пара зайва, і хтось спростить її до статусу");
  assert.ok(sameIdElsewhere.some((r) => !["invoiced", "paid"].includes(r.stage)),
    "🔴 у чужих воронках наші статуси означають те саме — доказ потреби в парі зник");

  // 🔴 І ЧОМУ НЕ `funnel_stage`: у 'invoiced' є статуси ПОЗА нашим списком.
  // Заміряно на проді: 69716304 — 66 рахунків / 2.53 млн, які фільтр по
  // funnel_stage зарахував би як «перевізник оплачений».
  const invoiced = rows.filter((r) => r.stage === "invoiced");
  const extra = invoiced.filter((r) => !CARRIER_PAID_STAGES.some((st) => st.pipelineId === r.pipeline && st.statusId === r.status));
  assert.ok(extra.length > 0,
    "🔴 у 'invoiced' немає жодного статусу поза списком — тоді список зайвий, і хтось замінить його на funnel_stage");
  const inside = invoiced.filter((r) => CARRIER_PAID_STAGES.some((st) => st.pipelineId === r.pipeline && st.statusId === r.status));
  assert.ok(inside.length > 0, "🔴 у 'invoiced' немає жодного НАШОГО статусу — список відірвався від воронки");
});

/**
 * #154 — ВОРОНКА ПОЗА МАПОЮ НАЗВАНА, А НЕ ВІДФІЛЬТРОВАНА.
 * Заміряно: воронка 8868280, 1 рахунок, 9 000 ₴. Сховати рядок означало б, що
 * гроші зникли з екрана без сліду.
 */
test("#154 воронка поза мапою етапів НАЗВАНА, а рахунок лишається в сумі", () => {
  const facts = [row({ amount: 9000, stageMapped: false, pipelineId: 8868280, statusId: 69355700 }),
                 row({ amount: 1000 })].map((r) => classifyInvoice(r));
  const { totals, byClient } = foldFacts(facts);
  assert.equal(totals.amount, 10000, "🔴 рахунок поза мапою випав із суми — це і є «зникнення без сліду»");
  assert.deepEqual(totals.pipelinesOutOfMap, [8868280], "🔴 воронку не названо — людина не дізнається, куди дивитись");
  assert.deepEqual(byClient.get("к")!.pipelinesOutOfMap, [8868280]);
  // 🪞 ДЗЕРКАЛО: коли все в мапі — поле ПОРОЖНЄ, а не вигадує воронку.
  const clean = foldFacts([classifyInvoice(row())]);
  assert.deepEqual(clean.totals.pipelinesOutOfMap, []);
});

/**
 * #155 — ЮРОСОБА ЙДЕ ЧЕРЕЗ `EntityResolver`, а не через `if` по `payment_type`.
 * Джерело абстраговане під майбутній 1С: підміна резолвера мусить змінити
 * ВЕСЬ екран, а не лише одне місце.
 */
test("#155 юрособа береться через EntityResolver — підміна джерела міняє результат", () => {
  assert.equal(classifyInvoice(row({ paymentType: "Безнал с НДС" })).entity, "uts");
  assert.equal(classifyInvoice(row({ paymentType: "Безнал без НДС" })).entity, "avtomuv");
  assert.equal(classifyInvoice(row({ paymentType: "ВАЛЮТА" })).entity, "avtomuv");
  assert.equal(classifyInvoice(row({ paymentType: "Наличные" })).entity, "fop");
  // 🔴 Порожня форма оплати — UNKNOWN З ПРИЧИНОЮ, а не мовчазне приліплювання
  // до найбільшої юрособи. Заміряно: 7 рах. / 124 300 ₴.
  const empty = classifyInvoice(row({ paymentType: null }));
  assert.equal(empty.entity, "unknown");
  assert.equal(empty.entityReason, "no_payment_type");
  // Три причини UNKNOWN лишаються РІЗНИМИ — інакше три різні дії злились би в одну.
  assert.equal(classifyInvoice(row({ dealId: null })).entityReason, "one_c");
  assert.equal(classifyInvoice(row({ dealId: 9, dealFound: false })).entityReason, "broken_link");

  // 🪞 ДЗЕРКАЛО АБСТРАКЦІЇ: інший резолвер (майбутній 1С) МУСИТЬ дати інший
  // результат на тому самому рядку. Якби роут читав `payment_type` сам, підміна
  // резолвера нічого б не змінила — і цей assert почервонів би.
  const fake: EntityResolver = { name: "1c-stub", resolve: () => ({ entity: "fop", reason: null }) };
  assert.equal(classifyInvoice(row({ paymentType: "Безнал с НДС" }), fake).entity, "fop");
  assert.equal(fromKommoPaymentType.name, "kommo-payment-type");
});

test("#150b aging розкладає за віком, і невідомий вік лишається невідомим", () => {
  assert.equal(agingBucket(0), "0-30");
  assert.equal(agingBucket(30), "0-30");
  assert.equal(agingBucket(31), "31-60");
  assert.equal(agingBucket(90), "61-90");
  assert.equal(agingBucket(91), "90+");
  // 🔴 Немає дати рахунку → немає кошика. Приліпити такий рахунок до «0-30»
  // означало б сказати «свіжий» про те, чого ми не знаємо.
  assert.equal(agingBucket(null), null);
});

// ───────────────────── ЖИВІ ДАНІ (потребують БД) ─────────────────────

const handler = async (path: string) => {
  const { dashboardRouter } = await import("../routes/dashboard.js");
  const layer = (dashboardRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => void }[] } }[] })
    .stack.find((l) => l.route?.path === path && l.route.methods.get);
  assert.ok(layer?.route, `🔴 роут ${path} не знайдено — гейт не має що міряти`);
  return layer!.route!.stack[layer!.route!.stack.length - 1].handle;
};
type Auth = { role: string; roleKey: string; managerId: number | null; teamId: number | null; userId: number };
const call = (h: Awaited<ReturnType<typeof handler>>, auth: Auth) =>
  new Promise<any>((ok, bad) => {
    const res = { json(b: unknown) { ok(b); }, status() { return this; }, send(b: unknown) { ok(b); }, setHeader() {} };
    try { h({ auth, query: {}, params: {} }, res, (e?: unknown) => bad(e ?? new Error("next()"))); } catch (e) { bad(e); }
  });
const ADMIN: Auth = { role: "admin", roleKey: "admin", managerId: null, teamId: null, userId: 0 };

/**
 * #150c — ЖИВЕ ДЗЕРКАЛО #150: Σ плиток == Σ рядків == Σ таблиці `receivables`.
 * Чиста функція доводить, що складання не губить; це доводить, що НЕ гублять
 * ще й скоуп та запит. Саме тут виявився б скоуп по `ri.manager_id`.
 */
test("#150c ЖИВІ ДАНІ: Σ плиток == Σ рядків екрана", needsDb(), async () => {
  const body = await call(await handler("/receivables"), ADMIN);
  const rowsSum = body.managers.reduce((s: number, m: any) => s + m.total, 0);
  assert.ok(rowsSum > 0, "🔴 Σ = 0 — перевіряти нема чого, це ПРОВАЛ, а не успіх");
  assert.ok(body.totals, "🔴 підсумків для плиток немає — плитки малювались би з іншого джерела");
  const d = Math.abs(body.totals.amount - rowsSum);
  assert.ok(d < 0.01, `🔴 Σ плиток ${body.totals.amount} != Σ рядків ${rowsSum} (Δ ${d.toFixed(2)})`);
  for (const dim of ["link", "entity", "carrier"] as const) {
    const s = Object.values(body.totals[dim] as Record<string, { amount: number }>)
      .reduce((x, v) => x + v.amount, 0);
    assert.ok(Math.abs(s - rowsSum) < 0.01, `🔴 зріз «${dim}» дає ${s} замість ${rowsSum}`);
  }
});

/**
 * #157 — ФАКТИ СКОУПЛЯТЬСЯ ПО КЛЮЧАХ КЛІЄНТІВ, А НЕ ПО МЕНЕДЖЕРУ РАХУНКУ.
 *
 * Рядок клієнта фільтрується по ВІДПОВІДАЛЬНОМУ (`receivables.manager_id`),
 * а рахунок носить менеджера САМОГО РАХУНКУ (`receivable_invoices.manager_id`) —
 * після override або склейки це різні люди. Фільтруй факти по другому, і в
 * тімліда зʼявились би факти чужих клієнтів (або зникли свої), тобто плитки
 * розійшлися б із рядками МОВЧКИ: кожне число окремо лишалось би правильним.
 */
test("#157 у КОЖНОГО видимого клієнта факти РІВНО на його борг — і у звуженому скоупі теж", needsDb(), async () => {
  const h = await handler("/receivables");
  // 🔴 ЗВУЖЕНИЙ СКОУП ОБОВʼЯЗКОВИЙ. В адміна видно ВСІХ клієнтів, тож помилка
  // скоупу (фільтр фактів по `ri.manager_id` замість ключів клієнтів) там просто
  // недосяжна: зайвих рахунків нема звідки взятись. Ловиться вона рівно там, де
  // множини розходяться — у тімліда, чий клієнт має рахунки з чужим менеджером
  // (після override або склейки це нормальна ситуація).
  const scopes: [string, Auth][] = [
    ["адмін", ADMIN],
    ["тімлід t5", { role: "team_lead", roleKey: "team_lead", managerId: null, teamId: 5, userId: 0 }],
    ["тімлід t6", { role: "team_lead", roleKey: "team_lead", managerId: null, teamId: 6, userId: 0 }],
  ];
  let checked = 0;
  for (const [label, auth] of scopes) {
    const body = await call(h, auth);
    const clients = body.managers.flatMap((m: any) => m.clients);
    assert.ok(clients.length > 0, `🔴 у скоупі «${label}» немає клієнтів — гейт нічого не перевіряє`);
    for (const c of clients) {
      assert.ok(c.facts, `🔴 «${c.clientName}» (${label}) БЕЗ фактів — екран малював би прочерки замість відповіді`);
      assert.equal(c.facts.clientKey, c.clientKey,
        `🔴 «${c.clientName}» дістав факти ключа «${c.facts.clientKey}»`);
      // Рівність, а не «не більше»: борг клієнта СКЛАДЕНИЙ із цих самих рахунків.
      // Нерівність у будь-який бік = скоуп фактів розійшовся зі скоупом рядків.
      assert.ok(Math.abs(c.facts.amount - c.amount) < 0.01,
        `🔴 «${c.clientName}» (${label}): рядок ${c.amount}, факти ${c.facts.amount} — скоуп фактів розійшовся`);
      checked++;
    }
  }
  assert.ok(checked > 50, `🔴 перевірено лише ${checked} клієнтів — вибірка завузька, щоб щось доводити`);
});

/**
 * #158 — КІЛЬКІСТЬ ПОХОДІВ У БД, а не час.
 *
 * Заміряно 24.08.2026: RTT до Neon = 30 мс (медіана 10× «SELECT 1»), а весь
 * екран — 303 рахунки на 72 клієнтів. Тобто кожен НОВИЙ блок, зроблений окремим
 * запитом, коштує +30 мс незалежно від того, що рахує. Стеля структурна й
 * детермінована — на відміну від абсолютного часу, який визначає завантаження
 * Neon, а не ми (саме тому #137e знято).
 */
test("#158 /receivables робить не більше 4 запитів до БД", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const h = await handler("/receivables");
  let n = 0;
  const orig = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = function (t: unknown, p: unknown) { n++; return orig(t as string, p as unknown[]); };
  try { await call(h, ADMIN); } finally { (pool as unknown as { query: unknown }).query = orig; }
  assert.ok(n > 0, "🔴 жодного запиту не перехоплено — лічильник не працює, а не роут дешевий");
  // 4 = клієнти + нотатки + syncedAt + факти. Було 3 до редизайну; факти додали
  // РІВНО ОДИН похід на всі зрізи разом (юрособа, перевізник, вік, звʼязок).
  assert.ok(n <= 4,
    `🔴 /receivables робить ${n} запитів (стеля 4) — хтось додав блок ОКРЕМИМ запитом замість того, `
    + "щоб скласти його з уже привезених фактів. Кожен такий блок коштує +30 мс RTT.");
});

/**
 * #156 — ГЕЙТ ПРАВА СТОЇТЬ ПЕРШИМ ЗНАЧУЩИМ ОПЕРАТОРОМ.
 *
 * Кнопки Е3 (зміна відповідального, склейка) спираються на ці роути. Валідація
 * тіла ПЕРЕД перевіркою права дає 400 замість 403 і ламає гарантію матриці
 * доступу «403 = спрацював гейт» — на цьому вже відкочували прод 04.08.2026.
 *
 * ⚠️ Гейт читає ДЖЕРЕЛО, а не робить HTTP-пробу: для проби потрібні живий
 * сервер і користувач БЕЗ права — умови, кожна з яких дала б `skip`, тобто
 * гейт мовчки не виконувався б. А він стереже рішення власника про доступ.
 */
test("#156 у роутах дебіторки перевірка права — перший значущий оператор", () => {
  const src = readFileSync(srcOf("../routes/dashboard.ts"), "utf8");
  const cases = [
    { route: 'dashboardRouter.put("/receivables/owner"', guard: "isAdminScope" },
    { route: 'dashboardRouter.post("/receivables/merge"', guard: "merge_receivables" },
    { route: 'dashboardRouter.delete("/receivables/owner/:clientKey"', guard: "isAdminScope" },
  ];
  for (const c of cases) {
    const at = src.indexOf(c.route);
    assert.ok(at > 0, `🔴 роут ${c.route} не знайдено — гейт стереже те, чого немає`);
    // Тіло до кінця роута; коментарі геть, інакше гейт червонів би на власному поясненні.
    const body = src.slice(at, at + 1400).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const guardAt = body.indexOf(c.guard);
    assert.ok(guardAt > 0, `🔴 у ${c.route} немає перевірки «${c.guard}»`);
    // Перший дотик до тіла запиту — усе, що читає req.body/req.params/req.query.
    const bodyRead = body.search(/req\.(body|params|query)/);
    assert.ok(bodyRead === -1 || guardAt < bodyRead,
      `🔴 у ${c.route} тіло запиту читається (позиція ${bodyRead}) РАНІШЕ за гейт «${c.guard}» (${guardAt}) `
      + "— відмова прийде як 400 замість 403");
  }
});
