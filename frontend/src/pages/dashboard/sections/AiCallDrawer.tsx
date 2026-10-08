import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchAiCallCard, setAiCallType, putAiCallNote, fetchAiCallRecording, hiringError, type AiCallCardResp, type AiQuoted } from "../../../api";
import { STATE_UI, TONE_COLOR, PROMISE_UI, mmss, afterLabel, drawerTabs, promisesLabel, deadlineBasisLabel, quoteTurnIndex, scoreLabel, REVIEW_REASON_UI, TYPE_LABEL, type AiCallState, type Tone } from "../aiCallsView";
import { CallConversation, type SeekFn } from "./CallConversation";
import { ChecklistBlock } from "./FirstTouchChecklist";
import "./hiring.css";

/**
 * 🎧 КАРТКА ДЗВІНКА — панель справа, як картка працівника в «Наймі» (прохання Романа 29.09.2026, макет —
 * артборд «6 · Картка дзвінка»). Стилі — спільні `hr-overlay` / `hr-drawer` / `hr-seg2` з `hiring.css`.
 *
 * Дані й права — той самий `/ai-calls/:uniqueid`, що й раніше: повний текст сервер віддає лише адміну
 * й КВП, тож вкладка «Розшифровка» зʼявляється тільки тоді, коли текст прийшов (`drawerTabs`).
 */

const fmtFull = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const c = TONE_COLOR[tone];
  return <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: "3px 10px", fontSize: 12, whiteSpace: "nowrap" }}>{children}</span>;
}

function StateChip({ state }: { state: AiCallState }) {
  const ui = STATE_UI[state];
  return <span title={ui.hint}><Chip tone={ui.tone}>{ui.label}</Chip></span>;
}

/** Перемотка запису до цитати з розбору: є лише тоді, коли запис можна слухати й цитату знайдено в репліках. */
export const QuoteSeek = createContext<((quote: string, go?: boolean) => number | null) | null>(null);

