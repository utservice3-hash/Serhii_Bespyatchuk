import { Fragment, useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, Brush } from "recharts";
import {
  fetchMissedCalls, fetchMissedList, fetchNoDeal, fetchNoDealList, fetchMissedSeries,
  type MissedSeriesGranularity, type MissedSeriesResp,
  type MissedCallsResp, type MissedDayBucket, type MissedManagerRow, type MissedListResp,
  type MissedNextStep, type NoDealCounts, type NoDealState, type NoDealListRow, type MissedTeamRow,
} from "../../../api";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { missedDefaultPeriod, groupByTeam, clientCell, clampListDay, SERIES_METRICS, type SeriesMetric } from "../missedCallsView";
import { RANGES, MIN_WIN, rangeWindow, shortDate, COLORS } from "./StatisticsChartsSection";
import { ClientCardPanel } from "./ClientCardPanel";

/**
 * 📵 «ПРОПУЩЕНІ ДЗВІНКИ» — ТЗ-1 від 14.09.2026, блоки A (підсумок) і B (по менеджерах).
 *
 * Замінює ручний збір: доти Юля щодня збирала пропущені сама й кидала в чат «Керівники».
 * Усі означення — рішення власника 15.09.2026, закриті гейтами `#431`-`#440` на бекенді:
 * BUSY рахується, CLIENT NO ANSWER — ні; передзвін у вікні 24 год будь-ким; плечі одного
 * дзвінка склеєні.
 *
 * 🔴 «БЕЗ ВІДПОВІДАЛЬНОГО» — ПОЛОВИНА ПРЕДМЕТА, І ВОНА НЕ ХОВАЄТЬСЯ. Правило фронту:
 * коли невідомих БІЛЬШІСТЬ, прогалина стає числом у шапці, а не підписом у кожному рядку.
 * Тому тут обидва: плитка в блоці A і один чесний рядок у таблиці B.
 */

/** Порядок і підписи відер — ті самі, що в ядрі (`core/dayBuckets.ts`, `DAY_BUCKETS`). */
const BUCKETS: { key: MissedDayBucket; label: string; hint: string }[] = [
  { key: "work", label: "Робочий час", hint: "Будні 9:00–18:00 за Києвом." },
  { key: "evening", label: "Вечір", hint: "Будні 18:00–21:00 за Києвом." },
  { key: "weekend", label: "Вихідні", hint: "Субота й неділя цілу добу. Державні свята НЕ враховуються — календар свят порожній, тож свято в будній день рахується як звичайний день." },
  { key: "night", label: "Ніч", hint: "Будні 21:00–9:00 за Києвом." },
];

type SortKey = "missed" | "callbackSelf" | "callbackColleague" | "noCallback" | "medianMin" | "clientSelf";

/** «—», а не «0 %»: нульовий знаменник — це «нема з чого рахувати», а не провал. */
function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

/**
 * @param canOpenClient чи віддасть сервер картку клієнта (вкладка «Клієнти»). Без неї в списку
 *   дзвінків стоїть «є в CRM», а не кнопка, що відповіла б 403.
 */
