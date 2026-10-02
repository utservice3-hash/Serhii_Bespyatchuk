/**
 * Серверний PDF — векторний друк HTML документа браузером (на відміну від html2pdf у макеті, растр):
 * менші файли, чіткий друк, пошук по тексту. Пагінацію тримає CSS шаблона (break-inside:avoid на
 * .sigs/.rq2/.rqb/рядках таблиці) — «різана печатка» тут неможлива.
 *
 * 📄 v2 ПАКЕТА (оформлення «Б», 14–15.10, передано 01.10.2026): поля 10/11/15/11 мм (низ — під колонтитул
 * «Разовий договір № N · сторінка X з Y»), автопідгонка заявки під 3 сторінки (`renderDocumentPdf`),
 * лічильник сторінок (`countPdfPages`). У пакеті колонтитул — `footerTemplate` puppeteer; тут той самий
 * текст друкують поля сторінки CSS (`@page { @bottom-left / @bottom-right }`, Chrome ≥ 131 — заміряно на
 * 154 01.10.2026), бо CLI-друк шаблонів колонтитула не має.
 *
 * 🔧 ПІДКЛЮЧЕННЯ ДО ДАШБОРДА (30.09.2026) — проти пакета Сергія змінено ЛИШЕ спосіб запуску браузера:
 *
 * 1. НУЛЬ ЗАЛЕЖНОСТЕЙ: не `puppeteer`, а прямий виклик `chrome-headless-shell --print-to-pdf`.
 *    Ланцюг викату порівнює `package-lock.json` бази й гілки і ЗУПИНЯЄТЬСЯ на розбіжності (`deploy.ts`,
 *    крок `test`), а залежностей не ставить узагалі — тобто нова npm-залежність вимагала б ручного
 *    `npm ci` на проді. Прямий виклик робить те саме, що `page.pdf()`, без жодного пакета — у дусі
 *    `docgen.ts` Сергія («нуль залежностей»). Шлях до браузера — `CONSTRUCTOR_CHROME_PATH` у `.env`.
 *    📐 Заміряно на прод-хості 30.09.2026: chrome-headless-shell 154 стартує на glibc 2.28, бібліотек
 *    не бракує, 8-сторінковий документ — 0,28 с і ~100 МБ.
 *
 * 2. ПРОЦЕС НА КОЖЕН ДОКУМЕНТ. У пакеті браузер жив постійно поруч із сервером; хост (CloudLinux LVE)
 *    уже вбивав довгоживучий другий процес за 1–2 хвилини (DoD п.7, 05.08.2026). Тут процес стартує,
 *    друкує і завершується; стеля часу — 30 с, тимчасові файли прибираються за будь-якого результату.
 *
 * 3. Поля й фони — CSS-ом (`@page`, `print-color-adjust`), бо CLI не має `margin`/`printBackground`.
 *    Вставляються тут, у копію сторінки для друку: шаблон Сергія (`printTemplate.ts`) не змінено.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { densSteps, MAX_PAGES, FOOT_TITLE, type DocumentState, type Density } from './docgen.js';
import { fullPageHTML, type PrintImages } from './printTemplate.js';

/** Шлях до chrome-headless-shell на сервері. Без нього PDF чесно відмовляє, а не падає 500-ю. */
export function chromePath(): string | null {
  const p = (process.env.CONSTRUCTOR_CHROME_PATH ?? '').trim();
  return p || null;
}

export class PdfUnavailable extends Error {}

/**
 * Поля «Б» (10/11/15/11 мм) і друк фонів (смуга, клітинки умов, картки реквізитів). `.sigend` (білий спейсер
 * під підписами) — для браузерної нарізки html2canvas у макеті; у векторному друку він виштовхував ПОРОЖНЮ
 * останню сторінку (заміряно 30.09.2026), тож ховаємо його й тут, хоч DOC_CSS v2 має для цього `@media print`.
 */
export const PRINT_CSS = '<style>@page{size:A4;margin:10mm 11mm 15mm 11mm}'
  + 'html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}'
  + '.docfmt .sigend{display:none}</style>';

