import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchEmployees, previewEmployeeImport, commitEmployeeImport, updateEmployee, fetchSecretsStatus, linkEmployeesKommo, hiringError,
  type EmployeeRow, type ImportPreview, type SecretsStatus, type EmployeePatch,
} from "../../../api";
import type { Toast } from "./HiringShared";
import { StatusBar, VaultPanel } from "./HiringSecrets";

/**
 * 🗂 «НАЙМ → СПІВРОБІТНИКИ» — реєстр, доступи й імпорт «UTS Співробітники УКР» (18.09.2026, задача №3898).
 * «Доступи» злиті сюди: картка людини має розділи «Профіль» (редагування, зміна команди) і «Доступи» (сейф).
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

const TEAM_TONES = ["#1d4ed8", "#047857", "#b45309", "#7c3aed", "#be185d", "#0e7490", "#4d7c0f", "#9f1239"];
const teamTone = (t: string) => TEAM_TONES[[...t].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % TEAM_TONES.length];
const teamName = (t: string | null) => (t == null ? null : /^\d+$/.test(t) ? `Команда ${t}` : t);
const daysSince = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(`${iso}T00:00:00`).getTime()) / 86_400_000) : null);
const tenure = (from: string | null, to: string | null) => {
  if (!from) return null;
  const days = Math.max(0, Math.floor(((to ? new Date(`${to}T00:00:00`) : new Date()).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000));
  return days < 60 ? `${days} дн.` : days < 730 ? `${Math.round(days / 30.4)} міс.` : `${(days / 365).toFixed(1).replace(".", ",")} р.`;
};
const bdaySoon = (iso: string | null) => {
  if (!iso) return false;
  const [, m, d] = iso.split("-").map(Number), now = new Date();
  let next = new Date(now.getFullYear(), m - 1, d);
  if (next.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) next = new Date(now.getFullYear() + 1, m - 1, d);
  return (next.getTime() - now.getTime()) / 86_400_000 <= 7;
};
type Extra = "all" | "new" | "noacc" | "nosec" | "bday";

export function HiringEmployees({ toast }: { toast: Toast }) {
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [teams, setTeams] = useState<string[]>([]);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"active" | "dismissed" | "all">("active");
  const [team, setTeam] = useState<string>("");
  const [extra, setExtra] = useState<Extra>("all");
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<{ id: number; tab: "profile" | "access" } | null>(null);
  const load = useCallback(() => {
    fetchEmployees().then((r) => { setRows(r.rows); setTeams(r.teams); }).catch((e) => setErr(hiringError(e)));
    fetchSecretsStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  const inView = useMemo(() => (rows ?? []).filter((r) => view === "all" || r.status === view), [rows, view]);
  const shown = useMemo(() => inView.filter((r) => (!team || (team === "—" ? !r.team_label : r.team_label === team))
    && (extra === "all" || (extra === "new" && (daysSince(r.hired_at) ?? 999) <= 30) || (extra === "noacc" && r.user_id == null)
      || (extra === "nosec" && r.secrets === 0) || (extra === "bday" && bdaySoon(r.birth_date)))
    && (!q.trim() || `${r.full_name} ${r.position ?? ""} ${r.team_label ?? ""} ${r.phone ?? ""} ${r.email ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))),
  [inView, team, extra, q]);
  const teamOptions = useMemo(() => [...new Set(inView.map((r) => r.team_label).filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b, "uk", { numeric: true })), [inView]);
  if (err) return <div className="chart-card"><b>Реєстр недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!rows) return <p className="loading-text">Завантаження…</p>;
  const active = rows.filter((r) => r.status === "active");
  const newbies = active.filter((r) => (daysSince(r.hired_at) ?? 999) <= 30).length;
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const leftYear = rows.filter((r) => r.status === "dismissed" && (r.dismissed_at ?? "") >= yearAgo).length;
  const openRow = open ? rows.find((r) => r.id === open.id) ?? null : null;

  return (
    <>
      {status && <StatusBar status={status} onChanged={load} toast={toast} />}
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Працюють</div><div className="kpi-value">{active.length}</div><div className="hr-muted">нових за 30 днів: {newbies}</div></div>
        <div className="kpi-card"><div className="kpi-label">Звільнено за рік</div><div className="kpi-value">{leftYear}</div><div className="hr-muted">усього в архіві: {rows.length - active.length}</div></div>
        <div className="kpi-card"><div className="kpi-label">Без акаунта в дашборді</div><div className="kpi-value" style={{ color: active.some((r) => r.user_id == null) ? "var(--warn)" : undefined }}>{active.filter((r) => r.user_id == null).length}</div><div className="hr-muted">серед тих, хто працює</div></div>
        <div className="kpi-card"><div className="kpi-label">Доступів у сейфі</div><div className="kpi-value">{rows.reduce((a, r) => a + r.secrets, 0)}</div><div className="hr-muted">працюють без жодного: {active.filter((r) => r.secrets === 0).length}</div></div>
      </div>
      <div className="chart-card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="emp-bar">
          <div className="hr-seg2">
            {([["active", `Працюють · ${active.length}`], ["dismissed", `Звільнені · ${rows.length - active.length}`], ["all", "Усі"]] as const).map(([k, l]) =>
              <button key={k} className={view === k ? "on" : ""} onClick={() => { setView(k); setTeam(""); }}>{l}</button>)}
          </div>
          <select className="hr-inp" value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Команда">
            <option value="">Усі команди</option>
            {teamOptions.map((t) => <option key={t} value={t}>{teamName(t)}</option>)}
            <option value="—">Без команди</option>
          </select>
          <select className="hr-inp" value={extra} onChange={(e) => setExtra(e.target.value as Extra)} aria-label="Відбір">
            <option value="all">Усі люди</option>
            <option value="new">Нові (до 30 днів)</option>
            <option value="bday">День народження за тиждень</option>
            <option value="noacc">Без акаунта в дашборді</option>
            <option value="nosec">Без доступів у сейфі</option>
          </select>
          <input className="hr-inp" placeholder="Пошук: ПІБ, посада, телефон" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пошук у реєстрі" style={{ flex: "1 1 200px" }} />
          <button className="hr-btn" title="Привʼязати людей до менеджерів Kommo: за ID Kommo з таблиці або за єдиним збігом ПІБ"
            onClick={() => void linkEmployeesKommo().then((r) => { toast(`Kommo: привʼязано ${r.linked} (за ID ${r.byId}, за ПІБ ${r.byName})${r.ambiguous ? ` · однофамільців ${r.ambiguous} — вручну` : ""}`); load(); }).catch((e) => toast(hiringError(e), { error: true }))}>Зіставити з Kommo</button>
          <button className="hr-btn" onClick={() => setImporting(true)}>Імпорт з таблиці</button>
        </div>
        <Birthdays rows={rows} onOpen={(id) => setOpen({ id, tab: "profile" })} />
        {rows.length === 0 ? (
          <div style={{ padding: 16 }}><b>Реєстр порожній.</b> <span className="hr-muted">Натисніть «Імпорт з таблиці» і покладіть CSV з аркуша «Укр NEW».</span></div>
        ) : (
          <div className="hr-tw">
            <table className="data-table emp-table">
              <thead><tr><th>Співробітник</th><th>Команда</th><th>Телефон</th><th>{view === "dismissed" ? "Звільнено" : "Прийнято"}</th><th>Стаж</th><th>Акаунт</th><th className="num">Доступи</th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const fresh = r.status === "active" && (daysSince(r.hired_at) ?? 999) <= 30;
                  return (
                    <tr key={r.id} className={r.status === "dismissed" ? "off" : ""} onClick={() => setOpen({ id: r.id, tab: "profile" })}>
                      <td>
                        <b>{r.full_name}</b>
                        {fresh && <span className="emp-pill info">новий</span>}
                        {bdaySoon(r.birth_date) && <span className="emp-pill warn" title={`День народження ${r.birth_date?.slice(5).split("-").reverse().join(".")}`}>🎂</span>}
                        <div className="hr-muted">{r.position ?? "посада не вказана"}</div>
                      </td>
                      <td>{r.team_label ? <span className="emp-team" style={{ ["--t" as string]: teamTone(r.team_label) }}>{teamName(r.team_label)}</span> : <span className="hr-muted">—</span>}</td>
                      <td>{r.phone ?? <span className={r.status === "active" ? "emp-miss" : "hr-muted"}>немає</span>}</td>
                      <td>{(r.status === "dismissed" ? d(r.dismissed_at) : d(r.hired_at)) ?? <span className="hr-muted">—</span>}
                        {r.status === "dismissed" && r.dismiss_reason && <div className="hr-muted">{r.dismiss_reason}</div>}</td>
                      <td>{tenure(r.hired_at, r.status === "dismissed" ? r.dismissed_at : null) ?? <span className="hr-muted">—</span>}</td>
                      <td>{r.user_id != null ? <span className="emp-pill ok">✓ {r.account_active === false ? "вимкнено" : "є"}</span>
                        : r.status === "active" ? <span className="emp-pill warn">немає</span> : <span className="hr-muted">—</span>}</td>
                      <td className="num">
                        <button className={`emp-vault ${r.secrets === 0 && r.status === "active" ? "empty" : ""}`} title="Відкрити доступи"
                          onClick={(e) => { e.stopPropagation(); setOpen({ id: r.id, tab: "access" }); }}>🔐 {r.secrets}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && <div className="hr-muted" style={{ padding: 16 }}>Нікого не знайдено — змініть фільтри.</div>}
          </div>
        )}
      </div>
      {openRow && <EmployeeDrawer row={openRow} tab={open!.tab} teams={teams} status={status} toast={toast}
        onTab={(t) => setOpen({ id: openRow.id, tab: t })} onClose={() => setOpen(null)} onSaved={load} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={(msg, pending) => {
        setImporting(false); toast(msg); load();
        // Імпорт довершується на сервері — кілька разів перечитуємо реєстр, щоб результат зʼявився без перезавантаження.
        if (pending) for (let k = 1; k <= 12; k++) window.setTimeout(load, k * 15_000);
      }} />}
    </>
  );
}

const FIELDS: [keyof EmployeePatch, string, "text" | "date" | "team" | "status"][] = [
  ["full_name", "ПІБ", "text"], ["position", "Посада", "text"], ["team_label", "Команда", "team"], ["status", "Статус", "status"],
  ["phone", "Телефон", "text"], ["email", "Пошта", "text"], ["telegram", "Telegram", "text"], ["birth_date", "Дата народження", "date"],
  ["hired_at", "Дата прийому", "date"], ["dismissed_at", "Дата звільнення", "date"], ["dismiss_reason", "Причина звільнення", "text"], ["note", "Примітка", "text"],
];

function EmployeeDrawer({ row, tab, teams, status, toast, onTab, onClose, onSaved }: {
  row: EmployeeRow; tab: "profile" | "access"; teams: string[]; status: SecretsStatus | null; toast: Toast;
  onTab: (t: "profile" | "access") => void; onClose: () => void; onSaved: () => void;
}) {
  const init = useMemo(() => Object.fromEntries(FIELDS.map(([k]) => [k, (row[k] as string | null) ?? ""])) as Record<string, string>, [row]);
  const [form, setForm] = useState(init);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setForm(init); setMsg(null); }, [init]);
  const dirty = FIELDS.filter(([k]) => form[k] !== init[k]).map(([k]) => k);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const patch = Object.fromEntries(dirty.map((k) => [k, form[k] === "" ? null : form[k]])) as EmployeePatch;
      const changed = await updateEmployee(row.id, patch);
      toast(changed.length ? `Збережено: ${row.full_name}` : "Нічого не змінилось");
      onSaved();
    } catch (e) { setMsg(hiringError(e)); }
    setBusy(false);
  };
  const extras = Object.entries(row.extra ?? {});
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <div className="hr-drawer emp-drawer" role="dialog" aria-label={`Співробітник: ${row.full_name}`} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{row.full_name}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <span className={`emp-pill ${row.status === "active" ? "ok" : "mute"}`}>{row.status === "active" ? "працює" : "звільнений"}</span>
              {row.team_label && <span className="emp-team" style={{ ["--t" as string]: teamTone(row.team_label) }}>{teamName(row.team_label)}</span>}
              {row.user_id != null ? <span className="emp-pill ok">акаунт: {row.account_name}</span> : <span className="emp-pill warn">без акаунта в дашборді</span>}
              {row.kommo_name ? <span className="emp-pill info">Kommo: {row.kommo_name}</span> : <span className="emp-pill mute">не привʼязано до Kommo</span>}
            </div>
          </div>
          <button className="hr-btn" onClick={onClose}>Закрити</button>
        </div>
        <div className="hr-seg2" style={{ margin: "14px 0 4px" }}>
          <button className={tab === "profile" ? "on" : ""} onClick={() => onTab("profile")}>Профіль</button>
          <button className={tab === "access" ? "on" : ""} onClick={() => onTab("access")}>🔐 Доступи · {row.secrets}</button>
        </div>
        {tab === "profile" ? (
          <>
            <div className="emp-form">
              {FIELDS.map(([k, label, kind]) => (
                <label key={k} className={k === "note" || k === "dismiss_reason" ? "wide" : ""}>
                  <span>{label}</span>
                  {kind === "status" ? (
                    <select className="hr-inp" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value, ...(e.target.value === "active" ? { dismissed_at: "" } : {}) })}>
                      <option value="active">працює</option><option value="dismissed">звільнений</option>
                    </select>
                  ) : (
                    <input className="hr-inp" type={kind === "date" ? "date" : "text"} value={form[k]} list={kind === "team" ? "emp-teams" : undefined}
                      onChange={(e) => setForm({ ...form, [k]: e.target.value, ...(k === "dismissed_at" && e.target.value ? { status: "dismissed" } : {}) })} />
                  )}
                </label>
              ))}
              <datalist id="emp-teams">{teams.map((t) => <option key={t} value={t}>{teamName(t)}</option>)}</datalist>
            </div>
            {msg && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{msg}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              {row.status === "active" && form.status === "active" && (
                <button className="hr-btn" style={{ marginRight: "auto", color: "var(--danger)" }} title="Заповнить статус і дату звільнення — вкажіть причину й збережіть"
                  onClick={() => setForm({ ...form, status: "dismissed", dismissed_at: new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) })}>Звільнити…</button>
              )}
              <button className="hr-btn" disabled={!dirty.length || busy} onClick={() => setForm(init)}>Скасувати зміни</button>
              <button className="hr-btn p" disabled={!dirty.length || busy} onClick={() => void save()}>{busy ? "Зберігаю…" : dirty.length ? `Зберегти (${dirty.length})` : "Зберегти"}</button>
            </div>
            {extras.length > 0 && (
              <div className="hr-sect" style={{ padding: "14px 0 0", marginTop: 14 }}>
                <h4>З таблиці «UTS Співробітники УКР»</h4>
                <dl className="emp-extra">{extras.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
              </div>
            )}
          </>
        ) : status ? (
          <VaultPanel id={row.ref} status={status} toast={toast} onStatus={onSaved} />
        ) : <p className="hr-muted">Сейф недоступний.</p>}
      </div>
    </div>, document.body);
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string, pending?: boolean) => void }) {
  const [sheet, setSheet] = useState<"active" | "dismissed">("active");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string[] | null>(null);
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = async (text: string, m?: string[], row?: number) => {
    setBusy(true); setMsg(null);
    try {
      const r = await previewEmployeeImport(text, m, row ?? pv?.headerRow);
      setPv(r); setMapping(r.columns.map((c) => c.target));
    } catch (e) { setMsg(hiringError(e)); }
    setBusy(false);
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setMsg("Потрібен CSV: у Google Таблиці — Файл → Завантажити → CSV (поточний аркуш)"); return; }
    const text = await f.text();
    setFileName(f.name); setCsv(text); setSheet(/звільн/i.test(f.name) ? "dismissed" : "active");
    setPv(null); setMapping(null);
    try { const r = await previewEmployeeImport(text); setPv(r); setMapping(r.columns.map((c) => c.target)); } catch (e) { setMsg(hiringError(e)); }
  };
  const setCol = (i: number, t: string) => {
    if (!mapping || !csv) return;
    const m = mapping.slice(); m[i] = t; setMapping(m); void preview(csv, m);
  };
  const [writing, setWriting] = useState(false);
  const commit = async () => {
    if (!csv || !mapping || writing) return;
    setBusy(true); setWriting(true); setMsg(null);
    try {
      const c = await commitEmployeeImport(csv, mapping, sheet, pv!.headerRow);
      const parts = [`людей: нових ${c.created}, оновлено ${c.updated}`, `привʼязано до акаунтів: ${c.linked}`,
        `у сейф: ${c.secretsCreated}`];
      if (c.secretsExisting) parts.push(`уже були в сейфі: ${c.secretsExisting}`);
      if (c.secretsNoAccount) parts.push(`з них у людей без акаунта: ${c.secretsNoAccount}`);
      if (c.secretsInvalid) parts.push(`не схожі на картку/пароль: ${c.secretsInvalid}`);
      onDone(`Імпортовано — ${parts.join(" · ")}`);
    } catch (e) {
      const st = (e as { response?: { status?: number } }).response?.status;
      // Браузер або проксі не дочекались відповіді — сервер при цьому довершує імпорт (18.09.2026 так і було).
      if (st == null || st >= 502) { onDone("Звʼязок перервався, але імпорт триває на сервері — реєстр оновиться сам за хвилину-дві", true); return; }
      setMsg(st === 409 ? "Імпорт уже триває (його запустили раніше) — дочекайтесь, реєстр оновиться сам" : hiringError(e));
      setBusy(false); setWriting(false);
    }
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
          {busy && <span className="hr-muted">{writing ? "Імпорт триває — не закривайте вікно й не натискайте вдруге…" : "Рахую…"}</span>}
        </div>
        {msg && <div className="hr-note" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>{msg}</div>}

        {pv && mapping && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "12px 0 6px" }}>
              <b>Заголовки колонок у рядку</b>
              <select className="hr-inp" value={pv.headerRow} aria-label="Рядок із заголовками"
                onChange={(e) => { if (csv) void preview(csv, undefined, Number(e.target.value)); }}>
                {Array.from({ length: 15 }, (_, i) => i + 1).map((n) => {
                  const c = pv.headerCandidates.find((x) => x.row === n);
                  return <option key={n} value={n}>{n}{c ? ` — впізнано: ${c.fields.join(", ")}` : ""}</option>;
                })}
              </select>
              <span className="hr-muted">рядки вище пропускаються; знайдено автоматично — міняйте, лише якщо не той</span>
            </div>
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
                  <div className="hr-tile"><div className="lb">Паролів і карток</div><div className="vl">{t.secrets}</div><div className="sb">{t.secretsNoAccount ? `з них у людей без акаунта: ${t.secretsNoAccount} — ляжуть на людину реєстру` : "усі — у людей з акаунтом"}</div></div>
                  <div className="hr-tile"><div className="lb">Проблеми</div><div className="vl">{t.problems}</div><div className="sb">з нерозпізнаною датою чи поштою{t.skipped ? ` · пропущено службових рядків: ${t.skipped}` : ""}</div></div>
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
                          <td className="num">{r.secrets}</td>
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

/** 🎂 Дні народження на найближчі 14 днів — серед тих, хто працює. */
function Birthdays({ rows, onOpen }: { rows: EmployeeRow[]; onOpen: (id: number) => void }) {
  const now = new Date(), t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const soon = rows.filter((r) => r.status === "active" && r.birth_date).map((r) => {
    const [, m, d] = r.birth_date!.split("-").map(Number);
    let next = new Date(now.getFullYear(), m - 1, d).getTime();
    if (next < t0) next = new Date(now.getFullYear() + 1, m - 1, d).getTime();
    return { r, days: Math.round((next - t0) / 86_400_000), age: new Date(next).getFullYear() - Number(r.birth_date!.slice(0, 4)) };
  }).filter((x) => x.days <= 14).sort((a, b) => a.days - b.days);
  if (!soon.length) return null;
  return (
    <div className="bd-row">
      <b>🎂 Найближчі дні народження:</b>
      {soon.map(({ r, days, age }) => (
        <button key={r.id} className={`bd-chip ${days === 0 ? "today" : ""}`} onClick={() => onOpen(r.id)}>
          {r.full_name.split(" ").slice(0, 2).join(" ")} · {days === 0 ? "сьогодні" : days === 1 ? "завтра" : `${r.birth_date!.slice(8, 10)}.${r.birth_date!.slice(5, 7)}`} · {age}
        </button>
      ))}
    </div>
  );
}
