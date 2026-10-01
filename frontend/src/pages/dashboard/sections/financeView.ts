/**
 * 💰 Правила вигляду вкладки «План/факт витрат» — чисті функції, щоб гейт перевіряв саме їх (#937).
 *
 * Чи показувати рядок статті в таблиці місяця:
 *  - вимкнена в цьому місяці — ніколи;
 *  - режим внесення — завжди (вносять у будь-яку діючу статтю);
 *  - «лише понад план» — лише «понад» і «без плану»;
 *  - ПОРОЖНЮ статтю ховаємо лише в МИНУЛИХ місяцях (там вона справді нічого не означає), а в поточному й
 *    майбутніх показуємо: 01.10.2026 жовтень став поточним без жодної цифри, і екран показав самі назви груп —
 *    69 статей «зникли», хоча нікуди не дівались.
 */
export interface RowLike { active: boolean; state: "empty" | "noplan" | "nofact" | "over" | "ok" }
export interface ViewOpts { month: string; currentMonth: string; edit: boolean; onlyOver: boolean; showEmpty: boolean }

export function rowVisible(it: RowLike, o: ViewOpts): boolean {
  if (!it.active) return false;
  if (o.edit) return true;
  if (o.onlyOver) return it.state === "over" || it.state === "noplan";
  if (!o.showEmpty && it.state === "empty" && o.month < o.currentMonth) return false;
  return true;
}
