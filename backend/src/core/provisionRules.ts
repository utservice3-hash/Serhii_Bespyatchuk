/**
 * 🔐 КОМУ СИНК KOMMO КЕРУЄ АКТИВНІСТЮ АКАУНТА — чисте правило, нуль імпортів.
 *
 * `provisionUsers` наприкінці кожного тіка `syncKommo` писав `users.is_active` значенням із
 * `managers` УСІМ, у кого є запис менеджера. Для продажів це правильно: вимкнули людину в
 * CRM — вхід закрився. Для штабу — ні.
 *
 * 📐 ВИПАДОК, ЯКИЙ ЦЕ КУПИВ (21.09.2026): користувача Kommo Романа Денисюка вимкнули, і
 * дашборд мовчки деактивував акаунт АДМІНА. У журналі доступу — жодного запису, бо це зробила
 * не людина. Поки жив старий токен, цього ніхто не бачив; вихід із системи замкнув двері, а
 * форма входу ще й назвала причину «невірний пароль». Після переходу з Kommo на Twenty
 * (рішення 18.09.2026) так само вимкнуло б кожного, хто має запис менеджера.
 *
 * ПРАВИЛО: активність веде синк, ЯКЩО ефективна роль — продажна (`manager`, `team_lead`) або
 * `candidate` (її веде найм), чи ручної ролі немає взагалі. Будь-яка інша ручна роль (admin,
 * ceo, opdir, kvp, financier, hr, бухгалтерія, кастомні) означає, що доступ видав адмін
 * свідомо й незалежно від CRM — і забирає його теж адмін, кнопкою в Налаштуваннях.
 * ⚠️ Звуження навмисне: найм писав `role_override = 'manager'` прийнятим кандидатам (до 21.10.2026; з #2231
 * найм знімає ручну роль зовсім — `settleHiredAccount`), і звільнення таких людей у CRM мусить і далі закривати
 * вхід. «Будь-який override» зламав би саме це.
 */
const CRM_OWNED_ROLES: readonly string[] = ["manager", "team_lead", "candidate"];

export function syncOwnsActive(roleOverride: string | null | undefined): boolean {
  const r = (roleOverride ?? "").trim();
  return r === "" || CRM_OWNED_ROLES.includes(r);
}

/** SQL-двійник для одного UPDATE: `$n` — активність із CRM. Список — той самий, з константи. */
export function isActiveAssignSql(param: string): string {
  const list = CRM_OWNED_ROLES.map((r) => `'${r}'`).join(", ");
  return `is_active = CASE WHEN role_override IS NULL OR btrim(role_override) = '' OR role_override IN (${list}) THEN ${param} ELSE is_active END`;
}

/**
 * 🔑 ЯКИЙ АКАУНТ СИНК БЕРЕ ДЛЯ МЕНЕДЖЕРА KOMMO (#2232, 21.10.2026). `$1` — `managers.id`, `$2` — пошта з Kommo.
 *
 * За алгоритмом «один акаунт» HR перед переведенням вписує кандидату робочу пошту — логін змінюється, і синк
 * мусить знайти САМЕ цей акаунт, а не створити другий. Тому:
 *   - пошта без урахування регістру: логін кандидата зберігається малими літерами, у Kommo буває інакше;
 *   - порядок однозначний: акаунт, уже прив'язаний до цього Kommo, — першим. Раніше `rows[0]` без `ORDER BY`
 *     брав перший-ліпший, коли збігались ДВА акаунти (прив'язаний і інший із тією самою поштою).
 * Константою, а не рядком усередині `provisionUsers`, — щоб гейт виконував ЦЕЙ запит, а не свою копію.
 */
export const PROVISION_LOOKUP_SQL =
  `SELECT id, role, role_override, manager_id FROM users WHERE manager_id = $1 OR lower(email) = lower($2)
    ORDER BY (manager_id = $1) DESC NULLS LAST, id LIMIT 1`;

/**
 * Чи кликати `settleHiredAccount` після тіка синку. Лише коли є що робити: акаунт ще з роллю «Кандидат» або
 * Kommo щойно прив'язався / змінився. Інакше кожен тік множив би запити на кожного менеджера (див. гіпотезу
 * про пул о :00 у `rules/jobs-sync.md`).
 */
export function syncShouldSettle(u: { role_override: string | null; manager_id: number | null }, managerId: number): boolean {
  return u.role_override === "candidate" || u.manager_id !== managerId;
}
