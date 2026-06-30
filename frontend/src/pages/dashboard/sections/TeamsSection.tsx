import type { Dispatch, SetStateAction } from "react";
import { QuickPeriods } from "../../../components/DateRangeFilter";
import type { TeamRanking } from "../../../api";
import { formatAmount } from "../format";

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
              {teamsRanking.map((t, i) => (
                <tr key={t.teamId}>
                  <td>{["🥇", "🥈", "🥉"][i] ?? i + 1}</td>
                  <td>{t.teamName}</td>
                  <td style={{ fontWeight: 600 }}>{formatAmount(t.revenue)}</td>
                  <td>{t.deals}</td>
                  <td>{formatAmount(t.avgCheck)}</td>
                  <td>{t.conversion}%</td>
                  <td style={t.receivables > 0 ? { color: "#dc2626" } : undefined}>{formatAmount(t.receivables)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
