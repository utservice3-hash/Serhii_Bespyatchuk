// Синк банк-виписок — що ~15 хв. Активні рахунки → адаптер банку → нормалізація → UAH →
// upsert по external_tx_id (ідемпотентно). Нема env для рахунку → warning + skip (не краш).
import { pool } from "../db/pool.js";
import { isBankFee } from "../core/bankReport.js";
import { toUah } from "../bankSources/fx.js";
import * as mono from "../bankSources/mono.js";
import { tokenFor } from "../bankSources/token.js";
import * as privat from "../bankSources/privat.js";
import type { BankAccountRow, NormalizedTx, BankAdapter } from "../bankSources/types.js";
import { syncBankOutcome } from "./syncBankOutcome.js";
import { syncSince, onOrAfterSyncFrom } from "../core/bankSyncWindow.js";

const ADAPTERS: Partial<Record<BankAccountRow["bank"], BankAdapter>> = { mono, privat };
// Історія ≥60 днів (`INITIAL_LOOKBACK_DAYS`, `core/bankSyncWindow.ts`). mono statement обмежений 31 добою/запит →
// адаптер сам чанкує (2 вікна на 60д); privat покриває вікно followId-пагінацією. Нічого молодшого за 60 днів не чистимо.
// Рахунок із `sync_from` (ЄЛОГІСТ, 26.10.2026) раніше цієї дати не тягнеться й не пишеться ніколи.

/** Upsert однієї транзакції. Повертає true, якщо вставлено НОВУ (для лічильника). */
export async function upsertTx(accountId: number, tx: NormalizedTx, unmatched = false): Promise<boolean> {
  const when = tx.processedAt ?? tx.bookedAt;
  const { amountUah, rate } = await toUah(tx.amount, tx.currency, tx.fxRate, when);
  const fee = isBankFee(tx.counterpartyName, tx.purpose);
  const r = await pool.query(
    `INSERT INTO bank_transactions
       (account_id, direction, external_tx_id, booked_at, processed_at, counterparty_name,
        counterparty_iban, purpose, amount, currency, fx_rate, amount_uah, unmatched_account, raw_json, is_bank_fee)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (account_id, external_tx_id) DO UPDATE SET
       booked_at=EXCLUDED.booked_at, processed_at=EXCLUDED.processed_at,
       counterparty_name=EXCLUDED.counterparty_name, counterparty_iban=EXCLUDED.counterparty_iban,
       purpose=EXCLUDED.purpose, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       fx_rate=EXCLUDED.fx_rate, amount_uah=EXCLUDED.amount_uah, is_bank_fee=EXCLUDED.is_bank_fee
     RETURNING (xmax = 0) AS inserted`,
    [accountId, tx.direction, tx.externalTxId, tx.bookedAt, tx.processedAt, tx.counterpartyName,
     tx.counterpartyIban, tx.purpose, tx.amount, tx.currency, rate, amountUah, unmatched, tx.raw as object, fee]
  );
  return r.rows[0]?.inserted === true;
}

