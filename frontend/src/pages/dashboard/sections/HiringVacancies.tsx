import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchHiringVacancies, createHiringVacancy, patchHiringVacancy, hiringError,
  type HiringMeta, type HiringVacancyRow, type HiringVacancyStatus,
} from "../../../api";
import { dm, todayKyiv, VACANCY_TONE, isClosedVacancy } from "../hiringView";
import type { Toast } from "./HiringShared";

/**
 * 💼 «ВАКАНСІЇ» — прохід 1a, за записом Хурми Івана: список зі статусами (відкрита, в роботі, на
 * паузі, закрита, скасована) і кількістю кандидатів. Кількість — з повʼязок кандидат × вакансія
 * (#523), клік відкриває «Кандидатів» із фільтром цієї вакансії. Закриття — лише з результатом.
 *
 * 22.09.2026 — новий вигляд за макетом (затвердив Роман): великі плитки загальної статистики, у таблиці
 * воронка вакансії колонками (кандидатів · співбесід · навчання · менеджер) з конверсією, «прийнято N із
 * потрібних» зі смужкою, сигнали. Воронку рахує сервер тим самим «дійшов за найдальшим етапом», що й
 * «Зведення» (#626/#627). «Прийнято» = дійшли до «Менеджер» на цій вакансії.
 * Статус і «хто веде» більше не міняються прямо в рядку (випадковий клік міняв вакансію) — через «⋯».
 * ⚠️ Сигнал «давно без нових кандидатів» НЕ показуємо тривогою: порогу не назвали (ВІДКРИТЕ ПИТАННЯ до
 * Івана), тож видно факт — «останній кандидат N дн. тому».
 */
const STAGES = [["candidates", "Кандидатів"], ["interviews", "Співбесід"], ["training", "Навчання"], ["managers", "Менеджер"]] as const;
const LATE_DAYS = 60;

