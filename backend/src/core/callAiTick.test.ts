import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./adCallFacts.js";
import type { HttpDeps } from "./callAiHttp.js";
import type { PortionReport } from "./callAiPipeline.js";
import { drainWithBudget, type TickEnv, type TickPrices } from "./callAiTick.js";
import { ELEVENLABS_STT_URL } from "./callAiProviders.js";

/**
 * 🎯 #780–#785 — AI-АНАЛІЗ, коміт ④: щогодинний тік, його вибірка, проводка крону й вид помилки.
 *
 * Живі гейти ганяють ЦІЛИЙ тік на scratch-базі з підставною мережею: запис Ringostat, ElevenLabs
 * і Gemini відповідають за адресою, а гейт рахує запити до кожного — тобто питає «скільки разів
 * ми б заплатили», не торкаючись жодного постачальника. Сесія в UTC: межа київської доби справжня.
 */

const NOW = new Date("2026-09-28T09:00:00Z");
const PRICES: TickPrices = { sttUsdPerHour: 0.22, sttMonthCapUsd: 40, llmUsdPerMtokIn: 0.75, llmUsdPerMtokOut: 3.75, llmMonthCapUsd: 10 };
const FAKE_AD = { predicate: (r: string) => `(d.client_source = ANY(${r}))`, adSources: ["uts.ua"] };

let ctxP: Promise<{ db: Db; raw: import("pg").Client } | { unavailable: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });

async function ctx(t: { skip: (m: string) => void }) {
  ctxP ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { unavailable: skipReason(s) };
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query("SET TIME ZONE 'UTC'");
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "schema.sql"), "utf8"));
    dispose = async () => { await c.end().catch(() => {}); s.dispose(); };
    return { db: c as unknown as Db, raw: c };
  })();
  const r = await ctxP;
  if ("unavailable" in r) { t.skip(r.unavailable); return null; }
  return r;
}

/** Синтетичний WAV: стерео 8 кГц 16 біт — як справжні записи Ringostat (замір 24.09.2026). */
function wav(sec: number): Uint8Array<ArrayBuffer> {
  const byteRate = 8000 * 2 * 2, data = Math.round(sec * byteRate);
  const b = new Uint8Array(44 + data), dv = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let k = 0; k < 4; k++) b[o + k] = s.charCodeAt(k); };
  put(0, "RIFF"); dv.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 8000, true);
  dv.setUint32(28, byteRate, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  put(36, "data"); dv.setUint32(40, data, true);
  return b;
}

const ANALYSIS = JSON.stringify({ summary: "s", manager_channel: "1", client_request: "тент", next_step: "", conversation_type: "cargo_request", type_confidence: 0.95, type_reason: "клієнт питає ціну перевезення", price_value: "",
  price: { discussed: true, quote: "скільки коштує" }, objections: [], promises: [] });

