import { useEffect, useRef, useState } from "react";
import { fetchClientSearch, type ClientSearchHit } from "../../api";
import { formatAmountFull } from "./format";

/**
 * 🔎 ВИБІР КЛІЄНТА ЖИВИМ ПОШУКОМ.
 *
 * 🔴 НАВІЩО. Форма «Обʼєднати клієнтів» мала два поля вільного тексту, а вводити
 * туди треба було КАНОНІЧНИЙ КЛЮЧ (`вкавтострада`). Дізнатись його з екрана було
 * нізвідки, тож формою просто не могли скористатись. Тут людина шукає так, як
 * памʼятає клієнта — за назвою або номером, — а ключ підставляє UI.
 *
 * 🔴 РУКАМИ КЛЮЧ НЕ ВВОДИТЬСЯ. `onPick` віддає значення ЛИШЕ з вибраного рядка;
 * поки нічого не вибрано, назовні їде `null`. Інакше лишалась би та сама пастка:
 * можна набрати «схоже» й отримати обʼєднання не з тим клієнтом — операцію, яку
 * потім треба відкочувати руками.
 */
export interface ClientPickerValue {
  clientKey: string;
  clientName: string;
  /** Відповідальний на момент вибору — щоб форма показала «зараз веде», не роблячи другого запиту. */
  managerName?: string | null;
  orders?: number;
  lastPaid?: string | null;
}

export function ClientPicker({ value, onPick, placeholder, disabled, autoFocus }: {
  value: ClientPickerValue | null;
  onPick: (v: ClientPickerValue | null) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ClientSearchHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Дебаунс 250 мс: пошук іде по 146 тис. угод, і смикати його на кожну літеру
  // означало б чергу запитів, де відповідає останній, а показується перший.
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); setLoading(false); return; }
    let dead = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetchClientSearch(q.trim())
        .then((r) => { if (!dead) { setHits(r); setCursor(0); setOpen(true); } })
        .catch(() => { if (!dead) setHits([]); })
        .finally(() => { if (!dead) setLoading(false); });
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const pick = (h: ClientSearchHit) => {
    onPick({ clientKey: h.clientKey, clientName: h.clientName, managerName: h.managerName,
             orders: h.orders, lastPaid: h.lastPaid });
    setQ(""); setHits(null); setOpen(false);
  };

  const input: React.CSSProperties = {
    fontSize: 12, padding: "6px 9px", border: "1px solid #d1d5db", borderRadius: 8,
    width: "100%", boxSizing: "border-box",
  };

  if (value) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #bfdbfe",
                    background: "#eff6ff", borderRadius: 8, padding: "6px 9px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {value.clientName}
          </div>
          {/* Ключ показуємо, але як ДОВІДКУ — щоб було видно, ЩО саме поїде в реєстр. */}
          <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace" }}>
            {value.clientKey}
            {value.managerName ? <span style={{ fontFamily: "inherit" }}> · 👤 {value.managerName}</span> : null}
            {value.orders != null ? <span style={{ fontFamily: "inherit" }}> · {value.orders} опл</span> : null}
          </div>
        </div>
        <button onClick={() => onPick(null)} disabled={disabled} title="Обрати іншого"
          style={{ border: "none", background: "transparent", cursor: "pointer", color: "#1d4ed8", fontSize: 12 }}>
          змінити
        </button>
      </div>
    );
  }

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input
        value={q} disabled={disabled} autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (hits?.length) setOpen(true); }}
        onKeyDown={(e) => {
          if (!open || !hits?.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
          if (e.key === "Enter") { e.preventDefault(); pick(hits[cursor]); }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder ?? "почніть вводити назву або номер…"}
        style={input}
      />
      {q.trim().length > 0 && q.trim().length < 2 && (
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>ще хоча б одна літера…</div>
      )}
      {loading && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>шукаю…</div>}
      {open && hits != null && (
        <div style={{ position: "absolute", zIndex: 40, left: 0, right: 0, top: "100%", marginTop: 4,
                      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
                      boxShadow: "0 12px 28px rgba(0,0,0,.12)", maxHeight: 280, overflowY: "auto" }}>
          {hits.length === 0 && (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "#9ca3af" }}>
              нікого не знайшли — спробуйте частину назви або номер телефону
            </div>
          )}
          {hits.map((h, i) => (
            <div key={h.clientKey} onMouseEnter={() => setCursor(i)} onMouseDown={(e) => { e.preventDefault(); pick(h); }}
              style={{ padding: "7px 11px", cursor: "pointer", background: i === cursor ? "#eff6ff" : "#fff",
                       borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{h.clientName}</div>
              <div style={{ fontSize: 11, color: "#6b7280", display: "flex", gap: 8, flexWrap: "wrap" }}>
                {/* Менеджер — те саме джерело, що в передачі відповідального:
                    COALESCE(закріплений, основний за оплатами). */}
                <span>👤 {h.managerName ?? "—"}{h.pinned ? " 📌" : ""}{h.managerName && !h.managerActive ? " (деактив.)" : ""}</span>
                <span>· {h.orders} опл · {formatAmountFull(h.lifetimeRevenue)}</span>
                <span>· остання: {h.lastPaid ?? "—"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
