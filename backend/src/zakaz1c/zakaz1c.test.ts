import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { verifyKommoToken, requireKommoCaller } from "./kommoAuth.js";
import {
  buildCreateCustomerBody, buildCreateInvoiceBody, canEdit, customerInfoFrom1c, fromCreateInvoiceReply, genesisComment, invoiceAllowed,
  orgRules, parseInvoiceForm, payStateOf, serviceSwaps,
} from "./invoice.js";
import { zakaz1cFieldsMode, zakaz1cMode } from "./env.js";
import { BEFORE_PAID, PAID_STAGE, patchOf, planPayment, runPayments } from "./payments.js";
import { invoiceCaption, noteInvoice } from "./notes.js";
import { SERVICES } from "./invoice.js";

/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» (26.10.2026, `zakaz1c/`). Без БД і мережі: межі модуля — чисті функції, і гейти ганяють рівно їх.
 * Кожна заборона має пару-дозвіл (дзеркальність): інакше «відхиляє все» виглядало б як надійність.
 */
const WIDGET = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "widget", p), "utf8");

const ENV = { secret: "s3cret-for-tests", clientUuid: "11111111-2222-3333-4444-555555555555", accountId: 10847791 };
const NOW = 1_800_000_000;
const sign = (over: Record<string, unknown> = {}, secret = ENV.secret) => jwt.sign({
  iss: "https://utsercice.amocrm.com", aud: "dashboard.uts.ua", jti: "x", iat: NOW - 10, nbf: NOW - 10, exp: NOW + 1800,
  account_id: ENV.accountId, subdomain: "utsercice", client_uuid: ENV.clientUuid, user_id: 904923, is_admin: true, ...over,
}, secret, { algorithm: "HS256", noTimestamp: true });

test("#7100 ПІДПИС KOMMO: свій токен пускає; чужий секрет, прострочений, інша інтеграція, інший акаунт — ні", () => {
  const ok = verifyKommoToken(sign(), ENV, NOW);
  assert.deepEqual(ok, { ok: true, caller: { userId: 904923, accountId: 10847791, isAdmin: true } });
  assert.equal(verifyKommoToken(sign({}, "чужий-секрет"), ENV, NOW).ok, false, "підпис іншим секретом пройшов");
  assert.equal(verifyKommoToken(sign({ exp: NOW - 120 }), ENV, NOW).ok, false, "прострочений токен пройшов");
  assert.equal(verifyKommoToken(sign({ client_uuid: "інша-інтеграція" }), ENV, NOW).ok, false, "токен іншої інтеграції пройшов");
  assert.equal(verifyKommoToken(sign({ account_id: 1 }), ENV, NOW).ok, false, "токен іншого акаунта пройшов");
  assert.equal(verifyKommoToken(sign({ user_id: 0 }), ENV, NOW).ok, false, "токен без користувача пройшов");
  assert.equal(verifyKommoToken(sign(), { ...ENV, secret: "" }, NOW).ok, false, "без налаштованого секрету пройшло");
  // HS256 і лише він: токен `alg: none` не має проходити навіть із правильними полями.
  const none = jwt.sign({ client_uuid: ENV.clientUuid, account_id: ENV.accountId, user_id: 1, exp: NOW + 60 }, "", { algorithm: "none" as never });
  assert.equal(verifyKommoToken(none, ENV, NOW).ok, false, "токен alg:none пройшов");
});

test("#7101 МІДЛВАР ВХОДУ: без X-Auth-Token — 401 і далі нічого; з валідним — пускає і знає користувача", () => {
  const saved = { ...process.env };
  try {
    process.env.ZAKAZ1C_KOMMO_SECRET = ENV.secret;
    process.env.ZAKAZ1C_KOMMO_CLIENT_UUID = ENV.clientUuid;
    const res = () => { const r: any = { code: 0, body: null }; r.status = (c: number) => { r.code = c; return r; }; r.json = (b: unknown) => { r.body = b; return r; }; return r; };
    let nexted = false;
    const r1 = res();
    // Токен дашборда (Bearer) нічого не відкриває: межа — лише підпис Kommo.
    requireKommoCaller({ headers: { authorization: "Bearer будь-який-токен-дашборда" } } as any, r1, () => { nexted = true; });
    assert.equal(r1.code, 401);
    assert.equal(nexted, false, "без підпису Kommo запит пішов далі");
    const fresh = jwt.sign({ account_id: ENV.accountId, client_uuid: ENV.clientUuid, user_id: 42, is_admin: false }, ENV.secret,
      { algorithm: "HS256", expiresIn: 600 });
    const req: any = { headers: { "x-auth-token": fresh } };
    requireKommoCaller(req, res(), () => { nexted = true; });
    assert.equal(nexted, true, "валідний токен Kommo не пустило");
    assert.equal(req.kommoCaller.userId, 42);
  } finally {
    process.env = saved;
  }
});

