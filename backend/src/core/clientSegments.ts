import { pool } from "../db/pool.js";
import { GENERIC_CLIENT_KEYS } from "./metrics.js";
import {
  segmentOf, stateOf, ARCHIVE_DAYS,
  type ClientSegment, type ClientState,
} from "./reactivationRules.js";

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
 * фрагмент вимагає `closed_at_kommo IS NOT NULL`. Клієнт із 2+ оплатами, у яких
 * дата закриття не проставлена, випадав з ОБОХ екранів МОВЧКИ — рівно те, від чого
 * фрагмент і мав захистити. На проді такий один (`0674673308`, 3 оплати, 0 дат).
 * Тепер факти віддаються мапою, а `factsFor` дає таким клієнтам той самий стан,
 * що вони мали до появи сегментів: `unknown` / `active`. Тримає гейт `#30n`.
 *
 * 🔴 ПРАВИЛО ЖИВЕ В ЧИСТИХ ФУНКЦІЯХ (`segmentOf`/`stateOf`), а SQL віддає лише
 * ФАКТИ (скільки оплат, медіанний інтервал, скільки днів мовчить). Раніше та сама
 * умова стояла двічі — `CASE` у SQL і функція в TS — і їх доводилось звіряти
 * тестом. Одна реалізація не може розійтись сама з собою.
 */

/** Сирі факти по клієнту — те, що вміє порахувати лише БД. */
export interface ClientSegmentFacts {
  clientKey: string;
  payments: number;
  medianGapDays: number | null;
  daysSince: number;
  paymentType: string | null;
  phoneKey: boolean;
}

/** Факти + похідні від них сегмент/стан (похідні рахують чисті функції). */
export interface ClientSegmentRow extends ClientSegmentFacts {
  segment: ClientSegment;
  state: ClientState;
  archived: boolean;
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
  )
  SELECT p.client_key,
         COUNT(*)::int AS payments,
         m.median_gap,
         (CURRENT_DATE - (MAX(p.closed_at_kommo) AT TIME ZONE 'Europe/Kyiv')::date)::int AS days_since,
         MODE() WITHIN GROUP (ORDER BY p.payment_type) AS payment_type,
         (p.client_key ~ '^[0-9]+$') AS phone_key
    FROM seg_paid p LEFT JOIN seg_med m ON m.client_key = p.client_key
   GROUP BY p.client_key, m.median_gap`;

/** Мапа `client_key → сегмент/стан`. Один запит на прохід екрана. */
export async function loadClientSegments(): Promise<Map<string, ClientSegmentRow>> {
  const rows = (await pool.query<{
    client_key: string; payments: number; median_gap: string | null;
    days_since: number; payment_type: string | null; phone_key: boolean;
  }>(SEGMENT_FACTS_SQL, [GENERIC_CLIENT_KEYS])).rows;

  const map = new Map<string, ClientSegmentRow>();
  for (const r of rows) {
    const medianGapDays = r.median_gap == null ? null : Math.round(Number(r.median_gap) * 10) / 10;
    const payments = Number(r.payments);
    const daysSince = Number(r.days_since);
    const segment = segmentOf(medianGapDays, payments);
    map.set(r.client_key, {
      clientKey: r.client_key, payments, medianGapDays, daysSince,
      paymentType: r.payment_type, phoneKey: r.phone_key,
      segment, state: stateOf(daysSince, segment), archived: daysSince >= ARCHIVE_DAYS,
    });
  }
  return map;
}

/**
 * Факти для клієнта, якого у мапі немає (жодної оплати з проставленою датою).
 *
 * 🔴 НЕ ВИГАДУЄМО ЙОМУ СЕГМЕНТ І НЕ ХОВАЄМО ЙОГО. Сегмент — `unknown`
 * («частоту рахувати нема з чого» — це відповідь, а не порожнє місце), стан —
 * той самий `active`, що екран показував до появи сегментів. Викинути його
 * означало б мовчки втратити клієнта; призначити «сплячий» означало б збрехати
 * про дату, якої в CRM немає.
 */
export function factsFor(map: Map<string, ClientSegmentRow>, clientKey: string): ClientSegmentRow {
  return map.get(clientKey) ?? {
    clientKey, payments: 0, medianGapDays: null, daysSince: 0,
    paymentType: null, phoneKey: /^[0-9]+$/.test(clientKey),
    segment: segmentOf(null, 0), state: stateOf(0), archived: false,
  };
}

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
 * (Повторний замір 05.08.2026 на списку реактивації: 1 137 → 842, тобто 295.)
 */
export function keepInReactivation(f: ClientSegmentRow): boolean {
  return !f.phoneKey || (f.paymentType ?? "").toLowerCase().includes("езнал");
}
