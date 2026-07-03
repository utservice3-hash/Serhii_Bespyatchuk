import { useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
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
import type { ConversionChannel, ExecutiveOverview, FunnelStage, SyncStatus, Team } from "../../../api";
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
  isManager,
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
  syncStatus,
  syncing,
  canSync,
  onManualSync,
}: {
  isManager: boolean;
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
  syncStatus: SyncStatus | null;
  syncing: boolean;
  canSync: boolean;
  onManualSync: () => void;
}) {
  const [showTransferred, setShowTransferred] = useState(false);
  const [cardDetail, setCardDetail] = useState<null | "created" | "newRev" | "repeatRev">(null);
  const clickableCard: CSSProperties = { textAlign: "left", border: "none", cursor: "pointer", background: "var(--card-bg)" };
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Огляд продажів</h1>
        <div className="page-filters">
          {syncStatus && (
            <span
              title={
                syncStatus.lastSuccessAt
                  ? `Оновлено: ${new Date(syncStatus.lastSuccessAt).toLocaleString("uk-UA")}`
                  : "Ще не синхронізовано"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: syncStatus.stale ? "#dc2626" : "#16a34a",
                fontWeight: 600,
              }}
            >
              {syncStatus.stale ? "⚠️" : "🟢"}
              {syncStatus.ageMinutes != null ? `${syncStatus.ageMinutes} хв тому` : "—"}
            </span>
          )}
          {canSync && (
            <button
              onClick={onManualSync}
              disabled={syncing}
              title="Підтягнути свіжі дані з CRM"
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "none",
                background: syncing ? "#94a3b8" : "#c5141c",
                color: "#fff",
                fontWeight: 600,
                cursor: syncing ? "default" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {syncing ? "Синхронізація…" : "🔄 Синхронізувати"}
            </button>
          )}
          {!isManager && (
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
          )}

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

      <h2 className="section-heading">📊 Ключові показники</h2>
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
        const showTeams = !isManager && (kpi.key === "sum" || kpi.key === "deals");
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
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={overview.monthlyHistory} margin={{ top: 22 }}>
                        <defs>
                          <linearGradient id="brandBar" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#e11d2a" />
                            <stop offset="100%" stopColor="#8f0f1c" />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                        <XAxis dataKey="month" />
                        <YAxis tickFormatter={(v) => isMoney ? `${Math.round(v / 1000)}k` : String(v)} />
                        <Tooltip formatter={(v) => isMoney ? formatAmount(Number(v)) : kpi.unit === "%" ? `${v}%` : Number(v).toLocaleString("uk-UA")} cursor={{ fill: "rgba(197,20,28,0.06)" }} />
                        <Bar dataKey={field} name={kpi.label} fill="url(#brandBar)" radius={[6, 6, 0, 0]} maxBarSize={56}>
                          <LabelList dataKey={field} position="top" formatter={(v) => isMoney ? formatAmount(Number(v)) : kpi.unit === "%" ? `${v}%` : Number(v).toLocaleString("uk-UA")} style={{ fontSize: 11, fontWeight: 600, fill: "var(--text)" }} />
                        </Bar>
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

              {kpi.key === "avg" && overview && !isManager && (
                <table className="data-table">
                  <thead><tr><th>Команда</th><th>Середній чек</th><th>Угод</th></tr></thead>
                  <tbody>
                    {overview.byTeam.map((t) => (
                      <tr key={t.teamId}>
                        <td>{t.teamName}</td>
                        <td>{formatAmount(t.deals > 0 ? Math.round(t.revenue / t.deals) : 0)}</td>
                        <td>{t.deals}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {kpi.key === "newc" && overview && (
                <div>
                  <h3 style={{ fontSize: 14, margin: "0 0 8px", color: "var(--text-muted)" }}>Звідки прийшли нові клієнти</h3>
                  <table className="data-table">
                    <thead><tr><th>Джерело</th><th>Клієнтів</th></tr></thead>
                    <tbody>
                      <tr><td>🎯 Реклама / таргет</td><td>{overview.newClientsBySource.ad.toLocaleString("uk-UA")}</td></tr>
                      <tr><td>📞 Лідогенерація</td><td>{overview.newClientsBySource.leadgen.toLocaleString("uk-UA")}</td></tr>
                      <tr><td>✍️ Вручну / інше</td><td>{overview.newClientsBySource.other.toLocaleString("uk-UA")}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}

              {kpi.key === "repc" && overview && (
                <div>
                  <h3 style={{ fontSize: 14, margin: "0 0 8px", color: "var(--text-muted)" }}>
                    Постійні клієнти, що замовляли ({overview.repeatClientsList.length})
                  </h3>
                  {overview.repeatClientsList.length === 0 ? (
                    <p className="loading-text">Немає даних за період.</p>
                  ) : (
                    <table className="data-table">
                      <thead><tr><th>Клієнт</th><th>Замовлень</th><th>Сума</th></tr></thead>
                      <tbody>
                        {overview.repeatClientsList.map((c, i) => (
                          <tr key={i}>
                            <td>{c.clientName}</td>
                            <td>{c.orders}</td>
                            <td>{formatAmount(c.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {overview && (
        <>
          <h2 className="section-heading">💰 Гроші, план і клієнти</h2>
          <div className="kpi-grid">
            <ProgressGauge
              plan={overview.plan}
              planMonth={overview.planMonthTotal}
              fact={overview.fact}
              pct={overview.planPct}
              contributors={overview.byTeam.map((t) => ({ name: t.teamName, revenue: t.revenue, deals: t.deals }))}
            />
            <HoverInfoCard
              label="Очікувані оплати"
              value={`${overview.pendingPayments.deals} угод · ${formatAmount(overview.pendingPayments.revenue)}`}
              rows={overview.pendingPayments.byTeam}
            />
            <button className="kpi-card" style={clickableCard} onClick={() => setCardDetail("created")} title="Натисніть: скільки створених угод на якому етапі">
              <span className="kpi-label">Створені угоди (Повний цикл)</span>
              <span className="kpi-value">{overview.createdFullCycle.toLocaleString("uk-UA")}</span>
            </button>
            <div className="kpi-card" title="Угоди ще в роботі (погоджені → рахунок → оплата отримана, крім Успішна) — знімок на початок місяця, фіксується один раз">
              <span className="kpi-label">Сума перенесених угод з минулого місяця</span>
              <span className="kpi-value">
                {overview.carryover ? formatAmount(overview.carryover.amount) : "—"}
              </span>
              {overview.carryover && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {overview.carryover.deals.toLocaleString("uk-UA")} угод
                </span>
              )}
            </div>
            <button
              className="kpi-card"
              onClick={() => setShowTransferred(true)}
              title="Заявки, передані лідогеном менеджеру (взяв у роботу), і скільки з них успішно реалізовано. Натисніть для деталей по командах."
              style={{ textAlign: "left", border: "none", cursor: "pointer", background: "var(--card-bg)" }}
            >
              <span className="kpi-label">Передані заявки → Успішно</span>
              <span className="kpi-value">
                {overview.transferred.total.toLocaleString("uk-UA")} → {overview.transferred.success.toLocaleString("uk-UA")}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                різниця {(overview.transferred.total - overview.transferred.success).toLocaleString("uk-UA")}
              </span>
            </button>
            <button className="kpi-card" style={clickableCard} onClick={() => setCardDetail("newRev")} title="Натисніть: перелік нових клієнтів із сумою">
              <span className="kpi-label">Виручка від нових клієнтів</span>
              <span className="kpi-value">{formatAmount(overview.newRevenue)}</span>
            </button>
            <div className="kpi-card">
              <span className="kpi-label">Дебіторська заборгованість</span>
              <span className="kpi-value">{formatAmount(overview.receivablesTotal)}</span>
            </div>
            <button className="kpi-card" style={clickableCard} onClick={() => setCardDetail("repeatRev")} title="Натисніть: перелік постійних клієнтів (назва, к-сть замовлень, сума)">
              <span className="kpi-label">Виручка від постійних клієнтів</span>
              <span className="kpi-value">{formatAmount(overview.repeatRevenue)}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {overview.newRevenue + overview.repeatRevenue > 0
                  ? Math.round(
                      (overview.repeatRevenue / (overview.newRevenue + overview.repeatRevenue)) * 100
                    )
                  : 0}
                % від загальної
              </span>
            </button>
          </div>

          {!isManager && (
          <div className="chart-grid">
            <div className="chart-card">
              <h2 className="chart-title">Виручка по командах</h2>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={overview.byTeam} margin={{ bottom: 24, top: 22 }}>
                  <defs>
                    <linearGradient id="brandBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#e11d2a" />
                      <stop offset="100%" stopColor="#8f0f1c" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                  <XAxis dataKey="teamName" interval={0} tick={{ fontSize: 11 }} angle={-15} textAnchor="end" height={50} />
                  <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v) => formatAmount(Number(v))} cursor={{ fill: "rgba(197,20,28,0.06)" }} />
                  <Bar dataKey="revenue" name="Виручка" fill="url(#brandBar)" radius={[6, 6, 0, 0]} maxBarSize={64}>
                    <LabelList dataKey="revenue" position="top" formatter={(v) => formatAmount(Number(v))} style={{ fontSize: 11, fontWeight: 600, fill: "var(--text)" }} />
                  </Bar>
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
          )}
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
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={chartData} margin={{ bottom: 24, top: 22 }}>
                <defs>
                  <linearGradient id="brandBar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#e11d2a" />
                    <stop offset="100%" stopColor="#8f0f1c" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                <XAxis dataKey="name" interval={0} tick={{ fontSize: 12 }} angle={-15} textAnchor="end" height={50} />
                <YAxis />
                <Tooltip
                  cursor={{ fill: "rgba(197,20,28,0.06)" }}
                  formatter={(v, _n, p) => [`${Number(v).toLocaleString("uk-UA")} угод · ${formatAmount(Number(p?.payload?.amount ?? 0))}`, "Етап"]}
                />
                <Bar dataKey="count" fill="url(#brandBar)" radius={[6, 6, 0, 0]} maxBarSize={72}>
                  <LabelList dataKey="count" position="top" style={{ fontSize: 12, fontWeight: 600, fill: "var(--text)" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {showTransferred && overview && (
        <div onClick={() => setShowTransferred(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 680, maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h2 className="chart-title">Передані заявки → Успішно реалізовано</h2>
              <button onClick={() => setShowTransferred(false)} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
              «Передано» = лідоген передав заявку, і менеджер взяв її в роботу (зміна відповідального в «Кваліфікація»). «Успішно» = закриті як «Успішна угода» за період.
            </p>
            <div className="kpi-grid" style={{ marginBottom: 12 }}>
              <div className="kpi-card"><span className="kpi-label">Передано заявок</span><span className="kpi-value">{overview.transferred.total.toLocaleString("uk-UA")}</span></div>
              <div className="kpi-card"><span className="kpi-label">Успішно реалізовано</span><span className="kpi-value">{overview.transferred.success.toLocaleString("uk-UA")}</span></div>
              <div className="kpi-card"><span className="kpi-label">Різниця (не закрито)</span><span className="kpi-value">{(overview.transferred.total - overview.transferred.success).toLocaleString("uk-UA")}</span></div>
            </div>
            {isManager ? null : overview.transferred.byTeam.length === 0 ? (
              <p className="loading-text">Немає даних за період.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Команда</th><th>Передано</th><th>Успішно</th><th>Сума успішних</th></tr></thead>
                <tbody>
                  {overview.transferred.byTeam.map((t) => (
                    <tr key={t.teamId}>
                      <td>{t.teamName}</td>
                      <td>{t.transferred}</td>
                      <td>{t.success}</td>
                      <td>{formatAmount(t.successRevenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {cardDetail && overview && (() => {
        const title = cardDetail === "created" ? "Створені угоди — за етапами"
          : cardDetail === "newRev" ? "Виручка від нових клієнтів"
          : "Виручка від постійних клієнтів";
        const list = cardDetail === "newRev" ? overview.newClientsList : cardDetail === "repeatRev" ? overview.repeatClientsList : [];
        return (
          <div onClick={() => setCardDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 24, width: "90vw", maxWidth: 680, maxHeight: "85vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h2 className="chart-title" style={{ marginBottom: 0 }}>{title}</h2>
                <button onClick={() => setCardDetail(null)} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
              </div>
              {cardDetail === "created" ? (
                <table className="data-table">
                  <thead><tr><th>Етап (де зараз)</th><th>Угод</th><th>Сума</th></tr></thead>
                  <tbody>
                    {overview.createdByStage.map((s) => (
                      <tr key={s.stage}><td>{s.label}</td><td style={{ fontWeight: 600 }}>{s.deals.toLocaleString("uk-UA")}</td><td>{formatAmount(s.amount)}</td></tr>
                    ))}
                    <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
                      <td>Разом створено</td>
                      <td>{overview.createdFullCycle.toLocaleString("uk-UA")}</td>
                      <td>{formatAmount(overview.createdByStage.reduce((s, x) => s + x.amount, 0))}</td>
                    </tr>
                  </tbody>
                </table>
              ) : list.length === 0 ? (
                <p className="loading-text">Немає даних за період.</p>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Клієнт</th><th>Замовлень (рахунків)</th><th>Сума</th></tr></thead>
                  <tbody>
                    {list.map((c, i) => (
                      <tr key={i}><td>{c.clientName}</td><td>{c.orders}</td><td style={{ fontWeight: 600 }}>{formatAmount(c.revenue)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}
