import type { Db } from "./adCallFacts.js";
import { ParamNotSetError } from "./adCallFactsRules.js";
import { ACCOUNT_WIDE, RETRYABLE, VendorError, VENDOR_FAILURE_UA, type VendorFailureKind } from "./callAiHttp.js";
import { RECORDING_UNAVAILABLE_UA, type DownloadOutcome } from "./ringostatRecording.js";
import { buildAnalysisRequest, inputTokenUpperBound, interpretAnalysis, toTurns,
  type GeminiOutcome, type SttAudio, type SttResult, type Turn } from "./callAiProviders.js";

/**
 * 🧰 РУБРИКА ЯК ПАРАМЕТР: як зібрати запит до моделі й як прочитати відповідь. Конвеєр однаковий для
 * будь-якої рубрики — черга, стеля, журнал; різниться лише це. Без параметра — «Перший дотик».
 */
export interface AnalysisKit {
  build: (turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null) => Record<string, unknown>;
  interpret: (out: GeminiOutcome, turns: readonly Turn[]) => { ok: true; result: unknown } | { ok: false; why: string };
}
export const FIRST_TOUCH_KIT: AnalysisKit = { build: buildAnalysisRequest, interpret: interpretAnalysis };

/**
 * 🧵 КОНВЕЄР AI-АНАЛІЗУ: черга → узяти в роботу → стеля → платний виклик → журнал витрат.
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах», прохід A, коміт ③. Порціями в ТОМУ Ж процесі:
 * другий Node-процес на хості вбивається за 1–2 хв, тож «окремий воркер» тут неможливий.
 *
 * 🔴 ІНВАРІАНТИ, ЗАРАДИ ЯКИХ МОДУЛЬ ІСНУЄ (кожен тримає свій гейт):
 *   1. ДЗВІНОК ОПЛАЧУЄТЬСЯ ОДИН РАЗ. Рядок береться в роботу (`queued → working`) ОДНИМ
 *      оператором з `FOR UPDATE SKIP LOCKED` ДО платного виклику — два тіки, що біжать
 *      одночасно, не візьмуть той самий рядок; повторний запуск бачить `done` і не платить.
 *   2. СТЕЛЯ ПЕРЕВІРЯЄТЬСЯ ДО ВИКЛИКУ, по ОЦІНЦІ цього виклику, а не після по факту. Для
 *      розпізнавання оцінка точна (тривалість × канали з заголовка WAV); для аналізу — ВЕРХНЯ
 *      межа (байти запиту + стеля виходу). Немає ціни або стелі → `ParamNotSetError`, а не
 *      «безкоштовно»: невідома ціна — це закрита стеля.
 *   3. ОПЛАТА І СТАН — ОДНИМ ОПЕРАТОРОМ. Запис у журнал і `working → done` їдуть одним
 *      `WITH … INSERT … UPDATE`: обрив між ними не лишить ні оплати без рядка, ні рядка без оплати.
 *   4. БЕЗ КЛЮЧА — НУЛЬ ЗАПИТІВ НАЗОВНІ. Рядки черги стають `not_enabled`, і це видно на екрані;
 *      щойно ключ зʼявився — повертаються в чергу самі.
 *   5. ЗАВИСЛИЙ `working` (процес убили посеред виклику) повертається в чергу через
 *      `stuckAfterMin`; після `maxAttempts` — `failed` із причиною, а не вічне коло.
 *   6. ПОМИЛКА ПОРЦІЇ НЕ МІСТИТЬ HTTP-КОДІВ: `classifyJobError` читає 403/429 як «Kommo відмовляє».
 *      Код лишається в `failure` рядка — там його читає людина, а не класифікатор тривог.
 *
 * ⚖️ ПОРОГИ ЦЬОГО МОДУЛЯ — ОПЕРАЦІЙНІ, НЕ БІЗНЕС-ПРАВИЛА, і все одно приходять параметром:
 * порція, спроби, «завис» задає той, хто кличе (джоба / пілот). Ціни й стелі — лише параметром.
 */

type Table = "call_transcripts" | "call_analyses";

