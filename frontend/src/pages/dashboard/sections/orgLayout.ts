/** 🏢 Розкладка дерева орг-структури — чиста, без React (її звіряє гейт #2715). */

/**
 * Діти блоку в дереві: якщо простих команд (без власних блоків) більше чотирьох — вони йдуть сіткою рядками по чотири, а
 * діти з власними блоками — окремими гілками; інакше — усі гілками в один ряд, як було (`rows` порожній).
 */
export function splitKids<T>(ch: readonly T[], hasKids: (c: T) => boolean): { branches: T[]; rows: T[][] } {
  const flat = ch.filter((c) => !hasKids(c));
  if (flat.length <= 4) return { branches: [...ch], rows: [] };
  const rows: T[][] = [];
  for (let i = 0; i < flat.length; i += 4) rows.push(flat.slice(i, i + 4));
  return { branches: ch.filter(hasKids), rows };
}
