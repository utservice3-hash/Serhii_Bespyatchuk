import { Fragment, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import { DateRangeFilter, QuickPeriods } from "../../../components/DateRangeFilter";
import { fetchFunnelPlan, saveFunnelPlan, fetchTasks, updateTask, type Task, type ReportData, type FunnelReport, type FunnelStageRow, type ManagerOption, type Team, type FunnelWeeklyReport, type WeeklyBlock } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { InfoHint } from "../widgets";
import { DailyProductivityCard } from "./DailyProductivityCard";
import { StuckDealsCard } from "./StuckDealsCard";

const STATUS_LBL: Record<string, string> = {
  not_started: "Заплановано", todo_list: "Заплановано", to_realize: "До реалізації", planned: "Заплановано",
  deferred: "Відкладено", in_progress: "В роботі", ball_on_executor: "На виконавці",
  ready_for_approval: "На перевірці", done: "Готово",
};
const METRIC_LBL: Record<string, string> = {
  ads_count: "Реклама (шт)", leadgen_count: "Лідоген (шт)", avg_check: "Середній чек", conversion: "Конверсія",
  dispatch_count: "Авто (шт)", payment_amount: "Сума, ₴",
};

/** Manager drill-down: План/Факт + його задачі (тижневі KPI, в роботі тощо). */
function ManagerDetailModal({ m, onClose }: { m: ReportData["byManager"][number]; onClose: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    fetchTasks().then((all) => setTasks(all.filter((t) => t.assigneeId === m.managerId))).catch(() => setTasks([]));
  }, [m.managerId]);
  const fact = m.successRevenue + m.paymentReceived;
  const pct = m.plan > 0 ? Math.round((fact / m.plan) * 100) : null;
  const pctColor = pct == null ? "var(--text-muted)" : pct >= 100 ? "#16a34a" : pct >= 70 ? "#d97706" : "#dc2626";
  const kpi = tasks.filter((t) => t.taskType !== "simple");
  const manual = tasks.filter((t) => t.taskType === "simple" && t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 640, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>{m.name}</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>

        <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "0 0 8px" }}>План / Факт (місяць)</h3>
        <div className="kpi-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 8 }}>
          <div className="kpi-card"><span className="kpi-label">Факт (отримано)</span><span className="kpi-value">{formatAmount(fact)}</span></div>
          <div className="kpi-card"><span className="kpi-label">План на місяць</span><span className="kpi-value">{m.plan > 0 ? formatAmount(m.plan) : "—"}</span></div>
          <div className="kpi-card"><span className="kpi-label">Виконання</span><span className="kpi-value" style={{ color: pctColor }}>{pct != null ? `${pct}%` : "—"}</span></div>
        </div>
        {m.plan > 0 && (
          <div style={{ height: 8, borderRadius: 999, background: "var(--border)", overflow: "hidden", marginBottom: 16 }}>
            <div style={{ height: "100%", width: `${Math.min(100, pct ?? 0)}%`, background: pctColor, borderRadius: 999 }} />
          </div>
        )}

        {kpi.length > 0 && (
          <>
            <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "8px 0 8px" }}>KPI-план ({kpi.length})</h3>
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Метрика / період</th><th>Ціль</th><th>Факт</th><th>Статус</th></tr></thead>
              <tbody>
                {kpi.map((t) => (
                  <tr key={t.id}>
                    <td>{METRIC_LBL[t.metric ?? ""] ?? t.title}{t.periodStart ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {t.periodStart}…{t.periodEnd}</span> : null}</td>
                    <td>{t.targetValue ?? "—"}</td>
                    <td style={{ fontWeight: 600 }}>{t.actualValue ?? "—"}</td>
                    <td>{STATUS_LBL[t.status] ?? t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "8px 0 8px" }}>Задачі в роботі ({manual.length})</h3>
        {manual.length === 0 ? (
          <p className="loading-text" style={{ margin: 0 }}>Немає відкритих задач.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Задача</th><th>Джерело</th><th>Дедлайн</th><th>Статус</th></tr></thead>
            <tbody>
              {manual.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{t.createdByRole === "team_lead" || t.createdByRole === "admin" ? "від тімліда" : "власна"}</td>
                  <td>{t.deadline ?? "—"}</td>
                  <td>{STATUS_LBL[t.status] ?? t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {done.length > 0 && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>✔ Виконано за час: {done.length}</p>}

        <div style={{ marginTop: 16 }}>
          <StuckDealsCard managerId={m.managerId} />
        </div>
      </div>
    </div>
  );
}

/**
 * Selected manager's tasks for THIS week with the done/not-done fact — the KPI
 * plan the team-lead set, decomposed per working day, plus any manual tasks due
 * this week. Answers "які задачі стоять на тиждень і що виконано".
 */
function ManagerWeeklyTasks({ managerId }: { managerId: number }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    setTasks(null);
    fetchTasks().then((all) => setTasks(all.filter((t) => t.assigneeId === managerId))).catch(() => setTasks([]));
  }, [managerId]);

  // Current week, Mon–Sun.
  const now = new Date();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const ws = iso(monday), we = iso(sunday);
  const today = iso(now);
  const inWeek = (d: string | null) => d != null && d >= ws && d <= we;
  const WD = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const dayLabel = (d: string) => { const dt = new Date(d + "T00:00:00"); return `${WD[dt.getDay()]} ${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`; };

  if (tasks === null) return <div className="chart-card" style={{ marginBottom: 16 }}><p className="loading-text" style={{ margin: 0 }}>Завантаження задач…</p></div>;

  const kpiDays = tasks.filter((t) => t.taskType === "daily_kpi" && inWeek(t.planDate)).sort((a, b) => (a.planDate ?? "").localeCompare(b.planDate ?? ""));
  const manual = tasks.filter((t) => (t.taskType === "simple" || t.taskType === "reactivation") && inWeek(t.deadline));
  // Fact icon for a dated task: done → ✅, past & not done → ❌ (не виконав), else ⏳.
  const factIcon = (status: string, date: string | null) => status === "done" ? "✅" : (date && date < today ? "❌" : "⏳");

  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <h2 className="chart-title" style={{ marginBottom: 4 }}>📋 Задачі на тиждень</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>{dayLabel(ws)} — {dayLabel(we)} · ✅ виконано · ❌ не виконано · ⏳ попереду</p>
      {kpiDays.length === 0 && manual.length === 0 ? (
        <p className="loading-text" style={{ margin: 0 }}>На цей тиждень задач не поставлено.</p>
      ) : (
        <>
          {kpiDays.length > 0 && (
            <table className="data-table" style={{ marginBottom: manual.length ? 14 : 0 }}>
              <thead><tr><th>День</th><th>Показники (факт / ціль)</th><th style={{ textAlign: "center" }}>Факт</th></tr></thead>
              <tbody>
                {kpiDays.map((t) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: "nowrap", fontWeight: t.planDate === today ? 700 : 400 }}>{t.planDate ? dayLabel(t.planDate) : "—"}</td>
                    <td>
                      {(t.metricsJson && t.metricsJson.length > 0)
                        ? <span style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {t.metricsJson.map((m, i) => (
                              <span key={i} style={{ fontSize: 12 }}>
                                {METRIC_LBL[m.metric] ?? m.metric}: <b style={{ color: m.done ? "#16a34a" : "var(--text)" }}>{m.actual ?? "—"}</b>/{m.target}
                              </span>
                            ))}
                          </span>
                        : (METRIC_LBL[t.metric ?? ""] ?? t.title)}
                    </td>
                    <td style={{ textAlign: "center", whiteSpace: "nowrap" }} title={STATUS_LBL[t.status] ?? t.status}>{factIcon(t.status, t.planDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {manual.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Задача</th><th>Джерело</th><th>Дедлайн</th><th style={{ textAlign: "center" }}>Факт</th></tr></thead>
              <tbody>
                {manual.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{t.createdByRole === "team_lead" || t.createdByRole === "admin" ? "від тімліда" : "власна"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{t.deadline ?? "—"}</td>
                    <td style={{ textAlign: "center" }} title={STATUS_LBL[t.status] ?? t.status}>{factIcon(t.status, t.deadline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

/** Manager's task list inside the report — tasks set by themselves or the team-lead. */
function MyTasksBlock() {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => { fetchTasks().then(setTasks).catch(() => setTasks([])); }, []);
  const open = tasks.filter((t) => !t.auto && t.status !== "done");
  const move = (id: number, status: Task["status"]) => {
    setTasks((p) => p.map((t) => (t.id === id ? { ...t, status } : t)));
    updateTask(id, { status }).catch(() => {});
  };
  if (open.length === 0) return null;
  const overdue = (d: string | null) => d != null && new Date(d) < new Date(new Date().toDateString());
  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <h2 className="chart-title">Мої задачі ({open.length})</h2>
      <table className="data-table">
        <thead><tr><th>Задача</th><th>Джерело</th><th>Дедлайн</th><th>Пріоритет</th><th>Статус</th></tr></thead>
        <tbody>
          {open.map((t) => (
            <tr key={t.id}>
              <td>{t.title}{t.comments ? <span style={{ color: "var(--text-muted)", fontSize: 12 }}> — {t.comments}</span> : null}</td>
              <td>{t.createdByRole === "team_lead" || t.createdByRole === "admin"
                ? <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "rgba(245,158,11,0.15)", padding: "2px 8px", borderRadius: 999 }}>від тімліда</span>
                : <span style={{ fontSize: 11, color: "var(--text-muted)" }}>власна</span>}</td>
              <td style={overdue(t.deadline) ? { color: "#dc2626", fontWeight: 600 } : undefined}>{t.deadline ?? "—"}</td>
              <td>{t.priority === "high" ? "🔴 високий" : t.priority === "low" ? "🟢 низький" : "🟡 середній"}</td>
              <td>
                <select value={t.status} onChange={(e) => move(t.id, e.target.value as Task["status"])} style={{ fontSize: 12 }}>
                  <option value="not_started">Заплановано</option>
                  <option value="in_progress">В роботі</option>
                  <option value="done">Готово</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FUNNEL_STAGES: { stage: string; label: string }[] = [
  { stage: "lead_taken", label: "Взято в роботу лідів" },
  { stage: "quote_requested", label: "Отримано заявку на прорахунок" },
  { stage: "approved", label: "Договір/заявку погоджено" },
  { stage: "invoiced", label: "Виставлено рахунок" },
  { stage: "paid", label: "Оплата отримана" },
];

type DateRange = { from: string; to: string };
type Gran = "day" | "week" | "month";

function convPct(n: number, base: number): string {
  return base > 0 ? `${Math.round((n / base) * 100)}%` : "—";
}

function FunnelTable({ stages }: { stages: FunnelStageRow[] }) {
  const hasPlan = stages.some((s) => s.planMonth > 0);
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Етап</th>
          <th>Нові</th>
          <th>Постійні</th>
          <th>Лідоген</th>
          <th>Факт</th>
          {hasPlan && <th>План міс</th>}
          {hasPlan && <th>План сьогодні</th>}
          {hasPlan && <th>Викон. %</th>}
          {hasPlan && <th>Відставання</th>}
          <th>% переходу</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((s, i) => {
          const lag = s.planToDate - s.total; // >0 = behind pace
          return (
            <tr key={s.stage}>
              <td>{s.label}</td>
              <td>{s.new}</td>
              <td>{s.regular}</td>
              <td>{s.leadgen}</td>
              <td style={{ fontWeight: 600 }}>{s.total}</td>
              {hasPlan && <td>{s.planMonth || "—"}</td>}
              {hasPlan && <td>{s.planToDate || "—"}</td>}
              {hasPlan && (
                <td style={{ color: s.planMonth > 0 && s.total >= s.planToDate ? "#16a34a" : s.planMonth > 0 ? "#dc2626" : undefined }}>
                  {convPct(s.total, s.planMonth)}
                </td>
              )}
              {hasPlan && <td style={{ color: lag > 0 ? "#dc2626" : undefined }}>{s.planMonth > 0 ? (lag > 0 ? lag : 0) : "—"}</td>}
              <td>{i === 0 ? "—" : convPct(s.total, stages[i - 1].total)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ddmm(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

/** One "Звіт по воронці клієнтів" block. Columns Етап + Факт are frozen (via
 *  CSS .weekly-funnel), the weekly columns scroll horizontally. */
function WeeklyFunnelBlock({ block, weeks, highlight }: { block: WeeklyBlock; weeks: FunnelWeeklyReport["weeks"]; highlight?: boolean }) {
  // Plan columns are shown ONLY when a funnel plan is set for the month —
  // otherwise they are all "—" and just widen the table.
  const hasPlan = block.stages.some((s) => s.planMonth > 0);
  const perWeekCols = hasPlan ? 3 : 2;
  // Everything after the frozen "Факт" column (plan cols + weekly cols).
  const tailCols = (hasPlan ? 5 : 0) + weeks.length * perWeekCols;

  const moneyRow = (label: string, value: number, color: string | undefined, first: boolean) => {
    const bt = first ? "2px solid var(--border)" : undefined;
    return (
      <tr>
        <td style={{ fontWeight: 600, borderTop: bt }}>{label}</td>
        <td style={{ fontWeight: 700, color: color ?? "var(--text)", borderTop: bt }}>{formatAmount(value)}</td>
        {tailCols > 0 && <td colSpan={tailCols} style={{ borderTop: bt }} />}
      </tr>
    );
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ padding: "6px 12px", marginBottom: 4, borderRadius: 8, background: highlight ? "rgba(197,20,28,0.08)" : "var(--hover-bg, rgba(127,127,127,0.06))" }}>
        <strong style={{ fontSize: 14, color: highlight ? "#c5141c" : "var(--text)" }}>{block.name}</strong>
      </div>
      <div style={{ overflowX: "auto" }}>
      <table className="data-table weekly-funnel" style={{ fontSize: 12, minWidth: 270 + weeks.length * (hasPlan ? 3 * 74 + 70 : 2 * 78) + (hasPlan ? 300 : 0) }}>
        <thead>
          <tr>
            <th rowSpan={2}>Етап</th>
            <th rowSpan={2}>Факт</th>
            {hasPlan && <th rowSpan={2}>План<br />міс</th>}
            {hasPlan && <th rowSpan={2}>План<br />сьогодні</th>}
            {hasPlan && <th rowSpan={2}>Темп<br />плану %</th>}
            {hasPlan && <th rowSpan={2}>Викон.<br />міс %</th>}
            {hasPlan && <th rowSpan={2}>Відст.<br />шт</th>}
            {weeks.map((w) => (
              <th key={w.label} colSpan={perWeekCols} style={{ textAlign: "center", borderLeft: "2px solid var(--border)" }}>
                {w.label}<br /><span style={{ fontWeight: 400, fontSize: 10 }}>{ddmm(w.from)}–{ddmm(w.to)}</span>
              </th>
            ))}
          </tr>
          <tr>
            {weeks.map((w) => (
              <Fragment key={w.label}>
                {hasPlan && <th style={{ borderLeft: "2px solid var(--border)" }}>план</th>}
                <th style={hasPlan ? undefined : { borderLeft: "2px solid var(--border)" }}>факт</th>
                <th>% конв</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.stages.map((s, i) => {
            const prev = i > 0 ? block.stages[i - 1] : null;
            const tempo = s.planToday > 0 ? Math.round((s.factToday / s.planToday) * 100) : null;
            const exec = s.planMonth > 0 ? (s.factToday / s.planMonth) * 100 : null;
            const lag = Math.max(0, s.planToday - s.factToday);
            return (
              <tr key={s.stage}>
                <td style={{ fontWeight: 600 }}>{s.label}</td>
                <td style={{ fontWeight: 700, color: "#c5141c" }}>{s.factToday}</td>
                {hasPlan && <td>{s.planMonth || "—"}</td>}
                {hasPlan && <td>{s.planToday || "—"}</td>}
                {hasPlan && <td style={{ color: tempo != null ? (tempo >= 100 ? "#16a34a" : "#dc2626") : undefined }}>{tempo != null ? `${tempo}%` : "—"}</td>}
                {hasPlan && <td>{exec != null ? `${exec.toFixed(1)}%` : "—"}</td>}
                {hasPlan && <td style={{ color: s.planMonth > 0 && lag > 0 ? "#dc2626" : undefined }}>{s.planMonth > 0 ? lag : "—"}</td>}
                {s.weeks.map((w, wi) => {
                  const base = prev?.weeks[wi].fact ?? 0;
                  const conv = i > 0 && base > 0 ? `${Math.round((w.fact / base) * 100)}%` : i > 0 ? "—" : "";
                  return (
                    <Fragment key={wi}>
                      {hasPlan && <td style={{ borderLeft: "2px solid var(--border)", color: "var(--text-muted)" }}>{w.plan || "—"}</td>}
                      <td style={{ fontWeight: w.fact > 0 ? 700 : 400, borderLeft: hasPlan ? undefined : "2px solid var(--border)" }}>{w.fact}</td>
                      <td style={{ fontSize: 11 }}>{conv}</td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
          {moneyRow("Оплата отримана, ₴", block.money.received, "#16a34a", true)}
          {moneyRow("Перенесені з мин. міс., ₴", block.money.carryover, undefined, false)}
          {moneyRow("Очікувані оплати, ₴", block.money.expected, undefined, false)}
          {/* Отримані кошти по тижнях: план/факт/викон.%/відставання. План =
              місячний план виручки пропорційно роб. дням тижня; факт тижня =
              «Успішно» (142), закриті в тижні. */}
          {(block.money.weeks?.some((w) => w.plan > 0 || w.fact > 0)) && (() => {
            const mw = block.money.weeks;
            const hasMoneyPlan = block.money.planMonth > 0;
            const leadCols = 1 + (hasPlan ? 5 : 0); // клітинки після «Етап» до тижнів
            const weekCell = (wi: number, content: React.ReactNode, extra?: React.CSSProperties) => (
              <td key={wi} colSpan={perWeekCols} style={{ borderLeft: "2px solid var(--border)", textAlign: "center", ...extra }}>{content}</td>
            );
            return (
              <>
                {hasMoneyPlan && (
                  <tr>
                    <td style={{ fontWeight: 600, borderTop: "2px solid var(--border)" }}>💰 План, ₴</td>
                    <td colSpan={leadCols} style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>{formatAmount(block.money.planMonth)}</td>
                    {mw.map((w, wi) => weekCell(wi, w.plan ? formatAmount(w.plan) : "—", { color: "var(--text-muted)", borderTop: "2px solid var(--border)" }))}
                  </tr>
                )}
                <tr>
                  <td style={{ fontWeight: 600, borderTop: hasMoneyPlan ? undefined : "2px solid var(--border)" }}>💰 Факт (успішно), ₴</td>
                  <td colSpan={leadCols} style={{ fontWeight: 700, color: "#16a34a", borderTop: hasMoneyPlan ? undefined : "2px solid var(--border)" }}>
                    {formatAmount(mw.reduce((s, w) => s + w.fact, 0))}
                  </td>
                  {mw.map((w, wi) => weekCell(wi, w.fact ? formatAmount(w.fact) : "—", { fontWeight: 700, borderTop: hasMoneyPlan ? undefined : "2px solid var(--border)" }))}
                </tr>
                {hasMoneyPlan && (
                  <tr>
                    <td style={{ fontWeight: 600 }}>💰 Викон. % · відставання</td>
                    <td colSpan={leadCols} />
                    {mw.map((w, wi) => {
                      if (!w.plan) return weekCell(wi, "—");
                      const pct = Math.round((w.fact / w.plan) * 100);
                      const lag = Math.max(0, w.plan - w.fact);
                      return weekCell(wi, (
                        <span style={{ fontSize: 11 }}>
                          <b style={{ color: pct >= 100 ? "#16a34a" : "#dc2626" }}>{pct}%</b>
                          {lag > 0 ? <span style={{ color: "#dc2626" }}> · −{formatAmount(lag)}</span> : null}
                        </span>
                      ));
                    })}
                  </tr>
                )}
              </>
            );
          })()}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function PlanEditor({
  managerOptions,
  month,
  onClose,
  onSaved,
}: {
  managerOptions: ManagerOption[];
  month: string; // YYYY-MM
  onClose: () => void;
  onSaved: () => void;
}) {
  const [managerId, setManagerId] = useState<number | "">("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function pick(id: number) {
    setManagerId(id);
    try {
      const { plans } = await fetchFunnelPlan(id, month);
      const v: Record<string, string> = {};
      for (const s of FUNNEL_STAGES) v[s.stage] = plans[s.stage] != null ? String(plans[s.stage]) : "";
      setValues(v);
    } catch {
      setValues({});
    }
  }

  async function save() {
    if (managerId === "") return;
    setSaving(true);
    try {
      const plans: Record<string, number> = {};
      for (const s of FUNNEL_STAGES) plans[s.stage] = Number(values[s.stage] || 0);
      await saveFunnelPlan({ managerId: Number(managerId), month, plans });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 520 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>План на місяць ({month})</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>
        <select value={managerId} onChange={(e) => e.target.value && pick(Number(e.target.value))} style={{ width: "100%", marginBottom: 12 }}>
          <option value="">Оберіть менеджера…</option>
          {managerOptions.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        {managerId !== "" && (
          <>
            {FUNNEL_STAGES.map((s) => (
              <label key={s.stage} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8, fontSize: 13 }}>
                {s.label}
                <input
                  type="number"
                  value={values[s.stage] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [s.stage]: e.target.value }))}
                  style={{ width: 110 }}
                />
              </label>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={onClose}>Скасувати</button>
              <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Збереження…" : "Зберегти план"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ReportSection({
  title,
  report,
  funnelReport,
  funnelWeekly,
  loading,
  granularity,
  setGranularity,
  dateRange,
  setDateRange,
  datePreset,
  setDatePreset,
  canEditPlan,
  canPickManager,
  managerOptions,
  reportManagerId,
  setReportManagerId,
  canPickTeam,
  teams,
  reportTeamId,
  setReportTeamId,
  onPlanSaved,
}: {
  title: string;
  report: ReportData | null;
  funnelReport: FunnelReport | null;
  funnelWeekly: FunnelWeeklyReport | null;
  loading: boolean;
  granularity: Gran;
  setGranularity: Dispatch<SetStateAction<Gran>>;
  dateRange: DateRange;
  setDateRange: Dispatch<SetStateAction<DateRange>>;
  datePreset: string | null;
  setDatePreset: Dispatch<SetStateAction<string | null>>;
  canEditPlan: boolean;
  canPickManager: boolean;
  managerOptions: ManagerOption[];
  reportManagerId: number | "";
  setReportManagerId: Dispatch<SetStateAction<number | "">>;
  canPickTeam: boolean;
  teams: Team[];
  reportTeamId: number | "";
  setReportTeamId: Dispatch<SetStateAction<number | "">>;
  onPlanSaved: () => void;
}) {
  const [planOpen, setPlanOpen] = useState(false);
  const [detailMgr, setDetailMgr] = useState<ReportData["byManager"][number] | null>(null);
  const s = report?.summary;
  const kpis = s
    ? [
        { label: "Отримані кошти", value: formatAmount(s.revenue), sub: `${s.deals} угод`, hint: "«Успішно реалізовано» (статус 142, за датою закриття в періоді) + «Оплата отримана» (поточний етап, знімок)." },
        { label: "Успішно реалізовано", value: formatAmount(s.successRevenue), sub: `${s.successDeals} угод`, hint: "Угоди в статусі «Успішна угода» (142), за датою закриття угоди в періоді." },
        { label: "Оплата отримана", value: formatAmount(s.paymentRevenue), sub: `${s.paymentDeals} угод`, hint: "Угоди, що ЗАРАЗ на етапі «Оплата отримана» (знімок поточного стану, без фільтра дати)." },
        { label: "⏳ Очікування оплати", value: formatAmount(s.expected), sub: "виставлені рахунки", hint: "Гроші на етапі «Виставлено рахунок» (знімок поточного стану) — виставлені рахунки, що очікують оплати. Ще НЕ в «Отриманих коштах»." },
        { label: "Середній чек", value: formatAmountFull(s.avgCheck), sub: "", hint: "Отримані кошти ÷ кількість угод." },
        { label: "Прийнято реклами", value: s.adLeads.toLocaleString("uk-UA"), sub: "", hint: "Кількість лідів із реклами (google-utm) за період." },
        { label: "Передані заявки (лідоген)", value: s.transfers.toLocaleString("uk-UA"), sub: "", hint: "Заявки, які лідоген передав менеджеру (зміна відповідального в «Кваліфікації») за період." },
        { label: "Отримано прорахунків", value: s.quotes.toLocaleString("uk-UA"), sub: "", hint: "Ліди, що дійшли до етапу «Прорахунок» (запит КП) за період." },
        { label: "Відправлено авто", value: s.dispatched.toLocaleString("uk-UA"), sub: formatAmount(s.dispatchedSum), hint: "Угоди, що перейшли на етап «Авто працює» (машина в рейсі) за період." },
        { label: "Створені угоди (Повний цикл)", value: s.createdDeals.toLocaleString("uk-UA"), sub: "", hint: "Створені угоди повного циклу (пайплайни New + старий) за датою створення в періоді." },
        { label: "Нові клієнти", value: s.newClients.toLocaleString("uk-UA"), sub: "", hint: "Клієнти, чия перша оплата за всю історію припала на період." },
        { label: "Постійні клієнти", value: s.repeatClients.toLocaleString("uk-UA"), sub: "", hint: "Клієнти з 2+ оплаченими перевезеннями lifetime, що замовляли в періоді." },
        { label: "Перенесені з мин. міс.", value: formatAmount(s.carryover), sub: `${s.carryoverDeals} угод`, hint: "Знімок угод, ще в роботі на 1-ше число місяця (рахунок → оплата, крім «Успішна»)." },
        { label: "Дебіторка", value: formatAmount(s.receivables), sub: "", hint: "Сума неоплаченої дебіторки з Google-таблиці (оновлюється кожні 30 хв)." },
      ]
    : [];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <div className="page-filters">
          {canPickTeam && (
            <select
              value={reportTeamId}
              onChange={(e) => { setReportTeamId(e.target.value ? Number(e.target.value) : ""); setReportManagerId(""); }}
              title="Детально по команді"
            >
              <option value="">Усі команди</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          {canPickManager && (
            <select
              value={reportManagerId}
              onChange={(e) => setReportManagerId(e.target.value ? Number(e.target.value) : "")}
              title="Детально по менеджеру"
            >
              <option value="">Уся команда</option>
              {managerOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as Gran)}>
            <option value="day">По днях</option>
            <option value="week">По тижнях</option>
            <option value="month">По місяцях</option>
          </select>
          <DateRangeFilter
            value={dateRange}
            onChange={(r) => { setDateRange(r); setDatePreset(null); }}
          />
        </div>
      </div>

      <QuickPeriods active={datePreset} onSelect={(id, range) => { setDatePreset(id); setDateRange(range); }} />

      {!canPickManager && <DailyProductivityCard />}
      {canPickManager && reportManagerId !== "" && <DailyProductivityCard managerId={Number(reportManagerId)} />}
      {canPickManager && reportManagerId !== "" && <ManagerWeeklyTasks managerId={Number(reportManagerId)} />}
      {!canPickManager && <MyTasksBlock />}
      {!canPickManager && <StuckDealsCard />}
      {canPickManager && (
        <StuckDealsCard
          managerId={reportManagerId ? Number(reportManagerId) : undefined}
          teamId={reportTeamId ? Number(reportTeamId) : undefined}
        />
      )}

      {loading ? (
        <p className="loading-text">Завантаження...</p>
      ) : !report ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <>
          <div className="kpi-grid">
            {kpis.map((k) => (
              <div className="kpi-card" key={k.label}>
                <span className="kpi-label">{k.label}{k.hint && <InfoHint text={k.hint} />}</span>
                <span className="kpi-value">{k.value}</span>
                {k.sub && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{k.sub}</span>}
              </div>
            ))}
          </div>

          {funnelReport && (
            <>
              <div className="chart-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <h2 className="chart-title" style={{ marginBottom: 0 }}>Воронка клієнтів (когорта створених угод, розріз по типу клієнта)</h2>
                  {canEditPlan && (
                    <button
                      onClick={() => setPlanOpen(true)}
                      style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#c5141c", color: "#fff", fontWeight: 600, cursor: "pointer" }}
                    >
                      ✏️ План на місяць
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 8px" }}>
                  Робочих днів: {funnelReport.workingDays.elapsed} з {funnelReport.workingDays.total} (план на сьогодні пропорційний)
                </p>
                <FunnelTable stages={funnelReport.stages} />
              </div>
              {planOpen && (
                <PlanEditor
                  managerOptions={managerOptions}
                  month={funnelReport.month.slice(0, 7)}
                  onClose={() => setPlanOpen(false)}
                  onSaved={onPlanSaved}
                />
              )}
              {funnelReport.scope === "team" && funnelReport.byManager.length > 0 && (
                <div className="chart-card">
                  <h2 className="chart-title">Воронка по менеджерах</h2>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Менеджер</th>
                        <th>Взято</th>
                        <th>Прорахунок</th>
                        <th>Погоджено</th>
                        <th>Рахунок</th>
                        <th>Оплата</th>
                        <th>Конв.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funnelReport.byManager.map((m) => {
                        const t = (i: number) => m.stages[i]?.total ?? 0;
                        return (
                          <tr key={m.managerId}>
                            <td>{m.name}</td>
                            <td>{t(0)}</td>
                            <td>{t(1)}</td>
                            <td>{t(2)}</td>
                            <td>{t(3)}</td>
                            <td style={{ fontWeight: 600 }}>{t(4)}</td>
                            <td>{convPct(t(4), t(0))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {funnelWeekly && (
            <div className="chart-card">
              <h2 className="chart-title" style={{ marginBottom: 4 }}>Звіт по воронці клієнтів (тижнева динаміка)</h2>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 12px" }}>
                Факт = входи угод у етап за подіями CRM. Робочих днів: {funnelWeekly.workingDays.elapsed} з {funnelWeekly.workingDays.total}.
                «Темп» = факт ÷ план на сьогодні; «Викон.» = факт ÷ план місяця; «% конв» тижня = етап ÷ попередній етап.
              </p>
              <WeeklyFunnelBlock block={funnelWeekly.overall} weeks={funnelWeekly.weeks} highlight />
              {funnelWeekly.byManager.map((m) => (
                <WeeklyFunnelBlock key={m.managerId} block={m} weeks={funnelWeekly.weeks} />
              ))}
            </div>
          )}

          <div className="chart-card">
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h2 className="chart-title" style={{ marginBottom: 0 }}>Динаміка отриманих коштів</h2>
              <div style={{ display: "flex", gap: 6 }}>
                {(["day", "week", "month"] as const).map((g) => (
                  <button key={g} onClick={() => setGranularity(g)}
                    style={{ padding: "5px 13px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: granularity === g ? 700 : 500,
                      border: `1px solid ${granularity === g ? "#c5141c" : "var(--border)"}`,
                      background: granularity === g ? "#c5141c" : "var(--card-bg)", color: granularity === g ? "#fff" : "var(--text)" }}>
                    {g === "day" ? "Дні" : g === "week" ? "Тижні" : "Місяці"}
                  </button>
                ))}
              </div>
            </div>
            {report.byPeriod.length === 0 ? (
              <p className="loading-text">Немає даних за період.</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={report.byPeriod} margin={{ top: 22 }}>
                  <defs>
                    <linearGradient id="reportBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e11d2a" />
                      <stop offset="100%" stopColor="#8f0f1c" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v) => formatAmount(Number(v))} cursor={{ fill: "rgba(197,20,28,0.06)" }} />
                  <Bar dataKey="revenue" name="Отримані кошти" fill="url(#reportBar)" radius={[6, 6, 0, 0]} maxBarSize={64}>
                    <LabelList dataKey="revenue" position="top" formatter={(v) => formatAmount(Number(v))} style={{ fontSize: 10, fontWeight: 600, fill: "var(--text)" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="chart-card">
            <h2 className="chart-title">Розбивка по періодах</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Період</th>
                  <th>Отримані кошти</th>
                  <th>Угод</th>
                  <th>Сер. чек</th>
                  <th>Створено угод</th>
                </tr>
              </thead>
              <tbody>
                {report.byPeriod.map((p) => (
                  <tr key={p.period}>
                    <td>{p.period}</td>
                    <td style={{ fontWeight: 600 }}>{formatAmount(p.revenue)}</td>
                    <td>{p.deals}</td>
                    <td>{formatAmountFull(p.avgCheck)}</td>
                    <td>{p.created}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.scope === "team" && report.byManager.length > 0 && (
            <div className="chart-card" style={{ overflowX: "auto" }}>
              <h2 className="chart-title">По менеджерах (повний зріз)</h2>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>Натисніть на менеджера — План/Факт і задачі.</p>
              <table className="data-table" style={{ minWidth: 1000 }}>
                <thead>
                  <tr>
                    <th>Менеджер</th>
                    <th>План/Факт</th>
                    <th>Реклама</th>
                    <th>Передані</th>
                    <th>Прорахунки</th>
                    <th>Відпр. авто</th>
                    <th>Сума відпр.</th>
                    <th>Оплата отр. ₴</th>
                    <th title="Виставлені рахунки, що очікують оплати">Очікування ₴</th>
                    <th>Успішно ₴</th>
                    <th>Успішно, шт</th>
                    <th>Сер. чек</th>
                    <th>Перенесені ₴</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byManager.map((m) => {
                    const fact = m.successRevenue + m.paymentReceived;
                    const pct = m.plan > 0 ? Math.round((fact / m.plan) * 100) : null;
                    const pc = pct == null ? "var(--text-muted)" : pct >= 100 ? "#16a34a" : pct >= 70 ? "#d97706" : "#dc2626";
                    return (
                      <tr key={m.managerId} onClick={() => setDetailMgr(m)} style={{ cursor: "pointer" }} title="Деталі: План/Факт і задачі">
                        <td style={{ fontWeight: 600 }}>{m.name}</td>
                        <td style={{ color: pc, fontWeight: 600, whiteSpace: "nowrap" }}>{pct != null ? `${pct}%` : "—"}</td>
                        <td>{m.adLeads}</td>
                        <td>{m.transfers}</td>
                        <td>{m.quotes}</td>
                        <td>{m.dispatched}</td>
                        <td>{formatAmount(m.dispatchedSum)}</td>
                        <td>{formatAmount(m.paymentReceived)}</td>
                        <td style={{ color: "#d97706", fontWeight: 600 }}>{formatAmount(m.expected)}</td>
                        <td style={{ fontWeight: 600 }}>{formatAmount(m.successRevenue)}</td>
                        <td>{m.successDeals}</td>
                        <td>{formatAmountFull(m.avgCheck)}</td>
                        <td>{formatAmount(m.carryover)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {detailMgr && <ManagerDetailModal m={detailMgr} onClose={() => setDetailMgr(null)} />}
    </>
  );
}
