/**
 * 🏷 ЛІД І КАМПАНІЯ РЕКЛАМНОЇ УГОДИ (задача #8702, 10.11.2026) — чисті SQL-фрагменти без доступу до бази, щоб їх
 * могли тримати юніт-гейти (`#3315b`) і щоб `metrics` і `money` брали одне означення.
 */

/**
 * 🧬 ЛІД УГОДИ — БАТЬКО, ЯКЩО ЦЕ КОПІЯ. Копія з «Кваліфікації» у «Перевозки» — не новий лід: дата ліда й мітка
 * кампанії беруться з першої батьківської угоди (`lead_child_links`). LATERAL з LIMIT 1, а не LEFT JOIN: у дитини
 * може бути кілька батьків, і JOIN подвоїв би рядок — а з ним і гроші.
 * Віддає колонки `par.created_at_kommo`, `par.utm_campaign`, `par.adv_camp` (NULL, якщо угода не копія).
 */
export const LEAD_PARENT_JOIN = (dealAlias: string): string => `
  LEFT JOIN LATERAL (SELECT pd.created_at_kommo, pd.utm_campaign, pd.adv_camp
                       FROM lead_child_links lcl JOIN deals pd ON pd.kommo_id = lcl.parent_id
                      WHERE lcl.child_id = ${dealAlias}.kommo_id
                      ORDER BY lcl.created_at, lcl.parent_id LIMIT 1) par ON true`;

/** Значення мітки, що НЕ є кампанією (замір 10.11.2026: 1 652 рекламні угоди мали саме їх) — у рядок «без мітки». */
export const NOT_A_CAMPAIGN = ["(organic)", "(direct)", "(not set)"] as const;

/**
 * КАМПАНІЯ ЛІДА: мітка першого заходу на сайт — utm_campaign (нове покоління) або ADV_CAMP (старе), спершу в батька,
 * потім у самої угоди. Порожнє й не-кампанії → NULL. Потребує `LEAD_PARENT_JOIN` того ж аліаса.
 */
export const adCampaignTagSql = (dealAlias: string): string => `(SELECT CASE WHEN t.v = ANY(ARRAY['${NOT_A_CAMPAIGN.join("','")}']) THEN NULL ELSE t.v END
    FROM (SELECT btrim(COALESCE(NULLIF(btrim(par.utm_campaign), ''), NULLIF(btrim(par.adv_camp), ''),
                               NULLIF(btrim(${dealAlias}.utm_campaign), ''), NULLIF(btrim(${dealAlias}.adv_camp), ''))) AS v) t)`;
