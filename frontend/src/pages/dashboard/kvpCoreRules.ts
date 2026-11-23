/**
 * 🏆 ЗВІТ КВП — ЯДРО (задача 5605, ТЗ Юлі 12.10.2026; з 21.10.2026 — задача 6442, «на екрані одна таблиця команд»): чисті
 * правила таблиці «Команди — план / факт». Без React — гейт бекенду виконує цей модуль. Числа беруться з ТОГО САМОГО
 * `/kvp-report`, що й решта екрана: тиждень — `weeks[].plan/fact/expected` (очікування = оплати з ПЛАНОВОЮ датою в цьому
 * тижні, `expectedByManagerDay`), місяць — `plan / revenue / expectedThisMonth`. Своїх формул грошей тут немає.
 */

export type CloseKind = "closed" | "real" | "risk" | "no" | "none";
export interface CloseStatus {
  kind: CloseKind;
  /** Частка очікуваного, що має прийти, щоб закрити план тижня (0..1); `null` — коли рахувати нема з чого. */
  share: number | null;
  /** Скільки бракує навіть з усім очікуваним (₴); 0 — коли вистачає. */
  short: number;
}

export const CLOSE_LABEL: Record<CloseKind, string> = {
  closed: "Закрито", real: "Реально", risk: "Під ризиком", no: "Не закриється", none: "—",
};

/** Пороги з ТЗ, розділ 3: «реально» — до 50% очікуваного, «під ризиком» — 50–85%, понад 85% — «не закриється». */
export const CLOSE_REAL_MAX = 0.5;
export const CLOSE_RISK_MAX = 0.85;

/**
 * Статус «Закриємо?» по тижню (ТЗ, розділ 3). Треба = план − факт; дивимось, яку частку очікуваних оплат тижня це
 * становить. Плану немає — статусу немає («—»), а не «закрито»: нуль плану не означає виконання.
 */
export function weekCloseStatus(plan: number, fact: number, expected: number): CloseStatus {
  if (!(plan > 0)) return { kind: "none", share: null, short: 0 };
  if (fact >= plan) return { kind: "closed", share: 0, short: 0 };
  const need = plan - fact;
  const exp = Math.max(0, expected);
  if (exp <= 0 || need > exp) return { kind: "no", share: exp > 0 ? need / exp : null, short: need - exp };
  const share = need / exp;
  return { kind: share <= CLOSE_REAL_MAX ? "real" : share <= CLOSE_RISK_MAX ? "risk" : "no", share, short: 0 };
}

/**
 * ✂️ Значення міток «Закриємо?» — ОДНИМ реченням для підказки (i) заголовка таблиці команд (задача 10753, 23.11.2026).
 * Доти це була окрема легенда під таблицею; її прибрали з ручного списку правок Романа, а пояснення переїхало сюди,
 * щоб не загубитись. Пороги беруться з тих самих констант, що й `weekCloseStatus`, тож підказка не розійдеться з правилом.
 */
export function closeLegendText(): string {
  const real = Math.round(CLOSE_REAL_MAX * 100), risk = Math.round(CLOSE_RISK_MAX * 100);
  return `Мітка «Закриємо?» поточного тижня: «${CLOSE_LABEL.closed}» — факт уже не менший за план тижня; `
    + `«${CLOSE_LABEL.real}» — вистачить до ${String(real)}% очікуваних оплат; `
    + `«${CLOSE_LABEL.risk}» — має прийти ${String(real)}–${String(risk)}% очікуваного; `
    + `«${CLOSE_LABEL.no}» — треба понад ${String(risk)}% або навіть усього очікуваного не вистачає.`;
}

/** Другий рядок під статусом — словами, як у макеті. */
export function closeNote(s: CloseStatus, fmt: (v: number) => string): string | null {
  if (s.kind === "none" || s.kind === "closed") return null;
  if (s.short > 0) return `бракує ${fmt(s.short)} навіть з оплатами`;
  return s.share == null ? null : `має прийти ${String(Math.round(s.share * 100))}% очікуваного`;
}

export const pctOfPlan = (v: number, plan: number): number | null => (plan > 0 ? Math.round((v / plan) * 100) : null);

/**
 * «Факт + очікування» (задача 6442, Юля 21.10.2026): факт плюс оплати з ПЛАНОВОЮ датою в тому самому періоді — і % плану.
 * Одне правило на місяць (`revenue + expectedThisMonth`) і на поточний тиждень (`fact + expected`), для команди, менеджера
 * й Σ відділу. Плану немає — відсотка немає («—»), а не 0% і не ∞.
 */
export function withExpected(plan: number, fact: number, expected: number): { sum: number; pct: number | null } {
  const sum = fact + expected;
  return { sum, pct: pctOfPlan(sum, plan) };
}

// 🎧 Сортування й фільтр таблиці менеджерів «Першого дотику» (sortFtLines / tileCountsByManager, ТЗ 12.10, розділ 4)
// ПРИБРАНО разом із самою таблицею (правки зустрічі 17.11.2026): у Звіті КВП лишились лише картки, клік веде на екран AI.

// ───────────── 📅 ПЕРІОД ЗВІТУ КВП З НАВІГАТОРА «‹ назва ›» (20.11.2026) ─────────────

/** Стан навігатора — рівно поля `PeriodState` (periodRules.ts); описані тут, щоб модуль лишався без імпортів. */
export interface KvpNavLike { mode: string; anchor: string; focusDay: string; rangeFrom: string; rangeTo: string }

/**
 * Що просити в `/kvp-report` для обраного періоду. День і тиждень якоряться ФОКУС-ДНЕМ, який людина бачить у назві
 * («10–16 листопада»), а не 1-м числом місяця: саме та плутанина, через яку тиждень «серпня» колись показував липень.
 * Місяць іде пресетом (сервер тоді віддає тижні Т1–Т5 і «з очікуваннями»), довільний період — межами.
 */
export function kvpReportParams(nav: KvpNavLike): { preset?: string; date?: string; from?: string; to?: string } {
  if (nav.mode === "range") return { from: nav.rangeFrom, to: nav.rangeTo };
  if (nav.mode === "month") return { preset: "month", date: `${nav.anchor.slice(0, 7)}-01` };
  return { preset: nav.mode, date: nav.focusDay };
}
/** Місяць, план якого показує блок «Показники»: місяць, у якому починається обраний період. */
export const kvpPlanMonth = (nav: KvpNavLike): string =>
  (nav.mode === "range" ? nav.rangeFrom : nav.mode === "month" ? nav.anchor : nav.focusDay).slice(0, 7);
