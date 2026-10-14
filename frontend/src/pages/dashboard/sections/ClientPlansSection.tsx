import { Fragment, useCallback, useEffect, useState } from "react";
import type { AuthPayload } from "../../../auth";
import {
  fetchClientPlans,
  createClientReactivationTask, addClientContact, contactChannelLabel, closeReactivationTask,
  fetchClientComments, addClientComment,
  type ClientPlansResp, type ClientPlanRow, type ClientComment, type ManagerOption,
} from "../../../api";
import { formatAmountFull } from "../format";
import { CARD_MATCH, cardStats, toggleCard, signedUah, type CardKey } from "../clientsCards";
import { useToast } from "../../../components/Toasts";
import { SegmentBadge, ForcedBadge, MergedLine } from "./SegmentBadge";
import { RowComment } from "./RowComment";
import { CarrierCommentBanner } from "./CarrierCommentBanner";
import { CreateTaskDialog, CloseTaskDialog, ContactDialog } from "./ReactivationBits";
import { RecordingPlayer } from "./RecordingPlayer";
import { ClientCardPanel } from "./ClientCardPanel";
import { ClientContactFileViewer } from "./ClientContactFileViewer";
import { ReactCycleStatus, ReactCycleButtons, LeadgenPoolPanel } from "./ReactivationCycle";

/**
 * «ПОСТІЙНІ КЛІЄНТИ» (задача 5609, ТЗ Юлі 12.10.2026 після TOP Weekly; регламент ред. 2).
 *
 * Рядок = клієнт по КАНОНІЧНОМУ ключу (злиті телефони й назви — один клієнт). Факт — «з рахунку і далі», ядро.
 *
 * 🔴 ПЛАНІВ ПО КЛІЄНТАХ БІЛЬШЕ НЕМАЄ (регламент ред. 2, п.3; ТЗ п.6; рішення Романа 13.10.2026): з екрана прибрано
 * колонку плану, тижні, «Подати / Затвердити / повернути» й обґрунтування плану в рядку. Дані в БД не чіпали — плани
 * за жовтень лишились, їх просто ніде не показано. Замість плану — факти: шість карток зверху (кожна фільтрує
 * таблицю), «всього грошей», «замовляв цього місяця», періодичність і «Без роботи» першими з червоною смугою.
 */

/** Липка шапка таблиці (ТЗ 5609, п.6): фон обовʼязковий, інакше рядки просвічують крізь підписи. */
const STICKY_TH: React.CSSProperties = { position: "sticky", top: 0, zIndex: 2, background: "#fff" };

const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" } as const,
  th: { textAlign: "left", fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280",
        fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" } as const,
  td: { padding: "10px", borderBottom: "1px solid #f1f5f9", fontSize: 13, verticalAlign: "middle" } as const,
  /** Той самий вигляд кнопки, що був на вкладці реактивації — щоб дія не змінила подачу. */
  btn: (primary?: boolean) => ({ fontSize: 12, fontWeight: primary ? 700 : 500, padding: "6px 12px",
        borderRadius: 8, cursor: "pointer", border: primary ? "none" : "1px solid #d1d5db",
        background: primary ? "#111827" : "#fff", color: primary ? "#fff" : "#374151" } as const),
  chip: (bg: string, fg: string) => ({ display: "inline-block", padding: "1px 7px", borderRadius: 999,
        fontSize: 10, fontWeight: 700, background: bg, color: fg, whiteSpace: "nowrap" } as const),
};

/**
 * 🔵 ПОЗНАЧКА СТАНУ для рядка, який потрапив у список ЛИШЕ через план.
 *
 * 🔴 Без неї фікс зробив би гірше, ніж було. Раніше такий клієнт з екрана
 * зникав — це помилка, але помітна («де мій план?»). Показати його БЕЗ позначки
 * означало б поставити поруч із живими клієнтами тих, кому новий план ставити
 * не можна, і жодним способом цього не сказати — тиха неправда замість гучної
 * прогалини. Тримає `#110`.
 */
const STATE_CHIP: Record<string, { label: string; bg: string; fg: string; title: string }> = {
  sleeping: { label: "💤 сплячий", bg: "#eef2ff", fg: "#3730a3",
    title: "Клієнт зараз у реактивації — рядок показано, бо за ним лишився план цього місяця. Новий план ставлять лише активним." },
  lost: { label: "❌ втрачений", bg: "#fef2f2", fg: "#991b1b",
    title: "Клієнт втрачений — рядок показано, бо за ним лишився план цього місяця." },
  oneoff: { label: "1× разовий", bg: "#f5f3ff", fg: "#5b21b6",
    title: "Не проходить кваліфікацію постійного — рядок показано, бо за ним лишився план цього місяця." },
};

/** `rule` — правило стану з ядра (`categoryRules.stateTips`), додається до пояснення чипа. */
function StateChip({ state, rule }: { state: string; rule?: string }) {
  const m = STATE_CHIP[state];
  if (!m) return null;
  return <span title={rule ? `${rule}\n${m.title}` : m.title} style={S.chip(m.bg, m.fg)}>{m.label}</span>;
}

/** Картка зверху (ТЗ п.3): клік — фільтр таблиці, повторний — знімає. «Клієнтів у вибірці» лише показує число. */
function Card({ title, value, sub, tone, on, onClick, children }: { title: string; value: string; sub?: string; tone?: "warn" | "bad" | "ok"; on?: boolean; onClick?: () => void; children?: React.ReactNode }) {
  const color = tone === "bad" ? "#dc2626" : tone === "warn" ? "#b45309" : tone === "ok" ? "#166534" : "#111827";
  const st: React.CSSProperties = { ...S.card, flex: "1 1 170px", minWidth: 160, textAlign: "left", font: "inherit",
    cursor: onClick ? "pointer" : "default", borderColor: on ? "#2563eb" : "#e5e7eb", boxShadow: on ? "0 0 0 2px #bfdbfe" : undefined };
  const body = (<>
    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    {children}
  </>);
  return onClick ? <button type="button" aria-pressed={!!on} onClick={onClick} style={st}>{body}</button> : <div style={st}>{body}</div>;
}

