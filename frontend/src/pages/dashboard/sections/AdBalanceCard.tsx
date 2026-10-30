import { useEffect, useState } from "react";
import { fetchAdBalance, saveAdBalance, type AdBalance } from "../../../api";
import { failureReason } from "../../../actionFeedback";

/**
 * 💳 БАЛАНС РЕКЛАМНОГО КАБІНЕТУ (30.10.2026) — лише адмін-рівень: кому сервер віддав 403, картку не бачить узагалі.
 * Чому рахуємо, а не беремо з Google, і формула — `backend/src/core/adBalance.ts`.
 */
const uah = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} грн`;
const dmy = (iso: string) => iso.slice(8, 10) + "." + iso.slice(5, 7);

export function AdBalanceCard() {
  const [b, setB] = useState<AdBalance | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchAdBalance()
      .then((r) => { setB(r.balance); setSynced(r.syncedAt); setHidden(!r.balance); })
      .catch(() => setHidden(true));
  }, []);

  if (hidden || !b) return null;

  async function save() {
    const n = Number(value.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { setErr("Вкажіть число з кабінету, наприклад 29205,81"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await saveAdBalance(n);
      setB(r.balance); setSynced(r.syncedAt); setEdit(false); setValue("");
    } catch (e) { setErr(failureReason(e, "Не зберіглось")); }
    finally { setBusy(false); }
  }

  const tone = b.low ? "var(--danger)" : "var(--ok)";
  return (
    <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${tone}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
            💳 Баланс кабінету Google Ads · лише адміни
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 4, color: b.balance <= 0 ? "var(--danger)" : "var(--text)" }}>
            {uah(b.balance)}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>з ПДВ, як у кабінеті · без ПДВ {uah(b.balanceNet)}</div>
        </div>
        <div style={{ display: "grid", gap: 4, fontSize: 13, minWidth: 220 }}>
          <div>
            Вистачить на:{" "}
            <b style={{ color: tone }}>{b.daysLeft == null ? "—" : `≈ ${b.daysLeft.toLocaleString("uk-UA")} дн.`}</b>
            {b.avgDaily != null && <span style={{ color: "var(--text-muted)" }}> (≈ {uah(b.avgDaily)}/день за 7 днів)</span>}
          </div>
          <div>Останнє поповнення: {b.lastPayment ? <b>{dmy(b.lastPayment.day)} · {uah(b.lastPayment.amount)}</b> : "—"}</div>
          {b.low && <div style={{ color: "var(--danger)", fontWeight: 700 }}>⚠ Кошти закінчуються — треба поповнити</div>}
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span>
          Розрахунок: поповнення з «Виписки» мінус витрати Google Ads (GA4)
          {synced ? `, станом на ${new Date(synced).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}.
          Точка звірки: {dmy(b.anchor.asOf)}.
        </span>
        {!edit && (
          <button type="button" onClick={() => setEdit(true)}
            style={{ border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 }}>
            Звірити з кабінетом
          </button>
        )}
      </div>
      {edit && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
          <span>«Доступні кошти» з Google Ads → Платежі → Підсумок:</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="29205,81" inputMode="decimal"
            style={{ width: 140, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)", fontFamily: "inherit" }} />
          <button type="button" disabled={busy} onClick={save}
            style={{ border: 0, background: "var(--brand)", color: "#fff", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
            {busy ? "Збереження…" : "Зберегти"}
          </button>
          <button type="button" onClick={() => { setEdit(false); setErr(null); }}
            style={{ border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}>
            Скасувати
          </button>
          {err && <span role="alert" style={{ color: "var(--danger)" }}>{err}</span>}
        </div>
      )}
    </div>
  );
}
