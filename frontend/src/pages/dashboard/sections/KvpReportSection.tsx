import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchOverview, fetchLeadQuality, fetchKvpPlan, saveKvpPlan,
  type ExecutiveOverview, type LeadQuality, type KvpPlans,
} from "../../../api";
import { formatAmount, formatAmountFull, previousRange } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";

/** Пояснення джерела даних кожного показника (звідки береться з CRM). */
const HINTS: Record<string, string> = {
  received: "«Успішно реалізовано» (142, за датою закриття в періоді) + «Оплата отримана» (69716460/60412544, знімок).",
  success: "Угоди в статусі «Успішна угода» (142), за датою закриття в періоді.",
  payment: "Угоди, що ЗАРАЗ на етапі «Оплата отримана» (знімок).",
  pending: "Очікувані кошти = сума виставлених рахунків (етап «Виставлено рахунок»), знімок. Мінусові угоди (напр. Київтеплоенерго у Шевчука) віднімаються автоматично — їхній бюджет зберігається відʼємним.",
  avg: "Отримані кошти ÷ кількість угод.",
  repeatRev: "Отримані кошти від постійних клієнтів (2+ оплати lifetime).",
  newRev: "Отримані кошти від нових клієнтів (перша оплата в періоді).",
  carryover: "Знімок угод, ще в роботі на 1-ше число (рахунок→оплата, крім «Успішна»).",
  created: "Створені угоди повного циклу (8921932 + 155304) за датою створення.",
  dispatched: "Відправлені авто (проксі) = успішно закриті + оплата отримана. Один етап «Виставлено рахунок/Авто працює» рахуємо разом.",
  newClients: "Клієнти, чия перша оплата за всю історію припала на період.",
  repeatClients: "Клієнти з 2+ оплатами lifetime, що замовляли в періоді.",
  receivables: "Неоплачена дебіторка (Google-таблиця, кожні 30 хв).",
  adBudget: "Витрати на рекламу з Google-таблиці (сума денних Cost).",
  adGaLeads: "Заявки з Google Ads (конверсії) з тієї ж таблиці.",
  adLeads: "Ліди з реклами (сайтові джерела) в CRM за період.",
  adPaid: "Скільки рекламних лідів дійшли до оплаченої угоди.",
  adConv: "Оплачено з реклами ÷ ліди з реклами × 100%.",
  target: "Цільові = пайплайн повного циклу 8921932, створені в періоді.",
  nonTarget: "Не цільові = Кваліфікація 8921928, статус 143 (відмова).",
  transferred: "Передані заявки з «Реєстру» лідоген-бота (вхід у «Нова заявка від лідогенератора»).",
  transferSuccess: "З переданих — скільки дійшли до успішної угоди.",
  leadgenConv: "Передані, чий клієнт дійшов до оплаченої угоди ÷ усі передані × 100%.",
};

type Range = { from: string; to: string; label?: string };
type Unit = "money" | "moneyFull" | "num" | "pct";
type Block = { ov: ExecutiveOverview; lq: LeadQuality };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dmy = (iso: string) => iso.split("-").reverse().join(".");
const MONTH_NAMES = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

function fullMonthRange(y: number, m0: number): Range { return { from: ymd(new Date(y, m0, 1)), to: ymd(new Date(y, m0 + 1, 0)) }; }
function weekBlocksFor(y: number, m0: number): Range[] {
  const last = new Date(y, m0 + 1, 0).getDate();
  return [1, 8, 15, 22, 29].filter((s) => s <= last).map((s, i) => ({
    from: ymd(new Date(y, m0, s)), to: ymd(new Date(y, m0, Math.min(s + 6, last))), label: `Тиждень ${i + 1}`,
  }));
}
const blockIndexOf = (d: number) => Math.min(4, Math.floor((d - 1) / 7));
const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

const dispatchedFact = (o: ExecutiveOverview) => o.successDeals + o.paymentDeals;
const avgCheck = (o: ExecutiveOverview) => { const n = dispatchedFact(o); return n > 0 ? Math.round(o.fact / n) : 0; };

function fmtVal(v: number, unit: Unit) {
  if (unit === "money") return formatAmount(v);
  if (unit === "moneyFull") return formatAmountFull(v);
  if (unit === "pct") return `${v}%`;
  return v.toLocaleString("uk-UA");
}

const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", MUTED = "var(--text-muted)";
const pctColor = (p: number | null) => (p == null ? MUTED : p >= 100 ? GREEN : p >= 70 ? AMBER : RED);

/** Метрика звіту: як дістати факт, який план (stored/спец), чи потоковий (для темпу/тижнів). */
type PlanKind = "revenue" | "ad_budget" | string | null; // string = kvp_plans metric key
type Metric = {
  key: string; label: string; unit: Unit; group: string;
  get: (b: Block) => number;
  planKind: PlanKind;          // null → без плану (контекст)
  flow: boolean;               // true = сумується/має темп; false = знімок (без прогнозу/тижнів)
  editable?: boolean;          // редагований stored-план
  hint?: string;
};

