import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchHiringSchedule, createHiringInterview, patchHiringInterview, deleteHiringInterview, restoreHiringInterview, fetchHiringCard, setHiringStatus, hiringError,
  fetchTldv, syncTldvNow, linkTldv, ignoreTldv, type TldvState,
  type HiringMeta, type HiringScheduleRow, type HiringStatus,
} from "../../../api";
import { todayKyiv, nowKyivHM, addDays, mondayOf, longDate, dm, dowOf, isWeekend, LS, isClosedVacancy } from "../hiringView";
import { StatusDialog, StatusPill, RefusalDialog, type Toast } from "./HiringShared";
import { CandidateDrawer } from "./HiringCandidates";
import { InterviewDialog, avatarTone, initials } from "./HiringInterviewDialog";

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
  const [refuseFor, setRefuseFor] = useState<HiringScheduleRow | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  // «Розклад» (картки на шкалі часу, макет v14) — типово; «Таблиця» — для масового внесення, як затверджував Іван 16.09.
  const [view, setView] = useState<"agenda" | "sheet">(() => (LS.get("sview") === "sheet" ? "sheet" : "agenda"));
  const [ivAt, setIvAt] = useState<string | null>(null);

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
      if ("source" in patch || "responsible" in patch) onMetaStale();
      if ("vacancyId" in patch) toast("Вакансію привʼязано");
    } catch (e) { toast(hiringError(e), { error: true }); load(); }
  };

  const nextTime = () => {
    const times = dayRows.map((r) => r.interview_time).filter(Boolean).sort() as string[];
    if (!times.length) return "10:00";
    const [h, m] = times[times.length - 1].split(":").map(Number);
    const t = Math.min(h * 60 + m + 30, 23 * 60 + 30);
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  const add = async () => {
    const time = nextTime();
    try {
      const id = await createHiringInterview({ interviewDate: day, interviewTime: time, responsible: LS.get("responsible") ?? "" });
      setFocusId(id); load();
    } catch (e) { toast(hiringError(e), { error: true }); }
  };

  /**
   * 📅 ПЕРЕНЕСТИ РЯДОК ГРАФІКА (23.09.2026, Іван: «випадково поставив співбесіди на сьогодні — як перенести
   * на завтра або видалити, щоб не тягнулось у звітність»). Дата й час — той самий `save`, що й решта полів,
   * тож щоденний звіт рахує день співбесіди по НОВІЙ даті. ⚠️ «Призначено» (дата, коли рядок завели) НЕ
   * рухається: це факт дня, а не план. Помилковий рядок прибирається «Видалити» — воно скасовне.
   */
  const move = async (r: HiringScheduleRow, date: string, time: string) => {
    await save(r, { interviewDate: date, interviewTime: time });
    const to = `${date.slice(8, 10)}.${date.slice(5, 7)}${time ? ` ${time}` : ""}`;
    toast(`${r.full_name || "Рядок"}: перенесено на ${to}`, { action: { label: "Відкрити той день", run: () => setDay(date) } });
  };

  /**
   * ⟲ СКАСУВАТИ ПОЗНАЧКУ ЯВКИ (23.09.2026, Іван: «якщо помилково поставив, що прийшов, можна відмінити»).
   * Знімає «прийшов / не прийшов» і одразу пропонує повернути статус, який ця позначка зрушила. Який саме
   * статус був — питаємо СЕРВЕР (`lastFrom` картки), а не вгадуємо з поточного: повернення дозволяє те саме
   * правило «повернути останню зміну», що й кнопка в картці кандидата. Тримає #691.
   */
  const clearMark = async (r: HiringScheduleRow) => {
    await save(r, { attended: null });
    if (!r.candidate_id) return;
    try {
      const card = await fetchHiringCard(r.candidate_id);
      const back = card.lastFrom;
      if (!back) { toast("Позначку знято"); return; }
      const label = meta.statuses.find((x) => x.key === back)?.label ?? back;
      toast(`Позначку знято. Статус зараз «${meta.statuses.find((x) => x.key === card.candidate.status)?.label ?? card.candidate.status}»`, {
        action: { label: `Повернути «${label}»`, run: () => void setHiringStatus(r.candidate_id!, { to: back, comment: "скасовано позначку явки в графіку" })
          .then(() => { toast(`Статус повернуто: «${label}»`); load(); }).catch((e) => toast(hiringError(e), { error: true })) },
      });
    } catch (e) { toast(hiringError(e), { error: true }); }
  };

  /** ↩ Повернути останню зміну статусу просто з графіка — те саме, що кнопка «↩ Повернути» в картці. */
  const undoStatus = async (r: HiringScheduleRow) => {
    if (!r.candidate_id) return;
    try {
      const card = await fetchHiringCard(r.candidate_id);
      if (!card.lastFrom) { toast("Немає що повертати: статус ще не міняли", { error: true }); return; }
      const label = meta.statuses.find((x) => x.key === card.lastFrom)?.label ?? card.lastFrom;
      await setHiringStatus(r.candidate_id, { to: card.lastFrom, comment: "повернуто останню зміну з графіка" });
      toast(`Статус повернуто: «${label}»`); load();
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
        {mode === "day" && (
          <div className="hr-seg" style={{ marginLeft: "auto" }}>
            <button className={view === "agenda" ? "on" : ""} onClick={() => { setView("agenda"); LS.set("sview", "agenda"); }}>Розклад</button>
            <button className={view === "sheet" ? "on" : ""} onClick={() => { setView("sheet"); LS.set("sview", "sheet"); }}>Таблиця</button>
          </div>
        )}
        <div className="hr-seg" style={mode === "day" ? undefined : { marginLeft: "auto" }}>
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
      ) : view === "agenda" ? (
        <Agenda meta={meta} day={day} today={today} now={now} rows={dayRows} nextId={nextId} unmarked={unmarked}
          onMove={(r, d, t) => void move(r, d, t)} onRemove={(r) => void remove(r)}
          onClearMark={(r) => void clearMark(r)} onUndoStatus={(r) => void undoStatus(r)}
          onEdit={(r, patch) => void save(r, patch)}
          tiles={{ total: dayRows.length, came, missed, open: dayRows.length - came - missed }}
          onAttend={(r, v) => void save(r, { attended: v })} onStatus={(r, to) => (to === "refused" ? setRefuseFor(r) : setStatusFor({ row: r, to }))}
          onOpen={(id) => setOpenId(id)} onAdd={(t) => setIvAt(t ?? nextTime())} />
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
                  <th style={{ width: 150 }}>Джерело</th><th style={{ width: 210 }}>Вакансія</th><th style={{ width: 132 }}>Прийшов</th>
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
                      <td>
                        {r.candidate_id ? (
                          <>
                            <select className={`hr-c ${r.vacancies?.length ? "" : "novac"}`} value={r.vacancies?.[0]?.id ?? ""}
                              onChange={(e) => { if (e.target.value) void save(r, { vacancyId: Number(e.target.value) }); }}>
                              <option value="">— вакансія —</option>
                              {meta.vacancies.filter((v) => !isClosedVacancy(v.status) || r.vacancies?.some((x) => x.id === v.id)).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
                            </select>
                            {(r.vacancies?.length ?? 0) > 1 && <div className="hr-muted">+{r.vacancies!.length - 1} ще — у картці</div>}
                          </>
                        ) : <span className="hr-muted">спершу ПІБ або телефон</span>}
                      </td>
                      <td>
                        <select className="hr-c" value={r.attended === true ? "y" : r.attended === false ? "n" : ""}
                          onChange={(e) => void save(r, { attended: e.target.value === "y" ? true : e.target.value === "n" ? false : null })}>
                          <option value="">не відмічено</option><option value="y">✓ прийшов</option><option value="n">✕ не прийшов</option>
                        </select>
                      </td>
                      <td>
                        {r.candidate_id && r.status ? (
                          <select className="hr-c" value={r.status} onChange={(e) => {
                            const to = e.target.value as HiringStatus;
                            if (to === "refused") setRefuseFor(r); else setStatusFor({ row: r, to });
                          }}>
                            <option value={r.status}>{meta.statuses.find((s) => s.key === r.status)?.label}</option>
                            {next.map((s) => <option key={s} value={s}>→ {meta.statuses.find((x) => x.key === s)?.label}{s === "refused" ? "…" : ""}</option>)}
                          </select>
                        ) : <span className="hr-muted">спершу ПІБ або телефон</span>}
                        {r.refusal_reason && (r.status === "refused" || r.status === "black") && <div className="hr-muted">{r.refusal_reason}</div>}
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
            <button className="hr-btn p" onClick={() => setIvAt(nextTime())}>+ Співбесіда з кандидатом</button>
            <button className="hr-btn" onClick={() => void add()}>+ Порожній рядок</button>
            <span className="hr-muted">Новий рядок стає через 30 хв після останнього; час змінюється в клітинці. Зміна дати переносить рядок на інший день.</span>
          </div>
        </div>
      )}

      <datalist id="hr-resp">{meta.responsibles.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="hr-src">{meta.sources.map((x) => <option key={x} value={x} />)}</datalist>

      <TldvBlock toast={toast} onLinked={load} />
      {ivAt != null && <InterviewDialog meta={meta} day={day} time={ivAt} onClose={() => setIvAt(null)}
        onDone={(msg) => { setIvAt(null); toast(msg); load(); onMetaStale(); }} />}
      {openId != null && <CandidateDrawer meta={meta} id={openId} toast={toast} onClose={() => setOpenId(null)} onChanged={load} onMetaStale={onMetaStale} />}
      {refuseFor && refuseFor.candidate_id && refuseFor.status && (
        <RefusalDialog meta={meta} candidateId={refuseFor.candidate_id} candidateName={refuseFor.full_name ?? ""} from={refuseFor.status} toast={toast}
          onClose={() => { setRefuseFor(null); load(); }} onDone={() => { setRefuseFor(null); load(); }} onReasonsChanged={onMetaStale} />
      )}
      {statusFor && statusFor.row.candidate_id && statusFor.row.status && (
        <StatusDialog meta={meta} candidateId={statusFor.row.candidate_id} from={statusFor.row.status} to={statusFor.to}
          teamId={statusFor.row.team_id} toast={toast} onClose={() => { setStatusFor(null); load(); }}
          onDone={() => { setStatusFor(null); load(); }} />
      )}
    </div>
  );
}

/** Посилання на месенджери з номера (і Telegram-ніка, якщо є) — як у картці кандидата. */
function msgLinks(phone: string | null, telegram: string | null): [string, string][] {
  const d = (phone ?? "").replace(/\D/g, ""), n = d.length === 10 && d[0] === "0" ? `38${d}` : d;
  const tg = (telegram ?? "").trim(), user = tg.startsWith("@") ? tg.slice(1) : (tg.match(/t\.me\/([\w_]+)/) ?? [])[1];
  const out: [string, string][] = [];
  if (user) out.push(["Telegram", `https://t.me/${user}`]); else if (n.length >= 11) out.push(["Telegram", `https://t.me/+${n}`]);
  if (n.length >= 11) { out.push(["Viber", `viber://chat?number=%2B${n}`]); out.push(["WhatsApp", `https://wa.me/${n}`]); }
  return out;
}
const ST_COLOR: Partial<Record<HiringStatus, string>> = {
  planned: "var(--info)", done: "var(--ok)", noshow: "var(--danger)", noanswer: "var(--warn)", lead: "#7c3aed",
  candidate: "var(--ok)", training: "var(--ok)", manager: "var(--ok)", refused: "var(--text-muted)", black: "var(--text-muted)",
};
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;

/**
 * 📅 «РОЗКЛАД» (макет v14, за мотивами Cal.com Bookings / Google Calendar): час ліворуч, картка праворуч,
 * «✓ Прийшов / ✕ Не прийшов» однією кнопкою, лінія «зараз», вільні вікна з кнопкою призначення.
 * Дані й дії — ті самі, що в таблиці (той самий `save` рядка графіка), тож звіт рахує однаково.
 */
function Agenda({ meta, day, today, now, rows, nextId, unmarked, tiles, onAttend, onStatus, onOpen, onAdd, onMove, onRemove, onClearMark, onUndoStatus, onEdit }: {
  meta: HiringMeta; day: string; today: string; now: string; rows: HiringScheduleRow[]; nextId?: number;
  unmarked: (r: HiringScheduleRow) => boolean; tiles: { total: number; came: number; missed: number; open: number };
  onAttend: (r: HiringScheduleRow, v: boolean) => void; onStatus: (r: HiringScheduleRow, to: HiringStatus) => void;
  onOpen: (id: number) => void; onAdd: (time?: string) => void;
  onMove: (r: HiringScheduleRow, date: string, time: string) => void; onRemove: (r: HiringScheduleRow) => void;
  onClearMark: (r: HiringScheduleRow) => void; onUndoStatus: (r: HiringScheduleRow) => void;
  onEdit: (r: HiringScheduleRow, patch: Record<string, unknown>) => void;
}) {
  const [moving, setMoving] = useState<HiringScheduleRow | null>(null);
  const [editing, setEditing] = useState<HiringScheduleRow | null>(null);
  const [menu, setMenu] = useState<{ r: HiringScheduleRow; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close); window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);
  const out: React.ReactNode[] = [];
  let nowShown = day !== today;
  rows.forEach((r, i) => {
    if (!nowShown && (r.interview_time ?? "99:99") > now) { out.push(<div key="now" className="ag-now">зараз {now}</div>); nowShown = true; }
    const prev = rows[i - 1];
    if (prev?.interview_time && r.interview_time && toMin(r.interview_time) - toMin(prev.interview_time) >= 60) {
      const ft = fromMin(toMin(prev.interview_time) + 30);
      out.push(<div key={`gap${r.id}`} />, <button key={`free${r.id}`} className="ag-free" onClick={() => onAdd(ft)}>+ вільне вікно з {ft} — призначити співбесіду</button>);
    }
    const unm = unmarked(r), vac = r.vacancies?.[0];
    const next = r.status ? meta.transitions[r.status] ?? [] : [];
    out.push(
      <div key={`t${r.id}`} className="ag-t">{prev?.interview_time === r.interview_time ? null : <><b>{r.interview_time ?? "—"}</b><span>{r.responsible ?? ""}</span></>}</div>,
      <div key={`c${r.id}`} className={`ag-c ${r.id === nextId ? "next" : ""}`} style={{ ["--st" as string]: r.attended === true ? "var(--ok)" : r.attended === false ? "var(--danger)" : unm ? "var(--warn)" : (r.status && ST_COLOR[r.status]) || "var(--border-strong)" }}>
        <div className="ag-av" style={{ ["--av" as string]: avatarTone(r.full_name) }}>{initials(r.full_name)}</div>
        <div className="ag-h">
          {r.candidate_id ? <button className="nm" onClick={() => onOpen(r.candidate_id!)}>{r.full_name || "без імені"}</button> : <span className="nm hr-muted">кандидата не вказано</span>}
          {r.id === nextId && <span className="hr-badge today">далі</span>}
          {r.candidate_id && (vac ? <span className="chip vac">{vac.title}</span> : <span className="chip novac">без вакансії</span>)}
          {r.source && <span className="chip">{r.source}</span>}
        </div>
        <div className="ag-r">
          {r.attended === true ? <span className="emp-pill ok">✓ прийшов</span> : r.attended === false ? <span className="emp-pill" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>✕ не прийшов</span>
            : unm ? <span className="emp-pill warn">не відмічено</span> : r.status ? <StatusPill meta={meta} status={r.status} /> : null}
          <div className="ag-acts">
            {r.candidate_id && (<>
              {r.attended == null && <>
                <button className="hr-btn xs came" onClick={() => onAttend(r, true)}>✓ Прийшов</button>
                <button className="hr-btn xs miss" onClick={() => onAttend(r, false)}>✕ Не прийшов</button>
              </>}
              {r.attended != null && <button className="hr-btn xs" title="Помилкова позначка — зняти й, за потреби, повернути статус" onClick={() => onClearMark(r)}>⟲ Скасувати позначку</button>}
              {r.attended != null && r.status && next.filter((s) => s !== "refused" && s !== "black").slice(0, 1).map((s) =>
                <button key={s} className="hr-btn xs p" onClick={() => onStatus(r, s)}>→ {meta.statuses.find((x) => x.key === s)?.label ?? s}</button>)}
              {r.status && next.includes("refused") && <button className="hr-btn xs" onClick={() => onStatus(r, "refused")}>Відмова…</button>}
            </>)}
            <button className="hr-btn xs" aria-label="Ще дії" title="Перенести, видалити, картка кандидата"
              onClick={(e) => { e.stopPropagation(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ r, x: b.right, y: b.bottom }); }}>⋯</button>
          </div>
        </div>
        <div className="ag-sub">
          <span>{r.phone ? `📞 ${r.phone}` : "телефон не вказано"}</span>
          {msgLinks(r.phone, r.telegram).map(([l, u]) => <a key={l} href={u} target="_blank" rel="noopener noreferrer">{l}</a>)}
          {r.record_url && <a href={r.record_url} target="_blank" rel="noopener noreferrer">▶ запис</a>}
          <span>призначено {r.assigned_on.slice(8, 10)}.{r.assigned_on.slice(5, 7)}</span>
        </div>
        {r.comment && <div className="ag-note">💬 {r.comment}</div>}
      </div>,
    );
  });
  if (!nowShown && rows.length) out.push(<div key="now-end" className="ag-now">зараз {now}</div>);
  const menuNode = menu && createPortal(
    <div className="vc-menu" style={{ top: menu.y + 4, left: Math.max(8, menu.x - 210) }} onClick={(e) => e.stopPropagation()}>
      {menu.r.candidate_id && <button onClick={() => { const id = menu.r.candidate_id!; setMenu(null); onOpen(id); }}>Картка кандидата</button>}
      <button onClick={() => { setEditing(menu.r); setMenu(null); }}>Змінити рядок…</button>
      <button onClick={() => { setMoving(menu.r); setMenu(null); }}>Перенести на іншу дату…</button>
      {menu.r.candidate_id && <button onClick={() => { const r = menu.r; setMenu(null); onUndoStatus(r); }}>↩ Повернути останню зміну статусу</button>}
      <button className="dg" onClick={() => { const r = menu.r; setMenu(null); onRemove(r); }}>Видалити з графіка</button>
    </div>, document.body);
  const editNode = editing && <EditRowDialog meta={meta} r={editing} onClose={() => setEditing(null)}
    onDone={(patch) => { const r = editing; setEditing(null); onEdit(r, patch); }} />;
  const moveNode = moving && <MoveDialog r={moving} day={day} onClose={() => setMoving(null)}
    onDone={(d, t) => { const r = moving; setMoving(null); onMove(r, d, t); }} />;
  return (
    <div className="hr-card">
      <div className="hr-tiles">
        <div className="hr-tile"><div className="lb"><span>Усього</span></div><div className="vl">{tiles.total}</div><div className="sb">співбесід на день</div></div>
        <div className="hr-tile"><div className="lb"><span>Прийшли</span></div><div className="vl">{tiles.came}</div><div className="sb">позначка «прийшов»</div></div>
        <div className="hr-tile"><div className="lb"><span>Не прийшли</span></div><div className="vl">{tiles.missed}</div><div className="sb">позначка «не прийшов»</div></div>
        <div className="hr-tile"><div className="lb"><span>Не відмічено</span></div><div className="vl" style={{ color: rows.some(unmarked) ? "var(--warn)" : undefined }}>{tiles.open}</div><div className="sb">без позначки</div></div>
      </div>
      <div style={{ padding: "4px 16px 12px" }}>
        {rows.length === 0 ? (
          <div className="ag-empty">На {longDate(day)} співбесід немає. <button className="hr-btn p xs" onClick={() => onAdd("10:00")}>+ Співбесіда</button></div>
        ) : <div className="ag">{out}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border)", flexWrap: "wrap", alignItems: "center" }}>
        <button className="hr-btn p" onClick={() => onAdd()}>+ Співбесіда</button>
        <span className="hr-muted">Кандидата можна обрати з бази або створити тут же. Позначка «прийшов» — однією кнопкою в картці.
          Помилкову дію видно скасувати: «⟲ Скасувати позначку» знімає явку, «⋯» дає змінити рядок, перенести, повернути останню зміну статусу
          або видалити (з кнопкою «Відновити»). Для масового внесення — вигляд «Таблиця».</span>
      </div>
      {menuNode}
      {editNode}
      {moveNode}
    </div>
  );
}

