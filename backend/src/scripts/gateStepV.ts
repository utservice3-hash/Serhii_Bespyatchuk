import { pool } from "../db/pool.js";
import * as metrics from "../core/metrics.js";

/**
 * Крок В — Σ-ГЕЙТИ конверсій (READ-ONLY, запускати НА СЕРВЕРІ з DATABASE_URL):
 *   npx tsx src/scripts/gateStepV.ts 2026-02   # зрілий місяць
 *   npx tsx src/scripts/gateStepV.ts 2026-07   # поточний → ⏳
 *
 * По ВСІХ 4 конверсіях друкує: entered · ДО(142-only) won/% → ПІСЛЯ(MONEY_ZONE)
 * won/% · mature, і перевіряє інваріанти:
 *   • ПІСЛЯ ≥ ДО (MONEY_ZONE ⊇ {142})   • ≤100%   • знаменник не зсунувся
 *   • детермінізм (двічі однаково)       • зрілий = real %, поточний = ⏳
 *   • крос-екран: Σ per-manager (conversionAdsByManager) == загальний по відділу.
 * Жодних write. Exit 1 при будь-якому порушенні інваріанта.
 */
const ym = process.argv[2] ?? "2026-02";
const FC = [8921932, 155304];
const ADZONE = [69693652, 69693656, 69693660, 68671948, 68065144, 67888780];
const PZ_PIPES = [8921936, 7337048], PZ_TAKEN = 69693696;
const RE_PIPES = [8921948], RE_WARM = 69693740;
const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
let failed = false;

async function adSources(): Promise<string[]> {
  // Той самий контракт, що getSettings().adSources: активні джерела реклами.
  const r = await pool.query<{ v: string }>(
    `SELECT DISTINCT source AS v FROM ad_sources_log WHERE active = true`
  );
  if (!r.rows.length) throw new Error("adSources порожній — конфіг-помилка (див. schema.sql сид)");
  return r.rows.map((x) => x.v);
}

// ── ДО: чисельник = вхід у 142 (стара межа), той самий знаменник ──
async function oldDeal(src: string[]): Promise<{ entered: number; won: number }> {
  const r = await pool.query<{ entered: string; won: string }>(
    `WITH adzone AS (SELECT kommo_id, MIN(changed_at) AS entered_at FROM deal_stage_events WHERE status_id = ANY($1) GROUP BY kommo_id),
          won AS (SELECT kommo_id, MIN(changed_at) AS won_at FROM deal_stage_events WHERE pipeline_id = ANY($2) AND status_id = 142 GROUP BY kommo_id),
          pop AS (SELECT a.entered_at, w.won_at FROM adzone a JOIN deals d ON d.kommo_id=a.kommo_id LEFT JOIN managers m ON m.id=d.manager_id LEFT JOIN won w ON w.kommo_id=a.kommo_id
                  WHERE ((d.traf_type='cpc' OR d.utm_medium='cpc' OR d.utm_campaign IS NOT NULL) OR (((d.client_source = ANY($3) OR d.lead_channel='ad') AND COALESCE(d.client_source,'') NOT ILIKE '%реактив%') AND COALESCE(lower(d.traf_type),'')<>'organic'))
                    AND (CASE WHEN d.lead_channel='leadgen' THEN 'leadgen' WHEN d.client_key IS NOT NULL AND EXISTS (SELECT 1 FROM deals pr JOIN pipeline_stage_map psm2 ON psm2.pipeline_id=pr.pipeline_id AND psm2.status_id=pr.status_id WHERE pr.client_key=d.client_key AND psm2.funnel_stage='paid' AND pr.created_at_kommo<d.created_at_kommo) THEN 'repeat' ELSE 'new' END)='new')
    SELECT COUNT(*) FILTER (WHERE (entered_at ${KYIV}) >= $4::date AND (entered_at ${KYIV}) < ($4::date + INTERVAL '1 month'))::int AS entered,
           COUNT(*) FILTER (WHERE won_at IS NOT NULL AND (entered_at ${KYIV}) >= $4::date AND (entered_at ${KYIV}) < ($4::date + INTERVAL '1 month'))::int AS won
    FROM pop`, [ADZONE, FC, src, ym + "-01"]);
  return { entered: Number(r.rows[0].entered), won: Number(r.rows[0].won) };
}

