import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { verifyKommoToken, requireKommoCaller } from "./kommoAuth.js";
import {
  actPdfFrom1c, actRefusal, buildCreateCustomerBody, buildCreateInvoiceBody, buildUpdateInvoiceBody, canEdit, customerInfoFrom1c, dealFieldsOf,
  fromCreateInvoiceReply, genesisComment, invoiceAllowed, orgRules, parseInvoiceForm, parseOrganizations, payStateOf, serviceSwaps,
  type BankAccount,
} from "./invoice.js";
import { WIDGET_TAG, claimPatch, dealOwner } from "./owner.js";
import { writable } from "./payments.js";
import { PAID_TAG, dealPayState, decidePayment, parseEvent, webhookKeyOk, type PaymentEvent } from "./events.js";
import { isNetError, withNetRetry } from "./kommoApi.js";
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
const FOP_BANKS: BankAccount[] = [
  { uid: "B-MONO", name: "Текущий в Монобанк", iban: "UA84…", currency: "UAH", bank: "Монобанк", isMain: false },
  { uid: "B-PRIV", name: "Текущий в АТ КБ «ПРИВАТБАНК»", iban: "UA70…", currency: "UAH", bank: "АТ КБ «ПРИВАТБАНК»", isMain: false },
];
const ctxBanks = { ...ctx, banksOf: (code: string) => (code === "000000011" ? FOP_BANKS : []) };
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
  // Банк — лише в організації, якій він потрібен (ФОП); тут АвтоМув — `bank_account` не йде.
  assert.ok(!("bank_account" in raw), "банк пішов у рахунок організації, де його не обирають");
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

