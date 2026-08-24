import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  fetchOneOnOneSubjects, fetchOneOnOne, saveOneOnOne, fetchOneOnOneStats, fetchO2OForm, fetchO2OEnps, fetchO2OConductTypes,
  fetchO2OMeetings, fetchO2OOpenTasks, createO2OTask, reviewO2OTask,
  type OneOnOneSubject, type OneOnOneAnswers, type OneOnOneStatRow, type O2OForm, type O2ONotes, type OneOnOneRecord,
  type O2OMeeting, type O2OOpenTask, type O2OTaskOutcome, type O2OEnpsResponse, type O2OEnpsSummary,
} from "../../../api";
import { DatePicker } from "../../../components/DatePicker";
import { DateRangeFilter, QuickPeriods, getDateRange } from "../../../components/DateRangeFilter";
import { enpsColor, CLASS_UI, BAND_COLOR, SCALE_CAPTION } from "./enpsScale";
import { OneOnOneFormsEditor } from "./OneOnOneFormsEditor";
import { saveErrorText, draftKey, hasUnsavedEdits, UNSAVED_PROMPT, UNSAVED_BEFOREUNLOAD, type O2ODraft } from "./oneOnOneSave";

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
/** Сьогодні по-київськи (YYYY-MM-DD) — дата зустрічі за замовчуванням. */
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const dmy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const scoreColor = (v: number | null) => (v == null ? "var(--text-muted)" : v >= 8 ? "#16a34a" : v >= 6 ? "#d97706" : "#dc2626");

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
  // Доступні для проведення типи + прапорці беремо з СЕРВЕРА (живий roleKey/права),
  // а не зі scope-clamped auth.role/знімку токена — тож працює за будь-якого data_scope.
  const [availableTypes, setAvailableTypes] = useState<O2OType[]>([]);
  const [crossview, setCrossview] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [typesLoaded, setTypesLoaded] = useState(false);

  const [type, setType] = useState<O2OType>("A");
  const [tab, setTab] = useState<"conduct" | "stats" | "enps" | "edit">("conduct");
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("o2oMonth") || curMonthStr());
  const [form, setForm] = useState<O2OForm | null>(null);
  const [subjects, setSubjects] = useState<OneOnOneSubject[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<OneOnOneAnswers>({});
  const [enpsScore, setEnpsScore] = useState<number | null>(null);
  const [enpsReason, setEnpsReason] = useState<string>("");
  // Задоволеність компанією — ОКРЕМИЙ показник, свідомо поза overall (інакше нові
  // зустрічі стали б непорівнянні з історичними). Для типу В її роль грає eNPS.
  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const [notes, setNotes] = useState<O2ONotes>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // 🔴 ПОМИЛКА ЗБЕРЕЖЕННЯ МУСИТЬ БУТИ ВИДИМОЮ. Раніше save/doReview/addTask стояли
  // без `catch`, тож 403/500 не лишав на екрані ЖОДНОГО сліду.
  const [err, setErr] = useState<string | null>(null);
  // Відбиток стану, який СЕРВЕР уже знає. Проти нього рахуємо «є незбережене».
  const [savedSnap, setSavedSnap] = useState<string | null>(null);
  const [stats, setStats] = useState<OneOnOneStatRow[]>([]);
  // eNPS: період ДОВІЛЬНИЙ (1×1 не тримаються меж місяця). Стан локальний для вкладки —
  // спільний фільтр періоду живе в контейнері, а він цим проходом не чіпається.
  const [enpsData, setEnpsData] = useState<O2OEnpsResponse | null>(null);
  const [enpsRange, setEnpsRange] = useState(() => getDateRange("quarter"));
  const [enpsPreset, setEnpsPreset] = useState<string | null>("quarter");
  const [hist, setHist] = useState<{ managerId: number; name: string; date: string } | null>(null);
  const [person, setPerson] = useState<{ managerId: number; name: string } | null>(null);
  // Задачі з 1×1: відкриті з МИНУЛИХ зустрічей (рев'ю) + форма постановки нової
  const [openTasks, setOpenTasks] = useState<O2OOpenTask[]>([]);
  const [newTask, setNewTask] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  // ДАТА ЗУСТРІЧІ — авторитетна: саме вона визначає запис (у місяці зустрічей може бути кілька).
  const [dateSel, setDateSel] = useState<string>(kyivToday);
  const [meetings, setMeetings] = useState<O2OMeeting[]>([]);

  useEffect(() => {
    fetchO2OConductTypes().then((r) => {
      const types = r.types as O2OType[];
      setAvailableTypes(types); setCrossview(r.crossview); setCanEdit(r.canEdit); setTypesLoaded(true);
      if (types.length && !types.includes(type)) setType(types[0]);
    }).catch(() => setTypesLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSubjects = () => fetchOneOnOneSubjects(type, monthSel).then((d) => setSubjects(d.subjects)).catch(() => setSubjects([]));
  const loadMeetings = (mgrId: number) => fetchO2OMeetings(type, mgrId, 24).then(setMeetings).catch(() => setMeetings([]));
  useEffect(() => { fetchO2OForm(type).then(setForm).catch(() => setForm(null)); }, [type]);
  useEffect(() => { setSelId(null); setMeetings([]); void loadSubjects(); /* eslint-disable-next-line */ }, [type, monthSel]);
  useEffect(() => { if (tab === "stats") fetchOneOnOneStats(type, 6).then(setStats).catch(() => setStats([])); }, [tab, type, monthSel]);
  useEffect(() => {
    if (tab !== "enps") return;
    // «Весь час» дає порожні кінці, а сервер вимагає обидва — підставляємо найширші.
    const from = enpsRange.from || "2000-01-01";
    const to = enpsRange.to || kyivToday();
    let live = true;
    fetchO2OEnps(from, to).then((d) => live && setEnpsData(d)).catch(() => live && setEnpsData(null));
    return () => { live = false; };
  }, [tab, enpsRange]);

  // Обрали субʼєкта → журнал його зустрічей + дата за замовчуванням: поточний місяць → СЬОГОДНІ
  // (нова зустріч), минулий → остання зустріч того місяця (читаємо, що було).
  useEffect(() => {
    if (selId == null) { setMeetings([]); return; }
    let live = true;
    fetchO2OMeetings(type, selId, 24).then((list) => {
      if (!live) return;
      setMeetings(list);
      const inMonth = list.filter((m) => m.meeting_date.slice(0, 7) === monthSel);
      setDateSel(monthSel === curMonthStr() ? kyivToday() : (inMonth[0]?.meeting_date ?? `${monthSel}-01`));
    }).catch(() => { if (live) setMeetings([]); });
    return () => { live = false; };
  }, [selId, type, monthSel]);

  // Відкриті задачі з МИНУЛИХ зустрічей (`before` = ця дата, тож поставлені сьогодні
  // в блок рев'ю не потрапляють — їх переглядатимуть на НАСТУПНІЙ зустрічі).
  const loadOpenTasks = (mgrId: number, date: string) =>
    fetchO2OOpenTasks(type, mgrId, date).then(setOpenTasks).catch(() => setOpenTasks([]));
  useEffect(() => {
    if (selId == null || type === "V") { setOpenTasks([]); return; }
    let live = true;
    fetchO2OOpenTasks(type, selId, dateSel).then((r) => live && setOpenTasks(r)).catch(() => live && setOpenTasks([]));
    return () => { live = false; };
  }, [selId, type, dateSel]);

  const doReview = async (id: number, outcome: O2OTaskOutcome) => {
    if (selId == null) return;
    setTaskBusy(true);
    setErr(null);
    try { await reviewO2OTask(id, outcome, dateSel); await loadOpenTasks(selId, dateSel); }
    catch (e) { setErr(saveErrorText(e, "Не вдалося позначити задачу")); }
    finally { setTaskBusy(false); }
  };
  const addTask = async () => {
    if (selId == null || !newTask.trim()) return;
    setTaskBusy(true); setErr(null);
    try {
      await createO2OTask({ type, subjectManagerId: selId, meetingDate: dateSel, title: newTask.trim(), deadline: newTaskDue || null });
      setNewTask(""); setNewTaskDue("");
    } catch (e) { setErr(saveErrorText(e, "Задачу не поставлено")); }
    finally { setTaskBusy(false); }
  };

  // Запис КОНКРЕТНОЇ зустрічі — ключ (субʼєкт, тип, дата).
  useEffect(() => {
    if (selId == null) return;
    let live = true;
    // 🔴 ЗНІМОК СТАВИМО В ОБОХ ГІЛКАХ. Якщо лишити його `null` на збої завантаження,
    // захист незбереженого мовчки вимкнеться саме там, де людина почне набирати заново.
    const snap = (d: O2ODraft) => { setSavedSnap(draftKey(d)); };
    fetchOneOnOne(type, selId, dateSel).then((r) => {
      if (!live) return;
      const loaded: O2ODraft = {
        answers: r.answers || {}, enpsScore: r.enps_score, enpsReason: r.enps_reason || "",
        satisfaction: r.satisfaction_score ?? null, notes: (r.notes || {}) as O2ONotes,
      };
      setAnswers(loaded.answers); setEnpsScore(loaded.enpsScore); setEnpsReason(loaded.enpsReason);
      setSatisfaction(loaded.satisfaction);
      // Стара помилка знімається ТУТ, а не на початку ефекту: поки нового запису ще
      // немає, ховати попереднє «не збереглося» нема підстав (а синхронний setState в
      // тілі ефекту — ще й зайвий каскад рендерів).
      setNotes(loaded.notes); setSavedAt(r.updated_at ?? null); snap(loaded); setErr(null);
    }).catch((e) => {
      if (!live) return;
      const empty: O2ODraft = { answers: {}, enpsScore: null, enpsReason: "", satisfaction: null, notes: {} };
      setAnswers(empty.answers); setEnpsScore(null); setEnpsReason(""); setSatisfaction(null);
      setNotes(empty.notes); setSavedAt(null); snap(empty);
      setErr(saveErrorText(e, "Не вдалося завантажити анкету"));
    });
    return () => { live = false; };
  }, [selId, type, dateSel]);

  const setAns = (key: string, patch: { score?: number; text?: string }) =>
    setAnswers((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  // ── НЕЗБЕРЕЖЕНЕ НЕ ЗНИКАЄ МОВЧКИ ──────────────────────────────────────────
  // Анкета живе в локальному стані до кнопки «Зберегти», а перемикання дати/людини/
  // типу перезавантажує запис із сервера — тобто набране зникало БЕЗ помилки, просто
  // «штатно». Для типу В там нотатки HR, які вдруге ніхто не переказує.
  const draft: O2ODraft = useMemo(
    () => ({ answers, enpsScore, enpsReason, satisfaction, notes }),
    [answers, enpsScore, enpsReason, satisfaction, notes]);
  const dirty = hasUnsavedEdits(savedSnap, draft);
  /** Єдиний замок переходу. Мовчить, коли втрачати нічого (див. `draftKey`: порядок
   *  ключів і порожній текст правкою НЕ вважаються — інакше попередження стало б шумом,
   *  а шум прощіпують не читаючи). */
  const leaveGuard = () => !dirty || window.confirm(UNSAVED_PROMPT);
  const pickSubject = (id: number) => { if (leaveGuard()) setSelId(id); };
  const pickDate = (v: string) => { if (leaveGuard()) setDateSel(v); };
  const pickType = (t: O2OType) => { if (!leaveGuard()) return; setType(t); setSelId(null); };

  // Закриття вкладки/перезавантаження — теж вихід. Вішаємо ЛИШЕ поки є що втрачати.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = UNSAVED_BEFOREUNLOAD; };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

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
    setSaving(true); setErr(null);
    try {
      await saveOneOnOne({ type, subjectManagerId: selId, meetingDate: dateSel, answers,
        enpsScore: type === "V" ? enpsScore : null, enpsReason: type === "V" ? enpsReason : null, notes: type === "V" ? notes : null,
        satisfactionScore: type === "V" ? null : satisfaction });
      setSavedAt(new Date().toISOString());
      // Знімок рухається ТІЛЬКИ тут: поки сервер не підтвердив, правка лишається незбереженою.
      setSavedSnap(draftKey(draft));
      await Promise.all([loadSubjects(), loadMeetings(selId)]);
    } catch (e) { setErr(saveErrorText(e, "Зустріч не збережена")); }
    finally { setSaving(false); }
  };

  const pickMonth = (v: string) => { if (!v || v > curMonthStr()) return; if (!leaveGuard()) return; setMonthSel(v); localStorage.setItem("o2oMonth", v); setSelId(null); };
  const selected = subjects.find((s) => s.id === selId);
  const isV = type === "V";
  // «нова зустріч» = на цю дату запису ще немає (журнал не містить її)
  const isNewMeeting = !meetings.some((m) => m.meeting_date === dateSel);
  const byTeam = useMemo(() => {
    const m = new Map<string, OneOnOneSubject[]>();
    for (const s of subjects) { const k = s.team_name || "Без команди"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); }
    return [...m.entries()];
  }, [subjects]);

  if (!typesLoaded) {
    return <div style={CARD}><p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;
  }
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
                <Pill key={t} active={type === t} onClick={() => pickType(t)} title={TYPE_LABEL[t]}>
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
                  <button key={s.id} onClick={() => pickSubject(s.id)}
                    style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 12, marginBottom: 2, cursor: "pointer", textAlign: "left",
                      border: "none", background: selId === s.id ? "rgba(197,20,28,0.07)" : "transparent", color: "var(--text)" }}>
                    <Avatar name={s.name} size={32} />
                    <span style={{ fontSize: 13.5, fontWeight: selId === s.id ? 700 : 500, flex: 1 }}>{s.is_team_lead ? "👑 " : ""}{s.name}</span>
                    {s.meetings > 1 && (
                      <span title={`зустрічей у місяці: ${s.meetings}`}
                        style={{ fontSize: 10.5, fontWeight: 700, color: "#16a34a", background: "rgba(22,163,74,.12)", borderRadius: 20, padding: "1px 7px", flexShrink: 0 }}>×{s.meetings}</span>
                    )}
                    <span title={s.done ? `проведено${s.last_meeting_date ? ` · остання ${dmy(s.last_meeting_date)}` : ""}` : "ще не проведено"}
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
                    {dirty && <Chip>● незбережено</Chip>}
                    <button onClick={save} disabled={saving}
                      style={{ padding: "9px 22px", borderRadius: 12, border: "none", background: RED, color: "#fff", fontWeight: 700, fontSize: 14, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}>
                      {saving ? "Збереження…" : "Зберегти"}
                    </button>
                  </div>
                </div>

                {/* 🔴 ПОМИЛКА ЗБЕРЕЖЕННЯ — НА ЕКРАНІ. Доти 403/500 виглядав рівно як успіх:
                    кнопка переставала крутитись, підпис «збережено ЧЧ:ХХ» лишався старим. */}
                {err && (
                  <div role="alert" onClick={() => setErr(null)} title="Приховати"
                    style={{ marginBottom: 14, padding: "11px 14px", borderRadius: 14, cursor: "pointer",
                      background: "rgba(220,38,38,.10)", color: "#b91c1c", fontSize: 13.5, fontWeight: 600 }}>
                    ⚠️ {err}
                  </div>
                )}

                {/* ЖУРНАЛ ЗУСТРІЧЕЙ. Дата — АВТОРИТЕТНА: вона визначає, який саме запис
                    редагуємо. У місяці зустрічей може бути кілька; чипи ліворуч-направо — минулі. */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16, padding: "12px 14px", borderRadius: 16, background: "rgba(128,128,128,.05)" }}>
                  <span style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 800, color: "var(--text-muted)" }}>📅 Дата зустрічі</span>
                  <DatePicker mode="day" value={dateSel} onChange={(v) => v && pickDate(v)} minWidth={150} />
                  <Chip>{isNewMeeting ? "нова зустріч" : "запис існує"}</Chip>
                  {meetings.length > 0 && (
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginLeft: "auto" }}>
                      <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>журнал:</span>
                      {meetings.slice(0, 10).map((m) => (
                        <button key={m.meeting_date} onClick={() => pickDate(m.meeting_date)}
                          title={`${dmy(m.meeting_date)}${m.conducted_by_name ? ` · провів: ${m.conducted_by_name}` : ""}`}
                          style={{ border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: dateSel === m.meeting_date ? 700 : 500,
                            padding: "4px 9px", borderRadius: 20, color: dateSel === m.meeting_date ? "#fff" : "var(--text)",
                            background: dateSel === m.meeting_date ? RED : "rgba(128,128,128,.12)" }}>
                          {dmy(m.meeting_date).slice(0, 5)}{(isV ? m.enps_score : m.overall) != null ? ` · ${isV ? m.enps_score : m.overall}` : ""}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* РЕВʼЮ: задачі з МИНУЛОГО 1×1 — угорі форми, поки не позначені. */}
                {openTasks.length > 0 && (
                  <div style={{ marginBottom: 16, padding: "14px 16px", borderRadius: 16, background: "rgba(217,119,6,.08)" }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "0 0 10px", fontWeight: 800, color: "#b45309" }}>
                      📌 Задачі з минулого 1×1 — переглянь і познач
                    </h3>
                    {openTasks.map((t) => (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 0", borderTop: "1px dashed rgba(180,83,9,.25)" }}>
                        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                          <div style={{ fontSize: 14.5, overflowWrap: "anywhere" }}>{t.title}</div>
                          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                            поставлено {dmy(t.setAt)}{t.createdByName ? ` · ведучий: ${t.createdByName}` : ""}
                            {t.deadline ? ` · до ${dmy(t.deadline).slice(0, 5)}` : ""}
                          </div>
                        </div>
                        {t.carriedTimes > 0 && (
                          <span title={`переносилась разів: ${t.carriedTimes}`}
                            style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "rgba(217,119,6,.18)", borderRadius: 20, padding: "3px 10px" }}>переноситься</span>
                        )}
                        <div style={{ display: "flex", gap: 6 }}>
                          {([["done", "✓ Виконано", "#16a34a"], ["carried", "✗ Ні", "#dc2626"], ["cancelled", "✗ Знято", "#64748b"]] as const).map(([o, lbl, col]) => (
                            <button key={o} onClick={() => void doReview(t.id, o)} disabled={taskBusy}
                              title={o === "done" ? "Закрити й відкріпити" : o === "carried" ? "Лишається закріпленою і переноситься далі" : "Помилкова/неактуальна — закрити БЕЗ зарахування"}
                              style={{ border: "none", borderRadius: 10, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: taskBusy ? "default" : "pointer",
                                background: "var(--card-bg)", color: col, opacity: taskBusy ? 0.6 : 1 }}>{lbl}</button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

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

                {/* ЗАДОВОЛЕНІСТЬ КОМПАНІЄЮ (A/Б) — структурний блок наприкінці форми.
                    НЕ входить в overall: інакше нові зустрічі стали б непорівнянні з історичними. */}
                {form.questions.satisfaction && (
                  <div style={{ marginBottom: 22, padding: 16, borderRadius: 16, background: "rgba(99,102,241,.07)" }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 12px", fontWeight: 800 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#6366f1" }} />Задоволеність компанією
                    </h3>
                    <label style={{ display: "block", fontSize: 14.5, lineHeight: 1.5, marginBottom: 8 }}>Наскільки ти задоволений роботою в компанії? (1-10)</label>
                    <ScoreTrack value={satisfaction ?? undefined} onChange={setSatisfaction} />
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                      Окремий показник — у загальну оцінку <b>не входить</b> (щоб історія лишалась порівнянною).
                    </div>
                  </div>
                )}

                {/* ПОСТАНОВКА ЗАДАЧІ (A/Б) — унизу форми. Падає в Задачник субʼєкта закріпленою;
                    зняти може лише ведучий через рев'ю на наступній зустрічі. */}
                {type !== "V" && (
                  <div style={{ marginBottom: 22, padding: 16, borderRadius: 16, background: "rgba(128,128,128,.05)" }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "0 0 10px", fontWeight: 800 }}>
                      ➕ Поставити задачу {selected.is_team_lead ? "тімліду" : "менеджеру"}
                    </h3>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <input value={newTask} onChange={(e) => setNewTask(e.target.value)}
                        placeholder="Напр.: підготувати шаблони КП до кінця місяця…"
                        style={{ ...FIELD, flex: "1 1 320px", minWidth: 0 }} />
                      <DatePicker mode="day" value={newTaskDue} onChange={(v) => setNewTaskDue(v || "")} placeholder="дедлайн" minWidth={150} />
                      <button onClick={() => void addTask()} disabled={taskBusy || !newTask.trim()}
                        style={{ padding: "10px 22px", borderRadius: 12, border: "none", background: RED, color: "#fff", fontWeight: 700, fontSize: 14,
                          cursor: taskBusy || !newTask.trim() ? "default" : "pointer", opacity: taskBusy || !newTask.trim() ? 0.5 : 1 }}>Поставити</button>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
                      Задача одразу зʼявиться в Задачнику з позначкою «Задача з 1×1», <b>закріпленою вгорі й без можливості видалення</b>. Її статус ти переглянеш і закриєш на <b>наступному 1×1</b>.
                    </div>
                  </div>
                )}

                {form.questions.enps && (
                  <div style={{ marginBottom: 22, padding: 16, borderRadius: 16, background: "rgba(22,163,74,.06)" }}>
                    <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 12px", fontWeight: 800 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#16a34a" }} />eNPS
                    </h3>
                    <label style={{ display: "block", fontSize: 14.5, lineHeight: 1.5, marginBottom: 8 }}>Наскільки ймовірно порекомендуєш компанію як місце роботи? (0-10)</label>
                    <ScoreTrack value={enpsScore ?? undefined} onChange={setEnpsScore} from={0} to={10} enps />
                    <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 10px" }}>{SCALE_CAPTION}</div>
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
                    {/* Поля «Дата» тут БІЛЬШЕ НЕМАЄ: дата зустрічі — авторитетна (журнал угорі),
                        а не напис у нотатках. Дублювати її тут = два джерела правди. */}
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
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
        <StatsView stats={stats} isV={isV} onOpen={(managerId, name, date) => setHist({ managerId, name, date })}
          onOpenPerson={(managerId, name) => setPerson({ managerId, name })} />
      ) : tab === "enps" ? (
        <EnpsView data={enpsData} range={enpsRange} preset={enpsPreset}
          onRange={(r, preset) => { setEnpsRange(r); setEnpsPreset(preset); }} />
      ) : (
        <OneOnOneFormsEditor type={type} />
      )}
      {/* Журнал людини (z 999) і повна анкета (z 1000) шаруються: закрив анкету — лишився журнал. */}
      {person && <PersonHistoryModal type={type} managerId={person.managerId} name={person.name}
        onOpenRecord={(date) => setHist({ managerId: person.managerId, name: person.name, date })}
        onClose={() => setPerson(null)} />}
      {hist && <HistoryRecordModal type={type} managerId={hist.managerId} name={hist.name} date={hist.date} onClose={() => setHist(null)} />}
    </>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11.5, color: "var(--text-muted)", background: "rgba(128,128,128,.10)", padding: "3px 10px", borderRadius: 20 }}>{children}</span>;
}

