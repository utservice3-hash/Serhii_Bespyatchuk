import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dueForLookup, isLardiCarrier, lookupRow, lookupMissedPhones, LOOKUP_BUDGET_MS, RECHECK_FOUND_DAYS, RECHECK_MISSING_DAYS,
  type LardiSearch, type LardiSearchResult,
} from "./lardiPhoneLookup.js";

/**
 * 🔎 ЗНАЙДЕНО НА ЛАРДІ = ПЕРЕВІЗНИК (Роман 25.11.2026: «якщо ларді каже що такий номер знайдено це автоматом перевізник, не
 * тільки по архіву а взагалом»; «давай все робити щоб всі номери це перевізники»). Правила — `core/lardiPhoneLookup.ts`,
 * словник §11. Кожне твердження — по обидва боки межі; прохід і довідник — на СВОЄМУ кластері, Ларді підміняє фейк.
 */
const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const DAY = 86_400_000;

type Client = { query<R = Record<string, unknown>>(q: string, p?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>; end(): Promise<void> };
let ready: Promise<Client | string> | null = null;
let scratchUrl = "";
function db(): Promise<Client | string> {
  ready ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return skipReason(scratch);
    process.env.DATABASE_URL = scratch.url;
    scratchUrl = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "test";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    return c as unknown as Client;
  })();
  return ready;
}
after(async () => {
  const c = await ready;
  if (c && typeof c !== "string") await c.end();
});

const reset = (c: Client) => c.query("DELETE FROM ringostat_calls; DELETE FROM lardi_phone_lookup; DELETE FROM carrier_phones; DELETE FROM lardi_offers");
/** Дзвінок `ago` днів тому. */
const call = (c: Client, id: string, phone: string, o: { type?: string; disp?: string; sec?: number; ago?: number } = {}) =>
  c.query(`INSERT INTO ringostat_calls(uniqueid, calldate, call_type, disposition, billsec, client_phone)
           VALUES ($1, now() - make_interval(days => $2::int, mins => 5), $3, $4, $5, $6)`,
    [id, o.ago ?? 1, o.type ?? "in", o.disp ?? "NO ANSWER", o.sec ?? 0, phone]);
const found = (name: string): LardiSearchResult => ({ ok: true, status: 200, users: [{ name }] });
const none: LardiSearchResult = { ok: true, status: 200, users: [] };
/** Фейк Ларді: відповіді за номером, журнал викликів. Номер без відповіді — тест сам зламався. */
function fake(ans: Record<string, LardiSearchResult>): { search: LardiSearch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    search: async (p9) => {
      asked.push(p9);
      const r = ans[p9];
      assert.ok(r, `🔴 Ларді спитали про номер, якого фікстура не чекала: ${p9}`);
      return r;
    },
  };
}
const rows = async (c: Client) =>
  Object.fromEntries((await c.query<{ p9: string; users: number }>("SELECT p9, users FROM lardi_phone_lookup ORDER BY p9")).rows.map((r) => [r.p9, r.users]));

/**
 * #11030 — ПРАВИЛА: знайдено (≥1 користувач) = перевізник; збій Ларді не дає рядка (≠ «не знайдено»); знайдений
 * перевіряється знову через 30 днів, не знайдений — через 7. 🧨 Червоніє, якщо збій записати «0 користувачів», якщо
 * перевізником вважати лише когось із вантажами/машинами (тут фейк знає лише імʼя) або зсунути будь-який строк.
 */
