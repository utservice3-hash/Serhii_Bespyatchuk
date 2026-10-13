import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasRealPhone, shouldDeclineUnsorted, phonesOfUnsorted, MIN_PHONE_DIGITS, declinedRowOf } from "./kommoSpamRules.js";

/**
 * #703 — СПАМ-ПРАВИЛО ПО ОБИДВА БОКИ: форма без телефону → відхилити; форма з телефоном → лишити;
 * сентинел «Неизвестен» не є телефоном; 6 цифр не телефон, 7 — телефон; SIP і пошта без телефону
 * НЕ відхиляються ніколи. Червоніє, якщо зняти умову category або визнати сентинел номером.
 */
test("#703 спам-заявки: лише форми без справжнього телефону; SIP/пошта недоторкані", () => {
  assert.equal(shouldDeclineUnsorted({ category: "forms", phones: [] }), true);
  assert.equal(shouldDeclineUnsorted({ category: "forms", phones: ["Неизвестен"] }), true, "сентинел — не телефон");
  assert.equal(shouldDeclineUnsorted({ category: "forms", phones: ["+380 67 123 45 67"] }), false, "🪞 з телефоном лишається");
  assert.equal(shouldDeclineUnsorted({ category: "sip", phones: [] }), false, "🪞 пропущений дзвінок без телефону — не чіпаємо");
  assert.equal(shouldDeclineUnsorted({ category: "mail", phones: [] }), false, "🪞 пошта — не чіпаємо");
  assert.equal(hasRealPhone(["123456"]), false, `${MIN_PHONE_DIGITS - 1} цифр — не телефон`);
  assert.equal(hasRealPhone(["1234567"]), true);
  assert.equal(hasRealPhone([null, "", "unknown", "0501112233"]), true, "один справжній серед сміття");
  assert.deepEqual(phonesOfUnsorted({ _embedded: { contacts: [{ custom_fields_values: [{ field_code: "EMAIL", values: [{ value: "a@b" }] }, { field_code: "PHONE", values: [{ value: "0501112233" }, { value: 380 }] }] }] } }), ["0501112233", "380"]);
  assert.deepEqual(phonesOfUnsorted({}), []);
});

/**
 * #1644 — ДЖОБУ ВИМКНЕНО (13.10.2026): `declineSpamForms` не кличеться з `index.ts` і не стоїть у `MONITORED_JOBS`.
 * Вона відхиляла всі заявки з форми: список «Нерозібраного» віддає контакт без телефону. Червоніє, якщо повернути
 * виклик у розклад, не прибравши цього гейта свідомо разом із фіксом підтягування контакту.
 */
test("#1644 declineSpamForms ВИМКНЕНО: не в розкладі й не в моніторі, доки контакт не підтягується окремо", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const idx = readFileSync(path.join(src, "index.ts"), "utf8");
  assert.doesNotMatch(idx, /declineSpamForms\(/, "🔴 джоба знову в розкладі — вона відхиляє живі заявки");
  assert.doesNotMatch(readFileSync(path.join(src, "jobs", "monitoredJobs.ts"), "utf8"), /"declineSpamForms"/, "🔴 вимкнена джоба в моніторі дасть вічну тривогу");
  // 🪞 дзеркало: сусіди в розкладі лишились — гейт не задовольняється порожнім файлом
  assert.match(idx, /runJob\("syncKommo"/);
});

/**
 * #1362 — РЯДОК ЖУРНАЛУ ПО ОБИДВА БОКИ: з повної заявки — форма, сторінка, IP, імʼя, пошта, час приходу;
 * з голої заявки — null у кожному полі без падіння; без uid — null (писати нікуди). Червоніє, якщо
 * загубити поле або дати впасти на заявці без контакту.
 */
test("#1362 declinedRowOf: повна заявка → усі поля, гола → null-поля, без uid → null", () => {
  const full = declinedRowOf({
    uid: "abc", created_at: 1759650000,
    metadata: { form_name: "Форма на сайте", form_page: "https://uts.ua/", ip: "194.207.171.115" },
    _embedded: { contacts: [{ name: " Неизвестно ", custom_fields_values: [{ field_code: "PHONE", values: [{ value: "Неизвестен" }] }, { field_code: "EMAIL", values: [{ value: "x@y.z" }] }] }] },
  });
  assert.deepEqual(full, { uid: "abc", receivedAt: new Date(1759650000 * 1000), formName: "Форма на сайте",
    formPage: "https://uts.ua/", ip: "194.207.171.115", contactName: "Неизвестно", email: "x@y.z" });
  assert.deepEqual(declinedRowOf({ uid: "bare" }), { uid: "bare", receivedAt: null, formName: null, formPage: null, ip: null, contactName: null, email: null }, "🪞 гола заявка не падає");
  assert.equal(declinedRowOf({ metadata: { ip: "1.1.1.1" } }), null, "без uid писати нікуди");
  assert.equal(declinedRowOf(null), null);
});

/**
 * #1362b — ЖУРНАЛ ДО ВІДХИЛЕННЯ: INSERT у `kommo_declined_forms` стоїть у тілі циклу ПЕРЕД `kommoDelete`, і його
 * помилка робить `continue` (заявку не відхиляємо). Межі — змістові: тіло циклу по `targets.slice`. Червоніє, якщо
 * переставити запис після видалення або ковтнути помилку запису.
 */
test("#1362b declineSpamForms: заявка лягає в журнал ДО відхилення; не записалась — не відхиляється", () => {
  const j = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "jobs", "declineSpamForms.ts"), "utf8");
  const loop = j.slice(j.indexOf("of targets.slice(0, DECLINE_CAP_PER_TICK)"));
  const ins = loop.indexOf("INSERT INTO kommo_declined_forms"), del = loop.indexOf("kommoDelete(");
  assert.ok(ins > 0 && del > 0, "у циклі немає запису в журнал або відхилення");
  assert.ok(ins < del, "🔴 запис у журнал після відхилення — заявка зникне без сліду");
  const between = loop.slice(ins, del);
  assert.match(between, /catch \(e\) \{[^}]*continue; \}/, "🔴 помилка запису не обриває відхилення");
});

/**
 * #1362c — ЖУРНАЛ ЗАКРИТО ВІД AI: REVOKE нижче за CREATE і нижче за загальний GRANT; таблиця у `FORBIDDEN_TABLES`.
 * Червоніє, якщо прибрати REVOKE, поставити його вище GRANT або забути заборону застосунку.
 */
test("#1362c kommo_declined_forms: REVOKE від ai_readonly після CREATE і GRANT, є у FORBIDDEN_TABLES", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const sql = readFileSync(path.join(src, "db", "schema.sql"), "utf8");
  const rev = sql.indexOf("REVOKE ALL ON kommo_declined_forms FROM ai_readonly;");
  assert.ok(rev > sql.indexOf("CREATE TABLE IF NOT EXISTS kommo_declined_forms ("), "🔴 REVOKE немає або вище за CREATE");
  assert.ok(rev > sql.indexOf("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;"), "🔴 REVOKE вище за GRANT — GRANT поверне доступ");
  assert.match(readFileSync(path.join(src, "ai", "metricTools.ts"), "utf8"), /"kommo_declined_forms",/, "🔴 немає у FORBIDDEN_TABLES");
});
