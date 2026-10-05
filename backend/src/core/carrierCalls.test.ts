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
/** Відповідь рубрики `carrier-v2` — ключі з ТЗ 30.09.2026. */
const CARRIER_JSON_V2 = JSON.stringify({ summary: "перевізник шукає вантаж", manager_channel: "1", verdict: "carrier", other_type: "",
  confidence: 0.95, reason: "має свою фуру й шукає вантаж", quote: "своя фура шукаю вантаж" });
const FIRST_TOUCH_JSON = JSON.stringify({ summary: "s", manager_channel: "1", client_request: "тент", next_step: "",
  price: { discussed: false, quote: "" }, objections: [], promises: [] });

/** Мережа: Gemini відповідає за РУБРИКОЮ запиту (схема з `other_type` — перевізники v2, з `caller_role` — v1, інакше — перший дотик). */
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
        const body = String(init?.body ?? "");
        const v2 = body.includes("other_type"), carrier = v2 || body.includes("caller_role");
        if (carrier) hits.geminiCarrier++;
        return Response.json({ candidates: [{ content: { parts: [{ text: v2 ? CARRIER_JSON_V2 : carrier ? CARRIER_JSON : FIRST_TOUCH_JSON }] }, finishReason: "STOP" }],
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
/** 🛡 Синк дзвінків «щойно вдався» (хвилину тому) — без нього «без розмови» на паузі (`carrierNoTalkGuard.ts`). */
async function syncedAt(c: Raw, at: Date | null = new Date(NOW.getTime() - 60_000)) {
  if (!at) { await c.raw.query("DELETE FROM job_runs WHERE name = 'syncCallsFresh'"); return; }
  await c.raw.query(`INSERT INTO job_runs(name, last_success_at) VALUES ('syncCallsFresh', $1)
    ON CONFLICT (name) DO UPDATE SET last_success_at = EXCLUDED.last_success_at`, [at.toISOString()]);
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
  assert.deepEqual(r, { onStage: 4, tooYoung: 1, noPhone: 1, beforeLaunch: 0, inserted: 2 });
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
  await call(c, "931-3s", min(25 * 60), 3, phone(93100, 3));     // дзвінок, що створив угоду, — короткий
  await syncedAt(c);
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

interface CarrierView {
  CARRIER_TABS: readonly { key: string; label: string; hint: string }[];
  tabOf: (c: string) => string | null;
  CATEGORY_UI: Record<string, { label: string }>;
  OTHER_TYPE_UI: Record<string, string>;
  DECISION_UI: Record<string, { label: string }>;
  dealStatusLabel: (s: number | null, r: string | null) => string;
  closeLabel: (c: { state: string; at: string; reason?: string } | null, fmt: (iso: string) => string) => string | null;
  deciderLabel: (role: string | null) => string;
}
async function loadCarrierView(): Promise<CarrierView> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("pages/dashboard/carrierCallsView.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`) as CarrierView;
}

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
  const m = await carrierCallsMeta(c.db, NOW, { stt: 40, analysis: 10 }, { mode: "dry", otherMode: "dry" });
  assert.equal(m.transcripts.queued, 1, "🔴 у черзі мобільних рахується чужий дзвінок");
  assert.equal(m.spend.carrier, 2, "🔴 витрати мобільних змішано з рекламними");
  assert.equal(m.spend.stt, 7, "дзеркало: загальні витрати розпізнавання — усі");
  assert.equal(m.caps.carrier, 15);
});

// ─── Закриття перевізників у Kommo ──────────────────────────────────────────

function fakeKommo(fail = false) {
  const calls: { patch: unknown[][]; notes: unknown[][] } = { patch: [], notes: [] };
  return { calls, kommo: {
    patchLeads: async (b: unknown[]) => { calls.patch.push(b); if (fail) throw new Error("Kommo API error 502"); return {}; },
    addNotes: async (b: unknown[]) => { calls.notes.push(b); return {}; },
  } };
}
async function seedClose(c: Raw, base: number) {
  const mk = async (n: number, role: string, conf: number, qc: string) => {
    const P = phone(base, n), u = `${String(base)}-${String(n)}`;
    await call(c, u, min(200), 40, P);
    await carrierDeal(c, base + n, P, min(201), "own", u, 1);
    await carrierAnalysed(c, u, role, conf, qc);
  };
  await mk(1, "carrier", 0.95, "counterpart");     // кандидат
  await mk(2, "carrier", 0.84, "counterpart");     // нижче порогу
  await mk(3, "client", 0.95, "counterpart");      // клієнт
  await mk(4, "carrier", 0.95, "manager");         // цитата менеджера
  await mk(5, "carrier", 0.95, "counterpart");     // уже не на етапі
  await c.raw.query(`INSERT INTO carrier_call_deals(kommo_id,phone,deal_created_at,seen_at,state,reused_from)
    VALUES ($1,$2,$3,$4,'reused',$5)`, [base + 6, phone(base, 1), min(100).toISOString(), NOW.toISOString(), base + 1]);
  return new Set([base + 1, base + 2, base + 3, base + 4, base + 6]);
}

/**
 * #970 — КАНДИДАТИ НА ЗАКРИТТЯ: лише впевнений перевізник (≥ 0,85 і цитата співрозмовника) і лише угода, що досі
 * на етапі за відповіддю Kommo; угода з повтором вердикту номера — теж. Клієнт, нижче порогу, фраза менеджера,
 * угода не на етапі, повернута людиною — ні.
 * 🧨 Червоніє, якщо закрити клієнта чи невпевненого, або ігнорувати свіжий етап.
 */
test("#970 КАНДИДАТИ · ЖИВА СХЕМА: лише впевнений перевізник, що досі на етапі; клієнт, поріг, чужа цитата — ні", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log");
  const { closeCandidates } = await import("./carrierClose.js");
  const B = 97000, onStage = await seedClose(c, B);
  await c.raw.query(`INSERT INTO carrier_close_log(kommo_id,uniqueid,confidence,decided_at,mode,closed_at,reverted_at)
    VALUES ($1,'x',0.95,$2,'live',$2,$2)`, [B + 6, NOW.toISOString()]);
  const got = (await closeCandidates(c.db, onStage, NOW)).map((x) => x.kommoId).sort();
  assert.deepEqual(got, [B + 1], "🔴 закриваємо не рівно впевненого перевізника на етапі (або повернуту людиною угоду)");
  await c.raw.query("DELETE FROM carrier_close_log WHERE kommo_id = $1", [B + 6]);
  assert.deepEqual((await closeCandidates(c.db, onStage, NOW)).map((x) => x.kommoId).sort(), [B + 1, B + 6],
    "дзеркало: угода з повтором вердикту номера теж закривається");
});

/**
 * #971 — РЕЖИМИ: `dry` — журнал без жодного запиту до Kommo, повтор не дублює; `live` — один пакет і примітки,
 * закрите позначено й удруге не пишеться; `off` — нічого.
 * 🧨 Червоніє, якщо «журнал» пише в CRM, «живий» не пише або пише двічі.
 */
test("#971 РЕЖИМИ · ЖИВА СХЕМА: журнал — нуль запитів до Kommo; живий — один пакет і примітки; повтор — нічого", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log");
  const { runCarrierClose } = await import("./carrierClose.js");
  const B = 97100, onStage = await seedClose(c, B);
  const off = fakeKommo();
  assert.equal((await runCarrierClose(c.db, NOW, "off", onStage, off.kommo)).logged, 0);
  const dry = fakeKommo();
  const r1 = await runCarrierClose(c.db, NOW, "dry", onStage, dry.kommo);
  assert.deepEqual([r1.logged, r1.closed, dry.calls.patch.length], [2, 0, 0], "🔴 «лише журнал» записав у Kommo");
  assert.equal((await runCarrierClose(c.db, NOW, "dry", onStage, dry.kommo)).logged, 0, "🔴 журнал дублюється щопроходу");
  const live = fakeKommo();
  const r2 = await runCarrierClose(c.db, NOW, "live", onStage, live.kommo);
  assert.equal(r2.closed, 2);
  assert.equal(live.calls.patch.length, 1, "🔴 закриття не одним пакетом");
  assert.deepEqual((live.calls.patch[0] as { id: number }[]).map((x) => x.id).sort(), [B + 1, B + 6]);
  assert.equal(live.calls.notes.length, 1, "🔴 без примітки менеджер не знатиме, чому угоду закрито");
  await runCarrierClose(c.db, NOW, "live", onStage, live.kommo);
  assert.equal(live.calls.patch.length, 1, "🔴 закриту угоду закрито вдруге");
});

/**
 * #972 — ЗАПИТ ДО KOMMO: закриття — статус 143 у воронці Кваліфікація з причиною «Перевізник» (6343043);
 * повернення — етап «Дзвінки на мобільні» і причина знята; пакети по 50; запис вмикає лише рівно «live».
 * 🧨 Червоніє, якщо переплутати статус, причину чи воронку або ввімкнути запис описком.
 */
test("#972 ЗАПИТ: 143 + «Перевізник», повернення — етап і без причини, пакети по 50, запис лише на «live»", async () => {
  const { closePayload, revertPayload, closeModeOf, chunks } = await import("./carrierClose.js");
  assert.deepEqual(closePayload([5]), [{ id: 5, pipeline_id: 8921928, status_id: 143,
    custom_fields_values: [{ field_id: 2097265, values: [{ enum_id: 6343043 }] }] }]);
  assert.deepEqual(revertPayload(5), [{ id: 5, pipeline_id: 8921928, status_id: 70419108,
    custom_fields_values: [{ field_id: 2097265, values: null }] }]);
  assert.deepEqual(chunks(Array.from({ length: 120 }, (_, i) => i), 50).map((x) => x.length), [50, 50, 20]);
  assert.equal(closeModeOf("live"), "live");
  assert.equal(closeModeOf("off"), "off");
  for (const v of [undefined, "", "LIVE", "yes", "true", " live1"]) assert.equal(closeModeOf(v), "dry", `🔴 «${String(v)}» — не журнал`);
});

/**
 * #973 — ПОВЕРНЕННЯ: закрита угода повертається на етап, у журналі — хто й коли; вдруге — відмова; повернуту
 * автоматика більше не закриває; «лише журнал» і чужу угоду повертати нема чого.
 * 🧨 Червоніє, якщо повернення не пише в Kommo, не лишає сліду або автоматика закриває повернуту знову.
 */
test("#973 ПОВЕРНЕННЯ · ЖИВА СХЕМА: на етап, хто й коли; повернуту більше не закриваємо; журнал і чуже — відмова", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log");
  const { runCarrierClose, revertCarrierClose } = await import("./carrierClose.js");
  const B = 97300, onStage = await seedClose(c, B);
  const k = fakeKommo();
  await runCarrierClose(c.db, NOW, "live", onStage, k.kommo);
  const r = await revertCarrierClose(c.db, B + 1, 42, "kvp@uts", NOW, k.kommo);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(k.calls.patch.at(-1), [{ id: B + 1, pipeline_id: 8921928, status_id: 70419108,
    custom_fields_values: [{ field_id: 2097265, values: null }] }], "🔴 повернення не пішло в Kommo");
  const l = (await c.raw.query<{ reverted_by: number; reverted_at: Date | null }>("SELECT reverted_by, reverted_at FROM carrier_close_log WHERE kommo_id=$1", [B + 1])).rows[0];
  assert.equal(l.reverted_by, 42); assert.ok(l.reverted_at, "🔴 не видно, хто й коли повернув");
  assert.equal((await revertCarrierClose(c.db, B + 1, 42, "kvp@uts", NOW, k.kommo) as { code?: number }).code, 409);
  const before = k.calls.patch.length;
  await runCarrierClose(c.db, NOW, "live", onStage, k.kommo);
  assert.equal(k.calls.patch.length, before, "🔴 повернуту людиною угоду автоматика закрила знову");
  await c.raw.query(`INSERT INTO carrier_close_log(kommo_id,uniqueid,confidence,decided_at,mode) VALUES (97399,'y',0.9,$1,'dry')`, [NOW.toISOString()]);
  assert.equal((await revertCarrierClose(c.db, 97399, 42, "x", NOW, k.kommo) as { code?: number }).code, 409, "🔴 «повернуто» те, що не закривалось");
  assert.equal((await revertCarrierClose(c.db, 97398, 42, "x", NOW, k.kommo) as { code?: number }).code, 404);
});

/**
 * #974 — ПОМИЛКА KOMMO: невдалий запис не позначає угоду закритою, лишає причину; повтор — не раніше ніж за
 * годину (не бомбимо CRM щоп'ять хвилин), після години — пробуємо знову.
 * 🧨 Червоніє, якщо помилку прийняти за закриття або повторювати щопроходу.
 */
test("#974 ПОМИЛКА KOMMO · ЖИВА СХЕМА: не закрито, причина збережена, повтор — не раніше ніж за годину", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log");
  const { runCarrierClose } = await import("./carrierClose.js");
  const B = 97400, onStage = await seedClose(c, B);
  const bad = fakeKommo(true);
  const r = await runCarrierClose(c.db, NOW, "live", onStage, bad.kommo);
  assert.deepEqual([r.closed, r.failed], [0, 2]);
  assert.match(r.error ?? "", /502/);
  const l = (await c.raw.query<{ closed_at: Date | null; close_error: string | null }>("SELECT closed_at, close_error FROM carrier_close_log WHERE kommo_id=$1", [B + 1])).rows[0];
  assert.equal(l.closed_at, null, "🔴 невдалий запис позначено закриттям");
  assert.match(l.close_error ?? "", /502/);
  await runCarrierClose(c.db, new Date(NOW.getTime() + 5 * 60_000), "live", onStage, bad.kommo);
  assert.equal(bad.calls.patch.length, 1, "🔴 після помилки CRM бомбимо щоп'ять хвилин");
  const ok = fakeKommo();
  assert.equal((await runCarrierClose(c.db, new Date(NOW.getTime() + 61 * 60_000), "live", onStage, ok.kommo)).closed, 2, "дзеркало: за годину — пробуємо знову");
});

/**
 * #976 — ПРОХІД ЗАКРИВАЄ ЛИШЕ ТЕ, ЩО KOMMO ЩОЙНО ВІДДАВ «НА ЕТАПІ»: два впевнені перевізники, але Kommo цього
 * проходу віддав лише одного — закривається лише він.
 * 🧨 Червоніє, якщо крок закриття брати етап не з відповіді цього проходу.
 */
