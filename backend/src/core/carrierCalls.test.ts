import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCESS_MATRIX } from "../auth/accessMatrix.js";
import type { Db } from "./adCallFacts.js";
import type { HttpDeps } from "./callAiHttp.js";
import type { TickPrices } from "./callAiTick.js";
import { ELEVENLABS_STT_URL } from "./callAiProviders.js";
import { carrierBucket, checkCarrierQuote, interpretCarrier, oldEnough, type CarrierResult } from "./carrierCallRules.js";
import type { StageLead } from "./carrierCalls.js";

/**
 * 🚚 #950–#959 — ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ, прохід 1 (дані й аналіз, без екрана; ТЗ 29.09.2026).
 *
 * Живі гейти ганяють ядро на scratch-базі з підставною мережею (як `#780`): запис, ElevenLabs і Gemini
 * відповідають за адресою, а гейт рахує запити — «скільки разів ми б заплатили». Kommo підставляється
 * функцією `stageLeads`: гейт стверджує, що вибірка йде з ВІДПОВІДІ Kommo, а не з таблиці `deals`.
 * Кожна фікстура — по обидва боки межі, яку гейт стереже.
 */

const NOW = new Date("2026-09-28T09:00:00Z");
const PRICES: TickPrices = { sttUsdPerHour: 0.22, sttMonthCapUsd: 40, llmUsdPerMtokIn: 0.75, llmUsdPerMtokOut: 3.75, llmMonthCapUsd: 10 };
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

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

function wav(seconds: number): Uint8Array<ArrayBuffer> {
  const byteRate = 8000 * 2 * 2, data = Math.round(seconds * byteRate);
  const b = new Uint8Array(44 + data), dv = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let k = 0; k < 4; k++) b[o + k] = s.charCodeAt(k); };
  put(0, "RIFF"); dv.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 8000, true);
  dv.setUint32(28, byteRate, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  put(36, "data"); dv.setUint32(40, data, true);
  return b;
}

const CARRIER_JSON = JSON.stringify({ summary: "перевізник шукає вантаж", manager_channel: "1", caller_role: "carrier",
  caller_role_confidence: 0.95, caller_role_quote: "своя фура шукаю вантаж" });
const FIRST_TOUCH_JSON = JSON.stringify({ summary: "s", manager_channel: "1", client_request: "тент", next_step: "",
  price: { discussed: false, quote: "" }, objections: [], promises: [] });