/** Тривалість розмови `m:ss` — так її читають у Ringostat. */
function fmtSec(sec: number | null | undefined): string {
  if (sec == null) return "";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function LastOrder({ days }: { days: number | null }) {
  if (days == null) return <span style={{ color: "#9ca3af" }}>—</span>;
  const bad = days >= 45, warn = days >= 30;
  return (
    <span style={{ color: bad ? "#dc2626" : warn ? "#b45309" : "#374151", fontWeight: warn ? 700 : 400 }}>
      {warn && "⚠️ "}{days === 0 ? "сьогодні" : `${days} дн. тому`}
    </span>
  );
}

function CommentsPanel({ clientKey, canWrite }: { clientKey: string; canWrite: boolean }) {
  const [items, setItems] = useState<ClientComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchClientComments(clientKey).then(setItems).catch(() => setItems([])); }, [clientKey]);
  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try { await addClientComment({ clientKey, body: draft.trim() }); setDraft(""); setItems(await fetchClientComments(clientKey)); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>💬 Коментарі</div>
      {items == null ? <div style={{ color: "#9ca3af", fontSize: 12 }}>завантаження…</div>
        : items.length === 0 ? <div style={{ color: "#9ca3af", fontSize: 12 }}>коментарів ще немає</div>
        : items.map((c) => (
          <div key={c.id} style={{ fontSize: 12, padding: "6px 0", borderBottom: "1px dashed #e5e7eb" }}>
            <b>{c.author ?? "—"}</b>
            <span style={{ color: "#6b7280" }}> · {c.createdAt.slice(0, 10).split("-").reverse().slice(0, 2).join(".")} — </span>
            {c.body}
          </div>
        ))}
      {canWrite && (
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Додати коментар…"
            style={{ flex: 1, fontSize: 12, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6 }} />
          <button onClick={add} disabled={busy || !draft.trim()}
            style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
            Додати
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Підсумок рівня ієрархії. Рахується З ТИХ САМИХ рядків, що показані нижче —
 * тому «згорнути» не змінює жодної цифри, а лише ховає рядки. Якби рівень
 * рахувався окремим запитом, згорнутий і розгорнутий вигляд могли б розійтись, і
 * ніхто б не сказав, який із них правильний.
 */
function levelTotals(rows: ClientPlanRow[]) {
  return {
    clients: rows.length,
    lifetime: rows.reduce((s, c) => s + c.lifetimeRevenue, 0),
    ordered: rows.filter(CARD_MATCH.ordered).length,
    fact: rows.reduce((s, c) => s + c.fact, 0),
    delta: rows.reduce((s, c) => s + c.delta, 0),
    margin6m: rows.some((c) => c.margin6m != null) ? rows.reduce((s, c) => s + (c.margin6m ?? 0), 0) : null as number | null,
  };
}

/**
 * Скільки перших колонок займає назва рівня: Клієнт · Останнє зам. · Періодичність · Контакт · Задача.
 * Далі підсумки стають РІВНО під «Всього грошей», «Цього місяця» і «Факт з рахунку» (гейт #811 рахує й цей рядок).
 */
const GROUP_LEAD_COLS = 5;
/** Колонок у таблиці: назва рівня (5) + всього грошей + цього місяця + факт + дії — одне число на шапку, рядок і підсумок. */
const COL_COUNT = GROUP_LEAD_COLS + 4;

/** Рядок-шапка рівня (команда / менеджер) з підсумками й «розгорнути». */
function GroupRow({ level, title, sub, open, onToggle, totals }: {
  level: "team" | "manager"; title: string; sub?: string; open: boolean;
  onToggle: () => void; totals: ReturnType<typeof levelTotals>;
}) {
  const isTeam = level === "team";
  return (
    <tr onClick={onToggle}
      style={{ background: isTeam ? "#f1f5f9" : "#fafcff", cursor: "pointer",
               borderTop: isTeam ? "2px solid #e2e8f0" : "1px solid #eef2f7" }}>
      <td style={{ ...S.td, paddingLeft: isTeam ? 10 : 28, fontWeight: isTeam ? 800 : 700,
                   fontSize: isTeam ? 14 : 13, borderBottom: "none" }} colSpan={GROUP_LEAD_COLS}>
        <span style={{ color: "#64748b", marginRight: 6 }}>{open ? "▾" : "▸"}</span>
        {isTeam ? "🏢 " : "👤 "}{title}
        <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>
          {sub ? ` · ${sub}` : ""} · {totals.clients} {totals.clients === 1 ? "клієнт" : "клієнтів"}
        </span>
      </td>
      <td style={{ ...S.td, borderBottom: "none", textAlign: "right", fontWeight: 700 }}>{Math.round(totals.lifetime).toLocaleString("uk-UA")}</td>
      <td style={{ ...S.td, borderBottom: "none", fontWeight: 700 }}>{totals.ordered} з {totals.clients}</td>
      <td style={{ ...S.td, borderBottom: "none", textAlign: "right", fontWeight: 800,
                   color: totals.fact > 0 ? "#166534" : "#9ca3af" }}>
        {totals.fact.toLocaleString("uk-UA")}
        <div style={{ fontSize: 11, fontWeight: 600, color: totals.delta < 0 ? "#b91c1c" : totals.delta > 0 ? "#166534" : "#6b7280" }}>{signedUah(totals.delta)} до сер.</div>
      </td>
      <td style={{ ...S.td, borderBottom: "none" }} />
    </tr>
  );
}

export function ClientPlansSection({ auth, fromReact }: { auth: AuthPayload; managers?: ManagerOption[]; fromReact?: boolean }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<ClientPlansResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payFilter, setPayFilter] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"all" | "stale">("all");
  /** 👥 Картка зверху, якою відфільтровано таблицю (ТЗ 5609, п.3): «all» — без фільтра. */
  const [card, setCard] = useState<CardKey>("all");
  /**
   * 🗂 ВКЛАДКИ «ВСІ / ПОСТІЙНІ / РЕАКТИВАЦІЯ» (ТЗ Юлі 22.09, п.3.1). Замінили ряд «Стан:».
   * Вкладка — ФІЛЬТР того самого ростеру (рішення власника 04.09.2026 «усе в одному місці» лишається):
   * клієнт не додається й не зникає, група рядка приходить із сервера (`tabGroup`, `core/clientTabs.ts`).
   * Усередині «Реактивації» — підфільтр сплячі / втрачені, бо це різні пороги й різна робота.
   */
  const [tab, setTab] = useState<"all" | "regular" | "react" | "pool">(fromReact ? "react" : "all");
  const [reactSub, setReactSub] = useState<"all" | "sleeping" | "lost">("all");
  /** 🔁 Рішення по циклу реактивації (ТЗ 22.09, блок 4): чекають · реактивую сам · у пулі. Стан — з сервера. */
  const [cycleSub, setCycleSub] = useState<"all" | "waiting" | "self" | "pool">("all");
  /** ⓘ Довідка «Як рахуються категорії» розгорнута (ТЗ 22.09, п.2.4). */
  const [showRules, setShowRules] = useState(false);
  const [creating, setCreating] = useState<{ clientKey: string; name: string } | null>(null);
  const [closing, setClosing] = useState<{ taskId: number; name: string } | null>(null);
  const [contacting, setContacting] = useState<{ clientKey: string; name: string } | null>(null);
  /** 📎 Скрини клієнта, відкриті з рядка (задача 4310, п.1.3): перегляд на місці, не вкладка. */
  const [viewingFiles, setViewingFiles] = useState<{ clientKey: string; name: string; initialId?: number | null } | null>(null);
  /** 🎧 Який запис грає просто в рядку (п.3.3): один ключ — одне аудіо, як у картці. */
  const [playing, setPlaying] = useState<string | null>(null);
  // 🔴 ДЕФОЛТ — «НАЙГІРШІ ЗВЕРХУ» (рішення власника 04.08.2026): екран існує, щоб бачити проблеми. Без плану
  // «найгірші» — найбільший МІНУС до середнього (задача 5609); «найбільші» — за фактом з рахунку.
  const [sortMode, setSortMode] = useState<"worst" | "biggest" | "margin">("worst");
  // 🧭 Фільтри ТЗ 3989 п.3 — окрема вісь від стану: «без розмови», «прострочений крок», «VIP спить 14+», «стоп через дебіторку».
  const [reactFilter, setReactFilter] = useState<"all" | "no_talk" | "step_overdue" | "vip_sleeping" | "debt_hold">("all");
  const [mgrFilter, setMgrFilter] = useState<number | "">("");
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  const [openMgrs, setOpenMgrs] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    setErr(null);
    fetchClientPlans({ month }).then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, [month]);
  useEffect(load, [load]);

  /**
   * Стартовий вигляд залежить від того, скільки людина бачить:
   *   тімлід  — його команда РОЗГОРНУТА одразу (вона в нього одна, згорнутий
   *             рівень «команда» був би кліком у нікуди);
   *   адмін/ОД/КВП — усе згорнуто до команд: саме тут список і був нечитабельний.
   * Менеджер сюди не потрапляє — у нього плаский список, як і був.
   */
  useEffect(() => {
    if (!data || auth.role !== "team_lead") return;
    setOpenTeams(new Set(data.clients.map((c) => c.teamName)));
  }, [data, auth.role]);

  /**
   * 🔴 ВІДМОВА СЕРВЕРА МУСИТЬ БУТИ ВИДИМОЮ (борг 15, той самий, що на екрані формування).
   *
   * До цього `act` не мав `catch` ЗОВСІМ: будь-яка відмова — 500, 409 «План затверджено»,
   * 403 скоупу, 400 «на цей ключ план поставити не можна» — летіла в порожнечу, і на
   * екрані НЕ ВІДБУВАЛОСЬ НІЧОГО.
   *
   * 📐 Ціна заміряна, і вона не гіпотетична: `POST /client-plan` падав із 500 на КОЖНОМУ
   * збереженні від дня переїзду на цей екран (29.07), і саме мовчання ховало це пʼять
   * тижнів. Власник вписував 50 000 і не отримував ані числа, ані помилки; півдня пішло
   * на пошук поломки там, де її не було.
   *
   * ⚠️ ОКРЕМИЙ СТАН, А НЕ `err`: той рендериться на `:237` ЗАМІСТЬ усього екрана — доречно
   * для збою завантаження, але для відмови дії це сховало б таблицю разом із помилкою.
   */
  const [actErr, setActErr] = useState<string | null>(null);
  const toast = useToast();
  const explain = (e: unknown): string => {
    const r = (e as { response?: { status?: number; data?: { error?: unknown } } }).response;
    const raw = r?.data?.error;
    const txt = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : null;
    return txt ?? (r?.status ? `Сервер відмовив (код ${r.status}). Зміну НЕ збережено.` : "Не вдалося звʼязатися з сервером. Зміну НЕ збережено.");
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setActErr(null);
    try { await fn(); load(); } catch (e) { setActErr(explain(e)); } finally { setBusy(false); }
  };

  if (err) return <div style={{ ...S.card, color: "#dc2626" }}>{err}</div>;
  if (!data) return <div style={{ ...S.card, color: "#6b7280" }}>завантаження…</div>;

  const t = data.totals;
  /** «вересень» для підпису «📞 за вересень» — місяць екрана, а не поточний. */
  const monthName = new Date(`${data.month}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "long", timeZone: "UTC" });
  /** «липні» → для підпису карток: назва місяця дати YYYY-MM-DD у називному відмінку. */
  const monLong = (d: string) => new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "long", timeZone: "UTC" });
  const shift = (d: number) => {
    const dt = new Date(`${month}-01T00:00:00Z`); dt.setUTCMonth(dt.getUTCMonth() + d);
    setMonth(dt.toISOString().slice(0, 7));
  };
  const payTypes = [...new Set(data.clients.map((c) => c.paymentType).filter(Boolean))] as string[];
  /** Усі фільтри, КРІМ картки: з цих рядків рахуються картки, тож число в картці == рядкам після кліку (ТЗ п.8). */
  const baseRows = data.clients.filter((c) => {
    if (payFilter.size && !payFilter.has(c.paymentType ?? "")) return false;
    if (view === "stale" && !(c.lastOrderDays != null && c.lastOrderDays >= 30)) return false;
    if (tab === "regular" && c.tabGroup === "react") return false;
    if (tab === "react" && c.tabGroup !== "react") return false;
    if (tab === "react" && reactSub !== "all" && c.state !== reactSub) return false;
    if (tab === "react" && cycleSub !== "all" && c.reactCycle?.status !== cycleSub) return false;
    if (mgrFilter !== "" && c.managerId !== mgrFilter) return false;
    if (reactFilter === "no_talk" && c.lastTalk != null) return false;
    if (reactFilter === "step_overdue" && c.nextStep?.state !== "overdue") return false;
    if (reactFilter === "vip_sleeping" && !(c.segment === "vip" && (c.daysSince ?? 0) >= 14)) return false;
    if (reactFilter === "debt_hold" && !c.debtHold) return false;
    return true;
  });
  const cs = cardStats(baseRows);
  const rows = baseRows.filter(CARD_MATCH[card]);
  const mgrOptions = [...new Map(data.clients.map((c) => [c.managerId, c.managerName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  /** Лічильники беруться з ТИХ САМИХ рядків, що й список, — інакше підпис розійдеться з ним. */
  const byState = data.clients.reduce((a, c) => { a[c.state] = (a[c.state] ?? 0) + 1; return a; },
    {} as Record<string, number>);
  /** Лічильники вкладок — з усього ростеру: «Постійні» + «Реактивація» == «Всі» (гейт #810b). */
  const tabCounts = {
    all: data.clients.length,
    regular: data.clients.filter((c) => c.tabGroup !== "react").length,
    react: data.clients.filter((c) => c.tabGroup === "react").length,
  };
  /** Порядок у «Всі»: постійні → жовті → реактивація; ранги дає сервер. В інших вкладках — не втручається. */
  const byGroup = (a: ClientPlanRow, b: ClientPlanRow) =>
    tab === "all" ? data.tabGroupRank[a.tabGroup] - data.tabGroupRank[b.tabGroup] : 0;
  const colCount = COL_COUNT;

  /**
   * 🔴 ІЄРАРХІЯ — ЦЕ ПОДАЧА, А НЕ СКОУП. Групуємо ТІ САМІ рядки, що прийшли з
   * бекенду: жоден клієнт не додається й не зникає, підсумки рівнів — суми
   * видимих рядків. Адмін/ОД/КВП бачили сотні клієнтів одним списком і не могли
   * з ним працювати; менеджер свій десяток бачить як бачив — йому ієрархія лише
   * додала б два кліки.
   */
  const grouped = auth.role !== "manager";
  /**
   * Порядок клієнтів: «Без роботи» — ЗВЕРХУ (макет 5609: окремий блок із червоною смугою), далі група вкладки «Всі»,
   * далі за режимом сортування. «Найгірші» — найбільший мінус до середнього.
   */
  const byRow = (a: ClientPlanRow, b: ClientPlanRow) =>
    Number(b.work.noWork) - Number(a.work.noWork) || byGroup(a, b)
    || (sortMode === "margin" ? byMargin(a, b) : sortMode === "worst" ? a.delta - b.delta || b.fact - a.fact : b.fact - a.fact);
  /** За маржею 6 міс (price = маржа): більша зверху; без оплат — унизу, а не «0 зверху». */
  const byMargin = (a: ClientPlanRow, b: ClientPlanRow) => { const A = a.margin6m ?? null, B = b.margin6m ?? null; if (A == null && B == null) return 0; if (A == null) return 1; if (B == null) return -1; return B - A; };
  const teams = (() => {
    if (!grouped) return [];
    const byTeam = new Map<string, { teamName: string; mgrs: Map<number, { name: string; rows: ClientPlanRow[] }> }>();
    for (const c of rows) {
      const tk = c.teamName;
      const tEntry = byTeam.get(tk) ?? { teamName: tk, mgrs: new Map() };
      const mEntry = tEntry.mgrs.get(c.managerId) ?? { name: c.managerName, rows: [] };
      mEntry.rows.push(c);
      tEntry.mgrs.set(c.managerId, mEntry);
      byTeam.set(tk, tEntry);
    }
    // «Найгірші» — найбільший сумарний мінус до середнього (задача 5609: плану немає, тож і % плану немає).
    const cmp = <T extends { rows: ClientPlanRow[] }>(a: T, b: T) => {
      const A = levelTotals(a.rows), B = levelTotals(b.rows);
      if (sortMode === "margin") { const a = A.margin6m ?? null, b = B.margin6m ?? null; if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1; return b - a; }
      if (sortMode === "biggest") return B.fact - A.fact;
      return A.delta - B.delta || B.fact - A.fact;
    };
    return [...byTeam.values()]
      .map((tt) => ({
        teamName: tt.teamName,
        rows: [...tt.mgrs.values()].flatMap((m) => m.rows),
        mgrs: [...tt.mgrs.entries()]
          .map(([id, m]) => ({ id, name: m.name, rows: [...m.rows].sort(byRow) }))
          .sort(cmp),
      }))
      .sort(cmp);
  })();

  const renderRow = (c: ClientPlanRow) => {
  const isOpen = open === c.clientKey;
  /** Жовтий фон — рівно група «жовті» з сервера (активні, 30+ днів без замовлення); реактивацію підписує чип стану. */
  const risk = c.tabGroup === "yellow";
  const ddmmOf = (iso: string | null | undefined) => (iso ?? "").slice(5, 10).split("-").reverse().join(".");
  const rec = playing === `talk:${c.clientKey}` && c.lastTalkRecording
    ? { src: c.lastTalkRecording, label: `розмова ${ddmmOf(c.lastTalk)}${c.lastTalkBy ? ` · ${c.lastTalkBy}` : ""}` }
    : null;
  return (
    <Fragment key={c.clientKey}>
      <tr style={{ background: risk ? "#fffbeb" : undefined }}>
        {/* 📌 Назва клієнта завжди видна (ТЗ 5609, п.6): колонка липка при горизонтальній прокрутці. «Без роботи» —
            червона смуга зліва (макет). */}
        <td style={{ ...S.td, position: "sticky", left: 0, zIndex: 1, background: risk ? "#fffbeb" : "#fff",
                     boxShadow: c.work.noWork ? "inset 4px 0 0 #dc2626" : undefined }}>
          <div style={{ fontWeight: 700 }}>{c.clientName}</div>
          <MergedLine merged={c.merged} />
          {(c.work.noWork || c.work.noTask || c.work.overdue) && (
            <div style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {c.work.noWork && <span style={S.chip("#fef2f2", "#b91c1c")} title={`${data.compare.noWorkDays} днів ні розмови в Ringostat, ні ручного контакту, і немає наступного кроку чи задачі з датою`}>Без роботи</span>}
              {c.work.noTask && <span style={S.chip("#fff7ed", "#9a3412")} title="немає відкритої задачі чи наступного кроку по клієнту">без задачі</span>}
              {c.work.overdue && <span style={S.chip("#fef2f2", "#991b1b")} title="дата задачі чи наступного кроку минула">задача прострочена</span>}
            </div>
          )}

          <div style={{ marginTop: 3, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <SegmentBadge segment={c.segment} tip={data?.categoryRules?.segmentTips[c.segment]} />
            {/* 🔴 БЕЗУМОВНО. До обʼєднання вкладок чип малювався лише в рядках, доданих
                через план, — бо решта за побудовою була активною. Тепер у списку живуть
                сплячі й втрачені, і рядок без підпису читався б як «активний» (`#330`). */}
            <StateChip state={c.state} rule={c.state === "sleeping" ? data?.categoryRules?.stateTips.sleeping : c.state === "lost" ? data?.categoryRules?.stateTips.lost : undefined} />
            {c.forcedRegular && <ForcedBadge note={c.forceNote} />}
            {/* 💬 Коментар прямо тут: клієнт може мовчати 55 днів і формально
                лишатись «активним» — причину треба записати, не розгортаючи рядок. */}
            <RowComment clientKey={c.clientKey} value={c.lastComment} canWrite onSaved={load} />
            {c.paymentType && <span style={S.chip("#eff6ff", "#1d4ed8")}>{c.paymentType}</span>}
            <span style={{ fontSize: 11, color: "#6b7280" }}>
              {c.orders} зам.{c.since ? ` · з ${c.since}` : ""}
            </span>
            {/* 👤 ВІДПОВІДАЛЬНИЙ БІЛЯ КОЖНОГО КЛІЄНТА. Джерело — те саме, що
                в передачі відповідального: COALESCE(закріплений, основний за
                оплатами). 📌 показує, що спрацювала перша гілка, а не друга. */}
            {grouped && (
              <span style={{ fontSize: 11, color: "#6b7280" }}
                title={c.pinned ? "закріплений за менеджером вручну" : "основний менеджер за оплатами"}>
                · 👤 {c.managerName}{c.pinned ? " 📌" : ""}
              </span>
            )}
            {!grouped && c.pinned && (
              <span style={S.chip("#f5f3ff", "#6d28d9")} title="закріплений за менеджером вручну">📌 {c.managerName}</span>
            )}
          </div>
        </td>
        <td style={S.td}><LastOrder days={c.lastOrderDays} /></td>
        {/* 🔁 Періодичність — ПОРУЧ з «Останнє зам.» (ТЗ п.5): «раз на 14 дн.», а поруч «79 дн. тому». */}
        <td style={S.td} title="Звичайна пауза між замовленнями клієнта (медіана; та сама, що визначає сегмент)">
          {c.periodDays == null ? <span style={{ color: "#9ca3af" }}>замало історії</span>
            : c.periodDays < 1 ? <span title="медіана паузи — менше доби: кілька замовлень в один день">кілька на день</span>
            : <span>раз на ~{Math.round(c.periodDays)} дн.</span>}
        </td>
        {/* 📱 КОНТАКТ — повернуто на екран (17.09.2026). При злитті вкладки «Реактивація» в
            план колонки про дзвінки зникли, хоч бекенд їх рахував. Тепер: остання розмова
            Ringostat АБО ручний контакт (Viber/Telegram, зі скрином), недодзвони окремо. */}
        <td style={S.td}>
          <div style={{ fontSize: 12, lineHeight: 1.4 }}>
            {/* 🎧 ОСТАННЯ РОЗМОВА — ОДРАЗУ ПОСЛУХАТИ (ТЗ 22.09, п.3.3). Запис — з того самого рядка ядра,
                що й дата розмови, тож ▶ грає саме цей дзвінок. */}
            {c.lastTalk && c.lastTalkRecording && (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button type="button" onClick={() => setPlaying(playing === `talk:${c.clientKey}` ? null : `talk:${c.clientKey}`)}
                  title={playing === `talk:${c.clientKey}` ? "Згорнути плеєр" : "Послухати останню розмову"}
                  style={{ border: "1px solid #2563eb", color: "#2563eb", background: "#fff", borderRadius: 999, width: 22, height: 22, cursor: "pointer", fontSize: 10, padding: 0 }}>
                  {playing === `talk:${c.clientKey}` ? "⏹" : "▶"}
                </button>
                <span>розмова {c.lastTalk.slice(5).split("-").reverse().join(".")} · {fmtSec(c.lastTalkSec)}{c.lastTalkBy ? ` · ${c.lastTalkBy}` : ""}</span>
              </div>
            )}
            {/* 📞 Дзвінків за ОБРАНИЙ місяць (п.3.3): розмови й усі дзвінки — два числа, не сума. */}
            <div style={{ color: "#374151" }} title="розмови (з відповіддю) / усі дзвінки за місяць екрана; ядро core/clientCalls.ts">
              📞 за {monthName}: {c.callsMonth.talks}/{c.callsMonth.calls}
            </div>
            {c.lastContact ? (
              /* Остання розмова вже показана рядком із ▶ — не дублюємо її ще раз. */
              c.lastContact.source === "talk" && c.lastTalkRecording ? null : (
                <div title={c.lastContact.source === "talk" ? "остання розмова по Ringostat (billsec > 0)" : `ручний контакт: ${contactChannelLabel(c.lastContact.channel)}`}>
                  {c.lastContact.source === "talk" ? "📞" : "📱"} {c.lastContact.at.slice(0, 10).split("-").reverse().slice(0, 2).join(".")}
                  {c.lastContact.source === "manual" && <span style={{ color: "#6b7280" }}> · {contactChannelLabel(c.lastContact.channel)}</span>}
                  {/* 📎 КНОПКА, А НЕ ПОЗНАЧКА (задача 4310, п.1.3): доти значок лише казав «скрин є»,
                      а відкрити його з рядка було нічим. */}
                  {c.lastContact.source === "manual" && c.lastContactHasFile && (
                    <button type="button" title="Переглянути скрин"
                      onClick={() => setViewingFiles({ clientKey: c.clientKey, name: c.clientName ?? c.clientKey })}
                      style={{ marginLeft: 4, border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: 0 }}>📎</button>
                  )}
                </div>
              )
            ) : c.phone === "none" ? (
              <span style={{ color: "#b45309" }} title="у контактах клієнта немає жодного номера — дзвінки не привʼязуються">📵 нема номера</span>
            ) : (
              <span style={{ color: "#9ca3af" }}>контакту не було</span>
            )}
            {c.debtHold && (
              <div style={{ fontSize: 11, color: "#b91c1c", fontWeight: 600 }} title="є прострочена дебіторка — новий план не ставимо, доки не закриють">🛑 стоп: дебіторка</div>
            )}
            {c.nextStep && (
              <div style={{ fontSize: 11, color: c.nextStep.state === "overdue" ? "#b91c1c" : c.nextStep.state === "today" ? "#b45309" : "#374151" }}
                title={`наступний крок: ${c.nextStep.text}`}>
                📌 {c.nextStep.state === "overdue" ? "прострочено " : ""}{c.nextStep.due ? c.nextStep.due.slice(5).split("-").reverse().join(".") : "без дати"} · {c.nextStep.text.length > 28 ? c.nextStep.text.slice(0, 28) + "…" : c.nextStep.text}
              </div>
            )}
            {(c.attempts ?? 0) > 0 && (
              <div style={{ color: "#b45309", fontSize: 11 }} title="дзвінки без відповіді після останньої розмови">недодзвонів {c.attempts}</div>
            )}
            <button disabled={busy} style={{ ...S.btn(), marginTop: 4, fontSize: 11, padding: "3px 8px" }}
              title="Записати контакт у Viber/Telegram/email зі скрином"
              onClick={() => setContacting({ clientKey: c.clientKey, name: c.clientName })}>＋ Контакт</button>
          </div>
        </td>
        <td style={S.td}>
          {/* 🔁 ЦИКЛ РЕАКТИВАЦІЇ (ТЗ 22.09, блок 4, п.4.2–4.3): стан, строк і кнопки — з сервера. */}
          {c.reactCycle && (
            <div style={{ marginBottom: 6 }}>
              <ReactCycleStatus cycle={c.reactCycle} />
              <ReactCycleButtons clientKey={c.clientKey} cycle={c.reactCycle} onDone={load} onError={setActErr} />
            </div>
          )}
          {/* 🔁 Перенесено з вкладки «Реактивація» дослівно. Єдина додана межа —
              активним кнопки НЕМАЄ: задача реактивації ставиться тому, хто перестав
              замовляти, і до злиття вкладок активний клієнт у цьому списку не бував
              узагалі. Тобто це не нове правило, а збереження старого. */}
          {c.state === "active" ? (
            <span style={{ color: "#9ca3af" }}>—</span>
          ) : c.taskId && c.taskStatus !== "done" ? (
            <div>
              <b>{c.taskAssignee ?? "—"}</b>
              {c.taskDeadline && <span style={{ color: "#b45309" }}> · до {c.taskDeadline.slice(5)}</span>}
              <div>
                <button disabled={busy} style={{ ...S.btn(), marginTop: 5, fontSize: 11, padding: "4px 9px" }}
                  onClick={() => setClosing({ taskId: c.taskId!, name: c.clientName })}>Закрити…</button>
              </div>
            </div>
          ) : c.taskId ? (
            /* 🔁 Автозакриття підписане ОКРЕМО: «закрита» і «клієнт повернувся» — різні
               факти, і злити їх в одне слово означало б втратити те, заради чого власник
               просив залишити слід. */
            <span style={{ color: c.closeReason?.startsWith("returned") ? "#047857" : "#6b7280" }}>
              {c.closeReason?.startsWith("returned") ? "закрита — клієнт повернувся" : "закрита"}
            </span>
          ) : c.seasonal ? (
            <span style={{ color: "#9ca3af" }}>сезонний — задача не потрібна</span>
          ) : (
            <button disabled={busy} style={{ ...S.btn(true), fontSize: 11, padding: "5px 10px" }}
              onClick={() => setCreating({ clientKey: c.clientKey, name: c.clientName })}>＋ Задача</button>
          )}
        </td>
        {/* 💰 Всього грошей від клієнта (ТЗ п.5) — Σ маржі успішних угод за весь час (price = маржа в цьому продукті). */}
        <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }} title={`${c.orders} успішних угод за весь час${c.since ? `, з ${c.since}` : ""}`}>
          {Math.round(c.lifetimeRevenue).toLocaleString("uk-UA")}
        </td>
        {/* 🗓 Замовляв цього місяця (ТЗ п.5): угода місяця дійшла до «Виставлення рахунку» або далі. */}
        <td style={S.td}>
          {c.orderedThisMonth
            ? <span style={S.chip("#dcfce7", "#166534")}>так</span>
            : <span style={c.orderedBefore ? S.chip("#fef2f2", "#b91c1c") : S.chip("#f3f4f6", "#6b7280")}
                title={c.orderedBefore ? "замовляв у 3 попередні місяці, цього — ще ні" : "і в 3 попередні місяці не замовляв"}>ні</span>}
        </td>
        <td style={{ ...S.td, textAlign: "right" }}>
          <div style={{ fontWeight: 800, color: c.fact > 0 ? "#166534" : "#9ca3af" }}>
            {c.fact.toLocaleString("uk-UA")}
            {c.factSuccess != null && c.fact > 0 && c.factSuccess !== c.fact && (
              <div style={{ fontSize: 11, fontWeight: 500, color: "#6b7280" }} title="«успішно реалізовано» за цей місяць — частина факту, що вже закрита">
                успішно {c.factSuccess.toLocaleString("uk-UA")}
              </div>
            )}
          </div>
          {/* ± до середнього (ТЗ п.3): ті самі дні трьох попередніх місяців; середнє — у підказці. */}
          <div style={{ fontSize: 11, fontWeight: 600, marginTop: 3, color: c.delta < 0 ? "#b91c1c" : c.delta > 0 ? "#166534" : "#6b7280" }}
            title={`середнє за ті самі дні 3 попередніх місяців: ${c.prevAvg.toLocaleString("uk-UA")} ₴`}>
            {signedUah(c.delta)} до сер.
          </div>
        </td>
        <td style={S.td}>
          <button onClick={() => setOpen(isOpen ? null : c.clientKey)}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>
            💬 {c.comments} · {isOpen ? "▲" : "▼"}
          </button>
        </td>
      </tr>
      {/* 🎧 ЗАПИС — ОКРЕМИМ РЯДКОМ НА ВСЮ ШИРИНУ ТАБЛИЦІ (задача 13.10.2026): у клітинці «Контакт» плеєр мав 230 px і
          смугу перемотки в кілька пікселів. Один плеєр на три місця — `RecordingPlayer`, як і в картці клієнта. */}
      {rec && (
        <tr>
          <td colSpan={colCount} style={{ padding: "6px 16px 10px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ fontSize: 12, color: "#374151", fontWeight: 600 }}>🎧 {c.clientName} · {rec.label}</div>
            <RecordingPlayer key={rec.src} src={rec.src} />
          </td>
        </tr>
      )}
      {isOpen && (
        <tr>
          <td colSpan={colCount} style={{ padding: "14px 16px", background: "#fbfdff", borderBottom: "1px solid #e5e7eb" }}>
            {/* КАРТКА КЛІЄНТА: спершу «як він платив» (те, заради чого
                рядок і розгортають), під нею — коментарі й дзвінки. */}
            {/* onChanged — щоб «прибрати з постійних» одразу зникло з цього ж
                списку, а не лишалось рядком, який уже не існує за правилом. */}
            <ClientCardPanel clientKey={c.clientKey} onChanged={load} month={month} />
            {/* 📞 Панель «перелік дзвінків ще не побудований» прибрано (задача 4310): картка вище
                вже показує дзвінки по роках із записами, і та панель стверджувала неправду. */}
            <div style={{ marginTop: 16, borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
              <CommentsPanel clientKey={c.clientKey} canWrite />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── ШАПКА */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Постійні клієнти</h2>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {data.month} · {auth.role === "manager" ? "мої клієнти" : auth.role === "team_lead" ? "моя команда" : "усі команди"}
            {" · клієнт = канонічний ключ (злиті телефони й назви рахуються разом)"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => shift(-1)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>←</button>
          <span style={{ fontWeight: 700, fontSize: 13, minWidth: 78, textAlign: "center" }}>{data.month}</span>
          <button onClick={() => shift(1)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>→</button>
        </div>
      </div>

      {/* 🚚 Клієнти з коментарем «перевізник» → в архів одним кліком (тімлід і керівництво, 05.10.2026). */}
      {auth.role !== "manager" && <CarrierCommentBanner onArchived={load} />}

      {/* ── КАРТКИ (ТЗ 5609, п.3): кожна клікабельна — фільтрує таблицю; число == рядкам після кліку (одне правило
          `CARD_MATCH`). Рахуються з рядків під усіма іншими фільтрами, тож вкладка, команда й оплата їх звужують. */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Card title="Клієнтів у вибірці" value={String(cs.all)} on={card === "all"} onClick={() => setCard("all")}
          sub="постійні у вибраних вкладці й фільтрах" />
        <Card title="Замовили цього місяця" value={String(cs.ordered)} tone="ok" on={card === "ordered"} onClick={() => setCard(toggleCard(card, "ordered"))}
          sub="угода місяця дійшла до «Виставлення рахунку» або далі" />
        <Card title="Не замовили цього місяця" value={String(cs.notOrdered)} tone={cs.notOrdered ? "bad" : undefined} on={card === "notOrdered"}
          onClick={() => setCard(toggleCard(card, "notOrdered"))}
          sub={`замовляли в ${monLong(data.compare.before.from)}–${monLong(data.compare.before.to)}, цього місяця — ще ні`} />
        <Card title="Плюс / мінус до середнього" value={signedUah(cs.delta)} tone={cs.delta < 0 ? "bad" : cs.delta > 0 ? "ok" : undefined}
          on={card === "more" || card === "less"}
          sub={data.compare.partial
            ? `з 1-го до сьогодні проти середнього за ті самі дні 3 попередніх місяців`
            : `місяць проти середнього за 3 попередні місяці`}>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {(["more", "less"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={card === k} onClick={() => setCard(toggleCard(card, k))}
                style={{ ...S.chip(card === k ? "#111827" : k === "more" ? "#dcfce7" : "#fef2f2", card === k ? "#fff" : k === "more" ? "#166534" : "#b91c1c"), border: "none", cursor: "pointer", fontSize: 11, padding: "3px 8px" }}>
                {k === "more" ? `купили більше ${cs.more.n} · ${signedUah(cs.more.sum)}` : `купили менше ${cs.less.n} · ${signedUah(cs.less.sum)}`}
              </button>
            ))}
          </div>
        </Card>
        <Card title="Без роботи" value={String(cs.noWork)} tone={cs.noWork ? "bad" : undefined} on={card === "noWork"}
          onClick={() => setCard(toggleCard(card, "noWork"))}
          sub={`без контакту ${data.compare.noWorkDays} дн. і кроку з датою: ${cs.noWorkOnly} · без задачі: ${cs.noTaskOnly}`} />
        <Card title="Задача прострочена" value={String(cs.overdue)} tone={cs.overdue ? "warn" : undefined} on={card === "overdue"}
          onClick={() => setCard(toggleCard(card, "overdue"))} sub="дата задачі чи наступного кроку минула" />
      </div>

      {/* 🔢 ТРИ ЦИФРИ РЕАКТИВАЦІЇ (ТЗ 3989, п.5) — ЗВЕРХУ, одразу під показниками плану. */}
      {t.react && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "0 0 10px" }}>
          {[
            ["в роботі (реактивація)", t.react.inWork, "сплячі + втрачені у вашому скоупі"],
            ["повернуто за місяць", t.react.returnedMonth, `перша оплата місяця після паузи ≥ ${t.react.gapDays} дн.`],
            ["повернутої маржі", formatAmountFull(t.react.returnedMargin), "Σ оплат цих клієнтів цього місяця (price = маржа)"],
          ].map(([label, val, hint]) => (
            <div key={String(label)} title={String(hint)} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 14px", background: "#fff", minWidth: 150 }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── ВКЛАДКИ (ТЗ 22.09, п.3.1): фільтр одного списку; лічильники з усього ростеру */}
      <div role="tablist" style={{ display: "flex", gap: 0, borderBottom: "1px solid #e5e7eb" }}>
        {([["all", "Всі"], ["regular", "Постійні"], ["react", "Реактивація"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            style={{ padding: "9px 16px", border: "none", borderBottom: `3px solid ${tab === k ? "#2563eb" : "transparent"}`,
                     marginBottom: -1, background: "transparent", cursor: "pointer", fontSize: 14,
                     fontWeight: tab === k ? 700 : 500, color: tab === k ? "#111827" : "#6b7280" }}>
            {label} <span style={{ fontSize: 12, padding: "1px 7px", borderRadius: 999, background: "#f3f4f6", color: "#374151" }}>{tabCounts[k]}</span>
          </button>
        ))}
        {/* 🎯 Пул лідгенів (ТЗ 22.09, п.4.2–4.4) — вкладку бачить лише той, кому сервер відкрив пул. */}
        {data.leadgenPool?.canSee && (
          <button role="tab" aria-selected={tab === "pool"} onClick={() => setTab("pool")}
            style={{ padding: "9px 16px", border: "none", borderBottom: `3px solid ${tab === "pool" ? "#6d28d9" : "transparent"}`,
                     marginBottom: -1, background: "transparent", cursor: "pointer", fontSize: 14,
                     fontWeight: tab === "pool" ? 700 : 500, color: tab === "pool" ? "#111827" : "#6b7280" }}>
            🎯 Пул лідгенів
          </button>
        )}
      </div>

      {/* ── ФІЛЬТРИ + ДІЇ ЦИКЛУ */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {payTypes.map((p) => {
          const on = payFilter.has(p);
          return (
            <button key={p} onClick={() => { const n = new Set(payFilter); on ? n.delete(p) : n.add(p); setPayFilter(n); }}
              style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                       border: `1px solid ${on ? "#2563eb" : "#d1d5db"}`, background: on ? "#eff6ff" : "#fff",
                       color: on ? "#1d4ed8" : "#374151" }}>{p}</button>
          );
        })}
        <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}>Показати:</span>
        {([["all", "усі"], ["stale", "без замовлень 30+ дн."]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                     border: `1px solid ${view === k ? "#2563eb" : "#d1d5db"}`, background: view === k ? "#eff6ff" : "#fff",
                     color: view === k ? "#1d4ed8" : "#374151" }}>{label}</button>
        ))}
        {tab === "react" && (
          <>
            <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}
              title="Стан рішення по клієнту в поточному циклі реактивації — з сервера">Рішення:</span>
            {([["all", "усі"], ["waiting", "чекають рішення"], ["self", "реактивую сам"], ["pool", "у пулі лідгенів"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setCycleSub(k)}
                style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                         border: `1px solid ${cycleSub === k ? "#6d28d9" : "#d1d5db"}`,
                         background: cycleSub === k ? "#f5f3ff" : "#fff",
                         color: cycleSub === k ? "#6d28d9" : "#374151" }}>
                {label}{k !== "all" ? ` · ${data.clients.filter((c) => c.reactCycle?.status === k).length}` : ""}
              </button>
            ))}
            <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}>Реактивація:</span>
            {([["all", "усі"], ["sleeping", "сплячі"], ["lost", "втрачені"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setReactSub(k)}
                title={k === "sleeping" ? data?.categoryRules?.stateTips.sleeping : k === "lost" ? data?.categoryRules?.stateTips.lost : undefined}
                style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                         border: `1px solid ${reactSub === k ? "#2563eb" : "#d1d5db"}`,
                         background: reactSub === k ? "#eff6ff" : "#fff",
                         color: reactSub === k ? "#1d4ed8" : "#374151" }}>
                {label}{k !== "all" && byState[k] ? ` · ${byState[k]}` : ""}
              </button>
            ))}
          </>
        )}
        <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}>Фільтр:</span>
        {([["all", "усі"], ["no_talk", "без розмови"], ["step_overdue", "прострочений крок"], ["vip_sleeping", "VIP спить 14+"], ["debt_hold", "стоп: дебіторка"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setReactFilter(k)}
            title={k === "no_talk" ? "жодної розмови по Ringostat" : k === "step_overdue" ? "дата наступного кроку минула" : k === "vip_sleeping" ? "сегмент VIP і 14+ днів без замовлення" : k === "debt_hold" ? "є прострочена дебіторка — новий план не ставимо" : undefined}
            style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                     border: `1px solid ${reactFilter === k ? (k === "debt_hold" ? "#b91c1c" : "#2563eb") : "#d1d5db"}`,
                     background: reactFilter === k ? (k === "debt_hold" ? "#fef2f2" : "#eff6ff") : "#fff",
                     color: reactFilter === k ? (k === "debt_hold" ? "#b91c1c" : "#1d4ed8") : "#374151" }}>{label}</button>
        ))}
        {grouped && mgrOptions.length > 1 && (
          <select value={mgrFilter} onChange={(e) => setMgrFilter(e.target.value ? Number(e.target.value) : "")}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 8, border: "1px solid #d1d5db", marginLeft: 6 }}>
            <option value="">менеджер: усі</option>
            {mgrOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}>
          показано {rows.length} із {data.clients.length}
        </span>
        {/* ⓘ ДОВІДКА ПРАВИЛ (ТЗ 22.09, п.2.4). Текст складає ядро (`core/categoryRules.ts`) з тих
            самих констант, що рахують категорію; тут лише показ. */}
        {data.categoryRules && (
          <button type="button" onClick={() => setShowRules((v) => !v)} aria-expanded={showRules}
            style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer", marginLeft: 6,
                     border: "1px solid #d1d5db", background: showRules ? "#eff6ff" : "#fff", color: "#1d4ed8" }}>
            ⓘ Як рахуються категорії
          </button>
        )}
        {grouped && (
          <>
            <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}>Сортувати:</span>
            {([["worst", "найгірші зверху"], ["biggest", "найбільші зверху"], ["margin", "за маржею 6 міс"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setSortMode(k)}
                title={k === "worst" ? "найбільший мінус до середнього зверху" : k === "margin" ? "Σ маржі (price) за 6 місяців; без оплат — унизу" : "за фактом з рахунку цього місяця"}
                style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                         border: `1px solid ${sortMode === k ? "#2563eb" : "#d1d5db"}`,
                         background: sortMode === k ? "#eff6ff" : "#fff",
                         color: sortMode === k ? "#1d4ed8" : "#374151" }}>{label}</button>
            ))}
          </>
        )}
        <span style={{ flex: 1 }} />
      </div>

      {showRules && data.categoryRules && (
        <div style={{ ...S.card, marginBottom: 10, fontSize: 12.5, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>ⓘ Як рахуються категорії клієнтів</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.categoryRules.text.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>Пороги беруться з тих самих правил, що рахують категорію, тож тут завжди актуальні числа.</div>
        </div>
      )}

      {/* ── ТАБЛИЦЯ */}
      {actErr && (
        <div role="alert" style={{ ...S.card, marginBottom: 8, borderLeft: "3px solid #dc2626",
                                   color: "#b91c1c", fontSize: 13, fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
          <span>⚠️</span><span style={{ flex: 1 }}>{actErr}</span>
          <button onClick={() => setActErr(null)} title="сховати"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#b91c1c", fontSize: 15 }}>×</button>
        </div>
      )}
      {tab === "react" && data.reactRules && (
        <div style={{ ...S.card, marginBottom: 8, fontSize: 12.5, color: "#4b5563", lineHeight: 1.55, borderLeft: "3px solid #6d28d9" }}>
          <b>Реактивація</b> — клієнти без виставленого рахунку {data.reactRules.quietMonths} повні календарні місяці
          (з 4-го місяця). Натисніть «🙋 Реактивую сам» або «🎯 Передати лідгенам». Без рахунку й без рішення
          за {Math.round(data.reactRules.decisionDays / 7)} тижні клієнт іде в пул лідгенів автоматично; після «Реактивую сам» —
          через {Math.round(data.reactRules.selfGraceDays / 7)} тижні без рахунку. Передача — щопонеділка о {data.reactRules.transferHour}:00, не більше{" "}
          {data.reactRules.weeklyCap} клієнтів на тиждень, першими — з найсвіжішим рахунком. Ті, хто вже був у реактивації,
          ідуть порціями з понеділка {data.reactRules.launchRelease.slice(8, 10)}.{data.reactRules.launchRelease.slice(5, 7)}.
        </div>
      )}
      {tab === "pool" ? <LeadgenPoolPanel onTaken={load} /> : (
      /* 📌 ШАПКА ЗАКРІПЛЕНА (ТЗ 5609, п.6): прокрутка — усередині блоку таблиці, тож `sticky` тримає підписи колонок
         зверху, а колонку «Клієнт» — зліва. */
      <div style={{ ...S.card, padding: 0, overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 1180 }}>
          <thead>
            <tr>
              <th style={{ ...S.th, ...STICKY_TH, left: 0, zIndex: 3 }}>Клієнт</th>
              <th style={{ ...S.th, ...STICKY_TH }}>Останнє зам.</th>
              <th style={{ ...S.th, ...STICKY_TH }} title="Звичайна пауза між замовленнями (медіана)">Періодичність</th>
              <th style={{ ...S.th, ...STICKY_TH }} title="Остання розмова (Ringostat) або ручний контакт у месенджері; недодзвони після останньої розмови">Контакт</th>
              <th style={{ ...S.th, ...STICKY_TH }}>Задача</th>
              <th style={{ ...S.th, ...STICKY_TH, textAlign: "right" }} title="Σ маржі успішних угод клієнта за весь час">Всього грошей</th>
              <th style={{ ...S.th, ...STICKY_TH }} title="угода цього місяця дійшла до «Виставлення рахунку» або далі">Замовляв цього міс.</th>
              <th style={{ ...S.th, ...STICKY_TH, textAlign: "right" }} title="угоди, що в цьому місяці вперше дійшли до «Виставлення рахунку» або далі; програні не рахуються. Нижче — плюс / мінус до середнього">Факт з рахунку</th>
              <th style={{ ...S.th, ...STICKY_TH }}>Дії</th>
            </tr>
          </thead>
          <tbody>
            {!grouped && [...rows].sort(byRow).map(renderRow)}
            {grouped && teams.map((tm) => {
              const tOpen = openTeams.has(tm.teamName);
              return (
                <Fragment key={tm.teamName}>
                  <GroupRow level="team" title={tm.teamName} open={tOpen}
                    sub={`${tm.mgrs.length} ${tm.mgrs.length === 1 ? "менеджер" : "менеджерів"}`}
                    totals={levelTotals(tm.rows)}
                    onToggle={() => setOpenTeams((prev) => {
                      const n = new Set(prev); n.has(tm.teamName) ? n.delete(tm.teamName) : n.add(tm.teamName); return n;
                    })} />
                  {tOpen && tm.mgrs.map((mg) => {
                    const mOpen = openMgrs.has(mg.id);
                    return (
                      <Fragment key={mg.id}>
                        <GroupRow level="manager" title={mg.name} open={mOpen} totals={levelTotals(mg.rows)}
                          onToggle={() => setOpenMgrs((prev) => {
                            const n = new Set(prev); n.has(mg.id) ? n.delete(mg.id) : n.add(mg.id); return n;
                          })} />
                        {mOpen && mg.rows.map(renderRow)}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={colCount} style={{ ...S.td, color: "#9ca3af", textAlign: "center", padding: 24 }}>
                немає клієнтів під цей фільтр
              </td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr style={{ background: "#f8fafc", fontWeight: 800 }}>
                <td style={{ ...S.td, borderBottom: "none" }} colSpan={GROUP_LEAD_COLS}>Разом · {rows.length} клієнтів</td>
                <td style={{ ...S.td, borderBottom: "none", textAlign: "right" }}>{Math.round(levelTotals(rows).lifetime).toLocaleString("uk-UA")}</td>
                <td style={{ ...S.td, borderBottom: "none" }}>{levelTotals(rows).ordered} з {rows.length}</td>
                <td style={{ ...S.td, borderBottom: "none", textAlign: "right" }}>
                  {rows.reduce((s2, c) => s2 + c.fact, 0).toLocaleString("uk-UA")}
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{signedUah(levelTotals(rows).delta)} до сер.</div>
                </td>
                <td style={{ ...S.td, borderBottom: "none" }} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}

      {/* 🌉 МІСТОК. Сплячі й втрачені з екрана ЗНИКЛИ (жорсткий поділ) — без цього
          рядка вони зникли б МОВЧКИ, і це читалось би як «клієнти загубились».
          У Σ «постійні принесуть» місток НЕ входить: це не план, а вказівник. */}
      {/* 🔁 З блоку 4 (30.09.2026) число містка — РІВНО лічильник вкладки «Реактивація» (3 повні місяці без
          рахунку). Доти тут стояло `t.inReactivation` за станом (сплячі + втрачені): 677 поруч із вкладкою 501 —
          два джерела одного показника на одному екрані. Стан лишився підфільтром усередині вкладки. */}
      {tab !== "react" && tab !== "pool" && tabCounts.react > 0 && (
        <div style={{ ...S.card, borderLeft: "3px solid #b45309", display: "flex",
                      alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>
            🌉 Ще <b>{tabCounts.react}</b> постійних зараз у <b>реактивації</b>
            <span style={{ color: "#6b7280" }}> — без виставленого рахунку {data.reactRules?.quietMonths ?? 3} повні місяці.</span>
          </span>
          <button type="button" onClick={() => setTab("react")}
            style={{ fontSize: 12, color: "#b45309", border: "none", background: "transparent", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
            → вкладка «Реактивація»
          </button>
        </div>
      )}

      {/* 🎯 РАЗОВІ. Той самий аргумент, що й місток: після двошляхової кваліфікації
          база постійних звузилась, і без цього рядка це читалось би як «клієнти
          зникли». Тут вони НАЗВАНІ — і сказано, за яким правилом. */}
      {t.oneOff > 0 && (
        <div style={{ ...S.card, fontSize: 12, color: "#4b5563", lineHeight: 1.6 }}>
          <b>Разових: {t.oneOff}</b> — не проходять кваліфікацію постійного і тому не показані
          ні тут, ні в реактивації. Правило: <b>безнал</b> — 2+ оплати з інтервалом до 30 днів
          або 3+ за всю історію; <b>готівка</b> — 3+ за історію; змішані форми рахуються за
          безнальним правилом. Разовий не зник — він просто не постійний.
          {t.skippedGeneric > 0 && (
            <> {" "}Ще <b>{t.skippedGeneric}</b> сплячих і втрачених мають ключ-телефон без
            безготівкових оплат — фільтр реактивації їх не показує (це разові фізособи), у плані
            їх теж немає. Названі тут, щоб не зникли мовчки.</>
          )}
        </div>
      )}

      <div style={{ ...S.card, fontSize: 12, color: "#4b5563", lineHeight: 1.6 }}>
        <b>Як це рахується.</b> Факт — угоди, що в місяці вперше дійшли до «Виставлення рахунку»
        або будь-якого етапу далі (готівка без рахунку — з наступного етапу); програні не рахуються.
        Це факт саме цього екрана (ТЗ 22.09): Звіт і КВП рахують «успішно реалізовано», тож суми
        розходяться свідомо. Рахує ядро, не цей екран. <b>Плюс / мінус до середнього</b> — факт з 1-го до сьогодні
        проти середнього за ті самі дні трьох попередніх місяців. <b>Не замовили</b> — замовляли в трьох попередніх
        місяцях, цього — ще ні. <b>Без роботи</b> — {data.compare.noWorkDays} днів ні розмови в Ringostat, ні ручного
        контакту, і немає наступного кроку чи задачі з датою; разом із ними — клієнти без жодної задачі. <b>Всього
        грошей</b> — маржа успішних угод за весь час. Планів по клієнтах немає (регламент ред. 2). Клієнт = канонічний
        ключ: злиті телефони й назви рахуються разом.
      </div>

      {creating && (
        <CreateTaskDialog client={creating} busy={busy} error={actErr}
          onCancel={() => { setCreating(null); setActErr(null); }}
          onSubmit={(deadline, comment) => act(async () => {
            const r = await createClientReactivationTask({ clientKey: creating.clientKey, deadline, comment });
            setCreating(null);
            toast(`«${r.clientName || creating.name}». Виконавець — основний менеджер клієнта, задача в його Задачнику.`, { head: "Задачу реактивації створено" });
          })} />
      )}
      {viewingFiles && (
        <ClientContactFileViewer clientKey={viewingFiles.clientKey} clientName={viewingFiles.name}
          initialId={viewingFiles.initialId ?? null} onClose={() => setViewingFiles(null)} />
      )}
      {contacting && (
        <ContactDialog client={contacting} busy={busy} error={actErr}
          onCancel={() => { setContacting(null); setActErr(null); }}
          onSubmit={(channel, note, file) => act(async () => {
            await addClientContact({ clientKey: contacting.clientKey, channel, note, file });
            setContacting(null);
            toast(`Контакт записано: «${contacting.name}»`);
          })} />
      )}
      {closing && data.closeReasons && (
        <CloseTaskDialog task={closing} reasons={data.closeReasons} busy={busy} error={actErr}
          onCancel={() => { setClosing(null); setActErr(null); }}
          onSubmit={(reason, note) => act(async () => {
            await closeReactivationTask({ taskId: closing.taskId, reason, note });
            setClosing(null);
            toast(`Задачу закрито: «${closing.name}»`);
          })} />
      )}
    </div>
  );
}
