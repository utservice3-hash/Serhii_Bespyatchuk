import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  cardText, emptyTally, formatItems, launchAt, pageContinues, qualifies, quietTooLong, runVerdict, winnersOf,
  type PzSearchItem, type PzTender, type Winner,
} from "./prozorroRules.js";
import { makeProzorroClient } from "./prozorroClient.js";
import { runProzorroCollect, type LeadRow, type PzStore, type TenderRow } from "./prozorroCollect.js";
import { PROZORRO_NICHES } from "./prozorroNiches.js";

const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const LAUNCH = new Date("2026-10-22T03:05:00Z");
const win = (p: Partial<Winner>): Winner => ({ edrpou: "45740219", companyName: "ТОВ ДІЗЕЛЬ ЕНЕРДЖИ", region: null, city: null, address: null,
  contactName: null, phone: null, email: null, amount: 500_000, currency: "UAH", awardDate: "2026-10-23T09:50:06+03:00", ...p });

/**
 * #2350 — ПОРІГ І «ЛИШЕ НОВЕ» (рішення Романа 21.10.2026: переможці від 500 000 ₴, без прогону за минуле).
 * Приклади по ОБИДВА боки кожної межі: 499 999 / 500 000 ₴, рішення до / після запуску, гривня / валюта, є / немає коду.
 * 🧨 Червоніє, якщо `>=` стане `>`, прибрати перевірку дати чи валюти, або пустити переможця без ЄДРПОУ (дубль неможливо відсіяти).
 */
test("#2350 ПОРІГ: 500 000 ₴ береться, 499 999 — ні; рішення до запуску, не гривня, без ЄДРПОУ — не ліди", () => {
  assert.equal(qualifies(win({ amount: 500_000 }), 500_000, LAUNCH), "ok", "🔴 рівно 500 000 ₴ не пройшло поріг «від 500 000»");
  assert.equal(qualifies(win({ amount: 499_999.99 }), 500_000, LAUNCH), "below", "🔴 менше порогу стало лідом");
  assert.equal(qualifies(win({ awardDate: "2026-10-22T06:04:59+03:00" }), 500_000, LAUNCH), "before_launch",
    "🔴 переможця, визначеного ДО запуску, взято — це прогін за минуле, якого вирішили не робити");
  assert.equal(qualifies(win({ awardDate: "2026-10-22T06:05:00+03:00" }), 500_000, LAUNCH), "ok", "дзеркало: рішення в мить запуску — нове");
  assert.equal(qualifies(win({ awardDate: null }), 500_000, LAUNCH), "before_launch", "🔴 рішення без дати прочитано як нове");
  assert.equal(qualifies(win({ currency: "USD", amount: 900_000 }), 500_000, LAUNCH), "currency", "🔴 долари порівняно з гривневим порогом");
  assert.equal(qualifies(win({ edrpou: null, amount: 9_000_000 }), 500_000, LAUNCH), "no_edrpou", "🔴 переможець без коду став лідом");
  const now = new Date("2026-10-25T00:00:00Z");
  assert.equal(launchAt(null, now), now, "перший прохід — запуск зараз");
  assert.equal(launchAt(LAUNCH, now), LAUNCH, "🔴 момент запуску «поїхав» за поточним часом — минуле знову стане новим");
});

/**
 * #2351 — ПЕРЕМОЖЦІ З ТЕНДЕРА: лише рішення `active` (скасоване чи відхилене — не переможець), консорціум дає рядок на
 * кожного учасника, код нормалізується до цифр, назва — юридична, а без неї коротка.
 * 🧨 Червоніє, якщо прибрати фільтр статусу рішення або брати лише першого постачальника.
 */
