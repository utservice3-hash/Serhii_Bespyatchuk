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
import { compareWindows, rangeWindows, compareLabel, deltaPct, planPct, rankByPlan, foldWeek, weekOf, type Gran, type Window, type WeekPlanCell, type CompareWindows } from "./statsCompare.js";
import { kyivToday, workingDaysBetween } from "../core/dates.js";
import { teamAvgCheckTargets } from "../core/avgCheckTarget.js";
import { callsNormFor } from "../core/callsNormPlan.js";
import { callsByManagerDay } from "../core/reportCuts.js";
import { activeManagerSql } from "../core/activeManager.js";

/** Розформовані команди — історія лишається, у дефолтному вигляді їх немає (рішення Романа 02.10, питання 4). */
export const ARCHIVED_TEAM_IDS = new Set<number>([36283]);

export interface Viewer { allTeams: boolean; teamId: number | null; managerId: number | null }

export interface Tile {
  key: "revenue" | "dispatched" | "calls" | "transfers" | "avgCheck";
  label: string;
  unit: "₴" | "шт";
  now: number;
  prev: number;
  deltaPct: number | null;
  plan: number | null;
  planPct: number | null;
  /** Підрядок: для грошей — ① успішно реалізовано за ті самі дати. НЕ «з них»: ① і ② анкеряться на різні дати
   *  входу в етап, тож ① буває більшим за ② (серпень 2026: 2 550 073 проти 2 543 993). */
  sub: { label: string; value: number } | null;
  /** Чому плану немає — словами, а не порожнечею. */
  planNote: string | null;
  /** Колір за нормою — лише «у нормі / нижче» (Юля 10.10: «зелений — у нормі, червоний — нижче»), без жовтого. */
  binary?: boolean;
  /** 📞 Дзвінки на менеджера за робочий день (розмови + спроби) проти норми з «Планів» (4632). */
  callsNorm?: { perDay: number | null; norm: number | null; managers: number; workDays: number };
  /** Як рахується план цього періоду — словами (4632: тиждень динамічний, узгоджено в задачі 5146). */
  planRule?: string;
  /** Тиждень через межу місяців: план = сума частин (рішення Романа 02.10 — показувати розбивку). */
  planParts?: { from: string; to: string; plan: number; kind: "auto" | "manual" }[];
  formula: string;
}
export interface TeamRow {
  teamId: number; name: string; archived: boolean;
  fact: number; prev: number; deltaPct: number | null; plan: number | null; pct: number | null; rank: number;
  /** 🎯 Сер. чек команди за період і її ціль на місяць (4632). `avgCheckTarget` null — менше 30 угод за базу. */
  avgCheck: number | null; avgCheckTarget: number | null; avgCheckBaseDeals: number;
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
  if (gran === "range") {
    /* «З – по» — місячний план, розкладений по робочих днях: ТОЙ САМИЙ вираз, що Звіт за ті самі дати (4632). */
    const teamOf = new Map((await pool.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers`)).rows.map((x) => [x.id, x.team_id]));
    const byMgr = new Map<number, { teamId: number | null; autoPerBlock: number[]; manual: number }>();
    for (const [mid, v] of await plans.proratedMonthPlanByManager(full.from, full.to, null)) byMgr.set(mid, { teamId: teamOf.get(mid) ?? null, autoPerBlock: [v], manual: 0 });
    return { blocks: [full], byMgr };
  }
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

/** Робочі дні (Пн–Пт) відрізка — тим самим календарем, що план тижня (`workingDaysBetween`). */
export function workdaysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) out.push(d); }
  return out;
}

/**
 * План на день: Σ по днях == план тижня (до копійки до округлення), тож графік «день» і плитка «тиждень» не
 * розходяться. Компанія + живі команди, як інші лінії плану.
 */
async function dayPlanSeries(from: string, to: string): Promise<{ scopeKey: string; points: { period: string; value: number }[] }[]> {
  const ms = await pool.query<{ m: string }>(
    `SELECT DISTINCT to_char(date_trunc('month', plan_date),'YYYY-MM-DD') AS m FROM plans
      WHERE metric='payment_amount' AND plan_date BETWEEN date_trunc('month', $1::date) AND $2::date ORDER BY 1`, [from, to]);
  const live = new Set(LIVE_TEAMS.map((t) => t.id));
  const byScope = new Map<string, Map<string, number>>();
  const add = (scope: string, day: string, v: number) => {
    if (day < from || day > to) return;
    const m = byScope.get(scope) ?? new Map<string, number>(); m.set(day, (m.get(day) ?? 0) + v); byScope.set(scope, m);
  };
  // Ручна ціль — раз на ЗАДАЧУ на весь прохід: тиждень через межу місяців інакше порахував би її двічі (як `foldWeek`).
  const counted = new Set<number>();
  for (const { m } of ms.rows) {
    const cells = await monthWeekPlanCells(m);
    for (const c of cells) {
      const scopes = ["company", ...(c.teamId != null && live.has(c.teamId) ? [String(c.teamId)] : [])];
      if (c.manual != null && c.manualTaskId != null) {
        if (counted.has(c.manualTaskId)) continue;
        counted.add(c.manualTaskId);
        const wk = weekOf(c.blockFrom), days = workdaysOf(wk.from, wk.to);
        for (const d of days) for (const sc of scopes) add(sc, d, c.manual / days.length);
      } else {
        const days = workdaysOf(c.blockFrom, c.blockTo);
        for (const d of days) for (const sc of scopes) add(sc, d, c.auto / days.length);
      }
    }
  }
  return [...byScope].map(([scopeKey, m]) => ({ scopeKey,
    points: [...m].sort(([a], [b]) => a.localeCompare(b)).map(([period, value]) => ({ period, value: Math.round(value) })) }));
}

/** Відправлені авто (за датою завантаження) у скоупі глядача — та сама функція, що факт KPI «Авто» на Звіті. */
async function dispatchedIn(w: Window, viewer: Viewer): Promise<number> {
  const rows = await metrics.dispatchedByManager({ from: w.from, to: w.to,
    ...(viewer.allTeams ? {} : viewer.teamId != null ? { teamId: viewer.teamId } : {}) });
  const own = viewer.allTeams || viewer.teamId != null ? rows : rows.filter((r) => r.managerId === viewer.managerId);
  return own.reduce((a, r) => a + r.deals, 0);
}

/**
 * Цілі KPI «відправлено авто» (`dispatch_count`) по менеджерах за період — ті самі цілі задачника, що на Звіті.
 * ОДНЕ джерело і для плитки «Відправлені авто», і для лінії плану на графіку «Поставлені» (той самий факт).
 */
async function dispatchTargets(w: Window): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const [aid, m] of await loadKpiTargets(w.from, w.to)) if (m.dispatch_count != null) out.set(aid, m.dispatch_count);
  return out;
}

/** План KPI «відправлено авто» за період у скоупі глядача. */
async function dispatchPlan(full: Window, viewer: Viewer, teamOfMgr: Map<number, number | null>): Promise<number | null> {
  let sum = 0, any = false;
  for (const [aid, v] of await dispatchTargets(full)) {
    const inScope = viewer.allTeams || (viewer.teamId != null ? teamOfMgr.get(aid) === viewer.teamId : aid === viewer.managerId);
    if (!inScope) continue;
    sum += v; any = true;
  }
  return any ? Math.round(sum) : null;
}

/**
 * 📈 Лінія плану «відправлено авто» на графіку: по повних тижнях Пн–Нд або місяцях, компанія + живі команди.
 * Та сама `dispatchTargets`, що плитка, тож точка тижня == план плитки за той тиждень (гейт #882b).
 * Будується лише від `seamFrom` (01.07.2026): до шва на графіку історія ручної таблиці, а цілей задачника
 * тоді ще не було (перші — 06.07.2026). Точка без жодної цілі не ставиться — «плану немає» ≠ «план 0».
 */
export async function dispatchPlanSeries(g: "day" | "week" | "month", seamFrom: string, to: string):
    Promise<{ scopeKey: string; points: { period: string; value: number }[] }[]> {
  if (seamFrom > to) return [];
  const windows: Window[] = [];
  if (g === "day") {
    /* 4632 п.2.1: план авто на день — ціль тижня, рівно по робочих днях тижня (ті самі `dispatchTargets`). */
    for (let w = weekOf(seamFrom); w.from <= to; w = weekOf(addDaysIso(w.to, 1))) windows.push(w);
  } else if (g === "week") {
    for (let w = weekOf(seamFrom); w.from <= to; w = weekOf(addDaysIso(w.to, 1))) windows.push(w);
  } else {
    for (let m = `${seamFrom.slice(0, 7)}-01`; m <= to; m = addMonthIso(m)) windows.push({ from: m, to: monthEndIso(m) });
  }
  const live = new Set(LIVE_TEAMS.map((t) => t.id));
  const teamOf = new Map((await pool.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers`)).rows.map((x) => [x.id, x.team_id]));
  const byScope = new Map<string, { period: string; value: number }[]>();
  const push = (k: string, period: string, v: number) => { const a = byScope.get(k) ?? []; a.push({ period, value: Math.round(v) }); byScope.set(k, a); };
  const all = await Promise.all(windows.map((w) => dispatchTargets(w)));
  windows.forEach((w, i) => {
    const t = all[i];
    if (!t.size) return;
    const team = new Map<number, number>();
    let company = 0;
    for (const [aid, v] of t) { company += v; const tid = teamOf.get(aid); if (tid != null && live.has(tid)) team.set(tid, (team.get(tid) ?? 0) + v); }
    if (g === "day") {
      const days = workdaysOf(w.from, w.to).filter((d) => d >= seamFrom && d <= to);
      const all5 = workdaysOf(w.from, w.to).length || 1;
      for (const d of days) { push("company", d, company / all5); for (const [tid, v] of team) push(String(tid), d, v / all5); }
      return;
    }
    push("company", w.from, company);
    for (const [tid, v] of team) push(String(tid), w.from, v);
  });
  return [...byScope].map(([scopeKey, points]) => ({ scopeKey, points }));
}
const addDaysIso = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonthIso = (m: string) => { const x = new Date(`${m}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1, 1); return x.toISOString().slice(0, 10); };
const monthEndIso = (m: string) => { const x = new Date(`${m}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1, 0); return x.toISOString().slice(0, 10); };

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

