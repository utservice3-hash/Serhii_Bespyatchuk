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
  const key = (filtered.length > 0 ? filtered : words).join(" ").trim();

  return key.length > 0 ? key : null;
}
