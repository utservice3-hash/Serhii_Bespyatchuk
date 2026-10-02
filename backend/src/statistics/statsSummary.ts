/**
 * 📊 ПЛИТКИ Й ТАБЛИЦЯ КОМАНД «СТАТИСТИК» (ТЗ 28.09.2026, блоки 1–3; задачі 4603, 4604, 4605, 4367).
 *
 * Одна відповідь на «скільки зараз · добре чи погано (до плану й до минулого) · хто тягне вгору/вниз».
 * Нічого не рахує сам: гроші — ядро (`core/money.ts`), план — ТІ САМІ функції, що на Звіті
 * (`plans.dynamicTarget` для місяця, `plans.effectiveWeekTargets` для тижня), порівняння — чисте
 * (`statsCompare.ts`).
 *
 * 🧭 РІШЕННЯ РОМАНА 02.10.2026 (питання 1–2 плану):
 *  1. План у CRM заведений на ② «отримані кошти» (`payment_amount`), і Звіт із 06.08 рахує план проти ②.
 *     Тому плитка з планом показує ② як головне число, а ① «успішно реалізовано» — підрядком. Інакше
 *     % на Статистиках і на Звіті розійшлись би на тих самих грошах.
 *  2. План тижня — ПРАВИЛО ВЛАСНИКА 06.08 (залишок ÷ робочі дні, морозиться в понеділок, ручна ціль
 *     із задачника перемагає), тобто рівно те число, що на Звіті. Другого «пропорційного» не заводимо.
 *
 * Тиждень статистик — календарний Пн–Нд; тижні плану — блоки Пн–Нд, ОБРІЗАНІ межею місяця. Тиждень
 * через межу місяця = два блоки, план = їх сума; ручна ціль (вона на тиждень, не на блок) — один раз.
 */
import { pool } from "../db/pool.js";
import * as money from "../core/money.js";
import * as plans from "../core/plans.js";
import { fixedWeekBlocks } from "../core/dates.js";
import { weekPlansForMonth } from "../core/weekPlan.js";
import { LIVE_TEAMS } from "./seriesCatalog.js";
import { SALES_TEAM_LEAD } from "./catalog.js";
import { buildLeadMap, resolveLead } from "../jobs/syncRingostatCalls.js";
import { leadgenStats } from "../core/leadgenStats.js";
import * as metrics from "../core/metrics.js";
import { loadKpiTargets } from "../core/kpiTargetsDb.js";
import { leadgenTeamMembers, approvedLeadgenPlans } from "../core/leadgenPlans.js";
import { planForPeriod } from "../core/leadgenPlanRules.js";
import { compareWindows, deltaPct, planPct, rankByPlan, foldWeek, type Gran, type Window, type WeekPlanCell } from "./statsCompare.js";

/** Розформовані команди — історія лишається, у дефолтному вигляді їх немає (рішення Романа 02.10, питання 4). */
export const ARCHIVED_TEAM_IDS = new Set<number>([36283]);

export interface Viewer { allTeams: boolean; teamId: number | null; managerId: number | null }

export interface Tile {
  key: "revenue" | "dispatched" | "calls" | "transfers";
  label: string;
  unit: "₴" | "шт";
  now: number;
  prev: number;
  deltaPct: number | null;
  plan: number | null;
  planPct: number | null;
  /** Підрядок: для грошей — ① «з них успішно». */
  sub: { label: string; value: number } | null;
  /** Чому плану немає — словами, а не порожнечею. */
  planNote: string | null;
  /** Тиждень через межу місяців: план = сума частин (рішення Романа 02.10 — показувати розбивку). */
  planParts?: { from: string; to: string; plan: number; kind: "auto" | "manual" }[];
  formula: string;
}
export interface TeamRow {
  teamId: number; name: string; archived: boolean;
  fact: number; prev: number; deltaPct: number | null; plan: number | null; pct: number | null; rank: number;
}

