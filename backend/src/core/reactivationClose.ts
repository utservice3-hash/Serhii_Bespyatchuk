import { CLOSE_REASON_KEYS, RETURNED_CLOSE_REASON } from "./reactivationRules.js";
import { MIGRATED_CLOSE_REASON } from "./reactivationPack.js";

/**
 * 🏷 ЧОМУ ЗАДАЧУ ЗАКРИТО — І ХТО ЦЕ ВИРІШИВ: ЛЮДИНА ЧИ СИСТЕМА.
 *
 * 📐 КУПЛЕНО ЗАМІРОМ 07.09.2026, ДО ПЕРШОГО РЯДКА ЕКРАНА. Задача цього проходу —
 * показати тімліду результат його дій, і найпростіша реалізація («покажемо закриті
 * задачі з їхньою причиною») збрехала б з першого дня:
 *
 *   людських причин із довідника ....... 0
 *   мітка перенесення (наша, 05.09) .... 194   ← їх поставив скрипт міграції
 *   закриті БЕЗ причини (пачки) ........ 11    ← CHECK вимагає причину лише поклієнтно
 *   мітка автоповернення ............... 0
 *
 * Тобто «закритих із причиною» у базі 194, а зроблених людьми — жодної. Екран, який
 * не розрізняє ці класи, показав би 194 опрацьовані клієнти там, де роботи не було.
 *
 * 🔴 КЛАСИ БЕРУТЬСЯ З КОНСТАНТ, А НЕ З ПЕРЕПИСАНИХ ПРЕФІКСІВ. Порівнюємо саме зі
 * значеннями `RETURNED_CLOSE_REASON` / `MIGRATED_CLOSE_REASON`; якби тут стояв
 * власний рядок «migrated:», перейменування константи мовчки перевело б сотні рядків
 * у клас «людська причина» — той самий клас помилки, що друга копія правила.
 *
 * ⚠️ `unknown` — НЕ смітник, а чесна відповідь. Причина, якої немає ні в довіднику, ні
 * серед службових міток, означає «щось написали повз обидва механізми», і це треба
 * бачити, а не приписувати людині. Правило 3: стан, що стверджує причину, не може
 * бути смітником для кількох різних відмов.
 */
export type CloseClass = "human" | "auto" | "legacy" | "none" | "unknown";

/** Службові мітки — рівно ті, які ставить КОД, а не людина. */
export const SERVICE_CLOSE_REASONS: readonly string[] = [
  RETURNED_CLOSE_REASON,
  MIGRATED_CLOSE_REASON,
];

/**
 * 🔴 ПРИЧИНА ЗБЕРІГАЄТЬСЯ ЯК «ключ: пояснення», А НЕ ГОЛИМ КЛЮЧЕМ — і це знайдено
 * читанням ЗАПИСУВАЧА, а не здогадом. `POST /reactivation-task/close` складає рядок
 * `${reasonKey}: ${note}`, коли менеджер дописав пояснення (а для «Інше» воно
 * обовʼязкове). Перша редакція цього класифікатора порівнювала весь рядок із довідником
 * і зарахувала б КОЖНУ причину з поясненням до «поза довідником» — тобто найдетальніші
 * закриття, зроблені людиною, зникли б із класу «людські».
 *
 * ⚠️ Службові мітки звіряються ЦІЛКОМ, а не префіксом: їх пише лише код і пише дослівно.
 * Префіксне порівняння тут відкрило б двері рядку «returned: щось своє» ззовні.
 */
export function closeReasonKey(reason: string): string {
  const i = reason.indexOf(":");
  return (i === -1 ? reason : reason.slice(0, i)).trim();
}

export function closeReasonClass(reason: string | null | undefined): CloseClass {
  const r = (reason ?? "").trim();
  if (!r) return "none";
  /* 🔴 ДВІ СЛУЖБОВІ МІТКИ — ДВА РІЗНІ ФАКТИ, І ЗЛИТИ ЇХ ЗНАЧИТЬ ОБМОВИТИ ЛЮДЕЙ.
     `returned:` ставить крон за фактом оплати — це справді зробила система.
     `migrated:` поставив скрипт перенесення 05.09, але РОБОТУ зробила людина: це ті
     самі клієнти, яких менеджер відмітив у чеклісті пачки (заміряно 07.09: 198 із 347
     елементів відмічені, 180 мають written коментар на кшталт «Зараз немає контракту»).
     Спільний підпис «закрито системою» записав би 194 людські опрацювання на машину. */
  if (r === RETURNED_CLOSE_REASON) return "auto";
  if (r === MIGRATED_CLOSE_REASON) return "legacy";
  if (CLOSE_REASON_KEYS.includes(closeReasonKey(r))) return "human";
  return "unknown";
}

/** Підпис класу для екрана. Кожен називає СЕБЕ, а не вдає причину. */
export const CLOSE_CLASS_LABEL: Record<CloseClass, string> = {
  human: "закрито менеджером",
  auto: "закрито автоматично — клієнт повернувся",
  legacy: "опрацьовано до реєстру, автора не збережено",
  none: "закрито без причини",
  unknown: "причина поза довідником",
};