/** Історія: працівник × ЗУСТРІЧІ (колонка = дата, бо в місяці їх може бути кілька).
 *  Значення — загальна оцінка або eNPS-бал. Клік по клітинці → повна анкета тієї зустрічі. */
function StatsView({ stats, isV, onOpen, onOpenPerson }: { stats: OneOnOneStatRow[]; isV: boolean; onOpen: (managerId: number, name: string, date: string) => void; onOpenPerson: (managerId: number, name: string) => void }) {
  const dates = [...new Set(stats.map((r) => r.meeting_date))].sort();
  const byMgr = useMemo(() => {
    const m = new Map<number, { id: number; name: string; team: string | null; byDate: Map<string, number | null> }>();
    for (const r of stats) {
      if (!m.has(r.id)) m.set(r.id, { id: r.id, name: r.name, team: r.team_name, byDate: new Map() });
      m.get(r.id)!.byDate.set(r.meeting_date, isV ? r.enps_score : r.overall);
    }
    return [...m.values()].sort((a, b) => (a.team || "").localeCompare(b.team || "") || a.name.localeCompare(b.name));
  }, [stats, isV]);

  if (stats.length === 0) return <div style={CARD}><p className="loading-text" style={{ margin: 0 }}>Ще немає проведених зустрічей за останні місяці.</p></div>;
  return (
    <div style={CARD}>
      <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>Динаміка {isV ? "eNPS-балів" : "загальних оцінок"} (останні місяці)</h2>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-muted)" }}>Колонка = зустріч (за датою). Клікніть по клітинці з оцінкою, щоб побачити повну анкету тієї зустрічі.</p>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table compact" style={{ minWidth: 520 }}>
          <thead><tr><th style={{ textAlign: "left" }}>Працівник</th><th style={{ textAlign: "left" }}>Команда</th>
            {dates.map((d) => <th key={d} style={{ textAlign: "center", whiteSpace: "nowrap" }}>{dmy(d).slice(0, 5)}<div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)" }}>{d.slice(0, 4)}</div></th>)}
            <th style={{ textAlign: "center" }}>Тренд</th></tr></thead>
          <tbody>
            {byMgr.map((r) => {
              const vals = dates.map((d) => r.byDate.get(d) ?? null);
              const nums = vals.filter((v): v is number => v != null);
              const trend = nums.length >= 2 ? nums[nums.length - 1] - nums[0] : 0;
              return (
                <tr key={r.id}>
                  <td style={{ textAlign: "left", fontWeight: 600 }}>
                    <button onClick={() => onOpenPerson(r.id, r.name)} title="Журнал зустрічей цієї людини"
                      style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "none", background: "transparent", cursor: "pointer", font: "inherit", fontWeight: 600, color: "var(--text)", padding: 0 }}>
                      <Avatar name={r.name} size={26} /><span style={{ textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: "rgba(128,128,128,.45)" }}>{r.name}</span>
                    </button>
                  </td>
                  <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{r.team ?? "—"}</td>
                  {dates.map((d, i) => {
                    const v = vals[i];
                    return (
                      <td key={d} style={{ textAlign: "center" }}>
                        {v == null ? <span style={{ color: "var(--text-muted)" }}>·</span> : (
                          <button onClick={() => onOpen(r.id, r.name, d)} title={`Відкрити повну анкету · ${dmy(d)}`}
                            style={{ border: "none", background: "transparent", cursor: "pointer", fontWeight: 700, fontSize: 14, color: scoreColor(v), textDecoration: "underline", textUnderlineOffset: 3 }}>{v}</button>
                        )}
                      </td>
                    );
                  })}
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

/** ЖУРНАЛ ЗУСТРІЧЕЙ ОДНІЄЇ ЛЮДИНИ: дата · заг. оцінка · задоволеність · динаміка.
 *  Динаміка — до ПОПЕРЕДНЬОЇ зустрічі за задоволеністю (для типу В її роль грає eNPS).
 *  Записи, зроблені до появи показника, показують «—», а не 0. Клік по рядку → повна анкета. */
function PersonHistoryModal({ type, managerId, name, onOpenRecord, onClose }:
  { type: O2OType; managerId: number; name: string; onOpenRecord: (date: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState<O2OMeeting[] | null>(null);
  const isV = type === "V";
  useEffect(() => {
    let live = true;
    fetchO2OMeetings(type, managerId, 24).then((r) => live && setRows(r)).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [type, managerId]);
  // rows приходять НОВІШІ ПЕРШИМИ; «попередня зустріч» — це наступний елемент масиву
  const list = rows ?? [];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,.45)", zIndex: 999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...CARD, maxWidth: 720, width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Avatar name={name} size={44} />
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{name}</h2>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{TYPE_LABEL[type]} · журнал зустрічей</div>
            </div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "rgba(128,128,128,.12)", borderRadius: 10, width: 34, height: 34, cursor: "pointer", fontSize: 18, color: "var(--text)" }}>✕</button>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-muted)" }}>Клік по рядку — повні відповіді тієї зустрічі.</p>
        {rows === null ? <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>
          : list.length === 0 ? <p className="loading-text" style={{ margin: 0 }}>Зустрічей ще не було.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact" style={{ minWidth: 460 }}>
              <thead><tr>
                <th style={{ textAlign: "left" }}>Дата</th>
                <th style={{ textAlign: "center" }}>{isV ? "eNPS" : "Заг. оцінка"}</th>
                {!isV && <th style={{ textAlign: "center" }}>Задоволеність компанією</th>}
                <th style={{ textAlign: "center" }}>Динаміка</th>
              </tr></thead>
              <tbody>
                {list.map((m, i) => {
                  const sat = m.satisfaction_score;
                  const prev = list[i + 1]?.satisfaction_score ?? null;
                  const d = sat != null && prev != null ? sat - prev : null;
                  return (
                    <tr key={m.meeting_date} onClick={() => onOpenRecord(m.meeting_date)} style={{ cursor: "pointer" }}
                      title={`Відкрити анкету · ${dmy(m.meeting_date)}${m.conducted_by_name ? ` · провів: ${m.conducted_by_name}` : ""}`}>
                      <td style={{ textAlign: "left", fontWeight: 600 }}>{dmy(m.meeting_date)}</td>
                      <td style={{ textAlign: "center", fontWeight: 700, color: scoreColor(isV ? m.enps_score : m.overall) }}>
                        {(isV ? m.enps_score : m.overall) ?? "—"}<span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}> /10</span>
                      </td>
                      {!isV && (
                        <td style={{ textAlign: "center", fontWeight: 700, color: sat == null ? "var(--text-muted)" : scoreColor(sat) }}>
                          {sat ?? "—"}{sat != null && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}> /10</span>}
                        </td>
                      )}
                      <td style={{ textAlign: "center", fontWeight: 700, color: d == null ? "var(--text-muted)" : d > 0 ? "#16a34a" : d < 0 ? "#dc2626" : "var(--text-muted)" }}>
                        {d == null ? "—" : d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "→ 0"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Read-only трек оцінки (для перегляду історії). */
function ReadTrack({ value, enps = false }: { value: number | null; enps?: boolean }) {
  if (value == null) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const from = enps ? 0 : 1, to = 10;
  const fill = enps ? enpsColor(value) : "#16a34a";
  const nums: number[] = []; for (let i = from; i <= to; i++) nums.push(i);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ display: "inline-flex", gap: 3 }}>
        {nums.map((n) => <span key={n} style={{ width: 16, height: 22, borderRadius: 5, background: n <= value ? fill : "rgba(128,128,128,.12)" }} />)}
      </span>
      <b style={{ color: fill, fontSize: 16 }}>{value}<span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}> / 10</span></b>
    </span>
  );
}

/** READ-ONLY повна анкета минулої зустрічі (рендер проти form_version запису). Гейт — на сервері (GET /record). */
function HistoryRecordModal({ type, managerId, name, date, onClose }: { type: O2OType; managerId: number; name: string; date: string; onClose: () => void }) {
  const [rec, setRec] = useState<OneOnOneRecord | null>(null);
  const [form, setForm] = useState<O2OForm | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let live = true;
    fetchOneOnOne(type, managerId, date).then((r) => {
      if (!live) return; setRec(r);
      fetchO2OForm(type, r.form_version).then((f) => live && setForm(f)).catch(() => {});
    }).catch(() => live && setDenied(true));
    return () => { live = false; };
  }, [type, managerId, date]);
  const answers = rec?.answers ?? {};
  const notes = (rec?.notes ?? {}) as O2ONotes;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,.45)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...CARD, maxWidth: 760, width: "100%", maxHeight: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Avatar name={name} size={44} />
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{name}</h2>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{TYPE_LABEL[type]} · {dmy(date)}{rec?.conducted_by_name ? ` · провів: ${rec.conducted_by_name}` : ""}{rec ? ` · форма v${rec.form_version}` : ""}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "rgba(128,128,128,.12)", borderRadius: 10, width: 34, height: 34, cursor: "pointer", fontSize: 18, color: "var(--text)" }}>✕</button>
        </div>
        {denied ? (
          <p style={{ margin: 0, color: "#dc2626" }}>Ця зустріч недоступна — її проводив інший (потрібен наскрізний доступ).</p>
        ) : !rec || !form ? (
          <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>
        ) : (
          <div>
            {form.questions.sections.map((sec, i) => (
              <div key={sec.key} style={{ marginBottom: 18 }}>
                <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 10px", fontWeight: 800 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: SECTION_DOTS[i % SECTION_DOTS.length] }} />{sec.title}
                </h3>
                {sec.questions.map((q) => (
                  <div key={q.qKey} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 6, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{q.label}</div>
                    {(q.field === "score" || q.field === "score_text") && <div style={{ marginBottom: 6 }}><ReadTrack value={answers[q.qKey]?.score ?? null} /></div>}
                    {(q.field === "text" || q.field === "score_text") && (
                      <div style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "rgba(128,128,128,.06)", borderRadius: 12, padding: "10px 12px", minHeight: 8 }}>
                        {answers[q.qKey]?.text?.trim() ? answers[q.qKey]!.text : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {form.questions.enps && (
              <div style={{ marginBottom: 18, padding: 14, borderRadius: 14, background: "rgba(22,163,74,.06)" }}>
                <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 10px", fontWeight: 800 }}>eNPS</h3>
                <ReadTrack value={rec.enps_score} enps />
                <div style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 10, background: "var(--card-bg)", borderRadius: 12, padding: "10px 12px" }}>
                  {rec.enps_reason?.trim() ? rec.enps_reason : <span style={{ color: "var(--text-muted)" }}>—</span>}
                </div>
              </div>
            )}
            {form.questions.notes && (
              <div>
                <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 10px", fontWeight: 800 }}>📝 Нотатки HR</h3>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10, fontSize: 13 }}>
                  {notes.mood && <span><b>Настрій:</b> {notes.mood}</span>}
                </div>
                {NOTE_FIELDS.map((f) => (notes[f.key] as string)?.trim() ? (
                  <div key={f.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 13, marginBottom: 4 }}>{f.icon} {f.label}</div>
                    <div style={{ fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "rgba(128,128,128,.06)", borderRadius: 12, padding: "10px 12px" }}>{notes[f.key] as string}</div>
                  </div>
                ) : null)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Підпис бакета тренду: день · тиждень (Пн-Нд) · місяць — за грануляцією з сервера. */
function bucketLabel(bucket: string, gran: "day" | "week" | "month"): string {
  const [y, m, d] = bucket.split("-");
  if (gran === "month") return `${m}.${y}`;
  if (gran === "day") return `${d}.${m}`;
  const end = new Date(`${bucket}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${d}.${m}–${String(end.getUTCDate()).padStart(2, "0")}.${String(end.getUTCMonth() + 1).padStart(2, "0")}`;
}
const GRAN_LABEL: Record<"day" | "week" | "month", string> = {
  day: "по днях", week: "по тижнях", month: "по місяцях",
};

/** Смуга-бейдж: межі й підпис приходять із СЕРВЕРА, фронт лише фарбує за `tone`. */
function BandBadge({ band, big }: { band: NonNullable<O2OEnpsSummary["band"]>; big?: boolean }) {
  const col = BAND_COLOR[band.tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: big ? "7px 16px" : "3px 10px",
      borderRadius: 20, background: `${col}1f`, color: col, fontWeight: 800, fontSize: big ? 15 : 12 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: col }} />{band.label}
    </span>
  );
}

/** Одна частка структури: 😊 Промоутери 60% · 12 осіб. */
function ShareTile({ kind, pct, count }: { kind: "promoter" | "passive" | "detractor"; pct: number; count: number }) {
  const ui = CLASS_UI[kind];
  return (
    <div style={{ flex: "1 1 150px", minWidth: 140, padding: "12px 16px", borderRadius: 16, background: `${ui.color}12` }}>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{ui.emoji} {ui.label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <b style={{ fontSize: 26, fontWeight: 800, color: ui.color }}>{pct}%</b>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{count} {count === 1 ? "оцінка" : "оцінок"}</span>
      </div>
    </div>
  );
}

/**
 * eNPS-аналітика (тип В) за ДОВІЛЬНИЙ період.
 *
 * 🔴 ЖОДНОГО ПОРОГА ТУТ НЕМАЄ. Відсотки, сам eNPS і смугу рахує сервер
 * (`oneOnOne/enps.ts`); цей компонент їх лише малює. Доти «Поточний eNPS» показував
 * ОСТАННІЙ МІСЯЦЬ ряду, а не період — і при довільному періоді це було б просто
 * неправдою.
 */
function EnpsView({ data, range, preset, onRange }: {
  data: O2OEnpsResponse | null;
  range: { from: string; to: string };
  preset: string | null;
  onRange: (r: { from: string; to: string }, preset: string | null) => void;
}) {
  const s = data?.summary;
  const maxAbs = Math.max(50, ...(data?.series ?? []).map((x) => Math.abs(x.enps ?? 0)));
  return (
    <div style={CARD}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800 }}>eNPS · %промоутерів − %критиків</h2>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            Період довільний — від дня до дня. {data ? `Показано ${data.from} — ${data.to}.` : ""}
          </p>
        </div>
        <DateRangeFilter value={range} onChange={(r) => onRange(r, null)} />
      </div>
      <div style={{ marginTop: 12 }}>
        <QuickPeriods active={preset} onSelect={(id, r) => onRange(r, id)} />
      </div>

      {!data ? (
        <p className="loading-text" style={{ margin: 0 }}>Завантаження…</p>
      ) : !s || s.total === 0 ? (
        /* 🔴 «Оцінок немає», а НЕ «0»: нуль читається як результат опитування. */
        <p className="loading-text" style={{ margin: "8px 0 0" }}>
          За цей період оцінок немає.{s && s.invalid > 0 ? ` (${s.invalid} поза шкалою 0-10 — у розрахунок не входять.)` : ""}
        </p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", margin: "16px 0 14px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 54, fontWeight: 800, lineHeight: 1,
                color: s.band ? BAND_COLOR[s.band.tone] : "var(--text)" }}>
                {s.enps! > 0 ? `+${s.enps}` : s.enps}
              </span>
              {s.band && <BandBadge band={s.band} big />}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              {s.total} {s.total === 1 ? "оцінка" : "оцінок"} у періоді
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <ShareTile kind="promoter"  pct={s.promotersPct}  count={s.promoters} />
            <ShareTile kind="passive"   pct={s.passivesPct}   count={s.passives} />
            <ShareTile kind="detractor" pct={s.detractorsPct} count={s.detractors} />
          </div>

          {/* 🔴 БАЛИ ПОЗА ШКАЛОЮ НАЗВАНІ ЧИСЛОМ (рішення власника). Доти такий бал мовчки
              потрапляв у знаменник як нейтрал і ЗАНИЖУВАВ eNPS. */}
          {s.invalid > 0 && (
            <div style={{ marginBottom: 14, padding: "9px 13px", borderRadius: 12, fontSize: 12.5,
              background: "rgba(220,38,38,.08)", color: "#b91c1c" }}>
              ⚠️ {s.invalid} {s.invalid === 1 ? "оцінка" : "оцінок"} поза шкалою 0-10 — у розрахунок НЕ входять.
            </div>
          )}

          <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 800 }}>
            Тренд <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>({GRAN_LABEL[data.granularity]}, обрано за довжиною періоду)</span>
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact" style={{ minWidth: 560 }}>
              <thead><tr>
                <th style={{ textAlign: "left" }}>Період</th>
                <th style={{ textAlign: "center" }}>{CLASS_UI.promoter.emoji}</th>
                <th style={{ textAlign: "center" }}>{CLASS_UI.passive.emoji}</th>
                <th style={{ textAlign: "center" }}>{CLASS_UI.detractor.emoji}</th>
                <th style={{ textAlign: "center" }}>Всього</th>
                <th style={{ textAlign: "left" }}>eNPS</th>
              </tr></thead>
              <tbody>
                {data.series.map((x) => (
                  <tr key={x.bucket}>
                    <td style={{ textAlign: "left", fontWeight: 600 }}>{bucketLabel(x.bucket, data.granularity)}</td>
                    <td style={{ textAlign: "center", color: CLASS_UI.promoter.color, fontWeight: 700 }}>{x.promoters}</td>
                    <td style={{ textAlign: "center", color: CLASS_UI.passive.color, fontWeight: 700 }}>{x.passives}</td>
                    <td style={{ textAlign: "center", color: CLASS_UI.detractor.color, fontWeight: 700 }}>{x.detractors}</td>
                    <td style={{ textAlign: "center" }}>{x.total}</td>
                    <td style={{ textAlign: "left" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span style={{ display: "inline-block", width: 120, height: 8, background: "rgba(128,128,128,.14)", borderRadius: 4, position: "relative" }}>
                          <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: "var(--text-muted)" }} />
                          {x.enps != null && <span style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 4,
                            background: x.enps >= 0 ? CLASS_UI.promoter.color : CLASS_UI.detractor.color,
                            left: x.enps >= 0 ? "50%" : `${50 - (Math.abs(x.enps) / maxAbs) * 50}%`,
                            width: `${(Math.abs(x.enps) / maxAbs) * 50}%` }} />}
                        </span>
                        <b style={{ color: x.enps == null ? "var(--text-muted)" : x.band ? BAND_COLOR[x.band.tone] : "var(--text)" }}>
                          {x.enps == null ? "—" : x.enps > 0 ? `+${x.enps}` : x.enps}
                        </b>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "10px 0 0" }}>
            Класи: {SCALE_CAPTION}. eNPS = %промоутерів − %критиків; нейтрали у формулу не входять.
          </p>
        </>
      )}
    </div>
  );
}