function Quote({ q }: { q: AiQuoted }) {
  const at = useContext(QuoteSeek);
  if (!q.quote.trim()) return null;
  const t = at ? at(q.quote) : null;
  return (
    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
      <q>{q.quote}</q>{" "}
      {t != null && <button type="button" className="hr-linkbtn" title="Послухати це місце" onClick={() => { at?.(q.quote, true); }}
        style={{ border: 0, background: "none", padding: 0, color: "var(--info)", cursor: "pointer", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>▶ {mmss(t)}</button>}{" "}
      {q.quote_found === true && <span style={{ color: "var(--ok-fg, #1d6b3a)", fontSize: 12 }}>✓ звірено з розшифровкою</span>}
      {q.quote_found === false && <span style={{ color: "var(--danger, #b3261e)", fontSize: 12 }}>✗ такої фрази в розмові немає</span>}
    </div>
  );
}

const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", gap: 12, padding: "5px 0", fontSize: 13.5, lineHeight: 1.45 };
const key: React.CSSProperties = { fontSize: 12.5, color: "var(--text-muted)", fontWeight: 600 };

export function Analysis({ c }: { c: AiCallCardResp }) {
  const r = c.result;
  if (!r) {
    const ui = STATE_UI[c.row.state];
    return (
      <div style={{ fontSize: 13.5, color: "var(--text-muted)", paddingTop: 6 }}>
        {ui.hint}
        {c.row.failure && <div style={{ color: "var(--danger, #b3261e)", marginTop: 6 }}>Причина: {c.row.failure}</div>}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={row}><span style={key}>Про що</span><span>{r.summary}</span></div>
      {r.client_request && <div style={row}><span style={key}>Запит клієнта</span><span>{r.client_request}</span></div>}
      {r.next_step && <div style={row}><span style={key}>Наступний крок</span><span>{r.next_step}</span></div>}
      <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0" }} />
      <div style={row}><span style={key}>Ціна</span><span>{r.price.discussed ? "обговорили" : "не прозвучала"}<Quote q={r.price} /></span></div>
      <div style={row}>
        <span style={key}>Заперечення</span>
        {r.objections.length === 0
          ? <span style={{ color: "var(--text-muted)" }}>не було</span>
          : <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>{r.objections.map((o, i) => <span key={i}>{o.what}<Quote q={o} /></span>)}</span>}
      </div>
      <div style={row}>
        <span style={key}>Обіцянки</span>
        {r.promises.length === 0
          ? <span style={{ color: "var(--text-muted)" }}>не було</span>
          : (
            <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {r.promises.map((p, i) => {
                const chk = c.promiseChecks[i] ?? null;
                return (
                  <span key={i}>
                    <b>{p.who === "manager" ? "Менеджер" : "Клієнт"}:</b> {p.what}{" · "}
                    <span style={{ color: "var(--text-muted)" }}>{p.deadline_text.trim() ? `«${p.deadline_text}»` : "часу не названо"}</span>
                    {chk && (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 3 }}>
                        <span title={PROMISE_UI[chk.state].hint}><Chip tone={PROMISE_UI[chk.state].tone}>{PROMISE_UI[chk.state].label}</Chip></span>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>обіцяв до {fmtFull(chk.deadline)} · {deadlineBasisLabel(chk.basis)}{chk.countUntil !== chk.deadline && <> · <b>зараховуємо до {fmtFull(chk.countUntil)}</b> (мінімальний дедлайн і допуск з «Налаштувань»)</>}</span>
                      </span>
                    )}
                    {p.who === "client" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}> · обіцянка клієнта — не рахується</span>}
                    <Quote q={p} />
                  </span>
                );
              })}
            </span>
          )}
      </div>
      {c.promiseChecks.some((x) => x != null) && (
        <div style={row}>
          <span style={key}>Дзвінки на номер після розмови</span>
          {c.callsAfter.length === 0
            ? <span style={{ color: "var(--text-muted)" }}>за 7 днів — жодного</span>
            : <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
                {c.callsAfter.map((x, i) => (
                  <span key={i}>{fmtFull(x.at)} · {x.direction === "in" ? "клієнт нам" : "ми клієнту"}{x.direction === "out" ? ` · ${x.managerName ?? "лінія без менеджера"}${x.byPromiser ? " (той, хто обіцяв)" : " — не рахується: обіцяв інший"}` : ""} · {x.billsec > 0 ? `розмова ${mmss(x.billsec)}` : "без розмови"}</span>
                ))}
              </span>}
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        {c.transcriptHidden ? "Повний текст розмови бачать адмін, КВП, CEO й опдир. Цитати вище — дослівні." : "Оцінки менеджера тут немає — лише витяг із розмови."}
      </div>
    </div>
  );
}


/**
 * 🗂 Тип розмови (ТЗ 30.09.2026): що сказала модель, чи це ручна позначка, і кнопки «Це вантаж» / «Це не вантаж»
 * для тімліда своєї команди й адміна (право вирішує сервер — `canEditType`). Помилку запису видно, а не «нічого».
 */
function TypeBlock({ c, onChanged }: { c: AiCallCardResp; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const r = c.row;
  const set = async (isCargo: boolean) => {
    setBusy(true); setMsg(null);
    try { await setAiCallType(r.uniqueid, isCargo); onChanged(); } catch (e) { setMsg(hiringError(e)); }
    setBusy(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <b>Тип розмови:</b>
        {r.conversationType ? TYPE_LABEL[r.conversationType] : <span style={{ color: "var(--text-muted)" }}>ще не визначено</span>}
        {r.typeConfidence != null && <span style={{ color: "var(--text-muted)", fontSize: 12.5 }}>· упевненість {Math.round(r.typeConfidence * 100)}%</span>}
        {r.typeCheck && <Chip tone="warn">Перевірити тип</Chip>}
        <Chip tone={r.inReport ? "ok" : "muted"}>{r.inReport ? "у звіті" : "у виключених"}</Chip>
      </div>
      {r.typeReason && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{r.typeReason}</div>}
      {c.typeHistory.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {c.typeHistory.map((h, i) => <div key={i}>{fmtFull(h.at)} · {h.byName ?? "невідомо хто"} · {h.isCargo ? "«Це вантаж»" : "«Це не вантаж»"}{i === 0 ? " — діє" : ""}</div>)}
        </div>
      )}
      {c.canEditType && (
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="hr-btn" disabled={busy} onClick={() => void set(true)}>Це вантаж</button>
          <button type="button" className="hr-btn" disabled={busy} onClick={() => void set(false)}>Це не вантаж</button>
        </div>
      )}
      {msg && <div style={{ color: "var(--danger, #b3261e)", fontSize: 13 }}>{msg}</div>}
    </div>
  );
}

/**
 * 📝 Коментарі (ТЗ 30.09.2026): «Чому не озвучено ціну» — коли ціни в розмові не було; «Опрацьовано» — коли менеджер
 * не передзвонив (після нього банер у звіті цю розмову не показує). Хто пише — вирішує сервер (`noteRights`).
 */
function NoteField({ c, kind, title, hint, onSaved }: { c: AiCallCardResp; kind: "price" | "missed" | "offline"; title: string; hint: string; onSaved: () => void }) {
  const cur = kind === "price" ? c.row.priceNote : kind === "missed" ? c.row.missedNote : c.row.offlineNote;
  const can = c.noteRights[kind];
  const [text, setText] = useState(cur?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setText(cur?.text ?? ""); }, [cur?.text]);
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await putAiCallNote(c.row.uniqueid, kind, text); onSaved(); } catch (e) { setMsg(hiringError(e)); }
    setBusy(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13.5 }}>
      <b>{title}</b>
      {cur ? <span>{cur.text} <span style={{ color: "var(--text-muted)", fontSize: 12 }}>· {cur.byName ?? "невідомо хто"}, {fmtFull(cur.at)}</span></span>
        : <span style={{ color: "var(--warn-fg, #8a5a00)", fontSize: 13 }}>{hint}</span>}
      {can && (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <textarea id={`ai-note-${kind}`} className="hr-inp" rows={2} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} maxLength={2000} />
          <button type="button" className="hr-btn p" disabled={busy || text === (cur?.text ?? "")} onClick={() => void save()}>{busy ? "Зберігаю…" : "Зберегти"}</button>
        </div>
      )}
      {msg && <span style={{ color: "var(--danger, #b3261e)", fontSize: 13 }}>{msg}</span>}
    </div>
  );
}