test("#7124 ПРАВИЛА ОРГАНІЗАЦІЙ: ЮТС і Єлогіст лише з ПДВ, АвтоМув і ФОП лише без, послуга — своя, «Оплатити до» не в минулому; ФОП — Беспятчук 000000011", () => {
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
  // ФОП Беспятчук — без ПДВ (з ПДВ — ні); банк перевіряє #7119.
  const fopForm = { ...FORM, org: "fop", currency: "UAH", bankUid: "B-MONO", items: [{ ...FORM.items[0], service: "Організація перевезення за маршрутом" }] };
  assert.equal(parseInvoiceForm(fopForm, ctxBanks).ok, true, "ФОП без ПДВ з банком не пройшов");
  assert.equal(parseInvoiceForm({ ...fopForm, vatType: "ПДВ в тому числі" }, ctxBanks).ok, false, "ФОП з ПДВ пройшов");
  assert.deepEqual(ORGS.map((o) => [o.key, o.code]), [["uts", "000000002"], ["elogist", "000000012"], ["avtomuv", "000000004"], ["fop", "000000011"]],
    "коди організацій 1С не ті, що дала 1С / Сергій");
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

test("#7112 ПІДМІНА ПОСЛУГИ: 1С поставила іншу номенклатуру — менеджер бачить попередження; та сама — тиша", () => {
  // Звіряємо КОДИ: назва «Експедиторські послуги» в 1С з латинською «i» — за назвою це була б хибна тривога щоразу.
  assert.deepEqual(serviceSwaps([{ name: "Експедиторські послуги", code: "000000252" }], [{ name: "Eкспедиторськi послуги", code: "000000252" }]), [],
    "та сама послуга (інше написання назви) прочитана як підміна");
  const w = serviceSwaps([{ name: "Штрафні санкції за простій автомобільного транспорту", code: "000000180" }],
    [{ name: "Організація перевезення в межах території України за маршрутом", code: "000000092" }]);
  assert.equal(w.length, 1, "підміну послуги проковтнуто");
  assert.match(w[0], /Штрафні санкції/);
  assert.deepEqual(serviceSwaps([{ name: "а", code: "1" }], []), [], "порожня відповідь 1С прочитана як підміна");
  const r = fromCreateInvoiceReply({ state: true, invoice_number: "1", invoice_uid: "u", items: [{ name: "Х", code: "000000092" }] });
  assert.ok(r.ok && r.invoice.itemNames[0] === "Х" && r.invoice.itemCodes[0] === "000000092", "номенклатуру з відповіді 1С не прочитано");
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

const RID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const MOUNT = () => readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "mount.ts"), "utf8");
const routeSrc = (m: string, from: string, to: string) => m.slice(m.indexOf(from), m.indexOf(to, m.indexOf(from) + 1));

test("#7117 КІЛЬКА РАХУНКІВ В УГОДІ: ключ форми йде в 1С як request_id; без ключа сервер не виставляє; вікно дає новий ключ кожній формі", () => {
  const p = parseInvoiceForm({ ...FORM, requestId: RID }, ctx);
  assert.ok(p.ok);
  if (!p.ok) return;
  const raw = buildCreateInvoiceBody(1, p.form, { customerUid: "u", manager: "", today: TODAY, orgCode: "000000004" }) as Record<string, unknown>;
  assert.equal(raw.request_id, RID, "ключ форми не дійшов до 1С — повтор «Виставити» створив би дубль");
  assert.equal(raw.deal_id, "1", "deal_id загубився — idAMO рахунку буде порожній");
  assert.equal(parseInvoiceForm({ ...FORM, requestId: "не-uuid" }, ctx).ok, false, "зламаний ключ форми пройшов");
  const create = routeSrc(MOUNT(), 'r.post("/lead/:leadId/invoice"', "r.post(");
  assert.match(create, /if \(!form\.requestId\) return res\.status\(400\)/, "без ключа форми рахунок виставляється — захист від дубля зник");
  assert.doesNotMatch(MOUNT(), /ONEC_WAITS\.multi/, "другий рахунок в угоді досі відхиляється");
  const js = WIDGET("script.js");
  assert.match(js, /requestId: uuid\(\)/, "нова форма не отримує нового ключа");
  assert.match(js, /data-z1c='open'[^>]*>\+ ще рахунок</, "«+ ще рахунок» не відкриває форму");
});

test("#7118 «ЗМІНИТИ»: той самий рахунок (invoice_uid), без deal_id і request_id, стерта дата акту очищається; сервер пускає лише сьогодні й без оплати, без зміни організації чи валюти", () => {
  const p = parseInvoiceForm({ ...FORM, actDate: "", crmComment: "" }, ctx);
  assert.ok(p.ok);
  if (!p.ok) return;
  const b = buildUpdateInvoiceBody("cc04a01e-d0bc-11f1-b5e5-000d181848ac", p.form, { manager: "Яна", dealId: 7, orgCode: "000000004" }) as Record<string, any>;
  assert.equal(b.invoice_uid, "cc04a01e-d0bc-11f1-b5e5-000d181848ac");
  assert.ok(!("deal_id" in b) && !("request_id" in b), "зміна несе deal_id/request_id — 1С їх ігнорує, але це ознака плутанини зі створенням");
  assert.deepEqual(b.deal_fields, { act_date: null, act_date_by_manager: false, crm_comment: null }, "стерта дата акту лишилась би в 1С");
  assert.equal(b.comment, "Яна, Загружен из amoCRM по сделке №7", "коментар при зміні перестав бути як у Genesis");
  const upd = routeSrc(MOUNT(), 'r.post("/lead/:leadId/invoice/:uid/update"', "r.get(");
  const call = upd.indexOf("updateInvoiceIn1c(");
  assert.ok(upd.indexOf("if (!row.can_edit) return res.status(409)") > 0 && upd.indexOf("if (!row.can_edit) return res.status(409)") < call,
    "«Змінити» не перевіряє «сьогодні й без оплати» до запиту в 1С");
  assert.ok(upd.indexOf("form.org !== row.org_key || form.currency !== row.currency") > 0 && upd.indexOf("form.org !== row.org_key") < call,
    "зміну організації чи валюти не відсікаємо до запиту в 1С");
  assert.ok(fromCreateInvoiceReply({ state: true, invoice_number: "1", invoice_uid: "u", updated: true, existed: true }).ok);
  assert.match(WIDGET("script.js"), /data-z1c='edit'/, "у вікні немає робочої кнопки «Змінити»");
});

test("#7119 ФОП: без банку не виставляється, банк — лише свій і у валюті рахунку (з /organizations), іде в 1С як bank_account; ЮТС банк не несе", () => {
  const fop = { ...FORM, org: "fop", currency: "UAH", items: [{ ...FORM.items[0], service: "Організація перевезення за маршрутом" }] };
  assert.equal(parseInvoiceForm({ ...fop, bankUid: "" }, ctxBanks).ok, false, "ФОП без банку пройшов — 1С обрала б будь-який");
  assert.equal(parseInvoiceForm({ ...fop, bankUid: "ЧУЖИЙ" }, ctxBanks).ok, false, "чужий банк пройшов");
  assert.equal(parseInvoiceForm({ ...fop, currency: "EUR", bankUid: "B-MONO" }, ctxBanks).ok, false, "банк у гривні пройшов для рахунку в EUR");
  assert.equal(parseInvoiceForm({ ...fop, bankUid: "B-MONO" }, ctx).ok, false, "без рахунків з 1С ФОП пройшов");
  const ok = parseInvoiceForm({ ...fop, bankUid: "B-PRIV" }, ctxBanks);
  assert.ok(ok.ok, ok.ok ? "" : ok.why);
  if (ok.ok) assert.equal((buildCreateInvoiceBody(1, ok.form, { customerUid: "u", manager: "", today: TODAY, orgCode: "000000011" }) as any).bank_account, "B-PRIV");
  const uts = parseInvoiceForm({ ...FORM, org: "uts", currency: "UAH", vatType: "ПДВ в тому числі", bankUid: "B-PRIV",
    items: [{ service: "Експедиторські послуги", route: "", qty: 1, price: 10, vat: 20 }] }, ctxBanks);
  assert.ok(uts.ok && uts.form.bankUid === "", "банк протік у рахунок ЮТС");
  const orgs = parseOrganizations({ state: true, organizations: [{ code: "000000011", bank_accounts: [{ uid: "X", name: "Текущий в Монобанк", currency: "UAH", bank: "Монобанк", is_main: false }] }] });
  assert.deepEqual(orgs?.get("000000011")?.map((b) => [b.uid, b.bank, b.isMain]), [["X", "Монобанк", false]]);
  assert.equal(parseOrganizations({ state: false }), null, "відмова 1С прочитана як порожній список банків");
});

test("#7120 АКТ: not_realized — «ще не сформовано», а не помилка; PDF — лише по рахунку своєї угоди; у файли угоди — один раз; ТТН у вікні немає", async () => {
  assert.deepEqual(actRefusal({ state: false, code: "not_realized" }).ok, false);
  assert.equal((actRefusal({ state: false, code: "not_realized" }) as any).notYet, true, "«ще немає реалізації» прочитано як збій");
  assert.equal((actRefusal({ state: false, code: "multiple_realizations" }) as any).notYet, false);
  const pdf = await actPdfFrom1c("http://1c", "u", false, (async (url: string) => {
    assert.match(url, /realizationPdf\?invoice_uid=u&form=act&format=file&stamp=0$/, "акт запитується не тим методом або з печаткою");
    return new Response(Buffer.from("%PDF-1.7 act"), { status: 200 });
  }) as never);
  assert.ok(pdf.ok, "PDF акту не прочитано");
  const json = await actPdfFrom1c("http://1c", "u", true, (async () => new Response(JSON.stringify({ state: false, code: "not_realized" }), { status: 200 })) as never);
  assert.ok(!json.ok && json.notYet, "відповідь «не проведено» у форматі file не розпізнано");
  const act = routeSrc(MOUNT(), 'r.get("/lead/:leadId/invoice/:uid/act"', "r.post(");
  assert.ok(act.indexOf("own?.leadId !== leadId") > 0 && act.indexOf("own?.leadId !== leadId") < act.indexOf("actPdfFrom1c("), "акт віддається без перевірки, що рахунок з цієї угоди");
  assert.match(act, /attachActOnce\(/, "акт кладеться у файли угоди повз перевірку «вже лежить»");
  assert.match(MOUNT(), /async function attachActOnce\([^)]*\)[^{]*\{\s*if \(await actAttached\(pool, uid\)\) return false;/, "акт кладеться у файли угоди на кожне натискання");
  const js = WIDGET("script.js");
  assert.match(js, /data-z1c='act'/, "у вікні немає кнопки акту");
  assert.doesNotMatch(js, />ТТН</, "у вікні знову є ТТН — її формують у Конструкторі (Роман, 30.10.2026)");
});

test("#7121 ДАТА АКТУ Й КОМЕНТАР → 1С (deal_fields): дата ставить «від менеджера», порожня — нічого; коментар — до 150 символів", () => {
  assert.deepEqual(dealFieldsOf({ actDate: "2026-10-30", crmComment: "" }), { act_date: "2026-10-30", act_date_by_manager: true });
  assert.deepEqual(dealFieldsOf({ actDate: "", crmComment: "" }), {}, "порожня дата поставила «від менеджера» або порожній реквізит");
  assert.deepEqual(dealFieldsOf({ actDate: "", crmComment: "до пʼятниці" }), { crm_comment: "до пʼятниці" });
  const p = parseInvoiceForm({ ...FORM, crmComment: "я".repeat(300) }, ctx);
  assert.ok(p.ok && p.form.crmComment.length === 150, "коментар довший за реквізит 1С (150) — 1С обріже мовчки");
  if (p.ok) assert.deepEqual((buildCreateInvoiceBody(1, p.form, { customerUid: "u", manager: "", today: TODAY, orgCode: "000000004" }) as any).deal_fields,
    { act_date: "2026-10-30", act_date_by_manager: true, crm_comment: "я".repeat(150) }, "дата акту чи коментар не дійшли до 1С");
  const none = parseInvoiceForm({ ...FORM, actDate: "", crmComment: "" }, ctx);
  if (none.ok) assert.ok(!("deal_fields" in buildCreateInvoiceBody(1, none.form, { customerUid: "u", manager: "", today: TODAY, orgCode: "000000004" })),
    "порожній deal_fields пішов у 1С");
});

test("#7122 ОДНА УГОДА — ОДНА СИСТЕМА: чужий «Номер заказа» або чужий рахунок 1С → Genesis; сервер відмовляє до запиту в 1С; своя угода — номер і тег", () => {
  assert.equal(dealOwner({ orderNo: "", ourNumbers: [], onecNumbers: [] }), "free");
  assert.equal(dealOwner({ orderNo: "000009043", ourNumbers: ["000009043"], onecNumbers: ["9043"] }), "widget", "своя угода визнана чужою");
  assert.equal(dealOwner({ orderNo: "000008587", ourNumbers: [], onecNumbers: [] }), "genesis", "угода з «Номером заказа» Genesis визнана вільною");
  assert.equal(dealOwner({ orderNo: "", ourNumbers: [], onecNumbers: ["000008587"] }), "genesis", "угода з рахунком 1С не з журналу визнана вільною");
  assert.equal(dealOwner({ orderNo: "000009043", ourNumbers: ["000009043"], onecNumbers: ["000009043", "000009100"] }), "genesis",
    "угода, куди Genesis дописав свій рахунок, лишилась за віджетом");
  const m = MOUNT();
  for (const [from, to, call] of [['r.post("/lead/:leadId/invoice"', "r.post(", "createInvoiceIn1c("], ['r.post("/lead/:leadId/customer"', "r.post(", "createCustomerIn1c("]] as const) {
    const src = routeSrc(m, from, to);
    const guard = src.indexOf('=== "genesis") return res.status(409)');
    assert.ok(guard > 0 && guard < src.indexOf(call), `${from}: угода Genesis не відсікається до запиту в 1С`);
  }
  assert.deepEqual(claimPatch(5, { orderNo: "", tags: [] }, "000009043"), { id: 5,
    custom_fields_values: [{ field_id: 2096315, values: [{ value: "000009043" }] }], tags_to_add: [{ name: WIDGET_TAG }] });
  assert.equal(claimPatch(5, { orderNo: "000009043", tags: [WIDGET_TAG] }, "000009100"), null, "«Номер заказа» перетерто другим рахунком");
});

test("#7123 ОПЛАТИ В KOMMO, РЕЖИМ own: лише угоди віджета без чужих рахунків; off — нікуди; невідоме значення режиму не вмикає запис", () => {
  const ids = [1, 2, 3];
  assert.deepEqual([...writable("off", ids, new Set([1]))], []);
  assert.deepEqual([...writable("own", ids, new Set([2]))], [2], "у режимі own запис пішов не лише в угоди віджета");
  assert.deepEqual([...writable("own", ids, null)], [], "без переліку угод віджета own писав би всюди");
  assert.deepEqual([...writable("live", ids, null)], ids);
  assert.equal(zakaz1cFieldsMode({ ZAKAZ1C_FIELDS_MODE: "own" } as NodeJS.ProcessEnv), "own");
  assert.equal(zakaz1cFieldsMode({ ZAKAZ1C_FIELDS_MODE: "OWN " } as NodeJS.ProcessEnv), "own");
  assert.equal(zakaz1cFieldsMode({ ZAKAZ1C_FIELDS_MODE: "yes" } as NodeJS.ProcessEnv), "off", "невідоме значення ввімкнуло запис");
  const pay = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "payments.ts"), "utf8");
  assert.match(pay, /ltrim\(di\.number, '0'\) NOT IN \(SELECT ltrim\(z\.number, '0'\) FROM zakaz_onec_invoices z WHERE z\.lead_id = j\.lead_id\)/,
    "до «своїх» угод потрапляють угоди з чужими рахунками 1С");
});

const STORE = () => readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "store.ts"), "utf8");
const PAY_EV = (o: Partial<Record<string, unknown>> = {}) => ({ event: "payment", event_id: "E1", sent_at: "2026-10-30T14:05:12",
  invoice_uid: "c49fc79a-d3a8-11f1-b5e5-000d181848ac", invoice_number: "000009070", deal_id: "62818383", currency: "UAH",
  invoice_total: 1200, paid_total: 1200, remaining: 0, fully_paid: true, realized: false, payment: { sum: 1200 }, ...o });