/** Мережа за адресою: скільки запитів пішло до кожного постачальника. */
function fakeNet() {
  const hits = { ringostat: 0, elevenlabs: 0, gemini: 0, other: 0 };
  const http: HttpDeps = {
    fetch: (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.startsWith("https://rec/")) { hits.ringostat++; return new Response(wav(20)); }
      if (url === ELEVENLABS_STT_URL) {
        hits.elevenlabs++;
        return Response.json({ audio_duration_secs: 40, transcripts: [
          { language_code: "ukr", words: [{ text: "Добрий", type: "word", start: 0, end: 1, channel_index: 1 }] },
          { language_code: "ukr", words: [{ text: "скільки", type: "word", start: 2, end: 2.5, channel_index: 0 },
            { text: "коштує", type: "word", start: 2.5, end: 3, channel_index: 0 }] }] });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        hits.gemini++;
        return Response.json({ candidates: [{ content: { parts: [{ text: ANALYSIS }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 90, thoughtsTokenCount: 40 } });
      }
      hits.other++;
      return new Response("ні", { status: 404 });
    }) as typeof fetch,
    sleep: async () => {},
    nowMs: () => Date.now(),
  };
  return { http, hits };
}

async function seed(c: { raw: import("pg").Client }, base: number): Promise<{ first: string[] }> {
  const deal = (id: number, ch: string | null, src: string | null, key: string, created: string) =>
    c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,client_source)
      VALUES ($1,$2,8921932,1,$3,$4,$5,$6)`, [id, `D${String(id)}`, created, key, ch, src]);
  const call = (u: string, at: string, type: string, sec: number, phone: string) =>
    c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,client_phone,recording)
      VALUES ($1,$2,$3,'ANSWERED',$4,$5,$6,$7)`, [u, at, type, sec, sec + 5, phone, `https://rec/${u}`]);
  const ph = (n: number) => `05${String(base + n).padStart(8, "0")}`;
  await deal(base + 1, "ad", null, ph(1), "2026-09-20 10:00:00+03");
  await deal(base + 2, null, "uts.ua", ph(2), "2026-09-21 10:00:00+03");
  await deal(base + 3, "ad", null, ph(3), "2026-08-20 10:00:00+03");
  await deal(base + 4, "other", "organic", ph(4), "2026-09-22 10:00:00+03");
  await deal(base + 5, "ad", null, ph(5), "2026-09-23 10:00:00+03");
  const u = (s: string) => `${String(base)}-${s}`;
  await call(u("a0"), "2026-09-20 10:05:00+03", "out", 10, "38" + ph(1));   // спроба
  await call(u("a1"), "2026-09-20 10:30:00+03", "out", 35, "38" + ph(1));   // перша розмова, вихідна
  await call(u("a2"), "2026-09-20 11:30:00+03", "in", 50, "38" + ph(1));    // друга розмова — не береться
  await call(u("b1"), "2026-09-21 10:10:00+03", "in", 25, "38" + ph(2));    // перша розмова, вхідна
  await call(u("c1"), "2026-08-20 10:10:00+03", "out", 90, "38" + ph(3));   // угода старша за 30 днів
  await call(u("d1"), "2026-09-22 10:10:00+03", "in", 90, "38" + ph(4));    // не реклама
  await call(u("e1"), "2026-09-23 10:10:00+03", "out", 10, "38" + ph(5));   // лише спроба
  return { first: [u("a1"), u("b1")] };
}

const env = (db: Db, http: HttpDeps, keys = { elevenlabs: "k-el", gemini: "k-g" }, prices = PRICES): TickEnv =>
  ({ db, http, keys, ad: FAKE_AD, prices, now: () => NOW });

/**
 * #780 — ТІК ЦІЛКОМ: бере рівно перші розмови рекламних угод за 30 днів (обидва напрямки, обидві
 * ознаки), розпізнає й аналізує їх; ДРУГИЙ тік нічого не оплачує вдруге. Спроба, друга розмова,
 * угода старша за 30 днів, не-реклама й угода без розмови — не беруться.
 * 🧨 Червоніє, якщо брати перший дзвінок замість розмови, звузити напрямок чи ознаку, або дублювати чергу.
 */
test("#780 ТІК · ЖИВА СХЕМА: перші розмови реклами за 30 днів, розпізнано й проаналізовано, повтор не платить", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { runCallAiTick } = await import("./callAiTick.js");
  const { first } = await seed(c, 7000);
  const net = fakeNet();
  const r1 = await runCallAiTick(env(c.db, net.http));
  const got = (await c.raw.query<{ uniqueid: string; status: string }>(
    "SELECT uniqueid, status FROM call_transcripts WHERE uniqueid LIKE '7000-%' ORDER BY uniqueid")).rows;
  assert.deepEqual(got.map((x) => x.uniqueid), first, "🔴 вибірка тіку — не перші розмови реклами за 30 днів");
  assert.ok(got.every((x) => x.status === "done"), `🔴 не розпізнано: ${JSON.stringify(got)}`);
  assert.equal(r1.selected, 2);
  assert.deepEqual({ el: net.hits.elevenlabs, g: net.hits.gemini, other: net.hits.other }, { el: 2, g: 2, other: 0 });
  const an = (await c.raw.query<{ n: number }>(`SELECT count(*)::int n FROM call_analyses a JOIN call_transcripts t ON t.id=a.transcript_id
    WHERE t.uniqueid LIKE '7000-%' AND a.status='done'`)).rows[0].n;
  assert.equal(an, 2, "🔴 розшифровки не проаналізовано");

  const r2 = await runCallAiTick(env(c.db, net.http));
  assert.equal(r2.enqueued, 0, "🔴 другий тік поставив у чергу те, що вже там");
  assert.deepEqual({ el: net.hits.elevenlabs, g: net.hits.gemini }, { el: 2, g: 2 }, "🔴 другий тік заплатив удруге");
});

