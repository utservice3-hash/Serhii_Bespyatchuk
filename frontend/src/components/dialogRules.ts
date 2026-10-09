/**
 * 🪟 ПРАВИЛА ДІАЛОГІВ ДАШБОРДА — чисті, без React (прохід B стандарту сповіщень, 09.10.2026; Роман: «треба щоб всі
 * сповіщення були в 1 системі і підпорядковувалися 1 правилам»). Тут — ЩО повертає діалог на кожну дію людини; верстка —
 * у `Dialogs.tsx`. Окремо, щоб гейти перевіряли поведінку, а не текст коду (`#1500c`).
 */

export type DialogKind = "confirm" | "prompt" | "choose" | "form";

export interface FieldSpec {
  key: string;
  label: string;
  initial?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  /** Вибір зі списку замість введення: значення — лише одне з `options`. */
  options?: { value: string; label: string; hint?: string }[];
}

/** Поле, яке не пройшло перевірку (перше), або `null` — можна підтверджувати. */
export function firstInvalid(fields: FieldSpec[], values: Record<string, string>): string | null {
  for (const f of fields) {
    const v = (values[f.key] ?? "").trim();
    if (f.options && v !== "" && !f.options.some((o) => o.value === v)) return f.key;
    if (f.required && v === "") return f.key;
  }
  return null;
}

/** Що віддати викликачу на підтвердження: значення без крайніх пробілів (поле-список — як є). */
export function submittedValues(fields: FieldSpec[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.key] = (values[f.key] ?? "").trim();
  return out;
}

/**
 * Клавіша → дія. Esc скасовує завжди. Enter підтверджує, але НЕ в багаторядковому полі (там це новий рядок) і не тоді,
 * коли обовʼязкове поле порожнє — інакше «обовʼязково» трималось би лише на кнопці.
 */
export function keyAction(key: string, opts: { inMultiline: boolean; invalid: boolean }): "cancel" | "submit" | null {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && !opts.inMultiline) return opts.invalid ? null : "submit";
  return null;
}

/**
 * Підпис кнопки підтвердження — назва дії, а не «ОК»: «Видалити «x»?» → «Видалити». Перше слово-дієслово (на -ти/-тись),
 * інакше «Так». Небезпечна дія (видалити, прибрати, деактивувати…) — червона кнопка, і фокус стоїть на «Скасувати».
 */
const DANGER = /^(видалити|прибрати|деактивувати|архівувати|скасувати|зняти|відхилити|відкликати|очистити|звільнити)/i;
export function confirmLabel(text: string): { label: string; danger: boolean } {
  const first = (text.trim().match(/^[\p{L}ʼ'’-]+/u)?.[0] ?? "");
  const verb = /(ти|тись)$/iu.test(first) ? first : "";
  return { label: verb ? verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase() : "Так", danger: DANGER.test(first) };
}
