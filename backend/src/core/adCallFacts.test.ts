import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyClientKey, phoneStateSql, dealCallState, promiseOutcome, silentBeforeClose, assertFactsParams,
  ParamNotSetError, KOMMO_LOST_STATUS, type AdDealCallFacts, type AdCallFactsParams,
} from "./adCallFactsRules.js";
import { classifyJobError } from "../health/jobErrorKind.js";

/**
 * 🎯 #756–#758b — ФАКТИ З ДЗВІНКІВ ПО РЕКЛАМНІЙ УГОДІ (ТЗ AI-аналізу, прохід A, коміт ①).
 * Кожне правило — з ОБОХ боків межі, бо фікстура з одного значення властивості не перевіряє
 * (правило 11 кореневого CLAUDE.md).
 */

// Предикат «як у Звіті» для гейта — навмисно ПРОСТИЙ і такий, що дає NULL на NULL-джерелі:
// гейт перевіряє нашу КОМПОЗИЦІЮ (обидва прапорці, COALESCE, обʼєднання), а не сам `adDealSql`,
// який стережуть власні гейти (`#33` та ін.). Справжній передає джоба/пілот.
const FAKE_AD_DEAL = (ref: string): string =>
  `(d.client_source = ANY(${ref}) AND COALESCE(d.client_source,'') NOT ILIKE '%реактив%')`;

/**
 * #756 — ЖИВА СХЕМА (scratch): вибірка лише реклами за ДВОМА предикатами з незалежними
 * прапорцями; межа київської доби створення; вікно угоди «до створення» з обох боків секунди;
 * поріг розмови 19 проти 20 с; склейка дубля CDR; дзвінок у двох угодах того самого клієнта
 * зараховано обом; чотири стани угоди, сума == відібраним; парність класифікації номера JS↔SQL.
 * Кластер свій (`pg.Client`, не `db/pool.js`); на проді бінарів PostgreSQL немає → чесний skip.
 */
