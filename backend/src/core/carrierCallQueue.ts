import type { Db } from "./adCallFacts.js";
import { CARRIER_RULE } from "./carrierCallRules.js";

/**
 * Дзвінки мобільних, що зараз під межею черги «Перевізників за розмовою»: своя розмова угоди, яку бачили на
 * етапі за останні `keepDays`. Окремий модуль, бо його читають ОБИДВІ джоби: мобільна бере в роботу лише їх,
 * а годинна рекламна — не прибирає й не оплачує їх під своєю стелею.
 */
export async function carrierActiveIds(db: Db, now: Date): Promise<string[]> {
  const r = await db.query<{ u: string }>(
    `SELECT DISTINCT uniqueid AS u FROM carrier_call_deals
      WHERE state = 'own' AND seen_at >= $1::timestamptz - make_interval(days => $2)`,
    [now.toISOString(), CARRIER_RULE.keepDays]);
  return r.rows.map((x) => x.u);
}