/**
 * Результативні дзвінки (розмова > 0 с) за відрізок, по командах. За Києвом.
 *
 * 🔴 ПРИВʼЯЗКА — ТА САМА, ЩО В ДЕПСТАТІ (`syncRingostatCalls.buildLeadMap/resolveLead`): ПІБ співробітника
 * Ringostat → тімлід. Перша редакція бралась за `ringostat_calls.manager_id` і давала на 11–13% менше
 * за серію «Дзвінки» на тому самому екрані (заміряно 02.10: тиждень 14.09 — 2 623 проти 2 951, 21.09 —
 * 2 095 проти 2 421). Два числа «дзвінків» на одній сторінці — та поломка, від якої лікує це ТЗ.
 */
export async function callsByTeam(w: Window, teamIds: number[]): Promise<Map<number, number>> {
  const r = await pool.query<{ fio: string | null; n: string }>(
    `SELECT employee_fio AS fio, COUNT(*) AS n FROM ringostat_calls
      WHERE billsec > 0 AND (calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2
      GROUP BY 1`, [w.from, w.to]);
  const leadMap = await buildLeadMap();
  const teamOfLead = new Map<string, number>(Object.entries(SALES_TEAM_LEAD).map(([id, lead]) => [lead, Number(id)]));
  teamOfLead.set("Шевчук Назар", 36283);   // «Самостійні» → Шевчук (R2), як `teamLeadForStats`
  const out = new Map<number, number>();
  for (const row of r.rows) {
    const lead = resolveLead(row.fio ?? "", leadMap);
    const tid = lead ? teamOfLead.get(lead) : undefined;
    if (tid == null || !teamIds.includes(tid)) continue;
    out.set(tid, (out.get(tid) ?? 0) + Number(row.n));
  }
  return out;
}

