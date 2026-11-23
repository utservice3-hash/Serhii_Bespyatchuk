import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./firstTouch.css";
import { fetchAiCalls, fetchAiCallsMeta, putAiCallNote, hiringError, type AiCallsResp, type AiCallsMetaResp } from "../../../api";
import { useToast } from "../../../components/Toasts";
import { AiCallDrawer, ApproveButton } from "./AiCallDrawer";
import { FirstTouchQueue } from "./FirstTouchQueue";
import { FirstTouchPriceChart } from "./FirstTouchPriceChart";
import { ReviewByTeamBlock } from "./ReviewByTeamBlock";
import { CarrierCallsSection } from "./CarrierCallsSection";
import { FirstTouchRules } from "./FirstTouchRules";
import { FirstTouchPane } from "./FirstTouchPane";
import { useSegInk } from "./useSegInk";
import { AnimatedNumber } from "./AnimatedNumber";
import { InfoHint } from "../widgets";
import { PeriodStepper, stepperLabel } from "../PeriodStepper";
import { MoreFilters } from "./FirstTouchMore";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { approveState, approveWaitText, type ApproveState, STATE_UI, TONE_COLOR, FILTERS, matchesFilter, aiDefaultPeriod, jobErrorIsCurrent, parseCallParam, withCallParam,
  GROUP_LABEL, applyListFilter, type ListFilter, type PipelineGroupT,
  TYPE_LABEL, tabRows, type ListTab, type ConversationTypeT,
  type AiFilter, type AiCallState,
  CHECK_ITEMS, CHECK_MARK_UI, managerChecklist, queueRows, scoreLabel, medianMin, fmtMinutes,
  TILE_MATCH, tileStats, priceFormStats, PRICE_FORM_UI, PRICE_FORM_FROM_UA, priceSuccessSplit, SUCCESS_MIN_FOR_PCT, type TileKey, onlyMature, priceConversionByManager, MATURE_DAYS, CLOSURE_UI,
  TRANSPORT_LABEL, type ExcludedFilterT,
  sortManagerLines, nextMgrSort, parseMgrSort, type MgrSort, type MgrSortKey,
  DEFAULT_LIST_FILTER, parseAiLink, withoutAiLinkParams, excludedLabel, REQUEST_KIND_LABEL, requestKindTab, type RequestKindFilterT,
  priceReasonStats, priceReasonKey, PRICE_REASON_KEY_UA, type PriceReasonKeyT, countsForTeam,
  reviewBucket, inListMode, LIST_MODE_UA, REVIEW_REASON_UI, type ListModeT, type ReviewReasonT,
  groupByDay, pickSelected, reviewNoteText } from "../aiCallsView";

/**
 * 🎧 «ПЕРШИЙ ДОТИК · AI» — прохід 1, лише перегляд (рішення Романа 28.09.2026, макет — на ньому).
 *
 * 🆕 ЕКРАН D (Роман 08.10.2026, макет «D · Огляд + черга розбору», «майже 1 в 1»): смуга черги розбору, пʼять чисел,
 * менеджери за чек-листом з 3 пунктів (запит · ціна · обіцянка), таблиця з квадратами чек-листа й колонкою «Розбір».
 * Черга (розкладка B) відкривається поверх і згортається назад у смугу. Стани пунктів і «потребує розбору» — від
 * сервера (`core/firstTouchTeamReport.ts`); тут їх лише складають.
 *
 * 🆕 ФІНАЛЬНИЙ МАКЕТ (Роман 24.11.2026, «давай тепер реально таке робити, додавай плавні анімації»): вкладки «Розбір» і
 * «Статистика», період — той самий перемикач, що у «Звіті» (`PeriodStepper`), темної смуги «Точка контролю» немає («плашка про
 * 23 розмови зайва») — число «Потребує дії» стоїть на вкладці «Розбір»; фільтри списку — двома підписаними рядками
 * («Показати», «Причина»), рідкісні — у панелі «Ще фільтри» (`FirstTouchMore`), усе ввімкнене видно плашками під ними.
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

/** Скелет на час завантаження — та сама розкладка, що й перша вкладка «Розбір» (два рядки фільтрів, список і панель розмови), щоб нічого не стрибало. */
function FirstTouchSkeleton({ header, drawer }: { header: React.ReactNode; drawer: React.ReactNode }) {
  const sk = (w: string | number, h: number, extra: React.CSSProperties = {}) => <span className="ftd-sk" style={{ width: w, height: h, ...extra }} />;
  return (
    <div className="ftd" aria-busy="true" aria-label="Завантаження «Першого дотику»">
      {header}
      <div className="ftd-card" aria-hidden="true">
        <div className="ftd-fbar">
          <div className="ftd-frow">{sk(64, 14)}{sk(420, 34, { borderRadius: 8 })}<span style={{ flex: 1 }} />{sk(240, 34, { borderRadius: 8 })}</div>
          <div className="ftd-frow">{sk(64, 14)}{sk(120, 30, { borderRadius: 999 })}{sk(110, 30, { borderRadius: 999 })}{sk(96, 30, { borderRadius: 999 })}{sk(130, 30, { borderRadius: 999 })}</div>
        </div>
        <div className="ftd-two" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="ftd-list" style={{ overflow: "hidden" }}>
            {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ display: "grid", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
              {sk("55%", 14)}{sk("100%", 12)}{sk("80%", 12)}{sk(120, 18, { borderRadius: 999 })}</div>)}
          </div>
          <div className="ftd-pane">
            {sk("40%", 20)}{sk("96%", 14, { marginTop: 22 })}{sk("92%", 14, { marginTop: 10 })}{sk("70%", 14, { marginTop: 10 })}{sk("100%", 96, { marginTop: 22, borderRadius: 8 })}{sk(150, 38, { marginTop: 22, borderRadius: 8 })}</div>
        </div>
      </div>
      <span className="ftd-sr">Завантаження…</span>
      {drawer}
    </div>
  );
}

/**
 * Вкладки екрана (Роман 23.11.2026, задача 10734 п.2): перша — список розмов; «Перевізники за розмовою» — колишній пункт меню.
 * Назви «Розбір» і «Статистика» — з фінального макета (Роман 24.11.2026); ключі `ctrl` / `an` лишились, на них тримаються гейти.
 */
type FtPageT = "ctrl" | "an" | "car";
/** Підписи фільтра «Стан» — ті самі три стани, що й у кнопки «Погоджую» (`approveState`): фільтр і кнопка не розійдуться. */
const APPROVE_FILTER_UA: Record<ApproveState["kind"], string> = { can: "Можна погодити", wait: "Чекає коментаря менеджера", notManager: "Коментар не від менеджера" };
const FT_PAGE_UA: Record<FtPageT, string> = { ctrl: "Розбір", an: "Статистика", car: "Перевізники за розмовою" };

