import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchTrainingCourses, fetchTrainingCourse, fetchTrainingMaterial, openTrainingMaterial, doneTrainingMaterial,
  fetchCandidateMe, fetchMyTrainingQuestions, askTrainingQuestion, hiringError,
  type TrainingCourse, type TrainingCourseDetail, type TrainingMaterialContent, type CandidateMe, type MyTrainingQuestion,
} from "../../../api";
import { LessonBody } from "./LessonBody";
import { CourseHeader, LessonPage, ProgramAccordion } from "./LearnLayout";
import "./training.css";
import { useNavigate } from "react-router-dom";
import { fetchDocTree, type DocFile } from "../../../api";
import "./hiring.css";

/**
 * 🎓 «НАВЧАННЯ» ОЧИМА КАНДИДАТА (найм, прохід 2b, 18.09.2026) — за макетом v12.
 *
 * Порядок, замки й відсоток рахує сервер (`core/trainingProgress.ts`) — тут лише показ.
 * Вміст кроку теж береться із сервера окремим запитом, і для замкненого кроку сервер його не
 * віддає (423): «по черзі» тримається не на кнопці, а на відповіді.
 */

const HOUR = 3_600_000;
const kyiv = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  : "—");

type Step = TrainingCourseDetail["modules"][number]["materials"][number] & { module: string; courseId: number };

export function CandidateTraining() {
  const [me, setMe] = useState<CandidateMe | null>(null);
  const [courses, setCourses] = useState<TrainingCourse[] | null>(null);
  const [details, setDetails] = useState<TrainingCourseDetail[]>([]);
  const [questions, setQuestions] = useState<MyTrainingQuestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [stepId, setStepId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, c, q] = await Promise.all([fetchCandidateMe(), fetchTrainingCourses(), fetchMyTrainingQuestions()]);
      setMe(m); setCourses(c.courses); setQuestions(q);
      setDetails(await Promise.all(c.courses.map((x) => fetchTrainingCourse(x.id))));
      setErr(null);
    } catch (e) { setErr(hiringError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Усі кроки всіх курсів кандидата — у порядку сервера.
  const steps: Step[] = useMemo(() => details.flatMap((d) => d.modules.flatMap((m) =>
    m.materials.map((x) => ({ ...x, module: m.name, courseId: d.course.id })))), [details]);
  /** 🎓 Теми всіх курсів кандидата — для «Програми курсу» і бічної панелі уроку, як у Sereda. */
  const modules = useMemo(() => details.flatMap((d) => d.modules), [details]);
  const required = steps.filter((s) => s.required);
  const pct = required.length ? Math.round((required.filter((s) => s.state === "done").length / required.length) * 100) : 0;

  if (err) return <div className="hr-card"><div className="hr-sect" style={{ border: 0 }}><b>Не вдалося завантажити навчання.</b> <span className="hr-muted">{err}</span></div></div>;
  if (!courses || !me) return <p className="loading-text">Завантаження…</p>;

  if (stepId != null) {
    const idx = steps.findIndex((s) => s.id === stepId);
    return <StepView step={steps[idx]} next={steps.slice(idx + 1).find((s) => s.state !== "done") ?? null}
      modules={modules} percent={pct}
      questions={questions.filter((q) => q.material_id === stepId)} canAsk={me.candidate}
      onBack={() => { setStepId(null); void load(); }}
      onGo={(id) => { setStepId(id); void load(); }}
      onAsked={() => void load()} />;
  }
  return <Home me={me} courses={courses} steps={steps} modules={modules} questions={questions} onOpen={setStepId} />;
}

function deadlineText(me: Extract<CandidateMe, { candidate: true }>): [string, string] {
  if (!me.deadline) return ["", "gr"];
  const left = Math.round((new Date(me.deadline).getTime() - Date.now()) / HOUR);
  if (left <= 0) return ["строк навчання завершується", "dg"];
  return [`доступ ще ${left} год`, left <= 12 ? "dg" : left <= 30 ? "wn" : "pl"];
}

/**
 * 📄 ОФЕР У ВКЛАДЦІ КАНДИДАТА (пункт 7 власника, 21.09.2026): рекрутер формує офер із шаблону в «Наймі»,
 * він лягає в «Документи → Офери» на акаунт кандидата — а тут кандидат бачить його одразу, зі станом підпису,
 * і переходить підписати. Джерело — те саме дерево документів (сервер віддає лише СВІЙ офер), окремої логіки немає.
 */
function OfferCard() {
  const [offers, setOffers] = useState<DocFile[] | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    fetchDocTree().then((t) => { if (alive) setOffers(t.files.filter((f) => f.section === "offer" && !f.archivedAt && f.addresseeUserId === t.viewer.userId)); })
      .catch(() => { if (alive) setOffers([]); });
    return () => { alive = false; };
  }, []);
  if (!offers || !offers.length) return null;
  const STATE: Record<string, [string, string]> = {
    signed: ["підписано", "ok"], review: ["фото підпису на перевірці", "wn"], pending: ["чекає вашого підпису", "wn"],
    overdue: ["чекає вашого підпису", "dg"], outdated: ["нова версія — підпишіть ще раз", "wn"], not_required: ["", "gr"],
  };
  return (
    <div className="hr-card" style={{ marginBottom: 14 }}>
      {offers.map((f) => { const [txt, cls] = STATE[f.signature.kind] ?? ["", "gr"]; const toSign = f.signature.kind !== "signed" && f.signature.kind !== "review" && f.canSign; return (
        <div key={f.id} className="hr-sect" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", border: 0 }}>
          <span style={{ fontSize: 26 }}>📄</span>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 700 }}>Ваш офер</div>
            <div className="hr-muted" style={{ fontSize: 13 }}>{f.name.replace(/\.[a-z0-9]+$/i, "")}</div>
          </div>
          {txt && <span className={`hr-pill ${cls}`}>{f.signature.earlier ? "підписано раніше" : txt}</span>}
          <button className={toSign ? "hr-btn p" : "hr-btn"} onClick={() => navigate(`/documents?doc=${f.id}`)}>{toSign ? "Відкрити й підписати" : "Відкрити"}</button>
        </div>); })}
    </div>
  );
}

