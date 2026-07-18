import { pool } from "../db/pool.js";
import { kommoGet, extractIsMinus, type KommoDeal } from "../kommo/client.js";
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
export const RECONCILE_THRESHOLD = 0.005; // 0.5% — синк (deals ↔ Kommo)
export const DASHBOARD_THRESHOLD = 0.02; // 2% — дашборд (money.ts ↔ deals)
// АБСОЛЮТНИЙ мінімум значущості: рядок «будить» алерт лише якщо дельта > %-порогу
// І матеріальна (>2 угод АБО >20 000 ₴). Інакше один дил у малого менеджера
// (3% від 48) червонив би алерт щоночі → за 2 тижні на нього перестануть дивитись.
// НЕ піднімати %-поріг — саме матеріальність відсіює шум, не втрачаючи поломки.
export const MATERIAL_DEALS = 2;
export const MATERIAL_REVENUE = 20000;
const isMaterial = (r: ReconRow) =>
  Math.abs(r.ourDeals - r.kommoDeals) > MATERIAL_DEALS || Math.abs(r.ourRevenue - r.kommoRevenue) > MATERIAL_REVENUE;

interface KommoWonLead {
  id: number;
  name: string;
  price: number;
  responsible_user_id: number;
  closed_at: number | null;
  is_minus: boolean;
}

// Знак дає ПОЛЕ «Мінусова угода» (2098529), не слово в назві — тотожно syncKommo,
// щоб Kommo-сторона звірки нетила мінуси так само, як наша `deals.price` (інакше
// 270 польових-мінусів давали б хибний дрейф deals↔Kommo).
const signedPrice = (isMinus: boolean, price: number) =>
  isMinus ? -Math.abs(price) : Math.abs(price);

/** YYYY-MM у КИЇВСЬКОМУ часі — щоб бакетити Kommo так само, як наше (не по UTC). */
const kyivMonth = (unix: number | null): string | null =>
  unix ? new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }).slice(0, 7) : null;

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

/** Kommo НАПРЯМУ: виграні ліди (статус 142) повного циклу, closed_at у [from, to).
 * Вікно розширене на ±1 добу — бо межі місяця в нас київські, а filter[closed_at]
 * у Kommo — по unix (UTC); бакетимо потім по КИЇВСЬКІЙ даті (kyivMonth). */
