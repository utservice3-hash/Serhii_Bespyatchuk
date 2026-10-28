/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» — роутер модуля (`/api/zakaz1c`). Усе, що стосується заміни Genesis, живе в теці `zakaz1c/`:
 *   env.ts       — перемикач off/test/live, тестувальники, секрет і токен інтеграції;
 *   kommoAuth.ts — вхід за підписом Kommo (`X-Auth-Token` від `$authorizedAjax`), без сесії дашборда;
 *   invoice.ts   — правила вікна → `POST /createInvoice` 1С, PDF `invoicePdf`, контрагент, стан оплати;
 *   kommoApi.ts  — угода/компанія/менеджер з Kommo, PDF у файли угоди, примітка;
 *   store.ts     — журнал `zakaz_onec_invoices`;
 *   widget/      — сам віджет Kommo (вкладка й вікно), архів для завантаження в інтеграцію.
 * У спільних файлах дашборда — лише точки підключення: `routes/zakaz1c.ts`, `index.ts`, матриця доступу, маніфест,
 * схема (таблиця) і список таблиць, закритих від ШІ.
 *
 * Межа доступу — НЕ вкладка дашборда, а підпис Kommo: вікно відкривають менеджери в Kommo, яких може не бути серед
 * користувачів дашборда. Тому `requireAuth` тут немає, а токен дашборда (Bearer) нічого не відкриває — 401.
 *
 * Акт і ТТН — з 1С, як у Genesis (форми з реалізації за рахунком; рішення Романа 28.10.2026). Методу в 1С ще немає
 * (ТЗ Андрію п. 5), тож маршрутів для них тут немає, а кнопки у вікні сірі з поясненням.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireKommoCaller } from "./kommoAuth.js";
import { onecServiceBase, zakaz1cFieldsMode, zakaz1cMode, zakaz1cTestEdrpou, zakaz1cTesters } from "./env.js";
import {
  CURRENCIES, buildCreateCustomerBody, buildCreateInvoiceBody, createCustomerIn1c, createInvoiceIn1c, customerInfoFrom1c,
  invoiceAllowed, invoicePdfFrom1c, itemVatsFor, kyivIso, orgRules, parseInvoiceForm, serviceSwaps, servicesFor, vatTypesFor,
} from "./invoice.js";
import { KOMMO_FIELDS, addLeadNote, attachPdfToLead, kommoUserName, loadLead, patchLeads } from "./kommoApi.js";
import { invoiceOfLead, listInvoices, saveInvoice } from "./store.js";

/** Чого 1С ще не вміє — показуємо у вікні словами (ТЗ Андрію 28.10.2026, пункти в дужках). */
export const ONEC_WAITS = {
  multi: "Другий рахунок в угоді 1С поки не створює: за номером угоди повертає перший (ТЗ п. 1).",
  update: "Змінити рахунок з Kommo 1С поки не дозволяє — чекаємо метод від Андрія (ТЗ п. 4).",
  docs: "Акт і ТТН друкує 1С з реалізації, як у Genesis. Метод для них чекаємо від Андрія (ТЗ п. 5).",
  fields: "«Дата акту» й «Коментар СРМ» зберігаємо в нас; у рахунок 1С вони підуть, щойно Андрій додасть поля (ТЗ п. 2).",
} as const;

