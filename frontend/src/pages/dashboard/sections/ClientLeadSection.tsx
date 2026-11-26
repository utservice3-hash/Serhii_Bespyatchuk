import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AuthPayload } from "../../../auth";
import { fetchClientPlans, createClientReactivationTask, type ClientPlansResp, type ClientPlanRow } from "../../../api";
import { SegmentBadge } from "./SegmentBadge";
import { RowComment } from "./RowComment";
import { CreateTaskDialog } from "./ReactivationBits";
import { openRecording, closeRecording, useDockSrc } from "./RecordingDock";
import { ClientCardPanel } from "./ClientCardPanel";
import { monthsLabel } from "./ClientSeasonBlock";
import { readLeadNav, leadNavSearch, backTarget, backIsHistoryBack, type LeadNav } from "../clientLeadNav";
import { HelpTip } from "./HelpTip";
import { leadGroupOf, pickRows, inTile, tileRows, applyLeadFilter, workSplit, leadFilterActive, overRhythm, noPhone, profileOpen, talkMatches, sortLead, TALK_AGE_DAYS, DEFAULT_LEAD_FILTER, type LeadSort, type LeadGroup, type LeadFilter, type LeadTile } from "../clientLeadView";

/**
 * 🚦 «З КИМ З ПОСТІЙНИХ ГОВОРИТИ» — ПРОСТИЙ ЕКРАН ТІМЛІДА (ТЗ Юлі 28.10.2026, етап 2; задача 7360).
 *
 * Вибір як у «Планах»: команда → менеджер → його клієнти у трьох групах. 🔴 ФРОНТ НЕ МАЄ ВЛАСНОГО ПРАВИЛА:
 * колір, «працюють», «передати іншому», «новий постійний» і «втратили» приходять із сервера (`row.lead`, ядро
 * `core/clientLeadRules.ts`). Тут лише групування й підсумки — підсумок рівня = сума його рядків.
 *
 * Дані — той самий `/client-plans`, що й таблиця «План місяця», тож клієнт на обох екранах один і той самий.
 */

type Row = ClientPlanRow;
const ym = () => new Date().toISOString().slice(0, 7);
const dm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "long", timeZone: "UTC" });

const COLOR = {
  green: { dot: "🟢", title: "Зелені", sub: "замовляють у своєму звичному ритмі", bg: "#f0fdf4", fg: "#166534", line: "#86efac" },
  yellow: { dot: "🟡", title: "Жовті", sub: "мали замовити за своїм ритмом, але не замовили", bg: "#fffbeb", fg: "#92400e", line: "#fcd34d" },
  red: { dot: "🔴", title: "Червоні", sub: "втрачені — 180+ днів без замовлення", bg: "#fef2f2", fg: "#991b1b", line: "#fca5a5" },
  // ⚠️ Задача 8350: з ними неможливо працювати — видно окремо, у лічильники менеджера не йдуть.
  problem: { dot: "⚠️", title: "Проблемні", sub: "з ними неможливо працювати — не рахуються в лічильниках менеджера, «Немає роботи» і «передати»", bg: "#fff7ed", fg: "#b45309", line: "#fdba74" },
} as const;
/** Група рядка — з `clientLeadView` (діюча позначка «Проблемний» переважає колір). */
const groupOf = leadGroupOf;
/** «ще 1 клієнт / 2 клієнти / 5 клієнтів» — спільний номер останньої розмови (задача 9061). */
function sharedLabel(n: number): string {
  // Позначка стоїть лише на розмові через спільний номер (≤5 клієнтів), але відмінювання — повне, про запас.
  const teen = [11, 12, 13, 14].includes(n % 100), m10 = n % 10;
  const w = !teen && m10 === 1 ? "клієнт" : !teen && [2, 3, 4].includes(m10) ? "клієнти" : "клієнтів";
  return `${String(n)} ${w}`;
}
const WORK_BY: Record<string, string> = { talk: "розмова", stage: "рух угоди", deal: "нова угода", order: "замовлення", comment: "коментар", contact: "контакт", payment: "оплата у Виписці", season: "не сезон (сезонний)" };
const SOURCE: Record<string, string> = { leadgen: "лідогенерація", ad: "реклама", manager: "менеджер" };