const METRICS: Metric[] = [
  // 💰 Дохід
  { key: "received", label: "Отримані кошти", unit: "money", group: "💰 Дохід", get: (b) => b.ov.fact, planKind: "revenue", flow: true, hint: HINTS.received },
  { key: "success", label: "Успішно закрито", unit: "money", group: "💰 Дохід", get: (b) => b.ov.successRevenue, planKind: "success", flow: true, editable: true, hint: HINTS.success },
  { key: "payment", label: "Оплата отримана", unit: "money", group: "💰 Дохід", get: (b) => b.ov.paymentRevenue, planKind: null, flow: false, hint: HINTS.payment },
  { key: "pending", label: "⏳ Очікувані оплати", unit: "money", group: "💰 Дохід", get: (b) => b.ov.pendingPayments?.revenue ?? 0, planKind: null, flow: false, hint: HINTS.pending },
  { key: "avg", label: "Середній чек", unit: "moneyFull", group: "💰 Дохід", get: (b) => avgCheck(b.ov), planKind: "avg_check", flow: false, editable: true, hint: HINTS.avg },
  { key: "newRev", label: "Виручка від нових", unit: "money", group: "💰 Дохід", get: (b) => b.ov.newRevenue, planKind: "new_revenue", flow: true, editable: true, hint: HINTS.newRev },
  { key: "repeatRev", label: "Виручка від постійних", unit: "money", group: "💰 Дохід", get: (b) => b.ov.repeatRevenue, planKind: "repeat_revenue", flow: true, editable: true, hint: HINTS.repeatRev },
  { key: "carryover", label: "Перенесено з мин. міс.", unit: "money", group: "💰 Дохід", get: (b) => b.ov.carryover?.amount ?? 0, planKind: null, flow: false, hint: HINTS.carryover },
  // 👥 Угоди та клієнти
  { key: "created", label: "Створені угоди (повний цикл)", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.createdFullCycle, planKind: "created_full_cycle", flow: true, editable: true, hint: HINTS.created },
  { key: "dispatched", label: "Відправлені авто", unit: "num", group: "👥 Угоди та клієнти", get: (b) => dispatchedFact(b.ov), planKind: "dispatched_cars", flow: true, editable: true, hint: HINTS.dispatched },
  { key: "newClients", label: "Нові клієнти", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.newClients, planKind: "new_clients", flow: true, editable: true, hint: HINTS.newClients },
  { key: "repeatClients", label: "Постійні клієнти", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.repeatClients, planKind: "repeat_clients", flow: false, editable: true, hint: HINTS.repeatClients },
  { key: "receivables", label: "Дебіторка (знімок)", unit: "money", group: "👥 Угоди та клієнти", get: (b) => b.ov.receivablesTotal, planKind: null, flow: false, hint: HINTS.receivables },
  // 🎯 Реклама
  { key: "adBudget", label: "Рекламний бюджет", unit: "money", group: "🎯 Реклама", get: (b) => b.lq.adBudgetFact, planKind: "ad_budget", flow: true, hint: HINTS.adBudget },
  { key: "adGaLeads", label: "Заявки з реклами (GA)", unit: "num", group: "🎯 Реклама", get: (b) => b.lq.adBudgetLeads, planKind: null, flow: true, hint: HINTS.adGaLeads },
  { key: "adLeads", label: "Ліди з реклами (CRM)", unit: "num", group: "🎯 Реклама", get: (b) => b.ov.adConversion.leads, planKind: "ad_leads", flow: true, editable: true, hint: HINTS.adLeads },
  { key: "adPaid", label: "Оплачено з реклами", unit: "num", group: "🎯 Реклама", get: (b) => b.ov.adConversion.paid, planKind: null, flow: true, hint: HINTS.adPaid },
  { key: "adConv", label: "Конверсія реклами", unit: "pct", group: "🎯 Реклама", get: (b) => b.ov.adConversion.conversion, planKind: "ad_conversion", flow: false, editable: true, hint: HINTS.adConv },
  { key: "target", label: "Цільові ліди", unit: "num", group: "🎯 Реклама", get: (b) => b.lq.targetLeads, planKind: "target_leads", flow: true, editable: true, hint: HINTS.target },
  { key: "nonTarget", label: "Не цільові (Кваліф. 143)", unit: "num", group: "🎯 Реклама", get: (b) => b.lq.nonTargetLeads, planKind: null, flow: true, hint: HINTS.nonTarget },
  // 📞 Лідогенератори
  { key: "transferred", label: "Передані заявки", unit: "num", group: "📞 Лідогенератори", get: (b) => b.ov.transferred.total, planKind: "transferred", flow: true, editable: true, hint: HINTS.transferred },
  { key: "transferSuccess", label: "Успішно з переданих", unit: "num", group: "📞 Лідогенератори", get: (b) => b.ov.transferred.success, planKind: "transfer_success", flow: true, editable: true, hint: HINTS.transferSuccess },
  { key: "leadgenConv", label: "Конверсія лідогену", unit: "pct", group: "📞 Лідогенератори", get: (b) => b.ov.leadgenConversion.conversion, planKind: "leadgen_conversion", flow: false, editable: true, hint: HINTS.leadgenConv },
];

/** Робочі дні місяця (для темпу). elapsed<total лише для поточного місяця (MTD). */
type Pj = ExecutiveOverview["projection"];
function paceRatio(pj: Pj): number | null {
  const el = pj?.elapsedWorkingDays ?? 0, tot = pj?.totalWorkingDays ?? 0;
  if (el > 0 && tot > 0 && el < tot) return el / tot;
  return null; // період завершено (минулий місяць) → без проекції
}

