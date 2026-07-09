import { useEffect, useState } from "react";
import {
  fetchReactivation, updateReactivationClient, removeReactivationClient,
  type ReactivationClient,
} from "../../../api";
import { formatAmount } from "../format";

const STATUS_OPTS = [
  { v: "in_progress", label: "🔄 В роботі" },
  { v: "reactivated", label: "✅ Реактивовано" },
  { v: "refused", label: "🚫 Відмова" },
] as const;

const inputStyle: React.CSSProperties = {
  font: "inherit", fontSize: 12, padding: "3px 6px", borderRadius: 6,
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
};
/** Порожнє обовʼязкове поле підсвічуємо, щоб менеджер бачив, що треба заповнити. */
const needFill: React.CSSProperties = { ...inputStyle, borderColor: "#d97706", background: "rgba(217,119,6,0.08)" };

/**
 * Грід реактивації (аналог плану по постійних): клієнти, яких тімлід віддав
 * менеджеру в роботу. Обовʼязкові поля: план/факт, 1-й контакт → результат,
 * 2-й контакт → результат. Факт = отримані кошти від клієнта після взяття.
 *
 * Керований (clients+onReload з батька) або самодостатній (сам фетчить,
 * напр. у звіті менеджера/тімліда). readOnly — для вбудованих звітів.
 */