/** Рядок для `content:"…"` у CSS: лапки й зворотні риски — екрановано, переноси — пробіл. */
const cssStr = (t: string) => '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';

/**
 * Колонтитул як у `footerTemplate` пакета: ліворуч «<назва> № N», праворуч «сторінка X з Y»; Times, 8 px, сірий.
 * Порожній `title` — без колонтитула.
 */
export function footerCss(title: string): string {
  if (!title) return '';
  const font = "font-family:'Times New Roman','Tinos','Liberation Serif',serif;font-size:8px;color:#7c8090;vertical-align:middle";
  return `<style>@page{@bottom-left{content:${cssStr(title)};${font}}`
    + `@bottom-right{content:"сторінка " counter(page) " з " counter(pages);${font}}}</style>`;
}

/**
 * Сторінка для друку: та сама `fullPageHTML`, плюс `PRINT_CSS` (і колонтитул) ПЕРЕД `</head>` — тобто ПІСЛЯ
 * CSS документа. Порядок не косметичний: `.docfmt .sigend` має ту саму специфічність, що й у `DOC_CSS`, і
 * правило, вставлене раніше, мовчки програвало (заміряно 30.09.2026).
 */
export function printable(fullHtml: string, footerTitle = ''): string {
  const css = PRINT_CSS + footerCss(footerTitle);
  return fullHtml.includes('</head>') ? fullHtml.replace('</head>', css + '</head>') : css + fullHtml;
}

export async function htmlToPdf(fullHtml: string, footerTitle = ''): Promise<Uint8Array> {
  const chrome = chromePath();
  if (!chrome) throw new PdfUnavailable('PDF на сервері не налаштовано (CONSTRUCTOR_CHROME_PATH). Word працює.');
  const dir = await mkdtemp(join(tmpdir(), 'ctor-pdf-'));
  try {
    const src = join(dir, 'doc.html');
    const out = join(dir, 'doc.pdf');
    await writeFile(src, printable(fullHtml, footerTitle), 'utf8');
    await new Promise<void>((resolve, reject) => {
      execFile(chrome, [
        '--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--font-render-hinting=none',
        `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${out}`, pathToFileURL(src).href,
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err) => (err ? reject(new PdfUnavailable(`PDF не сформувався: ${err.message.split('\n')[0]}. Word працює.`)) : resolve()));
    });
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Кількість сторінок у PDF Chromium (об'єкти /Type /Page, без /Pages) — як у пакеті. */
export function countPdfPages(pdf: Uint8Array): number {
  return (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

export interface RenderedPdf { pdf: Uint8Array; pages: number; dens: Density; overflow: boolean }
export type PdfRender = (fullHtml: string, footerTitle: string) => Promise<Uint8Array>;

/**
 * PDF документа з автопідгонкою під 3 сторінки (рішення 14–15.10) — логіка пакета без змін: стартова щільність
 * за типом (клієнтська d1, перевізницька dc), 4-та сторінка → крок щільніше до d95; основний — dm без підгонки;
 * не влізло й так — віддаємо як є з `overflow: true`. `render` підміняється в гейтах (без браузера).
 */
export async function renderDocumentPdf(s: DocumentState, num: string, img: PrintImages, render: PdfRender = htmlToPdf): Promise<RenderedPdf> {
  let out: RenderedPdf | null = null;
  for (const dens of densSteps(s)) {
    const pdf = await render(fullPageHTML(s, num, img, dens), footerTitle(s, num));
    const pages = countPdfPages(pdf);
    out = { pdf, pages, dens, overflow: s.doc !== 'main' && pages > MAX_PAGES };
    if (s.doc === 'main' || pages <= MAX_PAGES) break;
  }
  return out!;
}

/** Текст лівої частини колонтитула — той самий, що `footerTemplate` пакета і `footer1.xml` у Word. */
export const footerTitle = (s: DocumentState, num: string) => `${FOOT_TITLE[s.doc] || 'Договір'} № ${num}`;
