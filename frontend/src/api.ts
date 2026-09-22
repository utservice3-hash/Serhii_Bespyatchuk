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
        // Той самий запис «куди повернути», що в RequireAuth (App.tsx): лише власний шлях застосунку.
        const here = window.location.pathname + window.location.search;
        if (here.startsWith("/") && !here.startsWith("//") && here !== "/") {
          try { sessionStorage.setItem("afterLogin", here); } catch { /* без повернення */ }
        }
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

/** 📞 Новий екран «Лідогенерація» — сім показників із подій CRM (ТЗ v2, 08.09.2026). */
export interface LeadgenPersonRow {
  managerId: number; name: string; teamId: number | null; teamName: string | null;
  isActive: boolean; leads: number; opr: number; quotes: number; warming: number; calls: number;
}
export interface LeadgenStatsResp {
  from: string; to: string;
  rows: LeadgenPersonRow[];
  bySource: { source: string; leads: number }[];
  totals: { leads: number; opr: number; quotes: number; warming: number; calls: number };
  conversions: {
    oprOfLeads: number | null; quotesOfOpr: number | null;
    targets: { oprOfLeads: number; quotesOfOpr: number; machinesOfQuotes: number };
  };
  department: {
    machines: number; machinesRevenue: number; receivedRevenue: number; receivedDeals: number;
    note: string; anchors: string;
    /** Покриття поля «Лидогенератор» у періоді — межа розрізу по особах. */
    leadGeneratorFill: { withPerson: number; total: number };
  };
  weeks: { week: string; leads: number; opr: number; quotes: number }[];
  closures: { reason: string; deals: number }[];
  handoffs: { kommoId: number; day: string; name: string | null; manager: string | null; url: string }[];
  handoffsLimit: number;
  warmingNow: number;
  callRule: string;
  scopedTo: number | null;
}
export async function fetchLeadgenStats(params: { from: string; to: string }): Promise<LeadgenStatsResp> {
  const { data } = await api.get<LeadgenStatsResp>("/dashboard/leadgen-stats", { params });
  return data;
}

/**
 * 📵 ПРОПУЩЕНІ ВХІДНІ (ТЗ-1). Типи — ДЗЕРКАЛО бекенду один-в-один
 * (`core/missedCalls.ts` → `MissedSummary`, `core/missedCallsRules.ts` → `MissedManagerRow`).
 * Нічого не вигадано й не перейменовано: розбіжність імен тут дала б `undefined` у
 * клітинці, а таке читається як «нуль», а не як поломка.
 */
export type MissedDayBucket = "work" | "evening" | "weekend" | "night";
export interface MissedSummary {
  missed: number; excluded: number; ownerless: number;
  callback: number; callbackTalked: number; callbackSelf: number; callbackColleague: number;
  clientSelf: number;
  /** `null` — передзвонів за період не було, тобто медіану нема з чого рахувати. */
  medianMin: number | null;
  buckets: Record<MissedDayBucket, number>;
}
export interface MissedManagerRow {
  /** `null` — рядок «Без відповідального»: дзвінок не дійшов до людини. */
  managerId: number | null;
  name: string;
  /** ПОТОЧНА команда менеджера; `null` — поза командами або рядок «Без відповідального». */
  teamId: number | null;
  missed: number; callbackSelf: number; callbackColleague: number; clientSelf: number;
  noCallback: number;
  /** У підсумковому рядку ЗАВЖДИ `null`: медіани не додаються й не усереднюються. */
  medianMin: number | null;
}
/** Рядок команди блоку B. `teamId: null` — «Поза командами». Медіана — по дзвінках команди. */
export interface MissedTeamRow {
  teamId: number | null;
  name: string;
  missed: number; callbackSelf: number; callbackColleague: number; clientSelf: number;
  noCallback: number;
  medianMin: number | null;
}
export interface MissedCallsResp {
  /** Період, за який СПРАВДІ пораховано — не той, що попросили (порожній дає 30 днів). */
  period: { from: string; to: string };
  summary: MissedSummary;
  managers: MissedManagerRow[];
  total: MissedManagerRow;
  teams: MissedTeamRow[];
  /** `false` у зрізі команди чи менеджера: «без відповідального» туди не входить за побудовою. */
  ownerlessInScope: boolean;
}
export async function fetchMissedCalls(params: { from: string; to: string }): Promise<MissedCallsResp> {
  const { data } = await api.get<MissedCallsResp>("/dashboard/missed-calls", { params });
  return data;
}

/** 📈 Динаміка: ряди по днях / тижнях / місяцях. `key`: total | team:<id> | noteam | ownerless. */
export type MissedSeriesGranularity = "day" | "week" | "month";
export interface MissedSeriesPoint { period: string; missed: number; callback: number; clientSelf: number; medianMin: number | null }
export interface MissedSeriesResp {
  granularity: MissedSeriesGranularity; from: string; to: string; ownerlessInScope: boolean;
  series: { key: string; name: string | null; points: MissedSeriesPoint[] }[];
}
export async function fetchMissedSeries(params: { granularity: MissedSeriesGranularity }): Promise<MissedSeriesResp> {
  const { data } = await api.get<MissedSeriesResp>("/dashboard/missed-calls/series", { params });
  return data;
}

/** Блок C. Типи — дзеркало `core/missedCalls.ts` (`MissedListRow`) + `dealUrl` з роуту. */
export type MissedNextStep = "callback_talked" | "callback_no_answer" | "client_self" | "nothing";
export interface MissedListRow {
  uniqueid: string;
  /** Час за Києвом, `HH:MM`. */
  at: string;
  phone: string | null; clientKey: string | null;
  managerId: number | null; managerName: string; bucket: MissedDayBucket;
  /** НАЙРАНІША подія після пропущеного — не «чи був передзвін узагалі». */
  next: MissedNextStep; nextMin: number | null;
  dealId: number | null; dealUrl: string | null;
}
export interface MissedListResp {
  day: string; onlyNoCallback: boolean;
  /** true — список обрізано стелею; екран мусить це сказати, а не вдавати повноту. */
  truncated: boolean;
  rows: MissedListRow[];
}
export async function fetchMissedList(params: { day: string; noCallback?: "1" }): Promise<MissedListResp> {
  const { data } = await api.get<MissedListResp>("/dashboard/missed-calls/list", { params });
  return data;
}

/** Блок D. Три стани — окремі числа, не одне. */
export type NoDealState = "unknown" | "has_deal" | "no_deal";
export interface NoDealCounts { answered: number; unknown: number; hasDeal: number; noDeal: number }
export async function fetchNoDeal(params: { from: string; to: string }): Promise<{ period: { from: string; to: string }; counts: NoDealCounts }> {
  const { data } = await api.get<{ period: { from: string; to: string }; counts: NoDealCounts }>("/dashboard/missed-calls/no-deal", { params });
  return data;
}
export interface NoDealListRow {
  uniqueid: string;
  /** Дата й час за Києвом, `YYYY-MM-DD HH:MM`. */
  at: string;
  phone: string | null; clientKey: string | null;
  managerId: number | null; managerName: string; talkSec: number;
  dealId: number | null; dealUrl: string | null;
}
export async function fetchNoDealList(params: { from: string; to: string; state: NoDealState }):
Promise<{ state: NoDealState; truncated: boolean; rows: NoDealListRow[] }> {
  const { data } = await api.get<{ state: NoDealState; truncated: boolean; rows: NoDealListRow[] }>("/dashboard/missed-calls/no-deal/list", { params });
  return data;
}