export async function syncBank(): Promise<{ synced: number; inserted: number; skipped: string[] }> {
  const accounts = await pool.query<BankAccountRow>(
    // `manual` (Сейф) — без банку: записи вносить людина (`core/bankManual.ts`), синкати нічого.
    `SELECT to_char(sync_from, 'YYYY-MM-DD') AS sync_from, to_char(resync_from, 'YYYY-MM-DD') AS resync_from,
            id, company, bank, label, currency, external_account_id, iban, env_key_name, mono_type, mono_pan_last4
       FROM bank_accounts WHERE is_active = true AND bank <> 'manual'`
  );
  let inserted = 0, synced = 0;
  const skipped: string[] = [];
  // Збої рахунків збираються ОКРЕМО від свідомих пропусків і після циклу стають помилкою
  // джоби — див. `syncBankOutcome.ts`, чому «рядок у лозі» тут не рахується за сигнал.
  const failed: { label: string; error: string }[] = [];
  for (const acc of accounts.rows) {
    const token = tokenFor(acc.env_key_name);
    if (!token) { skipped.push(acc.label); console.warn(`syncBank: рахунок «${acc.label}» пропущено — немає env ${acc.env_key_name}`); continue; }
    const adapter = ADAPTERS[acc.bank];
    if (!adapter) { skipped.push(acc.label); continue; }
    try {
      // external_account_id не збережено → резолвимо явно (mono: ФОП-рахунок через client-info).
      // Персистимо в БД, щоб більше не бити ліміт client-info. Statement цього ж циклу пропускаємо
      // (mono ліміт «1 запит / 60с» — client-info + statement підряд дали б 429); підтягне наступний.
      if (!acc.external_account_id && typeof adapter.resolveAccountId === "function") {
        const rid = await adapter.resolveAccountId(acc);
        if (!rid) { skipped.push(acc.label); console.warn(`syncBank: «${acc.label}» — не знайдено рахунок для привʼязки`); continue; }
        await pool.query(`UPDATE bank_accounts SET external_account_id=$1 WHERE id=$2`, [rid, acc.id]);
        acc.external_account_id = rid;
        // IBAN — лише коли порожній (правку адміна не перетираємо): без нього поповнення картки з наших рахунків
        // не впізнається як переказ між своїми (картка Олександра, 07.10.2026).
        if (!acc.iban && typeof adapter.resolveIban === "function") {
          const iban = await adapter.resolveIban(acc).catch(() => null);
          if (iban) await pool.query(`UPDATE bank_accounts SET iban=$1 WHERE id=$2 AND iban IS NULL`, [iban, acc.id]);
        }
        console.warn(`syncBank: «${acc.label}» привʼязано рахунок; виписку тягне наступний цикл`);
        continue;
      }
      // Баланс (best-effort, ПЕРЕД випискою): mono — з client-info, privat — closing-balance.
      // Немає ключа/доступу (403) → null → лишаємо старий («—»), не чіпаємо. Помилка не валить синк.
      if (typeof adapter.fetchBalance === "function") {
        try {
          const bal = await adapter.fetchBalance(acc);
          if (bal) await pool.query(
            `UPDATE bank_accounts SET balance_amount=$1, balance_currency=$2, balance_updated_at=now() WHERE id=$3`,
            [bal.amount, bal.currency, acc.id]);
        } catch (e) { console.warn(`syncBank: баланс «${acc.label}» пропущено:`, (e as Error).message); }
      }
      const last = await pool.query<{ b: Date }>(
        `SELECT MAX(booked_at) AS b FROM bank_transactions WHERE account_id=$1`, [acc.id]);
      // −1 день перекриття від останнього руху; без рухів — 60 днів; і ніколи не раніше `sync_from` рахунку.
      const since = syncSince(last.rows[0]?.b ? new Date(last.rows[0].b) : null, acc.sync_from ?? null, new Date(), acc.resync_from ?? null);
      const txs = await adapter.fetchTransactions(acc, since);
      for (const tx of txs) {
        if (!onOrAfterSyncFrom(tx.bookedAt, acc.sync_from ?? null)) continue;
        if (await upsertTx(acc.id, tx)) inserted++;
      }
      // Разове повторне завантаження відпрацювало — знімаємо позначку (лише ту саму: нову, поставлену під час проходу, не чіпаємо).
      if (acc.resync_from) await pool.query(`UPDATE bank_accounts SET resync_from = NULL WHERE id = $1 AND resync_from = $2::date`, [acc.id, acc.resync_from]);
      synced++;
    } catch (e) {
      // помилка банку (таймаут/ліміт) не валить синк ІНШИХ рахунків — цикл іде далі...
      console.error(`syncBank: «${acc.label}» помилка:`, (e as Error).message);
      failed.push({ label: acc.label, error: (e as Error).message });
    }
  }
  // ...але після циклу збій стає помилкою ДЖОБИ, інакше `runJob` запише успіх (#660).
  const outcome = syncBankOutcome({ failed, noToken: skipped });
  if (!outcome.ok) throw new Error(outcome.error);
  return { synced, inserted, skipped };
}
