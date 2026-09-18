import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchChurn, fetchExits, createExit, updateExit, deleteExit, restoreExit, fetchEmployees, hiringError,
  type ChurnReport, type ExitInterview, type EmployeeRow,
} from "../../../api";
import type { Toast } from "./HiringShared";

/**
 * 📉 «ПЛИННІСТЬ» і «EXIT-ІНТЕРВʼЮ» (18.09.2026, етап 5). Дані — з реєстру співробітників (дати прийому й
 * звільнення) і власних записів інтервʼю. Формула плинності — як у таблиці «Плинність NEW»; рахує сервер.
 */

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("uk-UA", { month: "short", year: "2-digit" });
const pct = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);
const PRESETS: [string, number][] = [["6 місяців", 6], ["12 місяців", 12], ["24 місяці", 24]];

export function HiringChurnTab() {
  const [n, setN] = useState(12);
  const [d, setD] = useState<ChurnReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const now = new Date(), from = new Date(now.getFullYear(), now.getMonth() - n + 1, 1);
    setErr(null); fetchChurn(ym(from), ym(now)).then(setD).catch((e) => setErr(hiringError(e)));
  }, [n]);
  if (err) return <div className="chart-card"><b>Плинність недоступна.</b> <span className="hr-muted">{err}</span></div>;
  if (!d) return <p className="loading-text">Рахую…</p>;
  const max = Math.max(1, ...d.months.map((m) => m.turnover ?? 0));
  const noDate = d.months.at(-1)?.noHireDate ?? 0;
  return (
    <>
      <div className="page-filters" style={{ marginBottom: 14 }}>
        <div className="hr-seg2">{PRESETS.map(([l, k]) => <button key={k} className={n === k ? "on" : ""} onClick={() => setN(k)}>{l}</button>)}</div>
        <span className="hr-muted" style={{ fontSize: 12.5 }}>Плинність місяця = звільнено ÷ усі, хто працював у цьому місяці (як у таблиці «Плинність NEW»).</span>
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Середня плинність</div><div className="kpi-value">{pct(d.total.avgTurnover)}</div><div className="hr-muted">на місяць за період</div></div>
        <div className="kpi-card"><div className="kpi-label">Звільнено</div><div className="kpi-value" style={{ color: "var(--danger)" }}>{d.total.dismissed}</div><div className="hr-muted">з них у перші 90 днів: {d.total.early}</div></div>
        <div className="kpi-card"><div className="kpi-label">Прийнято</div><div className="kpi-value" style={{ color: "var(--ok)" }}>{d.total.hired}</div><div className="hr-muted">за період</div></div>
        <div className="kpi-card"><div className="kpi-label">Працює зараз</div><div className="kpi-value">{d.total.active}</div><div className="hr-muted">{noDate ? `без дати прийому: ${noDate}` : "дати прийому в усіх"}</div></div>
      </div>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="chart-title">Плинність по місяцях</div>
        <div className="hr-tw">
          <table className="data-table compact" style={{ width: "100%" }}>
            <thead><tr><th>Місяць</th><th className="num">Працювало</th><th className="num">Прийнято</th><th className="num">Звільнено</th><th className="num">у перші 90 днів</th><th>Плинність</th></tr></thead>
            <tbody>{d.months.map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td><td className="num">{m.headcount}</td><td className="num" style={{ color: m.hired ? "var(--ok)" : undefined }}>{m.hired || "—"}</td>
                <td className="num" style={{ color: m.dismissed ? "var(--danger)" : undefined }}>{m.dismissed || "—"}</td><td className="num">{m.early || "—"}</td>
                <td style={{ minWidth: 180 }}><div className="ch-bar"><i style={{ width: `${((m.turnover ?? 0) / max) * 100}%`, background: (m.turnover ?? 0) >= 10 ? "var(--danger)" : (m.turnover ?? 0) >= 5 ? "var(--warn)" : "var(--ok)" }} /><span>{pct(m.turnover)}</span></div></td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
      <div className="chart-grid">
        <div className="chart-card"><div className="chart-title">Причини звільнень</div>
          {d.reasons.length ? <table className="data-table compact" style={{ width: "100%" }}><tbody>{d.reasons.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.n}</td></tr>)}</tbody></table> : <div className="hr-muted">За період звільнень немає.</div>}
        </div>
        <div className="chart-card"><div className="chart-title">Звідки йдуть — за посадою</div>
          {d.positions.length ? <table className="data-table compact" style={{ width: "100%" }}><tbody>{d.positions.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.n}</td></tr>)}</tbody></table> : <div className="hr-muted">—</div>}
        </div>
      </div>
    </>
  );
}

