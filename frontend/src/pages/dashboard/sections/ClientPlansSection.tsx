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
import { SegmentBadge, ForcedBadge } from "./SegmentBadge";
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
/** Ширини двох закріплених зліва колонок «Робота» й «Клієнт» — назва клієнта завжди видна (ТЗ 5609, п.6). */
const W_WORK = 112, W_NAME = 260;
const STICKY_COL = (left: number, width: number): React.CSSProperties => ({ position: "sticky", left, zIndex: 1, width, minWidth: width, maxWidth: width });

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
  active: { label: "Активний", bg: "#dcfce7", fg: "#166534", title: "Замовляє у своєму звичному ритмі." },
  sleeping: { label: "Сплячий", bg: "#fef3c7", fg: "#92400e", title: "Пауза довша за звичну для сегмента." },
  lost: { label: "Втрачений", bg: "#fef2f2", fg: "#991b1b", title: "Давно без замовлень." },
  oneoff: { label: "1× разовий", bg: "#f5f3ff", fg: "#5b21b6", title: "Не проходить кваліфікацію постійного." },
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
  const st: React.CSSProperties = { ...S.card, textAlign: "left", font: "inherit", minWidth: 0,
    cursor: onClick ? "pointer" : "default", borderColor: on ? "#2563eb" : "#e5e7eb", boxShadow: on ? "0 0 0 2px #bfdbfe" : undefined };
  // Як у макеті 5609: число зверху, під ним назва, нижче — пояснення дрібно.
  const body = (<>
    <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    <div style={{ fontSize: 13, color: "#111827", marginTop: 4 }}>{title}</div>
    {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4, lineHeight: 1.35 }}>{sub}</div>}
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


/** Стовпчики «Історія» за 6 місяців (макет 5609): поточний місяць — темніший. Підказка — суми по місяцях. */
function Spark({ values, months }: { values: number[]; months: string[] }) {
  const mx = Math.max(1, ...values.map((v) => Math.abs(v)));
  const mon = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "short", timeZone: "UTC" });
  return (
    <div title={values.map((v, i) => `${mon(months[i] ?? "")}: ${Math.round(v).toLocaleString("uk-UA")} ₴`).join(", ")}
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 28 }}>
      {values.map((v, i) => (
        <i key={i} style={{ display: "block", width: 9, height: Math.max(1, (Math.abs(v) / mx) * 26),
          background: i === values.length - 1 ? "#dc2626" : "#fca5a5", borderRadius: 1 }} />
      ))}
    </div>
  );
}

/** ВІП, що не замовляє 14+ днів — та сама межа, що й була у фільтрі «VIP спить 14+». */
const vipSleeping = (c: ClientPlanRow) => c.segment === "vip" && (c.daysSince ?? 0) >= 14;

/**
 * Швидкі фільтри під панеллю (макет 5609). Поєднуються через «І». Ключі `no_talk`, `step_overdue`, `vip_sleeping`,
 * `debt_hold` — ті самі, що були (ТЗ 3989, п.3).
 */
type QuickKey = "noWork" | "noTask" | "vipNoTask" | "step_overdue" | "vip_sleeping" | "sleeping" | "no_talk" | "debt_hold" | "stale" | "yearGone";
const QUICK: readonly { key: QuickKey; label: string; title: string; fn: (c: ClientPlanRow) => boolean }[] = [
  { key: "noWork", label: "Без роботи", title: "30+ днів ні розмови, ні контакту в месенджері, і немає кроку чи задачі з датою", fn: (c) => c.work.noWork },
  { key: "noTask", label: "Без задачі", title: "немає відкритої задачі чи наступного кроку", fn: (c) => c.work.noTask },
  { key: "vipNoTask", label: "ВІП 14+ без задачі", title: "ВІП не замовляє 14+ днів, а задачі немає — у першу чергу", fn: (c) => vipSleeping(c) && c.work.noTask },
  { key: "step_overdue", label: "Задача прострочена", title: "дата задачі чи наступного кроку минула", fn: (c) => c.work.overdue },
  { key: "vip_sleeping", label: "ВІП спить 14+", title: "сегмент ВІП і 14+ днів без замовлення", fn: vipSleeping },
  { key: "sleeping", label: "Сплячі", title: "пауза довша за звичну для сегмента", fn: (c) => c.state === "sleeping" },
  { key: "no_talk", label: "Без розмови 30+ днів", title: "у телефонії Ringostat немає розмови з клієнтом понад 30 днів", fn: (c) => c.lastTalkDays == null || c.lastTalkDays > 30 },
  { key: "debt_hold", label: "Стоп: дебіторка", title: "є прострочена дебіторка", fn: (c) => !!c.debtHold },
  { key: "stale", label: "Без замовлень 30+ днів", title: "останнє замовлення понад 30 днів тому", fn: (c) => c.lastOrderDays != null && c.lastOrderDays > 30 },
  { key: "yearGone", label: "Замовлень понад рік немає", title: "останнє замовлення понад 365 днів тому", fn: (c) => c.lastOrderDays != null && c.lastOrderDays > 365 },
];

