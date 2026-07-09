import { useEffect, useState } from "react";
import { fetchResponseTime, type ResponseTime } from "../../../api";

/** Format minutes as a compact human string (хв / год хв / дн). */
function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min} хв`;
  if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h} год ${m} хв` : `${h} год`;
  }
  const d = Math.floor(min / (60 * 24));
  const h = Math.round((min % (60 * 24)) / 60);
  return h > 0 ? `${d} дн ${h} год` : `${d} дн`;
}

const barColor = (min: number | null) =>
  min == null ? "var(--border)" : min <= 30 ? "#16a34a" : min <= 120 ? "#d97706" : "#dc2626";

/**
 * «Середній час опрацювання заявки» — from a Кваліфікація lead's creation to the
 * moment a manager takes it (стає відповідальним). Split by when the lead arrived:
 * робочий час 9–18, вечір 18–21, ніч 21–9, вихідний — to see if off-hours leads
 * wait longer. Self-fetching; role-scoped on the backend.
 */
export function ResponseTimeCard({
  from,
  to,
  managerId,
  teamId,
}: {
  from: string;
  to: string;
  managerId?: number;
  teamId?: number;
}) {
  const [data, setData] = useState<ResponseTime | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetchResponseTime({ from, to, managerId, teamId })
      .then(setData)
      .catch(() => setData(null));
  }, [from, to, managerId, teamId]);

  if (data === null) return null;
  if (data.totalCount === 0) return null;

  const maxMin = Math.max(1, ...data.buckets.map((b) => b.avgMin ?? 0));

  return (
    <div className="chart-card" style={{ marginBottom: 16, borderLeft: "4px solid #6366f1" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          textAlign: "left",
          color: "var(--text)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="chart-title" style={{ marginBottom: 0 }}>⏱ Середній час опрацювання заявки</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: barColor(data.overallAvgMin), background: "rgba(99,102,241,0.12)", borderRadius: 999, padding: "2px 10px" }}>
            {fmtMin(data.overallAvgMin)}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{data.totalCount} заявок</span>
        </span>
        <span style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          {open ? "Згорнути ▲" : "Показати ▼"}
        </span>
      </button>

      {open && (
        <>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "10px 0" }}>
            Від створення ліда в «Кваліфікації» до моменту, коли менеджер став відповідальним (узяв заявку).
            Розбито за часом надходження заявки (київський час). Ціль — швидка реакція; повільна = втрачений клієнт.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            {data.buckets.map((b) => (
              <div key={b.key} title={b.hint}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{b.label}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {b.count > 0 ? (
                      <>
                        сер. <b style={{ color: barColor(b.avgMin) }}>{fmtMin(b.avgMin)}</b>
                        {" · "}медіана {fmtMin(b.medianMin)}
                        {" · "}{b.count} шт
                      </>
                    ) : (
                      "немає заявок"
                    )}
                  </span>
                </div>
                <div style={{ height: 10, borderRadius: 6, background: "var(--border)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${Math.min(100, ((b.avgMin ?? 0) / maxMin) * 100)}%`,
                      height: "100%",
                      background: barColor(b.avgMin),
                      borderRadius: 6,
                      transition: "width .4s ease",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10 }}>
            🟢 ≤30 хв · 🟡 ≤2 год · 🔴 &gt;2 год. «Медіана» — типова заявка (не спотворена поодинокими довгими).
          </p>
        </>
      )}
    </div>
  );
}