test("#11030 ПРАВИЛА ПОШУКУ НА ЛАРДІ: знайдено = перевізник; збій Ларді — не «не знайдено»; повтор через 30 днів знайденому і 7 — не знайденому", () => {
  assert.equal(isLardiCarrier(1), true, "🔴 номер, який Ларді знаходить, не перевізник — Роман 25.11: «знайдено це автоматом перевізник»");
  assert.equal(isLardiCarrier(0), false, "🔴 номер, якого Ларді не знаходить, став перевізником");
  assert.deepEqual(lookupRow(found("ФОП Вавришин")), { users: 1, name: "ФОП Вавришин" });
  assert.deepEqual(lookupRow(none), { users: 0, name: null });
  assert.equal(lookupRow({ ok: false, status: 403, users: [] }), null, "🔴 відмову Ларді записано як результат — 403 за годину зробив би сотні номерів «клієнтами»");
  assert.equal(lookupRow({ ok: false, status: 0, users: [] }), null, "🔴 обрив звʼязку з Ларді записано як результат");

  const now = new Date("2026-11-25T08:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  assert.equal(dueForLookup(null, now), true, "🔴 номер, якого ще не перевіряли, не перевіряється");
  assert.equal(RECHECK_FOUND_DAYS, 30); assert.equal(RECHECK_MISSING_DAYS, 7);
  assert.equal(dueForLookup({ checkedAt: ago(29), users: 1 }, now), false, "🔴 знайденого перевіряють раніше за 30 днів");
  assert.equal(dueForLookup({ checkedAt: ago(30), users: 1 }, now), true, "🔴 знайденого не перевіряють і після 30 днів");
  assert.equal(dueForLookup({ checkedAt: ago(6), users: 0 }, now), false, "🔴 не знайденого перевіряють раніше за 7 днів");
  assert.equal(dueForLookup({ checkedAt: ago(7), users: 0 }, now), true, "🔴 не знайденого не перевіряють і після 7 днів — номери з'являються на Ларді за 7-8 днів");
});

/**
 * #11031 — ПРОХІД: Ларді питають лише про номери ПРОПУЩЕНИХ вхідних за 35 днів, українські, яких немає в довіднику з
 * інших джерел; знайдене й не знайдене пишеться, а перший збій зупиняє прохід і нічого за цей номер не пише.
 * 🧨 Червоніє, якщо брати відповідані, вихідні, старі чи закордонні дзвінки; питати про номери з історії CRM; писати збій
 * або йти далі після нього.
 */
test("#11031 ПРОХІД: питаємо лише номери пропущених (35 днів, 380…, не в довіднику); знайдено й не знайдено — пишемо; збій зупиняє прохід і не пишеться", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  await reset(c);
  const P = { a: "380971794867", b: "380501822899", fail: "380509391013", answered: "380671100001", out: "380671100002",
    old: "380671100003", foreign: "48601100004", hist: "380671100005", mobile: "380671100006" };
  await call(c, "a", P.a, { ago: 1 });
  await call(c, "m", P.mobile, { ago: 2, type: "transitin", disp: "BUSY" });
  await call(c, "b", P.b, { ago: 3 });
  await call(c, "f", P.fail, { ago: 4 });
  await call(c, "ans", P.answered, { disp: "ANSWERED", sec: 40 });
  await call(c, "out", P.out, { type: "out" });
  await call(c, "old", P.old, { ago: 40 });
  await call(c, "for", P.foreign);
  await call(c, "h", P.hist);
  await c.query("INSERT INTO carrier_phones(p9, via_lardi, via_history) VALUES ($1, false, true)", [P.hist.slice(-9)]);

  const L = fake({ [P.a.slice(-9)]: found("Вавришин Віктор Петрович, ФОП"), [P.mobile.slice(-9)]: none,
    [P.b.slice(-9)]: none, [P.fail.slice(-9)]: { ok: false, status: 429, users: [] } });
  const rep = await lookupMissedPhones(c, L.search, { pauseMs: 0 });

  assert.deepEqual(L.asked, [P.a, P.mobile, P.b, P.fail].map((p) => p.slice(-9)),
    "🔴 Ларді питали не про ті номери або не в тому порядку (свіжий дзвінок першим)");
  assert.deepEqual(await rows(c), { [P.a.slice(-9)]: 1, [P.mobile.slice(-9)]: 0, [P.b.slice(-9)]: 0 },
    "🔴 у таблиці пошуку не те: знайдене/не знайдене загубилось або збій записано результатом");
  assert.deepEqual(rep, { candidates: 4, checked: 3, found: 1, outOfTime: false, failed: 1, failStatus: 429 });
});

/**
 * #11032 — ВІДМОВА ЛАРДІ НА ПЕРШОМУ Ж НОМЕРІ — ПОМИЛКА ДЖОБИ, А НЕ «УСПІХ З НУЛЕМ» (урок архіву цін 17.09–12.10.2026:
 * 3,5 тижня «успіху» на 403). Нічого не записано. Дзеркало: нема кого перевіряти — успіх з нулем, без запитів.
 * 🧨 Червоніє, якщо відмову проковтнути або на порожньому списку смикати Ларді.
 */
