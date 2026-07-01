import type { Dispatch, SetStateAction } from "react";
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
import type { ReportData, FunnelReport, FunnelStageRow } from "../../../api";
import { formatAmount } from "../format";

type DateRange = { from: string; to: string };
type Gran = "day" | "week" | "month";

function convPct(n: number, base: number): string {
  return base > 0 ? `${Math.round((n / base) * 100)}%` : "—";
}

function FunnelTable({ stages }: { stages: FunnelStageRow[] }) {
  const first = stages[0]?.total ?? 0;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Етап</th>
          <th>Нові</th>
          <th>Постійні</th>
          <th>Від лідогену</th>
          <th>Разом</th>
          <th>% від «Взято»</th>
          <th>% переходу</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((s, i) => (
          <tr key={s.stage}>
            <td>{s.label}</td>
            <td>{s.new}</td>
            <td>{s.regular}</td>
            <td>{s.leadgen}</td>
            <td style={{ fontWeight: 600 }}>{s.total}</td>
            <td>{convPct(s.total, first)}</td>
            <td>{i === 0 ? "—" : convPct(s.total, stages[i - 1].total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
}) {
  const s = report?.summary;
  const kpis = s
    ? [
        { label: "Отримані кошти", value: formatAmount(s.revenue), sub: `${s.deals} угод` },
        { label: "Успішно реалізовано", value: formatAmount(s.successRevenue), sub: `${s.successDeals} угод` },
        { label: "Оплата отримана", value: formatAmount(s.paymentRevenue), sub: `${s.paymentDeals} угод` },
        { label: "Середній чек", value: formatAmount(s.avgCheck), sub: "" },
        { label: "Створені угоди (Повний цикл)", value: s.createdDeals.toLocaleString("uk-UA"), sub: "" },
        { label: "Нові клієнти", value: s.newClients.toLocaleString("uk-UA"), sub: "" },
        { label: "Постійні клієнти", value: s.repeatClients.toLocaleString("uk-UA"), sub: "" },
        { label: "Дебіторка", value: formatAmount(s.receivables), sub: "" },
      ]
    : [];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <div className="page-filters">
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
                <h2 className="chart-title">Воронка клієнтів (когорта створених угод, розріз по типу клієнта)</h2>
                <FunnelTable stages={funnelReport.stages} />
              </div>
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
            <div className="chart-card">
              <h2 className="chart-title">По менеджерах</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Менеджер</th>
                    <th>Отримані кошти</th>
                    <th>Угод</th>
                    <th>Сер. чек</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byManager.map((m, i) => (
                    <tr key={m.managerId}>
                      <td>{["🥇", "🥈", "🥉"][i] ?? i + 1}</td>
                      <td>{m.name}</td>
                      <td style={{ fontWeight: 600 }}>{formatAmount(m.revenue)}</td>
                      <td>{m.deals}</td>
                      <td>{formatAmount(m.avgCheck)}</td>
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