const ev = (o: Partial<Record<string, unknown>> = {}) => { const p = parseEvent(PAY_EV(o)); assert.ok(p.ok, p.ok ? "" : p.why); return (p as any).ev as PaymentEvent; };
const CTX = { known: true, owner: "widget" as const, writeMode: true, testMode: true, wasFull: false, pipelineId: 8921932, statusId: 69716312, tags: [] as string[] };

test("#7125 ВЕБХУК 1С: вхід лише з ключем X-Api-Key (чужий / порожній — ні, і порожній налаштований ключ не пускає нікого); маршрут — до підпису Kommo", () => {
  assert.equal(webhookKeyOk("k-123", "k-123"), true, "правильний ключ не пустило");
  assert.equal(webhookKeyOk("k-124", "k-123"), false, "чужий ключ пустило");
  assert.equal(webhookKeyOk("", "k-123"), false, "без ключа пустило");
  assert.equal(webhookKeyOk("", ""), false, "незаданий ключ відкрив приймач усім");
  const m = MOUNT();
  const hook = m.indexOf('r.post("/onec/events"'), kommo = m.indexOf("r.use(requireKommoCaller)");
  assert.ok(hook > 0 && hook < kommo, "вебхук стоїть після перевірки підпису Kommo — 1С отримала б 401 завжди");
  const src = routeSrc(m, 'r.post("/onec/events"', "r.use(requireKommoCaller)");
  assert.ok(src.indexOf("if (!key) return res.status(503)") < src.indexOf("webhookKeyOk("), "без налаштованого ключа приймач не закритий");
  assert.ok(src.indexOf("webhookKeyOk(") < src.indexOf("recordEvent("), "подія записується до перевірки ключа");
});

