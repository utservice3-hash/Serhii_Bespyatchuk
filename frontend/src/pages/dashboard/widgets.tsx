// Small presentational widgets shared across dashboard sections.
import { useState } from "react";
import { formatAmount } from "./format";

/** Plan-vs-fact fill bar with a hover popover listing top contributors. */
export function ProgressGauge({
  plan,
  planMonth,
  fact,
  pct,
  contributors,
}: {
  plan: number;
  planMonth?: number;
  fact: number;
  pct: number;
  contributors: { name: string; revenue: number; deals: number }[];
}) {
  const [hover, setHover] = useState(false);
  const color = pct >= 100 ? "#16a34a" : pct >= 70 ? "#d97706" : "#dc2626";
  return (
    <div
      className="kpi-card"
      style={{ gridColumn: "span 2", position: "relative", cursor: "pointer" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="kpi-label">План / Факт за період</span>
        <span style={{ fontWeight: 700, color }}>{pct}%</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, margin: "6px 0 8px" }}>
        <span style={{ color: "var(--text-muted)" }}>Факт {formatAmount(fact)}</span>
        <span style={{ color: "var(--text-muted)" }}>План {formatAmount(plan)}</span>
      </div>
      {planMonth != null && planMonth !== plan && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
          План на весь місяць: {formatAmount(planMonth)} (за період — пропорційно)
        </div>
      )}
      <div style={{ height: 14, borderRadius: 8, background: "var(--border, #eceff3)", overflow: "hidden" }}>
        <div
          style={{
            width: `${Math.min(100, pct)}%`,
            height: "100%",
            background: color,
            borderRadius: 8,
            transition: "width .5s ease",
          }}
        />
      </div>
      {hover && contributors.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 12,
            right: 12,
            background: "var(--card-bg, #fff)",
            border: "1px solid var(--border, #e0e4ea)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            padding: 12,
            zIndex: 50,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Найбільший вклад:</div>
          {contributors.slice(0, 5).map((c) => (
            <div key={c.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "2px 0" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              <span style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                {formatAmount(c.revenue)}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                  {" "}· {fact > 0 ? Math.round((c.revenue / fact) * 100) : 0}%
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** KPI card that reveals a per-team breakdown popover on hover. */
export function HoverInfoCard({
  label,
  value,
  rows,
  hint,
}: {
  label: string;
  value: string;
  rows: { teamName: string; deals: number; revenue: number }[];
  hint?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="kpi-card"
      style={{ position: "relative", cursor: "pointer" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="kpi-label">{label}{hint && <InfoHint text={hint} />}</span>
      <span className="kpi-value">{value}</span>
      {hover && rows.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 12,
            right: 12,
            background: "var(--card-bg, #fff)",
            border: "1px solid var(--border, #e0e4ea)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            padding: 12,
            zIndex: 50,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>По командах:</div>
          {rows.map((r) => (
            <div key={r.teamName} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "2px 0" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.teamName}</span>
              <span style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                {formatAmount(r.revenue)}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {r.deals} угод</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const FORECAST_COLORS: Record<string, string> = {
  on_track: "#22c55e",
  at_risk: "#f59e0b",
  behind: "#ef4444",
  no_plan: "#94a3b8",
};

const FORECAST_LABELS: Record<string, string> = {
  on_track: "В темпі плану",
  at_risk: "Під загрозою",
  behind: "Відставання",
  no_plan: "Немає плану",
};

/** Small ⓘ icon that reveals a data-source explanation on hover (desktop) or
 *  tap (mobile). Safe to embed inside clickable KPI <button> cards — clicks are
 *  stopped so opening the hint doesn't trigger the card's own modal. */
export function InfoHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="info-hint"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span className="info-hint-icon" aria-label="Звідки дані">ⓘ</span>
      {open && (
        <span className="info-hint-pop" onClick={(e) => e.stopPropagation()}>
          {text}
        </span>
      )}
    </span>
  );
}

export function ForecastBadge({ forecast }: { forecast: { status: string; projectedPct: number } }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: FORECAST_COLORS[forecast.status] ?? "#94a3b8",
      }}
    >
      {FORECAST_LABELS[forecast.status] ?? forecast.status}
      {forecast.status !== "no_plan" && ` · ${Math.round(forecast.projectedPct * 100)}%`}
    </span>
  );
}
