import type { Db } from "./adCallFacts.js";
import { ELEVENLABS_STT_MODEL } from "./callAiProviders.js";
import { STT_PROVIDER } from "./callAiPilot.js";
import { aiCallState } from "./callAiScreen.js";
import type { MissedScope } from "./missedCallsRules.js";
import { CARRIER_RUBRICS, carrierBucket, dealCategory, reviewDeadline, type CarrierAiState, type CarrierBucket, type CarrierResult,
  type DealCategory, type HumanDecision, type OtherType } from "./carrierCallRules.js";

/**
 * 🧭 ВІДСІВ ПЕРЕВІЗНИКІВ — УГОДА ЯК ОДИНИЦЯ (ТЗ Романа 30.09.2026 «Відсів перевізників з „Дзвінків на мобільні“»).
 *
 * Один запит і одне правило (`dealCategory`) годують ВСЕ: вкладки «Клієнти / Перевізники / Інше / На перевірці»,
 * чергу рішень, блок у «Звіті» й закриття в CRM. Тому число у звіті збігається зі списком за побудовою, а не
 * звіркою: вони рахуються з тих самих рядків.
 *
 * Межа видимості — у запиті, а не на екрані (правило 1 кореня: скоуп звужує ВІДПОВІДЬ): менеджер — угоди, де він
 * відповідальний; тімлід — його команда (склад команд — Налаштування дашборда, `managers.team_id`); керівництво —
 * усе. Порожній скоуп — `-1`, а не нуль (`missedScopeFor`, правило 7).
 */

export type CarrierScope = MissedScope;

export interface CloseState { state: "would_close" | "closed" | "reverted" | "failed"; at: string; error: string | null; reason: "carrier" | "other" | "no_talk" }

export interface DealRow {
  kommoId: number;
  phone: string;
  createdAt: string;
  dealState: string;
  reused: boolean;
  talkNo: number;
  uniqueid: string | null;
  calledAt: string | null;
  billsec: number | null;
  direction: "in" | "out" | null;
  managerId: number | null;
  managerName: string | null;
  teamId: number | null;
  teamName: string | null;
  ai: {
    state: CarrierAiState | null;
    failure: string | null;
    rubric: string | null;
    verdict: string | null;
    confidence: number | null;
    otherType: OtherType | null;
    reason: string | null;
    quote: string | null;
    quoteCheck: string | null;
    summary: string | null;
    bucket: CarrierBucket | null;
  };
  human: { decision: HumanDecision; otherType: OtherType | null; note: string | null; by: string; role: string | null; at: string } | null;
  /** Усі рішення людей по угоді, старі — теж (ТЗ: «попередні рішення зберігаються»); останнє — чинне. */
  journal: JournalEntry[];
  category: DealCategory;
  source: "human" | "ai" | "crm" | null;
  /** Стан `history`: угода номера, закрита як «Перевізник», з якої взято вердикт. */
  historyFrom: number | null;
  why: string | null;
  /**
   * «На перевірці» / «Помилка»: з якого моменту чекає людину, до коли її треба розібрати (кінець робочого дня,
   * `reviewDeadline`) і чи вже прострочено. Для решти категорій — `null` / `false`.
   */
  reviewSince: string | null;
  reviewDeadline: string | null;
  overdue: boolean;
  /** Підтип «Інше»: людини, якщо вона вирішила «Інше», інакше AI; для решти категорій — `null`. */
  otherType: OtherType | null;
  close: CloseState | null;
  crm: { statusId: number | null; rejectReason: string | null };
}

export interface JournalEntry { by: string; role: string | null; decision: HumanDecision; otherType: OtherType | null; note: string | null;
  at: string; aiRole: string | null; aiConfidence: number | null }

