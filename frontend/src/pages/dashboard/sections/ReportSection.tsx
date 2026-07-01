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
import type { ReportData } from "../../../api";
import { formatAmount } from "../format";

type DateRange = { from: string; to: string };
type Gran = "day" | "week" | "month";

export function ReportSection({
  title,
  report,
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
