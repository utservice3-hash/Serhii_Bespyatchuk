import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchOverview, fetchLeadQuality, fetchKvpPlan, saveKvpPlan, fetchKvpExtra,
  type ExecutiveOverview, type LeadQuality, type KvpPlans, type KvpExtra,
} from "../../../api";
import { formatAmount, formatAmountFull, previousRange } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";
import { LeadgenRegularsCard } from "./LeadgenRegularsCard";

/** Пояснення джерела даних кожного показника (звідки береться з CRM). */
const HINTS: Record<string, string> = {
  received: "«Успішно реалізовано» (142, за датою закриття в періоді) + «Оплата отримана» (69716460/60412544, знімок).",
  success: "Угоди в статусі «Успішна угода» (142), за датою закриття в періоді.",
  payment: "Угоди, що ЗАРАЗ на етапі «Оплата отримана» (знімок).",
  pending: "Очікувані кошти = сума виставлених рахунків (етап «Виставлено рахунок»), знімок. Мінусові угоди (напр. Київтеплоенерго у Шевчука) віднімаються автоматично.",
  avg: "Отримані кошти ÷ кількість угод.",
  repeatRev: "Отримані кошти від постійних клієнтів (2+ оплати lifetime).",
  newRev: "Отримані кошти від нових клієнтів (перша оплата в періоді).",
  carryover: "Знімок угод, ще в роботі на 1-ше число (рахунок→оплата, крім «Успішна»).",
  created: "Створені угоди повного циклу (8921932 + 155304) за датою створення.",
  dispatchedSum: "Сума бюджетів угод, що ВПЕРШЕ увійшли в «Авто працює» у періоді (за подіями CRM).",
  dispatchedCars: "Кількість угод, що ВПЕРШЕ увійшли в «Авто працює» у періоді (за подіями CRM).",
  successDeals: "Кількість «Успішних угод» (142), закритих у періоді.",
  paidDeals: "Кількість угод ЗАРАЗ на етапі «Оплата отримана» (знімок).",
  managers: "Активні менеджери продажу (з командою, без лідоген-команд), із CRM.",
  avgPerMgr: "Отримані кошти ÷ кількість менеджерів у продажу.",
  newClients: "Клієнти, чия перша оплата за всю історію припала на період.",
  repeatClients: "Клієнти з 2+ оплатами lifetime, що замовляли в періоді.",
  receivables: "Неоплачена дебіторка (Google-таблиця, кожні 30 хв).",
  adBudget: "Витрати на рекламу з Google-таблиці (сума денних Cost).",
  adGaLeads: "Заявки з Google Ads (конверсії) з тієї ж таблиці.",
  adLeads: "Ліди з реклами (сайтові джерела) в CRM за період.",
  nonTarget: "Не цільові = Кваліфікація 8921928, статус 143 (відмова).",
  adRevenue: "Отримані кошти від рекламних клієнтів («Источник клиента» = сайтові джерела): успішно закриті в періоді + оплата (знімок).",
  adDispatched: "Угоди рекламних клієнтів, що ВПЕРШЕ увійшли в «Авто працює» у періоді.",
  adAvg: "Дохід з реклами ÷ оплачені рекламні угоди.",
  adPaid: "Скільки рекламних лідів дійшли до оплаченої угоди.",
  adConv: "Оплачено з реклами ÷ ліди з реклами × 100%.",
  target: "Цільові = пайплайн повного циклу 8921932, створені в періоді.",
  transferred: "Передані заявки з «Реєстру» лідоген-бота (вхід у «Нова заявка від лідогенератора»).",
  transferSuccess: "З переданих — скільки дійшли до успішної угоди.",
  lgRevenue: "Отримані кошти з лідоген-угод (канал = лідоген): успішно закриті в періоді + оплата (знімок).",
  lgDispatched: "Лідоген-угоди, що ВПЕРШЕ увійшли в «Авто працює» у періоді.",
  leadgenConv: "Передані, чий клієнт дійшов до оплаченої угоди ÷ усі передані × 100%.",
  teamPlan: "Місячний план виручки команди — проставляє КВП (клік по клітинці). Факт = отримані кошти команди.",
};

type Range = { from: string; to: string; label?: string };
type Unit = "money" | "moneyFull" | "num" | "pct";
type Block = { ov: ExecutiveOverview; lq: LeadQuality; ex: KvpExtra };

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
const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/** Робочі дні (Пн–Пт) у діапазоні включно. */
function wdCount(from: string, to: string): number {
  if (!from || !to || from > to) return 0;
  let n = 0;
  const d = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  while (d <= end) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
  return n;
}
function isect(aFrom: string, aTo: string, bFrom: string, bTo: string): [string, string] | null {
  const f = aFrom > bFrom ? aFrom : bFrom;
  const t = aTo < bTo ? aTo : bTo;
  return f <= t ? [f, t] : null;
}

const paidDealsFact = (o: ExecutiveOverview) => o.successDeals + o.paymentDeals;
const avgCheck = (o: ExecutiveOverview) => { const n = paidDealsFact(o); return n > 0 ? Math.round(o.fact / n) : 0; };

function fmtVal(v: number, unit: Unit) {
  if (unit === "money") return formatAmount(v);
  if (unit === "moneyFull") return formatAmountFull(v);
  if (unit === "pct") return `${v}%`;
  return v.toLocaleString("uk-UA");
}

const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", MUTED = "var(--text-muted)";
const pctColor = (p: number | null) => (p == null ? MUTED : p >= 100 ? GREEN : p >= 70 ? AMBER : RED);