test("#976 ПРОХІД · ЖИВА СХЕМА: закривається лише угода з цієї ж відповіді Kommo", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log");
  const { runCarrierTick } = await import("./carrierCalls.js");
  const B = 97600;
  await seedClose(c, B);
  const k = fakeKommo();
  const net = fakeNet();
  const lead = (id: number) => ({ id, name: phone(B, id - B), created_at: sec(min(201)), responsible_user_id: 1 });
  const r = await runCarrierTick({ db: c.db, http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW,
    stageLeads: async () => [lead(B + 1)], alert: async () => {}, close: { mode: "live", kommo: k.kommo } });
  assert.equal(r.closed?.closed, 1);
  assert.deepEqual((k.calls.patch[0] as { id: number }[]).map((x) => x.id), [B + 1], "🔴 закрито угоду, якої Kommo цього проходу на етапі не віддав");
});

// ─── Рішення людини по невпевнених ──────────────────────────────────────────

/** Хто вирішує: керівництво без скоупу (роль до 30.09.2026 не записувалась — `null`), якщо гейт не каже інакше. */
const lead = (userId: number, roleKey: string | null = null, scope: { managerId?: number | null; teamId?: number | null } = {}) => ({ userId, roleKey, scope });

async function seedDecide(c: Raw, base: number) {
  const mk = async (n: number, role: string, conf: number, qc: string, status = 70419108) => {
    const P = phone(base, n), u = `${String(base)}-${String(n)}`;
    await call(c, u, min(300 - n), 40, P);
    await carrierDeal(c, base + n, P, min(301 - n), "own", u, 1);
    await carrierAnalysed(c, u, role, conf, qc);
    await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo) VALUES ($1,$2,8921928,$3,$4)
      ON CONFLICT (kommo_id) DO UPDATE SET status_id = EXCLUDED.status_id`, [base + n, P, status, min(301 - n).toISOString()]);
  };
  await mk(1, "carrier", 0.78, "counterpart");        // невпевнено → у черзі
  await mk(2, "carrier", 0.95, "manager");            // цитата менеджера → у черзі
  await mk(3, "unclear", 0.3, "empty");               // не чути → у черзі
  await mk(4, "carrier", 0.95, "counterpart");        // упевнений → не в черзі (закриває автоматика)
  await mk(5, "client", 0.95, "counterpart");         // упевнений клієнт → не в черзі
  await mk(6, "carrier", 0.7, "counterpart", 143);    // уже не на етапі → не в черзі
  return new Set([base + 1, base + 2, base + 3, base + 4, base + 5]);
}

/**
 * #1040 — ЧЕРГА: лише невпевнені (нижче порогу, цитата менеджера, «не чути»), що стоять на етапі й без рішення людини.
 * Упевнений перевізник (його закриває автоматика), упевнений клієнт, угода не на етапі, вирішена — ні.
 * 🧨 Червоніє, якщо в черзі опиниться впевнений, вирішений або вже зрушений.
 */
test("#1040 ЧЕРГА · ЖИВА СХЕМА: лише невпевнені на етапі без рішення; упевнені, вирішені, не на етапі — ні", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log, carrier_decisions");
  const { decisionQueue, recordDecision } = await import("./carrierDecisions.js");
  const B = 98000; await seedDecide(c, B);
  const q1 = await decisionQueue(c.db, NOW);
  assert.deepEqual(q1.pending.map((x) => x.kommoId).sort(), [B + 1, B + 2, B + 3], "🔴 черга — не рівно невпевнені на етапі");
  assert.deepEqual(q1.pending.map((x) => x.why).sort(), ["впевненість нижче 85%", "розмову не розібрати", "доказ — слова менеджера, а не того, хто дзвонив"].sort());
  assert.equal((await recordDecision(c.db, B + 1, "client", null, "", lead(7), NOW)).ok, true);
  const q2 = await decisionQueue(c.db, NOW);
  assert.ok(!q2.pending.some((x) => x.kommoId === B + 1), "🔴 вирішена угода лишилась у черзі");
  assert.deepEqual(q2.decided.map((x) => [x.kommoId, x.decision]), [[B + 1, "client"]], "дзеркало: вирішена — у «Вирішених»");
});

/**
 * #1041 — ЛЮДИНА СИЛЬНІША ЗА AI в обидва боки: «Перевізник» людини → закриваємо навіть невпевнений вердикт (з приміткою
 * «рішення людини»); «Клієнт» людини → упевненого перевізника НЕ закриваємо.
 * 🧨 Червоніє, якщо автоматика ігнорує рішення людини в будь-який бік.
 */
test("#1041 ЛЮДИНА СИЛЬНІША · ЖИВА СХЕМА: «Перевізник» — закриваємо невпевненого; «Клієнт» — не закриваємо впевненого", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log, carrier_decisions");
  const { recordDecision } = await import("./carrierDecisions.js");
  const { closeCandidates, closeNoteText } = await import("./carrierClose.js");
  const B = 98100; const onStage = await seedDecide(c, B);
  const before = (await closeCandidates(c.db, onStage, NOW)).map((x) => x.kommoId);
  assert.deepEqual(before, [B + 4], "дзеркало: без рішень закривається лише впевнений перевізник");
  await recordDecision(c.db, B + 1, "carrier", null, "свій бус", lead(7), NOW);
  await recordDecision(c.db, B + 4, "client", null, "він просив машину", lead(7), NOW);
  const after = await closeCandidates(c.db, onStage, NOW);
  assert.deepEqual(after.map((x) => x.kommoId), [B + 1], "🔴 рішення людини не переважило AI");
  assert.equal(after[0].byHuman, true);
  assert.match(closeNoteText(after[0].confidence ?? 0, after[0].quote, true), /рішення людини/);
});

/**
 * #1042 — ЗАПИС РІШЕННЯ: невідоме — 400, чужа угода — 404, угода вже закрита в CRM — 409 (повертати треба кнопкою);
 * історія лише дописується, чинне — останнє, поруч — що казав AI у момент рішення.
 * 🧨 Червоніє, якщо дозволити змінити закриту, губити історію або приймати сміття.
 */
test("#1042 РІШЕННЯ · ЖИВА СХЕМА: 400/404/409, історія дописується, чинне — останнє, вердикт AI збережено", async (t) => {
  const c = await ctx(t); if (!c) return;
  await reset(c); await c.raw.query("TRUNCATE carrier_close_log, carrier_decisions");
  const { recordDecision, decisionQueue } = await import("./carrierDecisions.js");
  const B = 98200; await seedDecide(c, B);
  assert.equal((await recordDecision(c.db, B + 1, "maybe", null, "", lead(7), NOW) as { code?: number }).code, 400);
  assert.equal((await recordDecision(c.db, 98299, "client", null, "", lead(7), NOW) as { code?: number }).code, 404);
  await recordDecision(c.db, B + 1, "carrier", null, "", lead(7), NOW);
  await recordDecision(c.db, B + 1, "other", null, "реклама", lead(8), new Date(NOW.getTime() + 1000));
  const h = (await c.raw.query<{ decision: string; ai_role: string | null; ai_confidence: string | null }>(
    "SELECT decision, ai_role, ai_confidence FROM carrier_decisions WHERE kommo_id=$1 ORDER BY id", [B + 1])).rows;
  assert.deepEqual(h.map((x) => x.decision), ["carrier", "other"], "🔴 історію рішень переписано");
  assert.deepEqual([h[0].ai_role, Number(h[0].ai_confidence)], ["carrier", 0.78], "🔴 не видно, що казав AI у момент рішення");
  assert.equal((await decisionQueue(c.db, NOW)).decided.find((x) => x.kommoId === B + 1)?.decision, "other", "🔴 чинне — не останнє");
  await c.raw.query(`INSERT INTO carrier_close_log(kommo_id,uniqueid,confidence,decided_at,mode,closed_at) VALUES ($1,'x',0.9,$2,'live',$2)`, [B + 2, NOW.toISOString()]);
  assert.equal((await recordDecision(c.db, B + 2, "client", null, "", lead(7), NOW) as { code?: number }).code, 409, "🔴 змінили рішення по вже закритій угоді");
});

/**
 * #1043 — ЧОМУ НЕ ВПЕВНЕНИЙ: «невпевнено» (нижче 0,85), «цитата менеджера», «цитата не знайдена», «не чути»; упевнений — null.
 * 🧨 Червоніє, якщо причина злиється або впевнений потрапить у чергу.
 */
test("#1043 ЧОМУ НЕ ВПЕВНЕНИЙ: чотири різні причини, упевнений — без причини", async () => {
  const { whyUncertain } = await import("./carrierDecisions.js");
  const w = (role: CarrierResult["caller_role"], conf: number, qc: CarrierResult["quote_check"]) =>
    whyUncertain({ caller_role: role, caller_role_confidence: conf, quote_check: qc });
  assert.equal(w("carrier", 0.8, "counterpart"), "впевненість нижче 85%");
  assert.equal(w("carrier", 0.95, "manager"), "доказ — слова менеджера, а не того, хто дзвонив");
  assert.equal(w("client", 0.95, "absent"), "у розмові немає фрази-доказу");
  assert.equal(w("unclear", 0.3, "empty"), "розмову не розібрати");
  assert.equal(w("carrier", 0.95, "counterpart"), null, "🔴 упевнений вердикт отримав причину — потрапить у чергу");
  assert.equal(w("other", 0.9, "empty"), null);
});


// ─── Відсів перевізників (ТЗ Романа 30.09.2026): рубрика v2, категорії, скоуп ролей, звіт, «Інше» ─────────

/** Вердикт рубрики `carrier-v2` (підтип і причина) на розшифровці з двома каналами. */
async function carrierAnalysedV2(c: Raw, u: string, role: string, conf: number, quoteCheck: string, otherType: string | null = null) {
  const t = await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ($1,'elevenlabs','scribe_v2','done','[{"channel":1,"start":0,"end":1,"text":"Добрий день","lang":"ukr"},{"channel":0,"start":1,"end":3,"text":"у мене своя фура","lang":"ukr"}]'::jsonb) RETURNING id`, [u]);
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,result)
    VALUES ($1,'google','gemini-3.8-flash','carrier-v2','done',$2::jsonb)`,
  [t.rows[0].id, JSON.stringify({ summary: "s", manager_channel: "1", caller_role: role, caller_role_confidence: conf, caller_role_quote: "своя фура",
    quote_check: quoteCheck, other_type: otherType, reason: `чому ${role}` })]);
  return t.rows[0].id;
}
/** Дві команди, три менеджери: A — 1 і 2, B — 3. Kommo user id менеджера = 10600 + n. Повтор нічого не дублює. */
async function seedTeams(c: Raw) {
  await c.raw.query(`INSERT INTO teams(id,name) VALUES (10601,'Команда A 1060'),(10602,'Команда B 1060') ON CONFLICT (id) DO NOTHING`);
  await c.raw.query(`INSERT INTO managers(id,name,team_id,kommo_user_id) VALUES
    (10611,'Менеджер 1',10601,10601),(10612,'Менеджер 2',10601,10602),(10613,'Менеджер 3',10602,10603) ON CONFLICT (id) DO NOTHING`);
  return { A: 10601, B: 10602, m1: 10611, m2: 10612, m3: 10613 };
}
async function owner(c: Raw, kommoId: number, kommoUser: number | null) {
  await c.raw.query("UPDATE carrier_call_deals SET responsible_user_id = $2 WHERE kommo_id = $1", [kommoId, kommoUser]);
}
async function resetAll(c: Raw) {
  await reset(c);
  await c.raw.query("TRUNCATE carrier_close_log, carrier_decisions");
}

/**
 * #1060 — РУБРИКА v2: новий мобільний дзвінок слухається лише `carrier-v2` (ключі з ТЗ), а розмова з готовим вердиктом
 * `carrier-v1` удруге НЕ оплачується; рекламний дзвінок — лише рекламна рубрика.
 * 🧨 Червоніє, якщо тік лишиться на v1, або переслуховуватиме вже розібране (прибрати `carrierAnalysedEarlier`).
 */
test("#1060 РУБРИКА v2 · ЖИВА СХЕМА: нове — лише carrier-v2, розібране v1 не оплачується вдруге, рекламне — лише рекламна", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { runCarrierTick } = await import("./carrierCalls.js");
  const { runCallAiTick } = await import("./callAiTick.js");
  const P = phone(10600, 1), Q = phone(10600, 2);
  await call(c, "1060-new", min(100), 30, P);
  await carrierDeal(c, 106001, P, min(101), "own", "1060-new", 1);
  await call(c, "1060-old", min(100), 30, Q);
  await carrierDeal(c, 106002, Q, min(101), "own", "1060-old", 1);
  await carrierAnalysed(c, "1060-old", "client", 0.95, "counterpart");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,created_at_kommo,client_key,lead_channel)
    VALUES (106099,'D',8921932,1,'2026-09-26 10:00:00+03','0999106099','ad')`);
  await call(c, "1060-ad", new Date("2026-09-26T07:30:00Z"), 35, "380999106099");
  const net = fakeNet();
  const tick = { http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW };
  await runCarrierTick({ db: c.db, ...tick, stageLeads: async () => [], alert: async () => {} });
  await runCallAiTick({ db: c.db, ...tick, ad: { predicate: (r: string) => `(d.client_source = ANY(${r}))`, adSources: ["uts.ua"] } });
  const rubrics = async (u: string) => (await c.raw.query<{ r: string }>(`SELECT a.rubric_version r FROM call_analyses a
    JOIN call_transcripts t ON t.id=a.transcript_id WHERE t.uniqueid=$1 ORDER BY 1`, [u])).rows.map((x) => x.r);
  assert.deepEqual(await rubrics("1060-new"), ["carrier-v2"], "🔴 новий мобільний дзвінок слухається не рубрикою v2");
  assert.deepEqual(await rubrics("1060-old"), ["carrier-v1"], "🔴 розібраний v1 дзвінок переслухали й оплатили вдруге");
  assert.equal(net.hits.geminiCarrier, 1, "🔴 модель кликали не рівно для одного нового дзвінка");
  // Рубрика «Першого дотику» — з константи: вона змінюється разом із ТЗ (30.09.2026 — first-touch-v2).
  assert.deepEqual(await rubrics("1060-ad"), [(await import("./callAiProviders.js")).RUBRIC_CURRENT], "🔴 рекламний дзвінок отримав рубрику перевізників");
  const res = (await c.raw.query<{ result: CarrierResult }>(`SELECT a.result FROM call_analyses a JOIN call_transcripts t ON t.id=a.transcript_id
    WHERE t.uniqueid='1060-new'`)).rows[0].result;
  assert.deepEqual([res.caller_role, res.other_type, res.quote_check, carrierBucket(res)], ["carrier", null, "counterpart", "carrier"]);
  assert.equal(res.reason, "має свою фуру й шукає вантаж", "🔴 причина вердикту загубилась");
});

/**
 * #1061 — РОЗБІР v2: ключі відповіді — дослівно з ТЗ; підтип є лише в «Інше» (у решти — null, навіть якщо модель його
 * дала); невідомий підтип «Інше» → «other», а не відмова; сміття — відмова.
 * 🧨 Червоніє, якщо пропустити підтип іншим вердиктам, відкидати «Інше» з незнайомим підтипом або змінити ключі.
 */
