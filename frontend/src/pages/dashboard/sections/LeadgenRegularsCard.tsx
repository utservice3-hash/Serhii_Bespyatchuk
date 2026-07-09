import { useEffect, useState } from "react";
import { fetchLeadgenRegulars, type LeadgenRegulars } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { InfoHint } from "../widgets";

/**
 * «🔁 Постійні від лідогену» — накопичений ефект лідогенераторів за весь час:
 * скільки клієнтів після лідоген-дотику стали постійними (2+ оплати) і скільки
 * грошей принесли ПІСЛЯ дотику. Показує довгу цінність лідогену поза місячними
 * звітами. Використовується в розділі «Лідогенерація» та Звіті КВП.
 */
export function LeadgenRegularsCard() {
  const [d, setD] = useState<LeadgenRegulars | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { fetchLeadgenRegulars().then(setD).catch(() => setErr(true)); }, []);
  if (err) return null;
  if (!d) return <div className="chart-card" style={{ marginBottom: 16 }}><p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const convToPay = d.touched > 0 ? Math.round(((d.paidOnce + d.regulars) / d.touched) * 100) : 0;
  const tiles = [
    {
      label: "Стали постійними", value: d.regulars.toLocaleString("uk-UA"),
      sub: `${d.regularsNew} нових з нуля · ${d.regularsReact} реактивовано`,
      hint: "Клієнти, що зробили 2+ оплачені угоди ПІСЛЯ першого лідоген-дотику (угода повного циклу з каналом «лідоген»). Безіменні клієнти виключені.",
      color: "#16a34a",
    },
    {
      label: "Гроші постійних (після дотику)", value: formatAmount(d.revenueAfter),
      sub: `нові ${formatAmount(d.revenueNew)} · реактивовані ${formatAmount(d.revenueReact)}`,
      hint: "Сума оплачених угод цих клієнтів після лідоген-дотику — внесок лідогену, а не старі заслуги клієнта. Lifetime разом з до-дотиковими оплатами: " + formatAmount(d.lifetime) + ".",
      color: "#16a34a",
    },
    {
      label: "Оплатили 1 раз", value: d.paidOnce.toLocaleString("uk-UA"),
      sub: `${formatAmount(d.paidOnceSum)} · кандидати в постійні`,
      hint: "Клієнти з рівно однією оплатою після лідоген-дотику — потенціал для повторного продажу/реактивації.",
    },
    {
      label: "Профіль постійного", value: `${d.avgPays} оплат`,
      sub: `сер. чек ${formatAmountFull(d.avgCheck)}`,
      hint: "У середньому оплат на одного постійного від лідогену після дотику та середній чек цих оплат.",
    },
    {
      label: "Конверсія дотик → платник", value: `${convToPay}%`,
      sub: `${(d.paidOnce + d.regulars).toLocaleString("uk-UA")} із ${d.touched.toLocaleString("uk-UA")} торкнутих`,
      hint: "Скільки клієнтів, до яких доторкнувся лідоген, зробили хоча б одну оплату після дотику.",
    },
  ];
  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <h2 className="chart-title" style={{ marginBottom: 4 }}>🔁 Постійні від лідогену (за весь час)</h2>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 10px" }}>
        Накопичений ефект: кожен третій платник від лідогену стає постійним — довга цінність поза місячними звітами.
      </p>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        {tiles.map((t) => (
          <div key={t.label} className="kpi-card" style={t.color ? { borderTop: `3px solid ${t.color}` } : undefined}>
            <span className="kpi-label">{t.label}<InfoHint text={t.hint} /></span>
            <span className="kpi-value" style={t.color ? { color: t.color } : undefined}>{t.value}</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.sub}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