async function oldClient(entryPipes: number[], entryStatus: number): Promise<{ entered: number; won: number }> {
  const r = await pool.query<{ entered: string; won: string }>(
    `WITH entered AS (SELECT d.client_key, MIN(e.changed_at) AS entered_at FROM deal_stage_events e JOIN deals d ON d.kommo_id=e.kommo_id WHERE e.status_id=$3 AND e.pipeline_id=ANY($1) AND d.client_key IS NOT NULL GROUP BY d.client_key),
          won AS (SELECT en.client_key, MIN(e.changed_at) AS won_at FROM entered en JOIN deals d ON d.client_key=en.client_key JOIN deal_stage_events e ON e.kommo_id=d.kommo_id WHERE e.status_id=142 AND e.pipeline_id=ANY($2) AND e.changed_at>=en.entered_at GROUP BY en.client_key),
          pop AS (SELECT en.entered_at, w.won_at FROM entered en LEFT JOIN won w ON w.client_key=en.client_key)
    SELECT COUNT(*) FILTER (WHERE (entered_at ${KYIV}) >= $4::date AND (entered_at ${KYIV}) < ($4::date + INTERVAL '1 month'))::int AS entered,
           COUNT(*) FILTER (WHERE won_at IS NOT NULL AND (entered_at ${KYIV}) >= $4::date AND (entered_at ${KYIV}) < ($4::date + INTERVAL '1 month'))::int AS won
    FROM pop`, [entryPipes, FC, entryStatus, ym + "-01"]);
  return { entered: Number(r.rows[0].entered), won: Number(r.rows[0].won) };
}