function Home({ me, courses, steps, modules, questions, onOpen }: {
  me: CandidateMe; courses: TrainingCourse[]; steps: Step[]; modules: TrainingCourseDetail["modules"]; questions: MyTrainingQuestion[]; onOpen: (id: number) => void;
}) {
  const required = steps.filter((s) => s.required);
  const done = required.filter((s) => s.state === "done").length;
  const pct = required.length ? Math.round((done / required.length) * 100) : 0;
  const next = steps.find((s) => s.state === "available" || s.state === "opened") ?? null;
  const titleOf = new Map(steps.map((s) => [s.id, s.title]));
  const dl = me.candidate ? deadlineText(me) : null;

  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>📚 Навчання</h1>
      <p className="hr-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        {me.candidate && me.teamName ? `Вітаємо в команді ${me.teamName}. ` : ""}
        Проходьте кроки по черзі: наступний відкривається, коли попередній позначено «Опрацював(ла)».
        {me.candidate && me.leadName ? ` Питання — тімліду ${me.leadName}.` : ""}
      </p>
      <OfferCard />

      {steps.length === 0 ? (
        <div className="hr-card"><div className="hr-sect" style={{ border: 0 }}>Курс для вас ще готується. Зазирніть трохи пізніше або напишіть рекрутеру.</div></div>
      ) : (
        <>
          {/* 🎓 Як у Sereda: шапка курсу зі станом і лічильниками, нижче «Програма курсу» темами-акордеонами. */}
          <CourseHeader title={courses.map((c) => c.title).join(" · ")} percent={pct} modules={modules} onContinue={onOpen}
            badge={<>
              {me.candidate && me.firstLoginAt && <span className={`hr-pill ${dl?.[1] ?? "pl"}`}>День {Math.max(me.day, 1)} із {me.days}{dl?.[0] ? ` · ${dl[0]}` : ""}</span>}
              <span className="hr-pill gr">{done} із {required.length} обовʼязкових</span>
            </>} />
          <div className="lr-sect">Програма курсу</div>
          <ProgramAccordion modules={modules} currentId={next?.id ?? null} onOpen={onOpen} />
          <div style={{ height: 18 }} />
        </>
      )}

      {me.candidate && (
        <div className="hr-card">
          <div className="hd"><h3>Питання тімліду</h3><span className="hr-muted">поставити питання можна прямо з кроку</span></div>
          <div className="hr-sect" style={{ borderTop: 0, paddingTop: 0 }}>
            {questions.length === 0 ? <div className="hr-muted">Питань ще не було.</div> : questions.map((q) => (
              <div key={q.id} className="hr-qa">
                <div><b>Ви:</b> {q.question} <span className="hr-muted">· {kyiv(q.asked_at)}{q.material_id && titleOf.get(q.material_id) ? ` · крок «${titleOf.get(q.material_id)}»` : ""}</span></div>
                {q.answer ? <div className="a">{q.answer} <span className="hr-muted">· {kyiv(q.answered_at)}</span></div> : <div className="hr-muted" style={{ marginTop: 4 }}>чекає відповіді тімліда</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StepView({ step, next, modules, percent, questions, canAsk, onBack, onGo, onAsked }: {
  step: Step | undefined; next: Step | null; modules: TrainingCourseDetail["modules"]; percent: number; questions: MyTrainingQuestion[]; canAsk: boolean;
  onBack: () => void; onGo: (id: number) => void; onAsked: () => void;
}) {
  const [m, setM] = useState<TrainingMaterialContent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [qMsg, setQMsg] = useState<string | null>(null);
  const id = step?.id;

  useEffect(() => {
    if (id == null) return;
    let alive = true;
    setM(null); setErr(null); setQ(""); setQMsg(null); // новий крок — чисте поле питання
    fetchTrainingMaterial(id)
      .then(async (x) => {
        if (!alive) return;
        setM(x);
        // Відкриття — це й «остання активність» на дошці тімліда. Повтор нічого не додає.
        if (x.status == null) await openTrainingMaterial(id).catch(() => undefined);
      })
      .catch((e) => { if (alive) setErr((e as { response?: { status?: number } }).response?.status === 423
        ? "Цей крок ще закритий: спершу пройдіть попередній." : hiringError(e)); });
    return () => { alive = false; };
  }, [id]);

  if (!step) return null;
  const done = m?.status === "done" || step.state === "done";

  const markDone = async () => {
    setBusy(true);
    try { await doneTrainingMaterial(step.id); if (next) onGo(next.id); else onBack(); }
    catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };
  const ask = async () => {
    const text = q.trim();
    if (!text) { setQMsg("Напишіть питання"); return; }
    try { await askTrainingQuestion(text, step.id); setQ(""); setQMsg("Питання надіслано тімліду — відповідь зʼявиться тут і на головній «Навчання»."); onAsked(); }
    catch (e) { setQMsg(hiringError(e)); }
  };

  return (
    <LessonPage title={step.title} done={done} modules={modules} currentId={step.id} percent={percent} onBack={onBack} onOpen={onGo}
      footer={m && <>
        {(m.kind as string) === "quiz"
          ? <span className="hr-muted">Тест зараховується перевіркою відповідей — зʼявиться разом з екзаменом.</span>
          : done
            ? <>{next && <button className="hr-btn p" onClick={() => onGo(next.id)}>Наступний урок: {next.title} →</button>}</>
            : <button className="hr-btn p" disabled={busy} onClick={() => void markDone()}>{busy ? "Зберігаємо…" : next ? "Опрацював(ла) — далі" : "Опрацював(ла)"}</button>}
        {!step.required && <span className="hr-muted">необовʼязковий урок</span>}
      </>}>
      {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
      {!m && !err && <p className="loading-text">Завантаження…</p>}
      {/* 📘 Урок цілим — той самий компонент, що й у кроці курсу (`#729`): кандидат бачить урок так само. */}
      {m && <LessonBody m={m} />}

      {canAsk && m && (
        <div className="hr-card" style={{ marginTop: 8 }}>
          <div className="hd"><h3>Питання тімліду</h3><span className="hr-muted">до цього уроку</span></div>
          <div className="hr-sect" style={{ borderTop: 0, paddingTop: 0 }}>
            {questions.map((x) => (
              <div key={x.id} className="hr-qa">
                <div><b>Ви:</b> {x.question} <span className="hr-muted">· {kyiv(x.asked_at)}</span></div>
                {x.answer ? <div className="a">{x.answer}</div> : <div className="hr-muted" style={{ marginTop: 4 }}>чекає відповіді тімліда</div>}
              </div>
            ))}
            <textarea className="hr-inp" rows={2} style={{ width: "100%", boxSizing: "border-box" }} placeholder="Що незрозуміло в цьому уроці?"
              aria-label="Питання тімліду" value={q} onChange={(ev) => { setQ(ev.target.value); setQMsg(null); }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <button className="hr-btn" onClick={() => void ask()}>Надіслати тімліду</button>
              {qMsg && <span className="hr-muted">{qMsg}</span>}
            </div>
          </div>
        </div>
      )}
    </LessonPage>
  );
}
