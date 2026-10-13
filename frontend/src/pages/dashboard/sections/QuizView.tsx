import { useEffect, useState } from "react";
import {
  fetchMyQuiz, startQuiz, submitQuiz, fetchQuizEditor, publishTrainingMaterial, hiringError,
  type MyQuiz, type QuizPublicQuestion, type QuizAnswerValue, type QuizResult, type QuizEditorView,
} from "../../../api";
import "./training.css";

/**
 * 📝 ТЕСТ ПІСЛЯ ТЕМИ — ЕКРАН УЧНЯ (13.10.2026, за макетом «Тести в курсі продажу»).
 *
 * Вступ (скільки питань, що треба, скільки спроб) → питання по одному → результат. Перевірка — ЛИШЕ на сервері:
 * екран не знає правильних відповідей (їх немає в жодній відповіді учневі), тож і «підглянути» нічого.
 * Після спроби — де помилка, пояснення й урок, де про це сказано; правильний варіант не показуємо (рішення Р5).
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
  const [run, setRun] = useState<{ attemptId: number; questions: QuizPublicQuestion[] } | null>(null);
  const [answers, setAnswers] = useState<Record<number, QuizAnswerValue>>({});
  const [cur, setCur] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuizResult | null>(null);

  const load = () => fetchMyQuiz(materialId).then((x) => { setMe(x); setErr(null); }).catch((e) => setErr(hiringError(e)));
  useEffect(() => { setRun(null); setResult(null); setAnswers({}); setCur(0); void load(); }, [materialId]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = async () => {
    setBusy(true); setErr(null);
    try { const r = await startQuiz(materialId); setRun({ attemptId: r.attemptId, questions: r.questions }); setAnswers({}); setCur(0); setResult(null); }
    catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };
  const finish = async () => {
    if (!run) return;
    setBusy(true); setErr(null);
    try {
      const r = await submitQuiz(materialId, run.attemptId, answers);
      setResult(r); setRun(null); await load();
      if (r.passed) onPassed();
    } catch (e) { setErr(hiringError(e)); }
    setBusy(false);
  };

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

  // ── Проходження ───────────────────────────────────────────────────────
  if (run) {
    const qs = run.questions, q = qs[cur], a = answers[q.id];
    const answered = (x: QuizPublicQuestion) => { const v = answers[x.id]; return v != null && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== ""); };
    const nAns = qs.filter(answered).length;
    const setA = (v: QuizAnswerValue) => setAnswers((s) => ({ ...s, [q.id]: v }));
    return (
      <div className="qz">
        <div className="qz-top">
          <span className="hr-pill gr">{me.title} · спроба {me.used + 1}</span>
          <span className="hr-muted qz-num">Відповіли на {nAns} з {qs.length}</span>
        </div>
        <div className="lr-bar"><i style={{ width: `${Math.round((nAns / qs.length) * 100)}%` }} /></div>
        <div className="qz-nav" role="tablist" aria-label="Питання тесту">
          {qs.map((x, i) => (
            <button key={x.id} type="button" className={`${answered(x) ? "done" : ""}${i === cur ? " cur" : ""}`} aria-label={`Питання ${i + 1}`} onClick={() => setCur(i)}>{i + 1}</button>
          ))}
        </div>
        <div className="qz-kind">Питання {cur + 1} з {qs.length} · {q.kind === "multi" ? "оберіть усі правильні" : q.kind === "number" ? "введіть число" : "одна правильна відповідь"}</div>
        <div className="qz-text">{q.text}</div>
        {q.kind === "number" ? (
          <div className="qz-numin">
            <input id={`qz-num-${q.id}`} className="hr-inp" inputMode="decimal" placeholder="Ваша відповідь" aria-label="Відповідь числом"
              value={typeof a === "string" || typeof a === "number" ? String(a) : ""} onChange={(e) => setA(e.target.value)} />
          </div>
        ) : (
          <div className="qz-opts">
            {(q.options ?? []).map((o) => {
              const sel = q.kind === "multi" ? Array.isArray(a) && a.includes(o.i) : a === o.i;
              return (
                <button key={o.i} type="button" className={`qz-opt${q.kind === "multi" ? " multi" : ""}${sel ? " sel" : ""}`} aria-pressed={sel}
                  onClick={() => {
                    if (q.kind === "multi") { const s = new Set(Array.isArray(a) ? a : []); if (s.has(o.i)) s.delete(o.i); else s.add(o.i); setA([...s].sort((x, y) => x - y)); }
                    else setA(o.i);
                  }}>
                  <span className="mk" /><span>{o.text}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="qz-foot">
          <button className="hr-btn" disabled={cur === 0} onClick={() => setCur(cur - 1)}>← Назад</button>
          {cur < qs.length - 1
            ? <button className="hr-btn p" onClick={() => setCur(cur + 1)}>Далі →</button>
            : <button className="hr-btn p" disabled={busy || nAns < qs.length} title={nAns < qs.length ? "Дайте відповідь на всі питання" : ""} onClick={() => void finish()}>
                {busy ? "Перевіряємо…" : "Завершити тест"}</button>}
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
        <li>Відповіді можна змінювати, доки не натиснете «Завершити тест».</li>
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
              <div className="hr-muted" style={{ fontSize: 12 }}>{kindWord(q.kind)}{q.sourceTitle ? ` · урок «${q.sourceTitle}»` : ""}</div>
              {q.options && <ul className="qz-eopts">{q.options.map((o, oi) => (
                <li key={oi} className={Array.isArray(q.correct) && q.correct.includes(oi) ? "ok" : ""}>{Array.isArray(q.correct) && q.correct.includes(oi) ? "✓ " : ""}{o}</li>))}</ul>}
              {!q.options && !Array.isArray(q.correct) && <div className="qz-eopts"><span className="ok">✓ {q.correct.value}{q.correct.tol ? ` ± ${q.correct.tol}` : ""}</span></div>}
              {q.explanation && <p>{q.explanation}</p>}
            </div>
          </div>
        ))}
      </div>
      <p className="hr-muted" style={{ margin: 0, fontSize: 12 }}>Правка питань у редакторі — наступним проходом. Зараз питання оновлюються повторним імпортом із погодженого документа.</p>
    </div>
  );
}
