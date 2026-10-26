import { useState, type ReactNode } from "react";
import type { Task, TaskStatus } from "../../../api";
import { StatusPicker } from "../../../components/StatusPicker";
import { STATUS_DOT_COLORS } from "../constants";
import {
  FOCUS_BUCKETS, chipKeeps, focusCounts, focusGroups, goalProgress, goalState, kyivDate,
  browserStorage, readGoalsOpen, writeGoalsOpen,
  type FocusBucket, type FocusChip,
} from "../tasksFocus";

/**
 * 🎯 НОВИЙ ЕКРАН ЗАДАЧНИКА «ЩО ГОРИТЬ» (варіант Б, рішення Романа 20.10.2026, №6379 / №5998).
 *
 * Список і статистика на одному екрані: угорі плитки, під ними задачі, згруповані за терміном.
 * Плитка — це довжина групи, а не окремий підрахунок (`tasksFocus.ts`), тож цифри й список
 * збігаються побудовою. Клік по плитці лишає в списку лише її частину; повторний — знімає.
 *
 * Сюди приходить ТА САМА вибірка, що й у стару таблицю (`pickRows` у `TasksSection`), без
 * селектора статусу. Редагування — у картці задачі (клік по назві); у рядку лише галочка
 * «Готово», бо це найчастіша дія. Права на неї рахує сервер (`statusRights`).
 */
