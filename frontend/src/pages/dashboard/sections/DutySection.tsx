import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchDutySchedule, assignDuty, removeDuty, fetchTeams,
  createAbsence, decideAbsence, removeAbsence, createHoliday, removeHoliday,
  type DutySchedule, type Absence, type AbsenceKind, type Team,
} from "../../../api";

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MON_SHORT = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const pad = (n: number) => String(n).padStart(2, "0");

// Палітра типів (1:1 з макетом): чергування — фіолет; відпустка — зелений; лікарняний —
// бурштин; вихідний — сірий; скорочений — синій.
type CalKind = "duty" | AbsenceKind;
const KIND: Record<CalKind, { label: string; short: string; bg: string; fg: string; dot: string; icon: string }> = {
  duty: { label: "Чергування", short: "чергування", bg: "#ede9fe", fg: "#6d28d9", dot: "#8b5cf6", icon: "🛡" },
  vacation: { label: "Відпустка", short: "відпустка", bg: "#dcfce7", fg: "#15803d", dot: "#16a34a", icon: "🏖" },
  sick: { label: "Лікарняний", short: "лікарняний", bg: "#fef3c7", fg: "#b45309", dot: "#f59e0b", icon: "🤒" },
  day_off: { label: "Вихідний", short: "вихідний", bg: "#f3f4f6", fg: "#4b5563", dot: "#9ca3af", icon: "🌙" },
  short_day: { label: "Скорочений", short: "скороч.", bg: "#dbeafe", fg: "#1d4ed8", dot: "#3b82f6", icon: "⏱" },
};
const LEGEND: CalKind[] = ["duty", "vacation", "sick", "day_off", "short_day"];
const SHIFT_LABEL: Record<string, string> = { day: "Весь день", evening: "Вечір 18–21", weekend: "Вихідний" };

const iso = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const colOf = (date: string) => (new Date(date + "T00:00:00").getDay() + 6) % 7; // Пн=0..Нд=6
const ddmm = (date: string) => date.slice(8, 10);
const rangeLabel = (a: Absence) => {
  const s = a.startDate, e = a.endDate;
  const mon = MON_SHORT[Number(e.slice(5, 7)) - 1];
  return `${ddmm(s)}-${ddmm(e)} ${mon}`;
};

