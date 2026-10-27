/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» — роутер модуля (`/api/zakaz1c`). Усе, що стосується заміни Genesis, живе в теці `zakaz1c/`:
 *   env.ts       — перемикач off/test/live, тестувальники, секрет і токен інтеграції;
 *   kommoAuth.ts — вхід за підписом Kommo (`X-Auth-Token` від `$authorizedAjax`), без сесії дашборда;
 *   invoice.ts   — форма вікна → `POST /createInvoice` 1С, PDF `invoicePdf`;
 *   kommoApi.ts  — угода/компанія/менеджер з Kommo, PDF у файли угоди, примітка;
 *   store.ts     — журнал `zakaz_onec_invoices`;
 *   widget/      — сам віджет Kommo (вкладка й вікно), архів для завантаження в інтеграцію.
 * У спільних файлах дашборда — лише точки підключення: `routes/zakaz1c.ts`, `index.ts`, матриця доступу, маніфест,
 * схема (таблиця) і список таблиць, закритих від ШІ.
 *
 * Межа доступу — НЕ вкладка дашборда, а підпис Kommo: вікно відкривають менеджери в Kommo, яких може не бути серед
 * користувачів дашборда. Тому `requireAuth` тут немає, а токен дашборда (Bearer) нічого не відкриває — 401.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireKommoCaller } from "./kommoAuth.js";
import { onecServiceBase, zakaz1cFieldsMode, zakaz1cMode, zakaz1cTestEdrpou, zakaz1cTesters } from "./env.js";
import { stateById } from "../routes/constructor.js";
import { buildTtn, waybillBlocker } from "../constructor/services/waybills.js";
import {
  CURRENCIES, ORGANIZATIONS, VAT_TYPES, buildCreateInvoiceBody, createInvoiceIn1c, invoiceAllowed, invoicePdfFrom1c, parseInvoiceForm,
} from "./invoice.js";
import { KOMMO_FIELDS, addLeadNote, attachPdfToLead, kommoUserName, loadLead, patchLeads } from "./kommoApi.js";
import { invoiceOfLead, listInvoices, saveInvoice } from "./store.js";

