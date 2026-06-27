import { useEffect, useMemo, useRef, useState } from "react";
import { NAV_ITEMS, type NavKey } from "./Layout";

/**
 * Global quick-navigation palette. Opens on Ctrl/Cmd+K, filters the dashboard
 * sections, and jumps to the chosen one on Enter/click.
 */
export function CommandPalette({ onSelect }: { onSelect: (key: NavKey) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(
    () => NAV_ITEMS.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
    [query]
  );

  if (!open) return null;

  function choose(key: NavKey) {
    onSelect(key);
    setOpen(false);
  }

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 3000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card-bg)",
          color: "var(--text)",
          borderRadius: 12,
          width: "90vw",
          maxWidth: 560,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="Перейти до розділу…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter" && results[active]) choose(results[active].key);
          }}
          style={{
            width: "100%",
            border: "none",
            borderBottom: "1px solid var(--border)",
            borderRadius: 0,
            padding: "16px 18px",
            fontSize: 16,
            outline: "none",
          }}
        />
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {results.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-muted)" }}>Нічого не знайдено</div>
          )}
          {results.map((item, i) => (
            <button
              key={item.key}
              onClick={() => choose(item.key)}
              onMouseEnter={() => setActive(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                textAlign: "left",
                padding: "12px 18px",
                border: "none",
                background: i === active ? "rgba(197,20,28,0.12)" : "transparent",
                color: "var(--text)",
                fontSize: 15,
              }}
            >
              <span style={{ fontSize: 18 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
        <div
          style={{
            padding: "8px 18px",
            fontSize: 12,
            color: "var(--text-muted)",
            borderTop: "1px solid var(--border)",
          }}
        >
          ↑↓ — вибір · Enter — перейти · Esc — закрити
        </div>
      </div>
    </div>
  );
}