test("#1061 РОЗБІР v2: ключі з ТЗ, підтип лише в «Інше», невідомий підтип — «other», сміття — відмова", async () => {
  const { CARRIER_SCHEMA_V2, OTHER_TYPES, OTHER_TYPE_UA, interpretCarrierV2 } = await import("./carrierCallRules.js");
  assert.deepEqual([...OTHER_TYPES], ["spam", "supplier", "job_seeker", "personal", "wrong_number", "other"], "🔴 підтипи ≠ ТЗ");
  assert.deepEqual(Object.keys(OTHER_TYPE_UA).sort(), [...OTHER_TYPES].sort());
  for (const k of ["verdict", "other_type", "confidence", "reason", "summary"]) assert.ok((CARRIER_SCHEMA_V2.required as readonly string[]).includes(k), `🔴 ключа ${k} з ТЗ немає`);
  const turns = [{ channel: 1, start: 0, end: 1, text: "Добрий день", lang: "ukr" }, { channel: 0, start: 1, end: 3, text: "продаємо пальне оптом", lang: "ukr" }];
  const run = (o: Record<string, unknown>) => interpretCarrierV2({ text: JSON.stringify({ summary: "s", manager_channel: "1", verdict: "other",
    other_type: "supplier", confidence: 0.9, reason: "продає пальне", quote: "продаємо пальне оптом", ...o }), finishReason: "STOP", blockReason: null, usage: null }, turns);
  const ok = run({});
  assert.ok(ok.ok); assert.deepEqual(ok.ok && [ok.result.caller_role, ok.result.other_type, ok.result.quote_check, ok.result.reason],
    ["other", "supplier", "counterpart", "продає пальне"]);
  const strange = run({ other_type: "бухгалтерія" });
  assert.ok(strange.ok && strange.result.other_type === "other", "🔴 «Інше» з незнайомим підтипом відкинуто або підтип вигадано");
  const carrier = run({ verdict: "carrier", other_type: "spam" });
  assert.ok(carrier.ok && carrier.result.other_type === null, "🔴 підтип «Інше» потрапив у вердикт «перевізник»");
  assert.equal(run({ confidence: 1.2 }).ok, false, "🔴 впевненість поза 0..1 прийнята");
  assert.equal(run({ reason: 5 }).ok, false, "🔴 причина не рядком прийнята");
  assert.equal(run({ verdict: "maybe" }).ok, false, "🔴 вердикт поза переліком прийнято");
});

/**
 * #1063 — СПИСОК УГОД І СКОУП: рядок — угода (і без розмови теж); менеджер бачить лише свої, тімлід — команду,
 * керівництво — усе; порожній скоуп (`-1`) — нікого; «прибрав фільтр» — лише ті, кого ми після фільтра не бачили.
 * 🧨 Червоніє, якщо зняти фільтр менеджера чи команди, загубити угоду без розмови або рахувати свої закриття як фільтр.
 */
