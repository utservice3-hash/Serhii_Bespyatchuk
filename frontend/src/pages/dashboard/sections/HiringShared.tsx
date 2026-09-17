import { useState } from "react";
import { createPortal } from "react-dom";
import { hiringError, setHiringStatus, refuseHiringCandidate, addHiringRefusalReason, type HiringMeta, type HiringStatus, type HiringRefusalSide } from "../../../api";
import { NEEDS_TEAM, STATUS_TONE } from "../hiringView";

/** Спливаюче повідомлення розділу; `action` — наприклад, «Відновити» після видалення рядка. */
export type Toast = (text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }) => void;

export function StatusPill({ meta, status }: { meta: HiringMeta; status: HiringStatus | null }) {
  if (!status) return <span className="hr-muted">—</span>;
  const label = meta.statuses.find((x) => x.key === status)?.label ?? status;
  return <span className={`hr-pill ${STATUS_TONE[status]}`}>{label}</span>;
}

/**
 * Діалог зміни статусу: коментар обовʼязковий (затверджений макет), команда — коли статус
 * її вимагає. Помилку сервера показуємо текстом: мовчазний 400/403 — це «нічого не сталось»
 * для людини (борг 15 у CLAUDE.md).
 */
export function StatusDialog({ meta, candidateId, from, to, teamId, onClose, onDone, toast }: {
  meta: HiringMeta; candidateId: number; from: HiringStatus; to: HiringStatus; teamId: number | null;
  onClose: () => void; onDone: () => void; toast: Toast;
}) {
  const [comment, setComment] = useState("");
  const [team, setTeam] = useState<string>(teamId ? String(teamId) : meta.access === "lead" && meta.teamId ? String(meta.teamId) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = (s: HiringStatus) => meta.statuses.find((x) => x.key === s)?.label ?? s;
  const needsTeam = NEEDS_TEAM.includes(to);
  const submit = async () => {
    if (!comment.trim()) { setErr("Введіть коментар"); return; }
    if (needsTeam && !team) { setErr("Оберіть команду"); return; }
    setBusy(true); setErr(null);
    try {
      await setHiringStatus(candidateId, { to, comment: comment.trim(), teamId: team ? Number(team) : null });
      toast(`Статус: «${label(to)}»`);
      onDone();
    } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Зміна статусу" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>«{label(from)}» → «{label(to)}»</h3>
        <p className="hr-muted" style={{ margin: "0 0 12px" }}>Коментар потрапить в історію кандидата.</p>
        {needsTeam && (
          <label style={{ display: "block", marginBottom: 10, fontSize: 12, color: "var(--text-muted)" }}>До якої команди
            <select className="hr-inp" style={{ width: "100%", marginTop: 4 }} value={team} disabled={meta.access === "lead"} onChange={(e) => setTeam(e.target.value)}>
              <option value="">— оберіть —</option>
              {meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        <textarea className="hr-inp" autoFocus rows={3} style={{ width: "100%", boxSizing: "border-box" }} placeholder="Коментар (обовʼязково)"
          value={comment} onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void submit()}>Застосувати</button>
        </div>
      </div>
    </div>, document.body);
}

/**
 * Діалог відмови (прохід 1a, за Хурмою): вкладки «Усі / Відмова кандидата / Відмова компанії»,
 * пошук, довідник причин, «+ Нова причина», нотатка, «Додати в резерв», «У чорний список» (лише
 * відмова компанії). Без причини сервер відмову не приймає (#520) — фронт каже це до запиту.
 */
export function RefusalDialog({ meta, candidateId, candidateName, from, onClose, onDone, onReasonsChanged, toast }: {
  meta: HiringMeta; candidateId: number; candidateName: string; from: HiringStatus;
  onClose: () => void; onDone: () => void; onReasonsChanged: () => void; toast: Toast;
}) {
  const [side, setSide] = useState<"all" | HiringRefusalSide>("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [reserve, setReserve] = useState(false);
  const [blacklist, setBlacklist] = useState(false);
  const [extra, setExtra] = useState<{ id: number; side: HiringRefusalSide; label: string }[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [newSide, setNewSide] = useState<HiringRefusalSide>("candidate");
  const [newLabel, setNewLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = meta.access === "edit";
  const reasons = [...meta.refusalReasons, ...extra.filter((x) => !meta.refusalReasons.some((r) => r.id === x.id))];
  const shown = reasons.filter((r) => (side === "all" || r.side === side) && (!q || r.label.toLowerCase().includes(q.toLowerCase())));
  const pickedReason = reasons.find((r) => r.id === picked);
  const label = (s: HiringStatus) => meta.statuses.find((x) => x.key === s)?.label ?? s;
  const SIDE_LABEL: Record<HiringRefusalSide, string> = { candidate: "Відмова кандидата", company: "Відмова компанії" };

  const addReason = async () => {
    if (!newLabel.trim()) { setErr("Введіть назву причини"); return; }
    try {
      const id = await addHiringRefusalReason({ side: newSide, label: newLabel.trim() });
      setExtra((x) => [...x, { id, side: newSide, label: newLabel.trim() }]);
      setPicked(id); setNewOpen(false); setNewLabel(""); setErr(null); onReasonsChanged();
      toast("Причину додано в довідник");
    } catch (e) { setErr(hiringError(e)); }
  };
  const submit = async () => {
    if (!picked) { setErr("Оберіть причину відмови — без неї відмова не зберігається"); return; }
    setBusy(true); setErr(null);
    try {
      await refuseHiringCandidate(candidateId, { reasonId: picked, note: note.trim(), reserve, blacklist: blacklist && pickedReason?.side === "company" });
      toast(`Відмова збережена: ${pickedReason?.label ?? ""}${blacklist && pickedReason?.side === "company" ? " · чорний список" : ""}`);
      onDone();
    } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };

  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" style={{ maxWidth: 500 }} role="dialog" aria-label="Причина відмови" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 2px", fontSize: 16 }}>Виберіть причину відмови</h3>
        <div className="hr-muted" style={{ marginBottom: 10 }}>{candidateName || "ПІБ не вказано"} · {label(from)}</div>
        <input className="hr-inp" style={{ width: "100%", boxSizing: "border-box" }} placeholder="Пошук причини" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="hr-rtabs">
          {(["all", "candidate", "company"] as const).map((k) => (
            <button key={k} className={side === k ? "on" : ""} onClick={() => setSide(k)}>{k === "all" ? "Усі відмови" : SIDE_LABEL[k]}</button>
          ))}
        </div>
        <div className="hr-rlist">
          {(["candidate", "company"] as const).filter((sd) => side === "all" || side === sd).map((sd) => {
            const items = shown.filter((r) => r.side === sd);
            if (!items.length) return null;
            return (
              <div key={sd}>
                {side === "all" && <div className="hr-rgrp">{SIDE_LABEL[sd]}</div>}
                {items.map((r) => (
                  <label key={r.id} className={`hr-ropt ${picked === r.id ? "on" : ""}`}>
                    <input type="radio" name="hr-reason" checked={picked === r.id} onChange={() => { setPicked(r.id); setErr(null); if (r.side !== "company") setBlacklist(false); }} /> {r.label}
                  </label>
                ))}
              </div>
            );
          })}
          {!shown.length && <div className="hr-muted" style={{ padding: 8 }}>Нічого не знайдено</div>}
        </div>
        {edit && (newOpen ? (
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <select className="hr-inp" value={newSide} onChange={(e) => setNewSide(e.target.value as HiringRefusalSide)}>
              <option value="candidate">кандидата</option><option value="company">компанії</option>
            </select>
            <input className="hr-inp" style={{ flex: 1 }} autoFocus placeholder="Назва причини" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            <button className="hr-btn xs" onClick={() => void addReason()}>Зберегти</button>
          </div>
        ) : <button className="hr-link" style={{ marginTop: 8 }} onClick={() => { setNewOpen(true); setNewSide(side === "company" ? "company" : "candidate"); }}>+ Нова причина</button>)}
        <label style={{ display: "block", marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>Нотатка
          <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} placeholder="Що саме сказав кандидат або чому відмовили" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {edit && <label className="hr-chk2"><input type="checkbox" checked={reserve} onChange={(e) => setReserve(e.target.checked)} /> Додати в резерв <span className="hr-muted">— повернемось, якщо бракуватиме відгуків</span></label>}
        {edit && (
          <label className={`hr-chk2 ${pickedReason?.side === "company" ? "" : "dim"}`}>
            <input type="checkbox" disabled={pickedReason?.side !== "company"} checked={blacklist && pickedReason?.side === "company"} onChange={(e) => setBlacklist(e.target.checked)} /> У чорний список <span className="hr-muted">— лише для відмови компанії</span>
          </label>
        )}
        {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn dg" disabled={busy} onClick={() => void submit()}>Відмовити</button>
        </div>
      </div>
    </div>, document.body);
}
