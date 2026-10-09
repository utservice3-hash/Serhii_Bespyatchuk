/**
 * 🔔 ПРАВИЛА СПОВІЩЕНЬ — чистий модуль без React (стандарт «Еволюція бренду UTS», затверджено Романом 07.10.2026).
 *
 * Тут лише рішення «скільки висить», «що ховати під «Ще N»» і «що робити з однаковим ключем».
 * `Toasts.tsx` їх виконує, а гейти `#1230`–`#1232` кличуть ці функції напряму — правило існує в
 * одному місці, тож показ і перевірка не можуть розійтись.
 *
 * Чому саме так (усі шість досліджених дизайн-систем: Carbon, Atlassian, Polaris, Material 3,
 * Primer, Sonner): помилка сама не зникає (WCAG 2.2.1), тост із кнопкою теж — інакше «Відновити»
 * зникає раніше, ніж людина встигла натиснути. Подія «вам щось прийшло» зникає за 15 с (рішення
 * Романа 07.10.2026) — таймер стоїть, поки вкладка прихована чи курсор на тості, тож менеджер, що
 * відійшов від екрана, усе одно встигне її побачити.
 */

export type ToastTone = "ok" | "info" | "warn" | "err";

export interface ToastRuleItem {
  id: number;
  tone: ToastTone;
  /** Подія ззовні («чекає вашого прийняття», пропущений дзвінок), а не результат власної дії. */
  event?: boolean;
  /** Має кнопку дії («Відновити», «Відкрити»). */
  hasAction?: boolean;
  /** Триває операція («Зберігаю…»). */
  loading?: boolean;
  /** Ключ: тост із тим самим ключем ЗАМІНЮЄ попередній, а не стає поруч. */
  key?: string;
  /** Скільки разів прийшло (для злиття серії). */
  count?: number;
}

/** Успіх чи інформація без кнопки — 3 с (рішення Романа 08.10.2026, варіант А; було 5 с). */
export const TOAST_PLAIN_MS = 3000;
/** Подія «вам щось прийшло» — 8 с (рішення Романа 08.10.2026, варіант А; було 15 с). */
export const TOAST_EVENT_MS = 8000;
/**
 * Плавне зникнення: тост гасне й відʼїжджає за цей час, і лише потім іде з екрана (сусіди стуляються
 * без стрибка). Хто вимкнув анімації в системі, — тост іде одразу. Тримає `#1290b`.
 */
export const TOAST_EXIT_MS = 200;
export function exitDelay(reducedMotion: boolean): number {
  return reducedMotion ? 0 : TOAST_EXIT_MS;
}
/** Скільки тостів видно одночасно; решта — під кнопкою «Ще N». */
export const TOAST_MAX_SHOWN = 3;

/** Важливий тост — ховається під «Ще N» лише після звичайних: помилка, кнопка дії, подія, незавершена операція. */
export function isSticky(it: Pick<ToastRuleItem, "tone" | "event" | "hasAction" | "loading">): boolean {
  return it.tone === "err" || !!it.event || !!it.hasAction || !!it.loading;
}

/**
 * Скільки мс тост живе без втручання; `null` — висить до закриття.
 * Порядок має значення: помилка й незавершена операція висять завжди (навіть як подія);
 * подія — 15 с, хоч і з кнопкою; тост із кнопкою поза подією — до закриття; решта — 5 с.
 */
export function toastLifetime(it: Pick<ToastRuleItem, "tone" | "event" | "hasAction" | "loading">): number | null {
  if (it.tone === "err" || it.loading) return null;
  if (it.event) return TOAST_EVENT_MS;
  if (it.hasAction) return null;
  return TOAST_PLAIN_MS;
}

/**
 * Що видно, а що під «Ще N». Ховаємо в такому порядку: спершу найстаріші звичайні тости, потім
 * події й тости з дією, і лише в останню чергу — помилки. Інакше наплив успіхів витіснив би помилку,
 * і людина її не побачила б (ваду знайдено на прототипі 07.10.2026).
 */
export function visibleToasts<T extends ToastRuleItem>(items: T[], max = TOAST_MAX_SHOWN): { shown: T[]; hidden: number } {
  const shown = items.slice();
  let hidden = 0;
  while (shown.length > max) {
    let i = shown.findIndex((x) => !isSticky(x));
    if (i < 0) i = shown.findIndex((x) => x.tone !== "err");
    if (i < 0) i = 0;
    shown.splice(i, 1);
    hidden++;
  }
  return { shown, hidden };
}

/**
 * Додати тост. Той самий ключ ЗАМІНЮЄ наявний (і рахує повтори) замість другого поруч:
 * «Зберігаю…» стає «Збережено» на тому самому місці, а серія пропущених дзвінків — одним тостом.
 */
export function upsertToast<T extends ToastRuleItem>(items: T[], next: T): T[] {
  if (next.key) {
    const at = items.findIndex((x) => x.key === next.key);
    if (at >= 0) {
      const prev = items[at];
      const merged = { ...next, id: prev.id, count: (prev.count ?? 1) + 1 } as T;
      return items.map((x, i) => (i === at ? merged : x));
    }
  }
  return [...items, { ...next, count: next.count ?? 1 }];
}
