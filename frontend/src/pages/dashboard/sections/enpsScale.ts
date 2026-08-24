/**
 * 📊 ШКАЛА eNPS НА ФРОНТІ — ЄДИНА КОПІЯ, І ВОНА ПІД ГЕЙТОМ.
 *
 * 🔴 ЧОМУ КОПІЯ ВЗАГАЛІ Є. Класифікація періоду (хто промоутер, які відсотки, яка
 * смуга) приїжджає з сервера готовою — фронт її не рахує. Але пікер оцінки під час
 * зустрічі має розфарбувати ОДИН бал ще до будь-якого запиту, і тягти по HTTP колір
 * однієї кнопки безглуздо. Тому два числа живуть тут — і рівно тут.
 *
 * 🔴 ЩОБ КОПІЯ НЕ РОЗІЙШЛАСЬ МОВЧКИ, її звіряє гейт `#143c`: він транспілює ЦЕЙ файл і
 * `backend/src/oneOnOne/enps.ts` і вимагає однакової класифікації для КОЖНОГО бала
 * шкали плюс для значень поза нею. Доти порогів було чотири комплекти, і жоден нічого
 * не стеріг.
 *
 * ⚠️ Підпис під пікером БУДУЄТЬСЯ з цих чисел, а не написаний словами. Раніше він був
 * окремим рядком тексту — тобто ще однією копією правила, яка мовчки застаріла б
 * першої ж зміни шкали.
 */

export const ENPS_SCALE = { min: 0, max: 10, promoterFrom: 9, passiveFrom: 7 } as const;

export type EnpsClass = "promoter" | "passive" | "detractor" | "invalid";
export type EnpsTone = "green" | "amber" | "orange" | "red";

export function classifyEnps(score: number | null | undefined): EnpsClass {
  if (typeof score !== "number" || !Number.isInteger(score)) return "invalid";
  if (score < ENPS_SCALE.min || score > ENPS_SCALE.max) return "invalid";
  if (score >= ENPS_SCALE.promoterFrom) return "promoter";
  if (score >= ENPS_SCALE.passiveFrom) return "passive";
  return "detractor";
}

/** Як показуємо кожен клас. Емодзі — вимога власника (😊 · 😐 · 🙁). */
export const CLASS_UI: Record<Exclude<EnpsClass, "invalid">, { emoji: string; label: string; color: string }> = {
  promoter:  { emoji: "😊", label: "Промоутери",  color: "#16a34a" },
  passive:   { emoji: "😐", label: "Нейтральні",  color: "#d97706" },
  detractor: { emoji: "🙁", label: "Критики",     color: "#dc2626" },
};

/** Колір смуги приходить із сервера КЛЮЧЕМ (`tone`), а не числом — межі смуг фронт не знає. */
export const BAND_COLOR: Record<EnpsTone, string> = {
  green: "#16a34a", amber: "#d97706", orange: "#ea580c", red: "#dc2626",
};

/** Колір ОДНОГО бала в пікері. */
export function enpsColor(score: number): string {
  const c = classifyEnps(score);
  return c === "invalid" ? "var(--text-muted)" : CLASS_UI[c].color;
}

/** Підпис шкали — зібраний із чисел, а не переписаний словами. */
export const SCALE_CAPTION =
  `${ENPS_SCALE.min}-${ENPS_SCALE.passiveFrom - 1} критик · ` +
  `${ENPS_SCALE.passiveFrom}-${ENPS_SCALE.promoterFrom - 1} нейтрал · ` +
  `${ENPS_SCALE.promoterFrom}-${ENPS_SCALE.max} промоутер`;
