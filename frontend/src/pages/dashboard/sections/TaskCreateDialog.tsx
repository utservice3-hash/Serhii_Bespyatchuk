import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { ManagerOption, TaskAssignee, TaskPriority } from "../../../api";
import type { TaskForm } from "../taskForm";
import { teamGroups } from "../assigneeGroups";
import { kyivDate } from "../tasksFocus";
import { formMissing, pickGroups, quickDates, type PickPerson } from "../taskCreateRules";

/**
 * 🆕 НОВА ЗАДАЧА — КОМПАКТНИЙ ДІАЛОГ (варіант А, рішення Романа 26.10.2026: «роби А»).
 *
 * Угорі — тип («Задача / 🎯 Стратегічна задача / KPI-план / Реактивація»; назва — рішення Романа 26.10.2026), далі опис великим полем, для цілі —
 * фіолетовий блок «Результат», рядок пігулок (👤 Виконавець · 📅 Дедлайн · ⚑ Пріоритет · ✅ Приймає),
 * рідкісне — під «+ Ще». Унизу «Бракує: …» і бліда кнопка, поки форма неповна; Ctrl/⌘+Enter — створити.
 *
 * Стан форми — той самий `TaskForm` у контейнері, і подання — той самий `handleSubmitTaskModal`:
 * діалог змінює вигляд, а не те, що їде на сервер. KPI-план і Реактивація лишаються своїми формами —
 * перемикач лише відкриває їх (`onKind`).
 *
 * Зону файла, «список не завантажився» і «неактивні з команди» малює `TasksSection` і передає слотами:
 * це ті самі компоненти, що в картці задачі, тож поведінка (межа розміру, повтор, підказка) — одна.
 */
type Kind = "task" | "goal" | "kpi" | "react";

