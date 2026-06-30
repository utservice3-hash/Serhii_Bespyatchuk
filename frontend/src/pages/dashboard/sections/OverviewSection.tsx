import type { Dispatch, SetStateAction } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { DateRangeFilter, QuickPeriods } from "../../../components/DateRangeFilter";
import type { ConversionChannel, ExecutiveOverview, FunnelStage, Team } from "../../../api";
import { formatAmount, previousRange } from "../format";
import { ProgressGauge, HoverInfoCard } from "../widgets";

type DateRange = { from: string; to: string };

export type Kpi = {
  key: string;
  label: string;
  value: string;
  cur: number;
  prev: number;
  unit?: string;
};

export function OverviewSection({
  teamId,
  setTeamId,
  teams,
  granularity,
  setGranularity,
  dateRange,
  setDateRange,
  datePreset,
  setDatePreset,
  kpis,
  prevStages,
  prevOverview,
  kpiDetail,
  setKpiDetail,
  overview,
  conversionChannels,
  loading,
  chartData,
}: {
  teamId: number | "";
  setTeamId: Dispatch<SetStateAction<number | "">>;
  teams: Team[];
  granularity: "day" | "week" | "month";
  setGranularity: Dispatch<SetStateAction<"day" | "week" | "month">>;
  dateRange: DateRange;
  setDateRange: Dispatch<SetStateAction<DateRange>>;
  datePreset: string | null;
  setDatePreset: Dispatch<SetStateAction<string | null>>;
  kpis: Kpi[];
  prevStages: FunnelStage[];
  prevOverview: ExecutiveOverview | null;
  kpiDetail: string | null;
  setKpiDetail: Dispatch<SetStateAction<string | null>>;
  overview: ExecutiveOverview | null;
  conversionChannels: ConversionChannel[];
  loading: boolean;
  chartData: { name: string; count: number; amount: number }[];
}) {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Огляд продажів</h1>
        <div className="page-filters">
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">Усі команди</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <select value={granularity} onChange={(e) => setGranularity(e.target.value as "day" | "week" | "month")}>
            <option value="day">По днях</option>
            <option value="week">По тижнях</option>
            <option value="month">По місяцях</option>
          </select>

          <DateRangeFilter
            value={dateRange}
            onChange={(r) => {
              setDateRange(r);
              setDatePreset(null);
            }}
          />
        </div>
      </div>

      <QuickPeriods
        active={datePreset}
        onSelect={(id, range) => {
          setDatePreset(id);
          setDateRange(range);
        }}
      />

      <div className="kpi-grid">
        {kpis.map((kpi) => {
          const hasPrev = prevStages.length > 0 || prevOverview !== null;
          const diff = kpi.cur - kpi.prev;
          const pct = kpi.prev > 0 ? Math.round((diff / kpi.prev) * 100) : kpi.cur > 0 ? 100 : 0;
          const color = diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : "#667085";
          const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
          return (
            <button
              className="kpi-card"
              key={kpi.key}
              onClick={() => setKpiDetail(kpi.key)}
              style={{ textAlign: "left", border: "none", cursor: "pointer", background: "var(--card-bg)" }}
              title="Натисніть для деталей"
            >
              <span className="kpi-label">{kpi.label}</span>
              <span className="kpi-value">{kpi.value}</span>
              {hasPrev && (
                <span style={{ fontSize: 12, color, fontWeight: 600 }}>
                  {arrow} {Math.abs(pct)}% до попер. періоду
                </span>
              )}
            </button>
          );
        })}
      </div>

      {kpiDetail && (() => {
        const kpi = kpis.find((k) => k.key === kpiDetail)!;
        const diff = kpi.cur - kpi.prev;
        const pct = kpi.prev > 0 ? Math.round((diff / kpi.prev) * 100) : kpi.cur > 0 ? 100 : 0;
        const fmt = (n: number) =>
          kpi.unit === "%" ? `${Math.round(n)}%` : kpi.key === "sum" || kpi.key === "avg" ? formatAmount(n) : n.toLocaleString("uk-UA");
        const showTeams = kpi.key === "sum" || kpi.key === "deals";
        return (
          <div onClick={() => setKpiDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 640, maxHeight: "85vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 className="chart-title">{kpi.label} — деталі</h2>
                <button onClick={() => setKpiDetail(null)} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
              </div>
              <div className="kpi-grid" style={{ marginBottom: 16 }}>
                <div className="kpi-card">
                  <span className="kpi-label">Поточний період</span>
                  <span className="kpi-value">{fmt(kpi.cur)}</span>
                  {dateRange.from && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{dateRange.from} — {dateRange.to}</span>}
                </div>
                <div className="kpi-card">
                  <span className="kpi-label">Попередній період</span>
                  <span className="kpi-value">{fmt(kpi.prev)}</span>
                  {dateRange.from && dateRange.to && (() => { const p = previousRange(dateRange.from, dateRange.to); return <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.from} — {p.to}</span>; })()}
                </div>
                <div className="kpi-card"><span className="kpi-label">Зміна</span><span className="kpi-value" style={{ color: diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : undefined }}>{diff > 0 ? "↑" : diff < 0 ? "↓" : "→"} {Math.abs(pct)}%</span></div>
              </div>

              {kpi.key === "sum" && overview && (
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 14, margin: "0 0 8px", color: "var(--text-muted)" }}>Розбивка отриманих коштів</h3>
                  <div className="kpi-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <div className="kpi-card">
                      <span className="kpi-label">Успішно реалізовано (закрито за період)</span>
                      <span className="kpi-value">{formatAmount(overview.successRevenue)}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{overview.successDeals} угод</span>
                    </div>
                    <div className="kpi-card">
                      <span className="kpi-label">Оплата отримана (поточний етап)</span>
                      <span className="kpi-value">{formatAmount(overview.paymentRevenue)}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{overview.paymentDeals} угод</span>
                    </div>
                  </div>
                </div>
              )}

              {overview && overview.monthlyHistory.length > 0 && (() => {
                const fieldByKey: Record<string, string> = {
                  deals: "deals",
                  sum: "revenue",
                  convAd: "adConversion",
                  convLg: "leadgenConversion",
                  avg: "avgCheck",
                  newc: "newClients",
                  repc: "repeatClients",
                };
                const field = fieldByKey[kpi.key];
                if (!field) return null;
                const isMoney = kpi.key === "sum" || kpi.key === "avg";
                return (
                  <div style={{ marginBottom: 16 }}>
                    <h3 style={{ fontSize: 14, margin: "0 0 8px", color: "var(--text-muted)" }}>Історія за 3 місяці</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={overview.monthlyHistory}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" />
                        <YAxis tickFormatter={(v) => isMoney ? `${Math.round(v / 1000)}k` : String(v)} />
                        <Tooltip formatter={(v) => isMoney ? formatAmount(Number(v)) : kpi.unit === "%" ? `${v}%` : Number(v).toLocaleString("uk-UA")} />
                        <Bar dataKey={field} name={kpi.label} fill="#c5141c" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                );
              })()}
              {showTeams && overview && (
                <table className="data-table">
                  <thead><tr><th>Команда</th><th>Виручка</th><th>Угод</th></tr></thead>
                  <tbody>
                    {overview.byTeam.map((t) => (
                      <tr key={t.teamId}><td>{t.teamName}</td><td>{formatAmount(t.revenue)}</td><td>{t.deals}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })()}

      {overview && (
        <>
          <div className="kpi-grid">
            <ProgressGauge
              plan={overview.plan}
              fact={overview.fact}
              pct={overview.planPct}
              contributors={overview.byTeam.map((t) => ({ name: t.teamName, revenue: t.revenue, deals: t.deals }))}
            />
            <HoverInfoCard
              label="Очікувані оплати"
              value={`${overview.pendingPayments.deals} угод · ${formatAmount(overview.pendingPayments.revenue)}`}
              rows={overview.pendingPayments.byTeam}
            />
            <div className="kpi-card">
              <span className="kpi-label">Створені угоди (Повний цикл)</span>
              <span className="kpi-value">{overview.createdFullCycle.toLocaleString("uk-UA")}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Виручка від нових клієнтів</span>
              <span className="kpi-value">{formatAmount(overview.newRevenue)}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Дебіторська заборгованість</span>
              <span className="kpi-value">{formatAmount(overview.receivablesTotal)}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label" title="Частка виручки від постійних (повторних) клієнтів у загальній виручці за період">Виручка від постійних клієнтів, %</span>
              <span className="kpi-value">
                {overview.newRevenue + overview.repeatRevenue > 0
                  ? Math.round(
                      (overview.repeatRevenue / (overview.newRevenue + overview.repeatRevenue)) * 100
                    )
                  : 0}
                %
              </span>
            </div>
          </div>

          <div className="chart-grid">
            <div className="chart-card">
              <h2 className="chart-title">Виручка по командах</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={overview.byTeam} margin={{ bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="teamName" interval={0} tick={{ fontSize: 11 }} angle={-15} textAnchor="end" height={50} />
                  <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v) => formatAmount(Number(v))} />
                  <Bar dataKey="revenue" name="Виручка" fill="#c5141c" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-card">
              <h2 className="chart-title">Топ-10 менеджерів за виручкою</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Менеджер</th>
                    <th>Виручка</th>
                    <th>Угод</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.topManagers.map((m, i) => (
                    <tr key={m.managerId}>
                      <td>{i + 1}</td>
                      <td>{m.name}</td>
                      <td>{formatAmount(m.revenue)}</td>
                      <td>{m.deals}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {conversionChannels.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <h2 className="chart-title">Конверсія за джерелом</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Джерело</th>
                <th>Лідів</th>
                <th>Оплачено</th>
                <th>Конверсія</th>
                <th>Сума оплат</th>
              </tr>
            </thead>
            <tbody>
              {conversionChannels.map((c) => (
                <tr key={c.channel}>
                  <td>{c.label}</td>
                  <td>{c.leads.toLocaleString("uk-UA")}</td>
                  <td>{c.paid.toLocaleString("uk-UA")}</td>
                  <td>{c.conversion}%</td>
                  <td>{formatAmount(c.paidAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading ? (
        <p className="loading-text">Завантаження...</p>
      ) : (
        <div className="chart-grid">
          <div className="chart-card">
            <h2 className="chart-title">Воронка продажів</h2>
            <ResponsiveContainer width="100%" height={340}>
              <BarChart data={chartData} margin={{ bottom: 24 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} tick={{ fontSize: 12 }} angle={-15} textAnchor="end" height={50} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="count" fill="#c5141c" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </>
  );
}
