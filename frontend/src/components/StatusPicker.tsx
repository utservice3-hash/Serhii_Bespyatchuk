import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskStatus } from "../api";
import { STATUS_GROUPS, STATUS_LABELS, STATUS_DOT_COLORS } from "../pages/dashboard/constants";

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/**
 * Kommo-style status picker: a coloured pill trigger (dot + label) opening a
 * grouped popover (To-do / In progress / Complete) where every status carries
 * its own coloured dot, like the CRM. Replaces the plain native <select> whose
 * options browsers won't let us colour. The popover is portalled to <body> with
 * fixed positioning so it is never clipped by a table cell's overflow:hidden.
 */
export function StatusPicker({
  value, onChange, fullWidth = false,
}: {
  value: TaskStatus;
  onChange: (s: TaskStatus) => void;
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const popW = 240, popH = popRef.current?.offsetHeight ?? 320;
    // Не вилазимо за правий край; якщо знизу не влазить — відкриваємось вгору.
    const left = Math.max(8, Math.min(r.left, vw - popW - 8));
    const top = r.bottom + 6 + popH > vh - 8 && r.top - popH - 6 > 8
      ? r.top - popH - 6
      : Math.min(r.bottom + 6, vh - popH - 8);
    setPos({ top: Math.max(8, top), left });
  };
  // Дві фази: 1) відкрили — оцінка позиції; 2) поповер змонтувався (popRef є) —
  // уточнюємо за реальною висотою, щоб не вилазив за низ/правий край екрана.
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useLayoutEffect(() => { if (open && pos && popRef.current) place(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, popRef.current]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const color = STATUS_DOT_COLORS[value] ?? "#94a3b8";
  const dot = (c: string, size = 9) => (
    <span style={{ width: size, height: size, borderRadius: "50%", background: c, flex: "0 0 auto", display: "inline-block" }} />
  );

  return (
    <div style={{ display: fullWidth ? "block" : "inline-block", width: fullWidth ? "100%" : undefined, maxWidth: "100%" }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, width: fullWidth ? "100%" : undefined, maxWidth: "100%",
          background: hexA(color, 0.16), color: "var(--text)", border: "none", borderRadius: 999,
          padding: "4px 12px", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
        {dot(color)}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{STATUS_LABELS[value]}</span>
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: "fixed", zIndex: 1000, top: pos.top, left: pos.left, minWidth: 240,
          background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: 8 }}>
          {STATUS_GROUPS.map((group, gi) => (
            <div key={group.label} style={{ marginTop: gi === 0 ? 0 : 6, paddingTop: gi === 0 ? 0 : 6, borderTop: gi === 0 ? "none" : "1px solid var(--border)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4, padding: "4px 8px 6px" }}>
                {group.label}
              </div>
              {group.statuses.map((s) => {
                const c = STATUS_DOT_COLORS[s] ?? "#94a3b8";
                const sel = s === value;
                return (
                  <button key={s} type="button"
                    onClick={() => { onChange(s); setOpen(false); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", border: "none",
                      background: sel ? hexA(c, 0.16) : "transparent", color: "var(--text)", cursor: "pointer",
                      borderRadius: 999, padding: "6px 10px", fontSize: 13, fontWeight: sel ? 700 : 500, marginBottom: 2 }}
                    onMouseEnter={(e) => { if (!sel) (e.currentTarget.style.background = hexA(c, 0.10)); }}
                    onMouseLeave={(e) => { if (!sel) (e.currentTarget.style.background = "transparent"); }}>
                    {dot(c)}
                    <span style={{ flex: 1 }}>{STATUS_LABELS[s]}</span>
                    {sel && <span style={{ color: c, fontWeight: 700 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
