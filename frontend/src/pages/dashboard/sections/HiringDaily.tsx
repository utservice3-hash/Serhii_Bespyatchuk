import { useCallback, useEffect, useState } from "react";
import { fetchHiringDaily, saveHiringDaily, saveHiringOverride, saveHiringWeekOverride, fetchHiringWeekPlan, saveHiringWeekPlan, hiringError,
  type HiringDailyRow, type HiringOverrideMetric, type HiringPlanMetric, type HiringWeekMetric, type HiringWeekPlan, type HiringDailyWeek } from "../../../api";
import { todayKyiv, addDays, longDate, dm, dowOf, isWeekend, pct, presetRange } from "../hiringView";
import type { Toast } from "./HiringShared";

/**
 * 📊 «ЩОДЕННИЙ ЗВІТ» — замість «Щоденний звіт NEW», у стилі картки «Продуктивність за день».
 * Руками вводяться лише два числа, яких немає ні в графіку, ні в базі: оброблені резюме й
 * холодний пошук. Решта рахується сервером (визначення — `dailyReport` у `core/hiring.ts`):
 *  • призначено — співбесіди, заплановані на день;
 *  • проведено — позначки «прийшов», поставлені цього дня (рішення 17.09);
 *  • явка — прийшли ÷ заплановано, за період — із сум, а не середнє відсотків (#502b).
 */
type Totals = Omit<HiringDailyRow, "day"> & { attendancePct: number | null };

const PRESETS: [string, string][] = [["today", "Сьогодні"], ["yesterday", "Вчора"], ["week", "Цей тиждень"], ["lastweek", "Минулий тиждень"], ["month", "Цей місяць"], ["lastmonth", "Минулий місяць"]];