test("#7102 ТЕСТОВИЙ РЕЖИМ: off — нікому; test — лише тестувальник і лише тестовий ЄДРПОУ; live — будь-хто з ЄДРПОУ", () => {
  const base = { edrpou: "00100110", testEdrpou: "00100110", userId: 7, testers: new Set([7]) };
  assert.equal(invoiceAllowed("off", base).ok, false, "у режимі off дозволено");
  assert.equal(invoiceAllowed("test", base).ok, true, "тестувальнику на тестовий ЄДРПОУ не дозволено");
  assert.equal(invoiceAllowed("test", { ...base, edrpou: "12345678" }).ok, false, "тестовий режим пустив справжнього контрагента");
  assert.equal(invoiceAllowed("test", { ...base, userId: 8 }).ok, false, "тестовий режим пустив не тестувальника");
  assert.equal(invoiceAllowed("live", { ...base, edrpou: "12345678", userId: 8, testers: new Set() }).ok, true, "live не пустив");
  assert.equal(invoiceAllowed("live", { ...base, edrpou: "" }).ok, false, "рахунок без ЄДРПОУ дозволено");
  // Порожній список тестувальників — будь-хто, але межа ЄДРПОУ стоїть (вкладка всім, рішення Романа 28.10.2026).
  const open = { ...base, userId: 8, testers: new Set<number>() };
  assert.equal(invoiceAllowed("test", open).ok, true, "з порожнім списком тестувальників не пустило");
  assert.equal(invoiceAllowed("test", { ...open, edrpou: "12345678" }).ok, false, "порожній список тестувальників пустив справжнього контрагента");
  // Перемикач за замовчуванням — вимкнено: невідоме значення не вмикає модуль.
  assert.equal(zakaz1cMode({} as NodeJS.ProcessEnv), "off");
  assert.equal(zakaz1cMode({ ZAKAZ1C_MODE: "yes" } as NodeJS.ProcessEnv), "off");
  assert.equal(zakaz1cMode({ ZAKAZ1C_MODE: "TEST" } as NodeJS.ProcessEnv), "test");
});

const TODAY = "2026-10-28";
const ORGS = orgRules();
const ctx = { today: TODAY, orgs: ORGS };
const FORM = {
  org: "avtomuv", agreement: "", currency: "EUR", vatType: "Без ПДВ", discount: 100, invoiceDate: "2026-01-01",
  dueDate: "2026-11-04", actDate: "2026-10-30", crmComment: "клієнт просив до пʼятниці", bank: "", stamp: false,
  items: [{ service: "Організація міжнародного перевезення", route: "м. Praha (CZ) – м. Київ (Київська обл.)", qty: 1, price: 1800, vat: 0 }],
};

