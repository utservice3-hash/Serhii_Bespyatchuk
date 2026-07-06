import { useEffect, useMemo, useRef, useState } from "react";

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MONTHS_SHORT = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDay = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const fmtMonth = (y: number, m: number) => `${y}-${pad(m + 1)}`;

/**
 * Modern, dependency-free date / month picker with a branded popover calendar.
 * `mode="day"` → value "YYYY-MM-DD"; `mode="month"` → value "YYYY-MM".
 */
export function DatePicker({
  value, onChange, mode = "day", placeholder, minWidth = 150,
}: {
  value: string;
  onChange: (v: string) => void;
  mode?: "day" | "month";
  placeholder?: string;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const today = new Date();

  // View month/year the calendar is currently showing.
  const parsed = useMemo(() => {
    if (mode === "month") { const [y, m] = value.split("-").map(Number); return value ? { y, m: m - 1 } : null; }
    if (!value) return null;
    const [y, m, d] = value.split("-").map(Number);
    return { y, m: m - 1, d };
  }, [value, mode]);
  const [view, setView] = useState(() => ({ y: parsed?.y ?? today.getFullYear(), m: parsed?.m ?? today.getMonth() }));
  useEffect(() => { if (parsed) setView({ y: parsed.y, m: parsed.m }); }, [parsed?.y, parsed?.m]); // eslint-disable-line

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label = useMemo(() => {
    if (!value) return placeholder ?? (mode === "month" ? "Оберіть місяць" : "Оберіть дату");
    if (mode === "month") { const [y, m] = value.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; }
    const [y, m, d] = value.split("-").map(Number);
    return `${pad(d)}.${pad(m)}.${y}`;
  }, [value, mode, placeholder]);

  const shiftMonth = (delta: number) => setView((v) => { const d = new Date(v.y, v.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const shiftYear = (delta: number) => setView((v) => ({ ...v, y: v.y + delta }));

  const days = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const startWd = (first.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const cells: { y: number; m: number; d: number; cur: boolean }[] = [];
    for (let i = 0; i < startWd; i++) { const dd = new Date(view.y, view.m, -(startWd - 1 - i)); cells.push({ y: dd.getFullYear(), m: dd.getMonth(), d: dd.getDate(), cur: false }); }
    for (let d = 1; d <= daysInMonth; d++) cells.push({ y: view.y, m: view.m, d, cur: true });
    while (cells.length % 7 !== 0 || cells.length < 42) { const last = cells[cells.length - 1]; const dd = new Date(last.y, last.m, last.d + 1); cells.push({ y: dd.getFullYear(), m: dd.getMonth(), d: dd.getDate(), cur: false }); if (cells.length >= 42) break; }
    return cells;
  }, [view]);

  const isSel = (y: number, m: number, d?: number) =>
    parsed != null && parsed.y === y && parsed.m === m && (mode === "month" || parsed.d === d);
  const isToday = (y: number, m: number, d: number) => today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;

  const btn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: value ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 14, minWidth, justifyContent: "space-between" };
  const cell: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", borderRadius: 8, height: 32, fontSize: 13, color: "var(--text)" };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={btn}>
        <span>{label}</span>
        <span style={{ opacity: 0.6 }}>📅</span>
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 50, top: "calc(100% + 6px)", left: 0, width: 268, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <button type="button" onClick={() => (mode === "month" ? shiftYear(-1) : shiftMonth(-1))} style={{ ...cell, width: 32, fontSize: 18, lineHeight: 1 }}>‹</button>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{mode === "month" ? view.y : `${MONTHS[view.m]} ${view.y}`}</div>
            <button type="button" onClick={() => (mode === "month" ? shiftYear(1) : shiftMonth(1))} style={{ ...cell, width: 32, fontSize: 18, lineHeight: 1 }}>›</button>
          </div>

          {mode === "month" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {MONTHS_SHORT.map((mn, i) => {
                const sel = isSel(view.y, i);
                return (
                  <button key={i} type="button"
                    onClick={() => { onChange(fmtMonth(view.y, i)); setOpen(false); }}
                    style={{ ...cell, height: 40, fontWeight: sel ? 700 : 500, background: sel ? "#c8102e" : "transparent", color: sel ? "#fff" : "var(--text)" }}>
                    {mn}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
                {WD.map((w) => <div key={w} style={{ textAlign: "center", fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>{w}</div>)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                {days.map((c, i) => {
                  const sel = isSel(c.y, c.m, c.d);
                  const tod = isToday(c.y, c.m, c.d);
                  return (
                    <button key={i} type="button"
                      onClick={() => { onChange(fmtDay(c.y, c.m, c.d)); setOpen(false); }}
                      style={{ ...cell, opacity: c.cur ? 1 : 0.35, fontWeight: sel || tod ? 700 : 400,
                        background: sel ? "#c8102e" : "transparent",
                        color: sel ? "#fff" : c.cur ? "var(--text)" : "var(--text-muted)",
                        boxShadow: tod && !sel ? "inset 0 0 0 1.5px #c8102e" : "none" }}>
                      {c.d}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <button type="button" onClick={() => { onChange(""); setOpen(false); }} style={{ ...cell, color: "var(--text-muted)", fontSize: 13, padding: "0 6px" }}>Очистити</button>
            <button type="button" onClick={() => { onChange(mode === "month" ? fmtMonth(today.getFullYear(), today.getMonth()) : fmtDay(today.getFullYear(), today.getMonth(), today.getDate())); setOpen(false); }}
              style={{ ...cell, color: "#c8102e", fontWeight: 600, fontSize: 13, padding: "0 6px" }}>
              {mode === "month" ? "Цей місяць" : "Сьогодні"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