/**
 * 🏷 ПРАВИЛО ПЛАНУ СЛОВАМИ. Тиждень — динамічний: ТЗ 4632 (28.09) казав «місячний ÷ робочі тижні», але пізніше ТЗ 5146
 * (05.10) Юлі ввів динамічний план тижня, і Роман 10.10.2026 підтвердив його для Статистик — з підписом на екрані.
 */
export const PLAN_RULE: Record<Gran, string> = {
  week: "план тижня динамічний: невиконане переноситься на решту місяця, фіксується в понеділок (узгоджено в задачі 5146)",
  month: "план місяця з «Планів»",
  range: "місячний план, розкладений по робочих днях періоду — як Звіт за ті самі дати",
};

export async function buildSummary(gran: Gran, anchor: string, viewer: Viewer, range?: Window) {
  const win: CompareWindows = gran === "range" && range ? rangeWindows(range.from, range.to, kyivToday())
    : compareWindows(gran === "range" ? "week" : gran, anchor);
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

  // 🎯 Сер. чек (4632): ① за ті самі дати; ціль — команди глядача на місяць кінця відрізка. Компанії ціль не ставиться.
  const targetMonth = `${win.cur.to.slice(0, 7)}-01`;
  const targets = await teamAvgCheckTargets(targetMonth, LIVE_TEAMS.map((t) => t.id));
  const viewerTeam = viewer.allTeams ? null : viewer.teamId ?? (viewer.managerId != null ? mgrTeams.get(viewer.managerId) ?? null : null);
  const tgt = viewerTeam != null ? targets.get(viewerTeam) ?? null : null;
  const avgOf = (a: { revenue: number; deals: number }) => (a.deals > 0 ? Math.round(a.revenue / a.deals) : null);
  const avgNow = avgOf(succNow), avgPrev = avgOf(succPrev);
  // 📞 Норма дзвінків (4632): розмови + спроби на менеджера за робочий день — ТІ САМІ денні комірки, що колонка Звіту
  // «Днів з нормою»; норма — з «Планів». Менеджери — активні в скоупі (у кого нуль дзвінків, теж тягне середнє).
  const normTeams = viewer.allTeams ? LIVE_TEAMS.map((t) => t.id) : viewerTeam != null ? [viewerTeam] : [];
  const mgrIds = viewer.allTeams || viewer.teamId != null
    ? (await pool.query<{ id: number }>(`SELECT m.id FROM managers m WHERE ${activeManagerSql("m")} AND m.team_id = ANY($1::int[])`, [normTeams])).rows.map((x) => x.id)
    : viewer.managerId != null ? [viewer.managerId] : [];
  const mgrSet = new Set(mgrIds);
  const dayRows = mgrIds.length ? await callsByManagerDay(win.cur.from, win.cur.to, {}) : [];
  const callsSum = dayRows.filter((r) => mgrSet.has(r.managerId)).reduce((a, r) => a + r.talks + r.attempts, 0);
  const workDays = workingDaysBetween(win.cur.from, win.cur.to);
  const normNow = await callsNormFor(win.cur.to);
  const callsNorm = { perDay: mgrIds.length && workDays > 0 ? Math.round((callsSum / (mgrIds.length * workDays)) * 10) / 10 : null,
    norm: normNow, managers: mgrIds.length, workDays };

  const tiles: Tile[] = [
    { key: "revenue", label: "Отримані кошти", unit: "₴", now: Math.round(recvNow.revenue), prev: Math.round(recvPrev.revenue),
      deltaPct: deltaPct(recvNow.revenue, recvPrev.revenue), plan, planPct: planPct(recvNow.revenue, plan),
      sub: { label: "успішно реалізовано за ці дати", value: Math.round(succNow.revenue) },
      planNote: plan == null ? "план на цей період ще не заведено" : null, ...(planParts ? { planParts } : {}),
      planRule: PLAN_RULE[gran],
      formula: "оплата отримана ∪ успішно реалізовано (без подвоєння) — як план і факт на Звіті" },
    /* 🚚 «Відправлені авто» з планом KPI (рішення Романа 02.10): план у задачнику ставиться саме на відправлені
       (`dispatch_count`, за датою завантаження) — тож і факт той самий, що в KPI «Авто» на Звіті. Закриті в
       «Успішно» — підрядком. */
    { key: "dispatched", label: "Відправлені авто", unit: "шт", now: dispNow, prev: dispPrev,
      deltaPct: deltaPct(dispNow, dispPrev), plan: dispPlan, planPct: planPct(dispNow, dispPlan),
      sub: { label: "успішно закрито угод за ці дати", value: succNow.deals },
      planNote: dispPlan == null ? "тижневих KPI-цілей на авто за цей період у задачнику немає" : null,
      formula: "авто за датою завантаження; план — KPI-цілі задачника («відправлено авто»), як на Звіті" },
    { key: "calls", label: "Результативні дзвінки", unit: "шт", now: callsNow, prev: callsPrev,
      deltaPct: deltaPct(callsNow, callsPrev), plan: null, planPct: null, sub: null,
      planNote: "плану на розмови немає — норма нижче рахує розмови разом зі спробами (інше число)", formula: "дзвінки Ringostat із розмовою > 0 с; співробітник → команда за ПІБ, як у депстаті",
      callsNorm },
    /* 🎯 Сер. чек (4632, Юля 10.10.2026): ціль — по командах, автоматично; колір лише «у нормі / нижче». */
    { key: "avgCheck", label: "Середній чек", unit: "₴", now: avgNow ?? 0, prev: avgPrev ?? 0,
      deltaPct: avgNow != null && avgPrev != null ? deltaPct(avgNow, avgPrev) : null,
      plan: tgt?.target ?? null, planPct: avgNow != null ? planPct(avgNow, tgt?.target ?? null) : null, binary: true,
      sub: { label: "успішних угод за ці дати", value: succNow.deals },
      planNote: viewer.allTeams ? "ціль ставиться по командах — у таблиці нижче"
        : tgt == null ? "ціль команди не знайдено"
        : tgt.target == null ? `ціль не ставиться: у команди ${tgt.deals} успішних угод за ${tgt.base.from.slice(5, 7)}–${tgt.base.to.slice(5, 7)}.${tgt.base.to.slice(0, 4)} (потрібно від 30)` : null,
      planRule: tgt?.target != null ? `ціль = чек команди за ${tgt.base.from.slice(8, 10)}.${tgt.base.from.slice(5, 7)}–${tgt.base.to.slice(8, 10)}.${tgt.base.to.slice(5, 7)} (${tgt.deals} угод) + 5%, фіксується на місяць${tgt.reconstructed ? " · розраховано заднім числом" : ""}` : undefined,
      formula: "маржа угод «Успішно реалізовано» за ці дати ÷ їх кількість (мінусові віднімаються) — як на Звіті" },
  ];
  if (viewer.allTeams) tiles.push({ key: "transfers", label: "Прорахунки лідгенів", unit: "шт", now: trNow, prev: trPrev,
    deltaPct: deltaPct(trNow, trPrev), plan: trPlan, planPct: planPct(trNow, trPlan), sub: null,
    planNote: trPlan == null ? "затверджених планів лідгенів на цей період немає" : null, formula: "входи угод у «Кваліфіковано» — як на екрані «Лідогенерація»" });

  const avgTeam = new Map((teamIds.length ? await money.avgCheckByTeam("success", { from: win.cur.from, to: win.cur.to }) : [])
    .map((t) => [t.teamId, t.avgCheck]));
  const rnow = new Map(recvTeamNow.map((t) => [t.teamId, t.revenue]));
  const rprev = new Map(recvTeamPrev.map((t) => [t.teamId, t.revenue]));
  const rowOf = (t: { id: number; name: string }) => {
    const fact = Math.round(rnow.get(t.id) ?? 0), prev = Math.round(rprev.get(t.id) ?? 0);
    const p = planTeam.get(t.id); const pl = p && p > 0 ? Math.round(p) : null;
    return { teamId: t.id, name: t.name, archived: ARCHIVED_TEAM_IDS.has(t.id), fact, prev,
      deltaPct: deltaPct(fact, prev), plan: pl, pct: planPct(fact, pl),
      avgCheck: avgTeam.get(t.id) ?? null, avgCheckTarget: targets.get(t.id)?.target ?? null, avgCheckBaseDeals: targets.get(t.id)?.deals ?? 0 };
  };
  // Ранг — лише серед живих команд; архівна не займає місце в рейтингу (rank 0 = «поза рейтингом»).
  const teams: TeamRow[] = [
    ...rankByPlan(liveTeams.filter((t) => !ARCHIVED_TEAM_IDS.has(t.id)).map(rowOf)),
    ...liveTeams.filter((t) => ARCHIVED_TEAM_IDS.has(t.id)).map((t) => ({ ...rowOf(t), rank: 0 })),
  ];

  return { gran, asOf: win.cur.to, complete: win.complete, period: win.full, cur: win.cur, prev: win.prev,
    cmpLabel: compareLabel(win), tiles, teams };
}

