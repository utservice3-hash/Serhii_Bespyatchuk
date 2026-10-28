import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchChurn, fetchExits, createExit, updateExit, deleteExit, restoreExit, fetchEmployees, hiringError, setDismissDate, EMP_CATEGORIES, empCategoryLabel,
  type ChurnReport, type ChurnPersonRow, type ExitInterview, type EmployeeRow,
} from "../../../api";
import type { Toast } from "./HiringShared";

/**
 * 📉 «ПЛИННІСТЬ» і «EXIT-ІНТЕРВʼЮ» (18.09.2026, етап 5). Дані — з реєстру співробітників (дати прийому й
 * звільнення) і власних записів інтервʼю. Формула плинності — як у таблиці «Плинність NEW»; рахує сервер.
 */

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const ymd = (d: Date) => `${ym(d)}-${String(d.getDate()).padStart(2, "0")}`;
const dmy = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : "—");
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("uk-UA", { month: "short", year: "2-digit" });
const pct = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);
const stazh = (days: number | null) => {
  if (days == null) return null;
  if (days < 60) return `${days} дн.`;
  const m = Math.round(days / 30.4);
  return m < 24 ? `${m} міс.` : `${(days / 365).toFixed(1).replace(".", ",")} р.`;
};

/**
 * 📅 ПЕРІОД (28.10.2026, ТЗ Івана): тиждень — календарний пн–нд (пропозиція, питання 3 макета), місяць — календарний,
 * 6/12/24 — останні N місяців, що закінчуються місяцем-якорем. Стрілки зсувають якір на один період.
 */
