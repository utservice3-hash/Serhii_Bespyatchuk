/**
 * 💰 СУМИ УГОДИ ЗА ПРАВИЛОМ ФІНАНСИСТА (аркуш «ФМ», підтверджено Тетяною 01.10.2026) — чистий модуль без імпортів.
 *
 *   дохід   = Σ «Приход 1» … «Приход 5»;
 *   витрати = Σ «Расход 1» … «Расход 5», КРІМ слотів із типом оплати «Оплата на выгрузке».
 *
 * 📐 Звірено через API Kommo на «Поставлених авто» 14–20.09.2026 (207 угод): 5 755 594,26 / 4 698 651,52 — рівно її
 * числа, до копійки. Без виключення «Оплата на выгрузке» витрати були б 5 151 451,52 (+452 800 — рівно ця сума).
 * Це НЕ «Приход 1» / «Расход 1» (`client_pay_amount` / `carrier_obligation`): ті лишаються як є для решти екранів.
 * Немає жодної суми — `null` («не знаємо»), а не нуль.
 */
export const FM_INCOME_FIELDS = [2097627, 2097683, 2097685, 2097687, 2097689] as const;
/** [поле суми «Расход N», поле «Расход N Тип оплаты»]. */
export const FM_EXPENSE_FIELDS = [[2097661, 2097651], [2097663, 2097653], [2097665, 2097655], [2097667, 2097657], [2097669, 2097659]] as const;
export const FM_EXPENSE_EXCLUDED_TYPE = "Оплата на выгрузке";

type Get = (fieldId: number) => string | null | undefined;

/** Сума з поля Kommo в копійках; порожнє чи не число — `null`. */
function cents(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[\s ]/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function fmIncomeFrom(get: Get): number | null {
  let sum = 0, any = false;
  for (const id of FM_INCOME_FIELDS) { const c = cents(get(id)); if (c != null) { sum += c; any = true; } }
  return any ? sum / 100 : null;
}

export function fmExpenseFrom(get: Get): number | null {
  let sum = 0, any = false;
  for (const [amount, type] of FM_EXPENSE_FIELDS) {
    const c = cents(get(amount));
    if (c == null) continue;
    any = true;
    if ((get(type) ?? "").trim() === FM_EXPENSE_EXCLUDED_TYPE) continue;
    sum += c;
  }
  return any ? sum / 100 : null;
}
