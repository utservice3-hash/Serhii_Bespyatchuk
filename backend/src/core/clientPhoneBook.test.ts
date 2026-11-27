import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_PHONE_BOOK_SQL, PHONE_BOOK_DAYS, PHONE_BOOK_MAX, phoneBookOf, type PhoneBookRow } from "./clientPhoneBook.js";

/**
 * ☎️ #11252 / #11254 — «НОМЕРИ КЛІЄНТА» В КАРТЦІ (задача 11223; Роман 27.11.2026: «давай записувати номери окремо, щоб
 * ми бачили всі номери клієнта постійного»).
 *
 * Твердження `#11252`: (1) номер і в контакті, і в картці компанії — ОДИН рядок із джерелом «контакт» і станом
 * `linked`, а назва компанії лишається довідкою; (2) номер лише з картки компанії — `unlinked`, бо привʼязку дзвінків
 * дає тільки контакт; (3) номер із довідника перевізників — `carrier`, яким би не було джерело; (4) «розмов» і
 * «зараховано клієнту» — два числа, і друге не підмінює перше; (5) зайві номери названі числом `more`, а не обрізані.
 * 🧨 Червоніє, якщо злити джерела в одне («company» завжди linked), рахувати спільність разом із самим клієнтом,
 * обрізати мовчки або підняти перевізника над номерами замовника.
 * Живий SQL — `#11253` у `routes/carrierPhones7359.test.ts` (там уже є кластер; другий заводити заборонено).
 */
const row = (phone: string, src: PhoneBookRow["src"], o: Partial<PhoneBookRow> = {}): PhoneBookRow => ({
  phone, src, contact_id: src === "contact" ? "7" : null, company_id: src === "company" ? "9" : null, company: src === "company" ? " ТОВ Приклад " : null,
  talks: 0, linked: 0, last_day: null, via_lardi: null, via_history: null, shared_n: null, ...o });

test("#11252 НОМЕРИ КЛІЄНТА: контакт сильніший за картку компанії; номер лише з картки — «не привʼязано»; перевізник підписаний; зайві — числом", () => {
  const A = "380670000001", B = "380670000002", C = "380670000003", D = "380670000004";
  const book = phoneBookOf([
    // A: і контакт, і картка компанії; порядок рядків як у запиті (company < contact за алфавітом джерела)
    row(A, "company", { talks: 4, linked: 4, last_day: "2026-11-20" }), row(A, "contact", { talks: 4, linked: 4, last_day: "2026-11-20" }),
    // B: лише картка компанії, розмови є, клієнту не зараховано жодної
    row(B, "company", { talks: 3, linked: 0, last_day: "2026-11-02" }),
    // C: контакт, але номер у довіднику перевізників; спільний із двома іншими клієнтами
    row(C, "contact", { talks: 9, linked: 9, via_lardi: true, via_history: false, shared_n: 3 }),
    // D: контакт без розмов
    row(D, "contact"),
  ]);
  assert.equal(book.total, 4, "🔴 номер із двох джерел порахований двічі або загубився");
  assert.deepEqual(book.phones.map((p) => p.phone), [A, D, B, C], "🔴 порядок: спершу номери, що дають клієнту розмови, перевізник останній");
  const [a, d, b, c] = book.phones;
  assert.deepEqual({ source: a.source, state: a.state, contactId: a.contactId, companyId: a.companyId, company: a.company },
    { source: "contact", state: "linked", contactId: 7, companyId: 9, company: "ТОВ Приклад" }, "🔴 номер із контакту й картки компанії подано не як «контакт»");
  assert.deepEqual({ source: b.source, state: b.state, talks: b.talks, linked: b.linked }, { source: "company", state: "unlinked", talks: 3, linked: 0 },
    "🔴 номер лише з картки компанії читається як привʼязаний — або «зараховано» підмінило «розмов»");
  assert.equal(c.state, "carrier", "🔴 номер перевізника не підписаний");
  assert.deepEqual(c.carrier, { lardi: true, history: false });
  assert.equal(c.sharedWith, 2, "🔴 «ще N клієнтів» рахує й самого клієнта");
  assert.deepEqual({ state: d.state, talks: d.talks, lastDay: d.lastDay, sharedWith: d.sharedWith, carrier: d.carrier },
    { state: "linked", talks: 0, lastDay: null, sharedWith: 0, carrier: null });
  // ключ фізособи — привʼязаний номер; разом із контактом лишається «контакт»
  assert.equal(phoneBookOf([row(A, "key")]).phones[0].state, "linked");
  assert.equal(phoneBookOf([row(A, "contact"), row(A, "key")]).phones[0].source, "contact");
  assert.equal(phoneBookOf([row(A, "company"), row(A, "key")]).phones[0].source, "key", "🔴 ключ фізособи слабший за картку компанії");

  // межа з обох боків: рівно MAX — без «ще», MAX + 3 — показано MAX і названо 3
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`38067${String(1000000 + i)}`, "contact", { linked: n - i, talks: n - i }));
  assert.equal(phoneBookOf(many(PHONE_BOOK_MAX)).more, 0, "🔴 «ще N» зʼявилось, хоча вмістились усі");
  const over = phoneBookOf(many(PHONE_BOOK_MAX + 3));
  assert.deepEqual([over.phones.length, over.more, over.total], [PHONE_BOOK_MAX, 3, PHONE_BOOK_MAX + 3], "🔴 зайві номери обрізано мовчки");
  assert.equal(over.phones[0].linked, PHONE_BOOK_MAX + 3, "🔴 обрізано не хвіст, а номери з розмовами");
  assert.deepEqual(phoneBookOf([]), { phones: [], more: 0, total: 0 });
});