export function HiringDaily({ toast }: { toast: Toast }) {
  const today = todayKyiv();
  const [p, setP] = useState<{ preset: string; from: string; to: string }>({ preset: "today", ...presetRange("today", today) });
  const [data, setData] = useState<{ rows: HiringDailyRow[]; totals: Totals; week?: HiringDailyWeek } | null>(null);
  const [trend, setTrend] = useState<HiringDailyRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const single = p.from === p.to;

  const load = useCallback(() => {
    let alive = true;
    const trendTo = p.to > today ? today : p.to;
    Promise.all([fetchHiringDaily(p.from, p.to), fetchHiringDaily(addDays(trendTo, -13), trendTo)])
      .then(([d, t]) => { if (alive) { setData(d); setTrend(t.rows); setErr(null); } })
      .catch((e) => { if (alive) setErr(hiringError(e)); });
    return () => { alive = false; };
  }, [p.from, p.to, today]);
  useEffect(load, [load]);

  const saveManual = async (day: string, field: "resumes" | "coldSearch", raw: string, prev: number) => {
    const v = raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(v) || v < 0) { toast("Кількість — ціле число від 0", { error: true }); load(); return; }
    if (v === prev) return;
    try { await saveHiringDaily(day, { [field]: v }); toast(`Збережено за ${dm(day)}`); load(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };

  // 📊 Ручне виправлення плитки за день (#2101, рішення Романа): число замінює авто лише тут, авто видно поруч.
  // 📊 #2104: у вигляді одного тижня («цей / минулий тиждень») «✎» правит число за ВЕСЬ тиждень — на планерці
  // Іван звітує тижнем. Дні й місяць лишаються сумою днів.
  const [editing, setEditing] = useState<HiringWeekMetric | null>(null);
  const week = !single ? data?.week : undefined;
  const saveOverride = async (metric: HiringWeekMetric, raw: string | null) => {
    const v = raw === null ? null : raw.trim() === "" ? null : Number(raw);
    if (v !== null && (!Number.isInteger(v) || v < 0)) { toast("Кількість — ціле число від 0", { error: true }); return; }
    try {
      if (week) await saveHiringWeekOverride(week.weekStart, metric, v);
      else await saveHiringOverride(p.from, metric as HiringOverrideMetric, v);
      const what = week ? `за тиждень з ${dm(week.weekStart)}` : `за ${dm(p.from)}`;
      toast(v === null ? `Повернуто авто ${what}` : `Виправлено вручну ${what}`); setEditing(null); load();
    } catch (e) { toast(hiringError(e), { error: true }); }
  };
  const dayRow = single ? data?.rows[0] : undefined;
  /** Значення плитки з «✎»: один день — число дня; один тиждень — число тижня; інший період — без правки. */
  const ov = (metric: HiringWeekMetric, value: React.ReactNode) => {
    const cur = week ? data?.totals[metric] : dayRow && metric !== "resumes" && metric !== "coldSearch" ? dayRow[metric] : undefined;
    if (cur === undefined) return value;
    const manual = week ? week.manual.includes(metric) : dayRow?.manual?.includes(metric as HiringOverrideMetric);
    const auto = week ? week.auto[metric] : dayRow?.auto?.[metric as HiringOverrideMetric];
    if (editing === metric) return (
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <input autoFocus className="hr-inp" type="number" min={0} defaultValue={cur} style={{ width: 90, fontSize: 20, fontWeight: 680, padding: "2px 6px" }}
          onKeyDown={(e) => { if (e.key === "Enter") void saveOverride(metric, (e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(null); }}
          id={`ov-${metric}`} />
        <button className="hr-btn xs p" onClick={() => void saveOverride(metric, (document.getElementById(`ov-${metric}`) as HTMLInputElement)?.value ?? "")}>OK</button>
        <button className="hr-btn xs" onClick={() => setEditing(null)}>✕</button>
      </span>
    );
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
        {value}
        <button className="hr-btn xs" title={week ? "Виправити число за весь тиждень" : "Виправити вручну"} onClick={() => setEditing(metric)}>✎</button>
        {manual && <span className="hr-manual" title={`Система нарахувала ${auto ?? "—"}`}>{week ? "вручну за тиждень" : "вручну"} · авто {auto ?? "—"}</span>}
        {manual && <button className="hr-btn xs" title={week ? "Повернути суму днів" : "Повернути число системи"} onClick={() => void saveOverride(metric, null)}>авто</button>}
      </span>
    );
  };

  const setDay = (d: string) => setP({ preset: d === today ? "today" : d === addDays(today, -1) ? "yesterday" : "", from: d, to: d });
  const t = data?.totals;
  const att = t?.attendancePct ?? null;
  const col = (v: number | null) => (v == null ? "var(--text-muted)" : v >= 70 ? "#16a34a" : v >= 50 ? "#d97706" : "#dc2626");
  const maxT = Math.max(1, ...trend.map((r) => r.done));

  const manualInput = (field: "resumes" | "coldSearch", value: number) => (
    <input key={`${p.from}-${field}-${value}`} className="hr-inp" type="number" min={0} defaultValue={value}
      style={{ width: 100, fontSize: 22, fontWeight: 680, padding: "2px 8px" }}
      onBlur={(e) => void saveManual(p.from, field, e.target.value, value)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
  const tile = (label: string, value: React.ReactNode, sub: string, extra?: React.ReactNode, manual = false) => (
    <div className="hr-tile">
      <div className="lb"><span>{label}</span>{manual && <span className="hr-manual">вручну</span>}</div>
      <div className="vl">{value}</div>
      <div className="sb">{sub}</div>
      {extra}
    </div>
  );

  const fun: [string, number][] = t ? [
    ["Оброблено резюме", t.resumes], ["Призначено співбесід", t.planned], ["Проведено", t.done],
    ["Співбесіда з тімлідом", t.toLead], ["Кандидат + команда", t.toCandidate], ["На навчанні", t.toTraining], ["Вийшли (менеджер)", t.toManager],
  ] : [];
  const top = Math.max(1, ...fun.map(([, v]) => v));

  return (
    <div>
      <div className="hr-pills">
        {PRESETS.map(([k, l]) => <button key={k} className={p.preset === k ? "on" : ""} onClick={() => setP({ preset: k, ...presetRange(k, today) })}>{l}</button>)}
        <input className="hr-inp" type="date" value={p.from} onChange={(e) => e.target.value && setP({ preset: "", from: e.target.value, to: p.to < e.target.value ? e.target.value : p.to })} />
        <span className="hr-muted">–</span>
        <input className="hr-inp" type="date" value={p.to} onChange={(e) => e.target.value && setP({ preset: "", from: p.from > e.target.value ? e.target.value : p.from, to: e.target.value })} />
      </div>

      {err && <div className="chart-card" style={{ color: "var(--danger)" }}>{err}</div>}

      <div className="hr-card">
        <div className="hd">
          <div><h3>Щоденний звіт найму</h3><div className="hr-muted">{single ? longDate(p.from) : `${dm(p.from)} – ${dm(p.to)} · ${data?.rows.length ?? "…"} дн.`}</div></div>
          {single && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button className="hr-nav" onClick={() => setDay(addDays(p.from, -1))} title="Попередній день">‹</button>
              <button className="hr-nav" style={{ fontWeight: 650 }} onClick={() => setDay(today)}>{p.from === today ? "Сьогодні" : longDate(p.from)}</button>
              <button className="hr-nav" onClick={() => setDay(addDays(p.from, 1))} disabled={p.from >= today} style={{ opacity: p.from >= today ? 0.4 : 1 }} title="Наступний день">›</button>
            </div>
          )}
        </div>
        {!t ? <p className="loading-text" style={{ padding: 16 }}>Завантаження…</p> : (
          <>
            <div className="hr-tiles">
              {tile("Оброблено резюме", single ? manualInput("resumes", t.resumes) : ov("resumes", t.resumes), single ? "введіть за день" : week ? "за тиждень" : "сума за період", undefined, true)}
              {tile("Призначено співбесід", ov("planned", t.planned), `записано в графік цього ${single ? "дня" : "періоду"}: ${t.booked}`)}
              {tile("Проведено", <>{ov("done", t.done)} <span style={{ fontSize: 15, fontWeight: 650, color: col(att) }}>{att == null ? "" : `${att} %`}</span></>,
                t.planned ? `явка: ${t.done} із ${t.planned} запланованих · не прийшли ${t.noshow}` : `запланованих немає · не прийшли ${t.noshow}`,
                <div className="hr-bar"><i style={{ width: `${Math.min(100, att ?? 0)}%`, background: col(att) }} /></div>)}
              {tile("Холодний пошук", single ? manualInput("coldSearch", t.coldSearch) : ov("coldSearch", t.coldSearch), single ? "контактів за день" : week ? "за тиждень" : "сума за період", undefined, true)}
              {tile("Співбесіда з тімлідом", ov("toLead", t.toLead), single ? "переведено цього дня" : "переведено за період")}
              {tile("Кандидат + команда", ov("toCandidate", t.toCandidate), "рішення після тімліда")}
              {tile("На навчанні", ov("toTraining", t.toTraining), t.done ? `${pct(t.toTraining, t.done)} % від проведених` : "від проведених")}
              {tile("Вийшли на роботу", ov("toManager", t.toManager), "статус «менеджер»")}
            </div>
            <div className="hr-sect">
              <h4>Воронка {single ? "дня" : "періоду"}</h4>
              <div className="hr-fun">
                {fun.map(([l, v], i) => (
                  <div key={l} style={{ display: "contents" }}>
                    <span>{l}</span>
                    <div className="b"><i style={{ width: `${Math.round((v / top) * 100)}%` }} /></div>
                    <span style={{ textAlign: "right" }}><b>{v}</b>{i > 1 && fun[i - 1][1] ? <span className="hr-muted"> {pct(v, fun[i - 1][1])} %</span> : null}</span>
                  </div>
                ))}
              </div>
              <div className="hr-muted" style={{ marginTop: 8 }}>Етапи рахуються за днем події, тож за короткий період наступний етап може бути більшим за попередній: кандидати приходять із минулих днів.</div>
            </div>
            {trend.length > 0 && (
              <div className="hr-sect">
                <h4>Проведені співбесіди — останні 14 днів</h4>
                <div className="hr-trend">
                  {trend.map((r, i) => <i key={r.day} className={i === trend.length - 1 ? "last" : ""} title={`${dm(r.day)}: ${r.done}`} style={{ height: `${Math.max(4, (r.done / maxT) * 100)}%` }} />)}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-muted)", marginTop: 6 }}>
                  <span>{dm(trend[0].day)}</span><span>{dm(trend[trend.length - 1].day)}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {!single && data && (
        <div className="hr-card">
          <div className="hd"><div><h3>По днях</h3><div className="hr-muted">Резюме й холодний пошук редагуються в клітинці; решта рахується з графіка й бази, а виправлене вручну (✎ на плитках дня) позначено курсивом</div></div></div>
          {data.week && data.week.manual.length > 0 && (
            <div className="hr-note" style={{ margin: "0 16px 10px" }}>
              Тиждень виправлено вручну: {data.week.manual.map((m) => `${WEEK_LABEL[m]} ${data.totals[m]} (сума днів ${data.week!.auto[m] ?? "—"})`).join(" · ")}. У рядку «Разом» — ці числа; дні нижче — як нарахувала система.
            </div>
          )}
          <div className="hr-tw">
            <table className="hr-table">
              <thead><tr>
                <th>Дата</th><th className="num">Резюме</th><th className="num">Призначено</th><th className="num">Проведено</th><th className="num">Явка</th>
                <th className="num">Не прийшли</th><th className="num">З тімлідом</th><th className="num">Кандидат</th><th className="num">Навчання</th><th className="num">Вийшли</th><th className="num">Холодний пошук</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.day} className={isWeekend(r.day) ? "we" : ""}>
                    <td><button className="hr-link" onClick={() => setDay(r.day)}>{dowOf(r.day)} {dm(r.day)}</button></td>
                    <td className="num"><input key={`${r.day}-res-${r.resumes}`} className="hr-inp" type="number" min={0} style={{ width: 70, textAlign: "right" }} defaultValue={r.resumes} onBlur={(e) => void saveManual(r.day, "resumes", e.target.value, r.resumes)} /></td>
                    <td className="num">{mc(r, "planned")}</td><td className="num">{mc(r, "done")}</td>
                    <td className="num hr-muted">{pct(r.done, r.planned) == null ? "—" : `${pct(r.done, r.planned)} %`}</td>
                    <td className="num">{r.noshow}</td><td className="num">{mc(r, "toLead")}</td><td className="num">{mc(r, "toCandidate")}</td><td className="num">{mc(r, "toTraining")}</td><td className="num">{mc(r, "toManager")}</td>
                    <td className="num"><input key={`${r.day}-cold-${r.coldSearch}`} className="hr-inp" type="number" min={0} style={{ width: 70, textAlign: "right" }} defaultValue={r.coldSearch} onBlur={(e) => void saveManual(r.day, "coldSearch", e.target.value, r.coldSearch)} /></td>
                  </tr>
                ))}
                {t && (
                  <tr className="tot">
                    <td>Разом</td><td className="num">{t.resumes}</td><td className="num">{t.planned}</td><td className="num">{t.done}</td>
                    <td className="num">{att == null ? "—" : `${att} %`}</td><td className="num">{t.noshow}</td><td className="num">{t.toLead}</td><td className="num">{t.toCandidate}</td>
                    <td className="num">{t.toTraining}</td><td className="num">{t.toManager}</td><td className="num">{t.coldSearch}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <WeekPlanCard day={p.from} toast={toast} stamp={data} />
    </div>
  );
}

/** Клітинка таблиці «По днях»: ручне число — курсивом, системне — у підказці. */
const mc = (r: HiringDailyRow, m: HiringOverrideMetric) =>
  r.manual?.includes(m) ? <i title={`вручну · система нарахувала ${r.auto?.[m] ?? "—"}`}>{r[m]}✎</i> : r[m];

const WEEK_LABEL: Record<HiringWeekMetric, string> = {
  resumes: "Резюме", coldSearch: "Холодний пошук", planned: "Призначено", done: "Проведено",
  toLead: "З тімлідом", toCandidate: "Кандидат + команда", toTraining: "Навчання", toManager: "Вийшли",
};

const PLAN_LABEL: [HiringPlanMetric, string][] = [
  ["planned", "Призначено співбесід"], ["done", "Проведено"],
  ["toLead", "Співбесіда з тімлідом"], ["toCandidate", "Кандидат + команда"], ["toTraining", "На навчанні"], ["toManager", "Вийшли на роботу"],
];

/**
 * 📊 ПЛАН / ФАКТ ТИЖНЯ (#2102, рішення Романа: «всі 8 показників», ставлять HR і адміни). Факт — сума днів тижня
 * з цього ж звіту (ручні виправлення враховано), тож план і плитки говорять про ті самі числа.
 */
function WeekPlanCard({ day, toast, stamp }: { day: string; toast: Toast; stamp: unknown }) {
  const [anchor, setAnchor] = useState(day);
  useEffect(() => setAnchor(day), [day]);
  const [w, setW] = useState<HiringWeekPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { fetchHiringWeekPlan(anchor).then((x) => { setW(x); setErr(null); }).catch((e) => setErr(hiringError(e))); }, [anchor]);
  useEffect(load, [load, stamp]);
  const save = async (m: HiringPlanMetric, raw: string) => {
    const v = raw.trim() === "" ? null : Number(raw);
    if (v !== null && (!Number.isInteger(v) || v < 0)) { toast("План — ціле число від 0", { error: true }); load(); return; }
    if (w && w.plans[m] === v) return;
    try { await saveHiringWeekPlan(anchor, { [m]: v }); toast("План збережено"); load(); }
    catch (e) { toast(hiringError(e), { error: true }); load(); }
  };
  const copyPrev = async () => {
    try {
      const prev = await fetchHiringWeekPlan(addDays(w?.weekStart ?? anchor, -7));
      const plans = Object.fromEntries(Object.entries(prev.plans).filter(([, v]) => v != null)) as Partial<Record<HiringPlanMetric, number>>;
      if (!Object.keys(plans).length) { toast("Минулого тижня плану не було", { error: true }); return; }
      await saveHiringWeekPlan(anchor, plans); toast("План скопійовано з минулого тижня"); load();
    } catch (e) { toast(hiringError(e), { error: true }); }
  };
  if (err) return <div className="hr-card"><div className="hd"><h3>План / факт тижня</h3></div><p className="hr-muted" style={{ padding: 16 }}>{err}</p></div>;
  return (
    <div className="hr-card">
      <div className="hd">
        <div><h3>План / факт тижня</h3><div className="hr-muted">{w ? `${dm(w.weekStart)} – ${dm(w.weekEnd)}` : "…"} · факт — із цього звіту, разом із ручними виправленнями</div></div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button className="hr-nav" onClick={() => setAnchor(addDays(w?.weekStart ?? anchor, -7))} title="Попередній тиждень">‹</button>
          <button className="hr-nav" onClick={() => setAnchor(addDays(w?.weekStart ?? anchor, 7))} title="Наступний тиждень">›</button>
          <button className="hr-btn xs" onClick={() => void copyPrev()}>Як минулого тижня</button>
        </div>
      </div>
      {!w ? <p className="loading-text" style={{ padding: 16 }}>Завантаження…</p> : (
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>Показник</th><th className="num">План</th><th className="num">Факт</th><th className="num">Виконання</th></tr></thead>
            <tbody>
              {PLAN_LABEL.map(([m, label]) => {
                const plan = w.plans[m], fact = w.fact[m];
                const p = plan ? pct(fact, plan) : null;
                return (
                  <tr key={m}>
                    <td>{label}</td>
                    <td className="num"><input key={`${w.weekStart}-${m}-${plan ?? ""}`} className="hr-inp" type="number" min={0} placeholder="—" style={{ width: 80, textAlign: "right" }}
                      defaultValue={plan ?? ""} onBlur={(e) => void save(m, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></td>
                    <td className="num"><b>{fact}</b></td>
                    <td className="num" style={{ color: p == null ? "var(--text-muted)" : p >= 100 ? "#16a34a" : p >= 70 ? "#d97706" : "#dc2626" }}>{plan == null ? "плану немає" : `${p} %`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
