import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchHuntRadar, fetchHuntActivity, revealHuntPhones, fetchHuntCandidates, addHuntCandidate, fetchHuntCandidate, updateHuntCandidate,
  moveHuntCandidate, commentHuntCandidate, hiringError,
  type HuntRadar, type HuntRadarRow, type HuntCandidateRow, type HuntCandidate, type HuntStage,
} from "../../../api";
import type { Toast } from "./HiringShared";

/**
 * 🎯 «ХАНТИНГ» (15.11.2026, ТЗ Івана, погоджено Сергієм) — проходи 1–2: «Радар Ларді» + «Воронка кандидатів».
 * Дані радару — архів `collectLardi` (наші маршрути, раз на 3 год), не весь Ларді; живий скан — прохід 3, лише з
 * пакетом «Розширений доступ до API». Доступ поіменний — вирішує сервер (`/api/hunt/access`). Правила — `core/hunt.ts`.
 */

const STAGES: [HuntStage, string][] = [["picked", "Обрано"], ["call", "Дзвінок"], ["interview", "Співбесіда"], ["approval", "Погодження"], ["offer", "Оффер"], ["hired", "Вийшов на роботу"]];
const STAGE_LABEL: Record<string, string> = Object.fromEntries([...STAGES, ["rejected", "Відмова"]]);
const REASONS: [string, string][] = [["salary", "Зарплата"], ["not_ready", "Не готовий переходити"], ["not_fit", "Не підійшов"], ["other", "Інше"]];
const dmy = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const dmyhm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");

export function HiringHunt({ toast }: { toast: Toast }) {
  const [sub, setSub] = useState<"radar" | "funnel">("radar");
  const [nonce, setNonce] = useState(0);
  const [openCand, setOpenCand] = useState<number | null>(null);
  return (
    <>
      <div className="hr-seg2" style={{ marginBottom: 14 }}>
        <button className={sub === "radar" ? "on" : ""} onClick={() => setSub("radar")}>Радар Ларді</button>
        <button className={sub === "funnel" ? "on" : ""} onClick={() => setSub("funnel")}>Воронка кандидатів</button>
      </div>
      {sub === "radar" ? <Radar toast={toast} nonce={nonce} onAdded={() => setNonce((n) => n + 1)} onOpenFunnel={(id) => { setSub("funnel"); setOpenCand(id); }} />
        : <Funnel toast={toast} nonce={nonce} openId={openCand} onOpen={setOpenCand} onChanged={() => setNonce((n) => n + 1)} />}
    </>
  );
}

/* ─────────────────────────── Радар ─────────────────────────── */