/** Метрика звіту (рядок ручного файлу КВП). */
type PlanKind = "revenue" | "ad_budget" | string | null; // string = kvp_plans metric key
type Metric = {
  key: string; label: string; unit: Unit; group: string;
  get: (b: Block) => number;
  planKind: PlanKind;          // null → без плану (контекст)
  flow: boolean;               // true = сумується/має темп; false = знімок
  editable?: boolean;          // редагований stored-план
  weekly?: boolean;            // false → не показувати в тижневому блоці (знімки)
  hint?: string;
};

const METRICS: Metric[] = [
  // 💰 Дохід
  { key: "received", label: "Отримані кошти", unit: "money", group: "💰 Дохід", get: (b) => b.ov.fact, planKind: "revenue", flow: true, hint: HINTS.received },
  { key: "success", label: "Дохід успішно закритих угод", unit: "money", group: "💰 Дохід", get: (b) => b.ov.successRevenue, planKind: "success", flow: true, editable: true, hint: HINTS.success },
  { key: "payment", label: "Оплата отримана (знімок)", unit: "money", group: "💰 Дохід", get: (b) => b.ov.paymentRevenue, planKind: null, flow: false, weekly: false, hint: HINTS.payment },
  { key: "pending", label: "⏳ Очікувані оплати", unit: "money", group: "💰 Дохід", get: (b) => b.ov.pendingPayments?.revenue ?? 0, planKind: null, flow: false, weekly: false, hint: HINTS.pending },
  { key: "dispatchedSum", label: "Сума з поставлених машин", unit: "money", group: "💰 Дохід", get: (b) => b.ex.dispatched.revenue, planKind: "dispatched_sum", flow: true, editable: true, hint: HINTS.dispatchedSum },
  { key: "newRev", label: "Виручка від нових (РНК)", unit: "money", group: "💰 Дохід", get: (b) => b.ov.newRevenue, planKind: "new_revenue", flow: true, editable: true, hint: HINTS.newRev },
  { key: "repeatRev", label: "Виручка від постійних (РПК)", unit: "money", group: "💰 Дохід", get: (b) => b.ov.repeatRevenue, planKind: "repeat_revenue", flow: true, editable: true, hint: HINTS.repeatRev },
  { key: "carryover", label: "Перенесено з мин. міс.", unit: "money", group: "💰 Дохід", get: (b) => b.ov.carryover?.amount ?? 0, planKind: null, flow: false, weekly: false, hint: HINTS.carryover },
  { key: "avg", label: "Середній чек", unit: "moneyFull", group: "💰 Дохід", get: (b) => avgCheck(b.ov), planKind: "avg_check", flow: false, editable: true, hint: HINTS.avg },
  { key: "managers", label: "Менеджерів у продажу", unit: "num", group: "💰 Дохід", get: (b) => b.ex.managersCount, planKind: "managers_count", flow: false, editable: true, hint: HINTS.managers },
  { key: "avgPerMgr", label: "Середня сума на менеджера", unit: "money", group: "💰 Дохід", get: (b) => (b.ex.managersCount > 0 ? Math.round(b.ov.fact / b.ex.managersCount) : 0), planKind: "avg_per_manager", flow: false, editable: true, hint: HINTS.avgPerMgr },
  // 👥 Угоди та клієнти
  { key: "created", label: "Створені угоди (повний цикл)", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.createdFullCycle, planKind: "created_full_cycle", flow: true, editable: true, hint: HINTS.created },
  { key: "dispatchedCars", label: "Кількість поставлених машин", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ex.dispatched.count, planKind: "dispatched_cars", flow: true, editable: true, hint: HINTS.dispatchedCars },
  { key: "successDeals", label: "Кількість успішних угод", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.successDeals, planKind: "success_deals", flow: true, editable: true, hint: HINTS.successDeals },
  { key: "paidDeals", label: "Оплата отримана, шт (знімок)", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.paymentDeals, planKind: "paid_deals", flow: false, weekly: false, editable: true, hint: HINTS.paidDeals },
  { key: "newClients", label: "Нові клієнти", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.newClients, planKind: "new_clients", flow: true, editable: true, hint: HINTS.newClients },
  { key: "repeatClients", label: "Постійні клієнти", unit: "num", group: "👥 Угоди та клієнти", get: (b) => b.ov.repeatClients, planKind: "repeat_clients", flow: false, editable: true, hint: HINTS.repeatClients },
  { key: "receivables", label: "Дебіторка (знімок)", unit: "money", group: "👥 Угоди та клієнти", get: (b) => b.ov.receivablesTotal, planKind: null, flow: false, weekly: false, hint: HINTS.receivables },
  // 🎯 Реклама
  { key: "adBudget", label: "Рекламний бюджет", unit: "money", group: "🎯 Реклама", get: (b) => b.lq.adBudgetFact, planKind: "ad_budget", flow: true, hint: HINTS.adBudget },
  { key: "adGaLeads", label: "Заявки з реклами (GA)", unit: "num", group: "🎯 Реклама", get: (b) => b.lq.adBudgetLeads, planKind: null, flow: true, hint: HINTS.adGaLeads },
  { key: "adLeads", label: "К-ть лідів з реклами (CRM)", unit: "num", group: "🎯 Реклама", get: (b) => b.ov.adConversion.leads, planKind: "ad_leads", flow: true, editable: true, hint: HINTS.adLeads },
  { key: "nonTarget", label: "К-ть не цільових лідів", unit: "num", group: "🎯 Реклама", get: (b) => b.lq.nonTargetLeads, planKind: "nontarget_leads", flow: true, editable: true, hint: HINTS.nonTarget },
  { key: "adRevenue", label: "Дохід з реклами", unit: "money", group: "🎯 Реклама", get: (b) => b.ex.ad.revenue, planKind: "ad_revenue", flow: true, editable: true, hint: HINTS.adRevenue },
  { key: "adDispatched", label: "Поставлені машини з реклами", unit: "num", group: "🎯 Реклама", get: (b) => b.ex.ad.dispatched, planKind: "ad_dispatched", flow: true, editable: true, hint: HINTS.adDispatched },
  { key: "adPaid", label: "Оплачено з реклами", unit: "num", group: "🎯 Реклама", get: (b) => b.ov.adConversion.paid, planKind: null, flow: true, hint: HINTS.adPaid },
  { key: "adAvg", label: "Середній чек реклами", unit: "moneyFull", group: "🎯 Реклама", get: (b) => (b.ov.adConversion.paid > 0 ? Math.round(b.ex.ad.revenue / b.ov.adConversion.paid) : 0), planKind: "ad_avg_check", flow: false, editable: true, hint: HINTS.adAvg },
  { key: "adConv", label: "Конверсія реклами", unit: "pct", group: "🎯 Реклама", get: (b) => b.ov.adConversion.conversion, planKind: "ad_conversion", flow: false, editable: true, hint: HINTS.adConv },
  { key: "target", label: "Цільові ліди", unit: "num", group: "🎯 Реклама", get: (b) => b.lq.targetLeads, planKind: "target_leads", flow: true, editable: true, hint: HINTS.target },
  // 📞 Лідогенератори
  { key: "transferred", label: "Передані заявки", unit: "num", group: "📞 Лідогенератори", get: (b) => b.ov.transferred.total, planKind: "transferred", flow: true, editable: true, hint: HINTS.transferred },
  { key: "transferSuccess", label: "Успішно з переданих", unit: "num", group: "📞 Лідогенератори", get: (b) => b.ov.transferred.success, planKind: "transfer_success", flow: true, editable: true, hint: HINTS.transferSuccess },
  { key: "lgRevenue", label: "Дохід з лідогену", unit: "money", group: "📞 Лідогенератори", get: (b) => b.ex.leadgen.revenue, planKind: "leadgen_revenue", flow: true, editable: true, hint: HINTS.lgRevenue },
  { key: "lgDispatched", label: "Поставлені машини з лідогену", unit: "num", group: "📞 Лідогенератори", get: (b) => b.ex.leadgen.dispatched, planKind: "leadgen_dispatched", flow: true, editable: true, hint: HINTS.lgDispatched },
  { key: "leadgenConv", label: "Конверсія лідогену", unit: "pct", group: "📞 Лідогенератори", get: (b) => b.ov.leadgenConversion.conversion, planKind: "leadgen_conversion", flow: false, editable: true, hint: HINTS.leadgenConv },
];

