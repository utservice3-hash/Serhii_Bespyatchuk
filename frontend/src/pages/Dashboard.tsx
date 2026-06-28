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
  fetchConversion,
  fetchFunnel,
  fetchOverview,
  fetchLeadgen,
  fetchLoyalty,
  fetchSettings,
  saveSettings,
  fetchChatUsers,
  fetchConversation,
  sendMessage,
  fetchNews,
  addNews,
  deleteNews,
  fetchKmPrices,
  saveKmPrices,
  uploadFile,
  type NewsItem,
  type KmPrices,
  type ChatUser,
  type ChatMessage,
  fetchUsers as fetchDashboardUsers,
  provisionUsers,
  resetUserPassword,
  updateUser,
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
  type ConversionChannel,
  type ExecutiveOverview,
  type LeadgenGroup,
  type LoyaltyDynamics,
  type AppSettings,
  type DashboardUser,
  type ReceivableManager,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type Team,
} from "../api";
import { Layout, NAV_ITEMS, type NavKey } from "../components/Layout";
import { DateRangeFilter, QuickPeriods, getDateRange } from "../components/DateRangeFilter";
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

/** The equal-length period immediately before [from, to]. */
function previousRange(from: string, to: string): { from: string; to: string } {
  const f = new Date(from);
  const t = new Date(to);
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const prevTo = new Date(f);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - days + 1);
  return {
    from: prevFrom.toISOString().split("T")[0],
    to: prevTo.toISOString().split("T")[0],
  };
}

// Automatic rank ladder by current-month paid revenue (₴). Badges escalate as
// a manager hits each threshold; brand-new managers start as "духи".
function getRank(revenue: number): { emoji: string; title: string } {
  if (revenue >= 300000) return { emoji: "👑", title: "Король" };
  if (revenue >= 200000) return { emoji: "🔥", title: "Профі" };
  if (revenue >= 100000) return { emoji: "⭐", title: "Боєць" };
  return { emoji: "👻", title: "Дух" };
}

function presence(lastSeen: string | null): { online: boolean; label: string } {
  if (!lastSeen) return { online: false, label: "не заходив" };
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  if (diffMs < 2 * 60 * 1000) return { online: true, label: "в мережі" };
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return { online: false, label: `був ${mins} хв тому` };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { online: false, label: `був ${hours} год тому` };
  return { online: false, label: `був ${new Date(lastSeen).toLocaleDateString("uk-UA")}` };
}

