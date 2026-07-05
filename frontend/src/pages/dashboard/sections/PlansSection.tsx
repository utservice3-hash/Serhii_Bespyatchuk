import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchPlansGrid, savePlan, type PlansGrid, type Team } from "../../../api";
import { formatAmount } from "../format";

const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/** Plan editor: admin/team-lead sets each manager's monthly revenue plan; the
 *  grid auto-decomposes it by week (fixed 7-day blocks) and per working day.
 *  Team totals and grand total update live. Everything flows from these plans. */
export function PlansSection({ canPickTeam, teams }: { canPickTeam: boolean; teams: Team[] }) {
  const [month, setMonth] = useState<string>(() => localStorage.getItem("plansMonth") || curMonthStr());
  const [teamId, setTeamId] = useState<number | "">(() => {
    const v = localStorage.getItem("plansTeam");
    return v ? Number(v) : "";
  });
  const [grid, setGrid] = useState<PlansGrid | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setGrid(null);
    fetchPlansGrid(month, teamId ? Number(teamId) : undefined)
      .then((g) => { if (alive) { setGrid(g); setDrafts({}); } })
      .catch(() => { if (alive) setErr("Не вдалося завантажити плани."); });
    return () => { alive = false; };
  }, [month, teamId, reload]);

  const setMonthP = (v: string) => { if (!v) return; setMonth(v); localStorage.setItem("plansMonth", v); };
  const shiftMonth = (d: number) => {
    const [y, m] = month.split("-").map(Number);
    const nd = new Date(y, m - 1 + d, 1);
    setMonthP(`${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}`);
  };

  const save = async (managerId: number) => {
    const raw = drafts[managerId];
    if (raw == null) return;
    const val = Number(raw.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(val)) return;
    setSavingId(managerId);
    try {
      await savePlan(managerId, month, val);
      setReload((n) => n + 1);
    } catch {
      setErr("Не вдалося зберегти план.");
    } finally {
      setSavingId(null);
    }
  };

  // Per-block plan = monthly × daysInBlock / daysInMonth; per working day = monthly / workingDays.
  const decomp = useMemo(() => {
    if (!grid) return null;
    return (plan: number) => ({
      perWeek: grid.weeks.map((w) => Math.round((plan * w.days) / grid.daysInMonth)),
      perDay: grid.workingDays > 0 ? Math.round(plan / grid.workingDays) : 0,
    });
  }, [grid]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">💵 Плани</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {canPickTeam && (
            <select value={teamId} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : ""; setTeamId(v); localStorage.setItem("plansTeam", v ? String(v) : ""); }}>
              <option value="">Усі команди</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <button onClick={() => shiftMonth(-1)} title="Попередній місяць"
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>←</button>
          <input type="month" value={month} onChange={(e) => setMonthP(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          <button onClick={() => shiftMonth(1)} title="Наступний місяць"
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>→</button>
        </div>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 760 }}>
        Місячний план виручки по кожному менеджеру. Тижні й день рахуються автоматично: тиждень = пропорція днів блоку, день = план ÷ робочі дні місяця
        {grid ? ` (${grid.workingDays} роб. дн. у місяці)` : ""}. Команда = сума менеджерів.
      </p>

      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!grid && !err && <p className="loading-text">Завантаження…</p>}

      {grid && decomp && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Менеджер</th>
                  <th style={{ textAlign: "right" }}>План на місяць</th>
                  {grid.weeks.map((w) => (
                    <th key={w.label} style={{ textAlign: "right" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{w.from}–{w.to}</div></th>
                  ))}
                  <th style={{ textAlign: "right" }}>На роб. день</th>
                </tr>
              </thead>
              <tbody>
                {grid.teams.map((team) => (
                  <Fragment key={team.teamId}>
                    <tr>
                      <td style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))" }}>{team.teamName}</td>
                      <td style={{ fontWeight: 700, textAlign: "right", background: "var(--bg-subtle, rgba(127,127,127,0.08))" }}>{formatAmount(team.teamPlan)}</td>
                      {grid.weeks.map((_w, i) => (
                        <td key={i} style={{ textAlign: "right", fontWeight: 600, background: "var(--bg-subtle, rgba(127,127,127,0.08))" }}>{formatAmount(decomp(team.teamPlan).perWeek[i])}</td>
                      ))}
                      <td style={{ textAlign: "right", fontWeight: 600, background: "var(--bg-subtle, rgba(127,127,127,0.08))" }}>{formatAmount(decomp(team.teamPlan).perDay)}</td>
                    </tr>
                    {team.managers.map((m) => {
                      const d = decomp(m.plan);
                      const draft = drafts[m.managerId];
                      const dirty = draft != null && Number(draft.replace(/[^\d.-]/g, "")) !== m.plan;
                      return (
                        <tr key={m.managerId}>
                          <td style={{ textAlign: "left", paddingLeft: 18 }}>{m.name}</td>
                          <td style={{ textAlign: "right" }}>
                            <input
                              value={draft ?? String(m.plan)}
                              onChange={(e) => setDrafts((p) => ({ ...p, [m.managerId]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") save(m.managerId); }}
                              inputMode="numeric"
                              style={{ width: 110, textAlign: "right", padding: "3px 6px", borderRadius: 6, border: `1px solid ${dirty ? "#d97706" : "var(--border)"}`, background: "var(--card-bg)", color: "var(--text)" }}
                            />
                            {dirty && (
                              <button onClick={() => save(m.managerId)} disabled={savingId === m.managerId}
                                style={{ marginLeft: 4, padding: "3px 8px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                                {savingId === m.managerId ? "…" : "✓"}
                              </button>
                            )}
                          </td>
                          {d.perWeek.map((v, i) => (
                            <td key={i} style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(v)}</td>
                          ))}
                          <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(d.perDay)}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
                <tr style={{ borderTop: "2px solid var(--border)" }}>
                  <td style={{ fontWeight: 800 }}>Разом по відділу</td>
                  <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(grid.totalPlan)}</td>
                  {grid.weeks.map((_w, i) => (
                    <td key={i} style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(decomp(grid.totalPlan).perWeek[i])}</td>
                  ))}
                  <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(decomp(grid.totalPlan).perDay)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