test("#11032 ВІДМОВА ЛАРДІ НА ПЕРШОМУ НОМЕРІ — падіння джоби, нічого не записано; нема кандидатів — успіх без запитів", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  await reset(c);
  await call(c, "x", "380971794867");
  const L = fake({ "971794867": { ok: false, status: 403, users: [] } });
  await assert.rejects(lookupMissedPhones(c, L.search, { pauseMs: 0 }), /Ларді не відповів.*403/, "🔴 відмову Ларді проковтнуто — джоба звітує успіх");
  assert.deepEqual(await rows(c), {}, "🔴 відмову Ларді записано");

  await reset(c);
  const E = fake({});
  assert.deepEqual(await lookupMissedPhones(c, E.search, { pauseMs: 0 }), { candidates: 0, checked: 0, found: 0, outOfTime: false, failed: 0, failStatus: null });
  assert.deepEqual(E.asked, [], "🔴 без пропущених Ларді все одно питали");
});

/**
 * #11033 — ПОВТОРНА ПЕРЕВІРКА В SQL ТА САМА, ЩО `dueForLookup`: знайдений — через 30 днів, не знайдений — через 7, по
 * обидва боки межі. Номер, знайдений на Ларді, повторно перевіряється, хоч уже й у довіднику (`via_lardi_user`) — інакше
 * видалений профіль лишався б перевізником назавжди. 🧨 Червоніє, якщо зсунути межу в SQL або виключати з кандидатів
 * номери, що в довіднику лише через пошук.
 */
test("#11033 ПОВТОРНА ПЕРЕВІРКА: SQL = dueForLookup по обидва боки (29/31 днів знайденому, 6/8 — не знайденому); свій же рядок довідника не блокує повтор", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  await reset(c);
  const P = { f29: "380671200001", f31: "380671200002", n6: "380671200003", n8: "380671200004" };
  for (const [k, p] of Object.entries(P)) await call(c, k, p);
  const seed = (p: string, days: number, users: number) =>
    c.query("INSERT INTO lardi_phone_lookup(p9, checked_at, users) VALUES ($1, now() - make_interval(days => $2::int), $3)", [p.slice(-9), days, users]);
  await seed(P.f29, 29, 1); await seed(P.f31, 31, 1); await seed(P.n6, 6, 0); await seed(P.n8, 8, 0);
  await c.query("INSERT INTO carrier_phones(p9, via_lardi, via_history, via_lardi_user) VALUES ($1, false, false, true), ($2, false, false, true)",
    [P.f29.slice(-9), P.f31.slice(-9)]);

  const L = fake({ [P.f31.slice(-9)]: none, [P.n8.slice(-9)]: found("ТОВ Ван") });
  await lookupMissedPhones(c, L.search, { pauseMs: 0 });
  assert.deepEqual(L.asked.slice().sort(), [P.f31, P.n8].map((p) => p.slice(-9)).sort(),
    "🔴 повторна перевірка в SQL розійшлась із правилом 30/7 днів");
  const now = new Date();
  for (const [p, d, u, want] of [[P.f29, 29, 1, false], [P.f31, 31, 1, true], [P.n6, 6, 0, false], [P.n8, 8, 0, true]] as const)
    assert.equal(dueForLookup({ checkedAt: new Date(now.getTime() - d * DAY), users: u }, now), want, `правило і SQL мають казати те саме для ${p}`);
});

/**
 * #11034 — ДОВІДНИК: номер, який знаходить пошук Ларді, — у `carrier_phones` (`via_lardi_user`, назва з профілю), і для
 * екрана клієнтів це «Lardi»; не знайдений — ні. Номер і з машин, і з пошуку — один рядок. Проводка: джоба під кроном
 * «7 * * * *» і під наглядом раз на 60 хв; підказка вкладки каже про пошук Ларді. 🧨 Червоніє, якщо прибрати CTE пошуку з
 * довідника, брати «не знайдено», загубити назву, зняти джобу з крону чи нагляду або повернути старий текст підказки.
 */
