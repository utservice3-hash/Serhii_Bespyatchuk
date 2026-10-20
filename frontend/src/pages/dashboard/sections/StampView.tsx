import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ctorStampImage, ctorStampPdf, type CtorStamp } from "../../../api";

/**
 * 🔏 ПЕЧАТКА НА PDF (задача 5779, просив Сергій; Роман 20.10.2026: лише печатка, робити можуть усі;
 * «просто кнопка „Додати печатку“, трекати всі печатки, крутити їх»).
 * Менеджер кладе готовий PDF і додає печатки — скільки треба, на будь-які сторінки. Кожну видно в списку:
 * перетягнути, повернути, змінити розмір, прибрати. Сервер накладає їх поверх (текст лишається текстом).
 * Позиція й розмір — у частках сторінки, кут — у градусах за годинниковою стрілкою; від масштабу прев'ю не залежать.
 * ФОП печатки не має — вибрати не можна.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

const VIEW_W = 520;                     // ширина прев'ю сторінки, px
const SIZE0 = 0.19;                     // діаметр печатки — частка ширини сторінки (≈ 4 см на A4)
const STAMP_ENTS: Array<{ k: "uts" | "avm"; t: string }> = [{ k: "uts", t: "ЮТС" }, { k: "avm", t: "АвтоМув" }];
const ENT_NAME: Record<string, string> = { uts: "ЮТС", avm: "АвтоМув" };
const cm = (size: number) => (Math.round(size * 210) / 10).toFixed(1);

type Placed = CtorStamp & { id: number };

export function StampView({ errText }: { errText: (e: unknown) => Promise<string> }) {
  const [file, setFile] = useState<File | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [ent, setEnt] = useState<"uts" | "avm">("avm");
  const [img, setImg] = useState<Record<string, string>>({});
  const [stamps, setStamps] = useState<Placed[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [ratio, setRatio] = useState(1.414);                      // висота / ширина сторінки
  const [msg, setMsg] = useState<{ t: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  /* зображення обох печаток — з тієї ж картки юрособи, що й у документах */
  useEffect(() => {
    const urls: string[] = [];
    let live = true;
    for (const { k } of STAMP_ENTS)
      ctorStampImage(k).then((b) => { if (!live) return; const u = URL.createObjectURL(b); urls.push(u); setImg((m) => ({ ...m, [k]: u })); }).catch(() => {});
    return () => { live = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  /* файл → pdf.js */
  useEffect(() => {
    if (!file) { setDoc(null); return; }
    let live = true;
    file.arrayBuffer().then((buf) => getDocument({ data: new Uint8Array(buf) }).promise)
      .then((d) => { if (!live) return; setDoc(d); setPage(d.numPages); setStamps([]); setSel(null); setMsg(null); })
      .catch(() => setMsg({ t: "Не вдалося відкрити файл — це точно PDF? Захищений паролем PDF тут не відкриється.", bad: true }));
    return () => { live = false; };
  }, [file]);

  /* сторінка → canvas */
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let cancelled = false;
    doc.getPage(page).then((p) => {
      if (cancelled || !canvas.current) return;
      const v1 = p.getViewport({ scale: 1 });
      const scale = VIEW_W / v1.width, dpr = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = vp.width; c.height = vp.height;
      c.style.width = `${VIEW_W}px`; c.style.height = `${vp.height / dpr}px`;
      setRatio(v1.height / v1.width);
      p.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport: vp });
    });
    return () => { cancelled = true; };
  }, [doc, page]);

  const H = VIEW_W * ratio;
  const clampXY = (s: Placed, x: number, y: number) => ({ x: Math.min(Math.max(0, x), 1 - s.size), y: Math.min(Math.max(0, y), 1 - s.size * VIEW_W / H) });
  const upd = (id: number, f: (s: Placed) => Partial<Placed>) => setStamps((a) => a.map((s) => (s.id === id ? { ...s, ...f(s) } : s)));
  const selected = stamps.find((s) => s.id === sel) ?? null;

  const add = () => {
    if (!doc) return;
    const onPage = stamps.filter((s) => s.page === page).length;   // кожна наступна — трохи вище й лівіше, щоб не лягла точно на попередню
    const s: Placed = { id: nextId.current++, ent, page, x: Math.max(0, 0.62 - onPage * 0.05), y: Math.max(0, 0.72 - onPage * 0.05), size: SIZE0, rot: 0 };
    setStamps((a) => [...a, s]); setSel(s.id);
  };
  const remove = (id: number) => { setStamps((a) => a.filter((s) => s.id !== id)); if (sel === id) setSel(null); };
  const rotate = (id: number, d: number) => upd(id, (s) => ({ rot: ((((s.rot + d) % 360) + 540) % 360) - 180 }));

  const onDown = (e: RPointerEvent<HTMLImageElement>, s: Placed) => {
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    const b = box.current!.getBoundingClientRect();
    drag.current = { id: s.id, dx: e.clientX - b.left - s.x * VIEW_W, dy: e.clientY - b.top - s.y * H };
    setSel(s.id);
  };
  const onMove = (e: RPointerEvent<HTMLImageElement>) => {
    const d = drag.current; if (!d || !box.current) return;
    const b = box.current.getBoundingClientRect();
    upd(d.id, (s) => clampXY(s, (e.clientX - b.left - d.dx) / VIEW_W, (e.clientY - b.top - d.dy) / H));
  };
  const onUp = () => { drag.current = null; };

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { setMsg({ t: "Потрібен файл PDF.", bad: true }); return; }
    if (f.size > 20 * 1024 * 1024) { setMsg({ t: "Файл більший за 20 МБ.", bad: true }); return; }
    setFile(f);
  };
  const apply = async () => {
    if (!file || !stamps.length) return;
    setBusy(true); setMsg(null);
    try {
      const out = await ctorStampPdf(file, stamps.map(({ id: _id, ...s }) => s));
      const name = file.name.replace(/\.pdf$/i, "") + " — з печаткою.pdf";
      const a = document.createElement("a"); a.href = URL.createObjectURL(out); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      setMsg({ t: `Готово: «${name}» завантажено (печаток: ${stamps.length}). Оригінал не змінено.` });
    } catch (e) { setMsg({ t: await errText(e), bad: true }); }
    finally { setBusy(false); }
  };

  const here = stamps.filter((s) => s.page === page);
  return (
    <div className="grid stampgrid">
      <main className="card">
        <div className="sec">
          <h3><span className="n">1</span>Файл</h3>
          <p className="hint">Готовий PDF — договір від клієнта, акт, рахунок. Печатки ляжуть поверх, текст документа лишається текстом.</p>
          <div className="way" style={{ marginLeft: 30 }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}>
            <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
            {file
              ? <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="ext">PDF</span><b style={{ fontSize: 13 }}>{file.name}</b>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{doc ? `${doc.numPages} стор.` : "відкриваю…"}</span>
                  <button className="btn sm" onClick={() => input.current?.click()}>Інший файл</button></div>
              : <button className="btn" onClick={() => input.current?.click()}>⬆ Обрати PDF або перетягнути сюди</button>}
          </div>
        </div>

        <div className="sec">
          <h3><span className="n">2</span>Печатки</h3>
          <p className="hint">Оберіть сторінку й юрособу і натисніть «Додати печатку». Печатку перетягують мишкою; вибрану в списку можна повернути, змінити розмір чи прибрати.</p>
          <div className="stamprow">
            <div className="fld" style={{ minWidth: 150 }}><label htmlFor="stPage">Сторінка</label>
              <select id="stPage" value={page} disabled={!doc} onChange={(e) => { setPage(+e.target.value); setSel(null); }}>
                {Array.from({ length: doc?.numPages ?? 1 }, (_, i) => <option key={i} value={i + 1}>{i + 1}{doc && i + 1 === doc.numPages ? " (остання)" : ""}{stamps.some((s) => s.page === i + 1) ? " · 🔏" : ""}</option>)}
              </select></div>
            <div className="fld"><label>Чия печатка</label>
            <div className="ways" role="group" aria-label="Чия печатка">
              {STAMP_ENTS.map((x) => <button key={x.k} aria-pressed={ent === x.k} onClick={() => { setEnt(x.k); if (selected) upd(selected.id, () => ({ ent: x.k })); }}>{x.t}</button>)}
              <button disabled title="У ФОП немає печатки — лише підпис" style={{ opacity: .45, cursor: "not-allowed" }}>ФОП · без печатки</button>
            </div></div>
            <button className="btn pri" disabled={!doc} onClick={add}>＋ Додати печатку</button>
          </div>

          <div style={{ marginLeft: 30, marginTop: 12 }}>
            {!stamps.length
              ? <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>{doc ? "Печаток ще немає — додайте першу." : "Спершу оберіть файл."}</p>
              : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {stamps.map((s, i) => {
                    const on = s.id === sel;
                    return (
                      <div key={s.id} onClick={() => { setSel(s.id); setPage(s.page); setEnt(s.ent as "uts" | "avm"); }}
                        style={{ border: `1px solid ${on ? "var(--ent)" : "var(--line)"}`, borderRadius: 10, padding: "8px 10px", cursor: "pointer",
                          background: on ? "color-mix(in srgb, var(--ent) 6%, var(--surface))" : "var(--surface)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                          {img[s.ent] && <img src={img[s.ent]} alt="" style={{ width: 28, height: 28, transform: `rotate(${s.rot}deg)` }} />}
                          <b style={{ fontSize: 13 }}>Печатка {i + 1} · {ENT_NAME[s.ent]}</b>
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>стор. {s.page} · {cm(s.size)} см · {s.rot}°</span>
                          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                            <button className="btn sm" title="Повернути на 15° проти годинникової" onClick={(e) => { e.stopPropagation(); rotate(s.id, -15); }}>↺</button>
                            <button className="btn sm" title="Повернути на 15° за годинниковою" onClick={(e) => { e.stopPropagation(); rotate(s.id, 15); }}>↻</button>
                            <button className="btn sm" title="Прибрати печатку" style={{ color: "var(--bad)" }} onClick={(e) => { e.stopPropagation(); remove(s.id); }}>✕</button>
                          </span>
                        </div>
                        {on && <div className="g2" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                          <div className="fld"><label htmlFor={`rot${s.id}`}>Поворот · {s.rot}°</label>
                            <input id={`rot${s.id}`} type="range" min={-180} max={180} step={1} value={s.rot} onChange={(e) => upd(s.id, () => ({ rot: +e.target.value }))} /></div>
                          <div className="fld"><label htmlFor={`sz${s.id}`}>Розмір · {cm(s.size)} см</label>
                            <input id={`sz${s.id}`} type="range" min={0.14} max={0.26} step={0.005} value={s.size}
                              onChange={(e) => upd(s.id, (x) => ({ size: +e.target.value, ...clampXY({ ...x, size: +e.target.value }, x.x, x.y) }))} /></div>
                        </div>}
                      </div>
                    );
                  })}
                </div>}
          </div>
        </div>

        <div className="sec" style={{ borderBottom: 0 }}>
          <button className="btn pri" disabled={!doc || !stamps.length || busy} onClick={() => void apply()}>
            {busy ? "⏳ Ставлю печатки…" : `🔏 Поставити ${stamps.length > 1 ? `печатки (${stamps.length})` : "печатку"} і завантажити PDF`}</button>
          {msg && <p style={{ fontSize: 12.5, margin: "10px 0 0", color: msg.bad ? "var(--bad)" : "var(--ok)", fontWeight: 600 }}>{msg.t}</p>}
          <p className="hint" style={{ margin: "10px 0 0" }}>Новий файл зберігається як «… — з печаткою.pdf». У журнал записується, хто, коли, на який файл і скільки печаток поставив.</p>
        </div>
      </main>

      <section className="card preview">
        <div className="pvhead"><span className="t">Сторінка {doc ? `${page} з ${doc.numPages}` : "—"}</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{here.length ? `печаток на сторінці: ${here.length} · рамка лише тут, у файлі її не буде` : "печаток на цій сторінці немає"}</span></div>
        <div style={{ padding: 16, display: "flex", justifyContent: "center", background: "var(--surface-2)" }} onPointerDown={() => setSel(null)}>
          {doc
            ? <div ref={box} style={{ position: "relative", width: VIEW_W, height: H, boxShadow: "0 1px 4px rgba(0,0,0,.12)", background: "#fff" }}>
                <canvas ref={canvas} style={{ display: "block" }} />
                {here.map((s) => img[s.ent] && (
                  <img key={s.id} src={img[s.ent]} alt={`Печатка ${ENT_NAME[s.ent]}`} draggable={false}
                    onPointerDown={(e) => onDown(e, s)} onPointerMove={onMove} onPointerUp={onUp}
                    style={{ position: "absolute", left: s.x * VIEW_W, top: s.y * H, width: s.size * VIEW_W, transform: `rotate(${s.rot}deg)`,
                      cursor: "grab", outline: s.id === sel ? "1.5px dashed var(--ent)" : "1px dashed rgba(0,0,0,.18)", outlineOffset: 3, touchAction: "none", userSelect: "none" }} />
                ))}
              </div>
            : <div style={{ width: VIEW_W, height: VIEW_W * 1.414, border: "1px dashed var(--line)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13, background: "var(--surface)" }}>
                Тут зʼявиться сторінка документа</div>}
        </div>
      </section>
    </div>
  );
}
