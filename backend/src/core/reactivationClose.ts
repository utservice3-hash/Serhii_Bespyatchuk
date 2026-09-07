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
export type CloseClass = "human" | "service" | "none" | "unknown";

/** Службові мітки — рівно ті, які ставить КОД, а не людина. */
export const SERVICE_CLOSE_REASONS: readonly string[] = [
  RETURNED_CLOSE_REASON,
  MIGRATED_CLOSE_REASON,
];

export function closeReasonClass(reason: string | null | undefined): CloseClass {
  const r = (reason ?? "").trim();
  if (!r) return "none";
  if (SERVICE_CLOSE_REASONS.includes(r)) return "service";
  if (CLOSE_REASON_KEYS.includes(r)) return "human";
  return "unknown";
}

/** Підпис класу для екрана. Кожен називає СЕБЕ, а не вдає причину. */
export const CLOSE_CLASS_LABEL: Record<CloseClass, string> = {
  human: "закрито менеджером",
  service: "закрито системою",
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