/**
 * #781 — БЕЗ КЛЮЧІВ ТІК ЗЕЛЕНИЙ І НЕ ТОРКАЄТЬСЯ МЕРЕЖІ. Дзвінки відібрано й поставлено «не ввімкнено»,
 * запитів назовні — нуль, навіть до Ringostat; тік не кидає (джоба не червона). Дзеркало: з ключами
 * ті самі рядки розпізнаються.
 * 🧨 Червоніє, якщо перевірку ключа перенести після завантаження запису.
 */
test("#781 ТІК БЕЗ КЛЮЧІВ: нуль запитів назовні, рядки «не ввімкнено», джоба не червона", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { runCallAiTick } = await import("./callAiTick.js");
  await seed(c, 7100);
  const net = fakeNet();
  const r = await runCallAiTick(env(c.db, net.http, { elevenlabs: "", gemini: "" }));
  assert.equal(net.hits.ringostat + net.hits.elevenlabs + net.hits.gemini + net.hits.other, 0, "🔴 без ключів пішли запити назовні");
  assert.match(r.sttStoppedBy ?? "", /не задано/);
  const st = (await c.raw.query<{ status: string }>("SELECT DISTINCT status FROM call_transcripts WHERE uniqueid LIKE '7100-%'")).rows;
  assert.deepEqual(st.map((x) => x.status), ["not_enabled"]);
  await runCallAiTick(env(c.db, net.http));
  assert.ok(net.hits.elevenlabs >= 2, "дзеркало: з ключами ті самі рядки мусять розпізнатись");
});

/**
 * #782 — З КЛЮЧАМИ, АЛЕ БЕЗ ЦІН — «не налаштовано», і нуль оплат. Невідома ціна — закрита стеля.
 * Помилка тіку читається класифікатором як `config`, а не як збій постачальника.
 * 🧨 Червоніє, якщо дати ціні значення за замовчуванням або пустити виклик без ціни.
 */
test("#782 ТІК БЕЗ ЦІН: «не налаштовано», нуль оплат, вид помилки — config", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { runCallAiTick } = await import("./callAiTick.js");
  const { classifyJobError } = await import("../health/jobErrorKind.js");
  await seed(c, 7200);
  const net = fakeNet();
  const e = await runCallAiTick(env(c.db, net.http, undefined, { ...PRICES, sttUsdPerHour: null, llmUsdPerMtokOut: null }))
    .then(() => null, (x: Error) => x);
  assert.ok(e, "🔴 тік без цін пройшов «успіхом»");
  assert.match(e.message, /не налаштовано/);
  assert.equal(classifyJobError(e.message), "config");
  assert.equal(net.hits.elevenlabs + net.hits.gemini, 0, "🔴 без ціни пішов платний виклик");
});

const rep = (state: PortionReport["state"], claimed: number, stoppedBy: string | null = null): PortionReport => ({
  state, claimed, done: claimed, retry: 0, failed: 0, unavailable: 0, capped: 0, lostRace: 0,
  requeuedStuck: 0, failedStuck: 0, spentUsd: 0, capUsd: 40, stoppedBy,
});

/**
 * #783 — ТІК ОБМЕЖЕНИЙ ЧАСОМ: порції крутяться, доки не вийде час; порожня черга — кінець без
 * зупинки; стеля — названа зупинка; помилка порції — повертається, а не ковтається.
 * 🧨 Червоніє, якщо прибрати дедлайн (тік тягнувся б до наступного) або ковтати помилку.
 */
