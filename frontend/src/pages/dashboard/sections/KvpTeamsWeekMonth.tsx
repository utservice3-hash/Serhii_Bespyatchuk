import { Fragment, useState } from "react";
import type { KvpReport } from "../../../api";
import { formatAmount } from "../format";
import { InfoHint } from "../widgets";
import { coreRows, weekCloseStatus, closeNote, pctOfPlan, CLOSE_LABEL, type CloseKind, type CoreRow, type Money3, type TeamLike } from "../kvpCoreRules";

/**
 * 🏅 «КОМАНДИ: ТИЖДЕНЬ І МІСЯЦЬ» (задача 5605, ТЗ Юлі 12.10.2026, розділ 3; макет «Звіт КВП - ядро»).
 * Тиждень: План · Без очікувань · З очікуваннями · «Закриємо?»; місяць: План · Без очікувань · З очікуваннями. Під сумою —
 * % від плану. Клік по команді — менеджери в тих самих колонках. Числа — з `/kvp-report` без жодної своєї формули
 * (`kvpCoreRules.coreRows`), стиль — таблиця `data-table`, як решта звіту.
 */
const MUTED = "var(--text-muted)";
const TONE: Record<CloseKind, { bg: string; fg: string }> = {
  closed: { bg: "rgba(22,163,74,.12)", fg: "#15803d" },
  real: { bg: "rgba(22,163,74,.12)", fg: "#15803d" },
  risk: { bg: "rgba(217,119,6,.14)", fg: "#b45309" },
  no: { bg: "rgba(220,38,38,.12)", fg: "#dc2626" },
  none: { bg: "transparent", fg: MUTED },
};
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const kindLabel: Record<string, string> = { rpk: "РПК", rnk: "РНК", leadgen: "Лідогенерація" };

function Sum({ v, plan, bold }: { v: number; plan: number; bold?: boolean }) {
  const p = pctOfPlan(v, plan);
  return (
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: bold ? 700 : 600 }}>
      {formatAmount(v)}
      <div style={{ fontSize: 11, fontWeight: 400, color: MUTED }}>{p == null ? "—" : `${String(p)}%`}</div>
    </td>
  );
}

function Status({ w }: { w: Money3 }) {
  const s = weekCloseStatus(w.plan, w.fact, w.withExp - w.fact);
  if (s.kind === "none") return <td style={{ color: MUTED, paddingLeft: 16 }}>—</td>;
  const note = closeNote(s, formatAmount);
  return (
    <td style={{ paddingLeft: 16, minWidth: 170 }}>
      <span style={{ display: "inline-block", fontSize: 12, fontWeight: 600, padding: "1px 8px", borderRadius: 10, background: TONE[s.kind].bg, color: TONE[s.kind].fg }}>{CLOSE_LABEL[s.kind]}</span>
      {note && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{note}</div>}
    </td>
  );
}

function Cells({ r, bold }: { r: Pick<CoreRow, "week" | "month">; bold?: boolean }) {
  return (<>
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatAmount(r.week.plan)}</td>
    <Sum v={r.week.fact} plan={r.week.plan} bold={bold} />
    <Sum v={r.week.withExp} plan={r.week.plan} bold={bold} />
    <Status w={r.week} />
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", borderLeft: "1px solid var(--border)" }}>{formatAmount(r.month.plan)}</td>
    <Sum v={r.month.fact} plan={r.month.plan} bold={bold} />
    <Sum v={r.month.withExp} plan={r.month.plan} bold={bold} />
  </>);
}

export function KvpTeamsWeekMonth({ rep }: { rep: KvpReport }) {
  const [open, setOpen] = useState<string | null>(null);
  const blk = rep.weekBlocks.find((b) => b.isCurrent) ?? [...rep.weekBlocks].reverse().find((b) => !b.isFuture) ?? null;
  const { rows, dept } = coreRows(rep.teams as unknown as TeamLike[], blk?.idx ?? null,
    (t) => t.name || `Без команди · ${kindLabel[t.kind] ?? t.kind}`);
  const monthName = rep.scope.label;
  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <h2 className="chart-title" style={{ marginBottom: 2 }}>🏅 Команди: тиждень і місяць
        <InfoHint text="Без очікувань — гроші, що вже прийшли (отримані кошти, як у картці вгорі). З очікуваннями — плюс оплати з плановою датою оплати в цьому тижні чи місяці. План тижня — той самий динамічний план, що на Звіті. Клік по команді — менеджери." /></h2>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>без очікувань — гроші, що вже прийшли; з очікуваннями — плюс оплати з плановою датою в цьому тижні або місяці. Клік по команді — менеджери</div>
      {!blk ? <p style={{ color: MUTED, fontSize: 13 }}>Тижні рахуються лише для одного календарного місяця — оберіть «Місяць».</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th rowSpan={2} style={{ verticalAlign: "bottom" }}>Команда</th>
                <th colSpan={4} style={{ textAlign: "center" }}>Тиждень {blk.from.slice(8, 10)}–{ddmm(blk.to)}</th>
                <th colSpan={3} style={{ textAlign: "center", borderLeft: "1px solid var(--border)" }}>{monthName}</th>
              </tr>
              <tr>
                <th style={{ textAlign: "right" }}>План</th><th style={{ textAlign: "right" }}>Без очікувань</th>
                <th style={{ textAlign: "right" }}>З очікуваннями</th><th style={{ paddingLeft: 16 }}>Закриємо?</th>
                <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>План</th>
                <th style={{ textAlign: "right" }}>Без очікувань</th><th style={{ textAlign: "right" }}>З очікуваннями</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.key}>
                  <tr onClick={() => setOpen(open === r.key ? null : r.key)} style={{ cursor: "pointer" }}>
                    <td style={{ fontWeight: 600 }}>{open === r.key ? "▾" : "▸"} {r.name}</td>
                    <Cells r={r} />
                  </tr>
                  {open === r.key && (r.managers.length
                    ? r.managers.map((m) => (
                      <tr key={m.key} style={{ background: "var(--surface-2, rgba(127,127,127,0.05))" }}>
                        <td style={{ paddingLeft: 24 }}>{m.name}</td>
                        <Cells r={m} />
                      </tr>))
                    : <tr><td colSpan={8} style={{ paddingLeft: 24, color: MUTED, fontSize: 12 }}>менеджерів у цьому рядку немає — гроші без закріпленого менеджера</td></tr>)}
                </Fragment>
              ))}
              <tr style={{ borderTop: "2px solid var(--border)", background: "var(--bg, #f6f6f7)" }}>
                <td style={{ fontWeight: 700 }}>Σ Відділ</td>
                <Cells r={dept} bold />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 12, color: MUTED, marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(["closed", "real", "risk", "no"] as const).map((k) => (
          <span key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 600, padding: "0 6px", borderRadius: 10, background: TONE[k].bg, color: TONE[k].fg }}>{CLOSE_LABEL[k]}</span>
            {k === "closed" ? "факт уже не менший за план тижня" : k === "real" ? "вистачить до половини очікуваних оплат" : k === "risk" ? "має прийти 50–85% очікуваного" : "треба понад 85% або навіть усього очікуваного не вистачає"}
            {k !== "no" && " ·"}
          </span>
        ))}
      </div>
    </div>
  );
}
