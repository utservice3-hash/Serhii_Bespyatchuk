import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchPlansGrid, savePlan, type PlansGrid, type Team } from "../../../api";
import { formatAmount } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { teamOptions } from "../teamColors";

const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/** Plan editor: admin/team-lead sets each manager's monthly revenue plan; the
 *  grid auto-decomposes it by week (fixed 7-day blocks) and per working day.
 *  Team totals and grand total update live. Everything flows from these plans. */
export function PlansSection({ canPickTeam, teams, canEdit = true }: { canPickTeam: boolean; teams: Team[]; canEdit?: boolean }) {
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
    if (!canEdit) return;                 // 🔒 запис у plans — лише admin (governance)
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

  // DYNAMIC decomposition: залишок = max(0, план − факт) розкидається на РОБОЧІ
  // дні, що ще ЗАЛИШИЛИСЯ до кінця місяця. Тому щойно менеджер щось заробляє,
  // тижневі/денні цілі автоматично зменшуються. Тиждень = блок × його майбутні
  // робочі дні ÷ усі майбутні робочі дні місяця.
  const decomp = useMemo(() => {
    if (!grid) return null;
    const [gy, gm] = grid.month.split("-").map(Number); // gm 1-based
    const now = new Date();
    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const isPast = grid.month < curKey, isFuture = grid.month > curKey;
    const todayDay = now.getDate();
    const futureDay = (d: number) => (isPast ? false : isFuture ? true : d >= todayDay);
    const isWD = (d: number) => { const dow = new Date(gy, gm - 1, d).getDay(); return dow !== 0 && dow !== 6; };
    const futureWDInWeek = (w: { from: number; to: number }) => { let n = 0; for (let d = w.from; d <= w.to; d++) if (isWD(d) && futureDay(d)) n++; return n; };
    let remWD = 0, elapsedWD = 0;
    for (let d = 1; d <= grid.daysInMonth; d++) {
      if (!isWD(d)) continue;
      if (futureDay(d)) remWD++;
      // "Пройдено" робочих днів (для плану на сьогодні): минулі + сьогодні.
      const passed = isPast ? true : isFuture ? false : d <= todayDay;
      if (passed) elapsedWD++;
    }
    const totalWD = grid.workingDays;
    return (plan: number, fact: number, carryover: number, expected = 0) => {
      const remaining = Math.max(0, plan - fact);
      // План на сьогодні (декомпозований по тижнях/днях до поточного моменту).
      const planToDate = totalWD > 0 ? Math.round((plan * elapsedWD) / totalWD) : 0;
      // Відставання = план на сьогодні − (факт + перенесені). >0 — позаду темпу.
      const lag = Math.round(planToDate - (fact + carryover));
      // Реалістичне = ще й мінус очікувані (майже оплачені рахунки).
      const lagReal = Math.round(planToDate - (fact + carryover + expected));
      return {
        remaining,
        planToDate,
        lag,
        lagReal,
        perDay: remWD > 0 ? Math.round(remaining / remWD) : 0,
        perWeek: grid.weeks.map((w) => (remWD > 0 ? Math.round((remaining * futureWDInWeek(w)) / remWD) : 0)),
      };
    };
  }, [grid]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">💵 Плани</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {canPickTeam && (
            <select value={teamId} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : ""; setTeamId(v); localStorage.setItem("plansTeam", v ? String(v) : ""); }}>
              <option value="">Усі команди</option>
              {teamOptions(teams)}
            </select>
          )}
          <button onClick={() => shiftMonth(-1)} title="Попередній місяць"
            style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>←</button>
          <DatePicker mode="month" value={month} onChange={(v) => v && setMonthP(v)} minWidth={140} />
          <button onClick={() => shiftMonth(1)} title="Наступний місяць"
            style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>→</button>
        </div>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 820 }}>
        Місячний план виручки по менеджеру (редагується). <b>Тижні/день — динамічні</b>: залишок (план − факт) розкидається на робочі дні, що ще залишилися, тож цілі <b>автоматично зменшуються</b> у міру виконання.
        Факт = «Успішно» + «Оплата отримана». Очікувані = снапшот угод з етапу «Виставлено рахунок».
        <b> Відставання</b> = план на сьогодні − (факт + перенесені); <b>Реаліст.</b> = ще й мінус очікувані (майже оплачені рахунки). «✓» — темп витримано.
        {!canEdit && <><br /><b style={{ color: "#d97706" }}>🔒 Лише перегляд.</b> План формується через «💼 Формування плану» (ти подаєш → КВП затверджує). Пряме редагування плану — за адміністратором.</>}
      </p>

      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!grid && !err && <p className="loading-text">Завантаження…</p>}

      {grid && decomp && (() => {
        const sub = "var(--bg-subtle, rgba(127,127,127,0.08))";
        const wkCols = grid.weeks.length;
        return (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact" style={{ minWidth: 1160 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Менеджер</th>
                  <th style={{ textAlign: "right" }}>План<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>статичний</div></th>
                  <th style={{ textAlign: "right" }}>Факт<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>успішно+оплата</div></th>
                  <th style={{ textAlign: "right" }}>Перенесені</th>
                  <th style={{ textAlign: "right" }}>Очікувані<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>з рахунку</div></th>
                  <th style={{ textAlign: "right" }}>Залишок</th>
                  <th style={{ textAlign: "right" }}>Відставання<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>план сьогодні − факт+перен.</div></th>
                  <th style={{ textAlign: "right" }}>Реаліст.<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>ще − очікувані</div></th>
                  {grid.weeks.map((w) => (
                    <th key={w.label} style={{ textAlign: "right" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{w.from}–{w.to}</div></th>
                  ))}
                  <th style={{ textAlign: "right" }}>На день</th>
                </tr>
              </thead>
              <tbody>
                {grid.teams.map((team) => {
                  const td = decomp(team.teamPlan, team.teamFact, team.teamCarryover, team.teamExpected);
                  return (
                  <Fragment key={team.teamId}>
                    <tr>
                      <td style={{ fontWeight: 700, background: sub }}>{team.teamName}</td>
                      <td style={{ fontWeight: 700, textAlign: "right", background: sub }}>{formatAmount(team.teamPlan)}</td>
                      <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: "#16a34a" }}>{formatAmount(team.teamFact)}</td>
                      <td style={{ textAlign: "right", background: sub }}>{formatAmount(team.teamCarryover)}</td>
                      <td style={{ textAlign: "right", background: sub }}>{formatAmount(team.teamExpected)}</td>
                      <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: "#d97706" }}>{formatAmount(td.remaining)}</td>
                      <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: td.lag > 0 ? "#dc2626" : "#16a34a" }}>{td.lag > 0 ? formatAmount(td.lag) : "✓"}</td>
                      <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: td.lagReal > 0 ? "#d97706" : "#16a34a" }}>{td.lagReal > 0 ? formatAmount(td.lagReal) : "✓"}</td>
                      {td.perWeek.map((v, i) => (
                        <td key={i} style={{ textAlign: "right", fontWeight: 600, background: sub }}>{formatAmount(v)}</td>
                      ))}
                      <td style={{ textAlign: "right", fontWeight: 600, background: sub }}>{formatAmount(td.perDay)}</td>
                    </tr>
                    {team.managers.map((m) => {
                      const d = decomp(m.plan, m.fact, m.carryover, m.expected);
                      const draft = drafts[m.managerId];
                      const dirty = draft != null && Number(draft.replace(/[^\d.-]/g, "")) !== m.plan;
                      return (
                        <tr key={m.managerId}>
                          <td style={{ textAlign: "left", paddingLeft: 18 }}>{m.name}</td>
                          <td style={{ textAlign: "right" }}>
                            {canEdit ? (
                              <>
                                <input
                                  value={draft ?? String(m.plan)}
                                  onChange={(e) => setDrafts((p) => ({ ...p, [m.managerId]: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter") save(m.managerId); }}
                                  inputMode="numeric"
                                  style={{ width: 96, textAlign: "right", padding: "3px 6px", borderRadius: 6, border: `1px solid ${dirty ? "#d97706" : "var(--border)"}`, background: "var(--card-bg)", color: "var(--text)" }}
                                />
                                {dirty && (
                                  <button onClick={() => save(m.managerId)} disabled={savingId === m.managerId}
                                    style={{ marginLeft: 4, padding: "3px 8px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                                    {savingId === m.managerId ? "…" : "✓"}
                                  </button>
                                )}
                              </>
                            ) : (
                              formatAmount(m.plan)   // 🔒 тімлід — лише перегляд (план формується через «Формування»)
                            )}
                          </td>
                          <td style={{ textAlign: "right", color: "#16a34a", fontWeight: 600 }}>{formatAmount(m.fact)}</td>
                          <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(m.carryover)}</td>
                          <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(m.expected)}</td>
                          <td style={{ textAlign: "right", color: "#d97706", fontWeight: 600 }}>{formatAmount(d.remaining)}</td>
                          <td style={{ textAlign: "right", fontWeight: 600, color: d.lag > 0 ? "#dc2626" : "#16a34a" }}>{d.lag > 0 ? formatAmount(d.lag) : "✓"}</td>
                          <td style={{ textAlign: "right", fontWeight: 600, color: d.lagReal > 0 ? "#d97706" : "#16a34a" }}>{d.lagReal > 0 ? formatAmount(d.lagReal) : "✓"}</td>
                          {d.perWeek.map((v, i) => (
                            <td key={i} style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(v)}</td>
                          ))}
                          <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(d.perDay)}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                  );
                })}
                {(() => { const gd = decomp(grid.totalPlan, grid.totalFact, grid.totalCarryover, grid.totalExpected); return (
                <tr style={{ borderTop: "2px solid var(--border)" }}>
                  <td style={{ fontWeight: 800 }}>Разом по відділу</td>
                  <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(grid.totalPlan)}</td>
                  <td style={{ fontWeight: 800, textAlign: "right", color: "#16a34a" }}>{formatAmount(grid.totalFact)}</td>
                  <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(grid.totalCarryover)}</td>
                  <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(grid.totalExpected)}</td>
                  <td style={{ fontWeight: 800, textAlign: "right", color: "#d97706" }}>{formatAmount(gd.remaining)}</td>
                  <td style={{ fontWeight: 800, textAlign: "right", color: gd.lag > 0 ? "#dc2626" : "#16a34a" }}>{gd.lag > 0 ? formatAmount(gd.lag) : "✓"}</td>
                  <td style={{ fontWeight: 800, textAlign: "right", color: gd.lagReal > 0 ? "#d97706" : "#16a34a" }}>{gd.lagReal > 0 ? formatAmount(gd.lagReal) : "✓"}</td>
                  {gd.perWeek.map((v, i) => (
                    <td key={i} style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(v)}</td>
                  ))}
                  <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(gd.perDay)}</td>
                </tr>
                ); })()}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            Стовпці «Тиждень» і «На день» — це скільки ЩЕ треба заробити (залишок), розподілено на майбутні робочі дні{wkCols ? "" : ""}. Минулі дні не враховуються.
          </p>
        </div>
        );
      })()}
    </>
  );
}
