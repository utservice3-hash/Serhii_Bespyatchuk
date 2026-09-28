import { fetchWithRetry, VendorError, type HttpDeps, type RetryPolicy } from "./callAiHttp.js";

/**
 * 🎧 ЗАПИС РОЗМОВИ З RINGOSTAT — ОДИН ФАЙЛ, У ПАМʼЯТІ, ЗІ СТЕЛЕЮ РОЗМІРУ.
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах», прохід A, коміт ③.
 *
 * 🔴 ЧОМУ БАЙТИ, А НЕ `source_url` ElevenLabs. Документація ElevenLabs дозволяє передати URL
 * замість файла, але URL запису Ringostat відкривається БЕЗ логіна (`docs/RINGOSTAT_CALLS.md`) —
 * тобто віддати його третій стороні означає роздати доступ до розмови ще одному сервісу з
 * невідомим строком зберігання логів. Байти ми качаємо самі й віддаємо лише їх.
 *
 * 🔴 ЧОМУ У ПАМʼЯТІ, А НЕ У ТИМЧАСОВОМУ ФАЙЛІ. Хвилина телефонного WAV 8 кГц стерео — ~1.9 МБ;
 * стеля розміру зупиняє читання, щойно її перевищено (а не після), тож памʼять обмежена числом,
 * а не довжиною розмови. Тимчасовий файл дав би ще одне місце, де лежить розмова, і ще один
 * шлях, який треба прибирати після падіння процесу.
 *
 * ⚖️ СТАНИ «ЗАПИСУ НЕМАЄ» — ЧЕСНІ Й РІЗНІ. Вони НЕ є збоєм постачальника і НЕ коштують грошей:
 *   no_url     — у дзвінка немає посилання на запис;
 *   not_found  — Ringostat відповів 404/410;
 *   empty      — файл порожній;
 *   too_large  — більше за стелю (читання зупинено на стелі);
 *   not_wav    — не RIFF/WAVE: тривалість і канали невідомі, тож вартість наперед не порахувати;
 *   too_long   — довше за межу multichannel ElevenLabs (документація: 1 година).
 * Збій мережі чи 5xx — інше: це `VendorError`, і рядок повертається в чергу.
 */

export type RecordingUnavailable = "no_url" | "not_found" | "empty" | "too_large" | "not_wav" | "too_long";

export const RECORDING_UNAVAILABLE_UA: Record<RecordingUnavailable, string> = {
  no_url: "у дзвінка немає посилання на запис",
  not_found: "Ringostat не віддав запис (не знайдено)",
  empty: "файл запису порожній",
  too_large: "файл запису більший за стелю розміру",
  not_wav: "запис не у форматі WAV — тривалість і канали невідомі",
  too_long: "запис довший за межу розпізнавання по каналах (1 година)",
};

/** Межа multichannel за документацією ElevenLabs (сторінка суперечить собі: беремо меншу). */
export const MULTICHANNEL_MAX_SEC = 3600;

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  durationSec: number;
}

/**
 * Заголовок WAV: канали, частота, тривалість. Тривалість — з розміру блоку `data` і
 * `byteRate`; якщо блок оголошено більшим за файл (запис потоком), беремо фактичні байти.
 */
export function wavInfo(buf: Uint8Array): WavInfo | null {
  if (buf.length < 12) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12;
  let fmt: { channels: number; sampleRate: number; byteRate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        byteRate: dv.getUint32(body + 8, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt || fmt.byteRate <= 0 || fmt.channels <= 0) return null;
      const dataBytes = Math.min(size, buf.length - body);
      return { channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bits, durationSec: dataBytes / fmt.byteRate };
    }
    off = body + size + (size % 2);
  }
  return null;
}

export type DownloadOutcome =
  | { ok: true; bytes: Uint8Array; info: WavInfo }
  | { ok: false; unavailable: RecordingUnavailable };

export interface DownloadOpts extends RetryPolicy {
  maxBytes: number;
}

/**
 * Завантажує запис. Стеля розміру перевіряється двічі: за `Content-Length` (не читаючи тіла) і
 * під час читання (заголовка може не бути або він бреше) — потік скасовується на стелі.
 */
export async function downloadRecording(deps: HttpDeps, url: string | null | undefined, opts: DownloadOpts): Promise<DownloadOutcome> {
  if (!url || !url.trim()) return { ok: false, unavailable: "no_url" };
  let res: Response;
  try {
    res = await fetchWithRetry(deps, { vendor: "Ringostat (запис)", url, init: () => ({ method: "GET" }) }, opts);
  } catch (e) {
    if (e instanceof VendorError && e.kind === "not_found") return { ok: false, unavailable: "not_found" };
    throw e;
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, unavailable: "too_large" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, unavailable: "too_large" };
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { ok: false, unavailable: "empty" };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  const info = wavInfo(bytes);
  if (!info) return { ok: false, unavailable: "not_wav" };
  if (info.durationSec > MULTICHANNEL_MAX_SEC) return { ok: false, unavailable: "too_long" };
  return { ok: true, bytes, info };
}
