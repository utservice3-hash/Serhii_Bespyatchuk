import { formatAmount, formatAmountFull } from "../format";

/** Уніфікований рядок світлофора (команда АБО менеджер). */
export interface TrafficRow {
  id: number;
  name: string;
  plan: number;
  fact: number;
  pctPlan: number | null;
  remaining: number;
  expectedThisMonth: number;
  flowCur: number | null;
  flowPrev: number | null;
}

/** Колір за % виконання плану (токени дашборду): <70 червоний, 70–95 жовтий, ≥95 зелений. */
function planColor(pct: number | null): string {
  if (pct == null) return "var(--text-muted)";
  if (pct < 70) return "#dc2626";
  if (pct < 95) return "#d97706";
  return "#16a34a";
}

/**
 * Р4c.1 — світлофор (рівне-залежний). Рядки — команди АБО менеджери (той самий формат):
 * бар % плану · % · очік. цього місяця · залишок до плану. Найгірші зверху (сорт бекенду).
 * Клік по рядку → дрілл (команда→менеджери / менеджер→звіт менеджера). Δ — like-for-like
 * по датованому потоку. % плану менеджера — нативний план з `plans` (без вигадки; без плану → «—»).
 */
export function TrafficLight({
  title,
  hint,
  rows,
  compareLabel,
  onRowClick,
  clickTitle,
}: {
  title: string;
  hint: string;
  rows: TrafficRow[];
  compareLabel?: string | null;
  onRowClick?: (id: number) => void;
  clickTitle?: (name: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <div className="chart-card">
        <h2 className="chart-title">{title}</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Немає даних за цей період.</p>
      </div>
    );
  }

  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 12 }}>
        {title} <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>· найгірші зверху · {hint}{compareLabel ? ` · Δ: ${compareLabel}` : ""}</span>
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((t) => {
          const color = planColor(t.pctPlan);
          const fill = t.pctPlan == null ? 0 : Math.min(100, Math.max(0, t.pctPlan));
          // Δ — like-for-like по датованому потоку (success), не по received.
          const dprev = t.flowCur != null && t.flowPrev != null ? t.flowCur - t.flowPrev : null;
          const Tag = onRowClick ? "button" : "div";
          return (
            <Tag
              key={t.id}
              onClick={onRowClick ? () => onRowClick(t.id) : undefined}
              title={clickTitle ? clickTitle(t.name) : undefined}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 1.4fr) minmax(80px, 1.8fr) 48px minmax(80px, 0.9fr) minmax(90px, 1fr)",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                borderLeft: `4px solid ${color}`,
                background: "var(--card-bg)",
                color: "var(--text)",
                cursor: onRowClick ? "pointer" : "default",
                textAlign: "left",
                width: "100%",
              }}
            >
              {/* Назва + Δ */}
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                {dprev != null && (
                  <span style={{ fontSize: 11, color: dprev >= 0 ? "#16a34a" : "#dc2626" }}>
                    {dprev >= 0 ? "↑" : "↓"} {formatAmount(Math.abs(dprev))} <span style={{ color: "var(--text-muted)" }}>дат. потік</span>
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

              {/* Очікування цей місяць */}
              <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }} title={`Очікування цього місяця (CRM, planned-date): ${formatAmountFull(t.expectedThisMonth)}`}>
                очік. <span style={{ color: "#b45309", fontWeight: 600 }}>{formatAmount(t.expectedThisMonth)}</span>
              </span>

              {/* Залишок до плану */}
              <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }} title={t.plan > 0 ? `План ${formatAmountFull(t.plan)} · факт ${formatAmountFull(t.fact)}` : "План не заданий"}>
                {t.plan > 0 ? <>залишок <span style={{ color: "var(--text)", fontWeight: 600 }}>{formatAmount(t.remaining)}</span></> : "без плану"}
              </span>
            </Tag>
          );
        })}
      </div>
    </div>
  );
}