/** Змінити рядок графіка з «Розкладу»: час, хто проводить, коментар, посилання на запис. Поля — ті самі, що в «Таблиці». */
function EditRowDialog({ meta, r, onClose, onDone }: { meta: HiringMeta; r: HiringScheduleRow; onClose: () => void; onDone: (patch: Record<string, unknown>) => void }) {
  const [p, setP] = useState({
    interviewTime: r.interview_time ?? "", responsible: r.responsible ?? "",
    comment: r.comment ?? "", recordUrl: r.record_url ?? "",
  });
  const dirty = Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== ({ interviewTime: r.interview_time ?? "", responsible: r.responsible ?? "", comment: r.comment ?? "", recordUrl: r.record_url ?? "" } as Record<string, string>)[k]));
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Змінити рядок графіка" onClick={(e) => e.stopPropagation()} style={{ width: "min(520px, 96vw)" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Змінити рядок</h3>
        <div className="hr-muted" style={{ marginBottom: 12, fontSize: 13 }}>{r.full_name || "рядок без кандидата"} · {dm(r.interview_date)}</div>
        <div className="emp-form" style={{ marginTop: 0 }}>
          <label><span>Час</span><input className="hr-inp" type="time" value={p.interviewTime} onChange={(e) => setP({ ...p, interviewTime: e.target.value })} /></label>
          <label><span>Хто проводить</span><input className="hr-inp" list="hr-sched-resp" value={p.responsible} onChange={(e) => setP({ ...p, responsible: e.target.value })} /></label>
          <label className="wide"><span>Посилання на запис</span><input className="hr-inp" value={p.recordUrl} placeholder="https://…" onChange={(e) => setP({ ...p, recordUrl: e.target.value })} /></label>
          <label className="wide"><span>Коментар</span><input className="hr-inp" value={p.comment} onChange={(e) => setP({ ...p, comment: e.target.value })} /></label>
          <datalist id="hr-sched-resp">{meta.responsibles.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={!Object.keys(dirty).length} onClick={() => onDone(dirty)}>Зберегти</button>
        </div>
      </div>
    </div>, document.body);
}

