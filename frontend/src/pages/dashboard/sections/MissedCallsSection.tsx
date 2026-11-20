import { Fragment, useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, Brush } from "recharts";
import {
  fetchMissedCalls, fetchMissedList, fetchNoDeal, fetchNoDealList, fetchMissedSeries, fetchLeadResponse, fetchMissedDeals,
  type MissedDealsResp, type MissedDealNext,
  type ResponseTimeResp, type ResponseLineT, type ResponseTeamT,
  type MissedSeriesGranularity, type MissedSeriesResp,
  type MissedCallsResp, type MissedDayBucket, type MissedManagerRow, type MissedListResp,
  type MissedNextStep, type NoDealCounts, type NoDealState, type NoDealListRow, type MissedTeamRow,
} from "../../../api";
import { PeriodStepper } from "../PeriodStepper";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { missedDefaultPeriod, groupByTeam, clientCell, clampListDay, SERIES_METRICS, type SeriesMetric,
  MISSED_FILTER_KEY, EMPTY_MISSED_FILTER, parseMissedFilter, missedFilterParams, normLabel, type MissedFilter,
  mobileSplit, durText, noTaskReason, callbackPct, prevPeriodOf, prevPeriodWord, changePp, teamsCopyText, type CopyRow } from "../missedCallsView";
import { fetchMissedNorm, type MissedFilterParams } from "../../../api";
import { MissedFilterMenu, useMissedTasks, taskAssignable, TaskCell, ManagerName } from "./MissedCallsTzBlocks";
import { Fold, CountUp, Hint } from "./MissedFold";
import { RANGES, MIN_WIN, rangeWindow, shortDate, COLORS } from "./StatisticsChartsSection";
import { ClientCardPanel } from "./ClientCardPanel";

/**
 * 📵 «ПРОПУЩЕНІ ДЗВІНКИ» — ТЗ-1 від 14.09.2026; ВИГЛЯД — РЕДИЗАЙН 20.11.2026 (прохання Романа: «дуже багато даних, треба
 * спростити й зробити гарним», план `plans/missed-calls/redesign/redesign-plan.md`, прототип погоджено).
 *
 * Перший екран відповідає на два питання: «скільки пропустили і як швидко передзвонюємо» (смуга з чотирьох чисел) і
 * «кому передзвонити просто зараз» (один список). Решта лишається на екрані, але згорнута, і в заголовку кожного
 * згорнутого блоку стоїть його число. ЧИСЛА НЕ ЗМІНЮЮТЬСЯ — міняється лише вигляд, порядок і що відкрито одразу.
 * Єдине нове число — розбивка «на лінію / на мобільні» (рішення Романа 20.11.2026); «чекають» = досі без розмови
 * від 10 с СКРІЗЬ (рішення Романа 20.11.2026, картка «Досі без розмови (38)»).
 *
 * Шапка — та сама, що у Звіті (`rv-head`, `PeriodStepper`, `rv-sel`, `rv-view`): людина вже знає цей контрол.
 *
 * 🔴 «БЕЗ ВІДПОВІДАЛЬНОГО» — ПОЛОВИНА ПРЕДМЕТА, І ВОНА НЕ ХОВАЄТЬСЯ: число в рядку під смугою і рядок у таблиці команд.
 */

/** Порядок і підписи відер — ті самі, що в ядрі (`core/dayBuckets.ts`, `DAY_BUCKETS`). */
const BUCKETS: { key: MissedDayBucket; label: string; hint: string }[] = [
  { key: "work", label: "Робочий час", hint: "Будні 9:00–18:00 за Києвом." },
  { key: "evening", label: "Вечір", hint: "Будні 18:00–21:00 за Києвом." },
  { key: "weekend", label: "Вихідні", hint: "Субота й неділя цілу добу. Державні свята НЕ враховуються — календар свят порожній, тож свято в будній день рахується як звичайний день." },
  { key: "night", label: "Ніч", hint: "Будні 21:00–9:00 за Києвом." },
];

/** «—», а не «0 %»: нульовий знаменник — це «нема з чого рахувати», а не провал. */
function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}
const num = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA"));

/**
 * @param canOpenClient чи віддасть сервер картку клієнта (вкладка «Клієнти»). Без неї в списку
 *   дзвінків стоїть «є в CRM», а не кнопка, що відповіла б 403.
 */
