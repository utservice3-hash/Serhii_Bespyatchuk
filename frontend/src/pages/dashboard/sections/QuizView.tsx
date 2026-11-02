import { useEffect, useRef, useState } from "react";
import {
  fetchMyQuiz, startQuiz, answerQuiz, reportQuizViolation, fetchQuizEditor, publishTrainingMaterial, setQuizQuestionLimit, hiringError,
  type MyQuiz, type QuizStep, type QuizTurn, type QuizAnswerValue, type QuizResult, type QuizEditorView, type QuizViolationKind,
} from "../../../api";
import "./training.css";

/**
 * 📝 ТЕСТ ПІСЛЯ ТЕМИ — ЕКРАН УЧНЯ (13.10.2026, за макетом «Тести в курсі продажу»).
 *
 * Вступ (скільки питань, що треба, скільки спроб) → питання по одному → результат. Перевірка — ЛИШЕ на сервері:
 * екран не знає правильних відповідей (їх немає в жодній відповіді учневі), тож і «підглянути» нічого.
 * Після спроби — де помилка, пояснення й урок, де про це сказано; правильний варіант не показуємо (рішення Р5).
 *
 * ⏱ ЛІМІТ ЧАСУ (28.10.2026): сервер видає питання ПО ОДНОМУ й рахує час сам; екран лише показує залишок, який
 * прийшов із сервера, і, коли він дійшов до нуля, шле порожню відповідь. Назад повернутись не можна: інакше ліміт
 * обходився б тим, що на питання дивляться довше, ніж дозволено.
 *
 * 🖥 ПОВНИЙ ЕКРАН (28.10.2026): «Почати тест» розгортає браузер на весь екран, а тест закриває собою розділ. Вихід
 * із повного екрана, інша вкладка чи згорнутий браузер, інша програма довше 2 с — порушення; лічильник на сервері.
 * Два — попередження, третє завершує спробу як не складену. Одне «виходження» дає кілька подій браузера — рахуємо
 * один раз, доки людина не натисне «Повернутись до тесту». На iPhone повного екрана для сторінок немає — там
 * лишається вкладка/програма.
 */
