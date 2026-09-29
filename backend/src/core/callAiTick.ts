import type { Db } from "./adCallFacts.js";
import { adDealFirstTalksSql, type AdFlag, type FirstTalkRow } from "./adCallFactsRules.js";
import { createMinInterval, type HttpDeps } from "./callAiHttp.js";
import { downloadRecording } from "./ringostatRecording.js";
import { ELEVENLABS_STT_MODEL, elevenLabsTranscribe, GEMINI_MODEL, geminiGenerate, RUBRIC_CURRENT } from "./callAiProviders.js";
import { dequeueOutside, enqueueAnalyses, enqueueTranscripts, runAnalysisPortion, runSttPortion, type PortionReport } from "./callAiPipeline.js";
import { LLM_POLICY, LLM_PROVIDER, RECORDING_MAX_BYTES, RINGOSTAT_MIN_INTERVAL_MS, RINGOSTAT_POLICY, STT_POLICY,
  STT_PROVIDER, STUCK_AFTER_MIN, type AdPredicate } from "./callAiPilot.js";

/**
 * ⏰ ОДИН ТІК AI-АНАЛІЗУ: знайти дзвінки першого дотику → черга → розпізнати → проаналізувати.
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах», коміт ④. Логіка тут, без пулу; обгортка з пулом,
 * налаштуваннями й охоронцем — `jobs/callAiJob.ts`. Так само влаштовано пропущені дзвінки.
 *
 * ⚖️ ЩО ТАКЕ «ДЗВІНОК ПЕРШОГО ДОТИКУ» — рішення Романа 28.09.2026 («роби з рекомендованими»),
 * записане в METRICS_GLOSSARY §15. Заміряно того ж дня за 30 днів: 1 107 розмов, ≈$22/міс.
 *   • перша РОЗМОВА рекламної угоди, у БУДЬ-ЯКОМУ напрямку: 87% перших контактів — передзвін
 *     на заявку, тож «лише вхідні» (як описано в uts-bot) відрізали б більшу частину реклами;
 *   • реклама = будь-яка з двох ознак (`lead_channel='ad'` АБО правило Звіту `adDealSql`);
 *   • розмова — від 20 с; дзвінок за добу до створення угоди теж її (з нього угоду й заводять).
 *
 * 🔁 ПЕРЕЗАПОВНЕННЯ БЕЗ ОКРЕМОГО РЕЖИМУ. Кожен тік бере угоди, створені за останні 30 днів:
 * перший тік підбирає весь хвіст, наступні — лише нове. Постановка в чергу ідемпотентна
 * (`UNIQUE` + `DO NOTHING`), тож повтор нічого не оплачує вдруге. Старше 30 днів не береться.
 *
 * ⏱ ПОРЦІЇ ДРІБНІ, А ТІК ОБМЕЖЕНИЙ ЧАСОМ. Узятий у роботу рядок чекає своєї черги в порції; якщо
 * порція довша за `STUCK_AFTER_MIN`, його забрали б як завислий і заплатили б удруге. Тому
 * порція — 10 дзвінків (≤10 хв навіть по 60 с), а тік крутить порції, доки не вийде час.
 */
export const FIRST_TOUCH_RULE: Readonly<{ talkMinSec: number; windowBefore: string; flag: AdFlag; lookbackDays: number; startDate: string }> = {
  talkMinSec: 20,
  windowBefore: "1 days",
  flag: "either",
  lookbackDays: 30,
  /** Рішення власника 28.09.2026: аналізуємо угоди, створені З 20.09.2026 (Київ). Раніші не беруться. */
  startDate: "2026-09-20",
};

/** Перший день вибірки: пізніший із дати старту й «сьогодні − lookbackDays» (Київ, YYYY-MM-DD). */
export function selectionFrom(now: Date): string {
  const rolling = kyivDateOf(new Date(now.getTime() - FIRST_TOUCH_RULE.lookbackDays * 86_400_000));
  return rolling > FIRST_TOUCH_RULE.startDate ? rolling : FIRST_TOUCH_RULE.startDate;
}

export const TICK_PORTION = 10;
export const TICK_MAX_ATTEMPTS = 3;
/** Час на розпізнавання й на аналіз в одному тіку. Разом менше за годину між тіками й за `MAX_RUN_MS`. */
export const STT_BUDGET_MS = 8 * 60_000;
export const LLM_BUDGET_MS = 4 * 60_000;
export const MAX_OUTPUT_TOKENS = 2048;

/** Київська дата моменту — `sv-SE` дає рівно YYYY-MM-DD (як `kyivToday`, але для заданого «зараз»). */
export const kyivDateOf = (d: Date): string => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

/** Дзвінки першого дотику від `selectionFrom` до сьогодні (дата створення угоди, за Києвом, обидва кінці). */
export async function selectFirstTouchCalls(db: Db, ad: AdPredicate, now: Date): Promise<string[]> {
  const from = selectionFrom(now);
  const q = adDealFirstTalksSql({ from, to: kyivDateOf(now), now, talkMinSec: FIRST_TOUCH_RULE.talkMinSec,
    windowBefore: FIRST_TOUCH_RULE.windowBefore, adDealPredicate: ad.predicate, adSources: ad.adSources },
  FIRST_TOUCH_RULE.flag, 5000);
  return (await db.query<FirstTalkRow>(q.sql, q.params)).rows.map((r) => r.uniqueid);
}

