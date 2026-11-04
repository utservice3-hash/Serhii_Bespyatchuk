import { useCallback, useEffect, useState } from "react";
import { createLeadsBotLink, fetchLeadsBotMe } from "../api";

/**
 * 🤖 «Підключіть бот заявок» — менеджеру з черги LinkedIn, у якого бот «UTS Заявки» ще не підключений (задача 7361).
 * Без бота черга йому нічого не дає (Роман 04.11.2026), тож плашка стоїть угорі будь-якого екрана, доки не підключить.
 * Окремої сторінки профілю в дашборді немає — тому тут, а не в налаштуваннях.
 */
export function LeadsBotBanner() {
  const [show, setShow] = useState(false);
  const [link, setLink] = useState<{ url: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try { const me = await fetchLeadsBotMe(); setShow(me.configured && me.inQueue && !me.linked); return me.linked; }
    catch { return false; }
  }, []);
  useEffect(() => { void check(); }, [check]);
  // Після «Підключити» людина йде в Telegram — перевіряємо кожні 5 с, поки код живий (10 хв).
  useEffect(() => {
    if (!link) return;
    const started = Date.now();
    const t = setInterval(() => { void check().then((ok) => { if (ok || Date.now() - started > 10 * 60_000) clearInterval(t); }); }, 5000);
    return () => clearInterval(t);
  }, [link, check]);

  if (!show) return null;
  const connect = async () => {
    setError(null);
    try { const r = await createLeadsBotLink(); setLink(r); window.open(r.url, "_blank", "noopener"); }
    catch (e) { setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося створити код"); }
  };
  return (
    <div className="chart-card" style={{ borderLeft: "4px solid #b45309", margin: "0 0 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ fontSize: 13.5 }}>
        <b>🔗 Підключіть бот заявок LinkedIn.</b> Ви в черзі LinkedIn, але без бота заявки вам не надходитимуть.
        {link && <div style={{ marginTop: 4, color: "var(--text-muted)" }}>Відкрився Telegram — натисніть «Start». Або надішліть боту код <b style={{ color: "var(--text)", letterSpacing: 1 }}>{link.code}</b> (діє 10 хв).</div>}
        {error && <div style={{ marginTop: 4, color: "#b3261e" }}>{error}</div>}
      </div>
      <button type="button" className="hr-btn" onClick={() => void connect()} style={{ background: "#1f2330", color: "#fff", borderColor: "#1f2330" }}>
        {link ? "Новий код" : "Підключити"}
      </button>
    </div>
  );
}