/**
 * 📈 СХОДИНКИ ПЛАНУ НА ГРАФІКУ (ТЗ 28.09, блок 2, п.2) — лише для «Оплата отримана» (②), бо план заведений
 * саме на ці гроші. Місяць — місячний план (`dynamicTarget`, той самий, що на Звіті). Тиждень — ЗАФІКСОВАНІ
 * знімки тижневого плану (`weekly_plan_snapshots`), зведені до понеділка календарного тижня (блок, що
 * починається 1-го числа посеред тижня, додається до свого тижня). Ручні цілі задачника на графіку НЕ
 * враховано — це підписано на екрані; на плитці й у таблиці вони є (там `effectiveWeekTargets`).
 * День (4632 п.2.1, «місяць → тиждень → день»): ТОЙ САМИЙ план тижня, рівно розкладений по робочих днях (Пн–Пт)
 * свого блоку; ручна ціль тижня — по робочих днях усього тижня. Вихідні точки не мають (плану на вихідний немає).
 */
export async function planSeries(g: "day" | "week" | "month", from: string, to: string):
    Promise<{ scopeKey: string; points: { period: string; value: number }[] }[]> {
  if (g === "day") return dayPlanSeries(from, to);
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════
   📋 ВКЛАДКА «ПЛАН-ФАКТ» (ТЗ 4632 п.2.2): помісячно / потижнево / «з – по», компанія → команда → менеджер.
   Колонки: план, факт, %, залишок, очікування, треба на день; плюс сер. чек проти цілі команди і дзвінки на день
   проти норми (п.2.5). Нічого не рахує сам: гроші — ядро (`receivedByMgrAtTeam`, ②, як Звіт і плитка), план — той
   самий `planByManager`, що плитка, сер. чек — `avgCheckByManager`, дзвінки — денні комірки Звіту.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface PlanFactLine {
  plan: number | null; fact: number; pct: number | null;
  /** План − факт, не менше нуля; `null` без плану. */
  remaining: number | null;
  /** Очікується за плановою датою оплати від сьогодні до кінця періоду (минулий період — 0). */
  expect: number;
  /** Скільки треба на робочий день до кінця періоду, щоб закрити залишок; минулий період або без плану — `null`. */
  needPerDay: number | null;
  avgCheck: number | null; successDeals: number;
  /** Розмови + спроби на менеджера за робочий день відрізка. */
  callsPerDay: number | null;
}
export interface PlanFactManager extends PlanFactLine { managerId: number; name: string; isActive: boolean }
export interface PlanFactTeam extends PlanFactLine {
  teamId: number | null; name: string; archived: boolean;
  avgCheckTarget: number | null; avgCheckBaseDeals: number;
  managers: PlanFactManager[];
}

/** Рядок із чисел: % і залишок рахуються тут, один раз, для менеджера, команди й компанії однаково. */
export function planFactLine(x: { plan: number | null; fact: number; expect: number; avgRevenue: number; successDeals: number;
  calls: number; managerDays: number; workDaysLeft: number; complete: boolean }): PlanFactLine {
  const plan = x.plan != null && x.plan > 0 ? Math.round(x.plan) : null;
  const remaining = plan != null ? Math.max(0, plan - Math.round(x.fact)) : null;
  return {
    plan, fact: Math.round(x.fact), pct: planPct(x.fact, plan), remaining, expect: Math.round(x.expect),
    needPerDay: !x.complete && remaining != null && x.workDaysLeft > 0 ? Math.round(remaining / x.workDaysLeft) : null,
    avgCheck: x.successDeals > 0 ? Math.round(x.avgRevenue / x.successDeals) : null, successDeals: x.successDeals,
    callsPerDay: x.managerDays > 0 ? Math.round((x.calls / x.managerDays) * 10) / 10 : null,
  };
}

export async function buildPlanFact(gran: Gran, anchor: string, viewer: Viewer, range?: Window) {
  const today = kyivToday();
  const win: CompareWindows = gran === "range" && range ? rangeWindows(range.from, range.to, today)
    : compareWindows(gran === "range" ? "week" : gran, anchor);
  const cur = win.cur;
  const workDaysElapsed = workingDaysBetween(cur.from, cur.to);
  const leftFrom = today > win.full.from ? today : win.full.from;
  const workDaysLeft = win.complete ? 0 : workingDaysBetween(leftFrom, win.full.to);

  const [factRows, planMgr, avgRows, dayRows, expRows, names] = await Promise.all([
    money.receivedByMgrAtTeam({ from: cur.from, to: cur.to }),
    planByManager(gran, win.full),
    money.avgCheckByManager({ from: cur.from, to: cur.to }),
    callsByManagerDay(cur.from, cur.to, {}),
    win.complete ? Promise.resolve([] as Awaited<ReturnType<typeof metrics.expectedByManagerDay>>) : metrics.expectedByManagerDay({}),
    pool.query<{ id: number; name: string; team_id: number | null; active: boolean }>(
      `SELECT m.id, m.name, m.team_id, ${activeManagerSql("m")} AS active FROM managers m`).then((r) => new Map(r.rows.map((x) => [x.id, x]))),
  ]);
  const targets = await teamAvgCheckTargets(`${cur.to.slice(0, 7)}-01`, LIVE_TEAMS.map((t) => t.id));
  const avgBy = new Map(avgRows.map((r) => [r.managerId, r]));
  const callsBy = new Map<number, number>();
  for (const r of dayRows) callsBy.set(r.managerId, (callsBy.get(r.managerId) ?? 0) + r.talks + r.attempts);
  const expBy = new Map<number, number>();
  for (const r of expRows) if (r.day >= leftFrom && r.day <= win.full.to) expBy.set(r.managerId, (expBy.get(r.managerId) ?? 0) + r.sum);

  // Рядки (менеджер × команда): факт — за командою на дату анкера; план — у рядок поточної команди людини.
  type Raw = { managerId: number; teamId: number | null; plan: number | null; fact: number };
  const raw = new Map<string, Raw>();
  const key = (m: number, t: number | null) => `${m}:${t ?? "-"}`;
  for (const f of factRows) raw.set(key(f.managerId, f.teamId), { managerId: f.managerId, teamId: f.teamId, plan: null, fact: f.revenue });
  for (const [mid, p] of planMgr.byMgr) {
    const total = p.autoPerBlock.reduce((a, v) => a + v, 0) + p.manual;
    if (total <= 0) continue;
    const k = key(mid, p.teamId);
    const r = raw.get(k) ?? { managerId: mid, teamId: p.teamId, plan: null, fact: 0 };
    r.plan = total; raw.set(k, r);
  }
  // Активний менеджер без плану й без грошей теж лишається — його дзвінки й нуль видно, а не зникають.
  for (const [mid, n] of names) {
    if (!n.active || n.team_id == null || [...raw.values()].some((r) => r.managerId === mid)) continue;
    if ((callsBy.get(mid) ?? 0) > 0) raw.set(key(mid, n.team_id), { managerId: mid, teamId: n.team_id, plan: null, fact: 0 });
  }

  const visibleTeam = (t: number | null) => viewer.allTeams || (viewer.teamId != null && t === viewer.teamId);
  const ownRow = (r: Raw) => viewer.allTeams || viewer.teamId != null ? visibleTeam(r.teamId) : r.managerId === viewer.managerId;
  const rows = [...raw.values()].filter(ownRow);
  // Сер. чек і дзвінки — властивість людини за відрізок, а не рядка-команди: у того, хто перейшов, вони йдуть у рядок
  // ПОТОЧНОЇ команди, щоб не подвоювались.
  const lineOf = (rs: Raw[]) => {
    let plan: number | null = null, fact = 0, expect = 0, avgRevenue = 0, successDeals = 0, calls = 0, managerDays = 0;
    for (const r of rs) {
      if (r.plan != null) plan = (plan ?? 0) + r.plan;
      fact += r.fact;
      const home = (names.get(r.managerId)?.team_id ?? null) === r.teamId;
      if (home) {
        expect += expBy.get(r.managerId) ?? 0;
        const a = avgBy.get(r.managerId); if (a) { avgRevenue += a.revenue; successDeals += a.successDeals; }
        if (names.get(r.managerId)?.active) { calls += callsBy.get(r.managerId) ?? 0; managerDays += workDaysElapsed; }
      }
    }
    return planFactLine({ plan, fact, expect, avgRevenue, successDeals, calls, managerDays, workDaysLeft, complete: win.complete });
  };
  const teamName = new Map<number, string>([
    ...(await pool.query<{ id: number; name: string }>(`SELECT id, name FROM teams`)).rows.map((t) => [t.id, t.name] as [number, string]),
    ...LIVE_TEAMS.map((t) => [t.id, t.name] as [number, string]),
  ]);
  const teamIds = [...new Set(rows.map((r) => r.teamId))];
  const teams: PlanFactTeam[] = teamIds.map((tid) => {
    const rs = rows.filter((r) => r.teamId === tid);
    const tg = tid != null ? targets.get(tid) : undefined;
    return {
      teamId: tid, name: tid == null ? "Поза командами" : teamName.get(tid) ?? `Команда #${tid}`,
      archived: tid != null && ARCHIVED_TEAM_IDS.has(tid),
      avgCheckTarget: tg?.target ?? null, avgCheckBaseDeals: tg?.deals ?? 0,
      ...lineOf(rs),
      managers: rs.map((r) => ({ managerId: r.managerId, name: names.get(r.managerId)?.name ?? `#${r.managerId}`,
        isActive: names.get(r.managerId)?.active ?? false, ...lineOf([r]) }))
        .sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1) || b.fact - a.fact),
    };
  }).sort((a, b) => (a.teamId == null ? 1 : 0) - (b.teamId == null ? 1 : 0) || (a.pct ?? -1) - (b.pct ?? -1));
  const company = viewer.allTeams ? lineOf(rows) : null;
  return {
    gran, period: win.full, cur, complete: win.complete, today, workDaysLeft, planRule: PLAN_RULE[gran],
    callsNorm: await callsNormFor(cur.to), avgCheckRule: "ціль сер. чека = чек команди за 3 повні місяці + 5%, фіксується на місяць; менше 30 угод — без цілі",
    company, teams,
  };
}