test("#2351 ПЕРЕМОЖЦІ: лише active-рішення, кожен учасник консорціуму, код — цифри, контакти з contactPoint", () => {
  const t: PzTender = { tenderID: "UA-2026-10-05-000291-a", awards: [
    { status: "cancelled", date: "2026-10-20T10:00:00+03:00", value: { amount: 9e6, currency: "UAH" }, suppliers: [{ name: "СКАСОВАНИЙ", identifier: { id: "11111111" } }] },
    { status: "active", date: "2026-10-23T09:50:06+03:00", value: { amount: 1_356_790, currency: "UAH" }, suppliers: [
      { name: "ДІЗЕЛЬ", identifier: { id: " 4574 0219 ", legalName: "ТОВ ДІЗЕЛЬ ЕНЕРДЖИ" },
        address: { postalCode: "07415", locality: "село Погреби", region: "Київська область", streetAddress: "вул. Шлях, 1б" },
        contactPoint: { name: "Ірина", telephone: "+380670000000", email: "sales@example.ua" } },
      { name: "ПАРТНЕР", identifier: { id: "1234567890" } },
    ] },
  ] };
  const ws = winnersOf(t);
  assert.equal(ws.length, 2, "🔴 скасоване рішення дало переможця або консорціум зрізано до одного");
  assert.deepEqual([ws[0].edrpou, ws[0].companyName, ws[0].phone, ws[0].email, ws[0].region, ws[0].amount],
    ["45740219", "ТОВ ДІЗЕЛЬ ЕНЕРДЖИ", "+380670000000", "sales@example.ua", "Київська область", 1_356_790]);
  assert.equal(ws[0].address, "07415, село Погреби, вул. Шлях, 1б");
  assert.deepEqual([ws[1].edrpou, ws[1].companyName, ws[1].phone], ["1234567890", "ПАРТНЕР", null], "ФОП — ІПН 10 цифр; без юр. назви — коротка");
  assert.equal(winnersOf({ awards: [{ status: "active", suppliers: [{ identifier: { id: "123" } }] }] })[0].edrpou, null, "🔴 «123» прийнято за ЄДРПОУ");
});

/**
 * #2352 — КАРТКА УГОДИ (ТЗ, «що показувати менеджеру»): позиції «1. … — 10 шт.», понад 15 — «… ще N позицій», коди ДК021
 * без повторів, замовник із регіоном, сума в гривнях із пробілами, «Роль: Переможець», робоче посилання на тендер.
 * 🧨 Червоніє, якщо зламати формат позицій, загубити ДК021 чи посилання.
 */
test("#2352 КАРТКА: позиції з кількістю, ДК021 без повторів, замовник, сума, роль і посилання на тендер", () => {
  const items = [
    { description: "Генератор дизельний 100 кВт", quantity: 10, unit: { name: "шт." }, classification: { id: "31120000-3", description: "Генератори" } },
    { description: "Кабель силовий КГ 4x25", quantity: 200, unit: { name: "м" }, classification: { id: "44320000-9", description: "Кабелі" } },
    { description: "Генератор дизельний 60 кВт", quantity: 2.5, unit: null, classification: { id: "31120000-3", description: "Генератори" } },
  ];
  const t: PzTender = { tenderID: "UA-2026-10-05-000291-a", title: "Дизельні генератори", items,
    procuringEntity: { identifier: { legalName: "Військова частина А7029" }, address: { region: "Закарпатська область" } } };
  const card = cardText(t, win({ amount: 1_356_790, awardDate: "2026-10-23T09:50:06+03:00" }), ["Енергетика/електрика"]);
  for (const line of ["Тендер: Дизельні генератори", "1. Генератор дизельний 100 кВт — 10 шт.", "2. Кабель силовий КГ 4x25 — 200 м",
    "3. Генератор дизельний 60 кВт — 2.5 шт.", "ДК021: 31120000-3 — Генератори; 44320000-9 — Кабелі",
    "Замовник: Військова частина А7029, Закарпатська область", "Сума: 1 356 790 ₴", "Дата рішення: 23.10.2026", "Роль: Переможець",
    "Ніша: Енергетика/електрика", "Посилання: https://prozorro.gov.ua/tender/UA-2026-10-05-000291-a"]) {
    assert.ok(card.split("\n").includes(line), `🔴 у картці немає рядка «${line}»:\n${card}`);
  }
  const many = formatItems(Array.from({ length: 18 }, (_, i) => ({ description: `Парта ${String(i + 1)}`, quantity: 1 })));
  assert.deepEqual([many.length, many[14], many[15]], [16, "15. Парта 15 — 1 шт.", "… ще 3 позицій"], "🔴 довгий перелік не обрізано або загублено хвіст");
});

