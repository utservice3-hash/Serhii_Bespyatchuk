/**
 * 🔏 ПЕЧАТКА НА PDF (задача 5779, просив Сергій; Роман 20.10.2026: лише печатка, робити можуть усі, «Додати печатку»,
 * печаток скільки треба, крутити). Менеджер кладе готовий PDF, ставить печатки ЮТС/АвтоМув на будь-які сторінки —
 * сервер дописує їх ПОВЕРХ сторінки окремим шаром: текст документа лишається текстом, решта байтів сторінки не чіпається.
 *
 * Чим: pdf-lib 1.17.1 (MIT) — самодостатній UMD-бандл `vendor/pdf-lib.min.cjs`, як shevchenko (5461). Не npm: ланцюг
 * викату `npm ci` не робить. Не qpdf: на проді qpdf 7.1.1, а накладання (`--overlay`) зʼявилось лише у 8.4 (замір 20.10).
 *
 * Координати — як їх бачить людина в прев'ю (pdf.js): частки ВИДИМОЇ сторінки (CropBox, з урахуванням /Rotate),
 * лівий верхній кут печатки, діаметр — частка видимої ширини, кут — градуси за годинниковою. `placeOnPage` переводить
 * їх у простір сторінки PDF (початок унизу ліворуч, поворот проти годинникової) — і це єдине місце, де живе ця математика.
 */
import { createRequire } from 'node:module';

/* ── мінімальний опис pdf-lib, яким користуємось ── */
interface PdfImage { width: number; height: number }
interface PdfBox { x: number; y: number; width: number; height: number }
interface PdfPage {
  getCropBox(): PdfBox;
  getRotation(): { angle: number };
  drawImage(img: PdfImage, o: { x: number; y: number; width: number; height: number; rotate: unknown }): void;
}
interface PdfDoc { getPages(): PdfPage[]; getPageCount(): number; embedPng(png: Uint8Array): Promise<PdfImage>; save(): Promise<Uint8Array> }
interface PdfLib {
  PDFDocument: { load(b: Uint8Array, o?: { updateMetadata?: boolean }): Promise<PdfDoc> };
  degrees(d: number): unknown;
  EncryptedPDFError: new (...a: unknown[]) => Error;
}
let lib: PdfLib | null = null;
const pdfLib = (): PdfLib => (lib ??= createRequire(import.meta.url)('../vendor/pdf-lib.min.cjs') as PdfLib);

export type StampEnt = 'uts' | 'avm';
/** Одна печатка: сторінка з 1; x, y — лівий верхній кут, size — діаметр (частки видимої сторінки); rot — градуси за годинниковою. */
export interface Stamp { ent: StampEnt; page: number; x: number; y: number; size: number; rot: number }

export const MAX_STAMPS = 30;
export const SIZE_MIN = 0.05, SIZE_MAX = 0.5;

/** Список печаток із тіла запиту → перевірений список або текст відмови (сторінки звіряються пізніше, з файлом). */
export function parseStamps(raw: unknown): Stamp[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'Додайте хоча б одну печатку.';
  if (raw.length > MAX_STAMPS) return `Забагато печаток: ${raw.length} (до ${MAX_STAMPS}).`;
  const out: Stamp[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const n = (k: string) => Number(o[k]);
    const s: Stamp = { ent: o.ent as StampEnt, page: n('page'), x: n('x'), y: n('y'), size: n('size'), rot: n('rot') || 0 };
    const no = `Печатка ${i + 1}`;
    if (s.ent !== 'uts' && s.ent !== 'avm') return `${no}: печатка є лише в ЮТС і АвтоМув (у ФОП — тільки підпис).`;
    if (!Number.isInteger(s.page) || s.page < 1) return `${no}: невідома сторінка.`;
    if (![s.x, s.y, s.size, s.rot].every(Number.isFinite)) return `${no}: неправильне розташування.`;
    if (s.size < SIZE_MIN || s.size > SIZE_MAX) return `${no}: розмір поза межами.`;
    if (s.x < 0 || s.y < 0 || s.x + s.size > 1.001 || s.y > 1) return `${no}: печатка виходить за межі сторінки.`;
    if (s.rot < -360 || s.rot > 360) return `${no}: кут поза межами.`;
    out.push(s);
  }
  return out;
}

