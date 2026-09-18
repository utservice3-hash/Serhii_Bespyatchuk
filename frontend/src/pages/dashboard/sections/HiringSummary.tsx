import { useEffect, useMemo, useState } from "react";
import { fetchHiringSummary, fetchHiringVacancies, hiringError, type HiringSummary as Summary, type HiringVacancyRow, type HiringCutRow } from "../../../api";

/**
 * 📊 «НАЙМ → ЗВЕДЕННЯ» (18.09.2026, етап 2 плану за зустріччю 15.09). Воронка рекрутингу як у Хурмі:
 * скільки дійшло до кожного етапу, конверсія від попереднього й від першого, де втрачаємо людей,
 * відмови кандидата й компанії, розрізи за джерелом і вакансією, прийняті/звільнені з реєстру.
 * Когорта — кандидати, додані за період (київські дати). Рахує сервер (`core/hiringFunnel.ts`).
 */

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const PRESETS: [string, () => [string, string]][] = [
  ["Цей місяць", () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n)]; }],
  ["Минулий місяць", () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))]; }],
  ["90 днів", () => { const n = new Date(); return [iso(new Date(n.getTime() - 89 * 86_400_000)), iso(n)]; }],
  ["Рік", () => { const n = new Date(); return [iso(new Date(n.getFullYear(), 0, 1)), iso(n)]; }],
];
const pctText = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("uk-UA", { month: "long", year: "numeric" });

