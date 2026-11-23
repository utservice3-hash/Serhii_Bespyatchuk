import { useEffect, useMemo, useRef, useState } from "react";
import type { ReportPlanManager } from "../../../api";
import { pickGroups, toggleMany } from "../mgrPick";

/**
 * 👥 «МЕНЕДЖЕРИ · N з M» — вибір рядків Звіту (задача 10752, 23.11.2026), той самий вигляд, що «Колонки · N з M».
 * Стан живе в контейнері (`ReportPlanSection`), бо діє і на таблицю, і на картки; тут лише меню.
 * Логіка (групи, перемикання, збереження) — у чистому `mgrPick.ts`, який виконують гейти `#10752…`.
 */
export function ReportManagerPicker({ managers, hidden, onChange }: {
  /** Усі менеджери поточних даних (до будь-якого фільтра рядків). */
  managers: readonly ReportPlanManager[];
  hidden: readonly number[];
  onChange: (next: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const h = useMemo(() => new Set(hidden), [hidden]);
  const shown = managers.filter((m) => !h.has(m.managerId)).length;
  const narrowed = shown < managers.length;
  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => pickGroups(needle ? managers.filter((m) => m.name.toLowerCase().includes(needle)) : managers), [managers, needle]);
  const allIds = managers.map((m) => m.managerId);

  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "5px 12px 5px 30px", fontSize: 13, cursor: "pointer" };
  const linkBtn: React.CSSProperties = {
    border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
    borderRadius: "var(--r-pill)", padding: "3px 10px", fontSize: 12, cursor: "pointer",
  };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <button type="button" className="rv-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true"
        title="Обрати, чиї рядки показати в таблиці й картках"
        style={{ fontVariantNumeric: "tabular-nums", ...(narrowed ? { borderColor: "var(--brand)", color: "var(--brand)" } : {}) }}>
        Менеджери · {shown} з {managers.length} <span style={{ opacity: 0.6, marginLeft: 2 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 60,
          width: "min(340px, calc(100vw - 32px))", maxHeight: "min(480px, 70vh)", overflowY: "auto",
          background: "var(--card-bg)", border: "1px solid var(--border-strong)",
          borderRadius: "var(--r-md)", boxShadow: "var(--shadow)", padding: "6px 0",
        }}>
          <div style={{ display: "flex", gap: 6, padding: "4px 12px 8px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
            <button type="button" style={linkBtn} onClick={() => onChange([])}>Усі</button>
            <button type="button" style={linkBtn} onClick={() => onChange([...new Set([...hidden, ...allIds])])}>Жодного</button>
          </div>
          <div style={{ padding: "8px 12px 4px" }}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук менеджера…" aria-label="Пошук менеджера"
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: "var(--r-md)",
                padding: "6px 9px", fontSize: 12.5, background: "var(--card-bg)", color: "var(--text)" }} />
          </div>
          {groups.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--text-muted)" }}>Нікого не знайдено.</div>}
          {groups.map((g) => {
            const ids = g.rows.map((m) => m.managerId);
            const on = ids.filter((id) => !h.has(id)).length;
            return (
              <div key={g.team}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px 3px", fontSize: 10.5, textTransform: "uppercase",
                  letterSpacing: ".05em", color: "var(--text-muted)", cursor: "pointer" }}>
                  <input type="checkbox" checked={on === ids.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < ids.length; }}
                    onChange={() => onChange(toggleMany(hidden, ids))} />
                  {g.team}
                  <span style={{ marginLeft: "auto", textTransform: "none", letterSpacing: 0 }}>{on} з {ids.length}</span>
                </label>
                {g.rows.map((m) => (
                  <label key={m.managerId} style={row}>
                    <input type="checkbox" checked={!h.has(m.managerId)} onChange={() => onChange(toggleMany(hidden, [m.managerId]))} />
                    {m.name}
                  </label>
                ))}
              </div>
            );
          })}
          <div style={{ padding: "8px 12px 4px", borderTop: "1px solid var(--border)", marginTop: 6, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4 }}>
            Вибір запамʼятовується для вас. Нові менеджери показуються самі. Плитки вгорі не звужуються.
          </div>
        </div>
      )}
    </div>
  );
}
