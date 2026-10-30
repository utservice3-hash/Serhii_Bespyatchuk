/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» — роутер модуля (`/api/zakaz1c`). Усе, що стосується заміни Genesis, живе в теці `zakaz1c/`:
 *   env.ts       — перемикач off/test/live, тестувальники, секрет і токен інтеграції;
 *   kommoAuth.ts — вхід за підписом Kommo (`X-Auth-Token` від `$authorizedAjax`), без сесії дашборда;
 *   invoice.ts   — правила вікна → 1С (`createInvoice`, `updateInvoice`, `invoicePdf`, `realizationPdf`, `organizations`);
 *   owner.ts     — хто веде угоду: Genesis чи віджет («одна угода — одна система»);
 *   kommoApi.ts  — угода/компанія/менеджер з Kommo, PDF у файли угоди, примітки, «Номер заказа», тег;
 *   notes.ts     — слід рахунку в стрічці угоди (запис з PDF);
 *   store.ts     — журнал `zakaz_onec_invoices`;
 *   widget/      — сам віджет Kommo (вкладка й вікно), архів для завантаження в інтеграцію.
 * У спільних файлах дашборда — лише точки підключення: `routes/zakaz1c.ts`, `index.ts`, матриця доступу, маніфест,
 * схема (таблиця) і список таблиць, закритих від ШІ.
 *
 * Межа доступу — НЕ вкладка дашборда, а підпис Kommo: вікно відкривають менеджери в Kommo, яких може не бути серед
 * користувачів дашборда. Тому `requireAuth` тут немає, а токен дашборда (Bearer) нічого не відкриває — 401.
 *
 * Акт — з 1С (`realizationPdf`), коли бухгалтерія провела реалізацію. ТТН у вікні немає: 1С ТТН автоматично не друкує
 * (ручна форма; через Genesis за 2026 рік — жодної), її формують у Конструкторі дашборда (рішення Романа 30.10.2026).
 */
import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireKommoCaller } from "./kommoAuth.js";
import { onecServiceBase, zakaz1cMode, zakaz1cTestEdrpou, zakaz1cTesters } from "./env.js";
import {
  CURRENCIES, actPdfFrom1c, buildCreateCustomerBody, buildCreateInvoiceBody, buildUpdateInvoiceBody, codeOfService, createCustomerIn1c,
  createInvoiceIn1c, customerInfoFrom1c, invoiceAllowed, invoicePdfFrom1c, itemVatsFor, kyivIso, orgRules, organizationsFrom1c,
  parseInvoiceForm, serviceSwaps, servicesFor, updateInvoiceIn1c, vatTypesFor, type BankAccount, type CreatedInvoice, type InvoiceForm,
  type OrgRule,
} from "./invoice.js";
import { addFileNote, addLeadNote, attachPdfToLead, kommoUserName, loadLead, patchLeads, type LeadForInvoice } from "./kommoApi.js";
import { noteInvoice } from "./notes.js";
import { GENESIS_DEAL_WHY, WIDGET_TAG, claimPatch, dealOwner, type DealOwner } from "./owner.js";
import { actAttached, invoiceOfLead, listInvoices, markActAttached, onecNumbersOfDeal, saveInvoice } from "./store.js";

/** Що показуємо словами у вікні. */
export const ONEC_WAITS = {
  fields: "«Дата акту» і «Коментар для бухгалтерії» йдуть у рахунок 1С (реквізити «Дата акта» і «Коментар CRM»).",
  docs: "Акт зʼявиться, щойно бухгалтерія проведе реалізацію в 1С. ТТН формується в Конструкторі дашборда.",
  fopBanks: "1С не віддала рахунки ФОП — спробуйте пізніше.",
  edit: "Змінити можна лише в день виставлення і поки немає оплати — далі через запит бухгалтерії.",
} as const;


