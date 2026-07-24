// ЄДИНЕ джерело правди для вкладки «Статистики» (діаграми): шов, CRM-able набір,
// мапінг scope та реєстр live-обчислювачів. Читають І імпорт-скрипт (skip ≥ шов),
// І роут /statistics/series (live ≥ шов) — щоб skip і live НЕ розходились.

export const STATS_SEAM = "2026-07-01"; // sheet (<) → crm (≥)

// CRM-able метрики: історія sheet діє СТРОГО до шва; з шва — тільки live з ядра.
// Решта (finance/hr/tenders/lgintl/бюджети) — sheet+manual (CRM не рахує).
export const CRM_ABLE: Record<string, Set<string>> = {
  sales: new Set(["revenue_success", "avg_check", "calls", "cars_success", "cars_delivered", "payment_received", "managers_count", "cash_deals_sum"]),
  marketing: new Set(["ad_leads", "ad_offtarget_leads", "ad_new_revenue", "ad_new_paid_cars", "ad_avg_check", "lg_transfers", "lg_new_revenue", "lg_new_clients", "lg_avg_check", "revenue_all_clients"]),
  logistics: new Set(["repeat_clients_sum", "repeat_clients_cars", "repeat_clients_active", "repeat_avg_check", "cars_delivered_all"]),
  intl: new Set(["intl_delivered_sum", "intl_delivered_cars", "intl_avg_check", "intl_new_sum", "intl_new_cars", "intl_new_avg_check", "intl_repeat_sum", "intl_repeat_cars", "intl_repeat_avg_check"]),
};
export const isCrmAble = (block: string, metric: string): boolean => CRM_ABLE[block]?.has(metric) ?? false;

// team_lead (scope_name у CSV) → {key, name}. Живі команди → team_id (текст); Шевчук —
// окрема історична серія (перетин дат із «самостійні»), тож ключ = назва (без CRM).
export const TEAM_LEAD_MAP: Record<string, { key: string; name: string }> = {
  "Яцик": { key: "5", name: "Яцик" },
  "Дмитрук": { key: "6", name: "Дмитрук" },
  "Шаврова": { key: "14", name: "Шаврова" },
  "Безпамятний": { key: "13", name: "Безпамятний" },
  "Михальчевська": { key: "15", name: "Михальчевська" },
  "самостійні": { key: "36283", name: "Самостійні" },
  "Шевчук": { key: "Шевчук", name: "Шевчук" },
};
export function scopeForTeamLead(raw: string): { key: string; name: string } {
  return TEAM_LEAD_MAP[raw] ?? { key: raw, name: raw };
}
export function scopeFor(scopeType: string, raw: string): { key: string; name: string } {
  if (scopeType === "company") return { key: "company", name: raw };
  if (scopeType === "team_lead") return scopeForTeamLead(raw);
  return { key: raw, name: raw };
}

// Живі команди, що мають CRM-продовження (team_id → показова назва). Історичні
// тімліди (Шевчук/Мельник/Федоровський/Корнийчук/Єрмоченко) сюди НЕ входять — їхні
// серії обриваються на шві.
export const LIVE_TEAMS: { id: number; name: string }[] = [
  { id: 13, name: "РНК Безпам'ятного" },
  { id: 5, name: "РПК Яцика" },
  { id: 6, name: "РПК Дмитрука" },
  { id: 36283, name: "Самостійні" },
  { id: 15, name: "РНК Михальчевської" },
  { id: 14, name: "РПК Шаврової" },
];

// Реєстр live-обчислювачів. kind → як рахувати з core-bucket-функцій. Метрики без
// запису тут CRM-продовження ПОКИ не мають (serve sheet/manual; додаємо інкрементально).
export type LiveKind = "success_rev" | "success_deals" | "success_avg" | "received_rev";
export const LIVE_METRIC: Record<string, LiveKind> = {
  revenue_success: "success_rev",   // дохід успіху (142, closed_at, signed)
  cars_success: "success_deals",    // успішні авто (COUNT угод success)
  avg_check: "success_avg",         // середній чек success-only (Σrev÷Σcars)
  payment_received: "received_rev", // оплата отримана (received = success ⊎ paidOnly)
};
export const hasLive = (block: string, metric: string): boolean => isCrmAble(block, metric) && metric in LIVE_METRIC;
