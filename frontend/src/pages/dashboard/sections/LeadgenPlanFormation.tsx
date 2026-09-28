import { useEffect, useState } from "react";
import {
  fetchLeadgenPlans, submitLeadgenPlan, approveLeadgenPlan, returnLeadgenPlan,
  type LgPlanFormation, type LgPlanMember, type LgPlanMetric,
} from "../../../api";
import { ST, ProcessLegend } from "./PlanFormationSection";

const GREEN = "#16a34a", RED = "#dc2626", AMBER = "#d97706", BAR = "#2f6fdb", MUTED = "var(--text-muted)";
const MN = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const MN_FULL = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const title = (ym: string) => `${MN_FULL[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dm = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const shift = (ym: string, k: number) => {
  const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const METRICS: { k: LgPlanMetric; label: string }[] = [
  { k: "leads", label: "Ліди" }, { k: "opr", label: "ОПР" }, { k: "quotes", label: "Прорахунки" },
];

/**
 * 📋 ФОРМУВАННЯ ПЛАНУ ЛІДГЕНІВ — ДЗЕРКАЛО «Формування плану» продажів (рішення власника 25.09.2026).
 *
 * Ті самі стани й кольори (`ST`, `ProcessLegend` з `PlanFormationSection`): тімлід вводить ліди · ОПР ·
 * прорахунки на місяць і подає (● Чернетка → ⏳ На затвердженні); адмін-рівень (КВП, ОД, СЕО, адмін,
 * фінансист) затверджує (✓ — план стає живим на екрані) або повертає з коментарем (↩). Повторне подання
 * й повернення НЕ скасовують попередній затверджений план — він діє, поки новий на розгляді.
 * Поруч — факт трьох попередніх місяців і цього, тими самими лічильниками, що на екрані (рекомендації
 * немає: формули для лідгенів власник не давав, вигадувати не будемо).
 */
export function LeadgenPlanFormation({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<LgPlanFormation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMonth(initialMonth); }, [initialMonth]);
  useEffect(() => {
    if (!open) return;
    let alive = true; setErr(null);
    fetchLeadgenPlans(month).then((d) => alive && setData(d)).catch(() => alive && setErr("Не вдалося завантажити плани лідгенів."));
    return () => { alive = false; };
  }, [month, reload, open]);
  const refresh = () => setReload((x) => x + 1);
  const approveAll = async () => {
    setBusy(true);
    try { await approveLeadgenPlan({ month }); refresh(); } catch { setErr("Не вдалося затвердити подані."); } finally { setBusy(false); }
  };
  const nav: React.CSSProperties = { padding: "6px 11px", borderRadius: 7, border: "none", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 700 };

  return (
    <details className="chart-card" style={{ marginTop: 16 }} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontWeight: 650 }}>
        📋 Плани лідгенів · {title(month)}
        {data && data.month.slice(0, 7) === month && (
          <span style={{ fontWeight: 400, color: MUTED, fontSize: 13 }}> · затверджено {data.approvedCount} з {data.members.length} · на затвердженні {data.submitted}</span>
        )}
      </summary>
      <div style={{ color: MUTED, fontSize: 13, margin: "10px 0", lineHeight: 1.5 }}>
        План на місяць: <b>ліди</b> (входи в «Взято в роботу»), <b>ОПР</b>, <b>прорахунки</b> — ті самі лічильники, що вгорі.
        Виконання на рядку лідгена — <b>прорахунки ÷ план</b>. <b>Тімлід формує і подає, КВП / адмін затверджує або повертає</b>;
        живим стає лише затверджений план. Плани ставляться лише активним учасникам команди «Лідогенерація».
      </div>
      <ProcessLegend />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "12px 0" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 10 }}>
          <button onClick={() => setMonth(shift(month, -1))} style={nav}>◀</button>
          <span style={{ fontWeight: 700, fontSize: 14, minWidth: 120, textAlign: "center" }}>{title(month)}</span>
          <button onClick={() => setMonth(shift(month, 1))} style={nav}>▶</button>
        </div>
        {data?.canApprove && data.submitted > 0 && (
          <button onClick={approveAll} disabled={busy}
            style={{ marginLeft: "auto", padding: "9px 16px", borderRadius: 10, border: "none", cursor: "pointer", background: GREEN, color: "#fff", fontWeight: 700 }}>
            {busy ? "…" : `✓ Затвердити подані (${data.submitted})`}
          </button>
        )}
      </div>
      {err && <p role="alert" style={{ color: RED }}>{err}</p>}
      {open && !data && !err && <p style={{ color: MUTED }}>Завантаження…</p>}
      {data && data.members.length === 0 && (
        <p style={{ color: MUTED }}>
          {data.scopedTo != null ? "У вашій команді немає активних учасників «Лідогенерації» — плани ставляться лише їм."
            : "У команді «Лідогенерація» ще немає активних учасників. Людей у команду переводить адмін у Налаштуваннях → «Команди»."}
        </p>
      )}
      {data && data.month.slice(0, 7) === month && data.members.map((m) => (
        <MemberCard key={m.managerId} m={m} month={month} canApprove={data.canApprove} onChanged={refresh} />
      ))}
    </details>
  );
}

function MemberCard({ m, month, canApprove, onChanged }: { m: LgPlanMember; month: string; canApprove: boolean; onChanged: () => void }) {
  const st = ST[m.status];
  const start = (k: LgPlanMetric) => { const v = m.proposed[k] ?? m.approved[k]; return v == null ? "" : String(v); };
  const [vals, setVals] = useState<Record<LgPlanMetric, string>>({ leads: start("leads"), opr: start("opr"), quotes: start("quotes") });
  useEffect(() => { setVals({ leads: start("leads"), opr: start("opr"), quotes: start("quotes") }); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.proposed.leads, m.proposed.opr, m.proposed.quotes, m.approved.leads, m.approved.opr, m.approved.quotes]);
  const [comment, setComment] = useState("");
  const [returning, setReturning] = useState(false);
  const [retComment, setRetComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const num = (k: LgPlanMetric) => Number(vals[k]);
  const filled = METRICS.every(({ k }) => vals[k].trim() !== "" && Number.isInteger(num(k)) && num(k) >= 0);
  /** Помилка сервера — видимим рядком (урок боргу 15 продажів: німа кнопка читається як поломка). */
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); } catch (e) {
      const r = (e as { response?: { status?: number; data?: { error?: unknown } } }).response;
      const raw = r?.data?.error;
      setErr(typeof raw === "string" ? raw : r?.status ? `Сервер відмовив (код ${r.status}).` : "Не вдалося звʼязатися з сервером.");
    } finally { setBusy(false); }
  };
  const body = () => ({ managerId: m.managerId, month, leads: num("leads"), opr: num("opr"), quotes: num("quotes"), comment: comment || m.comment || undefined });
  const doSubmit = () => guard(async () => { await submitLeadgenPlan(body()); });
  const same = METRICS.every(({ k }) => m.proposed[k] === num(k));
  const doApprove = () => guard(async () => {
    if (m.status !== "submitted" || !same) await submitLeadgenPlan(body());
    await approveLeadgenPlan({ managerId: m.managerId, month });
  });
  const doReturn = () => guard(async () => { await returnLeadgenPlan(m.managerId, month, retComment || undefined); setReturning(false); });

  const btn = (label: string, color: string, onClick: () => void, solid = true, off = false) => (
    <button onClick={onClick} disabled={busy || off} title={off ? "Заповніть усі три числа (цілі, від 0)" : undefined}
      style={{ padding: "8px 13px", borderRadius: 9, border: solid ? "none" : `1px solid ${color}`, cursor: off ? "not-allowed" : "pointer",
        background: off ? "var(--bg)" : solid ? color : "transparent", color: off ? MUTED : solid ? "#fff" : color, fontWeight: 700, fontSize: 13 }}>
      {busy ? "…" : label}
    </button>
  );
  const editable = (m.canSubmit && (m.status === "draft" || m.status === "returned")) || (canApprove && (m.status === "submitted" || m.status === "approved"));
  const cellHead: React.CSSProperties = { padding: "4px 8px", fontSize: 11, color: MUTED, fontWeight: 600, textAlign: "right", whiteSpace: "nowrap" };
  const cell: React.CSSProperties = { padding: "4px 8px", fontSize: 13, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ border: "1px solid var(--border)", borderLeft: `4px solid ${st.c}`, borderRadius: 12, marginTop: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <b style={{ fontSize: 15 }}>{m.name}</b>
        <span style={{ display: "inline-flex", gap: 6, fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: st.c + "22", color: st.c }}>
          <span>{st.icon}</span>{st.label}
        </span>
        {m.approved.quotes != null && (
          <span style={{ fontSize: 12, color: GREEN }}>діє: ліди {m.approved.leads} · ОПР {m.approved.opr} · прорахунки {m.approved.quotes}</span>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...cellHead, textAlign: "left" }} />
              {m.history.map((h, i) => <th key={h.month} style={cellHead}>{MN[Number(h.month.slice(5, 7)) - 1]}{i === m.history.length - 1 ? " (факт зараз)" : ""}</th>)}
              <th style={{ ...cellHead, color: BAR }}>План {MN[Number(month.slice(5, 7)) - 1]}</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map(({ k, label }) => (
              <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ ...cell, textAlign: "left", fontWeight: 600 }}>{label}</td>
                {m.history.map((h) => <td key={h.month} style={{ ...cell, color: MUTED }}>{h[k].toLocaleString("uk-UA")}</td>)}
                <td style={cell}>
                  {editable ? (
                    <input value={vals[k]} inputMode="numeric" onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value.replace(/[^\d]/g, "") }))}
                      aria-label={`${label}: план на ${title(month)}`}
                      style={{ width: 80, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontWeight: 700, textAlign: "right" }} />
                  ) : <b>{m.proposed[k] ?? m.approved[k] ?? "—"}</b>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(m.status === "submitted" || m.status === "approved") && (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
          {m.comment && <span style={{ fontStyle: "italic", color: "var(--text)" }}>«{m.comment}» · </span>}
          {m.submittedBy}{m.submittedAt ? ` · подав ${dm(m.submittedAt)}` : ""}{m.status === "approved" && m.decidedBy ? ` · затвердив ${m.decidedBy} ${dm(m.decidedAt)}` : ""}
        </div>
      )}
      {m.status === "returned" && (
        <div style={{ background: RED + "10", border: `1px solid ${RED}44`, borderRadius: 10, padding: "8px 11px", marginTop: 8, fontSize: 12.5 }}>
          <b style={{ color: RED }}>↩ Повернуто</b>{m.decidedBy ? ` · ${m.decidedBy}` : ""}{m.decidedAt ? ` · ${dm(m.decidedAt)}` : ""}
          {m.returnComment && <span style={{ fontStyle: "italic" }}> · «{m.returnComment}»</span>}
          {m.approved.quotes != null && <span style={{ color: MUTED }}> · діє попередній затверджений план</span>}
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {returning ? (
          <>
            <input value={retComment} onChange={(e) => setRetComment(e.target.value)} placeholder="Причина повернення…"
              style={{ flex: 1, minWidth: 200, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
            {btn("↩ Повернути тімліду", RED, doReturn)}
            <button onClick={() => setReturning(false)} style={{ padding: "8px 13px", borderRadius: 9, border: "1px solid var(--border)", background: "transparent", color: MUTED, cursor: "pointer" }}>Скасувати</button>
          </>
        ) : (
          <>
            {m.canSubmit && (m.status === "draft" || m.status === "returned") && (
              <>
                <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Обґрунтування (необовʼязково)…"
                  style={{ flex: 1, minWidth: 200, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 12.5 }} />
                {btn(m.status === "returned" ? "↑ Подати знову" : "Подати", m.status === "returned" ? RED : BAR, doSubmit, true, !filled)}
              </>
            )}
            {m.status === "submitted" && canApprove && <>{btn("✓ Затвердити", GREEN, doApprove, true, !filled)}{btn("↩ Повернути", RED, () => setReturning(true), false)}</>}
            {m.status === "submitted" && !canApprove && <span style={{ fontSize: 12.5, color: AMBER }}>⏳ подано · очікує рішення КВП</span>}
            {m.status === "approved" && canApprove && btn("Змінити", MUTED, doApprove, false, !filled)}
            {m.status === "approved" && !canApprove && <span style={{ fontSize: 12.5, color: GREEN }}>✓ затверджено · діє з 01.{month.slice(5, 7)}</span>}
            {!m.canSubmit && !canApprove && m.status !== "approved" && m.status !== "submitted" && <span style={{ fontSize: 12.5, color: MUTED }}>план формує тімлід</span>}
          </>
        )}
      </div>
      {err && <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: RED }}>⚠️ {err}</div>}
    </div>
  );
}
