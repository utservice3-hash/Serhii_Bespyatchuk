import { useEffect, useRef, useState } from "react";
import { fetchReceivables, type ReceivableClient } from "../../../api";
import { formatAmount } from "../format";
import { InfoHint } from "../widgets";

/**
 * KPI-картка «Дебіторка», що по кліку розкриває ознайомчий список: скільки ще
 * борг усього + які компанії й на які суми (прострочені — червоним). Скоуп
 * успадковує фільтр менеджера/команди зі Звіту.
 */
export function ReceivablesBreakdownCard({
  label, value, hint, managerId, teamId,
}: {
  label: string; value: string; hint?: string;
  managerId?: number; teamId?: number;
}) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<ReceivableClient[] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Тягнемо список при першому відкритті (або зміні скоупу, поки відкрито).
  useEffect(() => {
    if (!open) return;
    setClients(null);
    fetchReceivables({ managerId, teamId })
      .then((r) => {
        const all = r.managers.flatMap((m) => m.clients);
        all.sort((a, b) => b.amount - a.amount);
        setClients(all);
      })
      .catch(() => setClients([]));
  }, [open, managerId, teamId]);

  // Клік поза карткою закриває поповер.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const total = clients?.reduce((s, c) => s + c.amount, 0) ?? 0;
  const overdueCount = clients?.filter((c) => (c.overdueDays ?? 0) > 0).length ?? 0;

  return (
    <div
      ref={wrapRef}
      className="kpi-card"
      style={{ borderLeft: "3px solid #dc2626", position: "relative", cursor: "pointer" }}
      onClick={() => setOpen((v) => !v)}
    >
      <span className="kpi-label">{label}{hint && <InfoHint text={hint} />}</span>
      <span className="kpi-value" style={{ color: "#dc2626" }}>{value}</span>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{open ? "згорнути ▲" : "показати борги ▼"}</span>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
            background: "var(--card-bg, #fff)", border: "1px solid var(--border, #e0e4ea)",
            borderRadius: 10, boxShadow: "0 10px 28px rgba(0,0,0,0.18)", padding: 12, zIndex: 60,
            maxHeight: 340, overflowY: "auto", minWidth: 280,
          }}
        >
          {clients === null ? (
            <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>
          ) : clients.length === 0 ? (
            <p className="loading-text" style={{ margin: 0 }}>Немає боргів у цьому зрізі. 🎉</p>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{clients.length} компаній{overdueCount > 0 ? ` · ${overdueCount} прострочено` : ""}</span>
                <span style={{ fontWeight: 800, color: "#dc2626" }}>{formatAmount(total)}</span>
              </div>
              {clients.map((c) => {
                const overdue = (c.overdueDays ?? 0) > 0;
                return (
                  <div key={c.clientKey} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "3px 0" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.clientName}>
                      {overdue && <span title={`Прострочено ${c.overdueDays} дн.`}>🔴 </span>}{c.clientName}
                      {overdue && <span style={{ color: "#dc2626", fontSize: 11 }}> · {c.overdueDays} дн.</span>}
                    </span>
                    <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{formatAmount(c.amount)}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
