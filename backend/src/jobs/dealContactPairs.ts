/**
 * 🔗 ДЕДУП ПАР (угода, контакт) ПЕРЕД ВСТАВКОЮ — БЕЗ імпортів.
 *
 * 🔴 ІНЦИДЕНТ 03.08.2026. `syncKommo` падав із «ON CONFLICT DO UPDATE command cannot
 * affect row a second time» в `upsertDealContacts`. Postgres не дозволяє одному
 * `INSERT ... ON CONFLICT DO UPDATE` зачепити ОДИН рядок двічі — а саме це стається,
 * коли в масиві є дві однакові пари.
 *
 * 🔴 ПРИЧИНА — НЕ ТА, ЩО ЗДАВАЛАСЬ. Перша гіпотеза: «угода в Kommo несе той самий
 * контакт двічі». Замір її СПРОСТУВАВ: 748 угод вікна, дублів усередині угоди — 0.
 * Справжнє джерело — НАШ код: `fetchAllDeals` тягне сторінки ПАРАЛЕЛЬНО
 * (PAGE_FETCH_CONCURRENCY = 3), а `filter[updated_at][from]` + пагінація не дають
 * стабільного знімка: угода, яку оновили між запитами сусідніх сторінок, зсувається
 * і потрапляє у ДВІ сторінки одразу. Тоді дублюється не контакт, а САМА УГОДА — і
 * кожна її пара (deal, contact) їде у вставку двічі.
 *
 * Тому дедуп стоїть у ДВОХ місцях, і це не перестраховка:
 *   • тут, по парах — рятує від будь-якого джерела дублікатів, включно з тим, якого
 *     ми ще не бачили (наприклад, якщо Kommo колись таки віддасть контакт двічі);
 *   • у `fetchAllDeals`, по id угоди — прибирає причину, а не наслідок.
 *
 * ⚠️ Ігнорувати помилку (`ON CONFLICT DO NOTHING`) було б гірше: тоді `is_main`
 * перестав би оновлюватись, і зміна головного контакта тихо не доїжджала б.
 */

export interface DealContactPair { dealId: number; contactId: number; isMain: boolean }

/**
 * Останній запис у списку перемагає: у межах одного проходу пізніша сторінка —
 * свіжіший знімок угоди, тож саме її `is_main` і має лягти.
 */
export function dedupeDealContactPairs(pairs: DealContactPair[]): DealContactPair[] {
  const byKey = new Map<string, DealContactPair>();
  for (const p of pairs) byKey.set(`${p.dealId}|${p.contactId}`, p);
  return [...byKey.values()];
}

/** Дедуп сутностей за числовим id зі збереженням ОСТАННЬОГО входження. */
export function dedupeById<T extends { id: number }>(items: T[]): T[] {
  const byId = new Map<number, T>();
  for (const it of items) byId.set(it.id, it);
  return [...byId.values()];
}
