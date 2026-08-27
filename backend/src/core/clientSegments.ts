import { pool } from "../db/pool.js";
import { GENERIC_CLIENT_KEYS } from "./metrics.js";
import {
  segmentOf, stateOf, payModeOf, qualifiesAsRepeat, LONG_LAPSED_DAYS,
  inReactivationTab, keepInReactivation,
  type ClientSegment, type ClientState, type ClientPayMode,
} from "./reactivationRules.js";
// Обидва предикати вкладок живуть у ЧИСТОМУ модулі правил (він не тягне `db/pool`),
// а сюди лише ре-експортуються — щоб виклики лишились на місці, а копії не зʼявилось.
export { inReactivationTab, keepInReactivation };

/**
 * 🧭 СЕГМЕНТ І СТАН КЛІЄНТА — ОДНЕ ДЖЕРЕЛО НА ДВА ЕКРАНИ.
 *
 * 🔴 НАВІЩО СПІЛЬНЕ ДЖЕРЕЛО. Планування і реактивація РОЗДІЛЕНІ за станом:
 * активні — в плануванні, сплячі й втрачені — в реактивації. Якщо стан
 * рахуватимуть два різні місця, вони рано чи пізно розійдуться — і клієнт зникне
 * з ОБОХ екранів або зʼявиться на обох. Перше помітять через тиждень, друге —
 * ніколи.
 *
 * ⚡ ЧОМУ ОКРЕМИЙ ЗАПИТ, А НЕ CTE ВСЕРЕДИНІ ЗАПИТІВ ЕКРАНІВ (заміряно 05.08.2026).
 * Перша редакція підставляла цей фрагмент як `WITH …` у великі запити
 * `/client-plans` і `/reactivation-list`. Сам фрагмент дешевий — **77-303 мс**.
 * Але його оцінка рядків промахується у ~1800 разів (плановик каже `rows=10`,
 * фактично 18 001), і всередині великого запиту ця похибка отруює план:
 *
 * | ендпоінт | до | фрагмент усередині | окремим запитом |
 * |---|---|---|---|
 * | `/client-plans` | 1 276 мс | **20 768 мс** | ~1 600 мс |
 * | `/reactivation-list` | 703 мс | **10 512 мс** | ~1 000 мс |
 *
 * 🔴 20 768 мс — це БІЛЬШЕ за вартового `REQ_TIMEOUT_MS = 20_000` в `index.ts`,
 * тобто екран планів віддавав би **503**, а не «просто повільно». Саме на цьому
 * гейт `#30c` і зупинив хвилю 1. `MATERIALIZED` на CTE проблему НЕ знімає
 * (заміряно: 12 420 мс) — план псується не всередині фрагмента, а на стику.
 *
 * 🔴 ДРУГИЙ НАСЛІДОК ТОГО САМОГО РІШЕННЯ: `JOIN seg_state` був ВНУТРІШНІМ, а
 * фрагмент вимагав `closed_at_kommo IS NOT NULL`. Клієнт із 2+ оплатами, у яких
 * дата закриття не проставлена, випадав з ОБОХ екранів МОВЧКИ — рівно те, від чого
 * фрагмент і мав захистити. На проді такий один (`0674673308`, 3 оплати, 0 дат).
 * Тепер запит рахує ВСІ оплати, а дату вимагає лише там, де без неї не обійтись —
 * в інтервалах. Тримає гейт `#30n`.
 *
 * 🎯 ТУТ ЖЕ ЖИВЕ КВАЛІФІКАЦІЯ (`qualified`) — двошляхове правило власника
 * «хто взагалі є постійним». Вона МУСИТЬ стояти поруч із сегментом, а не окремо:
 * обидва екрани мають однаково відповідати і на «чи він наш постійний», і на
 * «з якою частотою він замовляє». Саме правило — у `reactivationRules.ts`,
 * чистою функцією; тут лише факти, з яких воно рахується.
 *
 * 🔴 ПРАВИЛО ЖИВЕ В ЧИСТИХ ФУНКЦІЯХ (`segmentOf`/`stateOf`), а SQL віддає лише
 * ФАКТИ (скільки оплат, медіанний інтервал, скільки днів мовчить). Раніше та сама
 * умова стояла двічі — `CASE` у SQL і функція в TS — і їх доводилось звіряти
 * тестом. Одна реалізація не може розійтись сама з собою.
 */

