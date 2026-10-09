import { Fragment, useEffect, useRef, useState } from "react";
import type { AiTurn } from "../../../api";
import { hiringError } from "../../../api";
import { mmss, speakerOf } from "../aiCallsView";

/**
 * 🎧 РОЗМОВА В КАРТЦІ «ПЕРШОГО ДОТИКУ» — та сама система, що в «Перевізниках за розмовою» (прохання Романа 07.10.2026):
 * кругла кнопка ▶, смуга з перемоткою кліком, час, швидкість 1× / 1.5× / 2×, під нею — репліки: клік перемотує,
 * поточна підсвічується, жовтим — фрази, на які спирається розбір (мітки на смузі там само). Запис тягнеться лише
 * після першого ▶ — байти через наш сервер, права вирішує він.
 */

export type SeekFn = (t: number) => void;

/** Доріжка мовця під смугою: коли він говорив (з часу реплік), як у «Перевізниках» і макеті D. */
export interface Lane { label: string; color: string; spans: { start: number; end: number }[] }

/** Одночасно грає лише один плеєр: той, що стартував, сповіщає решту, і вони стають на паузу. */
const PLAY_EVENT = "ft-audio-play";
let playerSeq = 0;

function Player({ load, marks, onTime, seekRef, lanes = [], durHint = null, preload = true, active = true }: { load: () => Promise<Blob>; marks: number[]; onTime: (t: number) => void;
  seekRef: React.MutableRefObject<SeekFn | null>; lanes?: Lane[]; durHint?: number | null;
  /** Почати тягнути запис одразу при відкритті картки — тоді ▶ грає без очікування (Роман 08.10.2026). */
  preload?: boolean;
  /** `false` — плеєр сховано (згорнута черга): запис стає на паузу, а не грає у фоні. */
  active?: boolean }) {
  const myId = useRef(++playerSeq);
  const wantPlay = useRef(false);
  const [queued, setQueued] = useState(false);
  const want = (v: boolean) => { wantPlay.current = v; setQueued(v); };
  const audio = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState(0); const [dur, setDur] = useState(0); const [play, setPlay] = useState(false); const [speed, setSpeed] = useState(1);
  const pending = useRef<number | null>(null);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const start = async (): Promise<void> => {
    setState("loading"); setErr(null);
    try { const b = await load(); setSrc(URL.createObjectURL(b)); setState("ready"); }
    catch (e) { setErr(hiringError(e)); setState("error"); }
  };
  const toggle = () => {
    if (state === "idle" || state === "error") { want(true); void start(); return; }
    // Запис ще тягнеться (попереднє завантаження) — заграє, щойно прийде.
    if (state === "loading") { want(true); return; }
    const a = audio.current; if (!a) return;
    if (a.paused) void a.play(); else a.pause();
  };
  // Попереднє завантаження: тягнемо запис одразу, але НЕ граємо, поки не натиснули ▶.
  useEffect(() => { if (preload && state === "idle") void start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state === "ready" && audio.current && wantPlay.current) { want(false); void audio.current.play(); } }, [state]);
  // Сховали (черга згорнута) — пауза.
  useEffect(() => { if (!active) { want(false); audio.current?.pause(); } }, [active]);
  // Інший плеєр стартував — пауза тут.
  useEffect(() => {
    const onOther = (e: Event) => { if ((e as CustomEvent<number>).detail !== myId.current) audio.current?.pause(); };
    window.addEventListener(PLAY_EVENT, onOther);
    return () => { window.removeEventListener(PLAY_EVENT, onOther); audio.current?.pause(); };
  }, []);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed, src]);
  const seek = (t: number) => {
    if (!Number.isFinite(t)) return;
    const a = audio.current;
    // Клік по репліці до першого ▶: спершу вантажимо запис, перемотаємо, щойно знатимемо тривалість.
    if (!a) { pending.current = t; want(true); if (state === "idle" || state === "error") void start(); return; }
    a.currentTime = t; setPos(t); if (a.paused) void a.play();
  };
  useEffect(() => { seekRef.current = seek; return () => { seekRef.current = null; }; });
  return (
    <div>
      {src && <audio ref={audio} src={src} preload="auto" onPlay={() => { setPlay(true); window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: myId.current })); }} onPause={() => setPlay(false)} onEnded={() => setPlay(false)}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget; setDur(a.duration);
          if (pending.current != null) { a.currentTime = pending.current; setPos(pending.current); pending.current = null; if (wantPlay.current) { want(false); void a.play(); } }
        }}
        onTimeUpdate={(e) => { setPos(e.currentTarget.currentTime); onTime(e.currentTarget.currentTime); }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" className="cq-play" onClick={toggle} aria-label={play ? "Пауза" : "Слухати"} aria-busy={state === "loading"}
          style={{ width: 34, height: 34, borderRadius: "50%", border: 0, background: "var(--brand)", color: "#fff", cursor: "pointer", flex: "none" }}>
          {state === "loading" && queued ? "…" : play ? "❚❚" : "▶"}</button>
        <div style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: lanes.length ? "64px minmax(0, 1fr)" : "minmax(0, 1fr)", gap: "5px 8px", alignItems: "center" }}>
          {lanes.length > 0 && <span />}
          <div onClick={(e) => { if (!dur) return; const b = e.currentTarget.getBoundingClientRect(); seek((e.clientX - b.left) / b.width * dur); }}
            style={{ height: 6, borderRadius: 3, background: "var(--border)", position: "relative", cursor: dur ? "pointer" : "default" }}>
            <i className="cq-bar" style={{ position: "absolute", inset: "0 auto 0 0", width: `${String(dur ? pos / dur * 100 : 0)}%`, background: "var(--brand)", borderRadius: 3 }} />
            {(dur || durHint) ? marks.map((m, i) => (
              <span key={i} title="Тут фраза з розбору" style={{ position: "absolute", top: -4, left: `${String(Math.min(100, m / (dur || durHint || 1) * 100))}%`, width: 3, height: 14, background: "var(--warn)", borderRadius: 2 }} />
            )) : null}
          </div>
          {lanes.map((l) => (
            <Fragment key={l.label}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{l.label}</span>
              <div className="ft-lane" aria-hidden="true" style={{ position: "relative", height: 8, background: "var(--bg, #f4f3f1)", borderRadius: 2 }}>
                {(dur || durHint) ? l.spans.map((s, i) => (
                  <span key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${String(Math.min(100, s.start / (dur || durHint || 1) * 100))}%`,
                    width: `${String(Math.max(0.6, (s.end - s.start) / (dur || durHint || 1) * 100))}%`, background: l.color, borderRadius: 2 }} />
                )) : null}
              </div>
            </Fragment>
          ))}
        </div>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{mmss(pos)} / {dur ? mmss(dur) : "—"}</span>
        <button type="button" onClick={() => setSpeed(speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1)}
          style={{ fontSize: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "2px 6px", cursor: "pointer" }}>{speed}×</button>
      </div>
      {err && <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--danger)" }}>{err}</p>}
    </div>
  );
}

/**
 * Плеєр і репліки разом. `turns` — null, коли тексту цій ролі не віддали (тоді лише плеєр); `quoted` — індекси
 * реплік, на які спирається розбір (`quoteTurnIndex`).
 */
export function CallConversation({ load, turns, managerChannel, quoted, seekRef, mixed = false, durationSec = null, showTurns = true, active = true }: {
  load: () => Promise<Blob>; turns: AiTurn[] | null; managerChannel: number | null; quoted: ReadonlySet<number>;
  seekRef: React.MutableRefObject<SeekFn | null>;
  /** Моно без розділення голосів: підпис «Обидва голоси», а не «Менеджер» — інакше підпис бреше. */
  mixed?: boolean;
  /** Тривалість запису з розшифровки — щоб доріжки й мітки стояли на місці ще до завантаження. */
  durationSec?: number | null;
  /** `false` — лише плеєр із доріжками (черга розбору показує текст окремо). */
  showTurns?: boolean;
  /** `false` — сховано (згорнута черга): пауза. */
  active?: boolean;
}) {
  const [now, setNow] = useState(0);
  const list = turns ?? [];
  const marks = [...quoted].map((i) => list[i]?.start).filter((s): s is number => s != null);
  // Доріжки — лише коли відомо, хто менеджер, і голоси розділені: інакше смуга «Менеджер» брехала б.
  const lanes: Lane[] = !mixed && managerChannel != null && list.length > 0 ? [
    { label: "Менеджер", color: "var(--rpt-ink, #16181d)", spans: list.filter((t) => t.channel === managerChannel && t.start != null).map((t) => ({ start: t.start!, end: t.end ?? t.start! + 1 })) },
    { label: "Клієнт", color: "#b45309", spans: list.filter((t) => t.channel !== managerChannel && t.start != null).map((t) => ({ start: t.start!, end: t.end ?? t.start! + 1 })) },
  ] : [];
  return (
    <>
      <Player load={load} marks={marks} onTime={setNow} seekRef={seekRef} lanes={lanes} durHint={durationSec} active={active} />
      {showTurns && list.length > 0 && (
        <div style={{ marginTop: 10, maxHeight: 280, overflowY: "auto" }}>
          {list.map((t, i) => {
            const next = list[i + 1];
            const cur = t.start != null && now > 0 && now >= t.start && (!next || next.start == null || now < next.start);
            const who = mixed ? "Обидва голоси" : speakerOf(t.channel, managerChannel);
            return (
              <p key={i} className="cq-line" title="Перемотати сюди" onClick={() => { if (t.start != null) seekRef.current?.(t.start); }}
                style={{ margin: "1px 0", fontSize: 13, padding: "3px 6px", borderRadius: 6, cursor: "pointer", background: cur ? "var(--info-bg)" : undefined }}>
                <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", marginRight: 6, fontSize: 12 }}>{mmss(t.start)}</span>
                <span style={{ fontWeight: 600, marginRight: 6, color: who === "Клієнт" ? "var(--warn)" : "var(--text-muted)" }}>{who}</span>
                {quoted.has(i) ? <mark style={{ background: "var(--warn-bg)", color: "inherit", borderRadius: 3 }}>{t.text}</mark> : t.text}
              </p>
            );
          })}
        </div>
      )}
    </>
  );
}