test("#11034 ДОВІДНИК: знайдений пошуком Ларді — перевізник (via_lardi_user, «Lardi» на екрані клієнтів), не знайдений — ні; джоба під кроном і наглядом; підказка про пошук", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  await reset(c);
  const P = { user: "380971794867", miss: "380501822899", both: "380671300001" };
  await c.query("INSERT INTO lardi_phone_lookup(p9, users, name) VALUES ($1, 1, 'Вавришин Віктор Петрович, ФОП'), ($2, 0, NULL), ($3, 2, 'ТОВ Два')",
    [P.user.slice(-9), P.miss.slice(-9), P.both.slice(-9)]);
  await c.query(`INSERT INTO lardi_offers(side, offer_id, from_id, to_id, company, phones) VALUES ('lorry', 1, 1, 2, 'ТОВ Машини', $1::jsonb)`,
    [JSON.stringify([{ n: `+${P.both}` }])]);
  const { rebuildCarrierPhones, clientPhones } = await import("./carrierPhones.js");
  assert.equal(await rebuildCarrierPhones(c), 2, "🔴 у довіднику не 2 номери: знайдений пошуком загубився, не знайдений потрапив або номер задвоївся");
  const d = Object.fromEntries((await c.query<{ p9: string; via_lardi: boolean; via_lardi_user: boolean; lardi_company: string | null }>(
    "SELECT p9, via_lardi, via_lardi_user, lardi_company FROM carrier_phones")).rows.map((r) => [r.p9, r]));
  assert.deepEqual(d[P.user.slice(-9)], { p9: P.user.slice(-9), via_lardi: false, via_lardi_user: true, lardi_company: "Вавришин Віктор Петрович, ФОП" },
    "🔴 номер, який знаходить Ларді, не перевізник — Роман 25.11: «знайдено це автоматом перевізник»");
  assert.equal(d[P.miss.slice(-9)], undefined, "🔴 номер, якого Ларді НЕ знаходить, став перевізником");
  assert.deepEqual([d[P.both.slice(-9)]?.via_lardi, d[P.both.slice(-9)]?.via_lardi_user, d[P.both.slice(-9)]?.lardi_company], [true, true, "ТОВ Машини"]);

  await c.query(`INSERT INTO deals(kommo_id, name, pipeline_id, status_id, client_key, client_key_raw, price, created_at_kommo)
                 VALUES (110341, 'ТОВ Клієнт', 8921932, 142, 'k1', 'k1', 1000, now())`);
  await c.query("INSERT INTO deal_contacts(deal_kommo_id, contact_id) VALUES (110341, 11034)");
  await c.query("INSERT INTO contact_phones(contact_id, phone) VALUES (11034, $1)", [P.user]);
  const ph = (await clientPhones(c, ["k1"])).get("k1") ?? [];
  assert.equal(ph[0]?.carrier?.lardi, true, "🔴 на екрані клієнтів номер, знайдений пошуком Ларді, не позначено «Lardi»");

  const idx = SRC("index.ts");
  assert.match(idx, /cron\.schedule\("1,6,11,16,21,26,31,36,41,46,51,56 \* \* \* \*", \(\) => \{\s*void runJob\("lardiPhoneLookup", \(\) => lardiPhoneLookup\(\)\);/,
    "🔴 джоба пошуку на Ларді не під кроном кожні 5 хв (Роман 25.11: «давай цю джобу частіше ранити»)");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "lardiPhoneLookup")?.everyMin, 5, "🔴 джоба пошуку на Ларді не під наглядом раз на 5 хв (== крону)");
  const fe = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "missedCallsView.ts"), "utf8");
  assert.match(fe, /знаходяться пошуком Ларді за номером/, "🔴 підказка «перевізники» не каже про пошук Ларді");
  const gl = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "docs", "METRICS_GLOSSARY.md"), "utf8");
  assert.match(gl, /ЗНАЙДЕНО НА ЛАРДІ = ПЕРЕВІЗНИК \(з 25\.11\.2026[\s\S]{0,1600}«Відсів» \(§17a\) це джерело НЕ читає/, "🔴 словник не каже правила 25.11");
});

/**
 * #11035 — ЧАСТІШЕ Й ОДРАЗУ НА ЕКРАН (Роман 25.11.2026: «давай цю джобу частіше ранити»). Прохід кожні 5 хв має стелю
 * часу — зупиняється й лишає решту наступному тіку (але один номер перевіряє завжди); знайшов хоч одного — одразу кличе
 * перебудову довідника, не знайшов нікого — не кличе. Джоба передає саме перебудову довідника.
 * 🧨 Червоніє, якщо прибрати стелю, зламати умову виклику перебудови або не передати її з джоби.
 */
