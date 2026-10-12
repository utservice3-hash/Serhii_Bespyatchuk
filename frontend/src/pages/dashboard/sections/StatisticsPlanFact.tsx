import { Fragment, useState } from "react";
import type { PlanFactLine, PlanFactResp, PlanFactTeam } from "../../../api";
import { planTone, AvgCheckCell } from "./StatisticsSummary";
import { ddmm } from "../periodRules";

/**
 * 📋 ВКЛАДКА «ПЛАН-ФАКТ» (ТЗ 4632 п.2.2): компанія → команда → менеджер; план, факт, %, залишок, очікування, треба на
 * день, сер. чек проти цілі команди і дзвінки на день проти норми. Усі числа рахує сервер (`/statistics/plan-fact`);
 * тут лише показ. Рядок команди — те, що прийшло з сервера, а не сума видимих рядків: так «згорнуто» і «розгорнуто»
 * не можуть показати різне.
 */

const MUTED = "var(--text-muted)";
const fmtN = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
const money = (n: number | null) => (n == null ? <span style={{ color: MUTED }}>—</span> : <>{fmtN(n)} ₴</>);

function Cells({ l, norm, target, baseDeals, complete }: { l: PlanFactLine; norm: number | null; target?: number | null; baseDeals?: number; complete: boolean }) {
  const tone = planTone(l.pct);
  const cPct = l.callsPerDay != null && norm ? (l.callsPerDay / norm) * 100 : null;
  return (
    <>
      <td style={{ textAlign: "right" }}>{l.plan != null ? `${fmtN(l.plan)} ₴` : <span style={{ color: MUTED }}>плану немає</span>}</td>
      <td style={{ textAlign: "right" }}>{fmtN(l.fact)} ₴</td>
      <td style={{ textAlign: "right", fontWeight: 800, color: tone.fg }}>{l.pct != null ? `${l.pct}%` : "—"}</td>
      <td style={{ textAlign: "right" }}>{money(l.remaining)}</td>
      <td style={{ textAlign: "right" }}>{complete ? <span style={{ color: MUTED }}>—</span> : money(l.expect)}</td>
      <td style={{ textAlign: "right" }}>{complete ? <span style={{ color: MUTED }}>період минув</span> : money(l.needPerDay)}</td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        {target !== undefined ? <AvgCheckCell value={l.avgCheck} target={target} baseDeals={baseDeals ?? 0} /> : money(l.avgCheck)}
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap", fontWeight: 700, color: planTone(cPct, true).fg }}>
        {l.callsPerDay != null ? l.callsPerDay : <span style={{ color: MUTED, fontWeight: 400 }}>—</span>}
      </td>
    </>
  );
}

export function StatisticsPlanFact({ data }: { data: PlanFactResp }) {
  // Тімліду (одна команда) — розгорнуто одразу; компанії — згорнуто до команд.
  const [open, setOpen] = useState<Set<string>>(() => new Set(data.teams.length === 1 ? [String(data.teams[0].teamId)] : []));
  const [showArchived, setShowArchived] = useState(false);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const teams = data.teams.filter((t) => showArchived || !t.archived);
  const archived = data.teams.filter((t) => t.archived).length;
  const norm = data.callsNorm;

  const teamRow = (t: PlanFactTeam) => {
    const k = String(t.teamId);
    const isOpen = open.has(k);
    return (
      <Fragment key={k}>
        <tr onClick={() => toggle(k)} style={{ cursor: "pointer", background: "rgba(127,127,127,0.05)", opacity: t.archived ? 0.6 : 1 }}>
          <td style={{ fontWeight: 800 }}>{isOpen ? "▾" : "▸"} {t.name} <span style={{ color: MUTED, fontWeight: 400, fontSize: 12 }}>· {t.managers.length}</span></td>
          <Cells l={t} norm={norm} target={t.teamId == null ? undefined : t.avgCheckTarget} baseDeals={t.avgCheckBaseDeals} complete={data.complete} />
        </tr>
        {isOpen && t.managers.map((m) => (
          <tr key={`${k}:${m.managerId}`}>
            <td style={{ paddingLeft: 26 }}>{m.name}{!m.isActive && <span style={{ color: MUTED, fontSize: 12 }}> · звільнений</span>}</td>
            {/* Менеджер міряється ціллю СВОЄЇ команди — ціль чека ставиться по командах (Юля 10.10.2026). */}
            <Cells l={m} norm={norm} target={t.teamId == null ? undefined : t.avgCheckTarget} baseDeals={t.avgCheckBaseDeals} complete={data.complete} />
          </tr>
        ))}
      </Fragment>
    );
  };

  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <b style={{ fontSize: 14 }}>План-факт · {ddmm(data.period.from)}–{ddmm(data.period.to)}{!data.complete ? ` · станом на ${ddmm(data.cur.to)}` : ""}</b>
        {archived > 0 && (
          <label style={{ fontSize: 12, color: MUTED, cursor: "pointer" }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> показати архівні ({archived})
          </label>
        )}
      </div>
      {/* 🏷 Правила — словами над таблицею, а не лише в ⓘ. */}
      <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.45, marginBottom: 8 }}>
        <div>Факт — отримані кошти (оплата отримана ∪ успішно реалізовано), як на Звіті. План: {data.planRule}.</div>
        <div>Очікування — за плановою датою оплати від сьогодні до кінця періоду. Треба на день — залишок ÷ робочі дні до кінця періоду ({data.workDaysLeft}).</div>
        <div>Сер. чек: {data.avgCheckRule}. Дзвінки — розмови + спроби на менеджера за робочий день; норма {norm != null ? <b style={{ color: "var(--text)" }}>{norm}</b> : "не задана"} (Плани).</div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Команда / менеджер</th>
              <th style={{ textAlign: "right" }}>План</th><th style={{ textAlign: "right" }}>Факт</th><th style={{ textAlign: "right" }}>%</th>
              <th style={{ textAlign: "right" }}>Залишок</th><th style={{ textAlign: "right" }}>Очікування</th>
              <th style={{ textAlign: "right" }}>Треба на день</th>
              <th style={{ textAlign: "right" }}>Сер. чек · ціль</th>
              <th style={{ textAlign: "right" }} title="розмови + спроби на менеджера за робочий день">Дзвінків / день</th>
            </tr>
          </thead>
          <tbody>
            {data.company && (
              <tr style={{ fontWeight: 800, borderBottom: "2px solid var(--border)" }}>
                <td>Компанія</td>
                <Cells l={data.company} norm={norm} complete={data.complete} />
              </tr>
            )}
            {teams.map(teamRow)}
          </tbody>
        </table>
      </div>
      {teams.length === 0 && <div style={{ fontSize: 13, color: MUTED, padding: "8px 0" }}>За цей період немає ні плану, ні факту.</div>}
    </div>
  );
}