test("#783 ТІК У ЧАСІ: порції до дедлайну, idle — кінець, стеля — зупинка, помилка не ковтається", async () => {
  let clock = 0, calls = 0;
  const into: PortionReport[] = [];
  const slow = async () => { calls++; clock += 60_000; return rep("ok", 10); };
  const r = await drainWithBudget(slow, 5 * 60_000, () => clock, into);
  assert.deepEqual(r, { stoppedBy: null, error: null });
  assert.equal(calls, 5, "🔴 тік не зупинився на дедлайні — наздоганяв би наступний");
  const seq = (xs: (PortionReport | Error)[]) => { let i = 0; return async () => { const x = xs[i++]; if (x instanceof Error) throw x; return x; }; };
  assert.deepEqual(await drainWithBudget(seq([rep("ok", 3), rep("idle", 0)]), 60_000, () => 0, []), { stoppedBy: null, error: null });
  assert.equal((await drainWithBudget(seq([rep("capped", 2, "стеля місяця")]), 60_000, () => 0, [])).stoppedBy, "стеля місяця");
  const boom = await drainWithBudget(seq([new Error("AI-конвеєр: зупинено")]), 60_000, () => 0, []);
  assert.equal(boom.error?.message, "AI-конвеєр: зупинено", "🔴 помилку порції проковтнуто — джоба лишилась би зеленою");
});

/**
 * #853 — ПРОВОДКА: `callAiJob` запускається кроном раз на 10 хв (ТЗ 30.09.2026), не на :00/:30, і стоїть під
 * наглядом із тією самою частотою. Хвилини — з матчера самої бібліотеки, а не з тексту (як `#458`).
 * 🧨 Червоніє, якщо змінити крон, не змінивши `everyMin`, або прибрати джобу з нагляду.
 */
test("#853 ПРОВОДКА: крон callAiJob раз на 10 хв не на :00/:30, під наглядом із тією самою частотою, тік вкладається в 10 хв", async () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "index.ts"), "utf8");
  const at = src.indexOf('runJob("callAiJob"');
  assert.ok(at > 0, "🔴 callAiJob не запускається з index.ts");
  const spec = [...src.slice(0, at).matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  assert.ok(spec, "🔴 не знайдено cron.schedule перед callAiJob");
  const { createRequire } = await import("node:module");
  const TimeMatcher = createRequire(import.meta.url)("node-cron/src/time-matcher.js") as new (p: string) => { match(d: Date): boolean };
  const tm = new TimeMatcher(`0 ${spec}`);
  const minutes = Array.from({ length: 60 }, (_, i) => i).filter((i) => tm.match(new Date(2026, 8, 28, 10, i, 0)));
  assert.equal(minutes.length, 6, `🔴 крон «${spec}» стріляє ${String(minutes.length)} раз(и) на годину, а не раз на 10 хв`);
  assert.ok(!minutes.some((m) => [0, 30].includes(m)), `🔴 крон «${spec}» стріляє разом із syncKommo`);
  const gaps = minutes.slice(1).map((m, k) => m - minutes[k]);
  assert.ok(gaps.every((g) => g === 10), `🔴 інтервали між тіками нерівні: ${gaps.join(",")}`);
  const T = await import("./callAiTick.js");
  assert.ok(T.STT_BUDGET_MS + T.LLM_BUDGET_MS <= (T.TICK_EVERY_MIN - 1.5) * 60_000, "🔴 бюджет тіку не вкладається в 10 хв із запасом на вибірку й останню порцію");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  const j = MONITORED_JOBS.find((x) => x.name === "callAiJob");
  assert.ok(j, "🔴 callAiJob не під наглядом — його мовчання ніхто не побачить");
  assert.equal(j.everyMin, 10, "🔴 частота в нагляді ≠ крону — сторож мовчання бив би тривогу сам на себе");
});

