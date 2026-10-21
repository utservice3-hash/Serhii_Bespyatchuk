import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from "recharts";
import { InfoHint } from "../widgets";
import { priceConversionByManager, MATURE_DAYS, type PriceConvLine, type PriceConvPart, type ChecklistT } from "../aiCallsView";

/**
 * 📊 «ЦІНА І РЕЗУЛЬТАТ ПО МЕНЕДЖЕРАХ» (задача 6439 п.3, Юля 20.10.2026). Рахує `priceConversionByManager` — тут лише вигляд.
 * Команда й місяць — ті самі, що в шапці екрана (рядки приходять уже відфільтрованими); «старші 7 днів» — свій перемикач.
 */
const SERIES: readonly { key: "priced" | "withPrice" | "withoutPrice"; label: string; color: string; hint: string }[] = [
  { key: "priced", label: "Ціну назвали", color: "#2563eb", hint: "у скількох розмовах назвали ціну" },
  { key: "withPrice", label: "Успіх, коли назвали ціну", color: "#16a34a", hint: "з розмов, де ціну назвали" },
  { key: "withoutPrice", label: "Успіх, коли не назвали", color: "#9ca3af", hint: "з розмов, де ціну НЕ назвали" },
];
const partText = (p: PriceConvPart) => (p.pct == null ? "—" : `${String(p.pct)}% (${String(p.n)} з ${String(p.of)})`);

type Row = { inReport: boolean; managerId: number | null; managerName: string | null; dealCreatedAt: string;
  checklist: ChecklistT | null; dealOutcome?: { state: string } | null };

export function FirstTouchPriceChart({ rows, today }: { rows: readonly Row[]; today: string }) {
  const [mature, setMature] = useState(true);
  const { lines, total } = priceConversionByManager(rows, { matureOnly: mature, today });
  const data = lines.map((l) => ({ name: `${l.name} · ${String(l.calls)}`, line: l,
    priced: l.priced.pct, withPrice: l.withPrice.pct, withoutPrice: l.withoutPrice.pct }));
  return (
    <section aria-label="Ціна і результат по менеджерах" className="ftd-card ftd-card-pad">
      <div className="ftd-card-h">
        <h2>Ціна і результат по менеджерах
          <InfoHint text="Розібрані розмови звіту за період і команду з шапки. Успіх — той самий, що в колонці «Успіх»: угода зараз в «Авто працює» або далі. «Не назвали» — лише розмови, де ціну могли назвати й не назвали; втрачені ліди й не запити сюди не входять." /></h2>
        <label className="ftd-sub" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input id="ftd-price-mature" type="checkbox" checked={mature} onChange={(e) => setMature(e.target.checked)} />
          лише угоди, старші {MATURE_DAYS} днів
        </label>
      </div>
      {total && (
        <div className="ftd-sub">
          Разом: ціну назвали {partText(total.priced)} · успіх з ціною {partText(total.withPrice)} · без ціни {partText(total.withoutPrice)}
        </div>
      )}
      {lines.length === 0
        ? <p className="ftd-sub" style={{ margin: 0 }}>{mature ? `Розібраних розмов по угодах, старших ${String(MATURE_DAYS)} днів, у періоді немає — зніміть позначку, щоб побачити свіжі.` : "Розібраних розмов у періоді ще немає."}</p>
        : (
          <div style={{ width: "100%", height: 56 + lines.length * 44 }}>
            <ResponsiveContainer>
              <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barGap={1} barCategoryGap={8}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${String(v)}%`}
                  tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
                <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 12, fill: "var(--text)" }} />
                <Tooltip cursor={{ fill: "var(--bg)" }} content={({ active, payload }) => {
                  const l = active ? (payload?.[0]?.payload as { line?: PriceConvLine } | undefined)?.line : undefined;
                  if (!l) return null;
                  return (
                    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{l.name} · {l.calls} розмов</div>
                      {SERIES.map((s) => <div key={s.key}><span style={{ color: s.color }}>■</span> {s.label}: {partText(l[s.key])}</div>)}
                    </div>);
                }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {SERIES.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[0, 3, 3, 0]} isAnimationActive={false} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
    </section>
  );
}