test("#756 ФАКТИ ДЗВІНКІВ · ЖИВА СХЕМА: лише реклама, два прапорці, вікно, поріг, склейка, стани", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { adCallFacts } = await import("./adCallFacts.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    // 🔴 Сесія в UTC: у київській сесії помилка «дата створення без AT TIME ZONE» лишалась би зеленою
    // (урок динаміки пропущених, 17.09.2026). Угода 111 створена о 00:30 за Києвом = 15.09 за UTC.
    await c.query("SET TIME ZONE 'UTC'");
    await c.query("INSERT INTO teams(id,name) VALUES (1,'РНК') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'А',1,true),(2,'Б',1,true) ON CONFLICT DO NOTHING");
    const deal = (id: number, ch: string | null, src: string | null, key: string | null, created: string,
      closed: string | null = null, status = 1) =>
      c.query(`INSERT INTO deals(kommo_id,name,manager_id,pipeline_id,status_id,created_at_kommo,closed_at_kommo,client_key,lead_channel,client_source)
               VALUES ($1,$2,1,8921932,$3,$4,$5,$6,$7,$8)`, [id, `D${String(id)}`, status, created, closed, key, ch, src]);
    let seq = 0;
    const call = (at: string, type: string, sec: number, mgr: number, phone: string, ck: string | null = null) =>
      c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone,client_key)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [`u${String(++seq)}`, at, type, sec > 0 ? "ANSWERED" : "NO ANSWER", sec, mgr, phone, ck]);

    await deal(101, "ad", null, "0671111111", "2026-09-10 12:00:00+03");                 // реклама, джерело NULL
    await deal(102, "other", "organic", "0671111111", "2026-09-10 13:00:00+03");         // НЕ реклама, той самий номер
    await deal(103, null, "uts.ua", "0672222222", "2026-09-11 09:00:00+03", "2026-09-14 09:00:00+03", KOMMO_LOST_STATUS);
    await deal(104, "ad", "Реактивація закриті", "товагро", "2026-09-12 08:00:00+03");  // не номер, але є client_key у дзвінку
    await deal(105, "ad", null, "12345678", "2026-09-12 09:00:00+03");                   // ЄДРПОУ
    await deal(106, "ad", null, null, "2026-09-12 09:30:00+03");                         // клієнта немає
    await deal(107, "ad", null, "0673333333", "2026-09-12 10:00:00+03");                 // номер є, дзвінків немає
    await deal(108, "ad", null, "0671111111", "2026-09-12 10:00:00+03");                 // друга угода того самого клієнта
    await deal(110, "ad", null, "0674444444", "2026-09-15 23:30:00+03");                 // київська доба 15.09 — у періоді
    await deal(111, "ad", null, "0674444444", "2026-09-16 00:30:00+03");                 // UTC ще 15.09, Київ уже 16.09 — поза
    await deal(112, "ad", null, "0675555555", "2026-09-13 10:00:00+03");                 // лише спроба

    const P1 = "380671111111";
    await call("2026-09-09 11:59:59+03", "in", 60, 1, P1);        // за 1 с ДО вікна 101 — поза
    await call("2026-09-09 12:00:01+03", "in", 19, 1, P1);        // у вікні 101, але 19 с — не розмова
    await call("2026-09-10 12:30:00+03", "out", 20, 1, P1);       // рівно поріг — розмова
    await call("2026-09-10 12:30:40+03", "out", 45, 1, P1);       // дубль того самого дзвінка (той самий менеджер, 40 с) — склеїти
    await call("2026-09-12 11:00:00+03", "out", 90, 2, P1);       // у вікнах 101 і 108 — обом
    await call("2026-09-12 12:00:00+03", "out", 0, 1, P1);        // спроба після останньої розмови
    await call("2026-09-21 10:00:00+03", "out", 30, 1, P1);       // після «зараз» — поза
    await call("2026-09-11 09:05:00+03", "in", 120, 1, "380672222222");
    await call("2026-09-14 10:00:00+03", "out", 30, 1, "380672222222");   // після закриття 103 — поза
    await call("2026-09-12 08:10:00+03", "in", 40, 2, "380509999999", "товагро");  // лише через client_key
    await call("2026-09-13 10:05:00+03", "out", 0, 1, "380675555555");    // тільки спроба

    const p: AdCallFactsParams = {
      from: "2026-09-10", to: "2026-09-15", now: new Date("2026-09-20T12:00:00+03:00"),
      talkMinSec: 20, windowBefore: "1 days", adDealPredicate: FAKE_AD_DEAL, adSources: ["uts.ua"],
    };
    const facts = await adCallFacts(c, p);
    const by = new Map(facts.map((f) => [f.kommoId, f]));
    const ids = [...by.keys()].sort((a, b) => a - b);

    assert.deepEqual(ids, [101, 103, 104, 105, 106, 107, 108, 110, 112],
      `🔴 вибірка не та: ${ids.join(",")} (102 — не реклама, 111 — київська доба 16.09)`);
    const f = (id: number): AdDealCallFacts => by.get(id)!;

    // Два прапорці незалежні, NULL-джерело дає false, а не NULL.
    assert.deepEqual([f(101).isLeadChannelAd, f(101).isAdDealSql], [true, false], "🔴 101: джерело NULL мусить дати false");
    assert.deepEqual([f(103).isLeadChannelAd, f(103).isAdDealSql], [false, true], "🔴 103: лише «як у Звіті»");
    assert.deepEqual([f(104).isLeadChannelAd, f(104).isAdDealSql], [true, false], "🔴 104: реактивація відсікається лише другим предикатом");

    // 101: вікно, поріг, склейка, спроба після розмови.
    assert.equal(f(101).calls, 4, `🔴 101: дзвінків ${String(f(101).calls)}, а треба 4 (межа вікна, дубль склеєно, «після зараз» поза)`);
    assert.equal(f(101).talks, 2, `🔴 101: розмов ${String(f(101).talks)}, а треба 2 (19 с — ні, 20 с — так)`);
    assert.equal(f(101).firstCallDir, "in", "🔴 101: перший дзвінок — вхідний за 1 с після межі вікна");
    assert.equal(f(101).firstOutAfterCreatedAt?.toISOString(), new Date("2026-09-10T12:30:00+03:00").toISOString());
    assert.equal(f(101).lastTalkAt?.toISOString(), new Date("2026-09-12T11:00:00+03:00").toISOString());
    assert.equal(f(101).outAfterLastTalk, 1, "🔴 101: спроба після останньої розмови не порахована");
    assert.equal(f(101).state, "talked");

    // 108: той самий дзвінок, що й у 101, зараховано й другій угоді.
    assert.equal(f(108).calls, 2, `🔴 108: дзвінок, спільний із 101, загубився (${String(f(108).calls)})`);
    assert.equal(f(108).talks, 1);

    // 103: закрита — дзвінок після закриття поза вікном; розрив до закриття.
    assert.equal(f(103).calls, 1, "🔴 103: дзвінок після закриття потрапив у факти");
    assert.equal(f(103).closeGapMin, 71 * 60 + 55, `🔴 103: розрив до закриття ${String(f(103).closeGapMin)} хв`);

    // Стани й причини номера.
    assert.equal(f(104).phoneState, "not_phone"); assert.equal(f(104).state, "talked", "🔴 104: звʼязка через client_key не спрацювала");
    assert.equal(f(105).phoneState, "not_ua_phone"); assert.equal(f(105).state, "no_phone");
    assert.equal(f(106).phoneState, "no_key"); assert.equal(f(106).state, "no_phone");
    assert.equal(f(107).state, "no_calls"); assert.equal(f(110).state, "no_calls");
    assert.equal(f(112).state, "no_talks", "🔴 112: спроба без розмови — це «розмов немає», а не «дзвінків немає»");
    const sum = { no_phone: 0, no_calls: 0, no_talks: 0, talked: 0 };
    for (const x of facts) sum[x.state]++;
    assert.equal(sum.no_phone + sum.no_calls + sum.no_talks + sum.talked, facts.length, "🔴 сума станів ≠ кількість угод");
    assert.deepEqual(sum, { no_phone: 2, no_calls: 2, no_talks: 1, talked: 4 });

    // Парність класифікації номера: той самий вираз у SQL, що й у JS.
    for (const k of [null, "", "  ", "0671234567", "671234567", "00671234567", "12345678", "380671234567", "товагро", "0a71234567"]) {
      const sql = (await c.query<{ s: string }>(`SELECT ${phoneStateSql("$1::text")} AS s`, [k])).rows[0].s;
      assert.equal(sql, classifyClientKey(k), `🔴 JS і SQL класифікують «${String(k)}» по-різному`);
    }
  } finally {
    await c.end().catch(() => {});
    scratch.dispose();
  }
});

