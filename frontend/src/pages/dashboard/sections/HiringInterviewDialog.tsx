import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createHiringInterviewFor, fetchHiringCandidates, hiringError, type HiringMeta, type HiringCandidateRow } from "../../../api";
import { longDate, LS, isClosedVacancy } from "../hiringView";
import { StatusPill } from "./HiringShared";

/**
 * 📅 «+ СПІВБЕСІДА» (18.09.2026, макет v14 «Графік — розклад»). Дві вкладки: наявний кандидат (пошук за
 * ПІБ, телефоном, Telegram по всій базі) або новий (ПІБ, телефон, вакансія — обовʼязкові). Сервер
 * створює рядок графіка й кандидата в одній транзакції; той самий номер — наявний кандидат, не дубль.
 * `fixed` — виклик із картки кандидата: вкладок немає, кандидат уже обраний.
 */
export function InterviewDialog({ meta, day, time, fixed, onClose, onDone }: {
  meta: HiringMeta; day: string; time?: string; fixed?: { id: number; name: string };
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"exist" | "new">("exist");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HiringCandidateRow[]>([]);
  const [pick, setPick] = useState<{ id: number; name: string } | null>(fixed ?? null);
  const [date, setDate] = useState(day);
  const [tm, setTm] = useState(time ?? "10:00");
  const [resp, setResp] = useState(LS.get("responsible") ?? meta.responsibles[0] ?? "");
  const [n, setN] = useState({ fullName: "", phone: "", vacancyId: "", source: meta.sources[0] ?? "", telegram: "" });
  const [dup, setDup] = useState<HiringCandidateRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (fixed || mode !== "exist") return;
    const t = window.setTimeout(() => {
      fetchHiringCandidates({ q: q.trim() || undefined, limit: 30 }).then((r) => setHits(r.rows)).catch(() => setHits([]));
    }, 220);
    return () => window.clearTimeout(t);
  }, [q, mode, fixed]);
  useEffect(() => {
    const d = n.phone.replace(/\D/g, "");
    if (mode !== "new" || d.length < 9) { setDup(null); return; }
    const t = window.setTimeout(() => {
      fetchHiringCandidates({ q: d.slice(-9), limit: 1 }).then((r) => setDup(r.rows[0] ?? null)).catch(() => setDup(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [n.phone, mode]);

  const submit = async () => {
    setErr(null);
    if (mode === "exist" && !pick) { setErr("Оберіть кандидата зі списку"); return; }
    if (mode === "new" && (!n.fullName.trim() || n.phone.replace(/\D/g, "").length < 9 || !n.vacancyId)) { setErr("Потрібні ПІБ, телефон і вакансія"); return; }
    setBusy(true);
    try {
      if (resp) LS.set("responsible", resp);
      const r = await createHiringInterviewFor({
        interviewDate: date, interviewTime: tm || undefined, responsible: resp || undefined,
        ...(mode === "exist" ? { candidateId: pick!.id } : {
          newCandidate: { fullName: n.fullName.trim(), phone: n.phone, vacancyId: Number(n.vacancyId), source: n.source || undefined, telegram: n.telegram || undefined },
        }),
      });
      const who = mode === "exist" ? pick!.name : n.fullName.trim();
      const st = meta.statuses.find((s) => s.key === r.status)?.label ?? "";
      onDone(r.repeat ? `Цей номер уже був у базі — співбесіду призначено наявному кандидату (${st})`
        : r.moved ? `${who}: співбесіда ${tm}, статус «заплановано»`
        : mode === "new" ? `${who}: новий кандидат, співбесіда ${tm}` : `${who}: співбесіда ${tm} (статус «${st}» не змінено)`);
    } catch (e) { setErr(hiringError(e)); setBusy(false); }
  };

  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Нова співбесіда" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 96vw)" }}>
        <h3 style={{ margin: "0 0 4px" }}>{fixed ? `Співбесіда: ${fixed.name}` : "Нова співбесіда"}</h3>
        <p className="hr-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>Рядок зʼявиться в «Графіку», кандидат — у «Кандидатах».</p>
        {!fixed && (
          <div className="iv-tabs">
            <button className={mode === "exist" ? "on" : ""} onClick={() => { setMode("exist"); setErr(null); }}>Наявний кандидат</button>
            <button className={mode === "new" ? "on" : ""} onClick={() => { setMode("new"); setPick(null); setErr(null); }}>Новий кандидат</button>
          </div>
        )}
        {!fixed && mode === "exist" && (
          <>
            <input className="hr-inp" autoFocus placeholder="🔍 ПІБ, телефон або Telegram" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} aria-label="Пошук кандидата" />
            <div className="iv-list">
              {hits.length === 0 ? <div className="hr-muted" style={{ padding: 10 }}>Нікого не знайдено — перейдіть на «Новий кандидат».</div>
                : hits.map((c) => (
                  <button key={c.id} className={`iv-it ${pick?.id === c.id ? "sel" : ""}`} onClick={() => setPick({ id: c.id, name: c.full_name })}>
                    <span className="ag-av sm" style={{ ["--av" as string]: avatarTone(c.full_name) }}>{initials(c.full_name)}</span>
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}><b>{c.full_name || "без імені"}</b>
                      <span className="hr-muted" style={{ display: "block", fontSize: 12 }}>{c.phone ?? "без телефону"}{c.vacancies?.[0] ? ` · ${c.vacancies[0].title}` : ""}</span></span>
                    <StatusPill meta={meta} status={c.status} />
                  </button>
                ))}
            </div>
          </>
        )}
        {!fixed && mode === "new" && (
          <div className="emp-form" style={{ marginTop: 0 }}>
            <label><span>ПІБ *</span><input className="hr-inp" autoFocus value={n.fullName} onChange={(e) => setN({ ...n, fullName: e.target.value })} placeholder="Прізвище Імʼя" /></label>
            <label><span>Телефон *</span><input className="hr-inp" value={n.phone} onChange={(e) => setN({ ...n, phone: e.target.value })} placeholder="0XX XXX XX XX" /></label>
            <label><span>Вакансія *</span>
              <select className="hr-inp" value={n.vacancyId} onChange={(e) => setN({ ...n, vacancyId: e.target.value })}>
                <option value="">— оберіть —</option>
                {meta.vacancies.filter((v) => !isClosedVacancy(v.status)).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select></label>
            <label><span>Джерело</span>
              <select className="hr-inp" value={n.source} onChange={(e) => setN({ ...n, source: e.target.value })}>
                {meta.sources.map((x) => <option key={x}>{x}</option>)}
              </select></label>
            <label className="wide"><span>Telegram</span><input className="hr-inp" value={n.telegram} onChange={(e) => setN({ ...n, telegram: e.target.value })} placeholder="@нік" /></label>
            {dup && (
              <div className="hr-note wide" style={{ margin: 0 }}>
                Цей номер уже в базі: <b>{dup.full_name}</b>. <button className="hr-btn xs p" onClick={() => { setMode("exist"); setPick({ id: dup.id, name: dup.full_name }); setQ(dup.full_name); }}>Взяти його</button>
              </div>
            )}
          </div>
        )}
        <div className="emp-form" style={{ marginTop: 12 }}>
          <label><span>Дата</span><input className="hr-inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label><span>Час</span><input className="hr-inp" type="time" value={tm} onChange={(e) => setTm(e.target.value)} /></label>
          <label className="wide"><span>Хто проводить</span>
            <input className="hr-inp" list="iv-resp" value={resp} onChange={(e) => setResp(e.target.value)} /></label>
          <datalist id="iv-resp">{meta.responsibles.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
        <div className="hr-muted" style={{ fontSize: 12.5, marginTop: 6 }}>{longDate(date)}</div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void submit()}>{busy ? "Зберігаю…" : "Призначити співбесіду"}</button>
        </div>
      </div>
    </div>, document.body);
}

const TONES = ["#1d4ed8", "#047857", "#b45309", "#7c3aed", "#be185d", "#0e7490", "#4d7c0f", "#9f1239"];
export const avatarTone = (n: string | null) => TONES[[...(n || "?")].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % TONES.length];
export const initials = (n: string | null) => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
