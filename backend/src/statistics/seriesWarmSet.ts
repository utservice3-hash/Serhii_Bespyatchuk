/**
 * 🔥 СТАНДАРТНИЙ НАБІР «СТАТИСТИК» ДЛЯ ФОНОВОГО РОЗРАХУНКУ — ЧИСТИЙ МОДУЛЬ БЕЗ ІМПОРТІВ (21.11.2026).
 *
 * Набір = рівно те, що екран питає БЕЗ участі людини: кожен показник стіни × крок картки (місяць, тиждень) × два
 * періоди — картки (13 місяців / 13 тижнів, `cardFrom`) і розгорнутого графіка (уся глибина CRM). Розріз — компанія:
 * це головна серія адміна на картці й лінія, яку графік малює першою. Команди, менеджери, крок «день» і власні
 * періоди рахуються на вимогу й далі живуть у тій самій памʼяті (`seriesCache.ts`).
 *
 * 🔴 ПЕРЕЛІК ПОКАЗНИКІВ — ДЗЕРКАЛО МЕНЮ ЕКРАНА (`CATS` у `StatisticsChartsSection.tsx`), і `cardFrom` — дзеркало
 * однойменної функції фронту (`statsCards.ts`). Розійдуться — фон грітиме не те, що питає екран, і стіна знову
 * відкриватиметься холодною, хоча памʼять «повна». Обидва дзеркала тримає `#10421` (виконанням, а не читанням).
 */
export type WarmGran = "week" | "month";

/** Період за замовчуванням, коли екран не шле `from`/`to` (розгорнутий графік). Нижню межу далі клампить `STATS_CRM_FROM`. */
export const SERIES_DEFAULT_FROM = "2024-07-01";
/**
 * Верхня межа за замовчуванням — кінець ПОТОЧНОГО року за Києвом. Тут стояла константа «2026-12-31»: з 01.01.2027
 * графіки мовчки обривались би на грудні. У 2026-му значення те саме, тож числа не рухаються.
 */
export const seriesDefaultTo = (today: string): string => `${today.slice(0, 4)}-12-31`;

export interface WallMetric { block: string; metric: string; monthOnly?: true }
export const WALL_METRICS: readonly WallMetric[] = [
  // 💰 Продажі
  { block: "sales", metric: "payment_received" }, { block: "sales", metric: "revenue_success" }, { block: "sales", metric: "avg_check" },
  { block: "sales", metric: "cars_success" }, { block: "sales", metric: "cars_delivered" }, { block: "sales", metric: "calls" },
  { block: "sales", metric: "lead_take_median" }, { block: "sales", metric: "lead_take_m5_pct" },
  // 📣 Реклама
  { block: "marketing", metric: "ad_leads" }, { block: "marketing", metric: "ad_received_sum" },
  { block: "marketing", metric: "ad_received_deals" }, { block: "marketing", metric: "ad_received_avg" },
  // 🎯 Лідогенерація
  { block: "marketing", metric: "lg_transfers" }, { block: "marketing", metric: "lg_earned_sum", monthOnly: true },
  { block: "marketing", metric: "lg_earned_deals", monthOnly: true }, { block: "marketing", metric: "lg_machines", monthOnly: true },
  // 🏛 Тендери і LinkedIn
  { block: "sales", metric: "prozorro_deals" }, { block: "sales", metric: "linkedin_deals" },
  // 🚚 Логістика
  { block: "logistics", metric: "cars_delivered_all" }, { block: "logistics", metric: "new_clients_cars" },
  { block: "logistics", metric: "repeat_clients_active" }, { block: "logistics", metric: "repeat_clients_cars" },
  { block: "logistics", metric: "repeat_clients_sum" }, { block: "logistics", metric: "repeat_avg_check" },
  // 💵 Фінанси
  { block: "finance", metric: "fin_bank_in" }, { block: "finance", metric: "fin_bank_out" },
  { block: "finance", metric: "fin_receivables" }, { block: "finance", metric: "fin_delivered_income" },
  // 🧑‍💼 HR
  { block: "hr", metric: "hr_headcount", monthOnly: true }, { block: "hr", metric: "hr_hired", monthOnly: true },
  { block: "hr", metric: "hr_fired", monthOnly: true }, { block: "hr", metric: "hr_turnover_total", monthOnly: true },
  // 📵 Пропущені дзвінки (26.11.2026) — один спільний виклик ядра на крок і період гріє всі чотири
  { block: "missed", metric: "missed_count" }, { block: "missed", metric: "missed_nocb_pct" },
  { block: "missed", metric: "missed_cb_median" }, { block: "missed", metric: "missed_self_pct" },
];

/** Звідки починається ряд картки: 13 місяців / 13 тижнів — ТА САМА арифметика, що `cardFrom` фронту. */
export function cardFrom(today: string, g: WarmGran): string {
  const d = new Date(`${today}T00:00:00Z`);
  if (g === "month") { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 13); } else d.setUTCDate(d.getUTCDate() - 7 * 13);
  return d.toISOString().slice(0, 10);
}

export interface WarmTask { block: string; metric: string; g: WarmGran; from: string; to: string }

/** Усі запити стандартного набору на сьогодні. Показник «лише помісячно» тижневого ряду не має — як на екрані (`effGranOf`). */
export function warmTasks(today: string): WarmTask[] {
  const to = seriesDefaultTo(today), out: WarmTask[] = [];
  for (const m of WALL_METRICS)
    for (const g of (m.monthOnly ? ["month"] : ["month", "week"]) as WarmGran[]) {
      out.push({ block: m.block, metric: m.metric, g, from: cardFrom(today, g), to });
      out.push({ block: m.block, metric: m.metric, g, from: SERIES_DEFAULT_FROM, to });
    }
  return out;
}
