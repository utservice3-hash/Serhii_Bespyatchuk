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
import { LIVE_TEAMS } from "./seriesCatalog.js";
import { SALES_TEAM_LEAD } from "./catalog.js";
import { buildLeadMap, resolveLead } from "../jobs/syncRingostatCalls.js";
import { leadgenStats } from "../core/leadgenStats.js";
import { compareWindows, deltaPct, planPct, rankByPlan, type Gran, type Window } from "./statsCompare.js";

/** Розформовані команди — історія лишається, у дефолтному вигляді їх немає (рішення Романа 02.10, питання 4). */
export const ARCHIVED_TEAM_IDS = new Set<number>([36283]);

export interface Viewer { allTeams: boolean; teamId: number | null; managerId: number | null }

export interface Tile {
  key: "revenue" | "cars" | "calls" | "transfers";
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

/** План ② по менеджерах за повний період: місяць — місячний план, тиждень — сума тижневих цілей Звіту. */
export async function planByManager(gran: Gran, full: Window): Promise<Map<number, { plan: number; teamId: number | null }>> {
  const out = new Map<number, { plan: number; teamId: number | null }>();
  if (gran === "month") {
    for (const d of await plans.dynamicTarget({ month: full.from }, "month")) out.set(d.managerId, { plan: d.monthPlan, teamId: d.teamId });
    return out;
  }
  // Тиждень: блоки Пн–Нд у межах місяця, що перетинаються з календарним тижнем.
  const months = [...new Set([full.from.slice(0, 7), full.to.slice(0, 7)])];
  const manualCounted = new Set<number>();
  for (const ym of months) {
    const block = fixedWeekBlocks(`${ym}-01`).find((b) => b.to >= full.from && b.from <= full.to);
    if (!block) continue;
    const teamOf = new Map((await plans.dynamicTarget({ month: `${ym}-01` }, "week")).map((d) => [d.managerId, d.teamId]));
    const targets = await plans.effectiveWeekTargets({ month: `${ym}-01` }, block.from);
    for (const [mid, t] of targets) {
      if (t.isManual) { if (manualCounted.has(mid)) continue; manualCounted.add(mid); }
      const cur = out.get(mid) ?? { plan: 0, teamId: teamOf.get(mid) ?? null };
      cur.plan += t.target;
      out.set(mid, cur);
    }
  }
  return out;
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

  const [recvNow, recvPrev, succNow, succPrev, recvTeamNow, recvTeamPrev, planMgr] = await Promise.all([
    money.receivedMoney(scope(win.cur)), money.receivedMoney(scope(win.prev)),
    money.successMoney(scope(win.cur)), money.successMoney(scope(win.prev)),
    teamIds.length ? money.receivedByTeam({ from: win.cur.from, to: win.cur.to }) : Promise.resolve([]),
    teamIds.length ? money.receivedByTeam({ from: win.prev.from, to: win.prev.to }) : Promise.resolve([]),
    planByManager(gran, win.full),
  ]);

  // План у скоупі глядача: усі / своя команда / свій.
  let planScope = 0;
  const planTeam = new Map<number, number>();
  for (const [mid, p] of planMgr) {
    if (p.teamId != null) planTeam.set(p.teamId, (planTeam.get(p.teamId) ?? 0) + p.plan);
    if (viewer.allTeams || (viewer.teamId != null && p.teamId === viewer.teamId) || (viewer.teamId == null && mid === viewer.managerId)) planScope += p.plan;
  }
  const plan = planScope > 0 ? Math.round(planScope) : null;

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
      planNote: plan == null ? "плану на цей період у CRM немає" : null,
      formula: "оплата отримана ∪ успішно реалізовано (без подвоєння) — як план і факт на Звіті" },
    { key: "cars", label: "Успішні авто", unit: "шт", now: succNow.deals, prev: succPrev.deals,
      deltaPct: deltaPct(succNow.deals, succPrev.deals), plan: null, planPct: null, sub: null,
      planNote: "плану на авто немає", formula: "угоди в «Успішно реалізовано» (142) за датою закриття" },
    { key: "calls", label: "Результативні дзвінки", unit: "шт", now: callsNow, prev: callsPrev,
      deltaPct: deltaPct(callsNow, callsPrev), plan: null, planPct: null, sub: null,
      planNote: "плану на дзвінки немає", formula: "дзвінки Ringostat із розмовою > 0 с; співробітник → команда за ПІБ, як у депстаті" },
  ];
  if (viewer.allTeams) tiles.push({ key: "transfers", label: "Прорахунки лідгенів", unit: "шт", now: trNow, prev: trPrev,
    deltaPct: deltaPct(trNow, trPrev), plan: null, planPct: null, sub: null,
    planNote: "плану на прорахунки тут немає", formula: "входи угод у «Кваліфіковано» — як на екрані «Лідогенерація»" });

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
    const r = await pool.query<{ wk: string; team_id: number | null; plan: string }>(
      `SELECT to_char(date_trunc('week', s.week_start)::date,'YYYY-MM-DD') AS wk, m.team_id, SUM(s.plan) AS plan
         FROM weekly_plan_snapshots s JOIN managers m ON m.id = s.manager_id
        WHERE s.week_start BETWEEN $1::date - 6 AND $2::date
        GROUP BY 1, 2`, [from, to]);
    for (const x of r.rows) {
      add("company", x.wk, Number(x.plan));
      if (x.team_id != null && live.has(x.team_id)) add(String(x.team_id), x.wk, Number(x.plan));
    }
  }
  return [...byScope].map(([scopeKey, m]) => ({ scopeKey,
    points: [...m].filter(([p]) => p >= from.slice(0, 10) || g === "month").sort(([a], [b]) => a.localeCompare(b))
      .map(([period, value]) => ({ period, value: Math.round(value) })) }));
}
