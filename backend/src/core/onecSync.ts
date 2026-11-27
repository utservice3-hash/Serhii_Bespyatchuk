/**
 * 🗄 ЗАПИС 1С ПО УГОДАХ у `onec_deal_invoices` / `onec_deal_payments` (задача #5583, прохід 2, 23.10.2026). Окремо від
 * `dealLedger.ts`, який лише рахує. Вміст замінюється ЦІЛКОМ в одній транзакції — як скрипт Тетяни переписує «Расх из
 * 1C», — але лише після перевірок: порожньо — відмова; зникло понад 10% рядків проти минулого синку — відмова (обрізана
 * відповідь 1С не має тихо стерти вересень). Відмова нічого не пише, крім причини в `onec_deals_state`.
 * З 27.11.2026 тут же — знімок рядків БЕЗ номера угоди для вкладки «Безпека» (`replaceNoDeal`, `writeOnec` унизу).
 */
import type { Db } from "./finance.js";
import type { OnecInvoice, OnecPayment, OnecNoDealRow } from "./dealLedger.js";

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
    // `edrpou` (задача 11225) — сирий код платника; `?? null`, бо рядок без коду — звичайна річ (готівка), а не помилка.
    await db.query(`INSERT INTO onec_deal_payments (deal_id, organization, kontragent, paid_on, sum, currency, edrpou)
      SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::date[], $5::numeric[], $6::text[], $7::text[])`,
    [p.map((x) => x.deal), p.map((x) => x.organization), p.map((x) => x.kontragent), p.map((x) => x.paidOn), p.map((x) => x.sum), p.map((x) => x.currency),
      p.map((x) => x.edrpou ?? null)]);
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

/**
 * 🛡 ЗНІМОК РЯДКІВ 1С БЕЗ НОМЕРА УГОДИ у `onec_no_deal_rows` — для вкладки «Безпека» (задача 11231, Роман 27.11.2026).
 * Показуємо документи з 2026 року (як і неоплачені рахунки 1С); старіші й без дати не пишемо, але РАХУЄМО у стані —
 * інакше «на екрані 488» читалось би як «у 1С 488». Знімок замінюється цілком і історії не має: документ, якому в 1С
 * дописали угоду, зникає звідси наступного синку.
 */
export const NO_DEAL_FROM = "2026-01-01";

export async function replaceNoDeal(db: Db, rows: readonly OnecNoDealRow[]): Promise<{ rows: number; older: number; undated: number }> {
  const shown = rows.filter((x) => x.docOn != null && x.docOn >= NO_DEAL_FROM);
  const undated = rows.filter((x) => x.docOn == null).length;
  const older = rows.length - shown.length - undated;
  await db.query(`DELETE FROM onec_no_deal_rows`);
  for (let i = 0; i < shown.length; i += 1000) {
    const p = shown.slice(i, i + 1000);
    const col = <K extends keyof OnecNoDealRow>(k: K) => p.map((x) => x[k]);
    await db.query(`INSERT INTO onec_no_deal_rows (kind, number, organization, kontragent, edrpou, doc_on, sum, currency, deal_raw, manager, comment)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[], $7::numeric[], $8::text[], $9::text[], $10::text[], $11::text[])`,
    [col("kind"), col("number"), col("organization"), col("kontragent"), col("edrpou"), col("docOn"), col("sum"), col("currency"), col("dealRaw"), col("manager"), col("comment")]);
  }
  await db.query(`INSERT INTO onec_no_deal_state (id, synced_at, rows, older, undated, error, error_at) VALUES (1, now(), $1, $2, $3, NULL, NULL)
    ON CONFLICT (id) DO UPDATE SET synced_at = now(), rows = EXCLUDED.rows, older = EXCLUDED.older, undated = EXCLUDED.undated, error = NULL, error_at = NULL`,
  [shown.length, older, undated]);
  return { rows: shown.length, older, undated };
}

/** Клієнт із транзакцією — те, що дає `pool.connect()`; у тестах — обгортка над одним зʼєднанням. */
export interface DbClient extends Db { release(): void }
export interface DbPool extends Db { connect(): Promise<DbClient> }

async function inTx<T>(pool: DbPool, work: (db: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await work(c);
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
}

/**
 * Запис одного проходу синку: спершу угоди (`replaceOnec`), і лише ПІСЛЯ їхнього коміту — знімок «без угоди» ОКРЕМОЮ
 * транзакцією. 🔴 Порядок і окрема транзакція — навмисно: від таблиць угод живуть «Результат місяця», «Зарплата» і
 * рахунки 1С, а знімок потрібен одній вкладці. Збій знімка не має відкотити чи зупинити запис угод: він лишає
 * попередній знімок, пише причину в `onec_no_deal_state` (екран її покаже) і повертається в підсумку проходу.
 * Відмова `replaceOnec` (порожньо, зникло понад 10%) знімка не чіпає взагалі — обрізана відповідь 1С обрізала б і його.
 */
export async function writeOnec(pool: DbPool, inv: readonly OnecInvoice[], pay: readonly OnecPayment[], noDeal: readonly OnecNoDealRow[]):
  Promise<{ invoices: number; payments: number; noDeal: number | null; noDealError?: string }> {
  const out = await inTx(pool, (db) => replaceOnec(db, inv, pay));
  try {
    const snap = await inTx(pool, (db) => replaceNoDeal(db, noDeal));
    return { ...out, noDeal: snap.rows };
  } catch (e) {
    const message = (e as Error).message;
    await pool.query(`INSERT INTO onec_no_deal_state (id, error, error_at) VALUES (1, $1, now())
      ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`, [message.slice(0, 500)]).catch(() => undefined);
    return { ...out, noDeal: null, noDealError: message };
  }
}
