import type { Db } from "./adCallFacts.js";
import type { HttpDeps } from "./callAiHttp.js";
import { createMinInterval } from "./callAiHttp.js";
import { downloadRecording } from "./ringostatRecording.js";
import { ELEVENLABS_STT_MODEL, elevenLabsTranscribe, GEMINI_MODEL, geminiGenerate } from "./callAiProviders.js";
import { enqueueAnalyses, enqueueTranscripts, runAnalysisPortion, runSttPortion } from "./callAiPipeline.js";
import { LLM_POLICY, LLM_PROVIDER, RECORDING_MAX_BYTES, RINGOSTAT_MIN_INTERVAL_MS, RINGOSTAT_POLICY, runUntilDrained,
  STT_POLICY, STT_PROVIDER, STUCK_AFTER_MIN } from "./callAiPilot.js";
import { MAX_OUTPUT_TOKENS, TICK_MAX_ATTEMPTS, type TickPrices } from "./callAiTick.js";
import { CARRIER_BUDGET, CARRIER_KIT, CARRIER_OPS, CARRIER_RULE, CARRIER_THRESHOLD, carrierBucket,
  RUBRIC_CARRIER_V1, type CarrierBucket, type CarrierResult } from "./carrierCallRules.js";

/**
 * 🧪 ПІЛОТ ЯКОСТІ «ПЕРЕВІЗНИКІВ ЗА РОЗМОВОЮ» (ТЗ, крок 3) — ДО показу керівництву.
 *
 * Дві відомі групи: 50 угод, які фільтр CRM закрив як «Перевізник», і 50 справжніх клієнтів із «Перевозок»
 * (етапи від «Взято на прорахунок»). Слухаємо першу розмову ≥10 с кожної й дивимось на ДВІ цифри:
 * скільки клієнтів названо перевізником упевнено (має бути 0) і скільки перевізників знайдено.
 * Прибрані фільтром угоди тут — ЛИШЕ як еталон відомих перевізників; у робочу вибірку вони не йдуть.
 * Результат пишеться в ті самі таблиці з мітками `carrier_pilot_*`, а екран їх не бачить: у
 * `carrier_call_deals` пілотних угод немає.
 */
export const PILOT_GROUPS = {
  carrier: { pipelineId: 8921928, statusId: 143, rejectReason: "Перевізник", from: "2026-09-13" },
  client: { pipelineId: 8921932, from: "2026-09-02",
    statuses: [69693668, 69693672, 69716252, 69693676, 69716256, 69716260, 100274340, 69716300,
      98470988, 69716304, 69716312, 69716460, 142] },
} as const;

export interface PilotPick { group: "carrier" | "client"; kommo_id: string; uniqueid: string; billsec: number }

/**
 * Відбір: перша розмова ≥10 с із записом у вікні ±1 доба від створення угоди, номер — з назви угоди (як Ringostat)
 * або з контакту. Вибірка детермінована (`md5`), щоб повторний прогін брав ті самі угоди й не платив удруге.
 */
export async function planCarrierPilot(db: Db, perGroup: number): Promise<PilotPick[]> {
  const g = PILOT_GROUPS;
  const r = await db.query<PilotPick>(
    `WITH src AS (
       SELECT 'carrier'::text AS grp, d.kommo_id, d.created_at_kommo, d.name, d.client_key FROM deals d
        WHERE d.pipeline_id = $1 AND d.status_id = $2 AND d.reject_reason = $3
          AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $4::date
       UNION ALL
       SELECT 'client', d.kommo_id, d.created_at_kommo, d.name, d.client_key FROM deals d
        WHERE d.pipeline_id = $5 AND d.status_id = ANY($6::bigint[])
          AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $7::date),
     ph AS (SELECT grp, kommo_id, created_at_kommo,
                   CASE WHEN name ~ '^380[0-9]{9}$' THEN name WHEN client_key IS NOT NULL THEN '38' || client_key END AS phone
              FROM src),
     talk AS (SELECT ph.grp, ph.kommo_id, t.uniqueid, t.billsec FROM ph CROSS JOIN LATERAL (
                SELECT rc.uniqueid, rc.billsec FROM ringostat_calls rc
                 WHERE rc.client_phone = ph.phone AND rc.billsec >= $8 AND rc.recording IS NOT NULL
                   AND rc.calldate BETWEEN ph.created_at_kommo - interval '1 day' AND ph.created_at_kommo + interval '1 day'
                 ORDER BY rc.calldate, rc.uniqueid LIMIT 1) t
             WHERE ph.phone IS NOT NULL),
     uniq AS (SELECT DISTINCT ON (uniqueid) grp, kommo_id, uniqueid, billsec FROM talk ORDER BY uniqueid, grp),
     ranked AS (SELECT *, row_number() OVER (PARTITION BY grp ORDER BY md5(kommo_id::text)) AS rn FROM uniq)
     SELECT grp AS "group", kommo_id::text, uniqueid, billsec FROM ranked WHERE rn <= $9 ORDER BY grp, rn`,
    [g.carrier.pipelineId, g.carrier.statusId, g.carrier.rejectReason, g.carrier.from,
      g.client.pipelineId, [...g.client.statuses], g.client.from, CARRIER_RULE.talkMinSec, perGroup]);
  return r.rows.map((x) => ({ ...x, billsec: Number(x.billsec) }));
}