export function MissedCallsSection({ canOpenClient }: { canOpenClient: boolean }) {
  // 📅 Період СВІЙ, дефолт «вчора» (ТЗ §1.4 A). Чому не спільний `dateRange` — `missedCallsView.ts`.
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => missedDefaultPeriod(today));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<MissedCallsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("missed");
  // День списку живе ТУТ, а не в блоці C: блок перемонтовується на кожному запиті, і день
  // скидався б на кінець періоду, зокрема на майбутній (рецензія 17.09.2026).
  const [listDay, setListDay] = useState<string>(() => clampListDay(null, from, to, today));
  useEffect(() => { setListDay((cur) => clampListDay(cur, from, to, today)); }, [from, to, today]);

  useEffect(() => {
    if (!from || !to) return;
    // 🔴 ГОНКА: відповідь за СТАРИЙ період, що прийшла пізніше, не сміє перезаписати новий.
    let alive = true;
    setD(null); setErr(null);
    fetchMissedCalls({ from, to })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to]);

  /**
   * Сортуємо лише ЛЮДЕЙ. «Без відповідального» лишається внизу за будь-якого сортування:
   * це не людина, і поставити «нікого» на перше місце рейтингу означало б сказати
   * неправду про роботу відділу — саме так упорядковує і ядро (`foldManagerRows`).
   */
  const table = useMemo(() => {
    if (!d) return { groups: [] as { team: MissedTeamRow; people: MissedManagerRow[] }[], orphans: [] as MissedManagerRow[], ownerless: [] as MissedManagerRow[] };
    const val = (r: { [k in SortKey]: number | null } & { name: string }) => r[sort] ?? -1;
    const byVal = <R extends { [k in SortKey]: number | null } & { name: string }>(a: R, b: R) =>
      val(b) - val(a) || a.name.localeCompare(b.name, "uk");
    // Команди — за тією ж колонкою, «Поза командами» лишається останньою, як і в ядрі.
    const teams = [...d.teams].sort((a, b) => (a.teamId === null ? 1 : 0) - (b.teamId === null ? 1 : 0) || byVal(a, b));
    const { groups, orphans } = groupByTeam(teams, d.managers);
    for (const g of groups) g.people.sort(byVal);
    return { groups, orphans: orphans.sort(byVal), ownerless: d.managers.filter((r) => r.managerId === null) };
  }, [d, sort]);

  const navBar = <PeriodNav state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />;
  if (err) return <div className="chart-card">{navBar}<p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p></div>;
  if (!d) return <div className="chart-card">{navBar}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const s = d.summary;
  const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" };
  const cols: { key: SortKey; label: string; hint: string }[] = [
    { key: "missed", label: "Пропущено", hint: "Вхідні без розмови з відповіддю NO ANSWER або BUSY, плечі одного дзвінка склеєні." },
    { key: "callbackSelf", label: "Передзвонив сам", hint: "Перший вихідний на той самий номер протягом 24 год зробив той самий менеджер." },
    { key: "callbackColleague", label: "Передзвонив колега", hint: "Перший вихідний протягом 24 год зробив інший менеджер. Для рядка «Без відповідального» будь-хто — колега." },
    { key: "noCallback", label: "Не передзвонили", hint: "Жодного вихідного на цей номер за 24 год." },
    { key: "medianMin", label: "Медіана, хв", hint: "Медіана, а не середнє: поодинокі передзвони наступного дня тягнуть середнє вдесятеро вгору." },
    { key: "clientSelf", label: "Клієнт сам", hint: "Клієнт передзвонив сам і дочекався відповіді. НЕ зараховується як наш передзвін." },
  ];
  const num = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA"));

  return (
    <>
      <div className="chart-card">
        {navBar}
        <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
          📵 Пропущені дзвінки
          <InfoHint text={
            "Дані з Ringostat. Пропущений = вхідний без розмови з відповіддю «не відповіли» або «зайнято». "
            + "Не враховуються: голосова пошта, клієнт кинув слухавку до відповіді, відповідані з нульовою розмовою. "
            + "Передзвін — перший вихідний на той самий номер протягом 24 годин."
          } />
        </h3>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>
          Період: {d.period.from} — {d.period.to}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          <Tile label="Пропущено" value={num(s.missed)} sub={`не враховано: ${num(s.excluded)}`}
            hint="Не враховано — голосова пошта, клієнт кинув слухавку до відповіді, відповідані з нульовою розмовою. Показані окремо, щоб їх не шукали як зниклі." />
          <Tile label="Передзвонили за 24 год" value={pct(s.callback, s.missed)} sub={`${num(s.callback)} із ${num(s.missed)}`}
            hint={`З них додзвонились: ${num(s.callbackTalked)}. Сам відповідальний — ${num(s.callbackSelf)}, колега — ${num(s.callbackColleague)}.`} />
          <Tile label="Медіана передзвону" value={s.medianMin == null ? "—" : `${s.medianMin} хв`} sub="від пропущеного до першого вихідного"
            hint="Медіана, а не середнє: розподіл хвостатий, і поодинокі «передзвонили наступного дня» тягнуть середнє вдесятеро вгору." />
          <Tile label="Клієнт передзвонив сам" value={pct(s.clientSelf, s.missed)} sub={`${num(s.clientSelf)} дзвінків`}
            hint="Клієнт сам набрав знову й дочекався відповіді. Це НЕ наш передзвін і в нього не зараховується." />
          {/* 🔴 У зрізі команди чи менеджера «без відповідального» не входить за побудовою — тут
              був би нуль, що читається «у вас таких немає». Правило 7: порожній скоуп не нуль. */}
          {d.ownerlessInScope
            ? <Tile label="Без відповідального" value={pct(s.ownerless, s.missed)} sub={`${num(s.ownerless)} дзвінків`}
                hint="Ringostat не віддав менеджера: дзвінок не дійшов до людини (черга, IVR). Такі дзвінки не приписуються нікому — ні командам, ні черговому." />
            : <Tile label="Без відповідального" value="—" sub="не входять у зріз команди"
                hint="Дзвінки без відповідального не належать жодній команді й жодному менеджеру, тому в цьому зрізі їх немає — це не нуль. Повне число видно в зрізі всієї компанії." />}
        </div>

        <h4 style={{ margin: "18px 0 8px", fontSize: 14 }}>Коли пропускаємо</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
          {BUCKETS.map((b) => (
            <Tile key={b.key} label={b.label} value={num(s.buckets[b.key])} sub={pct(s.buckets[b.key], s.missed)} hint={b.hint} />
          ))}
        </div>
        {/* ТЗ §1.2: «вихідні = Сб/Нд, і це написано на екрані у виносці» — видимо, а не лише в підказці. */}
        <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>
          Час — за Києвом. Вихідні — субота й неділя; державні свята не враховуються (календар свят порожній),
          тож свято в будній день рахується як звичайний день.
        </p>
      </div>

      {/* 🔝 «Дзвінок був, а угоди немає» — ОДРАЗУ ПІД ПІДСУМКОМ (прохання власника 17.09.2026): унизу
          його не було видно за довгою таблицею й списком дзвінків. Далі — динаміка, як на Статистиках. */}
      <NoDealBlock from={d.period.from} to={d.period.to} />
      <MissedDynamicsBlock />

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: "0 0 12px" }}>По менеджерах</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ ...head, textAlign: "left", cursor: "default" }}>Менеджер</th>
                {cols.map((c) => (
                  <th key={c.key} style={head} onClick={() => setSort(c.key)} title="Сортувати">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {c.label}{sort === c.key ? " ↓" : ""} <InfoHint text={c.hint} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* ТЗ §1.4 B: кожен менеджер + рядок команди + «без відповідального» + «всього».
                  Рядок команди — з ядра (медіана по дзвінках команди), а не Σ людей на фронті. */}
              {table.groups.map((g) => (
                <Fragment key={`team-${String(g.team.teamId)}`}>
                  {g.people.map((r) => <MgrRow key={r.managerId ?? "x"} r={r} cell={cell} num={num} indent />)}
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", fontWeight: 600 }}>
                    <td style={{ ...cell, textAlign: "left" }}>Команда: {g.team.name}</td>
                    <td style={cell}>{num(g.team.missed)}</td>
                    <td style={cell}>{num(g.team.callbackSelf)}</td>
                    <td style={cell}>{num(g.team.callbackColleague)}</td>
                    <td style={cell}>{num(g.team.noCallback)}</td>
                    <td style={cell}>{num(g.team.medianMin)}</td>
                    <td style={cell}>{num(g.team.clientSelf)}</td>
                  </tr>
                </Fragment>
              ))}
              {table.orphans.map((r) => <MgrRow key={r.managerId ?? "x"} r={r} cell={cell} num={num} />)}
              {table.ownerless.map((r) => <MgrRow key="ownerless" r={r} cell={cell} num={num} />)}
              <tr style={{ fontWeight: 700 }}>
                <td style={{ ...cell, textAlign: "left" }}>{d.total.name}</td>
                <td style={cell}>{num(d.total.missed)}</td>
                <td style={cell}>{num(d.total.callbackSelf)}</td>
                <td style={cell}>{num(d.total.callbackColleague)}</td>
                <td style={cell}>{num(d.total.noCallback)}</td>
                {/* Медіани не додаються: справжня медіана періоду стоїть у плитці вище. */}
                <td style={cell} title="Медіана періоду — у плитці «Медіана передзвону» вище">{s.medianMin == null ? "—" : s.medianMin}</td>
                <td style={cell}>{num(d.total.clientSelf)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <MissedListBlock from={d.period.from} to={d.period.to} day={listDay} setDay={setListDay} canOpenClient={canOpenClient} />
    </>
  );
}

function MgrRow({ r, cell, num, indent = false }: {
  r: MissedManagerRow; cell: React.CSSProperties; num: (v: number | null) => string; indent?: boolean;
}) {
  return (
    <tr style={{
      borderBottom: "1px solid var(--border)",
      color: r.managerId === null ? "var(--text-muted)" : "inherit",
      fontStyle: r.managerId === null ? "italic" : "normal",
    }}>
      <td style={{ ...cell, textAlign: "left", paddingLeft: indent ? 22 : 10 }}>{r.name}</td>
      <td style={cell}>{num(r.missed)}</td>
      <td style={cell}>{num(r.callbackSelf)}</td>
      <td style={cell}>{num(r.callbackColleague)}</td>
      <td style={cell}>{num(r.noCallback)}</td>
      <td style={cell}>{num(r.medianMin)}</td>
      <td style={cell}>{num(r.clientSelf)}</td>
    </tr>
  );
}

/**
 * 📈 ДИНАМІКА — «статистика по днях», як на сторінках Статистик (прохання власника 17.09.2026):
 * показник чипом, День / Тиждень / Місяць, діапазон 3м / 6м / 12м / Усе, повзунок і зум протягуванням,
 * серії-легенда (клік — увімк/вимк, подвійний — лише ця), рядок підсумків вікна.
 *
 * Від навігатора періоду вгорі НЕ залежить свідомо: графік — це історія, а навігатор обирає зріз для
 * таблиць. Завантажується вся історія один раз на гранулярність (рік по днях — ~1 с на проді), а
 * діапазон лише зсуває вікно — рівно як на Статистиках. Числа — з того самого ядра, що й плитки
 * (Σ точок за період == «Пропущено» за той самий період; гейт #472).
 */
function MissedDynamicsBlock() {
  const [gran, setGran] = useState<MissedSeriesGranularity>("day");
  const [metricKey, setMetricKey] = useState<SeriesMetric["key"]>("missed");
  const [range, setRange] = useState("3м");
  const [resp, setResp] = useState<MissedSeriesResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [win, setWin] = useState<{ lo: number; hi: number; key: string } | null>(null);
  const [drag, setDrag] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const metric = SERIES_METRICS.find((x) => x.key === metricKey) ?? SERIES_METRICS[0];

  useEffect(() => {
    let alive = true;
    setResp(null); setErr(null); setWin(null);
    fetchMissedSeries({ granularity: gran })
      .then((r) => { if (alive) setResp(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [gran]);

  const seriesList = resp?.series ?? [];
  const nameOf = (s: MissedSeriesResp["series"][number]) => (s.key === "total" ? "Усього" : s.name ?? s.key);
  const rows = useMemo(() => {
    if (!resp) return [] as Record<string, string | number | null>[];
    const periods = [...new Set(resp.series.flatMap((s) => s.points.map((p) => p.period)))].sort();
    const map = new Map(periods.map((p) => [p, { period: p } as Record<string, string | number | null>]));
    resp.series.forEach((s, i) => s.points.forEach((p) => { map.get(p.period)![`s${i}`] = metric.value(p); }));
    return periods.map((p) => map.get(p)!);
  }, [resp, metric]);

  const winKey = `${range}:${rows.length}:${gran}`;
  const eff = useMemo(() => {
    if (!rows.length) return { lo: 0, hi: 0 };
    if (win && win.key === winKey) {
      const lo = Math.max(0, Math.min(win.lo, win.hi, rows.length - 1));
      const hi = Math.max(0, Math.min(Math.max(win.lo, win.hi), rows.length - 1));
      return { lo, hi };
    }
    return rangeWindow(rows as { period: string }[], range);
  }, [rows, range, win, winKey]);

  const visible = seriesList.map((s, i) => ({ s, i })).filter(({ s }) => !hidden.has(s.key));
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const isolate = (k: string) => setHidden(new Set(seriesList.map((s) => s.key).filter((x) => x !== k)));

  // Підсумки вікна — по ПЕРШІЙ видимій серії, як на Статистиках; «за вікно» — зі сум, не середнім.
  const stat = useMemo(() => {
    const first = visible[0]; if (!first || !rows.length) return null;
    const lo = String(rows[eff.lo]?.period ?? ""), hi = String(rows[eff.hi]?.period ?? "");
    const pts = first.s.points.filter((p) => p.period >= lo && p.period <= hi);
    const vals = pts.map((p) => ({ p: p.period, v: metric.value(p) })).filter((x): x is { p: string; v: number } => x.v != null);
    if (!vals.length) return null;
    const now = vals[vals.length - 1], prev = vals.length > 1 ? vals[vals.length - 2] : null;
    const min = vals.reduce((a, b) => (b.v < a.v ? b : a)), max = vals.reduce((a, b) => (b.v > a.v ? b : a));
    return { name: nameOf(first.s), now, total: metric.total(pts), min, max,
      delta: prev && prev.v ? ((now.v - prev.v) / Math.abs(prev.v)) * 100 : null };
  }, [visible, rows, eff.lo, eff.hi, metric]);

  const f = (v: number | null) => (v == null ? "—" : `${metric.unit === "%" ? v.toFixed(1) : Math.round(v).toLocaleString("uk-UA")}${metric.unit ? ` ${metric.unit}` : ""}`);
  const onDragEnd = () => {
    if (drag.a && drag.b && drag.a !== drag.b) {
      const ia = rows.findIndex((r) => r.period === drag.a), ib = rows.findIndex((r) => r.period === drag.b);
      const lo = Math.min(ia, ib); let hi = Math.max(ia, ib);
      if (hi - lo < MIN_WIN) hi = Math.min(rows.length - 1, lo + MIN_WIN);
      setWin({ lo, hi, key: winKey });
    }
    setDrag({ a: null, b: null });
  };
  const pill = (active: boolean): React.CSSProperties => ({ fontSize: 12.5, fontWeight: 700, padding: "6px 11px", borderRadius: 8, cursor: "pointer",
    border: "1px solid " + (active ? "#2f6fdb" : "var(--border)"), background: active ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: active ? "#2f6fdb" : "var(--text)" });
  const MUTED = "var(--text-muted)";

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 8 }}>
        📈 Динаміка
        <InfoHint text={"Пропущені по днях, тижнях чи місяцях за всю історію дзвінків (з 01.09.2025). Остання точка — вчора: частка «не передзвонили» за останню добу ще може зменшитись, доки не мине 24 години на передзвін. "
          + "Серії — уся компанія (або ваш зріз), кожна команда за поточним складом, «Поза командами» і «Без відповідального»; у кожній точці Σ серій = «Усього»."} />
      </h3>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {SERIES_METRICS.map((mm) => (
            <button key={mm.key} type="button" onClick={() => setMetricKey(mm.key)} title={mm.hint}
              style={{ fontSize: 13, fontWeight: 650, padding: "7px 13px", borderRadius: 20, cursor: "pointer",
                border: metricKey === mm.key ? "1px solid #2f6fdb" : "1px solid var(--border)",
                background: metricKey === mm.key ? "rgba(47,111,219,0.1)" : "var(--card-bg)", color: metricKey === mm.key ? "#2f6fdb" : "var(--text)" }}>
              {mm.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
            {(["day", "week", "month"] as const).map((g) => (
              <button key={g} type="button" onClick={() => setGran(g)} style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", cursor: "pointer", border: "none",
                background: gran === g ? "#1f2330" : "var(--card-bg)", color: gran === g ? "#fff" : "var(--text)" }}>
                {g === "day" ? "День" : g === "week" ? "Тиждень" : "Місяць"}
              </button>
            ))}
          </div>
          <div style={{ display: "inline-flex", gap: 4 }}>
            {Object.keys(RANGES).map((r) => (
              <button key={r} type="button" onClick={() => { setRange(r); setWin(null); }} style={pill(range === r)}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!err && !resp && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {resp && rows.length === 0 && <p style={{ margin: 0, color: MUTED }}>Дзвінків за історію немає.</p>}
      {resp && rows.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {seriesList.map((s, i) => (
                <span key={s.key} onClick={() => toggle(s.key)} onDoubleClick={() => isolate(s.key)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, cursor: "pointer", opacity: hidden.has(s.key) ? 0.4 : 1, userSelect: "none" }}>
                  <span style={{ width: 11, height: 11, borderRadius: "50%", background: COLORS[i % COLORS.length] }} />
                  {nameOf(s)}
                </span>
              ))}
            </div>
            <span style={{ fontSize: 11.5, color: MUTED }}>клік — увімк/вимк · подвійний — тільки ця серія · тягни по графіку — зум</span>
          </div>
          <div style={{ userSelect: "none" }}>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={rows} margin={{ top: 12, right: 24, bottom: 4, left: 8 }}
                onMouseDown={(e: { activeLabel?: string | number } | null) => { if (e?.activeLabel != null) setDrag({ a: String(e.activeLabel), b: String(e.activeLabel) }); }}
                onMouseMove={(e: { activeLabel?: string | number } | null) => { if (e?.activeLabel != null && drag.a) { const l = String(e.activeLabel); setDrag((dd) => ({ ...dd, b: l })); } }}
                onMouseUp={onDragEnd}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="period" tickFormatter={shortDate} tick={{ fontSize: 11, fill: MUTED }} minTickGap={40} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} width={48} />
                <Tooltip formatter={(v: unknown) => f(v == null ? null : Number(v))} labelFormatter={(l: unknown) => shortDate(String(l))}
                  contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)" }} />
                {visible.map(({ s, i }) => (
                  <Line key={s.key} type="monotone" dataKey={`s${i}`} name={nameOf(s)} stroke={COLORS[i % COLORS.length]}
                    strokeWidth={s.key === "total" ? 2.4 : 1.6} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                ))}
                {drag.a && drag.b && <ReferenceArea x1={drag.a} x2={drag.b} fill="#2f6fdb" fillOpacity={0.08} />}
                <Brush dataKey="period" height={26} travellerWidth={9} stroke="#94a3b8" tickFormatter={shortDate}
                  startIndex={eff.lo} endIndex={eff.hi} gap={1}
                  onChange={(e: { startIndex?: number; endIndex?: number }) => {
                    if (e?.startIndex == null || e.endIndex == null) return;
                    let lo = e.startIndex, hi = e.endIndex;
                    if (lo === eff.lo && hi === eff.hi) return;
                    if (hi - lo < MIN_WIN) { if (lo + MIN_WIN <= rows.length - 1) hi = lo + MIN_WIN; else lo = Math.max(0, hi - MIN_WIN); }
                    setWin({ lo, hi, key: winKey });
                  }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {stat ? (
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap", alignItems: "center", paddingTop: 10, borderTop: "1px solid var(--border)", marginTop: 6, fontSize: 13 }}>
              <span style={{ color: MUTED }}>{stat.name}:</span>
              <span>Остання точка: <b>{f(stat.now.v)}</b> ({shortDate(stat.now.p)})</span>
              <span style={{ color: MUTED }}>{metric.key === "missed" ? "Разом за вікно" : "За вікно"}: <b style={{ color: "var(--text)" }}>{f(stat.total)}</b></span>
              <span style={{ color: MUTED }}>Мін: <b style={{ color: "var(--text)" }}>{f(stat.min.v)}</b> ({shortDate(stat.min.p)})</span>
              <span style={{ color: MUTED }}>Макс: <b style={{ color: "var(--text)" }}>{f(stat.max.v)}</b> ({shortDate(stat.max.p)})</span>
              {stat.delta != null && (
                <span style={{ color: MUTED }}>Δ до попер.: <b style={{ color: "var(--text)" }}>{stat.delta >= 0 ? "▲" : "▼"} {Math.abs(stat.delta).toFixed(1)}%</b></span>
              )}
            </div>
          ) : <div style={{ padding: "12px 0", color: MUTED, fontSize: 13 }}>У вікні немає точок для цієї серії.</div>}
        </>
      )}
    </div>
  );
}

const BUCKET_LABEL: Record<MissedDayBucket, string> = Object.fromEntries(BUCKETS.map((b) => [b.key, b.label])) as Record<MissedDayBucket, string>;

/** Текст «що сталось далі». Невдалий передзвін — ОКРЕМО від вдалого: це різна робота. */
function nextLabel(kind: MissedNextStep, min: number | null): { text: string; bad: boolean } {
  const m = min == null ? "" : ` через ${String(min)} хв`;
  switch (kind) {
    case "callback_talked": return { text: `передзвонили${m}, додзвонились`, bad: false };
    case "callback_no_answer": return { text: `передзвонили${m}, не додзвонились`, bad: false };
    case "client_self": return { text: `клієнт передзвонив сам${m}`, bad: false };
    case "nothing": return { text: "нічого за 24 год", bad: true };
  }
}

/**
 * 📋 БЛОК C — пропущені за ОДИН день.
 * Список рахується тим самим виразом, що й «пропущено» в блоці A (гейт `#452`), тож за той
 * самий день рядків тут рівно стільки, скільки в числі.
 * 👤 КЛІЄНТ (ТЗ §1.4 C, хвіст звірки 16.09.2026): адреси картки клієнта в продукті немає, тож
 * картка відкривається ТУТ ЖЕ, під рядком — той самий `ClientCardPanel`, що на екрані планів
 * клієнтів. Хто картку не отримає від сервера, бачить «є в CRM», а не кнопку.
 */
function MissedListBlock({ from, to, day, setDay, canOpenClient }: {
  from: string; to: string; day: string; setDay: (d: string) => void; canOpenClient: boolean;
}) {
  const [onlyNo, setOnlyNo] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [d, setD] = useState<MissedListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!day) return;
    let alive = true;
    setD(null); setErr(null);
    fetchMissedList({ day, ...(onlyNo ? { noCallback: "1" as const } : {}) })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [day, onlyNo]);

  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
        📋 Список дзвінків
        <InfoHint text="Кожен пропущений за обраний день і що сталось одразу після нього. «Що сталось далі» — НАЙРАНІША подія: якщо клієнт передзвонив сам раніше, ніж ми, рядок покаже саме це." />
      </h3>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12, fontSize: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          День
          <input id="missed-list-day" type="date" value={day} min={from} max={to} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input id="missed-list-only-no" type="checkbox" checked={onlyNo} onChange={(e) => setOnlyNo(e.target.checked)} />
          лише без нашого передзвону
        </label>
      </div>

      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!err && !d && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {d && d.rows.length === 0 && (
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          {onlyNo ? `За ${day} немає пропущених без нашого передзвону.` : `За ${day} пропущених немає.`}
        </p>
      )}
      {d && d.rows.length > 0 && (
        <>
          {d.truncated && (
            <p style={{ margin: "0 0 8px", color: "var(--danger, #c8102e)", fontSize: 13 }}>
              Показано перші {d.rows.length.toLocaleString("uk-UA")} — список за цей день довший і обрізаний.
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={head}>Час</th><th style={head}>Номер</th><th style={head}>Менеджер</th>
                  <th style={head}>Коли</th><th style={head}>Що сталось далі</th><th style={head}>Клієнт</th><th style={head}>Угода</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => {
                  const n = nextLabel(r.next, r.nextMin);
                  const cc = clientCell(r.clientKey, canOpenClient);
                  const isOpen = openRow === r.uniqueid;
                  return (
                    <Fragment key={r.uniqueid}>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={cell}>{r.at}</td>
                      <td style={cell}>{r.phone ?? "номер не визначено"}</td>
                      <td style={{ ...cell, color: r.managerId === null ? "var(--text-muted)" : "inherit", fontStyle: r.managerId === null ? "italic" : "normal" }}>{r.managerName}</td>
                      <td style={cell}>{BUCKET_LABEL[r.bucket]}</td>
                      <td style={{ ...cell, color: n.bad ? "var(--danger, #c8102e)" : "inherit" }}>{n.text}</td>
                      <td style={cell}>
                        {cc === "open" && (
                          <button type="button" onClick={() => setOpenRow(isOpen ? null : r.uniqueid)}
                            style={{ background: "none", border: "none", padding: 0, color: "var(--link, #2f5d8a)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}>
                            {isOpen ? "сховати картку" : "картка клієнта"}
                          </button>
                        )}
                        {cc === "known" && <span style={{ color: "var(--text-muted)" }}>є в CRM</span>}
                        {cc === "unknown" && <span style={{ color: "var(--text-muted)" }}>не впізнано в CRM</span>}
                      </td>
                      <td style={cell}>
                        {r.dealUrl
                          ? <a href={r.dealUrl} target="_blank" rel="noreferrer">угода в CRM</a>
                          : <span style={{ color: "var(--text-muted)" }}>немає</span>}
                      </td>
                    </tr>
                    {isOpen && r.clientKey && (
                      <tr>
                        <td colSpan={7} style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
                          <ClientCardPanel clientKey={r.clientKey} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Підписи трьох станів — ОДИН підпис на одне значення (правило проєкту). */
const NO_DEAL_TILES: { state: NoDealState; key: keyof NoDealCounts; label: string; hint: string }[] = [
  { state: "unknown", key: "unknown", label: "Номер не знайдено в CRM",
    hint: "Номер не збігся жодним контактом у CRM. Це НЕ «заявку не завели» — це «ми не знаємо, хто дзвонив»: можливо, новий клієнт, а можливо, номер записаний у CRM інакше." },
  { state: "has_deal", key: "hasDeal", label: "Є угода",
    hint: "Клієнт відомий, і його угода створена в межах від доби до дзвінка до 7 днів після." },
  { state: "no_deal", key: "noDeal", label: "Клієнт є, заявки за тиждень немає",
    hint: "Клієнт відомий, розмова була, але жодної угоди від доби до дзвінка до 7 днів після. Найближче до «заявку не завели»." },
];

/**
 * 🧾 БЛОК D — «дзвінок був, а угоди немає». Три числа, і кожне розкривається списком,
 * порахованим ТИМ САМИМ запитом (гейт `#452`: рядків у розкритті рівно стільки, скільки в числі).
 */
function NoDealBlock({ from, to }: { from: string; to: string }) {
  const [c, setC] = useState<NoDealCounts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<NoDealState | null>(null);
  const [list, setList] = useState<{ truncated: boolean; rows: NoDealListRow[] } | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setC(null); setErr(null); setOpen(null); setList(null);
    fetchNoDeal({ from, to })
      .then((r) => { if (alive) setC(r.counts); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(null); setListErr(null);
    fetchNoDealList({ from, to, state: open })
      .then((r) => { if (alive) setList({ truncated: r.truncated, rows: r.rows }); })
      .catch((e) => { if (alive) setListErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [open, from, to]);

  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };
  const talk = (sec: number) => `${String(Math.floor(sec / 60))}:${String(sec % 60).padStart(2, "0")}`;

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        🧾 Дзвінок був, а угоди немає
        <InfoHint text="Вхідні дзвінки, на які відповіли, розкладені на три стани. Натисніть на число, щоб побачити самі дзвінки." />
      </h3>
      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!err && !c && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {c && (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>
            Відповіданих вхідних за період: {c.answered.toLocaleString("uk-UA")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
            {NO_DEAL_TILES.map((t) => {
              const n = c[t.key];
              const active = open === t.state;
              return (
                <button key={t.state} type="button" onClick={() => setOpen(active ? null : t.state)}
                  style={{
                    textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit",
                    background: active ? "var(--surface-2, rgba(0,0,0,0.04))" : "transparent",
                    border: `1px solid ${active ? "var(--text-muted)" : "var(--border)"}`, borderRadius: 10, padding: "12px 14px",
                  }}>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                    {t.label} <InfoHint text={t.hint} />
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{n.toLocaleString("uk-UA")}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                    {pct(n, c.answered)} · {active ? "сховати список" : "показати список"}
                  </div>
                </button>
              );
            })}
          </div>

          {open && (
            <div style={{ marginTop: 14 }}>
              {listErr && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{listErr}</p>}
              {!listErr && !list && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
              {list && list.rows.length === 0 && <p style={{ margin: 0, color: "var(--text-muted)" }}>Дзвінків у цьому стані за період немає.</p>}
              {list && list.rows.length > 0 && (
                <>
                  {list.truncated && (
                    <p style={{ margin: "0 0 8px", color: "var(--danger, #c8102e)", fontSize: 13 }}>
                      Показано перші {list.rows.length.toLocaleString("uk-UA")} — список обрізаний.
                    </p>
                  )}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                          <th style={head}>Дата й час</th><th style={head}>Номер</th><th style={head}>Менеджер</th>
                          <th style={head}>Розмова</th><th style={head}>Угода</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.rows.map((r) => (
                          <tr key={r.uniqueid} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={cell}>{r.at}</td>
                            <td style={cell}>{r.phone ?? "номер не визначено"}</td>
                            <td style={{ ...cell, color: r.managerId === null ? "var(--text-muted)" : "inherit" }}>{r.managerName}</td>
                            <td style={cell}>{talk(r.talkSec)}</td>
                            <td style={cell}>
                              {r.dealUrl
                                ? <a href={r.dealUrl} target="_blank" rel="noreferrer">угода в CRM</a>
                                : <span style={{ color: "var(--text-muted)" }}>немає</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
        {label} <InfoHint text={hint} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
