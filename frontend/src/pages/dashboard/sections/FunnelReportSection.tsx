import type { Dispatch, SetStateAction } from "react";
import { DateRangeFilter, QuickPeriods } from "../../../components/DateRangeFilter";
import type { FunnelReport, FunnelStageRow } from "../../../api";

type DateRange = { from: string; to: string };

function pct(n: number, base: number): string {
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
            <td>{pct(s.total, first)}</td>
            <td>{i === 0 ? "—" : pct(s.total, stages[i - 1].total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FunnelReportSection({
  title,
  report,
  loading,
  dateRange,
  setDateRange,
  datePreset,
  setDatePreset,
}: {
  title: string;
  report: FunnelReport | null;
  loading: boolean;
  dateRange: DateRange;
  setDateRange: Dispatch<SetStateAction<DateRange>>;
  datePreset: string | null;
  setDatePreset: Dispatch<SetStateAction<string | null>>;
}) {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        <div className="page-filters">
          <DateRangeFilter value={dateRange} onChange={(r) => { setDateRange(r); setDatePreset(null); }} />
        </div>
      </div>
      <QuickPeriods active={datePreset} onSelect={(id, range) => { setDatePreset(id); setDateRange(range); }} />

      {loading ? (
        <p className="loading-text">Завантаження...</p>
      ) : !report ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <>
          <div className="chart-card">
            <h2 className="chart-title">Воронка за період (когорта створених угод, розріз по типу клієнта)</h2>
            <FunnelTable stages={report.stages} />
          </div>

          {report.scope === "team" && report.byManager.length > 0 && (
            <div className="chart-card">
              <h2 className="chart-title">По менеджерах</h2>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Менеджер</th>
                    <th>Взято в роботу</th>
                    <th>Запит на прорахунок</th>
                    <th>Погоджено</th>
                    <th>Рахунок</th>
                    <th>Оплата</th>
                    <th>Конв. (оплата/взято)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byManager.map((m) => {
                    const t = (i: number) => m.stages[i]?.total ?? 0;
                    return (
                      <tr key={m.managerId}>
                        <td>{m.name}</td>
                        <td>{t(0)}</td>
                        <td>{t(1)}</td>
                        <td>{t(2)}</td>
                        <td>{t(3)}</td>
                        <td style={{ fontWeight: 600 }}>{t(4)}</td>
                        <td>{pct(t(4), t(0))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
