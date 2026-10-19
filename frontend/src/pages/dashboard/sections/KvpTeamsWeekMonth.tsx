import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchKvpReport, type KvpReport } from "../../../api";
import { formatAmount } from "../format";
import { InfoHint } from "../widgets";
import { coreRows, weekCloseStatus, closeNote, pctOfPlan, CLOSE_LABEL, prevWeekRange, blocksWithin, coversRange, prevWeekRows, weekResult,
  type CloseKind, type CoreRow, type Money3, type TeamLike, type PlanFact } from "../kvpCoreRules";
import { VacationMark } from "../VacationMark";

/**
 * 🏅 «КОМАНДИ: ТИЖДЕНЬ І МІСЯЦЬ» (задача 5605, ТЗ Юлі 12.10.2026, розділ 3; макет «Звіт КВП - ядро»).
 * Спершу місяць (План · Без очікувань · З очікуваннями), далі тиждень (те саме + «Закриємо?») — порядок за проханням Юлі
 * 16.10.2026: «Жовтень 2026 спочатку, а потім тижні». Між ними — МИНУЛИЙ тиждень (План · Факт · Підсумок; Юля 19.10.2026:
 * «звітую по ньому в понеділок»): календарний Пн–Нд перед поточним, зібраний з блоків обох місяців, якщо він їх
 * перетинає (тоді попередній місяць довантажується окремим запитом). Під сумою —
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

/** Минулий тиждень: План · Факт (% під ним) · Підсумок. `undefined` — дані ще вантажаться; `null` — їх немає. */
function PrevCells({ pf, bold }: { pf: PlanFact | null | undefined; bold?: boolean }) {
  const L = { borderLeft: "1px solid var(--border)" };
  if (pf === undefined) return <><td style={{ ...L, color: MUTED }}>…</td><td /><td /></>;
  if (pf === null || (!pf.plan && !pf.fact)) return <><td style={{ ...L, textAlign: "right", color: MUTED }}>—</td><td style={{ textAlign: "right", color: MUTED }}>—</td><td style={{ color: MUTED, paddingLeft: 16 }}>—</td></>;
  const res = weekResult(pf);
  return (<>
    <td style={{ ...L, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatAmount(pf.plan)}</td>
    <Sum v={pf.fact} plan={pf.plan} bold={bold} />
    <td style={{ paddingLeft: 16, minWidth: 150 }}>
      {res.kind === "none" ? <span style={{ color: MUTED }}>плану не було</span> : <>
        <span style={{ display: "inline-block", fontSize: 12, fontWeight: 600, padding: "1px 8px", borderRadius: 10,
          background: TONE[res.kind === "done" ? "closed" : "no"].bg, color: TONE[res.kind === "done" ? "closed" : "no"].fg }}>{res.kind === "done" ? "Виконано" : "Не виконано"}</span>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{res.kind === "done" ? `+${formatAmount(res.diff)} понад план` : `−${formatAmount(res.diff)} до плану`}</div>
      </>}
    </td>
  </>);
}

function Cells({ r, bold, prev }: { r: Pick<CoreRow, "week" | "month">; bold?: boolean; prev: PlanFact | null | undefined }) {
  return (<>
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatAmount(r.month.plan)}</td>
    <Sum v={r.month.fact} plan={r.month.plan} bold={bold} />
    <Sum v={r.month.withExp} plan={r.month.plan} bold={bold} />
    <PrevCells pf={prev} bold={bold} />
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", borderLeft: "1px solid var(--border)" }}>{formatAmount(r.week.plan)}</td>
    <Sum v={r.week.fact} plan={r.week.plan} bold={bold} />
    <Sum v={r.week.withExp} plan={r.week.plan} bold={bold} />
    <Status w={r.week} />
  </>);
}

