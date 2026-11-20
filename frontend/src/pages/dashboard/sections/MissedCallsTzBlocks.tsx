import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMissedNoCallback, createMissedTasks, fetchMissedNorm, saveMissedNorm,
  type MissedNoCallbackResp, type MissedTaskResult, type MissedNormResp, type MissedFilterParams,
} from "../../../api";
import { managersForTeams, type MissedFilter } from "../missedCallsView";
import { VacationMark } from "../VacationMark";

/**
 * 📵 ЕКРАН «ПРОПУЩЕНІ ДЗВІНКИ» — ТЗ Юлі 12.10.2026: фільтр «Команда / Менеджер» на весь екран, кнопка «Задача» (і масова)
 * у списку «Кому передзвонити», ціль у Налаштуваннях. Звіт тижня з 20.11.2026 — перемикач «Тиждень» + таблиця «По командах»
 * з колонкою «Зміна» і «Скопіювати для звіту» (редизайн, питання 2 плану).
 * Визначення — ті самі, що на екрані (сервер, `missedNoCallbackRules`); тут лише вигляд. Стиль — той самий, що в решти
 * блоків екрана (`chart-card`, таблиця з тими самими клітинками).
 */
const MUTED = "var(--text-muted)";
const btn: React.CSSProperties = { fontSize: 12.5, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" };
const errText = (e: unknown) => {
  const ax = e as { response?: { data?: { error?: unknown } }; message?: string };
  return typeof ax?.response?.data?.error === "string" ? ax.response.data.error : ax?.message ?? "помилка";
};
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const kyiv = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/* ───────────── 👥 ФІЛЬТР — ВИПАДНИЙ СПИСОК У ШАПЦІ (редизайн 20.11.2026, п.10 плану) ───────────── */

/**
 * Той самий фільтр, що був рядком кнопок (ТЗ Юлі 12.10.2026, розділ 3): кілька команд, «Без відповідального», один менеджер.
 * Тепер — один елемент у шапці, як «Усі команди» у Звіті: рядок із 9 кнопок займав місце й важко читався.
 * Тімлід команди не обирає (сервер клампить до своєї) — лишається лише «Менеджер».
 */
export function MissedFilterMenu({ filter, onChange, teams, managers, teamLocked }: {
  filter: MissedFilter; onChange: (f: MissedFilter) => void;
  teams: { teamId: number | null; name: string }[];
  managers: { managerId: number | null; teamId: number | null; name: string }[];
  teamLocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (host.current && !host.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const opts = useMemo(() => managersForTeams(managers, filter.teams), [managers, filter.teams]);
  const named = teams.filter((t) => t.teamId != null);
  const toggle = (k: string) => {
    const teamsNext = filter.teams.includes(k) ? filter.teams.filter((x) => x !== k) : [...filter.teams, k];
    const keep = filter.managerId != null && managersForTeams(managers, teamsNext).some((m) => m.managerId === filter.managerId);
    onChange({ teams: teamsNext, managerId: keep ? filter.managerId : null });
  };
  const teamName = (k: string) => (k === "none" ? "Без відповідального" : named.find((t) => String(t.teamId) === k)?.name ?? `Команда #${k}`);
  const mgr = filter.managerId != null ? managers.find((m) => m.managerId === filter.managerId)?.name ?? `#${String(filter.managerId)}` : null;
  const base = teamLocked ? "Уся команда" : filter.teams.length === 0 ? "Усі команди"
    : filter.teams.length === 1 ? teamName(filter.teams[0]) : `${String(filter.teams.length)} команди`;
  const label = mgr ? (teamLocked || filter.teams.length === 0 ? mgr : `${base} · ${mgr}`) : base;
  const active = filter.teams.length > 0 || filter.managerId != null;
  return (
    <div className="mc-fm" ref={host}>
      <button type="button" className={`rv-sel${active ? " mc-on" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <div className="mc-fm-pop" role="dialog" aria-label="Фільтр: команда і менеджер">
          {!teamLocked && <>
            <div className="mc-fm-h">Команди</div>
            {named.map((t) => {
              const k = String(t.teamId);
              return <label key={k} className="mc-fm-row"><input type="checkbox" checked={filter.teams.includes(k)} onChange={() => toggle(k)} />{t.name}</label>;
            })}
            <label className="mc-fm-row"><input type="checkbox" checked={filter.teams.includes("none")} onChange={() => toggle("none")} />Без відповідального</label>
          </>}
          <div className="mc-fm-h">Менеджер</div>
          <select className="rv-sel" value={filter.managerId ?? ""} aria-label="Менеджер" style={{ width: "100%" }}
            onChange={(e) => onChange({ ...filter, managerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">усі</option>
            {opts.map((m) => <option key={String(m.managerId)} value={String(m.managerId)}>{m.name}</option>)}
          </select>
          <div className="mc-fm-foot">
            <button type="button" className="mc-btn2" disabled={!active} onClick={() => onChange({ teams: [], managerId: null })}>Скинути</button>
            <button type="button" className="mc-btn2" onClick={() => setOpen(false)}>Готово</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────── 📵 ЗАДАЧА З КНОПКИ — у рядку списку «Кому передзвонити» (ТЗ 12.10, розділ 4) ───────────── */

/**
 * Дані для кнопки «Задача» в рядках списку. Блок «Не передзвонили за 24 год» злився зі списком дня (редизайн 20.11.2026,
 * п.4 плану): ті самі дзвінки двічі під різними назвами. Правило кнопки НЕ змінилось — вона є там, де сервер віддає рядок
 * `no-callback` (минула доба й досі немає розмови від 10 с), і робить рівно те саме: `createMissedTasks`.
 */
export function useMissedTasks(from: string, to: string, fp: MissedFilterParams) {
  const [d, setD] = useState<MissedNoCallbackResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Record<string, MissedTaskResult>>({});
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);
  const fpKey = JSON.stringify(fp);
  useEffect(() => {
    let alive = true; setErr(null);
    fetchMissedNoCallback({ from, to, ...fp }).then((x) => { if (alive) setD(x); }).catch((e) => { if (alive) setErr(errText(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fpKey, rev]);
  const byId = useMemo(() => new Map((d?.rows ?? []).map((r) => [r.uniqueid, r])), [d]);
  // Задача ставиться на НОМЕР (один рядок на номер — найстаріший пропущений без розмови), тож повторний дзвінок того
  // самого номера бачить свою задачу через цей мап, а не порожню клітинку (баг 20.11.2026).
  const byPhone = useMemo(() => new Map((d?.rows ?? []).map((r) => [r.phone, r])), [d]);
  const assign = async (items: { uniqueid: string; managerId?: number }[]) => {
    if (!items.length) return;
    setBusy(true);
    try {
      const out = await createMissedTasks(items);
      setRes((r) => ({ ...r, ...Object.fromEntries(out.map((x) => [x.uniqueid, x])) }));
      setRev((x) => x + 1);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  return { byId, byPhone, loaded: d != null, truncated: d?.truncated ?? false, canAssign: d?.canAssign ?? false, assign, res, busy, err };
}
export type MissedTasks = ReturnType<typeof useMissedTasks>;

/** Чи можна поставити задачу з цього рядка (і отже — чи є в нього галочка для масової кнопки). */
export const taskAssignable = (t: MissedTasks, uniqueid: string): boolean =>
  t.canAssign && t.byId.get(uniqueid)?.task.state === "none" && !t.res[uniqueid];

export function TaskCell({ uniqueid, managerId, t, pick, onPick, managers }: {
  uniqueid: string; managerId: number | null; t: MissedTasks;
  pick: number | undefined; onPick: (id: number) => void;
  managers: { managerId: number | null; name: string }[];
}) {
  const row = t.byId.get(uniqueid);
  const done = t.res[uniqueid];
  if (done?.result === "error") return <span className="mc-err">{done.error}</span>;
  if (done) return done.taskId != null
    ? <a href={`/tasks?id=${String(done.taskId)}`}>{done.result === "created" ? "Задачу поставлено" : "Задача вже є"}{done.deadline ? ` · до ${ddmm(done.deadline)}` : ""}</a>
    : <span>{done.result === "created" ? "Задачу поставлено" : "Задача вже є"}</span>;
  if (!row) return null;
  if (row.task.state !== "none") {
    return <a href={`/tasks?id=${String(row.task.id)}`} className={row.task.state === "overdue" ? "mc-err" : undefined}>
      {row.task.state === "overdue" ? "прострочена" : "відкрита"}{row.task.deadline ? ` · до ${ddmm(row.task.deadline)}` : ""}</a>;
  }
  if (!t.canAssign) return <span className="mc-m">задачі немає</span>;
  return (
    <span className="mc-task">
      {managerId == null && (
        <select className="mc-pick" value={pick ?? ""} aria-label="Кому поставити" onChange={(e) => onPick(Number(e.target.value))}>
          <option value="">Обрати менеджера</option>
          {managers.filter((m) => m.managerId != null).map((m) => <option key={String(m.managerId)} value={String(m.managerId)}>{m.name}</option>)}
        </select>
      )}
      <button type="button" className="mc-btn2" disabled={t.busy || (managerId == null && !pick)}
        onClick={() => { void t.assign([{ uniqueid, ...(pick ? { managerId: pick } : {}) }]); }}>Задача</button>
    </span>
  );
}

/** Імʼя відповідального зі значком «у відпустці» — як було в блоці «Не передзвонили». */
export function ManagerName({ managerId, name }: { managerId: number | null; name: string }) {
  return <>{managerId == null ? <span className="mc-m">{name}</span> : name}<VacationMark managerId={managerId} /></>;
}

/* ───────────── 🎯 ЦІЛЬ (картка для «Налаштувань» і підпис біля метрики) ───────────── */

function useMissedNorm(): [MissedNormResp | null, () => void] {
  const [n, setN] = useState<MissedNormResp | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { fetchMissedNorm().then(setN).catch(() => setN(null)); }, [rev]);
  return [n, () => setRev((x) => x + 1)];
}

export function MissedNormCard() {
  const [n, reload] = useMissedNorm();
  const [v, setV] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await saveMissedNorm(Number(v)); setMsg("Збережено"); setV(""); reload(); }
    catch (e) { setMsg(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>📵 Ціль: передзвонили за 24 год, %</h2>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        Зараз: <b>{n?.norm == null ? "не задана" : `${String(n.norm)}%`}</b>
        {n?.setBy && <span style={{ color: MUTED }}> · встановив {n.setBy}{n.setAt ? `, ${kyiv(n.setAt)}` : ""}</span>}
      </p>
      {n?.canSet ? (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="number" min={1} max={100} value={v} onChange={(e) => setV(e.target.value)} placeholder="%" style={{ width: 80 }} aria-label="Ціль, %" />
          <button type="button" style={btn} disabled={busy || !v} onClick={() => { void save(); }}>Зберегти</button>
        </span>
      ) : <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>Змінює лише керівництво (адмін, операційний директор, CEO, КВП).</p>}
      {msg && <p style={{ fontSize: 12.5, margin: "6px 0 0", color: msg === "Збережено" ? "#16a34a" : "#dc2626" }}>{msg}</p>}
    </div>
  );
}