/** Позначки «Що не так» у рядку (макет 5609). */
function flagsOf(c: ClientPlanRow): { label: string; tone: "bad" | "warn" }[] {
  const f: { label: string; tone: "bad" | "warn" }[] = [];
  if (c.work.noWork) f.push({ label: "Без роботи", tone: "bad" });
  if (vipSleeping(c)) f.push({ label: "ВІП спить 14+", tone: "bad" });
  else if (c.state === "sleeping") f.push({ label: "Сплячий", tone: "warn" });
  if (c.state === "lost") f.push({ label: "Втрачений", tone: "bad" });
  if (!c.work.noWork && (c.lastTalkDays == null || c.lastTalkDays > 30)) f.push({ label: "Без розмови 30+ днів", tone: "warn" });
  if (c.debtHold) f.push({ label: "Стоп: дебіторка", tone: "bad" });
  if (c.work.overdue) f.push({ label: "Задача прострочена", tone: "bad" });
  return f;
}

/** Колонки таблиці (макет 5609 + три колонки ТЗ п.5). `sort` — ключ сортування кліком по заголовку. */
type SortKey = "work" | "name" | "manager" | "segment" | "lastOrder" | "period" | "talk" | "avg3" | "fact" | "lifetime" | "ordered" | "margin6m" | "flags" | "task";
const COLS: readonly { key: SortKey; label: string; num?: boolean; title: string }[] = [
  { key: "work", label: "Робота", title: "Немає роботи — 30+ днів ні розмови, ні переписки, і немає наступного кроку з датою" },
  { key: "name", label: "Клієнт", title: "Назва клієнта в CRM; «обʼєднано» — злиті юрособи й контакти" },
  { key: "manager", label: "Менеджер", title: "Відповідальний менеджер і його команда" },
  { key: "segment", label: "Сегмент і стан", title: "Сегмент за звичною паузою між оплатами; стан — чи замовляє у своєму ритмі" },
  { key: "lastOrder", label: "Останнє замовлення", num: true, title: "Скільки днів від останнього замовлення; нижче — дата останнього рахунку" },
  { key: "period", label: "Періодичність", num: true, title: "Звичайна пауза між замовленнями (медіана)" },
  { key: "talk", label: "Остання розмова (Ringostat)", num: true, title: "Остання розмова з клієнтом у телефонії; ручний контакт у месенджері — нижче" },
  { key: "avg3", label: "Історія · середнє/міс", num: true, title: "Гроші з рахунку по місяцях за пів року; число — середнє за 3 повні місяці перед цим" },
  { key: "fact", label: "Факт з рахунку", num: true, title: "угоди, що в цьому місяці вперше дійшли до «Виставлення рахунку» або далі; програні не рахуються. Нижче — плюс / мінус до середнього" },
  { key: "lifetime", label: "Всього грошей", num: true, title: "Σ маржі успішних угод клієнта за весь час" },
  { key: "ordered", label: "Замовляв цього міс.", title: "угода цього місяця дійшла до «Виставлення рахунку» або далі" },
  { key: "margin6m", label: "Маржа 6 міс", num: true, title: "Σ маржі успішних угод за 6 місяців" },
  { key: "flags", label: "Що не так", title: "На що звернути увагу" },
  { key: "task", label: "Задача", title: "Відкрита задача чи наступний крок по клієнту" },
];
/** Колонок у таблиці — одне число на шапку, групові рядки, плеєр і картку. */
const COL_COUNT = COLS.length;

