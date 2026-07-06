import { useState, type Dispatch, type SetStateAction } from "react";
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
import { fetchRegularClients, type LoyaltyManager, type LoyaltyDynamics, type RegularClient, type Team } from "../../../api";
import { formatAmount } from "../format";
import { RepeatPlanGrid } from "./RepeatPlanGrid";

/** Badge distinguishing a company regular (🏢, by name) from an individual
 * (👤, identified by phone) — so the list reads unambiguously and de-duped. */
function ClientType({ isCompany, identifier }: { isCompany: boolean; identifier: string | null }) {
  if (isCompany) {
    return <span style={{ fontSize: 12, color: "var(--text-muted)" }}>🏢 Компанія</span>;
  }
  return (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
      👤 Фізособа{identifier ? ` · ${identifier}` : ""}
    </span>
  );
}

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
  const [allClients, setAllClients] = useState<RegularClient[] | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [sortBy, setSortBy] = useState<"revenue" | "orders">("revenue");
  const toggleAll = () => {
    const next = !allOpen;
    setAllOpen(next);
    if (next && allClients === null) {
      fetchRegularClients().then(setAllClients).catch(() => setAllClients([]));
    }
  };
  const sortedAll = allClients
    ? [...allClients].sort((a, b) => (sortBy === "revenue" ? b.revenue - a.revenue : b.orders - a.orders))
    : [];
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

      {auth && (
        <RepeatPlanGrid canPickTeam={auth.role === "admin"} teams={teams} role={auth.role} />
      )}

      {auth?.role !== "manager" && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <button
              onClick={toggleAll}
              style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "var(--text)" }}
            >
              {allOpen ? "▾" : "▸"} Усі постійні клієнти (усі команди)
            </button>
            {allOpen && allClients && allClients.length > 0 && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <span style={{ color: "var(--text-muted)" }}>Сортувати:</span>
                <button onClick={() => setSortBy("revenue")} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border)", background: sortBy === "revenue" ? "#c5141c" : "var(--card-bg)", color: sortBy === "revenue" ? "#fff" : "var(--text)", cursor: "pointer" }}>за сумою</button>
                <button onClick={() => setSortBy("orders")} style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border)", background: sortBy === "orders" ? "#c5141c" : "var(--card-bg)", color: sortBy === "orders" ? "#fff" : "var(--text)", cursor: "pointer" }}>за к-стю</button>
              </div>
            )}
          </div>
          {allOpen && (
            allClients === null ? (
              <p className="loading-text">Завантаження…</p>
            ) : allClients.length === 0 ? (
              <p className="loading-text">Немає даних.</p>
            ) : (
              <table className="data-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr><th>#</th><th>Клієнт</th><th>Тип</th><th>Замовлень (рахунків)</th><th>Сума (lifetime)</th><th>Остання оплата</th></tr>
                </thead>
                <tbody>
                  {sortedAll.map((c, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{c.clientName}</td>
                      <td><ClientType isCompany={c.isCompany} identifier={c.identifier} /></td>
                      <td>{c.orders}</td>
                      <td style={{ fontWeight: 600 }}>{formatAmount(c.revenue)}</td>
                      <td>{c.lastPaid ? new Date(c.lastPaid).toLocaleDateString("uk-UA") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}

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
                            <th>Тип</th>
                            <th>За 2 міс.</th>
                            <th>Всього оплат</th>
                            <th>Остання оплата</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.list.slice(0, 100).map((c) => (
                            <tr key={c.clientKey}>
                              <td>{c.clientName}</td>
                              <td><ClientType isCompany={c.isCompany} identifier={c.identifier} /></td>
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
