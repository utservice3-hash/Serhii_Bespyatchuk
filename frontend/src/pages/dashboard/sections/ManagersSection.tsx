import type { Dispatch, SetStateAction } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import type { AuthPayload } from "../../../auth";
import type { ManagerBreakdown, PersonalDashboard, Team } from "../../../api";
import { formatAmount } from "../format";
import { STAGE_ORDER, STAGE_LABELS } from "../constants";
import { ForecastBadge } from "../widgets";
import { teamOptions } from "../teamColors";

export function ManagersSection({
  auth,
  teams,
  managerTeamId,
  setManagerTeamId,
  month,
  setMonth,
  managersLoading,
  managerRows,
  selectedManagerId,
  setSelectedManagerId,
  personalLoading,
  personalData,
}: {
  auth: AuthPayload | null;
  teams: Team[];
  managerTeamId: number | "";
  setManagerTeamId: Dispatch<SetStateAction<number | "">>;
  month: string;
  setMonth: Dispatch<SetStateAction<string>>;
  managersLoading: boolean;
  managerRows: ManagerBreakdown[];
  selectedManagerId: number | null;
  setSelectedManagerId: Dispatch<SetStateAction<number | null>>;
  personalLoading: boolean;
  personalData: PersonalDashboard | null;
}) {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{auth?.role === "manager" ? "Мій кабінет" : "Менеджери"}</h1>
        <div className="page-filters">
          {auth?.role !== "manager" && teams.length > 1 && (
            <select
              value={managerTeamId}
              onChange={(e) => setManagerTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Оберіть команду</option>
              {teamOptions(teams)}
            </select>
          )}
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      {auth?.role !== "manager" && (
        managersLoading ? (
          <p className="loading-text">Завантаження...</p>
        ) : managerRows.length === 0 ? (
          <div className="chart-card">
            <p className="loading-text">Немає даних за цей місяць.</p>
          </div>
        ) : (
          <div className="chart-card manager-card">
            <h2 className="chart-title">Команда — світлофор по плану</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Менеджер</th>
                  <th>План</th>
                  <th>Факт</th>
                  <th>Залишок</th>
                  <th title="Гроші на етапі «Виставлено рахунок» — очікують оплати">Очікування</th>
                  <th>Прогноз</th>
                </tr>
              </thead>
              <tbody>
                {managerRows.map((manager) => {
                  const f = manager.forecast ?? { plan: 0, fact: 0, remaining: 0, projected: 0, projectedPct: 0, status: "no_plan" as const };
                  return (
                    <tr
                      key={manager.id}
                      onClick={() => setSelectedManagerId(manager.id)}
                      style={{
                        cursor: "pointer",
                        background: selectedManagerId === manager.id ? "rgba(197,20,28,0.06)" : undefined,
                      }}
                    >
                      <td>{manager.name}</td>
                      <td>{formatAmount(f.plan)}</td>
                      <td>{formatAmount(f.fact)}</td>
                      <td>{formatAmount(f.remaining)}</td>
                      <td style={{ color: "#d97706", fontWeight: 600 }}>{formatAmount(manager.expected)}</td>
                      <td>
                        <ForecastBadge forecast={f} />
                      </td>
                    </tr>
                  );
                })}
                {managerRows.length > 1 && (
                  <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 700 }}>
                    <td>Разом</td>
                    <td>{formatAmount(managerRows.reduce((s, m) => s + (m.forecast?.plan ?? 0), 0))}</td>
                    <td>{formatAmount(managerRows.reduce((s, m) => s + (m.forecast?.fact ?? 0), 0))}</td>
                    <td>{formatAmount(managerRows.reduce((s, m) => s + (m.forecast?.remaining ?? 0), 0))}</td>
                    <td style={{ color: "#d97706" }}>{formatAmount(managerRows.reduce((s, m) => s + m.expected, 0))}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )
      )}

      {auth?.role !== "manager" && !selectedManagerId && (
        <div className="chart-card">
          <p className="loading-text">Оберіть менеджера в таблиці вище, щоб побачити деталі.</p>
        </div>
      )}

      {(auth?.role === "manager" || selectedManagerId) && (
        personalLoading ? (
          <p className="loading-text">Завантаження...</p>
        ) : !personalData ? (
          <div className="chart-card">
            <p className="loading-text">Немає даних за цей місяць.</p>
          </div>
        ) : (
          <>
            <div className="chart-card manager-card">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <h2 className="chart-title" style={{ marginBottom: 0 }}>
                  {personalData.manager.name} — {month}
                </h2>
                <ForecastBadge forecast={personalData.forecast} />
              </div>
              <div className="kpi-grid">
                <div className="kpi-card">
                  <span className="kpi-label">План</span>
                  <span className="kpi-value">{formatAmount(personalData.forecast.plan)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Факт</span>
                  <span className="kpi-value">{formatAmount(personalData.forecast.fact)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Залишилось до плану</span>
                  <span className="kpi-value">{formatAmount(personalData.forecast.remaining)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">
                    Прогноз на кінець місяця ({personalData.daysElapsed}/{personalData.daysInMonth} дн.)
                  </span>
                  <span className="kpi-value">{formatAmount(personalData.forecast.projected)}</span>
                </div>
              </div>
            </div>

            <div className="chart-grid">
              <div className="chart-card">
                <h2 className="chart-title">Декомпозиція воронки за місяць</h2>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={STAGE_ORDER.map((stage) => ({
                      name: STAGE_LABELS[stage],
                      count: personalData!.totals[stage]?.fact ?? 0,
                    }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="count" fill="#c5141c" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-card">
                <h2 className="chart-title">Динаміка по днях (оплати)</h2>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={personalData.daily}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tickFormatter={(d) => d.slice(8, 10)} />
                    <YAxis />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="payment_amount"
                      name="Сума оплат"
                      stroke="#c5141c"
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="chart-card">
              <h2 className="chart-title">Історія за 12 місяців: план vs факт оплат</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={personalData.history}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip formatter={(v) => formatAmount(Number(v))} />
                  <Legend />
                  <Bar dataKey="planPaymentAmount" name="План" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="factPaymentAmount" name="Факт" fill="#c5141c" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )
      )}
    </>
  );
}
