import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  createEmployee, matchEmployeeFiles, uploadEmployeeDoc, hiringError, HR_DOC_KINDS,
  type EmployeeRow, type EmployeeFileMatch, type NewEmployee,
} from "../../../api";

/**
 * 👤 «+ СПІВРОБІТНИК» і 📎 «ДОКУМЕНТИ ПАКЕТОМ» (22.09.2026, питання Івана). Правила — на сервері
 * (`backend/src/core/employeeAdd.ts`): хто вже є в реєстрі, і чий файл за ПІБ у назві. Екран лише показує
 * результат і дає виправити руками те, що сервер не впізнав. Кандидат, що став «Менеджер», потрапляє в
 * реєстр сам — ця форма для тих, хто прийшов не через «Найм».
 */
const todayKyiv = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export function AddEmployeeDialog({ teams, onClose, onDone, onOpenExisting }: {
  teams: string[]; onClose: () => void; onDone: (id: number, name: string) => void; onOpenExisting: (id: number) => void;
}) {
  const [p, setP] = useState<Required<NewEmployee>>({ full_name: "", position: "", team_label: "", phone: "", email: "", telegram: "", hired_at: todayKyiv(), birth_date: "" });
  const [err, setErr] = useState<string | null>(null);
  const [existing, setExisting] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (p.full_name.trim().split(/\s+/).length < 2) { setErr("Вкажіть прізвище та імʼя"); return; }
    setBusy(true); setErr(null); setExisting(null);
    try { onDone(await createEmployee(p), p.full_name.trim()); }
    catch (e) {
      const d = (e as { response?: { data?: { existingId?: number } } }).response?.data;
      setErr(hiringError(e)); if (d?.existingId) setExisting(d.existingId); setBusy(false);
    }
  };
  const f = (k: keyof NewEmployee, l: string, extra?: React.InputHTMLAttributes<HTMLInputElement>, wide = false) => (
    <label className={wide ? "wide" : ""}><span>{l}</span>
      <input className="hr-inp" value={p[k]} onChange={(e) => { setP({ ...p, [k]: e.target.value }); setErr(null); }} {...extra} /></label>
  );
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Новий співробітник" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 96vw)" }}>
        <h3 style={{ margin: "0 0 4px" }}>Новий співробітник</h3>
        <p className="hr-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Для тих, хто прийшов не через «Найм». Кандидат, якого перевели в «Менеджер», зʼявляється в реєстрі сам.
        </p>
        <div className="emp-form" style={{ marginTop: 0 }}>
          {f("full_name", "Прізвище Імʼя По батькові *", { autoFocus: true, placeholder: "Коваленко Олена Петрівна" }, true)}
          {f("position", "Посада", { placeholder: "менеджер з продажу" })}
          {f("team_label", "Команда", { list: "emp-add-teams" })}
          {f("phone", "Телефон", { placeholder: "0XX XXX XX XX" })}
          {f("email", "Пошта")}
          {f("telegram", "Telegram", { placeholder: "@нік" })}
          {f("hired_at", "Дата прийому", { type: "date" })}
          {f("birth_date", "Дата народження", { type: "date" })}
          <datalist id="emp-add-teams">{teams.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}
          {existing != null && <> <button className="hr-btn xs" onClick={() => onOpenExisting(existing)}>Відкрити картку</button></>}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{busy ? "Зберігаю…" : "Додати в реєстр"}</button>
        </div>
      </div>
    </div>, document.body);
}

type Row = EmployeeFileMatch & { pick: string; state: "wait" | "ok" | "err"; msg?: string };

