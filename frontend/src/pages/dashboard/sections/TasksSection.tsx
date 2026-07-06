import { useState, type Dispatch, type SetStateAction } from "react";
import {
  updateTask,
  type ManagerOption,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../../api";
import { STATUS_DOT_COLORS, STATUS_GROUPS, STATUS_LABELS, PRIORITY_LABELS } from "../constants";
import type { TaskForm } from "../taskForm";

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
  role,
  currentUserId,
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
  role?: string;
  currentUserId?: number;
}) {
  const isAdmin = role === "admin";
  const [adminTab, setAdminTab] = useState<"mine" | "all">("mine");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "done">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<number | "">("");

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
          <button
            className="btn-primary"
            onClick={() => {
              setTaskForm(emptyTaskForm);
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
              <col style={{ width: "30%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "11%" }} />
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
                const visible = q
                  ? base.filter((t) =>
                      [t.title, t.comments, t.department, t.assigneeName]
                        .some((v) => (v ?? "").toLowerCase().includes(q))
                    )
                  : base;
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
                      <textarea
                        value={task.title}
                        onChange={(e) => patchTaskLocal(task.id, { title: e.target.value })}
                        onBlur={(e) => updateTask(task.id, { title: e.target.value })}
                        rows={Math.max(1, Math.ceil((task.title?.length ?? 0) / 40))}
                        style={{
                          border: "none",
                          width: "100%",
                          resize: "vertical",
                          font: "inherit",
                          background: "transparent",
                          lineHeight: 1.4,
                          overflow: "hidden",
                        }}
                      />
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
                      <div className="task-status-cell">
                        <span
                          className="task-status-dot"
                          style={{ background: STATUS_DOT_COLORS[task.status] }}
                        />
                        <select
                          value={task.status}
                          onChange={(e) => {
                            const status = e.target.value as TaskStatus;
                            patchTaskLocal(task.id, { status });
                            updateTask(task.id, { status });
                          }}
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
                      </div>
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
                      >
                        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={task.comments ?? ""}
                        placeholder="—"
                        onChange={(e) => patchTaskLocal(task.id, { comments: e.target.value })}
                        onBlur={(e) => updateTask(task.id, { comments: e.target.value })}
                        style={{ border: "none", width: "100%" }}
                      />
                    </td>
                    <td>
                      <input
                        value={task.department ?? ""}
                        placeholder="—"
                        onChange={(e) => patchTaskLocal(task.id, { department: e.target.value })}
                        onBlur={(e) => updateTask(task.id, { department: e.target.value })}
                        style={{ border: "none", width: "100%" }}
                      />
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
                </select>
              </label>

              {taskForm.taskType === "simple" ? (
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
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                    {taskForm.taskType === "weekly_kpi" ? "Дата (будь-який день тижня плану)" : "Дата (будь-який день місяця плану)"}
                    <input
                      type="date"
                      value={taskForm.weekStart}
                      onChange={(e) => setTaskForm((f) => ({ ...f, weekStart: e.target.value }))}
                    />
                  </label>
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
                    <input
                      value={taskForm.department}
                      onChange={(e) => setTaskForm((f) => ({ ...f, department: e.target.value }))}
                      placeholder="напр. Продзвін"
                    />
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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
