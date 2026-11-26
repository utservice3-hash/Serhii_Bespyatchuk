import { useState, type ReactNode } from "react";

/**
 * ❓ ПОЯСНЕННЯ ПІД ЗНАКОМ ПИТАННЯ (задача 11222; зустріч по дашборду 25.11.2026: «купа тексту… знак питання, наводиш —
 * і все»). Довгий пояснювальний текст не стоїть на екрані постійно: видно лише «?», текст відкривається наведенням,
 * кліком або фокусом із клавіатури. Сам текст нікуди не зник — правило, яке пояснювало число, і далі поруч із ним.
 */
export function HelpTip({ children, label = "Пояснення", align = "left" }: { children: ReactNode; label?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        style={{ width: 18, height: 18, borderRadius: 999, border: "1px solid #9ca3af", background: open ? "#eff6ff" : "#fff", color: "#4b5563",
                 fontSize: 11, fontWeight: 700, lineHeight: 1, padding: 0, cursor: "help", flex: "none" }}>?</button>
      {open && (
        <span role="tooltip"
          style={{ position: "absolute", top: "calc(100% + 6px)", [align]: 0, zIndex: 100, width: "max-content", maxWidth: 360,
                   background: "#fff", color: "#1f2937", border: "1px solid #d1d5db", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.18)",
                   padding: "10px 12px", fontSize: 12, fontWeight: 400, lineHeight: 1.5, textAlign: "left", whiteSpace: "normal",
                   textTransform: "none", letterSpacing: 0 }}>
          {children}
        </span>
      )}
    </span>
  );
}