test("#7103 ФОРМА → 1С: валюта, організація, ПДВ, знижка, позиції, печатка й deal_id доходять; контрагент — лише від сервера", () => {
  const p = parseInvoiceForm({ ...FORM, customer_edrpou: "99999999", customer_uid: "чужий" }, ctx);
  assert.equal(p.ok, true, p.ok ? "" : p.why);
  if (!p.ok) return;
  const body = buildCreateInvoiceBody(62752319, p.form, { customerUid: "00cb6b57-6007-11f1-b5de-000d181848ac", manager: "Федькевич Яна",
    today: TODAY, orgCode: "000000004" });
  const raw = body as Record<string, unknown>; // перевірки «поля немає» — по сирому обʼєкту: `in` звужує тип тіла до never
  assert.equal(body.currency, "EUR");
  assert.equal(body.organization, "000000004", "організація пішла не кодом 1С");
  assert.equal(body.vat_type, "Без ПДВ");
  assert.equal(body.discount, 0, "знижка з вікна дійшла до 1С — у вікні її немає (Сергій, 28.10.2026)");
  assert.equal(body.stamp, false);
  assert.equal(body.deal_id, "62752319", "без deal_id 1С створить дубль при повторному натисканні");
  assert.equal(body.customer_uid, "00cb6b57-6007-11f1-b5de-000d181848ac", "контрагент узявся не від сервера");
  assert.ok(!("customer_edrpou" in raw), "код контрагента з браузера потрапив у запит до 1С");
  assert.equal(body.invoice_date, TODAY, "дата рахунку взялась із вікна, а не «сьогодні» сервера");
  assert.equal(body.due_date, "2026-11-04");
  assert.equal(body.comment, "Федькевич Яна, Загружен из amoCRM по сделке №62752319", "коментар не як у Genesis");
  assert.ok(!("order_date" in raw), "order_date 1С допише в коментар — і той перестане бути як у Genesis");
  assert.equal(body.items.length, 1);
  assert.deepEqual([body.items[0].name, body.items[0].content, body.items[0].price, body.items[0].code],
    ["Організація міжнародного перевезення", "м. Praha (CZ) – м. Київ (Київська обл.)", 1800, "000000179"]);
  assert.equal(body.pdf, true);
  // Кожна послуга — своїм кодом 1С (відповідь 1С 28.10.2026): за назвою «Експедиторські послуги» 1С не знаходить.
  assert.deepEqual(SERVICES.map((x) => x.code), ["000000092", "000000008", "000000179", "000000252", "000000180"], "коди послуг не ті, що дала 1С");
  const allSvc = parseInvoiceForm({ ...FORM, items: ["Організація перевезення за маршрутом", "Експедиторські послуги",
    "Штрафні санкції за простій автомобільного транспорту"].map((service) => ({ service, route: "", qty: 1, price: 10, vat: 0 })) }, ctx);
  assert.ok(allSvc.ok);
  if (allSvc.ok) {
    const codes = buildCreateInvoiceBody(1, allSvc.form, { customerUid: "u", manager: "", today: TODAY, orgCode: "000000004" }).items.map((i) => i.code);
    assert.deepEqual(codes, ["000000008", "000000252", "000000180"], "код послуги загубився дорогою в 1С");
  }
  // Чого 1С ще не приймає — не шлемо (і не вдаємо, що шлемо); воно лежить у формі для журналу.
  for (const k of ["act_date", "crm_comment", "bank_account", "deal_fields"]) assert.ok(!(k in raw), `${k} пішло в 1С, якої там ще немає`);
  assert.equal(p.form.actDate, "2026-10-30", "дату акту загублено, а не збережено для журналу");
  assert.equal(p.form.crmComment, "клієнт просив до пʼятниці");
  // Без менеджера коментар лишається Genesis-подібним, без «undefined, ».
  assert.equal(genesisComment("", 5), "Загружен из amoCRM по сделке №5");
  // Дзеркало перевірок форми: невалідне відхиляється з поясненням, валідне — проходить (вище).
  assert.equal(parseInvoiceForm({ ...FORM, currency: "GBP" }, ctx).ok, false, "непідтримувану валюту пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, org: "ФОП Невідомий" }, ctx).ok, false, "організацію не зі списку пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, items: [] }, ctx).ok, false, "рахунок без позицій пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, items: [{ ...FORM.items[0], price: 0 }] }, ctx).ok, false, "нульову ціну пропущено");
});

test("#7104 ВІДПОВІДЬ 1С: state:false — помилка словами; рахунок — номер, uid, existed і PDF з base64", () => {
  const bad = fromCreateInvoiceReply({ state: false, message: "Контрагента з ЄДРПОУ 99999999 не знайдено в 1С" });
  assert.deepEqual(bad, { ok: false, why: "1С: Контрагента з ЄДРПОУ 99999999 не знайдено в 1С" });
  const pdf = Buffer.from("%PDF-1.7 test").toString("base64");
  const ok = fromCreateInvoiceReply({ state: true, existed: true, invoice_number: "000008871", invoice_number_print: "8871",
    invoice_uid: "cc04a01e-d0bc-11f1-b5e5-000d181848ac", invoice_date_iso: "2026-10-25T23:41:17", currency: "EUR", total: 1800,
    organization: { name: "ТОВ \"АвтоМув\"" }, warnings: ["договір створено"], print_form: { file_name: "invoice_8871.pdf", body: pdf } });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.invoice.numberPrint, "8871");
  assert.equal(ok.invoice.existed, true);
  assert.equal(ok.invoice.uid, "cc04a01e-d0bc-11f1-b5e5-000d181848ac");
  assert.equal(ok.invoice.pdf?.bytes.subarray(0, 4).toString(), "%PDF");
  assert.deepEqual(ok.invoice.warnings, ["договір створено"]);
  assert.equal(fromCreateInvoiceReply({ state: true }).ok, false, "відповідь без номера прийнято за рахунок");
});