export function HiringVacancies({ meta, toast, onOpenCandidates, onChanged }: {
  meta: HiringMeta; toast: Toast; onOpenCandidates: (vacancyId: number) => void; onChanged: () => void;
}) {
  const [scope, setScope] = useState<"active" | "closed">("active");
  const [all, setAll] = useState<HiringVacancyRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<HiringVacancyRow | null>(null);
  const [editing, setEditing] = useState<HiringVacancyRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ v: HiringVacancyRow; x: number; y: number } | null>(null);
  const edit = meta.access === "edit";

  const load = useCallback(() => {
    let alive = true;
    fetchHiringVacancies("all").then((a) => { if (alive) { setAll(a); setErr(null); } }).catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close); window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);

  const patch = async (v: HiringVacancyRow, p: Record<string, unknown>, msg: string) => {
    try { await patchHiringVacancy(v.id, p); toast(msg); load(); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };

  if (err) return <div className="chart-card" style={{ color: "var(--danger)" }}>{err}</div>;
  if (!all) return <p className="loading-text">Завантаження…</p>;
  const active = all.filter((v) => !isClosedVacancy(v.status));
  const closed = all.filter((v) => isClosedVacancy(v.status));
  const hot = (v: HiringVacancyRow) => !isClosedVacancy(v.status) && v.days_open > LATE_DAYS;
  const rows = scope === "active"
    ? [...active].sort((a, b) => Number(hot(b)) - Number(hot(a)) || a.opened_on.localeCompare(b.opened_on))
    : [...closed].sort((a, b) => (b.closed_on ?? "").localeCompare(a.closed_on ?? ""));
  const F = (v: HiringVacancyRow, k: typeof STAGES[number][0]) => v.funnel?.[k] ?? 0;
  const needAll = active.reduce((a, v) => a + v.need, 0);
  const hiredAll = active.reduce((a, v) => a + F(v, "managers"), 0);
  const stillNeed = active.reduce((a, v) => a + Math.max(0, v.need - F(v, "managers")), 0);
  const cands = active.reduce((a, v) => a + F(v, "candidates"), 0);
  const ivs = active.reduce((a, v) => a + F(v, "interviews"), 0);
  const trainAll = active.reduce((a, v) => a + F(v, "training") - F(v, "managers"), 0);
  const avgClose = closed.length ? Math.round(closed.reduce((a, v) => a + v.days_open, 0) / closed.length) : null;
  const hotN = active.filter(hot).length;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const statusLabel = (s: HiringVacancyStatus) => meta.vacancyStatuses.find((x) => x.key === s)?.label ?? s;
  const open = openId != null ? all.find((v) => v.id === openId) ?? null : null;
  const cnt = (k: HiringVacancyStatus) => active.filter((v) => v.status === k).length;

  return (
    <div>
      <div className="vc-kpis">
        <div className="vc-kpi"><span className="k">Активні вакансії</span><span className="v">{active.length}</span><span className="s">відкриті {cnt("open")} · в роботі {cnt("in_work")} · пауза {cnt("paused")}</span></div>
        <div className="vc-kpi"><span className="k">Ще потрібно людей</span><span className="v">{stillNeed}</span><span className="s">з {needAll} на всі активні вакансії</span></div>
        <div className="vc-kpi"><span className="k">Прийнято</span><span className="v">{hiredAll}<small>/ {needAll}</small></span>
          <div className="vc-track"><i style={{ width: `${Math.min(100, pct(hiredAll, needAll))}%`, background: "var(--ok)" }} /></div>
          <span className="s">{pct(hiredAll, needAll)}% плану найму · на навчанні {trainAll}</span></div>
        <div className="vc-kpi"><span className="k">Кандидатів</span><span className="v">{cands}</span><span className="s">співбесід {ivs} · {pct(ivs, cands)}% дійшли</span></div>
        <div className="vc-kpi"><span className="k">Днів до закриття</span><span className="v">{avgClose ?? "—"}</span><span className="s">{avgClose == null ? "закритих вакансій ще немає" : `у середньому по ${closed.length} закритих`}</span></div>
        <div className={`vc-kpi ${hotN ? "hot" : ""}`}><span className="k">Понад {LATE_DAYS} днів</span><span className="v">{hotN}</span><span className="s">{hotN ? "вакансії, що горять" : "усе в межах"}</span></div>
      </div>
      <div className="hr-pills">
        {([["active", `Активні · ${active.length}`], ["closed", `Закриті · ${closed.length}`]] as const).map(([k, l]) => (
          <button key={k} className={scope === k ? "on" : ""} onClick={() => setScope(k)}>{l}</button>
        ))}
        {edit && <button className="hr-btn p" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>+ Вакансія</button>}
      </div>
      <div className="hr-card">
        <div className="hr-tw">
          <table className="hr-table vc-table">
            <thead><tr>
              <th>Вакансія</th><th>Статус</th><th>Веде</th><th style={{ minWidth: 150 }}>Прийнято</th>
              {STAGES.map(([k, l]) => <th key={k} className="c">{l}</th>)}
              <th className="num">Днів</th><th>Сигнали</th><th />
            </tr></thead>
            <tbody>
              {rows.map((v) => {
                const isClosed = isClosedVacancy(v.status), hired = F(v, "managers"), p = Math.min(100, pct(hired, v.need));
                const tr = Math.min(100 - p, pct(F(v, "training") - hired, v.need));
                return (
                  <tr key={v.id} className={`vc-row ${hot(v) ? "late" : ""} ${isClosed ? "off" : ""}`} tabIndex={0}
                    onClick={() => setOpenId(v.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpenId(v.id); }}>
                    <td><b>{v.title}</b>
                      <div className="hr-muted">{v.opened_by ? `відкрив ${v.opened_by} ` : "відкрито "}{dm(v.opened_on)}
                        {isClosed ? ` · закрито ${dm(v.closed_on)}` : ""}{v.funnel?.sources.length ? ` · ${v.funnel.sources.slice(0, 3).map((x) => `${x.label} ${x.n}`).join(" · ")}` : ""}</div></td>
                    <td><span className={`hr-pill ${VACANCY_TONE[v.status]}`}>{statusLabel(v.status)}</span></td>
                    <td>{v.responsible || <span className="hr-muted">—</span>}</td>
                    <td><div className="hr-muted" style={{ marginBottom: 4 }}><b style={{ color: "var(--text)" }}>{hired}</b> із {v.need}{!isClosed && ` · лишилось ${Math.max(0, v.need - hired)}`}</div>
                      <div className="vc-track" title="зелене — прийнято, синє — на навчанні"><i style={{ width: `${p}%`, background: "var(--ok)" }} /><i style={{ width: `${tr}%`, background: "var(--info)", opacity: .55 }} /></div></td>
                    {STAGES.map(([k], i) => {
                      const n = F(v, k), prev = i ? F(v, STAGES[i - 1][0]) : 0;
                      return <td key={k} className="c"><b>{n}</b>{i > 0 && <div className="cv">{prev ? `${pct(n, prev)}%` : ""}</div>}</td>;
                    })}
                    <td className="num" style={hot(v) ? { color: "var(--danger)", fontWeight: 700 } : undefined}>{v.days_open}</td>
                    <td>
                      {hot(v) && <span className="hr-pill dg">понад {LATE_DAYS} днів</span>}
                      {!isClosed && (v.funnel?.fresh ?? 0) > 0 && <span className="hr-pill wn">{v.funnel!.fresh} нових без контакту</span>}
                      {!isClosed && v.funnel?.lastAddedDays != null && v.funnel.lastAddedDays > 0 && <span className="hr-pill gr">останній кандидат {v.funnel.lastAddedDays} дн. тому</span>}
                      {!isClosed && !v.funnel && <span className="hr-pill gr">кандидатів ще немає</span>}
                      {isClosed && <span className="hr-pill gr">{v.close_result ?? "закрито"}</span>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      <button className="hr-btn xs" onClick={() => onOpenCandidates(v.id)} title="Кандидати цієї вакансії">Кандидати ›</button>{" "}
                      {edit && <button className="hr-btn xs" aria-label="Ще дії" onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ v, x: r.right, y: r.bottom }); }}>⋯</button>}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={11} className="hr-muted">{scope === "closed" ? "Закритих вакансій ще немає." : "Активних вакансій немає. Натисніть «+ Вакансія», щоб відкрити пошук."}</td></tr>}
            </tbody>
            {rows.length > 1 && (
              <tfoot><tr><td colSpan={3}><b>Разом</b></td>
                <td><b>{rows.reduce((a, v) => a + F(v, "managers"), 0)}</b> <span className="hr-muted">із {rows.reduce((a, v) => a + v.need, 0)}</span></td>
                {STAGES.map(([k]) => <td key={k} className="c"><b>{rows.reduce((a, v) => a + F(v, k), 0)}</b></td>)}
                <td /><td /><td />
              </tr></tfoot>
            )}
          </table>
        </div>
        <div className="hr-sect hr-muted">
          Зверху — вакансії понад {LATE_DAYS} днів, далі за датою відкриття. Відсоток під числом — конверсія від попереднього етапу.
          «Прийнято» — кандидати, що дійшли до «Менеджер» на цій вакансії. Клік по рядку — деталі.
        </div>
      </div>
      {menu && createPortal(
        <div className="vc-menu" style={{ top: menu.y + 4, left: Math.max(8, menu.x - 190) }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setEditing(menu.v); setMenu(null); }}>Змінити</button>
          {menu.v.status === "paused" && <button onClick={() => { void patch(menu.v, { status: "in_work" }, `«${menu.v.title}» знову в роботі`); setMenu(null); }}>Відновити</button>}
          {(menu.v.status === "open" || menu.v.status === "in_work") && <button onClick={() => { void patch(menu.v, { status: "paused" }, `«${menu.v.title}» на паузі`); setMenu(null); }}>Поставити на паузу</button>}
          {menu.v.status === "open" && <button onClick={() => { void patch(menu.v, { status: "in_work" }, `«${menu.v.title}» в роботі`); setMenu(null); }}>Позначити «в роботі»</button>}
          {isClosedVacancy(menu.v.status)
            ? <button onClick={() => { void patch(menu.v, { status: "in_work" }, `«${menu.v.title}» знову в роботі`); setMenu(null); }}>↩ Повернути в роботу</button>
            : <button className="dg" onClick={() => { setClosing(menu.v); setMenu(null); }}>Закрити вакансію…</button>}
        </div>, document.body)}
      {open && <VacancyDrawer v={open} statusLabel={statusLabel} onClose={() => setOpenId(null)} onCandidates={() => onOpenCandidates(open.id)} />}
      <datalist id="hr-vac-resp">{meta.responsibles.map((x) => <option key={x} value={x} />)}</datalist>
      {editing && <EditVacancy v={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast("Вакансію змінено"); load(); onChanged(); }} />}
      {closing && <CloseVacancy meta={meta} v={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); toast(`«${closing.title}» закрито`); load(); onChanged(); }} />}
      {adding && <AddVacancy meta={meta} onClose={() => setAdding(false)} onDone={() => { setAdding(false); toast("Вакансію відкрито"); load(); onChanged(); }} />}
    </div>
  );
}

