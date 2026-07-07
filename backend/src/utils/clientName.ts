const LEGAL_ENTITY_PHRASES = [
  "товариство з обмеженою відповідальністю",
  "общество с ограниченной ответственностью",
];

const LEGAL_ENTITY_TOKENS = [
  "тов", "пп", "фоп", "пат", "ооо", "зат", "тзов", "прат",
];

export function normalizeClientName(rawName: string | null | undefined): string | null {
  if (!rawName) return null;

  let name = rawName.toLowerCase();
  for (const phrase of LEGAL_ENTITY_PHRASES) {
    name = name.split(phrase).join(" ");
  }
  name = name.replace(/["'«»“”]/g, " ");
  name = name.replace(/[.,]/g, " ");
  name = name.replace(/[^\p{L}\p{N}\s]/gu, " ");

  const words = name.split(/\s+/).filter(Boolean);
  const filtered = words.filter((word) => !LEGAL_ENTITY_TOKENS.includes(word));
  // Join WITHOUT spaces so spacing/apostrophe variants of the same company map to
  // one key (e.g. «СМАР ТЕКС»/«СМАРТЕКС» → "смартекс", «Курʼєр»/«Кур єр» → "куреєр").
  const key = (filtered.length > 0 ? filtered : words).join("").trim();

  return key.length > 0 ? key : null;
}

/** True if the raw name contains a legal-entity marker (ТОВ/ФОП/ООО/...). */
export function isLegalEntityName(rawName: string | null | undefined): boolean {
  if (!rawName) return false;
  const lower = rawName.toLowerCase();
  if (LEGAL_ENTITY_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  const words = lower.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.some((word) => LEGAL_ENTITY_TOKENS.includes(word));
}

/**
 * Normalizes a phone number to digits only, keeping the last 10 digits
 * (covers a leading country code or trunk "0" being present or not).
 */
export function normalizePhone(rawPhone: string | null | undefined): string | null {
  if (!rawPhone) return null;
  const digits = rawPhone.replace(/\D/g, "");
  if (digits.length < 9) return null;
  return digits.slice(-10);
}