test("#1063 СПИСОК УГОД · ЖИВА СХЕМА: рядок — угода; менеджер — свої, тімлід — команда, керівництво — усе", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const T = await seedTeams(c);
  const { carrierCallsList } = await import("./carrierCallScreen.js");
  const at = new Date("2026-09-24T08:00:00Z");
  const mk = async (n: number, user: number | null, state = "own") => {
    const P = phone(10630, n), u = `1063-${String(n)}`;
    if (state === "own") await call(c, u, at, 40, P);
    await carrierDeal(c, 106300 + n, P, at, state, state === "own" ? u : null, state === "own" ? 1 : 0);
    await owner(c, 106300 + n, user);
    return u;
  };
  await carrierAnalysed(c, await mk(1, 10601), "carrier", 0.95, "counterpart");       // м1 · перевізник
  await mk(2, 10601, "no_talk");                                                           // м1 · без розмови → перевірка
  await carrierAnalysedV2(c, await mk(3, 10602), "client", 0.95, "counterpart");        // м2 · клієнт
  const u4 = await mk(4, 10602);                                                           // м2 · збій аналізу → помилка
  const t4 = await c.raw.query<{ id: string }>(`INSERT INTO call_transcripts(uniqueid,provider,model,status,segments)
    VALUES ($1,'elevenlabs','scribe_v2','done','[{"channel":0,"start":0,"end":1,"text":"так","lang":"ukr"}]'::jsonb) RETURNING id`, [u4]);
  await c.raw.query(`INSERT INTO call_analyses(transcript_id,provider,model,rubric_version,status,attempts,failure)
    VALUES ($1,'google','gemini-3.8-flash','carrier-v2','failed',3,'502')`, [t4.rows[0].id]);
  await carrierAnalysedV2(c, await mk(5, 10603), "other", 0.9, "counterpart", "spam"); // м3 · інше/спам
  await mk(6, 99999, "waiting");                                                           // невідомий менеджер
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,reject_reason,created_at_kommo) VALUES
    (106391,'380500106391',8921928,143,'Перевізник','2026-09-24 10:00:00+03'),
    (106301,'380500106301',8921928,143,'Перевізник','2026-09-24 10:00:00+03')`);
  const all = await carrierCallsList(c.db, "2026-09-22", "2026-09-28", {});
  const byId = new Map(all.rows.map((r) => [r.kommoId, r]));
  assert.equal(all.rows.length, 6, "🔴 не кожна угода — рядок (без розмови чи без менеджера загубились)");
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => byId.get(106300 + n)?.category), ["carrier", "no_talk", "client", "error", "other", "waiting"]);
  assert.equal(byId.get(106305)?.otherType, "spam");
  assert.equal(byId.get(106304)?.why, "AI не відповів після кількох спроб", "🔴 «Помилка» не каже причину");
  assert.equal(all.kpis.removedByFilter, 1, "🔴 нашу угоду, закриту як «Перевізник», пораховано як роботу фільтра");
  const ids = async (scope: { managerId?: number | null; teamId?: number | null }) =>
    (await carrierCallsList(c.db, "2026-09-22", "2026-09-28", scope)).rows.map((r) => r.kommoId - 106300).sort();
  assert.deepEqual(await ids({ managerId: T.m1 }), [1, 2], "🔴 менеджер бачить не рівно свої угоди");
  assert.deepEqual(await ids({ teamId: T.A }), [1, 2, 3, 4], "🔴 тімлід бачить не рівно свою команду");
  assert.deepEqual(await ids({ teamId: T.B }), [5]);
  assert.deepEqual(await ids({ managerId: -1 }), [], "🔴 порожній скоуп менеджера відкрив чужі угоди");
});

/**
 * #1064 — ЗВІТ = СПИСКИ: кожна клітинка звіту — рівно кількість рядків вкладки з тим самим менеджером і категорією;
 * рядок команди — сума її менеджерів; «Інше» окремо від перевізників; вручну — окремо від AI; без менеджера — свій рядок.
 * 🧨 Червоніє, якщо звіт рахувати інакше, ніж вкладки, злити «Інше» з перевізниками чи ручне з AI.
 */
test("#1064 ЗВІТ · ЖИВА СХЕМА: клітинка = рядки вкладки; команда = сума менеджерів; «Інше» й «вручну» окремо", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  await seedTeams(c);
  const { carrierDealRows, carrierReport } = await import("./carrierDeals.js");
  const { recordDecision } = await import("./carrierDecisions.js");
  const at = new Date("2026-09-24T08:00:00Z");
  const mk = async (n: number, user: number | null, role: string, conf: number, other: string | null = null) => {
    const P = phone(10640, n), u = `1064-${String(n)}`;
    await call(c, u, at, 40, P);
    await carrierDeal(c, 106400 + n, P, at, "own", u, 1);
    await owner(c, 106400 + n, user);
    await carrierAnalysedV2(c, u, role, conf, "counterpart", other);
  };
  await mk(1, 10601, "carrier", 0.95); await mk(2, 10601, "carrier", 0.6); await mk(3, 10601, "other", 0.9, "spam");
  await mk(4, 10602, "client", 0.95); await mk(5, 10602, "carrier", 0.5); await mk(6, 10603, "other", 0.5);
  await mk(7, null, "client", 0.95);
  await recordDecision(c.db, 106402, "carrier", null, "", lead(1), NOW);           // м1: вручну перевізник
  await recordDecision(c.db, 106406, "other", "wrong_number", "", lead(1), NOW);   // м3: вручну інше
  const rows = await carrierDealRows(c.db, { period: { from: "2026-09-22", to: "2026-09-28" }, scope: {} });
  const rep = carrierReport(rows);
  const COLS = {
    clients: (r: (typeof rows)[number]) => r.category === "client",
    carriersAuto: (r: (typeof rows)[number]) => r.category === "carrier" && r.source !== "human",
    carriersManual: (r: (typeof rows)[number]) => r.category === "carrier" && r.source === "human",
    otherAuto: (r: (typeof rows)[number]) => r.category === "other" && r.source !== "human",
    otherManual: (r: (typeof rows)[number]) => r.category === "other" && r.source === "human",
    unsorted: (r: (typeof rows)[number]) => ["review", "error", "waiting"].includes(r.category),
  } as const;
  for (const m of rep.managers) {
    const mine = rows.filter((r) => r.managerId === m.managerId);
    assert.equal(m.total, mine.length, `🔴 ${String(m.managerName)}: «усього» ≠ рядкам вкладки`);
    for (const [k, f] of Object.entries(COLS)) assert.equal(m[k as keyof typeof COLS], mine.filter(f).length, `🔴 ${String(m.managerName)} · ${k} ≠ списку`);
  }
  const m1 = rep.managers.find((m) => m.managerId === 10611)!;
  assert.deepEqual([m1.carriersAuto, m1.carriersManual, m1.otherAuto, m1.otherManual], [1, 1, 1, 0], "🔴 ручне й AI або «Інше» й перевізники злились");
  const m3 = rep.managers.find((m) => m.managerId === 10613)!;
  assert.deepEqual([m3.otherManual, m3.unsorted], [1, 0]);
  assert.ok(rep.managers.some((m) => m.managerId === null && m.total === 1), "🔴 угода без менеджера зникла зі звіту");
  const A = rep.teams.find((x) => x.teamId === 10601)!;
  const sumA = rep.managers.filter((m) => m.teamId === 10601).reduce((s, m) => s + m.total, 0);
  assert.equal(A.total, sumA, "🔴 рядок команди ≠ сумі її менеджерів");
  assert.equal(rep.total.total, rows.length, "🔴 «разом» ≠ усім рядкам вкладок");
  const route = SRC("routes/dashboard.ts");
  const at2 = route.indexOf('dashboardRouter.get("/carrier-calls/report"');
  assert.ok(at2 > 0, "🔴 роуту звіту немає");
  assert.match(route.slice(at2, route.indexOf("dashboardRouter.", at2 + 10)), /const rows = await carrierDealRows\(pool, \{ period: \{ from, to \}, scope, since: CARRIER_SINCE\(\) \}\);\s*const rep = carrierReport\(rows\);/,
    "🔴 звіт рахується не з тих самих рядків, що вкладки");
});

/**
 * #1065 — РІШЕННЯ ЗА РОЛЛЮ: менеджер — лише свої (чужа — 404), тімлід — команда (інша — 404) і може переписати
 * менеджера; менеджер не переписує тімліда, тімлід — керівника (409); підтип — лише для «Інше»; журнал — усі рішення з ролями.
 * 🧨 Червоніє, якщо зняти скоуп, дозволити молодшому переписати старшого або загубити старі рішення.
 */
test("#1065 РІШЕННЯ ЗА РОЛЛЮ · ЖИВА СХЕМА: менеджер — свої, тімлід — команда й над менеджером, старшого не переписати", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const T = await seedTeams(c);
  const { recordDecision } = await import("./carrierDecisions.js");
  const { carrierDealRows } = await import("./carrierDeals.js");
  const mk = async (n: number, user: number) => {
    const P = phone(10650, n), u = `1065-${String(n)}`;
    await call(c, u, min(300), 40, P);
    await carrierDeal(c, 106500 + n, P, min(301), "own", u, 1);
    await owner(c, 106500 + n, user);
    await carrierAnalysedV2(c, u, "carrier", 0.6, "counterpart");
  };
  await mk(1, 10601); await mk(2, 10602); await mk(3, 10603);
  const mgr1 = lead(21, "manager", { managerId: T.m1 }), tlA = lead(22, "team_lead", { teamId: T.A }), boss = lead(23, "kvp", {});
  const code = (x: { ok: true } | { ok: false; code: number }) => (x.ok ? 200 : x.code);
  assert.equal(code(await recordDecision(c.db, 106501, "client", null, "", mgr1, NOW)), 200, "дзеркало: менеджер вирішує своє");
  assert.equal(code(await recordDecision(c.db, 106502, "client", null, "", mgr1, NOW)), 404, "🔴 менеджер вирішив чужу угоду");
  assert.equal(code(await recordDecision(c.db, 106503, "client", null, "", tlA, NOW)), 404, "🔴 тімлід вирішив угоду іншої команди");
  assert.equal(code(await recordDecision(c.db, 106501, "carrier", null, "", tlA, new Date(NOW.getTime() + 1000))), 200, "🔴 тімлід не може переписати менеджера");
  assert.equal(code(await recordDecision(c.db, 106501, "client", null, "", mgr1, new Date(NOW.getTime() + 2000))), 409, "🔴 менеджер переписав тімліда");
  assert.equal(code(await recordDecision(c.db, 106501, "other", "spam", "", boss, new Date(NOW.getTime() + 3000))), 200, "дзеркало: керівник переписує тімліда");
  assert.equal(code(await recordDecision(c.db, 106501, "client", null, "", tlA, new Date(NOW.getTime() + 4000))), 409, "🔴 тімлід переписав керівника");
  assert.equal(code(await recordDecision(c.db, 106502, "client", "spam", "", boss, NOW)), 400, "🔴 підтип «Інше» прийнято для «Клієнт»");
  assert.equal(code(await recordDecision(c.db, 106502, "other", "бухгалтерія", "", boss, NOW)), 400, "🔴 невідомий підтип прийнято");
  const [row] = await carrierDealRows(c.db, { period: null, scope: {}, ids: [106501] });
  assert.deepEqual(row.journal.map((j) => [j.decision, j.role, j.otherType]),
    [["client", "manager", null], ["carrier", "team_lead", null], ["other", "kvp", "spam"]], "🔴 журнал загубив попередні рішення або ролі");
  assert.deepEqual([row.category, row.source, row.otherType], ["other", "human", "spam"], "🔴 чинне — не останнє рішення");
});

/**
 * #1066 — ЗАКРИТТЯ «ІНШЕ»: рішення людини «Інше» закривається «Нецільовим зверненням» (6340787) з підтипом у примітці;
 * AI-«Інше» — окремим перемикачем: `dry` — лише журнал, `live` — закриваємо, `off` — навіть не пишемо в журнал;
 * «Клієнт» (AI чи людина) — ніколи; перевізник і «Інше» — різними пакетами з різною причиною.
 * 🧨 Червоніє, якщо закрити клієнта, закрити AI-«Інше» без перемикача чи поставити «Інше» причину «Перевізник».
 */
test("#1066 ЗАКРИТТЯ «ІНШЕ» · ЖИВА СХЕМА: людина — закриваємо, AI — лише з перемикачем; клієнт — ніколи; своя причина", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { runCarrierClose } = await import("./carrierClose.js");
  const { recordDecision } = await import("./carrierDecisions.js");
  const B = 106600;
  const mk = async (n: number, role: string, conf: number, other: string | null = null) => {
    const P = phone(B, n), u = `1066-${String(n)}`;
    await call(c, u, min(300), 40, P);
    await carrierDeal(c, B + n, P, min(301), "own", u, 1);
    await carrierAnalysedV2(c, u, role, conf, "counterpart", other);
  };
  await mk(1, "other", 0.9, "spam");     // AI-«Інше»
  await mk(2, "carrier", 0.6);           // людина → «Інше»
  await mk(3, "client", 0.95);           // AI-клієнт
  await mk(4, "carrier", 0.95);          // людина → «Клієнт» поверх упевненого перевізника
  await mk(5, "carrier", 0.95);          // AI-перевізник
  await recordDecision(c.db, B + 2, "other", "supplier", "", lead(1), NOW);
  await recordDecision(c.db, B + 4, "client", null, "", lead(1), NOW);
  const onStage = new Set([1, 2, 3, 4, 5].map((n) => B + n));
  const k = fakeKommo();
  const r1 = await runCarrierClose(c.db, NOW, "live", onStage, k.kommo, "dry");
  const byEnum = new Map(k.calls.patch.map((b) => [(b as { custom_fields_values: { values: { enum_id: number }[] }[] }[])[0].custom_fields_values[0].values[0].enum_id,
    (b as { id: number }[]).map((x) => x.id).sort()]));
  assert.deepEqual(byEnum.get(6343043), [B + 5], "🔴 «Перевізник» закрито не рівно перевізнику");
  assert.deepEqual(byEnum.get(6340787), [B + 2], "🔴 «Інше» людини не закрито «Нецільовим зверненням» або закрито AI-«Інше» без перемикача");
  assert.equal(r1.closed, 2);
  const notes = k.calls.notes.flat() as { entity_id: number; params: { text: string } }[];
  assert.match(notes.find((x) => x.entity_id === B + 2)?.params.text ?? "", /постачальник/, "🔴 підтип не записано в примітку угоди");
  const log = async (id: number) => (await c.raw.query<{ mode: string; closed_at: Date | null; reason: string }>(
    "SELECT mode, closed_at, reason FROM carrier_close_log WHERE kommo_id=$1", [id])).rows[0];
  assert.deepEqual([(await log(B + 1))?.mode, (await log(B + 1))?.closed_at, (await log(B + 1))?.reason], ["dry", null, "other"], "🔴 AI-«Інше» в режимі журналу не лягло в журнал");
  assert.equal(await log(B + 3), undefined, "🔴 клієнта AI поставлено на закриття");
  assert.equal(await log(B + 4), undefined, "🔴 клієнта людини поставлено на закриття");
  const k2 = fakeKommo();
  await runCarrierClose(c.db, NOW, "live", onStage, k2.kommo, "live");
  assert.deepEqual(k2.calls.patch.map((b) => (b as { id: number }[]).map((x) => x.id)), [[B + 1]], "дзеркало: з перемикачем AI-«Інше» закривається, решта — удруге ні");
  await c.raw.query("TRUNCATE carrier_close_log");
  const k3 = fakeKommo();
  const r3 = await runCarrierClose(c.db, NOW, "dry", new Set([B + 1]), k3.kommo, "off");
  assert.deepEqual([r3.candidates, r3.logged], [0, 0], "🔴 «off» для «Інше» усе одно пише в журнал");
  const r4 = await runCarrierClose(c.db, NOW, "off", onStage, k3.kommo, "live");
  assert.deepEqual([r4.logged, k3.calls.patch.length], [0, 0], "🔴 вимкнений основний режим не вимкнув «Інше»");
});

/**
 * #1067 — ДОСТУП І ПРОВОДКА: шість роутів читання в матриці = сид вкладки (керівництво + тімлід + менеджер), HR і
 * фінансист — ні; запис (рішення, повернення) закритий HR; межа — вкладка; скоуп — `missedScopeFor` у кожному роуті;
 * картка, запис і повернення перевіряють скоуп ДО роботи; «pending» і «report» зареєстровані ДО `/:uniqueid`.
 * 🧨 Червоніє, якщо розвести матрицю й сид, прибрати скоуп із роуту чи перевіряти його ПІСЛЯ завантаження запису.
 */
test("#1067 ДОСТУП · ПРОВОДКА: матриця = сид (6 ролей), скоуп у кожному роуті, перевірка ДО роботи, службові до /:uniqueid", async () => {
  const schema = SRC("db/schema.sql");
  const m = /UPDATE roles SET screen_access = screen_access \|\| '\{"carrier-calls":true\}'::jsonb\s+WHERE key IN \(([^)]+)\)/.exec(schema);
  assert.ok(m, "🔴 сиду вкладки carrier-calls у схемі немає");
  const seeded = m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(seeded, ["admin", "ceo", "kvp", "manager", "opdir", "team_lead"]);
  const { CARRIER_LISTEN_ROLES } = await import("./carrierCallScreen.js");
  assert.deepEqual([...CARRIER_LISTEN_ROLES].sort(), seeded, "🔴 слухати запис може не рівно той, хто має вкладку");
  const GETS = ["", "/meta", "/report", "/pending", "/:uniqueid", "/:uniqueid/audio"].map((x) => `/api/dashboard/carrier-calls${x}`);
  for (const p of GETS) {
    const r = ACCESS_MATRIX.find((x) => x.method === "GET" && x.path === p);
    assert.ok(r, `🔴 ${p} немає в матриці`);
    assert.deepEqual([...r.allow].sort(), seeded, `🔴 ${p}: матриця ≠ сид`);
    for (const d of ["hr", "financier"]) assert.ok(r.deny.includes(d as never), `🔴 ${p}: ${d} не в deny`);
  }
  for (const p of ["/api/dashboard/carrier-calls/deals/:kommoId/decision", "/api/dashboard/carrier-calls/deals/:kommoId/revert"]) {
    const w = ACCESS_MATRIX.find((x) => x.method === "POST" && x.path === p);
    assert.ok(w && w.deny.includes("hr" as never), `🔴 ${p}: HR може писати`);
  }
  const { tabsForPath } = await import("../auth/routeTab.js");
  for (const p of ["/api/dashboard/carrier-calls", "/api/dashboard/carrier-calls/report", "/api/dashboard/carrier-calls/x/audio", "/api/dashboard/carrier-calls/deals/1/decision"])
    assert.deepEqual(tabsForPath(p), ["carrier-calls"], `🔴 ${p} без межі вкладки`);
  const route = SRC("routes/dashboard.ts");
  const body = (sig: string) => {
    const at = route.indexOf(sig); assert.ok(at > 0, `🔴 роут ${sig} не знайдено`);
    return route.slice(at, route.indexOf("dashboardRouter.", at + 10));
  };
  assert.match(route, /const carrierScope = \(req[^)]*\) => missedScopeFor\(req\.auth!, req\.query\);/, "🔴 скоуп вкладки не з missedScopeFor");
  for (const sig of ['dashboardRouter.get("/carrier-calls",', 'dashboardRouter.get("/carrier-calls/report"', 'dashboardRouter.get("/carrier-calls/pending"'])
    assert.match(body(sig), /carrierScope\(req\)/, `🔴 ${sig}: без скоупу ролі`);
  const audio = body('dashboardRouter.get("/carrier-calls/:uniqueid/audio"');
  assert.ok(audio.indexOf("callInScope(") > 0 && audio.indexOf("callInScope(") < audio.indexOf("carrierRecording("), "🔴 запис вантажиться ДО перевірки скоупу");
  assert.match(audio, /transcriptAllowed\(auth, CARRIER_LISTEN_ROLES\)/);
  const card = body('dashboardRouter.get("/carrier-calls/:uniqueid",');
  assert.ok(card.indexOf("callInScope(") > 0 && card.indexOf("callInScope(") < card.indexOf("carrierCallCard("), "🔴 картка вантажиться ДО перевірки скоупу");
  const revert = body('dashboardRouter.post("/carrier-calls/deals/:kommoId/revert"');
  assert.ok(revert.indexOf("carrierDealRows(") > 0 && revert.indexOf("carrierDealRows(") < revert.indexOf("revertCarrierClose("), "🔴 повернення пише в Kommo ДО перевірки скоупу");
  assert.match(body('dashboardRouter.post("/carrier-calls/deals/:kommoId/decision"'), /scope: missedScopeFor\(auth, \{\}\)/, "🔴 рішення без скоупу ролі");
  const iu = route.indexOf('dashboardRouter.get("/carrier-calls/:uniqueid"');
  for (const s of ['dashboardRouter.get("/carrier-calls/pending"', 'dashboardRouter.get("/carrier-calls/report"', 'dashboardRouter.get("/carrier-calls/meta"'])
    assert.ok(route.indexOf(s) > 0 && route.indexOf(s) < iu, `🔴 ${s} зареєстровано ПІСЛЯ /:uniqueid — піде як номер дзвінка`);
  const job = SRC("jobs/carrierCallJob.ts");
  assert.match(job, /mode: closeModeOf\(config\.callAi\.carrierAutoClose\)/, "🔴 режим закриття береться не з closeModeOf");
  assert.match(job, /otherMode: closeModeOf\(config\.callAi\.carrierAutoCloseOther\)/, "🔴 перемикач «Інше» береться не з closeModeOf");
});

/**
 * #1068 — МІГРАЦІЯ ДВІЧІ: вкладку мають керівництво, тімлід і менеджер; фінансист (синк «= екрани адміна») і HR — ні,
 * і ДРУГИЙ прогін схеми цього не змінює. Підтип у журналі рішень — лише для «Інше» (перевірка в самій базі).
 * 🧨 Червоніє, якщо прибрати зняття після синку, забути тімліда/менеджера або зняти CHECK підтипу.
 */
test("#1068 МІГРАЦІЯ ДВІЧІ · ЖИВА СХЕМА: вкладка — керівництво, тімлід, менеджер; фінансист і HR — НІ; підтип лише в «Інше»", async (t) => {
  const c = await ctx(t); if (!c) return;
  await c.raw.query(readFileSync(path.join(import.meta.dirname, "..", "..", "src", "db", "schema.sql"), "utf8"));
  const rows = (await c.raw.query<{ key: string; screen_access: Record<string, unknown> }>("SELECT key, screen_access FROM roles")).rows;
  const sees = (k: string) => rows.find((r) => r.key === k)?.screen_access?.["carrier-calls"] === true;
  assert.ok(rows.some((r) => r.key === "financier"), "🔴 у scratch-базі немає ролі фінансиста — перевіряти нема чого");
  for (const k of ["admin", "ceo", "opdir", "kvp", "team_lead", "manager"]) assert.ok(sees(k), `🔴 «${k}» не бачить вкладки`);
  for (const k of ["financier", "hr"]) assert.ok(!sees(k), `🔴 «${k}» бачить вкладку після ДРУГОЇ міграції`);
  await assert.rejects(c.raw.query("INSERT INTO carrier_decisions(kommo_id,decision,other_type,decided_by) VALUES (1,'client','spam',1)"), /carrier_decisions_other_type_chk/,
    "🔴 база прийняла підтип «Інше» для «Клієнт»");
  await c.raw.query("INSERT INTO carrier_decisions(kommo_id,decision,other_type,decided_by) VALUES (1068,'other','spam',1)");
  await c.raw.query("DELETE FROM carrier_decisions WHERE kommo_id = 1068");
});

/**
 * #1069 — ПРОВОДКА ФРОНТУ: меню → секція (статичний імпорт, #225) → список, метадані, черга; картка угоди → картка
 * дзвінка, запис байтами, рішення з підтипом, повернення; блок у «Звіті» → звіт і той самий список; вкладки =
 * «Клієнти / Перевізники / Інше / На перевірці», усе нерозсортоване — у «На перевірці»; підтипи й кнопки = бекенду.
 * 🧨 Червоніє, якщо від'єднати будь-що з цього, розвести підтипи чи кнопки з бекендом або загубити «Помилку».
 */
test("#1069 ПРОВОДКА ФРОНТУ: вкладки ТЗ, картка угоди, блок у «Звіті»; підтипи й кнопки = бекенду", async () => {
  const layout = readFileSync(FE("components/Layout.tsx"), "utf8");
  assert.match(layout, /label: "Продаж",[\s\S]{0,400}\{ key: "carrier-calls"/, "🔴 пункту «Перевізники за розмовою» у групі «Продаж» немає");
  const dash = readFileSync(FE("pages/Dashboard.tsx"), "utf8");
  assert.match(dash, /import \{ CarrierCallsSection \} from "\.\/dashboard\/sections\/CarrierCallsSection";/, "🔴 секція не імпортована статично");
  assert.doesNotMatch(dash, /lazy\([^)]*CarrierCallsSection/, "🔴 lazy-імпорт розбив би бандл (#225)");
  const sec = readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8");
  for (const fn of ["fetchCarrierCalls(", "fetchCarrierCallsMeta(", "fetchCarrierPending(", "<CarrierDealPanel "]) assert.ok(sec.includes(fn), `🔴 секція не має ${fn}`);
  const panel = readFileSync(FE("pages/dashboard/sections/CarrierDealPanel.tsx"), "utf8");
  for (const fn of ["fetchCarrierCallCard(", "fetchCarrierAudio(", "postCarrierDecision(", "revertCarrierClose("]) assert.ok(panel.includes(fn), `🔴 картка не кличе ${fn}`);
  // Ланцюжок ДО ЕКРАНА, а не «блок є в якомусь файлі» (правило 10): меню «Звіт» рендерить `ReportPlanSection`, і саме
  // в ньому блок. 📐 Куплено 30.09.2026: блок стояв у `ReportSection`, який «Звіт» не рендерить, — гейт був зелений,
  // а на екрані блоку не було.
  assert.match(dash, /section === "report" && auth && \(\s*<ReportPlanSection/, "🔴 меню «Звіт» рендерить не ReportPlanSection — блок треба шукати в іншому файлі");
  const report = readFileSync(FE("pages/dashboard/sections/ReportPlanSection.tsx"), "utf8");
  assert.match(report, /<CarrierReportCard from=\{selectedPeriod\.from\} to=\{selectedPeriod\.to\}/, "🔴 блоку «Дзвінки на мобільні» у «Звіті» немає");
  const card = readFileSync(FE("pages/dashboard/sections/CarrierReportCard.tsx"), "utf8");
  for (const fn of ["fetchCarrierReport(", "fetchCarrierCalls("]) assert.ok(card.includes(fn), `🔴 блок звіту не кличе ${fn}`);
  const api = readFileSync(FE("api.ts"), "utf8");
  for (const p of ['"/dashboard/carrier-calls"', '"/dashboard/carrier-calls/report"', '"/dashboard/carrier-calls/pending"', "`/dashboard/carrier-calls/deals/${String(kommoId)}/decision`, { decision, note, otherType }"])
    assert.ok(api.includes(p), `🔴 api не ходить на ${p}`);
  assert.match(api, /\/audio`, \{ responseType: "blob" \}/, "🔴 запис не йде байтами з нашого сервера");
  const V = await loadCarrierView();
  assert.deepEqual(V.CARRIER_TABS.map((x) => x.label), ["Клієнти", "Перевізники", "Інше", "AI не впевнений"], "🔴 вкладки ≠ ТЗ (четверта — «AI не впевнений», Роман 30.09.2026)");
  assert.ok(V.CARRIER_TABS.every((x) => x.hint.length > 20), "🔴 у вкладки немає пояснення під ⓘ");
  assert.deepEqual(["client", "carrier", "other", "review", "error", "waiting", "no_talk"].map(V.tabOf), ["client", "carrier", "other", "review", "review", "review", null],
    "🔴 нерозсортоване (помилка, AI слухає) загубилось з вкладок або «без розмови» потрапило у вкладку");
  assert.deepEqual(Object.keys(V.CATEGORY_UI).sort(), ["carrier", "client", "error", "no_talk", "other", "review", "waiting"]);
  const { OTHER_TYPE_UA } = await import("./carrierCallRules.js");
  assert.deepEqual(V.OTHER_TYPE_UI, { ...OTHER_TYPE_UA }, "🔴 підтипи фронту ≠ бекенду");
  const { HUMAN_DECISIONS } = await import("./carrierDecisions.js");
  assert.deepEqual(Object.keys(V.DECISION_UI).sort(), [...HUMAN_DECISIONS].sort(), "🔴 кнопки фронту ≠ рішення бекенду");
  assert.equal(V.dealStatusLabel(70419108, null), "у CRM: на етапі");
  assert.equal(V.dealStatusLabel(null, null), "у CRM: ще не підтягнули", "🔴 невідомий стан угоди показано порожнім");
  assert.match(V.closeLabel({ state: "closed", at: "2026-09-30T08:00:00Z", reason: "other" }, () => "30.09") ?? "", /Нецільове звернення/);
  assert.deepEqual(["manager", "team_lead", "kvp", null].map(V.deciderLabel), ["менеджер", "тімлід", "керівник", "керівник"]);
  const css = readFileSync(FE("index.css"), "utf8");
  const rm = /@media \(prefers-reduced-motion: reduce\) \{\s*\.cq-panel[^}]*\}[^}]*\}/.exec(css)?.[0] ?? "";
  assert.ok(rm.includes("animation: none") && rm.includes("transition: none"), "🔴 анімації не вимикаються для «зменшити рух»");
});