/** Деталі вакансії: воронка й джерела смугами, коментар. */
function VacancyDrawer({ v, statusLabel, onClose, onCandidates }: { v: HiringVacancyRow; statusLabel: (s: HiringVacancyStatus) => string; onClose: () => void; onCandidates: () => void }) {
  const max = v.funnel?.candidates || 1;
  const bar = (label: string, n: number, color = "var(--info)") => (
    <div className="vc-fbar" key={label}><span>{label}</span><span className="t"><i style={{ width: `${Math.round((n / max) * 100)}%`, background: color }} /></span><b>{n}</b></div>
  );
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer" role="dialog" aria-label={v.title} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <div><div style={{ fontSize: 18, fontWeight: 700 }}>{v.title}</div>
            <div className="hr-muted">{statusLabel(v.status)} · веде {v.responsible || "—"} · відкрито {dm(v.opened_on)} · {v.days_open} дн. · потрібно {v.need}</div></div>
          <button className="hr-btn" onClick={onClose}>Закрити</button>
        </div>
        <h4 style={{ margin: "18px 0 6px" }}>Воронка вакансії</h4>
        {v.funnel ? STAGES.map(([k, l]) => bar(l, v.funnel![k])) : <p className="hr-muted">Кандидатів на цю вакансію ще немає.</p>}
        {v.funnel && <>
          <h4 style={{ margin: "18px 0 6px" }}>Джерела</h4>
          {v.funnel.sources.map((x) => bar(x.label, x.n, "var(--text-muted)"))}
        </>}
        {v.comment && <><h4 style={{ margin: "18px 0 6px" }}>Побажання</h4><p style={{ margin: 0 }}>{v.comment}</p></>}
        <div style={{ marginTop: 18 }}><button className="hr-btn p" onClick={onCandidates}>Кандидати вакансії</button></div>
      </div>
    </div>, document.body);
}

