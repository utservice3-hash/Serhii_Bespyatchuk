import { adCallFactsSql, foldFacts, OUTBOUND_TYPES_FOR_PROMISE, type AdCallFactsParams, type AdCallFactsRow,
  type AdDealCallFacts, type OutboundCall } from "./adCallFactsRules.js";

/**
 * Виконавець фактів із `adCallFactsRules.ts`. Базу дає той, хто кличе (`Db`), тож гейти
 * ганяють його на scratch-кластері з керованим «зараз», а джоба й пілот — на своєму пулі.
 * Модуль без `db/pool.js` з тієї самої причини, що й правила: імпорт пулу кидає без
 * `DATABASE_URL` ще до `skip`.
 */
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export async function adCallFacts(db: Db, p: AdCallFactsParams): Promise<AdDealCallFacts[]> {
  const q = adCallFactsSql(p);
  const rows = (await db.query<AdCallFactsRow>(q.sql, q.params)).rows;
  return rows.map(foldFacts);
}

/**
 * Наші вихідні на номер клієнта за проміжок — вхід для `promiseOutcome`. Номер — у формі
 * Ringostat (`380XXXXXXXXX`). Від будь-кого з менеджерів: обіцянку давала компанія.
 */
export async function outboundCallsTo(db: Db, clientPhone: string, from: Date, to: Date): Promise<OutboundCall[]> {
  const r = await db.query<{ calldate: Date; billsec: number; call_type: string }>(
    `SELECT calldate, billsec, call_type FROM ringostat_calls
      WHERE client_phone = $1 AND call_type = ANY($2::text[]) AND calldate > $3 AND calldate <= $4
      ORDER BY calldate, uniqueid`,
    [clientPhone, [...OUTBOUND_TYPES_FOR_PROMISE], from.toISOString(), to.toISOString()]);
  return r.rows.map((x) => ({ at: new Date(x.calldate), billsec: Number(x.billsec), callType: x.call_type }));
}
