import { useEffect, useMemo, useState } from "react";
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
  createTask,
  deleteTask,
  fetchFunnel,
  fetchLoyalty,
  fetchManagerBreakdown,
  fetchManagerOptions,
  fetchPersonalDashboard,
  fetchReceivables,
  fetchTasks,
  fetchTeams,
  fetchTimeseries,
  updateTask,
  type FunnelStage,
  type LoyaltyManager,
  type ManagerBreakdown,
  type ManagerOption,
  type PersonalDashboard,
  type ReceivableManager,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type Team,
} from "../api";
import { Layout, type NavKey } from "../components/Layout";
import { DateRangeFilter } from "../components/DateRangeFilter";
import { getAuthPayload } from "../auth";

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo_list: "To do list",
  to_realize: "Взяти до реалізації",
  planned: "Заплановано",
  not_started: "Не почато",
  deferred: "Відкладений запит",
  in_progress: "В процесі",
  ball_on_executor: "М'яч на стороні виконавця",
  ready_for_approval: "Готово на затвердження",
  done: "Готово",
};

const STATUS_GROUPS: { label: string; statuses: TaskStatus[] }[] = [
  { label: "To-do", statuses: ["todo_list", "to_realize", "planned", "not_started"] },
  { label: "In progress", statuses: ["deferred", "in_progress", "ball_on_executor"] },
  { label: "Complete", statuses: ["ready_for_approval", "done"] },
];

const STATUS_DOT_COLORS: Record<TaskStatus, string> = {
  todo_list: "#94a3b8",
  to_realize: "#f59e0b",
  planned: "#f59e0b",
  not_started: "#94a3b8",
  deferred: "#f59e0b",
  in_progress: "#eab308",
  ball_on_executor: "#60a5fa",
  ready_for_approval: "#a78bfa",
  done: "#34d399",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Низький",
  medium: "Середній",
  high: "Високий",
};

const STAGE_LABELS: Record<string, string> = {
  lead_taken: "Ліди в роботі",
  quote_requested: "Запит КП",
  approved: "Погоджено",
  invoiced: "Рахунок виставлено",
  paid: "Оплачено",
};

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

