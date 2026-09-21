import { pool } from "../db/pool.js";
import { isHidden, type HiddenPayee } from "./bankReport.js";
import { excludeHidden, type RawTx, type StatementBank } from "./bankStatementCsv.js";

/**
 * Рядки для виписки у форматі банку. Формат — у чистому `bankStatementCsv.ts`; тут лише
 * ВИБІРКА і та сама межа прихованих отримувачів, що на екрані «Виписка».
 *
 * 🔴 ПРИХОВАНІ ВИКЛЮЧАЮТЬСЯ НА СЕРВЕРІ, І ЇХ КІЛЬКІСТЬ ПОВЕРТАЄТЬСЯ. Роль без
 * `view_hidden_payments` отримає файл КОРОТШИЙ за банківський — і це мусить бути видно
 * числом, інакше бухгалтер звірятиме з 1С файл, про неповноту якого не знає. Фільтр той
 * самий, що у `feedPage`: лише ВИХІДНІ, за імʼям отримувача (`isHidden`).
 * Комісії банку НЕ відкидаються (стрічка екрана їх ховає, банківський файл — ні): заміряно
 * 21.09.2026 — 178 зі 178 рядків банку зійшлись саме з повною вибіркою.
 */
export interface StatementData {
  bank: StatementBank; label: string; iban: string | null;
  rows: RawTx[]; hiddenExcluded: number;
}

export async function statementData(
  accountId: number, from: string, to: string, payees: HiddenPayee[], canSeeHidden: boolean,
): Promise<StatementData | null> {
  const acc = await pool.query<{ bank: string; label: string; iban: string | null }>(
    `SELECT bank, label, iban FROM bank_accounts WHERE id = $1`, [accountId]);
  const a = acc.rows[0];
  if (!a || (a.bank !== "privat" && a.bank !== "mono")) return null;
  const r = await pool.query<{ direction: string; counterparty_name: string | null; raw_json: RawTx | null }>(
    `SELECT t.direction, t.counterparty_name, t.raw_json
       FROM bank_transactions t
      WHERE t.account_id = $1
        AND (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3`,
    [accountId, from, to]);
  const { visible, hiddenExcluded } = excludeHidden(r.rows, (n) => isHidden(n, payees), canSeeHidden);
  return { bank: a.bank, label: a.label, iban: a.iban, rows: visible.map((x) => x.raw_json ?? {}), hiddenExcluded };
}
