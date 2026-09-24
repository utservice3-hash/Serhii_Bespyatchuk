/**
 * 📎 ЩО ВІЛЬНО ЗАВАНТАЖИТИ В НАВЧАННЯ — ОДНЕ МІСЦЕ (23.09.2026, прохання Романа «має бути
 * можливість додавати фото та відео»).
 *
 * 🔴 ЧОМУ ЦЕ ЯДРО, А НЕ ДВІ ПЕРЕВІРКИ. Межу розміру знали ОБИДВА боки і кожен своїм числом:
 * у роуті `MAX_BYTES = 45 МБ`, у формі бібліотеки `MAX_MB = 45`. Поки числа збігались, це
 * виглядало нормально; розійшлися б вони мовчки — і людина діставала б 413 **після** хвилини
 * завантаження, тобто дізнавалась би про межу найдорожчим способом. Тепер число одне, а
 * `#716` червоніє, якщо завести другу копію.
 *
 * 🔴 ТИПУ ФАЙЛА ДОСІ НЕ ПЕРЕВІРЯВ НІХТО — заміряно 23.09: у `POST /material` стояла лише
 * межа розміру, тож у теку навчання можна було покласти `.exe` чи `.html`, а `/file` віддає
 * її `inline` авторизованим. Білий список закриває саме це.
 *
 * ⚠️ `svg` і `html` свідомо ПОЗА списком, хоч перший і є зображенням: файли віддаються
 * `inline`, тобто виконалися б у нашому походженні. Хочеш схему — png або pdf.
 *
 * ⚠️ СТЕЛЯ 45 МБ — рішення, а не технічна межа (тіло запиту тримає 140 МБ). Файл їде в памʼяті
 * процесу цілком, а цей хост уже вбивав нам Node за памʼять; два одночасні завантаження по
 * 90 МБ дали б ~250 МБ сплеском. Великі відео — посиланням (YouTube/Vimeo), як і досі.
 */

/** Стеля одного файла. ОДНЕ число на сервер і фронт — див. `#716`. */
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
export const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

/**
 * Дозволені типи. Ключ — те, що присилає браузер або що ми вивели з розширення
 * (`core/trainingMime.ts`); значення — як називаємо це людині у відмові.
 */
export const ALLOWED_UPLOAD: Record<string, string> = {
  "image/png": "зображення",
  "image/jpeg": "зображення",
  "image/webp": "зображення",
  "image/gif": "зображення",
  "image/heic": "зображення",
  "video/mp4": "відео",
  "video/webm": "відео",
  "video/quicktime": "відео",
  "audio/mpeg": "аудіо",
  "audio/mp4": "аудіо",
  "audio/wav": "аудіо",
  "application/pdf": "документ",
  "application/msword": "документ",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "документ",
  "application/vnd.ms-excel": "таблиця",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "таблиця",
  "application/vnd.ms-powerpoint": "презентація",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "презентація",
  "text/plain": "текст",
  "text/csv": "текст",
};

/** Для `accept` у формі — щоб у діалозі вибору одразу було видно, що фото й відео можна. */
export const ACCEPT_ATTR = Object.keys(ALLOWED_UPLOAD).join(",");

export type UploadVerdict = { ok: true; mime: string } | { ok: false; status: 400 | 413; reason: string };

/**
 * Чи приймаємо цей файл. `mime` — уже виведений (`effectiveMime`), тобто «порожній» означає
 * «тип невідомий навіть за розширенням», а не «браузер промовчав».
 *
 * 🔴 Відмова НАЗИВАЄ причину і межу: «не той тип» і «завеликий» — різні поломки, і людина
 * має бачити, котра з них її, а не спільне «не вдалося зберегти».
 */
export function checkUpload(mime: string | null, sizeBytes: number): UploadVerdict {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, status: 400, reason: "Файл порожній" };
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    const mb = Math.ceil(sizeBytes / (1024 * 1024));
    return { ok: false, status: 413, reason: `Файл ${mb} МБ — більше за межу ${MAX_UPLOAD_MB} МБ. Велике відео додайте посиланням (YouTube/Vimeo).` };
  }
  const key = (mime ?? "").trim().toLowerCase().split(";")[0];
  if (!key) return { ok: false, status: 400, reason: "Не вдалося визначити тип файла — перейменуйте його з розширенням (напр. .pdf, .png, .mp4)" };
  if (!ALLOWED_UPLOAD[key]) return { ok: false, status: 400, reason: `Тип «${key}» не приймаємо. Можна: фото, відео, документи, таблиці, презентації.` };
  return { ok: true, mime: key };
}
