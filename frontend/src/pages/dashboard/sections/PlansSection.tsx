import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchPlansGrid, savePlan, fetchLeadRecommendation, type PlansGrid, type Team, type LeadRecRow } from "../../../api";
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
  // Рекомендація «скільки лідів треба» — розкривний рядок по кліку на менеджера.
  // Вантажиться ОДИН раз на (місяць × період × команда) і роздається по managerId.
  const [openRec, setOpenRec] = useState<number | null>(null);
  const [recPeriod, setRecPeriod] = useState<"month" | "3m" | "year">("3m");
  const [rec, setRec] = useState<Map<number, LeadRecRow> | null>(null);

  useEffect(() => {
    let alive = true;
    setRec(null);
    fetchLeadRecommendation({ month, period: recPeriod, teamId: teamId ? Number(teamId) : undefined })
      .then((r) => { if (alive) setRec(new Map(r.rows.map((x) => [x.managerId, x]))); })
      .catch(() => { if (alive) setRec(new Map()); });
    return () => { alive = false; };
  }, [month, recPeriod, teamId, reload]);

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
                        <Fragment key={m.managerId}>
                        <tr>
                          <td style={{ textAlign: "left", paddingLeft: 18, cursor: "pointer", userSelect: "none" }}
                              title="Показати рекомендацію: скільки лідів треба взяти"
                              onClick={() => setOpenRec((o) => (o === m.managerId ? null : m.managerId))}>
                            <span style={{ color: "var(--text-muted)", fontSize: 11, marginRight: 5 }}>{openRec === m.managerId ? "▾" : "▸"}</span>
                            {m.name}
                          </td>
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
                        {openRec === m.managerId && (
                          <tr>
                            <td colSpan={9 + wkCols} style={{ background: sub, padding: "12px 18px" }}>
                              <LeadRec row={rec?.get(m.managerId) ?? null} loading={rec == null}
                                period={recPeriod} onPeriod={setRecPeriod} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
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

/**
 * Рекомендація «скільки лідів треба взяти» — розкривний рядок під менеджером.
 * 🔴 ЛИШЕ ПОКАЗУЄ: жодної кнопки збереження, план у БД не змінюється.
 * 🔴 Мало даних → «—» + причина. Нуль замість «—» був би вигаданою цифрою.
 */
function LeadRec({ row, loading, period, onPeriod }: {
  row: LeadRecRow | null; loading: boolean;
  period: "month" | "3m" | "year"; onPeriod: (p: "month" | "3m" | "year") => void;
}) {
  const MUTED = "var(--text-muted)";
  const cell = (label: string, value: React.ReactNode, hint?: string, strong?: boolean) => (
    <div style={{ minWidth: 108 }}>
      <div style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".3px" }}>{label}</div>
      <div style={{ fontSize: strong ? 19 : 15, fontWeight: strong ? 800 : 650, color: strong ? "#2f6fdb" : "var(--text)", lineHeight: 1.25 }}>{value}</div>
      {hint && <div style={{ fontSize: 10.5, color: MUTED }}>{hint}</div>}
    </div>
  );
  const dash = <span style={{ color: MUTED }}>—</span>;
  const periods: { k: "month" | "3m" | "year"; l: string }[] = [
    { k: "month", l: "місяць" }, { k: "3m", l: "3 міс" }, { k: "year", l: "рік" },
  ];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13 }}>🎯 Скільки лідів треба взяти</b>
        {row?.planBelowBase && (
          <span title="Прогноз по постійних клієнтах перевищує місячний план. «Треба 0» тут означає не «все добре», а що план нижчий за базу, яку менеджер і так приносить — привід переглянути план, а не розслабитись."
                style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 9px", borderRadius: 20, background: "rgba(217,119,6,0.14)", color: "#d97706", whiteSpace: "nowrap", cursor: "help" }}>
            ⚠️ план нижчий за базу постійних
          </span>
        )}
        {row?.unreachable && (
          <span title={`Потрібно ${row.leadsNeeded} лідів, а найкращий місяць за останні 6 — ${row.maxMonthlyLeads}. Цифра арифметично правильна, але як ціль нечитабельна: за поточної структури (конверсія × чек) план не забезпечений.`}
                style={{ fontSize: 10.5, fontWeight: 800, padding: "2px 9px", borderRadius: 20, background: "rgba(220,38,38,0.12)", color: "#dc2626", whiteSpace: "nowrap", cursor: "help" }}>
            🚫 недосяжно за поточної структури
          </span>
        )}
        <span style={{ fontSize: 11, color: MUTED }}>
          (план − прогноз по постійних) ÷ (конверсія × ср.чек){row ? ` · канал: ${row.channel === "ad" ? "реклама" : "лідоген"}` : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: MUTED }}>конверсія / чек за:</span>
          {periods.map((p) => (
            <button key={p.k} onClick={() => onPeriod(p.k)}
              style={{ padding: "3px 10px", borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${period === p.k ? "#2f6fdb" : "var(--border)"}`,
                background: period === p.k ? "rgba(47,111,219,0.12)" : "var(--card-bg)",
                color: period === p.k ? "#2f6fdb" : MUTED }}>{p.l}</button>
          ))}
        </span>
      </div>
      {loading ? <span style={{ fontSize: 12, color: MUTED }}>Завантаження…</span> : !row ? (
        <span style={{ fontSize: 12, color: MUTED }}>Немає даних для цього менеджера.</span>
      ) : (
        <>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
            {cell("План", formatAmount(row.plan))}
            {cell("Постійні дадуть", row.forecast != null ? formatAmount(row.forecast) : dash,
              row.forecastClients ? `${row.forecastClients} кл. · сер./міс за 6 міс` : "немає історії")}
            {cell("Залишок", row.remainder != null ? formatAmount(row.remainder) : dash, "план − постійні")}
            {/**
              * 🔀 ПІДПИС НАЗИВАЄ ОСНОВУ (рішення власника 21.08.2026). У продукті тепер
              * ДВІ різні «конверсії лідогену», і обидві правильні: тут знаменник —
              * РЕЄСТР ПЕРЕДАНИХ ЗАЯВОК (`lead_transfer_events` за `transfer_date`), а в
              * Звіті — когорта СТВОРЕНИХ угод за `lead_channel`. За серпень 2026 вони
              * дають 3.8% і 24.8% — розрив у 6.5 раза. Без підпису два правильні числа
              * на сусідніх екранах читаються як поломка.
              * ⚠️ Змінено ТІЛЬКИ підпис: `row.conversionPct` рахується тим самим
              * `conversionAdsByManager`/`conversionLeadgenByManager`, що й раніше.
              */}
            {cell(row.channel === "leadgen" ? "Конверсія (за передачами)" : "Конверсія (за прийнятою рекламою)",
              <>
                {row.conversionPct != null ? `${row.conversionPct}%` : dash}
                {(row.conversionSource === "team" || row.conversionSource === "company") && (
                  <span title={row.conversionSource === "team"
                    ? "Особистої конверсії не вистачає (менш як 10 заявок у періоді) — показано конверсію КОМАНДИ в цьому ж каналі. Це не особистий показник менеджера."
                    : "Немає ні особистої, ні командної конверсії — показано конверсію ВСІЄЇ КОМПАНІЇ в цьому ж каналі. Це не показник менеджера і не команди."}
                        style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 20, cursor: "help", verticalAlign: "middle",
                          background: row.conversionSource === "team" ? "rgba(47,111,219,0.14)" : "rgba(217,119,6,0.16)",
                          color: row.conversionSource === "team" ? "#2f6fdb" : "#d97706" }}>
                    {row.conversionSource === "team" ? "за конверсією команди" : "за конверсією компанії"}
                  </span>
                )}
              </>,
              row.conversionSource === "team" ? "особистих заявок замало"
                : row.conversionSource === "company" ? "ні своїх, ні командних"
                : `${row.conversionWon}/${row.conversionEntered} ${row.channel === "leadgen" ? "переданих заявок" : "прийнятих реклами"}`)}
            {cell("Ср. чек",
              <>
                {row.avgCheck != null ? formatAmount(row.avgCheck) : dash}
                {(row.avgCheckSource === "team" || row.avgCheckSource === "company") && (
                  <span title={row.avgCheckSource === "team"
                    ? "У менеджера немає успішних угод у періоді — показано середній чек КОМАНДИ. Це не особистий показник."
                    : "Немає ні своїх успішних угод, ні командних — показано середній чек ВСІЄЇ КОМПАНІЇ. Це не показник менеджера і не команди."}
                        style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 20, cursor: "help", verticalAlign: "middle",
                          background: row.avgCheckSource === "team" ? "rgba(47,111,219,0.14)" : "rgba(217,119,6,0.16)",
                          color: row.avgCheckSource === "team" ? "#2f6fdb" : "#d97706" }}>
                    {row.avgCheckSource === "team" ? "чек команди" : "чек компанії"}
                  </span>
                )}
              </>,
              row.avgCheckSource === "team" ? "своїх успішних угод немає"
                : row.avgCheckSource === "company" ? "ні своїх, ні командних" : "успішних угод")}
            {cell("₴ з ліда", row.perLead != null ? formatAmount(row.perLead) : dash, "конверсія × чек")}
            {cell("ТРЕБА ЛІДІВ", row.leadsNeeded != null ? row.leadsNeeded : dash,
              row.maxMonthlyLeads > 0 ? `макс за 6 міс: ${row.maxMonthlyLeads}` : undefined, true)}
          </div>
          {row.reasons.length > 0 && (
            <div style={{ marginTop: 9, fontSize: 11.5, color: "#d97706" }}>
              ⚠️ недостатньо даних: {row.reasons.join(" · ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