export function ReactivationGrid({
  clients: clientsProp,
  onReload,
  managerId,
  teamId,
  readOnly = false,
  canDelete = false,
  title = "🔄 Реактивація — клієнти в роботі",
}: {
  clients?: ReactivationClient[] | null;
  onReload?: () => void;
  managerId?: number;
  teamId?: number;
  readOnly?: boolean;
  canDelete?: boolean;
  title?: string;
}) {
  const [own, setOwn] = useState<ReactivationClient[] | null>(null);
  const selfManaged = clientsProp === undefined;
  const params = managerId || teamId ? { managerId, teamId } : undefined;
  useEffect(() => {
    if (!selfManaged) return;
    fetchReactivation(params).then(setOwn).catch(() => setOwn([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfManaged, managerId, teamId]);

  const clients = selfManaged ? own : clientsProp;
  const reload = () => {
    if (selfManaged) fetchReactivation(params).then(setOwn).catch(() => {});
    else onReload?.();
  };

  // Локальні чернетки текстових полів (зберігаємо на blur, щоб не спамити API).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const dkey = (ck: string, f: string) => `${ck}:${f}`;
  type Patch = Partial<{
    plan: number; contact1Date: string | null; contact1Result: string | null;
    contact2Date: string | null; contact2Result: string | null; status: string; comment: string | null;
  }>;
  const save = (clientKey: string, patch: Patch) => {
    updateReactivationClient({ clientKey, ...patch }).then(reload).catch(() => {});
  };

  if (clients === null || clients === undefined) {
    return <div className="chart-card" style={{ marginBottom: 16 }}><p className="loading-text" style={{ margin: 0 }}>Завантаження реактивації…</p></div>;
  }
  if (clients.length === 0 && readOnly) return null;

  const inWork = clients.filter((c) => c.status === "in_progress").length;
  const done = clients.filter((c) => c.status === "reactivated").length;
  const planSum = clients.reduce((s, c) => s + c.plan, 0);
  const factSum = clients.reduce((s, c) => s + c.fact, 0);

  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h2 className="chart-title" style={{ marginBottom: 0 }}>{title}</h2>
        <div style={{ display: "flex", gap: 12, fontSize: 12, color: "var(--text-muted)", flexWrap: "wrap" }}>
          <span>🔄 в роботі: <b style={{ color: "var(--text)" }}>{inWork}</b></span>
          <span>✅ реактивовано: <b style={{ color: "#16a34a" }}>{done}</b></span>
          <span>план: <b style={{ color: "var(--text)" }}>{formatAmount(planSum)}</b></span>
          <span>факт: <b style={{ color: factSum >= planSum && planSum > 0 ? "#16a34a" : "var(--text)" }}>{formatAmount(factSum)}</b></span>
        </div>
      </div>
      {clients.length === 0 ? (
        <p className="loading-text" style={{ margin: "10px 0 0" }}>
          Поки нікого немає. Тімлід додає сплячих/втрачених клієнтів кнопкою «➕ в реактивацію» у списках нижче.
        </p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table className="data-table compact" style={{ minWidth: readOnly ? 760 : 1150, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Клієнт</th>
                <th style={{ textAlign: "left" }}>Менеджер</th>
                <th>Категорія</th>
                <th style={{ textAlign: "right" }}>План ₴</th>
                <th style={{ textAlign: "right" }}>Факт ₴</th>
                <th>1-й контакт</th>
                <th style={{ textAlign: "left" }}>Результат 1</th>
                <th>2-й контакт</th>
                <th style={{ textAlign: "left" }}>Результат 2</th>
                <th>Статус</th>
                {!readOnly && <th style={{ textAlign: "left" }}>Коментар</th>}
                {canDelete && <th />}
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => {
                const factColor = c.fact > 0 ? "#16a34a" : "var(--text-muted)";
                return (
                  <tr key={c.clientKey}>
                    <td style={{ textAlign: "left", fontWeight: 600 }}>
                      {c.clientName}
                      <div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>
                        остання оплата: {c.lastPaid ? new Date(c.lastPaid).toLocaleDateString("uk-UA") : "—"} · додано {new Date(c.addedAt).toLocaleDateString("uk-UA")}
                      </div>
                    </td>
                    <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{c.managerName}</td>
                    <td>{c.category === "lost" ? "🕸 втрачений" : "💤 сплячий"}</td>
                    <td style={{ textAlign: "right" }}>
                      {readOnly ? (c.plan ? formatAmount(c.plan) : "—") : (
                        <input type="number" defaultValue={c.plan || ""} placeholder="план"
                          onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== c.plan) save(c.clientKey, { plan: v }); }}
                          style={{ ...(c.plan ? inputStyle : needFill), width: 80, textAlign: "right" }} />
                      )}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: factColor }} title={`${c.factDeals} угод після взяття в роботу`}>
                      {c.fact ? formatAmount(c.fact) : "0"}
                    </td>
                    <td>
                      {readOnly ? (c.contact1Date ? new Date(c.contact1Date).toLocaleDateString("uk-UA") : "—") : (
                        <input type="date" value={c.contact1Date ?? ""}
                          onChange={(e) => save(c.clientKey, { contact1Date: e.target.value || null })}
                          style={c.contact1Date ? inputStyle : needFill} />
                      )}
                    </td>
                    <td style={{ textAlign: "left" }}>
                      {readOnly ? (c.contact1Result ?? "—") : (
                        <input value={draft[dkey(c.clientKey, "r1")] ?? c.contact1Result ?? ""} placeholder="результат…"
                          onChange={(e) => setDraft((d) => ({ ...d, [dkey(c.clientKey, "r1")]: e.target.value }))}
                          onBlur={(e) => { if (e.target.value !== (c.contact1Result ?? "")) save(c.clientKey, { contact1Result: e.target.value || null }); }}
                          style={{ ...(c.contact1Result ? inputStyle : needFill), width: 130 }} />
                      )}
                    </td>
                    <td>
                      {readOnly ? (c.contact2Date ? new Date(c.contact2Date).toLocaleDateString("uk-UA") : "—") : (
                        <input type="date" value={c.contact2Date ?? ""}
                          onChange={(e) => save(c.clientKey, { contact2Date: e.target.value || null })}
                          style={inputStyle} />
                      )}
                    </td>
                    <td style={{ textAlign: "left" }}>
                      {readOnly ? (c.contact2Result ?? "—") : (
                        <input value={draft[dkey(c.clientKey, "r2")] ?? c.contact2Result ?? ""} placeholder="результат…"
                          onChange={(e) => setDraft((d) => ({ ...d, [dkey(c.clientKey, "r2")]: e.target.value }))}
                          onBlur={(e) => { if (e.target.value !== (c.contact2Result ?? "")) save(c.clientKey, { contact2Result: e.target.value || null }); }}
                          style={{ ...inputStyle, width: 130 }} />
                      )}
                    </td>
                    <td>
                      {readOnly ? (STATUS_OPTS.find((s) => s.v === c.status)?.label ?? c.status) : (
                        <select value={c.status} onChange={(e) => save(c.clientKey, { status: e.target.value })} style={inputStyle}>
                          {STATUS_OPTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                        </select>
                      )}
                    </td>
                    {!readOnly && (
                      <td style={{ textAlign: "left" }}>
                        <input value={draft[dkey(c.clientKey, "cm")] ?? c.comment ?? ""} placeholder="—"
                          onChange={(e) => setDraft((d) => ({ ...d, [dkey(c.clientKey, "cm")]: e.target.value }))}
                          onBlur={(e) => { if (e.target.value !== (c.comment ?? "")) save(c.clientKey, { comment: e.target.value || null }); }}
                          style={{ ...inputStyle, width: 140 }} />
                      </td>
                    )}
                    {canDelete && (
                      <td>
                        <button title="Прибрати з реактивації"
                          onClick={() => { if (confirm(`Прибрати «${c.clientName}» з реактивації?`)) removeReactivationClient(c.clientKey).then(reload).catch(() => {}); }}
                          style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)" }}>🗑</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