/**
 * Межа черги за дзвінками. Два споживачі ділять одну чергу (реклама щогодини, мобільні щоп'ять хвилин),
 * і кожен мусить брати в роботу, ставити на стелю й будити ЛИШЕ свої рядки: інакше стеля мобільних
 * заморозила б рекламні дзвінки, а годинна джоба оплатила б мобільні під рекламною стелею.
 * Не задано — уся черга, як було.
 */
export interface CallFilter {
  only?: readonly string[];
  except?: readonly string[];
}

interface Scope extends CallFilter {
  table: Table;
  provider: string;
  model: string;
  rubric?: string;
}

function scopeWhere(s: Scope, first: number): { sql: string; params: unknown[] } {
  const parts = [`provider = $${String(first)}`, `model = $${String(first + 1)}`];
  const params: unknown[] = [s.provider, s.model];
  if (s.table === "call_analyses") {
    parts.push(`rubric_version = $${String(first + 2)}`);
    params.push(s.rubric);
  }
  const callIn = (n: number): string => s.table === "call_transcripts"
    ? `uniqueid = ANY($${String(n)}::text[])`
    : `transcript_id IN (SELECT ct.id FROM call_transcripts ct WHERE ct.uniqueid = ANY($${String(n)}::text[]))`;
  if (s.only) { params.push([...s.only]); parts.push(callIn(first + params.length - 1)); }
  if (s.except?.length) { params.push([...s.except]); parts.push(`NOT (${callIn(first + params.length - 1)})`); }
  return { sql: parts.join(" AND "), params };
}

export interface QueueParams {
  now: Date;
  /** Рядків за один тік. */
  limit: number;
  maxAttempts: number;
  /** Скільки хвилин `working` вважається завислим. Мусить бути більшим за таймаут виклику. */
  stuckAfterMin: number;
  /** Стеля на календарний місяць за Києвом, USD, по ЦЬОМУ постачальнику. */
  monthCapUsd: number | null | undefined;
  /** Мітка в журналі витрат: `stt` / `analysis` / `pilot_stt` / `pilot_analysis`. */
  operation: string;
  /** Межа черги за дзвінками (див. `CallFilter`). */
  calls?: CallFilter;
  /**
   * Додаткова стеля на місяць для ЧАСТИНИ витрат — тих, чия мітка операції починається з `opPrefix`,
   * по ВСІХ постачальниках разом. Діє поверх стелі постачальника, а не замість неї.
   */
  subCap?: { usd: number; opPrefix: string; label: string } | null;
}

function assertQueueParams(p: QueueParams): number {
  if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 200) throw new Error(`limit поза 1..200: ${String(p.limit)}`);
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) throw new Error(`maxAttempts має бути цілим ≥1: ${String(p.maxAttempts)}`);
  if (!Number.isInteger(p.stuckAfterMin) || p.stuckAfterMin < 1) throw new Error(`stuckAfterMin має бути цілим ≥1: ${String(p.stuckAfterMin)}`);
  if (p.monthCapUsd == null || !Number.isFinite(p.monthCapUsd) || p.monthCapUsd <= 0)
    throw new ParamNotSetError("місячна стеля витрат постачальника (USD)");
  return p.monthCapUsd;
}

function assertPrice(v: number | null | undefined, what: string): number {
  if (v == null || !Number.isFinite(v) || v < 0) throw new ParamNotSetError(`ціна: ${what}`);
  return v;
}

export interface PortionReport {
  state: "ok" | "idle" | "not_enabled" | "capped" | "stopped";
  claimed: number;
  done: number;
  /** Повернуто в чергу після збою, що лікується повтором. */
  retry: number;
  failed: number;
  unavailable: number;
  capped: number;
  /** Оплачено, але рядок тим часом забрали як завислий (стан не перезаписано). */
  lostRace: number;
  requeuedStuck: number;
  failedStuck: number;
  spentUsd: number;
  capUsd: number | null;
  stoppedBy: string | null;
}

const emptyReport = (): PortionReport => ({
  state: "idle", claimed: 0, done: 0, retry: 0, failed: 0, unavailable: 0, capped: 0, lostRace: 0,
  requeuedStuck: 0, failedStuck: 0, spentUsd: 0, capUsd: null, stoppedBy: null,
});

// ─── Спільні кроки черги ────────────────────────────────────────────────────