/** Мережа: Gemini відповідає за РУБРИКОЮ запиту (схема з `caller_role` — перевізники, інакше — перший дотик). */
function fakeNet() {
  const hits = { ringostat: 0, elevenlabs: 0, gemini: 0, geminiCarrier: 0, other: 0 };
  const http: HttpDeps = {
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.startsWith("https://rec/")) { hits.ringostat++; return new Response(wav(20)); }
      if (url === ELEVENLABS_STT_URL) {
        hits.elevenlabs++;
        return Response.json({ audio_duration_secs: 40, transcripts: [
          { language_code: "ukr", words: [{ text: "у", type: "word", start: 2, end: 2.1, channel_index: 0 },
            { text: "мене", type: "word", start: 2.1, end: 2.3, channel_index: 0 },
            { text: "своя", type: "word", start: 2.3, end: 2.6, channel_index: 0 },
            { text: "фура", type: "word", start: 2.6, end: 2.9, channel_index: 0 },
            { text: "шукаю", type: "word", start: 2.9, end: 3.2, channel_index: 0 },
            { text: "вантаж", type: "word", start: 3.2, end: 3.6, channel_index: 0 }] },
          { language_code: "ukr", words: [{ text: "Добрий", type: "word", start: 0, end: 1, channel_index: 1 }] }] });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        hits.gemini++;
        const carrier = String(init?.body ?? "").includes("caller_role");
        if (carrier) hits.geminiCarrier++;
        return Response.json({ candidates: [{ content: { parts: [{ text: carrier ? CARRIER_JSON : FIRST_TOUCH_JSON }] }, finishReason: "STOP" }],
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

type Raw = { raw: import("pg").Client };
const phone = (base: number, n: number) => `3805${String(base + n).padStart(8, "0")}`;
async function call(c: Raw, u: string, at: Date, secs: number, ph: string, rec = true) {
  await c.raw.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,duration,client_phone,recording)
    VALUES ($1,$2,'in','ANSWERED',$3,$4,$5,$6)`, [u, at.toISOString(), secs, secs + 5, ph, rec ? `https://rec/${u}` : null]);
}
async function carrierDeal(c: Raw, id: number, ph: string, created: Date, state = "waiting", uniqueid: string | null = null, talkNo = 0) {
  await c.raw.query(`INSERT INTO carrier_call_deals(kommo_id,phone,deal_created_at,seen_at,state,uniqueid,first_uniqueid,talk_no)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`, [id, ph, created.toISOString(), NOW.toISOString(), state, uniqueid, talkNo]);
}
async function analysed(c: Raw, u: string, role: string, conf = 0.9, tStatus = "done") {
  const t = await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ($1,'elevenlabs','scribe_v2',$2,'[{"channel":0,"start":0,"end":1,"text":"алло","lang":"ukr"}]'::jsonb) RETURNING id`, [u, tStatus]);
  if (tStatus !== "done") return;
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
    VALUES ($1,'google','gemini-3.8-flash','carrier-v1','done',$2::jsonb)`,
  [t.rows[0].id, JSON.stringify({ summary: "", manager_channel: "1", caller_role: role, caller_role_confidence: conf, caller_role_quote: "", quote_check: "empty" })]);
}
/** Гейти ділять один кластер; ті, що рахують точні числа, починають із чистої черги. */
async function reset(c: Raw) {
  await c.raw.query("TRUNCATE carrier_call_deals, call_analyses, call_transcripts, ai_spend_ledger, ai_cap_alerts");
}
const row = async (c: Raw, id: number) => (await c.raw.query<{ state: string; uniqueid: string | null; talk_no: number; reused_from: string | null; first_uniqueid: string | null }>(
  "SELECT state, uniqueid, talk_no, reused_from::text, first_uniqueid FROM carrier_call_deals WHERE kommo_id = $1", [id])).rows[0];

/**
 * #950 — ВИБІРКА = ВІДПОВІДЬ KOMMO «зараз на етапі», старша за 15 хв, із номером у назві.
 * Угода, яку наша `deals` вважає «на етапі», але якої Kommo вже не віддав (фільтр прибрав), — не береться;
 * і навпаки, Kommo — джерело правди, навіть якщо `deals` ще не синкнулась. Повтор нічого не дублює.
 * 🧨 Червоніє, якщо брати статус із `deals`, прибрати поріг віку чи прийняти назву без номера.
 */
test("#950 ВИБІРКА · ЖИВА СХЕМА: лише угоди з відповіді Kommo, старші за 15 хв, із номером у назві", async (t) => {
  assert.equal(oldEnough(sec(min(14.5)), NOW), false, "🔴 угоду молодшу за 15 хв узято — фільтр CRM міг ще не пройти");
  assert.equal(oldEnough(sec(min(15)), NOW), true, "дзеркало: рівно 15 хв — уже беремо");
  const c = await ctx(t); if (!c) return;
  const { recordStageDeals } = await import("./carrierCalls.js");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo) VALUES
    (93004,'380500000004',8921928,70419108,$1), (93005,'380500000005',8921928,143,$1)`, [min(60).toISOString()]);
  const leads: StageLead[] = [
    { id: 93001, name: "380500000001", created_at: sec(min(20)), responsible_user_id: 7 },
    { id: 93002, name: "380500000002", created_at: sec(min(10)), responsible_user_id: 7 },
    { id: 93003, name: "ТОВ Ромашка", created_at: sec(min(30)), responsible_user_id: 7 },
    { id: 93005, name: "380500000005", created_at: sec(min(60)), responsible_user_id: 7 },
  ];
  const r = await recordStageDeals(c.db, leads, NOW);
  assert.deepEqual(r, { onStage: 4, tooYoung: 1, noPhone: 1, inserted: 2 });
  const ids = (await c.raw.query<{ k: string }>("SELECT kommo_id::text k FROM carrier_call_deals WHERE kommo_id BETWEEN 93000 AND 93099 ORDER BY 1")).rows.map((x) => x.k);
  assert.deepEqual(ids, ["93001", "93005"], "🔴 вибірка — не відповідь Kommo (93004 є лише в `deals`, 93005 — навпаки)");
  assert.equal((await recordStageDeals(c.db, leads, NOW)).inserted, 0, "🔴 повтор записав угоди вдруге");
});

/**
 * #950b — ЗАПИТ ДО KOMMO: фільтр рівно по воронці й етапу; сторінки до неповної; понад межу — помилка, а не
 * обрізаний список. Без бази: `get` підставляється.
 * 🧨 Червоніє, якщо загубити фільтр етапу або мовчки віддати перші 1000 угод.
 */
test("#950b KOMMO: фільтр воронки й етапу, сторінки до неповної, понад межу — помилка", async () => {
  const { stageLeadsPath, pageStageLeads } = await import("../kommo/stageLeads.js");
  const p = stageLeadsPath(8921928, 70419108, 2);
  assert.match(p, /filter\[statuses\]\[0\]\[pipeline_id\]=8921928/);
  assert.match(p, /filter\[statuses\]\[0\]\[status_id\]=70419108/);
  assert.match(p, /limit=250&page=2/);
  const lead = (id: number) => ({ id, name: "", price: 0, pipeline_id: 1, status_id: 1, responsible_user_id: 1, created_at: 0, updated_at: 0, closed_at: null });
  const pages = (sizes: number[]) => { let i = 0; const seen: string[] = [];
    return { seen, get: async <T>(path: string): Promise<T> => { seen.push(path);
      const n = sizes[i++] ?? 0; return { _embedded: { leads: Array.from({ length: n }, (_, k) => lead(i * 1000 + k)) } } as T; } }; };
  const a = pages([250, 3]);
  assert.equal((await pageStageLeads(a.get, 8921928, 70419108, 4)).length, 253);
  assert.equal(a.seen.length, 2, "🔴 після неповної сторінки пішов зайвий запит до Kommo");
  const b = pages([250, 250, 250, 250]);
  await assert.rejects(pageStageLeads(b.get, 8921928, 70419108, 4), /обрізаний список/, "🔴 понад межу — мовчки обрізано");
});

/**
 * #951 — РОЗМОВА: перша ≥10 с із записом у вікні [−10 хв; +24 год] від створення угоди. 9 с, без запису
 * й раніше вікна — не беруться. Немає розмови — чекаємо, доки доба не мине; минула — «розмови не було».
 * 🧨 Червоніє, якщо поріг стане 20 с чи 9, або «розмови не було» ставитиметься до кінця доби.
 */
test("#951 РОЗМОВА · ЖИВА СХЕМА: ≥10 с із записом у вікні доби; без розмови — чекаємо, потім пропускаємо", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const created = min(120), P = phone(93100, 1);
  await carrierDeal(c, 93101, P, created);
  await call(c, "931-early", new Date(created.getTime() - 20 * 60_000), 40, P);
  await call(c, "931-9s", new Date(created.getTime() + 60_000), 9, P);
  await call(c, "931-norec", new Date(created.getTime() + 2 * 60_000), 30, P, false);
  await call(c, "931-10s", new Date(created.getTime() + 5 * 60_000), 10, P);
  await carrierDeal(c, 93102, phone(93100, 2), min(60));
  await carrierDeal(c, 93103, phone(93100, 3), min(25 * 60));
  await resolveCarrierDeals(c.db, NOW);
  assert.deepEqual({ ...(await row(c, 93101)) }, { state: "own", uniqueid: "931-10s", talk_no: 1, reused_from: null, first_uniqueid: "931-10s" },
    "🔴 узято не першу розмову ≥10 с із записом у вікні");
  assert.equal((await row(c, 93102)).state, "waiting", "🔴 доба ще не минула, а номер уже пропущено");
  assert.equal((await row(c, 93103)).state, "no_talk", "🔴 доба минула без розмови, а угода досі чекає");
});

/**
 * #952 — ВЕРДИКТ НА НОМЕР 30 ДНІВ: номер уже слухали — нова угода бере той самий вердикт, без нової оплати;
 * на 31-й день — слухаємо знову. Вердикт «не розібрати» не повторюється.
 * 🧨 Червоніє, якщо межа попливе в будь-який бік або повторюватиметься «не розібрати».
 */
test("#952 НОМЕР 30 ДНІВ · ЖИВА СХЕМА: повтор без оплати в межах 30 днів, на 31-й — слухаємо знову", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  const P = phone(93200, 1);
  await call(c, "932-src", day(40), 60, P);
  await carrierDeal(c, 93201, P, day(40), "own", "932-src", 1);
  await analysed(c, "932-src", "carrier");
  await carrierDeal(c, 93202, P, day(20));           // 20 днів після розмови — повтор
  await call(c, "932-new", new Date(day(9).getTime() + 60_000), 30, P);
  await carrierDeal(c, 93203, P, day(9));            // 31 день після розмови — своя
  const Q = phone(93200, 2);                          // той самий сценарій, але вердикт «не розібрати»
  await call(c, "932-unc", day(5), 60, Q);
  await carrierDeal(c, 93204, Q, day(5), "own", "932-unc", 1);
  await analysed(c, "932-unc", "unclear", 0.3);
  await call(c, "932-q2", new Date(day(2).getTime() + 60_000), 30, Q);
  await carrierDeal(c, 93205, Q, day(2));
  await resolveCarrierDeals(c.db, NOW);
  assert.deepEqual([(await row(c, 93202)).state, (await row(c, 93202)).reused_from], ["reused", "93201"], "🔴 номер у межах 30 днів слухаємо вдруге");
  assert.deepEqual([(await row(c, 93203)).state, (await row(c, 93203)).uniqueid], ["own", "932-new"], "🔴 на 31-й день вердикт досі повторюється");
  assert.equal((await row(c, 93205)).state, "own", "🔴 повторено вердикт «не розібрати» — нову розмову не слухали");
});

/**
 * #953 — ДРУГА СПРОБА: першу розмову не розібрати (unclear або запису немає) — беремо наступну розмову номера
 * у вікні; третьої не буває. Упевнений вердикт — без другої спроби.
 * 🧨 Червоніє, якщо слухати третю, не слухати другу, або переслуховувати впевнені.
 */
test("#953 ДРУГА СПРОБА · ЖИВА СХЕМА: «не розібрати» чи без запису — наступна розмова, не більше двох", async (t) => {
  const c = await ctx(t); if (!c) return;
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const created = min(300);
  const at = (m: number) => new Date(created.getTime() + m * 60_000);
  const A = phone(93300, 1), B = phone(93300, 2), C = phone(93300, 3), D = phone(93300, 4);
  await call(c, "933-a1", at(1), 20, A); await call(c, "933-a2", at(30), 25, A);
  await carrierDeal(c, 93301, A, created, "own", "933-a1", 1); await analysed(c, "933-a1", "unclear", 0.2);
  await call(c, "933-b1", at(1), 20, B); await call(c, "933-b2", at(40), 25, B);
  await carrierDeal(c, 93302, B, created, "own", "933-b1", 1); await analysed(c, "933-b1", "x", 0, "recording_unavailable");
  await call(c, "933-c1", at(1), 20, C); await call(c, "933-c2", at(40), 25, C);
  await carrierDeal(c, 93303, C, created, "own", "933-c1", 1); await analysed(c, "933-c1", "carrier", 0.97);
  await call(c, "933-d1", at(1), 20, D); await call(c, "933-d2", at(20), 25, D); await call(c, "933-d3", at(60), 25, D);
  await c.raw.query(`INSERT INTO carrier_call_deals(kommo_id,phone,deal_created_at,seen_at,state,uniqueid,first_uniqueid,talk_no)
    VALUES (93304,$1,$2,$3,'own','933-d2','933-d1',2)`, [D, created.toISOString(), NOW.toISOString()]);
  await analysed(c, "933-d2", "unclear", 0.2);
  await resolveCarrierDeals(c.db, NOW);
  assert.deepEqual([(await row(c, 93301)).uniqueid, (await row(c, 93301)).talk_no, (await row(c, 93301)).first_uniqueid], ["933-a2", 2, "933-a1"],
    "🔴 першу розмову не розібрати, а другу не взято (або загублено першу)");
  assert.equal((await row(c, 93302)).uniqueid, "933-b2", "🔴 запису немає — друга розмова не взята");
  assert.equal((await row(c, 93303)).uniqueid, "933-c1", "🔴 упевнений вердикт переслуховується");
  assert.equal((await row(c, 93304)).uniqueid, "933-d2", "🔴 узято третю розмову");
});

/**
 * #954 — ЧЕРГА НЕ ЗМІШУЄТЬСЯ: мобільна джоба бере в роботу лише свої дзвінки (рекламний лишається в черзі
 * недоторканим), а годинна рекламна не прибирає й не оплачує мобільні.
 * 🧨 Червоніє, якщо зняти межу `only` у мобільній або `except`/об'єднання в рекламній.
 */
test("#954 ЧЕРГА · ЖИВА СХЕМА: мобільна бере лише свої, рекламна мобільні не прибирає й не оплачує", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { runCarrierTick } = await import("./carrierCalls.js");
  const { runCallAiTick } = await import("./callAiTick.js");
  const P = phone(93400, 1);
  await call(c, "934-mob", min(100), 30, P);
  await carrierDeal(c, 93401, P, min(101), "own", "934-mob", 1);
  await call(c, "934-ad-q", min(200), 30, "380999934000");
  await c.raw.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('934-ad-q','elevenlabs','scribe_v2','queued')");
  const net = fakeNet();
  await runCarrierTick({ db: c.db, http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW,
    stageLeads: async () => [], alert: async () => {} });
  const st = async (u: string) => (await c.raw.query<{ status: string }>("SELECT status FROM call_transcripts WHERE uniqueid=$1", [u])).rows[0]?.status;
  assert.equal(await st("934-mob"), "done");
  assert.equal(await st("934-ad-q"), "queued", "🔴 мобільна джоба взяла в роботу рекламний дзвінок");
  assert.equal(net.hits.elevenlabs, 1, "🔴 мобільна джоба оплатила чужий дзвінок");

  const Q = phone(93400, 2);
  await call(c, "934-mob2", min(50), 30, Q);
  await carrierDeal(c, 93402, Q, min(51), "own", "934-mob2", 1);
  await c.raw.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('934-mob2','elevenlabs','scribe_v2','queued')");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel)
    VALUES (93499,'D',8921932,1,'2026-09-25 10:00:00+03','0999934999','ad')`);
  await call(c, "934-ad", new Date("2026-09-25T07:30:00Z"), 35, "380999934999");
  const before = net.hits.elevenlabs;
  await runCallAiTick({ db: c.db, http: net.http, keys: { elevenlabs: "k", gemini: "g" },
    ad: { predicate: (r: string) => `(d.client_source = ANY(${r}))`, adSources: ["uts.ua"] }, prices: PRICES, now: () => NOW });
  assert.equal(await st("934-ad"), "done", "дзеркало: рекламна джоба робить свою роботу");
  assert.equal(await st("934-mob2"), "queued", "🔴 рекламна джоба прибрала або оплатила мобільний дзвінок");
  assert.equal(net.hits.elevenlabs - before, 1, "🔴 рекламна джоба оплатила мобільний дзвінок під своєю стелею");
});

