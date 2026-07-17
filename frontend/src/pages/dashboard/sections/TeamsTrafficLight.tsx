import type { ManagerReport } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";

type TeamRow = NonNullable<ManagerReport["teams"]>[number];

/** Колір за % виконання плану (токени дашборду): <70 червоний, 70–95 жовтий, ≥95 зелений. */
function planColor(pct: number | null): string {
  if (pct == null) return "var(--text-muted)";
  if (pct < 70) return "#dc2626";
  if (pct < 95) return "#d97706";
  return "#16a34a";
}

/**
 * Р4c.1 — світлофор команд (лише рівень «Відділ»). Команди рядками, найгірші зверху
 * (сортування на бекенді), колір по % плану. Клік по команді → звіт перебудовується
 * на рівень цієї команди (level=team). Δ — до періоду порівняння, коли він увімкнений.
 */
export function TeamsTrafficLight({
  teams,
  onSelectTeam,
}: {
  teams: TeamRow[];
  onSelectTeam: (teamId: number) => void;
}) {
  if (teams.length === 0) {
    return (
      <div className="chart-card">
        <h2 className="chart-title">🚦 Світлофор команд</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Немає даних по командах за цей період.</p>
      </div>
    );
  }

  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 12 }}>🚦 Світлофор команд <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>· найгірші зверху · клік → звіт по команді</span></h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {teams.map((t) => {
          const color = planColor(t.pctPlan);
          const fill = t.pctPlan == null ? 0 : Math.min(100, Math.max(0, t.pctPlan));
          const dprev = t.factPrev != null ? t.fact - t.factPrev : null;
          return (
            <button
              key={t.teamId}
              onClick={() => onSelectTeam(t.teamId)}
              title={`Відкрити звіт по команді «${t.teamName}»`}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 1.4fr) minmax(90px, 2fr) 54px minmax(90px, 1fr)",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                borderLeft: `4px solid ${color}`,
                background: "var(--card-bg)",
                color: "var(--text)",
                cursor: "pointer",
                textAlign: "left",
                width: "100%",
              }}
            >
              {/* Назва + Δ */}
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.teamName}</span>
                {dprev != null && (
                  <span style={{ fontSize: 11, color: dprev >= 0 ? "#16a34a" : "#dc2626" }}>
                    {dprev >= 0 ? "↑" : "↓"} {formatAmount(Math.abs(dprev))} <span style={{ color: "var(--text-muted)" }}>до пор.</span>
                  </span>
                )}
              </span>

              {/* Бар % плану */}
              <span style={{ display: "block", height: 10, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${fill}%`, background: color, borderRadius: 999, transition: "width .3s" }} />
              </span>

              {/* % */}
              <span style={{ fontWeight: 700, fontSize: 15, color, textAlign: "right" }}>
                {t.pctPlan == null ? "—" : `${t.pctPlan}%`}
              </span>

              {/* Залишок до плану */}
              <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }} title={t.plan > 0 ? `План ${formatAmountFull(t.plan)} · факт ${formatAmountFull(t.fact)}` : "План не заданий"}>
                {t.plan > 0 ? <>залишок <span style={{ color: "var(--text)", fontWeight: 600 }}>{formatAmount(t.remaining)}</span></> : "без плану"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
