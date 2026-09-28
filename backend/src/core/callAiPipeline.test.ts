import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./adCallFacts.js";
import { VendorError } from "./callAiHttp.js";
import type { DownloadOutcome } from "./ringostatRecording.js";
import type { GeminiOutcome, SttAudio, SttResult } from "./callAiProviders.js";
import type { AnalysisParams, SttParams } from "./callAiPipeline.js";

/**
 * 🎯 #765–#767, #769 — КОНВЕЄР AI-АНАЛІЗУ НА ЖИВІЙ СХЕМІ (scratch): оплата один раз, без ключа нуль
 * запитів, стеля до виклику, чесні стани, помилка порції без HTTP-кодів, журнал витрат.
 *
 * Постачальники — підставні функції, що рахують виклики: гейт питає «скільки разів ЗАПЛАТИЛИ б»,
 * а не «що повернув API». Один кластер на файл; кожен гейт — свій постачальник і свої дзвінки,
 * тож журнал і черги гейтів не перетинаються. Сесія в UTC — межа київського місяця справжня.
 * Модулі конвеєра імпортуються ліниво: так вимагає правило тестів проти БД.
 */

type Pipeline = typeof import("./callAiPipeline.js");
interface Ctx { db: Db; db2: Db; raw: import("pg").Client; pl: Pipeline }

let ctxP: Promise<Ctx | { unavailable: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });

async function ctx(t: { skip: (m: string) => void }): Promise<Ctx | null> {
  ctxP ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    const { default: pg } = await import("pg");
    const a = new pg.Client({ connectionString: s.url });
    const b = new pg.Client({ connectionString: s.url });
    await a.connect(); await b.connect();
    await a.query("SET TIME ZONE 'UTC'"); await b.query("SET TIME ZONE 'UTC'");
    await a.query(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "schema.sql"), "utf8"));
    dispose = async () => { await a.end().catch(() => {}); await b.end().catch(() => {}); s.dispose(); };
    return { db: a as unknown as Db, db2: b as unknown as Db, raw: a, pl: await import("./callAiPipeline.js") };
  })();
  const c = await ctxP;
  if ("unavailable" in c) { t.skip(c.unavailable); return null; }
  return c;
}

const NOW = new Date("2026-09-22T09:00:00Z");
const MIN = 60_000;

async function seedCalls(c: Ctx, rows: [uniqueid: string, recording: string | null][]): Promise<void> {
  for (const [u, rec] of rows)
    await c.raw.query(`INSERT INTO ringostat_calls (uniqueid, calldate, call_type, billsec, duration, recording)
      VALUES ($1, $2, 'in', 60, 70, $3) ON CONFLICT (uniqueid) DO UPDATE SET recording = EXCLUDED.recording`, [u, NOW.toISOString(), rec]);
}

/** Підставний постачальник: байти запису = його URL; розпізнавання рахує оплати по дзвінку. */
function fakeStt(opts: { sec?: number; failFor?: Map<string, () => VendorError>; delayMs?: number } = {}) {
  const downloads: string[] = [];
  const paid = new Map<string, number>();
  const w = {
    download: async (url: string | null): Promise<DownloadOutcome> => {
      if (url) downloads.push(url);
      if (!url) return { ok: false, unavailable: "no_url" };
      if (url.includes("gone")) return { ok: false, unavailable: "not_found" };
      return { ok: true, bytes: new TextEncoder().encode(url), info: { channels: 2, sampleRate: 8000, bitsPerSample: 16, durationSec: opts.sec ?? 60 } };
    },
    transcribe: async (_key: string, audio: SttAudio): Promise<SttResult> => {
      const url = new TextDecoder().decode(audio.bytes);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const f = opts.failFor?.get(url);
      if (f) throw f();
      paid.set(url, (paid.get(url) ?? 0) + 1);
      return { audioDurationSec: 120, transcriptionId: null, channels: [
        { index: 0, language: "uk", words: [{ text: "Добрий", start: 0, end: 0.5, channel: 0 }, { text: "день", start: 0.5, end: 1, channel: 0 }] },
        { index: 1, language: "uk", words: [{ text: "Скільки", start: 2, end: 2.5, channel: 1 }, { text: "коштує", start: 2.5, end: 3, channel: 1 }] }] };
    },
  };
  return { w, downloads, paid, totalPaid: () => [...paid.values()].reduce((s, n) => s + n, 0) };
}

