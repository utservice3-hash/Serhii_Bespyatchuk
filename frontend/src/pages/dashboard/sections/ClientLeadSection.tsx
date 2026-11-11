import { Fragment, useCallback, useEffect, useState } from "react";
import type { AuthPayload } from "../../../auth";
import { fetchClientPlans, createClientReactivationTask, type ClientPlansResp, type ClientPlanRow } from "../../../api";
import { SegmentBadge } from "./SegmentBadge";
import { RowComment } from "./RowComment";
import { CreateTaskDialog } from "./ReactivationBits";
import { openRecording, closeRecording, useDockSrc } from "./RecordingDock";
import { ClientCardPanel } from "./ClientCardPanel";
import { monthsLabel } from "./ClientSeasonBlock";

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
/** Група рядка: діюча позначка «Проблемний» (8350) переважає колір. */
const groupOf = (r: Row): keyof typeof COLOR => (r.lead.problem ? "problem" : r.lead.color);
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

/** Підсумок набору рядків — одне місце для команди, менеджера й шапки. */
function stats(rows: Row[]) {
  const s = { all: rows.length, green: 0, yellow: 0, red: 0, problem: 0, working: 0, handOver: 0, newRepeat: 0, lost: 0,
    bySource: { leadgen: 0, ad: 0, manager: 0 } as Record<string, number> };
  for (const r of rows) {
    // ⚠️ Проблемний (8350) — лише своїм числом: не в кольорах, не в «працюють», не в «передати», не у «втратили».
    if (r.lead.problem) { s.problem++; continue; }
    s[r.lead.color]++;
    if (r.lead.color !== "green" && r.lead.works.yes) s.working++;
    if (r.lead.handOver) s.handOver++;
    if (r.lead.newRepeat) { s.newRepeat++; s.bySource[r.lead.source]++; }
    if (r.lead.lostThisMonth) s.lost++;
  }
  return s;
}

