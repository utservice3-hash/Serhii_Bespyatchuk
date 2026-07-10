import { useEffect, useMemo, useState } from "react";
import {
  fetchDutySchedule,
  assignDuty,
  removeDuty,
  fetchTeams,
  type DutySchedule,
  type DutyAssignment,
  type Team,
} from "../../../api";
import { teamOptions } from "../teamColors";

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const pad = (n: number) => String(n).padStart(2, "0");

const SHIFT_LABEL: Record<string, string> = { day: "Весь день", evening: "Вечір 18–21", weekend: "Вихідний" };
const SHIFT_SHORT: Record<string, string> = { day: "весь день", evening: "вечір", weekend: "вихідний" };
const SHIFT_COLOR: Record<string, string> = { day: "#6366f1", evening: "#d97706", weekend: "#dc2626" };

/** Build a Mon-first grid of weeks covering the whole month (leading/trailing blanks). */
function monthGrid(year: number, month0: number): (string | null)[][] {
  const first = new Date(year, month0, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${pad(month0 + 1)}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function DayEditorModal({
  date, data, canEdit, teamId, onClose, onChanged,
}: {
  date: string;
  data: DutySchedule;
  canEdit: boolean;
  teamId: number | "";
  onClose: () => void;
  onChanged: () => void;
}) {
  const dayAssigns = data.assignments.filter((a) => a.date === date);
  const [managerId, setManagerId] = useState<number | "">("");
  const [shift, setShift] = useState("day");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const d = new Date(date + "T00:00:00");
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
  // On weekends the natural default is a whole-day «вихідний» duty.
  useEffect(() => { if (isWeekend) setShift("weekend"); }, [isWeekend]);

  const mgrs = teamId ? data.managers.filter((m) => m.team_id === Number(teamId)) : data.managers;

  async function add() {
    if (!managerId) return;
    setBusy(true); setErr(null);
    try {
      await assignDuty({ date, managerId: Number(managerId), shift, note: note.trim() || undefined });
      setManagerId(""); setNote("");
      onChanged();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg ?? "Не вдалося зберегти");
    } finally { setBusy(false); }
  }
  async function del(id: number) {
    setBusy(true); setErr(null);
    try { await removeDuty(id); onChanged(); }
    catch { setErr("Не вдалося видалити"); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>
            {d.getDate()} {MONTHS[d.getMonth()].toLowerCase()} · {WD[(d.getDay() + 6) % 7]}
            {isWeekend && <span style={{ color: "#dc2626", fontSize: 13, marginLeft: 8 }}>вихідний</span>}
          </h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>

        <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "0 0 8px" }}>Чергові цього дня</h3>
        {dayAssigns.length === 0 ? (
          <p className="loading-text" style={{ margin: "0 0 12px" }}>Нікого не призначено.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {dayAssigns.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: SHIFT_COLOR[a.shift] ?? "#6366f1" }} />
                  <b>{a.managerName}</b>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{SHIFT_LABEL[a.shift] ?? a.shift}{a.teamName ? ` · ${a.teamName}` : ""}</span>
                  {a.note && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>— {a.note}</span>}
                </span>
                {canEdit && (
                  <button onClick={() => del(a.id)} disabled={busy} title="Прибрати" style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 16 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        )}

        {canEdit && (
          <>
            <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "8px 0 8px" }}>Призначити</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Оберіть менеджера…</option>
                {mgrs.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.team_name ? ` (${m.team_name})` : ""}</option>
                ))}
              </select>
              <div style={{ display: "flex", gap: 8 }}>
                {(["day", "evening", "weekend"] as const).map((s) => (
                  <button key={s} onClick={() => setShift(s)}
                    style={{ flex: 1, padding: "6px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: shift === s ? 700 : 500,
                      border: `1px solid ${shift === s ? SHIFT_COLOR[s] : "var(--border)"}`,
                      background: shift === s ? SHIFT_COLOR[s] : "var(--card-bg)", color: shift === s ? "#fff" : "var(--text)" }}>
                    {SHIFT_LABEL[s]}
                  </button>
                ))}
              </div>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Нотатка (необовʼязково)" style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
              {err && <div style={{ color: "#dc2626", fontSize: 12 }}>{err}</div>}
              <button onClick={add} disabled={busy || !managerId}
                style={{ padding: "8px 12px", borderRadius: 8, border: "none", cursor: managerId ? "pointer" : "not-allowed", background: managerId ? "#c5141c" : "var(--border)", color: "#fff", fontWeight: 600 }}>
                + Додати чергового
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Графік чергування — місячний календар. Тімлід (РНК)/адмін призначає менеджерів
 * на дні (клік по дню); менеджер бачить графік своєї команди, свої дні підсвічені.
 * Прив'язано до метрики «сер. час опрацювання заявки»: черговий закриває вечірні/
 * вихідні вікна, де реакція провисає.
 */
