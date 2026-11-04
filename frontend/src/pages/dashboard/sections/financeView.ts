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

/** Як число стоїть у клітинці внесення: «1234,5», порожнє — «». */
export const asInput = (v: number | null) => (v == null ? "" : String(v).replace(".", ","));

/**
 * «Взяти план із попереднього місяця» (рішення Романа 01.10.2026: кнопкою, не автоматично) — чернетки для клітинок
 * плану. Заповнює ЛИШЕ порожні: план у статті вже є або клітинку вже правили — не чіпаємо. Нічого не записує:
 * чернетки йдуть у звичайне «Зберегти», тож план з'являється, лише коли людина його підтвердила (і він в історії).
 * Вимкнена стаття і стаття без плану в попередньому місяці — пропускаються.
 */
export function planFromPrevious(
  items: readonly { id: number; active: boolean; plan: number | null }[],
  prevPlan: ReadonlyMap<number, number | null>,
  drafts: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    if (!it.active || it.plan != null) continue;
    const key = `${it.id}:plan`;
    if (drafts[key] !== undefined) continue;
    const p = prevPlan.get(it.id);
    if (p == null) continue;
    out[key] = asInput(p);
  }
  return out;
}

/**
 * 🧾 Підсумок вікна «Розпис плану» (задача 7832) — по чернетках рядків, як їх набрали: «1 234,5». Порожній рядок не
 * рахується; рядок із текстом без суми чи з сумою ≤ 0 — `bad` (сервер однаково відмовить). Стан — як на сервері
 * (`partsStateOf`): `ok` — Σ = плану, `under` — не розписано `left`, `over` — розпис більший на −`left`.
 */
export function partsDraftSum(plan: number | null, rows: readonly { amount: string; note: string }[]):
  { sum: number; left: number | null; bad: number[]; state: "none" | "ok" | "under" | "over" | "noplan" } {
  let sum = 0, filled = 0;
  const bad: number[] = [];
  rows.forEach((r, i) => {
    const t = r.amount.replace(/[\s ]/g, "").replace(",", ".");
    if (!t) { if (r.note.trim()) bad.push(i); return; }
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) { bad.push(i); return; }
    sum += n; filled++;
  });
  sum = Math.round(sum * 100) / 100;
  if (!filled) return { sum, left: plan, bad, state: "none" };
  if (plan == null) return { sum, left: null, bad, state: "noplan" };
  const left = Math.round((plan - sum) * 100) / 100;
  return { sum, left, bad, state: left === 0 ? "ok" : left > 0 ? "under" : "over" };
}
