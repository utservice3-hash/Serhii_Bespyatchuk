import type { Db } from "./adCallFacts.js";
import { ELEVENLABS_STT_MODEL, type Turn } from "./callAiProviders.js";
import { LLM_PROVIDER, STT_PROVIDER } from "./callAiPilot.js";
import { monthSpend, monthSpendByOp } from "./callAiPipeline.js";
import { aiCallState, type AiCallState } from "./callAiScreen.js";
import { CARRIER_BUDGET, CARRIER_RUBRICS, CARRIER_STAGE, carrierBucket, type CarrierBucket,
  type CarrierResult } from "./carrierCallRules.js";
import { CARRIER_ANALYSIS_LATERAL, carrierDealRows, type CarrierScope, type CloseState, type DealRow } from "./carrierDeals.js";

/**
 * 🚚 ЕКРАН «ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ» (29.09.2026; ТЗ Романа 30.09.2026 «Відсів перевізників»).
 * Рядок — УГОДА (`carrierDealRows`): вкладки «Клієнти / Перевізники / Інше / На перевірці» й звіт рахуються з
 * тих самих рядків. Межа — скоуп ролі (менеджер — свої, тімлід — команда, керівництво — усе).
 */

export const SCREEN_LIMIT = 5000;

/**
 * Хто слухає запис і читає текст розмови у цій вкладці: усі ролі вкладки, у межах свого скоупу (ТЗ 30.09.2026:
 * картка менеджера й тімліда — «аудіо, транскрипт, вердикт»). Окремий набір, а не `TRANSCRIPT_ROLES` «Першого дотику».
 */
export const CARRIER_LISTEN_ROLES: ReadonlySet<string> = new Set(["admin", "ceo", "opdir", "kvp", "team_lead", "manager"]);

export interface CarrierKpis {
  /** Угоди етапу (назва-номер), які фільтр CRM закрив як «Перевізник» і яких ми після фільтра не бачили. */
  removedByFilter: number;
  /** Угоди, які ми побачили на етапі ПІСЛЯ фільтра (`carrier_call_deals`), — усі, з розмовою чи без. */
  leftAfterFilter: number;
  waitingTalk: number;
  noTalk: number;
  /** З якого моменту ведеться облік «після фільтра»: раніше цієї дати число не відтворюється (правило 17). */
  recordingSince: string | null;
}

export async function carrierCallsList(db: Db, from: string, to: string, scope: CarrierScope = {}, since: string | null = null):
  Promise<{ rows: DealRow[]; kpis: CarrierKpis; truncated: boolean }> {
  const all = await carrierDealRows(db, { period: { from, to }, scope, since });
  const k = (await db.query<{ removed: number; since: Date | null }>(`
    SELECT (SELECT count(*) FROM deals dd LEFT JOIN managers m ON m.id = dd.manager_id
             WHERE dd.pipeline_id = $3 AND dd.status_id = 143 AND dd.reject_reason = 'Перевізник' AND dd.name ~ '^380[0-9]{9}$'
               AND (dd.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
               AND NOT EXISTS (SELECT 1 FROM carrier_call_deals x WHERE x.kommo_id = dd.kommo_id)
               AND ($4::int IS NULL OR m.id = $4::int) AND ($5::int IS NULL OR m.team_id = $5::int)
               AND ($6::timestamptz IS NULL OR dd.created_at_kommo >= $6::timestamptz))::int AS removed,
           GREATEST((SELECT min(seen_at) FROM carrier_call_deals), $6::timestamptz) AS since`,
  [from, to, CARRIER_STAGE.pipelineId, scope.managerId ?? null, scope.teamId ?? null, since])).rows[0];
  return {
    rows: all.slice(0, SCREEN_LIMIT),
    truncated: all.length > SCREEN_LIMIT,
    kpis: {
      removedByFilter: Number(k?.removed ?? 0), leftAfterFilter: all.length,
      waitingTalk: all.filter((r) => r.dealState === "waiting").length, noTalk: all.filter((r) => r.dealState === "no_talk").length,
      recordingSince: k?.since ? new Date(k.since).toISOString() : null,
    },
  };
}

function closeStateOf(x: { cl_decided: Date | null; cl_closed: Date | null; cl_reverted: Date | null; cl_error: string | null;
  cl_reason: "carrier" | "other" | null }): CloseState | null {
  if (!x.cl_decided) return null;
  const iso = (d: Date) => new Date(d).toISOString();
  const reason = x.cl_reason ?? "carrier";
  if (x.cl_reverted) return { state: "reverted", at: iso(x.cl_reverted), error: null, reason };
  if (x.cl_closed) return { state: "closed", at: iso(x.cl_closed), error: x.cl_error, reason };
  if (x.cl_error) return { state: "failed", at: iso(x.cl_decided), error: x.cl_error, reason };
  return { state: "would_close", at: iso(x.cl_decided), error: null, reason };
}