/**
 * #785 — ВИД ПОМИЛКИ AI-КОНВЕЄРА — СВІЙ: «AI-конвеєр …» → `ai` з порадою про баланс і квоту
 * постачальника. Дзеркала: 429 від Kommo лишається `kommo_http`, «не налаштовано» — `config`.
 * 🧨 Червоніє, якщо прибрати вид `ai`: помилка впаде в «вид не розпізнано» без поради.
 */
test("#785 ВИД ПОМИЛКИ: AI-конвеєр — свій вид із порадою; Kommo 429 і «не налаштовано» не змішуються", async () => {
  const { classifyJobError, adviceForError } = await import("../health/jobErrorKind.js");
  const msg = "AI-конвеєр (розпізнавання): порцію зупинено — ElevenLabs: скінчились кошти на рахунку або квота ключа; дзвінки повернуто в чергу";
  assert.equal(classifyJobError(msg), "ai");
  assert.match(adviceForError("ai"), /баланс/);
  assert.match(adviceForError("ai"), /не Kommo/);
  assert.equal(classifyJobError("Kommo 429 Too Many Requests"), "kommo_http", "дзеркало: відмова Kommo лишається своїм видом");
  assert.equal(classifyJobError("не налаштовано: ціна: розпізнавання"), "config", "дзеркало: не налаштовано — config");
});

/**
 * #786 — ДАТА СТАРТУ 20.09.2026 (рішення власника 28.09.2026). Угода, створена за Києвом 19.09 о 23:30,
 * не береться; створена 20.09 о 00:10 — береться. Межа — київська доба, а не UTC: обидві угоди
 * лежать по різні боки київської півночі, але в ОДНІЙ UTC-добі (19.09). Далі вікно ковзне:
 * через 30 днів після старту вибірка починається з «сьогодні − 30».
 * 🧨 Червоніє, якщо прибрати дату старту з `selectionFrom` або рахувати межу в UTC.
 */
test("#786 ДАТА СТАРТУ: угоди раніше 20.09.2026 (Київ) не беруться, з 20.09 — беруться, далі вікно ковзне", async (t) => {
  const { selectionFrom, FIRST_TOUCH_RULE } = await import("./callAiTick.js");
  assert.equal(FIRST_TOUCH_RULE.startDate, "2026-09-20");
  assert.equal(selectionFrom(NOW), "2026-09-20", "🔴 28.09 вибірка починається не з дати старту");
  assert.equal(selectionFrom(new Date("2026-11-15T09:00:00Z")), "2026-10-16", "🔴 через 30 днів вікно не ковзнуло");
  const view = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "aiCallsView.ts"), "utf8");
  assert.match(view, new RegExp(`export const AI_START_DATE = "${FIRST_TOUCH_RULE.startDate}";`), "🔴 дата старту на екрані розійшлась із ядром");
  const c = await ctx(t); if (!c) return;
  const { selectFirstTouchCalls } = await import("./callAiTick.js");
  const deal = (id: number, key: string, created: string) =>
    c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel)
      VALUES ($1,$2,8921932,1,$3,$4,'ad')`, [id, `D${String(id)}`, created, key]);
  const call = (u: string, at: string, phone: string) =>
    c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,client_phone,recording)
      VALUES ($1,$2,'out','ANSWERED',60,65,$3,$4)`, [u, at, phone, `https://rec/${u}`]);
  await deal(7601, "0500007601", "2026-09-19 23:30:00+03");
  await deal(7602, "0500007602", "2026-09-20 00:10:00+03");
  await call("7600-before", "2026-09-19 23:40:00+03", "380500007601");
  await call("7600-after", "2026-09-20 00:20:00+03", "380500007602");
  const ids = await selectFirstTouchCalls(c.db, FAKE_AD, NOW);
  assert.ok(!ids.includes("7600-before"), "🔴 угоду з 19.09 (Київ) узято, хоча старт — 20.09");
  assert.ok(ids.includes("7600-after"), "дзеркало: угоду з 20.09 00:10 (Київ) мусить бути взято");
});