/** Перенести рядок графіка: нова дата й час. Дата обовʼязкова; час можна лишити порожнім («—» у розкладі). */
function MoveDialog({ r, day, onClose, onDone }: { r: HiringScheduleRow; day: string; onClose: () => void; onDone: (date: string, time: string) => void }) {
  const [date, setDate] = useState(r.interview_date || day);
  const [time, setTime] = useState(r.interview_time ?? "");
  const [err, setErr] = useState<string | null>(null);
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Перенести співбесіду" onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 96vw)" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Перенести співбесіду</h3>
        <div className="hr-muted" style={{ marginBottom: 12, fontSize: 13 }}>
          {r.full_name || "рядок без кандидата"} · зараз {dm(r.interview_date)}{r.interview_time ? ` ${r.interview_time}` : ""}.
          Дата призначення не змінюється — у звіті за сьогодні рядок лишиться «призначено».
        </div>
        <div className="emp-form" style={{ marginTop: 0 }}>
          <label><span>Дата *</span><input className="hr-inp" type="date" value={date} onChange={(e) => { setDate(e.target.value); setErr(null); }} /></label>
          <label><span>Час</span><input className="hr-inp" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" onClick={() => (date ? onDone(date, time) : setErr("Оберіть дату"))}>Перенести</button>
        </div>
      </div>
    </div>, document.body);
}