interface Raw {
  kommo_id: string; phone: string; deal_created_at: Date; state: string; reused: boolean; talk_no: number; u: string | null;
  history_from: string | null;
  manager_id: number | null; manager_name: string | null; team_id: number | null; team_name: string | null;
  calldate: Date | null; billsec: number | null; call_type: string | null;
  stt_status: string | null; stt_failure: string | null; text_empty: boolean | null;
  llm_status: string | null; llm_failure: string | null; result: CarrierResult | null; rubric: string | null;
  d_upd: Date; t_upd: Date | null; a_upd: Date | null;
  dec: HumanDecision | null; dec_other: OtherType | null; dec_note: string | null; dec_role: string | null; dec_at: Date | null; dec_by: string | null;
  deal_status: string | null; reject_reason: string | null;
  cl_decided: Date | null; cl_closed: Date | null; cl_reverted: Date | null; cl_error: string | null; cl_reason: "carrier" | "other" | "no_talk" | null;
}

const IN_TYPES = new Set(["in", "transitin"]);
const iso = (d: Date) => new Date(d).toISOString();

function closeStateOf(x: Raw): CloseState | null {
  if (!x.cl_decided) return null;
  const reason = x.cl_reason ?? "carrier";
  if (x.cl_reverted) return { state: "reverted", at: iso(x.cl_reverted), error: null, reason };
  if (x.cl_closed) return { state: "closed", at: iso(x.cl_closed), error: x.cl_error, reason };
  if (x.cl_error) return { state: "failed", at: iso(x.cl_decided), error: x.cl_error, reason };
  return { state: "would_close", at: iso(x.cl_decided), error: null, reason };
}

export interface DealQuery {
  /** Період за датою створення угоди (Київ, обидва кінці). `null` — без періоду (закриття, картка). */
  period: { from: string; to: string } | null;
  scope: CarrierScope;
  /** Лише ці угоди (закриття: id з відповіді Kommo цього проходу). */
  ids?: readonly number[];
  /** Точка старту: угоди, створені раніше, у вкладки й звіт не йдуть (Роман 30.09.2026: «працюємо з 0»). */
  since?: string | null;
  /** «Зараз» для прострочки; за замовчуванням — мить запиту. */
  now?: Date;
}

/** Найсвіжіший вердикт будь-якої з рубрик мобільних; готовий — першим. */
export const CARRIER_ANALYSIS_LATERAL = (t: string, rubricsParam: string) => `LEFT JOIN LATERAL (
    SELECT a.status, a.failure, a.result, a.rubric_version, a.updated_at FROM call_analyses a
     WHERE a.transcript_id = ${t}.id AND a.rubric_version = ANY(${rubricsParam}::text[])
     ORDER BY (a.status = 'done') DESC, a.id DESC LIMIT 1) a ON true`;

