import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { verifyKommoToken, requireKommoCaller } from "./kommoAuth.js";
import { buildCreateInvoiceBody, fromCreateInvoiceReply, invoiceAllowed, parseInvoiceForm } from "./invoice.js";
import { zakaz1cFieldsMode, zakaz1cMode } from "./env.js";
import { BEFORE_PAID, PAID_STAGE, patchOf, planPayment, runPayments } from "./payments.js";

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
  // Перемикач за замовчуванням — вимкнено: невідоме значення не вмикає модуль.
  assert.equal(zakaz1cMode({} as NodeJS.ProcessEnv), "off");
  assert.equal(zakaz1cMode({ ZAKAZ1C_MODE: "yes" } as NodeJS.ProcessEnv), "off");
  assert.equal(zakaz1cMode({ ZAKAZ1C_MODE: "TEST" } as NodeJS.ProcessEnv), "test");
});

const FORM = {
  organization: "ТОВ АвтоМув", agreement: "", currency: "EUR", vatType: "Без ПДВ", discount: 100,
  invoiceDate: "2026-10-26", dueDate: "2026-11-02", comment: "тест", stamp: false,
  items: [{ name: "Організація міжнародного перевезення", content: "Praha (CZ) – Київ (UA), МАН АТ9718СР", qty: 1, price: 1800, vat: 0 }],
};

test("#7103 ФОРМА → 1С: валюта, організація, ПДВ, знижка, позиції, печатка й deal_id доходять; контрагент — лише від сервера", () => {
  const p = parseInvoiceForm({ ...FORM, customer_edrpou: "99999999" });
  assert.equal(p.ok, true, p.ok ? "" : p.why);
  if (!p.ok) return;
  const body = buildCreateInvoiceBody(62752319, p.form, { edrpou: "00100110", manager: "Федькевич Яна", orderDate: "26.10.2026" });
  assert.equal(body.currency, "EUR");
  assert.equal(body.organization, "ТОВ АвтоМув");
  assert.equal(body.vat_type, "Без ПДВ");
  assert.equal(body.discount, 100);
  assert.equal(body.stamp, false);
  assert.equal(body.deal_id, "62752319", "без deal_id 1С створить дубль при повторному натисканні");
  assert.equal(body.customer_edrpou, "00100110", "ЄДРПОУ з браузера потрапив у запит до 1С");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].price, 1800);
  assert.equal(body.items[0].content, "Praha (CZ) – Київ (UA), МАН АТ9718СР");
  assert.equal(body.pdf, true);
  // Дзеркало перевірок форми: невалідне відхиляється з поясненням, валідне — проходить (вище).
  assert.equal(parseInvoiceForm({ ...FORM, currency: "GBP" }).ok, false, "непідтримувану валюту пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, organization: "ФОП Невідомий" }).ok, false, "організацію не зі списку пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, items: [] }).ok, false, "рахунок без позицій пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, items: [{ ...FORM.items[0], price: 0 }] }).ok, false, "нульову ціну пропущено");
  assert.equal(parseInvoiceForm({ ...FORM, discount: 5000 }).ok, false, "знижку більшу за суму пропущено");
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

test("#7108 ТТН У ВКЛАДЦІ: кнопка є лише за наявної заявки перевізнику і йде підписаним каналом у той самий генератор Конструктора", () => {
  const js = WIDGET("script.js");
  assert.match(js, /d\.ttn\s*\n?\s*\?/, "кнопка ТТН не залежить від наявності заявки");
  assert.match(js, /download\("\/lead\/" \+ leadId\(\) \+ "\/ttn"/, "ТТН качається не з маршруту модуля");
  const mount = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "zakaz1c", "mount.ts"), "utf8");
  assert.match(mount, /buildTtn\(d\.s\)/, "ТТН будується не генератором Конструктора");
  assert.match(mount, /waybillBlocker\(d\.s\)/, "клієнтська заявка може дати ТТН без перевізника");
  assert.match(mount, /party = 'carrier'/, "ТТН береться не із заявки перевізнику");
});
