import type { Db } from "./adCallFacts.js";
import { adDealFirstTalksSql } from "./adCallFactsRules.js";
import { OUTBOUND_TYPES } from "./missedCallsRules.js";
import type { MissedScope } from "./missedCallsRules.js";
import { ELEVENLABS_STT_MODEL, GEMINI_MODEL, RUBRIC_PILOT_V0, type AnalysisResult, type Turn } from "./callAiProviders.js";
import { LLM_PROVIDER, STT_PROVIDER, type AdPredicate } from "./callAiPilot.js";
import { FIRST_TOUCH_RULE } from "./callAiTick.js";
import { monthSpend } from "./callAiPipeline.js";

/**
 * 🎧 ЕКРАН «ПЕРШИЙ ДОТИК · AI» — ЛИШЕ ПЕРЕГЛЯД (прохід 1, рішення Романа 28.09.2026).
 *
 * Модуль без пулу: базу дає роут (`pool`) або гейт (scratch). Вибірка — ТА САМА, що в джобі
 * (`adDealFirstTalksSql` + `FIRST_TOUCH_RULE`, METRICS_GLOSSARY §15): друга копія правила «що
 * таке перший дотик» розійшлася б із першою мовчки. Тому екран показує рівно ті дзвінки, які
 * джоба бере в роботу, — і ті, до яких вона ще не дійшла, теж: зі станом, а не пропуском.
 *
 * 🔒 ДОСТУП (рішення Романа 28.09.2026): вкладка — admin, kvp, ceo, opdir, team_lead; тімлід бачить
 * лише дзвінки своєї команди (за тим, ХТО ДЗВОНИВ — дотик належить йому, як у §12). ПОВНИЙ текст
 * розмови — лише admin і kvp; решта бачить витяг із цитатами.
 *
 * ⚖️ ПЕРІОД — за датою СТВОРЕННЯ угоди (Київ), як у правилі вибірки: інакше лічильник екрана й
 * черга джоби рахували б різні множини. Межі одні на обидва боки.
 */

/** Ролі, яким видно повну розшифровку. Решта ролей вкладки — лише цитати. */
export const TRANSCRIPT_ROLES: ReadonlySet<string> = new Set(["admin", "kvp"]);

/**
 * Стан рядка — ЧЕСНИЙ і РІЗНИЙ для кожної причини «ще не готово». Жоден не показується нулем.
 *   not_queued            — джоба ще не дійшла до дзвінка (новий, або ключів ще не було);
 *   not_enabled           — ключа постачальника немає;
 *   queued                — у черзі або вже в роботі;
 *   capped                — чекає, бо вичерпано стелю місяця;
 *   recording_unavailable — запису в Ringostat немає;
 *   stt_failed / llm_failed — постачальник відмовив після всіх спроб;
 *   llm_pending           — розшифровка є, аналіз ще не готовий;
 *   done                  — є витяг.
 */
export type AiCallState = "not_queued" | "not_enabled" | "queued" | "capped" | "recording_unavailable"
  | "stt_failed" | "llm_pending" | "llm_failed" | "done";
export const AI_CALL_STATES: readonly AiCallState[] = ["done", "llm_pending", "queued", "not_queued", "not_enabled",
  "capped", "recording_unavailable", "stt_failed", "llm_failed"];

export function aiCallState(stt: string | null, llm: string | null): AiCallState {
  if (stt == null) return "not_queued";
  if (stt === "not_enabled") return "not_enabled";
  if (stt === "queued" || stt === "working") return "queued";
  if (stt === "capped") return "capped";
  if (stt === "recording_unavailable") return "recording_unavailable";
  if (stt === "failed") return "stt_failed";
  // stt === "done"
  if (llm == null || llm === "queued" || llm === "working") return "llm_pending";
  if (llm === "not_enabled") return "not_enabled";
  if (llm === "capped") return "capped";
  if (llm === "failed") return "llm_failed";
  return "done";
}

export interface AiCallRow {
  kommoId: number;
  uniqueid: string;
  calledAt: string;
  direction: "in" | "out";
  billsec: number;
  dealCreatedAt: string;
  managerId: number | null;
  managerName: string | null;
  teamId: number | null;
  teamName: string | null;
  state: AiCallState;
  failure: string | null;
  summary: string | null;
  priceDiscussed: boolean | null;
  objections: number;
  promises: number;
  promisesWithDeadline: number;
  /** Цитат, яких немає в розмові (модель процитувала те, чого не казали). Нуль — норма. */
  unverifiedQuotes: number;
}