/** Фейкове сховище з тим самим ключем дубля, що в схемі: (ЄДРПОУ + тендер + роль). */
function fakeStore(seed: string[] = []) {
  const tenders = new Map<string, TenderRow>(seed.map((id) => [id, { uaId: id } as TenderRow]));
  const leads = new Map<string, LeadRow>();
  let first: Date | null = seed.length ? new Date("2026-10-22T03:05:00Z") : null;
  const store: PzStore = {
    knownTenders: async (ids) => new Set(ids.filter((id) => tenders.has(id))),
    firstSeenAt: async () => first,
    saveTenders: async (rows) => { for (const r of rows) if (!tenders.has(r.uaId)) tenders.set(r.uaId, r); first ??= new Date("2026-10-22T03:05:00Z"); },
    knownCompanies: async (e) => new Set([...leads.values()].map((l) => l.edrpou!).filter((x) => e.includes(x))),
    crmCompanies: async (e) => new Map(e.filter((x) => x === "22222222").map((x) => [x, 777])),
    saveLeads: async (rows) => rows.filter((l) => {
      const k = `${l.edrpou}|${l.uaId}|${l.role}`;
      if (leads.has(k)) return false;
      leads.set(k, l); return true;
    }),
  };
  return { store, tenders, leads };
}
const item = (id: string): PzSearchItem => ({ tenderID: id, title: id, status: "complete", value: { amount: 1e6, currency: "UAH" } });
const tenderOf = (id: string, edrpou: string, amount: number, date = "2026-10-23T10:00:00+03:00"): PzTender =>
  ({ id: `hex-${id}`, tenderID: id, title: `Тендер ${id}`, items: [{ description: "Генератор", quantity: 1 }],
    awards: [{ status: "active", date, value: { amount, currency: "UAH" }, suppliers: [{ name: `Фірма ${edrpou}`, identifier: { id: edrpou } }] }] });

/**
 * #2353 — ПРОХІД: перший — точка відліку (усе знайдене записано баченим, ЖОДНОГО запиту деталей, жодного ліда);
 * далі деталі тягнуться лише для НЕБАЧЕНИХ, лід — лише за правилами #2350, дубль (ЄДРПОУ + тендер) удруге не пишеться,
 * тендер, деталі якого не прийшли, НЕ записується (завтра спробуємо знову), старі номери з пошуку не беруться,
 * пошук гортається, поки сторінка повна й свіжа.
 * 🧨 Червоніє, якщо перший прохід потягне деталі (≈4 год запитів) чи створить ліди за минуле, бачені тендери тягнутимуться
 * щодня, дубль запишеться двічі або тендер зі збоєм загубиться назавжди.
 */
