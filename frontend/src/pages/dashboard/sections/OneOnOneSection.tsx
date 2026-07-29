import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  fetchOneOnOneSubjects, fetchOneOnOne, saveOneOnOne, fetchOneOnOneStats, fetchO2OForm, fetchO2OEnps,
  type OneOnOneSubject, type OneOnOneAnswers, type OneOnOneStatRow, type O2OForm, type O2ONotes, type O2OEnpsPoint,
} from "../../../api";
import { getAuthPayload } from "../../../auth";
import { DatePicker } from "../../../components/DatePicker";
import { OneOnOneFormsEditor } from "./OneOnOneFormsEditor";

type O2OType = "A" | "B" | "V";
const TYPE_LABEL: Record<O2OType, string> = { A: "Тімлід → Менеджер", B: "Керівник → Тімлід", V: "HR → Всі" };
const MOODS = ["Позитивний", "Нейтральний", "Напружений"];
const NOTE_FIELDS: { key: keyof O2ONotes; label: string; icon: string }[] = [
  { key: "likes", label: "Що подобається", icon: "💚" },
  { key: "pains", label: "Болі", icon: "⚠️" },
  { key: "ideas", label: "Ідеї", icon: "💡" },
  { key: "requests", label: "Запити до HR", icon: "🎯" },
  { key: "about_manager", label: "Про менеджера", icon: "🧑" },
  { key: "development", label: "Розвиток", icon: "📈" },
  { key: "followup", label: "Follow-up", icon: "📌" },
];
const SECTION_DOTS = ["#6366f1", "#16a34a", "#d97706", "#8b5cf6", "#0ea5e9", "#ec4899", "#ef4444"];

// ── дизайн-токени (сучасний макет; тема-стійкі: card/text через CSS-vars) ──
export const CARD: CSSProperties = { background: "var(--card-bg)", borderRadius: 20, boxShadow: "0 8px 34px rgba(20,30,50,.07)", border: "none", padding: 22 };
const FIELD: CSSProperties = { width: "100%", resize: "vertical", font: "inherit", fontSize: 14, padding: "11px 13px", borderRadius: 14, border: "none", background: "rgba(128,128,128,.08)", color: "var(--text)", outline: "none" };
const RED = "#c5141c";

const curMonthStr = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };
const scoreColor = (v: number | null) => (v == null ? "var(--text-muted)" : v >= 8 ? "#16a34a" : v >= 6 ? "#d97706" : "#dc2626");
const enpsColor = (v: number) => (v >= 9 ? "#16a34a" : v >= 7 ? "#d97706" : "#dc2626");

function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase(); }
function avatarHue(name: string) { return [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360; }
function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <div style={{ width: size, height: size, minWidth: size, borderRadius: size > 40 ? 14 : "50%",
      background: `hsl(${avatarHue(name)} 52% 55%)`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: Math.round(size * 0.38) }}>{initials(name)}</div>
  );
}

