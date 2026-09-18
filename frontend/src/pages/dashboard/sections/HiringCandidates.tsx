import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchHiringCandidates, fetchHiringCard, createHiringCandidate, patchHiringCandidate, addHiringComment, hiringError,
  setHiringCandidateVacancies, setHiringReserve, uploadHiringFile, deleteHiringFile, restoreHiringFile, fetchHiringFileBlobUrl,
  type HiringMeta, type HiringCandidateRow, type HiringCard, type HiringStatus,
} from "../../../api";
import { dm, isClosedVacancy, todayKyiv } from "../hiringView";
import { StatusDialog, StatusPill, RefusalDialog, type Toast } from "./HiringShared";
import { TrainingAccessBlock } from "./HiringTraining";
import { InterviewDialog } from "./HiringInterviewDialog";

/**
 * 🗂 «КАНДИДАТИ» — база замість «Кандидати UA». Прохід 1a (за Хурмою): фільтри вакансії, резерву,
 * сторони відмови; вакансії чипами; «без вакансії» — числом у шапці й фільтром (невідоме видиме).
 * Тімлід бачить лише своїх після співбесіди з ним — фільтр на сервері.
 */
type Filters = { q: string; status: string; source: string; vacancyId: string; refusalSide: string; reserve: "" | "yes" | "no"; noVacancy: boolean };

