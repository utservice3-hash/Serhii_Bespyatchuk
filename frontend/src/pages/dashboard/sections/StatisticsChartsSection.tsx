import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea, Brush,
} from "recharts";
import { fetchStatsSeries, saveStatsManual, type StatsSeriesResp, type StatsSeries } from "../../../api";
import { InfoHint } from "../widgets";

const SEAM = "2026-07-01";
// dataviz категорійна палітра (фіксований порядок; компанія завжди [0]). CVD-safe рампи.
const COLORS = ["#2f6fdb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d"];
const MUTED = "var(--text-muted)";

type Metric = { key: string; block: string; label: string; unit?: string; monthOnly?: boolean; weekOnly?: boolean; manual?: boolean; hint?: string; seamHint?: string; unitScope?: string };
type Cat = { key: string; icon: string; label: string; metrics: Metric[]; manualForm?: boolean; depstats?: boolean };

const SEAM_CARS = "До лип 2026 — ручний лічильник таблиці; з лип 2026 — точний підрахунок CRM (тому рівень міг зміститись).";
const CALLS_HINT = "Результативні дзвінки Ringostat (billsec>0); історія до лип 2026 — з таблиці (визначення могло відрізнятись).";
const FINHR_HINT = "Історія з таблиці; оновиться після внесення через депстат-ввід.";
const DIR_HINT = "Напрямок (unit-серія). Історія з таблиці; CRM-продовження по sales_channel — у розробці (де ще нема — показуємо історію до шва). Лише для КВП/адміна.";

