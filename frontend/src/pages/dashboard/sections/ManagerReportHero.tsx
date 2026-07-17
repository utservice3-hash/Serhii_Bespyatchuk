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
        {proj.zoneFull > 0 ? (
          <>
            <Stat
              label="Прогноз місяця"
              value={uah(proj.projected)}
              sub={`${proj.projectedPct != null ? `${proj.projectedPct}% плану · ` : ""}коридор ±5%: ${uah(proj.projected * 0.95)} – ${uah(proj.projected * 1.05)}`}
              color={pctColor(proj.projectedPct)}
              title={`Модель (бектест 5 міс: зміщення −3.9%, MAE 4.6%, найгірший місяць −14%): факт + повна грошова зона + новий бізнес (трейл 3м). Місяці задньозавантажені — точність ±5% із середини місяця.\nСкладові: факт ${uah(revenue.fact)} + зона ${uah(proj.zoneFull)} (${proj.zoneDeals} угод, ~65% закривається, решту добирають ранні стадії) + добір ${uah(proj.dobir)}.`}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                = факт + повна грошова зона {uah(proj.zoneFull)} ({proj.zoneDeals}) + новий бізнес {uah(proj.dobir)}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                контекст: підлога (без нових) {uah(proj.floor)}{proj.floorPct != null ? ` · ${proj.floorPct}%` : ""} · по темпу дня ({proj.elapsedWorkingDays}/{proj.totalWorkingDays} роб. дн.) {uah(proj.byPace)}{proj.byPacePct != null ? ` · ${proj.byPacePct}%` : ""}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                ⚠️ прогноз бере ПОВНУ зону; картка «Очікування → цей місяць» — лише planned-дату (різні питання)
              </span>
            </div>
          </>
        ) : (
          <Stat label="Прогноз" value={uah(proj.projected)} sub={proj.projectedPct != null ? `${proj.projectedPct}% плану` : undefined} color={pctColor(proj.projectedPct)} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color, strong, title }: { label: string; value: string; sub?: string; color?: string; strong?: boolean; title?: string }) {
  return (
    <div title={title} style={title ? { cursor: "help" } : undefined}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      <div style={{ fontSize: strong ? 24 : 20, fontWeight: strong ? 800 : 700, color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{sub}</div>}
    </div>
  );
}
