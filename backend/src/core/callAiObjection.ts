import { callDateLine, dialogText, normForQuote, type GeminiOutcome, type Turn } from "./callAiProviders.js";

/**
 * 🛡 КРИТЕРІЙ «РОБОТА ІЗ ЗАПЕРЕЧЕННЯМИ» — ОКРЕМОЮ РУБРИКОЮ (ТЗ «фінальні доробки після показу 08.10», рішення Романа
 * 08.10.2026 «1 ок»). Чому окремо, а не новою версією основного розбору: повторний прогін основної рубрики змінив би
 * відповіді моделі й по ціні та типу розмови — і вимога ТЗ «цифри старих колонок за 20.09–07.10 до і після однакові»
 * порушилась би сама собою. Тут модель відповідає РІВНО на одне питання; старі розбори не чіпаються.
 *
 * Автоматично рубрика йде лише для розмов від `OBJECTION_FROM`; старіші — тільки окремим запуском після згоди власника
 * (ТЗ: «повторний аналіз старих розмов — окремо оціни вартість і спитай мене перед запуском»).
 */

export const RUBRIC_OBJECTION_V1 = "first-touch-objection-v1";
/** День викату: від нього заперечення розбираються самі. Старші розмови — лише окремим запуском (`objectionBackfill`). */
export const OBJECTION_FROM = "2026-10-09";

export const OBJECTION_TYPES = ["price", "think", "competitor", "not_now", "other", "none"] as const;
export type ObjectionType = typeof OBJECTION_TYPES[number];
export const OBJECTION_HANDLED = ["handled", "not_handled", "n/a"] as const;
export type ObjectionHandled = typeof OBJECTION_HANDLED[number];

export interface ObjectionResult {
  present: boolean;
  type: ObjectionType;
  client_quote: string;
  handled: ObjectionHandled;
  manager_action: string;
  /** Цитату клієнта знайдено в його каналі; `null` — цитати немає. Ставить код, не модель. */
  quote_found?: boolean | null;
}

export const OBJECTION_SCHEMA = {
  type: "object",
  properties: {
    present: { type: "boolean", description: "true — клієнт висловив заперечення (див. правило 1)" },
    type: { type: "string", enum: [...OBJECTION_TYPES], description: "price — дорого; think — подумаю / передзвоню сам; competitor — порівняю, є інший перевізник; not_now — не зараз; other — інше; none — заперечення не було" },
    client_quote: { type: "string", description: "дослівна коротка цитата клієнта; порожньо, якщо заперечення не було" },
    handled: { type: "string", enum: [...OBJECTION_HANDLED], description: "handled — опрацьовано (правило 2); not_handled — ні; n/a — заперечення не було" },
    manager_action: { type: "string", description: "що зробив менеджер у відповідь, одним реченням; порожньо, якщо заперечення не було" },
  },
  required: ["present", "type", "client_quote", "handled", "manager_action"],
} as const;

export const OBJECTION_SYSTEM_PROMPT = [
  "Ти отримуєш автоматичну розшифровку першої телефонної розмови менеджера з продажу логістичної компанії UTS із клієнтом.",
  "Кожен рядок — час від початку розмови, номер каналу і текст. Хто з каналів менеджер — визнач зі змісту розмови.",
  "Відповідай лише на одне питання: чи було заперечення клієнта і чи опрацював його менеджер. Відповідь — JSON за схемою.",
  "1. Заперечення — коли клієнт після ціни чи пропозиції сумнівається або відмовляється: «дорого», «подумаю»,",
  "   «передзвоню сам», «порівняю з іншими», «у нас вже є перевізник», «не зараз». Питання про деталі перевезення —",
  "   не заперечення. Якщо заперечень кілька, бери перше суттєве.",
  "2. Опрацьовано (handled), якщо менеджер зробив хоча б одне: зʼясував причину («а з чим порівнюєте?», «яка ціна для",
  "   вас прийнятна?»); аргументував цінність (терміни, страхування, тип авто, досвід); запропонував альтернативу (інша",
  "   машина, догруз, інша дата, знижка в межах повноважень); домовився про конкретний наступний крок із часом.",
  "   Просте «добре, думайте» чи «до побачення» — НЕ опрацювання (not_handled).",
  "3. Заперечення не було: present=false, type=none, handled=n/a, client_quote і manager_action — порожні.",
  "4. client_quote — дослівний уривок слів клієнта з розшифровки, без часу й номера каналу, не переказ.",
].join("\n");

export function buildObjectionRequest(turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> {
  const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
  return {
    system_instruction: { parts: [{ text: OBJECTION_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: OBJECTION_SCHEMA } },
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens,
    },
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * Сувора перевірка відповіді. Суперечлива відповідь — НЕ приймається мовчки: «заперечення не було», але «опрацьовано»,
 * чи «було», але `n/a`, — це відмова з причиною, а не тихе виправлення (модель могла помилитись у будь-якому з полів).
 */
export function validateObjection(x: unknown): { ok: true; value: ObjectionResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  if (typeof o.present !== "boolean") return { ok: false, why: "present не boolean" };
  if (!isStr(o.type) || !(OBJECTION_TYPES as readonly string[]).includes(o.type)) return { ok: false, why: "type поза переліком" };
  if (!isStr(o.handled) || !(OBJECTION_HANDLED as readonly string[]).includes(o.handled)) return { ok: false, why: "handled поза переліком" };
  if (!isStr(o.client_quote) || !isStr(o.manager_action)) return { ok: false, why: "client_quote / manager_action не рядки" };
  if (!o.present && (o.handled !== "n/a" || o.type !== "none")) return { ok: false, why: "заперечення не було, а тип чи опрацювання задано" };
  if (o.present && (o.handled === "n/a" || o.type === "none")) return { ok: false, why: "заперечення було, а тип чи опрацювання — «немає»" };
  return { ok: true, value: { present: o.present, type: o.type as ObjectionType, client_quote: o.client_quote.trim(),
    handled: o.handled as ObjectionHandled, manager_action: o.manager_action.trim() } };
}

/** Цитату клієнта шукаємо в тексті ОДНОГО каналу (як у `verifyQuotes`): склейка з двох каналів не пройде. */
export function verifyObjectionQuote(r: ObjectionResult, turns: readonly Turn[]): ObjectionResult {
  const n = normForQuote(r.client_quote);
  if (!n) return { ...r, quote_found: null };
  const byChannel = new Map<number, string[]>();
  for (const t of turns) byChannel.set(t.channel, [...(byChannel.get(t.channel) ?? []), t.text]);
  const found = [...byChannel.values()].some((xs) => ` ${normForQuote(xs.join(" "))} `.includes(` ${n} `));
  return { ...r, quote_found: found };
}

export function interpretObjection(out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: ObjectionResult } | { ok: false; why: string } {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validateObjection(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: verifyObjectionQuote(v.value, turns) };
}

export const OBJECTION_KIT = { build: buildObjectionRequest, interpret: interpretObjection };

/** Підписи для екрана: тип заперечення людською мовою. */
export const OBJECTION_TYPE_UA: Record<ObjectionType, string> = {
  price: "дорого", think: "подумаю / передзвоню сам", competitor: "порівнює, є інший перевізник", not_now: "не зараз", other: "інше", none: "—",
};