const leadIdOf = (req: Request) => {
  const n = Number(req.params.leadId);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const UID_RE = /^[0-9a-f-]{36}$/i;
const testMark = (mode: string) => (mode === "test" ? "[ТЕСТ] " : "");

/** Організації для вікна: правила + що можна виставити зараз + банки ФОП з 1С. Сервер перевіряє те саме ще раз. */
function orgsForWindow(banks: Map<string, BankAccount[]> | null) {
  return orgRules().map((o) => {
    const own = o.needsBank && o.code ? (banks?.get(o.code) ?? null) : null;
    const noBanks = o.needsBank && (!own || own.length === 0);
    return {
      key: o.key, short: o.short, name: o.name, match: o.match, available: !!o.code && !noBanks,
      waits: o.waits ?? (noBanks ? ONEC_WAITS.fopBanks : null),
      vatTypes: vatTypesFor(o), itemVats: itemVatsFor(o), services: servicesFor(o.key).map((x) => x.name),
      banks: own ? own.map((b) => ({ uid: b.uid, label: b.bank || b.name, currency: b.currency, isMain: b.isMain })) : null,
    };
  });
}

/** Хто веде угоду — з «Номера заказа» Kommo, нашого журналу й рахунків 1С за угодою. */
async function ownerOf(leadId: number, lead: LeadForInvoice): Promise<DealOwner> {
  const [ours, onec] = await Promise.all([
    pool.query<{ number: string }>(`SELECT number FROM zakaz_onec_invoices WHERE lead_id = $1`, [leadId]),
    onecNumbersOfDeal(pool, leadId),
  ]);
  return dealOwner({ orderNo: lead.orderNo, ourNumbers: ours.rows.map((r) => r.number), onecNumbers: onec });
}

/** PDF рахунку → файли угоди + запис з файлом у стрічці. Помилки Kommo не гублять рахунок: повертаємо їх словами. */
async function attachInvoice(leadId: number, inv: CreatedInvoice, o: OrgRule, mode: string, edited: boolean):
  Promise<{ fileUuid: string | null; error: string | null }> {
  if (!inv.pdf) return { fileUuid: null, error: "1С не віддала PDF" };
  let file: { uuid: string; versionUuid: string } | null = null;
  let error: string | null = null;
  try {
    file = await attachPdfToLead(leadId, inv.pdf.fileName, inv.pdf.bytes);
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  const note = await noteInvoice({ testMode: mode === "test", numberPrint: inv.numberPrint, date: inv.date, orgShort: o.short,
    total: inv.total, currency: inv.currency, edited }, file, { fileNote: (f) => addFileNote(leadId, f), textNote: (t) => addLeadNote(leadId, t) });
  if (note.kind !== "file") error = error ?? note.why;
  return { fileUuid: file?.uuid ?? null, error };
}

export function buildZakaz1cRouter(): Router {
  const r = Router();
  r.use(requireKommoCaller);
  r.use((_req, res, next) => {
    if (zakaz1cMode() === "off") { res.status(503).json({ error: "Виставлення рахунків вимкнено." }); return; }
    next();
  });

  /** Підстановка для вікна: угода, хто її веде, контрагент у 1С, правила організацій з банками ФОП, рахунки з оплатою. */
  r.get("/lead/:leadId", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const mode = zakaz1cMode();
    const today = kyivIso();
    const lead = await loadLead(leadId);
    const code = lead.company?.edrpou ?? "";
    const [onec, invoices, managerName, banks, owner] = await Promise.all([customerInfoFrom1c(onecServiceBase(), code),
      listInvoices(pool, leadId, today), kommoUserName(req.kommoCaller!.userId), organizationsFrom1c(onecServiceBase()), ownerOf(leadId, lead)]);
    const allowed = invoiceAllowed(mode, { edrpou: code, testEdrpou: zakaz1cTestEdrpou(), userId: req.kommoCaller!.userId, testers: zakaz1cTesters() });
    res.json({
      mode, testEdrpou: zakaz1cTestEdrpou(), today, managerName, owner, ownerWhy: owner === "genesis" ? GENESIS_DEAL_WHY : null,
      canCreate: allowed.ok && owner !== "genesis", blockedWhy: owner === "genesis" ? GENESIS_DEAL_WHY : allowed.ok ? null : allowed.why,
      orgs: orgsForWindow(banks), currencies: CURRENCIES, waits: ONEC_WAITS,
      lead: { id: lead.id, name: lead.name, price: lead.price, car: lead.car, cityFrom: lead.cityFrom, cityTo: lead.cityTo, company: lead.company },
      onec: { found: onec.found, name: onec.name, agreements: onec.agreements, error: onec.error ?? null },
      invoices,
    });
  });

  /**
   * «Створити контрагента в 1С» — з компанії угоди (назва + ЄДРПОУ / ІПН). Genesis створював їх сам, `createInvoice` —
   * ні. Та сама межа тестового режиму, що й для рахунку: контрагент у 1С — справжній запис. Повтор безпечний: 1С за
   * тим самим кодом повертає наявного з `existed: true`.
   */
  r.post("/lead/:leadId/customer", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const mode = zakaz1cMode();
    const caller = req.kommoCaller!;
    const lead = await loadLead(leadId);
    const code = lead.company?.edrpou ?? "";
    const allowed = invoiceAllowed(mode, { edrpou: code, testEdrpou: zakaz1cTestEdrpou(), userId: caller.userId, testers: zakaz1cTesters() });
    if (!allowed.ok) return res.status(403).json({ error: allowed.why });
    if ((await ownerOf(leadId, lead)) === "genesis") return res.status(409).json({ error: GENESIS_DEAL_WHY });
    const built = buildCreateCustomerBody({ name: lead.company?.name ?? "", code }, await kommoUserName(caller.userId));
    if (!built.ok) return res.status(400).json({ error: built.why });
    const c = await createCustomerIn1c(onecServiceBase(), built.body);
    if (!c.ok) return res.status(502).json({ error: c.why });
    if (!c.existed) {
      await addLeadNote(leadId, `${testMark(mode)}Контрагента «${built.body.name}» створено в 1С з вкладки «ТЕСТ ЗАКАЗ 1С»`).catch(() => undefined);
    }
    res.json({ existed: c.existed, warnings: c.warnings });
  });

  /**
   * «Виставити»: 1С → PDF у файли й стрічку угоди → «Номер заказа», тег → журнал. Кілька рахунків в угоді — кожна
   * відкрита форма має свій `request_id`; повтор тієї самої форми (подвійний клік, повтор після збою) дає той самий
   * рахунок з `existed: true`. В угоді Genesis — відмова ДО запиту в 1С.
   */
  r.post("/lead/:leadId/invoice", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const today = kyivIso();
    const orgs = orgRules();
    const banks = await organizationsFrom1c(onecServiceBase());
    const parsed = parseInvoiceForm(req.body, { today, orgs, banksOf: (c) => banks?.get(c) ?? [] });
    if (!parsed.ok) return res.status(400).json({ error: parsed.why });
    const form = parsed.form;
    if (!form.requestId) return res.status(400).json({ error: "Немає ключа форми — оновіть сторінку й відкрийте форму ще раз." });
    const mode = zakaz1cMode();
    const caller = req.kommoCaller!;
    const lead = await loadLead(leadId);
    const code = lead.company?.edrpou ?? "";
    const allowed = invoiceAllowed(mode, { edrpou: code, testEdrpou: zakaz1cTestEdrpou(), userId: caller.userId, testers: zakaz1cTesters() });
    if (!allowed.ok) return res.status(403).json({ error: allowed.why });
    if ((await ownerOf(leadId, lead)) === "genesis") return res.status(409).json({ error: GENESIS_DEAL_WHY });
    const customer = await customerInfoFrom1c(onecServiceBase(), code);
    if (!customer.found) {
      return res.status(409).json({ error: customer.error ? `1С: ${customer.error}.` : "Контрагента немає в 1С — спершу натисніть «Створити контрагента в 1С»." });
    }

    const o = orgs.find((x) => x.key === form.org)!;
    const manager = await kommoUserName(caller.userId);
    const body = buildCreateInvoiceBody(leadId, form, { customerUid: customer.uid, manager, today, orgCode: o.code! });
    const result = await createInvoiceIn1c(onecServiceBase(), body);
    if (!result.ok) return res.status(502).json({ error: result.why });
    const inv = result.invoice;
    const warnings = [...inv.warnings, ...serviceSwaps(form.items.map((it) => ({ name: it.service, code: codeOfService(it.service) })),
      inv.itemNames.map((name, i) => ({ name, code: inv.itemCodes[i] ?? "" })))];

    // Повтор тієї самої форми (existed) — рахунок уже в угоді: PDF і примітку вдруге не кладемо.
    const att = inv.existed ? { fileUuid: null, error: null } : await attachInvoice(leadId, inv, o, mode, false);
    let attachError = att.error;
    if (!inv.existed) {
      const patch = claimPatch(leadId, lead, inv.number);
      if (patch) await patchLeads([patch]).catch((e) => { attachError = attachError ?? `угода Kommo: ${(e as Error).message.slice(0, 200)}`; });
      if (!lead.tags.includes(WIDGET_TAG)) {
        await addLeadNote(leadId, `${testMark(mode)}Угоду веде віджет «ТЕСТ ЗАКАЗ 1С». Рахунки в цій угоді виставляйте там, Genesis не використовуйте.`)
          .catch(() => undefined);
      }
    }
    await saveInvoice(pool, { leadId, inv: { ...inv, warnings }, form: inv.existed ? null : form, mode: mode === "live" ? "live" : "test",
      kommoUserId: caller.userId, fileUuid: att.fileUuid, attachError });
    res.json({
      invoice: { uid: inv.uid, number: inv.numberPrint, date: inv.date, organization: inv.organization, agreement: inv.agreement,
        currency: inv.currency, vatType: inv.vatType, total: inv.total, existed: inv.existed, warnings },
      attached: att.fileUuid !== null, attachError,
    });
  });

  /**
   * «Змінити» — лише свій рахунок, у день виставлення і без оплати (правило Сергія й Інни). Організацію й валюту
   * змінити не можна (так і в 1С). 1С сама ще раз відмовить, якщо є оплата чи реалізація — її текст показуємо як є.
   */
  r.post("/lead/:leadId/invoice/:uid/update", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    const uid = String(req.params.uid ?? "");
    if (!leadId || !UID_RE.test(uid)) return res.status(400).json({ error: "Некоректний запит." });
    const today = kyivIso();
    const row = (await listInvoices(pool, leadId, today)).find((x) => x.invoice_uid === uid);
    if (!row) return res.status(404).json({ error: "Рахунок не з цієї угоди." });
    if (!row.can_edit) return res.status(409).json({ error: ONEC_WAITS.edit });
    const orgs = orgRules();
    const banks = await organizationsFrom1c(onecServiceBase());
    const parsed = parseInvoiceForm(req.body, { today, orgs, banksOf: (c) => banks?.get(c) ?? [] });
    if (!parsed.ok) return res.status(400).json({ error: parsed.why });
    const form = parsed.form;
    if (form.org !== row.org_key || form.currency !== row.currency) {
      return res.status(400).json({ error: "Організацію й валюту рахунку змінити не можна — виставте новий рахунок, а цей попросіть бухгалтерію позначити на видалення." });
    }
    const mode = zakaz1cMode();
    const caller = req.kommoCaller!;
    const lead = await loadLead(leadId);
    if ((await ownerOf(leadId, lead)) === "genesis") return res.status(409).json({ error: GENESIS_DEAL_WHY });
    const o = orgs.find((x) => x.key === form.org)!;
    const manager = await kommoUserName(caller.userId);
    const result = await updateInvoiceIn1c(onecServiceBase(), buildUpdateInvoiceBody(uid, form, { manager, dealId: leadId, orgCode: o.code! }));
    if (!result.ok) return res.status(502).json({ error: result.why });
    const inv = result.invoice;
    const att = await attachInvoice(leadId, inv, o, mode, true);
    await saveInvoice(pool, { leadId, inv, form, mode: mode === "live" ? "live" : "test", kommoUserId: caller.userId,
      fileUuid: att.fileUuid, attachError: att.error, edit: true });
    res.json({ invoice: { uid: inv.uid, number: inv.numberPrint, total: inv.total, currency: inv.currency, warnings: inv.warnings },
      attached: att.fileUuid !== null, attachError: att.error });
  });

  /**
   * «PDF ще раз» — лише рахунок, що належить цій угоді (за журналом). `?stamp=0` — без печатки.
   * Віддаємо JSON з base64, а не `application/pdf`: віджет ходить сюди лише через `$authorizedAjax` (підписаний
   * заголовок), а звичайне посилання в браузері заголовка не несе. Файл збирає сам віджет.
   */
  r.get("/lead/:leadId/invoice/:uid/pdf", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    const uid = String(req.params.uid ?? "");
    if (!leadId || !UID_RE.test(uid)) return res.status(400).json({ error: "Некоректний запит." });
    const own = await invoiceOfLead(pool, uid);
    if (own?.leadId !== leadId) return res.status(404).json({ error: "Рахунок не з цієї угоди." });
    const stamp = req.query.stamp !== "0";
    const pdf = await invoicePdfFrom1c(onecServiceBase(), uid, stamp);
    if (!pdf.ok) return res.status(502).json({ error: pdf.why });
    res.json({ fileName: `invoice_${own.numberPrint}${stamp ? "" : "_bez_pechatky"}.pdf`, base64: pdf.bytes.toString("base64") });
  });

  /**
   * Акт за рахунком — як у Genesis, на натискання: реалізації ще немає → 409 «ще не сформовано» (не помилка).
   * Уперше отриманий акт кладемо й у файли/стрічку угоди — один раз, а не на кожне натискання.
   */
  r.get("/lead/:leadId/invoice/:uid/act", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    const uid = String(req.params.uid ?? "");
    if (!leadId || !UID_RE.test(uid)) return res.status(400).json({ error: "Некоректний запит." });
    const own = await invoiceOfLead(pool, uid);
    if (own?.leadId !== leadId) return res.status(404).json({ error: "Рахунок не з цієї угоди." });
    const stamp = req.query.stamp !== "0";
    const act = await actPdfFrom1c(onecServiceBase(), uid, stamp);
    if (!act.ok) return res.status(act.notYet ? 409 : 502).json({ error: act.why, notYet: act.notYet });
    const fileName = `akt_${own.numberPrint}${stamp ? "" : "_bez_pechatky"}.pdf`;
    if (!(await actAttached(pool, uid))) {
      try {
        const f = await attachPdfToLead(leadId, fileName, act.bytes);
        await addFileNote(leadId, { ...f, name: `${testMark(zakaz1cMode())}Акт за рахунком №${own.numberPrint}.pdf` }).catch(() => undefined);
        await markActAttached(pool, uid, f.uuid);
      } catch { /* акт усе одно віддаємо менеджеру — у файли угоди покладемо наступного разу */ }
    }
    res.json({ fileName, base64: act.bytes.toString("base64") });
  });

  /**
   * Запит бухгалтерії на зміну рахунку. Самі запити поки йдуть у Telegram (Інна, 27.10.2026): текст для Telegram
   * збирає вікно, а сюди приходить лише «передано» — щоб у стрічці угоди лишився слід, хто й що просив змінити.
   */
  r.post("/lead/:leadId/invoice/:uid/request", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    const uid = String(req.params.uid ?? "");
    if (!leadId || !UID_RE.test(uid)) return res.status(400).json({ error: "Некоректний запит." });
    const what = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    if (!what) return res.status(400).json({ error: "Напишіть, що саме змінити в рахунку." });
    const own = await invoiceOfLead(pool, uid);
    if (own?.leadId !== leadId) return res.status(404).json({ error: "Рахунок не з цієї угоди." });
    await addLeadNote(leadId, `${testMark(zakaz1cMode())}Запит на зміну рахунку №${own.numberPrint} передано бухгалтерії в Telegram · ${what}`);
    res.json({ ok: true });
  });

  return r;
}

export type { InvoiceForm };
