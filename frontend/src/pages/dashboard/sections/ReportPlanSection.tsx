import { useNavigate } from "react-router-dom";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  fetchReportPlan, fetchManagerDetail, fetchStuckGrouped, saveDealNote, fetchDayItems,
  fetchResponseTimeByManager,
  type ReportPlan, type ReportPlanManager, type ReportPlanDismissed, type KvpManagerDetail, type KvpDetailCell, type Team,
  type DayItemKind, type DayItems, type DealSource, type DealKlass,
  type StuckGrouped, type StuckManagerGroup, type StuckGroupDeal,
} from "../../../api";
import { PeriodStepper } from "../PeriodStepper";
import {
  ddmm, dow, mondayOf, monthEnd, monthStart, sundayOf, todayKyiv,
  periodOf, periodLabelOf, type PeriodMode, type PeriodState,
} from "../periodRules";
import { InfoHint } from "../widgets";
import { ReportTableSection, LevelChip } from "./ReportTableSection";
import { mergeReportPlans } from "../reportScope";
import { firstTouchLabel, firstTouchStale, fmtCallback } from "../reportTableCols";
// 🔀 Зріз за новизною — ЄДИНЕ місце рішення на фронті; звіряється з ядром у `#213`.
import { NON_COMMERCIAL_TEAM_IDS } from "../teamSets";
import { keepByKlass, visibleSlices, narrowToSlice, SLICE_LABEL, KLASS_CHIP, type Slice } from "../klassSlice";
import { useCarrierReport, awaitingByManager } from "../carrierReportData";
import { VacationMark } from "../VacationMark";

/**
 * 🔀 ПОЛОЖЕННЯ ПЕРЕМИКАЧА ЇДЕ КОНТЕКСТОМ, А НЕ ПРОПСОМ.
 *
 * `DayDrill` живе всередині `MgrStrip`, а той викликається з ТРЬОХ місць. Пробивати
 * проп крізь два рівні й три виклики означало б три шанси забути один — рівно те,
 * як розкриття і число розходяться. Контекст читає той, кому воно треба.
 */
const SliceCtx = createContext<Slice>("all");
/** ⏳ «Чекають рішення» по менеджерах (5968) — з того самого звіту, що й нижній блок «Дзвінки на мобільні». */
const AwaitCtx = createContext<ReadonlyMap<number, { awaitingNow: number; overdueNow: number }>>(new Map());

// Статуси-кольори (зарезервовані, з іконкою+підписом — не колір-наодинці). Тема-безпечні.
const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", BAR = "#2f6fdb", MUTED = "var(--text-muted)";
// «Прийшло ⑨» — окремий колір від «Закрито ①»: це РІЗНІ стани тих самих грошей,
// і зливати їх в один відтінок означало б знову подавати дві величини як одну.
const LINK = "#7c3aed";
const SCOL: Record<string, string> = { g: GREEN, a: AMBER, r: RED };
const SLBL: Record<string, string> = { g: "В нормі", a: "Відстає", r: "Зрив" };

/**
 * 🔴 ЧИП «новий/постійний» — ОДИН на обидва розкриття (07.08.2026).
 * Було двічі скопійовано `it.src === "new" ? "новий" : "постійний"`, тобто третій
 * стан (`null` = ядро не змогло визначити) МОВЧКИ друкувався як «постійний».
 * Це той самий клас помилки, який ми тут і виправляємо: невідоме зʼїжджає в
 * конкретну відповідь. Тепер «невизначено» видно, і воно сіре.
 */
function SrcChip({ src, source }: { src: DealKlass; source?: DealSource }) {
  const c = src === "new" ? BAR : src === "rep" ? GREEN : MUTED;
  // 🔴 ПІДПИС — З ЄДИНОГО РЕЄСТРУ (`KLASS_CHIP`), а не потрійний вираз тут.
  // Доти `'undef'` і `null` малювались однаково «невизначено», хоч це різні речі:
  // перше — ядро не змогло визначити клас угоди, друге — рядок узагалі не угода
  // (дзвінок). Поки третій клас був порожній, різниці не було видно; 25.08.2026
  // він ожив (6 угод сторно, −18 004 ₴).
  const t = src == null ? "новизна незастосовна" : KLASS_CHIP[src];
  // 🔴 ДЖЕРЕЛО — ДРУГА, ОКРЕМА ПОЗНАЧКА (18.08.2026). Доти канал угоди ВИРІШУВАВ
  // новизну: усе з реклами й лідогену друкувалось «новий», навіть якщо клієнт возив
  // із нами роками (заміряно: 296 угод за 12 міс). Тепер новизну рахує канон, а
  // «звідки прийшла угода» стоїть поруч власним маркером — дві відповіді на два
  // різні питання, а не одна замість обох.
  // 🔴 ЧОТИРИ ДЖЕРЕЛА, А НЕ ДВА (24.08.2026, Е2 моделі каналів).
  //
  // Було: позначка малювалась лише для `ad`/`leadgen`, решта не малювалась узагалі.
  // Наслідок бачив би кожен, хто розгорне день: «без джерела» — 43.2% створених угод
  // — стояли БЕЗ ПОЗНАЧКИ, тобто так само, як рядки, до яких питання не стосується.
  // Колонка над розкриттям рахувала чотири кошики, розкриття показувало два. Це та
  // сама розбіжність «число проти складу», що вже коштувала нам 12.6% угод серпня
  // на мітці «новий/постійний» — лише в іншому вимірі. Тримає `#175`/`#175c`.
  //
  // ⚠️ «без джерела» ≠ «канал не вказано»: перше — дотику НЕ БУЛО (менеджер завів
  // угоду сам), друге — ми НЕ ЗНАЄМО. Зводити їх в одну позначку означає видати
  // незнання за факт; саме тому тут дві різні гілки, а не одна.
  const S: Record<string, { l: string; t: string; dim?: boolean }> = {
    "ad": { l: "рекл.", t: "джерело угоди — реклама. Окремий вимір: на новизну клієнта не впливає." },
    "leadgen": { l: "лідог.", t: "джерело угоди — лідогенератор. Окремий вимір: на новизну клієнта не впливає." },
    // 🟣 eLogist — окремий канал з 27.10.2026 (рішення власника), НЕ реклама UTS.
    "elogist": { l: "eLogist", t: "джерело угоди — eLogist (сайт elogist.com.ua, сестринський бренд). Окремий канал, НЕ реклама UTS (рішення власника 27.10.2026). На новизну клієнта не впливає." },
    "other": { l: "без джерела", t: "ані рекламного, ані лідоген-дотику не було — угоду завів менеджер сам. Це ВІДПОВІДЬ, а не прогалина; переважно робота з наявною базою." },
    "undef": { l: "канал не вказано", t: "канал угоди не заповнений у CRM — ми НЕ ЗНАЄМО джерела (на відміну від «без джерела», де відомо, що дотику не було).", dim: true },
  };
  const s = source ? S[source] : undefined;
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      <span title={src === null ? "ядро не змогло визначити: немає ні ключа клієнта, ні мітки CRM"
                                : "новизна клієнта — за історією його угод у повному циклі"}
            style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 5,
                     textAlign: "center", background: c + "22", color: c }}>{t}</span>
      {s && (
        <span title={s.t}
              style={{ fontSize: 9, fontWeight: 600, padding: "2px 5px", borderRadius: 5,
                       whiteSpace: "nowrap",
                       background: "var(--surface-2, #f1f5f9)", color: MUTED,
                       ...(s.dim ? { border: `1px dashed ${MUTED}55`, fontStyle: "italic" } : null) }}>{s.l}</span>
      )}
    </span>
  );
}
/**
 * 🔗 НАЗВА УГОДИ — ПОСИЛАННЯ НА ЇЇ КАРТКУ В KOMMO.
 *
 * Один компонент на ОБИДВА розкриття — рівно з тієї ж причини, що й `SrcChip`:
 * два однакові рядки верстки розходяться мовчки, і потім одне розкриття клікабельне,
 * а друге ні. `url` приходить ІЗ СЕРВЕРА (`core/kommoLinks.kommoLeadUrl` від
 * `KOMMO_BASE_URL`) — фронт піддомену акаунта не знає й не зашиває.
 *
 * `target="_blank"` + `rel="noopener noreferrer"`: розкриття дня — робочий список,
 * з якого людина йде в CRM і повертається; підміняти вкладку зі списком не можна.
 * Дзвінки картки не мають (`url === null`) і лишаються звичайним текстом.
 */
function DealName({ name, url }: { name: string; url: string | null }) {
  const style = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
  if (!url) return <span style={style}>{name}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="відкрити картку угоди в Kommo"
       style={{ ...style, color: LINK, textDecoration: "none" }}>{name}</a>
  );
}

const SICON: Record<string, string> = { g: "🟢", a: "🟠", r: "🔴" };

// Комерційний скоуп (A1): у перемикачі команд не показуємо некомерційні команди — фінанси й лідогенерацію
// (= бекенд KVP_FINANCE/LEADGEN). Список один на фронт — pages/dashboard/teamSets.ts.
const HIDE_TEAMS = NON_COMMERCIAL_TEAM_IDS;
const fmt = (n: number) => (n === 0 ? "0" : Math.round(n).toLocaleString("uk-UA").replace(/,/g, " "));
const k = (n: number) => Math.round(n / 1000) + "к";
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

// ── дати (Пн–Нд, локально) — ПЕРЕЇХАЛИ в `../periodRules`, бо їх просить і «Реклама».
// Тіла не мінялись: переїзд, який «заодно покращує», неможливо прийняти.
// Компактна розбивка авто за джерелом (пост/лід/рекл/невз), нулі приховані. «5пост · 3лід · 1рекл».
// 🟣 `elogist` — п'ята частина з 27.10.2026 (рішення власника): до того ці авто стояли в «рекл».
const autoSplit = (repeat: number, leadgen: number, ad: number, elogist: number, undef: number): string =>
  ([[repeat, "пост"], [leadgen, "лід"], [ad, "рекл"], [elogist, "eLogist"], [undef, "невз"]] as [number, string][])
    .filter(([n]) => n > 0).map(([n, l]) => `${n}${l}`).join(" · ");

/** Режими живуть у `../periodNav` — щоб «Реклама» й Звіт не мали двох переліків. */
type Mode = PeriodMode;