type Per = "week" | "month" | "6" | "12" | "24";
const PERIODS: [Per, string][] = [["week", "Тиждень"], ["month", "Місяць"], ["6", "6 місяців"], ["12", "12 місяців"], ["24", "24 місяці"]];
function rangeOf(per: Per, anchor: Date): { from: string; to: string; end: Date; label: string } {
  if (per === "week") {
    const mon = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((anchor.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return { from: ymd(mon), to: ymd(sun), end: sun, label: `${dmy(ymd(mon)).slice(0, 5)} – ${dmy(ymd(sun))}` };
  }
  const n = per === "month" ? 1 : Number(per);
  const first = new Date(anchor.getFullYear(), anchor.getMonth() - n + 1, 1), last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const lbl = (d: Date) => d.toLocaleDateString("uk-UA", { month: "long", year: "numeric" }).replace(" р.", "");
  return { from: ym(first), to: ym(anchor), end: last, label: n === 1 ? lbl(anchor) : `${monthLabel(ym(first))} – ${monthLabel(ym(anchor))}` };
}
const shiftAnchor = (per: Per, a: Date, k: number) =>
  per === "week" ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * k) : new Date(a.getFullYear(), a.getMonth() + k * (per === "month" ? 1 : Number(per)), 1);

export function HiringChurnTab({ toast }: { toast: Toast }) {
  const [per, setPer] = useState<Per>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [cat, setCat] = useState("");
  const [d, setD] = useState<ChurnReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<ChurnPersonRow | null>(null);
  const r = rangeOf(per, anchor);
  const load = useCallback(() => {
    setErr(null); fetchChurn(r.from, r.to, cat || null).then(setD).catch((e) => setErr(hiringError(e)));
  }, [r.from, r.to, cat]);
  useEffect(load, [load]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const atEnd = r.end >= today;
  const head = (
    <div className="page-filters" style={{ marginBottom: 14, alignItems: "center" }}>
      <div className="hr-seg2">{PERIODS.map(([k, l]) => <button key={k} className={per === k ? "on" : ""} onClick={() => { setPer(k); setAnchor(new Date()); }}>{l}</button>)}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button className="hr-btn xs" aria-label="Попередній період" onClick={() => setAnchor(shiftAnchor(per, anchor, -1))}>‹</button>
        <b style={{ minWidth: 150, textAlign: "center" }}>{r.label}</b>
        <button className="hr-btn xs" aria-label="Наступний період" disabled={atEnd} onClick={() => setAnchor(shiftAnchor(per, anchor, 1))}>›</button>
      </div>
    </div>
  );
  if (err) return <>{head}<div className="chart-card"><b>Плинність недоступна.</b> <span className="hr-muted">{err}</span></div></>;
  if (!d) return <>{head}<p className="loading-text">Рахую…</p></>;
  const max = Math.max(1, ...d.months.map((m) => m.turnover ?? 0));
  const noDate = d.months.at(-1)?.noHireDate ?? 0;
  const allN = Object.values(d.byCategory).reduce((a, n) => a + n, 0);
  return (
    <>
      {head}
      <div className="chart-card" style={{ padding: 0, marginBottom: 14 }}>
        <div className="emp-cats" role="group" aria-label="Категорія" style={{ borderBottom: 0 }}>
          <button className={`emp-cat ${cat === "" ? "on" : ""}`} onClick={() => setCat("")}>Усі <span>{allN}</span></button>
          {[...EMP_CATEGORIES, ["none", "Без категорії"] as const].map(([k, l]) => {
            const n = d.byCategory[k] ?? 0;
            if (k === "none" && !n && cat !== "none") return null;
            return <button key={k} className={`emp-cat ${cat === k ? "on" : ""} ${n ? "" : "zero"}`} onClick={() => setCat(cat === k ? "" : k)}>{l} <span>{n}</span></button>;
          })}
        </div>
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Звільнено</div><div className="kpi-value" style={{ color: "var(--danger)" }}>{d.total.dismissed}</div><div className="hr-muted">з них у перші 90 днів: {d.total.early}</div></div>
        <div className="kpi-card"><div className="kpi-label">Середній стаж звільнених</div><div className="kpi-value">{stazh(d.total.avgTenureDays) ?? "—"}</div>
          <div className="hr-muted">{d.total.noHireDate ? `без дати початку: ${d.total.noHireDate} — не в середньому` : "від дати початку до звільнення"}</div></div>
        <div className="kpi-card"><div className="kpi-label">{d.wholeMonths && d.months.length > 1 ? "Середня плинність" : "Плинність"}</div><div className="kpi-value">{pct(d.total.avgTurnover)}</div>
          <div className="hr-muted">{d.wholeMonths ? (d.months.length > 1 ? "на місяць за період" : "звільнено ÷ працювало в місяці") : "для тижня не рахується — формула помісячна"}</div></div>
        <div className="kpi-card"><div className="kpi-label">Працює зараз</div><div className="kpi-value">{d.total.active}</div><div className="hr-muted">{noDate ? `без дати прийому: ${noDate}` : cat ? `у категорії «${empCategoryLabel(cat === "none" ? null : cat)}»` : "за реєстром"}</div></div>
      </div>
      {(d.total.unknownDate ?? 0) > 0 && (
        <div className="hr-muted" style={{ margin: "-6px 0 12px", fontSize: 12.5 }}>
          Поза розрахунком: {d.total.unknownDate} звільнених із невідомою датою (позначено в картці людини — «дата невідома»).
        </div>
      )}
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="chart-title">Хто звільнився · {r.label}</div>
        {d.people.length === 0 ? <div className="hr-muted">За цей період звільнень немає{cat ? ` у категорії «${empCategoryLabel(cat === "none" ? null : cat)}»` : ""}.</div> : (
          <div className="hr-tw">
            <table className="data-table compact" style={{ width: "100%" }}>
              <thead><tr><th>Співробітник</th><th>Категорія</th><th>Посада</th><th>Почав</th><th>Звільнився</th><th className="num">Стаж</th><th /></tr></thead>
              <tbody>{d.people.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.full_name}</b></td>
                  <td>{p.category ? empCategoryLabel(p.category) : <span className="hr-muted">без категорії</span>}</td>
                  <td className="hr-muted">{p.position ?? "—"}</td>
                  <td>{p.hired_at ? dmy(p.hired_at) : <span className="hr-muted">невідомо</span>}</td>
                  <td>{dmy(p.dismissed_at)}</td>
                  <td className="num">{stazh(p.tenure_days) ?? <span className="hr-muted">—</span>}</td>
                  <td style={{ textAlign: "right" }}><button className="hr-btn xs" onClick={() => setEdit(p)}>Змінити</button></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </div>
      {d.months.length > 1 && (
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
      )}
      <div className="chart-grid">
        <div className="chart-card"><div className="chart-title">Причини звільнень</div>
          {d.reasons.length ? <table className="data-table compact" style={{ width: "100%" }}><tbody>{d.reasons.map((x) => <tr key={x.label}><td>{x.label}</td><td className="num">{x.n}</td></tr>)}</tbody></table> : <div className="hr-muted">За період звільнень немає.</div>}
        </div>
        <div className="chart-card"><div className="chart-title">Звідки йдуть — за посадою</div>
          {d.positions.length ? <table className="data-table compact" style={{ width: "100%" }}><tbody>{d.positions.map((x) => <tr key={x.label}><td>{x.label}</td><td className="num">{x.n}</td></tr>)}</tbody></table> : <div className="hr-muted">—</div>}
        </div>
      </div>
      {edit && <TenureDialog p={edit} onClose={() => setEdit(null)} onDone={(m) => { setEdit(null); toast(m); load(); }} />}
    </>
  );
}

/**
 * ✏️ «Змінити» в списку плинності (28.10.2026, ТЗ Івана, варіант А): стаж правиться ДАТАМИ, а не окремим числом —
 * одне джерело правди для картки, плинності й стажу. Коментар обовʼязковий, зміна йде в журнал (`setDismissDate`).
 */
function TenureDialog({ p, onClose, onDone }: { p: ChurnPersonRow; onClose: () => void; onDone: (m: string) => void }) {
  const [hired, setHired] = useState(p.hired_at ?? "");
  const [left, setLeft] = useState(p.dismissed_at);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const days = hired && left ? Math.round((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${hired}T00:00:00Z`)) / 86_400_000) : null;
  const bad = days != null && days < 0;
  const save = async () => {
    if (!left) { setErr("Вкажіть дату звільнення"); return; }
    if (bad) { setErr("Дата початку пізніше за дату звільнення"); return; }
    if (!comment.trim()) { setErr("Коментар обовʼязковий"); return; }
    setBusy(true); setErr(null);
    try {
      await setDismissDate(p.id, { date: left, comment: comment.trim(), ...(hired !== (p.hired_at ?? "") ? { hiredAt: hired || null } : {}) });
      onDone(`${p.full_name}: ${dmy(hired || null)} – ${dmy(left)}${days != null && !bad ? `, стаж ${stazh(days)}` : ""}`);
    } catch (e) { setErr(hiringError(e)); setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label="Дати роботи" onClick={(e) => e.stopPropagation()} style={{ width: "min(480px, 96vw)" }}>
        <h3 style={{ margin: "0 0 4px" }}>{p.full_name} — дати роботи</h3>
        <p className="hr-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>Стаж рахується з цих дат сам. Ті самі дати — у картці співробітника й у плинності.</p>
        <div className="emp-form" style={{ marginTop: 0 }}>
          <label><span>Почав(ла)</span><input className="hr-inp" type="date" value={hired} onChange={(e) => setHired(e.target.value)} /></label>
          <label><span>Звільнився(лась)</span><input className="hr-inp" type="date" value={left} onChange={(e) => setLeft(e.target.value)} /></label>
          <div className="wide hr-muted" style={{ fontSize: 13, color: bad ? "var(--danger)" : undefined }}>
            {bad ? "Дата початку пізніше за дату звільнення" : days != null ? <>Стаж: <b style={{ color: "var(--text)" }}>{stazh(days)}</b> · рахується сам</> : "Без дати початку стаж невідомий"}
          </div>
          <label className="wide"><span>Коментар *</span><input className="hr-inp" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="напр.: вийшла на стажування раніше, ніж оформили" /></label>
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={busy || !comment.trim() || bad} onClick={() => void save()}>{busy ? "Зберігаю…" : "Зберегти"}</button>
        </div>
      </div>
    </div>, document.body);
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
