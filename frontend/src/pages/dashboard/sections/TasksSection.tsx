import { useLayoutEffect, useRef, useState, useEffect, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import {
  updateTask,
  createTask,
  fetchReactivationCandidates,
  type ManagerOption,
  type ReactivationManager,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type Team,
} from "../../../api";
import { STATUS_DOT_COLORS, STATUS_GROUPS, STATUS_LABELS, PRIORITY_LABELS } from "../constants";
import { formatAmount } from "../format";
import type { TaskForm } from "../taskForm";

const METRIC_LBL: Record<string, string> = {
  ads_count: "Реклама",
  leadgen_count: "Лідоген",
  dispatch_count: "Авто",
  avg_check: "Сер. чек",
  conversion: "Конверсія",
  payment_amount: "Сума",
};
const METRIC_UNIT: Record<string, string> = { avg_check: "₴", payment_amount: "₴", conversion: "%" };

/** hex → rgba with alpha, for soft Notion-style pill backgrounds. */
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** Colored pill styling for a status <select> (kept editable, looks like Notion). */
const statusPillStyle = (s: TaskStatus): CSSProperties => ({
  background: hexA(STATUS_DOT_COLORS[s] ?? "#94a3b8", 0.16),
  color: "var(--text)", border: "none", borderRadius: 999, padding: "3px 12px",
  fontWeight: 600, fontSize: 12, appearance: "none", WebkitAppearance: "none", cursor: "pointer", maxWidth: "100%",
});
// Fixed departments (roles/відділи) — teams from the DB are appended at runtime.
const DEPARTMENTS = ["Операційний директор", "HR", "Асистент", "Офіс-менеджер", "Комерційний відділ", "Лідогенерація", "Фінанси", "Відділ якості"];
const DEPT_PALETTE = ["#60a5fa", "#a78bfa", "#f472b6", "#f59e0b", "#34d399", "#22d3ee", "#fb7185", "#818cf8", "#94a3b8"];
const deptColor = (s: string) => DEPT_PALETTE[[...s].reduce((h, c) => h + c.charCodeAt(0), 0) % DEPT_PALETTE.length];
const deptPillStyle = (s: string): CSSProperties => ({
  background: hexA(deptColor(s), 0.16), color: "var(--text)", border: "none", borderRadius: 999,
  padding: "3px 12px", fontWeight: 500, fontSize: 12, appearance: "none", WebkitAppearance: "none", cursor: "pointer", maxWidth: "100%",
});

const PRIORITY_COLOR: Record<TaskPriority, string> = { high: "#dc2626", medium: "#eab308", low: "#16a34a" };
const priorityPillStyle = (p: TaskPriority): CSSProperties => ({
  background: hexA(PRIORITY_COLOR[p] ?? "#94a3b8", 0.16), color: "var(--text)", border: "none",
  borderRadius: 999, padding: "3px 12px", fontWeight: 600, fontSize: 12,
  appearance: "none", WebkitAppearance: "none", cursor: "pointer",
});

/** Textarea that grows to fit its full content — never clips, no matter how
 *  narrow the column. onLocal updates the row live; onCommit persists on blur. */
function AutoTextarea({ value, onLocal, onCommit, style, placeholder }: {
  value: string;
  onLocal: (v: string) => void;
  onCommit: (v: string) => void;
  style?: CSSProperties;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onLocal(e.target.value)}
      onBlur={(e) => onCommit(e.target.value)}
      rows={1}
      style={{ border: "none", width: "100%", resize: "none", font: "inherit", background: "transparent", lineHeight: 1.4, overflow: "hidden", ...style }}
    />
  );
}

