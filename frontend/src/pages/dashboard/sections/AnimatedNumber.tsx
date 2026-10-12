import { useEffect, useRef, useState } from "react";

/**
 * 🔢 ЧИСЛО, ЩО ПЛАВНО ПЕРЕТІКАЄ (Роман 08.10.2026: «плавне оновлення цифр при зміні команди»). Від попереднього
 * значення до нового за ~450 мс зі сповільненням у кінці. Перший показ — без анімації (рахувати «від нуля» на
 * завантаженні — шум). «Зменшення руху» в системі — одразу нове значення.
 */
const DURATION_MS = 450;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function AnimatedNumber({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  const [shown, setShown] = useState<number | null>(value);
  const from = useRef<number | null>(value);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = from.current;
    if (value == null || start == null || start === value || reducedMotion()) { from.current = value; setShown(value); return; }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / DURATION_MS);
      const v = Math.round(start + (value - start) * easeOut(k));
      setShown(v); from.current = v;
      if (k < 1) raf.current = requestAnimationFrame(step); else from.current = value;
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current != null) cancelAnimationFrame(raf.current); };
  }, [value]);
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{shown == null ? "—" : `${shown.toLocaleString("uk-UA")}${suffix}`}</span>;
}