async function setNotEnabled(db: Db, s: Scope, now: Date): Promise<void> {
  const w = scopeWhere(s, 2);
  await db.query(`UPDATE ${s.table} SET status = 'not_enabled', updated_at = $1 WHERE ${w.sql} AND status = 'queued'`,
    [now.toISOString(), ...w.params]);
}

async function wakeNotEnabled(db: Db, s: Scope, now: Date): Promise<void> {
  const w = scopeWhere(s, 2);
  await db.query(`UPDATE ${s.table} SET status = 'queued', updated_at = $1 WHERE ${w.sql} AND status = 'not_enabled'`,
    [now.toISOString(), ...w.params]);
}

async function reclaimStuck(db: Db, s: Scope, p: QueueParams): Promise<{ requeued: number; failed: number }> {
  const w = scopeWhere(s, 4);
  const r = await db.query<{ status: string }>(
    `UPDATE ${s.table} SET
        status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
        failure = CASE WHEN attempts >= $2
          THEN 'стеля спроб: рядок ' || attempts || ' раз(и) зависав у роботі — процес обривався посеред виклику'
          ELSE failure END,
        claimed_at = NULL, updated_at = $1
      WHERE ${w.sql} AND status = 'working' AND claimed_at < $1::timestamptz - make_interval(mins => $3)
      RETURNING status`,
    [p.now.toISOString(), p.maxAttempts, p.stuckAfterMin, ...w.params]);
  return {
    requeued: r.rows.filter((x) => x.status === "queued").length,
    failed: r.rows.filter((x) => x.status === "failed").length,
  };
}

/** Витрачено за київський місяць по операціях із префіксом — усі постачальники разом. */
export async function monthSpendByOp(db: Db, opPrefix: string, now: Date): Promise<{ usd: number; unpriced: number }> {
  const r = await db.query<{ usd: number; unpriced: number }>(
    `SELECT COALESCE(SUM(usd), 0)::float8 AS usd, COUNT(*) FILTER (WHERE usd IS NULL)::int AS unpriced
       FROM ai_spend_ledger
      WHERE left(operation, length($1)) = $1
        AND (at AT TIME ZONE 'Europe/Kyiv') >= date_trunc('month', $2::timestamptz AT TIME ZONE 'Europe/Kyiv')
        AND (at AT TIME ZONE 'Europe/Kyiv') <  date_trunc('month', $2::timestamptz AT TIME ZONE 'Europe/Kyiv') + interval '1 month'`,
    [opPrefix, now.toISOString()]);
  return { usd: Number(r.rows[0]?.usd ?? 0), unpriced: Number(r.rows[0]?.unpriced ?? 0) };
}

/** Витрачено за календарний місяць (Київ), у якому лежить `now`. Рядки без ціни — окремо. */
export async function monthSpend(db: Db, provider: string, now: Date): Promise<{ usd: number; unpriced: number }> {
  const r = await db.query<{ usd: number; unpriced: number }>(
    `SELECT COALESCE(SUM(usd), 0)::float8 AS usd, COUNT(*) FILTER (WHERE usd IS NULL)::int AS unpriced
       FROM ai_spend_ledger
      WHERE provider = $1
        AND (at AT TIME ZONE 'Europe/Kyiv') >= date_trunc('month', $2::timestamptz AT TIME ZONE 'Europe/Kyiv')
        AND (at AT TIME ZONE 'Europe/Kyiv') <  date_trunc('month', $2::timestamptz AT TIME ZONE 'Europe/Kyiv') + interval '1 month'`,
    [provider, now.toISOString()]);
  return { usd: Number(r.rows[0]?.usd ?? 0), unpriced: Number(r.rows[0]?.unpriced ?? 0) };
}

async function moveStatus(db: Db, s: Scope, now: Date, from: string, to: string): Promise<number> {
  const w = scopeWhere(s, 4);
  const r = await db.query(`UPDATE ${s.table} SET status = $3, updated_at = $1 WHERE ${w.sql} AND status = $2`,
    [now.toISOString(), from, to, ...w.params]);
  return r.rowCount ?? 0;
}

/**
 * Час дзвінка рядка черги — для порядку «НОВІ ПЕРШИМИ» (рішення власника 28.09.2026). Раніше черга йшла
 * за `id`, тобто в порядку постановки: перший тік поставив 1100 дзвінків за 30 днів, і свіжі чекали б
 * у хвості ~85 годин. Дзвінок без запису в `ringostat_calls` — у кінці (`NULLS LAST`), а не загублений.
 */
