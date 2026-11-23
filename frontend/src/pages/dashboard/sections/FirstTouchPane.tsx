import { useEffect, useState } from "react";
import { fetchAiCallCard, hiringError, type AiCallCardResp, type AiCallRowT } from "../../../api";
import { approveState, approveWaitText, APPROVE_LABEL_UA, CHECK_ITEMS, CHECK_MARK_UI, CLOSURE_UI, DECISION_UI, PROMISE_UI, REVIEW_REASON_UI, STATE_UI, TONE_COLOR,
  fmtMinutes, mmss, priceNoteLine, scoreLabel } from "../aiCallsView";
import { ChecklistBlock } from "./FirstTouchChecklist";
import { FeedbackButton } from "./AiCallDrawer";

/**
 * 🪟 ПАНЕЛЬ РОЗМОВИ — праве вікно «Контролю» (Роман 23.11.2026, макет А «Розбір у два вікна»).
 *
 * Навіщо: у таблиці на 9 колонок опису «Про що (AI)» лишалось ~250 px, і чотири речення розтягувались на 18 рядків
 * (скрін Романа 23.11). Тут опис стоїть ПОВНІСТЮ, на всю ширину панелі; у списку ліворуч — два рядки.
 *
 * Що показує: те саме, що колонки колишньої таблиці («Після ціни», «Обіцянка», «Успіх», «Реакція», «Розбір»), плюс
 * чек-лист із цитатами — той самий `ChecklistBlock`, що в черзі розбору й у картці. Стан кнопки «Погоджую» — та сама
 * `approveState`, що в списку, черзі й картці (задача 9229): власної умови тут немає.
 *
 * Чого тут свідомо немає: плеєра й тексту розмови — вони в «Повній картці» і в черзі «Почати розбір». Панель — для
 * швидкого «прочитав і погодив», а не друга картка.
 */

const fmtFull = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" });

function Chip({ tone, title, children }: { tone: keyof typeof TONE_COLOR; title?: string; children: React.ReactNode }) {
  return <span className="ftd-chip" title={title} style={{ background: TONE_COLOR[tone].bg, color: TONE_COLOR[tone].fg }}>{children}</span>;
}

