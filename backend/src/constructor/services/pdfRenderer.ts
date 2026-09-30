/**
 * Серверний PDF через puppeteer — на відміну від html2pdf у макеті (растр),
 * page.pdf() дає векторний текст: менші файли, чіткий друк, пошук по тексту.
 * Поля ті самі, що в макеті: 10/11/12/11 мм. Пагінацію тримає CSS шаблона
 * (break-inside:avoid на .sigs/.rq2) — «різана печатка» тут неможлива, а
 * порожній хвіст останньої сторінки Chromium-друк не створює (на відміну від
 * html2canvas-зрізів у браузерній версії).
 *
 * 🔧 ПІДКЛЮЧЕННЯ ДО ДАШБОРДА (30.09.2026) — дві зміни проти пакета Сергія, решта як була:
 *
 * 1. `puppeteer-core` + `CONSTRUCTOR_CHROME_PATH` замість повного `puppeteer`. Повний пакет
 *    сам тягне Chrome (~260 МБ) у `npm ci`, а ланцюг викату залежностей не ставить узагалі —
 *    браузер кладеться на сервер один раз, окремо, і шлях до нього — у `.env`.
 *    📐 Заміряно на прод-хості 30.09.2026: chrome-headless-shell 154 стартує на glibc 2.28,
 *    бібліотек не бракує, 8-сторінковий документ — 0,28 с і ~100 МБ.
 *
 * 2. БРАУЗЕР НА КОЖЕН ДОКУМЕНТ, А НЕ ОДИН НА ПРОЦЕС. У пакеті був синглтон, що живе поруч
 *    із сервером увесь час. Хост (CloudLinux LVE) уже вбивав довгоживучий другий процес за
 *    1–2 хвилини (DoD п.7, 05.08.2026) — і вбитий синглтон лишив би `browserP` на мертвому
 *    браузері до рестарту. Запуск на документ коштує частку секунди і не лишає нічого живого.
 */
import type { Browser } from 'puppeteer-core';

/** Шлях до chrome-headless-shell на сервері. Без нього PDF чесно відмовляє, а не падає 500-ю. */
export function chromePath(): string | null {
  const p = (process.env.CONSTRUCTOR_CHROME_PATH ?? '').trim();
  return p || null;
}

export class PdfUnavailable extends Error {}

export async function htmlToPdf(fullHtml: string): Promise<Uint8Array> {
  const executablePath = chromePath();
  if (!executablePath) throw new PdfUnavailable('PDF на сервері не налаштовано (CONSTRUCTOR_CHROME_PATH). Word працює.');
  const { default: puppeteer } = await import('puppeteer-core');
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath, headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
    });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'load' }); // data:-URI картинок вантажаться синхронно
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '11mm', bottom: '12mm', left: '11mm' },
    });
    return new Uint8Array(pdf);
  } finally {
    // Закрити за будь-якого результату: живий браузер після запиту — рівно те, від чого ми тікаємо.
    if (browser) await browser.close().catch(() => undefined);
  }
}
