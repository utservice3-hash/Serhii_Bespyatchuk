/**
 * 💎 LTV КЛІЄНТІВ ЛІДОГЕНЕРАЦІЇ — збирання (джоба `buildLeadgenLtv`) і читання (`/leadgen-ltv`, `/leadgen-ltv-clients`).
 * Правила — `leadgenLtvRules.ts`; тут лише дані. Нічого не рахується з нуля (ТЗ п. 2):
 *  • передачі й угода менеджера — `leadgenHandoffMoney` (ядро «Гроші з переданих лідів»), уся памʼять журналу;
 *  • перший успіх клієнта — `money.clientSuccessHistory` (① без мінусових); LTV — `money.successByClientKey` (①, мінусові
 *    віднімаються); оборот — `money.successIncomeByClientKey` (сума рахунку тих самих угод);
 *  • менеджер клієнта зараз — `clientOwnersFor`; сегмент і стан — `loadClientSegments` (ті самі, що в «Клієнтах»).
 * Закріплення — за тим, хто передав (див. правила); лід за ядром на поточному відповідальному — і це не змінюється.
 */
import { pool } from "../db/pool.js";
import { kyivToday } from "./dates.js";
import { leadgenHandoffMoney } from "./leadgenStats.js";
import { clientSuccessHistory, successByClientKey, successByClientBucket, successIncomeByClientKey } from "./money.js";
import { GENERIC_CLIENT_KEYS, LEADGEN_DASH_TEAM_ID } from "./metrics.js";
import { fetchStatusChangesForLeads } from "../kommo/client.js";
import { clientOwnersFor } from "./clientOwner.js";
import { loadClientSegments, factsFor } from "./clientSegments.js";
import { leadgenTeamMembers } from "./leadgenPlans.js";
import { kommoLeadUrl } from "./kommoLinks.js";
import {
  pickHandoffActor, pickLeadgenClients, firstSuccessOf, unlinkedByMonth, aggLtv, cohortsOf,
  type HandoffForLtv, type LtvRow, type LtvAgg, type Cohort,
} from "./leadgenLtvRules.js";

/* ───────────────────────────── збирання ───────────────────────────── */

export interface LtvBuildReport { handoffs: number; clients: number; actorsFetched: number; actorsUnknown: number; pool: number; turnoverMissing: number }