test("#7105 ВІДЖЕТ: вкладка card_sdk + lcard-0, `{}` лише тестувальникам, запити лише підписаним каналом, секретів немає", () => {
  const manifest = JSON.parse(WIDGET("manifest.json"));
  assert.ok(manifest.locations.includes("card_sdk") && manifest.locations.includes("lcard-0"), "без card_sdk/lcard-0 вкладки не буде");
  assert.equal(JSON.parse(WIDGET("i18n/ru.json")).widget.name, "ТЕСТ ЗАКАЗ 1С");
  const js = WIDGET("script.js");
  assert.match(js, /if \(!allowedHere\(\)\) return Promise\.resolve\(\[\]\);/, "не-тестувальнику вкладка не прибирається");
  assert.match(js, /return t\.length === 0 \|\| t\.indexOf\(me\(\)\) !== -1;/, "порожній список тестувальників не відкриває вкладку всім");
  assert.match(js, /return Promise\.resolve\(\{\}\);/, "тестувальнику вкладка не тримається (`{}`)");
  assert.match(js, /self\.\$authorizedAjax\(/, "запити йдуть не підписаним каналом Kommo");
  assert.doesNotMatch(js, /\$\.ajax\(|fetch\(/, "є запит повз $authorizedAjax — без підпису сервер його відхилить, а якщо ні — це діра");
  assert.doesNotMatch(js, /secret|Bearer|api[_-]?key/i, "у віджеті є щось схоже на ключ");
});

test("#7106 ОПЛАТИ → УГОДА: сума по валютах, «оплачено» лише без неоплачених рахунків, етап лише ВПЕРЕД і лише з етапів до «Оплата отримана»", () => {
  const base = { dealId: 1, pipelineId: 8921932, statusId: 69716312, payments: [{ sum: 28000, currency: "UAH" }], unpaidInvoices: 0 };
  assert.deepEqual(planPayment(base), { dealId: 1, paidText: "28000", fullyPaid: true, moveTo: 69716460 });
  assert.equal(planPayment({ ...base, payments: [] }), null, "без оплат щось пишеться");
  assert.equal(planPayment({ ...base, payments: [{ sum: 1000.5, currency: "UAH" }, { sum: 500, currency: "UAH" }] })!.paidText, "1500.50");
  assert.equal(planPayment({ ...base, payments: [{ sum: 1800, currency: "EUR" }, { sum: 500, currency: "UAH" }] })!.paidText, "1800 EUR + 500 UAH");
  const partial = planPayment({ ...base, unpaidInvoices: 1 })!;
  assert.equal(partial.fullyPaid, false, "з неоплаченим рахунком угода вважається оплаченою");
  assert.equal(partial.moveTo, null, "часткова оплата рухає етап");
  for (const st of [142, 143, 69716460]) assert.equal(planPayment({ ...base, statusId: st })!.moveTo, null, `етап ${st} зрушено`);
  assert.equal(planPayment({ ...base, pipelineId: 8921936, statusId: 69693696 })!.moveTo, null, "рух в іншій воронці");
  assert.equal(planPayment({ ...base, pipelineId: 155304, statusId: 25044997 })!.moveTo, PAID_STAGE[155304], "стара воронка не рухається");
  assert.ok(!BEFORE_PAID[8921932].has(PAID_STAGE[8921932]), "«Оплата отримана» стоїть у переліку етапів ДО неї");
  // Що піде в Kommo: галочку лише ставимо, етап — лише з moveTo.
  const pFull = patchOf(planPayment(base)!, 8921932);
  assert.deepEqual(pFull.custom_fields_values!.map((f) => f.field_id), [2096323, 2096325]);
  assert.equal(pFull.status_id, 69716460);
  const pPart = patchOf(partial, 8921932);
  assert.deepEqual(pPart.custom_fields_values!.map((f) => f.field_id), [2096323], "без повної оплати пишеться галочка");
  assert.equal(pPart.status_id, undefined, "без повної оплати пишеться етап");
});

test("#7107 ПОКИ ПРАЦЮЄ GENESIS (ZAKAZ1C_FIELDS_MODE=off) — у Kommo ані запиту; план рахується й лягає в журнал", async () => {
  assert.equal(zakaz1cFieldsMode({} as NodeJS.ProcessEnv), "off", "типово пише в поля Genesis");
  assert.equal(zakaz1cFieldsMode({ ZAKAZ1C_FIELDS_MODE: "on" } as NodeJS.ProcessEnv), "off", "невідоме значення ввімкнуло запис");
  const saved = { mode: process.env.ZAKAZ1C_FIELDS_MODE, fetch: globalThis.fetch };
  let fetches = 0;
  const queries: string[] = [];
  globalThis.fetch = (async () => { fetches++; throw new Error("мережа в тесті заборонена"); }) as typeof fetch;
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (/FROM c LEFT JOIN deals/.test(sql)) return { rows: [{ deal_id: "62771111", pipeline_id: 8921932, status_id: 69716312,
        pays: [{ sum: "28000", currency: "UAH" }], unpaid: 0, genesis_paid1c: true }] };
      return { rows: [] };
    },
  };
  try {
    delete process.env.ZAKAZ1C_FIELDS_MODE;
    const r = await runPayments(pool as never);
    assert.equal(fetches, 0, "у режимі off був запит у мережу (Kommo)");
    assert.deepEqual({ deals: r.deals, fullyPaid: r.fullyPaid, moves: r.moves, written: r.written, mode: r.mode, agree: r.genesisAgree },
      { deals: 1, fullyPaid: 1, moves: 1, written: 0, mode: "off", agree: 1 });
    assert.ok(queries.some((q) => /INSERT INTO zakaz_onec_pay_plan\b(?!_)/.test(q)), "план не записано в журнал");
    // Дзеркало: у live той самий план ІДЕ в Kommo (інакше «off» нічого б не доводив).
    process.env.ZAKAZ1C_FIELDS_MODE = "live";
    process.env.ZAKAZ1C_KOMMO_TOKEN = "t";
    await runPayments(pool as never).catch(() => undefined);
    assert.ok(fetches > 0, "у режимі live запиту в Kommo не було");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.mode === undefined) delete process.env.ZAKAZ1C_FIELDS_MODE; else process.env.ZAKAZ1C_FIELDS_MODE = saved.mode;
    delete process.env.ZAKAZ1C_KOMMO_TOKEN;
  }
});

