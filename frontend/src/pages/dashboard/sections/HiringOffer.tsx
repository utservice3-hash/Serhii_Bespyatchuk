import { useCallback, useEffect, useState } from "react";
import {
  fetchOfferTemplates, uploadOfferTemplate, setOfferTemplateActive, fetchCandidateOffer, generateCandidateOffer, hiringError,
  type OfferTemplate, type OfferInfo, type OfferStateKind,
} from "../../../api";
import type { Toast } from "./HiringShared";

/**
 * 📄 ОФЕР ІЗ ШАБЛОНУ (18.09.2026, етап 3). Шаблон — Word-файл із мітками {{ПІБ}}, {{Посада}}, {{Ставка}}…
 * Офер лягає в «Документи → Офери» на імʼя кандидата; підпис і нагадування — там само. Стан оферу
 * тут лише показується: його рахує сервер із документа й підпису.
 */

export const OFFER_STATE: Record<OfferStateKind, [string, string]> = {
  none: ["офер не надіслано", "mute"], pending: ["офер надіслано, чекає підпису", "info"], overdue: ["офер не підписано понад 7 днів", "warn"],
  review: ["підпис фото — чекає перевірки", "warn"], signed: ["офер підписано", "ok"], outdated: ["офер змінено — потрібен новий підпис", "warn"],
  not_required: ["—", "mute"],
};

