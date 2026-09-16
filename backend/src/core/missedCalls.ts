import { pool } from "../db/pool.js";
import { DAY_BUCKETS, type DayBucket } from "./dayBuckets.js";
import {
  missedSummarySql, missedByManagerSql, foldManagerRows,
  missedListSql, noDealCountsSql, noDealListSql, nextStep, OWNERLESS_LABEL, MISSED_LIST_LIMIT,
  type MissedScope, type MissedManagerRaw, type MissedManagerRow, type NextStep, type NoDealState,
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

export interface MissedListRow {
  uniqueid: string; at: string; phone: string | null; clientKey: string | null;
  managerId: number | null; managerName: string; bucket: DayBucket;
  next: NextStep; nextMin: number | null; dealId: number | null;
}

/**
 * Блок C. `truncated` — не прикраса: без нього стеля `MISSED_LIST_LIMIT` мовчки обрізала
 * б список, і екран показав би «ось усі», хоча показав лише частину.
 */
export async function missedList(day: string, s: MissedScope = {}, onlyNoCallback = false):
Promise<{ rows: MissedListRow[]; truncated: boolean }> {
  const { sql, params } = missedListSql(day, s, onlyNoCallback);
  const r = await pool.query<{
    uniqueid: string; at: string; client_phone: string | null; client_key: string | null;
    manager_id: number | null; manager_name: string | null; bucket: DayBucket;
    cb_min: string | null; cb_talked: boolean | null; cs_min: string | null; deal_id: string | null;
  }>(sql, params);
  const rows = r.rows.map((x) => {
    const n = nextStep({
      cbMin: x.cb_min == null ? null : Number(x.cb_min),
      cbTalked: x.cb_talked,
      csMin: x.cs_min == null ? null : Number(x.cs_min),
    });
    return {
      uniqueid: x.uniqueid, at: x.at, phone: x.client_phone, clientKey: x.client_key,
      managerId: x.manager_id,
      managerName: x.manager_id == null ? OWNERLESS_LABEL : (x.manager_name ?? `#${String(x.manager_id)}`),
      bucket: x.bucket, next: n.kind, nextMin: n.minutes,
      dealId: x.deal_id == null ? null : Number(x.deal_id),
    };
  });
  return { rows, truncated: rows.length >= MISSED_LIST_LIMIT };
}

export interface NoDealCounts { answered: number; unknown: number; hasDeal: number; noDeal: number }

/** Блок D. Три стани й ціле одним запитом. */
export async function noDealCounts(from: string, to: string, s: MissedScope = {}): Promise<NoDealCounts> {
  const { sql, params } = noDealCountsSql(from, to, s);
  const x = (await pool.query<{ answered: number; unknown: number; has_deal: number; no_deal: number }>(sql, params)).rows[0];
  return {
    answered: Number(x?.answered ?? 0), unknown: Number(x?.unknown ?? 0),
    hasDeal: Number(x?.has_deal ?? 0), noDeal: Number(x?.no_deal ?? 0),
  };
}

export interface NoDealListRow {
  uniqueid: string; at: string; phone: string | null; clientKey: string | null;
  managerId: number | null; managerName: string; talkSec: number; dealId: number | null;
}

/** Розкриття одного стану блоку D. */
export async function noDealList(from: string, to: string, s: MissedScope, state: NoDealState):
Promise<{ rows: NoDealListRow[]; truncated: boolean }> {
  const { sql, params } = noDealListSql(from, to, s, state);
  const r = await pool.query<{
    uniqueid: string; at: string; client_phone: string | null; client_key: string | null;
    manager_id: number | null; manager_name: string | null; billsec: number; deal_id: string | null;
  }>(sql, params);
  const rows = r.rows.map((x) => ({
    uniqueid: x.uniqueid, at: x.at, phone: x.client_phone, clientKey: x.client_key,
    managerId: x.manager_id,
    managerName: x.manager_id == null ? OWNERLESS_LABEL : (x.manager_name ?? `#${String(x.manager_id)}`),
    talkSec: Number(x.billsec), dealId: x.deal_id == null ? null : Number(x.deal_id),
  }));
  return { rows, truncated: rows.length >= MISSED_LIST_LIMIT };
}

export { DAY_BUCKETS };
export type { DayBucket, MissedScope, MissedManagerRow, NoDealState };