const VIOLATION_TEXT: Record<QuizViolationKind, string> = {
  fullscreen_exit: "вийшли з повного екрана",
  tab_hidden: "перейшли на іншу вкладку чи згорнули браузер",
  window_blur: "перемкнулись в іншу програму",
};
const enterFullscreen = (fsOn: { current: boolean }) => {
  const el = document.documentElement;
  if (document.fullscreenElement) { fsOn.current = true; return; }
  if (typeof el.requestFullscreen !== "function") return; // iPhone/iPad: лишається вкладка/програма
  el.requestFullscreen().then(() => { fsOn.current = true; }).catch(() => undefined);
};
const exitFullscreen = (fsOn: { current: boolean }) => {
  fsOn.current = false;
  if (document.fullscreenElement && typeof document.exitFullscreen === "function") document.exitFullscreen().catch(() => undefined);
};
export function QuizView({ materialId, intro, onPassed, onOpenLesson, nextLabel, onNext }: {
  materialId: number;
  /** Вступ до тесту — текст уроку-тесту, який редактор пише в полі «Вступ». */
  intro?: string | null;
  /** Склав — батько перечитує курс (відкривається наступна тема). */
  onPassed: () => void;
  /** «Повторити урок «…»» — перейти до уроку за назвою. */
  onOpenLesson?: (title: string) => void;
  nextLabel?: string | null;
  onNext?: () => void;
}) {
  const [me, setMe] = useState<MyQuiz | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Поточне питання і мить, коли прийшла відповідь сервера: залишок = remainingSec − скільки минуло відтоді.
  const [run, setRun] = useState<{ step: QuizStep; at: number } | null>(null);
  const [a, setA] = useState<QuizAnswerValue | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuizResult | null>(null);
  const sending = useRef(false);
  const fsOn = useRef(false);   // ми розгорнули повний екран — його втрата є порушенням
  const away = useRef(false);   // людина «вийшла»; наступні події того самого виходу не рахуються
  const [warn, setWarn] = useState<{ n: number; limit: number; kind: QuizViolationKind } | null>(null);

  const load = () => fetchMyQuiz(materialId).then((x) => { setMe(x); setErr(null); }).catch((e) => setErr(hiringError(e)));
  useEffect(() => { setRun(null); setResult(null); setA(undefined); void load(); }, [materialId]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (t: QuizTurn) => {
    if (t.done) {
      exitFullscreen(fsOn); away.current = false; setWarn(null);
      setResult(t.result); setRun(null); await load();
      if (t.result.passed) onPassed();
    } else { setRun({ step: t, at: Date.now() }); setNow(Date.now()); setA(undefined); }
  };
  const begin = async () => {
    enterFullscreen(fsOn); // лише в обробнику кліку: браузер дає повний екран тільки на дію людини
    away.current = false; setWarn(null);
    setBusy(true); setErr(null);
    try { setResult(null); await apply(await startQuiz(materialId)); }
    catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };
  /** Відповідь на поточне питання; `null` — час вийшов. Розійшлись із сервером (стара вкладка) — беремо його поточний хід. */
  const send = async (value: QuizAnswerValue | null) => {
    if (!run || sending.current) return;
    sending.current = true; setBusy(true); setErr(null);
    try { await apply(await answerQuiz(materialId, run.step.attemptId, run.step.question.id, value)); }
    catch (e) {
      try { await apply(await startQuiz(materialId)); } catch { setErr(hiringError(e)); }
    }
    sending.current = false; setBusy(false);
  };
  useEffect(() => {
    if (!run) return;
    const h = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(h);
  }, [run]);
  // 🖥 Вихід із тесту → сервер рахує; третій завершує спробу (у відповідь — результат).
  const attemptId = run?.step.attemptId ?? null;
  useEffect(() => {
    if (attemptId == null) return;
    let blurTimer: number | undefined;
    const leave = (kind: QuizViolationKind) => {
      if (away.current) return;
      away.current = true;
      reportQuizViolation(materialId, attemptId, kind)
        .then((r) => { if (r.done) void apply({ done: true, result: r.result }); else setWarn({ n: r.violations, limit: r.limit, kind }); })
        .catch((e) => { setWarn({ n: 0, limit: 3, kind }); setErr(hiringError(e)); });
    };
    const onVis = () => { if (document.hidden) leave("tab_hidden"); };
    const onFs = () => { if (!document.fullscreenElement && fsOn.current) { fsOn.current = false; leave("fullscreen_exit"); } };
    const onBlur = () => { window.clearTimeout(blurTimer); blurTimer = window.setTimeout(() => { if (!document.hasFocus()) leave("window_blur"); }, 2000); };
    const onFocus = () => window.clearTimeout(blurTimer);
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("fullscreenchange", onFs);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(blurTimer);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("fullscreenchange", onFs);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [attemptId, materialId]); // eslint-disable-line react-hooks/exhaustive-deps
  const backToQuiz = () => { enterFullscreen(fsOn); away.current = false; setWarn(null); };

  const left = run ? Math.max(0, run.step.remainingSec - (now - run.at) / 1000) : 0;
  const expired = !!run && left <= 0;
  useEffect(() => { if (expired) void send(null); }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !me) return <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>;
  if (!me) return <p className="loading-text">Завантаження…</p>;
  const need = Math.ceil((me.passPct * me.questionCount) / 100);
  const errNote = err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>;
  const leftWord = (n: number) => (n === 1 ? "спроба лишилась" : n >= 2 && n <= 4 ? "спроби лишилось" : "спроб лишилось");

  // 🎨 ВИГЛЯД (02.11.2026, Роман: «кнопки й поля розкидані — зроби гарно»; макет «Екрани тесту UTS»): кожен екран —
  // ОДНА картка: шапка (що це й де ми), тіло, підвал із дією. Нічого не «плаває» по фону розділу.

  // ── Результат щойно завершеної спроби ─────────────────────────────────
  if (result) {
    const wrong = result.results.filter((x) => !x.ok);
    const byExit = result.endedBy === "violations";
    const leftText = result.left > 0 ? `Лишилось спроб: ${result.left}.` : "Спроби закінчились — тімлід або рекрутер може дати ще одну.";
    return (
      <div className="qz-card">
        <div className="qz-res-top">
          <Ring pct={result.pct} ok={result.passed} sub={`${result.right} з ${result.total}`} />
          <div className="qz-verdict">
            {result.passed ? <span className="qz-tag ok">✓ Складено</span> : byExit ? <span className="qz-tag warn">⛶ Не зараховано</span> : <span className="qz-tag bad">✗ Не складено</span>}
            <h2>{result.passed ? "Наступну тему відкрито" : byExit ? "Ви 3 рази виходили з тесту" : `Потрібно ${need} з ${result.total}, у вас ${result.right}`}</h2>
            <p>{result.passed ? `Рекрутер і ваш тімлід бачать результат: ${result.right} з ${result.total}.`
              : byExit ? `Спробу завершено як не складену, незалежно від відповідей. Тімлід і рекрутер бачать причину. ${leftText}`
              : `${leftText}${result.left > 0 ? " Перегляньте уроки з помилками нижче й спробуйте знову." : ""}`}</p>
          </div>
        </div>
        <div className="qz-foot">
          <span className="qz-hint">{me.title}</span>
          {result.passed
            ? (onNext && nextLabel ? <button className="qz-btn" onClick={onNext}>{nextLabel} →</button> : null)
            : result.left > 0 && <button className="qz-btn" disabled={busy} onClick={() => void begin()}>Спробувати ще раз</button>}
        </div>
        <div className="qz-mist">
          <h3>{wrong.length ? `Де помилились · ${wrong.length}` : "Помилок немає"}</h3>
          {wrong.map((x) => (
            <div key={x.id} className="qz-m">
              <span className="x">✗</span>
              <div>
                <b>{x.text}</b>
                {x.late && <span className="qz-late">⏱ Час вийшов — відповідь не зарахована</span>}
                {x.explanation && <p>{x.explanation}</p>}
                {x.source && onOpenLesson && <button className="qz-link" onClick={() => onOpenLesson(x.source!)}>Повторити урок «{x.source}» →</button>}
              </div>
            </div>
          ))}
          {!wrong.length && <p className="qz-hint">Усі {result.total} відповідей правильні.</p>}
          {errNote}
        </div>
      </div>
    );
  }

  // ── Проходження: одне питання, таймер, без «Назад» ───────────────────
  if (run) {
    const { step } = run, q = step.question;
    const answered = a != null && (Array.isArray(a) ? a.length > 0 : String(a).trim() !== "");
    const secs = Math.ceil(left);
    const last = step.index + 1 >= step.total;
    const kindText = q.kind === "multi" ? "оберіть усі правильні" : q.kind === "number" ? "введіть число" : "одна правильна відповідь";
    return (
      <div className="qz-fs">
        <div className="qz-card qz-run">
          <div className="qz-head">
            <div className="qz-head-t">
              <div className="qz-eyebrow">Питання {step.index + 1} з {step.total} · {kindText}</div>
              <h1>{me.title}</h1>
            </div>
            <TimerRing left={left} limit={step.limitSec} secs={secs} />
          </div>
          <div className="qz-steps" aria-hidden="true">
            {Array.from({ length: step.total }, (_, i) => <i key={i} className={i < step.index ? "done" : i === step.index ? "cur" : ""} />)}
          </div>
          <div className="qz-body">
            <p className="qz-q">{q.text}</p>
            {q.kind === "number" ? (
              <div className="qz-numin">
                <input id={`qz-num-${q.id}`} inputMode="decimal" placeholder="0" aria-label="Відповідь числом" autoFocus
                  value={typeof a === "string" || typeof a === "number" ? String(a) : ""} onChange={(e) => setA(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && answered && !busy) void send(a!); }} />
              </div>
            ) : (
              <div className="qz-opts">
                {(q.options ?? []).map((o, n) => {
                  const sel = q.kind === "multi" ? Array.isArray(a) && a.includes(o.i) : a === o.i;
                  return (
                    <button key={o.i} type="button" className={`qz-opt${q.kind === "multi" ? " multi" : ""}${sel ? " sel" : ""}`} aria-pressed={sel}
                      onClick={() => {
                        if (q.kind === "multi") { const st = new Set(Array.isArray(a) ? a : []); if (st.has(o.i)) st.delete(o.i); else st.add(o.i); setA([...st].sort((x, y) => x - y)); }
                        else setA(o.i);
                      }}>
                      <span className="k">{q.kind === "multi" ? (sel ? "✓" : "") : LETTERS[n] ?? n + 1}</span><span>{o.text}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {errNote}
          </div>
          <div className="qz-foot">
            <span className="qz-hint">↺ Повернутись до попереднього питання не можна</span>
            <button className="qz-btn" disabled={busy || !answered} onClick={() => void send(a!)}>
              {busy ? "Зберігаємо…" : last ? "Завершити тест" : "Відповісти →"}</button>
          </div>
        </div>
        {warn && (
          <div className="qz-warn" role="alertdialog" aria-modal="true" aria-labelledby="qz-warn-h">
            <div className="qz-warn-box">
              <div className="ic">!</div>
              <h3 id="qz-warn-h">{warn.n ? `Попередження ${warn.n} з ${warn.limit - 1}` : "Ви вийшли з тесту"}</h3>
              <div className="qz-dots" aria-hidden="true">{Array.from({ length: warn.limit }, (_, i) => <i key={i} className={i < warn.n ? "on" : ""} />)}</div>
              <p>Ви {VIOLATION_TEXT[warn.kind]}. {warn.n >= warn.limit - 1
                ? "Наступний вихід завершить тест як не складений."
                : `Ще ${warn.limit - warn.n} виходи — і тест не буде зараховано.`} Таймер питання не зупинявся.</p>
              <button className="qz-btn" autoFocus onClick={backToQuiz}>Повернутись до тесту</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Вступ / підсумок, якщо вже складено ─────────────────────────────
  const prev = me.attempts[me.attempts.length - 1];
  const limits = me.limitMinSec === me.limitMaxSec ? `${me.limitMinSec} секунд на питання` : `${me.limitMinSec}–${me.limitMaxSec} секунд на питання`;
  return (
    <div className="qz-card">
      <div className="qz-body">
        {me.passed && <div className="qz-banner ok"><b>Тест складено · {me.bestPct}%</b><span>Наступна тема відкрита.</span></div>}
        {!me.passed && prev && <div className="qz-banner bad"><b>Минула спроба: {prev.right} з {prev.total} ({prev.pct}%)</b><span>Потрібно {need} з {me.questionCount}.</span></div>}
        {intro && <p className="qz-introtext">{intro}</p>}
        <div className="qz-facts">
          <div><b>{me.questionCount}</b><span>питань</span></div>
          <div><b>{need} з {me.questionCount}</b><span>щоб скласти ({me.passPct}%)</span></div>
          <div><b>{me.passed ? "—" : me.left}</b><span>{me.passed ? "спроби більше не потрібні" : leftWord(me.left)}</span></div>
        </div>
        <ul className="qz-rules">
          <li><span className="ic">⏱</span><div><b>{limits}</b><span>Час вийшов — питання зараховується як неправильне.</span></div></li>
          <li><span className="ic">→</span><div><b>Питання по одному</b><span>Повернутись до попереднього не можна. Оновлення сторінки таймер не зупиняє.</span></div></li>
          <li><span className="ic">⛶</span><div><b>На весь екран</b><span>Вихід із тесту, інша вкладка чи програма — порушення. Два попередження, на третій раз спроба не зараховується.</span></div></li>
        </ul>
        {errNote}
      </div>
      <div className="qz-foot">
        <span className="qz-hint">Після тесту побачите, де помилились, і урок, де про це сказано</span>
        {!me.passed && (me.left > 0 || me.hasOpenAttempt)
          ? <button className="qz-btn" disabled={busy || me.questionCount === 0} onClick={() => void begin()}>
              {busy ? "Готуємо питання…" : me.hasOpenAttempt ? "Продовжити тест →" : me.used ? "Спробувати ще раз" : "Почати тест →"}</button>
          : !me.passed ? <span className="qz-hint">Спроби закінчились — тімлід або рекрутер може дати ще одну.</span>
          : onNext && nextLabel ? <button className="qz-btn" onClick={onNext}>{nextLabel} →</button> : null}
      </div>
      {me.questionCount === 0 && <p className="qz-hint" style={{ padding: "0 22px 16px" }}>У тесті ще немає питань.</p>}
    </div>
  );
}

const LETTERS = ["А", "Б", "В", "Г", "Д", "Е", "Є", "Ж"];

/** Таймер-кільце: дуга — залишок від ліміту; останні 10 секунд — червоним. */
function TimerRing({ left, limit, secs }: { left: number; limit: number; secs: number }) {
  const R = 21, C = 2 * Math.PI * R, frac = Math.max(0, Math.min(1, left / limit));
  return (
    <div className={`qz-timer${secs <= 10 ? " low" : ""}`} role="timer" aria-label={`Лишилось ${secs} секунд`}>
      <svg viewBox="0 0 52 52" aria-hidden="true">
        <circle className="track" cx="26" cy="26" r={R} />
        <circle className="arc" cx="26" cy="26" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <b>{secs}</b>
    </div>
  );
}

function Ring({ pct, ok, sub }: { pct: number; ok: boolean; sub: string }) {
  const R = 52, C = 2 * Math.PI * R;
  return (
    <svg className="qz-ring" viewBox="0 0 120 120" role="img" aria-label={`${pct}%`}>
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--border)" strokeWidth="10" />
      <circle cx="60" cy="60" r={R} fill="none" stroke={ok ? "var(--ok)" : "var(--danger)"} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${(C * pct) / 100} ${C}`} transform="rotate(-90 60 60)" />
      <text x="60" y="58" textAnchor="middle" fontSize="26" fontWeight="800" fill="var(--text)">{pct}%</text>
      <text x="60" y="80" textAnchor="middle" fontSize="12" fill="var(--text-muted)">{sub}</text>
    </svg>
  );
}

/**
 * 📝 ТЕСТ У РЕДАКТОРІ КУРСУ (13.10.2026) — налаштування й питання РАЗОМ із правильними відповідями, лише перегляд.
 * Правка питань — прохід 2; до нього питання оновлюються повторним імпортом (`tools/importQuiz.ts`).
 * Правильні відповіді приходять лише цьому екрану (`GET /quiz/:id/editor`, право `manage_training`).
 */
export function QuizEditorPanel({ materialId, draft, onPublished }: { materialId: number; draft: boolean; onPublished: () => void }) {
  const [v, setV] = useState<QuizEditorView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchQuizEditor(materialId).then(setV).catch((e) => setErr(hiringError(e))); }, [materialId]);
  if (err) return <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>;
  if (!v) return <p className="loading-text">Завантаження тесту…</p>;
  const s = v.settings;
  const shown = s.showCount && s.showCount < v.questions.length ? s.showCount : v.questions.length;
  const kindWord = (k: string) => (k === "multi" ? "кілька правильних" : k === "number" ? "число" : "один варіант");
  return (
    <div className="qz">
      <div className="qz-top">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className={`hr-pill ${draft ? "wn" : "ok"}`}>{draft ? "Чернетка — кандидати не бачать" : "Опубліковано"}</span>
          <span className="hr-pill gr">поріг {s.passPct}%</span>
          <span className="hr-pill gr">{shown} з {v.questions.length} питань у спробі</span>
          <span className="hr-pill gr">{s.maxAttempts} спроби</span>
        </div>
        {draft && <button className="hr-btn p" disabled={busy || !v.questions.length}
          onClick={async () => { setBusy(true); try { await publishTrainingMaterial(materialId); onPublished(); } catch (e) { setErr(hiringError(e)); } setBusy(false); }}>
          {busy ? "Публікуємо…" : "Опублікувати тест"}</button>}
      </div>
      <div className="qz-res-list">
        {v.questions.map((q, i) => (
          <div key={q.id} className="qz-eq">
            <span className="n">{i + 1}</span>
            <div>
              <b>{q.text}</b>
              <div className="hr-muted" style={{ fontSize: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span>{kindWord(q.kind)}{q.sourceTitle ? ` · урок «${q.sourceTitle}»` : ""}</span>
                <LimitField materialId={materialId} questionId={q.id} value={q.timeLimitSec} />
              </div>
              {q.options && <ul className="qz-eopts">{q.options.map((o, oi) => (
                <li key={oi} className={Array.isArray(q.correct) && q.correct.includes(oi) ? "ok" : ""}>{Array.isArray(q.correct) && q.correct.includes(oi) ? "✓ " : ""}{o}</li>))}</ul>}
              {!q.options && !Array.isArray(q.correct) && <div className="qz-eopts"><span className="ok">✓ {q.correct.value}{q.correct.tol ? ` ± ${q.correct.tol}` : ""}</span></div>}
              {q.explanation && <p>{q.explanation}</p>}
            </div>
          </div>
        ))}
      </div>
      <p className="hr-muted" style={{ margin: 0, fontSize: 12 }}>Ліміт часу на питання — тут, не менше 30 секунд. Тексти питань — повторним імпортом із погодженого документа.</p>
    </div>
  );
}

/** ⏱ Ліміт часу питання в редакторі: зберігається, щойно поле втратило фокус; менше 30 с не приймає ні екран, ні сервер. */
function LimitField({ materialId, questionId, value }: { materialId: number; questionId: number; value: number }) {
  const [v, setV] = useState(String(value));
  const [saved, setSaved] = useState(value);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    const n = Number(v);
    if (n === saved) return;
    if (!Number.isInteger(n) || n < 30) { setMsg("не менше 30 с"); setV(String(saved)); return; }
    try { const r = await setQuizQuestionLimit(materialId, questionId, n); setSaved(r.timeLimitSec); setMsg("збережено"); }
    catch (e) { setMsg(hiringError(e)); setV(String(saved)); }
  };
  return (
    <label className="qz-elim">
      ⏱ <input id={`qz-lim-${questionId}`} type="number" min={30} max={600} step={5} value={v} aria-label="Секунд на питання"
        onChange={(e) => { setV(e.target.value); setMsg(null); }} onBlur={() => void save()} /> с
      {msg && <span className={msg === "збережено" ? "ok" : "bad"}>{msg}</span>}
    </label>
  );
}
