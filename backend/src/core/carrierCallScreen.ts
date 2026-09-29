import type { Db } from "./adCallFacts.js";
import { ELEVENLABS_STT_MODEL, GEMINI_MODEL, type Turn } from "./callAiProviders.js";
import { LLM_PROVIDER, STT_PROVIDER } from "./callAiPilot.js";
import { monthSpend, monthSpendByOp } from "./callAiPipeline.js";
import { aiCallState, type AiCallState } from "./callAiScreen.js";
import { CARRIER_BUDGET, CARRIER_STAGE, carrierBucket, RUBRIC_CARRIER_V1, type CarrierBucket,
  type CarrierResult } from "./carrierCallRules.js";

/**
 * 🚚 ЕКРАН «ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ» (прохід 2, макет — https://claude.ai/artifact/6nbQB8nHDP2WTaZLUWf6p3).
 * Лише перегляд; у Kommo нічого не пишемо. Правила — `carrierCallRules.ts`, METRICS_GLOSSARY §16.
 *
 * Рядок — ДЗВІНОК, а не угода: номер, що дзвонив кілька разів, слухаємо один раз (вердикт на номер 30 днів),
 * тож усі його угоди з'являються в одному рядку. Угоди без розмови (чекають або пропущені) у списку не
 * показуються (рішення Романа), але їх ЧИСЛО — у шапці: невідоме має бути видимим (frontend.md).
 */

export const SCREEN_LIMIT = 5000;

export interface CarrierCallRow {
  uniqueid: string;
  calledAt: string;
  direction: "in" | "out";
  billsec: number;
  managerName: string | null;
  deals: { kommoId: number; statusId: number | null; rejectReason: string | null; reused: boolean }[];
  talkNo: number;
  state: AiCallState;
  failure: string | null;
  bucket: CarrierBucket | null;
  role: string | null;
  confidence: number | null;
  quote: string | null;
  quoteCheck: string | null;
  summary: string | null;
}

export interface CarrierKpis {
  /** Угоди етапу (назва-номер), які фільтр CRM закрив як «Перевізник». Джерело — `deals`, синк раз на 30 хв. */
  removedByFilter: number;
  /** Угоди, які ми побачили на етапі ПІСЛЯ фільтра (`carrier_call_deals`), — усі, з розмовою чи без. */
  leftAfterFilter: number;
  waitingTalk: number;
  noTalk: number;
  /** Номерів із готовим вердиктом. */
  listenedPhones: number;
  /** З якого моменту ведеться облік «після фільтра»: раніше цієї дати число не відтворюється (правило 17). */
  recordingSince: string | null;
}

interface RawRow {
  kommo_id: string; deal_state: string; talk_no: number; uniqueid: string; calldate: Date; call_type: string; billsec: number;
  manager_name: string | null; deal_status: string | null; reject_reason: string | null;
  stt_status: string | null; stt_failure: string | null; llm_status: string | null; llm_failure: string | null;
  result: CarrierResult | null;
}

const IN_TYPES = new Set(["in", "transitin"]);