/** «Змінити»: назва, хто веде, скільки людей, побажання. Статус — у меню «⋯». */
function EditVacancy({ v, onClose, onDone }: { v: HiringVacancyRow; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState({ title: v.title, responsible: v.responsible ?? "", need: String(v.need), comment: v.comment ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!p.title.trim()) { setErr("Введіть назву вакансії"); return; }
    try { await patchHiringVacancy(v.id, { ...p, need: Number(p.need) }); onDone(); } catch (e) { setErr(hiringError(e)); }
  };
  const f = (k: keyof typeof p, l: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>{l}
      <input className="hr-inp" value={p[k]} onChange={(e) => { setP({ ...p, [k]: e.target.value }); setErr(null); }} {...extra} />
    </label>
  );
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 520 }} role="dialog" aria-label="Змінити вакансію" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Змінити вакансію</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
          {f("title", "Назва", { autoFocus: true })}
          {f("responsible", "Веде", { list: "hr-vac-resp" })}
          {f("need", "Скільки людей потрібно", { type: "number", min: 0 })}
        </div>
        <label style={{ display: "block", marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>Побажання / пояснення
          <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} value={p.comment} onChange={(e) => setP({ ...p, comment: e.target.value })} />
        </label>
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" onClick={() => void save()}>Зберегти</button>
        </div>
      </div>
    </div>, document.body);
}

function CloseVacancy({ meta, v, onClose, onDone }: { meta: HiringMeta; v: HiringVacancyRow; onClose: () => void; onDone: () => void }) {
  const [result, setResult] = useState("");
  const [day, setDay] = useState(todayKyiv());
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!result) { setErr("Оберіть результат закриття"); return; }
    try { await patchHiringVacancy(v.id, { closeResult: result, closedOn: day }); onDone(); } catch (e) { setErr(hiringError(e)); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Закрити вакансію" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Закрити вакансію</h3>
        <div className="hr-muted" style={{ marginBottom: 10 }}>{v.title} · відкрита {dm(v.opened_on)} · {v.days_open} дн · кандидатів {v.candidates}</div>
        <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>Результат
          <select className="hr-inp" style={{ width: "100%" }} value={result} onChange={(e) => { setResult(e.target.value); setErr(null); }}>
            <option value="">— оберіть —</option>
            {meta.vacancyResults.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>Дата закриття
          <input className="hr-inp" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" onClick={() => void save()}>Закрити вакансію</button>
        </div>
      </div>
    </div>, document.body);
}

function AddVacancy({ meta, onClose, onDone }: { meta: HiringMeta; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState({ title: "", openedBy: "", responsible: "", need: "1", status: "open", comment: "" });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!p.title.trim()) { setErr("Введіть назву вакансії"); return; }
    try { await createHiringVacancy({ ...p, need: Number(p.need) }); onDone(); } catch (e) { setErr(hiringError(e)); }
  };
  const f = (k: keyof typeof p, l: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>{l}
      <input className="hr-inp" value={p[k]} onChange={(e) => { setP({ ...p, [k]: e.target.value }); setErr(null); }} {...extra} />
    </label>
  );
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 520 }} role="dialog" aria-label="Нова вакансія" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Нова вакансія</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
          {f("title", "Назва", { placeholder: "Менеджер з продажу (РНК)", autoFocus: true })}
          {f("openedBy", "Хто відкрив", { placeholder: "Безпамʼятний" })}
          {f("responsible", "Веде", { list: "hr-vac-resp" })}
          {f("need", "Скільки людей потрібно", { type: "number", min: 0 })}
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>Статус
            <select className="hr-inp" value={p.status} onChange={(e) => setP({ ...p, status: e.target.value })}>
              {meta.vacancyStatuses.filter((s) => !isClosedVacancy(s.key)).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        </div>
        <label style={{ display: "block", marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>Побажання / пояснення
          <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} value={p.comment} onChange={(e) => setP({ ...p, comment: e.target.value })} />
        </label>
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" onClick={() => void save()}>Відкрити вакансію</button>
        </div>
      </div>
    </div>, document.body);
}
