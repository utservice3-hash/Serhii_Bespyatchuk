import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createMinInterval, fetchWithRetry, kindFromBody, redactUrl, scrubText, VendorError, type HttpDeps, type RetryPolicy } from "./callAiHttp.js";
import { downloadRecording, wavInfo } from "./ringostatRecording.js";
import {
  ANALYSIS_SCHEMA, buildAnalysisRequest, ELEVENLABS_STT_URL, elevenLabsTranscribe, geminiGenerate, inputTokenUpperBound,
  interpretAnalysis, parseGeminiResponse, parseSttResponse, toTurns, verifyQuotes, type Turn,
} from "./callAiProviders.js";
import { ParamNotSetError } from "./adCallFactsRules.js";
import { parsePilotArgs, planPilot, planToJsonl, runUntilDrained } from "./callAiPilot.js";
import type { PortionReport } from "./callAiPipeline.js";

/**
 * 🎯 #760–#764, #768 — AI-АНАЛІЗ ДЗВІНКІВ, коміт ③: HTTP, запис Ringostat, адаптери, пілот.
 * Без мережі й без бази: `fetch`, `sleep` і годинник — підставні, тож повтори, таймаути й 429
 * перевіряються за мілісекунди, а жоден байт нікуди не йде.
 */

const KEY = "fake_test_key_0123456789abcdefghijklmnop";
const REC = "https://app.ringostat.com/recordings/1758612345.123456";
const FAST: RetryPolicy = { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000, timeoutMs: 1_000 };

interface Call { url: string; init: RequestInit }
function fakeHttp(responses: (() => Response | Promise<Response>)[]): { deps: HttpDeps; calls: Call[]; sleeps: number[] } {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const deps: HttpDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const r = responses[Math.min(i++, responses.length - 1)];
      return r();
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    nowMs: () => 1_700_000_000_000,
  };
  return { deps, calls, sleeps };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Синтетичний WAV: PCM, `channels` × `bits`, `sec` секунд. `declared` — що написати в розмір `data`. */
function wav(sec: number, channels = 2, sampleRate = 8000, bits = 16, declared?: number): Uint8Array<ArrayBuffer> {
  const byteRate = sampleRate * channels * (bits / 8);
  const data = Math.round(sec * byteRate);
  const b = new Uint8Array(44 + data);
  const dv = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let k = 0; k < 4; k++) b[o + k] = s.charCodeAt(k); };
  put(0, "RIFF"); dv.setUint32(4, 36 + data, true); put(8, "WAVE");
  put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, byteRate, true); dv.setUint16(32, channels * (bits / 8), true);
  dv.setUint16(34, bits, true);
  put(36, "data"); dv.setUint32(40, declared ?? data, true);
  return b;
}

/**
 * #760 — ДОСТУП НЕ ТЕЧЕ В ПОМИЛКИ. Відповідь постачальника, що відлунює ключ і URL запису, і
 * мережева помилка з URL у `cause` — у тексті й у повному `util.inspect` немає ні ключа, ні
 * шляху запису. Дзеркало: справжня причина («insufficient_credits») доживає до тексту.
 * 🧨 Червоніє, якщо прибрати `scrubText` з тіла відповіді або пробросити `cause`.
 */