/** Хто передав — з таблиці, а відсутніх дотягує з журналу Kommo (лише читання, по 10 угод за запит). */
async function actorsFor(picks: readonly { pzId: number; handoffDay: string }[], dry: boolean): Promise<{ map: Map<string, number | null>; fetched: number }> {
  const key = (pz: number, day: string) => `${pz}|${day}`;
  const map = new Map<string, number | null>();
  if (!picks.length) return { map, fetched: 0 };
  const have = dry ? [] : (await pool.query<{ pz_id: string; day: string; actor: string | null }>(
    `SELECT pz_id, to_char(handoff_day, 'YYYY-MM-DD') AS day, actor_kommo_user_id AS actor FROM leadgen_handoff_actors
      WHERE pz_id = ANY($1::bigint[])`, [picks.map((p) => p.pzId)])).rows;
  for (const r of have) map.set(key(Number(r.pz_id), r.day), r.actor == null ? null : Number(r.actor));
  const missing = picks.filter((p) => !map.has(key(p.pzId, p.handoffDay)));
  if (!missing.length) return { map, fetched: 0 };
  const events = await fetchStatusChangesForLeads([...new Set(missing.map((p) => p.pzId))]);
  for (const p of missing) {
    const actor = pickHandoffActor(events, p.pzId, p.handoffDay);
    map.set(key(p.pzId, p.handoffDay), actor);
    if (!dry) await pool.query(`INSERT INTO leadgen_handoff_actors (pz_id, handoff_day, actor_kommo_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [p.pzId, p.handoffDay, actor]);
  }
  return { map, fetched: missing.length };
}

/**
 * Повне перезбирання трьох таблиць однією транзакцією: читач не бачить напівзібраного стану. `dry` — нічого не пише й
 * таблиць не читає (замір проти живої бази ДО викату, у ролі лише читання): повертає звіт і зведення по людях.
 */
export async function buildLeadgenLtv(opts: { dry?: boolean } = {}): Promise<LtvBuildReport & { dryPeople?: { actor: number | null; managerId: number | null; clients: number; ltv: number }[] }> {
  const dry = opts.dry === true;
  const today = kyivToday();
  const money = await leadgenHandoffMoney("2020-01-01", today, { teamId: null, managerId: null });
  const handoffs: HandoffForLtv[] = money.deals.map((d) => ({ pzId: d.pzId, dealId: d.dealId, day: d.day }));
  const dealIds = handoffs.flatMap((h) => (h.dealId == null ? [] : [h.dealId]));
  const keys = [...new Set((await pool.query<{ client_key: string }>(
    `SELECT DISTINCT client_key FROM deals WHERE kommo_id = ANY($1::bigint[]) AND client_key IS NOT NULL AND NOT (client_key = ANY($2::text[]))`,
    [dealIds, GENERIC_CLIENT_KEYS])).rows.map((r) => r.client_key))];
  const first = firstSuccessOf(await clientSuccessHistory(keys));
  const carriers = new Set((await pool.query<{ client_key: string }>(
    `SELECT client_key FROM loyalty_overrides WHERE client_key = ANY($1::text[]) AND archived_at IS NOT NULL AND archive_reason = 'carrier'`,
    [keys])).rows.map((r) => r.client_key));
  // `force_regular` часу постановки не має — береться остання зміна рядка: позначка, зроблена ДО передачі, мусила
  // стояти вже тоді; пізнішу зміну рядка не можна читати як «був постійним» (тоді клієнт лідгена лишається його).
  const forced = new Map((await pool.query<{ client_key: string; day: string }>(
    `SELECT client_key, to_char(updated_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day FROM loyalty_overrides
      WHERE client_key = ANY($1::text[]) AND force_regular`, [keys])).rows.map((r) => [r.client_key, r.day]));
  const picks = pickLeadgenClients(first, handoffs, carriers, forced);
  const pk = picks.map((p) => p.clientKey);

  const { map: actors, fetched } = await actorsFor(picks, dry);
  const mgrByKommo = new Map((await pool.query<{ id: number; kommo_user_id: string }>(
    `SELECT id, kommo_user_id FROM managers WHERE kommo_user_id IS NOT NULL`)).rows.map((r) => [Number(r.kommo_user_id), r.id]));
  const ltv = new Map((await successByClientKey({})).map((r) => [r.key, r]));
  const history = await clientSuccessHistory(pk);
  const income = await successIncomeByClientKey(pk);
  const owners = await clientOwnersFor(pk, today.slice(0, 7));
  const segments = await loadClientSegments();
  const merged = new Set((await pool.query<{ k: string }>(
    `SELECT DISTINCT canonical_key AS k FROM client_key_alias WHERE revoked_at IS NULL AND canonical_key = ANY($1::text[])`, [pk])).rows.map((r) => r.k));

  // 🎯 Повернуті з пулу (п. 3.4): узяв лідген (команда «Лідогенерація»), маржа ① лише ПІСЛЯ дня, коли взяв.
  const taken = (await pool.query<{ client_key: string; lg: number; taken_at: Date; day: string }>(
    `SELECT DISTINCT ON (c.client_key) c.client_key, c.taken_by_manager_id AS lg, c.taken_at,
            to_char(c.taken_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day
       FROM client_react_cycles c JOIN managers m ON m.id = c.taken_by_manager_id
      WHERE c.close_reason = 'taken' AND m.team_id = $1
      ORDER BY c.client_key, c.taken_at DESC`, [LEADGEN_DASH_TEAM_ID])).rows.filter((r) => !pk.includes(r.client_key));
  const after = new Map<string, { ltv: number; deals: number }>();
  if (taken.length) {
    const since = taken.map((t) => t.day).sort()[0];
    const dayOf = new Map(taken.map((t) => [t.client_key, t.day]));
    for (const b of await successByClientBucket({ from: since }, "day")) {
      const d = dayOf.get(b.clientKey);
      if (!d || b.bucket <= d) continue; // лише ПІСЛЯ дня, коли взяли
      const a = after.get(b.clientKey) ?? { ltv: 0, deals: 0 };
      a.ltv += b.revenue; a.deals += b.deals; after.set(b.clientKey, a);
    }
  }

  const months = unlinkedByMonth(handoffs);
  if (dry) {
    const by = new Map<string, { actor: number | null; managerId: number | null; clients: number; ltv: number }>();
    for (const p of picks) {
      const actor = actors.get(`${p.pzId}|${p.handoffDay}`) ?? null;
      const k = String(actor);
      const x = by.get(k) ?? { actor, managerId: actor == null ? null : mgrByKommo.get(actor) ?? null, clients: 0, ltv: 0 };
      x.clients++; x.ltv += ltv.get(p.clientKey)?.revenue ?? 0; by.set(k, x);
    }
    const missing = picks.reduce((a, p) => a + (income.get(p.clientKey)?.missing ?? 0), 0);
    return { handoffs: handoffs.length, clients: picks.length, actorsFetched: fetched, actorsUnknown: [...by.values()].filter((x) => x.actor == null).reduce((a, x) => a + x.clients, 0),
      pool: taken.length, turnoverMissing: missing, dryPeople: [...by.values()].sort((a, b) => b.ltv - a.ltv) };
  }
  const c = await pool.connect();
  let turnoverMissing = 0;
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM leadgen_ltv_clients");
    for (const p of picks) {
      const actor = actors.get(`${p.pzId}|${p.handoffDay}`) ?? null;
      const inc = income.get(p.clientKey);
      turnoverMissing += inc?.missing ?? 0;
      const f = factsFor(segments, p.clientKey);
      const o = owners.get(p.clientKey);
      await c.query(
        `INSERT INTO leadgen_ltv_clients (client_key, lg_manager_id, actor_kommo_user_id, pz_id, handoff_day, first_deal_id, first_day,
           deals, ltv, turnover, turnover_missing, client_name, owner_manager_id, segment, state, merged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [p.clientKey, actor == null ? null : mgrByKommo.get(actor) ?? null, actor, p.pzId, p.handoffDay, p.dealId, p.firstDay,
          history.get(p.clientKey)?.length ?? 0, ltv.get(p.clientKey)?.revenue ?? 0, inc?.income ?? 0, inc?.missing ?? 0,
          o?.clientName ?? null, o?.managerId ?? null, f.segment, f.state, merged.has(p.clientKey)]);
    }
    await c.query("DELETE FROM leadgen_ltv_pool");
    for (const t of taken) {
      const a = after.get(t.client_key) ?? { ltv: 0, deals: 0 };
      await c.query(`INSERT INTO leadgen_ltv_pool (client_key, lg_manager_id, taken_at, ltv_after, deals_after) VALUES ($1,$2,$3,$4,$5)`,
        [t.client_key, t.lg, t.taken_at, a.ltv, a.deals]);
    }
    await c.query("DELETE FROM leadgen_ltv_months");
    for (const [ym, m] of months)
      await c.query(`INSERT INTO leadgen_ltv_months (ym, handoffs, unlinked) VALUES ($1,$2,$3)`, [ym, m.handoffs, m.unlinked]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { c.release(); }
  const actorsUnknown = picks.filter((p) => (actors.get(`${p.pzId}|${p.handoffDay}`) ?? null) == null).length;
  return { handoffs: handoffs.length, clients: picks.length, actorsFetched: fetched, actorsUnknown, pool: taken.length, turnoverMissing };
}

/* ───────────────────────────── читання ───────────────────────────── */

/** Межа: `own` — лише цей лідген; `team` — лише учасники команди «Лідогенерація»; `all` — увесь відділ. */
export type LtvScope = { kind: "all" } | { kind: "own"; managerId: number } | { kind: "team"; teamId: number };

interface StoredRow {
  client_key: string; lg_manager_id: number | null; actor: string | null; pz_id: string; handoff_day: string;
  first_deal_id: string; first_day: string; deals: number; ltv: string; turnover: string; turnover_missing: number;
  client_name: string | null; owner_manager_id: number | null; owner_name: string | null; segment: string | null; state: string | null;
  merged: boolean; lg_name: string | null; lg_active: boolean | null; built_at: Date;
}

async function stored(): Promise<StoredRow[]> {
  return (await pool.query<StoredRow>(
    `SELECT c.client_key, c.lg_manager_id, c.actor_kommo_user_id AS actor, c.pz_id, to_char(c.handoff_day, 'YYYY-MM-DD') AS handoff_day,
            c.first_deal_id, to_char(c.first_day, 'YYYY-MM-DD') AS first_day, c.deals, c.ltv, c.turnover, c.turnover_missing,
            c.client_name, c.owner_manager_id, om.name AS owner_name, c.segment, c.state, c.merged,
            lm.name AS lg_name, lm.is_active AS lg_active, c.built_at
       FROM leadgen_ltv_clients c
       LEFT JOIN managers lm ON lm.id = c.lg_manager_id
       LEFT JOIN managers om ON om.id = c.owner_manager_id`)).rows;
}

/** Людина, за якою закріплено клієнта: менеджер дашборду або, якщо його немає, акаунт Kommo. */
function personOf(r: StoredRow): { key: string; managerId: number | null; name: string; dismissed: boolean } {
  if (r.lg_manager_id != null) return { key: `m:${r.lg_manager_id}`, managerId: r.lg_manager_id, name: r.lg_name ?? `#${r.lg_manager_id}`, dismissed: r.lg_active === false };
  if (r.actor != null) return { key: `u:${r.actor}`, managerId: null, name: `акаунт Kommo ${r.actor}`, dismissed: false };
  return { key: "?", managerId: null, name: "хто передав — невідомо", dismissed: false };
}

function inScope(r: StoredRow, scope: LtvScope, members: ReadonlySet<number>): boolean {
  if (scope.kind === "own") return r.lg_manager_id === scope.managerId;
  if (scope.kind === "team") return scope.teamId === LEADGEN_DASH_TEAM_ID && r.lg_manager_id != null && members.has(r.lg_manager_id);
  return true;
}

export interface LtvClientOut {
  clientKey: string; name: string; firstDay: string; firstDealId: number; firstDealUrl: string; handoffDay: string;
  handedBy: string; deals: number; ltv: number; turnover: number; ownerName: string | null; segment: string | null; state: string | null;
  marks: ("merged" | "pool")[];
}
const clientOut = (r: StoredRow): LtvClientOut => ({
  clientKey: r.client_key, name: r.client_name ?? r.client_key, firstDay: r.first_day, firstDealId: Number(r.first_deal_id),
  firstDealUrl: kommoLeadUrl(Number(r.first_deal_id)), handoffDay: r.handoff_day, handedBy: personOf(r).name, deals: r.deals,
  ltv: Math.round(Number(r.ltv)), turnover: Math.round(Number(r.turnover)), ownerName: r.owner_name, segment: r.segment, state: r.state,
  marks: r.merged ? ["merged"] : [],
});

export interface LtvPersonOut { managerId: number | null; name: string; dismissed: boolean; agg: LtvAgg; pool: { clients: number; ltv: number }; top: LtvClientOut[] }
export interface LtvView {
  builtAt: string | null; from: string; to: string; totals: LtvAgg; pool: { clients: number; ltv: number };
  people: LtvPersonOut[]; others: { agg: LtvAgg; pool: { clients: number; ltv: number }; people: LtvPersonOut[] } | null;
  cohorts: Cohort[]; unknownActors: number; turnoverMissing: number;
}

/** Блок «💎 LTV клієнтів лідогенерації»: «за весь час» — з таблиці, приріст і нові за період — ядром на кожен запит. */
export async function leadgenLtvView(scope: LtvScope, from: string, to: string, pickManagerId: number | null): Promise<LtvView> {
  const [all, members, growth, poolRows, monthRows] = await Promise.all([
    stored(), leadgenTeamMembers(), successByClientKey({ from, to }),
    pool.query<{ client_key: string; lg_manager_id: number | null; ltv_after: string }>(`SELECT client_key, lg_manager_id, ltv_after FROM leadgen_ltv_pool`),
    pool.query<{ ym: string; handoffs: number; unlinked: number }>(`SELECT ym, handoffs, unlinked FROM leadgen_ltv_months`),
  ]);
  const memberIds = new Set(members.map((m) => m.managerId));
  const g = new Map(growth.map((x) => [x.key, x.revenue]));
  const rows = all.filter((r) => inScope(r, scope, memberIds) && (pickManagerId == null || r.lg_manager_id === pickManagerId));
  const toRow = (r: StoredRow): LtvRow => ({ clientKey: r.client_key, ltv: Number(r.ltv), deals: r.deals, turnover: Number(r.turnover), firstDay: r.first_day, growth: g.get(r.client_key) ?? 0, state: r.state });
  const poolIn = poolRows.rows.filter((p) => (scope.kind === "own" ? p.lg_manager_id === scope.managerId
    : scope.kind === "team" ? p.lg_manager_id != null && memberIds.has(p.lg_manager_id) : true)
    && (pickManagerId == null || p.lg_manager_id === pickManagerId));
  const poolOf = (ids: (number | null)[] | null) => {
    const xs = ids == null ? poolIn : poolIn.filter((p) => ids.includes(p.lg_manager_id));
    return { clients: xs.length, ltv: Math.round(xs.reduce((a, p) => a + Number(p.ltv_after), 0)) };
  };
  const top = (rs: StoredRow[]) => [...rs].sort((a, b) => Number(b.ltv) - Number(a.ltv)).slice(0, 10).map(clientOut);

  const groups = new Map<string, { p: ReturnType<typeof personOf>; rs: StoredRow[] }>();
  for (const r of rows) { const p = personOf(r); const gr = groups.get(p.key) ?? { p, rs: [] }; gr.rs.push(r); groups.set(p.key, gr); }
  const personOut = (x: { p: ReturnType<typeof personOf>; rs: StoredRow[] }): LtvPersonOut => ({
    managerId: x.p.managerId, name: x.p.name, dismissed: x.p.dismissed, agg: aggLtv(x.rs.map(toRow), from, to),
    pool: poolOf(x.p.managerId == null ? [] : [x.p.managerId]), top: top(x.rs),
  });
  const people = members.map((m) => personOut(groups.get(`m:${m.managerId}`) ?? { p: { key: `m:${m.managerId}`, managerId: m.managerId, name: m.name, dismissed: false }, rs: [] }))
    .filter((p) => scope.kind !== "own" || p.managerId === scope.managerId)
    .filter((p) => pickManagerId == null || p.managerId === pickManagerId);
  const otherGroups = [...groups.values()].filter((x) => x.p.managerId == null || !memberIds.has(x.p.managerId));
  const otherRows = otherGroups.flatMap((x) => x.rs);
  const others = scope.kind === "all" && otherGroups.length
    ? { agg: aggLtv(otherRows.map(toRow), from, to), pool: poolOf(otherGroups.map((x) => x.p.managerId).filter((id) => id != null && !memberIds.has(id))),
        people: otherGroups.map(personOut).sort((a, b) => b.agg.ltv - a.agg.ltv) }
    : null;
  const months = new Map(monthRows.rows.map((m) => [m.ym, { handoffs: m.handoffs, unlinked: m.unlinked }]));
  return {
    builtAt: all[0]?.built_at ? new Date(all[0].built_at).toISOString() : null, from, to,
    totals: aggLtv(rows.map(toRow), from, to), pool: poolOf(null), people: people.sort((a, b) => b.agg.ltv - a.agg.ltv), others,
    cohorts: cohortsOf(rows.map(toRow), months, from, to),
    unknownActors: rows.filter((r) => r.lg_manager_id == null).length,
    turnoverMissing: rows.reduce((a, r) => a + r.turnover_missing, 0),
  };
}

/** Таб «Клієнти LTV» у «Які угоди рахуємо»: кожен клієнт для звірки з Kommo + повернуті з пулу окремими рядками. */
export async function leadgenLtvClients(scope: LtvScope, pickManagerId: number | null): Promise<{ clients: LtvClientOut[]; pool: { clientKey: string; name: string; takenAt: string; ltv: number; deals: number; handedBy: string }[] }> {
  const [all, members] = await Promise.all([stored(), leadgenTeamMembers()]);
  const memberIds = new Set(members.map((m) => m.managerId));
  const clients = all.filter((r) => inScope(r, scope, memberIds) && (pickManagerId == null || r.lg_manager_id === pickManagerId))
    .sort((a, b) => Number(b.ltv) - Number(a.ltv)).map(clientOut);
  const poolRows = (await pool.query<{ client_key: string; lg_manager_id: number | null; lg_name: string | null; taken_at: string; ltv_after: string; deals_after: number; name: string | null }>(
    `SELECT p.client_key, p.lg_manager_id, m.name AS lg_name, to_char(p.taken_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS taken_at,
            p.ltv_after, p.deals_after,
            (SELECT d.client_name FROM deals d WHERE d.client_key = p.client_key ORDER BY d.kommo_id DESC LIMIT 1) AS name
       FROM leadgen_ltv_pool p LEFT JOIN managers m ON m.id = p.lg_manager_id`)).rows
    .filter((p) => (scope.kind === "own" ? p.lg_manager_id === scope.managerId
      : scope.kind === "team" ? p.lg_manager_id != null && memberIds.has(p.lg_manager_id) : true)
      && (pickManagerId == null || p.lg_manager_id === pickManagerId));
  return {
    clients,
    pool: poolRows.map((p) => ({ clientKey: p.client_key, name: p.name ?? p.client_key, takenAt: p.taken_at, ltv: Math.round(Number(p.ltv_after)), deals: p.deals_after, handedBy: p.lg_name ?? "—" })),
  };
}
