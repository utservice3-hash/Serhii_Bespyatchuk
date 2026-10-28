import { useEffect, useRef, useState } from "react";
import {
  fetchTowns, fetchBodyTypes, analyzeRates, fetchRatesHealth, sendRateFeedback,
  type Town, type BodyType, type RateAnalysis, type RateFeedbackRating,
} from "../../../api";
import { TownField, OfferTable, CityInfoView, CarriersView, StatsView } from "./RatesSection";
import { RateFeedbackStats } from "./RateFeedbackStats";

/**
 * 🧮 «Розрахунок ставки» — спрощений екран (Роман 27.10.2026; макет і прототип погоджені того ж дня).
 * Одна відповідь — ставка клієнту з зонної карти (рядок, обраний за авто); ринок одним рядком; «Як порахували» і
 * пропозиції Lardi згорнуті. Відгук «наскільки допоміг» виїжджає справа через 15 с перегляду результату — лише коли
 * сервер каже «питати» (раз на маршрут на день, `core/rateFeedback.ts`). «Ціни по місту», «Перевізники» і статистика
 * лишились — малими кнопками; у статистиці зведення відгуків бачать адмін, СЕО, ОД, КВП (межу тримає сервер).
 * Попередній вигляд (`RatesSection`) не видалено — лише не показується; його частини (поле міста, таблиці) спільні.
 */
const ACC = "#c8102e";
const FEEDBACK_DELAY_MS = 15_000;
const fmt = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("uk-UA"));
const range = (a: number | null | undefined, b: number | null | undefined) =>
  a == null ? "—" : b == null || a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;

/** Авто → вага, за якою сервер обирає рядок зонної карти (`ZONE_RATES`). */
const AUTOS = [
  { id: "f20", label: "Фура 20 т", min: 18, max: 22 },
  { id: "t10", label: "до 10 т", min: 5.1, max: 10 },
  { id: "t5", label: "до 5 т", min: 2.6, max: 5 },
  { id: "t25", label: "до 2,5 т", min: null, max: 2.5 },
] as const;
const TOP_BODIES = ["Тент", "Реф.", "Ізотерм", "Бортова / Відкрита"];
const FEEDBACK: [RateFeedbackRating, string][] = [
  ["ok", "Точно, взяв цю ставку"], ["high", "Завищено"], ["low", "Занижено"], ["no", "Не допоміг"],
];
type View = "calc" | "cities" | "carriers" | "stats";
const VIEWS: [View, string][] = [["calc", "Розрахунок"], ["cities", "Ціни по місту"], ["carriers", "Перевізники"], ["stats", "Статистика"]];

/* Анімації — одним блоком; «зменшити рух» у системі вимикає їх повністю. */
const CSS = `
.rs-in{animation:rs-up .42s cubic-bezier(.2,.8,.2,1) both}
.rs-d1{animation-delay:.06s}.rs-d2{animation-delay:.12s}.rs-d3{animation-delay:.18s}.rs-d4{animation-delay:.24s}
@keyframes rs-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.rs-btn{transition:background-color .18s ease,border-color .18s ease,box-shadow .18s ease,transform .12s ease,opacity .18s ease}
.rs-btn:hover:not(:disabled){box-shadow:0 2px 10px rgba(20,30,45,.10)}
.rs-btn:active:not(:disabled){transform:scale(.97)}
.rs-acc{interpolate-size:allow-keywords}
.rs-acc::details-content{height:0;overflow:hidden;transition:height .3s ease,content-visibility .3s allow-discrete}
.rs-acc[open]::details-content{height:auto}
.rs-acc>summary{list-style:none;display:flex;align-items:center;gap:8px}
.rs-acc>summary::-webkit-details-marker{display:none}
.rs-acc>summary::before{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .25s ease;margin-left:2px}
.rs-acc[open]>summary::before{transform:rotate(45deg)}
.rs-skel{background:linear-gradient(90deg,var(--border) 25%,rgba(200,200,210,.25) 50%,var(--border) 75%);background-size:200% 100%;animation:rs-shim 1.2s linear infinite;border-radius:8px}
@keyframes rs-shim{from{background-position:200% 0}to{background-position:-200% 0}}
.rs-fb{position:fixed;right:24px;bottom:24px;z-index:50;width:340px;max-width:calc(100vw - 32px);
  transform:translateX(calc(100% + 40px));opacity:0;transition:transform .55s cubic-bezier(.2,.8,.2,1),opacity .4s ease;
  box-shadow:0 18px 48px rgba(20,30,45,.18)}
.rs-fb.on{transform:none;opacity:1}
@media (max-width:600px){.rs-fb{right:16px;bottom:16px}}
@media (min-width:1100px){.rs-res{transition:margin-right .55s cubic-bezier(.2,.8,.2,1)}.rs-res.fb-on{margin-right:364px}}
@media (prefers-reduced-motion:reduce){.rs-in,.rs-skel{animation:none}.rs-btn,.rs-fb,.rs-res,.rs-acc::details-content,.rs-acc>summary::before{transition:none}}
`;

