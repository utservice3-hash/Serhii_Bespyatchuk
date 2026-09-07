/**
 * 📰 ПІДПИСИ ЗМІН ДЛЯ НОВИНИ ПРО ВИКАТ — окремим файлом для ЛЮДЕЙ, не з комітів.
 *
 * 🔴 ЧОМУ НЕ КОМІТ-ПОВІДОМЛЕННЯ. Вони технічні за призначенням: «#352 ланцюг більше не
 * обривається після власного lockRelease» правдиве й нечитабельне для менеджера. Новина
 * адресована людям, які не знають слова «lockRelease», тож джерело тексту має бути
 * окремим — і писати його має той, хто робив зміну, у момент, коли ще памʼятає навіщо.
 *
 * 🔴 ПОРОЖНІЙ БЛОК — ЦЕ ВІДПОВІДЬ «НЕМАЄ ЩО СКАЗАТИ», А НЕ ЗБІЙ. Викат без видимих для
 * людей змін (рефакторинг, гейти, борги) не повинен породжувати новину «оновлено»: така
 * новина за тиждень навчить не читати всі інші. Тому `null` тут — штатний результат, і
 * гейт стверджує саме це, а не «порожньо = зелено».
 *
 * ⚠️ РОЗРІЗНЯЄМО ТРИ СТАНИ, а не два: файла немає · блок порожній · блок є. Перші два
 * дають однакове «новини не буде», але різні ПРИЧИНИ, і склеїти їх означало б не
 * помітити, що файл загубився при переїзді.
 */

/** Верхній блок `RELEASE_NOTES.md`: заголовок `## …` і текст до наступного `## `. */
export type ReleaseNote = { title: string; body: string };

/** Чому новини не буде — назване, а не мовчазне `null`. */
export type NoNoteReason = "no-file" | "empty-block";

export type ParsedNotes =
  | { note: ReleaseNote; reason?: undefined }
  | { note: null; reason: NoNoteReason };

/**
 * Розбір верхнього блоку. `raw === null` означає «файла немає» — читання файла
 * лишається викликачу, щоб функція була чистою й гейт не потребував диска.
 */
export function parseReleaseNotes(raw: string | null): ParsedNotes {
  if (raw === null) return { note: null, reason: "no-file" };

  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start === -1) return { note: null, reason: "empty-block" };

  const title = lines[start].slice(3).trim();
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

  // 🔴 Заголовок БЕЗ тіла — теж «порожній блок». Новина з самою датою в назві не каже
  // людині нічого, а виглядає як повідомлення: гірше за відсутність.
  if (!title || !body) return { note: null, reason: "empty-block" };
  return { note: { title, body } };
}
