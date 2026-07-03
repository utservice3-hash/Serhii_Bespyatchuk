import type { Dispatch, SetStateAction } from "react";
import type { AuthPayload } from "../../../auth";
import { saveReceivableNote, type ReceivableManager, type Team } from "../../../api";
import { formatAmount } from "../format";

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
}) {
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
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
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
        {(() => {
          const all = receivablesData
            .flatMap((m) => m.clients.map((c) => ({ ...c, managerName: m.managerName })))
            .sort((a, b) => b.amount - a.amount);
          const total = all.reduce((s, c) => s + c.amount, 0);
          return (
            <details className="chart-card" style={{ marginBottom: 16 }} open>
              <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 16 }}>
                Усі боржники — звід ({all.length}) · {formatAmount(total)}
              </summary>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 8px" }}>
                Перелік усіх клієнтів із сумою боргу та кількістю днів без оплати. Червоним — прострочка понад ліміт.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>Клієнт</th><th>Менеджер</th><th>Сума боргу</th><th>Днів не оплачено</th><th>Ліміт днів</th><th>Дата оплати</th><th>Коментар</th></tr>
                  </thead>
                  <tbody>
                    {all.map((c, i) => {
                      const over = c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays;
                      return (
                        <tr key={`${c.clientKey}-${i}`}>
                          <td>{i + 1}</td>
                          <td>{c.clientName}</td>
                          <td style={{ color: "var(--text-muted)" }}>{c.managerName}</td>
                          <td style={{ fontWeight: 600 }}>{formatAmount(c.amount)}</td>
                          <td style={over ? { color: "#dc2626", fontWeight: 700 } : undefined}>{c.overdueDays ?? "—"}</td>
                          <td>{c.limitDays ?? "—"}</td>
                          <td>{c.dueDate ?? "—"}</td>
                          <td>{c.comment ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })()}
        <div className="chart-grid">
          {receivablesData.map((m) => (
            <div className="chart-card" key={m.managerId}>
              <h2 className="chart-title">{m.managerName}</h2>
              <div className="kpi-grid">
                <div className="kpi-card">
                  <span className="kpi-label">Загальний борг</span>
                  <span className="kpi-value">{formatAmount(m.total)}</span>
                </div>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Клієнт</th>
                    <th>Заборгованість</th>
                    <th>Лімит днів</th>
                    <th>Макс днів</th>
                    <th>Дата оплати</th>
                    <th>Коментар</th>
                  </tr>
                </thead>
                <tbody>
                  {m.clients.map((c) => (
                    <tr key={c.clientKey}>
                      <td>{c.clientName}</td>
                      <td>{formatAmount(c.amount)}</td>
                      <td>{c.limitDays ?? "—"}</td>
                      <td
                        style={
                          c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays
                            ? { color: "#dc2626", fontWeight: 600 }
                            : undefined
                        }
                      >
                        {c.overdueDays ?? "—"}
                      </td>
                      <td>
                        {canEditReceivables ? (
                          <input
                            type="date"
                            value={c.dueDate ?? ""}
                            onChange={(e) => patchReceivableNote(c.clientKey, { dueDate: e.target.value || null })}
                            onBlur={(e) => saveReceivableNote({ clientKey: c.clientKey, dueDate: e.target.value || null, comment: c.comment })}
                            style={{ fontSize: 12 }}
                          />
                        ) : (
                          c.dueDate ?? "—"
                        )}
                      </td>
                      <td>
                        {canEditReceivables ? (
                          <input
                            value={c.comment ?? ""}
                            placeholder="—"
                            onChange={(e) => patchReceivableNote(c.clientKey, { comment: e.target.value })}
                            onBlur={(e) => saveReceivableNote({ clientKey: c.clientKey, comment: e.target.value, dueDate: c.dueDate })}
                            style={{ border: "none", width: "100%", minWidth: 120 }}
                          />
                        ) : (
                          c.comment ?? "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        </>
      )}
    </>
  );
}
