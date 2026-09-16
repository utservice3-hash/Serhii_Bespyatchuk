import { pool } from "../db/pool.js";
import {
  firstTouchByCallerSql, firstTouchMetaSql, type FirstTouchCounts,
} from "./firstTouchRules.js";

/** Оцінки «перший дотик» за період для Звіту. Правила — `firstTouchRules.ts`. */
export async function firstTouchReport(from: string, to: string): Promise<{
  byManager: Map<number, FirstTouchCounts>;
  unmapped: FirstTouchCounts;
  coveredTeamIds: Set<number>;
  lastAnalyzedAt: string | null;
}> {
  const q = firstTouchByCallerSql(from, to);
  const [rows, meta] = await Promise.all([
    pool.query<{ manager_id: number | null; analyzed: number; voiced: number; no_record: number }>(q.sql, q.params),
    pool.query<{ covered_team_ids: number[]; last_analyzed_at: string | null }>(firstTouchMetaSql()),
  ]);
  const byManager = new Map<number, FirstTouchCounts>();
  let unmapped: FirstTouchCounts = { analyzed: 0, voiced: 0, noRecord: 0 };
  for (const r of rows.rows) {
    const c = { analyzed: Number(r.analyzed), voiced: Number(r.voiced), noRecord: Number(r.no_record) };
    if (r.manager_id == null) unmapped = c; else byManager.set(r.manager_id, c);
  }
  return {
    byManager, unmapped,
    coveredTeamIds: new Set((meta.rows[0]?.covered_team_ids ?? []).map(Number)),
    lastAnalyzedAt: meta.rows[0]?.last_analyzed_at ?? null,
  };
}
