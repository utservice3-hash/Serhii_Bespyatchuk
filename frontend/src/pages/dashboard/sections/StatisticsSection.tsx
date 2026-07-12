import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  fetchStatisticsCatalog, fetchStatisticsValues, saveStatisticsManual,
  type StatCatalog, type StatDepartmentDef, type StatMetricDef, type StatValueRow,
} from "../../../api";

// Розділ «Статистики (відділи)» — авто-заміна ручної Google-таблиці показників.
// Структура (вкладки/метрики) будується ДИНАМІЧНО з /statistics/catalog —
// хардкоду переліку відділів/метрик тут немає. Історія — imported з листа,
// поточні sales-метрики — auto (CRM). Ручні комірки редагує ЛИШЕ admin.

type PeriodType = "month" | "week";
const ROW = "__total__"; // ключ рядка «Разом» / зведення без розрізу

// ── форматування ─────────────────────────────────────────────────────────────
function fmt(value: number | null, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (unit === "percent") return `${(value * 100).toFixed(1).replace(/\.0$/, "")}%`;
  if (unit === "count") return Math.round(value).toLocaleString("uk-UA");
  return Math.round(value).toLocaleString("uk-UA"); // uah, 0 знаків
}
// значення percent у БД зберігається часткою (0.0532) АБО як ціле з листа —
// нормалізуємо на показ: якщо |v|>1.5 для percent, це «5.32» → /100.
function pctNorm(v: number): number { return Math.abs(v) > 1.5 ? v / 100 : v; }

