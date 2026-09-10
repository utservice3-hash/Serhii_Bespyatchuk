import { LAST_PAID_CTE, LAST_PAID_JOIN, archivedSql } from "./clientArchive.js";

/**
 * 🧾 СПИСОК КЛІЄНТІВ ДЛЯ «ПЛАН МІСЯЦЯ» (`GET /dashboard/client-plans`) — один текст на роут і гейт.
 *
 * 🔴 ЧОМУ БАЗА МАТЕРІАЛІЗОВАНА, А СКОУП НАКЛАДАЄТЬСЯ ЗОВНІ (10.09.2026). Самохвалов:
 * «не відкривається план клієнтів» — `request timeout`. Заміряно на проді: адмін 0,23 с,
 * менеджер **21,7 с** при вартовому 20 с → 503. Планувальник оцінював CTE `paid` у **13 рядків**
 * (насправді 19 220), і з умовою `pm.manager_id = $2` ВСЕРЕДИНІ запиту обирав вкладений цикл,
 * який **838 разів** переобчислював `arch_paid` (loops=838 × ~30 мс). Статистика `deals` була
 * свіжа (автоаналіз тієї ж ночі) — це оцінка планувальника, а не протухлі stats.
 * З `base AS MATERIALIZED` і фільтром зверху: менеджер **0,14 с**, команда 0,14 с, адмін 0,25 с,
 * рядки ті самі (264 для менеджера 67).
 *
 * Колонки скоупу навмисно ТІ САМІ, що були в умові: `primary_manager_id` = основний за
 * оплатами (`pm.manager_id`), `team_id` = команда показаного менеджера (`mm.team_id`).
 * Змінити їх означало б змінити, кого бачить менеджер, — це не перф-правка.
 *
 * `cond` — готова умова з `$n` по аліасу `b`, порожня для адмін-рівня.
 */
export function clientsListSql(cond: string): string {
  return `WITH ${LAST_PAID_CTE},
     paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
          AND NOT (d.client_key = ANY($1))
     ),
     agg AS (
       SELECT client_key, COUNT(*)::int AS orders, COALESCE(SUM(price),0) AS revenue,
              MIN(closed_at_kommo) AS first_paid, MAX(closed_at_kommo) AS last_paid
         FROM paid GROUP BY client_key HAVING COUNT(*) >= 2
     ),
     per_cm AS (
       SELECT client_key, manager_id, COUNT(*) AS n, MAX(closed_at_kommo) AS mx
         FROM paid GROUP BY 1, 2
     ),
     primary_mgr AS (
       SELECT DISTINCT ON (client_key) client_key, manager_id
         FROM per_cm ORDER BY client_key, n DESC, mx DESC
     ),
     base AS MATERIALIZED (
     SELECT a.client_key, a.orders, a.revenue, nm.client_name AS name, nm.payment_type,
            to_char(a.first_paid AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS first_paid,
            to_char(a.last_paid  AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS last_paid,
            COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id,
            pm.manager_id AS primary_manager_id,
            mm.name AS manager_name, lo.pinned_manager_id,
            mm.team_id, tt.name AS team_name
       FROM agg a
       JOIN primary_mgr pm ON pm.client_key = a.client_key
       -- 🔴 БЕЗ умови AND NOT lo.hidden У ЦЬОМУ JOIN — І ЦЕ НЕ КОСМЕТИКА.
       -- Було: LEFT JOIN … AND NOT lo.hidden, а нижче WHERE COALESCE(lo.hidden,false)=false.
       -- Для ПРИХОВАНОГО клієнта join не давав рядка → lo.hidden = NULL →
       -- COALESCE(NULL,false)=false → умова ІСТИННА, і клієнт лишався на екрані.
       -- Тобто дія «прибрати з постійних» роками писалась у базу й не робила НІЧОГО.
       -- Заміряно на живому сервері: hidden=true, а клієнт у видачі обох екранів.
       LEFT JOIN loyalty_overrides lo ON lo.client_key = a.client_key
       ${LAST_PAID_JOIN}
       JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id) AND mm.is_active
       LEFT JOIN teams tt ON tt.id = mm.team_id
       LEFT JOIN LATERAL (
         SELECT d2.client_name, d2.payment_type FROM deals d2
           JOIN pipeline_stage_map p2 ON p2.pipeline_id = d2.pipeline_id AND p2.status_id = d2.status_id
                                      AND p2.funnel_stage = 'paid'
          WHERE d2.client_key = a.client_key
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      -- 🗄 Архів замість hidden — те саме джерело, що в реактивації (гейт #38).
      WHERE NOT ${archivedSql("lo", "ap")}
     )
     SELECT b.* FROM base b
      WHERE 1=1 ${cond}
      ORDER BY b.revenue DESC`;
}