/**
 * 👤 КОМАНДА ВІДПОВІДАЛЬНОГО ЗА КЛІЄНТА — множинна версія тієї САМОЇ формули.
 *
 * 🔴 ДРУГОЇ ФОРМУЛИ «МЕНЕДЖЕР КЛІЄНТА» НЕ ЗАВОДИМО (правило зони `clients.md`):
 * скрізь це `COALESCE(loyalty_overrides.pinned_manager_id, основний за оплатами)`.
 * Поштучний резолвер уже є — `clientOwnerTeam` у `routes/dashboard.ts`, — але він
 * робить ОКРЕМИЙ запит на клієнта, тож для списку архіву дав би N запитів на N рядків.
 * Тут та сама формула, висловлена набором.
 *
 * ⚠️ Це CTE, а не готовий запит: викликач дописує своє `FROM ... JOIN owner_team`.
 * Віддавати сюди повний SQL означало б зліпити доступ і предметний запит в одне місце.
 */
export const OWNER_TEAM_CTE = `
  paid_mgr AS (
    SELECT client_key, manager_id FROM (
      SELECT d.client_key, d.manager_id,
             ROW_NUMBER() OVER (PARTITION BY d.client_key
                                ORDER BY COUNT(*) DESC, MAX(d.closed_at_kommo) DESC) AS rn
        FROM deals d
        JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key, d.manager_id) z
     WHERE rn = 1
  ),
  owner_team AS (
    SELECT pm.client_key, m.team_id
      FROM paid_mgr pm
      LEFT JOIN loyalty_overrides lo ON lo.client_key = pm.client_key
      JOIN managers m ON m.id = COALESCE(lo.pinned_manager_id, pm.manager_id)
  )`;

/**
 * 🔒 КЛАМП СКОУПУ — рядком SQL, а не фільтром на фронті.
 *
 * Порожній рядок для адмін-рівня; для тімліда — умова по команді відповідального.
 * 📐 Чому це не «просто фільтр»: фільтр на фронті лишає дані у ВІДПОВІДІ, тобто
 * тімлід дістає чужу команду одним curl. Той самий урок, що в скоупі пошуку клієнтів.
 */
export function ownerTeamClamp(leadTeamId: number | null, param: string): string {
  return leadTeamId == null ? "" : `AND ot.team_id = ${param}`;
}

/**
 * 🔒 КЛАМП РЕЄСТРУ ЗАКРИТИХ — ПО КОМАНДІ ВИКОНАВЦЯ, А НЕ ВЛАСНИКА КЛІЄНТА.
 *
 * 🔴 І ЦЕ НЕ НЕДОГЛЯД, А РІЗНІ ПРЕДМЕТИ. Архів відповідає на «яких КЛІЄНТІВ прибрано
 * з екрана», тож ріжеться по відповідальному за клієнта. Реєстр відповідає на «що
 * зробила МОЯ КОМАНДА», тож ріжеться по виконавцю задачі. Зліпити їх в одне правило
 * означало б, що тімлід не побачить власної закритої задачі на клієнті, якого встигли
 * передати іншій команді, — тобто результат СВОЄЇ дії зник би саме тоді, коли він
 * найпотрібніший.
 *
 * ⚠️ Друга причина, суто фактична: пачка (`task_type='reactivation'`) взагалі не має
 * `client_key` — клієнти в ній усередині. По власнику клієнта її не звузити ніяк.
 */
export function assigneeTeamClamp(leadTeamId: number | null, param: string): string {
  return leadTeamId == null ? "" : `AND m.team_id = ${param}`;
}

/**
 * 📋 РЕЄСТР ЗАКРИТИХ ЗАДАЧ РЕАКТИВАЦІЇ — один текст на роут і на гейт.
 *
 * Віддає СИРУ причину; клас рахує `closeReasonClass` уже в коді. Класифікувати в SQL
 * означало б завести друге місце, де живе те саме правило, — і воно розійшлося б із
 * першим тихо, бо обидва «працюють».
 */
export function closedListSql(clamp: string): string {
  return `
    SELECT t.id, t.task_type, t.title, t.client_key, t.close_reason,
           to_char(t.closed_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS closed_at,
           COALESCE(cu.full_name, cu.email) AS closed_by,
           m.name AS assignee, tm.name AS team_name,
           (SELECT d.client_name FROM deals d
             WHERE d.client_key = t.client_key AND d.client_name IS NOT NULL
             ORDER BY d.closed_at_kommo DESC NULLS LAST LIMIT 1) AS client_name
      FROM tasks t
      LEFT JOIN managers m ON m.id = t.assignee_id
      LEFT JOIN teams tm ON tm.id = m.team_id
      LEFT JOIN users cu ON cu.id = t.closed_by
     -- 🔴 ЛИШЕ ПОКЛІЄНТНІ РЯДКИ. Пачка-батько не є подією по клієнту: її 59 клієнтів
     -- уже присутні в списку окремими рядками-дітьми, тож показувати ще й батька означало
     -- б рахувати ту саму роботу двічі (205 рядків там, де 194 клієнти + 11 папок).
     -- ⚠️ Безпечно рівно тому, що НЕперенесених пачок не існує — це стереже #347.
     WHERE t.task_type = 'reactivation_client'
       AND t.status = 'done' ${clamp}
     ORDER BY t.closed_at DESC NULLS LAST, t.id DESC`;
}