export interface ExecutiveOverview {
  /**
   * 🔴 Чи обраний період ПОТОЧНИЙ. Знімкові показники (дебіторка, перехідні,
   * очікування) від періоду не залежать — при непоточному вони мусять бути
   * підписані «станом на сьогодні», інакше читаються як «за обраний період».
   * Заміряно 07.08: `receivablesTotal` однаковий за липень, за тиждень і за день.
   */
  scope?: { from: string | null; to: string | null; isCurrent: boolean };
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
/** Партиція новизни (`repeat+new+undef = total`) + накладка джерела (`source.*` ⊂ партиція). */
export interface PFClients {
  repeat: PFCountSum; new: PFCountSum; undef: PFCountSum; total: PFCountSum;
  source: { leadgen: PFCountSum; ad: PFCountSum };
}
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
  /**
   * 🔐 Чи МОЖНА подати САМЕ ЦЕЙ рядок. Порядкове, бо менеджер бачить усю свою
   * команду: одне значення на відповідь малювало б «Подати» на чужих рядках.
   */
  canSubmit: boolean;
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

/** 📊 Екран «Реклама»: день × кампанія з GA4 + ліди CRM за той самий день. */
export interface AdsDay {
  /** Оплачено (142) · програно (143) · у роботі. Разом дають `leads`. */
  paid: number;
  lost: number;
  inWork: number;
  day: string;
  cost: number;
  clicks: number;
  sessions: number;
  /** Витрати з аркуша Сергія за той самий день; `null` = аркуш цього дня не має. */
  sheetCost: number | null;
  /** Ліди з ЯДРА conversion_ads (не свій SQL) — знаменник платних лідів. */
  leads: number;
  won: number;
}
export interface AdsCampaign {
  day: string;
  campaign: string;
  channelGroup: string | null;
  sessions: number;
  conversions: number;
  cost: number;
  clicks: number;
}
export interface AdsReport {
  days: AdsDay[];
  campaigns: AdsCampaign[];
  /** false → GA4 ще не ввімкнули; екран каже це словами, а не показує порожнечу. */
  ga4Configured: boolean;
  /** Місячний план (сума місяців періоду). `null` = плану на ці місяці не ставили — НЕ нуль. */
  planMonth: number | null;
  /** Гроші, ЩО НАДІЙШЛИ в періоді від реклами будь-якого часу. Не «принесли ці ліди». */
  revenue: number;
  revenueDeals: number;
}

/** Одна угода рекламної когорти дня — для розкриття. */
export interface AdsDeal {
  kommoId: number;
  name: string;
  price: number;
  /** paid = 142 · lost = 143 · inWork = ні те, ні те (означення власника). */
  state: "paid" | "lost" | "inWork";
  /** Дійшла до грошової зони — може бути true і в стані inWork («Виставлення рахунку»). */
  reachedMoney: boolean;
  url: string;
}

export async function fetchAds(params: { from?: string; to?: string }): Promise<AdsReport> {
  const { data } = await api.get<AdsReport>("/dashboard/ads", { params });
  return data;
}

export async function fetchAdsDeals(day: string): Promise<{ day: string; deals: AdsDeal[] }> {
  const { data } = await api.get<{ day: string; deals: AdsDeal[] }>("/dashboard/ads/deals", { params: { day } });
  return data;
}

/** Запис місячного плану. `month` — будь-який день потрібного місяця. */
export async function saveAdPlan(month: string, plan: number): Promise<void> {
  await api.put("/settings/ad-plan", { month, plan });
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

// 🪦 KvpExtra / fetchKvpExtra знято 03.09.2026 разом із роутом /dashboard/kvp-extra:
// функція не мала жодного виклику (контроль: сусіди fetchKvpReport/fetchKvpPlan по 2),
// літерала шляху в прод-бандлі — 0. «Відправлені авто» живуть у Статистиках.

// ── КРОК Д: композитний Звіт КВП (/kvp-report) ──
export type KvpExpectBucket = "overdue" | "thisMonth" | "later" | "noDate";
export interface KvpAgg { deals: number; revenue: number }
export interface KvpEngineTeam { plan: number; revenue: number; expected: number; expectedThisMonth: number;
  pct: number | null; forecastPct: number | null; conversion: number | null; entered: number }
export interface KvpDay { bucket: string; revenue: number; deals: number }
export interface KvpWeek { idx: number; from: string; to: string; plan: number; fact: number; expected: number; auto: number; autoRevenue: number; leadsAd: number; leadsLeadgen: number; met: boolean; isCurrent: boolean; isFuture: boolean; pace: number | null }
export interface KvpDeptWeek { idx: number; from: string; to: string; plan: number; fact: number; expected: number; auto: number; autoRevenue: number; leadsAd: number; leadsLeadgen: number; success: number; newRecv: number; repeatRecv: number; lostDeals: number; lostSum: number; expectedPlanned: number; isCurrent: boolean; isFuture: boolean; pace: number | null }
/** `new+repeat+undef = created` — партиція НОВИЗНИ. `ad`/`leadgen` — накладка
 *  ДЖЕРЕЛА: підмножини партиції, у `created` НЕ додаються. */
/**
 * 🔀 Е4: ЧОТИРИ КАНАЛИ, А НЕ ДВА. `other` — «не реклама і не лідген» (рішення власника
 * 26.08.2026): підпис описує ПРЕДИКАТ, бо жоден позитивний підпис не переживає
 * перевірки на всьому каналі — «створено вручну» це 13%, а «постійні» правда для РПК
 * (71%) і неправда для РНК (19%, там 222 нові). Сенс несе НОВИЗНА поруч, не назва.
 * `noChannel` = `lead_channel IS NULL`; на живих даних 0, але кошик існує в ядрі.
 */
export interface CreatedSplit { created: number; new: number; repeat: number; undef: number; ad: number; leadgen: number; other: number; noChannel: number }
export interface KvpManager {
  managerId: number; name: string; plan: number; revenue: number; pct: number | null;
  avgCheck: number; successDeals: number; conversion: number | null; convEntered: number; expected: number;
  // #4 «в очікуванні оплат» ср.чек (chainInflight знімок) · #2 очікування за план. датою.
  avgCheckAwaiting: number | null; awaitingDeals: number; expectedThisMonth: number; expectedNextMonth: number; expectedPastMonths: number;
  createdSplit: CreatedSplit;
  daily: KvpDay[]; weeks: KvpWeek[];
}
export interface KvpExpBucket { deals: number; sum: number }
// Крок Д фінал A — детальний дрил менеджера weeks→days (лінивий фетч)
export interface KvpDetailCell {
  created: number; newCount: number; repeatCount: number; undefCount: number;
  // 🔴 crAd/crLeadgen/crOther — партиція СТВОРЕНОГО за каналом (Σ == created).
  // НЕ плутати з leadsAd/leadsLeadgen/leadsOther: ті рахують ЛІДИ — інша популяція.
  crAd: number; crLeadgen: number; crOther: number; crNoChannel: number;
  leadsAd: number; leadsLeadgen: number; leadsOther: number; dispatched: number;
  // Розбивка відправлених авто за джерелом (постійний / лідоген / реклама / невизн). Σ = dispatched.
  dispRepeat: number; dispLeadgen: number; dispAd: number; dispUndef: number;
  received: { deals: number; revenue: number }; expected: { deals: number; sum: number };
  // Розклад ② по дню + активність дзвінків + виставлені рахунки ТОГО дня.
  success: { deals: number; revenue: number }; paid: { deals: number; revenue: number };
  talks: number; attempts: number; invoiced: { deals: number; sum: number };
  /**
   * 🟫 КОГОРТА ДНЯ: авто, відправлені ТОГО дня, і що з ними ЗАРАЗ.
   * `dispPaid + dispAwait == dispatched/dispSum` за побудовою — саме це робить
   * коричневу смугу перевірною очима, без нас.
   */
  dispSum: number;
  dispPaid: { deals: number; sum: number };
  dispAwait: { deals: number; sum: number };
}
export interface KvpDetailWeek { idx: number; from: string; to: string; isCurrent: boolean; isFuture: boolean; total: KvpDetailCell; days: (KvpDetailCell & { day: string })[] }
export interface KvpManagerDetail {
  managerId: number; name: string; from: string; to: string;
  weeks: KvpDetailWeek[]; monthTotals: KvpDetailCell;
}
export async function fetchManagerDetail(params: { managerId: number; from: string; to: string }): Promise<KvpManagerDetail> {
  const { data } = await api.get<KvpManagerDetail>("/dashboard/kvp-report/manager-detail", { params });
  return data;
}
export interface KvpTeam {
  teamId: number; name: string; kind: "rpk" | "rnk" | "leadgen";
  plan: number; revenue: number; expected: number; pct: number | null; forecastPct: number | null;
  conversion: number | null; entered: number; won: number; managers: KvpManager[];
  // #3 лайфтайм-конверсія (Варіант A, весь час): РНК÷реклама, РПК÷лідген; ≤100%.
  convLifetime: { num: number; den: number; pct: number | null };
  // #4 два чеки команди: «успішно» (success за місяць) + «в очікуванні» (chainInflight знімок).
  avgCheckSuccess: number | null; avgCheckAwaiting: number | null;
  expectedThisMonth: number; expectedNextMonth: number; expectedPastMonths: number; weeks: KvpWeek[];
}
export interface KvpSignal { severity: "critical" | "serious" | "warning" | "info"; icon: string; title: string; detail: string; action: string; expectedThisMonth?: number; expectedNextMonth?: number }
export interface KvpSeriesRow { ym: string; [k: string]: number | string | boolean }
export interface KvpReport {
  scope: { from: string; to: string; prevFrom: string; prevTo: string; preset: string; label: string; isCurrent: boolean; monthAligned: boolean };
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
    projection: { fact: number; projected: number; projectedPct: number | null; expectedThisMonth: number; dobir: number; pace: number | null; pacePct: number | null; elapsedWorkingDays: number; totalWorkingDays: number };
    lifecycle: { sent: KvpAgg; received: KvpAgg;
      /** Зона очікування + розбивка за датою очікуваного платежу (`core/expectSplit.ts`).
       *  `today` — київська дата межі «прострочено»; вона рухається щодня, тому приходить
       *  із сервера, а не рахується у браузері. */
      awaiting: KvpAgg & { today: string; split: Record<KvpExpectBucket, { bucket: KvpExpectBucket; deals: number; sum: number }> } };
    derived: { base: number; low: number; target: number; high: number };
  };
  signals: KvpSignal[];
  topPerformers: { name: string; team: string; plan: number; fact: number; pct: number }[];
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
/** Розклад джерела всередині одного класу новизни (`created` == Σ чотирьох). */
export interface SrcCounts {
  created: number; adCount: number; leadgenCount: number; otherCount: number; noChannelCount: number;
}
/** Лічильники «першого дотику». `noRecord` — бот розмови не чув; у відсоток НЕ входить. */
export interface FirstTouchCounts { analyzed: number; voiced: number; noRecord: number }
/** `not_covered` — команду бот не оцінює взагалі: «не вимірюється», а не 0 з 0. */
export interface FirstTouchCell extends FirstTouchCounts { state: "measured" | "not_covered" }
export interface ReportPlanManager {
  managerId: number; name: string; teamId: number | null; teamName: string | null;
  tag: "rpk" | "rnk" | "self";
  plan: number; fact: number; expect: number; pct: number | null;
  factSuccess: number; factPaid: number; // #1 круг оплати: факт = успішно ⊎ оплачено
  // К-сть угод у кожній половині факту — банер має називати ЧИСЛО, а не лише суму.
  factSuccessDeals: number; factPaidDeals: number;
  // 📞 Розмова (billsec>0) і недодзвін — ДВІ цифри; складати заборонено.
  talks: number; attempts: number;
  /** 🎯 ТЗ-3 «ціну названо в перший дотик» — оцінки бота, звʼязані з тим, хто ДЗВОНИВ. */
  firstTouch: FirstTouchCell;
  // ⏳ Очікування БЕЗ планової дати — в жодну суму не входить, тому й окремо.
  expectNoDate: number; expectNoDateDeals: number;
  // 🧱 Скільки з очікувань стоїть на «Виставленні рахунку» (затор).
  jam: number; jamDeals: number;
  // 📈 «За темпом» — ЕКСТРАПОЛЯЦІЯ (факт ÷ минулі роб. дні × усі), не прогноз.
  // `byPaceEarly` = перевищує 150% плану → на екрані «⚠ рано».
  byPace: number; byPaceEarly: boolean;
  expectThisMonth: number; expectNextMonth: number; // #2 за плановою датою оплати
  // 🗓 Планова дата в МИНУЛИХ місяцях. Не входить у прогноз і не є «простроченим»
  //    з плитки КВП (там межа — сьогодні). Заміряно 07.09.2026: 67.1% зони відділу.
  expectPastMonths: number;
  // 🟡 Добір нового бізнесу. У `projected` з 06.08.2026 НЕ входить (рішення власника),
  // але лишається видимим числом — щоб зміна формули читалась, а не зникла тихо.
  dobir: number;
  /**
   * 🔗 Ланцюг періоду: ВІДПРАВЛЕНО → ОЧІКУЄ → ОПЛАЧЕНО. `paidSum + awaitSum == sum`
   * за побудовою; `awaitDatedSum + awaitNoDateSum == awaitSum`.
   */
  cohort: { deals: number; sum: number; paidDeals: number; paidSum: number;
    awaitDeals: number; awaitSum: number; awaitDatedSum: number; awaitNoDateSum: number };
  // #P1 динамічна тижнева ціль (Variant A: manual ?? dynamic — одна цифра з Задачником).
  week: { target: number; dynamic: number; manual: number | null; isManual: boolean; fact: number; dayTarget: number; weeksLeft: number; presentDaysLeftWeek: number;
    /** Перевиконання місячного плану на початок тижня (план тижня 0, надлишок названий). */
    overPlan: number;
    /** Ціль зафіксована знімком у понеділок — усередині тижня не рухається. */
    frozen: boolean;
    /** Знімок ВІДНОВЛЕНО ретроспективно, а не збережено в момент. Межа видима в ⓘ. */
    reconstructed: boolean;
    weekFrom: string | null; workingDaysWeek: number };
  projected: number; monthInProgress: boolean;
  created: number; new: number; rep: number;
  /** накладка ДЖЕРЕЛА (⊂ created), у суму не додається */
  // Розклад створених за ДЖЕРЕЛОМ — партиція: Σ чотирьох == created (гейт #174).
  srcAd: number; srcLeadgen: number; srcOther: number; srcNoChannel: number;
  /**
   * 🔀 Той самий розклад ВСЕРЕДИНІ кожного класу новизни (Е3). Приїжджає разом
   * із рядком, бо перемикач НЕ ходить на сервер: `/overview` ×4 вже 4 940-5 168 мс
   * при стелі 5 000 (`#36`). Плоскі поля вище — це зріз «усі», і вони НЕ
   * дублюються сюди: два джерела одного числа на одному екрані розходяться мовчки.
   */
  srcByKlass: Record<"new" | "rep" | "undef", SrcCounts>;
  /**
   * 🧬 ГРОШІ ЗА НОВИЗНОЮ КЛІЄНТА (канон `dealKlassSql`). `fact == factNew +
   * factRepeat + factUndef`, і те саме для очікувань. `undef` на екран не йде —
   * сьогодні він нуль (заміряно на проді 20.08.2026: 0 ₴ з 1 492 822 ₴), а
   * будильник `#102b` червоніє на першому ненульовому.
   */
  factNew: number; factRepeat: number; factUndef: number;
  expectThisMonthNew: number; expectThisMonthRepeat: number; expectThisMonthUndef: number;
  status: "g" | "a" | "r"; needPerDay: number; remainingWorkdays: number;
  spark: number[];
  kpi: { ads: ReportPlanKpi; leadgen: ReportPlanKpi; dispatch: ReportPlanKpi; avgCheck: ReportPlanKpi; conversion: ReportPlanKpi };
  /**
   * 🔀 ТА САМА конверсія, звужена до каналу (рішення власника 21.08.2026).
   * `taken`/`won` є ЗАВЖДИ, `fact` (відсоток) — лише при `taken >= 10`, як і в
   * combined. Σ канальних counts == combined counts; відсотки НЕ адитивні.
   */
  conversionAd: { taken: number; won: number; fact: number | null };
  conversionLeadgen: { taken: number; won: number; fact: number | null };
}
export interface ReportPlan {
  scope: { from: string; to: string; isCurrent: boolean; workingDaysTotal: number; workingDaysElapsed: number };
  role: string; viewerManagerId: number | null; elapsed: number; remainingWorkdays: number;
  glance: { plan: number; fact: number; factSuccess: number; factPaid: number; expect: number; expectThisMonth: number; expectNextMonth: number; expectPastMonths: number;
    dispatched: number; dispatchedRevenue: number; created: number; avgCheck: number | null;
    expectNoDate: number; jam: number; jamDeals: number; dobir: number; byPace: number; talks: number; attempts: number;
    /**
     * Σ «першого дотику» по ростеру + стан покриття команди + оцінки людей ПОЗА ростером у межах
     * скоупу (завершують, звільнені) — окремим числом, щоб не зникали. Відсоток — з сум ростеру.
     */
    firstTouch: FirstTouchCounts & { state: "measured" | "not_covered"; outside: FirstTouchCounts };
    /**
     * 🔴 Скільки з факту прийшло від менеджерів БЕЗ плану (і від звільнених — у них
     * плану немає за побудовою). План команди = Σ планів її менеджерів, тож ці гроші
     * піднімають відсоток, не піднявши знаменник. Заміряно: у Яцика +8.3 п.п.
     */
    factNoPlan: number;
    /** 🟢 ТРИ стани, взаємовиключні й повні: Σ(g+a+r) == к-сті менеджерів (рішення 07.08.2026). */
    statusCounts: { g: number; a: number; r: number } };
  managers: ReportPlanManager[];
  /**
   * 🔴 ЗВІЛЬНЕНІ З ГРІШМИ — окремий масив, а не рядки серед `managers`.
   * У них НЕМАЄ плану, відсотка, світлофора й темпу (ставити план людині, якої
   * немає, безглуздо), але їхні гроші ВХОДЯТЬ у `glance` і в суму команди —
   * інакше Σ(менеджери) перестала б дорівнювати команді, а це той інваріант, на
   * якому стоїть половина гейтів. Порожній масив — нормальний стан.
   */
  dismissed: ReportPlanDismissed[];
  /** Про ДЖЕРЕЛО «першого дотику»: не звʼязані з менеджером оцінки, остання оцінка бота, скільки команд він оцінює. */
  firstTouchMeta: { unmapped: FirstTouchCounts; lastAnalyzedAt: string | null; coveredTeams: number };
}
export interface ReportPlanDismissed {
  managerId: number; name: string; teamId: number | null; teamName: string | null;
  fact: number; factSuccess: number; factPaid: number;
  factPaidDeals: number; factSuccessDeals: number;
  /** Стан людини: чому вона поза ростером. Три РІЗНІ причини, не одна. */
  state?: "active" | "finishing" | "dismissed";
  /** Готова позначка з ядра («завершує» / «звільнений» / ""). Фронт її не вигадує. */
  badge?: string;
  deactivated?: boolean;
}
export async function fetchReportPlan(params: { from: string; to: string; managerId?: number; teamId?: number }): Promise<ReportPlan> {
  const { data } = await api.get<ReportPlan>("/dashboard/report-plan", { params });
  return data;
}
/** `src` — НОВИЗНА клієнта, `source` — ДЖЕРЕЛО угоди. Різні виміри: угода буває
 *  водночас `src:"rep"` і `source:"ad"` (постійний клієнт прийшов через рекламу). */
// Джерело угоди — партиція з чотирьох (див. metrics.dealSourceCase). `null` НЕ
// п'ятий стан, а «питання незастосовне»: так позначені рядки-дзвінки. Тримає `#175c`.
export type DealSource = "ad" | "leadgen" | "other" | "undef" | null;
/**
 * НОВИЗНА клієнта — ДЗЕРКАЛО `core/klassFilter.DealKlassState`. `"undef"` став
 * окремим станом 25.08.2026: до того сервер зводив його в `null`, тож 6 угод
 * сторно (−18 004 ₴) були на екрані нерозрізненні з рядком-дзвінком, до якого
 * питання про новизну не стосується. Тримає `#207b`/`#207c`.
 */
export type DealKlass = "new" | "rep" | "undef" | null;
/** Положення перемикача зрізу. `"all"` — не клас, а відсутність звуження. */
export type KlassSlice = "all" | "new" | "rep" | "undef";
export interface ReportPlanDeal {
  name: string; src: DealKlass; source: DealSource; price: number; status: string;
  /** Картка угоди в Kommo — URL будує сервер, піддомен фронт не знає. */
  kommoId: number; url: string;
}

/**
 * 🔎 ДРУГИЙ РІВЕНЬ РОЗГОРТКИ — склад КОНКРЕТНОГО числа в рядку дня.
 * Один роут із параметром `kind`, а не одинадцять ендпоінтів: одинадцять місць —
 * це одинадцять шансів, що склад розійдеться з числом, яке він пояснює.
 */
export type DayItemKind = "created" | "dispatched" | "dispatched_paid" | "dispatched_awaiting"
  | "success" | "paid" | "received" | "avgcheck" | "calls";
export interface DayItem {
  name: string;
  /** Картка угоди в Kommo (для дзвінків — `null`). */
  kommoId: number | null;
  url: string | null;
  src: DealKlass;
  /** ДЖЕРЕЛО угоди — окремий вимір від новизни (`src`). */
  source: DealSource;
  /** Сума показується ЗАВЖДИ; стан — окремим полем, а не замість числа. */
  price: number;
  state: string;
  plannedPayAt: string | null;
  call?: { phone: string | null; durationSec: number; at: string; answered: boolean; recordUrl: string | null };
}
export interface DayItems {
  kind: DayItemKind; day: string; items: DayItem[];
  /** Підсумок розкриття — доказ, що число зійшлося. */
  total: { count: number; sum: number };
}
export async function fetchDayItems(params: { managerId: number; date: string; to?: string; kind: DayItemKind }): Promise<DayItems> {
  const { data } = await api.get<DayItems>("/dashboard/report-plan/day-items", { params });
  return data;
}
/**
 * 🗓 ТИЖНІ МІСЯЦЯ ОДНОГО МЕНЕДЖЕРА — розкриття рядка табличного вигляду.
 * `plan` приходить ІЗ ЗАМОРОЖЕНОГО ЗНІМКА, а не перераховується: `source`
 * каже, чи його зафіксували в понеділок (`live`), чи відновили заднім числом
 * (`backfill`). UI зобовʼязаний цю різницю показати.
 */
export interface ManagerWeek {
  idx: number; from: string; to: string; workingDays: number;
  plan: number; fact: number; pct: number | null; overPlan: number;
  source: "live" | "backfill" | null; reconstructed: boolean;
  /** 🚚 Авто, відправлені того тижня (анкер `load_at`), і тижнева ціль із Задачника. */
  dispatchFact: number;
  /** `null` — тижневої парасольки немає (їх має 17 із 31), тобто цілі не ставили. */
  dispatchTarget: number | null;
  /** ✂️ Тиждень обрізаний межею місяця — не повний Пн–Нд. */
  clipped: boolean;
}
export interface ManagerWeeks { managerId: number; month: string; monthPlan: number; weeks: ManagerWeek[] }
export async function fetchManagerWeeks(params: { managerId: number; month: string }): Promise<ManagerWeeks> {
  const { data } = await api.get<ManagerWeeks>("/dashboard/report-plan/manager-weeks", { params });
  return data;
}

/**
 * ⏱ ЧАСТКА ПОВІЛЬНИХ ЛІДІВ (реакція > 60 хв) по менеджерах.
 * Менеджера без вхідних лідів у видачі немає — на екрані буде «—», а не 0%.
 */
export interface ResponseTimeMgr { managerId: number; n: number; slow: number; pctSlow: number | null }
export async function fetchResponseTimeByManager(params: { from: string; to: string; teamId?: number }): Promise<ResponseTimeMgr[]> {
  const { data } = await api.get<{ managers: ResponseTimeMgr[] }>("/dashboard/response-time/by-manager", { params });
  return data.managers ?? [];
}

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
  id: number; managerId: number | null; userId: number | null; managerName: string; teamId: number | null; teamName: string | null;
  kind: AbsenceKind; startDate: string; endDate: string; hours: number | null; note: string | null;
  status: AbsenceStatus; createdBy: number | null; createdAt: string;
  approvedBy: number | null; approverName: string | null; approvedAt: string | null; mine: boolean;
}
export interface Holiday { id: number; date: string; name: string }
/** `id` = users.id — акаунт; `managerId` довідково (null для ручних акаунтів: HR, бухгалтерія, адміни). */
export interface CalendarManager { id: number; managerId: number | null; name: string; teamId: number | null; teamName: string | null }
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
export async function createAbsence(body: { userId?: number; managerId?: number; kind: AbsenceKind; startDate: string; endDate?: string; hours?: number; note?: string }): Promise<{ ok: boolean; id: number; status: AbsenceStatus }> {
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

export interface TrackerConfig {
  idleThresholdSec: number; heartbeatIntervalSec: number; trackApps: boolean;
  collectHost: boolean; sendTitles: boolean; coalesceSameSource: boolean;
  maxIntervalSec: number; maxClockSkewSec: number;
}
/**
 * 🔴 ЦЕЙ ТИП МУСИТЬ ВІДПОВІДАТИ БЕКЕНДНОМУ ПОЛЕ В ПОЛЕ — тримає гейт `#277`.
 *
 * До 02.09.2026 тут було ШІСТЬ полів із девʼяти: бракувало `planMinPerManager`,
 * `tracker` і `adSources`. `saveSettings` шле САМЕ цей обʼєкт, тобто екран Налаштувань
 * щоразу надсилав неповний набір. Не втрачалось нічого лише тому, що PUT написаний
 * оборонно — кожне поле має фолбек `current.X`, а `tracker` по кожному підполю окремо.
 * Тобто ми були зелені ЗАВДЯКИ ДІРЦІ: варто комусь дописати нове поле без фолбека — і
 * перше ж збереження стерло б його всім, а фронт би цього не помітив.
 *
 * ⚠️ Фолбеки в PUT НЕ прибрано — вони лишаються ДРУГИМ шаром. Перший шар тепер тут.
 */
export interface AppSettings {
  loyaltyThreshold: number;
  loyaltyWindowMonths: number;
  sleepingWindowMonths: number;
  receivablesOverdueWarnDays: number;
  ratesFallbackFullPerKm: number;
  ratesFallbackPartPerKm: number;
  /** Мʼяка нижня межа плану, ₴. 0 = межу свідомо знято. `null` = повернути дефолт. */
  planMinPerManager: number | null;
  tracker: TrackerConfig;
  adSources: string[];
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
  manager_id?: number | null;                 // NULL = ручний користувач, стану не має
  work_state?: "finishing" | "dismissed" | null; // NULL = активний (відсутність рішення)
}

/**
 * 👤 Стан працівника. `state: null` — зняти рішення (людина знову активна).
 * 🔴 «Звільнений» ЗАКРИВАЄ вхід у дашборд, а зняття — відкриває: сервер виводить це зі
 * стану при кожному логіні, тож окремої кнопки «повернути доступ» не існує й не треба.
 */
export async function setWorkState(managerId: number, state: "finishing" | "dismissed" | null, note?: string) {
  const { data } = await api.patch<{ ok: true; state: string; loginEnabled: boolean }>(
    `/settings/managers/${managerId}/work-state`, { state, note });
  return data;
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

/** Чому саме цей відповідальний за борг. `none` — нікого, і екран мусить сказати ЧОМУ. */
export type ReceivableOwnerSource =
  | "override" | "auto-majority" | "auto-teamlead"
  /** Готівковий клієнт: менеджер приходить з УГОД CRM, а не з рахунків дебіторки. */
  | "cash-invoice"
  | "none";

/** Звʼязок рахунку з угодою Kommo. Три РІЗНІ діагнози, не один «немає даних». */
export type ReceivableLinkState =
  | "kommo"        // № угоди є, угода знайдена
  | "one_c"        // виставлено через 1С повз CRM — угоди немає ЗА ЗАДУМОМ
  | "broken_link"; // № угоди є, а угоди немає — це вже проблема, не задум

export type ReceivableEntity = "uts" | "avtomuv" | "fop" | "unknown";
export type ReceivableEntityReason = "one_c" | "broken_link" | "no_payment_type";
/** `na` = «не знаємо», НЕ «не оплачено». Різниця — 1.59 млн фальшивої неоплати. */
export type ReceivableCarrierPaid = "paid" | "unpaid" | "na";
export type ReceivableCarrierReason = "one_c" | "broken_link" | "out_of_map";
export type ReceivableAging = "0-30" | "31-60" | "61-90" | "90+";

/**
 * 💰 КЛІТИНКА МАРЖИНАЛЬНОСТІ — РАХУЄ СЕРВЕР, фронт лише форматує.
 *
 * `pct = null` означає «—», і це НЕ нуль: `why` називає, чого саме бракує.
 * Заміряно 25.08.2026 на живому проді — знаменник це «Приход 1» (повна сума
 * угоди), а НЕ борг: борг падає з кожною оплатою, і `заробили / борг` давало
 * до 6 667%.
 */
export type ReceivableMarginUnknown = "no_deal" | "no_base";
export interface ReceivableMargin {
  earned: number | null;
  base: number | null;
  pct: number | null;
  why: ReceivableMarginUnknown | null;
}

export interface ReceivableTally { n: number; amount: number }
type TallyMap<K extends string> = Partial<Record<K, ReceivableTally>>;

/** Зведення по клієнту — джерело ЯРЛИКІВ у його рядку. */
export interface ReceivableClientFacts {
  clientKey: string;
  invoices: number;
  amount: number;
  link: TallyMap<ReceivableLinkState>;
  entity: TallyMap<ReceivableEntity>;
  carrier: TallyMap<ReceivableCarrierPaid>;
  aging: TallyMap<ReceivableAging>;
  entityReasons: ReceivableEntityReason[];
  carrierReasons: ReceivableCarrierReason[];
  /** Воронки поза `pipeline_stage_map` — НАЗИВАЄМО їх, а не ховаємо. */
  pipelinesOutOfMap: number[];
  oldestAgeDays: number | null;
  /**
   * 💰 Скільки ЗАРОБИЛИ на угодах цього клієнта (`deals.price` — у цьому
   * продукті це вже маржа) і ПОВНА сума тих угод («Приход 1»), яка й є
   * знаменником маржинальності. Рахуються РАЗ НА УГОДУ: два рахунки однієї
   * угоди інакше подвоїли б маржу, і вона виглядала б правдоподібно.
   *
   * `null` — «рахувати нема з чого», і це НЕ нуль: нуль означав би «заробили
   * нічого». Заміряно 25.08.2026: 5 клієнтів із 76 не мають жодної звʼязаної
   * угоди, і саме вони мусять дати «—», а не 0.0%.
   */
  earned: number | null;
  clientPay: number | null;
  /** 🗑 Списано як безнадійне. У `amount` НЕ входить, але видно підписом. */
  writtenOffN: number;
  writtenOffAmount: number;
}

/** Ті самі числа, що в ярликах рядків, — джерело ПЛИТОК. Вираз один на обох. */
export interface ReceivableTotals {
  invoices: number;
  amount: number;
  link: TallyMap<ReceivableLinkState>;
  entity: TallyMap<ReceivableEntity>;
  carrier: TallyMap<ReceivableCarrierPaid>;
  aging: TallyMap<ReceivableAging>;
  entityReason: TallyMap<ReceivableEntityReason>;
  carrierReason: TallyMap<ReceivableCarrierReason>;
  pipelinesOutOfMap: number[];
  /** 💰 Ті самі величини, що в рядках, — по всьому екрану. Вираз один на обох. */
  earned: number | null;
  clientPay: number | null;
  margin: ReceivableMargin | null;
  writtenOffN: number;
  writtenOffAmount: number;
}

export interface ReceivableClient {
  clientKey: string;
  clientName: string;
  amount: number;
  limitDays: number | null;
  /** 💰 Ліміт по СУМІ — незалежний від денного (рішення власника 26.08.2026). */
  limitAmount: number | null;
  overdueDays: number | null;
  comment: string | null;
  dueDate: string | null;
  /**
   * 🗓 Коли домовленість записали. Саме це поле вирішує, чи вона ще актуальна:
   * активним є запис ПІСЛЯ понеділка 00:00 за Києвом (`isCurrentWeekNote`).
   * Нічого не затирається — змінюється лише те, що вважається активним.
   */
  noteUpdatedAt: string | null;
  /**
   * Скільки записів у журналі домовленостей. 0 → кнопки «історія» немає.
   * ⚠️ Рахується по КАНОНІЧНОМУ ключу — так само, як їх віддає `/note-history`.
   * Записи, що лежать на псевдонімах, сюди не входять НАВМИСНО: лічильник,
   * більший за вміст діалогу, був би двома джерелами одного числа.
   */
  noteHistoryCount: number;
  /**
   * 🏢 Юрособа, з ключа якої взято ПОКАЗАНИЙ запис домовленості. `null` —
   * запис лежить на канонічному ключі, тобто рядок такий самий, як завжди.
   */
  noteFrom: string | null;
  /** Назви юросіб решти записів набору — підпис «ще N». Порожньо в 61 рядку з 63. */
  noteOthers: string[];
  /** 🏢 Розклад боргу по юрособах клієнта + звірка з сумою рядка. */
  counterparties: {
    parts: { key: string; name: string | null; n: number; amount: number }[];
    remainder: number;
    ok: boolean;
    show: boolean;
  } | null;
  ownerSource: ReceivableOwnerSource;
  /** Мажоритар до перевірки активності — щоб підпис назвав, кого замінили. */
  majorityName: string | null;
  /** `null` лише коли в клієнта немає жодного рахунку в деталізації. */
  facts: ReceivableClientFacts | null;
  /** 💰 Заробіток / повна сума / %. Рахує сервер тим самим виразом, що плитку. */
  margin: ReceivableMargin | null;
  /**
   * 💰 Скільки рахунків клієнта вже мають гроші у виписці. Та сама функція ядра,
   * що дає бейджі в розкритті — інакше «2 з 5» у рядку й бейджі під ним
   * розійшлися б мовчки.
   */
  paymentSeen: PaymentSeenRoll | null;
}

/** Ручне призначення відповідального. `managerId: null` — свідоме «без відповідального». */
export async function setReceivableOwner(payload: {
  clientKey: string;
  managerId: number | null;
  note: string;
}): Promise<void> {
  await api.put("/dashboard/receivables/owner", payload);
}

/**
 * 🧾 Записати узгоджену відстрочку. `limitDays = 0` — ПОВНОЦІННЕ значення
 * («розглянули і не дали»), а не «порожньо»: щоб прибрати ліміт зовсім, є
 * `clearReceivableLimit`, і це ТРЕТІЙ стан.
 */
/**
 * 🔴 `undefined` І `null` ТУТ РІЗНІ, І ПЛУТАТИ ЇХ НЕ МОЖНА.
 * Поле відсутнє = «не чіпай цей ліміт»; `null` = «зняти саме його». Частковий
 * upsert, що трактує відсутнє як `null`, тихо зніс би сусідній ліміт — рівно та
 * поломка, що вже була в `loyalty-override` (затирало `pinned_manager_id`).
 */
export async function setReceivableLimit(payload: {
  clientKey: string; note: string; limitDays?: number | null; limitAmount?: number | null;
}): Promise<void> {
  await api.put("/dashboard/receivables/limit", payload);
}

/**
 * 🧾 Запит на перегляд ліміту → ЗАГОТОВКА задачі, а не створена задача.
 * Виконавця й дедлайн обирає той, хто ставить (рішення власника 26.08.2026).
 * `existing` — уже відкритий запит на цього клієнта: сервер віддає ЙОГО, а не
 * мовчазний успіх і не другу задачу (унікальність тримає частковий індекс у БД).
 */
export interface LimitRequestDraft {
  taskType: string; clientKey: string; clientName: string; debt: number;
  limitAmount: number | null; limitState: string; title: string; description: string;
}
export interface LimitRequestResp {
  ok: boolean;
  existing: { id: number; title: string; assigneeId: number | null; status: string } | null;
  draft: LimitRequestDraft | null;
  note?: string;
}
export async function requestCreditLimit(clientKey: string): Promise<LimitRequestResp> {
  const { data } = await api.get<LimitRequestResp>("/dashboard/receivables/limit-request", { params: { clientKey } });
  return data;
}

/**
 * Створення задачі про ліміт. Окремий роут, а НЕ `POST /tasks`: контракт
 * Задачника (`routes/tasks.ts`) правиться лише окремою задачею з окремим
 * прийманням, а він не приймає `task_type`/`client_key`/`description`.
 * Форма скопійована з наявного `POST /reactivation-task`, який робить те саме.
 */
export async function createLimitTask(payload: {
  clientKey: string; assigneeId: number; deadline?: string | null; priority?: "low" | "medium" | "high";
}): Promise<{ id: number }> {
  const { data } = await api.post<{ id: number }>("/dashboard/receivables/limit-task", payload);
  return data;
}

/** Прибрати ліміт зовсім → стан «не встановлювали». Дзеркальна дія до setReceivableLimit. */
export async function clearReceivableLimit(clientKey: string): Promise<void> {
  await api.delete(`/dashboard/receivables/limit/${encodeURIComponent(clientKey)}`);
}

/** Зняти ручне призначення — вмикається авто-правило. */
export async function clearReceivableOwner(clientKey: string): Promise<void> {
  await api.delete(`/dashboard/receivables/owner/${encodeURIComponent(clientKey)}`);
}

/**
 * 🔗 Обʼєднати N клієнтів у дебіторці ОДНІЄЮ транзакцією. Пише в ТОЙ САМИЙ реєстр
 * `client_key_alias`, що й екран «Клієнти» — це одні двері до одного реєстру,
 * а не другий механізм.
 *
 * ⚠️ Роз'єднання ЗВІДСИ немає навмисно (в роуті прямо написано, чому: два
 * відкоти до одного реєстру розійшлися б у поведінці швидше, ніж ми про це
 * дізнались би). Розʼєднати можна ТУТ-ТАКИ (кнопка в рядку злитої групи, з
 * превʼю наслідків), а також на екрані «Клієнти»; дебіторка підхопить відкіт на
 * наступному синку (≤15 хв) — не миттєво.
 */
export async function mergeReceivableClients(payload: {
  aliases: string[]; canonical: string; reason: string;
}): Promise<{ merged: number; limitDays: number | null; limitAmount: number | null }> {
  const { data } = await api.post<{ merged: number; limitDays: number | null; limitAmount: number | null }>(
    "/dashboard/receivables/merge", payload);
  return data;
}

/**
 * 🔓 ПРЕВʼЮ РОЗʼЄДНАННЯ — що саме станеться, ДО дії.
 *
 * Дію робить наявний `revokeMerge` (той самий, що на екрані «Клієнти»), тож тут
 * лише показ. Межа читання та сама, що в дії: сервер гейтить обидва
 * `revokeAllowed` за джерелом злиття.
 */
export interface UnmergePreviewData {
  canonicalKey: string;
  splitsInto: { clientKey: string; name: string; amount: number; invoices: number }[];
  parties: number;
  amount: number;
  invoices: number;
  aliasLimitsRestored: { clientKey: string; days: number | null; amount: number | null }[];
  canonicalLimit: {
    now: { days: number | null; amount: number | null; note: string | null };
    before: { kind: "recorded" | "sheet" | "unknown"; days?: number | null; why?: string };
    /** Ніколи не порожній — сервер це гарантує (`#268`). */
    warning: string;
  };
  ownerlessNotes: { text: string; dueDate: string | null; createdAt: string }[];
  notesBecomingVisible: number;
  rebuildMinutes: number;
}

export async function fetchUnmergePreview(canonical: string): Promise<UnmergePreviewData> {
  const { data } = await api.get<UnmergePreviewData>(
    "/dashboard/receivables/unmerge-preview", { params: { canonical } });
  return data;
}

/** Один запис журналу домовленостей — із датою й автором. */
export interface ReceivableNoteEntry { comment: string; author: string | null; at: string }

/**
 * 🗓 Історія домовленостей по клієнту. Поле на екрані показує лише поточний
 * тиждень; усе старіше живе тут і НЕ гине — тому «очищення» безпечне.
 */
export async function fetchReceivableNoteHistory(clientKey: string): Promise<ReceivableNoteEntry[]> {
  const { data } = await api.get<{ entries: ReceivableNoteEntry[] }>(
    "/dashboard/receivables/note-history", { params: { clientKey } });
  return data.entries;
}

/** Один рядок архіву списаних боргів. */
export interface ReceivableWriteoff {
  clientKeyRaw: string; clientName: string | null; invoiceNo: string;
  amount: number; note: string; author: string | null; at: string;
}

/**
 * 🗄 Архів списаних боргів + лічильник розбіжності з CRM.
 *
 * `stillInZone` — угоди, які ми зі СВОЇХ очікуваних прибрали, а в Kommo вони
 * досі на грошовій стадії. Дашборд у цьому місці показує МЕНШЕ за CRM, і це
 * названо числом навмисно: тиха розбіжність — найдорожчий клас помилок.
 */
export interface ReceivableArchive {
  writeoffs: ReceivableWriteoff[];
  totals: { n: number; amount: number; thisMonth: number; oldestAt: string | null; clients: number };
  stillInZone: { deals: number; amount: number };
  canWriteOff: boolean;
  /** 🧾 Чи є сенс малювати кнопку запиту ліміту (тімлід і вище). Право гейтить роут. */
  canRequestLimit: boolean;
}

export async function fetchReceivableArchive(): Promise<ReceivableArchive> {
  const { data } = await api.get<ReceivableArchive>("/dashboard/receivables/writeoffs");
  return data;
}

export async function saveReceivableNote(payload: {
  clientKey: string;
  comment?: string | null;
  dueDate?: string | null;
  /** Порожній `comment` без цього прапорця НЕ стирає текст на сервері (17.09.2026). */
  clear?: boolean;
}): Promise<void> {
  await api.put("/dashboard/receivables/note", payload);
}

export interface ReceivableInvoice {
  /** Чий це рахунок. У розкритті клієнта надлишковий, у ПЛАСКОМУ реєстрі — ключ. */
  clientKey: string;
  clientName: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  /**
   * 🕐 «HH:MM:SS» або `null` — часу не записано.
   * 🔴 `null` НЕ ДОРІВНЮЄ «00:00». 1С пише сентинел `00:00:00`, коли часу немає
   * (заміряно 27.08.2026: 121 із 293 рядків), і парсер перетворює його на `null`
   * ОДИН раз. Показувати тут «00:00» означало б стверджувати мить доби, якої ми
   * не знаємо.
   */
  invoiceTime: string | null;
  /** ЄДРПОУ контрагента з фіду 1С. Порожній у 14 із 298 рядків. */
  edrpou: string | null;
  amount: number;
  serviceUrl: string | null;
  note: string | null;
  dueDate: string | null;
  comment: string | null;
  /** Юрособа КЛІЄНТА, з якої прийшов рахунок. Для обʼєднаного клієнта їх кілька. */
  entityName: string | null;
  entityKey: string | null;
  /** 🔗 Клієнт має активні псевдоніми в реєстрі злиття (сервер, не склад рахунків). */
  clientMerged?: boolean;
  /**
   * 👤 Менеджер САМОГО РАХУНКУ — не той, хто веде клієнта. Після override або
   * склейки це різні люди, і колонка існує саме щоб різницю було видно.
   */
  managerName: string | null;
  /**
   * 🏢 НАША юрособа по цьому рахунку (ЮТС / Автомув / ФОП) — те саме, що в
   * плитці «За нашою юрособою». Не плутати з `entityName`: та про КЛІЄНТА,
   * ця про НАС. Обидві потрібні, і саме тому названі по-різному.
   */
  ourEntity: ReceivableEntity | null;
  /** Чому наша юрособа невідома. «Невідомо» без причини — порожнє місце. */
  ourEntityReason: ReceivableEntityReason | null;
  /**
   * 🚚 Чи оплачений перевізник за цим рахунком. `na` — «не знаємо», і воно
   * ЗАВЖДИ приходить із причиною: відсутність угоди не є фактом неоплати.
   */
  carrierPaid: ReceivableCarrierPaid | null;
  carrierReason: ReceivableCarrierReason | null;
  /**
   * 💰 Чи прийшли гроші за цим рахунком (виписка приходить РАНІШЕ, ніж
   * бухгалтерія рознесе рахунки). Рахує СЕРВЕР — `core/paymentMatch`; фронт
   * лише форматує. Друге виведення тут одного дня розійшлося б зі згорткою
   * «2 з 5» у рядку клієнта, і кожна половина лишилась би правдоподібною.
   */
  paymentSeen: PaymentSeen | null;
  /**
   * 🚚 Скільки заплачено перевізнику. `null` = «суму не вказано» — НЕ нуль і не
   * «не оплачено»: умови виплати просто не заповнені в CRM (30% угод).
   */
  carrierPayAmount: number | null;
  carrierPayType: string | null;
  /** № угоди й чи знайшлась вона. Лінк малюємо ЛИШЕ коли угода справді є. */
  dealId: number | null;
  dealFound: boolean;
  /**
   * 🗑 Рахунок списано як безнадійний. У сумі клієнта його НЕМАЄ, а в розкритті
   * він лишається видимим: плитка, що просіла без сліду, читається як поломка.
   */
  writtenOff: boolean;
  /**
   * 💰 Заробіток УГОДИ, до якої привʼязаний цей рахунок — те саме поле, з якого
   * складається «Заробили» в рядку клієнта. Приходить СИРИМ по кожному рахунку;
   * кому з них малювати число, вирішує `earnedCells` — інакше кілька рахунків
   * однієї угоди подвоїли б Σ колонки.
   */
  earned: number | null;
}

/**
 * 🗑 Списати безнадійний борг — рахунок або клієнта цілком (`invoiceNo` не
 * передано). Право `write_off_debt` = {СЕО, опердир}; кнопки в решти НЕМАЄ,
 * а не «є, але дає 403» — право віддає сервер полем `canWriteOff`.
 *
 * Примітка обовʼязкова, і її вимагає не лише роут, а `CHECK` у БД: списання без
 * «чому» через місяць нічим не відрізняється від помилки.
 */
export async function writeOffReceivable(payload: {
  clientKey: string; invoiceNo?: string | null; note: string;
}): Promise<{ written: number }> {
  const { data } = await api.post<{ written: number }>("/dashboard/receivables/writeoff", payload);
  return data;
}

/** Скасувати списання — тим самим інтерфейсом, із тим самим журналом. */
export async function revokeReceivableWriteoff(payload: {
  clientKey: string; invoiceNo?: string | null; note: string;
}): Promise<{ revoked: number }> {
  const { data } = await api.delete<{ revoked: number }>("/dashboard/receivables/writeoff", { data: payload });
  return data;
}

/**
 * 🕰 `oldestAliveDays` їде РАЗОМ із рахунками — це те саме число, що в колонці
 * «Днів» рядка клієнта, і рахує його сервер одним виразом. Раніше шапка
 * розкриття рахувала вік сама, і на списаному рахунку екран казав двома
 * голосами: «1128 дн.» у рядку і «найстаріший 22 дн.» у шапці під ним.
 */
/**
 * 💰 СТАН «ГРОШІ ЗАЙШЛИ» — ЧОТИРИ ВІДПОВІДІ, І ЖОДНА НЕ ПОРОЖНЯ.
 *
 * 🔴 `ambiguous` існує ОКРЕМО від `none` за рішенням власника 28.08.2026:
 * людина бачить ПРИЧИНУ («платіж називає кілька рахунків») і розвʼязує це
 * очима за дві секунди, тоді як спільне «не зіставлено» відправило б її
 * шукати наосліп. Той самий клас, що «архів ≠ давно втрачений».
 */
export type PaymentSeenKind = "seen" | "stale" | "ambiguous" | "none";
export interface PaymentSeen {
  kind: PaymentSeenKind;
  bookedOn: string | null;
  amount: number | null;
  txId: number | null;
  /** Робочих днів від платежу; після стелі стан стає `stale` і каже про себе. */
  workdays: number | null;
}
/** Скільки рахунків клієнта в якому стані — згортка для рядка списку. */
export interface PaymentSeenRoll { seen: number; stale: number; ambiguous: number; total: number }

export interface ReceivableInvoicesResp { invoices: ReceivableInvoice[]; oldestAliveDays: number | null }
export async function fetchReceivableInvoices(clientKey: string): Promise<ReceivableInvoicesResp> {
  const { data } = await api.get<ReceivableInvoicesResp>("/dashboard/receivables/invoices", { params: { clientKey } });
  return { invoices: data.invoices, oldestAliveDays: data.oldestAliveDays ?? null };
}

/**
 * 📋 РЕЄСТР РАХУНКІВ — ПЛАСКИЙ СПИСОК УСІХ ЖИВИХ РАХУНКІВ У СКОУПІ.
 *
 * 🔴 ТОЙ САМИЙ РОУТ, що й розкриття клієнта, просто без `clientKey`. Окремий
 * роут означав би другий предикат «живий рахунок», другий скоуп і другий набір
 * полів — тобто рівно ту конструкцію, що дала «рядок 2 323 000 проти розкриття
 * 691 000». Тут одне джерело, отже розійтись їм нема як.
 */
export async function fetchInvoiceRegistry(): Promise<ReceivableInvoicesResp> {
  const { data } = await api.get<ReceivableInvoicesResp>("/dashboard/receivables/invoices");
  return { invoices: data.invoices, oldestAliveDays: data.oldestAliveDays ?? null };
}

/**
 * 📋 РЕЄСТР ЗАЯВОК НА ОПЛАТУ ПЕРЕВІЗНИКАМ — угоди воронки «Оплата перевозчикам».
 * Скоуп по менеджеру, що подав (рішення власника 07.09.2026). Лише читання.
 */
export type PaymentRequestKind = "unsorted" | "pending" | "accepted" | "problem" | "paid" | "rejected" | "unknown";
export interface PaymentRequestRow {
  kommoId: number; submittedOn: string;
  clientKey: string | null; clientName: string | null;
  carrierName: string | null; carrierEdrpou: string | null;
  payType: string | null; amount: number | null;
  statusId: number; status: string; kind: PaymentRequestKind;
  managerId: number | null; managerName: string | null; crmUrl: string;
}
export interface PaymentRequestsResp {
  from: string; to: string; rows: PaymentRequestRow[];
  summary: Record<PaymentRequestKind, { n: number; amount: number }>;
}
export async function fetchPaymentRequests(params: { from?: string; to?: string; status?: string }): Promise<PaymentRequestsResp> {
  const { data } = await api.get<PaymentRequestsResp>("/dashboard/receivables/payment-requests", { params });
  return data;
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
/* 🪦 Обгортки `/dashboard/reactivation` (GET/POST/PUT/DELETE) прибрано
   26.08.2026: єдиним споживачем був `ReactivationGrid.tsx`, знятий разом із
   ними. Читальний роут на бекенді видалено (рахував гроші повз `core/money.ts`);
   пишучі лишились без споживачів і знімаються окремим рішенням власника. */


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

/**
 * Відповідь екрана дебіторки.
 *
 * 🔴 `canSetOwner` / `canMerge` рахує СЕРВЕР тими самими виразами, що гейтять
 * роути. Фронт свого правила про доступ не має і мати не повинен: інакше екран
 * матиме власну думку, і вона розійдеться з сервером мовчки.
 */
export interface ReceivablesResponse {
  syncedAt: string | null;
  managers: ReceivableManager[];
  totals: ReceivableTotals | null;
  /** `isAdminScope` — admin · ceo · opdir · kvp · ФІНАНСИСТ (рішення власника 31.07). */
  canSetOwner?: boolean;
  /** `merge_receivables` — admin · ceo · opdir · kvp. Фінансиста тут НЕМАЄ. */
  canMerge?: boolean;
  /**
   * 🧾 Чи можна правити узгоджену відстрочку (Е4). Право `manage_credit_limits`:
   * СЕО · опердир · адмін · КВП · ФІНАНСИСТ. Рахує СЕРВЕР тим самим виразом, що
   * гейтить роут — фронт своєї думки про доступ не має.
   */
  canSetLimit?: boolean;
  /**
   * 🗑 Чи можна списати безнадійний борг. Право `write_off_debt` — РІВНО ДВІ
   * ролі: СЕО й опердир. Адміна тут НЕМАЄ свідомо (рішення власника
   * 25.08.2026): списання зменшує суму на плитці, тобто це визнання втрати
   * грошей, а не операційна дія.
   */
  canWriteOff?: boolean;
  /**
   * 🧾 Чи є сенс малювати кнопку ЗАПИТУ на перегляд ліміту (рішення власника
   * 26.08.2026: «Кнопка тільки в тімліда»). Це ПІДКАЗКА фронту, а не право:
   * роут гейтить сам і ще й звужує тімліда до СВОЄЇ команди по конкретному
   * клієнту. Схована кнопка правом не є.
   */
  canRequestLimit?: boolean;
  /**
   * 🔗 Скільки псевдонімів уже зібрано під кожним канонічним ключем. Діалог
   * обʼєднання читає це, щоб не пропонувати приречену дію: ключ, який уже є
   * канонічним, псевдонімом стати НЕ МОЖЕ — тригер `client_key_alias_no_chain`
   * відхилить, і людина дізналась би правило з тексту помилки 409.
   */
  canonicalOf?: Record<string, number>;
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
}): Promise<ReceivablesResponse> {
  const { data } = await api.get<ReceivablesResponse>(
    "/dashboard/receivables",
    { params }
  );
  return data;
}

export interface TeamManagerRow {
  id: number;
  name: string;
  /**
   * 🔴 `false` = ЗВІЛЬНЕНИЙ. Гроші лишаються в розрізі (рішення власника
   * 05.08.2026: is_active керує списками й вибором, НЕ історичними сумами), але
   * рядок мусить це СКАЗАТИ — інакше вчорашня людина виглядає як діючий менеджер.
   */
  isActive?: boolean;
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
  // 🎧 Джерело останньої розмови: нотатка Kommo чи Ringostat (де розмови в Kommo немає).
  talkSource: "kommo" | "ringostat" | null;
  // ⚠️ Розмова є, але у клієнта кілька відкритих угод — привʼязати її до ЦІЄЇ не можна.
  talkAmbiguous: boolean;
  // Нотатка менеджера по угоді. canEditNote рахує СЕРВЕР (відповідальний + тімлід/адмін);
  // тут вона лише керує тим, показати поле чи текст — write-роут перевіряє право сам.
  note: string | null; noteAuthor: string | null; noteAt: string | null; canEditNote: boolean }
export interface StuckManagerGroup { managerId: number; manager: string; teamId: number | null; teamTag: string | null; count: number; sumAtRisk: number; longestIdleDays: number; deals: StuckGroupDeal[] }
export interface StuckGrouped { minDays: number; role: string; scope: "company" | "team" | "own"; total: number; sumRisk: number; managers: number; over90: number; groups: StuckManagerGroup[];
  /** 🕰 Дані станом на цей момент (найстаріший із синків, що живлять екран). */
  asOf: string; talkAmbiguousCount: number;
  /**
   * ⏳ Чи показувати «(N год тому)». Вирішує СЕРВЕР: поріг = 2× штатний інтервал
   * тієї джоби, що відстає (`MONITORED_JOBS.everyMin`). Фронт свого числа годин
   * НЕ має — інакше правило жило б двома копіями і розійшлось би мовчки.
   */
  asOfStale: boolean; asOfAgeMin: number; asOfStaleAfterMin: number; asOfJob: string | null }
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
  /** 🏷 Причина закриття їхала в базу й ніколи не поверталась — з 07.09.2026 віддається. */
  closeReason?: string | null;
  closedAt?: string | null;
  closedByName?: string | null;
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
  /** Виконавець-АКАУНТ (`users.id`) — для тих, кого немає в CRM. Разом з `assigneeId` неможливий. */
  assigneeUserId?: number | null;
  /** Особиста група-папка. `groupName` приходить ЛИШЕ для власних груп — чужі виглядають як «без групи». */
  groupId?: number | null;
  groupName?: string | null;
  commentCount?: number;
  /**
   * 📎 Скільки вкладень. `null` — НЕ «нуль», а «не моя задача»: вкладення бачать
   * лише автор і виконавець (рішення власника 14.09.2026), і сервер свідомо не
   * називає наглядачеві навіть кількість. Екран мусить показати це як невідоме
   * (замок), а не як «файлів немає».
   */
  fileCount?: number | null;
  /** Хто поклав файли (через кому) — лише власнику, як і лічильник. */
  fileAuthors?: string | null;
  /** Імʼя автора задачі — щоб на «Спільних» було видно, ВІД КОГО вона. */
  createdByName?: string | null;
  /** «Є нове»: доповнення або зміна статусу після мого останнього перегляду і НЕ мною. */
  hasUnseen?: boolean;
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
  /** Рівень цілі-показника — ЛИШЕ тиждень: місячну ціль знято 18.08.2026. */
  period: "week";
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
  groupId?: number | null;
  assigneeUserId?: number | null;
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
    groupId: number | null;
    assigneeUserId: number | null;
    checklistJson: ChecklistItem[] | null;
    subtasksJson: Subtask[] | null;
  }>
): Promise<void> {
  await api.patch(`/tasks/${id}`, payload);
}

export async function deleteTask(id: number): Promise<void> {
  await api.delete(`/tasks/${id}`);
}

// ── Спільна задача: групи · стрічка · історія · вкладення (14.09.2026) ──

/** Особиста група-папка. Чужих не бачимо — сервер фільтрує по власнику. */
export interface TaskGroup { id: number; name: string; parentId: number | null; createdAt: string; taskCount: number }
export interface TaskComment { id: number; body: string; createdAt: string; authorId: number | null; authorName: string | null }
export interface TaskFile {
  id: number; name: string; mime: string | null; sizeBytes: number | string;
  createdAt: string; createdById: number | null; author: string | null;
}
export interface TaskHistoryEntry {
  id: number; fromStatus: TaskStatus | null; toStatus: TaskStatus;
  changedAt: string; changedByName: string | null;
}
/** Кандидат у виконавці-акаунти. Сервер віддає імʼя без email — логін не їде на екран. */
export interface TaskAssignee { id: number; name: string; nameIsLogin: boolean; managerId: number | null }

/** 🔴 Ліміт файла 5 МБ — рішення Романа 14.09.2026. Дзеркалить `FILE_MAX_BYTES` сервера. */
export const TASK_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** Ліміт кількості на задачу — дзеркалить `FILES_PER_TASK` сервера (гейт `#399i`). */
export const TASK_FILES_PER_TASK = 2;

export async function fetchTaskGroups(): Promise<TaskGroup[]> {
  const { data } = await api.get<{ groups: TaskGroup[] }>("/tasks/groups");
  return data.groups;
}
export async function createTaskGroup(name: string): Promise<TaskGroup> {
  const { data } = await api.post<TaskGroup>("/tasks/groups", { name });
  return data;
}
export async function renameTaskGroup(id: number, name: string): Promise<void> {
  await api.patch(`/tasks/groups/${id}`, { name });
}
export async function deleteTaskGroup(id: number): Promise<void> {
  await api.delete(`/tasks/groups/${id}`);
}

export async function fetchTaskComments(taskId: number): Promise<TaskComment[]> {
  const { data } = await api.get<{ comments: TaskComment[] }>(`/tasks/${taskId}/comments`);
  return data.comments;
}
export async function createTaskComment(taskId: number, body: string): Promise<TaskComment> {
  const { data } = await api.post<TaskComment>(`/tasks/${taskId}/comments`, { body });
  return data;
}

export async function fetchTaskHistory(taskId: number): Promise<TaskHistoryEntry[]> {
  const { data } = await api.get<{ history: TaskHistoryEntry[] }>(`/tasks/${taskId}/history`);
  return data.history;
}

export async function fetchTaskFiles(taskId: number): Promise<TaskFile[]> {
  const { data } = await api.get<{ files: TaskFile[] }>(`/tasks/${taskId}/files`);
  return data.files;
}
/** Завантаження вкладення — base64 у тілі, як у регламентах (multipart у проєкті немає). */
export async function uploadTaskFile(taskId: number, file: File): Promise<TaskFile> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const { data } = await api.post<TaskFile>(`/tasks/${taskId}/files`, {
    filename: file.name, mime: file.type || null, dataBase64,
  });
  return data;
}
export async function deleteTaskFile(taskId: number, fileId: number): Promise<void> {
  await api.delete(`/tasks/${taskId}/files/${fileId}`);
}
/** Тягне вкладення авторизованим стрімом як blob-URL (Bearer у інтерсепторі). */
export async function fetchTaskFileBlobUrl(taskId: number, fileId: number): Promise<string> {
  const { data } = await api.get(`/tasks/${taskId}/files/${fileId}`, { responseType: "blob" });
  return URL.createObjectURL(data as Blob);
}

