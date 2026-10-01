/**
 * CSS друкованого документа — ВИТЯГНУТО ПРОГРАМНО з затвердженого макета (v15).
 * Це і є «вигляд, який затвердив Сергій»: Times New Roman 11pt/1.45, таблиця 10pt,
 * реквізити 9.8pt у дві колонки, підпис+печатка поруч (absolute у .cell),
 * білий спейсер .sigend і break-inside:avoid на .sigs/.rq2 (пагінація без різаних печаток).
 * Правити тільки синхронно з макетом і пере-затвердженням вигляду.
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
.docfmt .dband{background:#17181c;color:#fff;display:flex;align-items:center;gap:10pt;padding:8pt 14pt;
.docfmt .dband .dmk{background:#c5141c;font-weight:800;letter-spacing:.08em;padding:2pt 6pt;border-radius:4pt}
.docfmt .dband .dco{color:#c9ccd2;font-weight:600}
.docfmt .dband .dnum{margin-left:auto;font-family:var(--mono);font-size:7.5pt}
`;
