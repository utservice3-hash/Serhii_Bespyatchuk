/**
 * 📋 Поля угоди → рахунок 1С, як у Genesis (0.6.4, 17.11.2026). Бухгалтерія: «по новому рахунку не заповнюється Расход 1».
 * Genesis переносив у рахунок «Расход 1–3» з типом оплати, авто, «Код оплаты», «Тип запиту», «Канал продажу» і поля
 * реєстрації компанії. Ми шлемо їх у `deal_fields` при виставленні й «Змінити», а далі звіряємо: «Расход» часто
 * вписують в угоду ПІСЛЯ рахунку, коли знайшли перевізника.
 *
 * Коли переносимо:
 *   - при виставленні й «Змінити» — разом з рахунком;
 *   - щойно менеджер відкрив вкладку (`GET /lead/:id`);
 *   - щогодини (`paymentsJob.ts`) — угоди з рахунками від 0.6.4, де немає оплати й реалізації.
 * Чим: `updateInvoice` лише з `invoice_uid` і `deal_fields` — решта рахунку лишається як була (лист 1С 29.10.2026).
 * Межа: оплачений або реалізований рахунок 1С змінювати не дає — для нього потрібен окремий метод (ТЗ Андрію).
 * Рахунки до 0.6.4 (`deal_fields_sent` = NULL) без `backfill` не чіпаємо: дозаповнення — окремий дозвіл Романа.
 */
import type { Pool } from "pg";
import { onecServiceBase, zakaz1cMode } from "./env.js";
import { GENESIS_DEAL_FIELD_KEYS, genesisDealFields, kyivIso, updateInvoiceIn1c } from "./invoice.js";
import { loadLead, type LeadForInvoice } from "./kommoApi.js";
import { leadsForDealFieldsSync, listInvoices, saveDealFieldsSent, sentDealFields } from "./store.js";

/** Чи вже пішло в 1С саме це (jsonb не зберігає порядок ключів — звіряємо по ключах). Чиста. */
export function sameDealFields(sent: Record<string, unknown> | null | undefined, want: Record<string, string | number | null>): boolean {
  if (!sent) return false;
  return GENESIS_DEAL_FIELD_KEYS.every((k) => (sent[k] ?? null) === (want[k] ?? null));
}

export interface DealFieldsOutcome { uid: string; ok: boolean; why: string | null }

/** Перенести поля угоди в рахунки віджета цієї угоди, де вони відрізняються і 1С ще дає змінювати. */
export async function pushDealFields(pool: Pool, leadId: number, lead: Pick<LeadForInvoice, "raw">,
  opts: { backfill?: boolean } = {}): Promise<DealFieldsOutcome[]> {
  const want = genesisDealFields(lead.raw);
  const [rows, sent] = await Promise.all([listInvoices(pool, leadId, kyivIso()), sentDealFields(pool, leadId)]);
  const out: DealFieldsOutcome[] = [];
  for (const r of rows) {
    if (!sent.has(r.invoice_uid)) continue;
    const s = sent.get(r.invoice_uid) ?? null;
    if (s === null && !opts.backfill) continue;
    if (r.realized || r.pay.paid > 0 || r.pay.k === "paid") continue;
    if (sameDealFields(s, want)) continue;
    const res = await updateInvoiceIn1c(onecServiceBase(), { invoice_uid: r.invoice_uid, deal_fields: want });
    await saveDealFieldsSent(pool, r.invoice_uid, res.ok ? want : null, res.ok ? null : res.why);
    out.push({ uid: r.invoice_uid, ok: res.ok, why: res.ok ? null : res.why });
  }
  return out;
}

/** Щогодинна звірка: угоди з рахунками від 0.6.4 без оплати й реалізації. Угоду читаємо з Kommo (полів «Расход» у БД немає). */
export async function runDealFieldsSync(pool: Pool): Promise<{ leads: number; pushed: number; refused: number }> {
  if (zakaz1cMode() === "off") return { leads: 0, pushed: 0, refused: 0 };
  const leads = await leadsForDealFieldsSync(pool);
  let pushed = 0, refused = 0;
  for (const id of leads) {
    try {
      const res = await pushDealFields(pool, id, await loadLead(id));
      pushed += res.filter((o) => o.ok).length;
      refused += res.filter((o) => !o.ok).length;
    } catch { refused++; }
  }
  return { leads: leads.length, pushed, refused };
}