export async function carrierCallsList(db: Db, from: string, to: string): Promise<{ rows: CarrierCallRow[]; kpis: CarrierKpis; truncated: boolean }> {
  const r = await db.query<RawRow>(`
    WITH d AS (
      SELECT d.kommo_id, d.state, d.talk_no,
             CASE WHEN d.state = 'own' THEN d.uniqueid ELSE src.uniqueid END AS u,
             CASE WHEN d.state = 'own' THEN d.talk_no ELSE src.talk_no END AS src_talk_no
        FROM carrier_call_deals d
        LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
       WHERE d.state IN ('own', 'reused')
         AND (d.deal_created_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date)
    SELECT d.kommo_id::text, d.state AS deal_state, d.src_talk_no AS talk_no, d.u AS uniqueid,
           rc.calldate, rc.call_type, rc.billsec, m.name AS manager_name,
           dd.status_id::text AS deal_status, dd.reject_reason,
           t.status AS stt_status, t.failure AS stt_failure, a.status AS llm_status, a.failure AS llm_failure, a.result
      FROM d
      JOIN ringostat_calls rc ON rc.uniqueid = d.u
      LEFT JOIN managers m ON m.id = rc.manager_id
      LEFT JOIN deals dd ON dd.kommo_id = d.kommo_id
      LEFT JOIN call_transcripts t ON t.uniqueid = d.u AND t.provider = $3 AND t.model = $4
      LEFT JOIN call_analyses a ON a.transcript_id = t.id AND a.provider = $5 AND a.model = $6 AND a.rubric_version = $7
     ORDER BY rc.calldate DESC, d.kommo_id
     LIMIT $8`,
  [from, to, STT_PROVIDER, ELEVENLABS_STT_MODEL, LLM_PROVIDER, GEMINI_MODEL, RUBRIC_CARRIER_V1, SCREEN_LIMIT + 1]);
  const truncated = r.rows.length > SCREEN_LIMIT;
  const byCall = new Map<string, CarrierCallRow>();
  for (const x of r.rows.slice(0, SCREEN_LIMIT)) {
    const deal = { kommoId: Number(x.kommo_id), statusId: x.deal_status == null ? null : Number(x.deal_status),
      rejectReason: x.reject_reason, reused: x.deal_state === "reused" };
    const hit = byCall.get(x.uniqueid);
    if (hit) { hit.deals.push(deal); continue; }
    const state = aiCallState(x.stt_status, x.llm_status);
    const res = state === "done" ? x.result : null;
    byCall.set(x.uniqueid, {
      uniqueid: x.uniqueid, calledAt: new Date(x.calldate).toISOString(), direction: IN_TYPES.has(x.call_type) ? "in" : "out",
      billsec: Number(x.billsec), managerName: x.manager_name, deals: [deal], talkNo: Number(x.talk_no), state,
      failure: x.llm_failure ?? x.stt_failure,
      bucket: res ? carrierBucket(res) : null, role: res?.caller_role ?? null, confidence: res?.caller_role_confidence ?? null,
      quote: res?.caller_role_quote || null, quoteCheck: res?.quote_check ?? null, summary: res?.summary ?? null,
    });
  }
  const k = (await db.query<{ removed: number; left_after: number; waiting: number; no_talk: number; listened: number; since: Date | null }>(`
    SELECT
      (SELECT count(*) FROM deals WHERE pipeline_id = $3 AND status_id = 143 AND reject_reason = 'Перевізник'
          AND name ~ '^380[0-9]{9}$' AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date)::int AS removed,
      count(*)::int AS left_after,
      count(*) FILTER (WHERE d.state = 'waiting')::int AS waiting,
      count(*) FILTER (WHERE d.state = 'no_talk')::int AS no_talk,
      (SELECT count(DISTINCT x.phone) FROM carrier_call_deals x
         JOIN call_transcripts t ON t.uniqueid = x.uniqueid AND t.provider = $4 AND t.model = $5
         JOIN call_analyses a ON a.transcript_id = t.id AND a.rubric_version = $6 AND a.status = 'done'
        WHERE x.state = 'own' AND (x.deal_created_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date)::int AS listened,
      (SELECT min(seen_at) FROM carrier_call_deals) AS since
      FROM carrier_call_deals d
     WHERE (d.deal_created_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date`,
  [from, to, CARRIER_STAGE.pipelineId, STT_PROVIDER, ELEVENLABS_STT_MODEL, RUBRIC_CARRIER_V1])).rows[0];
  return {
    rows: [...byCall.values()],
    truncated,
    kpis: {
      removedByFilter: Number(k?.removed ?? 0), leftAfterFilter: Number(k?.left_after ?? 0),
      waitingTalk: Number(k?.waiting ?? 0), noTalk: Number(k?.no_talk ?? 0), listenedPhones: Number(k?.listened ?? 0),
      recordingSince: k?.since ? new Date(k.since).toISOString() : null,
    },
  };
}

