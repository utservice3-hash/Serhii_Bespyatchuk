import { useEffect, useState } from "react";
import { fetchCallsNorm, saveCallsNorm, type CallsNormResp } from "../../../api";
import { useToast } from "../../../components/Toasts";

/**
 * 📞 НОРМА ДЗВІНКІВ НА ДЕНЬ У «ПЛАНАХ» (ТЗ 4632 п.2.5; Юля 10.10.2026: розмови + спроби, одна на всіх — 45;
 * Роман 10.10.2026: «в Планах», «КВП сама ставить», «до наступної зміни»).
 * Ставить КВП (і адмін) — право віддає сервер (`canEdit`). Нова норма діє з обраного місяця; минулі місяці лишаються
 * зі своєю, тож поставити заднім числом не можна. Історія видна повністю.
 */
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export function CallsNormCard() {
  const toast = useToast();
  const [d, setD] = useState<CallsNormResp | null>(null);
  const [norm, setNorm] = useState("");
  const [fromMonth, setFromMonth] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHist, setShowHist] = useState(false);
  const load = () => fetchCallsNorm().then((x) => { setD(x); setFromMonth(x.month.slice(0, 7)); }).catch(() => setD(null));
  useEffect(() => { void load(); }, []);
  if (!d) return null;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await saveCallsNorm({ norm: Number(norm), fromMonth });
      toast(`Норму дзвінків збережено: ${norm} на день з ${monthLabel(`${fromMonth}-01`)}`, { tone: "ok" });
      setNorm(""); await load();
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалось зберегти");
    }
    setBusy(false);
  };
  const months = [0, 1, 2].map((i) => { const x = new Date(`${d.month}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + i); return x.toISOString().slice(0, 7); });
  const inp = { padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 13 } as const;
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <b style={{ fontSize: 14 }}>📞 Норма дзвінків на день</b>
        <span style={{ fontSize: 13 }}>
          зараз: <b>{d.current ?? "не задано"}</b>{d.current != null && " на менеджера (розмови + спроби)"}
        </span>
        {d.history.length > 0 && (
          <button type="button" onClick={() => setShowHist((v) => !v)}
            style={{ border: 0, background: "none", color: "var(--info, #1d4ed8)", cursor: "pointer", fontSize: 12.5, textDecoration: "underline" }}>
            історія ({d.history.length})
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
        Одна на всіх менеджерів; діє з обраного місяця й до наступної зміни. Видно на Статистиках і у Звіті («Днів з нормою»).
      </div>
      {d.canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <input type="number" min={1} max={500} placeholder="напр. 45" value={norm} onChange={(e) => setNorm(e.target.value)} style={{ ...inp, width: 110 }}
            aria-label="Норма дзвінків на день" />
          <label style={{ fontSize: 12.5, color: "var(--text-muted)" }}>діє з{" "}
            <select value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} style={inp}>
              {months.map((m) => <option key={m} value={m}>{monthLabel(`${m}-01`)}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !norm.trim()} onClick={() => void save()}
            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "#1f2330", color: "#fff", fontWeight: 700, cursor: busy ? "default" : "pointer" }}>
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
          {err && <span style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>{err}</span>}
        </div>
      )}
      {showHist && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
          {d.history.map((h, i) => (
            <li key={i}>з {monthLabel(h.fromMonth)} — <b>{h.norm}</b> · {h.setBy ?? "невідомо хто"}, {new Date(h.setAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
