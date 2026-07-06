import { Fragment, useState, type Dispatch, type SetStateAction } from "react";
import { QuickPeriods } from "../../../components/DateRangeFilter";
import type { TeamRanking } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";

type DateRange = { from: string; to: string };

export function TeamsSection({
  datePreset,
  setDatePreset,
  setDateRange,
  teamsRanking,
}: {
  datePreset: string | null;
  setDatePreset: Dispatch<SetStateAction<string | null>>;
  setDateRange: Dispatch<SetStateAction<DateRange>>;
  teamsRanking: TeamRanking[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Рейтинг команд</h1>
      </div>
      <QuickPeriods active={datePreset} onSelect={(id, range) => { setDatePreset(id); setDateRange(range); }} />
      <div className="chart-card">
        {teamsRanking.length === 0 ? (
          <p className="loading-text">Немає даних за період.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Команда</th>
                <th>Виручка</th>
                <th>Угод</th>
                <th>Сер. чек</th>
                <th>Конверсія</th>
                <th>Дебіторка</th>
              </tr>
            </thead>
            <tbody>
              {teamsRanking.map((t, i) => {
                const open = openId === t.teamId;
                return (
                  <Fragment key={t.teamId}>
                    <tr
                      onClick={() => setOpenId(open ? null : t.teamId)}
                      style={{ cursor: "pointer" }}
                      title="Натисніть, щоб побачити менеджерів і плани"
                    >
                      <td>{["🥇", "🥈", "🥉"][i] ?? i + 1}</td>
                      <td style={{ fontWeight: 600 }}>{open ? "▾ " : "▸ "}{t.teamName}</td>
                      <td style={{ fontWeight: 600 }}>{formatAmount(t.revenue)}</td>
                      <td>{t.deals}</td>
                      <td>{formatAmountFull(t.avgCheck)}</td>
                      <td>{t.conversion}%</td>
                      <td style={t.receivables > 0 ? { color: "#dc2626" } : undefined}>{formatAmount(t.receivables)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ background: "var(--hover-bg, rgba(127,127,127,0.05))", padding: "8px 12px" }}>
                          {t.managers.length === 0 ? (
                            <p className="loading-text" style={{ margin: 0 }}>Немає менеджерів з активністю.</p>
                          ) : (
                            <table className="data-table" style={{ fontSize: 13 }}>
                              <thead>
                                <tr>
                                  <th>Менеджер</th>
                                  <th>Факт (виручка)</th>
                                  <th>План міс</th>
                                  <th>Викон.</th>
                                  <th>Угод</th>
                                  <th>Сер. чек</th>
                                  <th>Дебіторка</th>
                                </tr>
                              </thead>
                              <tbody>
                                {t.managers.map((m) => (
                                  <tr key={m.id}>
                                    <td>{m.name}</td>
                                    <td style={{ fontWeight: 600 }}>{formatAmount(m.revenue)}</td>
                                    <td>{m.plan > 0 ? formatAmount(m.plan) : "—"}</td>
                                    <td style={{ color: m.plan > 0 ? (m.planPct >= 100 ? "#16a34a" : m.planPct >= 70 ? "#d97706" : "#dc2626") : undefined }}>
                                      {m.plan > 0 ? `${m.planPct}%` : "—"}
                                    </td>
                                    <td>{m.deals}</td>
                                    <td>{formatAmountFull(m.avgCheck)}</td>
                                    <td style={m.receivables > 0 ? { color: "#dc2626" } : undefined}>{formatAmount(m.receivables)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
