import type { ReceivableTotals } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import {
  AGING_LABEL, AGING_ORDER, CARRIER_REASON_LABEL, ENTITY_LABEL, ENTITY_REASON_LABEL, t,
} from "../receivablesView";

/**
 * 📊 ПЛИТКИ ДЕБІТОРКИ.
 *
 * 🔴 УСІ ЧИСЛА ТУТ — З `totals`, ЯКІ ПРИЇХАЛИ З СЕРВЕРА, і з того самого
 * зведення, що й ярлики в рядках. Порахувати їх тут по масиву клієнтів було б
 * простіше — і це рівно той спосіб, яким на одному екрані зʼявляються два
 * числа про одне («Команда за місяць 12%» проти плитки «11.8%»).
 *
 * 🔴 І друге: кожен «невідомо» підписаний ПРИЧИНОЮ. Порожнє місце читається як
 * «нічого немає», а не як «ми не знаємо» — а тут це три різні речі з трьома
 * різними діями.
 */

const Bar = ({ parts }: { parts: { label: string; value: number; color: string; hint: string }[] }) => {
  const sum = parts.reduce((s, p) => s + p.value, 0);
  if (sum <= 0) return null;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginTop: 6, background: "var(--border)" }}>
      {parts.filter((p) => p.value > 0).map((p) => (
        <div key={p.label} title={p.hint} style={{ width: `${(p.value / sum) * 100}%`, background: p.color }} />
      ))}
    </div>
  );
};

const Legend = ({ items }: { items: { label: string; text: string; color?: string }[] }) => (
  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
    {items.map((i) => (
      <div key={i.label}>
        {i.color && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: i.color, marginRight: 5 }} />}
        {i.label}: <b style={{ color: "var(--text)" }}>{i.text}</b>
      </div>
    ))}
  </div>
);

const C = { paid: "#16a34a", unpaid: "#f59e0b", na: "#94a3b8",
  a0: "#16a34a", a1: "#eab308", a2: "#f97316", a3: "#dc2626",
  uts: "#c5141c", avtomuv: "#2563eb", fop: "#7c3aed", unknown: "#94a3b8" };

