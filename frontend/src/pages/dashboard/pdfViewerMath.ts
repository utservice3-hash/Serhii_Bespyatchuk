/**
 * 📄 ПЕРЕГЛЯДАЧ PDF ЯК У SEREDA — ЧИСТА МАТЕМАТИКА (24.09.2026, рішення Романа: «точна копія середи,
 * прям такий самий перегляд пдф»).
 *
 * Числа тут — НЕ смак, а ЗАМІР живого переглядача Sereda (урок «Welcome to UTS», 17 сторінок,
 * 24.09.2026): «+» дає 100 → 125 → 156 → 195 → 244 → 300%, «−» від 300 дає 240 → 192 → 154 → 123 →
 * 98 → 78 → 62 → 50%. На 300% гасне «+», на 50% гасне «−».
 *
 * 🔴 ПРАВИЛО ПІДІБРАНО ПІД ОБИДВА РЯДИ, а не під один. Просте «×1.25 / ÷1.25» дає вниз 79 і 63 замість
 * 78 і 62 — Sereda округлює масштаб ДО СОТИХ після кожного кроку (0.984 → 0.98 → 0.784 → 0.78), і
 * похибка накопичується саме так. Далі — обрізання межами. Це правило відтворює ОБИДВА заміряні ряди
 * до цифри; `#722` тримає саме їх, а не формулу.
 *
 * 🔴 БЕЗ ІМПОРТІВ, свідомо: гейти `#722`/`#722b` транспілюють і ВИКОНУЮТЬ цей файл, а не читають його.
 */

export const ZOOM_STEP = 1.25;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** До сотих — як Sereda: 1.5625 → 1.56, 0.984 → 0.98. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

export const canZoomIn = (z: number): boolean => z < ZOOM_MAX;
export const canZoomOut = (z: number): boolean => z > ZOOM_MIN;

export const zoomIn = (z: number): number => (canZoomIn(z) ? Math.min(ZOOM_MAX, round2(z * ZOOM_STEP)) : z);
export const zoomOut = (z: number): number => (canZoomOut(z) ? Math.max(ZOOM_MIN, round2(z / ZOOM_STEP)) : z);

/** Як масштаб написано на панелі: ціле число відсотків, як у Sereda («156%», а не «156.25%»). */
export const zoomLabel = (z: number): string => `${Math.round(z * 100)}%`;

/**
 * Яка сторінка «поточна» на лічильнику `N / M`. Поточна — та, на яку припадає СЕРЕДИНА вікна:
 * так лічильник перемикається, коли нова сторінка зайняла більшу частину екрана, а не щойно
 * з'явився її край (саме так поводиться Sereda: «2 / 17» при кінці першої сторінки вгорі вікна).
 *
 * `tops` — верхні краї сторінок у координатах вмісту вікна, за зростанням. Повертає 1..M;
 * для порожнього документа — 1, щоб панель не показувала «0 / 0» під час завантаження.
 */
export function pageAtScroll(tops: readonly number[], scrollTop: number, viewportHeight: number): number {
  if (tops.length === 0) return 1;
  const mid = scrollTop + viewportHeight / 2;
  let page = 1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= mid) page = i + 1;
    else break;
  }
  return page;
}
