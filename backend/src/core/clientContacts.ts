/**
 * 📱 ОСТАННІЙ КОНТАКТ ІЗ КЛІЄНТОМ — з двох джерел, і обидва названі.
 *
 * Розмова Ringostat (billsec > 0) і ручний контакт (Viber/Telegram/email/дзвінок з особистого,
 * записаний менеджером зі скрином). «Останній контакт» = свіжіше з двох; джерело завжди
 * повертається разом із датою, бо «контакт був» без «як саме» знову змусить людину гадати.
 * Рішення Романа 17.09.2026: ручний контакт рахується як спроба реактивації нарівні з дзвінком.
 */
export const CONTACT_CHANNELS = [
  { key: "viber", label: "Viber" },
  { key: "telegram", label: "Telegram" },
  { key: "email", label: "Email" },
  { key: "call", label: "Дзвінок з особистого" },
  { key: "other", label: "Інше" },
] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number]["key"];
export const CONTACT_CHANNEL_KEYS: readonly string[] = CONTACT_CHANNELS.map((c) => c.key);
export const CONTACT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const CONTACT_IMAGE_MIMES: readonly string[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export interface LastContact { at: string; source: "talk" | "manual"; channel: string | null }

/** Свіжіше з розмови Ringostat і ручного контакту; `null`, якщо обох немає. */
export function lastContactOf(
  talkAt: string | null, manualAt: string | null, manualChannel: string | null,
): LastContact | null {
  const t = talkAt ? Date.parse(talkAt) : NaN;
  const m = manualAt ? Date.parse(manualAt) : NaN;
  if (Number.isNaN(t) && Number.isNaN(m)) return null;
  if (Number.isNaN(m) || (!Number.isNaN(t) && t >= m)) return { at: talkAt!, source: "talk", channel: null };
  return { at: manualAt!, source: "manual", channel: manualChannel };
}

/** Чи можна прийняти файл: лише зображення, не більше 5 МБ, не порожній. */
export function contactFileVerdict(mime: string | null, size: number): { ok: true } | { ok: false; error: string } {
  if (size <= 0) return { ok: false, error: "Файл порожній" };
  if (size > CONTACT_FILE_MAX_BYTES) return { ok: false, error: "Скрин завеликий (макс. 5 МБ)" };
  if (!mime || !CONTACT_IMAGE_MIMES.includes(mime)) return { ok: false, error: "Приймаються лише зображення (JPG, PNG, WebP, GIF)" };
  return { ok: true };
}

/** Видалити свій запис можна протягом доби; керівництво — завжди (рішення 17.09.2026). */
export function canDeleteContact(isAdminScope: boolean, ownerId: number | null, userId: number, createdAt: string, now: Date): boolean {
  if (isAdminScope) return true;
  if (ownerId !== userId) return false;
  return now.getTime() - Date.parse(createdAt) <= 24 * 60 * 60 * 1000;
}