const sttParams = (provider: string, over: Partial<SttParams> = {}): SttParams => ({
  now: NOW, limit: 10, maxAttempts: 3, stuckAfterMin: 15, monthCapUsd: 40, operation: "stt",
  provider, model: "scribe_v2", usdPerAudioSec: 0.0001, ...over,
});

async function statuses(c: Ctx, provider: string): Promise<Record<string, string>> {
  const r = await c.raw.query<{ uniqueid: string; status: string }>(
    "SELECT uniqueid, status FROM call_transcripts WHERE provider = $1 ORDER BY uniqueid", [provider]);
  return Object.fromEntries(r.rows.map((x) => [x.uniqueid, x.status]));
}
const ledger = async (c: Ctx, provider: string) => (await c.raw.query<{ units: string; unit: string; usd: string | null; uniqueid: string }>(
  "SELECT uniqueid, units, unit, usd FROM ai_spend_ledger WHERE provider = $1 ORDER BY id", [provider])).rows;

/**
 * #765 — ОДИН ДЗВІНОК = ОДНА ОПЛАТА. Два тіки на ДВОХ зʼєднаннях одночасно беруть ту саму чергу —
 * кожен дзвінок розпізнано рівно раз; повторний запуск не платить; повторна постановка в чергу не
 * дублює; завислий `working` повертається в чергу, а після стелі спроб — `failed` із причиною.
 * Оплата й стан — одним оператором: журнал має рівно стільки рядків, скільки `done`.
 * 🧨 Червоніє, якщо прибрати `SKIP LOCKED` / узяття в роботу до виклику або писати журнал окремо.
 */
test("#765 КОНВЕЄР · ЖИВА СХЕМА: два тіки — одна оплата, повтор не платить, завислий повертається", async (t) => {
  const c = await ctx(t); if (!c) return;
  const P = "el-659";
  const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
  await seedCalls(c, ids.map((u) => [u, `https://rec/${u}`]));
  assert.equal(await c.pl.enqueueTranscripts(c.db, ids, P, "scribe_v2", NOW), 6);
  assert.equal(await c.pl.enqueueTranscripts(c.db, [...ids, "a1"], P, "scribe_v2", NOW), 0, "🔴 повторна постановка додала рядки");

  const f = fakeStt({ delayMs: 15 });
  const [r1, r2] = await Promise.all([
    c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { limit: 4 })),
    c.pl.runSttPortion(c.db2, { apiKey: "k", ...f.w }, sttParams(P, { limit: 4 })),
  ]);
  assert.equal(r1.claimed + r2.claimed, 6, "🔴 два тіки разом узяли не всю чергу рівно раз");
  assert.deepEqual([...f.paid.values()], [1, 1, 1, 1, 1, 1], `🔴 дзвінок оплачено двічі: ${JSON.stringify([...f.paid])}`);
  assert.equal(f.paid.size, 6);
  const l = await ledger(c, P);
  assert.equal(l.length, 6, "🔴 рядків журналу не стільки, скільки оплат");
  assert.ok(l.every((x) => Number(x.units) === 120 && x.unit === "audio_sec"), "🔴 одиниці оплати не «тривалість × канали»");
  assert.ok(Math.abs(Number(l[0].usd) - 0.012) < 1e-12);

  const again = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P));
  assert.equal(again.claimed, 0);
  assert.equal(f.totalPaid(), 6, "🔴 повторний запуск заплатив за done");
  const seg = (await c.raw.query<{ segments: unknown }>("SELECT segments FROM call_transcripts WHERE provider=$1 AND uniqueid='a1'", [P])).rows[0].segments;
  assert.deepEqual((seg as { channel: number; text: string }[]).map((x) => [x.channel, x.text]), [[0, "Добрий день"], [1, "Скільки коштує"]]);

  await seedCalls(c, [["s1", "https://rec/s1"], ["s2", "https://rec/s2"]]);
  await c.pl.enqueueTranscripts(c.db, ["s1", "s2"], P, "scribe_v2", NOW);
  const stale = new Date(NOW.getTime() - 20 * MIN).toISOString();
  await c.raw.query("UPDATE call_transcripts SET status='working', claimed_at=$2, attempts=1 WHERE provider=$1 AND uniqueid='s1'", [P, stale]);
  await c.raw.query("UPDATE call_transcripts SET status='working', claimed_at=$2, attempts=3 WHERE provider=$1 AND uniqueid='s2'", [P, stale]);
  const fresh = new Date(NOW.getTime() - 5 * MIN).toISOString();
  await seedCalls(c, [["s3", "https://rec/s3"]]);
  await c.pl.enqueueTranscripts(c.db, ["s3"], P, "scribe_v2", NOW);
  await c.raw.query("UPDATE call_transcripts SET status='working', claimed_at=$2, attempts=1 WHERE provider=$1 AND uniqueid='s3'", [P, fresh]);
  const rs = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P));
  assert.equal(rs.requeuedStuck, 1);
  assert.equal(rs.failedStuck, 1);
  const st = await statuses(c, P);
  assert.equal(st.s1, "done", "🔴 завислий рядок не повернувся в чергу");
  assert.equal(st.s2, "failed", "🔴 рядок після стелі спроб крутиться далі");
  assert.equal(st.s3, "working", "🔴 рядок, що працює 5 хв, забрано як завислий — друга оплата");
  const why = (await c.raw.query<{ failure: string }>("SELECT failure FROM call_transcripts WHERE provider=$1 AND uniqueid='s2'", [P])).rows[0].failure;
  assert.match(why, /стеля спроб/);
});