/** Кільце-прогрес загальної оцінки (conic). */
function Ring({ value, max = 10, label }: { value: number | null; max?: number; label: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const col = value == null ? "var(--text-muted)" : scoreColor(value);
  return (
    <div style={{ width: 58, height: 58, borderRadius: "50%", background: `conic-gradient(${col} ${pct * 360}deg, rgba(128,128,128,.15) 0)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 46, height: 46, borderRadius: "50%", background: "var(--card-bg)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
        <b style={{ fontSize: 17, color: col }}>{value ?? "—"}</b>
        <span style={{ fontSize: 8, color: "var(--text-muted)", marginTop: 2 }}>{label}</span>
      </div>
    </div>
  );
}

/** Суцільний трек оцінки: сегменти заповнюються до обраної; обрана — піднята. */
function ScoreTrack({ value, onChange, from = 1, to = 10, enps = false }: { value?: number; onChange: (v: number) => void; from?: number; to?: number; enps?: boolean }) {
  const nums: number[] = []; for (let i = from; i <= to; i++) nums.push(i);
  const sel = typeof value === "number" ? value : null;
  const fill = enps ? (sel != null ? enpsColor(sel) : "#16a34a") : "#16a34a";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 320px", minWidth: 260 }}>
        <div style={{ display: "flex", gap: 5 }}>
          {nums.map((n) => {
            const filled = sel != null && n <= sel;
            const isSel = n === sel;
            return (
              <button key={n} onClick={() => onChange(n)} title={`${n}`}
                style={{ flex: 1, minWidth: 26, height: 36, borderRadius: 9, cursor: "pointer", fontWeight: 700, fontSize: 13,
                  border: "none", background: filled ? fill : "rgba(128,128,128,.10)", color: filled ? "#fff" : "var(--text-muted)",
                  transform: isSel ? "translateY(-3px)" : "none", boxShadow: isSel ? `0 8px 16px ${fill}55` : "none", transition: "transform .1s" }}>
                {n}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
          <span>{enps ? "0 — не порекомендую" : "низько"}</span><span>{enps ? "10 — точно" : "високо"}</span>
        </div>
      </div>
      <div style={{ textAlign: "center", minWidth: 46 }}>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: sel == null ? "var(--text-muted)" : fill }}>{sel ?? "—"}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>/ {to}</div>
      </div>
    </div>
  );
}

/** Textarea, що АВТО-РОСТЕ під вміст (без внутрішнього скролу, нічого не ріже).
 *  Підганяє висоту при наборі і коли підвантажується збережений запис. */
export function AutoTextarea({ style, value, onChange, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => { const el = ref.current; if (!el) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  useLayoutEffect(fit, [value]);
  return (
    <textarea ref={ref} value={value} rows={2}
      onChange={(e) => { onChange?.(e); fit(); }}
      style={{ ...style, overflow: "hidden", resize: "none", whiteSpace: "pre-wrap", wordBreak: "break-word" }} {...rest} />
  );
}

function Pill({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      style={{ padding: "7px 14px", borderRadius: 12, cursor: "pointer", fontWeight: active ? 700 : 500, fontSize: 13,
        border: "none", background: active ? RED : "rgba(128,128,128,.10)", color: active ? "#fff" : "var(--text)", transition: "background .12s" }}>
      {children}
    </button>
  );
}

export function OneOnOneSection() {
  const auth = getAuthPayload();
  const perms = auth?.perms ?? [];
  const crossview = perms.includes("view_all_1x1");
  const canEdit = perms.includes("edit_1x1_forms");
  const availableTypes = useMemo<O2OType[]>(
    () => (crossview ? ["A", "B", "V"] : auth?.role === "team_lead" ? ["A"] : []),
    [crossview, auth?.role]);

  const [type, setType] = useState<O2OType>(availableTypes[0] ?? "A");
  const [tab, setTab] = useState<"conduct" | "stats" | "enps" | "edit">("conduct");
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("o2oMonth") || curMonthStr());
  const [form, setForm] = useState<O2OForm | null>(null);
  const [subjects, setSubjects] = useState<OneOnOneSubject[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<OneOnOneAnswers>({});
  const [enpsScore, setEnpsScore] = useState<number | null>(null);
  const [enpsReason, setEnpsReason] = useState<string>("");
  const [notes, setNotes] = useState<O2ONotes>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [stats, setStats] = useState<OneOnOneStatRow[]>([]);
  const [enpsSeries, setEnpsSeries] = useState<O2OEnpsPoint[]>([]);

  const loadSubjects = () => fetchOneOnOneSubjects(type, monthSel).then((d) => setSubjects(d.subjects)).catch(() => setSubjects([]));
  useEffect(() => { fetchO2OForm(type).then(setForm).catch(() => setForm(null)); }, [type]);
  useEffect(() => { setSelId(null); void loadSubjects(); /* eslint-disable-next-line */ }, [type, monthSel]);
  useEffect(() => { if (tab === "stats") fetchOneOnOneStats(type, 6).then(setStats).catch(() => setStats([])); }, [tab, type, monthSel]);
  useEffect(() => { if (tab === "enps") fetchO2OEnps(12).then(setEnpsSeries).catch(() => setEnpsSeries([])); }, [tab, monthSel]);

  useEffect(() => {
    if (selId == null) return;
    fetchOneOnOne(type, selId, monthSel).then((r) => {
      setAnswers(r.answers || {}); setEnpsScore(r.enps_score); setEnpsReason(r.enps_reason || "");
      setNotes(r.notes || {}); setSavedAt(r.updated_at ?? null);
    }).catch(() => { setAnswers({}); setEnpsScore(null); setEnpsReason(""); setNotes({}); });
  }, [selId, type, monthSel]);

  const setAns = (key: string, patch: { score?: number; text?: string }) =>
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const allQuestions = useMemo(() => (form?.questions.sections ?? []).flatMap((s) => s.questions), [form]);
  const scoreKeys = useMemo(() => allQuestions.filter((q) => q.field === "score" || q.field === "score_text").map((q) => q.qKey), [allQuestions]);
  const answeredCount = useMemo(() => allQuestions.filter((q) => {
    const a = answers[q.qKey]; return (typeof a?.score === "number" && a.score > 0) || (a?.text?.trim() ?? "") !== "";
  }).length, [allQuestions, answers]);
  const liveOverall = useMemo(() => {
    if (type === "V") return enpsScore;
    const s = scoreKeys.map((k) => answers[k]?.score).filter((x): x is number => typeof x === "number" && x > 0);
    return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null;
  }, [answers, scoreKeys, type, enpsScore]);

  const save = async () => {
    if (selId == null) return;
    setSaving(true);
    try {
      await saveOneOnOne({ type, subjectManagerId: selId, month: monthSel, answers,
        enpsScore: type === "V" ? enpsScore : null, enpsReason: type === "V" ? enpsReason : null, notes: type === "V" ? notes : null });
      setSavedAt(new Date().toISOString()); await loadSubjects();
    } finally { setSaving(false); }
  };

  const pickMonth = (v: string) => { if (!v || v > curMonthStr()) return; setMonthSel(v); localStorage.setItem("o2oMonth", v); setSelId(null); };
  const selected = subjects.find((s) => s.id === selId);
  const byTeam = useMemo(() => {
    const m = new Map<string, OneOnOneSubject[]>();
    for (const s of subjects) { const k = s.team_name || "Без команди"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); }
    return [...m.entries()];
  }, [subjects]);

  if (availableTypes.length === 0) {
    return <div style={CARD}><p className="loading-text" style={{ margin: 0 }}>Немає доступу до проведення 1×1.</p></div>;
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🤝 Ван-ту-ван</h1>
        <div className="page-filters" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {availableTypes.length > 1 && (
            <div style={{ display: "flex", gap: 5 }}>
              {availableTypes.map((t) => (
                <Pill key={t} active={type === t} onClick={() => { setType(t); setSelId(null); }} title={TYPE_LABEL[t]}>
                  {t === "A" ? "Тімлід→Менеджер" : t === "B" ? "КВП→Тімлід" : "HR→Всі"}
                </Pill>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 5 }}>
            {([["conduct", "Провести"], ["stats", "Історія"], ...(type === "V" ? [["enps", "eNPS"]] as const : []), ...(canEdit ? [["edit", "✏️ Питання"]] as const : [])] as const).map(([t, lbl]) => (
              <Pill key={t} active={tab === t} onClick={() => setTab(t)}>{lbl}</Pill>
            ))}
          </div>
          <DatePicker mode="month" value={monthSel} onChange={(v) => v && pickMonth(v)} minWidth={150} />
        </div>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", maxWidth: 900 }}>
        <b style={{ color: "var(--text)" }}>{TYPE_LABEL[type]}.</b> {crossview ? "Наскрізний доступ: усі 1×1 і аналітика." : "Ви бачите лише свої проведені 1×1."} Менеджери цей розділ не бачать.
      </p>

      {tab === "conduct" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 18, alignItems: "start" }}>
          {/* Список людей */}
          <div style={{ ...CARD, padding: 12 }}>
            {byTeam.length === 0 && <p className="loading-text" style={{ margin: 8 }}>Немає працівників у скоупі.</p>}
            {byTeam.map(([team, list]) => (
              <div key={team} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 700, margin: "6px 8px 4px" }}>{team}</div>
                {list.map((s) => (
                  <button key={s.id} onClick={() => setSelId(s.id)}
                    style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 12, marginBottom: 2, cursor: "pointer", textAlign: "left",
                      border: "none", background: selId === s.id ? "rgba(197,20,28,0.07)" : "transparent", color: "var(--text)" }}>
                    <Avatar name={s.name} size={32} />
                    <span style={{ fontSize: 13.5, fontWeight: selId === s.id ? 700 : 500, flex: 1 }}>{s.is_team_lead ? "👑 " : ""}{s.name}</span>
                    <span title={s.done ? "проведено" : "ще не проведено"}
                      style={{ width: 9, height: 9, borderRadius: "50%", background: s.done ? "#16a34a" : "#eab308", flexShrink: 0 }} />
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Анкета */}
          <div style={CARD}>
            {!selected ? (
              <p className="loading-text" style={{ margin: 0 }}>← Оберіть працівника зі списку, щоб провести зустріч.</p>
            ) : !form ? (
              <p className="loading-text" style={{ margin: 0 }}>Завантаження форми…</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={selected.name} size={48} />
                    <div>
                      <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>{selected.is_team_lead ? "👑 " : ""}{selected.name}</h2>
                      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <Chip>{selected.is_team_lead ? "тімлід" : "менеджер"}</Chip>
                        {selected.team_name && <Chip>команда {selected.team_name}</Chip>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <Ring value={liveOverall} label={type === "V" ? "eNPS" : "оцінка"} />
                    <button onClick={save} disabled={saving}
                      style={{ padding: "9px 22px", borderRadius: 12, border: "none", background: RED, color: "#fff", fontWeight: 700, fontSize: 14, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
                      {saving ? "Збереження…" : "Зберегти"}
                    </button>
                  </div>
                </div>

                {/* Прогрес */}
                <div style={{ marginBottom: 18 }}>
                  <div style={{ height: 6, borderRadius: 4, background: "rgba(128,128,128,.12)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${allQuestions.length ? (answeredCount / allQuestions.length) * 100 : 0}%`, background: RED, borderRadius: 4, transition: "width .2s" }} />
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
                    Заповнено <b style={{ color: "var(--text)" }}>{answeredCount}</b> з {allQuestions.length} · пікерів оцінки {scoreKeys.length}
                    {savedAt && <> · збережено {new Date(savedAt).toLocaleString("uk-UA")}</>}
                  </div>
                </div>

                {/* Двоколонка для типу В: ліворуч форма+eNPS, праворуч Нотатки; вузько → стек (flex-wrap). */}
                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: "3 1 340px", minWidth: 0 }}>
                {form.questions.sections.map((sec, i) => (
                  <div key={sec.key} style={{ marginBottom: 22 }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 12px", fontWeight: 800 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: SECTION_DOTS[i % SECTION_DOTS.length] }} />{sec.title}
                    </h3>
                    {sec.note && <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 12px" }}>{sec.note}</p>}
                    {sec.questions.map((q) => (
                      <div key={q.qKey} style={{ marginBottom: 16 }}>
                        <label style={{ display: "block", fontSize: 14.5, lineHeight: 1.5, marginBottom: 8, overflowWrap: "anywhere" }}>
                          {q.label}{q.quarterly && <span style={{ marginLeft: 8, fontSize: 10.5, color: "#8b5cf6", background: "rgba(139,92,246,.12)", padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>1 раз на квартал</span>}
                        </label>
                        {(q.field === "score" || q.field === "score_text") && (
                          <ScoreTrack value={answers[q.qKey]?.score} onChange={(v) => setAns(q.qKey, { score: v })} />
                        )}
                        {(q.field === "text" || q.field === "score_text") && (
                          <AutoTextarea value={answers[q.qKey]?.text ?? ""} onChange={(e) => setAns(q.qKey, { text: e.target.value })}
                            style={{ ...FIELD, marginTop: q.field === "score_text" ? 10 : 0 }} />
                        )}
                      </div>
                    ))}
                  </div>
                ))}

                {form.questions.enps && (
                  <div style={{ marginBottom: 22, padding: 16, borderRadius: 16, background: "rgba(22,163,74,.06)" }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 12px", fontWeight: 800 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#16a34a" }} />eNPS
                    </h3>
                    <label style={{ display: "block", fontSize: 14.5, lineHeight: 1.5, marginBottom: 8 }}>Наскільки ймовірно порекомендуєш компанію як місце роботи? (0-10)</label>
                    <ScoreTrack value={enpsScore ?? undefined} onChange={setEnpsScore} from={0} to={10} enps />
                    <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 10px" }}>0-6 критик · 7-8 нейтрал · 9-10 промоутер</div>
                    <AutoTextarea value={enpsReason} onChange={(e) => setEnpsReason(e.target.value)} placeholder="Чому саме така оцінка?" style={FIELD} />
                  </div>
                )}
                </div>

                {form.questions.notes && (
                  <div style={{ flex: "1 1 250px", minWidth: 0, position: "sticky", top: 12 }}>
                  <div style={{ background: "rgba(128,128,128,.05)", borderRadius: 16, padding: 16 }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 12px", fontWeight: 800 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#d97706" }} />📝 Нотатки HR
                    </h3>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                      <div>
                        <label style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", marginBottom: 5 }}>Дата</label>
                        <input type="date" value={notes.date ?? ""} onChange={(e) => setNotes((p) => ({ ...p, date: e.target.value }))} style={{ ...FIELD, width: "auto", padding: "8px 12px" }} />
                      </div>
                      <div>
                        <label style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", marginBottom: 5 }}>Настрій</label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {MOODS.map((m) => (
                            <button key={m} onClick={() => setNotes((p) => ({ ...p, mood: p.mood === m ? "" : m }))}
                              style={{ padding: "8px 12px", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: notes.mood === m ? 700 : 500,
                                background: notes.mood === m ? (m === "Позитивний" ? "#16a34a" : m === "Нейтральний" ? "#64748b" : "#dc2626") : "rgba(128,128,128,.10)",
                                color: notes.mood === m ? "#fff" : "var(--text)" }}>{m}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {NOTE_FIELDS.map((f) => (
                      <div key={f.key} style={{ marginBottom: 12 }}>
                        <label style={{ display: "block", fontSize: 13.5, marginBottom: 6 }}>{f.icon} {f.label}</label>
                        <AutoTextarea value={(notes[f.key] as string) ?? ""} onChange={(e) => setNotes((p) => ({ ...p, [f.key]: e.target.value }))} style={FIELD} />
                      </div>
                    ))}
                  </div>
                  </div>
                )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : tab === "stats" ? (
        <StatsView stats={stats} isV={type === "V"} />
      ) : tab === "enps" ? (
        <EnpsView series={enpsSeries} />
      ) : (
        <OneOnOneFormsEditor type={type} />
      )}
    </>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11.5, color: "var(--text-muted)", background: "rgba(128,128,128,.10)", padding: "3px 10px", borderRadius: 20 }}>{children}</span>;
}

