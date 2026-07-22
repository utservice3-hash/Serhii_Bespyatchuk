import { useLayoutEffect, useRef, useState, useEffect, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import {
  updateTask,
  createReactivationTask,
  fetchReactivationCandidates,
  type ManagerOption,
  type ReactivationManager,
  type Task,
  type TaskPriority,
  type Team,
  type Subtask,
} from "../../../api";
import { PRIORITY_LABELS } from "../constants";
import { CommentField } from "../../../components/CommentField";

/** Підзадачі задачі — довільний чекліст, кожен пункт трекається виконано/ні.
 *  Зберігається on-change у tasks.subtasks_json. */
function SubtasksEditor({ task, patchTaskLocal }: { task: Task; patchTaskLocal: (id: number, patch: Partial<Task>) => void }) {
  const list: Subtask[] = task.subtasksJson ?? [];
  const [draft, setDraft] = useState("");
  const save = (next: Subtask[]) => { patchTaskLocal(task.id, { subtasksJson: next }); updateTask(task.id, { subtasksJson: next }); };
  const done = list.filter((s) => s.done).length;
  const add = () => { const t = draft.trim(); if (!t) return; save([...list, { title: t, done: false }]); setDraft(""); };
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 6px" }}>
        ✅ Підзадачі {list.length > 0 && <span style={{ color: done === list.length ? "#16a34a" : "var(--text-muted)" }}>({done}/{list.length})</span>}
      </h3>
      {list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {list.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={!!s.done} onChange={() => save(list.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} />
              <span style={{ flex: 1, textDecoration: s.done ? "line-through" : "none", opacity: s.done ? 0.6 : 1 }}>{s.title}</span>
              <button onClick={() => save(list.filter((_, j) => j !== i))} title="Прибрати" style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer" }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="Нова підзадача…" style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 13 }} />
        <button onClick={add} disabled={!draft.trim()} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: draft.trim() ? "#c5141c" : "var(--border)", color: "#fff", cursor: draft.trim() ? "pointer" : "default", fontSize: 13 }}>+ Додати</button>
      </div>
    </div>
  );
}
import { formatAmount } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { StatusPicker } from "../../../components/StatusPicker";
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
// Адитивні метрики (сумуються по днях у шапку парасольки); чек/конверсія — ставкові (по днях).
const ADDITIVE_METRICS = new Set(["ads_count", "leadgen_count", "dispatch_count", "payment_amount"]);

/** hex → rgba with alpha, for soft Notion-style pill backgrounds. */
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
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
  onOpenGoals,
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
  onOpenGoals?: () => void;
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
  const [expandedKpi, setExpandedKpi] = useState<Set<number>>(new Set());
  const toggleKpi = (id: number) => setExpandedKpi((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

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
          {(role === "admin" || role === "team_lead") && onOpenGoals && (
            <button onClick={onOpenGoals} title="Місячні цілі"
              style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontWeight: 600 }}>
              🎯 Місячні цілі
            </button>
          )}
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
              <col style={{ width: "25%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
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
                // Діти KPI-періоду (parentId) НЕ показуємо окремими рядками —
                // вони в розкривному списку своєї задачі-парасольки.
                const childrenOf = (id: number) => tasks.filter((t) => t.parentId === id)
                  .sort((a, b) => (a.planDate ?? "").localeCompare(b.planDate ?? ""));
                let base = tasks.filter((t) => t.parentId == null);
                // Admin tab: «Мої» = personal tasks — assigned to my own account OR
                // created by me without an assignee; «Усі» = everything.
                if (isAdmin) {
                  base = adminTab === "mine"
                    ? base.filter((t) => t.assigneeId === currentManagerId || (t.createdById === currentUserId && t.assigneeId == null))
                    : base;
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
                    case "status": cmp = (a.status ?? "").localeCompare(b.status ?? ""); break;
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
                      {task.metricsJson && task.metricsJson.length > 0 && task.taskType !== "kpi_period" && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 22, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                          {task.planDate ? <span>📅 {task.planDate}</span> : null}
                          {task.metricsJson.map((m, i) => {
                            const icon = m.actual == null ? "⏳" : m.done ? "✅" : "❌";
                            return (
                              <span key={i} title={m.done ? "виконано" : m.actual == null ? "попереду" : "не виконано"}>
                                {icon} {METRIC_LBL[m.metric] ?? m.metric}{" "}
                                <b style={{ color: m.done ? "#16a34a" : m.actual == null ? "var(--text-muted)" : "#dc2626" }}>{m.actual ?? "—"}</b>/{m.target}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {task.taskType === "kpi_period" && (() => {
                        const kids = childrenOf(task.id);
                        if (kids.length === 0) return null;
                        const open = expandedKpi.has(task.id);
                        const doneN = kids.filter((k) => k.status === "done").length;
                        // Агрегація дітей у шапку (FE, дані не чіпаємо): адитивні = Σ факту дітей vs
                        // ціль парасольки; ставкові (чек/конв) = лише ціль + «по днях» (рішення власника).
                        const summary = (task.metricsJson ?? []).map((um) => {
                          if (ADDITIVE_METRICS.has(um.metric)) {
                            let fact = 0, has = false;
                            for (const kid of kids) {
                              const cm = (kid.metricsJson ?? []).find((x) => x.metric === um.metric);
                              if (cm && cm.actual != null) { fact += cm.actual; has = true; }
                            }
                            return { metric: um.metric, target: um.target, fact: has ? fact : null, additive: true, done: has && fact >= um.target };
                          }
                          return { metric: um.metric, target: um.target, fact: null, additive: false, done: false };
                        });
                        return (
                          <div style={{ paddingLeft: 22, marginTop: 4 }}>
                            {/* період + виконавець */}
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
                              📅 {task.periodStart}…{task.periodEnd}{task.assigneeName ? ` · 👤 ${task.assigneeName}` : ""}
                            </div>
                            {/* шапка: 6 KPI факт/ціль (адитивні Σ; ставкові — ціль + по днях) */}
                            <div style={{ fontSize: 11, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 4 }}>
                              {summary.map((s, i) => {
                                const unit = METRIC_UNIT[s.metric] ?? "";
                                if (!s.additive) {
                                  return <span key={i} style={{ color: "var(--text-muted)" }} title="ставкова метрика — факт по днях у розгортанні">🎯 {METRIC_LBL[s.metric] ?? s.metric} <b>{s.target}{unit}</b> <i>· по днях</i></span>;
                                }
                                const icon = s.fact == null ? "⏳" : s.done ? "✅" : "❌";
                                return (
                                  <span key={i} title={s.done ? "виконано" : s.fact == null ? "попереду" : "не виконано"}>
                                    {icon} {METRIC_LBL[s.metric] ?? s.metric}{" "}
                                    <b style={{ color: s.done ? "#16a34a" : s.fact == null ? "var(--text-muted)" : "#dc2626" }}>{s.fact ?? "—"}</b>/{s.target}{unit}
                                  </span>
                                );
                              })}
                            </div>
                            <button onClick={() => toggleKpi(task.id)}
                              style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text)", font: "inherit", fontSize: 12, fontWeight: 600, padding: 0 }}>
                              {open ? "▾" : "▸"} Дні плану: {doneN}/{kids.length} виконано
                            </button>
                            {open && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                                {kids.map((k) => {
                                  const allDone = k.status === "done";
                                  return (
                                    <div key={k.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 11, borderLeft: `3px solid ${allDone ? "#16a34a" : "var(--border)"}`, paddingLeft: 8 }}>
                                      <span style={{ fontWeight: 600, minWidth: 84 }}>{allDone ? "✅" : "⬜"} {k.planDate}</span>
                                      {(k.metricsJson ?? []).map((m, i) => {
                                        const icon = m.actual == null ? "⏳" : m.done ? "✅" : "❌";
                                        return (
                                          <span key={i} title={m.done ? "виконано" : m.actual == null ? "попереду" : "не виконано"}>
                                            {icon} {METRIC_LBL[m.metric] ?? m.metric}{" "}
                                            <b style={{ color: m.done ? "#16a34a" : m.actual == null ? "var(--text-muted)" : "#dc2626" }}>{m.actual ?? "—"}</b>/{m.target}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {task.checklistJson && task.checklistJson.length > 0 && (() => {
                        const list = task.checklistJson;
                        const doneN = list.filter((c) => c.done).length;
                        return (
                          <div style={{ paddingLeft: 22, marginTop: 4, display: "flex", flexDirection: "column", gap: 6 }}>
                            {list.map((c, i) => (
                              <div key={c.clientKey} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                                  <input type="checkbox" checked={!!c.done} onChange={() => {
                                    const next = list.map((x, j) => (j === i ? { ...x, done: !x.done } : x));
                                    patchTaskLocal(task.id, { checklistJson: next });
                                    updateTask(task.id, { checklistJson: next });
                                  }} />
                                  <span style={{ flex: 1, textDecoration: c.done ? "line-through" : "none", opacity: c.done ? 0.55 : 1 }}>🏢 {c.clientName}</span>
                                  <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                                    {c.category === "oneshot_bg" ? "1 перевез. (б/г)" : "замовклий"}{c.orders != null ? ` · ${c.orders} перевез.` : ""}
                                  </span>
                                </label>
                                {/* Коментар менеджера НАВПРОТИ КОЖНОГО клієнта (результат дзвінка). */}
                                <div style={{ marginLeft: 22 }}>
                                  <CommentField
                                    value={c.comment}
                                    placeholder="Коментар по клієнту (результат дзвінка)…"
                                    onSave={(next) => {
                                      const v = next.trim() || null;
                                      if (v === (c.comment ?? null)) return;
                                      const updated = list.map((x, j) => (j === i ? { ...x, comment: v } : x));
                                      patchTaskLocal(task.id, { checklistJson: updated });
                                      updateTask(task.id, { checklistJson: updated });
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                            <span style={{ fontSize: 11, color: doneN === list.length ? "#16a34a" : "var(--text-muted)", fontWeight: 600 }}>
                              Опрацьовано {doneN}/{list.length}
                            </span>
                          </div>
                        );
                      })()}
                      {task.subtasksJson && task.subtasksJson.length > 0 && (() => {
                        const sd = task.subtasksJson.filter((s) => s.done).length;
                        const n = task.subtasksJson.length;
                        return (
                          <span style={{ fontSize: 11, fontWeight: 600, color: sd === n ? "#16a34a" : "var(--text-muted)", background: "rgba(127,127,127,0.1)", borderRadius: 999, padding: "1px 8px", marginLeft: 2 }} title={task.subtasksJson.map((s) => `${s.done ? "✅" : "⬜"} ${s.title}`).join("\n")}>
                            ✅ {sd}/{n} підзадач
                          </span>
                        );
                      })()}
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
                      <StatusPicker
                        value={task.status}
                        onChange={(status) => {
                          patchTaskLocal(task.id, { status });
                          updateTask(task.id, { status });
                        }}
                      />
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
                    <StatusPicker value={openTask.status} fullWidth
                      onChange={(status) => { patchTaskLocal(openTask.id, { status }); updateTask(openTask.id, { status }); }} />
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

            <SubtasksEditor task={openTask} patchTaskLocal={patchTaskLocal} />

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
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        {([["range", "📅 Період"], ["day", "🎯 Один день"]] as const).map(([k, lbl]) => (
                          <button key={k} type="button" onClick={() => setTaskForm((f) => ({ ...f, planScope: k }))}
                            style={{ padding: "6px 13px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: taskForm.planScope === k ? 700 : 500,
                              border: `1px solid ${taskForm.planScope === k ? "#c5141c" : "#d0d5dd"}`,
                              background: taskForm.planScope === k ? "#c5141c" : "var(--card-bg)", color: taskForm.planScope === k ? "#fff" : "var(--text)" }}>
                            {lbl}
                          </button>
                        ))}
                      </div>
                      {taskForm.planScope === "day" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                          День задачі
                          <DatePicker value={taskForm.rangeFrom} onChange={(v) => setTaskForm((f) => ({ ...f, rangeFrom: v, rangeTo: v }))} placeholder="дата" minWidth={140} />
                        </div>
                      ) : (
                        <>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                            Період: від
                            <DatePicker value={taskForm.rangeFrom} onChange={(v) => setTaskForm((f) => ({ ...f, rangeFrom: v }))} placeholder="від" minWidth={130} />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                            до
                            <DatePicker value={taskForm.rangeTo} onChange={(v) => setTaskForm((f) => ({ ...f, rangeTo: v }))} placeholder="до" minWidth={130} />
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                      Дата (будь-який день місяця плану)
                      <DatePicker value={taskForm.weekStart} onChange={(v) => setTaskForm((f) => ({ ...f, weekStart: v }))} minWidth={150} />
                    </div>
                  )}
                  {!(taskForm.taskType === "weekly_kpi" && taskForm.planScope === "day") && (<>
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
                  </>)}
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
                      К-сть лідогенів (РПК/РНК)
                      <input
                        type="number"
                        value={taskForm.leadgenCount}
                        onChange={(e) => setTaskForm((f) => ({ ...f, leadgenCount: e.target.value }))}
                        placeholder="напр. 40"
                        title="Прийнято заявок від лідогенераторів (переданих і взятих у роботу менеджером — з Реєстру лідоген-бота). Доступно і для РНК, і для РПК."
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
                      💰 Сума до принесення, ₴
                      <input
                        type="number"
                        value={taskForm.paymentAmount}
                        onChange={(e) => setTaskForm((f) => ({ ...f, paymentAmount: e.target.value }))}
                        placeholder="за період; напр. 80000"
                        title="Скільки менеджер має принести за період — розкладеться по днях. Якщо порожньо — береться з місячного плану виручки."
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
                  {role === "manager" ? (
                    // Менеджер ставить план/задачу ЛИШЕ собі — виконавець зафіксований.
                    <div style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-subtle, rgba(127,127,127,0.06))", color: "var(--text-muted)" }}>
                      Ви (собі)
                    </div>
                  ) : (
                    <select
                      value={taskForm.assigneeId}
                      onChange={(e) =>
                        setTaskForm((f) => ({ ...f, assigneeId: e.target.value === "" ? "" : Number(e.target.value) }))
                      }
                    >
                      <option value="">—</option>
                      {(() => {
                        // Group managers by team: team names as <optgroup>, managers under.
                        const byTeam = new Map<string, typeof managerOptions>();
                        for (const m of managerOptions) {
                          const key = m.teamName ?? "Без команди";
                          if (!byTeam.has(key)) byTeam.set(key, []);
                          byTeam.get(key)!.push(m);
                        }
                        return [...byTeam.entries()].map(([team, mgrs]) => (
                          <optgroup key={team} label={team}>
                            {mgrs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </optgroup>
                        ));
                      })()}
                    </select>
                  )}
                </label>
                {taskForm.taskType === "simple" && role !== "manager" && (
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 150 }}>
                    2-й виконавець (необовʼязково)
                    <select
                      value={taskForm.assigneeId2}
                      onChange={(e) => setTaskForm((f) => ({ ...f, assigneeId2: e.target.value === "" ? "" : Number(e.target.value) }))}
                      title="Задача одразу для двох менеджерів — створиться копія кожному"
                    >
                      <option value="">— (одному)</option>
                      {(() => {
                        const byTeam = new Map<string, typeof managerOptions>();
                        for (const m of managerOptions) {
                          if (m.id === taskForm.assigneeId) continue;
                          const key = m.teamName ?? "Без команди";
                          if (!byTeam.has(key)) byTeam.set(key, []);
                          byTeam.get(key)!.push(m);
                        }
                        return [...byTeam.entries()].map(([team, mgrs]) => (
                          <optgroup key={team} label={team}>
                            {mgrs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </optgroup>
                        ));
                      })()}
                    </select>
                  </label>
                )}
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
      // ONE task per manager, bundling their picked clients as a checklist.
      let created = 0;
      for (const mgr of data) {
        const clients = mgr.clients.filter((c) => picked.has(c.clientKey));
        if (clients.length === 0) continue;
        await createReactivationTask(mgr.managerId, clients.map((c) => ({
          clientKey: c.clientKey, clientName: c.clientName, orders: c.orders,
          revenue: c.revenue, lastPaid: c.lastPaid, category: c.category, paymentType: c.paymentType,
        })));
        created++;
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
                  const oneshot = c.category === "oneshot_bg";
                  const bgLabel = oneshot ? (/без/i.test(c.paymentType ?? "") ? "1 перевез. · б/г без ПДВ" : /НДС|ПДВ/i.test(c.paymentType ?? "") ? "1 перевез. · б/г з ПДВ" : "1 перевез. (б/г)") : "замовклий 3+";
                  return (
                    <label key={c.clientKey} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={picked.has(c.clientKey)} onChange={() => toggle(c.clientKey)} />
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, whiteSpace: "nowrap", background: oneshot ? "#dbeafe" : "#fef3c7", color: oneshot ? "#1d4ed8" : "#b45309" }}>
                        {bgLabel}
                      </span>
                      <span style={{ flex: 1 }}>🏢 {c.clientName}</span>
                      <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{c.orders} перевез. · {formatAmount(c.revenue)}{oneshot ? "" : ` · без замовлень ${ds ?? "?"} дн.`}</span>
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
