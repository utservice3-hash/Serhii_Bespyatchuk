import type { Db } from "./adCallFacts.js";
import type { HttpDeps } from "./callAiHttp.js";
import { createMinInterval } from "./callAiHttp.js";
import { downloadRecording } from "./ringostatRecording.js";
import { ELEVENLABS_STT_MODEL, elevenLabsTranscribe, GEMINI_MODEL, geminiGenerate } from "./callAiProviders.js";
import { enqueueAnalyses, enqueueTranscripts, runAnalysisPortion, runSttPortion, type PortionReport } from "./callAiPipeline.js";
import { LLM_POLICY, LLM_PROVIDER, RECORDING_MAX_BYTES, RINGOSTAT_MIN_INTERVAL_MS, RINGOSTAT_POLICY, STT_POLICY,
  STT_PROVIDER, STUCK_AFTER_MIN } from "./callAiPilot.js";
import { drainWithBudget, MAX_OUTPUT_TOKENS, TICK_MAX_ATTEMPTS, TICK_PORTION, type TickPrices } from "./callAiTick.js";
import { carrierActiveIds } from "./carrierCallQueue.js";
import { notifyCapOnce } from "./aiCapAlert.js";
import { runCarrierClose, type CloseMode, type CloseReport, type KommoCloser } from "./carrierClose.js";
import { syncCarrierReviewTasks, type ReviewTaskStats } from "./carrierReviewTasks.js";
import { carrierHistorySql } from "./carrierHistory.js";
import { CREATING_CALL_SQL, NO_TALK_DUE_SQL, NO_TALK_GUARD, readNoTalkGuard, type NoTalkGate } from "./carrierNoTalkGuard.js";
import { CARRIER_BUDGET, CARRIER_KIT_V2, CARRIER_OPS, CARRIER_RUBRIC, CARRIER_RUBRICS, CARRIER_RULE, oldEnough,
  phoneFromDealName } from "./carrierCallRules.js";

/**
 * 🚚 ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ — база й прохід (правила й рубрика — `carrierCallRules.ts`).
 *
 * `carrier_call_deals` — ЗАПИС ФАКТУ «угода стояла на етапі після фільтра». Етап — це стан «зараз», і завтра
 * угоди там уже не буде; подій входу на етап у нас немає (заміряно: 24 події за весь час). Тож свідчення
 * фіксуємо самі в момент, коли бачимо, — інакше «скільки лишилось після фільтра» за минулий тиждень не
 * відтворити нічим (правило 17 кореня: знімок не має історії).
 *
 * Стани угоди: `waiting` — розмови ≥10 с ще нема, вікно доби відкрите; `own` — слухаємо СВОЮ розмову
 * (`uniqueid`, перша чи друга спроба); `reused` — номер уже слухали за 30 днів, вердикт береться з угоди
 * `reused_from`; `no_talk` — доба минула, розмови ≥10 с не було: номер пропускаємо (рішення Романа).
 */

export interface StageLead { id: number; name: string; created_at: number; responsible_user_id: number | null }

export interface RecordReport { onStage: number; tooYoung: number; noPhone: number; beforeLaunch: number; inserted: number }

/**
 * Записати угоди, що ЗАРАЗ стоять на етапі й старші за поріг. Повтор нічого не дублює. Угоди, створені ДО точки
 * старту (`launchAt`, Роман 30.09.2026: «працюємо з 0»), не записуються — отже й не слухаються.
 */
export async function recordStageDeals(db: Db, leads: readonly StageLead[], now: Date, launchAt: Date | null = null): Promise<RecordReport> {
  const rep: RecordReport = { onStage: leads.length, tooYoung: 0, noPhone: 0, beforeLaunch: 0, inserted: 0 };
  const ids: number[] = [], phones: string[] = [], created: string[] = [], resp: (number | null)[] = [];
  for (const l of leads) {
    if (launchAt && l.created_at * 1000 < launchAt.getTime()) { rep.beforeLaunch++; continue; }
    if (!oldEnough(l.created_at, now)) { rep.tooYoung++; continue; }
    const phone = phoneFromDealName(l.name);
    if (!phone) { rep.noPhone++; continue; }
    ids.push(l.id); phones.push(phone); created.push(new Date(l.created_at * 1000).toISOString()); resp.push(l.responsible_user_id);
  }
  if (!ids.length) return rep;
  const r = await db.query(
    `INSERT INTO carrier_call_deals (kommo_id, phone, deal_created_at, responsible_user_id, seen_at, state, updated_at)
     SELECT i, p, c::timestamptz, u, $5::timestamptz, 'waiting', $5::timestamptz
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[]) AS x(i, p, c, u)
     ON CONFLICT (kommo_id) DO NOTHING`,
    [ids, phones, created, resp, now.toISOString()]);
  rep.inserted = r.rowCount ?? 0;
  return rep;
}