/** Історія: працівник × місяці (загальна оцінка або eNPS-бал). */
function StatsView({ stats, isV }: { stats: OneOnOneStatRow[]; isV: boolean }) {
  const months = [...new Set(stats.map((r) => r.month))].sort();
  const byMgr = useMemo(() => {
    const m = new Map<number, { name: string; team: string | null; byMonth: Map<string, number | null> }>();
    for (const r of stats) {
      if (!m.has(r.id)) m.set(r.id, { name: r.name, team: r.team_name, byMonth: new Map() });
      m.get(r.id)!.byMonth.set(r.month, isV ? r.enps_score : r.overall);
    }
    return [...m.values()].sort((a, b) => (a.team || "").localeCompare(b.team || "") || a.name.localeCompare(b.name));
  }, [stats, isV]);

  if (stats.length === 0) return <div style={CARD}><p className="loading-text" style={{ margin: 0 }}>Ще немає проведених зустрічей за останні місяці.</p></div>;
  return (
    <div style={CARD}>
      <h2 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 800 }}>Динаміка {isV ? "eNPS-балів" : "загальних оцінок"} (останні місяці)</h2>
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
                  <td style={{ textAlign: "left", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><Avatar name={r.name} size={26} />{r.name}</td>
                  <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{r.team ?? "—"}</td>
                  {vals.map((v, i) => <td key={i} style={{ textAlign: "center", fontWeight: 700, color: scoreColor(v) }}>{v ?? "·"}</td>)}
                  <td style={{ textAlign: "center", color: trend > 0 ? "#16a34a" : trend < 0 ? "#dc2626" : "var(--text-muted)", fontWeight: 700 }}>{trend > 0 ? `↑ +${trend.toFixed(1)}` : trend < 0 ? `↓ ${trend.toFixed(1)}` : "→"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** eNPS-аналітика (тип В): тренд по місяцях + розклад промоутери/нейтрали/критики. */
function EnpsView({ series }: { series: O2OEnpsPoint[] }) {
  if (series.length === 0) return <div style={CARD}><p className="loading-text" style={{ margin: 0 }}>Ще немає даних eNPS.</p></div>;
  const last = series[series.length - 1];
  const maxAbs = Math.max(50, ...series.map((s) => Math.abs(s.enps ?? 0)));
  return (
    <div style={CARD}>
      <h2 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 800 }}>eNPS (тип В) — %промоутерів − %критиків</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "6px 0 18px" }}>
        <Kpi label="Поточний eNPS" value={last.enps == null ? "—" : `${last.enps}`} color={last.enps == null ? undefined : last.enps >= 0 ? "#16a34a" : "#dc2626"} big />
        <Kpi label="Промоутери" value={`${last.promoters}`} color="#16a34a" />
        <Kpi label="Нейтрали" value={`${last.passives}`} color="#d97706" />
        <Kpi label="Критики" value={`${last.detractors}`} color="#dc2626" />
        <Kpi label="Відповідей" value={`${last.total}`} />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table compact" style={{ minWidth: 560 }}>
          <thead><tr><th style={{ textAlign: "left" }}>Місяць</th><th style={{ textAlign: "center" }}>Пром.</th><th style={{ textAlign: "center" }}>Нейтр.</th><th style={{ textAlign: "center" }}>Крит.</th><th style={{ textAlign: "center" }}>Всього</th><th style={{ textAlign: "left" }}>eNPS</th></tr></thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.month}>
                <td style={{ textAlign: "left", fontWeight: 600 }}>{s.month}</td>
                <td style={{ textAlign: "center", color: "#16a34a", fontWeight: 700 }}>{s.promoters}</td>
                <td style={{ textAlign: "center", color: "#d97706", fontWeight: 700 }}>{s.passives}</td>
                <td style={{ textAlign: "center", color: "#dc2626", fontWeight: 700 }}>{s.detractors}</td>
                <td style={{ textAlign: "center" }}>{s.total}</td>
                <td style={{ textAlign: "left" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ display: "inline-block", width: 120, height: 8, background: "rgba(128,128,128,.14)", borderRadius: 4, position: "relative" }}>
                      <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--text-muted)" }} />
                      {s.enps != null && <span style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 4,
                        background: s.enps >= 0 ? "#16a34a" : "#dc2626",
                        left: s.enps >= 0 ? "50%" : `${50 - (Math.abs(s.enps) / maxAbs) * 50}%`,
                        width: `${(Math.abs(s.enps) / maxAbs) * 50}%` }} />}
                    </span>
                    <b style={{ color: s.enps == null ? "var(--text-muted)" : s.enps >= 0 ? "#16a34a" : "#dc2626" }}>{s.enps ?? "—"}</b>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "10px 0 0" }}>eNPS = %промоутерів (9-10) − %критиків (0-6). Нейтрали (7-8) у формулу не входять.</p>
    </div>
  );
}

function Kpi({ label, value, color, big }: { label: string; value: string; color?: string; big?: boolean }) {
  return (
    <div style={{ minWidth: 110, padding: "12px 16px", borderRadius: 16, background: "rgba(128,128,128,.06)" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: big ? 30 : 24, fontWeight: 800, color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}
