import { CLOSE_REASONS, CLOSE_REASON_KEYS } from "./reactivationRules.js";
import { lastOrderCte } from "./clientOrder.js";

/**
 * 🗄 АРХІВ КЛІЄНТА — ОДНА ДІЯ ЗАМІСТЬ `hidden` (рішення власника 05.08.2026).
 *
 * 🔴 ЧОМУ ЗАМІСТЬ, А НЕ ПОРУЧ. `loyalty_overrides.hidden` був булевим тумблером
 * без причини й без дати: клієнт зникав, і через місяць ніхто не знав, чому і хто
 * це зробив. Другий механізм поруч зі старим означав би два способи прибрати
 * клієнта з екрана — а ми вже знаємо, чим це закінчується (два визначення
 * розходяться, і ніхто не памʼятає, яке з них дивиться на екран).
 * Тому `hidden` більше НЕ ЧИТАЄТЬСЯ ніде; його значення перенесені в архів
 * міграцією, а колонка лишена лише як слід (див. `schema.sql`).
 *
 * 🔴 ПРИЧИНА ОБОВʼЯЗКОВА, І ЇЇ СТЕРЕЖЕ `CHECK` У БД, а не валідація в роуті.
 * Валідацію в роуті обходить будь-який скрипт; словник причин — той самий, що
 * при закритті реактиваційної задачі (`CLOSE_REASONS`), бо це те саме питання
 * «чому клієнт більше не наш», і два словники розійшлися б за півроку.
 *
 * 🟢 ПОВЕРНЕННЯ — АВТОМАТИЧНЕ Й БЕЗ ДЖОБИ. Клієнт виходить з архіву САМ, щойно
 * зʼявляється оплата ПІЗНІШЕ за дату архівації. Це ПОХІДНА, а не збережений стан:
 * збережений треба комусь оновлювати, і джоба, що тихо не відпрацювала, лишила б
 * в архіві клієнта, який учора замовив. Той самий принцип, що й у станах
 * реактивації («жодного тумблера "зробити сплячим"»).
 */

export const ARCHIVE_REASONS = CLOSE_REASONS;
export const ARCHIVE_REASON_KEYS = CLOSE_REASON_KEYS;

/**
 * Чиста функція правила. `archivedAt` — коли поклали в архів; `lastPaidAt` —
 * остання оплата клієнта (будь-яка, з `deals`).
 *
 * ⚠️ Порівняння СТРОГЕ (`>`): оплата, датована тим самим моментом, що й
 * архівація, поверненням не вважається — інакше архівація угоди, закритої
 * секунда-в-секунду, скасовувала б сама себе.
 */
export function isArchived(archivedAt: Date | string | null, lastPaidAt: Date | string | null): boolean {
  if (archivedAt == null) return false;
  if (lastPaidAt == null) return true;
  return new Date(lastPaidAt).getTime() <= new Date(archivedAt).getTime();
}

/**
 * SQL-предикат «клієнт ЗАРАЗ в архіві». Один текст на всі екрани.
 * @param lo   алиас `loyalty_overrides`
 * @param paid алиас підзапиту з `last_paid` по клієнту (колонка `last_paid`)
 */
export function archivedSql(lo = "lo", paid = "ap"): string {
  return `(${lo}.archived_at IS NOT NULL
           AND (${paid}.last_paid IS NULL OR ${paid}.last_paid <= ${lo}.archived_at))`;
}

/**
 * Підзапит «остання оплата клієнта» для `archivedSql`. Окремим CTE, а не
 * корельованим підзапитом — урок 05.08.2026: корельований `EXISTS` на кожен рядок
 * коштував `/overview` 9.5 с.
 */
export const LAST_PAID_CTE = `
  ${lastOrderCte("arch_orders")},
  arch_paid AS (SELECT client_key, last_order_at AS last_paid FROM arch_orders)`;
export const LAST_PAID_JOIN = "LEFT JOIN arch_paid ap ON ap.client_key = a.client_key";

import { OWNER_TEAM_CTE } from "./reactivationClose.js";

/**
 * 🗄 СПИСОК АРХІВУ — ОДИН ТЕКСТ НА РОУТ І НА ГЕЙТ.
 *
 * 🔴 ВИНЕСЕНО САМЕ ЗАРАДИ ДОКАЗУ. Правило зони каже прямо: SQL усередині шаблонного
 * рядка НЕ типізується — `tsc` зелений, `npm test` зелений, а запит падає на першому
 * ж кліку. Єдина перевірка, яка тут щось означає, — виконати ТОЙ САМИЙ текст проти
 * живої бази. Поки він жив усередині роута, гейт мусив би тримати власну копію, а
 * доказ на переписаному тексті є доказом ні про що (урок `#21c`).
 *
 * `clamp` — готова умова скоупу (`ownerTeamClamp`), порожня для адмін-рівня.
 */
export function archiveListSql(clamp: string): string {
  return `WITH ${LAST_PAID_CTE},${OWNER_TEAM_CTE},
     agg AS (
       SELECT d.client_key, COUNT(*)::int AS orders, COALESCE(SUM(d.price),0) AS revenue
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
        GROUP BY d.client_key
     )
     SELECT o.client_key, COALESCE(o.client_name, nm.client_name) AS client_name,
            o.archive_reason AS reason,
            to_char(o.archived_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS archived_at,
            COALESCE(u.full_name, u.email) AS by_name,
            COALESCE(a.orders,0) AS orders, COALESCE(a.revenue,0) AS revenue,
            to_char(ap.last_paid AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS last_paid
       FROM loyalty_overrides o
       LEFT JOIN arch_paid ap ON ap.client_key = o.client_key
       LEFT JOIN agg a ON a.client_key = o.client_key
       LEFT JOIN users u ON u.id = o.archived_by
       -- 🔴 ІМʼЯ КЛІЄНТА БЕРЕТЬСЯ З deals, ТИМ САМИМ LATERAL, ЩО Й У РЕАКТИВАЦІЇ.
       -- loyalty_overrides.client_name ніхто не заповнює (архівація пише лише
       -- ключ і причину), тож фолбек "?? client_key" показував НОРМАЛІЗОВАНИЙ
       -- ключ: «АМС ФАРМ ТОВ» на екрані виглядало як «амсфарм». Спіймано живою
       -- пробою на проді, не читанням коду.
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = o.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
       LEFT JOIN owner_team ot ON ot.client_key = o.client_key
      WHERE ${archivedSql("o", "ap")} ${clamp}
      ORDER BY o.archived_at DESC`;
}