const CATS: Cat[] = [
  { key: "money", icon: "💰", label: "Гроші", metrics: [
    { key: "avg_check", block: "sales", label: "Середній чек", unit: "₴", hint: "виручка успіху ÷ успішні угоди", seamHint: SEAM_CARS },
    { key: "revenue_success", block: "sales", label: "Дохід (успіх)", unit: "₴", hint: "успішні угоди (142) за датою закриття, signed" },
    { key: "payment_received", block: "sales", label: "Оплата отримана", unit: "₴", hint: "received = success ⊎ paidOnly" },
    { key: "cash_deals_sum", block: "sales", label: "Готівкові", unit: "₴" },
  ] },
  { key: "auto", icon: "🚚", label: "Авто", metrics: [
    { key: "cars_success", block: "sales", label: "Успішні", seamHint: SEAM_CARS },
    { key: "cars_delivered", block: "sales", label: "Поставлені", hint: "company включає поставки поза 6 командами (~0.5%)", seamHint: SEAM_CARS },
  ] },
  { key: "leads", icon: "📈", label: "Ліди й канали", metrics: [
    { key: "ad_leads", block: "marketing", label: "Ліди з реклами" },
    { key: "lg_transfers", block: "marketing", label: "Прорахунки лідгенів" },
  ] },
  { key: "clients", icon: "👥", label: "Клієнти", metrics: [
    { key: "repeat_clients_active", block: "logistics", label: "Постійні в роботі", hint: "постійний = has_prior (≥1 попередня виграна)" },
    { key: "repeat_clients_cars", block: "logistics", label: "Машини постійних" },
    { key: "repeat_clients_sum", block: "logistics", label: "Сума постійних", unit: "₴" },
    { key: "repeat_avg_check", block: "logistics", label: "Чек постійних", unit: "₴" },
  ] },
  { key: "calls", icon: "☎️", label: "Дзвінки", metrics: [
    { key: "calls", block: "sales", label: "Результативні", hint: CALLS_HINT },
  ] },
  { key: "plan", icon: "🎯", label: "План / факт", metrics: [
    { key: "plan_execution", block: "sales", label: "% виконання", unit: "%", monthOnly: true, hint: "received-факт ÷ план (payment_amount). Тижневих планів нема." },
  ] },
  { key: "intl", icon: "🌍", label: "Напрямки", metrics: [
    // Кожен напрямок — unit-серія (scope_type='unit'). Історія з таблиці; CRM-обчислювачі
    // напрямків у хвості 2b → показуємо історію (мітка «історія до…»), не порожнечу.
    { key: "intl_delivered_sum", block: "intl", unitScope: "Міжнародка", label: "Міжнародка: дохід", unit: "₴", hint: DIR_HINT },
    { key: "intl_delivered_cars", block: "intl", unitScope: "Міжнародка", label: "Міжнародка: авто", hint: DIR_HINT },
    { key: "intl_avg_check", block: "intl", unitScope: "Міжнародка", label: "Міжнародка: чек", unit: "₴", hint: DIR_HINT },
    { key: "tender_requests", block: "tenders", unitScope: "Тендери", label: "Тендери: заявки", hint: DIR_HINT },
    { key: "tender_cars", block: "tenders", unitScope: "Тендери", label: "Тендери: авто", hint: DIR_HINT },
    { key: "tender_commission", block: "tenders", unitScope: "Тендери", label: "Тендери: комісія", unit: "₴", hint: DIR_HINT },
    { key: "lgintl_transfers", block: "lgintl", unitScope: "ЛідгенМіжн", label: "ЛідгенМіжн: передачі", hint: DIR_HINT },
    { key: "lgintl_revenue", block: "lgintl", unitScope: "ЛідгенМіжн", label: "ЛідгенМіжн: дохід", unit: "₴", hint: DIR_HINT },
    { key: "cars_delivered_all", block: "logistics", unitScope: "ВЛТ", label: "ВЛТ: поставлені авто", weekOnly: true, hint: DIR_HINT },
    { key: "repeat_clients_sum", block: "logistics", unitScope: "ВЛТ", label: "ВЛТ: сума постійних", unit: "₴", weekOnly: true, hint: DIR_HINT },
  ] },
  { key: "finance", icon: "💵", label: "Фінанси", depstats: true, metrics: [
    { key: "cashflow", block: "finance", label: "Cash flow", unit: "₴", hint: FINHR_HINT },
    { key: "acted_income", block: "finance", label: "Дохід (акт)", unit: "₴", hint: FINHR_HINT },
    { key: "receivables", block: "finance", label: "Дебіторка", unit: "₴", hint: FINHR_HINT },
    { key: "expenses_total", block: "finance", label: "Витрати загальні", unit: "₴", hint: FINHR_HINT },
  ] },
  { key: "hr", icon: "🧑‍💼", label: "HR", depstats: true, metrics: [
    { key: "hr_headcount", block: "hr", label: "Штат", hint: FINHR_HINT },
    { key: "hr_hired", block: "hr", label: "Найнято", hint: FINHR_HINT },
    { key: "hr_fired", block: "hr", label: "Звільнено", hint: FINHR_HINT },
    { key: "hr_turnover_total", block: "hr", label: "Плинність", unit: "%", hint: FINHR_HINT },
  ] },
  { key: "manual", icon: "✍️", label: "Ручні", manualForm: true, metrics: [
    { key: "budget_yalogist", block: "marketing", label: "Бюджет Ялогист", unit: "₴", manual: true },
    { key: "budget_uts", block: "marketing", label: "Бюджет ЮТС", unit: "₴", manual: true },
    { key: "budget_evrazia", block: "marketing", label: "Бюджет Эвразия", unit: "₴", manual: true },
    { key: "lg_budget", block: "marketing", label: "Бюджет лідгену", unit: "₴", manual: true },
    { key: "lg_headcount", block: "marketing", label: "Штат лідгену", manual: true },
    { key: "tender_requests", block: "tenders", label: "Тендер: заявки", manual: true },
    { key: "tender_cars", block: "tenders", label: "Тендер: авто", manual: true },
  ] },
];