function callTimeOf(table: Table, alias: string): string {
  return table === "call_transcripts"
    ? `(SELECT rc.calldate FROM ringostat_calls rc WHERE rc.uniqueid = ${alias}.uniqueid)`
    : `(SELECT rc.calldate FROM call_transcripts ct JOIN ringostat_calls rc ON rc.uniqueid = ct.uniqueid WHERE ct.id = ${alias}.transcript_id)`;
}

async function claim(db: Db, s: Scope, now: Date, limit: number): Promise<{ id: string; ref: string; attempts: number }[]> {
  const w = scopeWhere(s, 3);
  const refCol = s.table === "call_transcripts" ? "uniqueid" : "transcript_id::text";
  const r = await db.query<{ id: string; ref: string; attempts: number }>(
    `UPDATE ${s.table} q SET status = 'working', claimed_at = $1, attempts = q.attempts + 1, updated_at = $1
      WHERE q.id IN (SELECT o.id FROM ${s.table} o WHERE ${w.sql} AND o.status = 'queued'
                      ORDER BY ${callTimeOf(s.table, "o")} DESC NULLS LAST, o.id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING q.id::text AS id, q.${refCol} AS ref, q.attempts`,
    [now.toISOString(), limit, ...w.params]);
  return r.rows.map((x) => ({ id: String(x.id), ref: String(x.ref), attempts: Number(x.attempts) }));
}

/**
 * Закрити рядок без оплати. `refund` повертає спробу: зупинка з вини рахунку чи стелі — не
 * провина дзвінка, і вона не має наближати його до `failed`.
 */
async function finishRow(db: Db, table: Table, id: string, now: Date, status: string, failure: string | null, refund: boolean): Promise<void> {
  await db.query(
    `UPDATE ${table} SET status = $3, failure = $4, attempts = attempts - $5, claimed_at = NULL, updated_at = $2
      WHERE id = $1 AND status = 'working'`,
    [id, now.toISOString(), status, failure, refund ? 1 : 0]);
}

interface Pre {
  scope: Scope;
  capUsd: number;
  spentUsd: number;
  /** Додаткова стеля й витрачене під нею; null — її немає. */
  sub: { capUsd: number; spentUsd: number; label: string } | null;
  report: PortionReport;
  rows: { id: string; ref: string; attempts: number }[];
}

/** Чи вміщається оцінка під обидві стелі. Повертає причину зупинки або null. */
function overCap(pre: Pick<Pre, "capUsd" | "sub">, spent: number, est: number, spentDigits: number, what: string): string | null {
  if (spent + est > pre.capUsd) return `стеля місяця: ${spent.toFixed(spentDigits)} + ${what} ${est.toFixed(4)} > ${pre.capUsd.toFixed(2)} USD`;
  if (pre.sub && pre.sub.spentUsd + est > pre.sub.capUsd)
    return `стеля «${pre.sub.label}»: ${pre.sub.spentUsd.toFixed(spentDigits)} + ${what} ${est.toFixed(4)} > ${pre.sub.capUsd.toFixed(2)} USD`;
  return null;
}

