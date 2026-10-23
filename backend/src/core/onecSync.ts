/**
 * 🗄 ЗАПИС 1С ПО УГОДАХ у `onec_deal_invoices` / `onec_deal_payments` (задача #5583, прохід 2, 23.10.2026). Окремо від
 * `dealLedger.ts`, який лише рахує. Вміст замінюється ЦІЛКОМ в одній транзакції — як скрипт Тетяни переписує «Расх из
 * 1C», — але лише після перевірок: порожньо — відмова; зникло понад 10% рядків проти минулого синку — відмова (обрізана
 * відповідь 1С не має тихо стерти вересень). Відмова нічого не пише, крім причини в `onec_deals_state`.
 */
import type { Db } from "./finance.js";
import type { OnecInvoice, OnecPayment } from "./dealLedger.js";

export const MAX_DROP_SHARE = 0.1;

/** Чи можна замінити `prev` рядків на `next`: не порожньо і зникло не більше 10%. Відмова — причина словами. */
export function onecVerdict(label: string, prev: number | null, next: number): string | null {
  if (next <= 0) return `1С, ${label}: сервіс не віддав жодного рядка з номером угоди — нічого не змінено`;
  if (prev != null && prev > 0 && next < prev * (1 - MAX_DROP_SHARE))
    return `1С, ${label}: рядків стало ${next} замість ${prev} (зникло понад 10%) — нічого не змінено`;
  return null;
}

/** Замінює обидві таблиці (у відкритій транзакції `db`) і пише стан. Відмова — `Error` з причиною. */
export async function replaceOnec(db: Db, inv: readonly OnecInvoice[], pay: readonly OnecPayment[]): Promise<{ invoices: number; payments: number }> {
  const prev = (await db.query(`SELECT invoices, payments FROM onec_deals_state WHERE id = 1`)).rows[0] ?? {};
  const why = onecVerdict("реалізації", prev.invoices ?? null, inv.length) ?? onecVerdict("оплати клієнтів", prev.payments ?? null, pay.length);
  if (why) throw new Error(why);
  await db.query(`DELETE FROM onec_deal_invoices`);
  for (let i = 0; i < inv.length; i += 2000) {
    const p = inv.slice(i, i + 2000);
    await db.query(`INSERT INTO onec_deal_invoices (deal_id, number, organization, kontragent, doc_on, act_on, sum, currency, out_vat, out_novat, out_unload, out_cash)
      SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::date[], $6::date[], $7::numeric[], $8::text[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[])`,
    [p.map((x) => x.deal), p.map((x) => x.number), p.map((x) => x.organization), p.map((x) => x.kontragent), p.map((x) => x.docOn), p.map((x) => x.actOn),
      p.map((x) => x.sum), p.map((x) => x.currency), p.map((x) => x.out.vat), p.map((x) => x.out.novat), p.map((x) => x.out.unload), p.map((x) => x.out.cash)]);
  }
  await db.query(`DELETE FROM onec_deal_payments`);
  for (let i = 0; i < pay.length; i += 2000) {
    const p = pay.slice(i, i + 2000);
    await db.query(`INSERT INTO onec_deal_payments (deal_id, organization, kontragent, paid_on, sum, currency)
      SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::date[], $5::numeric[], $6::text[])`,
    [p.map((x) => x.deal), p.map((x) => x.organization), p.map((x) => x.kontragent), p.map((x) => x.paidOn), p.map((x) => x.sum), p.map((x) => x.currency)]);
  }
  await db.query(`INSERT INTO onec_deals_state (id, synced_at, invoices, payments, error, error_at) VALUES (1, now(), $1, $2, NULL, NULL)
    ON CONFLICT (id) DO UPDATE SET synced_at = now(), invoices = EXCLUDED.invoices, payments = EXCLUDED.payments`, [inv.length, pay.length]);
  return { invoices: inv.length, payments: pay.length };
}

/** Відмова синку — причина в стані; останні добрі дані лишаються. */
export async function saveOnecError(db: Db, message: string): Promise<void> {
  await db.query(`INSERT INTO onec_deals_state (id, error, error_at) VALUES (1, $1, now())
    ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`, [message.slice(0, 500)]);
}
