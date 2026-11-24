import { useLayoutEffect, useRef } from "react";

/**
 * 🎚 ПОВЗУНОК ПЕРЕМИКАЧА (Роман 23.11.2026, макет А): біла плашка переїжджає під активну кнопку `.on`, а не блимає на
 * новому місці — видно, ЗВІДКИ й КУДИ перемкнули. Хук лише міряє активну кнопку й кладе її зсув і ширину в CSS-змінні
 * `--ink-x` / `--ink-w`; сам повзунок і перехід — у `firstTouch.css` (`.ftd-seg.has-ink::before`), там же він вимкнений
 * при «зменшенні руху». Без JS (змінних немає) перемикач виглядає як раніше: активна кнопка просто біла.
 */
export function useSegInk<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = () => {
      const on = box.querySelector<HTMLElement>("button.on");
      box.style.setProperty("--ink-x", `${String(on?.offsetLeft ?? 0)}px`);
      box.style.setProperty("--ink-w", `${String(on?.offsetWidth ?? 0)}px`);
      box.classList.add("has-ink");
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => ro.disconnect();
  }, [dep]);
  return ref;
}