/** Усе до першого платного виклику: ключ, параметри, завислі, стеля, узяття в роботу. */
async function prepare(db: Db, scope: Scope, p: QueueParams, apiKey: string, assertPrices: () => void): Promise<Pre | PortionReport> {
  const report = emptyReport();
  if (!apiKey) {
    await setNotEnabled(db, scope, p.now);
    return { ...report, state: "not_enabled", stoppedBy: `ключ ${scope.provider} не задано — жодного запиту назовні` };
  }
  const capUsd = assertQueueParams(p);
  assertPrices();
  report.capUsd = capUsd;
  await wakeNotEnabled(db, scope, p.now);
  const st = await reclaimStuck(db, scope, p);
  report.requeuedStuck = st.requeued;
  report.failedStuck = st.failed;
  const spend = await monthSpend(db, scope.provider, p.now);
  report.spentUsd = spend.usd;
  if (p.subCap != null && (!Number.isFinite(p.subCap.usd) || p.subCap.usd <= 0 || !p.subCap.opPrefix))
    throw new ParamNotSetError(`додаткова стеля «${p.subCap.label}» (USD і префікс операції)`);
  const subSpend = p.subCap ? await monthSpendByOp(db, p.subCap.opPrefix, p.now) : null;
  const subHit = p.subCap && subSpend && subSpend.usd >= p.subCap.usd;
  if (spend.unpriced > 0 || spend.usd >= capUsd || subHit) {
    report.capped = await moveStatus(db, scope, p.now, "queued", "capped");
    return {
      ...report, state: "capped",
      stoppedBy: spend.unpriced > 0
        ? `у журналі ${String(spend.unpriced)} витрат без ціни — скільки витрачено, невідомо; стеля закрита`
        : spend.usd >= capUsd
          ? `стеля місяця вичерпана: ${spend.usd.toFixed(2)} із ${capUsd.toFixed(2)} USD`
          : `стеля «${p.subCap!.label}» вичерпана: ${subSpend!.usd.toFixed(2)} із ${p.subCap!.usd.toFixed(2)} USD`,
    };
  }
  await moveStatus(db, scope, p.now, "capped", "queued");
  const rows = await claim(db, scope, p.now, p.limit);
  report.claimed = rows.length;
  if (!rows.length) return report;
  const sub = p.subCap && subSpend ? { capUsd: p.subCap.usd, spentUsd: subSpend.usd, label: p.subCap.label } : null;
  return { scope, capUsd, spentUsd: spend.usd, sub, report, rows };
}

/** Зупинити решту взятих рядків: стеля → `capped`; збій рахунку → назад у чергу. Спроба повертається. */
async function stopRest(db: Db, table: Table, rest: Pre["rows"], now: Date, status: "capped" | "queued", why: string, r: PortionReport): Promise<void> {
  for (const x of rest) {
    await finishRow(db, table, x.id, now, status, why, true);
    if (status === "capped") r.capped++; else r.retry++;
  }
}

/**
 * Помилка ПОРЦІЇ — лише наш словник видів, без HTTP-кодів (інваріант 6). Кидається, коли жоден
 * взятий рядок не дійшов до результату з вини постачальника: інакше джоба лишалась би зеленою,
 * поки вся черга горить.
 */
function portionFailure(stage: string, kinds: Map<VendorFailureKind, number>, total: number): Error {
  const list = [...kinds.entries()].map(([k, n]) => `${VENDOR_FAILURE_UA[k]} ×${String(n)}`).join("; ");
  return new Error(`AI-конвеєр (${stage}): жоден із ${String(total)} узятих дзвінків не дійшов до результату — ${list}`);
}

function vendorOutcome(e: VendorError, attempts: number, maxAttempts: number): { status: "queued" | "failed"; refund: boolean } {
  if (RETRYABLE.has(e.kind) && attempts < maxAttempts) return { status: "queued", refund: false };
  return { status: "failed", refund: false };
}

// ─── Розпізнавання ──────────────────────────────────────────────────────────

export interface SttParams extends QueueParams {
  provider: string;
  model: string;
  usdPerAudioSec: number | null | undefined;
}

export interface SttWorker {
  apiKey: string;
  download: (recordingUrl: string | null) => Promise<DownloadOutcome>;
  /** `mono` — у файлі один канал: голоси розділяються за звучанням (`STT_MONO_FORM_FIELDS`). */
  transcribe: (apiKey: string, audio: SttAudio, opts?: { mono?: boolean }) => Promise<SttResult>;
}

/** Поставити дзвінки в чергу розпізнавання. Повтор нічого не дублює (`UNIQUE` + `DO NOTHING`). */
export async function enqueueTranscripts(db: Db, uniqueids: readonly string[], provider: string, model: string, now: Date): Promise<number> {
  if (!uniqueids.length) return 0;
  const r = await db.query(
    `INSERT INTO call_transcripts (uniqueid, provider, model, status, created_at, updated_at)
     SELECT DISTINCT u, $2, $3, 'queued', $4::timestamptz, $4::timestamptz FROM unnest($1::text[]) AS u
     ON CONFLICT (uniqueid, provider, model) DO NOTHING`,
    [[...uniqueids], provider, model, now.toISOString()]);
  return r.rowCount ?? 0;
}