/** Кілька файлів одразу: тип, файли → сервер розкладає за ПІБ у назві → виправити невпізнані → завантажити. */
export function BulkDocsDialog({ people, onClose, onDone }: { people: EmployeeRow[]; onClose: () => void; onDone: (n: number) => void }) {
  const [kind, setKind] = useState<string>("Офер");
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const sorted = useMemo(() => [...people].sort((a, b) => Number(a.status === "dismissed") - Number(b.status === "dismissed") || a.full_name.localeCompare(b.full_name, "uk")), [people]);
  const choose = async (list: FileList | null) => {
    const fs = Array.from(list ?? []); if (!fs.length) return;
    setErr(null); setBusy(true);
    try {
      const m = await matchEmployeeFiles(fs.map((f) => f.name));
      setFiles(fs); setRows(m.map((r) => ({ ...r, pick: r.employeeId != null ? String(r.employeeId) : "", state: "wait" })));
    } catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };
  const ready = rows?.filter((r) => r.pick && r.state !== "ok").length ?? 0;
  const upload = async () => {
    if (!rows) return;
    setBusy(true); let n = 0;
    const next = [...rows];
    for (let i = 0; i < next.length; i++) {
      const r = next[i]; if (!r.pick || r.state === "ok") continue;
      try { await uploadEmployeeDoc(Number(r.pick), files[i], kind); next[i] = { ...r, state: "ok" }; n++; }
      catch (e) { next[i] = { ...r, state: "err", msg: hiringError(e) }; }
      setRows([...next]);
    }
    setBusy(false);
    if (n && next.every((r) => r.state === "ok" || !r.pick)) onDone(n);
  };
  const unmatched = rows?.filter((r) => !r.pick).length ?? 0;
  return createPortal(
    <div className="hr-modal-back" onClick={busy ? undefined : onClose}>
      <div className="hr-modal" role="dialog" aria-label="Документи пакетом" onClick={(e) => e.stopPropagation()} style={{ width: "min(860px, 96vw)", maxHeight: "90vh", overflow: "auto" }}>
        <h3 style={{ margin: "0 0 4px" }}>Документи пакетом</h3>
        <p className="hr-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Оберіть тип і файли. Людину дашборд знаходить за прізвищем та імʼям у назві файла, наприклад «Офер Коваленко Олена.pdf».
          Кого не впізнав — оберіть вручну.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="hr-inp" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Тип документів">
            {HR_DOC_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          <label className="hr-btn p" style={{ cursor: "pointer" }}>{rows ? "Обрати інші файли" : "Обрати файли"}
            <input type="file" multiple hidden onChange={(e) => { void choose(e.target.files); e.target.value = ""; }} /></label>
          {rows && <span className="hr-muted" style={{ fontSize: 13 }}>файлів {rows.length} · впізнано {rows.length - unmatched}{unmatched ? <> · <b style={{ color: "var(--warn)" }}>треба обрати {unmatched}</b></> : ""}</span>}
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
        {rows && (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Файл</th><th>Людина</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ wordBreak: "break-word" }}>{r.file}
                    <div className="hr-muted" style={{ fontSize: 12 }}>{r.how === "name" ? "впізнано за ПІБ" : r.how === "ambiguous" ? `кілька людей з таким ПІБ (${r.candidates.length}) — оберіть` : "у назві немає ПІБ з реєстру — оберіть"}</div></td>
                  <td>
                    <select className="hr-inp" style={{ maxWidth: 300, ...(r.pick ? {} : { borderColor: "var(--warn)" }) }} value={r.pick} disabled={r.state === "ok" || busy}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pick: e.target.value, state: "wait", msg: undefined } : x)))}>
                      <option value="">— пропустити —</option>
                      {r.candidates.length > 1 && <optgroup label="Збіг за ПІБ">{r.candidates.map((id) => { const p = byId.get(id); return p ? <option key={id} value={id}>{p.full_name}{p.status === "dismissed" ? " (звільнений)" : ""}</option> : null; })}</optgroup>}
                      <optgroup label="Усі люди">{sorted.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.status === "dismissed" ? " (звільнений)" : ""}</option>)}</optgroup>
                    </select>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{r.state === "ok" ? <span className="emp-pill ok">завантажено</span> : r.state === "err" ? <span className="emp-pill warn" title={r.msg}>помилка</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" disabled={busy} onClick={onClose}>Закрити</button>
          <button className="hr-btn p" disabled={busy || !ready} onClick={() => void upload()}>{busy ? "Завантажую…" : `Завантажити ${ready}`}</button>
        </div>
      </div>
    </div>, document.body);
}
