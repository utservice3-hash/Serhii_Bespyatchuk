import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchOverview, fetchLeadQuality, type ExecutiveOverview, type LeadQuality } from "../../../api";
import { formatAmount } from "../format";

type Range = { from: string; to: string };
type Unit = "money" | "num" | "pct";
type Row = { label: string; prev: number; cur: number; unit: Unit; plan?: number | null; pct?: number | null };

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** offset 0 = this month, -1 = previous month; full calendar month range. */
function monthRange(offset: number): Range {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: ymd(from), to: ymd(to) };
}
/** offset 0 = this week, -1 = last week; Monday–Sunday. */
function weekRange(offset: number): Range {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0 = Monday
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + offset * 7);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { from: ymd(mon), to: ymd(sun) };
}

const dmy = (iso: string) => iso.split("-").reverse().join(".");

type Block = { ov: ExecutiveOverview; lq: LeadQuality };

const avgCheck = (o: ExecutiveOverview) => {
  const n = o.successDeals + o.paymentDeals;
  return n > 0 ? Math.round(o.fact / n) : 0;
};

function buildRows(prev: Block, cur: Block, isMonth: boolean): { group: string; rows: Row[] }[] {
  const p = prev.ov, c = cur.ov;
  const planFact = isMonth ? c.planMonthTotal : c.plan;
  return [
    {
      group: "💰 Дохід",
      rows: [
        { label: "Отримані кошти (успішно + оплата)", prev: p.fact, cur: c.fact, unit: "money", plan: planFact, pct: c.planPct },
        { label: "Успішно закрито — сума", prev: p.successRevenue, cur: c.successRevenue, unit: "money" },
        { label: "Успішно закрито — угод", prev: p.successDeals, cur: c.successDeals, unit: "num" },
        { label: "Оплата отримана — сума", prev: p.paymentRevenue, cur: c.paymentRevenue, unit: "money" },
        { label: "Оплата отримана — угод", prev: p.paymentDeals, cur: c.paymentDeals, unit: "num" },
        { label: "Середній чек", prev: avgCheck(p), cur: avgCheck(c), unit: "money" },
        { label: "Виручка від постійних", prev: p.repeatRevenue, cur: c.repeatRevenue, unit: "money" },
        { label: "Виручка від нових", prev: p.newRevenue, cur: c.newRevenue, unit: "money" },
      ],
    },
    {
      group: "👥 Угоди та клієнти",
      rows: [
        { label: "Створені угоди (повний цикл)", prev: p.createdFullCycle, cur: c.createdFullCycle, unit: "num" },
        { label: "Нові клієнти", prev: p.newClients, cur: c.newClients, unit: "num" },
        { label: "Постійні клієнти", prev: p.repeatClients, cur: c.repeatClients, unit: "num" },
        { label: "Дебіторка (знімок)", prev: p.receivablesTotal, cur: c.receivablesTotal, unit: "money" },
      ],
    },
    {
      group: "🎯 Реклама",
      rows: [
        { label: "Ліди з реклами", prev: p.adConversion.leads, cur: c.adConversion.leads, unit: "num" },
        { label: "Оплачено з реклами", prev: p.adConversion.paid, cur: c.adConversion.paid, unit: "num" },
        { label: "Конверсія реклами", prev: p.adConversion.conversion, cur: c.adConversion.conversion, unit: "pct" },
        { label: "Цільові ліди (повний цикл)", prev: prev.lq.targetLeads, cur: cur.lq.targetLeads, unit: "num" },
        { label: "Не цільові ліди (Кваліфікація 143)", prev: prev.lq.nonTargetLeads, cur: cur.lq.nonTargetLeads, unit: "num" },
      ],
    },
    {
      group: "📞 Лідогенератори",
      rows: [
        { label: "Передані заявки", prev: p.transferred.total, cur: c.transferred.total, unit: "num" },
        { label: "Успішно з переданих", prev: p.transferred.success, cur: c.transferred.success, unit: "num" },
        { label: "Конверсія лідогену", prev: p.leadgenConversion.conversion, cur: c.leadgenConversion.conversion, unit: "pct" },
      ],
    },
  ];
}

function fmtVal(v: number, unit: Unit) {
  if (unit === "money") return formatAmount(v);
  if (unit === "pct") return `${v}%`;
  return v.toLocaleString("uk-UA");
}

function DeltaCell({ prev, cur }: { prev: number; cur: number }) {
  const diff = cur - prev;
  const pct = prev > 0 ? Math.round((diff / prev) * 100) : cur > 0 ? 100 : 0;
  const color = diff > 0 ? "#16a34a" : diff < 0 ? "#dc2626" : "var(--text-muted)";
  const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
  return <span style={{ color, fontWeight: 600, whiteSpace: "nowrap" }}>{arrow} {Math.abs(pct)}%</span>;
}