/**
 * #765b — БЕЗ КЛЮЧА НУЛЬ ЗАПИТІВ НАЗОВНІ. Черга стає `not_enabled` (видно на екрані), жодного
 * завантаження запису, жодного виклику моделі, журнал порожній — і параметри навіть не
 * потрібні. Дзеркало: щойно ключ зʼявився, ті самі рядки розпізнаються.
 * 🧨 Червоніє, якщо перевіряти ключ після завантаження запису або лишати рядки `queued`.
 */
test("#765b БЕЗ КЛЮЧА: нуль запитів, черга «не ввімкнено», з ключем — працює", async (t) => {
  const c = await ctx(t); if (!c) return;
  const P = "el-659b";
  await seedCalls(c, [["b1", "https://rec/b1"], ["b2", "https://rec/b2"]]);
  await c.pl.enqueueTranscripts(c.db, ["b1", "b2"], P, "scribe_v2", NOW);
  const f = fakeStt();
  const r = await c.pl.runSttPortion(c.db, { apiKey: "", ...f.w }, sttParams(P, { monthCapUsd: null, usdPerAudioSec: null }));
  assert.equal(r.state, "not_enabled");
  assert.equal(f.downloads.length + f.totalPaid(), 0, "🔴 без ключа пішли запити назовні");
  assert.deepEqual(await statuses(c, P), { b1: "not_enabled", b2: "not_enabled" });
  assert.equal((await ledger(c, P)).length, 0);

  let gen = 0;
  const an = await c.pl.runAnalysisPortion(c.db, { apiKey: "", generate: async () => { gen++; throw new Error("x"); } },
    { ...sttParams("g-659b"), rubricVersion: "v", sttProvider: P, sttModel: "scribe_v2", maxOutputTokens: 100,
      usdPerInputToken: null, usdPerOutputToken: null } as AnalysisParams);
  assert.equal(an.state, "not_enabled");
  assert.equal(gen, 0, "🔴 без ключа Gemini викликано модель");

  const on = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P));
  assert.equal(on.done, 2, "🔴 з ключем рядки «не ввімкнено» не повернулись у роботу");
  assert.deepEqual(await statuses(c, P), { b1: "done", b2: "done" });
});

/**
 * #766 — СТЕЛЯ ДО ВИКЛИКУ. Немає ціни → «не налаштовано» ДО будь-якого запиту; оцінка виклику
 * понад залишок → `capped` без оплати, спроба повертається; наступного КИЇВСЬКОГО місяця стеля
 * знову відкрита; витрата без ціни в журналі закриває стелю, а не рахується нулем.
 * 🧨 Червоніє, якщо перевіряти стелю ПІСЛЯ виклику, рахувати місяць за UTC чи NULL як 0.
 */