test("#2353 ПРОХІД: точка відліку без деталей; далі лише нові тендери; дубль не пишеться; збій деталей — повтор завтра", async () => {
  const now = new Date("2026-10-23T03:05:00Z");
  const page1 = [...Array.from({ length: 19 }, (_, i) => item(`UA-2026-10-1${String(i % 10)}-00000${String(i)}-a`)), item("UA-2026-10-20-000100-a")];
  const pages: Record<string, PzSearchItem[][]> = {
    генератор: [page1, [item("UA-2026-10-21-000200-a"), item("UA-2024-01-18-000001-a")]],
    кабель: [[item("UA-2026-10-20-000100-a"), item("UA-2026-10-21-000300-a")]],
  };
  const niches = { "Енергетика/електрика": ["генератор", "кабель"] };
  const calls = { search: [] as string[], tender: [] as string[] };
  const deps = (store: PzStore, details: Record<string, PzTender | null>) => ({
    search: async (w: string, p: number) => { calls.search.push(`${w}:${String(p)}`); return { ok: true as const, data: pages[w]?.[p - 1] ?? [] }; },
    tender: async (id: string) => { calls.tender.push(id); const t = details[id]; return t ? { ok: true as const, data: t } : { ok: false as const, status: 503, error: "HTTP 503" }; },
    store, niches, now, minAmount: 500_000,
  });

  const base = fakeStore();
  const r0 = await runProzorroCollect(deps(base.store, {}));
  assert.equal(r0.tally.baseline, true);
  assert.equal(calls.tender.length, 0, "🔴 перший прохід тягнув деталі старих тендерів");
  assert.equal(r0.leads.length + base.leads.size, 0, "🔴 перший прохід створив ліди — це прогін за минуле");
  assert.deepEqual(calls.search, ["генератор:1", "генератор:2", "кабель:1"], "🔴 пошук гортає не за правилом «повна й свіжа сторінка»");
  assert.equal(base.tenders.size, 22, "🔴 не все знайдене записано баченим (тендер 2024 року мав відпасти)");
  assert.ok(!base.tenders.has("UA-2024-01-18-000001-a"), "🔴 тендер 2024 року взято з пошуку");
  assert.equal(r0.verdict.ok, true);

  calls.search.length = 0; calls.tender.length = 0;
  pages.кабель = [[item("UA-2026-10-20-000100-a"), item("UA-2026-10-22-000400-a"), item("UA-2026-10-22-000500-a"), item("UA-2026-10-22-000600-a")]];
  const r1 = await runProzorroCollect(deps(base.store, {
    "UA-2026-10-22-000400-a": tenderOf("UA-2026-10-22-000400-a", "22222222", 2_000_000),
    "UA-2026-10-22-000500-a": tenderOf("UA-2026-10-22-000500-a", "33333333", 100_000),
    "UA-2026-10-22-000600-a": null,
  }));
  assert.deepEqual(calls.tender.sort(), ["UA-2026-10-22-000400-a", "UA-2026-10-22-000500-a", "UA-2026-10-22-000600-a"],
    "🔴 деталі тягнуться для вже бачених тендерів (щодня ті самі тисячі запитів)");
  assert.deepEqual(r1.leads.map((l) => [l.edrpou, l.uaId, l.kommoCompanyExisting, l.mode]),
    [["22222222", "UA-2026-10-22-000400-a", 777, "dry"]], "🔴 лідом став не той переможець або режим не пробний");
  assert.deepEqual([r1.tally.newLeads, r1.tally.inCrm, r1.tally.skipped.below, r1.tally.detailFail], [1, 1, 1, 1]);
  assert.ok(!base.tenders.has("UA-2026-10-22-000600-a"), "🔴 тендер зі збоєм деталей записано баченим — більше ніколи не перевіримо");
  assert.match(r1.leads[0].card, /^Тендер: Тендер UA-2026-10-22-000400-a$/m);

  const again = await base.store.saveLeads(r1.leads);
  assert.equal(again.length, 0, "🔴 дубль (ЄДРПОУ + тендер + роль) записано вдруге");
});

/**
 * #2354 — ВИРОК І ТИША (ТЗ: «Alert якщо помилок API > 5%, нема нових лідів 2 доби»). Пошук не відповів жодного разу —
 * падіння (нуль тут аварія, а не вимір); помилок понад 5% — падіння; 5% рівно — ще ні. Тиша 2 доби — лише після
 * 2 діб роботи (одразу після запуску нуль — норма).
 * 🧨 Червоніє, якщо «успіх із нулем» повернеться, поріг 5% зсунеться або тиша кричатиме в перший день.
 */
test("#2354 ВИРОК: нуль відповідей і понад 5% помилок — аварія, рівно 5% — ні; тиша 2 доби — лише після 2 діб роботи", () => {
  const t = (p: Partial<ReturnType<typeof emptyTally>>) => ({ ...emptyTally(), ...p });
  const dead = runVerdict(t({ searchRequests: 200, searchFail: 200, lastFail: "HTTP 503" }));
  assert.equal(dead.ok, false, "🔴 Prozorro мовчав увесь прохід, а вирок — успіх");
  assert.match(dead.ok ? "" : dead.error, /жодного разу: 200 з 200 .*HTTP 503/);
  assert.equal(runVerdict(t({ searchRequests: 95, searchOk: 94, searchFail: 1, fetched: 5, detailFail: 5 })).ok, false, "🔴 6% помилок — не аварія");
  assert.equal(runVerdict(t({ searchRequests: 95, searchOk: 90, searchFail: 5, fetched: 5 })).ok, true, "дзеркало: рівно 5% — ще не аварія");
  assert.equal(runVerdict(t({})).ok, true, "дзеркало: нема чого шукати — не збій");
  const launch = new Date("2026-10-22T03:00:00Z");
  const h = (n: number) => new Date(launch.getTime() + n * 3_600_000);
  assert.equal(quietTooLong(null, launch, h(47)), false, "🔴 тиша кричить у перші 2 доби після запуску");
  assert.equal(quietTooLong(null, launch, h(48)), true, "🔴 2 доби без жодного ліда — і тиші не видно");
  assert.equal(quietTooLong(h(10), launch, h(57)), false, "дзеркало: останній лід 47 год тому — ще не тривога");
  assert.equal(quietTooLong(h(10), launch, h(58)), true);
});