/**
 * #1070 — ЗАПИС І СКОУП ДЗВІНКА: запис віддається лише для дзвінків вкладки (чужий — 404 без запиту до Ringostat),
 * байтами з нашого сервера; дзвінок бачить лише той скоуп, чия угода: менеджер — свій, тімлід — команди, керівництво — усі.
 * 🧨 Червоніє, якщо віддати чужий запис, ходити за ним у мережу або відкрити дзвінок чужому менеджеру.
 */
test("#1070 ЗАПИС І СКОУП · ЖИВА СХЕМА: лише дзвінки вкладки, байтами; менеджер — свій, тімлід — команда", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const T = await seedTeams(c);
  const { carrierRecording } = await import("./carrierAudio.js");
  const { callInScope } = await import("./carrierDeals.js");
  const P = phone(10700, 1), Q = phone(10700, 2);
  await call(c, "1070-m1", min(100), 40, P); await call(c, "1070-m3", min(100), 40, Q); await call(c, "1070-ad", min(100), 40, "380999107000");
  await carrierDeal(c, 107001, P, min(101), "own", "1070-m1", 1); await owner(c, 107001, 10601);
  await carrierDeal(c, 107002, Q, min(101), "own", "1070-m3", 1); await owner(c, 107002, 10603);
  const net = fakeNet();
  const other = await carrierRecording(c.db, "1070-ad", net.http);
  assert.deepEqual([other.ok, (other as { code?: number }).code, net.hits.ringostat], [false, 404, 0], "🔴 віддали чужий запис або ходили по нього");
  const mine = await carrierRecording(c.db, "1070-m1", net.http);
  assert.ok(mine.ok && mine.bytes.length > 44, "дзеркало: свій запис віддається байтами");
  assert.equal(await callInScope(c.db, "1070-m1", { managerId: T.m1 }), true, "дзеркало: менеджер бачить свій дзвінок");
  assert.equal(await callInScope(c.db, "1070-m3", { managerId: T.m1 }), false, "🔴 менеджер бачить чужий дзвінок");
  assert.equal(await callInScope(c.db, "1070-m3", { teamId: T.A }), false, "🔴 тімлід бачить дзвінок іншої команди");
  assert.equal(await callInScope(c.db, "1070-m3", { teamId: T.B }), true);
  assert.equal(await callInScope(c.db, "1070-m3", {}), true, "дзеркало: керівництво бачить усі");
  assert.equal(await callInScope(c.db, "1070-ad", {}), false, "🔴 чужий дзвінок «у скоупі» вкладки");
});

/**
 * #1071 — ТЕСТ ТОЧНОСТІ: три групи з розміткою CRM (перевізник / клієнт / «Нецільове звернення»); угоди, що пройшли через
 * нашу вкладку, еталоном не є; матриця «група × вердикт» і точність рахуються лише з розібраних; «клієнт як Інше» — окремо.
 * 🧨 Червоніє, якщо взяти в еталон угоду, закриту дашбордом, або рахувати точність із нерозібраними.
 */
test("#1071 ТЕСТ ТОЧНОСТІ · ЖИВА СХЕМА: три групи з CRM, наші закриття — не еталон, точність — з розібраних", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  await c.raw.query("DELETE FROM deals WHERE kommo_id BETWEEN 107100 AND 107199");
  const { planCarrierPilot, pilotVerdict } = await import("./carrierCallPilot.js");
  const at = new Date("2026-09-20T08:00:00Z");
  const mk = async (id: number, pipeline: number, status: number, reason: string | null, analysed: string | null, conf = 0.95) => {
    const P = `380500${String(id)}`;
    await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,reject_reason,created_at_kommo) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, P, pipeline, status, reason, at.toISOString()]);
    await call(c, `1071-${String(id)}`, at, 40, P);
    if (analysed) await carrierAnalysedV2(c, `1071-${String(id)}`, analysed, conf, "counterpart", analysed === "other" ? "spam" : null);
  };
  await mk(107101, 8921928, 143, "Перевізник", "carrier");
  await mk(107102, 8921928, 143, "Перевізник", "client");
  await mk(107103, 8921928, 143, "Перевізник", null);                 // не розібрано — у точність не йде
  await mk(107111, 8921932, 142, null, "client");
  await mk(107112, 8921932, 142, null, "other");                      // клієнт як «Інше»
  await mk(107121, 8921928, 143, "Нецільове звернення", "other");
  await mk(107122, 8921928, 143, "Нецільове звернення", "other", 0.5); // невпевнено — не влучання
  await mk(107123, 8921928, 143, "Нецільове звернення", "other");     // закрита нашою вкладкою — не еталон
  await carrierDeal(c, 107123, "380500107123", at, "own", "1071-107123", 1);
  const picks = await planCarrierPilot(c.db, 30);
  const ours = picks.filter((p) => Number(p.kommo_id) >= 107100 && Number(p.kommo_id) < 107200);
  assert.ok(!ours.some((p) => p.kommo_id === "107123"), "🔴 угода, закрита дашбордом, пішла в еталон");
  assert.deepEqual(["carrier", "client", "other"].map((g) => ours.filter((p) => p.group === g).length), [3, 2, 2]);
  const v = await pilotVerdict(c.db, ours);
  const g = (k: string) => v.groups.find((x) => x.group === k)!;
  assert.deepEqual([g("carrier").n, g("carrier").analysed, g("carrier").hit, g("carrier").accuracy], [3, 2, 1, 0.5], "🔴 точність перевізників з нерозібраними");
  assert.deepEqual([g("other").hit, g("other").accuracy], [1, 0.5], "🔴 невпевнене «Інше» пораховано влучанням");
  assert.equal(v.clientsAsOther, 1, "🔴 клієнта, названого «Інше», не видно окремо");
  assert.equal(v.clientsAsCarrier, 0);
});

/**
 * #1072 — AI ПРОТИ ЛЮДИНИ: по кожному вердикту AI — скільки рішень людей і скільки погодились; рахується ОСТАННЄ рішення
 * по угоді проти того, що AI казав у момент рішення; рішення без вердикту AI (угода без розмови) — не рахується.
 * 🧨 Червоніє, якщо рахувати всі рішення історії чи порівнювати не з тим, що казав AI.
 */
test("#1072 AI ПРОТИ ЛЮДИНИ · ЖИВА СХЕМА: останнє рішення по угоді проти вердикту AI; без вердикту — не рахується", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { carrierCallsMeta } = await import("./carrierCallScreen.js");
  await c.raw.query(`INSERT INTO carrier_decisions(kommo_id,decision,decided_by,ai_role,ai_confidence,decided_at) VALUES
    (1,'client',1,'carrier',0.6,$1), (1,'carrier',1,'carrier',0.6,$2),
    (2,'client',1,'carrier',0.7,$1),
    (3,'other',1,'other',0.8,$1),
    (4,'client',1,NULL,NULL,$1)`, [NOW.toISOString(), new Date(NOW.getTime() + 1000).toISOString()]);
  const m = await carrierCallsMeta(c.db, NOW, { stt: 40, analysis: 10 }, { mode: "dry", otherMode: "dry" });
  const by = Object.fromEntries(m.agreement.map((a) => [a.aiRole, [a.decisions, a.agreed]]));
  assert.deepEqual(by, { carrier: [2, 1], other: [1, 1] }, "🔴 точність за рішеннями людей порахована не з останнього рішення або з угодами без вердикту");
});

/**
 * #1073 — ТОЧКА СТАРТУ (Роман 30.09.2026: «працюємо з 0, тільки після деплою починаємо транскрибацію нового»):
 * угода, створена ДО старту, не записується з відповіді Kommo, її розмова не оплачується, у вкладки й звіт не йде;
 * створена ПІСЛЯ — усе як звичайно. Джоба й чотири роути беруть старт із конфігу.
 * 🧨 Червоніє, якщо зняти межу в записі, у черзі транскрибації чи в рядках вкладок.
 */
test("#1073 ТОЧКА СТАРТУ · ЖИВА СХЕМА: до старту — не пишемо, не слухаємо, не показуємо; після — як звичайно", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { runCarrierTick, recordStageDeals } = await import("./carrierCalls.js");
  const { carrierDealRows } = await import("./carrierDeals.js");
  const launch = min(200);
  const Old = phone(10730, 1), New = phone(10730, 2);
  const rec = await recordStageDeals(c.db, [
    { id: 107301, name: Old, created_at: sec(min(300)), responsible_user_id: null },
    { id: 107302, name: New, created_at: sec(min(100)), responsible_user_id: null }], NOW, launch);
  assert.deepEqual([rec.beforeLaunch, rec.inserted], [1, 1], "🔴 угоду до старту записано (або нову — ні)");
  // Стара угода, записана ще до запровадження старту, — з розмовою: платити за неї не можна.
  await call(c, "1073-old", min(400), 40, phone(10730, 3));
  await carrierDeal(c, 107303, phone(10730, 3), min(401), "own", "1073-old", 1);
  await call(c, "1073-new", min(90), 40, New);
  const net = fakeNet();
  await runCarrierTick({ db: c.db, http: net.http, keys: { elevenlabs: "k", gemini: "g" }, prices: PRICES, now: () => NOW,
    stageLeads: async () => [], alert: async () => {}, launchAt: launch });
  const st = async (u: string) => (await c.raw.query<{ status: string }>("SELECT status FROM call_transcripts WHERE uniqueid=$1", [u])).rows[0]?.status ?? null;
  assert.equal(await st("1073-old"), null, "🔴 розмову угоди до старту поставлено в чергу й оплачено");
  assert.equal(await st("1073-new"), "done", "дзеркало: нова угода слухається");
  const shown = (await carrierDealRows(c.db, { period: null, scope: {}, since: launch.toISOString() })).map((r) => r.kommoId).sort();
  assert.deepEqual(shown, [107302], "🔴 угода до старту потрапила у вкладки/звіт");
  const route = SRC("routes/dashboard.ts");
  assert.match(route, /const CARRIER_SINCE = \(\) => config\.callAi\.carrierLaunchAt;/);
  assert.equal((route.match(/CARRIER_SINCE\(\)/g) ?? []).length, 6, "🔴 не всі роути вкладки, звіту, динаміки й однієї угоди беруть точку старту");
  assert.match(SRC("jobs/carrierCallJob.ts"), /launchAt: new Date\(config\.callAi\.carrierLaunchAt\)/, "🔴 джоба слухає без точки старту");
  assert.match(SRC("config.ts"), /carrierLaunchAt: process\.env\.CARRIER_LAUNCH_AT \?\? "2026-09-30T09:48:08Z"/, "🔴 точка старту ≠ рішенню 30.09.2026");
});

/**
 * #1074 — СТРОК «ДО КІНЦЯ РОБОЧОГО ДНЯ» (Роман 30.09.2026): прийшла в будній день до 18:00 за Києвом — розібрати до
 * 18:00 того ж дня; о 18:00 і пізніше, у п'ятницю ввечері чи у вихідні — до 18:00 наступного робочого дня.
 * 🧨 Червоніє, якщо зсунути межу 18:00, забути вихідні чи рахувати в UTC замість Києва.
 */