/** Питання — ті самі, що в Google-формі «Exit interview». */
const Q: [keyof ExitInterview, string, "text" | "area" | "rating" | "yn"][] = [
  ["position", "На якій посаді працював(ла)", "text"], ["tenure", "Скільки часу працював(ла) в компанії", "text"],
  ["team_lead", "Хто був тімлідом", "text"], ["reason", "Причина звільнення", "text"], ["reason_detail", "Причина докладніше", "area"],
  ["rating", "Оцінка компанії (1–10)", "rating"], ["missing", "Чого нам не вистачає, щоб бути кращими", "area"],
  ["recommend", "Чи порадив(ла) б компанію", "yn"], ["note", "Примітка HR", "area"],
];

export function HiringExitTab({ toast }: { toast: Toast }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof fetchExits>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<ExitInterview> | null>(null);
  const load = useCallback(() => { fetchExits().then(setD).catch((e) => setErr(hiringError(e))); }, []);
  useEffect(load, [load]);
  if (err) return <div className="chart-card"><b>Exit-інтервʼю недоступні.</b> <span className="hr-muted">{err}</span></div>;
  if (!d) return <p className="loading-text">Завантаження…</p>;
  const remove = (x: ExitInterview) => void deleteExit(x.id).then(() => { load(); toast(`Інтервʼю «${x.full_name}» видалено`, { action: { label: "Відновити", run: () => void restoreExit(x.id).then(load) } }); }).catch((e) => toast(hiringError(e), { error: true }));
  return (
    <>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Інтервʼю</div><div className="kpi-value">{d.stats.total}</div><div className="hr-muted">усього записано</div></div>
        <div className="kpi-card"><div className="kpi-label">Середня оцінка</div><div className="kpi-value">{d.stats.avgRating ?? "—"}</div><div className="hr-muted">з 10</div></div>
        <div className="kpi-card"><div className="kpi-label">Порадили б компанію</div><div className="kpi-value">{d.stats.recommendPct == null ? "—" : `${d.stats.recommendPct}%`}</div><div className="hr-muted">серед тих, хто відповів</div></div>
        <div className="kpi-card"><div className="kpi-label">Головна причина</div><div className="kpi-value" style={{ fontSize: 18 }}>{d.stats.reasons[0]?.label ?? "—"}</div><div className="hr-muted">{d.stats.reasons[0] ? `${d.stats.reasons[0].n} раз(и)` : ""}</div></div>
      </div>
      <div className="chart-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div className="chart-title" style={{ margin: 0 }}>Exit-інтервʼю</div>
          <button className="hr-btn p" onClick={() => setEdit({ interview_date: new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }) })}>+ Інтервʼю</button>
        </div>
        {d.rows.length === 0 ? <div className="hr-muted">Записів ще немає. Проведіть інтервʼю зі звільненим і внесіть відповіді кнопкою «+ Інтервʼю».</div> : (
          <div className="hr-tw">
            <table className="data-table compact" style={{ width: "100%" }}>
              <thead><tr><th>Дата</th><th>Хто</th><th>Посада</th><th>Причина</th><th className="num">Оцінка</th><th>Порадив би</th><th /></tr></thead>
              <tbody>{d.rows.map((x) => (
                <tr key={x.id} style={{ cursor: "pointer" }} onClick={() => setEdit(x)}>
                  <td>{x.interview_date.split("-").reverse().join(".")}</td><td><b>{x.full_name}</b>{x.team_lead && <div className="hr-muted">тімлід: {x.team_lead}</div>}</td>
                  <td>{x.position ?? <span className="hr-muted">—</span>}</td><td>{x.reason ?? <span className="hr-muted">—</span>}</td>
                  <td className="num"><b style={{ color: x.rating == null ? undefined : x.rating >= 8 ? "var(--ok)" : x.rating >= 5 ? "var(--warn)" : "var(--danger)" }}>{x.rating ?? "—"}</b></td>
                  <td>{x.recommend ?? <span className="hr-muted">—</span>}</td>
                  <td><button className="hr-link" style={{ color: "var(--text-muted)" }} title="Видалити (можна відновити)" onClick={(e) => { e.stopPropagation(); remove(x); }}>✕</button></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </div>
      {edit && <ExitDialog value={edit} onClose={() => setEdit(null)} onSaved={(m) => { setEdit(null); toast(m); load(); }} />}
    </>
  );
}

function ExitDialog({ value, onClose, onSaved }: { value: Partial<ExitInterview>; onClose: () => void; onSaved: (m: string) => void }) {
  const [f, setF] = useState<Partial<ExitInterview>>(value);
  const [people, setPeople] = useState<EmployeeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetchEmployees().then((r) => setPeople(r.rows.filter((p) => p.status === "dismissed"))).catch(() => setPeople([])); }, []);
  const pickPerson = (name: string) => {
    const p = people.find((x) => x.full_name === name);
    setF({ ...f, full_name: name, ...(p ? { employee_id: p.id, position: f.position || p.position, reason: f.reason || p.dismiss_reason } : { employee_id: null }) });
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...f, rating: f.rating == null || (f.rating as unknown) === "" ? null : Number(f.rating) };
      if (value.id) { await updateExit(value.id, body); onSaved("Інтервʼю збережено"); }
      else { await createExit(body); onSaved(`Інтервʼю «${f.full_name}» додано`); }
    } catch (e) { setErr(hiringError(e)); setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Exit-інтервʼю" onClick={(e) => e.stopPropagation()} style={{ width: "min(640px, 96vw)", maxHeight: "90vh", overflow: "auto" }}>
        <h3 style={{ margin: "0 0 10px" }}>{value.id ? `Exit-інтервʼю: ${value.full_name}` : "Нове Exit-інтервʼю"}</h3>
        <div className="emp-form">
          <label><span>ПІБ *</span><input className="hr-inp" list="exit-people" value={f.full_name ?? ""} onChange={(e) => pickPerson(e.target.value)} placeholder="почніть вводити — підкажу звільнених" /></label>
          <datalist id="exit-people">{people.map((p) => <option key={p.id} value={p.full_name} />)}</datalist>
          <label><span>Дата інтервʼю *</span><input className="hr-inp" type="date" value={f.interview_date ?? ""} onChange={(e) => setF({ ...f, interview_date: e.target.value })} /></label>
          {Q.map(([k, label, kind]) => (
            <label key={k} className={kind === "area" ? "wide" : ""}><span>{label}</span>
              {kind === "area" ? <textarea className="hr-inp" rows={2} value={(f[k] as string) ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                : kind === "rating" ? <input className="hr-inp" type="number" min={1} max={10} value={(f[k] as number | null) ?? ""} onChange={(e) => setF({ ...f, rating: e.target.value === "" ? null : Number(e.target.value) })} />
                : kind === "yn" ? <select className="hr-inp" value={(f[k] as string) ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value || null })}><option value="">—</option><option>Так</option><option>Ні</option><option>Не впевнений(а)</option></select>
                : <input className="hr-inp" value={(f[k] as string) ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
            </label>
          ))}
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>{busy ? "Зберігаю…" : "Зберегти"}</button>
        </div>
      </div>
    </div>, document.body);
}
