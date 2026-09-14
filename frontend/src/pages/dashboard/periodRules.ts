/**
 * 📅 ПЕРІОД ЕКРАНА — ОДНЕ ПРАВИЛО НА ВСІ ЕКРАНИ, ЩО ЙОГО МАЮТЬ.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ МОДУЛЬ, А НЕ КОПІЯ В КОЖНОМУ ЕКРАНІ. До 09.09.2026 ці функції були
 * ЛОКАЛЬНИМИ константами `ReportPlanSection.tsx` і нікуди не експортувались. Щойно
 * другий екран («Реклама») попросив «такий самий вибір періоду, як у Звіті», вибір був
 * між копією й переїздом. Копія тут — це не дублювання коду, а дублювання ПРАВИЛА:
 * «тиждень рахується від фокус-дня, а місяць від якоря» жило б у двох місцях, і через
 * місяць вони збігалися б одне з одним, а не з правилом (той самий клас, що чип
 * «новий/постійний», який розходився з лічильником на 12.6% угод).
 *
 * ⚠️ ТІЛА ФУНКЦІЙ ПЕРЕЇХАЛИ БАЙТ-У-БАЙТ. Це навмисно: переїзд, який «заодно трохи
 * покращує», неможливо прийняти — незрозуміло, чи змінилось число через переїзд, чи
 * через покращення. Звіт після цього переїзду мусить показувати ТІ САМІ дати.
 */

// ── дати (Пн–Нд, локально) ──
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(s + "T00:00:00Z");
export const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
/** День тижня Пн=1..Нд=7. Експортується: Звіт фарбує ним вихідні у смузі днів. */
export const dow = (s: string) => { const w = parse(s).getUTCDay(); return w === 0 ? 7 : w; };
export const mondayOf = (s: string) => addDays(s, -(dow(s) - 1));
export const sundayOf = (s: string) => addDays(mondayOf(s), 6);
/** Довжина діапазону в днях ВКЛЮЧНО (11–13 = 3). Крок навігації ←/→ у режимі «Період». */
export const spanDays = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000) + 1;
export const monthStart = (s: string) => s.slice(0, 7) + "-01";
export const monthEnd = (s: string) => { const [y, m] = s.split("-").map(Number); return iso(new Date(Date.UTC(y, m, 0))); };
export const addMonth = (s: string, n: number) => { const [y, m] = s.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return iso(d); };
export const todayKyiv = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
export const ddmm = (s: string) => s.slice(8) + "." + s.slice(5, 7);
export const monLbl = (s: string) => { const M = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"]; return M[Number(s.slice(5, 7)) - 1] + " " + s.slice(0, 4); };

export type PeriodMode = "day" | "week" | "month" | "range";

/**
 * Стан навігатора. Два якорі, і вони РІЗНІ навмисно:
 *   `anchor`   — місяць (і те, куди веде ←/→ у режимі місяця);
 *   `focusDay` — активний день, від нього рахується тиждень.
 * Злиття їх в один зламало б Звіт: там тижнева смуга лишається на своєму тижні,
 * навіть коли обраний період — місяць (рішення власника).
 */
export interface PeriodState {
  mode: PeriodMode;
  anchor: string;
  focusDay: string;
  rangeFrom: string;
  rangeTo: string;
}

/**
 * 🔴 ОБРАНИЙ ПЕРІОД — ОДНЕ ПОНЯТТЯ НА ВЕСЬ ЕКРАН (18.08.2026).
 *
 * Було: цей вираз звався `drillPeriod` і доходив РІВНО до розгортки по днях, а тіло
 * Звіту читало `monthData` завжди. Тобто перемикач «Тиждень/Період» не змінював ані
 * ростер, ані glance, ані гроші — людина бачила місяць під підписом тижня.
 */
export function periodOf(s: PeriodState): { from: string; to: string } {
  if (s.mode === "day") return { from: s.focusDay, to: s.focusDay };
  if (s.mode === "week") return { from: mondayOf(s.focusDay), to: sundayOf(s.focusDay) };
  if (s.mode === "range") return { from: s.rangeFrom, to: s.rangeTo };
  return { from: monthStart(s.anchor), to: monthEnd(s.anchor) };
}

/** Підпис періоду — «вер 2026», «09.09» або «01.09–09.09». */
export function periodLabelOf(s: PeriodState): string {
  const p = periodOf(s);
  if (s.mode === "month") return monLbl(s.anchor);
  if (s.mode === "day") return ddmm(p.from);
  return `${ddmm(p.from)}–${ddmm(p.to)}`;
}

/**
 * Крок ←/→ за одиницею режиму. Повертає ПАТЧ стану, а не новий стан цілком:
 * так видно, що навігація не чіпає `mode`, і жоден екран не може випадково його зсунути.
 *
 * 🔴 ДІАПАЗОН ЗСУВАЄТЬСЯ НА ВЛАСНУ ДОВЖИНУ (18.08.2026). Гілка була порожня, а кнопки
 * вимкнені — тобто «минулі 3 дні» подивитись було НЕМОЖЛИВО, доводилось клацати обидві
 * дати в календарі. Крок = довжина діапазону включно, тож ← дає рівно попередній
 * такий самий відрізок без дірки й без перекриття.
 *
 * `null` = не рухаємось (діапазон не заданий або зіпсований).
 */
export function navBy(s: PeriodState, dir: number): Partial<PeriodState> | null {
  if (s.mode === "month") return { anchor: addMonth(s.anchor, dir) };
  if (s.mode === "range") {
    const span = spanDays(s.rangeFrom, s.rangeTo);
    if (span <= 0) return null;
    return { rangeFrom: addDays(s.rangeFrom, dir * span), rangeTo: addDays(s.rangeTo, dir * span) };
  }
  const step = s.mode === "day" ? dir : dir * 7;
  const nd = addDays(s.focusDay, step);
  return { focusDay: nd, anchor: nd };
}
