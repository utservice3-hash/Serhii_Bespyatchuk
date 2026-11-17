/**
 * 🏷 Події Kommo «тег додано» (`entity_tag_added`) → угоди, яким колись поставили тег (задача 9363, тег «LinkedIn»).
 * Чисте ядро без `config`: гейт `#3653` ганяє його без env Kommo, а `jobs/backfillLinkedinTags.ts` — на живих подіях.
 *
 * Навіщо події, а не прохід по всіх угодах: синк пише теги лише угодам свого вікна (змінені після появи колонки), а
 * угоду, якій тег поставили давно і яку відтоді не чіпали, він не побачить. Повний прохід по угодах Kommo — понад
 * 50 000 угод (заміряно 17.11.2026, стеля скрипта), а подія «тег додано» називає рівно ті угоди, які треба дочитати.
 */

/** Назви тегів у `value_after` події. Формат Kommo — `[{ tag: { name } }]`; приймаємо й `[{ name }]`, решту ігноруємо. */
export function tagNamesOf(valueAfter: unknown): string[] {
  if (!Array.isArray(valueAfter)) return [];
  const out: string[] = [];
  for (const v of valueAfter) {
    const o = (v ?? {}) as { tag?: { name?: unknown }; name?: unknown };
    const n = o.tag?.name ?? o.name;
    if (typeof n === "string" && n.trim()) out.push(n.trim());
  }
  return out;
}

export interface TagEvent { entityId: number; entityType?: string; valueAfter: unknown }

/** Угоди (лише `lead`), яким подія додала саме цей тег, без дублів і за зростанням id. Назва — точний збіг після обрізання пробілів. */
export function leadIdsWithTag(events: readonly TagEvent[], tag: string): number[] {
  const ids = new Set<number>();
  for (const e of events) {
    if (e.entityType != null && e.entityType !== "lead") continue;
    if (tagNamesOf(e.valueAfter).includes(tag)) ids.add(e.entityId);
  }
  return [...ids].sort((a, b) => a - b);
}
