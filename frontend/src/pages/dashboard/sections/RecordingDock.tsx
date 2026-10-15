import { useEffect, useState } from "react";
import { RecordingPlayer } from "./RecordingPlayer";

/**
 * 🎧 ЗАКРІПЛЕНИЙ ПЛЕЄР ЗАПИСІВ (Роман 15.10.2026: «плеєр дзвінків трішки погано працює — зроби його меншим та
 * фіксованим в одному місці»). Раніше плеєр ставав рядком таблиці на всю її ширину: на широкій таблиці «Постійних
 * клієнтів», що гортається вбік, він обрізався зліва, а смуга перемотки тяглась на 2 000+ px і виїжджала за екран.
 *
 * Тепер панель ОДНА на весь дашборд (підключена в `Dashboard.tsx`), у правому нижньому куті, і не рухається разом
 * із таблицею. ▶ у рядку клієнта чи в картці кличе `openRecording` — панель перемикається на цей запис; ✕ закриває.
 */
export interface DockTrack { src: string; label: string }

const DOCK_EVENT = "rec-dock";
let current: DockTrack | null = null;

export function openRecording(t: DockTrack | null): void {
  current = t;
  window.dispatchEvent(new CustomEvent<DockTrack | null>(DOCK_EVENT, { detail: t }));
}
export const closeRecording = () => openRecording(null);

/** Запис, що зараз у панелі (`src` або `null`) — щоб ▶ у рядку показував ⏹ саме біля того, що грає. */
export function useDockSrc(): string | null {
  const [src, setSrc] = useState<string | null>(current?.src ?? null);
  useEffect(() => {
    const on = (e: Event) => setSrc((e as CustomEvent<DockTrack | null>).detail?.src ?? null);
    window.addEventListener(DOCK_EVENT, on);
    return () => window.removeEventListener(DOCK_EVENT, on);
  }, []);
  return src;
}

export function RecordingDock() {
  const [t, setT] = useState<DockTrack | null>(current);
  useEffect(() => {
    const on = (e: Event) => setT((e as CustomEvent<DockTrack | null>).detail);
    window.addEventListener(DOCK_EVENT, on);
    return () => window.removeEventListener(DOCK_EVENT, on);
  }, []);
  if (!t) return null;
  return (
    <div role="region" aria-label="Плеєр запису" className="rec-dock"
      style={{ position: "fixed", right: 16, bottom: 16, zIndex: 1200, width: "min(420px, calc(100vw - 32px))", boxSizing: "border-box",
        background: "#fff", border: "1px solid #d1d5db", borderRadius: 12, boxShadow: "0 8px 24px rgba(15,23,42,.18)", padding: "8px 12px 6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span title={t.label} style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>🎧 {t.label}</span>
        <button type="button" onClick={closeRecording} aria-label="Закрити плеєр" title="Закрити плеєр"
          style={{ border: 0, background: "none", cursor: "pointer", fontSize: 15, lineHeight: 1, color: "#6b7280", padding: 2 }}>✕</button>
      </div>
      <RecordingPlayer key={t.src} src={t.src} />
    </div>
  );
}
