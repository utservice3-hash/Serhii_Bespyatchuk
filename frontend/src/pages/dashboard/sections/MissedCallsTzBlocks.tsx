import { useEffect, useMemo, useState } from "react";
import {
  fetchMissedNoCallback, createMissedTasks, fetchMissedWeek, fetchMissedNorm, saveMissedNorm,
  type MissedNoCallbackResp, type MissedTaskResult, type MissedWeekResp, type MissedNormResp, type MissedFilterParams,
} from "../../../api";
import { managersForTeams, type MissedFilter } from "../missedCallsView";

/**
 * 📵 ЕКРАН «ПРОПУЩЕНІ ДЗВІНКИ» — ТЗ Юлі 12.10.2026: фільтр «Команда / Менеджер» на весь екран, блок «Не передзвонили за
 * 24 год» з кнопкою «Поставити задачу менеджеру» (і масовою), звіт тижня з «Скопіювати для звіту», ціль у Налаштуваннях.
 * Визначення — ті самі, що на екрані (сервер, `missedNoCallbackRules`); тут лише вигляд. Стиль — той самий, що в решти
 * блоків екрана (`chart-card`, таблиця з тими самими клітинками).
 */
const MUTED = "var(--text-muted)";
const cell: React.CSSProperties = { padding: "7px 10px", whiteSpace: "nowrap", fontSize: 13 };
const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED, textAlign: "left" };
const btn: React.CSSProperties = { fontSize: 12.5, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", cursor: "pointer" };
const errText = (e: unknown) => {
  const ax = e as { response?: { data?: { error?: unknown } }; message?: string };
  return typeof ax?.response?.data?.error === "string" ? ax.response.data.error : ax?.message ?? "помилка";
};
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const kyiv = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/* ───────────── 👥 ФІЛЬТР ───────────── */

export function MissedFilterBar({ filter, onChange, teams, managers, teamLocked }: {
  filter: MissedFilter; onChange: (f: MissedFilter) => void;
  teams: { teamId: number | null; name: string }[];
  managers: { managerId: number | null; teamId: number | null; name: string }[];
  /** Тімлід: команду обрано сервером (своя), перемикати нічого — лишається лише «Менеджер». */
  teamLocked: boolean;
}) {
  const opts = useMemo(() => managersForTeams(managers, filter.teams), [managers, filter.teams]);
  const toggle = (k: string) => {
    const teamsNext = filter.teams.includes(k) ? filter.teams.filter((x) => x !== k) : [...filter.teams, k];
    const keep = filter.managerId != null && managersForTeams(managers, teamsNext).some((m) => m.managerId === filter.managerId);
    onChange({ teams: teamsNext, managerId: keep ? filter.managerId : null });
  };
  const chip = (k: string, label: string) => {
    const on = filter.teams.includes(k);
    return <button key={k} type="button" aria-pressed={on} onClick={() => toggle(k)}
      style={{ ...btn, borderRadius: 999, borderColor: on ? "#2563eb" : "var(--border)", background: on ? "rgba(37,99,235,.1)" : "var(--card-bg)", color: on ? "#2563eb" : "var(--text)" }}>{label}</button>;
  };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "8px 0 4px" }}>
      {!teamLocked && <>
        <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 600 }}>Команда:</span>
        {teams.filter((t) => t.teamId != null).map((t) => chip(String(t.teamId), t.name))}
        {chip("none", "Без відповідального")}
      </>}
      <span style={{ fontSize: 12.5, color: MUTED, fontWeight: 600, marginLeft: teamLocked ? 0 : 8 }}>Менеджер:</span>
      <select value={filter.managerId ?? ""} aria-label="Менеджер"
        onChange={(e) => onChange({ ...filter, managerId: e.target.value ? Number(e.target.value) : null })}>
        <option value="">усі</option>
        {opts.map((m) => <option key={String(m.managerId)} value={String(m.managerId)}>{m.name}</option>)}
      </select>
      {(filter.teams.length > 0 || filter.managerId != null) && (
        <button type="button" style={btn} onClick={() => onChange({ teams: [], managerId: null })}>Скинути</button>
      )}
    </div>
  );
}

