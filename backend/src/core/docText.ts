/**
 * 🔎 ТЕКСТ ДОКУМЕНТА ДЛЯ ПОШУКУ — з чотирма ЧЕСНИМИ станами, а не «є текст / немає».
 *
 *   ok          — текст витягнуто;
 *   empty       — формат розібрано, але тексту немає (скан у PDF, порожній документ);
 *   unsupported — формат без тексту для нас (фото, архів, старий .doc);
 *   failed      — розбір зламався (пошкоджений файл, немає `pdftotext`), причина в `reason`.
 *
 * 🔴 `failed` ≠ `empty`. Інакше зламаний розбір читався б як «у документі нічого немає», і пошук
 * мовчки не знаходив би саме те, що зламалось. Екран пошуку показує, скільки документів НЕ шукались.
 */
import { execFile } from "child_process";
import { parseDocx, docxText, parseXlsx, xlsxText, decodeXml } from "./officeParse.js";

export type TextStatus = "ok" | "empty" | "unsupported" | "failed";
export interface TextResult { status: TextStatus; text: string | null; reason: string | null }

/** Стеля тексту одного документа в базі. */
export const MAX_TEXT_CHARS = 1_000_000;

export type DocFormat = "pdf" | "docx" | "xlsx" | "html" | "text" | "other";
export function formatOf(name: string, mime: string | null): DocFormat {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "html" || ext === "htm" || mime === "text/html") return "html";
  if (["txt", "csv", "md"].includes(ext) || mime === "text/plain" || mime === "text/csv") return "text";
  return "other";
}

export function htmlText(html: string): string {
  return decodeXml(html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " "));
}

export type PdfRunner = (path: string) => Promise<string>;
export const pdftotext: PdfRunner = (path) => new Promise((resolve, reject) => {
  execFile("pdftotext", ["-q", "-enc", "UTF-8", path, "-"], { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    if (err) reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error("на сервері немає pdftotext") : err);
    else resolve(stdout);
  });
});

const tidy = (s: string) => s.replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

export async function extractText(fmt: DocFormat, buf: Buffer, path: string, pdf: PdfRunner = pdftotext): Promise<TextResult> {
  try {
    let raw: string;
    if (fmt === "pdf") raw = await pdf(path);
    else if (fmt === "docx") raw = docxText(parseDocx(buf));
    else if (fmt === "xlsx") raw = xlsxText(parseXlsx(buf, 100_000, 200));
    else if (fmt === "html") raw = htmlText(buf.toString("utf8"));
    else if (fmt === "text") raw = buf.toString("utf8");
    else return { status: "unsupported", text: null, reason: null };
    const text = tidy(raw).slice(0, MAX_TEXT_CHARS);
    return text ? { status: "ok", text, reason: null } : { status: "empty", text: null, reason: fmt === "pdf" ? "у PDF немає текстового шару (скан)" : null };
  } catch (e) {
    return { status: "failed", text: null, reason: (e as Error).message.slice(0, 300) };
  }
}
