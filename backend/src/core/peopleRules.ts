/**
 * 📷 ФОТО СПІВРОБІТНИКІВ — ЧИСТІ ПРАВИЛА (22.09.2026). Без імпорту БД, щоб гейти бігли без `.env`.
 *
 * Одне фірмове фото на людину з реєстру `employees`. Показується скрізь, де є ця людина: презентація
 * зустрічі, номінації тижня, (далі) дошка пошани. Завантажують ті, хто має право сейфу
 * (`view_employee_secrets` — admin, ceo, opdir, kvp, hr; рішення Романа 22.09), бачать — усі залогінені.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sniffFileMime } from "./hiringRules.js";

/** Межа розміру файла, що приходить на сервер. Браузер зменшує фото до 800 px ще до відправки. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];

/**
 * Перевірка файла фото (#640). Тип визначаємо за БАЙТАМИ, а не за назвою чи заявленим mime: PDF,
 * порожній файл і будь-що не-картинка — відмова; понад 5 МБ — відмова.
 */
export function checkPhoto(buf: Uint8Array | null): { ok: true; mime: PhotoMime } | { ok: false; error: string } {
  if (!buf || buf.length === 0) return { ok: false, error: "файл фото порожній" };
  if (buf.length > PHOTO_MAX_BYTES) return { ok: false, error: "фото більше за 5 МБ" };
  const mime = sniffFileMime(buf);
  if (!mime || !(PHOTO_MIMES as readonly string[]).includes(mime)) return { ok: false, error: "це не фото: потрібен JPEG, PNG або WebP" };
  return { ok: true, mime: mime as PhotoMime };
}

/**
 * Імʼя файлу на диску: КОРІНЬ теки документів, префікс `photo-`. Корінь — бо нічний бекап
 * (`jobs/backupDocuments.ts`) копіює лише файли кореня, без підтек (#641).
 */
export const photoStoredName = (uuid: string, mime: PhotoMime): string =>
  `photo-${uuid}${{ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[mime]}`;

/**
 * Тека фото = КОРІНЬ теки документів, яку копіює нічний бекап (`jobs/backupDb.ts`: `DOCS_DIR` з
 * оточення, інакше `backend/documents`). Той самий перемикач і та сама тека за замовчуванням (#641):
 * куди дивиться копія, туди й лягає фото. Це також тека «Документів» і «Найму».
 */
export const photoDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DOCS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "documents");

export interface PhotoState { file: string | null; prev: string | null }
export type PhotoAction = { kind: "upload"; file: string } | { kind: "remove" } | { kind: "restore" };

/**
 * Перехід стану фото (#642). Кожна дія скасовна тим самим інтерфейсом:
 *  · «Завантажити/Замінити» — нове фото, попереднім стає поточне (якщо поточного немає — лишається старе попереднє);
 *  · «Прибрати» — фото зникає, але стає попереднім → «Повернути попереднє» його вертає;
 *  · «Повернути попереднє» — поточне й попереднє міняються місцями (повторне натискання — назад).
 */
export function nextPhotoState(cur: PhotoState, a: PhotoAction): { ok: true; state: PhotoState } | { ok: false; error: string } {
  if (a.kind === "upload") return { ok: true, state: { file: a.file, prev: cur.file ?? cur.prev } };
  if (a.kind === "remove") {
    if (!cur.file) return { ok: false, error: "фото й так немає" };
    return { ok: true, state: { file: null, prev: cur.file } };
  }
  if (!cur.prev) return { ok: false, error: "попереднього фото немає" };
  return { ok: true, state: { file: cur.prev, prev: cur.file } };
}

/** Версія фото для кешу браузера: змінюється разом із фото, тож нове фото не ховається за старим. */
export const photoVersion = (updatedAt: Date | string | null): number => (updatedAt ? new Date(updatedAt).getTime() : 0);
