import type { Db } from "./adCallFacts.js";
import { CARRIER_RULE } from "./carrierCallRules.js";

/**
 * Дзвінки мобільних, що зараз під межею черги «Перевізників за розмовою»: своя розмова угоди, яку бачили на
 * етапі за останні `keepDays`. Окремий модуль, бо його читають ОБИДВІ джоби: мобільна бере в роботу лише їх,
 * а годинна рекламна — не прибирає й не оплачує їх під своєю стелею.
 */
export async function carrierActiveIds(db: Db, now: Date, launchAt: Date | null = null): Promise<string[]> {
  const r = await db.query<{ u: string }>(
    `SELECT DISTINCT uniqueid AS u FROM carrier_call_deals
      WHERE state = 'own' AND seen_at >= $1::timestamptz - make_interval(days => $2)
        AND ($3::timestamptz IS NULL OR deal_created_at >= $3::timestamptz)`,
    [now.toISOString(), CARRIER_RULE.keepDays, launchAt ? launchAt.toISOString() : null]);
  return r.rows.map((x) => x.u);
}