/**
 * #2355 — КОНТАКТИ ПЕРЕМОЖЦІВ ЗАКРИТО ВІД AI: REVOKE нижче за CREATE обох таблиць і нижче за загальний GRANT; обидві в
 * `FORBIDDEN_TABLES`.
 * 🧨 Червоніє, якщо прибрати REVOKE, поставити його вище GRANT або забути заборону застосунку.
 */
test("#2355 prozorro_tenders і prozorro_leads: REVOKE від ai_readonly після CREATE і GRANT, є у FORBIDDEN_TABLES", () => {
  const sql = SRC("db/schema.sql");
  const rev = sql.indexOf("REVOKE ALL ON prozorro_tenders, prozorro_leads FROM ai_readonly;");
  assert.ok(rev > sql.indexOf("CREATE TABLE IF NOT EXISTS prozorro_leads ("), "🔴 REVOKE немає або вище за CREATE");
  assert.ok(rev > sql.indexOf("CREATE TABLE IF NOT EXISTS prozorro_tenders ("), "🔴 REVOKE вище за CREATE тендерів");
  assert.ok(rev > sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;"), "🔴 REVOKE вище за GRANT — GRANT поверне доступ");
  assert.match(SRC("ai/metricTools.ts"), /"prozorro_tenders", "prozorro_leads",/, "🔴 немає у FORBIDDEN_TABLES");
});

/**
 * #2356 — КЛІЄНТ PROZORRO: 429 і 5xx — повтор із паузою, 404 — без повтору (не допоможе), збій мережі — повтор; між
 * запитами пауза ≥ 500 мс (2/с; на ~4/с Prozorro віддає 429); User-Agent є завжди (без нього пошук — 503 на кожен запит).
 * 🧨 Червоніє, якщо прибрати повтори, паузу чи заголовок.
 */
test("#2356 КЛІЄНТ: повтор на 429/5xx і збій мережі, без повтору на 404; пауза між запитами; User-Agent у кожному", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const seen: { url: string; ua: string | null }[] = [];
  const script: (number | Error)[] = [429, 503, 200, 404, new Error("fetch failed"), 200, 200];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, ua: new Headers(init?.headers).get("User-Agent") });
    const s = script.shift();
    if (s instanceof Error) throw s;
    return new Response(s === 200 ? JSON.stringify(url.includes("summary") ? { id: "hex1" } : { data: url.includes("public-api") ? { tenderID: "UA-1" } : [] }) : "x", { status: s });
  }) as unknown as typeof fetch;
  const c = makeProzorroClient({ fetch: fakeFetch, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, nowMs: () => clock });
  const s = await c.search("генератор", 1);
  assert.equal(s.ok, true, "🔴 після 429 і 503 повтору не було");
  assert.equal(seen.length, 3);
  const nf = await c.tender("UA-1");
  assert.deepEqual(nf.ok ? null : [nf.status, seen.length], [404, 4], "🔴 404 повторювали — це марні запити до Prozorro");
  const ok = await c.tender("UA-1");
  assert.equal(ok.ok, true, "🔴 збій мережі не повторено");
  assert.ok(seen.every((x) => x.ua && /uts-dashboard/.test(x.ua)), "🔴 запит без User-Agent — Prozorro відповість 503");
  assert.ok(sleeps.some((ms) => ms >= 499 && ms <= 500), "🔴 між запитами немає паузи 500 мс");
});

