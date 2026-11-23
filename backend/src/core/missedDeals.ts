import { pool } from "../db/pool.js";
import type { MissedScope } from "./missedCallsRules.js";
import {
  missedDealsSummarySql, missedDealsByManagerSql, missedDealsListSql, missedDealNext, missedDealManagerName,
  MISSED_DEALS_LIST_LIMIT, type MissedDealNext,
} from "./missedDealsRules.js";

/**
 * 📄 ПРОПУЩЕНІ УГОДИ — шар до бази над `missedDealsRules.ts` (рішення Романа 20.11.2026). Правило — там і в словнику §11a.
 * `now` один на всі три запити: «ще не минуло 5 хв» рахується від однієї миті, і підсумок не розійдеться зі списком.
 */
export interface MissedDealsSummary {
  deals: number; missed: number; talkedLater: number; ownerless: number; carriers: number; pending: number;
}
export interface MissedDealsManagerRow {
  managerId: number | null; name: string; teamId: number | null; teamName: string | null;
  deals: number; missed: number; talkedLater: number;
}
export interface MissedDealsListRow {
  dealId: number; at: string; phone: string; managerId: number | null; managerName: string; teamName: string | null;
  next: MissedDealNext; nextMin: number | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export async function missedDeals(from: string, to: string, s: MissedScope, now: Date): Promise<{
  summary: MissedDealsSummary; managers: MissedDealsManagerRow[]; rows: MissedDealsListRow[]; truncated: boolean;
}> {
  const nowIso = now.toISOString();
  const a = missedDealsSummarySql(from, to, s, nowIso);
  const b = missedDealsByManagerSql(from, to, s, nowIso);
  const c = missedDealsListSql(from, to, s, nowIso);
  const [rs, rm, rl] = await Promise.all([
    pool.query<{ deals: number; missed: number; talked_later: number; ownerless: number; carriers: number; pending: number }>(a.sql, a.params),
    pool.query<{ manager_id: number | null; name: string | null; team_id: number | null; team_name: string | null;
      deals: number; missed: number; talked_later: number }>(b.sql, b.params),
    pool.query<{ kommo_id: string; at: string; phone: string; manager_id: number | null; manager_name: string | null;
      team_name: string | null; talk_min: string | null; out_min: string | null }>(c.sql, c.params),
  ]);
  const x = rs.rows[0];
  const summary: MissedDealsSummary = {
    deals: num(x?.deals), missed: num(x?.missed), talkedLater: num(x?.talked_later),
    ownerless: num(x?.ownerless), carriers: num(x?.carriers), pending: num(x?.pending),
  };
  const managers = rm.rows
    .map((m) => ({
      managerId: m.manager_id, name: missedDealManagerName(m.manager_id, m.name),
      teamId: m.team_id, teamName: m.team_name,
      deals: num(m.deals), missed: num(m.missed), talkedLater: num(m.talked_later),
    }))
    .sort((p, q) => q.missed - p.missed || q.deals - p.deals || p.name.localeCompare(q.name, "uk"));
  const truncated = rl.rows.length > MISSED_DEALS_LIST_LIMIT;
  const rows = rl.rows.slice(0, MISSED_DEALS_LIST_LIMIT).map((r) => {
    const n = missedDealNext(numOrNull(r.talk_min), numOrNull(r.out_min));
    return {
      dealId: Number(r.kommo_id), at: r.at, phone: r.phone,
      managerId: r.manager_id, managerName: missedDealManagerName(r.manager_id, r.manager_name), teamName: r.team_name,
      next: n.kind, nextMin: n.minutes,
    };
  });
  return { summary, managers, rows, truncated };
}
