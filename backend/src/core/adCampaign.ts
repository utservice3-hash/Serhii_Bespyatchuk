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

/**
 * Значення мітки, що НЕ є кампанією (замір 10.11.2026: 1 652 рекламні угоди мали саме їх; «(referral)» — 13 угод,
 * знайдено на проді 11.11) — у рядок «без мітки».
 */
export const NOT_A_CAMPAIGN = ["(organic)", "(direct)", "(not set)", "(referral)"] as const;

/**
 * Ключі-заглушки клієнта — копія `metrics.GENERIC_CLIENT_KEYS` (цей модуль чистий і не тягне пул). Розходження
 * копій ловить `#3316c`. Без них «Название не указано» склеїв би сотні різних людей в одного «клієнта».
 */
export const GENERIC_CLIENT_KEYS_SQL = `ARRAY['названиенеуказано','companynamenotspecified','']`;

/** Власна мітка угоди (без батька) — для пошуку першої мітки КЛІЄНТА. */
const ownTagSql = (a: string): string => `(SELECT CASE WHEN t.v = ANY(ARRAY['${NOT_A_CAMPAIGN.join("','")}']) THEN NULL ELSE t.v END
    FROM (SELECT btrim(COALESCE(NULLIF(btrim(${a}.utm_campaign), ''), NULLIF(btrim(${a}.adv_camp), ''))) AS v) t)`;

/**
 * 🧲 КАМПАНІЯ КЛІЄНТА (задача #8709; Сергій 09.11: «перший контакт — геомітка… далі, якщо менеджер створює угоди,
 * надходження саме реклама відноситься до цього клієнта»): мітка НАЙРАНІШОЇ угоди того самого клієнта, що має
 * справжню кампанію. Клієнти-заглушки (`GENERIC_CLIENT_KEYS_SQL`) не мають кампанії — інакше склеїлись би.
 */
export const clientCampaignSql = (dealAlias: string): string => `(SELECT ${ownTagSql("cd")}
    FROM deals cd
   WHERE cd.client_key = ${dealAlias}.client_key AND ${dealAlias}.client_key IS NOT NULL
     AND NOT (${dealAlias}.client_key = ANY(${GENERIC_CLIENT_KEYS_SQL}))
     AND ${ownTagSql("cd")} IS NOT NULL
   ORDER BY cd.created_at_kommo, cd.kommo_id LIMIT 1)`;

/**
 * КАМПАНІЯ УГОДИ ДЛЯ ЕКРАНА: власна мітка (через батька), а якщо її немає — кампанія клієнта. Так ручна угода
 * менеджера без мітки йде в кампанію, з якої клієнт прийшов уперше. Потребує `LEAD_PARENT_JOIN` того ж аліаса.
 */
export const dealCampaignSql = (dealAlias: string): string => `COALESCE(${adCampaignTagSql(dealAlias)}, ${clientCampaignSql(dealAlias)})`;

/**
 * КАМПАНІЯ ЛІДА: мітка першого заходу на сайт — utm_campaign (нове покоління) або ADV_CAMP (старе), спершу в батька,
 * потім у самої угоди. Порожнє й не-кампанії → NULL. Потребує `LEAD_PARENT_JOIN` того ж аліаса.
 */
export const adCampaignTagSql = (dealAlias: string): string => `(SELECT CASE WHEN t.v = ANY(ARRAY['${NOT_A_CAMPAIGN.join("','")}']) THEN NULL ELSE t.v END
    FROM (SELECT btrim(COALESCE(NULLIF(btrim(par.utm_campaign), ''), NULLIF(btrim(par.adv_camp), ''),
                               NULLIF(btrim(${dealAlias}.utm_campaign), ''), NULLIF(btrim(${dealAlias}.adv_camp), ''))) AS v) t)`;
