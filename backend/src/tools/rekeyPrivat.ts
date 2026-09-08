/**
 * ПЕРЕЗАВЕДЕННЯ ВИПИСКИ ПРИВАТУ ПІД НОВИЙ КЛЮЧ (`ID` замість `REF`).
 *
 * Навіщо — див. `bankSources/privat.ts` → `privatTxKey`: ключ за `REF` склеював платіж із
 * комісією за нього, і за 30 днів 370 вихідних платежів у базі замінились рядками «−3 грн».
 *
 * Що робить, по рахунку за рахунком, лише `bank = 'privat'`:
 *   1. тягне з API ВСЮ історію від найстаршого рядка рахунку в базі (−1 день);
 *   2. в ОДНІЙ транзакції: видаляє рядки цього рахунку зі старим ключем (`'privat:' || REF`,
 *      де є `ID` і він відмінний від `REF`) і вставляє все, що привіз API, новим ключем.
 *
 * 🔴 ПОРЯДОК НЕ ВИПАДКОВИЙ: мережа ДО транзакції. Якщо Приват не відповів — нічого не
 * видалено, база лишається як була. Якщо відповів частково (обрив пагінації) — `fetch`
 * кидає, і транзакція не починається.
 *
 * ⚠️ Джерело правди — банк, тому «видалити й завести знову» безпечно: банк віддає те саме.
 * Звʼязків на `bank_transactions.id` у схемі немає (перевірено 08.09.2026: зіставлення
 * платежів рахується на льоту й лише по вхідних).
 *
 *   node dist/tools/rekeyPrivat.js            # звіт, нічого не пише
 *   node dist/tools/rekeyPrivat.js --write    # виконати
 */
import { pool } from "../db/pool.js";
import { isBankFee } from "../core/bankReport.js";
import { toUah } from "../bankSources/fx.js";
import { fetchTransactions } from "../bankSources/privat.js";
import type { BankAccountRow } from "../bankSources/types.js";

const WRITE = process.argv.includes("--write");

async function main(): Promise<void> {
  const accounts = await pool.query<BankAccountRow & { id: number }>(
    `SELECT id, company, bank, label, currency, external_account_id, iban, env_key_name
       FROM bank_accounts WHERE is_active = true AND bank = 'privat' ORDER BY id`);
  for (const acc of accounts.rows) {
    if (!acc.env_key_name || !process.env[acc.env_key_name]) { console.log(`— «${acc.label}»: немає токена, пропущено`); continue; }
    const { rows: [b] } = await pool.query<{ mn: Date | null; n: number; old: number }>(
      `SELECT min(booked_at) AS mn, count(*)::int AS n,
              count(*) FILTER (WHERE external_tx_id = 'privat:' || (raw_json->>'REF')
                                 AND raw_json->>'ID' IS NOT NULL AND raw_json->>'ID' <> raw_json->>'REF')::int AS old
         FROM bank_transactions WHERE account_id = $1`, [acc.id]);
    const since = b.mn ? new Date(new Date(b.mn).getTime() - 24 * 3600 * 1000) : new Date(Date.now() - 60 * 864e5);
    const txs = await fetchTransactions(acc, since);
    const keys = new Set(txs.map((t) => t.externalTxId));
    console.log(`«${acc.label}»: у базі ${b.n} (старим ключем ${b.old}) · API від ${since.toISOString().slice(0, 10)}: ${txs.length} записів, ${keys.size} унікальних`);
    if (txs.length !== keys.size) throw new Error(`«${acc.label}»: ключі не унікальні (${txs.length} ≠ ${keys.size}) — новий ключ теж клеїть; СТОП`);
    if (!WRITE) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const del = await client.query(
        `DELETE FROM bank_transactions
          WHERE account_id = $1 AND external_tx_id = 'privat:' || (raw_json->>'REF')
            AND raw_json->>'ID' IS NOT NULL AND raw_json->>'ID' <> raw_json->>'REF'`, [acc.id]);
      let ins = 0;
      for (const tx of txs) {
        const when = tx.processedAt ?? tx.bookedAt;
        const { amountUah, rate } = await toUah(tx.amount, tx.currency, tx.fxRate, when);
        const r = await client.query(
          `INSERT INTO bank_transactions
             (account_id, direction, external_tx_id, booked_at, processed_at, counterparty_name,
              counterparty_iban, purpose, amount, currency, fx_rate, amount_uah, unmatched_account, raw_json, is_bank_fee)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13,$14)
           ON CONFLICT (external_tx_id) DO UPDATE SET
             booked_at=EXCLUDED.booked_at, processed_at=EXCLUDED.processed_at,
             counterparty_name=EXCLUDED.counterparty_name, counterparty_iban=EXCLUDED.counterparty_iban,
             purpose=EXCLUDED.purpose, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
             fx_rate=EXCLUDED.fx_rate, amount_uah=EXCLUDED.amount_uah, is_bank_fee=EXCLUDED.is_bank_fee
           RETURNING (xmax = 0) AS inserted`,
          [acc.id, tx.direction, tx.externalTxId, tx.bookedAt, tx.processedAt, tx.counterpartyName,
           tx.counterpartyIban, tx.purpose, tx.amount, tx.currency, rate, amountUah, tx.raw as object,
           isBankFee(tx.counterpartyName, tx.purpose)]);
        if (r.rows[0]?.inserted) ins++;
      }
      // Інваріант ПЕРЕД комітом: рядків не стало менше, ніж було. Менше = API віддав не всю
      // історію, і коміт стер би платежі, яких банк уже не повертає. Тоді відкат, а не «ну майже».
      const { rows: [after] } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM bank_transactions WHERE account_id = $1`, [acc.id]);
      if (after.n < b.n) throw new Error(`«${acc.label}»: після перезаведення ${after.n} < ${b.n} — API віддав не всю історію; відкат`);
      await client.query("COMMIT");
      console.log(`  ✓ видалено ${del.rowCount}, вставлено нових ${ins}, разом стало ${after.n} (було ${b.n}, +${after.n - b.n})`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally { client.release(); }
  }
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1); });