async function oldTransferred(): Promise<{ entered: number; won: number }> {
  const r = await pool.query<{ entered: string; won: string }>(
    `WITH entered AS (SELECT d.client_key, MIN(lr.transferred_at) AS entered_at FROM leadgen_registry lr JOIN deals d ON d.kommo_id=lr.lead_id JOIN managers m ON m.id=d.manager_id JOIN teams t ON t.id=m.team_id WHERE t.name NOT ILIKE '%лідоген%' AND d.client_key IS NOT NULL GROUP BY d.client_key),
          won AS (SELECT en.client_key, MIN(e.changed_at) AS won_at FROM entered en JOIN deals d ON d.client_key=en.client_key JOIN deal_stage_events e ON e.kommo_id=d.kommo_id WHERE e.status_id=142 AND e.pipeline_id=ANY($1) AND e.changed_at>=en.entered_at GROUP BY en.client_key),
          pop AS (SELECT en.entered_at, w.won_at FROM entered en LEFT JOIN won w ON w.client_key=en.client_key)
    SELECT COUNT(*) FILTER (WHERE (entered_at ${KYIV}) >= $2::date AND (entered_at ${KYIV}) < ($2::date + INTERVAL '1 month'))::int AS entered,
           COUNT(*) FILTER (WHERE won_at IS NOT NULL AND (entered_at ${KYIV}) >= $2::date AND (entered_at ${KYIV}) < ($2::date + INTERVAL '1 month'))::int AS won
    FROM pop`, [FC, ym + "-01"]);
  return { entered: Number(r.rows[0].entered), won: Number(r.rows[0].won) };
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const rowAt = <T extends { ym: string }>(rows: T[], y = ym) => rows.find((r) => r.ym === y);

function line(name: string, old: { entered: number; won: number }, nw: metrics.ConversionCohortRow | undefined) {
  const n = nw ?? { entered: 0, wonEventually: 0, cohortPct: null, mature: false } as metrics.ConversionCohortRow;
  console.log(`${name.padEnd(15)} entered=${String(n.entered).padStart(5)} | ДО(142): ${String(old.won).padStart(4)} ${String(pct(old.won, old.entered) ?? "—").padStart(6)}%  →  ПІСЛЯ(MZ): ${String(n.wonEventually).padStart(4)} ${String(n.cohortPct ?? "—").padStart(6)}%  mature=${n.mature}`);
  if (n.wonEventually < old.won) { console.log(`   ❌ ПІСЛЯ < ДО (${n.wonEventually} < ${old.won})`); failed = true; }
  if (n.cohortPct != null && n.cohortPct > 100) { console.log(`   ❌ >100%: ${n.cohortPct}`); failed = true; }
  if (n.entered !== old.entered) { console.log(`   ❌ знаменник зсунувся: ядро=${n.entered} стара=${old.entered}`); failed = true; }
}

async function main() {
  const src = await adSources();
  const curYm = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }).slice(0, 7);
  console.log(`\n=== Крок В Σ-ГЕЙТИ · місяць ${ym} · adSources=${src.length} · поточний=${curYm} ===\n`);

  const [adM, pzM, reM, trM] = await Promise.all([
    metrics.conversionAdsByMonth({}, src),
    metrics.conversionProdzvinByMonth({}),
    metrics.conversionReactivationByMonth({}),
    metrics.conversionTransferredByMonth({}),
  ]);
  const [adO, pzO, reO, trO] = await Promise.all([oldDeal(src), oldClient(PZ_PIPES, PZ_TAKEN), oldClient(RE_PIPES, RE_WARM), oldTransferred()]);

  // Продзвін/Реактивація віддають LeadgenConversionRow (won-поля) → зводимо до
  // cohort-форми для звірки headline-конверсії (won, не handoff).
  const asCohort = (r: metrics.LeadgenConversionRow | undefined): metrics.ConversionCohortRow | undefined =>
    r && { ym: r.ym, entered: r.entered, wonEventually: r.wonEventually, cohortPct: r.wonCohortPct, wonInMonth: r.wonInMonth, periodPct: r.wonPeriodPct, mature: r.mature };
  line("Реклама", adO, rowAt(adM));
  line("Продзвін", pzO, asCohort(rowAt(pzM)));
  line("Реактивація", reO, asCohort(rowAt(reM)));
  line("Лідоген-перед.", trO, rowAt(trM));

  // Дозрівання
  const isCurrent = ym === curYm;
  const adRow = rowAt(adM);
  if (adRow) {
    if (isCurrent && adRow.mature) { console.log(`\n❌ поточний місяць ${ym} має mature=true (очікується ⏳/false)`); failed = true; }
    if (!isCurrent && !adRow.mature) console.log(`\n⚠️ ${ym} НЕ зрілий (mature=false) — обери місяць старіший за now−90д для «real %»`);
    else console.log(`\nДозрівання ${ym}: mature=${adRow.mature} → ${adRow.mature ? "real %" : "⏳"}`);
  }

  // Детермінізм
  const [a1, a2] = await Promise.all([metrics.conversionAdsByMonth({}, src), metrics.conversionAdsByMonth({}, src)]);
  const det = JSON.stringify(a1) === JSON.stringify(a2);
  console.log(`Детермінізм (adByMonth ×2): ${det ? "✅ ідентично" : "❌ РОЗБІЖНІСТЬ"}`);
  if (!det) failed = true;

  // Крос-екран: Σ per-manager (won/entered) == загальний по відділу за [ym..ym]
  const monthEnd = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const mgr = await metrics.conversionAdsByManager({ from: ym + "-01", to: `${ym}-${String(monthEnd).padStart(2, "0")}` }, src);
  const mgrEntered = mgr.reduce((s, m) => s + m.entered, 0);
  const mgrWon = mgr.reduce((s, m) => s + m.won, 0);
  const dept = rowAt(adM);
  const crossOk = dept != null && mgrEntered === dept.entered && mgrWon === dept.wonEventually;
  console.log(`Крос-екран (Σ менеджерів == відділ): Σ entered=${mgrEntered}/${dept?.entered} won=${mgrWon}/${dept?.wonEventually} → ${crossOk ? "✅" : "❌"}`);
  if (!crossOk) { console.log("   (Σ per-manager рахує лише угоди з manager_id; якщо є угоди без менеджера — Δ очікувана, звірити вручну)"); failed = true; }

  console.log(`\n${failed ? "❌ Є ПОРУШЕННЯ — див. вище" : "✅ УСІ ІНВАРІАНТИ ЗЕЛЕНІ"}\n`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