export async function carrierDealRows(db: Db, q: DealQuery): Promise<DealRow[]> {
  const r = await db.query<Raw>(`
    SELECT d.kommo_id::text, d.phone, d.deal_created_at, d.state, (d.reused_from IS NOT NULL) AS reused, d.history_from::text,
           COALESCE(src.talk_no, d.talk_no) AS talk_no, COALESCE(src.uniqueid, d.uniqueid) AS u,
           m.id AS manager_id, m.name AS manager_name, m.team_id, tm.name AS team_name,
           rc.calldate, rc.billsec, rc.call_type,
           t.status AS stt_status, t.failure AS stt_failure,
           (t.status = 'done' AND t.text_purged_at IS NULL AND jsonb_array_length(COALESCE(t.segments, '[]'::jsonb)) = 0) AS text_empty,
           a.status AS llm_status, a.failure AS llm_failure, a.result, a.rubric_version AS rubric,
           d.updated_at AS d_upd, t.updated_at AS t_upd, a.updated_at AS a_upd,
           cd.decision AS dec, cd.other_type AS dec_other, cd.note AS dec_note, cd.decider_role AS dec_role, cd.decided_at AS dec_at,
           COALESCE(um.name, uu.email) AS dec_by,
           dd.status_id::text AS deal_status, dd.reject_reason,
           cl.decided_at AS cl_decided, cl.closed_at AS cl_closed, cl.reverted_at AS cl_reverted, cl.close_error AS cl_error, cl.reason AS cl_reason
      FROM carrier_call_deals d
      LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
      LEFT JOIN managers m ON m.kommo_user_id = d.responsible_user_id
      LEFT JOIN teams tm ON tm.id = m.team_id
      LEFT JOIN ringostat_calls rc ON rc.uniqueid = COALESCE(src.uniqueid, d.uniqueid)
      LEFT JOIN call_transcripts t ON t.uniqueid = rc.uniqueid AND t.provider = $1 AND t.model = $2
      ${CARRIER_ANALYSIS_LATERAL("t", "$3")}
      LEFT JOIN LATERAL (SELECT x.decision, x.other_type, x.note, x.decider_role, x.decided_by, x.decided_at FROM carrier_decisions x
                          WHERE x.kommo_id = d.kommo_id ORDER BY x.id DESC LIMIT 1) cd ON true
      LEFT JOIN users uu ON uu.id = cd.decided_by
      LEFT JOIN managers um ON um.id = uu.manager_id
      LEFT JOIN deals dd ON dd.kommo_id = d.kommo_id
      LEFT JOIN carrier_close_log cl ON cl.kommo_id = d.kommo_id
     WHERE ($4::date IS NULL OR (d.deal_created_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $4::date AND $5::date)
       AND ($6::int IS NULL OR m.id = $6::int)
       AND ($7::int IS NULL OR m.team_id = $7::int)
       AND ($8::bigint[] IS NULL OR d.kommo_id = ANY($8::bigint[]))
       AND ($9::timestamptz IS NULL OR d.deal_created_at >= $9::timestamptz)
     ORDER BY d.deal_created_at DESC, d.kommo_id`,
  [STT_PROVIDER, ELEVENLABS_STT_MODEL, [...CARRIER_RUBRICS], q.period?.from ?? null, q.period?.to ?? null,
    q.scope.managerId ?? null, q.scope.teamId ?? null, q.ids ? [...q.ids] : null, q.since ?? null]);
  const now = q.now ?? new Date();
  const rows = r.rows.map((x) => toRow(x, now));
  if (!rows.length) return rows;
  const j = await db.query<{ kommo_id: string; by: string | null; role: string | null; decision: HumanDecision; other_type: OtherType | null;
    note: string | null; at: Date; ai_role: string | null; ai_confidence: string | null }>(`
    SELECT x.kommo_id::text, COALESCE(um.name, uu.email) AS by, x.decider_role AS role, x.decision, x.other_type, x.note,
           x.decided_at AS at, x.ai_role, x.ai_confidence::text
      FROM carrier_decisions x LEFT JOIN users uu ON uu.id = x.decided_by LEFT JOIN managers um ON um.id = uu.manager_id
     WHERE x.kommo_id = ANY($1::bigint[]) ORDER BY x.id`, [rows.map((x) => x.kommoId)]);
  const byDeal = new Map(rows.map((x) => [x.kommoId, x]));
  for (const x of j.rows) byDeal.get(Number(x.kommo_id))?.journal.push({ by: x.by ?? "невідомо", role: x.role, decision: x.decision,
    otherType: x.other_type, note: x.note, at: iso(x.at), aiRole: x.ai_role, aiConfidence: x.ai_confidence == null ? null : Number(x.ai_confidence) });
  return rows;
}