test("#1074 СТРОК: до 18:00 того ж будня; після 18:00, вечір пʼятниці й вихідні — наступний робочий день, за Києвом", async () => {
  const { reviewDeadline } = await import("./carrierCallRules.js");
  const k = (iso: string) => reviewDeadline(new Date(iso)).toISOString();
  // Київ у вересні — UTC+3: 18:00 Києва = 15:00 UTC. 30.09.2026 — середа.
  assert.equal(k("2026-09-30T07:00:00Z"), "2026-09-30T15:00:00.000Z", "🔴 ранок будня — не до 18:00 того ж дня");
  assert.equal(k("2026-09-30T14:59:00Z"), "2026-09-30T15:00:00.000Z", "🔴 17:59 — не того ж дня");
  assert.equal(k("2026-09-30T15:00:00Z"), "2026-10-01T15:00:00.000Z", "🔴 рівно 18:00 — має перейти на наступний день");
  assert.equal(k("2026-09-29T22:30:00Z"), "2026-09-30T15:00:00.000Z", "🔴 01:30 ночі за Києвом (ще вівторок в UTC) — не той день");
  assert.equal(k("2026-10-02T16:00:00Z"), "2026-10-05T15:00:00.000Z", "🔴 вечір пʼятниці — не на понеділок");
  assert.equal(k("2026-10-03T09:00:00Z"), "2026-10-05T15:00:00.000Z", "🔴 субота — не на понеділок");
  assert.equal(k("2026-10-04T20:59:00Z"), "2026-10-05T15:00:00.000Z", "🔴 неділя 23:59 — не на понеділок");
  // Зимовий час (UTC+2): 18:00 Києва = 16:00 UTC — зсув береться на ту саму мить.
  assert.equal(k("2026-11-02T08:00:00Z"), "2026-11-02T16:00:00.000Z", "🔴 зимовий час порахований як літній");
});

/**
 * #1075 — ПРОСТРОЧКА В РЯДКАХ І ЗВІТІ: невирішена «На перевірці» після строку — прострочена; до строку — ні; вирішена
 * людиною — ні; упевнена категорія — ні. У звіті «прострочено» = рядкам вкладки з тією ж позначкою.
 * 🧨 Червоніє, якщо позначати вирішені, не рахувати прострочку або розвести звіт і вкладку.
 */
test("#1075 ПРОСТРОЧКА · ЖИВА СХЕМА: після строку — так, до строку й вирішена — ні; звіт = рядки", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { carrierDealRows, carrierReport } = await import("./carrierDeals.js");
  const { recordDecision } = await import("./carrierDecisions.js");
  const came = new Date("2026-09-30T08:00:00Z");     // середа 11:00 Києва → строк 15:00 UTC того ж дня
  const mk = async (n: number, role: string, conf: number) => {
    const P = phone(10750, n), u = `1075-${String(n)}`;
    await call(c, u, came, 40, P);
    await carrierDeal(c, 107500 + n, P, came, "own", u, 1);
    await carrierAnalysedV2(c, u, role, conf, "counterpart");
    await c.raw.query(`UPDATE call_analyses a SET updated_at = $2 FROM call_transcripts t WHERE t.id = a.transcript_id AND t.uniqueid = $1`, [u, came.toISOString()]);
  };
  await mk(1, "carrier", 0.6); await mk(2, "carrier", 0.6); await mk(3, "carrier", 0.95);
  await recordDecision(c.db, 107502, "client", null, "", lead(1), came);
  const at = async (iso: string) => new Map((await carrierDealRows(c.db, { period: null, scope: {}, now: new Date(iso) })).map((r) => [r.kommoId, r]));
  const before = await at("2026-09-30T14:59:00Z"), after = await at("2026-09-30T15:01:00Z");
  assert.equal(before.get(107501)?.overdue, false, "🔴 до кінця робочого дня вже «прострочено»");
  assert.equal(after.get(107501)?.overdue, true, "🔴 після 18:00 невирішена — не прострочена");
  assert.equal(after.get(107501)?.reviewDeadline, "2026-09-30T15:00:00.000Z");
  assert.equal(after.get(107502)?.overdue, false, "🔴 вирішена людиною позначена простроченою");
  assert.equal(after.get(107503)?.overdue, false, "🔴 упевнений перевізник позначений простроченим");
  const rows = [...after.values()];
  assert.equal(carrierReport(rows).total.overdue, rows.filter((r) => r.overdue).length, "🔴 «прострочено» у звіті ≠ рядкам вкладки");
  assert.equal(carrierReport(rows).total.overdue, 1);
});

/**
 * #1076 — ЗАДАЧА В ЗАДАЧНИКУ: одна відкрита на менеджера з числом угод «На перевірці» й строком — найранішим кінцем
 * робочого дня; число оновлюється; розібрав усе — задача закривається сама з причиною й записом у журналі статусів;
 * нова угода після закриття — нова задача; менеджер без черги — без задачі; двох відкритих не буває.
 * 🧨 Червоніє, якщо плодити задачі щопроходу, не закривати розібране чи ставити задачу не тому менеджеру.
 */
test("#1076 ЗАДАЧНИК · ЖИВА СХЕМА: одна відкрита на менеджера, число оновлюється, розібрав — закрилась сама", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  await c.raw.query("DELETE FROM tasks WHERE assignee_id IN (10611, 10612, 10613)");
  await seedTeams(c);
  const { syncCarrierReviewTasks, REVIEW_TASK_DONE_REASON } = await import("./carrierReviewTasks.js");
  const { recordDecision } = await import("./carrierDecisions.js");
  const came = new Date("2026-09-30T08:00:00Z");
  const mk = async (n: number, user: number, role: string, conf: number) => {
    const P = phone(10760, n), u = `1076-${String(n)}`;
    await call(c, u, came, 40, P);
    await carrierDeal(c, 107600 + n, P, came, "own", u, 1); await owner(c, 107600 + n, user);
    await carrierAnalysedV2(c, u, role, conf, "counterpart");
    // Час вердикту — фіксований, а не «зараз»: інакше після 18:00 за Києвом строк переїжджає на завтра, і гейт червоніє
    // за годинником, а не за дефектом (спіймано 30.09.2026 о 18:0x).
    await c.raw.query(`UPDATE call_analyses a SET updated_at = $2 FROM call_transcripts t WHERE t.id = a.transcript_id AND t.uniqueid = $1`, [u, came.toISOString()]);
  };
  await mk(1, 10601, "carrier", 0.6); await mk(2, 10601, "unclear", 0.3); await mk(3, 10602, "client", 0.95);
  const tasks = async () => (await c.raw.query<{ id: number; assignee_id: number; title: string; status: string; deadline: string; close_reason: string | null }>(
    `SELECT id, assignee_id, title, status, to_char(deadline,'YYYY-MM-DD') AS deadline, close_reason FROM tasks
      WHERE assignee_id IN (10611, 10612, 10613) ORDER BY id`)).rows;
  const t1 = new Date("2026-09-30T09:00:00Z");
  const s1 = await syncCarrierReviewTasks(c.db, t1, null);
  assert.deepEqual([s1.created, s1.closed], [1, 0]);
  let all = await tasks();
  assert.deepEqual(all.map((x) => [x.assignee_id, x.title, x.status, x.deadline]),
    [[10611, "📞 Дзвінки на мобільні: розібрати 2", "not_started", "2026-09-30"]], "🔴 задача не тому, не з тим числом чи строком (у м2 черги немає — задачі теж)");
  await syncCarrierReviewTasks(c.db, t1, null);
  assert.equal((await tasks()).length, 1, "🔴 повторний прохід поставив другу задачу");
  await recordDecision(c.db, 107601, "carrier", null, "", lead(21, "manager", { managerId: 10611 }), t1);
  const s2 = await syncCarrierReviewTasks(c.db, t1, null);
  assert.equal(s2.updated, 1);
  assert.equal((await tasks())[0].title, "📞 Дзвінки на мобільні: розібрати 1", "🔴 число в задачі не оновилось");
  await recordDecision(c.db, 107602, "other", "spam", "", lead(21, "manager", { managerId: 10611 }), t1);
  const s3 = await syncCarrierReviewTasks(c.db, t1, null);
  all = await tasks();
  assert.deepEqual([s3.closed, all[0].status, all[0].close_reason], [1, "done", REVIEW_TASK_DONE_REASON], "🔴 розібрав усе — задача не закрилась сама");
  const log = (await c.raw.query("SELECT 1 FROM task_status_log WHERE task_id = $1 AND to_status = 'done'", [all[0].id])).rowCount;
  assert.equal(log, 1, "🔴 автозакриття без запису в журналі статусів");
  await mk(4, 10601, "carrier", 0.5);
  await syncCarrierReviewTasks(c.db, t1, null);
  all = await tasks();
  assert.deepEqual(all.map((x) => x.status), ["done", "not_started"], "дзеркало: нова угода після закриття — нова задача");
  await assert.rejects(c.raw.query(`WITH t AS (INSERT INTO tasks (title, status, assignee_id) VALUES ('x','not_started',10611) RETURNING id)
    INSERT INTO carrier_review_tasks (task_id, manager_id, opened_at) SELECT id, 10611, now() FROM t`), /idx_carrier_review_tasks_open/,
    "🔴 база дозволила другу відкриту задачу менеджеру");
  assert.match(SRC("jobs/carrierCallJob.ts"), /reviewTasks: true,/, "🔴 бойова джоба задач не ставить");
});

/**
 * #1077 — КАТЕГОРІЯ УГОДИ (редакція 30.09.2026): людина сильніша за AI; упевнений AI — його категорія; невпевнений і
 * «не чути» — «На перевірці»; без розмови від 10 с — «без розмови» (закривається, не аналізується); збій після спроб —
 * «Помилка»; решта — AI слухає.
 * 🧨 Червоніє, якщо AI переважить людину, «без розмови» піде людині на перевірку чи помилка злиється з очікуванням.
 */
test("#1077 КАТЕГОРІЯ: людина > AI; поріг 0,85 з обох боків; без розмови — окремо; збій — помилка; черга — AI слухає", async () => {
  const { dealCategory } = await import("./carrierCallRules.js");
  const r = (role: CarrierResult["caller_role"], conf: number, qc: CarrierResult["quote_check"] = "counterpart"): CarrierResult =>
    ({ summary: "", manager_channel: "1", caller_role: role, caller_role_confidence: conf, caller_role_quote: "x", quote_check: qc });
  const cat = (x: Parameters<typeof dealCategory>[0]) => { const v = dealCategory(x); return [v.category, v.source]; };
  const base = { human: null, result: null, dealState: "own", ai: null } as Parameters<typeof dealCategory>[0];
  assert.deepEqual(cat({ ...base, human: "client", result: r("carrier", 0.99), ai: "done" }), ["client", "human"], "🔴 AI переважив людину");
  assert.deepEqual(cat({ ...base, result: r("carrier", 0.85), ai: "done" }), ["carrier", "ai"]);
  assert.deepEqual(cat({ ...base, result: r("carrier", 0.8499), ai: "done" }), ["review", null], "🔴 невпевнений став категорією");
  assert.deepEqual(cat({ ...base, result: r("client", 0.95, "manager"), ai: "done" }), ["review", null], "🔴 цитата менеджера — упевнений клієнт");
  assert.deepEqual(cat({ ...base, result: r("other", 0.9, "empty"), ai: "done" }), ["other", "ai"], "дзеркало: «Інше» цитати не вимагає");
  assert.deepEqual(cat({ ...base, result: r("unclear", 0.3, "empty"), ai: "done" }), ["review", null]);
  assert.deepEqual(cat({ ...base, dealState: "no_talk" }), ["no_talk", null], "🔴 угоду без розмови віддано людині на перевірку");
  assert.deepEqual(cat({ ...base, dealState: "waiting" }), ["waiting", null]);
  for (const ai of ["llm_failed", "stt_failed", "recording_unavailable", "no_text"] as const)
    assert.deepEqual(cat({ ...base, ai }), ["error", null], `🔴 «${ai}» не став «Помилкою»`);
  for (const ai of ["queued", "llm_pending", "capped", "not_enabled", "not_queued"] as const)
    assert.deepEqual(cat({ ...base, ai }), ["waiting", null], `🔴 «${ai}» — не «AI слухає»`);
});

/**
 * #1078 — БЕЗ РОЗМОВИ (Роман 30.09.2026: «розмови менш 10 секунд видаляємо, не аналізуй їх»; строк — 4 год після заміру):
 * угода без розмови від 10 с стає «без розмови» щойно минув строк (бойовий — `carrierNoTalkCloseMin`, 240 хв; гейт
 * ганяє механізм зі строком 0 і з типовою добою), закривається
 * «Немає зв'язку» (6343067) з приміткою й нічого не оплачує; угода, в номера якої є раніша угода, що ще слухається, —
 * чекає повтору вердикту, а не закривається; у звіті — окремим числом, поза «усього».
 * 🧨 Червоніє, якщо чекати добу, закрити сусіда за номером, поставити не ту причину чи домішати в «усього».
 */
test("#1078 БЕЗ РОЗМОВИ · ЖИВА СХЕМА: після строку (бойовий — 4 год) «Немає зв'язку», без оплати; сусід за номером чекає; у звіті окремо", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const { runCarrierClose } = await import("./carrierClose.js");
  const { carrierDealRows, carrierReport } = await import("./carrierDeals.js");
  const B = 107800;
  const silent = phone(B, 1), P = phone(B, 2);
  await carrierDeal(c, B + 1, silent, min(20));                  // дзвінок 5 с — розмови від 10 с немає
  await call(c, "1078-short", min(20), 5, silent);
  await call(c, "1078-talk", min(40), 40, P);                    // номер P: перша угода з розмовою
  await carrierDeal(c, B + 2, P, min(40));
  await carrierDeal(c, B + 3, P, min(20));                       // друга угода того ж номера — повторить вердикт
  await syncedAt(c);
  const r1 = await resolveCarrierDeals(c.db, NOW, 0);
  const st = async (id: number) => (await row(c, id)).state;
  assert.equal(await st(B + 1), "no_talk", "🔴 угода без розмови чекає добу замість закриття одразу");
  assert.equal(await st(B + 2), "own");
  assert.equal(await st(B + 3), "waiting", "🔴 сусіда за номером закрито «немає зв'язку», хоча розмова в номера є");
  assert.equal(r1.noTalk, 1);
  await resolveCarrierDeals(c.db, NOW, 0);
  assert.equal(await st(B + 3), "reused", "дзеркало: наступним проходом сусід повторює вердикт номера");
  assert.equal((await resolveCarrierDeals(c.db, NOW)).noTalk, 0, "дзеркало: за замовчуванням — доба (стара поведінка ядра)");
  const k = fakeKommo();
  const rep = await runCarrierClose(c.db, NOW, "live", new Set([B + 1]), k.kommo);
  assert.equal(rep.closed, 1);
  assert.deepEqual(k.calls.patch[0], [{ id: B + 1, pipeline_id: 8921928, status_id: 143,
    custom_fields_values: [{ field_id: 2097265, values: [{ enum_id: 6343067 }] }] }], "🔴 закрито не «Немає зв'язку»");
  assert.match(((k.calls.notes[0] as { params: { text: string } }[])[0]).params.text, /розмови від 10 с не було/);
  const t0 = (await c.raw.query("SELECT 1 FROM call_transcripts WHERE uniqueid = '1078-short'")).rowCount;
  assert.equal(t0, 0, "🔴 короткий дзвінок поставлено на розпізнавання");
  const rows = await carrierDealRows(c.db, { period: null, scope: {}, ids: [B + 1, B + 2] });
  const rp = carrierReport(rows);
  assert.deepEqual([rp.total.noTalk, rp.total.total, rp.total.unsorted], [1, 1, 1], "🔴 «без розмови» домішано в «усього» чи «не розібрано»");
  assert.match(SRC("jobs/carrierCallJob.ts"), /noTalkAfterMin: config\.callAi\.carrierNoTalkCloseMin/, "🔴 бойова джоба не бере строк «без розмови»");
  assert.match(SRC("config.ts"), /carrierNoTalkCloseMin: Number\(process\.env\.CARRIER_NO_TALK_CLOSE_MIN \?\? "240"\)/, "🔴 строк «без розмови» ≠ рішенню 30.09.2026 (4 год)");
});

