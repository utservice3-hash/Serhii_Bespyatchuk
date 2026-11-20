import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 🪗 ЗГОРТАННЯ ЕКРАНА «ПРОПУЩЕНІ» (прохання Романа 20.11.2026: «списки, які згортаються… найкращі принципи UX»).
 *
 * Принципи, на яких тримається (`plans/missed-calls/redesign/redesign-plan.md`, розділ «Згортання»):
 *  · згорнутий блок НЕ ховає головного — ключове число стоїть у заголовку (`summary`), розгортати заради нього не треба;
 *  · екран памʼятає, що людина розгорнула (памʼять браузера, ключ `mc-open`);
 *  · з клавіатури працює все: заголовок — кнопка з `aria-expanded`, згорнутий вміст `inert` (Tab у нього не заходить);
 *  · плавно, але без нудьги: висота через `grid-template-rows` 0fr↔1fr (0.32 с); «менше руху» в системі вимикає все (CSS).
 *  · `lazy` — важкий вміст (графік за всю історію) не вантажиться, доки блок жодного разу не відкрили.
 */

const KEY = "mc-open";
function readOpen(): Record<string, boolean> {
  try { const x = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown; return x && typeof x === "object" ? x as Record<string, boolean> : {}; }
  catch { return {}; }
}
function useFoldOpen(id: string, def: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => { const v = readOpen()[id]; return typeof v === "boolean" ? v : def; });
  const set = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(KEY, JSON.stringify({ ...readOpen(), [id]: v })); } catch { /* приватне вікно — без памʼяті */ }
  };
  return [open, set];
}

export function Fold({ id, title, summary, defaultOpen = false, nested = false, lazy = false, tools, children }: {
  id: string; title: ReactNode; summary?: ReactNode; defaultOpen?: boolean; nested?: boolean; lazy?: boolean;
  /** Праворуч у заголовку, ПОЗА кнопкою згортання (кнопки й підказки не вкладаються в кнопку). */
  tools?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useFoldOpen(id, defaultOpen);
  const [mounted, setMounted] = useState(open || !lazy);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => { body.current?.toggleAttribute("inert", !open); }, [open]);
  return (
    <section className={`mc-sec${nested ? " mc-sub" : ""}`} data-open={open}>
      <div className="mc-shrow">
        <button type="button" className="mc-sh" aria-expanded={open} aria-controls={`mc-${id}`} onClick={() => setOpen(!open)}>
          <span className="mc-chev" aria-hidden="true">▾</span>
          <span className="mc-title">{title}</span>
          {summary != null && <span className="mc-sum">{summary}</span>}
        </button>
        {tools && <div className="mc-shtools">{tools}</div>}
      </div>
      <div className="mc-sb" id={`mc-${id}`} ref={body}><div className="mc-sbi">{mounted && children}</div></div>
    </section>
  );
}

const reduced = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Число «набігає» до цілі (0.7 с, ease-out) — при відкритті й при зміні періоду. «Менше руху» — одразу ціле. */
export function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(() => (reduced() ? target : 0));
  const from = useRef(v);
  useEffect(() => {
    if (reduced()) { setV(target); from.current = target; return; }
    const start = performance.now(), a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms), e = 1 - Math.pow(1 - k, 3);
      const x = Math.round(a + (target - a) * e);
      setV(x); from.current = x;
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** Ціле число, що набігає; `fmt` — як його написати (відсоток, «хв»). */
export function CountUp({ value, fmt = (n) => n.toLocaleString("uk-UA") }: { value: number; fmt?: (n: number) => string }) {
  return <>{fmt(useCountUp(value))}</>;
}

/**
 * ⓘ ПІДКАЗКА, ЯКУ НІЩО НЕ ОБРІЗАЄ (баг, знайдений Романом 20.11.2026 на проді: підказку «Чекають передзвону» накрила шапка).
 * Звичайний `InfoHint` малює спливашку всередині свого блоку, тож її ховали: липка шапка екрана (смуга чисел під нею),
 * `overflow: hidden` згортного блоку (без нього не працює плавне згортання) і прокрутка таблиць. Заміряно на проді:
 * 38 підказок із 39 на обох вкладках були закриті хоч частково.
 * Тут спливашка йде в `document.body` (портал) з `position: fixed` за координатами значка: над усім, що є на сторінці.
 * Місце обирає сама: зверху, якщо там вистачає місця нижче шапки, інакше знизу; по горизонталі не виходить за екран.
 * Той самий вигляд і поведінка, що в `InfoHint`: наведення показує, клік закріплює (на телефоні — дотик).
 */
export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const icon = useRef<HTMLSpanElement | null>(null);
  const pop = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const a = icon.current?.getBoundingClientRect(), p = pop.current?.getBoundingClientRect();
      if (!a || !p) return;
      // Шапка екрана липка: спливашка зверху не має залазити під неї.
      const head = document.querySelector(".rv-head")?.getBoundingClientRect().bottom ?? 0;
      const gap = 8, edge = 8;
      const above = a.top - gap - p.height;
      const top = above >= Math.max(head, 0) + edge ? above : a.bottom + gap;
      const left = Math.min(Math.max(edge, a.left + a.width / 2 - p.width / 2), window.innerWidth - p.width - edge);
      setPos({ left, top });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  return (
    <span className="info-hint" ref={icon}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}>
      <span className="info-hint-icon" aria-label="Звідки дані">ⓘ</span>
      {open && createPortal(
        <span ref={pop} className="info-hint-pop mc-hint-pop" role="tooltip"
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}>{text}</span>,
        document.body)}
    </span>
  );
}
