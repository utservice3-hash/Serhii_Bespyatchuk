import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { canZoomIn, canZoomOut, pageAtScroll, zoomIn, zoomLabel, zoomOut } from "../pdfViewerMath";
import "./training.css";

/**
 * 📄 ПЕРЕГЛЯДАЧ PDF ЯК У SEREDA (24.09.2026, рішення Романа: «точна копія середи, прям такий самий
 * перегляд пдф»). Один на всі екрани навчання: крок курсу, бібліотека, екран кандидата.
 *
 * 🔴 ЩО СКОПІЙОВАНО — ЗА ЗАМІРОМ, А НЕ З ПАМʼЯТІ (урок «Welcome to UTS» у Sereda, 17 сторінок):
 *   • рушій — pdf.js, а не вбудований переглядач браузера: жодної чужої панелі зверху;
 *   • панель — лише `N / M` · `−` · `100%` · `+` (крок і межі масштабу — `pdfViewerMath.ts`);
 *   • вікно квадратне, документ прокручується ВСЕРЕДИНІ нього, сторінка уроку стоїть;
 *   • сторінки стовпчиком через 16 px, кожна малюється в чіткості екрана (×devicePixelRatio);
 *   • малюється лише та сторінка, до якої дійшла прокрутка, — решта чекає з індикатором;
 *   • лічильник іде за прокруткою.
 *
 * 🔴 ЧОГО НЕМАЄ, БО НЕМАЄ В SEREDA: завантаження, друку, виділення тексту, повного екрана. Тримає `#723b`.
 * ⚠️ «Немає кнопки завантаження» — це НЕ захист: файл однаково приходить у браузер людини. Файл, який
 * треба віддати, віддається окремим посиланням (як «Вкладення» в Sereda), а не через переглядач.
 *
 * ⚠️ ВОРКЕР — ОКРЕМИЙ ФАЙЛ ЗБІРКИ (`pdf.worker.min-*.mjs`, ~1.2 МБ). Ядро pdf.js імпортується статично
 * й живе в основному бандлі: динамічний імпорт дав би другий чанк, а `#225` його забороняє, бо після
 * викату він 404-ить у тих, хто не перезавантажив сторінку. Воркер під цю заборону не підпадає — його
 * `cssGuard` не видаляє (прибирає лише `index-*`), і `#724` називає його поіменно, а не пропускає
 * крізь те, що `#225` рахує лише `.js`.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

/** Відступ вікна з кожного боку, px. Сторінка на 100% займає ширину вікна мінус ці відступи. */
const PAD = 16;

type PageSize = { w: number; h: number };

