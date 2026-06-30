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
      )}
    </>
  );
}
