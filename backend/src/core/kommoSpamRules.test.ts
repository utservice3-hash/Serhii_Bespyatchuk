import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasRealPhone, shouldDeclineUnsorted, phonesOfUnsorted, MIN_PHONE_DIGITS } from "./kommoSpamRules.js";

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
 * #703b — ПРОВОДКА: джоба читає ЛИШЕ category=forms, відхиляє через чисте правило, має стелю на тік
 * і повертає числа; крон кожні 10 хв під паузою Kommo; джоба в MONITORED_JOBS з everyMin 10.
 * Червоніє, якщо прибрати фільтр форм із запиту, обійти правило або зняти з монітора.
 */
test("#703b declineSpamForms: лише forms, через shouldDeclineUnsorted, стеля, крон під паузою, у моніторі", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const j = readFileSync(path.join(src, "jobs", "declineSpamForms.ts"), "utf8");
  assert.match(j, /\/api\/v4\/leads\/unsorted\?filter\[category\]\[\]=forms/, "запит без фільтра форм зачепив би SIP");
  assert.match(j, /\bshouldDeclineUnsorted\(/);
  assert.match(j, /targets\.slice\(0, DECLINE_CAP_PER_TICK\)/, "без стелі на тік");
  assert.match(j, /\/decline`\)/, "відхилення не через decline");
  const idx = readFileSync(path.join(src, "index.ts"), "utf8");
  const i = idx.indexOf('runJob("declineSpamForms"'); assert.ok(i > 0, "джоба не в розкладі");
  const block = idx.slice(idx.lastIndexOf("cron.schedule(", i), i);
  assert.match(block, /cron\.schedule\("4,14,24,34,44,54 \* \* \* \*"/, "не раз на 10 хв, або знову на :00/:30");
  assert.match(block, /isKommoPaused\(\)/, "пише в Kommo повз паузу кола");
  assert.match(readFileSync(path.join(src, "jobs", "monitoredJobs.ts"), "utf8"), /name: "declineSpamForms", everyMin: 10/);
});