/** Блок у картці кандидата. Лише для HR/керівництва: тімліду сервер відповідає 403 — і блок ховається. */
export function OfferBox({ candidateId, status, toast, onChanged }: { candidateId: number; status: string; toast: Toast; onChanged?: () => void }) {
  const [info, setInfo] = useState<OfferInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [templates, setTemplates] = useState<OfferTemplate[]>([]);
  const [tpl, setTpl] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback((templateId?: number) => {
    fetchCandidateOffer(candidateId, templateId).then((r) => {
      setInfo(r);
      if (r.form) setValues(Object.fromEntries(r.form.fields.map((f) => [f.marker, f.value ?? ""])));
    }).catch((e) => { if ((e as { response?: { status?: number } }).response?.status === 403) setHidden(true); else setMsg(hiringError(e)); });
  }, [candidateId]);
  useEffect(() => { load(); fetchOfferTemplates().then((t) => setTemplates(t.filter((x) => x.is_active))).catch(() => setTemplates([])); }, [load]);
  if (hidden || !info) return null;
  const st = OFFER_STATE[info.state.state] ?? OFFER_STATE.none;
  const allowed = status === "candidate" || status === "training";
  const pick = (id: string) => { const n = Number(id) || null; setTpl(n); setMsg(null); if (n) load(n); };
  const make = async () => {
    if (!tpl) return;
    setBusy(true); setMsg(null);
    try {
      const r = await generateCandidateOffer(candidateId, tpl, values);
      toast(r.version === 1 ? "Офер сформовано й надіслано кандидату в «Документи»" : `Офер оновлено (версія ${r.version}) — кандидату треба підписати заново`);
      setTpl(null); load(); onChanged?.();
    } catch (e) {
      const fields = (e as { response?: { data?: { fields?: string[] } } }).response?.data?.fields;
      setMsg(fields?.length ? `Заповніть: ${fields.join(", ")}` : hiringError(e));
    }
    setBusy(false);
  };
  return (
    <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
      <h4>Офер</h4>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span className={`emp-pill ${st[1]}`}>{st[0]}</span>
        {info.state.docId && <a className="hr-link" href={`/documents?doc=${info.state.docId}`}>{info.state.name} · версія {info.state.version} ↗</a>}
      </div>
      {!allowed ? <div className="hr-muted">Офер формується на статусі «кандидат + команда» або «на навчанні».</div>
        : templates.length === 0 ? <div className="hr-muted">Шаблонів ще немає — додайте Word-файл у вкладці «Шаблони».</div> : (
          <>
            <select className="hr-inp" value={tpl ?? ""} onChange={(e) => pick(e.target.value)} aria-label="Шаблон оферу">
              <option value="">{info.state.docId ? "Сформувати нову версію з шаблону…" : "Сформувати офер з шаблону…"}</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            {tpl && info.form && (
              <div className="emp-form" style={{ marginTop: 10 }}>
                {info.form.fields.map((f) => (
                  <label key={f.marker}>
                    <span>{f.marker}{f.auto ? <span className="hr-muted"> · з картки</span> : <b style={{ color: "var(--warn)" }}> · дописати</b>}</span>
                    <input className="hr-inp" value={values[f.marker] ?? ""} onChange={(e) => setValues({ ...values, [f.marker]: e.target.value })} />
                  </label>
                ))}
                <div className="wide" style={{ display: "flex", gap: 8, justifyContent: "flex-end", gridColumn: "1 / -1" }}>
                  <button className="hr-btn" onClick={() => setTpl(null)}>Скасувати</button>
                  <button className="hr-btn p" disabled={busy} onClick={() => void make()}>{busy ? "Формую…" : info.state.docId ? "Сформувати нову версію" : "Сформувати й надіслати"}</button>
                </div>
              </div>
            )}
          </>
        )}
      {msg && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

/** Вкладка «Шаблони»: Word-файли оферів і які мітки в них знайдено. */
export function OfferTemplatesTab({ toast }: { toast: Toast }) {
  const [rows, setRows] = useState<OfferTemplate[] | null>(null);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { fetchOfferTemplates().then(setRows).catch((e) => setErr(hiringError(e))); }, []);
  useEffect(load, [load]);
  const upload = async () => {
    if (!file || !title.trim()) return;
    setBusy(true); setErr(null);
    try {
      const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(r.error); r.readAsDataURL(file); });
      const r = await uploadOfferTemplate(title.trim(), data);
      toast(`Шаблон додано — міток: ${r.markers.length}`); setTitle(""); setFile(null); load();
    } catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };
  if (!rows && !err) return <p className="loading-text">Завантаження…</p>;
  return (
    <>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="chart-title">Новий шаблон оферу</div>
        <div className="hr-muted" style={{ marginBottom: 10, fontSize: 13 }}>
          Відкрийте офер у Word і замість даних кандидата впишіть мітки у фігурних дужках: <b>{"{{ПІБ}}"}</b>, <b>{"{{Посада}}"}</b>, <b>{"{{Команда}}"}</b>,
          {" "}<b>{"{{Тімлід}}"}</b>, <b>{"{{Дата}}"}</b>, <b>{"{{Телефон}}"}</b>, <b>{"{{Пошта}}"}</b> дашборд заповнить сам. Будь-яку іншу мітку
          (напр. <b>{"{{Ставка}}"}</b>, <b>{"{{Дата старту}}"}</b>) HR дописує перед формуванням. Збережіть як .docx і завантажте сюди.
        </div>
        <div className="page-filters">
          <input className="hr-inp" placeholder="Назва: напр. «Офер РПК»" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Назва шаблону" style={{ minWidth: 220 }} />
          <label className="hr-btn" style={{ cursor: "pointer" }}>
            {file ? file.name : "Обрати .docx…"}
            <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button className="hr-btn p" disabled={busy || !file || !title.trim()} onClick={() => void upload()}>{busy ? "Завантажую…" : "Додати шаблон"}</button>
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
      </div>
      <div className="chart-card">
        <div className="chart-title">Шаблони</div>
        {!rows?.length ? <div className="hr-muted">Шаблонів ще немає.</div> : (
          <table className="data-table compact" style={{ width: "100%" }}>
            <thead><tr><th>Назва</th><th>Поля</th><th>Додав</th><th></th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} style={t.is_active ? undefined : { opacity: 0.55 }}>
                  <td><b>{t.title}</b>{!t.is_active && <span className="emp-pill mute">вимкнено</span>}</td>
                  <td>{t.fields.map((f) => <span key={f.marker} className={`emp-pill ${f.auto ? "ok" : "warn"}`} title={f.auto ? "заповнюється з картки" : "HR дописує"}>{f.marker}</span>)}</td>
                  <td className="hr-muted">{t.author ?? "—"}</td>
                  <td><button className="hr-btn xs" onClick={() => void setOfferTemplateActive(t.id, !t.is_active).then(load)}>{t.is_active ? "Вимкнути" : "Увімкнути"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