/** «Я це бачив» — гасить бейдж «є нове». Кличеться на ВІДКРИТТІ задачі, не на списку. */
export async function markTaskSeen(taskId: number): Promise<void> {
  await api.post(`/tasks/${taskId}/seen`, {});
}

export async function fetchTaskAssignees(): Promise<TaskAssignee[]> {
  const { data } = await api.get<{ assignees: TaskAssignee[] }>("/tasks/assignees");
  return data.assignees;
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
    options: { tonnage: string; kind?: "vehicle" | "partial"; margin: number | null; per_km_min: number; per_km_max: number; total_min: number | null; total_max: number | null; client_min: number | null; client_max: number | null; selected: boolean }[];
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

// ── Регламенти та документи v2 (15.09.2026): розділи, типи, версії, доступи, підпис, архів ──
export type DocSection = "general" | "personal" | "offer";
export type DocSigKind = "not_required" | "signed" | "review" | "pending" | "overdue" | "outdated";
export const DOC_TYPES = ["Регламент", "Інструкція", "Шаблон", "Офер", "Матеріал для клієнта", "Інше"] as const;
export interface DocFolder { id: number; parentId: number | null; name: string; createdAt: string; sortOrder: number }
export interface DocFile {
  id: number; folderId: number | null; name: string; category: string | null; mime: string | null; sizeBytes: number | null;
  createdAt: string; updatedAt: string; section: DocSection; addresseeUserId: number | null; addressee: string | null;
  description: string | null; version: number; sha256: string | null; archivedAt: string | null; archivedReason: string | null;
  /** «Неактивний»: повернутий з архіву після повернення людини; активує керівництво. */
  inactiveAt: string | null;
  author: string | null; createdBy: number | null;
  /** `earlier` — керівництво відмітило «підписано раніше на папері». */
  signature: { kind: DocSigKind; days: number | null; earlier?: boolean };
  canEdit: boolean; canSign: boolean;
  /** 📖 Ознайомлення (лише загальні регламенти): мій стан і прогрес аудиторії (done/total лише керівництву). */
  ack: { required: boolean; mine: "not_required" | "acked" | "pending"; done: number | null; total: number | null };
  /** 🆕 Я ще не відкривав поточну версію, і їй не більше 30 днів. */
  isNew: boolean;
  /** 🔐 У документа є власні права ролей, відмінні від папки (приходить лише керівництву). */
  ownRights: boolean;
}
export interface DocTree {
  folders: DocFolder[]; files: DocFile[];
  counts: { general: number; personal: number; offer: number; archive: number };
  sections: { general: boolean; personal: boolean; offer: boolean; archive: boolean };
  viewer: { userId: number; roleKey: string; isManagement: boolean; canManageAccess: boolean; canUploadRoot: boolean; uploadFolders: number[] };
  types: readonly string[];
}
export async function fetchDocTree(): Promise<DocTree> {
  const { data } = await api.get<DocTree>("/documents/tree");
  return data;
}
export interface DocCard {
  file: DocFile;
  versions: { version: number; sha256: string; mime: string | null; size_bytes: string | null; created_at: string; author: string | null }[];
  signatures: { id: number; version: number; sha256: string; signedAt: string; method: string; signer: string | null; hasEvidence: boolean; current: boolean; approvedAt: string | null; rejectedAt: string | null; rejectedReason: string | null }[];
  events: { kind: string; at: string; details: Record<string, unknown> | null; actor: string | null }[];
}
export async function fetchDocCard(id: number): Promise<DocCard> {
  const { data } = await api.get<DocCard>(`/documents/file/${id}`);
  return data;
}
export async function fetchDocViewers(id: number): Promise<{ who: { label: string; note: string }[]; exceptions: { name: string; until: string | null }[] }> {
  const { data } = await api.get(`/documents/file/${id}/viewers`);
  return data;
}
export async function fetchDocPeople(): Promise<{ userId: number; name: string; role: string; team: string | null }[]> {
  const { data } = await api.get<{ people: { userId: number; name: string; role: string; team: string | null }[] }>("/documents/people");
  return data.people;
}
export async function createDocFolder(name: string, parentId: number | null): Promise<void> { await api.post("/documents/folder", { name, parentId }); }
export async function renameDocFolder(id: number, name: string): Promise<void> { await api.patch(`/documents/folder/${id}`, { name }); }
/** Перенести папку в іншу (`null` — у корінь). */
export async function moveDocFolder(id: number, parentId: number | null): Promise<void> { await api.patch(`/documents/folder/${id}`, { parentId }); }
/** Порядок папок усередині одного батька: повний список сусідів у бажаному порядку. */
export async function orderDocFolders(parentId: number | null, ids: number[]): Promise<void> { await api.put(`/documents/folders/order`, { parentId, ids }); }
/** ✍️ «Підписано раніше на папері» — без повторного підпису; `signedOn` РРРР-ММ-ДД необовʼязкова. */
export async function presignDocFile(id: number, signedOn?: string | null): Promise<void> { await api.post(`/documents/file/${id}/presigned`, { signedOn: signedOn || null }); }
export async function undoPresignDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/presigned/undo`); }
export async function deleteDocFolder(id: number): Promise<void> { await api.delete(`/documents/folder/${id}`); }
export async function uploadDocFile(body: {
  folderId: number | null; filename: string; mime: string | null; category?: string | null; dataBase64: string;
  section: DocSection; addresseeUserId?: number | null; description?: string | null;
}, onProgress?: (pct: number) => void): Promise<DocFile> {
  const { data } = await api.post<DocFile>("/documents/file", body, {
    onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100)); },
  });
  return data;
}
export async function uploadDocVersion(id: number, body: { filename: string; mime: string | null; dataBase64: string }): Promise<{ version: number }> {
  const { data } = await api.post<{ version: number }>(`/documents/file/${id}/version`, body);
  return data;
}
export async function updateDocFile(id: number, patch: { name?: string; category?: string | null; description?: string | null; folderId?: number | null }): Promise<void> {
  await api.patch(`/documents/file/${id}`, patch);
}
export async function archiveDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/archive`); }
export async function restoreDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/restore`); }
export async function activateDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/activate`); }
export async function deleteDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/delete`); }
export interface DocTrashFile { id: number; name: string; category: string | null; section: string; mime: string | null; sizeBytes: number | null; version: number; deletedAt: string; deletedBy: string | null; addressee: string | null; folderId: number | null }
export async function fetchDocTrash(): Promise<DocTrashFile[]> { const { data } = await api.get<{ files: DocTrashFile[] }>("/documents/trash"); return data.files; }
export async function undeleteDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/undelete`); }
export async function ackDocFile(id: number): Promise<void> { await api.post(`/documents/file/${id}/ack`); }
export async function fetchDocAcks(id: number): Promise<{ people: { userId: number; name: string; ackedAt: string | null; hasTelegram: boolean }[]; done: number; total: number }> { const { data } = await api.get(`/documents/file/${id}/acks`); return data; }
export async function remindDocAcks(id: number): Promise<{ sent: number; noTelegram: number; missing: number }> { const { data } = await api.post(`/documents/file/${id}/ack-remind`); return data; }
export type SignBody =
  | { method: "paper_photo"; filename: string; dataBase64: string }
  | { method: "telegram_code"; step: "send" }
  | { method: "telegram_code"; step: "verify"; code: string };