/**
 * #2367 — ПРОВОДКА (прохід 2): щодня о 06:05 за Києвом; під наглядом із частотою свого крону (мовчання = тривога);
 * запис у Kommo — ЛИШЕ в бойовому режимі й лише рядків бойового режиму (зібране в пробному в CRM не йде ніколи); у самому
 * зборі шляху в Kommo немає; звіт — у лог, НЕ в Telegram (рішення 23.10), і пишеться ДО падіння.
 * 🧨 Червоніє, якщо зняти джобу з нагляду, розвести частоти, прибрати київський пояс, писати в Kommo поза «live», брати в
 * чергу рядки пробного режиму, повернути Telegram або писати звіт після падіння.
 */
test("#2367 ПРОВОДКА: 06:05 за Києвом, під наглядом раз на добу; запис у Kommo лише в бойовому режимі, звіт — у лог", async () => {
  const src = SRC("index.ts");
  assert.match(src, /cron\.schedule\("5 6 \* \* \*", \(\) => \{\n {2}void runJob\("prozorroLeads", \(\) => prozorroLeads\(\)\);\n\}, \{ timezone: "Europe\/Kyiv" \}\);/,
    "🔴 джоба не запускається щодня о 06:05 за Києвом");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "prozorroLeads")?.everyMin, 1440, "🔴 збір не під наглядом або частота розійшлась із кроном");
  assert.doesNotMatch(SRC("core/prozorroCollect.ts"), /kommo\/client|kommoWrite/, "🔴 у самому зборі з'явився шлях запису в Kommo");
  const jobSrc = SRC("jobs/prozorroLeads.ts");
  const calls = [...jobSrc.matchAll(/\bpushLeads\(/g)].length;
  assert.equal(calls, 1, "🔴 запис у Kommo викликається не рівно в одному місці");
  assert.match(jobSrc, /if \(mode === "live"\) \{\n(?:[^\n]*\n){1,5}?[^\n]*\bpushLeads\(/, "🔴 запис у Kommo не під умовою бойового режиму");
  assert.match(jobSrc, /WHERE l\.mode = 'live' AND l\.kommo_lead_id IS NULL AND l\.push_attempts < \$1/,
    "🔴 у чергу запису потрапляють рядки пробного режиму або вже записані");
  assert.doesNotMatch(jobSrc, /sendAdminAlert/, "🔴 звіт знову шлеться в Telegram — Роман 23.10: «без звіту в телеграм»");
  assert.match(jobSrc, /console\.log\(`prozorroLeads: [^\n]*\$\{text\}`\);\n {2}if \(!res\.verdict\.ok\) throw new Error\(res\.verdict\.error\);/,
    "🔴 звіт не пишеться в лог перед падінням — аварійний прохід лишиться без пояснення");
});

/**
 * #2358 — НІШІ ДОСЛІВНО З ТЗ: 8 груп, жодна не порожня, жодне слово не повторюється (повтор = подвійні запити й ліди
 * з двома нішами без причини), ключові слова з прикладів ТЗ на місці.
 * 🧨 Червоніє, якщо видалити групу чи слово з ТЗ або продублювати слово.
 */
test("#2358 НІШІ: 8 груп із ТЗ, жодна не порожня, без повторів слів", () => {
  const groups = Object.entries(PROZORRO_NICHES);
  assert.equal(groups.length, 8, "🔴 груп не 8, як у ТЗ");
  assert.ok(groups.every(([, w]) => w.length > 0), "🔴 порожня ніша");
  const all = groups.flatMap(([, w]) => w.map((x) => x.toLowerCase()));
  assert.equal(new Set(all).size, all.length, `🔴 слово повторюється: ${all.filter((x, i) => all.indexOf(x) !== i).join(", ")}`);
  for (const w of ["генератор", "БПЛА", "металопрокат", "томограф", "сміттєвоз", "шкільні меблі", "вантажівка", "насос"]) {
    assert.ok(all.includes(w.toLowerCase()), `🔴 слова «${w}» з ТЗ немає`);
  }
  assert.ok(all.length >= 150, `🔴 слів ${String(all.length)} — частину ТЗ загублено`);
  assert.equal(pageContinues([], "2026-01-01"), false);
});
