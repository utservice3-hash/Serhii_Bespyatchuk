import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchHiringCandidates, fetchHiringCard, createHiringCandidate, patchHiringCandidate, addHiringComment, hiringError,
  type HiringMeta, type HiringCandidateRow, type HiringCard, type HiringStatus,
} from "../../../api";
import { dm } from "../hiringView";
import { StatusDialog, StatusPill, type Toast } from "./HiringShared";

/**
 * 🗂 «КАНДИДАТИ» — база замість «Кандидати UA». Пошук за ПІБ, телефоном (≥4 цифри) і Telegram;
 * фільтри статусу, джерела й посади. Тімлід бачить лише своїх після співбесіди з ним — фільтр
 * стоїть на сервері, тут нічого не ховається додатково.
 */
export function HiringCandidates({ meta, toast }: { meta: HiringMeta; toast: Toast }) {
  const [f, setF] = useState({ q: "", status: "", source: "", position: "" });
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ total: number; rows: HiringCandidateRow[] } | null>(null);
  const [limit, setLimit] = useState(100);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const edit = meta.access === "edit";

  useEffect(() => { const t = window.setTimeout(() => setF((x) => ({ ...x, q })), 300); return () => window.clearTimeout(t); }, [q]);

  const load = useCallback(() => {
    let alive = true;
    fetchHiringCandidates({ ...f, limit })
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [f, limit]);
  useEffect(load, [load]);

  return (
    <div>
      <div className="hr-pills">
        <input className="hr-inp" style={{ minWidth: 230 }} placeholder="🔍 ПІБ, телефон, Telegram" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="hr-inp" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Статус: усі</option>
          {meta.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="hr-inp" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          <option value="">Джерело: усі</option>
          {meta.sources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="hr-inp" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })}>
          <option value="">Посада: усі</option>
          {meta.positions.map((s) => <option key={s}>{s}</option>)}
        </select>
        {edit && <button className="hr-btn p" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>+ Кандидат</button>}
      </div>

      <div className="hr-card">
        <div className="hd">
          <div><h3>Кандидати</h3><div className="hr-muted">{data ? `знайдено ${data.total}` : "…"} · клік по рядку відкриває картку</div></div>
        </div>
        {err && <p style={{ padding: 16, color: "var(--danger)" }}>{err}</p>}
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>Кандидат</th><th>Телефон · Telegram</th><th>Джерело</th><th>Посада</th><th>Статус</th><th>Команда</th><th>Остання співбесіда</th><th>Додано</th></tr></thead>
            <tbody>
              {data?.rows.map((c) => (
                <tr key={c.id} className="row" onClick={() => setOpenId(c.id)}>
                  <td><b>{c.full_name || <span className="hr-muted">ПІБ не вказано</span>}</b>{c.repeats ? <div className="hr-muted">повторний відгук ×{c.repeats}</div> : null}</td>
                  <td>{c.phone || "—"}{c.telegram ? <div className="hr-muted">{c.telegram}</div> : null}</td>
                  <td>{c.source || "—"}</td>
                  <td>{c.position || "—"}</td>
                  <td><StatusPill meta={meta} status={c.status} /></td>
                  <td>{c.team_name || "—"}</td>
                  <td>{dm(c.last_interview)}</td>
                  <td>{dm(c.created_on)}</td>
                </tr>
              ))}
              {data && !data.rows.length && <tr><td colSpan={8} className="hr-muted">{meta.access === "lead" ? "Поки немає кандидатів вашої команди після співбесіди з тімлідом." : "Нікого не знайдено."}</td></tr>}
            </tbody>
          </table>
        </div>
        {data && data.rows.length < data.total && (
          <div style={{ padding: 12 }}><button className="hr-btn" onClick={() => setLimit((l) => l + 100)}>Показати ще ({data.total - data.rows.length})</button></div>
        )}
      </div>

      {openId != null && <CandidateDrawer meta={meta} id={openId} toast={toast} onClose={() => setOpenId(null)} onChanged={load} />}
      {adding && <AddCandidate meta={meta} toast={toast} onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); load(); setOpenId(id); }} />}
    </div>
  );
}