export async function signDocFile(id: number, body: SignBody): Promise<{ ok?: boolean; sent?: boolean; expiresInSec?: number }> {
  const { data } = await api.post<{ ok?: boolean; sent?: boolean; expiresInSec?: number }>(`/documents/file/${id}/sign`, body);
  return data;
}
/** 🤖 Привʼязка Telegram до акаунта (бот «UTS Підпис»): для кодів підпису й нагадувань. */
export interface TelegramStatus { configured: boolean; linked: boolean; linkedAt: string | null; botUsername: string | null }
/** 🗂 Живі вкладки ролі (сайдбар не довіряє знімку в токені). */
export async function fetchLiveScreens(): Promise<{ roleKey: string; screens: string[] }> { const { data } = await api.get<{ roleKey: string; screens: string[] }>("/auth/screens"); return data; }
export async function fetchTelegramStatus(): Promise<TelegramStatus> { const { data } = await api.get<TelegramStatus>("/auth/telegram"); return data; }
export async function createTelegramLink(): Promise<{ url: string; code: string; botUsername: string; expiresInSec: number }> { const { data } = await api.post<{ url: string; code: string; botUsername: string; expiresInSec: number }>("/auth/telegram-link"); return data; }
export async function unlinkTelegram(): Promise<void> { await api.post("/auth/telegram-unlink"); }
export interface DocFolderAccess {
  roles: { key: string; name: string; management: boolean; canView: boolean; canUpload: boolean; canEdit: boolean; canPublish: boolean; canManage: boolean; inheritedFrom?: number | null }[];
  grants: { id: number; userId: number; name: string; canView: boolean; canUpload: boolean; expiresAt: string | null }[];
  log: { action: string; details: Record<string, unknown> | null; at: string; actor: string | null }[];
}
export async function fetchDocFolderAccess(folderId: number): Promise<DocFolderAccess> {
  const { data } = await api.get<DocFolderAccess>(`/documents/access/${folderId}`);
  return data;
}
export async function saveDocFolderAccess(folderId: number, body: {
  roles: { key: string; canView: boolean; canUpload: boolean; canEdit: boolean; canPublish: boolean }[];
  grants: { userId: number; canView: boolean; canUpload: boolean; expiresAt: string | null }[];
}): Promise<void> { await api.put(`/documents/access/${folderId}`, body); }
/** 📄 Перегляд Word/Excel: структура, яку фронт малює сам (не HTML). */
export type DocxRun = { text: string; b?: boolean; i?: boolean; u?: boolean };
export type DocxBlock = { t: "p" | "li"; runs: DocxRun[] } | { t: "h"; level: 1 | 2 | 3; runs: DocxRun[] } | { t: "table"; rows: string[][] };
export type DocRender =
  | { kind: "docx"; version: number; blocks: DocxBlock[]; truncated: boolean; hasImages: boolean }
  | { kind: "xlsx"; version: number; sheets: { name: string; rows: string[][]; totalRows: number; totalCols: number; truncated: boolean }[] };
