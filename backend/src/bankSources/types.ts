// Спільний контракт банк-адаптерів. Кожен банк → NormalizedTx[].
export interface BankAccountRow {
  id: number;
  company: string;
  bank: "mono" | "privat";
  label: string;
  currency: string;
  external_account_id: string | null;
  iban: string | null;
  env_key_name: string | null;
}

export interface NormalizedTx {
  externalTxId: string;              // унікальний id транзакції в банку (ідемпотентність)
  direction: "in" | "out";
  bookedAt: Date;                    // клієнтська дата
  processedAt: Date | null;          // час проводки
  counterpartyName: string | null;   // платник (in) / отримувач (out)
  counterpartyIban: string | null;
  purpose: string | null;
  amount: number;                    // signed, у валюті рахунку (+ надходження, − списання)
  currency: string;
  fxRate: number | null;             // UAH за 1 одиницю, ЯКЩО банк дав; інакше null → фолбек НБУ
  raw: unknown;
}

export interface AccountBalance { amount: number; currency: string }

export interface BankAdapter {
  fetchTransactions(account: BankAccountRow, since: Date): Promise<NormalizedTx[]>;
  /** Опційно: резолвить банківський id рахунку (напр. mono ФОП-рахунок через client-info),
   *  коли external_account_id ще не збережено. Повертає id або null (не знайдено). */
  resolveAccountId?(account: BankAccountRow): Promise<string | null>;
  /** Опційно: поточний залишок рахунку (mono client-info / privat closing-balance).
   *  Повертає null, якщо недоступно (нема ключа / 403 / банк не дав) — тоді «—», без крашу. */
  fetchBalance?(account: BankAccountRow): Promise<AccountBalance | null>;
}