test("#7126 ПОВТОР ПОДІЇ: та сама event_id — 200 без обробки; збій обробки — подію прибрано, 1С повторить; без event_id — відмова", () => {
  assert.equal(parseEvent({ ...PAY_EV(), event_id: "" }).ok, false, "подію без event_id прийнято — повтори не відсіяти");
  const src = routeSrc(MOUNT(), 'r.post("/onec/events"', "r.use(requireKommoCaller)");
  const dup = src.indexOf("if (!(await recordEvent(pool, ev, req.body))) return res.json({ ok: true, duplicate: true })");
  assert.ok(dup > 0 && dup < src.indexOf("handleEvent(ev)"), "повтор події обробляється вдруге — подвійна примітка й запис");
  assert.match(src, /catch \(e\) \{\s*await pool\.query\(`DELETE FROM zakaz_onec_events WHERE event_id = \$1`/, "після збою подія лишилась у журналі — повтор 1С її вже не обробить");
  assert.match(STORE(), /ON CONFLICT \(event_id\) DO NOTHING RETURNING event_id/);
});

test("#7127 СТАН УГОДИ З ПОДІЙ: «Оплачено 1с» — усі рахунки по валютах; «оплачено повністю», тег і етап — лише коли оплачено ВСЕ; стан абсолютний", () => {
  assert.deepEqual(dealPayState([{ currency: "UAH", paidTotal: 1200, fullyPaid: true }, { currency: "UAH", paidTotal: 500, fullyPaid: false }]),
    { paidText: "1700", fullyPaid: false }, "угода з неоплаченим рахунком вважається оплаченою");
  assert.equal(dealPayState([{ currency: "EUR", paidTotal: 100, fullyPaid: true }, { currency: "UAH", paidTotal: 800, fullyPaid: true }]).paidText, "100 EUR + 800 UAH");
  assert.deepEqual(dealPayState([]), { paidText: "0", fullyPaid: false }, "угода без рахунків «оплачена»");
  const full = decidePayment(ev(), { ...CTX, invoices: [{ currency: "UAH", paidTotal: 1200, fullyPaid: true }] });
  assert.deepEqual(full.patch?.custom_fields_values?.map((f) => [f.field_id, f.values[0].value]), [[2096323, "1200"], [2096325, true]]);
  assert.deepEqual(full.patch?.tags_to_add, [{ name: PAID_TAG }], "тег «полная оплата» не ставиться");
  assert.equal(full.patch?.status_id, 69716460, "повна оплата не переводить на «Оплата отримана»");
  assert.match(full.note ?? "", /Оплата 1200 UAH за рахунком 1С №9070 · рахунок оплачено повністю · угоду оплачено повністю/);
  const part = decidePayment(ev({ paid_total: 500, remaining: 700, fully_paid: false, payment: { sum: 500 } }), { ...CTX,
    invoices: [{ currency: "UAH", paidTotal: 500, fullyPaid: false }] });
  assert.deepEqual(part.patch?.custom_fields_values?.map((f) => f.field_id), [2096323], "часткова оплата ставить «Оплачено из 1с»");
  assert.equal(part.patch?.status_id, undefined, "часткова оплата рухає етап");
  assert.equal(decidePayment(ev(), { ...CTX, statusId: 142, invoices: [{ currency: "UAH", paidTotal: 1200, fullyPaid: true }] }).patch?.status_id, undefined,
    "етап «Успішна» зрушено назад на «Оплата отримана»");
  assert.match(STORE(), /AND \(pay_event_at IS NULL OR pay_event_at <= \$6::timestamptz\)/, "старіша подія, що прийшла пізніше, відкотила б свіжіший стан");
});

test("#7128 МЕЖІ ВЕБХУКА: чужий рахунок, угода Genesis або режим off — у Kommo нічого; невідомий рахунок відсікається до будь-якого запису", () => {
  const inv = [{ currency: "UAH", paidTotal: 1200, fullyPaid: true }];
  assert.equal(decidePayment(ev(), { ...CTX, known: false, invoices: inv }).patch, null, "оплату чужого рахунку записано в угоду");
  assert.equal(decidePayment(ev(), { ...CTX, owner: "genesis", invoices: inv }).patch, null, "у угоду Genesis записали оплату — дві системи в одному полі");
  assert.equal(decidePayment(ev(), { ...CTX, writeMode: false, invoices: inv }).patch, null, "у режимі off записали в Kommo");
  assert.ok(decidePayment(ev(), { ...CTX, owner: "free", invoices: inv }).patch, "угоду без чужих рахунків не оновлено");
  const h = MOUNT().slice(MOUNT().indexOf("async function handleEvent("), MOUNT().indexOf("export function buildZakaz1cRouter"));
  const guard = h.indexOf("if (!own || own.leadId !== ev.dealId) return");
  assert.ok(guard > 0 && guard < h.indexOf("applyPaymentEvent(") && guard < h.indexOf("patchLeads("), "подія по чужому рахунку дійшла до запису");
  assert.equal(parseEvent({ ...PAY_EV(), invoice_uid: "не-uid" }).ok, false);
  assert.equal(parseEvent({ ...PAY_EV(), fully_paid: "так" }).ok, false, "fully_paid не булевий — прийнято");
});

test("#7129 СКАСУВАННЯ ОПЛАТИ: угода вже не оплачена повністю → галочку «Оплачено из 1с» і тег «полная оплата» знято; етап назад не рухаємо", () => {
  const c = decidePayment(ev({ event: "payment_cancelled", paid_total: 0, remaining: 1200, fully_paid: false, payment: { sum: 1200 } }),
    { ...CTX, wasFull: true, tags: [PAID_TAG], statusId: 69716460, invoices: [{ currency: "UAH", paidTotal: 0, fullyPaid: false }] });
  assert.deepEqual(c.patch?.custom_fields_values?.map((f) => [f.field_id, f.values[0].value]), [[2096323, "0"], [2096325, false]],
    "після скасування «Оплачено из 1с» лишилась — в угоді неправда");
  assert.deepEqual(c.patch?.tags_to_delete, [{ name: PAID_TAG }], "тег «полная оплата» не знято");
  assert.equal(c.patch?.status_id, undefined, "скасування рухає етап");
  assert.match(c.note ?? "", /скасовано або змінено в 1С · оплачено 0 з 1200 UAH\. Перевірте\./);
  const stillFull = decidePayment(ev(), { ...CTX, wasFull: true, tags: [PAID_TAG], invoices: [{ currency: "UAH", paidTotal: 1200, fullyPaid: true }] });
  assert.equal(stillFull.patch?.tags_to_delete, undefined, "у повністю оплаченої угоди зняли тег");
  assert.equal(stillFull.patch?.tags_to_add, undefined, "тег, що вже стоїть, ставиться вдруге");
});

test("#7130 РЕАЛІЗАЦІЯ: проведено → акт у файлах угоди ОДИН раз (і з кнопки, і з події); скасовано → примітка; угода Genesis — нічого", () => {
  const p = parseEvent({ event: "realization", event_id: "R1", invoice_uid: "c49fc79a-d3a8-11f1-b5e5-000d181848ac", deal_id: "62818383",
    realization_number: "000006327", realization_date: "2026-10-30", posted: true });
  assert.ok(p.ok && p.ev.kind === "realization" && p.ev.posted);
  assert.equal(parseEvent({ event: "realization", event_id: "R2", invoice_uid: "c49fc79a-d3a8-11f1-b5e5-000d181848ac", deal_id: "1" }).ok, false, "реалізація без posted прийнята");
  const m = MOUNT();
  const once = m.slice(m.indexOf("async function attachActOnce("), m.indexOf("async function handleEvent("));
  assert.match(once, /if \(await actAttached\(pool, uid\)\) return false;/, "акт кладеться у файли угоди при кожній події");
  const h = m.slice(m.indexOf("async function handleEvent("), m.indexOf("export function buildZakaz1cRouter"));
  assert.ok(h.indexOf('if (owner === "genesis") return') < h.indexOf("actPdfFrom1c("), "в угоду Genesis кладемо акт");
  assert.match(h, /attachActOnce\(ev\.dealId/);
  assert.match(routeSrc(m, 'r.get("/lead/:leadId/invoice/:uid/act"', "r.post("), /attachActOnce\(/, "кнопка «Акт» кладе акт повз «один раз»");
});

test("#7131 ПЛИТКА «ОПЛАТА» — ВСЯ УГОДА: сума всіх рахунків по валютах, загальний стан, а не останній рахунок", () => {
  const js = WIDGET("script.js");
  assert.match(js, /function dealPay\(\)/, "немає розрахунку оплати по угоді");
  const steps = js.slice(js.indexOf("function steps()"), js.indexOf("function seg("));
  assert.match(steps, /var dp = inv \? dealPay\(\) : null;/, "плитка оплати рахує лише останній рахунок");
  assert.doesNotMatch(steps, /chip\(payChip\(p\)\)/, "у плитці лишився стан одного рахунку");
  assert.match(js, /if \(d\.owner === "genesis"\) \{[\s\S]{0,200}genesisView\(\)/, "угода Genesis показує плитки «рахунку немає»");
});

test("#7132 ОБРИВ ЗВʼЯЗКУ: PDF — ще одна спроба після «fetch failed»; відповідь Kommo з кодом не повторюємо; друга невдача — помилка", async () => {
  let n = 0;
  assert.equal(await withNetRetry(async () => { n++; if (n === 1) throw new TypeError("fetch failed"); return "ok"; }, 0), "ok");
  assert.equal(n, 2, "після обриву не було другої спроби");
  let m = 0;
  await assert.rejects(withNetRetry(async () => { m++; throw new Error("Kommo частина файлу: 400"); }, 0));
  assert.equal(m, 1, "відповідь Kommo з кодом повторено — причина сама не мине");
  let k = 0;
  await assert.rejects(withNetRetry(async () => { k++; throw new TypeError("fetch failed"); }, 0));
  assert.equal(k, 2, "повторів більше одного");
  assert.equal(isNetError(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
  assert.match(MOUNT(), /withNetRetry\(\(\) => attachPdfToLead\(leadId, pdf\.fileName, pdf\.bytes\)\)/, "PDF рахунку вантажиться без повтору");
});

test("#7133 SQL ВЕБХУКА — ТИПИ ПАРАМЕТРІВ ЯВНО: «що записали» (zakaz_onec_pay_plan) не падає «inconsistent types» на CASE без типу", () => {
  // Спіймано на проді 30.10.2026 першою ж подією: `CASE … THEN $3 END` Postgres вивів як text, а `$3` у fully_paid — boolean.
  // Без БД SQL не перевірити, тож стережемо саме прийом: кожен параметр у CASE — з явним типом.
  const st = STORE();
  const sw = st.slice(st.indexOf("export async function saveWritten("), st.indexOf("]);", st.indexOf("export async function saveWritten(")));
  for (const piece of ["$2::text", "$3::boolean", "$4::bigint", "THEN $2::text END", "THEN $3::boolean END"]) {
    assert.ok(sw.includes(piece), `у saveWritten параметр без явного типу (${piece}) — Postgres виведе text і запит упаде`);
  }
  assert.doesNotMatch(sw, /THEN \$[23] END/, "у CASE лишився параметр без типу");
});