export async function fetchDocRender(fileId: number): Promise<DocRender> {
  const { data } = await api.get<DocRender>(`/documents/file/${fileId}/render`);
  return data;
}
/** 🔎 Пошук по тексту видимих документів; «не шукались» і «обробляються» — окремими числами. */
export interface DocTextSearch { hits: { id: number; snippet: string; count: number }[]; searched: number; notSearchable: number; pending: number }
export async function searchDocText(q: string): Promise<DocTextSearch> {
  const { data } = await api.get<DocTextSearch>("/documents/search", { params: { q } });
  return data;
}
/** 🔐 Власні права документа: по ролі — права папки і власний рядок (null = «як у папці»). */
export interface DocFileAccess {
  applicable: boolean;
  roles: { key: string; name: string; management: boolean; folder: { canView: boolean; canEdit: boolean }; own: { canView: boolean; canEdit: boolean } | null }[];
  log: { action: string; details: Record<string, unknown> | null; at: string; actor: string | null }[];
}
export async function fetchDocFileAccess(fileId: number): Promise<DocFileAccess> {
  const { data } = await api.get<DocFileAccess>(`/documents/file/${fileId}/access`);
  return data;
}
export async function saveDocFileAccess(fileId: number, roles: { key: string; own: { canView: boolean; canEdit: boolean } | null }[]): Promise<void> {
  await api.put(`/documents/file/${fileId}/access`, { roles });
}
/** Файл авторизованим стрімом як blob-URL; `inline` — для прев'ю в iframe/img. */
export async function fetchSigEvidenceBlobUrl(fileId: number, sigId: number): Promise<string> {
  const { data } = await api.get(`/documents/file/${fileId}/signature/${sigId}/evidence`, { responseType: "blob" });
  return URL.createObjectURL(data as Blob);
}
export async function approveDocSignature(fileId: number, sigId: number): Promise<void> { await api.post(`/documents/file/${fileId}/signature/${sigId}/approve`); }
export async function rejectDocSignature(fileId: number, sigId: number, reason: string): Promise<void> { await api.post(`/documents/file/${fileId}/signature/${sigId}/reject`, { reason }); }
export async function fetchDocFileBlobUrl(id: number, opts: { inline?: boolean; version?: number } = {}): Promise<string> {
  const { data } = await api.get(`/documents/file/${id}/download`, { responseType: "blob", params: { inline: opts.inline ? 1 : undefined, version: opts.version } });
  return URL.createObjectURL(data as Blob);
}

