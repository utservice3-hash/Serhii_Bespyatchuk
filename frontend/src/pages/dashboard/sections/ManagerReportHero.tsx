import type { ManagerReport } from "../../../api";

const uah = (n: number) => Math.round(n).toLocaleString("uk-UA") + " ₴";
const pctColor = (p: number | null) => (p == null ? "#667085" : p >= 100 ? "#16a34a" : p >= 80 ? "#d97706" : "#dc2626");

/**
 * Р4b — ГОЛОВНЕ (рівень 1 піраміди): виконання плану виручки великим числом.
 * Факт/план, залишок, прогноз, Δ до порівняння. Окремий компонент (не моноліт).
 */
export function ManagerReportHero({ revenue, compare }: Pick<ManagerReport, "revenue" | "compare">) {
  const pct = revenue.pctComplete;
  const d = compare?.revenueFact;
  const proj = revenue.projection;
  return (
    <div className="chart-card" style={{ display: "flex", flexWrap: "wrap", gap: 28, alignItems: "center" }}>
      <div style={{ minWidth: 190 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 2 }}>Виконання плану виручки</div>
        <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1, color: pctColor(pct) }}>
          {pct == null ? "—" : `${pct}%`}
        </div>
        {d && d.delta != null && (
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6, color: d.delta >= 0 ? "#16a34a" : "#dc2626" }}>
            {d.delta >= 0 ? "↑" : "↓"} {uah(Math.abs(d.delta))} ({d.deltaPct != null ? `${d.deltaPct > 0 ? "+" : ""}${d.deltaPct}%` : "—"}) до порівняння
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, flex: 1 }}>
        <Stat label="Факт" value={uah(revenue.fact)} strong />
        <Stat label="План" value={uah(revenue.plan)} />
        <Stat label="Залишок до плану" value={uah(revenue.remaining)} color={revenue.remaining > 0 ? "#dc2626" : "#16a34a"} />
        <Stat
          label={proj.pipelineThisMonth > 0 ? "Прогноз (факт + пайплайн)" : "Прогноз"}
          value={uah(proj.projected)}
          sub={
            proj.pipelineThisMonth > 0
              ? `${proj.projectedPct != null ? `${proj.projectedPct}% плану · ` : ""}+${uah(proj.pipelineThisMonth)} пайплайн (${proj.pipelineDeals})`
              : proj.projectedPct != null ? `${proj.projectedPct}% плану` : undefined
          }
          color={pctColor(proj.projectedPct)}
        />
        {proj.pipelineThisMonth > 0 && (
          <Stat
            label={`По темпу дня (${proj.elapsedWorkingDays}/${proj.totalWorkingDays} роб. дн.)`}
            value={uah(proj.byPace)}
            sub={`${proj.byPacePct != null ? `${proj.byPacePct}% · ` : ""}для звірки, не в сумі`}
            color="#94a3b8"
          />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color, strong }: { label: string; value: string; sub?: string; color?: string; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      <div style={{ fontSize: strong ? 24 : 20, fontWeight: strong ? 800 : 700, color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{sub}</div>}
    </div>
  );
}
