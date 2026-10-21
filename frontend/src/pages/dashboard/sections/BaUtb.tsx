import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchBaUtb, fetchBaUtbCard, fetchBaUtbManagers, createBaUtb, updateBaUtb, uploadBaFile, downloadBaUtbXlsx, hiringError,
  type BaMeta, type BaUtbRow, type BaUtbCard, type BaUtbFilter, type BaUtbStatus, type BaUtbDocs,
} from "../../../api";
import { money, fmtDate, todayKyiv, useEscape, Docs, History, type Toast } from "./BaShared";

/**
 * 🚛 «РЕЄСТР УКРТРАНСБЕЗПЕКИ» (задача 6269, ТЗ Даші 19.10.2026) — пʼята вкладка «Бізнес-асистента». Вигляд — як
 * «Судовий реєстр»: таблиця, фільтри, картка-шухляда з документами й історією. Веде власник реєстру (`access = edit`),
 * адміни й операційний директор лише бачать (`view`): кнопок запису в них немає, а сервер однаково відмовить (`utbGate`).
 * Що можна і чого бракує для статусу — вирішує сервер (`core/baUtbRules.ts`), тут лише показ його відповіді.
 */
const TONE: Record<BaUtbStatus, string> = { new: "gr", collecting: "wn", handed: "pl", transferred: "ok", rejected: "dg" };
const EMPTY: BaUtbFilter = { q: "", carrier: "", managerId: "", status: "", from: "", to: "" };
/** ТЗ: «запис без заявки або ТТН підсвічується». */
const lacksDocs = (d: BaUtbDocs) => !d.request || !d.ttn;
function docsText(d: BaUtbDocs): string {
  const miss = [!d.decision && "постанова", !d.request && "заявка", !d.ttn && "ТТН"].filter(Boolean);
  return miss.length ? `бракує: ${miss.join(", ")}` : "повний комплект";
}