function Counters({ rows, month }: { rows: Row[]; month: string }) {
  const s = stats(rows);
  const src = (["leadgen", "ad", "manager"] as const).filter((k) => s.bySource[k] > 0).map((k) => `${SOURCE[k]} ${s.bySource[k]}`).join(" · ");
  const box = (value: number, label: string, sub?: string, tone?: string) => (
    <div style={{ ...S.card, minWidth: 170 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone ?? "#111827", lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 13, marginTop: 3 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
      {box(s.all, "постійних", `🟢 ${s.green} · 🟡 ${s.yellow} · 🔴 ${s.red}${s.problem ? ` · ⚠️ ${s.problem}` : ""}`)}
      {box(s.newRepeat, `нових постійних за ${monthName(month)}`, src ? `звідки: ${src}` : "друга оплата припала на цей місяць", "#166534")}
      {box(s.lost, `втратили за ${monthName(month)}`, "цього місяця минуло 180 днів без замовлення", s.lost ? "#b91c1c" : undefined)}
      {box(s.handOver, "передати іншому менеджеру", "дедлайн задачі минув, розмови не було", s.handOver ? "#b91c1c" : undefined)}
    </div>
  );
}

/** Рядок рівня «команда» або «менеджер»: кольори, скільки з жовтих і червоних у роботі, скільки передати. */
function LevelTable({ title, groups, onPick }: { title: string; groups: { id: number; name: string; rows: Row[] }[]; onPick: (id: number) => void }) {
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
                <td style={{ ...S.td, textAlign: "right", color: COLOR.green.fg }}>{s.green}</td>
                <td style={{ ...S.td, textAlign: "right", color: COLOR.yellow.fg, fontWeight: 700 }}>{s.yellow}</td>
                <td style={{ ...S.td, textAlign: "right", color: COLOR.red.fg, fontWeight: 700 }}>{s.red}</td>
                <td style={{ ...S.td, textAlign: "right", color: s.problem ? COLOR.problem.fg : "#9ca3af" }}>{s.problem}</td>
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
  const [team, setTeam] = useState<number | null>(() => (auth.role === "team_lead" && auth.teamId != null ? auth.teamId : null));
  const [mgr, setMgr] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showGreen, setShowGreen] = useState(false);
  const [creating, setCreating] = useState<{ clientKey: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const dockSrc = useDockSrc();

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
  const teamRows = isManager ? all : team == null ? all : all.filter((c) => (c.teamId ?? -1) === team);
  const managers = [...new Map(teamRows.map((c) => [c.managerId, c.managerName])).entries()]
    .map(([id, name]) => ({ id, name, rows: teamRows.filter((c) => c.managerId === id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
  // Менеджер бачить лише своїх — вибирати нема з чого; інакше — список менеджера, коли його обрано.
  const mgrRows = isManager ? all : mgr == null ? null : teamRows.filter((c) => c.managerId === mgr);
  const teamName = teams.find((t) => t.id === team)?.name;
  const mgrName = managers.find((m) => m.id === mgr)?.name;
  const scopeRows = mgrRows ?? teamRows;

  const crumb = (
    <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
      {!isManager && auth.role !== "team_lead" && (
        <button type="button" onClick={() => { setTeam(null); setMgr(null); }} style={{ ...S.btn(team == null), padding: "3px 9px" }}>Усі команди</button>
      )}
      {!isManager && team != null && <>
        <span style={{ color: "#9ca3af" }}>›</span>
        <button type="button" onClick={() => setMgr(null)} style={{ ...S.btn(mgr == null), padding: "3px 9px" }}>{teamName}</button>
      </>}
      {!isManager && mgr != null && <><span style={{ color: "#9ca3af" }}>›</span><b>{mgrName}</b></>}
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
            <div style={{ fontWeight: 700 }}>{c.clientName}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
              <SegmentBadge segment={c.segment} tip={data.categoryRules?.segmentTips[c.segment]} />
              {L.handOver && <span style={S.chip("#dc2626", "#fff")} title="дедлайн задачі на дзвінок минув, а розмови від 10 с після неї не було (правило Сергія). Передає тімлід.">⚠️ передати іншому менеджеру</span>}
              {L.problem && <span style={S.chip("#b45309", "#fff")} title={`«${L.problem.note}» — ${L.problem.byName ?? ""}, ${dm(L.problem.day)}`}>⚠️ Проблемний · {L.problem.label}</span>}
              {L.offSeason && <span style={S.chip("#eef2ff", "#4338ca")} title={`сезонний клієнт: возить ${monthsLabel(c.seasonMonths)} — зараз не сезон, дзвонити не треба`}>🌙 не сезон</span>}
              {L.newRepeat && <span style={S.chip("#dcfce7", "#166534")} title={`друга оплата — цього місяця · звідки: ${SOURCE[L.source]}`}>новий постійний</span>}
            </div>
            {!mgrRows && <div style={grey}>{c.managerName}</div>}
          </td>
          <td style={S.td}>
            <div>{L.orderDays == null ? "замовлень не було" : L.orderDays === 0 ? "замовив сьогодні" : `не замовляв ${L.orderDays} дн.`}</div>
            <div style={grey} title="замовлення = рахунок («Виставлення рахунку» і далі) або оплата — що свіжіше">{L.lastOrder ? `останнє ${dm(L.lastOrder)}.${L.lastOrder.slice(2, 4)}` : ""}</div>
          </td>
          <td style={S.td}>
            {L.problem
              ? <div style={{ fontSize: 12, maxWidth: 320 }}><b style={{ color: "#b45309" }}>{L.problem.label}</b>: «{L.problem.note}»<div style={grey}>{L.problem.byName ?? "—"}, {dm(L.problem.day)} · знімається сама, якщо клієнт знову замовить</div></div>
              : L.works.yes
              ? <span style={S.chip("#dcfce7", "#166534")} title={`за ${L.works.windowDays} дн. (ритм сегмента) є робота`}>✅ працюють · {WORK_BY[L.works.by ?? ""]} {dm(L.works.at)}</span>
              : <span style={S.chip("#fef2f2", "#b91c1c")} title="розмова від 10 с, нова угода чи рух угоди, замовлення, коментар, контакт або оплата у Виписці — нічого">роботи немає за {L.works.windowDays} дн.</span>}
          </td>
          <td style={{ ...S.td, minWidth: 220 }}>
            <RowComment clientKey={c.clientKey} value={c.lastComment} canWrite onSaved={load} />
          </td>
          <td style={{ ...S.td, minWidth: 240 }}>
            {c.lastTalk ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{dm(c.lastTalk)}.{c.lastTalk.slice(2, 4)}{c.lastTalkSec != null ? ` · ${Math.floor(c.lastTalkSec / 60)}:${String(c.lastTalkSec % 60).padStart(2, "0")}` : ""}</span>
                {c.lastTalkRecording && (
                  <button type="button" onClick={() => play(c)} title={playing(c) ? "Закрити плеєр" : "Послухати"}
                    style={{ border: "1px solid #2563eb", color: "#2563eb", background: "#fff", borderRadius: 999, width: 22, height: 22, cursor: "pointer", fontSize: 10, padding: 0 }}>
                    {playing(c) ? "⏹" : "▶"}
                  </button>
                )}
                {c.lastTalkBy && <span style={grey}>{c.lastTalkBy}</span>}
              </div>
            ) : <span style={S.chip("#fef2f2", "#b91c1c")}>розмов не було</span>}
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
    const sorted = [...rows].sort((a, b) => Number(b.lead.handOver) - Number(a.lead.handOver) || b.lifetimeRevenue - a.lifetimeRevenue);
    const hidden = color === "green" && !showGreen;
    return (
      <div key={color} style={{ ...S.card, padding: 0, overflowX: "auto", borderColor: m.line }}>
        <div style={{ padding: "10px 14px", background: m.bg, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ color: m.fg, fontSize: 15 }}>{m.dot} {m.title} · {rows.length}</b>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{m.sub}</span>
          {color !== "green" && color !== "problem" && <span style={{ fontSize: 12, color: "#374151" }}>· працюють: {rows.filter((r) => r.lead.works.yes).length} з {rows.length}</span>}
          {color === "green" && rows.length > 0 && (
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

  const showClients = isManager || mgr != null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>З ким з постійних говорити</h2>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          Колір — лише від замовлення (рахунок або оплата) і звичного ритму клієнта: ВІП 14 днів, регулярний 30, епізодичний і без історії 60; червоний — 180.
          «Працюють» — розмова від 10 с, рух угоди, коментар, контакт або оплата у Виписці за ритм сегмента; колір від цього не змінюється.
        </div>
      </div>
      {!isManager && crumb}
      <Counters rows={scopeRows} month={month} />
      {actErr && <div role="alert" style={{ ...S.card, color: "#b91c1c", fontWeight: 600 }}>⚠️ {actErr}</div>}
      {!isManager && team == null && <LevelTable title="Команда" groups={teams} onPick={(id) => { setTeam(id); setMgr(null); }} />}
      {!isManager && team != null && mgr == null && <LevelTable title="Менеджер" groups={managers} onPick={setMgr} />}
      {/* ⚠️ «Проблемні» (8350) — між червоними й зеленими, і лише коли вони є (порожня група нічого не каже). */}
      {showClients && (["yellow", "red", "problem", "green"] as const)
        .filter((k) => k !== "problem" || (mgrRows ?? []).some((c) => groupOf(c) === "problem"))
        .map((k) => group(k, (mgrRows ?? []).filter((c) => (k === "problem" ? c.lead.problem != null : !c.lead.problem && c.lead.color === k))))}
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
