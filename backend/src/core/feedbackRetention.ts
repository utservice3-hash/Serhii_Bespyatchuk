/**
 * 💬 ЗВОРОТНИЙ ЗВʼЯЗОК — ПРАВИЛА ФОТО Й ВИДАЛЕННЯ (рішення Романа 05.10.2026, варіант А).
 *
 * Чистий модуль без БД: його ВИКОНУЮТЬ гейти `#495`/`#497`, а роут і джоба беруть звідси
 * ті самі константи. Дві копії правила «що таке закрите» розійшлися б рівно так, як
 * розійшлися чипи «новий/постійний» (CLAUDE.md, «РОЗКРИТТЯ ПОЯСНЮЄ ЧИСЛО»).
 */

/** Закрите = «Вирішено» або «Відхилено». «Схвалено» — ще в роботі, такі не видаляються. */
export const FEEDBACK_CLOSED_STATUSES = ["resolved", "rejected"] as const;
/** Скільки днів закрите звернення живе до безповоротного видалення. */
export const FEEDBACK_RETENTION_DAYS = 30;
export const FEEDBACK_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const FEEDBACK_FILES_PER_ITEM = 5;

export const isClosedStatus = (s: string): boolean =>
  (FEEDBACK_CLOSED_STATUSES as readonly string[]).includes(s);

/**
 * Предикат видалення — ОДИН рядок SQL, і саме його кличе джоба. `closed_at IS NULL`
 * (ще не закрите або повернуте на розгляд) не проходить ніколи: `NULL < x` — не true.
 */
export const FEEDBACK_PURGE_WHERE =
  `status IN (${FEEDBACK_CLOSED_STATUSES.map((s) => `'${s}'`).join(", ")}) ` +
  `AND closed_at < now() - interval '${FEEDBACK_RETENTION_DAYS} days'`;

/** Дата видалення для підпису «видалиться ДД.ММ» — той самий строк, що в предикаті. */
export function purgeDate(closedAt: Date | null): Date | null {
  return closedAt ? new Date(closedAt.getTime() + FEEDBACK_RETENTION_DAYS * 86_400_000) : null;
}

/**
 * Тип картинки — ЗА БАЙТАМИ, а не за розширенням чи словами клієнта. Підпис файла
 * («image/png») пише браузер зі слів імені, тож `.exe`, перейменований на `.png`,
 * пройшов би перевірку mime, але не цю.
 */
export function imageKind(buf: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.length >= 12 && String.fromCharCode(...buf.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...buf.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}
