import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./firstTouch.css";
import { fetchAiCalls, fetchAiCallsMeta, type AiCallsResp, type AiCallsMetaResp } from "../../../api";
import { AiCallDrawer } from "./AiCallDrawer";
import { FirstTouchQueue } from "./FirstTouchQueue";
import { InfoHint } from "../widgets";
import { PeriodNav } from "../PeriodNav";
import { periodOf, todayKyiv, type PeriodState } from "../periodRules";
import { STATE_UI, TONE_COLOR, FILTERS, matchesFilter, mmss, aiDefaultPeriod, jobErrorIsCurrent, parseCallParam, withCallParam,
  PROMISE_UI, GROUP_LABEL, applyListFilter, type ListFilter, type PipelineGroupT,
  TYPE_LABEL, tabRows, type ListTab, type ConversationTypeT,
  type AiFilter, type AiCallState,
  CHECK_ITEMS, CHECK_MARK_UI, managerChecklist, avgScore3, markPct, queueRows, scoreLabel, medianMin, fmtMinutes } from "../aiCallsView";

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
  const topRef = useRef<HTMLDivElement | null>(null);
  const [queueSel, setQueueSel] = useState<string | null>(null);
  const [glow, setGlow] = useState(false);
  const [preset, setPreset] = useState<"all" | "noPrice" | "noCall" | "lost" | "low">("all");
  const [view, setView] = useState<"all" | "todo">("all");
  const [q, setQ] = useState("");
  // Згортання блоку «Менеджери за чек-листом» — пам'ятаємо в браузері (лише зручність, не дані).
  const [mgrCollapsed, setMgrCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("ftd.mgrCollapsed") === "1"; } catch { return false; } });
  const toggleMgr = () => setMgrCollapsed((v) => { try { localStorage.setItem("ftd.mgrCollapsed", v ? "0" : "1"); } catch { /* приватне вікно */ } return !v; });

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    // Перечитування після розбору (`reload`) оновлює дані на місці: інакше «Завантаження…» знімало б чергу посеред роботи.
    if (periodKey.current !== `${from}|${to}`) { setD(null); periodKey.current = `${from}|${to}`; }
    setErr(null);
    fetchAiCalls({ from, to })
      .then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
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
  if (!d) return <div className="chart-card">{navBar}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>{drawer}</div>;

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

  // Пʼять чисел екрана D — з тих самих рядків звіту, стани пунктів — від сервера.
  const cls = done.map((r) => r.checklist);
  const promiseMarks = cls.filter((c) => c != null && c.promise !== "o");
  const late = done.filter((r) => r.promiseState === "late").length;
  const noCall = done.filter((r) => r.promiseState === "broken").length;
  const keptN = done.filter((r) => r.checklist?.promise === "y").length;
  const lost = done.filter((r) => r.conversationType === "lead_lost");
  const lostReact = medianMin(lost.map((r) => r.reactionMin));
  const pricePct = markPct(cls, "price");
  const promisePct = markPct(cls, "promise");
  const avg = avgScore3(done.map((r) => r.checkScore));
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

  const presetOk = (r: (typeof rows)[number]) => preset === "all"
    || (preset === "noPrice" && r.checklist?.price === "n") || (preset === "noCall" && r.promiseState === "broken")
    || (preset === "lost" && r.conversationType === "lead_lost") || (preset === "low" && r.checkScore != null && r.checkScore.yes <= 1);
  const needle = q.trim().toLowerCase();
  const shownD = shown.filter((r) => (view === "all" || r.needsReview) && presetOk(r)
    && (!needle || `${r.summary ?? ""} ${r.managerName ?? ""} ${r.priceValue ?? ""}`.toLowerCase().includes(needle)));
  const presetN = (p: typeof preset) => scoped.filter((r) => p === "noPrice" ? r.checklist?.price === "n" : p === "noCall" ? r.promiseState === "broken"
    : p === "lost" ? r.conversationType === "lead_lost" : p === "low" ? r.checkScore != null && r.checkScore.yes <= 1 : true).length;
  const kpi = (label: string, value: string, sub: string, hint: string) => (
    <div className="ftd-kpi">
      <div className="ftd-kpi-l">{label}<InfoHint text={hint} /></div>
      <div className="ftd-kpi-v">{value}</div>
      <div className="ftd-kpi-s">{sub}</div>
    </div>
  );
  const bar = (v: number | null) => (
    <div className="ftd-bar"><i style={{ width: `${String(v ?? 0)}%` }} /><span>{v == null ? "—" : `${String(v)}%`}</span></div>
  );
  const cell: React.CSSProperties = {};

  return (
    <>
      <div className="ftd" ref={topRef}>
        <div className={`ftd-over${queueOpen ? " is-dim" : ""}`} aria-hidden={queueOpen}>
          <div className="ftd-head">
            <div>
              <div className="ftd-kicker">Продаж · перші розмови з реклами</div>
              <h1 className="ftd-title">Перший дотик · AI
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
            {kpi("Перших розмов", rows.length.toLocaleString("uk-UA"), done.length < rows.length ? `проаналізовано ${String(done.length)}` : "усі проаналізовано",
              "Перші розмови рекламних угод, створених у періоді, у межах вашого доступу. Лише звіт — без «Виключених».")}
            {kpi("Середній бал чек-листа", avg == null ? "—" : `${avg.toLocaleString("uk-UA")} / 3`, `по ${String(done.filter((r) => r.checkScore && r.checkScore.total > 0).length)} розібраних`,
              "Три пункти: запит, ціна, обіцянка. Бал розмови = виконані ÷ ті, що рахуються (втрачений лід — без ціни; без обіцянки — без пункту «обіцянка»), приведено до 3.")}
            {kpi("Назвали ціну", pricePct == null ? "—" : `${String(pricePct)}%`, `${String(cls.filter((c) => c?.price === "y").length)} з ${String(cls.filter((c) => c != null && c.price !== "o").length)}`,
              "Серед розібраних, крім втрачених лідів: там називати ціну нікому.")}
            {kpi("Обіцянки виконано", promisePct == null ? "—" : `${String(promisePct)}%`, `вчасно ${String(keptN)} · пізно ${String(late)} · немає ${String(noCall)}`,
              `Обіцянки передзвонити, термін яких настав: виконано (з розмовою, лише спроби, поза телефонією) — з ${String(promiseMarks.length)}.`)}
            {kpi("Втрачені ліди", lost.length.toLocaleString("uk-UA"), lostReact == null ? "реакція — немає даних" : `реакція (медіана) ${fmtMinutes(lostReact)}`,
              "Клієнт уже вирішив без нас. Реакція — від створення заявки до нашого першого вихідного дзвінка.")}
          </section>

          <section aria-label="Менеджери за чек-листом" className="ftd-card ftd-card-pad">
            <div className="ftd-card-h">
              <h2>Менеджери за чек-листом першого дотику</h2>
              <span style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                {!mgrCollapsed && "частка розмов, де пункт виконано · найслабші — згори · клік по менеджеру фільтрує таблицю, ще клік — знімає"}
                <button type="button" className="ftd-link" aria-expanded={!mgrCollapsed} onClick={toggleMgr}>{mgrCollapsed ? "Розгорнути ▾" : "Згорнути ▴"}</button>
              </span>
            </div>
            {mgrCollapsed
              ? <div className="ftd-sub">{lines.length} менеджерів{weakest ? ` · найслабший бал — ${weakest.name} (${weakest.score!.toLocaleString("uk-UA")})` : ""}{pickedName ? ` · вибрано: ${pickedName}` : ""}</div>
              : (
            <div style={{ overflowX: "auto" }}>
              <div className="ftd-mgr">
                <div className="ftd-mgr-h">Менеджер</div><div className="ftd-mgr-h">Бал</div>
                {CHECK_ITEMS.map((it) => <div key={it.key} className="ftd-mgr-h">{it.label}</div>)}
                {lines.map((l) => (
                  <div key={String(l.managerId)} style={{ display: "contents" }}>
                    <button type="button" className={`ftd-mgr-name${lf.managerId === l.managerId ? " on" : ""}`} aria-pressed={lf.managerId === l.managerId}
                      onClick={() => setLf({ ...lf, managerId: lf.managerId === l.managerId ? null : l.managerId })}>{l.name} <span>· {l.calls}</span></button>
                    <div style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{l.score == null ? "—" : l.score.toLocaleString("uk-UA")}</div>
                    {bar(l.request)}{bar(l.price)}{bar(l.promise)}
                  </div>
                ))}
              </div>
              {lines.length === 0 && <p className="ftd-sub" style={{ margin: 0 }}>Розібраних розмов у періоді ще немає.</p>}
            </div>
              )}
          </section>

          <section aria-label="Розмови" className="ftd-card">
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
              {([["noPrice", "Ціни не було"], ["noCall", "Обіцяв — дзвінка немає"], ["lost", "Втрачені"], ["low", "Бал ≤ 1"]] as const).map(([k, label]) => (
                <button key={k} type="button" className={`ftd-pill${preset === k ? " on" : ""}`} aria-pressed={preset === k}
                  onClick={() => setPreset(preset === k ? "all" : k)}>{label} <b>{presetN(k)}</b></button>
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
                        <th style={cell}>Обіцянка</th><th style={cell}>Реакція</th><th style={cell}>Розбір</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownD.map((r) => (
                        <tr key={r.uniqueid} className="ftd-row" tabIndex={0} aria-label={`Відкрити розмову ${fmtTime(r.calledAt)}`}
                          onClick={() => (d.canReview && r.needsReview ? openQueue(r.uniqueid) : setOpen(r.uniqueid))}
                          onKeyDown={(e) => { if (e.key === "Enter") { if (d.canReview && r.needsReview) openQueue(r.uniqueid); else setOpen(r.uniqueid); } }}>
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
            <div className="ftd-foot">Квадрати чек-листа: запит · ціна · обіцянка (зелений — так, червоний — ні, сірий — не рахується). Клік по рядку з черги відкриває розбір, по іншому — картку.</div>
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
