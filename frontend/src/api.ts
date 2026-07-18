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
  // Empty/aborted responses (e.g. a malformed date range → 200 with empty body)
  // must not yield `undefined` — a non-iterable value crashes the whole app.
  return data?.stages ?? [];
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
  return data?.points ?? [];
}

export interface ConversionChannel {
  channel: string;
  label: string;
  leads: number;
  paid: number;
  paidAmount: number;
  conversion: number | null;   // ad → cohort (null коли entered<10); other → old %
  conversionPeriod?: number | null;
  mature?: boolean;
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
  planMonthTotal: number;
  projection: {
    monthFact: number;
    projected: number;
    plan: number;
    projectedPct: number | null;
    elapsedWorkingDays: number;
    totalWorkingDays: number;
  };
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
  dispatchedCount: number;
  createdByStage: { stage: string; label: string; deals: number; amount: number }[];
  carryover: { amount: number; deals: number } | null;
  repeatClientsList: { clientName: string; orders: number; revenue: number }[];
  newClientsList: { clientName: string; orders: number; revenue: number }[];
  newClientsBySource: { ad: number; leadgen: number; other: number };
  transferred: {
    total: number;
    success: number;
    byTeam: { teamId: number; teamName: string; transferred: number; success: number; successRevenue: number }[];
  };
  // КРОК 9-conv: конверсія з ядра. conversion=null → «—» (нерекламний/entered<10);
  // mature=false → бейдж «дозріває» (когорта <90 днів).
  adConversion: { leads: number; paid: number; conversion: number | null; conversionPeriod: number | null; mature: boolean };
  // Дві лідоген-плитки: won велике, handoff дрібне.
  prodzvinConversion: { entered: number; won: number | null; wonPeriod: number | null; handoff: number | null; mature: boolean };
  reactivationConversion: { entered: number; won: number | null; wonPeriod: number | null; handoff: number | null; mature: boolean };
  // Стара (Фаза 3 прибере) — лишена для сумісності.
  leadgenConversion: { leads: number; paid: number; conversion: number };
  monthlyHistory: {
    month: string;
    deals: number;
    paid: number;
    revenue: number;
    conversion: number;
    avgCheck: number;
    adConversion: number | null;
    prodzvinWon: number | null;
    reactivationWon: number | null;
    leadgenConversion: number;
    newClients: number;
    repeatClients: number;
  }[];
  byTeam: { teamId: number; teamName: string; revenue: number; deals: number }[];
  topManagers: { managerId: number; name: string; revenue: number; deals: number }[];
  receivablesTotal: number;
  receivablesCash: number;
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

export interface DataQualityCheck {
  key: string;
  label: string;
  count: number;
  sample: { kommoId: number; name: string | null; manager: string | null; extra: string | null }[];
}
export interface ReconCheck {
  key: string; label: string; value: number; threshold: number; ok: boolean; detail: string;
}
export interface Reconciliation {
  ranAt: string; warnings: number; checks: ReconCheck[];
}
export async function fetchDataQuality(): Promise<{ checks: DataQualityCheck[]; reconciliation: Reconciliation | null }> {
  const { data } = await api.get<{ checks: DataQualityCheck[]; reconciliation: Reconciliation | null }>("/dashboard/data-quality");
  return data;
}

export interface LeadQuality {
  targetLeads: number;
  nonTargetLeads: number;
  adBudgetPlan: number;
  adBudgetFact: number;
  adBudgetLeads: number;
}

export interface PlansGrid {
  month: string;
  daysInMonth: number;
  workingDays: number;
  weeks: { label: string; from: number; to: number; days: number }[];
  teams: {
    teamId: number; teamName: string;
    teamPlan: number; teamFact: number; teamCarryover: number; teamExpected: number;
    managers: { managerId: number; name: string; plan: number; fact: number; carryover: number; expected: number }[];
  }[];
  totalPlan: number;
  totalFact: number;
  totalCarryover: number;
  totalExpected: number;
}

export async function fetchPlansGrid(month: string, teamId?: number): Promise<PlansGrid> {
  const { data } = await api.get<PlansGrid>("/dashboard/plans-grid", { params: teamId ? { month, teamId } : { month } });
  return data;
}

export async function savePlan(managerId: number, month: string, plannedValue: number): Promise<void> {
  await api.post("/plans", { managerId, planDate: `${month}-01`, metric: "payment_amount", plannedValue });
}

// Repeat-client revenue plan (target earned from постійні клієнти), set monthly
// per manager, decomposed by weeks with auto-filled fact.
export interface RepeatPlansGrid {
  month: string;
  daysInMonth: number;
  workingDays: number;
  weeks: { label: string; from: number; to: number; days: number }[];
  teams: {
    teamId: number; teamName: string; teamPlan: number; teamFact: number;
    managers: {
      managerId: number; name: string; plan: number; fact: number;
      clients: RepeatClientPlan[];
    }[];
  }[];
  totalPlan: number;
  totalFact: number;
}

export interface RepeatClientPlan {
  clientKey: string;
  clientName: string;
  isCompany: boolean;
  identifier: string | null;
  orders: number;
  revenue: number;
  lastPaid: string;
  lastActivity: string | null;
  inactive: boolean;
  plan: number;
  fact: number;
  weekFact: number[];
  status: string; // 'none' | 'pending' | 'approved'
  forecast: string | null; // 'same' | 'down' | 'up'
  realizationPct: number | null;
  international: boolean | null;
  weDo: boolean | null;
  callLink: string | null;
  comment: string | null;
}

export interface RepeatClientPlanInput {
  clientKey: string;
  month: string; // YYYY-MM
  managerId: number;
  plan: number;
  forecast: string | null;
  realizationPct: number | null;
  international: boolean | null;
  weDo: boolean | null;
  callLink: string | null;
  comment: string | null;
}

export async function saveRepeatClientPlan(input: RepeatClientPlanInput): Promise<void> {
  await api.post("/dashboard/repeat-client-plan", input);
}

export async function approveRepeatClientPlan(clientKey: string, month: string, status: "approved" | "pending" = "approved"): Promise<void> {
  await api.post("/dashboard/repeat-client-plan/approve", { clientKey, month, status });
}

export async function approveAllRepeatClientPlans(month: string, teamId?: number): Promise<number> {
  const { data } = await api.post<{ ok: boolean; approved: number }>("/dashboard/repeat-client-plan/approve-all", { month, teamId });
  return data.approved;
}

export interface RepeatClientPlanHistoryEntry {
  changedAt: string;
  action: string;
  plan: number | null;
  status: string | null;
  comment: string | null;
  who: string | null;
}
export async function fetchRepeatClientPlanHistory(clientKey: string, month: string): Promise<RepeatClientPlanHistoryEntry[]> {
  const { data } = await api.get<{ history: RepeatClientPlanHistoryEntry[] }>("/dashboard/repeat-client-plan/history", { params: { clientKey, month } });
  return data.history;
}

export interface RepeatClientHistory {
  history: { month: string; orders: number; revenue: number }[];
  avgRecent: number;
  suggestedPlan: number;
}
export async function fetchRepeatClientHistory(clientKey: string): Promise<RepeatClientHistory> {
  const { data } = await api.get<RepeatClientHistory>("/dashboard/repeat-client-history", { params: { clientKey } });
  return data;
}

export interface ConversionTsPoint {
  bucket: string;
  leads: number;
  paid: number;
  conversion: number;
  adLeads: number;
  adPaid: number;
  adConversion: number | null;
}
export async function fetchConversionTimeseries(params: {
  from?: string;
  to?: string;
  granularity?: "day" | "week" | "month";
  managerId?: number;
  teamId?: number;
}): Promise<{ from: string; to: string; granularity: string; points: ConversionTsPoint[] }> {
  const { data } = await api.get<{ from: string; to: string; granularity: string; points: ConversionTsPoint[] }>("/dashboard/conversion-timeseries", { params });
  return data;
}

export async function fetchRepeatPlansGrid(month: string, teamId?: number, includeInactive?: boolean): Promise<RepeatPlansGrid> {
  const params: Record<string, string | number> = { month };
  if (teamId) params.teamId = teamId;
  if (includeInactive) params.includeInactive = 1;
  const { data } = await api.get<RepeatPlansGrid>("/dashboard/repeat-plans-grid", { params });
  return data;
}

export async function saveRepeatPlan(managerId: number, month: string, plannedValue: number): Promise<void> {
  await api.post("/plans", { managerId, planDate: `${month}-01`, metric: "repeat_payment_amount", plannedValue });
}

export async function fetchLeadQuality(params: {
  from?: string;
  to?: string;
  teamId?: number;
}): Promise<LeadQuality> {
  const { data } = await api.get<LeadQuality>("/dashboard/lead-quality", { params });
  return data;
}

// ── Департаментні плани КВП (Звіт КВП) ──
export type KvpPlans = Record<string, number>;
export async function fetchKvpPlan(month: string): Promise<KvpPlans> {
  const { data } = await api.get<{ plans: KvpPlans }>("/dashboard/kvp-plan", { params: { month } });
  return data?.plans ?? {};
}
export async function saveKvpPlan(month: string, plans: Record<string, number | null>): Promise<void> {
  await api.post("/dashboard/kvp-plan", { month, plans });
}

/** Додаткові факти Звіту КВП: відправлені авто (події), канали, менеджери. */
export interface KvpExtra {
  dispatched: { count: number; revenue: number };
  ad: { revenue: number; dispatched: number; dispatchedSum: number };
  leadgen: { revenue: number; dispatched: number; dispatchedSum: number };
  managersCount: number;
  /** Потік за період (надійшло В період, за подіями) — для тижневих зрізів. */
  flow: { received: number; ad: number; leadgen: number };
}
export async function fetchKvpExtra(params: { from?: string; to?: string }): Promise<KvpExtra> {
  const { data } = await api.get<KvpExtra>("/dashboard/kvp-extra", { params });
  return data;
}

export interface ResponseTimeBucket {
  key: string;
  label: string;
  hint: string;
  count: number;
  avgMin: number | null;
  medianMin: number | null;
  immediatePct: number;
}
export interface ResponseTime {
  from: string;
  to: string;
  buckets: ResponseTimeBucket[];
  totalCount: number;
  overallMedianMin: number | null;
  overallAvgMin: number | null;
  taken2minPct: number;
  taken15minPct: number;
  neglectedOver24h: number;
}
export async function fetchResponseTime(params: {
  from?: string;
  to?: string;
  managerId?: number;
  teamId?: number;
}): Promise<ResponseTime> {
  const { data } = await api.get<ResponseTime>("/dashboard/response-time", { params });
  return data;
}

export interface DutyAssignment {
  id: number;
  date: string;
  managerId: number;
  managerName: string;
  teamId: number | null;
  teamName: string | null;
  shift: string;
  note: string | null;
  mine: boolean;
}
export interface DutyManager {
  id: number;
  name: string;
  team_id: number | null;
  team_name: string | null;
}
export interface DutySchedule {
  from: string;
  to: string;
  assignments: DutyAssignment[];
  managers: DutyManager[];
  canEdit: boolean;
}
export async function fetchDutySchedule(params: { from: string; to: string; teamId?: number }): Promise<DutySchedule> {
  const { data } = await api.get<DutySchedule>("/duty", { params });
  return data;
}
export async function assignDuty(body: { date: string; managerId: number; shift?: string; note?: string }): Promise<{ ok: boolean; id: number }> {
  const { data } = await api.post<{ ok: boolean; id: number }>("/duty", body);
  return data;
}
export async function removeDuty(id: number): Promise<void> {
  await api.delete(`/duty/${id}`);
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
  teamId: number | null;
  teamName: string | null;
}

export async function fetchManagerOptions(teamId?: number): Promise<ManagerOption[]> {
  const { data } = await api.get<{ managers: ManagerOption[] }>("/teams/managers", { params: teamId ? { teamId } : undefined });
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
  expected: number; // «Очікування» — invoiced-stage snapshot
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
  isCompany: boolean;
  identifier: string | null;
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
  ratesFallbackFullPerKm: number;
  ratesFallbackPartPerKm: number;
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

/** Re-pull the receivables sheet on demand (paid invoices removed from the file
 *  drop off immediately). Resolves once the sync has finished. */
export async function triggerReceivablesSync(): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>("/dashboard/sync-receivables");
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
  patch: { role?: "admin" | "team_lead" | "manager"; isActive?: boolean }
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

export interface ReceivableInvoice {
  invoiceNo: string | null;
  invoiceDate: string | null;
  amount: number;
  serviceUrl: string | null;
  note: string | null;
  dueDate: string | null;
  comment: string | null;
}

export async function fetchReceivableInvoices(clientKey: string): Promise<ReceivableInvoice[]> {
  const { data } = await api.get<{ invoices: ReceivableInvoice[] }>("/dashboard/receivables/invoices", { params: { clientKey } });
  return data.invoices;
}

/** Дедлайн оплати + коментар до конкретного рахунку (менеджер — свої клієнти). */
export async function saveReceivableInvoiceNote(payload: {
  clientKey: string; invoiceNo: string; dueDate?: string | null; comment?: string | null;
}): Promise<void> {
  await api.put("/dashboard/receivables/invoice-note", payload);
}

// ── Реактивація клієнтів (сплячі/втрачені → в роботу менеджеру) ──
export interface ReactivationClient {
  clientKey: string;
  clientName: string;
  managerId: number;
  managerName: string;
  category: string | null;      // sleeping | lost
  plan: number;
  fact: number;                 // отримані кошти після взяття в роботу
  factDeals: number;
  contact1Date: string | null;
  contact1Result: string | null;
  contact2Date: string | null;
  contact2Result: string | null;
  status: "in_progress" | "reactivated" | "refused";
  comment: string | null;
  addedAt: string;
  lastPaid: string | null;
}
export async function fetchReactivation(params?: { teamId?: number; managerId?: number }): Promise<ReactivationClient[]> {
  const { data } = await api.get<{ clients: ReactivationClient[] }>("/dashboard/reactivation", { params });
  return data.clients;
}
export async function addReactivationClient(payload: {
  clientKey: string; clientName: string; managerId: number; category?: "sleeping" | "lost";
}): Promise<void> {
  await api.post("/dashboard/reactivation", payload);
}
export async function updateReactivationClient(payload: { clientKey: string } & Partial<{
  plan: number; contact1Date: string | null; contact1Result: string | null;
  contact2Date: string | null; contact2Result: string | null;
  status: string; comment: string | null; managerId: number;
}>): Promise<void> {
  await api.put("/dashboard/reactivation", payload);
}
export async function removeReactivationClient(clientKey: string): Promise<void> {
  await api.delete(`/dashboard/reactivation/${encodeURIComponent(clientKey)}`);
}

/** «Постійні від лідогену» — накопичений ефект за весь час. */
export interface LeadgenRegulars {
  touched: number;        // клієнтів з лідоген-дотиком
  paidOnce: number;       // оплатили 1 раз після дотику
  paidOnceSum: number;
  regulars: number;       // стали постійними (2+ оплати після дотику)
  regularsNew: number;    // з нуля (без оплат до)
  regularsReact: number;  // реактивовані
  revenueAfter: number;   // гроші постійних після дотику
  revenueNew: number;
  revenueReact: number;
  lifetime: number;
  avgPays: number;
  avgCheck: number;
}
export async function fetchLeadgenRegulars(): Promise<LeadgenRegulars> {
  const { data } = await api.get<LeadgenRegulars>("/dashboard/leadgen-regulars");
  return data;
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

export interface TeamManagerRow {
  id: number;
  name: string;
  revenue: number;
  deals: number;
  avgCheck: number;
  plan: number;
  planPct: number;
  receivables: number;
}
export interface TeamRanking {
  teamId: number;
  teamName: string;
  revenue: number;
  deals: number;
  avgCheck: number;
  conversion: number;
  receivables: number;
  managers: TeamManagerRow[];
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
    adPriceVoiced: number;
    adFirstTouchAnalyzed: number;
    dispatched: number;
    dispatchedSum: number;
    transfers: number;
    carryover: number;
    carryoverDeals: number;
    expected: number;      // грошова зона (expectedPaymentsByPlanned), Σ мгр = відділ
    projection: number;    // декомпозований прогноз (факт+зона+добір), Σ мгр = відділ
    plan: number;
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
    plan: number;
    expected: number;      // грошова зона по менеджеру
    projection: number;    // декомпозований прогноз по менеджеру
    conversion: number | null;    // null → «—» (нерекламний менеджер / entered<10)
    conversionEntered: number;
    conversionBase: string;
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
  money: {
    carryover: number; expected: number; received: number; receivedDeals: number;
    planMonth: number;
    weeks: { plan: number; fact: number; expected: number }[];
    daily: { date: string; v: number }[];
  };
}
export interface FunnelWeeklyReport {
  scope: "manager" | "team";
  granularity: "week" | "day";
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
  granularity?: "week" | "day";
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

export type FeedbackStatus = "pending" | "approved" | "rejected" | "resolved";
export interface FeedbackItem {
  id: number;
  section: string | null;
  message: string;
  status: FeedbackStatus;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  authorUserId: number;
  authorName: string;
}
export async function fetchFeedback(): Promise<FeedbackItem[]> {
  const { data } = await api.get<{ feedback: FeedbackItem[] }>("/feedback");
  return data.feedback;
}
export async function submitFeedback(payload: { message: string; section?: string }): Promise<FeedbackItem> {
  const { data } = await api.post<{ feedback: FeedbackItem }>("/feedback", payload);
  return data.feedback;
}
export async function updateFeedback(id: number, payload: { status: FeedbackStatus; adminNote?: string }): Promise<FeedbackItem> {
  const { data } = await api.patch<{ feedback: FeedbackItem }>(`/feedback/${id}`, payload);
  return data.feedback;
}

export interface AiAttachment { url: string; name: string }
export interface AiMessage {
  id: number;
  role: "user" | "assistant";
  body: string;
  status: string | null;
  attachments: AiAttachment[] | null;
  createdAt: string;
  authorName: string;
}
export async function fetchAiMessages(): Promise<AiMessage[]> {
  const { data } = await api.get<{ messages: AiMessage[] }>("/ai-work");
  return data.messages;
}
export async function postAiMessage(body: string, attachments?: AiAttachment[]): Promise<AiMessage> {
  const { data } = await api.post<{ message: AiMessage }>("/ai-work", { body, attachments });
  return data.message;
}

export interface ReportWidget {
  id: number;
  title: string;
  chartType: "table" | "bar" | "line" | "kpi";
  config: Record<string, unknown> | null;
  visibility: "admin" | "leads" | "all";
  rows: Record<string, unknown>[];
  error: string | null;
}
export async function fetchReports(): Promise<ReportWidget[]> {
  const { data } = await api.get<{ widgets: ReportWidget[] }>("/reports");
  return data.widgets;
}
export async function deleteReport(id: number): Promise<void> {
  await api.delete(`/reports/${id}`);
}

export interface RegularClient {
  clientKey?: string;
  clientName: string;
  isCompany: boolean;
  identifier: string | null;
  orders: number;
  revenue: number;
  lastPaid: string | null;
}
export async function fetchRegularClients(params?: { teamId?: number }): Promise<RegularClient[]> {
  const { data } = await api.get<{ clients: RegularClient[] }>("/dashboard/regular-clients", { params });
  return data.clients;
}

// ── Ручні правки постійних клієнтів (лише адмін) ──
export interface LoyaltyOverride {
  clientKey: string; clientName: string | null;
  hidden: boolean; pinnedManagerId: number | null; pinnedManagerName: string | null;
  forceRegular: boolean; note: string | null; updatedAt: string;
}
export async function fetchLoyaltyOverrides(): Promise<LoyaltyOverride[]> {
  const { data } = await api.get<{ overrides: LoyaltyOverride[] }>("/dashboard/loyalty-overrides");
  return data.overrides;
}
export async function saveLoyaltyOverride(payload: {
  clientKey: string; clientName?: string | null;
  hidden?: boolean; pinnedManagerId?: number | null; forceRegular?: boolean; note?: string | null;
}): Promise<void> {
  await api.post("/dashboard/loyalty-override", payload);
}
export async function removeLoyaltyOverride(clientKey: string): Promise<void> {
  await api.delete(`/dashboard/loyalty-override/${encodeURIComponent(clientKey)}`);
}

export interface DailyProductivity {
  date: string;
  managerName: string;
  teamName: string | null;
  taken: number;
  avto: number;
  paidCount: number;
  paidSum: number;
  planDay: number;
  planPct: number | null;
  trend: { day: string; amount: number }[];
}
export async function fetchDailyProductivity(params: { managerId?: number; date?: string }): Promise<DailyProductivity> {
  const { data } = await api.get<DailyProductivity>("/dashboard/daily", { params });
  return data;
}

export interface StuckDeal {
  kommoId: number;
  crmUrl: string;
  name: string;
  client: string | null;
  manager: string;
  price: number;
  stage: string;
  days: number;
  activityDays: number | null;
}
export async function fetchStuckDeals(params: { managerId?: number; teamId?: number; minDays?: number }): Promise<{ minDays: number; deals: StuckDeal[] }> {
  const { data } = await api.get<{ minDays: number; deals: StuckDeal[] }>("/dashboard/stuck-deals", { params });
  return data;
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
  taskType: "simple" | "weekly_kpi" | "monthly_kpi" | "daily_kpi" | "kpi_period" | "reactivation";
  metric: "ads_count" | "avg_check" | "conversion" | null;
  targetValue: number | null;
  actualValue: number | null;
  planDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parentId: number | null;
  auto: boolean;
  createdByRole?: "admin" | "team_lead" | "manager" | null;
  createdById?: number | null;
  assigneeTeamId?: number | null;
  metricsJson?: { metric: string; target: number; actual: number | null; done: boolean }[] | null;
  checklistJson?: ChecklistItem[] | null;
  subtasksJson?: Subtask[] | null;
  createdAt: string;
  updatedAt: string;
}
export interface Subtask { title: string; done?: boolean }

export interface ChecklistItem {
  clientKey: string;
  clientName: string;
  orders?: number;
  revenue?: number;
  lastPaid?: string | null;
  category?: string;
  paymentType?: string | null;
  done?: boolean;
  comment?: string | null;
}

export interface ReactivationCandidate {
  clientKey: string;
  clientName: string;
  isCompany: boolean;
  identifier: string | null;
  orders: number;
  revenue: number;
  lastPaid: string | null;
  lastActivity: string | null;
  category: "lapsed" | "oneshot_bg";
  paymentType: string | null;
}

export async function createReactivationTask(assigneeId: number, clients: ChecklistItem[]): Promise<{ id: number }> {
  const { data } = await api.post<{ id: number }>("/tasks/reactivation", { assigneeId, clients });
  return data;
}
export interface ReactivationManager {
  managerId: number;
  managerName: string;
  clients: ReactivationCandidate[];
}
export async function fetchReactivationCandidates(teamId?: number): Promise<ReactivationManager[]> {
  const { data } = await api.get<{ managers: ReactivationManager[] }>("/dashboard/reactivation-candidates", { params: teamId ? { teamId } : {} });
  return data.managers;
}

export async function createTaskPlan(payload: {
  assigneeId: number;
  period: "week" | "month";
  days: string[];
  adsCount?: number;
  leadgenCount?: number;
  dispatchCount?: number;
  avgCheck?: number;
  conversion?: number;
  paymentAmount?: number;
}): Promise<{ created: number }> {
  const { data } = await api.post<{ created: number }>("/tasks/plan", payload);
  return data;
}

export interface MonthlyGoal {
  id: number;
  month: string;
  teamId: number | null;
  teamName: string | null;
  title: string;
  target: string | null;
  status: "in_progress" | "done";
  comment: string | null;
  createdById: number | null;
  authorName: string | null;
}
export async function fetchGoals(month: string, opts: { scope?: "mine" | "teams"; teamId?: number } = {}): Promise<MonthlyGoal[]> {
  const params: Record<string, string | number> = { month };
  if (opts.scope) params.scope = opts.scope;
  if (opts.teamId) params.teamId = opts.teamId;
  const { data } = await api.get<{ goals: MonthlyGoal[] }>("/goals", { params });
  return data.goals;
}
export async function createGoal(payload: { month: string; title: string; target?: string | null; teamId?: number | null }): Promise<{ id: number }> {
  const { data } = await api.post<{ id: number }>("/goals", payload);
  return data;
}
export async function updateGoal(id: number, patch: Partial<{ title: string; target: string | null; status: "in_progress" | "done"; comment: string | null }>): Promise<void> {
  await api.patch(`/goals/${id}`, patch);
}
export async function deleteGoal(id: number): Promise<void> {
  await api.delete(`/goals/${id}`);
}

export interface ExpectedDeal {
  kommoId: number;
  managerId: number;
  managerName: string;
  clientName: string | null;
  amount: number;
  createdAt: string;
  invoicedAt: string | null;
}
export async function fetchExpectedDeals(params: { managerId?: number; teamId?: number } = {}): Promise<{ deals: ExpectedDeal[]; total: number }> {
  const { data } = await api.get<{ deals: ExpectedDeal[]; total: number }>("/dashboard/expected-deals", { params });
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
  assigneeIds?: number[];   // задача одразу на кількох менеджерів
  priority?: TaskPriority;
  comments?: string | null;
  department?: string | null;
}): Promise<{ id: number; ids?: number[] }> {
  const { data } = await api.post<{ id: number; ids?: number[] }>("/tasks", payload);
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
    checklistJson: ChecklistItem[] | null;
    subtasksJson: Subtask[] | null;
  }>
): Promise<void> {
  await api.patch(`/tasks/${id}`, payload);
}

export async function deleteTask(id: number): Promise<void> {
  await api.delete(`/tasks/${id}`);
}

// ── Калькулятор ставок (Lardi, формат оригінального lardiweb) ──
export interface Town { id: number; name: string; country: string | null; area: string; area_id: number | null; lat: number | null; lon: number | null; }
export interface BodyType { id: number; name: string; }
export interface RateSummary { n: number; min: number; median: number; avg: number; max: number; dropped?: number; }
export interface RateOffer {
  id: number; cargo: string | null; mass: number | null; load_type: string;
  total: number | null; per_ton: number | null; per_km: number | null; is_uah: boolean;
  currency: string | null; negotiable: boolean; bodies: string[]; company: string | null; face: string | null;
  phones: { n: string; m: string[] }[]; payform: string | null; from: string | null; to: string | null;
  dist_km: number | null; date: string | null; note?: string; ts?: number;
}
export interface RateClass {
  count: number; negotiable: number;
  uah: RateSummary | null; uah_per_ton: RateSummary | null; uah_per_km: RateSummary | null;
  other_currencies: Record<string, RateSummary | null>; median_distance: number | null;
}
export interface RateSide {
  count: number; scope: string;
  classes: { all: RateClass; full: RateClass; part: RateClass };
  class_counts: { full: number; part: number; unknown: number };
  top_cargo: [string, number][]; top_body: [string, number][];
  offers: RateOffer[]; history?: RateOffer[];
  error?: string; detail?: string;
}
export interface RateAnalysis {
  route: { from: string; to: string; distance_km: number | null };
  cargo: RateSide; lorry: RateSide;
  recommendation: {
    distance_km: number | null; cargo_median?: number; lorry_median?: number;
    band_low?: number; band_high?: number; per_km?: number; per_km_src?: string; per_km_total?: number;
  };
  /** Рекомендація за зонною картою КВП (зона області відправлення). */
  zone_recommendation?: {
    zone: "green" | "yellow" | "red"; zone_label: string; zone_src: string;
    from_area: string | null; to_area: string | null; tonnage: string;
    per_km_min: number; per_km_max: number;
    total_min: number | null; total_max: number | null; distance_km: number | null;
    short_haul?: boolean;
    margin?: number; client_min?: number | null; client_max?: number | null;
    options: { tonnage: string; margin: number; per_km_min: number; per_km_max: number; total_min: number | null; total_max: number | null; client_min: number | null; client_max: number | null; selected: boolean }[];
  } | null;
  /** Самонавчальна рекомендація з накопиченого архіву цін Ларді по маршруту. */
  learned_recommendation?: {
    source: string; samples: number; price_samples: number; since: string | null;
    confidence: "low" | "medium" | "high";
    per_km_median: number | null; per_km_p25: number | null; per_km_p75: number | null;
    carrier_median: number | null; carrier_min: number | null; carrier_max: number | null;
    short_haul: boolean; margin: number; client_min: number | null; client_max: number | null;
    distance_km: number | null;
    options: { tonnage: string; margin: number; client_min: number | null; client_max: number | null; selected: boolean }[];
  } | null;
}
export interface RatesUsageStats {
  days: number; total_requests: number; total_users: number;
  today_requests: number; today_users: number;
  by_day: { date: string; requests: number; users: number }[];
  top_routes: { route: string; count: number }[];
}

export async function fetchTowns(q: string): Promise<Town[]> {
  const { data } = await api.get<Town[]>("/rates/towns", { params: { q } });
  return data;
}
export async function fetchBodyTypes(): Promise<BodyType[]> {
  const { data } = await api.get<BodyType[]>("/rates/bodytypes");
  return data;
}
export async function fetchRatesHealth(): Promise<{ ok: boolean; has_token: boolean }> {
  const { data } = await api.get<{ ok: boolean; has_token: boolean }>("/rates/health");
  return data;
}
export async function fetchRatesStats(days = 30): Promise<RatesUsageStats> {
  const { data } = await api.get<RatesUsageStats>("/rates/stats", { params: { days } });
  return data;
}
export interface AnalyzePoint { town_id: number; area_id: number | null; lat: number | null; lon: number | null; label: string; area?: string | null; }
export async function analyzeRates(body: {
  frm: AnalyzePoint; to: AnalyzePoint; mass_min: number | null; mass_max: number | null; body_type_ids: number[];
}): Promise<RateAnalysis> {
  const { data } = await api.post<RateAnalysis>("/rates/analyze", body);
  return data;
}

// ── «Ціни по місту» (скритник → дашборд) ──
export type CityInfoCategory = "price" | "loaders" | "contact";
export interface CityInfoEntry {
  id: number; city: string; category: CityInfoCategory;
  title: string | null; phone: string | null; price: string | null; comment: string | null;
  authorUserId: number | null; authorName: string | null; updatedAt: string;
}
export async function fetchCityInfo(q?: string): Promise<CityInfoEntry[]> {
  const { data } = await api.get<{ entries: CityInfoEntry[] }>("/rates/city-info", { params: q ? { q } : {} });
  return data.entries;
}
export async function addCityInfo(body: {
  city: string; category: CityInfoCategory;
  title?: string; phone?: string; price?: string; comment?: string;
}): Promise<void> {
  await api.post("/rates/city-info", body);
}
export async function deleteCityInfo(id: number): Promise<void> {
  await api.delete(`/rates/city-info/${id}`);
}

// ── Перевізники з CRM (пошук по місту в маршруті угоди) ──
export interface CrmCarrier { name: string | null; phone: string; trips: number; lastTrip: string | null; routes: string[]; }
export async function fetchCarriers(city: string): Promise<{ carriers: CrmCarrier[]; processed: number }> {
  const { data } = await api.get<{ carriers: CrmCarrier[]; processed: number }>("/rates/carriers", { params: { city } });
  return data;
}

// ── Регламенти та документи (файлова база відділу) ──
export interface DocFolder { id: number; parent_id: number | null; name: string; created_at: string; }
export interface DocFile {
  id: number; folder_id: number | null; name: string; category?: string | null;
  mime: string | null; size_bytes: string | number | null; created_at: string; author?: string | null;
}
export const DOC_CATEGORIES = ["Регламент", "Шаблон", "Інструкція", "Інше"] as const;
export async function fetchDocTree(): Promise<{ folders: DocFolder[]; files: DocFile[] }> {
  const { data } = await api.get<{ folders: DocFolder[]; files: DocFile[] }>("/documents/tree");
  return { folders: data?.folders ?? [], files: data?.files ?? [] };
}
export async function createDocFolder(name: string, parentId: number | null): Promise<DocFolder> {
  const { data } = await api.post<DocFolder>("/documents/folder", { name, parentId });
  return data;
}
export async function renameDocFolder(id: number, name: string): Promise<void> {
  await api.patch(`/documents/folder/${id}`, { name });
}
export async function deleteDocFolder(id: number): Promise<void> {
  await api.delete(`/documents/folder/${id}`);
}
export async function uploadDocFile(body: {
  folderId: number | null; filename: string; mime: string | null; category?: string | null; dataBase64: string;
}, onProgress?: (pct: number) => void): Promise<DocFile> {
  const { data } = await api.post<DocFile>("/documents/file", body, {
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}
export async function updateDocFile(id: number, patch: { name?: string; category?: string | null }): Promise<void> {
  await api.patch(`/documents/file/${id}`, patch);
}
export async function deleteDocFile(id: number): Promise<void> {
  await api.delete(`/documents/file/${id}`);
}
/** Тягне файл авторизованим стрімом (Bearer у інтерсепторі) як blob-URL. */
export async function fetchDocFileBlobUrl(id: number): Promise<string> {
  const { data } = await api.get(`/documents/file/${id}/download`, { responseType: "blob" });
  return URL.createObjectURL(data as Blob);
}

// ── Навчання (training) ──
export interface TrainingFolder {
  id: number; parent_id: number | null; name: string; position: number; created_at: string;
}
export type TrainingKind = "video_embed" | "file" | "link" | "text";
export interface TrainingMaterial {
  id: number; folder_id: number | null; title: string; kind: TrainingKind;
  url: string | null; mime: string | null; size_bytes: string | number | null;
  content: string | null; position: number; created_at: string; author?: string | null;
}
export async function fetchTrainingTree(): Promise<{ folders: TrainingFolder[]; materials: TrainingMaterial[] }> {
  const { data } = await api.get<{ folders: TrainingFolder[]; materials: TrainingMaterial[] }>("/training/tree");
  return data;
}
export async function createTrainingFolder(name: string, parentId: number | null): Promise<TrainingFolder> {
  const { data } = await api.post<TrainingFolder>("/training/folder", { name, parentId });
  return data;
}
export async function updateTrainingFolder(id: number, patch: { name?: string; parentId?: number | null; position?: number }): Promise<void> {
  await api.patch(`/training/folder/${id}`, patch);
}
export async function deleteTrainingFolder(id: number): Promise<void> {
  await api.delete(`/training/folder/${id}`);
}
export async function createTrainingMaterial(body: {
  folderId: number | null; title: string; kind: TrainingKind;
  url?: string | null; content?: string | null;
  filename?: string; mime?: string | null; dataBase64?: string;
}, onProgress?: (pct: number) => void): Promise<TrainingMaterial> {
  const { data } = await api.post<TrainingMaterial>("/training/material", body, {
    onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100)); },
  });
  return data;
}
export async function updateTrainingMaterial(id: number, patch: { title?: string; content?: string | null; url?: string | null; folderId?: number | null; position?: number }): Promise<void> {
  await api.patch(`/training/material/${id}`, patch);
}
export async function deleteTrainingMaterial(id: number): Promise<void> {
  await api.delete(`/training/material/${id}`);
}
export async function fetchTrainingFileBlobUrl(id: number): Promise<string> {
  const { data } = await api.get(`/training/material/${id}/file`, { responseType: "blob" });
  return URL.createObjectURL(data as Blob);
}

// ── Ван-ту-вани (1-on-1) ──
export interface OneOnOneSubject {
  id: number; name: string; team_id: number | null; team_name: string | null;
  is_team_lead: boolean; overall: number | null; done: boolean; updated_at: string | null;
}
export type OneOnOneAnswers = Record<string, { score?: number; text?: string }>;
export interface OneOnOneRecord {
  subject_manager_id: number; month: string; answers: OneOnOneAnswers;
  overall: number | null; conducted_by_name?: string | null; updated_at?: string;
}
export async function fetchOneOnOneSubjects(month: string): Promise<{ month: string; subjects: OneOnOneSubject[] }> {
  const { data } = await api.get("/one-on-ones/subjects", { params: { month } });
  return { month: data?.month ?? month, subjects: data?.subjects ?? [] };
}
export async function fetchOneOnOne(managerId: number, month: string): Promise<OneOnOneRecord> {
  const { data } = await api.get<OneOnOneRecord>(`/one-on-ones/${managerId}`, { params: { month } });
  return data;
}
export async function saveOneOnOne(subjectManagerId: number, month: string, answers: OneOnOneAnswers): Promise<{ overall: number | null }> {
  const { data } = await api.post("/one-on-ones", { subjectManagerId, month, answers });
  return { overall: data?.overall ?? null };
}
export interface OneOnOneStatRow { id: number; name: string; team_id: number | null; team_name: string | null; month: string; overall: number | null; answers: OneOnOneAnswers; }
export async function fetchOneOnOneStats(months = 6): Promise<OneOnOneStatRow[]> {
  const { data } = await api.get<{ rows: OneOnOneStatRow[] }>("/one-on-ones/stats/scores", { params: { months } });
  return data?.rows ?? [];
}

// ── Статистики ───────────────────────────────────────────────────────────────
export type StatUnit = "uah" | "count" | "percent";
export type StatSource = "auto" | "manual" | "derived";
export type StatAggregation = "sum" | "avg" | "last";
export interface StatMetricDef {
  key: string; label: string; unit: StatUnit; source: StatSource;
  aggregation: StatAggregation; formula?: string; order: number; note?: string;
  csvIndexMonth?: number; csvIndexWeek?: number;
}
export interface StatDepartmentDef {
  key: string; label: string; tabMonth: string; tabWeek: string;
  hasTeamLeadBreakdown: boolean; csvDateIndex: number; metrics: StatMetricDef[];
}
export interface StatCatalog { departments: StatDepartmentDef[]; autoFrom: string; }
export interface StatValueRow {
  period_start: string; team_lead: string | null; metric_key: string;
  value: number | null; source: StatSource;
}
export interface StatValuesResponse {
  department: string; periodType: "month" | "week";
  scopedTo: string | null; rows: StatValueRow[];
  plans?: Record<string, number>; // `${period_start}|${team_lead}` → план (sales/month)
}

export async function fetchStatisticsCatalog(): Promise<StatCatalog> {
  const { data } = await api.get<StatCatalog>("/statistics/catalog");
  return data;
}
export async function fetchStatisticsValues(params: {
  department: string; period_type: "month" | "week"; from?: string; to?: string;
}): Promise<StatValuesResponse> {
  const { data } = await api.get<StatValuesResponse>("/statistics", { params });
  return data;
}
export async function saveStatisticsManual(body: {
  department: string; period_type: "month" | "week"; period_start: string;
  team_lead?: string | null; values: Record<string, number | null>;
}): Promise<{ ok: boolean; saved: number }> {
  const { data } = await api.put<{ ok: boolean; saved: number }>("/statistics/manual", body);
  return data;
}

// ───────────────────────── Р4b: ЄДИНИЙ ЗВІТ (manager-report) ─────────────────────────

export interface MRFunnelBucket {
  bucket: string; cohort: number;
  reached: { lead_taken: number; quote_requested: number; approved: number; invoiced: number; paid: number };
  pct: { lead_taken: number; quote_requested: number | null; approved: number | null; invoiced: number | null; paid: number | null };
  midfunnel: number; mature: boolean;
}
export interface MRBucket { deals: number; sum: number }
export interface MRConv { cohort?: number | null; won?: number | null; period?: number | null; handoff?: number | null; entered: number; mature: boolean; target: number; vsTarget: number | null }
export interface MRDelta { current: number | null; previous: number | null; delta: number | null; deltaPct: number | null; maturityMismatch?: boolean }
export interface ManagerReport {
  scope: { level: "department" | "team" | "manager"; id: number | null; period: { from: string; to: string; granularity: "month" | "week" }; compareWith: { from: string; to: string } | null };
  revenue: {
    plan: number; fact: number; successFlow: number; pctComplete: number | null; remaining: number;
    projection: { projected: number; projectedPct: number | null; zoneFull: number; zoneDeals: number; dobir: number; byPace: number; byPacePct: number | null; floor: number; floorPct: number | null; elapsedWorkingDays: number; totalWorkingDays: number };
  };
  funnel: MRFunnelBucket[];
  expected: { total: MRBucket; thisMonth: MRBucket; nextMonth: MRBucket; overdue: MRBucket; later: MRBucket; noDate: MRBucket };
  conversions: { ads: MRConv; prodzvin: MRConv; reactivation: MRConv };
  carryover: { amount: number; deals: number };
  weekly: { label: string; from: string; to: string; plan: number; fact: number; pct: number | null; remaining: number; status: "past" | "current" | "future" }[];
  expectedByTeam: { id: number; name: string; teamId: number | null; deals: number; sum: number }[];
  expectedByManager: { id: number; name: string; teamId: number | null; deals: number; sum: number }[];
  teams?: { teamId: number; teamName: string; plan: number; fact: number; pctPlan: number | null; remaining: number; expectedThisMonth: number; flowCur: number | null; flowPrev: number | null }[];
  managers?: { managerId: number; name: string; teamId: number | null; plan: number; fact: number; pctPlan: number | null; remaining: number; expectedThisMonth: number; flowCur: number | null; flowPrev: number | null }[];
  compare: Record<string, MRDelta> | null;
}

export async function fetchManagerReport(params: {
  level: "department" | "team" | "manager"; id?: number;
  from: string; to: string; granularity: "month" | "week";
  compareFrom?: string; compareTo?: string;
}): Promise<ManagerReport> {
  const { data } = await api.get<ManagerReport>("/dashboard/manager-report", { params });
  return data;
}