export function HiringCandidates({ meta, toast, initialVacancyId, onMetaStale }: {
  meta: HiringMeta; toast: Toast; initialVacancyId?: number | null; onMetaStale: () => void;
}) {
  const [f, setF] = useState<Filters>({ q: "", status: "", source: "", vacancyId: initialVacancyId ? String(initialVacancyId) : "", refusalSide: "", reserve: "", noVacancy: false });
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ total: number; rows: HiringCandidateRow[]; noVacancy: number; inReserve: number } | null>(null);
  const [limit, setLimit] = useState(100);
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const edit = meta.access === "edit";

  useEffect(() => { if (initialVacancyId) setF((x) => ({ ...x, vacancyId: String(initialVacancyId), noVacancy: false })); }, [initialVacancyId]);
  useEffect(() => { const t = window.setTimeout(() => setF((x) => ({ ...x, q })), 300); return () => window.clearTimeout(t); }, [q]);

  const load = useCallback(() => {
    let alive = true;
    fetchHiringCandidates({
      q: f.q, status: f.status, source: f.source, vacancyId: f.vacancyId, refusalSide: f.refusalSide,
      reserve: f.reserve, noVacancy: f.noVacancy ? "1" : "", limit,
    })
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [f, limit]);
  useEffect(load, [load]);

  const activeVacancies = meta.vacancies.filter((v) => !isClosedVacancy(v.status));

  return (
    <div>
      <div className="hr-pills">
        <input className="hr-inp" style={{ minWidth: 230 }} placeholder="🔍 ПІБ, телефон, пошта, Telegram" value={q} onChange={(e) => setQ(e.target.value)} />
        {edit && (
          <select className="hr-inp" value={f.vacancyId} onChange={(e) => setF({ ...f, vacancyId: e.target.value, noVacancy: false })}>
            <option value="">Вакансія: усі</option>
            {meta.vacancies.map((v) => <option key={v.id} value={v.id}>{v.title}{isClosedVacancy(v.status) ? " (закрита)" : ""}</option>)}
          </select>
        )}
        <select className="hr-inp" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Статус: усі</option>
          {meta.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="hr-inp" value={f.refusalSide} onChange={(e) => setF({ ...f, refusalSide: e.target.value })}>
          <option value="">Відмова: усі</option>
          <option value="candidate">відмова кандидата</option>
          <option value="company">відмова компанії</option>
        </select>
        <select className="hr-inp" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          <option value="">Джерело: усі</option>
          {meta.sources.map((s) => <option key={s}>{s}</option>)}
        </select>
        <span className="hr-seg2">
          {([["", "Усі"], ["yes", `У резерві ${data?.inReserve ?? ""}`], ["no", "Без резерву"]] as const).map(([k, l]) => (
            <button key={k} className={f.reserve === k ? "on" : ""} onClick={() => setF({ ...f, reserve: k })}>{l}</button>
          ))}
        </span>
        {edit && <button className="hr-btn p" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>+ Кандидат</button>}
      </div>

      <div className="hr-card">
        <div className="hd">
          <div><h3>Кандидати</h3><div className="hr-muted">{data ? `знайдено ${data.total}` : "…"} · клік по рядку відкриває картку</div></div>
          {!!data?.noVacancy && edit && (
            <button className="hr-pill wn" style={{ border: 0, cursor: "pointer" }} title="Показати кандидатів без вакансії — вони не рахуються в жодній вакансії"
              onClick={() => setF({ ...f, noVacancy: !f.noVacancy, vacancyId: "" })}>
              {f.noVacancy ? "✕ " : ""}без вакансії: {data.noVacancy}
            </button>
          )}
        </div>
        {err && <p style={{ padding: 16, color: "var(--danger)" }}>{err}</p>}
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>Кандидат</th><th>Вакансії</th><th>Джерело</th><th>Статус</th><th>Відмова</th><th>Команда</th><th>Остання співбесіда</th><th className="num">Файли</th></tr></thead>
            <tbody>
              {data?.rows.map((c) => (
                <tr key={c.id} className="row" onClick={() => setOpenId(c.id)}>
                  <td>
                    <b>{c.full_name || <span className="hr-muted">ПІБ не вказано</span>}</b>
                    <div className="hr-muted">{c.phone || "телефон не вказано"}{c.telegram ? ` · ${c.telegram}` : ""}{c.email ? <><br />{c.email}</> : null}</div>
                    {c.repeats ? <div className="hr-muted">повторний відгук ×{c.repeats}</div> : null}
                  </td>
                  <td>{c.vacancies.length ? c.vacancies.map((v) => <span key={v.id} className="hr-chip">{v.title}</span>) : <span className="hr-chip warn">без вакансії</span>}</td>
                  <td>{c.source || "—"}</td>
                  <td><StatusPill meta={meta} status={c.status} />{c.reserved_on && <div className="hr-muted">у резерві з {dm(c.reserved_on)}</div>}</td>
                  <td>{c.status === "refused" || c.status === "black"
                    ? <><span className="hr-muted">{c.refusal_side === "company" ? "компанія · " : c.refusal_side === "candidate" ? "кандидат · " : ""}</span>{c.refusal_reason ?? "причина не вказана (перенесено)"}</>
                    : "—"}</td>
                  <td>{c.team_name || "—"}</td>
                  <td>{dm(c.last_interview)}</td>
                  <td className="num">{c.files_count || "—"}</td>
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

      {openId != null && <CandidateDrawer meta={meta} id={openId} toast={toast} onClose={() => setOpenId(null)} onChanged={load} onMetaStale={onMetaStale} />}
      {adding && <AddCandidate meta={meta} vacancies={activeVacancies} toast={toast} onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); load(); setOpenId(id); }} />}
    </div>
  );
}

function AddCandidate({ meta, vacancies, toast, onClose, onCreated }: {
  meta: HiringMeta; vacancies: HiringMeta["vacancies"]; toast: Toast; onClose: () => void; onCreated: (id: number) => void;
}) {
  const [p, setP] = useState({ fullName: "", phone: "", email: "", telegram: "", source: "", vacancyId: "", status: "new", resumeUrl: "", comment: "" });
  const [err, setErr] = useState<{ text: string; existingId?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!p.fullName.trim()) { setErr({ text: "Введіть ПІБ" }); return; }
    if (!p.vacancyId) { setErr({ text: "Оберіть вакансію — без неї кандидат не потрапить у лічильник вакансії" }); return; }
    setBusy(true); setErr(null);
    try { const id = await createHiringCandidate({ ...p, vacancyIds: [Number(p.vacancyId)] }); toast("Кандидата додано"); onCreated(id); }
    catch (e) {
      const ex = (e as { response?: { data?: { existing?: { id: number } } } })?.response?.data?.existing;
      setErr({ text: hiringError(e), existingId: ex?.id });
    } finally { setBusy(false); }
  };
  const field = (k: keyof typeof p, label: string, extra: { list?: string[]; placeholder?: string } = {}) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>{label}
      <input className="hr-inp" value={p[k]} placeholder={extra.placeholder} list={extra.list ? `hr-add-${k}` : undefined} onChange={(e) => { setP({ ...p, [k]: e.target.value }); setErr(null); }} />
      {extra.list && <datalist id={`hr-add-${k}`}>{extra.list.map((x) => <option key={x} value={x} />)}</datalist>}
    </label>
  );
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 560 }} role="dialog" aria-label="Новий кандидат" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Новий кандидат</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
          {field("fullName", "ПІБ")}{field("phone", "Телефон · ключ дублів", { placeholder: "066 000 01 01" })}
          {field("email", "Пошта", { placeholder: "name@gmail.com" })}{field("telegram", "Telegram", { placeholder: "@нік" })}
          {field("source", "Джерело", { list: meta.sources })}
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>Вакансія · обовʼязково
            <select className="hr-inp" value={p.vacancyId} onChange={(e) => { setP({ ...p, vacancyId: e.target.value }); setErr(null); }}>
              <option value="">— оберіть —</option>
              {vacancies.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>Статус
            <select className="hr-inp" value={p.status} onChange={(e) => setP({ ...p, status: e.target.value })}>
              <option value="new">новий</option><option value="contacted">перше повідомлення</option>
            </select>
          </label>
          {field("resumeUrl", "Резюме (посилання)")}
        </div>
        {!vacancies.length && <div className="hr-muted" style={{ marginTop: 8 }}>Активних вакансій немає — спершу відкрийте вакансію у вкладці «Вакансії».</div>}
        <label style={{ display: "block", marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>Коментар
          <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} value={p.comment} onChange={(e) => setP({ ...p, comment: e.target.value })} />
        </label>
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err.text}{err.existingId && <> · <button className="hr-link" onClick={() => onCreated(err.existingId!)}>відкрити картку</button></>}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>Додати</button>
        </div>
      </div>
    </div>, document.body);
}