function ComparisonTable({ prevRange, curRange, groups }: { prevRange: Range; curRange: Range; groups: { group: string; rows: Row[] }[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table compact" style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Показник</th>
            <th style={{ textAlign: "right" }}>{dmy(prevRange.from)}–{dmy(prevRange.to)}</th>
            <th style={{ textAlign: "right" }}>{dmy(curRange.from)}–{dmy(curRange.to)}</th>
            <th style={{ textAlign: "right" }}>Динаміка</th>
            <th style={{ textAlign: "right" }}>План</th>
            <th style={{ textAlign: "right" }}>Викон.</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.group}>
              <tr>
                <td colSpan={6} style={{ fontWeight: 700, background: "var(--bg-subtle, rgba(127,127,127,0.08))", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>{g.group}</td>
              </tr>
              {g.rows.map((r) => {
                const pctColor = r.pct == null ? "var(--text-muted)" : r.pct >= 100 ? "#16a34a" : r.pct >= 70 ? "#d97706" : "#dc2626";
                return (
                  <tr key={g.group + r.label}>
                    <td style={{ textAlign: "left" }}>{r.label}</td>
                    <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{fmtVal(r.prev, r.unit)}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtVal(r.cur, r.unit)}</td>
                    <td style={{ textAlign: "right" }}><DeltaCell prev={r.prev} cur={r.cur} /></td>
                    <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{r.plan != null ? fmtVal(r.plan, r.unit) : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 600, color: pctColor }}>{r.pct != null ? `${r.pct}%` : "—"}</td>
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

function TeamTable({ prev, cur }: { prev: ExecutiveOverview; cur: ExecutiveOverview }) {
  const prevByTeam = new Map(prev.byTeam.map((t) => [t.teamId, t]));
  if (cur.byTeam.length === 0) return null;
  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table className="data-table compact" style={{ minWidth: 520 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Команда</th>
            <th style={{ textAlign: "right" }}>Минулий</th>
            <th style={{ textAlign: "right" }}>Поточний</th>
            <th style={{ textAlign: "right" }}>Угод</th>
            <th style={{ textAlign: "right" }}>Динаміка</th>
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
                <td style={{ textAlign: "right" }}><DeltaCell prev={pv?.revenue ?? 0} cur={t.revenue} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Звіт КВП — department-head weekly/monthly scorecard. Admin/КВП only.
 *  Auto-filled from CRM: reuses the trusted /overview metrics across four
 *  periods (this/last month, this/last week) so numbers match the rest of the
 *  dashboard exactly. Finance-only rows (CASH FLOW, рекл. бюджет, тендери)
 *  live outside CRM and are not shown yet. */
export function KvpReportSection() {
  const ranges = useMemo(() => ({
    monthCur: monthRange(0), monthPrev: monthRange(-1),
    weekCur: weekRange(0), weekPrev: weekRange(-1),
  }), []);
  const [data, setData] = useState<Record<"monthCur" | "monthPrev" | "weekCur" | "weekPrev", Block> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (r: Range): Promise<Block> => {
      const [ov, lq] = await Promise.all([fetchOverview(r), fetchLeadQuality(r)]);
      return { ov, lq };
    };
    Promise.all([load(ranges.monthPrev), load(ranges.monthCur), load(ranges.weekPrev), load(ranges.weekCur)])
      .then(([mp, mc, wp, wc]) => { if (alive) setData({ monthPrev: mp, monthCur: mc, weekPrev: wp, weekCur: wc }); })
      .catch(() => { if (alive) setErr("Не вдалося завантажити звіт."); });
    return () => { alive = false; };
  }, [ranges]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 Звіт КВП</h1>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 720 }}>
        Зведення керівника відділу продажу — автоматично з CRM. Порівняння план/факт по місяцю та тижню.
        Фінансові рядки поза CRM (CASH FLOW, рекламний бюджет, виграні тендери) поки не показуються — за потреби додамо ручне введення.
      </p>

      {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
      {!data && !err && <p className="loading-text">Завантаження…</p>}

      {data && (
        <>
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">📅 За місяць</h2>
            <ComparisonTable prevRange={ranges.monthPrev} curRange={ranges.monthCur} groups={buildRows(data.monthPrev, data.monthCur, true)} />
            <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0 4px" }}>По командах</h3>
            <TeamTable prev={data.monthPrev.ov} cur={data.monthCur.ov} />
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title">🗓️ За тиждень</h2>
            <ComparisonTable prevRange={ranges.weekPrev} curRange={ranges.weekCur} groups={buildRows(data.weekPrev, data.weekCur, false)} />
            <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0 4px" }}>По командах</h3>
            <TeamTable prev={data.weekPrev.ov} cur={data.weekCur.ov} />
          </div>
        </>
      )}
    </>
  );
}
