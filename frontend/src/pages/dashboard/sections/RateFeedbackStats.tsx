import { useEffect, useState } from "react";
import { fetchRateFeedbackStats, type RateFeedbackStats as Stats, type RateFeedbackRating, type RateFeedbackBucket } from "../../../api";

/**
 * 🧮 Зведення відгуків «наскільки допоміг розрахунок» (Роман 27.10.2026). Бачать адмін, СЕО, ОД, КВП — межу тримає
 * сервер (право `view_rate_feedback`); без права (403) блок просто не показується, і перелогін не потрібен.
 */
const ACC = "#c8102e";
const LABEL: Record<RateFeedbackRating, string> = { ok: "Точно", high: "Завищено", low: "Занижено", no: "Не допоміг" };
const ZONE: Record<string, string> = { green: "зелена", yellow: "жовта", red: "червона" };
const PERIODS: [number, string][] = [[7, "Тиждень"], [30, "Місяць"], [90, "3 місяці"]];
const pct = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);

function Buckets({ title, rows, label }: { title: string; rows: RateFeedbackBucket[]; label?: (k: string) => string }) {
  return (
    <div className="chart-card" style={{ flex: "1 1 320px", minWidth: 0 }}>
      <h2 className="chart-title">{title}</h2>
      <table className="data-table">
        <thead><tr><th>{title.includes("зон") ? "Зона" : "Авто"}</th><th style={{ textAlign: "right" }}>Відгуків</th><th style={{ textAlign: "right" }}>«Точно»</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((b) => (
            <tr key={b.key}><td>{label ? label(b.key) : b.key}</td><td style={{ textAlign: "right" }}>{b.n}</td>
              <td style={{ textAlign: "right", fontWeight: 600 }}>{pct(Math.round((b.ok / b.n) * 1000) / 10)}</td></tr>
          )) : <tr><td colSpan={3} style={{ color: "var(--text-muted)" }}>ще немає відгуків</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function RateFeedbackStats() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Stats | null>(null);
  const [state, setState] = useState<"load" | "ok" | "denied" | "error">("load");
  useEffect(() => {
    setState("load");
    fetchRateFeedbackStats(days).then((x) => { setD(x); setState("ok"); })
      .catch((e: { response?: { status?: number } }) => setState(e.response?.status === 403 ? "denied" : "error"));
  }, [days]);
  if (state === "denied") return null;
  if (state === "error") return <div className="chart-card" style={{ marginBottom: 16 }}>Відгуки зараз недоступні — спробуйте пізніше.</div>;
  if (!d) return <p className="loading-text">Завантаження відгуків…</p>;
  const dev = d.deviation;
  return (
    <section aria-label="Відгуки на розрахунок" style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <h2 className="chart-title" style={{ margin: 0 }}>Відгуки: наскільки допоміг розрахунок</h2>
        <span style={{ flex: 1 }} />
        {PERIODS.map(([n, l]) => (
          <button key={n} type="button" onClick={() => setDays(n)} aria-pressed={days === n}
            style={{ minHeight: 36, padding: "0 12px", borderRadius: 999, fontSize: 13, cursor: "pointer", color: "var(--text)",
              border: days === n ? `1px solid ${ACC}` : "1px solid var(--border)", background: days === n ? "rgba(200,16,46,0.08)" : "var(--card-bg)" }}>{l}</button>
        ))}
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-value" style={{ color: ACC }}>{pct(d.okShare)}</span><span className="kpi-label">«Точно, взяв цю ставку»</span></div>
        <div className="kpi-card"><span className="kpi-value">{d.total}</span><span className="kpi-label">відгуків · {pct(d.coverage)} від {d.calculations} розрахунків</span></div>
        <div className="kpi-card">
          <span className="kpi-value">{dev ? `${dev.avg > 0 ? "+" : ""}${pct(dev.avg)}` : "—"}</span>
          <span className="kpi-label">{dev ? `погоджена ставка проти розрахованої · ${dev.n} з сумою` : "ще ніхто не вписав погоджену ставку"}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-value" style={{ fontSize: 15, lineHeight: 1.5 }}>
            {(Object.keys(LABEL) as RateFeedbackRating[]).map((r) => `${LABEL[r]} ${d.byRating[r]}`).join(" · ")}
          </span>
          <span className="kpi-label">оцінки</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -8 }}>
        «+» — погодили дорожче, ніж порахував калькулятор (занижує); «−» — дешевше (завищує). Порівнюємо із серединою діапазону «Ставка клієнту».
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <Buckets title="За авто" rows={d.byTonnage} />
        <Buckets title="За зоною карти" rows={d.byZone} label={(k) => ZONE[k] ?? k} />
      </div>
      <div className="chart-card">
        <h2 className="chart-title">Останні коментарі</h2>
        {d.comments.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {d.comments.map((c, i) => (
              <div key={i} style={{ borderTop: i ? "1px solid var(--border)" : undefined, paddingTop: i ? 10 : 0 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {new Date(c.at).toLocaleDateString("uk-UA")} · {c.author} · {c.route} · {LABEL[c.rating]}{c.agreed ? ` · погодили ${c.agreed.toLocaleString("uk-UA")} грн` : ""}
                </div>
                <div style={{ fontSize: 14, marginTop: 2 }}>{c.comment}</div>
              </div>
            ))}
          </div>
        ) : <div style={{ color: "var(--text-muted)", fontSize: 13 }}>коментарів поки немає</div>}
      </div>
    </section>
  );
}
