/**
 * Серверний PDF — векторний друк HTML документа браузером (на відміну від html2pdf у макеті, растр):
 * менші файли, чіткий друк, пошук по тексту. Поля ті самі, що в макеті: 10/11/12/11 мм. Пагінацію
 * тримає CSS шаблона (break-inside:avoid на .sigs/.rq2) — «різана печатка» тут неможлива.
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

/** Шлях до chrome-headless-shell на сервері. Без нього PDF чесно відмовляє, а не падає 500-ю. */
export function chromePath(): string | null {
  const p = (process.env.CONSTRUCTOR_CHROME_PATH ?? '').trim();
  return p || null;
}

export class PdfUnavailable extends Error {}

/**
 * Поля макета (10/11/12/11 мм) і друк фонів (темна смуга, сірі клітинки таблиці умов).
 * `.sigend` (білий спейсер 26 pt під підписами) — для браузерної нарізки html2canvas у макеті; у векторному
 * друку він лише виштовхував ПОРОЖНЮ останню сторінку, коли документ займав сторінку вщерть (заміряно
 * 30.09.2026: клієнтська разова — 4 сторінки, четверта біла). Від різаної печатки й далі стереже
 * `padding-bottom` і `break-inside:avoid` на `.sigs`.
 */
export const PRINT_CSS = '<style>@page{size:A4;margin:10mm 11mm 12mm 11mm}'
  + 'html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}'
  + '.docfmt .sigend{display:none}</style>';

/**
 * Сторінка для друку: та сама `fullPageHTML`, плюс `PRINT_CSS` ПЕРЕД `</head>` — тобто ПІСЛЯ CSS документа.
 * Порядок не косметичний: `.docfmt .sigend` має ту саму специфічність, що й у `DOC_CSS`, і правило, вставлене
 * раніше, мовчки програвало (заміряно 30.09.2026: з ним — так само 4 сторінки). `height:0` теж не лікує —
 * лише `display:none` (заміряно: 4 → 3 сторінки, остання з текстом).
 */
export function printable(fullHtml: string): string {
  return fullHtml.includes('</head>') ? fullHtml.replace('</head>', PRINT_CSS + '</head>') : PRINT_CSS + fullHtml;
}

export async function htmlToPdf(fullHtml: string): Promise<Uint8Array> {
  const chrome = chromePath();
  if (!chrome) throw new PdfUnavailable('PDF на сервері не налаштовано (CONSTRUCTOR_CHROME_PATH). Word працює.');
  const dir = await mkdtemp(join(tmpdir(), 'ctor-pdf-'));
  try {
    const src = join(dir, 'doc.html');
    const out = join(dir, 'doc.pdf');
    await writeFile(src, printable(fullHtml), 'utf8');
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