test("#766 СТЕЛЯ: без ціни — не налаштовано, оцінка понад залишок — стоп без оплати, київський місяць", async (t) => {
  const c = await ctx(t); if (!c) return;
  const P = "el-660";
  const ids = ["c1", "c2", "c3"];
  await seedCalls(c, ids.map((u) => [u, `https://rec/${u}`]));
  await c.pl.enqueueTranscripts(c.db, ids, P, "scribe_v2", NOW);
  const f = fakeStt();
  await assert.rejects(c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { usdPerAudioSec: null })), /не налаштовано/);
  await assert.rejects(c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { monthCapUsd: undefined })), /не налаштовано/);
  assert.equal(f.downloads.length, 0, "🔴 без ціни чи стелі пішов запит");
  assert.deepEqual(await statuses(c, P), { c1: "queued", c2: "queued", c3: "queued" }, "🔴 без ціни рядки взято в роботу");

  // Кожен дзвінок: 60 с × 2 канали × 0.0001 = 0.012 USD; стеля 0.02 → вміщається рівно один.
  const r = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { monthCapUsd: 0.02 }));
  assert.equal(r.done, 1);
  assert.equal(r.state, "capped");
  assert.equal(f.totalPaid(), 1, "🔴 оплачено понад стелю");
  assert.deepEqual(Object.values(await statuses(c, P)).sort(), ["capped", "capped", "done"]);
  const att = (await c.raw.query<{ a: number }>("SELECT max(attempts)::int AS a FROM call_transcripts WHERE provider=$1 AND status='capped'", [P])).rows[0].a;
  assert.equal(att, 0, "🔴 стеля «спалила» спробу дзвінка");

  const same = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { monthCapUsd: 0.02, now: new Date("2026-09-30T20:59:00Z") }));
  assert.equal(same.state, "capped");
  assert.equal(f.totalPaid(), 1, "🔴 23:59 за Києвом 30.09 — ще вересень, а стеля відкрилась");
  const next = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { monthCapUsd: 0.02, now: new Date("2026-09-30T21:01:00Z") }));
  assert.equal(next.done, 1, "🔴 00:01 за Києвом 01.10 — новий місяць, а стеля лишилась закритою");
  assert.equal(f.totalPaid(), 2);

  await c.raw.query("INSERT INTO ai_spend_ledger (at, provider, operation, units, unit) VALUES ($1, $2, 'stt', 10, 'audio_sec')",
    ["2026-10-02T09:00:00Z", P]);
  const unp = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P, { now: new Date("2026-10-02T10:00:00Z") }));
  assert.equal(unp.state, "capped");
  assert.match(unp.stoppedBy ?? "", /без ціни/, "🔴 витрату без ціни пораховано нулем");
  assert.equal(f.totalPaid(), 2);
});

/**
 * #766b — ЧЕСНІ СТАНИ Й ПОМИЛКА ПОРЦІЇ. Немає посилання / запис зник → `recording_unavailable`
 * без оплати; порція, де ЖОДЕН дзвінок не дійшов до результату, кидає помилку БЕЗ HTTP-кодів
 * (дзеркало: сирий текст із «HTTP 429» класифікатор справді прочитав би як Kommo), а код лишається
 * в рядку; збій рахунку зупиняє порцію й не палить спроб.
 * 🧨 Червоніє, якщо писати «немає запису» як збій, мовчати на повному провалі або класти код у помилку порції.
 */
