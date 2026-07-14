import { pool } from "../db/pool.js";
import { kommoGet } from "../kommo/client.js";
import * as money from "./money.js";

/**
 * КРОК 4 (Звірка): регресійна звірка НАШЕ (`core/money.ts`) ↔ Kommo API НАПРЯМУ,
 * 12 міс × команди × менеджери, + інваріант цілісності `deal_stage_events`↔`deals`.
 *
 * Метрика звірки — «Успішно реалізовано» (статус `142`), APPLES-TO-APPLES:
 *   НАШЕ  = наша `deals` у статусі 142, closed_at у місяці (перевіряє, що синк
 *           deals↔Kommo вірний: ті самі угоди, ті самі ціни, той самий менеджер —
 *           САМЕ це зловило б дірку на 35 561 угоду).
 *   KOMMO = ліди в статусі 142 (повний цикл), закриті в тому ж місяці, НАПРЯМУ з API.
 * Обидві сторони — ОДНА дефініція (статус 142 + closed_at). Мінуси нетяться з обох
 * (наше — `deals.price` уже мінусом; Kommo — `signedPrice`). Логіку `core/money.ts`
 * (анкер по входу) окремо перевіряють юніт-тести + еталон Яцика.
 * ⚠️ Поточний (неповний) місяць виключено з pass/fail — синк лагає, це не дрейф.
 */
export const RECONCILE_THRESHOLD = 0.005; // 0.5%

interface KommoWonLead {
  id: number;
  name: string;
  price: number;
  responsible_user_id: number;
}

const signedPrice = (name: string, price: number) =>
  /мінус/i.test(name || "") ? -Math.abs(price) : price;

/** Останні `n` календарних місяців (включно з поточним), київські межі + Kommo unix (UTC). */
function lastMonths(n: number): { ym: string; from: string; to: string; fromUnix: number; toUnix: number }[] {
  const now = new Date();
  const out: { ym: string; from: string; to: string; fromUnix: number; toUnix: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() - i;
    const start = new Date(Date.UTC(y, m, 1));
    const nextStart = new Date(Date.UTC(y, m + 1, 1));
    const lastDay = new Date(Date.UTC(y, m + 1, 0));
    out.push({
      ym: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      from: start.toISOString().slice(0, 10),
      to: lastDay.toISOString().slice(0, 10),
      fromUnix: Math.floor(start.getTime() / 1000),
      toUnix: Math.floor(nextStart.getTime() / 1000),
    });
  }
  return out;
}

/** Kommo НАПРЯМУ: виграні ліди (статус 142) повного циклу, закриті в [fromUnix, toUnix). */
async function fetchWonLeads(fromUnix: number, toUnix: number): Promise<KommoWonLead[]> {
  const statusFilter = money.FC_PIPELINES
    .map((p, i) => `filter[statuses][${i}][pipeline_id]=${p}&filter[statuses][${i}][status_id]=142`)
    .join("&");
  const dateFilter = `filter[closed_at][from]=${fromUnix}&filter[closed_at][to]=${toUnix - 1}`;
  const out: KommoWonLead[] = [];
  for (let page = 1; page <= 400; page++) {
    const data = await kommoGet<{ _embedded?: { leads?: KommoWonLead[] } }>(
      `/api/v4/leads?page=${page}&limit=250&${statusFilter}&${dateFilter}`
    );
    const leads = data?._embedded?.leads ?? [];
    for (const l of leads) {
      out.push({ id: l.id, name: l.name ?? "", price: Number(l.price) || 0, responsible_user_id: l.responsible_user_id });
    }
    if (leads.length < 250) break;
  }
  return out;
}

export interface ReconRow {
  ym: string;
  scope: "team" | "manager";
  id: number;
  name: string;
  ourRevenue: number;
  kommoRevenue: number;
  ourDeals: number;
  kommoDeals: number;
  deltaPct: number; // |our-kommo| / max(kommo, 1) по виручці
}

export interface IntegrityResult {
  orphans: number; // deal_id з deal_stage_events (12 міс), яких немає в deals
  sample: number[];
}

/** Інваріант Ф12: КОЖЕН deal_id з deal_stage_events має бути в deals. Норма = 0. */
export async function checkIntegrity(): Promise<IntegrityResult> {
  const r = await pool.query<{ n: string; sample: number[] | null }>(
    `WITH e AS (
       SELECT DISTINCT kommo_id FROM deal_stage_events
       WHERE (changed_at AT TIME ZONE 'Europe/Kyiv')::date
             >= ((now() AT TIME ZONE 'Europe/Kyiv')::date - interval '12 months')
     )
     SELECT count(*) AS n, (array_agg(e.kommo_id))[1:10] AS sample
     FROM e LEFT JOIN deals d ON d.kommo_id = e.kommo_id
     WHERE d.kommo_id IS NULL`
  );
  return { orphans: Number(r.rows[0]?.n ?? 0), sample: r.rows[0]?.sample ?? [] };
}

export interface ReconResult {
  months: number;
  rows: ReconRow[];
  rowsOverThreshold: ReconRow[];
  maxDeltaPct: number;
  integrity: IntegrityResult;
  ok: boolean;
}

