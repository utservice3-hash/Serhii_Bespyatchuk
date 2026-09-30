/**
 * 🔔 ЧИ ВИДНО, ЩО ДІЯ СПРАЦЮВАЛА — чисті правила (30.09.2026, прохід «А + Г»).
 *
 * Без імпортів навмисно: гейти `#1101`–`#1103` транспілюють цей файл і ВИКОНУЮТЬ його, а не читають.
 * Аудит 30.09 знайшов ~40 кнопок, що при помилці сервера мовчать (обробник без `catch`), і 8 місць,
 * де екран стверджує успіх, якого не було. Правила нижче — спільна відповідь на обидва класи.
 */

const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

type AxiosLike = {
  isAxiosError?: boolean;
  code?: string;
  config?: { method?: string };
  response?: { status?: number; data?: unknown };
};

/**
 * 🛟 СТРАХОВКА. Текст червоного повідомлення для помилки, яку не зловила сама кнопка, — або `null`,
 * коли показувати нічого не треба:
 * - читання (GET) — це фонові оновлення списків, їхній збій не є дією людини;
 * - 401 — інтерцептор `api.ts` уже веде на вхід;
 * - скасований запит і будь-яка помилка не від сервера — не наша справа тут.
 * Причину беремо зі звичної відповіді бекенда `{ error }`: людина має знати, ЧОМУ не вийшло.
 */
export function mutationFailureText(reason: unknown): { head: string; text: string } | null {
  const e = reason as AxiosLike | null;
  if (!e || typeof e !== "object" || e.isAxiosError !== true) return null;
  if (e.code === "ERR_CANCELED") return null;
  const method = (e.config?.method ?? "").toLowerCase();
  if (!WRITE_METHODS.has(method)) return null;
  const status = e.response?.status;
  if (status === 401) return null;
  if (status == null) {
    return { head: "Дію не виконано", text: "Немає звʼязку з сервером. Нічого не збережено — перевірте інтернет і спробуйте ще раз." };
  }
  const data = e.response?.data as { error?: unknown } | undefined;
  const why = data && typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
  return {
    head: "Дію не виконано",
    text: why
      ? `Сервер відповів: «${why}» (${status}). Нічого не збережено.`
      : `Сервер відповів помилкою ${status}. Нічого не збережено — спробуйте ще раз або напишіть адміністратору.`,
  };
}

/** Причина відмови так, як її назвав сервер (`{ error }`), — або запасний текст. */
export function failureReason(e: unknown, fallback: string): string {
  const d = (e as AxiosLike | null)?.response?.data as { error?: unknown } | undefined;
  return d && typeof d.error === "string" && d.error.trim() ? d.error.trim() : fallback;
}

/**
 * ↩ ПОКАЗАТИ ОДРАЗУ, А ПРИ ПОМИЛЦІ — ПОВЕРНУТИ. Для полів, що зберігаються «на льоту» (коментар рахунку,
 * статус задачі у Звіті, клітинка плану КВП). Раніше там стояло `.catch(() => {})`: нове значення лишалось
 * на екрані, хоча в базу не лягло. Повертає `true`, якщо збереглось.
 */
export async function commitOptimistic(p: {
  apply: () => void;
  save: () => Promise<unknown>;
  revert: () => void;
  onError: (e: unknown) => void;
}): Promise<boolean> {
  p.apply();
  try {
    await p.save();
    return true;
  } catch (e) {
    p.revert();
    p.onError(e);
    return false;
  }
}

/**
 * ✕ «ВІДХИЛИТИ» ЗВЕРНЕННЯ. `window.prompt` повертає `null` на «Скасувати» і `""` на порожнє «OK».
 * Було `?? undefined` — і «Скасувати» однаково відхиляло звернення.
 */
export function rejectNote(promptResult: string | null): { reject: false } | { reject: true; note: string | undefined } {
  if (promptResult === null) return { reject: false };
  const note = promptResult.trim();
  return { reject: true, note: note || undefined };
}