export function TasksSection({
  taskSearch,
  setTaskSearch,
  setTaskForm,
  emptyTaskForm,
  taskModalOpen,
  setTaskModalOpen,
  taskForm,
  tasksLoading,
  tasks,
  managerOptions,
  patchTaskLocal,
  handleDeleteTask,
  handleSubmitTaskModal,
  refreshTasks,
  role,
  currentUserId,
  currentManagerId,
  teams,
}: {
  taskSearch: string;
  setTaskSearch: Dispatch<SetStateAction<string>>;
  setTaskForm: Dispatch<SetStateAction<TaskForm>>;
  emptyTaskForm: TaskForm;
  taskModalOpen: boolean;
  setTaskModalOpen: Dispatch<SetStateAction<boolean>>;
  taskForm: TaskForm;
  tasksLoading: boolean;
  tasks: Task[];
  managerOptions: ManagerOption[];
  patchTaskLocal: (id: number, patch: Partial<Task>) => void;
  handleDeleteTask: (id: number) => void;
  handleSubmitTaskModal: () => void;
  refreshTasks?: () => Promise<void>;
  role?: string;
  currentUserId?: number;
  currentManagerId?: number | null;
  teams?: Team[];
}) {
  const isAdmin = role === "admin";
  // Department dropdown = fixed відділи + all team names, de-duplicated.
  const deptOptions = Array.from(new Set([...DEPARTMENTS, ...(teams ?? []).map((t) => t.name)]));
  const [adminTab, setAdminTab] = useState<"mine" | "all">("mine");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "done">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<number | "">("");
  const [sortBy, setSortBy] = useState<"created" | "deadline" | "priority" | "status" | "assignee" | "title">("created");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const openTask = openTaskId != null ? tasks.find((t) => t.id === openTaskId) ?? null : null;

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer",
    background: active ? "#c5141c" : "var(--card-bg)", color: active ? "#fff" : "var(--text)", fontWeight: 600,
  });

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Задачник</h1>
        <div className="page-filters" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input
            placeholder="🔍 Пошук задач..."
            value={taskSearch}
            onChange={(e) => setTaskSearch(e.target.value)}
            style={{ width: 200 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "done")}>
            <option value="all">Усі статуси</option>
            <option value="active">Активні</option>
            <option value="done">Виконані</option>
          </select>
          {role !== "manager" && (
            <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Усі виконавці</option>
              {managerOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              title="Сортування та налаштування"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: settingsOpen ? "rgba(127,127,127,0.12)" : "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 600 }}
            >
              ⇅ Сортування
            </button>
            {settingsOpen && (
              <>
                <div onClick={() => setSettingsOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 250, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: 14, zIndex: 50 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>Сортування</div>
                  <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Поле</label>
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} style={{ width: "100%", marginBottom: 12 }}>
                    <option value="created">За створенням</option>
                    <option value="deadline">За дедлайном</option>
                    <option value="priority">За пріоритетом</option>
                    <option value="status">За статусом</option>
                    <option value="assignee">За виконавцем</option>
                    <option value="title">За назвою</option>
                  </select>
                  <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Напрямок</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setSortDir("asc")} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer", background: sortDir === "asc" ? "#c5141c" : "var(--card-bg)", color: sortDir === "asc" ? "#fff" : "var(--text)", fontWeight: 600 }}>↑ Зрост.</button>
                    <button onClick={() => setSortDir("desc")} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer", background: sortDir === "desc" ? "#c5141c" : "var(--card-bg)", color: sortDir === "desc" ? "#fff" : "var(--text)", fontWeight: 600 }}>↓ Спад.</button>
                  </div>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "10px 0 0" }}>Виконані задачі завжди в кінці списку.</p>
                </div>
              </>
            )}
          </div>
          <button
            className="btn-primary"
            onClick={() => {
              // Default assignee = the creator themselves (still changeable).
              setTaskForm({ ...emptyTaskForm, assigneeId: currentManagerId ?? "" });
              setTaskModalOpen(true);
            }}
          >
            + Додати
          </button>
        </div>
      </div>

      {isAdmin && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button style={tabBtn(adminTab === "mine")} onClick={() => setAdminTab("mine")}>👤 Мої задачі</button>
          <button style={tabBtn(adminTab === "all")} onClick={() => setAdminTab("all")}>🗂️ Усі задачі</button>
        </div>
      )}

      {tasksLoading ? (
        <p className="loading-text">Завантаження...</p>
      ) : (
        <div className="chart-card">
          <table className="data-table tasks-table">
            <colgroup>
              <col style={{ width: "26%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "19%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "3%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Задачі</th>
                <th>Статус</th>
                <th>Дедлайн</th>
                <th>Виконавець</th>
                <th>Пріоритет</th>
                <th>Коментарі</th>
                <th>Департамент</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const q = taskSearch.trim().toLowerCase();
                let base = tasks;
                // Admin tab: «Мої» = personal tasks (created by me, no assignee); «Усі» = everything.
                if (isAdmin) {
                  base = adminTab === "mine"
                    ? tasks.filter((t) => t.createdById === currentUserId && t.assigneeId == null)
                    : tasks;
                }
                if (assigneeFilter !== "") base = base.filter((t) => t.assigneeId === assigneeFilter);
                if (statusFilter === "active") base = base.filter((t) => t.status !== "done");
                else if (statusFilter === "done") base = base.filter((t) => t.status === "done");
                const filtered = q
                  ? base.filter((t) =>
                      [t.title, t.comments, t.department, t.assigneeName]
                        .some((v) => (v ?? "").toLowerCase().includes(q))
                    )
                  : base;
                const prioRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
                const dir = sortDir === "asc" ? 1 : -1;
                const visible = [...filtered].sort((a, b) => {
                  // Done tasks always sink to the bottom, regardless of sort.
                  const ad = a.status === "done" ? 1 : 0, bd = b.status === "done" ? 1 : 0;
                  if (ad !== bd) return ad - bd;
                  let cmp: number;
                  switch (sortBy) {
                    case "deadline": cmp = (a.deadline ?? "9999-99-99").localeCompare(b.deadline ?? "9999-99-99"); break;
                    case "priority": cmp = (prioRank[a.priority] ?? 9) - (prioRank[b.priority] ?? 9); break;
                    case "status": cmp = a.status.localeCompare(b.status); break;
                    case "assignee": cmp = (a.assigneeName ?? "").localeCompare(b.assigneeName ?? "", "uk"); break;
                    case "title": cmp = (a.title ?? "").localeCompare(b.title ?? "", "uk"); break;
                    default: cmp = (a.createdAt ?? "").localeCompare(b.createdAt ?? ""); break;
                  }
                  return cmp * dir;
                });
                if (visible.length === 0) {
                  return (
                    <tr>
                      <td colSpan={8} className="loading-text">
                        {q ? "Нічого не знайдено." : "Задач немає."}
                      </td>
                    </tr>
                  );
                }
                return visible.map((task) => (
                  <tr key={task.id}>
                    <td style={{ verticalAlign: "top" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
                        <button
                          onClick={() => setOpenTaskId(task.id)}
                          title="Відкрити картку задачі"
                          style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", fontSize: 15, lineHeight: 1.4, padding: 0, opacity: 0.6 }}
                        >📄</button>
                        <AutoTextarea
                          value={task.title}
                          onLocal={(v) => patchTaskLocal(task.id, { title: v })}
                          onCommit={(v) => updateTask(task.id, { title: v })}
                        />
                      </div>
                      {task.metricsJson && task.metricsJson.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 22 }}>
                          {task.planDate ? `📅 ${task.planDate} · ` : ""}
                          {task.metricsJson.map((m) => `${METRIC_LBL[m.metric] ?? m.metric} ${m.actual ?? "—"}/${m.target}`).join(" · ")}
                        </div>
                      )}
                      {task.auto && task.targetValue != null && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 2 }}>
                          {task.planDate ? `📅 ${task.planDate} · ` : task.periodStart ? `📅 ${task.periodStart}…${task.periodEnd} · ` : ""}
                          🎯 {task.targetValue}
                          {task.metric === "conversion" ? "%" : task.metric === "avg_check" ? "₴" : ""}
                          {task.actualValue != null && (
                            <span style={{ color: Number(task.actualValue) >= Number(task.targetValue) ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
                              {" "}· факт {task.actualValue}
                              {task.metric === "conversion" ? "%" : task.metric === "avg_check" ? "₴" : ""}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <select
                        value={task.status}
                        onChange={(e) => {
                          const status = e.target.value as TaskStatus;
                          patchTaskLocal(task.id, { status });
                          updateTask(task.id, { status });
                        }}
                        style={statusPillStyle(task.status)}
                      >
                        {STATUS_GROUPS.map((group) => (
                          <optgroup key={group.label} label={group.label}>
                            {group.statuses.map((s) => (
                              <option key={s} value={s}>
                                {STATUS_LABELS[s]}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="date"
                        value={task.deadline ?? ""}
                        onChange={(e) => {
                          const deadline = e.target.value || null;
                          patchTaskLocal(task.id, { deadline });
                          updateTask(task.id, { deadline });
                        }}
                      />
                    </td>
                    <td>
                      <select
                        value={task.assigneeId ?? ""}
                        onChange={(e) => {
                          const assigneeId = e.target.value ? Number(e.target.value) : null;
                          const assigneeName =
                            managerOptions.find((m) => m.id === assigneeId)?.name ?? null;
                          patchTaskLocal(task.id, { assigneeId, assigneeName });
                          updateTask(task.id, { assigneeId });
                        }}
                      >
                        <option value="">—</option>
                        {managerOptions.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={task.priority}
                        onChange={(e) => {
                          const priority = e.target.value as TaskPriority;
                          patchTaskLocal(task.id, { priority });
                          updateTask(task.id, { priority });
                        }}
                        style={priorityPillStyle(task.priority)}
                      >
                        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ verticalAlign: "top" }}>
                      <AutoTextarea
                        value={task.comments ?? ""}
                        placeholder="—"
                        onLocal={(v) => patchTaskLocal(task.id, { comments: v })}
                        onCommit={(v) => updateTask(task.id, { comments: v })}
                      />
                    </td>
                    <td>
                      <select
                        value={task.department ?? ""}
                        onChange={(e) => {
                          const department = e.target.value || null;
                          patchTaskLocal(task.id, { department });
                          updateTask(task.id, { department });
                        }}
                        style={task.department ? deptPillStyle(task.department) : { border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", maxWidth: "100%" }}
                      >
                        <option value="">—</option>
                        {task.department && !deptOptions.includes(task.department) && (
                          <option value={task.department}>{task.department}</option>
                        )}
                        {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </td>
                    <td>
                      <button
                        onClick={() => handleDeleteTask(task.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-muted)",
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      )}

      {openTask && (
        <div onClick={() => setOpenTaskId(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 2500 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed", top: 0, right: 0, height: "100vh", width: "min(460px, 100vw)",
              background: "var(--card-bg, #fff)", color: "var(--text)", boxShadow: "-8px 0 32px rgba(0,0,0,0.22)",
              overflowY: "auto", padding: 24, zIndex: 2600,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
              <textarea
                value={openTask.title}
                onChange={(e) => patchTaskLocal(openTask.id, { title: e.target.value })}
                onBlur={(e) => updateTask(openTask.id, { title: e.target.value })}
                rows={Math.max(1, Math.ceil((openTask.title?.length ?? 0) / 34))}
                style={{ border: "none", width: "100%", resize: "vertical", font: "inherit", fontSize: 20, fontWeight: 700, background: "transparent", lineHeight: 1.3 }}
              />
              <button onClick={() => setOpenTaskId(null)} style={{ flexShrink: 0, background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: "var(--text)" }}>✕</button>
            </div>

            {(() => {
              const F = ({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) => (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 130, flexShrink: 0, color: "var(--text-muted)", fontSize: 13 }}>{icon} {label}</span>
                  <div style={{ flex: 1 }}>{children}</div>
                </div>
              );
              return (
                <>
                  <F icon="👤" label="Виконавець">
                    <select value={openTask.assigneeId ?? ""} onChange={(e) => { const assigneeId = e.target.value ? Number(e.target.value) : null; const assigneeName = managerOptions.find((m) => m.id === assigneeId)?.name ?? null; patchTaskLocal(openTask.id, { assigneeId, assigneeName }); updateTask(openTask.id, { assigneeId }); }} style={{ width: "100%" }}>
                      <option value="">— (моя / без виконавця)</option>
                      {managerOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </F>
                  <F icon="📅" label="Дедлайн">
                    <input type="date" value={openTask.deadline ?? ""} onChange={(e) => { const deadline = e.target.value || null; patchTaskLocal(openTask.id, { deadline }); updateTask(openTask.id, { deadline }); }} />
                  </F>
                  <F icon="🏷️" label="Департамент">
                    <select value={openTask.department ?? ""} onChange={(e) => { const department = e.target.value || null; patchTaskLocal(openTask.id, { department }); updateTask(openTask.id, { department }); }} style={{ width: "100%" }}>
                      <option value="">—</option>
                      {openTask.department && !deptOptions.includes(openTask.department) && (
                        <option value={openTask.department}>{openTask.department}</option>
                      )}
                      {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </F>
                  <F icon="⚑" label="Пріоритет">
                    <select value={openTask.priority} onChange={(e) => { const priority = e.target.value as TaskPriority; patchTaskLocal(openTask.id, { priority }); updateTask(openTask.id, { priority }); }} style={{ width: "100%" }}>
                      {Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </F>
                  <F icon="◔" label="Статус">
                    <select value={openTask.status} onChange={(e) => { const status = e.target.value as TaskStatus; patchTaskLocal(openTask.id, { status }); updateTask(openTask.id, { status }); }} style={{ width: "100%" }}>
                      {STATUS_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.statuses.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</optgroup>)}
                    </select>
                  </F>
                </>
              );
            })()}

            {openTask.metricsJson && openTask.metricsJson.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>🎯 Факт по показниках {openTask.planDate ? `(${openTask.planDate})` : ""}</h3>
                <table className="data-table compact" style={{ width: "100%" }}>
                  <thead><tr><th style={{ textAlign: "left" }}>Показник</th><th style={{ textAlign: "right" }}>Ціль</th><th style={{ textAlign: "right" }}>Факт</th><th style={{ textAlign: "center" }}>✓</th></tr></thead>
                  <tbody>
                    {openTask.metricsJson.map((m) => {
                      const u = METRIC_UNIT[m.metric] ?? "";
                      return (
                        <tr key={m.metric}>
                          <td style={{ textAlign: "left" }}>{METRIC_LBL[m.metric] ?? m.metric}</td>
                          <td style={{ textAlign: "right" }}>{m.target}{u}</td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>{m.actual == null ? "—" : `${m.actual}${u}`}</td>
                          <td style={{ textAlign: "center" }}>{m.actual == null ? "⏳" : m.done ? "✅" : "❌"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Факт підтягується автоматично з CRM після завершення дня. Задача закривається сама, коли всі показники виконані.</p>
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 6px" }}>💬 Коментарі</h3>
              <textarea
                value={openTask.comments ?? ""}
                placeholder="Додати коментар…"
                onChange={(e) => patchTaskLocal(openTask.id, { comments: e.target.value })}
                onBlur={(e) => updateTask(openTask.id, { comments: e.target.value })}
                rows={5}
                style={{ width: "100%", resize: "vertical", font: "inherit", padding: 10, lineHeight: 1.5, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}
              />
            </div>

            <div style={{ marginTop: 18, textAlign: "right" }}>
              <button onClick={() => { handleDeleteTask(openTask.id); setOpenTaskId(null); }} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 12px", color: "#dc2626", cursor: "pointer" }}>🗑 Видалити</button>
            </div>
          </div>
        </div>
      )}

      {taskModalOpen && (
        <div
          onClick={() => setTaskModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            zIndex: 2000,
            padding: "60px 16px",
            overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="chart-card"
            style={{ width: "100%", maxWidth: 560, background: "var(--card-bg, #fff)" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Нова задача</h2>
              <button
                onClick={() => setTaskModalOpen(false)}
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)" }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Тип задачі
                <select
                  value={taskForm.taskType}
                  onChange={(e) => setTaskForm((f) => ({ ...f, taskType: e.target.value as typeof f.taskType }))}
                >
                  <option value="simple">Звичайна</option>
                  <option value="weekly_kpi">Тижневий план (KPI)</option>
                  <option value="monthly_kpi">Місячний план (KPI)</option>
                  {(role === "admin" || role === "team_lead") && <option value="reactivation">🔄 Реактивація клієнтів</option>}
                </select>
              </label>

              {taskForm.taskType === "reactivation" ? (
                <ReactivationPlanner
                  teams={teams}
                  canPickTeam={role === "admin"}
                  onDone={async () => { await refreshTasks?.(); setTaskForm(emptyTaskForm); setTaskModalOpen(false); }}
                />
              ) : taskForm.taskType === "simple" ? (
                <>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                    Опис задачі
                    <textarea
                      autoFocus
                      value={taskForm.title}
                      onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))}
                      rows={4}
                      placeholder="Опишіть задачу детально…"
                      style={{ width: "100%", resize: "vertical", font: "inherit", padding: 8, lineHeight: 1.4 }}
                    />
                  </label>

                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 150 }}>
                      Дедлайн
                      <input
                        type="date"
                        value={taskForm.deadline}
                        onChange={(e) => setTaskForm((f) => ({ ...f, deadline: e.target.value }))}
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 150 }}>
                      Пріоритет
                      <select
                        value={taskForm.priority}
                        onChange={(e) => setTaskForm((f) => ({ ...f, priority: e.target.value as TaskPriority }))}
                      >
                        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              ) : (
                <>
                  {taskForm.taskType === "weekly_kpi" ? (
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                        Період: від
                        <input type="date" value={taskForm.rangeFrom}
                          onChange={(e) => setTaskForm((f) => ({ ...f, rangeFrom: e.target.value }))} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                        до
                        <input type="date" value={taskForm.rangeTo}
                          onChange={(e) => setTaskForm((f) => ({ ...f, rangeTo: e.target.value }))} />
                      </label>
                    </div>
                  ) : (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                      Дата (будь-який день місяця плану)
                      <input
                        type="date"
                        value={taskForm.weekStart}
                        onChange={(e) => setTaskForm((f) => ({ ...f, weekStart: e.target.value }))}
                      />
                    </label>
                  )}
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Робочі дні (на них розкладається план):</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].map((d, i) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() =>
                          setTaskForm((f) => {
                            const wd = [...f.weekdays];
                            wd[i] = !wd[i];
                            return { ...f, weekdays: wd };
                          })
                        }
                        style={{
                          padding: "5px 12px",
                          borderRadius: 16,
                          border: `1px solid ${taskForm.weekdays[i] ? "#c5141c" : "#d0d5dd"}`,
                          background: taskForm.weekdays[i] ? "#c5141c" : "#fff",
                          color: taskForm.weekdays[i] ? "#fff" : "#344054",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Цілі (заповніть потрібні):</div>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                      К-сть реклами (за період)
                      <input
                        type="number"
                        value={taskForm.adsCount}
                        onChange={(e) => setTaskForm((f) => ({ ...f, adsCount: e.target.value }))}
                        placeholder="напр. 25"
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                      К-сть лідогенів (РПК)
                      <input
                        type="number"
                        value={taskForm.leadgenCount}
                        onChange={(e) => setTaskForm((f) => ({ ...f, leadgenCount: e.target.value }))}
                        placeholder="напр. 40"
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                      К-сть авто (поставити)
                      <input
                        type="number"
                        value={taskForm.dispatchCount}
                        onChange={(e) => setTaskForm((f) => ({ ...f, dispatchCount: e.target.value }))}
                        placeholder="напр. 5"
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                      Середній чек, ₴
                      <input
                        type="number"
                        value={taskForm.avgCheck}
                        onChange={(e) => setTaskForm((f) => ({ ...f, avgCheck: e.target.value }))}
                        placeholder="напр. 5000"
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 140 }}>
                      Конверсія, %
                      <input
                        type="number"
                        value={taskForm.conversion}
                        onChange={(e) => setTaskForm((f) => ({ ...f, conversion: e.target.value }))}
                        placeholder="напр. 30"
                      />
                    </label>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    К-сть реклами розкладеться по обраних днях у задачник менеджера й закриється автоматично за фактом.
                    Чек і конверсія оцінюються підсумком за {taskForm.taskType === "weekly_kpi" ? "тиждень" : "місяць"}.
                  </div>
                </>
              )}

              {taskForm.taskType !== "reactivation" && (<>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 150 }}>
                  Виконавець{taskForm.taskType !== "simple" ? " (менеджер)" : ""}
                  <select
                    value={taskForm.assigneeId}
                    onChange={(e) =>
                      setTaskForm((f) => ({ ...f, assigneeId: e.target.value === "" ? "" : Number(e.target.value) }))
                    }
                  >
                    <option value="">—</option>
                    {managerOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                {taskForm.taskType === "simple" && (
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 150 }}>
                    Департамент
                    <select
                      value={taskForm.department}
                      onChange={(e) => setTaskForm((f) => ({ ...f, department: e.target.value }))}
                    >
                      <option value="">—</option>
                      {taskForm.department && !deptOptions.includes(taskForm.department) && (
                        <option value={taskForm.department}>{taskForm.department}</option>
                      )}
                      {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </label>
                )}
              </div>

              {taskForm.taskType === "simple" && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  Коментарі
                  <textarea
                    value={taskForm.comments}
                    onChange={(e) => setTaskForm((f) => ({ ...f, comments: e.target.value }))}
                    rows={2}
                    style={{ width: "100%", resize: "vertical", font: "inherit", padding: 8, lineHeight: 1.4 }}
                  />
                </label>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button onClick={() => setTaskModalOpen(false)}>Скасувати</button>
                <button
                  className="btn-primary"
                  onClick={handleSubmitTaskModal}
                  disabled={taskForm.taskType === "simple" && !taskForm.title.trim()}
                >
                  {taskForm.taskType === "simple" ? "Створити задачу" : "Поставити план"}
                </button>
              </div>
              </>)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Reactivation planner (team-lead/admin): the dashboard proposes former good
 * clients (3+ paid) who went quiet, grouped by their manager; the team lead
 * ticks whom to reactivate and each becomes a task assigned to that manager.
 */
function ReactivationPlanner({ teams, canPickTeam, onDone }: {
  teams?: Team[]; canPickTeam: boolean; onDone: () => Promise<void>;
}) {
  const [teamId, setTeamId] = useState<number | "">("");
  const [data, setData] = useState<ReactivationManager[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    setData(null);
    fetchReactivationCandidates(teamId ? Number(teamId) : undefined)
      .then(setData)
      .catch(() => setData([]));
  }, [teamId]);

  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const daysSince = (d: string | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);

  const createTasks = async () => {
    if (!data || picked.size === 0) return;
    setBusy(true);
    try {
      let created = 0;
      for (const mgr of data) {
        for (const c of mgr.clients) {
          if (!picked.has(c.clientKey)) continue;
          const last = c.lastPaid ? new Date(c.lastPaid).toLocaleDateString("uk-UA") : "—";
          await createTask({
            title: `🔄 Реактивація: ${c.clientName}`,
            assigneeId: mgr.managerId,
            priority: "high",
            department: "Реактивація",
            comments: `Постійний клієнт, що замовк. Перевезень: ${c.orders}, напрацював ${formatAmount(c.revenue)}. Остання оплата: ${last}. Звʼязатися й повернути в роботу.`,
          });
          created++;
        }
      }
      setDone(created);
      await onDone();
    } finally { setBusy(false); }
  };

  const totalCandidates = data?.reduce((s, m) => s + m.clients.length, 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
        Дашборд пропонує колишніх хороших клієнтів (<b>3+ перевезень</b>), які <b>давно не замовляли</b> і <b>не є боржниками</b>, по кожному менеджеру. Відзначте, кого віддати в реактивацію — кожен стане окремою задачею для менеджера.
      </p>
      {canPickTeam && (
        <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
          style={{ alignSelf: "flex-start", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)" }}>
          <option value="">Усі команди</option>
          {(teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      {done != null ? (
        <p style={{ color: "#16a34a", fontWeight: 600 }}>✓ Створено {done} задач(і) на реактивацію.</p>
      ) : data === null ? (
        <p className="loading-text">Пошук кандидатів…</p>
      ) : totalCandidates === 0 ? (
        <p className="loading-text">Немає кандидатів на реактивацію (усі активні або в дебіторці).</p>
      ) : (
        <>
          <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
            {data.filter((m) => m.clients.length > 0).map((m) => (
              <div key={m.managerId} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, margin: "4px 0" }}>{m.managerName} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({m.clients.length})</span></div>
                {m.clients.map((c) => {
                  const ds = daysSince(c.lastPaid);
                  return (
                    <label key={c.clientKey} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={picked.has(c.clientKey)} onChange={() => toggle(c.clientKey)} />
                      <span style={{ flex: 1 }}>{c.isCompany ? "🏢" : "👤"} {c.clientName}</span>
                      <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{c.orders} перевез. · {formatAmount(c.revenue)} · без замовлень {ds ?? "?"} дн.</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <span style={{ alignSelf: "center", fontSize: 12, color: "var(--text-muted)" }}>Обрано: {picked.size}</span>
            <button className="btn-primary" onClick={createTasks} disabled={busy || picked.size === 0}>
              {busy ? "Створення…" : `Створити задачі (${picked.size})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
