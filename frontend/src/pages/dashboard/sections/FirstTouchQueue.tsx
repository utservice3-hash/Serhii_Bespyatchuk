import { useEffect, useRef, useState } from "react";
import { fetchAiCallCard, fetchAiCallRecording, putAiCallNote, hiringError, type AiCallCardResp, type AiCallRowT } from "../../../api";
import { CHECK_ITEMS, CHECK_MARK_UI, REVIEW_REASON_UI, PROMISE_UI, TONE_COLOR, TYPE_LABEL, mmss, quoteTurnIndex, scoreLabel } from "../aiCallsView";
import { CallConversation, type SeekFn } from "./CallConversation";

/**
 * 🗂 ЧЕРГА РОЗБОРУ ТІМЛІДА (екран D, розкладка B — Роман 08.10.2026). Зліва — розмови, що потребують розбору (прапорець
 * сервера `needsReview`), справа — обрана: плеєр з доріжками, чек-лист з трьох пунктів і доказ до кожного («▶ 0:14 і
 * цитата»). «Опрацьовано · наступна» ставить позначку «Розібрано» і відкриває наступну. «Закрити» згортає чергу в смугу
 * на огляді — анімація в `firstTouch.css` (`.ftd-queue.is-closed`).
 */

const fmtFull = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const fmtShort = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const DOT: Record<"y" | "n" | "o", { mark: string; bg: string }> = { y: { mark: "✓", bg: "#166534" }, n: { mark: "✕", bg: "#b91c1c" }, o: { mark: "–", bg: "#9ca3af" } };