test("#7109 ПРАВИЛА ОРГАНІЗАЦІЙ: ЮТС лише з ПДВ, АвтоМув лише без, послуга — своя, «Оплатити до» не в минулому; Єлогіст — з кодом, ФОП — чекає банку", () => {
  const uts = { ...FORM, org: "uts", currency: "UAH", vatType: "ПДВ в тому числі",
    items: [{ service: "Організація перевезення в межах території України за маршрутом", route: "м. Київ – м. Львів", qty: 1, price: 30000, vat: 20 }] };
  // Дозволи — по обидва боки кожної межі.
  assert.equal(parseInvoiceForm(uts, ctx).ok, true, "ЮТС з ПДВ і своєю послугою не пройшов");
  assert.equal(parseInvoiceForm(FORM, ctx).ok, true, "АвтоМув без ПДВ з міжнародною не пройшов");
  assert.equal(parseInvoiceForm({ ...uts, items: [{ ...uts.items[0], service: "Експедиторські послуги" }] }, ctx).ok, true, "спільну послугу ЮТС не пустило");
  assert.equal(parseInvoiceForm({ ...FORM, dueDate: TODAY }, ctx).ok, true, "«Оплатити до» сьогодні не пустило");
  assert.equal(parseInvoiceForm({ ...FORM, dueDate: "" }, ctx).ok, true, "порожнє «Оплатити до» (1С візьме з договору) не пустило");
  // Заборони.
  assert.equal(parseInvoiceForm({ ...uts, vatType: "Без ПДВ" }, ctx).ok, false, "ЮТС без ПДВ пройшов");
  assert.equal(parseInvoiceForm({ ...uts, vatType: "ПДВ зверху" }, ctx).ok, false, "ЮТС з «ПДВ зверху» пройшов — його прибрали");
  assert.equal(parseInvoiceForm({ ...uts, items: [{ ...uts.items[0], vat: 0 }] }, ctx).ok, false, "ЮТС зі ставкою 0 % пройшов");
  assert.equal(parseInvoiceForm({ ...FORM, vatType: "ПДВ в тому числі" }, ctx).ok, false, "АвтоМув з ПДВ пройшов");
  assert.equal(parseInvoiceForm({ ...FORM, items: [{ ...FORM.items[0], vat: 20 }] }, ctx).ok, false, "АвтоМув зі ставкою 20 % пройшов");
  assert.equal(parseInvoiceForm({ ...uts, items: [{ ...uts.items[0], service: "Організація міжнародного перевезення" }] }, ctx).ok, false,
    "ЮТС з послугою АвтоМува пройшов");
  assert.equal(parseInvoiceForm({ ...FORM, items: [{ ...FORM.items[0], service: "Будь-що" }] }, ctx).ok, false, "послуга не зі списку пройшла");
  assert.equal(parseInvoiceForm({ ...FORM, dueDate: "2026-10-27" }, ctx).ok, false, "«Оплатити до» вчора пройшло");
  // Єлогіст (код 000000012): правила ЮТС — з ПДВ і своєю послугою проходить, без ПДВ — ні.
  const el = { ...uts, org: "elogist" };
  assert.equal(parseInvoiceForm(el, ctx).ok, true, "Єлогіст з ПДВ не пройшов");
  assert.equal(parseInvoiceForm({ ...el, vatType: "Без ПДВ" }, ctx).ok, false, "Єлогіст без ПДВ пройшов");
  // ФОП: 1С ще не приймає вибір банку → недоступний навіть із банком.
  const fop = parseInvoiceForm({ ...FORM, org: "fop", bank: "monobank", items: [{ ...FORM.items[0], service: "Організація перевезення за маршрутом" }] }, ctx);
  assert.ok(!fop.ok && /банк/.test(fop.why), "ФОП пройшов, хоча 1С обрала б банк сама");
  assert.deepEqual(ORGS.map((o) => [o.key, o.code]), [["uts", "000000002"], ["elogist", "000000012"], ["avtomuv", "000000004"], ["fop", null]],
    "коди організацій 1С не ті, що дала 1С");
});