/**
 * Прибрати з черги розпізнавання дзвінки, яких немає в поточній вибірці (раніше дати старту або
 * випали з вікна). Прибирається ЛИШЕ те, за що не заплачено й не пробували: стан очікування,
 * `attempts = 0`, жодного рядка в журналі витрат і жодного аналізу. Порожня вибірка не прибирає
 * НІЧОГО: порожнеча — привід зупинитись, а не зачистити чергу (правило 15 кореня).
 */
export async function dequeueOutside(db: Db, keep: readonly string[], provider: string, model: string): Promise<number> {
  if (!keep.length) return 0;
  const r = await db.query(
    `DELETE FROM call_transcripts t
      WHERE t.provider = $2 AND t.model = $3
        AND t.status IN ('queued', 'not_enabled', 'capped') AND t.attempts = 0
        AND NOT (t.uniqueid = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM ai_spend_ledger l WHERE l.uniqueid = t.uniqueid)
        AND NOT EXISTS (SELECT 1 FROM call_analyses a WHERE a.transcript_id = t.id)`,
    [[...keep], provider, model]);
  return r.rowCount ?? 0;
}

export async function runSttPortion(db: Db, w: SttWorker, p: SttParams): Promise<PortionReport> {
  const scope: Scope = { table: "call_transcripts", provider: p.provider, model: p.model, ...p.calls };
  let price = 0;
  const pre = await prepare(db, scope, p, w.apiKey, () => { price = assertPrice(p.usdPerAudioSec, "розпізнавання, USD за секунду аудіо"); });
  if (!("rows" in pre)) return pre;
  const { report: r, rows } = pre;
  let spent = pre.spentUsd;
  r.state = "ok";

  const urls = new Map<string, string | null>();
  const u = await db.query<{ uniqueid: string; recording: string | null }>(
    "SELECT uniqueid, recording FROM ringostat_calls WHERE uniqueid = ANY($1::text[])", [rows.map((x) => x.ref)]);
  for (const x of u.rows) urls.set(x.uniqueid, x.recording);

  const kinds = new Map<VendorFailureKind, number>();
  let vendorFails = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const got = await w.download(urls.get(row.ref) ?? null);
      if (!got.ok) {
        await finishRow(db, scope.table, row.id, p.now, "recording_unavailable", RECORDING_UNAVAILABLE_UA[got.unavailable], false);
        r.unavailable++;
        continue;
      }
      const billedSec = got.info.durationSec * got.info.channels;
      const est = billedSec * price;
      const why = overCap(pre, spent, est, 2, "оцінка");
      if (why) {
        await stopRest(db, scope.table, rows.slice(i), p.now, "capped", why, r);
        r.state = "capped";
        r.stoppedBy = why;
        break;
      }
      const stt = await w.transcribe(w.apiKey, { bytes: got.bytes, contentType: "audio/wav" }, { mono: got.info.channels === 1 });
      const turns = toTurns(stt);
      const done = await db.query<{ updated: number }>(
        `WITH l AS (
           INSERT INTO ai_spend_ledger (at, provider, operation, uniqueid, units, unit, unit_price_usd)
           VALUES ($2, $3, $4, $5, $6, 'audio_sec', $7) RETURNING id
         ), t AS (
           UPDATE call_transcripts SET status = 'done', channels = $8, duration_sec = $9, segments = $10::jsonb,
                  failure = NULL, claimed_at = NULL, updated_at = $2
            WHERE id = $1 AND status = 'working' RETURNING id
         )
         SELECT (SELECT count(*) FROM t)::int AS updated, (SELECT count(*) FROM l)::int AS billed`,
        [row.id, p.now.toISOString(), p.provider, p.operation, row.ref, Math.round(billedSec * 1000) / 1000, price,
          got.info.channels, Math.round(got.info.durationSec * 1000) / 1000, JSON.stringify(turns)]);
      spent += est;
      if (pre.sub) pre.sub.spentUsd += est;
      if (Number(done.rows[0]?.updated) === 1) r.done++; else r.lostRace++;
    } catch (e) {
      if (!(e instanceof VendorError)) throw e;
      if (ACCOUNT_WIDE.has(e.kind)) {
        await stopRest(db, scope.table, rows.slice(i), p.now, "queued", e.message, r);
        r.state = "stopped";
        r.stoppedBy = `${e.vendor}: ${VENDOR_FAILURE_UA[e.kind]}`;
        throw new Error(`AI-конвеєр (розпізнавання): порцію зупинено — ${r.stoppedBy}; дзвінки повернуто в чергу`);
      }
      const o = vendorOutcome(e, row.attempts, p.maxAttempts);
      await finishRow(db, scope.table, row.id, p.now, o.status, e.message, o.refund);
      if (o.status === "queued") r.retry++; else r.failed++;
      vendorFails++;
      kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    }
  }
  r.spentUsd = spent;
  if (vendorFails > 0 && r.done === 0 && vendorFails === rows.length) throw portionFailure("розпізнавання", kinds, rows.length);
  return r;
}

