/**
 * HTML друкованого документа — порт printHTML() із затвердженого макета (v20, оформлення «Б», 15.10).
 * Один шаблон на два споживачі:
 *  - серверний PDF (puppeteer page.pdf — векторний текст, кращий за html2pdf макета);
 *  - прев'ю в UI (iframe у ConstructorPage — повна сторінка з CSS, /preview).
 *
 * CSS — у data/docCss.ts (витягнуто з макета; тест звіряє). Картинки — data:-URI
 * з docAssets.docImageDataUris, ті САМІ png-байти, що йдуть у docx.
 *
 * Класи контейнера (docClass): docfmt doc-b ent-<юрособа> dens-<щільність>.
 * Щільність обирає pdfRenderer.renderDocumentPdf (автопідгонка під 3 сторінки).
 */

import { ENTITIES } from '../data/entities.js';
import { MAIN_BODY, MAIN_THIRD } from '../data/legalTexts.js';
import { DOC_CSS } from '../data/docCss.js';
import {
  DocumentState, EntityKey, Seg, Density, FOOT_TITLE, densSteps,
  condRows, legalBlocks, preambleSegs, reqLines, docTitleParts, docDateStr, mainClauseText,
} from './docgen.js';

const esc = (s: string) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const segsHTML = (segs: Seg[]) => segs.map(x => x.b ? '<b>' + esc(x.t) + '</b>' : esc(x.t)).join('');

export interface PrintImages { logo?: string; sig?: string; stamp?: string } // data:-URI

/** Внутрішній фрагмент документа (без <html>) — 1:1 із макетом. */
export function printHTML(s: DocumentState, num: string, img: PrintImages = {}): string {
  const e = ENTITIES[s.ent];
  const orig: string | undefined = 'orig' in e ? e.orig : undefined;
  const { title, sub } = docTitleParts(s);
  const mainMode = s.doc === 'main';
  const rows = condRows(s);
  const legal = legalBlocks(s);
  const pl = s.doc === 'carr' ? 'перевізник' : 'клієнт';
  const other = pl === 'перевізник' ? 'ПЕРЕВІЗНИК' : 'ЗАМОВНИК';
  const otherSigner = (s.cp.dir || '_______________');
  const dateStr = mainMode ? (s.mainDate || '«___» ____________ 2026 р.') : docDateStr(s);

  // логотип юрособи (ЮТС, АвтоМув); ФОП — без логотипа (рішення 14–15.10)
  const logo = img.logo ? `<img class="dlogo${s.ent === 'avm' ? ' dlogo-avm' : ''}" src="${img.logo}" alt="${esc(e.code)}">` : '';
  let h = `<div class="dband">${logo}
      <span class="dco">${esc(('docName' in e && e.docName) || e.name)} · ${s.ent === 'fop' ? 'ІПН' : 'ЄДРПОУ'} ${esc(e.edrpou)} · ${esc(e.vat)}</span>
      <span class="dnum">№ ${esc(num)}</span></div>
    <h2>${title} № ${esc(num)}</h2><p class="sub">${sub}</p>
    <div class="dl"><span>м. Київ</span><span>${esc(dateStr)}</span></div>
    <p>${segsHTML(preambleSegs(s))}</p>`;

  if (mainMode) {
    // основний договір: розділ — h3.dsec; пункт — номер стовпчиком (p.dcl > b.dno, без пробілу)
    (MAIN_BODY as ReadonlyArray<{ h?: string; n?: string; t?: string }>).forEach(b => {
      if (b.h) { h += `<h3 class="dsec">${esc(b.h)}</h3>`; return; }
      const t = mainClauseText(s, b.t || '', (MAIN_THIRD as Record<EntityKey, string>)[s.ent] || '');
      h += `<p class="dcl"><b class="dno">${esc(b.n || '')}</b>${esc(t)}</p>`;
    });
  } else {
    if (legal) h += `<p>${esc(legal[0] as string)}</p>`;
    h += `<h3>2. Основні умови перевезення:</h3><table>` +
      rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v2">${v ? esc(v) : '—'}</td></tr>`).join('') + `</table>`;
    legal!.slice(1).forEach(b => {
      h += (typeof b === 'object') ? `<h3>${esc(b.h)}</h3>` : `<p>${esc(b)}</p>`;
    });
  }

  const rqHtml = (side: 'our' | 'their') =>
    reqLines(s, side).map((l, i) => i === 0 ? '<b>' + esc(l) + '</b>' : esc(l)).join('<br>');
  // .rqb — «РЕКВІЗИТИ СТОРІН» не відривається від карток на іншу сторінку
  h += `<div class="rqb"><h3 style="text-align:center">РЕКВІЗИТИ СТОРІН</h3><div class="rq2">
    <div><h4>${other}</h4>${rqHtml('their')}</div>
    <div><h4>ЕКСПЕДИТОР</h4>${rqHtml('our')}</div></div></div>
    <div class="sigs">
      <div class="cell">Від ${other === 'ПЕРЕВІЗНИК' ? 'Перевізника' : 'Замовника'}:<div class="ln"></div>
        Директор <b>${esc(otherSigner)}</b><br>М.П.</div>
      <div class="cell">Від Експедитора:<div class="ln"></div>
        ${s.ent === 'fop' ? 'ФОП ' : 'Директор '}<b>${esc(e.dirShort)}</b>${'stampImg' in e && e.stampImg ? '<br>М.П.' : ''}
        ${img.sig ? `<img class="simg" src="${img.sig}">` : ''}
        ${img.stamp ? `<img class="stimg" src="${img.stamp}">` : ''}
      </div>
    </div>${orig ? `
    <div class="orig-mini"><b>Адреса для надсилання оригіналів документів:</b> ${esc(orig)}</div>` : ''}
    <div class="sigend"></div>`;
  return h;
}

/** Класи контейнера документа — ті самі, що docClass() у макеті. */
export const docClass = (ent: EntityKey, dens: Density) => `docfmt doc-b ent-${ent} dens-${dens}`;

/**
 * Повна сторінка для puppeteer (і для iframe-прев'ю). Параметри page.pdf() — у pdfRenderer.htmlToPdf:
 *   A4, printBackground, поля 10/11/15/11 мм (низ 15 — під колонтитул), footerTemplate.
 */
export function fullPageHTML(s: DocumentState, num: string, img: PrintImages = {}, dens?: Density): string {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<style>
:root{--mono:"JetBrains Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace}
html,body{margin:0;padding:0;background:#fff}
${DOC_CSS}
</style></head>
<body><div class="${docClass(s.ent, dens || densSteps(s)[0])}">${printHTML(s, num, img)}</div></body></html>`;
}

/** Колонтитул puppeteer: «Разовий договір № N · сторінка X з Y» (6 пт, сірий) — як у макеті. */
export function footerTemplate(s: DocumentState, num: string): string {
  return '<div style="width:100%;padding:0 11mm;font-family:Times New Roman,Tinos,Liberation Serif,serif;font-size:8px;color:#7c8090;' +
    'display:flex;justify-content:space-between">' +
    `<span>${esc(FOOT_TITLE[s.doc] || 'Договір')} № ${esc(num)}</span>` +
    '<span>сторінка <span class="pageNumber"></span> з <span class="totalPages"></span></span></div>';
}