/**
 * #955 — РУБРИКИ НЕ ПЕРЕТИНАЮТЬСЯ: мобільний дзвінок отримує лише carrier-v1, рекламний — лише рекламну.
 * 🧨 Червоніє, якщо рекламна джоба ставитиме аналіз без межі або мобільна — рекламну рубрику.
 */
test("#955 РУБРИКИ · ЖИВА СХЕМА: мобільний — лише carrier-v1, рекламний — лише рекламна", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { runCarrierTick } = await import("./carrierCalls.js");
  const { runCallAiTick } = await import("./callAiTick.js");
  const P = phone(93500, 1);
  await call(c, "935-mob", min(100), 30, P);
  await carrierDeal(c, 93501, P, min(101), "own", "935-mob", 1);
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel)
    VALUES (93599,'D',8921932,1,'2026-09-26 10:00:00+03','0999935999','ad')`);
  await call(c, "935-ad", new Date("2026-09-26T07:30:00Z"), 35, "380999935999");
  const net = fakeNet();
  const tick = { http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW };
  await runCarrierTick({ db: c.db, ...tick, stageLeads: async () => [], alert: async () => {} });
  await runCallAiTick({ db: c.db, ...tick, ad: { predicate: (r: string) => `(d.client_source = ANY(${r}))`, adSources: ["uts.ua"] } });
  const rubrics = async (u: string) => (await c.raw.query<{ r: string }>(`SELECT a.rubric_version r FROM call_analyses a
    JOIN call_transcripts t ON t.id=a.transcript_id WHERE t.uniqueid=$1 ORDER BY 1`, [u])).rows.map((x) => x.r);
  assert.deepEqual(await rubrics("935-mob"), ["carrier-v1"], "🔴 мобільний дзвінок отримав чужу рубрику");
  assert.deepEqual(await rubrics("935-ad"), ["first-touch-v1"], "🔴 рекламний дзвінок отримав рубрику перевізників");
  const res = (await c.raw.query<{ result: CarrierResult }>(`SELECT a.result FROM call_analyses a JOIN call_transcripts t ON t.id=a.transcript_id
    WHERE t.uniqueid='935-mob'`)).rows[0].result;
  assert.equal(res.quote_check, "counterpart", "дзеркало: цитата співрозмовника підтверджена на справжній розшифровці");
  assert.equal(carrierBucket(res), "carrier");
});

/**
 * #956 — ЦИТАТА СПІВРОЗМОВНИКА: підтверджує лише цитата з каналу НЕ менеджера; фраза менеджера, вигадка,
 * невідомий бік — не підтвердження, і такий вердикт іде «нижче порогу». Поріг 0,85 — з обох боків.
 * 🧨 Червоніє, якщо прийняти фразу менеджера, шукати у склейці каналів або зсунути поріг.
 */
test("#956 ЦИТАТА: лише зі слів співрозмовника; фраза менеджера й вигадка — нижче порогу; поріг 0,85 з обох боків", () => {
  const turns = [
    { channel: 1, start: 0, end: 1, text: "Добрий день ви ж перевізник", lang: "ukr" },
    { channel: 0, start: 1, end: 3, text: "так у мене своя фура шукаю вантаж", lang: "ukr" },
  ];
  const r = (quote: string, mgr: "0" | "1" | "unknown" = "1"): CarrierResult =>
    ({ summary: "", manager_channel: mgr, caller_role: "carrier", caller_role_confidence: 0.95, caller_role_quote: quote });
  assert.equal(checkCarrierQuote(r("своя фура шукаю вантаж"), turns), "counterpart");
  assert.equal(checkCarrierQuote(r("ви ж перевізник"), turns), "manager", "🔴 фраза менеджера прийнята як слова співрозмовника");
  assert.equal(checkCarrierQuote(r("маю рефрижератор"), turns), "absent");
  assert.equal(checkCarrierQuote(r(""), turns), "empty");
  assert.equal(checkCarrierQuote(r("своя фура", "unknown"), turns), "side_unknown");
  assert.equal(checkCarrierQuote(r("перевізник так у мене"), turns), "absent", "🔴 цитата зі склейки двох каналів прийнята");
  const b = (conf: number, qc: CarrierResult["quote_check"], role: CarrierResult["caller_role"] = "carrier") =>
    carrierBucket({ caller_role: role, caller_role_confidence: conf, quote_check: qc });
  assert.equal(b(0.85, "counterpart"), "carrier");
  assert.equal(b(0.8499, "counterpart"), "low", "🔴 поріг 0,85 поплив");
  assert.equal(b(0.95, "manager"), "low", "🔴 упевнений вердикт на фразі менеджера");
  assert.equal(b(0.95, "empty", "other"), "other", "дзеркало: «інше» цитати не вимагає");
  assert.equal(b(0.4, "counterpart", "unclear"), "unclear");
  const bad = interpretCarrier({ text: JSON.stringify({ ...r("x"), caller_role_confidence: 1.2 }), finishReason: "STOP", blockReason: null, usage: null }, turns);
  assert.equal(bad.ok, false, "🔴 впевненість поза 0..1 прийнята");
});

/**
 * #957 — СТЕЛЯ МОБІЛЬНИХ $15: вичерпано — стоять лише мобільні (рекламний рядок не зачеплено), Telegram —
 * один раз на місяць; наступного місяця — знову.
 * 🧨 Червоніє, якщо стеля заморозить рекламну чергу, не спрацює або писатиме щоп'ять хвилин.
 */
test("#957 СТЕЛЯ МОБІЛЬНИХ · ЖИВА СХЕМА: стоять лише мобільні, Telegram один раз на місяць", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { runCarrierTick } = await import("./carrierCalls.js");
  const { notifyCapOnce } = await import("./aiCapAlert.js");
  const P = phone(93700, 1);
  await call(c, "937-mob", min(100), 30, P);
  await carrierDeal(c, 93701, P, min(101), "own", "937-mob", 1);
  await c.raw.query("INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES ('937-ad','elevenlabs','scribe_v2','queued')");
  await c.raw.query(`INSERT INTO ai_spend_ledger(at,provider,operation,units,unit,unit_price_usd)
    VALUES ($1,'elevenlabs','carrier_stt',15,'audio_sec',1)`, [NOW.toISOString()]);
  const net = fakeNet();
  const sent: string[] = [];
  const env = { db: c.db, http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW,
    stageLeads: async () => [], alert: async (x: string) => { sent.push(x); } };
  const r = await runCarrierTick(env);
  const st = async (u: string) => (await c.raw.query<{ status: string }>("SELECT status FROM call_transcripts WHERE uniqueid=$1", [u])).rows[0]?.status;
  assert.equal(r.stt[0]?.state, "capped", "🔴 стеля мобільних не спрацювала");
  assert.equal(await st("937-mob"), "capped");
  assert.equal(await st("937-ad"), "queued", "🔴 стеля мобільних заморозила рекламний дзвінок");
  assert.equal(net.hits.elevenlabs, 0, "🔴 за вичерпаною стелею пішла оплата");
  assert.equal(net.hits.ringostat, 0, "🔴 за вичерпаною стелею рядки взято в роботу й завантажено запис — перший рубіж не спрацював");
  await runCarrierTick(env);
  assert.equal(sent.length, 1, "🔴 повідомлення про стелю не одне на місяць");
  assert.match(sent[0], /мобільні/);
  assert.equal(await notifyCapOnce(c.db, "carrier", "x", new Date("2026-10-01T09:00:00Z"), async () => {}), true,
    "дзеркало: наступного місяця — знову");
});

/**
 * #957b — ДРУГИЙ РУБІЖ СТЕЛІ МОБІЛЬНИХ: витрачено трохи менше $15 — рядок береться, але дзвінок, що перевищив би
 * стелю, не оплачується (оцінка до виклику). Дзеркало: без витрат — оплачується.
 * 🧨 Червоніє, якщо прибрати перевірку додаткової стелі перед кожним дзвінком.
 */
test("#957b СТЕЛЯ МОБІЛЬНИХ · ЖИВА СХЕМА: під самою стелею дзвінок, що її перевищить, не оплачується", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { runCarrierTick } = await import("./carrierCalls.js");
  const P = phone(93750, 1);
  await call(c, "937b-mob", min(100), 30, P);
  await carrierDeal(c, 93751, P, min(101), "own", "937b-mob", 1);
  await c.raw.query(`INSERT INTO ai_spend_ledger(at,provider,operation,units,unit,unit_price_usd)
    VALUES ($1,'google','carrier_analysis',14.9999,'input_tokens',1)`, [NOW.toISOString()]);
  const net = fakeNet();
  const env = { db: c.db, http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW,
    stageLeads: async () => [], alert: async () => {} };
  const r = await runCarrierTick(env);
  assert.equal(net.hits.elevenlabs, 0, "🔴 дзвінок, що перевищує стелю мобільних, оплачено");
  assert.match(r.stt[0]?.stoppedBy ?? "", /мобільні/, "🔴 зупинка не названа стелею мобільних");
  await c.raw.query("TRUNCATE ai_spend_ledger");
  await runCarrierTick(env);
  assert.equal(net.hits.elevenlabs, 1, "дзеркало: без витрат дзвінок оплачується");
});

/**
 * #958 — ТЕКСТ 12 МІСЯЦІВ: старший за рік текст дзвінка мобільних видаляється, вердикт лишається; молодший —
 * ні; дзвінок, який аналізувала інша рубрика, живе за її правилами.
 * 🧨 Червоніє, якщо видаляти раніше, видаляти чужі або з'їсти вердикт.
 */
test("#958 ТЕКСТ 12 МІСЯЦІВ · ЖИВА СХЕМА: старший за рік видалено, вердикт лишився; молодший і чужий — ні", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { purgeOldCarrierText } = await import("./carrierCalls.js");
  const monthsAgo = (m: number) => new Date(Date.UTC(2026, 8 - m, 28, 9)).toISOString();
  for (const [u, m, other] of [["938-old", 13, false], ["938-young", 11, false], ["938-shared", 13, true]] as const) {
    await carrierDeal(c, 93800 + m + (other ? 50 : 0), phone(93800, m + (other ? 50 : 0)), min(60), "own", u, 1);
    await analysed(c, u, "carrier");
    await c.raw.query("UPDATE call_transcripts SET created_at = $2 WHERE uniqueid = $1", [u, monthsAgo(m)]);
    if (other) await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status)
      SELECT id,'google','gemini-3.8-flash','first-touch-v1','done' FROM call_transcripts WHERE uniqueid=$1`, [u]);
  }
  assert.equal(await purgeOldCarrierText(c.db, NOW), 1);
  const s = async (u: string) => (await c.raw.query<{ seg: unknown; p: Date | null; role: string | null }>(`SELECT t.segments seg, t.text_purged_at p,
    (SELECT a.result->>'caller_role' FROM call_analyses a WHERE a.transcript_id=t.id AND a.rubric_version='carrier-v1') role
    FROM call_transcripts t WHERE t.uniqueid=$1`, [u])).rows[0];
  const old = await s("938-old");
  assert.equal(old.seg, null); assert.ok(old.p, "🔴 не видно, коли видалено текст");
  assert.equal(old.role, "carrier", "🔴 разом із текстом зник вердикт");
  assert.notEqual((await s("938-young")).seg, null, "🔴 видалено текст, молодший за рік");
  assert.notEqual((await s("938-shared")).seg, null, "🔴 видалено текст дзвінка, який належить іншому екрану");
});