test("#11035 ПОШУК НА ЛАРДІ КОЖНІ 5 ХВ: прохід має стелю часу (решта — наступним тіком); знайдено — одразу перебудова довідника, не знайдено — без неї", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  assert.ok(LOOKUP_BUDGET_MS > 0 && LOOKUP_BUDGET_MS < 5 * 60_000, "🔴 стеля проходу не вкладається в 5 хв між тіками — проходи наклались би");
  const P = ["380671400001", "380671400002", "380671400003"];
  const seed = async () => { await reset(c); for (const [i, p] of P.entries()) await call(c, `b${i}`, p, { ago: i + 1 }); };

  await seed();
  let rebuilt = 0;
  const A = fake({ [P[0].slice(-9)]: found("ФОП Один"), [P[1].slice(-9)]: none, [P[2].slice(-9)]: none });
  const cut = await lookupMissedPhones(c, A.search, { pauseMs: 0, budgetMs: 0, onFound: async () => { rebuilt++; } });
  assert.deepEqual(A.asked, [P[0].slice(-9)], "🔴 прохід не зупинився на стелі часу (або не перевірив жодного номера)");
  assert.deepEqual([cut.checked, cut.found, cut.outOfTime], [1, 1, true]);
  assert.equal(rebuilt, 1, "🔴 знайдений на Ларді номер не перебудував довідник одразу — дійде до екрана лише о :22");

  await seed();
  rebuilt = 0;
  const B = fake({ [P[0].slice(-9)]: none, [P[1].slice(-9)]: none, [P[2].slice(-9)]: none });
  const all = await lookupMissedPhones(c, B.search, { pauseMs: 0, onFound: async () => { rebuilt++; } });
  assert.deepEqual([B.asked.length, all.checked, all.outOfTime], [3, 3, false], "🔴 без вичерпаної стелі прохід перевірив не всіх");
  assert.equal(rebuilt, 0, "🔴 довідник перебудовується, хоча Ларді нікого не знайшов");

  assert.match(SRC("jobs/lardiPhoneLookup.ts"), /lookupMissedPhones\(pool, lardiUsersByPhone, \{ onFound: \(\) => rebuildCarrierPhones\(\) \}\)/,
    "🔴 джоба не передає перебудову довідника — знайдені номери чекатимуть :22");
});

/**
 * #11036 — ДВІ ПЕРЕБУДОВИ ДОВІДНИКА ЙДУТЬ ПО ЧЕРЗІ. Тепер довідник перебудовує не лише крон о :22, а й пошук на Ларді
 * (о :21 прохід може зайти на :22). Конкурент — перебудова без замка, що стоїть посеред транзакції (DELETE + INSERT,
 * не закомічено); наша мусить дочекатись і пройти. 🧨 Без `LOCK TABLE` наша не бачить вставлених конкурентом рядків
 * і падає на ключі `carrier_phones_pkey`.
 */
test("#11036 ДВІ ПЕРЕБУДОВИ ДОВІДНИКА ОДНОЧАСНО: друга чекає першу й проходить, а не падає на ключі", async (t) => {
  const c = await db(); if (typeof c === "string") return t.skip(c);
  await reset(c);
  await c.query("INSERT INTO lardi_phone_lookup(p9, users, name) VALUES ('971794867', 1, 'ФОП'), ('501822899', 1, 'ТОВ')");
  const { rebuildCarrierPhones, CARRIER_PHONES_SELECT_SQL } = await import("./carrierPhones.js");
  assert.equal(await rebuildCarrierPhones(c), 2);

  const { default: pg } = await import("pg");
  const other = new pg.Client({ connectionString: scratchUrl });
  await other.connect();
  try {
    await other.query("BEGIN");
    await other.query("DELETE FROM carrier_phones");
    await other.query(`INSERT INTO carrier_phones (p9, via_lardi, via_history, via_lardi_user, history_deal, lardi_company) ${CARRIER_PHONES_SELECT_SQL}`);
    const ours = rebuildCarrierPhones(c).then((n) => ({ n }), (e: unknown) => ({ e }));
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const w = await other.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()");
      waiting = (w.rows[0]?.n ?? 0) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(waiting, "🔴 наша перебудова не чекала на конкурента — фікстура не відтворила зустрічі двох перебудов");
    await other.query("COMMIT");
    const res = await ours;
    assert.deepEqual(res, { n: 2 }, `🔴 друга перебудова довідника впала замість дочекатись першої: ${"e" in res ? String(res.e) : ""}`);
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    await other.end();
  }
});