async function fetchWonLeads(fromUnix: number, toUnix: number): Promise<KommoWonLead[]> {
  const statusFilter = money.FC_PIPELINES
    .map((p, i) => `filter[statuses][${i}][pipeline_id]=${p}&filter[statuses][${i}][status_id]=142`)
    .join("&");
  const dateFilter = `filter[closed_at][from]=${fromUnix - 86400}&filter[closed_at][to]=${toUnix + 86400}`;
  const out: KommoWonLead[] = [];
  for (let page = 1; page <= 400; page++) {
    const data = await kommoGet<{ _embedded?: { leads?: KommoDeal[] } }>(
      `/api/v4/leads?page=${page}&limit=250&${statusFilter}&${dateFilter}`
    );
    const leads = data?._embedded?.leads ?? [];
    for (const l of leads) {
      out.push({ id: l.id, name: l.name ?? "", price: Number(l.price) || 0, responsible_user_id: l.responsible_user_id, closed_at: l.closed_at ?? null, is_minus: extractIsMinus(l) });
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

/**
 * Ч.2 (4-та перевірка) — СВІЖІСТЬ вотермарків. Застряглий вотермарк ТИХО ламає
 * метрики (напр. `last_event_at` застряг 09.07 → липневі гроші недораховувались, а
 * 3 рівні цього не бачили, бо поточний місяць виключено з pass/fail). Поріг = 2×
 * частоти джоби. Має БУДИТИ (Telegram), не логуватись.
 */
export interface FreshnessRow {
  key: string;
  label: string;
  ageMin: number | null; // null = вотермарк ніколи не ставився
  thresholdMin: number;
  stale: boolean;
  critical: boolean; // money-критичний (last_event_at живить core/money.ts)
}

export async function checkFreshness(): Promise<FreshnessRow[]> {
  const r = await pool.query<{ success: string | null; event: string | null; activity: string | null; transfer: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - last_success_at)) / 60 AS success,
            EXTRACT(EPOCH FROM (now() - last_event_at)) / 60 AS event,
            EXTRACT(EPOCH FROM (now() - last_activity_note_at)) / 60 AS activity,
            EXTRACT(EPOCH FROM (now() - last_transfer_at)) / 60 AS transfer
       FROM sync_state WHERE id = 1`
  );
  const row = r.rows[0] ?? {};
  const defs: { key: string; label: string; raw: string | null | undefined; thresholdMin: number; critical: boolean }[] = [
    // Пороги = 2× частоти: syncKommo/syncStageEvents 30хв→60; syncDealActivity 3год→360; syncTransfers 24год→2880.
    { key: "last_event_at", label: "syncStageEvents (💰 гроші)", raw: row.event, thresholdMin: 60, critical: true },
    { key: "last_success_at", label: "syncKommo", raw: row.success, thresholdMin: 60, critical: false },
    { key: "last_activity_note_at", label: "syncDealActivity", raw: row.activity, thresholdMin: 360, critical: false },
    { key: "last_transfer_at", label: "syncTransfers", raw: row.transfer, thresholdMin: 2880, critical: false },
  ];
  return defs.map((d) => {
    const ageMin = d.raw == null ? null : Math.round(Number(d.raw));
    // NULL (ніколи не синкалось): критичні (гроші) → stale; решта → ні (щоб не шуміти на свіжій БД).
    const stale = ageMin == null ? d.critical : ageMin > d.thresholdMin;
    return { key: d.key, label: d.label, ageMin, thresholdMin: d.thresholdMin, stale, critical: d.critical };
  });
}

/**
 * Ч.4 — «ПОКИНУТІ СТАДІЇ» (КРОК 6.6). Той самий клас, що застряглий вотермарк:
 * процес у CRM ламається (стадію перестають проставляти), а метрика, що з неї
 * живиться, ТИХО показує ~0. Доведено: Реактивація-142 «Відправлено у відділ
 * продажів» впала з ~250/міс до 2–10 з 04.2026 → conversion_reactivation_handoff
 * замовкла, і жоден рівень звірки цього не бачив.
 *
 * Легка перевірка (лише `deal_stage_events`, БЕЗ Kommo): для КЛЮЧОВИХ стадій
 * (handoff-и лідогену + грошові етапи) беремо ОСТАННІЙ ПОВНИЙ місяць і медіану
 * 3 місяців перед ним. Якщо обсяг подій впав **>80%** від медіани — стадію
 * «покинуто». Поточний (неповний) місяць НЕ рахуємо (щоб не фолсити на 1-е число).
 * Поріг матеріальності `ABANDON_MIN_BASELINE`: стадії з медіаною <20 подій/міс
 * ігноруємо (дрібні й так шумлять).
 */
export interface AbandonedStageRow {
  key: string;
  label: string;
  month: string;          // останній ПОВНИЙ місяць, що перевіряється
  current: number;        // обсяг подій того місяця
  medianPrev3: number;    // медіана 3 місяців перед ним
  dropPct: number | null; // % падіння від медіани
  abandoned: boolean;
}

const ABANDON_MIN_BASELINE = 20; // медіана нижче — стадія не «ключова», не шумимо
const ABANDON_DROP = 0.8;        // падіння >80% від медіани = покинуто

export async function checkAbandonedStages(): Promise<AbandonedStageRow[]> {
  const FC = money.FC_PIPELINES;
  const stages: { key: string; label: string; statusIds: number[]; pipelineIds: number[] }[] = [
    { key: "react_handoff", label: "Реактивація-142 «Відправлено у відділ продажів»", statusIds: [142], pipelineIds: [8921948] },
    { key: "prodzvin_handoff", label: "Продзвін-142 «заявку на прорахунок отримано»", statusIds: [142], pipelineIds: [8921936, 7337048] },
    { key: "money_expected", label: "💰 Етап 8 «Очікуємо оплату»", statusIds: money.STAGE_EXPECTED, pipelineIds: FC },
    { key: "money_paid", label: "💰 Етап 9 «Оплата отримана»", statusIds: money.STAGE_PAID, pipelineIds: FC },
    { key: "money_success", label: "💰 Етап 10 «Успішна угода» (142)", statusIds: [142], pipelineIds: FC },
  ];
  const out: AbandonedStageRow[] = [];
  for (const st of stages) {
    // 4 повні місяці [M-4..M-1]; поточний неповний виключено (< поч. поточного місяця).
    const r = await pool.query<{ ym: string; n: string }>(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')) - interval '4 months',
           date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')) - interval '1 month',
           interval '1 month') m
       ),
       ev AS (
         SELECT date_trunc('month', (changed_at AT TIME ZONE 'Europe/Kyiv')) m, count(DISTINCT kommo_id) n
           FROM deal_stage_events
          WHERE status_id = ANY($1) AND pipeline_id = ANY($2)
          GROUP BY 1
       )
       SELECT to_char(mo.m, 'YYYY-MM') ym, COALESCE(ev.n, 0)::int n
         FROM months mo LEFT JOIN ev ON ev.m = mo.m ORDER BY mo.m`,
      [st.statusIds, st.pipelineIds]
    );
    const counts = r.rows.map((x) => Number(x.n)); // [M-4, M-3, M-2, M-1]
    if (counts.length < 4) continue;
    const current = counts[3];
    const prev3 = counts.slice(0, 3).sort((a, b) => a - b);
    const median = prev3[1];
    const abandoned = median >= ABANDON_MIN_BASELINE && current < (1 - ABANDON_DROP) * median;
    out.push({
      key: st.key, label: st.label, month: r.rows[3].ym,
      current, medianPrev3: median,
      dropPct: median > 0 ? Math.round((1 - current / median) * 100) : null,
      abandoned,
    });
  }
  return out;
}

