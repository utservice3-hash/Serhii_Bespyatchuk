/**
 * HTML друкованого документа — порт printHTML() із затвердженого макета (v15).
 * Один шаблон на два споживачі:
 *  - серверний PDF (puppeteer page.pdf — векторний текст, кращий за html2pdf макета);
 *  - прев'ю в UI (iframe/див. ConstructorPage).
 *
 * CSS — у data/docCss.ts (витягнуто з макета програмно). Картинки — data:-URI
 * з docAssets.docImageDataUris, ті САМІ jpeg-байти, що йдуть у docx.
 */

import { ENTITIES } from '../data/entities.js';
import { MAIN_BODY, MAIN_THIRD } from '../data/legalTexts.js';
import { DOC_CSS } from '../data/docCss.js';
import {
  DocumentState, EntityKey, Seg,
  condRows, legalBlocks, preambleSegs, reqLines, docTitleParts, docDateStr, mainClauseText,
} from './docgen.js';

const esc = (s: string) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const segsHTML = (segs: Seg[]) => segs.map(x => x.b ? '<b>' + esc(x.t) + '</b>' : esc(x.t)).join('');

export interface PrintImages { sig?: string; stamp?: string } // data:-URI

/** Внутрішній фрагмент документа (без <html>) — 1:1 із макетом. */
export function printHTML(s: DocumentState, num: string, img: PrintImages = {}): string {
  const e = ENTITIES[s.ent];
  const { title, sub } = docTitleParts(s);
  const mainMode = s.doc === 'main';
  const rows = condRows(s);
  const legal = legalBlocks(s);
  const pl = s.doc === 'carr' ? 'перевізник' : 'клієнт';
  const other = pl === 'перевізник' ? 'ПЕРЕВІЗНИК' : 'ЗАМОВНИК';
  const otherSigner = (s.cp.dir || '_______________');
  const dateStr = mainMode ? (s.mainDate || '«___» ____________ 2026 р.') : docDateStr(s);

  let h = `<div class="dband"><span class="dmk">UTS</span>
      <span class="dco">${esc(('docName' in e && e.docName) || e.name)} · ${s.ent === 'fop' ? 'ІПН' : 'ЄДРПОУ'} ${esc(e.edrpou)} · ${esc(e.vat)}</span>
      <span class="dnum">№ ${esc(num)}</span></div>
    <h2>${title} № ${esc(num)}</h2><p class="sub">${sub}</p>
    <div class="dl"><span>м. Київ</span><span>${esc(dateStr)}</span></div>
    <p>${segsHTML(preambleSegs(s))}</p>`;

  if (mainMode) {
    (MAIN_BODY as ReadonlyArray<{ h?: string; n?: string; t?: string }>).forEach(b => {
      if (b.h) { h += `<h3 style="text-align:center">${esc(b.h)}</h3>`; return; }
      const t = mainClauseText(s, b.t || '', (MAIN_THIRD as Record<EntityKey, string>)[s.ent] || '');
      h += `<p><b>${esc(b.n || '')}</b> ${esc(t)}</p>`;
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
  h += `<h3 style="text-align:center">РЕКВІЗИТИ СТОРІН</h3><div class="rq2">
    <div><h4>${other}</h4>${rqHtml('their')}</div>
    <div><h4>ЕКСПЕДИТОР</h4>${rqHtml('our')}</div></div>
    <div class="sigs">
      <div class="cell">Від ${other === 'ПЕРЕВІЗНИК' ? 'Перевізника' : 'Замовника'}:<div class="ln"></div>
        Директор <b>${esc(otherSigner)}</b><br>М.П.</div>
      <div class="cell">Від Експедитора:<div class="ln"></div>
        ${s.ent === 'fop' ? 'ФОП ' : 'Директор '}<b>${esc(e.dirShort)}</b>${'stampImg' in e && e.stampImg ? '<br>М.П.' : ''}
        ${img.sig ? `<img class="simg" src="${img.sig}">` : ''}
        ${img.stamp ? `<img class="stimg" src="${img.stamp}">` : ''}
      </div>
    </div>
    <div class="sigend"></div>`;
  return h;
}

/**
 * Повна сторінка для puppeteer. Рекомендовані параметри page.pdf():
 *   format:'A4', printBackground:true,
 *   margin:{top:'10mm', right:'11mm', bottom:'12mm', left:'11mm'}
 * (ті самі поля, що в макеті). preferCSSPageSize не потрібен.
 */
export function fullPageHTML(s: DocumentState, num: string, img: PrintImages = {}): string {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;background:#fff}
${DOC_CSS}
</style></head>
<body><div class="docfmt">${printHTML(s, num, img)}</div></body></html>`;
}