export function BaUtb({ meta, access, toast }: { meta: BaMeta; access: "edit" | "view"; toast: Toast }) {
  const canEdit = access === "edit";
  const [filter, setFilter] = useState<BaUtbFilter>(EMPTY);
  const [rows, setRows] = useState<BaUtbRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [managers, setManagers] = useState<{ id: number; name: string }[]>([]);
  const [open, setOpen] = useState<number | "new" | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);

  useEffect(() => { fetchBaUtbManagers().then(setManagers).catch(() => setManagers([])); }, []);
  // Текстові поля — з паузою, щоб не смикати сервер на кожну літеру.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { fetchBaUtb(filter).then((r) => { if (alive) { setRows(r); setErr(null); } }).catch((e) => { if (alive) setErr(hiringError(e)); }); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [filter, nonce]);

  const set = (k: keyof BaUtbFilter) => (e: { target: { value: string } }) => setFilter((f) => ({ ...f, [k]: e.target.value }));
  const exportXlsx = () => { downloadBaUtbXlsx(filter).catch((e) => toast(hiringError(e), { error: true })); };
  const total = rows?.reduce((s, r) => s + r.fineAmount, 0) ?? 0;

  return (
    <div className="hr-card">
      <div className="hd" style={{ flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input className="hr-inp" placeholder="Пошук за № ВП" value={filter.q} onChange={set("q")} aria-label="Пошук за № виконавчого провадження" style={{ width: 150 }} />
          <input className="hr-inp" placeholder="Перевізник" value={filter.carrier} onChange={set("carrier")} aria-label="Перевізник" style={{ width: 150 }} />
          <select className="hr-inp" value={filter.managerId} onChange={set("managerId")} aria-label="Відповідальний менеджер">
            <option value="">Усі менеджери</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select className="hr-inp" value={filter.status} onChange={set("status")} aria-label="Статус">
            <option value="">Усі статуси</option>
            {meta.utbStatuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <input className="hr-inp" type="date" value={filter.from} onChange={set("from")} aria-label="Надійшла з" />
          <span className="hr-muted">—</span>
          <input className="hr-inp" type="date" value={filter.to} onChange={set("to")} aria-label="Надійшла по" />
          {JSON.stringify(filter) !== JSON.stringify(EMPTY) && <button className="hr-btn xs" onClick={() => setFilter(EMPTY)}>Скинути</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="hr-btn" onClick={exportXlsx} disabled={!rows?.length}>⬇ Excel</button>
          {canEdit && <button className="hr-btn p" onClick={() => setOpen("new")}>+ Запис</button>}
        </div>
      </div>
      {err ? <div className="hr-sect"><span className="hr-muted">{err}</span></div> : !rows ? <p className="loading-text">Завантаження…</p> : (
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>№ ВП</th><th>Надійшла</th><th>Перевізник</th><th className="num">Сума штрафу</th><th>Менеджер</th><th>Відповідальна особа</th><th>Статус</th><th>Документи</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row" tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.id); }}
                  style={lacksDocs(r.docs) && r.status !== "rejected" ? { background: "rgba(220,38,38,.06)" } : undefined}>
                  <td><b>{r.epNumber}</b></td>
                  <td>{fmtDate(r.receivedOn)}</td>
                  <td>{r.carrier}</td>
                  <td className="num">{money(r.fineAmount)}</td>
                  <td>{r.managerName ?? <span className="hr-muted">не призначено</span>}</td>
                  <td>{r.handlerName ?? <span className="hr-muted">—</span>}</td>
                  <td><span className={`hr-pill ${TONE[r.status]}`}>{r.statusLabel}</span></td>
                  <td title={docsText(r.docs)}>{lacksDocs(r.docs)
                    ? <span style={{ color: "var(--danger)" }}>⚠ {docsText(r.docs)}</span>
                    : <span style={{ color: "var(--ok, #15803d)" }}>✓ {docsText(r.docs)}</span>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} className="hr-muted" style={{ padding: 16 }}>
                {JSON.stringify(filter) !== JSON.stringify(EMPTY) ? "За цим фільтром записів немає." : `Записів ще немає.${canEdit ? " Нова постанова Укртрансбезпеки — кнопка «+ Запис»." : ""}`}
              </td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="hr-sect hr-muted">
        {rows?.length ? `Записів: ${String(rows.length)} · сума штрафів ${money(total)}. ` : ""}
        Червоним підсвічено записи без заявки або ТТН. «Передано» можна поставити лише з постановою, заявкою й ТТН.
        {!canEdit && " Реєстр веде власник — у вас перегляд."}
      </div>
      {open != null && <UtbDrawer meta={meta} id={open} canEdit={canEdit} managers={managers} toast={toast}
        onClose={() => setOpen(null)} onChanged={refresh} onCreated={(id) => setOpen(id)} />}
    </div>
  );
}

type Form = { epNumber: string; receivedOn: string; carrier: string; fineAmount: string; managerId: string; handlerId: string; ttnNumber: string; comment: string; status: BaUtbStatus };

function UtbDrawer({ meta, id, canEdit, managers, toast, onClose, onChanged, onCreated }: {
  meta: BaMeta; id: number | "new"; canEdit: boolean; managers: { id: number; name: string }[]; toast: Toast;
  onClose: () => void; onChanged: () => void; onCreated: (id: number) => void;
}) {
  const [card, setCard] = useState<BaUtbCard | null>(null);
  const [form, setForm] = useState<Form>({ epNumber: "", receivedOn: todayKyiv(), carrier: "", fineAmount: "", managerId: "", handlerId: "", ttnNumber: "", comment: "", status: "new" });
  const [decision, setDecision] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (id === "new") return;
    fetchBaUtbCard(id).then((k) => {
      setCard(k);
      setForm({ epNumber: k.epNumber, receivedOn: k.receivedOn, carrier: k.carrier, fineAmount: String(k.fineAmount),
        managerId: k.managerId == null ? "" : String(k.managerId), handlerId: k.handlerId == null ? "" : String(k.handlerId),
        ttnNumber: k.ttnNumber, comment: k.comment, status: k.status });
    }).catch((e) => setErr(hiringError(e)));
  }, [id]);
  useEffect(load, [load]);
  useEscape(onClose);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const body = () => ({ epNumber: form.epNumber, receivedOn: form.receivedOn, carrier: form.carrier, fineAmount: form.fineAmount,
    managerId: form.managerId ? Number(form.managerId) : null, handlerId: form.handlerId ? Number(form.handlerId) : null,
    ttnNumber: form.ttnNumber, comment: form.comment });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (id === "new") {
        // ТЗ, крок 1: запис створюється разом із файлом заяви / постанови.
        if (!decision) { setErr("Додайте файл заяви / постанови УТБ"); return; }
        if (decision.size > meta.fileMaxBytes) { setErr("Файл більший за 10 МБ"); return; }
        const nid = await createBaUtb(body());
        try { await uploadBaFile("utb", nid, decision, "utb_decision"); }
        catch (e) { toast(`Запис створено, але файл постанови не додався: ${hiringError(e)}. Додайте його в картці.`, { error: true }); }
        onChanged(); onCreated(nid); toast("Запис створено");
      } else {
        await updateBaUtb(id, { ...body(), status: form.status }); onChanged(); load(); toast("Збережено");
      }
    } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };

  const loading = id !== "new" && !card && !err;
  const mgrSelect = (k: "managerId" | "handlerId", label: string) => (
    <select className="hr-inp" value={form[k]} onChange={set(k)} disabled={!canEdit} aria-label={label}>
      <option value="">— не призначено —</option>
      {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      {/* Звільнений після призначення — лишається видимим у своєму записі, а не зникає з поля. */}
      {form[k] && !managers.some((m) => String(m.id) === form[k]) && <option value={form[k]}>{(k === "managerId" ? card?.managerName : card?.handlerName) ?? `#${form[k]}`}</option>}
    </select>
  );
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <aside className="hr-drawer" role="dialog" aria-label="Запис реєстру Укртрансбезпеки" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
          <div>
            <div className="hr-muted">Реєстр Укртрансбезпеки{canEdit ? "" : " · перегляд"}</div>
            <h2 style={{ margin: "2px 0 12px", fontSize: 19 }}>{id === "new" ? "Нова постанова" : `ВП № ${card?.epNumber ?? "…"}`}</h2>
          </div>
          <button className="hr-btn xs" onClick={onClose} aria-label="Закрити картку">×</button>
        </div>
        {loading ? <p className="loading-text">Завантаження…</p> : (<>
          {card && lacksDocs(card.docs) && card.status !== "rejected" && <div className="hr-note" style={{ background: "var(--danger-bg, rgba(220,38,38,.08))", color: "var(--danger)", marginTop: 0, marginBottom: 10 }}>
            Документи неповні — {docsText(card.docs)}. Без них запис не можна передати відповідальній особі.</div>}
          <div className="hr-kv">
            <span className="k">№ виконавчого провадження *</span><input className="hr-inp" value={form.epNumber} onChange={set("epNumber")} disabled={!canEdit} />
            <span className="k">Дата надходження заяви *</span><input className="hr-inp" type="date" value={form.receivedOn} onChange={set("receivedOn")} disabled={!canEdit} />
            <span className="k">Перевізник *</span><input className="hr-inp" placeholder="На кого переводимо штраф" value={form.carrier} onChange={set("carrier")} disabled={!canEdit} />
            <span className="k">Сума штрафу, грн *</span><input className="hr-inp" inputMode="decimal" value={form.fineAmount} onChange={set("fineAmount")} disabled={!canEdit} />
            <span className="k">Відповідальний менеджер</span>{mgrSelect("managerId", "Відповідальний менеджер")}
            <span className="k">№ ТТН</span><input className="hr-inp" value={form.ttnNumber} onChange={set("ttnNumber")} disabled={!canEdit} />
            <span className="k">Відповідальна особа</span>{mgrSelect("handlerId", "Відповідальна особа")}
            {id !== "new" && <>
              <span className="k">Статус</span>
              <select className="hr-inp" value={form.status} onChange={set("status")} disabled={!canEdit}>
                {meta.utbStatuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </>}
            <span className="k">Коментар</span><textarea className="hr-inp" rows={3} value={form.comment} onChange={set("comment")} disabled={!canEdit}
              placeholder={form.status === "rejected" ? "Обовʼязково: чому штраф не переведено" : ""} />
            {id === "new" && <>
              <span className="k">Заява / постанова УТБ *</span>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx" onChange={(e) => setDecision(e.target.files?.[0] ?? null)} aria-label="Файл заяви / постанови УТБ" />
            </>}
          </div>
          {id === "new" && <p className="hr-muted" style={{ margin: "8px 0 0" }}>Менеджер отримає задачу передати заявку і ТТН, щойно його буде призначено. Заявку, ТТН та інші документи додасте в картці.</p>}
          {err && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
            <button className="hr-btn" onClick={onClose}>{canEdit ? "Скасувати" : "Закрити"}</button>
            {canEdit && <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{id === "new" ? "Створити" : "Зберегти"}</button>}
          </div>
          {card && <>
            <Docs kind="utb" ownerId={card.id} files={card.fileList} types={meta.utbDocTypes} maxBytes={meta.fileMaxBytes} toast={toast} onAdded={() => { load(); onChanged(); }} readOnly={!canEdit} />
            <History events={card.events} />
          </>}
        </>)}
      </aside>
    </div>, document.body);
}
