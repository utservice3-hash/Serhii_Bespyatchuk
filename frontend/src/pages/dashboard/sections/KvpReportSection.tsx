import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchOverview, fetchLeadQuality, type ExecutiveOverview, type LeadQuality } from "../../../api";
import { formatAmount } from "../format";

type Range = { from: string; to: string; label?: string };
type Unit = "money" | "num" | "pct";
type Block = { ov: ExecutiveOverview; lq: LeadQuality };

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dmy = (iso: string) => iso.split("-").reverse().join(".");

function monthRange(offset: number): Range {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: ymd(from), to: ymd(to) };
}

/** Fixed 7-day blocks from the 1st: [1-7],[8-14],[15-21],[22-28],[29-end].
 *  Matches how the manager sheet splits a month into "тижні". */
function monthWeekBlocks(offset: number): Range[] {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + offset;
  const last = new Date(y, m + 1, 0).getDate();
  const starts = [1, 8, 15, 22, 29];
  return starts
    .filter((s) => s <= last)
    .map((s, i) => ({
      from: ymd(new Date(y, m, s)),
      to: ymd(new Date(y, m, Math.min(s + 6, last))),
      label: `Тиждень ${i + 1}`,
    }));
}

/** Index (0..4) of the fixed 7-day block that today falls into. */
function currentBlockIndex(): number {
  return Math.min(4, Math.floor((new Date().getDate() - 1) / 7));
}

const avgCheck = (o: ExecutiveOverview) => {
  const n = o.successDeals + o.paymentDeals;
  return n > 0 ? Math.round(o.fact / n) : 0;
};

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
      { key: "avg", label: "Середній чек", unit: "money", get: (b) => avgCheck(b.ov) },
      { key: "repeatRev", label: "Виручка від постійних", unit: "money", get: (b) => b.ov.repeatRevenue, sumInWeekly: true },
      { key: "newRev", label: "Виручка від нових", unit: "money", get: (b) => b.ov.newRevenue, sumInWeekly: true },
      { key: "carryover", label: "Перенесено з мин. місяця", unit: "money", get: (b) => b.ov.carryover?.amount ?? 0 },
    ],
  },
  {
    group: "👥 Угоди та клієнти",
    metrics: [
      { key: "created", label: "Створені угоди (повний цикл)", unit: "num", get: (b) => b.ov.createdFullCycle, sumInWeekly: true },
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
      { key: "adLeads", label: "Ліди з реклами (CRM)", unit: "num", get: (b) => b.ov.adConversion.leads, sumInWeekly: true },
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
            <th style={{ textAlign: "right" }}>Динаміка*</th>
            <th style={{ textAlign: "right" }}>План</th>
            <th style={{ textAlign: "right" }}>Викон.</th>
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
                    <td style={{ textAlign: "left" }}>{mt.label}</td>
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
export function KvpReportSection() {
  const setup = useMemo(() => {
    const monthPrev = monthRange(-1);
    const monthCur = { ...monthRange(0), to: ymd(new Date()) }; // MTD
    const prevWeeks = monthWeekBlocks(-1);
    const curWeeksFull = monthWeekBlocks(0);
    const idx = Math.min(currentBlockIndex(), curWeeksFull.length - 1);
    const today = ymd(new Date());
    const curWeekFull = curWeeksFull[idx];
    const curWeek: Range = { ...curWeekFull, to: today < curWeekFull.to ? today : curWeekFull.to };
    const analogWeek = prevWeeks[Math.min(idx, prevWeeks.length - 1)];
    return { monthPrev, monthCur, prevWeeks, curWeek, analogWeek, idx };
  }, []);

  const [data, setData] = useState<{
    monthPrev: Block; monthCur: Block; prevWeeks: Block[]; curWeek: Block; analogWeek: Block;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (r: Range): Promise<Block> => {
      const [ov, lq] = await Promise.all([fetchOverview(r), fetchLeadQuality(r)]);
      return { ov, lq };
    };
    (async () => {
      try {
        const [monthPrev, monthCur, curWeek, ...prevWeeks] = await Promise.all([
          load(setup.monthPrev), load(setup.monthCur), load(setup.curWeek),
          ...setup.prevWeeks.map(load),
        ]);
        if (!alive) return;
        const analogWeek = prevWeeks[Math.min(setup.idx, prevWeeks.length - 1)];
        setData({ monthPrev, monthCur, prevWeeks, curWeek, analogWeek });
      } catch {
        if (alive) setErr("Не вдалося завантажити звіт.");
      }
    })();
    return () => { alive = false; };
  }, [setup]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 Звіт КВП</h1>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 760 }}>
        Зведення керівника відділу продажу — автоматично з CRM та Google-таблиці реклами.
        <b> Динаміка (*)</b> скрізь рахується до аналогічного періоду минулого місяця (місяць→минулий місяць, тиждень→той самий тиждень минулого місяця).
      </p>

      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!data && !err && <p className="loading-text">Завантаження…</p>}

      {data && (
        <>
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">📅 За місяць (поточний vs минулий)</h2>
            <ComparisonTable prev={data.monthPrev} cur={data.monthCur} prevRange={setup.monthPrev} curRange={setup.monthCur} isMonth />
            <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0 4px" }}>По командах</h3>
            <TeamTable prev={data.monthPrev.ov} cur={data.monthCur.ov} />
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🗓️ Поточний тиждень (vs той самий тиждень минулого місяця)</h2>
            <ComparisonTable prev={data.analogWeek} cur={data.curWeek} prevRange={setup.analogWeek} curRange={setup.curWeek} isMonth={false} />
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">📊 Минулий місяць по тижнях</h2>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>
              Тижні = фіксовані 7-денні блоки від 1-го числа (1–7, 8–14, 15–21, 22–28, 29–кінець).
            </p>
            <WeeklyBreakdown weeks={setup.prevWeeks} blocks={data.prevWeeks} />
          </div>
        </>
      )}
    </>
  );
}
