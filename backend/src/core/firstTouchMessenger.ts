import { callDateLine, dialogText, type GeminiOutcome, type Turn } from "./callAiProviders.js";
import { quoteInOneChannel } from "./callAiObjection.js";
import type { PromiseChannel } from "./callAiPromise.js";

/**
 * 💬 МЕСЕНДЖЕР У ПЕРШІЙ РОЗМОВІ (задача 7184, Юля 26.10.2026; рішення Романа 30.10.2026).
 *
 *  1. Обіцянки «у месенджер» по менеджеру — з НАЯВНОГО розбору: обіцянка менеджера з каналом `message` (Viber, Telegram,
 *     WhatsApp, SMS, пошта) — Ringostat її не бачить, тож перевірити її система не може. Рахуємо БУДЬ-ЯКИЙ месенджер
 *     (Роман: «як радиш» — Viber і так 79 % таких обіцянок, замір 1–29.10).
 *  2. Сигнал «менеджер САМ запропонував перейти в месенджер, клієнт не просив» — окрема коротка рубрика по готовій
 *     розшифровці, лише для розмов, де месенджер узагалі звучить. Ставимо лише з дослівною цитатою, що знайшлась у розмові.
 *     До звірки з людьми сигнал бачать адмін і КВП; тімлідам — перемикачем у «Налаштуваннях» (`messengerSignalTeamLeads`).
 *
 * Модуль чистий: рубрика, правило сигналу, хто бачить.
 */
export const RUBRIC_MESSENGER_V1 = "first-touch-messenger-v1";
/** Початок вибірки «Першого дотику» (`FIRST_TOUCH_RULE.startDate`). */
export const MESSENGER_FROM = "2026-09-20";
/** Хто запропонував перейти в месенджер. */
export const MESSENGER_MOVES = ["none", "manager", "client"] as const;
export type MessengerMove = typeof MESSENGER_MOVES[number];
export interface MessengerResult { move: MessengerMove; quote: string; quote_found?: boolean | null }

/** Кандидати рубрики: у тексті розмови звучить месенджер (POSIX-регулярка для `~*` у Postgres). */
export const MESSENGER_TEXT_RE = "(вайбер|вайбір|viber|телеграм|телеґрам|telegram|вотсап|ватсап|вацап|whatsapp|месенджер|мессенджер)";

export const MESSENGER_SCHEMA = {
  type: "object",
  properties: {
    move: { type: "string", enum: [...MESSENGER_MOVES], description: "хто першим запропонував перейти в месенджер: manager — менеджер сам; client — клієнт попросив; none — переходу не було" },
    quote: { type: "string", description: "дослівні слова того, хто запропонував; для none — порожньо" },
  },
  required: ["move", "quote"],
} as const;

export const MESSENGER_SYSTEM_PROMPT = [
  "Ти аналізуєш першу розмову менеджера логістичної компанії з клієнтом. Відповідь — JSON за схемою.",
  "Питання одне: чи ПЕРЕВЕЛИ розмову в месенджер (Viber, Telegram, WhatsApp) і ХТО ЦЕ ЗАПРОПОНУВАВ ПЕРШИМ.",
  "move:",
  "  manager — менеджер сам запропонував написати чи надіслати в месенджер, а клієнт про це не просив («скину вам у вайбер», «напишіть мені у вайбер», «я вам у телеграм напишу»);",
  "  client — клієнт сам попросив месенджер («скиньте у вайбер», «мені зручніше у вайбері») — навіть якщо менеджер потім погодився;",
  "  none — переходу в месенджер не було, або месенджер лише згадали без домовленості.",
  "Правила:",
  "1. Лише за прямими словами розмови. Не впевнений — none.",
  "2. Якщо клієнт попросив раніше, ніж менеджер запропонував, — client.",
  "3. quote — дослівні слова того, хто запропонував; для none — порожньо.",
].join("\n");

export function buildMessengerRequest(turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> {
  const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
  return {
    system_instruction: { parts: [{ text: MESSENGER_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: MESSENGER_SCHEMA } }, thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens },
  };
}

/** Сувора перевірка: поза переліком чи «хтось запропонував» без цитати — відмова з причиною, а не тихе виправлення. */
export function validateMessenger(x: unknown): { ok: true; value: MessengerResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  if (typeof o.move !== "string" || !(MESSENGER_MOVES as readonly string[]).includes(o.move)) return { ok: false, why: "move поза переліком" };
  if (typeof o.quote !== "string") return { ok: false, why: "quote не рядок" };
  const quote = o.quote.trim();
  if (o.move !== "none" && !quote) return { ok: false, why: "перехід є, а цитати немає" };
  return { ok: true, value: { move: o.move as MessengerMove, quote: o.move === "none" ? "" : quote } };
}

export function interpretMessenger(out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: MessengerResult } | { ok: false; why: string } {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validateMessenger(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: { ...v.value, quote_found: v.value.move === "none" ? null : quoteInOneChannel(v.value.quote, turns) } };
}

export const MESSENGER_KIT = { build: buildMessengerRequest, interpret: interpretMessenger };

/**
 * Сигнал «менеджер сам запропонував месенджер»: `true` — так, і цитата знайшлась у розмові; `false` — розібрано, сигналу
 * немає (клієнт попросив, переходу не було, або цитата не знайшлась — сумнів не стає сигналом); `null` — не розбирали
 * (месенджер у розмові не звучав або рубрика ще не дійшла).
 */
export function messengerSignal(ai: MessengerResult | null): boolean | null {
  if (!ai) return null;
  return ai.move === "manager" && ai.quote_found === true;
}

/** Скільки обіцянок МЕНЕДЖЕРА пішли в месенджер — їх система перевірити не може. */
export const messengerPromisesOf = (promises: readonly { who: string; channel?: PromiseChannel }[]): number =>
  promises.filter((p) => p.who === "manager" && p.channel === "message").length;

/** Хто бачить сигнал: адмін і КВП завжди; тімлід — лише коли адмін увімкнув після звірки. Менеджер — ні. */
export const canSeeMessengerSignal = (roleKey: string | null | undefined, forTeamLeads: boolean): boolean =>
  roleKey === "admin" || roleKey === "kvp" || (roleKey === "team_lead" && forTeamLeads);