/** Робочі дні місяця (для темпу). elapsed<total лише для поточного місяця (MTD). */
type Pj = ExecutiveOverview["projection"];
function paceRatio(pj: Pj): number | null {
  const el = pj?.elapsedWorkingDays ?? 0, tot = pj?.totalWorkingDays ?? 0;
  if (el > 0 && tot > 0 && el < tot) return el / tot;
  return null; // період завершено (минулий місяць) → без проекції
}

/** План на сьогодні / темп% / викон. плану міс% / залишок / відставання / прогноз. */
function computePace(fact: number, plan: number | null, flow: boolean, ratio: number | null) {
  if (plan == null || plan <= 0) return { plan, planToday: null as number | null, pct: null as number | null, pctMonth: null as number | null, left: null as number | null, lag: null as number | null, forecast: null as number | null };
  const planToday = flow && ratio != null ? Math.round(plan * ratio) : plan;
  const pct = planToday > 0 ? Math.round((fact / planToday) * 100) : null; // темп: факт ÷ план-на-сьогодні
  const pctMonth = Math.round((fact / plan) * 100);                        // виконання ПЛАНУ: факт ÷ повний план
  const left = Math.max(0, plan - fact);                                   // залишок до плану місяця
  const lag = Math.max(0, planToday - fact);                               // ВІДСТАВАННЯ від графіка на сьогодні
  const forecast = flow && ratio != null ? Math.round(fact / ratio) : fact;
  return { plan, planToday, pct, pctMonth, left, lag, forecast };
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
  const revPlan = o.planMonthTotal || plans.received_total || o.plan || null;
  const tiles: { label: string; fact: number; unit: Unit; plan: number | null; flow: boolean; series: number[]; sub?: string }[] = [
    { label: "Отримані кошти", fact: o.fact, unit: "money", plan: revPlan, flow: true, series: hist.map((m) => m.revenue) },
    { label: "Поставлені машини", fact: b.ex.dispatched.count, unit: "num", plan: plans.dispatched_cars ?? null, flow: true, series: hist.map((m) => m.paid) },
    { label: "⏳ Очікувані оплати", fact: o.pendingPayments?.revenue ?? 0, unit: "money", plan: null, flow: false, series: [], sub: `${o.pendingPayments?.deals ?? 0} виставлених рахунків` },
    { label: "Конверсія реклами", fact: o.adConversion.conversion, unit: "pct", plan: plans.ad_conversion ?? null, flow: false, series: hist.map((m) => m.adConversion) },
    { label: "Середній чек", fact: avgCheck(o), unit: "moneyFull", plan: plans.avg_check ?? null, flow: false, series: hist.map((m) => m.avgCheck) },
  ];
  return (
    <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", marginBottom: 16 }}>
      {tiles.map((t) => {
        const p = computePace(t.fact, t.plan, t.flow, ratio);
        return (
          <div key={t.label} className="kpi-card" style={{ borderTop: `3px solid ${p.pctMonth == null ? "var(--border)" : pctColor(p.pctMonth)}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="kpi-label">{t.label}</span>
              <Spark values={t.series} />
            </div>
            <span className="kpi-value">{fmtVal(t.fact, t.unit)}</span>
            {t.plan != null ? (
              <>
                <div style={{ height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden", margin: "6px 0 4px" }}>
                  <div style={{ width: `${Math.min(100, p.pctMonth ?? 0)}%`, height: "100%", background: pctColor(p.pctMonth) }} />
                </div>
                <div style={{ fontSize: 11, color: MUTED, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <span>план {fmtVal(t.plan, t.unit)}</span>
                  <span style={{ color: pctColor(p.pctMonth), fontWeight: 700 }}>{p.pctMonth}%</span>
                  {t.flow && ratio != null && p.lag != null && (
                    p.lag > 0
                      ? <span style={{ color: RED, fontWeight: 700 }}>відстає на {fmtVal(p.lag, t.unit)}</span>
                      : <span style={{ color: GREEN, fontWeight: 600 }}>✓ у графіку</span>
                  )}
                  {p.left != null && p.left > 0 && <span>до плану {fmtVal(p.left, t.unit)}</span>}
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
function TargetCell({ value, unit, onSave, muted }: { value: number | null; unit: Unit; onSave: (v: number | null) => void; muted?: boolean }) {
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
    <span onClick={() => { setRaw(String(value ?? "")); setEditing(true); }} title="Клік — задати план"
      style={{ cursor: "pointer", color: value != null ? (muted ? MUTED : "var(--text)") : MUTED, borderBottom: "1px dashed var(--border)" }}>
      {value != null ? fmtVal(value, unit) : "✏️ план"}
    </span>
  );
}

/** План метрики за місяць: гроші — з планів менеджерів (fallback ручний), реклбюджет — з таблиці, решта — kvp_plans. */
function monthPlanOfBlock(m: Metric, b: Block | null | undefined, pl: KvpPlans): number | null {
  if (!b) return null;
  if (m.planKind === "revenue") return b.ov.planMonthTotal || pl.received_total || null;
  if (m.planKind === "ad_budget") return b.lq.adBudgetPlan || null;
  if (m.planKind) return pl[m.planKind] ?? null;
  return null;
}

// ── Матриця План/Факт (структура ручного звіту КВП) ───────────────────
function PlanFactMatrix({ prev, cur, prevRange, curRange, isMonth, plans, plansPrev, ratio, onSave, onSavePrev }: {
  prev: Block; cur: Block; prevRange: Range; curRange: Range; isMonth: boolean;
  plans: KvpPlans; plansPrev: KvpPlans; ratio: number | null;
  onSave: (metric: string, v: number | null) => void;
  onSavePrev: (metric: string, v: number | null) => void;
}) {
  const groups = [...new Set(METRICS.map((m) => m.group))];
  const nCols = isMonth ? 10 : 4;
  // План редагований: явно editable, АБО received без планів менеджерів (fallback received_total).
  const canEdit = (m: Metric, which: "cur" | "prev") => {
    if (!isMonth) return false;
    if (m.editable) return true;
    if (m.planKind === "revenue") {
      const b = which === "cur" ? cur : prev;
      return !b.ov.planMonthTotal; // немає суми планів менеджерів → ручний план
    }
    return false;
  };
  const editKey = (m: Metric) => (m.planKind === "revenue" ? "received_total" : (m.planKind as string));
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: isMonth ? 1080 : 560 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Показник</th>
            <th style={{ textAlign: "right", color: MUTED }}>Факт<br />{dmy(prevRange.from)}–{dmy(prevRange.to)}</th>
            {isMonth && <th style={{ textAlign: "right", color: MUTED }}>План<br />мин. міс<InfoHint text="План минулого місяця — для порівняння. Редагується кліком." /></th>}
            <th style={{ textAlign: "right" }}>Факт<br />{dmy(curRange.from)}–{dmy(curRange.to)}</th>
            {isMonth && <th style={{ textAlign: "right" }}>План<br />поточ. міс<InfoHint text="Гроші — сума планів менеджерів (якщо є). Реклбюджет — з таблиці. Решта — плани КВП: клік по клітинці, щоб проставити вручну." /></th>}
            {isMonth && <th style={{ textAlign: "right" }}>Викон.<br />плану %<InfoHint text="Факт ÷ ПЛАН МІСЯЦЯ × 100%. Зелений ≥100, жовтий ≥70, червоний <70." /></th>}
            {isMonth && <th style={{ textAlign: "right" }}>Залишок<br />до плану<InfoHint text="План − факт: скільки ще треба зробити до кінця місяця." /></th>}
            <th style={{ textAlign: "right" }}>Динаміка*<InfoHint text="(поточний − попередній) ÷ попередній × 100%." /></th>
            {isMonth && <th style={{ textAlign: "right", color: MUTED }}>Темп · відставання<InfoHint text="Факт ÷ план-на-сьогодні (план × частка робочих днів, що минули). Якщо позаду графіка — червоним показано, СКІЛЬКИ саме бракує станом на сьогодні." /></th>}
            {isMonth && <th style={{ textAlign: "right", color: MUTED }}>Прогноз<InfoHint text="Лінійна екстраполяція за темпом: факт ÷ частку минулих робочих днів." /></th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g}>
              <tr><td colSpan={nCols} style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>{g}</td></tr>
              {METRICS.filter((m) => m.group === g).map((m) => {
                const pv = m.get(prev), cv = m.get(cur);
                const planCur = monthPlanOfBlock(m, cur, plans);
                const planPrev = monthPlanOfBlock(m, prev, plansPrev);
                const p = computePace(cv, planCur, m.flow, ratio);
                return (
                  <tr key={m.key}>
                    <td style={{ textAlign: "left" }}>{m.label}{m.hint && <InfoHint text={m.hint} />}</td>
                    <td style={{ textAlign: "right", color: MUTED }}>{fmtVal(pv, m.unit)}</td>
                    {isMonth && (
                      <td style={{ textAlign: "right" }}>
                        {canEdit(m, "prev")
                          ? <TargetCell value={planPrev} unit={m.unit} muted onSave={(v) => onSavePrev(editKey(m), v)} />
                          : <span style={{ color: MUTED }}>{planPrev != null ? fmtVal(planPrev, m.unit) : "—"}</span>}
                      </td>
                    )}
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtVal(cv, m.unit)}</td>
                    {isMonth && (
                      <td style={{ textAlign: "right" }}>
                        {canEdit(m, "cur")
                          ? <TargetCell value={planCur} unit={m.unit} onSave={(v) => onSave(editKey(m), v)} />
                          : <span style={{ color: MUTED }}>{planCur != null ? fmtVal(planCur, m.unit) : "—"}</span>}
                      </td>
                    )}
                    {isMonth && <td style={{ textAlign: "right", fontWeight: 700, color: pctColor(p.pctMonth) }}>{p.pctMonth != null ? `${p.pctMonth}%` : "—"}</td>}
                    {isMonth && (
                      <td style={{ textAlign: "right", fontWeight: 600 }}>
                        {p.left == null ? <span style={{ color: MUTED }}>—</span>
                          : p.left === 0 ? <span style={{ color: GREEN }}>✓ виконано</span>
                          : <span style={{ color: AMBER }}>{fmtVal(p.left, m.unit)}</span>}
                      </td>
                    )}
                    <td style={{ textAlign: "right" }}><Delta prev={pv} cur={cv} /></td>
                    {isMonth && (
                      <td style={{ textAlign: "right", fontSize: 12, whiteSpace: "nowrap" }}>
                        {p.pct != null && m.flow && ratio != null ? (
                          <>
                            <span style={{ color: pctColor(p.pct), fontWeight: 600 }}>{p.pct}%</span>
                            {p.lag != null && p.lag > 0
                              ? <span style={{ color: RED }}> · −{fmtVal(p.lag, m.unit)}</span>
                              : <span style={{ color: GREEN }}> ✓</span>}
                          </>
                        ) : "—"}
                      </td>
                    )}
                    {isMonth && <td style={{ textAlign: "right", color: MUTED }}>{p.forecast != null && m.flow && ratio != null ? fmtVal(p.forecast, m.unit) : "—"}</td>}
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

// ── Команди (РПК/РНК) — план/факт із редагованими планами ─────────────
function TeamMatrix({ prev, cur, plans, plansPrev, ratio, isMonth, onSave, onSavePrev }: {
  prev: ExecutiveOverview; cur: ExecutiveOverview; plans: KvpPlans; plansPrev: KvpPlans;
  ratio: number | null; isMonth: boolean;
  onSave: (metric: string, v: number | null) => void;
  onSavePrev: (metric: string, v: number | null) => void;
}) {
  const prevByTeam = new Map(prev.byTeam.map((t) => [t.teamId, t]));
  const rows = [...cur.byTeam].sort((a, b) => b.revenue - a.revenue);
  if (rows.length === 0) return null;
  const maxRev = Math.max(...rows.map((t) => t.revenue), 1);
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: isMonth ? 860 : 620 }}>
        <thead><tr>
          <th style={{ textAlign: "left" }}>#</th><th style={{ textAlign: "left" }}>Команда<InfoHint text={HINTS.teamPlan} /></th>
          <th style={{ textAlign: "right", color: MUTED }}>Факт мин. міс</th>
          {isMonth && <th style={{ textAlign: "right", color: MUTED }}>План мин.</th>}
          <th style={{ textAlign: "right" }}>Факт</th>
          {isMonth && <th style={{ textAlign: "right" }}>План міс</th>}
          {isMonth && <th style={{ textAlign: "right" }}>Викон. %</th>}
          {isMonth && <th style={{ textAlign: "right" }}>Залишок</th>}
          <th style={{ textAlign: "right" }}>Динаміка*</th>
          <th style={{ textAlign: "right" }}>Угод</th><th style={{ textAlign: "right" }}>Сер. чек</th>
        </tr></thead>
        <tbody>
          {rows.map((t, i) => {
            const pv = prevByTeam.get(t.teamId);
            const avg = t.deals > 0 ? Math.round(t.revenue / t.deals) : 0;
            const key = `team_revenue_${t.teamId}`;
            const planCur = plans[key] ?? null;
            const planPrev = plansPrev[key] ?? null;
            const p = computePace(t.revenue, planCur, true, ratio);
            return (
              <tr key={t.teamId}>
                <td style={{ textAlign: "left", fontWeight: 700, color: i === 0 ? "#c5141c" : MUTED }}>{i + 1}</td>
                <td style={{ textAlign: "left" }}>
                  {t.teamName}
                  <div style={{ height: 4, marginTop: 3, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${(t.revenue / maxRev) * 100}%`, height: "100%", background: "linear-gradient(90deg,#e11d2a,#8f0f1c)" }} />
                  </div>
                </td>
                <td style={{ textAlign: "right", color: MUTED }}>{formatAmount(pv?.revenue ?? 0)}</td>
                {isMonth && <td style={{ textAlign: "right" }}><TargetCell value={planPrev} unit="money" muted onSave={(v) => onSavePrev(key, v)} /></td>}
                <td style={{ textAlign: "right", fontWeight: 600 }}>{formatAmount(t.revenue)}</td>
                {isMonth && <td style={{ textAlign: "right" }}><TargetCell value={planCur} unit="money" onSave={(v) => onSave(key, v)} /></td>}
                {isMonth && <td style={{ textAlign: "right", fontWeight: 700, color: pctColor(p.pctMonth) }}>{p.pctMonth != null ? `${p.pctMonth}%` : "—"}</td>}
                {isMonth && (
                  <td style={{ textAlign: "right", fontWeight: 600 }}>
                    {p.left == null ? <span style={{ color: MUTED }}>—</span>
                      : p.left === 0 ? <span style={{ color: GREEN }}>✓</span>
                      : <span style={{ color: AMBER }}>{formatAmount(p.left)}</span>}
                  </td>
                )}
                <td style={{ textAlign: "right" }}><Delta prev={pv?.revenue ?? 0} cur={t.revenue} /></td>
                <td style={{ textAlign: "right" }}>{t.deals}</td>
                <td style={{ textAlign: "right" }}>{formatAmount(avg)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Тижневий блок (минулий тиждень vs поточний, план/факт/викон.) ─────
type WkRatios = { inCur: number; inPrev: number };
function WeeklyMatrix({ prevB, curB, prevRange, curRange, monthPlanOf, teamMonthPlan, ratios }: {
  prevB: Block; curB: Block; prevRange: Range; curRange: Range;
  monthPlanOf: (m: Metric, which: "cur" | "prev") => number | null;
  teamMonthPlan: (teamId: number, which: "cur" | "prev") => number | null;
  ratios: { cur: WkRatios; prev: WkRatios };
}) {
  // Тижневий план: потокові — місячний план пропорційно роб. дням тижня (крос-місячні
  // тижні беруть частку з обох місяців); знімкові (чек/конверсія) — ціль місяця як є.
  const weekPlan = (m: Metric, which: "cur" | "prev"): number | null => {
    const pc = monthPlanOf(m, "cur"), pp = monthPlanOf(m, "prev");
    if (pc == null && pp == null) return null;
    if (!m.flow) return which === "cur" ? pc : (pp ?? pc);
    const r = which === "cur" ? ratios.cur : ratios.prev;
    const v = (pc ?? 0) * r.inCur + (pp ?? 0) * r.inPrev;
    return v > 0 ? Math.round(v) : null;
  };
  const teamWeekPlan = (id: number, which: "cur" | "prev"): number | null => {
    const pc = teamMonthPlan(id, "cur"), pp = teamMonthPlan(id, "prev");
    if (pc == null && pp == null) return null;
    const r = which === "cur" ? ratios.cur : ratios.prev;
    const v = (pc ?? 0) * r.inCur + (pp ?? 0) * r.inPrev;
    return v > 0 ? Math.round(v) : null;
  };
  const rows = METRICS.filter((m) => m.weekly !== false);
  const groups = [...new Set(rows.map((m) => m.group))];
  const prevTeams = new Map(prevB.ov.byTeam.map((t) => [t.teamId, t]));
  const teams = [...curB.ov.byTeam].sort((a, b) => b.revenue - a.revenue);
  const cell = (v: number | null, unit: Unit, muted = false) => (
    <td style={{ textAlign: "right", color: muted ? MUTED : undefined }}>{v != null ? fmtVal(v, unit) : "—"}</td>
  );
  const renderRow = (label: string, unit: Unit, pv: number, cv: number, planPrev: number | null, planCur: number | null, hint?: string) => {
    const pct = planCur != null && planCur > 0 ? Math.round((cv / planCur) * 100) : null;
    const left = planCur != null ? Math.max(0, planCur - cv) : null;
    return (
      <tr key={label}>
        <td style={{ textAlign: "left" }}>{label}{hint && <InfoHint text={hint} />}</td>
        {cell(pv, unit, true)}
        {cell(planPrev, unit, true)}
        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtVal(cv, unit)}</td>
        {cell(planCur, unit)}
        <td style={{ textAlign: "right", fontWeight: 700, color: pctColor(pct) }}>{pct != null ? `${pct}%` : "—"}</td>
        <td style={{ textAlign: "right", fontWeight: 600 }}>
          {left == null ? <span style={{ color: MUTED }}>—</span>
            : left === 0 ? <span style={{ color: GREEN }}>✓</span>
            : <span style={{ color: AMBER }}>{fmtVal(left, unit)}</span>}
        </td>
        <td style={{ textAlign: "right" }}><Delta prev={pv} cur={cv} /></td>
      </tr>
    );
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Показник</th>
            <th style={{ textAlign: "right", color: MUTED }}>Факт<br />{dmy(prevRange.from)}–{dmy(prevRange.to)}</th>
            <th style={{ textAlign: "right", color: MUTED }}>План<br />мин. тижд<InfoHint text="Місячний план × частка робочих днів тижня в місяці (крос-місячні тижні — з обох місяців)." /></th>
            <th style={{ textAlign: "right" }}>Факт<br />{dmy(curRange.from)}–{dmy(curRange.to)}</th>
            <th style={{ textAlign: "right" }}>План<br />поточ. тижд</th>
            <th style={{ textAlign: "right" }}>Викон.<br />плану %</th>
            <th style={{ textAlign: "right" }}>Залишок</th>
            <th style={{ textAlign: "right" }}>Динаміка</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g}>
              <tr><td colSpan={8} style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>{g}</td></tr>
              {rows.filter((m) => m.group === g).map((m) =>
                renderRow(m.label, m.unit, m.get(prevB), m.get(curB), weekPlan(m, "prev"), weekPlan(m, "cur"), m.hint))}
            </Fragment>
          ))}
          {teams.length > 0 && (
            <>
              <tr><td colSpan={8} style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>🏅 Команди (виручка)</td></tr>
              {teams.map((t) =>
                renderRow(`Команда ${t.teamName}`, "money", prevTeams.get(t.teamId)?.revenue ?? 0, t.revenue, teamWeekPlan(t.teamId, "prev"), teamWeekPlan(t.teamId, "cur"), HINTS.teamPlan))}
            </>
          )}
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
  const romi = lq.adBudgetFact > 0 ? Math.round((b.ex.ad.revenue / lq.adBudgetFact) * 100) : null;
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
    { label: "ROMI", val: romi != null ? `${romi}%` : "—", hint: "Дохід з реклами ÷ рекл. бюджет × 100%." },
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

// ── Декомпозиція плану (stored цілі, з фолбеком) ──────────────────────
function Decomposition({ b, plans, periodPlan }: { b: Block; plans: KvpPlans; periodPlan?: boolean }) {
  const o = b.ov;
  const plan = periodPlan ? o.plan : (o.planMonthTotal || plans.received_total || o.plan);
  const avg = avgCheck(o);
  const carsDone = b.ex.dispatched.count;
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
        Ср. чек {formatAmountFull(avg)} · конверсія реклами {conv}%. Треба авто/лідів — зі збережених планів КВП (якщо задані), інакше розрахунок із плану виручки. «На день» = лишилось ÷ {daysLeft} роб. днів.
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

// ── Місяць по тижнях (факт-грід) ──────────────────────────────────────
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
  const [plansPrev, setPlansPrev] = useState<KvpPlans>({});

  const setup = useMemo(() => {
    const [selY, selM] = monthSel.split("-").map(Number);
    const y = selY, m0 = selM - 1;
    const now = new Date();
    const isCurrentMonth = y === now.getFullYear() && m0 === now.getMonth();
    const today = ymd(now);
    const prevY = m0 === 0 ? y - 1 : y, prevM0 = m0 === 0 ? 11 : m0 - 1;
    const prevMonthStr = `${prevY}-${String(prevM0 + 1).padStart(2, "0")}`;
    const monthPrev = fullMonthRange(prevY, prevM0);
    const full = fullMonthRange(y, m0);
    const monthCur: Range = isCurrentMonth ? { ...full, to: today } : full;
    const selWeeks = weekBlocksFor(y, m0);
    // Календарні тижні (Пн–Нд): поточний (факт кліпнутий до сьогодні) і минулий —
    // як у ручному звіті КВП (29.06–05.07 vs 22.06–28.06).
    let curWeek: Range | null = null, prevWeek: Range | null = null;
    let ratios: { cur: WkRatios; prev: WkRatios } = { cur: { inCur: 0, inPrev: 0 }, prev: { inCur: 0, inPrev: 0 } };
    if (isCurrentMonth) {
      const dow = (now.getDay() + 6) % 7; // Пн=0
      const mon = new Date(now); mon.setDate(now.getDate() - dow); mon.setHours(0, 0, 0, 0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const pMon = new Date(mon); pMon.setDate(mon.getDate() - 7);
      const pSun = new Date(mon); pSun.setDate(mon.getDate() - 1);
      const curFull: Range = { from: ymd(mon), to: ymd(sun) };
      curWeek = { from: ymd(mon), to: today };
      prevWeek = { from: ymd(pMon), to: ymd(pSun) };
      const wkRatio = (w: Range, month: Range): number => {
        const i = isect(w.from, w.to, month.from, month.to);
        if (!i) return 0;
        const tot = wdCount(month.from, month.to);
        return tot > 0 ? wdCount(i[0], i[1]) / tot : 0;
      };
      // План тижня — за ПОВНИЙ тиждень (Пн–Нд), факт — кліпнутий до сьогодні.
      ratios = {
        cur: { inCur: wkRatio(curFull, full), inPrev: wkRatio(curFull, monthPrev) },
        prev: { inCur: wkRatio(prevWeek, full), inPrev: wkRatio(prevWeek, monthPrev) },
      };
    }
    return { monthPrev, monthCur, selWeeks, curWeek, prevWeek, ratios, isCurrentMonth, prevMonthStr, monthLabel: `${MONTH_NAMES[m0]} ${y}` };
  }, [monthSel]);

  const [data, setData] = useState<{ monthPrev: Block; monthCur: Block; selWeeks: Block[]; curWeek: Block | null; prevWeek: Block | null } | null>(null);
  const [rangeData, setRangeData] = useState<{ cur: Block; prev: Block } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadBlock = async (r: Range): Promise<Block> => {
    const [ov, lq, ex] = await Promise.all([fetchOverview(r), fetchLeadQuality(r), fetchKvpExtra(r)]);
    return { ov, lq, ex };
  };

  // Плани — на обраний і попередній місяці.
  useEffect(() => {
    let alive = true;
    fetchKvpPlan(monthSel).then((p) => { if (alive) setPlans(p); }).catch(() => { if (alive) setPlans({}); });
    fetchKvpPlan(setup.prevMonthStr).then((p) => { if (alive) setPlansPrev(p); }).catch(() => { if (alive) setPlansPrev({}); });
    return () => { alive = false; };
  }, [monthSel, setup.prevMonthStr]);

  const onSavePlan = (metric: string, v: number | null) => {
    setPlans((prev) => { const next = { ...prev }; if (v == null) delete next[metric]; else next[metric] = v; return next; });
    saveKvpPlan(monthSel, { [metric]: v }).catch(() => {});
  };
  const onSavePlanPrev = (metric: string, v: number | null) => {
    setPlansPrev((prev) => { const next = { ...prev }; if (v == null) delete next[metric]; else next[metric] = v; return next; });
    saveKvpPlan(setup.prevMonthStr, { [metric]: v }).catch(() => {});
  };

  // «Плани з факту минулого місяця +N%»: для метрик БЕЗ ручного плану ставимо
  // факт минулого місяця, збільшений на N% (гроші округлюємо до сотень).
  // Ручні плани і авто-плани (виручка з планів менеджерів, реклбюджет) не чіпаємо.
  const [seeding, setSeeding] = useState(false);
  const seedPlans = async () => {
    if (!data) return;
    const pctStr = window.prompt("На скільки % збільшити показники минулого місяця? (2–5)", "3");
    if (pctStr == null) return;
    const k = 1 + (Math.max(0, Number(pctStr.replace(",", "."))) || 0) / 100;
    const upd: Record<string, number> = {};
    for (const m of METRICS) {
      if (!m.planKind || m.planKind === "revenue" || m.planKind === "ad_budget") continue;
      if (plans[m.planKind] != null) continue; // ручний план уже стоїть — не перезаписуємо
      const fv = m.get(data.monthPrev);
      if (!fv || fv <= 0) continue;
      upd[m.planKind] = m.unit === "num" || m.unit === "pct"
        ? Math.ceil(fv * k)
        : Math.round((fv * k) / 100) * 100;
    }
    for (const t of data.monthPrev.ov.byTeam) {
      const key = `team_revenue_${t.teamId}`;
      if (plans[key] != null || !t.revenue) continue;
      upd[key] = Math.round((t.revenue * k) / 100) * 100;
    }
    if (!Object.keys(upd).length) { window.alert("Усі плани вже заповнені — нічого доповнювати (ручні не перезаписуються)."); return; }
    setSeeding(true);
    try {
      await saveKvpPlan(monthSel, upd);
      setPlans((p) => ({ ...p, ...upd }));
      window.alert(`Заповнено ${Object.keys(upd).length} планів = факт минулого місяця +${pctStr}%.`);
    } finally { setSeeding(false); }
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
        const extra = setup.curWeek && setup.prevWeek ? [setup.curWeek, setup.prevWeek] : [];
        const results = await Promise.all([loadBlock(setup.monthPrev), loadBlock(setup.monthCur), ...setup.selWeeks.map(loadBlock), ...extra.map(loadBlock)]);
        if (!alive) return;
        const selWeeks = results.slice(2, 2 + setup.selWeeks.length);
        const curWeek = extra.length ? results[2 + setup.selWeeks.length] : null;
        const prevWeek = extra.length ? results[2 + setup.selWeeks.length + 1] : null;
        setData({ monthPrev: results[0], monthCur: results[1], selWeeks, curWeek, prevWeek });
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
  // Темп/проекція — лише в місячному режимі.
  const ratio = (!rangeMode && active) ? paceRatio(active.ov.projection) : null;
  const heroPlanToday = active ? Math.round((active.ov.planMonthTotal || plans.received_total || active.ov.plan || 0) * (ratio ?? 1)) : null;

  // План метрики за місяць (для тижневих планів).
  const monthPlanOf = (m: Metric, which: "cur" | "prev"): number | null =>
    monthPlanOfBlock(m, which === "cur" ? data?.monthCur : data?.monthPrev, which === "cur" ? plans : plansPrev);
  const teamMonthPlan = (teamId: number, which: "cur" | "prev"): number | null =>
    (which === "cur" ? plans : plansPrev)[`team_revenue_${teamId}`] ?? null;

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
          {!rangeMode && (
            <button onClick={seedPlans} disabled={seeding || !data}
              title="Для показників БЕЗ плану: ставить факт минулого місяця +N% (ручні плани не перезаписуються)"
              style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#c5141c", color: "#fff", fontWeight: 600, cursor: seeding || !data ? "default" : "pointer", opacity: seeding || !data ? 0.6 : 1 }}>
              {seeding ? "Заповнюю…" : "📈 Плани з факту мин. міс."}
            </button>
          )}
        </div>
      </div>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 16px", maxWidth: 900 }}>
        Структура ручного звіту КВП: факт і план минулого й поточного місяця, <b>Викон. плану %</b> = факт ÷ план місяця, <b>Залишок</b> — скільки ще до плану.
        Плани, яких дашборд не знає, проставляй кліком по клітинці «✏️ план» (зберігаються по місяцях). <b>Динаміка (*)</b> — поточний vs попередній період.
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
              isMonth={!rangeMode} plans={plans} plansPrev={plansPrev} ratio={ratio}
              onSave={onSavePlan} onSavePrev={onSavePlanPrev}
            />
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🏅 Команди — план / факт (РПК · РНК)</h2>
            <TeamMatrix prev={activePrev.ov} cur={active.ov} plans={plans} plansPrev={plansPrev} ratio={ratio} isMonth={!rangeMode} onSave={onSavePlan} onSavePrev={onSavePlanPrev} />
          </div>

          {!rangeMode && data && data.curWeek && data.prevWeek && setup.curWeek && setup.prevWeek && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">🗓️ Тиждень: {dmy(setup.curWeek.from)}–{dmy(setup.curWeek.to)} vs {dmy(setup.prevWeek.from)}–{dmy(setup.prevWeek.to)}</h2>
              <p style={{ fontSize: 12, color: MUTED, margin: "0 0 10px" }}>Календарні тижні Пн–Нд, як у ручному звіті. План тижня = місячний план × частка робочих днів тижня.</p>
              <WeeklyMatrix prevB={data.prevWeek} curB={data.curWeek} prevRange={setup.prevWeek} curRange={setup.curWeek}
                monthPlanOf={monthPlanOf} teamMonthPlan={teamMonthPlan} ratios={setup.ratios} />
            </div>
          )}

          <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, marginBottom: 16 }}>
            <div className="chart-card"><h2 className="chart-title">💎 Якість виручки</h2><RevenueQuality o={active.ov} /></div>
            <div className="chart-card"><h2 className="chart-title">🎯 Реклама — ефективність</h2><AdEfficiency b={active} /></div>
          </div>

          <LeadgenRegularsCard />

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🎯 Декомпозиція плану ({rangeMode ? "період" : "місяць"}, по відділу)</h2>
            <Decomposition b={active} plans={plans} periodPlan={rangeMode} />
          </div>

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
