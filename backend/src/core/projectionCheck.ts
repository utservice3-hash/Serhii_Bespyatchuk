import { pool } from "../db/pool.js";
import { FC_PIPELINES, STAGE_PAID } from "./money.js";
import { EXPECT_ZONE } from "./metrics.js";

const K = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * 🔁 САМОПЕРЕВІРКА ФОРМУЛИ A (стоп-критерій формули, не окрема фіча).
 * Щойно місяць завершився — реконструюємо «прогноз@17» ТІЄЮ Ж методологією, що
 * бектест (статус-на-T через deal_stage_events + повна зона + трейл-добір), і
 * порівнюємо з РЕАЛЬНИМ фіналом місяця. Пишемо в `projection_backtest` (PK ym →
 * ідемпотентно: рахується РАЗ на місяць, наступні ночі — no-op). |зміщення| >
 * PROJECTION_ALERT_PCT → Telegram-алерт: формула поплила, треба ребектест.
 * ⚠️ Реконструкція «факту@17» — по подіях входу в 142/етап9 (та сама, що в
 * бектесті, який дав MAE 4.6%); planned_payment_at не історизується, але Формулі A
 * він і не потрібен (повна зона за СТАТУСОМ).
 */
export const PROJECTION_ALERT_PCT = 10;

export interface ProjectionCheckRow {
  ym: string;
  factAt17: number;
  zoneAt17: number;
  dobir: number;
  forecast: number;
  final: number;
  errorPct: number | null;
  isNew: boolean;
}

export async function checkProjectionAccuracy(): Promise<ProjectionCheckRow | null> {
  // Попередній (щойно завершений) місяць за Києвом.
  const todayK = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const [y, m] = todayK.split("-").map(Number);
  let py = y, pm = m - 1;
  if (pm < 1) { pm = 12; py--; }
  const ym = `${py}-${String(pm).padStart(2, "0")}`;
  const monthStart = `${ym}-01`;
  const T = `${ym}-17 23:59:59`;

  // Ідемпотентність: уже залоговано → віддати наявне, БЕЗ повторного алерту.
  const ex = await pool.query<{ fact_at17: string; zone_at17: string; dobir: string; forecast: string; final: string; error_pct: string | null }>(
    `SELECT fact_at17, zone_at17, dobir, forecast, final, error_pct FROM projection_backtest WHERE ym = $1`, [ym]
  );
  if (ex.rows.length > 0) {
    const r = ex.rows[0];
    return { ym, factAt17: Number(r.fact_at17), zoneAt17: Number(r.zone_at17), dobir: Number(r.dobir), forecast: Number(r.forecast), final: Number(r.final), errorPct: r.error_pct == null ? null : Number(r.error_pct), isNew: false };
  }

  // Реконструкція стану «на 17-те» (статус-на-T по подіях; та сама CTE, що в бектесті).
  const st = await pool.query<{ success_s: string; paid_s: string; zone_s: string }>(
    `WITH s AS (
        SELECT DISTINCT ON (kommo_id) kommo_id, status_id, changed_at
          FROM deal_stage_events
         WHERE pipeline_id = ANY($1) AND changed_at <= ($2 ${K})
         ORDER BY kommo_id, changed_at DESC)
     SELECT
       COALESCE(sum(d.price) FILTER (WHERE s.status_id = 142 AND (s.changed_at ${K})::date >= $3),0) success_s,
       COALESCE(sum(d.price) FILTER (WHERE s.status_id = ANY($4) AND (s.changed_at ${K})::date >= $3),0) paid_s,
       COALESCE(sum(d.price) FILTER (WHERE s.status_id = ANY($5)),0) zone_s
     FROM s JOIN deals d ON d.kommo_id = s.kommo_id`,
    [FC_PIPELINES, T, monthStart, STAGE_PAID, EXPECT_ZONE]
  );
  const factAt17 = Number(st.rows[0].success_s) + Number(st.rows[0].paid_s);
  const zoneAt17 = Number(st.rows[0].zone_s);

  // Трейл-добір: 3 завершені місяці ПЕРЕД ym, created day>17 & closed same month.
  const db = await pool.query<{ s: string }>(
    `SELECT COALESCE(sum(d.price),0) s
       FROM deals d
      WHERE d.status_id = 142 AND d.pipeline_id = ANY($1) AND d.closed_at_kommo IS NOT NULL
        AND to_char((d.created_at_kommo ${K}),'YYYY-MM') = to_char((d.closed_at_kommo ${K}),'YYYY-MM')
        AND extract(day from (d.created_at_kommo ${K})) > 17
        AND (d.closed_at_kommo ${K})::date >= ($2::date - interval '3 months')
        AND (d.closed_at_kommo ${K})::date < $2::date
      GROUP BY to_char((d.closed_at_kommo ${K}),'YYYY-MM')`,
    [FC_PIPELINES, monthStart]
  );
  const dobir = db.rows.length ? Math.round(db.rows.reduce((a, r) => a + Number(r.s), 0) / db.rows.length) : 0;

  // Реальний фінал місяця (success за фінальним станом, анкер closed_at).
  const fin = await pool.query<{ s: string }>(
    `SELECT COALESCE(sum(d.price),0) s FROM deals d
      WHERE d.status_id = 142 AND d.pipeline_id = ANY($1) AND d.closed_at_kommo IS NOT NULL
        AND to_char((d.closed_at_kommo ${K}),'YYYY-MM') = $2`,
    [FC_PIPELINES, ym]
  );
  const final = Number(fin.rows[0].s);
  const forecast = Math.round(factAt17 + zoneAt17 + dobir);
  const errorPct = final > 0 ? Math.round(((forecast - final) / final) * 1000) / 10 : null;

  await pool.query(
    `INSERT INTO projection_backtest (ym, fact_at17, zone_at17, dobir, forecast, final, error_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ym) DO NOTHING`,
    [ym, Math.round(factAt17), Math.round(zoneAt17), dobir, forecast, Math.round(final), errorPct]
  );
  return { ym, factAt17: Math.round(factAt17), zoneAt17: Math.round(zoneAt17), dobir, forecast, final: Math.round(final), errorPct, isNew: true };
}