/** План на сьогодні / викон.% / відставання / прогноз для рядка. */
function computePace(fact: number, plan: number | null, flow: boolean, ratio: number | null) {
  if (plan == null || plan <= 0) return { plan, planToday: null as number | null, pct: null as number | null, gap: null as number | null, forecast: null as number | null };
  // Знімкові (не потокові) метрики: план на сьогодні = сам план (без проекції).
  const planToday = flow && ratio != null ? Math.round(plan * ratio) : plan;
  const pct = planToday > 0 ? Math.round((fact / planToday) * 100) : null;
  const gap = fact - planToday;
  const forecast = flow && ratio != null ? Math.round(fact / ratio) : fact;
  return { plan, planToday, pct, gap, forecast };
}

function Delta({ prev, cur }: { prev: number; cur: number }) {
  const diff = cur - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : cur > 0 ? 100 : 0;
  const color = diff > 0 ? GREEN : diff < 0 ? RED : MUTED;
  return <span style={{ color, fontWeight: 600, whiteSpace: "nowrap" }}>{diff > 0 ? "↑" : diff < 0 ? "↓" : "→"} {Math.abs(pct)}%</span>;
}

/** Мінімалістичний SVG-спарклайн (без залежностей). */
function Spark({ values, w = 84, h = 24 }: { values: number[]; w?: number; h?: number }) {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={up ? GREEN : RED} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
    </svg>
  );
}

