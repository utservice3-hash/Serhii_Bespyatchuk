import { callDateLine, dialogText, type GeminiOutcome, type Turn } from "./callAiProviders.js";
import { quoteInOneChannel } from "./callAiObjection.js";

/**
 * 🚛 ВИД ПЕРЕВЕЗЕННЯ — НЕ ОЦІНЮЄМО В «ПЕРШОМУ ДОТИКУ» (задача 7183, п.1; Юля 26.10.2026, тімліди й Сергій погодились).
 * На міжнародці, тралі й негабариті, цистернах, самоскидах і зерновозах ціну в першій розмові назвати майже неможливо,
 * тож такі розмови йдуть у «Виключені» з причиною і не входять у плитки, бал і графік. ДОВАНТАЖЕННЯ лишається в оцінці.
 *
 * Звідки знаємо (заміряно 28.10.2026: у CRM «Тип кузова» заповнений в одній угоді на всю базу, «Тип запиту» — у ~40%):
 *   • міжнародне — поле Kommo «Тип запиту = Міжнародні» (без AI) АБО розмова;
 *   • решта — лише розмова: окрема коротка рубрика по ГОТОВІЙ розшифровці (без повторного розпізнавання).
 * Виключаємо лише за прямими словами: модель дає вид і ДОСЛІВНУ цитату, і цитата мусить знайтись у розмові. Немає
 * цитати чи вона не знайшлась — розмова лишається в оцінці (сумнів — не привід виключати).
 */
export const RUBRIC_TRANSPORT_V1 = "first-touch-transport-v1";
/** З якої дати розмов рубрика ставиться сама — з початку вибірки «Першого дотику» (`FIRST_TOUCH_RULE.startDate`). */
export const TRANSPORT_FROM = "2026-09-20";
/** Значення поля Kommo «Тип запиту» (2097965) для міжнародки — той самий літерал, що `nominations.INTL_REQUEST_TYPE`. */
export const INTL_REQUEST_TYPE = "Міжнародні";

export const TRANSPORT_KINDS = ["regular", "international", "oversize", "tanker", "dump", "grain"] as const;
export type TransportKind = typeof TRANSPORT_KINDS[number];
export type ExcludedTransport = Exclude<TransportKind, "regular">;

export const TRANSPORT_UA: Record<ExcludedTransport, string> = {
  international: "міжнародне", oversize: "трал / негабарит", tanker: "цистерна", dump: "самоскид", grain: "зерновоз",
};

export interface TransportResult { kind: TransportKind; quote: string; quote_found?: boolean | null }

export const TRANSPORT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...TRANSPORT_KINDS], description: "вид перевезення за прямими словами розмови; сумнів — regular" },
    quote: { type: "string", description: "дослівні слова з розмови, з яких видно вид; для regular — порожньо" },
  },
  required: ["kind", "quote"],
} as const;

export const TRANSPORT_SYSTEM_PROMPT = [
  "Ти визначаєш ВИД ПЕРЕВЕЗЕННЯ в розмові логістичної компанії з клієнтом. Відповідь — JSON за схемою.",
  "kind:",
  "  international — маршрут перетинає кордон України: завантаження чи вивантаження за кордоном (Польща, Молдова, ЄС тощо), митниця, розмитнення;",
  "  oversize — трал, негабарит, важка техніка, яку везуть тралом (екскаватор, комбайн, трактор);",
  "  tanker — цистерна, наливний вантаж (паливо, олія, рідини наливом);",
  "  dump — самоскид (пісок, щебінь, ґрунт навалом);",
  "  grain — зерновоз (зерно, насіння навалом);",
  "  regular — усе інше: тент, рефрижератор, бус, контейнер, палети. ДОВАНТАЖЕННЯ (догруз, збірний вантаж) — теж regular.",
  "Правила:",
  "1. Лише за ПРЯМИМИ словами розмови. Не вгадуй за назвою вантажу чи міста. Не впевнений — regular.",
  "2. Кілька ознак — обери ту, через яку ціну складніше назвати одразу (international важливіше за решту).",
  "3. quote — дослівні слова з розмови, з яких видно вид («потрібен трал», «везти в Польщу»); для regular — порожньо.",
].join("\n");

export function buildTransportRequest(turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> {
  const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
  return {
    system_instruction: { parts: [{ text: TRANSPORT_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: TRANSPORT_SCHEMA } }, thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens },
  };
}

/** Сувора перевірка: вид поза переліком або «не звичайне» без цитати — відмова з причиною, а не тихе виправлення. */
export function validateTransport(x: unknown): { ok: true; value: TransportResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  if (typeof o.kind !== "string" || !(TRANSPORT_KINDS as readonly string[]).includes(o.kind)) return { ok: false, why: "kind поза переліком" };
  if (typeof o.quote !== "string") return { ok: false, why: "quote не рядок" };
  const quote = o.quote.trim();
  if (o.kind !== "regular" && !quote) return { ok: false, why: "вид не звичайний, а цитати немає" };
  return { ok: true, value: { kind: o.kind as TransportKind, quote: o.kind === "regular" ? "" : quote } };
}

export function interpretTransport(out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: TransportResult } | { ok: false; why: string } {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validateTransport(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: { ...v.value, quote_found: v.value.kind === "regular" ? null : quoteInOneChannel(v.value.quote, turns) } };
}

export const TRANSPORT_KIT = { build: buildTransportRequest, interpret: interpretTransport };

/**
 * Чи виключати розмову і з якою причиною. Kommo «Міжнародні» — без AI. AI — лише «не звичайне» з цитатою, що знайшлась
 * у розмові. `null` — розмова лишається в оцінці.
 */
export function transportExclusion(x: { ai: TransportResult | null; kommoInternational: boolean }): ExcludedTransport | null {
  if (x.kommoInternational) return "international";
  if (x.ai && x.ai.kind !== "regular" && x.ai.quote_found === true) return x.ai.kind;
  return null;
}