export function AiCallsSection({ canSeeCarriers = false, roleKey = null }: { canSeeCarriers?: boolean; roleKey?: string | null } = {}) {
  const today = todayKyiv();
  // 🔗 Перехід зі Звіту КВП (задача 5314): період, плитка, команда чи менеджер — з адреси, один раз при відкритті.
  const link = useMemo(() => parseAiLink(window.location.search), []);
  const [nav, setNav] = useState<PeriodState>(() => link.nav ?? aiDefaultPeriod(today));
  const { from, to } = periodOf(nav);
  const [d, setD] = useState<AiCallsResp | null>(null);
  const [meta, setMeta] = useState<AiCallsMetaResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Після ручної зміни типу список перечитується: розмова переходить між «Звітом» і «Виключеними».
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<AiFilter>("all");
  // П8-Б: воронка, команда, менеджер; нецільові («Дубль», «Перевізник») сховані, їх число — у перемикачі.
  const [lf, setLf] = useState<ListFilter>(() => ({ ...DEFAULT_LIST_FILTER, teamId: link.teamId, managerId: link.managerId }));
  const [silenceOnly, setSilenceOnly] = useState(false);
  // Відкрита картка живе в адресі (`?call=`): посилання можна переслати, і воно відкриє ту саму картку.
  const [open, setOpenState] = useState<string | null>(() => parseCallParam(window.location.search));
  const setOpen = useCallback((uniqueid: string | null) => {
    setOpenState(uniqueid);
    window.history.replaceState(window.history.state, "", withCallParam(window.location.href, uniqueid));
  }, []);
  const closeCard = useCallback(() => setOpen(null), [setOpen]);
  // Черга розбору (розкладка B, з плеєром) — поверх екрана; відкривається кнопкою під фільтрами списку.
  const [queueOpen, setQueueOpen] = useState(false);
  const periodKey = useRef("");
  // Новий період: старі цифри лишаються (напівпрозорі, «Оновлюю…»), а щойно прийдуть нові — плитки перетікають до них.
  // Скелет — лише на першому відкритті, коли показати ще нічого (Роман 08.10.2026).
  const [stale, setStale] = useState(false);
  const topRef = useRef<HTMLDivElement | null>(null);
  const [queueSel, setQueueSel] = useState<string | null>(null);
  const [preset, setPreset] = useState<"all" | TileKey>(link.tile ?? "all");
  // 💬 Задача 7239: клік по причині в блоці «Чому не назвали ціну» — список лише розмов без ціни з цією причиною.
  const [reasonPick, setReasonPick] = useState<PriceReasonKeyT | null>(null);
  useEffect(() => { if (link.any) window.history.replaceState(window.history.state, "", withoutAiLinkParams(window.location.href)); }, [link]);
  const tableRef = useRef<HTMLElement | null>(null);
  // Прийшли з картки Звіту КВП — одразу до списку розмов цієї плитки («натиснув — висвітлилось, які саме»).
  const linkScrolled = useRef(false);
  useEffect(() => {
    if (d && link.tile && !linkScrolled.current) { linkScrolled.current = true; tableRef.current?.scrollIntoView({ block: "start" }); }
  }, [d, link.tile]);
  // 🎯 Режим списку (задача 10734 п.1, п.4): «Потребує дії / Закриті без розбору / Розібрані / Усі заявки». `null` — типовий:
  // тому, хто розбирає, — «Потребує дії»; решті (і переходу зі Звіту КВП з плиткою) — «Усі заявки».
  const [mode, setMode] = useState<ListModeT | null>(link.tile ? "all" : null);
  const [page, setPage] = useState<FtPageT>("ctrl");
  const [rulesOpen, setRulesOpen] = useState(false);
  const closeRules = useCallback(() => setRulesOpen(false), []);
  // Рядок «Причина» (задача 10734 п.4, макет 24.11.2026): причина розбору й стан погодження; менеджер — той самий `lf.managerId`.
  const [fReasons, setFReasons] = useState<ReviewReasonT[]>([]);
  const [fApprove, setFApprove] = useState<"all" | ApproveState["kind"]>("all");
  const [q, setQ] = useState("");
  // 🪟 «Розбір у два вікна» (Роман 23.11.2026, макет А): обрана розмова — у правій панелі. `orderRef` памʼятає порядок
  // списку з минулого рендера: коли обрана зникає (погодили), праворуч стає НАСТУПНА за нею, а не перша (`pickSelected`).
  const [sel, setSel] = useState<string | null>(null);
  const orderRef = useRef<string[]>([]);
  const wantSel = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Погодження з панелі: рядок виїжджає зі списку (`leaving`), унизу списку кілька секунд висить «Скасувати» (`undo`).
  const [leaving, setLeaving] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ uniqueid: string; label: string } | null>(null);
  const undoTimer = useRef<number | null>(null);
  const [apBusy, setApBusy] = useState(false);
  const toast = useToast();
  // Згортання блоку «Менеджери за чек-листом» — пам'ятаємо в браузері (лише зручність, не дані).
  const [mgrCollapsed, setMgrCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("ftd.mgrCollapsed") === "1"; } catch { return false; } });
  const toggleMgr = () => setMgrCollapsed((v) => { try { localStorage.setItem("ftd.mgrCollapsed", v ? "0" : "1"); } catch { /* приватне вікно */ } return !v; });
  // Сортування блоку менеджерів кліком по назві колонки (09.10.2026); вибір памʼятає браузер, як і згортання.
  const [mgrSort, setMgrSort] = useState<MgrSort>(() => { try { return parseMgrSort(localStorage.getItem("ftd.mgrSort")); } catch { return parseMgrSort(null); } });
  const pickSort = (k: MgrSortKey) => setMgrSort((cur) => { const n = nextMgrSort(cur, k); try { localStorage.setItem("ftd.mgrSort", `${n.key}:${n.dir}`); } catch { /* приватне вікно */ } return n; });
  // 📊 Вигляд блоку менеджерів «Таблиця | Графік» і «лише угоди, старші 7 днів» (Роман 22.10.2026) — зручність, не дані.
  const [mgrView, setMgrView] = useState<"table" | "chart">(() => { try { return localStorage.getItem("ftd.mgrView") === "chart" ? "chart" : "table"; } catch { return "table"; } });
  const pickView = (v: "table" | "chart") => { setMgrView(v); try { localStorage.setItem("ftd.mgrView", v); } catch { /* приватне вікно */ } };
  const [mgrMature, setMgrMature] = useState<boolean>(() => { try { return localStorage.getItem("ftd.mgrMature") === "1"; } catch { return false; } });
  const pickMature = (on: boolean) => { setMgrMature(on); try { localStorage.setItem("ftd.mgrMature", on ? "1" : "0"); } catch { /* приватне вікно */ } };

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
  // 🎚 Повзунки перемикачів (вкладки екрана й кошики списку) — переїжджають під активну кнопку (`useSegInk`).
  const pagesInk = useSegInk<HTMLDivElement>(page);
  const modeInk = useSegInk<HTMLDivElement>(`${page}|${String(mode)}|${tab}|${d ? String(d.rows.length) : "-"}|${String(reload)}`);
  const [exType, setExType] = useState<ExcludedFilterT>("all");
  const scopedAll = useMemo(() => (d ? applyListFilter(d.rows, lf) : []), [d, lf]);
  const scoped = useMemo(() => tabRows(scopedAll, tab, exType), [scopedAll, tab, exType]);
  // П3: прапорець «тиша» — лише з дати оголошення норми; до того фільтра немає зовсім.
  const normFrom = d?.silence.normFrom ?? null;
  const shown = useMemo(() => scoped.filter((r) => matchesFilter(r, filter)
    && (!silenceOnly || (normFrom != null && r.silentBeforeClose === true && r.dealCreatedAt.slice(0, 10) >= normFrom))), [scoped, filter, silenceOnly, normFrom]);

  // 🗓 Період — той самий перемикач, що у «Звіті» (Роман 23.11.2026: «додай фільтри по датах як у "звіт"»): День · Тиждень ·
  // Місяць · Період, стрілки, календар по кліку на назві. Правила періоду ті самі (`periodRules`), змінився лише вигляд.
  const navBar = <PeriodStepper state={nav} onPatch={(patch) => setNav((st) => ({ ...st, ...patch }))} today={today} />;
  const drawer = open ? <AiCallDrawer uniqueid={open} onClose={closeCard} onChanged={() => setReload((x) => x + 1)} /> : null;
  // 🧭 ШАПКА — ОДНА для скелета й екрана (Роман 08.10.2026: «вибір періоду не потребує рендера після отримання даних»):
  // заголовок, рядок конвеєра, під ними завжди окремим рядком період і «Команда». Даних ще немає — команди «усі».
  const headTeams = d ? [...new Map(d.rows.filter((r) => r.teamId != null).map((r) => [r.teamId!, r.teamName ?? `Команда #${String(r.teamId)}`])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "uk")) : [];
  // Плитки й підсумки рахуються лише по ЗВІТУ: виключене сміття не розмиває відсотки (ТЗ 30.09.2026).
  const rows = tabRows(scopedAll, "report");
  // Черга розбору: прапорець сервера; лічильник «розібрано N з M» — серед тих, що потребували розбору.
  const queue = queueRows(rows);
  // 🎯 Задача 10734 п.1 («нуль у черзі»): у черзі й «Потребує дії» — лише відкриті угоди; закриті без розбору — окремо.
  // Рахується ДО шапки: те саме число стоїть на вкладці «Розбір» (замість темної смуги, Роман 24.11.2026) — одне правило, не два.
  const needNow = queue.filter((r) => reviewBucket(r) === "need");
  // 🧭 Вкладки екрана — у шапці, щоб і «Перевізники» (свій період і свої фільтри) відкривались з того самого місця.
  const pages: FtPageT[] = canSeeCarriers ? ["ctrl", "an", "car"] : ["ctrl", "an"];
  const pageTabs = (
    <div className="ftd-seg ftd-pages" role="tablist" aria-label="Вкладки «Першого дотику»" ref={pagesInk}>
      {pages.map((k) => (
        <button key={k} type="button" role="tab" aria-selected={page === k} className={page === k ? "on" : ""} onClick={() => setPage(k)}>{FT_PAGE_UA[k]}
          {k === "ctrl" && d?.canReview && <b className={`ftd-tab-n${needNow.length === 0 ? " is-zero" : ""}`} title="Потребує дії: розмови відкритих угод, які ще не розібрано. Ціль — 0."><AnimatedNumber value={needNow.length} /></b>}
        </button>
      ))}
    </div>
  );
  // 📘 Задача 10734 п.3: «Правила роботи» — окрема кнопка поруч із заголовком; панель — фіксована, тож живе тут же.
  const rulesEl = rulesOpen ? <FirstTouchRules onClose={closeRules} /> : null;
  const titleBlock = (
        <div>
          <div className="ftd-kicker">Продаж · перші розмови з реклами</div>
          <h1 className="ftd-title">Перший дотик · AI
            {stale && <span className="ftd-updating" role="status">Оновлюю…</span>}
            <InfoHint text="Перша розмова кожної рекламної угоди (будь-який напрямок, від 20 с), розпізнана по двох каналах і розібрана моделлю: ціна, заперечення, обіцянки й наступний крок із дослівними цитатами. Оцінки менеджера тут немає. Період — за датою створення угоди." />
            <button type="button" className="ftd-pill ftd-rules-btn" onClick={() => setRulesOpen(true)}>📘 Правила роботи</button>
          </h1>
          {rulesEl}
        </div>
  );
  // ⚙️ Рядок конвеєра й витрат — технічне (Олександр 20.11, 37:57): живе в згорнутому блоці «Технічне» внизу «Розбору».
  const techMeta = (
        <>
          {meta && (
            <p className="ftd-meta">
              Конвеєр: {meta.job?.lastSuccessAt ? `останній успішний запуск ${fmtTime(meta.job.lastSuccessAt)}` : "успішних запусків ще не було"}
              {meta.job?.lastError && (jobErrorIsCurrent(meta.job)
                ? <span style={{ color: "var(--danger, #b3261e)" }}> · остання помилка {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}: {meta.job.lastError}</span>
                : <span title={meta.job.lastError}> · остання помилка була {meta.job.lastErrorAt ? fmtTime(meta.job.lastErrorAt) : ""}, після неї — успішні запуски</span>)}
              {" · "}витрати місяця: розпізнавання {usd(meta.spend.stt)}{meta.caps.stt != null ? ` з ${usd(meta.caps.stt)}` : ""}, аналіз {usd(meta.spend.analysis)}{meta.caps.analysis != null ? ` з ${usd(meta.caps.analysis)}` : ""}
            </p>
          )}
          {!meta && <span className="ftd-sk" style={{ width: 420, height: 12, marginTop: 6 }} />}
        </>
  );
  const header = (
      <div className="ftd-head">
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
          {titleBlock}
          {pageTabs}
        </div>
        {page !== "car" && <div className="ftd-nav rv">
          {navBar}
          <label className="ftd-team">Команда
            <select id="ai-team" disabled={!d} value={lf.teamId ?? ""} onChange={(e) => setLf({ ...lf, teamId: e.target.value ? Number(e.target.value) : null, managerId: null })}>
              <option value="">усі</option>
              {headTeams.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </div>}
      </div>
  );
  // 🚚 «Перевізники за розмовою» — вкладкою, без змін у самому екрані (свій період, свої фільтри); даних «Першого дотику» не чекає.
  if (page === "car") return (
    <>
      <div className="ftd" style={{ paddingBottom: 0, marginBottom: 14 }}>{header}</div>
      <CarrierCallsSection roleKey={roleKey} />
    </>
  );
  if (err) return <div className="ftd">{header}<p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p>{drawer}</div>;
  if (!d) return <FirstTouchSkeleton header={header} drawer={drawer} />;

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
  // 🌱 Задача 7239 п.3: бал і плитки команди — без розмов менеджерів на адаптації (вони — окремим блоком нижче).
  // Черга розбору й причини без ціни — по всіх: розбирати й пояснювати треба й новачкам.
  const teamRows = rows.filter(countsForTeam);
  const ts = tileStats(teamRows);
  const pf = priceFormStats(teamRows);
  const reasons = priceReasonStats(rows);
  const reasonsTotal = reasons.reduce((a, x) => a + x.n, 0);
  const split = priceSuccessSplit(teamRows);
  const target = d.priceTargetPct;
  const lost = teamRows.filter(TILE_MATCH.lost);
  const lostReact = medianMin(lost.map((r) => r.reactionMin));
  // Блок менеджерів — по всій команді, без фільтра «менеджер»: інакше після кліку лишався один рядок і повернутись було нікуди.
  // Таблиця й графік — ТІ САМІ рядки: команда з шапки, вкладка «Звіт», «старші 7 днів» діє на обидва (варіант «а», 22.10).
  const mgrAll = onlyMature(tabRows(applyListFilter(d.rows, { ...lf, managerId: null }), "report"), today, mgrMature);
  const mgrRows = mgrAll.filter(countsForTeam);
  const lines = managerChecklist(mgrRows);
  const adaptLines = managerChecklist(mgrAll.filter((r) => !countsForTeam(r)));
  const noHireDate = new Set(mgrAll.filter((r) => r.adaptation == null && r.managerId != null).map((r) => r.managerId)).size;
  const priceConv = priceConversionByManager(mgrRows);
  const pickedName = lf.managerId != null ? (lines.find((l) => l.managerId === lf.managerId)?.name ?? managers.find(([id]) => id === lf.managerId)?.[1] ?? "менеджер") : null;
  const weakest = lines.find((l) => l.score != null) ?? null;
  const shownLines = sortManagerLines(lines, mgrSort);
  const sortHead = (k: MgrSortKey, label: string) => (
    <div className="ftd-mgr-h" aria-sort={mgrSort.key === k ? (mgrSort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`ftd-mgr-sort${mgrSort.key === k ? " on" : ""}`} onClick={() => pickSort(k)}
        title={mgrSort.key === k ? "Ще клік — у зворотному порядку" : "Сортувати за цією колонкою"}>
        {label}<span aria-hidden="true">{mgrSort.key === k ? (mgrSort.dir === "asc" ? " ↑" : " ↓") : ""}</span>
      </button>
    </div>);

  const dueTotal = rows.filter((r) => r.reviewReason != null).length;
  const reviewedN = dueTotal - queue.length;
  const modeCount = (m: ListModeT) => (m === "all" ? rows.length : rows.filter((r) => reviewBucket(r) === m).length);
  const listMode: ListModeT = tab === "excluded" ? "all" : (mode ?? (d.canReview ? "need" : "all"));
  const openQueue = (uniqueid?: string) => {
    setQueueSel(uniqueid ?? needNow[0]?.uniqueid ?? null); setQueueOpen(true);
    topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const closeQueue = () => setQueueOpen(false);
  const teamTitle = lf.teamId != null ? (teams.find(([id]) => id === lf.teamId)?.[1] ?? "команда") : "усі команди";

  const presetOk = (r: (typeof rows)[number]) => preset === "all" || TILE_MATCH[preset](r);
  const needle = q.trim().toLowerCase();
  // «Стан» діє лише там, де його видно: у «Потребує дії» для тих, хто розбирає. В інших режимах вибір не фільтрує потай.
  const stateOn = d.canReview && tab === "report" && listMode === "need";
  const fAp = stateOn ? fApprove : "all";
  const shownD = shown.filter((r) => inListMode(r, listMode) && presetOk(r)
    && (fReasons.length === 0 || (r.reviewReason != null && fReasons.includes(r.reviewReason)))
    && (fAp === "all" || approveState(r, d.canReview)?.kind === fAp)
    && (reasonPick == null || (TILE_MATCH.noPrice(r) && priceReasonKey(r) === reasonPick))
    && (!needle || `${r.summary ?? ""} ${r.managerName ?? ""} ${r.priceValue ?? ""}`.toLowerCase().includes(needle)));
  // 🪟 Обрана розмова правої панелі. Рахується на рендері, без ефекту: список і вибір мусять зійтись в одному кадрі.
  const dayGroups = groupByDay(shownD, today);
  const shownIds = dayGroups.flatMap((g) => g.rows.map((r) => r.uniqueid));
  let curId = pickSelected(orderRef.current, shownIds, sel);
  if (wantSel.current && shownIds.includes(wantSel.current)) { curId = wantSel.current; wantSel.current = null; }
  orderRef.current = shownIds;
  if (curId !== sel) setSel(curId);
  const cur = shownD.find((r) => r.uniqueid === curId) ?? null;
  // На вузькому екрані панель не влазить (CSS її ховає) — розмова відкривається повною карткою, як раніше.
  const narrow = () => window.matchMedia("(max-width: 900px)").matches;
  const pickRow = (uniqueid: string) => { if (narrow()) setOpen(uniqueid); else setSel(uniqueid); };
  const focusRow = (uniqueid: string) => listRef.current?.querySelector<HTMLElement>(`[data-u="${CSS.escape(uniqueid)}"]`)?.focus();
  // ✅ «Погоджую» з панелі: той самий запис, що в списку, черзі й картці (`review` + `reviewNoteText(true)`, задача 9229).
  // Рядок виїжджає лише там, де розмова справді покине список («Потребує дії», «Закриті без розбору»).
  const approvePane = async (uniqueid: string) => {
    const row = shownD.find((r) => r.uniqueid === uniqueid);
    if (!row || apBusy) return;
    setApBusy(true);
    try {
      await putAiCallNote(uniqueid, "review", reviewNoteText(true));
      if (listMode === "need" || listMode === "closed") {
        setLeaving(uniqueid);
        setSel(pickSelected(shownIds, shownIds.filter((x) => x !== uniqueid), uniqueid));
      }
      setUndo({ uniqueid, label: `${row.managerName ?? "менеджер невідомий"}, ${fmtTime(row.calledAt)}` });
      if (undoTimer.current != null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
      window.setTimeout(() => setReload((x) => x + 1), 300);
    } catch (e) { toast(hiringError(e)); }
    setApBusy(false);
  };
  // ↩ «Скасувати»: порожній текст знімає позначку «Розібрано» — сервер дозволяє це завжди (routes/dashboard.ts, PUT note).
  const undoApprove = async () => {
    if (!undo) return;
    const u = undo.uniqueid;
    setUndo(null); setLeaving(null);
    try { await putAiCallNote(u, "review", ""); wantSel.current = u; setReload((x) => x + 1); } catch (e) { toast(hiringError(e)); }
  };
  // ⌨️ Стрілки ходять по розмовах, Enter погоджує обрану (коли це можна). Клавіші всередині кнопок і полів не чіпаємо.
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    const i = shownIds.indexOf(curId ?? "");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const nx = shownIds[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (nx) { e.preventDefault(); setSel(nx); focusRow(nx); }
    } else if (e.key === "Enter" && cur) {
      e.preventDefault();
      if (narrow()) setOpen(cur.uniqueid);
      else if (approveState(cur, d.canReview)?.kind === "can") void approvePane(cur.uniqueid);
    }
  };
  // Плитки, рядки й чіпи «Статистики» ведуть у список «Розбору» («натиснув — висвітлилось, які саме»).
  const goList = () => { setTab("report"); setMode("all"); setPage("ctrl"); window.setTimeout(() => tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0); };
  const pickTile = (k: TileKey) => { setPreset(preset === k ? "all" : k); goList(); };
  const CHIPS = ([["noCall", "Обіцяв — дзвінка немає"], ["noPrice", "Ціни не було"], ["objNotHandled", "Заперечення не опрацьоване"], ["lost", "Втрачені"], ["success", "Успіх"], ["agreed", "Погодився після ціни"], ["thinking", "Думає"], ["declined", "Відмовив"], ["agreedLost", "Погодився, а в Kommo втрачено"],
    ["messenger", "Обіцяв у месенджер"], ...(d.canSeeMessengerSignal ? [["messengerSelf", "Сам запропонував месенджер"] as const] : []),
    ["priceExact", "Ціна: точна"], ["priceRange", "Ціна: вилка"], ["priceFrom", "Ціна: «від…»"]] as const);
  const TILE_UA: Partial<Record<TileKey, string>> = Object.fromEntries(CHIPS);
  // 🧹 УСЕ ВВІМКНЕНЕ — ОДНИМ ПЕРЕЛІКОМ (макет 24.11.2026): з нього і плашки під фільтрами, і число на «Ще фільтри», і
  // «Скинути все». Фільтр, якого тут немає, діяв би невидимо — тому новий фільтр списку додається САМЕ сюди.
  const reqKind = lf.requestKind ?? "all";
  const active: { key: string; label: string; more?: boolean; off: () => void }[] = [
    ...(tab === "excluded" ? [{ key: "ex", label: `Виключені · ${String(excludedCount)}`, more: true, off: () => { setTab("report"); setExType("all"); } }] : []),
    ...(preset !== "all" ? [{ key: "tile", label: `${TILE_UA[preset] ?? preset}: ${String(scoped.filter(TILE_MATCH[preset]).length)}`, off: () => setPreset("all") }] : []),
    ...(reasonPick ? [{ key: "why", label: `Без ціни: ${PRICE_REASON_KEY_UA[reasonPick]}`, off: () => setReasonPick(null) }] : []),
    ...fReasons.map((k) => ({ key: `r-${k}`, label: `Причина: ${REVIEW_REASON_UI[k].label}`, off: () => setFReasons(fReasons.filter((x) => x !== k)) })),
    ...(fAp !== "all" ? [{ key: "state", label: `Стан: ${APPROVE_FILTER_UA[fAp].toLowerCase()}`, off: () => setFApprove("all") }] : []),
    ...(pickedName ? [{ key: "mgr", label: `Менеджер: ${pickedName}`, off: () => setLf({ ...lf, managerId: null }) }] : []),
    ...(reqKind !== "all" ? [{ key: "kind", label: `Тип запиту: ${REQUEST_KIND_LABEL[reqKind]}`, more: true, off: () => setLf({ ...lf, requestKind: "all" }) }] : []),
    ...(lf.group !== "all" ? [{ key: "group", label: `Воронка: ${GROUP_LABEL[lf.group]}`, more: true, off: () => setLf({ ...lf, group: "all" }) }] : []),
    ...(lf.showNonTarget ? [{ key: "nt", label: "З нецільовими", more: true, off: () => setLf({ ...lf, showNonTarget: false }) }] : []),
    ...(silenceOnly ? [{ key: "silence", label: "Тиша перед закриттям", more: true, off: () => setSilenceOnly(false) }] : []),
    ...(filter !== "all" ? [{ key: "ai", label: `Стан аналізу: ${FILTERS.find((f) => f.key === filter)?.label ?? filter}`, more: true, off: () => setFilter("all") }] : []),
    ...(needle ? [{ key: "q", label: `Пошук: «${q.trim()}»`, off: () => setQ("") }] : []),
  ];
  const moreActive = active.filter((a) => a.more).length;
  // «Команда» з шапки — не фільтр списку, а зріз усього екрана: «Скинути все» її не чіпає.
  const resetAll = () => {
    setFReasons([]); setFApprove("all"); setPreset("all"); setReasonPick(null); setQ(""); setSilenceOnly(false); setFilter("all");
    setTab("report"); setExType("all"); setLf({ ...DEFAULT_LIST_FILTER, teamId: lf.teamId });
  };
  const goodBad = (ok: boolean | null) => (ok == null ? "" : ok ? " is-ok" : " is-bad");
  // ✅ Задача 9229: клітинка «Розбір» розмови, що чекає розбору. Хто може розбирати — бачить «Погоджую», коли менеджер
  // пояснив сам; коли коментар вписав не менеджер — так і написано (раніше тут стояло «менеджер пояснив»).
  const reviewTodoCell = (r: (typeof rows)[number]) => {
    const ap = approveState(r, d.canReview);
    const label = ap?.kind === "can" ? "менеджер пояснив" : ap?.kind === "notManager" ? `коментар від ${ap.author}`
      : ap?.kind === "wait" ? "не розібрано" : r.explainNote ? "менеджер пояснив" : "не розібрано";
    return (
      <>
        <span style={{ color: "var(--danger, #b91c1c)" }} title={ap ? approveWaitText(ap) ?? undefined : undefined}>{label}</span>
        {ap?.kind === "can" && <div style={{ marginTop: 4 }}><ApproveButton uniqueid={r.uniqueid} onDone={() => setReload((x) => x + 1)} /></div>}
      </>
    );
  };
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

  return (
    <>
      <div className="ftd" ref={topRef}>
        <div className={`ftd-over${queueOpen ? " is-dim" : ""}${stale ? " is-stale" : ""}`} aria-hidden={queueOpen} aria-busy={stale}>
          {header}

          {page === "ctrl" && (<>
          <section aria-label="Розмови" className="ftd-card" ref={tableRef}>
            {/* 🎛 ФІЛЬТРИ ДВОМА ПІДПИСАНИМИ РЯДКАМИ (Роман 24.11.2026: «фільтра трішки покращ що було більше інтуєтивно»):
                «Показати» — який кошик; «Причина» — чому розмова в розборі, стан погодження, менеджер; рідкісне — «Ще фільтри». */}
            <div className="ftd-fbar">
              <div className="ftd-frow">
                <span className="ftd-flabel" id="ftd-fl-show">Показати</span>
                <div className="ftd-seg" role="tablist" aria-labelledby="ftd-fl-show" ref={modeInk}>
                  {(d.canReview ? (["need", "closed", "reviewed", "all"] as const) : (["all"] as const)).map((m) => (
                    <button key={m} type="button" role="tab" aria-selected={tab === "report" && listMode === m} className={tab === "report" && listMode === m ? "on" : ""}
                      onClick={() => { setTab("report"); setMode(m); }}>{LIST_MODE_UA[m]} <span className="ftd-seg-n"><AnimatedNumber value={modeCount(m)} /></span></button>
                  ))}
                </div>
                <div style={{ flex: 1 }} />
                <label htmlFor="ai-search" style={{ position: "absolute", left: -9999 }}>Пошук у розмовах</label>
                <input id="ai-search" type="search" className="ftd-search" placeholder="Пошук: менеджер, маршрут, сума" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <div className="ftd-frow">
                <span className="ftd-flabel" id="ftd-fl-why">Причина</span>
                <span role="group" aria-labelledby="ftd-fl-why" style={{ display: "contents" }}>
                  {(Object.keys(REVIEW_REASON_UI) as ReviewReasonT[]).map((k) => {
                    const n = shown.filter((r) => inListMode(r, listMode) && r.reviewReason === k).length;
                    const on = fReasons.includes(k);
                    return (
                      <button key={k} type="button" className={`ftd-fchip${on ? " on" : ""}${n === 0 && !on ? " is-zero" : ""}`} aria-pressed={on}
                        onClick={() => setFReasons(on ? fReasons.filter((x) => x !== k) : [...fReasons, k])}>{REVIEW_REASON_UI[k].label} <b>{n}</b></button>
                    );
                  })}
                </span>
                {stateOn && (
                  <select id="ai-approve" aria-label="Стан розбору" className={`ftd-fsel${fApprove === "all" ? "" : " on"}`} value={fApprove} onChange={(e) => setFApprove(e.target.value as typeof fApprove)}>
                    <option value="all">Стан: усі</option>
                    {(Object.keys(APPROVE_FILTER_UA) as ApproveState["kind"][]).map((k) => <option key={k} value={k}>{APPROVE_FILTER_UA[k]}</option>)}
                  </select>
                )}
                <select id="ai-manager" aria-label="Менеджер" className={`ftd-fsel${lf.managerId == null ? "" : " on"}`} value={lf.managerId ?? ""} onChange={(e) => setLf({ ...lf, managerId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Менеджер: усі</option>
                  {managers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                {/* 🔽 Рідкісні фільтри — колишній вміст блоку «Технічне»: тип запиту, воронка, нецільові, тиша, стан аналізу, виключені. */}
                <MoreFilters count={moreActive}>
                  <label className="ftd-more-f">Тип запиту
                    <select id="ai-reqkind" value={reqKind} onChange={(e) => {
                      const k = e.target.value as RequestKindFilterT;
                      setLf({ ...lf, requestKind: k });
                      const t = requestKindTab(k);
                      if (t) { setTab(t); setExType("all"); }
                    }}>
                      <option value="all">усі · {applyListFilter(d.rows, { ...lf, requestKind: "all" }).length}</option>
                      {(Object.keys(REQUEST_KIND_LABEL) as (keyof typeof REQUEST_KIND_LABEL)[]).map((k) => (
                        <option key={k} value={k}>{REQUEST_KIND_LABEL[k]} · {applyListFilter(d.rows, { ...lf, requestKind: k }).length}</option>
                      ))}
                    </select>
                  </label>
                  <div className="ftd-more-f">Воронка
                    <div className="hr-seg2" role="group" aria-label="Воронка">
                      {(["all", "full", "qualification"] as const).map((g) => (
                        <button key={g} type="button" className={lf.group === g ? "on" : ""} aria-pressed={lf.group === g} onClick={() => setLf({ ...lf, group: g })}>
                          {g === "all" ? "Усі" : GROUP_LABEL[g]} · {groupCount(g)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="ftd-more-f">Стан аналізу
                    <select id="ai-filter" aria-label="Фільтр" value={filter} onChange={(e) => setFilter(e.target.value as AiFilter)}>
                      {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </label>
                  <label className="ftd-more-chk" title="«Дубль» і «Перевізник» — причина відмови в CRM">
                    <input id="ai-nontarget" type="checkbox" checked={lf.showNonTarget} onChange={(e) => setLf({ ...lf, showNonTarget: e.target.checked })} />
                    <span>Показати нецільові{lf.showNonTarget ? "" : ` (прибрано: ${String(nonTargetHidden)})`}</span>
                  </label>
                  {normFrom && (
                    <label className="ftd-more-chk">
                      <input id="ai-silence" type="checkbox" checked={silenceOnly} onChange={(e) => setSilenceOnly(e.target.checked)} />
                      <span>Лише з тишею перед закриттям</span>
                    </label>
                  )}
                  {/* «Виключені» — не запити на перевезення (перевізники, продавці, помилка номером); менеджеру сервер їх не віддає. */}
                  {d.canSeeExcluded && <button type="button" className={`ftd-pill${tab === "excluded" ? " on" : ""}`} aria-pressed={tab === "excluded"}
                    onClick={() => { setTab(tab === "excluded" ? "report" : "excluded"); setExType("all"); }}
                    title="Розмови, які модель упевнено визнала не запитом на перевезення: перевізники, продавці, пошук роботи, помилка номером.">Виключені · {excludedCount}</button>}
                  {tab === "excluded" && (
                    <label className="ftd-more-f">Тип виключених
                      <select id="ai-extype" value={exType} onChange={(e) => setExType(e.target.value as ExcludedFilterT)}>
                        <option value="all">усі</option>
                        <option value="transport">вид перевезення (не оцінюємо)</option>
                        {(Object.keys(TYPE_LABEL) as ConversationTypeT[]).filter((k) => k !== "cargo_request").map((k) => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}
                      </select>
                    </label>
                  )}
                </MoreFilters>
                {active.length > 0 && <button type="button" className="ftd-reset" onClick={resetAll}>Скинути все</button>}
              </div>
            </div>
            {/* Під фільтрами: скільки розмов у кошику за період і скільки з них показано; кожен увімкнений фільтр — плашка, що знімається кліком. */}
            <div className="ftd-under">
              <span>{tab === "excluded" ? "Виключені розмови" : `«${LIST_MODE_UA[listMode]}»`} · {stepperLabel(nav, today)}: <b>{tab === "excluded" ? scoped.length : modeCount(listMode)}</b>
                {shownD.length !== (tab === "excluded" ? scoped.length : modeCount(listMode)) && <> · показано <b>{shownD.length}</b></>}</span>
              {active.filter((a) => a.key !== "mgr").map((a) => <button key={a.key} type="button" className="ftd-pill on ftd-fpill" onClick={a.off} aria-label={`Зняти фільтр: ${a.label}`}>{a.label} <span aria-hidden="true">✕</span></button>)}
              {pickedName && (
                <button type="button" className="ftd-pill on ftd-fpill" onClick={() => setLf({ ...lf, managerId: null })} aria-label={`Зняти фільтр: ${pickedName}`}>Менеджер: {pickedName} <span aria-hidden="true">✕</span></button>
              )}
              <span style={{ flex: 1 }} />
              <span className="ftd-legend" aria-label="Квадрати чек-листа">
                {(["y", "n", "o"] as const).map((k) => <span key={k}><i style={{ background: CHECK_MARK_UI[k].color }} />{k === "y" ? "так" : k === "n" ? "ні" : "не оцінюємо"}</span>)}
              </span>
              {d.canReview && <button type="button" className="ftd-pill ftd-qbtn" disabled={needNow.length === 0} title="Розбір по черзі з плеєром: розмови «Потребує дії» одна за одною, із записом і текстом"
                onClick={() => openQueue()}>{needNow.length === 0 ? "Усе розібрано ✓" : reviewedN > 0 ? "Продовжити розбір ›" : "Почати розбір ›"}</button>}
              <span className="ftd-keys">{d.canReview ? "↑ ↓ між розмовами · Enter погодити" : "↑ ↓ між розмовами"}</span>
            </div>
            {d.truncated && <div className="ftd-filters"><span style={{ color: "var(--warn-fg, #8a5a00)" }}>Показано перші 5 000 — звузьте період.</span></div>}
            {shownD.length === 0
              // Порожньо буває з трьох причин, і кожна названа: у періоді нічого немає; усе розібрано; або розмови сховав фільтр — тоді поруч «Скинути все».
              ? <p style={{ margin: 0, padding: 16, color: "var(--text-muted)" }}>{rows.length === 0 ? "У періоді немає перших розмов по рекламних угодах." : listMode === "need" && tab === "report" && active.length === 0 ? "Потребує дії: 0 — усе розібрано." : "Під ці фільтри розмов немає."}
                {rows.length > 0 && active.length > 0 && <> <button type="button" className="ftd-reset" onClick={resetAll}>Скинути все</button></>}</p>
              : (
                // `key` — щоб список плавно проявлявся на новому кошику й на новому періоді. Період береться з ВІДПОВІДІ сервера
                // (`d.period`), а не з перемикача: проявляються вже нові розмови, а не старі в мить кліку по стрілці.
                <div className="ftd-two" key={`${listMode}|${tab}|${d.period.from}|${d.period.to}`}>
                  {/* 🪟 Ліве вікно: розмови групами по київських днях; опис — два рядки, повний текст — праворуч. */}
                  <div className="ftd-list" ref={listRef} role="listbox" aria-label="Розмови" onKeyDown={onListKey}>
                    {dayGroups.map((g) => (
                      <div key={g.day} role="group" aria-label={g.label}>
                        <div className="ftd-day">{g.label} <span className="ftd-sub">· {g.rows.length}</span></div>
                        {g.rows.map((r) => (
                          <div key={r.uniqueid} role="option" aria-selected={r.uniqueid === curId} tabIndex={r.uniqueid === curId ? 0 : -1} data-u={r.uniqueid}
                            className={`ftd-row ftd-li${r.uniqueid === curId ? " on" : ""}${leaving === r.uniqueid && r.needsReview ? " is-leaving" : ""}`}
                            aria-label={`Розмова ${fmtTime(r.calledAt)}, ${r.managerName ?? "менеджер невідомий"}`} onClick={() => pickRow(r.uniqueid)}>
                            <span className="ftd-li-who">{r.managerName ?? "менеджер невідомий"}</span>
                            <span className="ftd-li-when">{fmtTime(r.calledAt)}</span>
                            {(r.typeCheck || !r.inReport || r.typeOverride) && (
                              <div className="ftd-li-flags">
                                {r.typeCheck && <span className="ftd-chip" title={r.conversationType ? `Модель не впевнена в типі (${TYPE_LABEL[r.conversationType]}, ${String(r.typeConfidence ?? "—")}): ${r.typeReason ?? ""}` : r.typeReason ?? "Тип не визначено"}
                                  style={{ background: TONE_COLOR.warn.bg, color: TONE_COLOR.warn.fg }}>Перевірити тип</span>}
                                {r.messengerSignal === true && <span className="ftd-chip" title="Менеджер сам запропонував перейти в месенджер — клієнт не просив (задача 7184)" style={{ background: TONE_COLOR.warn.bg, color: TONE_COLOR.warn.fg }}>сам запропонував месенджер</span>}
                                {!r.inReport && r.transportKind
                                  ? <span className="ftd-chip" title="Не оцінюємо в першому дотику: на такому перевезенні ціну в першій розмові назвати майже неможливо (задача 7183)" style={{ background: TONE_COLOR.muted.bg, color: TONE_COLOR.muted.fg }}>не оцінюємо · {TRANSPORT_LABEL[r.transportKind]}</span>
                                  : !r.inReport && excludedLabel(r) && <span className="ftd-chip" title={r.typeOverride?.cut ? "Тімлід позначив: розмови по суті не було" : r.typeReason ?? ""} style={{ background: TONE_COLOR.muted.bg, color: TONE_COLOR.muted.fg }}>{excludedLabel(r)}</span>}
                                {r.typeOverride && <span className="ftd-sub">позначено вручну{r.typeOverride.byName ? ` · ${r.typeOverride.byName}` : ""}</span>}
                              </div>
                            )}
                            <p className="ftd-li-sum">{r.summary ?? <span className="ftd-sub">опису ще немає</span>}</p>
                            <div className="ftd-li-meta">
                              {r.reviewReason && <span className="ftd-chip" style={{ background: TONE_COLOR[REVIEW_REASON_UI[r.reviewReason].tone].bg, color: TONE_COLOR[REVIEW_REASON_UI[r.reviewReason].tone].fg }}>{REVIEW_REASON_UI[r.reviewReason].label}</span>}
                              {r.state === "done" && r.checklist
                            ? <span className="ftd-dots" title={CHECK_ITEMS.map((it) => `${it.label}: ${CHECK_MARK_UI[r.checklist![it.key]].label}`).join(" · ")}>
                                {CHECK_ITEMS.map((it) => <i key={it.key} style={{ background: CHECK_MARK_UI[r.checklist![it.key]].color }} />)}
                                <b>{scoreLabel(r.checkScore) ?? "—"}</b>
                              </span>
                            : r.state === "done" ? null : <StateChip state={r.state} />}
                              <div className="ftd-li-rev">{r.reviewNote
                            ? <span style={{ color: "var(--ok, #166534)" }}>{r.reviewNote.byName ?? "розібрано"} · {new Date(r.reviewNote.at).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })}</span>
                            : r.missedNote ? <span style={{ color: "var(--ok, #166534)" }}>опрацьовано</span>
                            : r.reviewClosure === "invoice" ? <span style={{ color: "var(--ok, #166534)" }} title={CLOSURE_UI.invoice.hint}>{CLOSURE_UI.invoice.label}</span>
                            // ✅ Задача 9229: «Погоджую» прямо в списку — той самий стан, що в черзі й картці (`approveState`).
                            : r.needsReview ? reviewTodoCell(r)
                            : <span className="ftd-sub">—</span>}
                            {/* 💬 Задача 7183: чим закрито — «погоджено коментар» / «закрито тімлідом». */}
                            {r.reviewClosure && r.reviewClosure !== "invoice" && <div className="ftd-sub" title={CLOSURE_UI[r.reviewClosure].hint}>{CLOSURE_UI[r.reviewClosure].label}</div>}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {/* 🪟 Праве вікно: обрана розмова. `key` — щоб панель «вʼїжджала» на кожну нову розмову. */}
                  <div className="ftd-pane" aria-label="Обрана розмова">
                    {cur && <FirstTouchPane key={cur.uniqueid} row={cur} canReview={d.canReview} canFeedback={d.canFeedback} busy={apBusy}
                      onApprove={() => void approvePane(cur.uniqueid)} onOpenCard={() => setOpen(cur.uniqueid)} />}
                  </div>
                </div>
              )}
            {/* ↩ «Скасувати» висить унизу екрана кілька секунд після погодження — і тоді, коли список став порожнім. */}
            {undo && (
              <div className="ftd-undo" role="status">
                <span>Погоджено: {undo.label}</span>
                <button type="button" onClick={() => void undoApprove()}>Скасувати</button>
              </div>
            )}
            <div className="ftd-foot">
              <div><b>Ціна названа → успіх:</b> {split.named.n} з {split.named.of}{split.enough ? ` (${String(Math.round((split.named.n / Math.max(1, split.named.of)) * 100))}%)` : ""}
                {" · "}<b>не названа → успіх:</b> {split.notNamed.n} з {split.notNamed.of}{split.enough ? ` (${String(Math.round((split.notNamed.n / Math.max(1, split.notNamed.of)) * 100))}%)` : ""}
                {!split.enough && <span> — замало угод для висновку: відсотки зʼявляться, коли в кожній групі буде від {SUCCESS_MIN_FOR_PCT} успішних.</span>}</div>
              <div>Квадрати чек-листа: запит · ціна · обіцянка · заперечення (зелений — так, червоний — ні, сірий — не оцінюємо). Клік по розмові показує її праворуч; запис і текст розмови — у «Повній картці»; розбір по черзі з плеєром — кнопкою «Почати розбір» під фільтрами.</div>
            </div>
          </section>
          {/* ⚙️ Задача 10734 п.2 (Олександр 20.11, 37:57; Сергій 43:48): технічне — вниз, згорнуто. Фільтри звідси переїхали
              в «Ще фільтри» (24.11.2026); тут лишились конвеєр AI, витрати й те, що ще не проаналізовано. */}
          <details className="ftd-card ftd-card-pad ftd-tech">
            <summary><b>⚙️ Технічне</b> <span className="ftd-sub">· конвеєр AI і витрати</span></summary>
            {techMeta}
            {done.length < rows.length && (
              <p className="ftd-meta">Ще не проаналізовано: {[...byState.entries()].filter(([s]) => s !== "done").map(([s, n]) => `${STATE_UI[s].label.toLowerCase()} — ${String(n)}`).join(", ")}.</p>
            )}
          </details>
          </>)}

          {page === "an" && (<>
          <section aria-label="Головні числа" className={`ftd-kpis${d.canSeeMessengerSignal ? " is-6" : ""}`}>
            {kpi("noCall", "Обіцяли — дзвінка в телефонії немає", <AnimatedNumber value={ts.noCall.n} />,
              `${ts.noCall.of ? `${String(Math.round((ts.noCall.n / ts.noCall.of) * 100))}% від ` : "з "}${String(ts.noCall.of)} обіцянок`,
              "Менеджер пообіцяв передзвонити, а в телефонії його дзвінка немає. Ringostat не бачить особистого мобільного й месенджерів — тому «в телефонії».")}
            {kpi("noPrice", "Ціна озвучена", <AnimatedNumber value={ts.price.pct} suffix="%" />, `${String(ts.price.yes)} з ${String(ts.price.of)} · ціль ${String(target)}%${pf.analysed ? ` · «від…» ${String(pf.lines.find((l) => l.form === "from")?.n ?? 0)}` : ""}`,
              "Серед розібраних, крім втрачених лідів. Клік — розмови, де ціну НЕ назвали. Ціль змінює адмін у «Налаштуваннях».", goodBad(ts.price.pct == null ? null : ts.price.pct >= target))}
            {kpi("objNotHandled", "Заперечення опрацьовано", <AnimatedNumber value={ts.objection.pct} suffix="%" />, ts.objection.of ? `${String(ts.objection.handled)} з ${String(ts.objection.of)} заперечень` : "розбираються для розмов від 09.10",
              "Клієнт сказав «дорого», «подумаю», «порівняю» — і менеджер зʼясував причину, аргументував, запропонував альтернативу чи домовився про крок. Клік — неопрацьовані.")}
            {kpi("lost", "Втрачені ліди", <AnimatedNumber value={lost.length} />, lostReact == null ? "реакція — немає даних" : `реакція (медіана) ${fmtMinutes(lostReact)}`,
              "Клієнт уже вирішив без нас. Реакція — від створення заявки до нашого першого вихідного дзвінка.")}
            {kpi("success", "Успіх", <><AnimatedNumber value={ts.success.n} /> з <AnimatedNumber value={ts.success.of} /></>,
              ts.success.n >= SUCCESS_MIN_FOR_PCT ? `${String(Math.round((ts.success.n / Math.max(1, ts.success.of)) * 100))}% угод` : "замало угод для відсотка",
              "Машина поїхала: угода з цієї розмови ЗАРАЗ в етапі «Авто працює» або далі, включно з «Успішно реалізовано» (для кваліфікації — її дочірня угода). Оновлюється з Kommo щопівгодини.")}
            {/* 💬 Задача 7184: окрема плитка — лише ролям, яким сервер дав сигнал; число й список після кліку — одним правилом (TILE_MATCH). */}
            {d.canSeeMessengerSignal && kpi("messengerSelf", "Сам запропонував месенджер", <AnimatedNumber value={ts.messengerSelf.n} />,
              ts.messengerSelf.of ? `з ${String(ts.messengerSelf.of)} розібраних · ${String(Math.round((ts.messengerSelf.n / ts.messengerSelf.of) * 100))}%` : "розбирається для розмов від 30.10",
              "Менеджер сам запропонував перейти у Viber / Telegram / WhatsApp, клієнт про це не просив. Лише з дослівною цитатою, знайденою в розмові. Розбираються розмови від 30.10, де звучить месенджер. Клік — ці розмови; у картці — цитата.")}
          </section>
          <p className="ftd-kpis-cap">Клік по плитці відкриває ці розмови в «Розборі».</p>

          {/* 📋 Задача 7238: розбір по командах за день і тиждень — тим, хто розбирає (тімлід, КВП, адмін). З «Розбору» переїхав
              сюди 24.11.2026: на першій вкладці лишився тільки список розмов. */}
          {d.canReview && <ReviewByTeamBlock variant="ftd" refresh={reload} />}

          {/* 💵 Задача 7351: як названо ціну і чи погодився клієнт — кожен рядок фільтрує список тим самим правилом (TILE_MATCH). */}
          <section aria-label="Як назвали ціну" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>Як назвали ціну → згода клієнта</h2>
              <span>{pf.analysed
                ? `розмови з ціною від ${PRICE_FORM_FROM_UA}: ${String(pf.analysed)}${pf.unknown ? ` · форму не визначено: ${String(pf.unknown)}` : ""} · «від…» поки рахується названою ціною`
                : `форма ціни визначається для розмов від ${PRICE_FORM_FROM_UA}, де ціну назвали; за цей період таких ще немає`}</span>
            </div>
            {pf.analysed > 0 && (
              <div className="ftd-pf">
                {pf.lines.map((l) => {
                  const k = PRICE_FORM_UI[l.form].tile;
                  return (
                    <button key={l.form} type="button" className={`ftd-pf-row${preset === k ? " on" : ""}`} aria-pressed={preset === k} onClick={() => pickTile(k)}>
                      <span className="ftd-pf-l">{PRICE_FORM_UI[l.form].label}<InfoHint text={PRICE_FORM_UI[l.form].hint} /></span>
                      <span className="ftd-pf-n"><b>{l.n}</b> розмов</span>
                      <span className="ftd-pf-n">{l.pct == null ? "згода — ще не відома" : <>погодився <b>{l.pct}%</b> <span className="ftd-sub">· {l.agreed} з {l.decided}</span></>}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* 💬 Задача 7239 п.2: чому не назвали ціну — за причиною з переліку; Σ рядків = розмов без ціни. Клік фільтрує список. */}
          <section aria-label="Чому не назвали ціну" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>Чому не назвали ціну</h2>
              <span>{reasonsTotal ? `розмов без ціни: ${String(reasonsTotal)} · причину обирають у картці розмови` : "за цей період розмов без ціни немає"}</span>
            </div>
            {reasonsTotal > 0 && (
              <div className="ftd-pf">
                {reasons.map((x) => (
                  <button key={x.key} type="button" className={`ftd-pf-row${reasonPick === x.key ? " on" : ""}`} aria-pressed={reasonPick === x.key}
                    onClick={() => { setReasonPick(reasonPick === x.key ? null : x.key); goList(); }}>
                    <span className="ftd-pf-l">{PRICE_REASON_KEY_UA[x.key]}</span>
                    <span className="ftd-pf-n"><b>{x.n}</b> розмов</span>
                    <span className="ftd-pf-n">{Math.round((x.n / reasonsTotal) * 100)}%</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section aria-label="Менеджери за чек-листом" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>Менеджери за чек-листом першого дотику</h2>
              <span style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`ftd-fade${mgrCollapsed ? " is-hidden" : ""}`}>{mgrView === "table"
                  ? "частка розмов, де пункт виконано · клік по назві колонки — сортування · клік по менеджеру фільтрує таблицю, ще клік — знімає"
                  : "чи допомагає названа ціна успіху · клік по менеджеру фільтрує таблицю, ще клік — знімає"}</span>
                <label className="ftd-sub" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input id="ftd-mgr-mature" type="checkbox" checked={mgrMature} onChange={(e) => pickMature(e.target.checked)} />
                  лише угоди, старші {MATURE_DAYS} днів
                </label>
                <span className="ftd-seg" role="tablist" aria-label="Вигляд блоку менеджерів">
                  <button type="button" role="tab" aria-selected={mgrView === "table"} className={mgrView === "table" ? "on" : ""} onClick={() => pickView("table")}>Таблиця</button>
                  <button type="button" role="tab" aria-selected={mgrView === "chart"} className={mgrView === "chart" ? "on" : ""} onClick={() => pickView("chart")}>Графік</button>
                </span>
                <button type="button" className={`ftd-collapse${mgrCollapsed ? " is-collapsed" : ""}`} aria-expanded={!mgrCollapsed} aria-controls="ftd-mgr-body"
                  aria-label={mgrCollapsed ? "Розгорнути блок менеджерів" : "Згорнути блок менеджерів"} title={mgrCollapsed ? "Розгорнути" : "Згорнути"} onClick={toggleMgr}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </span>
            </div>
            <div className={`ftd-sub ftd-fade${mgrCollapsed ? "" : " is-hidden is-gone"}`}>{lines.length} менеджерів{weakest ? ` · найслабший бал — ${weakest.name} (${String(weakest.score)}%)` : ""}{pickedName ? ` · вибрано: ${pickedName}` : ""}</div>
            <div id="ftd-mgr-body" className={`ftd-collapsible${mgrCollapsed ? " is-collapsed" : ""}`} aria-hidden={mgrCollapsed}>
            <div className="ftd-collapsible-in">
            {mgrView === "chart"
              ? <FirstTouchPriceChart lines={priceConv.lines} total={priceConv.total} selectedId={lf.managerId}
                  onPick={(id) => setLf({ ...lf, managerId: id })} />
              : (
            <div style={{ overflowX: "auto" }}>
              <div className="ftd-mgr">
                {sortHead("name", "Менеджер")}{sortHead("score", "Бал")}
                {CHECK_ITEMS.map((it) => <div key={it.key} style={{ display: "contents" }}>{sortHead(it.key, it.key === "price" ? `Ціна · ціль ${String(target)}%` : it.key === "objection" ? "Заперечення (опрац. / було)" : it.label)}</div>)}
                {sortHead("decision", "Згода після ціни")}
                <div className="ftd-mgr-h" title="Розмов, де менеджер пообіцяв щось у месенджер (Viber, Telegram…): Ringostat цього не бачить, перевірити не можна. У бал не входить.">У месенджер</div>
                {sortHead("success", "Успіх")}
                {shownLines.map((l) => (
                  <div key={String(l.managerId)} style={{ display: "contents" }}>
                    <button type="button" className={`ftd-mgr-name${lf.managerId === l.managerId ? " on" : ""}`} aria-pressed={lf.managerId === l.managerId}
                      onClick={() => setLf({ ...lf, managerId: lf.managerId === l.managerId ? null : l.managerId })}>{l.name} <span>· {l.calls}</span></button>
                    <div style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{l.score == null ? "—" : `${String(l.score)}%`}</div>
                    {bar(l.request)}{bar(l.price, target)}{bar(l.promise)}
                    {l.objections === 0
                      ? <div className="ftd-sub" title="Заперечення розбираються для розмов від 09.10; у цих розмовах їх не було або ще не розібрано">—</div>
                      : <div className="ftd-obj" title={`${String(l.objectionsHandled)} опрацьовано з ${String(l.objections)}`}>{bar(l.objection)}<span className="ftd-sub">{l.objectionsHandled}/{l.objections}</span></div>}
                    {l.decided === 0
                      ? <div className="ftd-sub" title="Згода після ціни розбирається для розмов від 13.10 і лише там, де ціну назвали">—</div>
                      : <div className="ftd-obj ftd-dec" title={`Погодився в ${String(l.agreed)} з ${String(l.decided)} розмов, де назвали ціну. У бал не входить.`}>
                          {bar(Math.round((l.agreed / l.decided) * 100))}<span className="ftd-sub">{l.agreed}/{l.decided}{l.thinking ? ` · думає ${String(l.thinking)}` : ""}</span></div>}
                    {/* 💬 Задача 7184: обіцянки в месенджер (не перевірити) і «сам запропонував» — лише ролям, яким сервер дав сигнал. */}
                    <div style={{ fontVariantNumeric: "tabular-nums" }} title={`У ${String(l.messengerCalls)} з ${String(l.calls)} розмов пообіцяв щось у месенджер${d.canSeeMessengerSignal ? ` · сам запропонував месенджер: ${String(l.messengerSelf)}` : ""}`}>
                      {l.messengerCalls} з {l.calls}{l.calls ? <span className="ftd-sub"> · {Math.round((l.messengerCalls / l.calls) * 100)}%</span> : null}
                      {d.canSeeMessengerSignal && l.messengerSelf > 0 && <div className="ftd-sub">сам запропонував: {l.messengerSelf}</div>}
                    </div>
                    <div style={{ fontVariantNumeric: "tabular-nums" }}>{l.success} з {l.calls}</div>
                  </div>
                ))}
              </div>
              {lines.length === 0 && <p className="ftd-sub" style={{ margin: 0 }}>Розібраних розмов у періоді ще немає.</p>}
            </div>
              )}
            </div>
            </div>
          </section>

          {/* 🌱 Задача 7239 п.3: новачки (перші 4 тижні від прийому на день розмови) — окремо; у бал і плитки команди не входять. */}
          <section aria-label="На адаптації" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>На адаптації <InfoHint text="Розмови в перші 4 тижні від «Дати прийому» з «Найму». У бал команди, плитки вгорі, звіт тімліда, Звіт КВП і ціну у Звіті не входять." /></h2>
              <span>{adaptLines.length ? `${String(adaptLines.length)} менеджерів · у бал команди не входять` : "у цьому періоді новачків немає"}
                {noHireDate > 0 && ` · без дати прийому в «Наймі»: ${String(noHireDate)} (рахуються в команді)`}</span>
            </div>
            {adaptLines.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table className="ftd-table" style={{ minWidth: 560 }}>
                  <thead><tr><th>Менеджер</th><th style={{ textAlign: "right" }}>Розмов</th><th style={{ textAlign: "right" }}>Бал</th>
                    {CHECK_ITEMS.map((it) => <th key={it.key} style={{ textAlign: "right" }}>{it.label}</th>)}</tr></thead>
                  <tbody>
                    {adaptLines.map((l) => (
                      <tr key={String(l.managerId)}>
                        <td>{l.name}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.calls}</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.score == null ? "—" : `${String(l.score)}%`}</td>
                        {CHECK_ITEMS.map((it) => <td key={it.key} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l[it.key] == null ? "—" : `${String(l[it.key])}%`}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 🔎 Задача 10734 п.2: чіпи-фільтри переїхали з першої вкладки; клік — список у «Розборі» з цим фільтром. */}
          <section aria-label="Фільтри розмов" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>Фільтри розмов</h2>
              <span>клік — список розмов у «Розборі» з цим фільтром · ще клік — знімає</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {CHIPS.map(([k, label]) => (
                <button key={k} type="button" className={`ftd-pill${preset === k ? " on" : ""}`} aria-pressed={preset === k}
                  onClick={() => { setPreset(preset === k ? "all" : k); goList(); }}>{label} <b>{scoped.filter(TILE_MATCH[k]).length}</b></button>
              ))}
            </div>
          </section>
          </>)}
        </div>

        {d.canReview && (
          <FirstTouchQueue rows={needNow} open={queueOpen} selected={queueSel} onSelect={setQueueSel} onClose={closeQueue}
            onReviewed={() => setReload((x) => x + 1)} onOpenCard={(u) => setOpen(u)} title={teamTitle} />
        )}
      </div>
      {drawer}
    </>
  );
}
