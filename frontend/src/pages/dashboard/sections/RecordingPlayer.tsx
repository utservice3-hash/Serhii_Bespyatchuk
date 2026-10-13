import { useEffect, useRef, useState } from "react";
import { mmss } from "../aiCallsView";
import { seekBy, seekAt, PLAYER_RATES, type PlayerRate } from "./recordingPlayerRules";

/**
 * 🎧 ЗАПИС ДЗВІНКА НА ЕКРАНІ «КЛІЄНТИ» — ОДИН ПЛЕЄР ДЛЯ ТРЬОХ МІСЦЬ (задача 13.10.2026, скрин Романа 29.09): рядок
 * клієнта («розмова ДД.ММ»), «обґрунтування плану» і картка клієнта. Вбудований `<audio controls>` шириною 230 px
 * давав смугу перемотки в кілька пікселів — точно перемотати було неможливо.
 *
 * Тут: ▶ / пауза, широка смуга (клік і перетягування), час, −10 с / +10 с, швидкість 1× / 1,5× / 2×. Запис — прямий
 * лінк Ringostat, як і був (рішення власника 05.08.2026: без проксі). Одночасно грає один плеєр: той, що стартував,
 * ставить решту на паузу — і плеєри «Першого дотику», що слухають ту саму подію.
 */
const PLAY_EVENT = "ft-audio-play";
let seq = 0;

export function RecordingPlayer({ src, autoPlay = true }: { src: string; autoPlay?: boolean }) {
  const me = useRef(++seq);
  const audio = useRef<HTMLAudioElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [play, setPlay] = useState(false);
  const [rate, setRate] = useState<PlayerRate>(1);
  const [err, setErr] = useState(false);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate, src]);
  useEffect(() => {
    const onOther = (e: Event) => { if ((e as CustomEvent<number>).detail !== me.current) audio.current?.pause(); };
    window.addEventListener(PLAY_EVENT, onOther);
    return () => { window.removeEventListener(PLAY_EVENT, onOther); audio.current?.pause(); };
  }, []);

  const go = (t: number) => { const a = audio.current; if (!a) return; a.currentTime = t; setPos(t); };
  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) void a.play().catch(() => setErr(true)); else a.pause(); };
  const fromPointer = (clientX: number) => {
    const b = bar.current?.getBoundingClientRect();
    if (b && dur) go(seekAt(clientX - b.left, b.width, dur));
  };
  const btn: React.CSSProperties = { fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", whiteSpace: "nowrap" };

  return (
    <div className="rec-player" style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minWidth: 0, padding: "4px 0" }}>
      <audio ref={audio} src={src} autoPlay={autoPlay} preload="metadata"
        onPlay={() => { setPlay(true); setErr(false); window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: me.current })); }}
        onPause={() => setPlay(false)} onEnded={() => setPlay(false)} onError={() => setErr(true)}
        onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); e.currentTarget.playbackRate = rate; }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} />
      <button type="button" onClick={toggle} aria-label={play ? "Пауза" : "Слухати"}
        style={{ width: 32, height: 32, borderRadius: "50%", border: 0, background: "#2563eb", color: "#fff", cursor: "pointer", flex: "none", fontSize: 12 }}>
        {play ? "❚❚" : "▶"}</button>
      <button type="button" onClick={() => go(seekBy(pos, -10, dur))} title="Назад на 10 секунд" style={btn}>−10 с</button>
      <div ref={bar} role="slider" aria-label="Перемотка запису" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pos)} tabIndex={0}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons & 1) fromPointer(e.clientX); }}
        onKeyDown={(e) => { if (e.key === "ArrowLeft") go(seekBy(pos, -5, dur)); if (e.key === "ArrowRight") go(seekBy(pos, 5, dur)); }}
        style={{ flex: 1, minWidth: 120, height: 18, display: "flex", alignItems: "center", cursor: dur ? "pointer" : "default", touchAction: "none" }}>
        <div style={{ position: "relative", width: "100%", height: 6, borderRadius: 3, background: "#e5e7eb" }}>
          <i style={{ position: "absolute", inset: "0 auto 0 0", width: `${String(dur ? (pos / dur) * 100 : 0)}%`, background: "#2563eb", borderRadius: 3 }} />
          <b style={{ position: "absolute", top: -4, left: `calc(${String(dur ? (pos / dur) * 100 : 0)}% - 7px)`, width: 14, height: 14, borderRadius: "50%", background: "#fff", border: "2px solid #2563eb" }} />
        </div>
      </div>
      <button type="button" onClick={() => go(seekBy(pos, 10, dur))} title="Вперед на 10 секунд" style={btn}>+10 с</button>
      <span style={{ fontSize: 12, color: "#6b7280", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{mmss(pos)} / {dur ? mmss(dur) : "—"}</span>
      <span style={{ display: "flex", gap: 3 }}>
        {PLAYER_RATES.map((r) => (
          <button key={r} type="button" onClick={() => setRate(r)} aria-pressed={rate === r}
            style={{ ...btn, padding: "3px 6px", background: rate === r ? "#111827" : "#fff", color: rate === r ? "#fff" : "#374151" }}>{r}×</button>
        ))}
      </span>
      {err && <span style={{ fontSize: 12, color: "#b91c1c" }}>запис не відкрився</span>}
    </div>
  );
}
