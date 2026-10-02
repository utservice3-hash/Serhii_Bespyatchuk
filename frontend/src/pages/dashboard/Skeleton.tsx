import type { CSSProperties } from "react";

/**
 * ⏳ ЗАГОТОВКИ ЗАВАНТАЖЕННЯ — замість тексту «Завантаження…», який схлопував блок до одного рядка й
 * змушував сторінку стрибати при кожному перемиканні (прохання Романа 02.10.2026: «додай placeholder
 * of a preload, і таке потрібно для всіх графіків»). Розмір заготовки = розмір справжнього блока.
 * Стилі — `.skel` в `index.css`.
 */
export function SkelBox({ w = "100%", h = 14, r = 8, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) {
  return <div className="skel" aria-hidden style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Заготовка графіка тієї самої висоти, що й графік. */
export function ChartSkeleton({ height = 300, label = "Завантаження графіка…" }: { height?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} style={{ position: "relative", height }}>
      <SkelBox h={height} r={12} />
      <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

/** Заготовка рядка плиток. */
export function TilesSkeleton({ n = 4, height = 170 }: { n?: number; height?: number }) {
  return (
    <div role="status" aria-label="Рахуємо цифри періоду…" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12 }}>
      {Array.from({ length: n }, (_, i) => <SkelBox key={i} h={height} r={14} />)}
    </div>
  );
}

/** Заготовка таблиці: шапка + N рядків. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden style={{ display: "grid", gap: 10, padding: "6px 0" }}>
      <SkelBox h={12} w="60%" />
      {Array.from({ length: rows }, (_, i) => <SkelBox key={i} h={18} />)}
    </div>
  );
}
