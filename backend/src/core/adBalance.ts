/**
 * 💳 БАЛАНС РЕКЛАМНОГО КАБІНЕТУ GOOGLE ADS (задача «Відображати баланс рекламного кабінету в дашборді (тільки адміни)»,
 * Роман 30.10.2026).
 *
 * 🔴 ЧОМУ РАХУЄМО, А НЕ БЕРЕМО З КАБІНЕТУ. Кабінет передоплачений (поповнюємо переказом на ТОВ «ГУГЛ»); для таких
 * Google не віддає залишок ні через API, ні через скрипти — лише в інтерфейсі «Платежі». Рішення керівництва 30.10:
 * «сума оплати − ПДВ − факт використання = залишковий баланс».
 *
 * Формула — у гривнях «як у кабінеті», тобто З ПДВ (кабінет і списує витрати з ПДВ: жовтень 125 794 у кабінеті проти
 * 103 849 у GA4 = ×1,2):
 *     залишок = точка звірки + Σ поповнень (з «Виписки») − 1,2 × Σ витрат GA4 (без ПДВ)
 *     без ПДВ = залишок ÷ 1,2
 * ⚠️ ПДВ знімається ДІЛЕННЯМ на 1,2, а не «−20%»: на історії «−20%» дає неможливий мінусовий залишок (−4 623),
 * ділення — правдоподібний (+24 544 без ПДВ ≈ 29 453 з ПДВ).
 *
 * 📐 Звірено 30.10.2026 11:30: розрахунок від нуля з 01.06 (перша оплата Google у «Виписці») — 29 452; кабінет —
 * 29 205,81. Розбіжність 0,8% (витрати сьогоднішнього дня GA4 віддає із запізненням). Точку звірки адмін може
 * оновити числом із кабінету — тоді рахуємо від неї.
 *
 * Чистий модуль: SQL віддає сирі рядки, тут — лише формула. Тримає гейт `#7140`.
 */

/** ПДВ, що сидить усередині оплат і витрат кабінету. */
export const AD_VAT = 1.2;
/** Скільки повних днів беремо для середньої витрати (без сьогоднішнього — він ще не повний). */
export const AD_AVG_DAYS = 7;
/** Поріг «закінчуються кошти» — днів до нуля. */
export const AD_LOW_DAYS = 5;

export interface AdAnchor { asOf: string; balance: number }            // залишок з ПДВ на ПОЧАТОК дня asOf (Київ)
export interface AdPayment { day: string; amount: number }              // поповнення з ПДВ, як у «Виписці»
export interface AdCost { day: string; cost: number }                   // витрата дня без ПДВ (GA4)

export interface AdBalance {
  balance: number;          // з ПДВ — як у кабінеті
  balanceNet: number;       // без ПДВ
  avgDaily: number | null;  // середня витрата на день з ПДВ за AD_AVG_DAYS повних днів
  daysLeft: number | null;
  low: boolean;
  lastPayment: AdPayment | null;
  anchor: AdAnchor;
  paidSince: number;        // Σ поповнень від точки звірки, з ПДВ
  spentSince: number;       // Σ витрат від точки звірки, з ПДВ
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** `today` — київська дата «YYYY-MM-DD», параметром, щоб гейт не залежав від календаря. */
export function computeAdBalance(anchor: AdAnchor, payments: AdPayment[], costs: AdCost[], today: string): AdBalance {
  const paidSince = payments.filter((p) => p.day >= anchor.asOf).reduce((s, p) => s + Math.abs(p.amount), 0);
  const spentSince = costs.filter((c) => c.day >= anchor.asOf).reduce((s, c) => s + c.cost, 0) * AD_VAT;
  const balance = anchor.balance + paidSince - spentSince;

  const full = costs.filter((c) => c.day < today).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, AD_AVG_DAYS);
  const avgDaily = full.length ? (full.reduce((s, c) => s + c.cost, 0) / full.length) * AD_VAT : null;
  const daysLeft = avgDaily && avgDaily > 0 ? Math.max(0, balance) / avgDaily : null;
  const lastPayment = [...payments].sort((a, b) => (a.day < b.day ? 1 : -1))[0] ?? null;

  return {
    balance: r2(balance), balanceNet: r2(balance / AD_VAT), avgDaily: avgDaily == null ? null : r2(avgDaily),
    daysLeft: daysLeft == null ? null : Math.round(daysLeft * 10) / 10,
    low: balance <= 0 || (daysLeft != null && daysLeft < AD_LOW_DAYS),
    lastPayment: lastPayment ? { day: lastPayment.day, amount: Math.abs(lastPayment.amount) } : null,
    anchor, paidSince: r2(paidSince), spentSince: r2(spentSince),
  };
}

/** Остання точка звірки. */
export const AD_ANCHOR_SQL = `
  SELECT to_char(as_of, 'YYYY-MM-DD') AS as_of, balance AS balance
    FROM ad_balance_anchor ORDER BY created_at DESC, id DESC LIMIT 1`;

/** Поповнення кабінету: вихідні платежі на ТОВ «ГУГЛ» (кирилицею — так пише банк). Дрібні «Google» — інші сервіси. */
export const AD_PAYMENTS_SQL = `
  SELECT to_char((t.booked_at AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS day, abs(t.amount_uah) AS amount
    FROM bank_transactions AS t
   WHERE t.direction = 'out' AND t.deleted_at IS NULL AND t.counterparty_name ILIKE '%гугл%'
     AND (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date >= $1::date`;

/** Витрати по днях із GA4 (без ПДВ) — від точки звірки, але не менше ніж за AD_AVG_DAYS + 1 день для середньої. */
export const AD_COSTS_SQL = `
  SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(cost) AS cost
    FROM ad_ga4_daily
   WHERE day >= LEAST($1::date, (now() AT TIME ZONE 'Europe/Kyiv')::date - ${AD_AVG_DAYS + 1})
   GROUP BY day`;

/** Коли GA4 востаннє синхронізувався — «станом на». */
export const AD_SYNCED_SQL = `SELECT max(synced_at) AS synced_at FROM ad_ga4_daily`;

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export async function loadAdBalance(db: Q, today: string): Promise<{ balance: AdBalance; syncedAt: string | null } | null> {
  const a = (await db.query(AD_ANCHOR_SQL)).rows[0];
  if (!a) return null;
  const anchor: AdAnchor = { asOf: String(a.as_of), balance: Number(a.balance) };
  const [p, c, s] = await Promise.all([
    db.query(AD_PAYMENTS_SQL, [anchor.asOf]), db.query(AD_COSTS_SQL, [anchor.asOf]), db.query(AD_SYNCED_SQL),
  ]);
  const b = computeAdBalance(
    anchor,
    p.rows.map((r) => ({ day: String(r.day), amount: Number(r.amount) })),
    c.rows.map((r) => ({ day: String(r.day), cost: Number(r.cost) })),
    today,
  );
  const synced = s.rows[0]?.synced_at;
  return { balance: b, syncedAt: synced ? new Date(synced as string).toISOString() : null };
}

/**
 * Звірка з кабінетом: адмін вписує поточний залишок. Кабінет уже списав сьогоднішні витрати, а ми рахуємо від
 * ПОЧАТКУ дня, тож повертаємо в точку звірки те, що GA4 встиг показати за сьогодні (з ПДВ). GA4 запізнюється на
 * кілька годин — ця частина дня і є залишкова неточність звірки.
 */
export function anchorFromCabinet(cabinetBalance: number, todayCostNet: number, today: string): AdAnchor {
  return { asOf: today, balance: r2(cabinetBalance + todayCostNet * AD_VAT) };
}
