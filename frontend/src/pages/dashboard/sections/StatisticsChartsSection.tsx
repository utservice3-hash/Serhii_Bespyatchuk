import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea, ReferenceDot, Brush,
} from "recharts";
import { effGranOf } from "../statsGran";
import { fetchStatsSeries, saveStatsManual, fetchLapsedClients, type StatsSeriesResp, type StatsSeries, type LapsedClientsResp } from "../../../api";
import { todayKyiv } from "../periodRules";
import { StatisticsSummary } from "./StatisticsSummary";
import { ChartSkeleton, SkelBox, TableSkeleton } from "../Skeleton";

const SEAM = "2026-07-01";
// dataviz категорійна палітра (фіксований порядок; компанія завжди [0]). CVD-safe рампи.
export const COLORS = ["#2f6fdb", "#16a34a", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d"];
const MUTED = "var(--text-muted)";

type Metric = { key: string; block: string; label: string; unit?: string; monthOnly?: boolean; weekOnly?: boolean; manual?: boolean; hint?: string; seamHint?: string; unitScope?: string };
type Cat = { key: string; icon: string; label: string; metrics: Metric[]; manualForm?: boolean; depstats?: boolean };

const SEAM_CARS = "До лип 2026 — ручний лічильник таблиці; з лип 2026 — точний підрахунок CRM (тому рівень міг зміститись).";
const CALLS_HINT = "Результативні дзвінки Ringostat (billsec>0); історія до лип 2026 — з таблиці (визначення могло відрізнятись).";
const FINHR_HINT = "Історія з таблиці; оновиться після внесення через депстат-ввід.";
const DIR_HINT = "Напрямок (unit-серія). Історія з таблиці; CRM-продовження по sales_channel — у розробці (де ще нема — показуємо історію до шва). Лише для КВП/адміна.";

const CATS: Cat[] = [
  { key: "money", icon: "💰", label: "Гроші", metrics: [
    /* 4367 (ТЗ Юлії): з підказки мусить бути видно, ЗА ЯКИЙ ПЕРІОД і ЗА ЯКОЮ ДАТОЮ угоди. Перевірено в ядрі
       (`money.successByBucket`): анкер — дата переходу угоди в «Успішно реалізовано» (142) за Києвом, не дата
       оплати й не відвантаження; кожна точка — чек саме за свій день / тиждень / місяць. */
    { key: "avg_check", block: "sales", label: "Середній чек", unit: "₴", hint: "виручка «успішно реалізовано» ÷ кількість таких угод — окремо за кожну точку (день, тиждень чи місяць — за «Кроком»); дата угоди — день переходу в «Успішно реалізовано», за Києвом (не дата оплати й не відвантаження)", seamHint: SEAM_CARS },
    { key: "revenue_success", block: "sales", label: "Дохід (успіх)", unit: "₴", hint: "успішні угоди (142) за датою закриття, signed" },
    { key: "payment_received", block: "sales", label: "Отримані кошти", unit: "₴", hint: "оплата отримана ∪ успішно реалізовано, без подвоєння — на цих грошах стоїть план" },
    { key: "cash_deals_sum", block: "sales", label: "Готівкові", unit: "₴", hint: "сума готівкових угод — лише історія ручної таблиці до 01.07.2026; з CRM цей показник не продовжується, тому після шва точок немає" },
  ] },
  { key: "auto", icon: "🚚", label: "Авто", metrics: [
    { key: "cars_success", block: "sales", label: "Успішні", hint: "кількість угод, що перейшли в «Успішно реалізовано», за датою переходу (Київ), кожна раз", seamHint: SEAM_CARS },
    { key: "cars_delivered", block: "sales", label: "Поставлені", hint: "авто за датою завантаження — те саме, що плитка «Відправлені авто»; план — KPI-цілі задачника «відправлено авто»; company включає поставки поза 6 командами (~0.5%)", seamHint: SEAM_CARS },
  ] },
  { key: "leads", icon: "📈", label: "Ліди й канали", metrics: [
    { key: "ad_leads", block: "marketing", label: "Ліди з реклами", hint: "угоди з каналом «реклама», за першим входом у «Взято в роботу» в межах періоду — кожна угода раз" },
    { key: "lg_transfers", block: "marketing", label: "Прорахунки лідгенів", hint: "входи угод у «Кваліфіковано» — як на екрані «Лідогенерація»; лише компанія, по командах не розрізається" },
  ] },
  { key: "clients", icon: "👥", label: "Клієнти", metrics: [
    { key: "repeat_clients_active", block: "logistics", label: "Постійні в роботі", hint: "постійний = has_prior (≥1 попередня виграна)" },
    { key: "repeat_clients_cars", block: "logistics", label: "Машини постійних", hint: "відправлені авто клієнтів, у яких уже була виграна угода, — за датою завантаження" },
    { key: "repeat_clients_sum", block: "logistics", label: "Сума постійних", unit: "₴", hint: "сума угод (ціна) тих самих авто постійних клієнтів, за датою завантаження" },
    { key: "repeat_avg_check", block: "logistics", label: "Чек постійних", unit: "₴", hint: "сума постійних ÷ машини постійних — окремо за кожну точку" },
  ] },
  { key: "calls", icon: "☎️", label: "Дзвінки", metrics: [
    { key: "calls", block: "sales", label: "Результативні", hint: CALLS_HINT },
  ] },
  { key: "plan", icon: "🎯", label: "План / факт", metrics: [
    { key: "plan_execution", block: "sales", label: "% виконання", unit: "%", monthOnly: true, hint: "отримані кошти ÷ місячний план, по місяцях; план тижня — на плитках угорі й лінією на графіку «Отримані кошти»" },
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
  /* 📣 «Реклама» переїхала окремим розділом меню (ТЗ 28.09, блок 4, п.6) — див. `AdsPage.tsx`. */
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
// 📤 Експортуються для графіка «Пропущених дзвінків» (17.09.2026): той самий вигляд діапазонів і вікна,
// а не друга копія логіки, що розійдеться з цією на першій правці.
export const shortDate = (p: string) => { const [y, m, d] = p.split("-"); return `${d}.${m}.${y.slice(2)}`; };
export const RANGES: Record<string, number> = { "3м": 90, "6м": 180, "12м": 365, "Усе": 9999 };
export const MIN_WIN = 3; // мінімальна ширина вікна брашу (≥4 точки) — щоб не з'їжджало в 2-точкову пряму
// Вікно [lo,hi] (індекси у ПОВНОМУ rows) для діапазону 3м/6м/12м/Усе.
export function rangeWindow(rows: { period: string }[], range: string): { lo: number; hi: number } {
  const hi = rows.length - 1;
  if (hi < 0) return { lo: 0, hi: 0 };
  if (range === "Усе") return { lo: 0, hi };
  const cut = new Date(rows[hi].period); cut.setDate(cut.getDate() - RANGES[range]);
  const cs = cut.toISOString().slice(0, 10);
  let lo = rows.findIndex((r) => r.period >= cs); if (lo < 0) lo = 0;
  if (hi - lo < MIN_WIN) lo = Math.max(0, hi - MIN_WIN);
  return { lo, hi };
}

/** 📏 Круглі поділки осі Y (ТЗ, блок 4, п.4): 0 / 5к / 10к / 15к, а не 0к · 4к · 7к · 11к · 14к. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
const axisFmt = (v: number, unit?: string) => {
  if (unit === "%") return `${v}%`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toLocaleString("uk-UA", { maximumFractionDigits: 1 })} млн`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}к`;
  return String(v);
};
const SEAM_NOTE = "До 01.07.2026 — історія з ручної таблиці, з 01.07 — точні дані CRM. Рівні до і після шва не порівнюються: це зміна джерела, а не обвал чи стрибок.";

export default function StatisticsChartsSection({ role }: { role?: string }) {
  const today = todayKyiv();
  const [catKey, setCatKey] = useState("money");
  const cat = CATS.find((c) => c.key === catKey)!;
  /* 🎯 Дефолт — «Оплата отримана»: саме на ній стоїть план, тож графік одразу показує сходинки плану. */
  const [metricKey, setMetricKey] = useState("payment_received");
  /* 📣 Категорія може НЕ мати метрик — тип пишемо ЯВНО: без `noUncheckedIndexedAccess` вираз
     `cat.metrics[0]` типізується як `Metric`, тож компілятор мовчить, а падає рантайм.
     Саме так 08.09.2026 клік по «Рекламі» клав увесь екран Статистик на `metric.monthOnly`. */
  const metric: Metric | undefined = cat.metrics.find((m) => m.key === metricKey) ?? cat.metrics[0];
  const [gran, setGran] = useState<"day" | "week" | "month">("week");
  /* 🗓 Дефолт — 3 місяці (ТЗ, блок 4, п.1); було 12 місяців і 7 ліній. */
  const [range, setRange] = useState("3м");
  const [resp, setResp] = useState<StatsSeriesResp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /* ⏳ Графік вантажиться — на його місці заготовка ТІЄЇ САМОЇ висоти, легенда лишається (прохання Романа 02.10). */
  const [chartLoading, setChartLoading] = useState(true);
  /** Карта графіка — сюди плавно прокручує клік по команді в таблиці. */
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [nonce, setNonce] = useState(0);
  /** Які серії ПОКАЗАНІ. Дефолт — лише компанія; команди додаються вибором (ТЗ, блок 4, п.1). */
  const [shown, setShown] = useState<Set<string> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [pickedTeam, setPickedTeam] = useState<number | null>(null);
  const [win, setWin] = useState<{ lo: number; hi: number; key: string } | null>(null);
  const [drag, setDrag] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });

  const effGran = effGranOf(metric, gran); // напрямок без місячних (ВЛТ) → тиждень
  useEffect(() => {
    let alive = true; setChartLoading(true); setLoadErr(null); setWin(null);
    if (!metric) return; // категорія без метрик серій не тягне
    const m = metric;    // звужений локальний — далі жодного дотику до можливо-порожнього `metric`
    fetchStatsSeries({ block: m.block, metric: m.key, granularity: effGran, ...(m.unitScope ? { unit: m.unitScope } : {}) })
      .then((d) => { if (alive) { setResp(d); setChartLoading(false); } })
      /* 🔴 ПОМИЛКА — ЯВНО, а не «Немає даних (очікує вводу)» і не вічне «Завантаження…» (ТЗ, блок 1, п.2):
         обидва варіанти брехали про причину. */
      .catch((e) => alive && (setChartLoading(false), setLoadErr(e?.response?.data?.error ?? (e?.response?.status ? `сервер відповів ${e.response.status}` : "немає звʼязку з сервером"))));
    return () => { alive = false; };
  }, [metric?.block, metric?.key, effGran, metric?.unitScope, nonce]);

  // Скоуп за замовчуванням: компанія (або перша серія, якщо компанії в скоупі немає) — й обрана в таблиці команда.
  const visibleKeys = useMemo(() => {
    if (!resp) return new Set<string>();
    if (shown) return shown;
    const first = resp.series.find((s) => s.scopeType === "company") ?? resp.series[0];
    const set = new Set<string>(first ? [first.scopeKey] : []);
    if (pickedTeam != null) set.add(String(pickedTeam));
    return set;
  }, [resp, shown, pickedTeam]);

  // усі періоди (вісь X) + рядки для recharts; план — окремими ключами `p<scopeKey>`
  const { rows, seriesList } = useMemo(() => {
    if (!resp) return { rows: [] as any[], seriesList: [] as StatsSeries[] };
    const periods = new Set<string>();
    resp.series.forEach((s) => s.points.forEach((p) => periods.add(p.period)));
    (resp.plan ?? []).forEach((pl) => pl.points.forEach((p) => periods.add(p.period)));
    const sorted = [...periods].sort();
    const map = new Map(sorted.map((p) => [p, { period: p } as any]));
    resp.series.forEach((s, i) => s.points.forEach((p) => { map.get(p.period)![`s${i}`] = p.value; }));
    (resp.plan ?? []).forEach((pl) => pl.points.forEach((p) => { map.get(p.period)![`p${pl.scopeKey}`] = p.value; }));
    return { rows: sorted.map((p) => map.get(p)!), seriesList: resp.series };
  }, [resp]);

  const winKey = `${range}:${rows.length}`;
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
  const visibleSeries = seriesList.map((s, i) => ({ s, i })).filter(({ s }) => visibleKeys.has(s.scopeKey) && (showArchived || !s.archived));
  const toggle = (k: string) => setShown(() => { const n = new Set(visibleKeys); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const isolate = (k: string) => setShown(new Set([k]));
  const archivedCount = seriesList.filter((s) => s.archived).length;
  const planVisible = (resp?.plan ?? []).filter((pl) => visibleKeys.has(pl.scopeKey));

  // Межа осі Y — по видимому вікну (лінії й план), щоб поділки були круглими саме в тому, що бачимо.
  const yTicks = useMemo(() => {
    const windowRows = rows.slice(eff.lo, eff.hi + 1);
    let max = 0;
    for (const r of windowRows) {
      for (const { i } of visibleSeries) { const v = r[`s${i}`]; if (typeof v === "number" && v > max) max = v; }
      for (const pl of planVisible) { const v = r[`p${pl.scopeKey}`]; if (typeof v === "number" && v > max) max = v; }
    }
    return niceTicks(max);
  }, [rows, eff.lo, eff.hi, visibleSeries, planVisible]);

  // Середнє / мін / макс по ПЕРШІЙ видимій серії у вікні. «Зараз» і «Δ до попер.» прибрано: вони порівнювали
  // неповний поточний відрізок із повним минулим (ТЗ, блок 1, п.1) — чесне порівняння тепер у плитках зверху.
  const stat = useMemo(() => {
    const first = visibleSeries[0]; if (!first || !rows.length) return null;
    const windowRows = rows.slice(eff.lo, eff.hi + 1);
    const key = `s${first.i}`;
    const pts = windowRows.filter((r) => r[key] != null).map((r) => ({ p: r.period, v: r[key] as number }));
    if (!pts.length) return null;
    const vals = pts.map((x) => x.v);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const min = pts.reduce((a, b) => (b.v < a.v ? b : a)), max = pts.reduce((a, b) => (b.v > a.v ? b : a));
    return { avg, min, max, name: first.s.scopeName };
  }, [visibleSeries, rows, eff.lo, eff.hi]);

  const anomalyAt = (period: string) => (resp?.anomalies ?? []).filter((a) => a.period === period && visibleKeys.has(a.scopeKey));

  const onDragEnd = () => {
    if (drag.a && drag.b && drag.a !== drag.b) {
      const ia = rows.findIndex((r) => r.period === drag.a), ib = rows.findIndex((r) => r.period === drag.b);
      let lo = Math.min(ia, ib), hi = Math.max(ia, ib);
      if (hi - lo < MIN_WIN) hi = Math.min(rows.length - 1, lo + MIN_WIN);
      setWin({ lo, hi, key: winKey });
    }
    setDrag({ a: null, b: null });
  };

  const onPickTeam = (teamId: number) => {
    setPickedTeam(teamId); setShown(null);
    // Таблиця команд рахує «отримані кошти» — графік показує ту саму величину для обраної команди.
    setCatKey("money"); setMetricKey("payment_received");
    // Плавно до графіка (прохання Романа 02.10): таблиця нагорі, графік нижче — інакше клік «нічого не робить».
    requestAnimationFrame(() => chartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const segBtn = (on: boolean, disabled = false) => ({ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", cursor: disabled ? "not-allowed" : "pointer", border: "none",
    opacity: disabled ? 0.4 : 1, background: on ? "#1f2330" : "var(--card-bg)", color: on ? "#fff" : "var(--text)" } as const);

  return (
    <div>
      <h1 className="page-title">📊 Статистики</h1>

      {/* 1️⃣ ЦИФРИ — НА ПЕРШОМУ ПЛАНІ: плитки (факт · план · % · Δ) і таблиця команд. Графік — нижче, другорядний. */}
      <StatisticsSummary today={today} onPickTeam={onPickTeam} pickedTeam={pickedTeam} />

      {/* Категорії */}
      {/* 🙈 ВКЛАДКА «Ручні» (✍️) НЕ ПОКАЗУЄТЬСЯ — рішення власника 08.09.2026: «щоб у
          ручному нічого не заповнювали». 🔴 ЗАПИС У `CATS` ЛИШАЄТЬСЯ, ПРИБРАНО ЛИШЕ ВХІД: на нього
          спирається `ManualForm` (`CATS.find(c => c.key === "manual")!`).
          ⚠️ МЕЖА, НАЗВАНА ВГОЛОС: це фронт, тож `POST /statistics/manual` лишається
          живим для адміна. Тобто вхід прибрано з ЕКРАНА, а не з API. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "22px 0 12px" }}>
        {/* ⚠️ ЛАНЦЮГ `CATS.filter((c) => !c.manualForm).map(` НЕ РОЗРИВАТИ: його читає гейт #363b. */}
        {CATS.filter((c) => !c.manualForm).map((c) => (
          <button key={c.key} onClick={() => { setCatKey(c.key); if (c.metrics.length) setMetricKey(c.metrics[0].key); setShown(null); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, padding: "9px 15px", borderRadius: 11, cursor: "pointer",
              border: catKey === c.key ? "1px solid #1f2330" : "1px solid var(--border)", background: catKey === c.key ? "#1f2330" : "var(--card-bg)", color: catKey === c.key ? "#fff" : "var(--text)" }}>
            <span>{c.icon}</span> {c.label} {c.depstats && "✍️"}
          </button>
        ))}
      </div>

      {!cat.manualForm && metric && (
        <div ref={chartRef} style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px", scrollMarginTop: 16 }}>
          {/* Чипи метрик; формула — видимим підписом під ними (ТЗ, блок 4, п.5) */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {cat.metrics.map((m) => (
              <button key={m.key} onClick={() => { setMetricKey(m.key); setShown(null); }}
                style={{ fontSize: 13, fontWeight: 650, padding: "7px 13px", borderRadius: 20, cursor: "pointer",
                  border: metricKey === m.key ? "1px solid #2f6fdb" : "1px solid var(--border)",
                  background: metricKey === m.key ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: metricKey === m.key ? "#2f6fdb" : "var(--text)" }}>
                {m.label}
              </button>
            ))}
          </div>
          {metric.hint && <div style={{ fontSize: 12, color: MUTED, margin: "6px 0 0" }}>📐 {metric.hint}{metric.seamHint ? ` · ${metric.seamHint}` : ""}</div>}

          {/* 🎛 КЕРУВАННЯ — ДВІ ПІДПИСАНІ ГРУПИ, однакові на всіх вкладках (ТЗ, блок 4, п.2). Недоступний крок
              видно вимкненим із поясненням, а не прибраним — інакше набір кнопок «стрибає» між вкладками. */}
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", margin: "12px 0 10px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 700 }}>Крок:</span>
              <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                {(["day", "week", "month"] as const).map((g) => {
                  const off = (metric.monthOnly && g !== "month") || (metric.weekOnly && g !== "week");
                  return (
                    <button key={g} disabled={off} title={off ? (metric.monthOnly ? "цей показник є лише помісячно" : "цей показник є лише по тижнях") : undefined}
                      onClick={() => setGran(g)} style={segBtn(effGran === g, off)}>
                      {g === "day" ? "День" : g === "week" ? "Тиждень" : "Місяць"}
                    </button>
                  );
                })}
              </span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 700 }}>Період:</span>
              <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
                {Object.keys(RANGES).map((r) => (
                  <button key={r} onClick={() => { setRange(r); setWin(null); }} style={segBtn(range === r)}>{r === "Усе" ? "Усе" : r.replace("м", " міс")}</button>
                ))}
              </span>
            </span>
          </div>

          {/* Серії: дефолт — компанія; команди додаються кліком. Розформовані — лише з «показати архівні». */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
            {seriesList.map((s, i) => (s.archived && !showArchived) ? null : (
              <span key={s.scopeKey} onClick={() => toggle(s.scopeKey)} onDoubleClick={() => isolate(s.scopeKey)}
                title={s.benchmark ? "бенчмарк — агрегат компанії (для порівняння)" : "клік — показати / сховати · подвійний — лише ця"}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, cursor: "pointer", opacity: visibleKeys.has(s.scopeKey) ? 1 : 0.4, userSelect: "none", color: s.benchmark ? MUTED : "var(--text)" }}>
                {s.benchmark
                  ? <span style={{ width: 14, height: 0, borderTop: "2px dashed #94a3b8" }} />
                  : <span style={{ width: 11, height: 11, borderRadius: "50%", background: color(i) }} />}
                {visibleKeys.has(s.scopeKey) ? "" : "+ "}{s.scopeName}{s.benchmark && " (бенчмарк)"}
              </span>
            ))}
            {archivedCount > 0 && (
              <label style={{ fontSize: 12, color: MUTED, cursor: "pointer" }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> показати архівні
              </label>
            )}
            {!resp && !loadErr && <SkelBox w={420} h={14} />}
          </div>

          {loadErr ? (
            <div role="alert" style={{ padding: "18px 0", color: "#b91c1c", fontSize: 13 }}>
              ⚠️ Графік не завантажився: {loadErr}.{" "}
              <button onClick={() => setNonce((n) => n + 1)} style={{ fontSize: 12.5, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" }}>Повторити</button>
            </div>
          ) : (chartLoading || !resp) ? (
            <ChartSkeleton height={300} />
          ) : (
            <>
              <div style={{ userSelect: "none" }}>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={rows} margin={{ top: 12, right: 64, bottom: 4, left: 8 }}
                    onMouseDown={(e: any) => e && setDrag({ a: e.activeLabel, b: e.activeLabel })}
                    onMouseMove={(e: any) => e && drag.a && setDrag((d) => ({ ...d, b: e.activeLabel }))}
                    onMouseUp={onDragEnd}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="period" tickFormatter={shortDate} tick={{ fontSize: 11, fill: MUTED }} minTickGap={40} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                    <YAxis ticks={yTicks} domain={[0, yTicks[yTicks.length - 1]]} tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => axisFmt(Number(v), metric.unit)} axisLine={false} tickLine={false} width={58} />
                    <Tooltip
                      content={({ active, payload, label }: any) => {
                        if (!active || !payload?.length) return null;
                        const an = anomalyAt(String(label));
                        return (
                          <div style={{ fontSize: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", padding: "8px 10px", maxWidth: 320 }}>
                            <b>{shortDate(String(label))}</b>{String(label) < SEAM && <span style={{ color: MUTED }}> · ручна таблиця</span>}
                            {payload.map((p: any) => <div key={p.dataKey} style={{ color: p.stroke }}>{p.name}: {fmt(Number(p.value), metric.unit)}</div>)}
                            {an.map((a, k) => (
                              <div key={k} style={{ marginTop: 4, color: a.kind === "real" ? "#b45309" : a.kind === "corrected" ? "#1d4ed8" : "#b91c1c" }}>{a.kind === "corrected" ? "✏️" : "⚠️"} {a.note}<br /><span style={{ color: MUTED }}>{a.crm}</span></div>
                            ))}
                          </div>
                        );
                      }} />
                    {/* 🪡 ШОВ ДАНИХ — ПІДПИСАНИЙ НА ГРАФІКУ (ТЗ, блок 4, п.3), а не дрібним текстом унизу сторінки. */}
                    <ReferenceLine x={rows.find((r) => r.period >= SEAM)?.period} stroke="#94a3b8" strokeDasharray="5 4"
                      label={{ value: "01.07: таблиця → CRM, рівні не порівнюються", position: "insideTopRight", fontSize: 10.5, fill: MUTED }} />
                    {visibleSeries.map(({ s, i }) => (
                      <Line key={s.scopeKey} type="monotone" dataKey={`s${i}`} name={s.scopeName}
                        stroke={s.benchmark ? "#94a3b8" : color(i)} strokeWidth={s.benchmark ? 1.6 : i === 0 ? 2.4 : 1.8}
                        strokeDasharray={s.benchmark ? "6 4" : undefined} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                    ))}
                    {/* 📈 Сходинки плану (ТЗ, блок 2, п.2) — для «Отримані кошти» і «Поставлені» (KPI авто), тією ж кольоровою гамою, пунктиром. */}
                    {planVisible.map((pl) => {
                      const idx = seriesList.findIndex((s) => s.scopeKey === pl.scopeKey);
                      return <Line key={`plan-${pl.scopeKey}`} type="stepAfter" dataKey={`p${pl.scopeKey}`} name={`План · ${seriesList[idx]?.scopeName ?? pl.scopeKey}`}
                        stroke={color(Math.max(0, idx))} strokeDasharray="2 3" strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />;
                    })}
                    {/* ⚠️ Аномалії з доказом CRM (ТЗ, блок 1, п.3) — точка помічена, а не лінія тягнеться мовчки. */}
                    {(resp.anomalies ?? []).flatMap((a, k) => {
                      const si = seriesList.findIndex((s) => s.scopeKey === a.scopeKey);
                      if (si < 0 || !visibleKeys.has(a.scopeKey)) return [];
                      const v = rows.find((r) => r.period === a.period)?.[`s${si}`];
                      const fill = a.kind === "real" ? "#f59e0b" : a.kind === "corrected" ? "#2563eb" : "#dc2626";
                      return typeof v === "number" ? [<ReferenceDot key={`an${k}`} x={a.period} y={v} r={6} fill={fill} stroke="#fff"
                        label={{ value: a.kind === "corrected" ? "✎" : "!", position: "top", fontSize: 12, fontWeight: 800, fill }} />] : [];
                    })}
                    {drag.a && drag.b && <ReferenceArea x1={drag.a} x2={drag.b} fill="#2f6fdb" fillOpacity={0.08} />}
                    <Brush dataKey="period" height={24} travellerWidth={9} stroke="#94a3b8" tickFormatter={shortDate}
                      startIndex={eff.lo} endIndex={eff.hi} gap={1}
                      onChange={(e: any) => {
                        if (!e || e.startIndex == null || e.endIndex == null) return;
                        let lo = e.startIndex, hi = e.endIndex;
                        if (lo === eff.lo && hi === eff.hi) return;
                        if (hi - lo < MIN_WIN) {
                          if (lo + MIN_WIN <= rows.length - 1) hi = lo + MIN_WIN; else lo = Math.max(0, hi - MIN_WIN);
                        }
                        setWin({ lo, hi, key: winKey });
                      }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4 }}>
                {SEAM_NOTE}{planVisible.length > 0 ? (metric.key === "cars_delivered"
                  ? " План — KPI-цілі задачника «відправлено авто» (є з 07.2026), те саме число, що на плитці «Відправлені авто»."
                  : effGran === "week" ? " План тижня на графіку — те саме число, що на плитці: автоплан частин тижня + ручні цілі тімлідів." : "") : ""}
              </div>
              {stat ? (
                <div style={{ display: "flex", gap: 26, flexWrap: "wrap", paddingTop: 8, borderTop: "1px solid var(--border)", marginTop: 8, fontSize: 13 }}>
                  <span style={{ color: MUTED }}>{stat.name}, точки у вікні графіка —</span>
                  <span style={{ color: MUTED }} title="середнє значення ТОЧОК, видимих на графіку; для чека це не «чек за весь період», а середнє чеків по днях / тижнях / місяцях">середнє точок: <b style={{ color: "var(--text)" }}>{fmt(stat.avg, metric.unit)}</b></span>
                  <span style={{ color: MUTED }}>мін: <b style={{ color: "var(--text)" }}>{fmt(stat.min.v, metric.unit)}</b> ({shortDate(stat.min.p)})</span>
                  <span style={{ color: MUTED }}>макс: <b style={{ color: "var(--text)" }}>{fmt(stat.max.v, metric.unit)}</b> ({shortDate(stat.max.p)})</span>
                </div>
              ) : <div style={{ padding: "12px 0", color: MUTED, fontSize: 13 }}>У вибраному вікні немає точок для цього показника.</div>}
            </>
          )}
        </div>
      )}

      {cat.manualForm && <ManualForm onClose={() => { setCatKey("money"); setMetricKey("payment_received"); }} isAdmin={role === "admin"} />}

      {catKey === "clients" && <LapsedClientsBlock />}
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

/**
 * 📉 «КУПУВАВ МИНУЛОГО МІСЯЦЯ, НЕ КУПИВ У ЦЬОМУ» по командах (задача 3990, п.3). Гроші й
 * правило — з бекенда (ядро), тут лише подача. Поточний місяць не завершений — підпис каже це
 * прямо, інакше список у середині місяця читався б як «втратили половину клієнтів».
 */
function LapsedClientsBlock() {
  const [data, setData] = useState<LapsedClientsResp | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [month, setMonth] = useState<string>("");
  useEffect(() => { let alive = true; fetchLapsedClients(month || undefined).then((d) => { if (alive) setData(d); }).catch((e) => setErr(String(e?.message ?? e))); return () => { alive = false; }; }, [month]);
  const fmt = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
  const label = (ym: string) => { const [y, m] = ym.split("-"); return `${["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"][Number(m) - 1]} ${y}`; };
  const shift = (d: number) => { const base = (data?.month ?? new Date().toISOString().slice(0, 7)); const [y, m] = base.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1 + d, 1)); setMonth(dt.toISOString().slice(0, 7)); };
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px", marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15 }}>📉 Купували {data ? label(data.prevMonth) : "минулого місяця"}, не купили {data ? label(data.month) : "у цьому"}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            гроші ① за анкером ядра, як на Звіті · команда — за ефективним менеджером клієнта
            {data && !data.monthComplete && <b style={{ color: "#b45309" }}> · поточний місяць не завершений — список зменшуватиметься до кінця місяця</b>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => shift(-1)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" }}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 13, minWidth: 90, textAlign: "center" }}>{data ? label(data.month) : "…"}</span>
          <button onClick={() => shift(1)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" }}>›</button>
        </div>
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
      {!data && !err && <TableSkeleton rows={6} />}
      {data && (
        <>
          <div style={{ fontSize: 13, marginBottom: 10 }}>Разом: <b>{data.total.clients}</b> клієнтів · минулого місяця принесли <b>{fmt(data.total.prevRevenue)} ₴</b></div>
          {data.teams.length === 0 && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Жоден клієнт минулого місяця не випав — або у вашому скоупі немає оплат за минулий місяць.</div>}
          <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Команда</th><th style={{ textAlign: "right" }}>Клієнтів</th><th style={{ textAlign: "right" }}>Принесли минулого місяця</th></tr></thead>
            <tbody>
              {data.teams.map((t) => { const k = String(t.teamId ?? "none"); const isOpen = open.has(k); return (
                <Fragment key={k}>
                  <tr onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} style={{ cursor: "pointer" }}>
                    <td style={{ fontWeight: 700 }}>{isOpen ? "▾" : "▸"} {t.teamName}</td>
                    <td style={{ textAlign: "right" }}>{t.clients}</td>
                    <td style={{ textAlign: "right" }}>{fmt(t.prevRevenue)} ₴</td>
                  </tr>
                  {isOpen && t.rows.map((r) => (
                    <tr key={r.clientKey} style={{ background: "rgba(0,0,0,0.02)" }}>
                      <td style={{ paddingLeft: 26 }}>{r.clientName}<span style={{ color: "var(--text-muted)" }}> · {r.manager ?? "без менеджера"}</span></td>
                      <td></td>
                      <td style={{ textAlign: "right" }}>{fmt(r.prevRevenue)} ₴</td>
                    </tr>
                  ))}
                </Fragment>
              ); })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
