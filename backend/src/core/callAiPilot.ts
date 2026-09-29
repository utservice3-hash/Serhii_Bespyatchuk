import type { Db } from "./adCallFacts.js";
import { AD_FLAGS, adDealFirstTalksSql, ParamNotSetError, type AdFlag, type FirstTalkRow } from "./adCallFactsRules.js";
import { createMinInterval, type HttpDeps, type RetryPolicy } from "./callAiHttp.js";
import { downloadRecording } from "./ringostatRecording.js";
import { ELEVENLABS_STT_MODEL, elevenLabsTranscribe, GEMINI_MODEL, geminiGenerate, RUBRIC_CURRENT } from "./callAiProviders.js";
import { enqueueAnalyses, enqueueTranscripts, monthSpend, runAnalysisPortion, runSttPortion, type PortionReport } from "./callAiPipeline.js";

/**
 * 🧪 ПІЛОТ AI-АНАЛІЗУ: 30 перших розмов по рекламних угодах — вибірка, кошторис, прогін.
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах», прохід A, коміт ③. Логіка тут, CLI — у
 * `tools/callAiPilot.ts`: CLI тягне пул, а пул кидає без `DATABASE_URL` ще на імпорті.
 *
 * 🔴 ДВА РЕЖИМИ, І ЗА ЗАМОВЧУВАННЯМ — СУХИЙ. Без `--go` пілот лише ЧИТАЄ базу (вибірка тим самим
 * правилом звʼязки, що факти) і пише план у файл: жодного запиту назовні, жодного запису в базу.
 * З `--go` — ставить у чергу й проганяє порції; ключі беруться з env, ціни й стелі — лише з
 * командного рядка, без значень за замовчуванням.
 *
 * ⚠️ ХОСТ УБИВАЄ ДРУГИЙ NODE-ПРОЦЕС ЗА 1–2 ХВ. Прогін `--go` на сервері обірветься посеред
 * порції — і це штатно: кожен дзвінок узято в роботу ДО оплати, тож повторний запуск тієї самої
 * команди продовжує з місця обриву й не платить удруге за `done`. Рядок, який обрив застав у
 * роботі, повернеться в чергу через `STUCK_AFTER_MIN`.
 *
 * ⚖️ ВІДКРИТІ ПИТАННЯ ВЛАСНИКА — ОБОВʼЯЗКОВІ АРГУМЕНТИ: поріг розмови, вікно до створення угоди,
 * який рекламний прапорець. Не названо → `ParamNotSetError`, а не «20 с, як у замірі».
 */

/** Операційні параметри пілота. Не бізнес-правила: вони лише ділять роботу на шматки. */
export const PILOT_PORTION = 5;
export const PILOT_MAX_ATTEMPTS = 3;
/** Більше за найдовший виклик із повторами (розпізнавання: 180 с × 3 спроби + паузи ≈ 10 хв). */
export const STUCK_AFTER_MIN = 15;
/** Межа проходів у одному запуску — страховка від вічного циклу, а не вимога. */
const MAX_LOOPS = 200;

export const RINGOSTAT_POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 2_000, maxDelayMs: 30_000, timeoutMs: 60_000 };
/** Ringostat віддає 429 на частих запитах: записи тягнемо по одному з цією паузою. */
export const RINGOSTAT_MIN_INTERVAL_MS = 1_500;
/** 1 год стерео 8 кГц 16 біт ≈ 115 МБ; межа multichannel — 1 год. */
export const RECORDING_MAX_BYTES = 128 * 1024 * 1024;
export const STT_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 5_000, maxDelayMs: 60_000, timeoutMs: 180_000 };
export const LLM_POLICY: RetryPolicy = { maxRetries: 2, baseDelayMs: 5_000, maxDelayMs: 60_000, timeoutMs: 120_000 };

export const STT_PROVIDER = "elevenlabs";
export const LLM_PROVIDER = "google";

export interface PilotArgs {
  from: string;
  to: string;
  limit: number;
  talkMinSec: number;
  windowBefore: string;
  flag: AdFlag;
  go: boolean;
  out: string;
  sttUsdPerHour: number | null;
  sttCapUsd: number | null;
  llmUsdPerMtokIn: number | null;
  llmUsdPerMtokOut: number | null;
  llmCapUsd: number | null;
  maxOutputTokens: number | null;
}

const KNOWN = new Set(["from", "to", "limit", "talk-min-sec", "window-before", "flag", "go", "out",
  "stt-usd-per-hour", "stt-cap-usd", "llm-usd-per-mtok-in", "llm-usd-per-mtok-out", "llm-cap-usd", "max-output-tokens"]);

const optNum = (v: string | undefined): number | null => (v == null || v === "" ? null : Number(v));

/**
 * Розбір аргументів. Невідомий прапорець — помилка: друкарська помилка в `--stt-cap-usd`
 * інакше тихо лишила б стелю незаданою, а з нею — закритий прогін без пояснення.
 */
