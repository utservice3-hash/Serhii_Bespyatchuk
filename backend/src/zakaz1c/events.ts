/**
 * 📨 Вебхук 1С → віджет (`POST /api/zakaz1c/onec/events`, ТЗ Андрію 30.10.2026). Заміна миттєвої «Оплати заказа»,
 * яку 1С шле в Genesis: для рахунків ВІДЖЕТА (їх немає в регістрі Genesis) 1С шле подію нам, і ми пишемо в угоду те
 * саме, що Genesis, — за секунди, а не за годину.
 *
 * Події:
 *   payment / payment_cancelled — стан рахунку ПІСЛЯ події (оплачено всього, залишок, «оплачено повністю»), а не різниця:
 *     тоді порядок подій неважливий і повтор нічого не ламає;
 *   realization — бухгалтерія провела (або скасувала) реалізацію: акт сам лягає в угоду.
 *
 * Правила запису в Kommo (Роман, 30.10.2026):
 *   - лише угода віджета (`owner.ts`), лише рахунок з нашого журналу, лише при `ZAKAZ1C_FIELDS_MODE=own|live`;
 *   - «Оплачено 1с» — сума оплат усіх рахунків угоди віджета (кілька валют — «1800 EUR + 500 UAH»);
 *   - «Оплачено из 1с» і тег «полная оплата» (як ставить Genesis) — коли оплачено ВСІ рахунки угоди;
 *   - скасували оплату і угода вже не оплачена повністю → галочку й тег ЗНІМАЄМО; етап назад не рухаємо (як Genesis);
 *   - етап «Оплата отримана» — лише вперед і лише з етапів до нього (`payments.ts`).
 * Ця частина — чиста (`decidePayment`), гейти ганяють рівно її; запити — у `mount.ts`.
 */
import { timingSafeEqual } from "node:crypto";
import { BEFORE_PAID, PAID_STAGE } from "./payments.js";
import { KOMMO_FIELDS, type LeadPatch } from "./kommoApi.js";

export const PAID_TAG = "полная оплата";

export interface PaymentEvent {
  kind: "payment" | "payment_cancelled";
  eventId: string;
  sentAt: string;
  invoiceUid: string;
  invoiceNumber: string;
  dealId: number;
  currency: string;
  invoiceTotal: number;
  paidTotal: number;
  remaining: number;
  fullyPaid: boolean;
  realized: boolean;
  paymentSum: number;
}
export interface RealizationEvent {
  kind: "realization";
  eventId: string;
  sentAt: string;
  invoiceUid: string;
  dealId: number;
  number: string;
  date: string;
  posted: boolean;
}
export type OnecEvent = PaymentEvent | RealizationEvent;

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const UID_RE = /^[0-9a-f-]{36}$/i;