/**
 * #852 — ЩО НЕ АНАЛІЗУЄМО (ТЗ «звіт тімліда» 30.09.2026), ЖИВА СХЕМА. Кожна ознака лідгену ОКРЕМО виводить
 * розмову з черги й з екрана: мітка угоди, реєстр лідгену, команда відповідального, команда того, хто говорив;
 * повторний контакт (із номером уже була розмова від порогу) — теж; 14 с — ні, 15 с — так. Дзеркало: звичайна
 * рекламна розмова береться. Екран бере ту саму умову, тож ці розмови не видно й там.
 * 🧨 Червоніє, якщо прибрати будь-яку з ознак, повернути поріг 20 с чи брати повторний контакт.
 */
test("#852 ВИБІРКА: лідген за кожною з 4 ознак і повторний контакт не йдуть ні в чергу, ні на екран; поріг 15 с", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { selectFirstTouchCalls, FIRST_TOUCH_RULE } = await import("./callAiTick.js");
  const { aiCallsList } = await import("./callAiScreen.js");
  assert.equal(FIRST_TOUCH_RULE.talkMinSec, 15);
  await c.raw.query("INSERT INTO teams(id,name) VALUES (8520,'Продаж 852'),(8521,'Лідогенерація 852') ON CONFLICT DO NOTHING");
  await c.raw.query("INSERT INTO managers(id,name,team_id) VALUES (85200,'Продавець',8520),(85210,'Лідген',8521) ON CONFLICT DO NOTHING");
  // client_source 'uts.ua' — рекламна за правилом Звіту НАВІТЬ з міткою лідгену (на проді таких 6 із 334).
  const deal = (id: number, key: string, mgr: number, ch: string) =>
    c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel,manager_id,client_source)
      VALUES ($1,$2,8921932,1,'2026-09-25 09:00:00+03',$3,$4,$5,'uts.ua')`, [id, `D${String(id)}`, key, ch, mgr]);
  const call = (u: string, at: string, sec: number, mgr: number, key: string) =>
    c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,manager_id,client_phone,recording)
      VALUES ($1,$2,'out','ANSWERED',$3,$4,$5,$6,'https://rec/x')`, [u, at, sec, sec + 5, mgr, "38" + key]);
  const k = (n: number) => `05085200${String(n).padStart(2, "0")}`;
  await deal(85201, k(1), 85200, "ad");      await call("852-ok", "2026-09-25 10:00:00+03", 40, 85200, k(1));
  await deal(85202, k(2), 85200, "leadgen"); await call("852-tag", "2026-09-25 10:00:00+03", 40, 85200, k(2));
  await deal(85203, k(3), 85200, "ad");      await call("852-reg", "2026-09-25 10:00:00+03", 40, 85200, k(3));
  await c.raw.query("INSERT INTO leadgen_touch(lead_kommo_id, source) VALUES (85203, 'registry')");
  await deal(85204, k(4), 85210, "ad");      await call("852-dteam", "2026-09-25 10:00:00+03", 40, 85200, k(4));
  await deal(85205, k(5), 85200, "ad");      await call("852-cteam", "2026-09-25 10:00:00+03", 40, 85210, k(5));
  await deal(85206, k(6), 85200, "ad");      await call("852-old", "2026-07-01 10:00:00+03", 30, 85200, k(6));
  await call("852-rep", "2026-09-25 10:00:00+03", 40, 85200, k(6));
  await deal(85207, k(7), 85200, "ad");      await call("852-14s", "2026-09-25 10:00:00+03", 14, 85200, k(7));
  await deal(85208, k(8), 85200, "ad");      await call("852-15s", "2026-09-25 10:00:00+03", 15, 85200, k(8));
  const ad = FAKE_AD;
  const picked = (await selectFirstTouchCalls(c.db, ad, NOW)).filter((u) => u.startsWith("852-")).sort();
  assert.deepEqual(picked, ["852-15s", "852-ok"], `🔴 у чергу пішли виключені або не пішли свої: ${picked.join(", ")}`);
  const shown = (await aiCallsList(c.db, ad, "2026-09-25", "2026-09-25", NOW, {})).rows.map((r) => r.uniqueid).filter((u) => u.startsWith("852-")).sort();
  assert.deepEqual(shown, picked, "🔴 екран і черга джоби показують різні множини");
});
