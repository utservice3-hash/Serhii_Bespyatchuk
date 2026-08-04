import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, clientPhoneOf } from "./phone.js";

test("#26 НОРМАЛІЗАЦІЯ ТЕЛЕФОНУ — один вигляд із усіх форматів CRM", () => {
  const want = "380671234567";
  for (const raw of ["380671234567", "+380671234567", "+38 (067) 123-45-67",
                     "0671234567", "067 123 45 67", "671234567", "80671234567"]) {
    assert.equal(normalizePhone(raw), want, `«${raw}» має звестись до ${want}`);
  }
  // 🔴 НЕ ВГАДУЄМО. Коротке — це добавочний або сміття; повернути обрізок
  // означало б звʼязати дзвінок із ВИПАДКОВИМ клієнтом, і це виглядало б як дані.
  for (const bad of ["", null, undefined, "—", "1234", "101", "abc"]) {
    assert.equal(normalizePhone(bad as string), null, `«${bad}» не телефон`);
  }
  // Іноземні лишаємо як є: обрізати їх до українського вигляду = склеїти різних людей.
  assert.equal(normalizePhone("+48 501 234 567"), "48501234567");
});

test("#26b НОМЕР КЛІЄНТА: вхідні — caller, вихідні — dst", () => {
  // ⚠️ Заміряно на живому API: для `out` поле `caller` містить SIP-логін
  // («utsua…»), а не номер. Брати caller скрізь = звʼязати ВСІ вихідні
  // дзвінки з неіснуючим клієнтом.
  assert.equal(clientPhoneOf("in", "380671234567", null), "380671234567");
  assert.equal(clientPhoneOf("transitin", "380671234567", null), "380671234567");
  assert.equal(clientPhoneOf("out", "utsua_sip_login", "380951112233"), "380951112233");
  assert.equal(clientPhoneOf("transitout", "utsua_sip_login", "380951112233"), "380951112233");
  // ДЗЕРКАЛО: якби ми брали caller для вихідних — тут був би не null, а сміття.
  assert.equal(normalizePhone("utsua_sip_login"), null,
    "🔴 SIP-логін пройшов нормалізацію — тоді вихідні звʼязались би з фантомом");
});
