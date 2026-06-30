import type { Dispatch, SetStateAction } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import type { AuthPayload } from "../../../auth";
import type { LoyaltyManager, LoyaltyDynamics, Team } from "../../../api";
import { formatAmount } from "../format";

export function LoyaltySection({
  auth,
  teams,
  loyaltyTeamId,
  setLoyaltyTeamId,
  loyaltyDynamics,
  loyaltyLoading,
  loyaltyData,
}: {
  auth: AuthPayload | null;
  teams: Team[];
  loyaltyTeamId: number | "";
  setLoyaltyTeamId: Dispatch<SetStateAction<number | "">>;
  loyaltyDynamics: LoyaltyDynamics | null;
  loyaltyLoading: boolean;
  loyaltyData: LoyaltyManager[];
}) {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Постійні клієнти</h1>
        {auth?.role !== "manager" && (
          <div className="page-filters">
            <select
              value={loyaltyTeamId}
              onChange={(e) => setLoyaltyTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loyaltyDynamics && loyaltyDynamics.months.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <h2 className="chart-title">Динаміка повторних оплат (12 міс.)</h2>
          <div className="kpi-grid">
            {(() => {
              const d = loyaltyDynamics;
              const arrow = (v: number) => (v > 0 ? "↑" : v < 0 ? "↓" : "→");
              const color = (v: number) => (v > 0 ? "#16a34a" : v < 0 ? "#dc2626" : "#667085");
              return (
                <>
                  <div className="kpi-card">
                    <span className="kpi-label">Замовлень (міс.)</span>
                    <span className="kpi-value">{d.latestOrders.toLocaleString("uk-UA")}</span>
                    <span style={{ color: color(d.deltaOrders), fontWeight: 600 }}>
                      {arrow(d.deltaOrders)} {Math.abs(d.deltaOrders)}% до попер. міс.
                    </span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">Сума (міс.)</span>
                    <span className="kpi-value">{formatAmount(d.latestAmount)}</span>
                    <span style={{ color: color(d.deltaAmount), fontWeight: 600 }}>
                      {arrow(d.deltaAmount)} {Math.abs(d.deltaAmount)}% до попер. міс.
                    </span>
                  </div>
                </>
              );
            })()}
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={loyaltyDynamics.months}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis yAxisId="left" orientation="left" />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
              <Tooltip
                formatter={(value, name) =>
                  name === "Сума"
                    ? formatAmount(Number(value))
                    : Number(value).toLocaleString("uk-UA")
                }
              />
              <Legend />
              <Bar yAxisId="left" dataKey="orders" name="Замовлень" fill="#60a5fa" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="right" dataKey="amount" name="Сума" fill="#c5141c" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {loyaltyLoading ? (
        <p className="loading-text">Завантаження...</p>
      ) : loyaltyData.length === 0 ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <div className="chart-grid">
          {loyaltyData.map((m) => (
            <div className="chart-card" key={m.managerId}>
              <h2 className="chart-title">{m.managerName}</h2>
              <div className="kpi-grid">
                <div className="kpi-card">
                  <span className="kpi-label">Постійні (2+ за 2 міс.)</span>
                  <span className="kpi-value">{m.regularCount}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Разові (1 за 2 міс.)</span>
                  <span className="kpi-value">{m.occasionalCount}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Сплячі (реактивація)</span>
                  <span className="kpi-value">{m.sleepingCount}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Втрачені (&gt;6 міс.)</span>
                  <span className="kpi-value">{m.lostCount}</span>
                </div>
              </div>

              {([
                { key: "regular", label: "Постійні клієнти", list: m.segments.regular },
                { key: "sleeping", label: "Сплячі — кандидати на реактивацію", list: m.segments.sleeping },
                { key: "lost", label: "Втрачені — давно не замовляли", list: m.segments.lost },
              ] as const).map(
                (group) =>
                  group.list.length > 0 && (
                    <details key={group.key} style={{ marginTop: 12 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                        {group.label} ({group.list.length})
                      </summary>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Клієнт</th>
                            <th>За 2 міс.</th>
                            <th>Всього оплат</th>
                            <th>Остання оплата</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.list.slice(0, 100).map((c) => (
                            <tr key={c.clientKey}>
                              <td>{c.clientName}</td>
                              <td>{c.orders}</td>
                              <td>{c.totalPaid}</td>
                              <td>
                                {c.lastPaid
                                  ? new Date(c.lastPaid).toLocaleDateString("uk-UA")
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
