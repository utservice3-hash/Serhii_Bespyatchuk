import type { Db } from "./adCallFacts.js";

/**
 * 🎛 НАЛАШТУВАННЯ «ПЕРШОГО ДОТИКУ» (05.10.2026, рішення власника після демо). Чотири параметри, які власник
 * погоджує з Сергієм і вмикає САМ у «Налаштуваннях» (лише адмін), без викату:
 *
 *   repeatWindowDays        — розмова повторна, лише якщо попередня з цим номером була не раніше ніж за N днів
 *                             (межа включно). `null` — без обмеження: виключається навіть розмова з липня;
 *   callbackGraceMin        — допуск до обіцяного часу передзвону, хв;
 *   callbackMinDeadlineMin  — мінімальний дедлайн для обіцянок у хвилинах («дві хвилини» → однаково N хв);
 *   bannerTone              — колір блоку «дзвінка в телефонії немає»: сірий, доки хибні «не передзвонив» не
 *                             розібрано, червоний — після. Заголовок НЕ змінюється (рішення власника);
 *   priceTargetPct          — ціль «ціну озвучено», % (ТЗ 08.10.2026: 50 %); плитка й смуги нижче цілі — червоні.
 *                             Необовʼязкове у вводі: старий клієнт без поля зберігає 50, а не помилку.
 *
 * 🔴 СТАРТ = ПОТОЧНА ПОВЕДІНКА (`CURRENT_BEHAVIOUR`): викат цього коду не зсуває жодної цифри. Рекомендовані
 * значення (`RECOMMENDED`) лише підказка на екрані — ставить їх людина.
 * Стан обіцянки не зберігається, а рахується на кожному показі, тож зміна допуску переводить і вже розібрані
 * розмови — і зсуває минулі тижні звіту тімліда (власника попереджено).
 * Кожна зміна — новий рядок журналу з автором; чинне — останній рядок; журналу немає — `CURRENT_BEHAVIOUR`.
 */
export type BannerTone = "neutral" | "alert";

export interface FirstTouchTunables {
  repeatWindowDays: number | null;
  callbackGraceMin: number;
  callbackMinDeadlineMin: number;
  bannerTone: BannerTone;
  priceTargetPct: number;
}

/** Ціль «ціну озвучено» за ТЗ 08.10.2026 — поки адмін не змінив. */
export const PRICE_TARGET_DEFAULT = 50;

export const CURRENT_BEHAVIOUR: Readonly<FirstTouchTunables> = Object.freeze({
  repeatWindowDays: null, callbackGraceMin: 0, callbackMinDeadlineMin: 0, bannerTone: "neutral", priceTargetPct: PRICE_TARGET_DEFAULT,
});

export const RECOMMENDED = Object.freeze({ repeatWindowDays: 30, callbackGraceMin: 10, callbackMinDeadlineMin: 20 });

export const TUNABLE_BOUNDS = Object.freeze({
  repeatWindowDays: { min: 1, max: 365 },
  callbackGraceMin: { min: 0, max: 120 },
  callbackMinDeadlineMin: { min: 0, max: 240 },
  priceTargetPct: { min: 1, max: 100 },
});

const intIn = (v: unknown, b: { min: number; max: number }): number | null => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < b.min || v > b.max) return null;
  return v;
};

/**
 * Розбір вводу адміна. Усі чотири поля обовʼязкові й перевіряються ЦІЛКОМ: часткового збереження немає, щоб
 * «забуте» поле не повернулось мовчки до старту. Поза межами — помилка зі словами, а не тихий кламп.
 */
