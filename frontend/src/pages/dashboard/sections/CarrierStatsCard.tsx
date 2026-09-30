import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchCarrierStats, type CarrierDayStatT } from "../../../api";
import { InfoHint } from "../widgets";

/**
 * 📈 «ДИНАМІКА ЗА ПЕРІОД» у вкладці «Перевізники за розмовою» (прохання Романа 30.09.2026: «графіки по тому скільки за
 * який період дзвінків відсіяно, пропущено, скільки грошей витрачено, щоб було гарно»).
 *
 * Два окремі графіки, а не один з двома осями: кількість угод і долари — різні величини (dataviz: одна вісь).
 *  · стовпчики по днях у стосі: відсіяв фільтр → без розмови → клієнти → перевізники → інше → чекають рішення.
 *    Рахуються з тих самих рядків, що вкладки й звіт (сервер, `carrierDailyStats`);
 *  · витрати AI по днях — лише керівництву (сервер віддає `null` іншим, і графіка тоді немає).
 * Кольори — змінні теми `--cc-*` (index.css), перевірені валідатором у світлій і темній темі; легенда несе числа.
 */

type Key = "filtered" | "noTalk" | "clients" | "carriers" | "other" | "unsorted";
const SERIES: readonly { key: Key; label: string; color: string; hint: string }[] = [
  { key: "filtered", label: "Відсіяв фільтр CRM", color: "var(--cc-filtered)", hint: "Фільтр CRM закрив як «Перевізник» ще до AI (Lardi, список відомих перевізників)." },
  { key: "noTalk", label: "Без розмови", color: "var(--cc-notalk)", hint: "Пропущені чи короткі дзвінки (розмови від 10 с не було) — закриваються «Немає зв'язку»." },
  { key: "clients", label: "Клієнти", color: "var(--cc-client)", hint: "Виявились клієнтами — лишаються на етапі." },
  { key: "carriers", label: "Перевізники", color: "var(--cc-carrier)", hint: "Перевізники, яких визначив AI або людина, — закриті в CRM." },
  { key: "other", label: "Інше", color: "var(--cc-other)", hint: "Спам, постачальники, пошук роботи, особисте, помилка номера — закриті як «Нецільове звернення»." },
  { key: "unsorted", label: "Чекають рішення", color: "var(--cc-unsorted)", hint: "AI не впевнений, помилка обробки або AI ще слухає." },
];

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const usd = (v: number) => `$${v.toFixed(2)}`;
const muted: React.CSSProperties = { color: "var(--text-muted)" };
const tipBox: React.CSSProperties = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5,
  boxShadow: "var(--shadow)", color: "var(--text)" };

function DealsTip({ active, payload, label }: { active?: boolean; payload?: { payload: CarrierDayStatT }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const total = SERIES.reduce((s, x) => s + d[x.key], 0);
  return (
    <div style={tipBox}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label ? ddmm(label) : ""} · усього {total}</div>
      {[...SERIES].reverse().map((x) => (
        <div key={x.key} style={{ display: "flex", alignItems: "center", gap: 6, fontVariantNumeric: "tabular-nums" }}>
          <i style={{ width: 9, height: 9, borderRadius: 2, background: x.color, display: "inline-block" }} />
          <span style={{ flex: 1 }}>{x.label}</span><b>{d[x.key]}</b>
        </div>
      ))}
    </div>
  );
}

function SpendTip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div style={tipBox}><b>{label ? ddmm(label) : ""}</b> · витрачено на AI <b>{usd(Number(payload[0].value))}</b></div>;
}

export function CarrierStatsCard({ from, to, refresh }: { from: string; to: string; refresh: number }) {
  const [days, setDays] = useState<CarrierDayStatT[] | null>(null);
  const [cap, setCap] = useState(15);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchCarrierStats({ from, to }).then((x) => { if (alive) { setDays(x.days); setCap(x.spendCapUsd); setErr(null); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Не вдалося завантажити"); });
    return () => { alive = false; };
  }, [from, to, refresh]);
  const totals = useMemo(() => Object.fromEntries(SERIES.map((x) => [x.key, (days ?? []).reduce((s, d) => s + d[x.key], 0)])) as Record<Key, number>, [days]);
  const spendShown = (days ?? []).some((d) => d.spendUsd != null);
  const spendTotal = (days ?? []).reduce((s, d) => s + (d.spendUsd ?? 0), 0);
  const allTotal = SERIES.reduce((s, x) => s + totals[x.key], 0);

  const head = (
    <h3 style={{ margin: "0 0 6px", display: "flex", alignItems: "center", gap: 6, fontSize: 15 }}>
      Динаміка за період
      <InfoHint text="Скільки дзвінків на мобільні прийшло кожного дня і що з ними сталось. День — за датою створення угоди. Наведіть на стовпчик — побачите числа." />
    </h3>
  );
  if (err) return <div className="chart-card">{head}<p style={{ margin: 0, color: "var(--danger)" }}>{err}</p></div>;
  if (!days) return <div className="chart-card">{head}<p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  return (
    <div className="chart-card">
      {head}
      {/* Легенда з числами — вона ж підписи (три слоти мають контраст < 3:1, колір не може бути єдиним носієм). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", margin: "4px 0 10px", fontSize: 13 }}>
        {SERIES.map((x) => (
          <span key={x.key} title={x.hint} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <i style={{ width: 10, height: 10, borderRadius: 3, background: x.color, display: "inline-block" }} />
            {x.label} <b style={{ fontVariantNumeric: "tabular-nums" }}>{totals[x.key]}</b>
          </span>
        ))}
        <span style={{ ...muted, marginLeft: "auto" }}>усього <b style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{allTotal}</b></span>
      </div>
      {allTotal === 0
        ? <p style={{ margin: 0, ...muted }}>За період дзвінків на мобільні ще не було.</p>
        : (
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={days} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
                <XAxis dataKey="day" tickFormatter={ddmm} tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={8} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} width={40} />
                <Tooltip content={<DealsTip />} cursor={{ fill: "var(--surface-2)" }} />
                {SERIES.map((x, i) => (
                  <Bar key={x.key} dataKey={x.key} name={x.label} stackId="d" fill={x.color} stroke="var(--card-bg)" strokeWidth={1.5}
                    radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} maxBarSize={42} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

      {spendShown && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <b style={{ fontSize: 14, display: "inline-flex", alignItems: "center", gap: 6 }}>
              Витрати на AI
              <InfoHint text={`Скільки коштувало розпізнати й проаналізувати розмови мобільних за кожен день (ElevenLabs + Gemini), по всій компанії. Стеля — $${String(cap)} на місяць; досягнули — AI зупиняється до кінця місяця й пише в Telegram. Бачить лише керівництво.`} />
            </b>
            <span style={{ fontSize: 13, ...muted }}>за період <b style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{usd(spendTotal)}</b> · стеля {usd(cap)} / міс</span>
          </div>
          <div style={{ width: "100%", height: 150 }}>
            <ResponsiveContainer>
              <BarChart data={days} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="day" tickFormatter={ddmm} tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={8} />
                <YAxis tickFormatter={(v: number) => `$${v.toFixed(v < 1 ? 2 : 0)}`} tick={{ fontSize: 11, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} width={48} />
                <Tooltip content={<SpendTip />} cursor={{ fill: "var(--surface-2)" }} />
                <Bar dataKey="spendUsd" name="Витрати" fill="var(--cc-spend)" radius={[4, 4, 0, 0]} maxBarSize={42} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
