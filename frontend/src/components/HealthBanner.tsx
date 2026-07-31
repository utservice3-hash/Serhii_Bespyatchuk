import { useEffect, useState } from "react";
import { fetchHealthAlerts, type HealthAlert } from "../api";

/**
 * 🚨 БАНЕР ТРИВОГ. З'являється ТІЛЬКИ на проблемі.
 *
 * «Все добре» зеленою плашкою НЕ показуємо навмисно: постійний індикатор перестають
 * помічати рівно тоді, коли він змінює колір. Немає тривог — немає банера.
 *
 * Тривога зникає САМА, щойно зникла причина: стан не кешується у стейті між
 * опитуваннями, кожні 2 хв малюємо те, що зараз віддав бекенд.
 *
 * 🔴 Якщо сам запит впав — це теж ТРИВОГА, а не тиша. «Не знаю» ≠ «добре»: мовчазний
 * банер при мертвому бекенді був би найгіршим варіантом із можливих.
 */
const POLL_MS = 2 * 60 * 1000;

const C = {
  critical: { bg: "#fef3f2", border: "#fda29b", dot: "#d92d20", label: "АВАРІЯ" },
  warning: { bg: "#fffaeb", border: "#fec84b", dot: "#dc6803", label: "УВАГА" },
} as const;

function since(iso: string | null): string {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} год ${min % 60} хв` : `${Math.floor(h / 24)} дн`;
}

export function HealthBanner() {
  const [alerts, setAlerts] = useState<HealthAlert[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetchHealthAlerts();
        if (alive) setAlerts(r.alerts ?? []);
      } catch (e) {
        // Недоступність самої сигналізації — окрема тривога, не привід замовкнути.
        if (alive) setAlerts([{
          id: "check_failed:fetch", severity: "critical",
          title: "Сигналізація недоступна",
          detail: `Не вдалось отримати стан: ${e instanceof Error ? e.message : String(e)}`,
          action: "Перевірити, чи живий бекенд. Поки це так, поломок не буде видно.",
          since: null,
        }]);
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!alerts.length) return null; // ← «все добре» = порожньо, без плашки

  const worst: keyof typeof C = alerts.some((a) => a.severity === "critical") ? "critical" : "warning";
  const c = C[worst];
  const head = alerts.length === 1
    ? alerts[0].title
    : `${alerts.length} проблем: ${alerts[0].title}`;

  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10,
      padding: "10px 14px", marginBottom: 14, fontSize: 13.5, color: "#1d2939",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
           onClick={() => setOpen((v) => !v)}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: c.dot, flexShrink: 0 }} />
        <b style={{ color: c.dot }}>{c.label}</b>
        <span style={{ flex: 1 }}>{head}</span>
        <span style={{ color: "#667085", fontSize: 12 }}>{open ? "згорнути ▲" : "деталі ▼"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          {alerts.map((a) => (
            <div key={a.id} style={{
              borderLeft: `3px solid ${C[a.severity].dot}`, paddingLeft: 10, lineHeight: 1.45,
            }}>
              <div style={{ fontWeight: 600 }}>
                {a.title}
                {a.since && <span style={{ color: "#667085", fontWeight: 400 }}> · триває {since(a.since)}</span>}
              </div>
              <div style={{ color: "#475467" }}>{a.detail}</div>
              <div style={{ color: "#175cd3", marginTop: 2 }}>→ {a.action}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
