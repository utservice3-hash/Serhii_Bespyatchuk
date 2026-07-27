// Синк банк-виписок — що ~15 хв. Активні рахунки → адаптер банку → нормалізація → UAH →
// upsert по external_tx_id (ідемпотентно). Нема env для рахунку → warning + skip (не краш).
import { pool } from "../db/pool.js";
import { toUah } from "../bankSources/fx.js";
import * as mono from "../bankSources/mono.js";
import * as privat from "../bankSources/privat.js";
import type { BankAccountRow, NormalizedTx, BankAdapter } from "../bankSources/types.js";

const ADAPTERS: Record<BankAccountRow["bank"], BankAdapter> = { mono, privat };
// Історія ≥60 днів. mono statement обмежений 31 добою/запит → адаптер сам чанкує (2 вікна на 60д);
// privat покриває вікно followId-пагінацією. Нічого молодшого за 60 днів не чистимо.
const INITIAL_LOOKBACK_DAYS = 60;

/** Upsert однієї транзакції. Повертає true, якщо вставлено НОВУ (для лічильника). */
export async function upsertTx(accountId: number, tx: NormalizedTx, unmatched = false): Promise<boolean> {
  const when = tx.processedAt ?? tx.bookedAt;
  const { amountUah, rate } = await toUah(tx.amount, tx.currency, tx.fxRate, when);
  const r = await pool.query(
    `INSERT INTO bank_transactions
       (account_id, direction, external_tx_id, booked_at, processed_at, counterparty_name,
        counterparty_iban, purpose, amount, currency, fx_rate, amount_uah, unmatched_account, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (external_tx_id) DO UPDATE SET
       booked_at=EXCLUDED.booked_at, processed_at=EXCLUDED.processed_at,
       counterparty_name=EXCLUDED.counterparty_name, counterparty_iban=EXCLUDED.counterparty_iban,
       purpose=EXCLUDED.purpose, amount=EXCLUDED.amount, currency=EXCLUDED.currency,
       fx_rate=EXCLUDED.fx_rate, amount_uah=EXCLUDED.amount_uah
     RETURNING (xmax = 0) AS inserted`,
    [accountId, tx.direction, tx.externalTxId, tx.bookedAt, tx.processedAt, tx.counterpartyName,
     tx.counterpartyIban, tx.purpose, tx.amount, tx.currency, rate, amountUah, unmatched, tx.raw as object]
  );
  return r.rows[0]?.inserted === true;
}

export async function syncBank(): Promise<{ synced: number; inserted: number; skipped: string[] }> {
  const accounts = await pool.query<BankAccountRow>(
    `SELECT id, company, bank, label, currency, external_account_id, iban, env_key_name
       FROM bank_accounts WHERE is_active = true`
  );
  let inserted = 0, synced = 0;
  const skipped: string[] = [];
  for (const acc of accounts.rows) {
    const token = acc.env_key_name ? process.env[acc.env_key_name] : undefined;
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
      const since = last.rows[0]?.b
        ? new Date(new Date(last.rows[0].b).getTime() - 24 * 3600 * 1000) // −1 день перекриття
        : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 24 * 3600 * 1000);
      const txs = await adapter.fetchTransactions(acc, since);
      for (const tx of txs) { if (await upsertTx(acc.id, tx)) inserted++; }
      synced++;
    } catch (e) {
      // помилка банку (таймаут/ліміт) не валить синк інших рахунків
      console.error(`syncBank: «${acc.label}» помилка:`, (e as Error).message);
      skipped.push(acc.label);
    }
  }
  return { synced, inserted, skipped };
}