test("#766b ЧЕСНІ СТАНИ: немає запису — не збій, повний провал порції — помилка без HTTP-кодів", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { classifyJobError } = await import("../health/jobErrorKind.js");
  const P = "el-660b";
  await seedCalls(c, [["d1", null], ["d2", "https://rec/gone/d2"]]);
  await c.pl.enqueueTranscripts(c.db, ["d1", "d2", "d-no-cdr"], P, "scribe_v2", NOW);
  const f = fakeStt();
  const r = await c.pl.runSttPortion(c.db, { apiKey: "k", ...f.w }, sttParams(P));
  assert.equal(r.unavailable, 3);
  assert.equal(f.totalPaid(), 0);
  assert.deepEqual(await statuses(c, P), { "d-no-cdr": "recording_unavailable", d1: "recording_unavailable", d2: "recording_unavailable" });
  assert.equal((await ledger(c, P)).length, 0, "🔴 за відсутній запис записано витрату");

  const P2 = "el-660b-429";
  await seedCalls(c, [["e1", "https://rec/e1"], ["e2", "https://rec/e2"]]);
  await c.pl.enqueueTranscripts(c.db, ["e1", "e2"], P2, "scribe_v2", NOW);
  const rl = () => new VendorError("ElevenLabs", "rate_limit", 429, "rate_limit_exceeded");
  const busy = fakeStt({ failFor: new Map([["https://rec/e1", rl], ["https://rec/e2", rl]]) });
  const err = await c.pl.runSttPortion(c.db, { apiKey: "k", ...busy.w }, sttParams(P2)).then(() => null, (e: Error) => e);
  assert.ok(err, "🔴 порція, де все впало, повернулась «успіхом» — джоба лишилась би зеленою");
  assert.ok(!/\b(403|429)\b/.test(err.message), `🔴 HTTP-код у помилці порції: ${err.message}`);
  assert.notEqual(classifyJobError(err.message), "kommo_http", "🔴 помилку постачальника AI прочитано як відмову Kommo");
  assert.equal(classifyJobError(rl().message), "kommo_http", "дзеркало: сирий текст постачальника класифікатор плутає — інакше гейт вище нічого не доводить");
  const rows = (await c.raw.query<{ status: string; attempts: number; failure: string }>(
    "SELECT status, attempts, failure FROM call_transcripts WHERE provider=$1 ORDER BY uniqueid", [P2])).rows;
  assert.ok(rows.every((x) => x.status === "queued" && x.attempts === 1 && /HTTP 429/.test(x.failure)), `🔴 ${JSON.stringify(rows)}`);
  await c.pl.runSttPortion(c.db, { apiKey: "k", ...busy.w }, sttParams(P2)).catch(() => {});
  await c.pl.runSttPortion(c.db, { apiKey: "k", ...busy.w }, sttParams(P2)).catch(() => {});
  assert.deepEqual(Object.values(await statuses(c, P2)), ["failed", "failed"], "🔴 після стелі спроб рядок крутиться далі");

  const P3 = "el-660b-auth";
  await seedCalls(c, [["g1", "https://rec/g1"], ["g2", "https://rec/g2"]]);
  await c.pl.enqueueTranscripts(c.db, ["g1", "g2"], P3, "scribe_v2", NOW);
  const auth = () => new VendorError("ElevenLabs", "auth", 401);
  const deny = fakeStt({ failFor: new Map([["https://rec/g1", auth], ["https://rec/g2", auth]]) });
  const e3 = await c.pl.runSttPortion(c.db, { apiKey: "k", ...deny.w }, sttParams(P3)).then(() => null, (e: Error) => e);
  assert.match(e3?.message ?? "", /ключ відхилено/);
  assert.equal(deny.downloads.length, 1, "🔴 після відмови ключа порція пішла качати наступні записи");
  const g = (await c.raw.query<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM call_transcripts WHERE provider=$1 ORDER BY uniqueid", [P3])).rows;
  assert.deepEqual(g, [{ status: "queued", attempts: 0 }, { status: "queued", attempts: 0 }], "🔴 збій рахунку спалив спроби дзвінків");
});

/**
 * #767 — АНАЛІЗ: у чергу йдуть лише готові непорожні розшифровки ТОГО розпізнавання; журнал
 * пише вхід і вихід (вихід разом із думками); непридатна відповідь — `failed`, але оплачена;
 * без `usageMetadata` пишуться ВЕРХНІ межі окремою одиницею; стеля по верхній межі — до виклику.
 * 🧨 Червоніє, якщо не писати журнал на непридатній відповіді чи ставити в чергу порожні розмови.
 */
