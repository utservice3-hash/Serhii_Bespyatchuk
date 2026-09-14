import { useLayoutEffect, useRef, useState, useEffect, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import {
  createReactivationTask,
  fetchReactivationCandidates,
  fetchTaskGroups, createTaskGroup, deleteTaskGroup,
  fetchTaskComments, createTaskComment, fetchTaskHistory,
  fetchTaskFiles, uploadTaskFile, deleteTaskFile, fetchTaskFileBlobUrl,
  markTaskSeen, fetchTaskAssignees,
  TASK_FILE_MAX_BYTES, TASK_FILES_PER_TASK,
  type ManagerOption,
  type ReactivationManager,
  type Task,
  type TaskPriority,
  type Team,
  type Subtask,
  type TaskGroup,
  type TaskComment,
  type TaskFile,
  type TaskHistoryEntry,
  type TaskAssignee,
} from "../../../api";
import { PRIORITY_LABELS } from "../constants";
import { CommentField } from "../../../components/CommentField";

/** Підзадачі задачі — довільний чекліст, кожен пункт трекається виконано/ні.
 *  Зберігається on-change у tasks.subtasks_json. */
function SubtasksEditor({ task, patchTaskLocal, commitTask }: { task: Task; patchTaskLocal: (id: number, patch: Partial<Task>) => void; commitTask: (id: number, patch: Partial<Task>) => void }) {
  const list: Subtask[] = task.subtasksJson ?? [];
  const [draft, setDraft] = useState("");
  const save = (next: Subtask[]) => { patchTaskLocal(task.id, { subtasksJson: next }); commitTask(task.id, { subtasksJson: next }); };
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

// ── дати (Пн–Нд, UTC) для синтетичних парасольок сиріт-daily_kpi ──
const tMondayOf = (s: string) => { const d = new Date(s + "T00:00:00Z"); const w = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (w - 1)); return d.toISOString().slice(0, 10); };
const tAddDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tDdmm = (s: string) => s.slice(8) + "." + s.slice(5, 7);

type MetricJ = { metric: string; target: number; actual: number | null; done: boolean };
type UmbSummaryRow = { metric: string; additive: boolean; fact: number | null; target: number | null; done: boolean };
/**
 * Агрегація дітей у шапку парасольки — СПІЛЬНА для реальної kpi_period і синтетичної
 * (сироти). ownMetrics=metrics_json парасольки (реальна) → ціль = таргет парасольки;
 * ownMetrics=null (синтетична) → набір метрик з дітей, адитивна ціль = Σ денних target.
 * Адитивні (реклама/лідоген/авто/сума): факт = Σ денних actual. Ставкові (чек/конв): по днях.
 */
function buildUmbrellaSummary(children: Task[], ownMetrics: MetricJ[] | null): UmbSummaryRow[] {
  const keys = ownMetrics
    ? ownMetrics.map((m) => m.metric)
    : [...new Set(children.flatMap((k) => (k.metricsJson ?? []).map((m) => m.metric)))];
  return keys.map((metric) => {
    if (ADDITIVE_METRICS.has(metric)) {
      let fact = 0, has = false, sumT = 0;
      for (const k of children) {
        const cm = (k.metricsJson ?? []).find((x) => x.metric === metric);
        if (cm) { if (cm.actual != null) { fact += cm.actual; has = true; } sumT += cm.target; }
      }
      const target = ownMetrics ? (ownMetrics.find((m) => m.metric === metric)?.target ?? 0) : sumT;
      return { metric, additive: true, fact: has ? fact : null, target, done: has && fact >= target };
    }
    const target = ownMetrics ? (ownMetrics.find((m) => m.metric === metric)?.target ?? null) : null;
    return { metric, additive: false, fact: null, target, done: false };
  });
}
// Рядок 6 KPI у шапці парасольки (спільний для реальної та синтетичної).
function UmbSummary({ rows }: { rows: UmbSummaryRow[] }) {
  return (
    <div style={{ fontSize: 11, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 4 }}>
      {rows.map((s, i) => {
        const unit = METRIC_UNIT[s.metric] ?? "";
        if (!s.additive) {
          return <span key={i} style={{ color: "var(--text-muted)" }} title="ставкова метрика — факт по днях у розгортанні">🎯 {METRIC_LBL[s.metric] ?? s.metric}{s.target != null ? <> <b>{s.target}{unit}</b></> : null} <i>· по днях</i></span>;
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
  );
}
// Тіло парасольки (період + виконавець + шапка 6 KPI + згортання денних рядків).
// Спільне для реальної kpi_period і синтетичної (сироти-daily_kpi).
function UmbBody({ periodStart, periodEnd, assigneeName, kids, summary, open, onToggle }: {
  periodStart: string | null; periodEnd: string | null; assigneeName: string | null;
  kids: Task[]; summary: UmbSummaryRow[]; open: boolean; onToggle: () => void;
}) {
  const doneN = kids.filter((k) => k.status === "done").length;
  return (
    <div style={{ paddingLeft: 22, marginTop: 4 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
        📅 {periodStart}…{periodEnd}{assigneeName ? ` · 👤 ${assigneeName}` : ""}
      </div>
      <UmbSummary rows={summary} />
      <button onClick={onToggle} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text)", font: "inherit", fontSize: 12, fontWeight: 600, padding: 0 }}>
        {open ? "▾" : "▸"} Дні плану: {doneN}/{kids.length} виконано
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          {kids.slice().sort((a, b) => (a.planDate ?? "").localeCompare(b.planDate ?? "")).map((k) => {
            const allDone = k.status === "done";
            return (
              <div key={k.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 11, borderLeft: `3px solid ${allDone ? "#16a34a" : "var(--border)"}`, paddingLeft: 8 }}>
                <span style={{ fontWeight: 600, minWidth: 84 }}>{allDone ? "✅" : "⬜"} {k.planDate}</span>
                {(k.metricsJson ?? []).map((m, i) => {
                  const icon = m.actual == null ? "⏳" : m.done ? "✅" : "❌";
                  return (
                    <span key={i} title={m.done ? "виконано" : m.actual == null ? "попереду" : "не виконано"}>
                      {icon} {METRIC_LBL[m.metric] ?? m.metric}{" "}
                      <b style={{ color: m.done ? "#16a34a" : m.actual == null ? "var(--text-muted)" : "#dc2626" }}>{m.actual ?? "—"}</b>/{m.target}{METRIC_UNIT[m.metric] ?? ""}
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
}

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

// ── Компактні клітинки (макет task_mock): щоб звільнити місце під ширший «Коментар» ──
const shortName = (n: string | null | undefined) => {
  if (!n) return "—";
  const p = n.trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[1][0]}.` : p[0];
};
const initialsOf = (n: string | null | undefined) =>
  n ? n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") : "?";
const PRIO_SHORT: Record<TaskPriority, string> = { high: "🚩 Вис.", medium: "🟡 Сер.", low: "⚪ Низ." };

// Дедлайн: коротка дата (дд.мм.рр), редагування по кліку.
function EditableDate({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <input type="date" autoFocus value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}
      onBlur={() => setEditing(false)} style={{ width: "100%", fontSize: 12, minWidth: 0 }} />;
  }
  return (
    <button onClick={() => setEditing(true)} title="Клік — редагувати дедлайн"
      style={{ border: "none", background: "transparent", cursor: "pointer", color: value ? "var(--text)" : "var(--text-muted)", fontSize: 12, padding: "2px 4px", whiteSpace: "nowrap" }}>
      {value ? `${value.slice(8)}.${value.slice(5, 7)}.${value.slice(2, 4)}` : "—"}
    </button>
  );
}

// Виконавець: аватар-ініціали + скорочене прізвище; редагування по кліку (select).
function AssigneeCell({ value, name, options, onChange }: {
  value: number | null; name: string | null; options: ManagerOption[]; onChange: (id: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <select autoFocus value={value ?? ""} onChange={(e) => { onChange(e.target.value ? Number(e.target.value) : null); setEditing(false); }}
        onBlur={() => setEditing(false)} style={{ width: "100%", fontSize: 12, minWidth: 0 }}>
        <option value="">—</option>
        {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    );
  }
  return (
    <button onClick={() => setEditing(true)} title={name ?? "Призначити виконавця"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", maxWidth: "100%", padding: "2px 0" }}>
      <span style={{ width: 22, height: 22, borderRadius: "50%", flex: "0 0 auto", background: name ? "rgba(99,102,241,0.16)" : "var(--border)", color: "#6366f1", fontSize: 9.5, fontWeight: 700, display: "grid", placeItems: "center" }}>{initialsOf(name)}</span>
      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortName(name)}</span>
    </button>
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
  commitTask,
  handleDeleteTask,
  handleSubmitTaskModal,
  refreshTasks,
  onOpenGoals,
  role,
  currentUserId,
  currentManagerId,
  accountEmail,
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
  /** Збереження на сервер із ВИДИМОЮ помилкою: мовчазний 403/500 читався як «збережено». */
  commitTask: (id: number, patch: Partial<Task>) => void;
  handleDeleteTask: (id: number) => void;
  handleSubmitTaskModal: () => void;
  refreshTasks?: () => Promise<void>;
  onOpenGoals?: () => void;
  role?: string;
  currentUserId?: number;
  currentManagerId?: number | null;
  accountEmail?: string;
  teams?: Team[];
}) {
  const isAdmin = role === "admin";
  // Підпис «чия сторінка»: імʼя менеджера (якщо акаунт привʼязаний) або email акаунта.
  const accountName = managerOptions.find((m) => m.id === currentManagerId)?.name || accountEmail || "мій акаунт";
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
  const [expandedKpi, setExpandedKpi] = useState<Set<string>>(new Set());
  const toggleKpi = (id: string) => setExpandedKpi((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ── 📁 ГРУПИ · 👥 АКАУНТИ · 💬 СУПУТНИКИ ВІДКРИТОЇ ЗАДАЧІ (14.09.2026) ──
  //
  // 🔴 Усе це тягнеться ОКРЕМО від поллера задач і НЕ додається в його колбек:
  // `#139` вирізає тіло поллера вікном у 600 знаків, і дописане туди переповнило б
  // вікно — гейт втратив би предмет і почервонів БЕЗ дефекту.
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [groupFilter, setGroupFilter] = useState<number | "all" | "none">("all");
  const [groupDraft, setGroupDraft] = useState("");
  const [accounts, setAccounts] = useState<TaskAssignee[]>([]);
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [files, setFiles] = useState<TaskFile[] | null>(null);
  const [history, setHistory] = useState<TaskHistoryEntry[] | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadGroups = () => { void fetchTaskGroups().then(setGroups).catch(() => setGroups([])); };
  useEffect(() => { reloadGroups(); void fetchTaskAssignees().then(setAccounts).catch(() => setAccounts([])); }, []);

  // Відкрили задачу → тягнемо стрічку, історію, вкладення і ГАСИМО бейдж.
  useEffect(() => {
    if (openTaskId == null) { setComments(null); setFiles(null); setHistory(null); setDetailErr(null); setCommentDraft(""); return; }
    const id = openTaskId;
    let alive = true;
    setDetailErr(null);
    void Promise.all([fetchTaskComments(id), fetchTaskFiles(id), fetchTaskHistory(id)])
      .then(([c, f, h]) => { if (alive) { setComments(c); setFiles(f); setHistory(h); } })
      // 👁 Порожнеча мусить називати себе: інакше збій читання виглядав би як
      // «обговорення немає» — та сама пастка, що «Порожньо» поруч із помилкою.
      .catch((e) => { if (alive) setDetailErr(e instanceof Error ? e.message : "не вдалося завантажити картку"); });
    void markTaskSeen(id).then(() => refreshTasks?.()).catch(() => {});
    return () => { alive = false; };
  }, [openTaskId]);

  const groupName = (id: number | null | undefined) => groups.find((g) => g.id === id)?.name ?? null;

  /** Чип групи — токенами дизайн-системи, а не пікселями: `--brand` однаковий у
   *  світлій і темній темі, а зашитий `#c5141c` у темній читався б інакше. */
  const groupChip = (active: boolean): React.CSSProperties => ({
    fontSize: "var(--fs-sm)", padding: "3px var(--sp-4)", borderRadius: "var(--r-pill)",
    cursor: "pointer", fontWeight: "var(--fw-semibold)" as React.CSSProperties["fontWeight"],
    border: "1px solid var(--border)",
    background: active ? "var(--brand)" : "var(--card-bg)", color: active ? "#fff" : "var(--text)",
  });

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer",
    background: active ? "#c5141c" : "var(--card-bg)", color: active ? "#fff" : "var(--text)", fontWeight: 600,
  });

  // «Мої» для тімліда/адміна: assignee = свій акаунт АБО я створив без виконавця.
  const isMine = (t: Task) => t.assigneeId === currentManagerId || (t.createdById === currentUserId && t.assigneeId == null);

  type SynthU = { synthKey: string; assigneeId: number | null; assigneeName: string | null; weekStart: string; weekEnd: string; kids: Task[]; status: string; title: string; department: string | null };
  // Рядок СИНТЕТИЧНОЇ парасольки (згорнуті сироти-daily_kpi одного менеджера за тиждень).
  // Віртуальний — статус/виконавець read-only; факт агрегується з реальних дітей (UmbBody).
  const renderSynthRow = (s: SynthU) => (
    <tr key={s.synthKey}>
      <td style={{ verticalAlign: "top" }}>
        <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          📦 План тижня {tDdmm(s.weekStart)}–{tDdmm(s.weekEnd)}
          <span style={{ fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 8, padding: "0 6px" }}>{s.kids.length} дн. · авто</span>
        </div>
        {s.department && <div style={{ marginTop: 2 }}><span style={{ ...deptPillStyle(s.department), fontSize: 10.5, padding: "1px 8px", display: "inline-block" }}>{s.department}</span></div>}
        <UmbBody periodStart={s.weekStart} periodEnd={s.weekEnd} assigneeName={s.assigneeName}
          kids={s.kids} summary={buildUmbrellaSummary(s.kids, null)}
          open={expandedKpi.has(s.synthKey)} onToggle={() => toggleKpi(s.synthKey)} />
      </td>
      <td><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: (s.status === "done" ? "#16a34a" : "var(--text-muted)") + "22", color: s.status === "done" ? "#16a34a" : "var(--text-muted)" }}>{s.status === "done" ? "Виконано" : "В роботі"}</span></td>
      <td style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap" }}>{tDdmm(s.weekEnd)}</td>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }} title={s.assigneeName ?? "—"}>
          <span style={{ width: 22, height: 22, borderRadius: "50%", flex: "0 0 auto", background: s.assigneeName ? "rgba(99,102,241,0.16)" : "var(--border)", color: "#6366f1", fontSize: 9.5, fontWeight: 700, display: "grid", placeItems: "center" }}>{initialsOf(s.assigneeName)}</span>
          <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortName(s.assigneeName)}</span>
        </span>
      </td>
      <td style={{ color: "var(--text-muted)" }}>—</td>
      <td style={{ color: "var(--text-muted)" }}>—</td>
      <td></td>
    </tr>
  );

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

      {(isAdmin || role === "team_lead" || role === "company") && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button style={tabBtn(adminTab === "mine")} onClick={() => setAdminTab("mine")}>👤 Свої задачі</button>
          <button style={tabBtn(adminTab === "all")} onClick={() => setAdminTab("all")}>{isAdmin || role === "company" ? "🗂️ Усі задачі" : "👥 Командні задачі"}</button>
          {adminTab === "mine" && (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>· {accountName}</span>
          )}
        </div>
      )}

      {/* 📁 ПАНЕЛЬ ГРУП. Групи ОСОБИСТІ (рішення Романа 14.09): чужих не видно, і
          задача в чужій папці для мене просто «без групи» — доступу групи не міняють. */}
      <div style={{ display: "flex", gap: "var(--sp-2)", marginBottom: "var(--sp-6)", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>📁 Групи:</span>
        <button style={groupChip(groupFilter === "all")} onClick={() => setGroupFilter("all")}>Усі</button>
        <button style={groupChip(groupFilter === "none")} onClick={() => setGroupFilter("none")}>Без групи</button>
        {groups.map((g) => (
          <span key={g.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button style={groupChip(groupFilter === g.id)} onClick={() => setGroupFilter(g.id)} title={`${g.taskCount} задач(і)`}>
              {g.name}{g.taskCount > 0 ? ` · ${g.taskCount}` : ""}
            </button>
            <button
              title="Прибрати групу (задачі лишаються, повертаються в «Без групи»)"
              onClick={async () => {
                if (!confirm(`Прибрати групу «${g.name}»? Задачі НЕ видаляються — повернуться в «Без групи».`)) return;
                await deleteTaskGroup(g.id).catch(() => {});
                if (groupFilter === g.id) setGroupFilter("all");
                reloadGroups(); refreshTasks?.();
              }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "var(--fs-xs)", padding: "0 2px" }}
            >✕</button>
          </span>
        ))}
        <input
          value={groupDraft}
          onChange={(e) => setGroupDraft(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key !== "Enter" || !groupDraft.trim()) return;
            const name = groupDraft.trim();
            setGroupDraft("");
            // Відмову показуємо словами: повторна назва це помилка кліку (409), і
            // тихе зникнення введеного читалось би як «нічого не сталось».
            await createTaskGroup(name).then(reloadGroups).catch((err) => {
              setDetailErr(err instanceof Error ? err.message : `не вдалося створити групу «${name}»`);
              setGroupDraft(name);
            });
          }}
          placeholder="+ нова група (Enter)"
          style={{ fontSize: "var(--fs-sm)", padding: "3px var(--sp-3)", borderRadius: "var(--r-pill)", border: "1px dashed var(--border)", background: "transparent", color: "var(--text)", width: 150 }}
        />
      </div>

      {tasksLoading ? (
        <p className="loading-text">Завантаження...</p>
      ) : ((() => {
      // Один рендер таблиці для довільного набору задач (щоб тімлід міг мати ДВІ секції).
      const renderTable = (src: Task[], title?: string) => (
        <div className="chart-card">
          {title && <div style={{ fontSize: 15, fontWeight: 700, margin: "2px 0 10px", display: "flex", alignItems: "center", gap: 6 }}>{title}</div>}
          <table className="data-table tasks-table">
            <colgroup>
              <col style={{ width: "23%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "40%" }} />
              <col style={{ width: "2%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Задача</th>
                <th>Статус</th>
                <th>Дедлайн</th>
                <th>Виконавець</th>
                <th>Пріоритет</th>
                <th>Коментар</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const q = taskSearch.trim().toLowerCase();
                // Діти KPI-періоду (parentId) НЕ показуємо окремими рядками — вони в
                // розкривному списку парасольки (реальної kpi_period АБО синтетичної).
                const childrenOf = (id: number) => tasks.filter((t) => t.parentId === id)
                  .sort((a, b) => (a.planDate ?? "").localeCompare(b.planDate ?? ""));
                // Реальні верхнього рівня — БЕЗ сиріт-daily_kpi (вони йдуть у синтетичні парасольки).
                let base = src.filter((t) => t.parentId == null && t.taskType !== "daily_kpi");
                // ЧАСТИНА 1: сироти-daily_kpi (parent_id NULL) → синтетична парасолька по
                // (assignee + ISO-тиждень plan_date, Пн–Нд). Дані не чіпаємо — лише групування.
                const gmap = new Map<string, Task[]>();
                for (const t of src.filter((t) => t.parentId == null && t.taskType === "daily_kpi" && t.planDate)) {
                  const wk = tMondayOf(t.planDate!); const key = `${t.assigneeId}|${wk}`;
                  (gmap.get(key) ?? gmap.set(key, []).get(key)!).push(t);
                }
                let synths: SynthU[] = [...gmap.entries()].map(([key, kids]) => {
                  const wk = key.split("|")[1]; const allDone = kids.every((k) => k.status === "done");
                  return { synthKey: `synth-${key}`, assigneeId: kids[0].assigneeId, assigneeName: kids[0].assigneeName,
                    weekStart: wk, weekEnd: tAddDays(wk, 6), kids, status: allDone ? "done" : "in_progress",
                    title: `План тижня ${tDdmm(wk)}–${tDdmm(tAddDays(wk, 6))}`, department: kids[0].department ?? null };
                });
                // Перемикач «Мої / Усі(admin) / Командні(team_lead)»: «Мої» = свій assignee.
                if ((isAdmin || role === "team_lead" || role === "company") && adminTab === "mine") { base = base.filter(isMine); synths = synths.filter((s) => s.assigneeId === currentManagerId); }
                if (assigneeFilter !== "") { base = base.filter((t) => t.assigneeId === assigneeFilter); synths = synths.filter((s) => s.assigneeId === assigneeFilter); }
                // 📁 Фільтр по групі. Синтетичні парасольки KPI груп не мають, тож
                // будь-який вибір, крім «Усі», їх свідомо прибирає.
                if (groupFilter === "none") { base = base.filter((t) => t.groupId == null || groupName(t.groupId) == null); }
                else if (groupFilter !== "all") { base = base.filter((t) => t.groupId === groupFilter); synths = []; }
                if (statusFilter === "active") { base = base.filter((t) => t.status !== "done"); synths = synths.filter((s) => s.status !== "done"); }
                else if (statusFilter === "done") { base = base.filter((t) => t.status === "done"); synths = synths.filter((s) => s.status === "done"); }
                if (q) {
                  base = base.filter((t) => [t.title, t.comments, t.department, t.assigneeName].some((v) => (v ?? "").toLowerCase().includes(q)));
                  synths = synths.filter((s) => [s.title, s.assigneeName].some((v) => (v ?? "").toLowerCase().includes(q)));
                }
                const prioRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
                const dir = sortDir === "asc" ? 1 : -1;
                type Row = { kind: "task"; task: Task } | { kind: "synth"; synth: SynthU };
                const gStatus = (r: Row) => r.kind === "task" ? r.task.status : r.synth.status;
                const gName = (r: Row) => r.kind === "task" ? (r.task.assigneeName ?? "") : (r.synth.assigneeName ?? "");
                const gCreated = (r: Row) => r.kind === "task" ? (r.task.createdAt ?? "") : r.synth.weekStart;
                const gDeadline = (r: Row) => r.kind === "task" ? (r.task.deadline ?? "9999-99-99") : r.synth.weekEnd;
                // Закріплені задачі з 1×1 — ЗАВЖДИ вгорі, незалежно від обраного сортування.
                // Серверного ORDER BY тут замало: клієнт пересортовує список під себе.
                const gPinned = (r: Row) => (r.kind === "task" && r.task.pinned ? 0 : 1);
                const visible: Row[] = [...base.map((t) => ({ kind: "task", task: t } as Row)), ...synths.map((s) => ({ kind: "synth", synth: s } as Row))].sort((a, b) => {
                  const ap = gPinned(a), bp = gPinned(b);
                  if (ap !== bp) return ap - bp;
                  const ad = gStatus(a) === "done" ? 1 : 0, bd = gStatus(b) === "done" ? 1 : 0;
                  if (ad !== bd) return ad - bd;
                  let cmp: number;
                  switch (sortBy) {
                    case "deadline": cmp = gDeadline(a).localeCompare(gDeadline(b)); break;
                    case "priority": cmp = (a.kind === "task" ? (prioRank[a.task.priority] ?? 9) : 1) - (b.kind === "task" ? (prioRank[b.task.priority] ?? 9) : 1); break;
                    case "status": cmp = gStatus(a).localeCompare(gStatus(b)); break;
                    case "assignee": cmp = gName(a).localeCompare(gName(b), "uk"); break;
                    case "title": cmp = (a.kind === "task" ? (a.task.title ?? "") : a.synth.title).localeCompare(b.kind === "task" ? (b.task.title ?? "") : b.synth.title, "uk"); break;
                    default: cmp = gCreated(a).localeCompare(gCreated(b)); break;
                  }
                  return cmp * dir;
                });
                if (visible.length === 0) {
                  return (
                    <tr>
                      <td colSpan={7} className="loading-text">
                        {q ? "Нічого не знайдено." : "Задач немає."}
                      </td>
                    </tr>
                  );
                }
                return visible.map((it) => {
                  if (it.kind === "synth") return renderSynthRow(it.synth);
                  const task = it.task;
                  return (
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
                          onCommit={(v) => commitTask(task.id, { title: v })}
                        />
                        {/* 🔔 «Є нове» — доповнення або зміна статусу ПІСЛЯ мого
                            останнього перегляду і НЕ мною (сервер, `task_views`). */}
                        {task.hasUnseen && (
                          <span title="Є нове: доповнення або зміна статусу після вашого останнього перегляду"
                            style={{ flexShrink: 0, width: 8, height: 8, borderRadius: "var(--r-pill)", background: "var(--brand)", marginTop: 6 }} />
                        )}
                      </div>
                      {/* 📎 Що є в картці — числом, а не здогадом. Мітка групи видима
                          лише власнику групи: сервер віддає `groupName` тільки йому. */}
                      {((task.commentCount ?? 0) > 0 || (task.fileCount ?? 0) > 0) && (
                        <div style={{ paddingLeft: 22, marginTop: 2, display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", alignItems: "center" }}>
                          {/* Форма бейджа — та сама, що в сусідніх мітках 1×1 вище:
                              pill, 10.5px, приглушений фон. Новий вигляд поруч зі
                              старим читався б як інша сутність. */}
                          {(task.commentCount ?? 0) > 0 && (
                            <span title="доповнень у стрічці" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>💬 {task.commentCount}</span>
                          )}
                          {(task.fileCount ?? 0) > 0 && (
                            <span title="вкладень" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>📎 {task.fileCount}</span>
                          )}
                        </div>
                      )}
                      {/* Задача з 1×1: бейдж + закріплення + замок. Видалення блокує сервер (403). */}
                      {task.taskType === "oneonone" && (
                        <div style={{ paddingLeft: 22, marginTop: 3, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <span title={task.o2oMeetingDate ? `поставлено на 1×1 ${task.o2oMeetingDate}` : undefined}
                            style={{ fontSize: 10.5, fontWeight: 700, color: "#b45309", background: "rgba(217,119,6,.15)", borderRadius: 999, padding: "1px 8px" }}>Задача з 1×1</span>
                          {task.pinned && <span style={{ fontSize: 10.5, fontWeight: 600, color: "#b45309", background: "rgba(217,119,6,.10)", borderRadius: 999, padding: "1px 8px" }}>📌 закріплено</span>}
                          <span title="Знімає лише ведучий на наступному 1×1"
                            style={{ fontSize: 10.5, color: "var(--text-muted)", background: "rgba(128,128,128,.10)", borderRadius: 999, padding: "1px 8px" }}>🔒 без видалення</span>
                          {task.o2oResolution === "cancelled" && (
                            <span style={{ fontSize: 10.5, color: "#64748b", background: "rgba(100,116,139,.14)", borderRadius: 999, padding: "1px 8px" }}>
                              знято{task.o2oResolvedByName ? ` · ${task.o2oResolvedByName}` : ""}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Команда/департамент + ГРУПА — малі чіпи ПІД назвою (не окремі
                          колонки), обидва редаговані одним кліком.
                          🔴 ГРУПА СТОЇТЬ САМЕ ТУТ, А НЕ ЛИШЕ В КАРТЦІ. Перша редакція
                          дозволяла покласти задачу в папку тільки з відкритої картки —
                          тобто розкласти двадцять задач означало двадцять відкриттів.
                          Привʼязка мусить бути там, де людина дивиться на список, і
                          виглядати так само, як сусідня «команда»: інакше фіча є, а
                          способу нею скористатись немає. */}
                      <div style={{ paddingLeft: 22, marginTop: 2, display: "flex", gap: "var(--sp-1)", flexWrap: "wrap", alignItems: "center" }}>
                        <select
                          value={task.groupId != null && groupName(task.groupId) ? String(task.groupId) : ""}
                          onChange={(e) => {
                            const groupId = e.target.value ? Number(e.target.value) : null;
                            patchTaskLocal(task.id, { groupId });
                            commitTask(task.id, { groupId });
                          }}
                          title={groups.length ? "Моя папка для цієї задачі" : "Спершу створіть групу смугою «📁 Групи» над списком"}
                          style={task.groupId != null && groupName(task.groupId)
                            ? { border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", borderRadius: "var(--r-pill)", fontSize: 10.5, padding: "1px var(--sp-3)", maxWidth: "100%" }
                            : { border: "1px dashed var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", borderRadius: "var(--r-pill)", fontSize: 10.5, padding: "1px var(--sp-3)", maxWidth: "100%" }}
                        >
                          {/* Порожній стан НАЗИВАЄ ПРИЧИНУ: «+ група» при нулі груп
                              виглядало б як зламаний контрол. */}
                          <option value="">{groups.length ? "+ група" : "+ група (спершу створіть)"}</option>
                          {groups.map((g) => <option key={g.id} value={g.id}>📁 {g.name}</option>)}
                        </select>
                        <select
                          value={task.department ?? ""}
                          onChange={(e) => { const department = e.target.value || null; patchTaskLocal(task.id, { department }); commitTask(task.id, { department }); }}
                          title="Команда / департамент"
                          style={task.department
                            ? { ...deptPillStyle(task.department), fontSize: 10.5, padding: "1px 8px" }
                            : { border: "1px dashed var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", borderRadius: 999, fontSize: 10.5, padding: "1px 8px", maxWidth: "100%" }}
                        >
                          <option value="">+ команда</option>
                          {task.department && !deptOptions.includes(task.department) && <option value={task.department}>{task.department}</option>}
                          {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
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
                        return <UmbBody periodStart={task.periodStart} periodEnd={task.periodEnd} assigneeName={task.assigneeName}
                          kids={kids} summary={buildUmbrellaSummary(kids, (task.metricsJson as MetricJ[] | null) ?? null)}
                          open={expandedKpi.has(String(task.id))} onToggle={() => toggleKpi(String(task.id))} />;
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
                                    commitTask(task.id, { checklistJson: next });
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
                                      commitTask(task.id, { checklistJson: updated });
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
                      {/* 🔄 ПАЧКА РЕАКТИВАЦІЇ НОВОГО ЗРАЗКА: клієнти — РЯДКИ-ДІТИ, не чекліст.
                          Батько лишається одним рядком (рішення власника), а стан кожного
                          клієнта живе у власній задачі — саме тому його видно на картці
                          клієнта й саме тому автозакриття «клієнт повернувся» його бачить.
                          Старі пачки й далі малюються чеклістом вище: обидва блоки
                          взаємовиключні за даними, бо чекліст у нових пачок порожній. */}
                      {task.taskType === "reactivation" && (() => {
                        const kids = childrenOf(task.id);
                        if (kids.length === 0) return null;
                        const doneN = kids.filter((k) => k.status === "done").length;
                        return (
                          <div style={{ paddingLeft: 22, marginTop: 4, display: "flex", flexDirection: "column", gap: 6 }}>
                            {kids.map((k) => {
                              const kd = k.status === "done";
                              const f = (k.metricsJson ?? {}) as { orders?: number | null; category?: string | null };
                              return (
                                <div key={k.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                                    <input type="checkbox" checked={kd} onChange={() => {
                                      const next = kd ? "not_started" : "done";
                                      patchTaskLocal(k.id, { status: next });
                                      commitTask(k.id, { status: next });
                                    }} />
                                    <span style={{ flex: 1, textDecoration: kd ? "line-through" : "none", opacity: kd ? 0.55 : 1 }}>🏢 {k.title}</span>
                                    <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                                      {f.category === "oneshot_bg" ? "1 перевез. (б/г)" : "замовклий"}{f.orders != null ? ` · ${f.orders} перевез.` : ""}
                                    </span>
                                  </label>
                                  <div style={{ marginLeft: 22 }}>
                                    <CommentField
                                      value={k.comments}
                                      placeholder="Коментар по клієнту (результат дзвінка)…"
                                      onSave={(next) => {
                                        const v = next.trim() || null;
                                        if (v === (k.comments ?? null)) return;
                                        patchTaskLocal(k.id, { comments: v });
                                        commitTask(k.id, { comments: v });
                                      }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                            <span style={{ fontSize: 11, color: doneN === kids.length ? "#16a34a" : "var(--text-muted)", fontWeight: 600 }}>
                              Опрацьовано {doneN}/{kids.length}
                            </span>
                          </div>
                        );
                      })()}
                      {/* 🏷 ПРИЧИНА ЗАКРИТТЯ — ВИДИМА. Поле заповнювали з першого дня
                          (`POST /reactivation-task/close` пише «ключ: пояснення»), а
                          видача задач його не віддавала ЗОВСІМ: людина обирала причину
                          зі списку, і та зникала з очей назавжди. Показуємо разом із
                          датою й автором; автора на старих рядках немає — до 07.09.2026
                          його не записували ніде, і підставляти виконавця замість нього
                          означало б відповідати на інше питання. */}
                      {task.status === "done" && task.closeReason && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 2 }}>
                          🏷 {task.closeReason}
                          {task.closedAt && ` · ${task.closedAt}`}
                          {task.closedByName ? ` · ${task.closedByName}` : " · автора не записано"}
                        </div>
                      )}
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
                          commitTask(task.id, { status });
                        }}
                      />
                    </td>
                    <td>
                      <EditableDate value={task.deadline} onChange={(deadline) => { patchTaskLocal(task.id, { deadline }); commitTask(task.id, { deadline }); }} />
                    </td>
                    <td>
                      <AssigneeCell value={task.assigneeId} name={task.assigneeName} options={managerOptions}
                        onChange={(assigneeId) => { const assigneeName = managerOptions.find((m) => m.id === assigneeId)?.name ?? null; patchTaskLocal(task.id, { assigneeId, assigneeName }); commitTask(task.id, { assigneeId }); }} />
                    </td>
                    <td>
                      <select
                        value={task.priority}
                        onChange={(e) => {
                          const priority = e.target.value as TaskPriority;
                          patchTaskLocal(task.id, { priority });
                          commitTask(task.id, { priority });
                        }}
                        style={{ ...priorityPillStyle(task.priority), fontSize: 11, padding: "3px 6px" }}
                        title="Пріоритет"
                      >
                        {(["high", "medium", "low"] as TaskPriority[]).map((value) => (
                          <option key={value} value={value}>{PRIO_SHORT[value]}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ verticalAlign: "top" }}>
                      <AutoTextarea
                        value={task.comments ?? ""}
                        placeholder="—"
                        onLocal={(v) => patchTaskLocal(task.id, { comments: v })}
                        onCommit={(v) => commitTask(task.id, { comments: v })}
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
                ); });
              })()}
            </tbody>
          </table>
        </div>
      );
      // ЧАСТИНА 2: тімлід — ОДНА таблиця на всю ширину + перемикач зверху «Мої / Командні»
      // (як в адміна). Дві колонки прибрано (таблиця стискалась). manager/admin без змін.
      return renderTable(tasks);
    })())}

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
                onBlur={(e) => commitTask(openTask.id, { title: e.target.value })}
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
                    <select value={openTask.assigneeId ?? ""} onChange={(e) => { const assigneeId = e.target.value ? Number(e.target.value) : null; const assigneeName = managerOptions.find((m) => m.id === assigneeId)?.name ?? null; patchTaskLocal(openTask.id, { assigneeId, assigneeName }); commitTask(openTask.id, { assigneeId }); }} style={{ width: "100%" }}>
                      <option value="">— (моя / без виконавця)</option>
                      {managerOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </F>
                  {/* 👤 ВИКОНАВЕЦЬ-АКАУНТ. Показуємо ЛИШЕ коли менеджера з CRM не
                      обрано: виконавець один (CHECK `tasks_one_assignee`), і два
                      селекти одночасно обіцяли б неможливе. */}
                  {openTask.assigneeId == null && (
                    <F icon="🧑‍💼" label="Або акаунт">
                      <select
                        value={openTask.assigneeUserId ?? ""}
                        onChange={(e) => {
                          const assigneeUserId = e.target.value ? Number(e.target.value) : null;
                          patchTaskLocal(openTask.id, { assigneeUserId });
                          commitTask(openTask.id, { assigneeUserId });
                        }}
                        style={{ width: "100%" }}
                      >
                        <option value="">— (без виконавця-акаунта)</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}{a.nameIsLogin ? " (логін)" : ""}</option>
                        ))}
                      </select>
                    </F>
                  )}
                  <F icon="📁" label="Група">
                    <select
                      value={openTask.groupId != null && groupName(openTask.groupId) ? openTask.groupId : ""}
                      onChange={(e) => {
                        const groupId = e.target.value ? Number(e.target.value) : null;
                        patchTaskLocal(openTask.id, { groupId });
                        commitTask(openTask.id, { groupId });
                      }}
                      style={{ width: "100%" }}
                    >
                      <option value="">— (без групи)</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </F>
                  <F icon="📅" label="Дедлайн">
                    <input type="date" value={openTask.deadline ?? ""} onChange={(e) => { const deadline = e.target.value || null; patchTaskLocal(openTask.id, { deadline }); commitTask(openTask.id, { deadline }); }} />
                  </F>
                  <F icon="🏷️" label="Департамент">
                    <select value={openTask.department ?? ""} onChange={(e) => { const department = e.target.value || null; patchTaskLocal(openTask.id, { department }); commitTask(openTask.id, { department }); }} style={{ width: "100%" }}>
                      <option value="">—</option>
                      {openTask.department && !deptOptions.includes(openTask.department) && (
                        <option value={openTask.department}>{openTask.department}</option>
                      )}
                      {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </F>
                  <F icon="⚑" label="Пріоритет">
                    <select value={openTask.priority} onChange={(e) => { const priority = e.target.value as TaskPriority; patchTaskLocal(openTask.id, { priority }); commitTask(openTask.id, { priority }); }} style={{ width: "100%" }}>
                      {Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </F>
                  <F icon="◔" label="Статус">
                    <StatusPicker value={openTask.status} fullWidth
                      onChange={(status) => { patchTaskLocal(openTask.id, { status }); commitTask(openTask.id, { status }); }} />
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

            <SubtasksEditor task={openTask} patchTaskLocal={patchTaskLocal} commitTask={commitTask} />

            <div style={{ marginTop: 18 }}>
              {/* 🔴 ДВА РІЗНІ ПОЛЯ, І ПІДПИСИ ЦЕ НАЗИВАЮТЬ. Верхнє — КОРОТКИЙ
                  коментар у рядку таблиці, його перезаписують (так і було).
                  Нижче — СТРІЧКА: історія з автором і часом, якої наступне
                  збереження не затирає. Спільний підпис «Коментарі» на обох
                  читався б як одне поле, і люди дивувались би, куди зник текст. */}
              <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 6px" }}>📝 Короткий коментар <span style={{ fontWeight: 400, opacity: .8 }}>· видно в рядку списку, перезаписується</span></h3>
              <textarea
                value={openTask.comments ?? ""}
                placeholder="Одна фраза для списку…"
                onChange={(e) => patchTaskLocal(openTask.id, { comments: e.target.value })}
                onBlur={(e) => commitTask(openTask.id, { comments: e.target.value })}
                rows={3}
                style={{ width: "100%", resize: "vertical", font: "inherit", padding: 10, lineHeight: 1.5, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}
              />
            </div>

            {detailErr && (
              // Помилка й порожнеча — РІЗНІ стани. Поки видно цей рядок, «немає
              // доповнень» нижче не друкується: саме на змішуванні цих двох
              // повідомлень вкладка документів казала водночас «помилка» і «порожньо».
              // `--danger` у темній темі інший (#f87171 проти #b91c1c) — зашитий
              // червоний там був би нечитним. Колір помилки бере тему.
              <p style={{ marginTop: "var(--sp-6)", fontSize: "var(--fs-sm)", color: "var(--danger)",
                          background: "var(--danger-bg)", borderRadius: "var(--r-md)", padding: "var(--sp-3) var(--sp-4)" }}>⚠️ {detailErr}</p>
            )}

            {/* ── 💬 СТРІЧКА ДОПОВНЕНЬ ── */}
            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>
                💬 Стрічка доповнень{comments ? ` · ${comments.length}` : ""}
              </h3>
              {comments == null ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{detailErr ? "—" : "Завантаження…"}</p>
              ) : comments.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Доповнень ще немає.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
                  {comments.map((c) => (
                    <div key={c.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "var(--sp-3) var(--sp-4)", background: "var(--card-bg)" }}>
                      <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
                        {c.authorName ?? "невідомий автор"} · {String(c.createdAt).slice(0, 16).replace("T", " ")}
                      </div>
                      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: "var(--lh)" }}>{c.body}</div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
                <textarea
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder="Дописати в стрічку…"
                  rows={2}
                  style={{ flex: 1, resize: "vertical", font: "inherit", padding: "var(--sp-3)", lineHeight: "var(--lh)", borderRadius: "var(--r-lg)", border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}
                />
                <button
                  className="btn-primary"
                  disabled={!commentDraft.trim() || busy}
                  onClick={async () => {
                    const body = commentDraft.trim();
                    if (!body) return;
                    setBusy(true); setDetailErr(null);
                    try {
                      const added = await createTaskComment(openTask.id, body);
                      setComments((cur) => [...(cur ?? []), added]);
                      setCommentDraft("");
                      refreshTasks?.();
                    } catch (err) {
                      // 🔴 Текст НЕ прибираємо з поля: людина його набирала.
                      setDetailErr(err instanceof Error ? err.message : "не вдалося дописати");
                    } finally { setBusy(false); }
                  }}
                  style={{ flexShrink: 0, cursor: commentDraft.trim() && !busy ? "pointer" : "default",
                           opacity: commentDraft.trim() && !busy ? 1 : 0.5 }}
                >Дописати</button>
              </div>
            </div>

            {/* ── 📎 ВКЛАДЕННЯ ── */}
            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>
                📎 Вкладення{files ? ` · ${files.length} із ${TASK_FILES_PER_TASK}` : ""}
              </h3>
              {files == null ? (
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{detailErr ? "—" : "Завантаження…"}</p>
              ) : files.length === 0 ? (
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>Файлів ще немає.</p>
              ) : (
                /* Компактна таблиця дашборду (`data-table compact`) — той самий
                   клас, що вже стоїть у цій картці на блоці показників. Власна
                   верстка списку виглядала б як чужа вставка. */
                <table className="data-table compact" style={{ width: "100%", marginBottom: "var(--sp-3)" }}>
                  <thead><tr>
                    <th style={{ textAlign: "left" }}>Файл</th>
                    <th style={{ textAlign: "right" }}>Розмір</th>
                    <th style={{ textAlign: "left" }}>Поклав</th>
                    <th style={{ width: 24 }} />
                  </tr></thead>
                  <tbody>
                    {files.map((f) => (
                      <tr key={f.id}>
                        <td style={{ textAlign: "left" }}>
                          <button
                            onClick={async () => {
                              try {
                                const url = await fetchTaskFileBlobUrl(openTask.id, f.id);
                                window.open(url, "_blank", "noopener");
                              } catch (err) {
                                setDetailErr(err instanceof Error ? err.message : "файл не відкрився");
                              }
                            }}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text)", textDecoration: "underline", padding: 0, font: "inherit", textAlign: "left" }}
                          >{f.name}</button>
                        </td>
                        <td className="recv-num" style={{ textAlign: "right", color: "var(--text-muted)" }}>
                          {Math.max(1, Math.round(Number(f.sizeBytes) / 1024))} КБ
                        </td>
                        <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{f.author ?? "—"}</td>
                        <td style={{ textAlign: "center" }}>
                          {(f.createdById === currentUserId || isAdmin) && (
                            <button
                              title="Прибрати вкладення"
                              onClick={async () => {
                                if (!confirm(`Прибрати «${f.name}»?`)) return;
                                try {
                                  await deleteTaskFile(openTask.id, f.id);
                                  setFiles((cur) => (cur ?? []).filter((x) => x.id !== f.id));
                                  refreshTasks?.();
                                } catch (err) {
                                  setDetailErr(err instanceof Error ? err.message : "не вдалося прибрати файл");
                                }
                              }}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}
                            >✕</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {/* 🔴 СИРИЙ `input[type=file]` МАЛЮЄТЬСЯ БРАУЗЕРОМ І В ДАШБОРД НЕ
                  ВПИСУЄТЬСЯ. Тому input схований, а видимий елемент — звичайна
                  кнопка в стилі решти картки. Межу «більше не можна» показуємо
                  ТЕКСТОМ, а не мертвою кнопкою: вимкнений контрол без причини
                  читається як поломка. */}
              {(files?.length ?? 0) >= TASK_FILES_PER_TASK ? (
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: 0 }}>
                  Більше {TASK_FILES_PER_TASK} файлів на задачу не кладемо — приберіть зайвий, щоб додати новий.
                </p>
              ) : (
                <label
                  style={{ display: "inline-block", padding: "var(--sp-2) var(--sp-6)", borderRadius: "var(--r-md)",
                           border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
                           cursor: busy ? "default" : "pointer", fontSize: "var(--fs-sm)",
                           fontWeight: "var(--fw-semibold)" as React.CSSProperties["fontWeight"], opacity: busy ? 0.5 : 1 }}
                >
                  {busy ? "Завантаження…" : "📎 Додати файл"}
                  <input
                    type="file"
                    disabled={busy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      // 🔴 Межу 5 МБ перевіряємо і ТУТ, і на сервері. Тут — щоб людина
                      // побачила причину одразу, а не після хвилини завантаження;
                      // там — бо межа не має триматись на екрані.
                      if (file.size > TASK_FILE_MAX_BYTES) {
                        setDetailErr(`«${file.name}» — ${Math.round(file.size / 1024 / 1024 * 10) / 10} МБ, а межа 5 МБ`);
                        return;
                      }
                      setBusy(true); setDetailErr(null);
                      try {
                        const added = await uploadTaskFile(openTask.id, file);
                        setFiles((cur) => [...(cur ?? []), added]);
                        refreshTasks?.();
                      } catch (err) {
                        setDetailErr(err instanceof Error ? err.message : "не вдалося завантажити файл");
                      } finally { setBusy(false); }
                    }}
                    style={{ display: "none" }}
                  />
                </label>
              )}
              <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: "var(--sp-2) 0 0" }}>
                До 5 МБ, не більше {TASK_FILES_PER_TASK} файлів на задачу. Прибране вкладення
                зникає зі списку, але зберігається — відновлюється вручну.
              </p>
            </div>

            {/* ── 📜 ІСТОРІЯ СТАТУСУ ── */}
            {history != null && history.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>
                  📜 Історія статусу <span style={{ fontWeight: 400, opacity: .8 }}>· рухи через інтерфейс</span>
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {history.map((h) => (
                    <div key={h.id} style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
                      {String(h.changedAt).slice(0, 16).replace("T", " ")} · {h.fromStatus ?? "—"} → <b style={{ color: "var(--text)" }}>{h.toStatus}</b> · {h.changedByName ?? "невідомо"}
                    </div>
                  ))}
                </div>
                {/* ⚠️ ЧЕСНА МЕЖА, А НЕ ДРІБНИЦЯ: статус задачі пишуть ще шість місць
                    поза цією карткою (оцінювач KPI, реактивація, 1×1, звіт), і вони в
                    лог НЕ пишуть. Без цього рядка порожній лог читався б як «ніхто не
                    рухав» там, де рухала джоба. */}
                <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: "var(--sp-2) 0 0" }}>
                  Автоматичні зміни (оцінювач KPI, реактивація, 1×1) тут не показуються.
                </p>
              </div>
            )}

            <div style={{ marginTop: 18, textAlign: "right" }}>
              {openTask.taskType === "oneonone" && openTask.createdById !== currentUserId ? (
                // Замок server-enforced (DELETE → 403); кнопку ховаємо, щоб не обіцяти неможливого.
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  🔒 Задача з 1×1 — знімається на наступному 1×1, ведучим
                </span>
              ) : (
                <button onClick={() => { handleDeleteTask(openTask.id); setOpenTaskId(null); }} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 12px", color: "#dc2626", cursor: "pointer" }}>🗑 Видалити</button>
              )}
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