const ROUTE = fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url));
const FE = (f: string): string => fileURLToPath(new URL(`../../../frontend/src/pages/dashboard/sections/${f}`, import.meta.url));

test("#11254 НОМЕРИ КЛІЄНТА ПРОВЕДЕНІ: роут картки віддає `phones`, адреса за джерелом, картка малює блок, порожній блок не малюється", () => {
  // запит: канонічний ключ, вікно по-київськи з обома кінцями, «зараховано» = дзвінок саме цього клієнта
  assert.match(CLIENT_PHONE_BOOK_SQL, /WHERE d\.client_key = \$1/);
  assert.match(CLIENT_PHONE_BOOK_SQL, /rc\.billsec > 0 AND rc\.client_key = \$1/, "🔴 «зараховано клієнту» рахує чужі розмови на номері");
  assert.ok(CLIENT_PHONE_BOOK_SQL.includes(`(now() AT TIME ZONE 'Europe/Kyiv')::date - ${String(PHONE_BOOK_DAYS - 1)}`),
    "🔴 вікно розмов не по-київськи або не дорівнює оголошеному числу днів");

  const route = readFileSync(ROUTE, "utf8");
  const card = route.slice(route.indexOf('dashboardRouter.get("/client-card"'));
  const body = card.slice(0, card.indexOf("\ndashboardRouter.", 10));
  assert.match(body, /await clientPhoneBook\(pool as unknown as LedgerDb, clientKey\)/, "🔴 роут картки не кличе clientPhoneBook");
  assert.match(body, /days: PHONE_BOOK_DAYS, total: phoneBook\.total, more: phoneBook\.more/, "🔴 вікно або «ще N» не доходить до екрана");
  assert.match(body, /p\.source === "company" \? \(p\.companyId != null \? kommoCompanyUrl\(p\.companyId\) : null\)\s*: p\.contactId != null \? kommoContactUrl\(p\.contactId\) : null/,
    "🔴 адреса номера будується не за джерелом (картка компанії / контакт)");

  const panel = readFileSync(FE("ClientCardPanel.tsx"), "utf8");
  assert.match(panel, /<ClientPhonesBlock card=\{card\} \/>/, "🔴 картка клієнта не малює блок номерів");
  const block = readFileSync(FE("ClientPhonesBlock.tsx"), "utf8");
  assert.match(block, /if \(!b \|\| b\.list\.length === 0\) return null;/, "🔴 без номерів блок малює порожню рамку");
  assert.match(block, /клієнту зараховано \{p\.linked\}/, "🔴 «зараховано клієнту» на екрані не показано — номер із картки компанії читається як робочий");
  assert.match(block, /b\.more > 0/, "🔴 «ще N» на екрані не показано");
  assert.match(block, /target="_blank" rel="noreferrer"/, "🔴 посилання відкривається в тій самій вкладці й зносить дашборд");
});
