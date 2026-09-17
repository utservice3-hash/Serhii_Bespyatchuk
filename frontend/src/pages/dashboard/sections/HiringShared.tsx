import { useState } from "react";
import { createPortal } from "react-dom";
import { hiringError, setHiringStatus, type HiringMeta, type HiringStatus } from "../../../api";
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