const fmt = (n: number, unit?: string) => {
  if (unit === "%") return Math.round(n) + "%";
  const r = Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + " млн" : Math.abs(n) >= 1e3 ? Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ") : String(Math.round(n));
  return unit === "₴" ? r + " ₴" : r;
};
const shortDate = (p: string) => { const [y, m, d] = p.split("-"); return `${d}.${m}.${y.slice(2)}`; };
const RANGES: Record<string, number> = { "3м": 90, "6м": 180, "12м": 365, "Усе": 9999 };
const MIN_WIN = 3; // мінімальна ширина вікна брашу (≥4 точки) — щоб не з'їжджало в 2-точкову пряму
// Вікно [lo,hi] (індекси у ПОВНОМУ rows) для діапазону 3м/6м/12м/Усе.
function rangeWindow(rows: { period: string }[], range: string): { lo: number; hi: number } {
  const hi = rows.length - 1;
  if (hi < 0) return { lo: 0, hi: 0 };
  if (range === "Усе") return { lo: 0, hi };
  const cut = new Date(rows[hi].period); cut.setDate(cut.getDate() - RANGES[range]);
  const cs = cut.toISOString().slice(0, 10);
  let lo = rows.findIndex((r) => r.period >= cs); if (lo < 0) lo = 0;
  if (hi - lo < MIN_WIN) lo = Math.max(0, hi - MIN_WIN);
  return { lo, hi };
}