function ForecastBadge({ forecast }: { forecast: { status: string; projectedPct: number } }) {
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

export function Dashboard() {
  const auth = useMemo(() => getAuthPayload(), []);
  const [section, setSection] = useState<NavKey>("overview");
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<number | "">("");
  const [granularity, setGranularity] = useState<"day" | "month">("day");
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const [timeseries, setTimeseries] = useState<Record<string, number | string>[]>([]);
  const [loading, setLoading] = useState(true);

  const [managerTeamId, setManagerTeamId] = useState<number | "">("");
  const [month, setMonth] = useState(currentMonth());
  const [managerRows, setManagerRows] = useState<ManagerBreakdown[]>([]);
  const [managersLoading, setManagersLoading] = useState(false);
  const [selectedManagerId, setSelectedManagerId] = useState<number | null>(null);
  const [personalData, setPersonalData] = useState<PersonalDashboard | null>(null);
  const [personalLoading, setPersonalLoading] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [managerOptions, setManagerOptions] = useState<ManagerOption[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  const [loyaltyTeamId, setLoyaltyTeamId] = useState<number | "">("");
  const [loyaltyData, setLoyaltyData] = useState<LoyaltyManager[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);

  const [receivablesTeamId, setReceivablesTeamId] = useState<number | "">("");
  const [receivablesData, setReceivablesData] = useState<ReceivableManager[]>([]);
  const [receivablesSyncedAt, setReceivablesSyncedAt] = useState<string | null>(null);
  const [receivablesLoading, setReceivablesLoading] = useState(false);

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    if (section !== "tasks") return;
    setTasksLoading(true);
    fetchTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setTasksLoading(false));
    fetchManagerOptions().then(setManagerOptions).catch(() => setManagerOptions([]));
  }, [section]);

  function patchTaskLocal(id: number, patch: Partial<Task>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function handleAddTask() {
    const title = newTaskTitle.trim();
    if (!title) return;
    const { id } = await createTask({ title });
    setNewTaskTitle("");
    setTasks((prev) => [
      {
        id,
        title,
        status: "not_started",
        deadline: null,
        assigneeId: null,
        assigneeName: null,
        priority: "medium",
        comments: null,
        department: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ...prev,
    ]);
  }

  async function handleDeleteTask(id: number) {
    await deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  useEffect(() => {
    if (section !== "managers") return;
    if (auth?.role === "manager") return;
    const teamIdToUse = managerTeamId || teams[0]?.id;
    if (!teamIdToUse) return;
    setManagersLoading(true);
    fetchManagerBreakdown({ teamId: teamIdToUse, month })
      .then(setManagerRows)
      .catch(() => setManagerRows([]))
      .finally(() => setManagersLoading(false));
  }, [section, managerTeamId, month, teams, auth]);

  useEffect(() => {
    if (section !== "managers") return;
    const managerIdToLoad = auth?.role === "manager" ? auth.managerId ?? undefined : selectedManagerId ?? undefined;
    if (!managerIdToLoad) {
      setPersonalData(null);
      return;
    }
    setPersonalLoading(true);
    fetchPersonalDashboard({ managerId: managerIdToLoad, month })
      .then(setPersonalData)
      .catch(() => setPersonalData(null))
      .finally(() => setPersonalLoading(false));
  }, [section, selectedManagerId, month, auth]);

  useEffect(() => {
    if (section !== "loyalty") return;
    const teamIdToUse = auth?.role === "manager" ? undefined : loyaltyTeamId || teams[0]?.id;
    const managerIdToUse = auth?.role === "manager" ? auth.managerId ?? undefined : undefined;
    setLoyaltyLoading(true);
    fetchLoyalty({ teamId: teamIdToUse || undefined, managerId: managerIdToUse })
      .then(setLoyaltyData)
      .catch(() => setLoyaltyData([]))
      .finally(() => setLoyaltyLoading(false));
  }, [section, loyaltyTeamId, teams, auth]);

  useEffect(() => {
    if (section !== "receivables") return;
    const teamIdToUse = auth?.role === "manager" ? undefined : receivablesTeamId || teams[0]?.id;
    const managerIdToUse = auth?.role === "manager" ? auth.managerId ?? undefined : undefined;
    setReceivablesLoading(true);
    fetchReceivables({ teamId: teamIdToUse || undefined, managerId: managerIdToUse })
      .then(({ syncedAt, managers }) => {
        setReceivablesData(managers);
        setReceivablesSyncedAt(syncedAt);
      })
      .catch(() => setReceivablesData([]))
      .finally(() => setReceivablesLoading(false));
  }, [section, receivablesTeamId, teams, auth]);

  useEffect(() => {
    setLoading(true);
    const params: Record<string, any> = {};
    if (teamId) params.teamId = teamId;
    if (dateRange.from) params.from = dateRange.from;
    if (dateRange.to) params.to = dateRange.to;

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
  }, [teamId, granularity, dateRange]);

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

              <DateRangeFilter value={dateRange} onChange={setDateRange} />
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
            <h1 className="page-title">{auth?.role === "manager" ? "Мій кабінет" : "Менеджери"}</h1>
            <div className="page-filters">
              {auth?.role !== "manager" && teams.length > 1 && (
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
                      <th>Прогноз</th>
                    </tr>
                  </thead>
                  <tbody>
                    {managerRows.map((manager) => {
                      const f = manager.forecast;
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
                          <td>
                            <ForecastBadge forecast={f} />
                          </td>
                        </tr>
                      );
                    })}
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
      )}

      {section === "loyalty" && (
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
                      <span className="kpi-label">Постійні (3+ за 3 міс.)</span>
                      <span className="kpi-value">{m.loyalCount}</span>
                    </div>
                    <div className="kpi-card">
                      <span className="kpi-label">At risk</span>
                      <span className="kpi-value">{m.atRiskCount}</span>
                    </div>
                  </div>
                  {m.atRiskCount > 0 && (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Клієнт (at risk)</th>
                          <th>Замовлень за 3 міс.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.atRisk.map((c) => (
                          <tr key={c.clientKey}>
                            <td>{c.clientName}</td>
                            <td>{c.orders}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {section === "receivables" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Дебіторська заборгованість</h1>
            <div className="page-filters">
              {auth?.role !== "manager" && (
                <select
                  value={receivablesTeamId}
                  onChange={(e) => setReceivablesTeamId(e.target.value ? Number(e.target.value) : "")}
                >
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              {receivablesSyncedAt && (
                <span className="loading-text" style={{ fontSize: 12 }}>
                  Оновлено: {new Date(receivablesSyncedAt).toLocaleString("uk-UA")}
                </span>
              )}
            </div>
          </div>

          {receivablesLoading ? (
            <p className="loading-text">Завантаження...</p>
          ) : receivablesData.length === 0 ? (
            <p className="loading-text">Немає даних.</p>
          ) : (
            <div className="chart-grid">
              {receivablesData.map((m) => (
                <div className="chart-card" key={m.managerId}>
                  <h2 className="chart-title">{m.managerName}</h2>
                  <div className="kpi-grid">
                    <div className="kpi-card">
                      <span className="kpi-label">Загальний борг</span>
                      <span className="kpi-value">{formatAmount(m.total)}</span>
                    </div>
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Клієнт</th>
                        <th>Заборгованість</th>
                        <th>Лімит днів</th>
                        <th>Макс днів</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.clients.map((c) => (
                        <tr key={c.clientKey}>
                          <td>{c.clientName}</td>
                          <td>{formatAmount(c.amount)}</td>
                          <td>{c.limitDays ?? "—"}</td>
                          <td
                            style={
                              c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays
                                ? { color: "#dc2626", fontWeight: 600 }
                                : undefined
                            }
                          >
                            {c.overdueDays ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {section === "tasks" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Задачник</h1>
            <div className="page-filters">
              <input
                placeholder="Нова задача..."
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTask()}
                style={{ width: 240 }}
              />
              <button className="btn-primary" onClick={handleAddTask}>
                + Додати
              </button>
            </div>
          </div>

          {tasksLoading ? (
            <p className="loading-text">Завантаження...</p>
          ) : (
            <div className="chart-card">
              <table className="data-table tasks-table">
                <colgroup>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "4%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Задачі</th>
                    <th>Статус</th>
                    <th>Дедлайн</th>
                    <th>Виконавець</th>
                    <th>Пріоритет</th>
                    <th>Коментарі</th>
                    <th>Департамент</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="loading-text">
                        Задач немає.
                      </td>
                    </tr>
                  ) : (
                    tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <input
                            value={task.title}
                            onChange={(e) => patchTaskLocal(task.id, { title: e.target.value })}
                            onBlur={(e) => updateTask(task.id, { title: e.target.value })}
                            style={{ border: "none", width: "100%" }}
                          />
                        </td>
                        <td>
                          <div className="task-status-cell">
                            <span
                              className="task-status-dot"
                              style={{ background: STATUS_DOT_COLORS[task.status] }}
                            />
                            <select
                              value={task.status}
                              onChange={(e) => {
                                const status = e.target.value as TaskStatus;
                                patchTaskLocal(task.id, { status });
                                updateTask(task.id, { status });
                              }}
                            >
                              {STATUS_GROUPS.map((group) => (
                                <optgroup key={group.label} label={group.label}>
                                  {group.statuses.map((s) => (
                                    <option key={s} value={s}>
                                      {STATUS_LABELS[s]}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </div>
                        </td>
                        <td>
                          <input
                            type="date"
                            value={task.deadline ?? ""}
                            onChange={(e) => {
                              const deadline = e.target.value || null;
                              patchTaskLocal(task.id, { deadline });
                              updateTask(task.id, { deadline });
                            }}
                          />
                        </td>
                        <td>
                          <select
                            value={task.assigneeId ?? ""}
                            onChange={(e) => {
                              const assigneeId = e.target.value ? Number(e.target.value) : null;
                              const assigneeName =
                                managerOptions.find((m) => m.id === assigneeId)?.name ?? null;
                              patchTaskLocal(task.id, { assigneeId, assigneeName });
                              updateTask(task.id, { assigneeId });
                            }}
                          >
                            <option value="">—</option>
                            {managerOptions.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={task.priority}
                            onChange={(e) => {
                              const priority = e.target.value as TaskPriority;
                              patchTaskLocal(task.id, { priority });
                              updateTask(task.id, { priority });
                            }}
                          >
                            {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            value={task.comments ?? ""}
                            placeholder="—"
                            onChange={(e) => patchTaskLocal(task.id, { comments: e.target.value })}
                            onBlur={(e) => updateTask(task.id, { comments: e.target.value })}
                            style={{ border: "none", width: "100%" }}
                          />
                        </td>
                        <td>
                          <input
                            value={task.department ?? ""}
                            placeholder="—"
                            onChange={(e) => patchTaskLocal(task.id, { department: e.target.value })}
                            onBlur={(e) => updateTask(task.id, { department: e.target.value })}
                            style={{ border: "none", width: "100%" }}
                          />
                        </td>
                        <td>
                          <button
                            onClick={() => handleDeleteTask(task.id)}
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--text-muted)",
                            }}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