interface RawRow {
  kommo_id: string | number; uniqueid: string; calldate: Date; call_type: string; billsec: number; created_at: Date;
  manager_id: number | null; manager_name: string | null; team_id: number | null; team_name: string | null;
  stt_status: string | null; stt_failure: string | null; llm_status: string | null; llm_failure: string | null;
  result: AnalysisResult | null;
}

const IN_TYPES = new Set(["in", "transitin"]);

export function foldRow(r: RawRow): AiCallRow {
  const state = aiCallState(r.stt_status, r.llm_status);
  const res = state === "done" ? r.result : null;
  const quotes = res ? [res.price, ...res.objections, ...res.promises] : [];
  return {
    kommoId: Number(r.kommo_id), uniqueid: r.uniqueid, calledAt: new Date(r.calldate).toISOString(),
    direction: IN_TYPES.has(r.call_type) ? "in" : "out", billsec: Number(r.billsec),
    dealCreatedAt: new Date(r.created_at).toISOString(),
    managerId: r.manager_id == null ? null : Number(r.manager_id), managerName: r.manager_name,
    teamId: r.team_id == null ? null : Number(r.team_id), teamName: r.team_name,
    state,
    failure: state === "stt_failed" || state === "recording_unavailable" ? r.stt_failure
      : state === "llm_failed" ? r.llm_failure : null,
    summary: res?.summary ?? null,
    priceDiscussed: res ? res.price.discussed : null,
    objections: res?.objections.length ?? 0,
    promises: res?.promises.length ?? 0,
    promisesWithDeadline: res?.promises.filter((p) => p.deadline_text.trim() !== "").length ?? 0,
    unverifiedQuotes: quotes.filter((q) => q.quote_found === false).length,
  };
}

/** Межа вибірки екрана. Більший період обрізається й це видно (`truncated`), а не мовчить. */
export const SCREEN_LIMIT = 5000;

/**
 * Список за період. Скоуп — `missedScopeFor` (той самий кламп, що в «Пропущених дзвінках»):
 * менеджер → лише свої (`-1`, якщо не привʼязаний — порожній скоуп НЕ нуль), тімлід → своя команда;
 * дзвінок без відомого менеджера бачить лише компанійна роль.
 */
export async function aiCallsList(db: Db, ad: AdPredicate, from: string, to: string, now: Date, scope: MissedScope):
  Promise<{ rows: AiCallRow[]; truncated: boolean }> {
  const q = adDealFirstTalksSql({ from, to, now, talkMinSec: FIRST_TOUCH_RULE.talkMinSec, windowBefore: FIRST_TOUCH_RULE.windowBefore,
    adDealPredicate: ad.predicate, adSources: ad.adSources }, FIRST_TOUCH_RULE.flag, SCREEN_LIMIT);
  const sql = `
    SELECT ft.kommo_id, ft.uniqueid, ft.calldate, ft.call_type, ft.billsec, ft.created_at,
           ft.manager_id, m.name AS manager_name, m.team_id, tm.name AS team_name,
           t.status AS stt_status, t.failure AS stt_failure,
           a.status AS llm_status, a.failure AS llm_failure, a.result
      FROM (${q.sql}) ft
      LEFT JOIN managers m ON m.id = ft.manager_id
      LEFT JOIN teams tm ON tm.id = m.team_id
      LEFT JOIN call_transcripts t ON t.uniqueid = ft.uniqueid AND t.provider = $8 AND t.model = $9
      LEFT JOIN call_analyses a ON a.transcript_id = t.id AND a.provider = $10 AND a.model = $11 AND a.rubric_version = $12
     WHERE ($13::int IS NULL OR ft.manager_id = $13)
       AND ($14::int IS NULL OR m.team_id = $14)
     ORDER BY ft.calldate DESC, ft.kommo_id DESC`;
  const params = [...q.params, STT_PROVIDER, ELEVENLABS_STT_MODEL, LLM_PROVIDER, GEMINI_MODEL, RUBRIC_PILOT_V0,
    scope.managerId ?? null, scope.teamId ?? null];
  const raw = (await db.query<RawRow>(sql, params)).rows;
  return { rows: raw.map(foldRow), truncated: raw.length >= SCREEN_LIMIT };
}

export interface AiCallCard {
  row: Omit<AiCallRow, "kommoId" | "dealCreatedAt"> & { kommoIds: number[] };
  result: AnalysisResult | null;
  /** `null` — роль не має права на повний текст (`transcriptHidden`), або розшифровки ще немає. */
  turns: Turn[] | null;
  transcriptHidden: boolean;
  managerChannel: number | null;
  durationSec: number | null;
  /** Перший наш ВИХІДНИЙ дзвінок на цей номер після розмови — факт Ringostat, не оцінка моделі. */
  nextOutboundAt: string | null;
}