export interface CarrierCallCard {
  uniqueid: string;
  calledAt: string;
  billsec: number;
  managerName: string | null;
  deals: { kommoId: number; reused: boolean; close: CloseState | null }[];
  talkNo: number;
  /** Перша розмова, якщо цю слухали як другу спробу, — і що з неї вийшло. */
  firstTry: { uniqueid: string; role: string | null } | null;
  state: AiCallState;
  failure: string | null;
  result: CarrierResult | null;
  bucket: CarrierBucket | null;
  turns: Turn[] | null;
  transcriptHidden: boolean;
  textPurged: boolean;
  managerChannel: number | null;
}

/**
 * Картка дзвінка — лише дзвінка мобільних (є в `carrier_call_deals`); чужий дзвінок → `null` → 404, щоб
 * через цю вкладку не читались розмови інших екранів. Повний текст — лише тим, кому дозволено (`canSeeTranscript`).
 */
export async function carrierCallCard(db: Db, uniqueid: string, canSeeTranscript: boolean): Promise<CarrierCallCard | null> {
  const deals = (await db.query<{ kommo_id: string; state: string; talk_no: number; uniqueid: string | null; first_uniqueid: string | null;
    cl_decided: Date | null; cl_closed: Date | null; cl_reverted: Date | null; cl_error: string | null; cl_reason: "carrier" | "other" | null }>(`
    SELECT d.kommo_id::text, d.state, COALESCE(src.talk_no, d.talk_no) AS talk_no,
           COALESCE(src.uniqueid, d.uniqueid) AS uniqueid, COALESCE(src.first_uniqueid, d.first_uniqueid) AS first_uniqueid,
           cl.decided_at AS cl_decided, cl.closed_at AS cl_closed, cl.reverted_at AS cl_reverted, cl.close_error AS cl_error,
           cl.reason AS cl_reason
      FROM carrier_call_deals d LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
      LEFT JOIN carrier_close_log cl ON cl.kommo_id = d.kommo_id
     WHERE COALESCE(src.uniqueid, d.uniqueid) = $1 OR d.first_uniqueid = $1
     ORDER BY d.deal_created_at DESC LIMIT 20`, [uniqueid])).rows;
  if (!deals.length) return null;
  const r = (await db.query<{ calldate: Date; billsec: number; manager_name: string | null; stt_status: string | null; stt_failure: string | null;
    segments: Turn[] | null; purged: Date | null; llm_status: string | null; llm_failure: string | null; result: CarrierResult | null }>(`
    SELECT rc.calldate, rc.billsec, m.name AS manager_name, t.status AS stt_status, t.failure AS stt_failure, t.segments,
           t.text_purged_at AS purged, a.status AS llm_status, a.failure AS llm_failure, a.result
      FROM ringostat_calls rc
      LEFT JOIN managers m ON m.id = rc.manager_id
      LEFT JOIN call_transcripts t ON t.uniqueid = rc.uniqueid AND t.provider = $2 AND t.model = $3
      ${CARRIER_ANALYSIS_LATERAL("t", "$4")}
     WHERE rc.uniqueid = $1`, [uniqueid, STT_PROVIDER, ELEVENLABS_STT_MODEL, [...CARRIER_RUBRICS]])).rows[0];
  if (!r) return null;
  const state = aiCallState(r.stt_status, r.llm_status);
  const result = state === "done" ? r.result : null;
  const own = deals.find((d) => d.uniqueid === uniqueid);
  const first = own && own.first_uniqueid && own.first_uniqueid !== uniqueid ? own.first_uniqueid : null;
  const firstRole = first ? (await db.query<{ role: string | null }>(`
    SELECT a.result->>'caller_role' AS role FROM call_transcripts t JOIN call_analyses a ON a.transcript_id = t.id
     WHERE t.uniqueid = $1 AND a.rubric_version = ANY($2::text[]) AND a.status = 'done' ORDER BY a.id DESC LIMIT 1`, [first, [...CARRIER_RUBRICS]])).rows[0]?.role ?? null : null;
  const mc = result?.manager_channel;
  return {
    uniqueid, calledAt: new Date(r.calldate).toISOString(), billsec: Number(r.billsec), managerName: r.manager_name,
    deals: deals.filter((d) => d.uniqueid === uniqueid).map((d) => ({ kommoId: Number(d.kommo_id), reused: d.state === "reused", close: closeStateOf(d) })),
    talkNo: own ? Number(own.talk_no) : 1,
    firstTry: first ? { uniqueid: first, role: firstRole } : null,
    state, failure: r.llm_failure ?? r.stt_failure, result, bucket: result ? carrierBucket(result) : null,
    turns: canSeeTranscript && r.segments ? r.segments : null,
    transcriptHidden: !canSeeTranscript,
    textPurged: r.purged != null,
    managerChannel: mc === "0" ? 0 : mc === "1" ? 1 : null,
  };
}