export function parseTunables(body: unknown): { ok: true; value: FirstTouchTunables } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const B = TUNABLE_BOUNDS;
  const win = b.repeatWindowDays === null ? null : intIn(b.repeatWindowDays, B.repeatWindowDays);
  if (b.repeatWindowDays !== null && win == null)
    return { ok: false, error: `Вікно повторного дзвінка — ціле ${String(B.repeatWindowDays.min)}…${String(B.repeatWindowDays.max)} днів або «без обмеження»` };
  const grace = intIn(b.callbackGraceMin, B.callbackGraceMin);
  if (grace == null) return { ok: false, error: `Допуск — ціле ${String(B.callbackGraceMin.min)}…${String(B.callbackGraceMin.max)} хв` };
  const minDl = intIn(b.callbackMinDeadlineMin, B.callbackMinDeadlineMin);
  if (minDl == null) return { ok: false, error: `Мінімальний дедлайн — ціле ${String(B.callbackMinDeadlineMin.min)}…${String(B.callbackMinDeadlineMin.max)} хв` };
  if (b.bannerTone !== "neutral" && b.bannerTone !== "alert") return { ok: false, error: "Колір блоку — «neutral» або «alert»" };
  const target = b.priceTargetPct === undefined ? PRICE_TARGET_DEFAULT : intIn(b.priceTargetPct, B.priceTargetPct);
  if (target == null) return { ok: false, error: `Ціль «ціну озвучено» — ціле ${String(B.priceTargetPct.min)}…${String(B.priceTargetPct.max)} %` };
  return { ok: true, value: { repeatWindowDays: win, callbackGraceMin: grace, callbackMinDeadlineMin: minDl, bannerTone: b.bannerTone, priceTargetPct: target } };
}

export interface TunablesEntry extends FirstTouchTunables { setByName: string | null; setAt: string }

/** Чинні налаштування — останній рядок журналу; журнал порожній — поточна поведінка. */
export async function loadTunables(db: Db): Promise<FirstTouchTunables> {
  const r = (await db.query<{ repeat_window_days: number | null; callback_grace_min: number; callback_min_deadline_min: number; banner_tone: BannerTone; price_target_pct: number | null }>(
    `SELECT repeat_window_days, callback_grace_min, callback_min_deadline_min, banner_tone, price_target_pct
       FROM first_touch_settings_log ORDER BY id DESC LIMIT 1`)).rows[0];
  if (!r) return { ...CURRENT_BEHAVIOUR };
  return { repeatWindowDays: r.repeat_window_days, callbackGraceMin: r.callback_grace_min,
    callbackMinDeadlineMin: r.callback_min_deadline_min, bannerTone: r.banner_tone, priceTargetPct: r.price_target_pct ?? PRICE_TARGET_DEFAULT };
}

/** Останні зміни для екрана налаштувань — хто й коли. */
export async function tunablesHistory(db: Db, limit = 10): Promise<TunablesEntry[]> {
  return (await db.query<{ repeat_window_days: number | null; callback_grace_min: number; callback_min_deadline_min: number;
    banner_tone: BannerTone; price_target_pct: number | null; set_by_name: string | null; set_at: Date }>(
    `SELECT repeat_window_days, callback_grace_min, callback_min_deadline_min, banner_tone, price_target_pct, set_by_name, set_at
       FROM first_touch_settings_log ORDER BY id DESC LIMIT $1`, [limit])).rows
    .map((r) => ({ repeatWindowDays: r.repeat_window_days, callbackGraceMin: r.callback_grace_min,
      callbackMinDeadlineMin: r.callback_min_deadline_min, bannerTone: r.banner_tone, priceTargetPct: r.price_target_pct ?? PRICE_TARGET_DEFAULT,
      setByName: r.set_by_name, setAt: new Date(r.set_at).toISOString() }));
}

export async function saveTunables(db: Db, t: FirstTouchTunables, by: { userId: number | null; name: string | null }, at: Date): Promise<void> {
  await db.query(`INSERT INTO first_touch_settings_log (repeat_window_days, callback_grace_min, callback_min_deadline_min, banner_tone, price_target_pct, set_by, set_by_name, set_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [t.repeatWindowDays, t.callbackGraceMin, t.callbackMinDeadlineMin, t.bannerTone, t.priceTargetPct, by.userId, by.name, at.toISOString()]);
}