const leadIdOf = (req: Request) => {
  const n = Number(req.params.leadId);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const UID_RE = /^[0-9a-f-]{36}$/i;
const testMark = (mode: string) => (mode === "test" ? "[ТЕСТ] " : "");

/** Організації для вікна: правила + що можна виставити зараз. Сервер перевіряє ті самі правила ще раз. */
function orgsForWindow() {
  return orgRules().map((o) => ({
    key: o.key, short: o.short, name: o.name, match: o.match, available: !!o.code, waits: o.waits ?? null,
    vatTypes: vatTypesFor(o), itemVats: itemVatsFor(o), banks: o.banks ?? null, services: servicesFor(o.key).map((x) => x.name),
  }));
}

export function buildZakaz1cRouter(): Router {
  const r = Router();
  r.use(requireKommoCaller);
  r.use((_req, res, next) => {
    if (zakaz1cMode() === "off") { res.status(503).json({ error: "Виставлення рахунків вимкнено." }); return; }
    next();
  });

  /** Підстановка для вікна: угода, компанія, контрагент у 1С, правила організацій, рахунки угоди з оплатою. */
  r.get("/lead/:leadId", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const mode = zakaz1cMode();
    const today = kyivIso();
    const lead = await loadLead(leadId);
    const code = lead.company?.edrpou ?? "";
    const [onec, invoices, managerName] = await Promise.all([customerInfoFrom1c(onecServiceBase(), code), listInvoices(pool, leadId, today),
      kommoUserName(req.kommoCaller!.userId)]);
    const allowed = invoiceAllowed(mode, { edrpou: code, testEdrpou: zakaz1cTestEdrpou(), userId: req.kommoCaller!.userId, testers: zakaz1cTesters() });
    res.json({
      mode, testEdrpou: zakaz1cTestEdrpou(), today, managerName,
      canCreate: allowed.ok, blockedWhy: allowed.ok ? null : allowed.why,
      orgs: orgsForWindow(), currencies: CURRENCIES, waits: ONEC_WAITS,
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
    const built = buildCreateCustomerBody({ name: lead.company?.name ?? "", code }, await kommoUserName(caller.userId));
    if (!built.ok) return res.status(400).json({ error: built.why });
    const c = await createCustomerIn1c(onecServiceBase(), built.body);
    if (!c.ok) return res.status(502).json({ error: c.why });
    if (!c.existed) {
      await addLeadNote(leadId, `${testMark(mode)}Контрагента «${built.body.name}» створено в 1С з вкладки «ТЕСТ ЗАКАЗ 1С»`).catch(() => undefined);
    }
    res.json({ existed: c.existed, warnings: c.warnings });
  });

  /** «Виставити»: 1С → PDF у файли угоди → примітка → журнал. Повтор за тим самим `deal_id` дає той самий рахунок. */
  r.post("/lead/:leadId/invoice", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const today = kyivIso();
    const orgs = orgRules();
    const parsed = parseInvoiceForm(req.body, { today, orgs });
    if (!parsed.ok) return res.status(400).json({ error: parsed.why });
    const form = parsed.form;
    const mode = zakaz1cMode();
    const caller = req.kommoCaller!;
    const lead = await loadLead(leadId);
    const code = lead.company?.edrpou ?? "";
    const allowed = invoiceAllowed(mode, { edrpou: code, testEdrpou: zakaz1cTestEdrpou(), userId: caller.userId, testers: zakaz1cTesters() });
    if (!allowed.ok) return res.status(403).json({ error: allowed.why });
    // Другий рахунок 1С не створить (повернула б перший за `deal_id`) — кажемо прямо, а не віддаємо старий як новий.
    if ((await listInvoices(pool, leadId, today)).length > 0) return res.status(409).json({ error: ONEC_WAITS.multi });
    const customer = await customerInfoFrom1c(onecServiceBase(), code);
    if (!customer.found) {
      return res.status(409).json({ error: customer.error ? `1С: ${customer.error}.` : "Контрагента немає в 1С — спершу натисніть «Створити контрагента в 1С»." });
    }

    const manager = await kommoUserName(caller.userId);
    const body = buildCreateInvoiceBody(leadId, form, { customerUid: customer.uid, manager, today, orgCode: orgs.find((o) => o.key === form.org)!.code! });
    const result = await createInvoiceIn1c(onecServiceBase(), body);
    if (!result.ok) return res.status(502).json({ error: result.why });
    const inv = result.invoice;
    const warnings = [...inv.warnings, ...serviceSwaps(form.items.map((it) => it.service), inv.itemNames)];

    // PDF і примітка — після рахунку: рахунок уже існує в 1С, тож збій Kommo не має губити номер. Кажемо словами.
    let fileUuid: string | null = null;
    let attachError: string | null = null;
    if (!inv.existed && inv.pdf) {
      try {
        fileUuid = await attachPdfToLead(leadId, inv.pdf.fileName, inv.pdf.bytes);
      } catch (e) {
        attachError = (e as Error).message.slice(0, 300);
      }
      await addLeadNote(leadId, `${testMark(mode)}Рахунок 1С №${inv.numberPrint} від ${inv.date.slice(0, 10)} · ${inv.organization} · `
        + `${inv.total} ${inv.currency}${attachError ? " · PDF не прикріпився, завантажте з вкладки" : ""}`).catch((e) => {
        attachError = attachError ?? `примітка: ${(e as Error).message.slice(0, 200)}`;
      });
    }
    // «Номер заказа» — лише коли Genesis вимкнено (ZAKAZ1C_FIELDS_MODE=live): поки він працює, це його поле.
    if (zakaz1cFieldsMode() === "live" && !inv.existed) {
      await patchLeads([{ id: leadId, custom_fields_values: [{ field_id: KOMMO_FIELDS.leadOrderNo, values: [{ value: inv.number }] }] }])
        .catch((e) => { attachError = attachError ?? `«Номер заказа»: ${(e as Error).message.slice(0, 200)}`; });
    }
    await saveInvoice(pool, { leadId, inv: { ...inv, warnings }, form: inv.existed ? null : form, mode: mode === "live" ? "live" : "test",
      kommoUserId: caller.userId, fileUuid, attachError });
    res.json({
      invoice: { uid: inv.uid, number: inv.numberPrint, date: inv.date, organization: inv.organization, agreement: inv.agreement,
        currency: inv.currency, vatType: inv.vatType, total: inv.total, existed: inv.existed, warnings },
      attached: fileUuid !== null, attachError,
    });
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
