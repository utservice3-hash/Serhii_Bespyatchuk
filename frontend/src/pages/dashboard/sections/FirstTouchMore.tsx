import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitShift } from "../aiCallsView";

/**
 * 🔽 «ЩЕ ФІЛЬТРИ» — панель рідкісних фільтрів «Розбору» (Роман 24.11.2026, правки до фінального макета: «кнопка ще фільтри
 * погано відкриває»).
 *
 * Навіщо окремий компонент, а не `<details>`: випадна панель `<details>` стояла `left: 0` від кнопки й не знала про край
 * екрана — коли кнопка переносилась у наступний рядок або стояла праворуч, панель виїжджала за межу і її обрізало.
 * Тут панель після відкриття МІРЯЄ себе й зсувається рівно настільки, щоб уміститись (`fitShift` в `aiCallsView.ts`), і закривається
 * кліком повз, клавішею Esc, хрестиком або «Готово» — чотирма звичними способами.
 *
 * Що всередині — вирішує екран (`children`); компонент знає лише про відкриття, місце й число ввімкнених фільтрів.
 */

export function MoreFilters({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (host.current && !host.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  // Місце панелі — на КОЖНОМУ рендері, поки вона відкрита (масив залежностей свідомо не задано): вибір усередині панелі
  // змінює рядок фільтрів (зʼявляється чи зникає «Стан», плашки), кнопка зсувається — і панель мусить піти за нею.
  const place = () => {
    const h = host.current, el = panel.current;
    if (!h || !el) return;
    // Міряємо кнопку й ШИРИНУ панелі (`offsetWidth`), а не її прямокутник: на вході панель масштабується анімацією,
    // і прямокутник у цю мить вужчий за справжній — панель лишалась би на кілька пікселів за краєм.
    const left = h.getBoundingClientRect().left;
    const dx = Math.round(fitShift(left, left + el.offsetWidth, document.documentElement.clientWidth));
    el.style.left = `${String(dx)}px`;
    // Панель «виростає» з кнопки, куди б її не зсунуло.
    el.style.transformOrigin = `${String(28 - dx)}px 0`;
  };
  useLayoutEffect(() => { if (open) place(); });
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  return (
    <div className="ftd-more" ref={host}>
      <button ref={btn} type="button" className={`ftd-pill ftd-more-btn${count ? " has" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Ще фільтри{count > 0 && <span className="ftd-badge">{count}</span>}<span aria-hidden="true" className="ftd-more-caret">▾</span>
      </button>
      {open && (
        <div ref={panel} className="ftd-more-pop" role="dialog" aria-label="Ще фільтри">
          <div className="ftd-more-h"><b>Ще фільтри</b><button type="button" aria-label="Закрити" onClick={() => setOpen(false)}>✕</button></div>
          {children}
          <button type="button" className="ftd-btn ftd-more-done" onClick={() => setOpen(false)}>Готово</button>
        </div>
      )}
    </div>
  );
}