async function callsOfManager(w: Window, managerId: number): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ringostat_calls rc
      WHERE rc.billsec > 0 AND rc.manager_id = $3
        AND (rc.calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2`, [w.from, w.to, managerId]);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Прорахунки лідгенів — ТІЄЮ САМОЮ функцією, що екран «Лідогенерація» (`leadgenStats`: входи угод у
 * «Кваліфіковано»). Рішення Романа 02.10.2026 (варіант А): доти плитка брала передачі бота
 * (`leadgen_touch`) і показувала 2 за вересень, коли «Лідогенерація» — 27 лише в Сердюка за тиждень.
 */
async function transfers(w: Window): Promise<number> {
  return (await leadgenStats(w.from, w.to)).totals.quotes;
}

/**
 * 🧱 ПЛАН ТИЖНЯ ПО МЕНЕДЖЕРАХ І ЧАСТИНАХ МІСЯЦЯ — ОДНЕ ДЖЕРЕЛО для плитки й лінії на графіку.
 * Те саме правило, що `plans.effectiveWeekTargets` на Звіті: менеджери з місячним планом (`dynamicTarget`),
 * автоматичний план частини тижня — зафіксований знімок (`weekPlansForMonth`), ручна ціль тижня із задачника
 * (`manualWeekTasksOn` — те саме правило, що `manualWeekTargetsOn` Звіту, плюс id задачі) — ПЕРЕМАГАЄ. Частина = блок Пн–Нд, обрізаний межею місяця.
 * 📐 Чому не знімки напряму: заміряно 02.10 — лінія зі знімків давала 802 669 ₴ за 21–27.09 проти 797 148 у плитці
 * (у знімках є люди, яких у плані місяця вже немає). Одна функція на обидва числа — і розбіжності немає за побудовою.
 */
export async function monthWeekPlanCells(monthStart: string): Promise<WeekPlanCell[]> {
  const dyn = await plans.dynamicTarget({ month: monthStart }, "week");
  if (!dyn.length) return [];
  const wp = await weekPlansForMonth({}, monthStart, new Map(dyn.map((d) => [d.managerId, d.monthPlan])), { freeze: false });
  const wpBy = new Map(wp.map((r) => [`${r.managerId}:${r.weekStart}`, r.plan]));
  const out: WeekPlanCell[] = [];
  for (const b of fixedWeekBlocks(monthStart)) {
    const manual = await plans.manualWeekTasksOn(b.from);
    for (const d of dyn) {
      out.push({ managerId: d.managerId, teamId: d.teamId, blockFrom: b.from, blockTo: b.to,
        auto: wpBy.get(`${d.managerId}:${b.from}`) ?? d.weekTarget,
        manual: manual.get(d.managerId)?.target ?? null, manualTaskId: manual.get(d.managerId)?.taskId ?? null });
    }
  }
  return out;
}

/**
 * План ② по менеджерах за повний період: місяць — місячний план; тиждень — `foldWeek` над частинами тижня.
 */
export async function planByManager(gran: Gran, full: Window): Promise<{
  blocks: Window[]; byMgr: Map<number, { teamId: number | null; autoPerBlock: number[]; manual: number }>;
}> {
  if (gran === "month") {
    const byMgr = new Map<number, { teamId: number | null; autoPerBlock: number[]; manual: number }>();
    for (const d of await plans.dynamicTarget({ month: full.from }, "month")) byMgr.set(d.managerId, { teamId: d.teamId, autoPerBlock: [d.monthPlan], manual: 0 });
    return { blocks: [full], byMgr };
  }
  const months = [...new Set([full.from.slice(0, 7), full.to.slice(0, 7)])];
  const cells: WeekPlanCell[] = [];
  const blocks: Window[] = [];
  for (const ym of months) {
    const block = fixedWeekBlocks(`${ym}-01`).find((b) => b.to >= full.from && b.from <= full.to);
    if (!block) continue;
    blocks.push({ from: block.from, to: block.to });
    cells.push(...(await monthWeekPlanCells(`${ym}-01`)).filter((c) => c.blockFrom === block.from));
  }
  return { blocks, byMgr: foldWeek(cells, blocks.map((b) => b.from)) };
}

/** Відправлені авто (за датою завантаження) у скоупі глядача — та сама функція, що факт KPI «Авто» на Звіті. */
async function dispatchedIn(w: Window, viewer: Viewer): Promise<number> {
  const rows = await metrics.dispatchedByManager({ from: w.from, to: w.to,
    ...(viewer.allTeams ? {} : viewer.teamId != null ? { teamId: viewer.teamId } : {}) });
  const own = viewer.allTeams || viewer.teamId != null ? rows : rows.filter((r) => r.managerId === viewer.managerId);
  return own.reduce((a, r) => a + r.deals, 0);
}

/** План KPI «відправлено авто» (`dispatch_count`) за період — ті самі цілі задачника, що на Звіті. */
async function dispatchPlan(full: Window, viewer: Viewer, teamOfMgr: Map<number, number | null>): Promise<number | null> {
  const t = await loadKpiTargets(full.from, full.to);
  let sum = 0, any = false;
  for (const [aid, m] of t) {
    const v = m.dispatch_count; if (v == null) continue;
    const inScope = viewer.allTeams || (viewer.teamId != null ? teamOfMgr.get(aid) === viewer.teamId : aid === viewer.managerId);
    if (!inScope) continue;
    sum += v; any = true;
  }
  return any ? Math.round(sum) : null;
}

/** План прорахунків лідгенів — затверджені плани учасників «Лідогенерації» на період, як на її екрані (`planForPeriod`). */
async function quotesPlan(full: Window): Promise<number | null> {
  const members = await leadgenTeamMembers();
  const approved = await approvedLeadgenPlans(members.map((m) => m.managerId), full.from, full.to);
  let sum = 0, any = false;
  for (const m of members) {
    const v = planForPeriod(approved.get(m.managerId) ?? new Map(), full.from, full.to).quotes;
    if (v == null) continue;
    sum += v; any = true;
  }
  return any ? Math.round(sum) : null;
}

export async function buildSummary(gran: Gran, anchor: string, viewer: Viewer) {
  const win = compareWindows(gran, anchor);
  const liveTeams = viewer.allTeams ? LIVE_TEAMS
    : viewer.teamId != null ? LIVE_TEAMS.filter((t) => t.id === viewer.teamId) : [];
  const teamIds = liveTeams.map((t) => t.id);
  const scope = (w: Window): money.MoneyScope => ({
    from: w.from, to: w.to,
    ...(viewer.allTeams ? {} : viewer.teamId != null ? { teamId: viewer.teamId } : { managerId: viewer.managerId ?? -1 }),
  });

  const [recvNow, recvPrev, succNow, succPrev, recvTeamNow, recvTeamPrev, planMgr, mgrTeams] = await Promise.all([
    money.receivedMoney(scope(win.cur)), money.receivedMoney(scope(win.prev)),
    money.successMoney(scope(win.cur)), money.successMoney(scope(win.prev)),
    teamIds.length ? money.receivedByTeam({ from: win.cur.from, to: win.cur.to }) : Promise.resolve([]),
    teamIds.length ? money.receivedByTeam({ from: win.prev.from, to: win.prev.to }) : Promise.resolve([]),
    planByManager(gran, win.full),
    pool.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers`).then((r) => new Map(r.rows.map((x) => [x.id, x.team_id]))),
  ]);

  // План у скоупі глядача: усі / своя команда / свій — і по частинах тижня (для розбивки на межі місяців).
  const partSums = planMgr.blocks.map(() => 0);
  let manualSum = 0;
  const planTeam = new Map<number, number>();
  for (const [mid, p] of planMgr.byMgr) {
    const total = p.autoPerBlock.reduce((a, v) => a + v, 0) + p.manual;
    if (p.teamId != null) planTeam.set(p.teamId, (planTeam.get(p.teamId) ?? 0) + total);
    if (viewer.allTeams || (viewer.teamId != null && p.teamId === viewer.teamId) || (viewer.teamId == null && mid === viewer.managerId)) {
      p.autoPerBlock.forEach((v, i) => { partSums[i] += v; });
      manualSum += p.manual;
    }
  }
  const planScope = partSums.reduce((a, v) => a + v, 0) + manualSum;
  const plan = planScope > 0 ? Math.round(planScope) : null;
  /* 📅 Розбивка — лише на тижні через межу місяців: автоплан кожної частини + ручні цілі тижня окремо (вони на
     весь тиждень і рахуються раз). Так видно, звідки число й чому Звіт (частина поточного місяця) показує інше. */
  const planParts = gran === "week" && planMgr.blocks.length > 1 && plan != null
    ? [...planMgr.blocks.map((b, i) => ({ from: b.from, to: b.to, plan: Math.round(partSums[i]), kind: "auto" as const })),
       ...(manualSum > 0 ? [{ from: win.full.from, to: win.full.to, plan: Math.round(manualSum), kind: "manual" as const }] : [])]
    : undefined;
  const [dispNow, dispPrev, dispPlan] = await Promise.all([
    dispatchedIn(win.cur, viewer), dispatchedIn(win.prev, viewer), dispatchPlan(win.full, viewer, mgrTeams)]);
  const trPlan = viewer.allTeams ? await quotesPlan(win.full) : null;

  let callsNow: number, callsPrev: number;
  if (viewer.allTeams || viewer.teamId != null) {
    const ids = viewer.allTeams ? LIVE_TEAMS.map((t) => t.id) : [viewer.teamId!];
    const [a, b] = await Promise.all([callsByTeam(win.cur, ids), callsByTeam(win.prev, ids)]);
    callsNow = [...a.values()].reduce((s, v) => s + v, 0);
    callsPrev = [...b.values()].reduce((s, v) => s + v, 0);
  } else {
    [callsNow, callsPrev] = await Promise.all([callsOfManager(win.cur, viewer.managerId ?? -1), callsOfManager(win.prev, viewer.managerId ?? -1)]);
  }
  const [trNow, trPrev] = viewer.allTeams ? await Promise.all([transfers(win.cur), transfers(win.prev)]) : [0, 0];

  const tiles: Tile[] = [
    { key: "revenue", label: "Отримані кошти", unit: "₴", now: Math.round(recvNow.revenue), prev: Math.round(recvPrev.revenue),
      deltaPct: deltaPct(recvNow.revenue, recvPrev.revenue), plan, planPct: planPct(recvNow.revenue, plan),
      sub: { label: "з них успішно реалізовано", value: Math.round(succNow.revenue) },
      planNote: plan == null ? "план на цей період ще не заведено" : null, ...(planParts ? { planParts } : {}),
      formula: "оплата отримана ∪ успішно реалізовано (без подвоєння) — як план і факт на Звіті" },
    /* 🚚 «Відправлені авто» з планом KPI (рішення Романа 02.10): план у задачнику ставиться саме на відправлені
       (`dispatch_count`, за датою завантаження) — тож і факт той самий, що в KPI «Авто» на Звіті. Закриті в
       «Успішно» — підрядком. */
    { key: "dispatched", label: "Відправлені авто", unit: "шт", now: dispNow, prev: dispPrev,
      deltaPct: deltaPct(dispNow, dispPrev), plan: dispPlan, planPct: planPct(dispNow, dispPlan),
      sub: { label: "з них успішно реалізовано (закриті)", value: succNow.deals },
      planNote: dispPlan == null ? "тижневих KPI-цілей на авто за цей період у задачнику немає" : null,
      formula: "авто за датою завантаження; план — KPI-цілі задачника («відправлено авто»), як на Звіті" },
    { key: "calls", label: "Результативні дзвінки", unit: "шт", now: callsNow, prev: callsPrev,
      deltaPct: deltaPct(callsNow, callsPrev), plan: null, planPct: null, sub: null,
      planNote: "плану на розмови немає (денна норма в налаштуваннях рахує розмови разом зі спробами — інше число)", formula: "дзвінки Ringostat із розмовою > 0 с; співробітник → команда за ПІБ, як у депстаті" },
  ];
  if (viewer.allTeams) tiles.push({ key: "transfers", label: "Прорахунки лідгенів", unit: "шт", now: trNow, prev: trPrev,
    deltaPct: deltaPct(trNow, trPrev), plan: trPlan, planPct: planPct(trNow, trPlan), sub: null,
    planNote: trPlan == null ? "затверджених планів лідгенів на цей період немає" : null, formula: "входи угод у «Кваліфіковано» — як на екрані «Лідогенерація»" });

  const rnow = new Map(recvTeamNow.map((t) => [t.teamId, t.revenue]));
  const rprev = new Map(recvTeamPrev.map((t) => [t.teamId, t.revenue]));
  const rowOf = (t: { id: number; name: string }) => {
    const fact = Math.round(rnow.get(t.id) ?? 0), prev = Math.round(rprev.get(t.id) ?? 0);
    const p = planTeam.get(t.id); const pl = p && p > 0 ? Math.round(p) : null;
    return { teamId: t.id, name: t.name, archived: ARCHIVED_TEAM_IDS.has(t.id), fact, prev,
      deltaPct: deltaPct(fact, prev), plan: pl, pct: planPct(fact, pl) };
  };
  // Ранг — лише серед живих команд; архівна не займає місце в рейтингу (rank 0 = «поза рейтингом»).
  const teams: TeamRow[] = [
    ...rankByPlan(liveTeams.filter((t) => !ARCHIVED_TEAM_IDS.has(t.id)).map(rowOf)),
    ...liveTeams.filter((t) => ARCHIVED_TEAM_IDS.has(t.id)).map((t) => ({ ...rowOf(t), rank: 0 })),
  ];

  return { gran, asOf: anchor, complete: win.complete, period: win.full, cur: win.cur, prev: win.prev, tiles, teams };
}

