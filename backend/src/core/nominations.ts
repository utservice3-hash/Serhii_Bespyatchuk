/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ — ДАНІ. Правила — `core/nominationRules.ts` (чисті), тут лише звідки числа.
 *
 * 🔴 ЖОДНОГО SQL ПО УГОДАХ І ГРОШАХ У ЦЬОМУ ФАЙЛІ (#601). Числа — ЛИШЕ з ядра, тими самими
 * функціями, що й Звіт (`/report-plan`), тож слайд і Звіт за той самий тиждень збігаються:
 *   гроші («Факт»), зазор, % маржі → `money.receivedDealStatsByMgr` (множина `receivedByMgr`);
 *   авто                           → `metrics.dispatchedByManager` (колонка «Авто»);
 *   міжнародні                     → `metrics.dispatchedByManager(…, { requestType: "Міжнародні" })`.
 * SQL тут — тільки про людей і про знімок: хто в заліку, як звуться команди, що зафіксовано.
 *
 * Хто в заліку — ТОЙ САМИЙ ростер, що в `/report-plan`: кому ставиться план (`hasPlanSql` поверх
 * `activeManagerSql`) ∩ комерційні команди. Звільнені й «завершує» не змагаються.
 */
import { pool } from "../db/pool.js";
import * as money from "./money.js";
import * as metrics from "./metrics.js";
import { activeManagerSql } from "./activeManager.js";
import * as managerState from "./managerState.js";
import { kommoLeadUrl } from "./kommoLinks.js";
import { leadgenStats } from "./leadgenStats.js";
import {
  NOMINATIONS, NOMINATION_RULE_VERSION, rankNominees, applyReview, fingerprint, deptWinners, weekOf, isFreezeDue, snapshotRows,
  teamRanking, rankingFromExtra, freezeInstant, LEADGEN_NOMINATIONS, buildRnkConv,
  type NominationKey, type Ranked, type Review, type Final, type NominationCell, type TeamWeek, type DeptWinner, type WeekView,
  type RnkConv, type ConvEdit,
} from "./nominationRules.js";
export type { NominationCell, TeamWeek, DeptWinner, WeekView } from "./nominationRules.js";

export const INTL_REQUEST_TYPE = "Міжнародні";
/**
 * Команда лідогенерації (22.09.2026): під цим id живуть рішення по рейтингу лідогенераторів, і її тімлід
 * вносить «свої дані». Та сама команда, що перша в `metrics.NON_COMMERCIAL_TEAM_IDS` (гейт #660).
 */
export const LEADGEN_TEAM_ID = 11;

export interface RosterRow { id: number; name: string; teamId: number; teamName: string; dept: "rpk" | "rnk" }

/** Учасники заліку. Відділ — за `metrics.RNK_TEAM_IDS` (джерело правди, як у звіті КВП), решта комерційних — ВРПК. */
export async function nominationRoster(teamId: number | null = null): Promise<RosterRow[]> {
  const p: unknown[] = [];
  const conds = [managerState.hasPlanSql("m", activeManagerSql("m")), metrics.commercialManagerSql("m")];
  if (teamId != null) { p.push(teamId); conds.push(`m.team_id = $${p.length}`); }
  const rows = (await pool.query<{ id: number; name: string; team_id: number; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id ${managerState.stateJoinSql("m")}
      WHERE ${conds.join(" AND ")} ORDER BY m.name`, p)).rows;
  const rnk = new Set(metrics.RNK_TEAM_IDS);
  return rows.map((r) => ({ id: r.id, name: r.name, teamId: r.team_id, teamName: r.team_name ?? `Команда #${r.team_id}`, dept: rnk.has(r.team_id) ? "rnk" : "rpk" }));
}

/** Значення кожної номінації по менеджеру — лише з ядра. */
type MgrKey = "maxDeal" | "cars" | "revenue" | "marginPct" | "intl";
export interface MgrValues { values: Record<MgrKey, number | null>; noCostDeals: number; maxDealId: number | null; marginDeal: { id: number; price: number; cost: number } | null }
export async function nominationValues(from: string, to: string): Promise<Map<number, MgrValues>> {
  const scope = { from, to };
  const [stats, cars, intl] = await Promise.all([
    money.receivedDealStatsByMgr(scope),
    metrics.dispatchedByManager(scope),
    metrics.dispatchedByManager(scope, { requestType: INTL_REQUEST_TYPE }),
  ]);
  const out = new Map<number, MgrValues>();
  const get = (id: number): MgrValues => {
    let v = out.get(id);
    if (!v) { v = { values: { maxDeal: null, cars: null, revenue: null, marginPct: null, intl: null }, noCostDeals: 0, maxDealId: null, marginDeal: null }; out.set(id, v); }
    return v;
  };
  for (const s of stats) {
    const v = get(s.managerId);
    v.values.revenue = s.revenue; v.values.maxDeal = s.maxDeal; v.values.marginPct = s.maxMarginPct;
    v.noCostDeals = s.noCostDeals; v.maxDealId = s.maxDealId;
    v.marginDeal = s.marginDealId != null && s.marginDealPrice != null && s.marginDealCost != null ? { id: s.marginDealId, price: s.marginDealPrice, cost: s.marginDealCost } : null;
  }
  for (const c of cars) get(c.managerId).values.cars = c.deals;
  for (const c of intl) get(c.managerId).values.intl = c.deals;
  return out;
}

/** Останнє рішення по кожній (команда, номінація) тижня — разом із тим, хто й коли його ухвалив. */
type ReviewRow = Review & { by: string | null; at: string };
async function latestReviews(weekFrom: string): Promise<Map<string, ReviewRow>> {
  const rows = (await pool.query<{ team_id: number; nomination: string; action: Review["action"]; crm_fingerprint: string; override_manager_ids: number[] | null; override_value: string | null; reason: string | null; by_name: string | null; created_at: Date }>(
    `SELECT DISTINCT ON (r.team_id, r.nomination) r.team_id, r.nomination, r.action, r.crm_fingerprint, r.override_manager_ids,
            r.override_value, r.reason, COALESCE(u.full_name, m.name, u.email) AS by_name, r.created_at
       FROM nomination_reviews r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN managers m ON m.id = u.manager_id
      WHERE r.week_from = $1 ORDER BY r.team_id, r.nomination, r.id DESC`, [weekFrom])).rows;
  return new Map(rows.map((r) => [`${r.team_id}:${r.nomination}`, {
    action: r.action, crmFingerprint: r.crm_fingerprint, overrideManagerIds: r.override_manager_ids,
    overrideValue: r.override_value == null ? null : Number(r.override_value), reason: r.reason,
    by: r.by_name, at: r.created_at.toISOString(),
  }]));
}

/**
 * Тімліди кожної команди ЗАРАЗ (активні акаунти з роллю team_lead) — щоб керівництво бачило, які рядки
 * «про тімліда» чекають саме його. Лише про людей: жодних угод і грошей (#601).
 */
async function teamLeads(): Promise<Map<number, { managerId: number | null; name: string }[]>> {
  const rows = (await pool.query<{ team_id: number; manager_id: number | null; name: string }>(
    `SELECT u.team_id, u.manager_id, COALESCE(u.full_name, m.name, u.email) AS name
       FROM users u LEFT JOIN managers m ON m.id = u.manager_id
      WHERE COALESCE(u.role_override, u.role) = 'team_lead' AND u.team_id IS NOT NULL AND u.is_active
      ORDER BY u.team_id, name`)).rows;
  const out = new Map<number, { managerId: number | null; name: string }[]>();
  for (const r of rows) { const l = out.get(r.team_id) ?? []; l.push({ managerId: r.manager_id, name: r.name }); out.set(r.team_id, l); }
  return out;
}

/**
 * Рейтинг лідогенераторів тижня (#660). Хто в заліку — ті самі люди, що у вкладці «Лідогенерація»
 * (ростер за ПОДІЯМИ, лише активні): туди потрапляє й лідген з іншої команди, якщо він робив лідгенівські дії.
 * «Прорахунки» — з CRM; решта номінацій — лише «свої дані» тімліда або керівництва.
 */
async function leadgenWeek(from: string, to: string, reviews: Map<string, ReviewRow>, leads: Map<number, { managerId: number | null; name: string }[]>): Promise<TeamWeek | null> {
  const stats = await leadgenStats(from, to);
  const members = stats.rows.filter((r) => r.isActive).map((r) => ({ id: r.managerId, name: r.name, quotes: r.quotes }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
  const decided = [...reviews.keys()].some((k) => k.startsWith(`${LEADGEN_TEAM_ID}:`));
  if (members.length === 0 && !decided) return null;
  const cells: NominationCell[] = LEADGEN_NOMINATIONS.map((n) => {
    const cands = members.map((m) => ({ managerId: m.id, value: n.key === "lgQuotes" ? m.quotes : null }));
    const crm = n.noCrm ? ({ state: "empty" } as Ranked) : rankNominees(cands);
    const rv = reviews.get(`${LEADGEN_TEAM_ID}:${n.key}`) ?? null;
    return { nomination: n.key, crm, final: applyReview(crm, rv), deal: null, ranking: teamRanking(cands),
      review: rv ? { action: rv.action, by: rv.by, at: rv.at } : null };
  });
  return { teamId: LEADGEN_TEAM_ID, teamName: "Лідогенерація", dept: "lg", members: members.map((m) => ({ id: m.id, name: m.name })),
    noCostDeals: 0, cells, leads: leads.get(LEADGEN_TEAM_ID) ?? [] };
}

/**
 * Статистика відділу РНК · конверсія (#661): «Конв. реклама» Звіту по кожному менеджеру РНК з ростеру
 * тижня + правки Даші й тімлідів (`nomination_conv_edits`, лише дописування). У знімок не йде — живе.
 * Лише про людей і правки: самі числа — з ядра (`metrics.conversionByManager`), свого SQL по угодах немає.
 */
async function rnkConvWeek(from: string, to: string): Promise<RnkConv> {
  const [roster, conv, edits] = await Promise.all([
    nominationRoster(), metrics.conversionByManager({ from, to }, "ad"),
    pool.query<{ manager_id: number | null; action: ConvEdit["action"]; taken: number | null; won: number | null; on_slide: boolean | null; comment: string | null; by_name: string | null; created_at: Date }>(
      `SELECT e.manager_id, e.action, e.taken, e.won, e.on_slide, e.comment, COALESCE(u.full_name, m.name, u.email) AS by_name, e.created_at
         FROM nomination_conv_edits e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN managers m ON m.id = u.manager_id
        WHERE e.week_from = $1 ORDER BY e.id`, [from]),
  ]);
  const byMgr = new Map(conv.map((c) => [c.managerId, c]));
  const system = roster.filter((r) => r.dept === "rnk").map((r) => ({ managerId: r.id, name: r.name, teamId: r.teamId, taken: byMgr.get(r.id)?.taken ?? 0, won: byMgr.get(r.id)?.won ?? 0 }));
  return buildRnkConv(system, edits.rows.map((e) => ({ managerId: e.manager_id, action: e.action, taken: e.taken, won: e.won, onSlide: e.on_slide, comment: e.comment, by: e.by_name, at: e.created_at.toISOString() })));
}

const depts = (teams: TeamWeek[]): DeptWinner[] => {
  const out: DeptWinner[] = [];
  for (const dept of ["rnk", "rpk"] as const) for (const n of NOMINATIONS) {
    const rows = teams.map((t) => { const c = t.cells.find((x) => x.nomination === n.key)!; return { teamId: t.teamId, dept: t.dept, winners: c.final.winners, value: c.final.value }; });
    const r = deptWinners(rows, dept);
    out.push(r.state === "empty"
      ? { dept, nomination: n.key, state: "empty", value: null, winners: [], teams: [] }
      : { dept, nomination: n.key, state: "ok", value: r.value, winners: r.winners, teams: r.teams ?? [] });
  }
  return out;
};

/** Чернетка тижня: CRM зараз + рішення тімлідів. `teamId` звужує ВІДПОВІДЬ (тімлід), а не розрахунок. */
export async function draftWeek(weekFrom: string, teamId: number | null = null): Promise<WeekView> {
  const { from, to } = weekOf(weekFrom);
  // Скоуп звужує відповідь, а не розрахунок (правило 1): переможців відділу рахуємо по ВСІХ командах.
  const [roster, values, reviews, leads] = await Promise.all([nominationRoster(), nominationValues(from, to), latestReviews(from), teamLeads()]);
  const byTeam = new Map<number, RosterRow[]>();
  for (const r of roster) { const l = byTeam.get(r.teamId) ?? []; l.push(r); byTeam.set(r.teamId, l); }
  const names: Record<number, string> = {};
  for (const r of roster) names[r.id] = r.name;
  const teams: TeamWeek[] = [...byTeam.entries()].map(([tid, members]) => {
    const cells: NominationCell[] = NOMINATIONS.map((n) => {
      // Рейтинг — з тієї самої мапи `values`, що й переможець: без другого запиту й другого означення (#652).
      const cands = members.map((m) => ({ managerId: m.id, value: values.get(m.id)?.values[n.key as MgrKey] ?? null }));
      const crm = rankNominees(cands);
      const rv = reviews.get(`${tid}:${n.key}`) ?? null;
      const final = applyReview(crm, rv);
      const first = crm.state === "ok" ? values.get(crm.winners[0]) : undefined;
      const dealRaw = n.key === "maxDeal" && first?.maxDealId != null ? { id: first.maxDealId }
        : n.key === "marginPct" && first?.marginDeal ? first.marginDeal : null;
      const deal = dealRaw ? { ...dealRaw, url: kommoLeadUrl(dealRaw.id) } : null;
      return { nomination: n.key, crm, final, deal, ranking: teamRanking(cands), review: rv ? { action: rv.action, by: rv.by, at: rv.at } : null };
    });
    const noCostDeals = members.reduce((a, m) => a + (values.get(m.id)?.noCostDeals ?? 0), 0);
    return { teamId: tid, teamName: members[0].teamName, dept: members[0].dept, members: members.map((m) => ({ id: m.id, name: m.name })), noCostDeals, cells, leads: leads.get(tid) ?? [] };
  }).sort((a, b) => a.dept.localeCompare(b.dept) || a.teamName.localeCompare(b.teamName, "uk"));
  const fz = weekOf(weekFrom);
  const view: WeekView = {
    weekFrom: from, weekTo: to, state: "draft", frozenAt: null, ruleVersion: NOMINATION_RULE_VERSION,
    freezeDueAt: `${addDaysIso(fz.from, 8)} 08:00`, freezeInstant: freezeInstant(fz.from), teams, depts: depts(teams), names,
    leadgen: await leadgenWeek(from, to, reviews, leads), rnkConv: await rnkConvWeek(from, to),
  };
  if (view.leadgen) for (const m of view.leadgen.members) view.names[m.id] ??= m.name;
  return teamId == null ? view : { ...view, teams: view.teams.filter((t) => t.teamId === teamId) };
}
const addDaysIso = (ymd: string, n: number): string => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Зафіксований тиждень — зі знімка; `null`, якщо тиждень ще не фіксувався. */
export async function frozenWeek(weekFrom: string, teamId: number | null = null): Promise<WeekView | null> {
  const w = (await pool.query<{ week_from: string; week_to: string; frozen_at: Date; rule_version: string }>(
    `SELECT to_char(week_from,'YYYY-MM-DD') AS week_from, to_char(week_to,'YYYY-MM-DD') AS week_to, frozen_at, rule_version
       FROM nomination_weeks WHERE week_from = $1`, [weekFrom])).rows[0];
  if (!w) return null;
  const rows = (await pool.query<{ team_id: number; team_name: string; dept: "rpk" | "rnk" | "lg"; nomination: NominationKey; status: Final["status"]; manager_id: number | null; manager_name: string | null; value: string | null; crm_manager_ids: number[]; crm_value: string | null; reason: string | null; extra: { stale?: boolean; deal?: NominationCell["deal"]; noCostDeals?: number; members?: { id: number; name: string }[]; ranking?: unknown } }>(
    `SELECT team_id, team_name, dept, nomination, status, manager_id, manager_name, value, crm_manager_ids, crm_value, reason, extra
       FROM nomination_snapshot WHERE week_from = $1 ORDER BY id`, [weekFrom])).rows;
  const names: Record<number, string> = {};
  const teams = new Map<number, TeamWeek>();
  let leadgen: TeamWeek | null = null;
  for (const r of rows) {
    if (r.manager_id != null && r.manager_name) names[r.manager_id] = r.manager_name;
    for (const m of r.extra.members ?? []) names[m.id] = m.name;
    let t: TeamWeek | undefined = r.dept === "lg" ? leadgen ?? undefined : teams.get(r.team_id);
    if (!t) {
      t = { teamId: r.team_id, teamName: r.team_name, dept: r.dept, members: r.extra.members ?? [], noCostDeals: r.extra.noCostDeals ?? 0, cells: [], leads: [] };
      if (r.dept === "lg") leadgen = t; else teams.set(r.team_id, t);
    }
    let c = t.cells.find((x) => x.nomination === r.nomination);
    if (!c) {
      const crmValue = r.crm_value == null ? null : Number(r.crm_value);
      const crm: Ranked = crmValue == null || r.crm_manager_ids.length === 0 ? { state: "empty" } : { state: "ok", value: crmValue, winners: r.crm_manager_ids };
      const value = r.value == null ? null : Number(r.value);
      const final: Final = r.status === "empty" ? { status: "empty", winners: [], value: null, reason: null, stale: !!r.extra.stale }
        : r.status === "overridden" ? { status: "overridden", winners: [], value: value ?? 0, reason: r.reason ?? "", stale: !!r.extra.stale }
        : { status: r.status, winners: [], value, reason: null, stale: !!r.extra.stale };
      c = { nomination: r.nomination, crm, final, deal: r.extra.deal ?? null, ranking: rankingFromExtra(r.extra), review: null };
      t.cells.push(c);
    }
    if (r.manager_id != null) (c.final.winners as number[]).push(r.manager_id);
  }
  const list = [...teams.values()].sort((a, b) => a.dept.localeCompare(b.dept) || a.teamName.localeCompare(b.teamName, "uk"));
  const view: WeekView = {
    weekFrom: w.week_from, weekTo: w.week_to, state: "frozen", frozenAt: w.frozen_at.toISOString(), ruleVersion: w.rule_version,
    freezeDueAt: `${addDaysIso(w.week_from, 8)} 08:00`, freezeInstant: freezeInstant(w.week_from), teams: list, depts: depts(list), names,
    leadgen, rnkConv: await rnkConvWeek(w.week_from, w.week_to),
  };
  return teamId == null ? view : { ...view, teams: view.teams.filter((t) => t.teamId === teamId) };
}

/** Тиждень для екрана: зафіксований — зі знімка, інакше чернетка. */
export async function nominationWeek(weekFrom: string, teamId: number | null = null): Promise<WeekView> {
  return (await frozenWeek(weekFrom, teamId)) ?? draftWeek(weekFrom, teamId);
}

/**
 * Фіксація тижня (#604): ЛИШЕ ДОПИСУВАННЯ. Рядок тижня вставляється `ON CONFLICT DO NOTHING`
 * в одній транзакції зі знімком: хто перший — той і зафіксував, повторний виклик нічого не
 * змінює (а UPDATE/DELETE і так заборонені тригером — #604). До вівторка 08:00 не фіксує.
 */
export async function freezeWeek(weekFrom: string, at: Date = new Date()): Promise<"frozen" | "already" | "not-due"> {
  if (!isFreezeDue(weekFrom, at)) return "not-due";
  const view = await draftWeek(weekFrom);
  const rows = snapshotRows(view);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ins = await c.query(
      `INSERT INTO nomination_weeks (week_from, week_to, frozen_by, rule_version) VALUES ($1, $2, 'job', $3)
       ON CONFLICT (week_from) DO NOTHING RETURNING week_from`, [view.weekFrom, view.weekTo, NOMINATION_RULE_VERSION]);
    if (ins.rowCount === 0) { await c.query("ROLLBACK"); return "already"; }
    for (const r of rows) {
      await c.query(
        `INSERT INTO nomination_snapshot (week_from, team_id, team_name, dept, nomination, status, manager_id, manager_name, value, crm_manager_ids, crm_value, reason, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [view.weekFrom, r.teamId, r.teamName, r.dept, r.nomination, r.status, r.managerId, r.managerName, r.value, r.crmManagerIds, r.crmValue, r.reason, JSON.stringify(r.extra)]);
    }
    await c.query("COMMIT");
    return "frozen";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Відбиток CRM для рядка — те, що сервер пише в рішення тімліда (а не те, що прислав фронт). */
export const cellFingerprint = (c: NominationCell): string => fingerprint(c.crm);
