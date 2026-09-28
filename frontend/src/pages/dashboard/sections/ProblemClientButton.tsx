import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchReceivableClaims, createReceivableClaim, hiringError, type ReceivableClaimsState } from "../../../api";

/**
 * 🗂 КНОПКА «ПРОБЛЕМНИЙ КЛІЄНТ» (ТЗ задачі 4314, 28.09.2026) у колонці «Дії» дебіторки.
 * Хто натискає — вирішує СЕРВЕР (`/receivables-claims/open` → `canCreate`, право `create_claim`:
 * керівництво і фінансист). Бухгалтерія, тімлід і менеджер кнопки не бачать; сервер однаково
 * відповість 403, тож тут лише косметика.
 * Відкрита претензія вже є — замість кнопки «претензія ·» з переходом у розділ (для тих, хто його бачить).
 */
export function useReceivableClaims() {
  const [state, setState] = useState<ReceivableClaimsState | null>(null);
  // Помилка → кнопки немає: дебіторка працює й без неї, а зламаний стан не має ламати екран.
  useEffect(() => { fetchReceivableClaims().then(setState).catch(() => setState(null)); }, []);
  const opened = (clientKey: string, claimId: number) =>
    setState((s) => (s ? { ...s, open: [...s.open.filter((o) => o.clientKey !== clientKey), { clientKey, claimId }] } : s));
  return { state, opened };
}

const linkStyle = {
  background: "none", border: "none", cursor: "pointer", font: "inherit", fontSize: "var(--fs-xs)",
  minHeight: 32, padding: "8px 6px", display: "inline-flex", alignItems: "center",
} as const;

export function ProblemClientButton({ clientKey, clientName, state, onOpened }: {
  clientKey: string; clientName: string; state: ReceivableClaimsState | null;
  onOpened: (clientKey: string, claimId: number) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!state) return null;
  const open = state.open.find((o) => o.clientKey === clientKey);
  if (open) {
    return state.canOpen
      ? <button style={{ ...linkStyle, color: "var(--danger)", textDecoration: "underline dotted" }}
          aria-label={`Відкрити претензію: ${clientName}`}
          onClick={() => navigate(`/ba?claim=${open.claimId}`)}>претензія · відкрити</button>
      : <span style={{ ...linkStyle, cursor: "default", color: "var(--danger)" }}>претензія є</span>;
  }
  if (!state.canCreate) return null;
  const create = async () => {
    if (!window.confirm(`Створити претензію «Проблемний клієнт» для «${clientName}»?\nСума боргу й дні прострочення візьмуться з дебіторки на цю мить.`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await createReceivableClaim(clientKey);
      onOpened(clientKey, r.id);
    } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <button style={{ ...linkStyle, color: "var(--danger)", fontWeight: 600 }} disabled={busy}
        aria-label={`Проблемний клієнт: ${clientName}`} title="Створити претензію в розділі «Бізнес-асистент»"
        onClick={() => void create()}>⚠ проблемний</button>
      {err && <span role="alert" style={{ color: "var(--danger)", fontSize: "var(--fs-xs)", whiteSpace: "normal" }}>{err}</span>}
    </>
  );
}