test("#7110 ОПЛАТА РАХУНКУ І «ЗМІНИТИ»: стан — зі знімка неоплачених 1С; змінити — лише в день виставлення і без оплати", () => {
  const created = new Date("2026-10-28T09:00:00Z"), after = new Date("2026-10-28T10:15:00Z"), before = new Date("2026-10-28T08:15:00Z");
  const inv = { createdAt: created, total: 1800 };
  const c = (o: Partial<{ syncedAt: Date | null; dealPaid: number }>) => ({ syncedAt: after, dealPaid: 0, today: TODAY, ...o });
  assert.equal(payStateOf(inv, { paid: 0, remaining: 1800, due: "2026-11-04" }, c({})).k, "unpaid");
  assert.equal(payStateOf(inv, { paid: 500, remaining: 1300, due: "2026-11-04" }, c({})).k, "part");
  assert.equal(payStateOf(inv, { paid: 0, remaining: 1800, due: "2026-10-27" }, c({})).k, "overdue");
  assert.deepEqual(payStateOf(inv, null, c({ dealPaid: 1800 })), { k: "paid", paid: 1800, remaining: 0 });
  // Немає в знімку — ще НЕ означає «оплачено»: без оплати угоди — «немає серед неоплачених»; знімок старший — «оновиться».
  assert.equal(payStateOf(inv, null, c({ dealPaid: 0 })).k, "missing", "рахунок без оплат угоди зараховано оплаченим");
  assert.equal(payStateOf(inv, null, c({ syncedAt: before, dealPaid: 1800 })).k, "pending", "знімок до рахунку прочитано як «оплачено»");
  assert.equal(payStateOf(inv, null, c({ syncedAt: null })).k, "pending");
  // «Змінити»: дозвіл — сьогодні й без оплати; заборона — вчора, частково, оплачено, невідомо.
  const unpaid = payStateOf(inv, { paid: 0, remaining: 1800, due: null }, c({}));
  assert.equal(canEdit(TODAY, unpaid, TODAY), true, "сьогоднішній неоплачений рахунок не можна змінити");
  assert.equal(canEdit(TODAY, payStateOf(inv, null, c({ syncedAt: before })), TODAY), true, "свіжий рахунок до синку не можна змінити");
  assert.equal(canEdit("2026-10-27", unpaid, TODAY), false, "вчорашній рахунок можна змінити");
  assert.equal(canEdit(TODAY, payStateOf(inv, { paid: 500, remaining: 1300, due: null }, c({})), TODAY), false, "частково оплачений можна змінити");
  assert.equal(canEdit(TODAY, payStateOf(inv, null, c({ dealPaid: 1800 })), TODAY), false, "оплачений можна змінити");
  assert.equal(canEdit(TODAY, payStateOf(inv, null, c({})), TODAY), false, "рахунок, якого немає серед неоплачених, можна змінити");
});