test("#760 ПОМИЛКИ БЕЗ ДОСТУПУ: ключ і URL запису не потрапляють ні в текст, ні в inspect", async () => {
  const echo = fakeHttp([json({ detail: { code: "insufficient_credits", message: `key ${KEY} for ${REC} has no credits` } }, 402)]);
  const e1 = await fetchWithRetry(echo.deps, { vendor: "ElevenLabs", url: ELEVENLABS_STT_URL, init: () => ({}), secrets: [KEY] }, FAST)
    .then(() => null, (e: unknown) => e);
  assert.ok(e1 instanceof VendorError, "🔴 402 не дав VendorError");
  assert.equal(e1.kind, "payment");
  const net = fakeHttp([() => { throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${REC}?token=${KEY}`) }); }]);
  const e2 = await fetchWithRetry(net.deps, { vendor: "Ringostat (запис)", url: REC, init: () => ({}) }, { ...FAST, maxRetries: 0 })
    .then(() => null, (e: unknown) => e);
  assert.ok(e2 instanceof VendorError && e2.kind === "network");
  for (const e of [e1, e2]) {
    const all = `${e.message}\n${inspect(e, { depth: 20, showHidden: true })}`;
    assert.ok(!all.includes(KEY), `🔴 ключ у помилці: ${all}`);
    assert.ok(!all.includes("/recordings/1758612345"), `🔴 шлях запису в помилці: ${all}`);
    assert.equal((e as { cause?: unknown }).cause, undefined, "🔴 cause проброшено — inspect розгорне його");
  }
  assert.match(e1.message, /insufficient_credits/, "🔴 очищення зʼїло справжню причину — помилка стала німою");
  assert.equal(redactUrl(REC), "[url app.ringostat.com]");
  assert.equal(scrubText(`a ${KEY} b`, []), "a […] b", "🔴 довгий токен без назви пройшов");
});

/**
 * #761 — ПОВТОРИ: 429 чекає рівно `Retry-After`, без нього — експонента під стелею; 4xx не
 * повторюється; вичерпані повтори → вид помилки; таймаут → `timeout`; проміжок між записами.
 * 🧨 Червоніє, якщо повторювати 400/401, ігнорувати `Retry-After` чи зняти `maxDelayMs`.
 */
test("#761 ПОВТОРИ: Retry-After, експонента під стелею, 4xx без повтору, таймаут, проміжок між записами", async () => {
  const ra = fakeHttp([json({}, 429, { "retry-after": "7" }), json({ ok: 1 })]);
  const r = await fetchWithRetry(ra.deps, { vendor: "V", url: "https://x/y", init: () => ({}) }, { ...FAST, maxDelayMs: 10_000 });
  assert.equal(r.status, 200);
  assert.deepEqual(ra.sleeps, [7000], "🔴 пауза не з Retry-After");
  assert.equal(ra.calls.length, 2);

  const exp = fakeHttp([json({}, 503), json({}, 503), json({}, 503), json({}, 503)]);
  await assert.rejects(fetchWithRetry(exp.deps, { vendor: "V", url: "https://x/y", init: () => ({}) }, { ...FAST, maxRetries: 3, maxDelayMs: 250 }),
    (e: unknown) => e instanceof VendorError && e.kind === "server");
  assert.deepEqual(exp.sleeps, [100, 200, 250], "🔴 експонента не та або без стелі");
  assert.equal(exp.calls.length, 4, "🔴 спроб не 1 + maxRetries");

  for (const [status, kind] of [[400, "bad_input"], [401, "auth"], [403, "auth"], [402, "payment"]] as const) {
    const h = fakeHttp([json({}, status), json({ ok: 1 })]);
    await assert.rejects(fetchWithRetry(h.deps, { vendor: "V", url: "https://x/y", init: () => ({}) }, FAST),
      (e: unknown) => e instanceof VendorError && e.kind === kind);
    assert.equal(h.calls.length, 1, `🔴 ${String(status)} повторено — повтор не лікує ${kind}`);
  }

  const hang: HttpDeps = {
    fetch: ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as typeof fetch,
    sleep: async () => {}, nowMs: () => 0,
  };
  await assert.rejects(fetchWithRetry(hang, { vendor: "V", url: "https://x/y", init: () => ({}) }, { ...FAST, maxRetries: 0, timeoutMs: 20 }),
    (e: unknown) => e instanceof VendorError && e.kind === "timeout");

  let clock = 1000;
  const waits: number[] = [];
  const gate = createMinInterval(1500, { nowMs: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await gate(); clock += 400; await gate(); clock += 2000; await gate();
  assert.deepEqual(waits, [1100], "🔴 проміжок між запитами до Ringostat не тримається");
});

/**
 * #762 — ЗАПИС RINGOSTAT: тривалість і канали — із заголовка WAV; «запису немає» — шість різних
 * причин, і жодна не є збоєм; стеля розміру зупиняє читання НА стелі, а не після.
 * 🧨 Червоніє, якщо читати весь потік до перевірки розміру або злити причини в одну.
 */
test("#762 ЗАПИС: WAV-заголовок, шість чесних причин відсутності, стеля зупиняє читання", async () => {
  const w = wavInfo(wav(2, 2));
  assert.deepEqual(w && { c: w.channels, sr: w.sampleRate, d: w.durationSec }, { c: 2, sr: 8000, d: 2 });
  assert.equal(wavInfo(wav(3, 2, 8000, 16, 0xffffffff))?.durationSec, 3, "🔴 потоковий WAV: тривалість не з фактичних байтів");
  assert.equal(wavInfo(new TextEncoder().encode("ID3……mp3")), null);

  const opts = { ...FAST, maxRetries: 1, maxBytes: 100_000 };
  const none = fakeHttp([json({})]);
  assert.deepEqual(await downloadRecording(none.deps, null, opts), { ok: false, unavailable: "no_url" });
  assert.equal(none.calls.length, 0, "🔴 без URL пішов запит");
  const nf = fakeHttp([json({}, 404)]);
  assert.deepEqual(await downloadRecording(nf.deps, REC, opts), { ok: false, unavailable: "not_found" });
  const big = fakeHttp([() => new Response(wav(1), { headers: { "content-length": "999999" } })]);
  assert.deepEqual(await downloadRecording(big.deps, REC, opts), { ok: false, unavailable: "too_large" });

  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(40_000)); } });
  const stream = fakeHttp([() => new Response(endless)]);
  assert.deepEqual(await downloadRecording(stream.deps, REC, opts), { ok: false, unavailable: "too_large" });
  assert.ok(pulled <= 4, `🔴 читання не зупинилось на стелі: ${String(pulled)} шматків по 40 КБ при стелі 100 КБ`);

  const empty = fakeHttp([() => new Response(new Uint8Array(0))]);
  assert.deepEqual(await downloadRecording(empty.deps, REC, opts), { ok: false, unavailable: "empty" });
  const mp3 = fakeHttp([() => new Response(new TextEncoder().encode("ID3 not a wav at all"))]);
  assert.deepEqual(await downloadRecording(mp3.deps, REC, opts), { ok: false, unavailable: "not_wav" });
  const long = fakeHttp([() => new Response(wav(3601, 1, 1, 8))]);
  assert.deepEqual(await downloadRecording(long.deps, REC, { ...opts, maxBytes: 10_000 }), { ok: false, unavailable: "too_long" });

  const flaky = fakeHttp([json({}, 503), () => new Response(wav(2))]);
  const ok = await downloadRecording(flaky.deps, REC, opts);
  assert.ok(ok.ok && ok.info.channels === 2 && ok.info.durationSec === 2, "🔴 справжній запис після повтору не прийшов");
  await assert.rejects(downloadRecording(fakeHttp([json({}, 503)]).deps, REC, { ...opts, maxRetries: 0 }),
    (e: unknown) => e instanceof VendorError && e.kind === "server", "🔴 5xx записано як «запису немає» — це збій, а не відсутність");
});

/**
 * #763 — ELEVENLABS: ключ лише заголовком, multichannel увімкнено й diarize вимкнено; канал слова —
 * з `words[].channel_index` (у прикладі документації верхнього поля немає), запасний шлях —
 * верхній `channel_index`, далі позиція; моно — одноканальна форма; репліки — у порядку часу.
 * 🧨 Червоніє, якщо брати канал лише з верхнього поля або склеювати слова різних каналів.
 */
test("#763 ELEVENLABS: запит по каналах із ключем у заголовку, канал слова, моно, репліки в часі", async () => {
  const h = fakeHttp([json({ transcripts: [{ language_code: "uk", text: "", words: [] }] })]);
  await elevenLabsTranscribe(h.deps, KEY, { bytes: wav(1), contentType: "audio/wav" }, FAST);
  assert.equal(h.calls[0].url, ELEVENLABS_STT_URL, "🔴 ключ або параметри в URL");
  assert.equal(new Headers(h.calls[0].init.headers).get("xi-api-key"), KEY);
  const fd = h.calls[0].init.body as FormData;
  assert.equal(fd.get("model_id"), "scribe_v2");
  assert.equal(fd.get("use_multi_channel"), "true", "🔴 розпізнавання не по каналах");
  assert.equal(fd.get("diarize"), "false", "🔴 diarize з multichannel — документація забороняє");
  assert.ok(fd.get("file") instanceof Blob);

  const multi = parseSttResponse({
    audio_duration_secs: 20,
    // Канал 1 ПЕРШИМ у масиві: інакше «канал = позиція» збігався б із правдою і гейт мовчав би.
    transcripts: [
      { language_code: "ru", words: [
        { text: "Здравствуйте", type: "word", start: 1.0, end: 1.6, channel_index: 1 },
        { text: "(сміх)", type: "audio_event", start: 1.7, end: 1.9, channel_index: 1 }] },
      { language_code: "uk", words: [
        { text: "Добрий", type: "word", start: 0.1, end: 0.4, channel_index: 0 },
        { text: " ", type: "spacing", start: 0.4, end: 0.5, channel_index: 0 },
        { text: "день", type: "word", start: 0.5, end: 0.8, channel_index: 0 },
        { text: "Скільки", type: "word", start: 3.0, end: 3.3, channel_index: 0 }] },
    ],
  });
  assert.deepEqual(multi.channels.map((c) => [c.index, c.language, c.words.map((x) => x.text)]),
    [[0, "uk", ["Добрий", "день", "Скільки"]], [1, "ru", ["Здравствуйте"]]]);
  assert.deepEqual(toTurns(multi).map((t) => [t.channel, t.text]),
    [[0, "Добрий день"], [1, "Здравствуйте"], [0, "Скільки"]], "🔴 репліки не в порядку часу або канали злиплись");

  const fallback = parseSttResponse({ transcripts: [
    { channel_index: 1, words: [{ text: "а", start: 0 }] }, { channel_index: 0, words: [{ text: "б", start: 1 }] }] });
  assert.deepEqual(fallback.channels.map((c) => [c.index, c.words[0].text]), [[0, "б"], [1, "а"]], "🔴 запасний шлях каналу не працює");
  const mono = parseSttResponse({ language_code: "uk", words: [{ text: "Алло", start: 0 }, { text: "так", start: null }] });
  assert.deepEqual(toTurns(mono).map((t) => t.text), ["Алло так"], "🔴 моно-форма або слово без часу загубились");
  assert.throws(() => parseSttResponse({ message: "accepted", request_id: "r1" }),
    (e: unknown) => e instanceof VendorError && /асинхронна/.test(e.message));
});

const TURNS: Turn[] = [
  { channel: 0, start: 0, end: 2, text: "Добрий день, компанія UTS, чим можу допомогти?", lang: "uk" },
  { channel: 1, start: 2, end: 6, text: "Мені треба перевезти двадцять тонн зерна з Вінниці в Одесу. Скільки коштує?", lang: "uk" },
  { channel: 0, start: 6, end: 9, text: "Порахую і передзвоню вам до обіду завтра.", lang: "uk" },
];

/**
 * #764 — GEMINI: тіло за чинним контрактом (`responseFormat`, `thinkingLevel=low`, без
 * `temperature`/`thinkingBudget`), ключ лише заголовком; оплачений вихід = відповідь + думки;
 * непридатна відповідь — чесна причина, а не «успіх»; цитати звірено з розшифровкою.
 * 🧨 Червоніє, якщо рахувати вихід без думок, пропустити MAX_TOKENS чи довіряти цитатам моделі.
 */
test("#764 GEMINI: контракт запиту, вихід із думками, MAX_TOKENS і блок — не успіх, цитати звірено", async () => {
  const body = buildAnalysisRequest(TURNS, 2048);
  const gc = body.generationConfig as Record<string, any>;
  // Перелік, а не MIME-рядок: живий API відхилив "application/json" кодом 400 (пілот 28.09.2026).
  // Попередня редакція гейта стверджувала саме хибне значення — тобто стерегла припущення, а не контракт.
  assert.equal(gc.responseFormat.text.mimeType, "APPLICATION_JSON", "🔴 MIME-рядок — живий Gemini відповідає на нього 400");
  assert.equal(gc.responseFormat.text.schema, ANALYSIS_SCHEMA);
  assert.equal(gc.thinkingConfig.thinkingLevel, "low", "🔴 minimal на 3.8 Flash — помилка; дефолт medium — дорожче");
  const flat = JSON.stringify(body);
  for (const bad of ["temperature", "topP", "topK", "candidateCount", "thinkingBudget", "responseSchema"])
    assert.ok(!flat.includes(`"${bad}"`), `🔴 у запиті ${bad} — для Gemini 3.x його прибрано`);
  assert.ok(inputTokenUpperBound(body) >= new TextEncoder().encode(flat).length, "🔴 верхня межа вхідних токенів нижча за байти");

  const h = fakeHttp([json({ candidates: [{ content: { parts: [{ text: "…", thought: true }, { text: "{}" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120, thoughtsTokenCount: 300 } })]);
  const out = await geminiGenerate(h.deps, KEY, "gemini-3.8-flash", body, FAST);
  assert.ok(!h.calls[0].url.includes(KEY) && !/[?&]key=/.test(h.calls[0].url), "🔴 ключ у URL");
  assert.equal(new Headers(h.calls[0].init.headers).get("x-goog-api-key"), KEY);
  assert.equal(out.text, "{}", "🔴 частину-думку взято як відповідь");
  assert.deepEqual(out.usage, { input: 900, output: 420, thoughts: 300 }, "🔴 оплачений вихід без думок");

  const good = {
    summary: "Клієнт питає ціну перевезення зерна.", manager_channel: "0", client_request: "20 т зерна Вінниця → Одеса",
    price: { discussed: true, quote: "Скільки коштує?" },
    objections: [{ what: "дорого", quote: "у конкурентів дешевше" }],
    promises: [{ who: "manager", what: "передзвонити з ціною", deadline_text: "до обіду завтра", quote: "Порахую і передзвоню вам до обіду завтра", channel: "call", deadline_kind: "day", deadline_minutes: 0, deadline_date: "2026-09-21", conditional: false }],
    next_step: "дзвінок із ціною",
  };
  const ok = interpretAnalysis({ text: JSON.stringify(good), finishReason: "STOP", blockReason: null, usage: null }, TURNS);
  assert.ok(ok.ok);
  assert.equal(ok.result.price.quote_found, true);
  assert.equal(ok.result.promises[0].quote_found, true, "🔴 дослівна цитата з іншими розділовими знаками не впізнана");
  assert.equal(ok.result.objections[0].quote_found, false, "🔴 вигадану цитату прийнято як факт");
  const noQuote = interpretAnalysis({ text: JSON.stringify({ ...good, price: { discussed: false, quote: "" } }), finishReason: "STOP", blockReason: null, usage: null }, TURNS);
  assert.ok(noQuote.ok && noQuote.result.price.quote_found === null, "🔴 порожня цитата має бути «нема що звіряти»");

  const cases: [Parameters<typeof interpretAnalysis>[0], RegExp][] = [
    [{ text: JSON.stringify(good).slice(0, 40), finishReason: "MAX_TOKENS", blockReason: null, usage: null }, /MAX_TOKENS/],
    [{ text: null, finishReason: null, blockReason: "SAFETY", usage: null }, /заблоковано/],
    [{ text: "не json", finishReason: "STOP", blockReason: null, usage: null }, /не JSON/],
    [{ text: JSON.stringify({ ...good, manager_channel: "2" }), finishReason: "STOP", blockReason: null, usage: null }, /не за схемою/],
    [{ text: null, finishReason: "STOP", blockReason: null, usage: null }, /порожню/],
  ];
  for (const [o, re] of cases) {
    const v = interpretAnalysis(o, TURNS);
    assert.ok(!v.ok && re.test(v.why), `🔴 непридатна відповідь пройшла або з чужою причиною: ${JSON.stringify(v)}`);
  }
  assert.equal(parseGeminiResponse({ candidates: [] }).usage, null, "🔴 без usageMetadata вигадано нулі");
});

/**
 * #768 — ПІЛОТ: відкриті питання — обовʼязкові аргументи без значень за замовчуванням; `--go` без
 * цін і стель не стартує; сухий прогін — рівно один читальний запит, жодного запису; план не
 * містить ні URL записів, ні номерів клієнтів.
 * 🧨 Червоніє, якщо дати поріг розмови за замовчуванням або писати в план номер чи URL.
 */
test("#768 ПІЛОТ: відкриті питання обовʼязкові, --go без цін закритий, сухий прогін лише читає", async () => {
  const base = ["--from=2026-09-01", "--to=2026-09-21", "--limit=30"];
  const open = ["--talk-min-sec=20", "--window-before=1 days", "--flag=either"];
  const outOf = (f: string, t: string) => `/tmp/plan-${f}_${t}.jsonl`;
  for (let i = 0; i < open.length; i++)
    assert.throws(() => parsePilotArgs([...base, ...open.filter((_, k) => k !== i)], outOf), ParamNotSetError,
      `🔴 без ${open[i]} пілот стартував — відкрите питання отримало значення за замовчуванням`);
  assert.throws(() => parsePilotArgs([...base, ...open, "--stt-cap=40"], outOf), /невідомий прапорець/);
  assert.throws(() => parsePilotArgs([...base, ...open, "--go"], outOf), ParamNotSetError, "🔴 --go без цін і стель");
  const dry = parsePilotArgs([...base, ...open], outOf);
  assert.equal(dry.go, false);
  assert.equal(dry.out, "/tmp/plan-2026-09-01_2026-09-21.jsonl");
  const go = parsePilotArgs([...base, ...open, "--go", "--stt-usd-per-hour=0.22", "--stt-cap-usd=40", "--llm-usd-per-mtok-in=0.75",
    "--llm-usd-per-mtok-out=3.75", "--llm-cap-usd=10", "--max-output-tokens=2048"], outOf);
  assert.equal(go.go && go.sttCapUsd === 40 && go.llmCapUsd === 10, true, "🔴 повний набір для --go не прийнято");

  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return { rowCount: 2, rows: [
        { kommo_id: "11", uniqueid: "u1", calldate: new Date("2026-09-02T08:00:00Z"), call_type: "in", billsec: 95, manager_id: 4,
          created_at: new Date(), is_lead_channel_ad: true, is_ad_deal_sql: true, duration: 110, has_recording: true },
        { kommo_id: "12", uniqueid: "u2", calldate: new Date("2026-09-03T08:00:00Z"), call_type: "out", billsec: 40, manager_id: null,
          created_at: new Date(), is_lead_channel_ad: false, is_ad_deal_sql: true, duration: 70, has_recording: false },
      ] as never[] };
    },
  };
  const plan = await planPilot(db, { ...dry, sttUsdPerHour: 0.36 },
    { predicate: (r) => `(d.client_source = ANY(${r}))`, adSources: ["Google"] }, new Date("2026-09-22T09:00:00Z"));
  assert.equal(seen.length, 1, "🔴 сухий прогін зробив більше одного запиту");
  assert.ok(/^\s*WITH\b/.test(seen[0].sql) && !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(seen[0].sql), "🔴 сухий прогін пише");
  assert.ok(seen[0].params.includes(20) && seen[0].params.includes("1 days"), "🔴 відкриті параметри не дійшли до запиту");
  assert.equal(plan.calls, 2);
  assert.equal(plan.withRecording, 1);
  assert.ok(Math.abs((plan.estSttUsd ?? 0) - (180 * 2 * 0.36) / 3600) < 1e-12, "🔴 оцінка не «тривалість × 2 канали × ціна»");
  const jsonl = planToJsonl(plan);
  assert.equal(jsonl.trim().split("\n").length, 2);
  assert.ok(!/https?:|380\d{9}|0\d{9}/.test(jsonl), `🔴 у плані URL або номер: ${jsonl}`);
});

/**
 * #753 — ВИД ВІДМОВИ ЗА КОДОМ ПОСТАЧАЛЬНИКА, А НЕ ЛИШЕ ЗА HTTP. Пілот 24.09.2026: ElevenLabs віддав
 * 401 з `quota_exceeded` на вичерпану квоту ключа, і ми показали «ключ відхилено». Тепер 401 +
 * `quota_exceeded` → «кошти або квота», без повтору; дзеркало: 401 без коду лишається «ключ».
 * 🧨 Червоніє, якщо прибрати `kindFromBody` або зіставлення `quota_exceeded`.
 */
test("#753 ВІДМОВА ЗА КОДОМ: 401 quota_exceeded — квота, а не «ключ відхилено»; 401 без коду — ключ", async () => {
  const quota = { detail: { type: "invalid_request", code: "quota_exceeded",
    message: "This request exceeds your API key (uts-dashboard-stt) quota of 40. You have 15 credits remaining" } };
  const h = fakeHttp([json(quota, 401), json({ ok: 1 })]);
  const e = await fetchWithRetry(h.deps, { vendor: "ElevenLabs", url: ELEVENLABS_STT_URL, init: () => ({}) }, FAST)
    .then(() => null, (x: unknown) => x);
  assert.ok(e instanceof VendorError);
  assert.equal(e.kind, "payment", "🔴 вичерпана квота знову читається як відхилений ключ");
  assert.equal(h.calls.length, 1, "🔴 квоту повторено — повтор не лікує порожній рахунок");
  assert.doesNotMatch(e.message, /ключ відхилено/);
  assert.match(e.message, /квота ключа/);

  const bad = fakeHttp([json({ detail: { type: "authentication_error", code: "invalid_api_key", message: "Invalid API key" } }, 401)]);
  const e2 = await fetchWithRetry(bad.deps, { vendor: "ElevenLabs", url: ELEVENLABS_STT_URL, init: () => ({}) }, FAST)
    .then(() => null, (x: unknown) => x);
  assert.ok(e2 instanceof VendorError && e2.kind === "auth", "дзеркало: справжній невірний ключ мусить лишитись «ключ відхилено»");

  assert.equal(kindFromBody(JSON.stringify({ detail: { code: "concurrent_limit_exceeded" } })), "rate_limit");
  assert.equal(kindFromBody(JSON.stringify({ detail: { code: "insufficient_credits" } })), "payment");
  assert.equal(kindFromBody(JSON.stringify({ detail: [{ loc: ["file"], msg: "x" }] })), null, "🔴 форма 422 (масив) дала вигаданий вид");
  assert.equal(kindFromBody("не json"), null);
  assert.equal(kindFromBody(JSON.stringify({ detail: { code: "toString" } })), null, "🔴 успадковане імʼя прочитано як код");
});

const rep = (state: PortionReport["state"], claimed: number, stoppedBy: string | null = null): PortionReport => ({
  state, claimed, done: claimed, retry: 0, failed: 0, unavailable: 0, capped: 0, lostRace: 0,
  requeuedStuck: 0, failedStuck: 0, spentUsd: 0, capUsd: 40, stoppedBy,
});

/**
 * #754 — ПОРОЖНЯ ЧЕРГА — ЦЕ КІНЕЦЬ, А НЕ ЗУПИНКА. Пілот 24.09.2026 друкував «розпізнавання
 * зупинилось: idle». Дзеркало: справжня зупинка (стеля, помилка порції) і далі повертає причину.
 * 🧨 Червоніє, якщо стан `idle` знову пройде гілкою «не ok → причина».
 */
test("#754 ЧЕРГА СКІНЧИЛАСЬ: idle — нормальний кінець; стеля й помилка — названа зупинка", async () => {
  const seq = (xs: (PortionReport | Error)[]) => { let i = 0; return async () => { const x = xs[i++]; if (x instanceof Error) throw x; return x; }; };
  const into: PortionReport[] = [];
  assert.equal(await runUntilDrained(seq([rep("ok", 5), rep("ok", 5), rep("idle", 0)]), into), null, "🔴 порожня черга названа зупинкою");
  assert.equal(into.length, 3);
  assert.equal(await runUntilDrained(seq([rep("ok", 5), rep("ok", 0)]), []), null);
  assert.equal(await runUntilDrained(seq([rep("ok", 5), rep("capped", 2, "стеля місяця вичерпана")]), []), "стеля місяця вичерпана",
    "дзеркало: стеля мусить лишитись названою зупинкою");
  assert.equal(await runUntilDrained(seq([rep("not_enabled", 0, "ключ не задано")]), []), "ключ не задано");
  assert.equal(await runUntilDrained(seq([new Error("AI-конвеєр: порцію зупинено")]), []), "AI-конвеєр: порцію зупинено");
});

/**
 * #755 — ЦИТАТА ЗВІРЯЄТЬСЯ З ТЕКСТОМ СВОГО КАНАЛУ. Пілот 28.09.2026: «угу» клієнта посеред речення
 * менеджера робило 18 із 54 справжніх цитат «не знайденими». Дзеркало: фраза, склеєна зі слів ОБОХ
 * каналів, і вигадана фраза — не знайдені.
 * 🧨 Червоніє, якщо знову шукати в спільному тексті розмови.
 */
test("#755 ЦИТАТА ПО КАНАЛУ: «угу» співрозмовника не ламає цитату; склейка каналів і вигадка — не знайдені", () => {
  const turns: Turn[] = [
    { channel: 1, start: 0, end: 3, text: "Дайте мені, будь ласка, 10 хв., зараз рахую", lang: "ukr" },
    { channel: 0, start: 3, end: 3.4, text: "угу", lang: "ukr" },
    { channel: 1, start: 3.5, end: 6, text: "по вартості і одразу вам повідомляю.", lang: "ukr" },
  ];
  const base = { summary: "", manager_channel: "1" as const, client_request: "", next_step: "",
    price: { discussed: false, quote: "" }, objections: [] };
  const v = verifyQuotes({ ...base, promises: [
    { who: "manager" as const, what: "порахувати", deadline_text: "10 хв", quote: "зараз рахую по вартості і одразу вам повідомляю" },
    { who: "manager" as const, what: "x", deadline_text: "", quote: "рахую угу по вартості" },
    { who: "manager" as const, what: "x", deadline_text: "", quote: "завтра надішлю договір" },
  ] }, turns);
  assert.deepEqual(v.promises.map((p) => p.quote_found), [true, false, false],
    "🔴 справжня цитата не знайдена через «угу» іншого каналу, або склейка каналів чи вигадка пройшли");
});
