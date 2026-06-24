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
import { fetchFunnel, fetchTeams, fetchTimeseries, type FunnelStage, type Team } from "../api";
import { Layout } from "../components/Layout";

const STAGE_LABELS: Record<string, string> = {
  lead_taken: "Ліди в роботі",
  quote_requested: "Запит КП",
  approved: "Погоджено",
  invoiced: "Рахунок виставлено",
  paid: "Оплачено",
};

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
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<number | "">("");
  const [granularity, setGranularity] = useState<"day" | "month">("day");
  const [timeseries, setTimeseries] = useState<Record<string, number | string>[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

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
    <Layout>
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
    </Layout>
  );
}
