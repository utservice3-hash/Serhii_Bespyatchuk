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
