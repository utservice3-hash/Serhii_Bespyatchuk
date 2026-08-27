/**
 * 🛒 «ЗАМОВИВ» — ОДНЕ ОЗНАЧЕННЯ НА ВЕСЬ ПРОДУКТ.
 *
 * 🔴 НАВІЩО. Означення жило ТРИЧІ — `clientArchive.LAST_PAID_CTE`, `reactivation.ts`
 * і `clientSegments.ts`, — і всі три казали те саме: угода дійшла до
 * `funnel_stage = 'paid'`, анкер `MAX(closed_at_kommo)`, київська дата.
 * 📐 Заміряно 27.08.2026: розбіжність «днів без замовлення» — **0 із 639** клієнтів.
 * Небезпека не в тому, що копії різні, а в тому, що їх ТРИ: дописати гілку в одну —
 * справа рядка. Це історія чипів «новий/постійний», де дві копії збігалися ОДНА З
 * ОДНОЮ, а не з правилом.
 *
 * 🔴 ДВА РІЗНІ ПИТАННЯ, І ОДНЕ НЕ СМІЄ ТИХО ОЗНАЧАТИ ДРУГЕ:
 *   «СКІЛЬКИ РАЗІВ замовляв» — `COUNT(*)`: недатована оплачена угода існує, і в
 *      рахунок замовлень вона входить.
 *   «КОЛИ ВОСТАННЄ»          — `MAX(closed_at_kommo)`: без дати відповісти НЕМОЖЛИВО,
 *      і `MAX` таку угоду ігнорує.
 * 📐 Недатовані оплачені угоди вже існують: **325 у 98 клієнтів** (замір проти живого
 * прода 27.08.2026, у момент дії — вранці того ж дня їх було 324 у 97, тобто число
 * РОСТЕ; звіряти заміром, а не цитатою звідси). Нульова розбіжність між копіями була
 * НЕ доказом узгодженості, а наслідком того, що `MAX` ігнорує `NULL` однаково в обох, —
 * тобто копії згодні одна з одною, а не з правдою.
 *
 * ⚠️ ЩО ЦЕ НЕ МІНЯЄ. Кваліфікація постійного бере `payments` (усі оплати) — як і
 * брала. Підміна на `paymentsDated` перевернула б **10 клієнтів** (усі «постійний →
 * разовий», усі рівно з 3 оплатами на порозі), «Активних» 142 → 136, «>30 дн» 34 → 33.
 * Це ціна МАЙБУТНЬОГО рішення власника, а не наявна розбіжність, тож правило тут
 * НЕ змінюється.
 */

/** Предикат оплаченої угоди — те, що робить угоду «замовленням». */
export const PAID_DEAL_JOIN = `
  JOIN pipeline_stage_map psm_ord ON psm_ord.pipeline_id = d.pipeline_id
                                 AND psm_ord.status_id  = d.status_id`;
export const PAID_DEAL_WHERE = `psm_ord.funnel_stage = 'paid' AND d.client_key IS NOT NULL`;

/**
 * CTE «останнє замовлення клієнта» + ОБИДВІ величини окремо.
 * `alias` — імʼя CTE, щоб виклик міг вбудувати його у свій `WITH`.
 */
export function lastOrderCte(alias = "client_orders", opts: { extraWhere?: string; having?: string } = {}): string {
  return `${alias} AS (
    SELECT d.client_key,
           COUNT(*)::int                    AS orders,          -- скільки разів замовляв
           COUNT(d.closed_at_kommo)::int    AS orders_dated,    -- із них із датою
           MAX(d.closed_at_kommo)           AS last_order_at,   -- коли востаннє (NULL-и ігноруються)
           COALESCE(SUM(d.price), 0)        AS revenue
      FROM deals d ${PAID_DEAL_JOIN}
     WHERE ${PAID_DEAL_WHERE} ${opts.extraWhere ?? ""}
     GROUP BY d.client_key
     ${opts.having ?? ""}
  )`;
}

/** Днів від останнього замовлення, за КИЇВСЬКОЮ датою. `NULL` → 0 (мовчить нуль днів). */
export function daysSinceOrderSql(col = "last_order_at"): string {
  return `COALESCE((CURRENT_DATE - (${col} AT TIME ZONE 'Europe/Kyiv')::date)::int, 0)`;
}
