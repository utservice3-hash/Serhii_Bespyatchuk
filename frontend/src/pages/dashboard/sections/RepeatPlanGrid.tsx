import { Fragment, useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { fetchRepeatPlansGrid, saveRepeatPlan, saveRepeatClientPlan, approveRepeatClientPlan, approveAllRepeatClientPlans, fetchRepeatClientPlanHistory, fetchRepeatClientHistory, type RepeatPlansGrid, type RepeatClientPlan, type RepeatClientPlanHistoryEntry, type RepeatClientHistory, type Team } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { teamOptions } from "../teamColors";
import { CommentField } from "../../../components/CommentField";

/** Історія змін плану по одному клієнту (хто/коли/дія/план/статус). */
function PlanHistoryModal({ clientKey, clientName, month, onClose }: { clientKey: string; clientName: string; month: string; onClose: () => void }) {
  const [rows, setRows] = useState<RepeatClientPlanHistoryEntry[] | null>(null);
  useEffect(() => { fetchRepeatClientPlanHistory(clientKey, month).then(setRows).catch(() => setRows([])); }, [clientKey, month]);
  const actLabel: Record<string, string> = { save: "✏️ Зміна плану", approve: "✓ Затвердження" };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2100, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 20, width: "90vw", maxWidth: 560, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 className="chart-title" style={{ marginBottom: 0 }}>🕘 Історія плану · {clientName}</h3>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>
        {rows === null ? <p className="loading-text">Завантаження…</p> : rows.length === 0 ? (
          <p className="loading-text" style={{ margin: 0 }}>Змін ще не було.</p>
        ) : (
          <table className="data-table compact" style={{ fontSize: 12 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Коли</th><th style={{ textAlign: "left" }}>Хто</th><th>Дія</th><th style={{ textAlign: "right" }}>План</th><th>Статус</th></tr></thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(h.changedAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{h.who ?? "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{actLabel[h.action] ?? h.action}</td>
                  <td style={{ textAlign: "right" }}>{h.plan != null ? formatAmount(h.plan) : "—"}</td>
                  <td style={{ whiteSpace: "nowrap", color: h.status === "approved" ? "#16a34a" : h.status === "pending" ? "#d97706" : "var(--text-muted)" }}>
                    {h.status === "approved" ? "✓ затв." : h.status === "pending" ? "⏳ надіслано" : h.status ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Плитка клієнта: графік піків/падінь замовлень (виручка помісячно, 13 міс) +
 * коротка історія + «план з викликом» (+12%), який можна одразу застосувати. */
function ClientHistoryModal({ clientKey, clientName, onApply, onClose }: {
  clientKey: string; clientName: string; onApply: (plan: number) => void; onClose: () => void;
}) {
  const [data, setData] = useState<RepeatClientHistory | null>(null);
  useEffect(() => { fetchRepeatClientHistory(clientKey).then(setData).catch(() => setData({ history: [], avgRecent: 0, suggestedPlan: 0 })); }, [clientKey]);
  const chart = (data?.history ?? []).map((h) => ({ ...h, label: h.month.slice(2) }));
  const maxRev = Math.max(1, ...chart.map((h) => h.revenue));
  const recent = (data?.history ?? []).filter((h) => h.revenue > 0).slice(-3);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2100, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 20, width: "92vw", maxWidth: 620, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 className="chart-title" style={{ marginBottom: 0 }}>📊 Замовлення клієнта · {clientName}</h3>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>
        {data === null ? <p className="loading-text">Завантаження…</p> : chart.length === 0 ? (
          <p className="loading-text" style={{ margin: 0 }}>Немає оплат за останні 13 місяців.</p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                <XAxis dataKey="label" fontSize={11} />
                <YAxis fontSize={11} width={54} tickFormatter={(v) => formatAmount(v as number)} />
                <Tooltip formatter={(v, n) => [n === "revenue" ? formatAmountFull(v as number) : v, n === "revenue" ? "Виручка" : "Замовлень"]} />
                <Bar dataKey="revenue" radius={[3, 3, 0, 0]}>
                  {chart.map((h, i) => (
                    <Cell key={i} fill={h.revenue >= maxRev * 0.85 ? "#16a34a" : h.revenue <= maxRev * 0.3 ? "#dc2626" : "#c8102e"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0 4px" }}>
              🟢 пік · 🔴 падіння. Останні місяці з оплатами:{" "}
              {recent.map((h) => `${h.month.slice(2)}: ${formatAmount(h.revenue)} (${h.orders})`).join(" · ") || "—"}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "var(--bg-subtle, rgba(127,127,127,0.06))" }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Середнє (3 міс)</div>
                <div style={{ fontWeight: 700 }}>{formatAmount(data.avgRecent)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>💪 План з викликом (+12%)</div>
                <div style={{ fontWeight: 700, color: "#16a34a" }}>{formatAmount(data.suggestedPlan)}</div>
              </div>
              {data.suggestedPlan > 0 && (
                <button onClick={() => { onApply(data.suggestedPlan); onClose(); }}
                  style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                  Застосувати план з викликом
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

const FORECASTS = [
  { value: "", label: "—" },
  { value: "same", label: "такий самий" },
  { value: "up", label: "збільшиться" },
  { value: "down", label: "зменшиться" },
];
const cellInput: React.CSSProperties = { width: "100%", padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 12 };

/** One editable per-client plan row (matches the КВП sheet): monthly plan (auto
 * weekly split), auto fact, and metadata (forecast, realization %, international,
 * we-do, call link, comment). The whole row is sent on save so nothing is lost. */
const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  pending: { label: "⏳ на затвердженні", color: "#d97706" },
  approved: { label: "✓ затверджено", color: "#16a34a" },
  none: { label: "— без плану", color: "var(--text-muted)" },
};

function ClientPlanRow({ client, month, managerId, weekPlan, role, onSaved, onHistory }: {
  client: RepeatClientPlan; month: string; managerId: number; weekPlan: number[]; role: string; onSaved: () => void; onHistory: (c: RepeatClientPlan) => void;
}) {
  const canApprove = role === "admin" || role === "team_lead";
  const [approving, setApproving] = useState(false);
  const approve = async () => {
    setApproving(true);
    try { await approveRepeatClientPlan(client.clientKey, month, "approved"); onSaved(); }
    finally { setApproving(false); }
  };
  const [d, setD] = useState({
    plan: client.plan ? String(client.plan) : "",
    forecast: client.forecast ?? "",
    realizationPct: client.realizationPct != null ? String(client.realizationPct) : "",
    international: client.international,
    weDo: client.weDo,
    callLink: client.callLink ?? "",
    comment: client.comment ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const planNum = Number(d.plan.replace(/[^\d.-]/g, "")) || 0;
  const dirty =
    planNum !== client.plan ||
    (d.forecast || null) !== (client.forecast || null) ||
    (d.realizationPct === "" ? null : Number(d.realizationPct)) !== client.realizationPct ||
    d.international !== client.international ||
    d.weDo !== client.weDo ||
    (d.callLink || null) !== (client.callLink || null) ||
    (d.comment || null) !== (client.comment || null);

  const save = async () => {
    setSaving(true);
    try {
      await saveRepeatClientPlan({
        clientKey: client.clientKey, month, managerId,
        plan: planNum,
        forecast: d.forecast || null,
        realizationPct: d.realizationPct === "" ? null : Number(d.realizationPct),
        international: d.international,
        weDo: d.weDo,
        callLink: d.callLink || null,
        comment: d.comment || null,
      });
      onSaved();
    } finally { setSaving(false); }
  };

  const remaining = Math.max(0, planNum - client.fact);
  const tri = (v: boolean | null, set: (x: boolean | null) => void) => (
    <select value={v == null ? "" : v ? "yes" : "no"} onChange={(e) => set(e.target.value === "" ? null : e.target.value === "yes")} style={cellInput}>
      <option value="">—</option><option value="yes">так</option><option value="no">ні</option>
    </select>
  );
  return (
    <tr>
      <td style={{ textAlign: "left", whiteSpace: "nowrap", opacity: client.inactive ? 0.6 : 1 }}>
        {client.inactive && <span title="Давно не замовляв (замовклий)">💤 </span>}{client.clientName}
        <button onClick={() => setHistOpen(true)} title="Історія замовлень (піки/падіння) + план з викликом"
          style={{ marginLeft: 6, border: "none", background: "none", cursor: "pointer", fontSize: 13, padding: 0 }}>📊</button>
        {histOpen && (
          <ClientHistoryModal clientKey={client.clientKey} clientName={client.clientName}
            onApply={(p) => setD((s) => ({ ...s, plan: String(p) }))} onClose={() => setHistOpen(false)} />
        )}
      </td>
      <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{client.isCompany ? "🏢" : `👤${client.identifier ? " " + client.identifier : ""}`}</td>
      <td style={{ textAlign: "right" }}>{client.orders}</td>
      <td style={{ textAlign: "right", fontWeight: 600 }} title={`Остання оплата: ${client.lastPaid ? new Date(client.lastPaid).toLocaleDateString("uk-UA") : "—"} · ${formatAmountFull(client.revenue)}`}>{formatAmount(client.revenue)}</td>
      <td style={{ whiteSpace: "nowrap", color: "var(--text-muted)" }} title="Остання реальна активність (дзвінок/нотатка)">{client.lastActivity ? new Date(client.lastActivity).toLocaleDateString("uk-UA") : "—"}</td>
      <td><input value={d.plan} onChange={(e) => setD((s) => ({ ...s, plan: e.target.value }))} inputMode="numeric" placeholder="0" style={{ ...cellInput, textAlign: "right", width: 80 }} /></td>
      <td style={{ textAlign: "right", color: "#16a34a", fontWeight: 600 }} title={formatAmountFull(client.fact)}>{formatAmount(client.fact)}</td>
      <td style={{ textAlign: "right", color: "#d97706" }}>{formatAmount(remaining)}</td>
      {weekPlan.map((wp, i) => (
        <Fragment key={i}>
          <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(wp)}</td>
          <td style={{ textAlign: "right", color: "#16a34a" }} title={formatAmountFull(client.weekFact[i] ?? 0)}>{formatAmount(client.weekFact[i] ?? 0)}</td>
        </Fragment>
      ))}
      <td style={{ minWidth: 110 }}>
        <select value={d.forecast} onChange={(e) => setD((s) => ({ ...s, forecast: e.target.value }))} style={cellInput}>
          {FORECASTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </td>
      <td style={{ width: 60 }}><input value={d.realizationPct} onChange={(e) => setD((s) => ({ ...s, realizationPct: e.target.value }))} inputMode="numeric" placeholder="%" style={{ ...cellInput, textAlign: "right" }} /></td>
      <td style={{ width: 60 }}>{tri(d.international, (x) => setD((s) => ({ ...s, international: x })))}</td>
      <td style={{ width: 60 }}>{tri(d.weDo, (x) => setD((s) => ({ ...s, weDo: x })))}</td>
      <td style={{ minWidth: 120 }}>
        {d.callLink && /^https?:\/\//.test(d.callLink)
          ? <a href={d.callLink} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>🔗</a> : null}
        <input value={d.callLink} onChange={(e) => setD((s) => ({ ...s, callLink: e.target.value }))} placeholder="лінк" style={cellInput} />
      </td>
      <td style={{ minWidth: 180, verticalAlign: "top" }}>
        <CommentField value={d.comment} onSave={(next) => setD((s) => ({ ...s, comment: next }))} />
      </td>
      <td style={{ minWidth: 130, whiteSpace: "nowrap" }}>
        {dirty ? (
          <button onClick={save} disabled={saving} title={role === "manager" ? "Надіслати на затвердження" : "Зберегти"}
            style={{ padding: "3px 8px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12 }}>
            {saving ? "…" : role === "manager" ? "Надіслати" : "Зберегти"}
          </button>
        ) : (
          <>
            <span style={{ fontSize: 11, color: STATUS_BADGE[client.status]?.color ?? "var(--text-muted)" }}>{STATUS_BADGE[client.status]?.label ?? ""}</span>
            {canApprove && client.status === "pending" && (
              <button onClick={approve} disabled={approving} title="Затвердити план"
                style={{ marginLeft: 6, padding: "3px 8px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                {approving ? "…" : "Затвердити"}
              </button>
            )}
            {canApprove && (
              <button onClick={() => onHistory(client)} title="Історія змін плану"
                style={{ marginLeft: 6, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>
                🕘
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Repeat-client revenue plan: each month a team lead sets, per manager, the sum
 * that must be earned FROM regular clients. Fact is auto-filled from CRM
 * (received money whose client has 2+ lifetime paid orders); the remaining
 * target (план − факт) is decomposed dynamically across the month's remaining
 * working days, so weekly/daily goals shrink as the manager earns.
 */
export function RepeatPlanGrid({ canPickTeam, teams, role }: { canPickTeam: boolean; teams: Team[]; role: string }) {
  const [month, setMonth] = useState<string>(() => localStorage.getItem("repeatPlansMonth") || curMonthStr());
  const [teamId, setTeamId] = useState<number | "">(() => {
    const v = localStorage.getItem("repeatPlansTeam");
    return v ? Number(v) : "";
  });
  const [grid, setGrid] = useState<RepeatPlansGrid | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleMgr = (id: number) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [historyClient, setHistoryClient] = useState<RepeatClientPlan | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const canApprove = role === "admin" || role === "team_lead";

  // Скільки планів очікують затвердження в поточному зрізі (для «схвалити всі»).
  const pendingCount = useMemo(() => {
    if (!grid) return 0;
    let n = 0;
    for (const t of grid.teams) for (const m of t.managers) for (const c of m.clients) if (c.status === "pending") n++;
    return n;
  }, [grid]);

  const approveAll = async () => {
    setApprovingAll(true);
    try {
      await approveAllRepeatClientPlans(month, teamId ? Number(teamId) : undefined);
      setReload((n) => n + 1);
    } catch {
      setErr("Не вдалося затвердити всі плани.");
    } finally {
      setApprovingAll(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setGrid(null);
    fetchRepeatPlansGrid(month, teamId ? Number(teamId) : undefined, includeInactive)
      .then((g) => { if (alive) { setGrid(g); setDrafts({}); } })
      .catch(() => { if (alive) setErr("Не вдалося завантажити плани."); });
    return () => { alive = false; };
  }, [month, teamId, reload, open, includeInactive]);

  const setMonthP = (v: string) => { if (!v) return; setMonth(v); localStorage.setItem("repeatPlansMonth", v); };
  const shiftMonth = (d: number) => {
    const [y, m] = month.split("-").map(Number);
    const nd = new Date(y, m - 1 + d, 1);
    setMonthP(`${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}`);
  };

  const save = async (managerId: number) => {
    const raw = drafts[managerId];
    if (raw == null) return;
    const val = Number(raw.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(val)) return;
    setSavingId(managerId);
    try {
      await saveRepeatPlan(managerId, month, val);
      setReload((n) => n + 1);
    } catch {
      setErr("Не вдалося зберегти план.");
    } finally {
      setSavingId(null);
    }
  };

  // DYNAMIC decomposition — залишок (план − факт) розкидається на РОБОЧІ дні, що
  // ще залишилися до кінця місяця, тож тижневі/денні цілі авто-зменшуються.
  const decomp = useMemo(() => {
    if (!grid) return null;
    const [gy, gm] = grid.month.split("-").map(Number);
    const now = new Date();
    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const isPast = grid.month < curKey, isFuture = grid.month > curKey;
    const todayDay = now.getDate();
    const futureDay = (d: number) => (isPast ? false : isFuture ? true : d >= todayDay);
    const isWD = (d: number) => { const dow = new Date(gy, gm - 1, d).getDay(); return dow !== 0 && dow !== 6; };
    const futureWDInWeek = (w: { from: number; to: number }) => { let n = 0; for (let d = w.from; d <= w.to; d++) if (isWD(d) && futureDay(d)) n++; return n; };
    let remWD = 0, elapsedWD = 0;
    for (let d = 1; d <= grid.daysInMonth; d++) {
      if (!isWD(d)) continue;
      if (futureDay(d)) remWD++;
      const passed = isPast ? true : isFuture ? false : d <= todayDay;
      if (passed) elapsedWD++;
    }
    const totalWD = grid.workingDays;
    return (plan: number, fact: number) => {
      const remaining = Math.max(0, plan - fact);
      const planToDate = totalWD > 0 ? Math.round((plan * elapsedWD) / totalWD) : 0;
      const lag = Math.round(planToDate - fact);
      return {
        remaining,
        lag,
        perDay: remWD > 0 ? Math.round(remaining / remWD) : 0,
        perWeek: grid.weeks.map((w) => (remWD > 0 ? Math.round((remaining * futureWDInWeek(w)) / remWD) : 0)),
      };
    };
  }, [grid]);

  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "var(--text)" }}
        >
          {open ? "▾" : "▸"} 🎯 План по постійних клієнтах (виручка з постійних)
        </button>
        {open && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {canApprove && pendingCount > 0 && (
              <button onClick={approveAll} disabled={approvingAll} title="Затвердити всі плани, що очікують"
                style={{ padding: "6px 12px", borderRadius: 10, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>
                {approvingAll ? "…" : `✓ Схвалити всі (${pendingCount})`}
              </button>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", cursor: "pointer", whiteSpace: "nowrap" }} title="Показати клієнтів, що давно не замовляли (замовклі)">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              💤 замовклі
            </label>
            {canPickTeam && (
              <select value={teamId} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : ""; setTeamId(v); localStorage.setItem("repeatPlansTeam", v ? String(v) : ""); }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
                <option value="">Усі команди</option>
                {teamOptions(teams)}
              </select>
            )}
            <button onClick={() => shiftMonth(-1)} title="Попередній місяць"
              style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>←</button>
            <DatePicker mode="month" value={month} onChange={(v) => v && setMonthP(v)} minWidth={140} />
            <button onClick={() => shiftMonth(1)} title="Наступний місяць"
              style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>→</button>
          </div>
        )}
      </div>

      {open && (
        <>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 12px", maxWidth: 860 }}>
            План по кожному постійному клієнту ставить <b>менеджер</b> (розкрий себе → «Надіслати»), а <b>тімлід затверджує</b> (кнопка «Затвердити» у статусі ⏳). <b>Факт</b> заповнюється авто з CRM: отримані кошти (успішно 142 + оплата отримана) від клієнтів із 2+ оплаченими перевезеннями. <b>Тижні/день — динамічні</b>: залишок (план − факт) розкидається на майбутні робочі дні. Клієнт зʼявляється <b>автоматично</b>, щойно має 2+ оплати.
          </p>
          {err && <p className="loading-text" style={{ color: "#dc2626" }}>{err}</p>}
          {!grid && !err && <p className="loading-text">Завантаження…</p>}
          {grid && decomp && (() => {
            const sub = "var(--bg-subtle, rgba(127,127,127,0.08))";
            return (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table compact" style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Менеджер</th>
                      <th style={{ textAlign: "right" }}>План<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>статичний</div></th>
                      <th style={{ textAlign: "right" }}>Факт<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>з постійних</div></th>
                      <th style={{ textAlign: "right" }}>Залишок</th>
                      <th style={{ textAlign: "right" }}>Відставання<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>план сьогодні − факт</div></th>
                      {grid.weeks.map((w) => (
                        <th key={w.label} style={{ textAlign: "right" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{w.from}–{w.to}</div></th>
                      ))}
                      <th style={{ textAlign: "right" }}>На день</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.teams.map((team) => {
                      const td = decomp(team.teamPlan, team.teamFact);
                      return (
                        <Fragment key={team.teamId}>
                          <tr>
                            <td style={{ fontWeight: 700, background: sub }}>{team.teamName}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub }}>{formatAmount(team.teamPlan)}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: "#16a34a" }}>{formatAmount(team.teamFact)}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: "#d97706" }}>{formatAmount(td.remaining)}</td>
                            <td style={{ fontWeight: 700, textAlign: "right", background: sub, color: td.lag > 0 ? "#dc2626" : "#16a34a" }}>{td.lag > 0 ? formatAmount(td.lag) : "✓"}</td>
                            {td.perWeek.map((v, i) => (
                              <td key={i} style={{ textAlign: "right", fontWeight: 600, background: sub }}>{formatAmount(v)}</td>
                            ))}
                            <td style={{ textAlign: "right", fontWeight: 600, background: sub }}>{formatAmount(td.perDay)}</td>
                          </tr>
                          {team.managers.map((m) => {
                            const d = decomp(m.plan, m.fact);
                            const draft = drafts[m.managerId];
                            const dirty = draft != null && Number(draft.replace(/[^\d.-]/g, "")) !== m.plan;
                            const isOpen = expanded.has(m.managerId);
                            const colSpan = 6 + grid.weeks.length;
                            return (
                              <Fragment key={m.managerId}>
                              <tr>
                                <td style={{ textAlign: "left", paddingLeft: 18 }}>
                                  <button onClick={() => toggleMgr(m.managerId)} title="Показати постійних клієнтів"
                                    style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text)", font: "inherit", padding: 0 }}>
                                    {m.clients.length > 0 ? (isOpen ? "▾ " : "▸ ") : ""}{m.name}
                                    {m.clients.length > 0 && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> ({m.clients.length})</span>}
                                  </button>
                                </td>
                                <td style={{ textAlign: "right" }}>
                                  {role === "manager" ? (
                                    <span style={{ fontWeight: 600 }}>{formatAmount(m.plan)}</span>
                                  ) : (
                                    <>
                                      <input
                                        value={draft ?? String(m.plan)}
                                        onChange={(e) => setDrafts((p) => ({ ...p, [m.managerId]: e.target.value }))}
                                        onKeyDown={(e) => { if (e.key === "Enter") save(m.managerId); }}
                                        inputMode="numeric"
                                        style={{ width: 96, textAlign: "right", padding: "3px 6px", borderRadius: 6, border: `1px solid ${dirty ? "#d97706" : "var(--border)"}`, background: "var(--card-bg)", color: "var(--text)" }}
                                      />
                                      {dirty && (
                                        <button onClick={() => save(m.managerId)} disabled={savingId === m.managerId}
                                          style={{ marginLeft: 4, padding: "3px 8px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                                          {savingId === m.managerId ? "…" : "✓"}
                                        </button>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td style={{ textAlign: "right", color: "#16a34a", fontWeight: 600 }} title={formatAmountFull(m.fact)}>{formatAmount(m.fact)}</td>
                                <td style={{ textAlign: "right", color: "#d97706", fontWeight: 600 }}>{formatAmount(d.remaining)}</td>
                                <td style={{ textAlign: "right", fontWeight: 600, color: d.lag > 0 ? "#dc2626" : "#16a34a" }}>{d.lag > 0 ? formatAmount(d.lag) : "✓"}</td>
                                {d.perWeek.map((v, i) => (
                                  <td key={i} style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(v)}</td>
                                ))}
                                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{formatAmount(d.perDay)}</td>
                              </tr>
                              {isOpen && m.clients.length > 0 && (
                                <tr>
                                  <td colSpan={colSpan} style={{ background: "var(--bg-subtle, rgba(127,127,127,0.05))", padding: "6px 10px 10px 26px" }}>
                                    <div style={{ overflowX: "auto" }}>
                                      <table className="data-table compact" style={{ fontSize: 12, minWidth: 1100 }}>
                                        <thead>
                                          <tr>
                                            <th style={{ textAlign: "left" }}>Постійний клієнт</th>
                                            <th>Тип</th>
                                            <th style={{ textAlign: "right" }}>Поїздок<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>всього</div></th>
                                            <th style={{ textAlign: "right" }}>Напрацював<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>сума lifetime</div></th>
                                            <th>Ост. активність</th>
                                            <th style={{ textAlign: "right" }}>План</th>
                                            <th style={{ textAlign: "right" }}>Факт</th>
                                            <th style={{ textAlign: "right" }}>Залишок</th>
                                            {grid.weeks.map((w) => (
                                              <th key={w.label} colSpan={2} style={{ textAlign: "center" }}>{w.label}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{w.from}–{w.to}</div></th>
                                            ))}
                                            <th>Прогноз обʼєму</th>
                                            <th style={{ textAlign: "right" }}>Реаліз.%</th>
                                            <th>Міжнар.</th>
                                            <th>Возимо</th>
                                            <th>Запис розмови</th>
                                            <th>Коментар</th>
                                            <th>Статус / дії</th>
                                          </tr>
                                          <tr>
                                            <th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th>
                                            {grid.weeks.map((w) => (
                                              <Fragment key={w.label}>
                                                <th style={{ textAlign: "right", fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>план</th>
                                                <th style={{ textAlign: "right", fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>факт</th>
                                              </Fragment>
                                            ))}
                                            <th></th><th></th><th></th><th></th><th></th><th></th><th></th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {m.clients.map((c) => (
                                            <ClientPlanRow
                                              key={c.clientKey}
                                              client={c}
                                              month={grid.month}
                                              managerId={m.managerId}
                                              weekPlan={decomp(c.plan, c.fact).perWeek}
                                              role={role}
                                              onSaved={() => setReload((n) => n + 1)}
                                              onHistory={setHistoryClient}
                                            />
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              </Fragment>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                    {(() => { const gd = decomp(grid.totalPlan, grid.totalFact); return (
                      <tr style={{ borderTop: "2px solid var(--border)" }}>
                        <td style={{ fontWeight: 800 }}>Разом по відділу</td>
                        <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(grid.totalPlan)}</td>
                        <td style={{ fontWeight: 800, textAlign: "right", color: "#16a34a" }}>{formatAmount(grid.totalFact)}</td>
                        <td style={{ fontWeight: 800, textAlign: "right", color: "#d97706" }}>{formatAmount(gd.remaining)}</td>
                        <td style={{ fontWeight: 800, textAlign: "right", color: gd.lag > 0 ? "#dc2626" : "#16a34a" }}>{gd.lag > 0 ? formatAmount(gd.lag) : "✓"}</td>
                        {gd.perWeek.map((v, i) => (
                          <td key={i} style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(v)}</td>
                        ))}
                        <td style={{ fontWeight: 800, textAlign: "right" }}>{formatAmount(gd.perDay)}</td>
                      </tr>
                    ); })()}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </>
      )}
      {historyClient && grid && (
        <PlanHistoryModal
          clientKey={historyClient.clientKey}
          clientName={historyClient.clientName}
          month={grid.month}
          onClose={() => setHistoryClient(null)}
        />
      )}
    </div>
  );
}