/**
 * 🎥 «ЗАПИСИ БЕЗ РЯДКА» (23.09.2026, прохід 7). Певні збіги (за поштою учасника) джоба привʼязала сама —
 * сюди потрапляє лише те, де вона НЕ впевнена. Людину обирає рекрутер; «не співбесіда» ховає запис.
 * Ключа немає — блок каже «не підключено», а не показує порожній список (різні стани — різні підписи).
 */
function TldvBlock({ toast, onLinked }: { toast: Toast; onLinked: () => void }) {
  const [st, setSt] = useState<TldvState | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({});
  const load = useCallback(() => { fetchTldv().then(setSt).catch(() => setSt(null)); }, []);
  useEffect(load, [load]);
  if (!st) return null;
  const { status, pending } = st;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); load(); onLinked(); } catch (e) { toast(hiringError(e), { error: true }); }
    setBusy(false);
  };
  const when = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${new Date(iso).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" })}` : "час невідомий");
  return (
    <div className="hr-card" style={{ marginTop: 14 }}>
      <div className="hd">
        <div><h3>🎥 Записи співбесід{pending.length ? ` · без рядка ${pending.length}` : ""}</h3>
          <div className="hr-muted">
            {!status.configured ? "tl;dv не підключено: ключ не вказано, записи не забираємо."
              : `Підключено${status.lastRunAt ? ` · остання перевірка ${when(status.lastRunAt)}` : ""} · знайдено ${status.seen}, привʼязано ${status.linked}${status.lastError ? ` · помилка: ${status.lastError}` : ""}`}
          </div></div>
        {status.configured && <button className="hr-btn" style={{ marginLeft: "auto" }} disabled={busy}
          onClick={() => void act(() => syncTldvNow(), "Перевірено")}>Перевірити зараз</button>}
      </div>
      {status.configured && (pending.length === 0
        ? <div className="hr-sect hr-muted">Усі записи привʼязані до рядків графіка.</div>
        : (
          <table className="hr-table">
            <thead><tr><th>Зустріч</th><th>Кому належить</th><th /></tr></thead>
            <tbody>
              {pending.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.name || "без назви"}</b>
                    <div className="hr-muted">{when(m.happenedAt)}{m.durationMin != null ? ` · ${m.durationMin} хв` : ""}
                      {m.organizer ? ` · ${m.organizer}` : ""} · учасників {m.invitees}
                      {m.url && <> · <a href={m.url} target="_blank" rel="noopener noreferrer">▶ відкрити в tl;dv</a></>}</div>
                    <div className="hr-muted">{m.how === "many" ? "кілька рядків у тому самому вікні — оберіть потрібний"
                      : m.how === "time" ? "збіг за часом, пошта учасника не збіглася — підтвердіть"
                      : "рядка графіка на цей час немає; можливо, це не співбесіда"}</div></td>
                  <td>
                    <select className="hr-inp" style={{ maxWidth: 260 }} value={pick[m.id] ?? (m.suggestions[0]?.interviewId ?? "")}
                      onChange={(e) => setPick({ ...pick, [m.id]: e.target.value })}>
                      <option value="">— оберіть рядок —</option>
                      {m.suggestions.map((sg) => <option key={sg.interviewId} value={sg.interviewId}>{sg.label}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="hr-btn xs p" disabled={busy || !(pick[m.id] ?? m.suggestions[0]?.interviewId)}
                      onClick={() => void act(() => linkTldv(m.id, Number(pick[m.id] ?? m.suggestions[0]!.interviewId)), "Запис привʼязано")}>Привʼязати</button>{" "}
                    <button className="hr-btn xs" disabled={busy}
                      onClick={() => void act(() => ignoreTldv(m.id), "Сховано: не співбесіда")}>Не співбесіда</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}