export function parsePilotArgs(argv: readonly string[], defaultOut: (from: string, to: string) => string): PilotArgs {
  const m = new Map<string, string>();
  for (const a of argv) {
    const x = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!x) throw new Error(`незрозумілий аргумент: ${a}`);
    if (!KNOWN.has(x[1])) throw new Error(`невідомий прапорець --${x[1]}`);
    m.set(x[1], x[2] ?? "true");
  }
  const from = m.get("from") ?? "", to = m.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("потрібні --from=YYYY-MM-DD і --to=YYYY-MM-DD");
  const limit = Number(m.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("потрібен --limit=1..100");
  const talk = m.get("talk-min-sec");
  if (talk == null || !Number.isInteger(Number(talk)) || Number(talk) < 1) throw new ParamNotSetError("--talk-min-sec (поріг розмови, секунд)");
  const wb = m.get("window-before");
  if (!wb) throw new ParamNotSetError("--window-before (вікно до створення угоди, «N hours» / «N days»)");
  const flag = m.get("flag") as AdFlag | undefined;
  if (!flag || !AD_FLAGS.includes(flag)) throw new ParamNotSetError("--flag (lead_channel / ad_deal_sql / either)");
  const go = m.get("go") === "true";
  const a: PilotArgs = {
    from, to, limit, talkMinSec: Number(talk), windowBefore: wb, flag, go,
    out: m.get("out") || defaultOut(from, to),
    sttUsdPerHour: optNum(m.get("stt-usd-per-hour")),
    sttCapUsd: optNum(m.get("stt-cap-usd")),
    llmUsdPerMtokIn: optNum(m.get("llm-usd-per-mtok-in")),
    llmUsdPerMtokOut: optNum(m.get("llm-usd-per-mtok-out")),
    llmCapUsd: optNum(m.get("llm-cap-usd")),
    maxOutputTokens: optNum(m.get("max-output-tokens")),
  };
  if (go) {
    const need: [keyof PilotArgs, string][] = [["sttUsdPerHour", "--stt-usd-per-hour"], ["sttCapUsd", "--stt-cap-usd"],
      ["llmUsdPerMtokIn", "--llm-usd-per-mtok-in"], ["llmUsdPerMtokOut", "--llm-usd-per-mtok-out"],
      ["llmCapUsd", "--llm-cap-usd"], ["maxOutputTokens", "--max-output-tokens"]];
    for (const [k, flagName] of need) {
      const v = a[k] as number | null;
      if (v == null || !Number.isFinite(v) || v < 0) throw new ParamNotSetError(`${flagName} (для --go обовʼязковий)`);
    }
  }
  return a;
}

export interface PilotPlanRow {
  uniqueid: string;
  kommoId: number;
  calldate: string;
  callType: string;
  billsec: number;
  durationSec: number;
  managerId: number | null;
  hasRecording: boolean;
  isLeadChannelAd: boolean;
  isAdDealSql: boolean;
}

export interface PilotPlan {
  rows: PilotPlanRow[];
  calls: number;
  withRecording: number;
  talkSec: number;
  audioSec: number;
  /** Тривалість дзвінка × 2 канали × ціна — оцінка ДО завантаження; точна рахується з WAV. */
  estSttUsd: number | null;
}

export interface AdPredicate {
  predicate: (srcRef: string) => string;
  adSources: string[];
}

/** Вибірка пілота. ЛИШЕ читання: один `WITH … SELECT`. */
export async function planPilot(db: Db, a: PilotArgs, ad: AdPredicate, now: Date): Promise<PilotPlan> {
  const q = adDealFirstTalksSql({ from: a.from, to: a.to, now, talkMinSec: a.talkMinSec, windowBefore: a.windowBefore,
    adDealPredicate: ad.predicate, adSources: ad.adSources }, a.flag, a.limit);
  const rows = (await db.query<FirstTalkRow>(q.sql, q.params)).rows.map((r): PilotPlanRow => ({
    uniqueid: r.uniqueid, kommoId: Number(r.kommo_id), calldate: new Date(r.calldate).toISOString(), callType: r.call_type,
    billsec: Number(r.billsec), durationSec: Number(r.duration), managerId: r.manager_id == null ? null : Number(r.manager_id),
    hasRecording: r.has_recording === true, isLeadChannelAd: r.is_lead_channel_ad === true, isAdDealSql: r.is_ad_deal_sql === true,
  }));
  const audioSec = rows.reduce((s, r) => s + r.durationSec, 0);
  return {
    rows,
    calls: rows.length,
    withRecording: rows.filter((r) => r.hasRecording).length,
    talkSec: rows.reduce((s, r) => s + r.billsec, 0),
    audioSec,
    estSttUsd: a.sttUsdPerHour == null ? null : (audioSec * 2 * a.sttUsdPerHour) / 3600,
  };
}

/** План у JSONL: без номера клієнта й без URL запису — лише ідентифікатори й тривалості. */
export function planToJsonl(plan: PilotPlan): string {
  return plan.rows.map((r) => JSON.stringify(r)).join("\n") + (plan.rows.length ? "\n" : "");
}

export interface PilotEnv {
  db: Db;
  http: HttpDeps;
  keys: { elevenlabs: string; gemini: string };
  now: () => Date;
  log: (line: string) => void;
}

