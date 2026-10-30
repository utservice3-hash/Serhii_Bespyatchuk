import { useEffect, useState } from "react";
import { fetchRateFeedbackStats, type RateFeedbackStats as Stats, type RateFeedbackRating, type RateAccuracyGroup, type RateAccuracyPair } from "../../../api";

/**
 * 📐 «Порахували → вийшло» (Роман 30.10.2026): що калькулятор показав у момент розрахунку і на яку ставку домовились —
 * рядок на відгук із відхиленням у %, і групи «де помиляємось» (найгірша перша). Раніше тут були лише частки оцінок
 * і коментарі без цін — «статистика нічого не дає». Бачать адмін, СЕО, ОД, КВП — межу тримає сервер
 * (право `view_rate_feedback`); без права (403) блок просто не показується, і перелогін не потрібен.
 */
const ACC = "#c8102e";
const LABEL: Record<RateFeedbackRating, string> = { ok: "Точно", high: "Завищено", low: "Занижено", no: "Не допоміг" };
const ZONE: Record<string, string> = { green: "зелена", yellow: "жовта", red: "червона" };
const PERIODS: [number, string][] = [[7, "Тиждень"], [30, "Місяць"], [90, "3 місяці"]];
const pct = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);
const signed = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${pct(v)}`);
const money = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("uk-UA"));
const range = (lo: number | null | undefined, hi: number | null | undefined) => (lo == null ? "—" : hi == null || hi === lo ? money(lo) : `${money(lo)} – ${money(hi)}`);
/** Відхилення: у межах ±10% — звичайний колір, до ±25% — помаранчевий, далі — червоний. */
const devColor = (v: number | null) => (v == null ? "var(--text-muted)" : Math.abs(v) <= 10 ? "var(--text)" : Math.abs(v) <= 25 ? "#b45309" : ACC);
const SOURCE_COLOR: Record<string, string> = { "ринок": "#2563eb", "тариф КВП": "#b45309" };
const right = { textAlign: "right" as const };
/** Заголовки й клітинки таблиці пар: 14 колонок на ширину екрана — без відступів «км» зливається з «Джерело». */
const th = { whiteSpace: "nowrap" as const, padding: "6px 10px" };
const td = { padding: "6px 10px" };
const muted = { color: "var(--text-muted)", fontSize: 13 };

function Groups({ title, col, rows, label }: { title: string; col: string; rows: RateAccuracyGroup[]; label?: (k: string) => string }) {
  return (
    // Дві картки в ряд (не чотири): шість колонок у 330 px не вміщались — числа й «Оцінки» вилазили за край (Роман 30.10).
    <div className="chart-card" style={{ flex: "1 1 520px", minWidth: 0, overflowX: "auto" }}>
      <h2 className="chart-title">{title}</h2>
      <table className="data-table" style={{ width: "100%" }}>
        <thead><tr><th style={th}>{col}</th><th style={{ ...th, ...right }}>Відгуків</th><th style={{ ...th, ...right }}>З ціною</th><th style={{ ...th, ...right }} title="медіана відхилення погодженої ставки від порахованої">Відхилення</th><th style={{ ...th, ...right }} title="медіана |відхилення| — типова похибка">Похибка</th><th style={th}>Оцінки</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((g) => (
            <tr key={g.key}>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{label ? label(g.key) : g.key}</td>
              <td style={{ ...td, ...right }}>{g.n}</td>
              <td style={{ ...td, ...right }}>{g.priced || "—"}</td>
              <td style={{ ...td, ...right, fontWeight: 600, color: devColor(g.median_dev), whiteSpace: "nowrap" }}>{signed(g.median_dev)}</td>
              <td style={{ ...td, ...right, color: devColor(g.median_abs), whiteSpace: "nowrap" }}>{g.median_abs == null ? "—" : `±${pct(g.median_abs)}`}</td>
              <td style={{ ...td, fontSize: 12, color: "var(--text-muted)", width: "40%" }}>
                {([["ok", g.ok], ["high", g.high], ["low", g.low], ["no", g.no]] as [RateFeedbackRating, number][]).filter(([, n]) => n).map(([r, n]) => `${LABEL[r]} ${n}`).join(" · ") || "—"}
              </td>
            </tr>
          )) : <tr><td colSpan={6} style={muted}>ще немає відгуків</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Pairs({ rows }: { rows: RateAccuracyPair[] }) {
  return (
    <div className="chart-card" style={{ overflowX: "auto" }}>
      <h2 className="chart-title">Порахували → вийшло</h2>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>
        Кожен відгук, де вписали погоджену ставку: що калькулятор показав у момент розрахунку і на чому домовились.
        «+» — домовились дорожче (калькулятор занизив), «−» — дешевше (завищив); відхилення — від середини показаного діапазону.
      </div>
      <table className="data-table" style={{ minWidth: 980 }}>
        <thead><tr>
          <th style={th}>Дата</th><th style={th}>Хто</th><th style={th}>Маршрут</th><th style={th}>Авто</th><th style={{ ...th, ...right }}>км</th><th style={th}>Джерело</th>
          <th style={{ ...th, ...right }}>Клієнту: порахували</th><th style={{ ...th, ...right }}>погодили</th><th style={{ ...th, ...right }}>Δ</th>
          <th style={{ ...th, ...right }}>Перевізнику: порахували</th><th style={{ ...th, ...right }}>погодили</th><th style={{ ...th, ...right }}>Δ</th>
          <th style={th}>Оцінка</th><th style={th}>Коментар</th>
        </tr></thead>
        <tbody>
          {rows.length ? rows.map((p, i) => (
            <tr key={i}>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{new Date(p.at).toLocaleDateString("uk-UA")}</td>
              <td style={td}>{p.author}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{p.route}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{p.tonnage ?? "—"}</td>
              <td style={{ ...td, ...right }}>{p.km ?? "—"}</td>
              <td style={{ ...td, color: SOURCE_COLOR[sourceLabel(p.source)] ?? "var(--text-muted)", whiteSpace: "nowrap" }}>{sourceLabel(p.source)}</td>
              <td style={{ ...td, ...right, whiteSpace: "nowrap" }}>{range(p.client_min, p.client_max)}</td>
              <td style={{ ...td, ...right, fontWeight: 600, whiteSpace: "nowrap" }}>{money(p.agreed)}</td>
              <td style={{ ...td, ...right, fontWeight: 700, color: devColor(p.dev_pct) }}>{signed(p.dev_pct)}</td>
              <td style={{ ...td, ...right, whiteSpace: "nowrap", color: "var(--text-muted)" }}>{range(p.carrier_min, p.carrier_max)}</td>
              <td style={{ ...td, ...right, whiteSpace: "nowrap" }}>{money(p.agreed_carrier)}</td>
              <td style={{ ...td, ...right, fontWeight: 600, color: devColor(p.dev_carrier_pct) }}>{signed(p.dev_carrier_pct)}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{LABEL[p.rating]}</td>
              <td style={{ ...td, fontSize: 13, maxWidth: 280 }}>{p.comment ?? ""}</td>
            </tr>
          )) : <tr><td colSpan={14} style={muted}>ще ніхто не вписав погоджену ставку — без неї порівнювати нема з чим</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const sourceLabel = (s: RateAccuracyPair["source"]) => (s === "market" ? "ринок" : s === "tariff" ? "тариф КВП" : "до 30.10 (тариф)");

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
  const a = d.accuracy;
  return (
    <section aria-label="Точність розрахунку" style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <h2 className="chart-title" style={{ margin: 0 }}>Точність калькулятора: порахували → вийшло</h2>
        <span style={{ flex: 1 }} />
        {PERIODS.map(([n, l]) => (
          <button key={n} type="button" onClick={() => setDays(n)} aria-pressed={days === n}
            style={{ minHeight: 36, padding: "0 12px", borderRadius: 999, fontSize: 13, cursor: "pointer", color: "var(--text)",
              border: days === n ? `1px solid ${ACC}` : "1px solid var(--border)", background: days === n ? "rgba(200,16,46,0.08)" : "var(--card-bg)" }}>{l}</button>
        ))}
      </div>
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-value" style={{ color: devColor(a.median_dev) }}>{signed(a.median_dev)}</span>
          <span className="kpi-label">{a.priced ? `медіана відхилення · ${a.priced} з ціною · типова похибка ±${pct(a.median_abs)}` : "ще ніхто не вписав погоджену ставку"}</span>
        </div>
        <div className="kpi-card"><span className="kpi-value" style={{ color: ACC }}>{pct(d.okShare)}</span><span className="kpi-label">«Точно, взяв цю ставку»</span></div>
        <div className="kpi-card"><span className="kpi-value">{d.total}</span><span className="kpi-label">відгуків · {pct(d.coverage)} від {d.calculations} розрахунків</span></div>
        <div className="kpi-card">
          <span className="kpi-value" style={{ fontSize: 15, lineHeight: 1.5 }}>
            {(Object.keys(LABEL) as RateFeedbackRating[]).map((r) => `${LABEL[r]} ${d.byRating[r]}`).join(" · ")}
          </span>
          <span className="kpi-label">оцінки</span>
        </div>
      </div>
      <Pairs rows={a.pairs} />
      <div>
        <h2 className="chart-title" style={{ marginBottom: 4 }}>Де помиляємось</h2>
        <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Групи за джерелом ціни, авто, відстанню й зоною — найбільша похибка зверху. Оцінки — за всіма відгуками, відхилення — лише за тими, де є ціна.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <Groups title="За джерелом ціни" col="Джерело" rows={a.bySource} />
          <Groups title="За авто" col="Авто" rows={a.byTonnage} />
          <Groups title="За відстанню" col="Відстань" rows={a.byDistance} />
          <Groups title="За зоною карти" col="Зона" rows={a.byZone} label={(k) => ZONE[k] ?? k} />
        </div>
      </div>
      <div className="chart-card">
        <h2 className="chart-title">Останні коментарі</h2>
        {d.comments.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {d.comments.map((c, i) => (
              <div key={i} style={{ borderTop: i ? "1px solid var(--border)" : undefined, paddingTop: i ? 10 : 0 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {new Date(c.at).toLocaleDateString("uk-UA")} · {c.author} · {c.route} · {LABEL[c.rating]}
                  {c.client_min != null ? ` · порахували ${range(c.client_min, c.client_max)} грн` : ""}
                  {c.agreed ? ` → погодили ${money(c.agreed)} грн` : ""}
                </div>
                <div style={{ fontSize: 14, marginTop: 2 }}>{c.comment}</div>
              </div>
            ))}
          </div>
        ) : <div style={muted}>коментарів поки немає</div>}
      </div>
    </section>
  );
}
