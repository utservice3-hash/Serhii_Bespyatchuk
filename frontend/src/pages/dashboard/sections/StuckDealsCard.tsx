import { useEffect, useState } from "react";
import { fetchStuckDeals, type StuckDeal } from "../../../api";
import { formatAmount } from "../format";

const stageColor: Record<string, string> = {
  "Авто працює": "#d97706",
  "Виставлено рахунок": "#dc2626",
  "Взято в роботу": "#667085",
};

/** "Застряглі угоди" — active deals not moving for a while. Manager sees their
 *  own; team-lead/КВП see the picked manager or their whole scope. */
export function StuckDealsCard({ managerId, teamId }: { managerId?: number; teamId?: number }) {
  const [deals, setDeals] = useState<StuckDeal[] | null>(null);
  const [minDays] = useState(7);
  const [open, setOpen] = useState(false); // collapsed by default — table is noisy

  useEffect(() => {
    fetchStuckDeals({ managerId, teamId, minDays })
      .then((r) => setDeals(r.deals))
      .catch(() => setDeals([]));
  }, [managerId, teamId, minDays]);

  if (deals === null) return null; // silent until loaded
  if (deals.length === 0) return null; // nothing stuck — no clutter

  const dayColor = (d: number) => (d >= 30 ? "#dc2626" : d >= 14 ? "#d97706" : "#eab308");
  const urgent = deals.filter((d) => d.days >= 30).length;

  return (
    <div className="chart-card" style={{ marginBottom: 16, borderLeft: "4px solid #d97706" }}>
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
          <span className="chart-title" style={{ marginBottom: 0 }}>⏳ Застряглі угоди</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#d97706", background: "rgba(217,119,6,0.12)", borderRadius: 999, padding: "2px 10px" }}>
            {deals.length}
          </span>
          {urgent > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "#dc2626" }}>
              з них {urgent} &gt; 30 дн.
            </span>
          )}
        </span>
        <span style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          {open ? "Згорнути ▲" : "Показати ▼"}
        </span>
      </button>

      {open && (
        <>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "10px 0" }}>
            Активні угоди без руху: «Авто працює»/«Рахунок» ≥ {minDays} дн., «Взято в роботу» ≥ {minDays * 3} дн. Найдовші — вгорі.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th>Днів без руху</th>
                  <th>Етап</th>
                  <th>Угода</th>
                  <th>Клієнт</th>
                  <th>Менеджер</th>
                  <th>Сума</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.kommoId}>
                    <td style={{ fontWeight: 700, color: dayColor(d.days), whiteSpace: "nowrap" }}>{d.days} дн.</td>
                    <td><span style={{ fontSize: 12, fontWeight: 600, color: stageColor[d.stage] ?? "var(--text)" }}>{d.stage}</span></td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.name}>{d.name || "—"}</td>
                    <td>{d.client || "—"}</td>
                    <td style={{ color: "var(--text-muted)" }}>{d.manager}</td>
                    <td style={{ fontWeight: 600 }}>{formatAmount(d.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
