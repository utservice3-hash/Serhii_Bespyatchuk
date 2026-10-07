/**
 * CSS друкованого документа — ЗГЕНЕРОВАНО з затвердженого макета (v20, оформлення «Б», 15.10)
 * командою: node --experimental-strip-types tools/docCssFromMockup.ts — руками не правити.
 * Шар 1 (.docfmt) — базова верстка: Times New Roman, таблиця, реквізити, підпис+печатка (absolute у .cell),
 *   білий спейсер .sigend (лише для html2pdf макета; у друці Chromium ховається — @media print).
 * Шар 2 (.doc-b, .ent-*) — «Б»: шапка з логотипом юрособи, акцент (ЮТС червоний, АвтоМув/ФОП графіт),
 *   реквізити в картках, рядки таблиці не розриваються, рамка адреси для оригіналів (.orig-mini).
 * Шар 3 (.dens-*) — щільність: d1 / dc / d95 (заявки, автопідгонка під 3 сторінки), dm (основний договір, 8 стор.).
 * Тест tests/printTemplate.test.ts звіряє цей рядок із макетом.
 */
export const DOC_CSS = `
.docfmt{font-family:'Times New Roman','Tinos','Liberation Serif',serif;font-size:11pt;line-height:1.45;color:#111}
.docfmt .sigend{height:26pt}
.docfmt h2{font-size:15pt;font-weight:700;text-align:center;margin:0 0 2pt;letter-spacing:.02em}
.docfmt .sub{text-align:center;font-size:10.5pt;margin:0 0 10pt;color:#222}
.docfmt .dl{display:flex;justify-content:space-between;font-size:10.5pt;margin:0 0 12pt}
.docfmt p{margin:0 0 7pt;text-align:justify;text-indent:32pt}
.docfmt h3{font-size:11.5pt;font-weight:700;margin:10pt 0 4pt}
.docfmt table{width:100%;border-collapse:collapse;margin:8pt 0 14pt;font-size:10pt;line-height:1.35}
.docfmt td{border:.6pt solid #555;padding:5pt 7pt;vertical-align:top}
.docfmt td.v2{font-weight:700;font-size:10.5pt}
.docfmt td.k{width:42%;background:#f6f4f1;color:#222}
.docfmt .rq2{display:grid;grid-template-columns:1fr 1fr;gap:26pt;margin-top:8pt;font-size:9.8pt;line-height:1.55;break-inside:avoid;page-break-inside:avoid}
.docfmt .rq2 h4{margin:0 0 5pt;font-size:10pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.docfmt .sigs{display:grid;grid-template-columns:1fr 1fr;gap:18pt;margin-top:4pt;padding-top:14pt;padding-bottom:17pt;break-inside:avoid;page-break-inside:avoid}
.docfmt .cell{position:relative;min-height:80px;font-size:9.5pt}
.docfmt .ln{border-bottom:1pt solid #14161c;margin-top:30pt}
.docfmt .simg{position:absolute;left:14pt;bottom:2pt;width:62pt;mix-blend-mode:multiply}
.docfmt .stimg{position:absolute;left:58pt;bottom:-10pt;width:82pt;transform:rotate(-8deg);mix-blend-mode:multiply}
.docfmt .dband{background:#17181c;color:#fff;display:flex;align-items:center;gap:10pt;padding:8pt 14pt; font-size:8pt;-webkit-print-color-adjust:exact;print-color-adjust:exact;margin:0 0 10pt}
.docfmt .dband .dmk{background:#c5141c;font-weight:800;letter-spacing:.08em;padding:2pt 6pt;border-radius:4pt}
.docfmt .dband .dco{color:#c9ccd2;font-weight:600}
.docfmt .dband .dnum{margin-left:auto;font-family:var(--mono);font-size:7.5pt}
@media print{.docfmt .sigend{display:none}}
.docfmt.doc-b{--acc:#c30010}
.docfmt.doc-b.ent-avm,.docfmt.doc-b.ent-fop{--acc:#2b2f3a}
.doc-b .dband{background:#fff;color:#17181c;border-left:4pt solid var(--acc);border-bottom:.75pt solid #e3ddd7;padding:6pt 2pt 6pt 10pt;margin:0 0 12pt;font-size:8.5pt;gap:10pt}
.doc-b .dband .dlogo{height:21pt;width:auto;display:block;flex:none}
.doc-b .dband .dco{color:#17181c;font-weight:600}
.doc-b .dband .dnum{color:var(--acc);border:1pt solid var(--acc);border-radius:3pt;padding:2pt 7pt;font-size:8.5pt;font-weight:600}
.doc-b h2{color:#17181c}
.doc-b .sub{color:#5a5f6b}
.doc-b h3{color:var(--acc)}
.doc-b table{border-left:2.5pt solid var(--acc)}
.doc-b td{border:.5pt solid #d8d2cc}
.doc-b td.k{background:#f8f5f2;color:#5a5f6b}
.doc-b .rq2{gap:14pt}
.doc-b .rq2 > div{background:#f8f6f4;border:.5pt solid #ebe5df;border-radius:4pt;padding:8pt 10pt}
.doc-b .rq2 h4{color:var(--acc)}
.dens-d1{font-size:10.5pt;line-height:1.4}
.dens-d1 p{margin:0 0 3.5pt}
.dens-d1 h3{font-size:11pt;margin:8pt 0 3pt}
.dens-d1 table{font-size:9.5pt;margin:5pt 0 10pt}
.dens-d1 td{padding:3pt 7pt}
.dens-d1 td.v2{font-size:10pt}
.dens-d1 .rq2{font-size:9.5pt;line-height:1.48}
.dens-dc{font-size:10pt;line-height:1.22}
.dens-dc .dband{padding:5pt 2pt 5pt 9pt;margin:0 0 8pt}
.dens-dc .dband .dlogo{height:19pt}
.dens-dc h2{font-size:13.5pt}
.dens-dc .sub{margin:0 0 6pt;font-size:9.5pt}
.dens-dc .dl{margin:0 0 7pt;font-size:9.5pt}
.dens-dc p{margin:0 0 1.5pt;text-indent:24pt}
.dens-dc h3{font-size:10.5pt;margin:5pt 0 2pt}
.dens-dc table{font-size:9pt;line-height:1.2;margin:4pt 0 7pt}
.dens-dc td{padding:2pt 5pt}
.dens-dc td.v2{font-size:9.5pt}
.dens-dc td.k{width:46%}
.dens-dc .rq2{font-size:9pt;line-height:1.28;margin-top:3pt;gap:12pt}
.dens-dc .rq2 > div{padding:6pt 9pt}
.dens-dc .sigs{padding-top:6pt}
.dens-d95{font-size:9.5pt;line-height:1.2}
.dens-d95 .dband{padding:5pt 2pt 5pt 9pt;margin:0 0 7pt}
.dens-d95 .dband .dlogo{height:18pt}
.dens-d95 h2{font-size:13pt}
.dens-d95 .sub{margin:0 0 5pt;font-size:9pt}
.dens-d95 .dl{margin:0 0 6pt;font-size:9pt}
.dens-d95 p{margin:0 0 1pt;text-indent:24pt}
.dens-d95 h3{font-size:10pt;margin:4pt 0 2pt}
.dens-d95 table{font-size:8.5pt;line-height:1.18;margin:3pt 0 6pt}
.dens-d95 td{padding:1.5pt 5pt}
.dens-d95 td.v2{font-size:9pt}
.dens-d95 td.k{width:46%}
.dens-d95 .rq2{font-size:8.5pt;line-height:1.25;margin-top:3pt;gap:12pt}
.dens-d95 .rq2 > div{padding:5pt 8pt}
.dens-d95 .sigs{padding-top:5pt}
.dens-dm{font-size:9.5pt;line-height:1.22}
.dens-dm .dband{padding:5pt 2pt 5pt 9pt;margin:0 0 8pt}
.dens-dm .dband .dlogo{height:19pt}
.dens-dm h2{font-size:13.5pt}
.dens-dm .sub{margin:0 0 6pt;font-size:9.5pt}
.dens-dm .dl{margin:0 0 7pt;font-size:9.5pt}
.dens-dm p{margin:0 0 1.5pt;text-indent:24pt}
.dens-dm h3{font-size:10pt;margin:6pt 0 2pt}
.dens-dm .rq2{font-size:9pt;line-height:1.28;margin-top:3pt;gap:12pt}
.dens-dm .rq2 > div{padding:6pt 9pt}
.dens-dm .sigs{padding-top:6pt}
.doc-b p.dcl{text-indent:-32pt;padding-left:32pt}
.doc-b p.dcl b.dno{display:inline-block;min-width:32pt;text-indent:0}
.doc-b h3.dsec{border-bottom:.5pt solid #e3ddd7;padding-bottom:1.5pt}
.doc-b h3{break-after:avoid}
.doc-b .rqb{break-inside:avoid;page-break-inside:avoid}
.doc-b tr{break-inside:avoid}
.doc-b .dband .dlogo-avm{height:17pt}
.doc-b .orig-mini{margin:4pt 0 0;border:.75pt solid var(--acc);border-radius:3pt;padding:3.5pt 8pt 4pt;font-size:8.5pt;line-height:1.35;color:#17181c;text-indent:0;break-inside:avoid}
.doc-b .orig-mini b{color:var(--acc)}
`;
