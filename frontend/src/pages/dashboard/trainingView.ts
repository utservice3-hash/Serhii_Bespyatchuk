/**
 * 🎓 Чисті правила екрана «Навчання» (прохід 2b, 18.09.2026). Без React — їх виконує гейт `#547`.
 */

/**
 * Який вигляд «Навчання» показати ролі.
 * Кандидат проходить КУРС — по кроках, із замками й відсотком. Решта ролей бачить бібліотеку
 * деревом, як і досі: курсовий вигляд для менеджерів — зона сесії «Навчання», не цього проходу.
 */
export function trainingViewFor(roleKey: string | undefined): "candidate" | "library" {
  return roleKey === "candidate" ? "candidate" : "library";
}

/** YouTube/Vimeo/пряме відео → що вставляти. Одне правило на бібліотеку й на екран кандидата. */
export function embedUrl(raw: string): { iframe?: string; direct?: string } {
  const url = raw.trim();
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { iframe: `https://www.youtube.com/embed/${yt[1]}` };
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return { iframe: `https://player.vimeo.com/video/${vimeo[1]}` };
  if (/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(url)) return { direct: url };
  return { iframe: url }; // інший embed — пробуємо як iframe
}
