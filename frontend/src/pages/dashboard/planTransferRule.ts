/**
 * 🔁 Правила діалогу «Передати план менеджера, який пішов» (задача 10477) - дзеркало серверних
 * `core/planTransferRules.ts`. Сервер перевіряє те саме ще раз; тут вони потрібні, щоб кнопка «Зберегти»
 * була неактивною, поки сума не сходиться, а не щоб замінити перевірку сервера.
 */
export type TransferMode = "all" | "rest";

/** Поділ порівну в цілих гривнях; залишок - першим. Σ завжди дорівнює `total`. */
export function splitEqually(total: number, n: number): number[] {
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(n) || n <= 0) return [];
  const base = Math.floor(total / n);
  let rem = total - base * n;
  return Array.from({ length: n }, () => { const v = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; return v; });
}

/** Скільки передаємо: увесь нерозподілений план або план мінус уже зароблене тим, хто пішов. */
export function transferAmount(pool: number, fact: number, mode: TransferMode): number {
  if (mode === "all") return Math.max(0, Math.round(pool));
  return Math.max(0, Math.round(pool) - Math.max(0, Math.round(fact)));
}

/** Чи можна зберігати: є отримувачі, кожна сума - ціле більше нуля, і разом вони дорівнюють тому, що передаємо. */
export function transferReady(total: number, amounts: number[]): boolean {
  return total > 0 && amounts.length > 0 && amounts.every((a) => Number.isInteger(a) && a > 0)
    && amounts.reduce((s, a) => s + a, 0) === total;
}