export function ClientPlansSection({ auth, fromReact }: { auth: AuthPayload; managers?: ManagerOption[]; fromReact?: boolean }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<ClientPlansResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 👥 Картка зверху, якою відфільтровано таблицю (ТЗ 5609, п.3): «all» — без фільтра. */
  const [card, setCard] = useState<CardKey>("all");
  /**
   * 🗂 ВКЛАДКИ «ВСІ / ПОСТІЙНІ / РЕАКТИВАЦІЯ» (ТЗ Юлі 22.09, п.3.1) — лишились перемикачем над таблицею (Роман 14.10.2026).
   * Вкладка — ФІЛЬТР того самого ростеру: клієнт не додається й не зникає, група рядка — з сервера (`core/clientTabs.ts`).
   */
  const [tab, setTab] = useState<"all" | "regular" | "react" | "pool">(fromReact ? "react" : "all");
  const [reactSub, setReactSub] = useState<"all" | "sleeping" | "lost">("all");
  /** 🔁 Рішення по циклу реактивації (ТЗ 22.09, блок 4): чекають · реактивую сам · у пулі. Стан — з сервера. */
  const [cycleSub, setCycleSub] = useState<"all" | "waiting" | "self" | "pool">("all");
  // 🔎 Панель фільтрів макета 5609: пошук, команда, менеджер, сегмент, стан, оплата + швидкі фільтри.
  const [q, setQ] = useState("");
  /** Тімліду — одразу своя команда (Роман 14.10.2026): у пласкому списку інакше він бачив би всіх. */
  const [fTeam, setFTeam] = useState<number | "">(() => (auth.role === "team_lead" && auth.teamId != null ? auth.teamId : ""));
  const [fMgr, setFMgr] = useState<number | "">("");
  const [fSeg, setFSeg] = useState("");
  const [fSt, setFSt] = useState("");
  const [fPay, setFPay] = useState("");
  const [quick, setQuick] = useState<Set<QuickKey>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "avg3", dir: -1 });
  /** ⓘ Довідка «Як рахуються категорії» розгорнута (ТЗ 22.09, п.2.4). */
  const [showRules, setShowRules] = useState(false);
  const [creating, setCreating] = useState<{ clientKey: string; name: string } | null>(null);
  const [closing, setClosing] = useState<{ taskId: number; name: string } | null>(null);
  const [contacting, setContacting] = useState<{ clientKey: string; name: string } | null>(null);
  /** 📎 Скрини клієнта, відкриті з рядка (задача 4310, п.1.3): перегляд на місці, не вкладка. */
  const [viewingFiles, setViewingFiles] = useState<{ clientKey: string; name: string; initialId?: number | null } | null>(null);
  /** 🎧 Який запис грає просто в рядку (п.3.3): один ключ — одне аудіо, як у картці. */
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    fetchClientPlans({ month }).then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, [month]);
  useEffect(load, [load]);

  /**
   * 🔴 ВІДМОВА СЕРВЕРА МУСИТЬ БУТИ ВИДИМОЮ (борг 15). Окремий стан, а не `err`: той рендериться ЗАМІСТЬ усього екрана —
   * доречно для збою завантаження, але для відмови дії це сховало б таблицю разом із помилкою.
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
  /** Назва місяця дати YYYY-MM-DD — для підписів карток і заголовків. */
  const monLong = (d: string) => new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "long", timeZone: "UTC" });
  const shift = (d: number) => {
    const dt = new Date(`${month}-01T00:00:00Z`); dt.setUTCMonth(dt.getUTCMonth() + d);
    setMonth(dt.toISOString().slice(0, 7));
  };
  const teamOptions = [...new Map(data.clients.filter((c) => c.teamId != null).map((c) => [c.teamId!, c.teamName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk"));
  const mgrOptions = [...new Map(data.clients.filter((c) => fTeam === "" || c.teamId === fTeam).map((c) => [c.managerId, c.managerName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk"));
  const payTypes = [...new Set(data.clients.map((c) => c.paymentType).filter(Boolean))] as string[];
  const needle = q.trim().toLowerCase();
  /** Усі фільтри, КРІМ картки: з цих рядків рахуються картки, тож число в картці == рядкам після кліку (ТЗ п.8). */
  const baseRows = data.clients.filter((c) => {
    if (tab === "regular" && c.tabGroup === "react") return false;
    if (tab === "react" && c.tabGroup !== "react") return false;
    if (tab === "react" && reactSub !== "all" && c.state !== reactSub) return false;
    if (tab === "react" && cycleSub !== "all" && c.reactCycle?.status !== cycleSub) return false;
    if (fTeam !== "" && c.teamId !== fTeam) return false;
    if (fMgr !== "" && c.managerId !== fMgr) return false;
    if (fSeg && c.segment !== fSeg) return false;
    if (fSt && c.state !== fSt) return false;
    if (fPay && (c.paymentType ?? "") !== fPay) return false;
    for (const qf of QUICK) if (quick.has(qf.key) && !qf.fn(c)) return false;
    if (needle) {
      const hay = [c.clientName, ...(c.merged ?? []).map((m) => m.name), c.managerName, c.teamName, c.lastComment?.body ?? "", c.nextStep?.text ?? ""].join(" ").toLowerCase();
      if (!needle.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const cs = cardStats(baseRows);
  const rows = baseRows.filter(CARD_MATCH[card]);
  const byState = data.clients.reduce((a, c) => { a[c.state] = (a[c.state] ?? 0) + 1; return a; }, {} as Record<string, number>);
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
  const sortVal = (c: ClientPlanRow): number | string => {
    switch (sort.key) {
      case "work": return Number(c.work.noWork);
      case "name": return c.clientName.toLowerCase();
      case "manager": return c.managerName.toLowerCase();
      case "segment": return "vregu".indexOf(c.segment[0]) * 10 + ["active", "sleeping", "lost", "oneoff"].indexOf(c.state);
      case "lastOrder": return c.lastOrderDays ?? Number.MAX_SAFE_INTEGER;
      case "period": return c.periodDays ?? Number.MAX_SAFE_INTEGER;
      case "talk": return c.lastTalkDays ?? Number.MAX_SAFE_INTEGER;
      case "avg3": return c.avg3;
      case "fact": return c.fact;
      case "lifetime": return c.lifetimeRevenue;
      case "ordered": return Number(c.orderedThisMonth);
      case "margin6m": return c.margin6m ?? -Number.MAX_SAFE_INTEGER;
      case "flags": return flagsOf(c).length;
      case "task": return c.nextStep?.due ?? c.taskDeadline ?? "9999";
    }
  };
  /**
   * Порядок: «Без роботи» — окремим блоком ЗВЕРХУ (макет 5609), далі група вкладки «Всі», далі колонка сортування.
   */
  const byRow = (a: ClientPlanRow, b: ClientPlanRow) => {
    const x = sortVal(a), y = sortVal(b);
    return Number(b.work.noWork) - Number(a.work.noWork) || byGroup(a, b)
      || (typeof x === "string" ? x.localeCompare(String(y), "uk") : x - (y as number)) * sort.dir;
  };
  const sorted = [...rows].sort(byRow);
  const noWorkRows = sorted.filter((c) => c.work.noWork);
  const workRows = sorted.filter((c) => !c.work.noWork);
  const pickSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key: k, dir: (COLS.find((c) => c.key === k)?.num ? -1 : 1) as 1 | -1 }));
  const resetFilters = () => { setQ(""); setFTeam(auth.role === "team_lead" && auth.teamId != null ? auth.teamId : ""); setFMgr(""); setFSeg(""); setFSt(""); setFPay(""); setQuick(new Set()); setCard("all"); };
  const ddmmOf = (iso: string | null | undefined) => (iso ?? "").slice(5, 10).split("-").reverse().join(".");
  const ddmmyy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}` : "");

  /** 📤 Вивантажити CSV (макет 5609) — рівно показані рядки, у тому ж порядку. */
  const exportCsv = () => {
    const head = ["Клієнт", "Менеджер", "Команда", "Сегмент", "Стан", "Оплата", "Останнє замовлення, дн.", "Періодичність, дн.", "Остання розмова",
      "Середнє/міс", "Факт з рахунку", "± до середнього", "Всього грошей", "Замовляв цього міс.", "Маржа 6 міс", "Без роботи", "Що не так"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = sorted.map((c) => [c.clientName, c.managerName, c.teamName, c.segment, c.state, c.paymentType ?? "", c.lastOrderDays ?? "", c.periodDays ?? "",
      c.lastTalk ?? "", c.avg3, c.fact, c.delta, Math.round(c.lifetimeRevenue), c.orderedThisMonth ? "так" : "ні", c.margin6m ?? "",
      c.work.noWork ? "так" : "", flagsOf(c).map((f) => f.label).join("; ")].map(cell).join(","));
    const blob = new Blob(["﻿" + [head.map(cell).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `postiyni-kliienty-${data.month}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const renderRow = (c: ClientPlanRow) => {
  const isOpen = open === c.clientKey;
  /** Жовтий фон — рівно група «жовті» з сервера (активні, 30+ днів без замовлення); реактивацію підписує чип стану. */
  const risk = c.tabGroup === "yellow";
  const rec = playing === `talk:${c.clientKey}` && c.lastTalkRecording
    ? { src: c.lastTalkRecording, label: `розмова ${ddmmOf(c.lastTalk)}${c.lastTalkBy ? ` · ${c.lastTalkBy}` : ""}` }
    : null;
  const bg = isOpen ? "#eff6ff" : risk ? "#fffbeb" : "#fff";
  /** Клік по рядку — картка клієнта (макет); клік по кнопці чи полю всередині рядок не розгортає. */
  const toggle = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return; setOpen(isOpen ? null : c.clientKey); };
  return (
    <Fragment key={c.clientKey}>
      <tr style={{ background: risk ? "#fffbeb" : undefined, cursor: "pointer" }} onClick={toggle}>
        {/* 📌 «Робота» і назва клієнта закріплені зліва (ТЗ 5609, п.6). «Без роботи» — червона смуга (макет). */}
        <td style={{ ...S.td, ...STICKY_COL(0, W_WORK), background: bg, boxShadow: c.work.noWork ? "inset 4px 0 0 #dc2626" : undefined }}>
          {c.work.noWork
            ? <span style={S.chip("#dc2626", "#fff")} title={`${data.compare.noWorkDays} днів ні розмови в Ringostat, ні ручного контакту, і немає наступного кроку чи задачі з датою`}>Немає роботи</span>
            : <span style={S.chip("#dcfce7", "#166534")}>В роботі</span>}
        </td>
        <td style={{ ...S.td, ...STICKY_COL(W_WORK, W_NAME), background: bg }}>
          <div style={{ fontWeight: 700 }}>{c.clientName}</div>
          {/* 🔗 Приєднані — коротко «ще N назв», як у макеті 5609; повний перелік — у підказці й у картці клієнта. */}
          {c.merged && c.merged.length > 0 && (
            <div style={{ fontSize: 11, color: "#1d4ed8", marginTop: 2 }} title={`Обʼєднано в цього клієнта: ${c.merged.map((m) => m.name).join(", ")}`}>
              ще {c.merged.length} {c.merged.length === 1 ? "назва" : c.merged.length < 5 ? "назви" : "назв"}
            </div>
          )}
          <div style={{ marginTop: 3, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {c.pinned && <span style={S.chip("#f5f3ff", "#6d28d9")} title="закріплений за менеджером вручну">📌</span>}
            {c.forcedRegular && <ForcedBadge note={c.forceNote} />}
            {/* 💬 Коментар прямо тут: причину «чому не замовляє» видно, не розгортаючи рядок. */}
            <RowComment clientKey={c.clientKey} value={c.lastComment} canWrite onSaved={load} />
          </div>
        </td>
        <td style={S.td}>
          <div>{c.managerName}</div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>{c.teamName}</div>
        </td>
        <td style={S.td}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <SegmentBadge segment={c.segment} tip={data?.categoryRules?.segmentTips[c.segment]} />
            <StateChip state={c.state} rule={c.state === "sleeping" ? data?.categoryRules?.stateTips.sleeping : c.state === "lost" ? data?.categoryRules?.stateTips.lost : undefined} />
          </div>
          {c.paymentType && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{c.paymentType}</div>}
        </td>
        <td style={{ ...S.td, textAlign: "right" }}>
          <LastOrder days={c.lastOrderDays} />
          {c.lastInvoice && <div style={{ fontSize: 11, color: "#6b7280" }}>ост. рахунок {ddmmyy(c.lastInvoice)}</div>}
        </td>
        {/* 🔁 Періодичність — ПОРУЧ з «Останнє замовлення» (ТЗ п.5): «раз на 14 дн.», а поруч «79 дн. тому». */}
        <td style={{ ...S.td, textAlign: "right" }} title="Звичайна пауза між замовленнями клієнта (медіана; та сама, що визначає сегмент)">
          {c.periodDays == null ? <span style={{ color: "#9ca3af" }}>замало історії</span>
            : c.periodDays < 1 ? <span title="медіана паузи — менше доби: кілька замовлень в один день">кілька на день</span>
            : <span>раз на ~{Math.round(c.periodDays)} дн.</span>}
        </td>
        {/* 📱 Остання розмова (Ringostat) — з ▶; ручний контакт у месенджері й «＋ Контакт» — нижче. */}
        <td style={{ ...S.td, textAlign: "right", fontSize: 12 }}>
          {/* 🎧 ОСТАННЯ РОЗМОВА — ОДРАЗУ ПОСЛУХАТИ (ТЗ 22.09, п.3.3). Запис — з того самого рядка ядра, що й дата. */}
          {c.lastTalk && c.lastTalkRecording && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
              <span>{ddmmyy(c.lastTalk)}{c.lastTalkSec != null ? ` · ${fmtSec(c.lastTalkSec)}` : ""}</span>
              <button type="button" onClick={() => setPlaying(playing === `talk:${c.clientKey}` ? null : `talk:${c.clientKey}`)}
                title={playing === `talk:${c.clientKey}` ? "Згорнути плеєр" : "Послухати останню розмову"}
                style={{ border: "1px solid #2563eb", color: "#2563eb", background: "#fff", borderRadius: 999, width: 22, height: 22, cursor: "pointer", fontSize: 10, padding: 0 }}>
                {playing === `talk:${c.clientKey}` ? "⏹" : "▶"}
              </button>
            </div>
          )}
          {c.lastTalk && !c.lastTalkRecording && <div>{ddmmyy(c.lastTalk)}{c.lastTalkSec != null ? ` · ${fmtSec(c.lastTalkSec)}` : ""}</div>}
          {c.lastTalk
            ? <div style={{ fontSize: 11, color: "#6b7280" }}>{c.lastTalkDays} дн. тому{c.lastTalkBy ? ` · ${c.lastTalkBy}` : ""}</div>
            : <span style={S.chip("#fef2f2", "#b91c1c")}>не було</span>}
          {/* 📞 Дзвінків за ОБРАНИЙ місяць (п.3.3): розмови й усі дзвінки — два числа, не сума. */}
          <div style={{ fontSize: 11, color: "#374151" }} title="розмови (з відповіддю) / усі дзвінки за місяць екрана; ядро core/clientCalls.ts">
            📞 за {monthName}: {c.callsMonth.talks}/{c.callsMonth.calls}
          </div>
          {c.lastContact?.source === "manual" && (
            <div style={{ fontSize: 11 }} title={`ручний контакт: ${contactChannelLabel(c.lastContact.channel)}`}>
              📱 {c.lastContact.at.slice(0, 10).split("-").reverse().slice(0, 2).join(".")} · {contactChannelLabel(c.lastContact.channel)}
              {/* 📎 КНОПКА, А НЕ ПОЗНАЧКА (задача 4310, п.1.3): скрин відкривається з рядка. */}
              {c.lastContactHasFile && (
                <button type="button" title="Переглянути скрин"
                  onClick={() => setViewingFiles({ clientKey: c.clientKey, name: c.clientName ?? c.clientKey })}
                  style={{ marginLeft: 4, border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: 0 }}>📎</button>
              )}
            </div>
          )}
          {c.phone === "none" && <div style={{ fontSize: 11, color: "#b45309" }} title="у контактах клієнта немає жодного номера — дзвінки не привʼязуються">📵 нема номера</div>}
          {(c.attempts ?? 0) > 0 && <div style={{ color: "#b45309", fontSize: 11 }} title="дзвінки без відповіді після останньої розмови">недодзвонів {c.attempts}</div>}
          <button disabled={busy} style={{ ...S.btn(), marginTop: 4, fontSize: 11, padding: "2px 8px" }}
            title="Записати контакт у Viber/Telegram/email зі скрином"
            onClick={() => setContacting({ clientKey: c.clientKey, name: c.clientName })}>＋ Контакт</button>
        </td>
        <td style={{ ...S.td, textAlign: "right" }}>
          <Spark values={c.historyInv} months={data.historyMonths} />
          <div style={{ fontWeight: 600, marginTop: 2 }} title="середнє за 3 повні місяці перед місяцем екрана, гроші з рахунку">{c.avg3.toLocaleString("uk-UA")}</div>
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
        <td style={{ ...S.td, textAlign: "right" }}>{c.margin6m != null ? c.margin6m.toLocaleString("uk-UA") : <span style={{ color: "#9ca3af" }}>—</span>}</td>
        <td style={S.td}>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {flagsOf(c).map((f) => <span key={f.label} style={f.tone === "bad" ? S.chip("#fef2f2", "#b91c1c") : S.chip("#fef3c7", "#92400e")}>{f.label}</span>)}
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
          {c.nextStep && (
            <div style={{ fontSize: 12, color: c.nextStep.state === "overdue" ? "#b91c1c" : c.nextStep.state === "today" ? "#b45309" : "#374151" }}
              title={`наступний крок: ${c.nextStep.text}`}>
              {c.nextStep.text.length > 40 ? c.nextStep.text.slice(0, 40) + "…" : c.nextStep.text}
              <div style={{ fontSize: 11 }}>{c.nextStep.due ? `до ${ddmmOf(c.nextStep.due)}` : "без дати"}{c.nextStep.state === "overdue" ? " · прострочено" : ""}</div>
            </div>
          )}
          {/* 🔁 Задача реактивації в Задачнику: активним її не ставлять (збережено правило з колишньої вкладки). */}
          {c.taskId && c.taskStatus !== "done" ? (
            <div style={{ fontSize: 12, marginTop: c.nextStep ? 4 : 0 }}>
              <b>{c.taskAssignee ?? "—"}</b>
              {c.taskDeadline && <span style={{ color: "#b45309" }}> · до {c.taskDeadline.slice(5)}</span>}
              <div>
                <button disabled={busy} style={{ ...S.btn(), marginTop: 5, fontSize: 11, padding: "4px 9px" }}
                  onClick={() => setClosing({ taskId: c.taskId!, name: c.clientName })}>Закрити…</button>
              </div>
            </div>
          ) : c.state !== "active" && !c.seasonal ? (
            <button disabled={busy} style={{ ...S.btn(true), fontSize: 11, padding: "5px 10px", marginTop: c.nextStep ? 4 : 0,
                background: vipSleeping(c) && c.work.noTask ? "#dc2626" : "#111827" }}
              onClick={() => setCreating({ clientKey: c.clientKey, name: c.clientName })}>
              {vipSleeping(c) && c.work.noTask ? `Потрібна задача: ВІП ${c.daysSince ?? ""} дн.` : "＋ Задача"}
            </button>
          ) : !c.nextStep ? (
            <span style={{ color: "#9ca3af", fontSize: 12 }} title="наступний крок ставиться в картці клієнта (клік по рядку)">немає</span>
          ) : null}
        </td>
      </tr>
      {/* 🎧 ЗАПИС — ОКРЕМИМ РЯДКОМ НА ВСЮ ШИРИНУ ТАБЛИЦІ (задача 13.10.2026). Один плеєр — `RecordingPlayer`. */}
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
            {/* КАРТКА КЛІЄНТА (клік по рядку, макет): гроші по місяцях, дзвінки, наступний крок, обʼєднання; під нею — коментарі. */}
            <ClientCardPanel clientKey={c.clientKey} onChanged={load} month={month} />
            <div style={{ marginTop: 16, borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
              <CommentsPanel clientKey={c.clientKey} canWrite />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
  };

  const selStyle: React.CSSProperties = { fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff" };
  const groupHead = (title: string, n: number, sub: string, bad: boolean) => (
    <tr><td colSpan={colCount} style={{ ...S.td, background: bad ? "#fdecec" : "#f8fafc", fontSize: 12 }}>
      <b style={{ color: bad ? "#b91c1c" : "#111827" }}>{title} · {n}</b> <span style={{ color: "#6b7280" }}>{sub}</span>
    </td></tr>
  );

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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        <Card title="клієнтів у вибірці" value={String(cs.all)} on={card === "all"} onClick={() => setCard("all")}
          sub="постійні у вибраній вкладці й фільтрах" />
        <Card title="замовили цього місяця" value={String(cs.ordered)} tone="ok" on={card === "ordered"} onClick={() => setCard(toggleCard(card, "ordered"))}
          sub="угода місяця дійшла до «Виставлення рахунку» або далі" />
        <Card title="не замовили цього місяця" value={String(cs.notOrdered)} tone={cs.notOrdered ? "bad" : undefined} on={card === "notOrdered"}
          onClick={() => setCard(toggleCard(card, "notOrdered"))}
          sub={`замовляли в ${monLong(data.compare.before.from)}–${monLong(data.compare.before.to)}, цього місяця — ще ні`} />
        <Card title="плюс / мінус до середнього" value={signedUah(cs.delta)} tone={cs.delta < 0 ? "bad" : cs.delta > 0 ? "ok" : undefined}
          on={card === "more" || card === "less"}
          sub={data.compare.partial
            ? `з 1-го до сьогодні проти середнього за ті самі дні 3 попередніх місяців`
            : `місяць проти середнього за 3 попередні місяці`}>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {(["more", "less"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={card === k} onClick={() => setCard(toggleCard(card, k))}
                style={{ ...S.chip(card === k ? "#111827" : k === "more" ? "#dcfce7" : "#fef2f2", card === k ? "#fff" : k === "more" ? "#166534" : "#b91c1c"), border: "none", cursor: "pointer", fontSize: 11, padding: "3px 8px", whiteSpace: "normal", textAlign: "left" }}>
                {k === "more" ? `купили більше ${cs.more.n} · ${signedUah(cs.more.sum)}` : `купили менше ${cs.less.n} · ${signedUah(cs.less.sum)}`}
              </button>
            ))}
          </div>
        </Card>
        <Card title="без роботи" value={String(cs.noWork)} tone={cs.noWork ? "bad" : undefined} on={card === "noWork"}
          onClick={() => setCard(toggleCard(card, "noWork"))}
          sub={`${data.compare.noWorkDays}+ днів без контакту й кроку з датою: ${cs.noWorkOnly} · без задачі: ${cs.noTaskOnly}`} />
        <Card title="задача прострочена" value={String(cs.overdue)} tone={cs.overdue ? "warn" : undefined} on={card === "overdue"}
          onClick={() => setCard(toggleCard(card, "overdue"))} sub="дата задачі чи наступного кроку минула, а її не закрили" />
      </div>

      {/* 🔢 ТРИ ЦИФРИ РЕАКТИВАЦІЇ (ТЗ 3989, п.5) — лишились над вкладками. */}
      {t.react && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            ["в роботі (реактивація)", t.react.inWork, "сплячі + втрачені у вашому скоупі"],
            ["повернуто за місяць", t.react.returnedMonth, `перша оплата місяця після паузи ≥ ${t.react.gapDays} дн.`],
            ["повернутої маржі", formatAmountFull(t.react.returnedMargin), "Σ оплат цих клієнтів цього місяця (price = маржа)"],
          ].map(([label, val, hint]) => (
            <div key={String(label)} title={String(hint)} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "6px 12px", background: "#fff", minWidth: 140 }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{val}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── ВКЛАДКИ (ТЗ 22.09, п.3.1; лишились перемикачем — Роман 14.10.2026): фільтр одного списку */}
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

      {/* ── ПАНЕЛЬ ФІЛЬТРІВ (макет 5609) */}
      <div style={{ ...S.card, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук: клієнт, інша назва, менеджер, коментар"
          style={{ ...selStyle, flex: "1 1 260px", minWidth: 200 }} />
        {auth.role !== "manager" && (
          <select value={fTeam} onChange={(e) => { setFTeam(e.target.value ? Number(e.target.value) : ""); setFMgr(""); }} style={selStyle}>
            <option value="">Усі команди</option>
            {teamOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        {auth.role !== "manager" && (
          <select value={fMgr} onChange={(e) => setFMgr(e.target.value ? Number(e.target.value) : "")} style={selStyle}>
            <option value="">Усі менеджери</option>
            {mgrOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <select value={fSeg} onChange={(e) => setFSeg(e.target.value)} style={selStyle}>
          <option value="">Усі сегменти</option>
          {[["vip", "ВІП"], ["regular", "Регулярний"], ["episodic", "Епізодичний"], ["unknown", "Без історії"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={fSt} onChange={(e) => setFSt(e.target.value)} style={selStyle}>
          <option value="">Будь-який стан</option>
          {[["active", "Активний"], ["sleeping", "Сплячий"], ["lost", "Втрачений"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={fPay} onChange={(e) => setFPay(e.target.value)} style={selStyle}>
          <option value="">Будь-яка оплата</option>
          {payTypes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button type="button" onClick={resetFilters} style={S.btn()}>Скинути</button>
        <button type="button" onClick={exportCsv} style={S.btn()}>Вивантажити CSV</button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {QUICK.map((qf) => {
          const on = quick.has(qf.key);
          return (
            <button key={qf.key} type="button" title={qf.title} aria-pressed={on}
              onClick={() => setQuick((prev) => { const n = new Set(prev); on ? n.delete(qf.key) : n.add(qf.key); return n; })}
              style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                       border: `1px solid ${on ? "#111827" : "#d1d5db"}`, background: on ? "#111827" : "#fff", color: on ? "#fff" : "#374151" }}>{qf.label}</button>
          );
        })}
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
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "#6b7280" }}>
        <span>Показано {rows.length} з {data.clients.length}. Клік по рядку — картка клієнта; по заголовку колонки — сортування.</span>
        {/* ⓘ ДОВІДКА ПРАВИЛ (ТЗ 22.09, п.2.4). Текст складає ядро (`core/categoryRules.ts`); тут лише показ. */}
        {data.categoryRules && (
          <button type="button" onClick={() => setShowRules((v) => !v)} aria-expanded={showRules}
            style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, cursor: "pointer",
                     border: "1px solid #d1d5db", background: showRules ? "#eff6ff" : "#fff", color: "#1d4ed8" }}>
            ⓘ Як рахуються категорії
          </button>
        )}
      </div>

      {showRules && data.categoryRules && (
        <div style={{ ...S.card, fontSize: 12.5, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>ⓘ Як рахуються категорії клієнтів</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.categoryRules.text.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>Пороги беруться з тих самих правил, що рахують категорію, тож тут завжди актуальні числа.</div>
        </div>
      )}

      {/* ── ТАБЛИЦЯ */}
      {actErr && (
        <div role="alert" style={{ ...S.card, borderLeft: "3px solid #dc2626",
                                   color: "#b91c1c", fontSize: 13, fontWeight: 600, display: "flex", gap: 8, alignItems: "center" }}>
          <span>⚠️</span><span style={{ flex: 1 }}>{actErr}</span>
          <button onClick={() => setActErr(null)} title="сховати"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#b91c1c", fontSize: 15 }}>×</button>
        </div>
      )}
      {tab === "react" && data.reactRules && (
        <div style={{ ...S.card, fontSize: 12.5, color: "#4b5563", lineHeight: 1.55, borderLeft: "3px solid #6d28d9" }}>
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
         зверху, а «Робота» й «Клієнт» — зліва. */
      <div style={{ ...S.card, padding: 0, overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 1900 }}>
          <thead>
            <tr>
              {COLS.map((col, i) => (
                <th key={col.key} title={col.title} onClick={() => pickSort(col.key)}
                  style={{ ...S.th, ...STICKY_TH, ...(i === 0 ? STICKY_COL(0, W_WORK) : i === 1 ? STICKY_COL(W_WORK, W_NAME) : {}),
                           zIndex: i < 2 ? 3 : 2, cursor: "pointer", textAlign: col.num ? "right" : "left" }}>
                  {col.label}{sort.key === col.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* «Без роботи» — окремим блоком зверху, «В роботі» — під ним (макет 5609). */}
            {noWorkRows.length > 0 && groupHead("Без роботи", noWorkRows.length, `за ${data.compare.noWorkDays} днів ні розмови в телефонії, ні контакту в месенджерах, і немає наступного кроку з датою`, true)}
            {noWorkRows.map(renderRow)}
            {workRows.length > 0 && groupHead("В роботі", workRows.length, `з клієнтом був контакт за ${data.compare.noWorkDays} днів або стоїть наступний крок`, false)}
            {workRows.map(renderRow)}
            {rows.length === 0 && (
              <tr><td colSpan={colCount} style={{ ...S.td, color: "#9ca3af", textAlign: "center", padding: 24 }}>
                немає клієнтів під цей фільтр
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {/* 🌉 МІСТОК: число — РІВНО лічильник вкладки «Реактивація» (3 повні місяці без рахунку). */}
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

      {/* 🎯 РАЗОВІ названі числом: після кваліфікації база звузилась, і без цього рядка це читалось би як «клієнти зникли». */}
      {t.oneOff > 0 && (
        <div style={{ ...S.card, fontSize: 12, color: "#4b5563", lineHeight: 1.6 }}>
          <b>Разових: {t.oneOff}</b> — не проходять кваліфікацію постійного і тому не показані
          ні тут, ні в реактивації. Разовий не зник — він просто не постійний.
          {t.skippedGeneric > 0 && (
            <> {" "}Ще <b>{t.skippedGeneric}</b> сплячих і втрачених мають ключ-телефон без
            безготівкових оплат — фільтр реактивації їх не показує (це разові фізособи). Названі тут, щоб не зникли мовчки.</>
          )}
        </div>
      )}

      <div style={{ ...S.card, fontSize: 12, color: "#4b5563", lineHeight: 1.6 }}>
        <b>Як це рахується.</b> Факт — угоди, що в місяці вперше дійшли до «Виставлення рахунку»
        або будь-якого етапу далі (готівка без рахунку — з наступного етапу); програні не рахуються.
        Це факт саме цього екрана (ТЗ 22.09): Звіт і КВП рахують «успішно реалізовано», тож суми
        розходяться свідомо. Рахує ядро, не цей екран. <b>Історія</b> — ті самі гроші з рахунку по місяцях за пів року;
        <b> середнє/міс</b> — за {monLong(data.compare.before.from)}–{monLong(data.compare.before.to)}. <b>Плюс / мінус до
        середнього</b> — факт з 1-го до сьогодні проти середнього за ті самі дні трьох попередніх місяців. <b>Не замовили</b> —
        замовляли в трьох попередніх місяцях, цього — ще ні. <b>Без роботи</b> — {data.compare.noWorkDays} днів ні розмови в
        Ringostat, ні ручного контакту, і немає наступного кроку чи задачі з датою; у картці — разом із клієнтами без жодної
        задачі. <b>Всього грошей</b> — маржа успішних угод за весь час. Планів по клієнтах немає (регламент ред. 2). Клієнт =
        канонічний ключ: злиті телефони й назви рахуються разом.
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
