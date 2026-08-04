import {
  SEGMENT_MIN_PAYMENTS, VIP_MAX_GAP_DAYS, REGULAR_MAX_GAP_DAYS,
  SEGMENT_SLEEPING_DAYS, LOST_DAYS, ARCHIVE_DAYS,
} from "./reactivationRules.js";

/**
 * 🧭 СЕГМЕНТ І СТАН КЛІЄНТА — ОДИН SQL НА ДВА ЕКРАНИ.
 *
 * 🔴 НАВІЩО СПІЛЬНИЙ ФРАГМЕНТ, А НЕ ДВА СХОЖІ ЗАПИТИ. Планування і реактивація
 * тепер РОЗДІЛЕНІ за станом: активні — в плануванні, сплячі й втрачені — в
 * реактивації. Якщо стан рахуватимуть два різні запити, вони рано чи пізно
 * розійдуться — і клієнт зникне з ОБОХ екранів або зʼявиться на обох. Перше
 * помітять через тиждень, друге — ніколи.
 *
 * Пороги приходять із `reactivationRules.ts` (чистий файл) і підставляються в
 * SQL, а не дублюються числами: підкрутили правило — поїхали обидва екрани.
 *
 * Повертає CTE `seg` з колонками:
 *   client_key · payments · median_gap · days_since · segment · state · archived
 *   · payment_type · phone_key
 *
 * `$1` має бути масивом GENERIC_CLIENT_KEYS.
 */
export const SEGMENT_CTE = `
  seg_paid AS (
    SELECT d.client_key, d.closed_at_kommo, d.payment_type
      FROM deals d
      JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       AND NOT (d.client_key = ANY($1)) AND d.closed_at_kommo IS NOT NULL
  ),
  seg_gaps AS (
    SELECT client_key,
           EXTRACT(EPOCH FROM (closed_at_kommo
             - LAG(closed_at_kommo) OVER (PARTITION BY client_key ORDER BY closed_at_kommo)))/86400 AS gap
      FROM seg_paid
  ),
  seg_med AS (
    SELECT client_key, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap
      FROM seg_gaps WHERE gap IS NOT NULL GROUP BY client_key
  ),
  seg_base AS (
    SELECT p.client_key,
           COUNT(*)::int AS payments,
           m.median_gap,
           (CURRENT_DATE - (MAX(p.closed_at_kommo) AT TIME ZONE 'Europe/Kyiv')::date)::int AS days_since,
           -- Форма оплати клієнта = найчастіша серед його оплат. MODE, а не
           -- «остання»: одна випадкова готівкова угода не має перекидати фірму.
           MODE() WITHIN GROUP (ORDER BY p.payment_type) AS payment_type
      FROM seg_paid p LEFT JOIN seg_med m ON m.client_key = p.client_key
     GROUP BY p.client_key, m.median_gap
  ),
  seg AS (
    SELECT b.*,
           (b.client_key ~ '^[0-9]+$') AS phone_key,
           CASE
             WHEN b.payments < ${SEGMENT_MIN_PAYMENTS} OR b.median_gap IS NULL THEN 'unknown'
             WHEN b.median_gap <= ${VIP_MAX_GAP_DAYS} THEN 'vip'
             WHEN b.median_gap <= ${REGULAR_MAX_GAP_DAYS} THEN 'regular'
             ELSE 'episodic'
           END AS segment
      FROM seg_base b
  ),
  seg_state AS (
    SELECT s.*,
           CASE
             WHEN s.days_since >= ${LOST_DAYS} THEN 'lost'
             WHEN s.days_since >= (CASE s.segment
                    WHEN 'vip' THEN ${SEGMENT_SLEEPING_DAYS.vip}
                    WHEN 'regular' THEN ${SEGMENT_SLEEPING_DAYS.regular}
                    WHEN 'episodic' THEN ${SEGMENT_SLEEPING_DAYS.episodic}
                    ELSE ${SEGMENT_SLEEPING_DAYS.unknown} END) THEN 'sleeping'
             ELSE 'active'
           END AS state,
           (s.days_since >= ${ARCHIVE_DAYS}) AS archived
      FROM seg s
  )`;

/**
 * 📵 ТЕЛЕФОННІ ДЖЕНЕРИКИ — геть із реактивації, КРІМ безготівкових
 * (рішення власника 04.08.2026).
 *
 * Клієнт із ключем-телефоном («380685263085») — це переважно разовий фізик, а не
 * клієнт із історією. Але серед них є й реальні фірми з кривим ключем — їх видає
 * форма оплати «Безнал з ПДВ / без ПДВ».
 *
 * 🟢 СТРАХОВКА ЗАМІРЯНА (прод, 04.08.2026): прибирається 294 із 388, лишається 94.
 * Топ-10 прибраних за грошима — усі з ПОРОЖНЬОЮ формою оплати і давністю
 * 1 034-2 246 днів, тобто легасі до появи поля. Цінного не викинули.
 */
export const REACTIVATION_KEEP_SQL =
  `(NOT s.phone_key OR COALESCE(s.payment_type, '') ILIKE '%езнал%')`;
