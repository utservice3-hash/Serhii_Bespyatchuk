import { useCallback, useEffect, useState } from "react";
import type { AuthPayload } from "../../../auth";
import {
  fetchClientPlans, saveClientPlan, submitClientPlans, approveClientPlans, returnClientPlan,
  fetchClientComments, addClientComment,
  type ClientPlansResp, type ClientComment, type ManagerOption,
} from "../../../api";
import { formatAmountFull } from "../format";

/**
 * ФАЗА A · «ПОСТІЙНІ КЛІЄНТИ · ПЛАН МІСЯЦЯ» (макет 1).
 *
 * Рядок = клієнт по КАНОНІЧНОМУ ключу (злиті телефони й назви — один клієнт).
 * ФАКТ = «успішно реалізовано» ①, той самий, що у Звіті; тижні — ті самі межі.
 * Обидва приходять із ядра, фронт нічого не перераховує.
 *
 * Цикл плану: ЧЕРНЕТКА → ПОДАНО → ЗАТВЕРДЖЕНО. У «постійні принесуть» іде Σ
 * лише затверджених — тому в шапці дві цифри, а не одна.
 */

const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" } as const,
  th: { textAlign: "left", fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280",
        fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" } as const,
  td: { padding: "10px", borderBottom: "1px solid #f1f5f9", fontSize: 13, verticalAlign: "middle" } as const,
  chip: (bg: string, fg: string) => ({ display: "inline-block", padding: "1px 7px", borderRadius: 999,
        fontSize: 10, fontWeight: 700, background: bg, color: fg, whiteSpace: "nowrap" } as const),
};

const STATUS_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  none:     { label: "—",           bg: "#f3f4f6", fg: "#6b7280" },
  draft:    { label: "чернетка",    bg: "#f3f4f6", fg: "#4b5563" },
  pending:  { label: "подано",      bg: "#fef3c7", fg: "#92400e" },
  approved: { label: "затверджено", bg: "#dcfce7", fg: "#166534" },
};