export function FirstTouchPane({ row: r, canReview, canFeedback, busy, onApprove, onOpenCard }: {
  row: AiCallRowT; canReview: boolean; canFeedback: boolean; busy: boolean; onApprove: () => void; onOpenCard: () => void;
}) {
  const [c, setC] = useState<AiCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Картку (цитати чек-листа, посилання на угоду) тягнемо з паузою: стрілками по списку проходять швидко, і запит на
  // кожну проминуту розмову був би зайвим. Усе, що вже є в рядку списку, видно одразу.
  useEffect(() => {
    let alive = true;
    setC(null); setErr(null);
    const t = window.setTimeout(() => {
      fetchAiCallCard(r.uniqueid).then((x) => { if (alive) setC(x); }).catch((e) => { if (alive) setErr(hiringError(e)); });
    }, 180);
    return () => { alive = false; window.clearTimeout(t); };
  }, [r.uniqueid]);

  const ap = approveState(r, canReview);
  const why = r.reviewReason ? REVIEW_REASON_UI[r.reviewReason] : null;
  const note = r.explainNote ?? r.priceNote;
  const dealTone = r.dealOutcome?.state === "success" ? "ok" : r.dealOutcome?.state === "lost" ? "muted" : "wait";

  return (
    <div className="ftd-pane-in">
      <div className="ftd-pane-head">
        <div style={{ minWidth: 0 }}>
          <h3>{r.managerName ?? "Менеджер невідомий"}</h3>
          <div className="ftd-sub">{r.teamName ?? "Поза командами"}</div>
        </div>
        <div className="ftd-sub" style={{ textAlign: "right" }}>
          {fmtFull(r.calledAt)} · {r.direction === "in" ? "вхідний" : "вихідний"} · {mmss(r.billsec)}
          {c?.dealUrls.map((u) => <span key={u.kommoId}> · <a href={u.url} target="_blank" rel="noreferrer">угода {u.kommoId} ↗</a></span>)}
        </div>
      </div>

      <h4>Про що розмова</h4>
      {/* Повний опис, без обрізки: саме заради цього рядка зроблено панель. */}
      {r.summary
        ? <p className="ftd-pane-text">{r.summary}</p>
        : <p className="ftd-pane-text ftd-sub">{r.state === "done" ? "AI не склав опису цієї розмови." : `Опису ще немає: ${STATE_UI[r.state].label.toLowerCase()}.`}</p>}

      <h4>Чек-лист{scoreLabel(r.checkScore) ? ` · ${scoreLabel(r.checkScore)!}` : ""}</h4>
      {c
        ? (c.result && r.checklist
          ? <ChecklistBlock c={c} checklist={r.checklist} promiseState={r.promiseState} conversationType={r.conversationType} onSeek={() => undefined} />
          : <p className="ftd-sub" style={{ margin: 0 }}>Чек-листа немає: {r.state === "done" ? "розмову не оцінюємо" : STATE_UI[r.state].label.toLowerCase()}.</p>)
        : r.checklist
          ? <div className="ftd-dots" aria-busy={!err}>
              {CHECK_ITEMS.map((it) => <i key={it.key} title={`${it.label}: ${CHECK_MARK_UI[r.checklist![it.key]].label}`} style={{ background: CHECK_MARK_UI[r.checklist![it.key]].color }} />)}
              <span className="ftd-sub" style={{ marginLeft: 8 }}>{err ? `Цитати не завантажились: ${err}` : "Завантажую цитати…"}</span>
            </div>
          : <p className="ftd-sub" style={{ margin: 0 }}>{err ?? "Завантажую…"}</p>}

      <h4>Підсумок</h4>
      <div className="ftd-pane-facts">
        {why && <Chip tone={why.tone} title="Причина, з якої розмова потрапила в розбір">{why.label}</Chip>}
        {r.clientDecision
          ? <Chip tone={DECISION_UI[r.clientDecision.value].tone} title={`${DECISION_UI[r.clientDecision.value].hint}${r.clientDecision.quote ? ` Клієнт: «${r.clientDecision.quote}»` : ""}`}>
              <b aria-hidden="true">{DECISION_UI[r.clientDecision.value].mark}</b> після ціни: {DECISION_UI[r.clientDecision.value].label}</Chip>
          : <span className="ftd-sub">після ціни: {r.checklist?.price === "y"
              ? <span className="ftd-sub" title="Згода після ціни розбирається для розмов від 13.10.2026">не розбиралось</span>
              : <span className="ftd-sub" title="Ціну в розмові не назвали — згоди питати нема про що">ціни не було</span>}</span>}
        {r.state === "done" && r.promiseState
          ? <Chip tone={PROMISE_UI[r.promiseState].tone} title={PROMISE_UI[r.promiseState].hint}>обіцянка: {PROMISE_UI[r.promiseState].label.toLowerCase()}</Chip>
          : r.state === "done" ? <span className="ftd-sub">обіцянок не було</span> : null}
        {r.dealOutcome
          ? <Chip tone={dealTone} title={r.dealOutcome.lossReason ? `Причина відмови в CRM: ${r.dealOutcome.lossReason}` : undefined}>
              угода: {r.dealOutcome.state === "success" ? "успіх" : r.dealOutcome.state === "lost" ? "відмова" : "у роботі"}</Chip>
          : <span className="ftd-sub">стан угоди невідомий</span>}
        <span className="ftd-sub" style={{ fontVariantNumeric: "tabular-nums" }}>
          реакція: {r.reactionMin == null ? "не виміряна" : fmtMinutes(r.reactionMin)}{r.reactionOffHours ? " · поза роб. часом" : ""}</span>
      </div>

      {(why || note) && <>
        <h4>Коментар менеджера</h4>
        {note
          ? <div className="ftd-pane-note">
              <div className="ftd-sub">{note.byName ?? "автор невідомий"}</div>
              {r.explainNote && <div>{r.explainNote.text}</div>}
              {r.priceNote && <div>{r.explainNote ? "Ціна: " : ""}{priceNoteLine(r.priceNote)}</div>}
            </div>
          : <div className="ftd-pane-note is-empty">Менеджер ще не написав, що було далі.</div>}
      </>}

      <div className="ftd-pane-acts">
        {r.reviewNote
          ? <span style={{ color: "var(--ok, #166534)", fontWeight: 600 }}>✓ {r.reviewNote.byName ?? "розібрано"} · {fmtDay(r.reviewNote.at)}
              {r.reviewClosure && r.reviewClosure !== "invoice" ? <span className="ftd-sub" title={CLOSURE_UI[r.reviewClosure].hint}> · {CLOSURE_UI[r.reviewClosure].label}</span> : null}</span>
          : r.reviewClosure === "invoice" ? <span style={{ color: "var(--ok, #166534)", fontWeight: 600 }} title={CLOSURE_UI.invoice.hint}>{CLOSURE_UI.invoice.label}</span>
          : ap?.kind === "can"
            ? <button type="button" className="ftd-btn ftd-approve" disabled={busy} onClick={onApprove}>{busy ? "Зберігаю…" : <>✓ {APPROVE_LABEL_UA} <kbd className="ftd-kbd">Enter</kbd></>}</button>
            : ap && <span className="ftd-sub" style={{ maxWidth: 420, color: ap.kind === "notManager" ? "var(--warn-fg, #8a5a00)" : undefined }}>{approveWaitText(ap)}</span>}
        <button type="button" className="ftd-btn" onClick={onOpenCard}>Повна картка</button>
        {canFeedback && <FeedbackButton uniqueid={r.uniqueid} />}
        <span className="ftd-pane-keys ftd-sub"><kbd className="ftd-kbd">↑</kbd> <kbd className="ftd-kbd">↓</kbd> між розмовами</span>
      </div>
    </div>
  );
}