export function TaskCreateDialog({
  form, setForm, sharedIntent, managerOptions, myTeamId, accounts, currentUserId, deptOptions, goalTitle,
  canReactivation, assigneeStatus, fileZone, onKind, onSubmit, onClose, selfManagerId = null, selfName,
}: {
  form: TaskForm;
  setForm: Dispatch<SetStateAction<TaskForm>>;
  /** Задачу ставлять зі «Спільних»: виконавець обовʼязковий, себе не підставляємо. */
  sharedIntent: boolean;
  managerOptions: ManagerOption[];
  myTeamId: number | null;
  accounts: TaskAssignee[];
  currentUserId?: number;
  deptOptions: string[];
  /** Назва цілі, якщо це підзадача (`form.goalId`). */
  goalTitle: string | null;
  canReactivation: boolean;
  /** «Список виконавців не завантажився · Повторити» і «неактивні з вашої команди». */
  assigneeStatus: ReactNode;
  /** Зона вкладення форми (та сама `AttachmentZone`, що в картці). */
  fileZone: ReactNode;
  /** Перемикач на KPI-план / Реактивацію — відкриває їхні форми. */
  onKind: (k: "kpi" | "react") => void;
  onSubmit: () => void;
  onClose: () => void;
  /**
   * Моя картка менеджера і моє імʼя. Форма за замовчуванням ставить виконавцем МЕНЕ — але моєї картки може
   * не бути серед активних менеджерів (Роман на неактивній №387273), і пігулка показувала «№387273»
   * (26.10.2026). Тепер — «Я (імʼя)». Тримає `#2394`.
   */
  selfManagerId?: number | null;
  selfName?: string;
}) {
  const [pop, setPop] = useState<null | "who" | "who2" | "date" | "prio" | "review">(null);
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(() => !!(form.department || form.comments || form.pendingFile));
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  const kind: Kind = form.strategic ? "goal" : "task";
  const missing = formMissing(form, { sharedIntent });
  const today = kyivDate(new Date());

  // Хто є хто — для підписів пігулок.
  const managerName = (id: number | "") => (id === "" ? null
    : id === selfManagerId ? `Я${selfName ? ` (${selfName})` : ""}`
    : managerOptions.find((m) => m.id === id)?.name ?? `№${id}`);
  const accountName = (id: number | "") => (id === "" ? null : accounts.find((a) => a.id === id)?.name ?? `№${id}`);
  const who = form.assigneeUserId !== "" ? accountName(form.assigneeUserId) : managerName(form.assigneeId);
  const who2 = managerName(form.assigneeId2);
  const reviewer = form.reviewerId === "" ? null : accountName(form.reviewerId);

  // Акаунти без менеджера CRM: менеджера обирають як менеджера, інакше людина була б у списку двічі.
  const plainAccounts = useMemo(() => accounts.filter((a) => a.managerId == null), [accounts]);
  const groups = useMemo(() => pickGroups(teamGroups(managerOptions, myTeamId), plainAccounts, query),
    [managerOptions, myTeamId, plainAccounts, query]);
  const groups2 = useMemo(() => pickGroups(teamGroups(managerOptions, myTeamId, form.assigneeId), [], query),
    [managerOptions, myTeamId, form.assigneeId, query]);

  const pick = (p: PickPerson) => {
    // Один виконавець на задачу (CHECK): акаунт знімає менеджерів, менеджер — акаунт.
    setForm((f) => p.kind === "account"
      ? { ...f, assigneeUserId: p.id, assigneeId: "", assigneeId2: "" }
      : { ...f, assigneeId: p.id, assigneeUserId: "", assigneeId2: f.assigneeId2 === p.id ? "" : f.assigneeId2 });
    setPop(null); setQuery("");
  };
  const setKind = (k: Kind) => {
    if (k === "kpi" || k === "react") { onKind(k); return; }
    setForm((f) => ({ ...f, strategic: k === "goal" }));
  };
  const submit = () => { if (missing.length === 0) onSubmit(); };
  const toggle = (p: typeof pop) => { setPop((cur) => (cur === p ? null : p)); setQuery(""); };

  const personList = (gs: [string, PickPerson[]][], onPick: (p: PickPerson) => void, clear?: { label: string; run: () => void }) => (
    <div className="tc-pop" role="dialog" onClick={(e) => e.stopPropagation()}>
      <input className="tc-search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Пошук людини…" aria-label="Пошук людини" />
      <div className="tc-scroll">
        {clear && <button type="button" className="tc-it" onClick={clear.run}>{clear.label}</button>}
        {gs.length === 0 && <p className="tc-empty">Нікого не знайдено</p>}
        {gs.map(([title, ps]) => (
          <div key={title}>
            <div className="tc-grp">{title}</div>
            {ps.map((p) => (
              <button type="button" key={`${p.kind}-${p.id}`} className="tc-it" onClick={() => onPick(p)}>
                <span className="tc-ava">{initials(p.name)}</span>{p.name}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="tc-backdrop" onClick={onClose}>
      <div className="tc" role="dialog" aria-label={sharedIntent ? "Спільна задача — кому ставите?" : "Нова задача"}
        onClick={(e) => { e.stopPropagation(); setPop(null); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { if (pop) setPop(null); else onClose(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}>
        <div className="tc-top">
          {sharedIntent ? <b className="tc-h">Спільна задача — кому ставите?</b> : (
            <div className="tc-seg" role="group" aria-label="Тип задачі">
              {(([["task", "Задача"], ["goal", "🎯 Стратегічна задача"], ["kpi", "KPI-план"], ...(canReactivation ? [["react", "Реактивація"]] : [])]) as [Kind, string][])
                .filter(([k]) => !(form.goalId !== "" && k === "goal"))
                .map(([k, label]) => (
                  <button key={k} type="button" className={k === "goal" ? "goal" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
                ))}
            </div>
          )}
          <button type="button" className="tc-x" aria-label="Закрити" onClick={onClose}>×</button>
        </div>

        {form.goalId !== "" && (
          <div className="tc-sub">
            <span>🎯 Підзадача до стратегічної задачі «{goalTitle ?? `№${form.goalId}`}»</span>
            <button type="button" onClick={() => setForm((f) => ({ ...f, goalId: "" }))} title="Відвʼязати від стратегічної задачі">✕</button>
          </div>
        )}

        <textarea ref={titleRef} className="tc-title" rows={2} value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          placeholder={kind === "goal" ? "Яка стратегічна задача? Напр.: вивести РПК на 3 млн на місяць" : "Що зробити? Опишіть задачу"} aria-label="Опис задачі" />

        {kind === "goal" && (
          <div className="tc-res">
            <label htmlFor="tc-res">Результат — як зрозуміти, що задачу виконано <span className="tc-req">обовʼязково</span></label>
            <input id="tc-res" className={form.goalResult.trim() ? "" : "bad"} value={form.goalResult} maxLength={500}
              onChange={(e) => setForm((f) => ({ ...f, goalResult: e.target.value }))}
              placeholder="Напр.: гроші РПК за грудень ≥ 3 млн ₴ у Звіті КВП" />
            {!form.goalResult.trim() && <span className="tc-hint">Без результату стратегічна задача не створиться</span>}
          </div>
        )}

        <div className="tc-chips">
          <span className="tc-anchor">
            <button type="button" className={`tc-chip${who ? " set" : ""}${sharedIntent && !who ? " req" : ""}`}
              onClick={(e) => { e.stopPropagation(); toggle("who"); }}>
              {who ? <span className="tc-ava">{initials(who)}</span> : "👤 "}{who ?? (sharedIntent ? "Кому ставите *" : "Виконавець")}
            </button>
            {pop === "who" && personList(groups, pick, who && !sharedIntent
              ? { label: "— без виконавця (особиста)", run: () => { setForm((f) => ({ ...f, assigneeId: "", assigneeUserId: "", assigneeId2: "" })); setPop(null); } }
              : undefined)}
          </span>
          {form.assigneeId !== "" && kind === "task" && (
            <span className="tc-anchor">
              <button type="button" className={`tc-chip${who2 ? " set" : ""}`} onClick={(e) => { e.stopPropagation(); toggle("who2"); }}
                title="Задача одразу для двох менеджерів — створиться копія кожному">
                {who2 ? <><span className="tc-ava">{initials(who2)}</span>{who2}</> : "+ ще один виконавець"}
              </button>
              {pop === "who2" && personList(groups2, (p) => { setForm((f) => ({ ...f, assigneeId2: p.id })); setPop(null); setQuery(""); },
                who2 ? { label: "— лише одному", run: () => { setForm((f) => ({ ...f, assigneeId2: "" })); setPop(null); } } : undefined)}
            </span>
          )}
          <span className="tc-anchor">
            <button type="button" className={`tc-chip${form.deadline ? " set" : ""}`} onClick={(e) => { e.stopPropagation(); toggle("date"); }}>
              📅 {form.deadline ? ddmmyy(form.deadline) : "Дедлайн"}
            </button>
            {pop === "date" && (
              <div className="tc-pop" onClick={(e) => e.stopPropagation()}>
                <div className="tc-dates">
                  {quickDates(today).map((q) => (
                    <button type="button" key={q.label} className={form.deadline === q.date ? "on" : ""}
                      onClick={() => { setForm((f) => ({ ...f, deadline: q.date })); setPop(null); }}>
                      {q.label} <small>{ddmm(q.date)}</small>
                    </button>
                  ))}
                </div>
                <label className="tc-cal">Інша дата
                  <input type="date" value={form.deadline} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))} />
                </label>
                {form.deadline && <button type="button" className="tc-it" onClick={() => { setForm((f) => ({ ...f, deadline: "" })); setPop(null); }}>Без дедлайну</button>}
              </div>
            )}
          </span>
          <span className="tc-anchor">
            <button type="button" className={`tc-chip${form.priority !== "medium" ? " set" : ""}`} onClick={(e) => { e.stopPropagation(); toggle("prio"); }}>
              ⚑ {PRIO[form.priority]}
            </button>
            {pop === "prio" && (
              <div className="tc-pop tc-pop-sm" onClick={(e) => e.stopPropagation()}>
                {(["high", "medium", "low"] as TaskPriority[]).map((p) => (
                  <button type="button" key={p} className="tc-it" onClick={() => { setForm((f) => ({ ...f, priority: p })); setPop(null); }}>⚑ {PRIO[p]}</button>
                ))}
              </div>
            )}
          </span>
          <span className="tc-anchor">
            <button type="button" className={`tc-chip${reviewer ? " set" : ""}`} onClick={(e) => { e.stopPropagation(); toggle("review"); }}
              title="Хто ставить «Готово». За замовчуванням — ви, автор">
              ✅ Приймає: {reviewer ?? "я (автор)"}
            </button>
            {pop === "review" && personList(
              pickGroups([], accounts.filter((a) => a.id !== currentUserId), query).map(([, ps]) => ["Акаунти", ps] as [string, PickPerson[]]),
              (p) => { setForm((f) => ({ ...f, reviewerId: p.id })); setPop(null); setQuery(""); },
              { label: "— я (автор)", run: () => { setForm((f) => ({ ...f, reviewerId: "" })); setPop(null); } })}
          </span>
        </div>
        {assigneeStatus}

        {more ? (
          <div className="tc-more">
            <label>Департамент
              <select value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}>
                <option value="">—</option>
                {form.department && !deptOptions.includes(form.department) && <option value={form.department}>{form.department}</option>}
                {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label>Короткий коментар — видно в рядку списку
              <textarea rows={2} value={form.comments} onChange={(e) => setForm((f) => ({ ...f, comments: e.target.value }))} />
            </label>
            {fileZone}
          </div>
        ) : (
          <button type="button" className="tc-morebtn" onClick={() => setMore(true)}>+ Ще: департамент, коментар, файл</button>
        )}

        <div className="tc-foot">
          <span className="tc-kbd">⌘/Ctrl + Enter — створити</span>
          <span className="tc-spacer" />
          {missing.length > 0 && <span className="tc-why">Бракує: {missing.join(", ")}</span>}
          <button type="button" className="tc-btn ghost" onClick={onClose}>Скасувати</button>
          <button type="button" className="tc-btn pri" disabled={missing.length > 0} onClick={submit}
            title={missing.length ? `Бракує: ${missing.join(", ")}` : undefined}>
            {kind === "goal" ? "Створити стратегічну задачу" : form.goalId !== "" ? "Створити підзадачу" : "Створити задачу"}
          </button>
        </div>
      </div>
    </div>
  );
}

const PRIO: Record<TaskPriority, string> = { high: "Високий", medium: "Середній", low: "Низький" };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const ddmmyy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