export interface CarrierCallsMeta {
  job: { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } | null;
  /** Черга лише дзвінків мобільних: чужих рядків тут немає. */
  transcripts: Record<string, number>;
  analyses: Record<string, number>;
  spend: { carrier: number; stt: number; analysis: number };
  caps: { carrier: number; stt: number | null; analysis: number | null };
  /** Режими закриття в Kommo і скільки чого в журналі (`other*` — «Інше», окремий перемикач для AI). */
  close: { mode: string; otherMode: string; wouldClose: number; closed: number; reverted: number; failed: number; otherWouldClose: number; otherClosed: number };
  /**
   * AI проти людини: скільки разів людина погодилась із вердиктом AI і скільки — ні, по вердикту AI. Зовнішня
   * звірка (правило 2 кореня): людина слухала запис, а не читала вердикт. Для тесту точності перед автозакриттям.
   */
  agreement: { aiRole: string; decisions: number; agreed: number; byDecision: Record<string, number> }[];
}

export async function carrierCallsMeta(db: Db, now: Date, caps: { stt: number | null; analysis: number | null },
  modes: { mode: string; otherMode: string }): Promise<CarrierCallsMeta> {
  const j = (await db.query<{ last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
    "SELECT last_success_at, last_error, last_error_at FROM job_runs WHERE name = 'carrierCallJob'")).rows[0];
  const count = async (sql: string) => Object.fromEntries((await db.query<{ status: string; n: number }>(sql, [[...CARRIER_RUBRICS]])).rows
    .map((x) => [x.status, Number(x.n)]));
  const mine = "SELECT DISTINCT uniqueid FROM carrier_call_deals WHERE state = 'own'";
  const c = (await db.query<{ w: number; c: number; r: number; f: number; ow: number; oc: number }>(`
    SELECT count(*) FILTER (WHERE closed_at IS NULL AND close_error IS NULL AND reason = 'carrier')::int AS w,
           count(*) FILTER (WHERE closed_at IS NOT NULL AND reverted_at IS NULL AND reason = 'carrier')::int AS c,
           count(*) FILTER (WHERE reverted_at IS NOT NULL)::int AS r,
           count(*) FILTER (WHERE closed_at IS NULL AND close_error IS NOT NULL)::int AS f,
           count(*) FILTER (WHERE closed_at IS NULL AND close_error IS NULL AND reason = 'other')::int AS ow,
           count(*) FILTER (WHERE closed_at IS NOT NULL AND reverted_at IS NULL AND reason = 'other')::int AS oc
      FROM carrier_close_log`)).rows[0];
  // Останнє рішення людини по угоді проти того, що AI казав У МОМЕНТ рішення (`ai_role`); без вердикту AI — не рахуємо.
  const agr = (await db.query<{ ai_role: string; decision: string; n: number }>(`
    SELECT ai_role, decision, count(*)::int AS n FROM (
      SELECT DISTINCT ON (kommo_id) ai_role, decision FROM carrier_decisions ORDER BY kommo_id, id DESC) x
     WHERE ai_role IS NOT NULL GROUP BY 1, 2`)).rows;
  const agreement = new Map<string, CarrierCallsMeta["agreement"][number]>();
  for (const x of agr) {
    const a = agreement.get(x.ai_role) ?? { aiRole: x.ai_role, decisions: 0, agreed: 0, byDecision: {} };
    a.decisions += Number(x.n);
    if (x.decision === x.ai_role) a.agreed += Number(x.n);
    a.byDecision[x.decision] = (a.byDecision[x.decision] ?? 0) + Number(x.n);
    agreement.set(x.ai_role, a);
  }
  return {
    job: j ? {
      lastSuccessAt: j.last_success_at ? new Date(j.last_success_at).toISOString() : null,
      lastError: j.last_error, lastErrorAt: j.last_error_at ? new Date(j.last_error_at).toISOString() : null,
    } : null,
    transcripts: await count(`SELECT t.status, count(*)::int AS n FROM call_transcripts t WHERE t.uniqueid IN (${mine}) AND $1::text[] IS NOT NULL GROUP BY t.status`),
    analyses: await count(`SELECT a.status, count(*)::int AS n FROM call_analyses a JOIN call_transcripts t ON t.id = a.transcript_id
      WHERE a.rubric_version = ANY($1::text[]) AND t.uniqueid IN (${mine}) GROUP BY a.status`),
    spend: {
      carrier: (await monthSpendByOp(db, CARRIER_BUDGET.opPrefix, now)).usd,
      stt: (await monthSpend(db, STT_PROVIDER, now)).usd,
      analysis: (await monthSpend(db, LLM_PROVIDER, now)).usd,
    },
    caps: { carrier: CARRIER_BUDGET.monthCapUsd, ...caps },
    close: { mode: modes.mode, otherMode: modes.otherMode, wouldClose: Number(c?.w ?? 0), closed: Number(c?.c ?? 0),
      reverted: Number(c?.r ?? 0), failed: Number(c?.f ?? 0), otherWouldClose: Number(c?.ow ?? 0), otherClosed: Number(c?.oc ?? 0) },
    agreement: [...agreement.values()].sort((a, b) => b.decisions - a.decisions),
  };
}