export interface PilotRunSummary {
  stt: PortionReport[];
  analysis: PortionReport[];
  stoppedBy: string | null;
  transcripts: Record<string, number>;
  analyses: Record<string, number>;
  spendUsd: { stt: number; analysis: number };
}

/**
 * Порції до спорожнення черги. Повертає причину зупинки або `null`, якщо черга просто скінчилась.
 * 📐 Порожня черга (`idle`) — це нормальний кінець, а не зупинка: пілот 24.09.2026 друкував
 * «розпізнавання зупинилось: idle», ніби стався збій.
 */
export async function runUntilDrained(run: () => Promise<PortionReport>, into: PortionReport[]): Promise<string | null> {
  for (let i = 0; i < MAX_LOOPS; i++) {
    let r: PortionReport;
    try { r = await run(); } catch (e) { return (e as Error).message; }
    into.push(r);
    if (r.state === "idle" || (r.state === "ok" && r.claimed === 0)) return null;
    if (r.state !== "ok") return r.stoppedBy ?? r.state;
  }
  return `межа ${String(MAX_LOOPS)} проходів — черга не спорожніла`;
}

/** Прогін `--go`: черга → розпізнавання → аналіз. Повторний запуск продовжує, а не дублює. */
export async function runPilot(env: PilotEnv, plan: PilotPlan, a: PilotArgs): Promise<PilotRunSummary> {
  const ids = plan.rows.map((r) => r.uniqueid);
  const throttle = createMinInterval(RINGOSTAT_MIN_INTERVAL_MS, env.http);
  const common = { limit: PILOT_PORTION, maxAttempts: PILOT_MAX_ATTEMPTS, stuckAfterMin: STUCK_AFTER_MIN };
  const out: PilotRunSummary = { stt: [], analysis: [], stoppedBy: null, transcripts: {}, analyses: {}, spendUsd: { stt: 0, analysis: 0 } };

  await enqueueTranscripts(env.db, ids, STT_PROVIDER, ELEVENLABS_STT_MODEL, env.now());
  const sttStop = await runUntilDrained(() => runSttPortion(env.db, {
    apiKey: env.keys.elevenlabs,
    download: async (url) => { await throttle(); return downloadRecording(env.http, url, { ...RINGOSTAT_POLICY, maxBytes: RECORDING_MAX_BYTES }); },
    transcribe: (key, audio) => elevenLabsTranscribe(env.http, key, audio, STT_POLICY),
  }, {
    ...common, now: env.now(), operation: "pilot_stt", provider: STT_PROVIDER, model: ELEVENLABS_STT_MODEL,
    monthCapUsd: a.sttCapUsd, usdPerAudioSec: a.sttUsdPerHour == null ? null : a.sttUsdPerHour / 3600,
  }), out.stt);
  if (sttStop) env.log(`розпізнавання зупинилось: ${sttStop}`);

  const ap = {
    provider: LLM_PROVIDER, model: GEMINI_MODEL, rubricVersion: RUBRIC_CURRENT,
    sttProvider: STT_PROVIDER, sttModel: ELEVENLABS_STT_MODEL,
  };
  await enqueueAnalyses(env.db, { ...ap, now: env.now() }, ids);
  const llmStop = await runUntilDrained(() => runAnalysisPortion(env.db, {
    apiKey: env.keys.gemini,
    generate: (key, model, body) => geminiGenerate(env.http, key, model, body, LLM_POLICY),
  }, {
    ...common, ...ap, now: env.now(), operation: "pilot_analysis", monthCapUsd: a.llmCapUsd,
    maxOutputTokens: a.maxOutputTokens ?? 0,
    usdPerInputToken: a.llmUsdPerMtokIn == null ? null : a.llmUsdPerMtokIn / 1e6,
    usdPerOutputToken: a.llmUsdPerMtokOut == null ? null : a.llmUsdPerMtokOut / 1e6,
  }), out.analysis);
  if (llmStop) env.log(`аналіз зупинився: ${llmStop}`);
  out.stoppedBy = sttStop ?? llmStop;

  const t = await env.db.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM call_transcripts WHERE provider = $1 AND model = $2 AND uniqueid = ANY($3::text[]) GROUP BY status`,
    [STT_PROVIDER, ELEVENLABS_STT_MODEL, ids]);
  for (const x of t.rows) out.transcripts[x.status] = Number(x.n);
  const an = await env.db.query<{ status: string; n: number }>(
    `SELECT a.status, count(*)::int AS n FROM call_analyses a JOIN call_transcripts t ON t.id = a.transcript_id
      WHERE a.provider = $1 AND a.model = $2 AND a.rubric_version = $3 AND t.uniqueid = ANY($4::text[]) GROUP BY a.status`,
    [LLM_PROVIDER, GEMINI_MODEL, RUBRIC_CURRENT, ids]);
  for (const x of an.rows) out.analyses[x.status] = Number(x.n);
  out.spendUsd = {
    stt: (await monthSpend(env.db, STT_PROVIDER, env.now())).usd,
    analysis: (await monthSpend(env.db, LLM_PROVIDER, env.now())).usd,
  };
  return out;
}
