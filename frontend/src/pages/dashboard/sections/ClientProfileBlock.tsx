import { useState } from "react";
import { saveClientProfile, type ClientCard } from "../../../api";
import { useToast } from "../../../components/Toasts";

/**
 * 📋 АНКЕТА КЛІЄНТА — У КАРТЦІ (задача 11221; зустріч по дашборду 25.11.2026).
 * Пʼять питань, які менеджер має один раз зʼясувати в постійного клієнта: чим займається, як часто і скільки возить,
 * яку частку возимо ми, чи є міжнародні, чи є авіа / море. Питання, межу довжини й відповіді віддає сервер
 * (`card.profile`, ядро `core/clientProfile.ts`); тут лише показ і ввід. Анкета зберігається цілою.
 */
const ddmm = (ymd: string) => ymd.slice(5, 10).split("-").reverse().join(".");

export function ClientProfileBlock({ card, onSaved }: { card: ClientCard; onSaved: () => void }) {
  const toast = useToast();
  const p = card.profile;
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!p) return null;

  const startEdit = () => { setDraft({ ...(p.answers ?? {}) }); setErr(null); setEdit(true); };
  /* 🧹 Порожня анкета — ОДИН РЯДОК із кнопкою «Заповнити» (Роман 27.11.2026: «дуже багато інфи, спрости»): пʼять
     порожніх полів займали пів картки в кожного клієнта. Червоне «не заповнена» лишається на видноті. */
  const editing = edit;
  const blank = p.answers == null && !edit;
  const saved = (key: string) => p.answers?.[key] ?? "";
  const anyAnswer = p.fields.some((f) => (draft[f.key] ?? "").trim() !== "");
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await saveClientProfile(card.clientKey, draft);
      toast(`Анкету збережено: відповідей ${r.filled} з ${r.total}.`);
      setEdit(false); onSaved();
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? "Не збережено: сервер відмовив.");
    } finally { setBusy(false); }
  };
  const full = p.filled === p.total;
  const btn = (bg: string, fg = "#fff", border = "none") =>
    ({ fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, border, background: bg, color: fg, cursor: "pointer" } as const);

  return (
    <div style={{ marginTop: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: blank ? 0 : 8 }}>
        <span style={{ fontSize: 11, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280" }}>📋 Анкета клієнта</span>
        <b style={{ fontSize: 12, color: full ? "#15803d" : p.filled === 0 ? "#b91c1c" : "#b45309" }}>
          {p.filled === 0 ? "не заповнена" : `відповідей ${p.filled} з ${p.total}`}
        </b>
        {p.updatedDay && <span style={{ fontSize: 11, color: "#6b7280" }}>· {p.updatedBy ?? "—"}, {ddmm(p.updatedDay)}</span>}
        {blank && <span style={{ fontSize: 11, color: "#6b7280" }}>питань {p.total}, зʼясуйте один раз у розмові з клієнтом</span>}
        {!editing && <button type="button" data-profile-open style={{ ...btn(blank ? "#2563eb" : "#fff", blank ? "#fff" : "#374151", blank ? "none" : "1px solid #d1d5db"), marginLeft: "auto" }} onClick={startEdit}>{blank ? "Заповнити" : "✎ змінити"}</button>}
      </div>
      {/* Питання — картками у дві колонки, підпис над полем: пʼять рядків «підпис ліворуч, поле на всю ширину» займали пів екрана. */}
      {!blank && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "10px 16px", fontSize: 12.5, alignItems: "start" }}>
        {p.fields.map((f) => (
          <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <label htmlFor={`profile-${f.key}`} style={{ fontSize: 11.5, color: "#6b7280", fontWeight: 600 }}>{f.label}</label>
            {editing ? (
              <textarea id={`profile-${f.key}`} value={draft[f.key] ?? ""} disabled={busy} maxLength={p.max} rows={2}
                placeholder={f.hint}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                style={{ fontSize: 12.5, padding: "6px 9px", border: "1px solid #d1d5db", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
            ) : saved(f.key).trim() !== ""
              ? <span style={{ whiteSpace: "pre-wrap", color: "#111827" }}>{saved(f.key)}</span>
              : <span style={{ color: "#b45309" }}>немає відповіді</span>}
          </div>
        ))}
      </div>}
      {editing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy || !anyAnswer} style={{ ...btn("#2563eb"), ...(anyAnswer ? {} : { opacity: 0.45, cursor: "not-allowed" }) }} onClick={() => void save()}>
            Зберегти анкету
          </button>
          <button type="button" disabled={busy} style={btn("#fff", "#374151", "1px solid #d1d5db")} onClick={() => { setEdit(false); setErr(null); }}>Скасувати</button>
          <span style={{ fontSize: 11, color: "#6b7280" }}>Зʼясуйте один раз у розмові з клієнтом. Можна зберегти частину й дописати пізніше.</span>
        </div>
      )}
      {err && <div role="alert" style={{ fontSize: 12, color: "#b91c1c", marginTop: 6 }}>⚠️ {err}</div>}
    </div>
  );
}