/** Сирі факти по клієнту — те, що вміє порахувати лише БД. */
export interface ClientSegmentFacts {
  clientKey: string;
  /** УСІ оплати, включно з тими, де не проставлена дата закриття (кваліфікація). */
  payments: number;
  /** Оплати З датою — лише з них можна рахувати частоту (сегмент). */
  paymentsDated: number;
  medianGapDays: number | null;
  /** НАЙМЕНШИЙ інтервал між сусідніми оплатами — ритм для кваліфікації. */
  minGapDays: number | null;
  daysSince: number;
  paymentType: string | null;
  payMode: ClientPayMode;
  phoneKey: boolean;
}

/** Факти + похідні від них (похідні рахують чисті функції). */
export interface ClientSegmentRow extends ClientSegmentFacts {
  segment: ClientSegment;
  state: ClientState;
  /**
   * 🔴 «ДАВНО ВТРАЧЕНИЙ» — ВІК БЕЗ ОПЛАТ, А НЕ РЕЄСТР АРХІВУ.
   * Поле звалось `archived`, і після появи вкладки «Архів» (реєстр із причиною,
   * датою й автором) на сусідніх екранах опинились ДВІ різні метрики під одним
   * словом: «архів 152» тут означало «не платив понад рік», а «Архів 0» там —
   * скільки клієнтів прибрали руками. Перейменовано рішенням власника 05.08.2026.
   */
  longLapsed: boolean;
  /** Двошляхова кваліфікація постійного. `false` = РАЗОВИЙ, не на екранах. */
  qualified: boolean;
  /**
   * ⭐ Клієнта включив КВП РУЧНО, попри правило (`loyalty_overrides.force_regular`).
   * Примітку тримаємо поруч, бо на екрані вона потрібна в ту саму мить, що й
   * позначка: «включений вручну» без «чому» через місяць нічим не відрізняється
   * від помилки. Примітку стереже `CHECK` у БД, не валідація роуту.
   */
  forcedRegular: boolean;
  forceNote: string | null;
}

/**
 * `$1` — масив `GENERIC_CLIENT_KEYS`. Один рядок на канонічний ключ.
 * `payment_type` — MODE, а не «остання»: одна випадкова готівкова угода не має
 * перекидати фірму в готівкові.
 */
const SEGMENT_FACTS_SQL = `
  WITH seg_paid AS (
    SELECT d.client_key, d.closed_at_kommo, d.payment_type
      FROM deals d
      JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       AND NOT (d.client_key = ANY($1))
  ),
  seg_gaps AS (
    SELECT client_key,
           EXTRACT(EPOCH FROM (closed_at_kommo
             - LAG(closed_at_kommo) OVER (PARTITION BY client_key ORDER BY closed_at_kommo)))/86400 AS gap
      FROM seg_paid WHERE closed_at_kommo IS NOT NULL
  ),
  seg_med AS (
    SELECT client_key,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap,
           MIN(gap) AS min_gap
      FROM seg_gaps WHERE gap IS NOT NULL GROUP BY client_key
  )
  SELECT p.client_key,
         COUNT(*)::int AS payments,
         COUNT(p.closed_at_kommo)::int AS payments_dated,
         m.median_gap, m.min_gap,
         -- Днів мовчання. Без жодної дати — 0: «мовчить нуль днів» це той самий
         -- стан "active", який екран показував до появи сегментів; вигадувати
         -- «сплячий» за датою, якої в CRM немає, ми не маємо права.
         COALESCE((CURRENT_DATE - (MAX(p.closed_at_kommo) AT TIME ZONE 'Europe/Kyiv')::date)::int, 0) AS days_since,
         MODE() WITHIN GROUP (ORDER BY p.payment_type) AS payment_type,
         -- 🔴 ФОРМУ ОПЛАТИ ДЛЯ КВАЛІФІКАЦІЇ беремо НЕ з MODE, а з наявності:
         -- «змішані — за безнальним правилом» (рішення власника). MODE у клієнта
         -- 2 готівки + 1 безнал сказав би «готівка» і зарахував би його в разові.
         BOOL_OR(COALESCE(p.payment_type,'') ILIKE '%езнал%') AS has_cashless,
         BOOL_OR(COALESCE(p.payment_type,'') ILIKE '%алич%'
                 OR COALESCE(p.payment_type,'') ILIKE '%отівк%') AS has_cash,
         (p.client_key ~ '^[0-9]+$') AS phone_key,
         COALESCE(lo.force_regular, false) AS forced_regular,
         lo.note AS force_note
    FROM seg_paid p
    LEFT JOIN seg_med m ON m.client_key = p.client_key
    -- ⭐ Ручний виняток КВП. LEFT JOIN, а не окремий запит: інакше «включений
    -- вручну» і «кваліфікований» рахувались би в різні моменти й розійшлися б.
    LEFT JOIN loyalty_overrides lo ON lo.client_key = p.client_key
   GROUP BY p.client_key, m.median_gap, m.min_gap, lo.force_regular, lo.note`;

