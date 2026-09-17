import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchHiringSchedule, createHiringInterview, patchHiringInterview, deleteHiringInterview, restoreHiringInterview, hiringError,
  type HiringMeta, type HiringScheduleRow, type HiringStatus,
} from "../../../api";
import { todayKyiv, nowKyivHM, addDays, mondayOf, longDate, dm, dowOf, isWeekend, LS } from "../hiringView";
import { StatusDialog, StatusPill, type Toast } from "./HiringShared";
import { CandidateDrawer } from "./HiringCandidates";

/**
 * 📅 «ГРАФІК» — замість «Графік Іван». Пріоритет — зручність: людина заходить подивитись, що
 * в неї СЬОГОДНІ, і бачить поруч минулі й наступні дні (відгук Романа 16.09). Усі поля таблиці
 * видно й редагуються в клітинці; час вводиться вручну. Кожна клітинка зберігається на виході
 * з неї, а помилка сервера показується текстом, а не зникає.
 */
export function HiringSchedule({ meta, toast, onMetaStale }: { meta: HiringMeta; toast: Toast; onMetaStale: () => void }) {
  const today = todayKyiv();
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<"day" | "week">("day");
  const [rows, setRows] = useState<HiringScheduleRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [statusFor, setStatusFor] = useState<{ row: HiringScheduleRow; to: HiringStatus } | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);

  const weekFrom = mondayOf(day), weekTo = addDays(weekFrom, 6);
  const load = useCallback(() => {
    let alive = true;
    fetchHiringSchedule(weekFrom, weekTo)
      .then((r) => { if (alive) { setRows(r); setErr(null); } })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [weekFrom, weekTo]);
  useEffect(load, [load]);

  const dayRows = useMemo(() => (rows ?? []).filter((r) => r.interview_date === day), [rows, day]);
  const now = nowKyivHM();
  const nextId = day === today ? dayRows.find((r) => r.attended == null && (r.interview_time ?? "99:99") >= now)?.id : undefined;
  const unmarked = (r: HiringScheduleRow) => r.attended == null && (r.interview_date < today || (r.interview_date === today && !!r.interview_time && r.interview_time < now));

  const save = async (r: HiringScheduleRow, patch: Record<string, unknown>) => {
    try {
      const res = await patchHiringInterview(r.id, patch);
      if (res.repeat) {
        const lbl = meta.statuses.find((s) => s.key === res.repeat!.status)?.label ?? res.repeat.status;
        toast(`Цей номер уже був у базі: ${res.repeat.full_name || "без імені"} (${lbl}). Рядок привʼязано до наявної картки.`,
          { error: res.repeat.status === "black" });
      }
      if ("responsible" in patch && typeof patch.responsible === "string") LS.set("responsible", patch.responsible);
      if ("interviewDate" in patch && patch.interviewDate !== day) toast(`Співбесіду перенесено на ${dm(String(patch.interviewDate))}`);
      load();
      if ("source" in patch || "position" in patch || "responsible" in patch) onMetaStale();
    } catch (e) { toast(hiringError(e), { error: true }); load(); }
  };

  const add = async () => {
    const times = dayRows.map((r) => r.interview_time).filter(Boolean).sort() as string[];
    let time = "10:00";
    if (times.length) {
      const [h, m] = times[times.length - 1].split(":").map(Number);
      const t = Math.min(h * 60 + m + 30, 23 * 60 + 30);
      time = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    }
    try {
      const id = await createHiringInterview({ interviewDate: day, interviewTime: time, responsible: LS.get("responsible") ?? "" });
      setFocusId(id); load();
    } catch (e) { toast(hiringError(e), { error: true }); }
  };

  const remove = async (r: HiringScheduleRow) => {
    try {
      await deleteHiringInterview(r.id); load();
      toast(`Рядок ${r.interview_time ?? ""} ${r.full_name ?? ""} видалено`, {
        action: { label: "Відновити", run: () => { void restoreHiringInterview(r.id).then(load).catch((e) => toast(hiringError(e), { error: true })); } },
      });
    } catch (e) { toast(hiringError(e), { error: true }); }
  };

  const badge = day === today ? <span className="hr-badge today">сьогодні</span>
    : day < today ? <span className="hr-badge past">минуле</span> : <span className="hr-badge future">попереду</span>;
  const count = (d: string) => (rows ?? []).filter((r) => r.interview_date === d).length;
  const came = dayRows.filter((r) => r.attended === true).length, missed = dayRows.filter((r) => r.attended === false).length;

  // Некеровані поля: ключ містить значення, тож після перезавантаження клітинка бере свіже.
  const cell = (r: HiringScheduleRow, field: string, value: string | null, props: { type?: string; list?: string; placeholder?: string; className?: string; style?: React.CSSProperties } = {}) => (
    <input key={`${r.id}-${field}-${value ?? ""}`} className={`hr-c ${props.className ?? ""}`} type={props.type ?? "text"} list={props.list}
      placeholder={props.placeholder} style={props.style} defaultValue={value ?? ""} autoFocus={field === "fullName" && focusId === r.id}
      onBlur={(e) => { const v = e.target.value; if (v !== (value ?? "")) void save(r, { [field]: v }); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );

  return (
    <div>
      <div className="hr-daynav">
        <button className="hr-nav" onClick={() => setDay(addDays(day, mode === "week" ? -7 : -1))} title="Назад">‹</button>
        <div className="hr-daytitle">{mode === "week" ? `${dm(weekFrom)} – ${dm(weekTo)}` : longDate(day)}{mode === "day" && badge}</div>
        <button className="hr-nav" onClick={() => setDay(addDays(day, mode === "week" ? 7 : 1))} title="Вперед">›</button>
        <button className="hr-btn" onClick={() => setDay(today)} disabled={day === today}>Сьогодні</button>
        <input className="hr-inp" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <div className="hr-seg" style={{ marginLeft: "auto" }}>
          <button className={mode === "day" ? "on" : ""} onClick={() => setMode("day")}>День</button>
          <button className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>Тиждень</button>
        </div>
      </div>

      <div className="hr-week">
        {Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i)).map((d) => (
          <button key={d} className={`hr-wd ${d === day ? "sel" : ""} ${d === today ? "tod" : ""} ${isWeekend(d) ? "we" : ""}`}
            onClick={() => { setDay(d); setMode("day"); }}>
            <div className="n">{dowOf(d)}</div><div className="d">{d.slice(8, 10)}</div><div className="c">{count(d) ? `${count(d)} співб.` : "—"}</div>
          </button>
        ))}
      </div>

      {err && <div className="chart-card" style={{ color: "var(--danger)" }}>{err}</div>}

      {mode === "week" ? (
        <div className="hr-wkgrid">
          {Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i)).map((d) => (
            <div key={d} className={`hr-wkcol ${d === today ? "tod" : ""}`}>
              <h4 onClick={() => { setDay(d); setMode("day"); }}>{dowOf(d)} {dm(d)}</h4>
              {(rows ?? []).filter((r) => r.interview_date === d).map((r) => (
                <div key={r.id} className="hr-wki" onClick={() => { setDay(d); setMode("day"); }}>
                  <b>{r.interview_time ?? "—"}</b> {r.full_name || <span className="hr-muted">без імені</span>}
                  <div>{r.attended === true ? "✓ прийшов" : r.attended === false ? "✕ не прийшов" : <StatusPill meta={meta} status={r.status} />}</div>
                </div>
              ))}
              {!count(d) && <div className="hr-muted">немає</div>}
            </div>
          ))}
        </div>
      ) : (
        <div className="hr-card">
          <div className="hr-tiles">
            <div className="hr-tile"><div className="lb"><span>Усього</span></div><div className="vl">{dayRows.length}</div><div className="sb">співбесід на день</div></div>
            <div className="hr-tile"><div className="lb"><span>Прийшли</span></div><div className="vl">{came}</div><div className="sb">позначка «прийшов»</div></div>
            <div className="hr-tile"><div className="lb"><span>Не прийшли</span></div><div className="vl">{missed}</div><div className="sb">позначка «не прийшов»</div></div>
            <div className="hr-tile"><div className="lb"><span>Не відмічено</span></div><div className="vl" style={{ color: dayRows.some(unmarked) ? "var(--warn)" : undefined }}>{dayRows.length - came - missed}</div><div className="sb">{dayRows.some(unmarked) ? "є минулі без позначки" : "чекають"}</div></div>
          </div>
          <div className="hr-tw">
            <table className="hr-sheet">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>Час</th><th style={{ width: 120 }}>Відповідальний</th><th style={{ width: 146 }}>Дата призначення</th>
                  <th style={{ width: 146 }}>Дата співбесіди</th><th style={{ width: 210 }}>Кандидат · телефон</th><th style={{ width: 130 }}>Telegram</th>
                  <th style={{ width: 150 }}>Джерело</th><th style={{ width: 200 }}>Посада</th><th style={{ width: 132 }}>Прийшов</th>
                  <th style={{ width: 200 }}>Статус</th><th style={{ width: 200 }}>Коментар</th><th style={{ width: 170 }}>Запис</th><th style={{ width: 36 }} />
                </tr>
              </thead>
              <tbody>
                {dayRows.map((r) => {
                  const next = r.status ? meta.transitions[r.status] ?? [] : [];
                  return (
                    <tr key={r.id} className={`${r.attended === true ? "done" : ""} ${unmarked(r) ? "unm" : ""} ${r.id === nextId ? "nxt" : ""}`}>
                      <td>{cell(r, "interviewTime", r.interview_time, { type: "time", className: "tm" })}</td>
                      <td>{cell(r, "responsible", r.responsible, { list: "hr-resp", placeholder: "хто проводить" })}</td>
                      <td>{cell(r, "assignedOn", r.assigned_on, { type: "date" })}</td>
                      <td>{cell(r, "interviewDate", r.interview_date, { type: "date" })}</td>
                      <td>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          {cell(r, "fullName", r.full_name, { placeholder: "ПІБ" })}
                          {r.candidate_id && <button className="hr-link" title="Картка кандидата" onClick={() => setOpenId(r.candidate_id)}>↗</button>}
                        </div>
                        {cell(r, "phone", r.phone, { placeholder: "телефон", style: { fontSize: 12, color: "var(--text-muted)" } })}
                      </td>
                      <td>{cell(r, "telegram", r.telegram, { placeholder: "@нік", style: { opacity: r.candidate_id ? 1 : 0.7 } })}</td>
                      <td>{cell(r, "source", r.source, { list: "hr-src" })}</td>
                      <td>{cell(r, "position", r.position, { list: "hr-pos" })}</td>
                      <td>
                        <select className="hr-c" value={r.attended === true ? "y" : r.attended === false ? "n" : ""}
                          onChange={(e) => void save(r, { attended: e.target.value === "y" ? true : e.target.value === "n" ? false : null })}>
                          <option value="">не відмічено</option><option value="y">✓ прийшов</option><option value="n">✕ не прийшов</option>
                        </select>
                      </td>
                      <td>
                        {r.candidate_id && r.status ? (
                          <select className="hr-c" value={r.status} onChange={(e) => setStatusFor({ row: r, to: e.target.value as HiringStatus })}>
                            <option value={r.status}>{meta.statuses.find((s) => s.key === r.status)?.label}</option>
                            {next.map((s) => <option key={s} value={s}>→ {meta.statuses.find((x) => x.key === s)?.label}</option>)}
                          </select>
                        ) : <span className="hr-muted">спершу ПІБ або телефон</span>}
                      </td>
                      <td>
                        <textarea key={`${r.id}-c-${r.comment ?? ""}`} className="hr-c" rows={1} defaultValue={r.comment ?? ""}
                          onBlur={(e) => { if (e.target.value !== (r.comment ?? "")) void save(r, { comment: e.target.value }); }} />
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          {cell(r, "recordUrl", r.record_url, { placeholder: "https://…" })}
                          {r.record_url && <a className="hr-link" href={r.record_url} target="_blank" rel="noopener noreferrer" title="Відкрити запис">▶</a>}
                        </div>
                      </td>
                      <td><button className="hr-link" style={{ color: "var(--text-muted)" }} title="Видалити рядок (можна відновити)" onClick={() => void remove(r)}>✕</button></td>
                    </tr>
                  );
                })}
                {rows && !dayRows.length && (
                  <tr><td colSpan={13} className="hr-muted" style={{ padding: 16 }}>На {longDate(day)} співбесід немає.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)", flexWrap: "wrap", alignItems: "center" }}>
            <button className="hr-btn p" onClick={() => void add()}>+ Додати співбесіду</button>
            <span className="hr-muted">Новий рядок стає через 30 хв після останнього; час змінюється в клітинці. Зміна дати переносить рядок на інший день.</span>
          </div>
        </div>
      )}

      <datalist id="hr-resp">{meta.responsibles.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="hr-src">{meta.sources.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="hr-pos">{meta.positions.map((x) => <option key={x} value={x} />)}</datalist>

      {openId != null && <CandidateDrawer meta={meta} id={openId} toast={toast} onClose={() => setOpenId(null)} onChanged={load} />}
      {statusFor && statusFor.row.candidate_id && statusFor.row.status && (
        <StatusDialog meta={meta} candidateId={statusFor.row.candidate_id} from={statusFor.row.status} to={statusFor.to}
          teamId={statusFor.row.team_id} toast={toast} onClose={() => { setStatusFor(null); load(); }}
          onDone={() => { setStatusFor(null); load(); }} />
      )}
    </div>
  );
}
