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

/**
 * 🤝 «ЗГОДА ПІСЛЯ ЦІНИ» (задача з TOP Weekly 08.10, рішення Романа 13.10.2026: «окрема інформація для розмов, в яких
 * назвали ціну; не впливає на оцінку, а на загальне бачення картини»). Друге питання в ТІЙ САМІЙ рубриці заперечень —
 * модель і так читає реакцію клієнта, окремий виклик був би другою оплатою за той самий текст.
 * Рубрика v1 НЕ змінюється: її розбори 09–12.10 лишаються як є. v2 — лише для дзвінків від `DECISION_FROM` (Роман:
 * «тільки з сьогоднішнього дня аналізуємо»); старші розмови згоди не мають і не отримають без окремого рішення.
 */
export const RUBRIC_OBJECTION_V2 = "first-touch-objection-v2";
export const DECISION_FROM = "2026-10-13";
/** Рубрики заперечень у порядку переваги для ЗАПЕРЕЧЕННЯ: v1 першою — поява v2 не переписує вже показані цифри. */
export const OBJECTION_RUBRICS = [RUBRIC_OBJECTION_V1, RUBRIC_OBJECTION_V2] as const;

export const CLIENT_DECISIONS = ["agreed", "thinking", "declined", "no_price"] as const;
export type ClientDecision = typeof CLIENT_DECISIONS[number];

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
  /** Лише рубрика v2: чим закінчилась розмова після названої ціни. */
  client_decision?: ClientDecision;
  /** Лише рубрика v2: дослівні слова клієнта, з яких видно рішення; порожньо при `no_price`. */
  decision_quote?: string;
  decision_quote_found?: boolean | null;
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

export const OBJECTION_SCHEMA_V2 = {
  type: "object",
  properties: {
    ...OBJECTION_SCHEMA.properties,
    client_decision: { type: "string", enum: [...CLIENT_DECISIONS], description: "agreed — погодився на ціну й наступний крок; thinking — думає; declined — відмовив; no_price — менеджер ціни не назвав (правило 5)" },
    decision_quote: { type: "string", description: "дослівні слова клієнта, з яких видно рішення; порожньо, якщо no_price" },
  },
  required: [...OBJECTION_SCHEMA.required, "client_decision", "decision_quote"],
} as const;

export const OBJECTION_SYSTEM_PROMPT_V2 = [
  ...OBJECTION_SYSTEM_PROMPT.split("\n").map((l) => l === "Відповідай лише на одне питання: чи було заперечення клієнта і чи опрацював його менеджер. Відповідь — JSON за схемою."
    ? "Відповідай на два питання: чи було заперечення клієнта і чи опрацював його менеджер; і чим закінчилась розмова після названої ціни. Відповідь — JSON за схемою."
    : l),
  "5. client_decision — реакція клієнта на ЦІНУ, яку назвав менеджер, на кінець розмови:",
  "   agreed — погодився на ціну й наступний крок: «оформлюйте», «чекаю рахунок», «ставте машину», «давайте»;",
  "   thinking — не вирішив: «подумаю», «узгоджу з керівником», «порівняю», «передзвоню сам»;",
  "   declined — відмовився: «дорого», «вже знайшли», «не треба»;",
  "   no_price — менеджер ціни не назвав (лише орієнтир з іншого рейсу чи бюджет клієнта — теж no_price).",
  "   Якщо клієнт спершу заперечив, а потім погодився, — agreed. thinking і declined — це завжди заперечення (правило 1).",
  "6. decision_quote — дослівні слова клієнта, з яких видно рішення; при no_price — порожньо.",
].join("\n");

function objectionRequest(prompt: string, schema: unknown) {
  return (turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> => {
    const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
    return {
      system_instruction: { parts: [{ text: prompt }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } },
        thinkingConfig: { thinkingLevel: "low" },
        maxOutputTokens,
      },
    };
  };
}
export const buildObjectionRequest = objectionRequest(OBJECTION_SYSTEM_PROMPT, OBJECTION_SCHEMA);
export const buildObjectionRequestV2 = objectionRequest(OBJECTION_SYSTEM_PROMPT_V2, OBJECTION_SCHEMA_V2);

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

/**
 * Згода (v2) — та сама сувора перевірка, плюс узгодженість двох відповідей: «думає» чи «відмовив» — це заперечення за
 * правилом 1, тож без нього відповідь суперечить сама собі й НЕ приймається (а не виправляється мовчки).
 */
export function validateObjectionV2(x: unknown): { ok: true; value: ObjectionResult } | { ok: false; why: string } {
  const base = validateObjection(x);
  if (!base.ok) return base;
  const o = x as Record<string, unknown>;
  if (!isStr(o.client_decision) || !(CLIENT_DECISIONS as readonly string[]).includes(o.client_decision)) return { ok: false, why: "client_decision поза переліком" };
  if (!isStr(o.decision_quote)) return { ok: false, why: "decision_quote не рядок" };
  const d = o.client_decision as ClientDecision;
  const q = o.decision_quote.trim();
  if ((d === "thinking" || d === "declined") && !base.value.present) return { ok: false, why: "клієнт думає чи відмовив, а заперечення не було" };
  if (d === "no_price" && q) return { ok: false, why: "ціни не було, а цитату рішення задано" };
  if (d !== "no_price" && !q) return { ok: false, why: "рішення є, а цитати клієнта немає" };
  return { ok: true, value: { ...base.value, client_decision: d, decision_quote: q } };
}

/** Цитату шукаємо в тексті ОДНОГО каналу (як у `verifyQuotes`): склейка з двох каналів не пройде. */
function quoteInOneChannel(quote: string, turns: readonly Turn[]): boolean | null {
  const n = normForQuote(quote);
  if (!n) return null;
  const byChannel = new Map<number, string[]>();
  for (const t of turns) byChannel.set(t.channel, [...(byChannel.get(t.channel) ?? []), t.text]);
  return [...byChannel.values()].some((xs) => ` ${normForQuote(xs.join(" "))} `.includes(` ${n} `));
}

export function verifyObjectionQuote(r: ObjectionResult, turns: readonly Turn[]): ObjectionResult {
  const v = { ...r, quote_found: quoteInOneChannel(r.client_quote, turns) };
  return r.client_decision === undefined ? v : { ...v, decision_quote_found: quoteInOneChannel(r.decision_quote ?? "", turns) };
}

function objectionInterpreter(validate: (x: unknown) => { ok: true; value: ObjectionResult } | { ok: false; why: string }) {
  return (out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: ObjectionResult } | { ok: false; why: string } => {
    if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
    if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
    if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
    let parsed: unknown;
    try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
    const v = validate(parsed);
    if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
    return { ok: true, result: verifyObjectionQuote(v.value, turns) };
  };
}
export const interpretObjection = objectionInterpreter(validateObjection);
export const interpretObjectionV2 = objectionInterpreter(validateObjectionV2);

export const OBJECTION_KIT = { build: buildObjectionRequest, interpret: interpretObjection };
export const OBJECTION_KIT_V2 = { build: buildObjectionRequestV2, interpret: interpretObjectionV2 };

/** Підписи для екрана: тип заперечення людською мовою. */
export const OBJECTION_TYPE_UA: Record<ObjectionType, string> = {
  price: "дорого", think: "подумаю / передзвоню сам", competitor: "порівнює, є інший перевізник", not_now: "не зараз", other: "інше", none: "—",
};