// ── Навчання (training) ──
export interface TrainingFolder {
  id: number; parent_id: number | null; name: string; position: number; created_at: string; course_id?: number | null;
}
export type TrainingKind = "video_embed" | "file" | "link" | "text";
export interface TrainingMaterial {
  id: number; folder_id: number | null; title: string; kind: TrainingKind;
  url: string | null; mime: string | null; size_bytes: string | number | null;
  content: string | null; position: number; created_at: string; author?: string | null;
  status?: "draft" | "published"; created_by_ai?: boolean; required?: boolean;
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
export async function updateTrainingFolder(id: number, patch: { name?: string; parentId?: number | null; position?: number; courseId?: number | null; force?: boolean }): Promise<void> {
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
export async function updateTrainingMaterial(id: number, patch: { title?: string; content?: string | null; url?: string | null; folderId?: number | null; position?: number; required?: boolean }): Promise<void> {
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
/**
 * 📅 `month` (YYYY-MM) звужує історію до ОДНОГО місяця. Без нього лишається старе
 * «останні N місяців» — фолбек для бандла, що ще крутиться у відкритих вкладках.
 */
export async function fetchOneOnOneStats(type: string, months = 6, month?: string): Promise<OneOnOneStatRow[]> {
  const { data } = await api.get<{ rows: OneOnOneStatRow[] }>("/one-on-ones/stats/scores",
    { params: month ? { type, month } : { type, months } });
  return data?.rows ?? [];
}
// ── Коротка аналітика 1×1 (сигнали за місяць) ────────────────────────────────
export type O2OSignalKey = "missed" | "never" | "avgLow" | "drop" | "enpsLow" | "answerLow" | "tasksOpen";
export interface O2OSignalHit { key: O2OSignalKey; value: number | null; detail: string }
export interface O2OPersonFinding {
  managerId: number; name: string; teamId: number | null; teamName: string | null;
  owed: string; hits: O2OSignalHit[];
}
export interface O2OTeamRollUp {
  teamId: number | null; teamName: string; people: number;
  bySignal: Record<O2OSignalKey, number>;
}
export interface O2OWeakQuestion { qKey: string; label: string | null; avg: number; answers: number }
export interface O2OAnalytics {
  month: string; prevMonth: string; rosterSize: number;
  /** Які типи 1×1 ця роль має право бачити. Порожній блок при `false` — це «недоступно», а не «0». */
  sources: Record<string, boolean>;
  thresholds: Record<string, number>;
  labels: Record<O2OSignalKey, string>;
  notes: Record<O2OSignalKey, string>;
  counts: Record<O2OSignalKey, number>;
  people: O2OPersonFinding[];
  teams: O2OTeamRollUp[];
  weakQuestions: O2OWeakQuestion[];
  /** Задачі 1×1 без дедлайну — у жоден місяць не потрапляють, тому названі окремо. */
  tasksWithoutDeadline: number;
}
/** Сигнали за ОДИН місяць (`YYYY-MM`). Правила й пороги рахує ядро на сервері. */
export async function fetchO2OAnalytics(month: string): Promise<O2OAnalytics> {
  const { data } = await api.get<O2OAnalytics>("/one-on-ones/analytics", { params: { month } });
  return data;
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

/** Смуга оцінки eNPS — межі рахує СЕРВЕР; фронт отримує ключ, підпис і тон. */
export interface O2OEnpsBand { key: string; label: string; tone: "green" | "amber" | "orange" | "red"; from: number; to: number }
export interface O2OEnpsSummary {
  total: number; promoters: number; passives: number; detractors: number;
  /** Бали поза шкалою 0-10: у знаменник НЕ входять, але мусять бути названі числом. */
  invalid: number;
  promotersPct: number; passivesPct: number; detractorsPct: number;
  /** null = оцінок немає (це НЕ нуль: нуль читався б як результат). */
  enps: number | null;
  band: O2OEnpsBand | null;
}
export interface O2OEnpsPoint extends O2OEnpsSummary { bucket: string }
export interface O2OEnpsResponse {
  from: string; to: string; granularity: "day" | "week" | "month";
  summary: O2OEnpsSummary; series: O2OEnpsPoint[];
}
/** Період ДОВІЛЬНИЙ, обидва кінці включно (1×1 не тримаються меж місяця). */
export async function fetchO2OEnps(from: string, to: string): Promise<O2OEnpsResponse> {
  const { data } = await api.get<O2OEnpsResponse>("/one-on-ones/enps", { params: { from, to } });
  return data;
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
/**
 * 🏦 Виписка у форматі банку (CSV). Файл іде blob-ом; три лічильники — заголовками, щоб екран
 * сказав, скільки рядків у файлі, скільки відкинула межа прихованих і чи губились символи.
 */
export async function downloadBankStatement(p: { account: number; from: string; to: string }): Promise<{ blob: Blob; filename: string; rows: number; hiddenExcluded: number; charsLost: number }> {
  const res = await api.get("/bank/statement.csv", { params: p, responseType: "blob" });
  const h = res.headers as Record<string, string | undefined>;
  const m = /filename="([^"]+)"/.exec(h["content-disposition"] ?? "");
  return { blob: res.data as Blob, filename: m?.[1] ?? `statement_${p.account}_${p.from}_${p.to}.csv`,
    rows: Number(h["x-rows"] ?? 0), hiddenExcluded: Number(h["x-hidden-excluded"] ?? 0), charsLost: Number(h["x-chars-lost"] ?? 0) };
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

/**
 * 🖥 SHA ЦЬОГО БАНДЛА — вшивається на збірці (`define` у `vite.config.ts`).
 * `"unknown"` тут легальне: збірка без git. Бекенд прочитає його як «не знаю».
 */
declare const __BUILD_SHA__: string;
export const BUILD_SHA: string = typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "unknown";

/**
 * Чи крутить ЦЯ вкладка стару збірку. Рішення ухвалює СЕРВЕР (`core`-правило
 * `clientStale` у `backend/src/version.ts`) — фронт лише повідомляє свою версію
 * і малює відповідь.
 *
 * 🔴 Правило свідомо НЕ дублюється тут. У фронті немає тестового прогону взагалі
 * (нуль файлів `*.test.ts*`), тож копія правила була б неперевірюваною за
 * побудовою — а дві копії одного правила в цьому проєкті вже розходились.
 *
 * `null` = «невідомо» (немає вшитої sha, сервер без версії, мережа впала).
 * Невідоме НЕ є приводом показати плашку.
 */
/**
 * Вердикт «застарів» + sha сервера, на якому він винесений. Друге поле потрібне
 * банеру, щоб відрізнити «людина закрила плашку на ЦЬОМУ викаті» від «після
 * закриття вийшов ЩЕ один викат» — булевого вердикту для цього замало.
 */
export async function fetchClientStale(): Promise<{ stale: boolean | null; serverSha: string | null }> {
  try {
    const { data } = await api.get<{ clientStale?: boolean | null; version?: { sha?: string; shortSha?: string } }>("/health", {
      params: { loaded: BUILD_SHA },
    });
    return { stale: data?.clientStale ?? null, serverSha: data?.version?.sha ?? data?.version?.shortSha ?? null };
  } catch {
    // Мережа/челендж/500 — це «не знаю», а не «оновись». Плашка, що спалахує на
    // кожному моргані звʼязку, навчає її ігнорувати.
    return { stale: null, serverSha: null };
  }
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
  /** ⭐ Включений КВП вручну попри правило + примітка «чому» (у підказці). */
  forcedRegular: boolean; forceNote: string | null;
  /** 💬 Останній коментар — видно прямо в рядку, повний текст у підказці. */
  lastComment: LastComment | null;
  /**
   * 🔵 Стан клієнта СЬОГОДНІ. `planOnly` = рядок у списку ЛИШЕ тому, що за ним
   * лишився план цього місяця; ставити йому НОВИЙ план не можна — він уже не
   * в активних. Без цієї позначки він читався б як живий.
   */
  state: "active" | "sleeping" | "lost" | "oneoff";
  planOnly: boolean;
  /** Звідки рядок у списку: активний · не замовляє (колишня вкладка) · лише через план. */
  inRoster: "active" | "reactivation" | "planOnly";
  /**
   * Поля колишньої вкладки «Реактивація» — у тому самому рядку (обʼєднання 05.09.2026).
   * `null` означає «не стосується цього клієнта», і екран підписує це словом.
   */
  daysSince: number | null;
  value: number | null;
  seasonal: boolean;
  seasonalNote: string | null;
  lastTalk: string | null;
  lastTalkDays: number | null;
  /** 📱 Останній контакт: свіжіше з розмови Ringostat і ручного запису (Viber/Telegram/…). */
  lastContact?: { at: string; source: "talk" | "manual"; channel: string | null } | null;
  lastContactHasFile?: boolean;
  attempts: number;
  taskId: number | null;
  taskStatus: string | null;
  taskDeadline: string | null;
  taskAssignee: string | null;
  closeReason: string | null;
  returned: boolean;
}
/** 🕳 План, під яким немає клієнтського рядка (дженерик-ключ Kommo). */
export interface UnattachedPlan {
  clientKey: string; plan: number; status: string;
  managerId: number | null; managerName: string | null;
}
export interface ClientPlansResp {
  month: string; historyMonths: string[];
  weeks: { label: string; from: string; to: string; status: "past" | "current" | "future"; workingDays: number }[];
  /** Довідники дій, що переїхали з вкладки «Реактивація». Приходять із ядра. */
  closeReasons?: { key: string; label: string }[];
  thresholds?: { sleepingDays: Record<string, number>; lostDays: number; longLapsedDays: number };
  clients: ClientPlanRow[];
  totals: {
    planTotal: number; planApproved: number; factTotal: number; pct: number | null;
    filledClients: number; totalClients: number;
    currentWeekIndex: number | null; currentWeekFact: number | null; currentWeekPlan: number | null;
    atRiskCount: number; atRiskNames: string[]; goesToManagerPlan: number;
    byStatus: Record<string, number>; canSubmit: boolean; canApprove: boolean;
    /** Скільки рядків у списку — ЛИШЕ через план (клієнт уже не активний). */
    planOnlyClients: number;
    rosterClients: number;
    byState: { active: number; reactivation: number; planOnly: number };
    /** 🕳 Плани без клієнтського рядка. `canSee` вирішує СЕРВЕР (isAdminScope). */
    unattached: { canSee: boolean; count: number; sum: number; rows: UnattachedPlan[] };
    /** 💡 «минулого місяця було N планів на X ₴» — контекст для порожнього місяця. */
    prevMonth: { month: string; count: number; sum: number };
    /** 🌉 МІСТОК: скільки постійних пішло в реактивацію. У Σ плану НЕ входить. */
    inReactivation: number; inReactivationSleeping: number; inReactivationLost: number;
    /** «Давно втрачені · понад рік» — ПІДМНОЖИНА втрачених, у Σ не додається.
     *  НЕ реєстр архіву (вкладка «Архів») — це вік без оплат, не ручна дія. */
    longLapsedCount: number;
    /** 🎯 Разові — не проходять двошляхову кваліфікацію; ні тут, ні в реактивації. */
    oneOff: number;
    /** 📵 Сплячі/втрачені з ключем-телефоном без безналу — фільтр реактивації їх прибрав. */
    skippedGeneric: number;
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
export interface ClientCallYear { year: number; calls: number; talks: number; totalSec: number; lastAt: string | null }
export interface ClientCall {
  at: string; direction: "in" | "out"; billsec: number; answered: boolean;
  disposition: string | null; manager: string | null;
  /** 🎧 Пряме посилання на запис у кабінеті Ringostat. Відкривається без логіна. */
  recording: string | null;
}
export interface ClientContact {
  id: number; channel: string; note: string | null; fileName: string | null; hasFile: boolean;
  fileUrl: string | null; createdAt: string; createdById: number | null; author: string | null;
}
export const CONTACT_CHANNELS: { key: string; label: string }[] = [
  { key: "viber", label: "Viber" }, { key: "telegram", label: "Telegram" }, { key: "email", label: "Email" },
  { key: "call", label: "Дзвінок з особистого" }, { key: "other", label: "Інше" },
];
export function contactChannelLabel(key: string | null): string {
  return CONTACT_CHANNELS.find((c) => c.key === key)?.label ?? (key ?? "");
}
export async function fetchClientContacts(clientKey: string): Promise<ClientContact[]> {
  const { data } = await api.get<{ contacts: ClientContact[] }>("/dashboard/client-contacts", { params: { clientKey } });
  return data.contacts;
}
export async function addClientContact(p: { clientKey: string; channel: string; note: string; file?: File | null }): Promise<ClientContact> {
  let dataBase64: string | undefined;
  if (p.file) {
    dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(p.file!);
    });
  }
  const { data } = await api.post<{ contact: ClientContact }>("/dashboard/client-contacts", {
    clientKey: p.clientKey, channel: p.channel, note: p.note, dataBase64, filename: p.file?.name, mime: p.file?.type || null,
  });
  return data.contact;
}
export async function deleteClientContact(id: number): Promise<void> { await api.delete(`/dashboard/client-contacts/${id}`); }
/** Скрин віддається лише з токеном, тож тягнемо через axios і показуємо як blob. */
export async function fetchContactFileBlobUrl(id: number): Promise<string> {
  const { data } = await api.get(`/dashboard/client-contacts/${id}/file`, { responseType: "blob" });
  return URL.createObjectURL(data as Blob);
}

export interface ClientCard {
  /** 📱 Контакти з клієнтом поза дзвінками (Viber/Telegram/…), зі скринами. */
  contacts?: ClientContact[];
  /** 📞 Дзвінки по роках. `callsSince` — глибина памʼяті: порожній рік до неї означає «даних немає». */
  callsByYear?: ClientCallYear[];
  calls?: ClientCall[];
  callsShown?: number;
  callsLimit?: number;
  callsSince?: string | null;
  /** 🗒 Журнал керівницьких дій: архів, повернення з архіву, зміна відповідального. */
  adminLog?: { at: string; action: string; actor: string | null; details: Record<string, unknown> }[];
  clientKey: string; clientName: string; managerName: string | null; teamName: string | null;
  pinned: boolean; paymentType: string | null; orders: number; lifetimeRevenue: number;
  firstPaid: string | null; lastPaid: string | null;
  months: { month: string; revenue: number; deals: number }[];
  monthsTotal: number; deals: ClientCardDeal[]; anchorNote: string;
  /** Права на дії керування — рахує СЕРВЕР тими самими гейтами, що й самі роути. */
  canArchive: boolean; canMerge: boolean; canAssign: boolean; mergeScope: "all" | "team";
  /** ⭐ «Вважати постійним попри правило» — право, стан і примітка «чому». */
  canForceRegular: boolean; forcedRegular: boolean; forceNote: string | null;
  /** Клієнт ЗАРАЗ в архіві (з автоповерненням) — тоді дія зворотна. */
  archived: boolean;
  archiveReason: string | null;
  archiveReasons: { key: string; label: string }[];
}
export async function fetchClientCard(clientKey: string): Promise<ClientCard> {
  const { data } = await api.get<ClientCard>("/dashboard/client-card", { params: { clientKey } });
  return data;
}

/** 💬 Останній коментар клієнта — те саме поле `client_comments`, що в картці. */
export interface LastComment { body: string; author: string | null; createdAt: string }
export interface ClientComment { id: number; body: string; createdAt: string; author: string | null }
export async function fetchClientComments(clientKey: string): Promise<ClientComment[]> {
  const { data } = await api.get<ClientComment[]>("/dashboard/client-comments", { params: { clientKey } });
  return data;
}
export async function addClientComment(body: { clientKey: string; body: string }): Promise<ClientComment> {
  const { data } = await api.post("/dashboard/client-comments", body);
  return data;
}

// ── 🗄 АРХІВ КЛІЄНТІВ (хвиля 2) ─────────────────────────────────────────────
export interface ArchiveRow {
  clientKey: string; clientName: string;
  reason: string; reasonLabel: string;
  archivedAt: string; archivedBy: string | null;
  orders: number; lifetimeRevenue: number; lastPaid: string | null;
}
export interface ArchiveResp {
  /** Чий зріз показано: уся компанія чи лише команда тімліда. */
  scope?: "company" | "team";
  reasons: { key: string; label: string }[];
  clients: ArchiveRow[];
}
export const fetchClientArchive = () =>
  api.get<ArchiveResp>("/dashboard/client-archive").then((r) => r.data);
/** `reason` обовʼязковий при архівації; при поверненні передається `restore: true`. */
export const archiveClient = (body: { clientKey: string; reason?: string; restore?: boolean }) =>
  api.post("/dashboard/client-archive", body).then((r) => r.data);

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
  /** Втрачений понад рік — у згорнутий блок «Давно втрачені», не в реєстр архіву. */
  longLapsed: boolean;
  /** ⭐ Включений КВП вручну попри правило + примітка «чому» (у підказці). */
  forcedRegular: boolean; forceNote: string | null;
  /** 💬 Останній коментар — видно прямо в рядку. */
  lastComment: LastComment | null;
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
    longLapsedDays: number; segmentMinPayments: number;
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
/**
 * 🎯 ВІДКІТ АДРЕСУЄТЬСЯ ПАРОЮ, А НЕ ОДНИМ КЛЮЧЕМ (15.09.2026).
 *
 * Доки псевдонім був унікальним безумовно, одного `alias` вистачало: активний
 * рядок для ключа не міг змінити «особу». Відколи розʼєднання звільняє ключ,
 * на нього лягає кілька рядків із різними канонічними — і клік по застарілому
 * рядку журналу відкотив би ЧУЖУ пару, мовчки й з кодом 200. Тому канонічний бік
 * їде з ТОГО САМОГО рядка, з якого взято текст підтвердження.
 */
export async function revokeMerge(alias: string, canonical: string): Promise<{ recomputed: number }> {
  const { data } = await api.post("/dashboard/client-merge/revoke", { alias, canonical });
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
export async function assignClientManager(body: { clientKey: string; managerId: number; reason: string; kind: "fix" | "transfer" }): Promise<{ effectiveFrom: string; kind: "fix" | "transfer"; note: string }> {
  const { data } = await api.post("/dashboard/client-manager", body);
  return data;
}
export interface ManagerHistoryRow {
  fromManager: string | null; toManager: string; effectiveFrom: string;
  reason: string | null; kind?: "fix" | "transfer"; changedBy: string | null; createdAt: string;
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

/**
 * The URL that opens the time tracker already signed in as the current user.
 *
 * Returns exactly one field; the tracker's own body never leaks through. Errors are translated
 * here rather than in the component, because a person reads them and "409" says nothing.
 */
export async function trackerSsoUrl(): Promise<{ url: string }> {
  try {
    const { data } = await api.get<{ url: string }>("/auth/tracker-sso");
    return data;
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: { error?: string } } };
    const status = err.response?.status;
    const code = err.response?.data?.error;

    if (status === 409 && code === "account_disabled") {
      throw new Error("Ваш обліковий запис у трекері часу вимкнено.");
    }
    if (status === 409) {
      throw new Error("У трекері часу для вас ще не створено обліковий запис. Зверніться до Романа.");
    }
    // Токен несе прапорець із моменту входу, тож у того, кому трекер вимкнули СЬОГОДНІ,
    // кнопка ще видима до наступного входу. Сервер відмовляє — хай відмова буде зрозумілою.
    if (status === 403 && code === "tracker_not_enabled") {
      throw new Error("Трекер часу вам не ввімкнено. Зверніться до адміністратора.");
    }
    if (status === 503) {
      throw new Error("Трекер часу ще не підключено до дашборду.");
    }
    if (status === 504) {
      throw new Error("Трекер часу зараз не відповідає. Спробуйте за хвилину.");
    }
    throw new Error("Не вдалося відкрити трекер часу.");
  }
}

/**
 * Carries a machine-readable code alongside the message, because the failure has to travel back
 * to the desktop agent, and a translated sentence is not something to parse on the far side.
 */
export class TrackerAssertionError extends Error {
  // Declared explicitly rather than as a constructor parameter property: this project builds
  // with erasableSyntaxOnly, which rejects the shorthand.
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TrackerAssertionError";
    this.code = code;
  }
}

/**
 * A two-minute assertion the desktop tracker can exchange for its own device token.
 *
 * Carries identity only. The tracker decides what that person may see.
 */
export async function trackerAssertion(): Promise<{ assertion: string }> {
  try {
    const { data } = await api.post<{ assertion: string }>("/auth/tracker-assertion");
    return data;
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 503) {
      throw new TrackerAssertionError("not_configured", "Трекер часу ще не підключено до дашборду.");
    }
    if (status === 401) {
      throw new TrackerAssertionError("unauthenticated", "Сесія в дашборді завершилась. Увійдіть знову.");
    }
    throw new TrackerAssertionError("failed", "Не вдалося підтвердити вхід.");
  }
}

/** 📋 Рядок реєстру закритих задач реактивації. */
export interface ClosedTaskRow {
  taskId: number;
  taskType: string;
  title: string;
  clientKey: string | null;
  clientName: string | null;
  closeReason: string | null;
  /** human · service · none · unknown — див. `core/reactivationClose.ts`. */
  closeClass: "human" | "auto" | "legacy" | "none" | "unknown";
  closeClassLabel: string;
  closedAt: string | null;
  closedBy: string | null;
  assignee: string | null;
  teamName: string | null;
}

export interface ClosedTasksResp {
  scope: "company" | "team";
  total: number;
  /** Три числа окремо: «закрито» ≠ «зроблено людиною». */
  byClass: Partial<Record<ClosedTaskRow["closeClass"], number>>;
  rows: ClosedTaskRow[];
}

export async function fetchReactivationClosed(): Promise<ClosedTasksResp> {
  const { data } = await api.get<ClosedTasksResp>("/dashboard/reactivation-closed");
  return data;
}

/**
 * 🔔 Скільки новин зʼявилось після останнього візиту. `sinceId` — найбільший id, який
 * ЦЕЙ браузер уже бачив (з localStorage): підсвітка стає на пристрій, і спільний логін
 * її не поділяє. Без аргументу сервер падає на стару колонку акаунта (сумісність зі
 * старим бандлом, не для нового). Повертає й `maxId` — «докуди долистати».
 */
export async function fetchNewsUnread(sinceId?: number): Promise<{ unread: number; maxId: number }> {
  const { data } = await api.get<{ unread: number; maxId: number }>(
    "/news/unread", { params: sinceId != null ? { sinceId } : {} });
  return data;
}

/** Відкрив розділ — побачив усе. Повертає `maxId`, який браузер кладе в localStorage. */
export async function markNewsSeen(): Promise<number> {
  const { data } = await api.post<{ ok: true; maxId: number }>("/news/seen");
  return data.maxId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧑‍💼 НАЙМ, прохід 1 (17.09.2026). Типи — дзеркало `backend/src/core/hiring.ts`.
// Доступ вирішує СЕРВЕР (`access` у /meta); фронт лише ховає те, що сервер однаково відмовить.
export type HiringStatus =
  | "new" | "contacted" | "planned" | "done" | "noshow" | "noanswer" | "lead"
  | "candidate" | "training" | "manager" | "refused" | "black";
export type HiringVacancyStatus = "open" | "in_work" | "paused" | "closed" | "cancelled";
export type HiringRefusalSide = "candidate" | "company";
export interface HiringVacancyRef { id: number; title: string; status: HiringVacancyStatus }
export type HiringAccessLevel = "edit" | "lead" | "none";

export interface HiringMeta {
  access: HiringAccessLevel;
  teamId: number | null;
  statuses: { key: HiringStatus; label: string }[];
  transitions: Partial<Record<HiringStatus, HiringStatus[]>>;
  sources: string[];
  positions: string[];
  responsibles: string[];
  teams: { id: number; name: string }[];
  vacancies: HiringVacancyRef[];
  refusalReasons: { id: number; side: HiringRefusalSide; label: string }[];
  vacancyStatuses: { key: HiringVacancyStatus; label: string }[];
  vacancyResults: string[];
}

export interface HiringScheduleRow {
  id: number; candidate_id: number | null; responsible: string | null;
  assigned_on: string; interview_date: string; interview_time: string | null;
  attended: boolean | null; record_url: string | null; comment: string | null;
  full_name: string | null; phone: string | null; telegram: string | null; source: string | null;
  position: string | null; status: HiringStatus | null; team_id: number | null;
  vacancies: HiringVacancyRef[] | null; refusal_reason: string | null;
}

export interface HiringCandidateRow {
  id: number; full_name: string; phone: string | null; telegram: string | null; source: string | null;
  position: string | null; status: HiringStatus; team_id: number | null; team_name: string | null;
  resume_url: string | null; comment: string | null; created_on: string;
  last_interview?: string | null; repeats?: number;
  email: string | null; vacancies: HiringVacancyRef[];
  refusal_side: HiringRefusalSide | null; refusal_reason_id: number | null; refusal_reason: string | null;
  refusal_note: string | null; refused_on: string | null; reserved_on: string | null; reserve_note: string | null;
  files_count: number;
}

export interface HiringVacancyRow {
  id: number; title: string; position: string | null; opened_by: string | null; responsible: string | null;
  need: number; status: HiringVacancyStatus; close_result: string | null; comment: string | null;
  opened_on: string; closed_on: string | null; candidates: number; days_open: number;
  /** 💼 Воронка вакансії (22.09.2026) — `backend/src/core/hiringFunnel.ts` `buildVacancyFunnels`; null — кандидатів немає. */
  funnel: HiringVacancyFunnel | null;
}
export interface HiringVacancyFunnel {
  candidates: number; interviews: number; training: number; managers: number; fresh: number;
  lastAddedDays: number | null; sources: { label: string; n: number }[];
}

export interface HiringFile { id: number; name: string; mime: string; size_bytes: number; created: string; author: string | null }

export interface HiringCard {
  candidate: HiringCandidateRow;
  interviews: { id: number; interview_date: string; interview_time: string | null; responsible: string | null; attended: boolean | null; record_url: string | null; comment: string | null }[];
  events: { id: number; kind: string; from_status: HiringStatus | null; to_status: HiringStatus | null; comment: string | null; at: string; actor: string | null }[];
  lastFrom: HiringStatus | null;
  files: HiringFile[];
  messengers: { telegram: string | null; viber: string | null; whatsapp: string | null };
}

export interface HiringDailyRow {
  day: string; planned: number; booked: number; done: number; noshow: number;
  toLead: number; toCandidate: number; toTraining: number; toManager: number;
  resumes: number; coldSearch: number;
}

/** Текст помилки сервера — щоб людина бачила причину, а не «нічого не сталось». */
export function hiringError(e: unknown): string {
  const d = (e as { response?: { data?: { error?: string } } })?.response?.data;
  return d?.error ?? (e instanceof Error ? e.message : "Не вдалося зберегти");
}

export const fetchHiringMeta = async () => (await api.get<HiringMeta>("/hiring/meta")).data;
export const fetchHiringSchedule = async (from: string, to: string) =>
  (await api.get<{ rows: HiringScheduleRow[] }>("/hiring/schedule", { params: { from, to } })).data.rows;
export const createHiringInterview = async (p: { interviewDate: string; interviewTime?: string; responsible?: string }) =>
  (await api.post<{ id: number }>("/hiring/interviews", p)).data.id;
/** «+ Співбесіда» з наявним (`candidateId`) або новим (`newCandidate`) кандидатом (18.09.2026). */
export interface HiringCreatedInterview { id: number; candidateId: number | null; moved: boolean; repeat: boolean; status: HiringStatus | null }
export const createHiringInterviewFor = async (p: {
  interviewDate: string; interviewTime?: string; responsible?: string; candidateId?: number;
  newCandidate?: { fullName: string; phone: string; vacancyId: number; source?: string; telegram?: string };
}) => (await api.post<HiringCreatedInterview>("/hiring/interviews", p)).data;
export const patchHiringInterview = async (id: number, patch: Record<string, unknown>) =>
  (await api.patch<{ candidateId: number | null; repeat?: { id: number; full_name: string; status: HiringStatus } }>(`/hiring/interviews/${id}`, patch)).data;
export const deleteHiringInterview = async (id: number) => { await api.delete(`/hiring/interviews/${id}`); };
export const restoreHiringInterview = async (id: number) => { await api.post(`/hiring/interviews/${id}/restore`); };

export const fetchHiringCandidates = async (params: {
  q?: string; status?: string; source?: string; position?: string; limit?: number; offset?: number;
  vacancyId?: number | string; reserve?: "yes" | "no" | ""; refusalSide?: string; noVacancy?: "1" | "";
}) =>
  (await api.get<{ total: number; rows: HiringCandidateRow[]; noVacancy: number; inReserve: number }>("/hiring/candidates", { params })).data;
export const createHiringCandidate = async (p: Record<string, unknown>) => (await api.post<{ id: number }>("/hiring/candidates", p)).data.id;
export const fetchHiringCard = async (id: number) => (await api.get<HiringCard>(`/hiring/candidates/${id}`)).data;
export const patchHiringCandidate = async (id: number, patch: Record<string, unknown>) => { await api.patch(`/hiring/candidates/${id}`, patch); };
export const setHiringStatus = async (id: number, p: { to: HiringStatus; comment: string; teamId?: number | null }) => { await api.post(`/hiring/candidates/${id}/status`, p); };
export const addHiringComment = async (id: number, comment: string) => { await api.post(`/hiring/candidates/${id}/comment`, { comment }); };

export const fetchHiringDaily = async (from: string, to: string) =>
  (await api.get<{ rows: HiringDailyRow[]; totals: Omit<HiringDailyRow, "day"> & { attendancePct: number | null } }>("/hiring/daily", { params: { from, to } })).data;
export const saveHiringDaily = async (day: string, p: { resumes?: number; coldSearch?: number }) => { await api.put(`/hiring/daily/${day}`, p); };

// ── Найм, етап 3: офер із шаблону (18.09.2026) ──
export interface OfferTemplate { id: number; title: string; markers: string[]; is_active: boolean; created_at: string; author: string | null; fields: { marker: string; auto: string | null }[] }
export type OfferStateKind = "none" | "pending" | "overdue" | "review" | "signed" | "outdated" | "not_required";
export interface OfferInfo {
  state: { state: OfferStateKind; days?: number | null; docId: number | null; version: number | null; name: string | null; sentAt: string | null };
  form: { template: { id: number; title: string }; fields: { marker: string; auto: string | null; value: string | null }[] } | null;
}
export const fetchOfferTemplates = async () => (await api.get<{ rows: OfferTemplate[] }>("/hiring/offer-templates")).data.rows;
export const uploadOfferTemplate = async (title: string, dataBase64: string) =>
  (await api.post<{ id: number; markers: string[] }>("/hiring/offer-templates", { title, dataBase64 })).data;
export const setOfferTemplateActive = async (id: number, isActive: boolean) => { await api.patch(`/hiring/offer-templates/${id}`, { isActive }); };
export const fetchCandidateOffer = async (id: number, templateId?: number) =>
  (await api.get<OfferInfo>(`/hiring/candidates/${id}/offer`, { params: templateId ? { templateId } : {} })).data;
export const generateCandidateOffer = async (id: number, templateId: number, values: Record<string, string>) =>
  (await api.post<{ docId: number; version: number; name: string }>(`/hiring/candidates/${id}/offer`, { templateId, values })).data;
export const fetchOfferStates = async () => (await api.get<{ states: Record<number, OfferStateKind> }>("/hiring/offers/states")).data.states;

// ── Найм, етап 2: зведення — воронка рекрутингу (18.09.2026) ──
export interface HiringFunnelStage { key: string; label: string; count: number; fromPrev: number | null; fromFirst: number | null; lost: number }
export interface HiringCutRow { key: string; label: string; added: number; interviews: number; candidates: number; managers: number; refused: number }
export interface HiringSummary {
  period: { from: string; to: string }; total: number; funnel: HiringFunnelStage[];
  refusals: { total: number; share: number | null; candidate: number; company: number; unknown: number; candidateShare: number | null; companyShare: number | null; reasons: { side: string; label: string; n: number }[] };
  side: { noshow: number; noanswer: number; reserved: number };
  bySource: HiringCutRow[]; byVacancy: HiringCutRow[];
  vacancies: { open: number; need: number; closed: { month: string; result: string | null; n: number }[] };
  offers: { sent: number; signed: number; pending: number; outdated: number };
  staff: { hired: number; dismissed: number; active: number; dismissReasons: { reason: string; n: number }[]; byPosition: { position: string; n: number }[] };
}
export const fetchHiringSummary = async (p: { from: string; to: string; vacancyId?: string; source?: string }) =>
  (await api.get<HiringSummary>("/hiring/summary", { params: p })).data;

// ── Найм, прохід 1a: вакансії, відмова, резерв, файли-докази ──
export const fetchHiringVacancies = async (scope: "active" | "closed" | "all") =>
  (await api.get<{ rows: HiringVacancyRow[] }>("/hiring/vacancies", { params: { scope } })).data.rows;
export const createHiringVacancy = async (p: Record<string, unknown>) => (await api.post<{ id: number }>("/hiring/vacancies", p)).data.id;
export const patchHiringVacancy = async (id: number, p: Record<string, unknown>) => { await api.patch(`/hiring/vacancies/${id}`, p); };
export const setHiringCandidateVacancies = async (id: number, vacancyIds: number[]) => { await api.put(`/hiring/candidates/${id}/vacancies`, { vacancyIds }); };
export const addHiringRefusalReason = async (p: { side: HiringRefusalSide; label: string }) => (await api.post<{ id: number }>("/hiring/refusal-reasons", p)).data.id;
export const refuseHiringCandidate = async (id: number, p: { reasonId: number | null; note: string; reserve: boolean; blacklist: boolean }) => { await api.post(`/hiring/candidates/${id}/refuse`, p); };
export const setHiringReserve = async (id: number, p: { on: boolean; note?: string }) => { await api.post(`/hiring/candidates/${id}/reserve`, p); };
export async function uploadHiringFile(id: number, file: File): Promise<number> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Не вдалося прочитати файл"));
    r.readAsDataURL(file);
  });
  return (await api.post<{ id: number }>(`/hiring/candidates/${id}/files`, { filename: file.name, dataBase64 })).data.id;
}
export const deleteHiringFile = async (id: number, fileId: number) => { await api.delete(`/hiring/candidates/${id}/files/${fileId}`); };
export const restoreHiringFile = async (id: number, fileId: number) => { await api.post(`/hiring/candidates/${id}/files/${fileId}/restore`); };
/** Файл тягнеться з токеном (звичайне посилання його не несе) і відкривається як blob. */
export async function fetchHiringFileBlobUrl(id: number, fileId: number): Promise<string> {
  const { data } = await api.get<Blob>(`/hiring/candidates/${id}/files/${fileId}`, { responseType: "blob" });
  return URL.createObjectURL(data);
}