export function HiringSummary() {
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[0][1]());
  const [preset, setPreset] = useState(0);
  const [vacancyId, setVacancyId] = useState("");
  const [source, setSource] = useState("");
  const [vacs, setVacs] = useState<HiringVacancyRow[]>([]);
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetchHiringVacancies("all").then(setVacs).catch(() => setVacs([])); }, []);
  useEffect(() => {
    setErr(null);
    fetchHiringSummary({ from, to, vacancyId: vacancyId || undefined, source: source || undefined }).then(setD).catch((e) => setErr(hiringError(e)));
  }, [from, to, vacancyId, source]);
  const sources = useMemo(() => (d?.bySource ?? []).map((r) => r.key), [d]);

  const filters = (
    <div className="page-filters" style={{ marginBottom: 14 }}>
      <div className="hr-seg2">
        {PRESETS.map(([l, f], i) => <button key={l} className={preset === i ? "on" : ""} onClick={() => { setPreset(i); setRange(f()); }}>{l}</button>)}
      </div>
      <input className="hr-inp" type="date" value={from} max={to} onChange={(e) => { setPreset(-1); setRange([e.target.value, to]); }} aria-label="Від" />
      <input className="hr-inp" type="date" value={to} min={from} onChange={(e) => { setPreset(-1); setRange([from, e.target.value]); }} aria-label="До" />
      <select className="hr-inp" value={vacancyId} onChange={(e) => setVacancyId(e.target.value)} aria-label="Вакансія">
        <option value="">Усі вакансії</option>
        {vacs.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
      </select>
      <select className="hr-inp" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Джерело">
        <option value="">Усі джерела</option>
        {sources.filter((k) => k !== "—").map((k) => <option key={k} value={k}>{k}</option>)}
        <option value="—">Джерело не вказано</option>
      </select>
    </div>
  );
  if (err) return <>{filters}<div className="chart-card"><b>Зведення недоступне.</b> <span className="hr-muted">{err}</span></div></>;
  if (!d) return <>{filters}<p className="loading-text">Рахую…</p></>;
  const first = d.funnel[0]?.count ?? 0;
  const worst = d.funnel.slice(0, -1).reduce<{ i: number; lost: number } | null>((m, s, i) => (s.lost > (m?.lost ?? 0) ? { i, lost: s.lost } : m), null);
  const hired = d.funnel.find((s) => s.key === "manager")?.count ?? 0;

  return (
    <>
      {filters}
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Нових кандидатів</div><div className="kpi-value">{d.total}</div><div className="hr-muted">додано за період</div></div>
        <div className="kpi-card"><div className="kpi-label">Дійшли до менеджера</div><div className="kpi-value">{hired}</div><div className="hr-muted">конверсія {pctText(first ? Math.round((hired / first) * 1000) / 10 : null)}</div></div>
        <div className="kpi-card"><div className="kpi-label">Відмов</div><div className="kpi-value">{d.refusals.total}</div><div className="hr-muted">кандидата {d.refusals.candidate} · компанії {d.refusals.company}</div></div>
        <div className="kpi-card"><div className="kpi-label">Відкритих вакансій</div><div className="kpi-value">{d.vacancies.open}</div><div className="hr-muted">потрібно людей: {d.vacancies.need}</div></div>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="chart-title">Воронка рекрутингу</div>
        {d.total === 0 ? <div className="hr-muted">За цей період кандидатів не додавали — змініть період або фільтри.</div> : (
          <>
            <div className="fn-list">
              {d.funnel.map((s, i) => (
                <div key={s.key} className="fn-row">
                  <div className="fn-label">{s.label}</div>
                  <div className="fn-track"><div className="fn-bar" style={{ width: `${first ? Math.max(2, (s.count / first) * 100) : 0}%` }} /><span className="fn-n">{s.count}</span></div>
                  <div className="fn-pct" title="від попереднього етапу">{i === 0 ? "" : pctText(s.fromPrev)}</div>
                  <div className="fn-pct muted" title="від нових">{i === 0 ? "100%" : pctText(s.fromFirst)}</div>
                </div>
              ))}
            </div>
            <div className="hr-muted" style={{ marginTop: 8, fontSize: 12.5 }}>
              Ліворуч — конверсія від попереднього етапу, праворуч — від усіх нових. Хто перескочив етап, його пройшов.
              {worst && worst.lost > 0 && <> Найбільше втрачаємо між «{d.funnel[worst.i].label}» і «{d.funnel[worst.i + 1].label}»: <b className="fn-warn">−{worst.lost}</b>.</>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <span className="emp-pill warn">не прийшли на співбесіду: {d.side.noshow}</span>
              <span className="emp-pill warn">недозвон: {d.side.noanswer}</span>
              <span className="emp-pill info">у резерві: {d.side.reserved}</span>
            </div>
          </>
        )}
      </div>

      <div className="chart-grid" style={{ marginBottom: 16 }}>
        <div className="chart-card">
          <div className="chart-title">Відмови</div>
          {d.refusals.total === 0 ? <div className="hr-muted">Відмов за період немає.</div> : (
            <>
              <div className="fn-split" aria-label="Частка відмов кандидата й компанії">
                <div className="c" style={{ flexGrow: d.refusals.candidate || 0.0001 }}>кандидата · {d.refusals.candidate} ({pctText(d.refusals.candidateShare)})</div>
                <div className="k" style={{ flexGrow: d.refusals.company || 0.0001 }}>компанії · {d.refusals.company} ({pctText(d.refusals.companyShare)})</div>
              </div>
              <div className="hr-muted" style={{ margin: "6px 0 10px", fontSize: 12.5 }}>Відмов — {pctText(d.refusals.share)} від усіх нових.{d.refusals.unknown ? ` Без вказаної сторони: ${d.refusals.unknown}.` : ""}</div>
              <table className="data-table compact" style={{ width: "100%" }}>
                <thead><tr><th>Причина</th><th>Сторона</th><th className="num">Кількість</th></tr></thead>
                <tbody>{d.refusals.reasons.map((r) => <tr key={`${r.side}${r.label}`}><td>{r.label}</td><td><span className={`emp-pill ${r.side === "candidate" ? "info" : r.side === "company" ? "warn" : "mute"}`}>{r.side === "candidate" ? "кандидата" : r.side === "company" ? "компанії" : "не вказано"}</span></td><td className="num">{r.n}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-title">Співробітники</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
            <div><div className="kpi-label">Прийнято</div><div style={{ fontSize: 22, fontWeight: 700, color: "var(--ok)" }}>+{d.staff.hired}</div></div>
            <div><div className="kpi-label">Звільнено</div><div style={{ fontSize: 22, fontWeight: 700, color: "var(--danger)" }}>−{d.staff.dismissed}</div></div>
            <div><div className="kpi-label">Працює зараз</div><div style={{ fontSize: 22, fontWeight: 700 }}>{d.staff.active}</div></div>
          </div>
          {d.staff.dismissReasons.length > 0 && <>
            <div className="kpi-label" style={{ marginBottom: 4 }}>Причини звільнень за період</div>
            <table className="data-table compact" style={{ width: "100%" }}><tbody>{d.staff.dismissReasons.map((r) => <tr key={r.reason}><td>{r.reason}</td><td className="num">{r.n}</td></tr>)}</tbody></table>
          </>}
          {d.staff.byPosition.length > 0 && <>
            <div className="kpi-label" style={{ margin: "10px 0 4px" }}>Працюють за посадами</div>
            <table className="data-table compact" style={{ width: "100%" }}><tbody>{d.staff.byPosition.map((r) => <tr key={r.position}><td>{r.position}</td><td className="num">{r.n}</td></tr>)}</tbody></table>
          </>}
        </div>
      </div>

      <div className="chart-grid" style={{ marginBottom: 16 }}>
        <CutTable title="За джерелом" rows={d.bySource} />
        <CutTable title="За вакансією" rows={d.byVacancy} note="Кандидат на кількох вакансіях — у рядку кожної, тож сума може бути більшою за «нових»." />
      </div>

      <div className="chart-card">
        <div className="chart-title">Закриті вакансії</div>
        {d.vacancies.closed.length === 0 ? <div className="hr-muted">За період вакансій не закривали.</div> : (
          <table className="data-table compact" style={{ width: "100%" }}>
            <thead><tr><th>Місяць</th><th>Результат</th><th className="num">Вакансій</th></tr></thead>
            <tbody>{d.vacancies.closed.map((r) => <tr key={`${r.month}${r.result}`}><td>{monthName(r.month)}</td><td>{r.result ?? "не вказано"}</td><td className="num">{r.n}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function CutTable({ title, rows, note }: { title: string; rows: HiringCutRow[]; note?: string }) {
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      {rows.length === 0 ? <div className="hr-muted">Даних немає.</div> : (
        <div className="hr-tw">
          <table className="data-table compact" style={{ width: "100%" }}>
            <thead><tr><th></th><th className="num">Нових</th><th className="num">Співбесід</th><th className="num">Кандидат + команда</th><th className="num">Менеджер</th><th className="num">Відмов</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{r.added}</td><td className="num">{r.interviews}</td><td className="num">{r.candidates}</td><td className="num"><b>{r.managers}</b></td><td className="num">{r.refused}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {note && <div className="hr-muted" style={{ fontSize: 12, marginTop: 6 }}>{note}</div>}
    </div>
  );
}
