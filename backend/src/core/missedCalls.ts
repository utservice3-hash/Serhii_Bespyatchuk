import { pool } from "../db/pool.js";
import { DAY_BUCKETS, type DayBucket } from "./dayBuckets.js";
import {
  missedSummarySql, missedByManagerSql, foldManagerRows,
  type MissedScope, type MissedManagerRaw, type MissedManagerRow,
} from "./missedCallsRules.js";

/**
 * 📵 ПРОПУЩЕНІ ВХІДНІ — ШАР, ЩО ХОДИТЬ У БАЗУ. ТЗ-1 від 14.09.2026.
 *
 * Означення й форма запиту живуть у `missedCallsRules.ts` (чистий модуль, без
 * `pool`). Поділ не косметичний: рівно він дозволяє гейтам перевіряти ОЗНАЧЕННЯ у
 * звичайному `npm test`, без живої БД і без скіпу, який ніколи не виконується.
 */

export interface MissedSummary {
  missed: number; excluded: number; ownerless: number;
  callback: number; callbackTalked: number; callbackSelf: number; callbackColleague: number;
  clientSelf: number; medianMin: number | null;
  buckets: Record<DayBucket, number>;
}

interface SummaryRaw {
  missed: number; excluded: number; ownerless: number; callback: number;
  callback_talked: number; callback_self: number; callback_colleague: number;
  client_self: number; median_min: string | null;
  b_work: number; b_evening: number; b_weekend: number; b_night: number;
}

/**
 * Блок A. Одна поїздка в базу на всі числа періоду — не заради швидкості, а тому
 * що інакше частки й ціле бралися б у РІЗНІ моменти живої таблиці. Дзвінки
 * доливаються щогодини; сусідній гейт `#26q` уже платив за це (зона зрушила на
 * 6 495 ₴ за 15 хв), і правило 18 у CLAUDE.md вимагає одного виклику.
 */
export async function missedSummary(from: string, to: string, s: MissedScope = {}): Promise<MissedSummary> {
  const { sql, params } = missedSummarySql(from, to, s);
  const r = await pool.query<SummaryRaw>(sql, params);
  const x = r.rows[0];
  const n = (v: number | undefined): number => Number(v ?? 0);
  return {
    missed: n(x?.missed), excluded: n(x?.excluded), ownerless: n(x?.ownerless),
    callback: n(x?.callback), callbackTalked: n(x?.callback_talked),
    callbackSelf: n(x?.callback_self), callbackColleague: n(x?.callback_colleague),
    clientSelf: n(x?.client_self),
    medianMin: x?.median_min == null ? null : Math.round(Number(x.median_min)),
    buckets: {
      work: n(x?.b_work), evening: n(x?.b_evening),
      weekend: n(x?.b_weekend), night: n(x?.b_night),
    },
  };
}

/** Блок B. Рядок «без відповідального» приходить звідси ЗВИЧАЙНИМ рядком із `null`. */
export async function missedByManager(from: string, to: string, s: MissedScope = {}):
Promise<{ rows: MissedManagerRow[]; total: MissedManagerRow }> {
  const { sql, params } = missedByManagerSql(from, to, s);
  const r = await pool.query<{
    manager_id: number | null; name: string | null; missed: number;
    callback_self: number; callback_colleague: number; client_self: number; median_min: string | null;
  }>(sql, params);
  const raw: MissedManagerRaw[] = r.rows.map((x) => ({
    managerId: x.manager_id, name: x.name, missed: Number(x.missed),
    callbackSelf: Number(x.callback_self), callbackColleague: Number(x.callback_colleague),
    clientSelf: Number(x.client_self),
    medianMin: x.median_min == null ? null : Math.round(Number(x.median_min)),
  }));
  return foldManagerRows(raw);
}

export { DAY_BUCKETS };
export type { DayBucket, MissedScope, MissedManagerRow };