// 🎓 КУРСИ НАВЧАННЯ (редактор, 17.09.2026). Дзеркало `routes/training.ts` → GET /training/courses.
export type TrainingAudience = "candidate" | "manager" | "all";
export interface TrainingModule { id: number; name: string; position: number; steps: number; required: number }
export interface TrainingCourse {
  id: number; title: string; description: string | null; audience: TrainingAudience;
  position: number; published: boolean; percent: number; materialCount: number; requiredCount: number;
  modules?: TrainingModule[];
}
export const fetchTrainingCourses = async () =>
  (await api.get<{ courses: TrainingCourse[]; canEdit: boolean; freeModules?: TrainingModule[] }>("/training/courses")).data;
export const createTrainingCourse = async (b: { title: string; description?: string | null; audience: TrainingAudience }) =>
  (await api.post<{ id: number }>("/training/courses", b)).data.id;
export const patchTrainingCourse = async (id: number, patch: { title?: string; description?: string | null; audience?: TrainingAudience; published?: boolean }) => {
  await api.patch(`/training/courses/${id}`, patch);
};

// 🎓 НАЙМ, прохід 2a (17.09.2026): акаунт кандидата, запрошення, доступ, прогрес. Дзеркало `core/hiringTraining.ts`.
export type HiringCloseReason = "no_login" | "expired" | "refused" | "manager";
export type HiringTrainingHealth = "manager" | "closed" | "done" | "no_login" | "stuck" | "ok" | "no_account";
export interface HiringTrainingRow {
  id: number; full_name: string | null; phone: string | null; telegram: string | null; status: HiringStatus;
  team_id: number | null; team_name: string | null; login: string | null;
  account_created_at: string | null; first_login_at: string | null; last_activity_at: string | null;
  access_extended_days: number; access_closed_at: string | null; access_closed_reason: HiringCloseReason | null;
  deadline: string | null; day: number; days: number; health: HiringTrainingHealth;
  done: number; total: number; percent: number; current_step: string | null; open_questions: number;
  invite: { expires_at: string; used_at: string | null; revoked_at: string | null } | null;
  password_issued_at: string | null;
}
export interface HiringTrainingRules { inviteHours: number; noLoginHours: number; trainingDays: number; stuckHours: number }
export interface HiringTrainingDetail {
  row: HiringTrainingRow;
  steps: { id: number; index: number; title: string; kind: string; module: string; required: boolean;
    state: "locked" | "available" | "opened" | "done"; opened_at: string | null; finished_at: string | null }[];
  questions: { id: number; question: string; asked_at: string; answer: string | null; answered_at: string | null;
    material_id: number | null; material_title: string | null; answered_by: string | null }[];
  events: { id: number; kind: string; from_status: HiringStatus | null; to_status: HiringStatus | null; comment: string | null; at: string; actor: string | null }[];
  canDecide: boolean; canRestore: boolean;
}
export const fetchHiringTraining = async () =>
  (await api.get<{ rows: HiringTrainingRow[]; rules: HiringTrainingRules; canDecide: boolean }>("/hiring/training")).data;
export const fetchHiringTrainingDetail = async (id: number) => (await api.get<HiringTrainingDetail>(`/hiring/training/${id}`)).data;
export const createHiringInvite = async (id: number) =>
  (await api.post<{ token: string; expiresAt: string; login: string }>(`/hiring/candidates/${id}/invite`)).data;
/** Логін і пароль кандидата. Пароль приходить ОДИН раз — у базі лише хеш. */
export const issueHiringPassword = async (id: number) =>
  (await api.post<{ login: string; password: string }>(`/hiring/candidates/${id}/password`)).data;
export const extendHiringAccess = async (id: number) => { await api.post(`/hiring/candidates/${id}/access/extend`); };
/** Привʼязати наявний акаунт із роллю «Кандидат» (створений, напр., у «Налаштуваннях») до картки. Лише HR/керівництво. */
export const fetchFreeCandidateAccounts = async () =>
  (await api.get<{ rows: { id: number; email: string; full_name: string | null; is_active: boolean }[] }>("/hiring/candidate-accounts/free")).data.rows;
export const linkCandidateAccount = async (id: number, userId: number) =>
  (await api.post<{ login: string }>(`/hiring/candidates/${id}/account/link`, { userId })).data;
export const restoreHiringAccess = async (id: number) => { await api.post(`/hiring/candidates/${id}/access/restore`); };
export const promoteHiringCandidate = async (id: number, comment: string) => { await api.post(`/hiring/candidates/${id}/promote`, { comment }); };
export const answerHiringQuestion = async (id: number, questionId: number, answer: string) => {
  await api.post(`/hiring/candidates/${id}/questions/${questionId}/answer`, { answer });
};
/** Адреса запрошення будується тут: сервер не знає, з якого домену відкрито дашборд. */
export const inviteUrl = (token: string) => `${window.location.origin}/invite/${token}`;
// Публічні — без токена (людина ще не має пароля).
export const fetchInvite = async (token: string) =>
  (await api.get<{ name: string | null; login: string; expiresAt: string }>(`/auth/invite/${encodeURIComponent(token)}`)).data;
export const acceptInvite = async (token: string, password: string) =>
  (await api.post<{ token: string; login: string }>(`/auth/invite/${encodeURIComponent(token)}`, { password })).data;

