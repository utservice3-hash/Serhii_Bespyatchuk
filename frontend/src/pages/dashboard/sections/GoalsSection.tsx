import { useEffect, useState } from "react";
import { fetchGoals, createGoal, updateGoal, deleteGoal, type MonthlyGoal, type Team } from "../../../api";
import { DatePicker } from "../../../components/DatePicker";

const curMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/**
 * «Місячні цілі» — high-level monthly objectives for a team lead / КВП, separate
 * from the numeric plans. Add goals for a month, mark done, edit progress notes.
 */
export function GoalsSection({ role, teams }: { role?: string; teams?: Team[] }) {
  const [month, setMonth] = useState(curMonth());
  const [teamId, setTeamId] = useState<number | "">("");
  const [goals, setGoals] = useState<MonthlyGoal[] | null>(null);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [reload, setReload] = useState(0);
  const canPickTeam = role === "admin";

  useEffect(() => {
    setGoals(null);
    fetchGoals(month, teamId ? Number(teamId) : undefined).then(setGoals).catch(() => setGoals([]));
  }, [month, teamId, reload]);

  const add = async () => {
    if (!title.trim()) return;
    await createGoal({ month, title: title.trim(), target: target.trim() || null, teamId: teamId ? Number(teamId) : null });
    setTitle(""); setTarget(""); setReload((n) => n + 1);
  };

  const doneN = goals?.filter((g) => g.status === "done").length ?? 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎯 Місячні цілі</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {canPickTeam && (
            <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
              style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
              <option value="">Весь відділ</option>
              {(teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <DatePicker mode="month" value={month} onChange={(v) => v && setMonth(v)} minWidth={150} />
        </div>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px", maxWidth: 760 }}>
          Високорівневі цілі на місяць (окремо від числових планів). Напр. «Запустити реактивацію б/г-клієнтів», «Закрити 5 нових компаній», «Підняти конверсію реклами до 30%».
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Нова ціль на місяць…" style={{ flex: 2, minWidth: 220, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          <input value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Ціль/показник (необов.)" style={{ flex: 1, minWidth: 140, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          <button className="btn-primary" onClick={add} disabled={!title.trim()}>Додати</button>
        </div>

        {goals === null ? (
          <p className="loading-text">Завантаження…</p>
        ) : goals.length === 0 ? (
          <p className="loading-text">Цілей на цей місяць ще немає. Додайте першу вгорі.</p>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Виконано {doneN}/{goals.length}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {goals.map((g) => (
                <div key={g.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", opacity: g.status === "done" ? 0.6 : 1 }}>
                  <input type="checkbox" checked={g.status === "done"} style={{ marginTop: 3 }}
                    onChange={() => { updateGoal(g.id, { status: g.status === "done" ? "in_progress" : "done" }).then(() => setReload((n) => n + 1)); }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, textDecoration: g.status === "done" ? "line-through" : "none" }}>
                      {g.title}
                      {canPickTeam && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}> · {g.teamName ?? "Весь відділ"}</span>}
                    </div>
                    {g.target && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>🎯 {g.target}</div>}
                    <input defaultValue={g.comment ?? ""} placeholder="Коментар/прогрес…"
                      onBlur={(e) => { if (e.target.value !== (g.comment ?? "")) updateGoal(g.id, { comment: e.target.value || null }); }}
                      style={{ marginTop: 6, width: "100%", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 13, padding: "2px 0" }} />
                  </div>
                  <button title="Видалити" onClick={() => { deleteGoal(g.id).then(() => setReload((n) => n + 1)); }}
                    style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16 }}>✕</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