export interface ReconResult {
  months: number;
  // Рівень СИНК: deals ↔ Kommo (status 142 + closed_at). ourRevenue=deals, kommoRevenue=Kommo.
  rows: ReconRow[];
  rowsOverThreshold: ReconRow[]; // >0.5% І матеріальні → будять алерт
  syncMinor: ReconRow[]; // >0.5% але НЕ матеріальні → лише логуються
  maxDeltaPct: number;
  // Рівень ДАШБОРД: money.ts (вхід у 142) ↔ deals (142, closed_at). ourRevenue=money.ts, kommoRevenue=deals.
  dashRows: ReconRow[];
  dashboardOver: ReconRow[]; // >2% І матеріальні
  dashMinor: ReconRow[];
  dashboardMaxDelta: number;
  // Рівень ЦІЛІСНІСТЬ: кожен deal_id з подій є в deals.
  integrity: IntegrityResult;
  // ДОРМАНТНІ УГОДИ: Kommo вважає виграними (142, повний цикл, closed у місяці),
  // але їх НЕМАЄ в `deals` (протік синк по updated_at). Ціль авто-хілу.
  missingWonIds: number[];
  missingWonByMonth: { ym: string; ids: number[] }[];
  // Ч.2: свіжість вотермарків (окремий сигнал, НЕ входить у ok — його будить hourly-watch).
  freshness: FreshnessRow[];
  // Ч.3: ПОТОЧНИЙ місяць — НЕ фейлить (він неповний), але ПОПЕРЕДЖАЄ: матеріальні
  // розбіжності синку/дашборду за поточний місяць. «warning», не «пропущено».
  currentMonthWarnings: ReconRow[];
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
  const dashRows: ReconRow[] = [];
  const missingWonByMonth: { ym: string; ids: number[] }[] = [];
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

    // ДАШБОРД — money.ts success (вхід у 142, анкер по події) по менеджеру.
    const moneyMgr = await money.successByMgr({ from: M.from, to: M.to });
    const moneyByMgr = new Map(moneyMgr.map((r) => [r.managerId, r]));
    const moneyTeam = new Map<number, { rev: number; n: number }>();
    for (const r of moneyMgr) {
      if (r.teamId == null) continue;
      const e = moneyTeam.get(r.teamId) ?? { rev: 0, n: 0 };
      e.rev += r.revenue; e.n += r.deals; moneyTeam.set(r.teamId, e);
    }

    // KOMMO НАПРЯМУ — виграні ліди, закриті в місяці, згруповані по менеджеру/команді.
    const won = await fetchWonLeads(M.fromUnix, M.toUnix);

    // ДОРМАНТНІ — виграні в Kommo (київський бакет = цей місяць), яких немає в `deals`
    // ВЗАГАЛІ (протікання синку по updated_at). Саме їх дотягує авто-хіл.
    const wonThisMonthIds = won.filter((l) => kyivMonth(l.closed_at) === M.ym).map((l) => l.id);
    if (wonThisMonthIds.length) {
      const present = await pool.query<{ kommo_id: string }>(
        `SELECT kommo_id FROM deals WHERE kommo_id = ANY($1::bigint[])`,
        [wonThisMonthIds]
      );
      const presentSet = new Set(present.rows.map((r) => String(r.kommo_id)));
      const missing = wonThisMonthIds.filter((id) => !presentSet.has(String(id)));
      if (missing.length) missingWonByMonth.push({ ym: M.ym, ids: missing });
    }