/** Мапа `client_key → сегмент/стан`. Один запит на прохід екрана. */
export async function loadClientSegments(): Promise<Map<string, ClientSegmentRow>> {
  const rows = (await pool.query<{
    client_key: string; payments: number; payments_dated: number;
    median_gap: string | null; min_gap: string | null; days_since: number;
    payment_type: string | null; has_cashless: boolean; has_cash: boolean; phone_key: boolean;
    forced_regular: boolean; force_note: string | null;
  }>(SEGMENT_FACTS_SQL, [GENERIC_CLIENT_KEYS])).rows;

  const round1 = (v: string | null) => (v == null ? null : Math.round(Number(v) * 10) / 10);
  const map = new Map<string, ClientSegmentRow>();
  for (const r of rows) {
    const medianGapDays = round1(r.median_gap);
    const minGapDays = round1(r.min_gap);
    const payments = Number(r.payments);
    const paymentsDated = Number(r.payments_dated);
    const daysSince = Number(r.days_since);
    // 🔴 СЕГМЕНТ — від ОПЛАТ ІЗ ДАТОЮ: частота рахується з інтервалів, а інтервал
    // без дати не існує. Кваліфікація натомість дивиться на ВСІ оплати — факт
    // оплати є фактом, навіть коли менеджер не проставив дату закриття.
    const segment = segmentOf(medianGapDays, paymentsDated);
    const payMode = payModeOf(r.has_cash, r.has_cashless);
    map.set(r.client_key, {
      clientKey: r.client_key, payments, paymentsDated, medianGapDays, minGapDays, daysSince,
      paymentType: r.payment_type, payMode, phoneKey: r.phone_key,
      segment, state: stateOf(daysSince, segment), longLapsed: daysSince >= LONG_LAPSED_DAYS,
      forcedRegular: r.forced_regular, forceNote: r.force_note,
      qualified: qualifiesAsRepeat({ payments, minGapDays, payMode, forcedRegular: r.forced_regular }),
    });
  }
  return map;
}

/**
 * Факти для клієнта, якого у мапі немає взагалі (жодної оплаченої угоди).
 *
 * 🔴 НЕ ВИГАДУЄМО ЙОМУ СЕГМЕНТ. `unknown` — «частоту рахувати нема з чого» — це
 * відповідь, а не порожнє місце. `qualified: false`: без жодної оплати постійним
 * не стають, і мовчазне «так» тут пустило б на екран кого завгодно.
 */
export function factsFor(map: Map<string, ClientSegmentRow>, clientKey: string): ClientSegmentRow {
  return map.get(clientKey) ?? {
    clientKey, payments: 0, paymentsDated: 0, medianGapDays: null, minGapDays: null, daysSince: 0,
    paymentType: null, payMode: "cashless", phoneKey: /^[0-9]+$/.test(clientKey),
    segment: segmentOf(null, 0), state: stateOf(0), longLapsed: false, qualified: false,
    forcedRegular: false, forceNote: null,
  };
}