/** Тіло вебхука → подія. Помилка — словами в журнал і 400 (1С побачить у своєму журналі відправок). */
export function parseEvent(b: any): { ok: true; ev: OnecEvent } | { ok: false; why: string } {
  if (!b || typeof b !== "object") return { ok: false, why: "тіло не JSON-обʼєкт" };
  const kind = str(b.event, 30);
  const eventId = str(b.event_id, 100);
  if (!eventId) return { ok: false, why: "немає event_id" };
  const invoiceUid = str(b.invoice_uid, 40);
  if (!UID_RE.test(invoiceUid)) return { ok: false, why: "invoice_uid не uid" };
  const dealId = Number(str(b.deal_id, 20));
  if (!Number.isInteger(dealId) || dealId <= 0) return { ok: false, why: "deal_id не номер угоди" };
  const sentAt = str(b.sent_at, 40);
  if (kind === "payment" || kind === "payment_cancelled") {
    const invoiceTotal = num(b.invoice_total), paidTotal = num(b.paid_total), remaining = num(b.remaining);
    if (![invoiceTotal, paidTotal, remaining].every(Number.isFinite)) return { ok: false, why: "invoice_total / paid_total / remaining мають бути числами" };
    if (typeof b.fully_paid !== "boolean") return { ok: false, why: "fully_paid має бути true/false" };
    return { ok: true, ev: { kind, eventId, sentAt, invoiceUid, invoiceNumber: str(b.invoice_number, 30), dealId, currency: str(b.currency, 3).toUpperCase() || "UAH",
      invoiceTotal, paidTotal, remaining, fullyPaid: b.fully_paid, realized: b.realized === true, paymentSum: num(b.payment?.sum) || 0 } };
  }
  if (kind === "realization") {
    if (typeof b.posted !== "boolean") return { ok: false, why: "posted має бути true/false" };
    return { ok: true, ev: { kind, eventId, sentAt, invoiceUid, dealId, number: str(b.realization_number, 30), date: str(b.realization_date, 10), posted: b.posted } };
  }
  return { ok: false, why: `невідома подія «${kind}»` };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Стан оплати угоди з рахунків віджета (кожен — з останньої події по ньому). */
export function dealPayState(invoices: { currency: string; paidTotal: number; fullyPaid: boolean }[]): { paidText: string; fullyPaid: boolean } {
  const byCur = new Map<string, number>();
  for (const i of invoices) byCur.set(i.currency || "UAH", (byCur.get(i.currency || "UAH") ?? 0) + Math.max(0, i.paidTotal));
  const parts = [...byCur.entries()].filter(([, s]) => s > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const paidText = parts.length === 0 ? "0" : parts.length === 1 ? fmt(Math.round(parts[0][1] * 100) / 100)
    : parts.map(([c, s]) => `${fmt(Math.round(s * 100) / 100)} ${c}`).join(" + ");
  return { paidText, fullyPaid: invoices.length > 0 && invoices.every((i) => i.fullyPaid) };
}

export interface PaymentDecision {
  patch: LeadPatch | null;
  note: string | null;
  /** Чому НЕ пишемо — для журналу подій. */
  skip: string | null;
  fullyPaid: boolean;
  paidText: string;
}

/**
 * Що писати в угоду після події оплати. `invoices` — рахунки віджета цієї угоди ПІСЛЯ застосування події.
 * `wasFull` — що ми записали минулого разу («Оплачено из 1с» стояла?).
 */
export function decidePayment(ev: PaymentEvent, ctx: {
  known: boolean; owner: "genesis" | "widget" | "free"; writeMode: boolean; testMode: boolean;
  invoices: { currency: string; paidTotal: number; fullyPaid: boolean }[];
  wasFull: boolean; pipelineId: number | null; statusId: number | null; tags: string[];
}): PaymentDecision {
  const state = dealPayState(ctx.invoices);
  const none = (skip: string): PaymentDecision => ({ patch: null, note: null, skip, ...state });
  if (!ctx.known) return none("рахунку немає в журналі віджета");
  if (ctx.owner === "genesis") return none("угоду веде Genesis");
  if (!ctx.writeMode) return none("ZAKAZ1C_FIELDS_MODE=off — лише журнал");
  const cf: NonNullable<LeadPatch["custom_fields_values"]> = [{ field_id: KOMMO_FIELDS.leadPaid1c, values: [{ value: state.paidText }] }];
  const patch: LeadPatch = { id: ev.dealId, custom_fields_values: cf };
  if (state.fullyPaid) {
    cf.push({ field_id: KOMMO_FIELDS.leadPaidFrom1c, values: [{ value: true }] });
    if (!ctx.tags.includes(PAID_TAG)) patch.tags_to_add = [{ name: PAID_TAG }];
    const before = ctx.pipelineId != null ? BEFORE_PAID[ctx.pipelineId] : undefined;
    if (before && ctx.statusId != null && before.has(ctx.statusId)) { patch.status_id = PAID_STAGE[ctx.pipelineId!]; patch.pipeline_id = ctx.pipelineId!; }
  } else if (ctx.wasFull || ctx.tags.includes(PAID_TAG)) {
    // Оплату скасували — «оплачено повністю» вже неправда: знімаємо галочку й тег. Етап назад не рухаємо.
    cf.push({ field_id: KOMMO_FIELDS.leadPaidFrom1c, values: [{ value: false }] });
    if (ctx.tags.includes(PAID_TAG)) patch.tags_to_delete = [{ name: PAID_TAG }];
  }
  const mark = ctx.testMode ? "[ТЕСТ] " : "";
  const sum = `${fmt(Math.round(ev.paymentSum * 100) / 100)} ${ev.currency}`;
  const no = ev.invoiceNumber.replace(/^0+/, "") || ev.invoiceNumber;
  const note = ev.kind === "payment"
    ? `${mark}Оплата ${sum} за рахунком 1С №${no}${ev.fullyPaid ? " · рахунок оплачено повністю" : ` · лишилось ${fmt(ev.remaining)} ${ev.currency}`}${state.fullyPaid ? " · угоду оплачено повністю" : ""}`
    : `${mark}Оплату за рахунком 1С №${no} скасовано або змінено в 1С · оплачено ${fmt(ev.paidTotal)} з ${fmt(ev.invoiceTotal)} ${ev.currency}. Перевірте.`;
  return { patch, note, skip: null, ...state };
}

/** Ключ вебхука: порівняння без витоку за часом. Порожній налаштований ключ — ніхто не проходить. */
export function webhookKeyOk(got: string, expected: string): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