const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" } as const,
  th: { textAlign: "left", fontSize: 11, color: "#6b7280", fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" } as const,
  td: { padding: "9px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 13, verticalAlign: "top" } as const,
  chip: (bg: string, fg: string) => ({ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg, whiteSpace: "nowrap" } as const),
  btn: (primary?: boolean) => ({ fontSize: 12, fontWeight: primary ? 700 : 500, padding: "5px 10px", borderRadius: 8, cursor: "pointer",
    border: primary ? "none" : "1px solid #d1d5db", background: primary ? "#111827" : "#fff", color: primary ? "#fff" : "#374151" } as const),
};
/** 🧩 Заголовок списку за плиткою (місяць дописує екран: «Втратили за листопад»). */
const TILE = {
  newRepeat: { title: "Нові постійні", fg: "#166534" },
  lost: { title: "Втратили", fg: "#b91c1c" },
  handOver: { title: "Передати іншому менеджеру", fg: "#b91c1c" },
} as const;
/** Панель фільтрів над списком: підпис групи, перемикач «одне з», незалежний перемикач, увімкнений фільтр. */
const BAR = {
  cap: { fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase", color: "#6b7280", fontWeight: 600, marginBottom: 5 } as const,
  label: { fontSize: 12, color: "#6b7280" } as const,
  select: { fontSize: 12.5, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", color: "#111827" } as const,
  seg: { display: "inline-flex", flexWrap: "wrap", border: "1px solid #d1d5db", borderRadius: 8, overflow: "hidden", background: "#fff" } as const,
  // Роздільник — лівий край кнопки зі зсувом на піксель: у першої він ховається під рамкою перемикача.
  segBtn: { border: "none", borderLeft: "1px solid #e5e7eb", marginLeft: -1, padding: "5px 10px", fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap" } as const,
  tog: { border: "1px solid #d1d5db", borderRadius: 8, padding: "5px 10px", fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap" } as const,
  active: { border: "none", borderRadius: 999, padding: "2px 9px", fontSize: 12, fontWeight: 600, background: "#eef2ff", color: "#3730a3", cursor: "pointer" } as const,
};
/** Чип, якому можна переноситись: у вузькій колонці він не розпирає таблицю (рядок мусить вміщатись на екрані ноутбука). */
const WRAP_CHIP = { whiteSpace: "normal", borderRadius: 10 } as const;

/**
 * 📊 ПЕРІОДИЧНІСТЬ ЗАМОВЛЕНЬ ЗА 6 МІСЯЦІВ — ПРЯМО В РЯДКУ (11218; зустріч 25.11.2026). Стовпчик = скільки замовлень
 * (угод «з рахунку») було в місяці; число над стовпчиком, місяць під ним. Порожній місяць — крапка, а не пропуск:
 * саме дірки й показують, що клієнт збився з ритму. Гроші того ж місяця — у підказці.
 */
function OrderSpark({ counts, money, months }: { counts: number[]; money: number[]; months: string[] }) {
  const mx = Math.max(1, ...counts);
  const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("uk-UA", { month: "short", timeZone: "UTC" }).replace(".", "");
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div style={{ marginTop: 5 }} title={`замовлень «з рахунку» за 6 міс: ${total}\n${months.map((m, i) => `${mon(m)}: ${counts[i] ?? 0} · ${Math.round(money[i] ?? 0).toLocaleString("uk-UA")} ₴`).join("\n")}`}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3 }}>
        {months.map((m, i) => {
          const n = counts[i] ?? 0, last = i === months.length - 1;
          return (
            <div key={m} style={{ width: 20, textAlign: "center" }}>
              <div style={{ fontSize: 9, lineHeight: "10px", color: n ? "#111827" : "#9ca3af", fontWeight: n ? 700 : 400 }}>{n || "·"}</div>
              <div style={{ height: 22, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                <i style={{ display: "block", width: 12, height: n ? Math.max(3, Math.round((n / mx) * 22)) : 1, background: n ? (last ? "#1d4ed8" : "#93c5fd") : "#d1d5db", borderRadius: 1 }} />
              </div>
              <div style={{ fontSize: 9, lineHeight: "11px", color: last ? "#1d4ed8" : "#6b7280" }}>{mon(m)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ⏱ РИТМ КЛІЄНТА ПОРУЧ ІЗ «НЕ ЗАМОВЛЯВ N ДН.» (11228; зустріч 25.11.2026). Звичайний інтервал і ознака «пропустив свій
 * ритм» приходять із сервера (`lead.rhythm`, те саме правило, що колір) — тут лише підпис.
 */
function RhythmLine({ r }: { r: NonNullable<Row["lead"]["rhythm"]> }) {
  if (r.usualDays == null) {
    return <div style={{ fontSize: 11, color: "#9ca3af" }} title="звичайний інтервал рахується від другої оплати — у клієнта їх ще замало">звичайний ритм невідомий — замало оплат</div>;
  }
  const usual = r.usualDays < 1 ? "зазвичай замовляє щодня" : `зазвичай раз на ~${Math.round(r.usualDays)} дн.`;
  return (
    <div style={{ fontSize: 11, color: "#6b7280" }} title="звичайний інтервал клієнта — медіана між його оплатами (та сама, що визначає сегмент)">
      {usual}
      {r.over && (
        <span style={{ ...S.chip("#fee2e2", "#b91c1c"), marginLeft: 6 }} title="днів без замовлення більше, ніж звичайний інтервал клієнта — те саме правило, що робить його жовтим">
          ⏰ пропустив ритм{r.overDays != null ? ` на ${Math.round(r.overDays)} дн.` : ""}
        </span>
      )}
    </div>
  );
}

const uah = (v: number) => `${Math.round(v).toLocaleString("uk-UA")} ₴`;
/**
 * 📅 ОБОРОТ І ДОХІД КЛІЄНТА ЗА ЦЕЙ РІК (11219; зустріч 25.11.2026). Обидва числа — з успішно реалізованих угод року:
 * оборот — сума рахунків, дохід — маржа. Якщо в частини угод суми рахунку немає, оборот позначено «≥» і це названо.
 */
function YearMoney({ y }: { y: NonNullable<Row["yearMoney"]> }) {
  if (y.deals === 0) return <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }} title={`успішно реалізованих угод за ${y.year} рік немає`}>{y.year}: успішних угод не було</div>;
  const partial = y.missing > 0;
  return (
    <div style={{ fontSize: 11, color: "#374151", marginTop: 4, maxWidth: 170 }}
      title={`успішно реалізовані угоди за ${y.year} рік: ${y.deals}. Оборот — сума рахунків цих угод, дохід — маржа.${partial ? ` У ${y.missing} з них суми рахунку в CRM немає — оборот неповний.` : ""}`}>
      {y.year}: оборот <b>{partial ? "≥ " : ""}{uah(y.income)}</b> · дохід <b>{uah(y.revenue)}</b>
    </div>
  );
}

/** Підсумок набору рядків — одне місце для команди, менеджера й шапки. */
function stats(rows: Row[]) {
  const s = { all: rows.length, green: 0, yellow: 0, red: 0, problem: 0, working: 0, handOver: 0, newRepeat: 0, lost: 0,
    bySource: { leadgen: 0, ad: 0, manager: 0 } as Record<string, number> };
  for (const r of rows) {
    // ⚠️ Проблемний (8350) — лише своїм числом: не в кольорах, не в «працюють», не в «передати», не у «втратили».
    if (r.lead.problem) { s.problem++; continue; }
    s[r.lead.color]++;
    if (r.lead.color !== "green" && r.lead.works.yes) s.working++;
    // 🧩 Числа плиток — тим самим предикатом, яким будується список за плиткою (`inTile`): число = довжина списку.
    if (inTile(r, "handOver")) s.handOver++;
    if (inTile(r, "newRepeat")) { s.newRepeat++; s.bySource[r.lead.source]++; }
    if (inTile(r, "lost")) s.lost++;
  }
  return s;
}

/**
 * 🎯 Кнопка-колір (11227): клік показує клієнтів цього кольору в поточному охопленні (компанія, команда, менеджер);
 * повторний клік знімає вибір. Число — те саме, що й було, лише тепер на нього можна натиснути.
 */
function ColorPick({ color, n, pick, onPick }: { color: LeadGroup; n: number; pick: LeadGroup | null; onPick: (c: LeadGroup) => void }) {
  const m = COLOR[color], on = pick === color;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onPick(color); }} aria-pressed={on}
      title={on ? "показано цих клієнтів — натисніть, щоб зняти вибір" : `показати клієнтів: ${m.title.toLowerCase()}`}
      style={{ border: `1px solid ${on ? m.fg : m.line}`, background: on ? m.fg : m.bg, color: on ? "#fff" : m.fg, borderRadius: 999,
        padding: "2px 9px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
      {m.dot} {n}
    </button>
  );
}

/**
 * 🧩 Плитка-кнопка (запит Романа 26.11.2026): клік показує клієнтів, яких вона рахує, у поточному охопленні; повторний
 * клік знімає вибір. Плитка з нулем не натискається — показувати нічого; але вже обрана лишається кнопкою і з нулем
 * (змінили команду — у новій таких немає), інакше вибір не було б чим зняти на самій плитці.
 */
function TileButton({ tile, n, label, sub, tone, active, onTile }: {
  tile: LeadTile; n: number; label: string; sub: string; tone?: string; active: LeadTile | null; onTile: (t: LeadTile) => void;
}) {
  const on = active === tile;
  return (
    <button type="button" disabled={n === 0 && !on} aria-pressed={on} onClick={() => onTile(tile)}
      title={on ? "показано цих клієнтів — натисніть, щоб зняти вибір" : n === 0 ? "таких клієнтів зараз немає" : "показати цих клієнтів"}
      style={{ ...S.card, minWidth: 170, textAlign: "left", font: "inherit", color: "#111827", position: "relative", cursor: n === 0 && !on ? "default" : "pointer",
        display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start",
        ...(on ? { border: "2px solid #111827", padding: "11px 13px" } : {}) }}>
      {(n > 0 || on) && (
        <span style={{ position: "absolute", right: 10, top: 10, fontSize: 11, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap",
          border: `1px solid ${on ? "#111827" : "#e5e7eb"}`, background: on ? "#111827" : "#fff", color: on ? "#fff" : "#6b7280" }}>
          {on ? "✓ показано · зняти" : "показати ›"}
        </span>
      )}
      <div style={{ fontSize: 24, fontWeight: 800, color: tone ?? "#111827", lineHeight: 1.1 }}>{n}</div>
      <div style={{ fontSize: 13, marginTop: 3 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{sub}</div>
    </button>
  );
}

function Counters({ rows, month, pick, onPick, tile, onTile }: {
  rows: Row[]; month: string; pick: LeadGroup | null; onPick: (c: LeadGroup) => void; tile: LeadTile | null; onTile: (t: LeadTile) => void;
}) {
  const s = stats(rows);
  const src = (["leadgen", "ad", "manager"] as const).filter((k) => s.bySource[k] > 0).map((k) => `${SOURCE[k]} ${s.bySource[k]}`).join(" · ");
  const colors = (
    <span style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 2 }}>
      <ColorPick color="green" n={s.green} pick={pick} onPick={onPick} />
      <ColorPick color="yellow" n={s.yellow} pick={pick} onPick={onPick} />
      <ColorPick color="red" n={s.red} pick={pick} onPick={onPick} />
      {s.problem > 0 && <ColorPick color="problem" n={s.problem} pick={pick} onPick={onPick} />}
    </span>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
      <div style={{ ...S.card, minWidth: 170 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#111827", lineHeight: 1.1 }}>{s.all}</div>
        <div style={{ fontSize: 13, marginTop: 3 }}>постійних · натисніть колір</div>
        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{colors}</div>
      </div>
      <TileButton tile="newRepeat" n={s.newRepeat} label={`нових постійних за ${monthName(month)}`} sub={src ? `звідки: ${src}` : "друга оплата припала на цей місяць"} tone="#166534" active={tile} onTile={onTile} />
      <TileButton tile="lost" n={s.lost} label={`втратили за ${monthName(month)}`} sub="цього місяця минуло 180 днів без замовлення" tone={s.lost ? "#b91c1c" : undefined} active={tile} onTile={onTile} />
      <TileButton tile="handOver" n={s.handOver} label="передати іншому менеджеру" sub="дедлайн задачі минув, розмови не було" tone={s.handOver ? "#b91c1c" : undefined} active={tile} onTile={onTile} />
    </div>
  );
}

/** Рядок рівня «команда» або «менеджер»: кольори, скільки з жовтих і червоних у роботі, скільки передати. */
function LevelTable({ title, groups, onPick, onPickColor }: {
  title: string; groups: { id: number; name: string; rows: Row[] }[]; onPick: (id: number) => void;
  /** 🎯 11227: клік по числу кольору в рядку — клієнти цього кольору цієї команди / менеджера. */
  onPickColor: (id: number, color: LeadGroup) => void;
}) {
  const num = (id: number, color: LeadGroup, n: number, bold: boolean) => (
    <td style={{ ...S.td, textAlign: "right" }}>
      {n > 0
        ? <button type="button" onClick={(e) => { e.stopPropagation(); onPickColor(id, color); }} title={`показати клієнтів: ${COLOR[color].title.toLowerCase()}`}
            style={{ border: "none", background: "none", padding: "0 2px", cursor: "pointer", fontSize: 13, fontWeight: bold ? 700 : 500, color: COLOR[color].fg, textDecoration: "underline" }}>{n}</button>
        : <span style={{ color: "#9ca3af" }}>0</span>}
    </td>
  );
  return (
    <div style={{ ...S.card, padding: 0, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={S.th}>{title}</th><th style={{ ...S.th, textAlign: "right" }}>Постійних</th>
          <th style={{ ...S.th, textAlign: "right" }}>🟢</th><th style={{ ...S.th, textAlign: "right" }}>🟡</th><th style={{ ...S.th, textAlign: "right" }}>🔴</th>
          <th style={{ ...S.th, textAlign: "right" }} title="проблемні — з ними неможливо працювати; у цифри менеджера не йдуть">⚠️</th>
          <th style={{ ...S.th, textAlign: "right" }} title="з жовтих і червоних — тих, з ким працюють за вікно сегмента">Працюють з 🟡+🔴</th>
          <th style={{ ...S.th, textAlign: "right" }}>Передати</th>
        </tr></thead>
        <tbody>
          {groups.map((g) => {
            const s = stats(g.rows);
            return (
              <tr key={g.id} onClick={() => onPick(g.id)} style={{ cursor: "pointer" }}>
                <td style={{ ...S.td, fontWeight: 700, color: "#1d4ed8" }}>{g.name} ›</td>
                <td style={{ ...S.td, textAlign: "right" }}>{s.all}</td>
                {num(g.id, "green", s.green, false)}
                {num(g.id, "yellow", s.yellow, true)}
                {num(g.id, "red", s.red, true)}
                {num(g.id, "problem", s.problem, false)}
                <td style={{ ...S.td, textAlign: "right" }}>{s.working} з {s.yellow + s.red}</td>
                <td style={{ ...S.td, textAlign: "right", color: s.handOver ? "#b91c1c" : "#9ca3af", fontWeight: s.handOver ? 700 : 400 }}>{s.handOver}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ClientLeadSection({ auth }: { auth: AuthPayload }) {
  const [month] = useState(ym);
  const [data, setData] = useState<ClientPlansResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 🔙 Задача 9225: команда й менеджер — з адреси (`?team=&mgr=`), щоб посилання й «назад» браузера вели туди ж.
  const [team, setTeam] = useState<number | null>(() => readLeadNav(window.location.search, auth.role, auth.teamId).team);
  const [mgr, setMgr] = useState<number | null>(() => readLeadNav(window.location.search, auth.role, auth.teamId).mgr);
  const [open, setOpen] = useState<string | null>(null);
  const [showGreen, setShowGreen] = useState(false);
  // 🎯 11227: обраний колір (клієнти цього кольору в поточному охопленні) і фільтр списку. Перехід між рівнями їх не скидає.
  const [pick, setPick] = useState<LeadGroup | null>(null);
  // 🧩 Обрана плитка («нових», «втратили», «передати»). Плитка й колір — один вибір «кого показати»: одне знімає інше.
  const [tile, setTile] = useState<LeadTile | null>(null);
  const [filter, setFilter] = useState<LeadFilter>(DEFAULT_LEAD_FILTER);
  // ↕️ 11224: порядок списку — за грошима (як було), за давністю розмови або за днями без замовлення.
  const [sortBy, setSortBy] = useState<LeadSort>("money");
  const [creating, setCreating] = useState<{ clientKey: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const dockSrc = useDockSrc();
  const topRef = useRef<HTMLDivElement>(null);

  /**
   * Перехід між рівнями — окремий запис історії (`pushState`), тож «назад» браузера повертає на рівень вище.
   * Кнопка «← Назад» (`back`) там, де ми прийшли саме з того рівня, робить `history.back()`, а не новий запис.
   */
  const go = useCallback((nav: LeadNav, back = false) => {
    topRef.current?.scrollIntoView({ block: "start" });
    if (back && backIsHistoryBack(window.history.state, nav)) { window.history.back(); return; }
    setTeam(nav.team); setMgr(nav.mgr); setOpen(null);
    const u = new URL(window.location.href);
    const from = readLeadNav(u.search, auth.role, auth.teamId);
    window.history.pushState({ lead9225: { from } }, "", `${u.pathname}${leadNavSearch(u.search, nav)}${u.hash}`);
  }, [auth.role, auth.teamId]);
  useEffect(() => {
    const onPop = () => {
      const n = readLeadNav(window.location.search, auth.role, auth.teamId);
      setTeam(n.team); setMgr(n.mgr); setOpen(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [auth.role, auth.teamId]);

  const load = useCallback(() => {
    setErr(null);
    fetchClientPlans({ month }).then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, [month]);
  useEffect(load, [load]);

  if (err) return <div style={{ ...S.card, color: "#dc2626" }}>{err}</div>;
  if (!data) return <div style={{ ...S.card, color: "#6b7280" }}>завантаження…</div>;

  /** Постійні = кваліфіковані; рядок «лише через план» (разовий) сюди не йде. */
  const all = data.clients.filter((c) => c.state !== "oneoff");
  const isManager = auth.role === "manager";
  const teams = [...new Map(all.map((c) => [c.teamId ?? -1, c.teamName || "Без команди"])).entries()]
    .map(([id, name]) => ({ id, name, rows: all.filter((c) => (c.teamId ?? -1) === id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
  // Чужий чи застарілий `team=` в адресі (команди вже немає у видачі) → список команд, а не порожній екран.
  // Тімліду команду не перевіряємо: вона його власна, і порожня команда має лишатись порожньою, як досі.
  const teamEff = isManager || auth.role === "team_lead" || team == null || teams.some((t) => t.id === team) ? team : null;
  const teamRows = isManager ? all : teamEff == null ? all : all.filter((c) => (c.teamId ?? -1) === teamEff);
  const managers = [...new Map(teamRows.map((c) => [c.managerId, c.managerName])).entries()]
    .map(([id, name]) => ({ id, name, rows: teamRows.filter((c) => c.managerId === id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
  // Менеджер бачить лише своїх — вибирати нема з чого; інакше — список менеджера, коли його обрано.
  // Менеджера з адреси, якого немає в цій команді (звільнений, чужий), не відкриваємо — показуємо список менеджерів.
  const mgrEff = teamEff == null || mgr == null || !managers.some((m) => m.id === mgr) ? null : mgr;
  const mgrRows = isManager ? all : mgrEff == null ? null : teamRows.filter((c) => c.managerId === mgrEff);
  const teamName = teams.find((t) => t.id === teamEff)?.name;
  const mgrName = managers.find((m) => m.id === mgrEff)?.name;
  const back = backTarget({ team: teamEff, mgr: mgrEff }, auth.role);
  const backBtn = back && (
    <button type="button" onClick={() => go(back.nav, true)} style={{ ...S.btn(true), fontSize: 14, padding: "8px 16px" }}>{back.label}</button>
  );
  const scopeRows = mgrRows ?? teamRows;
  const togglePick = (c: LeadGroup) => { setOpen(null); setTile(null); setPick((p) => (p === c ? null : c)); };
  const toggleTile = (t: LeadTile) => { setOpen(null); setPick(null); setTile((p) => (p === t ? null : t)); };
  const clearShown = () => { setOpen(null); setPick(null); setTile(null); };
  /** Клієнти, які зараз у списку: обрана плитка або колір — у всьому охопленні; без вибору — клієнти обраного менеджера. */
  const baseRows = tile != null ? tileRows(scopeRows, tile) : pick != null ? pickRows(scopeRows, pick) : mgrRows ?? [];
  const listRows = applyLeadFilter(baseRows, filter);
  const scopeLabel = mgrEff != null ? mgrName ?? "менеджер" : teamEff != null ? teamName ?? "команда" : isManager ? "мої клієнти" : "уся компанія";

  const crumb = (
    <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
      {!isManager && auth.role !== "team_lead" && (
        <button type="button" onClick={() => go({ team: null, mgr: null })} style={{ ...S.btn(teamEff == null), padding: "3px 9px" }}>Усі команди</button>
      )}
      {!isManager && teamEff != null && <>
        {auth.role !== "team_lead" && <span style={{ color: "#9ca3af" }}>›</span>}
        <button type="button" onClick={() => go({ team: teamEff, mgr: null })} style={{ ...S.btn(mgrEff == null), padding: "3px 9px" }}>{teamName}</button>
      </>}
      {!isManager && mgrEff != null && <><span style={{ color: "#9ca3af" }}>›</span><b>{mgrName}</b></>}
    </div>
  );

  const playing = (c: Row) => !!c.lastTalkRecording && dockSrc === c.lastTalkRecording;
  const play = (c: Row) => (playing(c) ? closeRecording() : c.lastTalkRecording && openRecording({
    src: c.lastTalkRecording, label: `${c.clientName} · розмова ${dm(c.lastTalk)}${c.lastTalkBy ? ` · ${c.lastTalkBy}` : ""}` }));
  const taskOpen = (c: Row) => c.taskId != null && !["done", "cancelled"].includes(c.taskStatus ?? "");

  const clientRow = (c: Row) => {
    const L = c.lead, isOpen = open === c.clientKey, grey = { fontSize: 11, color: "#6b7280" };
    const toggle = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return; setOpen(isOpen ? null : c.clientKey); };
    return (
      <Fragment key={c.clientKey}>
        <tr onClick={toggle} style={{ cursor: "pointer", background: isOpen ? "#eff6ff" : undefined, boxShadow: `inset 4px 0 0 ${COLOR[groupOf(c)].line}` }}>
          <td style={{ ...S.td, minWidth: 220 }}>
            {/* назва буває одним «словом» на сотні символів (пошти й номери, злиті без пробілів) — без переносу вона розпирає таблицю за край екрана */}
            <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{c.clientName}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
              <SegmentBadge segment={c.segment} tip={data.categoryRules?.segmentTips[c.segment]} />
              {L.handOver && <span style={S.chip("#dc2626", "#fff")} title="дедлайн задачі на дзвінок минув, а розмови від 10 с після неї не було (правило Сергія). Передає тімлід.">⚠️ передати іншому менеджеру</span>}
              {L.problem && <span style={S.chip("#b45309", "#fff")} title={`«${L.problem.note}» — ${L.problem.byName ?? ""}, ${dm(L.problem.day)}`}>⚠️ Проблемний · {L.problem.label}</span>}
              {L.offSeason && <span style={S.chip("#eef2ff", "#4338ca")} title={`сезонний клієнт: возить ${monthsLabel(c.seasonMonths)} — зараз не сезон, дзвонити не треба`}>🌙 не сезон</span>}
              {L.newRepeat && <span style={S.chip("#dcfce7", "#166534")} title={`друга оплата — цього місяця · звідки: ${SOURCE[L.source]}`}>новий постійний</span>}
              {c.profile && c.profile.filled > 0 && (
                <span style={c.profile.filled === c.profile.total ? S.chip("#dcfce7", "#166534") : S.chip("#fffbeb", "#b45309")}
                  title="анкета клієнта: чим займається, як часто і скільки возить, яку частку возимо ми, міжнародні, авіа / море. Відкрийте клієнта, щоб прочитати або дописати">📋 анкета {c.profile.filled}/{c.profile.total}</span>
              )}
            </div>
            {!mgrRows && <div style={grey}>{c.managerName}{teamEff == null && c.teamName ? ` · ${c.teamName}` : ""}</div>}
          </td>
          <td style={S.td}>
            <div>{L.orderDays == null ? "замовлень не було" : L.orderDays === 0 ? "замовив сьогодні" : `не замовляв ${L.orderDays} дн.`}</div>
            <div style={grey} title="замовлення = рахунок («Виставлення рахунку» і далі) або оплата в CRM — що свіжіше">{L.lastOrder ? `останнє ${dm(L.lastOrder)}.${L.lastOrder.slice(2, 4)}` : ""}</div>
            {L.rhythm && <RhythmLine r={L.rhythm} />}
            {c.historyInvDeals && <OrderSpark counts={c.historyInvDeals} money={c.historyInv} months={data.historyMonths} />}
            {c.yearMoney && <YearMoney y={c.yearMoney} />}
          </td>
          <td style={S.td}>
            {L.problem
              ? <div style={{ fontSize: 12, maxWidth: 320 }}><b style={{ color: "#b45309" }}>{L.problem.label}</b>: «{L.problem.note}»<div style={grey}>{L.problem.byName ?? "—"}, {dm(L.problem.day)} · знімається сама, якщо клієнт знову замовить</div></div>
              : L.works.yes
              ? <span style={{ ...S.chip("#dcfce7", "#166534"), ...WRAP_CHIP }} title={`за ${L.works.windowDays} дн. (ритм сегмента) є робота`}>✅ працюють · {WORK_BY[L.works.by ?? ""]} {dm(L.works.at)}</span>
              : <span style={{ ...S.chip("#fef2f2", "#b91c1c"), ...WRAP_CHIP }} title="розмова від 10 с, нова угода чи рух угоди, замовлення, коментар, контакт або оплата у Виписці — нічого">роботи немає за {L.works.windowDays} дн.</span>}
          </td>
          <td style={{ ...S.td, minWidth: 170 }}>
            <RowComment clientKey={c.clientKey} value={c.lastComment} canWrite onSaved={load} />
          </td>
          <td style={{ ...S.td, minWidth: 200 }}>
            {c.lastTalk ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{dm(c.lastTalk)}.{c.lastTalk.slice(2, 4)}{c.lastTalkSec != null ? ` · ${Math.floor(c.lastTalkSec / 60)}:${String(c.lastTalkSec % 60).padStart(2, "0")}` : ""}</span>
                {c.lastTalkRecording && (
                  <button type="button" onClick={() => play(c)} title={playing(c) ? "Закрити плеєр" : "Послухати"}
                    style={{ border: "1px solid #2563eb", color: "#2563eb", background: "#fff", borderRadius: 999, width: 22, height: 22, cursor: "pointer", fontSize: 10, padding: 0 }}>
                    {playing(c) ? "⏹" : "▶"}
                  </button>
                )}
                {c.lastTalkDays != null && <span style={grey} title="скільки днів тому була остання розмова">{c.lastTalkDays === 0 ? "сьогодні" : `${c.lastTalkDays} дн. тому`}</span>}
                {c.lastTalkBy && <span style={grey}>{c.lastTalkBy}</span>}
              </div>
            ) : <span style={S.chip("#fef2f2", "#b91c1c")}>розмов не було</span>}
            {noPhone(c) && (
              <div style={{ marginTop: 4 }}>
                <span style={S.chip("#fffbeb", "#b45309")} title="у контактах клієнта в Kommo немає жодного номера — дзвінки до нього не привʼязуються. Додайте номер у контакт або компанію в Kommo">📵 нема номера</span>
              </div>
            )}
            {c.lastTalk && (c.lastTalkSharedWith ?? 0) > 0 && (
              <div style={{ marginTop: 4 }}>
                <span style={S.chip("#eff6ff", "#1d4ed8")}
                  title="номер цієї розмови є в контактах кількох клієнтів у Kommo — розмова могла бути й про іншого клієнта">
                  📞 спільний номер · ще {sharedLabel(c.lastTalkSharedWith ?? 0)}
                </span>
              </div>
            )}
            {L.summary
              ? <div style={{ fontSize: 12, marginTop: 4, color: "#374151" }} title="суть розмови — з AI-аналізу дзвінка">💬 {dm(L.summary.at)}: {L.summary.text.length > 160 ? `${L.summary.text.slice(0, 160)}…` : L.summary.text}</div>
              : c.lastTalk && <div style={{ ...grey, marginTop: 3 }}>суть: розмову не розбирав AI</div>}
          </td>
          <td style={S.td}>
            {taskOpen(c)
              ? <div style={{ fontSize: 12 }}>📞 {c.taskAssignee ?? "—"}{c.taskDeadline && <span style={{ color: L.handOver ? "#b91c1c" : "#b45309" }}> · до {dm(c.taskDeadline)}</span>}</div>
              : <button type="button" disabled={busy} style={S.btn(true)} onClick={() => setCreating({ clientKey: c.clientKey, name: c.clientName })}>📞 Задача на дзвінок</button>}
            {L.handOver && auth.role !== "manager" && (
              <button type="button" style={{ ...S.btn(), marginTop: 5, display: "block" }} onClick={() => setOpen(c.clientKey)}
                title="відкриває картку клієнта — там «Передати клієнта»">👤 Передати…</button>
            )}
          </td>
        </tr>
        {isOpen && (
          <tr><td colSpan={6} style={{ padding: "14px 16px", background: "#fbfdff", borderBottom: "1px solid #e5e7eb" }}>
            <ClientCardPanel clientKey={c.clientKey} onChanged={load} month={month} />
          </td></tr>
        )}
      </Fragment>
    );
  };

  const group = (color: keyof typeof COLOR, rows: Row[]) => {
    const m = COLOR[color];
    const sorted = sortLead(rows, sortBy);
    // Зелені згорнуті, поки їх не просили: обраний колір або увімкнений фільтр — це і є прохання.
    const hidden = color === "green" && !showGreen && pick == null && tile == null && !leadFilterActive(filter);
    return (
      <div key={color} style={{ ...S.card, padding: 0, overflowX: "auto", borderColor: m.line }}>
        <div style={{ padding: "10px 14px", background: m.bg, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ color: m.fg, fontSize: 15 }}>{m.dot} {m.title} · {rows.length}</b>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{m.sub}</span>
          {color !== "green" && color !== "problem" && <span style={{ fontSize: 12, color: "#374151" }}>· працюють: {rows.filter((r) => r.lead.works.yes).length} з {rows.length}</span>}
          {color === "green" && rows.length > 0 && pick == null && tile == null && !leadFilterActive(filter) && (
            <button type="button" onClick={() => setShowGreen((v) => !v)} style={{ ...S.btn(), marginLeft: "auto" }}>{showGreen ? "Сховати" : "Показати"}</button>
          )}
        </div>
        {!hidden && rows.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={S.th}>Клієнт</th><th style={S.th}>Замовлення</th><th style={S.th}>Робота з клієнтом</th>
              <th style={S.th}>Коментар менеджера — чому не замовляє</th><th style={S.th}>Остання розмова і суть</th><th style={S.th}>Задача</th>
            </tr></thead>
            <tbody>{sorted.map(clientRow)}</tbody>
          </table>
        )}
        {rows.length === 0 && <div style={{ padding: "10px 14px", fontSize: 12, color: "#6b7280" }}>немає</div>}
      </div>
    );
  };

  const showClients = isManager || mgrEff != null || pick != null || tile != null;
  const ws = workSplit(baseRows);
  const chosen = pick != null || tile != null;
  const shownTitle = tile != null ? (tile === "handOver" ? TILE[tile].title : `${TILE[tile].title} за ${monthName(month)}`)
    : pick != null ? `${COLOR[pick].dot} ${COLOR[pick].title}` : "Усі клієнти";
  const shownFg = tile != null ? TILE[tile].fg : pick != null ? COLOR[pick].fg : "#111827";
  /** Число поруч із назвою фільтра — світліше за назву: спершу читається «що», потім «скільки». */
  const cnt = (on: boolean, n: number) => <span style={{ marginLeft: 5, fontSize: 11.5, fontWeight: 500, color: on ? "#d1d5db" : "#6b7280" }}>{n}</span>;
  /** Варіант «одне з»: кнопки зліплені в один перемикач (`BAR.seg`). */
  const segBtn = (on: boolean, label: string, n: number | null, onClick: () => void, title?: string) => (
    <button key={label} type="button" onClick={onClick} aria-pressed={on} title={title}
      style={{ ...BAR.segBtn, background: on ? "#111827" : "#fff", color: on ? "#fff" : "#374151", fontWeight: on ? 700 : 500 }}>
      {label}{n != null && cnt(on, n)}
    </button>
  );
  /** Незалежний перемикач «лише ті, де…»: вмикається й вимикається сам, інших не чіпає. */
  const tog = (on: boolean, label: string, n: number, onClick: () => void, title: string) => (
    <button type="button" onClick={onClick} aria-pressed={on} title={title}
      style={{ ...BAR.tog, background: on ? "#111827" : "#fff", color: on ? "#fff" : "#374151", borderColor: on ? "#111827" : "#d1d5db", fontWeight: on ? 700 : 500 }}>
      {label}{cnt(on, n)}
    </button>
  );
  /** Увімкнені фільтри одним рядком під панеллю: кожен знімається своїм хрестиком. */
  const activeFilters: { label: string; off: () => void }[] = [
    ...(filter.work !== "all" ? [{ label: filter.work === "yes" ? "працюють" : "роботи немає", off: () => setFilter((f) => ({ ...f, work: "all" as const })) }] : []),
    ...(filter.talk !== "all" ? [{ label: filter.talk === "none" ? "розмов не було" : `розмова понад ${filter.talk} дн.`, off: () => setFilter((f) => ({ ...f, talk: "all" as const })) }] : []),
    ...(filter.overRhythm ? [{ label: "пропустили ритм", off: () => setFilter((f) => ({ ...f, overRhythm: false })) }] : []),
    ...(filter.profileOpen ? [{ label: "анкета не заповнена", off: () => setFilter((f) => ({ ...f, profileOpen: false })) }] : []),
    ...(filter.noPhone ? [{ label: "без номера", off: () => setFilter((f) => ({ ...f, noPhone: false })) }] : []),
  ];
  /**
   * 🎯 ПАНЕЛЬ НАД СПИСКОМ (11227; переверстано 26.11.2026 — Роман: «самі фільтри виглядать жахливо зроби щось зручніше»).
   * Верхній рядок — ЩО показано і чиє (команда, менеджер, порядок). Нижче три підписані групи: два вибори «одне з»
   * (робота, розмова) і незалежні перемикачі. Унизу — що з цього ввімкнено і скільки лишилось у списку.
   * Правила відбору ті самі (`clientLeadView`): змінився вигляд, а не числа.
   */
  const listBar = showClients && (
    <div style={{ ...S.card, padding: 0, fontSize: 13 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", borderBottom: "1px solid #f1f5f9" }}>
        <b style={{ fontSize: 15, color: shownFg }}>{shownTitle} · {baseRows.length}</b>
        <span style={{ fontSize: 12.5, color: "#6b7280" }}>{scopeLabel}</span>
        {chosen && <button type="button" onClick={clearShown} title="зняти вибір кольору чи плитки" style={{ ...S.btn(), padding: "3px 10px", borderRadius: 999 }}>✕ зняти вибір</button>}
        {chosen && !isManager && auth.role !== "team_lead" && (
          <label style={BAR.label}>Команда{" "}
            <select value={teamEff ?? ""} onChange={(e) => go({ team: e.target.value === "" ? null : Number(e.target.value), mgr: null })} style={BAR.select}>
              <option value="">усі</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {chosen && !isManager && teamEff != null && (
          <label style={BAR.label}>Менеджер{" "}
            <select value={mgrEff ?? ""} onChange={(e) => go({ team: teamEff, mgr: e.target.value === "" ? null : Number(e.target.value) })} style={BAR.select}>
              <option value="">усі</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}
        <label style={{ ...BAR.label, marginLeft: "auto" }}>Порядок{" "}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as LeadSort)} style={BAR.select}>
            <option value="money">за грошима клієнта</option>
            <option value="talk">давніша розмова зверху</option>
            <option value="order">довше без замовлення зверху</option>
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 22, alignItems: "flex-start", flexWrap: "wrap", padding: "10px 14px 12px" }}>
        <div>
          <div style={BAR.cap} title="робота за ритм сегмента: розмова від 10 с, рух угоди, коментар, контакт, оплата у Виписці">Робота з клієнтом</div>
          <span style={BAR.seg}>
            {segBtn(filter.work === "all", "усі", ws.all, () => setFilter((f) => ({ ...f, work: "all" })))}
            {segBtn(filter.work === "yes", "працюють", ws.yes, () => setFilter((f) => ({ ...f, work: "yes" })))}
            {segBtn(filter.work === "no", "роботи немає", ws.no, () => setFilter((f) => ({ ...f, work: "no" })))}
          </span>
        </div>
        <div>
          <div style={BAR.cap} title="остання розмова з клієнтом у телефонії (без номерів перевізників)">Остання розмова</div>
          <span style={BAR.seg}>
            {segBtn(filter.talk === "all", "будь-коли", null, () => setFilter((f) => ({ ...f, talk: "all" })))}
            {TALK_AGE_DAYS.map((d) => segBtn(filter.talk === d, `понад ${d} дн.`, baseRows.filter((r) => talkMatches(r, d)).length,
              () => setFilter((f) => ({ ...f, talk: d })), `без розмови понад ${d} днів, включно з тими, з ким не говорили ніколи`))}
            {segBtn(filter.talk === "none", "не було", baseRows.filter((r) => talkMatches(r, "none")).length, () => setFilter((f) => ({ ...f, talk: "none" })), "розмов із клієнтом не було взагалі")}
          </span>
        </div>
        <div>
          <div style={BAR.cap}>Лише ті, де</div>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {tog(filter.overRhythm, "⏰ пропустили ритм", baseRows.filter(overRhythm).length, () => setFilter((f) => ({ ...f, overRhythm: !f.overRhythm })),
              "днів без замовлення більше, ніж звичайний інтервал клієнта")}
            {tog(filter.profileOpen, "📋 анкета не заповнена", baseRows.filter(profileOpen).length, () => setFilter((f) => ({ ...f, profileOpen: !f.profileOpen })),
              "анкета клієнта (пʼять питань у картці) не заповнена до кінця або її немає зовсім")}
            {tog(filter.noPhone, "📵 без номера", baseRows.filter(noPhone).length, () => setFilter((f) => ({ ...f, noPhone: !f.noPhone })),
              "у контактах клієнта в Kommo немає жодного номера — розмови з ним не привʼязуються")}
          </span>
        </div>
      </div>
      {leadFilterActive(filter) && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 14px", borderTop: "1px solid #f1f5f9", background: "#fafafa", borderRadius: "0 0 10px 10px", fontSize: 12.5 }}>
          <b>У списку {listRows.length} з {baseRows.length}</b>
          {activeFilters.map((a) => (
            <button key={a.label} type="button" onClick={a.off} title="зняти цей фільтр" style={BAR.active}>{a.label} ✕</button>
          ))}
          <button type="button" onClick={() => setFilter(DEFAULT_LEAD_FILTER)} style={{ ...S.btn(), padding: "2px 9px", borderRadius: 999 }}>✕ скинути всі</button>
        </div>
      )}
    </div>
  );
  return (
    <div ref={topRef} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>
          З ким з постійних говорити
          <HelpTip label="Як рахується колір і «працюють»">
            <b>Колір</b> — лише від замовлення (рахунок або оплата в CRM) і звичного ритму клієнта: ВІП 14 днів, регулярний 30, епізодичний і без історії 60; червоний — 180.
            <br /><b>«Працюють»</b> — розмова від 10 с, рух угоди, коментар, контакт або оплата у Виписці за ритм сегмента; колір від цього не змінюється.
          </HelpTip>
        </h2>
      </div>
      {/* 🔙 9225: помітна кнопка «назад» поруч із ланцюжком — ланцюжок на кнопку не схожий, тімлід його не впізнав. */}
      {!isManager && <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>{backBtn}{crumb}</div>}
      <Counters rows={scopeRows} month={month} pick={pick} onPick={togglePick} tile={tile} onTile={toggleTile} />
      {actErr && <div role="alert" style={{ ...S.card, color: "#b91c1c", fontWeight: 600 }}>⚠️ {actErr}</div>}
      {/* 🎯 11227: з обраним кольором чи плиткою таблицю рівня не показуємо — на її місці список цих клієнтів. */}
      {!isManager && pick == null && tile == null && teamEff == null && <LevelTable title="Команда" groups={teams} onPick={(id) => go({ team: id, mgr: null })}
        onPickColor={(id, color) => { setPick(color); go({ team: id, mgr: null }); }} />}
      {!isManager && pick == null && tile == null && teamEff != null && mgrEff == null && <LevelTable title="Менеджер" groups={managers} onPick={(id) => go({ team: teamEff, mgr: id })}
        onPickColor={(id, color) => { setPick(color); go({ team: teamEff, mgr: id }); }} />}
      {listBar}
      {/* ⚠️ «Проблемні» (8350) — між червоними й зеленими, і лише коли вони є (порожня група нічого не каже). */}
      {showClients && (["yellow", "red", "problem", "green"] as const)
        .filter((k) => (pick != null ? k === pick : tile != null ? listRows.some((c) => groupOf(c) === k) : k !== "problem" || listRows.some((c) => groupOf(c) === "problem")))
        .map((k) => group(k, listRows.filter((c) => (k === "problem" ? c.lead.problem != null : !c.lead.problem && c.lead.color === k))))}
      {showClients && tile != null && listRows.length === 0 && (
        <div style={{ ...S.card, fontSize: 13, color: "#6b7280" }}>{leadFilterActive(filter) ? "За цими фільтрами нікого немає." : "Таких клієнтів тут немає."}</div>
      )}
      {/* Список клієнтів довгий: після прокрутки верхньої кнопки вже не видно — та сама кнопка внизу. */}
      {showClients && backBtn && <div>{backBtn}</div>}
      {creating && (
        <CreateTaskDialog client={creating} busy={busy} error={actErr}
          onCancel={() => { setCreating(null); setActErr(null); }}
          onSubmit={async (deadline, comment) => {
            setBusy(true); setActErr(null);
            try { await createClientReactivationTask({ clientKey: creating.clientKey, deadline, comment: comment || "Подзвонити клієнту" }); setCreating(null); load(); }
            catch (e) { setActErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? "Задачу НЕ створено: сервер відмовив."); }
            finally { setBusy(false); }
          }} />
      )}
    </div>
  );
}
