/**
 * ☎️ НОРМАЛІЗАЦІЯ ТЕЛЕФОНУ — ОДНА функція на весь проєкт. БЕЗ імпортів.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ І ЧОМУ БЕЗ ІМПОРТІВ. Номер нормалізують ДВА різні
 * шляхи: синк дзвінків (Ringostat віддає `caller`/`dst`) і бекфіл контактів
 * (Kommo віддає custom-поле «Телефон» у довільному форматі). Якщо кожен
 * нормалізує «схоже», звʼязка номер→клієнт розсиплеться тихо: дзвінок просто
 * не знайде клієнта, і це виглядатиме як «дзвінка не було», а не як баг.
 *
 * Ми вже проходили це з `normalizeClientName`: 16 із 94 ключів у чеклістах не
 * зіставлялись, бо писались іншою редакцією тієї самої логіки.
 *
 * Файл без імпортів — щоб його можна було тестувати БЕЗ бази (`db/pool.js` →
 * `config.js` кидає на відсутньому DATABASE_URL ще на імпорті).
 */

/**
 * До канонічного українського вигляду `380XXXXXXXXX`.
 *
 * Повертає `null`, якщо номер не схожий на телефон, — і це НЕ помилка, а
 * чесний результат: у CRM трапляються «—», внутрішні добавочні, сміття.
 * Мовчазне повернення обрізка було б гірше: воно створило б звʼязок із
 * випадковим клієнтом.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // 380XXXXXXXXX — уже канонічний
  if (digits.length === 12 && digits.startsWith("380")) return digits;
  // 0XXXXXXXXX → 380XXXXXXXXX
  if (digits.length === 10 && digits.startsWith("0")) return "38" + digits;
  // XXXXXXXXX (без нуля) → 380XXXXXXXXX
  if (digits.length === 9) return "380" + digits;
  // 80XXXXXXXXX — старий формат із 8
  if (digits.length === 11 && digits.startsWith("80")) return "3" + digits;

  // Іноземні номери лишаємо як є (тільки цифри), якщо довжина правдоподібна:
  // клієнти з Польщі/Литви існують — обрізати їх до українського вигляду
  // означало б склеїти різних людей.
  if (digits.length >= 10 && digits.length <= 15) return digits;

  // Коротше за 10 цифр — це добавочний, внутрішній або сміття. НЕ вгадуємо.
  return null;
}

/** Номер КЛІЄНТА у дзвінку Ringostat: для вхідних — `caller`, для вихідних — `dst`. */
export function clientPhoneOf(callType: string | null | undefined,
                              caller: string | null | undefined,
                              dst: string | null | undefined): string | null {
  // ⚠️ Заміряно 03.08.2026: для `out` поле `caller` містить SIP-логін («utsua…»),
  // а НЕ номер. Брати `caller` для всіх напрямків означало б звʼязати всі
  // вихідні дзвінки з неіснуючим клієнтом.
  const isOutgoing = callType === "out" || callType === "transitout";
  return normalizePhone(isOutgoing ? dst : caller);
}