test("#7116 ЧОГО 1С НЕ ВМІЄ — НЕ ВДАЄМО: другий рахунок відхиляється до запиту в 1С, «+ ще рахунок», «Змінити», акт — сірі з причиною; ТТН у вікні немає", () => {
  const mount = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "mount.ts"), "utf8");
  const create = mount.slice(mount.indexOf('r.post("/lead/:leadId/invoice"'), mount.indexOf('r.get("/lead/:leadId/invoice/:uid/pdf"'));
  const refuse = create.search(/listInvoices\(pool, leadId, today\)\)\.length > 0\) return res\.status\(409\)\.json\(\{ error: ONEC_WAITS\.multi \}\)/);
  assert.ok(refuse > 0, "другий рахунок в угоді не відхиляється — 1С повернула б перший, а вікно показало б його як новий");
  assert.ok(refuse < create.indexOf("createInvoiceIn1c("), "відмова в другому рахунку стоїть ПІСЛЯ запиту в 1С");
  assert.doesNotMatch(mount, /\/ttn"|buildTtn|constructor/, "ТТН знову береться з Конструктора, а не з 1С");
  const js = WIDGET("script.js");
  assert.match(js, /<button class='btn link' disabled title='" \+ esc\(d\.waits\.multi\) \+ "'/, "«+ ще рахунок» не сіре");
  assert.match(js, /inv\.can_edit\s*\n?\s*\? "<button class='btn sm dash' disabled title='" \+ esc\(state\.data\.waits\.update\)/, "«Змінити» не сіре до методу 1С");
  assert.match(js, /data-z1c='req'/, "немає запиту бухгалтерії для рахунку, який змінювати вже не можна");
  assert.equal((js.match(/disabled title='Зʼявиться, коли бухгалтерія проведе реалізацію в 1С'>Акт</g) ?? []).length, 1, "Акт не сірий");
  assert.doesNotMatch(js, />ТТН</, "у вікні знову є кнопка ТТН — ТТН формують у Конструкторі (рішення Романа 30.10.2026)");
  assert.doesNotMatch(js, /"\/lead\/" \+ leadId\(\) \+ "\/ttn"/, "вікно знову качає ТТН через модуль");
});

test("#7112 ПІДМІНА ПОСЛУГИ: 1С поставила іншу номенклатуру — менеджер бачить попередження; та сама — тиша", () => {
  assert.deepEqual(serviceSwaps(["Експедиторські послуги"], ["Експедиторські послуги"]), []);
  const w = serviceSwaps(["Штрафні санкції за простій автомобільного транспорту"], ["Організація перевезення в межах території України за маршрутом"]);
  assert.equal(w.length, 1, "підміну послуги проковтнуто");
  assert.match(w[0], /Штрафні санкції/);
  assert.deepEqual(serviceSwaps(["а"], []), [], "порожня відповідь 1С прочитана як підміна");
  const r = fromCreateInvoiceReply({ state: true, invoice_number: "1", invoice_uid: "u", items: [{ name: "Х" }] });
  assert.ok(r.ok && r.invoice.itemNames[0] === "Х", "номенклатуру з відповіді 1С не прочитано");
});

