/**
 * 📅 Дата акту з поля угоди → рахунок 1С (0.6.0, 12.11.2026). Нікіта (10.11): «дату акта знаємо лише, коли перевізник
 * надішле документи» — часто вже після оплати, коли `updateInvoice` відмовляє. Тому, як і в Genesis, джерело дати —
 * поле угоди «Дата выгрузки (Дата акта)», а 1С з 11.11.2026 дає змінити ЛИШЕ дату акту навіть в оплаченому рахунку
 * (`POST /setActDate`). Бухгалтерія датує реалізацію саме цим реквізитом (у 96 % реалізацій 2026 року дати збігаються).
 *
 * Коли переносимо:
 *   - щойно менеджер відкрив вкладку (`GET /lead/:id`) — одразу, без очікування;
 *   - щогодини після оплат (`paymentsJob.ts`) — для тих, хто вкладку не відкриває: дату бере з `deals.unload_at`
 *     (синк Kommo щопівгодини), тож у Kommo по угоди не ходить;
 *   - кнопкою «Дата акту» у вкладці — пише і в поле угоди, і в 1С.
 * Що саме слати — `actDatePlan` (`invoice.ts`): порожнє поле не стирає дату, проведений рахунок не чіпаємо.
 * Відмову 1С (реалізація, позначка на видалення) пишемо в журнал і показуємо у вкладці словами 1С.
 */
import type { Pool } from "pg";
import { onecServiceBase, zakaz1cMode } from "./env.js";
import { actDatePlan, setActDateIn1c } from "./invoice.js";
import { addLeadNote } from "./kommoApi.js";
import { ACT_SYNC_SQL, saveActSync } from "./store.js";

export interface ActSyncOutcome { uid: string; number: string; date: string | null; ok: boolean; changed: boolean; why: string | null }

const dmy = (iso: string) => iso.split("-").reverse().join(".");

/**
 * Перенести дату в ці рахунки угоди. `force` — кнопка у вкладці: тоді шлемо й порожню дату (очистити) і повторюємо
 * навіть ту саму — менеджер натиснув свідомо. Без `force` — лише за `actDatePlan`.
 */
export async function pushActDate(pool: Pool, leadId: number, date: string | null,
  invoices: { uid: string; number: string; actDate: string | null; realized: boolean }[], opts: { force?: boolean } = {}): Promise<ActSyncOutcome[]> {
  const targets = opts.force
    ? invoices.filter((i) => !i.realized).map((i) => ({ uid: i.uid, date }))
    : actDatePlan(date ?? "", invoices);
  const out: ActSyncOutcome[] = [];
  for (const t of targets) {
    const inv = invoices.find((i) => i.uid === t.uid)!;
    const r = await setActDateIn1c(onecServiceBase(), t.uid, t.date);
    await saveActSync(pool, t.uid, r.ok ? { ok: true, date: r.actDate } : r);
    out.push({ uid: t.uid, number: inv.number, date: t.date, ok: r.ok, changed: r.ok && r.changed, why: r.ok ? null : r.why });
  }
  const changed = out.filter((o) => o.changed);
  if (changed.length) {
    const mark = zakaz1cMode() === "test" ? "[ТЕСТ] " : "";
    const what = date ? `Дату акту ${dmy(date)} перенесено` : "Дату акту очищено";
    await addLeadNote(leadId, `${mark}${what} в рахунок 1С №${changed.map((o) => o.number).join(", №")}`).catch(() => undefined);
  }
  return out;
}

/** Щогодинна звірка: усі угоди віджета, де дата в полі угоди не та, що в рахунку 1С. */
export async function runActDateSync(pool: Pool): Promise<{ invoices: number; changed: number; refused: number }> {
  if (zakaz1cMode() === "off") return { invoices: 0, changed: 0, refused: 0 };
  const q = await pool.query<{ invoice_uid: string; lead_id: string; number_print: string; deal_date: string; act_date: string | null }>(ACT_SYNC_SQL);
  const byLead = new Map<number, typeof q.rows>();
  for (const r of q.rows) byLead.set(Number(r.lead_id), [...(byLead.get(Number(r.lead_id)) ?? []), r]);
  let changed = 0, refused = 0;
  for (const [leadId, rows] of byLead) {
    const res = await pushActDate(pool, leadId, rows[0].deal_date,
      rows.map((r) => ({ uid: r.invoice_uid, number: r.number_print, actDate: r.act_date, realized: false })));
    changed += res.filter((o) => o.changed).length;
    refused += res.filter((o) => !o.ok).length;
  }
  return { invoices: q.rows.length, changed, refused };
}
