import { useEffect, useRef, useState, type ReactNode } from "react";

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
