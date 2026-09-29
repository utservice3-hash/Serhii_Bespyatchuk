import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchAiCallCard, hiringError, type AiCallCardResp, type AiQuoted } from "../../../api";
import { STATE_UI, TONE_COLOR, speakerOf, mmss, afterLabel, drawerTabs, promisesLabel, type AiCallState, type DrawerTab, type Tone } from "../aiCallsView";
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

function Quote({ q }: { q: AiQuoted }) {
  if (!q.quote.trim()) return null;
  return (
    <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
      <q>{q.quote}</q>{" "}
      {q.quote_found === true && <span style={{ color: "var(--ok-fg, #1d6b3a)", fontSize: 12 }}>✓ звірено з розшифровкою</span>}
      {q.quote_found === false && <span style={{ color: "var(--danger, #b3261e)", fontSize: 12 }}>✗ такої фрази в розмові немає</span>}
    </div>
  );
}

const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", gap: 12, padding: "5px 0", fontSize: 13.5, lineHeight: 1.45 };
const key: React.CSSProperties = { fontSize: 12.5, color: "var(--text-muted)", fontWeight: 600 };

function Analysis({ c }: { c: AiCallCardResp }) {
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
              {r.promises.map((p, i) => (
                <span key={i}>
                  <b>{p.who === "manager" ? "Менеджер" : "Клієнт"}:</b> {p.what}{" · "}
                  <span style={{ color: p.deadline_text.trim() ? "var(--ok-fg, #1d6b3a)" : "var(--warn-fg, #8a5a00)" }}>
                    {p.deadline_text.trim() ? `строк: ${p.deadline_text}` : "без строку"}
                  </span>
                  <Quote q={p} />
                </span>
              ))}
            </span>
          )}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        {c.transcriptHidden ? "Повний текст розмови бачать адмін і КВП. Цитати вище — дослівні." : "Оцінки менеджера тут немає — лише витяг із розмови."}
      </div>
    </div>
  );
}

function Transcript({ c }: { c: AiCallCardResp }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {(c.turns ?? []).map((t, i) => {
        const who = speakerOf(t.channel, c.managerChannel);
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "44px 84px minmax(0, 1fr)", gap: 8, fontSize: 13.5, padding: "4px 8px", borderRadius: 6,
            background: who === "Менеджер" ? "var(--ok-bg, #eef6ea)" : "var(--muted-bg, #f6f3ea)" }}>
            <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{mmss(t.start)}</span>
            <b style={{ fontSize: 12.5 }}>{who}</b>
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AiCallDrawer({ uniqueid, onClose }: { uniqueid: string; onClose: () => void }) {
  const [c, setC] = useState<AiCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<DrawerTab>("analysis");

  useEffect(() => {
    let alive = true;
    setC(null); setErr(null); setTab("analysis");
    fetchAiCallCard(uniqueid)
      .then((x) => { if (alive) setC(x); })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [uniqueid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs = c ? drawerTabs(c.transcriptHidden, c.turns?.length ?? null) : [];
  const r = c?.result ?? null;

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

            {tabs.length > 1 && (
              <div className="hr-seg2" role="tablist" aria-label="Розділи картки" style={{ alignSelf: "flex-start" }}>
                <button type="button" role="tab" aria-selected={tab === "analysis"} className={tab === "analysis" ? "on" : ""} onClick={() => setTab("analysis")}>Розбір</button>
                <button type="button" role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}>
                  Розшифровка · {c.turns?.length ?? 0} реплік
                </button>
              </div>
            )}

            {tab === "transcript" && tabs.includes("transcript") ? <Transcript c={c} /> : <Analysis c={c} />}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
