import { useEffect, useRef, useState } from "react";
import { fetchAiCallCard, fetchAiCallRecording, hiringError, type AiCallCardResp, type AiCallRowT } from "../../../api";
import { approveState, approveWaitText, APPROVE_LABEL_UA, CHECK_ITEMS, CHECK_MARK_UI, CLOSURE_UI, DECISION_UI, PROMISE_UI, REVIEW_REASON_UI, STATE_UI, TONE_COLOR,
  afterLabel, fmtMinutes, mmss, priceNoteLine, quoteTurnIndex, scoreLabel } from "../aiCallsView";
import { ChecklistBlock } from "./FirstTouchChecklist";
import { Analysis, CloseDealBlock, FeedbackButton, NotesBlock, QuoteSeek, TypeBlock } from "./AiCallDrawer";
import { CallConversation, type SeekFn } from "./CallConversation";

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
 * 🎧 З 24.11.2026 (Роман: «чому тут не відкривається розмова і не має всієї інфи, давай сюди і дзвінок перенесемо») тут
 * УСЯ розмова: плеєр (тримається вгорі під час прокрутки), текст розмови, «Розбір AI», тип розмови, коментарі й «Угода в
 * Kommo» — ті самі блоки, що в «Повній картці» (`AiCallDrawer`), а не копії. До цього панель показувала цитату кнопкою
 * «▶ 0:22», яка нічого не робила: плеєра не було, перемотувати було нічого.
 *
 * Запис тягнеться лише після ▶ або кліку по цитаті (`preload={false}`): по списку ходять стрілками, і качати запис кожної
 * проминутої розмови було б зайвим. Плеєр стає на паузу, коли панель закрита чергою чи карткою (`active`).
 */

const fmtFull = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" });

function Chip({ tone, title, children }: { tone: keyof typeof TONE_COLOR; title?: string; children: React.ReactNode }) {
  return <span className="ftd-chip" title={title} style={{ background: TONE_COLOR[tone].bg, color: TONE_COLOR[tone].fg }}>{children}</span>;
}

