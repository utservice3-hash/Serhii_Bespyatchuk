import { useState, type ReactNode } from "react";
import type { Task } from "../../../api";
import { STATUS_DOT_COLORS, STATUS_LABELS } from "../constants";
import {
  FOCUS_BUCKETS, chipKeeps, focusCounts, focusGroups,
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
export function TasksFocusView({ rows, kpi, today, showAssignee, meId, onOpen, onOpenFeed, onDone }: {
  rows: Task[];
  /** Плани KPI (тижневі парасольки) — окремою згорнутою групою, у лічильники не входять. */
  kpi: { count: number; node: ReactNode } | null;
  today: string;
  /** Колонка виконавця — коли у вибірці можуть бути чужі задачі. */
  showAssignee: boolean;
  /** Хто дивиться: «від кого» показуємо лише на чужих задачах, як і в старій таблиці. */
  meId?: number;
  onOpen: (id: number) => void;
  onOpenFeed: (id: number) => void;
  onDone: (task: Task) => void;
}) {
  const [chip, setChip] = useState<FocusChip | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["doneEarlier", "kpi"]));
  const toggle = (k: string) => setClosed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

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
    const locked = !done && (t.statusRights?.canChange === false || t.statusRights?.canDone === false);
    return (
      <div key={t.id} className={`tf-row${done ? " done" : ""}${showAssignee ? "" : " no-who"}`}>
        <button type="button" className={`tf-check${done ? " on" : ""}`} disabled={done || locked}
          onClick={() => onDone(t)}
          aria-label={done ? `№${t.id} виконано` : `Позначити №${t.id} виконаною`}
          title={done ? "Виконано" : locked ? `Закрити може ${t.reviewerName ?? "автор задачі"}` : "Позначити «Готово»"}>
          {done ? "✓" : ""}
        </button>
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
          </div>
        </div>
        <span className="tf-status" style={{ ["--dot" as string]: STATUS_DOT_COLORS[t.status] }}>{STATUS_LABELS[t.status] ?? t.status}</span>
        {showAssignee && <span className="tf-who" title={t.assigneeName ?? "Без виконавця"}>{t.assigneeName ?? "Без виконавця"}</span>}
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