/**
 * 📈 СХОДИНКИ ПЛАНУ НА ГРАФІКУ (ТЗ 28.09, блок 2, п.2) — лише для «Оплата отримана» (②), бо план заведений
 * саме на ці гроші. Місяць — місячний план (`dynamicTarget`, той самий, що на Звіті). Тиждень — ЗАФІКСОВАНІ
 * знімки тижневого плану (`weekly_plan_snapshots`), зведені до понеділка календарного тижня (блок, що
 * починається 1-го числа посеред тижня, додається до свого тижня). Ручні цілі задачника на графіку НЕ
 * враховано — це підписано на екрані; на плитці й у таблиці вони є (там `effectiveWeekTargets`).
 * День — плану немає.
 */
export async function planSeries(g: "day" | "week" | "month", from: string, to: string):
    Promise<{ scopeKey: string; points: { period: string; value: number }[] }[]> {
  if (g === "day") return [];
  const byScope = new Map<string, Map<string, number>>();
  const add = (scope: string, period: string, v: number) => {
    const m = byScope.get(scope) ?? new Map<string, number>(); m.set(period, (m.get(period) ?? 0) + v); byScope.set(scope, m);
  };
  const live = new Set(LIVE_TEAMS.map((t) => t.id));
  if (g === "month") {
    const r = await pool.query<{ m: string }>(
      `SELECT DISTINCT to_char(date_trunc('month', plan_date),'YYYY-MM-DD') AS m FROM plans
        WHERE metric='payment_amount' AND plan_date BETWEEN date_trunc('month',$1::date) AND $2::date ORDER BY 1`, [from, to]);
    for (const { m } of r.rows) {
      for (const d of await plans.dynamicTarget({ month: m }, "month")) {
        if (!d.monthPlan) continue;
        add("company", m, d.monthPlan);
        if (d.teamId != null && live.has(d.teamId)) add(String(d.teamId), m, d.monthPlan);
      }
    }
  } else {
    /* 🔴 ТА САМА ФУНКЦІЯ, ЩО ПЛИТКА (`monthWeekPlanCells` + `foldWeek`) — ручні цілі тімлідів враховано, як на Звіті.
       Перша редакція брала зафіксовані знімки напряму й давала 746 107 / 802 669 ₴ за 21–27.09 проти 797 148 у плитці.
       Лише місяці, на які є місячний план (`plans`): без нього тижневого плану не буває. */
    const ms = await pool.query<{ m: string }>(
      `SELECT DISTINCT to_char(date_trunc('month', plan_date),'YYYY-MM-DD') AS m FROM plans
        WHERE metric='payment_amount' AND plan_date BETWEEN date_trunc('month', $1::date - 6) AND $2::date ORDER BY 1`, [from, to]);
    const cells: WeekPlanCell[] = [];
    for (const { m } of ms.rows) cells.push(...await monthWeekPlanCells(m));
    const mon = (d: string) => { const x = new Date(`${d}T00:00:00Z`); const w = x.getUTCDay(); x.setUTCDate(x.getUTCDate() - ((w + 6) % 7)); return x.toISOString().slice(0, 10); };
    const weeks = [...new Set(cells.map((c) => mon(c.blockFrom)))];
    for (const wk of weeks) {
      const inWeek = cells.filter((c) => mon(c.blockFrom) === wk);
      const starts = [...new Set(inWeek.map((c) => c.blockFrom))].sort();
      for (const p of foldWeek(inWeek, starts).values()) {
        const v = p.autoPerBlock.reduce((a, x) => a + x, 0) + p.manual;
        add("company", wk, v);
        if (p.teamId != null && live.has(p.teamId)) add(String(p.teamId), wk, v);
      }
    }
  }
  return [...byScope].map(([scopeKey, m]) => ({ scopeKey,
    points: [...m].filter(([p]) => p >= from.slice(0, 10) || g === "month").sort(([a], [b]) => a.localeCompare(b))
      .map(([period, value]) => ({ period, value: Math.round(value) })) }));
}
