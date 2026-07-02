import { useState, type Dispatch, type SetStateAction } from "react";
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
import { fetchFunnelPlan, saveFunnelPlan, type ReportData, type FunnelReport, type FunnelStageRow, type ManagerOption } from "../../../api";
import { formatAmount } from "../format";

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
  onPlanSaved,
}: {
  title: string;
  report: ReportData | null;
  funnelReport: FunnelReport | null;
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
  onPlanSaved: () => void;
}) {
  const [planOpen, setPlanOpen] = useState(false);
  const s = report?.summary;
  const kpis = s
    ? [
        { label: "Отримані кошти", value: formatAmount(s.revenue), sub: `${s.deals} угод` },
        { label: "Успішно реалізовано", value: formatAmount(s.successRevenue), sub: `${s.successDeals} угод` },
        { label: "Оплата отримана", value: formatAmount(s.paymentRevenue), sub: `${s.paymentDeals} угод` },
        { label: "Середній чек", value: formatAmount(s.avgCheck), sub: "" },
        { label: "Прийнято реклами", value: s.adLeads.toLocaleString("uk-UA"), sub: "" },
        { label: "Передані заявки (лідоген)", value: s.transfers.toLocaleString("uk-UA"), sub: "" },
        { label: "Отримано прорахунків", value: s.quotes.toLocaleString("uk-UA"), sub: "" },
        { label: "Відправлено авто", value: s.dispatched.toLocaleString("uk-UA"), sub: formatAmount(s.dispatchedSum) },
        { label: "Створені угоди (Повний цикл)", value: s.createdDeals.toLocaleString("uk-UA"), sub: "" },
        { label: "Нові клієнти", value: s.newClients.toLocaleString("uk-UA"), sub: "" },
        { label: "Постійні клієнти", value: s.repeatClients.toLocaleString("uk-UA"), sub: "" },
        { label: "Перенесені з мин. міс.", value: formatAmount(s.carryover), sub: `${s.carryoverDeals} угод` },
        { label: "Дебіторка", value: formatAmount(s.receivables), sub: "" },
      ]
    : [];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <div className="page-filters">
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

      {loading ? (
        <p className="loading-text">Завантаження...</p>
      ) : !report ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <>
          <div className="kpi-grid">
            {kpis.map((k) => (
              <div className="kpi-card" key={k.label}>
                <span className="kpi-label">{k.label}</span>
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
                        <th>Запит</th>
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

          <div className="chart-card">
            <h2 className="chart-title">
              Динаміка отриманих коштів ({granularity === "day" ? "по днях" : granularity === "week" ? "по тижнях" : "по місяцях"})
            </h2>
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
                    <td>{formatAmount(p.avgCheck)}</td>
                    <td>{p.created}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.scope === "team" && report.byManager.length > 0 && (
            <div className="chart-card" style={{ overflowX: "auto" }}>
              <h2 className="chart-title">По менеджерах (повний зріз)</h2>
              <table className="data-table" style={{ minWidth: 920 }}>
                <thead>
                  <tr>
                    <th>Менеджер</th>
                    <th>Реклама</th>
                    <th>Передані</th>
                    <th>Прорахунки</th>
                    <th>Відпр. авто</th>
                    <th>Сума відпр.</th>
                    <th>Оплата отр. ₴</th>
                    <th>Успішно ₴</th>
                    <th>Успішно, шт</th>
                    <th>Сер. чек</th>
                    <th>Перенесені ₴</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byManager.map((m) => (
                    <tr key={m.managerId}>
                      <td>{m.name}</td>
                      <td>{m.adLeads}</td>
                      <td>{m.transfers}</td>
                      <td>{m.quotes}</td>
                      <td>{m.dispatched}</td>
                      <td>{formatAmount(m.dispatchedSum)}</td>
                      <td>{formatAmount(m.paymentReceived)}</td>
                      <td style={{ fontWeight: 600 }}>{formatAmount(m.successRevenue)}</td>
                      <td>{m.successDeals}</td>
                      <td>{formatAmount(m.avgCheck)}</td>
                      <td>{formatAmount(m.carryover)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