/** Розмова, придатна до слухання: ≥10 с, із записом, у вікні угоди. `$…` — параметри з `talkParams`. */
const TALK = (d: string, extra = "") => `
  SELECT rc.uniqueid FROM ringostat_calls rc
   WHERE rc.client_phone = ${d}.phone AND rc.billsec >= $2 AND rc.recording IS NOT NULL
     AND rc.calldate >= ${d}.deal_created_at - make_interval(mins => $3)
     AND rc.calldate <= ${d}.deal_created_at + make_interval(hours => $4) ${extra}
   ORDER BY rc.calldate, rc.uniqueid LIMIT 1`;
const talkParams = (now: Date) => [now.toISOString(), CARRIER_RULE.talkMinSec, CARRIER_RULE.windowBeforeMin, CARRIER_RULE.windowAfterHours];

/** Вердикт мобільних (будь-якої з рубрик, найсвіжіший) для дзвінка текстом ролі — для «вже розібрали» й «не розібрати». */
const RUBRICS_SQL = CARRIER_RUBRICS.map((r) => `'${r}'`).join(", ");
const ROLE_OF = (u: string) => `(
  SELECT a.result->>'caller_role' FROM call_transcripts t JOIN call_analyses a ON a.transcript_id = t.id
   WHERE t.uniqueid = ${u} AND a.rubric_version IN (${RUBRICS_SQL}) AND a.status = 'done'
   ORDER BY a.id DESC LIMIT 1)`;

export interface ResolveReport {
  history: number; reused: number; own: number; noTalk: number; secondTalk: number;
  /** Захист «без розмови»: стан синку дзвінків у момент кроку ③ і скільки угод тримає відсутній дзвінок-творець. */
  noTalkGate: NoTalkGate; noTalkNoCreatingCall: number;
}

/**
 * Крок угод: повтор вердикту номера → своя розмова → «розмови не було» → друга спроба.
 * Порядок має значення: спершу повтор, щоб не платити вдруге за номер, який уже слухали.
 */