export default function StatisticsChartsSection({ role }: { role?: string }) {
  const [catKey, setCatKey] = useState("money");
  const cat = CATS.find((c) => c.key === catKey)!;
  const [metricKey, setMetricKey] = useState("avg_check");
  const metric = cat.metrics.find((m) => m.key === metricKey) ?? cat.metrics[0];
  const [gran, setGran] = useState<"day" | "week" | "month">("week");
  const [range, setRange] = useState("12м");
  const [resp, setResp] = useState<StatsSeriesResp | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Вікно брашу/зуму — індекси у ПОВНОМУ rows + key прив'язки (діапазон+довжина).
  // key потрібен, щоб при зміні діапазону/показника старе вікно не «прилипало».
  const [win, setWin] = useState<{ lo: number; hi: number; key: string } | null>(null);
  const [drag, setDrag] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });

  const effGran = metric.monthOnly ? "month" : metric.weekOnly ? "week" : gran; // напрямок без місячних (ВЛТ) → тиждень
  useEffect(() => {
    let alive = true; setResp(null); setHidden(new Set()); setWin(null);
    fetchStatsSeries({ block: metric.block, metric: metric.key, granularity: effGran, ...(metric.unitScope ? { unit: metric.unitScope } : {}) })
      .then((d) => alive && setResp(d)).catch(() => alive && setResp({ block: metric.block, metric: metric.key, granularity: effGran, seam: SEAM, crmAble: false, live: false, series: [] }));
    return () => { alive = false; };
  }, [metric.block, metric.key, effGran, metric.unitScope]);

  // усі періоди (вісь X) + рядки для recharts
  const { rows, seriesList } = useMemo(() => {
    if (!resp) return { rows: [] as any[], seriesList: [] as StatsSeries[] };
    const periods = new Set<string>();
    resp.series.forEach((s) => s.points.forEach((p) => periods.add(p.period)));
    const sorted = [...periods].sort();
    const map = new Map(sorted.map((p) => [p, { period: p } as any]));
    resp.series.forEach((s, i) => s.points.forEach((p) => { map.get(p.period)![`s${i}`] = p.value; }));
    return { rows: sorted.map((p) => map.get(p)!), seriesList: resp.series };
  }, [resp]);

  // Ключ прив'язки вікна: діапазон + к-ть точок. win застосовується ЛИШЕ коли ключ збігається —
  // інакше після зміни «3м/6м/12м/Усе» чи показника вертаємось на вікно діапазону.
  const winKey = `${range}:${rows.length}`;
  // Ефективне вікно [lo,hi] (індекси у ПОВНОМУ rows). Графік рендериться на ПОВНИХ rows,
  // а Brush контрольований через startIndex/endIndex — жодного перерізання data → нема петлі.
  const eff = useMemo(() => {
    if (!rows.length) return { lo: 0, hi: 0 };
    if (win && win.key === winKey) {
      let lo = Math.max(0, Math.min(win.lo, rows.length - 1));
      let hi = Math.max(0, Math.min(win.hi, rows.length - 1));
      if (hi < lo) { const t = lo; lo = hi; hi = t; }
      return { lo, hi };
    }
    return rangeWindow(rows, range);
  }, [rows, range, win, winKey]);

  const color = (i: number) => COLORS[i % COLORS.length];
  const visibleSeries = seriesList.map((s, i) => ({ s, i })).filter(({ s }) => !hidden.has(s.scopeKey));
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const isolate = (k: string) => setHidden(new Set(seriesList.map((s) => s.scopeKey).filter((x) => x !== k)));

  // статистика по ПЕРШІЙ видимій серії у вікні
  const stat = useMemo(() => {
    const first = visibleSeries[0]; if (!first || !rows.length) return null;
    const windowRows = rows.slice(eff.lo, eff.hi + 1);
    const key = `s${first.i}`;
    const pts = windowRows.filter((r) => r[key] != null).map((r) => ({ p: r.period, v: r[key] as number }));
    if (!pts.length) return null;
    const vals = pts.map((x) => x.v);
    const now = pts[pts.length - 1].v, avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const min = pts.reduce((a, b) => (b.v < a.v ? b : a)), max = pts.reduce((a, b) => (b.v > a.v ? b : a));
    const prev = pts.length > 1 ? pts[pts.length - 2].v : now;
    return { now, avg, min, max, delta: prev ? ((now - prev) / Math.abs(prev)) * 100 : 0 };
  }, [visibleSeries, rows, eff.lo, eff.hi]);

  const onDragEnd = () => {
    if (drag.a && drag.b && drag.a !== drag.b) {
      const ia = rows.findIndex((r) => r.period === drag.a), ib = rows.findIndex((r) => r.period === drag.b);
      let lo = Math.min(ia, ib), hi = Math.max(ia, ib);
      if (hi - lo < MIN_WIN) hi = Math.min(rows.length - 1, lo + MIN_WIN); // не даємо зуму зхлопнутись у 2 точки
      setWin({ lo, hi, key: winKey });
    }
    setDrag({ a: null, b: null });
  };

  return (
    <div>
      <h1 className="page-title">📊 Статистики</h1>
      <p style={{ color: MUTED, fontSize: 13.5, lineHeight: 1.5, marginTop: -6, maxWidth: 900 }}>
        Істина — CRM: усі графіки рахуються з неї автоматично і збігаються зі Звітом/КВП. Категорія → показник → живий графік:
        <b> клік по легенді ізолює серію</b>, <b>тягнеш по графіку — зум</b>, повзунок знизу — навігація по всій історії.
      </p>

      {/* Категорії */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0 16px" }}>
        {CATS.map((c) => (
          <button key={c.key} onClick={() => { setCatKey(c.key); if (!c.manualForm) setMetricKey(c.metrics[0].key); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, padding: "9px 15px", borderRadius: 11, cursor: "pointer",
              border: catKey === c.key ? "1px solid #1f2330" : "1px solid var(--border)", background: catKey === c.key ? "#1f2330" : "var(--card-bg)", color: catKey === c.key ? "#fff" : "var(--text)" }}>
            <span>{c.icon}</span> {c.label} {c.depstats && "✍️"}
          </button>
        ))}
      </div>

      {!cat.manualForm && (
        <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px" }}>
          {/* Чипи метрик + контролі */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {cat.metrics.map((m) => (
                <button key={m.key} onClick={() => setMetricKey(m.key)}
                  style={{ fontSize: 13, fontWeight: 650, padding: "7px 13px", borderRadius: 20, cursor: "pointer",
                    border: metricKey === m.key ? "1px solid #2f6fdb" : "1px solid var(--border)",
                    background: metricKey === m.key ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: metricKey === m.key ? "#2f6fdb" : "var(--text)" }}>
                  {m.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              {!metric.monthOnly && !metric.weekOnly && (
                <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                  {(["day", "week", "month"] as const).map((g) => (
                    <button key={g} onClick={() => setGran(g)} style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", cursor: "pointer", border: "none",
                      background: gran === g ? "#1f2330" : "var(--card-bg)", color: gran === g ? "#fff" : "var(--text)" }}>
                      {g === "day" ? "День" : g === "week" ? "Тиждень" : "Місяць"}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: "inline-flex", gap: 4 }}>
                {Object.keys(RANGES).map((r) => (
                  <button key={r} onClick={() => { setRange(r); setWin(null); }} style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 11px", borderRadius: 8, cursor: "pointer",
                    border: "1px solid " + (range === r ? "#2f6fdb" : "var(--border)"), background: range === r ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: range === r ? "#2f6fdb" : "var(--text)" }}>{r}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Легенда-чипи */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {seriesList.map((s, i) => (
                <span key={s.scopeKey} onClick={() => toggle(s.scopeKey)} onDoubleClick={() => isolate(s.scopeKey)}
                  title={s.benchmark ? "бенчмарк — агрегат компанії (для порівняння)" : undefined}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, cursor: "pointer", opacity: hidden.has(s.scopeKey) ? 0.4 : 1, userSelect: "none", color: s.benchmark ? MUTED : "var(--text)" }}>
                  {s.benchmark
                    ? <span style={{ width: 14, height: 0, borderTop: "2px dashed #94a3b8" }} />
                    : <span style={{ width: 11, height: 11, borderRadius: "50%", background: color(i) }} />}
                  {s.scopeName}{s.benchmark && " (бенчмарк)"}
                </span>
              ))}
            </div>
            <span style={{ fontSize: 11.5, color: MUTED }}>клік — увімк/вимк · подвійний — тільки ця серія</span>
          </div>

          {/* Великий графік */}
          <div style={{ userSelect: "none" }}>
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={rows} margin={{ top: 12, right: 64, bottom: 4, left: 8 }}
                onMouseDown={(e: any) => e && setDrag({ a: e.activeLabel, b: e.activeLabel })}
                onMouseMove={(e: any) => e && drag.a && setDrag((d) => ({ ...d, b: e.activeLabel }))}
                onMouseUp={onDragEnd}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="period" tickFormatter={shortDate} tick={{ fontSize: 11, fill: MUTED }} minTickGap={40} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => (metric.unit === "₴" ? (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + "М" : Math.round(v / 1000) + "к") : String(v))} axisLine={false} tickLine={false} width={54} />
                <Tooltip formatter={(v: any) => fmt(Number(v), metric.unit)} labelFormatter={(l: any) => shortDate(String(l))}
                  contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)" }} />
                <ReferenceLine x={rows.find((r) => r.period >= SEAM)?.period} stroke="#94a3b8" strokeDasharray="5 4"
                  label={{ value: "історія · CRM", position: "insideTopRight", fontSize: 10.5, fill: MUTED }} />
                {visibleSeries.map(({ s, i }) => (
                  <Line key={s.scopeKey} type="monotone" dataKey={`s${i}`} name={s.scopeName}
                    stroke={s.benchmark ? "#94a3b8" : color(i)} strokeWidth={s.benchmark ? 1.6 : i === 0 ? 2.4 : 1.8}
                    strokeDasharray={s.benchmark ? "6 4" : undefined} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                ))}
                {drag.a && drag.b && <ReferenceArea x1={drag.a} x2={drag.b} fill="#2f6fdb" fillOpacity={0.08} />}
                <Brush dataKey="period" height={26} travellerWidth={9} stroke="#94a3b8" tickFormatter={shortDate}
                  startIndex={eff.lo} endIndex={eff.hi} gap={1}
                  onChange={(e: any) => {
                    if (!e || e.startIndex == null || e.endIndex == null) return;
                    let lo = e.startIndex, hi = e.endIndex;
                    if (lo === eff.lo && hi === eff.hi) return; // контрольований ре-емісія — ігноруємо (нема петлі)
                    if (hi - lo < MIN_WIN) { // не даємо ручкам зхлопнутись у пряму
                      if (lo + MIN_WIN <= rows.length - 1) hi = lo + MIN_WIN; else lo = Math.max(0, hi - MIN_WIN);
                    }
                    setWin({ lo, hi, key: winKey });
                  }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Статс-рядок */}
          {stat ? (
            <div style={{ display: "flex", gap: 30, flexWrap: "wrap", alignItems: "center", paddingTop: 10, borderTop: "1px solid var(--border)", marginTop: 6, fontSize: 13 }}>
              <span>Зараз: <b>{fmt(stat.now, metric.unit)}</b></span>
              <span style={{ color: MUTED }}>Сер. за період: <b style={{ color: "var(--text)" }}>{fmt(stat.avg, metric.unit)}</b></span>
              <span style={{ color: MUTED }}>Мін: <b style={{ color: "var(--text)" }}>{fmt(stat.min.v, metric.unit)}</b> ({shortDate(stat.min.p)})</span>
              <span style={{ color: MUTED }}>Макс: <b style={{ color: "var(--text)" }}>{fmt(stat.max.v, metric.unit)}</b> ({shortDate(stat.max.p)})</span>
              <span style={{ color: MUTED }}>Δ до попер.: <b style={{ color: stat.delta >= 0 ? "#16a34a" : "#dc2626" }}>{stat.delta >= 0 ? "▲" : "▼"} {Math.abs(stat.delta).toFixed(1)}%</b></span>
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, color: MUTED, fontSize: 12 }}>
                <InfoHint text={(metric.hint ? metric.hint + " " : "") + (metric.seamHint ?? "")} /> {metric.hint}
              </span>
            </div>
          ) : <div style={{ padding: "14px 0", color: MUTED, fontSize: 13 }}>{resp ? "Немає даних для цього показника (очікує вводу)" : "Завантаження…"}</div>}
        </div>
      )}

      {cat.manualForm && <ManualForm onClose={() => { setCatKey("money"); setMetricKey("avg_check"); }} isAdmin={role === "admin"} />}

      {/* Міні-плитки */}
      {!cat.manualForm && <MiniTiles onPick={(c, m) => { setCatKey(c); setMetricKey(m); }} />}

      {/* Пояснення */}
      <div style={{ background: "rgba(214,158,46,0.08)", border: "1px solid rgba(214,158,46,0.3)", borderRadius: 12, padding: "13px 16px", fontSize: 12.5, color: "var(--text)", lineHeight: 1.55, marginTop: 16 }}>
        <b>Категорії (усе — 🤖 з CRM):</b> Гроші · Авто (успішні/поставлені) · Ліди й канали · Клієнти (постійні) · Дзвінки · План/факт. Напрямки/Фінанси/HR — історія з таблиці + продовження вручну (депстат). Кожен графік ріжеться по серіях: компанія → команди → менеджери. Шов <b>2026-07-01</b> позначено пунктиром: ліворуч — історія таблиці, праворуч — точний CRM (рівень міг зміститись — це не збій, а зміна джерела). Міні-плитки — клік підставляє показник у великий графік.
      </div>
    </div>
  );
}

function MiniTiles({ onPick }: { onPick: (cat: string, metric: string) => void }) {
  const [data, setData] = useState<Record<string, StatsSeries | null>>({});
  const TILES = [
    { cat: "money", metric: "revenue_success", block: "sales", label: "ДОХІД (УСПІХ)", unit: "₴", color: COLORS[0] },
    { cat: "auto", metric: "cars_success", block: "sales", label: "УСПІШНІ АВТО", color: COLORS[1] },
    { cat: "calls", metric: "calls", block: "sales", label: "ДЗВІНКИ", color: COLORS[3] },
    { cat: "leads", metric: "lg_transfers", block: "marketing", label: "ПРОРАХУНКИ ЛІДГЕНІВ", color: COLORS[2] },
  ];
  useEffect(() => {
    let alive = true;
    Promise.all(TILES.map((t) => fetchStatsSeries({ block: t.block, metric: t.metric, granularity: "week" }).then((r) => r.series.find((s) => s.scopeType === "company") ?? null).catch(() => null)))
      .then((arr) => { if (alive) setData(Object.fromEntries(TILES.map((t, i) => [t.metric, arr[i]]))); });
    return () => { alive = false; };
  }, []);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14, marginTop: 16 }}>
      {TILES.map((t) => {
        const s = data[t.metric]; const pts = s?.points ?? [];
        const now = pts.length ? pts[pts.length - 1].value : 0;
        const prev = pts.length > 4 ? pts[pts.length - 5].value : now;
        const dlt = prev ? ((now - prev) / Math.abs(prev)) * 100 : 0;
        const vals = pts.slice(-24).map((p) => p.value); const mn = Math.min(...vals, 0), mx = Math.max(...vals, 1);
        const path = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * 200},${34 - ((v - mn) / (mx - mn || 1)) * 30}`).join(" ");
        return (
          <div key={t.metric} onClick={() => onPick(t.cat, t.metric)} style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "13px 15px", cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: MUTED }}>
              <span>{t.label}</span><span style={{ color: dlt >= 0 ? "#16a34a" : "#dc2626" }}>{dlt >= 0 ? "▲" : "▼"}{Math.abs(dlt).toFixed(0)}%</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, margin: "3px 0 6px" }}>{fmt(now, t.unit)}</div>
            <svg viewBox="0 0 200 34" width="100%" height="34" preserveAspectRatio="none"><polyline points={path} fill="none" stroke={t.color} strokeWidth={2} /></svg>
          </div>
        );
      })}
    </div>
  );
}

function ManualForm({ onClose, isAdmin }: { onClose: () => void; isAdmin: boolean }) {
  const manualMetrics = CATS.find((c) => c.key === "manual")!.metrics;
  const [mk, setMk] = useState(manualMetrics[0].key);
  const m = manualMetrics.find((x) => x.key === mk)!;
  const [period, setPeriod] = useState("2026-07-01");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");
  const submit = async () => {
    try { await saveStatsManual({ block: m.block, metric: m.key, scopeType: "company", scopeKey: "company", scopeName: "Компанія", granularity: "month", period, value: Number(value) }); setMsg("✓ Збережено"); setValue(""); }
    catch (e: any) { setMsg("✗ " + (e?.response?.data?.error ?? "помилка")); }
  };
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: 20, maxWidth: 560 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <b style={{ fontSize: 16 }}>✍️ Внести показники (ручні)</b>
        <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: MUTED, fontSize: 18 }}>×</button>
      </div>
      {!isAdmin ? <div style={{ color: MUTED }}>Ввід доступний лише адміну.</div> : (
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 13 }}>Показник
            <select value={mk} onChange={(e) => setMk(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
              {manualMetrics.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>Місяць
            <input type="month" value={period.slice(0, 7)} onChange={(e) => setPeriod(e.target.value + "-01")} style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          </label>
          <label style={{ fontSize: 13 }}>Значення {m.unit && `(${m.unit})`}
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          </label>
          <button onClick={submit} disabled={!value} style={{ padding: "9px 16px", borderRadius: 9, border: "none", background: "#2f6fdb", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Зберегти</button>
          {msg && <div style={{ fontSize: 13, color: msg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{msg}</div>}
          <div style={{ fontSize: 12, color: MUTED }}>Finance/HR вносяться в наявному розділі «Статистики (відділи)» (депстат) — тут не дублюємо.</div>
        </div>
      )}
    </div>
  );
}
