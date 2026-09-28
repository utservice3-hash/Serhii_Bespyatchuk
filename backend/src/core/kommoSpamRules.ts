/**
 * 🛡 СПАМ-ЗАЯВКИ З ФОРМИ САЙТУ — чисте правило, нуль імпортів.
 *
 * 📐 Дві атаки на «Форму на сайте» (Kommo form_id 1, сторінка uts.ua): 22.09 19:05 – 23.09 10:05 —
 * 447 заявок рівномірно по ~30/год, і 23.09 15:17 – 17:09 — 8 з однієї адреси 194.207.171.115.
 * У всіх контакт «Неизвестно», телефон «Неизвестен» або порожній. Живі заявки з тієї ж форми
 * телефон мають (49 за тиждень до атаки).
 *
 * ПРАВИЛО (слово Романа 23.09.2026): заявка з ФОРМИ у «Нерозібраному» без справжнього телефону
 * відхиляється. Лише category=forms — SIP (пропущені дзвінки) і пошта не чіпаються ніколи.
 * «Справжній телефон» = хоч один номер із ≥ 7 цифр, який не є сентинелом «Неизвест…/Невідом…».
 * ⚠️ Заявка лише з email без телефону теж потрапляє під правило — це свідома межа, названа
 * власнику; бот жодного разу не лишив email, а людина з email без телефону в атаці не траплялась.
 */
export interface UnsortedLike {
  category?: string | null;
  phones: (string | null | undefined)[];
}
const SENTINEL = /неизв|невідом|unknown/i;
export const MIN_PHONE_DIGITS = 7;

export function hasRealPhone(phones: (string | null | undefined)[]): boolean {
  return phones.some((p) => {
    const t = String(p ?? "").trim();
    if (!t || SENTINEL.test(t)) return false;
    return t.replace(/\D/g, "").length >= MIN_PHONE_DIGITS;
  });
}

/** Відхиляти = форма І без справжнього телефону. Все інше — лишати. */
export function shouldDeclineUnsorted(u: UnsortedLike): boolean {
  return u.category === "forms" && !hasRealPhone(u.phones);
}

/** Телефони з вкладених контактів відповіді Kommo `/leads/unsorted` (поле PHONE у custom_fields_values). */
export function phonesOfUnsorted(raw: { _embedded?: { contacts?: { custom_fields_values?: { field_code?: string | null; values?: { value?: unknown }[] }[] | null }[] } }): string[] {
  const out: string[] = [];
  for (const c of raw._embedded?.contacts ?? [])
    for (const f of c.custom_fields_values ?? [])
      if (f.field_code === "PHONE") for (const v of f.values ?? []) if (v.value != null) out.push(String(v.value));
  return out;
}