function AddCandidate({ meta, toast, onClose, onCreated }: { meta: HiringMeta; toast: Toast; onClose: () => void; onCreated: (id: number) => void }) {
  const [p, setP] = useState({ fullName: "", phone: "", telegram: "", source: "", position: "", resumeUrl: "", comment: "" });
  const [err, setErr] = useState<{ text: string; existingId?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try { const id = await createHiringCandidate(p); toast("Кандидата додано"); onCreated(id); }
    catch (e) {
      const ex = (e as { response?: { data?: { existing?: { id: number } } } })?.response?.data?.existing;
      setErr({ text: hiringError(e), existingId: ex?.id });
    } finally { setBusy(false); }
  };
  const field = (k: keyof typeof p, label: string, list?: string[]) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>{label}
      <input className="hr-inp" value={p[k]} list={list ? `hr-add-${k}` : undefined} onChange={(e) => setP({ ...p, [k]: e.target.value })} />
      {list && <datalist id={`hr-add-${k}`}>{list.map((x) => <option key={x} value={x} />)}</datalist>}
    </label>
  );
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 560 }} role="dialog" aria-label="Новий кандидат" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Новий кандидат</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
          {field("fullName", "ПІБ")}{field("phone", "Телефон")}{field("telegram", "Telegram")}
          {field("source", "Джерело", meta.sources)}{field("position", "Посада", meta.positions)}{field("resumeUrl", "Резюме (посилання)")}
        </div>
        <label style={{ display: "block", marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>Коментар
          <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} value={p.comment} onChange={(e) => setP({ ...p, comment: e.target.value })} />
        </label>
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err.text}{err.existingId && <> · <button className="hr-link" onClick={() => onCreated(err.existingId!)}>відкрити картку</button></>}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy || !p.fullName.trim()} onClick={() => void save()}>Додати</button>
        </div>
      </div>
    </div>, document.body);
}

const KIND_LABEL: Record<string, string> = { created: "створено", status: "статус", attended: "явка", comment: "коментар", repeat: "повторний відгук", edit: "змінено поля" };