export async function resolveCarrierDeals(db: Db, now: Date, noTalkAfterMin: number = CARRIER_RULE.windowAfterHours * 60,
  noTalkSyncMaxMin: number = NO_TALK_GUARD.defaultMaxAgeMin): Promise<ResolveReport> {
  const guard = await readNoTalkGuard(db, now, noTalkAfterMin, noTalkSyncMaxMin);
  const rep: ResolveReport = { history: 0, reused: 0, own: 0, noTalk: 0, secondTalk: 0,
    noTalkGate: guard.gate, noTalkNoCreatingCall: guard.noCreatingCall };

  // ⓪ Номер уже закривали як «Перевізник» у CRM, угоди замовника в «Успіх» чи в роботі немає (ТЗ 17.09, блок 1;
  //    `core/carrierHistory.ts`) — вердикт без розмови: не слухаємо й не платимо. ПЕРШИМ — раніше за повтор номера.
  rep.history = (await db.query(
    `UPDATE carrier_call_deals d SET state = 'history', history_from = h.src, updated_at = $1
       FROM (SELECT w.kommo_id, ${carrierHistorySql("w.phone", "w.kommo_id")} AS src
               FROM carrier_call_deals w WHERE w.state = 'waiting') h
      WHERE h.kommo_id = d.kommo_id AND h.src IS NOT NULL`,
    [now.toISOString()])).rowCount ?? 0;

  // ① Номер слухали за 30 днів (своя розмова іншої угоди, вердикт не «не розібрати») — беремо його вердикт.
  rep.reused = (await db.query(
    `WITH cand AS (
       SELECT d.kommo_id, (
         SELECT o.kommo_id FROM carrier_call_deals o JOIN ringostat_calls rc ON rc.uniqueid = o.uniqueid
          WHERE o.phone = d.phone AND o.state = 'own' AND o.kommo_id <> d.kommo_id
            AND rc.calldate >= d.deal_created_at - make_interval(days => $2)
            AND rc.calldate <= d.deal_created_at + make_interval(hours => $3)
            AND COALESCE(${ROLE_OF("o.uniqueid")}, '') <> 'unclear'
          ORDER BY rc.calldate DESC, o.kommo_id LIMIT 1) AS src
         FROM carrier_call_deals d WHERE d.state = 'waiting')
     UPDATE carrier_call_deals d SET state = 'reused', reused_from = cand.src, updated_at = $1
       FROM cand WHERE cand.kommo_id = d.kommo_id AND cand.src IS NOT NULL`,
    [now.toISOString(), CARRIER_RULE.reuseDays, CARRIER_RULE.windowAfterHours])).rowCount ?? 0;

  // ② Своя перша розмова — лише для НАЙРАНІШОЇ угоди номера: решта дочекається й повторить її вердикт,
  //    а не оплатить ту саму людину двічі за один прохід.
  rep.own = (await db.query(
    `WITH first AS (
       SELECT DISTINCT ON (phone) kommo_id FROM carrier_call_deals WHERE state = 'waiting'
        ORDER BY phone, deal_created_at, kommo_id),
     cand AS (SELECT d.kommo_id, (${TALK("d")}) AS u FROM carrier_call_deals d JOIN first USING (kommo_id))
     UPDATE carrier_call_deals d SET state = 'own', uniqueid = cand.u, first_uniqueid = cand.u, talk_no = 1, updated_at = $1
       FROM cand WHERE cand.kommo_id = d.kommo_id AND cand.u IS NOT NULL`,
    talkParams(now))).rowCount ?? 0;

  // ③ Строк минув (`noTalkAfterMin`: за замовчуванням доба; бойова джоба — рішення Романа 30.09.2026), розмови ≥10 с
  //    немає — «без розмови». Угоду, у номера якої є інша угода, що ще чекає чи вже слухається, не чіпаємо: вона
  //    повторить вердикт номера наступним проходом (крок ①), а не закриється як «немає зв'язку».
  //    🛡 Лише при свіжому синку дзвінків і лише якщо в базі є дзвінок, що створив угоду (`carrierNoTalkGuard.ts`):
  //    відсутність розмови доводить щось, тільки коли телефонію ВИДНО. Пауза — угода чекає, а не закривається.
  rep.noTalk = !guard.gate.open ? 0 : (await db.query(
    `UPDATE carrier_call_deals d SET state = 'no_talk', updated_at = $1
      WHERE ${NO_TALK_DUE_SQL("d")} AND ${CREATING_CALL_SQL("d")}`,
    [now.toISOString(), Math.max(0, Math.round(noTalkAfterMin))])).rowCount ?? 0;

  // ④ Першу розмову не розібрати (модель: unclear; або запису немає / розпізнати не вдалось) — друга, пізніша.
  //    Текст, видалений за строком зберігання, — не причина слухати ще раз.
  rep.secondTalk = (await db.query(
    `WITH need AS (
       SELECT d.kommo_id, rc1.calldate AS after_at FROM carrier_call_deals d
         JOIN ringostat_calls rc1 ON rc1.uniqueid = d.uniqueid
         LEFT JOIN call_transcripts t ON t.uniqueid = d.uniqueid
        WHERE d.state = 'own' AND d.talk_no = 1 AND d.talk_no < $5
          AND (t.status IN ('recording_unavailable', 'failed')
               OR (t.status = 'done' AND t.text_purged_at IS NULL AND jsonb_array_length(COALESCE(t.segments, '[]'::jsonb)) = 0)
               OR ${ROLE_OF("d.uniqueid")} = 'unclear')),
     cand AS (SELECT n.kommo_id, (${TALK("d", "AND rc.calldate > n.after_at")}) AS u
                FROM need n JOIN carrier_call_deals d USING (kommo_id))
     UPDATE carrier_call_deals d SET uniqueid = cand.u, talk_no = 2, updated_at = $1
       FROM cand WHERE cand.kommo_id = d.kommo_id AND cand.u IS NOT NULL`,
    [...talkParams(now), CARRIER_RULE.maxTalks])).rowCount ?? 0;
  return rep;
}