function toRow(x: Raw, now: Date): DealRow {
  const aiState = x.u ? aiCallState(x.stt_status, x.llm_status, x.text_empty === true) as CarrierAiState : null;
  const result = aiState === "done" ? x.result : null;
  const human = x.dec ? { decision: x.dec, otherType: x.dec_other, note: x.dec_note, by: x.dec_by ?? "невідомо", role: x.dec_role,
    at: iso(x.dec_at!) } : null;
  const cat = dealCategory({ human: x.dec, result, dealState: x.state, ai: aiState });
  const aiOther = result?.caller_role === "other" ? (result.other_type ?? null) : null;
  // Коли угода стала чекати людину: без розмови — коли доба минула (зміна стану угоди); інакше — коли AI дав
  // невпевнений вердикт чи здався (оновлення аналізу, а без нього — розпізнавання).
  const waitsHuman = cat.category === "review" || cat.category === "error";
  const sinceAt = !waitsHuman ? null : x.state === "no_talk" ? x.d_upd : (x.a_upd ?? x.t_upd ?? x.d_upd);
  const deadline = sinceAt ? reviewDeadline(new Date(sinceAt)) : null;
  return {
    kommoId: Number(x.kommo_id), phone: x.phone, createdAt: iso(x.deal_created_at), dealState: x.state, reused: x.reused,
    talkNo: Number(x.talk_no), uniqueid: x.u, calledAt: x.calldate ? iso(x.calldate) : null,
    billsec: x.billsec == null ? null : Number(x.billsec), direction: x.call_type ? (IN_TYPES.has(x.call_type) ? "in" : "out") : null,
    managerId: x.manager_id, managerName: x.manager_name, teamId: x.team_id, teamName: x.team_name,
    ai: {
      state: aiState, failure: x.llm_failure ?? x.stt_failure, rubric: result ? x.rubric : null,
      verdict: result?.caller_role ?? null, confidence: result ? Number(result.caller_role_confidence) : null,
      otherType: aiOther, reason: result?.reason || null, quote: result?.caller_role_quote || null,
      quoteCheck: result?.quote_check ?? null, summary: result?.summary || null, bucket: result ? carrierBucket(result) : null,
    },
    human, journal: [], category: cat.category, source: cat.source, why: cat.why,
    historyFrom: x.history_from == null ? null : Number(x.history_from),
    reviewSince: sinceAt ? iso(sinceAt) : null, reviewDeadline: deadline ? deadline.toISOString() : null,
    overdue: deadline != null && now.getTime() > deadline.getTime(),
    otherType: cat.category !== "other" ? null : cat.source === "human" ? (human?.otherType ?? null) : aiOther,
    close: closeStateOf(x),
    crm: { statusId: x.deal_status == null ? null : Number(x.deal_status), rejectReason: x.reject_reason },
  };
}

// ─── Звіт (ТЗ: блок по менеджерах у «Звіті») ─────────────────────────────────────────────────────

export interface ReportCounts {
  total: number; clients: number;
  carriersAuto: number; carriersManual: number;
  otherAuto: number; otherManual: number;
  /** «На перевірці» + «Помилка» + AI ще слухає. */
  unsorted: number;
  /** З «не розібрано» — не розібрані до кінця робочого дня (червоне в звіті). */
  overdue: number;
  /** Без розмови від 10 с — закриті «Немає зв'язку», не аналізуються; у «усього» й вкладки НЕ входять. */
  noTalk: number;
}
export interface ReportLine extends ReportCounts { managerId: number | null; managerName: string | null; teamId: number | null; teamName: string | null }

const zero = (): ReportCounts => ({ total: 0, clients: 0, carriersAuto: 0, carriersManual: 0, otherAuto: 0, otherManual: 0, unsorted: 0, overdue: 0, noTalk: 0 });

function add(c: ReportCounts, r: Pick<DealRow, "category" | "source" | "overdue">): void {
  if (r.category === "no_talk") { c.noTalk++; return; }
  c.total++;
  if (r.overdue) c.overdue++;
  if (r.category === "client") c.clients++;
  else if (r.category === "carrier") { if (r.source === "human") c.carriersManual++; else c.carriersAuto++; }
  else if (r.category === "other") { if (r.source === "human") c.otherManual++; else c.otherAuto++; }
  else c.unsorted++;
}

/**
 * Рядок на менеджера + сума команди + сума всього — з ТИХ САМИХ рядків, що й вкладки. «Без менеджера» — окремим
 * рядком (невідоме видиме, frontend.md), а не розчиняється в сумі.
 */
export function carrierReport(rows: readonly Pick<DealRow, "category" | "source" | "overdue" | "managerId" | "managerName" | "teamId" | "teamName">[]):
  { managers: ReportLine[]; teams: ReportLine[]; total: ReportCounts } {
  const byMgr = new Map<string, ReportLine>(), byTeam = new Map<string, ReportLine>();
  const total = zero();
  for (const r of rows) {
    const mk = r.managerId == null ? "none" : String(r.managerId);
    let m = byMgr.get(mk);
    if (!m) { m = { managerId: r.managerId, managerName: r.managerName, teamId: r.teamId, teamName: r.teamName, ...zero() }; byMgr.set(mk, m); }
    const tk = r.teamId == null ? "none" : String(r.teamId);
    let t = byTeam.get(tk);
    if (!t) { t = { managerId: null, managerName: null, teamId: r.teamId, teamName: r.teamName, ...zero() }; byTeam.set(tk, t); }
    add(m, r); add(t, r); add(total, r);
  }
  const order = (a: ReportLine, b: ReportLine) => b.total - a.total || (a.managerName ?? a.teamName ?? "").localeCompare(b.managerName ?? b.teamName ?? "", "uk");
  return { managers: [...byMgr.values()].sort(order), teams: [...byTeam.values()].sort(order), total };
}

