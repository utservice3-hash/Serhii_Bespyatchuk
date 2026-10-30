import { useEffect, useState } from "react";
import { fetchAdBalance, saveAdBalance, type AdBalance } from "../../../api";
import { failureReason } from "../../../actionFeedback";

/**
 * 💳 БАЛАНС РЕКЛАМНОГО КАБІНЕТУ (30.10.2026) — маленька цифра біля заголовка «Реклама», лише адмін-рівень:
 * кому сервер віддав 403, той її не бачить узагалі. Клік — подробиці й звірка з кабінетом.
 * Чому рахуємо, а не беремо з Google, і формула — `backend/src/core/adBalance.ts`.
 */
const uah = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} грн`;
const dmy = (iso: string) => iso.slice(8, 10) + "." + iso.slice(5, 7);

export function AdBalanceChip() {
  const [b, setB] = useState<AdBalance | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchAdBalance()
      .then((r) => { setB(r.balance); setSynced(r.syncedAt); })
      .catch(() => setB(null));
  }, []);

  if (!b) return null;

  async function save() {
    const n = Number(value.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { setErr("Вкажіть число з кабінету, наприклад 29205,81"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await saveAdBalance(n);
      setB(r.balance); setSynced(r.syncedAt); setValue(""); setOpen(false);
    } catch (e) { setErr(failureReason(e, "Не зберіглось")); }
    finally { setBusy(false); }
  }

  const tone = b.low ? "var(--danger)" : "var(--ok)";
  const days = b.daysLeft == null ? null : `≈ ${b.daysLeft.toLocaleString("uk-UA")} дн.`;
  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title="Баланс кабінету Google Ads (з ПДВ, як у кабінеті). Клік — подробиці й звірка"
        style={{ border: `1px solid ${b.low ? "var(--danger)" : "var(--border-strong)"}`, background: "var(--card-bg)", color: "var(--text)",
          borderRadius: 999, padding: "3px 10px", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
        💳 {uah(b.balance)}
        {days && <span style={{ color: tone, marginLeft: 6 }}>{b.low ? "⚠ " : ""}{days}</span>}
      </button>
      {open && (
        <div role="dialog" className="chart-card"
          style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, width: 320, maxWidth: "calc(100vw - 32px)",
            fontSize: 13, display: "grid", gap: 6, boxShadow: "0 6px 24px rgba(0,0,0,.15)" }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>Баланс кабінету Google Ads · лише адміни</div>
          <div><b>{uah(b.balance)}</b> з ПДВ · без ПДВ {uah(b.balanceNet)}</div>
          <div>
            Вистачить на: <b style={{ color: tone }}>{days ?? "—"}</b>
            {b.avgDaily != null && <span style={{ color: "var(--text-muted)" }}> ({uah(b.avgDaily)}/день за 7 днів)</span>}
          </div>
          <div>Останнє поповнення: {b.lastPayment ? <b>{dmy(b.lastPayment.day)} · {uah(b.lastPayment.amount)}</b> : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Поповнення з «Виписки» мінус витрати Google Ads (GA4) ×1,2
            {synced ? `, станом на ${new Date(synced).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}.
            Звірено з кабінетом: {dmy(b.anchor.asOf)}.
          </div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12 }}>Звірити: «Доступні кошти» з Google Ads → Платежі</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="29205,81" inputMode="decimal"
              style={{ width: 110, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--card-bg)", color: "var(--text)", fontFamily: "inherit" }} />
            <button type="button" disabled={busy || !value.trim()} onClick={save}
              style={{ border: 0, background: "var(--brand)", color: "#fff", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>
              {busy ? "…" : "Зберегти"}
            </button>
          </div>
          {err && <div role="alert" style={{ color: "var(--danger)" }}>{err}</div>}
        </div>
      )}
    </span>
  );
}