export interface PilotEnv {
  db: Db;
  http: HttpDeps;
  keys: { elevenlabs: string; gemini: string };
  prices: TickPrices;
  now: () => Date;
}

export async function runCarrierPilot(env: PilotEnv, picks: readonly PilotPick[]): Promise<{ sttStoppedBy: string | null; llmStoppedBy: string | null }> {
  const ids = picks.map((p) => p.uniqueid);
  if (!ids.length) return { sttStoppedBy: null, llmStoppedBy: null };
  await enqueueTranscripts(env.db, ids, STT_PROVIDER, ELEVENLABS_STT_MODEL, env.now());
  const throttle = createMinInterval(RINGOSTAT_MIN_INTERVAL_MS, env.http);
  const common = { limit: 5, maxAttempts: TICK_MAX_ATTEMPTS, stuckAfterMin: STUCK_AFTER_MIN, calls: { only: ids },
    subCap: { usd: CARRIER_BUDGET.monthCapUsd, opPrefix: CARRIER_BUDGET.opPrefix, label: CARRIER_BUDGET.label } };
  const sttStoppedBy = await runUntilDrained(() => runSttPortion(env.db, {
    apiKey: env.keys.elevenlabs,
    download: async (url) => { await throttle(); return downloadRecording(env.http, url, { ...RINGOSTAT_POLICY, maxBytes: RECORDING_MAX_BYTES }); },
    transcribe: (key, audio) => elevenLabsTranscribe(env.http, key, audio, STT_POLICY),
  }, {
    ...common, now: env.now(), operation: CARRIER_OPS.pilotStt, provider: STT_PROVIDER, model: ELEVENLABS_STT_MODEL,
    monthCapUsd: env.prices.sttMonthCapUsd,
    usdPerAudioSec: env.prices.sttUsdPerHour == null ? null : env.prices.sttUsdPerHour / 3600,
  }), []);
  const ap = { provider: LLM_PROVIDER, model: GEMINI_MODEL, rubricVersion: RUBRIC_CARRIER_V1,
    sttProvider: STT_PROVIDER, sttModel: ELEVENLABS_STT_MODEL };
  await enqueueAnalyses(env.db, { ...ap, now: env.now() }, ids);
  const llmStoppedBy = await runUntilDrained(() => runAnalysisPortion(env.db, {
    apiKey: env.keys.gemini,
    generate: (key, model, body) => geminiGenerate(env.http, key, model, body, LLM_POLICY),
    kit: CARRIER_KIT,
  }, {
    ...common, ...ap, now: env.now(), operation: CARRIER_OPS.pilotAnalysis, monthCapUsd: env.prices.llmMonthCapUsd,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    usdPerInputToken: env.prices.llmUsdPerMtokIn == null ? null : env.prices.llmUsdPerMtokIn / 1e6,
    usdPerOutputToken: env.prices.llmUsdPerMtokOut == null ? null : env.prices.llmUsdPerMtokOut / 1e6,
  }), []);
  return { sttStoppedBy, llmStoppedBy };
}

export interface PilotRow { group: "carrier" | "client"; kommo_id: string; bucket: CarrierBucket | "not_analysed"; role: string | null;
  confidence: number | null; quote_check: string | null; quote: string | null }

export interface PilotVerdict {
  /** Клієнтів, названих перевізником упевнено (поріг + цитата співрозмовника). ТЗ: має бути 0. */
  clientsAsCarrier: number;
  carriersFound: number;
  carriers: number;
  clients: number;
  notAnalysed: number;
  threshold: number;
  rows: PilotRow[];
}

/** Звіт пілоту. Без номерів телефонів: угода, кошик, впевненість і цитата — для розбору людиною. */
export async function pilotVerdict(db: Db, picks: readonly PilotPick[]): Promise<PilotVerdict> {
  const r = await db.query<{ uniqueid: string; result: CarrierResult | null }>(
    `SELECT t.uniqueid, a.result FROM call_transcripts t
       JOIN call_analyses a ON a.transcript_id = t.id AND a.rubric_version = $2 AND a.status = 'done'
      WHERE t.uniqueid = ANY($1::text[])`, [picks.map((p) => p.uniqueid), RUBRIC_CARRIER_V1]);
  const byId = new Map(r.rows.map((x) => [x.uniqueid, x.result]));
  const rows: PilotRow[] = picks.map((p) => {
    const res = byId.get(p.uniqueid) ?? null;
    return { group: p.group, kommo_id: p.kommo_id, bucket: res ? carrierBucket(res) : "not_analysed", role: res?.caller_role ?? null,
      confidence: res?.caller_role_confidence ?? null, quote_check: res?.quote_check ?? null, quote: res?.caller_role_quote ?? null };
  });
  return {
    clientsAsCarrier: rows.filter((x) => x.group === "client" && x.bucket === "carrier").length,
    carriersFound: rows.filter((x) => x.group === "carrier" && x.bucket === "carrier").length,
    carriers: rows.filter((x) => x.group === "carrier").length,
    clients: rows.filter((x) => x.group === "client").length,
    notAnalysed: rows.filter((x) => x.bucket === "not_analysed").length,
    threshold: CARRIER_THRESHOLD,
    rows,
  };
}