/** Картка кандидата: поля, співбесіди, історія, наступні статуси. Використовується й графіком. */
export function CandidateDrawer({ meta, id, toast, onClose, onChanged }: {
  meta: HiringMeta; id: number; toast: Toast; onClose: () => void; onChanged: () => void;
}) {
  const [card, setCard] = useState<HiringCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [to, setTo] = useState<HiringStatus | null>(null);
  const [note, setNote] = useState("");
  const edit = meta.access === "edit";

  const load = useCallback(() => {
    fetchHiringCard(id).then((c) => { setCard(c); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);

  const save = async (patch: Record<string, unknown>) => {
    try { await patchHiringCandidate(id, patch); load(); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };
  const label = (s: HiringStatus | null) => (s ? meta.statuses.find((x) => x.key === s)?.label ?? s : "—");

  const c = card?.candidate;
  const next = c ? meta.transitions[c.status] ?? [] : [];
  const undo = card?.lastFrom && c && !next.includes(card.lastFrom) ? card.lastFrom : null;

  const text = (k: string, label: string, value: string | null, placeholder = "") => (
    <>
      <span className="k">{label}</span>
      {edit
        ? <input key={`${k}-${value}`} className="hr-inp" defaultValue={value ?? ""} placeholder={placeholder}
            onBlur={(e) => { if (e.target.value !== (value ?? "")) void save({ [k]: e.target.value }); }} />
        : <span style={{ paddingTop: 6 }}>{value || "—"}</span>}
    </>
  );

  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer" role="dialog" aria-label="Картка кандидата" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <b style={{ fontSize: 17 }}>{c ? c.full_name || "ПІБ не вказано" : "…"}</b>
          <button className="hr-btn" onClick={onClose}>Закрити</button>
        </div>
        {err && <p style={{ color: "var(--danger)" }}>{err}</p>}
        {c && card && (
          <>
            <div style={{ margin: "8px 0 14px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              <StatusPill meta={meta} status={c.status} />
              {c.team_name && <span className="hr-pill gr">{c.team_name}</span>}
            </div>
            <div className="hr-kv">
              {text("fullName", "ПІБ", c.full_name)}
              {text("phone", "Телефон", c.phone, "ключ дублів")}
              {text("telegram", "Telegram", c.telegram, "@нік або посилання")}
              {text("source", "Джерело", c.source)}
              {text("position", "Посада", c.position)}
              <span className="k">Резюме</span>
              {edit
                ? <span style={{ display: "flex", gap: 6 }}>
                    <input key={`r-${c.resume_url}`} className="hr-inp" style={{ flex: 1 }} defaultValue={c.resume_url ?? ""} placeholder="https://…"
                      onBlur={(e) => { if (e.target.value !== (c.resume_url ?? "")) void save({ resumeUrl: e.target.value }); }} />
                    {c.resume_url && <a className="hr-link" href={c.resume_url} target="_blank" rel="noopener noreferrer" style={{ paddingTop: 6 }}>↗</a>}
                  </span>
                : c.resume_url ? <a className="hr-link" href={c.resume_url} target="_blank" rel="noopener noreferrer" style={{ paddingTop: 6 }}>відкрити ↗</a> : <span style={{ paddingTop: 6 }}>—</span>}
              {text("comment", "Коментар", c.comment)}
              <span className="k">Додано</span><span style={{ paddingTop: 6 }}>{dm(c.created_on)}.{c.created_on.slice(0, 4)}</span>
            </div>

            {(next.length > 0 || undo) && (
              <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
                <h4>Змінити статус</h4>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {next.map((s) => <button key={s} className={`hr-btn ${["done", "candidate", "manager"].includes(s) ? "p" : ""}`} onClick={() => setTo(s)}>{label(s)}</button>)}
                  {undo && <button className="hr-btn" onClick={() => setTo(undo)} title="Скасувати останню зміну статусу">↩ Повернути «{label(undo)}»</button>}
                </div>
              </div>
            )}

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Коментар в історію</h4>
              <div style={{ display: "flex", gap: 6 }}>
                <input className="hr-inp" style={{ flex: 1 }} value={note} placeholder="Що сталось, домовленості…" onChange={(e) => setNote(e.target.value)} />
                <button className="hr-btn" disabled={!note.trim()} onClick={async () => {
                  try { await addHiringComment(id, note.trim()); setNote(""); load(); } catch (e) { toast(hiringError(e), { error: true }); }
                }}>Додати</button>
              </div>
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Співбесіди</h4>
              {card.interviews.length ? (
                <ul className="hr-hist">
                  {card.interviews.map((i) => (
                    <li key={i.id}>
                      <b>{dm(i.interview_date)}</b> {i.interview_time ?? ""} · {i.responsible || "відповідальний не вказаний"} ·{" "}
                      {i.attended === true ? "прийшов" : i.attended === false ? "не прийшов" : "не відмічено"}
                      {i.record_url && <> · <a className="hr-link" href={i.record_url} target="_blank" rel="noopener noreferrer">запис ↗</a></>}
                      {i.comment && <div className="hr-muted">{i.comment}</div>}
                    </li>
                  ))}
                </ul>
              ) : <div className="hr-muted">У графіку ще немає.</div>}
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Історія</h4>
              <ul className="hr-hist">
                {card.events.map((e) => (
                  <li key={e.id}>
                    <span className="hr-muted">{e.at.slice(8, 10)}.{e.at.slice(5, 7)} {e.at.slice(11)} · {e.actor ?? "система"} · {KIND_LABEL[e.kind] ?? e.kind}</span><br />
                    {e.kind === "status" && <>«{label(e.from_status)}» → «{label(e.to_status)}»{e.comment ? " · " : ""}</>}
                    {e.comment}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
        {to && c && (
          <StatusDialog meta={meta} candidateId={id} from={c.status} to={to} teamId={c.team_id} toast={toast}
            onClose={() => setTo(null)} onDone={() => { setTo(null); load(); onChanged(); }} />
        )}
      </div>
    </div>, document.body);
}
