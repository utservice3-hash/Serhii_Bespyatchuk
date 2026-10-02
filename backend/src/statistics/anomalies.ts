/**
 * ⚠️ РЕЄСТР АНОМАЛІЙ НА ГРАФІКАХ СТАТИСТИК (ТЗ 28.09.2026, блок 1, п.3; задача 4603).
 *
 * ТЗ: «якщо помилка — виправити розрахунок; якщо реальна аномалія — позначити точку на графіку з
 * підказкою». Обидва відомі викиди сидять в ІСТОРІЇ з ручної таблиці (до шва 01.07.2026), тож
 * розрахунок дашборда тут не винен. Рішення Романа 02.10.2026: історію НЕ переписуємо, а позначаємо.
 *
 * 🔴 КОЖЕН ЗАПИС МАЄ ДОКАЗ ЧИСЛОМ З CRM — інакше позначка була б думкою, а не фактом. Заміряно
 * 02.10.2026 ядром грошей (`successByTeam`) за ті самі календарні тижні:
 *  · 29.12.2025–04.01.2026: CRM Яцик 290 угод, Дмитрук 147 (таблиця 292 / 145) — РЕАЛЬНА подія,
 *    масове закриття угод наприкінці року;
 *  · 19–25.01.2026, РНК Безпам'ятного: CRM 20 угод / 26 010 ₴ → чек ≈1 300 ₴, у таблиці 13 255 ₴ —
 *    ПОМИЛКА ТАБЛИЦІ (компанійний чек того тижня 3 823 ₴ теж підтягнутий нею).
 *
 * `period` — ПОНЕДІЛОК тижня (тижні з таблиці датовані неділею, і серія їх до понеділка зводить).
 * `scopeKey` — як у серії: "company" або id команди рядком.
 */
export type AnomalyKind = "real" | "data_error";
export interface Anomaly {
  metric: string;
  granularity: "week" | "month";
  scopeKey: string;
  period: string;
  kind: AnomalyKind;
  note: string;
  /** Доказ із CRM — число, а не оцінка. */
  crm: string;
}

const YEAR_END = "Масове закриття угод наприкінці року — реальна подія, підтверджено CRM";
const SHEET_ERR = "Помилка в історії ручної таблиці (до 01.07.2026): CRM за цей тиждень дає інше число";

export const ANOMALIES: Anomaly[] = [
  { metric: "cars_success", granularity: "week", scopeKey: "company", period: "2025-12-29", kind: "real", note: YEAR_END,
    crm: "CRM: 507 успішних угод за 29.12–04.01 (Яцик 290, Дмитрук 147); у таблиці 510" },
  { metric: "cars_success", granularity: "week", scopeKey: "5", period: "2025-12-29", kind: "real", note: YEAR_END,
    crm: "CRM: 290 успішних угод за 29.12–04.01; у таблиці 292" },
  { metric: "cars_success", granularity: "week", scopeKey: "6", period: "2025-12-29", kind: "real", note: YEAR_END,
    crm: "CRM: 147 успішних угод за 29.12–04.01; у таблиці 145" },
  { metric: "avg_check", granularity: "week", scopeKey: "13", period: "2026-01-19", kind: "data_error", note: SHEET_ERR,
    crm: "CRM: 20 угод / 26 010 ₴ → чек ≈1 300 ₴; у таблиці 13 255 ₴" },
  { metric: "avg_check", granularity: "week", scopeKey: "company", period: "2026-01-19", kind: "data_error", note: SHEET_ERR,
    crm: "Компанійний чек 3 823 ₴ підтягнутий помилкою РНК Безпам'ятного за той самий тиждень" },
];

export function anomaliesFor(metric: string, granularity: string): Anomaly[] {
  return ANOMALIES.filter((a) => a.metric === metric && a.granularity === granularity);
}