const KIND_LABEL: Record<string, string> = {
  created: "створено", status: "статус", attended: "явка", comment: "коментар", repeat: "повторний відгук", edit: "змінено поля",
  refusal: "відмова", reserve: "резерв", vacancy: "вакансія", file: "файл",
};

/** Картка кандидата: контакти, вакансії, відмова, резерв, статуси, файли, історія. Використовується й графіком. */
export function CandidateDrawer({ meta, id, toast, onClose, onChanged, onMetaStale }: {
  meta: HiringMeta; id: number; toast: Toast; onClose: () => void; onChanged: () => void; onMetaStale?: () => void;
}) {
  const [card, setCard] = useState<HiringCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [to, setTo] = useState<HiringStatus | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [booking, setBooking] = useState(false);
  const [note, setNote] = useState("");
  const [reserveNote, setReserveNote] = useState("");
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const edit = meta.access === "edit";

  const load = useCallback(() => {
    fetchHiringCard(id).then((c) => { setCard(c); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok); load(); onChanged(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };
  const save = (patch: Record<string, unknown>) => run(() => patchHiringCandidate(id, patch));
  const label = (s: HiringStatus | null) => (s ? meta.statuses.find((x) => x.key === s)?.label ?? s : "—");

  const c = card?.candidate;
  const next = c ? meta.transitions[c.status] ?? [] : [];
  const undo = card?.lastFrom && c && !next.includes(card.lastFrom) && card.lastFrom !== "refused" && card.lastFrom !== "black" ? card.lastFrom : null;
  const vacIds = c?.vacancies.map((v) => v.id) ?? [];

  const setVacancies = (ids: number[], msg: string, undoIds?: number[]) => run(async () => {
    await setHiringCandidateVacancies(id, ids);
    if (undoIds) toast(msg, { action: { label: "Повернути", run: () => void run(() => setHiringCandidateVacancies(id, undoIds), "Вакансію повернуто") } });
    else toast(msg);
  });

  const text = (k: string, lbl: string, value: string | null, placeholder = "") => (
    <>
      <span className="k">{lbl}</span>
      {edit
        ? <input key={`${k}-${value}`} className="hr-inp" defaultValue={value ?? ""} placeholder={placeholder}
            onBlur={(e) => { if (e.target.value !== (value ?? "")) void save({ [k]: e.target.value }); }} />
        : <span style={{ paddingTop: 6 }}>{value || "—"}</span>}
    </>
  );

  const openFile = async (fid: number, name: string, mime: string) => {
    try {
      const url = await fetchHiringFileBlobUrl(id, fid);
      if (mime.startsWith("image/")) setPreview({ url, name, mime });
      else { window.open(url, "_blank", "noopener"); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    } catch (e) { toast(hiringError(e), { error: true }); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setFileErr(null);
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)) { setFileErr("Приймаються лише PNG, JPG, WEBP або PDF"); return; }
    if (file.size > 5 * 1024 * 1024) { setFileErr(`Файл ${(file.size / 1048576).toFixed(1)} МБ — більше за 5 МБ`); return; }
    await run(() => uploadHiringFile(id, file), "Файл додано");
  };

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
              {c.reserved_on && <span className="hr-pill wn">у резерві</span>}
            </div>

            <div className="hr-sect" style={{ padding: 0, border: 0 }}><h4>Контакти</h4></div>
            <div className="hr-kv">
              {text("fullName", "ПІБ", c.full_name)}
              {text("phone", "Телефон", c.phone, "ключ дублів")}
              {text("email", "Пошта", c.email, "name@gmail.com")}
              {text("telegram", "Telegram", c.telegram, "@нік або посилання")}
              <span className="k">Написати</span>
              <span className="hr-msgs">
                {card.messengers.telegram && <a className="hr-msg" href={card.messengers.telegram} target="_blank" rel="noopener noreferrer">Telegram</a>}
                {card.messengers.viber && <a className="hr-msg" href={card.messengers.viber}>Viber</a>}
                {card.messengers.whatsapp && <a className="hr-msg" href={card.messengers.whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
                {!card.messengers.telegram && !card.messengers.viber && <span className="hr-muted">немає телефону чи Telegram</span>}
              </span>
              {text("source", "Джерело", c.source)}
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

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Вакансії</h4>
              <div>
                {c.vacancies.length ? c.vacancies.map((v) => (
                  <span key={v.id} className="hr-chip">{v.title}
                    {edit && <button className="x" aria-label={`Прибрати вакансію ${v.title}`}
                      onClick={() => void setVacancies(vacIds.filter((x) => x !== v.id), `Вакансію «${v.title}» прибрано`, vacIds)}>✕</button>}
                  </span>
                )) : <span className="hr-chip warn">без вакансії — не рахується в жодній вакансії</span>}
              </div>
              {edit && (
                <select className="hr-inp" style={{ marginTop: 6, maxWidth: 320 }} value="" onChange={(e) => { const v = Number(e.target.value); if (v) void setVacancies([...vacIds, v], "Вакансію додано: +1 кандидат у вакансії"); }}>
                  <option value="">+ Додати вакансію</option>
                  {meta.vacancies.filter((v) => !isClosedVacancy(v.status) && !vacIds.includes(v.id)).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
                </select>
              )}
              <div className="hr-muted" style={{ marginTop: 4 }}>Людина може відгукнутись на кілька вакансій — картка лишається одна.</div>
            </div>

            {(c.status === "refused" || c.status === "black") && (
              <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
                <h4>Відмова</h4>
                <div className={`hr-refbox ${c.refusal_side ?? ""}`}>
                  <b>{c.refusal_side === "company" ? "Відмова компанії" : c.refusal_side === "candidate" ? "Відмова кандидата" : "Відмова"}</b>
                  {" · "}{c.refusal_reason ?? "причина не вказана (перенесено зі старого статусу)"}
                  {c.status === "black" && <> · <span className="hr-pill dg">чорний список</span></>}
                  {c.refusal_note && <div className="hr-muted">{c.refusal_note}</div>}
                  {c.refused_on && <div className="hr-muted">{dm(c.refused_on)}</div>}
                </div>
              </div>
            )}

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Резерв</h4>
              {c.reserved_on
                ? <div>У резерві з {dm(c.reserved_on)}{c.reserve_note ? <span className="hr-muted"> · {c.reserve_note}</span> : null}</div>
                : <div className="hr-muted">Не в резерві</div>}
              {edit && (c.reserved_on
                ? <button className="hr-btn" style={{ marginTop: 6 }} onClick={() => void run(async () => {
                    const prevNote = c.reserve_note ?? "";
                    await setHiringReserve(id, { on: false });
                    toast("Прибрано з резерву", { action: { label: "Повернути", run: () => void run(() => setHiringReserve(id, { on: true, note: prevNote }), "Повернуто в резерв") } });
                  })}>Прибрати з резерву</button>
                : <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <input className="hr-inp" style={{ flex: 1 }} placeholder="Коли повернутись до кандидата" value={reserveNote} onChange={(e) => setReserveNote(e.target.value)} />
                    <button className="hr-btn" onClick={() => void run(() => setHiringReserve(id, { on: true, note: reserveNote }), "Додано в резерв").then(() => setReserveNote(""))}>Додати в резерв</button>
                  </div>)}
            </div>

            <TrainingAccessBlock key={`${c.status}-${card.events.length}`} meta={meta} id={id} toast={toast} onChanged={() => { load(); onChanged(); }} />

            {(next.length > 0 || undo) && (
              <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
                <h4>Змінити статус</h4>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {next.map((s) => s === "refused"
                    ? <button key={s} className="hr-btn dg" onClick={() => setRefusing(true)}>Відмовити…</button>
                    : <button key={s} className={`hr-btn ${["done", "candidate", "manager", "planned"].includes(s) ? "p" : ""}`} onClick={() => setTo(s)}>{label(s)}</button>)}
                  {undo && <button className="hr-btn" onClick={() => setTo(undo)} title="Скасувати останню зміну статусу">↩ Повернути «{label(undo)}»</button>}
                </div>
              </div>
            )}
            {edit && (
              <div style={{ marginTop: 10 }}>
                <button className="hr-btn" onClick={() => setBooking(true)}>📅 Призначити співбесіду</button>
              </div>
            )}
            {booking && <InterviewDialog meta={meta} day={todayKyiv()} fixed={{ id, name: c.full_name || "кандидат" }} onClose={() => setBooking(false)}
              onDone={(msg) => { setBooking(false); toast(msg); load(); onChanged(); }} />}

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Файли-докази</h4>
              {card.files.length ? (
                <div className="hr-files">
                  {card.files.map((fl) => (
                    <div key={fl.id} className="hr-file">
                      <button className="hr-link fn" title={fl.name} onClick={() => void openFile(fl.id, fl.name, fl.mime)}>{fl.mime === "application/pdf" ? "📄 " : "🖼 "}{fl.name}</button>
                      <span className="hr-muted">{Math.max(1, Math.round(fl.size_bytes / 1024))} КБ · {fl.author ?? "—"} · {dm(fl.created)}</span>
                      {edit && <button className="hr-btn xs" onClick={() => void run(async () => {
                        await deleteHiringFile(id, fl.id);
                        toast(`Файл «${fl.name}» видалено`, { action: { label: "Відновити", run: () => void run(() => restoreHiringFile(id, fl.id), "Файл відновлено") } });
                      })}>Видалити</button>}
                    </div>
                  ))}
                </div>
              ) : <div className="hr-muted">Файлів немає. Сюди — скриншот переписки, відмова в месенджері, фото документа.</div>}
              {edit && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                  <label className="hr-btn" style={{ cursor: "pointer" }}>+ Додати файл
                    <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
                  </label>
                  <span className="hr-muted">PNG, JPG, WEBP або PDF, до 5 МБ</span>
                </div>
              )}
              {fileErr && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{fileErr}</div>}
              {preview && (
                <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><b>{preview.name}</b><button className="hr-btn xs" onClick={() => setPreview(null)}>Закрити перегляд</button></div>
                  <img src={preview.url} alt={preview.name} style={{ maxWidth: "100%", borderRadius: 6 }} />
                </div>
              )}
            </div>

            <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
              <h4>Коментар в історію</h4>
              <div style={{ display: "flex", gap: 6 }}>
                <input className="hr-inp" style={{ flex: 1 }} value={note} placeholder="Що сталось, домовленості…" onChange={(e) => setNote(e.target.value)} />
                <button className="hr-btn" disabled={!note.trim()} onClick={() => void run(() => addHiringComment(id, note.trim())).then(() => setNote(""))}>Додати</button>
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
        {refusing && c && (
          <RefusalDialog meta={meta} candidateId={id} candidateName={c.full_name} from={c.status} toast={toast}
            onClose={() => setRefusing(false)} onDone={() => { setRefusing(false); load(); onChanged(); }}
            onReasonsChanged={() => onMetaStale?.()} />
        )}
      </div>
    </div>, document.body);
}
