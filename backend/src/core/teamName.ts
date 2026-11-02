/**
 * 🏷 НАЗВА КОМАНДИ — З KOMMO (рішення Романа 02.11.2026: «назви з коммо остаточні, роби прохід 2», задача 7371).
 *
 * До цього синк знаходив команду за `kommo_group_id` і назву НЕ чіпав, тож перейменування групи в Kommo в дашборд
 * не доходило ніколи: 02.11 у Kommo вже стояло «Яцик Team lead», а в дашборді — «РПК - Яцика Дмитра».
 * Тепер CRM — джерело назви, як і всього іншого; дашборд її дзеркалить.
 *
 * Виняток — групи, чию назву в дашборді змінили СВІДОМО, і вона має пережити синк (`KEEP_DASHBOARD_TEAM_NAME`).
 * Тип команди (нові / постійні клієнти) від назви НЕ залежить — він за номером (`NEW_CLIENTS_TEAM_IDS`, #3300), тому
 * перейменування не зрушує ні чергування, ні кольорів, ні метрик.
 */

/**
 * Групи Kommo, де назва дашборду перемагає. Ключ — `kommo_group_id`, бо назва групи якраз і змінюється.
 * 417860: у Kommo «Тендери», у дашборді «Самостійний» (команда 4, розформована й схована з екранів).
 */
export const KEEP_DASHBOARD_TEAM_NAME: ReadonlyMap<number, string> = new Map([
  [417860, "Тендери → «Самостійний»: назву дашборду змінено свідомо, команда розформована"],
]);

/** Як назва ляже в таблицю: без пробілів по краях і без подвійних (Kommo віддає «Логисты »). */
export const normalizeTeamName = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ");

export type TeamRename =
  | { kind: "keep"; reason: "same" | "empty" | "kept" }
  | { kind: "rename"; name: string }
  | { kind: "collision"; name: string };

/**
 * Що зробити з назвою наявної команди на цьому тіку синку.
 * `takenByOther` — назву вже носить ІНША команда: тоді пропускаємо, а не падаємо, бо назва унікальна в таблиці,
 * і збій тут зупинив би весь синк угод.
 */
export function teamRenameFromKommo(a: { groupId: number; local: string; kommo: string | null | undefined; takenByOther: boolean }): TeamRename {
  const name = normalizeTeamName(a.kommo);
  if (!name) return { kind: "keep", reason: "empty" };
  if (KEEP_DASHBOARD_TEAM_NAME.has(a.groupId)) return { kind: "keep", reason: "kept" };
  if (name === a.local) return { kind: "keep", reason: "same" };
  if (a.takenByOther) return { kind: "collision", name };
  return { kind: "rename", name };
}
