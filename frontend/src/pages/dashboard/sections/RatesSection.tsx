import { useEffect, useRef, useState } from "react";
import {
  fetchTowns, fetchBodyTypes, analyzeRates, fetchRatesHealth,
  type Town, type BodyType, type RateAnalysis, type RateSide, type RateSummary, type RateOffer,
} from "../../../api";

const BRAND = "#c8102e";
const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("uk-UA"));

/** Debounced city autocomplete backed by Lardi /rates/towns. */
function TownPicker({ label, value, onPick }: { label: string; value: Town | null; onPick: (t: Town | null) => void }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<Town[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) return; // showing a chosen town
    const s = q.trim();
    if (s.length < 2) { setOpts([]); return; }
    const t = setTimeout(() => { fetchTowns(s).then(setOpts).catch(() => setOpts([])); }, 250);
    return () => clearTimeout(t);
  }, [q, value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={box} style={{ position: "relative", flex: 1, minWidth: 200 }}>
      <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{label}</label>
      {value ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, border: `1px solid ${BRAND}`, background: "var(--card-bg)", marginTop: 4 }}>
          <span style={{ flex: 1, fontWeight: 600 }}>{value.name}{value.area ? <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {value.area}</span> : null}</span>
          <button onClick={() => { onPick(null); setQ(""); }} title="Змінити" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 15 }}>✕</button>
        </div>
      ) : (
        <input value={q} onFocusCapture={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          placeholder="Місто…" autoComplete="off"
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", marginTop: 4 }} />
      )}
      {open && !value && opts.length > 0 && (
        <div style={{ position: "absolute", zIndex: 40, top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", maxHeight: 280, overflowY: "auto" }}>
          {opts.map((t) => (
            <button key={t.id} onClick={() => { onPick(t); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent", color: "var(--text)", cursor: "pointer", padding: "8px 12px", fontSize: 14 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(200,16,46,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              {t.name}{t.area ? <span style={{ color: "var(--text-muted)" }}> · {t.area}</span> : null}
              {t.country && t.country !== "UA" ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> ({t.country})</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ title, s }: { title: string; s: RateSummary | null }) {
  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{title}</td>
      <td style={{ textAlign: "right" }}>{s ? fmt(s.min) : "—"}</td>
      <td style={{ textAlign: "right", fontWeight: 700, color: BRAND }}>{s ? fmt(s.median) : "—"}</td>
      <td style={{ textAlign: "right" }}>{s ? fmt(s.avg) : "—"}</td>
      <td style={{ textAlign: "right" }}>{s ? fmt(s.max) : "—"}</td>
      <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{s ? s.n : "—"}</td>
    </tr>
  );
}

function SidePanel({ title, icon, side }: { title: string; icon: string; side: RateSide | undefined }) {
  const [showAll, setShowAll] = useState(false);
  if (!side) return null;
  if (side.error) {
    return (
      <div className="chart-card">
        <h2 className="chart-title">{icon} {title}</h2>
        <p className="loading-text" style={{ color: "#dc2626" }}>Помилка Lardi: {side.error}. {side.detail}</p>
      </div>
    );
  }
  const all = side.classes.all;
  const offers = showAll ? side.offers : side.offers.slice(0, 12);
  return (
    <div className="chart-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 className="chart-title" style={{ marginBottom: 0 }}>{icon} {title} · {side.count}</h2>
        {side.scope === "area" && <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "rgba(245,158,11,0.15)", padding: "2px 10px", borderRadius: 999 }}>по області</span>}
      </div>
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table className="data-table compact">
          <thead><tr><th></th><th style={{ textAlign: "right" }}>мін</th><th style={{ textAlign: "right" }}>медіана</th><th style={{ textAlign: "right" }}>сер</th><th style={{ textAlign: "right" }}>макс</th><th style={{ textAlign: "right" }}>к-сть</th></tr></thead>
          <tbody>
            <SummaryRow title="Ставка, ₴" s={all.uah} />
            <SummaryRow title="₴ / т" s={all.uahPerTon} />
            <SummaryRow title="₴ / км" s={all.uahPerKm} />
          </tbody>
        </table>
      </div>
      {Object.keys(all.otherCurrencies).length > 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
          Інші валюти: {Object.entries(all.otherCurrencies).map(([c, s]) => `${c}: ${s ? fmt(s.median) : "—"} (медіана)`).join(" · ")}
        </p>
      )}
      {side.topCargo.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Вантажі: {side.topCargo.map(([c, n]) => `${c} (${n})`).join(", ")}</p>
      )}
      {offers.length > 0 && (
        <>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table className="data-table compact">
              <thead><tr><th>Вантаж</th><th>Компанія</th><th style={{ textAlign: "right" }}>Вага, т</th><th style={{ textAlign: "right" }}>Ставка</th><th style={{ textAlign: "right" }}>₴/т</th><th style={{ textAlign: "right" }}>₴/км</th><th>Оплата</th><th>Дата</th></tr></thead>
              <tbody>
                {offers.map((o: RateOffer, i) => (
                  <tr key={o.id ?? i}>
                    <td>{o.cargo}{o.bodies.length ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {o.bodies.join(", ")}</span> : null}</td>
                    <td>{o.company || o.face || "—"}{o.phones[0] ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {o.phones[0].n}</span> : null}</td>
                    <td style={{ textAlign: "right" }}>{o.mass ?? "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{o.negotiable ? "договірна" : `${fmt(o.total)} ${o.isUah ? "₴" : o.currency}`}</td>
                    <td style={{ textAlign: "right" }}>{fmt(o.perTon)}</td>
                    <td style={{ textAlign: "right" }}>{fmt(o.perKm)}</td>
                    <td style={{ fontSize: 12 }}>{o.payform || "—"}</td>
                    <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{o.date || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {side.offers.length > 12 && (
            <button onClick={() => setShowAll((v) => !v)} style={{ marginTop: 8, border: "none", background: "none", color: BRAND, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              {showAll ? "Згорнути" : `Показати всі ${side.offers.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function RatesSection() {
  const [frm, setFrm] = useState<Town | null>(null);
  const [to, setTo] = useState<Town | null>(null);
  const [massMin, setMassMin] = useState("20");
  const [massMax, setMassMax] = useState("22");
  const [bodyTypes, setBodyTypes] = useState<BodyType[]>([]);
  const [bodyIds, setBodyIds] = useState<number[]>([]);
  const [result, setResult] = useState<RateAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noToken, setNoToken] = useState(false);

  useEffect(() => {
    fetchRatesHealth().then((h) => setNoToken(!h.hasToken)).catch(() => {});
    fetchBodyTypes().then(setBodyTypes).catch(() => setBodyTypes([]));
  }, []);

  const run = async () => {
    if (!frm || !to) { setError("Оберіть міста звідки і куди"); return; }
    setError(null); setLoading(true); setResult(null);
    try {
      const r = await analyzeRates({
        frm: { townId: frm.id, areaId: frm.areaId, lat: frm.lat, lon: frm.lon, label: frm.name },
        to: { townId: to.id, areaId: to.areaId, lat: to.lat, lon: to.lon, label: to.name },
        massMin: massMin ? Number(massMin) : null,
        massMax: massMax ? Number(massMax) : null,
        bodyTypeIds: bodyIds,
      });
      setResult(r);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error ?? "Не вдалося отримати ставки");
    } finally {
      setLoading(false);
    }
  };

  const rec = result?.recommendation;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🧮 Калькулятор ставок</h1>
      </div>

      {noToken && (
        <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${BRAND}` }}>
          <p style={{ margin: 0, fontSize: 14 }}>⚠️ Токен Lardi не заданий на сервері (`LARDI_API_TOKEN`). Дані не завантажаться, поки його не додати в `.env`.</p>
        </div>
      )}

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px" }}>
          Вбий маршрут і вагу — і побачиш ринкові ставки по напрямку (заказчики й перевізники) з Lardi-Trans: мін / медіана / середня / макс у ₴, ₴/т та ₴/км.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <TownPicker label="Звідки" value={frm} onPick={setFrm} />
          <TownPicker label="Куди" value={to} onPick={setTo} />
          <div>
            <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>Вага, т (від–до)</label>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <input value={massMin} onChange={(e) => setMassMin(e.target.value)} inputMode="decimal" style={{ width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
              <input value={massMax} onChange={(e) => setMassMax(e.target.value)} inputMode="decimal" style={{ width: 70, boxSizing: "border-box", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
            </div>
          </div>
          <button onClick={run} disabled={loading || !frm || !to}
            style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: loading || !frm || !to ? "#94a3b8" : BRAND, color: "#fff", fontWeight: 700, cursor: loading || !frm || !to ? "default" : "pointer", fontSize: 14 }}>
            {loading ? "Аналіз…" : "Аналізувати"}
          </button>
        </div>
        {bodyTypes.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>Тип кузова (необовʼязково{bodyIds.length ? `, обрано ${bodyIds.length}` : ""})</summary>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {bodyTypes.map((b) => {
                const on = bodyIds.includes(b.id);
                return (
                  <button key={b.id} onClick={() => setBodyIds((cur) => on ? cur.filter((x) => x !== b.id) : [...cur, b.id])}
                    style={{ padding: "4px 12px", borderRadius: 999, border: `1px solid ${on ? BRAND : "var(--border)"}`, background: on ? "rgba(200,16,46,0.12)" : "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontSize: 12, fontWeight: on ? 700 : 400 }}>
                    {b.name}
                  </button>
                );
              })}
            </div>
          </details>
        )}
        {error && <p style={{ color: "#dc2626", marginTop: 10, marginBottom: 0, fontSize: 14 }}>{error}</p>}
      </div>

      {result && (
        <>
          {rec && (rec.bandLow || rec.perKm) && (
            <div className="chart-card" style={{ marginBottom: 16, background: "linear-gradient(135deg, rgba(200,16,46,0.10), rgba(200,16,46,0.02))" }}>
              <h2 className="chart-title">🎯 Орієнтир ставки — {result.route.from} → {result.route.to}{result.route.distanceKm ? ` · ${result.route.distanceKm} км` : ""}</h2>
              <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
                {rec.bandLow != null && <div className="kpi-card"><span className="kpi-label">Вилка ставки, ₴</span><span className="kpi-value" style={{ color: BRAND }}>{fmt(rec.bandLow)}–{fmt(rec.bandHigh)}</span></div>}
                {rec.cargoMedian != null && <div className="kpi-card"><span className="kpi-label">Медіана замовників</span><span className="kpi-value">{fmt(rec.cargoMedian)} ₴</span></div>}
                {rec.lorryMedian != null && <div className="kpi-card"><span className="kpi-label">Медіана перевізників</span><span className="kpi-value">{fmt(rec.lorryMedian)} ₴</span></div>}
                {rec.perKm != null && <div className="kpi-card"><span className="kpi-label">₴/км ({rec.perKmSrc})</span><span className="kpi-value">{fmt(rec.perKm)}{rec.perKmTotal ? <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 400 }}> · {fmt(rec.perKmTotal)} ₴/рейс</span> : null}</span></div>}
              </div>
            </div>
          )}
          <div className="chart-grid">
            <SidePanel title="Заказчики (вантажі)" icon="📦" side={result.cargo} />
            <SidePanel title="Перевізники (транспорт)" icon="🚚" side={result.lorry} />
          </div>
        </>
      )}
    </>
  );
}