const box: React.CSSProperties = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14 };
const ctl: React.CSSProperties = {
  height: 44, boxSizing: "border-box", padding: "0 10px", background: "var(--card-bg)", border: "1px solid var(--border)",
  borderRadius: 10, color: "var(--text)", fontSize: 15, width: "100%",
};
const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" };
const tile: React.CSSProperties = { background: "var(--bg, #f6f7f9)", borderRadius: 10, padding: 12 };

/** Число «набігає» від 0 до значення за ~0,7 с (easeOutCubic); без руху — одразу значення. */
function useCountUp(target: number | null | undefined, key: unknown): number | null {
  const [v, setV] = useState<number | null>(target ?? null);
  useEffect(() => {
    if (target == null) { setV(null); return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setV(target); return; }
    let raf = 0; const t0 = performance.now(), dur = 700;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      setV(Math.round((target * e) / 10) * 10);
      if (p < 1) raf = requestAnimationFrame(step); else setV(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, key]);
  return v;
}

export function RatesSimple() {
  const [view, setView] = useState<View>("calc");
  // Кнопка «Статистика» — як і раніше, керівництву й фінансисту (`/rates/stats`); відгуки в ній — лише з правом.
  const [isAdmin] = useState(() => { try { const t = localStorage.getItem("token"); if (!t) return false; return JSON.parse(atob(t.split(".")[1] ?? "")).role === "admin"; } catch { return false; } });
  const [noToken, setNoToken] = useState(false);
  const [frm, setFrm] = useState<Town | null>(null);
  const [to, setTo] = useState<Town | null>(null);
  const [frmText, setFrmText] = useState("");
  const [toText, setToText] = useState("");
  const [auto, setAuto] = useState<(typeof AUTOS)[number]["id"]>("f20");
  const [bodies, setBodies] = useState<BodyType[]>([]);
  const [bodyId, setBodyId] = useState("");
  const [data, setData] = useState<RateAnalysis | null>(null);
  const [runId, setRunId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fbOpen, setFbOpen] = useState(false);
  const [pick, setPick] = useState<RateFeedbackRating | null>(null);
  const [sending, setSending] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [agreed, setAgreed] = useState("");
  const [note, setNote] = useState("");
  const [recent, setRecent] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("ratesRecent") ?? "[]"); } catch { return []; } });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchBodyTypes().then(setBodies).catch(() => setBodies([]));
    fetchRatesHealth().then((h) => setNoToken(!h.has_token)).catch(() => {});
  }, []);

  // ⏱ Відгук — через 15 с перегляду результату і лише коли сервер каже «питати»; новий розрахунок — відлік заново.
  useEffect(() => {
    setFbOpen(false);
    if (!data?.feedback_due) return;
    const t = setTimeout(() => setFbOpen(true), FEEDBACK_DELAY_MS);
    return () => clearTimeout(t);
  }, [data, runId]);
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const resolve = async (picked: Town | null, q: string) => {
    if (picked) return picked;
    const s = q.trim(); if (!s) return null;
    const items = await fetchTowns(s).catch(() => []);
    return items.find((x) => x.name.toLowerCase() === s.toLowerCase()) ?? items[0] ?? null;
  };

  const run = async (fText = frmText, tText = toText, fPicked = frm, tPicked = to) => {
    setLoading(true); setError(null); setData(null); setPick(null); setSent(false); setAgreed(""); setNote(""); setFbError(null);
    try {
      const f = await resolve(fPicked, fText), t = await resolve(tPicked, tText);
      if (!f || !t) { setError("Вкажіть міста відправлення і призначення."); return; }
      setFrm(f); setFrmText(f.name); setTo(t); setToText(t.name);
      const a = AUTOS.find((x) => x.id === auto)!;
      const r = await analyzeRates({
        frm: { town_id: f.id, area_id: f.area_id, lat: f.lat, lon: f.lon, label: f.name, area: f.area },
        to: { town_id: t.id, area_id: t.area_id, lat: t.lat, lon: t.lon, label: t.name, area: t.area },
        mass_min: a.min, mass_max: a.max, body_type_ids: bodyId ? [Number(bodyId)] : [],
      });
      setData(r); setRunId((n) => n + 1);
      const key = `${f.name} → ${t.name}`;
      const next = [key, ...recent.filter((x) => x !== key)].slice(0, 5);
      setRecent(next); try { localStorage.setItem("ratesRecent", JSON.stringify(next)); } catch { /* приватне вікно */ }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; detail?: string } } };
      setError(err.response?.data?.detail ?? err.response?.data?.error ?? `Збій запиту: ${String(e)}`);
    } finally { setLoading(false); }
  };

  const send = async () => {
    if (!data?.usage_id || !pick) return;
    setSending(true); setFbError(null);
    try {
      await sendRateFeedback({ usageId: data.usage_id, rating: pick, agreed, comment: note });
      setSent(true);
      hideTimer.current = setTimeout(() => setFbOpen(false), 2600);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setFbError(err.response?.data?.error ?? "Не вдалося надіслати — спробуйте ще раз");
    } finally { setSending(false); }
  };

  const swap = () => { setFrm(to); setTo(frm); setFrmText(toText); setToText(frmText); };
  const zr = data?.zone_recommendation ?? null;
  const sel = zr?.options.find((o) => o.selected) ?? null;
  const cMin = useCountUp(sel?.client_min, runId), cMax = useCountUp(sel?.client_max, runId);
  const autoLabel = AUTOS.find((x) => x.id === auto)!.label.toLowerCase();
  const cargoPriced = (data?.cargo?.offers ?? []).filter((o) => o.is_uah && o.total).length;
  const lorryPriced = (data?.lorry?.offers ?? []).filter((o) => o.is_uah && o.total).length;
  const offersN = (data?.cargo?.offers?.length ?? 0) + (data?.lorry?.offers?.length ?? 0);
  const topBodies = bodies.filter((b) => TOP_BODIES.includes(b.name));
  const otherBodies = bodies.filter((b) => !TOP_BODIES.includes(b.name));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%" }}>
      <style>{CSS}</style>
      <div role="tablist" aria-label="Розділи розрахунку" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {VIEWS.filter(([v]) => v !== "stats" || isAdmin).map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className="rs-btn" onClick={() => setView(v)}
            style={{ minHeight: 36, padding: "0 12px", borderRadius: 999, fontSize: 13, cursor: "pointer", fontWeight: view === v ? 600 : 500,
              border: view === v ? `1px solid ${ACC}` : "1px solid var(--border)", background: view === v ? "rgba(200,16,46,0.08)" : "var(--card-bg)", color: "var(--text)" }}>{l}</button>
        ))}
      </div>
      {view === "cities" && <CityInfoView />}
      {view === "carriers" && <CarriersView />}
      {view === "stats" && isAdmin && <><RateFeedbackStats /><StatsView /></>}
      {view === "calc" && <>
      {noToken && <div className="rs-in" style={{ ...box, padding: 16, borderLeft: `4px solid ${ACC}`, fontSize: 14 }}>⚠️ Токен Lardi не заданий на сервері — розрахунок не працюватиме.</div>}
      {/* Анімація `.rs-in` робить кожну картку окремим шаром, і пізніші («Нещодавні», результат) малювались поверх
          підказок міст. Форма — вище за сусідів (Роман 27.10.2026, #2777). */}
      <div className="rs-in" style={{ ...box, padding: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", position: "relative", zIndex: 5 }}>
        <TownField label="Звідки" placeholder="місто" text={frmText} setText={(v) => { setFrmText(v); setFrm(null); }} picked={frm} onPick={(t) => { setFrm(t); setFrmText(t.name); }} />
        <button type="button" className="rs-btn" onClick={swap} aria-label="Поміняти місцями" style={{ ...ctl, width: 44, padding: 0, color: ACC, cursor: "pointer" }}>⇄</button>
        <TownField label="Куди" placeholder="місто" text={toText} setText={(v) => { setToText(v); setTo(null); }} picked={to} onPick={(t) => { setTo(t); setToText(t.name); }} />
        <label style={{ ...lbl, flex: "0 1 150px" }}>Авто
          <select value={auto} onChange={(e) => setAuto(e.target.value as typeof auto)} style={ctl}>
            {AUTOS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label style={{ ...lbl, flex: "0 1 170px" }}>Кузов
          <select value={bodyId} onChange={(e) => setBodyId(e.target.value)} style={ctl}>
            <option value="">будь-який</option>
            {topBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            {otherBodies.length > 0 && <optgroup label="Інші">{otherBodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>}
          </select>
        </label>
        <button type="button" className="rs-btn" onClick={() => run()} disabled={loading}
          style={{ height: 44, padding: "0 22px", border: 0, borderRadius: 10, background: ACC, color: "#fff", fontSize: 15, fontWeight: 600, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Рахую…" : "Розрахувати"}
        </button>
      </div>

      {!data && !loading && recent.length > 0 && (
        <div className="rs-in rs-d1" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13, color: "var(--text-muted)" }}>
          <span>Нещодавні:</span>
          {recent.map((r) => {
            const [a, b] = r.split(" → ");
            return <button key={r} type="button" className="rs-btn" onClick={() => { setFrmText(a); setToText(b); setFrm(null); setTo(null); void run(a, b, null, null); }}
              style={{ minHeight: 36, padding: "0 12px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 13, cursor: "pointer" }}>{r}</button>;
          })}
        </div>
      )}

      {loading && (
        <section className="rs-in" aria-busy="true" aria-label="Рахую ставку" style={{ ...box, padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="rs-skel" style={{ width: 220, height: 14 }} />
          <div className="rs-skel" style={{ width: 360, maxWidth: "100%", height: 40 }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
            <div className="rs-skel" style={{ height: 58 }} /><div className="rs-skel" style={{ height: 58 }} /><div className="rs-skel" style={{ height: 58 }} />
          </div>
        </section>
      )}

      {error && <div className="rs-in" style={{ ...box, padding: 16, color: "#dc2626", fontSize: 14 }}>{error}</div>}

      {data && !loading && (
        <section key={runId} className={`rs-in rs-res${fbOpen ? " fb-on" : ""}`} style={{ ...box, padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {data.route.from} → {data.route.to}{data.route.distance_km ? ` · ${fmt(data.route.distance_km)} км` : ""} · {autoLabel}
          </div>
          {sel?.client_min != null ? (
            <>
              <div className="rs-in rs-d1">
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>Ставка клієнту</div>
                <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" }}>{range(cMin, cMax)} грн</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                <div className="rs-in rs-d2" style={tile}><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Перевізнику</div><div style={{ fontSize: 18, fontWeight: 700 }}>{range(sel.total_min, sel.total_max)}</div></div>
                <div className="rs-in rs-d3" style={tile}><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Маржа UTS</div><div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(sel.margin)}</div></div>
                <div className="rs-in rs-d4" style={tile}><div style={{ fontSize: 12, color: "var(--text-muted)" }}>грн/км</div><div style={{ fontSize: 18, fontWeight: 700 }}>{sel.per_km_min === sel.per_km_max ? sel.per_km_min : `${sel.per_km_min}–${sel.per_km_max}`}</div></div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 15, color: "var(--text-muted)" }}>Для цього напрямку зонна ставка не визначилась — дивіться пропозиції Lardi нижче.</div>
          )}
          <div className="rs-in rs-d4" style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 13, color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <span>Ринок зараз: замовники <b style={{ color: "var(--text)" }}>{data.recommendation?.cargo_median ? `${fmt(data.recommendation.cargo_median)} грн` : "—"}</b> ({cargoPriced} зі ставкою)</span>
            <span>перевізники <b style={{ color: "var(--text)" }}>{data.recommendation?.lorry_median ? `${fmt(data.recommendation.lorry_median)} грн` : "договірна"}</b> ({lorryPriced} зі ставкою)</span>
          </div>
          {zr && (
            <details className="rs-acc" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600 }}>Як порахували</summary>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
                Зонна карта: зона «{zr.zone_label}» ({zr.zone_src}) · {zr.from_area ?? "?"} → {zr.to_area ?? "?"}
                {sel ? ` · тариф ${sel.per_km_min}–${sel.per_km_max} грн/км × відстань + маржа ${fmt(sel.margin)} грн` : ""}
                {zr.short_haul ? " · ×1,5 за коротке плече" : ""}
              </div>
            </details>
          )}
          <details className="rs-acc">
            <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600 }}>Пропозиції Lardi · {offersN}</summary>
            <OfferTable title="Замовники (вантажі)" side={data.cargo} cls="all" />
            <OfferTable title="Перевізники (транспорт)" side={data.lorry} cls="all" />
          </details>
        </section>
      )}
      </>}

      {/* 💬 Відгук: виїжджає з правого краю через 15 с; закривається хрестиком або сам після «Надіслати». */}
      <aside className={`rs-fb${fbOpen && data && view === "calc" ? " on" : ""}`} aria-hidden={!(fbOpen && data && view === "calc")} aria-label="Відгук про розрахунок"
        style={{ ...box, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {sent ? (
          <div className="rs-in" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Дякуємо!</div>
            <div style={{ fontSize: 14, color: "var(--text-muted)" }}>За відгуками рахуємо, наскільки калькулятор попадає в реальні ставки.</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Наскільки розрахунок допоміг?</div>
              <button type="button" className="rs-btn" onClick={() => setFbOpen(false)} aria-label="Закрити" tabIndex={fbOpen ? 0 : -1}
                style={{ width: 32, height: 32, flex: "none", border: 0, borderRadius: 8, background: "transparent", color: "var(--text-muted)", fontSize: 18, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {FEEDBACK.map(([id, label]) => (
                <button key={id} type="button" className="rs-btn" aria-pressed={pick === id} onClick={() => setPick(id)} tabIndex={fbOpen ? 0 : -1}
                  style={{ minHeight: 44, padding: "8px 10px", borderRadius: 10, cursor: "pointer", fontSize: 14, color: "var(--text)",
                    border: pick === id ? `2px solid ${ACC}` : "1px solid var(--border)", background: pick === id ? "rgba(200,16,46,0.08)" : "var(--card-bg)" }}>{label}</button>
              ))}
            </div>
            <label style={lbl}>Ставка, яку погодили з клієнтом (необовʼязково)
              <input value={agreed} onChange={(e) => setAgreed(e.target.value)} inputMode="numeric" placeholder="напр. 44 000" tabIndex={fbOpen ? 0 : -1} style={{ ...ctl, padding: "0 12px" }} />
            </label>
            <label style={lbl}>Коментар (необовʼязково)
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Що не так або чого бракує" tabIndex={fbOpen ? 0 : -1}
                style={{ ...ctl, height: "auto", padding: "10px 12px", fontSize: 14, resize: "vertical", fontFamily: "inherit" }} />
            </label>
            {fbError && <div role="alert" style={{ fontSize: 13, color: "#dc2626" }}>{fbError}</div>}
            <button type="button" className="rs-btn" disabled={!pick || sending} onClick={() => { void send(); }} tabIndex={fbOpen ? 0 : -1}
              style={{ height: 44, border: 0, borderRadius: 10, background: "var(--text)", color: "var(--card-bg)", fontSize: 15, fontWeight: 600, cursor: pick && !sending ? "pointer" : "default", opacity: pick && !sending ? 1 : 0.45 }}>{sending ? "Надсилаю…" : "Надіслати"}</button>
          </>
        )}
      </aside>
    </div>
  );
}
