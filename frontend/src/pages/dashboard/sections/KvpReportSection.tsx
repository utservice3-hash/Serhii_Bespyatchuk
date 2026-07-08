import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchOverview, fetchLeadQuality, type ExecutiveOverview, type LeadQuality } from "../../../api";
import { formatAmount, formatAmountFull, previousRange } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";

/** Пояснення джерела даних кожного показника (звідки береться з CRM). */
const METRIC_HINTS: Record<string, string> = {
  received: "«Успішно реалізовано» (статус 142, за датою закриття в періоді) + «Оплата отримана» (статуси 69716460/60412544, знімок поточного етапу).",
  success: "Угоди в статусі «Успішна угода» (142), за датою закриття угоди в періоді.",
  payment: "Угоди, що ЗАРАЗ на етапі «Оплата отримана» (знімок, без фільтра дати).",
  avg: "Отримані кошти ÷ кількість угод.",
  repeatRev: "Отримані кошти від постійних клієнтів (2+ оплачені перевезення lifetime).",
  newRev: "Отримані кошти від нових клієнтів (перша оплата за всю історію в періоді).",
  carryover: "Знімок угод, ще в роботі на 1-ше число місяця (рахунок→оплата, крім «Успішна»).",
  created: "Створені угоди повного циклу (пайплайни 8921932 + 155304) за датою створення в періоді.",
  newClients: "Клієнти, чия перша оплата за всю історію припала на період.",
  repeatClients: "Клієнти з 2+ оплаченими перевезеннями lifetime, що замовляли в періоді.",
  receivables: "Сума неоплаченої дебіторки з Google-таблиці (оновлюється кожні 30 хв).",
  adBudget: "Витрати на рекламу з Google-таблиці (сума денних Cost за період).",
  adGaLeads: "Заявки з Google Ads (конверсії) з тієї ж таблиці.",
  adLeads: "Ліди з реклами (google-utm) в CRM за період.",
  adPaid: "Скільки рекламних лідів дійшли до оплаченої угоди повного циклу.",
  adConv: "Оплачено з реклами ÷ ліди з реклами × 100%.",
  target: "Цільові = пайплайн повного циклу 8921932, створені в періоді.",
  nonTarget: "Не цільові = Кваліфікація 8921928, статус 143 (відмова), створені в періоді.",
  transferred: "Заявки, які лідоген передав менеджеру (зміна відповідального в «Кваліфікації»).",
  transferSuccess: "З переданих заявок — скільки закрито як «Успішна угода» в періоді.",
  leadgenConv: "Передані заявки, чий клієнт дійшов до оплаченої угоди ÷ усі передані × 100%.",
};

type Range = { from: string; to: string; label?: string };
type Unit = "money" | "moneyFull" | "num" | "pct";
type Block = { ov: ExecutiveOverview; lq: LeadQuality };

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dmy = (iso: string) => iso.split("-").reverse().join(".");

/** Full calendar range of month m0 (0-based) in year y. */
function fullMonthRange(y: number, m0: number): Range {
  return { from: ymd(new Date(y, m0, 1)), to: ymd(new Date(y, m0 + 1, 0)) };
}

/** Fixed 7-day blocks from the 1st: [1-7],[8-14],[15-21],[22-28],[29-end].
 *  Matches how the manager sheet splits a month into "тижні". */
function weekBlocksFor(y: number, m0: number): Range[] {
  const last = new Date(y, m0 + 1, 0).getDate();
  return [1, 8, 15, 22, 29]
    .filter((s) => s <= last)
    .map((s, i) => ({
      from: ymd(new Date(y, m0, s)),
      to: ymd(new Date(y, m0, Math.min(s + 6, last))),
      label: `Тиждень ${i + 1}`,
    }));
}

/** Index (0..4) of the fixed 7-day block that a given day-of-month falls into. */
const blockIndexOf = (dayOfMonth: number) => Math.min(4, Math.floor((dayOfMonth - 1) / 7));

const MONTH_NAMES = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

