import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./firstTouch.css";
import { fetchAiCalls, fetchAiCallsMeta, type AiCallsResp, type AiCallsMetaResp } from "../../../api";
import { AiCallDrawer } from "./AiCallDrawer";
import { FirstTouchQueue } from "./FirstTouchQueue";
import { AnimatedNumber } from "./AnimatedNumber";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { STATE_UI, TONE_COLOR, FILTERS, matchesFilter, mmss, aiDefaultPeriod, jobErrorIsCurrent, parseCallParam, withCallParam,
  PROMISE_UI, GROUP_LABEL, applyListFilter, type ListFilter, type PipelineGroupT,
  TYPE_LABEL, tabRows, type ListTab, type ConversationTypeT,
  type AiFilter, type AiCallState,
  CHECK_ITEMS, CHECK_MARK_UI, managerChecklist, queueRows, scoreLabel, medianMin, fmtMinutes,
  TILE_MATCH, tileStats, priceSuccessSplit, SUCCESS_MIN_FOR_PCT, type TileKey } from "../aiCallsView";

/**
 * 🎧 «ПЕРШИЙ ДОТИК · AI» — прохід 1, лише перегляд (рішення Романа 28.09.2026, макет — на ньому).
 *
 * 🆕 ЕКРАН D (Роман 08.10.2026, макет «D · Огляд + черга розбору», «майже 1 в 1»): смуга черги розбору, пʼять чисел,
 * менеджери за чек-листом з 3 пунктів (запит · ціна · обіцянка), таблиця з квадратами чек-листа й колонкою «Розбір».
 * Черга (розкладка B) відкривається поверх і згортається назад у смугу. Стани пунктів і «потребує розбору» — від
 * сервера (`core/firstTouchTeamReport.ts`); тут їх лише складають.
 *
 * Що є: перші розмови рекламних угод (правило — METRICS_GLOSSARY §15), витяг моделі з дослівними
 * цитатами, позначка «звірено з розшифровкою», факт Ringostat про наш наступний вихідний, стан
 * конвеєра й витрати. Чого немає свідомо: розбору тімліда, повернення угоди (П21), балу (після
 * калібрування), запису в Kommo. Повний текст розмови бачать адмін, КВП, CEO й опдир — сервер його
 * просто не віддає іншим, тож тут лише показуємо те, що прийшло.
 */

const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const usd = (v: number) => `$${v.toFixed(2)}`;

function StateChip({ state }: { state: AiCallState }) {
  const ui = STATE_UI[state];
  const c = TONE_COLOR[ui.tone];
  return <span title={ui.hint} style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: "1px 8px", fontSize: 12, whiteSpace: "nowrap" }}>{ui.label}</span>;
}

/** Скелет на час завантаження — та сама розкладка, що й екран (смуга, пʼять плиток, менеджери, таблиця), щоб нічого не стрибало. */
function FirstTouchSkeleton({ navBar, drawer }: { navBar: React.ReactNode; drawer: React.ReactNode }) {
  const sk = (w: string | number, h: number, extra: React.CSSProperties = {}) => <span className="ftd-sk" style={{ width: w, height: h, ...extra }} />;
  return (
    <div className="ftd" aria-busy="true" aria-label="Завантаження «Першого дотику»">
      <div className="ftd-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="ftd-kicker">Продаж · перші розмови з реклами</div>
          <h1 className="ftd-title">Перший дотик · AI</h1>
          {sk(420, 12)}
        </div>
        <div className="ftd-nav">{navBar}</div>
      </div>
      <div className="ftd-strip" aria-hidden="true">{sk("40%", 22, { background: "#2c2e36" })}<span style={{ flex: 1 }} />{sk(160, 44, { background: "#2c2e36", borderRadius: 8 })}</div>
      <div className="ftd-kpis" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="ftd-kpi">{sk("70%", 12)}{sk("45%", 28, { margin: "6px 0" })}{sk("60%", 12)}</div>)}
      </div>
      <div className="ftd-card ftd-card-pad" aria-hidden="true">
        {sk(320, 16)}
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "210px 64px repeat(4, minmax(80px, 1fr)) 80px", gap: 14 }}>
          {sk("80%", 14)}{sk(36, 14)}{sk("100%", 18)}{sk("100%", 18)}{sk("100%", 18)}{sk("100%", 18)}{sk(40, 14)}</div>)}
      </div>
      <div className="ftd-card" aria-hidden="true">
        <div className="ftd-toolbar">{sk(260, 30, { borderRadius: 8 })}{sk(120, 28, { borderRadius: 999 })}{sk(120, 28, { borderRadius: 999 })}</div>
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 150px minmax(0, 1fr) 90px 110px 80px 70px 90px", gap: 12, padding: "14px 16px", borderTop: "1px solid var(--border)" }}>
          {sk("90%", 14)}{sk("80%", 14)}{sk("95%", 14)}{sk(70, 14)}{sk(90, 18, { borderRadius: 999 })}{sk(60, 18, { borderRadius: 999 })}{sk(40, 14)}{sk(70, 14)}</div>)}
      </div>
      <span className="ftd-sr">Завантаження…</span>
      {drawer}
    </div>
  );
}

