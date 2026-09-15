import { useLayoutEffect, useRef, useState, useEffect, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { parseTaskIdParam, deepLinkState } from "../taskDeepLink";
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

/**
 * 🗣 ТЕКСТ ВІДМОВИ БЕРЕТЬСЯ З СЕРВЕРА, А НЕ З AXIOS.
 *
 * `err.message` в axios — це «Request failed with status code 403», тобто рівно те
 * повідомлення, яке людині нічого не каже. Причину сервер пише в тілі
 * (`{ error: "…" }`), і саме вона мусить дійти до екрана: «Вкладення доступні лише
 * автору та виконавцю задачі» — це відповідь, а код 403 — ні.
 */
function errText(e: unknown, fallback: string): string {
  const body = (e as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  if (typeof body === "string" && body.trim()) return body;
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * 👁 ПЕРЕГЛЯДАЧ ВКЛАДЕНЬ ЗАДАЧІ — відкривається ЗІ СПИСКУ, колонкою праворуч від
 * коментаря (вимога власника 14.09.2026: «немає перегляду файлів»).
 *
 * 🔴 ЧОМУ ЦЕ НЕ `window.open(blobUrl)`, ЯК БУЛО В КАРТЦІ. Стара кнопка відкривала
 * файл окремою вкладкою браузера: людина виходила з дашборду, поверталась руками,
 * а блокувальник попапів міг просто нічого не зробити — відмова, яку неможливо
 * відрізнити від роботи. Тепер картинка, PDF і відео показуються НА МІСЦІ.
 *
 * 🔒 Байти йдуть ЗАГОЛОВКОМ авторизації (`api.get` → `responseType: "blob"`), тому
 * `<img src="/api/…">` тут не годиться в принципі: токен у заголовку, а не в URL.
 * Звідси blob-URL і обовʼязковий `revokeObjectURL` — інакше кожне відкриття
 * лишало б копію файла в памʼяті вкладки.
 *
 * ⚠️ ВІДМОВА НАЗИВАЄ СЕБЕ. Сервер віддає 403 «Вкладення доступні лише автору та
 * виконавцю задачі» — і цей текст показується як є. Порожня модалка на місці
 * відмови читалась би як «файлів немає», тобто брехала б про дані.
 */
function TaskFilesViewer({ taskId, taskTitle, onClose }: {
  taskId: number; taskTitle: string; onClose: () => void;
}) {
  const [list, setList] = useState<TaskFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchTaskFiles(taskId)
      .then((fs) => { if (!alive) return; setList(fs); setPick(fs[0]?.id ?? null); })
      .catch((e) => { if (alive) setErr(errText(e, "вкладення не відкрились")); });
    return () => { alive = false; };
  }, [taskId]);

  /**
   * 🔴 СТОРОЖ `alive` ТУТ ОБОВʼЯЗКОВИЙ, І ЙОГО ВІДСУТНІСТЬ ДАВАЛА ДВА БАГИ ОДНИМ
   * РЯДКОМ (знайдено рецензією 14.09.2026):
   *  ① БАЙТИ НЕ ТОГО ФАЙЛА. Прибирач попереднього ефекту виконується, коли `u` ще
   *    `null` (запит не повернувся), тож нічого не відкликає — а коли повільний
   *    перший файл нарешті приходить, він БЕЗУМОВНО робить `setBlobUrl`, затираючи
   *    вже показаний другий. На екрані назва одного вкладення й байти іншого.
   *  ② ВТРАЧЕНА КОПІЯ. Той самий `u === null` означає, що blob першого файла не
   *    відкликається НІКОЛИ — до перезавантаження сторінки.
   * Тому відкликаємо і в прибирачі, і одразу, якщо ефект уже не живий.
   *
   * `setErr(null)` на початку — щоб плашка попередньої невдачі не висіла над
   * файлом, який відкрився нормально (правило: відмова мусить стосуватись того, що
   * зараз на екрані).
   */
  useEffect(() => {
    if (pick == null) { setBlobUrl(null); return; }
    let alive = true;
    let u: string | null = null;
    setBlobUrl(null);
    setErr(null);
    fetchTaskFileBlobUrl(taskId, pick)
      .then((url) => {
        u = url;
        if (alive) setBlobUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch((e) => { if (alive) setErr(errText(e, "файл не відкрився")); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [taskId, pick]);

  const cur = list?.find((f) => f.id === pick) ?? null;
  const isImage = cur?.mime?.startsWith("image/") ?? false;
  const isVideo = cur?.mime?.startsWith("video/") ?? false;
  const isPdf = cur?.mime === "application/pdf";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2700, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)",
        borderRadius: "var(--r-lg)", padding: "var(--sp-5)", width: "92vw", maxWidth: 920,
        maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--sp-4)", gap: 12 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>📎 Вкладення · {taskTitle}</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)",
            color: "var(--text)", borderRadius: "var(--r-md)", padding: "4px 12px", cursor: "pointer" }}>✕</button>
        </div>

        {err && (
          <p style={{ fontSize: "var(--fs-sm)", color: "var(--danger)", background: "var(--danger-bg)",
            borderRadius: "var(--r-md)", padding: "var(--sp-3) var(--sp-4)" }}>⚠️ {err}</p>
        )}

        {list == null && !err && <p className="loading-text">Завантаження…</p>}
        {list != null && list.length === 0 && !err && (
          <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>Файлів ще немає.</p>
        )}

        {/* Кілька вкладень — перемикач: на задачу їх не більше двох, тож смуга кнопок
            зрозуміліша за список із прокруткою. */}
        {list != null && list.length > 1 && (
          <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", marginBottom: "var(--sp-4)" }}>
            {list.map((f) => (
              <button key={f.id} onClick={() => setPick(f.id)}
                style={{ border: "1px solid var(--border)", borderRadius: "var(--r-pill)", cursor: "pointer",
                  fontSize: "var(--fs-xs)", padding: "2px var(--sp-3)",
                  background: f.id === pick ? "var(--brand)" : "var(--card-bg)",
                  color: f.id === pick ? "#fff" : "var(--text)" }}
              >{f.name}</button>
            ))}
          </div>
        )}

        {cur && (
          <>
            <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: "0 0 var(--sp-3)" }}>
              {cur.name} · {Math.max(1, Math.round(Number(cur.sizeBytes) / 1024))} КБ · поклав {cur.author ?? "—"}
            </p>
            {!blobUrl && !err && <p className="loading-text">Завантаження файла…</p>}
            {blobUrl && isImage && <img src={blobUrl} alt={cur.name} style={{ maxWidth: "100%", borderRadius: "var(--r-md)" }} />}
            {blobUrl && isVideo && <video src={blobUrl} controls style={{ width: "100%", borderRadius: "var(--r-md)", background: "#000" }} />}
            {blobUrl && isPdf && <iframe src={blobUrl} title={cur.name} style={{ width: "100%", height: "70vh", border: 0, borderRadius: "var(--r-md)" }} />}
            {/* Решта типів (docx, xlsx, zip) у браузері не показуються — і це
                називається словами, а не порожнім місцем. */}
            {blobUrl && !isImage && !isVideo && !isPdf && (
              <div style={{ padding: "var(--sp-5)", textAlign: "center" }}>
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: "0 0 var(--sp-3)" }}>
                  Цей тип файла браузер не показує — його можна завантажити.
                </p>
                <a href={blobUrl} download={cur.name} style={{ color: "var(--brand)", fontWeight: "var(--fw-semibold)" as CSSProperties["fontWeight"] }}>
                  ⬇️ Завантажити «{cur.name}»
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Іконка за типом — щоб файл упізнавався ще до назви. */
const fileGlyph = (mime: string | null | undefined, name: string) => {
  if (mime?.startsWith("image/")) return "🖼";
  if (mime?.startsWith("video/")) return "🎞";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "📄";
  if (/\.(xlsx?|csv)$/i.test(name)) return "📊";
  if (/\.(docx?|txt|rtf)$/i.test(name)) return "📝";
  return "📎";
};
const fmtKb = (bytes: number | string) => `${Math.max(1, Math.round(Number(bytes) / 1024))} КБ`;

type ZoneFile = { key: string | number; name: string; sizeBytes: number | string; mime?: string | null; author?: string | null; canRemove: boolean };

/**
 * 📎 ЗОНА ВКЛАДЕНЬ — ОДИН ВИГЛЯД НА ВСІ МІСЦЯ (картка задачі, форма створення).
 *
 * Зразок — drop-зона «Регламентів та документів» (`DocumentsSection.tsx`), тобто
 * прийом, який у дашборді ВЖЕ Є: пунктирна рамка, підсвітка при перетягуванні,
 * клік по всій зоні відкриває вибір файла. Власник 14.09.2026: «unclear file
 * attaching — make it with the best practices, copy from somewhere». Доти
 * вкладення жили як таблиця з кнопкою під нею, а в рядку списку скріпка стояла
 * ТРИЧІ — ніщо з цього не казало «сюди можна кинути файл».
 *
 * Межі (розмір, кількість) показуються ТЕКСТОМ у самій зоні, а коли місця немає —
 * зона зникає, лишається список: вимкнена рамка без причини читається як поломка.
 */
function AttachmentZone({ files, remaining, onPickClick, onFile, onOpen, onRemove, busy, note }: {
  files: ZoneFile[];
  remaining: number;
  onPickClick: () => void;
  onFile: (f: File) => void;
  onOpen?: (f: ZoneFile) => void;
  onRemove?: (f: ZoneFile) => void;
  busy?: boolean;
  note?: string | null;
}) {
  const [over, setOver] = useState(false);
  const maxMb = Math.round(TASK_FILE_MAX_BYTES / 1024 / 1024);
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      {files.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          {files.map((f) => (
            <div key={f.key} style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", padding: "6px var(--sp-3)",
              border: "1px solid var(--border)", borderRadius: "var(--r-md)", background: "var(--card-bg)", fontSize: "var(--fs-sm)" }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{fileGlyph(f.mime, f.name)}</span>
              {onOpen ? (
                <button type="button" onClick={() => onOpen(f)} title="Подивитися"
                  style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--text)", cursor: "pointer",
                    textAlign: "left", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.name}
                </button>
              ) : (
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              )}
              <span className="recv-num" style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", flexShrink: 0 }}>
                {fmtKb(f.sizeBytes)}{f.author ? ` · ${f.author}` : ""}
              </span>
              {onRemove && f.canRemove && (
                <button type="button" title="Прибрати" onClick={() => onRemove(f)}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "0 2px", flexShrink: 0 }}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}
      {remaining > 0 ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => { if (!busy) onPickClick(); }}
          onKeyDown={(e) => { if (!busy && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPickClick(); } }}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && !busy) onFile(f); }}
          style={{
            border: `1.5px dashed ${over ? "var(--brand)" : "var(--border)"}`,
            background: over ? "var(--danger-bg)" : "transparent",
            borderRadius: "var(--r-md)", padding: "var(--sp-4)", textAlign: "center",
            cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, transition: "border-color .15s, background .15s",
          }}
        >
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text)", fontWeight: "var(--fw-semibold)" as React.CSSProperties["fontWeight"] }}>
            {busy ? "Завантаження…" : "📎 Перетягніть файл сюди або натисніть, щоб обрати"}
          </div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginTop: 2 }}>
            до {maxMb} МБ · ще {remaining} із {TASK_FILES_PER_TASK}
          </div>
        </div>
      ) : (
        <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: 0 }}>
          Ліміт {TASK_FILES_PER_TASK} файли на задачу — приберіть зайвий, щоб додати новий.
        </p>
      )}
      {note && <p style={{ fontSize: "var(--fs-sm)", color: "var(--danger)", margin: 0 }}>⚠️ {note}</p>}
    </div>
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
  const [adminTab, setAdminTab] = useState<"mine" | "shared" | "all">("mine");
  // 👁 Яку задачу переглядаємо у вкладеннях (id) — модалка поверх списку.
  const [filesViewer, setFilesViewer] = useState<number | null>(null);
  /** 🤝 Форму відкрито зі «Спільних» — виконавець не підставляється, і без нього не створити. */
  const [sharedIntent, setSharedIntent] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "done">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<number | "">("");
  const [sortBy, setSortBy] = useState<"created" | "deadline" | "priority" | "status" | "assignee" | "title">("created");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 🔗 Глибоке посилання: картка відкривається ОДРАЗУ, якщо в URL є `?id=`.
  const [openTaskId, setOpenTaskId] = useState<number | null>(() => parseTaskIdParam(window.location.search));
  const openTask = openTaskId != null ? tasks.find((t) => t.id === openTaskId) ?? null : null;

  // 🔴 «ОДНЕ ЗАВАНТАЖЕННЯ ВЖЕ ЗАВЕРШИЛОСЬ» — не те саме, що «зараз не вантажимо».
  // `tasksLoading` стартує false і стає true лише коли ефект добіг до запиту, тож на
  // першому кадрі маємо false+[] одночасно. Без цього прапорця банер «недоступна»
  // блимав би на КОЖНОМУ глибокому посиланні, включно з валідним.
  const [tasksSettled, setTasksSettled] = useState(false);
  const wasLoading = useRef(false);
  useEffect(() => {
    if (tasksLoading) wasLoading.current = true;
    else if (wasLoading.current) setTasksSettled(true);
  }, [tasksLoading]);

  // URL іде за станом картки В ОБИДВА боки: відкрили — параметр зʼявився, закрили —
  // зник. `replaceState`, а не `pushState`, з тієї самої причини, що в «Клієнтах»:
  // інакше кожне відкриття картки клало б запис в історію, і «назад» гортало б їх,
  // а не вертало людину туди, звідки вона прийшла.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (openTaskId == null) u.searchParams.delete("id");
    else u.searchParams.set("id", String(openTaskId));
    window.history.replaceState({}, "", u);
  }, [openTaskId]);

  const deepLink = deepLinkState({ openTaskId, found: openTask != null, settled: tasksSettled });
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
  /** Окрема відмова саме вкладень: вона законна (не власник) і не має гасити картку. */
  const [filesErr, setFilesErr] = useState<string | null>(null);
  /** Відмова у формі СТВОРЕННЯ: `detailErr` рендериться лише в картці задачі. */
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 📎 ПРИКРІПЛЕННЯ ПРЯМО З РЯДКА СПИСКУ.
   *
   * 🔴 ПРИВІД — ВІДГУК ВЛАСНИКА: «не можна прикріпляти файли до задач». Заміряно в
   * його ж браузері: кнопка в картці ПРАЦЮЄ (клік доходить до інпута), блок
   * «Вкладення» рендериться — але лежить у самому НИЗУ прокручуваної картки, під
   * стрічкою доповнень. Людина відкрила картку, не побачила вкладень і зробила
   * правильний висновок: прикріпити не можна. Той самий клас, що груп: контрол є,
   * але не там, де дивляться.
   *
   * ⚠️ ЦІЛЬ ТРИМАЄМО В `ref`, А НЕ В СТАНІ. `setState` асинхронний, а `input.click()`
   * мусить статись у ТОМУ Ж оброблювачі, інакше браузер втрачає користувацький жест
   * і діалог вибору файла не відкриється взагалі.
   */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 📎 ДРУГИЙ інпут — саме для форми створення, і він потрібен окремо.
   * Секційний `fileInputRef` вантажить файл НЕГАЙНО (`attachPickedFile` знає
   * `task_id`), а у формі задачі ще не існує: файл треба лише ЗАПАМʼЯТАТИ.
   * Один інпут на дві різні поведінки означав би прапорець «а зараз як?» —
   * рівно той стан, що ми вичищаємо з цього файла.
   */
  const createFileRef = useRef<HTMLInputElement | null>(null);
  /** Одна перевірка на обидва шляхи у формі — клік через інпут і перетягування в зону. */
  const acceptCreateFile = (f: File) => {
    if (f.size > TASK_FILE_MAX_BYTES) {
      // 🔴 `setDetailErr` тут не годиться: він рендериться лише в картці задачі,
      // а ми у формі створення — іншому оверлеї. Відмова летіла б у порожнечу.
      setCreateErr(`Файл «${f.name}» завеликий: ${Math.round(f.size / 1024 / 1024)} МБ, межа ${Math.round(TASK_FILE_MAX_BYTES / 1024 / 1024)} МБ`);
      return;
    }
    setCreateErr(null);
    setTaskForm((cur) => ({ ...cur, pendingFile: f }));
  };
  const uploadTargetRef = useRef<number | null>(null);
  const pickFileFor = (taskId: number) => { uploadTargetRef.current = taskId; fileInputRef.current?.click(); };

  async function attachPickedFile(file: File): Promise<void> {
    const taskId = uploadTargetRef.current;
    if (taskId == null) return;
    if (file.size > TASK_FILE_MAX_BYTES) {
      setDetailErr(`«${file.name}» — ${Math.round(file.size / 1024 / 1024 * 10) / 10} МБ, а межа 5 МБ`);
      return;
    }
    setBusy(true); setDetailErr(null);
    try {
      const added = await uploadTaskFile(taskId, file);
      // Якщо картка цієї задачі відкрита — показуємо новий файл одразу.
      if (openTaskId === taskId) setFiles((cur) => [...(cur ?? []), added]);
      refreshTasks?.();
    } catch (err) {
      setDetailErr(err instanceof Error ? err.message : `не вдалося прикріпити «${file.name}»`);
    } finally { setBusy(false); }
  }

  const reloadGroups = () => { void fetchTaskGroups().then(setGroups).catch(() => setGroups([])); };
  useEffect(() => { reloadGroups(); void fetchTaskAssignees().then(setAccounts).catch(() => setAccounts([])); }, []);

  // Відкрили задачу → тягнемо стрічку, історію, вкладення і ГАСИМО бейдж.
  useEffect(() => {
    if (openTaskId == null) { setComments(null); setFiles(null); setHistory(null); setDetailErr(null); setFilesErr(null); setCommentDraft(""); return; }
    const id = openTaskId;
    let alive = true;
    setDetailErr(null);
    setFilesErr(null);
    /**
     * 🔴 ТРИ НЕЗАЛЕЖНІ ЗАПИТИ — ТРИ НЕЗАЛЕЖНІ ВІДМОВИ. Купувалось аварією того ж
     * дня, що й звуження доступу: доти всі три їхали одним `Promise.all`, а той
     * відхиляється ПЕРШОЮ відмовою. Щойно вкладення стали приватними, `/files`
     * почав віддавати 403 наглядачеві — і разом із ним із картки зникали СТРІЧКА
     * ДОПОВНЕНЬ та ІСТОРІЯ СТАТУСУ, які сервер віддав зі статусом 200.
     *
     * Тобто одна легітимна відмова зносила два набори даних, на які людина має
     * повне право. Рівно найдорожчий клас у цьому проєкті — зникнення з екрана, —
     * і зроблений рядком, який сам не змінювався. Тримає `#400q`.
     *
     * ⚠️ Відмова вкладень має ОКРЕМИЙ стан (`filesErr`): вона стосується лише
     * свого блоку, і виносити її в загальний банер означало б сказати «картка не
     * завантажилась», коли насправді не завантажилась одна її третина.
     */
    void fetchTaskComments(id)
      .then((c) => { if (alive) setComments(c); })
      .catch((e) => { if (alive) setDetailErr(errText(e, "не вдалося завантажити обговорення")); });
    void fetchTaskHistory(id)
      .then((h) => { if (alive) setHistory(h); })
      .catch((e) => { if (alive) setDetailErr(errText(e, "не вдалося завантажити історію")); });
    void fetchTaskFiles(id)
      .then((f) => { if (alive) setFiles(f); })
      .catch((e) => { if (alive) { setFiles([]); setFilesErr(errText(e, "вкладення не відкрились")); } });
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
  // 🔴 ДОДАНО `assigneeUserId`: задача, призначена моєму АКАУНТУ (бухгалтерія, HR,
  // рекрутер — ті, кого немає в CRM), раніше не потрапляла у «Свої» взагалі. Тобто
  // виконавець-акаунт бачив задачу лише на вкладці «Усі», а тімлід — ніде.
  // 🔴 `currentManagerId != null` ОБОВʼЯЗКОВО: у наскрізних ролей і в `company`
  // (адмін, CEO, опдир, КВП, фінансист, HR, бухгалтерія) картки менеджера немає,
  // тож `currentManagerId === null`. Задача, призначена АКАУНТУ, має
  // `assignee_id = null` — і без цієї сторожі `null === null` робило б «своєю»
  // кожну чужу задачу без менеджера-виконавця.
  const isMine = (t: Task) => (currentManagerId != null && t.assigneeId === currentManagerId)
    || (t.assigneeUserId != null && t.assigneeUserId === currentUserId)
    || (t.createdById === currentUserId && t.assigneeId == null);

  /**
   * 🤝 СПІЛЬНА ЗАДАЧА — «мені ПОСТАВИВ ХТОСЬ ІНШИЙ» (вимога власника 14.09.2026,
   * дослівно: «хочу щоб хтось міг назначити задачу для когось, наприклад директор
   * для мене, і мені світилося в дашборді, що є задача»).
   *
   * Дві умови, і обидві обовʼязкові: задача НА МЕНІ (як на менеджері CRM або як на
   * акаунті) І автор — НЕ Я. Без другої умови вкладка показувала б і те, що я сам
   * собі поставив, тобто перестала б відповідати на питання «що мені прийшло».
   *
   * ⚠️ Вкладки НЕ взаємовиключні свідомо: задача від директора видна і у «Своїх»
   * (вона на мені), і у «Спільних» (її поставив інший). «Спільні» — це не окрема
   * шухляда, а зріз «що прийшло від інших»; ховати її зі «Своїх» означало б, що
   * людина, яка дивиться свій список, не бачить частини своєї роботи.
   */
  const isSharedWithMe = (t: Task) =>
    ((currentManagerId != null && t.assigneeId === currentManagerId)
      || (t.assigneeUserId != null && t.assigneeUserId === currentUserId))
    && t.createdById != null && t.createdById !== currentUserId;

  // Лічильник для вкладки: скільки прийшло від інших і не закрито, і чи є НОВЕ.
  const sharedOpen = tasks.filter((t) => isSharedWithMe(t) && t.status !== "done" && t.taskType !== "daily_kpi");
  const sharedNew = sharedOpen.filter((t) => t.hasUnseen).length;

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
      {/* Файли: у синтетичної парасольки KPI своїх вкладень немає в принципі —
          вона віртуальна, зібрана з дітей-днів. Колонка мусить бути, бо інакше
          рядок поїде на одну клітинку вліво. */}
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
              setCreateErr(null);
              setSharedIntent(false);
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

      {/* 🤝 СМУГА ВКЛАДОК — ТЕПЕР ДЛЯ ВСІХ, А НЕ ЛИШЕ ДЛЯ КЕРІВНИКІВ.
          Доти її бачили тільки адмін, тімлід і `company`, тобто менеджер не мав
          жодного способу відокремити «що мені поставили» від «що я сам завів» —
          саме про це попросив власник. «Усі / Командні» лишається за ролями. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button style={tabBtn(adminTab === "mine")} onClick={() => setAdminTab("mine")}>👤 Свої задачі</button>
        {/* 🔔 ЛІЧИЛЬНИК НА ВКЛАДЦІ — ЦЕ Й Є «ЩОБ СВІТИЛОСЯ». Число — відкриті задачі
            від інших; червона крапка — серед них є НЕПРОЧИТАНЕ (нове доповнення або
            рух статусу після мого останнього перегляду). Порожній стан числа не
            малюємо взагалі: «0» біля вкладки читалось би як несправність. */}
        <button style={tabBtn(adminTab === "shared")} onClick={() => setAdminTab("shared")}
          title="Задачі, які вам поставив хтось інший">
          🤝 Спільні задачі{sharedOpen.length > 0 ? ` · ${sharedOpen.length}` : ""}
          {sharedNew > 0 && (
            <span title={`${sharedNew} із них з новим`} style={{ display: "inline-block", width: 8, height: 8,
              borderRadius: "var(--r-pill)", background: adminTab === "shared" ? "#fff" : "var(--brand)", marginLeft: 6 }} />
          )}
        </button>
        {(isAdmin || role === "team_lead" || role === "company") && (
          <button style={tabBtn(adminTab === "all")} onClick={() => setAdminTab("all")}>{isAdmin || role === "company" ? "🗂️ Усі задачі" : "👥 Командні задачі"}</button>
        )}
        {adminTab === "mine" && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>· {accountName}</span>
        )}
        {adminTab === "shared" && (
          <>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>· поставили вам інші</span>
            {/* 🤝 ПОСТАВИТИ ЗАДАЧУ КОМУСЬ — окрема кнопка, бо «+ Додати» підставляє
                виконавцем ТЕБЕ, і зі «Спільних» це створювало звичайну задачу собі
                (відгук власника 14.09.2026). Тут виконавець порожній і обовʼязковий. */}
            <button
              onClick={() => { setCreateErr(null); setSharedIntent(true); setTaskForm({ ...emptyTaskForm }); setTaskModalOpen(true); }}
              style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid var(--brand)", background: "transparent", color: "var(--brand)", cursor: "pointer", fontWeight: 600 }}
            >🤝 Поставити задачу</button>
          </>
        )}
      </div>

      {/* 📎 ЄДИНИЙ схований інпут на всю секцію: його кличуть і рядок, і картка.
          🔴 НЕ `display:none`: такий елемент у частині рушіїв не отримує кліку від
          мітки, і кнопка виглядає живою, а діалог не відкривається. Тримаємо його
          в розкладці, але невидимим — це той самий прийом, що для доступності. */}
      <input
        ref={fileInputRef}
        type="file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void attachPickedFile(f); }}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        tabIndex={-1}
        aria-hidden
      />
      {/* 📎 Інпут ФОРМИ створення: лише запамʼятовує файл, не вантажить.
          Межу розміру перевіряємо ТУТ, а не після створення задачі: інакше задача
          вже існувала б, а файл відлітав би з 413 — «створилось, але не все». */}
      <input
        ref={createFileRef}
        type="file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) acceptCreateFile(f); }}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        tabIndex={-1}
        aria-hidden
      />

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

      {/* 🔗 ПОРОЖНЕЧА НАЗИВАЄ СЕБЕ. Посилання на чужу особисту, видалену або неіснуючу
          задачу раніше давало порожній екран: три запити супутників тихо падали 404,
          помилка лягала в стан і не малювалась. Тепер людина читає причину. */}
      {deepLink === "missing" && (
        <div className="chart-card" style={{ marginBottom: 12, borderLeft: "3px solid var(--danger, #c8102e)" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Задача №{openTaskId} недоступна</div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
            Її або видалено, або вона особиста й належить іншій людині. Посилання правильне —
            доступу до цієї задачі у вас немає.{" "}
            <button
              onClick={() => setOpenTaskId(null)}
              style={{ background: "none", border: "none", padding: 0, color: "var(--link, #2f5d8a)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
            >Показати список</button>
          </div>
        </div>
      )}

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
              <col style={{ width: "32%" }} />
              <col style={{ width: "8%" }} />
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
                {/* 👁 ПЕРЕГЛЯД ВКЛАДЕНЬ — САМЕ ПРАВОРУЧ ВІД КОМЕНТАРЯ (вимога
                    власника 14.09.2026, дослівно: «немає перегляду файлів, він має
                    бути праворуч від коментаря»). Доти файл можна було відкрити
                    ЛИШЕ з розгорнутої картки, і то в новій вкладці браузера. */}
                <th>Файли</th>
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
                /* Перемикач «Свої / Спільні / Усі».
                   🔴 ГІЛКА ДЛЯ «shared» ОБОВʼЯЗКОВА, І ОСЬ ЧОМУ. Умова написана як
                   «якщо mine — звузь», тож будь-яке ІНШЕ значення автоматично
                   означає «показати все». Додати третю вкладку й не дописати їй
                   гілку = кнопка виглядає активною й показує ВЕСЬ список — відмова,
                   яку неможливо відрізнити від роботи. Тримає `#400m`.
                   ⚠️ Для ролі `manager` вкладка «Свої» НЕ фільтрує нічого: його
                   список і так лише свій (межа стоїть на сервері), а фільтр `isMine`
                   прибрав би задачі, які він створив колезі, — тобто зробив би те
                   саме зникнення, що ми лікували 14.09. */
                const canSeeAllTab = isAdmin || role === "team_lead" || role === "company";
                if (adminTab === "mine" && canSeeAllTab) { base = base.filter(isMine); synths = synths.filter((s) => s.assigneeId === currentManagerId); }
                else if (adminTab === "shared") { base = base.filter(isSharedWithMe); synths = []; }
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
                      <td colSpan={8} className="loading-text">
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
                      {/* 👤 ВІД КОГО — лише коли автор не я: у «Своїх» це був би шум, а на
                          «Спільних» — відповідь на головне питання (відгук власника 15.09). */}
                      {task.createdByName && task.createdById !== currentUserId && (
                        <div style={{ paddingLeft: 22, marginTop: 2, fontSize: 10.5, color: "var(--text-muted)" }}>
                          👤 від: {task.createdByName}
                        </div>
                      )}
                      {(task.commentCount ?? 0) > 0 && (
                        <div style={{ paddingLeft: 22, marginTop: 2, display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", alignItems: "center" }}>
                          {/* Форма бейджа — та сама, що в сусідніх мітках 1×1 вище:
                              pill, 10.5px, приглушений фон. Новий вигляд поруч зі
                              старим читався б як інша сутність. */}
                          {(task.commentCount ?? 0) > 0 && (
                            <span title="доповнень у стрічці" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>💬 {task.commentCount}</span>
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
                    {/* 👁 КЛІТИНКА ПЕРЕГЛЯДУ. Порожній стан НАЗИВАЄ СЕБЕ («—»), а не
                        лишається порожнім: пусте місце читалось би як «колонка не
                        працює». Число — скільки вкладень, і воно вже знає межу
                        власника: сервер віддає 0 тому, кому файли не належать. */}
                    <td style={{ verticalAlign: "top" }}>
                      {task.fileCount == null ? (
                        /* 🔒 «НЕ МОЄ» — не те саме, що «немає»: сервер не називає наглядачеві
                           навіть кількості (рішення власника 14.09.2026). Прочерк збрехав би. */
                        <span title="Вкладення доступні лише автору та виконавцю задачі"
                          style={{ color: "var(--text-muted)", fontSize: 11 }}>🔒</span>
                      ) : (
                        /* ОДНЕ місце для файлів у рядку: чип відкриває перегляд, «+» додає.
                           Доти скріпка стояла тричі (під назвою, кнопкою і тут) — і жодна
                           не казала «сюди можна кинути файл». */
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          {task.fileCount > 0 && (
                            <button
                              onClick={() => setFilesViewer(task.id)}
                              title={task.fileAuthors ? `Вкладення поклав: ${task.fileAuthors}` : "Подивитися вкладення"}
                              style={{ border: "1px solid var(--border)", background: "var(--card-bg)",
                                color: "var(--text)", borderRadius: "var(--r-pill)", cursor: "pointer",
                                fontSize: 11, padding: "2px var(--sp-3)", whiteSpace: "nowrap" }}
                            >📎 {task.fileCount}</button>
                          )}
                          {task.fileCount < TASK_FILES_PER_TASK && (
                            <button
                              onClick={() => pickFileFor(task.id)}
                              disabled={busy}
                              title={`Прикріпити файл (до 5 МБ, ще ${TASK_FILES_PER_TASK - task.fileCount} із ${TASK_FILES_PER_TASK})`}
                              style={{ border: "1px dashed var(--border)", background: "transparent",
                                color: "var(--text-muted)", borderRadius: "var(--r-pill)", cursor: busy ? "default" : "pointer",
                                fontSize: 11, padding: "2px var(--sp-3)", whiteSpace: "nowrap", opacity: busy ? 0.5 : 1 }}
                            >{task.fileCount > 0 ? "+" : "+ файл"}</button>
                          )}
                        </div>
                      )}
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
                  <F icon="✍️" label="Автор">
                    <span style={{ fontSize: 13 }}>{openTask.createdByName ?? "—"}</span>
                  </F>
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

            {/* ── 📎 ВКЛАДЕННЯ ── */}
            <div style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>
                📎 Вкладення{files ? ` · ${files.length} із ${TASK_FILES_PER_TASK}` : ""}
              </h3>
              {filesErr ? (
                /* 🔒 Законна відмова називає СЕБЕ і стоїть у СВОЄМУ блоці. Показати
                   тут «Файлів ще немає» означало б збрехати: файли можуть бути, ми
                   просто не маємо права їх бачити. */
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", margin: 0 }}>🔒 {filesErr}</p>
              ) : files == null ? (
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{detailErr ? "—" : "Завантаження…"}</p>
              ) : (
                <AttachmentZone
                  files={files.map((f) => ({ key: f.id, name: f.name, sizeBytes: f.sizeBytes, mime: f.mime, author: f.author,
                    canRemove: f.createdById === currentUserId || isAdmin }))}
                  remaining={TASK_FILES_PER_TASK - files.length}
                  busy={busy}
                  /* Клік — той самий схований інпут секції, що й у рядку списку:
                     `pickFileFor(openTask.id)` наводить його на цю задачу. */
                  onPickClick={() => pickFileFor(openTask.id)}
                  /* Перетягування минає інпут — файл іде тим самим шляхом завантаження. */
                  onFile={(f) => { uploadTargetRef.current = openTask.id; void attachPickedFile(f); }}
                  onOpen={() => setFilesViewer(openTask.id)}
                  onRemove={async (zf) => {
                    if (!confirm(`Прибрати «${zf.name}»?`)) return;
                    try {
                      await deleteTaskFile(openTask.id, Number(zf.key));
                      setFiles((cur) => (cur ?? []).filter((x) => x.id !== Number(zf.key)));
                      refreshTasks?.();
                    } catch (err) {
                      setDetailErr(errText(err, "не вдалося прибрати файл"));
                    }
                  }}
                />
              )}
              <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: "var(--sp-2) 0 0" }}>
                Прибране вкладення зникає зі списку, але зберігається — відновлюється вручну.
              </p>
            </div>

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
              <h2 style={{ margin: 0, fontSize: 18 }}>{sharedIntent ? "Спільна задача — кому ставите?" : "Нова задача"}</h2>
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
                  onChange={(e) => setTaskForm((f) => {
                    const taskType = e.target.value as typeof f.taskType;
                    /**
                     * 🔴 ФАЙЛ СКИДАЄТЬСЯ РАЗОМ ІЗ ТИПОМ, І ЦЕ НЕ ПРИБИРАННЯ СТАНУ.
                     * Вкладення живе лише у простій задачі: план і реактивація йдуть
                     * іншим роутом (`/tasks/plan`, `/tasks/reactivation`) і вкладень не
                     * приймають. Лишивши файл у формі, ми отримали б стан «обрав файл,
                     * натиснув «Поставити план», файла немає» — без жодного слова
                     * людині, бо смуга вибору для цих типів навіть не малюється.
                     */
                    const pendingFile = taskType === "simple" ? f.pendingFile : null;
                    return { ...f, taskType, pendingFile };
                  })}
                >
                  <option value="simple">Звичайна</option>
                  <option value="weekly_kpi">Тижневий план (KPI)</option>
                  {(role === "admin" || role === "team_lead") && <option value="reactivation">🔄 Реактивація клієнтів</option>}
                </select>
              </label>

              {taskForm.taskType === "reactivation" ? (
                <ReactivationPlanner
                  teams={teams}
                  canPickTeam={true} /* 🔓 14.09.2026: команду обирає будь-хто */
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
                  {/* 🔓 Рішення власника 14.09.2026: «всі можуть ставити один одному
                      задачі» — селект однаковий для всіх ролей. Доти менеджер бачив
                      плашку «Ви (собі)», тобто не міг поставити задачу нікому. */}
                    <select
                      value={taskForm.assigneeId}
                      onChange={(e) =>
                        setTaskForm((f) => ({ ...f, assigneeId: e.target.value === "" ? "" : Number(e.target.value), assigneeUserId: e.target.value === "" ? f.assigneeUserId : "" }))
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
                </label>
                {taskForm.taskType === "simple" && (
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1, minWidth: 150 }}>
                    Або акаунт <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>(HR, бухгалтерія — кого немає в CRM)</span>
                    <select
                      value={taskForm.assigneeUserId}
                      onChange={(e) => setTaskForm((f) => ({
                        ...f,
                        assigneeUserId: e.target.value === "" ? "" : Number(e.target.value),
                        // Один виконавець на задачу (CHECK): обрав акаунт — менеджери знімаються.
                        assigneeId: e.target.value === "" ? f.assigneeId : "",
                        assigneeId2: e.target.value === "" ? f.assigneeId2 : "",
                      }))}
                    >
                      <option value="">—</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}{a.nameIsLogin ? " (логін)" : ""}</option>
                      ))}
                    </select>
                  </label>
                )}
                {/* 🔓 Другий виконавець тепер і менеджеру: «всі можуть ставити один одному» (14.09.2026). */}
                {taskForm.taskType === "simple" && (
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

              {/* 📎 ФАЙЛ ЩЕ НА ЕТАПІ СТВОРЕННЯ (вимога власника 14.09.2026).
                  Доти вкладення можна було покласти лише до вже створеної задачі —
                  тобто «створи, знайди в списку, потім прикріпи». Файл тримається у
                  формі й їде окремим запитом ПІСЛЯ того, як сервер назвав id. */}
              {taskForm.taskType === "simple" && (
                <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
                  <span>Вкладення <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>· не обовʼязково</span></span>
                  <AttachmentZone
                    files={taskForm.pendingFile
                      ? [{ key: "pending", name: taskForm.pendingFile.name, sizeBytes: taskForm.pendingFile.size, mime: taskForm.pendingFile.type, canRemove: true }]
                      : []}
                    /* У формі — один файл: другий докладається вже в картці. */
                    remaining={taskForm.pendingFile ? 0 : 1}
                    onPickClick={() => createFileRef.current?.click()}
                    onFile={acceptCreateFile}
                    onRemove={() => setTaskForm((cur) => ({ ...cur, pendingFile: null }))}
                    note={createErr}
                  />
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button onClick={() => setTaskModalOpen(false)}>Скасувати</button>
                <button
                  className="btn-primary"
                  onClick={handleSubmitTaskModal}
                  disabled={(taskForm.taskType === "simple" && !taskForm.title.trim())
                    || (sharedIntent && taskForm.assigneeId === "" && taskForm.assigneeUserId === "")}
                  title={sharedIntent && taskForm.assigneeId === "" && taskForm.assigneeUserId === "" ? "Оберіть, кому ставите задачу" : undefined}
                >
                  {taskForm.taskType === "simple" ? "Створити задачу" : "Поставити план"}
                </button>
              </div>
              </>)}
            </div>
          </div>
        </div>
      )}

      {/* 👁 ПЕРЕГЛЯДАЧ ВКЛАДЕНЬ — поверх усього, включно з карткою задачі
          (її шухляда має z-index 2500/2600, тож переглядач стоїть на 2700).
          Назву задачі беремо зі списку: модалка мусить казати, ЧИЇ це файли. */}
      {filesViewer != null && (
        <TaskFilesViewer
          taskId={filesViewer}
          taskTitle={tasks.find((t) => t.id === filesViewer)?.title ?? `задача #${filesViewer}`}
          onClose={() => setFilesViewer(null)}
        />
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
