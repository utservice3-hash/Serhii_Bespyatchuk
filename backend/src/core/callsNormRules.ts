import { CALLS_NORM_BOUNDS } from "./callNorm.js";

/** 📞 Правила норми дзвінків (4632) — чисті, без бази. Пояснення — `callsNormPlan.ts`. */
export interface CallsNormRow { fromMonth: string; norm: number; setBy: string | null; setAt: string }

/** Чинна норма місяця `month` (YYYY-MM-01): найпізніша зміна з `fromMonth ≤ month`. Немає — `null` («не задано»). */
export function effectiveNorm(rows: readonly Pick<CallsNormRow, "fromMonth" | "norm" | "setAt">[], month: string): number | null {
  let best: Pick<CallsNormRow, "fromMonth" | "norm" | "setAt"> | null = null;
  for (const r of rows) {
    if (r.fromMonth > month) continue;
    if (!best || r.fromMonth > best.fromMonth || (r.fromMonth === best.fromMonth && r.setAt > best.setAt)) best = r;
  }
  return best ? best.norm : null;
}

/**
 * Хто ставить: КВП (рішення Романа 10.10.2026) і адмін. Тімлід і менеджер — ні: норма одна на всіх, і ставити її
 * собі той, кого нею міряють, не може.
 */
export function canSetCallsNorm(auth: { role?: string; roleKey?: string | null }): boolean {
  return auth.roleKey === "kvp" || auth.roleKey === "admin";
}

/** Перевірка вводу. Місяць — не раніше поточного: нова норма не переписує минулі місяці. */
export function callsNormVerdict(body: unknown, currentMonth: string): { ok: true; norm: number; fromMonth: string } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const norm = Number(b.norm);
  if (!Number.isInteger(norm) || norm < CALLS_NORM_BOUNDS.min || norm > CALLS_NORM_BOUNDS.max) {
    return { ok: false, error: `Норма — ціле число від ${CALLS_NORM_BOUNDS.min} до ${CALLS_NORM_BOUNDS.max} дзвінків на день` };
  }
  const fm = String(b.fromMonth ?? "");
  if (!/^\d{4}-\d{2}$/.test(fm)) return { ok: false, error: "Місяць, з якого діє норма, — у форматі YYYY-MM" };
  const fromMonth = `${fm}-01`;
  if (fromMonth < currentMonth) return { ok: false, error: "Норму не можна поставити заднім числом — минулі місяці лишаються зі своєю нормою" };
  return { ok: true, norm, fromMonth };
}