/**
 * 🗑 ТЕКСТ — 12 МІСЯЦІВ (рішення Романа 29.09.2026). Лише дзвінки мобільних, яких не аналізувала інша рубрика:
 * дзвінок, що є і в «Першому дотику», живе за правилами того екрана. Вердикт і цитата лишаються в аналізі.
 */
export async function purgeOldCarrierText(db: Db, now: Date): Promise<number> {
  const r = await db.query(
    `UPDATE call_transcripts t SET segments = NULL, text_purged_at = $1, updated_at = $1
      WHERE t.text_purged_at IS NULL AND t.status = 'done'
        AND t.created_at < $1::timestamptz - make_interval(months => $2)
        AND EXISTS (SELECT 1 FROM carrier_call_deals d WHERE d.uniqueid = t.uniqueid OR d.first_uniqueid = t.uniqueid)
        AND NOT EXISTS (SELECT 1 FROM call_analyses a WHERE a.transcript_id = t.id AND NOT (a.rubric_version = ANY($3::text[])))`,
    [now.toISOString(), CARRIER_RULE.retentionMonths, [...CARRIER_RUBRICS]]);
  return r.rowCount ?? 0;
}

/** Розмови з готовим вердиктом СТАРШОЇ рубрики мобільних — нова їх не переслуховує. */
export async function carrierAnalysedEarlier(db: Db, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const r = await db.query<{ u: string }>(`
    SELECT DISTINCT t.uniqueid AS u FROM call_transcripts t JOIN call_analyses a ON a.transcript_id = t.id
     WHERE t.uniqueid = ANY($1::text[]) AND a.status = 'done' AND a.rubric_version = ANY($2::text[]) AND a.rubric_version <> $3`,
  [[...ids], [...CARRIER_RUBRICS], CARRIER_RUBRIC]);
  return r.rows.map((x) => x.u);
}

export const CARRIER_STT_BUDGET_MS = 150_000;
export const CARRIER_LLM_BUDGET_MS = 60_000;

export interface CarrierTickEnv {
  db: Db;
  http: HttpDeps;
  keys: { elevenlabs: string; gemini: string };
  prices: TickPrices;
  now: () => Date;
  /** Угоди, що зараз на етапі, — прямо з Kommo. */
  stageLeads: () => Promise<StageLead[]>;
  alert: (text: string) => Promise<void>;
  /** Точка старту: угоди, створені раніше, не записуються й не слухаються. `null` — без межі. */
  launchAt?: Date | null;
  /** Через скільки хвилин угода без розмови ≥10 с стає «без розмови» (і закривається). Не задано — доба. */
  noTalkAfterMin?: number;
  /** Синк дзвінків старший за це — «без розмови» на паузі (`carrierNoTalkGuard.ts`). Не задано — 30 хв. */
  noTalkSyncMaxMin?: number;
  /** Задача «розібрати дзвінки на мобільні» в задачнику (лише бойова джоба; гейти вмикають явно). */
  reviewTasks?: boolean;
  /** Закриття в Kommo (перевізники, рішення людей; AI-«Інше» — `otherMode`). Не задано — кроку немає (як `off`). */
  close?: { mode: CloseMode; otherMode?: CloseMode; historyMode?: CloseMode; kommo: KommoCloser };
}

export interface CarrierTickReport {
  recorded: RecordReport;
  resolved: ResolveReport;
  active: number;
  enqueued: number;
  purged: number;
  stt: PortionReport[];
  llm: PortionReport[];
  sttStoppedBy: string | null;
  llmStoppedBy: string | null;
  capAlerted: boolean;
  closed: CloseReport | null;
  reviewTasks: ReviewTaskStats | null;
}

