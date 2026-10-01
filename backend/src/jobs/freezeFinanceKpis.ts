/**
 * 💰 ФІКСАЦІЯ АВТОМАТИЧНИХ РЯДКІВ «ФМ» — щодня 00:05 за Києвом + догін на старті (прохід 2б, 01.10.2026).
 *
 * Фіксує МИНУЛИЙ тиждень (Пн–Нд) і МИНУЛИЙ місяць: число ядра за фільтрами фінансиста лягає в базу з `frozen_at`.
 * Навіщо: обидва рядки змінюються заднім числом (заміряно на 12 тижнях: «Поставлені» ростуть +4…+54%, «Вигружені»
 * меншають −2…−55%), тож без фіксації число тижня пливло б разом із CRM. Ідемпотентна: зафіксоване й закриті
 * періоди не чіпає; щодня — щоб пропущений понеділок (сервер лежав) догнався наступного дня.
 */
import { pool } from "../db/pool.js";
import { freezeAutoKpis, currentPeriod, shiftPeriod, type PeriodKind } from "../core/financeKpi.js";
import { fmRefsFor } from "../core/financeKpiRefs.js";
import type { Db } from "../core/finance.js";

export async function runFreezeFinanceKpis(now: Date = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const kind of ["week", "month"] as PeriodKind[]) {
    const start = shiftPeriod(kind, currentPeriod(kind, now), -1);
    const refs = await fmRefsFor(kind, start, { forFreeze: true, now });
    const r = await freezeAutoKpis(pool as unknown as Db, kind, start, refs);
    out[`${kind} ${start}`] = r.skipped ?? `зафіксовано ${r.frozen}`;
  }
  console.log("freezeFinanceKpis:", JSON.stringify(out));
  return out;
}