/**
 * #757 — ОБІЦЯНКУ ВИКОНАНО ЧИ НІ ВИРІШУЮТЬ ДЗВІНКИ. Функція за побудовою не приймає нічого з
 * тексту аналізу; тут — межі строку (рівно в строк — зараховано, секунда після — ні), спроба
 * без розмови ≠ розмова, вхідний клієнта не зараховується, строк у майбутньому — «очікує».
 */
test("#757 ОБІЦЯНКА: виконання рахується з дзвінків — межі строку, спроба ≠ розмова, вхідний не рахується", () => {
  const madeAt = new Date("2026-09-12T10:16:00+03:00");
  const deadline = new Date("2026-09-12T18:00:00+03:00");
  const at = (s: string) => new Date(s);
  const now = at("2026-09-13T09:00:00+03:00");
  const pr = { madeAt, deadline };
  assert.equal(promiseOutcome(pr, [], now), "broken", "🔴 строк минув, дзвінків немає — це «не передзвонив»");
  assert.equal(promiseOutcome(pr, [{ at: deadline, billsec: 30, callType: "out" }], now), "kept_talk", "🔴 дзвінок рівно в строк — виконано");
  assert.equal(promiseOutcome(pr, [{ at: at("2026-09-12T18:00:01+03:00"), billsec: 30, callType: "out" }], now), "broken",
    "🔴 дзвінок після строку не робить обіцянку виконаною");
  assert.equal(promiseOutcome(pr, [{ at: madeAt, billsec: 30, callType: "out" }], now), "broken",
    "🔴 дзвінок у ту саму мить, коли пообіцяли (та сама розмова), — не виконання");
  assert.equal(promiseOutcome(pr, [{ at: at("2026-09-12T12:00:00+03:00"), billsec: 0, callType: "out" }], now), "kept_attempt_only",
    "🔴 спроба без розмови — окремий стан, а не «передзвонив»");
  assert.equal(promiseOutcome(pr, [{ at: at("2026-09-12T12:00:00+03:00"), billsec: 90, callType: "in" }], now), "broken",
    "🔴 клієнт подзвонив сам — це не наш передзвін");
  assert.equal(promiseOutcome(pr, [{ at: at("2026-09-12T12:00:00+03:00"), billsec: 40, callType: "transitout" }], now), "kept_talk",
    "🔴 друге плече вихідного — теж вихідний");
  assert.equal(promiseOutcome(pr, [], at("2026-09-12T17:59:59+03:00")), "pending", "🔴 до строку — «очікує», а не «не передзвонив»");
  assert.equal(promiseOutcome({ madeAt, deadline: null }, [], now), "no_deadline", "🔴 без строку не судимо");
  assert.equal(promiseOutcome.length, 3, "🔴 у функції зʼявився четвертий аргумент — текст аналізу не має сюди доходити");
});

const baseFacts = (o: Partial<AdDealCallFacts>): AdDealCallFacts => ({
  kommoId: 1, managerId: 1, pipelineId: 8921932, statusId: KOMMO_LOST_STATUS, createdAt: new Date(), closedAt: new Date(),
  isLeadChannelAd: true, isAdDealSql: true, phoneState: "ok", state: "talked", calls: 2, talks: 1,
  firstCallAt: null, firstCallDir: null, firstOutAfterCreatedAt: null, lastTalkAt: new Date(), lastTalkDir: "out",
  outAfterLastTalk: 0, closeGapMin: 24 * 60, ...o,
});

