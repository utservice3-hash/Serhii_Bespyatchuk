import { useEffect, useRef, useState } from "react";
import {
  fetchMyQuiz, startQuiz, answerQuiz, fetchQuizEditor, publishTrainingMaterial, setQuizQuestionLimit, hiringError,
  type MyQuiz, type QuizStep, type QuizTurn, type QuizAnswerValue, type QuizResult, type QuizEditorView,
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
 */
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

  const load = () => fetchMyQuiz(materialId).then((x) => { setMe(x); setErr(null); }).catch((e) => setErr(hiringError(e)));
  useEffect(() => { setRun(null); setResult(null); setA(undefined); void load(); }, [materialId]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (t: QuizTurn) => {
    if (t.done) {
      setResult(t.result); setRun(null); await load();
      if (t.result.passed) onPassed();
    } else { setRun({ step: t, at: Date.now() }); setNow(Date.now()); setA(undefined); }
  };
  const begin = async () => {
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
  const left = run ? Math.max(0, run.step.remainingSec - (now - run.at) / 1000) : 0;
  const expired = !!run && left <= 0;
  useEffect(() => { if (expired) void send(null); }, [expired]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !me) return <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>;
  if (!me) return <p className="loading-text">Завантаження…</p>;
  const need = Math.ceil((me.passPct * me.questionCount) / 100);

  // ── Результат щойно завершеної спроби ─────────────────────────────────
  if (result) {
    const wrong = result.results.filter((x) => !x.ok);
    return (
      <div className="qz">
        <div className="qz-score">
          <Ring pct={result.pct} ok={result.passed} sub={`${result.right} з ${result.total}`} />
          <div className="qz-score-t">
            <h2>{result.passed ? "Тест складено" : "Тест не складено"}</h2>
            {result.passed
              ? <div className="qz-banner ok"><b>Наступну тему відкрито</b><span>Рекрутер і ваш тімлід бачать результат: {result.right} з {result.total}.</span></div>
              : <div className="qz-banner bad"><b>Потрібно {need} з {result.total}, у вас {result.right}</b>
                  <span>{result.left > 0 ? `Лишилось спроб: ${result.left}. Перегляньте уроки з помилками нижче й спробуйте знову.` : "Спроби закінчились — тімлід або рекрутер може дати ще одну."}</span></div>}
            <div className="qz-actions">
              {result.passed
                ? (onNext && nextLabel ? <button className="hr-btn p" onClick={onNext}>{nextLabel} →</button> : null)
                : result.left > 0 && <button className="hr-btn p" disabled={busy} onClick={() => void begin()}>Спробувати ще раз</button>}
            </div>
          </div>
        </div>
        <h3 className="qz-h">{wrong.length ? `Де помилились (${wrong.length})` : "Помилок немає"}</h3>
        <div className="qz-res-list">
          {wrong.map((x) => (
            <div key={x.id} className="qz-res">
              <span className="m">✗</span>
              <div>
                <b>{x.text}</b>
                {x.late && <div className="qz-late">⏱ Час вийшов — відповідь не зарахована</div>}
                {x.explanation && <p>{x.explanation}</p>}
                {x.source && onOpenLesson && <button className="qz-link" onClick={() => onOpenLesson(x.source!)}>Повторити урок «{x.source}» →</button>}
              </div>
            </div>
          ))}
          {!wrong.length && <p className="hr-muted" style={{ margin: 0 }}>Усі {result.total} відповідей правильні.</p>}
        </div>
        {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
      </div>
    );
  }

  // ── Проходження: одне питання, таймер, без «Назад» ───────────────────
  if (run) {
    const { step } = run, q = step.question;
    const answered = a != null && (Array.isArray(a) ? a.length > 0 : String(a).trim() !== "");
    const secs = Math.ceil(left);
    const last = step.index + 1 >= step.total;
    return (
      <div className="qz">
        <div className="qz-top">
          <span className="hr-pill gr">{me.title} · спроба {me.used + 1}</span>
          <span className={`qz-timer${secs <= 10 ? " low" : ""}`} role="timer" aria-label={`Лишилось ${secs} секунд`}>⏱ {secs} с</span>
        </div>
        <div className="lr-bar qz-tbar"><i style={{ width: `${Math.max(0, Math.min(100, (left / step.limitSec) * 100))}%` }} /></div>
        <div className="qz-kind">Питання {step.index + 1} з {step.total} · {q.kind === "multi" ? "оберіть усі правильні" : q.kind === "number" ? "введіть число" : "одна правильна відповідь"}</div>
        <div className="qz-text">{q.text}</div>
        {q.kind === "number" ? (
          <div className="qz-numin">
            <input id={`qz-num-${q.id}`} className="hr-inp" inputMode="decimal" placeholder="Ваша відповідь" aria-label="Відповідь числом" autoFocus
              value={typeof a === "string" || typeof a === "number" ? String(a) : ""} onChange={(e) => setA(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && answered && !busy) void send(a!); }} />
          </div>
        ) : (
          <div className="qz-opts">
            {(q.options ?? []).map((o) => {
              const sel = q.kind === "multi" ? Array.isArray(a) && a.includes(o.i) : a === o.i;
              return (
                <button key={o.i} type="button" className={`qz-opt${q.kind === "multi" ? " multi" : ""}${sel ? " sel" : ""}`} aria-pressed={sel}
                  onClick={() => {
                    if (q.kind === "multi") { const st = new Set(Array.isArray(a) ? a : []); if (st.has(o.i)) st.delete(o.i); else st.add(o.i); setA([...st].sort((x, y) => x - y)); }
                    else setA(o.i);
                  }}>
                  <span className="mk" /><span>{o.text}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="qz-foot">
          <span className="hr-muted" style={{ fontSize: 12 }}>Повернутись до попереднього питання не можна</span>
          <button className="hr-btn p" disabled={busy || !answered} onClick={() => void send(a!)}>
            {busy ? "Зберігаємо…" : last ? "Завершити тест" : "Відповісти →"}</button>
        </div>
        {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
      </div>
    );
  }

  // ── Вступ / підсумок, якщо вже складено ─────────────────────────────
  const last = me.attempts[me.attempts.length - 1];
  return (
    <div className="qz">
      {me.passed && <div className="qz-banner ok"><b>Тест складено · {me.bestPct}%</b><span>Наступна тема відкрита.</span></div>}
      {intro && <p className="qz-introtext">{intro}</p>}
      {!me.passed && last && <div className="qz-banner bad"><b>Минула спроба: {last.right} з {last.total} ({last.pct}%)</b><span>Потрібно {need} з {me.questionCount}.</span></div>}
      <div className="qz-intro">
        <div><b>{me.questionCount}</b><span>питань</span></div>
        <div><b>{need} з {me.questionCount}</b><span>щоб скласти ({me.passPct}%)</span></div>
        <div><b>{me.passed ? "—" : me.left}</b><span>{me.passed ? "спроби більше не потрібні" : me.left === 1 ? "спроба лишилась" : "спроб лишилось"}</span></div>
      </div>
      <ul className="qz-rules">
        <li>На кожне питання — {me.limitMinSec === me.limitMaxSec ? `${me.limitMinSec} секунд` : `від ${me.limitMinSec} до ${me.limitMaxSec} секунд`}; таймер видно над питанням. Час вийшов — питання зараховується як неправильне.</li>
        <li>Питання йдуть по одному, повернутись до попереднього не можна. Оновлення сторінки таймер не зупиняє.</li>
        <li>Після тесту побачите, де помилились, і урок, де про це сказано.</li>
        <li>Склали — відкривається наступна тема. Ні — перегляньте уроки й спробуйте знову.</li>
      </ul>
      <div className="qz-actions">
        {!me.passed && (me.left > 0 || me.hasOpenAttempt)
          ? <button className="hr-btn p" disabled={busy || me.questionCount === 0} onClick={() => void begin()}>
              {busy ? "Готуємо питання…" : me.hasOpenAttempt ? "Продовжити тест" : me.used ? "Спробувати ще раз" : "Почати тест"}</button>
          : !me.passed && <span className="hr-muted">Спроби закінчились — тімлід або рекрутер може дати ще одну.</span>}
        {me.passed && onNext && nextLabel && <button className="hr-btn p" onClick={onNext}>{nextLabel} →</button>}
        {me.questionCount === 0 && <span className="hr-muted">У тесті ще немає питань.</span>}
      </div>
      {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
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
