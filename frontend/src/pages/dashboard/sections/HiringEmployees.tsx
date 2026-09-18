import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchEmployees, previewEmployeeImport, commitEmployeeImport, hiringError,
  type EmployeeRow, type ImportPreview,
} from "../../../api";
import type { Toast } from "./HiringShared";

/**
 * 🗂 «НАЙМ → СПІВРОБІТНИКИ» — реєстр і імпорт «UTS Співробітники УКР» (18.09.2026, задача №3898).
 *
 * Вкладку видно тим самим пʼятьом, що й «Доступи» (право `view_employee_secrets`): імпорт кладе
 * паролі в сейф. Таблицю читає СЕРВЕР: сюди приходять заголовки, лічильники й імена, але жодного
 * пароля чи номера картки — навіть у прев'ю. Колонку, схожу на пароль, сервер не пустить нікуди,
 * крім сейфу або «пропустити».
 */

const PLAIN: [string, string][] = [
  ["skip", "Пропустити"], ["full_name", "ПІБ"], ["last_name", "Прізвище"], ["first_name", "Імʼя"], ["middle_name", "По батькові"],
  ["position", "Посада"], ["team_label", "Команда / відділ"], ["phone", "Телефон"], ["email", "Пошта"], ["telegram", "Telegram"],
  ["birth_date", "Дата народження"], ["hired_at", "Дата прийому"], ["dismissed_at", "Дата звільнення"],
  ["dismiss_reason", "Причина звільнення"], ["note", "Примітка"], ["extra", "Зберегти як є"],
];
const SERVICES: [string, string][] = [
  ["kommo", "Kommo"], ["ringostat", "Ringostat"], ["trans_eu", "trans.eu"], ["lardi", "Lardi-Trans"],
  ["della", "Della"], ["yaware", "Yaware"], ["mail", "Пошта"], ["dashboard", "Дашборд"], ["other", "Інше"],
];
const SECRET: [string, string][] = [
  ["secret:card", "🔐 Сейф: картка"],
  ...SERVICES.map(([k, l]): [string, string] => [`secret:password:${k}`, `🔐 Сейф: пароль ${l}`]),
  ...SERVICES.filter(([k]) => k !== "other").map(([k, l]): [string, string] => [`secret:login:${k}`, `🔐 Сейф: логін ${l}`]),
];
const d = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : null);

