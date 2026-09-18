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
 */
export function HiringVacancies({ meta, toast, onOpenCandidates, onChanged }: {
  meta: HiringMeta; toast: Toast; onOpenCandidates: (vacancyId: number) => void; onChanged: () => void;
}) {
  const [scope, setScope] = useState<"active" | "closed" | "all">("active");
  const [rows, setRows] = useState<HiringVacancyRow[] | null>(null);
  const [all, setAll] = useState<HiringVacancyRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<HiringVacancyRow | null>(null);
  const [adding, setAdding] = useState(false);
  const edit = meta.access === "edit";

  const load = useCallback(() => {
    let alive = true;
    Promise.all([fetchHiringVacancies(scope), fetchHiringVacancies("all")])
      .then(([r, a]) => { if (alive) { setRows(r); setAll(a); setErr(null); } })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [scope]);
  useEffect(load, [load]);

  const patch = async (v: HiringVacancyRow, p: Record<string, unknown>, msg: string) => {
    try { await patchHiringVacancy(v.id, p); toast(msg); load(); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };

  const active = all.filter((v) => !isClosedVacancy(v.status));
  const month = todayKyiv().slice(0, 7);
  const closedMonth = all.filter((v) => isClosedVacancy(v.status) && (v.closed_on ?? "").startsWith(month));
  const statusLabel = (s: HiringVacancyStatus) => meta.vacancyStatuses.find((x) => x.key === s)?.label ?? s;
  const tile = (l: string, v: React.ReactNode, sub: string) => (
    <div className="hr-tile"><div className="lb"><span>{l}</span></div><div className="vl">{v}</div><div className="sb">{sub}</div></div>
  );

  return (
    <div>
      <div className="hr-pills">
        {([["active", "Активні"], ["closed", "Закриті"], ["all", "Усі"]] as const).map(([k, l]) => (
          <button key={k} className={scope === k ? "on" : ""} onClick={() => setScope(k)}>{l}</button>
        ))}
        {edit && <button className="hr-btn p" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>+ Вакансія</button>}
      </div>
      {err && <div className="chart-card" style={{ color: "var(--danger)" }}>{err}</div>}
      <div className="hr-card">
        <div className="hd"><div><h3>Вакансії</h3><div className="hr-muted">замість вкладки «Вакансії» в таблиці й розділу вакансій у Хурмі</div></div></div>
        <div className="hr-tiles">
          {tile("Активні", active.length, `відкрита ${active.filter((v) => v.status === "open").length} · в роботі ${active.filter((v) => v.status === "in_work").length} · на паузі ${active.filter((v) => v.status === "paused").length}`)}
          {tile("Потрібно людей", active.reduce((a, v) => a + v.need, 0), "на всі активні вакансії")}
          {tile("Кандидатів", active.reduce((a, v) => a + v.candidates, 0), "у повʼязках активних вакансій")}
          {tile("Закрито цього місяця", closedMonth.length, `успішно ${closedMonth.filter((v) => v.status === "closed").length} · скасовано ${closedMonth.filter((v) => v.status === "cancelled").length}`)}
        </div>
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>Вакансія</th><th>Статус</th><th>Веде</th><th className="num">Кандидатів</th><th className="num">Днів у пошуку</th><th /></tr></thead>
            <tbody>
              {rows?.map((v) => {
                const closed = isClosedVacancy(v.status);
                return (
                  <tr key={v.id} style={closed ? { color: "var(--text-muted)" } : undefined}>
                    <td>
                      <b>{v.title}</b>
                      <div className="hr-muted">
                        {v.opened_by ? `відкрив ${v.opened_by} ` : "відкрито "}{dm(v.opened_on)} · потрібно {v.need}
                        {closed && ` · ${v.close_result ?? ""} ${dm(v.closed_on)}`}
                      </div>
                    </td>
                    <td>
                      {!closed && edit ? (
                        <select className="hr-inp" value={v.status} onChange={(e) => void patch(v, { status: e.target.value }, `«${v.title}»: ${statusLabel(e.target.value as HiringVacancyStatus)}`)}>
                          {meta.vacancyStatuses.filter((s) => !isClosedVacancy(s.key)).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      ) : (
                        <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <span className={`hr-pill ${VACANCY_TONE[v.status]}`}>{statusLabel(v.status)}</span>
                          {closed && edit && <button className="hr-link" onClick={() => void patch(v, { status: "in_work" }, `«${v.title}» знову в роботі`)}>↩ повернути в роботу</button>}
                        </span>
                      )}
                    </td>
                    <td>
                      {!closed && edit ? (
                        <input key={`${v.id}-${v.responsible ?? ""}`} className="hr-inp" style={{ width: 120 }} list="hr-vac-resp" defaultValue={v.responsible ?? ""}
                          onBlur={(e) => { if (e.target.value !== (v.responsible ?? "")) void patch(v, { responsible: e.target.value }, "Відповідального змінено"); }} />
                      ) : (v.responsible || "—")}
                    </td>
                    <td className="num"><button className="hr-link" onClick={() => onOpenCandidates(v.id)} title="Відкрити кандидатів цієї вакансії">{v.candidates} ›</button></td>
                    <td className="num" style={!closed && v.days_open > 60 ? { color: "var(--danger)", fontWeight: 700 } : undefined}>{closed ? "—" : v.days_open}</td>
                    <td>{!closed && edit && <button className="hr-btn xs" onClick={() => setClosing(v)}>Закрити</button>}</td>
                  </tr>
                );
              })}
              {rows && !rows.length && <tr><td colSpan={6} className="hr-muted">{scope === "closed" ? "Закритих вакансій немає." : "Вакансій ще немає — додайте першу."}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="hr-sect hr-muted">Клік по числу кандидатів відкриває «Кандидатів» із фільтром цієї вакансії. Понад 60 днів у пошуку підсвічено червоним.</div>
      </div>
      <datalist id="hr-vac-resp">{meta.responsibles.map((x) => <option key={x} value={x} />)}</datalist>
      {closing && <CloseVacancy meta={meta} v={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); toast(`«${closing.title}» закрито`); load(); onChanged(); }} />}
      {adding && <AddVacancy meta={meta} onClose={() => setAdding(false)} onDone={() => { setAdding(false); toast("Вакансію відкрито"); load(); onChanged(); }} />}
    </div>
  );
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
