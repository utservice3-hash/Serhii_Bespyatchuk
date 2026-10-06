/**
 * 🧾 Реквізити з 1С у конструкторі (`constructor/onec.ts`) — гейти #1394–#1397. Без мережі: `lookup1c` і
 * `resolveRequisites` отримують фальшиві залежності. Фікстури — ВИГАДАНІ компанії, рахунки й люди (репозиторій
 * публічний), а форма відповіді — рівно та, що описана в листі 1С від 04.10.2026 і заміряна на проді 06.10.2026.
 * Живий гейт #1397 ходить у справжню 1С лише в `test:prod` (з прод-сервера 1С досяжна, як для `#124`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi } from "../testMode.js";
import { fromOneC, mergeRequisites, lookup1c, resolveRequisites, type OneCLookup } from "./onec.js";
import type { RegistryCard } from "./youscore.js";

const IBAN_A = "UA213052990000026007233566001";
const IBAN_B = "UA903220010000026001234567890";
const LEGAL_1C = {
  state: true, uid: "00000000-0000-0000-0000-000000000001", code: "000000001",
  name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ТЕСТОВА РОМАШКА"', inn: null, edrpou: "12345678",
  vat_payer: true, vat_number: "123456789012", resident: true, country: "UA",
  legal_address: "м. Київ, вул. Тестова, 1", actual_address: null, phones: "+380440000000", email: "office@test.example",
  contact_fio: "Контактенко Іван", bank_name: "АТ «ТЕСТБАНК»", bank_account: "ua21 3052 9900 0002 6007 2335 6600 1", bank_mfo: "305299",
  agreements: [],
};
const FOP_1C = { ...LEGAL_1C, name: "ФОП Тестенко Марія Іванівна", edrpou: null, inn: "1234567890", vat_number: null,
  bank_account: null, bank_name: null, phones: null, email: null };
const REG: RegistryCard = {
  edrpou: "12345678", name: "ТОВ «ТЕСТОВА РОМАШКА»", ipn: "123456789012", addr: "Україна, 01001, місто Київ, вул. Тестова, 1",
  dir: "Директоренко Остап Петрович", phone: "+380 44 111 11 11", email: "reg@test.example",
  isFop: false, actualDate: "2026-10-01T00:00:00Z", status: "Не перебуває в процесі припинення", warn: null,
};

/** #1394 — відповідь 1С у полях форми: IBAN нормалізується; некоректний НЕ підставляється, але не губиться. */
test("#1394 КАРТКА З 1С: IBAN нормалізується, некоректний не підставляється, ФОП — за 10-значним кодом", () => {
  const a = fromOneC("12345678", LEGAL_1C);
  assert.equal(a.iban, IBAN_A, "пробіли й регістр 1С не мають ламати рахунок");
  assert.equal(a.bank, "АТ «ТЕСТБАНК»");
  assert.equal(a.name, "ТОВ «ТЕСТОВА РОМАШКА»", "назва — скорочена з ялинками, як у ЄДР-гілці");
  assert.equal(a.ipn, "123456789012", "ІПН форми = ІПН платника ПДВ (`vat_number`), а не `inn`");
  assert.equal(a.addr, "м. Київ, вул. Тестова, 1");

  const bad = fromOneC("12345678", { ...LEGAL_1C, bank_account: "UA12 3456" });
  assert.equal(bad.iban, "", "🔴 рахунок не у форматі UA+27 цифр підставлено у форму");
  assert.equal(bad.bank, "", "банк без коректного рахунку — теж ні: пара йде разом");
  assert.equal(bad.ibanRaw, "UA123456", "некоректний рахунок мусить лишитись видимим — інакше «у 1С немає» збреше");

  assert.equal(fromOneC("12345678", { ...LEGAL_1C, name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ ВИРОБНИЧА КОМПАНІЯ"ТЕСТ"' }).name,
    "ТОВ ВИРОБНИЧА КОМПАНІЯ «ТЕСТ»", "🔴 лапка впритул до слова (так пише 1С) дала «КОМПАНІЯ»ТЕСТ»» у договорі");

  const f = fromOneC("1234567890", FOP_1C);
  assert.equal(f.isFop, true); assert.equal(f.edrpou, "1234567890");
  assert.equal(f.name, "ФОП Тестенко Марія Іванівна", "ПІБ ФОП не скорочується як назва юрособи");
  assert.equal(f.iban, ""); assert.equal(f.ibanRaw, ""); assert.equal(f.phone, "", "null у 1С → порожнє поле, а не «null»");
});

/** #1394b — зведення: директор з ЄДР, рахунок з 1С; довідник — лише запасний або видимою розбіжністю. */
test("#1394b ЗВЕДЕННЯ: директор і назва з ЄДР, рахунок з 1С, довідник — запас або видима розбіжність", () => {
  const one = fromOneC("12345678", LEGAL_1C);
  const m = mergeRequisites(one, REG, null);
  assert.equal(m.dir, "Директоренко Остап Петрович", "🔴 директор не з ЄДР — у 1С його немає, поле стало б ручним");
  assert.equal(m.name, "ТОВ «ТЕСТОВА РОМАШКА»");
  assert.equal(m.iban, IBAN_A); assert.equal(m.ibanSource, "1c");
  assert.equal(m.addr, "м. Київ, вул. Тестова, 1", "адреса — бухгалтерська, з 1С");
  assert.equal(m.phone, "+380440000000", "телефон — з 1С, ЄДР лише підстраховує");

  const conflict = mergeRequisites(one, REG, { iban: IBAN_B, bank: "Інший банк" });
  assert.equal(conflict.iban, IBAN_A, "🔴 при розбіжності підставлено не 1С (рішення Романа 06.10: 1С — куди підуть платежі)");
  assert.deepEqual(conflict.bookIban, { iban: IBAN_B, bank: "Інший банк" }, "🔴 довідниковий IBAN зник мовчки");
  assert.equal(mergeRequisites(one, REG, { iban: IBAN_A.replace(/(.{4})/g, "$1 "), bank: "x" }).bookIban, null,
    "той самий рахунок з пробілами — не розбіжність");

  const no1c = mergeRequisites(fromOneC("12345678", { ...LEGAL_1C, bank_account: null, bank_name: null }), REG, { iban: IBAN_B, bank: "Інший банк" });
  assert.equal(no1c.iban, IBAN_B); assert.equal(no1c.ibanSource, "book", "у 1С рахунку немає — довідник має підстрахувати");
  assert.equal(no1c.bookIban, null);

  const none = mergeRequisites(fromOneC("12345678", { ...LEGAL_1C, bank_account: "UA1" }), null, null);
  assert.equal(none.iban, ""); assert.equal(none.ibanSource, null); assert.equal(none.ibanInvalid1c, "UA1");
  assert.equal(none.dir, "", "без ЄДР директора не вигадуємо");
});

const okReg = async () => ({ kind: "ok" as const, card: REG, cached: false });
const ok1c = async (): Promise<OneCLookup> => ({ kind: "ok", card: fromOneC("12345678", LEGAL_1C) });

/** #1395 — порядок джерел і поведінка на збоях: збій 1С чи ЄДР не кладе автопідстановку. */
test("#1395 ПОРЯДОК: 1С → ЄДР → довідник; у 1С немає — як до 06.10; збій 1С лише підписується", async () => {
  let regCalls = 0;
  const reg = (r: () => Promise<any>) => async () => { regCalls++; return r(); };

  const a = await resolveRequisites("12345678", { oneC: ok1c, registry: reg(okReg), book: async () => null });
  assert.equal(a.kind, "json"); assert.equal((a as any).status, 200);
  assert.equal((a as any).body.source, "1c", "🔴 1С знайшла контрагента, а відповідь не з 1С");
  assert.equal((a as any).body.card.dir, "Директоренко Остап Петрович");
  assert.equal(regCalls, 1, "ЄДР потрібен для директора й стану");

  // ЄДР оновлюється — 1С-частину віддаємо одразу (200), а не 202 з порожнечею.
  const u = await resolveRequisites("12345678", { oneC: ok1c, registry: async () => ({ kind: "updating" as const }), book: async () => null });
  assert.equal((u as any).status, 200, "🔴 рахунок з 1С загубився, поки ЄДР оновлювався");
  assert.equal((u as any).body.registry, "updating"); assert.equal((u as any).body.card.iban, IBAN_A);

  // У 1С немає → рівно як було: довідник, ЄДР не питаємо (транзакція тарифу).
  regCalls = 0;
  const book = { id: 1, edrpou: "12345678", name: "З довідника", iban: IBAN_B, bank: "Б", director: "Д" };
  const b = await resolveRequisites("12345678", { oneC: async () => ({ kind: "notFound" }), registry: reg(okReg), book: async () => book });
  assert.equal((b as any).body.source, "book"); assert.equal((b as any).body.oneC, "notFound");
  assert.equal(regCalls, 0, "довідник знайшов — ЄДР не питаємо, як і до 06.10");

  // 1С лежить → довідника немає → ЄДР, 200, і збій 1С НАЗВАНО.
  const c = await resolveRequisites("12345678", { oneC: async () => ({ kind: "failed", why: "1С недоступна" }), registry: okReg, book: async () => null });
  assert.equal((c as any).status, 200, "🔴 збій 1С поклав автопідстановку");
  assert.equal((c as any).body.source, "youscore"); assert.equal((c as any).body.oneC, "failed");
  assert.equal((c as any).body.oneCWhy, "1С недоступна", "збій 1С мусить бути видимим, а не тихим «у 1С немає»");

  const d = await resolveRequisites("12345678", { oneC: async () => ({ kind: "failed", why: "1С не відповіла за 10 с" }), registry: async () => ({ kind: "notFound" as const }), book: async () => null });
  assert.equal(d.kind, "error"); assert.match((d as any).message, /1С не відповіла/, "у тексті відмови збій 1С не названо");
});

/** #1396 — запит до 1С: параметр за довжиною коду, «не знайдено» ≠ «збій», мережа не кидає назовні. */
test("#1396 ЗАПИТ ДО 1С: edrpou/inn за довжиною, state:false = немає, збій і таймаут = failed без винятку", async () => {
  const urls: string[] = [];
  const f = (status: number, body: unknown) => async (url: string) => { urls.push(url); return { status, json: async () => body }; };
  assert.equal((await lookup1c("12345678", { doFetch: f(200, LEGAL_1C), url: "http://x/ci" })).kind, "ok");
  assert.match(urls.at(-1)!, /\?edrpou=12345678$/);
  await lookup1c("1234567890", { doFetch: f(200, FOP_1C), url: "http://x/ci" });
  assert.match(urls.at(-1)!, /\?inn=1234567890$/, "🔴 ФОП шукається не за `inn` — 1С його за edrpou не знайде");
  assert.equal((await lookup1c("12345678", { doFetch: f(200, { state: false, message: "не знайдено" }), url: "u" })).kind, "notFound");
  const e500 = await lookup1c("12345678", { doFetch: f(500, null), url: "u" });
  assert.deepEqual(e500, { kind: "failed", why: "1С відповіла 500" }, "помилка 1С не має читатись як «контрагента немає»");
  const boom = await lookup1c("12345678", { doFetch: async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }, url: "u" });
  assert.deepEqual(boom, { kind: "failed", why: "1С не відповіла за 10 с" });
});

/**
 * #1397 — ЖИВА 1С: наш `lookup1c` + `fromOneC` проти справжнього `customerInfo` на кодах із дебіторки.
 * Червоніє, якщо 1С перейменує поле рахунку (ми тихо перестали б підставляти IBAN) або метод зникне.
 * 🔴 НЕ зареєстровано в дозволених прод-скіпах — навмисно, як `#124`: з прод-сервера 1С досяжна, і гейт,
 * що мовчить саме тоді, коли джерело лягло, був би декорацією. У `npm test` скіп законний (`needsApi`).
 */
test("#1397 ЖИВА 1С: customerInfo віддає поля, які ми розбираємо, і хоч один IBAN підставляється", { ...needsApi() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { rows } = await pool.query<{ e: string }>(
    `SELECT DISTINCT edrpou AS e FROM receivable_invoices WHERE edrpou ~ '^[0-9]{8}$' ORDER BY 1 LIMIT 20`);
  assert.ok(rows.length > 0, "у дебіторці немає жодного ЄДРПОУ — гейту нема на чому перевіряти");
  const res = await Promise.all(rows.map((r) => lookup1c(r.e)));
  const failed = res.filter((r) => r.kind === "failed");
  assert.equal(failed.length, 0, `1С не відповіла: ${JSON.stringify(failed[0])}`);
  const ok = res.filter((r): r is Extract<OneCLookup, { kind: "ok" }> => r.kind === "ok");
  assert.ok(ok.length > 0, `жодного з ${rows.length} кодів дебіторки 1С не знайшла — метод або параметр змінились`);
  assert.ok(ok.every((r) => r.card.name), "1С віддала контрагента без назви — поле `name` змінилось");
  assert.ok(ok.some((r) => r.card.iban), `🔴 у жодного з ${ok.length} знайдених IBAN не підставився — поле \`bank_account\` змінилось або формат`);
});

/**
 * #1398 — вибір ЦІЛОГО контрагента замінює реквізити, а не доповнює. Спіймано кліком на стенді 06.10.2026:
 * Фора (IBAN є) → «Хелл Енерджі» (у 1С рахунку немає) — підпис казав «впишіть IBAN вручну», а в полі стояв рахунок
 * Фори, бо `applyParsed` пропускає порожні значення. Межі — змістові: тіло кожного обробника від його `const` до
 * наступного `const` того ж рівня.
 */
test("#1398 ВИБІР КОНТРАГЕНТА ЗАМІНЮЄ РЕКВІЗИТИ: 1С, довідник і ЄДР не лишають полів попередньої компанії", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  const body = (name: string) => {
    const at = src.indexOf(`  const ${name} = `);
    assert.ok(at >= 0, `обробник ${name} зник — гейт нема на чому перевіряти`);
    const next = src.indexOf("\n  const ", at + 1);
    return src.slice(at, next < 0 ? undefined : next);
  };
  assert.match(src, /const replaceCp = \(cp: CtorCounterparty\) => setForm\(\(f\) => \(\{ \.\.\.f, cp: \{ \.\.\.cp \} \}\)\);/,
    "🔴 replaceCp більше не замінює контрагента цілком");
  for (const name of ["onPickBook", "onPickRegistry"]) {
    assert.match(body(name), /\breplaceCp\(/, `🔴 ${name} доповнює реквізити замість заміни — лишиться IBAN попередньої компанії`);
    assert.doesNotMatch(body(name), /\bapplyParsed\(/, `🔴 ${name} доповнює реквізити замість заміни`);
  }
  assert.match(body("onPickRegistry"), /iban: "", bank: ""/, "🔴 ЄДР рахунку не дає — поле має очищатись, а не лишати старе");
  assert.match(body("onPick1c"), /if \(refill\) \{ applyParsed\(cp, true\);[\s\S]{0,120}?\}\s*else \{ replaceCp\(cp\);/,
    "🔴 1С: перший вибір мусить замінювати, а повтор за директором — лише дописувати порожнє");
});

/** #1399 — мітки «1С / ЄДР / довідник» рахує сервер разом із вибором джерела: мітка = звідки РЕАЛЬНО взято значення. */
test("#1399 МІТКИ ДЖЕРЕЛА: кожне непорожнє поле має джерело, порожнє — ні, запасний IBAN — «довідник»", () => {
  const m = mergeRequisites(fromOneC("12345678", LEGAL_1C), REG, null);
  assert.deepEqual(m.src, { edrpou: "1c", name: "edr", ipn: "1c", addr: "1c", dir: "edr", phone: "1c", email: "1c", iban: "1c", bank: "1c" },
    "🔴 мітка не відповідає джерелу значення");
  const noReg = mergeRequisites(fromOneC("12345678", { ...LEGAL_1C, phones: null, bank_account: null, bank_name: null }), null, { iban: IBAN_B, bank: "Б", director: "Д" });
  assert.equal(noReg.src.name, "1c", "без ЄДР назва — з 1С, і мітка мусить це казати");
  assert.equal(noReg.src.dir, "book"); assert.equal(noReg.src.iban, "book"); assert.equal(noReg.src.bank, "book");
  assert.equal(noReg.src.phone, undefined, "🔴 порожнє поле з міткою — читалось би як «заповнено з 1С»");
  const none = mergeRequisites(fromOneC("12345678", { ...LEGAL_1C, bank_account: null, bank_name: null }), REG, null);
  assert.equal(none.src.iban, undefined); assert.equal(none.src.bank, undefined);
});

/**
 * #1399b — стан «шукаю»: вмикається ДО запиту й вимикається в `finally` (і на успіху, і на помилці — інакше кнопка
 * лишилась би заблокованою назавжди), кнопка заблокована, поки він іде. Межі — тіло `onEdr` від `const` до `const`.
 */
test("#1399b ПОШУК ВИДНО: «шукаю» вмикається до запиту, гасне в finally, кнопка заблокована під час пошуку", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  const at = src.indexOf("  const onEdr = "); assert.ok(at >= 0, "onEdr зник");
  const body = src.slice(at, src.indexOf("\n  const ", at + 1));
  const on = body.indexOf("setEdrBusy(true)"), call = body.indexOf("await ctorByEdrpou("), off = body.search(/finally \{ setEdrBusy\(false\); \}/);
  assert.ok(on >= 0 && call > on, "🔴 «шукаю» вмикається не ДО запиту — 3–4 с тиші, здається, що не спрацювало");
  assert.ok(off > call, "🔴 «шукаю» гасне не в finally — на помилці кнопка лишиться заблокованою");
  assert.match(src, /disabled=\{edrBusy \|\|[^\n]*\} onClick=\{\(\) => void onEdr\(\)\}>\s*\{edrBusy \? "⏳ Шукаю…" : "Підтягнути реквізити"\}/,
    "🔴 кнопка не блокується або не каже «Шукаю» під час пошуку");
  assert.match(src, /\{edrBusy && <div className="edrstat wait"/, "🔴 під полем не видно, що йде пошук");
});

/** #1399c — мітка показується, лише поки значення поля те саме, з яким вона прийшла: правка руками гасить її сама. */
test("#1399c МІТКА ГАСНЕ ВІД ПРАВКИ: показується лише поки значення поля = значенню, з яким прийшла", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "ConstructorSection.tsx"), "utf8");
  assert.match(src, /\{cpSrc\[k\] && cpSrc\[k\]!\.v === v && v\s*\?\s*<span className=\{`srctag src-\$\{cpSrc\[k\]!\.from\}`\}/,
    "🔴 мітка не привʼязана до значення — після правки руками поле лишилось би підписаним «1С»");
});
