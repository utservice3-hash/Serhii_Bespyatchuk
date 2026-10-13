/**
 * 🚚 «ПЕРЕВІЗНИК» ЗА LARDI (рішення Романа 13.10.2026: «ларді 100% розпізнає перевізника, це має бути на рівні відсіву
 * історії crm»; «без запобіжника»). Номер дзвінка на мобільні є серед контактів пропозицій МАШИН (`side='lorry'`) в
 * архіві Lardi → вердикт «перевізник» без розпізнавання й без AI, тим самим шляхом, що й історія CRM
 * (`core/carrierHistory.ts`): той самий перемикач закриття (`CARRIER_HISTORY_CLOSE`), той самий тег.
 *
 * 🔴 ЗАПОБІЖНИКА «Є УГОДА ЗАМОВНИКА» ТУТ НЕМАЄ — свідомо, рішенням Романа. Заміряно перед рішенням (14 днів до 13.10):
 * 40 розпізнаних угод із номерами з машин Lardi — 33 AI назвав перевізником, 3 «не впевнений», 1 «інше», 3 «клієнт»
 * (запити на перевезення від тих, хто також розміщує машини); угод замовника в жодного з 40 не було, тобто запобіжник
 * не врятував би й цих трьох.
 *
 * Номер звіряємо за ОСТАННІМИ 9 ЦИФРАМИ (Lardi пише «+380…», телефонія — «380…»). Пропозицію «вантажу» (`cargo`) не
 * беремо: там і замовники, і експедитори.
 * Форма запиту — хеш-з'єднання по розгорнутих телефонах: 174 мс на 150 тис. машин (заміряно 13.10.2026); варіант
 * «EXISTS по jsonb на кожну пропозицію» йшов 137 с.
 */
export const LARDI_SIDE = "lorry";

/** Останні 9 цифр номера — SQL-вираз. Той самий для обох боків звірки, інакше «+380…» і «380…» не зійдуться. */
export const PHONE9 = (expr: string): string => `right(regexp_replace(${expr}, '\\D', '', 'g'), 9)`;

/**
 * SQL (CTE-тіло): по одному рядку на угоду `carrier_call_deals` у стані `waiting`, чий номер є серед машин Lardi, —
 * `kommo_id` і `note` (компанія · маршрут найсвіжішої пропозиції) для підпису й примітки в CRM.
 */
export const LARDI_MATCH_SQL = `
  WITH w AS (SELECT kommo_id, ${PHONE9("phone")} AS p9 FROM carrier_call_deals WHERE state = 'waiting'),
  lp AS (SELECT ${PHONE9("p->>'n'")} AS p9, o.company, o.frm, o.tox, o.first_seen
           FROM lardi_offers o, jsonb_array_elements(o.phones) p WHERE o.side = '${LARDI_SIDE}')
  SELECT DISTINCT ON (w.kommo_id) w.kommo_id,
         left(concat_ws(' · ', NULLIF(lp.company, ''), NULLIF(concat_ws(' → ', NULLIF(lp.frm, ''), NULLIF(lp.tox, '')), '')), 200) AS note
    FROM w JOIN lp USING (p9)
   ORDER BY w.kommo_id, lp.first_seen DESC`;

/** Примітка в CRM для угоди, закритої за Lardi. */
export const lardiCloseNote = (note: string | null): string =>
  `Закрито дашбордом: номер є на Lardi серед пропозицій машин${note ? ` (${note})` : ""}. Тег «авто-перевізник», джерело: Lardi. `
  + "Помилка — поверніть угоду на етап у вкладці «Перевізники за розмовою».";
