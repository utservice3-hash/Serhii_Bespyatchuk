// Живий перерахунок auto-метрик розділу «Статистики». Щогодини (метрики
// агрегатні — 5-хв синк не потрібен). Рахує ПОТОЧНИЙ місяць+тиждень і
// перезакриває ПОПЕРЕДНІЙ (щоб межа періоду догорталась). UPSERT — без дублів.
//
// Обсяг auto (звірено на Кроці 2, docs/STATISTICS_RECONCILIATION.md): sales
// revenue_won / machines_success / machines_dispatched від STATS_AUTO_FROM.
// Готівка/оплата/рахунки/інші відділи — imported/manual (auto ще не звірено).
// Розширювати — коли відповідні метрики пройдуть звірку (Крок 5).

import { pool } from "../db/pool.js";
import {
  canonTeamLead, SALES_TEAM_LEAD, SALES_FALLBACK_LEAD, STATS_AUTO_FROM,
} from "../statistics/catalog.js";
import { computeDeptAuto } from "../statistics/computeAuto.js";

const FULL_CYCLE = [8921932, 155304];
const SALES_TEAM_IDS = Object.keys(SALES_TEAM_LEAD).map(Number);
const DISPATCH_SQL = "(psm.funnel_stage IN ('invoiced','paid') OR d.status_id IN (69716300,98470988,10937178))";
const RECENT_DAYS = 75; // покриває поточний + попередній місяць

export interface StatsRecomputeStatus {
  lastRunAt: string | null;
  lastError: string | null;
  lastUpserts: number;
  running: boolean;
}
const status: StatsRecomputeStatus = { lastRunAt: null, lastError: null, lastUpserts: 0, running: false };
export function getStatisticsStatus(): StatsRecomputeStatus { return { ...status }; }

let running = false;

export async function recomputeStatistics(): Promise<void> {
  if (running) { console.warn("recomputeStatistics: previous run in progress — skip."); return; }
  running = true; status.running = true;
  const startedAt = new Date();
  try {
    // 60с таймаут на весь прохід (метрики легкі; це запобіжник від зависання).
    await Promise.race([
      run(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("recomputeStatistics timeout 60s")), 60_000)),
    ]);
    status.lastError = null;
  } catch (err) {
    status.lastError = (err as Error).message;
    console.error("recomputeStatistics failed:", err);
  } finally {
    running = false; status.running = false;
    status.lastRunAt = startedAt.toISOString();
  }
}

const teamLeadOf = (teamId: number | null) =>
  teamId != null && SALES_TEAM_LEAD[teamId] ? canonTeamLead(SALES_TEAM_LEAD[teamId]) : SALES_FALLBACK_LEAD;

async function run(): Promise<void> {
  // ключ `${pt}|${ps}|${lead}|${metric}` → value
  const out = new Map<string, number>();
  const add = (pt: string, ps: string, lead: string, metric: string, v: number) => {
    const k = `${pt}|${ps}|${lead}|${metric}`;
    out.set(k, (out.get(k) ?? 0) + v);
  };

  for (const [ptype, trunc] of [["month", "month"], ["week", "week"]] as const) {
    // Q1 closed-based: revenue_won, machines_success (готівку НЕ пишемо — imported)
    const q1 = await pool.query<{ team_id: number | null; bucket: string; rev: string; succ: string }>(
      `SELECT m.team_id AS team_id,
              to_char(date_trunc('${trunc}', (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket,
              COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS succ
         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
        WHERE d.pipeline_id = ANY($1) AND d.status_id = 142 AND d.closed_at_kommo IS NOT NULL
          AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= (CURRENT_DATE - $3::int)
          AND (m.team_id IS NULL OR m.team_id = ANY($2))
        GROUP BY m.team_id, bucket`,
      [FULL_CYCLE, SALES_TEAM_IDS, RECENT_DAYS]
    );
    for (const r of q1.rows) {
      const lead = teamLeadOf(r.team_id);
      add(ptype, r.bucket, lead, "revenue_won", Number(r.rev));
      add(ptype, r.bucket, lead, "machines_success", Number(r.succ));
    }
    // Q2 created-based: machines_dispatched (снапшот-проксі)
    const q2 = await pool.query<{ team_id: number | null; bucket: string; disp: string }>(
      `SELECT m.team_id AS team_id,
              to_char(date_trunc('${trunc}', (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket,
              COUNT(*) AS disp
         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
         LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE d.pipeline_id = ANY($1) AND ${DISPATCH_SQL} AND d.created_at_kommo IS NOT NULL
          AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= (CURRENT_DATE - $3::int)
          AND (m.team_id IS NULL OR m.team_id = ANY($2))
        GROUP BY m.team_id, bucket`,
      [FULL_CYCLE, SALES_TEAM_IDS, RECENT_DAYS]
    );
    for (const r of q2.rows) add(ptype, r.bucket, teamLeadOf(r.team_id), "machines_dispatched", Number(r.disp));
  }

  const rows = [...out.entries()].filter(([k]) => k.split("|")[1] >= STATS_AUTO_FROM);
  let upserts = 0;
  if (rows.length) {
    const vals: unknown[] = [];
    const tuples = rows.map(([k, value], j) => {
      const [pt, ps, lead, metric] = k.split("|");
      const b = j * 5;
      vals.push(pt, ps, lead, metric, value);
      return `('sales',$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'auto')`;
    }).join(",");
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ${tuples}
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
      vals
    );
    upserts += rows.length;
  }

  // Відділові auto-метрики (marketing/logistics, рівень відділу, team_lead=NULL)
  // за поточний період — межа ~40 днів покриває поточний+попередній бакет.
  const since = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  const dept = await computeDeptAuto(since < STATS_AUTO_FROM ? STATS_AUTO_FROM : since);
  const dRows = [...dept.entries()];
  if (dRows.length) {
    const vals: unknown[] = [];
    const tuples = dRows.map(([k, value], j) => {
      const [department, pt, ps, metric] = k.split("|");
      const b = j * 5;
      vals.push(department, pt, ps, metric, value);
      return `($${b + 1},$${b + 2},$${b + 3},NULL,$${b + 4},$${b + 5},'auto')`;
    }).join(",");
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ${tuples}
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
      vals
    );
    upserts += dRows.length;
  }
  status.lastUpserts = upserts;
  console.log(`recomputeStatistics: upserted ${upserts} auto values (sales ${rows.length} + dept ${dRows.length}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  recomputeStatistics().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