/**
 * #1079 — ЕКРАН МЕНЕДЖЕРА (Роман 30.09.2026): менеджер не бачить службового рядка (витрати, режими) і точності AI,
 * у його таблиці немає колонки «Менеджер»; тімлід не бачить службового рядка; керівництво — усе. Звіт з одним
 * менеджером не повторює його рядок «разом». Роль іде в секцію з контейнера.
 * 🧨 Червоніє, якщо показати менеджеру службовий рядок чи не передати роль.
 */
test("#1079 ЕКРАН МЕНЕДЖЕРА: без службового рядка й колонки «Менеджер»; тімлід без службового; роль — з контейнера", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8");
  assert.match(sec, /const isManager = roleKey === "manager";/);
  assert.match(sec, /const isLead = roleKey !== "manager" && roleKey !== "team_lead";/, "🔴 керівництво визначено не як «не менеджер і не тімлід»");
  assert.match(sec, /\{meta && isLead && \(\s*<p/, "🔴 службовий рядок бачить не лише керівництво");
  assert.match(sec, /\{!isManager && <th style=\{cell\}><Hd t="Менеджер" /, "🔴 колонка «Менеджер» є в менеджера");
  assert.match(sec, /\{meta && isLead && meta\.agreementRows\.length > 0 && <AgreementCard/, "🔴 точність AI бачить не лише керівництво");
  assert.match(readFileSync(FE("pages/Dashboard.tsx"), "utf8"), /<CarrierCallsSection roleKey=\{auth\?\.roleKey \?\? null\} \/>/, "🔴 роль не передано в секцію");
  const card = readFileSync(FE("pages/dashboard/sections/CarrierReportCard.tsx"), "utf8");
  assert.match(card, /\{rep\.managers\.length > 1 && <tr/, "🔴 звіт з одним менеджером повторює його рядок «разом»");
});

/**
 * #1140 — ДИНАМІКА ЗА ПЕРІОД (Роман 30.09.2026: «графіки … скільки відсіяно, пропущено, скільки грошей»): кожен день
 * періоду є (порожній — нулем); сума стовпчиків за категоріями = числам звіту з тих самих рядків; «відсіяв фільтр» —
 * лише угоди, яких ми після фільтра не бачили; витрати — лише коли дозволено (керівництво), інакше `null`.
 * 🧨 Червоніє, якщо загубити порожній день, рахувати графік інакше, ніж звіт, чи віддати витрати менеджеру.
 */
test("#1140 ДИНАМІКА · ЖИВА СХЕМА: усі дні, графік = звіт, фільтр — без наших угод, витрати лише керівництву", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  await c.raw.query("DELETE FROM deals WHERE kommo_id BETWEEN 114000 AND 114099");
  await c.raw.query("TRUNCATE ai_spend_ledger");
  const { carrierDailyStats, carrierDealRows, carrierReport } = await import("./carrierDeals.js");
  const d1 = new Date("2026-08-10T08:00:00Z"), d3 = new Date("2026-08-12T08:00:00Z");
  const mk = async (n: number, at: Date, role: string | null, conf = 0.95, state = "own") => {
    const P = phone(11400, n), u = `1140-${String(n)}`;
    if (state === "own") await call(c, u, at, 40, P);
    await carrierDeal(c, 114000 + n, P, at, state, state === "own" ? u : null, state === "own" ? 1 : 0);
    if (role) await carrierAnalysedV2(c, u, role, conf, "counterpart", role === "other" ? "spam" : null);
  };
  await mk(1, d1, "client"); await mk(2, d1, "carrier"); await mk(3, d3, "other"); await mk(4, d3, "carrier", 0.5); await mk(5, d3, null, 0, "no_talk");
  await c.raw.query(`INSERT INTO deals(kommo_id,name,pipeline_id,status_id,reject_reason,created_at_kommo) VALUES
    (114090,'380500114090',8921928,143,'Перевізник','2026-08-10 10:00:00+03'),
    (114002,'380500114002',8921928,143,'Перевізник','2026-08-10 10:00:00+03')`);   // друга — наша, не фільтр
  await c.raw.query(`INSERT INTO ai_spend_ledger(at,provider,operation,units,unit,unit_price_usd) VALUES
    ('2026-08-10T09:00:00Z','elevenlabs','carrier_stt',10,'audio_sec',0.01), ('2026-08-10T09:00:00Z','elevenlabs','stt',10,'audio_sec',1)`);
  // Дати свідомо поза вереснем: база спільна для гейтів, а в інших фікстурах на 24–26.09 лежать «відсіяні фільтром».
  const days = await carrierDailyStats(c.db, "2026-08-10", "2026-08-12", {}, null, 8921928, true);
  assert.deepEqual(days.map((d) => d.day), ["2026-08-10", "2026-08-11", "2026-08-12"], "🔴 порожній день загубився з осі");
  assert.deepEqual(days.map((d) => [d.filtered, d.noTalk, d.clients, d.carriers, d.other, d.unsorted]),
    [[1, 0, 1, 1, 0, 0], [0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 1, 1]], "🔴 стовпчики ≠ категоріям угод по днях");
  const rep = carrierReport(await carrierDealRows(c.db, { period: { from: "2026-08-10", to: "2026-08-12" }, scope: {} }));
  const sum = (k: "clients" | "carriers" | "other" | "unsorted" | "noTalk") => days.reduce((s, d) => s + d[k], 0);
  assert.deepEqual([sum("clients"), sum("carriers"), sum("other"), sum("unsorted"), sum("noTalk")],
    [rep.total.clients, rep.total.carriersAuto + rep.total.carriersManual, rep.total.otherAuto + rep.total.otherManual, rep.total.unsorted, rep.total.noTalk],
    "🔴 графік рахує інакше, ніж звіт");
  assert.equal(days[0].spendUsd, 0.1, "🔴 витрати мобільних змішано з чужими або загублено");
  assert.ok((await carrierDailyStats(c.db, "2026-08-10", "2026-08-12", {}, null, 8921928, false)).every((d) => d.spendUsd === null),
    "🔴 витрати віддано тому, кому не можна");
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/carrier-calls/stats"');
  assert.ok(at > 0 && at < route.indexOf('dashboardRouter.get("/carrier-calls/:uniqueid"'), "🔴 /stats після /:uniqueid — піде як номер дзвінка");
  assert.match(route.slice(at, route.indexOf("dashboardRouter.", at + 10)), /carrierDailyStats\(pool, from, to, carrierScope\(req\), CARRIER_SINCE\(\), CARRIER_STAGE\.pipelineId, carrierIsLeadership\(req\.auth!\)\)/,
    "🔴 графік без скоупу ролі, точки старту чи межі витрат");
  const row = ACCESS_MATRIX.find((r) => r.method === "GET" && r.path === "/api/dashboard/carrier-calls/stats");
  assert.ok(row && row.deny.includes("hr" as never) && row.deny.includes("financier" as never), "🔴 /stats не в матриці або відкритий HR/фінансисту");
});

/**
 * #1141 — «AI ПРОТИ ЛЮДИНИ» ПОІМЕННО: рядок — ОСТАННЄ рішення по угоді, де AI мав вердикт (хто, роль, коли, чий менеджер,
 * збіг); угоди без вердикту AI не йдуть; список — лише керівництву (менеджер і тімлід отримують порожній).
 * 🧨 Червоніє, якщо брати не останнє рішення, домішати угоди без вердикту чи віддати список менеджеру.
 */
test("#1141 AI ПРОТИ ЛЮДИНИ ПОІМЕННО · ЖИВА СХЕМА: останнє рішення, хто й чия угода; лише керівництву", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  await seedTeams(c);
  const { carrierAgreementRows } = await import("./carrierDeals.js");
  await carrierDeal(c, 114101, phone(11410, 1), min(100)); await owner(c, 114101, 10601);
  await c.raw.query(`INSERT INTO carrier_decisions(kommo_id,decision,decided_by,decider_role,ai_role,ai_confidence,decided_at) VALUES
    (114101,'client',1,'manager','carrier',0.6,$1), (114101,'carrier',1,'team_lead','carrier',0.6,$2),
    (114102,'other',1,'kvp','client',0.7,$1),
    (114103,'client',1,'manager',NULL,NULL,$1)`, [min(50).toISOString(), min(40).toISOString()]);
  const rows = await carrierAgreementRows(c.db);
  assert.deepEqual(rows.map((r) => [r.kommoId, r.decision, r.byRole, r.agreed]), [[114101, "carrier", "team_lead", true], [114102, "other", "kvp", false]],
    "🔴 не останнє рішення, не той порядок або домішано угоду без вердикту AI");
  assert.equal(rows[0].managerName, "Менеджер 1", "🔴 не видно, чия це угода");
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/carrier-calls/meta"');
  assert.match(route.slice(at, route.indexOf("dashboardRouter.", at + 10)), /agreementRows: lead \? \(await carrierAgreementRows\(pool\)\)/, "🔴 поіменний список віддається не лише керівництву");
  assert.match(route, /const carrierIsLeadership = \(auth: AuthPayload\) => auth\.roleKey !== "manager" && auth\.roleKey !== "team_lead";/);
});

/**
 * #1142 — АНАЛІТИКА — ОКРЕМА СТОРІНКА (Роман 30.09.2026: «мав залишитися інтерфейс як і до цього … а графіки і
 * аналітика на іншій вкладці цієї сторінки»): «Угоди» — угоди за період по категоріях, без графіків; графіки й
 * «AI проти людини» — лише на «Аналітиці». Перемикач — у шапці, період спільний.
 * 🧨 Червоніє, якщо графік чи «AI проти людини» повернуться на сторінку угод або зникне перемикач.
 */
test("#1142 АНАЛІТИКА — ОКРЕМА СТОРІНКА: «Угоди» без графіків, графіки й «AI проти людини» — лише на «Аналітиці»", () => {
  const sec = readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8");
  assert.match(sec, /\[\["deals", "Угоди"\], \["analytics", "Аналітика"\]\]/, "🔴 перемикача «Угоди / Аналітика» немає");
  const a = sec.indexOf('if (page === "analytics") return (');
  assert.ok(a > 0, "🔴 сторінки «Аналітика» немає");
  const analytics = sec.slice(a, sec.indexOf("\n  );\n", a));
  assert.match(analytics, /<CarrierStatsCard from=\{from\} to=\{to\}/, "🔴 графіків немає на «Аналітиці»");
  assert.match(analytics, /<AgreementCard meta=\{meta\}/, "🔴 «AI проти людини» немає на «Аналітиці»");
  const rest = sec.slice(0, a) + sec.slice(a + analytics.length);
  const body = rest.slice(rest.indexOf("export function CarrierCallsSection"));
  assert.doesNotMatch(body, /<CarrierStatsCard /, "🔴 графік повернувся на сторінку угод");
  assert.doesNotMatch(body, /<AgreementCard /, "🔴 «AI проти людини» повернулось на сторінку угод");
});

/**
 * #1143 — УГОДА З «AI ПРОТИ ЛЮДИНИ» ВІДКРИВАЄТЬСЯ ПОВНІСТЮ (Роман 30.09.2026: «щоб можна було повністю відкрити
 * транскрипт»): клік по рядку — повна картка угоди (запис, текст, вердикт, журнал, кнопки) через `/carrier-calls/deal/:id`;
 * роут — у скоупі ролі й з точкою старту (чужа угода — 404), до `/:uniqueid`, у матриці; відповідь — тим самим переліком
 * полів, що й список.
 * 🧨 Червоніє, якщо зняти скоуп з роуту, віддати іншим переліком полів чи рядок перестане відкривати картку.
 */
test("#1143 УГОДА З «AI ПРОТИ ЛЮДИНИ»: повна картка, роут у скоупі ролі, до /:uniqueid, у матриці, той самий перелік полів", async () => {
  const route = SRC("routes/dashboard.ts");
  const at = route.indexOf('dashboardRouter.get("/carrier-calls/deal/:kommoId"');
  assert.ok(at > 0 && at < route.indexOf('dashboardRouter.get("/carrier-calls/:uniqueid"'), "🔴 роуту однієї угоди немає або він після /:uniqueid");
  const body = route.slice(at, route.indexOf("dashboardRouter.", at + 10));
  assert.match(body, /carrierDealRows\(pool, \{ period: null, scope: carrierScope\(req\), ids: \[id\], since: CARRIER_SINCE\(\) \}\)/, "🔴 угода за номером без скоупу ролі чи точки старту");
  assert.match(body, /res\.status\(404\)/, "🔴 чужа угода не 404");
  assert.match(body, /res\.json\(carrierDealJson\(r\)\)/, "🔴 одна угода віддається іншим переліком полів, ніж список");
  assert.match(route, /rows: rows\.map\(carrierDealJson\)/, "🔴 список і одна угода розійшлись у переліку полів");
  const row = ACCESS_MATRIX.find((r) => r.method === "GET" && r.path === "/api/dashboard/carrier-calls/deal/:kommoId");
  assert.ok(row && row.deny.includes("hr" as never) && row.deny.includes("financier" as never), "🔴 роут однієї угоди не в матриці або відкритий HR/фінансисту");
  const sec = readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8");
  assert.match(sec, /<CarrierDealById kommoId=\{r\.kommoId\}/, "🔴 рядок «AI проти людини» не відкриває картку угоди");
  const panel = readFileSync(FE("pages/dashboard/sections/CarrierDealPanel.tsx"), "utf8");
  // Межа — тіло самої функції (правило 9: змістова, а не за довжиною).
  const byId = panel.slice(panel.indexOf("export function CarrierDealById"), panel.indexOf("export function CarrierDealPanel"));
  assert.ok(byId.length > 0, "🔴 CarrierDealById не знайдено");
  assert.match(byId, /fetchCarrierDeal\(kommoId\)/, "🔴 картка за номером вантажить не угоду за номером");
  assert.match(byId, /<CarrierDealPanel deal=\{deal\}/, "🔴 картка за номером — не та сама повна картка угоди");
});

/**
 * #1144 — «ЩО З УГОДОЮ В CRM» ОДНИМ РЯДКОМ (Роман 30.09.2026: «скажи які угоди пішли в crm, які видалені, щоб розуміти»):
 * клієнт — лишилась; закрита дашбордом — прибрана з причиною; вирішено, але ще не закрито — буде прибрана; невирішена —
 * чекає рішення; повернута — повернута; закрита не нами (фільтр/людина в Kommo) — закрита в CRM; переведена далі — пішла
 * далі. Факт у CRM сильніший за наш намір.
 * 🧨 Червоніє, якщо переплутати причину, показати «лишилась» для прибраної чи намір замість факту.
 */
test("#1144 ЩО З УГОДОЮ В CRM: лишилась / прибрана з причиною / буде прибрана / чекає / повернута; факт CRM сильніший", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE("pages/dashboard/carrierCallsView.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const V = await import(`data:text/javascript,${encodeURIComponent(js)}`) as { crmOutcome: (r: unknown) => { icon: string; label: string } };
  const o = (category: string, close: unknown, statusId: number | null = 70419108, rejectReason: string | null = null) =>
    V.crmOutcome({ category, close, crm: { statusId, rejectReason } }).label;
  const closed = (reason: string) => ({ state: "closed", at: "2026-09-30T12:00:00Z", reason });
  assert.equal(o("client", null), "лишилась у CRM");
  assert.equal(o("carrier", closed("carrier"), 143, "Перевізник"), "прибрана: «Перевізник»");
  assert.equal(o("other", closed("other"), 143), "прибрана: «Нецільове звернення»", "🔴 причину «Інше» переплутано");
  assert.equal(o("no_talk", closed("no_talk"), 143), "прибрана: «Немає зв'язку»");
  assert.equal(o("carrier", null), "буде прибрана: «Перевізник»", "🔴 вирішену, але ще не закриту угоду показано як прибрану або як таку, що лишилась");
  assert.equal(o("review", null), "чекає рішення");
  assert.equal(o("carrier", { state: "reverted", at: "x", reason: "carrier" }), "повернута на етап");
  assert.equal(o("client", null, 143, "Дубль"), "закрита в CRM: «Дубль»", "🔴 факт CRM (закрита) переважила наш намір «лишилась»");
  assert.equal(o("client", null, 142), "успішна угода");
  assert.equal(o("review", null, 69693668), "пішла далі по воронці");
  const card = readFileSync(FE("pages/dashboard/sections/CarrierStatsCard.tsx"), "utf8");
  assert.match(card, /title: "Лишились у CRM", n: totals\.clients/, "🔴 «лишились у CRM» рахує не клієнтів");
  assert.match(card, /title: "Прибрано з CRM", n: totals\.filtered \+ totals\.carriers \+ totals\.other \+ totals\.noTalk/, "🔴 «прибрано з CRM» рахує не всі закриття");
  assert.match(readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8"), /const o = crmOutcome\(r\)/, "🔴 рядок угоди не показує, що з нею в CRM");
});

/**
 * #1145 — ЗАХИСТ «БЕЗ РОЗМОВИ» ВІД ПАДІННЯ RINGOSTAT, ПЕРЕВІРКА ① (рішення 05.10.2026): синк дзвінків старший за поріг
 * (30 хв) або невідомий — крок «без розмови» не виконується, угода ЧЕКАЄ; синк оновився — закривається тим самим проходом,
 * що й завжди. Бойова джоба бере поріг із налаштувань.
 * 🧨 Червоніє, якщо прибрати перевірку свіжості в кроці ③ (`!guard.gate.open`), рахувати «немає рядка» свіжим чи загубити поріг у джобі.
 */
test("#1145 СИНК ДЗВІНКІВ СТАРИЙ · ЖИВА СХЕМА: «без розмови» на паузі, угода чекає; синк свіжий — закривається", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const B = 114500, P = phone(B, 1);
  await carrierDeal(c, B + 1, P, min(300));
  await call(c, "1145-short", min(300), 4, P);                   // дзвінок-творець є, розмови від 10 с немає
  await syncedAt(c, min(31));
  const r1 = await resolveCarrierDeals(c.db, NOW, 0, 30);
  assert.equal((await row(c, B + 1)).state, "waiting", "🔴 синк дзвінків 31 хв тому, а угоду закрито «без розмови»");
  assert.deepEqual([r1.noTalk, r1.noTalkGate.open, r1.noTalkGate.syncAgeMin], [0, false, 31]);
  await syncedAt(c, null);
  const r2 = await resolveCarrierDeals(c.db, NOW, 0, 30);
  assert.equal((await row(c, B + 1)).state, "waiting", "🔴 вік синку невідомий (рядка немає), а «без розмови» поставлено — «не знаю» прочитано як «добре»");
  assert.deepEqual([r2.noTalkGate.open, r2.noTalkGate.syncAgeMin], [false, null]);
  await syncedAt(c, min(30));
  const r3 = await resolveCarrierDeals(c.db, NOW, 0, 30);
  assert.equal((await row(c, B + 1)).state, "no_talk", "дзеркало: синк рівно 30 хв тому — свіжий, угода закривається як завжди");
  assert.deepEqual([r3.noTalk, r3.noTalkGate.open], [1, true]);
  assert.match(SRC("jobs/carrierCallJob.ts"), /noTalkSyncMaxMin: minutesSetting\(config\.callAi\.carrierNoTalkSyncMaxMin, NO_TALK_GUARD\.defaultMaxAgeMin\)/,
    "🔴 бойова джоба не бере поріг свіжості синку з налаштувань");
});

/**
 * #1146 — ЗАХИСТ «БЕЗ РОЗМОВИ», ПЕРЕВІРКА ② (рішення 05.10.2026): Ringostat створює угоду на кожен дзвінок, тож дзвінок, що
 * її створив, мусить бути в базі. Немає — телефонію цієї угоди не видно (синк «успішний», а Ringostat віддав порожньо), і
 * угода чекає навіть при свіжому синку. Вікно −10…+10 хв від створення, з обох боків межі.
 * 🧨 Червоніє, якщо прибрати умову дзвінка-творця з кроку ③ або розширити/звузити вікно.
 */
test("#1146 НЕМАЄ ДЗВІНКА, ЩО СТВОРИВ УГОДУ · ЖИВА СХЕМА: свіжий синк, але дзвінка в базі немає — не закриваємо", async (t) => {
  const c = await ctx(t); if (!c) return;
  await resetAll(c);
  const { resolveCarrierDeals } = await import("./carrierCalls.js");
  const B = 114600, created = min(300), at = (m: number) => new Date(created.getTime() + m * 60_000);
  const [pNone, pIn, pEarly, pLate, pEdge] = [1, 2, 3, 4, 5].map((n) => phone(B, n));
  await carrierDeal(c, B + 1, pNone, created);                   // жодного дзвінка номера
  await carrierDeal(c, B + 2, pIn, created); await call(c, "1146-in", at(1), 0, pIn);          // недодзвон через хвилину
  await carrierDeal(c, B + 3, pEarly, created); await call(c, "1146-early", at(-11), 5, pEarly); // за 11 хв до — поза вікном
  await carrierDeal(c, B + 4, pLate, created); await call(c, "1146-late", at(11), 5, pLate);     // через 11 хв — поза вікном
  await carrierDeal(c, B + 5, pEdge, created); await call(c, "1146-edge", at(-10), 5, pEdge);    // рівно за 10 хв — у вікні
  await syncedAt(c);
  const r = await resolveCarrierDeals(c.db, NOW, 0, 30);
  const st = async (id: number) => (await row(c, id)).state;
  assert.equal(await st(B + 1), "waiting", "🔴 дзвінка, що створив угоду, у базі немає, а її закрито «без розмови»");
  assert.equal(await st(B + 2), "no_talk", "дзеркало: дзвінок-творець є (недодзвон), розмови немає — закривається");
  assert.deepEqual([await st(B + 3), await st(B + 4)], ["waiting", "waiting"], "🔴 вікно дзвінка-творця ширше за ±10 хв");
  assert.equal(await st(B + 5), "no_talk", "🔴 вікно дзвінка-творця вужче за 10 хв");
  assert.deepEqual([r.noTalk, r.noTalkNoCreatingCall], [2, 3], "🔴 звіт кроку не каже, скільки угод тримає відсутній дзвінок-творець");
});

/**
 * #1147 — ПОРОГИ ЗАХИСТУ — З НАЛАШТУВАНЬ (рішення 05.10.2026: «поріг винеси в налаштування»): пауза — 30 хв, тривога — 60 хв
 * за замовчуванням, змінюються змінними оточення; сміття в налаштуванні — типове значення, а не NaN (з NaN пауза й тривога
 * мовчали б назавжди). Межа паузи — включно: 30 хв ще свіжий, 31 — ні. Без бази.
 * 🧨 Червоніє, якщо зашити число в код, змінити типові пороги чи пропустити NaN.
 */
test("#1147 ПОРОГИ З НАЛАШТУВАНЬ: пауза 30 хв, тривога 60 хв, сміття — типове; межа включно", async () => {
  const G = await import("./carrierNoTalkGuard.js");
  const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
  assert.equal(G.noTalkGate(at(30), NOW, 30).open, true, "🔴 рівно 30 хв — уже пауза");
  assert.equal(G.noTalkGate(at(31), NOW, 30).open, false, "🔴 31 хв — ще закриваємо");
  assert.equal(G.noTalkGate(at(31), NOW, 45).open, true, "🔴 поріг не береться з параметра");
  assert.deepEqual(G.noTalkGate(null, NOW, 30), { open: false, syncAgeMin: null, maxAgeMin: 30, lastSyncAt: null });
  assert.deepEqual([G.minutesSetting(Number("abc"), 30), G.minutesSetting(0, 30), G.minutesSetting(-5, 30), G.minutesSetting(45, 30)], [30, 30, 30, 45],
    "🔴 сміття в налаштуванні пройшло як поріг");
  assert.deepEqual([G.NO_TALK_GUARD.defaultMaxAgeMin, G.NO_TALK_GUARD.defaultAlertMin], [30, 60], "🔴 типові пороги ≠ рішенню 05.10.2026");
  const cfg = SRC("config.ts");
  assert.match(cfg, /carrierNoTalkSyncMaxMin: Number\(process\.env\.CARRIER_NO_TALK_SYNC_MAX_MIN \?\? "30"\)/, "🔴 поріг паузи не в налаштуваннях");
  assert.match(cfg, /carrierNoTalkSyncAlertMin: Number\(process\.env\.CARRIER_NO_TALK_SYNC_ALERT_MIN \?\? "60"\)/, "🔴 поріг тривоги не в налаштуваннях");
});

/**
 * #1148 — ТРИВОГА: СИНКУ НЕМАЄ ДОВШЕ ГОДИНИ (рішення 05.10.2026): понад поріг тривоги (60 хв) або невідомо — тривога; рівно
 * 60 — ще ні. Перевірка ЗАРЕЄСТРОВАНА в сигналізації (а не лише написана) і бере поріг із налаштувань — тоді поштар
 * (`alertPush`) донесе її в Telegram і скаже «відновилось», коли синк оживе.
 * 🧨 Червоніє, якщо зсунути межу, мовчати на невідомому, не зареєструвати перевірку чи зашити поріг.
 */
test("#1148 ТРИВОГА: понад 60 хв чи невідомо — тривога; перевірка в сигналізації, поріг із налаштувань", async () => {
  const G = await import("./carrierNoTalkGuard.js");
  const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
  assert.equal(G.noTalkAlertDue(G.noTalkGate(at(61), NOW, 30), 60), true, "🔴 синку немає 61 хв — тривоги немає");
  assert.equal(G.noTalkAlertDue(G.noTalkGate(at(60), NOW, 30), 60), false, "🔴 рівно 60 хв — уже тривога");
  assert.equal(G.noTalkAlertDue(G.noTalkGate(at(45), NOW, 30), 60), false, "дзеркало: пауза без тривоги між 30 і 60 хв");
  assert.equal(G.noTalkAlertDue(G.noTalkGate(null, NOW, 30), 60), true, "🔴 вік синку невідомий — тривога мовчить");
  const alerts = SRC("health/alerts.ts");
  assert.match(alerts, /\{\s*id:\s*"carrier_no_talk",[^}]*run:\s*checkCarrierNoTalk\s*\}/, "🔴 перевірку не додано в CHECKS — тривога написана, але не викликається");
  assert.match(alerts, /minutesSetting\(config\.callAi\.carrierNoTalkSyncAlertMin, NO_TALK_GUARD\.defaultAlertMin\)/, "🔴 поріг тривоги не з налаштувань");
  assert.match(alerts, /noTalkAlertDue\(g\.gate, alertMin\)/, "🔴 тривога не через спільну функцію рішення");
});

/**
 * #1149 — СЛУЖБОВИЙ РЯДОК (рішення 05.10.2026): `/carrier-calls/meta` віддає стан захисту лише керівництву (тим самим
 * читанням, що й джоба), явним переліком полів; екран каже паузу СЛОВАМИ й червоним, а не мовчить.
 * 🧨 Червоніє, якщо віддати стан не керівництву, читати його інакше, ніж джоба, чи прибрати паузу з рядка.
 */
test("#1149 СЛУЖБОВИЙ РЯДОК: стан захисту лише керівництву, тим самим читанням; пауза — словами й червоним", async () => {
  const r = SRC("routes/dashboard.ts");
  const i = r.indexOf('dashboardRouter.get("/carrier-calls/meta"'); assert.ok(i > 0, "роут /carrier-calls/meta не знайдено");
  const body = r.slice(i, r.indexOf("dashboardRouter.", i + 10));
  assert.match(body, /const g = lead \? await readNoTalkGuard\(pool, new Date\(\), config\.callAi\.carrierNoTalkCloseMin,/, "🔴 стан захисту не лише керівництву або не тим читанням");
  assert.match(body, /noTalkGuard: g \? \{ open: g\.gate\.open, syncAgeMin: g\.gate\.syncAgeMin, maxAgeMin: g\.gate\.maxAgeMin, lastSyncAt: g\.gate\.lastSyncAt,\s*noCreatingCall: g\.noCreatingCall \} : null/,
    "🔴 стан захисту віддається не явним переліком полів");
  const sec = readFileSync(FE("pages/dashboard/sections/CarrierCallsSection.tsx"), "utf8");
  assert.match(sec, /\{meta\.noTalkGuard && <NoTalkGuardNote g=\{meta\.noTalkGuard\} \/>\}/, "🔴 стан захисту не виведено в службовий рядок");
  assert.match(sec, /color: "var\(--danger\)" \}[^>]*>\s*на паузі — синк дзвінків \{age\}, угоди чекають/, "🔴 пауза не сказана словами й червоним");
});