/* ───────────── 📵 НЕ ПЕРЕДЗВОНИЛИ ЗА 24 ГОД + КНОПКА ЗАДАЧІ ───────────── */

export function NoCallbackBlock({ from, to, fp, managers }: {
  from: string; to: string; fp: MissedFilterParams;
  /** Менеджери на вибір для дзвінків без відповідального. */
  managers: { managerId: number | null; name: string }[];
}) {
  const [d, setD] = useState<MissedNoCallbackResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pick, setPick] = useState<Record<string, number>>({});
  const [res, setRes] = useState<Record<string, MissedTaskResult>>({});
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);
  const fpKey = JSON.stringify(fp);
  useEffect(() => {
    let alive = true; setErr(null);
    fetchMissedNoCallback({ from, to, ...fp }).then((x) => { if (alive) { setD(x); setSel(new Set()); } }).catch((e) => { if (alive) setErr(errText(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, fpKey, rev]);

  const assign = async (ids: string[]) => {
    const items = ids.map((u) => ({ uniqueid: u, ...(pick[u] ? { managerId: pick[u] } : {}) }));
    setBusy(true);
    try {
      const out = await createMissedTasks(items);
      setRes((r) => ({ ...r, ...Object.fromEntries(out.map((x) => [x.uniqueid, x])) }));
      setRev((x) => x + 1);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  const title = <h2 className="chart-title" style={{ margin: 0 }}>📵 Не передзвонили за 24 год {d && <span style={{ color: d.rows.length ? "#dc2626" : MUTED }}>· {d.rows.length}{d.truncated ? "+" : ""}</span>}</h2>;
  if (err && !d) return <div className="chart-card">{title}<p style={{ color: "#dc2626", margin: "6px 0 0" }}>{err}</p></div>;
  if (!d) return <div className="chart-card">{title}<p className="loading-text" style={{ margin: "6px 0 0" }}>Завантаження…</p></div>;
  const selectable = d.rows.filter((r) => r.task.state === "none");
  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {title}
        {d.canAssign && sel.size > 0 && (
          <button type="button" disabled={busy} onClick={() => { void assign([...sel]); }}
            style={{ ...btn, background: "#c8102e", color: "#fff", border: "none" }}>Поставити задачі обраним ({sel.size})</button>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: MUTED, margin: "4px 0 8px" }}>
        Пропущений, після якого минуло 24 год і з цим номером досі немає розмови від 10 с (ні нашого передзвону, ні вхідного від клієнта).
        Перевізники — поза списком. Рядок зникає сам, щойно з'являється розмова. Найстаріші — зверху.
      </p>
      {err && <p role="alert" style={{ color: "#dc2626", fontSize: 12.5, margin: "0 0 6px" }}>⚠️ {err}</p>}
      {d.rows.length === 0 ? <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>За період таких дзвінків немає.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ minWidth: 980 }}>
            <thead><tr>
              {d.canAssign && <th style={head}><input type="checkbox" aria-label="Обрати всі"
                checked={selectable.length > 0 && selectable.every((r) => sel.has(r.uniqueid))}
                onChange={(e) => setSel(e.target.checked ? new Set(selectable.map((r) => r.uniqueid)) : new Set())} /></th>}
              <th style={head}>Пропущений</th><th style={{ ...head, textAlign: "right" }}>Минуло, год</th><th style={head}>Номер</th>
              <th style={head}>Клієнт і угода</th><th style={head}>Відповідальний</th><th style={head}>Команда</th>
              <th style={head}>Задача</th>{d.canAssign && <th style={head} />}
            </tr></thead>
            <tbody>
              {d.rows.map((r) => {
                const done = res[r.uniqueid];
                return (
                  <tr key={r.uniqueid}>
                    {d.canAssign && <td style={cell}>{r.task.state === "none" && (
                      <input type="checkbox" aria-label="Обрати" checked={sel.has(r.uniqueid)}
                        onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(r.uniqueid); else n.delete(r.uniqueid); return n; })} />)}</td>}
                    <td style={cell}>{kyiv(r.at)}{r.missedN > 1 && <span style={{ color: MUTED }}> · {r.missedN} рази</span>}</td>
                    <td style={{ ...cell, textAlign: "right", color: r.hours >= 48 ? "#dc2626" : undefined, fontWeight: 600 }}>{r.hours}</td>
                    <td style={cell}>{r.phone}</td>
                    <td style={{ ...cell, whiteSpace: "normal", minWidth: 180 }}>
                      {r.clientName ?? <span style={{ color: MUTED }}>клієнт невідомий</span>}
                      {r.dealUrl && <> · <a href={r.dealUrl} target="_blank" rel="noreferrer">угода ↗</a></>}
                    </td>
                    <td style={cell}>{r.managerName ?? <span style={{ color: MUTED }}>без відповідального</span>}</td>
                    <td style={cell}>{r.teamName ?? <span style={{ color: MUTED }}>—</span>}</td>
                    <td style={cell}>{r.task.state === "none" ? <span style={{ color: MUTED }}>немає</span>
                      : <a href={`/tasks?id=${String(r.task.id)}`} style={{ color: r.task.state === "overdue" ? "#dc2626" : "#2563eb" }}>
                          {r.task.state === "overdue" ? "прострочена" : "відкрита"}{r.task.deadline ? ` · до ${ddmm(r.task.deadline)}` : ""}</a>}</td>
                    {d.canAssign && <td style={cell}>
                      {done?.result === "error" ? <span style={{ color: "#dc2626", fontSize: 12 }}>{done.error}</span>
                        : done?.result === "exists" ? <span style={{ fontSize: 12 }}>Задача вже є{done.deadline ? ` · до ${ddmm(done.deadline)}` : ""}</span>
                        : r.task.state === "none" && (
                          // Вибір менеджера — НАД кнопкою, а не поруч: поруч кнопка виїжджала за правий край таблиці (прод 16.10.2026).
                          <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                            {r.managerId == null && (
                              <select value={pick[r.uniqueid] ?? ""} aria-label="Кому поставити" style={{ maxWidth: 210 }} onChange={(e) => setPick((p) => ({ ...p, [r.uniqueid]: Number(e.target.value) }))}>
                                <option value="">— менеджер —</option>
                                {managers.filter((m) => m.managerId != null).map((m) => <option key={String(m.managerId)} value={String(m.managerId)}>{m.name}</option>)}
                              </select>)}
                            <button type="button" style={btn} disabled={busy || (r.managerId == null && !pick[r.uniqueid])}
                              onClick={() => { void assign([r.uniqueid]); }}>Поставити задачу менеджеру</button>
                          </span>)}
                    </td>}
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

/* ───────────── 📊 ЗВІТ ТИЖНЯ ───────────── */

const mondayOf = (day: string) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const shiftWeek = (monday: string, n: number) => { const d = new Date(`${monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n * 7); return d.toISOString().slice(0, 10); };

export function MissedWeekBlock({ today, fp }: { today: string; fp: MissedFilterParams }) {
  const [monday, setMonday] = useState(() => shiftWeek(mondayOf(today), -1));
  const [d, setD] = useState<MissedWeekResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fpKey = JSON.stringify(fp);
  useEffect(() => {
    let alive = true; setErr(null); setD(null);
    fetchMissedWeek({ week: monday, ...fp }).then((x) => { if (alive) setD(x); }).catch((e) => { if (alive) setErr(errText(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday, fpKey]);
  const copy = async () => {
    if (!d) return;
    try { await navigator.clipboard.writeText(d.text); setCopied("Скопійовано"); }
    catch { setCopied(d.text); }
  };
  const p = (v: number | null) => (v == null ? "—" : `${String(v)}%`);
  const thisMonday = mondayOf(today);
  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 className="chart-title" style={{ margin: 0 }}>📊 Звіт тижня {d && <span style={{ color: MUTED, fontWeight: 400 }}>{ddmm(d.week.from)}–{ddmm(d.week.to)}</span>}</h2>
        <span style={{ display: "inline-flex", gap: 6 }}>
          <button type="button" style={btn} onClick={() => setMonday(shiftWeek(monday, -1))}>‹ попередній</button>
          <button type="button" style={btn} disabled={monday >= thisMonday} onClick={() => setMonday(shiftWeek(monday, 1))}>наступний ›</button>
          <button type="button" style={btn} disabled={!d} onClick={() => { void copy(); }}>Скопіювати для звіту</button>
        </span>
      </div>
      {copied && copied !== "Скопійовано" && <textarea readOnly value={copied} style={{ width: "100%", minHeight: 120, marginTop: 8, fontSize: 12 }} />}
      {copied === "Скопійовано" && <p style={{ fontSize: 12, color: "#16a34a", margin: "4px 0 0" }}>Скопійовано — вставте в чат.</p>}
      {err && <p role="alert" style={{ color: "#dc2626", margin: "6px 0 0" }}>{err}</p>}
      {!d && !err && <p className="loading-text" style={{ margin: "6px 0 0" }}>Завантаження…</p>}
      {d && (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table className="data-table" style={{ minWidth: 860 }}>
            <thead><tr>
              <th style={head}>Команда</th><th style={{ ...head, textAlign: "right" }}>Пропущено</th>
              <th style={{ ...head, textAlign: "right" }}>Передзвонили за 24 год</th><th style={{ ...head, textAlign: "right" }}>Медіана, хв</th>
              <th style={{ ...head, textAlign: "right" }}>Не передзвонили</th><th style={{ ...head, textAlign: "right" }}>Минулий тиждень</th>
              <th style={{ ...head, textAlign: "right" }}>Зміна</th><th style={{ ...head, textAlign: "right" }}>Ціль</th><th style={head}>Статус</th>
            </tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.key} style={r.key === "dept" ? { fontWeight: 700, background: "var(--bg, #f6f6f7)" } : undefined}>
                  <td style={cell}>{r.name}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{r.missed}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{p(r.pct)}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{r.medianMin ?? "—"}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{r.noCallback}</td>
                  <td style={{ ...cell, textAlign: "right", color: MUTED }}>{p(r.prevPct)}</td>
                  <td style={{ ...cell, textAlign: "right", color: r.change == null ? MUTED : r.change >= 0 ? "#16a34a" : "#dc2626" }}>{r.change == null ? "—" : `${r.change > 0 ? "+" : ""}${String(r.change)} п.п.`}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{d.norm == null ? "—" : `${String(d.norm)}%`}</td>
                  <td style={cell}>{r.status === "ok" ? <span style={{ color: "#16a34a" }}>у нормі</span>
                    : r.status === "below" ? <span style={{ color: "#dc2626", fontWeight: 600 }}>нижче норми</span>
                    : <span style={{ color: MUTED }}>{r.status === "no_norm" ? "ціль не задана" : "немає даних"}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ───────────── 🎯 ЦІЛЬ (картка для «Налаштувань» і підпис біля метрики) ───────────── */

function useMissedNorm(): [MissedNormResp | null, () => void] {
  const [n, setN] = useState<MissedNormResp | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { fetchMissedNorm().then(setN).catch(() => setN(null)); }, [rev]);
  return [n, () => setRev((x) => x + 1)];
}

export function MissedNormCard() {
  const [n, reload] = useMissedNorm();
  const [v, setV] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await saveMissedNorm(Number(v)); setMsg("Збережено"); setV(""); reload(); }
    catch (e) { setMsg(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>📵 Ціль: передзвонили за 24 год, %</h2>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        Зараз: <b>{n?.norm == null ? "не задана" : `${String(n.norm)}%`}</b>
        {n?.setBy && <span style={{ color: MUTED }}> · встановив {n.setBy}{n.setAt ? `, ${kyiv(n.setAt)}` : ""}</span>}
      </p>
      {n?.canSet ? (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="number" min={1} max={100} value={v} onChange={(e) => setV(e.target.value)} placeholder="%" style={{ width: 80 }} aria-label="Ціль, %" />
          <button type="button" style={btn} disabled={busy || !v} onClick={() => { void save(); }}>Зберегти</button>
        </span>
      ) : <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>Змінює лише керівництво (адмін, операційний директор, CEO, КВП).</p>}
      {msg && <p style={{ fontSize: 12.5, margin: "6px 0 0", color: msg === "Збережено" ? "#16a34a" : "#dc2626" }}>{msg}</p>}
    </div>
  );
}
