import { useEffect, useState } from "react";
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
import {
  fetchFunnel,
  fetchManagerBreakdown,
  fetchTeams,
  fetchTimeseries,
  type FunnelStage,
  type ManagerBreakdown,
  type Team,
} from "../api";
import { Layout, type NavKey } from "../components/Layout";

const STAGE_LABELS: Record<string, string> = {
  lead_taken: "Ліди в роботі",
  quote_requested: "Запит КП",
  approved: "Погоджено",
  invoiced: "Рахунок виставлено",
  paid: "Оплачено",
};

const METRIC_LABELS: Record<string, string> = {
  ...STAGE_LABELS,
  payment_amount: "Сума оплат, ₴",
};

const METRIC_ORDER = ["lead_taken", "quote_requested", "approved", "invoiced", "paid", "payment_amount"];

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

const STAGE_COLORS: Record<string, string> = {
  lead_taken: "#94a3b8",
  quote_requested: "#60a5fa",
  approved: "#34d399",
  invoiced: "#fbbf24",
  paid: "#c5141c",
};

const STAGE_ORDER = Object.keys(STAGE_LABELS);

function formatAmount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}М ₴`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}тис ₴`;
  return `${value.toFixed(0)} ₴`;
}

export function Dashboard() {
  const [section, setSection] = useState<NavKey>("overview");
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<number | "">("");
  const [granularity, setGranularity] = useState<"day" | "month">("day");
  const [timeseries, setTimeseries] = useState<Record<string, number | string>[]>([]);
  const [loading, setLoading] = useState(true);

  const [managerTeamId, setManagerTeamId] = useState<number | "">("");
  const [month, setMonth] = useState(currentMonth());
  const [managerRows, setManagerRows] = useState<ManagerBreakdown[]>([]);
  const [managersLoading, setManagersLoading] = useState(false);

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    if (section !== "managers") return;
    if (!managerTeamId && teams.length > 1) {
      // Admin viewing without picking a team yet — nothing to load.
      setManagerRows([]);
      return;
    }
    const teamIdToUse = managerTeamId || teams[0]?.id;
    if (!teamIdToUse) return;
    setManagersLoading(true);
    fetchManagerBreakdown({ teamId: teamIdToUse, month })
      .then(setManagerRows)
      .catch(() => setManagerRows([]))
      .finally(() => setManagersLoading(false));
  }, [section, managerTeamId, month, teams]);

  useEffect(() => {
    setLoading(true);
    const params = teamId ? { teamId } : {};

    Promise.all([
      fetchFunnel(params),
      fetchTimeseries({ granularity, ...params }),
    ])
      .then(([funnelData, points]) => {
        setStages(funnelData);

        const byPeriod = new Map<string, Record<string, number | string>>();
        for (const point of points) {
          const label = new Date(point.period).toLocaleDateString("uk-UA", {
            day: granularity === "day" ? "2-digit" : undefined,
            month: "2-digit",
            year: granularity === "month" ? "numeric" : "2-digit",
          });
          const row = byPeriod.get(point.period) ?? { period: label };
          row[point.funnel_stage] = Number(point.deal_count);
          byPeriod.set(point.period, row);
        }
        setTimeseries(
          Array.from(byPeriod.entries())
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([, row]) => row)
        );
      })
      .finally(() => setLoading(false));
  }, [teamId, granularity]);

  const chartData = stages.map((s) => ({
    name: STAGE_LABELS[s.funnel_stage] ?? s.funnel_stage,
    count: Number(s.deal_count),
    amount: Number(s.total_amount),
  }));

  const totalDeals = chartData.reduce((sum, s) => sum + s.count, 0);
  const totalAmount = chartData.reduce((sum, s) => sum + s.amount, 0);
  const leadTaken = chartData.find((s) => s.name === STAGE_LABELS.lead_taken)?.count ?? 0;
  const paid = chartData.find((s) => s.name === STAGE_LABELS.paid)?.count ?? 0;
  const conversion = leadTaken > 0 ? Math.round((paid / leadTaken) * 100) : 0;
  const avgDeal = totalDeals > 0 ? totalAmount / totalDeals : 0;

  const kpis = [
    { label: "Угоди", value: totalDeals.toLocaleString("uk-UA") },
    { label: "Сума", value: formatAmount(totalAmount) },
    { label: "Конверсія", value: `${conversion}%` },
    { label: "Середній чек", value: formatAmount(avgDeal) },
  ];

  return (
    <Layout active={section} onSelect={setSection}>
      {section === "overview" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Огляд продажів</h1>
            <div className="page-filters">
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Усі команди</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>

              <select value={granularity} onChange={(e) => setGranularity(e.target.value as "day" | "month")}>
                <option value="day">По днях</option>
                <option value="month">По місяцях</option>
              </select>
            </div>
          </div>

          <div className="kpi-grid">
            {kpis.map((kpi) => (
              <div className="kpi-card" key={kpi.label}>
                <span className="kpi-label">{kpi.label}</span>
                <span className="kpi-value">{kpi.value}</span>
              </div>
            ))}
          </div>

          {loading ? (
            <p className="loading-text">Завантаження...</p>
          ) : (
            <div className="chart-grid">
              <div className="chart-card">
                <h2 className="chart-title">Воронка продажів</h2>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="count" fill="#c5141c" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-card">
                <h2 className="chart-title">Динаміка по етапах</h2>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={timeseries}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="period" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    {STAGE_ORDER.map((stage) => (
                      <Line
                        key={stage}
                        type="monotone"
                        dataKey={stage}
                        name={STAGE_LABELS[stage]}
                        stroke={STAGE_COLORS[stage]}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}

      {section === "teams" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Команди</h1>
          </div>
          <div className="chart-card">
            {teams.length === 0 ? (
              <p className="loading-text">Команди не знайдено.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Команда</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {section === "managers" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Менеджери</h1>
            <div className="page-filters">
              {teams.length > 1 && (
                <select
                  value={managerTeamId}
                  onChange={(e) => setManagerTeamId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">Оберіть команду</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
          </div>

          {managersLoading ? (
            <p className="loading-text">Завантаження...</p>
          ) : managerRows.length === 0 ? (
            <div className="chart-card">
              <p className="loading-text">
                {teams.length > 1 && !managerTeamId
                  ? "Оберіть команду, щоб побачити дані."
                  : "Немає даних за цей місяць."}
              </p>
            </div>
          ) : (
            managerRows.map((manager) => (
              <div className="chart-card manager-card" key={manager.id}>
                <h2 className="chart-title">{manager.name}</h2>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Показник</th>
                      <th>План</th>
                      <th>Факт</th>
                      <th>% виконання</th>
                    </tr>
                  </thead>
                  <tbody>
                    {METRIC_ORDER.map((metric) => {
                      const totals = manager.totals[metric] ?? { plan: 0, fact: 0 };
                      const pct = totals.plan > 0 ? Math.round((totals.fact / totals.plan) * 100) : 0;
                      const isAmount = metric === "payment_amount";
                      return (
                        <tr key={metric}>
                          <td>{METRIC_LABELS[metric] ?? metric}</td>
                          <td>{isAmount ? formatAmount(totals.plan) : totals.plan}</td>
                          <td>{isAmount ? formatAmount(totals.fact) : totals.fact}</td>
                          <td>{totals.plan > 0 ? `${pct}%` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </>
      )}
    </Layout>
  );
}