const avgCheck = (o: ExecutiveOverview) => {
  const n = o.successDeals + o.paymentDeals;
  return n > 0 ? Math.round(o.fact / n) : 0;
};

// Похідні плани з місячного плану виручки (2.7 млн): авто = план ÷ сер.чек;
// створені угоди = авто ÷ заг.конверсія (оплачені/створені); ліди з реклами =
// авто ÷ конверсія реклами. Всі коефіцієнти — поточні фактичні з CRM.
const planCars = (o: ExecutiveOverview, plan: number) => {
  const avg = avgCheck(o);
  return avg > 0 ? Math.ceil(plan / avg) : null;
};
const planCreated = (o: ExecutiveOverview, plan: number) => {
  const cars = planCars(o, plan);
  const conv = o.createdFullCycle > 0 ? (o.successDeals + o.paymentDeals) / o.createdFullCycle : 0;
  return cars != null && conv > 0 ? Math.ceil(cars / conv) : null;
};
const planAdLeads = (o: ExecutiveOverview, plan: number) => {
  const cars = planCars(o, plan);
  const conv = o.adConversion.conversion;
  return cars != null && conv > 0 ? Math.ceil(cars / (conv / 100)) : null;
};
const monthPlanOf = (o: ExecutiveOverview, isMonth: boolean) => (isMonth ? o.planMonthTotal : o.plan);

type Metric = {
  key: string;
  label: string;
  unit: Unit;
  get: (b: Block) => number;
  plan?: (b: Block, isMonth: boolean) => number | null;
  sumInWeekly?: boolean;
};

const METRIC_GROUPS: { group: string; metrics: Metric[] }[] = [
  {
    group: "💰 Дохід",
    metrics: [
      { key: "received", label: "Отримані кошти (успішно + оплата)", unit: "money", get: (b) => b.ov.fact, plan: (b, m) => (m ? b.ov.planMonthTotal : b.ov.plan), sumInWeekly: true },
      { key: "success", label: "Успішно закрито", unit: "money", get: (b) => b.ov.successRevenue, sumInWeekly: true },
      { key: "payment", label: "Оплата отримана", unit: "money", get: (b) => b.ov.paymentRevenue },
      { key: "avg", label: "Середній чек", unit: "moneyFull", get: (b) => avgCheck(b.ov) },
      { key: "repeatRev", label: "Виручка від постійних", unit: "money", get: (b) => b.ov.repeatRevenue, sumInWeekly: true },
      { key: "newRev", label: "Виручка від нових", unit: "money", get: (b) => b.ov.newRevenue, sumInWeekly: true },
      { key: "carryover", label: "Перенесено з мин. місяця", unit: "money", get: (b) => b.ov.carryover?.amount ?? 0 },
    ],
  },
  {
    group: "👥 Угоди та клієнти",
    metrics: [
      { key: "created", label: "Створені угоди (повний цикл)", unit: "num", get: (b) => b.ov.createdFullCycle, plan: (b, m) => planCreated(b.ov, monthPlanOf(b.ov, m)), sumInWeekly: true },
      { key: "newClients", label: "Нові клієнти", unit: "num", get: (b) => b.ov.newClients, sumInWeekly: true },
      { key: "repeatClients", label: "Постійні клієнти", unit: "num", get: (b) => b.ov.repeatClients },
      { key: "receivables", label: "Дебіторка (знімок)", unit: "money", get: (b) => b.ov.receivablesTotal },
    ],
  },
  {
    group: "🎯 Реклама",
    metrics: [
      { key: "adBudget", label: "Рекламний бюджет", unit: "money", get: (b) => b.lq.adBudgetFact, plan: (b) => b.lq.adBudgetPlan, sumInWeekly: true },
      { key: "adGaLeads", label: "Заявки з реклами (GA)", unit: "num", get: (b) => b.lq.adBudgetLeads, sumInWeekly: true },
      { key: "adLeads", label: "Ліди з реклами (CRM)", unit: "num", get: (b) => b.ov.adConversion.leads, plan: (b, m) => planAdLeads(b.ov, monthPlanOf(b.ov, m)), sumInWeekly: true },
      { key: "adPaid", label: "Оплачено з реклами", unit: "num", get: (b) => b.ov.adConversion.paid },
      { key: "adConv", label: "Конверсія реклами", unit: "pct", get: (b) => b.ov.adConversion.conversion },
      { key: "target", label: "Цільові ліди (повний цикл)", unit: "num", get: (b) => b.lq.targetLeads, sumInWeekly: true },
      { key: "nonTarget", label: "Не цільові ліди (Кваліф. 143)", unit: "num", get: (b) => b.lq.nonTargetLeads, sumInWeekly: true },
    ],
  },
  {
    group: "📞 Лідогенератори",
    metrics: [
      { key: "transferred", label: "Передані заявки", unit: "num", get: (b) => b.ov.transferred.total, sumInWeekly: true },
      { key: "transferSuccess", label: "Успішно з переданих", unit: "num", get: (b) => b.ov.transferred.success, sumInWeekly: true },
      { key: "leadgenConv", label: "Конверсія лідогену", unit: "pct", get: (b) => b.ov.leadgenConversion.conversion },
    ],
  },
];