export function FirstTouchPane({ row: r, canReview, canFeedback, busy, active, onApprove, onOpenCard, onChanged }: {
  row: AiCallRowT; canReview: boolean; canFeedback: boolean; busy: boolean;
  /** `false` — панель закрита чергою розбору або повною карткою: запис стає на паузу. */
  active: boolean;
  onApprove: () => void; onOpenCard: () => void;
  /** Тип, коментар чи угоду змінили в панелі — список ліворуч має перечитатись. */
  onChanged: () => void;
}) {
  const [c, setC] = useState<AiCallCardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const seekRef = useRef<SeekFn | null>(null);
  // Картку (цитати чек-листа, посилання на угоду) тягнемо з паузою: стрілками по списку проходять швидко, і запит на
  // кожну проминуту розмову був би зайвим. Усе, що вже є в рядку списку, видно одразу.
  useEffect(() => {
    let alive = true;
    setErr(null);
    // Перечитування після зміни в панелі (`rev`) оновлює картку на місці: інакше плеєр і текст зникали б на мить.
    if (rev === 0) setC(null);
    const t = window.setTimeout(() => {
      fetchAiCallCard(r.uniqueid).then((x) => { if (alive) setC(x); }).catch((e) => { if (alive) setErr(hiringError(e)); });
    }, rev === 0 ? 180 : 0);
    return () => { alive = false; window.clearTimeout(t); };
  }, [r.uniqueid, rev]);
  const changed = () => { setRev((x) => x + 1); onChanged(); };

  const ap = approveState(r, canReview);
  const why = r.reviewReason ? REVIEW_REASON_UI[r.reviewReason] : null;
  const note = r.explainNote ?? r.priceNote;
  const dealTone = r.dealOutcome?.state === "success" ? "ok" : r.dealOutcome?.state === "lost" ? "muted" : "wait";
  // 🎧 Запис і текст — за тими самими правилами, що в черзі й картці: текст лише коли сервер його віддав; моно без
  // розділення голосів не перемотуємо й не підсвічуємо (це вдавало б точність, якої немає).
  const res = c?.result ?? null;
  const turns = c && !c.transcriptHidden ? c.turns : null;
  const listen = c != null && c.canListen && c.durationSec != null;
  const mixed = c?.mono === "mixed";
  const quoted = new Set(res && !mixed ? [res.price, ...res.objections, ...res.promises].map((q) => quoteTurnIndex(turns, q.quote)).filter((i) => i >= 0) : []);
  const seekQuote = (quote: string, go = false): number | null => {
    const i = quoteTurnIndex(turns, quote); const t = i >= 0 ? turns?.[i]?.start ?? null : null;
    if (go && t != null) seekRef.current?.(t);
    return t;
  };

  // Усе між плеєром і текстом розмови: чек-лист і погодження стоять вище за довгий текст.
  const mid = (
    <>
      <h4>Чек-лист{scoreLabel(r.checkScore) ? ` · ${scoreLabel(r.checkScore)!}` : ""}</h4>
      {c
        ? (c.result && r.checklist
          ? <ChecklistBlock c={c} checklist={r.checklist} promiseState={r.promiseState} conversationType={r.conversationType} onSeek={(t) => seekRef.current?.(t)} />
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
        {c && <span className="ftd-sub">{afterLabel(r.calledAt, c.nextOutboundAt)}</span>}
        {r.messengerSignal === true && <Chip tone="warn">сам запропонував месенджер</Chip>}
        {r.messengerPromises > 0 && <Chip tone="muted">обіцянок у месенджер: {r.messengerPromises} — не перевірити</Chip>}
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
      {c?.mono && <p className="ftd-sub" style={{ margin: 0 }}>{mixed
        ? "Запис моно: голоси не розділені — доріжок і перемотки по фразах немає."
        : "Запис моно: голоси розділено за звучанням — підпис «Менеджер / Клієнт» може помилятись."}</p>}
      {listen && turns && turns.length > 0 && <h4>Текст розмови · {turns.length} реплік <span className="ftd-sub">· клік по репліці перемотує запис</span></h4>}
    </>
  );

  return (
    <div className="ftd-pane-in">
      <div className="ftd-pane-head">
        <div style={{ minWidth: 0 }}>
          <h3>{r.managerName ?? "Менеджер невідомий"}</h3>
          <div className="ftd-sub">{r.teamName ?? "Поза командами"}</div>
        </div>
        <div className="ftd-sub" style={{ textAlign: "right" }}>
          {fmtFull(r.calledAt)} · {r.direction === "in" ? "вхідний" : "вихідний"} · {mmss(r.billsec)}
          {/* Поки картка вантажиться, номер угоди вже стоїть текстом: інакше посилання, зʼявившись, переносило рядок і зсувало все нижче. */}
          {c ? c.dealUrls.map((u) => <span key={u.kommoId}> · <a href={u.url} target="_blank" rel="noreferrer">угода {u.kommoId} ↗</a></span>)
            : r.kommoIds.map((id) => <span key={id}> · угода {id} ↗</span>)}
        </div>
      </div>

      <h4>Про що розмова</h4>
      {/* Повний опис, без обрізки: саме заради цього рядка зроблено панель. */}
      {r.summary
        ? <p className="ftd-pane-text">{r.summary}</p>
        : <p className="ftd-pane-text ftd-sub">{r.state === "done" ? "AI не склав опису цієї розмови." : `Опису ще немає: ${STATE_UI[r.state].label.toLowerCase()}.`}</p>}

      {/* 🎧 Плеєр: місце під нього тримаємо від першого кадру, щоб чек-лист не стрибав, коли картка довантажиться. */}
      {listen && c
        ? <CallConversation load={() => fetchAiCallRecording(c.row.uniqueid)} turns={turns} managerChannel={c.managerChannel} quoted={quoted} seekRef={seekRef}
            mixed={mixed} durationSec={c.durationSec} preload={false} active={active} playerClass="ftd-pane-player" between={mid} />
        : <>
            <div className="ftd-pane-player is-wait ftd-sub" aria-busy={!c && !err}>{c ? "Запису цієї розмови вам не видно." : err ? "Запис не завантажився." : "Запис: завантажую…"}</div>
            {mid}
          </>}
      {c && <>
        <h4>Розбір AI</h4>
        <QuoteSeek.Provider value={listen && turns && !mixed ? seekQuote : null}>
          <Analysis c={c} />
        </QuoteSeek.Provider>
        <h4>Тип розмови, коментарі, угода</h4>
        <TypeBlock c={c} onChanged={changed} />
        <NotesBlock c={c} onSaved={changed} />
        <CloseDealBlock c={c} onDone={changed} />
      </>}
    </div>
  );
}
