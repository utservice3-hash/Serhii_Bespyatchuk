/**
 * 🔏 КОДИ ПІДПИСУ Й ПРИВʼЯЗКИ TELEGRAM — чиста логіка без БД (розділ 9 ТЗ, рівень 2).
 *
 * Дві речі, які тут доводяться гейтами, бо без них підпис кодом не вартий нічого:
 *  1. код підпису привʼязаний до ФАЙЛА І ХЕША ВЕРСІЇ: код, надісланий на v1, не підпише v2
 *     (правило 9.3 ТЗ «заміна файлу анулює підпис» діє вже на етапі коду);
 *  2. код одноразовий, живе 5 хв і має 3 спроби — після чого його треба надсилати заново.
 * Токен привʼязки — те саме, але без файла й з 10 хв.
 */

export const SIGN_CODE_TTL_MS = 5 * 60_000;
export const LINK_TOKEN_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;

export interface CodeRecord {
  code: string;
  fileId: number | null;
  sha256: string | null;
  version: number | null;
  attempts: number;
  expiresAt: Date | string;
  usedAt: Date | string | null;
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: "expired" | "used" | "attempts" | "wrong_version" | "mismatch"; attemptsLeft: number };

/** 6 цифр, без провідних нулів не боїмось — це рядок. `rand` підмінюється в тестах. */
export function generateSignCode(rand: () => number = Math.random): string {
  return String(Math.floor(rand() * 1_000_000)).padStart(6, "0");
}

/** Токен deep-link: URL-безпечний, до 64 символів (обмеження Telegram на `start=`). */
export function generateLinkToken(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url").slice(0, 48);
}

/**
 * Перевірка коду підпису. Порядок значущий: спершу «мертві» стани (використано, прострочено,
 * спроби), потім версія документа, потім сам код. Версія — ПЕРЕД кодом, щоб правильний код на
 * чужу версію не «зʼїв» спробу як «не збігся», а сказав, що саме сталось.
 */
export function verifySignCode(
  rec: CodeRecord, input: string, expected: { fileId: number; sha256: string; version: number }, now: Date,
): VerifyOutcome {
  const left = Math.max(0, MAX_ATTEMPTS - rec.attempts);
  if (rec.usedAt != null) return { ok: false, reason: "used", attemptsLeft: 0 };
  if (new Date(rec.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: "expired", attemptsLeft: 0 };
  if (rec.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "attempts", attemptsLeft: 0 };
  if (rec.fileId !== expected.fileId || rec.sha256 !== expected.sha256 || rec.version !== expected.version) {
    return { ok: false, reason: "wrong_version", attemptsLeft: left };
  }
  if (rec.code !== String(input ?? "").trim()) return { ok: false, reason: "mismatch", attemptsLeft: Math.max(0, left - 1) };
  return { ok: true };
}

/** Токен привʼязки: живий рівно один раз і до строку. */
export function linkTokenState(rec: { expiresAt: Date | string; usedAt: Date | string | null }, now: Date): "ok" | "used" | "expired" {
  if (rec.usedAt != null) return "used";
  if (new Date(rec.expiresAt).getTime() <= now.getTime()) return "expired";
  return "ok";
}

/**
 * Чи слати повідомлення про офер: РІВНО ОДИН РАЗ на версію (рішення власника 15.09.2026, вечір:
 * «одне повідомлення без нагадування»). Лише неархівований і непідписаний на поточній версії;
 * `remindedAt` скидається при новій версії, бо нова версія — новий підпис.
 */
export function notifyDue(
  f: { section: string; archivedAt: Date | string | null; signedCurrent: boolean; remindedAt: Date | string | null },
): boolean {
  if (f.section !== "offer" || f.archivedAt != null || f.signedCurrent) return false;
  return f.remindedAt == null;
}

/** Текст повідомлення з кодом — тут, щоб тест бачив, що в ньому є код, назва й версія. */
export function signCodeMessage(code: string, docName: string, version: number): string {
  return `🔏 Код для підпису «${docName}» (версія ${version}): ${code}\nДіє 5 хвилин. Якщо ви не підписуєте цей документ — просто проігноруйте.`;
}
