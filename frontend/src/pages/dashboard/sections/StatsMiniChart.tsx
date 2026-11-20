import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

/**
 * 📈 МАЛИЙ ГРАФІК КАРТКИ СТІНИ. Повні періоди — суцільна лінія; період, що йде, — пунктиром і порожньою точкою
 * (він ще не закінчився, і рівень у ньому читати як «обвал» не можна). Осей і підписів немає: картка — для погляду,
 * числа — у розгорнутому показнику.
 */
export function StatsMiniChart({ points, currentStart, color = "#2f6fdb" }: {
  points: { period: string; value: number }[]; currentStart: string; color?: string;
}) {
  const closed = points.filter((p) => p.period < currentStart);
  const cur = points.find((p) => p.period === currentStart);
  const lastClosed = closed[closed.length - 1];
  const rows = points.filter((p) => p.period <= currentStart).map((p) => ({
    period: p.period,
    v: p.period < currentStart ? p.value : undefined,
    c: p.period === currentStart || (cur && p === lastClosed) ? p.value : undefined,
  }));
  if (rows.length < 2) return <div style={{ height: 46 }} />;
  return (
    <div style={{ height: 46, marginTop: 6 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 6, bottom: 2, left: 6 }}>
          <YAxis hide domain={["auto", "auto"]} />
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls={false} />
          <Line type="monotone" dataKey="c" stroke={color} strokeWidth={1.6} strokeDasharray="4 3" isAnimationActive={false}
            dot={(p: any) => (p?.payload?.period === currentStart && typeof p.cx === "number"
              ? <circle key="cur" cx={p.cx} cy={p.cy} r={3} fill="var(--card-bg)" stroke={color} strokeWidth={1.6} />
              : <g key={`n${p?.index ?? 0}`} />)} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
