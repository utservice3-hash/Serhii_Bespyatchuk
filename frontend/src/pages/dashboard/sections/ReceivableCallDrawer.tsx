import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchReceivableCallRecording, fetchReceivableDateLog, hiringError,
  type ReceivableClient, type ReceivableDateLogEntry,
} from "../../../api";
import { CallConversation, type SeekFn } from "./CallConversation";
import { CALL_STATE_UI, agreementView, callWhen, formatDateSafe, rescheduleLabel, talkLength } from "../receivablesView";
import { formatAmountFull } from "../format";
import "./hiring.css";

/**
 * 📞 КАРТКА РОЗМОВИ БІЛЯ ДАТИ ДОМОВЛЕНОСТІ (4631, Роман 09.10.2026: «щоб так само відкривалося, як в AI-аналізі»).
 * Та сама бічна панель (`hr-overlay`/`hr-drawer`) і той самий плеєр (`CallConversation`), що в картці першого дотику.
 *
 * Прохід 1 — плеєр і журнал перенесень. Тексту розмови й розбору тут ще немає: вони приїдуть другим проходом у ЦЮ Ж
 * картку, тому місце під них підписане, а не порожнє.
 *
 * Слухати — ролі першого дотику (`canListen` віддає сервер тим виразом, що гейтить `/receivables/call-recording`).
 * Журнал бачить кожен, хто бачить клієнта.
 */
const kyivDay = (iso: string | null) => (iso ? formatDateSafe(iso, "").slice(0, 5) : "—");

export function ReceivableCallDrawer({ client, view, canListen, canEdit, onEdit, onClose }: {
  client: ReceivableClient;
  view: "call" | "history";
  canListen: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const cl = client.callLink ?? { state: "none" as const, uniqueid: null, call: null };
  const ui = CALL_STATE_UI[cl.state];
  const [log, setLog] = useState<ReceivableDateLogEntry[] | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  // Який дзвінок у плеєрі: поточний, або той, по якому клікнули в журналі.
  const [playing, setPlaying] = useState<{ uniqueid: string; billsec: number } | null>(
    cl.uniqueid && cl.call ? { uniqueid: cl.uniqueid, billsec: cl.call.billsec } : null);
  const seekRef = useRef<SeekFn | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetchReceivableDateLog(client.clientKey)
      .then((x) => { if (alive) setLog(x); })
      .catch((e) => { if (alive) setLogErr(hiringError(e)); });
    return () => { alive = false; };
  }, [client.clientKey]);

  useEffect(() => {
    if (view === "history" && log) historyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [view, log]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const agree = agreementView({ dueDate: client.dueDate ?? null, note: "", comment: client.comment, noteUpdatedAt: client.noteUpdatedAt ?? null,
    noteActual: client.noteActual, crmDue: client.facts?.crmDueNearest ?? null, now: new Date() });
  const resched = rescheduleLabel(client.rescheduleCount);
  const call = cl.call;
  const box: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" };
  const head: React.CSSProperties = { fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", marginBottom: 8 };
  const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "130px minmax(0, 1fr)", gap: 12, padding: "4px 0", fontSize: 13.5, lineHeight: 1.45 };
  const key: React.CSSProperties = { fontSize: 12.5, color: "var(--text-muted)", fontWeight: 600 };

  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer" role="dialog" aria-label={`Розмова про борг: ${client.clientName}`}
        onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {call && (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{callWhen(call.calledAt, true)} · {talkLength(call.billsec)}</div>
            )}
            <div style={{ fontSize: 18, fontWeight: 700 }}>{client.clientName} · розмова про борг</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{call?.managerName ?? "дзвінка не прикріплено"}</div>
          </div>
          <button type="button" className="hr-btn" onClick={onClose}>Закрити</button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {ui && <span className={`recv-call-pill ${ui.tone}`} title={ui.hint}>{ui.label}</span>}
          {resched && <span className="recv-call-pill muted">{resched}</span>}
          {canEdit && (
            <button type="button" className="hr-btn" onClick={onEdit} style={{ marginLeft: "auto" }}>Змінити дату / розмову</button>
          )}
        </div>
        {ui && cl.state !== "ok" && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: -6 }}>{ui.hint}</div>}

        <div style={box}>
          <div style={head}>Домовленість по боргу</div>
          <div style={row}><span style={key}>Борг зараз</span><span>{formatAmountFull(client.amount)}{client.overdueDays != null ? ` · найстаріший рахунок ${client.overdueDays} дн.` : ""}</span></div>
          <div style={row}><span style={key}>Дата оплати</span>
            <span><b>{agree.dateText || "—"}</b>{agree.source === "crm" ? " · з CRM, у дашборді не ставили" : agree.source === "dashboard" ? " · поставлено в дашборді" : ""}</span></div>
          {client.noteActual !== false && client.comment?.trim() && (
            <div style={row}><span style={key}>Коментар</span><span>{client.comment.trim()}</span></div>
          )}
        </div>

        <div style={box}>
          <div style={head}>Розмова</div>
          {!playing ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
              {cl.state === "pending" ? "Посилання збережено, але дзвінка ще немає в нашій базі — синк Ringostat іде із запізненням."
                : "До дати не прикріплено розмови."}
            </p>
          ) : !canListen ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Слухати записи розмов ваша роль не може.</p>
          ) : (
            <CallConversation key={playing.uniqueid} load={() => fetchReceivableCallRecording(client.clientKey, playing.uniqueid)}
              turns={null} managerChannel={null} quoted={new Set()} seekRef={seekRef} durationSec={playing.billsec || null} />
          )}
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Текст розмови й розбір у цій картці ще не підключені.</p>
        </div>

        <div ref={historyRef} style={box}>
          <div style={head}>Історія дати</div>
          {logErr && <p style={{ margin: 0, color: "var(--danger)" }}>{logErr}</p>}
          {!log && !logErr && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
          {log && log.length === 0 && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Змін ще не було. Журнал веде кожну зміну дати й розмови з 09.10.2026.</p>
          )}
          {log && log.length > 0 && (
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
              {log.map((e, i) => (
                <li key={i}>
                  <span style={{ color: "var(--text-muted)" }}>{callWhen(e.at, true)} · {e.author ?? "невідомо хто"}: </span>
                  {e.newDate == null ? "дату знято"
                    : e.oldDate == null ? <>дата <b>{kyivDay(e.newDate)}</b></>
                    : e.reschedule ? <>перенесли {kyivDay(e.oldDate)} → <b>{kyivDay(e.newDate)}</b></>
                    : <>дата <b>{kyivDay(e.newDate)}</b> · змінили розмову</>}
                  {" · "}
                  {e.call ? (
                    <>
                      📞 {callWhen(e.call.calledAt)} · {talkLength(e.call.billsec)}
                      {!e.call.sameClient && <span className="recv-call-pill bad" style={{ marginLeft: 4 }}>інший номер</span>}
                      {canListen && e.callUniqueid && (
                        <button type="button" className="recv-call-link" style={{ marginLeft: 6 }}
                          onClick={() => setPlaying({ uniqueid: e.callUniqueid!, billsec: e.call!.billsec })}>▶ слухати</button>
                      )}
                    </>
                  ) : e.callUniqueid ? <span style={{ color: "var(--text-muted)" }}>дзвінок ще не підтягнувся</span>
                    : <span className="recv-call-pill warn">без розмови</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