function Radar({ toast, nonce, onAdded, onOpenFunnel }: { toast: Toast; nonce: number; onAdded: () => void; onOpenFunnel: (id: number) => void }) {
  const [days, setDays] = useState(30);
  const [show, setShow] = useState("all");
  const [side, setSide] = useState("");
  const [q, setQ] = useState("");
  const [d, setD] = useState<HuntRadar | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<HuntRadarRow | null>(null);
  const load = useCallback(() => {
    setErr(null); fetchHuntRadar({ days, show, q, side }).then(setD).catch((e) => setErr(hiringError(e)));
  }, [days, show, q, side]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q, nonce]);
  const col = days === 1 ? "d1" : days === 7 ? "d7" : "d30";
  const stale = d?.dataUntil && Date.now() - new Date(d.dataUntil).getTime() > 6 * 3_600_000;
  return (
    <>
      {d && (
        <div className="hr-note" style={{ marginBottom: 12, ...(stale ? { background: "var(--warn-bg)", color: "var(--warn)" } : {}) }}>
          Джерело — архів заявок Ларді по наших маршрутах (оновлюється раз на 3 год), не весь Ларді.{" "}
          {stale ? <>Нові заявки не надходять з <b>{dmyhm(d.dataUntil)}</b>: пакет Ларді «Розширений доступ до API» не діє. Після оплати дані підуть самі.</>
            : <>Останнє оновлення: {dmyhm(d.dataUntil)}.</>}{" "}
          Тип компанії Ларді не віддає: серед активних є й вантажовласники.
        </div>
      )}
      <div className="page-filters" style={{ marginBottom: 12, alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="hr-seg2">{([[1, "День"], [7, "Тиждень"], [30, "Місяць"]] as const).map(([k, l]) => <button key={k} className={days === k ? "on" : ""} onClick={() => setDays(k)}>{l}</button>)}</div>
        <div className="hr-seg2">{([["", "Усі заявки"], ["cargo", "Вантаж"], ["lorry", "Транспорт"]] as const).map(([k, l]) => <button key={k} className={side === k ? "on" : ""} onClick={() => setSide(k)}>{l}</button>)}</div>
        <select className="hr-inp" value={show} onChange={(e) => setShow(e.target.value)} aria-label="Показати">
          <option value="all">Показати: усіх</option><option value="new">лише нових (не у воронці)</option><option value="funnel">лише у воронці</option>
        </select>
        <input className="hr-inp" placeholder="Пошук: імʼя, компанія, телефон" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px" }} aria-label="Пошук" />
      </div>
      {err ? <div className="chart-card"><b>Радар недоступний.</b> <span className="hr-muted">{err}</span></div> : !d ? <p className="loading-text">Рахую активність…</p> : (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><div className="kpi-label">Заявок за період</div><div className="kpi-value">{d.totals.offers.toLocaleString("uk-UA")}</div><div className="hr-muted">унікальних, у топі списку</div></div>
            <div className="kpi-card"><div className="kpi-label">Активних менеджерів</div><div className="kpi-value">{d.totals.contacts}</div><div className="hr-muted">з {d.totals.companies} компаній</div></div>
            <div className="kpi-card"><div className="kpi-label">Нових кандидатів</div><div className="kpi-value">{d.totals.notInFunnel}</div><div className="hr-muted">ще не у воронці</div></div>
            <div className="kpi-card"><div className="kpi-label">У воронці зараз</div><div className="kpi-value">{d.totals.inFunnel}</div><div className="hr-muted">без відмов</div></div>
          </div>
          <div className="chart-card" style={{ padding: 0 }}>
            <div className="hr-tw">
              <table className="data-table compact" style={{ width: "100%" }}>
                <thead><tr><th>#</th><th>Менеджер · компанія</th><th>Телефон</th><th className="num">День</th><th className="num">7 дн.</th><th className="num">30 дн.</th><th>Напрямки</th><th className="num">З ціною</th><th>Воронка</th></tr></thead>
                <tbody>
                  {d.rows.map((r, i) => (
                    <tr key={r.key} style={{ cursor: "pointer", background: pick?.key === r.key ? "var(--surface-2)" : undefined }} onClick={() => setPick(r)}>
                      <td className="hr-muted">{i + 1}</td>
                      <td><b>{r.face}</b><div className="hr-muted" style={{ fontSize: 12 }}>{r.company}</div></td>
                      <td className="hr-muted" style={{ whiteSpace: "nowrap" }}>{r.phones[0] ?? "—"}</td>
                      <td className="num" style={{ fontWeight: col === "d1" ? 700 : undefined }}>{r.d1 || "—"}</td>
                      <td className="num" style={{ fontWeight: col === "d7" ? 700 : undefined }}>{r.d7 || "—"}</td>
                      <td className="num" style={{ fontWeight: col === "d30" ? 700 : undefined }}>{r.d30}</td>
                      <td style={{ fontSize: 12 }}>{r.top.map((t) => <div key={t.dir}>{t.dir} <span className="hr-muted">· {t.n}</span></div>)}</td>
                      <td className="num">{r.pricePct}%</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {r.candidate ? <button className="emp-pill info" style={{ border: 0, cursor: "pointer" }} onClick={() => onOpenFunnel(r.candidate!.id)}>{STAGE_LABEL[r.candidate.stage]}</button>
                          : <button className="hr-btn xs" onClick={() => setPick(r)}>+ У воронку</button>}
                      </td>
                    </tr>))}
                  {!d.rows.length && <tr><td colSpan={9} className="hr-muted" style={{ padding: 16 }}>За цей період активних менеджерів немає{stale ? " — нових заявок з Ларді не надходить." : "."}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {pick && <RadarCard row={pick} toast={toast} onClose={() => setPick(null)} onAdded={() => { setPick(null); onAdded(); load(); }} onOpenFunnel={onOpenFunnel} />}
    </>
  );
}

function PhoneReveal({ contactKey, masked, toast }: { contactKey: string; masked: string[]; toast: Toast }) {
  const [full, setFull] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const show = async () => { setBusy(true); try { setFull(await revealHuntPhones(contactKey)); } catch (e) { toast(hiringError(e), { error: true }); } setBusy(false); };
  if (full) return <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{full.map((p) => <a key={p} href={`tel:+${p.replace(/\D/g, "")}`}>+{p.replace(/\D/g, "")}</a>)}</div>;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="hr-muted">{masked.join(", ") || "—"}</span>
      <button className="hr-btn xs" disabled={busy} onClick={() => void show()} title="Перегляд записується в журнал">Показати</button>
    </div>
  );
}

function RadarCard({ row, toast, onClose, onAdded, onOpenFunnel }: { row: HuntRadarRow; toast: Toast; onClose: () => void; onAdded: () => void; onOpenFunnel: (id: number) => void }) {
  const [act, setAct] = useState<{ days: { d: string; n: number }[]; top: { dir: string; n: number }[] } | null>(null);
  const [interest, setInterest] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAct(null); fetchHuntActivity(row.key).then(setAct).catch(() => setAct({ days: [], top: [] })); }, [row.key]);
  const last7 = useMemo(() => {
    const m = new Map((act?.days ?? []).map((x) => [x.d, x.n]));
    return Array.from({ length: 7 }, (_, i) => { const dt = new Date(Date.now() - (6 - i) * 86_400_000); const k = dt.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }); return { k, n: m.get(k) ?? 0 }; });
  }, [act]);
  const max = Math.max(1, ...last7.map((x) => x.n));
  const add = async () => {
    setBusy(true);
    try { await addHuntCandidate(row.key, interest.trim()); toast(`${row.face} — у воронці, етап «Обрано»`); onAdded(); }
    catch (e) { toast(hiringError(e), { error: true }); setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <aside className="hunt-drawer" role="dialog" aria-label={`Контакт ${row.face}`} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div><h3 style={{ margin: 0 }}>{row.face}</h3><div className="hr-muted">{row.company}</div></div>
          <button className="hr-btn xs" onClick={onClose}>Закрити</button>
        </div>
        <div><div className="hunt-lbl">Телефон</div><PhoneReveal contactKey={row.key} masked={row.phones} toast={toast} /></div>
        <div>
          <div className="hunt-lbl">Активність за 7 днів</div>
          <div className="hunt-bars">{last7.map((x) => <div key={x.k} title={`${x.k}: ${x.n}`}><i style={{ height: `${(x.n / max) * 100}%` }} /><span>{x.k.slice(8)}</span></div>)}</div>
          <div className="hr-muted" style={{ fontSize: 12 }}>День {row.d1} · 7 дн. {row.d7} · 30 дн. {row.d30} · вантаж {row.cargo} / транспорт {row.lorry} · з ціною {row.pricePct}%</div>
        </div>
        <div><div className="hunt-lbl">Напрямки</div>{(act?.top ?? row.top).map((t) => <div key={t.dir} style={{ fontSize: 13 }}>{t.dir} <span className="hr-muted">· {t.n}</span></div>)}</div>
        <div className="hr-muted" style={{ fontSize: 12 }}>Години публікації не показуємо: архів бачить заявку лише в момент скану (раз на 3 год), а не публікації.</div>
        {row.candidate ? (
          <button className="hr-btn p" onClick={() => onOpenFunnel(row.candidate!.id)}>Відкрити у воронці · {STAGE_LABEL[row.candidate.stage]}</button>
        ) : (
          <>
            <label className="hunt-lbl" htmlFor="hunt-interest">Чим зацікавив</label>
            <textarea id="hunt-interest" className="hr-inp" rows={3} value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="напр.: стабільно 60+ заявок на тиждень по Києву, працює з рефом" />
            <button className="hr-btn p" disabled={busy} onClick={() => void add()}>Додати у воронку</button>
          </>
        )}
      </aside>
    </div>, document.body);
}

