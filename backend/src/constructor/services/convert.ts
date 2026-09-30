/**
 * 🔁 КОНВЕРТЕР ФАЙЛІВ конструктора (екран K-15 макета Сергія, 30.09.2026). Чисті функції — без БД і мережі.
 *
 * У макеті конвертація жила в браузері (pdf.js + html2pdf). У дашборді бандл однофайловий (гейт #225), тож
 * важкі бібліотеки туди не кладемо — конвертує сервер тим, що вже має:
 *  - docx/txt/jpg/png → PDF: HTML-сторінка → той самий `htmlToPdf` (chrome-headless-shell), що й документи;
 *  - PDF → txt/docx: текст дає `pdftotext` (наявний `core/docText.extractText`), Word збирає `zipStore` Сергія.
 * Скан без текстового шару чесно дає порожній текст — OCR у дашборді немає, і вигадувати текст ми не будемо.
 */
import { zipStore } from './docgen.js';

const X = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Текст → абзаци: порожній рядок розділяє абзаци, одиничні переноси всередині абзацу зберігаються. */
export function splitParagraphs(text: string): string[] {
  return String(text).replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n')
    .split(/\n\s*\n+/).map((p) => p.replace(/[ \t]+\n/g, '\n').trim()).filter(Boolean);
}

const PAGE = (body: string) => `<!doctype html><html lang="uk"><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
body{font-family:'Times New Roman','Tinos','Liberation Serif',serif;font-size:12pt;line-height:1.45;color:#111}
p{margin:0 0 8pt;white-space:pre-wrap;text-align:justify}
img{display:block;max-width:100%;max-height:270mm;margin:0 auto}
</style></head><body>${body}</body></html>`;

/** Сторінка з абзаців — для docx/txt → PDF. */
export function textPageHtml(paras: string[]): string {
  return PAGE(paras.map((p) => `<p>${X(p)}</p>`).join('') || '<p></p>');
}

/** Сторінка з однією картинкою на всю ширину — для jpg/png → PDF. */
export function imagePageHtml(mime: 'image/jpeg' | 'image/png', b64: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('картинка пошкоджена');
  return PAGE(`<img src="data:${mime};base64,${b64}" alt="">`);
}

/** Абзаци → мінімальний коректний .docx (Times New Roman 12, вирівнювання по ширині). */
export function paragraphsDocx(paras: string[]): Uint8Array {
  const RF = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';
  const para = (p: string) => '<w:p><w:pPr><w:jc w:val="both"/><w:spacing w:after="160"/></w:pPr>'
    + p.split('\n').map((line, i) => `<w:r><w:rPr>${RF}<w:sz w:val="24"/></w:rPr>${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${X(line)}</w:t></w:r>`).join('')
    + '</w:p>';
  const body = (paras.length ? paras : ['']).map(para).join('')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418"/></w:sectPr>';
  return zipStore([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ]);
}

/** Тип вхідного файла для «→ PDF» за розширенням; решта — відмова словами. */
export function toPdfKind(name: string): 'docx' | 'txt' | 'image/jpeg' | 'image/png' | null {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'docx') return 'docx';
  if (ext === 'txt') return 'txt';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  return null;
}

/** Ім'я вихідного файла: та сама основа, нове розширення; лише безпечні символи в заголовку. */
export function outName(name: string, ext: string): string {
  const base = String(name).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_ -]/gu, '_').slice(0, 80).trim() || 'file';
  return `${base}.${ext}`;
}
