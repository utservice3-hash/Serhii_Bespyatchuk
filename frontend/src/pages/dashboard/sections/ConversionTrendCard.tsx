import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from "recharts";
import { fetchConversionTimeseries, type ConversionTsPoint } from "../../../api";

const ddmm = (d: string) => (d ? d.slice(8, 10) + "." + d.slice(5, 7) : "");

/**
 * Динаміка конверсії в часі — тренд % конвертованих лідів повного циклу (клієнт
 * дійшов до оплаченої угоди) по днях/тижнях/місяцях. Дві лінії: загальна конверсія
 * і конверсія реклами. Скоуп успадковує фільтр менеджера/команди зі Звіту.
 */
export function ConversionTrendCard({
  from, to, granularity, managerId, teamId,
}: {
  from: string; to: string; granularity: "day" | "week" | "month";
  managerId?: number; teamId?: number;
}) {
  const [points, setPoints] = useState<ConversionTsPoint[] | null>(null);

  useEffect(() => {
    fetchConversionTimeseries({ from, to, granularity, managerId, teamId })
      .then((r) => setPoints(r.points))
      .catch(() => setPoints([]));
  }, [from, to, granularity, managerId, teamId]);

  if (points === null) return null;

  const data = points.map((p) => ({
    label: granularity === "month" ? p.bucket.slice(0, 7) : ddmm(p.bucket),
    conversion: p.conversion,
    adConversion: p.adConversion,
    leads: p.leads,
    paid: p.paid,
  }));
  const totalLeads = points.reduce((s, p) => s + p.leads, 0);
  const totalPaid = points.reduce((s, p) => s + p.paid, 0);
  const avg = totalLeads > 0 ? Math.round((totalPaid / totalLeads) * 100) : 0;

  return (
    <div className="chart-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 className="chart-title" style={{ marginBottom: 0 }}>Динаміка конверсії</h2>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
          середня за період: <b style={{ color: avg >= 20 ? "#16a34a" : avg >= 10 ? "#d97706" : "#dc2626" }}>{avg}%</b> ({totalPaid}/{totalLeads})
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
        % лідів повного циклу (створених у періоді), чий клієнт дійшов до оплаченої угоди. Когорта за датою створення — свіжі періоди ще «дозрівають».
      </p>
      {data.length === 0 ? (
        <p className="loading-text">Немає даних за період.</p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 10 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={(v) => `${v}%`} />
            <Tooltip formatter={(v: number, n) => [`${v}%`, n === "adConversion" ? "Конверсія реклами" : "Загальна конверсія"]} />
            <Legend />
            <Line type="monotone" dataKey="conversion" name="Загальна конверсія" stroke="#c5141c" strokeWidth={2} connectNulls dot={{ r: 3 }} />
            <Line type="monotone" dataKey="adConversion" name="Конверсія реклами" stroke="#6366f1" strokeWidth={2} connectNulls dot={{ r: 3 }} strokeDasharray="5 4" />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