export async function runCarrierTick(env: CarrierTickEnv): Promise<CarrierTickReport> {
  const t0 = env.now();
  const leads = await env.stageLeads();
  const launchAt = env.launchAt ?? null;
  const recorded = await recordStageDeals(env.db, leads, t0, launchAt);
  const resolved = await resolveCarrierDeals(env.db, t0, env.noTalkAfterMin, env.noTalkSyncMaxMin);
  // Слухаємо лише угоди від точки старту: записані раніше (до 30.09.2026) більше не оплачуються.
  const ids = await carrierActiveIds(env.db, t0, launchAt);
  const enqueued = await enqueueTranscripts(env.db, ids, STT_PROVIDER, ELEVENLABS_STT_MODEL, t0);
  const purged = await purgeOldCarrierText(env.db, t0);
  const out: CarrierTickReport = { recorded, resolved, active: ids.length, enqueued, purged, stt: [], llm: [],
    sttStoppedBy: null, llmStoppedBy: null, capAlerted: false, closed: null, reviewTasks: null };
  // 🧹 Закриття — ПІСЛЯ вердиктів, по угодах, що стоять на етапі за ЦІЄЮ ж відповіддю Kommo.
  const doClose = async () => env.close
    ? runCarrierClose(env.db, env.now(), env.close.mode, new Set(leads.map((l) => l.id)), env.close.kommo, env.close.otherMode ?? "dry",
      env.close.historyMode ?? "dry") : null;
  // 📋 Задачі — ПІСЛЯ закриття: закрита цим проходом угода вже не рахується в «розібрати».
  const doTasks = async () => (env.reviewTasks ? syncCarrierReviewTasks(env.db, env.now(), launchAt) : null);
  if (!ids.length) { out.closed = await doClose(); out.reviewTasks = await doTasks(); return out; }

  const throttle = createMinInterval(RINGOSTAT_MIN_INTERVAL_MS, env.http);
  const common = { limit: TICK_PORTION, maxAttempts: TICK_MAX_ATTEMPTS, stuckAfterMin: STUCK_AFTER_MIN,
    calls: { only: ids }, subCap: { usd: CARRIER_BUDGET.monthCapUsd, opPrefix: CARRIER_BUDGET.opPrefix, label: CARRIER_BUDGET.label } };

  const stt = await drainWithBudget(() => runSttPortion(env.db, {
    apiKey: env.keys.elevenlabs,
    download: async (url) => { await throttle(); return downloadRecording(env.http, url, { ...RINGOSTAT_POLICY, maxBytes: RECORDING_MAX_BYTES }); },
    transcribe: (key, audio) => elevenLabsTranscribe(env.http, key, audio, STT_POLICY),
  }, {
    ...common, now: env.now(), operation: CARRIER_OPS.stt, provider: STT_PROVIDER, model: ELEVENLABS_STT_MODEL,
    monthCapUsd: env.prices.sttMonthCapUsd,
    usdPerAudioSec: env.prices.sttUsdPerHour == null ? null : env.prices.sttUsdPerHour / 3600,
  }), CARRIER_STT_BUDGET_MS, env.http.nowMs, out.stt);
  out.sttStoppedBy = stt.stoppedBy;

  const ap = { provider: LLM_PROVIDER, model: GEMINI_MODEL, rubricVersion: CARRIER_RUBRIC,
    sttProvider: STT_PROVIDER, sttModel: ELEVENLABS_STT_MODEL };
  // Розмова, яку вже розібрала попередня рубрика, другий раз не оплачується: її вердикт чинний (ТЗ 30.09.2026).
  await enqueueAnalyses(env.db, { ...ap, now: env.now() }, ids, await carrierAnalysedEarlier(env.db, ids));
  const llm = await drainWithBudget(() => runAnalysisPortion(env.db, {
    apiKey: env.keys.gemini,
    generate: (key, model, body) => geminiGenerate(env.http, key, model, body, LLM_POLICY),
    kit: CARRIER_KIT_V2,
  }, {
    ...common, ...ap, now: env.now(), operation: CARRIER_OPS.analysis, monthCapUsd: env.prices.llmMonthCapUsd,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    usdPerInputToken: env.prices.llmUsdPerMtokIn == null ? null : env.prices.llmUsdPerMtokIn / 1e6,
    usdPerOutputToken: env.prices.llmUsdPerMtokOut == null ? null : env.prices.llmUsdPerMtokOut / 1e6,
  }), CARRIER_LLM_BUDGET_MS, env.http.nowMs, out.llm);
  out.llmStoppedBy = llm.stoppedBy;

  const capped = [...out.stt, ...out.llm].find((x) => x.state === "capped");
  if (capped) out.capAlerted = await notifyCapOnce(env.db, "carrier", capped.stoppedBy ?? "стеля вичерпана", env.now(), env.alert);
  out.closed = await doClose();
  out.reviewTasks = await doTasks();
  const errs = [stt.error, llm.error].filter((e): e is Error => e != null);
  if (out.closed?.error) errs.push(new Error(`закриття в Kommo: ${out.closed.error}`));
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" · "));
  return out;
}
