import { useEffect, useRef, useState } from "react";
import {
  fetchTowns, fetchBodyTypes, analyzeRates, fetchRatesHealth, fetchRatesStats, fetchSettings,
  fetchCityInfo, addCityInfo, deleteCityInfo, fetchCarriers,
  type Town, type BodyType, type RateAnalysis, type RateSide, type RateOffer, type RatesUsageStats,
  type AppSettings, type CityInfoEntry, type CityInfoCategory, type CrmCarrier,
} from "../../../api";

// Точна репліка оригінального lardiweb UI (порт вбудованого HTML/JS з main.py):
// періоди Зараз/Тиждень/Місяць з власного архіву, тип завантаження, орієнтир
// зі строгих збігів + IQR-фільтром аномалій, ПДВ-розбивка, повні таблиці з
// телефонами. Кольори прикладено до теми дашборду (акцент — бренд UTS).
const ACC = "#c8102e";
const CARGO_DOT = "#2f9e44";
const LORRY_DOT = "#e8893a";

const fmt = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("uk-UA"));
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

type Cls = "full" | "part" | "all";
type Period = "now" | "week" | "month";
const CLABEL: Record<Cls, string> = { full: "цілі машини", part: "догрузи", all: "усі типи" };

// Статистика з IQR-відкиданням аномалій (тільки якщо n>=5) — як в оригіналі.
interface Sum { n: number; dropped: number; min: number; median: number; avg: number; max: number }
function S(arr: number[]): Sum | null {
  let a = arr.filter((x) => x > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  let dropped = 0;
  if (a.length >= 5) {
    const q = (p: number) => { const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
    const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1, loB = q1 - 1.5 * iqr, hiB = q3 + 1.5 * iqr;
    const k = a.filter((x) => x >= loB && x <= hiB);
    if (k.length) { dropped = a.length - k.length; a = k; }
  }
  const m = Math.floor(a.length / 2);
  return {
    n: a.length, dropped,
    min: Math.round(a[0]), max: Math.round(a[a.length - 1]),
    median: a.length % 2 ? Math.round(a[m]) : Math.round((a[m - 1] + a[m]) / 2),
    avg: Math.round(a.reduce((s, x) => s + x, 0) / a.length),
  };
}
function statsObj(offers: RateOffer[]) {
  const other: Record<string, number[]> = {};
  for (const o of offers) if (o.total && !o.is_uah) (other[o.currency || "?"] ??= []).push(o.total);
  return {
    count: offers.length,
    negotiable: offers.filter((o) => o.negotiable).length,
    uah: S(offers.filter((o) => o.is_uah && o.total).map((o) => o.total as number)),
    uah_per_ton: S(offers.filter((o) => o.is_uah && o.per_ton).map((o) => o.per_ton as number)),
    uah_per_km: S(offers.filter((o) => o.is_uah && o.per_km).map((o) => o.per_km as number)),
    other_currencies: Object.fromEntries(Object.entries(other).map(([k, v]) => [k, S(v)])),
  };
}

const lardiOff = (side?: RateSide) =>
  !!side?.error && /403/.test(side.error) && /Расширен|доступ к API/i.test(side.detail || "");

export function RatesSection() {
  const [frm, setFrm] = useState<Town | null>(null);
  const [to, setTo] = useState<Town | null>(null);
  const [frmText, setFrmText] = useState("");
  const [toText, setToText] = useState("");
  const [massMin, setMassMin] = useState("");
  const [massMax, setMassMax] = useState("");
  const [bodyTypes, setBodyTypes] = useState<BodyType[]>([]);
  const [bodyId, setBodyId] = useState("");
  const [data, setData] = useState<RateAnalysis | null>(null);
  const [cls, setCls] = useState<Cls>("full");
  const [period, setPeriod] = useState<Period>("now");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noToken, setNoToken] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [view, setView] = useState<"route" | "cities" | "carriers">("route");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isAdmin] = useState(() => { try { const t = localStorage.getItem("token"); if (!t) return false; return JSON.parse(atob(t.split(".")[1] ?? "")).role === "admin"; } catch { return false; } });

  useEffect(() => {
    fetchRatesHealth().then((h) => setNoToken(!h.has_token)).catch(() => {});
    fetchBodyTypes().then(setBodyTypes).catch(() => setBodyTypes([]));
    fetchSettings().then(setSettings).catch(() => {});
  }, []);

  const swap = () => {
    setFrm(to); setTo(frm);
    setFrmText(toText); setToText(frmText);
  };

  // Якщо місто не вибране з підказки — резолвимо введений текст у town_id.
  const resolveTown = async (picked: Town | null, text: string): Promise<Town | null> => {
    if (picked) return picked;
    const q = text.trim();
    if (q.length < 2) return null;
    const items = await fetchTowns(q).catch(() => []);
    if (!items.length) return null;
    return items.find((x) => norm(x.name) === norm(q)) ?? items[0];
  };

  const run = async () => {
    setLoading(true); setError(null); setData(null);
    try {
      const f = await resolveTown(frm, frmText);
      const t = await resolveTown(to, toText);
      if (!f || !t) { setError("Вкажіть місто відправлення і призначення (почніть вводити — зʼявляться підказки)."); return; }
      setFrm(f); setFrmText(f.name); setTo(t); setToText(t.name);
      const r = await analyzeRates({
        frm: { town_id: f.id, area_id: f.area_id, lat: f.lat, lon: f.lon, label: f.name, area: f.area },
        to: { town_id: t.id, area_id: t.area_id, lat: t.lat, lon: t.lon, label: t.name, area: t.area },
        mass_min: massMin ? Number(massMin) : null,
        mass_max: massMax ? Number(massMax) : null,
        body_type_ids: bodyId ? [Number(bodyId)] : [],
      });
      setData(r); setCls("full"); setPeriod("now");
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; detail?: string } } };
      setError(err.response?.data?.detail ?? err.response?.data?.error ?? `Збій запиту: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  // view сторони з обраним періодом (now=live, week=7 дн, month=30 дн)
  const periodDays = period === "month" ? 30 : period === "week" ? 7 : 0;
  const sideView = (side?: RateSide): RateSide | undefined => {
    if (!side || side.error) return side;
    if (period === "now") return side;
    const cutoff = Math.floor(Date.now() / 1000) - periodDays * 86400;
    return { ...side, offers: (side.history ?? []).filter((o) => !o.ts || o.ts >= cutoff) };
  };

  // СТРОГЕ підмножина: точний маршрут; для вантажів — вага + тип завантаження.
  const strictForSide = (side: RateSide | undefined, isLorry: boolean): RateOffer[] => {
    if (!data) return [];
    const offers = side?.offers ?? [];
    const rf = norm(data.route.from), rt = norm(data.route.to);
    const mn = massMin ? Number(massMin) : null, mx = massMax ? Number(massMax) : null;
    return offers.filter((o) => {
      if (norm(o.from) !== rf || norm(o.to) !== rt) return false;
      if (!isLorry) {
        if (mn && (!o.mass || o.mass < mn)) return false;
        if (mx && (!o.mass || o.mass > mx)) return false;
        if (cls !== "all" && o.load_type !== cls && o.load_type !== "unknown") return false;
      }
      return true;
    });
  };

  const vc = sideView(data?.cargo), vl = sideView(data?.lorry);
  const dist = data?.route.distance_km ?? null;

  // рекомендація зі строгих збігів (як strictRec оригіналу)
  const strictStats = (side: RateSide | undefined, isLorry: boolean) => {
    const st = statsObj(strictForSide(side, isLorry));
    return { n: st.count, median: st.uah?.median ?? null, per_km: st.uah_per_km?.median ?? null };
  };
  const cs = strictStats(vc, false), ls = strictStats(vl, true);
  const bandMeds = [cs.median, ls.median].filter((x): x is number => !!x);
  const perKm = cs.per_km || ls.per_km;
  const perKmSrc = cs.per_km ? "замовники" : "перевізники";
  // Розбивка за ПДВ (по замовниках), якщо ставок з ціною >5
  const cofs = strictForSide(vc, false).filter((o) => o.is_uah && o.total);
  let vat: { without: { n: number; total: number | null; per_km: number | null }; with: { n: number; total: number | null; per_km: number | null } } | null = null;
  if (cofs.length > 5) {
    const g = (arr: RateOffer[]) => { const s = statsObj(arr); return { n: arr.length, total: s.uah?.median ?? null, per_km: s.uah_per_km?.median ?? null }; };
    vat = {
      without: g(cofs.filter((o) => !(o.payform || "").includes("з ПДВ"))),
      with: g(cofs.filter((o) => (o.payform || "").includes("з ПДВ"))),
    };
  }

  // лічильники для барів
  const co = vc?.offers ?? [];
  const ccFull = co.filter((o) => o.load_type === "full").length;
  const ccPart = co.filter((o) => o.load_type === "part").length;
  const allH = [...(data?.cargo?.history ?? []), ...(data?.lorry?.history ?? [])];
  const nowTs = Math.floor(Date.now() / 1000);
  const cnt = (days: number) => allH.filter((o) => !o.ts || o.ts >= nowTs - days * 86400).length;
  const w7 = cnt(7), w30 = cnt(30);
  const perNote: Record<Period, string> = {
    now: "поточний зріз ринку",
    week: "накопичена база за 7 днів (унікальні заявки)",
    month: "накопичена база за 30 днів (унікальні заявки)",
  };

  const off = lardiOff(data?.cargo) || lardiOff(data?.lorry);
  const mn = massMin ? Number(massMin) : null, mx = massMax ? Number(massMax) : null;
  const massNote = mn || mx ? ` · вага ${mn ?? "…"}–${mx ?? "…"} т` : "";
  const strictInfo = data ? `тільки точні збіги: ${data.route.from} → ${data.route.to}${massNote} · замовники ${cs.n}, перевізники ${ls.n}` : "";

  // Дублі клієнта: ЖИВІ заявки замовників на цьому маршруті під нашу вагу —
  // клієнт часто дзвонить кільком експедиторам одразу. 5+ дублів → перевізники
  // уникають вантажу; корисно виставити свою заявку найдорожчою.
  const dupes = (data?.cargo?.offers ?? []).filter((o) => {
    if (mn && (!o.mass || o.mass < mn - 1)) return false;
    if (mx && (!o.mass || o.mass > mx + 1)) return false;
    return true;
  });

  // 🗺 Зонна карта КВП: рекомендована ставка за зоною області ВІДПРАВЛЕННЯ
  // (правило: з зеленої в червону — зелений тариф). Головний орієнтир, коли
  // пропозицій у Ларді немає; інакше — додаткова довідка.
  const zr = data?.zone_recommendation ?? null;
  const zoneColors: Record<string, string> = { green: "#16a34a", yellow: "#d97706", red: "#c8102e" };
  const ZoneBlock = ({ big }: { big?: boolean }) => {
    if (!zr) return null;
    const zc = zoneColors[zr.zone] ?? ACC;
    return (
      <div style={{ marginTop: 10, textAlign: big ? "center" : "left", background: `${zc}0d`, border: `1px solid ${zc}55`, borderLeft: `4px solid ${zc}`, borderRadius: 8, padding: big ? "12px 14px" : "9px 12px" }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          🗺 Зонна карта: зона <b style={{ color: zc }}>{zr.zone_label}</b> <span title={zr.zone_src}>({zr.zone_src})</span> · {zr.tonnage}
          {zr.short_haul && <b style={{ color: ACC }}> · ×1.5 коротке плече (≤100 км)</b>}
        </div>
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table className="data-table compact" style={{ fontSize: big ? 13 : 12, margin: big ? "0 auto" : undefined, width: big ? "auto" : "100%" }}>
            <thead><tr><th style={{ textAlign: "left" }}>Авто</th><th style={{ textAlign: "right" }}>грн/км</th><th style={{ textAlign: "right" }}>Ціна рейсу</th></tr></thead>
            <tbody>
              {(zr.options ?? []).map((o) => (
                <tr key={o.tonnage} style={o.selected ? { background: `${zc}18`, fontWeight: 700 } : undefined}>
                  <td style={{ textAlign: "left" }}>{o.selected ? "🚚 " : ""}{o.tonnage}</td>
                  <td style={{ textAlign: "right", color: zc, fontWeight: o.selected ? 800 : 600 }}>
                    {o.per_km_min === o.per_km_max ? o.per_km_min : `${o.per_km_min}–${o.per_km_max}`}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {o.total_min ? (o.total_min === o.total_max ? `${fmt(o.total_min)} грн` : `${fmt(o.total_min)} – ${fmt(o.total_max ?? o.total_min)} грн`) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5 }}>
          {zr.from_area ?? "?"} → {zr.to_area ?? "?"}{zr.distance_km ? ` · ≈${fmt(zr.distance_km)} км` : ""} · правило: тариф за зоною ВІДПРАВЛЕННЯ (з зеленої в червону — зелений тариф){zr.short_haul ? " · тариф ×1.5, бо плече ≤100 км" : ""} · 🚚 = під вашу вагу
        </div>
      </div>
    );
  };

  const segBtn = (active: boolean): React.CSSProperties => ({
    padding: "7px 13px", borderRadius: 8, border: "1px solid var(--border)",
    background: active ? ACC : "var(--card-bg)", color: active ? "#fff" : "var(--text)",
    fontSize: 13, cursor: "pointer", fontWeight: active ? 700 : 500,
  });

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">⚡ Ставки за напрямком</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => { setView("route"); setShowStats(false); }}
            style={{ padding: "7px 14px", borderRadius: 10, border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700, fontSize: 13,
              background: view === "route" && !showStats ? ACC : "var(--card-bg)", color: view === "route" && !showStats ? "#fff" : "var(--text)" }}>
            🛣 Маршрут
          </button>
          <button onClick={() => { setView("cities"); setShowStats(false); }}
            style={{ padding: "7px 14px", borderRadius: 10, border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700, fontSize: 13,
              background: view === "cities" && !showStats ? ACC : "var(--card-bg)", color: view === "cities" && !showStats ? "#fff" : "var(--text)" }}>
            🏙 Ціни по місту
          </button>
          <button onClick={() => { setView("carriers"); setShowStats(false); }}
            style={{ padding: "7px 14px", borderRadius: 10, border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700, fontSize: 13,
              background: view === "carriers" && !showStats ? ACC : "var(--card-bg)", color: view === "carriers" && !showStats ? "#fff" : "var(--text)" }}>
            🚚 Перевізники
          </button>
          {isAdmin && (
            <button onClick={() => setShowStats((v) => !v)}
              style={{ padding: "7px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              {showStats ? "← до інструмента" : "📊 статистика"}
            </button>
          )}
        </div>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "-8px 0 16px" }}>
        {view === "cities"
          ? "База цін, вантажників і контактів по містах — ведеться менеджерами (заміна ТГ-скритника). Пошук за містом, додавайте свої записи."
          : view === "carriers"
            ? "Перевізники з нашої CRM: контакти з успішних угод за 12 міс (без гео/таргет-міток = не клієнт). Пошук по місту — за згадкою в маршруті угоди."
            : "Маршрут → ціни замовників і перевізників: зведення, грн/т, грн/км і повний список пропозицій. Дані Lardi-Trans."}
      </p>

      {showStats ? <StatsView /> : view === "cities" ? <CityInfoView /> : view === "carriers" ? <CarriersView /> : (
        <>
          {noToken && (
            <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${ACC}` }}>
              ⚠️ Токен Lardi не заданий на сервері (`LARDI_API_TOKEN`) — пошук не працюватиме.
            </div>
          )}

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <TownField label="Звідки" placeholder="місто відправлення" text={frmText} setText={(v) => { setFrmText(v); setFrm(null); }} picked={frm} onPick={(t) => { setFrm(t); setFrmText(t.name); }} />
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button onClick={swap} title="Поміняти місцями"
                  style={{ padding: "10px 14px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: ACC, cursor: "pointer", fontSize: 15 }}>⇄</button>
              </div>
              <TownField label="Куди" placeholder="місто призначення" text={toText} setText={(v) => { setToText(v); setTo(null); }} picked={to} onPick={(t) => { setTo(t); setToText(t.name); }} />
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
              <Fld label="Вага від, т"><input value={massMin} onChange={(e) => setMassMin(e.target.value)} type="number" min={0} step={0.5} placeholder="20" style={inp} /></Fld>
              <Fld label="Вага до, т"><input value={massMax} onChange={(e) => setMassMax(e.target.value)} type="number" min={0} step={0.5} placeholder="22" style={inp} /></Fld>
              {bodyTypes.length > 0 && (
                <Fld label="Тип кузова">
                  <select value={bodyId} onChange={(e) => setBodyId(e.target.value)} style={{ ...inp, minWidth: 170 }}>
                    <option value="">будь-який</option>
                    {bodyTypes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Fld>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
              <button onClick={run} disabled={loading}
                style={{ background: ACC, color: "#fff", border: 0, borderRadius: 9, padding: "11px 20px", fontSize: 15, fontWeight: 600, cursor: loading ? "default" : "pointer", opacity: loading ? 0.55 : 1 }}>
                Аналіз
              </button>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                {frm && to ? "готово до аналізу" : "введіть міста (можна без підказок)"}
              </span>
            </div>
          </div>

          {loading && <div className="chart-card" style={{ marginBottom: 16 }}><span className="loading-text">⏳ Збираю пропозиції з Lardi…</span></div>}
          {error && <div className="chart-card" style={{ marginBottom: 16, color: "#dc2626", fontSize: 14 }}>{error}</div>}

          {data && !loading && (
            <>
              {/* Дублі клієнта на маршруті */}
              {dupes.length > 0 && (
                <div className="chart-card" style={{ marginBottom: 16, borderLeft: `4px solid ${dupes.length >= 5 ? "#dc2626" : dupes.length >= 2 ? "#d97706" : "#16a34a"}` }}>
                  <b>📎 Заявки на цьому маршруті під вашу вагу: {dupes.length}</b>
                  {dupes.length >= 5
                    ? <span style={{ color: "#dc2626", fontWeight: 700 }}> — 5+ дублів! Перевізники уникають таких вантажів, клієнт малоцільовий.</span>
                    : dupes.length >= 2
                      ? <span style={{ color: "#b45309" }}> — можливі дублі (клієнт міг обдзвонити кількох експедиторів). Щоб перехопити перевізника — став свою заявку найдорожчою.</span>
                      : null}
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
                    {dupes.slice(0, 6).map((o, i) => (
                      <span key={i} style={{ marginRight: 12 }}>
                        {o.company || "—"}: {o.total ? `${fmt(o.total)} ${o.currency}` : "договірна"}{o.mass ? ` · ${o.mass} т` : ""}
                      </span>
                    ))}
                    {dupes.length > 6 ? `… і ще ${dupes.length - 6}` : ""}
                  </div>
                </div>
              )}

              {/* Період */}
              <div className="chart-card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>Період:</span>
                <button style={segBtn(period === "now")} onClick={() => setPeriod("now")}>Зараз</button>
                <button style={segBtn(period === "week")} onClick={() => setPeriod("week")}>За тиждень{w7 ? ` (${w7})` : ""}</button>
                <button style={segBtn(period === "month")} onClick={() => setPeriod("month")}>За місяць{w30 ? ` (${w30})` : ""}</button>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{perNote[period]}</span>
              </div>

              {off && period === "now" && (
                <div className="chart-card" style={{ marginBottom: 16, borderLeft: `3px solid ${ACC}`, background: "rgba(200,16,46,0.05)" }}>
                  ⚠️ <b>Пошук Lardi тимчасово недоступний.</b> Закінчився пакет «Розширений доступ до API» на акаунті Lardi — потрібно продовжити (це не помилка інструмента). Поки що спробуйте період <b>«За тиждень»</b> або <b>«За місяць»</b> — там працює наш архів.
                </div>
              )}

              {/* Тип завантаження */}
              <div className="chart-card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>Тип завантаження:</span>
                <button style={segBtn(cls === "full")} onClick={() => setCls("full")}>Ціла машина ({ccFull})</button>
                <button style={segBtn(cls === "part")} onClick={() => setCls("part")}>Догруз ({ccPart})</button>
                <button style={segBtn(cls === "all")} onClick={() => setCls("all")}>Усі</button>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>ділимо за вагою: ≥18 т — ціла машина, менше — догруз</span>
              </div>

              {/* Орієнтир */}
              <div className="chart-card" style={{ marginBottom: 16, textAlign: "center", background: "rgba(200,16,46,0.04)", border: "1px solid rgba(200,16,46,0.18)" }}>
                {bandMeds.length || perKm ? (
                  <>
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                      Орієнтир за напрямком {data.route.from} → {data.route.to}{dist ? ` · ≈${fmt(dist)} км` : ""} · <b>{CLABEL[cls]}</b>
                    </div>
                    {bandMeds.length > 0 && (
                      <div style={{ fontSize: 28, fontWeight: 800, color: ACC }}>
                        {Math.min(...bandMeds) === Math.max(...bandMeds) ? fmt(bandMeds[0]) : `${fmt(Math.min(...bandMeds))} – ${fmt(Math.max(...bandMeds))}`} грн
                      </div>
                    )}
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                      {cs.median ? `замовники ~${fmt(cs.median)} грн` : ""}{cs.median && ls.median ? " · " : ""}{ls.median ? `перевізники ~${fmt(ls.median)} грн` : ""}
                    </div>
                    {perKm && (
                      <div style={{ color: "#9c2b20", fontSize: 15, marginTop: 6 }}>
                        Рекомендована ставка: <b>{fmt(perKm)} грн/км</b>{dist ? <> ≈ <b>{fmt(Math.round(perKm * dist))} грн</b> за рейс</> : null}
                        <span style={{ color: "var(--text-muted)" }}> (за {perKmSrc})</span>
                      </div>
                    )}
                    {vat && (vat.without.total || vat.with.total) && (
                      <div style={{ fontSize: 14, marginTop: 4, color: "#9c2b20" }}>
                        {vat.without.total ? <>Без ПДВ: <b>{fmt(vat.without.total)} грн</b>{vat.without.per_km ? ` (${fmt(vat.without.per_km)} грн/км)` : ""} <span style={{ color: "var(--text-muted)" }}>· {vat.without.n}</span></> : null}
                        {vat.without.total && vat.with.total ? " · " : ""}
                        {vat.with.total ? <>З ПДВ: <b>{fmt(vat.with.total)} грн</b>{vat.with.per_km ? ` (${fmt(vat.with.per_km)} грн/км)` : ""} <span style={{ color: "var(--text-muted)" }}>· {vat.with.n}</span></> : null}
                      </div>
                    )}
                    <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>{strictInfo}</div>
                    <div style={{ textAlign: "left", fontSize: 13, lineHeight: 1.45, background: "var(--card-bg)", border: "1px solid rgba(200,16,46,0.25)", borderLeft: `3px solid ${ACC}`, borderRadius: 8, padding: "9px 12px", marginTop: 12 }}>
                      💡 <b style={{ color: ACC }}>Як читати:</b> «Замовники» — це здебільшого <b>експедиторські компанії</b>, які шукають перевізника за своєю (часто заниженою) ціною. За такою ставкою перевізника зазвичай <b>не знайти</b>. Тому орієнтуйся на <b>максимум</b> і на ставки перевізників, а клієнту став ціну <b>вище за максимум</b> — щоб під неї реально знайти транспорт і закласти свою маржу.
                    </div>
                    <ZoneBlock />
                  </>
                ) : (
                  <>
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Немає точних збігів для рекомендації ({strictInfo}). Повна статистика — нижче.</div>
                    <ZoneBlock big />
                    {settings && dist ? (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Заявок за вашим напрямком немає — орієнтуйтесь на базовий тариф:</div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: ACC, marginTop: 4 }}>
                          {fmt(settings.ratesFallbackFullPerKm)} грн/км ≈ {fmt(Math.round(settings.ratesFallbackFullPerKm * dist))} грн
                          <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400 }}> · ціла машина</span>
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "#9c2b20", marginTop: 2 }}>
                          {fmt(settings.ratesFallbackPartPerKm)} грн/км ≈ {fmt(Math.round(settings.ratesFallbackPartPerKm * dist))} грн
                          <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400 }}> · догруз</span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>базовий тариф UTS (редагується в Налаштуваннях) × ≈{fmt(dist)} км</div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              {/* Картки-зведення */}
              <div className="chart-grid">
                <StatCard title="Замовники (вантажі)" dot={CARGO_DOT} side={vc} offers={strictForSide(vc, false)} />
                <StatCard title="Перевізники (транспорт)" dot={LORRY_DOT} side={vl} offers={strictForSide(vl, true)} note="тип завантаження не ділимо (вільний транспорт)" />
              </div>

              {/* Повні таблиці */}
              <OfferTable title="Замовники (вантажі)" side={vc} cls={cls} />
              <OfferTable title="Перевізники (транспорт)" side={vl} cls="all" />
            </>
          )}
        </>
      )}
    </>
  );
}

