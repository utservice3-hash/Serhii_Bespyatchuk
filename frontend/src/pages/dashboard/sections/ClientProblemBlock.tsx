import { useState } from "react";
import { setClientProblem, clearClientProblem, type ClientCard } from "../../../api";
import { useToast } from "../../../components/Toasts";

/**
 * ⚠️ «ПРОБЛЕМНИЙ КЛІЄНТ» — У КАРТЦІ (задача 8350; макет погоджено, Роман 11.11.2026 «викочуй»).
 * Причина зі словника + обовʼязковий коментар → клієнт лишається на екрані групою «⚠️ Проблемні», але не рахується в
 * «Немає роботи», «Без задачі», сплячих і реактивації. Позначка перестає діяти сама, щойно клієнт знову замовить.
 * Право й стан — із сервера (`canProblem`, `problem`, `problemReasons`); тут лише ввід і показ.
 */
const ddmm = (ymd: string) => ymd.slice(5, 10).split("-").reverse().join(".");

export function ClientProblemBlock({ card, onSaved }: { card: ClientCard; onSaved: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!card.canProblem) return null;
  const min = card.problemNoteMin ?? 5;
  const errOf = (e: unknown) => (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? "Не збережено: сервер відмовив.";
  const btn = (bg: string, fg = "#fff", border = "none") =>
    ({ fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, border, background: bg, color: fg, cursor: "pointer" } as const);
  const chip = { display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "#b45309", color: "#fff", whiteSpace: "nowrap" } as const;

  const mark = async () => {
    setBusy(true); setErr(null);
    try { await setClientProblem(card.clientKey, reason, note.trim()); toast("Клієнта позначено проблемним — він окремою групою, у цифри менеджера не йде."); setReason(""); setNote(""); onSaved(); }
    catch (e) { setErr(errOf(e)); }
    finally { setBusy(false); }
  };
  const unmark = async () => {
    setBusy(true); setErr(null);
    try { await clearClientProblem(card.clientKey); toast("Позначку «Проблемний» знято."); onSaved(); }
    catch (e) { setErr(errOf(e)); }
    finally { setBusy(false); }
  };

  const p = card.problem;
  if (p) {
    return (
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ border: "1px solid #fed7aa", borderLeft: "4px solid #b45309", background: "#fff7ed", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={chip}>⚠️ Проблемний</span><b style={{ fontSize: 12 }}>{p.label}</b>
          <span style={{ fontSize: 12 }}>«{p.note}»</span>
          <span style={{ fontSize: 11, color: "#6b7280" }}>· {p.byName ?? "—"}, {ddmm(p.day)}</span>
          <button type="button" disabled={busy} style={{ ...btn("#fff", "#374151", "1px solid #d1d5db"), marginLeft: "auto" }} onClick={() => void unmark()}>↩ зняти позначку</button>
        </div>
        <span style={{ fontSize: 11, color: "#6b7280" }}>Не рахується в «Немає роботи», «Без задачі», сплячих і реактивації. Знімається сама, якщо клієнт знову замовить.</span>
        {err && <div role="alert" style={{ fontSize: 12, color: "#b91c1c" }}>⚠️ {err}</div>}
      </div>
    );
  }
  const ok = reason !== "" && note.trim().length >= min;
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
          style={{ fontSize: 12, padding: "5px 9px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff" }}>
          <option value="">причина проблеми…</option>
          {(card.problemReasons ?? []).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={1000}
          placeholder="що сталось і чому з клієнтом не працюємо (обовʼязково)…"
          style={{ fontSize: 12, padding: "5px 9px", border: "1px solid #d1d5db", borderRadius: 8, minWidth: 280, flex: "1 1 280px" }} />
        <button type="button" disabled={busy || !ok} style={{ ...btn("#b45309"), ...(ok ? {} : { opacity: 0.45, cursor: "not-allowed" }) }} onClick={() => void mark()}>
          ⚠️ проблемний клієнт
        </button>
      </div>
      <span style={{ fontSize: 11, color: "#6b7280" }}>
        З ним неможливо працювати: лишається на екрані окремою групою, але не рахується в «Немає роботи», «Без задачі», сплячих і реактивації. Стане звичайним сам, якщо знову замовить.
      </span>
      {err && <div role="alert" style={{ fontSize: 12, color: "#b91c1c" }}>⚠️ {err}</div>}
    </div>
  );
}