function NotesBlock({ c, onSaved }: { c: AiCallCardResp; onSaved: () => void }) {
  const needPrice = c.result != null && c.result.price.discussed === false;
  const needMissed = c.row.promiseState === "broken";
  // 📞 01.10.2026: Ringostat не бачить мобільного й месенджера — передзвін поза телефонією позначає людина.
  const needOffline = c.row.promiseState === "broken" || c.row.promiseState === "late" || c.row.offlineNote != null;
  if (!needPrice && !needMissed && !needOffline) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
      {needPrice && <NoteField c={c} kind="price" title="Чому не озвучено ціну" hint="Ціни в розмові не було, а причину ще не написали." onSaved={onSaved} />}
      {needOffline && <NoteField c={c} kind="offline" title="Передзвонив поза телефонією (мобільний, месенджер, інший номер)"
        hint="Якщо передзвін був не через Ringostat — напишіть коротко як і коли. Обіцянка тоді рахується виконаною." onSaved={onSaved} />}
      {needMissed && <NoteField c={c} kind="missed" title="Опрацьовано (тімлід)" hint="Дзвінка в телефонії немає. Поки тут порожньо, розмова стоїть у блоці «Немає дзвінка в телефонії» у звіті." onSaved={onSaved} />}
    </div>
  );
}


/**
 * ✅ «Розібрано» з бічної картки (08.10.2026): розмову з черги можна розібрати й тут, не заходячи в режим черги.
 * Кнопка — лише коли сервер каже, що розмова потребує розбору і цей користувач може її розібрати.
 */
