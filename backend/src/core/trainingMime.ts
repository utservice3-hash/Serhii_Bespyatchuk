/**
 * 📄 ТИП ФАЙЛА НАВЧАННЯ — ОДНА КОПІЯ ПРАВИЛА (23.09.2026).
 *
 * 🔴 ЧОМУ ЦЕ ЗʼЯВИЛОСЬ. Перенос Академії Sereda приніс 143 документи, і в **84 із них**
 * (83 pdf + 1 docx, заміряно на проді 23.09) колонка `mime` порожня: Sereda віддавала
 * файл без `content-type`, а ми зберігали рівно те, що дав клієнт. Крок екрана малює
 * документ у вікні перегляду лише при `mime === "application/pdf"`, тож **59% перенесених
 * документів людина бачила сірим рядком «📄 назва · завантажити»** — файл на місці (перший
 * приклад «WELCOME TO UTS», 8 МБ), а відкрити його на екрані не можна.
 *
 * 🔴 ЧОМУ НЕ РАЗОВИЙ `UPDATE` ПО 84 РЯДКАХ, хоча він коротший. По-перше, `revert` коду не
 * відкочує дані — виправлення жило б далі за свою причину. По-друге, SQL-міграція стала б
 * ДРУГОЮ копією правила «розширення → тип», і наступний, хто додасть формат у код, мовчки
 * розійдеться з нею. Тому тип виводиться **на віддачі**, з одного місця, а колонка лишається
 * такою, якою її дав клієнт: у ній зберігається ФАКТ («браузер типу не назвав»), а не здогад.
 *
 * 🔴 ЗБЕРЕЖЕНИЙ MIME ВИГРАЄ В ВИВЕДЕНОГО ЗАВЖДИ. Розширення — здогад про вміст, заголовок від
 * клієнта — твердження про нього. Виводимо лише там, де твердження немає.
 *
 * ⚠️ МЕЖА, СВІДОМА: невідоме розширення дає `null`, а не «application/octet-stream». Порожній
 * тип екран уже вміє показати чесним рядком «📄 назва · завантажити»; вигаданий тип змусив би
 * браузер повірити в нього. Невідоме має читатись як невідоме.
 *
 * ⚠️ `svg` навмисно НЕ в списку, хоч це й зображення: файли навчання віддаються `inline`, а
 * inline-SVG виконує скрипт у нашому походженні. Поки віддача inline — svg лишається без типу.
 */

/** Розширення → тип. Лише те, що ми справді показуємо або віддаємо на збереження. */
const BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

/**
 * Тип за іменем файла. Регістр не має значення; невідоме розширення → `null`.
 * Береться ОСТАННЄ розширення: `звіт.pdf.zip` — це zip, а не pdf.
 */
export function mimeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? null;
}

/**
 * Тип, який показуємо: збережений, якщо він є; інакше виведений з першого імені,
 * що дало відповідь (зазвичай `stored_name`, далі — видима назва матеріалу).
 */
export function effectiveMime(stored: string | null | undefined, ...names: (string | null | undefined)[]): string | null {
  const kept = typeof stored === "string" ? stored.trim() : "";
  if (kept) return kept;
  for (const n of names) {
    const guess = mimeFromName(n);
    if (guess) return guess;
  }
  return null;
}