const inp: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 11px", background: "var(--card-bg)",
  border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 15, outline: "none",
};

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: "1 1 120px", minWidth: 110, maxWidth: 190 }}>
      <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", margin: "0 0 4px 2px" }}>{label}</label>
      {children}
    </div>
  );
}

function TownField({ label, placeholder, text, setText, picked, onPick }: {
  label: string; placeholder: string; text: string; setText: (v: string) => void;
  picked: Town | null; onPick: (t: Town) => void;
}) {
  const [opts, setOpts] = useState<Town[]>([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (picked) { setOpts([]); return; }
    const q = text.trim();
    if (q.length < 2) { setOpts([]); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { fetchTowns(q).then((r) => { setOpts(r); setIdx(-1); }).catch(() => setOpts([])); }, 220);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text, picked]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={box} style={{ flex: "1 1 220px", position: "relative", minWidth: 190 }}>
      <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", margin: "0 0 4px 2px" }}>{label}</label>
      <input value={text} placeholder={placeholder} autoComplete="off" style={inp}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !opts.length) return;
          if (e.key === "ArrowDown") { setIdx((i) => Math.min(i + 1, opts.length - 1)); e.preventDefault(); }
          else if (e.key === "ArrowUp") { setIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
          else if (e.key === "Enter" && idx >= 0) { onPick(opts[idx]); setOpen(false); e.preventDefault(); }
        }} />
      {open && !picked && opts.length > 0 && (
        <div style={{ position: "absolute", zIndex: 30, left: 0, right: 0, top: "100%", background: "var(--card-bg)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 9px 9px", maxHeight: 260, overflow: "auto", boxShadow: "0 8px 20px rgba(20,30,45,.10)" }}>
          {opts.map((it, i) => (
            <div key={it.id} onClick={() => { onPick(it); setOpen(false); }}
              style={{ padding: "8px 11px", cursor: "pointer", fontSize: 14, borderTop: "1px solid var(--border)", background: i === idx ? "rgba(200,16,46,0.08)" : "transparent" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(200,16,46,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = i === idx ? "rgba(200,16,46,0.08)" : "transparent")}>
              <b>{it.name}</b>{it.area ? <span style={{ color: ACC }}> {it.area}</span> : null} <small style={{ color: "var(--text-muted)" }}>{it.country || ""}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ title, dot, side, offers, note }: { title: string; dot: string; side?: RateSide; offers: RateOffer[]; note?: string }) {
  if (!side || side.error) {
    const msg = lardiOff(side)
      ? "Доступ до пошуку Lardi тимчасово вимкнено (потрібно продовжити пакет «Розширений доступ до API»). Зверніться до адміністратора. Історія «За тиждень / За місяць» може ще працювати."
      : side?.error ? side.error + (side.detail ? ": " + side.detail : "") : "немає даних";
    return (
      <div className="chart-card">
        <h2 className="chart-title" style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: dot }} />{title}</h2>
        <p style={{ color: "#dc2626", fontSize: 13, margin: 0 }}>{msg}</p>
      </div>
    );
  }
  const st = statsObj(offers);
  const u = st.uah, pt = st.uah_per_ton, pk = st.uah_per_km;
  const cm: Record<string, number> = {}, bm: Record<string, number> = {};
  for (const o of offers) { const c = o.cargo || "—"; cm[c] = (cm[c] ?? 0) + 1; for (const b of o.bodies ?? []) bm[b] = (bm[b] ?? 0) + 1; }
  const top = (obj: Record<string, number>) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const tag: React.CSSProperties = { display: "inline-block", background: "var(--bg-subtle, rgba(127,127,127,0.06))", border: "1px solid var(--border)", borderRadius: 20, padding: "3px 10px", fontSize: 12, margin: "3px 4px 0 0", color: "var(--text-muted)" };
  const others = Object.entries(st.other_currencies).filter(([, v]) => v);
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: dot }} />{title}
      </h2>
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
        {st.count} пропозицій <span style={{ ...tag, background: "rgba(200,16,46,0.08)", color: "#b1432c", borderColor: "rgba(200,16,46,0.25)" }}>точний маршрут</span>
        {st.negotiable ? ` · ${st.negotiable} «договірна»` : ""}
        {u?.dropped ? <span title="ціни, що сильно вибиваються — не враховані в статистиці"> · відкинуто {u.dropped} аномальних</span> : null}
        {note ? <><br /><span style={{ fontSize: 12 }}>{note}</span></> : null}
      </div>
      <div style={{ fontSize: 25, fontWeight: 700, margin: "6px 0", color: ACC }}>
        {u ? fmt(u.median) : "—"} <small style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400 }}>грн · медіана</small>
      </div>
      {u ? (
        <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "4px 14px", fontSize: 14, margin: "8px 0" }}>
          <span>мін</span><b>{fmt(u.min)} грн</b>
          <span>середня</span><b>{fmt(u.avg)} грн</b>
          <span>макс</span><b>{fmt(u.max)} грн</b>
          {pt ? <><span>грн/тонна</span><b>{fmt(pt.median)} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({fmt(pt.min)}–{fmt(pt.max)})</span></b></> : null}
          {pk ? <><span>грн/км</span><b>{fmt(pk.median)} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({fmt(pk.min)}–{fmt(pk.max)})</span></b></> : null}
        </div>
      ) : (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>точних ставок у грн немає (усе «договірна»)</div>
      )}
      {others.length > 0 && <div>{others.map(([k, v]) => <span key={k} style={tag}>{k}: медіана {fmt(v!.median)} (n{v!.n})</span>)}</div>}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 13, padding: "4px 0" }}>вантажі / кузови у вибірці</summary>
        <div style={{ marginTop: 6 }}>
          {top(cm).map(([k, v]) => <span key={k} style={tag}>{k} ×{v}</span>)}
          {Object.keys(bm).length ? <br /> : null}
          {top(bm).map(([k, v]) => <span key={k} style={tag}>{k} ×{v}</span>)}
        </div>
      </details>
    </div>
  );
}