export function ReportPlanSection({ auth, teams }: {
  auth: { role: string; managerId: number | null; teamId: number | null };
  teams: Team[];
}) {
  const today = todayKyiv();
  const [mode, setMode] = useState<Mode>("month");
  /**
   * 🔀 Е3 — ЗРІЗ ЗА НОВИЗНОЮ КЛІЄНТА. Звужує «Створено» і розклад його джерела,
   * а також СКЛАД розкриття того самого числа. Інші числа (гроші, дзвінки,
   * відправлені авто) НЕ звужуються — і їхні розкриття теж, інакше ми б завели
   * рівно ту розбіжність «число проти складу», від якої цей перемикач і береже.
   */
  const [slice, setSlice] = useState<Slice>("all");
  /**
   * 🖥 ВИГЛЯД: картки (як було) або таблиця. Перемикач СУТО презентаційний —
   * обидва вигляди читають той самий `periodData`, тож перемикання не робить
   * жодного запиту і не може показати інші числа.
   */
  const [view, setView] = useState<"cards" | "table">(
    () => (localStorage.getItem("rptView") === "table" ? "table" : "cards"));
  const pickView = (v: "cards" | "table") => { setView(v); localStorage.setItem("rptView", v); };
  const [anchor, setAnchor] = useState(today);        // якір (місяць + навігація)
  const [focusDay, setFocusDay] = useState(today);    // активний день (тиждень-контекст + кластер)
  const [rangeFrom, setRangeFrom] = useState(monthStart(today));
  const [rangeTo, setRangeTo] = useState(today);
  /**
   * 🧩 ОБСЯГ — СПИСОК КОМАНД, а не одна (рішення власника 21.08.2026). Порожній =
   * весь відділ, одна = теперішня поведінка байт-у-байт (той самий одиничний
   * запит), 2+ = кілька запитів і злиття. Стан ОДИН на обидва вигляди: два стани
   * скоупу дали б екран, де картки й таблиця показують різні набори людей.
   */
  const [teamIds, setTeamIds] = useState<number[]>([]);
  /** Сумісність із тим, що вміє лише одну команду (StuckBlock, час реакції, select карток). */
  const teamId: number | "" = teamIds.length === 1 ? teamIds[0] : "";
  const setTeamId = (v: number | "") => setTeamIds(v === "" ? [] : [Number(v)]);
  const [monthData, setMonthData] = useState<ReportPlan | null>(null); // місяць (дефолт + смуга місяця)
  const [rangeData, setRangeData] = useState<ReportPlan | null>(null);  // довільний діапазон (режим «Період»)
  const [rangeLoading, setRangeLoading] = useState(false);
  const [weekData, setWeekData] = useState<ReportPlan | null>(null);   // тиждень-контекст смуги
  const [focus, setFocus] = useState<ReportPlan | null>(null);         // кластер фокус-дня
  const [loading, setLoading] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0); // ручний «Спробувати знову» перезапускає ефект
  const [openMgr, setOpenMgr] = useState<number | null>(null);

  // Тижнева смуга ЛИШАЄТЬСЯ на власному якорі (Пн–Нд тижня focusDay) — рішення власника:
  // вона про поточний тиждень людини, а не про обраний період.
  const monthPeriod = useMemo(() => ({ from: monthStart(anchor), to: monthEnd(anchor) }), [anchor]);
  const weekPeriod = useMemo(() => ({ from: mondayOf(focusDay), to: sundayOf(focusDay) }), [focusDay]);
  /**
   * 🔴 ОБРАНИЙ ПЕРІОД — ОДНЕ ПОНЯТТЯ НА ВЕСЬ ЕКРАН (18.08.2026).
   *
   * Було: цей вираз звався `drillPeriod` і доходив РІВНО до розгортки по днях, а тіло
   * Звіту читало `monthData` завжди (`const data = monthData`). Тобто перемикач
   * «Тиждень/Період» не змінював ані ростер, ані glance, ані гроші — людина бачила
   * місяць під підписом тижня. Гірше: `mode`/`rangeFrom`/`rangeTo` не стояли в
   * залежностях ефекту, тож режим «Період» не робив ЖОДНОГО запиту.
   * Тепер той самий вираз живить і тіло, і дрил — розійтись їм більше нема як.
   */
  const navState: PeriodState = { mode, anchor, focusDay, rangeFrom, rangeTo };
  const selectedPeriod = useMemo(() => periodOf({ mode, anchor, focusDay, rangeFrom, rangeTo }),
    [mode, anchor, focusDay, rangeFrom, rangeTo]);
  const periodLabel = periodLabelOf(navState);
  // 🚚 «Дзвінки на мобільні» — мітка «чекають рішення» в картці менеджера (5968). Нижнього блоку з 11.11.2026 немає
  //    (зустріч 10.11, правка 7): мітка веде на вкладку «Перевізники за розмовою».
  const carrier = useCarrierReport(selectedPeriod.from, selectedPeriod.to, teamIds.length === 1 ? teamIds[0] : undefined);
  const awaitMap = useMemo(() => awaitingByManager(carrier.rep), [carrier.rep]);
  /** Патч від навігатора → сеттери. Розкладено поіменно: `mode` тут не «одне з полів»,
      а окреме рішення, і зсув його разом із датами був би тихою зміною поведінки. */
  const applyNav = (patch: Partial<PeriodState>) => {
    if (patch.mode !== undefined) setMode(patch.mode);
    if (patch.anchor !== undefined) setAnchor(patch.anchor);
    if (patch.focusDay !== undefined) setFocusDay(patch.focusDay);
    if (patch.rangeFrom !== undefined) setRangeFrom(patch.rangeFrom);
    if (patch.rangeTo !== undefined) setRangeTo(patch.rangeTo);
  };

  /**
   * 🔴 ОДИН ШЛЯХ ЗАВАНТАЖЕННЯ НА ВСІ ЧОТИРИ ЗАПИТИ (місяць, тиждень, фокус-день,
   * діапазон). Розвилка «одна команда / кілька» стоїть ТУТ і ніде більше —
   * інакше злиття лягло б лише в один із чотирьох, і тиждень почав би показувати
   * інший набір людей, ніж місяць.
   */
  const scopeKey = teamIds.join(",");
  const fetchScoped = useCallback(async (period: { from: string; to: string }): Promise<ReportPlan> => {
    if (teamIds.length >= 2)
      return mergeReportPlans(await Promise.all(teamIds.map((id) => fetchReportPlan({ ...period, teamId: id }))));
    return fetchReportPlan({ ...period, ...(teamIds.length === 1 ? { teamId: teamIds[0] } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // САМОВІДНОВЛЕННЯ (фікс порожнечі при транзієнтному відхиленні):
  //  • cancelled-guard: жоден перерваний/застарілий виклик не пише стан (антигонка).
  //  • МІСЯЦЬ (головне тіло) — з авто-ретраєм (2 спроби + backoff); транзієнтний блимок
  //    піднімається САМ, без ручного refresh. Провал ПІСЛЯ ретраїв → err (видима помилка+ретрай).
  //  • ТИЖДЕНЬ/ФОКУС — best-effort (allSettled): їхня невдача НЕ обнуляє звіт (не «все або нічого»).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const withRetry = async (params: { from: string; to: string }, attempts = 3) => {
      for (let i = 0; ; i++) {
        try { return await fetchScoped(params); }
        catch (e) {
          if (cancelled) throw e;
          if (i >= attempts - 1) throw e;
          // Челендж/429 → довший експоненційний backoff з cap (не тайт-петля, щоб не «годувати»
          // хостинговий захист); звичайна помилка — коротший. base·2^i, cap 8с.
          const challenge = (e as { isChallenge?: boolean })?.isChallenge === true;
          await new Promise((r) => setTimeout(r, Math.min((challenge ? 2000 : 400) * 2 ** i, 8000)));
        }
      }
    };
    (async () => {
      try {
        const m = await withRetry(monthPeriod);
        if (cancelled) return;
        setMonthData(m);
        const [w, f] = await Promise.allSettled([
          fetchScoped(weekPeriod),
          fetchScoped({ from: focusDay, to: focusDay }),
        ]);
        if (cancelled) return;
        if (w.status === "fulfilled") setWeekData(w.value);
        if (f.status === "fulfilled") setFocus(f.value);
      } catch {
        // Порожнечу мовчки не лишаємо: `periodData` лишиться null → екран покаже
        // помилку з кнопкою «Спробувати знову» (умова нижче — по ДАНИХ, не по прапорцю,
        // тож вона накриває і тиждень, і день, і діапазон, а не лише місяць).
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [monthPeriod.from, monthPeriod.to, weekPeriod.from, weekPeriod.to, focusDay, scopeKey, retryNonce, fetchScoped]);

  /**
   * Довільний діапазон — ОКРЕМИЙ ефект, а не гілка в ефекті вище: місяць/тиждень/день
   * потрібні іншим віджетам ЗАВЖДИ (смуга тижня, кластер дня), і тягнути їх заново на
   * кожен зсув діапазону було б чистою витратою. Залежності містять `selectedPeriod` —
   * саме їх бракувало, через що режим «Період» не робив запиту взагалі.
   */
  useEffect(() => {
    if (mode !== "range") return;
    let cancelled = false;
    setRangeLoading(true);
    fetchScoped({ from: selectedPeriod.from, to: selectedPeriod.to })
      .then((r) => { if (!cancelled) setRangeData(r); })
      .catch(() => { if (!cancelled) setRangeData(null); })
      .finally(() => { if (!cancelled) setRangeLoading(false); });
    return () => { cancelled = true; };
    // 🔴 `scopeKey`, А НЕ `teamId`. Похідний `teamId` дорівнює "" ЩОРАЗУ, коли обрано
    // 2+ команди, тож зміна набору [5,6] → [5,6,13] його не зрушує — і режим «Період»
    // мовчки лишався б на попередньому наборі. Це та сама поломка, від якої гейт
    // `#79b` і поставлений: він її й спіймав, уже на проді.
  }, [mode, selectedPeriod.from, selectedPeriod.to, scopeKey, retryNonce, fetchScoped]);

  /**
   * 🔴 ТІЛО ЗВІТУ ЙДЕ ЗА ОБРАНИМ ПЕРІОДОМ. Готові відповіді ПЕРЕВИКОРИСТОВУЮТЬСЯ
   * (день/тиждень/місяць уже завантажені ефектом вище) — новий запит потрібен лише
   * діапазону. Підміни на `monthData` тут бути НЕ МОЖЕ: показати місяць під підписом
   * тижня гірше, ніж показати «даних немає», — тому фолбеку на місяць немає навмисно.
   */
  /**
   * ⏱ ЧАСТКА ПОВІЛЬНИХ ЛІДІВ ПО МЕНЕДЖЕРАХ — лише для табличного вигляду й лише
   * коли він відкритий: у картках цієї колонки немає, тож тягнути її завжди
   * означало б платити запитом за те, чого ніхто не бачить.
   *
   * `undefined` у мапі = «менеджера немає у видачі», тобто вхідних лідів у періоді
   * не було. Це НЕ «нуль повільних» — клітинка покаже «—».
   */
  const [respByMgr, setRespByMgr] = useState<Map<number, number | null> | undefined>(undefined);
  useEffect(() => {
    if (view !== "table") return;
    let alive = true;
    setRespByMgr(undefined);
    fetchResponseTimeByManager({ from: selectedPeriod.from, to: selectedPeriod.to, ...(teamId ? { teamId: Number(teamId) } : {}) })
      .then((rows) => { if (alive) setRespByMgr(new Map(rows.map((r) => [r.managerId, r.pctSlow]))); })
      .catch(() => { if (alive) setRespByMgr(new Map()); });
    return () => { alive = false; };
  }, [view, selectedPeriod.from, selectedPeriod.to, teamId, retryNonce]);

  const periodData = mode === "range" ? rangeData
    : mode === "week" ? weekData
    : mode === "day" ? focus
    : monthData;
  const data = periodData;
  const busy = loading || rangeLoading;
  const weekByMgr = useMemo(() => new Map((weekData?.managers ?? []).map((m) => [m.managerId, m])), [weekData]);
  const viewerId = data?.viewerManagerId ?? auth.managerId;
  const teamName = teamId ? teams.find((t) => t.id === Number(teamId))?.name : "";

  // Навігація ←/→ живе в `navBy` (../periodRules) — те саме правило кроку тепер
  // виконує й «Реклама». Тіло не мінялось.

  /**
   * 📅 ДЕНЬ ПЛИТКИ «СЬОГОДНІ» — останній день обраного періоду, але не пізніше сьогодні.
   * Смуги днів у новому вигляді немає (макет, 13.11.2026): конкретний день дивляться
   * режимом «День». Тиждень картки рахується від цього ж дня — тобто це тиждень,
   * у якому лежить показаний день, а не довільний.
   */
  const dayShown = selectedPeriod.to > today ? today : selectedPeriod.to;
  useEffect(() => {
    if (mode !== "day" && focusDay !== dayShown) setFocusDay(dayShown);
  }, [mode, dayShown, focusDay]);

  /** Чип стану = фільтр списку в ОБОХ виглядах; підсумок угорі він не звужує. */
  const [statusFilter, setStatusFilter] = useState<"g" | "a" | "r" | null>(null);
  const shownManagers = (data?.managers ?? []).filter((m) => !statusFilter || m.status === statusFilter);
  const listCount = `${shownManagers.length} з ${data?.managers.length ?? 0} менеджерів`;
  const toolbar = data && (
    <>
      <SliceSwitch data={data} slice={slice} onSlice={setSlice} />
      {statusFilter && (
        <span className="rv-fpill">лише «{SLBL[statusFilter].toLowerCase()}»
          <button type="button" aria-label="Скинути фільтр" onClick={() => setStatusFilter(null)}>×</button></span>
      )}
      <span className="rv-count">{listCount}</span>
    </>
  );

  return (
    <div className={`rv${busy ? " rv-loading" : ""}`}>
      {/* Шапка: назва · період (варіант «А») · команда · вигляд. Підзаголовок «план 2.7 млн»,
          чип «Ти бачиш» і смугу днів прибрано за макетом, погодженим 13.11.2026. */}
      <header className="rv-head">
        <h1>Звіт{teamName ? ` — ${teamName}` : ""}</h1>
        <PeriodStepper state={navState} onPatch={applyNav} today={today} />
        <div className="rv-grow" />
        {auth.role === "admin" && (
          <select className="rv-sel" aria-label="Команда" value={teamId}
            onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Усі команди</option>
            {teams.filter((t) => !HIDE_TEAMS.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <div className="rv-seg rv-view" role="group" aria-label="Вигляд">
          {(["table", "cards"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => pickView(v)}>{v === "cards" ? "Картки" : "Таблиця"}</button>
          ))}
        </div>
      </header>

      {!data && !busy ? (
        <div style={{ textAlign: "center", padding: 28, color: MUTED }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>⚠️</div>
          <div style={{ marginBottom: 12 }}>
            Не вдалося завантажити звіт за {periodLabel} (тимчасовий збій зʼєднання).
          </div>
          <button onClick={() => setRetryNonce((n) => n + 1)}
            style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: BAR, color: "#fff", fontWeight: 700, cursor: "pointer" }}>
            Спробувати знову
          </button>
        </div>
      ) : busy && !data ? <div style={{ color: MUTED, padding: 20 }}>Завантаження…</div> : data && (
        <SliceCtx.Provider value={slice}><AwaitCtx.Provider value={awaitMap}>
          <Glance data={data} focus={focus} focusDay={dayShown} today={today} periodLabel={periodLabel}
            statusFilter={statusFilter} onStatus={setStatusFilter} />
          {/* Застряглі — один рядок, розкривається на місці. Стан на зараз, не за періодом. */}
          <StuckBlock teamId={teamId ? Number(teamId) : undefined} />
          {/* 🗑 «Час опрацювання заявки», «Перший дотик · звіт по менеджерах» і «Дзвінки на мобільні» зі Звіту
              ПРИБРАНО (зустріч 10.11.2026, правки 3, 6, 7 — погодили Саша, Юля, Сергій). Пропущені й передзвін
              стали колонками таблиці; «Перший дотик» живе на своїй вкладці (колонка «Ціну названо» лишилась);
              дзвінки на мобільні — вкладка «Перевізники за розмовою». Компоненти блоків НЕ видалено. */}
          {view === "table" ? (
            <ReportTableSection
              data={data} auth={auth}
              periodLabel={periodLabel}
              responseByMgr={respByMgr} month={selectedPeriod.from.slice(0, 7)} slice={slice}
              statusFilter={statusFilter} toolbar={toolbar}
            />
          ) : (<>
            <div className="rv-bar">{toolbar}</div>
            {/* 🔴 ЗРІЗ ДІЄ Й НА КАРТКУ, А НЕ ЛИШЕ НА ТАБЛИЦЮ (знайдено скріншотом
                приймання 25.08.2026): картка показувала повне «створено» під звуженим
                підписом. Тому кожна картка отримує `narrowToSlice(m, slice)`. */}
            <div className="rv-cards">
              {/* Менеджер бачить свою картку першою — решта за станом, хто відстає, той угорі. */}
              {[...shownManagers].sort((a, b) => Number(b.managerId === viewerId) - Number(a.managerId === viewerId)).map((m) => (
                <MgrStrip key={m.managerId} m={narrowToSlice(m, slice)} mWeek={weekByMgr.get(m.managerId)}
                  focusDay={focusDay} today={today} elapsed={data.elapsed} remWd={data.remainingWorkdays}
                  weekLabel={`${ddmm(weekPeriod.from)}–${ddmm(weekPeriod.to)}`} weekPeriod={weekPeriod} drillPeriod={selectedPeriod}
                  periodLabel={periodLabel} isMonthMode={mode === "month"} weeksFirst={mode === "month" || mode === "range"} role={auth.role}
                  isSelf={m.managerId === viewerId}
                  open={openMgr === m.managerId} onToggle={() => setOpenMgr(openMgr === m.managerId ? null : m.managerId)} />
              ))}
            </div>
            {shownManagers.length === 0 && <div style={{ color: MUTED, padding: 20 }}>Немає менеджерів у цьому розрізі.</div>}
            <DismissedRows rows={data.dismissed ?? []} />
          </>)}
        </AwaitCtx.Provider></SliceCtx.Provider>
      )}
    </div>
  );
}

/**
 * 💸 ЛЮДИ ПОЗА РОСТЕРОМ, АЛЕ З ГРІШМИ — ВИДИМИЙ РЯДОК, А НЕ ЛИШЕ ДОДАНОК У СУМІ.
 *
 * 🔴 ПРИВІД, І ВІН НЕ ГІПОТЕТИЧНИЙ. `glance.fact` включає їхні гроші (інакше Σ по
 * екрану розійшлася б із ядром), а верстка масив `dismissed` не знала — тобто кільце
 * показувало суму, частину якої НЕ ПОЯСНЮВАВ ЖОДЕН ВИДИМИЙ РЯДОК. Заміряно 06.08.2026,
 * поки Шевчук був деактивований: 71 896 ₴ у сумі компанії без рядка на екрані.
 *
 * Рішення власника 01.09.2026 зробило цей рядок обовʼязковим: стан «завершує» означає
 * «плану немає, результат рахується й людина ПОКАЗУЄТЬСЯ з позначкою». Без цього блоку
 * переведення людини в «завершує» просто ховало б її з екрана разом із її роботою.
 *
 * ⚠️ Плану, %, світлофора й темпу тут НЕМАЄ навмисно: ставити план тому, кому його не
 * ставлять, безглуздо, а порожня шкала читалась би як «зрив».
 */
function DismissedRows({ rows }: { rows: ReportPlanDismissed[] }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.fact, 0);
  return (
    <div style={{ marginTop: 14, border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", background: "var(--card-bg)" }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
        Поза ростером, але з результатом — <b style={{ color: "var(--text)" }}>{fmt(total)} ₴</b>
        <span style={{ marginLeft: 6 }}>· ці гроші ВХОДЯТЬ у суму команди й компанії, плану в цих людей немає</span>
      </div>
      {rows.map((r) => (
        <div key={r.managerId} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "4px 0", fontSize: 13, borderTop: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
          {r.badge && <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", color: MUTED }}>{r.badge}</span>}
          <span style={{ fontSize: 11, color: MUTED }}>{r.teamName ?? "без команди"}</span>
          <span style={{ marginLeft: "auto", fontWeight: 600 }}>{fmt(r.fact)} ₴</span>
          <span style={{ fontSize: 11, color: MUTED }}>{r.factSuccessDeals + r.factPaidDeals} угод</span>
        </div>
      ))}
    </div>
  );
}


/**
 * 🔴 ПІДПИС ІДЕ ЗА ОБРАНИМ ПЕРІОДОМ, А НЕ КАЖЕ «ЗА МІСЯЦЬ» ЗАВЖДИ (20.08.2026).
 *
 * `Glance` отримує `periodData` — тобто числа ЗА ОБРАНИЙ ПЕРІОД. Підпис при цьому
 * був зашитий: у режимі «Тиждень» над сумою 587 590 ₴ за 10–16.08 стояло
 * «Команда за місяць». Це рівно той клас, що ми вже ловили тричі: підпис
 * правдоподібний, величина за ним інша.
 *
 * ⏭ ВИНЯТОК, ЯКИЙ ЛИШАЄТЬСЯ: плитка «ОЧІКУЄМО … цей міс» справді КАЛЕНДАРНО-
 * місячна (`expectedByManagerDay` за плановою датою оплати) і від обраного періоду
 * не залежить. Її підпис уже чесний, і міняти його означало б збрехати навпаки.
 */
/**
 * 🔀 ПЕРЕМИКАЧ ЗРІЗУ ЗА НОВИЗНОЮ (Е3, рішення власника 25.08.2026).
 *
 * 🔴 ТРЕТЄ ПОЛОЖЕННЯ — УМОВНЕ, і це не дрібниця. «Невизначено» показується ЛИШЕ
 * тоді, коли клас непорожній: у липні його нуль, у серпні — 6 угод на −18 004 ₴
 * (сторно без `client_key`). Постійно висяче положення з нулем бреше рівно так
 * само, як заголовок плитки «(понад ліміт)» над списком, куди входять і клієнти
 * без ліміту. Тримають `#212b` (є → видно) і `#212c` (немає → не видно) — двома
 * саботажами в протилежні боки, на липні й серпні відповідно.
 *
 * 🔴 ПІДПИС У ВВІМКНЕНОМУ СТАНІ ОБОВʼЯЗКОВИЙ. Без нього звужені числа читаються
 * як повні — це той самий клас, що дві правильні метрики без підпису, які
 * читаються як поломка. Тримає `#214`.
 */
const SHORT_SLICE: Record<Exclude<Slice, "undef">, string> = { all: "усі", new: "нові", rep: "постійні" };
function SliceSwitch({ data, slice, onSlice }: { data: ReportPlan; slice: Slice; onSlice: (v: Slice) => void }) {
  // Третій клас існує, якщо він непорожній ХОЧ У КОГОСЬ: ховати положення через
  // те, що в одного менеджера нуль, означало б ховати саме ті угоди, які шукають.
  const undefCount = data.managers.reduce((a, m) => a + (m.srcByKlass?.undef.created ?? 0), 0);
  // 🔴 РІШЕННЯ ПРО ВИДИМІСТЬ — НЕ ТУТ. `visibleSlices` живе в чистому модулі й
  // звіряється з ядром поведінкою (`#212b`/`#212c`/`#213`); умова, написана у
  // верстці, перевірялась би лише регуляркою по джерелу — тобто «що написано»,
  // а не «що працює».
  const shown: Slice[] = visibleSlices(undefCount);
  const total = data.managers.reduce((a, m) => a + m.created, 0);
  const inSlice = slice === "all" ? total
    : data.managers.reduce((a, m) => a + (m.srcByKlass?.[slice].created ?? 0), 0);
  return (
    <>
      <span className="lab">Створені угоди:</span>
      <div className="rv-seg" role="group" aria-label="Створені угоди">
        {shown.map((s) => (
          <button key={s} type="button" aria-pressed={slice === s} onClick={() => onSlice(s)}
            title={SLICE_LABEL[s]}>
            {/* Короткі підписи кнопок — як у макеті; повна назва зрізу (`SLICE_LABEL`) — у плашці нижче й у підказці. */}
            {s === "undef" ? `невизначено · ${undefCount}` : SHORT_SLICE[s]}
          </button>
        ))}
      </div>
      {slice !== "all" && (
        <span className="rv-slicewarn">
          ⚠️ показано <b>{SLICE_LABEL[slice]}</b> — {inSlice} із {total} створених;
          <span style={{ color: MUTED }}> звужено і числа, і склад розкриття дня. Гроші, дзвінки й відправлені авто НЕ звужуються.</span>
        </span>
      )}
    </>
  );
}

/** Колір виконання — те саме правило, що в `Donut` (≥100 / ≥70 / решта): одне правило на кільце й смугу. */
const pctColor = (pct: number) => (pct >= 100 ? "var(--rv-ok)" : pct >= 70 ? "var(--rv-warn)" : "var(--rv-bad)");
const WD_FULL = ["понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота", "неділя"];

/**
 * 🧭 ПІДСУМОК — ЧОТИРИ ПЛИТКИ (макет, погоджено 13.11.2026). Числа — ті самі поля
 * `glance`, що й раніше; змінилось лише розташування. Розклад «успішно + оплачено ·
 * чек» переїхав у підказку кільця, «поза ростером» і кількість нерозібраних розмов —
 * у підказку «ціну названо».
 */
function Glance({ data, focus, focusDay, today, periodLabel, statusFilter, onStatus }: {
  data: ReportPlan; focus: ReportPlan | null; focusDay: string; today: string; periodLabel: string;
  statusFilter: "g" | "a" | "r" | null; onStatus: (s: "g" | "a" | "r" | null) => void;
}) {
  const g = data.glance;
  const pct = g.plan > 0 ? Math.round((g.fact / g.plan) * 100) : 0;
  const fg = focus?.glance;
  const st = g.statusCounts;
  const futureFocus = focusDay > today;
  const ftGlance = firstTouchLabel(g.firstTouch);
  const ftOutside = (g.firstTouch?.outside.analyzed ?? 0) + (g.firstTouch?.outside.noRecord ?? 0);
  const col = pctColor(pct);
  const pace = Math.round(Math.min(1, Math.max(0, data.elapsed)) * 100);
  const dayHead = focusDay === today ? "Сьогодні" : WD_FULL[dow(focusDay) - 1].replace(/^./, (c) => c.toUpperCase());
  const ringTitle = `Круг оплати — факт (отримані кошти): ${fmt(g.fact)} ₴\n= успішно реалізовано (виграно 142): ${fmt(g.factSuccess)} ₴\n+ оплачено: ${fmt(g.factPaid)} ₴\nчек: ${g.avgCheck == null ? "—" : fmt(g.avgCheck) + " ₴"}`;
  return (
    <section className="rv-kpis">
      <div className="rv-tile">
        <div className="rv-team">
          <div className="rv-ring" title={ringTitle} style={{ background: `conic-gradient(${col} ${Math.min(100, pct) * 3.6}deg, var(--rv-soft) 0)` }}>
            <span>{pct}%</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="lab">Команда · {periodLabel} {data.scope.isCurrent && <span className="rv-cur">поточний</span>}
              <InfoHint text="Грошовий план — стратегічна ціль із вкладки «Плани». Факт — отримані кошти ② з ядра: угоди, що увійшли в «Успішно» чи «Оплачено» в обраному періоді, без повторів. Вертикальна риска — де мав би бути факт, якщо йти рівно по плану." />
            </div>
            <div className="val">{fmt(g.fact)} <small>з {fmt(g.plan)} ₴</small></div>
            <div className="rv-pace">
              <i style={{ width: `${Math.min(100, pct)}%`, background: col }} />
              {data.scope.isCurrent && <em style={{ left: `${pace}%` }} title={`темп: ${pace}% робочих днів минуло`} />}
            </div>
          </div>
        </div>
        {/* 🔵 Три стани покривають УСІХ: Σ чипів = кількість менеджерів (рішення власника 07.08.2026). */}
        <div className="rv-chips">
          {(["r", "a", "g"] as const).map((s) => (
            <button key={s} type="button" className={`rv-schip ${s}`} aria-pressed={statusFilter === s}
              title="Клік — показати лише їх у списку" onClick={() => onStatus(statusFilter === s ? null : s)}>
              {st[s]} {s === "r" ? "зрив" : s === "a" ? "відстає" : "у нормі"}
            </button>
          ))}
        </div>
      </div>
      <div className="rv-tile">
        <div className="lab">Очікуємо за план. датою <InfoHint text="За плановою датою оплати (коли має надійти); зміна дати переносить угоду між місяцями. «Цей міс» входить у прогноз; без дати — ні. Календарні місяці — від обраного періоду НЕ залежить." /></div>
        <div className="val" style={{ color: g.expectThisMonth > 0 ? "var(--rv-ok)" : MUTED }}>{fmt(g.expectThisMonth)} <small>₴ цей міс</small></div>
        <div className="rv-mini">
          <span>наступний місяць</span><b>{fmt(g.expectNextMonth)} ₴</b>
          {/* 🔴 «З минулих місяців» — НЕ «прострочено» з плитки КВП: там межа «сьогодні», тут — початок місяця. */}
          <span>з минулих місяців</span><b style={{ color: g.expectPastMonths !== 0 ? "var(--rv-warn)" : undefined }}>{fmt(g.expectPastMonths)} ₴</b>
        </div>
      </div>
      <div className="rv-tile">
        <div className="lab">Авто й ціна · {periodLabel}</div>
        <div className="val">{g.dispatched} <small>авто</small></div>
        <div className="rv-mini">
          <span>на суму</span><b>{fmt(g.dispatchedRevenue)} ₴</b>
          <span>ціну названо в 1-й дотик
            <InfoHint text={"AI-розбір перших розмов із рекламними лідами — ті самі розмови й те саме правило, що плитка «Ціна озвучена» на екрані «Перший дотик · AI». Відсоток — із сум (Σ названих ÷ Σ оцінених), по людях ростеру. "
              + (ftOutside > 0 ? `Ще ${ftOutside} оцінок у людей поза ростером — у відсоток не входять. ` : "")
              + "Розбір діє для угод, створених з 20.09.2026. Розмов без менеджера за період: "
              + `${String((data.firstTouchMeta?.unmapped.analyzed ?? 0) + (data.firstTouchMeta?.unmapped.noRecord ?? 0))}.`} />
          </span><b>{ftGlance.main}{ftGlance.sub ? <span style={{ color: MUTED, fontWeight: 500 }}> · {ftGlance.sub}</span> : null}</b>
        </div>
        {g.firstTouch?.state === "measured" && firstTouchStale(data.firstTouchMeta?.lastAnalyzedAt ?? null, today, data.scope.to) && (
          <div className="warnline">⚠ AI не розбирав розмов з {data.firstTouchMeta?.lastAnalyzedAt ? ddmm(data.firstTouchMeta.lastAnalyzedAt) : "—"} — число неповне</div>
        )}
      </div>
      <div className="rv-tile">
        <div className="lab">{dayHead}, {ddmm(focusDay)}</div>
        {futureFocus ? (
          <div className="val" style={{ color: MUTED }}>— <small>ще попереду</small></div>
        ) : (
          <div className="val">{fg?.dispatched ?? 0} <small>авто · {k(fg?.fact ?? 0)} отримано</small></div>
        )}
        <div className="sub">{futureFocus ? "день ще не настав" : <>створено <b>{fg?.created ?? 0}</b> угод</>}</div>
      </div>
    </section>
  );
}
export function Donut({ pct, title }: { pct: number; title?: string }) {
  const col = pct >= 100 ? GREEN : pct >= 70 ? AMBER : RED;
  const ring = Math.min(100, Math.max(0, pct)); // кільце ≤100% візуально, число повне
  return (
    <div title={title} style={{ width: 58, height: 58, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", position: "relative", cursor: title ? "help" : undefined, background: `conic-gradient(${col} ${ring}%, var(--border) 0)` }}>
      <div style={{ width: 42, height: 42, background: "var(--card-bg)", borderRadius: "50%", position: "absolute" }} />
      <span style={{ position: "relative", fontWeight: 750, fontSize: 13 }}>{pct}%</span>
    </div>
  );
}

// Смуга менеджера: МІСЯЦЬ (головна траєкторія, статус+сортування) + ТИЖДЕНЬ (поточний), обидва завжди (#11).
/**
 * 🃏 КАРТКА МЕНЕДЖЕРА — НОВИЙ ВИГЛЯД (макет, погоджено 13.11.2026).
 *
 * Згорнута — один рядок: хто · смуга періоду з рискою темпу · смуга тижня · чотири
 * числа. Розкрита — «чому», три блоки (задача тижня із Задачника · гроші тижня ·
 * дзвінки) і розкриття по тижнях/днях. Числа — ті самі поля рядка, що й раніше:
 * змінилась верстка, не розрахунок. Імʼя `MgrStrip` лишено навмисно — його ж
 * малює таблиця для одного менеджера, і гейти читають саме цю назву.
 */
function MgrStrip({ m, mWeek, focusDay, today, elapsed, weekLabel, weekPeriod, drillPeriod, periodLabel, isMonthMode, weeksFirst, role, isSelf, open, onToggle }: {
  m: ReportPlanManager; mWeek: ReportPlanManager | undefined;
  focusDay: string; today: string; elapsed: number; remWd: number; weekLabel: string;
  weekPeriod: { from: string; to: string };
  drillPeriod: { from: string; to: string };
  /** Підпис ОБРАНОГО періоду — щоб жоден заголовок не казав «Місяць» над тижневими цифрами. */
  periodLabel: string; isMonthMode: boolean;
  /**
   * 📅 Рівень розкриття: `true` — спершу тижні (Місяць/Період), `false` — одразу дні
   * (День/Тиждень). Рішення власника 20.08.2026: у коротких режимах рівень тижнів
   * порожній за змістом — блок там один.
   */
  weeksFirst: boolean;
  role: string; isSelf?: boolean; open: boolean; onToggle: () => void;
}) {
  const s = m.status; // статус за ОБРАНИМ періодом
  const aw = useContext(AwaitCtx).get(m.managerId);
  const navigate = useNavigate();
  const pct = m.plan > 0 ? Math.round((m.fact / m.plan) * 100) : 0;
  const wPct = m.week.target > 0 ? Math.round((m.week.fact / m.week.target) * 100) : 0;
  const showWhy = s !== "g";
  // Сер.чек: виграно_дохід÷виграно_угод (==КВП); нема виграних, а є відправлені авто →
  // Σ сума відправлених÷авто (load_at, signed) з поміткою «*відпр.»; нема й авто → «—».
  const dispCnt = m.kpi.dispatch.fact ?? 0;
  const chekAlt = m.kpi.avgCheck.fact == null && dispCnt > 0;
  const chekFact = m.kpi.avgCheck.fact != null ? m.kpi.avgCheck.fact
    : (chekAlt ? Math.round((m.kpi.dispatch.revenue ?? 0) / dispCnt) : null);
  const ft = firstTouchLabel(m.firstTouch);
  const sc = SCOL[s];
  return (
    <article className={`rv-mc${open ? " open" : ""}${isSelf ? " self" : ""}`} style={{ ["--sc" as string]: sc }}>
      <div className="hd" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <div className="who">
          {/* 🎚 «Старт / Профі» з «Найму» замість РНК/РПК (зустріч 10.11.2026, правка 4). */}
          <b>{m.name}</b> <LevelChip level={m.level} /> <VacationMark managerId={m.managerId} />
          <div className="ln2">{m.teamName ?? "без команди"} · <span style={{ color: sc, fontWeight: 700 }}>{SLBL[s].toLowerCase()}</span>{isSelf ? " · ти" : ""}</div>
          {aw && (
            <button type="button" className={`rv-await${aw.overdueNow > 0 ? " hot" : ""}`}
              title="Дзвінки на мобільні: угоди менеджера, що зараз чекають рішення людини (стан на зараз, не за періодом). Клік — вкладка «Перевізники за розмовою»."
              onClick={(e) => { e.stopPropagation(); navigate("/carrier-calls"); }}>
              🚚 чекають рішення: {aw.awaitingNow}{aw.overdueNow > 0 ? ` · прострочено ${String(aw.overdueNow)}` : ""}
            </button>
          )}
        </div>
        <div className="rv-trk">
          <div className="tl"><span>{isMonthMode ? "Місяць" : periodLabel} · <b>{fmt(m.fact)}</b> з {fmt(m.plan)} ₴</span><span className="p" style={{ color: sc }}>{pct}%</span></div>
          <div className="rv-track">
            <i style={{ width: `${Math.min(100, pct)}%`, background: sc }} />
            {m.monthInProgress && <em style={{ left: `${Math.round(Math.min(1, Math.max(0, elapsed)) * 100)}%` }} title="де мав би бути факт, якщо йти рівно по плану" />}
          </div>
        </div>
        <div className="rv-trk">
          <div className="tl"><span>Тиждень {weekLabel} · <b>{fmt(m.week.fact)}</b> з {fmt(m.week.target)}{m.week.isManual ? " ✎" : ""}</span><span className="p">{wPct}%</span></div>
          <div className="rv-track"><i style={{ width: `${Math.min(100, wPct)}%`, background: "var(--rv-ink)", opacity: .55 }} /></div>
        </div>
        <div className="rv-nums">
          <div title={`${m.new} нових · ${m.rep} постійних`}><b>{m.created}</b>створено</div>
          <div title={`на ${fmt(m.kpi.dispatch.revenue ?? 0)} ₴`}><b>{dispCnt}</b>авто</div>
          <div title={chekAlt ? "по відправлених авто, ще не закриті (сума÷авто)" : undefined}><b>{chekFact == null ? "—" : fmt(chekFact)}{chekAlt ? "*" : ""}</b>сер. чек</div>
          <div title="пропущені вхідні за період; червоним — скільки досі без передзвону">
            <b>{m.missed.missed}{m.missed.noCallback > 0 && <small> ({m.missed.noCallback})</small>}</b>пропущені</div>
        </div>
        <span className="rv-chev">▸</span>
      </div>
      {open && (
        <div className="more">
          {showWhy && <WhyBox m={m} role={role} isSelf={!!isSelf} />}
          <div className="rv-panes">
            <div className="rv-pane">
              {/* 🔴 ПІДПИС ЧЕСНИЙ: Звіт лише ЧИТАЄ задачник (`#56c`), «↔ синхронізовано» не повертаємо (`#56`). */}
              <h4>Тиждень · задача із Задачника <small title="Тижнева ціль = задачник (вручну) або динамічна ціль. Одна цифра у Звіті й Задачнику.">лише читання</small></h4>
              {mWeek ? (<>
                <KpiRow lbl="реклама" k={mWeek.kpi.ads} />
                <KpiRow lbl="лідоген" k={mWeek.kpi.leadgen} />
                <KpiRow lbl="авто" k={mWeek.kpi.dispatch} />
                <KpiRow lbl="сер. чек" k={mWeek.kpi.avgCheck} money />
                <KpiRow lbl="конверсія" k={mWeek.kpi.conversion} pctUnit />
              </>) : <div className="note">тижнева задача не задана</div>}
              <KpiRow lbl="гроші тижня" k={{ fact: m.week.fact, target: m.week.target }} money />
              {/* 🔴 РУЧНА ЦІЛЬ МУСИТЬ ВИГЛЯДАТИ РУЧНОЮ (рішення власника 07.08.2026). */}
              {m.week.isManual && m.week.manual != null ? (
                <div className="note">ціль <b>задана вручну</b> у Задачнику
                  {m.week.dynamic > 0 && m.week.dynamic !== m.week.manual ? ` — не рахувалась (динамічна була б ${fmt(m.week.dynamic)})` : ""}</div>
              ) : <div className="note">динамічний план тижня · залишок ÷ тижнів, що лишились</div>}
            </div>
            <WeekMoney mWeek={mWeek} managerId={m.managerId} period={weekPeriod} />
            <div className="rv-pane">
              <h4>Дзвінки й реакція <small>{isMonthMode ? "місяць" : periodLabel}</small></h4>
              <div className="kv"><span>пропущені (без передзвону)</span><b>{m.missed.missed} ({m.missed.noCallback})</b></div>
              <div className="kv"><span>передзвін, медіана</span><b>{fmtCallback(m.missed.medianMin)}</b></div>
              <div className="kv"><span>розмов / спроб</span><b>{m.talks} / {m.attempts}</b></div>
              <div className="kv" title="Ціну названо в першій розмові з рекламним лідом: названо ÷ оцінено. «Не вимірюється» — період до 20.09.2026."><span>ціну названо в 1-й дотик</span><b>{ft.main}{ft.sub ? ` · ${ft.sub}` : ""}</b></div>
            </div>
          </div>
          <DayDrill managerId={m.managerId} period={drillPeriod} focusDay={focusDay} today={today} weeksFirst={weeksFirst} />
        </div>
      )}
    </article>
  );
}

/** Рядок «показник: факт / ціль» у блоці задачі тижня. Ціль грішми — тим самим форматером, що й факт. */
function KpiRow({ lbl, k: x, money, pctUnit }: { lbl: string; k: { fact: number | null; target: number }; money?: boolean; pctUnit?: boolean }) {
  const has = x.target > 0;
  const ok = has && x.fact != null && x.fact >= x.target;
  const f = (v: number | null) => (v == null ? "—" : money ? fmt(v) : pctUnit ? `${v}%` : String(v));
  return (
    <div className="kv"><span>{lbl}</span>
      <b style={{ color: !has ? undefined : ok ? "var(--rv-ok)" : "var(--rv-warn)" }}>
        {f(x.fact)}<span style={{ color: MUTED, fontWeight: 500 }}>{has ? ` / ${f(x.target)}${ok ? " ✓" : ""}` : " · план не задано"}</span>
      </b>
    </div>
  );
}

// «Чому + Дія» — F8: світлофор ПО ГРОШАХ; активність по плану = сигнал, не «провал». F9: дія рольова.
function WhyBox({ m, role, isSelf }: { m: ReportPlanManager; role: string; isSelf: boolean }) {
  const behind = m.plan > 0 ? Math.max(0, m.plan - m.fact) : 0;
  const met = (x: { fact: number | null; target: number }) => x.target > 0 && x.fact != null && x.fact >= x.target;
  const low = (x: { fact: number | null; target: number }) => x.target > 0 && x.fact != null && x.fact < x.target;
  const activityOnPlan = met(m.kpi.ads) || met(m.kpi.leadgen) || met(m.kpi.dispatch);
  const lowLeads = low(m.kpi.ads) || low(m.kpi.leadgen);
  const forMe = role === "manager" || isSelf;
  const why = activityOnPlan
    ? `Активність по плану, але гроші відстають — потрібне втручання (факт ${k(m.fact)} / ${k(m.plan)}, ${m.pct ?? 0}%).`
    : m.status === "r"
      ? `Зрив темпу: факт ${k(m.fact)} при плані ${k(m.plan)} (${m.pct ?? 0}%).`
      : `Відстає: факт ${k(m.fact)} (${m.pct ?? 0}% плану), нижче темпу.`;
  const act = m.expect > behind
    ? (forMe
      ? `Пайплайн здоровий (очікуємо ${k(m.expect)}). Дотисни угоди з «Перевезення завершено» / «Дзвінок після розвантаж.».`
      : `Пайплайн здоровий (очікуємо ${k(m.expect)}). Дія: дотиснути угоди на грошових стадіях.`)
    : lowLeads
      ? (forMe
        ? `Лідів мало. Підніми оплати й додай нові ліди. Треба ${fmt(m.needPerDay)} ₴/день.`
        : `Лідів мало (реклама/лідоген нижче цілі). Дія: замовити лідогенів + підняти оплати. Треба ${fmt(m.needPerDay)} ₴/день.`)
      : (forMe
        ? `Пайплайну бракує (очікуємо ${k(m.expect)}). Наростай нові ліди й прискорюй закриття. Треба ${fmt(m.needPerDay)} ₴/день.`
        : `Пайплайну бракує (очікуємо лише ${k(m.expect)}). Дія: наростити ліди + прискорити закриття. Треба ${fmt(m.needPerDay)} ₴/день.`);
  const c = m.status === "r" ? RED : AMBER;
  return (
    <div style={{ padding: "0 0 12px" }}>
      <div style={{ borderRadius: 10, padding: "11px 14px", fontSize: 13, display: "flex", gap: 12, alignItems: "flex-start", background: c + "18" }}>
        <span style={{ fontSize: 15 }}>{SICON[m.status]}</span>
        <div><b>{why}</b><div style={{ marginTop: 3, color: "var(--text)" }}>{act}</div></div>
      </div>
    </div>
  );
}

// Дрил: період селектора → дні → угоди. День-клітинки з manager-detail; угоди — лінивий фетч.
/**
 * 🔎 РОЗГОРТКА ПО ДНЯХ — ДВА РІВНІ (макет `zvit-4`, рішення власника 07.08.2026).
 *
 * Перший рівень — рядок дня у трьох смугах. Другий — склад БУДЬ-ЯКОГО непорожнього
 * числа: клік на комірку → позиції, з яких воно склалось, і підсумок під ними.
 *
 * 🔴 ПРИНЦИП, А НЕ ПЕРЕЛІК ВИНЯТКІВ: Σ розкритих рядків ДОРІВНЮЄ числу, з якого їх
 * розкрили. Це не зручність — це перевірка, доступна користувачеві без нас. Тримає
 * гейт `#60` (на живих даних, по кожному типу) і `#60c` (когорта розбивається
 * без залишку).
 *
 * 🔴 ДВІ ДАТИ НА ОДНОМУ ЕКРАНІ — НАВМИСНО. Коричнева смуга датована днем
 * ЗАВАНТАЖЕННЯ, зелена — днем, коли ГРОШІ ЗАЙШЛИ. Тому «сума відправлених» і
 * «отримано» за той самий день не мусять збігатися, і це не помилка. Підпис під
 * таблицею називає це вголос: дві правильні величини без підпису читаються як
 * поломка — та сама пастка, через яку ми вже проходили з ① і ②.
 */
type DrillKey = { day: string; kind: DayItemKind };
const kindLabel: Record<DayItemKind, string> = {
  created: "Створено угод", dispatched: "Авто, відправлені того дня",
  dispatched_paid: "З них уже оплачено", dispatched_awaiting: "З них чекає оплати",
  success: "Закрито ① того дня", paid: "Прийшло ⑨ того дня",
  received: "Отримано ② того дня", avgcheck: "Угоди ②, з яких складається чек",
  calls: "Дзвінки того дня",
};

function WeekMoney({ mWeek, managerId, period }: {
  mWeek: ReportPlanManager | null | undefined; managerId: number; period: { from: string; to: string };
}) {
  const [open, setOpen] = useState<DayItemKind | null>(null);
  const [items, setItems] = useState<Record<string, DayItems | null>>({});
  const onChainDrill = (kind: DayItemKind) => {
    setOpen(open === kind ? null : kind);
    if (items[kind] === undefined) {
      setItems((p) => ({ ...p, [kind]: null }));
      fetchDayItems({ managerId, date: period.from, to: period.to, kind })
        .then((r) => setItems((p) => ({ ...p, [kind]: r })))
        .catch(() => setItems((p) => ({ ...p, [kind]: { kind, day: period.from, items: [], total: { count: 0, sum: 0 } } })));
    }
  };
  const r = open ? items[open] : undefined;
  return (
    <>
        {/**
          * 💰 ГРОШІ ТИЖНЯ — ЛАНЦЮГ ІЗ ТРЬОХ ЛАНОК (макет `zvit-6`, 07.08.2026).
          *
          * ВІДПРАВЛЕНО АВТО → ОЧІКУЄ ОПЛАТИ → ОПЛАЧЕНО. Σ зобовʼязана сходитись:
          * очікує + оплачено = відправлено. Це не оформлення, а перевірка, доступна
          * користувачеві без нас — тримає гейт `#62`.
          *
          * 🔴 ОЧІКУВАННЯ РОЗКЛАДАЄТЬСЯ ЩЕ РАЗ, і саме тут ховається різниця між
          * домовленістю і наміром: гроші з ПЛАНОВОЮ датою входять у прогноз, без
          * дати — ні. Друга плитка показується лише коли їй є що показати.
          *
          * 🔗 Кожне число розкривається ТИМ САМИМ `day-items`, що й розгортка по днях,
          * лише з періодом замість дня — другого механізму не заводимо.
          */}
        <div className="rv-pane">
          <h4>Гроші тижня <small>з власної роботи · {ddmm(period.from)}–{ddmm(period.to)}</small></h4>
          {(mWeek?.cohort.deals ?? 0) === 0 ? (
            /* 🔴 Дзеркало: порожній період КАЖЕ про себе, а не малює три нулі як досягнення. */
            <div style={{ fontSize: 12, color: MUTED }}>За цей тиждень не відправлено жодного авто — ланцюга ще немає.</div>
          ) : (() => {
            const c = mWeek!.cohort;
            const pct = (v: number) => c.sum > 0 ? `${Math.round((v / c.sum) * 100)}%` : "";
            // Ланцюг тими самими рядками «ключ — значення», що й сусідні блоки; кожне число клікабельне.
            const Link = ({ kind, lbl, val, color }: { kind: DayItemKind; lbl: string; val: string; color?: string }) => (
              <div className="kv" onClick={() => onChainDrill(kind)} title="клік → ці самі машини списком" style={{ cursor: "pointer" }}>
                <span>{lbl}</span>
                <b style={{ color, textDecoration: "underline dotted 1px", textUnderlineOffset: 3 }}>{val}</b>
              </div>
            );
            return (
              <>
                <Link kind="dispatched" lbl={`відправлено · ${c.deals} ${c.deals === 1 ? "машина" : c.deals < 5 ? "машини" : "машин"}`} val={`${fmt(c.sum)} ₴`} />
                <Link kind="dispatched_awaiting" lbl={`чекає оплати · ${pct(c.awaitSum)}`} val={`${fmt(c.awaitSum)} ₴`} color={BAR} />
                <Link kind="dispatched_paid" lbl={`оплачено · ${pct(c.paidSum)}`} val={`${fmt(c.paidSum)} ₴`} color={GREEN} />
                <div className="kv" title="входить у прогноз"><span>з плановою датою оплати</span><b>{fmt(c.awaitDatedSum)} ₴</b></div>
                {c.awaitNoDateSum > 0 && (
                  <div className="kv" title="у прогноз не входить"><span>без планової дати</span><b style={{ color: AMBER }}>{fmt(c.awaitNoDateSum)} ₴</b></div>
                )}
              </>
            );
          })()}
        </div>
      {open && (
        <div style={{ gridColumn: "1 / -1", order: 1, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "7px 12px", fontSize: 10.5, fontWeight: 700, color: BAR, textTransform: "uppercase", letterSpacing: ".4px", background: BAR + "0e" }}>
            ↳ {ddmm(period.from)}–{ddmm(period.to)} · {open === "dispatched" ? "відправлені авто" : open === "dispatched_paid" ? "з них уже оплачено" : "з них чекає оплати"}
          </div>
          {r == null ? <div style={{ padding: "8px 12px", fontSize: 12, color: MUTED }}>Завантаження…</div>
            : r.items.length === 0 ? <div style={{ padding: "8px 12px", fontSize: 12, color: MUTED }}>Порожньо.</div>
            : <>
                {r.items.map((it, i2) => (
                  <div key={i2} style={{ display: "grid", gridTemplateColumns: "1fr 100px 180px 110px", gap: 10, padding: "7px 12px", borderBottom: "1px solid var(--border)", fontSize: 12, alignItems: "center" }}>
                    <DealName name={it.name} url={it.url} />
                    <SrcChip src={it.src} source={it.source} />
                    <span style={{ fontSize: 11 }}><b>{it.state}</b><span style={{ color: MUTED }}> · {it.plannedPayAt ? `план. оплата ${ddmm(it.plannedPayAt)}` : "дата оплати не вказана"}</span></span>
                    <span style={{ textAlign: "right", fontWeight: 650 }}>{fmt(it.price)} ₴</span>
                  </div>
                ))}
                {/* Підсумок обовʼязковий — він і є доказом, що число зійшлося. */}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", fontSize: 12, fontWeight: 750, background: BAR + "16" }}>
                  <span>разом за {ddmm(period.from)}–{ddmm(period.to)} · {r.total.count} поз.</span>
                  <span>{fmt(r.total.sum)} ₴</span>
                </div>
              </>}
        </div>
      )}
    </>
  );
}

/**
 * 📅 ДВА РІВНІ РОЗКРИТТЯ (рішення власника 20.08.2026): у режимах «Місяць» і «Період»
 * спершу ТИЖНІ, і вже тиждень розкривається в дні. У «День»/«Тиждень» рівень тижнів
 * зайвий — там і так один блок, тож дні показуються одразу.
 *
 * 🔴 ОБИДВА РІВНІ РАХУЮТЬСЯ З ОДНІЄЇ ВІДПОВІДІ. Тиждень — це `w.total`, тобто Σ ТИХ
 * САМИХ днів, які під ним і розкриваються (`weeks[].days`). Другого запиту тут немає
 * НАВМИСНО: щойно тижні поїхали б окремим ендпоінтом, зʼявився б другий вираз того
 * самого числа — рівно те, від чого ми лікували чипи «новий/постійний» і розкриття
 * дня. Розкриття мусить пояснювати число, а не сперечатися з ним.
 */
/**
 * 🔀 ЗВУЖЕНИЙ НАБІР РЯДКІВ РОЗКРИТТЯ + ЙОГО ВЛАСНИЙ ПІДСУМОК.
 *
 * 🔴 ОДНА функція на обидві потреби — і рядки, і підсумок. Якби підсумок рахувався
 * окремо, зʼявився б рівно той розрив, який ця фіча й лікує, лише всередині
 * розкриття: угод показано 6, а «разом» — за 24.
 *
 * Рішення про клас НЕ приймається тут: `keepByKlass` — єдине місце, і воно
 * звіряється з ядром (`#213`). Тут лише «до якого числа зріз узагалі стосується».
 */
function sliceView(r: DayItems | null | undefined, kind: DayItemKind, slice: Slice): {
  items: DayItems["items"]; count: number; sum: number; narrowed: boolean;
} {
  const all = r?.items ?? [];
  const narrowed = slice !== "all" && kind === "created";
  if (!narrowed) return { items: all, count: r?.total.count ?? 0, sum: r?.total.sum ?? 0, narrowed: false };
  const items = all.filter((it) => keepByKlass(it.src, slice));
  return { items, count: items.length, sum: items.reduce((a, x) => a + x.price, 0), narrowed: true };
}

function DayDrill({ managerId, period, focusDay, today, weeksFirst }: { managerId: number; period: { from: string; to: string }; focusDay: string; today: string; weeksFirst: boolean }) {
  /**
   * 🔀 ЗРІЗ ДІЄ ЛИШЕ НА `created` — І ЦЕ НЕ ЛІНЬ, А ТА САМА ВИМОГА.
   *
   * Перемикач звужує ЧИСЛО «Створено». Розкриття, що пояснює саме це число,
   * зобовʼязане звузитись разом із ним. Але розкриття ГРОШЕЙ, ДЗВІНКІВ і
   * ВІДПРАВЛЕНИХ АВТО пояснюють числа, яких перемикач НЕ чіпає, — відфільтрувати
   * їх означало б завести розбіжність «число проти складу» в дзеркальний бік.
   * Дзвінки до того ж не мають новизни взагалі (`src: null`), тож звуження
   * спорожнило б їх геть.
   */
  const slice = useContext(SliceCtx);
  const [d, setD] = useState<KvpManagerDetail | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<DrillKey | null>(null);
  const [openWeek, setOpenWeek] = useState<number | null>(null);
  const [items, setItems] = useState<Record<string, DayItems | null>>({});
  useEffect(() => {
    let a = true; setD(null); setErr(false); setOpen(null); setOpenWeek(null); setItems({});
    fetchManagerDetail({ managerId, from: period.from, to: period.to })
      .then((x) => {
        if (!a) return;
        setD(x);
        // Тиждень фокус-дня розкритий одразу: інакше перший екран — це п'ять згорнутих
        // рядків, і день, на якому людина стоїть, треба ще знайти.
        setOpenWeek(x.weeks.find((w) => w.from <= focusDay && focusDay <= w.to)?.idx
          ?? x.weeks.find((w) => w.days.length > 0)?.idx ?? null);
      })
      .catch(() => a && setErr(true));
    return () => { a = false; };
  }, [managerId, period.from, period.to, focusDay]);

  /** 🔴 Дані вантажаться НА КЛІК — розкриття не має робити екран повільнішим для тих, хто його не відкриває. */
  const toggle = (day: string, kind: DayItemKind) => {
    const k = `${day}|${kind}`;
    setOpen(open && open.day === day && open.kind === kind ? null : { day, kind });
    if (items[k] === undefined) {
      setItems((p) => ({ ...p, [k]: null }));
      fetchDayItems({ managerId, date: day, kind })
        .then((r) => setItems((p) => ({ ...p, [k]: r })))
        .catch(() => setItems((p) => ({ ...p, [k]: { kind, day, items: [], total: { count: 0, sum: 0 } } })));
    }
  };
  const isOpen = (day: string, kind: DayItemKind) => !!open && open.day === day && open.kind === kind;

  if (err) return <div style={{ padding: "0 17px 16px", color: RED, fontSize: 12 }}>Не вдалося завантажити деталь.</div>;
  if (!d) return <div style={{ padding: "0 17px 16px", color: MUTED, fontSize: 12 }}>Завантаження деталі…</div>;
  const days = d.weeks.flatMap((w) => w.days);
  const T = d.monthTotals;

  /**
   * 🔴 ПОРОЖНЯ КОМІРКА НЕ КЛІКАЄТЬСЯ ВЗАГАЛІ. Клік, що відкриває порожній список, —
   * це «брехлива кнопка»: людина витрачає дію й дізнається, що дії не було.
   */
  /**
   * 🔴 ОДИН ОПИС КОМІРОК НА ОБИДВА РІВНІ. Рядок тижня і рядок дня показують ті самі
   * одинадцять чисел у тому самому порядку — тож опис колонок живе тут ОДИН раз, а
   * рівні різняться лише тим, чи комірка клікається. Двi копії розмітки означали б,
   * що колонку можна дописати в один рівень і забути в другому, і тиждень заперечував
   * би день тим самим екраном.
   */
  const cellDefs = (x: KvpDetailCell): { kind: DayItemKind | null; n: number; main: React.ReactNode; sub?: React.ReactNode; color?: string }[] => {
    const chk = x.received.deals ? Math.round(x.received.revenue / x.received.deals) : 0;
    return [
      { kind: "created", n: x.created, main: x.created, sub: `${x.newCount}н · ${x.repeatCount}п` },
      { kind: "calls", n: x.talks + x.attempts, main: x.talks || "—", sub: x.attempts ? `${x.attempts} спроб` : undefined },
      // `kind: null` — колонка-довідка без власного складу: клікати нема що діставати.
      { kind: null, n: 0, main: `${x.newCount}/${x.repeatCount}` },
      { kind: "dispatched", n: x.dispatched, main: x.dispatched, sub: x.dispatched ? autoSplit(x.dispRepeat, x.dispLeadgen, x.dispAd, x.dispElogist, x.dispUndef) : undefined },
      { kind: "dispatched", n: x.dispSum, main: `${fmt(x.dispSum)} ₴` },
      { kind: "dispatched_paid", n: x.dispPaid.sum, main: fmt(x.dispPaid.sum), color: GREEN },
      { kind: "dispatched_awaiting", n: x.dispAwait.sum, main: fmt(x.dispAwait.sum), color: BAR },
      { kind: "success", n: x.success.revenue, main: fmt(x.success.revenue), sub: x.success.deals ? `${x.success.deals} угод` : undefined, color: GREEN },
      { kind: "paid", n: x.paid.revenue, main: fmt(x.paid.revenue), sub: x.paid.deals ? `${x.paid.deals} угод` : undefined, color: LINK },
      { kind: "received", n: x.received.revenue, main: <b>{fmt(x.received.revenue)} ₴</b> },
      { kind: "avgcheck", n: chk, main: fmt(chk), sub: `${fmt(x.received.revenue)} ÷ ${x.received.deals}` },
    ];
  };

  const Cell = ({ day, kind, n, main, sub, color }: {
    day: string; kind: DayItemKind; n: number;
    main: React.ReactNode; sub?: React.ReactNode; color?: string;
  }) => {
    const live = n > 0;
    return (
      <td onClick={live ? (e) => { e.stopPropagation(); toggle(day, kind); } : undefined}
          title={live ? `${kindLabel[kind]} · клік → склад числа` : undefined}
          style={{ textAlign: "right", cursor: live ? "pointer" : "default",
            color: live ? color : MUTED, fontWeight: live ? 600 : 400,
            background: isOpen(day, kind) ? AMBER + "1f" : undefined,
            textDecoration: live ? "underline dotted 1px" : undefined, textUnderlineOffset: 3 }}>
        {live ? main : "—"}
        {live && sub ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{sub}</div> : null}
      </td>
    );
  };

  /** Рядок-розкриття: позиції + ОБОВʼЯЗКОВИЙ підсумок — він і є доказом, що число зійшлося. */
  const DrillRow = ({ day, kind }: { day: string; kind: DayItemKind }) => {
    const r = items[`${day}|${kind}`];
    const view = sliceView(r, kind, slice);
    return (
      <tr>
        <td colSpan={12} style={{ padding: 0, background: AMBER + "0e" }}>
          <div style={{ padding: "7px 14px", fontSize: 10.5, fontWeight: 700, color: BAR,
            textTransform: "uppercase", letterSpacing: ".4px", borderTop: `1px solid ${AMBER}55` }}>
            ↳ {ddmm(day)} · {kindLabel[kind]}
          </div>
          {r === null || r === undefined ? (
            <div style={{ padding: "8px 14px", color: MUTED, fontSize: 12 }}>Завантаження…</div>
          ) : view.items.length === 0 ? (
            <div style={{ padding: "8px 14px", color: MUTED, fontSize: 12 }}>
              {view.narrowed ? `У зрізі «${SLICE_LABEL[slice]}» угод цього дня немає.` : "Порожньо."}
            </div>
          ) : (
            <>
              {view.narrowed && (
                <div style={{ padding: "6px 14px", fontSize: 11, color: AMBER, background: AMBER + "12" }}>
                  ⚠️ зріз «{SLICE_LABEL[slice]}» — показано {view.items.length} із {r.items.length} угод дня
                </div>
              )}
              {view.items.map((it, i) => (
                <div key={i} style={{ display: "grid",
                  gridTemplateColumns: kind === "calls" ? "1fr 150px 110px 120px" : "1fr 110px 190px 120px",
                  gap: 10, padding: "7px 14px", borderBottom: "1px solid var(--border)", fontSize: 12, alignItems: "center" }}>
                  <DealName name={it.name} url={it.url} />
                  {kind === "calls" ? (
                    <>
                      <span style={{ color: MUTED, fontSize: 11 }}>{it.call?.phone ?? "—"}</span>
                      <span style={{ fontSize: 11 }}>
                        <b style={{ color: it.call?.answered ? GREEN : MUTED }}>{it.state}</b>
                        {it.call?.answered ? ` · ${Math.floor((it.call.durationSec) / 60)}:${String((it.call.durationSec) % 60).padStart(2, "0")}` : ""}
                        <span style={{ color: MUTED }}> · {it.call?.at.slice(11)}</span>
                      </span>
                      {/* 🎧 ПРЯМИЙ ЛІНК НА ЗАПИС, без проксі — рішення власника 05.08.2026. */}
                      <span style={{ textAlign: "right" }}>
                        {it.call?.recordUrl
                          ? <a href={it.call.recordUrl} target="_blank" rel="noreferrer" style={{ color: BAR, fontWeight: 600 }}>▶ запис</a>
                          : <span style={{ color: MUTED, fontSize: 11 }}>запису немає</span>}
                      </span>
                    </>
                  ) : (
                    <>
                      <SrcChip src={it.src} source={it.source} />
                      <span style={{ fontSize: 11 }}>
                        <span style={{ fontWeight: 600 }}>{it.state}</span>
                        <span style={{ color: MUTED }}>
                          {" · "}{it.plannedPayAt ? `план. оплата ${ddmm(it.plannedPayAt)}` : "дата оплати не вказана"}
                        </span>
                      </span>
                      {/* 🔴 СУМА ЗАВЖДИ, СТАН ОКРЕМО. Було `price ? сума : статус` — при
                          нульовому бюджеті замість числа зʼявлявся текст, і рядок
                          читався як «суми немає». Тепер нуль виглядає нулем. */}
                      <span style={{ textAlign: "right", fontWeight: 650 }}>{fmt(it.price)} ₴</span>
                    </>
                  )}
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 14px",
                fontSize: 12, fontWeight: 750, background: AMBER + "18" }}>
                {/* 🔴 ПІДСУМОК — ІЗ ТОГО САМОГО НАБОРУ, ЩО РЯДКИ. Брати `r.total`
                    при звуженому складі означало б, що розкриття сперечається
                    саме з собою: угод 6, а підсумок за 24. */}
                <span>разом за {ddmm(day)} · {view.count} поз.</span>
                <span>{kind === "calls" ? `${view.items.filter((x) => x.call?.answered).length} розмов · ${view.items.filter((x) => !x.call?.answered).length} спроб` : `${fmt(view.sum)} ₴`}</span>
              </div>
            </>
          )}
        </td>
      </tr>
    );
  };

  const BANDS: [string, number, string][] = [["Робота дня", 3, "var(--text)"], ["Авто, відправлені того дня · що з ними зараз", 4, BAR], ["Гроші, що надійшли того дня", 4, GREEN]];
  const HEADS = ["День", "Створено угод", "Дзвінки розмов/спроб", "Нові/Пост.",
    "Авто шт", "Сума відправлених", "З них оплачено", "З них чекає оплати",
    "Закрито ①", "Прийшло ⑨", "Отримано ②", "Сер.чек ②"];

  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg)", padding: "14px 17px 18px" }}>
      <div style={{ fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px", margin: "0 0 9px" }}>
        {weeksFirst
          ? `По тижнях періоду (${ddmm(period.from)}–${ddmm(period.to)}) · клік на тиждень → його дні, клік на число дня → його склад`
          : `По днях періоду (${ddmm(period.from)}–${ddmm(period.to)}) · клік на будь-яке число → його склад`}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
          <thead>
            <tr>
              <th />
              {BANDS.map(([t, span, c]) => (
                <th key={t} colSpan={span} style={{ textAlign: "center", fontSize: 10, letterSpacing: ".5px",
                  textTransform: "uppercase", color: c, borderBottom: `2px solid ${c}44` }}>{t}</th>
              ))}
            </tr>
            <tr>{HEADS.map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left" }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {(weeksFirst ? d.weeks : [{ idx: 0, from: period.from, to: period.to, days, total: T }]).map((w) => (
              <Fragment key={`w${w.idx}`}>
                {weeksFirst && (
                  <tr onClick={() => setOpenWeek(openWeek === w.idx ? null : w.idx)}
                      title="клік → дні цього тижня"
                      style={{ cursor: "pointer", fontWeight: 650,
                        background: openWeek === w.idx ? BAR + "14" : "var(--surface-2)",
                        borderTop: "1px solid var(--border)" }}>
                    <td style={{ textAlign: "left" }}>
                      <span style={{ color: BAR, marginRight: 5 }}>{openWeek === w.idx ? "▾" : "▸"}</span>
                      Тиждень {w.idx} · {ddmm(w.from)}–{ddmm(w.to)}
                      <span style={{ color: MUTED, fontWeight: 400, fontSize: 11 }}> · {w.days.length} дн.</span>
                    </td>
                    {cellDefs(w.total).map((c, i) => (
                      <td key={i} style={{ textAlign: "right", color: c.n ? (c.color ?? undefined) : MUTED }}>
                        {c.n || c.kind === null ? c.main : "—"}
                        {c.n && c.sub ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{c.sub}</div> : null}
                      </td>
                    ))}
                  </tr>
                )}
                {(!weeksFirst || openWeek === w.idx) && w.days.map((x) => {
                  const isF = x.day === focusDay;
                  const future = x.day > today;
                  const weekend = dow(x.day) >= 6;
                  return (
                    <Fragment key={x.day}>
                      <tr style={{ background: isF ? AMBER + "18" : weekend ? "var(--border)" + "44" : undefined,
                        color: future || weekend ? MUTED : undefined }}>
                        <td style={{ textAlign: "left", fontWeight: 600, paddingLeft: weeksFirst ? 22 : undefined,
                          color: future || weekend ? MUTED : undefined }}>
                          {WD[dow(x.day) - 1]} {ddmm(x.day)}{isF ? " •" : ""}
                        </td>
                        {future ? (
                          <td colSpan={11} style={{ textAlign: "right", color: MUTED, fontStyle: "italic" }}>ще попереду</td>
                        ) : cellDefs(x).map((c, i) => (
                          c.kind === null
                            ? <td key={i} style={{ textAlign: "right", color: MUTED }}>{c.main}</td>
                            : <Cell key={i} day={x.day} kind={c.kind} n={c.n} main={c.main} sub={c.sub} color={c.color} />
                        ))}
                      </tr>
                      {open && open.day === x.day ? <DrillRow day={x.day} kind={open.kind} /> : null}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
            <tr style={{ background: "var(--bg)", fontWeight: 750, borderTop: "2px solid var(--border)" }}>
              <td style={{ textAlign: "left" }}>Σ період</td>
              <td style={{ textAlign: "right" }}>{T.created}<div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{T.newCount}н · {T.repeatCount}п</div></td>
              <td style={{ textAlign: "right" }}>{T.talks || "—"}{T.attempts ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{T.attempts} спроб</div> : null}</td>
              <td style={{ textAlign: "right" }}>{T.newCount}/{T.repeatCount}</td>
              <td style={{ textAlign: "right" }}>{T.dispatched || "—"}{T.dispatched ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{autoSplit(T.dispRepeat, T.dispLeadgen, T.dispAd, T.dispElogist, T.dispUndef)}</div> : null}</td>
              <td style={{ textAlign: "right" }}>{T.dispSum ? fmt(T.dispSum) + " ₴" : "—"}</td>
              <td style={{ textAlign: "right", color: T.dispPaid.sum ? GREEN : MUTED }}>{T.dispPaid.sum ? fmt(T.dispPaid.sum) : "—"}{T.dispSum ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{Math.round((T.dispPaid.sum / T.dispSum) * 100)}%</div> : null}</td>
              <td style={{ textAlign: "right", color: T.dispAwait.sum ? BAR : MUTED }}>{T.dispAwait.sum ? fmt(T.dispAwait.sum) : "—"}{T.dispSum ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{Math.round((T.dispAwait.sum / T.dispSum) * 100)}%</div> : null}</td>
              <td style={{ textAlign: "right", color: T.success.revenue ? GREEN : MUTED }}>{T.success.revenue ? fmt(T.success.revenue) : "—"}{T.success.deals ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{T.success.deals} угод</div> : null}</td>
              <td style={{ textAlign: "right", color: T.paid.revenue ? LINK : MUTED }}>{T.paid.revenue ? fmt(T.paid.revenue) : "—"}{T.paid.deals ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{T.paid.deals} угод</div> : null}</td>
              <td style={{ textAlign: "right" }}>{fmt(T.received.revenue)} ₴</td>
              {/* Σ рахується ТІЄЮ САМОЮ формулою, що рядки над ним: гроші ② ÷ угоди ②.
                  🔴 ТУТ НАВМИСНО БЕЗ ПСЕВДОНІМА `T`: гейт `#58` шукає саме цей вираз
                  (`d.monthTotals.received.revenue / d.monthTotals.received.deals`), і
                  скорочення робить його сліпим. Він щойно це й довів — почервонів на
                  моєму ж рефакторингу. Читаність тут дешевша за перевірку. */}
              <td style={{ textAlign: "right" }}>{d.monthTotals.received.deals ? fmt(Math.round(d.monthTotals.received.revenue / d.monthTotals.received.deals)) : "—"}
                {T.received.deals ? <div style={{ color: MUTED, fontSize: 10.5, fontWeight: 400 }}>{fmt(T.received.revenue)} ÷ {T.received.deals}</div> : null}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: MUTED, lineHeight: 1.55 }}>
        <b>Коричнева смуга — це когорта дня:</b> авто, відправлені саме того дня, і що з ними сталося станом на сьогодні.
        «Оплачено» плюс «чекає оплати» завжди дорівнює «сумі відправлених». ·
        <b> Зелена смуга — це потік грошей того дня:</b> скільки надійшло, незалежно від того, коли авто поїхало.
        «Закрито ①» — угода доведена до кінця; «Прийшло ⑨» — гроші є, угода ще відкрита.
        <b> Сер.чек ②</b> = гроші ② ÷ кількість угод ② — чисельник і знаменник з одного джерела й однієї дати.
        <br />
        <b>Дві смуги міряні різними датами — і збігатися не мусять.</b> Авто датовані днем завантаження, гроші —
        днем, коли зайшли на рахунок: тому в дні без жодного авто цілком може надійти оплата за рейс, що поїхав
        раніше. Це не помилка. · Σ по «чекає оплати» за всі дні — це і є пайплайн менеджера, зібраний з його власної роботи.
      </div>
    </div>
  );
}

// #18 — застряглі угоди (реюз КВП /stuck-deals, роль-скоуп за токеном; найдовші вгорі).
// Тег команди → підпис + колір (РПК/РНК/лідоген).
const STUCK_TAG: Record<string, { label: string; c: string }> = { rpk: { label: "Повний цикл", c: BAR }, rnk: { label: "Реклама", c: "#7a52c7" }, leadgen: { label: "ЛГ", c: GREEN } };
// Стадія → чип-колір.
const STUCK_STAGE_C = (s: string) => s === "Авто працює" ? GREEN : s === "Взято в роботу" ? BAR : AMBER;
const idleColor = (d: number) => d >= 90 ? RED : d >= 21 ? AMBER : MUTED;

/**
 * #18 — Застряглі угоди, ЗГРУПОВАНІ по менеджерах (переробка, без «стелі 50»): справжня
 * к-сть, company-summary, роль-скоуп за токеном; дропдауни по менеджерах, на розкритті —
 * ПОВНИЙ список угод менеджера (скрол при довгому), найдовший простій угорі. Реюз core.
 */
type StuckSort = "count" | "sum" | "idle";
export function StuckBlock({ teamId }: { teamId?: number }) {
  const [data, setData] = useState<StuckGrouped | null>(null);
  const [openMgr, setOpenMgr] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<StuckSort>("count");
  const [sectionOpen, setSectionOpen] = useState(false); // ВСЯ секція згорнута за замовчуванням (обгортка над per-manager акордеоном)
  useEffect(() => {
    let a = true; setData(null); setOpenMgr(new Set());
    fetchStuckGrouped(teamId ? { teamId } : {})
      .then((d) => {
        if (!a) return;
        setData(d);
        // Авто-відкриття/розгортання — ЛИШЕ РНК (рішення власника 24.07): секція авто-розкривається
        // й авто-розгортаються менеджери тільки для критичних RNK-команд. РПК/Самостійний стартують
        // згорнуті (лише ручний клік). Ручний тоггл далі перекриває. Червоний чип/акцент — для всіх.
        const criticalRnk = d.groups.filter((g) => g.teamTag === "rnk" && g.longestIdleDays >= 90);
        setSectionOpen(criticalRnk.length > 0);
        setOpenMgr(new Set(criticalRnk.map((g) => g.managerId)));
      })
      .catch(() => a && setData({ minDays: 0, role: "", scope: "company", total: 0, sumRisk: 0, managers: 0, over90: 0, groups: [], asOf: "", talkAmbiguousCount: 0, asOfStale: false, asOfAgeMin: 0, asOfStaleAfterMin: 0, asOfJob: null }));
    return () => { a = false; };
  }, [teamId]);

  const toggleMgr = (id: number) => setOpenMgr((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });


  return (
    <div>
      {/* 🧱 ОДИН РЯДОК (макет, 13.11.2026): лічильники в шапці, решта — по кліку. Авто-розкриття
          для критичних РНК (рішення власника 24.07) лишається. */}
      <section className="rv-stuck">
        <div className="hd" onClick={() => setSectionOpen((o) => !o)} role="button" tabIndex={0} aria-expanded={sectionOpen}
             onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSectionOpen((o) => !o); } }}>
          <span className="rv-chev" style={{ transform: sectionOpen ? "rotate(90deg)" : "none" }}>▸</span>
          <span className="t">Застряглі угоди</span>
          {data == null ? <span className="m">завантаження…</span> : (
            <span className="m"><b style={{ color: data.total ? RED : GREEN }}>{data.total}</b> угод
              {data.total > 0 && <> · <b>{k(data.sumRisk)}</b> ₴ в ризику · <b>{data.managers}</b> менеджерів</>}</span>
          )}
          {data && data.over90 > 0 && <span className="rv-badge">⚠️ {data.over90} &gt;90 дн</span>}
          <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
            <InfoHint text={`Критерій — ВІДСУТНІСТЬ РУХУ: угоди від «взято на прорахунок» до «Виставлення рахунку» ВКЛЮЧНО, у яких понад ${data?.minDays ?? "—"} дн. не було ЖОДНОГО сигналу. Сигнали (рішення власника 14.08.2026): нотатка/чат людини · дзвінок ≥10 c · ЗМІНА ЕТАПУ. Далі «Виставлення рахунку» угоду веде логістика й оплата — там мовчання означає інше, і в список вона не входить. Анкер — найсвіжіший із сигналів (нотатки людини, не Salesbot); ДЗВІНОК КОРОТШИЙ ЗА 10 c активністю не вважається — недодзвон не є контактом. Розмова з Ringostat теж рахується рухом, але лише коли у клієнта РІВНО ОДНА відкрита угода: інакше невідомо, про яку з них говорили. Вік рахується від часу останнього успішного синку, а не від годинника — поки дані не оновлюються, лічильник не росте. Сума в ризику — signed (сторно нетиться). Вікно створення 180 днів. Роль-скоуп: адмін/КВП — вся компанія, тімлід — свій відділ, менеджер — лише свої. Стан на зараз, не за обраним періодом. ⚠️ Зміну етапу, зроблену ботом, ми поки не відрізняємо від людської — у подіях Kommo ми не зберігаємо, хто саме її зробив.`} />
          </span>
        </div>
        {sectionOpen && (
          <div className="rule">
            без руху ≥{data?.minDays ?? "—"} дн. · чат · дзвінок від 10 c · зміна етапу · до «Виставлення рахунку» включно · стан на зараз, не за обраним періодом ·{" "}
            <b style={{ color: data?.asOfStale ? AMBER : "var(--text)" }}>дані станом на {asOfLabel(data?.asOf, data?.asOfStale, data?.asOfAgeMin)}</b>
            {data && data.talkAmbiguousCount > 0 && <> · ⚠️ {data.talkAmbiguousCount} з розмовою, але угода не одна</>}
            {data && data.scope !== "own" && (
              <label style={{ marginLeft: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                Сортувати:
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as StuckSort)}
                  style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "3px 8px", cursor: "pointer" }}>
                  <option value="count">за к-стю</option>
                  <option value="sum">за сумою в ризику</option>
                  <option value="idle">за простоєм</option>
                </select>
              </label>
            )}
          </div>
        )}
        {sectionOpen && (data == null ? <div style={{ padding: "0 18px 18px", color: MUTED }}>Завантаження…</div> : (
          <>
            {data.groups.length === 0 ? (
              <div style={{ padding: 18, color: MUTED, fontSize: 13 }}>Немає застряглих угод ✓</div>
            ) : [...data.groups].sort((a, b) =>
                  sortBy === "sum" ? b.sumAtRisk - a.sumAtRisk : sortBy === "idle" ? b.longestIdleDays - a.longestIdleDays : b.count - a.count
                ).map((g) => (
              <StuckMgrRow key={g.managerId} g={g} open={openMgr.has(g.managerId)} onToggle={() => toggleMgr(g.managerId)} single={data.scope === "own"} />
            ))}
          </>
        ))}
      </section>
    </div>
  );
}

/**
 * 🕰 «ДАНІ СТАНОМ НА HH:MM» — обовʼязковий підпис, а не прикраса.
 *
 * Вік «днів без руху» рахується від часу останнього успішного синку, а не від
 * годинника. Без цього підпису екран мовчки показував би те саме число годинами й
 * читався б як «нічого не змінилось», хоча правильне пояснення інше: «ми ще не знаємо».
 *
 * ⏳ ХВІСТ «(N год тому)» — ЛИШЕ КОЛИ ВІДСТАВАННЯ НЕНОРМАЛЬНЕ, і вирішує це СЕРВЕР
 * (`asOfStale`). `syncDealActivity` ходить раз на 3 год, тож нормальний стан — це
 * відставання до трьох годин; малювати хвіст завжди означало б щодня лякати тим, що
 * є штатною роботою. Свого числа годин фронт НЕ має: поріг = 2× інтервал відсталішої
 * джоби, узятий із реєстру розкладу, і живе він в одному місці.
 * Час — київський, як усі дати в продукті.
 */
function asOfLabel(iso: string | undefined, stale?: boolean, ageMin?: number): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hhmm = d.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
  if (!stale) return hhmm;
  const h = Math.floor((ageMin ?? 0) / 60);
  return `${hhmm} (${h >= 1 ? `${h} год` : `${ageMin} хв`} тому)`;
}

const STUCK_COLS: { h: string; r?: boolean; hint?: string }[] = [
  { h: "Угода" }, { h: "Клієнт" }, { h: "Стадія" }, { h: "Сума", r: true }, { h: "Днів без руху", r: true },
  { h: "Остання розмова", r: true, hint: "Остання РОЗМОВА з клієнтом (від 10 c) — недодзвон не рахується. Два джерела: нотатка в CRM і телефонія Ringostat, береться свіжіше. 🎧 — розмова знайшлась лише в Ringostat (у CRM її немає). ⚠️ — розмова є, але у клієнта кілька відкритих угод, тож котрої саме вона стосується, ми не знаємо: таку угоду зі списку НЕ прибираємо. 🚩 — свіжа активність є, але місяць без розмови (метушня без контакту)." },
  { h: "Коментар", hint: "Робоча позначка: чому стоїть / що зроблено. Наша анотація — у CRM НЕ пишеться і на метрики не впливає. Зберігається автоматично (втрата фокуса або Ctrl+Enter). Редагує відповідальний менеджер, тімлід і адмін; бачать усі, хто бачить цю угоду." },
];

// Інлайн-нотатка по угоді: автозбереження на blur / Ctrl+Enter, лише коли текст ЗМІНИВСЯ.
// Не редактор — короткі позначки; сервер ріже до 2000 символів і сам перевіряє право.
function DealNote({ d }: { d: StuckGroupDeal }) {
  const [val, setVal] = useState(d.note ?? "");
  const [saved, setSaved] = useState<string>(d.note ?? "");
  const [state, setState] = useState<"" | "saving" | "ok" | "err">("");
  const [meta, setMeta] = useState<{ author: string | null; at: string | null }>({ author: d.noteAuthor, at: d.noteAt });
  const commit = async () => {
    const next = val.trim();
    if (next === saved.trim()) return; // без змін — не смикаємо сервер
    setState("saving");
    try {
      const r = await saveDealNote(d.kommoId, next);
      setSaved(next); setMeta({ author: r.noteAuthor, at: r.noteAt }); setState("ok");
      setTimeout(() => setState((s) => (s === "ok" ? "" : s)), 1800);
    } catch { setState("err"); }
  };
  if (!d.canEditNote) {
    return d.note
      ? <span title={meta.author ? `${meta.author}${meta.at ? " · " + meta.at.slice(0, 10) : ""}` : undefined} style={{ fontSize: 12 }}>{d.note}</span>
      : <span style={{ color: MUTED }}>—</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%" }}>
      <input value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        placeholder="позначка…" maxLength={2000}
        title={meta.author ? `останнє: ${meta.author}${meta.at ? " · " + meta.at.slice(0, 10) : ""}` : undefined}
        style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "4px 8px", borderRadius: 7, color: "var(--text)",
          background: "var(--card-bg)", border: `1px solid ${state === "err" ? RED : "var(--border)"}` }} />
      <span style={{ fontSize: 11, width: 14, color: state === "err" ? RED : state === "ok" ? GREEN : MUTED }}
        title={state === "err" ? "не збережено — спробуй ще раз" : undefined}>
        {state === "saving" ? "…" : state === "ok" ? "✓" : state === "err" ? "✗" : ""}
      </span>
    </span>
  );
}

function StuckMgrRow({ g, open, onToggle, single }: { g: StuckManagerGroup; open: boolean; onToggle: () => void; single: boolean }) {
  const tag = g.teamTag ? STUCK_TAG[g.teamTag] : null;
  const hasCritical = g.longestIdleDays >= 90; // ≥1 критична угода (>90 дн) → червоний акцент рядка
  return (
    <div style={{ borderBottom: "1px solid var(--border)", borderLeft: hasCritical ? `3px solid ${RED}` : "3px solid transparent", background: hasCritical ? RED + "0a" : undefined }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", cursor: "pointer", flexWrap: "wrap" }}>
        <span style={{ color: MUTED, fontSize: 12 }}>{open ? "▼" : "▶"}</span>
        {hasCritical && <span title="має критичні угоди >90 дн">⚠️</span>}
        <span style={{ fontWeight: 700, fontSize: 14.5, color: hasCritical ? RED : "var(--text)" }}>{single ? "Мої застряглі" : g.manager}</span>
        {tag && !single && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: tag.c + "22", color: tag.c }}>{tag.label}</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: 16 }}>
          <span><b style={{ color: RED, fontSize: 16 }}>{g.count}</b> <span style={{ fontSize: 11, color: MUTED }}>угод</span></span>
          <span><b style={{ fontSize: 16 }}>{k(g.sumAtRisk)} ₴</b> <span style={{ fontSize: 11, color: MUTED }}>в ризику</span></span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: idleColor(g.longestIdleDays), background: idleColor(g.longestIdleDays) + "18", padding: "3px 10px", borderRadius: 20 }}>найдовша {g.longestIdleDays} дн</span>
        </span>
      </div>
      {open && (
        <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
          <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
            <thead><tr>{STUCK_COLS.map((c) => <th key={c.h} style={{ textAlign: c.r ? "right" : "left", position: "sticky", top: 0, background: "var(--card-bg)", zIndex: 1 }}>{c.h}{c.hint && <> <InfoHint text={c.hint} /></>}</th>)}</tr></thead>
            <tbody>
              {g.deals.map((d) => {
                const sc = STUCK_STAGE_C(d.stage);
                const crit = d.days >= 90;
                return (
                  <tr key={d.kommoId}>
                    <td style={{ textAlign: "left" }}><a href={d.crmUrl} target="_blank" rel="noreferrer" style={{ color: BAR }}>{d.name || "—"}</a></td>
                    <td style={{ textAlign: "left", color: MUTED }}>{d.client || "—"}</td>
                    <td style={{ textAlign: "left" }}><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: sc + "1e", color: sc }}>{d.stage}</span></td>
                    <td style={{ textAlign: "right", fontWeight: 650, color: d.price < 0 ? RED : "var(--text)" }}>{d.price ? fmt(d.price) + " ₴" : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: idleColor(d.days) }}>{crit && <span title="критична: >90 дн">⚠️ </span>}{d.days}</td>
                    <td style={{ textAlign: "right", fontWeight: 650 }}>
                      {d.daysSinceLastCall == null
                        ? <span style={{ color: MUTED }}>розмови не було</span>
                        : <span style={{ color: d.daysSinceLastCall >= 30 ? AMBER : "var(--text)" }}>{d.daysSinceLastCall} дн</span>}
                      {d.talkSource === "ringostat" && <span title="розмова знайшлась у Ringostat — у CRM її немає"> 🎧</span>}
                      {d.talkAmbiguous && <span title="розмова є, але у клієнта кілька відкритих угод — котрої саме вона стосується, невідомо, тож угоду не прибираємо зі списку"> ⚠️</span>}
                      {d.noCallFlag && <span title="метушня без контакту: свіжа активність, але місяць без розмови"> 🚩</span>}
                    </td>
                    <td style={{ textAlign: "left", minWidth: 190 }}><DealNote d={d} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