export function DutySection({ role }: { role?: string }) {
  const now = new Date();
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [teamId, setTeamId] = useState<number | "">("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [data, setData] = useState<DutySchedule | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const isAdmin = role === "admin";
  const from = `${view.y}-${pad(view.m + 1)}-01`;
  const to = `${view.y}-${pad(view.m + 1)}-${pad(new Date(view.y, view.m + 1, 0).getDate())}`;
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  useEffect(() => { if (isAdmin) fetchTeams().then(setTeams).catch(() => setTeams([])); }, [isAdmin]);
  useEffect(() => {
    fetchDutySchedule({ from, to, teamId: isAdmin && teamId ? Number(teamId) : undefined })
      .then(setData)
      .catch(() => setData(null));
  }, [from, to, teamId, isAdmin, reload]);

  const byDate = useMemo(() => {
    const map = new Map<string, DutyAssignment[]>();
    for (const a of data?.assignments ?? []) {
      if (!map.has(a.date)) map.set(a.date, []);
      map.get(a.date)!.push(a);
    }
    return map;
  }, [data]);

  const weeks = monthGrid(view.y, view.m);
  const canEdit = data?.canEdit ?? false;
  const myDays = (data?.assignments ?? []).filter((a) => a.mine).map((a) => a.date).sort();
  const myUpcoming = myDays.filter((d) => d >= todayStr);

  function shiftMonth(delta: number) {
    setView((v) => {
      const nm = v.m + delta;
      return { y: v.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
    });
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🗓 Графік чергування</h1>
        <div className="page-filters" style={{ alignItems: "center", gap: 8 }}>
          {isAdmin && teams.length > 0 && (
            <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Усі команди</option>
              {teamOptions(teams)}
            </select>
          )}
          <button onClick={() => shiftMonth(-1)} style={navBtn}>‹</button>
          <span style={{ fontWeight: 600, minWidth: 150, textAlign: "center" }}>{MONTHS[view.m]} {view.y}</span>
          <button onClick={() => shiftMonth(1)} style={navBtn}>›</button>
          <button onClick={() => setView({ y: now.getFullYear(), m: now.getMonth() })} style={{ ...navBtn, width: "auto", padding: "0 10px", fontSize: 12 }}>Сьогодні</button>
        </div>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, maxWidth: 620 }}>
            {canEdit
              ? "Натисни на день, щоб призначити чергового. Черговий стежить за вхідними заявками у своє вікно — щоб увечері/у вихідні клієнт не чекав відповіді (див. «Сер. час опрацювання заявки» у Звіті)."
              : "Графік чергувань твоєї команди. Твої дні підсвічені. У день чергування стеж за вхідними заявками й швидко бери їх у роботу."}
          </p>
          <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--text-muted)" }}>
            {(["day", "evening", "weekend"] as const).map((s) => (
              <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: SHIFT_COLOR[s] }} /> {SHIFT_LABEL[s]}
              </span>
            ))}
          </div>
        </div>
        {myUpcoming.length > 0 && (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "rgba(99,102,241,0.10)", borderRadius: 8, fontSize: 13 }}>
            📌 Твої найближчі чергування: <b>{myUpcoming.slice(0, 5).map((d) => d.slice(8, 10) + "." + d.slice(5, 7)).join(", ")}</b>
            {myUpcoming.length > 5 && ` +${myUpcoming.length - 5}`}
          </div>
        )}
      </div>

      <div className="chart-card">
        {data === null ? (
          <p className="loading-text">Завантаження…</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="duty-calendar" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 700 }}>
              <thead>
                <tr>
                  {WD.map((w, i) => (
                    <th key={w} style={{ padding: "6px 4px", fontSize: 12, color: i >= 5 ? "#dc2626" : "var(--text-muted)", fontWeight: 600, textAlign: "left" }}>{w}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week, wi) => (
                  <tr key={wi}>
                    {week.map((date, di) => {
                      if (!date) return <td key={di} style={{ border: "1px solid var(--border)", background: "var(--bg, transparent)", height: 96 }} />;
                      const assigns = byDate.get(date) ?? [];
                      const isToday = date === todayStr;
                      const weekend = di >= 5;
                      const dayNum = Number(date.slice(8, 10));
                      return (
                        <td key={di}
                          onClick={() => setOpenDay(date)}
                          style={{
                            border: isToday ? "2px solid #c5141c" : "1px solid var(--border)",
                            background: weekend ? "rgba(220,38,38,0.04)" : "var(--card-bg)",
                            height: 96, verticalAlign: "top", padding: 6, cursor: "pointer",
                          }}
                          title={canEdit ? "Призначити чергового" : "Деталі дня"}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                            <span style={{ fontSize: 13, fontWeight: isToday ? 700 : 500, color: weekend ? "#dc2626" : "var(--text)" }}>{dayNum}</span>
                            {canEdit && <span style={{ fontSize: 14, color: "var(--text-muted)" }}>＋</span>}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            {assigns.slice(0, 3).map((a) => (
                              <span key={a.id} style={{
                                fontSize: 11, padding: "1px 6px", borderRadius: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                background: a.mine ? SHIFT_COLOR[a.shift] ?? "#6366f1" : "rgba(99,102,241,0.12)",
                                color: a.mine ? "#fff" : "var(--text)",
                                border: `1px solid ${SHIFT_COLOR[a.shift] ?? "#6366f1"}33`,
                                fontWeight: a.mine ? 700 : 500,
                              }} title={`${a.managerName} · ${SHIFT_SHORT[a.shift] ?? a.shift}`}>
                                {a.managerName}{a.shift !== "day" ? ` · ${SHIFT_SHORT[a.shift]}` : ""}
                              </span>
                            ))}
                            {assigns.length > 3 && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>+{assigns.length - 3} ще</span>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openDay && data && (
        <DayEditorModal
          date={openDay}
          data={data}
          canEdit={canEdit}
          teamId={teamId}
          onClose={() => setOpenDay(null)}
          onChanged={() => setReload((r) => r + 1)}
        />
      )}
    </>
  );
}

const navBtn: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border)",
  background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontSize: 16, fontWeight: 700,
};