/** Повна звірка: метрика 142 (наше↔Kommo) по місяцях×командах×менеджерах + цілісність. */
export async function runReconcile(months = 12): Promise<ReconResult> {
  // Мапа kommo_user_id → {managerId, teamId}. Наше «наше» рахується по manager_id,
  // Kommo — по responsible_user_id; зводимо через цю мапу.
  const mgrs = await pool.query<{ id: number; kommo_user_id: string; team_id: number | null; name: string }>(
    `SELECT id, kommo_user_id, team_id, name FROM managers WHERE kommo_user_id IS NOT NULL`
  );
  const byKommoUser = new Map(mgrs.rows.map((m) => [Number(m.kommo_user_id), m]));
  const mgrNameById = new Map(mgrs.rows.map((m) => [m.id, m.name]));
  const teamName = new Map<number, string>();
  const teamsRes = await pool.query<{ id: number; name: string }>(`SELECT id, name FROM teams`);
  for (const t of teamsRes.rows) teamName.set(t.id, t.name);

  const rows: ReconRow[] = [];
  for (const M of lastMonths(months)) {
    // НАШЕ — deals у статусі 142, closed_at у місяці (та сама дефініція, що Kommo).
    // deals.price уже збережено мінусом для мінус-угод → SUM уже нетто.
    const ourRes = await pool.query<{ id: number; team_id: number | null; name: string; rev: string; n: string }>(
      `SELECT d.manager_id AS id, m.team_id, m.name, COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS n
       FROM deals d JOIN managers m ON m.id = d.manager_id
       WHERE d.status_id = 142 AND d.pipeline_id = ANY($1)
         AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3
       GROUP BY d.manager_id, m.team_id, m.name`,
      [money.FC_PIPELINES, M.from, M.to]
    );
    const ourMgr = ourRes.rows.map((r) => ({ managerId: r.id, teamId: r.team_id, name: r.name, revenue: Number(r.rev), deals: Number(r.n) }));
    const ourByMgr = new Map(ourMgr.map((r) => [r.managerId, r]));

    // KOMMO НАПРЯМУ — виграні ліди, закриті в місяці, згруповані по менеджеру/команді.
    const won = await fetchWonLeads(M.fromUnix, M.toUnix);
    const kMgr = new Map<number, { rev: number; n: number }>();
    const kTeam = new Map<number, { rev: number; n: number }>();
    for (const l of won) {
      const mgr = byKommoUser.get(l.responsible_user_id);
      if (!mgr) continue; // ліди неактивних/несинкнутих користувачів — поза скоупом
      const price = signedPrice(l.name, l.price);
      const em = kMgr.get(mgr.id) ?? { rev: 0, n: 0 };
      em.rev += price; em.n += 1; kMgr.set(mgr.id, em);
      if (mgr.team_id != null) {
        const et = kTeam.get(mgr.team_id) ?? { rev: 0, n: 0 };
        et.rev += price; et.n += 1; kTeam.set(mgr.team_id, et);
      }
    }

    // НАШЕ по командах.
    const ourTeam = new Map<number, { rev: number; n: number; name: string }>();
    for (const r of ourMgr) {
      if (r.teamId == null) continue;
      const e = ourTeam.get(r.teamId) ?? { rev: 0, n: 0, name: teamName.get(r.teamId) ?? String(r.teamId) };
      e.rev += r.revenue; e.n += r.deals; ourTeam.set(r.teamId, e);
    }

    const push = (scope: "team" | "manager", id: number, name: string, our: { rev: number; n: number } | undefined, k: { rev: number; n: number } | undefined) => {
      const oR = our?.rev ?? 0, kR = k?.rev ?? 0, oN = our?.n ?? 0, kN = k?.n ?? 0;
      if (oR === 0 && kR === 0 && oN === 0 && kN === 0) return;
      rows.push({ ym: M.ym, scope, id, name, ourRevenue: oR, kommoRevenue: kR, ourDeals: oN, kommoDeals: kN, deltaPct: Math.abs(oR - kR) / Math.max(Math.abs(kR), 1) });
    };
    const teamIds = new Set<number>([...ourTeam.keys(), ...kTeam.keys()]);
    for (const tid of teamIds) push("team", tid, teamName.get(tid) ?? String(tid), ourTeam.get(tid), kTeam.get(tid));
    const mgrIds = new Set<number>([...ourByMgr.keys(), ...kMgr.keys()]);
    for (const mid of mgrIds) {
      const nm = ourByMgr.get(mid)?.name ?? mgrNameById.get(mid) ?? String(mid);
      const our = ourByMgr.get(mid);
      push("manager", mid, nm, our ? { rev: our.revenue, n: our.deals } : undefined, kMgr.get(mid));
    }
  }

  const integrity = await checkIntegrity();
  // Поточний (неповний) місяць — синк лагає, closed_at ще не всі синкнуті → не дрейф.
  const now = new Date();
  const currentYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const completed = rows.filter((r) => r.ym !== currentYm);
  const rowsOverThreshold = completed.filter((r) => r.deltaPct > RECONCILE_THRESHOLD);
  const maxDeltaPct = completed.reduce((m, r) => Math.max(m, r.deltaPct), 0);
  const ok = rowsOverThreshold.length === 0 && integrity.orphans === 0;
  return { months, rows, rowsOverThreshold, maxDeltaPct, integrity, ok };
}