/* ─────────────────────────── Воронка ─────────────────────────── */

function Funnel({ toast, nonce, openId, onOpen, onChanged }: { toast: Toast; nonce: number; openId: number | null; onOpen: (id: number | null) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<HuntCandidateRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const load = useCallback(() => { fetchHuntCandidates({ q, archived }).then((r) => { setRows(r.rows); setErr(null); }).catch((e) => setErr(hiringError(e))); }, [q, archived]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q, nonce]);
  const isOverdue = (r: HuntCandidateRow) => !!r.next_step_at && new Date(r.next_step_at).getTime() < Date.now();
  const shown = (rows ?? []).filter((r) => !overdue || isOverdue(r));
  const move = async (id: number, to: HuntStage) => {
    try { await moveHuntCandidate(id, to); load(); onChanged(); } catch (e) { toast(hiringError(e), { error: true }); }
  };
  return (
    <>
      <div className="page-filters" style={{ marginBottom: 12, alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input className="hr-inp" placeholder="Пошук: імʼя, компанія, телефон" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px" }} aria-label="Пошук у воронці" />
        <div className="hr-seg2">
          <button className={!archived ? "on" : ""} onClick={() => setArchived(false)}>Воронка</button>
          <button className={archived ? "on" : ""} onClick={() => setArchived(true)}>Відмова / архів</button>
        </div>
        {!archived && <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />Прострочені</label>}
      </div>
      {err ? <div className="chart-card"><b>Воронка недоступна.</b> <span className="hr-muted">{err}</span></div> : !rows ? <p className="loading-text">Завантаження…</p> : archived ? (
        <div className="chart-card">
          {shown.length === 0 ? <div className="hr-muted">У відмові нікого.</div> : (
            <table className="data-table compact" style={{ width: "100%" }}>
              <thead><tr><th>Кандидат</th><th>Компанія</th><th>Причина</th><th>Коли</th></tr></thead>
              <tbody>{shown.map((r) => <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.id)}><td><b>{r.full_name}</b></td><td>{r.company ?? "—"}</td><td>{REASONS.find(([k]) => k === r.reject_reason)?.[1] ?? "—"}</td><td>{dmy(r.stage_changed_at)}</td></tr>)}</tbody>
            </table>)}
        </div>
      ) : (
        <div className="hunt-board">
          {STAGES.map(([st, label], si) => {
            const col = shown.filter((r) => r.stage === st);
            return (
              <div key={st} className={`hunt-col ${drag != null ? "drop" : ""}`} onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (drag != null) { const r = rows.find((x) => x.id === drag); if (r && r.stage !== st) void move(drag, st); } setDrag(null); }}>
                <div className="hunt-col-h">{label} <span>{col.length}</span></div>
                {col.map((r) => (
                  <div key={r.id} className={`hunt-card ${isOverdue(r) ? "late" : ""}`} draggable onDragStart={() => setDrag(r.id)} onDragEnd={() => setDrag(null)} onClick={() => onOpen(r.id)}>
                    <b>{r.full_name}</b>
                    <div className="hr-muted" style={{ fontSize: 12 }}>{r.company ?? "компанія невідома"}</div>
                    {(r.last_comment || r.interest) && <div style={{ fontSize: 12, marginTop: 4 }}>{(r.last_comment || r.interest)!.slice(0, 90)}</div>}
                    <div className="hunt-card-f">
                      <span className={isOverdue(r) ? "late-t" : "hr-muted"}>{r.next_step ? `${r.next_step}${r.next_step_at ? ` · ${dmy(r.next_step_at)}` : ""}` : "крок не заплановано"}</span>
                      <span className="hr-muted">{daysSince(r.stage_changed_at)} дн.</span>
                    </div>
                    {si < STAGES.length - 1 && <button className="hr-btn xs" onClick={(e) => { e.stopPropagation(); void move(r.id, STAGES[si + 1][0]); }}>Далі: {STAGES[si + 1][1]}</button>}
                  </div>))}
                {!col.length && <div className="hr-muted" style={{ fontSize: 12, padding: 6 }}>порожньо</div>}
              </div>);
          })}
        </div>
      )}
      {openId != null && <CandidateCard id={openId} toast={toast} onClose={() => onOpen(null)} onChanged={() => { load(); onChanged(); }} />}
    </>
  );
}