// ─── Аналіз розшифровки ─────────────────────────────────────────────────────

export interface AnalysisParams extends QueueParams {
  provider: string;
  model: string;
  rubricVersion: string;
  /** Розшифровки ЯКОГО розпізнавання аналізуємо — щоб друга модель STT не подвоїла оплату аналізу. */
  sttProvider: string;
  sttModel: string;
  maxOutputTokens: number;
  usdPerInputToken: number | null | undefined;
  usdPerOutputToken: number | null | undefined;
}

export interface AnalysisWorker {
  apiKey: string;
  generate: (apiKey: string, model: string, body: unknown) => Promise<GeminiOutcome>;
  /** Рубрика: як будувати запит і читати відповідь. Не задано — «Перший дотик». */
  kit?: AnalysisKit;
}

/** Черга аналізу: готові НЕПОРОЖНІ розшифровки без аналізу цією моделлю й рубрикою. */
export async function enqueueAnalyses(db: Db, p: Pick<AnalysisParams, "provider" | "model" | "rubricVersion" | "sttProvider" | "sttModel" | "now">,
  uniqueids: readonly string[] | null, except: readonly string[] = []): Promise<number> {
  const r = await db.query(
    `INSERT INTO call_analyses (transcript_id, provider, model, rubric_version, status, created_at, updated_at)
     SELECT t.id, $1, $2, $3, 'queued', $4::timestamptz, $4::timestamptz FROM call_transcripts t
      WHERE t.status = 'done' AND t.provider = $5 AND t.model = $6
        AND jsonb_array_length(COALESCE(t.segments, '[]'::jsonb)) > 0
        AND ($7::text[] IS NULL OR t.uniqueid = ANY($7::text[]))
        AND NOT (t.uniqueid = ANY($8::text[]))
     ON CONFLICT (transcript_id, model, rubric_version) DO NOTHING`,
    [p.provider, p.model, p.rubricVersion, p.now.toISOString(), p.sttProvider, p.sttModel, uniqueids ? [...uniqueids] : null, [...except]]);
  return r.rowCount ?? 0;
}

