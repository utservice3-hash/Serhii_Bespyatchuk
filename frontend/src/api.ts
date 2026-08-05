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
// Хостинговий «I'm Under Attack» повертає HTML-сторінку-челендж (часто зі статусом 200).
// Ловимо: якщо очікували JSON, а прийшов HTML — це НЕ дані. Кидаємо помилку з isChallenge,
// щоб авто-ретраї робили backoff (не тайт-петлю) і UI не намагався читати HTML як дані.
function looksLikeChallenge(res: { headers?: unknown; data?: unknown }): boolean {
  const ct = String((res.headers as Record<string, unknown> | undefined)?.["content-type"] ?? "");
  if (ct.includes("application/json")) return false;
  return typeof res.data === "string" && /^\s*<(?:!doctype|html)/i.test(res.data);
}
api.interceptors.response.use(
  (res) => {
    if (looksLikeChallenge(res)) {
      const err = new Error("challenge") as Error & { isChallenge: boolean };
      err.isChallenge = true;
      return Promise.reject(err);
    }
    return res;
  },
  (error) => {
    if (error.response?.status === 401 && localStorage.getItem("token")) {
      localStorage.removeItem("token");
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    // 429 / 503 (rate-limit або челендж) — позначаємо для backoff у авто-ретраях.
    const st = error.response?.status;
    if (st === 429 || st === 503) (error as { isChallenge?: boolean }).isChallenge = true;
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
  /** ПЕРЕДАЧІ заявок менеджеру, не унікальні ліди. */
  leads: number;
  uniqueLeads: number;
  reachedPaid: number;
  conversion: number;
  bySource: LeadgenSource[];
}

export interface LeadgenGroup {
  teamName: string;
  isLeadgen: boolean;
  /** ПЕРЕДАЧІ (рядки реєстру бота) — головна цифра, рішення власника 04.08.2026. */
  leads: number;
  /** Довідково: скільки з них РІЗНИХ лідів. Складати з `leads` не можна. */
  uniqueLeads: number;
  reachedPaid: number;
  generators: LeadGenerator[];
}

export interface LeadgenResp {
  groups: LeadgenGroup[];
  /** Одиниця лічби — передача; підпис приходить із сервера, не зашитий у фронт. */
  unit: string;
  /** Розріз: менеджер-ОТРИМУВАЧ (імені лідогенератора в реєстрі немає). */
  dimensionNote: string;
}
export async function fetchLeadgen(params: {
  managerId?: number;
  teamId?: number;
  from?: string;
  to?: string;
}): Promise<LeadgenResp> {
  const { data } = await api.get<LeadgenResp>("/dashboard/leadgen", { params });
  return data;
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
  // Крок В #4: КОГОРТА переданих заявок → MONEY_ZONE (стеля ≤100%, ⏳, entered<10 → «—»).
  leadgenConversion: { leads: number; paid: number; conversion: number | null; conversionPeriod: number | null; mature: boolean };
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
  /**
   * 🔴 УНІКАЛЬНІ КЛІЄНТИ в періоді (рішення власника 04.08.2026): один клієнт =
   * один цільовий лід. Сира кількість угод — окремо у `targetLeadDeals`, щоб
   * різницю було видно, а не щоб її склали. Підпис бере `targetLeadsNote`.
   */
  targetLeads: number;
  targetLeadDeals: number;
  targetLeadsNote: string;
  nonTargetLeads: number | null;
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

// ───────────────────────── ФОРМУВАННЯ ПЛАНУ (двоетапне погодження) ─────────────────────────
export interface PFRecommendation {
  value: number; perWorkingDay: number; baseSum: number; baseWorkingDays: number;
  targetWorkingDays: number; baseMonthlyAvg: number; growthPct: number; sparseHistory: boolean;
}
export interface PFCountSum { count: number; sum: number }
export interface PFClients { repeat: PFCountSum; leadgen: PFCountSum; new: PFCountSum; undef: PFCountSum; total: PFCountSum }
export type PFStatus = "draft" | "submitted" | "approved" | "returned";
export interface PFState {
  status: PFStatus; proposedValue: number | null; comment: string | null; returnComment: string | null;
  /** На момент ПОДАЧІ сума була нижча за поріг — ставить сервер; для бейджа й майбутніх звітів. */
  belowMin?: boolean;
  submittedBy: string | null; submittedAt: string | null; decidedBy: string | null; decidedAt: string | null;
}
export interface PFManager {
  managerId: number; name: string; teamId: number | null; teamName: string | null;
  history: { month: string; revenue: number; deals: number }[];
  recommendation: PFRecommendation;
  clients: PFClients;
  carryover: number; currentPlan: number;
  /** Довідково з екрана «Постійні клієнти»: що заявлено вручну і що погоджено по клієнтах. */
  repeatClients?: { approved: number; approvedClients: number; entered: number; declared: number };
  formation: PFState;
}
export interface PFTeam {
  teamId: number | null; teamName: string; total: number;
  recommended: number; carryover: number; approved: number; submitted: number;
  managers: PFManager[];
}
export interface PlanFormation {
  month: string; refMonth: string; growthPct: number;
  role: string; canApprove: boolean; canSubmit: boolean; teams: PFTeam[];
  /** Мʼяка нижня межа плану на менеджера (₴) з налаштувань; 0 = вимкнено. */
  minPerManager?: number;
}
export async function fetchPlanFormation(month: string, teamId?: number, growth?: number): Promise<PlanFormation> {
  const params: Record<string, string | number> = { month };
  if (teamId) params.teamId = teamId;
  if (growth != null) params.growth = growth;
  const { data } = await api.get<PlanFormation>("/plans/formation", { params });
  return data;
}

export interface PFRepeatClient { clientKey: string; name: string; revenue: number; orders: number; deltaPct: number | null }
export interface PFRepeatBreakdown {
  clients: PFRepeatClient[]; rest: { count: number; revenue: number };
  totalRevenue: number; totalClients: number;
}
export async function fetchFormationRepeatClients(managerId: number, month: string): Promise<PFRepeatBreakdown> {
  const { data } = await api.get<PFRepeatBreakdown>("/plans/formation/repeat-clients", { params: { managerId, month } });
  return data;
}
export async function submitFormationPlan(managerId: number, month: string, proposedValue: number, comment?: string): Promise<void> {
  await api.post("/plans/formation/submit", { managerId, month, proposedValue, comment });
}
export async function approveFormationPlan(body: { managerId?: number; teamId?: number; month: string }): Promise<{ approved: number }> {
  const { data } = await api.post<{ ok: boolean; approved: number }>("/plans/formation/approve", body);
  return data;
}
export async function returnFormationPlan(managerId: number, month: string, returnComment?: string): Promise<void> {
  await api.post("/plans/formation/return", { managerId, month, returnComment });
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

// ── КРОК Д: композитний Звіт КВП (/kvp-report) ──
export interface KvpAgg { deals: number; revenue: number }
export interface KvpEngineTeam { plan: number; revenue: number; expected: number; pct: number | null; conversion: number | null; entered: number }
export interface KvpDay { bucket: string; revenue: number; deals: number }
export interface KvpWeek { idx: number; from: string; to: string; plan: number; fact: number; expected: number; auto: number; autoRevenue: number; leadsAd: number; leadsLeadgen: number; met: boolean; isCurrent: boolean; isFuture: boolean; pace: number | null }
export interface KvpDeptWeek { idx: number; from: string; to: string; plan: number; fact: number; expected: number; auto: number; autoRevenue: number; leadsAd: number; leadsLeadgen: number; success: number; newRecv: number; repeatRecv: number; lostDeals: number; lostSum: number; expectedPlanned: number; isCurrent: boolean; isFuture: boolean; pace: number | null }
export interface CreatedSplit { created: number; new: number; repeat: number; undef: number }
export interface KvpManager {
  managerId: number; name: string; plan: number; revenue: number; pct: number | null;
  avgCheck: number; successDeals: number; conversion: number | null; convEntered: number; expected: number;
  // #4 «в очікуванні оплат» ср.чек (chainInflight знімок) · #2 очікування за план. датою.
  avgCheckAwaiting: number | null; awaitingDeals: number; expectedThisMonth: number; expectedNextMonth: number;
  createdSplit: CreatedSplit;
  daily: KvpDay[]; weeks: KvpWeek[];
}
export interface KvpExpBucket { deals: number; sum: number }
// Крок Д фінал A — детальний дрил менеджера weeks→days (лінивий фетч)
export interface KvpDetailCell {
  created: number; newCount: number; repeatCount: number; undefCount: number;
  leadsAd: number; leadsLeadgen: number; leadsOther: number; dispatched: number;
  // Розбивка відправлених авто за джерелом (постійний / лідоген / реклама / невизн). Σ = dispatched.
  dispRepeat: number; dispLeadgen: number; dispAd: number; dispUndef: number;
  received: { deals: number; revenue: number }; expected: { deals: number; sum: number };
}
export interface KvpDetailWeek { idx: number; from: string; to: string; isCurrent: boolean; isFuture: boolean; total: KvpDetailCell; days: (KvpDetailCell & { day: string })[] }
export interface KvpManagerDetail {
  managerId: number; name: string; isRnk: boolean; from: string; to: string;
  weeks: KvpDetailWeek[]; monthTotals: KvpDetailCell;
}
export async function fetchManagerDetail(params: { managerId: number; from: string; to: string }): Promise<KvpManagerDetail> {
  const { data } = await api.get<KvpManagerDetail>("/dashboard/kvp-report/manager-detail", { params });
  return data;
}
export interface KvpTeam {
  teamId: number; name: string; kind: "rpk" | "rnk" | "leadgen";
  plan: number; revenue: number; expected: number; pct: number | null;
  conversion: number | null; entered: number; won: number; managers: KvpManager[];
  // #3 лайфтайм-конверсія (Варіант A, весь час): РНК÷реклама, РПК÷лідген; ≤100%.
  convLifetime: { num: number; den: number; pct: number | null };
  // #4 два чеки команди: «успішно» (success за місяць) + «в очікуванні» (chainInflight знімок).
  avgCheckSuccess: number | null; avgCheckAwaiting: number | null;
  expectedThisMonth: number; expectedNextMonth: number; weeks: KvpWeek[];
}
export interface KvpSignal { severity: "critical" | "serious" | "warning" | "info"; icon: string; title: string; detail: string; action: string; expectedThisMonth?: number; expectedNextMonth?: number }
export interface KvpSeriesRow { ym: string; [k: string]: number | string | boolean }
export interface KvpReport {
  scope: { from: string; to: string; prevFrom: string; prevTo: string; preset: string; label: string; isCurrent: boolean };
  weekBlocks: { idx: number; from: string; to: string; isCurrent: boolean; isFuture: boolean; pace: number | null; workingDays: number }[];
  deptWeeks: KvpDeptWeek[];
  strategicPlan: number;
  newMetrics: {
    forecast: { projected: number; fact: number; projectedPct: number | null };
    neededPacePerDay: number | null; remainingWorkingDays: number; remainingPlan: number;
    overduePayments: { count: number; sum: number };
    cac: number | null; cacBudget: number; cacNewClients: number;
    avgCycleDays: number | null;
    lost: { deals: number; sum: number; nonTargetLeads: number | null };
  };
  verdict: {
    received: KvpAgg; receivedPrev: { revenue: number }; strategicPlan: number; planPct: number | null;
    projection: { fact: number; projected: number; projectedPct: number; elapsedWorkingDays: number; totalWorkingDays: number };
    lifecycle: { sent: KvpAgg; awaiting: KvpAgg; received: KvpAgg };
    derived: { base: number; low: number; target: number; high: number };
  };
  signals: KvpSignal[];
  engines: {
    rpk: KvpEngineTeam; rnk: KvpEngineTeam; leadgenTeam: KvpEngineTeam;
    ad: { budget: number; gaLeads: number; romi: number | null; cpa: number | null; cplGa: number | null; cplCrm: number | null; conversion: number | null; entered: number; won: number; mature: boolean; revenue: number };
    leadgen: { transferred: number; transferredWon: number; dispatched: number; dispatchedRevenue: number; revenue: number };
  };
  teams: KvpTeam[];
  logistics: {
    direction: { key: string; revenue: number; deals: number; conversion: number | null; convEntered: number }[];
    salesChannel: { key: string; revenue: number; deals: number }[];
    transit: { avg: number | null; median: number | null; n: number };
    dso: { avg: number | null; median: number | null; n: number };
    aging: { buckets: { bucket: string; count: number; sum: number }[]; reversals: { count: number; sum: number } };
    concentration: { topN: number; topRevenue: number; totalRevenue: number; pct: number | null; clients: number; topClients: { key: string; revenue: number; deals: number }[] };
    repeatRides: { bucket: string; clients: number; revenue: number }[];
    fillRates: { requestType: number; salesChannel: number };
    margin: null;
  };
  retention: {
    newToRepeat: { ym: string; cohort: number; became: number; pct: number | null; mature: boolean }[];
    activeBase: { ym: string; activeClients: number }[];
    weeklyRegulars: { clients: number; windowWeeks: number; minWeeks: number };
    nonTarget: number | null;
    receivablesPaidOff: null;
  };
  revenueStructure: {
    received: { new: KvpAgg; repeat: KvpAgg; unattributed: KvpAgg; total: KvpAgg };
    expected: { new: KvpExpBucket; repeat: KvpExpBucket; unattributed: KvpExpBucket; total: KvpExpBucket };
  };
  segments: {
    totals: { newClients: number; newRevenue: number; repeatClients: number; repeatRevenue: number };
    byManager: { id: number; name: string; teamId: number | null; newClients: number; newRevenue: number; repeatClients: number; repeatRevenue: number }[];
    byTeam: { id: number; name: string; teamId: number | null; newClients: number; newRevenue: number; repeatClients: number; repeatRevenue: number }[];
  };
  createdSplit: {
    totals: CreatedSplit;
    byManager: (CreatedSplit & { managerId: number; name: string; teamId: number | null })[];
  };
  money: { received: KvpAgg; success: KvpAgg; paidOnly: KvpAgg; awaitingNow: { deals: number; revenue: number }; expectedThis: KvpExpBucket; expectedNext: KvpExpBucket; expectedZoneTotal: KvpExpBucket };
  funnel: { stage: string; deals: number; revenue: number }[];
}
// ── ЗВІТ (лендинг) — план із задачника + факт із core (макет zvit_v2) ──
export interface ReportPlanKpi { fact: number | null; target: number; taken?: number; won?: number; revenue?: number;
  // Тільки для «dispatch» (авто): розбивка факту за джерелом. Σ(repeat+leadgen+ad+undef) = fact.
  repeat?: number; leadgen?: number; ad?: number; undef?: number;
  // Тільки для «avgCheck» (#4): пул reportChain — signed Σ÷count (revenue/deals для Σ/Σ).
  deals?: number }
export interface ReportPlanManager {
  managerId: number; name: string; teamId: number | null; teamName: string | null;
  tag: "rpk" | "rnk" | "self";
  plan: number; fact: number; expect: number; pct: number | null;
  factSuccess: number; factPaid: number; // #1 круг оплати: факт = успішно ⊎ оплачено
  expectThisMonth: number; expectNextMonth: number; // #2 за плановою датою оплати
  // #P1 динамічна тижнева ціль (Variant A: manual ?? dynamic — одна цифра з Задачником).
  week: { target: number; dynamic: number; manual: number | null; isManual: boolean; fact: number; dayTarget: number; weeksLeft: number; presentDaysLeftWeek: number };
  projected: number; monthInProgress: boolean;
  created: number; new: number; rep: number;
  status: "g" | "a" | "r"; needPerDay: number; remainingWorkdays: number;
  spark: number[];
  kpi: { ads: ReportPlanKpi; leadgen: ReportPlanKpi; dispatch: ReportPlanKpi; avgCheck: ReportPlanKpi; conversion: ReportPlanKpi };
}
export interface ReportPlan {
  scope: { from: string; to: string; isCurrent: boolean };
  role: string; viewerManagerId: number | null; elapsed: number; remainingWorkdays: number;
  glance: { plan: number; fact: number; factSuccess: number; factPaid: number; expect: number; expectThisMonth: number; expectNextMonth: number;
    dispatched: number; dispatchedRevenue: number; created: number; avgCheck: number | null; statusCounts: { g: number; a: number; r: number } };
  managers: ReportPlanManager[];
}
export async function fetchReportPlan(params: { from: string; to: string; managerId?: number; teamId?: number }): Promise<ReportPlan> {
  const { data } = await api.get<ReportPlan>("/dashboard/report-plan", { params });
  return data;
}
export interface ReportPlanDeal { name: string; src: "new" | "rep"; price: number; status: string }
export async function fetchReportPlanDeals(params: { managerId: number; date: string }): Promise<ReportPlanDeal[]> {
  const { data } = await api.get<{ deals: ReportPlanDeal[] }>("/dashboard/report-plan/deals", { params });
  return data.deals;
}

export async function fetchKvpReport(params: { preset?: string; date?: string; from?: string; to?: string }): Promise<KvpReport> {
  const { data } = await api.get<KvpReport>("/dashboard/kvp-report", { params });
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
// Календар команди — відсутності (окремий шар від чергування).
export type AbsenceKind = "day_off" | "vacation" | "sick" | "short_day";
export type AbsenceStatus = "pending" | "approved" | "rejected";
export interface Absence {
  id: number; managerId: number; managerName: string; teamId: number | null; teamName: string | null;
  kind: AbsenceKind; startDate: string; endDate: string; hours: number | null; note: string | null;
  status: AbsenceStatus; createdBy: number | null; createdAt: string;
  approvedBy: number | null; approverName: string | null; approvedAt: string | null; mine: boolean;
}
export interface Holiday { id: number; date: string; name: string }
export interface CalendarManager { id: number; name: string; teamId: number | null; teamName: string | null }
export interface DutySchedule {
  from: string;
  to: string;
  assignments: DutyAssignment[];
  absences: Absence[];
  holidays: Holiday[];
  managers: DutyManager[];
  absenceManagers: CalendarManager[];
  canEdit: boolean;
  pendingCount: number;
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
export async function createAbsence(body: { managerId?: number; kind: AbsenceKind; startDate: string; endDate?: string; hours?: number; note?: string }): Promise<{ ok: boolean; id: number; status: AbsenceStatus }> {
  const { data } = await api.post<{ ok: boolean; id: number; status: AbsenceStatus }>("/duty/absences", body);
  return data;
}
export async function decideAbsence(id: number, decision: "approve" | "reject"): Promise<{ ok: boolean; status: AbsenceStatus }> {
  const { data } = await api.post<{ ok: boolean; status: AbsenceStatus }>(`/duty/absences/${id}/${decision}`, {});
  return data;
}
export async function removeAbsence(id: number): Promise<void> {
  await api.delete(`/duty/absences/${id}`);
}
export async function createHoliday(body: { date: string; name: string }): Promise<{ ok: boolean; id: number }> {
  const { data } = await api.post<{ ok: boolean; id: number }>("/duty/holidays", body);
  return data;
}
export async function removeHoliday(id: number): Promise<void> {
  await api.delete(`/duty/holidays/${id}`);
}
export interface PresenceDay { date: string; present: boolean; reason: string | null; partialHours: number | null }
export async function fetchPresence(params: { managerId: number; from: string; to: string }): Promise<{ managerId: number; from: string; to: string; days: PresenceDay[]; workingDaysPresent: number }> {
  const { data } = await api.get("/duty/presence", { params });
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
  name: string | null;                       // ПІБ: CRM-менеджерам з CRM, ручним — редаговане
  synced_role: "admin" | "team_lead" | "manager"; // CRM-owned (синк)
  role_override: string | null;              // панель-owned (переважає)
  role_effective: string;                    // = role_override ?? synced_role
  is_active: boolean;
  crm_linked: boolean;                        // ідентичність із CRM (ПІБ/команда/синк-роль read-only)
  tracker_enabled: boolean;                   // ⏱ дозвіл трекеру часу збирати дані з машини людини
  team_name: string | null;
  deactivated_at?: string | null;
  deactivated_reason?: string | null;
}

export async function fetchUsers(archived = false): Promise<DashboardUser[]> {
  const { data } = await api.get<{ users: DashboardUser[] }>("/settings/users", { params: archived ? { archived: 1 } : {} });
  return data.users;
}

export async function createUser(payload: {
  email: string;
  password?: string;
  role: string;
  teamId?: number;
  fullName?: string;
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
  patch: { roleOverride?: string | null; isActive?: boolean; fullName?: string; reason?: string; trackerEnabled?: boolean }
): Promise<void> {
  await api.patch(`/settings/users/${id}`, patch);
}

export async function reactivateUser(id: number): Promise<void> {
  await api.post(`/settings/users/${id}/reactivate`);
}

// --- Ролі та доступи ---
export interface RoleDef {
  key: string;
  name: string;
  built_in: boolean;
  data_scope: "own" | "team" | "company";
  screen_access: Record<string, boolean>;
  permissions: Record<string, boolean>;
  cloned_from: string | null;
  users_count: number;
}

export async function fetchRoles(): Promise<RoleDef[]> {
  const { data } = await api.get<{ roles: RoleDef[] }>("/settings/roles");
  return data.roles;
}

export async function createRole(payload: {
  key: string; name: string; cloneFrom?: string;
  dataScope?: string; screenAccess?: Record<string, boolean>; permissions?: Record<string, boolean>;
}): Promise<void> {
  await api.post("/settings/roles", payload);
}

export async function updateRole(key: string, payload: {
  name: string; dataScope: string; screenAccess: Record<string, boolean>; permissions: Record<string, boolean>;
}): Promise<void> {
  await api.put(`/settings/roles/${key}`, payload);
}

export async function deleteRole(key: string): Promise<void> {
  await api.delete(`/settings/roles/${key}`);
}

// --- Журнал змін ---
export interface AuditEntry {
  id: number;
  at: string;
  actor_email: string | null;
  action: string;
  target_type: "user" | "role";
  target_id: string;
  target_label: string | null;
  details: Record<string, unknown>;
}

export async function fetchAudit(): Promise<AuditEntry[]> {
  const { data } = await api.get<{ audit: AuditEntry[] }>("/settings/audit");
  return data.audit;
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
// uiSection — назва відкритого розділу дашборду: їде в системний промт, щоб питання
// «поясни цей блок» працювало без уточнень.
export async function postAiMessage(body: string, attachments?: AiAttachment[], uiSection?: string): Promise<AiMessage> {
  const { data } = await api.post<{ message: AiMessage }>("/ai-work", { body, attachments, uiSection });
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

// Застряглі угоди ЗГРУПОВАНІ по менеджерах (без «стелі 50») + company-summary.
export interface StuckGroupDeal { kommoId: number; crmUrl: string; name: string; client: string | null; price: number; stage: string; days: number; activityDays: number | null; lastCallAt: string | null; daysSinceLastCall: number | null; noCallFlag: boolean;
  // Нотатка менеджера по угоді. canEditNote рахує СЕРВЕР (відповідальний + тімлід/адмін);
  // тут вона лише керує тим, показати поле чи текст — write-роут перевіряє право сам.
  note: string | null; noteAuthor: string | null; noteAt: string | null; canEditNote: boolean }
export interface StuckManagerGroup { managerId: number; manager: string; teamId: number | null; teamTag: string | null; count: number; sumAtRisk: number; longestIdleDays: number; deals: StuckGroupDeal[] }
export interface StuckGrouped { minDays: number; role: string; scope: "company" | "team" | "own"; total: number; sumRisk: number; managers: number; over90: number; groups: StuckManagerGroup[] }
export async function saveDealNote(kommoId: number, comment: string): Promise<{ note: string | null; noteAuthor: string | null; noteAt: string | null }> {
  const { data } = await api.post<{ note: string | null; noteAuthor: string | null; noteAt: string | null }>("/dashboard/deal-note", { kommoId, comment });
  return data;
}
export async function fetchStuckGrouped(params: { teamId?: number; managerId?: number }): Promise<StuckGrouped> {
  const { data } = await api.get<StuckGrouped>("/dashboard/stuck-deals-grouped", { params });
  return data;
}

// ── Статистики (діаграми) ──
export interface StatsPoint { period: string; value: number; source: "sheet" | "crm" | "manual" }
export interface StatsSeries { scopeType: string; scopeKey: string; scopeName: string; points: StatsPoint[]; benchmark?: boolean }
export interface StatsSeriesResp { block: string; metric: string; granularity: "day" | "week" | "month"; seam: string; crmAble: boolean; live: boolean; series: StatsSeries[] }
export async function fetchStatsSeries(params: { block: string; metric: string; granularity: string; from?: string; to?: string; unit?: string }): Promise<StatsSeriesResp> {
  const { data } = await api.get<StatsSeriesResp>("/statistics/series", { params });
  return data;
}
export async function saveStatsManual(body: { block: string; metric: string; scopeType: string; scopeKey: string; scopeName?: string; granularity: string; period: string; value: number }): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>("/statistics/series/manual", body);
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
  taskType: "simple" | "weekly_kpi" | "monthly_kpi" | "daily_kpi" | "kpi_period" | "reactivation" | "oneonone";
  metric: "ads_count" | "avg_check" | "conversion" | null;
  targetValue: number | null;
  actualValue: number | null;
  planDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parentId: number | null;
  auto: boolean;
  // Задача з 1×1: закріплена вгорі, знімає лише ведучий (замок — на сервері).
  pinned?: boolean;
  o2oType?: "A" | "B" | "V" | null;
  o2oMeetingDate?: string | null;
  o2oResolution?: "done" | "carried" | "cancelled" | null;
  o2oResolvedAt?: string | null;
  o2oResolvedByName?: string | null;
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
  status?: "draft" | "published"; created_by_ai?: boolean;
}
/** Опублікувати чернетку (в т.ч. згенеровану АІ) — лише admin. */
export async function publishTrainingMaterial(id: number): Promise<void> {
  await api.post(`/training/materials/${id}/publish`);
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

// ── Ван-ту-вани (1×1) — три типи, форми з БД, приватність ──
export type O2OType = "A" | "B" | "V";
export type O2OFieldType = "score" | "text" | "score_text";
export interface O2OQuestion { qKey: string; label: string; field: O2OFieldType; quarterly?: boolean }
export interface O2OSection { key: string; title: string; note?: string; questions: O2OQuestion[] }
export interface O2OFormBody { sections: O2OSection[]; enps?: boolean; notes?: boolean;
  /** A/Б: структурний блок «Задоволеність компанією» — поза sections, тож поза overall. */
  satisfaction?: boolean }
export interface O2OForm { type: string; version: number; questions: O2OFormBody; is_active?: boolean }
export interface OneOnOneSubject {
  id: number; name: string; team_id: number | null; team_name: string | null;
  is_team_lead: boolean; overall: number | null; done: boolean; updated_at: string | null;
  // зустрічей у вибраному місяці (їх може бути кілька) + дата ОСТАННЬОЇ
  meetings: number; last_meeting_date: string | null;
}
export type OneOnOneAnswers = Record<string, { score?: number; text?: string }>;
export interface O2ONotes {
  mood?: string; likes?: string; pains?: string; ideas?: string;
  requests?: string; about_manager?: string; development?: string; enps?: string; followup?: string;
}
export interface OneOnOneRecord {
  // meeting_date — АВТОРИТЕТНА дата зустрічі: саме вона визначає запис (не місяць).
  subject_manager_id: number; type: string; meeting_date: string; form_version: number;
  answers: OneOnOneAnswers; overall: number | null; enps_score: number | null; enps_reason: string | null;
  // окремий показник, НЕ входить в overall (для типу В дорівнює enps_score)
  satisfaction_score: number | null;
  notes: O2ONotes | null; conducted_by: number | null; conducted_by_name?: string | null; updated_at?: string;
}
export interface O2OMeeting {
  meeting_date: string; overall: number | null; enps_score: number | null; satisfaction_score: number | null;
  form_version: number; conducted_by: number | null; conducted_by_name: string | null; updated_at: string;
}
export async function fetchO2OConductTypes(): Promise<{ types: string[]; crossview: boolean; canEdit: boolean }> {
  const { data } = await api.get("/one-on-ones/conduct-types");
  return { types: data?.types ?? [], crossview: !!data?.crossview, canEdit: !!data?.canEdit };
}
export async function fetchO2OForm(type: string, version?: number): Promise<O2OForm> {
  const { data } = await api.get<O2OForm>(`/one-on-ones/forms/${type}`, { params: version ? { version } : {} });
  return data;
}
export async function fetchO2OFormVersions(type: string): Promise<{ version: number; is_active: boolean; created_at: string }[]> {
  const { data } = await api.get(`/one-on-ones/forms/${type}/versions`);
  return data?.versions ?? [];
}
export async function saveO2OForm(type: string, questions: O2OFormBody): Promise<{ version: number }> {
  const { data } = await api.put(`/one-on-ones/forms/${type}`, { questions });
  return { version: data?.version };
}
export async function fetchOneOnOneSubjects(type: string, month: string): Promise<{ subjects: OneOnOneSubject[] }> {
  const { data } = await api.get("/one-on-ones/subjects", { params: { type, month } });
  return { subjects: data?.subjects ?? [] };
}
/** Журнал зустрічей субʼєкта (кожна зустріч — окремий запис). */
export async function fetchO2OMeetings(type: string, managerId: number, months = 12): Promise<O2OMeeting[]> {
  const { data } = await api.get(`/one-on-ones/meetings/${type}/${managerId}`, { params: { months } });
  return data?.meetings ?? [];
}
/** Запис КОНКРЕТНОЇ зустрічі за датою. Без дати — сьогоднішня (нова зустріч). */
export async function fetchOneOnOne(type: string, managerId: number, date: string): Promise<OneOnOneRecord> {
  const { data } = await api.get<OneOnOneRecord>(`/one-on-ones/record/${type}/${managerId}`, { params: { date } });
  return data;
}
export async function saveOneOnOne(p: {
  type: string; subjectManagerId: number; meetingDate: string; answers: OneOnOneAnswers;
  enpsScore?: number | null; enpsReason?: string | null; notes?: O2ONotes | null;
  satisfactionScore?: number | null;
}): Promise<{ overall: number | null }> {
  const { data } = await api.post("/one-on-ones/record", p);
  return { overall: data?.overall ?? null };
}
export interface OneOnOneStatRow { id: number; name: string; team_id: number | null; team_name: string | null; meeting_date: string; month: string; overall: number | null; enps_score: number | null; satisfaction_score: number | null; form_version: number; answers: OneOnOneAnswers; }
export async function fetchOneOnOneStats(type: string, months = 6): Promise<OneOnOneStatRow[]> {
  const { data } = await api.get<{ rows: OneOnOneStatRow[] }>("/one-on-ones/stats/scores", { params: { type, months } });
  return data?.rows ?? [];
}
// ── Задачі з 1×1 ─────────────────────────────────────────────────────────────
export interface O2OOpenTask {
  id: number; title: string; deadline: string | null; setAt: string; status: string;
  createdById: number | null; createdByName: string | null; carriedTimes: number;
}
export type O2OTaskOutcome = "done" | "carried" | "cancelled";
/** Поставити задачу субʼєкту внизу форми зустрічі (закріплена, знімає лише ведучий). */
export async function createO2OTask(p: {
  type: string; subjectManagerId: number; meetingDate: string; title: string; deadline?: string | null;
}): Promise<{ id: number }> {
  const { data } = await api.post("/one-on-ones/task", p);
  return { id: data?.id };
}
/** Відкриті задачі з МИНУЛИХ зустрічей (для блоку рев'ю вгорі форми). */
export async function fetchO2OOpenTasks(type: string, managerId: number, before: string): Promise<O2OOpenTask[]> {
  const { data } = await api.get(`/one-on-ones/open-tasks/${type}/${managerId}`, { params: { before } });
  return data?.tasks ?? [];
}
/** Позначити задачу на зустрічі: виконано / переноситься / знято. */
export async function reviewO2OTask(id: number, outcome: O2OTaskOutcome, meetingDate: string): Promise<void> {
  await api.post(`/one-on-ones/task/${id}/review`, { outcome, meetingDate });
}

export interface O2OEnpsPoint { month: string; promoters: number; detractors: number; passives: number; total: number; enps: number | null }
export async function fetchO2OEnps(months = 12): Promise<O2OEnpsPoint[]> {
  const { data } = await api.get<{ series: O2OEnpsPoint[] }>("/one-on-ones/enps", { params: { months } });
  return data?.series ?? [];
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
  daily: { date: string; leadsAd: number; leadsLeadgen: number; leadsOther: number; leadsTotal: number; created: number; dispatched: number; dispatchedSum: number; received: number; plan: number; working: boolean }[];
  expectedByDay: { date: string; sum: number; deals: number }[];
  planPerDay: { monthPlan: number; workingDays: number; perWorkingDay: number };
  expectedByTeam: { id: number; name: string; teamId: number | null; deals: number; sum: number }[];
  expectedByManager: { id: number; name: string; teamId: number | null; deals: number; sum: number }[];
  teams?: { teamId: number; teamName: string; plan: number; fact: number; pctPlan: number | null; remaining: number; expectedThisMonth: number; carryover: { amount: number; deals: number }; flowCur: number | null; flowPrev: number | null }[];
  managers?: { managerId: number; name: string; teamId: number | null; plan: number; fact: number; pctPlan: number | null; remaining: number; expectedThisMonth: number; carryover: { amount: number; deals: number }; flowCur: number | null; flowPrev: number | null }[];
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

// ─────────────────────────── Виписка (банк) ───────────────────────────
export interface BankAccount {
  id: number; company: string; bank: "mono" | "privat"; label: string; currency: string;
  external_account_id: string | null; is_active: boolean;
  legal_name: string | null; edrpou_ipn: string | null; iban: string | null;
  key_card?: string | null; // ключ-карта ФОП (звичайні реквізити, як IBAN)
  bank_name: string | null; mfo: string | null; purpose: string | null;
  vat_ipn?: string | null; legal_address?: string | null; director?: string | null; bank_edrpou?: string | null;
  env_key_name?: string | null; api_connected: boolean;
}
// Публічні реквізити (усі ролі; без ключів/балансів)
export interface BankRequisite {
  id: number; label: string; company: string; currency: string; legal_name: string | null; edrpou_ipn: string | null;
  vat_ipn: string | null; iban: string | null; key_card: string | null; bank_name: string | null; mfo: string | null;
  bank_edrpou: string | null; legal_address: string | null; director: string | null;
}
export async function fetchBankRequisites(): Promise<BankRequisite[]> {
  const { data } = await api.get<{ requisites: BankRequisite[] }>("/bank/requisites");
  return data.requisites;
}
export interface BankTx {
  id: number; account_id: number; company: string; account_label: string; direction: "in" | "out";
  booked_at: string; processed_at: string | null; counterparty_name: string | null;
  counterparty_iban: string | null; purpose: string | null; amount: string; currency: string;
  fx_rate: string | null; amount_uah: string; external_tx_id: string; unmatched_account: boolean;
  hidden?: boolean;
}
export interface BankSummary { total: number; count: number; byCompany: Record<string, number>; maxPayment: number }
// summary — лише на першій сторінці (за період); nextCursor — далі гортати (keyset), null = кінець історії
export interface BankFeed { rows: BankTx[]; nextCursor: string | null; summary?: BankSummary; canSeeHidden?: boolean }
export interface BankHiddenPayee { id: number; pattern: string; match_type: "exact" | "glob"; note: string | null; created_at: string }

export interface BankQuery { from?: string; to?: string; company?: string; account?: number; currency?: string; q?: string; cursor?: string; limit?: number }
const bankParams = (p: BankQuery) => ({ ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}), ...(p.company ? { company: p.company } : {}), ...(p.account ? { account: p.account } : {}), ...(p.currency ? { currency: p.currency } : {}), ...(p.q ? { q: p.q } : {}), ...(p.cursor ? { cursor: p.cursor } : {}), ...(p.limit ? { limit: p.limit } : {}) });

export async function fetchBankAccounts(): Promise<BankAccount[]> {
  const { data } = await api.get<{ accounts: BankAccount[] }>("/bank/accounts");
  return data.accounts;
}
export async function fetchBankIncoming(p: BankQuery): Promise<BankFeed> {
  const { data } = await api.get<BankFeed>("/bank/incoming", { params: bankParams(p) });
  return data;
}
export async function fetchBankOutgoing(p: BankQuery): Promise<BankFeed> {
  const { data } = await api.get<BankFeed>("/bank/outgoing", { params: bankParams(p) });
  return data;
}
export async function saveBankAccount(id: number | null, patch: Partial<BankAccount> & { envKeyName?: string; legalName?: string; edrpouIpn?: string; bankName?: string; isActive?: boolean; vatIpn?: string; legalAddress?: string; director?: string; bankEdrpou?: string; keyCard?: string }): Promise<void> {
  if (id == null) await api.post("/bank/accounts", patch); else await api.patch(`/bank/accounts/${id}`, patch);
}
export interface BankBalance { id: number; label: string; company: string; balance_amount: string | null; balance_currency: string | null; balance_updated_at: string | null; balance_uah?: number | null; fx_gain_period?: number | null }
export interface BankBalancesResp { balances: BankBalance[]; period?: { from: string; to: string } }
export interface CashflowMonth { month: string; incoming_uah: number; outgoing_uah: number; net_uah: number }
export async function fetchBankCashflow(months = 12): Promise<CashflowMonth[]> {
  const { data } = await api.get<{ cashflow: CashflowMonth[] }>("/bank/cashflow", { params: { months } });
  return data.cashflow;
}
export async function fetchBankBalances(from?: string, to?: string): Promise<BankBalancesResp> {
  const { data } = await api.get<BankBalancesResp>("/bank/balances", { params: { ...(from ? { from } : {}), ...(to ? { to } : {}) } });
  return data;
}
export async function fetchBankHiddenPayees(): Promise<BankHiddenPayee[]> {
  const { data } = await api.get<{ payees: BankHiddenPayee[] }>("/bank/hidden-payees");
  return data.payees;
}
export async function addBankHiddenPayee(pattern: string, matchType: "exact" | "glob"): Promise<void> {
  await api.post("/bank/hidden-payees", { pattern, matchType });
}
export async function deleteBankHiddenPayee(id: number): Promise<void> {
  await api.delete(`/bank/hidden-payees/${id}`);
}

// ── Рекомендація «скільки лідів треба взяти» (вкладка «Плани», розкривний рядок).
// Суто похідна від планів/історії — НІЧОГО не змінює в БД.
export interface LeadRecRow {
  managerId: number; name: string; teamId: number | null; channel: "ad" | "leadgen";
  plan: number;
  forecast: number | null; forecastClients: number;
  remainder: number | null;
  conversionPct: number | null; conversionEntered: number; conversionWon: number;
  avgCheck: number | null; perLead: number | null; leadsNeeded: number | null;
  // Джерело показника: 'own' — особистий, 'team' — фолбек на команду (ОБОВʼЯЗКОВО
  // підписується в UI, щоб командна цифра не читалась як особиста), null — немає.
  conversionSource: "own" | "team" | "company" | null;
  avgCheckSource: "own" | "team" | "company" | null;
  ownAvgCheck: number | null;
  enough: boolean; reasons: string[];
  // Позначки-сигнали (на розрахунок не впливають):
  maxMonthlyLeads: number;   // історичний максимум лідів/міс за 6 міс (свій канал)
  planBelowBase: boolean;    // прогноз по постійних > план
  unreachable: boolean;      // треба лідів > історичного максимуму
}
export interface LeadRecResp { month: string; period: string; scope: { from: string; to: string }; rows: LeadRecRow[] }
export async function fetchLeadRecommendation(params: { month: string; period: "month" | "3m" | "year"; teamId?: number }): Promise<LeadRecResp> {
  const { data } = await api.get<LeadRecResp>("/dashboard/lead-recommendation", { params });
  return data;
}

// 🚨 Тривоги для банера (Крок 2). Доступно лише керівництву — інші отримають 403.
export interface HealthAlert {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  action: string;
  since: string | null;
}
export async function fetchHealthAlerts(): Promise<{
  alerts: HealthAlert[]; checkedAt: string; checksDeclared: number; checksRan: number;
}> {
  const { data } = await api.get("/health/alerts");
  return data;
}

// ── ФАЗА A · «Постійні клієнти · план місяця» ────────────────────────────────
export interface ClientPlanWeek { label: string; from: string; to: string; status: "past" | "current" | "future"; plan: number; fact: number }
export interface ClientPlanRow {
  clientKey: string; clientName: string; paymentType: string | null;
  orders: number; lifetimeRevenue: number; since: string | null; lastOrderDays: number | null;
  history: number[]; plan: number; planStatus: "draft" | "pending" | "approved" | "none";
  reviewNote: string | null; weeks: ClientPlanWeek[]; fact: number; pct: number | null;
  managerId: number; managerName: string; pinned: boolean; comments: number; calls: never[];
  /** Команда менеджера — для ієрархії «команда → менеджер → клієнти» (подача, не скоуп). */
  teamId: number | null; teamName: string;
  /** Сегмент за частотою замовлень — бейдж біля клієнта. */
  segment: ClientSegment;
}
export interface ClientPlansResp {
  month: string; historyMonths: string[];
  weeks: { label: string; from: string; to: string; status: "past" | "current" | "future"; workingDays: number }[];
  clients: ClientPlanRow[];
  totals: {
    planTotal: number; planApproved: number; factTotal: number; pct: number | null;
    filledClients: number; totalClients: number;
    currentWeekIndex: number | null; currentWeekFact: number | null; currentWeekPlan: number | null;
    atRiskCount: number; atRiskNames: string[]; goesToManagerPlan: number;
    byStatus: Record<string, number>; canSubmit: boolean; canApprove: boolean;
    /** 🌉 МІСТОК: скільки постійних пішло в реактивацію. У Σ плану НЕ входить. */
    inReactivation: number; inReactivationSleeping: number; inReactivationLost: number;
    /** Розбивка ЖИВИХ по сегментах — цифра над таблицею. */
    activeBySegment: Record<ClientSegment, number>;
  };
  callsUnavailable: string;
}
export async function fetchClientPlans(params: { month: string; managerId?: number; teamId?: number }): Promise<ClientPlansResp> {
  const { data } = await api.get<ClientPlansResp>("/dashboard/client-plans", { params });
  return data;
}
export async function saveClientPlan(body: { clientKey: string; month: string; plan: number }): Promise<{ status: string }> {
  const { data } = await api.post("/dashboard/client-plan", body);
  return data;
}
export async function submitClientPlans(body: { month: string; managerId?: number }): Promise<{ submitted: number }> {
  const { data } = await api.post("/dashboard/client-plans/submit", body);
  return data;
}
export async function approveClientPlans(body: { month: string; managerId?: number }): Promise<{ approved: number }> {
  const { data } = await api.post("/dashboard/client-plans/approve-all", body);
  return data;
}
export async function returnClientPlan(body: { clientKey: string; month: string; note: string }): Promise<{ ok: boolean }> {
  const { data } = await api.post("/dashboard/client-plan/return", body);
  return data;
}
// ── Пошук клієнта (автокомпліт форм обʼєднання/передачі) ────────────────────
export interface ClientSearchHit {
  clientKey: string; clientName: string; orders: number; lifetimeRevenue: number;
  lastPaid: string | null; managerName: string | null; managerActive: boolean; pinned: boolean;
}
export async function fetchClientSearch(q: string, limit = 20): Promise<ClientSearchHit[]> {
  const { data } = await api.get<ClientSearchHit[]>("/dashboard/client-search", { params: { q, limit } });
  return data;
}

// ── Картка клієнта: помісячна динаміка ① + останні угоди ────────────────────
export interface ClientCardDeal {
  kommoId: number; crmUrl: string; name: string | null; date: string | null;
  dateKind: "closed" | "created"; price: number; stage: string; won: boolean; manager: string | null;
}
export interface ClientCard {
  clientKey: string; clientName: string; managerName: string | null; teamName: string | null;
  pinned: boolean; paymentType: string | null; orders: number; lifetimeRevenue: number;
  firstPaid: string | null; lastPaid: string | null;
  months: { month: string; revenue: number; deals: number }[];
  monthsTotal: number; deals: ClientCardDeal[]; anchorNote: string;
  /** Право на «🗑 прибрати з постійних» — рахує сервер тим самим гейтом, що й роут. */
  canHide: boolean;
  /** Клієнт уже прибраний вручну (`loyalty_overrides.hidden`) — тоді дія зворотна. */
  hidden: boolean;
}
export async function fetchClientCard(clientKey: string): Promise<ClientCard> {
  const { data } = await api.get<ClientCard>("/dashboard/client-card", { params: { clientKey } });
  return data;
}

export interface ClientComment { id: number; body: string; createdAt: string; author: string | null }
export async function fetchClientComments(clientKey: string): Promise<ClientComment[]> {
  const { data } = await api.get<ClientComment[]>("/dashboard/client-comments", { params: { clientKey } });
  return data;
}
export async function addClientComment(body: { clientKey: string; body: string }): Promise<ClientComment> {
  const { data } = await api.post("/dashboard/client-comments", body);
  return data;
}

// ── ФАЗА B · Реактивація · обʼєднання · відповідальний ───────────────────────
export type ClientState = "active" | "sleeping" | "lost";
export type ClientSegment = "vip" | "regular" | "episodic" | "unknown";
export interface ReactivationRow {
  clientKey: string; clientName: string; managerId: number; managerName: string; pinned: boolean;
  /** Команда ВІДПОВІДАЛЬНОГО менеджера — для ієрархії «команда → менеджер → клієнти». */
  teamId: number | null; teamName: string | null;
  orders: number; lifetimeRevenue: number; lastPaid: string | null; daysSince: number;
  /**
   * КОНТАКТ = РОЗМОВА (`billsec > 0`) по канонічному ключу — ДОВІДКА. Стан
   * рахується від оплати (`daysSince`), не звідси. `null` = розмов не знайдено.
   * Недодзвони — окремо в `attempts`, складати з розмовою заборонено.
   */
  lastTalk: string | null; lastTalkDays: number | null;
  lastTalkDirection: "in" | "out" | null;
  attempts: number; lastAttempt: string | null; lastAttemptDays: number | null;
  /** Сегмент за частотою; `unknown` = <3 оплат, сегмент НЕ вгадуємо. */
  segment: ClientSegment;
  medianGapDays: number | null;
  /** Втрачений понад рік — у згорнутий «Архів», а не на головну сцену. */
  archived: boolean;
  state: ClientState; value: number; seasonal: boolean; seasonalNote: string | null;
  taskId: number | null; taskStatus: string | null; taskAssignee: string | null;
  taskDeadline: string | null; closeReason: string | null;
  returned: boolean; returnedRevenue: number;
}
export interface ReactivationResp {
  clients: ReactivationRow[];
  closeReasons: { key: string; label: string }[];
  thresholds: {
    sleepingDays: number; lostDays: number;
    /** Пороги ПО СЕГМЕНТАХ — із ядра, щоб підпис не став другою редакцією правила. */
    bySegment: Record<ClientSegment, number>;
    archiveDays: number; segmentMinPayments: number;
  };
  tiles: {
    sleeping: number; sleepingPotential: number; lost: number; seasonal: number;
    inWork: number; returned30: number; returned30Revenue: number;
  };
  canAssign: boolean;
  /** Обʼєднання: тімліду відкрито в межах його команди (кламп — на сервері). */
  canMerge: boolean;
  mergeScope: "all" | "team";
}
export async function fetchReactivationList(params?: { managerId?: number; teamId?: number }): Promise<ReactivationResp> {
  const { data } = await api.get<ReactivationResp>("/dashboard/reactivation-list", { params });
  return data;
}
export async function setClientSeasonal(body: { clientKey: string; seasonal: boolean; note?: string }): Promise<{ seasonal: boolean }> {
  const { data } = await api.post("/dashboard/client-seasonal", body);
  return data;
}
export interface MergePreview {
  alias: { key: string; name: string | null; orders: number; revenue: number; lastPaid: string | null };
  canonical: { key: string; name: string | null; orders: number; revenue: number; lastPaid: string | null };
  after: { orders: number; revenue: number; regular: boolean };
  dealsToMove: number;
  chainBlocked: string[];
  plans: { side: string; month: string; plan: number; status: string }[];
  planConflictMonths: string[];
  reversible: string;
}
export async function fetchMergePreview(alias: string, canonical: string): Promise<MergePreview> {
  const { data } = await api.get<MergePreview>("/dashboard/client-merge/preview", { params: { alias, canonical } });
  return data;
}
export async function mergeClients(body: { alias: string; canonical: string; reason: string }): Promise<{ recomputed: number }> {
  const { data } = await api.post("/dashboard/client-merge", body);
  return data;
}
export async function revokeMerge(alias: string): Promise<{ recomputed: number }> {
  const { data } = await api.post("/dashboard/client-merge/revoke", { alias });
  return data;
}
export interface MergeJournalRow {
  aliasKey: string; canonicalKey: string; reason: string;
  createdAt: string; revokedAt: string | null; approvedBy: string | null;
}
export async function fetchMergeJournal(): Promise<MergeJournalRow[]> {
  const { data } = await api.get<MergeJournalRow[]>("/dashboard/client-merge/journal");
  return data;
}
export async function assignClientManager(body: { clientKey: string; managerId: number; reason?: string }): Promise<{ effectiveFrom: string; note: string }> {
  const { data } = await api.post("/dashboard/client-manager", body);
  return data;
}
export interface ManagerHistoryRow {
  fromManager: string | null; toManager: string; effectiveFrom: string;
  reason: string | null; changedBy: string | null; createdAt: string;
}
export async function fetchClientManagerHistory(clientKey: string): Promise<ManagerHistoryRow[]> {
  const { data } = await api.get<ManagerHistoryRow[]>("/dashboard/client-manager/history", { params: { clientKey } });
  return data;
}

/** Задача на ОДНОГО клієнта (Фаза B). Пачкову `createReactivationTask` не чіпаємо — вона лишається для масових кампаній. */
export async function createClientReactivationTask(body: { clientKey: string; deadline?: string; comment?: string; assigneeId?: number }): Promise<{ id: number; clientName: string }> {
  const { data } = await api.post("/dashboard/reactivation-task", body);
  return data;
}
export async function closeReactivationTask(body: { taskId: number; reason: string; note?: string }): Promise<{ closeReason: string }> {
  const { data } = await api.post("/dashboard/reactivation-task/close", body);
  return data;
}

// ── ПУЛ НІЧИЙНИХ КЛІЄНТІВ (рішення власника 05.08.2026) ──────────────────────
export interface OrphanClientRow {
  clientKey: string; name: string; managerId: number; manager: string;
  reason: "service" | "inactive"; segment: string; isRegular: boolean;
  payments: number; lastPaidAt: string | null; lastCallAt: string | null;
  daysSincePaid: number | null; daysSinceCall: number | null;
  revenue12: number; revenueAll: number; paymentType: string | null;
}
export interface OrphanGroup {
  managerId: number; manager: string; reason: string; reasonLabel: string;
  clients: OrphanClientRow[]; sum12: number; sumAll: number;
}
export interface OrphanPool {
  scope: string;
  tiles: { clients: number; money12: number; regulars: number; vip: number; claimedThisMonth: number; totalAllTime: number };
  groups: OrphanGroup[];
}
export async function fetchOrphanClients(scope?: "all"): Promise<OrphanPool> {
  const { data } = await api.get<OrphanPool>("/dashboard/orphan-clients", { params: scope ? { scope } : {} });
  return data;
}
/** 409 = клієнта вже взяли; текст помилки називає, хто саме. */
export async function claimOrphanClient(clientKey: string, managerId: number): Promise<void> {
  await api.post("/dashboard/orphan-clients/claim", { clientKey, managerId });
}