function fmtVal(v: number, unit: Unit) {
  if (unit === "money") return formatAmount(v);
  if (unit === "moneyFull") return formatAmountFull(v);
  if (unit === "pct") return `${v}%`;
  return v.toLocaleString("uk-UA");
}

function Delta({ prev, cur }: { prev: number; cur: number }) {
  const diff = cur - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : cur > 0 ? 100 : 0;
  const color = diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : "var(--text-muted)";
  const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
  return <span style={{ color, fontWeight: 600, whiteSpace: "nowrap" }}>{arrow} {Math.abs(pct)}%</span>;
}

/** Two-period comparison: dynamics is always vs the analogous period a month ago. */
function ComparisonTable({ prev, cur, prevRange, curRange, isMonth }: { prev: Block; cur: Block; prevRange: Range; curRange: Range; isMonth: boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 660 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Показник</th>
            <th style={{ textAlign: "right" }}>{dmy(prevRange.from)}–{dmy(prevRange.to)}</th>
            <th style={{ textAlign: "right" }}>{dmy(curRange.from)}–{dmy(curRange.to)}</th>
            <th style={{ textAlign: "right" }}>Динаміка*<InfoHint text="(поточний − попередній) ÷ попередній × 100%. ↑ зелений — ріст, ↓ червоний — падіння до попереднього рівного періоду." /></th>
            <th style={{ textAlign: "right" }}>План</th>
            <th style={{ textAlign: "right" }}>Викон.<InfoHint text="Факт ÷ план × 100%. Плани: гроші й рекл. бюджет — з таблиці планів; «створені угоди» = план ÷ сер.чек ÷ заг.конверсія; «ліди з реклами» = авто ÷ конверсія реклами (розрахункові з поточних коефіцієнтів CRM)." /></th>
          </tr>
        </thead>
        <tbody>
          {METRIC_GROUPS.map((g) => (
            <Fragment key={g.group}>
              <tr>
                <td colSpan={6} style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>{g.group}</td>
              </tr>
              {g.metrics.map((mt) => {
                const pv = mt.get(prev), cv = mt.get(cur);
                const plan = mt.plan ? mt.plan(cur, isMonth) : null;
                const pct = plan != null && plan > 0 ? Math.round((cv / plan) * 100) : null;
                const pctColor = pct == null ? "var(--text-muted)" : pct >= 100 ? "#16a34a" : pct >= 70 ? "#d97706" : "#dc2626";
                return (
                  <tr key={mt.key}>
                    <td style={{ textAlign: "left" }}>{mt.label}{METRIC_HINTS[mt.key] && <InfoHint text={METRIC_HINTS[mt.key]} />}</td>
                    <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{fmtVal(pv, mt.unit)}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtVal(cv, mt.unit)}</td>
                    <td style={{ textAlign: "right" }}><Delta prev={pv} cur={cv} /></td>
                    <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{plan != null ? fmtVal(plan, mt.unit) : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 600, color: pctColor }}>{pct != null ? `${pct}%` : "—"}</td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous month split into fixed 7-day weeks (columns), summable metrics as rows. */
function WeeklyBreakdown({ weeks, blocks }: { weeks: Range[]; blocks: Block[] }) {
  const summable = METRIC_GROUPS.flatMap((g) => g.metrics.filter((m) => m.sumInWeekly));
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Показник</th>
            {weeks.map((w, i) => (
              <th key={i} style={{ textAlign: "right" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{dmy(w.from)}–{dmy(w.to)}</div></th>
            ))}
            <th style={{ textAlign: "right" }}>Разом</th>
          </tr>
        </thead>
        <tbody>
          {summable.map((mt) => {
            const vals = blocks.map((b) => mt.get(b));
            const total = vals.reduce((s, v) => s + v, 0);
            return (
              <tr key={mt.key}>
                <td style={{ textAlign: "left" }}>{mt.label}</td>
                {vals.map((v, i) => (
                  <td key={i} style={{ textAlign: "right" }}>{fmtVal(v, mt.unit)}</td>
                ))}
                <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtVal(total, mt.unit)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Plan decomposition: from the revenue plan + current avg check we derive how
 *  many cars must be dispatched and (via conversion) how many leads are needed,
 *  and show what's still left to reach the plan. Whole-department for now. */
function Decomposition({ b, periodPlan }: { b: Block; periodPlan?: boolean }) {
  const o = b.ov;
  const plan = periodPlan ? o.plan : (o.planMonthTotal || o.plan);
  const avg = avgCheck(o);
  const carsDone = o.successDeals + o.paymentDeals;
  const carsNeeded = avg > 0 ? Math.ceil(plan / avg) : 0;
  const carsLeft = Math.max(0, carsNeeded - carsDone);
  const conv = o.adConversion.conversion; // %
  const leadsDone = o.adConversion.leads;
  const leadsNeeded = conv > 0 ? Math.ceil(carsNeeded / (conv / 100)) : 0;
  const leadsLeft = Math.max(0, leadsNeeded - leadsDone);
  // «Вже» по доходу = отримано цього місяця + перенесені угоди з минулого місяця.
  const carry = o.carryover?.amount ?? 0;
  const revDone = o.fact + carry;
  const revLeft = Math.max(0, plan - revDone);
  // Темп/прогноз і «на день»: залишок ÷ майбутні робочі дні місяця.
  const pj = o.projection;
  const daysLeft = Math.max(0, (pj?.totalWorkingDays ?? 0) - (pj?.elapsedWorkingDays ?? 0));
  const perDay = (left: number) => (daysLeft > 0 ? Math.ceil(left / daysLeft) : null);
  const planToday = o.plan; // пропорція плану на пройдені роб. дні
  const tempo = planToday > 0 ? Math.round((o.fact / planToday) * 100) : null;

  const num = (v: number) => v.toLocaleString("uk-UA");
  const rows: { label: string; need: string; done: string; left: string; day: string }[] = [
    { label: "Дохід (грн)", need: formatAmount(plan), done: formatAmount(revDone), left: formatAmount(revLeft), day: perDay(revLeft) != null ? formatAmount(perDay(revLeft)!) : "—" },
    { label: "Авто (угод)", need: carsNeeded ? num(carsNeeded) : "—", done: num(carsDone), left: num(carsLeft), day: carsNeeded && perDay(carsLeft) != null ? num(perDay(carsLeft)!) : "—" },
    { label: "Ліди (реклама)", need: leadsNeeded ? num(leadsNeeded) : "—", done: num(leadsDone), left: num(leadsLeft), day: leadsNeeded && perDay(leadsLeft) != null ? num(perDay(leadsLeft)!) : "—" },
  ];

  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 4px" }}>🎯 Декомпозиція плану ({periodPlan ? "обраний період" : "місяць"}, по відділу)</h3>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        Поточний ср. чек {formatAmountFull(avg)} · конверсія реклами {conv}%. Треба авто = план ÷ ср.чек; треба лідів = авто ÷ конверсія. «Вже» по доходу = отримано цього місяця + перенесені з минулого{carry > 0 ? ` (${formatAmount(carry)})` : ""}. «На день» = лишилось ÷ {daysLeft} роб. днів до кінця місяця.
      </p>
      {!periodPlan && pj && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 10 }}>
          <div className="kpi-card"><span className="kpi-label">План на сьогодні</span><span className="kpi-value">{formatAmount(planToday)}</span></div>
          <div className="kpi-card"><span className="kpi-label">Темп</span><span className="kpi-value" style={{ color: tempo == null ? undefined : tempo >= 100 ? "#16a34a" : tempo >= 70 ? "#d97706" : "#dc2626" }}>{tempo != null ? `${tempo}%` : "—"}</span></div>
          <div className="kpi-card"><span className="kpi-label">Прогноз місяця</span><span className="kpi-value">{formatAmount(pj.projected)}{pj.projectedPct != null && <span style={{ fontSize: 12, color: pj.projectedPct >= 100 ? "#16a34a" : "#dc2626", fontWeight: 600 }}> · {pj.projectedPct}%</span>}</span></div>
          <div className="kpi-card"><span className="kpi-label">Роб. днів минуло</span><span className="kpi-value">{pj.elapsedWorkingDays}/{pj.totalWorkingDays}</span></div>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table className="data-table compact" style={{ minWidth: 500 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Метрика</th>
              <th style={{ textAlign: "right" }}>Треба (план)</th>
              <th style={{ textAlign: "right" }}>Вже</th>
              <th style={{ textAlign: "right" }}>Лишилось</th>
              <th style={{ textAlign: "right" }}>На день</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={{ textAlign: "left" }}>{r.label}</td>
                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{r.need}</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{r.done}</td>
                <td style={{ textAlign: "right", fontWeight: 700, color: "#d97706" }}>{r.left}</td>
                <td style={{ textAlign: "right", fontWeight: 700, color: "#c5141c" }}>{r.day}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamTable({ prev, cur }: { prev: ExecutiveOverview; cur: ExecutiveOverview }) {
  const prevByTeam = new Map(prev.byTeam.map((t) => [t.teamId, t]));
  if (cur.byTeam.length === 0) return null;
  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table className="data-table compact" style={{ minWidth: 520 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Команда</th>
            <th style={{ textAlign: "right" }}>Мин. міс.</th>
            <th style={{ textAlign: "right" }}>Поточний</th>
            <th style={{ textAlign: "right" }}>Угод</th>
            <th style={{ textAlign: "right" }}>Динаміка*</th>
          </tr>
        </thead>
        <tbody>
          {cur.byTeam.map((t) => {
            const pv = prevByTeam.get(t.teamId);
            return (
              <tr key={t.teamId}>
                <td style={{ textAlign: "left" }}>{t.teamName}</td>
                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(pv?.revenue ?? 0)}</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{formatAmount(t.revenue)}</td>
                <td style={{ textAlign: "right" }}>{t.deals}</td>
                <td style={{ textAlign: "right" }}><Delta prev={pv?.revenue ?? 0} cur={t.revenue} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Звіт КВП — department-head scorecard. Admin/КВП only. Auto-filled from CRM +
 *  Google Ads sheet. Dynamics is always vs the analogous period a month earlier. */
const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

export function KvpReportSection() {
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("kvpMonth") || curMonthStr());
  // Довільний період (календар). Активний, коли обидві дати заповнені —
  // тоді звіт рахується за ним (vs попередній рівний період), інакше — місяць.
  const [range, setRange] = useState<{ from: string; to: string }>(() => {
    try { const v = JSON.parse(localStorage.getItem("kvpRange") || "null"); return v && v.from && v.to ? v : { from: "", to: "" }; } catch { return { from: "", to: "" }; }
  });
  const rangeMode = !!(range.from && range.to);
  const rangePrev = rangeMode ? previousRange(range.from, range.to) : null;

  const setup = useMemo(() => {
    const [selY, selM] = monthSel.split("-").map(Number);
    const y = selY, m0 = selM - 1;
    const now = new Date();
    const isCurrentMonth = y === now.getFullYear() && m0 === now.getMonth();
    const today = ymd(now);

    const monthPrev = fullMonthRange(m0 === 0 ? y - 1 : y, m0 === 0 ? 11 : m0 - 1);
    const full = fullMonthRange(y, m0);
    const monthCur: Range = isCurrentMonth ? { ...full, to: today } : full; // MTD for current
    const selWeeks = weekBlocksFor(y, m0);

    // "Поточний тиждень" only makes sense for the current month.
    let curWeek: Range | null = null;
    let analogWeek: Range | null = null;
    if (isCurrentMonth) {
      const idx = Math.min(blockIndexOf(now.getDate()), selWeeks.length - 1);
      const wf = selWeeks[idx];
      curWeek = { ...wf, to: today < wf.to ? today : wf.to };
      const prevWeeks = weekBlocksFor(m0 === 0 ? y - 1 : y, m0 === 0 ? 11 : m0 - 1);
      analogWeek = prevWeeks[Math.min(idx, prevWeeks.length - 1)];
    }
    const monthLabel = `${MONTH_NAMES[m0]} ${y}`;
    return { monthPrev, monthCur, selWeeks, curWeek, analogWeek, isCurrentMonth, monthLabel };
  }, [monthSel]);

  const [data, setData] = useState<{
    monthPrev: Block; monthCur: Block; selWeeks: Block[]; curWeek: Block | null; analogWeek: Block | null;
  } | null>(null);
  const [rangeData, setRangeData] = useState<{ cur: Block; prev: Block } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadBlock = async (r: Range): Promise<Block> => {
    const [ov, lq] = await Promise.all([fetchOverview(r), fetchLeadQuality(r)]);
    return { ov, lq };
  };

  // Custom-range mode: chosen dates vs previous equal-length period.
  useEffect(() => {
    if (!rangeMode || !rangePrev) return;
    let alive = true;
    setRangeData(null);
    setErr(null);
    (async () => {
      try {
        const [cur, prev] = await Promise.all([loadBlock(range), loadBlock(rangePrev)]);
        if (alive) setRangeData({ cur, prev });
      } catch { if (alive) setErr("Не вдалося завантажити звіт."); }
    })();
    return () => { alive = false; };
  }, [rangeMode, range.from, range.to]);

  useEffect(() => {
    if (rangeMode) return;
    let alive = true;
    setData(null);
    setErr(null);
    const load = loadBlock;
    (async () => {
      try {
        const extra = setup.curWeek && setup.analogWeek ? [setup.curWeek, setup.analogWeek] : [];
        const results = await Promise.all([
          load(setup.monthPrev), load(setup.monthCur),
          ...setup.selWeeks.map(load),
          ...extra.map(load),
        ]);
        if (!alive) return;
        const monthPrev = results[0];
        const monthCur = results[1];
        const selWeeks = results.slice(2, 2 + setup.selWeeks.length);
        const curWeek = extra.length ? results[2 + setup.selWeeks.length] : null;
        const analogWeek = extra.length ? results[2 + setup.selWeeks.length + 1] : null;
        setData({ monthPrev, monthCur, selWeeks, curWeek, analogWeek });
      } catch {
        if (alive) setErr("Не вдалося завантажити звіт.");
      }
    })();
    return () => { alive = false; };
  }, [setup, rangeMode]);

  const setRangeP = (r: { from: string; to: string }) => { setRange(r); localStorage.setItem("kvpRange", JSON.stringify(r)); };

  const shiftMonth = (delta: number) => {
    const [y, m] = monthSel.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (next > curMonthStr()) return; // не даємо йти в майбутнє
    setMonthSel(next);
    localStorage.setItem("kvpMonth", next);
  };
  const pickMonth = (v: string) => {
    if (!v || v > curMonthStr()) return;
    setMonthSel(v);
    localStorage.setItem("kvpMonth", v);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 Звіт КВП</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => shiftMonth(-1)} title="Попередній місяць"
            style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>←</button>
          <DatePicker mode="month" value={monthSel} onChange={(v) => v && pickMonth(v)} minWidth={150} />
          <button onClick={() => shiftMonth(1)} disabled={monthSel >= curMonthStr()} title="Наступний місяць"
            style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: monthSel >= curMonthStr() ? "default" : "pointer", opacity: monthSel >= curMonthStr() ? 0.5 : 1 }}>→</button>
          <span style={{ color: "var(--text-muted)", margin: "0 2px" }}>або період:</span>
          <DatePicker value={range.from} onChange={(v) => setRangeP({ ...range, from: v })} placeholder="від" minWidth={130} />
          <span style={{ color: "var(--text-muted)" }}>—</span>
          <DatePicker value={range.to} onChange={(v) => setRangeP({ ...range, to: v })} placeholder="до" minWidth={130} />
          {(range.from || range.to) && (
            <button onClick={() => setRangeP({ from: "", to: "" })} title="Очистити період (повернутись до місяця)"
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>✕</button>
          )}
        </div>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 820 }}>
        Зведення керівника відділу продажу — автоматично з CRM та Google-таблиці реклами. Оберіть <b>місяць</b> або задайте <b>довільний період</b> у календарі.
        <br /><b>Динаміка (*)</b> = наскільки поточний період більший/менший за попередній: <code>(поточний − попередній) ÷ попередній × 100%</code>.
        Для місяця порівняння — до <b>минулого місяця</b>; для довільного періоду — до <b>попереднього рівного за довжиною</b> (напр. 01–06.07 → 25–30.06).
        Колонка <b>«Викон.»</b> = факт ÷ план × 100%.
      </p>

      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}

      {rangeMode && !rangeData && !err && <p className="loading-text">Завантаження…</p>}
      {rangeMode && rangeData && rangePrev && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <h2 className="chart-title">📆 {dmy(range.from)}–{dmy(range.to)} (vs {dmy(rangePrev.from)}–{dmy(rangePrev.to)})</h2>
          <ComparisonTable prev={rangeData.prev} cur={rangeData.cur} prevRange={rangePrev} curRange={range} isMonth={false} />
          <Decomposition b={rangeData.cur} periodPlan />
          <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0 4px" }}>По командах</h3>
          <TeamTable prev={rangeData.prev.ov} cur={rangeData.cur.ov} />
        </div>
      )}

      {!rangeMode && !data && !err && <p className="loading-text">Завантаження…</p>}
      {!rangeMode && data && (
        <>
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">📅 {setup.monthLabel} (vs попередній місяць)</h2>
            <ComparisonTable prev={data.monthPrev} cur={data.monthCur} prevRange={setup.monthPrev} curRange={setup.monthCur} isMonth />
            <Decomposition b={data.monthCur} />
            <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0 4px" }}>По командах</h3>
            <TeamTable prev={data.monthPrev.ov} cur={data.monthCur.ov} />
          </div>

          {data.curWeek && data.analogWeek && setup.curWeek && setup.analogWeek && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">🗓️ Поточний тиждень (vs той самий тиждень минулого місяця)</h2>
              <ComparisonTable prev={data.analogWeek} cur={data.curWeek} prevRange={setup.analogWeek} curRange={setup.curWeek} isMonth={false} />
            </div>
          )}

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">📊 {setup.monthLabel} по тижнях</h2>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>
              Тижні = фіксовані 7-денні блоки від 1-го числа (1–7, 8–14, 15–21, 22–28, 29–кінець).
            </p>
            <WeeklyBreakdown weeks={setup.selWeeks} blocks={data.selWeeks} />
          </div>
        </>
      )}
    </>
  );
}