export function HiringEmployees({ toast }: { toast: Toast }) {
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"active" | "dismissed" | "all">("active");
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => { fetchEmployees().then(setRows).catch((e) => setErr(hiringError(e))); }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => (rows ?? []).filter((r) => (view === "all" || r.status === view)
    && (!q.trim() || `${r.full_name} ${r.position ?? ""} ${r.team_label ?? ""} ${r.phone ?? ""} ${r.email ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))), [rows, q, view]);
  if (err) return <div className="hr-card"><div className="hr-sect" style={{ border: 0 }}><b>Реєстр недоступний.</b> <span className="hr-muted">{err}</span></div></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const active = rows.filter((r) => r.status === "active");
  const noAccount = active.filter((r) => r.user_id == null).length;

  return (
    <>
      <div className="hr-card">
        <div className="hd">
          <div><h3>Співробітники</h3><div className="hr-muted">Реєстр людей компанії — з акаунтом дашборда чи без. Паролі й картки — у «Доступах», тут лише скільки їх.</div></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="hr-inp" placeholder="Пошук: ПІБ, посада, телефон" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук у реєстрі" style={{ minWidth: 220 }} />
            <button className="hr-btn solid" onClick={() => setImporting(true)}>Імпорт з таблиці</button>
          </div>
        </div>
        <div className="hr-tiles" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
          <div className="hr-tile"><div className="lb">Працюють</div><div className="vl">{active.length}</div><div className="sb">без акаунта в дашборді: {noAccount}</div></div>
          <div className="hr-tile"><div className="lb">Звільнені</div><div className="vl">{rows.length - active.length}</div><div className="sb">з таблиці «Звільнені»</div></div>
          <div className="hr-tile"><div className="lb">Записів у сейфі</div><div className="vl">{rows.reduce((a, r) => a + r.secrets, 0)}</div><div className="sb">у людей з акаунтом</div></div>
        </div>
        <div className="hr-seg2" style={{ margin: "0 16px 10px" }}>
          {([["active", "Працюють"], ["dismissed", "Звільнені"], ["all", "Усі"]] as const).map(([k, l]) =>
            <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>)}
        </div>
        {rows.length === 0 ? (
          <div className="hr-sect" style={{ border: 0 }}>
            <b>Реєстр порожній.</b> <span className="hr-muted">Натисніть «Імпорт з таблиці» і покладіть CSV з аркуша «Укр NEW», потім — з «Звільнені 25».</span>
          </div>
        ) : (
          <div className="hr-tw">
            <table className="hr-table">
              <thead><tr><th>ПІБ</th><th>Посада</th><th>Команда</th><th>Телефон</th><th>{view === "dismissed" ? "Звільнено" : "Прийнято"}</th><th>Акаунт</th><th className="num">У сейфі</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.full_name}</b>{r.email && <div className="hr-muted">{r.email}</div>}</td>
                    <td>{r.position ?? <span className="hr-muted">—</span>}</td>
                    <td>{r.team_label ?? <span className="hr-muted">—</span>}</td>
                    <td>{r.phone ?? <span className="hr-muted">—</span>}</td>
                    <td>{(r.status === "dismissed" ? d(r.dismissed_at) : d(r.hired_at)) ?? <span className="hr-muted">не вказано</span>}
                      {r.status === "dismissed" && r.dismiss_reason && <div className="hr-muted">{r.dismiss_reason}</div>}</td>
                    <td>{r.user_id != null ? <>{r.account_name}{r.account_active === false && <span className="hr-muted"> · вимкнено</span>}</> : <span className="hr-muted">немає</span>}</td>
                    <td className="num">{r.user_id == null ? <span className="hr-muted">—</span> : r.secrets || <span className="hr-muted">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={(msg) => { setImporting(false); toast(msg); load(); }} />}
    </>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [sheet, setSheet] = useState<"active" | "dismissed">("active");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string[] | null>(null);
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = async (text: string, m?: string[]) => {
    setBusy(true); setMsg(null);
    try {
      const r = await previewEmployeeImport(text, m);
      setPv(r); setMapping(r.columns.map((c) => c.target));
    } catch (e) { setMsg(hiringError(e)); }
    setBusy(false);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setMsg("Потрібен CSV: у Google Таблиці — Файл → Завантажити → CSV (поточний аркуш)"); return; }
    const text = await f.text();
    setFileName(f.name); setCsv(text); setSheet(/звільн/i.test(f.name) ? "dismissed" : "active");
    void preview(text);
  };
  const setCol = (i: number, t: string) => {
    if (!mapping || !csv) return;
    const m = mapping.slice(); m[i] = t; setMapping(m); void preview(csv, m);
  };
  const commit = async () => {
    if (!csv || !mapping) return;
    setBusy(true); setMsg(null);
    try {
      const c = await commitEmployeeImport(csv, mapping, sheet);
      const parts = [`людей: нових ${c.created}, оновлено ${c.updated}`, `привʼязано до акаунтів: ${c.linked}`,
        `у сейф: ${c.secretsCreated}`];
      if (c.secretsExisting) parts.push(`уже були в сейфі: ${c.secretsExisting}`);
      if (c.secretsNoAccount) parts.push(`без акаунта, не перенесено: ${c.secretsNoAccount}`);
      if (c.secretsInvalid) parts.push(`не схожі на картку/пароль: ${c.secretsInvalid}`);
      onDone(`Імпортовано — ${parts.join(" · ")}`);
    } catch (e) { setMsg(hiringError(e)); setBusy(false); }
  };
  const t = pv?.totals;

  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Імпорт з таблиці" onClick={(e) => e.stopPropagation()} style={{ width: "min(1040px, 96vw)", maxHeight: "90vh", overflow: "auto" }}>
        <h3 style={{ margin: "0 0 6px" }}>Імпорт з таблиці «UTS Співробітники УКР»</h3>
        <div className="hr-muted" style={{ marginBottom: 10 }}>
          У Google Таблиці відкрийте аркуш «Укр NEW» → Файл → Завантажити → <b>CSV (поточний аркуш)</b> і покладіть файл сюди.
          Потім так само — аркуш «Звільнені 25». Паролі й картки шифруються на сервері й ідуть лише в сейф; на цьому екрані їх не видно.
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <label className="hr-btn" style={{ cursor: "pointer" }}>
            {fileName ? `Файл: ${fileName}` : "Обрати CSV…"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <div className="hr-seg2">
            <button className={sheet === "active" ? "on" : ""} onClick={() => setSheet("active")}>Аркуш працюючих</button>
            <button className={sheet === "dismissed" ? "on" : ""} onClick={() => setSheet("dismissed")}>Аркуш звільнених</button>
          </div>
          {busy && <span className="hr-muted">Рахую…</span>}
        </div>
        {msg && <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>{msg}</div>}

        {pv && mapping && (
          <>
            <h4 style={{ margin: "12px 0 6px" }}>Колонки — що куди</h4>
            <div className="hr-tw">
              <table className="hr-table">
                <thead><tr><th>Заголовок у таблиці</th><th className="num">Заповнено</th><th>Куди</th></tr></thead>
                <tbody>
                  {pv.columns.map((c) => (
                    <tr key={c.index}>
                      <td>{c.header || <span className="hr-muted">без назви</span>}{c.secretish && <span className="hr-muted"> · схоже на пароль/картку</span>}</td>
                      <td className="num">{c.filled}</td>
                      <td>
                        <select className="hr-inp" value={mapping[c.index]} onChange={(e) => setCol(c.index, e.target.value)} aria-label={`Куди: ${c.header}`}>
                          {PLAIN.map(([k, l]) => <option key={k} value={k} disabled={c.secretish && k !== "skip"}>{l}</option>)}
                          <optgroup label="У сейф (шифром)">{SECRET.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pv.mappingError ? (
              <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)", marginTop: 10 }}>{pv.mappingError}</div>
            ) : t && (
              <>
                <div className="hr-tiles" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", margin: "12px 0" }}>
                  <div className="hr-tile"><div className="lb">Людей у файлі</div><div className="vl">{t.rows - t.duplicate}</div><div className="sb">нових {t.new} · оновиться {t.update}{t.duplicate ? ` · повторів ${t.duplicate}` : ""}</div></div>
                  <div className="hr-tile"><div className="lb">З акаунтом</div><div className="vl">{t.withAccount}</div><div className="sb">без акаунта: {t.noAccount}</div></div>
                  <div className="hr-tile"><div className="lb">Паролів і карток</div><div className="vl">{t.secrets - t.secretsLost}</div><div className="sb">{t.secretsLost ? `не перенесуться (немає акаунта): ${t.secretsLost}` : "усі мають куди лягти"}</div></div>
                  <div className="hr-tile"><div className="lb">Проблеми</div><div className="vl">{t.problems}</div><div className="sb">рядків із нерозпізнаною датою чи поштою</div></div>
                </div>
                <div className="hr-tw" style={{ maxHeight: 320, overflow: "auto" }}>
                  <table className="hr-table">
                    <thead><tr><th className="num">Рядок</th><th>ПІБ</th><th>Посада</th><th>Акаунт</th><th className="num">Секретів</th><th>Зауваги</th></tr></thead>
                    <tbody>
                      {pv.rows.map((r) => (
                        <tr key={r.line} style={r.state === "duplicate" ? { opacity: 0.55 } : undefined}>
                          <td className="num">{r.line}</td>
                          <td><b>{r.name}</b>{r.state === "update" && <span className="hr-muted"> · уже в реєстрі</span>}</td>
                          <td>{r.position ?? <span className="hr-muted">—</span>}</td>
                          <td>{r.account && r.match !== "taken" && <div>{r.account}</div>}<div className="hr-muted">{r.matchNote}</div></td>
                          <td className="num">{r.secrets}{r.secretsLost > 0 && <div className="hr-muted">не перенесуться</div>}</td>
                          <td>{r.problems.length ? r.problems.join("; ") : <span className="hr-muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn solid" disabled={busy || !pv || !!pv.mappingError || !t || t.rows === 0} onClick={() => void commit()}>
            {t ? `Імпортувати ${t.rows - t.duplicate} ${sheet === "dismissed" ? "звільнених" : "працюючих"}` : "Імпортувати"}
          </button>
        </div>
      </div>
    </div>, document.body);
}