function ReviewBar({ c, onDone }: { c: AiCallCardResp; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const rn = c.row.reviewNote;
  if (rn) return <div style={{ fontSize: 12.5, color: "var(--ok, #166534)", marginTop: 6 }}>Розібрано · {rn.byName ?? "—"} · {fmtFull(rn.at)}{rn.text !== "Розібрано" ? ` · «${rn.text}»` : ""}</div>;
  if (!c.needsReview || !c.canReview) return null;
  const go = async () => {
    setBusy(true); setMsg(null);
    try { await putAiCallNote(c.row.uniqueid, "review", "Розібрано"); onDone(); } catch (e) { setMsg(hiringError(e)); }
    setBusy(false);
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
      <button type="button" className="hr-btn" disabled={busy} onClick={() => void go()}>{busy ? "Зберігаю…" : "Розібрано"}</button>
      {c.reviewReason && <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>у черзі розбору: {REVIEW_REASON_UI[c.reviewReason].label.toLowerCase()}</span>}
      {msg && <span style={{ fontSize: 12.5, color: "var(--danger)" }}>{msg}</span>}
    </div>
  );
}

export function AiCallDrawer({ uniqueid, onClose, onChanged }: { uniqueid: string; onClose: () => void; onChanged?: () => void }) {
  const [c, setC] = useState<AiCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seekRef = useRef<SeekFn | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(null);
    if (rev === 0) setC(null);
    fetchAiCallCard(uniqueid)
      .then((x) => { if (alive) setC(x); })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [uniqueid, rev]);
  useEffect(() => { setRev(0); }, [uniqueid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs = c ? drawerTabs(c.transcriptHidden, c.turns?.length ?? null) : [];
  const r = c?.result ?? null;
  // Текст реплік — лише коли сервер його віддав (`drawerTabs`); без нього — тільки плеєр.
  const turns = c && tabs.includes("transcript") ? c.turns : null;
  const listen = c != null && c.canListen && c.durationSec != null;
  // Моно без розділення: уся розмова — одна репліка, тож «місце цитати» = весь текст і час 0:00. Не підсвічуємо й не
  // перемотуємо — це вдавало б точність, якої немає.
  const mixed = c?.mono === "mixed";
  const quoted = useMemo(() => {
    const all = r && !mixed ? [r.price, ...r.objections, ...r.promises] : [];
    return new Set(all.map((q) => quoteTurnIndex(turns, q.quote)).filter((i) => i >= 0));
  }, [r, turns, mixed]);
  const seekQuote = (quote: string, go = false): number | null => {
    const i = quoteTurnIndex(turns, quote); const t = i >= 0 ? turns?.[i]?.start ?? null : null;
    if (go && t != null) seekRef.current?.(t);
    return t;
  };

  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer" role="dialog" aria-label={c ? `Дзвінок ${fmtFull(c.row.calledAt)} — ${c.row.managerName ?? "менеджер невідомий"}` : "Картка дзвінка"}
        onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          {c ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                {fmtFull(c.row.calledAt)} · {c.row.direction === "in" ? "вхідний" : "вихідний"} · {mmss(c.row.billsec)}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{c.row.managerName ?? "Менеджер невідомий"}</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{c.row.teamName ?? "поза командами"}</div>
            </div>
          ) : <div style={{ fontSize: 18, fontWeight: 700 }}>Картка дзвінка</div>}
          <button type="button" className="hr-btn" onClick={onClose}>Закрити</button>
        </div>

        {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
        {!c && !err && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}

        {c && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <StateChip state={c.row.state} />
              {r && (r.price.discussed ? <Chip tone="ok">ціну обговорили</Chip> : <Chip tone="muted">ціна не прозвучала</Chip>)}
              {r && (r.objections.length > 0 ? <Chip tone="bad">заперечень: {r.objections.length}</Chip> : <Chip tone="muted">заперечень немає</Chip>)}
              {r && <Chip tone={c.row.promises > c.row.promisesWithDeadline ? "warn" : "muted"}>{promisesLabel(c.row.promises, c.row.promisesWithDeadline)}</Chip>}
              <Chip tone="wait">{afterLabel(c.row.calledAt, c.nextOutboundAt)}</Chip>
              {c.durationSec != null && <Chip tone="muted">запис {mmss(c.durationSec)}</Chip>}
              {c.dealUrls.map((d) => (
                <a key={d.kommoId} href={d.url} target="_blank" rel="noreferrer"
                  style={{ background: "var(--muted-bg, #f0f1f3)", borderRadius: 999, padding: "3px 10px", fontSize: 12 }}>угода {d.kommoId} в Kommo ↗</a>
              ))}
            </div>

            <TypeBlock c={c} onChanged={() => { setRev((x) => x + 1); onChanged?.(); }} />
            {c.checklist && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase" }}>Чек-лист першого дотику</div>
                  <b style={{ fontVariantNumeric: "tabular-nums" }}>{scoreLabel(c.checkScore)?.replace("/", " / ") ?? "—"}</b>
                </div>
                <ChecklistBlock c={c} checklist={c.checklist} promiseState={c.row.promiseState} conversationType={c.row.conversationType} onSeek={(t) => seekRef.current?.(t)} />
                <ReviewBar c={c} onDone={() => { setRev((x) => x + 1); onChanged?.(); }} />
              </div>
            )}
            <NotesBlock c={c} onSaved={() => { setRev((x) => x + 1); onChanged?.(); }} />
            {listen && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", marginBottom: 8 }}>
                  Розмова{turns ? ` · ${String(turns.length)} реплік` : ""}
                </div>
                {c.mono && (
                  <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--text-muted)" }}>
                    {c.mono === "mixed"
                      ? "Запис моно: обидва голоси в одному каналі й не розділені — текст іде одним шматком, перемотки по репліках немає."
                      : "Запис моно: голоси розділено за звучанням, а не за каналом — підпис «Менеджер / Клієнт» може помилятись."}
                  </p>
                )}
                <CallConversation load={() => fetchAiCallRecording(c.row.uniqueid)} turns={turns} managerChannel={c.managerChannel} quoted={quoted} seekRef={seekRef} mixed={mixed} durationSec={c.durationSec} />
              </div>
            )}

            <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase" }}>Розбір</div>
            <QuoteSeek.Provider value={listen && turns && !mixed ? seekQuote : null}>
              <Analysis c={c} />
            </QuoteSeek.Provider>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
