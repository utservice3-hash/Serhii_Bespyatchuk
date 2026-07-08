import { useEffect, useMemo, useState } from "react";
import {
  fetchOneOnOneSubjects, fetchOneOnOne, saveOneOnOne, fetchOneOnOneStats,
  type OneOnOneSubject, type OneOnOneAnswers, type OneOnOneStatRow,
} from "../../../api";
import { DatePicker } from "../../../components/DatePicker";

/** Покращений набір питань — щоб глибше розкрити менеджера (результат, клієнти,
 *  стан/мотивація, розвиток, домовленості). score = оцінка 1..10, text = вільна. */
const QUESTIONS: { key: string; group: string; label: string; type: "score" | "text" }[] = [
  { key: "prev", group: "Огляд", label: "Що з домовленостей минулої зустрічі виконано, що ні?", type: "text" },
  { key: "result_score", group: "Результати", label: "Наскільки ти задоволений своїм результатом за місяць (виконання плану)?", type: "score" },
  { key: "result_factors", group: "Результати", label: "Що найбільше допомогло / завадило досягти цілей?", type: "text" },
  { key: "intake_score", group: "Результати", label: "Наскільки якісно ти опрацьовуєш вхідні заявки (швидкість, дотиск)?", type: "score" },
  { key: "repeat_score", group: "Клієнти та процеси", label: "Наскільки добре ти утримуєш і розвиваєш постійних клієнтів?", type: "score" },
  { key: "client_challenges", group: "Клієнти та процеси", label: "Які виклики в роботі з клієнтами зараз найгостріші?", type: "text" },
  { key: "process_blockers", group: "Клієнти та процеси", label: "Що в процесах / інструментах сповільнює тебе найбільше?", type: "text" },
  { key: "energy_score", group: "Мотивація та стан", label: "Оціни свій рівень енергії та залученості зараз.", type: "score" },
  { key: "motivation", group: "Мотивація та стан", label: "Що тебе зараз найбільше мотивує / демотивує?", type: "text" },
  { key: "retention_score", group: "Мотивація та стан", label: "Наскільки ймовірно, що ти працюватимеш тут через рік?", type: "score" },
  { key: "growth_gap", group: "Розвиток", label: "Яких навичок / знань тобі бракує для наступного рівня?", type: "text" },
  { key: "growth_dir", group: "Розвиток", label: "Куди ти хочеш рости (роль / напрям)?", type: "text" },
  { key: "support_score", group: "Розвиток", label: "Наскільки ти отримуєш підтримку й визнання в роботі?", type: "score" },
  { key: "summary", group: "Домовленості", label: "Головні висновки зустрічі.", type: "text" },
  { key: "action_plan", group: "Домовленості", label: "План дій до наступної зустрічі (конкретні кроки).", type: "text" },
  { key: "overall_score", group: "Домовленості", label: "ЗАГАЛЬНА оцінка місяця (підсумок).", type: "score" },
];
const GROUPS = [...new Set(QUESTIONS.map((q) => q.group))];
const SCORE_QS = QUESTIONS.filter((q) => q.type === "score");

const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };
const scoreColor = (v: number | null) => (v == null ? "var(--text-muted)" : v >= 8 ? "#16a34a" : v >= 6 ? "#d97706" : "#dc2626");

function ScorePicker({ value, onChange }: { value?: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
        <button key={n} onClick={() => onChange(n)}
          style={{ width: 28, height: 28, borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 13,
            border: `1px solid ${value === n ? scoreColor(n) : "var(--border)"}`,
            background: value === n ? scoreColor(n) : "var(--card-bg)", color: value === n ? "#fff" : "var(--text)" }}>
          {n}
        </button>
      ))}
    </div>
  );
}

