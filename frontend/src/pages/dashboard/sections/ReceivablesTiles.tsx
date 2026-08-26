import type { ReceivableTotals } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import {
  AGING_LABEL, AGING_ORDER, CARRIER_REASON_LABEL, ENTITY_LABEL, ENTITY_REASON_LABEL, t,
  marginHint, marginPctText,
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
  <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
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

export function ReceivablesTiles({ totals, debtTotal, clientCount, overdueCount, overdueSum,
                                  overdueBeyondAgreed, overdueNoLimit }: {
  totals: ReceivableTotals | null;
  debtTotal: number;
  clientCount: number;
  overdueCount: number;
  overdueSum: number;
  overdueBeyondAgreed: number;
  overdueNoLimit: number;
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
      {/* 🔴 СМУГИ ЗВЕРХУ ПРИБРАНО З УСІХ ПʼЯТИ (Е4b). Пʼять різних кольорів у ряд
          читались як світлофор — ніби плитки різного «стану». Насправді вони просто
          різні метрики, і колір нічого про них не казав. Колір лишився там, де він
          щось означає: червоне число прострочки й сегменти смужок. */}
      <div className="kpi-card">
        <span className="kpi-label">Загальний борг</span>
        <span className="kpi-value" title={formatAmountFull(debtTotal)}>{formatAmount(debtTotal)}</span>
        {totals && <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{totals.invoices} рахунків · {clientCount} боржників</span>}
        {/* 🗑 ПІДПИС «СПИСАНО» ЗВІДСИ ПРИБРАНО — рішення власника 26.08.2026,
            і воно СКАСОВУЄ попереднє «плитка мусить казати, на скільки просіла».
            Причина: списаний борг зникає з активної дебіторки повністю, а все
            про нього живе у вкладці «Архів» — із сумою, причиною, автором, датою
            й кнопкою повернення. Підпис тут дублював би вкладку й лишав борг
            наполовину видимим у двох місцях, тобто саме тим «двома джерелами
            одного числа», від якого ми весь тиждень і лікуємось.
            ⚠️ Число НЕ просідає мовчки: поруч є вкладка «Архів» із лічильником. */}
        {/* 🔴 ПЛИТКА БІЛЬШЕ НЕ ПОРОЖНЯ. Дві перші були білими плямами на початку
            екрана, поки три сусідні несли розклад — читалось як «тут нема чого
            показати». Розклад той самий, що й у сусідів, і з ТОГО САМОГО виразу
            прострочки: гроші в межах домовленості проти грошей поза нею. */}
        <Bar parts={[
          { label: "ok", value: Math.max(0, debtTotal - overdueSum), color: C.paid,
            hint: `у межах домовленості · ${clientCount - overdueCount} боржників` },
          { label: "over", value: overdueSum, color: C.a3,
            hint: `прострочено · ${overdueCount} боржників` },
        ]} />
        <Legend items={[
          { label: "у межах домовленості", text: `${formatAmount(Math.max(0, debtTotal - overdueSum))} · ${clientCount - overdueCount}`, color: C.paid },
          { label: "прострочено", text: `${formatAmount(overdueSum)} · ${overdueCount}`, color: C.a3 },
        ]} />
      </div>

      <div className="kpi-card">
        {/* 🔴 «(понад ліміт)» ПРИБРАНО в Е4, і це не косметика. Після зміни правила
            сюди входять і клієнти, у яких ліміту НЕМАЄ — тобто заголовок стверджував
            би те, чого число вже не означає. Рівно той клас підміни, що «сер.чек ÷
            авто» і «синхронізовано із Задачником»: підпис правдоподібний, величина
            за ним інша. Що саме входить — каже розклад під числом. */}
        <span className="kpi-label">Прострочено</span>
        <span className="kpi-value" style={{ color: overdueCount ? "#dc2626" : "#16a34a" }}>{overdueCount}</span>
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          {overdueCount ? formatAmount(overdueSum) : "усе в межах ліміту"}
        </span>
        {/* 🔴 ДВІ ПРИЧИНИ ПІД ОДНИМ ЧИСЛОМ. «Понад термін» — класична прострочка;
            «ліміт не узгоджено» — клієнти, яким відстрочку не давали (немає рядка
            або 0 днів), тож будь-який несплачений рахунок для них прострочений.
            Число одне (правило власника), але без цього розкладу воно читалось би
            як «стільки клієнтів у біді», а серед них є рахунки віком 3 дні. */}
        {overdueCount > 0 && (
          <>
            <Bar parts={[
              { label: "beyond", value: overdueBeyondAgreed, color: C.a3,
                hint: `перевищили УЗГОДЖЕНИЙ термін · ${overdueBeyondAgreed}` },
              { label: "nolimit", value: overdueNoLimit, color: C.unpaid,
                hint: `ліміт не узгоджено — відстрочки не давали · ${overdueNoLimit}` },
            ]} />
            <Legend items={[
              { label: "понад узгоджений ліміт", text: String(overdueBeyondAgreed), color: C.a3 },
              { label: "ліміт не узгоджено", text: String(overdueNoLimit), color: C.unpaid },
            ]} />
          </>
        )}
      </div>

      {carrier && (
        <div className="kpi-card">
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
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginTop: 4, display: "block" }}>
              н/д тому, що: {naWhy.map((x) => `${CARRIER_REASON_LABEL[x.k]} — ${x.n}`).join(" · ")}
            </span>
          )}
        </div>
      )}

      {totals && (
        <div className="kpi-card">
          <span className="kpi-label">Вік боргу</span>
          <span className="kpi-value" style={{ color: t(totals.aging["90+"]).n ? "#dc2626" : "var(--text)" }}>
            {t(totals.aging["90+"]).n ? formatAmount(t(totals.aging["90+"]).amount) : "—"}
          </span>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>понад 90 днів</span>
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
        <div className="kpi-card">
          <span className="kpi-label">За нашою юрособою</span>
          <span className="kpi-value" title={formatAmountFull(t(totals.entity.uts).amount)}>{formatAmount(t(totals.entity.uts).amount)}</span>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>ЮТС · найбільша частка</span>
          <Bar parts={(["uts", "avtomuv", "fop", "unknown"] as const).map((k) => ({
            label: k, value: t(totals.entity[k]).amount, color: C[k],
            hint: `${ENTITY_LABEL[k]} · ${t(totals.entity[k]).n} рах. · ${formatAmount(t(totals.entity[k]).amount)}`,
          }))} />
          <Legend items={(["avtomuv", "fop", "unknown"] as const).map((k) => ({
            label: ENTITY_LABEL[k], text: `${formatAmount(t(totals.entity[k]).amount)} · ${t(totals.entity[k]).n}`, color: C[k],
          }))} />
          {entWhy.length > 0 && (
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginTop: 4, display: "block" }}>
              невідомо тому, що: {entWhy.map((x) => `${ENTITY_REASON_LABEL[x.k]} — ${x.n}`).join(" · ")}
            </span>
          )}
          {totals.pipelinesOutOfMap.length > 0 && (
            /* 🔴 НАЗИВАЄМО воронку, а не ховаємо рахунок (рішення власника). Сховати
               означало б, що гроші зникли з екрана без жодного сліду. */
            <span style={{ fontSize: "var(--fs-xs)", color: "var(--warn)", marginTop: 4, display: "block" }}>
              ⚠️ воронка поза мапою етапів: {totals.pipelinesOutOfMap.join(", ")}
            </span>
          )}
        </div>
      )}

      {/* 💰 СКІЛЬКИ ЗАРОБЛЕНО НА ТОМУ, ЩО ЩЕ НЕ ОПЛАЧЕНЕ (25.08.2026).
          🔴 ЗНАМЕННИК НАЗВАНО В ПІДПИСІ, І ЦЕ ГОЛОВНЕ В ЦІЙ ПЛИТЦІ. «% від
          боргу» був би технічно правдивий і саме тому небезпечний: борг падає
          з кожною оплатою, тож заміряний максимум — 6 667% (клієнт заборгував
          3 ₴ і «заробив» 200). Проти цього «% від суми рахунків» дає медіану
          12.3% і максимум 100.0%.
          Слово «PnL» тут заборонене: це не звіт про прибутки, а відношення
          двох полів CRM. Тримає гейт. */}
      {totals && (
        <div className="kpi-card">
          <span className="kpi-label">Заробили на цих угодах</span>
          <span className="kpi-value" title={marginHint(totals.margin)}>
            {totals.margin?.earned == null ? "—" : formatAmount(totals.margin.earned)}
          </span>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
            {/* «—» тут ВІДПОВІДЬ, а не порожнє місце: причина названа словами. */}
            {totals.margin?.pct == null
              ? marginHint(totals.margin)
              : `${marginPctText(totals.margin)} від суми рахунків (${formatAmount(totals.margin.base ?? 0)})`}
          </span>
          <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginTop: 4, display: "block" }}>
            Знаменник — «Приход 1» із CRM, тобто ПОВНА сума угод, а не залишок боргу.
          </span>
        </div>
      )}
    </div>
  );
}
