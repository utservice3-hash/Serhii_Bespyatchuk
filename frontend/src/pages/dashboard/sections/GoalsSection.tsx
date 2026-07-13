import { useEffect, useState } from "react";
import { fetchGoals, createGoal, updateGoal, deleteGoal, type MonthlyGoal, type Team } from "../../../api";
import { DatePicker } from "../../../components/DatePicker";
import { CommentField } from "../../../components/CommentField";

const curMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };

/**
 * «Місячні цілі» — high-level monthly objectives for a team lead / КВП, separate
 * from the numeric plans. Add goals for a month, mark done, edit progress notes.
 */
export function GoalsSection({ role, teams }: { role?: string; teams?: Team[] }) {
  const isAdmin = role === "admin";
  const [month, setMonth] = useState(curMonth());
  const [teamId, setTeamId] = useState<number | "">("");
  const [tab, setTab] = useState<"mine" | "teams">("mine"); // admin only
  const [goals, setGoals] = useState<MonthlyGoal[] | null>(null);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [reload, setReload] = useState(0);
  const teamsView = isAdmin && tab === "teams";

  useEffect(() => {
    setGoals(null);
    const scope = isAdmin ? tab : undefined;
    fetchGoals(month, { scope, teamId: teamsView && teamId ? Number(teamId) : undefined }).then(setGoals).catch(() => setGoals([]));
  }, [month, teamId, reload, tab, isAdmin, teamsView]);

  const add = async () => {
    if (!title.trim()) return;
    // Admin's own goals are department-wide (team_id null); their «Мої» view.
    await createGoal({ month, title: title.trim(), target: target.trim() || null, teamId: null });
    setTitle(""); setTarget(""); setReload((n) => n + 1);
  };

  const doneN = goals?.filter((g) => g.status === "done").length ?? 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎯 Місячні цілі</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {teamsView && (
            <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
              style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
              <option value="">Усі команди</option>
              {(teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <DatePicker mode="month" value={month} onChange={(v) => v && setMonth(v)} minWidth={150} />
        </div>
      </div>

      {isAdmin && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {(["mine", "teams"] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700,
                background: tab === k ? "#c8102e" : "var(--card-bg)", color: tab === k ? "#fff" : "var(--text)" }}>
              {k === "mine" ? "🎯 Мої цілі" : "👥 Цілі команд"}
            </button>
          ))}
        </div>
      )}

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px", maxWidth: 760 }}>
          {teamsView
            ? "Цілі, які тімліди поставили своїм командам на місяць (лише перегляд). Ваші цілі — у вкладці «Мої цілі», їх не бачить ніхто інший."
            : "Ваші високорівневі цілі на місяць (окремо від числових планів). Бачите тільки ви. Напр. «Запустити реактивацію б/г-клієнтів», «Підняти конверсію реклами до 30%»."}
        </p>
        {!teamsView && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Нова ціль на місяць…" style={{ flex: 2, minWidth: 220, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          <input value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Ціль/показник (необов.)" style={{ flex: 1, minWidth: 140, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
          <button className="btn-primary" onClick={add} disabled={!title.trim()}>Додати</button>
        </div>
        )}

        {goals === null ? (
          <p className="loading-text">Завантаження…</p>
        ) : goals.length === 0 ? (
          <p className="loading-text">{teamsView ? "Команди ще не поставили цілей на цей місяць." : "Цілей на цей місяць ще немає. Додайте першу вгорі."}</p>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Виконано {doneN}/{goals.length}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {goals.map((g) => (
                <div key={g.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", opacity: g.status === "done" ? 0.6 : 1 }}>
                  <input type="checkbox" checked={g.status === "done"} style={{ marginTop: 3 }} disabled={teamsView}
                    onChange={() => { if (teamsView) return; updateGoal(g.id, { status: g.status === "done" ? "in_progress" : "done" }).then(() => setReload((n) => n + 1)); }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, textDecoration: g.status === "done" ? "line-through" : "none" }}>
                      {g.title}
                      {teamsView && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}> · {g.teamName ?? "Відділ"}{g.authorName ? ` · ${g.authorName}` : ""}</span>}
                    </div>
                    {g.target && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>🎯 {g.target}</div>}
                    {teamsView
                      ? (g.comment && <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-muted)" }}>{g.comment}</div>)
                      : (
                        <div style={{ marginTop: 6 }}>
                          <CommentField value={g.comment} placeholder="Коментар/прогрес…"
                            onSave={(next) => updateGoal(g.id, { comment: next || null })} />
                        </div>
                      )}
                  </div>
                  {!teamsView && (
                    <button title="Видалити" onClick={() => { deleteGoal(g.id).then(() => setReload((n) => n + 1)); }}
                      style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16 }}>✕</button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
