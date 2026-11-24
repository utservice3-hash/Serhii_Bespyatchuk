import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

/**
 * 📈 МАЛИЙ ГРАФІК КАРТКИ СТІНИ — ЛИШЕ ПОВНІ ПЕРІОДИ. Період, що йде, сюди не потрапляє зовсім: число «станом на» вже
 * стоїть рядком над графіком, а точка неповного місяця на графіку без осей пірнала вниз і читалась як обвал навіть
 * пунктиром (огляд 23.11.2026). Осей і підписів немає: картка — для погляду, числа — у розгорнутому показнику.
 * Тримає `#10902`.
 */
export function StatsMiniChart({ points, currentStart, color = "#2f6fdb" }: {
  points: { period: string; value: number }[]; currentStart: string; color?: string;
}) {
  const rows = points.filter((p) => p.period < currentStart).map((p) => ({ period: p.period, v: p.value }));
  if (rows.length < 2) return <div style={{ height: 46 }} />;
  return (
    <div style={{ height: 46, marginTop: 6 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 6, bottom: 2, left: 6 }}>
          <YAxis hide domain={["auto", "auto"]} />
          <Line type="linear" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
