/**
 * 🎵 МУЗИКА НА ТИТУЛІ ПРЕЗЕНТАЦІЇ — ЧИСТІ ПРАВИЛА (задача «Додати музику в презентацію + фанфари», 09.11.2026).
 * Трек грає на першому слайді, поки люди збираються; завантажує Даша (керівництво), як фото команди. Без імпорту БД.
 *
 * Тип файла визначаємо за БАЙТАМИ, а не за назвою чи заявленим mime: PDF чи картинка під іменем «.mp3» — відмова.
 */

/** Межа розміру: трек на кілька хвилин у MP3 — 3–10 МБ; 20 МБ з запасом, але не «будь-що». */
export const MUSIC_MAX_BYTES = 20 * 1024 * 1024;
export const MUSIC_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
} as const;
export type MusicExt = keyof typeof MUSIC_TYPES;

const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));

/** Вид аудіо за першими байтами: MP3 (ID3-тег або кадр MPEG), M4A (контейнер `ftyp` з аудіо-брендом), OGG. */
export function sniffAudio(b: Uint8Array): MusicExt | null {
  if (b.length < 12) return null;
  if (ascii(b, 0, 3) === "ID3") return "mp3";
  // Кадр MPEG без тега: 11 біт синхронізації, шар не «зарезервований» (біти 1–2 другого байта ≠ 00).
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return "mp3";
  if (ascii(b, 4, 4) === "ftyp" && ["M4A ", "M4B ", "mp42", "isom", "iso2", "dash"].includes(ascii(b, 8, 4))) return "m4a";
  if (ascii(b, 0, 4) === "OggS") return "ogg";
  return null;
}

export function checkMusic(buf: Uint8Array | null): { ok: true; ext: MusicExt } | { ok: false; error: string } {
  if (!buf || buf.length === 0) return { ok: false, error: "файл музики порожній" };
  if (buf.length > MUSIC_MAX_BYTES) return { ok: false, error: "файл музики більший за 20 МБ" };
  const ext = sniffAudio(buf);
  if (!ext) return { ok: false, error: "це не аудіо: потрібен MP3, M4A або OGG" };
  return { ok: true, ext };
}

/** Імʼя на диску: корінь теки документів (її копіює нічний бекап, як і фото), префікс `music-`. */
export const musicStoredName = (uuid: string, ext: MusicExt): string => `music-${uuid}.${ext}`;

/** Назва треку для підпису у вкладці: з назви файла, без шляху й керуючих символів, до 120 знаків. */
export function musicTitle(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const t = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return t || null;
}
