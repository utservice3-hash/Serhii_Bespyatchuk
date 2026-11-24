import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea } from "recharts";
import { splitCurrent, periodTick, periodTitle, fmt, FULL_SUFFIX, CUR_SUFFIX } from "../statsChart";
import type { CardGran, StackPt } from "../statsCards";

/**
 * ☰ ГРАФІК РЯДКА У ВИГЛЯДІ «ОДИН ПІД ОДНИМ» (Роман 24.11.2026). Один показник — один графік зі своєю віссю Y; вісь часу
 * в усіх графіків стовпчика однакова (`statsCards.stackWindow` віддає кожен період вікна), тож місяці стоять рівно
 * один під одним і показники порівнюються очима по вертикалі.
 *
 *   • Наведення СПІЛЬНЕ: усі графіки стовпчика мають один `syncId`, тож лінія й число зʼявляються одразу на всіх.
 *     Зіставлення — за періодом (`syncMethod="value"`), а не за номером точки: показник «лише помісячно» у тижневому
 *     вигляді має іншу вісь і чужого тижня не підсвітить.
 *   • Період, що йде, — як на розгорнутому графіку: пунктир від останнього повного, порожня точка, сіра смуга «іде»
 *     (`splitCurrent`), бо неповний місяць суцільною лінією читається як обвал.
 *   • Ліній команд тут немає: вони в розгорнутому показнику. Вісім графіків по сім ліній не читаються.
 *
 * Запитів компонент не робить і чисел не рахує: рядки приходять готовими. Тримає `#10428`.
 */
export const STACK_SYNC_ID = "stats-stack";
export const STACK_CHART_HEIGHT = 170;
const MUTED = "var(--text-muted)";
const dm = (p: string) => `${p.slice(8, 10)}.${p.slice(5, 7)}`;

export function StatsStackChart({ rows, g, unit, currentStart, today, ticks, tickFmt, color = "#2f6fdb" }: {
  rows: StackPt[]; g: CardGran; unit?: string; currentStart: string; today: string;
  /** Круглі поділки осі Y від нуля; без них (є відʼємні значення) вісь підбирає межі сама. */
  ticks?: number[]; tickFmt: (v: number) => string; color?: string;
}) {
  const data = useMemo(
    () => splitCurrent(rows.map((r) => (r.value == null ? { period: r.period } : { period: r.period, v: r.value })), ["v"], currentStart),
    [rows, currentStart],
  );
  const fk = `v${FULL_SUFFIX}`, ck = `v${CUR_SUFFIX}`;
  if (!rows.some((r) => r.value != null)) {
    return <div style={{ height: STACK_CHART_HEIGHT, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: 12.5 }}>за цей період точок немає</div>;
  }
  const last = data[data.length - 1], prev = data[data.length - 2];
  /** Точка повного періоду без сусідів (діри з обох боків) лінії не дає — малюємо її саму, інакше значення є, а на графіку порожньо. */
  const loneDot = (p: any) => {
    const i = p?.index ?? -1;
    const lone = typeof data[i]?.[fk] === "number" && typeof data[i - 1]?.[fk] !== "number" && typeof data[i + 1]?.[fk] !== "number";
    return lone && typeof p.cx === "number" && typeof p.cy === "number"
      ? <circle key={`lone${i}`} cx={p.cx} cy={p.cy} r={3} fill={color} />
      : <g key={`n${i}`} />;
  };
  /** Порожня точка — лише на періоді, що йде (кінець пунктиру), з кільцем кольору фону. */
  const curDot = (p: any) => (p?.payload?.period >= currentStart && typeof p.cx === "number" && typeof p.cy === "number"
    ? <circle key={`cur${p.index}`} cx={p.cx} cy={p.cy} r={4} fill="var(--card-bg)" stroke={color} strokeWidth={2} />
    : <g key={`n${p?.index ?? 0}`} />);
  return (
    <ResponsiveContainer width="100%" height={STACK_CHART_HEIGHT}>
      <LineChart data={data} syncId={STACK_SYNC_ID} syncMethod="value" margin={{ top: 18, right: 18, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="period" tickFormatter={(p) => periodTick(String(p), g)} tick={{ fontSize: 11, fill: MUTED }} minTickGap={28} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
        {ticks
          ? <YAxis ticks={ticks} domain={[0, ticks[ticks.length - 1]]} tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => tickFmt(Number(v))} axisLine={false} tickLine={false} width={58} />
          : <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => tickFmt(Number(v))} axisLine={false} tickLine={false} width={58} />}
        {/* 💬 Підказка коротка: вона зʼявляється на КОЖНОМУ графіку стовпчика одразу. Число — головне, період — другорядний. */}
        <Tooltip
          cursor={{ stroke: "#94a3b8", strokeWidth: 1 }}
          content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null;
            const v = payload[0]?.payload?.v;
            return (
              <div style={{ fontSize: 12, borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", padding: "5px 9px", whiteSpace: "nowrap" }}>
                {typeof v === "number" ? <b>{fmt(v, unit)}</b> : <span style={{ color: MUTED }}>точки немає</span>}
                <span style={{ color: MUTED }}> · {periodTitle(String(label), g)}{String(label) >= currentStart && <> · іде, станом на {dm(today)}</>}</span>
              </div>
            );
          }} />
        <Line type="linear" dataKey={fk} stroke={color} strokeWidth={2} dot={loneDot} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
        <Line type="linear" dataKey={ck} stroke={color} strokeWidth={2} strokeDasharray="5 4" dot={curDot} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
        {last && prev && String(last.period) >= currentStart && (
          <ReferenceArea x1={prev.period} x2={last.period} fill="#94a3b8" fillOpacity={0.12} label={{ value: "іде", position: "top", offset: 5, fontSize: 11, fill: MUTED }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
