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
  adConversion: { leads: number; paid: number; conversion: number };
  leadgenConversion: { leads: number; paid: number; conversion: number };
  monthlyHistory: {
    month: string;
    deals: number;
    paid: number;
    revenue: number;
    conversion: number;
    avgCheck: number;
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

export const FILES_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:4000/api").replace(/\/api$/, "");

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
