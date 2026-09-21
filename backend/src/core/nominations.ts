/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ — ДАНІ. Правила — `core/nominationRules.ts` (чисті), тут лише звідки числа.
 *
 * 🔴 ЖОДНОГО SQL ПО УГОДАХ І ГРОШАХ У ЦЬОМУ ФАЙЛІ (#599). Числа — ЛИШЕ з ядра, тими самими
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
import {
  NOMINATIONS, NOMINATION_RULE_VERSION, rankNominees, applyReview, fingerprint, deptWinners, weekOf, isFreezeDue, snapshotRows,
  type NominationKey, type Ranked, type Review, type Final, type NominationCell, type TeamWeek, type DeptWinner, type WeekView,
} from "./nominationRules.js";
export type { NominationCell, TeamWeek, DeptWinner, WeekView } from "./nominationRules.js";

export const INTL_REQUEST_TYPE = "Міжнародні";

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
export interface MgrValues { values: Record<NominationKey, number | null>; noCostDeals: number; maxDealId: number | null; marginDeal: { id: number; price: number; cost: number } | null }
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

/** Останнє рішення по кожній (команда, номінація) тижня. */
async function latestReviews(weekFrom: string): Promise<Map<string, Review>> {
  const rows = (await pool.query<{ team_id: number; nomination: string; action: "confirm" | "override"; crm_fingerprint: string; override_manager_ids: number[] | null; override_value: string | null; reason: string | null }>(
    `SELECT DISTINCT ON (team_id, nomination) team_id, nomination, action, crm_fingerprint, override_manager_ids, override_value, reason
       FROM nomination_reviews WHERE week_from = $1 ORDER BY team_id, nomination, id DESC`, [weekFrom])).rows;
  return new Map(rows.map((r) => [`${r.team_id}:${r.nomination}`, {
    action: r.action, crmFingerprint: r.crm_fingerprint, overrideManagerIds: r.override_manager_ids,
    overrideValue: r.override_value == null ? null : Number(r.override_value), reason: r.reason,
  }]));
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
  const [roster, values, reviews] = await Promise.all([nominationRoster(), nominationValues(from, to), latestReviews(from)]);
  const byTeam = new Map<number, RosterRow[]>();
  for (const r of roster) { const l = byTeam.get(r.teamId) ?? []; l.push(r); byTeam.set(r.teamId, l); }
  const names: Record<number, string> = {};
  for (const r of roster) names[r.id] = r.name;
  const teams: TeamWeek[] = [...byTeam.entries()].map(([tid, members]) => {
    const cells: NominationCell[] = NOMINATIONS.map((n) => {
      const crm = rankNominees(members.map((m) => ({ managerId: m.id, value: values.get(m.id)?.values[n.key] ?? null })));
      const final = applyReview(crm, reviews.get(`${tid}:${n.key}`) ?? null);
      const first = crm.state === "ok" ? values.get(crm.winners[0]) : undefined;
      const deal = n.key === "maxDeal" && first?.maxDealId != null ? { id: first.maxDealId }
        : n.key === "marginPct" && first?.marginDeal ? first.marginDeal : null;
      return { nomination: n.key, crm, final, deal };
    });
    const noCostDeals = members.reduce((a, m) => a + (values.get(m.id)?.noCostDeals ?? 0), 0);
    return { teamId: tid, teamName: members[0].teamName, dept: members[0].dept, members: members.map((m) => ({ id: m.id, name: m.name })), noCostDeals, cells };
  }).sort((a, b) => a.dept.localeCompare(b.dept) || a.teamName.localeCompare(b.teamName, "uk"));
  const fz = weekOf(weekFrom);
  const view: WeekView = {
    weekFrom: from, weekTo: to, state: "draft", frozenAt: null, ruleVersion: NOMINATION_RULE_VERSION,
    freezeDueAt: `${addDaysIso(fz.from, 8)} 08:00`, teams, depts: depts(teams), names,
  };
  return teamId == null ? view : { ...view, teams: view.teams.filter((t) => t.teamId === teamId) };
}
const addDaysIso = (ymd: string, n: number): string => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Зафіксований тиждень — зі знімка; `null`, якщо тиждень ще не фіксувався. */
export async function frozenWeek(weekFrom: string, teamId: number | null = null): Promise<WeekView | null> {
  const w = (await pool.query<{ week_from: string; week_to: string; frozen_at: Date; rule_version: string }>(
    `SELECT to_char(week_from,'YYYY-MM-DD') AS week_from, to_char(week_to,'YYYY-MM-DD') AS week_to, frozen_at, rule_version
       FROM nomination_weeks WHERE week_from = $1`, [weekFrom])).rows[0];
  if (!w) return null;
  const rows = (await pool.query<{ team_id: number; team_name: string; dept: "rpk" | "rnk"; nomination: NominationKey; status: Final["status"]; manager_id: number | null; manager_name: string | null; value: string | null; crm_manager_ids: number[]; crm_value: string | null; reason: string | null; extra: { stale?: boolean; deal?: NominationCell["deal"]; noCostDeals?: number; members?: { id: number; name: string }[] } }>(
    `SELECT team_id, team_name, dept, nomination, status, manager_id, manager_name, value, crm_manager_ids, crm_value, reason, extra
       FROM nomination_snapshot WHERE week_from = $1 ORDER BY id`, [weekFrom])).rows;
  const names: Record<number, string> = {};
  const teams = new Map<number, TeamWeek>();
  for (const r of rows) {
    if (r.manager_id != null && r.manager_name) names[r.manager_id] = r.manager_name;
    for (const m of r.extra.members ?? []) names[m.id] = m.name;
    let t = teams.get(r.team_id);
    if (!t) { t = { teamId: r.team_id, teamName: r.team_name, dept: r.dept, members: r.extra.members ?? [], noCostDeals: r.extra.noCostDeals ?? 0, cells: [] }; teams.set(r.team_id, t); }
    let c = t.cells.find((x) => x.nomination === r.nomination);
    if (!c) {
      const crmValue = r.crm_value == null ? null : Number(r.crm_value);
      const crm: Ranked = crmValue == null || r.crm_manager_ids.length === 0 ? { state: "empty" } : { state: "ok", value: crmValue, winners: r.crm_manager_ids };
      const value = r.value == null ? null : Number(r.value);
      const final: Final = r.status === "empty" ? { status: "empty", winners: [], value: null, reason: null, stale: !!r.extra.stale }
        : r.status === "overridden" ? { status: "overridden", winners: [], value: value ?? 0, reason: r.reason ?? "", stale: !!r.extra.stale }
        : { status: r.status, winners: [], value, reason: null, stale: !!r.extra.stale };
      c = { nomination: r.nomination, crm, final, deal: r.extra.deal ?? null };
      t.cells.push(c);
    }
    if (r.manager_id != null) (c.final.winners as number[]).push(r.manager_id);
  }
  const list = [...teams.values()].sort((a, b) => a.dept.localeCompare(b.dept) || a.teamName.localeCompare(b.teamName, "uk"));
  const view: WeekView = {
    weekFrom: w.week_from, weekTo: w.week_to, state: "frozen", frozenAt: w.frozen_at.toISOString(), ruleVersion: w.rule_version,
    freezeDueAt: `${addDaysIso(w.week_from, 8)} 08:00`, teams: list, depts: depts(list), names,
  };
  return teamId == null ? view : { ...view, teams: view.teams.filter((t) => t.teamId === teamId) };
}

/** Тиждень для екрана: зафіксований — зі знімка, інакше чернетка. */
export async function nominationWeek(weekFrom: string, teamId: number | null = null): Promise<WeekView> {
  return (await frozenWeek(weekFrom, teamId)) ?? draftWeek(weekFrom, teamId);
}

/**
 * Фіксація тижня (#602): ЛИШЕ ДОПИСУВАННЯ. Рядок тижня вставляється `ON CONFLICT DO NOTHING`
 * в одній транзакції зі знімком: хто перший — той і зафіксував, повторний виклик нічого не
 * змінює (а UPDATE/DELETE і так заборонені тригером — #602). До вівторка 08:00 не фіксує.
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