test("#767 АНАЛІЗ · ЖИВА СХЕМА: черга лише з непорожніх, журнал вхід+вихід, непридатне — оплачене, стеля", async (t) => {
  const c = await ctx(t); if (!c) return;
  const S = "el-661", G = "g-661";
  const turns = JSON.stringify([{ channel: 0, start: 0, end: 2, text: "Порахую і передзвоню завтра", lang: "uk" }]);
  const ins = async (u: string, provider: string, status: string, segments: string | null) =>
    (await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts (uniqueid, provider, model, status, segments)
      VALUES ($1, $2, 'scribe_v2', $3, $4::jsonb) RETURNING id`, [u, provider, status, segments])).rows[0].id;
  await ins("h1", S, "done", turns);
  await ins("h2", S, "done", turns);
  await ins("h3", S, "done", turns);
  await ins("h-empty", S, "done", "[]");
  await ins("h-failed", S, "failed", null);
  await ins("h-other", "el-other", "done", turns);
  const ap = { provider: G, model: "gemini-3.8-flash", rubricVersion: "pilot-v0", sttProvider: S, sttModel: "scribe_v2", now: NOW };
  assert.equal(await c.pl.enqueueAnalyses(c.db, ap, null), 3, "🔴 у чергу аналізу потрапили порожні, провалені чи чужі розшифровки");
  assert.equal(await c.pl.enqueueAnalyses(c.db, ap, null), 0);

  const good = JSON.stringify({ summary: "s", manager_channel: "0", client_request: "", price: { discussed: false, quote: "" },
    objections: [], promises: [{ who: "manager", what: "передзвонити", deadline_text: "завтра", quote: "передзвоню завтра" }], next_step: "" });
  const answers: GeminiOutcome[] = [
    { text: good, finishReason: "STOP", blockReason: null, usage: { input: 800, output: 350, thoughts: 250 } },
    { text: good.slice(0, 30), finishReason: "MAX_TOKENS", blockReason: null, usage: { input: 800, output: 2048, thoughts: 2000 } },
    { text: good, finishReason: "STOP", blockReason: null, usage: null },
  ];
  let calls = 0;
  const w = { apiKey: "k", generate: async (): Promise<GeminiOutcome> => answers[calls++] };
  const p: AnalysisParams = { ...ap, limit: 10, maxAttempts: 3, stuckAfterMin: 15, monthCapUsd: 10, operation: "analysis",
    maxOutputTokens: 2048, usdPerInputToken: 0.75e-6, usdPerOutputToken: 3.75e-6 };
  const r = await c.pl.runAnalysisPortion(c.db, w, p);
  assert.equal(calls, 3);
  assert.deepEqual([r.done, r.failed], [2, 1]);
  const rows = (await c.raw.query<{ status: string; failure: string | null; result: { promises: { quote_found: boolean }[] } | null; output_tokens: number | null }>(
    "SELECT a.status, a.failure, a.result, a.output_tokens FROM call_analyses a JOIN call_transcripts t ON t.id=a.transcript_id WHERE a.provider=$1 ORDER BY t.uniqueid", [G])).rows;
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].result?.promises[0].quote_found, true, "🔴 цитату не звірено з розшифровкою");
  assert.equal(rows[0].output_tokens, 350);
  assert.equal(rows[1].status, "failed");
  assert.match(rows[1].failure ?? "", /MAX_TOKENS/);
  const l = await ledger(c, G);
  assert.equal(l.length, 6, "🔴 оплачена, але непридатна відповідь не потрапила в журнал");
  assert.deepEqual(l.map((x) => x.unit), ["input_tokens", "output_tokens", "input_tokens", "output_tokens", "input_tokens_bound", "output_tokens_bound"]);
  assert.equal(Number(l[1].units), 350, "🔴 вихід без думок");
  assert.equal(Number(l[5].units), 2048, "🔴 без usageMetadata витрату не видно");

  assert.equal((await c.pl.runAnalysisPortion(c.db, w, p)).claimed, 0);
  assert.equal(calls, 3, "🔴 повторний запуск заплатив за готовий аналіз");

  await ins("h4", S, "done", turns);
  await c.pl.enqueueAnalyses(c.db, ap, ["h4"]);
  const tight = await c.pl.runAnalysisPortion(c.db, w, { ...p, monthCapUsd: (await c.pl.monthSpend(c.db, G, NOW)).usd + 0.001 });
  assert.equal(tight.state, "capped", "🔴 верхня межа виклику понад залишок, а модель викликано");
  assert.equal(calls, 3);
});

/**
 * #769 — ВИБІРКА ПІЛОТА НА ЖИВІЙ СХЕМІ: перша РОЗМОВА (від порогу) кожної рекламної угоди, прапорець
 * відбирає рівно своїх, свіжі угоди першими, ознака запису чесна. Незалежна звірка: множина угод
 * пілота == угоди зі станом «talked» у фактах на тих самих даних — інший запит над тією ж звʼязкою.
 * SQL у шаблонному рядку компілятор не перевіряє — тому він біжить тут, а не лише проти підставної бази.
 * 🧨 Червоніє, якщо брати перший ДЗВІНОК замість першої розмови чи ігнорувати прапорець.
 */
test("#769 ПІЛОТ · ЖИВА СХЕМА: перша розмова рекламної угоди, прапорець, запис, == «talked» фактів", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { planPilot, parsePilotArgs } = await import("./callAiPilot.js");
  const { adCallFacts } = await import("./adCallFacts.js");
  const deal = (id: number, ch: string | null, src: string | null, key: string, created: string) =>
    c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,client_source)
      VALUES ($1,$2,8921932,1,$3,$4,$5,$6)`, [id, `D${String(id)}`, created, key, ch, src]);
  const call = (u: string, at: string, sec: number, phone: string, rec: string | null) =>
    c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,client_phone,recording)
      VALUES ($1,$2,'in','ANSWERED',$3,$4,$5,$6)`, [u, at, sec, sec + 10, phone, rec]);
  await deal(6301, "ad", null, "0501111111", "2026-09-10 10:00:00+03");
  await deal(6302, null, "uts.ua", "0502222222", "2026-09-11 10:00:00+03");
  await deal(6303, "ad", null, "0503333333", "2026-09-12 10:00:00+03");
  await deal(6304, "other", "organic", "0504444444", "2026-09-13 10:00:00+03");
  await deal(6305, "ad", null, "0505555555", "2026-10-01 10:00:00+03");
  await call("p1", "2026-09-10 10:05:00+03", 15, "380501111111", "https://rec/p1");  // спроба, не розмова
  await call("p2", "2026-09-10 10:30:00+03", 35, "380501111111", "https://rec/p2");  // перша розмова
  await call("p3", "2026-09-10 11:00:00+03", 50, "380501111111", "https://rec/p3");
  await call("p4", "2026-09-11 10:10:00+03", 25, "380502222222", null);              // розмова без запису
  await call("p5", "2026-09-12 10:10:00+03", 10, "380503333333", "https://rec/p5");  // лише спроба
  await call("p6", "2026-09-13 10:10:00+03", 90, "380504444444", "https://rec/p6");  // не реклама
  await call("p7", "2026-10-01 10:10:00+03", 90, "380505555555", "https://rec/p7");  // поза періодом

  const ad = { predicate: (r: string) => `(d.client_source = ANY(${r}))`, adSources: ["uts.ua"] };
  const argv = (flag: string, limit = 10) => ["--from=2026-09-01", "--to=2026-09-30", `--limit=${String(limit)}`,
    "--talk-min-sec=20", "--window-before=1 days", `--flag=${flag}`];
  const now = new Date("2026-10-05T09:00:00Z");
  const plan = async (flag: string, limit?: number) => planPilot(c.db, parsePilotArgs(argv(flag, limit), () => "/dev/null"), ad, now);

  const either = await plan("either");
  assert.deepEqual(either.rows.map((r) => [r.kommoId, r.uniqueid, r.hasRecording]), [[6302, "p4", false], [6301, "p2", true]],
    "🔴 не перша розмова, не той порядок або ознака запису бреше");
  assert.deepEqual((await plan("lead_channel")).rows.map((r) => r.kommoId), [6301], "🔴 прапорець lead_channel пропустив чужих");
  assert.deepEqual((await plan("ad_deal_sql")).rows.map((r) => r.kommoId), [6302], "🔴 прапорець ad_deal_sql пропустив чужих");
  assert.deepEqual((await plan("either", 1)).rows.map((r) => r.kommoId), [6302], "🔴 межа вибірки не з найсвіжіших");
  assert.equal(either.audioSec, 45 + 35);

  const facts = await adCallFacts(c.db, { from: "2026-09-01", to: "2026-09-30", now, talkMinSec: 20, windowBefore: "1 days",
    adDealPredicate: ad.predicate, adSources: ad.adSources });
  const talked = facts.filter((f) => f.state === "talked").map((f) => f.kommoId).sort();
  assert.ok(talked.length > 0, "🔴 фактам не було що знаходити — звірка нижче порожня");
  assert.deepEqual(either.rows.map((r) => r.kommoId).sort(), talked, "🔴 вибірка пілота розійшлась із фактами на тих самих даних");
});