export function AiCallsSection() {
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>(() => aiDefaultPeriod(today));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<AiCallsResp | null>(null);
  const [meta, setMeta] = useState<AiCallsMetaResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Після ручної зміни типу список перечитується: розмова переходить між «Звітом» і «Виключеними».
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<AiFilter>("all");
  // П8-Б: воронка, команда, менеджер; нецільові («Дубль», «Перевізник») сховані, їх число — у перемикачі.
  const [lf, setLf] = useState<ListFilter>({ group: "all", teamId: null, managerId: null, showNonTarget: false });
  const [silenceOnly, setSilenceOnly] = useState(false);
  // Відкрита картка живе в адресі (`?call=`): посилання можна переслати, і воно відкриє ту саму картку.
  const [open, setOpenState] = useState<string | null>(() => parseCallParam(window.location.search));
  const setOpen = useCallback((uniqueid: string | null) => {
    setOpenState(uniqueid);
    window.history.replaceState(window.history.state, "", withCallParam(window.location.href, uniqueid));
  }, []);
  const closeCard = useCallback(() => setOpen(null), [setOpen]);
  // Черга розбору (розкладка B) — поверх огляду; закриття згортає її в смугу (`.ftd-queue.is-closed`).
  const [queueOpen, setQueueOpen] = useState(false);
  const periodKey = useRef("");
  // Новий період: старі цифри лишаються (напівпрозорі, «Оновлюю…»), а щойно прийдуть нові — плитки перетікають до них.
  // Скелет — лише на першому відкритті, коли показати ще нічого (Роман 08.10.2026).
  const [stale, setStale] = useState(false);
  const topRef = useRef<HTMLDivElement | null>(null);
  const [queueSel, setQueueSel] = useState<string | null>(null);
  const [glow, setGlow] = useState(false);
  const [preset, setPreset] = useState<"all" | TileKey>("all");
  const tableRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<"all" | "todo">("all");
  const [q, setQ] = useState("");
  // Згортання блоку «Менеджери за чек-листом» — пам'ятаємо в браузері (лише зручність, не дані).
  const [mgrCollapsed, setMgrCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("ftd.mgrCollapsed") === "1"; } catch { return false; } });
  const toggleMgr = () => setMgrCollapsed((v) => { try { localStorage.setItem("ftd.mgrCollapsed", v ? "0" : "1"); } catch { /* приватне вікно */ } return !v; });

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    // Перечитування після розбору (`reload`) оновлює дані на місці: інакше «Завантаження…» знімало б чергу посеред роботи.
    if (periodKey.current !== `${from}|${to}`) { setStale(true); periodKey.current = `${from}|${to}`; }
    setErr(null);
    fetchAiCalls({ from, to })
      .then((x) => { if (alive) { setD(x); setStale(false); } })
      .catch((e) => { if (alive) { setStale(false); setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); } });
    return () => { alive = false; };
  }, [from, to, reload]);
  useEffect(() => { fetchAiCallsMeta().then(setMeta).catch(() => setMeta(null)); }, []);

  // ТЗ 30.09.2026: «Звіт» — запити на перевезення (і непевні з позначкою), «Виключені» — решта, з фільтром за типом.
  const [tab, setTab] = useState<ListTab>("report");
  const [exType, setExType] = useState<ConversationTypeT | "all">("all");
  const scopedAll = useMemo(() => (d ? applyListFilter(d.rows, lf) : []), [d, lf]);
  const scoped = useMemo(() => tabRows(scopedAll, tab, exType), [scopedAll, tab, exType]);
  // П3: прапорець «тиша» — лише з дати оголошення норми; до того фільтра немає зовсім.
  const normFrom = d?.silence.normFrom ?? null;
  const shown = useMemo(() => scoped.filter((r) => matchesFilter(r, filter)
    && (!silenceOnly || (normFrom != null && r.silentBeforeClose === true && r.dealCreatedAt.slice(0, 10) >= normFrom))), [scoped, filter, silenceOnly, normFrom]);

  const navBar = <PeriodNav state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />;
  const drawer = open ? <AiCallDrawer uniqueid={open} onClose={closeCard} onChanged={() => setReload((x) => x + 1)} /> : null;
  if (err) return <div className="chart-card">{navBar}<p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>{drawer}</div>;
  if (!d) return <FirstTouchSkeleton navBar={navBar} drawer={drawer} />;

  // Плитки й підсумки рахуються лише по ЗВІТУ: виключене сміття не розмиває відсотки (ТЗ 30.09.2026).
  const rows = tabRows(scopedAll, "report");
  const excludedCount = tabRows(scopedAll, "excluded").length;
  const done = rows.filter((r) => r.state === "done");
  const nonTargetHidden = applyListFilter(d.rows, { ...lf, showNonTarget: true }).length - applyListFilter(d.rows, { ...lf, showNonTarget: false }).length;
  const groupCount = (g: PipelineGroupT | "all") => applyListFilter(d.rows, { ...lf, group: g }).length;
  const teams = [...new Map(d.rows.filter((r) => r.teamId != null).map((r) => [r.teamId!, r.teamName ?? `Команда #${String(r.teamId)}`])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "uk"));
  const managers = [...new Map(d.rows.filter((r) => r.managerId != null && (lf.teamId == null || r.teamId === lf.teamId))
    .map((r) => [r.managerId!, r.managerName ?? `Менеджер #${String(r.managerId)}`])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk"));
  const byState = new Map<AiCallState, number>();
  for (const r of rows) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);

  // Плитки (ТЗ 08.10.2026): число і список після кліку — одне правило `TILE_MATCH`; стани й знаменники — від сервера.
  const ts = tileStats(rows);
  const split = priceSuccessSplit(rows);
  const target = d.priceTargetPct;
  const lost = rows.filter(TILE_MATCH.lost);
  const lostReact = medianMin(lost.map((r) => r.reactionMin));
  // Блок менеджерів — по всій команді, без фільтра «менеджер»: інакше після кліку лишався один рядок і повернутись було нікуди.
  const lines = managerChecklist(tabRows(applyListFilter(d.rows, { ...lf, managerId: null }), "report"));
  const pickedName = lf.managerId != null ? (lines.find((l) => l.managerId === lf.managerId)?.name ?? managers.find(([id]) => id === lf.managerId)?.[1] ?? "менеджер") : null;
  const weakest = lines.find((l) => l.score != null) ?? null;

  // Черга розбору: прапорець сервера; лічильник «розібрано N з M» — серед тих, що потребували розбору.
  const queue = queueRows(rows);
  const dueTotal = rows.filter((r) => r.reviewReason != null).length;
  const reviewedN = dueTotal - queue.length;
  const reasonN = (k: "noCall" | "noPrice" | "lost") => queue.filter((r) => r.reviewReason === k).length;
  const openQueue = (uniqueid?: string) => {
    setQueueSel(uniqueid ?? queue[0]?.uniqueid ?? null); setQueueOpen(true); setGlow(false);
    topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const closeQueue = () => { setQueueOpen(false); setGlow(true); window.setTimeout(() => setGlow(false), 900); };
  const teamTitle = lf.teamId != null ? (teams.find(([id]) => id === lf.teamId)?.[1] ?? "команда") : "усі команди";

  const presetOk = (r: (typeof rows)[number]) => preset === "all" || TILE_MATCH[preset](r);
  const needle = q.trim().toLowerCase();
  const shownD = shown.filter((r) => (view === "all" || r.needsReview) && presetOk(r)
    && (!needle || `${r.summary ?? ""} ${r.managerName ?? ""} ${r.priceValue ?? ""}`.toLowerCase().includes(needle)));
  const pickTile = (k: TileKey) => { setPreset(preset === k ? "all" : k); setTab("report"); setView("all"); tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const goodBad = (ok: boolean | null) => (ok == null ? "" : ok ? " is-ok" : " is-bad");
  const kpi = (k: TileKey, label: string, value: React.ReactNode, sub: string, hint: string, tone = "") => (
    <button type="button" className={`ftd-kpi ftd-tile${tone}${preset === k ? " on" : ""}`} aria-pressed={preset === k} onClick={() => pickTile(k)}>
      <span className="ftd-kpi-l">{label}<InfoHint text={hint} /></span>
      <span className="ftd-kpi-v">{value}</span>
      <span className="ftd-kpi-s">{sub}</span>
    </button>
  );
  const bar = (v: number | null, goal: number | null = null) => (
    <div className={`ftd-bar${goal == null || v == null ? "" : v >= goal ? " is-ok" : " is-bad"}`}>
      <i style={{ width: `${String(v ?? 0)}%` }} />{goal != null && <b className="ftd-goal" style={{ left: `${String(goal)}%` }} title={`ціль ${String(goal)} %`} />}
      <span>{v == null ? "—" : `${String(v)}%`}</span></div>
  );
  const cell: React.CSSProperties = {};

  return (
    <>
      <div className="ftd" ref={topRef}>
        <div className={`ftd-over${queueOpen ? " is-dim" : ""}${stale ? " is-stale" : ""}`} aria-hidden={queueOpen} aria-busy={stale}>
          <div className="ftd-head">
            <div>
              <div className="ftd-kicker">Продаж · перші розмови з реклами</div>
              <h1 className="ftd-title">Перший дотик · AI
                {stale && <span className="ftd-updating" role="status">Оновлюю…</span>}
                <InfoHint text="Перша розмова кожної рекламної угоди (будь-який напрямок, від 20 с), розпізнана по двох каналах і розібрана моделлю: ціна, заперечення, обіцянки й наступний крок із дослівними цитатами. Оцінки менеджера тут немає. Період — за датою створення угоди." />
              </h1>
              {meta && (
                <p className="ftd-meta">
                  Конвеєр: {meta.job?.lastSuccessAt ? `останній успішний запуск ${fmtTime(meta.job.lastSuccessAt)}` : "успішних запусків ще не було"}
                  {meta.job?.lastError && (jobErrorIsCurrent(meta.job)
                    ? <span style={{ color: "var(--danger, #b3261e)" }}> · остання помилка {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}: {meta.job.lastError}</span>
                    : <span title={meta.job.lastError}> · остання помилка була {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}, після неї — успішні запуски</span>)}
                  {" · "}витрати місяця: розпізнавання {usd(meta.spend.stt)}{meta.caps.stt != null ? ` з ${usd(meta.caps.stt)}` : ""}, аналіз {usd(meta.spend.analysis)}{meta.caps.analysis != null ? ` з ${usd(meta.caps.analysis)}` : ""}
                </p>
              )}
            </div>
            <div className="ftd-nav">
              {navBar}
              <label className="ftd-team">Команда
                <select id="ai-team" value={lf.teamId ?? ""} onChange={(e) => setLf({ ...lf, teamId: e.target.value ? Number(e.target.value) : null, managerId: null })}>
                  <option value="">усі</option>
                  {teams.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
            </div>
          </div>

          {d.canReview && (
            <section aria-label="Черга розбору" className={`ftd-strip${glow ? " is-glow" : ""}`}>
              <div style={{ flex: "1 1 320px" }}>
                <div className="ftd-strip-k">Черга розбору</div>
                <div className="ftd-strip-h">Розібрати: <b>{queue.length}</b> розмов · розібрано {reviewedN} з {dueTotal}</div>
                <div className="ftd-progress"><i style={{ width: `${String(dueTotal ? Math.round((reviewedN / dueTotal) * 100) : 0)}%` }} /></div>
              </div>
              <div className="ftd-strip-chips">
                <span style={{ background: "#3a1616", color: "#fecaca" }}>Немає дзвінка {reasonN("noCall")}</span>
                <span style={{ background: "#3a2c10", color: "#fde68a" }}>Без ціни {reasonN("noPrice")}</span>
                <span style={{ background: "#2c2e36", color: "#e5e7eb" }}>Втрачені {reasonN("lost")}</span>
              </div>
              <button type="button" className="ftd-go" disabled={queue.length === 0} onClick={() => openQueue()}>{reviewedN > 0 ? "Продовжити розбір ›" : "Почати розбір ›"}</button>
            </section>
          )}

          <section aria-label="Головні числа" className="ftd-kpis">
            {kpi("noCall", "Обіцяли — дзвінка в телефонії немає", <AnimatedNumber value={ts.noCall.n} />,
              `${ts.noCall.of ? `${String(Math.round((ts.noCall.n / ts.noCall.of) * 100))}% від ` : "з "}${String(ts.noCall.of)} обіцянок`,
              "Менеджер пообіцяв передзвонити, а в телефонії його дзвінка немає. Ringostat не бачить особистого мобільного й месенджерів — тому «в телефонії».")}
            {kpi("noPrice", "Ціна озвучена", <AnimatedNumber value={ts.price.pct} suffix="%" />, `${String(ts.price.yes)} з ${String(ts.price.of)} · ціль ${String(target)}%`,
              "Серед розібраних, крім втрачених лідів. Клік — розмови, де ціну НЕ назвали. Ціль змінює адмін у «Налаштуваннях».", goodBad(ts.price.pct == null ? null : ts.price.pct >= target))}
            {kpi("objNotHandled", "Заперечення опрацьовано", <AnimatedNumber value={ts.objection.pct} suffix="%" />, ts.objection.of ? `${String(ts.objection.handled)} з ${String(ts.objection.of)} заперечень` : "розбираються для розмов від 09.10",
              "Клієнт сказав «дорого», «подумаю», «порівняю» — і менеджер зʼясував причину, аргументував, запропонував альтернативу чи домовився про крок. Клік — неопрацьовані.")}
            {kpi("lost", "Втрачені ліди", <AnimatedNumber value={lost.length} />, lostReact == null ? "реакція — немає даних" : `реакція (медіана) ${fmtMinutes(lostReact)}`,
              "Клієнт уже вирішив без нас. Реакція — від створення заявки до нашого першого вихідного дзвінка.")}
            {kpi("success", "Успіх", <><AnimatedNumber value={ts.success.n} /> з <AnimatedNumber value={ts.success.of} /></>,
              ts.success.n >= SUCCESS_MIN_FOR_PCT ? `${String(Math.round((ts.success.n / Math.max(1, ts.success.of)) * 100))}% угод` : "замало угод для відсотка",
              "Угода з цієї розмови ЗАРАЗ в етапі «Успішно реалізовано» (для кваліфікації — її дочірня угода). Оновлюється з Kommo щопівгодини.")}
          </section>

          <section aria-label="Менеджери за чек-листом" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>Менеджери за чек-листом першого дотику</h2>
              <span style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`ftd-fade${mgrCollapsed ? " is-hidden" : ""}`}>частка розмов, де пункт виконано · найслабші — згори · клік по менеджеру фільтрує таблицю, ще клік — знімає</span>
                <button type="button" className={`ftd-collapse${mgrCollapsed ? " is-collapsed" : ""}`} aria-expanded={!mgrCollapsed} aria-controls="ftd-mgr-body"
                  aria-label={mgrCollapsed ? "Розгорнути блок менеджерів" : "Згорнути блок менеджерів"} title={mgrCollapsed ? "Розгорнути" : "Згорнути"} onClick={toggleMgr}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </span>
            </div>
            <div className={`ftd-sub ftd-fade${mgrCollapsed ? "" : " is-hidden is-gone"}`}>{lines.length} менеджерів{weakest ? ` · найслабший бал — ${weakest.name} (${String(weakest.score)}%)` : ""}{pickedName ? ` · вибрано: ${pickedName}` : ""}</div>
            <div id="ftd-mgr-body" className={`ftd-collapsible${mgrCollapsed ? " is-collapsed" : ""}`} aria-hidden={mgrCollapsed}>
            <div className="ftd-collapsible-in">
            <div style={{ overflowX: "auto" }}>
              <div className="ftd-mgr">
                <div className="ftd-mgr-h">Менеджер</div><div className="ftd-mgr-h">Бал</div>
                {CHECK_ITEMS.map((it) => <div key={it.key} className="ftd-mgr-h">{it.key === "price" ? `Ціна · ціль ${String(target)}%` : it.key === "objection" ? "Заперечення (опрац. / було)" : it.label}</div>)}
                <div className="ftd-mgr-h">Успіх</div>
                {lines.map((l) => (
                  <div key={String(l.managerId)} style={{ display: "contents" }}>
                    <button type="button" className={`ftd-mgr-name${lf.managerId === l.managerId ? " on" : ""}`} aria-pressed={lf.managerId === l.managerId}
                      onClick={() => setLf({ ...lf, managerId: lf.managerId === l.managerId ? null : l.managerId })}>{l.name} <span>· {l.calls}</span></button>
                    <div style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{l.score == null ? "—" : `${String(l.score)}%`}</div>
                    {bar(l.request)}{bar(l.price, target)}{bar(l.promise)}
                    {l.objections === 0
                      ? <div className="ftd-sub" title="Заперечення розбираються для розмов від 09.10; у цих розмовах їх не було або ще не розібрано">—</div>
                      : <div className="ftd-obj" title={`${String(l.objectionsHandled)} опрацьовано з ${String(l.objections)}`}>{bar(l.objection)}<span className="ftd-sub">{l.objectionsHandled}/{l.objections}</span></div>}
                    <div style={{ fontVariantNumeric: "tabular-nums" }}>{l.success} з {l.calls}</div>
                  </div>
                ))}
              </div>
              {lines.length === 0 && <p className="ftd-sub" style={{ margin: 0 }}>Розібраних розмов у періоді ще немає.</p>}
            </div>
            </div>
            </div>
          </section>

          <section aria-label="Розмови" className="ftd-card" ref={tableRef}>
            <div className="ftd-toolbar">
              <div className="ftd-seg" role="tablist" aria-label="Режим списку">
                <button type="button" role="tab" aria-selected={tab === "report" && view === "all"} className={tab === "report" && view === "all" ? "on" : ""}
                  onClick={() => { setTab("report"); setView("all"); }}>Усі {rows.length}</button>
                {d.canReview && <button type="button" role="tab" aria-selected={tab === "report" && view === "todo"} className={tab === "report" && view === "todo" ? "on" : ""}
                  onClick={() => { setTab("report"); setView("todo"); }}>Не розібрані {queue.length}</button>}
                {d.canSeeExcluded && <button type="button" role="tab" aria-selected={tab === "excluded"} className={tab === "excluded" ? "on" : ""} onClick={() => { setTab("excluded"); setView("all"); }}
                  title="Розмови, які модель упевнено визнала не запитом на перевезення: перевізники, продавці, пошук роботи, помилка номером.">Виключені · {excludedCount}</button>}
              </div>
              {pickedName && (
                <button type="button" className="ftd-pill on" onClick={() => setLf({ ...lf, managerId: null })} aria-label={`Зняти фільтр: ${pickedName}`}>Менеджер: {pickedName} ✕</button>
              )}
              {([["noCall", "Обіцяв — дзвінка немає"], ["noPrice", "Ціни не було"], ["objNotHandled", "Заперечення не опрацьоване"], ["lost", "Втрачені"], ["success", "Успіх"]] as const).map(([k, label]) => (
                <button key={k} type="button" className={`ftd-pill${preset === k ? " on" : ""}`} aria-pressed={preset === k}
                  onClick={() => setPreset(preset === k ? "all" : k)}>{label} <b>{scoped.filter(TILE_MATCH[k]).length}</b></button>
              ))}
              <div style={{ flex: 1 }} />
              <label htmlFor="ai-search" style={{ position: "absolute", left: -9999 }}>Пошук у розмовах</label>
              <input id="ai-search" type="search" className="ftd-search" placeholder="Пошук: менеджер, маршрут, сума" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="ftd-filters">
              {tab === "excluded" && (
                <label style={{ display: "flex", gap: 4, alignItems: "center" }}>Тип
                  <select id="ai-extype" value={exType} onChange={(e) => setExType(e.target.value as ConversationTypeT | "all")}>
                    <option value="all">усі</option>
                    {(Object.keys(TYPE_LABEL) as ConversationTypeT[]).filter((k) => k !== "cargo_request").map((k) => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}
                  </select>
                </label>
              )}
              <div className="hr-seg2" role="group" aria-label="Воронка">
                {(["all", "full", "qualification"] as const).map((g) => (
                  <button key={g} type="button" className={lf.group === g ? "on" : ""} aria-pressed={lf.group === g} onClick={() => setLf({ ...lf, group: g })}>
                    {g === "all" ? "Усі воронки" : GROUP_LABEL[g]} · {groupCount(g)}
                  </button>
                ))}
              </div>
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>Менеджер
                <select id="ai-manager" value={lf.managerId ?? ""} onChange={(e) => setLf({ ...lf, managerId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">усі</option>
                  {managers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", gap: 4, alignItems: "center" }} title="«Дубль» і «Перевізник» — причина відмови в CRM">
                <input id="ai-nontarget" type="checkbox" checked={lf.showNonTarget} onChange={(e) => setLf({ ...lf, showNonTarget: e.target.checked })} />
                показати нецільові{lf.showNonTarget ? "" : ` (прибрано: ${String(nonTargetHidden)})`}
              </label>
              {normFrom && (
                <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input id="ai-silence" type="checkbox" checked={silenceOnly} onChange={(e) => setSilenceOnly(e.target.checked)} />
                  тиша перед закриттям
                </label>
              )}
              <select id="ai-filter" aria-label="Фільтр" value={filter} onChange={(e) => setFilter(e.target.value as AiFilter)}>
                {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              {done.length < rows.length && (
                <span>Ще не проаналізовано: {[...byState.entries()].filter(([s]) => s !== "done").map(([s, n]) => `${STATE_UI[s].label.toLowerCase()} — ${String(n)}`).join(", ")}.</span>
              )}
              {d.truncated && <span style={{ color: "var(--warn-fg, #8a5a00)" }}>Показано перші 5 000 — звузьте період.</span>}
            </div>
            <div style={{ overflowX: "auto" }}>
              {shownD.length === 0
                ? <p style={{ margin: 0, padding: 16, color: "var(--text-muted)" }}>{rows.length === 0 ? "У періоді немає перших розмов по рекламних угодах." : "Під цей фільтр розмов немає."}</p>
                : (
                  <table className="ftd-table">
                    <thead>
                      <tr>
                        <th style={cell}>Розмова</th><th style={cell}>Менеджер</th><th style={cell}>Про що (AI)</th><th style={cell}>Чек-лист</th>
                        <th style={cell}>Обіцянка</th><th style={cell}>Успіх</th><th style={cell}>Реакція</th><th style={cell}>Розбір</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownD.map((r) => (
                        <tr key={r.uniqueid} className="ftd-row" tabIndex={0} aria-label={`Відкрити розмову ${fmtTime(r.calledAt)}`}
                          onClick={() => setOpen(r.uniqueid)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.uniqueid); }}>
                          <td style={{ whiteSpace: "nowrap" }}><b>{fmtTime(r.calledAt)}</b><div className="ftd-sub">{r.direction === "in" ? "вхідний" : "вихідний"} · {mmss(r.billsec)}</div></td>
                          <td style={{ whiteSpace: "nowrap" }}>{r.managerName ?? "невідомий"}<div className="ftd-sub">{r.teamName ?? ""}</div></td>
                          <td style={{ maxWidth: 380 }}>
                            {(r.typeCheck || !r.inReport || r.typeOverride) && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 3 }}>
                                {r.typeCheck && <span className="ftd-chip" title={`Модель не впевнена в типі (${r.conversationType ? TYPE_LABEL[r.conversationType] : "—"}, ${String(r.typeConfidence ?? "—")}): ${r.typeReason ?? ""}`}
                                  style={{ background: TONE_COLOR.warn.bg, color: TONE_COLOR.warn.fg }}>Перевірити тип</span>}
                                {!r.inReport && r.conversationType && <span className="ftd-chip" title={r.typeReason ?? ""} style={{ background: TONE_COLOR.muted.bg, color: TONE_COLOR.muted.fg }}>{TYPE_LABEL[r.conversationType]}</span>}
                                {r.typeOverride && <span className="ftd-sub">позначено вручну{r.typeOverride.byName ? ` · ${r.typeOverride.byName}` : ""}</span>}
                              </div>
                            )}
                            {r.summary ?? <span className="ftd-sub">—</span>}
                          </td>
                          <td>{r.state === "done" && r.checklist
                            ? <span className="ftd-dots" title={CHECK_ITEMS.map((it) => `${it.label}: ${CHECK_MARK_UI[r.checklist![it.key]].label}`).join(" · ")}>
                                {CHECK_ITEMS.map((it) => <i key={it.key} style={{ background: CHECK_MARK_UI[r.checklist![it.key]].color }} />)}
                                <b>{scoreLabel(r.checkScore) ?? "—"}</b>
                              </span>
                            : r.state === "done" ? null : <StateChip state={r.state} />}</td>
                          <td>{r.state !== "done" ? "—" : r.promiseState
                            ? <span className="ftd-chip" title={PROMISE_UI[r.promiseState].hint} style={{ background: TONE_COLOR[PROMISE_UI[r.promiseState].tone].bg, color: TONE_COLOR[PROMISE_UI[r.promiseState].tone].fg }}>{PROMISE_UI[r.promiseState].label}</span>
                            : <span className="ftd-sub">немає</span>}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{!r.dealOutcome ? "—"
                            : <span className="ftd-chip" title={r.dealOutcome.lossReason ? `Причина відмови в CRM: ${r.dealOutcome.lossReason}` : undefined}
                                style={{ background: TONE_COLOR[r.dealOutcome.state === "success" ? "ok" : r.dealOutcome.state === "lost" ? "muted" : "wait"].bg,
                                  color: TONE_COLOR[r.dealOutcome.state === "success" ? "ok" : r.dealOutcome.state === "lost" ? "muted" : "wait"].fg }}>
                                {r.dealOutcome.state === "success" ? "успіх" : r.dealOutcome.state === "lost" ? "відмова" : "у роботі"}</span>}</td>
                          <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{r.reactionMin == null ? "—" : fmtMinutes(r.reactionMin)}{r.reactionOffHours ? <div className="ftd-sub">поза роб. часом</div> : null}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{r.reviewNote
                            ? <span style={{ color: "var(--ok, #166534)" }}>{r.reviewNote.byName ?? "розібрано"} · {new Date(r.reviewNote.at).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })}</span>
                            : r.missedNote ? <span style={{ color: "var(--ok, #166534)" }}>опрацьовано</span>
                            : r.needsReview ? <span style={{ color: "var(--danger, #b91c1c)" }}>не розібрано</span>
                            : <span className="ftd-sub">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
            <div className="ftd-foot">
              <div><b>Ціна названа → успіх:</b> {split.named.n} з {split.named.of}{split.enough ? ` (${String(Math.round((split.named.n / Math.max(1, split.named.of)) * 100))}%)` : ""}
                {" · "}<b>не названа → успіх:</b> {split.notNamed.n} з {split.notNamed.of}{split.enough ? ` (${String(Math.round((split.notNamed.n / Math.max(1, split.notNamed.of)) * 100))}%)` : ""}
                {!split.enough && <span> — замало угод для висновку: відсотки зʼявляться, коли в кожній групі буде від {SUCCESS_MIN_FOR_PCT} успішних.</span>}</div>
              <div>Квадрати чек-листа: запит · ціна · обіцянка · заперечення (зелений — так, червоний — ні, сірий — не рахується). Клік по рядку — картка розмови; розбір черги — кнопкою «Почати розбір» у смузі.</div>
            </div>
          </section>
        </div>

        {d.canReview && (
          <FirstTouchQueue rows={queue} open={queueOpen} selected={queueSel} onSelect={setQueueSel} onClose={closeQueue}
            onReviewed={() => setReload((x) => x + 1)} onOpenCard={(u) => setOpen(u)} title={teamTitle} />
        )}
      </div>
      {drawer}
    </>
  );
}