function Tile({ title, value, sub, tone }: { title: string; value: string; sub?: string; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "#dc2626" : tone === "warn" ? "#b45309" : "#111827";
  return (
    <div style={{ ...S.card, flex: "1 1 180px", minWidth: 170 }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

/** Міні-бари історії 6 міс. Висота відносна до максимуму рядка — це форма, не шкала. */
function Spark({ values, months }: { values: number[]; months: string[] }) {
  const max = Math.max(1, ...values);
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 3, height: 26 }}>
      {values.map((v, i) => (
        <span key={i} title={`${months[i]}: ${formatAmountFull(v)}`}
          style={{ width: 7, height: Math.max(2, Math.round((v / max) * 26)), borderRadius: 2,
                   background: i === values.length - 1 ? "#2563eb" : "#bfdbfe" }} />
      ))}
    </span>
  );
}

function LastOrder({ days }: { days: number | null }) {
  if (days == null) return <span style={{ color: "#9ca3af" }}>—</span>;
  const bad = days >= 45, warn = days >= 30;
  return (
    <span style={{ color: bad ? "#dc2626" : warn ? "#b45309" : "#374151", fontWeight: warn ? 700 : 400 }}>
      {warn && "⚠️ "}{days === 0 ? "сьогодні" : `${days} дн. тому`}
    </span>
  );
}

function CommentsPanel({ clientKey, canWrite }: { clientKey: string; canWrite: boolean }) {
  const [items, setItems] = useState<ClientComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchClientComments(clientKey).then(setItems).catch(() => setItems([])); }, [clientKey]);
  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try { await addClientComment({ clientKey, body: draft.trim() }); setDraft(""); setItems(await fetchClientComments(clientKey)); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>💬 Коментарі</div>
      {items == null ? <div style={{ color: "#9ca3af", fontSize: 12 }}>завантаження…</div>
        : items.length === 0 ? <div style={{ color: "#9ca3af", fontSize: 12 }}>коментарів ще немає</div>
        : items.map((c) => (
          <div key={c.id} style={{ fontSize: 12, padding: "6px 0", borderBottom: "1px dashed #e5e7eb" }}>
            <b>{c.author ?? "—"}</b>
            <span style={{ color: "#6b7280" }}> · {c.createdAt.slice(0, 10).split("-").reverse().slice(0, 2).join(".")} — </span>
            {c.body}
          </div>
        ))}
      {canWrite && (
        <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Додати коментар…"
            style={{ flex: 1, fontSize: 12, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6 }} />
          <button onClick={add} disabled={busy || !draft.trim()}
            style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
            Додати
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Панель дзвінків. 🔴 ДАНИХ ПОКИ НЕМАЄ, і це підписано вголос: Ringostat-синк
 * зберігає лише агрегат по тімлідах, окремих дзвінків із номером абонента в базі
 * немає. Порожня панель із названою причиною чесніша за приховану колонку —
 * видно, що місце є, і чому воно порожнє.
 */
function CallsPanel({ reason }: { reason: string }) {
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>📞 Дзвінки · Ringostat</div>
      <div style={{ background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8, padding: "12px 14px",
                    fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
        Даних поки немає. {reason}.
      </div>
    </div>
  );
}

export function ClientPlansSection({ auth }: { auth: AuthPayload; managers?: ManagerOption[] }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<ClientPlansResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [payFilter, setPayFilter] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"in-plan" | "all" | "stale">("all");

  const isLead = auth.role === "team_lead" || auth.role === "admin";
  const load = useCallback(() => {
    setErr(null);
    fetchClientPlans({ month }).then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, [month]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); load(); } finally { setBusy(false); } };

  if (err) return <div style={{ ...S.card, color: "#dc2626" }}>{err}</div>;
  if (!data) return <div style={{ ...S.card, color: "#6b7280" }}>завантаження…</div>;

  const t = data.totals;
  const shift = (d: number) => {
    const dt = new Date(`${month}-01T00:00:00Z`); dt.setUTCMonth(dt.getUTCMonth() + d);
    setMonth(dt.toISOString().slice(0, 7));
  };
  const payTypes = [...new Set(data.clients.map((c) => c.paymentType).filter(Boolean))] as string[];
  const rows = data.clients.filter((c) => {
    if (payFilter.size && !payFilter.has(c.paymentType ?? "")) return false;
    if (view === "in-plan" && c.plan <= 0) return false;
    if (view === "stale" && !(c.lastOrderDays != null && c.lastOrderDays >= 30)) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── ШАПКА */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Постійні клієнти · план місяця</h2>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {data.month} · {auth.role === "manager" ? "мої клієнти" : auth.role === "team_lead" ? "моя команда" : "усі команди"}
            {" · клієнт = канонічний ключ (злиті телефони й назви рахуються разом)"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => shift(-1)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>←</button>
          <span style={{ fontWeight: 700, fontSize: 13, minWidth: 78, textAlign: "center" }}>{data.month}</span>
          <button onClick={() => shift(1)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>→</button>
        </div>
      </div>

      {/* ── ПЛИТКИ */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Tile title="План по постійних" value={formatAmountFull(t.planTotal)}
          sub={`заповнено ${t.filledClients} із ${t.totalClients} клієнтів`} />
        <Tile title="Факт · успішно реалізовано" value={formatAmountFull(t.factTotal)}
          sub={t.pct != null ? `${t.pct}% плану` : "плану ще немає"} />
        <Tile title={t.currentWeekIndex != null ? `Тиждень ${t.currentWeekIndex + 1} з ${data.weeks.length}` : "Тиждень"}
          value={t.currentWeekFact != null ? `${Math.round(t.currentWeekFact).toLocaleString("uk-UA")}` : "—"}
          sub={t.currentWeekPlan != null ? `/ ${Math.round(t.currentWeekPlan).toLocaleString("uk-UA")} · ті самі тижні, що у Звіті` : "місяць не поточний"} />
        <Tile title="Без замовлень > 30 дн." value={String(t.atRiskCount)} tone={t.atRiskCount ? "warn" : undefined}
          sub={t.atRiskNames.length ? `${t.atRiskNames.join(" · ")} — план під ризиком` : "усі активні"} />
        <Tile title="Іде у план менеджера" value={formatAmountFull(t.goesToManagerPlan)}
          sub={`лише ЗАТВЕРДЖЕНІ · довідково у «Формуванні плану»${t.planApproved !== t.planTotal
            ? ` · ще не погоджено ${formatAmountFull(t.planTotal - t.planApproved)}` : ""}`} />
      </div>

      {/* ── ФІЛЬТРИ + ДІЇ ЦИКЛУ */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {payTypes.map((p) => {
          const on = payFilter.has(p);
          return (
            <button key={p} onClick={() => { const n = new Set(payFilter); on ? n.delete(p) : n.add(p); setPayFilter(n); }}
              style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                       border: `1px solid ${on ? "#2563eb" : "#d1d5db"}`, background: on ? "#eff6ff" : "#fff",
                       color: on ? "#1d4ed8" : "#374151" }}>{p}</button>
          );
        })}
        <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 6 }}>Показати:</span>
        {([["in-plan", "у плані"], ["all", "усі постійні"], ["stale", "без замовлень 30+ дн."]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                     border: `1px solid ${view === k ? "#2563eb" : "#d1d5db"}`, background: view === k ? "#eff6ff" : "#fff",
                     color: view === k ? "#1d4ed8" : "#374151" }}>{label}</button>
        ))}
        <span style={{ flex: 1 }} />
        {auth.role === "manager" && (
          <button disabled={busy || !t.canSubmit} onClick={() => act(() => submitClientPlans({ month }))}
            title={t.canSubmit ? "Подати всі чернетки на затвердження" : "Немає чернеток до подання"}
            style={{ fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 8, cursor: t.canSubmit ? "pointer" : "default",
                     border: "none", background: t.canSubmit ? "#111827" : "#e5e7eb", color: t.canSubmit ? "#fff" : "#9ca3af" }}>
            Подати ({t.byStatus.draft ?? 0})
          </button>
        )}
        {isLead && (
          <button disabled={busy || !t.canApprove} onClick={() => act(() => approveClientPlans({ month }))}
            style={{ fontSize: 12, fontWeight: 700, padding: "7px 14px", borderRadius: 8, cursor: t.canApprove ? "pointer" : "default",
                     border: "none", background: t.canApprove ? "#166534" : "#e5e7eb", color: t.canApprove ? "#fff" : "#9ca3af" }}>
            Затвердити подані ({t.byStatus.pending ?? 0})
          </button>
        )}
      </div>

      {/* ── ТАБЛИЦЯ */}
      <div style={{ ...S.card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1180 }}>
          <thead>
            <tr>
              <th style={S.th}>Клієнт</th>
              <th style={S.th}>Історія · 6 міс</th>
              <th style={S.th}>Останнє зам.</th>
              <th style={S.th}>План (міс)</th>
              <th style={S.th}>Тижні · план / факт</th>
              <th style={{ ...S.th, textAlign: "right" }}>Факт</th>
              <th style={S.th}>Дії</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const st = STATUS_CHIP[c.planStatus] ?? STATUS_CHIP.none;
              const locked = c.planStatus === "approved" && !isLead;
              const val = edits[c.clientKey] ?? String(c.plan || "");
              const isOpen = open === c.clientKey;
              const risk = c.lastOrderDays != null && c.lastOrderDays >= 30;
              return (
                <>
                  <tr key={c.clientKey} style={{ background: risk ? "#fffbeb" : undefined }}>
                    <td style={S.td}>
                      <div style={{ fontWeight: 700 }}>{c.clientName}</div>
                      <div style={{ marginTop: 3, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        {c.paymentType && <span style={S.chip("#eff6ff", "#1d4ed8")}>{c.paymentType}</span>}
                        <span style={{ fontSize: 11, color: "#6b7280" }}>
                          {c.orders} зам.{c.since ? ` · з ${c.since}` : ""}
                        </span>
                        {c.pinned && <span style={S.chip("#f5f3ff", "#6d28d9")} title="закріплений за менеджером вручну">📌 {c.managerName}</span>}
                      </div>
                    </td>
                    <td style={S.td}><Spark values={c.history} months={data.historyMonths} /></td>
                    <td style={S.td}><LastOrder days={c.lastOrderDays} /></td>
                    <td style={S.td}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input value={val} disabled={locked || busy}
                          onChange={(e) => setEdits({ ...edits, [c.clientKey]: e.target.value })}
                          onBlur={() => {
                            const n = Number(val.replace(/\s/g, ""));
                            if (!Number.isFinite(n) || n === c.plan) return;
                            act(() => saveClientPlan({ clientKey: c.clientKey, month, plan: n }));
                          }}
                          title={locked ? "План затверджено — зміна лише через тімліда" : ""}
                          style={{ width: 92, fontSize: 13, fontWeight: 700, padding: "6px 8px", textAlign: "center",
                                   border: "1px solid #d1d5db", borderRadius: 8, background: locked ? "#f9fafb" : "#fff" }} />
                      </div>
                      <div style={{ marginTop: 4 }}><span style={S.chip(st.bg, st.fg)}>{st.label}</span></div>
                      {c.reviewNote && <div style={{ fontSize: 11, color: "#b45309", marginTop: 3 }} title="коментар тімліда">↩ {c.reviewNote}</div>}
                    </td>
                    <td style={S.td}>
                      <div style={{ display: "flex", gap: 3 }}>
                        {c.weeks.map((w, i) => (
                          <div key={i} title={`${w.from} — ${w.to}`}
                            style={{ minWidth: 58, padding: "4px 4px", borderRadius: 8, textAlign: "center",
                                     border: `1px solid ${w.status === "current" ? "#93c5fd" : "#e5e7eb"}`,
                                     background: w.status === "current" ? "#eff6ff" : "#fff" }}>
                            <div style={{ fontSize: 10, color: "#6b7280" }}>Т{i + 1} · {w.plan.toLocaleString("uk-UA")}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: w.fact > 0 ? "#166534" : w.status === "future" ? "#d1d5db" : "#dc2626" }}>
                              {w.status === "future" && w.fact === 0 ? "—" : w.fact.toLocaleString("uk-UA")}
                            </div>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td style={{ ...S.td, textAlign: "right" }}>
                      <div style={{ fontWeight: 800, color: c.fact > 0 ? "#166534" : "#9ca3af" }}>
                        {c.fact.toLocaleString("uk-UA")}{c.pct != null && <span style={{ color: "#6b7280", fontWeight: 500 }}> · {c.pct}%</span>}
                      </div>
                      <div style={{ height: 5, background: "#f1f5f9", borderRadius: 3, marginTop: 5, overflow: "hidden" }}>
                        <div style={{ width: `${Math.min(100, c.pct ?? 0)}%`, height: "100%", background: "#2563eb" }} />
                      </div>
                    </td>
                    <td style={S.td}>
                      <button onClick={() => setOpen(isOpen ? null : c.clientKey)}
                        style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>
                        💬 {c.comments} · 📞 0 · {isOpen ? "▲" : "▼"}
                      </button>
                      {isLead && c.planStatus !== "draft" && c.planStatus !== "none" && (
                        <button disabled={busy}
                          onClick={() => { const n = prompt("Коментар до повернення (обовʼязково):"); if (n && n.trim()) act(() => returnClientPlan({ clientKey: c.clientKey, month, note: n.trim() })); }}
                          title="Повернути план на доопрацювання"
                          style={{ marginLeft: 6, border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: "#b45309" }}>↩</button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${c.clientKey}-x`}>
                      <td colSpan={7} style={{ padding: "14px 16px", background: "#fbfdff", borderBottom: "1px solid #e5e7eb" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
                          <CommentsPanel clientKey={c.clientKey} canWrite />
                          <CallsPanel reason={data.callsUnavailable} />
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ ...S.td, color: "#9ca3af", textAlign: "center", padding: 24 }}>
                немає клієнтів під цей фільтр
              </td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr style={{ background: "#f8fafc", fontWeight: 800 }}>
                <td style={{ ...S.td, borderBottom: "none" }}>Разом · {rows.length} клієнтів</td>
                <td style={{ ...S.td, borderBottom: "none" }} />
                <td style={{ ...S.td, borderBottom: "none" }} />
                <td style={{ ...S.td, borderBottom: "none" }}>{rows.reduce((s2, c) => s2 + c.plan, 0).toLocaleString("uk-UA")}</td>
                <td style={{ ...S.td, borderBottom: "none" }} />
                <td style={{ ...S.td, borderBottom: "none", textAlign: "right" }}>
                  {rows.reduce((s2, c) => s2 + c.fact, 0).toLocaleString("uk-UA")}
                </td>
                <td style={{ ...S.td, borderBottom: "none" }} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div style={{ ...S.card, fontSize: 12, color: "#4b5563", lineHeight: 1.6 }}>
        <b>Як це рахується.</b> Факт — «успішно реалізовано» (①), той самий, що у Звіті: рахує ядро,
        не цей екран. Тижні збігаються з тижнями Звіту (спільна функція меж — розходження ловить гейт).
        План вводить менеджер, тижнева розбивка — автоматично за робочими днями. У «постійні принесуть»
        іде Σ <b>лише затверджених</b> планів. Клієнт = канонічний ключ: злиті телефони й назви
        рахуються разом.
      </div>
    </div>
  );
}
