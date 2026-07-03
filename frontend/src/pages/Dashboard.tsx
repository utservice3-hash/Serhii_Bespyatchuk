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
  LabelList,
} from "recharts";
import {
  createTask,
  createTaskPlan,
  deleteTask,
  fetchConversion,
  fetchFunnel,
  fetchOverview,
  fetchLeadgen,
  fetchLoyalty,
  fetchSettings,
  saveSettings,
  fetchSyncStatus,
  triggerSync,
  type SyncStatus,
  fetchReport,
  type ReportData,
  fetchFunnelReport,
  type FunnelReport,
  fetchFunnelWeekly,
  type FunnelWeeklyReport,
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
  createUser,
  resetUserPassword,
  updateUser,
  fetchManagerBreakdown,
  fetchManagerOptions,
  fetchPersonalDashboard,
  fetchReceivables,
  fetchTasks,
  fetchTeams,
  fetchTeamsRanking,
  type TeamRanking,
  fetchTimeseries,
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
  type Team,
} from "../api";
import { Layout, NAV_ITEMS, type NavKey } from "../components/Layout";
import { DateRangeFilter, QuickPeriods, getDateRange } from "../components/DateRangeFilter";
import { getAuthPayload } from "../auth";
import { currentMonth, formatAmount, formatAmountFull, previousRange, getRank, presence } from "./dashboard/format";
import { STAGE_LABELS, STAGE_COLORS, STAGE_ORDER, STAT_CHARTS } from "./dashboard/constants";
import { emptyTaskForm } from "./dashboard/taskForm";
import { OverviewSection, type Kpi } from "./dashboard/sections/OverviewSection";
import { FeedbackSection } from "./dashboard/sections/FeedbackSection";
import { AiWorkSection } from "./dashboard/sections/AiWorkSection";
import { TeamsSection } from "./dashboard/sections/TeamsSection";
import { ManagersSection } from "./dashboard/sections/ManagersSection";
import { LoyaltySection } from "./dashboard/sections/LoyaltySection";
import { ReceivablesSection } from "./dashboard/sections/ReceivablesSection";
import { TasksSection } from "./dashboard/sections/TasksSection";
import { ReportSection } from "./dashboard/sections/ReportSection";

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
  const [taskSearch, setTaskSearch] = useState("");
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskForm, setTaskForm] = useState(emptyTaskForm);

  const [loyaltyTeamId, setLoyaltyTeamId] = useState<number | "">("");
  const [loyaltyData, setLoyaltyData] = useState<LoyaltyManager[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [loyaltyDynamics, setLoyaltyDynamics] = useState<LoyaltyDynamics | null>(null);

  const [teamsRanking, setTeamsRanking] = useState<TeamRanking[]>([]);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportGranularity, setReportGranularity] = useState<"day" | "week" | "month">("week");
  const [reportManagerId, setReportManagerId] = useState<number | "">("");
  const [reportTeamId, setReportTeamId] = useState<number | "">("");
  const [funnelReport, setFunnelReport] = useState<FunnelReport | null>(null);
  const [funnelWeekly, setFunnelWeekly] = useState<FunnelWeeklyReport | null>(null);
  const [receivablesTeamId, setReceivablesTeamId] = useState<number | "">("");
  const [receivablesData, setReceivablesData] = useState<ReceivableManager[]>([]);
  const [receivablesSyncedAt, setReceivablesSyncedAt] = useState<string | null>(null);
  const [receivablesLoading, setReceivablesLoading] = useState(false);
  // Live refresh: bump a nonce every 5 min so data-loading effects re-fetch
  // fresh CRM data without a manual page reload.
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRefreshNonce((n) => n + 1), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const canEditReceivables = auth?.role === "admin" || auth?.role === "team_lead";
  function patchReceivableNote(clientKey: string, patch: { comment?: string; dueDate?: string | null }) {
    setReceivablesData((prev) =>
      prev.map((m) => ({
        ...m,
        clients: m.clients.map((c) => (c.clientKey === clientKey ? { ...c, ...patch } : c)),
      }))
    );
  }

  const [leadgenTeamId, setLeadgenTeamId] = useState<number | "">("");
  const [leadgenData, setLeadgenData] = useState<LeadgenGroup[]>([]);
  const [leadgenLoading, setLeadgenLoading] = useState(false);

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [settingsForm, setSettingsForm] = useState<AppSettings | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [provisionMsg, setProvisionMsg] = useState<string | null>(null);
  const [newUserForm, setNewUserForm] = useState({ email: "", password: "", role: "manager" as "manager" | "team_lead" | "admin", teamId: "" as number | "" });
  const [newUserCreds, setNewUserCreds] = useState<string | null>(null);

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
    if (section !== "teams") return;
    fetchTeamsRanking({ from: dateRange.from || undefined, to: dateRange.to || undefined })
      .then(setTeamsRanking)
      .catch(() => setTeamsRanking([]));
  }, [section, dateRange, refreshNonce]);

  useEffect(() => {
    if (section !== "report") return;
    // Manager pick takes precedence over team pick.
    const mgr = reportManagerId || undefined;
    const team = mgr ? undefined : reportTeamId || undefined;
    setReportLoading(true);
    fetchReport({ granularity: reportGranularity, from: dateRange.from || undefined, to: dateRange.to || undefined, managerId: mgr, teamId: team })
      .then(setReportData)
      .catch(() => setReportData(null))
      .finally(() => setReportLoading(false));
    // The client funnel lives inside the same "Звіт" section.
    fetchFunnelReport({ from: dateRange.from || undefined, to: dateRange.to || undefined, managerId: mgr, teamId: team })
      .then(setFunnelReport)
      .catch(() => setFunnelReport(null));
    // Weekly funnel matrix (operational Mon/Thu report), keyed to the selected month.
    fetchFunnelWeekly({ to: dateRange.to || undefined, managerId: mgr, teamId: team })
      .then(setFunnelWeekly)
      .catch(() => setFunnelWeekly(null));
    if (auth?.role !== "manager") {
      fetchManagerOptions().then(setManagerOptions).catch(() => setManagerOptions([]));
    }
  }, [section, reportGranularity, reportManagerId, reportTeamId, dateRange, refreshNonce, auth]);

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

  async function addTask(payload: {
    title: string;
    deadline?: string | null;
    assigneeId?: number | null;
    priority?: TaskPriority;
    department?: string | null;
    comments?: string | null;
  }) {
    const title = payload.title.trim();
    if (!title) return;
    const deadline = payload.deadline || null;
    const assigneeId = payload.assigneeId ?? null;
    const priority = payload.priority ?? "medium";
    const department = payload.department?.trim() || null;
    const comments = payload.comments?.trim() || null;
    const { id } = await createTask({ title, deadline, assigneeId, priority, department, comments });
    setTasks((prev) => [
      {
        id,
        title,
        status: "not_started",
        deadline,
        assigneeId,
        assigneeName: managerOptions.find((m) => m.id === assigneeId)?.name ?? null,
        priority,
        comments,
        department,
        taskType: "simple",
        metric: null,
        targetValue: null,
        actualValue: null,
        planDate: null,
        periodStart: null,
        periodEnd: null,
        parentId: null,
        auto: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ...prev,
    ]);
  }

  // Builds the list of ISO working-day dates the team-lead picked, for a week
  // (the week containing weekStart) or a month (all matching weekdays).
  function buildPlanDays(): string[] {
    if (!taskForm.weekStart) return [];
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const base = new Date(taskForm.weekStart + "T00:00:00");
    const wd = (d: Date) => (d.getDay() + 6) % 7; // Mon=0..Sun=6
    const days: string[] = [];
    if (taskForm.taskType === "weekly_kpi") {
      const monday = new Date(base);
      monday.setDate(base.getDate() - wd(base));
      for (let i = 0; i < 7; i++) {
        if (!taskForm.weekdays[i]) continue;
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        days.push(fmt(d));
      }
    } else {
      const d = new Date(base.getFullYear(), base.getMonth(), 1);
      while (d.getMonth() === base.getMonth()) {
        if (taskForm.weekdays[wd(d)]) days.push(fmt(d));
        d.setDate(d.getDate() + 1);
      }
    }
    return days;
  }

  async function handleSubmitTaskModal() {
    if (taskForm.taskType === "simple") {
      if (!taskForm.title.trim()) return;
      await addTask({
        title: taskForm.title,
        deadline: taskForm.deadline,
        assigneeId: taskForm.assigneeId === "" ? null : Number(taskForm.assigneeId),
        priority: taskForm.priority,
        department: taskForm.department,
        comments: taskForm.comments,
      });
    } else {
      if (taskForm.assigneeId === "") {
        alert("Оберіть виконавця (менеджера) для плану");
        return;
      }
      const days = buildPlanDays();
      if (days.length === 0) {
        alert("Оберіть дату початку та хоча б один робочий день");
        return;
      }
      await createTaskPlan({
        assigneeId: Number(taskForm.assigneeId),
        period: taskForm.taskType === "weekly_kpi" ? "week" : "month",
        days,
        adsCount: taskForm.adsCount ? Number(taskForm.adsCount) : undefined,
        leadgenCount: taskForm.leadgenCount ? Number(taskForm.leadgenCount) : undefined,
        avgCheck: taskForm.avgCheck ? Number(taskForm.avgCheck) : undefined,
        conversion: taskForm.conversion ? Number(taskForm.conversion) : undefined,
      });
      const fresh = await fetchTasks();
      setTasks(fresh);
    }
    setTaskForm(emptyTaskForm);
    setTaskModalOpen(false);
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
  }, [section, managerTeamId, month, teams, auth, refreshNonce]);

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
  }, [section, loyaltyTeamId, teams, auth, refreshNonce]);

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
  }, [section, receivablesTeamId, teams, auth, refreshNonce]);

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
  }, [section, auth, refreshNonce]);

  // Sync status drives both the Overview quick-sync control and the Settings card.
  useEffect(() => {
    if (section !== "overview" && section !== "settings") return;
    fetchSyncStatus().then(setSyncStatus).catch(() => setSyncStatus(null));
  }, [section, refreshNonce]);

  async function reloadUsers() {
    try {
      setUsers(await fetchDashboardUsers());
    } catch {
      setUsers([]);
    }
  }

  async function handleCreateUser() {
    if (!newUserForm.email.trim()) return;
    try {
      const res = await createUser({
        email: newUserForm.email.trim(),
        password: newUserForm.password || undefined,
        role: newUserForm.role,
        teamId: newUserForm.teamId || undefined,
      });
      setNewUserCreds(`${res.email} / ${res.password}`);
      setNewUserForm({ email: "", password: "", role: "manager", teamId: "" });
      await reloadUsers();
    } catch (e: any) {
      setNewUserCreds(e?.response?.data?.error ?? "Помилка створення");
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

  async function handleManualSync() {
    setSyncing(true);
    try {
      await triggerSync();
    } catch {
      setSyncing(false);
      return;
    }
    // Poll sync status until it reports fresh data, then refetch all metrics.
    const startedAt = Date.now();
    const poll = async () => {
      const st = await fetchSyncStatus().catch(() => null);
      if (st) setSyncStatus(st);
      const fresh = st != null && st.ageMinutes != null && st.ageMinutes < 2;
      if (fresh || Date.now() - startedAt > 300000) {
        setRefreshNonce((n) => n + 1);
        setSyncing(false);
        return;
      }
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 5000);
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
  }, [teamId, granularity, dateRange, refreshNonce]);

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
            <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={20} />
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
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
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
          <BarChart data={paidDynamics} margin={{ top: 12 }}>
            <defs>
              <linearGradient id="statBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e11d2a" />
                <stop offset="100%" stopColor="#8f0f1c" />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
            <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={20} />
            <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <Tooltip formatter={(v) => formatAmount(Number(v))} cursor={{ fill: "rgba(197,20,28,0.06)" }} />
            <Bar dataKey="revenue" name="Виручка" fill="url(#statBar)" radius={[4, 4, 0, 0]}>
              {height >= 500 && (
                <LabelList dataKey="revenue" position="top" formatter={(v) => formatAmount(Number(v))} style={{ fontSize: 10, fontWeight: 600, fill: "var(--text)" }} />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    if (key === "count") {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={paidDynamics}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={20} />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="paidCount" name="Оплачено угод" stroke="#16a34a" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    // avgcheck
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={paidDynamics}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={20} />
          <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
          <Tooltip formatter={(v) => formatAmount(Number(v))} />
          <Line type="monotone" dataKey="avgCheck" name="Середній чек" stroke="#7c3aed" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const totalDeals = chartData.reduce((sum, s) => sum + s.count, 0);
  // Average check = received money per received-money deal — the same base as
  // the "Отримані кошти" card (успішно + оплата отримана), not per funnel lead.
  const avgDeal = overview && overview.closedDeals > 0 ? overview.closedRevenue / overview.closedDeals : 0;

  // Previous-period equivalents (for growth deltas + drill-down details).
  const prevChart = [...prevStages].map((s) => ({
    name: STAGE_LABELS[s.funnel_stage] ?? s.funnel_stage,
    count: Number(s.deal_count),
    amount: Number(s.total_amount),
  }));
  const prevDeals = prevChart.reduce((s, x) => s + x.count, 0);
  const prevAvg = prevOverview && prevOverview.closedDeals > 0 ? prevOverview.closedRevenue / prevOverview.closedDeals : 0;

  // "Угоди" = deals that reached "Виставлено рахунок"…"Успішно реалізовано"
  // (invoiced+paid), created in the period — comes from the overview endpoint.
  const dealsCount = overview?.createdLeads ?? totalDeals;
  const prevDealsCount = prevOverview?.createdLeads ?? prevDeals;
  const adConv = overview?.adConversion?.conversion ?? 0;
  const prevAdConv = prevOverview?.adConversion?.conversion ?? 0;
  const lgConv = overview?.leadgenConversion?.conversion ?? 0;
  const prevLgConv = prevOverview?.leadgenConversion?.conversion ?? 0;

  const kpis: Kpi[] = [
    { key: "deals", label: "Угоди (рахунок→реалізовано)", value: dealsCount.toLocaleString("uk-UA"), cur: dealsCount, prev: prevDealsCount },
    { key: "sum", label: "Отримані кошти (оплата+успішно)", value: formatAmount(overview?.closedRevenue ?? 0), cur: overview?.closedRevenue ?? 0, prev: prevOverview?.closedRevenue ?? 0 },
    { key: "convAd", label: "Конверсія реклами", value: `${adConv}%`, cur: adConv, prev: prevAdConv, unit: "%" },
    { key: "convLg", label: "Конверсія лідогену", value: `${lgConv}%`, cur: lgConv, prev: prevLgConv, unit: "%" },
    { key: "avg", label: "Середній чек", value: formatAmountFull(avgDeal), cur: avgDeal, prev: prevAvg },
    { key: "newc", label: "Нові клієнти (вперше)", value: (overview?.newClients ?? 0).toLocaleString("uk-UA"), cur: overview?.newClients ?? 0, prev: prevOverview?.newClients ?? 0 },
    { key: "repc", label: "Постійні клієнти (2+)", value: (overview?.repeatClients ?? 0).toLocaleString("uk-UA"), cur: overview?.repeatClients ?? 0, prev: prevOverview?.repeatClients ?? 0 },
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
        <OverviewSection
          isManager={auth?.role === "manager"}
          teamId={teamId}
          setTeamId={setTeamId}
          teams={teams}
          granularity={granularity}
          setGranularity={setGranularity}
          dateRange={dateRange}
          setDateRange={setDateRange}
          datePreset={datePreset}
          setDatePreset={setDatePreset}
          kpis={kpis}
          prevStages={prevStages}
          prevOverview={prevOverview}
          kpiDetail={kpiDetail}
          setKpiDetail={setKpiDetail}
          overview={overview}
          conversionChannels={conversionChannels}
          loading={loading}
          chartData={chartData}
          syncStatus={syncStatus}
          syncing={syncing}
          canSync={auth?.role === "admin" || auth?.role === "team_lead"}
          onManualSync={handleManualSync}
        />
      )}

      {section === "report" && (
        <ReportSection
          title={auth?.role === "manager" ? "Мій звіт" : auth?.role === "team_lead" ? "Звіт тімліда" : "Звіт"}
          report={reportData}
          funnelReport={funnelReport}
          funnelWeekly={funnelWeekly}
          loading={reportLoading}
          granularity={reportGranularity}
          setGranularity={setReportGranularity}
          dateRange={dateRange}
          setDateRange={setDateRange}
          datePreset={datePreset}
          setDatePreset={setDatePreset}
          canEditPlan={auth?.role === "admin" || auth?.role === "team_lead"}
          canPickManager={auth?.role !== "manager"}
          canPickTeam={auth?.role === "admin"}
          teams={teams}
          reportTeamId={reportTeamId}
          setReportTeamId={setReportTeamId}
          managerOptions={managerOptions}
          reportManagerId={reportManagerId}
          setReportManagerId={setReportManagerId}
          onPlanSaved={() => setRefreshNonce((n) => n + 1)}
        />
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
        <TeamsSection
          datePreset={datePreset}
          setDatePreset={setDatePreset}
          setDateRange={setDateRange}
          teamsRanking={teamsRanking}
        />
      )}

      {section === "managers" && (
        <ManagersSection
          auth={auth}
          teams={teams}
          managerTeamId={managerTeamId}
          setManagerTeamId={setManagerTeamId}
          month={month}
          setMonth={setMonth}
          managersLoading={managersLoading}
          managerRows={managerRows}
          selectedManagerId={selectedManagerId}
          setSelectedManagerId={setSelectedManagerId}
          personalLoading={personalLoading}
          personalData={personalData}
        />
      )}

      {section === "loyalty" && (
        <LoyaltySection
          auth={auth}
          teams={teams}
          loyaltyTeamId={loyaltyTeamId}
          setLoyaltyTeamId={setLoyaltyTeamId}
          loyaltyDynamics={loyaltyDynamics}
          loyaltyLoading={loyaltyLoading}
          loyaltyData={loyaltyData}
        />
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
        <ReceivablesSection
          auth={auth}
          teams={teams}
          receivablesTeamId={receivablesTeamId}
          setReceivablesTeamId={setReceivablesTeamId}
          receivablesSyncedAt={receivablesSyncedAt}
          receivablesLoading={receivablesLoading}
          receivablesData={receivablesData}
          canEditReceivables={canEditReceivables}
          patchReceivableNote={patchReceivableNote}
        />
      )}

      {section === "feedback" && (
        auth?.role === "manager"
          ? <div className="page-header"><h1 className="page-title">Зворотний звʼязок</h1><p className="loading-text">Доступно тімлідам та адміністратору.</p></div>
          : <FeedbackSection isAdmin={auth?.role === "admin"} />
      )}

      {section === "aiwork" && <AiWorkSection />}

      {section === "settings" && (
        <>
          <div className="page-header">
            <h1 className="page-title">Налаштування</h1>
          </div>

          {syncStatus && (
            <div
              className="chart-card"
              style={{
                marginBottom: 16,
                borderLeft: `4px solid ${syncStatus.stale ? "#dc2626" : "#16a34a"}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <h2 className="chart-title" style={{ marginBottom: 0 }}>
                  Синхронізація з CRM
                </h2>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontWeight: 600, color: syncStatus.stale ? "#dc2626" : "#16a34a" }}>
                    {syncStatus.stale ? "⚠️ Дані застаріли" : "🟢 Актуально"}
                  </span>
                  {(auth?.role === "admin" || auth?.role === "team_lead") && (
                    <button
                      onClick={handleManualSync}
                      disabled={syncing}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 8,
                        border: "none",
                        background: syncing ? "#94a3b8" : "#c5141c",
                        color: "#fff",
                        fontWeight: 600,
                        cursor: syncing ? "default" : "pointer",
                      }}
                    >
                      {syncing ? "Синхронізація…" : "🔄 Синхронізувати зараз"}
                    </button>
                  )}
                </div>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 0" }}>
                Останнє оновлення:{" "}
                {syncStatus.lastSuccessAt
                  ? `${new Date(syncStatus.lastSuccessAt).toLocaleString("uk-UA")} (${
                      syncStatus.ageMinutes != null ? `${syncStatus.ageMinutes} хв тому` : "—"
                    })`
                  : "ще не було"}
                {syncStatus.lastDealCount != null && ` · угод за прохід: ${syncStatus.lastDealCount}`}
              </p>
              {syncStatus.consecutiveFailures > 0 && (
                <p style={{ fontSize: 13, color: "#dc2626", margin: "4px 0 0" }}>
                  Помилок поспіль: {syncStatus.consecutiveFailures}
                  {syncStatus.lastError ? ` — ${syncStatus.lastError.split("\n")[0]}` : ""}
                </p>
              )}
            </div>
          )}

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

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "12px 0", padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
                <b style={{ marginRight: 4 }}>Додати вручну:</b>
                <input placeholder="e-mail" value={newUserForm.email} onChange={(e) => setNewUserForm({ ...newUserForm, email: e.target.value })} style={{ width: 180 }} />
                <input placeholder="пароль (необов'язково)" value={newUserForm.password} onChange={(e) => setNewUserForm({ ...newUserForm, password: e.target.value })} style={{ width: 170 }} />
                <select value={newUserForm.role} onChange={(e) => setNewUserForm({ ...newUserForm, role: e.target.value as any })}>
                  <option value="manager">Менеджер</option>
                  <option value="team_lead">Тімлід</option>
                  <option value="admin">Керівник відділу продажу</option>
                </select>
                <select value={newUserForm.teamId} onChange={(e) => setNewUserForm({ ...newUserForm, teamId: e.target.value ? Number(e.target.value) : "" })}>
                  <option value="">Без команди</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button onClick={handleCreateUser} style={{ padding: "8px 16px", background: "#c5141c", color: "#fff", border: "none", borderRadius: 8 }}>Створити</button>
                {newUserCreds && <span style={{ color: "#16a34a", fontFamily: "monospace" }}>{newUserCreds}</span>}
              </div>

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
                          "Керівник відділу продажу"
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
        <TasksSection
          taskSearch={taskSearch}
          setTaskSearch={setTaskSearch}
          setTaskForm={setTaskForm}
          emptyTaskForm={emptyTaskForm}
          taskModalOpen={taskModalOpen}
          setTaskModalOpen={setTaskModalOpen}
          taskForm={taskForm}
          tasksLoading={tasksLoading}
          tasks={tasks}
          managerOptions={managerOptions}
          patchTaskLocal={patchTaskLocal}
          handleDeleteTask={handleDeleteTask}
          handleSubmitTaskModal={handleSubmitTaskModal}
        />
      )}
    </Layout>
  );
}