// ── HERO KPI-стрічка ──────────────────────────────────────────────────
function HeroStrip({ b, plans, ratio }: { b: Block; plans: KvpPlans; ratio: number | null }) {
  const o = b.ov;
  const hist = o.monthlyHistory ?? [];
  const revPlan = o.planMonthTotal || o.plan || null;
  const tiles: { label: string; fact: number; unit: Unit; plan: number | null; flow: boolean; series: number[]; sub?: string }[] = [
    { label: "Отримані кошти", fact: o.fact, unit: "money", plan: revPlan, flow: true, series: hist.map((m) => m.revenue) },
    { label: "Відправлені авто", fact: dispatchedFact(o), unit: "num", plan: plans.dispatched_cars ?? null, flow: true, series: hist.map((m) => m.paid) },
    { label: "⏳ Очікувані оплати", fact: o.pendingPayments?.revenue ?? 0, unit: "money", plan: null, flow: false, series: [], sub: `${o.pendingPayments?.deals ?? 0} виставлених рахунків` },
    { label: "Конверсія реклами", fact: o.adConversion.conversion, unit: "pct", plan: plans.ad_conversion ?? null, flow: false, series: hist.map((m) => m.adConversion) },
    { label: "Середній чек", fact: avgCheck(o), unit: "moneyFull", plan: plans.avg_check ?? null, flow: false, series: hist.map((m) => m.avgCheck) },
  ];
  return (
    <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", marginBottom: 16 }}>
      {tiles.map((t) => {
        const p = computePace(t.fact, t.plan, t.flow, ratio);
        return (
          <div key={t.label} className="kpi-card" style={{ borderTop: `3px solid ${p.pct == null ? "var(--border)" : pctColor(p.pct)}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="kpi-label">{t.label}</span>
              <Spark values={t.series} />
            </div>
            <span className="kpi-value">{fmtVal(t.fact, t.unit)}</span>
            {t.plan != null ? (
              <>
                <div style={{ height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden", margin: "6px 0 4px" }}>
                  <div style={{ width: `${Math.min(100, p.pct ?? 0)}%`, height: "100%", background: pctColor(p.pct) }} />
                </div>
                <div style={{ fontSize: 11, color: MUTED, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <span>план {fmtVal(t.plan, t.unit)}</span>
                  {p.planToday != null && t.flow && <span>на сьогодні {fmtVal(p.planToday, t.unit)}</span>}
                  <span style={{ color: pctColor(p.pct), fontWeight: 700 }}>{p.pct}%</span>
                  {p.gap != null && <span style={{ color: p.gap >= 0 ? GREEN : RED, fontWeight: 600 }}>{p.gap >= 0 ? "+" : ""}{fmtVal(p.gap, t.unit)}</span>}
                  {p.forecast != null && t.flow && ratio != null && <span>прогноз {fmtVal(p.forecast, t.unit)}</span>}
                </div>
              </>
            ) : (
              <span style={{ fontSize: 11, color: MUTED }}>{t.sub ?? "ціль не задана — постав у матриці ✏️"}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Смуга сигналів ────────────────────────────────────────────────────
function AlertsBar({ o, planToday }: { o: ExecutiveOverview; planToday: number | null }) {
  const chips: { text: string; color: string }[] = [];
  if (o.receivablesTotal > 0) chips.push({ text: `💰 Дебіторка ${formatAmount(o.receivablesTotal)}`, color: RED });
  if ((o.pendingPayments?.revenue ?? 0) > 0) chips.push({ text: `⏳ Очікувані оплати ${formatAmount(o.pendingPayments.revenue)}`, color: AMBER });
  if (planToday != null && o.fact < planToday) chips.push({ text: `📉 План позаду на ${formatAmount(planToday - o.fact)}`, color: RED });
  else if (planToday != null && o.fact >= planToday) chips.push({ text: `✅ Темп у нормі`, color: GREEN });
  if ((o.carryover?.amount ?? 0) > 0) chips.push({ text: `↪️ Перенесено ${formatAmount(o.carryover?.amount ?? 0)}`, color: MUTED });
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
      {chips.map((c, i) => (
        <span key={i} style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 999, color: "#fff", background: c.color }}>{c.text}</span>
      ))}
    </div>
  );
}

// ── Редагована комірка плану ──────────────────────────────────────────
function TargetCell({ value, unit, onSave }: { value: number | null; unit: Unit; onSave: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  if (editing) {
    return (
      <input autoFocus defaultValue={value ?? ""} onChange={(e) => setRaw(e.target.value)}
        onBlur={() => { setEditing(false); const v = raw.trim() === "" ? null : Number(raw.replace(/\s/g, "").replace(",", ".")); if (raw !== "" || value != null) onSave(v != null && Number.isFinite(v) ? v : null); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
        style={{ width: 90, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", textAlign: "right", fontSize: 13 }} />
    );
  }
  return (
    <span onClick={() => { setRaw(String(value ?? "")); setEditing(true); }} title="Клік — задати ціль"
      style={{ cursor: "pointer", color: value != null ? "var(--text)" : MUTED, borderBottom: "1px dashed var(--border)" }}>
      {value != null ? fmtVal(value, unit) : "✏️ ціль"}
    </span>
  );
}

// ── Матриця План/Факт ─────────────────────────────────────────────────
function PlanFactMatrix({ prev, cur, prevRange, curRange, isMonth, plans, ratio, onSave }: {
  prev: Block; cur: Block; prevRange: Range; curRange: Range; isMonth: boolean;
  plans: KvpPlans; ratio: number | null; onSave: (metric: string, v: number | null) => void;
}) {
  const planOf = (m: Metric): number | null => {
    if (m.planKind === "revenue") return isMonth ? (cur.ov.planMonthTotal || null) : (cur.ov.plan || null);
    if (m.planKind === "ad_budget") return cur.lq.adBudgetPlan || null;
    if (m.planKind) return plans[m.planKind] ?? null;
    return null;
  };
  const groups = [...new Set(METRICS.map((m) => m.group))];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Показник</th>
            <th style={{ textAlign: "right", color: MUTED }}>{dmy(prevRange.from)}–{dmy(prevRange.to)}</th>
            <th style={{ textAlign: "right" }}>{dmy(curRange.from)}–{dmy(curRange.to)}</th>
            <th style={{ textAlign: "right" }}>Динаміка*<InfoHint text="(поточний − попередній) ÷ попередній × 100%, до аналогічного періоду минулого місяця." /></th>
            <th style={{ textAlign: "right" }}>План<InfoHint text="Гроші — з планів менеджерів (сума). Реклбюджет — з таблиці. Решта — цілі КВП (клік по клітинці, щоб задати)." /></th>
            <th style={{ textAlign: "right" }}>На сьогодні<InfoHint text="План × (робочі дні минуло ÷ усього) — лише для потокових метрик і поточного місяця." /></th>
            <th style={{ textAlign: "right" }}>Викон.<InfoHint text="Факт ÷ план-на-сьогодні × 100%. Зелений ≥100, жовтий ≥70, червоний <70." /></th>
            <th style={{ textAlign: "right" }}>Δ до плану</th>
            <th style={{ textAlign: "right" }}>Прогноз<InfoHint text="За темпом: факт ÷ частку минулих робочих днів (лінійна екстраполяція)." /></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g}>
              <tr><td colSpan={9} style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>{g}</td></tr>
              {METRICS.filter((m) => m.group === g).map((m) => {
                const pv = m.get(prev), cv = m.get(cur);
                const plan = planOf(m);
                const p = computePace(cv, plan, m.flow, ratio);
                return (
                  <tr key={m.key}>
                    <td style={{ textAlign: "left" }}>{m.label}{m.hint && <InfoHint text={m.hint} />}</td>
                    <td style={{ textAlign: "right", color: MUTED }}>{fmtVal(pv, m.unit)}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtVal(cv, m.unit)}</td>
                    <td style={{ textAlign: "right" }}><Delta prev={pv} cur={cv} /></td>
                    <td style={{ textAlign: "right" }}>
                      {m.editable && isMonth
                        ? <TargetCell value={plan} unit={m.unit} onSave={(v) => onSave(m.planKind as string, v)} />
                        : <span style={{ color: MUTED }}>{plan != null ? fmtVal(plan, m.unit) : "—"}</span>}
                    </td>
                    <td style={{ textAlign: "right", color: MUTED }}>{p.planToday != null && m.flow ? fmtVal(p.planToday, m.unit) : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: pctColor(p.pct) }}>{p.pct != null ? `${p.pct}%` : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 600, color: p.gap == null ? MUTED : p.gap >= 0 ? GREEN : RED }}>{p.gap != null ? `${p.gap >= 0 ? "+" : ""}${fmtVal(p.gap, m.unit)}` : "—"}</td>
                    <td style={{ textAlign: "right", color: MUTED }}>{p.forecast != null && m.flow && ratio != null ? fmtVal(p.forecast, m.unit) : "—"}</td>
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

// ── Якість виручки ────────────────────────────────────────────────────
function RevenueQuality({ o }: { o: ExecutiveOverview }) {
  const total = o.fact || 1;
  const segs = [
    { label: "Нові клієнти", rev: o.newRevenue, n: o.newClients, color: "#1971c2" },
    { label: "Постійні клієнти", rev: o.repeatRevenue, n: o.repeatClients, color: "#2f9e44" },
  ];
  const src = o.newClientsBySource ?? { ad: 0, leadgen: 0, other: 0 };
  return (
    <div>
      <div style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
        {segs.map((s) => (
          <div key={s.label} title={`${s.label}: ${formatAmount(s.rev)}`} style={{ width: `${Math.max(2, (s.rev / total) * 100)}%`, background: s.color }} />
        ))}
        <div style={{ flex: 1, background: "var(--border)" }} title="Інше" />
      </div>
      <table className="data-table compact" style={{ minWidth: 420 }}>
        <thead><tr><th style={{ textAlign: "left" }}>Сегмент</th><th style={{ textAlign: "right" }}>Виручка</th><th style={{ textAlign: "right" }}>Частка</th><th style={{ textAlign: "right" }}>Клієнтів</th></tr></thead>
        <tbody>
          {segs.map((s) => (
            <tr key={s.label}><td style={{ textAlign: "left" }}><span style={{ color: s.color, fontWeight: 700 }}>■</span> {s.label}</td>
              <td style={{ textAlign: "right", fontWeight: 600 }}>{formatAmount(s.rev)}</td>
              <td style={{ textAlign: "right" }}>{Math.round((s.rev / total) * 100)}%</td>
              <td style={{ textAlign: "right" }}>{s.n.toLocaleString("uk-UA")}</td></tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: MUTED, margin: "8px 0 0" }}>
        Нові по джерелах: 🎯 реклама {src.ad} · 📞 лідоген {src.leadgen} · ✍️ інше {src.other}.
      </p>
    </div>
  );
}

// ── Реклама — ефективність ────────────────────────────────────────────
function AdEfficiency({ b }: { b: Block }) {
  const { ov, lq } = b;
  const cpl = lq.adBudgetLeads > 0 ? Math.round(lq.adBudgetFact / lq.adBudgetLeads) : null;
  const cplCrm = ov.adConversion.leads > 0 ? Math.round(lq.adBudgetFact / ov.adConversion.leads) : null;
  const cpa = ov.adConversion.paid > 0 ? Math.round(lq.adBudgetFact / ov.adConversion.paid) : null;
  const romi = lq.adBudgetFact > 0 ? Math.round((ov.newRevenue / lq.adBudgetFact) * 100) : null;
  const funnel = [
    { label: "Бюджет (факт)", val: formatAmount(lq.adBudgetFact) },
    { label: "GA-заявки", val: lq.adBudgetLeads.toLocaleString("uk-UA") },
    { label: "CRM-ліди", val: ov.adConversion.leads.toLocaleString("uk-UA") },
    { label: "Оплачено", val: ov.adConversion.paid.toLocaleString("uk-UA") },
    { label: "Конверсія", val: `${ov.adConversion.conversion}%` },
  ];
  const kpis = [
    { label: "CPL (GA)", val: cpl != null ? formatAmount(cpl) : "—", hint: "Вартість заявки: бюджет ÷ GA-заявки." },
    { label: "CPL (CRM)", val: cplCrm != null ? formatAmount(cplCrm) : "—", hint: "Бюджет ÷ CRM-ліди." },
    { label: "CPA (угода)", val: cpa != null ? formatAmount(cpa) : "—", hint: "Вартість оплаченої угоди: бюджет ÷ оплачено." },
    { label: "ROMI (нові)", val: romi != null ? `${romi}%` : "—", hint: "Виручка від нових ÷ рекл. бюджет × 100%." },
  ];
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {funnel.map((f, i) => (
          <Fragment key={f.label}>
            <div style={{ flex: "1 1 90px", textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg-subtle, rgba(127,127,127,0.08))" }}>
              <div style={{ fontSize: 11, color: MUTED }}>{f.label}</div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{f.val}</div>
            </div>
            {i < funnel.length - 1 && <div style={{ alignSelf: "center", color: MUTED }}>→</div>}
          </Fragment>
        ))}
      </div>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
        {kpis.map((k) => (
          <div key={k.label} className="kpi-card"><span className="kpi-label">{k.label}<InfoHint text={k.hint} /></span><span className="kpi-value">{k.val}</span></div>
        ))}
      </div>
    </div>
  );
}

// ── Лідерборд команд ──────────────────────────────────────────────────
function TeamLeaderboard({ prev, cur }: { prev: ExecutiveOverview; cur: ExecutiveOverview }) {
  const prevByTeam = new Map(prev.byTeam.map((t) => [t.teamId, t]));
  const rows = [...cur.byTeam].sort((a, b) => b.revenue - a.revenue);
  if (rows.length === 0) return null;
  const maxRev = Math.max(...rows.map((t) => t.revenue), 1);
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 620 }}>
        <thead><tr>
          <th style={{ textAlign: "left" }}>#</th><th style={{ textAlign: "left" }}>Команда</th>
          <th style={{ textAlign: "right" }}>Виручка</th><th style={{ textAlign: "right" }}>Угод</th>
          <th style={{ textAlign: "right" }}>Сер. чек</th><th style={{ textAlign: "right" }}>Мин. міс.</th>
          <th style={{ textAlign: "right" }}>Динаміка*</th>
        </tr></thead>
        <tbody>
          {rows.map((t, i) => {
            const pv = prevByTeam.get(t.teamId);
            const avg = t.deals > 0 ? Math.round(t.revenue / t.deals) : 0;
            return (
              <tr key={t.teamId}>
                <td style={{ textAlign: "left", fontWeight: 700, color: i === 0 ? "#c5141c" : MUTED }}>{i + 1}</td>
                <td style={{ textAlign: "left" }}>
                  {t.teamName}
                  <div style={{ height: 4, marginTop: 3, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${(t.revenue / maxRev) * 100}%`, height: "100%", background: "linear-gradient(90deg,#e11d2a,#8f0f1c)" }} />
                  </div>
                </td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{formatAmount(t.revenue)}</td>
                <td style={{ textAlign: "right" }}>{t.deals}</td>
                <td style={{ textAlign: "right" }}>{formatAmount(avg)}</td>
                <td style={{ textAlign: "right", color: MUTED }}>{formatAmount(pv?.revenue ?? 0)}</td>
                <td style={{ textAlign: "right" }}><Delta prev={pv?.revenue ?? 0} cur={t.revenue} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Декомпозиція плану (stored цілі, з фолбеком) ──────────────────────
function Decomposition({ b, plans, periodPlan }: { b: Block; plans: KvpPlans; periodPlan?: boolean }) {
  const o = b.ov;
  const plan = periodPlan ? o.plan : (o.planMonthTotal || o.plan);
  const avg = avgCheck(o);
  const carsDone = dispatchedFact(o);
  const carsNeeded = plans.dispatched_cars ?? (avg > 0 ? Math.ceil(plan / avg) : 0);
  const carsLeft = Math.max(0, carsNeeded - carsDone);
  const conv = o.adConversion.conversion;
  const leadsDone = o.adConversion.leads;
  const leadsNeeded = plans.ad_leads ?? (conv > 0 ? Math.ceil(carsNeeded / (conv / 100)) : 0);
  const leadsLeft = Math.max(0, leadsNeeded - leadsDone);
  const carry = o.carryover?.amount ?? 0;
  const revDone = o.fact + carry;
  const revLeft = Math.max(0, plan - revDone);
  const pj = o.projection;
  const daysLeft = Math.max(0, (pj?.totalWorkingDays ?? 0) - (pj?.elapsedWorkingDays ?? 0));
  const perDay = (left: number) => (daysLeft > 0 ? Math.ceil(left / daysLeft) : null);
  const planToday = o.plan;
  const tempo = planToday > 0 ? Math.round((o.fact / planToday) * 100) : null;
  const num = (v: number) => v.toLocaleString("uk-UA");
  const rows = [
    { label: "Дохід (грн)", need: formatAmount(plan), done: formatAmount(revDone), left: formatAmount(revLeft), day: perDay(revLeft) != null ? formatAmount(perDay(revLeft)!) : "—" },
    { label: "Авто (угод)", need: carsNeeded ? num(carsNeeded) : "—", done: num(carsDone), left: num(carsLeft), day: carsNeeded && perDay(carsLeft) != null ? num(perDay(carsLeft)!) : "—" },
    { label: "Ліди (реклама)", need: leadsNeeded ? num(leadsNeeded) : "—", done: num(leadsDone), left: num(leadsLeft), day: leadsNeeded && perDay(leadsLeft) != null ? num(perDay(leadsLeft)!) : "—" },
  ];
  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ fontSize: 11, color: MUTED, margin: "0 0 8px" }}>
        Ср. чек {formatAmountFull(avg)} · конверсія реклами {conv}%. Треба авто/лідів — зі збережених цілей КВП (якщо задані), інакше розрахунок із плану виручки. «На день» = лишилось ÷ {daysLeft} роб. днів.
      </p>
      {!periodPlan && pj && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 10 }}>
          <div className="kpi-card"><span className="kpi-label">План на сьогодні</span><span className="kpi-value">{formatAmount(planToday)}</span></div>
          <div className="kpi-card"><span className="kpi-label">Темп</span><span className="kpi-value" style={{ color: pctColor(tempo) }}>{tempo != null ? `${tempo}%` : "—"}</span></div>
          <div className="kpi-card"><span className="kpi-label">Прогноз місяця</span><span className="kpi-value">{formatAmount(pj.projected)}{pj.projectedPct != null && <span style={{ fontSize: 12, color: pj.projectedPct >= 100 ? GREEN : RED, fontWeight: 600 }}> · {pj.projectedPct}%</span>}</span></div>
          <div className="kpi-card"><span className="kpi-label">Роб. днів минуло</span><span className="kpi-value">{pj.elapsedWorkingDays}/{pj.totalWorkingDays}</span></div>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table className="data-table compact" style={{ minWidth: 500 }}>
          <thead><tr><th style={{ textAlign: "left" }}>Метрика</th><th style={{ textAlign: "right" }}>Треба (план)</th><th style={{ textAlign: "right" }}>Вже</th><th style={{ textAlign: "right" }}>Лишилось</th><th style={{ textAlign: "right" }}>На день</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}><td style={{ textAlign: "left" }}>{r.label}</td>
                <td style={{ textAlign: "right", color: MUTED }}>{r.need}</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{r.done}</td>
                <td style={{ textAlign: "right", fontWeight: 700, color: AMBER }}>{r.left}</td>
                <td style={{ textAlign: "right", fontWeight: 700, color: "#c5141c" }}>{r.day}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Тижнева динаміка (факт-грід) ──────────────────────────────────────
function WeeklyBreakdown({ weeks, blocks }: { weeks: Range[]; blocks: Block[] }) {
  const summable = METRICS.filter((m) => m.flow && m.planKind !== null && m.unit !== "pct");
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 640 }}>
        <thead><tr><th style={{ textAlign: "left" }}>Показник</th>
          {weeks.map((w, i) => (<th key={i} style={{ textAlign: "right" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: MUTED }}>{dmy(w.from)}–{dmy(w.to)}</div></th>))}
          <th style={{ textAlign: "right" }}>Разом</th></tr></thead>
        <tbody>
          {summable.map((m) => {
            const vals = blocks.map((b) => m.get(b));
            const total = vals.reduce((s, v) => s + v, 0);
            return (<tr key={m.key}><td style={{ textAlign: "left" }}>{m.label}</td>
              {vals.map((v, i) => (<td key={i} style={{ textAlign: "right" }}>{fmtVal(v, m.unit)}</td>))}
              <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtVal(total, m.unit)}</td></tr>);
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Звіт КВП — cockpit керівника відділу продажу. Admin/КВП only. */
export function KvpReportSection() {
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("kvpMonth") || curMonthStr());
  const [range, setRange] = useState<{ from: string; to: string }>(() => {
    try { const v = JSON.parse(localStorage.getItem("kvpRange") || "null"); return v && v.from && v.to ? v : { from: "", to: "" }; } catch { return { from: "", to: "" }; }
  });
  const rangeMode = !!(range.from && range.to);
  const rangePrev = rangeMode ? previousRange(range.from, range.to) : null;

  const [plans, setPlans] = useState<KvpPlans>({});

  const setup = useMemo(() => {
    const [selY, selM] = monthSel.split("-").map(Number);
    const y = selY, m0 = selM - 1;
    const now = new Date();
    const isCurrentMonth = y === now.getFullYear() && m0 === now.getMonth();
    const today = ymd(now);
    const monthPrev = fullMonthRange(m0 === 0 ? y - 1 : y, m0 === 0 ? 11 : m0 - 1);
    const full = fullMonthRange(y, m0);
    const monthCur: Range = isCurrentMonth ? { ...full, to: today } : full;
    const selWeeks = weekBlocksFor(y, m0);
    let curWeek: Range | null = null, analogWeek: Range | null = null;
    if (isCurrentMonth) {
      const idx = Math.min(blockIndexOf(now.getDate()), selWeeks.length - 1);
      const wf = selWeeks[idx];
      curWeek = { ...wf, to: today < wf.to ? today : wf.to };
      const prevWeeks = weekBlocksFor(m0 === 0 ? y - 1 : y, m0 === 0 ? 11 : m0 - 1);
      analogWeek = prevWeeks[Math.min(idx, prevWeeks.length - 1)];
    }
    return { monthPrev, monthCur, selWeeks, curWeek, analogWeek, isCurrentMonth, monthLabel: `${MONTH_NAMES[m0]} ${y}` };
  }, [monthSel]);

  const [data, setData] = useState<{ monthPrev: Block; monthCur: Block; selWeeks: Block[]; curWeek: Block | null; analogWeek: Block | null } | null>(null);
  const [rangeData, setRangeData] = useState<{ cur: Block; prev: Block } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadBlock = async (r: Range): Promise<Block> => {
    const [ov, lq] = await Promise.all([fetchOverview(r), fetchLeadQuality(r)]);
    return { ov, lq };
  };

  // Плани — раз на обраний місяць (не на кожен під-період).
  useEffect(() => {
    let alive = true;
    fetchKvpPlan(monthSel).then((p) => { if (alive) setPlans(p); }).catch(() => { if (alive) setPlans({}); });
    return () => { alive = false; };
  }, [monthSel]);

  const onSavePlan = (metric: string, v: number | null) => {
    setPlans((prev) => { const next = { ...prev }; if (v == null) delete next[metric]; else next[metric] = v; return next; });
    saveKvpPlan(monthSel, { [metric]: v }).catch(() => {});
  };

  useEffect(() => {
    if (!rangeMode || !rangePrev) return;
    let alive = true; setRangeData(null); setErr(null);
    (async () => {
      try { const [cur, prev] = await Promise.all([loadBlock(range), loadBlock(rangePrev)]); if (alive) setRangeData({ cur, prev }); }
      catch { if (alive) setErr("Не вдалося завантажити звіт."); }
    })();
    return () => { alive = false; };
  }, [rangeMode, range.from, range.to]);

  useEffect(() => {
    if (rangeMode) return;
    let alive = true; setData(null); setErr(null);
    (async () => {
      try {
        const extra = setup.curWeek && setup.analogWeek ? [setup.curWeek, setup.analogWeek] : [];
        const results = await Promise.all([loadBlock(setup.monthPrev), loadBlock(setup.monthCur), ...setup.selWeeks.map(loadBlock), ...extra.map(loadBlock)]);
        if (!alive) return;
        const selWeeks = results.slice(2, 2 + setup.selWeeks.length);
        const curWeek = extra.length ? results[2 + setup.selWeeks.length] : null;
        const analogWeek = extra.length ? results[2 + setup.selWeeks.length + 1] : null;
        setData({ monthPrev: results[0], monthCur: results[1], selWeeks, curWeek, analogWeek });
      } catch { if (alive) setErr("Не вдалося завантажити звіт."); }
    })();
    return () => { alive = false; };
  }, [setup, rangeMode]);

  const setRangeP = (r: { from: string; to: string }) => { setRange(r); localStorage.setItem("kvpRange", JSON.stringify(r)); };
  const shiftMonth = (delta: number) => {
    const [y, m] = monthSel.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (next > curMonthStr()) return;
    setMonthSel(next); localStorage.setItem("kvpMonth", next);
  };
  const pickMonth = (v: string) => { if (!v || v > curMonthStr()) return; setMonthSel(v); localStorage.setItem("kvpMonth", v); };

  // Активний блок для hero/alerts/decomp/quality/ad/teams.
  const active = rangeMode ? rangeData?.cur : data?.monthCur;
  const activePrev = rangeMode ? rangeData?.prev : data?.monthPrev;
  // Темп/проекція — лише в місячному режимі (місячна проекція не підходить довільному діапазону).
  const ratio = (!rangeMode && active) ? paceRatio(active.ov.projection) : null;
  const heroPlanToday = active ? Math.round((active.ov.planMonthTotal || active.ov.plan || 0) * (ratio ?? 1)) : null;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 Звіт КВП</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => shiftMonth(-1)} title="Попередній місяць" style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>←</button>
          <DatePicker mode="month" value={monthSel} onChange={(v) => v && pickMonth(v)} minWidth={150} />
          <button onClick={() => shiftMonth(1)} disabled={monthSel >= curMonthStr()} title="Наступний місяць" style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: monthSel >= curMonthStr() ? "default" : "pointer", opacity: monthSel >= curMonthStr() ? 0.5 : 1 }}>→</button>
          <span style={{ color: MUTED, margin: "0 2px" }}>або період:</span>
          <DatePicker value={range.from} onChange={(v) => setRangeP({ ...range, from: v })} placeholder="від" minWidth={130} />
          <span style={{ color: MUTED }}>—</span>
          <DatePicker value={range.to} onChange={(v) => setRangeP({ ...range, to: v })} placeholder="до" minWidth={130} />
          {(range.from || range.to) && (
            <button onClick={() => setRangeP({ from: "", to: "" })} title="Очистити період" style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>✕</button>
          )}
        </div>
      </div>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 16px", maxWidth: 860 }}>
        Кокпіт керівника відділу продажу — усе з CRM та Google-таблиць. <b>Динаміка (*)</b> — до аналогічного періоду минулого місяця. <b>План</b> для грошей — із планів менеджерів; решту цілей задавайте прямо в матриці (клік по клітинці «✏️ ціль»).
      </p>

      {err && <p className="loading-text" style={{ color: RED }}>{err}</p>}
      {!active && !err && <p className="loading-text">Завантаження…</p>}

      {active && activePrev && (
        <>
          <HeroStrip b={active} plans={plans} ratio={ratio} />
          <AlertsBar o={active.ov} planToday={heroPlanToday} />

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">📊 План / Факт — {rangeMode ? `${dmy(range.from)}–${dmy(range.to)}` : setup.monthLabel} {rangeMode ? `(vs ${dmy(rangePrev!.from)}–${dmy(rangePrev!.to)})` : "(vs минулий місяць)"}</h2>
            <PlanFactMatrix
              prev={activePrev} cur={active}
              prevRange={rangeMode ? rangePrev! : setup.monthPrev}
              curRange={rangeMode ? range : setup.monthCur}
              isMonth={!rangeMode} plans={plans} ratio={ratio} onSave={onSavePlan}
            />
          </div>

          <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, marginBottom: 16 }}>
            <div className="chart-card"><h2 className="chart-title">💎 Якість виручки</h2><RevenueQuality o={active.ov} /></div>
            <div className="chart-card"><h2 className="chart-title">🎯 Реклама — ефективність</h2><AdEfficiency b={active} /></div>
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🏅 Команди — лідерборд</h2>
            <TeamLeaderboard prev={activePrev.ov} cur={active.ov} />
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🎯 Декомпозиція плану ({rangeMode ? "період" : "місяць"}, по відділу)</h2>
            <Decomposition b={active} plans={plans} periodPlan={rangeMode} />
          </div>

          {!rangeMode && data && data.curWeek && data.analogWeek && setup.curWeek && setup.analogWeek && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">🗓️ Поточний тиждень (vs той самий тиждень минулого місяця)</h2>
              <PlanFactMatrix prev={data.analogWeek} cur={data.curWeek} prevRange={setup.analogWeek} curRange={setup.curWeek} isMonth={false} plans={plans} ratio={null} onSave={onSavePlan} />
            </div>
          )}

          {!rangeMode && data && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">📆 {setup.monthLabel} по тижнях</h2>
              <p style={{ fontSize: 12, color: MUTED, margin: "0 0 10px" }}>Тижні = фіксовані 7-денні блоки від 1-го (1–7, 8–14, 15–21, 22–28, 29–кінець).</p>
              <WeeklyBreakdown weeks={setup.selWeeks} blocks={data.selWeeks} />
            </div>
          )}
        </>
      )}
    </>
  );
}
