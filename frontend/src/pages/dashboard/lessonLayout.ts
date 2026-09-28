/**
 * 📘 РОЗКЛАДКА УРОКУ ЯК У SEREDA — ЧИСТЕ ПРАВИЛО (27.09.2026, рішення Романа: «все як в середі»).
 *
 * Заміряно на живому уроці Sereda «Welcome to UTS»: зверху — те, що ДИВЛЯТЬСЯ (pdf-переглядач, відео),
 * під ним — текст уроку, нижче — блок «Вкладення» (назва, розмір, кнопка завантаження), внизу — «Далі».
 * Цей файл вирішує лише ЩО куди йде; як воно виглядає — `LessonBody.tsx`.
 *
 * 🔴 ВКЛАДЕННЯ-PDF ЛИШАЄТЬСЯ ВКЛАДЕННЯМ, ЯКЩО В УРОЦІ Є ЩО ДИВИТИСЬ. У Sereda «WELCOME TO UTS (5.2 MB)» у
 * «Вкладеннях» — це інший файл, ніж презентація (8 МБ) у переглядачі, і він лише завантажується. Роль частини
 * важить більше за її тип. Виняток — урок, де дивитись нічого: тоді pdf-вкладення ще й у вікні (`#735`).
 *
 * 🔴 БЕЗ ІМПОРТІВ, свідомо: гейт `#728` транспілює й ВИКОНУЄ цей файл, а не читає його.
 */

export type LessonShow = "pdf" | "image" | "video" | "embed" | "link" | "text" | "download";

export interface LessonSource {
  id: number; title: string; kind: string; url: string | null; mime: string | null;
  sizeBytes: string | number | null; hasFile: boolean; content: string | null;
}
export interface LessonPartSource extends LessonSource { role: "main" | "attachment" }
export interface LessonItem { id: number; title: string; url: string | null; mime: string | null; sizeBytes: number | null; hasFile: boolean; show: LessonShow; content: string | null }
export interface LessonLayout { main: LessonItem[]; text: string | null; attachments: LessonItem[] }

/** Як частину ПОКАЗАТИ: за типом і mime. Невідомий файл — на завантаження, а не порожнє місце. */
export function showOf(x: Pick<LessonSource, "kind" | "mime" | "url">): LessonShow {
  if (x.kind === "video_embed") return "embed";
  if (x.kind === "link") return "link";
  if (x.kind === "text") return "text";
  const m = (x.mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return "download";
}

const item = (x: LessonSource): LessonItem => ({
  id: x.id, title: x.title, url: x.url, mime: x.mime, hasFile: x.hasFile, content: x.content,
  sizeBytes: x.sizeBytes == null || x.sizeBytes === "" ? null : Number(x.sizeBytes),
  show: showOf(x),
});
const blank = (s: string | null | undefined): boolean => !s || !s.trim();

/**
 * Урок = головний матеріал + його частини.
 *  • текстовий головний дає ТЕКСТ уроку; нетекстовий — стає першим у «main» (або вкладенням, якщо його не
 *    можна показати), а його опис — текстом;
 *  • частини «main» — у тіло, у порядку, в якому прийшли; ті, що показати не можна (docx) — у вкладення;
 *  • частини «attachment» — у вкладення, незалежно від типу.
 */
export function lessonLayout(head: LessonSource, parts: readonly LessonPartSource[] = []): LessonLayout {
  const main: LessonItem[] = [];
  const attachments: LessonItem[] = [];
  let text: string | null = null;

  if (head.kind === "text") text = blank(head.content) ? null : head.content;
  else {
    const h = item(head);
    (h.show === "download" ? attachments : main).push(h);
    if (!blank(head.content)) text = head.content;
  }
  for (const p of parts) {
    const it = item(p);
    if (p.role === "attachment" || it.show === "download") attachments.push(it);
    else if (it.show === "text") text = [text, p.content].filter((t) => !blank(t)).join("\n\n") || null;
    else main.push(it);
  }

  /* 🔁 ВКЛАДЕННЯ, ЯКЕ Є ТИМ САМИМ ФАЙЛОМ, ЩО Й У ВІКНІ, — НЕ ДУБЛЮЄМО. Заміряно 28.09: у всіх 11 уроках із
     презентацією та сама презентація лежить ще й серед вкладень (той самий розмір). Sereda її зі списку ховає
     (API — «2 вкладення», на сторінці — одне). Той самий файл = той самий розмір і тип. */
  const same = (a: LessonItem, b: LessonItem) => a.sizeBytes != null && a.sizeBytes === b.sizeBytes && (a.mime ?? "") === (b.mime ?? "");
  const shownInBody = [...main];
  const list = attachments.filter((a) => !shownInBody.some((m) => same(a, m)));

  /* 📄 УРОК БЕЗ ТОГО, ЩО ДИВИТИСЬ, АЛЕ З PDF-ВКЛАДЕННЯМ — PDF У ВІКНІ. Роман, 28.09: «відкрив сторінку, а пдфа
     немає». Заміряно: 79 уроків — текст + pdf-вкладення без презентації; документ був лише «на завантаження».
     Показуємо перший такий pdf у переглядачі й ЛИШАЄМО його у «Вкладеннях»: із переглядача файл не зберегти. */
  if (!main.some((m) => m.show === "pdf" || m.show === "video" || m.show === "image" || m.show === "embed")) {
    const pdf = list.find((a) => a.show === "pdf" && a.hasFile);
    if (pdf) main.push(pdf);
  }
  return { main, text, attachments: list };
}

/** Розмір для людини: «340 КБ», «5.2 МБ». Маленьке — у КБ, бо «0.0 МБ» читається як порожній файл. */
export function sizeLabel(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