test("#7113 КОНТРАГЕНТ: 8 цифр — ЄДРПОУ, 10 — ІПН ФОП (і в customerInfo, і в createCustomer); інший код — відмова", async () => {
  const u = buildCreateCustomerBody({ name: "ТОВ Ромашка", code: "12345678" }, "Федькевич Яна");
  assert.deepEqual(u, { ok: true, body: { name: "ТОВ Ромашка", edrpou: "12345678", manager: "Федькевич Яна" } });
  const f = buildCreateCustomerBody({ name: "ФОП Іваненко", code: "1234567890" }, "");
  assert.deepEqual(f, { ok: true, body: { name: "ФОП Іваненко", inn: "1234567890" } }, "ФОП пішов не як inn");
  assert.equal(buildCreateCustomerBody({ name: "Х", code: "123" }, "").ok, false, "код не 8 і не 10 цифр пройшов");
  assert.equal(buildCreateCustomerBody({ name: " ", code: "12345678" }, "").ok, false, "контрагент без назви пройшов");
  const urls: string[] = [];
  const fake = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ state: true, uid: "U1", name: "Н",
    agreements: [{ uid: "A1", name: "Основний", currency: "UAH", organization: "ТОВ \"АвтоМув\"" }] }), { status: 200 }); }) as never;
  const fopInfo = await customerInfoFrom1c("http://1c", "1234567890", fake);
  const legal = await customerInfoFrom1c("http://1c", "12345678", fake);
  assert.match(urls[0], /customerInfo\?inn=1234567890$/, "ФОП шукається не за inn — 1С його не знайде");
  assert.match(urls[1], /customerInfo\?edrpou=12345678$/);
  assert.deepEqual([fopInfo.found, fopInfo.uid, legal.agreements[0].organization], [true, "U1", "ТОВ \"АвтоМув\""]);
  assert.equal((await customerInfoFrom1c("http://1c", "", fake)).found, false);
  assert.equal(urls.length, 2, "порожній код усе одно пішов у 1С");
});

const NOTE = { testMode: true, numberPrint: "9043", date: "2026-10-29T17:57:18", orgShort: "ЮТС", total: 1000, currency: "UAH" };

test("#7114 PDF У СТРІЧЦІ: після рахунку — запис саме з файлом, у назві номер, дата, організація й сума", async () => {
  assert.equal(invoiceCaption(NOTE), "[ТЕСТ] Рахунок 1С №9043 від 29.10.2026 · ЮТС · 1000 UAH");
  assert.equal(invoiceCaption({ ...NOTE, testMode: false }).startsWith("Рахунок 1С №9043"), true, "у live лишилась мітка [ТЕСТ]");
  const files: { uuid: string; versionUuid: string; name: string }[] = [], texts: string[] = [];
  const r = await noteInvoice(NOTE, { uuid: "F1", versionUuid: "V1" }, { fileNote: async (f) => { files.push(f); }, textNote: async (t) => { texts.push(t); } });
  assert.deepEqual(r, { kind: "file" });
  assert.deepEqual(files, [{ uuid: "F1", versionUuid: "V1", name: "[ТЕСТ] Рахунок 1С №9043 від 29.10.2026 · ЮТС · 1000 UAH.pdf" }],
    "у стрічку пішов не запис з файлом або без номера рахунку");
  assert.deepEqual(texts, [], "поряд із записом з файлом пішов ще й текстовий — у стрічці буде дубль");
  const mount = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "mount.ts"), "utf8");
  assert.match(mount, /noteInvoice\(/, "створення рахунку не пише запис з файлом у стрічку");
});

test("#7115 ЗАПАСНИЙ ЗАПИС: файл не завантажився або Kommo відмовив у вкладенні — у стрічці однаково лишається текстовий слід", async () => {
  const texts: string[] = [];
  const t = async (x: string) => { texts.push(x); };
  const noFile = await noteInvoice(NOTE, null, { fileNote: async () => { throw new Error("не має викликатись"); }, textNote: t });
  assert.equal(noFile.kind, "text");
  assert.match(texts[0], /№9043.*PDF не прикріпився/, "без PDF текстовий запис не каже, що файлу немає");
  const refused = await noteInvoice(NOTE, { uuid: "F1", versionUuid: "" }, { fileNote: async () => { throw new Error("400"); }, textNote: t });
  assert.equal(refused.kind, "text", "відмова Kommo у вкладенні не дала запасного текстового запису");
  assert.equal(texts[1], "[ТЕСТ] Рахунок 1С №9043 від 29.10.2026 · ЮТС · 1000 UAH");
  const none = await noteInvoice(NOTE, null, { fileNote: async () => undefined, textNote: async () => { throw new Error("500"); } });
  assert.equal(none.kind, "none", "збій обох записів не повернувся як помилка — вікно сказало б, що все гаразд");
});