export function TasksFocusView({ rows, kpi, today, showAssignee, isMine, meId, onOpen, onOpenFeed, onDone, onReopen, onStatus, goals = [], subsOf = () => [], goalTitleOf = () => null, onAddSub }: {
  rows: Task[];
  /** Плани KPI (тижневі парасольки) — окремою згорнутою групою, у лічильники не входять. */
  kpi: { count: number; node: ReactNode } | null;
  today: string;
  /** Колонка виконавця — коли у вибірці можуть бути чужі задачі. */
  showAssignee: boolean;
  /** Задача на мені — імені в рядку не пишемо: «це мій задачник» (Роман 21.10.2026). */
  isMine: (t: Task) => boolean;
  /** Хто дивиться: «від кого» показуємо лише на чужих задачах, як і в старій таблиці. */
  meId?: number;
  onOpen: (id: number) => void;
  onOpenFeed: (id: number) => void;
  onDone: (task: Task) => void;
  /** «↩ У роботу» на виконаній задачі — виправити випадкове закриття одним кліком. */
  onReopen: (task: Task) => void;
  /** Зміна статусу з рядка (меню як у таблиці й картці). «Готово» сюди не приходить — воно йде через `onDone`. */
  onStatus: (task: Task, status: TaskStatus) => void;
  /** 🎯 Активні стратегічні цілі — блоком над усіма групами; у лічильники не входять. */
  goals?: Task[];
  /** Підзадачі цілі з УСІХ видимих задач (не лише з поточної вкладки) — з них прогрес. */
  subsOf?: (goalId: number) => Task[];
  /** Назва цілі для мітки підзадачі; `null` — ціль глядачу не видна. */
  goalTitleOf?: (goalId: number) => string | null;
  /** «+ Підзадача» — форма задачі з уже вибраною ціллю. */
  onAddSub?: (goalId: number) => void;
}) {
  const [chip, setChip] = useState<FocusChip | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["doneEarlier", "kpi"]));
  const toggle = (k: string) => setClosed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // 🎯 Блок стратегічних — згорнутий чи ні, памʼятає браузер (Роман 26.10.2026: «стратегічні можна згорнути»).
  const [goalsOpen, setGoalsOpen] = useState(() => readGoalsOpen(browserStorage()));
  const [openGoals, setOpenGoals] = useState<Set<number>>(() => new Set());
  const toggleGoal = (id: number) => setOpenGoals((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const g = focusGroups(rows, today);
  const c = focusCounts(g);

  const tile = (key: FocusChip | null, value: number, label: string, tone: "" | "err" | "ok" | "warn") => {
    const on = key != null && chip === key;
    return (
      <button type="button" className={`tf-tile${tone ? ` tf-${tone}` : ""}${on ? " on" : ""}`} aria-pressed={key == null ? undefined : on}
        onClick={() => setChip(key == null || on ? null : key)}
        title={key == null ? "Показати всі активні" : on ? "Зняти фільтр" : `Показати лише: ${label.toLowerCase()}`}>
        <span className="tf-v">{value}</span>
        <span className="tf-k">{label}</span>
      </button>
    );
  };

  const row = (t: Task, done: boolean) => {
    const late = !done && !!t.deadline && t.deadline < today;
    return (
      <div key={t.id} className={`tf-row${done ? " done" : ""}${showAssignee ? "" : " no-who"}`}
        style={done ? undefined : { ["--st" as string]: STATUS_DOT_COLORS[t.status] }}>
        <div className="tf-main">
          <button type="button" className="tf-title" onClick={() => onOpen(t.id)} title="Відкрити картку задачі">{t.title || "Без назви"}</button>
          <div className="tf-meta">
            {t.hasUnseen && <span className="tf-dot" title="Є нове після вашого останнього перегляду" />}
            {t.createdByName && t.createdById !== meId && <span>від: {t.createdByName}</span>}
            {(t.commentCount ?? 0) > 0 && (
              <button type="button" className="tf-feed" onClick={() => onOpenFeed(t.id)} title="Відкрити стрічку доповнень">💬 {t.commentCount}</button>
            )}
            {t.groupName && <span>📁 {t.groupName}</span>}
            {t.pinned && <span>📌 закріплено</span>}
            {t.goalId != null && (
              <button type="button" className="tf-goal-mark" onClick={() => onOpen(t.goalId!)} title="Відкрити стратегічну ціль">
                🎯 → {goalTitleOf(t.goalId) ?? "стратегічна ціль"}
              </button>
            )}
          </div>
        </div>
        {done && t.statusRights?.canChange !== false ? (
          <button type="button" className="tf-reopen" onClick={() => onReopen(t)} title="Повернути задачу в роботу (статус «В процесі»)">↩ У роботу</button>
        ) : (
          <span className="tf-status-pick">
            {/* Те саме меню, що в таблиці й картці: права з сервера, «Готово» без права — сірий пункт.
                «Готово» звідси йде через галочку — разом зі «Скасувати». */}
            <StatusPicker value={t.status} rights={t.statusRights} reviewerName={t.reviewerName}
              onChange={(st) => (st === "done" ? onDone(t) : onStatus(t, st))} />
          </span>
        )}
        {showAssignee && (isMine(t) ? <span className="tf-who" /> : <span className="tf-who" title={t.assigneeName ?? "Без виконавця"}>{t.assigneeName ?? "Без виконавця"}</span>)}
        <span className={`tf-dl${late ? " late" : ""}`}>{done ? (t.doneAt ? `✓ ${ddmm(t.doneAt)}` : "✓") : t.deadline ? ddmm(t.deadline) : "—"}</span>
      </div>
    );
  };

  const group = (key: string, label: string, items: Task[], done: boolean, tone = "") => {
    if (items.length === 0) return null;
    const isClosed = closed.has(key);
    return (
      <section key={key} className="tf-group">
        <button type="button" className={`tf-gh${tone ? ` tf-${tone}` : ""}`} aria-expanded={!isClosed} onClick={() => toggle(key)}>
          <span aria-hidden="true">{isClosed ? "▸" : "▾"}</span> {label} <span className="tf-cnt">· {items.length}</span>
        </button>
        {!isClosed && items.map((t) => row(t, done))}
      </section>
    );
  };

  /**
   * 🎯 КАРТКА ЦІЛІ. Прогрес — за підзадачами, які бачить глядач; колір — `goalState` (вчасно / відстає /
   * прострочено / усе виконано — чекає закриття). Статус — те саме меню, що в рядку; «Готово» — через
   * `onDone`, тобто зі «Скасувати», а закрити дасть лише «Приймає» (права з сервера).
   */
  const goalCard = (goal: Task) => {
    const subs = subsOf(goal.id);
    const { done, total } = goalProgress(subs);
    const st = goalState({ status: goal.status, deadline: goal.deadline, start: goal.createdAt ? kyivDate(new Date(goal.createdAt)) : null }, subs, today);
    const open = openGoals.has(goal.id);
    return (
      <div key={goal.id} className={`tf-goal g-${st}`}>
        <div className="tf-goal-row">
          <button type="button" className="tf-goal-chev" aria-expanded={open} onClick={() => toggleGoal(goal.id)}
            title={open ? "Згорнути підзадачі" : "Показати підзадачі"}>{open ? "▾" : "▸"}</button>
          <div className="tf-main">
            <button type="button" className="tf-title" onClick={() => onOpen(goal.id)} title="Відкрити картку цілі">{goal.title || "Без назви"}</button>
            <div className="tf-meta">
              {goal.goalResult && <span>Результат: <b className="tf-goal-res">{goal.goalResult}</b></span>}
              {!isMine(goal) && goal.assigneeName && <span>{goal.assigneeName}</span>}
            </div>
          </div>
          <div className="tf-goal-prog" title={total ? `${done} з ${total} підзадач виконано` : "Підзадач ще немає"}>
            <div className="tf-bar"><i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></div>
            <small>{total ? `${done} з ${total} підзадач` : "підзадач ще немає"}</small>
          </div>
          <span className="tf-status-pick" style={{ ["--st" as string]: STATUS_DOT_COLORS[goal.status] }}>
            <StatusPicker value={goal.status} rights={goal.statusRights} reviewerName={goal.reviewerName}
              onChange={(next) => (next === "done" ? onDone(goal) : onStatus(goal, next))} />
          </span>
          <span className={`tf-dl${st === "late" ? " late" : ""}`}>{goal.deadline ? ddmm(goal.deadline) : "—"}</span>
        </div>
        {open && (
          <div className="tf-subs">
            {subs.length === 0 && <p className="tf-sub-empty">Підзадач ще немає — розкладіть ціль на кроки.</p>}
            {subs.map((sub) => (
              <div key={sub.id} className={`tf-sub${sub.status === "done" ? " done" : ""}`} style={{ ["--st" as string]: STATUS_DOT_COLORS[sub.status] }}>
                <button type="button" className="tf-title" onClick={() => onOpen(sub.id)} title="Відкрити підзадачу">{sub.title || "Без назви"}</button>
                <span className="tf-status-pick">
                  <StatusPicker value={sub.status} rights={sub.statusRights} reviewerName={sub.reviewerName}
                    onChange={(next) => (next === "done" ? onDone(sub) : onStatus(sub, next))} />
                </span>
                <span className="tf-who">{isMine(sub) ? "" : sub.assigneeName ?? "Без виконавця"}</span>
                <span className={`tf-dl${sub.status !== "done" && sub.deadline && sub.deadline < today ? " late" : ""}`}>{sub.deadline ? ddmm(sub.deadline) : "—"}</span>
              </div>
            ))}
            {onAddSub && <button type="button" className="tf-plus" onClick={() => onAddSub(goal.id)}>+ Підзадача</button>}
          </div>
        )}
      </div>
    );
  };

  const keep = (b: FocusBucket | "doneWeek" | "doneEarlier") => (t: Task) => chipKeeps(chip, b, t.status);
  const groups = FOCUS_BUCKETS.map((b) => group(b.key, b.label, g[b.key].filter(keep(b.key)), false, b.key === "late" ? "err" : ""));
  const nothing = c.active === 0 && g.doneWeek.length === 0 && g.doneEarlier.length === 0 && !kpi;

  return (
    <div className="chart-card tf">
      <div className="tf-tiles">
        {tile(null, c.active, "Активні", "")}
        {tile("late", c.late, "Прострочені", "err")}
        {tile("thisWeek", c.thisWeek, "Дедлайн цього тижня", "")}
        {tile("review", c.review, "На затвердженні", "warn")}
        {tile("doneWeek", c.doneWeek, "Виконано цього тижня", "ok")}
      </div>
      {chip && (
        <div className="tf-filter">
          Показано лише: <b>{chip === "late" ? "прострочені" : chip === "thisWeek" ? "дедлайн цього тижня" : chip === "review" ? "на затвердженні" : "виконані цього тижня"}</b>
          <button type="button" onClick={() => setChip(null)}>Показати все</button>
        </div>
      )}
      {goals.length > 0 && (
        <section className="tf-goals" aria-label="Стратегічні задачі">
          <button type="button" className="tf-gh tf-goals-h" aria-expanded={goalsOpen}
            onClick={() => { const v = !goalsOpen; setGoalsOpen(v); writeGoalsOpen(browserStorage(), v); }}>
            <span aria-hidden="true">{goalsOpen ? "▾" : "▸"}</span> 🎯 Стратегічні <span className="tf-cnt">· {goals.length}</span>
          </button>
          {goalsOpen && goals.map(goalCard)}
        </section>
      )}
      {nothing ? (
        <p className="loading-text">Задач немає.</p>
      ) : (
        <div className="tf-list">
          {groups}
          {group("doneWeek", "Виконано цього тижня", g.doneWeek.filter(keep("doneWeek")), true, "ok")}
          {chip == null && group("doneEarlier", "Виконано раніше", g.doneEarlier, true)}
          {chip == null && kpi && kpi.count > 0 && (
            <section className="tf-group">
              <button type="button" className="tf-gh" aria-expanded={!closed.has("kpi")} onClick={() => toggle("kpi")}>
                <span aria-hidden="true">{closed.has("kpi") ? "▸" : "▾"}</span> Плани KPI <span className="tf-cnt">· {kpi.count}</span>
              </button>
              {!closed.has("kpi") && kpi.node}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