function CandidateCard({ id, toast, onClose, onChanged }: { id: number; toast: Toast; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<HuntCandidate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [remind, setRemind] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetchHuntCandidate(id).then((x) => {
      setC(x); setErr(null);
      setForm({ fullName: x.full_name, position: x.position ?? "", specialization: x.specialization ?? "", salaryExpectation: x.salary_expectation ?? "",
        nextStep: x.next_step ?? "", nextStepAt: toLocalInput(x.next_step_at), interviewAt: toLocalInput(x.interview_at), interest: x.interest ?? "" });
    }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); load(); onChanged(); } catch (e) { toast(hiringError(e), { error: true }); }
    setBusy(false);
  };
  const save = () => run(() => updateHuntCandidate(id, Object.fromEntries(Object.entries(form).map(([k, v]) =>
    [k, (k === "nextStepAt" || k === "interviewAt") ? (v ? new Date(v).toISOString() : null) : (v.trim() || null)]))), "Збережено");
  const field = (k: string, label: string, type = "text") => (
    <label key={k}><span>{label}</span><input className="hr-inp" type={type} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>);
  const stageIdx = c ? STAGES.findIndex(([k]) => k === c.stage) : -1;
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <aside className="hunt-drawer wide" role="dialog" aria-label="Картка кандидата" onClick={(e) => e.stopPropagation()}>
        {err ? <div><b>Картка недоступна.</b> <span className="hr-muted">{err}</span> <button className="hr-btn xs" onClick={onClose}>Закрити</button></div> : !c ? <p className="loading-text">Завантаження…</p> : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div><h3 style={{ margin: 0 }}>{c.full_name}</h3><div className="hr-muted">{c.company ?? "компанія невідома"} · у воронці з {dmy(c.created_at)}</div></div>
              <button className="hr-btn xs" onClick={onClose}>Закрити</button>
            </div>
            <div className="hunt-steps">
              {STAGES.map(([k, l], i) => (
                <button key={k} className={`${i <= stageIdx ? "done" : ""} ${k === c.stage ? "cur" : ""}`} disabled={busy || c.stage === k}
                  onClick={() => void run(() => moveHuntCandidate(id, k), `Етап: ${l}`)}>{l}</button>))}
            </div>
            {c.stage === "rejected" && <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>Відмова: {REASONS.find(([k]) => k === c.reject_reason)?.[1] ?? "—"}. Натисніть етап вище, щоб повернути у воронку.</div>}
            <div><div className="hunt-lbl">Телефон</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{c.phones.map((p) => <a key={p} className="hr-btn xs" href={`tel:+${p.replace(/\D/g, "")}`}>📞 +{p.replace(/\D/g, "")}</a>)}{!c.phones.length && <span className="hr-muted">номера немає</span>}</div>
            </div>
            <div className="hr-muted" style={{ fontSize: 12 }}>
              Джерело: Ларді{c.source?.d30 != null ? ` · на момент додавання ${c.source.d7 ?? 0} заявок за 7 дн., ${c.source.d30} за 30 дн.` : ""}
              {c.source?.top?.length ? ` · ${c.source.top.map((t) => t.dir).join("; ")}` : ""}
            </div>
            <div className="emp-form" style={{ marginTop: 0 }}>
              {field("fullName", "ПІБ")}{field("position", "Посада")}{field("specialization", "Спеціалізація")}{field("salaryExpectation", "Очікування щодо з/п")}
              {field("interviewAt", "Співбесіда", "datetime-local")}{field("nextStep", "Наступний крок")}{field("nextStepAt", "Коли", "datetime-local")}
              <label className="wide"><span>Чим зацікавив</span><textarea className="hr-inp" rows={2} value={form.interest ?? ""} onChange={(e) => setForm({ ...form, interest: e.target.value })} /></label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="hr-btn p" disabled={busy} onClick={() => void save()}>Зберегти</button></div>
            <div className="hunt-comment">
              <textarea className="hr-inp" rows={2} placeholder="Коментар: як пройшла розмова, що далі" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Новий коментар" />
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontSize: 12.5 }} className="hr-muted">Нагадати <input className="hr-inp" type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} /></label>
                <button className="hr-btn p" disabled={busy || !comment.trim()} onClick={() => void run(async () => { await commentHuntCandidate(id, comment.trim(), remind ? new Date(remind).toISOString() : null); setComment(""); setRemind(""); }, "Коментар додано")}>Додати коментар</button>
              </div>
            </div>
            <div className="hunt-timeline">
              {c.timeline.map((t) => (
                <div key={`${t.kind}${t.id}`} className={t.kind}>
                  <div className="hr-muted" style={{ fontSize: 12 }}>{dmyhm(t.at)} · {t.who ?? "—"}</div>
                  {t.kind === "comment" ? <div>{t.text}{t.remind_at && <span className="emp-pill warn" style={{ marginLeft: 6 }}>нагадати {dmyhm(t.remind_at)}</span>}</div>
                    : <div>Етап: {t.from_stage ? `${STAGE_LABEL[t.from_stage] ?? t.from_stage} → ` : ""}<b>{STAGE_LABEL[t.to_stage ?? ""] ?? t.to_stage}</b>{t.reason ? ` (${REASONS.find(([k]) => k === t.reason)?.[1] ?? t.reason})` : ""}</div>}
                </div>))}
            </div>
            {c.stage !== "rejected" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <select className="hr-inp" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Причина відмови">
                  <option value="">Причина відмови…</option>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <button className="hr-btn" disabled={busy || !reason} onClick={() => void run(() => moveHuntCandidate(id, "rejected", reason), "Перенесено у відмову")}>У відмову</button>
              </div>)}
          </>
        )}
      </aside>
    </div>, document.body);
}
