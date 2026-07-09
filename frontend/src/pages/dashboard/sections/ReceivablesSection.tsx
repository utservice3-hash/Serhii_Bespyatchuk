import { useState, type Dispatch, type SetStateAction, Fragment } from "react";
import type { AuthPayload } from "../../../auth";
import {
  saveReceivableNote, saveReceivableInvoiceNote, fetchReceivableInvoices, triggerReceivablesSync,
  type ReceivableInvoice, type ReceivableManager, type Team,
} from "../../../api";
import { formatAmount, formatAmountFull } from "../format";

const inputStyle: React.CSSProperties = {
  font: "inherit", fontSize: 12, padding: "3px 6px", borderRadius: 6,
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
};

/**
 * Дебіторська заборгованість: KPI-зведення → єдина таблиця боржників (клік по
 * клієнту → неоплачені рахунки з дедлайном і коментарем до КОЖНОГО рахунку) →
 * підсумок по менеджерах. Прострочений дедлайн → авто-задача менеджеру
 * «отримати оплату» (щоденний джоб).
 */
export function ReceivablesSection({
  auth,
  teams,
  receivablesTeamId,
  setReceivablesTeamId,
  receivablesSyncedAt,
  receivablesLoading,
  receivablesData,
  canEditReceivables,
  patchReceivableNote,
  onRefresh,
}: {
  auth: AuthPayload | null;
  teams: Team[];
  receivablesTeamId: number | "";
  setReceivablesTeamId: Dispatch<SetStateAction<number | "">>;
  receivablesSyncedAt: string | null;
  receivablesLoading: boolean;
  receivablesData: ReceivableManager[];
  canEditReceivables: boolean;
  patchReceivableNote: (clientKey: string, patch: { comment?: string; dueDate?: string | null }) => void;
  onRefresh?: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const refreshFromSheet = async () => {
    setSyncing(true);
    try { await triggerReceivablesSync(); onRefresh?.(); }
    finally { setSyncing(false); }
  };

  // Розгортання рахунків клієнта (лінива підгрузка) + локальні правки нотаток рахунків.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [invCache, setInvCache] = useState<Record<string, ReceivableInvoice[] | "loading">>({});
  const loadInvoices = (clientKey: string) => {
    fetchReceivableInvoices(clientKey)
      .then((inv) => setInvCache((c) => ({ ...c, [clientKey]: inv })))
      .catch(() => setInvCache((c) => ({ ...c, [clientKey]: [] })));
  };
  const toggleClient = (clientKey: string) => {
    setOpenKey((cur) => (cur === clientKey ? null : clientKey));
    if (invCache[clientKey] === undefined) {
      setInvCache((c) => ({ ...c, [clientKey]: "loading" }));
      loadInvoices(clientKey);
    }
  };
  const patchInvoice = (clientKey: string, invoiceNo: string, patch: { dueDate?: string | null; comment?: string | null }) => {
    // Оптимістично оновлюємо кеш, зберігаємо на бекенді, потім тихо перечитуємо.
    setInvCache((c) => {
      const list = c[clientKey];
      if (!Array.isArray(list)) return c;
      return {
        ...c,
        [clientKey]: list.map((x) => ((x.invoiceNo ?? "") === invoiceNo ? { ...x, ...("dueDate" in patch ? { dueDate: patch.dueDate ?? null } : {}), ...("comment" in patch ? { comment: patch.comment ?? null } : {}) } : x)),
      };
    });
    const cur = invCache[clientKey];
    const row = Array.isArray(cur) ? cur.find((x) => (x.invoiceNo ?? "") === invoiceNo) : undefined;
    saveReceivableInvoiceNote({
      clientKey, invoiceNo,
      dueDate: "dueDate" in patch ? patch.dueDate ?? null : row?.dueDate ?? null,
      comment: "comment" in patch ? patch.comment ?? null : row?.comment ?? null,
    }).catch(() => {});
  };

  const today = new Date().toISOString().slice(0, 10);
  const renderInvoices = (clientKey: string, colSpan: number) => {
    if (openKey !== clientKey) return null;
    const inv = invCache[clientKey];
    return (
      <tr>
        <td colSpan={colSpan} style={{ background: "var(--bg-subtle, rgba(127,127,127,0.05))", padding: "10px 12px 14px 28px" }}>
          {inv === "loading" || inv === undefined ? (
            <span className="loading-text">Завантаження рахунків…</span>
          ) : inv.length === 0 ? (
            <span className="loading-text">Деталізації рахунків немає.</span>
          ) : (
            <>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 6px" }}>
                📅 Постав дедлайн оплати по рахунку — якщо мине, а оплата не надійде, менеджеру автоматично створиться задача «отримати оплату».
              </p>
              <table className="data-table compact" style={{ fontSize: 12, minWidth: 680 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Рахунок №</th>
                    <th>Дата</th>
                    <th style={{ textAlign: "right" }}>Сума</th>
                    <th>📅 Дедлайн оплати</th>
                    <th style={{ textAlign: "left" }}>Коментар</th>
                    <th>Лінк</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.map((x, i) => {
                    const overdue = x.dueDate != null && x.dueDate < today;
                    return (
                      <tr key={i}>
                        <td style={{ textAlign: "left", fontWeight: 600 }}>{x.invoiceNo ?? "—"}</td>
                        <td>{x.invoiceDate ? new Date(x.invoiceDate).toLocaleDateString("uk-UA") : "—"}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }} title={formatAmountFull(x.amount)}>{formatAmount(x.amount)}</td>
                        <td>
                          <input
                            type="date"
                            value={x.dueDate ?? ""}
                            onChange={(e) => patchInvoice(clientKey, x.invoiceNo ?? "", { dueDate: e.target.value || null })}
                            style={{ ...inputStyle, ...(overdue ? { borderColor: "#dc2626", color: "#dc2626", fontWeight: 700 } : {}) }}
                            title={overdue ? "Дедлайн минув — менеджеру створено задачу отримати оплату" : "Дедлайн оплати рахунку"}
                          />
                          {overdue && <span style={{ color: "#dc2626", fontSize: 10, display: "block" }}>прострочено</span>}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          <input
                            defaultValue={x.comment ?? ""}
                            placeholder="коментар…"
                            onBlur={(e) => { if (e.target.value !== (x.comment ?? "")) patchInvoice(clientKey, x.invoiceNo ?? "", { comment: e.target.value || null }); }}
                            style={{ ...inputStyle, width: "100%", minWidth: 140 }}
                          />
                        </td>
                        <td>{x.serviceUrl ? <a href={x.serviceUrl} target="_blank" rel="noreferrer">🔗</a> : "—"}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ fontWeight: 700, textAlign: "left" }}>Разом: {inv.length} рах.</td>
                    <td />
                    <td style={{ textAlign: "right", fontWeight: 700 }}>{formatAmount(inv.reduce((s, x) => s + x.amount, 0))}</td>
                    <td colSpan={3} />
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </td>
      </tr>
    );
  };
  const caret = (clientKey: string) => (openKey === clientKey ? "▾ " : "▸ ");

  // Плоский список клієнтів + зведені KPI.
  const all = receivablesData
    .flatMap((m) => m.clients.map((c) => ({ ...c, managerName: m.managerName })))
    .sort((a, b) => b.amount - a.amount);
  const total = all.reduce((s, c) => s + c.amount, 0);
  const overdueClients = all.filter((c) => c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays);
  const overdueSum = overdueClients.reduce((s, c) => s + c.amount, 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Дебіторська заборгованість</h1>
        <div className="page-filters">
          {auth?.role !== "manager" && (
            <select
              value={receivablesTeamId}
              onChange={(e) => setReceivablesTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Усі команди</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          {canEditReceivables && (
            <button onClick={refreshFromSheet} disabled={syncing} title="Перечитати файл дебіторки — сплачені (видалені з файлу) рахунки зникнуть одразу"
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: syncing ? "default" : "pointer", fontWeight: 600, fontSize: 13 }}>
              {syncing ? "Оновлення…" : "🔄 Оновити з файлу"}
            </button>
          )}
          {receivablesSyncedAt && (
            <span className="loading-text" style={{ fontSize: 12 }}>
              Оновлено: {new Date(receivablesSyncedAt).toLocaleString("uk-UA")}
            </span>
          )}
        </div>
      </div>

      {receivablesLoading ? (
        <p className="loading-text">Завантаження...</p>
      ) : receivablesData.length === 0 ? (
        <p className="loading-text">Немає даних.</p>
      ) : (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginBottom: 16 }}>
            <div className="kpi-card" style={{ borderTop: "3px solid #c5141c" }}>
              <span className="kpi-label">Загальний борг</span>
              <span className="kpi-value">{formatAmount(total)}</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Боржників</span>
              <span className="kpi-value">{all.length}</span>
            </div>
            <div className="kpi-card" style={{ borderTop: `3px solid ${overdueClients.length ? "#dc2626" : "#16a34a"}` }}>
              <span className="kpi-label">Прострочено (понад ліміт)</span>
              <span className="kpi-value" style={{ color: overdueClients.length ? "#dc2626" : "#16a34a" }}>
                {overdueClients.length}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{overdueClients.length ? formatAmount(overdueSum) : "усе в межах ліміту"}</span>
            </div>
          </div>

          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title" style={{ marginBottom: 4 }}>Боржники ({all.length})</h2>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>
              Клік по клієнту — неоплачені рахунки з дедлайном і коментарем до кожного. Червоні дні — прострочка понад ліміт.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th style={{ textAlign: "left" }}>Клієнт</th>
                    <th style={{ textAlign: "left" }}>Менеджер</th>
                    <th style={{ textAlign: "right" }}>Сума боргу</th>
                    <th>Днів без оплати</th>
                    <th>Ліміт</th>
                    <th>Дата оплати (клієнт)</th>
                    <th style={{ textAlign: "left" }}>Коментар</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((c, i) => {
                    const over = c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays;
                    return (
                      <Fragment key={`${c.clientKey}-${i}`}>
                        <tr style={over ? { background: "rgba(220,38,38,0.04)" } : undefined}>
                          <td style={{ color: "var(--text-muted)" }}>{i + 1}</td>
                          <td style={{ textAlign: "left" }}>
                            <button onClick={() => toggleClient(c.clientKey)} title="Показати неоплачені рахунки"
                              style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text)", font: "inherit", fontWeight: 600, padding: 0, textAlign: "left" }}>
                              {caret(c.clientKey)}{c.clientName}
                            </button>
                          </td>
                          <td style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>{c.managerName}</td>
                          <td style={{ textAlign: "right", fontWeight: 700 }}>{formatAmount(c.amount)}</td>
                          <td style={over ? { color: "#dc2626", fontWeight: 700 } : undefined}>{c.overdueDays ?? "—"}</td>
                          <td style={{ color: "var(--text-muted)" }}>{c.limitDays ?? "—"}</td>
                          <td>
                            {canEditReceivables ? (
                              <input
                                type="date"
                                value={c.dueDate ?? ""}
                                onChange={(e) => patchReceivableNote(c.clientKey, { dueDate: e.target.value || null })}
                                onBlur={(e) => saveReceivableNote({ clientKey: c.clientKey, dueDate: e.target.value || null, comment: c.comment })}
                                style={inputStyle}
                              />
                            ) : (
                              c.dueDate ? new Date(c.dueDate).toLocaleDateString("uk-UA") : "—"
                            )}
                          </td>
                          <td style={{ textAlign: "left" }}>
                            {canEditReceivables ? (
                              <input
                                value={c.comment ?? ""}
                                placeholder="—"
                                onChange={(e) => patchReceivableNote(c.clientKey, { comment: e.target.value })}
                                onBlur={(e) => saveReceivableNote({ clientKey: c.clientKey, comment: e.target.value, dueDate: c.dueDate })}
                                style={{ ...inputStyle, width: "100%", minWidth: 140 }}
                              />
                            ) : (
                              c.comment ?? "—"
                            )}
                          </td>
                        </tr>
                        {renderInvoices(c.clientKey, 8)}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {receivablesData.length > 1 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">По менеджерах</h2>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table compact" style={{ minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Менеджер</th>
                      <th style={{ textAlign: "right" }}>Борг</th>
                      <th style={{ textAlign: "right" }}>Клієнтів</th>
                      <th style={{ textAlign: "right" }}>Прострочено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...receivablesData].sort((a, b) => b.total - a.total).map((m) => {
                      const od = m.clients.filter((c) => c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays);
                      return (
                        <tr key={m.managerId}>
                          <td style={{ textAlign: "left", fontWeight: 600 }}>{m.managerName}</td>
                          <td style={{ textAlign: "right", fontWeight: 700 }}>{formatAmount(m.total)}</td>
                          <td style={{ textAlign: "right" }}>{m.clients.length}</td>
                          <td style={{ textAlign: "right", color: od.length ? "#dc2626" : "#16a34a", fontWeight: 600 }}>
                            {od.length ? `${od.length} · ${formatAmount(od.reduce((s, c) => s + c.amount, 0))}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