export function ReceivablesTiles({ totals, debtTotal, clientCount, overdueCount, overdueSum }: {
  totals: ReceivableTotals | null;
  debtTotal: number;
  clientCount: number;
  overdueCount: number;
  overdueSum: number;
}) {
  const carrier = totals ? { paid: t(totals.carrier.paid), unpaid: t(totals.carrier.unpaid), na: t(totals.carrier.na) } : null;
  const naWhy = totals
    ? (Object.keys(CARRIER_REASON_LABEL) as (keyof typeof CARRIER_REASON_LABEL)[])
        .map((k) => ({ k, ...t(totals.carrierReason[k]) })).filter((x) => x.n > 0)
    : [];
  const entWhy = totals
    ? (Object.keys(ENTITY_REASON_LABEL) as (keyof typeof ENTITY_REASON_LABEL)[])
        .map((k) => ({ k, ...t(totals.entityReason[k]) })).filter((x) => x.n > 0)
    : [];

  return (
    <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", marginBottom: 16 }}>
      <div className="kpi-card" style={{ borderTop: "3px solid #c5141c" }}>
        <span className="kpi-label">Загальний борг</span>
        <span className="kpi-value" title={formatAmountFull(debtTotal)}>{formatAmount(debtTotal)}</span>
        {totals && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{totals.invoices} рахунків · {clientCount} боржників</span>}
      </div>

      <div className="kpi-card" style={{ borderTop: `3px solid ${overdueCount ? "#dc2626" : "#16a34a"}` }}>
        <span className="kpi-label">Прострочено (понад ліміт)</span>
        <span className="kpi-value" style={{ color: overdueCount ? "#dc2626" : "#16a34a" }}>{overdueCount}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {overdueCount ? formatAmount(overdueSum) : "усе в межах ліміту"}
        </span>
      </div>

      {carrier && (
        <div className="kpi-card" style={{ borderTop: "3px solid #16a34a" }}>
          <span className="kpi-label">Перевізник оплачений</span>
          <span className="kpi-value" title={formatAmountFull(carrier.paid.amount)}>{formatAmount(carrier.paid.amount)}</span>
          <Bar parts={[
            { label: "paid", value: carrier.paid.amount, color: C.paid, hint: `перевізник оплачений · ${carrier.paid.n} рах.` },
            { label: "unpaid", value: carrier.unpaid.amount, color: C.unpaid, hint: `ще не оплачено · ${carrier.unpaid.n} рах.` },
            { label: "na", value: carrier.na.amount, color: C.na, hint: `н/д · ${carrier.na.n} рах.` },
          ]} />
          <Legend items={[
            { label: "ще не оплачено", text: `${formatAmount(carrier.unpaid.amount)} · ${carrier.unpaid.n} рах.`, color: C.unpaid },
            /* 🔴 «н/д» — ОКРЕМА величина, а не частина «не оплачено». Заміряно:
               злиття дало б 1 589 000 ₴ фальшивої неоплати, тобто 28% зверху. */
            { label: "н/д (не знаємо)", text: `${formatAmount(carrier.na.amount)} · ${carrier.na.n} рах.`, color: C.na },
          ]} />
          {naWhy.length > 0 && (
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 4, display: "block" }}>
              н/д тому, що: {naWhy.map((x) => `${CARRIER_REASON_LABEL[x.k]} — ${x.n}`).join(" · ")}
            </span>
          )}
        </div>
      )}

      {totals && (
        <div className="kpi-card" style={{ borderTop: "3px solid #f97316" }}>
          <span className="kpi-label">Вік боргу</span>
          <span className="kpi-value" style={{ color: t(totals.aging["90+"]).n ? "#dc2626" : "var(--text)" }}>
            {t(totals.aging["90+"]).n ? formatAmount(t(totals.aging["90+"]).amount) : "—"}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>понад 90 днів</span>
          <Bar parts={AGING_ORDER.map((k, i) => ({
            label: k, value: t(totals.aging[k]).amount, color: [C.a0, C.a1, C.a2, C.a3][i],
            hint: `${AGING_LABEL[k]} · ${t(totals.aging[k]).n} рах. · ${formatAmount(t(totals.aging[k]).amount)}`,
          }))} />
          <Legend items={AGING_ORDER.map((k, i) => ({
            label: AGING_LABEL[k], text: `${formatAmount(t(totals.aging[k]).amount)} · ${t(totals.aging[k]).n}`,
            color: [C.a0, C.a1, C.a2, C.a3][i],
          }))} />
        </div>
      )}

      {totals && (
        <div className="kpi-card" style={{ borderTop: "3px solid #2563eb" }}>
          <span className="kpi-label">За нашою юрособою</span>
          <span className="kpi-value" title={formatAmountFull(t(totals.entity.uts).amount)}>{formatAmount(t(totals.entity.uts).amount)}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ЮТС · найбільша частка</span>
          <Bar parts={(["uts", "avtomuv", "fop", "unknown"] as const).map((k) => ({
            label: k, value: t(totals.entity[k]).amount, color: C[k],
            hint: `${ENTITY_LABEL[k]} · ${t(totals.entity[k]).n} рах. · ${formatAmount(t(totals.entity[k]).amount)}`,
          }))} />
          <Legend items={(["avtomuv", "fop", "unknown"] as const).map((k) => ({
            label: ENTITY_LABEL[k], text: `${formatAmount(t(totals.entity[k]).amount)} · ${t(totals.entity[k]).n}`, color: C[k],
          }))} />
          {entWhy.length > 0 && (
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 4, display: "block" }}>
              невідомо тому, що: {entWhy.map((x) => `${ENTITY_REASON_LABEL[x.k]} — ${x.n}`).join(" · ")}
            </span>
          )}
          {totals.pipelinesOutOfMap.length > 0 && (
            /* 🔴 НАЗИВАЄМО воронку, а не ховаємо рахунок (рішення власника). Сховати
               означало б, що гроші зникли з екрана без жодного сліду. */
            <span style={{ fontSize: 10.5, color: "var(--warn)", marginTop: 4, display: "block" }}>
              ⚠️ воронка поза мапою етапів: {totals.pipelinesOutOfMap.join(", ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
