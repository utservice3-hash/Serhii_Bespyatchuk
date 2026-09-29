import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { fetchCarrierAudio, fetchCarrierCallCard, fetchCarrierPending, postCarrierDecision,
  type CarrierCallCardResp, type CarrierDecidedT, type CarrierPendingT } from "../../../api";
import { InfoHint } from "../widgets";
import { mmss } from "../aiCallsView";
import { DECISION_UI, ROLE_UI, speakerShort, type HumanDecisionT } from "../carrierCallsView";

/**
 * 🙋 «ПОТРІБНЕ ВАШЕ РІШЕННЯ» — невпевнені вердикти AI (рішення Романа 29.09.2026, макет погоджено).
 * Слухаємо запис (лише адмін і КВП — сервер інакше не віддає), тиснемо «Перевізник / Клієнт / Інше».
 * Рішення людини сильніше за AI: «Перевізник» закривається в CRM, «Клієнт/Інше» — ніколи.
 * Після рішення рядок плавно відходить і відкривається наступний — черга розбирається підряд.
 */

const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const pill = (bg: string, fg: string): React.CSSProperties => ({ background: bg, color: fg, borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" });
const muted: React.CSSProperties = { color: "var(--text-muted)" };
const errText = (e: unknown) => (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e instanceof Error ? e.message : "не вдалося");

function Player({ uniqueid, quoteAt, onTime, seekRef }: { uniqueid: string; quoteAt: number | null; onTime: (t: number) => void;
  seekRef: React.MutableRefObject<((t: number) => void) | null> }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState(0); const [dur, setDur] = useState(0); const [play, setPlay] = useState(false); const [speed, setSpeed] = useState(1);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const toggle = async () => {
    if (state === "idle" || state === "error") {
      setState("loading"); setErr(null);
      try { const b = await fetchCarrierAudio(uniqueid); setSrc(URL.createObjectURL(b)); setState("ready"); }
      catch (e) { setErr(errText(e)); setState("error"); }
      return;
    }
    const a = audio.current; if (!a) return;
    if (a.paused) void a.play(); else a.pause();
  };
  useEffect(() => { if (state === "ready" && audio.current) void audio.current.play(); }, [state]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);
  const seek = (t: number) => { const a = audio.current; if (a && Number.isFinite(t)) { a.currentTime = t; setPos(t); } };
  // Перемотка з розшифровки: батько кличе через посилання (клік по репліці).
  useEffect(() => { seekRef.current = seek; return () => { seekRef.current = null; }; });
  return (
    <div>
      {src && <audio ref={audio} src={src} preload="auto" onPlay={() => setPlay(true)} onPause={() => setPlay(false)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} onTimeUpdate={(e) => { setPos(e.currentTarget.currentTime); onTime(e.currentTarget.currentTime); }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" className="cq-play" onClick={() => { void toggle(); }} aria-label={play ? "Пауза" : "Слухати"} disabled={state === "loading"}
          style={{ width: 34, height: 34, borderRadius: "50%", border: 0, background: "var(--brand)", color: "#fff", cursor: "pointer", flex: "none" }}>
          {state === "loading" ? "…" : play ? "❚❚" : "▶"}</button>
        <div onClick={(e) => { if (!dur) return; const b = e.currentTarget.getBoundingClientRect(); seek((e.clientX - b.left) / b.width * dur); }}
          style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--border)", position: "relative", cursor: dur ? "pointer" : "default" }}>
          <i className="cq-bar" style={{ position: "absolute", inset: "0 auto 0 0", width: `${String(dur ? pos / dur * 100 : 0)}%`, background: "var(--brand)", borderRadius: 3 }} />
          {quoteAt != null && dur > 0 && <span title="Тут цитата" style={{ position: "absolute", top: -4, left: `${String(Math.min(100, quoteAt / dur * 100))}%`, width: 3, height: 14, background: "var(--warn)", borderRadius: 2 }} />}
        </div>
        <span style={{ fontSize: 12, ...muted, fontVariantNumeric: "tabular-nums" }}>{mmss(pos)} / {dur ? mmss(dur) : "—"}</span>
        <button type="button" onClick={() => setSpeed(speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1)}
          style={{ fontSize: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "2px 6px", cursor: "pointer" }}>{speed}×</button>
      </div>
      {err && <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--danger)" }}>Запис недоступний: {err}</p>}
    </div>
  );
}

function Panel({ row, onDecide }: { row: CarrierPendingT; onDecide: (d: HumanDecisionT, note: string) => Promise<void> }) {
  const [card, setCard] = useState<CarrierCallCardResp | null>(null);
  const [now, setNow] = useState(0);
  const [note, setNote] = useState(""); const [noteOpen, setNoteOpen] = useState(false); const [busy, setBusy] = useState(false);
  const seekRef = useRef<((t: number) => void) | null>(null);
  useEffect(() => { let alive = true; fetchCarrierCallCard(row.uniqueid).then((c) => { if (alive) setCard(c); }).catch(() => {}); return () => { alive = false; }; }, [row.uniqueid]);
  const quote = card?.result?.caller_role_quote?.trim() ?? "";
  const turns = card?.turns ?? [];
  const mc = card?.managerChannel ?? null;
  const quoteTurn = turns.find((t) => quote && t.channel !== mc && t.text.includes(quote));
  const canListen = card != null && !card.transcriptHidden;
  const decide = async (d: HumanDecisionT) => { setBusy(true); try { await onDecide(d, note); } finally { setBusy(false); } };
  return (
    <div style={{ display: "grid", gridTemplateColumns: canListen ? "minmax(0,1.3fr) minmax(0,1fr)" : "1fr", gap: 16, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
      {canListen && (
        <div>
          <Player uniqueid={row.uniqueid} quoteAt={quoteTurn?.start ?? null} onTime={setNow} seekRef={seekRef} />
          <div style={{ marginTop: 10, maxHeight: 200, overflowY: "auto" }}>
            {turns.map((t, i) => {
              const next = turns[i + 1]; const cur = t.start != null && now >= t.start && (!next || next.start == null || now < next.start);
              const them = mc != null && t.channel !== mc;
              return <p key={i} className="cq-line" title="Перемотати сюди"
                onClick={() => { if (t.start != null) seekRef.current?.(t.start); }}
                style={{ margin: "1px 0", fontSize: 13, padding: "3px 6px", borderRadius: 6, cursor: "pointer", background: cur ? "var(--info-bg)" : undefined }}>
                <span style={{ fontWeight: 600, marginRight: 6, color: them ? "var(--warn)" : "var(--text-muted)" }}>{speakerShort(t.channel, mc)}</span>
                {t === quoteTurn ? <mark style={{ background: "var(--warn-bg)", color: "inherit", borderRadius: 3 }}>{t.text}</mark> : t.text}</p>;
            })}
            {card && !turns.length && <p style={{ margin: 0, fontSize: 13, ...muted }}>{card.textPurged ? "Текст видалено за строком зберігання." : "Розшифровки немає."}</p>}
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ ...muted, marginRight: 6 }}>AI:</span>
          <span style={pill(ROLE_UI[row.role]?.bg ?? "var(--surface-2)", ROLE_UI[row.role]?.fg ?? "var(--text-muted)")}>{ROLE_UI[row.role]?.label ?? row.role}</span>
          <span style={{ ...muted, marginLeft: 6 }}>{row.confidence.toFixed(2).replace(".", ",")}</span>
          {quote && <div style={{ fontStyle: "italic", marginTop: 4 }}>«{quote}»</div>}
          {card && card.transcriptHidden && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Запис і текст — адмін і КВП.</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(DECISION_UI) as HumanDecisionT[]).map((v) => (
            <button key={v} type="button" className="cq-btn" title={DECISION_UI[v].hint} disabled={busy} onClick={() => { void decide(v); }}
              style={{ flex: "1 1 0", minWidth: 96, border: `1px solid ${DECISION_UI[v].fg}`, background: "transparent", color: "var(--text)", borderRadius: 8, padding: "8px 6px", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = DECISION_UI[v].bg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              {DECISION_UI[v].icon} {DECISION_UI[v].label}</button>
          ))}
        </div>
        <div style={{ ...muted, fontSize: 12 }}>«Перевізник» — закриємо в CRM. Інше — лишиться на етапі.</div>
        {noteOpen
          ? <textarea id="carrier-decision-note" autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Коментар"
              style={{ fontSize: 13, minHeight: 44, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", background: "var(--card-bg)", color: "var(--text)", resize: "vertical" }} />
          : <button type="button" onClick={() => setNoteOpen(true)} style={{ alignSelf: "flex-start", border: 0, background: "none", color: "var(--info)", cursor: "pointer", fontSize: 12.5, padding: 0 }}>+ коментар</button>}
      </div>
    </div>
  );
}

export function CarrierDecisionQueue({ onChanged }: { onChanged: () => void }) {
  const [pending, setPending] = useState<CarrierPendingT[] | null>(null);
  const [decided, setDecided] = useState<CarrierDecidedT[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState<"wait" | "done">("wait");
  const [leaving, setLeaving] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [changing, setChanging] = useState<number | null>(null);
  const load = useCallback(async (openFirst: boolean) => {
    try {
      const d = await fetchCarrierPending();
      setPending(d.pending); setDecided(d.decided); setErr(null);
      if (openFirst) setOpen(d.pending[0]?.kommoId ?? null);
    } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(true); }, [load]);
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** Рішення: запис → рядок плавно відходить → відкривається наступний, що чекає. */
  const decide = async (row: CarrierPendingT, d: HumanDecisionT, note: string) => {
    try { await postCarrierDecision(row.kommoId, d, note); }
    catch (e) { window.alert(`Рішення не записано: ${errText(e)}`); return; }
    const next = (pending ?? []).find((p) => p.kommoId !== row.kommoId)?.kommoId ?? null;
    const finish = () => { setLeaving(null); setOpen(next); void load(false); onChanged(); };
    if (reduce) { finish(); return; }
    setLeaving(row.kommoId); setOpen(null);
    setTimeout(finish, 300);
  };

  /** Змінити рішення — доки угоду не закрито в CRM (після — сервер відмовить і підкаже «Повернути на етап»). */
  const change = async (kommoId: number, d: HumanDecisionT) => {
    try { await postCarrierDecision(kommoId, d, ""); setChanging(null); await load(false); onChanged(); }
    catch (e) { window.alert(`Не змінено: ${errText(e)}`); }
  };

  if (err) return <div className="chart-card" style={{ marginBottom: 16 }}><p style={{ margin: 0, color: "var(--danger)" }}>Черга рішень: {err}</p></div>;
  if (!pending) return null;
  if (!pending.length && !decided.length) return null;
  const cell: React.CSSProperties = { padding: "8px 10px", verticalAlign: "middle" };
  return (
    <div className="chart-card" style={{ borderLeft: "4px solid var(--warn)", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          Потрібне ваше рішення
          <InfoHint text="AI не впевнений: впевненість нижче 0,85, цитата — слова менеджера, або розмову не розібрати. Послухайте і виберіть. Рішення людини сильніше за AI." />
        </h3>
        <div role="group" aria-label="Черга рішень" style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {(["wait", "done"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k} style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "3px 12px", fontSize: 13, cursor: "pointer",
              background: tab === k ? "var(--accent-bg, #e8f0fb)" : "transparent", fontWeight: tab === k ? 600 : 400 }}>
              {k === "wait" ? <>Чекають <span key={pending.length} className="cq-pop">{pending.length}</span></> : <>Вирішені <span key={decided.length} className="cq-pop">{decided.length}</span></>}</button>
          ))}
        </div>
      </div>
      {tab === "wait"
        ? (pending.length === 0
          ? <p key="empty" className="cq-fade" style={{ margin: 0, ...muted }}>Усе вирішено 👌</p>
          : <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <tbody key="wait" className="cq-fade">
                {pending.map((p) => (
                  <Fragment key={p.kommoId}>
                    <tr className={`cq-row${leaving === p.kommoId ? " leave" : ""}`} tabIndex={0} aria-expanded={open === p.kommoId}
                      onClick={() => setOpen(open === p.kommoId ? null : p.kommoId)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(open === p.kommoId ? null : p.kommoId); }}
                      style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: open === p.kommoId ? "var(--surface-2)" : undefined }}>
                      <td style={{ ...cell, whiteSpace: "nowrap", width: 1 }}>{fmtTime(p.calledAt)}<span style={{ ...muted, marginLeft: 6, fontSize: 12 }}>{mmss(p.billsec)}</span></td>
                      <td style={{ ...cell, width: 1 }}><a href={p.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>№ {p.kommoId}</a></td>
                      <td style={cell}>{p.managerName ?? <span style={muted}>невідомий</span>}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        <span style={pill(ROLE_UI[p.role]?.bg ?? "var(--surface-2)", ROLE_UI[p.role]?.fg ?? "var(--text-muted)")}>{ROLE_UI[p.role]?.label ?? p.role}</span>
                        <span style={{ ...muted, fontSize: 12, marginLeft: 6 }}>{p.why}</span></td>
                      <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap", color: "var(--info)", fontSize: 13 }}>{open === p.kommoId ? "згорнути" : "слухати →"}</td>
                    </tr>
                    {open === p.kommoId && <tr><td colSpan={5} style={{ padding: "0 10px 12px", background: "var(--surface-2)" }}>
                      <div className="cq-panel"><Panel row={p} onDecide={(d, note) => decide(p, d, note)} /></div></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>)
        : (decided.length === 0
          ? <p key="empty-done" className="cq-fade" style={{ margin: 0, ...muted }}>Ще нічого не вирішено.</p>
          : <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <tbody key="done" className="cq-fade">
                {decided.map((p) => (
                  <tr key={p.kommoId} className="cq-row" style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ ...cell, whiteSpace: "nowrap", width: 1 }}>{fmtTime(p.calledAt)}</td>
                    <td style={{ ...cell, width: 1 }}><a href={p.url} target="_blank" rel="noreferrer" style={{ whiteSpace: "nowrap" }}>№ {p.kommoId}</a></td>
                    <td style={cell}>{p.managerName ?? <span style={muted}>невідомий</span>}</td>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}><span className="cq-pop" style={pill(DECISION_UI[p.decision].bg, DECISION_UI[p.decision].fg)}>✓ {DECISION_UI[p.decision].label}</span>
                      {p.note && <span style={{ ...muted, fontSize: 12, marginLeft: 6 }}>«{p.note}»</span>}</td>
                    <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap", ...muted, fontSize: 12.5 }}>
                      {changing === p.kommoId
                        ? <span className="cq-fade" style={{ display: "inline-flex", gap: 4 }}>
                            {(Object.keys(DECISION_UI) as HumanDecisionT[]).filter((v) => v !== p.decision).map((v) => (
                              <button key={v} type="button" className="cq-btn" onClick={() => { void change(p.kommoId, v); }}
                                style={{ border: `1px solid ${DECISION_UI[v].fg}`, background: "transparent", color: "var(--text)", borderRadius: 6, padding: "2px 8px", fontSize: 12.5, cursor: "pointer" }}>
                                {DECISION_UI[v].icon} {DECISION_UI[v].label}</button>
                            ))}
                            <button type="button" onClick={() => setChanging(null)} style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12.5 }}>скасувати</button>
                          </span>
                        : <>{p.by} · {fmtTime(p.at)}
                            <button type="button" onClick={() => setChanging(p.kommoId)} style={{ marginLeft: 8, border: 0, background: "none", color: "var(--info)", cursor: "pointer", fontSize: 12.5 }}>змінити</button></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>)}
    </div>
  );
}