export function PdfViewer({ src, title }: { src: string; title: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [fit, setFit] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  /** Частка прокрутки перед зміною масштабу — щоб після неї людина лишилась на тому ж місці документа. */
  const keep = useRef<{ y: number; x: number } | null>(null);

  // Документ: розміри ВСІХ сторінок одразу (це дешево), щоб місце під кожну було відоме до відмальовки
  // і прокрутка не стрибала, коли сторінки домальовуються.
  useEffect(() => {
    let alive = true;
    setDoc(null); setSizes([]); setErr(null); setPage(1);
    const task = getDocument({ url: src });
    task.promise.then(async (d) => {
      const s: PageSize[] = [];
      for (let i = 1; i <= d.numPages; i++) {
        const v = (await d.getPage(i)).getViewport({ scale: 1 });
        s.push({ w: v.width, h: v.height });
      }
      if (!alive) return;
      setDoc(d); setSizes(s);
    }).catch(() => { if (alive) setErr("Не вдалося відкрити документ. Спробуйте оновити сторінку."); });
    return () => { alive = false; void task.destroy(); };
  }, [src]);

  // Ширина «на 100%» — ширина вікна. Слідкуємо за нею, бо вікно гумове (телефон, бічна панель).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setFit(Math.max(0, box.clientWidth - PAD * 2));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [doc]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const tops = pageEls.current.filter((x): x is HTMLDivElement => !!x).map((x) => x.offsetTop);
    setPage(pageAtScroll(tops, box.scrollTop, box.clientHeight));
  }, []);

  const changeZoom = (next: number) => {
    const box = boxRef.current;
    if (box) keep.current = {
      y: box.scrollHeight ? box.scrollTop / box.scrollHeight : 0,
      x: box.scrollWidth ? (box.scrollLeft + box.clientWidth / 2) / box.scrollWidth : 0.5,
    };
    setZoom(next);
  };
  // Після зміни масштабу — повернути ту саму точку документа, а не кинути людину на першу сторінку.
  useLayoutEffect(() => {
    const box = boxRef.current, k = keep.current;
    if (!box || !k) return;
    box.scrollTop = k.y * box.scrollHeight;
    box.scrollLeft = Math.max(0, k.x * box.scrollWidth - box.clientWidth / 2);
    keep.current = null;
    onScroll();
  }, [zoom, onScroll]);

  const total = sizes.length;
  const width = fit * zoom;

  return (
    <div className="pdfv" aria-label={title}>
      <div className="pdfv-bar">
        <span className="pdfv-count">{total ? `${page} / ${total}` : "– / –"}</span>
        <span className="pdfv-sep" />
        <button type="button" title="Зменшити" aria-label="Зменшити" disabled={!total || !canZoomOut(zoom)} onClick={() => changeZoom(zoomOut(zoom))}>
          <ZoomIcon minus />
        </button>
        <span className="pdfv-zoom">{zoomLabel(zoom)}</span>
        <button type="button" title="Збільшити" aria-label="Збільшити" disabled={!total || !canZoomIn(zoom)} onClick={() => changeZoom(zoomIn(zoom))}>
          <ZoomIcon />
        </button>
      </div>
      <div className="pdfv-box" ref={boxRef} onScroll={onScroll}>
        {err ? <div className="pdfv-msg">{err}</div>
          : !doc || !fit ? <div className="pdfv-msg"><span className="pdfv-spinner" aria-label="Завантаження" /></div>
          : (
            <div className="pdfv-pages">
              {sizes.map((s, i) => (
                <PdfPage key={i} doc={doc} n={i + 1} width={width} height={(width * s.h) / s.w}
                  root={boxRef} setEl={(el) => { pageEls.current[i] = el; }} />
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

/**
 * Одна сторінка: місце під неї є завжди, а малюється вона, лише коли прокрутка підходить на висоту
 * вікна. Намальована сторінка не стирається, як і в Sereda; при зміні масштабу перемальовується,
 * коли знову стає видимою.
 */
function PdfPage({ doc, n, width, height, root, setEl }: {
  doc: PDFDocumentProxy; n: number; width: number; height: number;
  root: React.RefObject<HTMLDivElement | null>; setEl: (el: HTMLDivElement | null) => void;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(false);
  const [drawnAt, setDrawnAt] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near || !canvas.current || Math.abs(drawnAt - width) < 0.5) return;
    let task: RenderTask | null = null, alive = true;
    void (async () => {
      const p = await doc.getPage(n);
      if (!alive || !canvas.current) return;
      const vp = p.getViewport({ scale: width / p.getViewport({ scale: 1 }).width });
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      task = p.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try { await task.promise; if (alive) setDrawnAt(width); } catch { /* скасовано новим масштабом — нормально */ }
    })();
    return () => { alive = false; task?.cancel(); };
  }, [near, width, doc, n, drawnAt]);

  return (
    <div className="pdfv-page" style={{ width, height }} ref={(el) => { wrap.current = el; setEl(el); }}>
      <canvas ref={canvas} style={{ width, height }} />
      {Math.abs(drawnAt - width) >= 0.5 && <span className="pdfv-spinner pdfv-page-spin" aria-hidden />}
    </div>
  );
}

/** Лупа з «−» або «+», як на панелі Sereda. */
function ZoomIcon({ minus }: { minus?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M8 11h6" />
      {!minus && <path d="M11 8v6" />}
    </svg>
  );
}