/**
 * Картка одного дзвінка. Скоуп перевіряється ТИМ САМИМ фільтром, що й у списку: чужий дзвінок
 * повертає `null` (роут віддасть 404), а не порожню картку — інакше існування чужої розмови
 * просочувалось би відповіддю.
 */
export async function aiCallCard(db: Db, uniqueid: string, role: string, scope: MissedScope): Promise<AiCallCard | null> {
  const r = await db.query<RawRow & { segments: Turn[] | null; duration_sec: string | null; client_phone: string | null }>(`
    SELECT rc.uniqueid, rc.calldate, rc.call_type, rc.billsec, rc.calldate AS created_at, 0 AS kommo_id,
           rc.manager_id, m.name AS manager_name, m.team_id, tm.name AS team_name, rc.client_phone,
           t.status AS stt_status, t.failure AS stt_failure, t.segments, t.duration_sec,
           a.status AS llm_status, a.failure AS llm_failure, a.result
      FROM ringostat_calls rc
      LEFT JOIN managers m ON m.id = rc.manager_id
      LEFT JOIN teams tm ON tm.id = m.team_id
      LEFT JOIN call_transcripts t ON t.uniqueid = rc.uniqueid AND t.provider = $2 AND t.model = $3
      LEFT JOIN call_analyses a ON a.transcript_id = t.id AND a.provider = $4 AND a.model = $5 AND a.rubric_version = $6
     WHERE rc.uniqueid = $1
       AND ($7::int IS NULL OR rc.manager_id = $7)
       AND ($8::int IS NULL OR m.team_id = $8)`,
  [uniqueid, STT_PROVIDER, ELEVENLABS_STT_MODEL, LLM_PROVIDER, GEMINI_MODEL, RUBRIC_PILOT_V0,
    scope.managerId ?? null, scope.teamId ?? null]);
  const raw = r.rows[0];
  if (!raw) return null;
  const row = foldRow(raw);
  const deals = raw.client_phone
    ? (await db.query<{ kommo_id: string }>(
      `SELECT kommo_id::text FROM deals WHERE client_key IS NOT NULL AND '38' || client_key = $1 ORDER BY created_at_kommo DESC LIMIT 5`,
      [raw.client_phone])).rows.map((x) => Number(x.kommo_id))
    : [];
  const next = raw.client_phone
    ? (await db.query<{ at: Date | null }>(
      `SELECT min(calldate) AS at FROM ringostat_calls WHERE client_phone = $1 AND call_type = ANY($2::text[]) AND calldate > $3`,
      [raw.client_phone, [...OUTBOUND_TYPES], raw.calldate])).rows[0]?.at ?? null
    : null;
  const allowed = TRANSCRIPT_ROLES.has(role);
  const done = row.state === "done";
  const { kommoId: _k, dealCreatedAt: _d, ...rest } = row;
  const mc = done && raw.result ? raw.result.manager_channel : null;
  return {
    row: { ...rest, kommoIds: deals },
    result: done ? raw.result : null,
    turns: allowed && raw.segments ? raw.segments : null,
    transcriptHidden: !allowed,
    managerChannel: mc === "0" ? 0 : mc === "1" ? 1 : null,
    durationSec: raw.duration_sec == null ? null : Number(raw.duration_sec),
    nextOutboundAt: next ? new Date(next).toISOString() : null,
  };
}

export interface AiCallsMeta {
  job: { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } | null;
  transcripts: Record<string, number>;
  analyses: Record<string, number>;
  spend: { stt: number; analysis: number };
  caps: { stt: number | null; analysis: number | null };
}

/** Стан конвеєра: останній тік, черга за станами, витрати місяця (Київ) проти стелі. */
export async function aiCallsMeta(db: Db, now: Date, caps: AiCallsMeta["caps"]): Promise<AiCallsMeta> {
  const j = (await db.query<{ last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
    "SELECT last_success_at, last_error, last_error_at FROM job_runs WHERE name = 'callAiJob'")).rows[0];
  const count = async (table: "call_transcripts" | "call_analyses") => {
    const r = await db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM ${table} GROUP BY status`);
    return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
  };
  return {
    job: j ? {
      lastSuccessAt: j.last_success_at ? new Date(j.last_success_at).toISOString() : null,
      lastError: j.last_error, lastErrorAt: j.last_error_at ? new Date(j.last_error_at).toISOString() : null,
    } : null,
    transcripts: await count("call_transcripts"),
    analyses: await count("call_analyses"),
    spend: { stt: (await monthSpend(db, STT_PROVIDER, now)).usd, analysis: (await monthSpend(db, LLM_PROVIDER, now)).usd },
    caps,
  };
}
