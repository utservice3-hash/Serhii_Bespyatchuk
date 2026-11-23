/**
 * 🔁 ПЕРЕДАЧА ПЛАНУ МЕНЕДЖЕРА, ЯКИЙ ПІШОВ (задача 10477, ТЗ Юлі 20.11.2026; рішення Романа 23.11.2026).
 *
 * Було: план того, хто пішов, САМ ділився порівну на всіх активних у команді (`core/plans.ts`). Тімлід
 * не міг віддати його лише тим, хто тягне, а в «Плани» цей план просто зникав з екрана.
 * Стало: план лежить у ПУЛІ «не розподілено» і входить у план команди, поки КВП не передасть його
 * обраним менеджерам команди або свідомо не зніме.
 *
 * Тут лише чисті правила (без бази), щоб їх тримали гейти `#4030`–`#4034` без кластера.
 */

/**
 * З якого місяця план того, хто пішов, іде в пул, а не ділиться сам. Минулі місяці рахуються як
 * раніше: інакше закриті місяці зрушили б заднім числом (`#4.4` стереже їхні суми).
 */
export const PLAN_POOL_FROM_MONTH = "2026-11-01";

/** Чи діє для місяця пул (а не автоподіл). `month` - 'YYYY-MM-01' або 'YYYY-MM'. */
export function poolApplies(month: string): boolean {
  return `${month.slice(0, 7)}-01` >= PLAN_POOL_FROM_MONTH;
}

/** Передавати й знімати можна лише в поточному або майбутньому місяці: закритий місяць не рухаємо. */
export function monthOpenForTransfer(month: string, currentMonth: string): boolean {
  const m = `${month.slice(0, 7)}-01`;
  return poolApplies(m) && m >= `${currentMonth.slice(0, 7)}-01`;
}

/** Хто передає і знімає: КВП і адмін (ТЗ, п.2). Тімлід лише пропонує - окремим проходом. */
export function canTransferPlan(auth: { role?: string; roleKey?: string | null }): boolean {
  return auth.roleKey === "kvp" || auth.roleKey === "admin";
}

/** Поділ порівну в цілих гривнях; залишок від ділення - першим у списку. Σ завжди дорівнює `total`. */
export function splitEqually(total: number, n: number): number[] {
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(n) || n <= 0) return [];
  const base = Math.floor(total / n);
  let rem = total - base * n;
  return Array.from({ length: n }, () => { const v = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; return v; });
}

export type TransferMode = "all" | "rest";

/**
 * Скільки передаємо. «all» - увесь нерозподілений план; «rest» - план мінус уже зароблене тим, хто пішов:
 * тоді зароблена частина лишається за ним як виконаний план, і план команди не змінюється.
 */
export function transferAmount(pool: number, fact: number, mode: TransferMode): number {
  if (mode === "all") return Math.max(0, Math.round(pool));
  return Math.max(0, Math.round(pool) - Math.max(0, Math.round(fact)));
}

export interface TransferPart { managerId: number; amount: number }
export interface TransferInput {
  /** нерозподілений план того, хто пішов */
  pool: number;
  /** його факт за місяць */
  fact: number;
  mode: TransferMode;
  parts: TransferPart[];
  /** id тих, кому ставиться план у ТІЙ САМІЙ команді */
  roster: ReadonlySet<number>;
}
export type TransferVerdict =
  | { ok: true; amount: number; keep: number; parts: TransferPart[] }
  | { ok: false; error: string };

/**
 * Перевірка передачі ДО будь-якого запису. Сума частин мусить ТОЧНО дорівнювати тому, що передаємо:
 * інакше план команди тихо зрушив би на різницю.
 */
export function transferVerdict(i: TransferInput): TransferVerdict {
  const pool = Math.round(i.pool);
  if (!(pool > 0)) return { ok: false, error: "У цього менеджера немає нерозподіленого плану" };
  if (i.mode !== "all" && i.mode !== "rest") return { ok: false, error: "Невідомий режим передачі" };
  const amount = transferAmount(pool, i.fact, i.mode);
  if (!(amount > 0)) return { ok: false, error: "Залишку для передачі немає: факт уже покрив план" };
  if (!Array.isArray(i.parts) || i.parts.length === 0) return { ok: false, error: "Оберіть хоча б одного менеджера" };
  const seen = new Set<number>();
  let sum = 0;
  for (const p of i.parts) {
    if (!Number.isInteger(p.managerId) || !i.roster.has(p.managerId)) {
      return { ok: false, error: "Передати можна лише менеджерам тієї самої команди, яким ставиться план" };
    }
    if (seen.has(p.managerId)) return { ok: false, error: "Один менеджер указаний двічі" };
    seen.add(p.managerId);
    if (!Number.isInteger(p.amount) || p.amount <= 0) return { ok: false, error: "Сума кожному - ціле число більше нуля" };
    sum += p.amount;
  }
  if (sum !== amount) {
    return { ok: false, error: `Сума частин ${sum} не дорівнює плану, який передаємо (${amount})` };
  }
  return { ok: true, amount, keep: pool - amount, parts: i.parts.map((p) => ({ managerId: p.managerId, amount: p.amount })) };
}