const STAT_CHARTS = [
  { key: "stages", title: "Динаміка по етапах" },
  { key: "revenue", title: "Динаміка виручки (оплачено)" },
  { key: "count", title: "Динаміка кількості оплат" },
  { key: "avgcheck", title: "Динаміка середнього чека" },
];

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
  // Persist the open section so a page refresh (Ctrl+R) keeps you in place.
  const [section, setSection] = useState<NavKey>(() => {
    const saved = localStorage.getItem("section") as NavKey | null;
    return saved && NAV_ITEMS.some((i) => i.key === saved) ? saved : "overview";
  });
  useEffect(() => {
    localStorage.setItem("section", section);
  }, [section]);
  const [navHistory, setNavHistory] = useState<NavKey[]>([]);
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<number | "">("");
  const [granularity, setGranularity] = useState<"day" | "week" | "month">("day");
  // Default view is the current month so a fresh load shows the monthly picture.
  const [dateRange, setDateRange] = useState(() => getDateRange("thisMonth"));
  const [datePreset, setDatePreset] = useState<string | null>("thisMonth");
  const [conversionChannels, setConversionChannels] = useState<ConversionChannel[]>([]);
  const [paidDynamics, setPaidDynamics] = useState<
    { period: string; revenue: number; paidCount: number; avgCheck: number }[]
  >([]);
  const [zoomChart, setZoomChart] = useState<string | null>(null);
  const [overview, setOverview] = useState<ExecutiveOverview | null>(null);
  const [prevStages, setPrevStages] = useState<FunnelStage[]>([]);
  const [prevOverview, setPrevOverview] = useState<ExecutiveOverview | null>(null);
  const [kpiDetail, setKpiDetail] = useState<string | null>(null);
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
  const [loyaltyDynamics, setLoyaltyDynamics] = useState<LoyaltyDynamics | null>(null);

  const [receivablesTeamId, setReceivablesTeamId] = useState<number | "">("");
  const [receivablesData, setReceivablesData] = useState<ReceivableManager[]>([]);
  const [receivablesSyncedAt, setReceivablesSyncedAt] = useState<string | null>(null);
  const [receivablesLoading, setReceivablesLoading] = useState(false);

  const [leadgenTeamId, setLeadgenTeamId] = useState<number | "">("");
  const [leadgenData, setLeadgenData] = useState<LeadgenGroup[]>([]);
  const [leadgenLoading, setLeadgenLoading] = useState(false);

  const [settingsForm, setSettingsForm] = useState<AppSettings | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [provisionMsg, setProvisionMsg] = useState<string | null>(null);

  const [chatUsers, setChatUsers] = useState<ChatUser[]>([]);
  const [chatActive, setChatActive] = useState<ChatUser | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

  const [newsCategory, setNewsCategory] = useState<"company" | "logistics" | "sales">("company");
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [kmPrices, setKmPrices] = useState<KmPrices | null>(null);
  const [newsForm, setNewsForm] = useState<{ title: string; body: string; imageUrl?: string }>({ title: "", body: "" });
  const [kmForm, setKmForm] = useState({ t20: "", t10: "", t5: "", t2: "" });

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
      .then(({ managers, dynamics }) => {
        setLoyaltyData(managers);
        setLoyaltyDynamics(dynamics);
      })
      .catch(() => {
        setLoyaltyData([]);
        setLoyaltyDynamics(null);
      })
      .finally(() => setLoyaltyLoading(false));
  }, [section, loyaltyTeamId, teams, auth]);

  useEffect(() => {
    if (section !== "receivables") return;
    // Default to all teams (no filter) unless a specific team is picked.
    const teamIdToUse = auth?.role === "manager" ? undefined : receivablesTeamId || undefined;
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
    if (section !== "messenger") return;
    fetchChatUsers().then(setChatUsers).catch(() => setChatUsers([]));
  }, [section]);

  useEffect(() => {
    if (section !== "messenger" || !chatActive) return;
    let stop = false;
    const load = () =>
      fetchConversation(chatActive.id)
        .then((m) => {
          if (!stop) setChatMessages(m);
        })
        .catch(() => {});
    load();
    const interval = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(interval);
    };
  }, [section, chatActive]);

  async function handleSendMessage() {
    const body = chatInput.trim();
    if (!body || !chatActive) return;
    setChatInput("");
    const msg = await sendMessage(chatActive.id, body);
    setChatMessages((prev) => [...prev, msg]);
  }

  async function handleSendFile(file: File) {
    if (!chatActive) return;
    const up = await uploadFile(file);
    const msg = await sendMessage(chatActive.id, "", up);
    setChatMessages((prev) => [...prev, msg]);
  }

  useEffect(() => {
    if (section !== "news") return;
    fetchNews(newsCategory).then(setNewsItems).catch(() => setNewsItems([]));
  }, [section, newsCategory]);

  useEffect(() => {
    if (section !== "news") return;
    fetchKmPrices()
      .then((p) => {
        setKmPrices(p);
        if (p) setKmForm({ t20: String(p.t20 ?? ""), t10: String(p.t10 ?? ""), t5: String(p.t5 ?? ""), t2: String(p.t2 ?? "") });
      })
      .catch(() => setKmPrices(null));
  }, [section]);

  async function handleAddNews() {
    if (!newsForm.title.trim()) return;
    await addNews({ category: newsCategory, title: newsForm.title, body: newsForm.body, imageUrl: newsForm.imageUrl });
    setNewsForm({ title: "", body: "" });
    setNewsItems(await fetchNews(newsCategory));
  }

  async function handleSaveKm() {
    await saveKmPrices({
      t20: kmForm.t20 ? Number(kmForm.t20) : null,
      t10: kmForm.t10 ? Number(kmForm.t10) : null,
      t5: kmForm.t5 ? Number(kmForm.t5) : null,
      t2: kmForm.t2 ? Number(kmForm.t2) : null,
    });
    setKmPrices(await fetchKmPrices());
  }

  useEffect(() => {
    if (section !== "settings") return;
    fetchSettings().then(setSettingsForm).catch(() => setSettingsForm(null));
    if (auth?.role === "admin") {
      fetchDashboardUsers().then(setUsers).catch(() => setUsers([]));
    }
  }, [section, auth]);

  async function reloadUsers() {
    try {
      setUsers(await fetchDashboardUsers());
    } catch {
      setUsers([]);
    }
  }

  async function handleProvision() {
    const created = await provisionUsers();
    setProvisionMsg(
      created.length
        ? `Створено логінів: ${created.length}`
        : "Нових користувачів немає — усі вже створені"
    );
    await reloadUsers();
  }

  async function handleResetPassword(id: number) {
    const password = await resetUserPassword(id);
    setRevealed((r) => ({ ...r, [id]: password }));
  }

  async function handleToggleRole(u: DashboardUser) {
    await updateUser(u.id, { role: u.role === "team_lead" ? "manager" : "team_lead" });
    await reloadUsers();
  }

  async function handleToggleActive(u: DashboardUser) {
    await updateUser(u.id, { isActive: !u.is_active });
    await reloadUsers();
  }

  async function handleSaveSettings() {
    if (!settingsForm) return;
    setSettingsSaving(true);
    setSettingsSaved(false);
    try {
      await saveSettings(settingsForm);
      setSettingsSaved(true);
    } finally {
      setSettingsSaving(false);
    }
  }

  useEffect(() => {
    if (section !== "leadgen") return;
    const teamIdToUse = auth?.role === "manager" ? undefined : leadgenTeamId || undefined;
    const managerIdToUse = auth?.role === "manager" ? auth.managerId ?? undefined : undefined;
    setLeadgenLoading(true);
    fetchLeadgen({
      teamId: teamIdToUse || undefined,
      managerId: managerIdToUse,
      from: dateRange.from || undefined,
      to: dateRange.to || undefined,
    })
      .then(setLeadgenData)
      .catch(() => setLeadgenData([]))
      .finally(() => setLeadgenLoading(false));
  }, [section, leadgenTeamId, auth, dateRange]);

  useEffect(() => {
    setLoading(true);
    const params: Record<string, any> = {};
    if (teamId) params.teamId = teamId;
    if (dateRange.from) params.from = dateRange.from;
    if (dateRange.to) params.to = dateRange.to;

    fetchConversion(params)
      .then(setConversionChannels)
      .catch(() => setConversionChannels([]));

    fetchOverview(params)
      .then(setOverview)
      .catch(() => setOverview(null));

    // Same metrics for the immediately-preceding period of equal length, to
    // show growth/decline deltas on the KPI cards.
    const prev =
      dateRange.from && dateRange.to ? previousRange(dateRange.from, dateRange.to) : null;
    if (prev) {
      const prevParams = { ...params, from: prev.from, to: prev.to };
      fetchFunnel(prevParams).then(setPrevStages).catch(() => setPrevStages([]));
      fetchOverview(prevParams).then(setPrevOverview).catch(() => setPrevOverview(null));
    } else {
      setPrevStages([]);
      setPrevOverview(null);
    }

    Promise.all([
      fetchFunnel(params),
      fetchTimeseries({ granularity, ...params }),
    ])
      .then(([funnelData, points]) => {
        setStages(funnelData);

        const byPeriod = new Map<string, Record<string, number | string>>();
        // Parallel series of paid-deal metrics (revenue, count, avg check).
        const paidByPeriod = new Map<
          string,
          { period: string; sort: string; revenue: number; paidCount: number }
        >();
        for (const point of points) {
          const label = new Date(point.period).toLocaleDateString("uk-UA", {
            day: granularity === "month" ? undefined : "2-digit",
            month: "2-digit",
            year: granularity === "month" ? "numeric" : "2-digit",
          });
          const row = byPeriod.get(point.period) ?? { period: label };
          row[point.funnel_stage] = Number(point.deal_count);
          byPeriod.set(point.period, row);

          if (point.funnel_stage === "paid") {
            paidByPeriod.set(point.period, {
              period: label,
              sort: point.period,
              revenue: Number(point.total_amount),
              paidCount: Number(point.deal_count),
            });
          }
        }
        setTimeseries(
          Array.from(byPeriod.entries())
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([, row]) => row)
        );
        setPaidDynamics(
          Array.from(paidByPeriod.values())
            .sort((a, b) => (a.sort < b.sort ? -1 : 1))
            .map((p) => ({
              period: p.period,
              revenue: p.revenue,
              paidCount: p.paidCount,
              avgCheck: p.paidCount > 0 ? Math.round(p.revenue / p.paidCount) : 0,
            }))
        );
      })
      .finally(() => setLoading(false));
  }, [teamId, granularity, dateRange]);

  // Order the funnel stages by their real pipeline sequence, not by whatever
  // order the SQL GROUP BY returned them in.
  const chartData = [...stages]
    .sort((a, b) => STAGE_ORDER.indexOf(a.funnel_stage) - STAGE_ORDER.indexOf(b.funnel_stage))
    .map((s) => ({
      name: STAGE_LABELS[s.funnel_stage] ?? s.funnel_stage,
      count: Number(s.deal_count),
      amount: Number(s.total_amount),
    }));

  function renderStatChart(key: string, height: number) {
    if (key === "stages") {
      return (
        <ResponsiveContainer width="100%" height={height}>
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
      );
    }
    if (key === "revenue") {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={paidDynamics}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="period" />
            <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <Tooltip formatter={(v) => formatAmount(Number(v))} />
            <Bar dataKey="revenue" name="Виручка" fill="#c5141c" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      );
    }
    if (key === "count") {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={paidDynamics}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="period" />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="paidCount" name="Оплачено угод" stroke="#16a34a" connectNulls />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    // avgcheck
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={paidDynamics}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="period" />
          <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
          <Tooltip formatter={(v) => formatAmount(Number(v))} />
          <Line type="monotone" dataKey="avgCheck" name="Середній чек" stroke="#7c3aed" connectNulls />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const totalDeals = chartData.reduce((sum, s) => sum + s.count, 0);
  const paidStage = chartData.find((s) => s.name === STAGE_LABELS.paid);
  const paid = paidStage?.count ?? 0;
  const paidAmount = paidStage?.amount ?? 0;
  // Each deal sits in exactly one funnel stage (current status snapshot), so
  // conversion is the share of all deals that reached payment.
  const conversion = totalDeals > 0 ? Math.round((paid / totalDeals) * 100) : 0;
  // Average check = revenue per actually-paid deal, not per lead in the funnel.
  const avgDeal = paid > 0 ? paidAmount / paid : 0;

  // Previous-period equivalents (for growth deltas + drill-down details).
  const prevChart = [...prevStages].map((s) => ({
    name: STAGE_LABELS[s.funnel_stage] ?? s.funnel_stage,
    count: Number(s.deal_count),
    amount: Number(s.total_amount),
  }));
  const prevDeals = prevChart.reduce((s, x) => s + x.count, 0);
  const prevPaidStage = prevChart.find((s) => s.name === STAGE_LABELS.paid);
  const prevPaid = prevPaidStage?.count ?? 0;
  const prevConversion = prevDeals > 0 ? Math.round((prevPaid / prevDeals) * 100) : 0;
  const prevAvg = prevPaid > 0 ? (prevPaidStage?.amount ?? 0) / prevPaid : 0;

  const kpis = [
    { key: "deals", label: "Угоди", value: totalDeals.toLocaleString("uk-UA"), cur: totalDeals, prev: prevDeals },
    { key: "sum", label: "Отримані кошти (закрито)", value: formatAmount(overview?.closedRevenue ?? 0), cur: overview?.closedRevenue ?? 0, prev: prevOverview?.closedRevenue ?? 0 },
    { key: "conv", label: "Конверсія", value: `${conversion}%`, cur: conversion, prev: prevConversion, unit: "%" },
    { key: "avg", label: "Середній чек", value: formatAmount(avgDeal), cur: avgDeal, prev: prevAvg },
    { key: "newc", label: "Нові клієнти", value: (overview?.newClients ?? 0).toLocaleString("uk-UA"), cur: overview?.newClients ?? 0, prev: prevOverview?.newClients ?? 0 },
    { key: "repc", label: "Повторні клієнти", value: (overview?.repeatClients ?? 0).toLocaleString("uk-UA"), cur: overview?.repeatClients ?? 0, prev: prevOverview?.repeatClients ?? 0 },
  ];

  function navigateTo(next: NavKey) {
    if (next === section) return;
    setNavHistory((h) => [...h, section]);
    setSection(next);
  }

  function goBack() {
    // Within the managers section, first step out of a manager's drill-down.
    if (section === "managers" && selectedManagerId) {
      setSelectedManagerId(null);
      return;
    }
    setNavHistory((h) => {
      if (h.length === 0) return h;
      setSection(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  const canGoBack = navHistory.length > 0 || (section === "managers" && !!selectedManagerId);

  return (
    <Layout
      active={section}
      onSelect={navigateTo}
      onBack={canGoBack ? goBack : undefined}
    >
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

              <select value={granularity} onChange={(e) => setGranularity(e.target.value as "day" | "week" | "month")}>
                <option value="day">По днях</option>
                <option value="week">По тижнях</option>
                <option value="month">По місяцях</option>
              </select>

              <DateRangeFilter
                value={dateRange}
                onChange={(r) => {
                  setDateRange(r);
                  setDatePreset(null);
                }}
              />
            </div>
          </div>

          <QuickPeriods
            active={datePreset}
            onSelect={(id, range) => {
              setDatePreset(id);
              setDateRange(range);
            }}
          />

          <div className="kpi-grid">
            {kpis.map((kpi) => {
              const hasPrev = prevStages.length > 0 || prevOverview !== null;
              const diff = kpi.cur - kpi.prev;
              const pct = kpi.prev > 0 ? Math.round((diff / kpi.prev) * 100) : kpi.cur > 0 ? 100 : 0;
              const color = diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : "#667085";
              const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
              return (
                <button
                  className="kpi-card"
                  key={kpi.key}
                  onClick={() => setKpiDetail(kpi.key)}
                  style={{ textAlign: "left", border: "none", cursor: "pointer", background: "var(--card-bg)" }}
                  title="Натисніть для деталей"
                >
                  <span className="kpi-label">{kpi.label}</span>
                  <span className="kpi-value">{kpi.value}</span>
                  {hasPrev && (
                    <span style={{ fontSize: 12, color, fontWeight: 600 }}>
                      {arrow} {Math.abs(pct)}% до попер. періоду
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {kpiDetail && (() => {
            const kpi = kpis.find((k) => k.key === kpiDetail)!;
            const diff = kpi.cur - kpi.prev;
            const pct = kpi.prev > 0 ? Math.round((diff / kpi.prev) * 100) : kpi.cur > 0 ? 100 : 0;
            const fmt = (n: number) =>
              kpi.unit === "%" ? `${Math.round(n)}%` : kpi.key === "sum" || kpi.key === "avg" ? formatAmount(n) : n.toLocaleString("uk-UA");
            const showTeams = kpi.key === "sum" || kpi.key === "deals";
            return (
              <div onClick={() => setKpiDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
                <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 640, maxHeight: "85vh", overflowY: "auto" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <h2 className="chart-title">{kpi.label} — деталі</h2>
                    <button onClick={() => setKpiDetail(null)} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
                  </div>
                  <div className="kpi-grid" style={{ marginBottom: 16 }}>
                    <div className="kpi-card">
                      <span className="kpi-label">Поточний період</span>
                      <span className="kpi-value">{fmt(kpi.cur)}</span>
                      {dateRange.from && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{dateRange.from} — {dateRange.to}</span>}
                    </div>
                    <div className="kpi-card">
                      <span className="kpi-label">Попередній період</span>
                      <span className="kpi-value">{fmt(kpi.prev)}</span>
                      {dateRange.from && dateRange.to && (() => { const p = previousRange(dateRange.from, dateRange.to); return <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.from} — {p.to}</span>; })()}
                    </div>
                    <div className="kpi-card"><span className="kpi-label">Зміна</span><span className="kpi-value" style={{ color: diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : undefined }}>{diff > 0 ? "↑" : diff < 0 ? "↓" : "→"} {Math.abs(pct)}%</span></div>
                  </div>

                  {overview && overview.monthlyHistory.length > 0 && ["deals", "sum", "conv", "avg"].includes(kpi.key) && (() => {
                    const field = kpi.key === "deals" ? "deals" : kpi.key === "sum" ? "revenue" : kpi.key === "conv" ? "conversion" : "avgCheck";
                    const isMoney = kpi.key === "sum" || kpi.key === "avg";
                    return (
                      <div style={{ marginBottom: 16 }}>
                        <h3 style={{ fontSize: 14, margin: "0 0 8px", color: "var(--text-muted)" }}>Історія за 3 місяці</h3>
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={overview.monthlyHistory}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="month" />
                            <YAxis tickFormatter={(v) => isMoney ? `${Math.round(v / 1000)}k` : String(v)} />
                            <Tooltip formatter={(v) => isMoney ? formatAmount(Number(v)) : kpi.key === "conv" ? `${v}%` : Number(v).toLocaleString("uk-UA")} />
                            <Bar dataKey={field} name={kpi.label} fill="#c5141c" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    );
                  })()}
                  {showTeams && overview && (
                    <table className="data-table">
                      <thead><tr><th>Команда</th><th>Виручка</th><th>Угод</th></tr></thead>
                      <tbody>
                        {overview.byTeam.map((t) => (
                          <tr key={t.teamId}><td>{t.teamName}</td><td>{formatAmount(t.revenue)}</td><td>{t.deals}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            );
          })()}

          {overview && (
            <>
              <div className="kpi-grid">
                <div className="kpi-card">
                  <span className="kpi-label">План на місяць</span>
                  <span className="kpi-value">{formatAmount(overview.plan)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Факт (місяць)</span>
                  <span className="kpi-value">{formatAmount(overview.fact)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Виконання плану</span>
                  <span
                    className="kpi-value"
                    style={{ color: overview.planPct >= 100 ? "#16a34a" : overview.planPct >= 70 ? "#d97706" : "#dc2626" }}
                  >
                    {overview.planPct}%
                  </span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Дебіторська заборгованість</span>
                  <span className="kpi-value">{formatAmount(overview.receivablesTotal)}</span>
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Частка повторних (виручка)</span>
                  <span className="kpi-value">
                    {overview.newRevenue + overview.repeatRevenue > 0
                      ? Math.round(
                          (overview.repeatRevenue / (overview.newRevenue + overview.repeatRevenue)) * 100
                        )
                      : 0}
                    %
                  </span>
                </div>
              </div>

              <div className="chart-grid">
                <div className="chart-card">
                  <h2 className="chart-title">Виручка по командах</h2>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={overview.byTeam} margin={{ bottom: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="teamName" interval={0} tick={{ fontSize: 11 }} angle={-15} textAnchor="end" height={50} />
                      <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                      <Tooltip formatter={(v) => formatAmount(Number(v))} />
                      <Bar dataKey="revenue" name="Виручка" fill="#c5141c" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="chart-card">
                  <h2 className="chart-title">Топ-10 менеджерів за виручкою</h2>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Менеджер</th>
                        <th>Виручка</th>
                        <th>Угод</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.topManagers.map((m, i) => (
                        <tr key={m.managerId}>
                          <td>{i + 1}</td>
                          <td>{m.name}</td>
                          <td>{formatAmount(m.revenue)}</td>
                          <td>{m.deals}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {conversionChannels.length > 0 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">Конверсія за джерелом</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Джерело</th>
                    <th>Лідів</th>
                    <th>Оплачено</th>
                    <th>Конверсія</th>
                    <th>Сума оплат</th>
                  </tr>
                </thead>
                <tbody>
                  {conversionChannels.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.label}</td>
                      <td>{c.leads.toLocaleString("uk-UA")}</td>
                      <td>{c.paid.toLocaleString("uk-UA")}</td>
                      <td>{c.conversion}%</td>
                      <td>{formatAmount(c.paidAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {loading ? (
            <p className="loading-text">Завантаження...</p>
          ) : (
            <div className="chart-grid">
              <div className="chart-card">
                <h2 className="chart-title">Воронка продажів</h2>
                <ResponsiveContainer width="100%" height={340}>
                  <BarChart data={chartData} margin={{ bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" interval={0} tick={{ fontSize: 12 }} angle={-15} textAnchor="end" height={50} />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="count" fill="#c5141c" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}

      {section === "statistics" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Статистика</h1>
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
              <select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as "day" | "week" | "month")}
              >
                <option value="day">По днях</option>
                <option value="week">По тижнях</option>
                <option value="month">По місяцях</option>
              </select>
              <DateRangeFilter
                value={dateRange}
                onChange={(r) => {
                  setDateRange(r);
                  setDatePreset(null);
                }}
              />
            </div>
          </div>

          <QuickPeriods
            active={datePreset}
            onSelect={(id, range) => {
              setDatePreset(id);
              setDateRange(range);
            }}
          />

          {loading ? (
            <p className="loading-text">Завантаження...</p>
          ) : (
            <div className="chart-grid">
              {STAT_CHARTS.map((c) => (
                <div className="chart-card" key={c.key}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <h2 className="chart-title">{c.title}</h2>
                    <button
                      onClick={() => setZoomChart(c.key)}
                      title="Збільшити"
                      style={{
                        border: "1px solid #d0d5dd",
                        background: "#fff",
                        borderRadius: 6,
                        cursor: "pointer",
                        padding: "2px 8px",
                        fontSize: 16,
                      }}
                    >
                      ⛶
                    </button>
                  </div>
                  {renderStatChart(c.key, 300)}
                </div>
              ))}
            </div>
          )}

          {zoomChart && (
            <div
              onClick={() => setZoomChart(null)}
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2000,
                padding: 24,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: "#fff",
                  borderRadius: 12,
                  padding: 24,
                  width: "90vw",
                  maxWidth: 1200,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <h2 className="chart-title">
                    {STAT_CHARTS.find((c) => c.key === zoomChart)?.title}
                  </h2>
                  <button
                    onClick={() => setZoomChart(null)}
                    style={{
                      border: "1px solid #d0d5dd",
                      background: "#fff",
                      borderRadius: 6,
                      cursor: "pointer",
                      padding: "4px 12px",
                    }}
                  >
                    ✕ Закрити
                  </button>
                </div>
                {renderStatChart(zoomChart, 600)}
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
      )}

      {section === "leadgen" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Лідогенерація</h1>
            <div className="page-filters">
              {auth?.role !== "manager" && (
                <select
                  value={leadgenTeamId}
                  onChange={(e) => setLeadgenTeamId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">Усі команди</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              <DateRangeFilter
                value={dateRange}
                onChange={(r) => {
                  setDateRange(r);
                  setDatePreset(null);
                }}
              />
            </div>
          </div>

          <QuickPeriods
            active={datePreset}
            onSelect={(id, range) => {
              setDatePreset(id);
              setDateRange(range);
            }}
          />

          {leadgenLoading ? (
            <p className="loading-text">Завантаження...</p>
          ) : leadgenData.length === 0 ? (
            <p className="loading-text">Немає даних.</p>
          ) : (
            <>
              {leadgenData.map((group) => (
                <div key={group.teamName} style={{ marginBottom: 24 }}>
                  <h2
                    style={{
                      fontSize: 18,
                      margin: "8px 0 12px",
                      paddingBottom: 6,
                      borderBottom: "2px solid var(--border)",
                      color: group.isLeadgen ? "#c5141c" : "var(--text)",
                    }}
                  >
                    {group.isLeadgen ? "🎯 " : "🏢 "}
                    {group.teamName}
                    {!group.isLeadgen && " (комерційний відділ)"}
                    <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)", marginLeft: 10 }}>
                      {group.leads.toLocaleString("uk-UA")} лідів · {group.reachedPaid} оплат
                    </span>
                  </h2>
                  <div className="chart-grid">
                    {group.generators.map((g) => (
                      <div className="chart-card" key={g.managerId}>
                        <h2 className="chart-title">{g.managerName}</h2>
                        <div className="kpi-grid">
                          <div className="kpi-card">
                            <span className="kpi-label">Лідів</span>
                            <span className="kpi-value">{g.leads.toLocaleString("uk-UA")}</span>
                          </div>
                          <div className="kpi-card">
                            <span className="kpi-label">Дійшло до оплати</span>
                            <span className="kpi-value">{g.reachedPaid.toLocaleString("uk-UA")}</span>
                          </div>
                          <div className="kpi-card">
                            <span className="kpi-label">Конверсія</span>
                            <span className="kpi-value">{g.conversion}%</span>
                          </div>
                        </div>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Джерело клієнта</th>
                              <th>Лідів</th>
                              <th>Оплат</th>
                              <th>Конверсія</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.bySource.map((s) => (
                              <tr key={s.source}>
                                <td>{s.source}</td>
                                <td>{s.leads}</td>
                                <td>{s.reachedPaid}</td>
                                <td>{s.conversion}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
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
                  <option value="">Усі команди</option>
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

      {section === "settings" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Налаштування</h1>
          </div>
          {!settingsForm ? (
            <p className="loading-text">Завантаження...</p>
          ) : (
            <div className="chart-grid">
              <div className="chart-card">
                <h2 className="chart-title">Постійні клієнти</h2>
                {(
                  [
                    { key: "loyaltyThreshold", label: "Поріг «постійного» (оплат)", hint: "Скільки оплат робить клієнта постійним" },
                    { key: "loyaltyWindowMonths", label: "Вікно, місяців", hint: "За який період рахуються оплати" },
                    { key: "sleepingWindowMonths", label: "Вікно «сплячих», місяців", hint: "Глибина пошуку клієнтів на реактивацію" },
                  ] as const
                ).map((f) => (
                  <div key={f.key} style={{ marginBottom: 14 }}>
                    <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
                      {f.label}
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={settingsForm[f.key]}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, [f.key]: Number(e.target.value) })
                      }
                      style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d0d5dd", width: 120 }}
                    />
                    <div style={{ fontSize: 12, color: "#667085", marginTop: 2 }}>{f.hint}</div>
                  </div>
                ))}
              </div>

              <div className="chart-card">
                <h2 className="chart-title">Дебіторська заборгованість</h2>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
                    Підсвічувати прострочення понад (днів)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={settingsForm.receivablesOverdueWarnDays}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        receivablesOverdueWarnDays: Number(e.target.value),
                      })
                    }
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d0d5dd", width: 120 }}
                  />
                  <div style={{ fontSize: 12, color: "#667085", marginTop: 2 }}>
                    0 — підсвічувати, лише коли прострочення перевищує погоджений ліміт днів
                  </div>
                </div>
              </div>

              <div style={{ gridColumn: "1 / -1", display: "flex", gap: 12, alignItems: "center" }}>
                <button
                  onClick={handleSaveSettings}
                  disabled={settingsSaving}
                  style={{
                    padding: "10px 20px",
                    borderRadius: 8,
                    border: "none",
                    background: "#c5141c",
                    color: "#fff",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {settingsSaving ? "Збереження..." : "Зберегти"}
                </button>
                {settingsSaved && <span style={{ color: "#16a34a" }}>✓ Збережено</span>}
              </div>
            </div>
          )}

          {auth?.role === "admin" && (
            <div className="chart-card" style={{ marginTop: 16 }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <h2 className="chart-title">Користувачі та доступи</h2>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {provisionMsg && <span style={{ color: "#16a34a", fontSize: 13 }}>{provisionMsg}</span>}
                  <button
                    onClick={handleProvision}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "#c5141c",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Синхронізувати з CRM
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "#667085", marginTop: 4 }}>
                Логіни створюються автоматично для кожного менеджера з CRM. Тімлід бачить свою
                команду. Пароль генерується автоматично — натисніть «Скинути», щоб побачити новий.
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ім'я</th>
                    <th>E-mail</th>
                    <th>Команда</th>
                    <th>Роль</th>
                    <th>Пароль</th>
                    <th>Активний</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                      <td>{u.manager_name ?? "—"}</td>
                      <td>{u.email}</td>
                      <td>{u.team_name ?? "—"}</td>
                      <td>
                        {u.role === "admin" ? (
                          "Адмін"
                        ) : (
                          <button
                            onClick={() => handleToggleRole(u)}
                            style={{
                              cursor: "pointer",
                              border: "1px solid #d0d5dd",
                              borderRadius: 12,
                              padding: "2px 10px",
                              background: u.role === "team_lead" ? "#fef3c7" : "#fff",
                            }}
                          >
                            {u.role === "team_lead" ? "Тімлід" : "Менеджер"}
                          </button>
                        )}
                      </td>
                      <td style={{ fontFamily: "monospace" }}>
                        {revealed[u.id] ?? (u.initial_password ? u.initial_password : "••••••")}
                      </td>
                      <td>{u.is_active ? "✓" : "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {u.role !== "admin" && (
                          <>
                            <button
                              onClick={() => handleResetPassword(u.id)}
                              style={{ cursor: "pointer", marginRight: 6, fontSize: 12 }}
                            >
                              Скинути пароль
                            </button>
                            <button
                              onClick={() => handleToggleActive(u)}
                              style={{ cursor: "pointer", fontSize: 12 }}
                            >
                              {u.is_active ? "Деактивувати" : "Активувати"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {section === "messenger" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Месенджер</h1>
          </div>
          <div className="chart-card" style={{ display: "flex", gap: 0, padding: 0, height: "70vh", overflow: "hidden" }}>
            <div style={{ width: 280, borderRight: "1px solid var(--border)", overflowY: "auto" }}>
              {Array.from(
                chatUsers.reduce((map, u) => {
                  if (!map.has(u.team_name)) map.set(u.team_name, [] as ChatUser[]);
                  map.get(u.team_name)!.push(u);
                  return map;
                }, new Map<string, ChatUser[]>())
              ).map(([team, members]) => (
                <div key={team}>
                  <div
                    style={{
                      padding: "8px 16px 4px",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      color: "var(--text-muted)",
                      background: "var(--bg)",
                    }}
                  >
                    👥 {team}
                  </div>
                  {members.map((u) => {
                    const rank = getRank(u.revenue);
                    const pres = presence(u.last_seen);
                    return (
                      <button
                        key={u.id}
                        onClick={() => setChatActive(u)}
                        title={`${rank.title} · ${pres.label}`}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          width: "100%",
                          textAlign: "left",
                          padding: "10px 16px",
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          background: chatActive?.id === u.id ? "rgba(197,20,28,0.10)" : "transparent",
                          color: "var(--text)",
                        }}
                      >
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span>
                            <span style={{ marginRight: 6 }}>{rank.emoji}</span>
                            {u.name}
                          </span>
                          <span style={{ fontSize: 11, color: pres.online ? "#16a34a" : "var(--text-muted)" }}>
                            {pres.online ? "🟢 " : "⚪ "}
                            {pres.label}
                          </span>
                        </span>
                        {u.unread > 0 && (
                          <span style={{ background: "#c5141c", color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 12 }}>
                            {u.unread}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              {!chatActive ? (
                <div style={{ margin: "auto", color: "var(--text-muted)" }}>
                  Оберіть співрозмовника
                </div>
              ) : (
                <>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>
                    {chatActive.name}
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                    {chatMessages.map((m) => {
                      const mine = m.sender_id !== chatActive.id;
                      return (
                        <div
                          key={m.id}
                          style={{
                            alignSelf: mine ? "flex-end" : "flex-start",
                            background: mine ? "#c5141c" : "var(--bg)",
                            color: mine ? "#fff" : "var(--text)",
                            padding: "8px 12px",
                            borderRadius: 12,
                            maxWidth: "70%",
                          }}
                        >
                          {m.body && <div>{m.body}</div>}
                          {m.attachment_url &&
                            (/\.(png|jpe?g|gif|webp|bmp)$/i.test(m.attachment_url) ? (
                              <a href={m.attachment_url} target="_blank" rel="noreferrer">
                                <img src={m.attachment_url} alt={m.attachment_name ?? ""} style={{ maxWidth: 200, borderRadius: 8, display: "block" }} />
                              </a>
                            ) : (
                              <a href={m.attachment_url} target="_blank" rel="noreferrer" style={{ color: mine ? "#fff" : "var(--brand)", textDecoration: "underline" }}>
                                📎 {m.attachment_name ?? "файл"}
                              </a>
                            ))}
                          <div style={{ fontSize: 10, opacity: 0.7, textAlign: "right" }}>
                            {new Date(m.created_at).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)", alignItems: "center" }}>
                    <label style={{ cursor: "pointer", fontSize: 20 }} title="Прикріпити файл">
                      📎
                      <input
                        type="file"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleSendFile(f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                      placeholder="Повідомлення…"
                      style={{ flex: 1 }}
                    />
                    <button
                      onClick={handleSendMessage}
                      style={{ padding: "8px 18px", background: "#c5141c", color: "#fff", border: "none", borderRadius: 8 }}
                    >
                      Надіслати
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {section === "news" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Новини</h1>
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🚚 Орієнтовні ціни за 1 км (сьогодні)</h2>
            <div className="kpi-grid">
              {([["20 т", "t20"], ["10 т", "t10"], ["5 т", "t5"], ["2 т", "t2"]] as const).map(([label, key]) => (
                <div className="kpi-card" key={key}>
                  <span className="kpi-label">Вантажівка {label}</span>
                  <span className="kpi-value">
                    {kmPrices && kmPrices[key] != null ? `${kmPrices[key]} ₴/км` : "—"}
                  </span>
                </div>
              ))}
            </div>
            {auth?.role === "admin" && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                {(["t20", "t10", "t5", "t2"] as const).map((key) => (
                  <input
                    key={key}
                    type="number"
                    placeholder={key.replace("t", "") + "т ₴/км"}
                    value={kmForm[key]}
                    onChange={(e) => setKmForm({ ...kmForm, [key]: e.target.value })}
                    style={{ width: 110 }}
                  />
                ))}
                <button onClick={handleSaveKm} style={{ padding: "8px 16px", background: "#c5141c", color: "#fff", border: "none", borderRadius: 8 }}>
                  Зберегти ціни
                </button>
              </div>
            )}
          </div>

          <div className="page-filters" style={{ marginBottom: 12 }}>
            {([["company", "Новини компанії"], ["logistics", "Світ логістики"], ["sales", "Продажі логістичних послуг"]] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setNewsCategory(key)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 16,
                  border: `1px solid ${newsCategory === key ? "#c5141c" : "var(--border)"}`,
                  background: newsCategory === key ? "#c5141c" : "var(--card-bg)",
                  color: newsCategory === key ? "#fff" : "var(--text)",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {auth?.role === "admin" && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">Додати новину ({newsCategory === "company" ? "компанія" : newsCategory === "logistics" ? "логістика" : "продажі"})</h2>
              <input
                placeholder="Заголовок"
                value={newsForm.title}
                onChange={(e) => setNewsForm({ ...newsForm, title: e.target.value })}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <textarea
                placeholder="Текст новини"
                value={newsForm.body}
                onChange={(e) => setNewsForm({ ...newsForm, body: e.target.value })}
                style={{ width: "100%", minHeight: 70, marginBottom: 8, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}
              />
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                <input
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      const up = await uploadFile(f);
                      setNewsForm((prev) => ({ ...prev, imageUrl: up.url }));
                    }
                  }}
                />
                {newsForm.imageUrl && (
                  <img src={newsForm.imageUrl} alt="" style={{ height: 40, borderRadius: 6 }} />
                )}
              </div>
              <button onClick={handleAddNews} style={{ padding: "8px 18px", background: "#c5141c", color: "#fff", border: "none", borderRadius: 8 }}>
                Опублікувати
              </button>
            </div>
          )}

          {newsItems.length === 0 ? (
            <p className="loading-text">Новин поки немає.</p>
          ) : (
            <div className="chart-grid">
              {newsItems.map((n) => (
                <div className="chart-card" key={n.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                    <h2 className="chart-title">{n.title}</h2>
                    {auth?.role === "admin" && (
                      <button
                        onClick={async () => {
                          await deleteNews(n.id);
                          setNewsItems(await fetchNews(newsCategory));
                        }}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)" }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {n.image_url && (
                    <img src={n.image_url} alt="" style={{ maxWidth: "100%", borderRadius: 8, marginBottom: 8 }} />
                  )}
                  {n.body && <p style={{ color: "var(--text)", whiteSpace: "pre-wrap" }}>{n.body}</p>}
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {new Date(n.created_at).toLocaleDateString("uk-UA")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {section === "training" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Навчання</h1>
          </div>
          <div className="chart-grid">
            <div className="chart-card">
              <h2 className="chart-title">Як користуватись дашбордом</h2>
              <ul style={{ lineHeight: 1.9, color: "var(--text)" }}>
                <li><b>Огляд</b> — ключові показники компанії за обраний період (за замовчуванням — місяць).</li>
                <li><b>Статистика</b> — діаграми динаміки з вибором періоду й масштабуванням (⛶).</li>
                <li><b>Постійні клієнти</b> — сегменти й кандидати на реактивацію.</li>
                <li><b>Дебіторська заборгованість</b> — борги по клієнтах, ліміт і прострочення днів.</li>
                <li><b>Лідогенерація</b> — ефективність лідогенераторів по джерелах.</li>
                <li>Швидкий перехід між розділами — <b>Ctrl + K</b>.</li>
              </ul>
            </div>
            <div className="chart-card">
              <h2 className="chart-title">Матеріали</h2>
              <p style={{ color: "var(--text-muted)" }}>
                Тут будуть навчальні відео та інструкції. Додавання матеріалів —
                за потреби, скажіть які саме розмістити.
              </p>
            </div>
          </div>
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