// 🎓 ЕКРАН НАВЧАННЯ КАНДИДАТА (найм 2b, 18.09.2026). Дзеркало `routes/training.ts` і `routes/candidateTraining.ts`.
export type TrainingStepState = "locked" | "available" | "opened" | "done";
export interface TrainingCourseDetail {
  course: { id: number; title: string; description: string | null; audience: TrainingAudience; published: boolean };
  percent: number;
  modules: { id: number; name: string; index: number; percent: number;
    materials: { id: number; title: string; kind: TrainingKind; required: boolean; state: TrainingStepState;
      blockedBy: { materialId: number; title: string } | null }[] }[];
}
export interface TrainingMaterialContent {
  id: number; folderId: number | null; title: string; kind: TrainingKind; url: string | null; mime: string | null;
  sizeBytes: string | null; content: string | null; required: boolean; hasFile: boolean;
  status: "opened" | "done" | null; finishedAt: string | null;
}
export type CandidateMe = { candidate: false } | {
  candidate: true; fullName: string | null; teamName: string | null; leadName: string | null;
  day: number; days: number; deadline: string | null; firstLoginAt: string | null;
  closedReason: string | null; done: number; total: number; percent: number;
};
export interface MyTrainingQuestion { id: number; material_id: number | null; question: string; asked_at: string; answer: string | null; answered_at: string | null }
export const fetchTrainingCourse = async (id: number) => (await api.get<TrainingCourseDetail>(`/training/courses/${id}`)).data;
export const fetchTrainingMaterial = async (id: number) => (await api.get<TrainingMaterialContent>(`/training/material/${id}`)).data;
export const openTrainingMaterial = async (id: number) => { await api.post(`/training/progress/${id}/open`); };
export const doneTrainingMaterial = async (id: number) => { await api.post(`/training/progress/${id}/done`); };
export const fetchCandidateMe = async () => (await api.get<CandidateMe>("/training/candidate/me")).data;
export const fetchMyTrainingQuestions = async () => (await api.get<{ rows: MyTrainingQuestion[] }>("/training/questions")).data.rows;
export const askTrainingQuestion = async (question: string, materialId: number | null) =>
  (await api.post<{ id: number }>("/training/questions", { question, materialId })).data.id;
// 🔐 СЕЙФ ДОСТУПІВ (18.09.2026). Значення (пароль, номер картки) приходить ЛИШЕ з reveal.
export interface SecretsStatus { keyConfigured: boolean; botConfigured: boolean; botUsername: string | null; linked: boolean; linkedAt: string | null }
/** `ref` — «12» (акаунт) або «e34» (людина реєстру без акаунта). */
export interface SecretPerson { ref: string; id: number | null; name: string; email: string | null; team_name: string | null; role: string | null; status: "active" | "dismissed"; has_account: boolean; passwords: number; cards: number; updated_at: string | null }
export interface SecretItem {
  id: number; kind: "password" | "card"; service: string; label: string | null; login: string | null; last4: string | null;
  updated_at: string; updated_by: string | null; deleted_at: string | null; versions: number;
}
export interface SecretJournalRow { id: number; at: string; action: string; actor: string | null; service: string | null; reason: string | null }
export interface SecretPersonVault {
  person: { id: number | null; ref: string; name: string; email: string | null; team_name: string | null; role: string | null; hasAccount: boolean };
  items: SecretItem[]; journal: SecretJournalRow[];
}
export const fetchSecretsStatus = async () => (await api.get<SecretsStatus>("/secrets/status")).data;
export const createSecretsLink = async () => (await api.post<{ code: string; expiresInSec: number; botUsername: string | null; url: string | null }>("/secrets/link")).data;
export const unlinkSecretsBot = async () => { await api.post("/secrets/unlink"); };
export const fetchSecretPeople = async () => (await api.get<{ rows: SecretPerson[] }>("/secrets/people")).data.rows;
export const fetchSecretPerson = async (ref: string) => (await api.get<SecretPersonVault>(`/secrets/people/${ref}`)).data;
export const createSecret = async (userId: string, b: { kind: "password" | "card"; service?: string; label?: string; login?: string; value: string }) =>
  (await api.post<{ id: number }>(`/secrets/people/${userId}`, b)).data.id;
export const updateSecret = async (id: number, b: { login?: string; value?: string }) => (await api.patch<{ id: number }>(`/secrets/${id}`, b)).data.id;
export const deleteSecret = async (id: number) => { await api.delete(`/secrets/${id}`); };
export const restoreSecret = async (id: number) => { await api.post(`/secrets/${id}/restore`); };
export const sendSecretCode = async (id: number) => (await api.post<{ expiresInSec: number }>(`/secrets/${id}/code`)).data;
export const revealSecret = async (id: number, code: string, reason: string) =>
  (await api.post<{ value: string; login: string | null; seconds: number }>(`/secrets/${id}/reveal`, { code, reason })).data;


// 🗂 Реєстр співробітників + імпорт «UTS Співробітники УКР» (18.09.2026, задача №3898).
export interface EmployeeRow {
  id: number; ref: string; full_name: string; status: "active" | "finishing" | "dismissed"; position: string | null; team_label: string | null;
  phone: string | null; email: string | null; telegram: string | null; birth_date: string | null; hired_at: string | null;
  dismissed_at: string | null; dismiss_reason: string | null; note: string | null; extra: Record<string, string>;
  user_id: number | null; account_name: string | null; account_active: boolean | null; secrets: number; updated_at: string;
  manager_id: number | null; kommo_name: string | null;
  /** 🚪 Звільнення кнопками: крок і останній робочий день (null — звільнення через реєстр не було). */
  offboarding: "finishing" | "dismissed" | null; last_day: string | null;
  /** 📎 Документи людини (без прибраних) і чи є серед них NDA / офер — за типом документа. */
  docs: number; has_nda: boolean; has_offer: boolean;
}
export interface ImportColumn { index: number; header: string; target: string; secretish: boolean; filled: number }
export interface ImportPreviewRow {
  line: number; name: string; position: string | null; team: string | null; state: "new" | "update" | "duplicate";
  account: string | null; match: string; matchNote: string; secrets: number; secretsLost: number; secretsNoAccount: number; problems: string[];
}
export interface ImportPreview {
  columns: ImportColumn[]; mappingError: string | null; rows: ImportPreviewRow[];
  headerRow: number; headerCandidates: { row: number; fields: string[] }[];
  totals?: { rows: number; new: number; update: number; duplicate: number; withAccount: number; noAccount: number; secrets: number; secretsLost: number; secretsNoAccount: number; problems: number; skipped: number };
}
export interface ImportCounts { rows: number; created: number; updated: number; duplicate: number; linked: number; secretsCreated: number; secretsExisting: number; secretsNoAccount: number; secretsInvalid: number }
// ── Етапи 4–5: плинність, Exit-інтервʼю, привʼязка до Kommo (18.09.2026) ──
export interface ChurnMonthRow { month: string; headcount: number; hired: number; dismissed: number; turnover: number | null; early: number; noHireDate: number }
export interface ChurnReport {
  months: ChurnMonthRow[]; total: { dismissed: number; hired: number; early: number; avgTurnover: number; active: number };
  reasons: { label: string; n: number }[]; positions: { label: string; n: number }[];
}
export const fetchChurn = async (from: string, to: string) => (await api.get<ChurnReport>("/secrets/churn", { params: { from, to } })).data;
export const linkEmployeesKommo = async () => (await api.post<{ linked: number; byId: number; byName: number; ambiguous: number; none: number }>("/secrets/employees/kommo-link")).data;
export interface ExitInterview {
  id: number; employee_id: number | null; full_name: string; interview_date: string; position: string | null; tenure: string | null;
  reason: string | null; reason_detail: string | null; rating: number | null; missing: string | null; recommend: string | null;
  team_lead: string | null; note: string | null; author: string | null;
}
export const fetchExits = async () =>
  (await api.get<{ rows: ExitInterview[]; stats: { total: number; avgRating: number | null; recommendPct: number | null; reasons: { label: string; n: number }[] } }>("/secrets/exit")).data;
export const createExit = async (b: Partial<ExitInterview>) => (await api.post<{ id: number }>("/secrets/exit", b)).data.id;
export const updateExit = async (id: number, b: Partial<ExitInterview>) => { await api.patch(`/secrets/exit/${id}`, b); };
export const deleteExit = async (id: number) => { await api.delete(`/secrets/exit/${id}`); };
export const restoreExit = async (id: number) => { await api.post(`/secrets/exit/${id}/restore`); };
export const fetchEmployees = async () => (await api.get<{ rows: EmployeeRow[]; teams: string[] }>("/secrets/employees")).data;
export type EmployeePatch = Partial<Pick<EmployeeRow, "full_name" | "position" | "team_label" | "phone" | "email" | "telegram" | "birth_date" | "hired_at" | "dismissed_at" | "dismiss_reason" | "note" | "status">>;
export const updateEmployee = async (id: number, b: EmployeePatch) => (await api.patch<{ ok: true; changed: string[] }>(`/secrets/employees/${id}`, b)).data.changed;
// 🚪 Звільнення у два кроки (21.09.2026) — `backend/src/core/offboarding.ts`.
export const startDismissal = async (id: number, lastDay: string, reason: string) =>
  (await api.post<{ status: "finishing"; managers: number }>(`/secrets/employees/${id}/dismiss`, { lastDay, reason })).data;
export const finishDismissal = async (id: number) =>
  (await api.post<{ status: "dismissed"; accountOff: boolean }>(`/secrets/employees/${id}/dismiss/finish`)).data;
export const revertDismissal = async (id: number) =>
  (await api.post<{ status: string }>(`/secrets/employees/${id}/dismiss/revert`)).data;
// 📎 Документи людини (21.09.2026) — `backend/src/core/employeeDocs.ts`.
export const HR_DOC_KINDS = ["Офер", "NDA", "Договір", "Заява", "Наказ", "Інше"] as const;
export interface EmployeeDoc {
  id: number; name: string; category: string | null; description: string | null; section: string; mime: string | null;
  size_bytes: number | null; version: number; created_at: string; archived_at: string | null; deleted_at: string | null; author: string | null; signed: boolean;
}
export const fetchEmployeeDocs = async (id: number) => (await api.get<{ files: EmployeeDoc[] }>(`/secrets/employees/${id}/documents`)).data.files;
export async function uploadEmployeeDoc(id: number, file: File, kind: string): Promise<void> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file);
  });
  await api.post(`/secrets/employees/${id}/documents`, { filename: file.name, mime: file.type || null, kind, dataBase64 });
}
export async function employeeDocBlobUrl(id: number, fileId: number): Promise<string> {
  const { data } = await api.get(`/secrets/employees/${id}/documents/${fileId}`, { responseType: "blob", params: { inline: 1 } });
  return URL.createObjectURL(data as Blob);
}
export const deleteEmployeeDoc = async (id: number, fileId: number) => { await api.delete(`/secrets/employees/${id}/documents/${fileId}`); };
export const restoreEmployeeDoc = async (id: number, fileId: number) => { await api.post(`/secrets/employees/${id}/documents/${fileId}/restore`); };
export const previewEmployeeImport = async (csv: string, mapping?: string[], headerRow?: number) =>
  (await api.post<ImportPreview>("/secrets/import/preview", { csv, mapping, headerRow })).data;
export const commitEmployeeImport = async (csv: string, mapping: string[], sheet: "active" | "dismissed", headerRow: number) =>
  (await api.post<{ ok: true; counts: ImportCounts }>("/secrets/import/commit", { csv, mapping, sheet, headerRow })).data.counts;

// ───────────────────────── 🏆 НОМІНАЦІЇ ТИЖНЯ (21.09.2026) ─────────────────────────
// Дзеркало `backend/src/core/nominationRules.ts` (WeekView) + права глядача з роуту.
export type NominationKey = "maxDeal" | "cars" | "revenue" | "marginPct" | "intl";
export type NominationRanked = { state: "ok"; value: number; winners: number[] } | { state: "empty" };
export interface NominationFinal { status: "confirmed" | "unconfirmed" | "overridden" | "empty"; winners: number[]; value: number | null; reason: string | null; stale: boolean }
export type NominationAction = "confirm" | "override" | "retract";
export interface NominationCell {
  nomination: NominationKey; crm: NominationRanked; final: NominationFinal;
  deal: { id: number; price?: number; cost?: number; url?: string } | null;
  /** Рейтинг команди з CRM; `null` — тиждень зафіксовано до 22.09.2026, рейтинг тоді не зберігався. */
  ranking: { managerId: number; value: number | null }[] | null;
  /** Останнє рішення: хто й коли (лише чернетка). */
  review: { action: NominationAction; by: string | null; at: string } | null;
  canReview: boolean; whyNot: string | null;
}
export interface NominationTeam {
  teamId: number; teamName: string; dept: "rpk" | "rnk"; members: { id: number; name: string }[]; noCostDeals: number; cells: NominationCell[];
  leads: { managerId: number | null; name: string }[];
}
export interface NominationDept { dept: "rpk" | "rnk"; nomination: NominationKey; state: "ok" | "empty"; value: number | null; winners: number[]; teams: number[] }
export interface NominationWeek {
  weekFrom: string; weekTo: string; state: "draft" | "frozen"; frozenAt: string | null; ruleVersion: string; freezeDueAt: string;
  /** Мить фіксації як UTC — для зворотного відліку. */
  freezeInstant: string;
  teams: NominationTeam[]; depts: NominationDept[]; names: Record<string, string>;
  viewer: { role: "admin" | "team_lead"; teamId: number | null; managerId: number | null };
  defs: { key: NominationKey; label: string; hint: string; unit: "uah" | "count" | "pct"; rule: string; notCounted: string }[];
  /** Після «Погодитись з рештою» — які саме номінації погоджено. */
  bulk?: { confirmed: NominationKey[] };
  marginFlagPct: number;
  /** 📷 Фото людей тижня: id менеджера Kommo → фото співробітника (немає в мапі — ініціали). */
  photos: Record<string, PhotoRef>;
}
export const fetchNominationWeek = async (weekFrom?: string) =>
  (await api.get<NominationWeek>("/nominations/week", { params: weekFrom ? { weekFrom } : {} })).data;
export const reviewNomination = async (p: { weekFrom: string; teamId: number; nomination: NominationKey; action: NominationAction; overrideManagerIds?: number[]; overrideValue?: number; reason?: string }) =>
  (await api.post<NominationWeek>("/nominations/review", p)).data;
/** «Погодитись з рештою»: сервер сам бере лише рядки, що чекають і які цей глядач може погодити. */
export const confirmNominationsBulk = async (p: { weekFrom: string; teamId: number; nominations: NominationKey[] }) =>
  (await api.post<NominationWeek>("/nominations/review", { ...p, action: "confirm" })).data;
// 🎞 Ручні слайди презентації тижня (прохід 2) — лише керівництво.
export type ManualSlideKind = "newcomer" | "birthday" | "news" | "contest" | "webinar" | "custom";
export interface SlideTemplateField { key: string; label: string; required: boolean; max: number; multiline?: boolean; placeholder?: string; default?: string; type?: "employee" }
export interface SlideTemplate { key: ManualSlideKind; label: string; fields: SlideTemplateField[] }
export interface ManualSlide { id: number; kind: ManualSlideKind; title: string; person: string | null; fields: Record<string, string>; position: number }
export interface ManualSlidesResp { weekFrom: string; kinds: { key: ManualSlideKind; label: string }[]; templates: SlideTemplate[]; slides: ManualSlide[]; photos: Record<string, PhotoRef> }
export type ManualSlideInput = { weekFrom: string; kind: ManualSlideKind; fields: Record<string, string>; position?: number };
export const fetchManualSlides = async (weekFrom: string) =>
  (await api.get<ManualSlidesResp>("/nominations/manual-slides", { params: { weekFrom } })).data;
export const createManualSlide = async (p: ManualSlideInput) => (await api.post<ManualSlidesResp>("/nominations/manual-slides", p)).data;
export const updateManualSlide = async (id: number, p: ManualSlideInput) => (await api.patch<ManualSlidesResp>(`/nominations/manual-slides/${id}`, p)).data;
export const deleteManualSlide = async (id: number) => (await api.delete<ManualSlidesResp>(`/nominations/manual-slides/${id}`)).data;
export const restoreManualSlide = async (id: number) => (await api.post<ManualSlidesResp>(`/nominations/manual-slides/${id}/restore`)).data;

// 📷 Фото співробітників (22.09.2026) — `routes/people.ts`. Саме фото бачить будь-хто залогінений;
// список і завантаження — право сейфу (керівництво + HR).
export type PhotoRef = { id: number; v: number };
export interface PersonPhoto {
  employeeId: number; name: string; managerId: number | null; status: string; hasPhoto: boolean; hasPrev: boolean; v: number;
  updatedAt: string | null; updatedBy: string | null;
}
export const fetchPeoplePhotos = async () => (await api.get<{ people: PersonPhoto[] }>("/people/photos")).data.people;
export const uploadEmployeePhoto = async (id: number, dataBase64: string) => (await api.post<{ file: string | null; prev: string | null; v: number }>(`/people/photo/${id}`, { dataBase64 })).data;
export const removeEmployeePhoto = async (id: number) => (await api.delete<{ file: string | null; prev: string | null; v: number }>(`/people/photo/${id}`)).data;
export const restoreEmployeePhoto = async (id: number) => (await api.post<{ file: string | null; prev: string | null; v: number }>(`/people/photo/${id}/restore`)).data;
/**
 * Фото як blob-URL (через токен, тож `<img src>` напряму не годиться). Кеш за `id:v`: нова версія
 * фото — новий ключ, стара не показується; помилка з кешу випадає, щоб наступний показ спробував знову.
 */
const photoUrls = new Map<string, Promise<string | null>>();
export function employeePhotoUrl(p: PhotoRef): Promise<string | null> {
  const k = `${p.id}:${p.v}`;
  let u = photoUrls.get(k);
  if (!u) {
    u = api.get(`/people/photo/${p.id}`, { responseType: "blob", params: { v: p.v } })
      .then((r) => URL.createObjectURL(r.data as Blob))
      .catch(() => { photoUrls.delete(k); return null; });
    photoUrls.set(k, u);
  }
  return u;
}