const leadIdOf = (req: Request) => {
  const n = Number(req.params.leadId);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const kyivToday = () => new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" })
  .format(new Date());

/** Договори контрагента з `customerInfo` — для списку у вікні. Помилка 1С не ламає вікно: договір можна не обирати. */
async function agreementsOf(edrpou: string): Promise<{ found: boolean; name: string; agreements: { value: string; label: string }[]; error?: string }> {
  if (!edrpou) return { found: false, name: "", agreements: [] };
  try {
    const param = edrpou.length === 10 ? "inn" : "edrpou";
    const r = await fetch(`${onecServiceBase()}/customerInfo?${param}=${encodeURIComponent(edrpou)}`, { signal: AbortSignal.timeout(10_000) });
    const j: any = r.status === 200 ? await r.json().catch(() => null) : null;
    if (!j) return { found: false, name: "", agreements: [], error: `1С відповіла ${r.status}` };
    if (j.state !== true) return { found: false, name: "", agreements: [] };
    const list = Array.isArray(j.agreements) ? j.agreements : [];
    return {
      found: true,
      name: String(j.name ?? ""),
      agreements: list.map((a: any) => {
        const label = [a?.name, a?.number && `№ ${a.number}`, a?.currency, a?.organization].filter(Boolean).join(" · ");
        return { value: String(a?.uid ?? a?.name ?? ""), label: label || String(a?.uid ?? "") };
      }).filter((a: { value: string }) => a.value),
    };
  } catch {
    return { found: false, name: "", agreements: [], error: "1С недоступна" };
  }
}

/** Остання заявка перевізнику з Конструктора дашборда для цієї угоди (`deal_no` = ID угоди Kommo) — з неї ТТН. */
async function carrierDocOf(leadId: number): Promise<{ id: number; createdAt: string } | null> {
  const q = await pool.query<{ id: string; created_at: string }>(
    `SELECT id::text AS id, to_char(created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM.YYYY') AS created_at
       FROM constructor_documents WHERE deal_no = $1 AND party = 'carrier' ORDER BY id DESC LIMIT 1`, [String(leadId)]);
  return q.rows[0] ? { id: Number(q.rows[0].id), createdAt: q.rows[0].created_at } : null;
}

export function buildZakaz1cRouter(): Router {
  const r = Router();
  r.use(requireKommoCaller);
  r.use((_req, res, next) => {
    if (zakaz1cMode() === "off") { res.status(503).json({ error: "Виставлення рахунків вимкнено." }); return; }
    next();
  });

  /** Підстановка для вікна: угода, компанія, договори з 1С, уже створені рахунки, і чи можна створювати. */
  r.get("/lead/:leadId", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const mode = zakaz1cMode();
    const lead = await loadLead(leadId);
    const edrpou = lead.company?.edrpou ?? "";
    const [onec, invoices, carrierDoc] = await Promise.all([agreementsOf(edrpou), listInvoices(pool, leadId), carrierDocOf(leadId)]);
    const allowed = invoiceAllowed(mode, { edrpou, testEdrpou: zakaz1cTestEdrpou(), userId: req.kommoCaller!.userId, testers: zakaz1cTesters() });
    res.json({
      mode, testEdrpou: zakaz1cTestEdrpou(),
      canCreate: allowed.ok, blockedWhy: allowed.ok ? null : allowed.why,
      organizations: ORGANIZATIONS, currencies: CURRENCIES, vatTypes: VAT_TYPES,
      lead: { id: lead.id, name: lead.name, price: lead.price, car: lead.car, cityFrom: lead.cityFrom, cityTo: lead.cityTo, company: lead.company },
      onec, invoices, ttn: carrierDoc ? { createdAt: carrierDoc.createdAt } : null,
    });
  });

  /** «Створити рахунок»: 1С → PDF у файли угоди → примітка → журнал. Повтор за тим самим `deal_id` дає той самий рахунок. */
  r.post("/lead/:leadId/invoice", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const parsed = parseInvoiceForm(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.why });
    const mode = zakaz1cMode();
    const caller = req.kommoCaller!;
    const lead = await loadLead(leadId);
    const edrpou = lead.company?.edrpou ?? "";
    const allowed = invoiceAllowed(mode, { edrpou, testEdrpou: zakaz1cTestEdrpou(), userId: caller.userId, testers: zakaz1cTesters() });
    if (!allowed.ok) return res.status(403).json({ error: allowed.why });

    const manager = await kommoUserName(caller.userId);
    const body = buildCreateInvoiceBody(leadId, parsed.form, { edrpou, manager, orderDate: kyivToday() });
    const result = await createInvoiceIn1c(onecServiceBase(), body);
    if (!result.ok) return res.status(502).json({ error: result.why });
    const inv = result.invoice;

    // PDF і примітка — після рахунку: рахунок уже існує в 1С, тож збій Kommo не має губити номер. Кажемо словами.
    let fileUuid: string | null = null;
    let attachError: string | null = null;
    if (!inv.existed && inv.pdf) {
      try {
        fileUuid = await attachPdfToLead(leadId, inv.pdf.fileName, inv.pdf.bytes);
      } catch (e) {
        attachError = (e as Error).message.slice(0, 300);
      }
      const testMark = mode === "test" ? "[ТЕСТ] " : "";
      await addLeadNote(leadId, `${testMark}Рахунок 1С №${inv.numberPrint} від ${inv.date.slice(0, 10)} · ${inv.organization} · `
        + `${inv.total} ${inv.currency}${attachError ? " · PDF не прикріпився, завантажте з вкладки" : ""}`).catch((e) => {
        attachError = attachError ?? `примітка: ${(e as Error).message.slice(0, 200)}`;
      });
    }
    // «Номер заказа» — лише коли Genesis вимкнено (ZAKAZ1C_FIELDS_MODE=live): поки він працює, це його поле.
    if (zakaz1cFieldsMode() === "live" && !inv.existed) {
      await patchLeads([{ id: leadId, custom_fields_values: [{ field_id: KOMMO_FIELDS.leadOrderNo, values: [{ value: inv.number }] }] }])
        .catch((e) => { attachError = attachError ?? `«Номер заказа»: ${(e as Error).message.slice(0, 200)}`; });
    }
    await saveInvoice(pool, { leadId, inv, mode: mode === "live" ? "live" : "test", kommoUserId: caller.userId, fileUuid, attachError });
    res.json({
      invoice: { uid: inv.uid, number: inv.numberPrint, date: inv.date, organization: inv.organization, agreement: inv.agreement,
        currency: inv.currency, vatType: inv.vatType, total: inv.total, existed: inv.existed, warnings: inv.warnings },
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
    if (!leadId || !/^[0-9a-f-]{36}$/i.test(uid)) return res.status(400).json({ error: "Некоректний запит." });
    if ((await invoiceOfLead(pool, uid)) !== leadId) return res.status(404).json({ error: "Рахунок не з цієї угоди." });
    const stamp = req.query.stamp !== "0";
    const pdf = await invoicePdfFrom1c(onecServiceBase(), uid, stamp);
    if (!pdf.ok) return res.status(502).json({ error: pdf.why });
    res.json({ fileName: `invoice_${uid.slice(0, 8)}${stamp ? "" : "_bez_pechatky"}.pdf`, base64: pdf.bytes.toString("base64") });
  });

  /**
   * ТТН (1-ТН, Excel) — той самий генератор, що кнопка «⬇ ТТН» у Конструкторі дашборда, з останньої заявки перевізнику
   * цієї угоди. Заявки немає або вона клієнтська — 404/400 словами. JSON з base64 — з тієї ж причини, що й PDF.
   */
  r.get("/lead/:leadId/ttn", async (req: Request, res: Response) => {
    const leadId = leadIdOf(req);
    if (!leadId) return res.status(400).json({ error: "Некоректний номер угоди." });
    const doc = await carrierDocOf(leadId);
    if (!doc) return res.status(404).json({ error: "У Конструкторі дашборда немає заявки перевізнику для цієї угоди." });
    const d = await stateById(req, doc.id);
    const no = waybillBlocker(d.s);
    if (no) return res.status(400).json({ error: no });
    res.json({ fileName: `ТТН-${leadId}.xlsx`, base64: Buffer.from(buildTtn(d.s)).toString("base64") });
  });

  return r;
}
