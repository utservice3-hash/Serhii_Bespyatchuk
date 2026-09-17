/**
 * 🔗 SQL ЗВʼЯЗУВАННЯ ДЗВІНКІВ — чисті будівники, без `pool`.
 *
 * Доти обидва запити жили літералами всередині `linkCalls` і завжди проходили ВСЮ таблицю
 * `ringostat_calls` (467+ тис. рядків): перший агрегує всі телефони контактів через угоди,
 * другий ганяє регулярку по ПІБ кожного рядка. Для годинного синку це прийнятно. Для
 * частого (сигнал менеджеру за 5 хв, ТЗ-1) — ні: два повні проходи щопʼять хвилин на тій
 * самій таблиці, де вже ловили дедлок на читанні, і з витратою compute-квоти Neon.
 *
 * Тому межа `since`: без неї рядок БАЙТ-У-БАЙТ той самий, що стояв у `linkCalls` (годинний
 * прохід не змінюється — доведено виконанням шаблону з git), з нею — звʼязується лише
 * свіже вікно за індексом `idx_rc_calldate`.
 */
export interface LinkSql { sql: string; params: unknown[] }

const withBound = (since?: Date): { bound: string; params: unknown[] } =>
  since ? { bound: " AND rc.calldate >= $1", params: [since] } : { bound: "", params: [] };

/** Клієнт за номером телефону. */
export function linkByPhoneSql(since?: Date): LinkSql {
  const { bound, params } = withBound(since);
  return { sql: `UPDATE ringostat_calls rc SET client_key = m.ck
       FROM (
         SELECT cp.phone, (array_agg(d.client_key ORDER BY d.closed_at_kommo DESC NULLS LAST))[1] AS ck
           FROM contact_phones cp
           JOIN deal_contacts dc ON dc.contact_id = cp.contact_id
           JOIN deals d ON d.kommo_id = dc.deal_kommo_id AND d.client_key IS NOT NULL
          GROUP BY cp.phone
       ) m
      WHERE rc.client_phone = m.phone AND rc.client_key IS DISTINCT FROM m.ck${bound}`, params };
}

// 🔴 ПІБ ЗБІГАЄТЬСЯ НЕ ДОСЛІВНО. Ringostat віддає ПОВНЕ ПІБ («Крицька Діана
// Геннадіївна»), а `managers.name` буває і коротким («Крицька Діана»), і повним.
// Точний збіг дав би нуль мапінгів і тихо перетворив би ВСІ дзвінки на
// «менеджер невідомий». Правило те саме, що в агрегаті «Статистик»
// (`resolveLead`): прізвище+імʼя без пробілів, з нормалізацією апострофа.
//
// 🔴 КЛЮЧ ЗРІЗАЄТЬСЯ З ОБОХ БОКІВ (фікс 04.08.2026, заміряно). Було: ПІБ дзвінка
// різався до двох слів, а `managers.name` порівнювалось ЦІЛИМ. Для менеджерів із
// тричленним імʼям у базі (55 записів, з них 19 активних) ключі не сходились
// НІКОЛИ — «Демчук Вікторія Олександрівна» ≠ «демчуквікторія». Наслідок:
// 111 366 дзвінків (26.8% усіх) належали АКТИВНИМ менеджерам і тихо лишались
// «менеджер невідомий». Симптом виглядав як «цих людей немає в managers»,
// хоча вони там були — асиметрія ховала сама себе.
//
// 🟢 ЗВІЛЬНЕНИМ ПРИПИСУЄМО (рішення власника 04.08.2026): «дзвонила конкретна
//    людина (звільнена)» корисніше за «невідомо» — історія має казати правду.
//    Тому фільтра `is_active` тут НЕМА.
//    ⚠️ Це НЕ відкриває деактивованих на екранах ОЦІНКИ: там свій фільтр, і він
//    працює (перевірено поведінкою 04.08.2026 — деактивована «Мельник Лілія» з
//    7 виграними угодами за 90 днів не зʼявляється ні в `successByMgr`, ні в
//    `stuckDealsGrouped`). Звʼязка дзвінка — це ІСТОРІЯ, а не рейтинг.
//    ⚠️ Хто показує історію дзвінків — МУСИТЬ підписати звільненого звільненим,
//    інакше він читається як діючий. Екрана дзвінків ще немає; вимога записана
//    в docs/RINGOSTAT_CALLS.md, щоб не загубилась.
//
// 🔒 ДУБЛІ КЛЮЧА — БЕРЕМО АКТИВНОГО, і це НЕ здогад: серед активних менеджерів
// однакових ключів НУЛЬ (заміряно), а всі 8 колізій — це та сама людина двома
// рядками (активний + деактивований). Після зняття фільтра `is_active` цей
// пріоритет став ОБОВʼЯЗКОВИМ, а не запобіжним: тепер обидва рядки в вибірці. Якби колись зʼявились двоє РІЗНИХ
// активних із однаковим прізвище+імʼя — `DISTINCT ON` узяв би меншший id, тож
// цей випадок стереже тест #27c: він має впасти, а не мовчки вгадати.
export function linkByFioSql(since?: Date): LinkSql {
  const { bound, params } = withBound(since);
  return { sql: `UPDATE ringostat_calls rc SET manager_id = mm.id
       FROM (
         SELECT DISTINCT ON (k) id, k FROM (
           SELECT id, is_active,
                  regexp_replace(lower(translate(
                    (regexp_split_to_array(btrim(name), '\\s+'))[1] || ' ' ||
                    COALESCE((regexp_split_to_array(btrim(name), '\\s+'))[2], ''),
                    'ʼ’\`', '')), '\\s+', '', 'g') AS k
             FROM managers   -- 🟢 включно з деактивованими (рішення власника 04.08.2026)
         ) x ORDER BY k, is_active DESC, id
       ) mm
      WHERE rc.employee_fio IS NOT NULL
        AND mm.k = regexp_replace(
              lower(translate(
                (regexp_split_to_array(btrim(rc.employee_fio), '\\s+'))[1] || ' ' ||
                COALESCE((regexp_split_to_array(btrim(rc.employee_fio), '\\s+'))[2], ''),
                'ʼ’\`', '')), '\\s+', '', 'g')
        AND rc.manager_id IS DISTINCT FROM mm.id${bound}`, params };
}
