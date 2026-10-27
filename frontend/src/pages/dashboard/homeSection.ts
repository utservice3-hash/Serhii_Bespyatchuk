/**
 * 🏠 СТАРТОВА ВКЛАДКА ЗА РОЛЛЮ (12.10.2026, #1623). Без імпортів — гейт виконує цей файл напряму.
 *
 * Корінь «/» роками означав «Звіт» для ВСІХ. Але «Звіт» закритий для Кандидата, HR, Бухгалтерії й
 * Бізнес-асистента: людина відкривала посилання на дашборд і бачила вкладку, до якої не має доступу
 * (Іван 12.10: «автоматично відкриває оту погану лінку»). Тепер:
 *  • своя «домашня» вкладка ролі, якщо роль її має: Кандидат → «Навчання», HR → «Найм»;
 *  • інакше «Звіт», якщо він ролі дозволений (усі продажні й керівні ролі — як і було);
 *  • інакше перша дозволена вкладка в порядку меню.
 * Старий токен без переліку вкладок — «Звіт», як і раніше (сервер однаково гейтить незалежно).
 */
export const ROLE_HOME: Readonly<Record<string, string>> = { candidate: "training", hr: "hiring" };

export function homeSection(p: { roleKey?: string; screens?: string[]; navKeys: readonly string[] }): string {
  const screens = p.screens;
  if (!screens) return "report";
  const own = p.roleKey ? ROLE_HOME[p.roleKey] : undefined;
  if (own && screens.includes(own) && p.navKeys.includes(own)) return own;
  if (screens.includes("report")) return "report";
  // 🏢 «Орг структура» стоїть першою в меню й є в КОЖНОЇ ролі (задача 7062) — стартовою вона не стає, інакше бухгалтерія
  // й бізнес-асистент без «Звіту» відкривали б схему замість своєї роботи. Лише якщо більше нічого немає (#2706).
  return p.navKeys.find((k) => k !== "org" && screens.includes(k)) ?? (screens.includes("org") ? "org" : "report");
}