export function MissedCallsSection({ canOpenClient, roleKey }: { canOpenClient: boolean; roleKey?: string | null }) {
  // 📅 Період СВІЙ, дефолт «вчора» (ТЗ §1.4 A). Чому не спільний `dateRange` — `missedCallsView.ts`.
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => missedDefaultPeriod(today));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<MissedCallsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 📄 Дві вкладки одного екрана (рішення Романа 20.11.2026): період і фільтр — спільні.
  const [tab, setTab] = useState<"calls" | "deals">("calls");
  // День списку живе ТУТ, а не в блоці списку: блок перемонтовується на кожному запиті, і день
  // скидався б на кінець періоду, зокрема на майбутній (рецензія 17.09.2026).
  const [listDay, setListDay] = useState<string>(() => clampListDay(null, from, to, today));
  useEffect(() => { setListDay((cur) => clampListDay(cur, from, to, today)); }, [from, to, today]);

  // 👥 Фільтр «Команда / Менеджер» на весь екран (ТЗ 12.10, розділ 3). Менеджер бачить лише себе — фільтра в нього
  // немає; тімлід — своя команда (сервер клампить), лишається вибір менеджера. Вибір пам'ятається в браузері.
  const isManager = roleKey === "manager";
  const [filter, setFilterState] = useState<MissedFilter>(() => {
    try { return parseMissedFilter(localStorage.getItem(MISSED_FILTER_KEY)); } catch { return EMPTY_MISSED_FILTER; }
  });
  const setFilter = (f: MissedFilter) => {
    setFilterState(f);
    try { localStorage.setItem(MISSED_FILTER_KEY, JSON.stringify(f)); } catch { /* приватне вікно — лише без пам'яті */ }
  };
  const fp: MissedFilterParams = isManager ? {} : missedFilterParams(filter);
  const fpKey = JSON.stringify(fp);
  const filtered = fpKey !== "{}";
  // Варіанти фільтра — з НЕфільтрованої відповіді: інакше після вибору команди решта команд зникала б зі списку.
  const [opts, setOpts] = useState<{ teams: MissedTeamRow[]; managers: MissedManagerRow[] } | null>(null);
  useEffect(() => {
    if (!from || !to || !filtered || isManager) return;
    let alive = true;
    fetchMissedCalls({ from, to })
      .then((x) => { if (alive) setOpts({ teams: x.teams, managers: x.managers }); })
      // Не завантажились — меню однаково малюється (з «Скинути»), щоб збережений фільтр не став пасткою без виходу.
      .catch(() => { if (alive) setOpts((o) => o ?? { teams: [], managers: [] }); });
    return () => { alive = false; };
  }, [from, to, filtered, isManager]);
  // 🎯 Ціль із Налаштувань (ТЗ, розділ 7). Не задана — колонку «Статус» не малюємо взагалі (п.7 плану редизайну):
  // однакова фраза «ціль не задана» в кожному рядку нічого не казала.
  const [norm, setNorm] = useState<number | null>(null);
  useEffect(() => { fetchMissedNorm().then((x) => setNorm(x.norm)).catch(() => setNorm(null)); }, []);

  useEffect(() => {
    if (!from || !to || tab !== "calls") return;
    // 🔴 ГОНКА: відповідь за СТАРИЙ період, що прийшла пізніше, не сміє перезаписати новий.
    let alive = true;
    setD(null); setErr(null);
    fetchMissedCalls({ from, to, ...fp })
      .then((x) => { if (alive) setD(x); if (alive && !filtered) setOpts({ teams: x.teams, managers: x.managers }); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fpKey, tab]);

  // 📈 Колонка «Зміна» — той самий запит за попередній ТАКИЙ САМИЙ період (крок стрілки «‹»), той самий фільтр.
  // Не прийшов — колонка пише «—», а не «0»: невідома зміна ≠ відсутність зміни.
  const prevP = prevPeriodOf(nav);
  const [prev, setPrev] = useState<MissedCallsResp | null>(null);
  useEffect(() => {
    if (!prevP || tab !== "calls") return;
    let alive = true;
    setPrev(null);
    fetchMissedCalls({ from: prevP.from, to: prevP.to, ...fp })
      .then((x) => { if (alive) setPrev(x); })
      .catch(() => { if (alive) setPrev(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevP?.from, prevP?.to, fpKey, tab]);

  const tabBtn = (k: "calls" | "deals", label: string) => (
    <button type="button" onClick={() => setTab(k)} aria-pressed={tab === k}>{label}</button>
  );
  const navBar = (
    <header className="rv-head">
      <h1>Пропущені</h1>
      <PeriodStepper state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />
      <div className="rv-grow" />
      {!isManager && opts && <MissedFilterMenu filter={filter} onChange={setFilter} teams={opts.teams} managers={opts.managers} teamLocked={roleKey === "team_lead"} />}
      <div className="rv-seg rv-view" role="group" aria-label="Вкладка">
        {tabBtn("calls", "Дзвінки")}
        {tabBtn("deals", "Угоди")}
      </div>
    </header>
  );
  if (tab === "deals") return <div className="rv mc">{navBar}<div className="mc-view" key="deals"><MissedDealsBlock from={from} to={to} fp={fp} /></div></div>;
  if (err) return <div className="rv mc">{navBar}<p className="mc-err">{err}</p></div>;
  if (!d) return <div className="rv mc">{navBar}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const s = d.summary;
  const split = mobileSplit(s.missed, s.missedMobile);
  const cbPct = s.missed > 0 ? Math.round((s.callback / s.missed) * 100) : null;
  const ownerless = d.managers.filter((r) => r.managerId === null);

  return (
    <div className="rv mc">
      {navBar}
      <div className="mc-view" key="calls">
        {/* ① СМУГА З ЧОТИРЬОХ ЧИСЕЛ (п.1 плану): замість 25 плиток — те, що читається за 2 секунди. */}
        <div className="mc-card">
          <div className="mc-hero">
            <div className="mc-k">
              <div className="mc-kl">Пропущено <Hint text={
                "Дані з Ringostat. Пропущений = вхідний без розмови з відповіддю «не відповіли» або «зайнято»; плечі одного дзвінка склеєні. "
                + "«На лінію» — дзвінок мав хоча б одне плече «Вхідний»: саме їх показує фільтр у Ringostat. «На мобільні» — усі плечі "
                + "«Вхідний перехоплений»: Ringostat переадресував дзвінок на мобільний менеджера. Разом — рівно «Пропущено»."} /></div>
              <div className="mc-kv"><CountUp value={s.missed} /></div>
              <div className="mc-bar" aria-hidden="true"><i className="ln" style={{ width: `${String(split.linePct)}%` }} /><i className="mb" style={{ width: `${String(100 - split.linePct)}%` }} /></div>
              <div className="mc-ks"><b>{num(split.line)}</b> на лінію, <b>{num(split.mobile)}</b> на мобільні</div>
            </div>
            <div className="mc-k">
              <div className="mc-kl">Передзвонили за 24 год <Hint text={`Передзвін — перший вихідний на той самий номер протягом 24 год із розмовою від 10 с. Набрали й не додзвонились — це спроба, а не передзвін: таких ще ${num(s.callbackAttempt)}.`} /></div>
              <div className={`mc-kv${norm != null && cbPct != null ? (cbPct >= norm ? " mc-ok" : " mc-bad") : ""}`}>
                {cbPct == null ? "—" : <CountUp value={cbPct} fmt={(n) => `${String(n)}%`} />}
              </div>
              <div className="mc-ks">{num(s.callback)} з {num(s.missed)}: сам {num(s.callbackSelf)}, колега {num(s.callbackColleague)}
                {norm != null && <> · {normLabel(cbPct, norm)}</>}</div>
            </div>
            <div className="mc-k">
              <div className="mc-kl">Час до передзвону <Hint text="Медіана, а не середнє: від пропущеного до першої розмови від 10 с. Поодинокі «передзвонили наступного дня» тягнуть середнє вдесятеро вгору." /></div>
              <div className="mc-kv">{s.medianMin == null ? "—" : <CountUp value={s.medianMin} fmt={durText} />}</div>
              <div className="mc-ks">медіана, до розмови від 10 с</div>
            </div>
            <div className="mc-k mc-act">
              <div className="mc-kl">Чекають передзвону <Hint text="З номером досі немає розмови від 10 с — ні нашої, ні коли клієнт передзвонив сам. Без межі 24 год: щойно поговорили, дзвінок звідси зникає. Те саме число — у колонці «Чекають» таблиці команд і в списку нижче." /></div>
              <div className="mc-kv"><CountUp value={s.waiting} /></div>
              <div className="mc-ks">{num(s.waitingOverDay)} з них довше доби</div>
            </div>
          </div>
          {/* Не входять у «Пропущено» — числом, щоб їх не шукали як зниклі (правило проєкту). */}
          <div className="mc-foot">
            Не входять у {num(s.missed)}: {`перевізники: ${num(s.carriers)}`} <Hint text="Перевізники — номери, які в CRM закривали як «Перевізник» або які виставляють машини на Ларді (крім номерів з угодою замовника): їх немає ніде на цій вкладці і в колонці Звіту." />,
            {" "}голосова пошта та інше: {num(s.excluded)} <Hint text="Голосова пошта, клієнт кинув слухавку до відповіді, відповідані з нульовою розмовою." />.
            {" "}Клієнт передзвонив сам: {num(s.clientSelf)} (у передзвін не входить).
            {" "}{d.ownerlessInScope
              ? <>Без відповідального: {num(s.ownerless)} <Hint text="Ringostat не віддав менеджера: дзвінок не дійшов до людини (черга, IVR). Такі дзвінки не приписуються нікому — ні командам, ні черговому." /></>
              : <>Без відповідального — не входять у зріз команди <Hint text="Дзвінки без відповідального не належать жодній команді й жодному менеджеру, тому в цьому зрізі їх немає — це не нуль. Повне число видно в зрізі всієї компанії." /></>}
          </div>
        </div>

        {/* ② КОМУ ПЕРЕДЗВОНИТИ (п.4–5 плану): один список замість «Не передзвонили за 24 год» і «Списку дзвінків». */}
        <MissedListBlock from={d.period.from} to={d.period.to} day={listDay} setDay={setListDay} canOpenClient={canOpenClient} fp={fp}
          managers={opts?.managers ?? d.managers} />

        {/* ③ ПО КОМАНДАХ (п.6 плану): одна таблиця замість «Звіту тижня» і «По менеджерах». */}
        <TeamsBlock d={d} prev={prev} nav={nav} norm={norm} ownerless={ownerless} />

        {/* ④ ДЕТАЛЬНІШЕ (п.8 плану): для розбору, а не на щодень. Кожен підблок — зі своїм числом у заголовку. */}
        <DetailsBlock d={d} fp={fp} />
      </div>
    </div>
  );
}

/* ───────────── ② КОМУ ПЕРЕДЗВОНИТИ ───────────── */

/** Текст «що сталось далі». Невдалий передзвін — ОКРЕМО від вдалого: це різна робота. */
function nextLabel(kind: MissedNextStep, min: number | null): { text: string; bad: boolean } {
  const m = min == null ? "" : ` через ${durText(min)}`;
  switch (kind) {
    case "callback_talked": return { text: `передзвонили${m}, додзвонились`, bad: false };
    case "callback_no_answer": return { text: `набирали${m}, без розмови`, bad: false };
    case "client_self": return { text: `клієнт передзвонив сам${m}`, bad: false };
    case "nothing": return { text: "нічого", bad: true };
  }
}

const waitText = (h: number) => (h >= 48 ? `${String(Math.floor(h / 24))} д ${String(h % 24)} год` : `${String(h)} год`);

/**
 * 📋 СПИСОК ЗА ОДИН ДЕНЬ. Рахується тим самим виразом, що й «пропущено» (гейт `#452`), а «чекають» — тим самим
 * `stillWaitingSql`, що й число в смузі (гейт `#10146`): розкриття пояснює число, а не сперечається з ним.
 * Перемикач «Чекають / Усі / Лише мобільні» — над ОДНИМ завантаженим списком, тож лічильники на кнопках чесні ще до кліку.
 * 👤 Картка клієнта відкривається тут же, під рядком (`ClientCardPanel`); без права — «є в CRM», а не кнопка.
 */
function MissedListBlock({ from, to, day, setDay, canOpenClient, fp, managers }: {
  from: string; to: string; day: string; setDay: (d: string) => void; canOpenClient: boolean; fp: MissedFilterParams;
  managers: { managerId: number | null; name: string }[];
}) {
  const [view, setView] = useState<"waiting" | "all" | "mobile">("waiting");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [d, setD] = useState<MissedListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pick, setPick] = useState<Record<string, number>>({});
  // 📅 Кілька днів у періоді — список за ВЕСЬ період (як число «Чекають» у смузі); «День» звужує до одного дня.
  // Баг 20.11.2026: за тиждень смуга казала 131, а список — 38 за один день.
  const multiDay = from !== to;
  const [span, setSpan] = useState<"period" | "day">("period");
  useEffect(() => { setSpan("period"); }, [from, to]);
  const whole = multiDay && span === "period";
  const qFrom = whole ? from : day, qTo = whole ? to : day;
  const t = useMissedTasks(qFrom, qTo, fp);

  useEffect(() => {
    if (!qFrom) return;
    let alive = true;
    setD(null); setErr(null); setSel(new Set());
    const q = qTo !== qFrom ? { day: qFrom, to: qTo } : { day: qFrom };
    fetchMissedList({ ...q, ...fp })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qFrom, qTo, JSON.stringify(fp)]);
  const scopeWord = qFrom === qTo ? "за цей день" : "за період";

  const all = d?.rows ?? [];
  const waiting = all.filter((r) => r.waiting);
  const mobile = all.filter((r) => r.mobile);
  // «Чекають» — найдовше очікування зверху: кому дзвонити першим.
  const rows = view === "waiting" ? [...waiting].sort((a, b) => b.waitH - a.waitH) : view === "mobile" ? mobile : all;
  const overDay = waiting.filter((r) => r.waitH >= 24).length;
  const assignable = rows.filter((r) => taskAssignable(t, r.uniqueid));
  const picked = [...sel].filter((u) => assignable.some((r) => r.uniqueid === u));

  const chip = (k: typeof view, label: string, n: number) => (
    <button type="button" className="mc-chip" aria-pressed={view === k} onClick={() => setView(k)}>{label} {num(n)}</button>
  );
  return (
    <Fold id="c-list" defaultOpen title="Кому передзвонити"
      summary={d ? <><b className="mc-red">{num(waiting.length)}</b> чекають{overDay > 0 ? `, ${num(overDay)} довше доби` : ""}{multiDay && !whole ? ` · за ${day.slice(8)}.${day.slice(5, 7)}` : ""}</> : null}>
      <div className="mc-tools">
        {chip("waiting", "Чекають", waiting.length)}
        {chip("all", "Усі", all.length)}
        {chip("mobile", "Лише мобільні", mobile.length)}
        <Hint text="«Чекають» — з номером досі немає розмови від 10 с (ні нашої, ні коли клієнт передзвонив сам); щойно поговорили, рядок зникає. «Що далі» — НАЙРАНІША подія після дзвінка. «Мобільний» — Ringostat переадресував дзвінок на мобільний менеджера. Кнопка «Задача» з'являється, коли минула доба без розмови. Дзвінків з номерів перевізників тут немає." />
        {multiDay && (
          <span className="mc-day">
            <button type="button" className="mc-chip" aria-pressed={whole} onClick={() => setSpan("period")}>Увесь період</button>
            <label className="mc-day">або день
              <input id="missed-list-day" type="date" value={whole ? "" : day} min={from} max={to}
                onChange={(e) => { if (e.target.value) { setDay(e.target.value); setSpan("day"); } }} />
            </label>
          </span>
        )}
        <div className="rv-grow" />
        {t.canAssign && (
          <button type="button" className="mc-btn" disabled={t.busy || picked.length === 0}
            onClick={() => { void t.assign(picked.map((u) => ({ uniqueid: u, ...(pick[u] ? { managerId: pick[u] } : {}) }))); setSel(new Set()); }}>
            Поставити задачі обраним{picked.length ? ` (${String(picked.length)})` : ""}
          </button>
        )}
      </div>
      {t.err && <p role="alert" className="mc-err mc-pad">⚠️ {t.err}</p>}
      {err && <p className="mc-err mc-pad">{err}</p>}
      {!err && !d && <p className="loading-text mc-pad">Завантаження…</p>}
      {d && d.truncated && <p className="mc-err mc-pad">Показано перші {num(all.length)} — список {scopeWord} довший і обрізаний{whole ? ". Оберіть день" : ""}.</p>}
      {d && rows.length === 0 && (
        <div className="mc-empty">
          {view === "waiting" ? (all.length ? "Усім передзвонили. Нових пропущених немає." : `Пропущених ${scopeWord} немає.`)
            : view === "mobile" ? `Пропущених на мобільні ${scopeWord} немає.` : `Пропущених ${scopeWord} немає.`}
        </div>
      )}
      {d && rows.length > 0 && (
        <div className="mc-scroll">
          <table className="mc-tbl mc-list">
            <thead><tr>
              {t.canAssign && <th className="mc-cb"><input type="checkbox" aria-label="Обрати всі"
                checked={assignable.length > 0 && assignable.every((r) => sel.has(r.uniqueid))}
                onChange={(e) => setSel(e.target.checked ? new Set(assignable.map((r) => r.uniqueid)) : new Set())} /></th>}
              <th>Дзвінок</th><th>Клієнт</th><th>Відповідальний</th><th className="mc-hm">Що далі</th><th className="r">Чекає</th><th />
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const n = nextLabel(r.next, r.nextMin);
                const cc = clientCell(r.clientKey, canOpenClient);
                const isOpen = openRow === r.uniqueid;
                const can = taskAssignable(t, r.uniqueid);
                const noTask = noTaskReason(t, r);
                return (
                  <Fragment key={r.uniqueid}>
                    <tr>
                      {t.canAssign && <td className="mc-cb">{can && <input type="checkbox" aria-label="Обрати" checked={sel.has(r.uniqueid)}
                        onChange={(e) => setSel((x) => { const y = new Set(x); if (e.target.checked) y.add(r.uniqueid); else y.delete(r.uniqueid); return y; })} />}</td>}
                      <td className="mc-nw">{r.at}{r.mobile && <span className="mc-tag" title="Усі плечі «Вхідний перехоплений»: дзвінок ішов на мобільний менеджера">мобільний</span>}</td>
                      <td className="mc-nw">
                        {r.phone ?? <span className="mc-m">номер не визначено</span>}
                        {r.dealUrl && <> · <a href={r.dealUrl} target="_blank" rel="noreferrer">угода</a></>}
                        {cc === "open" && <> · <button type="button" className="mc-link" onClick={() => setOpenRow(isOpen ? null : r.uniqueid)}>{isOpen ? "сховати картку" : "картка"}</button></>}
                        {cc === "unknown" && <span className="mc-m"> · не впізнано в CRM</span>}
                      </td>
                      <td><ManagerName managerId={r.managerId} name={r.managerName} /></td>
                      <td className={`mc-hm${n.bad ? " mc-m" : ""}`}>{n.text}</td>
                      <td className="r mc-nw">{r.waiting ? <b className="mc-red">{waitText(r.waitH)}</b> : <span className="mc-m" title="З номером уже була розмова від 10 с">—</span>}</td>
                      <td className="r">{noTask ? <span className="mc-m mc-why">{noTask}</span>
                        : <TaskCell uniqueid={r.uniqueid} managerId={r.managerId} t={t} pick={pick[r.uniqueid]}
                          onPick={(id) => setPick((p) => ({ ...p, [r.uniqueid]: id }))} managers={managers} />}</td>
                    </tr>
                    {isOpen && r.clientKey && (
                      <tr><td colSpan={t.canAssign ? 7 : 6} className="mc-cardrow"><ClientCardPanel clientKey={r.clientKey} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Fold>
  );
}

/* ───────────── ③ ПО КОМАНДАХ ───────────── */

type SortKey = "missed" | "pct" | "medianMin" | "waiting";

/**
 * 👥 ОДНА ТАБЛИЦЯ ЗАМІСТЬ ДВОХ (п.6 плану). Команди згорнуті, клік або Enter розгортає менеджерів. «Чекають» — те саме
 * число, що в смузі (`stillWaitingSql`). «Зміна» — п.п. % передзвону до попереднього такого самого періоду.
 * Рядок команди — з ядра (медіана по дзвінках команди), а не Σ людей на фронті: медіани не додаються.
 * «Без відповідального» — свій рядок унизу за будь-якого сортування: це не людина й не команда.
 */
function TeamsBlock({ d, prev, nav, norm, ownerless }: {
  d: MissedCallsResp; prev: MissedCallsResp | null; nav: PeriodState; norm: number | null; ownerless: MissedManagerRow[];
}) {
  const [sort, setSort] = useState<SortKey>("missed");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const s = d.summary;
  type Row = { missed: number; callbackSelf: number; callbackColleague: number; medianMin: number | null; waiting: number; name: string };
  const val = (r: Row): number => (sort === "pct" ? callbackPct(r) ?? -1 : sort === "medianMin" ? r.medianMin ?? -1 : r[sort]);
  const byVal = (a: Row, b: Row) => val(b) - val(a) || a.name.localeCompare(b.name, "uk");
  const table = useMemo(() => {
    const teams = [...d.teams].sort((a, b) => (a.teamId === null ? 1 : 0) - (b.teamId === null ? 1 : 0) || byVal(a, b));
    const { groups, orphans } = groupByTeam(teams, d.managers);
    for (const g of groups) g.people.sort(byVal);
    return { groups, orphans: orphans.sort(byVal) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, sort]);
  const prevTeam = new Map((prev?.teams ?? []).map((t) => [t.teamId, t]));
  const prevMgr = new Map((prev?.managers ?? []).map((m) => [m.managerId, m]));
  const totalPct = s.missed > 0 ? Math.round((s.callback / s.missed) * 100) : null;
  const prevTotalPct = prev && prev.summary.missed > 0 ? Math.round((prev.summary.callback / prev.summary.missed) * 100) : null;
  const ch = (cur: number | null, p: number | null | undefined) => {
    const v = prev ? changePp(cur, p ?? null) : null;
    return v == null ? <span className="mc-m">—</span> : <span className={v > 0 ? "mc-up" : v < 0 ? "mc-down" : "mc-m"}>{v > 0 ? "+" : v < 0 ? "−" : ""}{String(Math.abs(v))} п.п.</span>;
  };
  const pctCell = (p: number | null) => (
    <span className={norm != null && p != null ? (p >= norm ? "mc-up" : "mc-down") : undefined} title={norm != null ? normLabel(p, norm) : undefined}>{p == null ? "—" : `${String(p)}%`}</span>
  );
  const toggle = (k: string) => setOpen((x) => { const y = new Set(x); if (y.has(k)) y.delete(k); else y.add(k); return y; });
  const word = prevPeriodWord(nav.mode);
  const top = table.groups.filter((g) => g.team.teamId != null).sort((a, b) => b.team.missed - a.team.missed)[0];

  const copyRows: CopyRow[] = [
    { name: "Відділ", missed: s.missed, pct: totalPct, medianMin: s.medianMin, waiting: s.waiting, change: prev ? changePp(totalPct, prevTotalPct) : null },
    ...table.groups.map((g) => ({ name: g.team.name, missed: g.team.missed, pct: callbackPct(g.team), medianMin: g.team.medianMin, waiting: g.team.waiting,
      change: prev ? changePp(callbackPct(g.team), (() => { const p = prevTeam.get(g.team.teamId); return p ? callbackPct(p) : null; })()) : null })),
    ...ownerless.map((r) => ({ name: r.name, missed: r.missed, pct: callbackPct(r), medianMin: r.medianMin, waiting: r.waiting,
      change: prev ? changePp(callbackPct(r), (() => { const p = prevMgr.get(null); return p ? callbackPct(p) : null; })()) : null })),
  ];
  const copy = async () => {
    const text = teamsCopyText(d.period.from === d.period.to ? d.period.from : `${d.period.from} — ${d.period.to}`, copyRows);
    try { await navigator.clipboard.writeText(text); setCopied("ok"); } catch { setCopied(text); }
  };
  const th = (k: SortKey | null, label: string, hint?: string) => (
    <th className="r">{k ? <button type="button" className="mc-sort" aria-pressed={sort === k} onClick={() => setSort(k)}>{label}{sort === k ? " ↓" : ""}</button> : label}
      {hint && <> <Hint text={hint} /></>}</th>
  );
  const mgrRow = (r: MissedManagerRow, k: string, i = -1) => (
    <tr key={k} className={`mc-mgr${i >= 0 ? " mc-in" : ""}`} style={i >= 0 ? { animationDelay: `${String(i * 30)}ms` } : undefined}>
      <td><ManagerName managerId={r.managerId} name={r.name} /></td>
      <td className="r">{num(r.missed)}</td><td className="r">{pctCell(callbackPct(r))}</td>
      <td className="r">{durText(r.medianMin)}</td>
      <td className="r">{num(r.waiting)}</td><td className="r">{ch(callbackPct(r), (() => { const p = prevMgr.get(r.managerId); return p ? callbackPct(p) : null; })())}</td>
    </tr>
  );
  return (
    <Fold id="c-teams" defaultOpen title="По командах"
      summary={top ? <>найбільше пропущених: {top.team.name} <b>{num(top.team.missed)}</b> · клік по команді — менеджери</> : "клік по команді — менеджери"}
      tools={<button type="button" className="mc-btn2" onClick={() => { void copy(); }}>Скопіювати для звіту</button>}>
      <p className="mc-note mc-pad">«Зміна» — до попереднього {word}. Тиждень для звіту — перемикач «Тиждень» угорі й стрілка «‹».</p>
      {copied === "ok" && <p className="mc-ok mc-pad" role="status">Скопійовано — вставте в чат.</p>}
      {copied && copied !== "ok" && <textarea readOnly value={copied} className="mc-copy" />}
      <div className="mc-scroll mc-noscroll">
        <table className="mc-tbl mc-teams">
          <thead><tr>
            <th>Команда</th>
            {th("missed", "Пропущено")}
            {th("pct", "Передзвонили", "Частка пропущених, яким за 24 год передзвонили з розмовою від 10 с: сам відповідальний або колега.")}
            {th("medianMin", "Медіана", "Час до передзвону, медіана по дзвінках команди. Медіани не додаються, тому в рядку «Відділ» — медіана всього періоду.")}
            {th("waiting", "Чекають", "З номером досі немає розмови від 10 с — те саме число, що в смузі вгорі.")}
            <th className="r">Зміна <Hint text={`Різниця % передзвону з попереднім ${word === "періоду" ? "таким самим періодом" : word} (п.п.). «—» — порівнювати нема з чим.`} /></th>
          </tr></thead>
          <tbody>
            {table.groups.map((g) => {
              const k = `team-${String(g.team.teamId)}`;
              const isOpen = open.has(k);
              const p = prevTeam.get(g.team.teamId);
              return (
                <Fragment key={k}>
                  <tr className="mc-team" tabIndex={0} role="button" aria-expanded={isOpen} onClick={() => toggle(k)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(k); } }}>
                    <td><span className="mc-tchev" aria-hidden="true">▸</span>{g.team.name}</td>
                    <td className="r">{num(g.team.missed)}</td><td className="r">{pctCell(callbackPct(g.team))}</td>
                    <td className="r">{durText(g.team.medianMin)}</td>
                    <td className="r">{g.team.waiting > 0 ? <b className="mc-red">{num(g.team.waiting)}</b> : num(g.team.waiting)}</td>
                    <td className="r">{ch(callbackPct(g.team), p ? callbackPct(p) : null)}</td>
                  </tr>
                  {isOpen && g.people.map((r, i) => mgrRow(r, `m-${String(r.managerId)}`, i))}
                </Fragment>
              );
            })}
            {table.orphans.map((r) => mgrRow(r, `o-${String(r.managerId)}`))}
            {ownerless.map((r) => (
              <tr key="ownerless" className="mc-mrow">
                <td className="mc-m">{r.name}</td>
                <td className="r">{num(r.missed)}</td><td className="r">{pctCell(callbackPct(r))}</td>
                <td className="r">{durText(r.medianMin)}</td>
                <td className="r">{r.waiting > 0 ? <b className="mc-red">{num(r.waiting)}</b> : num(r.waiting)}</td>
                <td className="r">{ch(callbackPct(r), (() => { const p = prevMgr.get(null); return p ? callbackPct(p) : null; })())}</td>
              </tr>
            ))}
            <tr className="mc-total">
              <td>Відділ</td><td className="r">{num(s.missed)}</td><td className="r">{pctCell(totalPct)}</td>
              {/* Медіани не додаються: тут медіана всього періоду з підсумку, а не з рядків. */}
              <td className="r">{durText(s.medianMin)}</td>
              <td className="r">{num(s.waiting)}</td><td className="r">{ch(totalPct, prevTotalPct)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Fold>
  );
}

/* ───────────── ④ ДЕТАЛЬНІШЕ ───────────── */

function DetailsBlock({ d, fp }: { d: MissedCallsResp; fp: MissedFilterParams }) {
  const s = d.summary;
  const [nd, setNd] = useState<NoDealCounts | null>(null);
  const a = d.automation;
  const closed = a ? a.closedCallback + a.closedCarrier + a.closedClientSelf : 0;
  return (
    <Fold id="c-more" title="Детальніше" summary="динаміка, години, дзвінок без угоди, автозадачі">
      <div className="mc-more">
        <Fold id="m-dyn" nested lazy title="Динаміка" summary="графік по днях, тижнях і місяцях за всю історію">
          <MissedDynamicsBlock fp={fp} />
        </Fold>
        <Fold id="m-hours" nested title="Коли пропускаємо"
          summary={<>робочий час <b>{num(s.buckets.work)}</b>, вечір {num(s.buckets.evening)}, ніч {num(s.buckets.night)}, вихідні {num(s.buckets.weekend)}</>}>
          <div className="mc-inner">
            <div className="mc-minis">
              {BUCKETS.map((b) => (
                <Tile key={b.key} label={b.label} value={num(s.buckets[b.key])} sub={pct(s.buckets[b.key], s.missed)} hint={b.hint} />
              ))}
            </div>
            {/* ТЗ §1.2: «вихідні = Сб/Нд, і це написано на екрані у виносці» — видимо, а не лише в підказці. */}
            <p className="mc-note">
              Час — за Києвом. Вихідні — субота й неділя; державні свята не враховуються (календар свят порожній),
              тож свято в будній день рахується як звичайний день.
            </p>
          </div>
        </Fold>
        <Fold id="m-nodeal" nested title="Дзвінок був, а угоди немає"
          summary={nd ? <><b>{num(nd.noDeal)}</b> без заявки за тиждень, {num(nd.unknown)} номерів не знайдено в CRM</> : null}>
          <NoDealBlock from={d.period.from} to={d.period.to} fp={fp} onCounts={setNd} />
        </Fold>
        {/* 🤖 Контроль ТЗ «автозакриття пропущених» (задача 4373): завжди 7 днів від сьогодні — не обраний період, і це в заголовку. */}
        {a && (
          <Fold id="m-auto" nested title={`Автозадачі за ${String(a.days)} днів`}
            summary={<>відкрито <b>{num(a.openNow)}</b>, закрито автоматично {num(closed)}</>}>
            <div className="mc-inner">
              <p className="mc-note">Завжди останні 7 днів до сьогодні, незалежно від обраного періоду.
                <Hint text="Перевізник за історією CRM — номер уже закривали як «Перевізник» і немає угоди замовника в «Успіх» чи в роботі. Біржа Lardi-Trans не відповідає з 28.09, тож частина перевізників сюди не потрапляє." /></p>
              <div className="mc-minis">
                <Tile label="Відкрито зараз" value={num(a.openNow)} sub="задач «передзвони»" hint="Задачі «передзвони», які зараз чекають на передзвін — у вашому зрізі." />
                <Tile label="Закрито: передзвонили" value={num(a.closedCallback)} sub="розмова від 10 с" hint="Задача закрилась сама: з номера компанії поговорили з клієнтом від 10 с. Хто й коли — у самій задачі." />
                <Tile label="Закрито: клієнт сам" value={num(a.closedClientSelf)} sub={`ще в «Успіху»: ${num(a.closedSuccess)}`}
                  hint="Відкриту задачу «передзвонити» закрито: клієнт сам передзвонив і з ним поговорили від 10 с, або угода цього номера після пропущеного перейшла в «Успішно реалізовано». У відсоток «Передзвонили за 24 год» це НЕ входить — це не наш передзвін." />
                <Tile label="Закрито: перевізник" value={num(a.closedCarrier)} sub="за історією CRM" hint="Відкриту задачу закрито: номер виявився перевізником за історією CRM. Помилка — відкрийте задачу знову." />
                <Tile label="Не поставлено: перевізник" value={num(a.skippedCarrier)} sub="задач «передзвони»" hint="Пропущений від номера, який у CRM уже закривали як «Перевізник», — задачу менеджеру не ставили." />
                {a.dealsHistory != null && (
                  <Tile label="Угоди: історія CRM" value={num(a.dealsHistory)} sub="у журналі «Відсіву»"
                    hint="Угоди етапу «Дзвінки на мобільні» з вердиктом «історія CRM». Список — вкладка «Перевізники за розмовою»: джерело «історія CRM»." />
                )}
              </div>
            </div>
          </Fold>
        )}
      </div>
    </Fold>
  );
}

/* ───────────── блоки «Детальніше» і «Відповідь на заявку» ───────────── */

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
function MissedDynamicsBlock({ fp }: { fp: MissedFilterParams }) {
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
    fetchMissedSeries({ granularity: gran, ...fp })
      .then((r) => { if (alive) setResp(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gran, JSON.stringify(fp)]);

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
    <div className="mc-inner">
      <p className="mc-note">
        Уся історія дзвінків; від періоду вгорі не залежить.
        <Hint text={"Пропущені по днях, тижнях чи місяцях за всю історію дзвінків (з 01.09.2025). Остання точка — вчора: частка «не передзвонили» за останню добу ще може зменшитись, доки не мине 24 години на передзвін. "
          + "Серії — уся компанія (або ваш зріз), кожна команда за поточним складом, «Поза командами» і «Без відповідального»; у кожній точці Σ серій = «Усього»."} />
      </p>
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
function NoDealBlock({ from, to, fp, onCounts }: { from: string; to: string; fp: MissedFilterParams; onCounts?: (c: NoDealCounts | null) => void }) {
  const [c, setC] = useState<NoDealCounts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<NoDealState | null>(null);
  const [list, setList] = useState<{ truncated: boolean; rows: NoDealListRow[] } | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setC(null); setErr(null); setOpen(null); setList(null);
    fetchNoDeal({ from, to, ...fp })
      .then((r) => { if (alive) setC(r.counts); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, JSON.stringify(fp)]);

  // Число в заголовку згорнутого блоку — з тієї самої відповіді, що й плитки (без другого запиту).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onCounts?.(c); }, [c]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(null); setListErr(null);
    fetchNoDealList({ from, to, state: open, ...fp })
      .then((r) => { if (alive) setList({ truncated: r.truncated, rows: r.rows }); })
      .catch((e) => { if (alive) setListErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from, to, JSON.stringify(fp)]);

  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };
  const talk = (sec: number) => `${String(Math.floor(sec / 60))}:${String(sec % 60).padStart(2, "0")}`;

  return (
    <div className="mc-inner">
      <p className="mc-note">
        Вхідні, на які відповіли, у трьох станах. Натисніть на число, щоб побачити дзвінки.
        <Hint text="Вхідні дзвінки, на які відповіли, розкладені на три стани. Натисніть на число, щоб побачити самі дзвінки." />
      </p>
      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!err && !c && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {c && (
        <>
          <p className="mc-note">Відповіданих вхідних за період: {c.answered.toLocaleString("uk-UA")}</p>
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
                    {t.label} <Hint text={t.hint} />
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

/**
 * 📞 «ВІДПОВІДЬ НА ЗАЯВКУ» (задача 5148, ТЗ Юлі 05.10.2026; рішення Романа 12.10.2026). Від створення заявки до
 * ПЕРШОГО НАБОРУ менеджера — медіана; нічна заявка рахується від 08:15. Відділ = реклама + сайт, лідгени — окремо й у
 * медіану відділу не входять. «Не взяв трубку» — перший набір тривав 0 с. Числа рахує сервер (`core/leadResponse.ts`).
 */
/** `filtered` — на екрані стоїть фільтр команд: цей блок його не бере (своя розбивка по командах на дату заявки), і це сказано словами. */
function ResponseTimeBlock({ from, to, filtered }: { from: string; to: string; filtered: boolean }) {
  const [r, setR] = useState<ResponseTimeResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    setR(null); setErr(null);
    fetchLeadResponse({ from, to })
      .then((x) => { if (alive) setR(x); })
      .catch((e) => { if (alive) setErr(String((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? e)); });
    return () => { alive = false; };
  }, [from, to]);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };
  const n = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA"));
  const noAns = (x: ResponseLineT) => (x.answerUnknown > 0 && x.answerUnknown === x.dialed ? "невідомо"
    : `${n(x.noAnswer)}${x.answerUnknown > 0 ? ` (+${n(x.answerUnknown)} невідомо)` : ""}`);
  const Row = ({ x, bold = false, indent = 0, onClick, openMark }: { x: ResponseLineT; bold?: boolean; indent?: number; onClick?: () => void; openMark?: boolean }) => (
    <tr onClick={onClick} style={{ borderBottom: "1px solid var(--border)", cursor: onClick ? "pointer" : "default", fontWeight: bold ? 600 : 400,
      background: bold ? "var(--bg)" : undefined }}>
      <td style={{ ...cell, textAlign: "left", paddingLeft: 10 + indent * 18 }}>{openMark != null ? (openMark ? "▾ " : "▸ ") : ""}{x.label}</td>
      <td style={cell}>{n(x.n)}</td>
      <td style={cell}>{n(x.dialed)}</td>
      <td style={{ ...cell, color: x.notDialed > 0 ? "var(--danger, #c8102e)" : undefined }}>{n(x.notDialed)}</td>
      <td style={{ ...cell, fontWeight: 600 }}>{x.medianMin == null ? "—" : `${x.medianMin} хв`}</td>
      <td style={cell}>{x.m5Pct == null ? "—" : `${x.m5Pct}%`}</td>
      <td style={cell}>{noAns(x)}</td>
    </tr>
  );
  const team = (t: ResponseTeamT, bold: boolean) => (
    <Fragment key={t.key}>
      <Row x={t} bold={bold} onClick={() => toggle(t.key)} openMark={open.has(t.key)} />
      {open.has(t.key) && t.managers.map((m) => <Row key={m.key} x={m} indent={1} />)}
    </Fragment>
  );
  return (
    <div className="mc-inner">
      <p className="mc-note">
        Від створення заявки до першого набору менеджера.
        <Hint text="Від створення заявки до ПЕРШОГО набору менеджера, навіть якщо клієнт не взяв трубку. Медіана, а не середнє: кілька заявок, яким передзвонили через дні, тягнуть середнє в десятки разів угору. Заявка, створена в неробочий час, рахується від 08:15 найближчого робочого дня — як у вікні «Час опрацювання заявки». Заявки — реклама (uts.ua) і сайт (yalogist); лідгени — окремим рядком і в медіану відділу не входять." />
      </p>
      <p className="mc-note">Період: {from} — {to} · за датою створення заявки · команда — на дату створення
        {filtered && <b style={{ color: "var(--text)" }}> · фільтр команд екрана на цей блок не діє — розбивка по командах нижче</b>}</p>
      {err && <p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>}
      {!r && !err && <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>}
      {r && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
            <Tile label="Медіана відповіді" value={r.dept.medianMin == null ? "—" : `${r.dept.medianMin} хв`} sub={`${n(r.dept.dialed)} із ${n(r.dept.n)} заявок`}
              hint="Від створення заявки до першого набору менеджера, медіана по відділу (реклама + сайт)." />
            <Tile label="Набрали за 5 хв" value={r.dept.m5Pct == null ? "—" : `${r.dept.m5Pct}%`} sub="від усіх заявок відділу"
              hint="Частка ВСІХ заявок відділу, яким менеджер набрав не пізніше 5 хв від створення (нічні — від 08:15)." />
            <Tile label="Без набору" value={n(r.dept.notDialed)} sub="заявок відділу"
              hint="Заявки, по яких вихідного дзвінка не знайдено ні в Kommo, ні в Ringostat." />
            <Tile label="Не взяв трубку з першого разу" value={noAns(r.dept)} sub="перший набір 0 с"
              hint="Менеджер набрав, а клієнт не відповів (тривалість першого дзвінка 0 с). «Невідомо» — тривалість не збережена (історія до 12.10.2026)." />
            <Tile label="Лідгени (окремо)" value={r.leadgen.medianMin == null ? "—" : `${r.leadgen.medianMin} хв`} sub={`${n(r.leadgen.dialed)} із ${n(r.leadgen.n)} заявок`}
              hint="Передані з відділу лідгенерації. Рахуються окремо й у медіану відділу не входять." />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...head, textAlign: "left" }}>Команда / менеджер</th>
                  <th style={head}>Заявок</th>
                  <th style={head}>З набором</th>
                  <th style={head}>Без набору</th>
                  <th style={head}>Медіана</th>
                  <th style={head}>До 5 хв</th>
                  <th style={head}>Не взяв трубку</th>
                </tr>
              </thead>
              <tbody>
                {r.teams.map((t) => team(t, false))}
                <Row x={r.dept} bold />
                {r.leadgen.n > 0 && team(r.leadgen, true)}
              </tbody>
            </table>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Клік по команді — її менеджери. Медіани не додаються: рядок відділу рахується по всіх його заявках.</p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint: string }) {
  return (
    <div className="mc-mini">
      <div className="mc-kl">{label} <Hint text={hint} /></div>
      <b>{value}</b>
      {sub && <div className="mc-ks">{sub}</div>}
    </div>
  );
}

/**
 * 📄 «ПРОПУЩЕНІ УГОДИ» — друга вкладка екрана (рішення Романа 20.11.2026, «правильні пропущені» п.5; словник §11a).
 * Пропущена угода — угода Kommo, яку створив вхідний дзвінок, а за 5 хв від нього не було ні розмови, ні нового
 * дзвінка (нашого будь-якого чи нового вхідного). Число, таблиця і список приходять ОДНИМ запитом і одним правилом.
 * Вигляд — той самий, що на вкладці дзвінків (редизайн 20.11.2026): смуга чисел, список, згорнуті таблиця й
 * «Відповідь на заявку» (п.9 плану: це швидкість реакції на заявку, тобто на угоду, тож блок стоїть тут).
 */
function MissedDealsBlock({ from, to, fp }: { from: string; to: string; fp: MissedFilterParams }) {
  const [d, setD] = useState<MissedDealsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"open" | "all">("open");
  const fpKey = JSON.stringify(fp);
  const filtered = fpKey !== "{}";
  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    setD(null); setErr(null);
    fetchMissedDeals({ from, to, ...fp })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fpKey]);
  if (err) return <p className="mc-err">{err}</p>;
  if (!d) return <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>;
  const s = d.summary;
  const missedPct = s.deals > 0 ? Math.round((s.missed / s.deals) * 100) : null;
  const open = d.rows.filter((r) => r.next !== "talked");
  const rows = view === "open" ? open : d.rows;
  const top = d.managers.filter((m) => m.managerId != null).sort((a, b) => b.missed - a.missed)[0];
  return (
    <>
      <div className="mc-card">
        <div className="mc-hero">
          <div className="mc-k">
            <div className="mc-kl">Угод із вхідного дзвінка <Hint text="Угоди, створені вхідним дзвінком за період (Kommo створює угоду одразу на дзвінок)." /></div>
            <div className="mc-kv"><CountUp value={s.deals} /></div>
            <div className="mc-ks">за обраний період</div>
          </div>
          <div className="mc-k mc-act">
            <div className="mc-kl">Пропущені угоди <Hint text={
              "Угода, яку створив вхідний дзвінок, а за 5 хвилин від дзвінка з цим номером не було ні розмови, ні нового дзвінка: "
              + "ні нашого вихідного (навіть без відповіді), ні нового вхідного. Відповідальний — відповідальний за угоду в Kommo."} /></div>
            <div className="mc-kv"><CountUp value={s.missed} /></div>
            <div className="mc-ks">{missedPct == null ? "—" : `${String(missedPct)}%`}: за 5 хв ні розмови, ні нового дзвінка</div>
          </div>
          <div className="mc-k">
            <div className="mc-kl">Поговорили пізніше <Hint text="З пропущених угод — скільки разом із номером згодом була розмова від 10 с (до сьогодні)." /></div>
            <div className="mc-kv"><CountUp value={s.talkedLater} /></div>
            <div className="mc-ks">з {num(s.missed)} пропущених ({pct(s.talkedLater, s.missed)})</div>
          </div>
          <div className="mc-k">
            <div className="mc-kl">Досі без розмови <Hint text="Пропущені угоди, з номером яких досі не було розмови від 10 с — ні нашої, ні вхідної." /></div>
            <div className="mc-kv">{num(open.length)}</div>
            <div className="mc-ks">{d.truncated ? "у показаній частині списку" : "кому передзвонити"}</div>
          </div>
        </div>
        <div className="mc-foot">
          Не входять: угоди перевізників {num(s.carriers)}. Ще рахуються (менше 5 хв від дзвінка): {num(s.pending)}.
          {" "}{d.ownerlessInScope ? <>Без відповідального: {num(s.ownerless)}.</> : <>Без відповідального — не входять у зріз команди.</>}
        </div>
      </div>

      <Fold id="d-list" defaultOpen title="Пропущені угоди" summary={<><b className="mc-red">{num(open.length)}</b> досі без розмови</>}>
        <div className="mc-tools">
          <button type="button" className="mc-chip" aria-pressed={view === "open"} onClick={() => setView("open")}>Досі без розмови {num(open.length)}</button>
          <button type="button" className="mc-chip" aria-pressed={view === "all"} onClick={() => setView("all")}>Усі {num(d.rows.length)}</button>
          <Hint text="Кожна пропущена угода періоду, від найновішої. «Що далі» — перша розмова від 10 с з номером після дзвінка, або лише наш набір без розмови, або нічого досі." />
        </div>
        {d.truncated && <p className="mc-err mc-pad">Показано перші {num(d.rows.length)} — список за період довший і обрізаний. Звузьте період.</p>}
        {rows.length === 0 ? <div className="mc-empty">{view === "open" ? "З усіма поговорили." : "Пропущених угод за період немає."}</div> : (
          <div className="mc-scroll">
            <table className="mc-tbl mc-list">
              <thead><tr><th>Дзвінок</th><th>Номер</th><th>Відповідальний</th><th>Що далі</th><th className="r">Угода</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const n = dealNextLabel(r.next, r.nextMin);
                  return (
                    <tr key={r.dealId}>
                      <td className="mc-nw">{r.at}</td><td className="mc-nw">{r.phone}</td>
                      <td>{r.managerId === null ? <span className="mc-m">{r.managerName}</span> : r.managerName}</td>
                      <td className={n.bad ? "mc-m" : undefined}>{n.text}</td>
                      <td className="r"><a href={r.dealUrl} target="_blank" rel="noreferrer">угода в CRM</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Fold>

      <Fold id="d-mgr" title="По менеджерах" summary={top ? <>найбільше пропущених: {top.name} <b>{num(top.missed)}</b></> : "за період угод із дзвінка немає"}>
        {d.managers.length === 0 ? <div className="mc-empty">За період угод із вхідного дзвінка немає.</div> : (
          <div className="mc-scroll mc-noscroll">
            <table className="mc-tbl">
              <thead><tr>
                <th>Менеджер</th><th className="mc-hm">Команда</th>
                <th className="r">Угод із дзвінка</th><th className="r">Пропущено</th><th className="r">%</th><th className="r">Поговорили пізніше</th>
              </tr></thead>
              <tbody>
                {d.managers.map((r) => (
                  <tr key={r.managerId ?? "ownerless"}>
                    <td>{r.managerId === null ? <span className="mc-m">{r.name}</span> : r.name}</td>
                    <td className="mc-hm mc-m">{r.teamName ?? (r.managerId === null ? "—" : "поза командами")}</td>
                    <td className="r">{num(r.deals)}</td><td className="r">{num(r.missed)}</td>
                    <td className="r">{pct(r.missed, r.deals)}</td><td className="r">{num(r.talkedLater)}</td>
                  </tr>
                ))}
                <tr className="mc-total">
                  <td>Усього</td><td className="mc-hm" />
                  <td className="r">{num(s.deals)}</td><td className="r">{num(s.missed)}</td>
                  <td className="r">{pct(s.missed, s.deals)}</td><td className="r">{num(s.talkedLater)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Fold>

      {/* 📞 5148: «один екран по швидкості реакції». Тут — бо це реакція на заявку, тобто на угоду (п.9 плану). */}
      <Fold id="d-resp" title="Відповідь на заявку" summary="медіана від заявки до першого набору, по командах">
        <ResponseTimeBlock from={d.period.from} to={d.period.to} filtered={filtered} />
      </Fold>
    </>
  );
}

function dealNextLabel(kind: MissedDealNext, min: number | null): { text: string; bad: boolean } {
  const m = min == null ? "" : ` через ${durText(min)}`;
  switch (kind) {
    case "talked": return { text: `поговорили${m}`, bad: false };
    case "attempt": return { text: `набирали${m}, без розмови`, bad: true };
    case "nothing": return { text: "досі ні розмови, ні нашого дзвінка", bad: true };
  }
}