/**
 * Прибрав фільтр CRM (Lardi / відомий перевізник) — поза AI, окремим числом по менеджерах (`deals`, синк 30 хв).
 * «Фільтр», а не «хтось закрив як перевізника»: угоду, яку ми бачили на етапі після фільтра, закрили вже ми чи людина
 * (зокрема разове закриття старих 30.09.2026) — вона в рядках вкладок, а не тут. Інакше одна угода рахувалась би двічі.
 */
export async function filterRemovedByManager(db: Db, from: string, to: string, pipelineId: number, scope: CarrierScope,
  since: string | null = null): Promise<Map<number | null, number>> {
  const r = await db.query<{ manager_id: number | null; n: number }>(`
    SELECT m.id AS manager_id, count(*)::int AS n FROM deals dd LEFT JOIN managers m ON m.id = dd.manager_id
     WHERE dd.pipeline_id = $3 AND dd.status_id = 143 AND dd.reject_reason = 'Перевізник' AND dd.name ~ '^380[0-9]{9}$'
       AND (dd.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
       AND NOT EXISTS (SELECT 1 FROM carrier_call_deals x WHERE x.kommo_id = dd.kommo_id)
       AND ($4::int IS NULL OR m.id = $4::int) AND ($5::int IS NULL OR m.team_id = $5::int)
       AND ($6::timestamptz IS NULL OR dd.created_at_kommo >= $6::timestamptz)
     GROUP BY 1`, [from, to, pipelineId, scope.managerId ?? null, scope.teamId ?? null, since]);
  return new Map(r.rows.map((x) => [x.manager_id, Number(x.n)]));
}

/** Чи бачить скоуп хоч одну угоду цього дзвінка (картка й запис: чужий дзвінок — 404, а не 403). */
export async function callInScope(db: Db, uniqueid: string, scope: CarrierScope): Promise<boolean> {
  const r = await db.query(`
    SELECT 1 FROM carrier_call_deals d
      LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
      LEFT JOIN managers m ON m.kommo_user_id = d.responsible_user_id
     WHERE (COALESCE(src.uniqueid, d.uniqueid) = $1 OR d.first_uniqueid = $1)
       AND ($2::int IS NULL OR m.id = $2::int) AND ($3::int IS NULL OR m.team_id = $3::int)
     LIMIT 1`, [uniqueid, scope.managerId ?? null, scope.teamId ?? null]);
  return (r.rowCount ?? 0) > 0;
}

// ─── Динаміка за період (прохання Романа 30.09.2026: «графіки … скільки відсіяно, пропущено, скільки грошей») ─────

export interface DayStat { day: string; filtered: number; noTalk: number; clients: number; carriers: number; other: number; unsorted: number; spendUsd: number | null }

const kyivDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

/** Усі дні [from; to] (Київ), щоб порожній день був нулем, а не пропуском на осі. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to && out.length < 400; d = new Date(d.getTime() + 86_400_000))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

/**
 * День за днем: скільки угод відсіяв фільтр CRM, скільки без розмови, як AI/людина розсортували решту — з ТИХ САМИХ
 * рядків, що вкладки (`carrierDealRows`), тож сума стовпчиків дорівнює числам вкладок і звіту. Витрати AI мобільних
 * (`carrier_*`) — по компанії, лише коли `withSpend` (керівництво); інакше `null`.
 */