export function OneOnOneSection({ role }: { role?: string }) {
  const [tab, setTab] = useState<"conduct" | "stats">("conduct");
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("o2oMonth") || curMonthStr());
  const [subjects, setSubjects] = useState<OneOnOneSubject[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<OneOnOneAnswers>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [stats, setStats] = useState<OneOnOneStatRow[]>([]);

  const loadSubjects = () => fetchOneOnOneSubjects(monthSel).then((d) => setSubjects(d.subjects)).catch(() => setSubjects([]));
  useEffect(() => { void loadSubjects(); }, [monthSel]);
  useEffect(() => { if (tab === "stats") fetchOneOnOneStats(6).then(setStats).catch(() => setStats([])); }, [tab, monthSel]);

  useEffect(() => {
    if (selId == null) return;
    fetchOneOnOne(selId, monthSel).then((r) => { setAnswers(r.answers || {}); setSavedAt(r.updated_at ?? null); }).catch(() => setAnswers({}));
  }, [selId, monthSel]);

  const setAns = (key: string, patch: { score?: number; text?: string }) =>
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const liveOverall = useMemo(() => {
    const s = SCORE_QS.map((q) => answers[q.key]?.score).filter((x): x is number => typeof x === "number" && x > 0);
    return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null;
  }, [answers]);

  const save = async () => {
    if (selId == null) return;
    setSaving(true);
    try { await saveOneOnOne(selId, monthSel, answers); setSavedAt(new Date().toISOString()); await loadSubjects(); }
    finally { setSaving(false); }
  };

  const pickMonth = (v: string) => { if (!v || v > curMonthStr()) return; setMonthSel(v); localStorage.setItem("o2oMonth", v); setSelId(null); };
  const selected = subjects.find((s) => s.id === selId);

  // Групування списку по командах.
  const byTeam = useMemo(() => {
    const m = new Map<string, OneOnOneSubject[]>();
    for (const s of subjects) { const k = s.team_name || "Без команди"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); }
    return [...m.entries()];
  }, [subjects]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🤝 Ван-ту-ван</h1>
        <div className="page-filters" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {(["conduct", "stats"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontWeight: tab === t ? 700 : 500,
                  border: `1px solid ${tab === t ? "#c5141c" : "var(--border)"}`, background: tab === t ? "#c5141c" : "var(--card-bg)", color: tab === t ? "#fff" : "var(--text)" }}>
                {t === "conduct" ? "Провести" : "Статистика оцінок"}
              </button>
            ))}
          </div>
          <DatePicker mode="month" value={monthSel} onChange={(v) => v && pickMonth(v)} minWidth={150} />
        </div>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 820 }}>
        Щомісячні зустрічі 1-на-1. {role === "admin" ? "Ви бачите всі команди й тімлідів." : "Ви бачите свою команду."} Менеджери цей розділ не бачать. На початку місяця кожному тімліду ставиться задача провести ван-ту-вани.
      </p>

      {tab === "conduct" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) 1fr", gap: 16, alignItems: "start" }}>
          {/* Список працівників */}
          <div className="chart-card" style={{ padding: 12 }}>
            {byTeam.length === 0 && <p className="loading-text" style={{ margin: 0 }}>Немає працівників.</p>}
            {byTeam.map(([team, list]) => (
              <div key={team} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)", fontWeight: 700, margin: "4px 0" }}>{team}</div>
                {list.map((s) => (
                  <button key={s.id} onClick={() => setSelId(s.id)}
                    style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 10px", borderRadius: 8, marginBottom: 3, cursor: "pointer", textAlign: "left",
                      border: `1px solid ${selId === s.id ? "#c5141c" : "transparent"}`, background: selId === s.id ? "rgba(197,20,28,0.06)" : "transparent", color: "var(--text)" }}>
                    <span style={{ fontSize: 14 }}>{s.is_team_lead ? "👑 " : ""}{s.name}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {s.overall != null && <span style={{ fontWeight: 700, color: scoreColor(s.overall) }}>{s.overall}</span>}
                      <span title={s.done ? "проведено" : "ще не проведено"}>{s.done ? "✅" : "⏳"}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Анкета */}
          <div className="chart-card">
            {!selected ? (
              <p className="loading-text" style={{ margin: 0 }}>← Оберіть працівника зі списку, щоб провести зустріч.</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  <h2 className="chart-title" style={{ margin: 0 }}>{selected.is_team_lead ? "👑 " : ""}{selected.name}</h2>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Заг. оцінка: <b style={{ color: scoreColor(liveOverall), fontSize: 18 }}>{liveOverall ?? "—"}</b></span>
                    <button onClick={save} disabled={saving}
                      style={{ padding: "7px 18px", borderRadius: 8, border: "none", background: "#c5141c", color: "#fff", fontWeight: 700, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
                      {saving ? "Збереження…" : "💾 Зберегти"}
                    </button>
                  </div>
                </div>
                {savedAt && <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 12px" }}>Востаннє збережено: {new Date(savedAt).toLocaleString("uk-UA")}</p>}

                {GROUPS.map((g) => (
                  <div key={g} style={{ marginBottom: 18 }}>
                    <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.04em", color: "#c5141c", margin: "0 0 8px", borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>{g}</h3>
                    {QUESTIONS.filter((q) => q.group === g).map((q) => (
                      <div key={q.key} style={{ marginBottom: 12 }}>
                        <label style={{ display: "block", fontSize: 13, marginBottom: 5 }}>{q.label}</label>
                        {q.type === "score" ? (
                          <ScorePicker value={answers[q.key]?.score} onChange={(v) => setAns(q.key, { score: v })} />
                        ) : (
                          <textarea value={answers[q.key]?.text ?? ""} onChange={(e) => setAns(q.key, { text: e.target.value })} rows={2}
                            style={{ width: "100%", resize: "vertical", font: "inherit", padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }} />
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ) : (
        <StatsView stats={stats} />
      )}
    </>
  );
}

/** Статистика: працівник × місяці (загальна оцінка) + середнє по кожному score-питанню. */
function StatsView({ stats }: { stats: OneOnOneStatRow[] }) {
  const months = [...new Set(stats.map((r) => r.month))].sort();
  const byMgr = useMemo(() => {
    const m = new Map<number, { name: string; team: string | null; byMonth: Map<string, number | null> }>();
    for (const r of stats) {
      if (!m.has(r.id)) m.set(r.id, { name: r.name, team: r.team_name, byMonth: new Map() });
      m.get(r.id)!.byMonth.set(r.month, r.overall);
    }
    return [...m.values()].sort((a, b) => (a.team || "").localeCompare(b.team || "") || a.name.localeCompare(b.name));
  }, [stats]);

  if (stats.length === 0) return <div className="chart-card"><p className="loading-text" style={{ margin: 0 }}>Ще немає проведених зустрічей за останні місяці.</p></div>;

  return (
    <div className="chart-card">
      <h2 className="chart-title">Динаміка загальних оцінок (останні місяці)</h2>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table compact" style={{ minWidth: 520 }}>
          <thead><tr><th style={{ textAlign: "left" }}>Працівник</th><th style={{ textAlign: "left" }}>Команда</th>
            {months.map((mo) => <th key={mo} style={{ textAlign: "center" }}>{mo}</th>)}
            <th style={{ textAlign: "center" }}>Тренд</th></tr></thead>
          <tbody>
            {byMgr.map((r) => {
              const vals = months.map((mo) => r.byMonth.get(mo) ?? null);
              const nums = vals.filter((v): v is number => v != null);
              const trend = nums.length >= 2 ? nums[nums.length - 1] - nums[0] : 0;
              return (
                <tr key={r.name}>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>{r.name}</td>
                  <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{r.team ?? "—"}</td>
                  {vals.map((v, i) => <td key={i} style={{ textAlign: "center", fontWeight: 700, color: scoreColor(v) }}>{v ?? "·"}</td>)}
                  <td style={{ textAlign: "center", color: trend > 0 ? "#16a34a" : trend < 0 ? "#dc2626" : "var(--text-muted)", fontWeight: 700 }}>{trend > 0 ? `↑ +${trend.toFixed(1)}` : trend < 0 ? `↓ ${trend.toFixed(1)}` : "→"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "10px 0 0" }}>Оцінка = середнє по всіх бальних питаннях зустрічі (1–10). Зелений ≥8, жовтий ≥6, червоний &lt;6.</p>
    </div>
  );
}
