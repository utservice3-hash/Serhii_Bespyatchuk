import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchRepeatPlansGrid, saveRepeatPlan, type RepeatPlansGrid, type Team } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";

const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/**
 * Repeat-client revenue plan: each month a team lead sets, per manager, the sum
 * that must be earned FROM regular clients. Fact is auto-filled from CRM
 * (received money whose client has 2+ lifetime paid orders); the remaining
 * target (план − факт) is decomposed dynamically across the month's remaining
 * working days, so weekly/daily goals shrink as the manager earns.
 */
export function RepeatPlanGrid({ canPickTeam, teams }: { canPickTeam: boolean; teams: Team[] }) {
  const [month, setMonth] = useState<string>(() => localStorage.getItem("repeatPlansMonth") || curMonthStr());
  const [teamId, setTeamId] = useState<number | "">(() => {
    const v = localStorage.getItem("repeatPlansTeam");
    return v ? Number(v) : "";
  });
  const [grid, setGrid] = useState<RepeatPlansGrid | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleMgr = (id: number) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setGrid(null);
    fetchRepeatPlansGrid(month, teamId ? Number(teamId) : undefined)
      .then((g) => { if (alive) { setGrid(g); setDrafts({}); } })
      .catch(() => { if (alive) setErr("Не вдалося завантажити плани."); });
    return () => { alive = false; };
  }, [month, teamId, reload, open]);

  const setMonthP = (v: string) => { if (!v) return; setMonth(v); localStorage.setItem("repeatPlansMonth", v); };
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
      await saveRepeatPlan(managerId, month, val);
      setReload((n) => n + 1);
    } catch {
      setErr("Не вдалося зберегти план.");
    } finally {
      setSavingId(null);
    }
  };

  // DYNAMIC decomposition — залишок (план − факт) розкидається на РОБОЧІ дні, що
  // ще залишилися до кінця місяця, тож тижневі/денні цілі авто-зменшуються.
  const decomp = useMemo(() => {
    if (!grid) return null;
    const [gy, gm] = grid.month.split("-").map(Number);
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
      const passed = isPast ? true : isFuture ? false : d <= todayDay;
      if (passed) elapsedWD++;
    }
    const totalWD = grid.workingDays;
    return (plan: number, fact: number) => {
      const remaining = Math.max(0, plan - fact);
      const planToDate = totalWD > 0 ? Math.round((plan * elapsedWD) / totalWD) : 0;
      const lag = Math.round(planToDate - fact);
      return {
        remaining,
        lag,
        perDay: remWD > 0 ? Math.round(remaining / remWD) : 0,
        perWeek: grid.weeks.map((w) => (remWD > 0 ? Math.round((remaining * futureWDInWeek(w)) / remWD) : 0)),
      };
    };
  }, [grid]);

  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "var(--text)" }}
        >
          {open ? "▾" : "▸"} 🎯 План по постійних клієнтах (виручка з постійних)
        </button>
        {open && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {canPickTeam && (
              <select value={teamId} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : ""; setTeamId(v); localStorage.setItem("repeatPlansTeam", v ? String(v) : ""); }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
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
        )}
      </div>

      {open && (
        <>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 12px", maxWidth: 820 }}>
            Тімлід ставить місячний план виручки <b>з постійних клієнтів</b> по кожному менеджеру. <b>Факт</b> заповнюється авто з CRM: отримані кошти (успішно 142 + оплата отримана) від клієнтів, які мають 2+ оплачених перевезень за весь час. <b>Тижні/день — динамічні</b>: залишок (план − факт) розкидається на майбутні робочі дні.
          </p>
          {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
          {!grid && !err && <p className="loading-text">Завантаження…</p>}
          {grid && decomp && (() => {
            const sub = "var(--bg-subtle, rgba(127,127,127,0.08))";
            return (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table compact" style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Менеджер</th>
                      <th style={{ textAlign: "right" }}>План<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>статичний</div></th>
                      <th style={{ textAlign: "right" }}>Факт<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>з постійних</div></th>
                      <th style={{ textAlign: "right" }}>Залишок</th>
                      <th style={{ textAlign: "right" }}>Відставання<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>план сьогодні − факт</div></th>
                      {grid.weeks.map((w) => (
                        <th key={w.label} style={{ textAlign: "right" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{w.from}–{w.to}</div></th>
                      ))}
                      <th style={{ textAlign: "right" }}>На день</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.teams.map((team) => {
                      const td = decomp(team.teamPlan, team.teamFact);
                      return (
                        <Fragment key={team.teamId}>
                          <tr>
                            <td style={{ fontWeight: 700, background: sub }}>{team.teamName}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub }}>{formatAmount(team.teamPlan)}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: "#16a34a" }}>{formatAmount(team.teamFact)}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: "#d97706" }}>{formatAmount(td.remaining)}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: td.lag > 0 ? "#dc2626" : "#16a34a" }}>{td.lag > 0 ? formatAmount(td.lag) : "✓"}</td>
                            {td.perWeek.map((v, i) => (
                              <td key={i} style={{ textAlign: "right", fontWeight: 600, background: sub }}>{formatAmount(v)}</td>
                            ))}
                            <td style={{ textAlign: "right", fontWeight: 600, background: sub }}>{formatAmount(td.perDay)}</td>
                          </tr>
                          {team.managers.map((m) => {
                            const d = decomp(m.plan, m.fact);
                            const draft = drafts[m.managerId];
                            const dirty = draft != null && Number(draft.replace(/[^\d.-]/g, "")) !== m.plan;
                            const isOpen = expanded.has(m.managerId);
                            const colSpan = 6 + grid.weeks.length;
                            return (
                              <Fragment key={m.managerId}>
                              <tr>
                                <td style={{ textAlign: "left", paddingLeft: 18 }}>
                                  <button onClick={() => toggleMgr(m.managerId)} title="Показати постійних клієнтів"
                                    style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text)", font: "inherit", padding: 0 }}>
                                    {m.clients.length > 0 ? (isOpen ? "▾ " : "▸ ") : ""}{m.name}
                                    {m.clients.length > 0 && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> ({m.clients.length})</span>}
                                  </button>
                                </td>
                                <td style={{ textAlign: "right" }}>
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
                                </td>
                                <td style={{ textAlign: "right", color: "#16a34a", fontWeight: 600 }} title={formatAmountFull(m.fact)}>{formatAmount(m.fact)}</td>
                                <td style={{ textAlign: "right", color: "#d97706", fontWeight: 600 }}>{formatAmount(d.remaining)}</td>
                                <td style={{ textAlign: "right", fontWeight: 600, color: d.lag > 0 ? "#dc2626" : "#16a34a" }}>{d.lag > 0 ? formatAmount(d.lag) : "✓"}</td>
                                {d.perWeek.map((v, i) => (
                                  <td key={i} style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(v)}</td>
                                ))}
                                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(d.perDay)}</td>
                              </tr>
                              {isOpen && m.clients.length > 0 && (
                                <tr>
                                  <td colSpan={colSpan} style={{ background: "var(--bg-subtle, rgba(127,127,127,0.05))", padding: "6px 10px 10px 26px" }}>
                                    <table className="data-table compact" style={{ fontSize: 12, minWidth: 560 }}>
                                      <thead>
                                        <tr><th style={{ textAlign: "left" }}>Постійний клієнт</th><th>Тип</th><th style={{ textAlign: "right" }}>Оплат</th><th style={{ textAlign: "right" }}>Сума (lifetime)</th><th style={{ textAlign: "right" }}>Остання</th></tr>
                                      </thead>
                                      <tbody>
                                        {m.clients.map((c, i) => (
                                          <tr key={i}>
                                            <td style={{ textAlign: "left" }}>{c.clientName}</td>
                                            <td style={{ color: "var(--text-muted)" }}>{c.isCompany ? "🏢 Компанія" : `👤 Фізособа${c.identifier ? " · " + c.identifier : ""}`}</td>
                                            <td style={{ textAlign: "right" }}>{c.orders}</td>
                                            <td style={{ textAlign: "right", fontWeight: 600 }}>{formatAmount(c.revenue)}</td>
                                            <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{c.lastPaid ? new Date(c.lastPaid).toLocaleDateString("uk-UA") : "—"}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              )}
                              </Fragment>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                    {(() => { const gd = decomp(grid.totalPlan, grid.totalFact); return (
                      <tr style={{ borderTop: "2px solid var(--border)" }}>
                        <td style={{ fontWeight: 800 }}>Разом по відділу</td>
                        <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(grid.totalPlan)}</td>
                        <td style={{ fontWeight: 800, textAlign: "right", color: "#16a34a" }}>{formatAmount(grid.totalFact)}</td>
                        <td style={{ fontWeight: 800, textAlign: "right", color: "#d97706" }}>{formatAmount(gd.remaining)}</td>
                        <td style={{ fontWeight: 800, textAlign: "right", color: gd.lag > 0 ? "#dc2626" : "#16a34a" }}>{gd.lag > 0 ? formatAmount(gd.lag) : "✓"}</td>
                        {gd.perWeek.map((v, i) => (
                          <td key={i} style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(v)}</td>
                        ))}
                        <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(gd.perDay)}</td>
                      </tr>
                    ); })()}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
