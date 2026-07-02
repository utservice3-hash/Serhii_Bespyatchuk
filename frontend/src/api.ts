import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:4000/api",
});

api.interceptors.request.use((req) => {
  const token = localStorage.getItem("token");
  if (token) req.headers.Authorization = `Bearer ${token}`;
  return req;
});

// When the token has expired (or is otherwise rejected), every authenticated
// request 401s — which previously left the UI silently broken (empty team
// dropdown, blank charts). Clear the stale token and send the user back to
// login so they can re-authenticate.
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && localStorage.getItem("token")) {
      localStorage.removeItem("token");
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export interface FunnelStage {
  funnel_stage: string;
  deal_count: string;
  total_amount: string;
}

export async function login(email: string, password: string): Promise<string> {
  const { data } = await api.post<{ token: string }>("/auth/login", { email, password });
  return data.token;
}

export async function fetchFunnel(params: {
  managerId?: number;
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<FunnelStage[]> {
  const { data } = await api.get<{ stages: FunnelStage[] }>("/dashboard/funnel", { params });
  return data.stages;
}

export interface TimeseriesPoint {
  period: string;
  funnel_stage: string;
  deal_count: string;
  total_amount: string;
}

export async function fetchTimeseries(params: {
  granularity: "day" | "week" | "month";
  managerId?: number;
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<TimeseriesPoint[]> {
  const { data } = await api.get<{ points: TimeseriesPoint[] }>("/dashboard/timeseries", {
    params,
  });
  return data.points;
}

export interface ConversionChannel {
  channel: string;
  label: string;
  leads: number;
  paid: number;
  paidAmount: number;
  conversion: number;
}

export async function fetchConversion(params: {
  managerId?: number;
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<ConversionChannel[]> {
  const { data } = await api.get<{ channels: ConversionChannel[] }>("/dashboard/conversion", {
    params,
  });
  return data.channels;
}

export interface LeadgenSource {
  source: string;
  leads: number;
  reachedPaid: number;
  conversion: number;
}

export interface LeadGenerator {
  managerId: number;
  managerName: string;
  teamName: string;
  leads: number;
  reachedPaid: number;
  conversion: number;
  bySource: LeadgenSource[];
}

export interface LeadgenGroup {
  teamName: string;
  isLeadgen: boolean;
  leads: number;
  reachedPaid: number;
  generators: LeadGenerator[];
}

export async function fetchLeadgen(params: {
  managerId?: number;
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<LeadgenGroup[]> {
  const { data } = await api.get<{ groups: LeadgenGroup[] }>("/dashboard/leadgen", {
    params,
  });
  return data.groups;
}

export interface ExecutiveOverview {
  plan: number;
  fact: number;
  planPct: number;
  closedRevenue: number;
  closedDeals: number;
  successRevenue: number;
  successDeals: number;
  paymentRevenue: number;
  paymentDeals: number;
  pendingPayments: {
    deals: number;
    revenue: number;
    byTeam: { teamId: number; teamName: string; deals: number; revenue: number }[];
  };
  createdFullCycle: number;
  carryover: { amount: number; deals: number } | null;
  repeatClientsList: { clientName: string; orders: number; revenue: number }[];
  newClientsBySource: { ad: number; leadgen: number; other: number };
  transferred: {
    total: number;
    success: number;
    byTeam: { teamId: number; teamName: string; transferred: number; success: number; successRevenue: number }[];
  };
  adConversion: { leads: number; paid: number; conversion: number };
  leadgenConversion: { leads: number; paid: number; conversion: number };
  monthlyHistory: {
    month: string;
    deals: number;
    paid: number;
    revenue: number;
    conversion: number;
    avgCheck: number;
    adConversion: number;
    leadgenConversion: number;
    newClients: number;
    repeatClients: number;
  }[];
  byTeam: { teamId: number; teamName: string; revenue: number; deals: number }[];
  topManagers: { managerId: number; name: string; revenue: number; deals: number }[];
  receivablesTotal: number;
  createdLeads: number;
  newClients: number;
  newRevenue: number;
  repeatClients: number;
  repeatRevenue: number;
}

export async function fetchOverview(params: {
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<ExecutiveOverview> {
  const { data } = await api.get<ExecutiveOverview>("/dashboard/overview", { params });
  return data;
}

export interface Team {
  id: number;
  name: string;
}

export async function fetchTeams(): Promise<Team[]> {
  const { data } = await api.get<{ teams: Team[] }>("/teams");
  return data.teams;
}

export interface ManagerOption {
  id: number;
  name: string;
}

export async function fetchManagerOptions(): Promise<ManagerOption[]> {
  const { data } = await api.get<{ managers: ManagerOption[] }>("/teams/managers");
  return data.managers;
}

export interface ManagerWeekRow {
  weekStart: string;
  metric: string;
  plan: number;
  fact: number;
}

export interface ManagerBreakdown {
  id: number;
  name: string;
  weeks: ManagerWeekRow[];
  totals: Record<string, { plan: number; fact: number }>;
  forecast: Forecast;
}

export interface Forecast {
  plan: number;
  fact: number;
  remaining: number;
  projected: number;
  projectedPct: number;
  status: "no_plan" | "on_track" | "at_risk" | "behind";
}

export async function fetchManagerBreakdown(params: {
  teamId?: number;
  month?: string;
}): Promise<ManagerBreakdown[]> {
  const { data } = await api.get<{ managers: ManagerBreakdown[] }>("/dashboard/managers", {
    params,
  });
  return data.managers;
}

export interface PersonalDashboard {
  manager: { id: number; name: string };
  month: string;
  daysInMonth: number;
  daysElapsed: number;
  totals: Record<string, { plan: number; fact: number }>;
  forecast: Forecast;
  daily: Record<string, number | string>[];
  history: {
    month: string;
    factPaymentAmount: number;
    factPaid: number;
    planPaymentAmount: number;
  }[];
}

export async function fetchPersonalDashboard(params: {
  managerId?: number;
  month?: string;
}): Promise<PersonalDashboard> {
  const { data } = await api.get<PersonalDashboard>("/dashboard/personal", { params });
  return data;
}

export interface LoyaltyClient {
  clientKey: string;
  clientName: string;
  orders: number;
  totalPaid: number;
  lastPaid: string;
}

export interface LoyaltySegments {
  regular: LoyaltyClient[];
  occasional: LoyaltyClient[];
  sleeping: LoyaltyClient[];
  lost: LoyaltyClient[];
}

export interface LoyaltyManager {
  managerId: number;
  managerName: string;
  segments: LoyaltySegments;
  regularCount: number;
  occasionalCount: number;
  sleepingCount: number;
  lostCount: number;
}

export interface LoyaltyDynamics {
  months: { month: string; orders: number; amount: number }[];
  currentMonth: string;
  latestMonth: string | null;
  deltaOrders: number;
  deltaAmount: number;
  latestOrders: number;
  latestAmount: number;
}

export interface AppSettings {
  loyaltyThreshold: number;
  loyaltyWindowMonths: number;
  sleepingWindowMonths: number;
  receivablesOverdueWarnDays: number;
}

export async function fetchSettings(): Promise<AppSettings> {
  const { data } = await api.get<{ settings: AppSettings }>("/settings");
  return data.settings;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await api.put("/settings", settings);
}

export interface SyncStatus {
  lastSuccessAt: string | null;
  lastRunStartedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  lastDealCount: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const { data } = await api.get<SyncStatus>("/dashboard/sync-status");
  return data;
}

export async function triggerSync(): Promise<{ started: boolean }> {
  const { data } = await api.post<{ started: boolean }>("/dashboard/sync");
  return data;
}

export interface DashboardUser {
  id: number;
  email: string;
  role: "admin" | "team_lead" | "manager";
  is_active: boolean;
  initial_password: string | null;
  manager_name: string | null;
  team_name: string | null;
}

export async function fetchUsers(): Promise<DashboardUser[]> {
  const { data } = await api.get<{ users: DashboardUser[] }>("/settings/users");
  return data.users;
}

export async function createUser(payload: {
  email: string;
  password?: string;
  role: "manager" | "team_lead" | "admin";
  teamId?: number;
}): Promise<{ email: string; password: string }> {
  const { data } = await api.post<{ email: string; password: string }>("/settings/users", payload);
  return data;
}

export async function provisionUsers(): Promise<{ email: string; password: string; name: string }[]> {
  const { data } = await api.post<{ created: { email: string; password: string; name: string }[] }>(
    "/settings/users/provision"
  );
  return data.created;
}

export async function resetUserPassword(id: number): Promise<string> {
  const { data } = await api.post<{ password: string }>(`/settings/users/${id}/reset-password`);
  return data.password;
}

export async function updateUser(
  id: number,
  patch: { role?: "team_lead" | "manager"; isActive?: boolean }
): Promise<void> {
  await api.patch(`/settings/users/${id}`, patch);
}

export async function fetchLoyalty(params: {
  managerId?: number;
  teamId?: number;
  asOf?: string;
}): Promise<{ managers: LoyaltyManager[]; dynamics: LoyaltyDynamics }> {
  const { data } = await api.get<{ managers: LoyaltyManager[]; dynamics: LoyaltyDynamics }>(
    "/dashboard/loyalty",
    { params }
  );
  return data;
}

export interface ReceivableClient {
  clientKey: string;
  clientName: string;
  amount: number;
  limitDays: number | null;
  overdueDays: number | null;
  comment: string | null;
  dueDate: string | null;
}

export async function saveReceivableNote(payload: {
  clientKey: string;
  comment?: string | null;
  dueDate?: string | null;
}): Promise<void> {
  await api.put("/dashboard/receivables/note", payload);
}

export interface ReceivableManager {
  managerId: number;
  managerName: string;
  clients: ReceivableClient[];
  total: number;
}

export async function fetchReceivables(params: {
  managerId?: number;
  teamId?: number;
}): Promise<{ syncedAt: string | null; managers: ReceivableManager[] }> {
  const { data } = await api.get<{ syncedAt: string | null; managers: ReceivableManager[] }>(
    "/dashboard/receivables",
    { params }
  );
  return data;
}

export interface TeamRanking {
  teamId: number;
  teamName: string;
  revenue: number;
  deals: number;
  avgCheck: number;
  conversion: number;
  receivables: number;
}

export interface ReportData {
  granularity: "day" | "week" | "month";
  scope: "manager" | "team";
  summary: {
    successRevenue: number;
    successDeals: number;
    paymentRevenue: number;
    paymentDeals: number;
    revenue: number;
    deals: number;
    avgCheck: number;
    createdDeals: number;
    newClients: number;
    repeatClients: number;
    receivables: number;
    adLeads: number;
    quotes: number;
    dispatched: number;
    dispatchedSum: number;
    transfers: number;
    carryover: number;
    carryoverDeals: number;
  };
  byPeriod: { period: string; revenue: number; deals: number; created: number; avgCheck: number }[];
  byManager: {
    managerId: number;
    name: string;
    adLeads: number;
    quotes: number;
    dispatched: number;
    dispatchedSum: number;
    successRevenue: number;
    successDeals: number;
    paymentReceived: number;
    transfers: number;
    carryover: number;
    carryoverDeals: number;
    avgCheck: number;
  }[];
}

export async function fetchReport(params: {
  granularity: "day" | "week" | "month";
  from?: string;
  to?: string;
  managerId?: number;
  teamId?: number;
}): Promise<ReportData> {
  const { data } = await api.get<ReportData>("/dashboard/report", { params });
  return data;
}

export interface FunnelStageRow {
  stage: string;
  label: string;
  new: number;
  regular: number;
  leadgen: number;
  total: number;
  planMonth: number;
  planToDate: number;
}
export interface FunnelReport {
  scope: "manager" | "team";
  month: string;
  workingDays: { total: number; elapsed: number };
  stages: FunnelStageRow[];
  byManager: { managerId: number; name: string; stages: FunnelStageRow[] }[];
}
export async function fetchFunnelReport(params: {
  from?: string;
  to?: string;
  managerId?: number;
  teamId?: number;
}): Promise<FunnelReport> {
  const { data } = await api.get<FunnelReport>("/dashboard/funnel-report", { params });
  return data;
}

export interface WeeklyStageRow {
  stage: string;
  label: string;
  planMonth: number;
  planToday: number;
  factToday: number;
  weeks: { plan: number; fact: number }[];
}
export interface WeeklyBlock {
  name: string;
  stages: WeeklyStageRow[];
}
export interface FunnelWeeklyReport {
  scope: "manager" | "team";
  month: string;
  today: string;
  workingDays: { total: number; elapsed: number };
  weeks: { label: string; from: string; to: string }[];
  overall: WeeklyBlock;
  byManager: (WeeklyBlock & { managerId: number })[];
}
export async function fetchFunnelWeekly(params: {
  month?: string;
  to?: string;
  managerId?: number;
  teamId?: number;
}): Promise<FunnelWeeklyReport> {
  const { data } = await api.get<FunnelWeeklyReport>("/dashboard/funnel-weekly", { params });
  return data;
}

export async function fetchFunnelPlan(managerId: number, month: string): Promise<{ plans: Record<string, number> }> {
  const { data } = await api.get<{ plans: Record<string, number> }>("/dashboard/funnel-plan", { params: { managerId, month } });
  return data;
}
export async function saveFunnelPlan(payload: { managerId: number; month: string; plans: Record<string, number> }): Promise<void> {
  await api.post("/dashboard/funnel-plan", payload);
}

export async function fetchTeamsRanking(params: { from?: string; to?: string }): Promise<TeamRanking[]> {
  const { data } = await api.get<{ teams: TeamRanking[] }>("/dashboard/teams", { params });
  return data.teams;
}

export const FILES_BASE =(import.meta.env.VITE_API_URL ?? "http://localhost:4000/api").replace(/\/api$/, "");

export async function uploadFile(file: File): Promise<{ url: string; name: string }> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const { data } = await api.post<{ url: string; name: string }>("/uploads", {
    filename: file.name,
    dataBase64,
  });
  return data;
}

export interface NewsItem {
  id: number;
  category: "company" | "logistics" | "sales";
  title: string;
  body: string | null;
  author: string | null;
  image_url: string | null;
  created_at: string;
}

export interface KmPrices {
  price_date: string;
  t20: number | null;
  t10: number | null;
  t5: number | null;
  t2: number | null;
}

export async function fetchNews(category?: string): Promise<NewsItem[]> {
  const { data } = await api.get<{ news: NewsItem[] }>("/news", { params: category ? { category } : {} });
  return data.news;
}

export async function addNews(payload: { category: string; title: string; body?: string; imageUrl?: string }): Promise<void> {
  await api.post("/news", payload);
}

export async function deleteNews(id: number): Promise<void> {
  await api.delete(`/news/${id}`);
}

export async function fetchKmPrices(): Promise<KmPrices | null> {
  const { data } = await api.get<{ prices: KmPrices | null }>("/news/km-prices");
  return data.prices;
}

export async function saveKmPrices(p: {
  t20: number | null;
  t10: number | null;
  t5: number | null;
  t2: number | null;
}): Promise<void> {
  await api.put("/news/km-prices", p);
}

export interface ChatUser {
  id: number;
  name: string;
  email: string;
  team_name: string;
  unread: number;
  revenue: number;
  last_seen: string | null;
}

export async function heartbeat(): Promise<void> {
  await api.post("/messages/heartbeat").catch(() => {});
}

export interface ChatMessage {
  id: number;
  sender_id: number;
  recipient_id: number;
  body: string;
  attachment_url: string | null;
  attachment_name: string | null;
  created_at: string;
}

export async function fetchChatUsers(): Promise<ChatUser[]> {
  const { data } = await api.get<{ users: ChatUser[] }>("/messages/users");
  return data.users;
}

export async function fetchUnreadCount(): Promise<number> {
  const { data } = await api.get<{ unread: number }>("/messages/unread");
  return data.unread;
}

export async function fetchConversation(userId: number): Promise<ChatMessage[]> {
  const { data } = await api.get<{ messages: ChatMessage[] }>(`/messages/${userId}`);
  return data.messages;
}

export async function sendMessage(
  userId: number,
  body: string,
  attachment?: { url: string; name: string }
): Promise<ChatMessage> {
  const { data } = await api.post<{ message: ChatMessage }>(`/messages/${userId}`, {
    body,
    attachmentUrl: attachment?.url,
    attachmentName: attachment?.name,
  });
  return data.message;
}

export type TaskStatus =
  | "todo_list"
  | "to_realize"
  | "planned"
  | "not_started"
  | "deferred"
  | "in_progress"
  | "ball_on_executor"
  | "ready_for_approval"
  | "done";

export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  deadline: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  priority: TaskPriority;
  comments: string | null;
  department: string | null;
  taskType: "simple" | "weekly_kpi" | "monthly_kpi" | "daily_kpi";
  metric: "ads_count" | "avg_check" | "conversion" | null;
  targetValue: number | null;
  actualValue: number | null;
  planDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parentId: number | null;
  auto: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function createTaskPlan(payload: {
  assigneeId: number;
  period: "week" | "month";
  days: string[];
  adsCount?: number;
  leadgenCount?: number;
  avgCheck?: number;
  conversion?: number;
}): Promise<{ created: number }> {
  const { data } = await api.post<{ created: number }>("/tasks/plan", payload);
  return data;
}

export async function fetchTasks(): Promise<Task[]> {
  const { data } = await api.get<{ tasks: Task[] }>("/tasks");
  return data.tasks;
}

export async function createTask(payload: {
  title: string;
  status?: TaskStatus;
  deadline?: string | null;
  assigneeId?: number | null;
  priority?: TaskPriority;
  comments?: string | null;
  department?: string | null;
}): Promise<{ id: number }> {
  const { data } = await api.post<{ id: number }>("/tasks", payload);
  return data;
}

export async function updateTask(
  id: number,
  payload: Partial<{
    title: string;
    status: TaskStatus;
    deadline: string | null;
    assigneeId: number | null;
    priority: TaskPriority;
    comments: string | null;
    department: string | null;
  }>
): Promise<void> {
  await api.patch(`/tasks/${id}`, payload);
}

export async function deleteTask(id: number): Promise<void> {
  await api.delete(`/tasks/${id}`);
}