/** Mon-first grid of weeks covering the whole month (leading/trailing blanks). */
function monthGrid(year: number, month0: number): (string | null)[][] {
  const first = new Date(year, month0, 1);
  const startDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(iso(year, month0, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// Позначка статусу відсутності: pending → ⏳ (пунктир); approved → ✓ (суцільна).
const statusMark = (s: string) => (s === "pending" ? "⏳" : s === "approved" ? "✓" : "✗");
const isPending = (s: string) => s === "pending";

export function DutySection({ role }: { role?: string }) {
  const now = new Date();
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [teamId, setTeamId] = useState<number | "">("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [data, setData] = useState<DutySchedule | null>(null);
  const [openDay, setOpenDay] = useState<{ from: string; to: string } | null>(null);
  const [showApprovals, setShowApprovals] = useState(false);
  const [reload, setReload] = useState(0);

  const isAdmin = role === "admin";
  const isApprover = role === "admin" || role === "team_lead";
  const from = iso(view.y, view.m, 1);
  const to = iso(view.y, view.m, new Date(view.y, view.m + 1, 0).getDate());
  const todayStr = iso(now.getFullYear(), now.getMonth(), now.getDate());

  useEffect(() => { if (isAdmin) fetchTeams().then(setTeams).catch(() => setTeams([])); }, [isAdmin]);
  useEffect(() => {
    fetchDutySchedule({ from, to, teamId: isAdmin && teamId ? Number(teamId) : undefined })
      .then(setData).catch(() => setData(null));
  }, [from, to, teamId, isAdmin, reload]);

  const weeks = monthGrid(view.y, view.m);
  const canEditDuty = data?.canEdit ?? false;
  const pendingCount = data?.pendingCount ?? 0;
  const changed = () => setReload((r) => r + 1);

  // Поденні позначки в клітинці: чергування + ОДНОДЕННІ відсутності (start==end).
  // Багатоденні (vacation/sick, start<end) — смугами-бендами над тижнем.
  const perDay = useMemo(() => {
    type Item = { key: string; kind: CalKind; name: string; label: string; status: string; mine: boolean; team?: string | null };
    const map = new Map<string, Item[]>();
    const push = (date: string, item: Item) => {
      if (!map.has(date)) map.set(date, []); map.get(date)!.push(item);
    };
    // Чергування — тімлід бачить ВСІ команди (координація); підпис несе команду (name + team).
    for (const a of data?.assignments ?? []) push(a.date, {
      key: "d" + a.id, kind: "duty", name: a.managerName, label: a.note?.trim() || KIND.duty.short, status: "approved", mine: a.mine, team: a.teamName,
    });
    for (const ab of data?.absences ?? []) {
      if (ab.status === "rejected") continue;
      if (ab.startDate === ab.endDate) {
        const short = ab.kind === "short_day" && ab.hours ? `${KIND.short_day.short} −${ab.hours}год` : KIND[ab.kind].short;
        push(ab.startDate, { key: "a" + ab.id, kind: ab.kind, name: ab.managerName, label: short, status: ab.status, mine: ab.mine });
      }
    }
    return map;
  }, [data]);

  // Бенди багатоденних відсутностей по тижнях (кліп у межах тижня).
  const bandsByWeek = useMemo(() => {
    const ranges = (data?.absences ?? []).filter((a) => a.status !== "rejected" && a.startDate < a.endDate);
    return weeks.map((week) => {
      const days = week.filter(Boolean) as string[];
      if (!days.length) return [];
      const wStart = days[0], wEnd = days[days.length - 1];
      const out: { a: Absence; startCol: number; endCol: number }[] = [];
      for (const a of ranges) {
        if (a.startDate > wEnd || a.endDate < wStart) continue;
        const s = a.startDate > wStart ? a.startDate : wStart;
        const e = a.endDate < wEnd ? a.endDate : wEnd;
        out.push({ a, startCol: colOf(s), endCol: colOf(e) });
      }
      return out;
    });
  }, [data, weeks]);

  function shiftMonth(delta: number) {
    setView((v) => { const nm = v.m + delta; return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }; });
  }

  // Протягування діапазону (Натисни день або протягни діапазон).
  const drag = useRef<{ start: string | null; end: string | null }>({ start: null, end: null });
  const [dragBox, setDragBox] = useState<{ start: string; end: string } | null>(null);
  const onCellDown = (date: string) => { drag.current = { start: date, end: date }; setDragBox({ start: date, end: date }); };
  const onCellEnter = (date: string) => { if (drag.current.start) { drag.current.end = date; setDragBox({ start: drag.current.start, end: date }); } };
  const onCellUp = () => {
    const { start, end } = drag.current; drag.current = { start: null, end: null }; setDragBox(null);
    if (!start) return;
    const [a, b] = start <= (end ?? start) ? [start, end ?? start] : [end ?? start, start];
    setOpenDay({ from: a, to: b });
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🗓 Календар команди · чергування та відсутності</h1>
        <div className="page-filters" style={{ alignItems: "center", gap: 8 }}>
          {isAdmin && teams.length > 0 && (
            <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Усі команди</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {pendingCount > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, background: "#fef3c7", border: "1px solid #f59e0b55", color: "#b45309", fontSize: 13, fontWeight: 600 }}>
              ⏳ {pendingCount} на погодженні
              {isApprover && <>· <button onClick={() => setShowApprovals(true)} style={{ border: "none", background: "transparent", color: "#b45309", textDecoration: "underline", cursor: "pointer", fontWeight: 700, padding: 0, fontSize: 13 }}>погодити</button></>}
            </span>
          )}
          <button onClick={() => shiftMonth(-1)} style={navBtn}>‹</button>
          <span style={{ fontWeight: 700, minWidth: 130, textAlign: "center" }}>{MONTHS[view.m]} {view.y}</span>
          <button onClick={() => shiftMonth(1)} style={navBtn}>›</button>
        </div>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start", justifyContent: "space-between" }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, maxWidth: 640, lineHeight: 1.6 }}>
            <b style={{ color: "var(--text)" }}>Доступно всім керівникам.</b> Менеджер відмічає свої <b style={{ color: "var(--text)" }}>вихідні, відпустку, лікарняний, скорочений</b> — усі йдуть на <b style={{ color: "var(--text)" }}>погодження тімліда або адміна</b> (⏳ на погодженні → ✓ погоджено); тімлід призначає чергового. Натисни день або протягни діапазон. <b style={{ color: "var(--text)" }}>Видно:</b> адмін — усе, тімлід — свою команду + чергування, менеджер — лише свої дні.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, color: "var(--text-muted)" }}>
            {LEGEND.map((k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: KIND[k].dot }} /> {KIND[k].label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-card">
        {data === null ? (
          <p className="loading-text">Завантаження…</p>
        ) : (
          <div style={{ overflowX: "auto" }} onMouseLeave={() => { drag.current = { start: null, end: null }; setDragBox(null); }}>
            <div style={{ minWidth: 760 }}>
              {/* weekday header */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
                {WD.map((w, i) => (
                  <div key={w} style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: i >= 5 ? "#dc2626" : "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{w}</div>
                ))}
              </div>
              {weeks.map((week, wi) => (
                <div key={wi}>
                  {/* бенди багатоденних відсутностей над тижнем */}
                  {bandsByWeek[wi].length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: 4, padding: "2px 0" }}>
                      {bandsByWeek[wi].map(({ a, startCol, endCol }) => {
                        const c = KIND[a.kind];
                        const pend = isPending(a.status);
                        return (
                          <div key={a.id} onClick={() => setOpenDay({ from: a.startDate, to: a.endDate })}
                            title={`${a.managerName} · ${c.label} ${rangeLabel(a)} · ${pend ? "на погодженні" : `погоджено${a.approverName ? " · " + a.approverName : ""}`}`}
                            style={{
                              gridColumn: `${startCol + 1} / ${endCol + 2}`, cursor: "pointer",
                              background: c.bg, color: c.fg, borderRadius: 8, padding: "3px 10px", fontSize: 12, fontWeight: 600,
                              border: `1.5px ${pend ? "dashed" : "solid"} ${c.dot}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>
                            {c.icon} {a.managerName} · {c.short} {rangeLabel(a)} · {pend ? "⏳ на погодженні" : "✓"}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* дні тижня */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))" }}>
                    {week.map((date, di) => {
                      if (!date) return <div key={di} style={{ border: "1px solid var(--border)", minHeight: 104, background: "var(--bg,transparent)" }} />;
                      const items = perDay.get(date) ?? [];
                      const isToday = date === todayStr;
                      const weekend = di >= 5;
                      const inDrag = dragBox && date >= (dragBox.start <= dragBox.end ? dragBox.start : dragBox.end) && date <= (dragBox.start <= dragBox.end ? dragBox.end : dragBox.start);
                      return (
                        <div key={di}
                          onMouseDown={() => onCellDown(date)} onMouseEnter={() => onCellEnter(date)} onMouseUp={onCellUp}
                          style={{
                            border: isToday ? "2px solid #c5141c" : "1px solid var(--border)",
                            background: inDrag ? "rgba(37,99,235,0.10)" : weekend ? "rgba(220,38,38,0.04)" : "var(--card-bg)",
                            minHeight: 104, padding: 7, cursor: "pointer", userSelect: "none",
                          }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                            <span style={{ fontSize: 13, fontWeight: isToday ? 800 : 600, color: weekend ? "#dc2626" : "var(--text)" }}>{Number(date.slice(8, 10))}</span>
                            <span style={{ fontSize: 15, color: "var(--text-muted)", lineHeight: 1 }}>＋</span>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {items.slice(0, 2).map((it) => {
                              const c = KIND[it.kind];
                              const pend = isPending(it.status);
                              return (
                                <span key={it.key} title={`${it.name}${it.team ? " · " + it.team : ""} · ${it.label}`} style={{
                                  fontSize: 11.5, padding: "2px 7px", borderRadius: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                  background: c.bg, color: c.fg, fontWeight: 600,
                                  border: `1px ${pend ? "dashed" : "solid"} ${c.dot}${pend ? "" : "66"}`,
                                }}>
                                  {it.name}{it.kind === "duty" && it.team ? <span style={{ fontWeight: 400, opacity: 0.75 }}> · {it.team}</span> : null} · {it.label}{it.kind === "duty" ? "" : ` ${statusMark(it.status)}`}
                                </span>
                              );
                            })}
                            {items.length > 2 && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>+{items.length - 2} ще</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Як це працює (продуктова довідка) */}
      <div className="chart-card" style={{ marginTop: 16, background: "rgba(37,99,235,0.05)" }}>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.7 }}>
          <b style={{ color: "var(--text)" }}>Як це працює:</b> один календар — чергування + відсутності для всіх команд. Відпустка/лікарняний — смугою через кілька днів (не поденно) + погодження тімліда/адміна; вихідний/скорочений — поденні; менеджер відмічає себе, тімлід призначає чергового. <b style={{ color: "var(--text)" }}>План НЕ зменшується</b> — пропущені дні перерозподіляються на присутні робочі дні (живить динамічний план, наступний крок). <b style={{ color: "var(--text)" }}>Видимість:</b> адмін — весь календар, тімлід — своя команда + чергування, менеджер — лише свої дні. Держсвята вручну фіксує адмін.
        </p>
      </div>

      {openDay && data && (
        <DayEditorModal range={openDay} data={data} role={role} canEditDuty={canEditDuty}
          onClose={() => setOpenDay(null)} onChanged={changed} />
      )}
      {showApprovals && data && (
        <ApprovalsModal data={data} role={role} onClose={() => setShowApprovals(false)} onChanged={changed} />
      )}
    </>
  );
}

// ─────────────────────────── DAY EDITOR (чергування + відсутність) ───────────────────────────
function DayEditorModal({ range, data, role, canEditDuty, onClose, onChanged }: {
  range: { from: string; to: string }; data: DutySchedule; role?: string; canEditDuty: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const single = range.from === range.to;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isManager = role !== "admin" && role !== "team_lead";
  const isApprover = role === "admin" || role === "team_lead";

  // Відсутність
  const [kind, setKind] = useState<AbsenceKind>(single ? "day_off" : "vacation");
  const [startDate, setStart] = useState(range.from);
  const [endDate, setEnd] = useState(range.to);
  const [hours, setHours] = useState(2);
  const [absMgr, setAbsMgr] = useState<number | "">("");
  const [absNote, setAbsNote] = useState("");
  const rangeKind = kind === "vacation" || kind === "sick";

  // Чергування
  const [dutyMgr, setDutyMgr] = useState<number | "">("");
  const [shift, setShift] = useState("day");
  const [dutyNote, setDutyNote] = useState("");

  // Держсвято (admin)
  const [holName, setHolName] = useState("");
  const holidayToday = data.holidays.find((h) => h.date === range.from);

  const d = new Date(range.from + "T00:00:00");
  const dayAssigns = data.assignments.filter((a) => a.date === range.from);
  const dayAbs = data.absences.filter((a) => a.startDate <= range.to && a.endDate >= range.from);

  const wrap = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); onChanged(); } catch (e) { setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка"); } finally { setBusy(false); } };
  const addAbsence = () => wrap(async () => {
    await createAbsence({ managerId: isManager ? undefined : (absMgr ? Number(absMgr) : undefined), kind, startDate, endDate: rangeKind ? endDate : undefined, hours: kind === "short_day" ? hours : undefined, note: absNote.trim() || undefined });
    setAbsNote("");
  });
  const addDuty = () => wrap(async () => { await assignDuty({ date: range.from, managerId: Number(dutyMgr), shift, note: dutyNote.trim() || undefined }); setDutyMgr(""); setDutyNote(""); });
  const canApprove = (a: Absence) => role === "admin" || (role === "team_lead" && !a.mine);

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>
            {single ? `${d.getDate()} ${MONTHS[d.getMonth()].toLowerCase()}` : `${ddmm(range.from)}–${ddmm(range.to)} ${MON_SHORT[Number(range.to.slice(5, 7)) - 1]}`}
          </h2>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        {/* Наявні відсутності дня/діапазону */}
        {dayAbs.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <h3 style={hdr}>Відсутності</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {dayAbs.map((a) => {
                const c = KIND[a.kind];
                return (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", border: `1px solid ${c.dot}55`, borderRadius: 8, background: c.bg }}>
                    <span style={{ fontSize: 12.5, color: c.fg }}>
                      <b>{a.managerName}</b> · {c.label}{a.kind === "short_day" && a.hours ? ` −${a.hours}год` : ""}
                      {a.startDate !== a.endDate ? ` · ${rangeLabel(a)}` : ""}
                      {" · "}{a.status === "pending" ? "⏳ на погодженні" : a.status === "approved" ? `✓ погоджено${a.approverName ? " (" + a.approverName + ")" : ""}` : "✗ відхилено"}
                    </span>
                    <span style={{ display: "flex", gap: 6 }}>
                      {a.status === "pending" && canApprove(a) && (
                        <>
                          <button disabled={busy} onClick={() => wrap(async () => { await decideAbsence(a.id, "approve"); })} style={miniBtn("#16a34a")}>✓</button>
                          <button disabled={busy} onClick={() => wrap(async () => { await decideAbsence(a.id, "reject"); })} style={miniBtn("#dc2626")}>✕</button>
                        </>
                      )}
                      {(role === "admin" || a.mine || (role === "team_lead")) && (
                        <button disabled={busy} onClick={() => wrap(async () => { await removeAbsence(a.id); })} title="Видалити" style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>🗑</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Додати відсутність */}
        <h3 style={hdr}>Відмітити відсутність</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["day_off", "vacation", "sick", "short_day"] as AbsenceKind[]).map((k) => (
              <button key={k} onClick={() => setKind(k)} style={{
                padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: kind === k ? 700 : 500,
                border: `1px solid ${kind === k ? KIND[k].dot : "var(--border)"}`, background: kind === k ? KIND[k].bg : "var(--card-bg)", color: kind === k ? KIND[k].fg : "var(--text)",
              }}>{KIND[k].label}</button>
            ))}
          </div>
          {!isManager && (
            <select value={absMgr} onChange={(e) => setAbsMgr(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{role === "admin" ? "Оберіть менеджера…" : "Оберіть (або лишіть — на себе)"}</option>
              {data.absenceManagers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.teamName ? ` (${m.teamName})` : ""}</option>)}
            </select>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={lbl}>з <input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} style={inp} /></label>
            {rangeKind && <label style={lbl}>по <input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} style={inp} /></label>}
            {kind === "short_day" && <label style={lbl}>годин <input type="number" min={1} max={8} value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ ...inp, width: 64 }} /></label>}
          </div>
          <input value={absNote} onChange={(e) => setAbsNote(e.target.value)} placeholder="Коментар (необовʼязково)" style={inp} />
          {err && <div style={{ color: "#dc2626", fontSize: 12 }}>{err}</div>}
          <button onClick={addAbsence} disabled={busy} style={primaryBtn}>
            {isApprover && (isManager || absMgr) ? "+ Додати (погоджено)" : "+ Надіслати на погодження"}
          </button>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {role === "manager" ? "Твоя відмітка піде на погодження тімліда/адміна."
              : role === "team_lead" ? "Своя відсутність → на погодження адміна; відсутність менеджера команди → одразу погоджено."
                : "Адмін — погоджується одразу."}
          </span>
        </div>

        {/* Чергування (лише RNK-лід/адмін) */}
        {canEditDuty && (
          <>
            <h3 style={hdr}>Чергування{single ? "" : ` (на ${ddmm(range.from)})`}</h3>
            {dayAssigns.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                {dayAssigns.map((a) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", border: `1px solid ${KIND.duty.dot}55`, borderRadius: 8, background: KIND.duty.bg }}>
                    <span style={{ fontSize: 12.5, color: KIND.duty.fg }}><b>{a.managerName}</b> · {a.note?.trim() || SHIFT_LABEL[a.shift]}{a.teamName ? ` · ${a.teamName}` : ""}</span>
                    <button disabled={busy} onClick={() => wrap(async () => { await removeDuty(a.id); })} style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer" }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <select value={dutyMgr} onChange={(e) => setDutyMgr(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Оберіть чергового…</option>
                {data.managers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.team_name ? ` (${m.team_name})` : ""}</option>)}
              </select>
              <div style={{ display: "flex", gap: 8 }}>
                {(["day", "evening", "weekend"] as const).map((s) => (
                  <button key={s} onClick={() => setShift(s)} style={{ flex: 1, padding: "6px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: shift === s ? 700 : 500, border: `1px solid ${shift === s ? KIND.duty.dot : "var(--border)"}`, background: shift === s ? KIND.duty.bg : "var(--card-bg)", color: shift === s ? KIND.duty.fg : "var(--text)" }}>{SHIFT_LABEL[s]}</button>
                ))}
              </div>
              <input value={dutyNote} onChange={(e) => setDutyNote(e.target.value)} placeholder="Нотатка (напр. заміна)" style={inp} />
              <button onClick={addDuty} disabled={busy || !dutyMgr} style={{ ...primaryBtn, background: dutyMgr ? "#6d28d9" : "var(--border)" }}>+ Призначити чергового</button>
            </div>
          </>
        )}

        {/* Держсвято — вручну фіксує адмін (глобально) */}
        {role === "admin" && single && (
          <>
            <h3 style={{ ...hdr, marginTop: 16 }}>Держсвято (неробочий день, усі команди)</h3>
            {holidayToday ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
                <span style={{ fontSize: 12.5 }}>🎌 <b>{holidayToday.name}</b></span>
                <button disabled={busy} onClick={() => wrap(async () => { await removeHoliday(holidayToday.id); })} style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer" }}>Прибрати</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input value={holName} onChange={(e) => setHolName(e.target.value)} placeholder="Назва свята" style={{ ...inp, flex: 1 }} />
                <button disabled={busy} onClick={() => wrap(async () => { await createHoliday({ date: range.from, name: holName.trim() || "Свято" }); setHolName(""); })} style={primaryBtn}>+ Свято</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── APPROVALS (⏳ на погодженні → погодити) ───────────────────────────
function ApprovalsModal({ data, role, onClose, onChanged }: { data: DutySchedule; role?: string; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const canApprove = (a: Absence) => role === "admin" || (role === "team_lead" && !a.mine);
  const pending = data.absences.filter((a) => a.status === "pending" && canApprove(a));
  const act = async (id: number, decision: "approve" | "reject") => { setBusy(true); try { await decideAbsence(id, decision); onChanged(); } finally { setBusy(false); } };
  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={modal}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>⏳ На погодженні ({pending.length})</h2>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>
        {pending.length === 0 ? <p className="loading-text">Немає відміток на погодженні.</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pending.map((a) => {
              const c = KIND[a.kind];
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", border: `1px solid ${c.dot}55`, borderRadius: 8, background: c.bg }}>
                  <span style={{ fontSize: 13, color: c.fg }}>
                    <b>{a.managerName}</b> · {c.label}{a.kind === "short_day" && a.hours ? ` −${a.hours}год` : ""} · {a.startDate === a.endDate ? ddmm(a.startDate) + " " + MON_SHORT[Number(a.startDate.slice(5, 7)) - 1] : rangeLabel(a)}
                    {a.teamName ? ` · ${a.teamName}` : ""}{a.note ? ` — ${a.note}` : ""}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button disabled={busy} onClick={() => act(a.id, "approve")} style={miniBtn("#16a34a")}>✓ Погодити</button>
                    <button disabled={busy} onClick={() => act(a.id, "reject")} style={miniBtn("#dc2626")}>✕ Відхилити</button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontSize: 16, fontWeight: 700 };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 };
const modal: React.CSSProperties = { background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 520, maxHeight: "88vh", overflowY: "auto" };
const xBtn: React.CSSProperties = { border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px", cursor: "pointer" };
const hdr: React.CSSProperties = { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "0 0 8px" };
const inp: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" };
const lbl: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6 };
const primaryBtn: React.CSSProperties = { padding: "9px 12px", borderRadius: 8, border: "none", cursor: "pointer", background: "#c5141c", color: "#fff", fontWeight: 600 };
const miniBtn = (color: string): React.CSSProperties => ({ padding: "4px 10px", borderRadius: 6, border: `1px solid ${color}`, background: "transparent", color, cursor: "pointer", fontSize: 12, fontWeight: 600 });