    const kMgr = new Map<number, { rev: number; n: number }>();
    const kTeam = new Map<number, { rev: number; n: number }>();
    for (const l of won) {
      if (kyivMonth(l.closed_at) !== M.ym) continue; // бакет по київській даті (як наше)
      const mgr = byKommoUser.get(l.responsible_user_id);
      if (!mgr) continue; // ліди неактивних/несинкнутих користувачів — поза скоупом
      const price = signedPrice(l.is_minus, l.price);
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

    // ДАШБОРД-рядки: money.ts (a) ↔ deals (b). Мають майже збігатись у закритих
    // місяцях (з успіху не повертаються — 1-2 виключення на всю історію).
    const pushDash = (scope: "team" | "manager", id: number, name: string, a: { rev: number; n: number } | undefined, b: { rev: number; n: number } | undefined) => {
      const aR = a?.rev ?? 0, bR = b?.rev ?? 0, aN = a?.n ?? 0, bN = b?.n ?? 0;
      if (aR === 0 && bR === 0 && aN === 0 && bN === 0) return;
      dashRows.push({ ym: M.ym, scope, id, name, ourRevenue: aR, kommoRevenue: bR, ourDeals: aN, kommoDeals: bN, deltaPct: Math.abs(aR - bR) / Math.max(Math.abs(bR), 1) });
    };
    const dTeamIds = new Set<number>([...moneyTeam.keys(), ...ourTeam.keys()]);
    for (const tid of dTeamIds) {
      const dl = ourTeam.get(tid);
      pushDash("team", tid, teamName.get(tid) ?? String(tid), moneyTeam.get(tid), dl ? { rev: dl.rev, n: dl.n } : undefined);
    }
    const dMgrIds = new Set<number>([...moneyByMgr.keys(), ...ourByMgr.keys()]);
    for (const mid of dMgrIds) {
      const nm = moneyByMgr.get(mid)?.name ?? ourByMgr.get(mid)?.name ?? mgrNameById.get(mid) ?? String(mid);
      const mny = moneyByMgr.get(mid), dl = ourByMgr.get(mid);
      pushDash("manager", mid, nm, mny ? { rev: mny.revenue, n: mny.deals } : undefined, dl ? { rev: dl.revenue, n: dl.deals } : undefined);
    }
  }

  const integrity = await checkIntegrity();
  // Поточний (неповний) місяць — синк лагає, closed_at ще не всі синкнуті → не дрейф.
  const now = new Date();
  const currentYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const completed = rows.filter((r) => r.ym !== currentYm);
  const syncFlagged = completed.filter((r) => r.deltaPct > RECONCILE_THRESHOLD);
  const rowsOverThreshold = syncFlagged.filter(isMaterial); // будять
  const syncMinor = syncFlagged.filter((r) => !isMaterial(r)); // логуються
  const maxDeltaPct = completed.reduce((m, r) => Math.max(m, r.deltaPct), 0);
  const completedDash = dashRows.filter((r) => r.ym !== currentYm);
  const dashFlagged = completedDash.filter((r) => r.deltaPct > DASHBOARD_THRESHOLD);
  const dashboardOver = dashFlagged.filter(isMaterial);
  const dashMinor = dashFlagged.filter((r) => !isMaterial(r));
  const dashboardMaxDelta = completedDash.reduce((m, r) => Math.max(m, r.deltaPct), 0);

  // Ч.3: ПОТОЧНИЙ місяць — попереджає, не фейлить. Матеріальні розбіжності синку/
  // дашборду за поточний ym (той самий поріг+матеріальність, що й для закритих). Саме
  // тут застряглий вотермарк проявився б дельтою — раніше він мовчки випадав із pass/fail.
  const cur = (arr: ReconRow[], thr: number) =>
    arr.filter((r) => r.ym === currentYm && r.deltaPct > thr && isMaterial(r));
  const currentMonthWarnings = [...cur(rows, RECONCILE_THRESHOLD), ...cur(dashRows, DASHBOARD_THRESHOLD)];

  const freshness = await checkFreshness();

  // ok = НЕМАЄ МАТЕРІАЛЬНИХ розбіжностей (дрібні дилки не валять звірку) + цілісність.
  // Свіжість і поточний місяць у ok НЕ входять (окремі сигнали: свіжість будить hourly-watch,
  // поточний місяць — «warning»), щоб ok лишався про Kommo-звірені ЗАКРИТІ факти.
  const ok = rowsOverThreshold.length === 0 && dashboardOver.length === 0 && integrity.orphans === 0;
  const missingWonIds = missingWonByMonth.flatMap((m) => m.ids);
  return { months, rows, rowsOverThreshold, syncMinor, maxDeltaPct, dashRows, dashboardOver, dashMinor, dashboardMaxDelta, integrity, missingWonIds, missingWonByMonth, freshness, currentMonthWarnings, ok };
}
