import { finDeliveredByLoadDate, finUnloadedTwoFilters } from "./money.js";
import { receivablesTotal } from "./metrics.js";
import { pool } from "../db/pool.js";
import { periodStart, periodEnd, receivablesSnapshotFits, autoActive, opexMonth, receivablesFxAt, type RefValues } from "./financeKpi.js";
import type { Db } from "./finance.js";

/**
 * 💰 Числа ядра для автоматичних рядків «ФМ» за період (прохід 2б) — один вхід для екрана й для фіксації.
 * Періоди до `FM_AUTO_FROM` — порожньо: там числа з таблиці.
 * Поставлені / вигружені — для будь-якого періоду (за фільтрами фінансиста, `core/money.ts`). Дебіторка — ЗНІМОК
 * «зараз» без історії: дається лише для поточного періоду або, для фіксації, не пізніше доби після кінця періоду —
 * інакше минулий тиждень отримав би сьогоднішній борг. Операційні витрати — лише місяць, з «План/факт» за розділами;
 * валютна дебіторка — підсумок 1С на кінець періоду (журнал `receivables_fx_totals`, тож і для минулих періодів).
 */
export async function fmRefsFor(kindArg: unknown, dateArg: unknown, opts: { forFreeze?: boolean; now?: Date } = {}): Promise<RefValues> {
  const { kind, start } = periodStart(kindArg, dateArg);
  if (!autoActive(kind, start)) return {}; // до старту — числа з таблиці, CRM не рахуємо (і не тратимо запитів)
  const end = periodEnd(kind, start);
  const now = opts.now ?? new Date();
  const [d, u] = await Promise.all([finDeliveredByLoadDate(start, end), finUnloadedTwoFilters(start, end)]);
  const refs: RefValues = { delivered_income: d.income, delivered_expense: d.expense, unloaded_income: u.income, unloaded_expense: u.expense };
  if (receivablesSnapshotFits(kind, start, now, opts.forFreeze === true)) refs.receivables = await receivablesTotal({ managerId: null, teamId: null });
  const db = pool as unknown as Db;
  if (kind === "month") Object.assign(refs, (await opexMonth(db, start)).refs);
  const fx = await receivablesFxAt(db, end, now);
  if (fx) refs.receivables_fx = fx.uah;
  return refs;
}
