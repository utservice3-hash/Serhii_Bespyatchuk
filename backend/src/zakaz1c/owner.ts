/**
 * 🤝 Хто веде угоду: Genesis чи наш віджет. Правило Романа 28.10.2026: «одна угода — одна система; Genesis основна,
 * ми акуратно її замінюємо». Genesis нашого рахунку не бачить (рахунки віджета не пишуться в його регістр), тож
 * розводимо системи на НАШОМУ боці: в угоді Genesis віджет рахунку не виставляє і в її поля не пише.
 *
 * Ознаки угоди Genesis — будь-яка з двох:
 *   1. «Номер заказа» в Kommo заповнений, і це не номер нашого рахунку (Genesis пише його одразу, щойно створив
 *      рахунок — тобто ознака миттєва);
 *   2. у 1С за угодою є рахунок, якого немає в нашому журналі (`onec_deal_invoices`, синк щогодини — ловить і ті
 *      випадки, коли «Номер заказа» стерли руками).
 * Рахунок, виставлений бухгалтерією вручну, теж потрапляє в (2) — і це правильно: угоду, де вже працює хтось інший,
 * віджет не підхоплює.
 *
 * Якщо в угоді віджета зʼявився рахунок Genesis (віджет не впорався, менеджер пішов у Genesis) — угода переходить
 * до Genesis: та сама функція вже скаже «genesis».
 *
 * 19.11.2026 — Genesis упав, Роман: «давай дозволяти виставляти угоду де працював генезис». Виставляти рахунок
 * «genesis» БІЛЬШЕ НЕ ЗАВАЖАЄ (і «Номер заказа» Genesis не перетираємо — `claimPatch` пише лише в порожнє поле).
 * `dealOwner` лишився для автозапису оплати й акта в поля угоди: оплат за рахунками Genesis ми не бачимо, тож
 * в угоді з рахунком Genesis «Оплачено» й етап «оплачено» за самими нашими рахунками не пишемо — збрехали б.
 */
import { KOMMO_FIELDS, type LeadPatch } from "./kommoApi.js";

export type DealOwner = "genesis" | "widget" | "free";

const norm = (n: string) => String(n ?? "").trim().replace(/^0+/, "");

export function dealOwner(a: { orderNo: string; ourNumbers: string[]; onecNumbers: string[] }): DealOwner {
  const ours = new Set(a.ourNumbers.map(norm).filter(Boolean));
  const order = norm(a.orderNo);
  if (order && !ours.has(order)) return "genesis";
  if (a.onecNumbers.map(norm).some((n) => n && !ours.has(n))) return "genesis";
  return ours.size ? "widget" : "free";
}

/** Тег угоди, яку веде віджет (видно в списку угод і в картці). 27.11.2026 Роман: «Заказ 1С» з угод прибрати — тег «Рахунок 1С»
 * (старий «Заказ 1С: новий віджет» лишається в угодах, де вже стоїть). */
export const WIDGET_TAG = "Рахунок 1С";

/**
 * Угода стала «нашою» (перший рахунок віджета): «Номер заказа» (лише якщо порожній — як пише Genesis; номер не
 * перетираємо — у колишній угоді Genesis там лишається номер Genesis) і тег.
 */
export function claimPatch(leadId: number, lead: { orderNo: string; tags: string[] }, number: string): LeadPatch | null {
  const patch: LeadPatch = { id: leadId };
  if (!lead.orderNo) patch.custom_fields_values = [{ field_id: KOMMO_FIELDS.leadOrderNo, values: [{ value: number }] }];
  if (!lead.tags.includes(WIDGET_TAG)) patch.tags_to_add = [{ name: WIDGET_TAG }];
  return patch.custom_fields_values || patch.tags_to_add ? patch : null;
}