export function FirstTouchQueue({ rows, open, selected, onSelect, onClose, onReviewed, onOpenCard, title }: {
  rows: AiCallRowT[]; open: boolean; selected: string | null; onSelect: (uniqueid: string) => void; onClose: () => void;
  onReviewed: () => void; onOpenCard: (uniqueid: string) => void; title: string;
}) {
  const cur = rows.find((r) => r.uniqueid === selected) ?? rows[0] ?? null;
  const [c, setC] = useState<AiCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const seekRef = useRef<SeekFn | null>(null);

  useEffect(() => {
    if (!open || !cur) return;
    let alive = true;
    setC(null); setErr(null); setNote("");
    fetchAiCallCard(cur.uniqueid).then((x) => { if (alive) setC(x); }).catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [open, cur?.uniqueid]);

  const turns = c && !c.transcriptHidden ? c.turns : null;
  const at = (quote: string | undefined): number | null => {
    if (!quote || c?.mono === "mixed") return null;
    const i = quoteTurnIndex(turns, quote);
    return i >= 0 ? turns?.[i]?.start ?? null : null;
  };
  const r = c?.result ?? null;
  const promise = r?.promises.find((p) => p.who === "manager" && p.channel === "call") ?? null;
  const evidence: Record<"request" | "price" | "promise", { text: string; quote?: string }> = {
    request: { text: r?.client_request?.trim() || "запиту клієнта модель не виділила" },
    price: { text: r ? (r.price.discussed ? "ціну назвали" : cur?.conversationType === "lead_lost" ? "втрачений лід — називати нікому" : "ціни не прозвучало") : "", quote: r?.price.quote },
    promise: { text: promise ? `${promise.what}${cur?.promiseState ? ` · ${PROMISE_UI[cur.promiseState].label.toLowerCase()}` : ""}` : "обіцянки передзвонити не було", quote: promise?.quote },
  };

  const next = () => {
    const i = rows.findIndex((x) => x.uniqueid === cur?.uniqueid);
    const nx = rows[i + 1] ?? rows[i - 1] ?? null;
    if (nx) onSelect(nx.uniqueid);
  };
  const review = async () => {
    if (!cur) return;
    setBusy(true); setErr(null);
    try { await putAiCallNote(cur.uniqueid, "review", note.trim() || "Розібрано"); next(); onReviewed(); }
    catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };
  const offline = async () => {
    if (!cur) return;
    setBusy(true); setErr(null);
    try { await putAiCallNote(cur.uniqueid, "offline", note.trim() || "Передзвонив поза телефонією"); onReviewed(); }
    catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };

  return (
    <div className={`ftd-queue${open ? "" : " is-closed"}`} aria-hidden={!open} role="dialog" aria-label="Черга розбору">
      <div className="ftd-q-head">
        <div>
          <div className="ftd-kicker">Черга розбору · {title}</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>Розібрати: <span style={{ color: "var(--brand)", fontVariantNumeric: "tabular-nums" }}>{rows.length}</span></div>
        </div>
        <button type="button" className="ftd-btn" style={{ fontWeight: 600 }} onClick={onClose}>Закрити ✕</button>
      </div>

      {rows.length === 0
        ? <div className="ftd-card ftd-card-pad"><b>Черга порожня.</b><span className="ftd-sub">Усі розмови, що потребували розбору за цей період, розібрано.</span></div>
        : (
          <div className="ftd-q-body">
            <section aria-label="Черга" className="ftd-q-list">
              {rows.map((q) => {
                const why = q.reviewReason ? REVIEW_REASON_UI[q.reviewReason] : null;
                const tone = why ? TONE_COLOR[why.tone] : TONE_COLOR.muted;
                return (
                  <button key={q.uniqueid} type="button" className={`ftd-q-item${q.uniqueid === cur?.uniqueid ? " on" : ""}`} onClick={() => onSelect(q.uniqueid)}
                    aria-current={q.uniqueid === cur?.uniqueid}>
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%" }}>
                      <b>{q.managerName ?? "Менеджер невідомий"}</b><span className="ftd-sub">{fmtShort(q.calledAt)}</span>
                    </span>
                    <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{q.summary ?? "—"}</span>
                    {why && <span className="ftd-chip" style={{ alignSelf: "flex-start", background: tone.bg, color: tone.fg, fontWeight: 600 }}>{why.label}</span>}
                  </button>
                );
              })}
            </section>

            <section aria-label="Розмова з доказами" className="ftd-q-card">
              {cur && (
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div className="ftd-sub">{fmtFull(cur.calledAt)} · {cur.direction === "in" ? "вхідний" : "вихідний"} · {mmss(cur.billsec)}
                      {c?.dealUrls.map((d) => <span key={d.kommoId}> · <a href={d.url} target="_blank" rel="noreferrer">угода {d.kommoId} ↗</a></span>)}</div>
                    <div style={{ fontSize: 19, fontWeight: 800 }}>{cur.managerName ?? "Менеджер невідомий"}{r?.client_request ? ` · ${r.client_request}` : ""}</div>
                    {cur.conversationType && <div className="ftd-sub">{TYPE_LABEL[cur.conversationType]}{cur.typeConfidence != null ? ` · ${String(Math.round(cur.typeConfidence * 100))}%` : ""}</div>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="ftd-sub">Чек-лист</div>
                    <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{scoreLabel(cur.checkScore)?.replace("/", " / ") ?? "—"}</div>
                  </div>
                </div>
              )}
              {err && <p style={{ margin: 0, color: "var(--danger)" }}>{err}</p>}
              {!c && !err && <p className="loading-text" style={{ margin: 0 }}>Завантаження розмови…</p>}
              {c && (
                <>
                  {r?.summary && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55 }}>{r.summary}</p>}
                  {c.canListen && c.durationSec != null && (
                    <div style={{ background: "var(--bg)", borderRadius: 10, padding: "10px 12px" }}>
                      {c.mono && <p style={{ margin: "0 0 6px", fontSize: 12.5, color: "var(--text-muted)" }}>{c.mono === "mixed"
                        ? "Запис моно: голоси не розділені — доріжок і перемотки по фразах немає."
                        : "Запис моно: голоси розділено за звучанням — підпис «Менеджер / Клієнт» може помилятись."}</p>}
                      <CallConversation load={() => fetchAiCallRecording(c.row.uniqueid)} turns={turns} managerChannel={c.managerChannel}
                        quoted={new Set()} seekRef={seekRef} mixed={c.mono === "mixed"} durationSec={c.durationSec} showTurns={false} />
                    </div>
                  )}
                  <div>
                    {CHECK_ITEMS.map((it) => {
                      const m = cur?.checklist?.[it.key] ?? "o";
                      const ev = evidence[it.key];
                      const t = at(ev.quote);
                      return (
                        <div key={it.key} className="ftd-check">
                          <span aria-hidden="true" className="ftd-check-dot" style={{ background: DOT[m].bg }}>{DOT[m].mark}</span>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            <div><b>{it.label}</b> <span style={{ fontSize: 13, color: DOT[m].bg, fontWeight: 600 }}>· {CHECK_MARK_UI[m].label}</span></div>
                            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{ev.text}</div>
                            {ev.quote?.trim() && (t != null
                              ? <button type="button" className="ftd-quote" onClick={() => seekRef.current?.(t)}>▶ <b>{mmss(t)}</b> «{ev.quote}»</button>
                              : <span className="ftd-quote" style={{ cursor: "default" }}>«{ev.quote}»</span>)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <label htmlFor="ftd-review-note" style={{ fontSize: 13, fontWeight: 600 }}>Коментар менеджеру <span className="ftd-sub">· необовʼязково</span></label>
                  <textarea id="ftd-review-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)}
                    placeholder={`Що сказати ${cur?.managerName ?? "менеджеру"} по цій розмові`}
                    style={{ minHeight: 60, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", font: "inherit", resize: "vertical", background: "var(--card-bg)", color: "var(--text)" }} />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" className="ftd-btn dark" disabled={busy} onClick={() => void review()}>{busy ? "Зберігаю…" : "Опрацьовано · наступна ›"}</button>
                    {cur?.reviewReason === "noCall" && c.noteRights.offline && (
                      <button type="button" className="ftd-btn" disabled={busy} onClick={() => void offline()}>Передзвонив поза телефонією</button>
                    )}
                    <button type="button" className="ftd-btn" onClick={() => cur && onOpenCard(cur.uniqueid)}>Повна картка і розмова</button>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
    </div>
  );
}