export function KvpTeamsWeekMonth({ rep }: { rep: KvpReport }) {
  const [open, setOpen] = useState<string | null>(null);
  const blk = rep.weekBlocks.find((b) => b.isCurrent) ?? [...rep.weekBlocks].reverse().find((b) => !b.isFuture) ?? null;
  const { rows, dept } = coreRows(rep.teams as unknown as TeamLike[], blk?.idx ?? null,
    (t) => t.name || `Без команди · ${kindLabel[t.kind] ?? t.kind}`);
  const monthName = rep.scope.label;

  // 📅 Минулий тиждень: якщо він заходить у попередній місяць — довантажуємо той місяць (той самий звіт, preset «місяць»).
  const prevR = blk && rep.scope.monthAligned ? prevWeekRange(blk.from) : null;
  const firstFrom = rep.weekBlocks[0]?.from ?? rep.scope.from;
  const needPrevMonth = !!prevR && prevR.from < firstFrom;
  const prevMonthFirst = (() => { const d = new Date(`${firstFrom.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
  const [prevRep, setPrevRep] = useState<KvpReport | null | "error">(null);
  useEffect(() => {
    if (!needPrevMonth) return;
    let alive = true; setPrevRep(null);
    fetchKvpReport({ preset: "month", date: prevMonthFirst })
      .then((x) => { if (alive) setPrevRep(x); }).catch(() => { if (alive) setPrevRep("error"); });
    return () => { alive = false; };
  }, [needPrevMonth, prevMonthFirst]);
  const prevPack = useMemo(() => {
    if (!prevR) return null;
    const parts = [{ blocks: rep.weekBlocks, teams: rep.teams as unknown as TeamLike[], idxs: blocksWithin(rep.weekBlocks, prevR) }];
    if (needPrevMonth) {
      if (prevRep === null) return undefined;           // ще вантажиться
      if (prevRep === "error") return null;
      parts.push({ blocks: prevRep.weekBlocks, teams: prevRep.teams as unknown as TeamLike[], idxs: blocksWithin(prevRep.weekBlocks, prevR) });
    }
    // Частину тижня не видно — чесне «немає даних», а не неповна сума.
    if (!coversRange(parts, prevR)) return null;
    return prevWeekRows(parts, (t) => t.name || `Без команди · ${kindLabel[t.kind] ?? t.kind}`);
  }, [prevR?.from, needPrevMonth, prevRep, rep]);
  const prevOf = (key: string, mgrKey?: string): PlanFact | null | undefined => {
    if (prevPack === undefined) return undefined;
    if (prevPack === null) return null;
    const x = prevPack.rows.get(key);
    if (!mgrKey) return x ?? { plan: 0, fact: 0 };
    return x?.managers.get(mgrKey) ?? { plan: 0, fact: 0 };
  };
  // Команди, що мали гроші чи план минулого тижня, але не мають рядка цього місяця (напр., лише у вересні), — окремими рядками.
  const prevOnly = prevPack ? [...prevPack.rows.entries()].filter(([k]) => !rows.some((r) => r.key === k)) : [];
  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <h2 className="chart-title" style={{ marginBottom: 2 }}>🏅 Команди: тиждень і місяць
        <InfoHint text="Без очікувань — гроші, що вже прийшли (отримані кошти, як у картці вгорі). З очікуваннями — плюс оплати з плановою датою оплати в цьому тижні чи місяці. План тижня — той самий динамічний план, що на Звіті. Клік по команді — менеджери." /></h2>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>без очікувань — гроші, що вже прийшли; з очікуваннями — плюс оплати з плановою датою в цьому тижні або місяці. Клік по команді — менеджери</div>
      {!blk ? <p style={{ color: MUTED, fontSize: 13 }}>Тижні рахуються лише для одного календарного місяця — оберіть «Місяць».</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ minWidth: 1180 }}>
            <thead>
              <tr>
                <th rowSpan={2} style={{ verticalAlign: "bottom" }}>Команда</th>
                <th colSpan={3} style={{ textAlign: "center" }}>{monthName}</th>
                <th colSpan={3} style={{ textAlign: "center", borderLeft: "1px solid var(--border)" }}>{prevR ? `Минулий тиждень ${ddmm(prevR.from)}–${ddmm(prevR.to)}` : "Минулий тиждень"}</th>
                <th colSpan={4} style={{ textAlign: "center", borderLeft: "1px solid var(--border)" }}>Тиждень {blk.from.slice(8, 10)}–{ddmm(blk.to)}</th>
              </tr>
              <tr>
                <th style={{ textAlign: "right" }}>План</th>
                <th style={{ textAlign: "right" }}>Без очікувань</th><th style={{ textAlign: "right" }}>З очікуваннями</th>
                <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>План</th><th style={{ textAlign: "right" }}>Факт</th><th style={{ paddingLeft: 16 }}>Підсумок</th>
                <th style={{ textAlign: "right", borderLeft: "1px solid var(--border)" }}>План</th><th style={{ textAlign: "right" }}>Без очікувань</th>
                <th style={{ textAlign: "right" }}>З очікуваннями</th><th style={{ paddingLeft: 16 }}>Закриємо?</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.key}>
                  <tr onClick={() => setOpen(open === r.key ? null : r.key)} style={{ cursor: "pointer" }}>
                    <td style={{ fontWeight: 600 }}>{open === r.key ? "▾" : "▸"} {r.name}</td>
                    <Cells r={r} prev={prevOf(r.key)} />
                  </tr>
                  {open === r.key && (r.managers.length
                    ? r.managers.map((m) => (
                      <tr key={m.key} style={{ background: "var(--surface-2, rgba(127,127,127,0.05))" }}>
                        <td style={{ paddingLeft: 24 }}>{m.name}<VacationMark managerId={m.key.startsWith("m:") ? Number(m.key.slice(2)) : null} /></td>
                        <Cells r={m} prev={prevOf(r.key, m.key)} />
                      </tr>))
                    : <tr><td colSpan={11} style={{ paddingLeft: 24, color: MUTED, fontSize: 12 }}>менеджерів у цьому рядку немає — гроші без закріпленого менеджера</td></tr>)}
                </Fragment>
              ))}
              {prevOnly.map(([k, x]) => (
                <tr key={`prev-${k}`}>
                  <td style={{ fontWeight: 600, color: MUTED }}>{x.name}</td>
                  <Cells r={{ week: { plan: 0, fact: 0, withExp: 0 }, month: { plan: 0, fact: 0, withExp: 0 } }} prev={x} />
                </tr>
              ))}
              <tr style={{ borderTop: "2px solid var(--border)", background: "var(--bg, #f6f6f7)" }}>
                <td style={{ fontWeight: 700 }}>Σ Відділ</td>
                <Cells r={dept} bold prev={prevPack === undefined ? undefined : prevPack === null ? null : prevPack.dept} />
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
