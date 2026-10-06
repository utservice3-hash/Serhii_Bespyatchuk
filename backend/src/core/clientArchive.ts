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

import { effectiveManagerSql } from "./effectiveManager.js";

/**
 * 🚚 «ПЕРЕВІЗНИК» У КОМЕНТАРІ → КАНДИДАТ В АРХІВ (05.10.2026, зворотний звʼязок #104/#69 Дарини).
 *
 * Менеджери самі позначають перевізників коментарем, але архівувати не можуть (це право тімліда й
 * вище), тож список знову й знову засмічується, а тімліди пишуть у «Зворотний звʼязок». Плашка
 * показує тімліду таких клієнтів його команди й архівує вибраних ОДНИМ кліком — з причиною
 * «Перевізник», тим самим записом, що й ручна «🗄 в архів» (скасовується «↩ повернути з архіву»).
 *
 * 🔴 ВПІЗНАВАННЯ — ЯВНІ ПАРИ ЛІТЕР, А НЕ `~*`/`lower()`: регістр кирилиці залежить від локалі бази
 * (`--locale=C` його не знає), а пишуть і «Перевiзник» з ЛАТИНСЬКОЮ i (правило 4: предикат по чужому
 * тексту доводиться покриттям). Корінь «перевіз» ловить «перевізник/-и/-ця», але не «перевозка»,
 * «перевірити». Хибні збіги («перевізники бачать ціни…») лишаються — тому список з ГАЛОЧКАМИ, а не
 * автоархів: рішення за тімлідом, текст коментаря видно поруч.
 * Заміряно 05.10: 25 клієнтів із таким коментарем, 10 уже в архіві, 15 ні.
 */
export const CARRIER_COMMENT_SQL_RE = "[Пп][Ее][Рр][Ее][Вв][ІіIi][Зз]";
const CARRIER_COMMENT_RE = new RegExp(CARRIER_COMMENT_SQL_RE, "u");
export function carrierCommentHit(text: string | null | undefined): boolean {
  return CARRIER_COMMENT_RE.test(text ?? "");
}

/**
 * Кандидати: клієнти, у яких ОСТАННІЙ коментар зі словом «перевіз…», і які ЗАРАЗ не в архіві
 * (з автоповерненням: повернутий новою оплатою знову кандидат). `clamp` — `ownerTeamClamp` (тімлід —
 * лише своя команда), `keysParam` — необовʼязковий фільтр за ключами (для масової дії).
 */
export function carrierCandidatesSql(clamp: string, keysParam?: string): string {
  return `WITH ${LAST_PAID_CTE},${OWNER_TEAM_CTE},
     cm AS (
       SELECT DISTINCT ON (c.client_key) c.client_key, c.body, c.created_at, c.author_id
         FROM client_comments c
        WHERE c.body ~ '${CARRIER_COMMENT_SQL_RE}'
        ORDER BY c.client_key, c.created_at DESC
     )
     SELECT cm.client_key, nm.client_name, cm.body AS comment,
            to_char(cm.created_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS commented_at,
            COALESCE(ua.full_name, ua.email) AS comment_by,
            mm.name AS manager_name, tt.name AS team_name, ot.team_id
       FROM cm
       LEFT JOIN loyalty_overrides o ON o.client_key = cm.client_key
       LEFT JOIN arch_paid ap ON ap.client_key = cm.client_key
       LEFT JOIN owner_team ot ON ot.client_key = cm.client_key
       LEFT JOIN paid_mgr pmx ON pmx.client_key = cm.client_key
       LEFT JOIN managers mm ON mm.id = ${effectiveManagerSql("o", "pmx")}
       LEFT JOIN teams tt ON tt.id = ot.team_id
       LEFT JOIN users ua ON ua.id = cm.author_id
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = cm.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      WHERE NOT ${archivedSql("o", "ap")} ${clamp}
        ${keysParam ? `AND cm.client_key = ANY(${keysParam})` : ""}
      ORDER BY tt.name NULLS LAST, mm.name, nm.client_name`;
}
