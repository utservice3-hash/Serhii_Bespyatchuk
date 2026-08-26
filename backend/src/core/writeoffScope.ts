/**
 * 🗑 СПИСАНИЙ БОРГ ВИХОДИТЬ І З ОЧІКУВАНИХ КОШТІВ — ЄДИНИЙ ВИРАЗ НА ВСІ ЕКРАНИ.
 *
 * 🔴 РІШЕННЯ ВЛАСНИКА 26.08.2026, І ВОНО НЕ ОЧЕВИДНЕ — ЗАПИСУЮ ЦІНУ.
 *
 * Дебіторка й «очікувані кошти» — РІЗНІ ВСЕСВІТИ: перша це залишок боргу з 1С,
 * другі рахуються `FROM deals` по стадіях CRM. Заміряно 26.08.2026: жодна з
 * пʼяти функцій очікуваних (`expectedZoneByScope`, `expectedPaymentsByPlanned`,
 * `expectedByManagerDay`, `expectedByPlannedBucket`, `awaitingNowSnapshot`) не
 * читає таблиць дебіторки взагалі. Тому списання рахунка САМО ПО СОБІ не могло
 * зменшити очікувані — їх ніщо не зв'язувало.
 *
 * 🔴 І ВЕЛИЧИНИ РІЗНІ, ЦЕ ТРЕБА ЗНАТИ НАПЕРЕД. За 266 угодами, що стоять у
 * `EXPECT_ZONE` і мають борг, борг 1С = 8 632 419 ₴, а їхній внесок в очікувані
 * = 754 172 ₴ (це `d.price`, тобто МАРЖА). Різниця в 11 разів. Тому «списали
 * рахунок на 169 000 ₴ — очікувані впали на 169 000 ₴» НЕМОЖЛИВО арифметично:
 * впаде маржа угоди, тобто ≈11 000 ₴. Власник це прийняв свідомо.
 *
 * 🔴 УМОВА — ВСІ РАХУНКИ УГОДИ, А НЕ ОДИН. Угода лишається в очікуваних, поки
 * за нею є хоч один несписаний рахунок: інакше списання однієї копійки з десяти
 * рахунків вимикало б усю угоду.
 *
 * 🔴 `NOT EXISTS`, А НЕ `NOT IN`. `NOT IN` з NULL у підзапиті виключає ВСЕ —
 * та сама NULL-пастка, що вже двічі коштувала нам замірів (`traf_type`, `CHECK`
 * з `IN`). Тут вона вимкнула б очікувані ЦІЛКОМ і виглядала б як «списали все».
 */

/** Угоди, у яких СПИСАНІ ВСІ рахунки. Ключ списання — сирий ключ клієнта + номер. */
export const FULLY_WRITTEN_OFF_DEALS = `
  SELECT dl.deal_id
    FROM (
      SELECT NULLIF(regexp_replace(COALESCE(ri.service_url, ''), '^.*/', ''), '')::bigint AS deal_id,
             COALESCE(ri.client_key_raw, ri.client_key) AS ck,
             COALESCE(ri.invoice_no, '')                AS ino
        FROM receivable_invoices ri
    ) dl
   WHERE dl.deal_id IS NOT NULL
   GROUP BY dl.deal_id
  HAVING count(*) = count(*) FILTER (
           WHERE EXISTS (SELECT 1 FROM receivable_writeoffs w
                          WHERE w.client_key_raw = dl.ck
                            AND w.invoice_no = dl.ino
                            AND w.revoked_at IS NULL))`;

/**
 * Предикат для будь-якого запиту, що рахує очікувані кошти `FROM deals d`.
 *
 * Параметрів не має навмисно: усі пʼять функцій нумерують `$N` по-своєму, і
 * спільний фрагмент із власним `$` розсипався б на першому ж переносі. Тут лише
 * імена таблиць, тож вставляти його можна куди завгодно.
 */
export const DEAL_NOT_WRITTEN_OFF =
  `NOT EXISTS (SELECT 1 FROM (${FULLY_WRITTEN_OFF_DEALS}) wo WHERE wo.deal_id = d.kommo_id)`;

/**
 * 🔴 ЛІЧИЛЬНИК РОЗБІЖНОСТІ З CRM — ВИМОГА ВЛАСНИКА, А НЕ ПРИКРАСА.
 *
 * Списана угода лишається в Kommo на грошовій стадії, а в нас її вже немає —
 * тобто дашборд показує МЕНШЕ за CRM. Це прямо суперечить «дашборд — дзеркало
 * CRM», і власник закрив суперечність не забороною, а ВИДИМІСТЮ: розбіжність
 * має бути названа числом, і вона ж підказує, що ті угоди треба закрити в Kommo.
 *
 * Сховати її було б найгіршим із варіантів: цифри розійшлись би тихо, а тиха
 * розбіжність — найдорожчий клас помилок, який у нас є.
 */
export const WRITTEN_OFF_STILL_IN_ZONE = `
  SELECT count(*)::int AS deals, COALESCE(sum(d.price), 0)::float AS amount
    FROM deals d
   WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2)
     AND EXISTS (SELECT 1 FROM (${FULLY_WRITTEN_OFF_DEALS}) wo WHERE wo.deal_id = d.kommo_id)`;
