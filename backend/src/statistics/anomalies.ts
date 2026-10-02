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
export type AnomalyKind = "real" | "data_error" | "corrected";
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
  /* 19–25.01.2026: точки ЗАМІНЕНО числами CRM (рішення Романа 02.10: «заміни на CRM») — див. CORRECTIONS нижче.
     Позначка лишається: людина має бачити, що на графіку не те, що було в ручній таблиці. */
  ...(["13", "company"] as const).flatMap((scopeKey) => (["avg_check", "cars_success", "revenue_success"] as const).map((metric): Anomaly => ({
    metric, granularity: "week", scopeKey, period: "2026-01-19", kind: "corrected",
    note: "Виправлено числом CRM: у ручній таблиці за цей тиждень у РНК Безпам'ятного було 2 авто замість 20 (звідси чек 13 255 ₴)",
    crm: scopeKey === "13" ? "CRM: 20 угод / 26 010 ₴ → чек 1 300 ₴; у таблиці було 2 авто / 26 510 ₴ / 13 255 ₴"
      : "Компанія перерахована з виправленою командою: 62 авто / 167 707 ₴ → чек 2 705 ₴; у таблиці було 44 авто / 168 207 ₴ / 3 823 ₴",
  }))),
];

export function anomaliesFor(metric: string, granularity: string): Anomaly[] {
  return ANOMALIES.filter((a) => a.metric === metric && a.granularity === granularity);
}

/**
 * ✏️ ВИПРАВЛЕННЯ ТОЧОК ІСТОРІЇ РУЧНОЇ ТАБЛИЦІ ЧИСЛАМИ CRM (рішення Романа 02.10.2026: «заміни на CRM»).
 *
 * Накладається ПРИ ЧИТАННІ серії (`routes/statisticsSeries.ts`, лише на точки з таблиці), у базі нічого не
 * переписується — тож виправлення видно в коді з причиною й доказом, і прибирається видаленням рядка.
 * Компанія для продажів у таблиці — Σ команд (чек = Σвиручка ÷ Σавто), тому виправлення команди тягне й компанію:
 * авто 44 + 18 = 62, виручка 168 207 − 500 = 167 707, чек 167 707 ÷ 62 ≈ 2 705.
 * Місячні точки січня НЕ чіпаємо: там у таблиці 58 авто / 1 862 ₴ у РНК Безпам'ятного — помилки тижня немає.
 */
export interface Correction { metric: string; granularity: "week" | "month"; scopeKey: string; period: string; was: number; value: number }
export const CORRECTIONS: Correction[] = [
  { metric: "cars_success", granularity: "week", scopeKey: "13", period: "2026-01-19", was: 2, value: 20 },
  { metric: "revenue_success", granularity: "week", scopeKey: "13", period: "2026-01-19", was: 26510, value: 26010 },
  { metric: "avg_check", granularity: "week", scopeKey: "13", period: "2026-01-19", was: 13255, value: 26010 / 20 },
  { metric: "cars_success", granularity: "week", scopeKey: "company", period: "2026-01-19", was: 44, value: 62 },
  { metric: "revenue_success", granularity: "week", scopeKey: "company", period: "2026-01-19", was: 168207, value: 167707 },
  { metric: "avg_check", granularity: "week", scopeKey: "company", period: "2026-01-19", was: 168207 / 44, value: 167707 / 62 },
];

/** Точки таблиці з виправленнями CRM. Чисте: лише значення, джерело точки лишається «sheet». */
export function applyCorrections<T extends { period: string; value: number }>(metric: string, granularity: string, scopeKey: string, points: T[]): T[] {
  const fix = CORRECTIONS.filter((c) => c.metric === metric && c.granularity === granularity && c.scopeKey === scopeKey);
  if (!fix.length) return points;
  return points.map((p) => { const c = fix.find((x) => x.period === p.period); return c ? { ...p, value: c.value } : p; });
}