/**
 * #959 — ПРОВОДКА: крон раз на 5 хв, за 2 хв після свіжих дзвінків, не на :00/:30; під наглядом із тією самою
 * частотою; таблиці — у блоці AI-аналізу (там їх бере `#759`) і в `FORBIDDEN_TABLES`.
 * 🧨 Червоніє, якщо зняти джобу з нагляду, поставити на :00/:30 чи вийти з блоку.
 */
test("#959 ПРОВОДКА: крон щоп'ять хвилин на :04…:59, під наглядом, таблиці в блоці AI й під забороною", async () => {
  const root = path.join(import.meta.dirname, "..", "..", "src");
  const src = readFileSync(path.join(root, "index.ts"), "utf8");
  const at = src.indexOf('runJob("carrierCallJob"');
  assert.ok(at > 0, "🔴 carrierCallJob не запускається з index.ts");
  const spec = [...src.slice(0, at).matchAll(/cron\.schedule\("([^"]+)"/g)].pop()?.[1];
  assert.ok(spec, "🔴 не знайдено cron.schedule перед carrierCallJob");
  const mins = spec.split(" ")[0].split(",").map(Number);
  assert.equal(mins.length, 12, "🔴 не щоп'ять хвилин");
  assert.ok(mins.every((m) => m % 5 === 4), `🔴 хвилини не :04…:59 (після свіжих дзвінків): ${spec}`);
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((x) => x.name === "carrierCallJob")?.everyMin, 5, "🔴 джоба не під наглядом із частотою крону");
  const schema = readFileSync(path.join(root, "db", "schema.sql"), "utf8");
  const block = schema.slice(schema.indexOf("-- ▼ AI-АНАЛІЗ ДЗВІНКІВ"), schema.indexOf("-- ▲ AI-АНАЛІЗ ДЗВІНКІВ ▲"));
  for (const tbl of ["carrier_call_deals", "ai_cap_alerts"]) {
    assert.match(block, new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}\\b`), `🔴 ${tbl} поза блоком AI-аналізу`);
    assert.match(block, new RegExp(`REVOKE ALL ON ${tbl} FROM ai_readonly`), `🔴 ${tbl} не відібрана в ai_readonly`);
  }
  const mt = readFileSync(path.join(root, "ai", "metricTools.ts"), "utf8");
  assert.match(mt, /"carrier_call_deals"/, "🔴 carrier_call_deals не в FORBIDDEN_TABLES");
});

// ─── Прохід 2: вкладка ──────────────────────────────────────────────────────

const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url));

async function carrierAnalysed(c: Raw, u: string, role: string, conf: number, quoteCheck: string, quote = "своя фура") {
  const t = await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ($1,'elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":1,"text":"Добрий день","lang":"ukr"},{"channel":0,"start":1,"end":3,"text":"у мене своя фура","lang":"ukr"}]'::jsonb) RETURNING id`, [u]);
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
    VALUES ($1,'google','gemini-3.8-flash','carrier-v1','done',$2::jsonb)`,
  [t.rows[0].id, JSON.stringify({ summary: "перевізник", manager_channel: "1", caller_role: role, caller_role_confidence: conf, caller_role_quote: quote, quote_check: quoteCheck })]);
  return t.rows[0].id;
}

/**
 * #960 — СПИСОК І ПЛИТКИ: рядок — дзвінок, угода з повтором вердикту номера стоїть у рядку свого джерела;
 * угоди без розмови в список не йдуть, але їх число — у плитках; «прибрав фільтр» — лише угоди етапу (назва-номер)
 * з причиною «Перевізник» у періоді; «лишилось після фільтра» — усі наші записи періоду.
 * 🧨 Червоніє, якщо рядок стане угодою, загубиться повтор, прибрати назву-номер чи розвести період.
 */
test("#960 СПИСОК · ЖИВА СХЕМА: рядок — дзвінок з усіма угодами номера; без розмови — лише числом; плитки з обох джерел", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { carrierCallsList } = await import("./carrierCallScreen.js");
  const P = phone(96000, 1), Q = phone(96000, 2);
  const at = new Date("2026-09-24T08:00:00Z");
  await call(c, "960-a", at, 40, P); await call(c, "960-c", at, 25, Q);
  await carrierDeal(c, 96001, P, at, "own", "960-a", 1);
  await c.raw.query(`INSERT INTO carrier_call_deals(kommo_id,phone,deal_created_at,seen_at,state,reused_from)
    VALUES (96002,$1,$2,$3,'reused',96001)`, [P, new Date("2026-09-25T08:00:00Z").toISOString(), NOW.toISOString()]);
  await carrierDeal(c, 96003, Q, at, "own", "960-c", 1);
  await carrierDeal(c, 96004, phone(96000, 4), at);
  await carrierDeal(c, 96005, phone(96000, 5), at, "no_talk");
  await carrierDeal(c, 96006, phone(96000, 6), new Date("2026-09-10T08:00:00Z"));
  await carrierAnalysed(c, "960-a", "carrier", 0.95, "counterpart");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,reject_reason,created_at_kommo) VALUES
    (96101,'380500960101',8921928,143,'Перевізник','2026-09-24 10:00:00+03'),
    (96102,'ТОВ Вантаж',8921928,143,'Перевізник','2026-09-24 10:00:00+03'),
    (96103,'380500960103',8921928,143,'Дубль','2026-09-24 10:00:00+03'),
    (96104,'380500960104',8921928,143,'Перевізник','2026-09-10 10:00:00+03')`);
  const { rows, kpis } = await carrierCallsList(c.db, "2026-09-22", "2026-09-28");
  assert.equal(rows.length, 2, "🔴 у списку не рівно два дзвінки (угоди без розмови чи поза періодом просочились, або рядок став угодою)");
  const a = rows.find((r) => r.uniqueid === "960-a")!;
  assert.deepEqual(a.deals.map((d) => [d.kommoId, d.reused]).sort(), [[96001, false], [96002, true]], "🔴 угода з повтором вердикту загубилась");
  assert.equal(a.bucket, "carrier");
  assert.equal(rows.find((r) => r.uniqueid === "960-c")!.bucket, null, "🔴 вердикт без аналізу");
  assert.deepEqual({ removed: kpis.removedByFilter, left: kpis.leftAfterFilter, waiting: kpis.waitingTalk, noTalk: kpis.noTalk, listened: kpis.listenedPhones },
    { removed: 1, left: 5, waiting: 1, noTalk: 1, listened: 1 });
  assert.ok(kpis.recordingSince, "🔴 не видно, з якого моменту ведеться облік — старі дні читались би як нуль");
});

