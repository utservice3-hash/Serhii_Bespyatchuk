import { useEffect, useRef, useState } from "react";
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
 * options browsers won't let us colour.
 */
export function StatusPicker({
  value, onChange, fullWidth = false,
}: {
  value: TaskStatus;
  onChange: (s: TaskStatus) => void;
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const color = STATUS_DOT_COLORS[value] ?? "#94a3b8";
  const dot = (c: string, size = 9) => (
    <span style={{ width: size, height: size, borderRadius: "50%", background: c, flex: "0 0 auto", display: "inline-block" }} />
  );

  return (
    <div ref={wrapRef} style={{ position: "relative", display: fullWidth ? "block" : "inline-block", width: fullWidth ? "100%" : undefined }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, width: fullWidth ? "100%" : undefined, maxWidth: "100%",
          background: hexA(color, 0.16), color: "var(--text)", border: "none", borderRadius: 999,
          padding: "4px 12px", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
        {dot(color)}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{STATUS_LABELS[value]}</span>
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 60, top: "calc(100% + 6px)", left: 0, minWidth: 240,
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
        </div>
      )}
    </div>
  );
}