export interface CarrierCallCard {
  uniqueid: string;
  calledAt: string;
  billsec: number;
  managerName: string | null;
  deals: { kommoId: number; reused: boolean }[];
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
  const deals = (await db.query<{ kommo_id: string; state: string; talk_no: number; uniqueid: string | null; first_uniqueid: string | null }>(`
    SELECT d.kommo_id::text, d.state, COALESCE(src.talk_no, d.talk_no) AS talk_no,
           COALESCE(src.uniqueid, d.uniqueid) AS uniqueid, COALESCE(src.first_uniqueid, d.first_uniqueid) AS first_uniqueid
      FROM carrier_call_deals d LEFT JOIN carrier_call_deals src ON src.kommo_id = d.reused_from
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
      LEFT JOIN call_analyses a ON a.transcript_id = t.id AND a.provider = $4 AND a.model = $5 AND a.rubric_version = $6
     WHERE rc.uniqueid = $1`, [uniqueid, STT_PROVIDER, ELEVENLABS_STT_MODEL, LLM_PROVIDER, GEMINI_MODEL, RUBRIC_CARRIER_V1])).rows[0];
  if (!r) return null;
  const state = aiCallState(r.stt_status, r.llm_status);
  const result = state === "done" ? r.result : null;
  const own = deals.find((d) => d.uniqueid === uniqueid);
  const first = own && own.first_uniqueid && own.first_uniqueid !== uniqueid ? own.first_uniqueid : null;
  const firstRole = first ? (await db.query<{ role: string | null }>(`
    SELECT a.result->>'caller_role' AS role FROM call_transcripts t JOIN call_analyses a ON a.transcript_id = t.id
     WHERE t.uniqueid = $1 AND a.rubric_version = $2 AND a.status = 'done' ORDER BY a.id DESC LIMIT 1`, [first, RUBRIC_CARRIER_V1])).rows[0]?.role ?? null : null;
  const mc = result?.manager_channel;
  return {
    uniqueid, calledAt: new Date(r.calldate).toISOString(), billsec: Number(r.billsec), managerName: r.manager_name,
    deals: deals.filter((d) => d.uniqueid === uniqueid).map((d) => ({ kommoId: Number(d.kommo_id), reused: d.state === "reused" })),
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
}

export async function carrierCallsMeta(db: Db, now: Date, caps: { stt: number | null; analysis: number | null }): Promise<CarrierCallsMeta> {
  const j = (await db.query<{ last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
    "SELECT last_success_at, last_error, last_error_at FROM job_runs WHERE name = 'carrierCallJob'")).rows[0];
  const count = async (sql: string) => Object.fromEntries((await db.query<{ status: string; n: number }>(sql, [RUBRIC_CARRIER_V1])).rows
    .map((x) => [x.status, Number(x.n)]));
  const mine = "SELECT DISTINCT uniqueid FROM carrier_call_deals WHERE state = 'own'";
  return {
    job: j ? {
      lastSuccessAt: j.last_success_at ? new Date(j.last_success_at).toISOString() : null,
      lastError: j.last_error, lastErrorAt: j.last_error_at ? new Date(j.last_error_at).toISOString() : null,
    } : null,
    transcripts: await count(`SELECT t.status, count(*)::int AS n FROM call_transcripts t WHERE t.uniqueid IN (${mine}) AND $1::text IS NOT NULL GROUP BY t.status`),
    analyses: await count(`SELECT a.status, count(*)::int AS n FROM call_analyses a JOIN call_transcripts t ON t.id = a.transcript_id
      WHERE a.rubric_version = $1 AND t.uniqueid IN (${mine}) GROUP BY a.status`),
    spend: {
      carrier: (await monthSpendByOp(db, CARRIER_BUDGET.opPrefix, now)).usd,
      stt: (await monthSpend(db, STT_PROVIDER, now)).usd,
      analysis: (await monthSpend(db, LLM_PROVIDER, now)).usd,
    },
    caps: { carrier: CARRIER_BUDGET.monthCapUsd, ...caps },
  };
}