/**
 * #961 — КАРТКА: лише дзвінок мобільних (чужий → null → 404); повний текст — лише кому дозволено. І з другого
 * боку: картка «Першого дотику» не відкриває дзвінок мобільних за прямою адресою, а дзвінок, що є і там, і там, — відкриває.
 * 🧨 Червоніє, якщо картка віддасть чужий дзвінок, текст — без права, або зняти захист у картці «Першого дотику».
 */
test("#961 КАРТКА · ЖИВА СХЕМА: лише дзвінки мобільних, текст — за правом; «Перший дотик» мобільний не відкриває", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { carrierCallCard } = await import("./carrierCallScreen.js");
  const { aiCallCard } = await import("./callAiScreen.js");
  const P = phone(96100, 1), S = phone(96100, 2);
  await call(c, "961-mob", min(100), 40, P); await call(c, "961-ad", min(100), 40, "380999961000"); await call(c, "961-both", min(90), 40, S);
  await carrierDeal(c, 96111, P, min(101), "own", "961-mob", 1);
  await carrierDeal(c, 96112, S, min(91), "own", "961-both", 1);
  await carrierAnalysed(c, "961-mob", "carrier", 0.95, "counterpart");
  const both = await carrierAnalysed(c, "961-both", "client", 0.9, "counterpart");
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status) VALUES ($1,'google','gemini-3.8-flash','first-touch-v1','queued')`, [both]);
  const hidden = await carrierCallCard(c.db, "961-mob", false);
  assert.ok(hidden?.result, "дзеркало: вердикт видно всім ролям вкладки");
  assert.equal(hidden?.turns, null, "🔴 повний текст віддано без права");
  assert.equal((await carrierCallCard(c.db, "961-mob", true))?.turns?.length, 2, "дзеркало: з правом — текст є");
  assert.equal(await carrierCallCard(c.db, "961-ad", true), null, "🔴 вкладка мобільних відкрила чужий дзвінок");
  assert.equal(await aiCallCard(c.db, "961-mob", true, {}), null, "🔴 картка «Першого дотику» відкрила дзвінок мобільних");
  assert.ok(await aiCallCard(c.db, "961-both", true, {}), "дзеркало: дзвінок, що є і в «Першому дотику», відкривається");
  assert.ok(await aiCallCard(c.db, "961-ad", true, {}), "дзеркало: звичайний дзвінок картка «Першого дотику» відкриває");
});

/**
 * #962 — ДОСТУП: три роути в матриці = сид вкладки (admin, ceo, opdir, kvp), тімлід, менеджер, фінансист і HR — у deny;
 * межа роутів — вкладка `carrier-calls`, і вона не накриває сусіда `ai-calls`; текст — через `transcriptAllowed(auth)`.
 * 🧨 Червоніє, якщо розвести сид і матрицю, прибрати межу або вирішувати право на текст за `auth.role`.
 */
test("#962 ДОСТУП: матриця = сид (admin, ceo, opdir, kvp), межа — carrier-calls, текст — за ключем ролі", async () => {
  const schema = SRC("db/schema.sql");
  const m = /UPDATE roles SET screen_access = screen_access \|\| '\{"carrier-calls":true\}'::jsonb\s+WHERE key IN \(([^)]+)\)/.exec(schema);
  assert.ok(m, "🔴 сиду вкладки carrier-calls у схемі немає");
  const seeded = m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(seeded, ["admin", "ceo", "kvp", "opdir"]);
  const rows = ACCESS_MATRIX.filter((r) => r.path.startsWith("/api/dashboard/carrier-calls"));
  assert.equal(rows.length, 3, "🔴 не всі роути вкладки в матриці");
  for (const r of rows) {
    assert.deepEqual([...r.allow].sort(), seeded, `🔴 ${r.path}: матриця ≠ сид`);
    for (const d of ["team_lead", "manager", "financier", "hr"]) assert.ok(r.deny.includes(d as never), `🔴 ${r.path}: ${d} не в deny`);
  }
  const { tabsForPath } = await import("../auth/routeTab.js");
  for (const p of ["/api/dashboard/carrier-calls", "/api/dashboard/carrier-calls/meta", "/api/dashboard/carrier-calls/123.45"])
    assert.deepEqual(tabsForPath(p), ["carrier-calls"], `🔴 ${p} без межі вкладки`);
  assert.deepEqual(tabsForPath("/api/dashboard/ai-calls"), ["ai-calls"], "🔴 межа мобільних накрила сусідню вкладку");
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/carrier-calls/:uniqueid"');
  assert.ok(at > 0, "🔴 роут картки не знайдено");
  assert.match(route.slice(at, route.indexOf("});", at)), /carrierCallCard\(pool, [^,]+, transcriptAllowed\(auth\)\)/,
    "🔴 право на текст вирішується не через transcriptAllowed(auth)");
});

/**
 * #962b — МІГРАЦІЯ ДВІЧІ: вкладку мають admin, ceo, opdir, kvp; фінансист (синк «= екрани адміна»), тімлід, HR і
 * менеджер — ні, і ДРУГИЙ прогін схеми цього не змінює (той механізм, що протік `ai-calls`, #794).
 * 🧨 Червоніє, якщо прибрати зняття після синку або поставити його вище за синк.
 */
test("#962b МІГРАЦІЯ ДВІЧІ · ЖИВА СХЕМА: «Перевізники» — у керівництва; фінансист, тімлід, HR і менеджер — НІ", async (t) => {
  const c = await ctx(t); if (!c) return;
  await c.raw.query(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "schema.sql"), "utf8"));
  const rows = (await c.raw.query<{ key: string; screen_access: Record<string, unknown> }>("SELECT key, screen_access FROM roles")).rows;
  const sees = (k: string) => rows.find((r) => r.key === k)?.screen_access?.["carrier-calls"] === true;
  assert.ok(rows.some((r) => r.key === "financier"), "🔴 у scratch-базі немає ролі фінансиста — перевіряти нема чого");
  for (const k of ["admin", "ceo", "opdir", "kvp"]) assert.ok(sees(k), `🔴 «${k}» не бачить вкладки — зняття забрало більше, ніж вирішено`);
  for (const k of ["financier", "team_lead", "hr", "manager"]) assert.ok(!sees(k), `🔴 «${k}» бачить вкладку після ДРУГОЇ міграції`);
});

interface CarrierView {
  BUCKET_UI: Record<string, { label: string }>;
  matchesCarrierFilter: (r: { bucket: string | null }, f: string) => boolean;
  dealStatusLabel: (s: number | null, r: string | null) => string;
  carrierSpeaker: (ch: number, mgr: number | null) => string;
}
async function loadCarrierView(): Promise<CarrierView> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("pages/dashboard/carrierCallsView.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as CarrierView;
}

/**
 * #963 — ПРОВОДКА ФРОНТУ: пункт меню в «Продажі», секція — статичним імпортом (#225), кличе три роути; правила
 * вигляду: кошики фронту = кошики бекенду з різними підписами, «ще слухаємо» = без вердикту, стан угоди словами.
 * 🧨 Червоніє, якщо відʼєднати секцію від меню чи роутів, завести lazy або злити підписи кошиків.
 */
test("#963 ПРОВОДКА ФРОНТУ: меню → секція → три роути; кошики, фільтри й стан угоди словами", async () => {
  const layout = readFileSync(FE("components/Layout.tsx"), "utf8");
  assert.match(layout, /label: "Продаж",[\s\S]{0,400}\{ key: "carrier-calls"/, "🔴 пункту «Перевізники за розмовою» у групі «Продаж» немає");
  const dash = readFileSync(FE("pages/Dashboard.tsx"), "utf8");
  assert.match(dash, /import \{ CarrierCallsSection \} from "\.\/dashboard\/sections\/CarrierCallsSection";/, "🔴 секція не імпортована статично");
  assert.match(dash, /section === "carrier-calls" && \([\s\S]{0,200}<CarrierCallsSection \/>/, "🔴 секція не рендериться на своєму ключі");
  assert.doesNotMatch(dash, /lazy\([^)]*CarrierCallsSection/, "🔴 lazy-імпорт розбив би бандл (#225)");
  const sec = readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8");
  for (const fn of ["fetchCarrierCalls(", "fetchCarrierCallCard(", "fetchCarrierCallsMeta("]) assert.ok(sec.includes(fn), `🔴 секція не кличе ${fn}`);
  const api = readFileSync(FE("api.ts"), "utf8");
  for (const p of ['"/dashboard/carrier-calls"', '"/dashboard/carrier-calls/meta"', "`/dashboard/carrier-calls/${"]) assert.ok(api.includes(p), `🔴 api не ходить на ${p}`);
  const V = await loadCarrierView();
  assert.deepEqual(Object.keys(V.BUCKET_UI).sort(), ["carrier", "client", "low", "other", "unclear"], "🔴 фронт і бекенд знають різні кошики");
  const labels = Object.values(V.BUCKET_UI).map((x) => x.label);
  assert.equal(new Set(labels).size, labels.length, "🔴 два кошики з однаковим підписом");
  assert.equal(V.matchesCarrierFilter({ bucket: null }, "pending"), true);
  assert.equal(V.matchesCarrierFilter({ bucket: "carrier" }, "pending"), false, "🔴 розмова з вердиктом — у «ще слухаємо»");
  assert.equal(V.matchesCarrierFilter({ bucket: "low" }, "carrier"), false, "🔴 невпевнений вердикт показано як перевізника");
  assert.equal(V.dealStatusLabel(70419108, null), "висить на етапі");
  assert.equal(V.dealStatusLabel(143, "Перевізник"), "закрито: Перевізник");
  assert.equal(V.dealStatusLabel(null, null), "угоди ще немає в дашборді", "🔴 невідомий стан угоди показано порожнім");
  assert.equal(V.carrierSpeaker(0, null), "Канал 0", "🔴 невідомий канал менеджера видано за відомий");
});

