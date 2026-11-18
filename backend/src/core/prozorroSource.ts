import { AI_TENDER_TAG } from "./prozorroPush.js";

/**
 * 🏛 «УГОДА З PROZORRO» — ОДНЕ ПРАВИЛО (задача 9230; правила погоджено Романом 18.11.2026: «добре давай додавати ці цифри у звіт»).
 *
 * ПРАВИЛО (`docs/METRICS_GLOSSARY.md` §21): угода з Prozorro = «Источник клиента» (поле 2098035) = «AI тендер»
 * (значення enum 6348927) **або** на угоді тег «AI тендер» (id 3102063) **або** тег «Prozorro» (id 3101953).
 *
 * 📐 Чому саме так (заміряно на проді 18.11.2026, `docs/sql/m9230.cjs`):
 *  · значення «Prozorro» в «Источник клиента» НЕМАЄ (20 значень, тендерне одне — «AI тендер»);
 *  · джерело й тег «AI тендер» ставить бот тендерів (`core/prozorroPush.ts`) на угоду в Продзвоні, і Kommo переносить їх
 *    на угоду менеджера, створену з тендерної: 4 з 4 таких угод у Повному циклі несуть «AI тендер». Тож правило
 *    накриває все, що екран «Тендери Prozorro» зве «Передано менеджеру», — і ще угоди, які менеджер завів сам
 *    (8 із джерелом «AI тендер» і 6 із ручним тегом «Prozorro» у Повному циклі з 01.09 — саме про них задача);
 *  · старий тег «тендер» (id 565328, 992 угоди 2024 — 07.2026, закритий тендерний відділ) НЕ береться: інакше історія
 *    роздулась би угодами відділу, якого немає.
 *
 * Тег лежить у `deals.tags` (пише `syncKommo`; NULL — угоду ще не перечитували після появи колонки, тоді вона йде лише
 * за джерелом). Свого SQL «що таке Prozorro» в інших місцях не писати — лише через `prozorroDealSql`.
 */

/** Текст значення enum «AI тендер» у «Источник клиента» — саме він лежить у `deals.client_source` (enum 6348927). */
export const PROZORRO_CLIENT_SOURCE = "AI тендер";
/** Теги угоди, що мітять Prozorro: тег бота (`AI_TENDER_TAG`) і ручний «Prozorro». Старий «тендер» — свідомо ні. */
export const PROZORRO_TAGS: readonly string[] = [AI_TENDER_TAG, "Prozorro"];

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** SQL-предикат «угода з Prozorro» над аліасом таблиці `deals`. Єдине місце правила. */
export function prozorroDealSql(alias = "d"): string {
  const tags = `ARRAY[${PROZORRO_TAGS.map(quote).join(", ")}]::text[]`;
  return `(COALESCE(btrim(${alias}.client_source), '') = ${quote(PROZORRO_CLIENT_SOURCE)} OR COALESCE(${alias}.tags, '{}'::text[]) && ${tags})`;
}

/** Та сама ознака на рядку в памʼяті (для чистих гейтів по обидва боки межі). */
export function isProzorroDeal(d: { clientSource: string | null; tags: readonly string[] | null }): boolean {
  if ((d.clientSource ?? "").trim() === PROZORRO_CLIENT_SOURCE) return true;
  return (d.tags ?? []).some((t) => PROZORRO_TAGS.includes(t));
}