export async function runAnalysisPortion(db: Db, w: AnalysisWorker, p: AnalysisParams): Promise<PortionReport> {
  const scope: Scope = { table: "call_analyses", provider: p.provider, model: p.model, rubric: p.rubricVersion, ...p.calls };
  const kit = w.kit ?? FIRST_TOUCH_KIT;
  let inPrice = 0, outPrice = 0;
  const pre = await prepare(db, scope, p, w.apiKey, () => {
    inPrice = assertPrice(p.usdPerInputToken, "аналіз, USD за вхідний токен");
    outPrice = assertPrice(p.usdPerOutputToken, "аналіз, USD за вихідний токен");
    if (!Number.isInteger(p.maxOutputTokens) || p.maxOutputTokens < 1) throw new ParamNotSetError("стеля вихідних токенів аналізу");
  });
  if (!("rows" in pre)) return pre;
  const { report: r, rows } = pre;
  let spent = pre.spentUsd;
  r.state = "ok";

  const segs = new Map<string, { uniqueid: string; turns: Turn[]; callAt: Date | null }>();
  // Час розмови — щоб модель рахувала «завтра» й «у понеділок» від дня дзвінка (рубрика first-touch-v1).
  const t = await db.query<{ id: string; uniqueid: string; segments: Turn[]; calldate: Date | null }>(
    `SELECT t.id::text AS id, t.uniqueid, t.segments, rc.calldate
       FROM call_transcripts t LEFT JOIN ringostat_calls rc ON rc.uniqueid = t.uniqueid
      WHERE t.id = ANY($1::bigint[])`, [rows.map((x) => x.ref)]);
  for (const x of t.rows) segs.set(String(x.id), { uniqueid: x.uniqueid, turns: x.segments ?? [], callAt: x.calldate ? new Date(x.calldate) : null });

  const kinds = new Map<VendorFailureKind, number>();
  let vendorFails = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const src = segs.get(row.ref);
    if (!src || !src.turns.length) {
      await finishRow(db, scope.table, row.id, p.now, "failed", "розшифровка порожня або зникла — аналізувати нічого", false);
      r.failed++;
      continue;
    }
    const body = kit.build(src.turns, p.maxOutputTokens, src.callAt);
    const inBound = inputTokenUpperBound(body);
    const est = inBound * inPrice + p.maxOutputTokens * outPrice;
    const why = overCap(pre, spent, est, 4, "верхня оцінка");
    if (why) {
      await stopRest(db, scope.table, rows.slice(i), p.now, "capped", why, r);
      r.state = "capped";
      r.stoppedBy = why;
      break;
    }
    let out: GeminiOutcome;
    try {
      out = await w.generate(w.apiKey, p.model, body);
    } catch (e) {
      if (!(e instanceof VendorError)) throw e;
      if (ACCOUNT_WIDE.has(e.kind)) {
        await stopRest(db, scope.table, rows.slice(i), p.now, "queued", e.message, r);
        r.state = "stopped";
        r.stoppedBy = `${e.vendor}: ${VENDOR_FAILURE_UA[e.kind]}`;
        throw new Error(`AI-конвеєр (аналіз): порцію зупинено — ${r.stoppedBy}; розшифровки повернуто в чергу`);
      }
      const o = vendorOutcome(e, row.attempts, p.maxAttempts);
      await finishRow(db, scope.table, row.id, p.now, o.status, e.message, o.refund);
      if (o.status === "queued") r.retry++; else r.failed++;
      vendorFails++;
      kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
      continue;
    }
    // Відповідь прийшла — за неї заплачено, навіть якщо вона непридатна. Без `usageMetadata`
    // пишемо ВЕРХНІ межі окремою одиницею: невидима витрата гірша за завищену.
    const inUnits = out.usage ? out.usage.input : inBound;
    const outUnits = out.usage ? out.usage.output : p.maxOutputTokens;
    const unitSuffix = out.usage ? "" : "_bound";
    const v = kit.interpret(out, src.turns);
    const upd = await db.query<{ updated: number }>(
      `WITH l AS (
         INSERT INTO ai_spend_ledger (at, provider, operation, uniqueid, units, unit, unit_price_usd)
         VALUES ($2, $3, $4, $5, $6, $7, $8), ($2, $3, $4, $5, $9, $10, $11) RETURNING id
       ), t AS (
         UPDATE call_analyses SET status = $12, result = $13::jsonb, failure = $14, input_tokens = $15, output_tokens = $16,
                claimed_at = NULL, updated_at = $2
          WHERE id = $1 AND status = 'working' RETURNING id
       )
       SELECT (SELECT count(*) FROM t)::int AS updated, (SELECT count(*) FROM l)::int AS billed`,
      [row.id, p.now.toISOString(), p.provider, p.operation, src.uniqueid,
        inUnits, `input_tokens${unitSuffix}`, inPrice, outUnits, `output_tokens${unitSuffix}`, outPrice,
        v.ok ? "done" : "failed", v.ok ? JSON.stringify(v.result) : null, v.ok ? null : v.why,
        out.usage?.input ?? null, out.usage?.output ?? null]);
    spent += inUnits * inPrice + outUnits * outPrice;
    if (pre.sub) pre.sub.spentUsd += inUnits * inPrice + outUnits * outPrice;
    if (Number(upd.rows[0]?.updated) !== 1) r.lostRace++;
    else if (v.ok) r.done++;
    else r.failed++;
  }
  r.spentUsd = spent;
  if (vendorFails > 0 && r.done === 0 && vendorFails === rows.length) throw portionFailure("аналіз", kinds, rows.length);
  return r;
}
