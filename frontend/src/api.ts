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
  leads: number;
  reachedPaid: number;
  conversion: number;
  bySource: LeadgenSource[];
}

export async function fetchLeadgen(params: {
  managerId?: number;
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<LeadGenerator[]> {
  const { data } = await api.get<{ generators: LeadGenerator[] }>("/dashboard/leadgen", {
    params,
  });
  return data.generators;
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
  deltaOrders: number;
  deltaAmount: number;
  latestOrders: number;
  latestAmount: number;
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
  createdAt: string;
  updatedAt: string;
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