// ── мінімальний безпечний калькулятор формул derived (+ - * /) ───────────────
function evalFormula(formula: string, lookup: (k: string) => number | null): number | null {
  const tokens = formula.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const eat = () => tokens[i++];
  let bad = false;
  const factor = (): number => {
    const t = eat();
    if (t === "(") { const v = expr(); eat(); return v; }
    if (t !== undefined && /^[A-Za-z_]/.test(t)) { const v = lookup(t); if (v === null || v === undefined) { bad = true; return 0; } return v; }
    return Number(t);
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") { const op = eat(); const r = factor(); v = op === "*" ? v * r : (r === 0 ? (bad = true, 0) : v / r); }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = eat(); const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const result = expr();
  return bad ? null : result;
}

const SOURCE_BADGE: Record<string, { t: string; c: string }> = {
  auto: { t: "CRM", c: "#16a34a" },
  imported: { t: "лист", c: "#6b7280" },
  manual: { t: "ручне", c: "#b45309" },
  derived: { t: "форм.", c: "#6366f1" },
};

export default function StatisticsSection({ role }: { role?: string }) {
  const isAdmin = role === "admin";
  const [catalog, setCatalog] = useState<StatCatalog | null>(null);
  const [dept, setDept] = useState<string>("sales");
  const [ptype, setPtype] = useState<PeriodType>("month");
  const [rows, setRows] = useState<StatValueRow[]>([]);
  const [plans, setPlans] = useState<Record<string, number>>({});
  const [scopedTo, setScopedTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fullHistory, setFullHistory] = useState(false);
  const [chartMetric, setChartMetric] = useState<string>("revenue_won");
  const [editing, setEditing] = useState<{ ps: string; lead: string | null; key: string } | null>(null);
  const [editVal, setEditVal] = useState<string>("");

  const department: StatDepartmentDef | undefined = useMemo(
    () => catalog?.departments.find((d) => d.key === dept), [catalog, dept]
  );

  useEffect(() => { fetchStatisticsCatalog().then(setCatalog).catch(() => setCatalog(null)); }, []);

  // дефолтна метрика графіка при зміні відділу
  useEffect(() => {
    if (department) {
      const first = department.metrics.find((m) => m.unit === "uah") ?? department.metrics[0];
      setChartMetric(first.key);
    }
  }, [department]);

  const load = useMemo(() => async () => {
    if (!dept) return;
    setLoading(true);
    try {
      const from = fullHistory ? undefined : (() => {
        const d = new Date();
        if (ptype === "month") d.setMonth(d.getMonth() - 12);
        else d.setDate(d.getDate() - 7 * 16);
        return d.toISOString().slice(0, 10);
      })();
      const res = await fetchStatisticsValues({ department: dept, period_type: ptype, from });
      setRows(res.rows);
      setPlans(res.plans ?? {});
      setScopedTo(res.scopedTo);
    } finally { setLoading(false); }
  }, [dept, ptype, fullHistory]);
  useEffect(() => { load(); }, [load]);

  // pivot: period_start → lead → metric_key → {value, source}
  const pivot = useMemo(() => {
    const m = new Map<string, Map<string, Map<string, { value: number | null; source: string }>>>();
    for (const r of rows) {
      const lead = r.team_lead ?? ROW;
      if (!m.has(r.period_start)) m.set(r.period_start, new Map());
      const byLead = m.get(r.period_start)!;
      if (!byLead.has(lead)) byLead.set(lead, new Map());
      byLead.get(lead)!.set(r.metric_key, { value: r.value, source: r.source });
    }
    return m;
  }, [rows]);

  const periods = useMemo(() => [...pivot.keys()].sort().reverse(), [pivot]);
  const leads = useMemo(() => {
    if (!department?.hasTeamLeadBreakdown) return [ROW];
    const s = new Set<string>();
    for (const byLead of pivot.values()) for (const l of byLead.keys()) s.add(l);
    return [...s].filter((l) => l !== ROW).sort();
  }, [pivot, department]);

  // значення метрики (з урахуванням derived) для (period, lead)
  function metricValue(ps: string, lead: string, met: StatMetricDef): { value: number | null; source: string } {
    const cell = pivot.get(ps)?.get(lead);
    if (met.source === "derived" && met.formula) {
      const v = evalFormula(met.formula, (k) => {
        const c = pivot.get(ps)?.get(lead)?.get(k);
        return c ? c.value : null;
      });
      return { value: v, source: "derived" };
    }
    const c = cell?.get(met.key);
    if (!c) return { value: null, source: "" };
    return { value: met.unit === "percent" && c.value !== null ? pctNorm(c.value) : c.value, source: c.source };
  }

  // «Разом» по відділу за період. Якщо метрика має значення на РІВНІ ВІДДІЛУ
  // (team_lead=NULL, напр. calls з Ringostat — по менеджерах не розбити) —
  // показуємо його; інакше сума sum-метрик по лідах (avg/last — останнє).
  function totalValue(ps: string, met: StatMetricDef): number | null {
    if (met.source === "derived" && met.formula) {
      return evalFormula(met.formula, (k) => {
        const base = department!.metrics.find((mm) => mm.key === k);
        if (!base) return null;
        return totalValue(ps, base);
      });
    }
    // Пріоритет: розбивка по тімлідах (точніша). Якщо її нема — значення рівня
    // відділу (team_lead=NULL, напр. calls з живого API, коли ще нема per-lead).
    let sum = 0, has = false, last: number | null = null;
    for (const lead of leads) {
      const c = pivot.get(ps)?.get(lead)?.get(met.key);
      if (!c || c.value === null) continue;
      has = true; last = c.value; sum += c.value;
    }
    if (has) return met.aggregation === "sum" ? sum : last;
    const deptLevel = pivot.get(ps)?.get(ROW)?.get(met.key);
    if (deptLevel && deptLevel.value !== null) return deptLevel.value;
    return null;
  }

  // План/факт (R4): лише sales revenue_won помісячно.
  function sumPlanForMonth(ps: string): number {
    let s = 0; for (const [k, v] of Object.entries(plans)) if (k.startsWith(ps + "|")) s += v; return s;
  }
  function PlanBadge({ ps, lead, met, fact }: { ps: string; lead: string; met: StatMetricDef; fact: number | null }) {
    if (dept !== "sales" || ptype !== "month" || met.key !== "revenue_won") return null;
    const plan = lead === ROW ? sumPlanForMonth(ps) : (plans[`${ps}|${lead}`] ?? 0);
    if (!plan) return null;
    const pct = fact != null && plan > 0 ? Math.round((fact / plan) * 100) : null;
    return (
      <sup style={{ color: pct != null && pct >= 100 ? "#16a34a" : "#6366f1", fontSize: 9, marginLeft: 4 }}
        title={`План: ${Math.round(plan).toLocaleString("uk-UA")} грн`}>
        {pct != null ? `${pct}% пл` : ""}
      </sup>
    );
  }

  async function saveEdit() {
    if (!editing || !department) return;
    const raw = editVal.trim();
    const value = raw === "" ? null : Number(raw.replace(",", "."));
    if (value !== null && !Number.isFinite(value)) { setEditing(null); return; }
    // оптимістично
    const prev = rows;
    setRows((rs) => {
      const others = rs.filter((r) => !(r.period_start === editing.ps && (r.team_lead ?? ROW) === (editing.lead ?? ROW) && r.metric_key === editing.key));
      return [...others, { period_start: editing.ps, team_lead: editing.lead, metric_key: editing.key, value, source: "manual" }];
    });
    setEditing(null);
    try {
      await saveStatisticsManual({
        department: department.key, period_type: ptype, period_start: editing.ps,
        team_lead: editing.lead, values: { [editing.key]: value },
      });
    } catch { setRows(prev); alert("Не вдалося зберегти значення"); }
  }

  const chartData = useMemo(() => {
    const met = department?.metrics.find((m) => m.key === chartMetric);
    if (!met) return [];
    return periods.slice().reverse().map((ps) => ({
      period: ps,
      value: department!.hasTeamLeadBreakdown ? totalValue(ps, met) : metricValue(ps, ROW, met).value,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, chartMetric, department, pivot]);

  if (!catalog) return <p className="loading-text">Завантаження…</p>;

  const chartMetricDef = department?.metrics.find((m) => m.key === chartMetric);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Статистики (відділи)</h1>
        <div className="page-filters">
          <select value={ptype} onChange={(e) => setPtype(e.target.value as PeriodType)}>
            <option value="month">По місяцях</option>
            <option value="week">По тижнях</option>
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
            <input type="checkbox" checked={fullHistory} onChange={(e) => setFullHistory(e.target.checked)} />
            вся історія
          </label>
        </div>
      </div>

      {/* Вкладки відділів — динамічно з каталогу */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {catalog.departments.map((d) => (
          <button
            key={d.key}
            onClick={() => setDept(d.key)}
            style={{
              padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 14,
              border: dept === d.key ? "2px solid #c8102e" : "1px solid #d0d5dd",
              background: dept === d.key ? "#fdeaec" : "#fff",
              fontWeight: dept === d.key ? 600 : 400,
            }}
          >{d.label}</button>
        ))}
      </div>

      {scopedTo && (
        <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>
          Показано лише ваш розріз: <b>{scopedTo}</b>
        </p>
      )}

      {/* Графік динаміки */}
      {department && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h2 className="chart-title">Динаміка</h2>
            <select value={chartMetric} onChange={(e) => setChartMetric(e.target.value)}>
              {department.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="period" fontSize={11} />
              <YAxis fontSize={11} width={70} tickFormatter={(v) => fmt(v, chartMetricDef?.unit ?? "count")} />
              <Tooltip formatter={(v) => fmt(v as number, chartMetricDef?.unit ?? "count")} />
              <Line type="monotone" dataKey="value" stroke="#c8102e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Таблиця */}
      {loading ? <p className="loading-text">Завантаження…</p> : department && (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table compact">
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: "#fff" }}>Період</th>
                {department.hasTeamLeadBreakdown && <th>Тімлід</th>}
                {department.metrics.map((m) => (
                  <th key={m.key} title={m.note ?? m.formula ?? ""} style={{ whiteSpace: "nowrap" }}>{m.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.map((ps) => {
                const rowLeads = department.hasTeamLeadBreakdown ? leads : [ROW];
                return (
                  <>
                    {rowLeads.map((lead, li) => (
                      <tr key={ps + lead}>
                        {li === 0 && (
                          <td rowSpan={department.hasTeamLeadBreakdown ? rowLeads.length + 1 : 1}
                            style={{ position: "sticky", left: 0, background: "#fff", fontWeight: 600, verticalAlign: "top" }}>
                            {ps}
                          </td>
                        )}
                        {department.hasTeamLeadBreakdown && <td>{lead}</td>}
                        {department.metrics.map((met) => {
                          const { value, source } = metricValue(ps, lead, met);
                          const editable = isAdmin && met.source === "manual";
                          const isEditing = editing && editing.ps === ps && (editing.lead ?? ROW) === lead && editing.key === met.key;
                          const badge = SOURCE_BADGE[source];
                          return (
                            <td key={met.key}
                              onClick={() => { if (editable && !isEditing) { setEditing({ ps, lead: lead === ROW ? null : lead, key: met.key }); setEditVal(value === null ? "" : String(value)); } }}
                              style={{ whiteSpace: "nowrap", cursor: editable ? "pointer" : "default", background: editable ? "#fffdf5" : undefined }}
                              title={badge ? badge.t : ""}>
                              {isEditing ? (
                                <input autoFocus value={editVal}
                                  onChange={(e) => setEditVal(e.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(null); }}
                                  style={{ width: 90 }} />
                              ) : (
                                <span>{fmt(value, met.unit)}{badge && source && source !== "derived" && (
                                  <sup style={{ color: badge.c, fontSize: 9, marginLeft: 3 }}>{badge.t}</sup>
                                )}<PlanBadge ps={ps} lead={lead} met={met} fact={value} /></span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {department.hasTeamLeadBreakdown && (
                      <tr key={ps + "_total"} style={{ background: "#f7f8fa", fontWeight: 600 }}>
                        <td>Разом</td>
                        {department.metrics.map((met) => {
                          const tv = totalValue(ps, met);
                          return (
                            <td key={met.key} style={{ whiteSpace: "nowrap" }}>
                              {fmt(tv, met.unit)}<PlanBadge ps={ps} lead={ROW} met={met} fact={tv} />
                            </td>
                          );
                        })}
                      </tr>
                    )}
                  </>
                );
              })}
              {periods.length === 0 && (
                <tr><td colSpan={department.metrics.length + 2} style={{ textAlign: "center", color: "#6b7280" }}>Немає даних за період</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 8 }}>
        Джерело: <sup style={{ color: "#16a34a" }}>CRM</sup> авто · <sup style={{ color: "#6b7280" }}>лист</sup> історія ·{" "}
        <sup style={{ color: "#b45309" }}>ручне</sup> введено · форм. — розрахунок.
        {isAdmin && " Ручні комірки (жовті) — клік для редагування."}
      </p>
    </>
  );
}
