import { pool } from "../db/pool.js";
import { adDealSql } from "./metrics.js";
import { dealCampaignSql, GENERIC_CLIENT_KEYS_SQL, LEAD_PARENT_JOIN } from "./adCampaign.js";
import { loadClientSegments } from "./clientSegments.js";
import { foldAdClients, type AdClient, type AdClientsReport } from "./adClientsFold.js";
export type { AdClient, AdClientsCampaign, AdClientsReport } from "./adClientsFold.js";

/**
 * 👥 КЛІЄНТИ З РЕКЛАМИ: ПОСТІЙНІ, ТИПИ, LTV (задача #8709; зустріч 09.11.2026 — Сергій: «скільки з реклами прийшло
 * постійних, LTV… VIP, епізодичних»; Роман 11.11: постійний — 2+ успішні, як у ядрі).
 *
 *  • Клієнт з реклами — `client_key`, у якого є хоч одна рекламна угода (`adDealSql`, той самий предикат, що в
 *    плитках). Заглушки «Название не указано» відкинуто (`GENERIC_CLIENT_KEYS_SQL`).
 *  • ПЕРШИЙ рекламний лід — найраніша з цих угод (копія → дата батька). Кампанія клієнта — кампанія цієї угоди
 *    (`dealCampaignSql`); `null` — клієнт без жодної рекламної мітки.
 *  • Період відбирає клієнтів за датою першого ліда; маржа (LTV) — УСІ оплачені угоди клієнта (етап «paid» карти
 *    етапів, як у сегментах ядра) від першого ліда до сьогодні, і не з реклами теж: так кампанія отримує і ручні
 *    повторні замовлення, як і казав Сергій.
 *  • «Постійний» і тип — НЕ свій розрахунок, а `loadClientSegments()` ядра (`qualified`, `segment`): той самий
 *    клієнт на «Клієнти та реактивація» і тут має той самий статус. Тримає `#3316`.
 */

export const AD_CLIENTS_SQL = `
  WITH ad AS (
    SELECT d.client_key, d.kommo_id, d.client_name,
           COALESCE(par.created_at_kommo, d.created_at_kommo) AS lead_at,
           ${dealCampaignSql("d")} AS campaign
      FROM deals d
      ${LEAD_PARENT_JOIN("d")}
     WHERE d.client_key IS NOT NULL AND NOT (d.client_key = ANY(${GENERIC_CLIENT_KEYS_SQL}))
       AND ${adDealSql("$1")}
  ),
  first AS (
    SELECT DISTINCT ON (client_key) client_key, lead_at, campaign, client_name
      FROM ad WHERE lead_at IS NOT NULL
     ORDER BY client_key, lead_at, kommo_id
  )
  SELECT f.client_key, f.campaign, COALESCE(NULLIF(btrim(f.client_name), ''), f.client_key) AS name,
         to_char((f.lead_at AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS first_lead,
         pm.deals, pm.margin
    FROM first f
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS deals, COALESCE(SUM(p.price), 0) AS margin
        FROM deals p
        JOIN pipeline_stage_map psm ON psm.pipeline_id = p.pipeline_id AND psm.status_id = p.status_id
       WHERE p.client_key = f.client_key AND psm.funnel_stage = 'paid'
         AND COALESCE(p.closed_at_kommo, p.created_at_kommo) >= f.lead_at
    ) pm ON true
   WHERE (f.lead_at AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
     AND (f.lead_at AT TIME ZONE 'Europe/Kyiv')::date <= $3::date`;

export async function adClients(from: string, to: string, adSources: string[]): Promise<AdClientsReport> {
  const [rows, segments] = await Promise.all([
    pool.query<{ client_key: string; campaign: string | null; name: string; first_lead: string; deals: number; margin: string }>(
      AD_CLIENTS_SQL, [adSources, from, to]),
    loadClientSegments(),
  ]);
  const clients: AdClient[] = rows.rows.map((r) => {
    const seg = segments.get(r.client_key);
    return {
      clientKey: r.client_key, name: r.name, campaign: r.campaign, firstLead: r.first_lead,
      segment: seg?.segment ?? "unknown", qualified: seg?.qualified ?? false,
      deals: Number(r.deals ?? 0), margin: Number(r.margin ?? 0),
    };
  });
  return foldAdClients(clients, from, to);
}