function PhoneCell({ o }: { o: RateOffer }) {
  if (!o.phones?.length) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <>
      {o.phones.map((p, i) => (
        <div key={i}>
          <a href={`tel:${p.n}`} style={{ color: ACC, whiteSpace: "nowrap", fontWeight: 600, textDecoration: "none" }}>{p.n}</a>
          {p.m?.length ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> {p.m.map((x) => (x === "VIBER" ? "Viber" : x === "TELEGRAM" ? "TG" : String(x))).join("/")}</span> : null}
        </div>
      ))}
    </>
  );
}

function OfferRows({ items }: { items: RateOffer[] }) {
  return (
    <div style={{ maxHeight: 520, overflow: "auto", border: "1px solid var(--border)", borderRadius: 10, marginTop: 8 }}>
      <table className="data-table compact" style={{ fontSize: 13 }}>
        <thead><tr><th>Вантаж</th><th>Компанія</th><th>Телефон</th><th>Маршрут</th><th>Вага</th><th>Ставка</th><th>Оплата</th><th>грн/т</th><th>грн/км</th><th>Кузов</th><th>Дата</th></tr></thead>
        <tbody>
          {items.map((s, i) => (
            <tr key={`${s.id}-${i}`}>
              <td>{s.cargo || "—"}{s.note ? <><br /><span style={{ color: "var(--text-muted)" }}>{s.note}</span></> : null}</td>
              <td>{s.company || <span style={{ color: "var(--text-muted)" }}>—</span>}{s.face ? <><br /><span style={{ color: "var(--text-muted)" }}>{s.face}</span></> : null}</td>
              <td><PhoneCell o={s} /></td>
              <td style={{ color: "var(--text-muted)" }}>{[s.from, s.to].filter(Boolean).join(" → ") || "—"}</td>
              <td>{s.mass ? `${fmt(s.mass)} т` : "—"}</td>
              <td>{s.total ? <><b>{fmt(s.total)}</b> {s.currency || ""}</> : <span style={{ color: "var(--text-muted)" }}>договірна</span>}</td>
              <td style={{ color: "var(--text-muted)" }}>{s.payform || "—"}</td>
              <td>{s.per_ton ? fmt(s.per_ton) : "—"}</td>
              <td>{s.per_km ? fmt(s.per_km) : "—"}</td>
              <td style={{ color: "var(--text-muted)" }}>{(s.bodies || []).join(", ")}</td>
              <td style={{ color: "var(--text-muted)" }}>{s.date || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OfferTable({ title, side, cls }: { title: string; side?: RateSide; cls: Cls }) {
  if (!side || side.error) return null;
  const all = (side.offers ?? []).filter((o) => cls === "all" || o.load_type === cls || o.load_type === "unknown");
  if (!all.length) return null;
  const priced = all.filter((o) => o.total), nego = all.filter((o) => !o.total);
  return (
    <details className="chart-card" open style={{ marginTop: 16 }}>
      <summary style={{ cursor: "pointer", fontSize: 14 }}>
        <b>{title}</b> — {priced.length} зі ставкою{nego.length ? `, ${nego.length} договірних` : ""} (деталі)
      </summary>
      {priced.length ? <OfferRows items={priced} /> : <div style={{ color: "var(--text-muted)", marginTop: 8, fontSize: 13 }}>немає пропозицій зі ставкою у цьому типі</div>}
      {nego.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 13 }}>Договірні (без ставки) — {nego.length}</summary>
          <OfferRows items={nego} />
        </details>
      )}
    </details>
  );
}

function StatsView() {
  const [d, setD] = useState<RatesUsageStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetchRatesStats(30).then(setD).catch((e) => setErr(String(e?.response?.data?.error ?? e))); }, []);
  if (err) return <div className="chart-card">Помилка: {err}</div>;
  if (!d) return <p className="loading-text">Завантаження…</p>;
  const maxR = Math.max(1, ...d.by_day.map((x) => x.requests));
  return (
    <>
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <div className="kpi-card"><span className="kpi-value" style={{ color: ACC }}>{fmt(d.today_requests)}</span><span className="kpi-label">запитів сьогодні</span></div>
        <div className="kpi-card"><span className="kpi-value" style={{ color: ACC }}>{fmt(d.today_users)}</span><span className="kpi-label">користувачів сьогодні</span></div>
        <div className="kpi-card"><span className="kpi-value" style={{ color: ACC }}>{fmt(d.total_requests)}</span><span className="kpi-label">запитів за {d.days} дн.</span></div>
        <div className="kpi-card"><span className="kpi-value" style={{ color: ACC }}>{fmt(d.total_users)}</span><span className="kpi-label">користувачів</span></div>
      </div>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h2 className="chart-title">За днями</h2>
        <table className="data-table">
          <thead><tr><th>Дата</th><th style={{ textAlign: "right" }}>Запитів</th><th style={{ textAlign: "right" }}>Користувачів</th></tr></thead>
          <tbody>
            {d.by_day.length ? d.by_day.map((x) => (
              <tr key={x.date}>
                <td>{x.date}</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>
                  {fmt(x.requests)}
                  <span style={{ height: 8, background: ACC, borderRadius: 6, display: "inline-block", verticalAlign: "middle", marginLeft: 8, opacity: 0.85, width: Math.round((x.requests / maxR) * 120) }} />
                </td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(x.users)}</td>
              </tr>
            )) : <tr><td colSpan={3} style={{ color: "var(--text-muted)" }}>ще немає даних</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="chart-card">
        <h2 className="chart-title">Топ напрямків</h2>
        <table className="data-table">
          <thead><tr><th>Маршрут</th><th style={{ textAlign: "right" }}>Запитів</th></tr></thead>
          <tbody>
            {d.top_routes.length ? d.top_routes.map((x) => (
              <tr key={x.route}><td>{x.route}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(x.count)}</td></tr>
            )) : <tr><td colSpan={2} style={{ color: "var(--text-muted)" }}>—</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

const CAT_META: Record<CityInfoCategory, { label: string; icon: string }> = {
  price: { label: "Ціна", icon: "💰" },
  loaders: { label: "Вантажники", icon: "💪" },
  contact: { label: "Контакт", icon: "📇" },
};

/** «Ціни по місту» — редагована менеджерами база цін/вантажників/контактів. */
function CityInfoView() {
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<CityInfoEntry[] | null>(null);
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState({ city: "", category: "price" as CityInfoCategory, title: "", phone: "", price: "", comment: "" });
  const [saving, setSaving] = useState(false);
  const me = (() => { try { const t = localStorage.getItem("token"); if (!t) return { id: 0, admin: false }; const p = JSON.parse(atob(t.split(".")[1] ?? "")); return { id: p.userId as number, admin: p.role !== "manager" }; } catch { return { id: 0, admin: false }; } })();

  useEffect(() => {
    setEntries(null);
    const t = setTimeout(() => { fetchCityInfo(q.trim() || undefined).then(setEntries).catch(() => setEntries([])); }, 250);
    return () => clearTimeout(t);
  }, [q, reload]);

  const add = async () => {
    if (!form.city.trim()) return;
    setSaving(true);
    try {
      await addCityInfo({ city: form.city.trim(), category: form.category, title: form.title, phone: form.phone, price: form.price, comment: form.comment });
      setForm({ ...form, title: "", phone: "", price: "", comment: "" });
      setReload((n) => n + 1);
    } finally { setSaving(false); }
  };

  const byCity = new Map<string, CityInfoEntry[]>();
  for (const e of entries ?? []) { const k = e.city; (byCity.get(k) ?? byCity.set(k, []).get(k)!).push(e); }

  return (
    <>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h2 className="chart-title">➕ Додати запис</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 160px", minWidth: 150 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Місто *</label>
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Харків" style={inp} />
          </div>
          <div style={{ flex: "0 1 150px", minWidth: 130 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Категорія</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as CityInfoCategory })} style={inp}>
              {Object.entries(CAT_META).map(([k, m]) => <option key={k} value={k}>{m.icon} {m.label}</option>)}
            </select>
          </div>
          <div style={{ flex: "1 1 170px", minWidth: 150 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Назва/хто це</label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="вивантаження / Іван (кран)" style={inp} />
          </div>
          <div style={{ flex: "1 1 150px", minWidth: 140 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Телефон</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="067…" style={inp} />
          </div>
          <div style={{ flex: "1 1 140px", minWidth: 120 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Ціна</label>
            <input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="2000 грн / 25 грн/км" style={inp} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} placeholder="Коментар (необовʼязково)" style={{ ...inp, flex: 1, minWidth: 220 }} />
          <button onClick={add} disabled={saving || !form.city.trim()}
            style={{ background: !form.city.trim() || saving ? "#94a3b8" : ACC, color: "#fff", border: 0, borderRadius: 9, padding: "10px 20px", fontWeight: 600, cursor: !form.city.trim() || saving ? "default" : "pointer" }}>
            {saving ? "Збереження…" : "Додати"}
          </button>
        </div>
      </div>

      <div className="chart-card">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>🏙 База по містах</h2>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Пошук міста…" style={{ ...inp, maxWidth: 260 }} />
        </div>
        {entries === null ? (
          <p className="loading-text">Завантаження…</p>
        ) : entries.length === 0 ? (
          <p className="loading-text">{q ? "Нічого не знайдено за цим містом." : "База поки порожня — додайте перший запис вище."}</p>
        ) : (
          [...byCity.entries()].map(([city, list]) => (
            <div key={city} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>{city}</div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table compact">
                  <thead><tr><th></th><th>Назва</th><th>Телефон</th><th>Ціна</th><th>Коментар</th><th>Автор</th><th>Дата</th><th></th></tr></thead>
                  <tbody>
                    {list.map((e) => (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{CAT_META[e.category].icon} {CAT_META[e.category].label}</td>
                        <td>{e.title || "—"}</td>
                        <td>{e.phone ? <a href={`tel:${e.phone}`} style={{ color: ACC, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>{e.phone}</a> : "—"}</td>
                        <td style={{ fontWeight: 600 }}>{e.price || "—"}</td>
                        <td style={{ color: "var(--text-muted)" }}>{e.comment || "—"}</td>
                        <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{e.authorName || "—"}</td>
                        <td style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap" }}>{e.updatedAt}</td>
                        <td>
                          {(me.admin || e.authorUserId === me.id) && (
                            <button onClick={() => { deleteCityInfo(e.id).then(() => setReload((n) => n + 1)); }} title="Видалити"
                              style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/** 🚚 Перевізники з CRM — пошук по місту (згадка в маршруті успішної угоди). */
function CarriersView() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CrmCarrier[] | null>(null);
  const [processed, setProcessed] = useState(0);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRows(null); return; }
    const t = setTimeout(() => {
      fetchCarriers(s).then((r) => { setRows(r.carriers); setProcessed(r.processed); }).catch(() => setRows([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="chart-card">
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <h2 className="chart-title" style={{ marginBottom: 0 }}>🚚 Пошук перевізників по місту</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Місто (напр. Київ)…" style={{ ...inp, maxWidth: 280 }} autoFocus />
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
        Тип запиту: по місту — покажемо контакти перевізників з усіх успішних угод, де місто згадується в маршруті. {processed ? `Опрацьовано угод: ${processed.toLocaleString("uk-UA")}.` : "База наповнюється щогодини."}
      </p>
      {rows === null ? (
        <p className="loading-text">Введіть місто (мін. 2 літери).</p>
      ) : rows.length === 0 ? (
        <p className="loading-text">Перевізників за цим містом (ще) не знайдено — база наповнюється поступово.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table compact">
            <thead><tr><th>Перевізник</th><th>Телефон</th><th style={{ textAlign: "right" }}>Перевезень</th><th>Останнє</th><th>Маршрути (приклади)</th></tr></thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={`${c.phone}-${i}`}>
                  <td style={{ fontWeight: 600 }}>{c.name || "—"}</td>
                  <td><a href={`tel:${c.phone}`} style={{ color: ACC, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>{c.phone}</a></td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{c.trips}</td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--text-muted)" }}>{c.lastTrip || "—"}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{(c.routes || []).slice(0, 3).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