/**
 * Порції, доки черга не спорожніє, не вийде час або порція не зупиниться. Повертає причину
 * зупинки (`null` — черга скінчилась або час вийшов штатно) і помилку, якщо порція кинула.
 */
export async function drainWithBudget(run: () => Promise<PortionReport>, budgetMs: number, nowMs: () => number,
  into: PortionReport[]): Promise<{ stoppedBy: string | null; error: Error | null }> {
  const deadline = nowMs() + budgetMs;
  while (nowMs() < deadline) {
    let r: PortionReport;
    try { r = await run(); } catch (e) { return { stoppedBy: (e as Error).message, error: e as Error }; }
    into.push(r);
    if (r.state === "idle" || (r.state === "ok" && r.claimed === 0)) return { stoppedBy: null, error: null };
    if (r.state !== "ok") return { stoppedBy: r.stoppedBy ?? r.state, error: null };
  }
  return { stoppedBy: null, error: null };
}

export interface TickPrices {
  sttUsdPerHour: number | null;
  sttMonthCapUsd: number | null;
  llmUsdPerMtokIn: number | null;
  llmUsdPerMtokOut: number | null;
  llmMonthCapUsd: number | null;
}

export interface TickEnv {
  db: Db;
  http: HttpDeps;
  keys: { elevenlabs: string; gemini: string };
  ad: AdPredicate;
  prices: TickPrices;
  now: () => Date;
}

export interface TickReport {
  selected: number;
  enqueued: number;
  /** Прибрано з черги: дзвінки, що випали з вибірки (раніше дати старту або старші за вікно), без жодної спроби. */
  dequeued: number;
  stt: PortionReport[];
  llm: PortionReport[];
  sttStoppedBy: string | null;
  llmStoppedBy: string | null;
}

/**
 * Один тік. Розпізнавання й аналіз ідуть незалежно: вичерпана квота ElevenLabs не заважає
 * проаналізувати вже готові розшифровки. Якщо хоч одна половина КИНУЛА — тік кидає наприкінці
 * (джоба червона в `job_runs`), але лише після того, як друга половина відпрацювала.
 * Без ключа — не помилка: рядки «не ввімкнено», і назовні не йде жодного запиту.
 */
export async function runCallAiTick(env: TickEnv): Promise<TickReport> {
  const t0 = env.now();
  const ids = await selectFirstTouchCalls(env.db, env.ad, t0);
  const enqueued = await enqueueTranscripts(env.db, ids, STT_PROVIDER, ELEVENLABS_STT_MODEL, t0);
  const dequeued = await dequeueOutside(env.db, ids, STT_PROVIDER, ELEVENLABS_STT_MODEL);
  const out: TickReport = { selected: ids.length, enqueued, dequeued, stt: [], llm: [], sttStoppedBy: null, llmStoppedBy: null };
  const throttle = createMinInterval(RINGOSTAT_MIN_INTERVAL_MS, env.http);
  const common = { limit: TICK_PORTION, maxAttempts: TICK_MAX_ATTEMPTS, stuckAfterMin: STUCK_AFTER_MIN };

  const stt = await drainWithBudget(() => runSttPortion(env.db, {
    apiKey: env.keys.elevenlabs,
    download: async (url) => { await throttle(); return downloadRecording(env.http, url, { ...RINGOSTAT_POLICY, maxBytes: RECORDING_MAX_BYTES }); },
    transcribe: (key, audio) => elevenLabsTranscribe(env.http, key, audio, STT_POLICY),
  }, {
    ...common, now: env.now(), operation: "stt", provider: STT_PROVIDER, model: ELEVENLABS_STT_MODEL,
    monthCapUsd: env.prices.sttMonthCapUsd,
    usdPerAudioSec: env.prices.sttUsdPerHour == null ? null : env.prices.sttUsdPerHour / 3600,
  }), STT_BUDGET_MS, env.http.nowMs, out.stt);
  out.sttStoppedBy = stt.stoppedBy;

  const ap = { provider: LLM_PROVIDER, model: GEMINI_MODEL, rubricVersion: RUBRIC_CURRENT,
    sttProvider: STT_PROVIDER, sttModel: ELEVENLABS_STT_MODEL };
  await enqueueAnalyses(env.db, { ...ap, now: env.now() }, null);
  const llm = await drainWithBudget(() => runAnalysisPortion(env.db, {
    apiKey: env.keys.gemini,
    generate: (key, model, body) => geminiGenerate(env.http, key, model, body, LLM_POLICY),
  }, {
    ...common, ...ap, now: env.now(), operation: "analysis", monthCapUsd: env.prices.llmMonthCapUsd,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    usdPerInputToken: env.prices.llmUsdPerMtokIn == null ? null : env.prices.llmUsdPerMtokIn / 1e6,
    usdPerOutputToken: env.prices.llmUsdPerMtokOut == null ? null : env.prices.llmUsdPerMtokOut / 1e6,
  }), LLM_BUDGET_MS, env.http.nowMs, out.llm);
  out.llmStoppedBy = llm.stoppedBy;

  const errs = [stt.error, llm.error].filter((e): e is Error => e != null);
  if (errs.length) throw new Error(errs.map((e) => e.message).join(" · "));
  return out;
}