/** Видима сторінка: CropBox (W×H, зсув ox/oy) і /Rotate (0/90/180/270). */
export interface PageGeom { W: number; H: number; ox: number; oy: number; R: number }
export interface Placement { x: number; y: number; width: number; height: number; rotate: number }

/**
 * Печатка з координат прев'ю → параметри `drawImage` у просторі сторінки. `imgRatio` — висота/ширина картинки печатки.
 * Видима сторінка при /Rotate 90/270 має сторони навпаки. Центр печатки переводимо з видимих координат (початок угорі
 * ліворуч) у простір сторінки; картинку малюємо з поворотом R − θ проти годинникової (сторінка сама довертає її на R)
 * і зсуваємо так, щоб поворот ішов довкола центру, а не кута.
 */
export function placeOnPage(g: PageGeom, s: Stamp, imgRatio: number): Placement {
  const R = ((Math.round(g.R / 90) * 90) % 360 + 360) % 360;
  const [Wd, Hd] = R === 90 || R === 270 ? [g.H, g.W] : [g.W, g.H];
  const w = s.size * Wd, h = w * imgRatio;
  const dx = s.x * Wd + w / 2, dy = s.y * Hd + h / 2;                 // центр у видимих координатах
  let ux: number, uy: number;                                          // центр у просторі CropBox
  if (R === 90) { ux = dy; uy = dx; }
  else if (R === 180) { ux = g.W - dx; uy = dy; }
  else if (R === 270) { ux = g.W - dy; uy = g.H - dx; }
  else { ux = dx; uy = g.H - dy; }
  const rotate = R - s.rot;                                            // проти годинникової, як у PDF
  const a = rotate * Math.PI / 180;
  return {
    x: g.ox + ux - (w / 2 * Math.cos(a) - h / 2 * Math.sin(a)),
    y: g.oy + uy - (w / 2 * Math.sin(a) + h / 2 * Math.cos(a)),
    width: w, height: h, rotate,
  };
}

export class StampRefused extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

/** Накласти печатки. `pngs` — байти печаток юросіб (ті самі файли, що й у документах). Сторінки без печаток не чіпаються. */
export async function stampPdf(pdf: Uint8Array, stamps: Stamp[], pngs: Record<StampEnt, Uint8Array>): Promise<{ pdf: Uint8Array; pages: number }> {
  const { PDFDocument, degrees, EncryptedPDFError } = pdfLib();
  let doc: PdfDoc, pages: PdfPage[];
  // пошкоджений файл pdf-lib інколи «відкриває» і падає вже на сторінках — тому обидва кроки під однією відмовою
  try { doc = await PDFDocument.load(pdf, { updateMetadata: false }); pages = doc.getPages(); }
  catch (e) {
    // у UMD-збірці `EncryptedPDFError` транспільований у звичайний Error — `instanceof` хибний (замір 20.10), тож і за текстом
    if (e instanceof EncryptedPDFError || /is encrypted/i.test((e as Error)?.message ?? ''))
      throw new StampRefused('PDF захищений паролем — зніміть захист і завантажте ще раз.', 422);
    throw new StampRefused('Файл не читається як PDF.');
  }
  const bad = stamps.find((s) => s.page > pages.length);
  if (bad) throw new StampRefused(`У файлі ${pages.length} стор. — сторінки ${bad.page} немає.`);
  const img: Partial<Record<StampEnt, PdfImage>> = {};
  for (const s of stamps) {
    const im = img[s.ent] ??= await doc.embedPng(pngs[s.ent]);
    const p = pages[s.page - 1], c = p.getCropBox();
    const pl = placeOnPage({ W: c.width, H: c.height, ox: c.x, oy: c.y, R: p.getRotation().angle }, s, im.height / im.width);
    p.drawImage(im, { x: pl.x, y: pl.y, width: pl.width, height: pl.height, rotate: degrees(pl.rotate) });
  }
  return { pdf: await doc.save(), pages: pages.length };
}