/**
 * #757b — «ТИША ПЕРЕД ЗАКРИТТЯМ»: рівно поріг — так, на хвилину менше — ні; будь-яка наша
 * спроба після розмови гасить; виграна угода чи угода без розмов — «не застосовно» (null),
 * а не «тиші немає»; поріг не заданий — помилка, а не мовчазне значення.
 */
test("#757b ТИША ПЕРЕД ЗАКРИТТЯМ: межа порогу, лише програні, спроба гасить, поріг без значення за замовчуванням", () => {
  assert.equal(silentBeforeClose(baseFacts({ closeGapMin: 24 * 60 }), 24), true, "🔴 рівно поріг — це тиша");
  assert.equal(silentBeforeClose(baseFacts({ closeGapMin: 24 * 60 - 1 }), 24), false, "🔴 на хвилину менше порогу — не тиша");
  assert.equal(silentBeforeClose(baseFacts({ outAfterLastTalk: 1 }), 24), false, "🔴 спроба після розмови гасить тишу");
  assert.equal(silentBeforeClose(baseFacts({ statusId: 142 }), 24), null, "🔴 виграна угода — не застосовно");
  assert.equal(silentBeforeClose(baseFacts({ closeGapMin: null }), 24), null, "🔴 без розмов чи відкрита — не застосовно");
  assert.throws(() => silentBeforeClose(baseFacts({}), null), ParamNotSetError, "🔴 поріг не заданий — має бути помилка");
});

/**
 * #758 — НОМЕР УГОДИ: чотири стани з різними причинами, жоден не склеєно з іншим; стан угоди
 * залежить від дзвінків, а «номер не визначено» — лише коли й дзвінків за client_key немає.
 */
test("#758 НОМЕР УГОДИ: чотири причини окремо, «номер не визначено» лише без дзвінків", () => {
  assert.equal(classifyClientKey("0671234567"), "ok");
  assert.equal(classifyClientKey(null), "no_key"); assert.equal(classifyClientKey("   "), "no_key");
  assert.equal(classifyClientKey("12345678"), "not_ua_phone"); assert.equal(classifyClientKey("380671234567"), "not_ua_phone");
  assert.equal(classifyClientKey("671234567"), "not_ua_phone");
  assert.equal(classifyClientKey("товагро"), "not_phone"); assert.equal(classifyClientKey("0a71234567"), "not_phone");
  assert.equal(dealCallState("ok", 0, 0), "no_calls");
  assert.equal(dealCallState("not_phone", 0, 0), "no_phone");
  assert.equal(dealCallState("not_phone", 1, 1), "talked", "🔴 дзвінок знайдено за client_key — стан за дзвінками, не «номер не визначено»");
  assert.equal(dealCallState("ok", 3, 0), "no_talks");
});

/**
 * #758b — ПАРАМЕТРИ, ЯКИХ ЩЕ НЕ ЗАТВЕРДИВ ВЛАСНИК, НЕ МАЮТЬ ЗНАЧЕНЬ ЗА ЗАМОВЧУВАННЯМ: не задано
 * → помилка з текстом «не налаштовано», і тривога класифікує її як конфіг, а не як збій даних.
 */
test("#758b ПАРАМЕТРИ БЕЗ ЗНАЧЕНЬ ЗА ЗАМОВЧУВАННЯМ: не задано → «не налаштовано» (вид config)", () => {
  const ok: AdCallFactsParams = { from: "2026-09-01", to: "2026-09-10", now: new Date(), talkMinSec: 20, windowBefore: "1 days",
    adDealPredicate: FAKE_AD_DEAL, adSources: [] };
  assert.deepEqual(assertFactsParams(ok), { talkMinSec: 20, windowBefore: "1 days" });
  for (const bad of [{ talkMinSec: null }, { talkMinSec: undefined }, { talkMinSec: 0 }, { talkMinSec: 19.5 }, { windowBefore: null },
    { windowBefore: "1 day; DROP TABLE deals" }, { windowBefore: "1 week" }]) {
    let msg = "";
    try { assertFactsParams({ ...ok, ...bad } as AdCallFactsParams); } catch (e) { msg = (e as Error).message; }
    assert.ok(msg.includes("не налаштовано"), `🔴 ${JSON.stringify(bad)} мало кинути «не налаштовано», а кинуло: «${msg}»`);
    assert.equal(classifyJobError(msg), "config", `🔴 «${msg}» класифіковано не як конфіг`);
  }
});
