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
 * ⚠️ Звуження навмисне: найм пише `role_override = 'manager'` прийнятим кандидатам, і їх
 * звільнення в CRM мусить і далі закривати вхід. «Будь-який override» зламав би саме це.
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