export async function carrierDailyStats(db: Db, from: string, to: string, scope: CarrierScope, since: string | null,
  pipelineId: number, withSpend: boolean): Promise<DayStat[]> {
  const days = new Map(daysBetween(from, to).map((d) => [d, { day: d, filtered: 0, noTalk: 0, clients: 0, carriers: 0, other: 0, unsorted: 0,
    spendUsd: withSpend ? 0 : null } as DayStat]));
  for (const r of await carrierDealRows(db, { period: { from, to }, scope, since })) {
    const x = days.get(kyivDay(r.createdAt)); if (!x) continue;
    if (r.category === "no_talk") x.noTalk++;
    else if (r.category === "client") x.clients++;
    else if (r.category === "carrier") x.carriers++;
    else if (r.category === "other") x.other++;
    else x.unsorted++;
  }
  const f = await db.query<{ day: string; n: number }>(`
    SELECT to_char(dd.created_at_kommo AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM deals dd LEFT JOIN managers m ON m.id = dd.manager_id
     WHERE dd.pipeline_id = $3 AND dd.status_id = 143 AND dd.reject_reason = 'Перевізник' AND dd.name ~ '^380[0-9]{9}$'
       AND (dd.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
       AND NOT EXISTS (SELECT 1 FROM carrier_call_deals x WHERE x.kommo_id = dd.kommo_id)
       AND ($4::int IS NULL OR m.id = $4::int) AND ($5::int IS NULL OR m.team_id = $5::int)
       AND ($6::timestamptz IS NULL OR dd.created_at_kommo >= $6::timestamptz)
     GROUP BY 1`, [from, to, pipelineId, scope.managerId ?? null, scope.teamId ?? null, since]);
  for (const x of f.rows) { const d = days.get(x.day); if (d) d.filtered = Number(x.n); }
  if (withSpend) {
    const s = await db.query<{ day: string; usd: number }>(`
      SELECT to_char(at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, COALESCE(SUM(usd), 0)::float8 AS usd FROM ai_spend_ledger
       WHERE left(operation, length('carrier_')) = 'carrier_' AND (at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
       GROUP BY 1`, [from, to]);
    for (const x of s.rows) { const d = days.get(x.day); if (d) d.spendUsd = Math.round(Number(x.usd) * 100) / 100; }
  }
  return [...days.values()];
}

/** «AI проти людини» поіменно: останнє рішення по угоді, де AI мав вердикт, — хто, коли, яка угода, чий менеджер. */
export interface AgreementRow { kommoId: number; uniqueid: string | null; managerName: string | null; aiRole: string; aiConfidence: number | null;
  decision: HumanDecision; otherType: OtherType | null; by: string; byRole: string | null; at: string; agreed: boolean }

export async function carrierAgreementRows(db: Db, limit = 300): Promise<AgreementRow[]> {
  const r = await db.query<{ kommo_id: string; u: string | null; manager_name: string | null; ai_role: string; ai_confidence: string | null;
    decision: HumanDecision; other_type: OtherType | null; by: string | null; decider_role: string | null; decided_at: Date }>(`
    SELECT * FROM (
      SELECT DISTINCT ON (x.kommo_id) x.kommo_id::text, COALESCE(src.uniqueid, d.uniqueid) AS u, m.name AS manager_name,
             x.ai_role, x.ai_confidence::text, x.decision, x.other_type, COALESCE(um.name, uu.email) AS by, x.decider_role, x.decided_at
        FROM carrier_decisions x
        LEFT JOIN carrier_call_deals d ON d.kommo_id = x.kommo_id
        LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
        LEFT JOIN managers m ON m.kommo_user_id = d.responsible_user_id
        LEFT JOIN users uu ON uu.id = x.decided_by LEFT JOIN managers um ON um.id = uu.manager_id
       ORDER BY x.kommo_id, x.id DESC) z
     WHERE z.ai_role IS NOT NULL
     ORDER BY z.decided_at DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ kommoId: Number(x.kommo_id), uniqueid: x.u, managerName: x.manager_name, aiRole: x.ai_role,
    aiConfidence: x.ai_confidence == null ? null : Number(x.ai_confidence), decision: x.decision, otherType: x.other_type,
    by: x.by ?? "невідомо", byRole: x.decider_role, at: iso(x.decided_at), agreed: x.ai_role === x.decision }));
}