/**
 * #964 — СТАН КОНВЕЄРА МОБІЛЬНИХ: черга рахує лише дзвінки мобільних (рекламний рядок не домішується), витрати —
 * лише операції `carrier_*`, стеля — $15.
 * 🧨 Червоніє, якщо рахувати всю чергу чи всі витрати під підписом мобільних.
 */
test("#964 СТАН МОБІЛЬНИХ · ЖИВА СХЕМА: черга й витрати — лише мобільних, стеля $15", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c);
  const { carrierCallsMeta } = await import("./carrierCallScreen.js");
  await carrierDeal(c, 96401, phone(96400, 1), min(60), "own", "964-mob", 1);
  await c.raw.query(`INSERT INTO call_transcripts(uniqueid,provider,model,status) VALUES
    ('964-mob','elevenlabs','scribe_v2','queued'), ('964-ad','elevenlabs','scribe_v2','queued')`);
  await c.raw.query(`INSERT INTO ai_spend_ledger(at,provider,operation,units,unit,unit_price_usd) VALUES
    ($1,'elevenlabs','carrier_stt',2,'audio_sec',1), ($1,'elevenlabs','stt',5,'audio_sec',1)`, [NOW.toISOString()]);
  const m = await carrierCallsMeta(c.db, NOW, { stt: 40, analysis: 10 });
  assert.equal(m.transcripts.queued, 1, "🔴 у черзі мобільних рахується чужий дзвінок");
  assert.equal(m.spend.carrier, 2, "🔴 витрати мобільних змішано з рекламними");
  assert.equal(m.spend.stt, 7, "дзеркало: загальні витрати розпізнавання — усі");
  assert.equal(m.caps.carrier, 15);
});
