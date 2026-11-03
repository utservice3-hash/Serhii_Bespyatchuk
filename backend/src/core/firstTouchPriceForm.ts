import { callDateLine, dialogText, type GeminiOutcome, type Turn } from "./callAiProviders.js";
import { quoteInOneChannel } from "./callAiObjection.js";

/**
 * 💵 ЯК НАЗВАНО ЦІНУ (задача 7351, п.6; Юля 03.11.2026; рішення Романа 03.11.2026).
 *
 * Поділ: точна сума / вилка (від–до) / «від…» без верхньої межі — щоб бачити звʼязок форми ціни зі згодою клієнта.
 * Сума й реакція клієнта лишаються як є; «від…» і далі РАХУЄТЬСЯ названою ціною (відсоток «ціну назвали» й Звіт не
 * змінюються), лише видно окремим рядком. Після тесту до 06.11 Юля вирішить, чи зараховувати «від…».
 *
 * Чому окрема рубрика, а не розбір тексту суми (заміряно 03.11 на 539 названих цінах з 01.10): «п'ятнадцяти - двадцяти
 * тисяч» і «шість-сім» — вилки словами, «8500, 11-12 тис., 17 тис.» — кілька варіантів, «від» є лише в 27 цитатах.
 * Тому — коротка рубрика по ГОТОВІЙ розшифровці, лише для розмов, де основний розбір каже «ціну назвали», і з
 * дослівною цитатою, що мусить знайтись у розмові. Немає цитати чи вона не знайшлась — форма «не визначена».
 *
 * Межові випадки (пропозиції, прийняті Романом 03.11.2026):
 *   • кілька варіантів (різні авто чи умови), кожен точною сумою — «точна»;
 *   • «близько / в районі / десь 28 тис.» — «точна» (одне число);
 *   • «від X до Y», «20–22», «шість-сім» — «вилка»;
 *   • «від X», «не менше X», «від 2 € за км» — «від…»;
 *   • різні форми в одній розмові — найслабша: «від…» > «вилка» > «точна».
 */
export const RUBRIC_PRICE_FORM_V1 = "first-touch-price-form-v1";
/** З якого дня розмов рубрика ставиться сама: лише нові (Роман 03.11.2026: «тільки з сьогодні»). */
export const PRICE_FORM_FROM = "2026-11-03";

export const PRICE_FORMS = ["exact", "range", "from", "none"] as const;
export type PriceFormRaw = typeof PRICE_FORMS[number];
/** Форма, яку показуємо: `none` (модель суми не почула) на екрані — «не визначено», тобто `null`. */
export type PriceForm = Exclude<PriceFormRaw, "none">;
export interface PriceFormResult { form: PriceFormRaw; quote: string; quote_found?: boolean | null }

export const PRICE_FORM_SCHEMA = {
  type: "object",
  properties: {
    form: { type: "string", enum: [...PRICE_FORMS], description: "як менеджер назвав ціну: exact — точна сума; range — вилка від–до; from — «від…» без верхньої межі; none — суми не назвав" },
    quote: { type: "string", description: "дослівні слова менеджера з ціною; для none — порожньо" },
  },
  required: ["form", "quote"],
} as const;

export const PRICE_FORM_SYSTEM_PROMPT = [
  "Ти аналізуєш першу розмову менеджера логістичної компанії з клієнтом. Відповідь — JSON за схемою.",
  "Питання одне: У ЯКІЙ ФОРМІ МЕНЕДЖЕР НАЗВАВ КЛІЄНТУ ЦІНУ за це перевезення.",
  "form:",
  "  exact — одна конкретна сума («буде 38 тисяч», «26400», «4500 гривень»), зокрема приблизна одним числом («близько 28 тисяч», «в районі двадцяти»);",
  "  range — вилка з нижньою і верхньою межею («20–22 тисячі», «від 40 до 45», «шість-сім тисяч», «п'ятнадцять-двадцять»);",
  "  from — лише нижня межа без верхньої («від 90 тисяч», «не менше п'ятнадцяти», «від двох євро за кілометр»);",
  "  none — менеджер суми за це перевезення не назвав.",
  "Правила:",
  "1. Лише ціна, яку назвав МЕНЕДЖЕР. Бюджет клієнта, ціна іншого рейсу як приклад, обіцянка порахувати пізніше — не ціна.",
  "2. Кілька варіантів (різні машини чи умови), кожен точною сумою — exact.",
  "3. Різні форми в одній розмові — обери найслабшу: from важливіше за range, range — за exact.",
  "4. quote — дослівні слова менеджера, з яких видно форму; для none — порожньо.",
].join("\n");

export function buildPriceFormRequest(turns: readonly Turn[], maxOutputTokens: number, callAt: Date | null = null): Record<string, unknown> {
  const text = callAt ? `${callDateLine(callAt)}\n\n${dialogText(turns)}` : dialogText(turns);
  return {
    system_instruction: { parts: [{ text: PRICE_FORM_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: PRICE_FORM_SCHEMA } }, thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens },
  };
}

/** Сувора перевірка: форма поза переліком чи форма без цитати — відмова з причиною, а не тихе виправлення. */
export function validatePriceForm(x: unknown): { ok: true; value: PriceFormResult } | { ok: false; why: string } {
  if (!x || typeof x !== "object") return { ok: false, why: "не обʼєкт" };
  const o = x as Record<string, unknown>;
  if (typeof o.form !== "string" || !(PRICE_FORMS as readonly string[]).includes(o.form)) return { ok: false, why: "form поза переліком" };
  if (typeof o.quote !== "string") return { ok: false, why: "quote не рядок" };
  const quote = o.quote.trim();
  if (o.form !== "none" && !quote) return { ok: false, why: "форма є, а цитати немає" };
  return { ok: true, value: { form: o.form as PriceFormRaw, quote: o.form === "none" ? "" : quote } };
}

export function interpretPriceForm(out: GeminiOutcome, turns: readonly Turn[]): { ok: true; result: PriceFormResult } | { ok: false; why: string } {
  if (out.blockReason) return { ok: false, why: `запит заблоковано постачальником: ${out.blockReason}` };
  if (out.finishReason && out.finishReason !== "STOP") return { ok: false, why: `модель не завершила відповідь: ${out.finishReason}` };
  if (!out.text) return { ok: false, why: "модель повернула порожню відповідь" };
  let parsed: unknown;
  try { parsed = JSON.parse(out.text); } catch { return { ok: false, why: "відповідь моделі не JSON" }; }
  const v = validatePriceForm(parsed);
  if (!v.ok) return { ok: false, why: `відповідь моделі не за схемою: ${v.why}` };
  return { ok: true, result: { ...v.value, quote_found: v.value.form === "none" ? null : quoteInOneChannel(v.value.quote, turns) } };
}

export const PRICE_FORM_KIT = { build: buildPriceFormRequest, interpret: interpretPriceForm };

/**
 * Форма для екрана: лише з цитатою, що знайшлась у розмові (сумнів не стає формою). `null` — не розбирали (ціни не було,
 * розмова до `PRICE_FORM_FROM`, рубрика ще не дійшла), модель суми не почула, або цитати в розмові немає.
 */
export function priceFormOf(ai: PriceFormResult | null): PriceForm | null {
  if (!ai || ai.form === "none" || ai.quote_found !== true) return null;
  return ai.form;
}
