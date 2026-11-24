import { useEffect, useMemo, useState } from "react";
import { fetchHiringEmployeesView, empCategoryLabel, EMP_LEVEL_LABEL, hiringError, type HiringEmployeeViewRow, type EmpLevel } from "../../../api";
import "./hiring.css";

/**
 * 👁 «НАЙМ → СПІВРОБІТНИКИ» ДЛЯ ПЕРЕГЛЯДУ (фінансист, 20.11.2026, рішення Романа: «кандидати і співробітники без паролів»).
 * Лише читання: ПІБ, посада, категорія, рівень, команда, дати. Паролів, сейфу, документів, контактів і акаунтів тут немає —
 * сервер їх не віддає (`GET /api/hiring/employees`, поля поіменно). Повний реєстр із сейфом — за правом сейфу. Тримає #4152.
 */
const d = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : "—");

export function HiringEmployeesView() {
  const [rows, setRows] = useState<HiringEmployeeViewRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"active" | "dismissed">("active");
  const [q, setQ] = useState("");
  useEffect(() => { fetchHiringEmployeesView().then(setRows).catch((e) => setErr(hiringError(e))); }, []);
  const shown = useMemo(() => (rows ?? []).filter((r) => (view === "dismissed" ? r.status === "dismissed" : r.status !== "dismissed")
    && (!q.trim() || `${r.full_name} ${r.position ?? ""} ${r.team_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))), [rows, view, q]);
  if (err) return <div className="chart-card"><b>Список співробітників недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const active = rows.filter((r) => r.status !== "dismissed").length;
  return (
    <div className="chart-card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="emp-bar">
        <div className="hr-seg2">
          <button className={view === "active" ? "on" : ""} onClick={() => setView("active")}>Працюють · {active}</button>
          <button className={view === "dismissed" ? "on" : ""} onClick={() => setView("dismissed")}>Звільнені · {rows.length - active}</button>
        </div>
        <input className="hr-inp" placeholder="Пошук: ПІБ, посада, команда" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук співробітника" style={{ flex: "1 1 200px" }} />
        <span className="hr-muted" style={{ fontSize: 12.5 }}>Лише перегляд · показано {shown.length}</span>
      </div>
      <div className="hr-tw">
        <table className="data-table emp-table">
          <thead><tr><th>Співробітник</th><th>Категорія</th><th>Рівень</th><th>Команда</th><th>Прийнято</th>{view === "dismissed" && <th>Звільнено</th>}</tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.status === "dismissed" ? "off" : ""}>
                <td><b>{r.full_name}</b>{r.is_office && <span className="emp-pill office" title="Працює в офісі: таймтрекер не чекає від нього даних">офіс</span>}<div className="hr-muted">{r.position ?? "посада не вказана"}</div></td>
                <td>{r.category ? empCategoryLabel(r.category) : <span className="hr-muted">без категорії</span>}</td>
                <td>{r.level ? <span className={`emp-lvl ${r.level}`}>{EMP_LEVEL_LABEL[r.level as EmpLevel]}</span> : <span className="hr-muted">—</span>}</td>
                <td>{r.team_name ?? <span className="hr-muted">—</span>}</td>
                <td>{d(r.hired_at)}</td>
                {view === "dismissed" && <td>{d(r.dismissed_at)}{r.dismiss_reason && <div className="hr-muted">{r.dismiss_reason}</div>}</td>}
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={6} className="hr-muted" style={{ padding: 16 }}>Нікого не знайдено.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
