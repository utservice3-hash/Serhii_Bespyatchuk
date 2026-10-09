import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../../../components/Dialogs";
import { useToast } from "../../../components/Toasts";
import { fetchCarrierAudio, fetchCarrierCallCard, fetchCarrierDeal, postCarrierDecision, revertCarrierClose,
  type CarrierCallCardResp, type CarrierDealT, type CarrierOtherTypeT } from "../../../api";
import { mmss } from "../aiCallsView";
import { InfoHint } from "../widgets";
import { CATEGORY_UI, DECISION_UI, OTHER_TYPE_UI, OTHER_TYPES_HINT, ROLE_UI, TONE, closeLabel, deciderLabel, pctLabel, speakerShort,
  type HumanDecisionT } from "../carrierCallsView";

/**
 * 🎧 КАРТКА УГОДИ «Перевізників за розмовою» (ТЗ Романа 30.09.2026): запис, розшифровка, вердикт AI з впевненістю й
 * причиною, кнопки «Клієнт / Перевізник / Інше» (+ підтип), журнал рішень. Що дозволено — вирішує сервер: менеджер
 * бачить і вирішує свої угоди, тімлід — команди, керівництво — усі; чуже сервер віддає як «не знайдено».
 */

const fmtTime = (iso: string) => new Date(iso).toLocaleString("uk-UA", {
  timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
export const pill = (bg: string, fg: string): React.CSSProperties => ({ background: bg, color: fg, borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" });
const muted: React.CSSProperties = { color: "var(--text-muted)" };
export const errText = (e: unknown) => (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e instanceof Error ? e.message : "не вдалося");
const label: React.CSSProperties = { fontSize: 11.5, ...muted, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", marginBottom: 4 };

/** Підпис блоку картки з поясненням під ⓘ. */
function LabelHint({ t, h }: { t: string; h: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{t}<InfoHint text={h} /></span>;
}

function Player({ uniqueid, quoteAt, onTime, seekRef }: { uniqueid: string; quoteAt: number | null; onTime: (t: number) => void;
  seekRef: React.MutableRefObject<((t: number) => void) | null> }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState(0); const [dur, setDur] = useState(0); const [play, setPlay] = useState(false); const [speed, setSpeed] = useState(1);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  const toggle = async () => {
    if (state === "idle" || state === "error") {
      setState("loading"); setErr(null);
      try { const b = await fetchCarrierAudio(uniqueid); setSrc(URL.createObjectURL(b)); setState("ready"); }
      catch (e) { setErr(errText(e)); setState("error"); }
      return;
    }
    const a = audio.current; if (!a) return;
    if (a.paused) void a.play(); else a.pause();
  };
  useEffect(() => { if (state === "ready" && audio.current) void audio.current.play(); }, [state]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);
  const seek = (t: number) => { const a = audio.current; if (a && Number.isFinite(t)) { a.currentTime = t; setPos(t); } };
  // Перемотка з розшифровки: батько кличе через посилання (клік по репліці).
  useEffect(() => { seekRef.current = seek; return () => { seekRef.current = null; }; });
  return (
    <div>
      {src && <audio ref={audio} src={src} preload="auto" onPlay={() => setPlay(true)} onPause={() => setPlay(false)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} onTimeUpdate={(e) => { setPos(e.currentTarget.currentTime); onTime(e.currentTarget.currentTime); }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" className="cq-play" onClick={() => { void toggle(); }} aria-label={play ? "Пауза" : "Слухати"} disabled={state === "loading"}
          style={{ width: 34, height: 34, borderRadius: "50%", border: 0, background: "var(--brand)", color: "#fff", cursor: "pointer", flex: "none" }}>
          {state === "loading" ? "…" : play ? "❚❚" : "▶"}</button>
        <div onClick={(e) => { if (!dur) return; const b = e.currentTarget.getBoundingClientRect(); seek((e.clientX - b.left) / b.width * dur); }}
          style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--border)", position: "relative", cursor: dur ? "pointer" : "default" }}>
          <i className="cq-bar" style={{ position: "absolute", inset: "0 auto 0 0", width: `${String(dur ? pos / dur * 100 : 0)}%`, background: "var(--brand)", borderRadius: 3 }} />
          {quoteAt != null && dur > 0 && <span title="Тут цитата" style={{ position: "absolute", top: -4, left: `${String(Math.min(100, quoteAt / dur * 100))}%`, width: 3, height: 14, background: "var(--warn)", borderRadius: 2 }} />}
        </div>
        <span style={{ fontSize: 12, ...muted, fontVariantNumeric: "tabular-nums" }}>{mmss(pos)} / {dur ? mmss(dur) : "—"}</span>
        <button type="button" onClick={() => setSpeed(speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1)}
          style={{ fontSize: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", borderRadius: 6, padding: "2px 6px", cursor: "pointer" }}>{speed}×</button>
      </div>
      {err && <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--danger)" }}>Запис недоступний: {err}</p>}
    </div>
  );
}

/**
 * 🎧 Запис розмови з розшифровкою (картка угоди й «AI проти людини» — один компонент): ▶ слухати, клік по репліці —
 * перемотка, жовтим — фраза, з якої AI зробив висновок. Права сервер перевіряє сам (скоуп ролі).
 */
export function CallRecording({ uniqueid, card, quote }: { uniqueid: string; card: CarrierCallCardResp; quote: string }) {
  const [now, setNow] = useState(0);
  const seekRef = useRef<((t: number) => void) | null>(null);
  const turns = card.turns ?? [];
  const mc = card.managerChannel;
  const quoteTurn = turns.find((t) => quote && t.channel !== mc && t.text.includes(quote));
  return (
    <>
      <Player uniqueid={uniqueid} quoteAt={quoteTurn?.start ?? null} onTime={setNow} seekRef={seekRef} />
      <div style={{ marginTop: 10, maxHeight: 220, overflowY: "auto" }}>
        {turns.map((t, i) => {
          const next = turns[i + 1]; const cur = t.start != null && now >= t.start && (!next || next.start == null || now < next.start);
          const them = mc != null && t.channel !== mc;
          return <p key={i} className="cq-line" title="Перемотати сюди"
            onClick={() => { if (t.start != null) seekRef.current?.(t.start); }}
            style={{ margin: "1px 0", fontSize: 13, padding: "3px 6px", borderRadius: 6, cursor: "pointer", background: cur ? "var(--info-bg)" : undefined }}>
            <span style={{ fontWeight: 600, marginRight: 6, color: them ? "var(--warn)" : "var(--text-muted)" }}>{speakerShort(t.channel, mc)}</span>
            {t === quoteTurn ? <mark style={{ background: "var(--warn-bg)", color: "inherit", borderRadius: 3 }}>{t.text}</mark> : t.text}</p>;
        })}
        {!turns.length && <p style={{ margin: 0, fontSize: 13, ...muted }}>{card.textPurged ? "Текст видалено за строком зберігання (12 місяців). Вердикт лишився." : "Розшифровки немає."}</p>}
      </div>
    </>
  );
}

/** Картка угоди за номером — сама вантажить угоду (рядки «AI проти людини», де повної угоди ще немає). */
export function CarrierDealById({ kommoId, onChanged }: { kommoId: number; onChanged: () => void }) {
  const [deal, setDeal] = useState<CarrierDealT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchCarrierDeal(kommoId).then((d) => { if (alive) setDeal(d); }).catch((e) => { if (alive) setErr(errText(e)); });
    return () => { alive = false; };
  }, [kommoId, reload]);
  if (err) return <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>{err}</p>;
  if (!deal) return <p className="loading-text" style={{ margin: 0 }}>Завантаження угоди…</p>;
  const changed = () => { setReload((n) => n + 1); onChanged(); };
  return <CarrierDealPanel deal={deal} onDecided={changed} onChanged={changed} />;
}

/** Панель однієї угоди: ліворуч — розмова, праворуч — вердикт, рішення, журнал. `onDecided` — після запису рішення. */
export function CarrierDealPanel({ deal, onDecided, onChanged }: { deal: CarrierDealT; onDecided: () => void; onChanged: () => void }) {
  const dlg = useDialogs();
  const toast = useToast();
  const [card, setCard] = useState<CarrierCallCardResp | null>(null);
  const [cardErr, setCardErr] = useState<string | null>(null);
  const [note, setNote] = useState(""); const [noteOpen, setNoteOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [pickOther, setPickOther] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!deal.uniqueid) return;
    let alive = true;
    fetchCarrierCallCard(deal.uniqueid).then((c) => { if (alive) setCard(c); }).catch((e) => { if (alive) setCardErr(errText(e)); });
    return () => { alive = false; };
  }, [deal.uniqueid, reload]);

  const quote = deal.ai.quote?.trim() ?? "";
  const canListen = deal.uniqueid != null && card != null && !card.transcriptHidden;
  const journal = deal.journal;
  const closed = deal.close?.state === "closed";
  const current = deal.human?.decision ?? null;

  const decide = async (d: HumanDecisionT, other: CarrierOtherTypeT | null = null) => {
    setBusy(true);
    try { await postCarrierDecision(deal.kommoId, d, note, other); setNote(""); setNoteOpen(false); setPickOther(false); setReload((n) => n + 1); onDecided(); }
    catch (e) { toast(`Рішення не записано: ${errText(e)}`, { error: true }); }
    finally { setBusy(false); }
  };
  const revert = async () => {
    if (!(await dlg.confirm(`Повернути угоду № ${String(deal.kommoId)} на етап «Дзвінки на мобільні» і зняти причину? Автоматика її більше не закриватиме.`))) return;
    setBusy(true);
    try { await revertCarrierClose(deal.kommoId); onChanged(); }
    catch (e) { toast(`Не повернуто: ${errText(e)}`, { error: true }); }
    finally { setBusy(false); }
  };

  const verdictUi = deal.ai.verdict ? ROLE_UI[deal.ai.verdict] : null;
  const cat = CATEGORY_UI[deal.category];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, background: "var(--card-bg)",
      border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={label}><LabelHint t="Розмова" h="Запис дзвінка і його текст. ▶ — слухати; клік по репліці — перемотати туди. «Він» — той, хто дзвонив; жовтим — фраза, з якої AI зробив висновок." /></div>
        {!deal.uniqueid
          ? <p style={{ margin: 0, fontSize: 13, ...muted }}>{deal.dealState === "no_talk"
              ? "Розмови від 10 с з цим номером не було: пропущений або короткий дзвінок. Вирішіть за номером або передзвоніть."
              : "Розмови ще немає — чекаємо дзвінок до доби після створення угоди."}</p>
          : cardErr ? <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>{cardErr}</p>
          : !card ? <p className="loading-text" style={{ margin: 0 }}>Завантаження розмови…</p>
          : card.transcriptHidden ? <p style={{ margin: 0, fontSize: 13, ...muted }}>Запис і текст цій ролі недоступні.</p>
          : <CallRecording uniqueid={deal.uniqueid} card={card} quote={quote} />}
        {canListen && card?.firstTry && (
          <p style={{ margin: "6px 0 0", fontSize: 12.5, ...muted }}>Це друга розмова номера: першу не вдалось розібрати.</p>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div>
          <div style={label}><LabelHint t="Що почув AI" h="Хто, на думку AI, дзвонив, наскільки він певен (від 85% — вирішує сам, нижче — рішення за вами) і чому він так вирішив." /></div>
          {verdictUi
            ? <div style={{ fontSize: 13 }}>
                <span style={pill(verdictUi.bg, verdictUi.fg)}>{verdictUi.label}{deal.ai.otherType ? ` · ${OTHER_TYPE_UI[deal.ai.otherType]}` : ""}</span>
                <span style={{ ...muted, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>впевненість {pctLabel(deal.ai.confidence)}</span>
                {deal.ai.reason && <div style={{ marginTop: 4 }}>{deal.ai.reason}</div>}
                {quote && <div style={{ fontStyle: "italic", marginTop: 4 }}>«{quote}»</div>}
                {!deal.ai.reason && deal.ai.summary && <div style={{ marginTop: 4, ...muted }}>{deal.ai.summary}</div>}
              </div>
            : <div style={{ fontSize: 13, ...muted }}>{deal.why ?? "вердикту немає"}</div>}
        </div>

        <div style={{ fontSize: 13 }}>
          <span style={{ ...muted, marginRight: 6, display: "inline-flex", alignItems: "center", gap: 4 }}>Рішення зараз<InfoHint text="Чинне рішення по угоді: AI (якщо він певен від 85%) або людини — рішення людини завжди сильніше. Нижче — що з угодою в CRM." />:</span>
          <span style={pill(TONE[cat.tone].bg, TONE[cat.tone].fg)}>{cat.label}{deal.otherType ? ` · ${OTHER_TYPE_UI[deal.otherType]}` : ""}</span>
          <span style={{ ...muted, marginLeft: 6 }}>
            {deal.source === "human" && deal.human ? `вирішив ${deviceName(deal.human.by)} (${deciderLabel(deal.human.role)})` : deal.source === "ai" ? "вирішив AI" : deal.source === "crm" ? `історія CRM${deal.historyFrom ? ` (угода №${String(deal.historyFrom)})` : ""}` : verdictUi ? deal.why ?? "" : ""}
          </span>
          {deal.close && <div style={{ ...muted, fontSize: 12.5, marginTop: 4 }}>{closeLabel(deal.close, fmtTime)}</div>}
          {deal.reviewDeadline && !deal.human && (
            <div style={{ fontSize: 12.5, marginTop: 4, color: deal.overdue ? "var(--danger)" : "var(--text-muted)" }}>
              {deal.overdue ? "Прострочено: треба було розібрати до " : "Розібрати до "}{fmtTime(deal.reviewDeadline)} (кінець робочого дня)
            </div>
          )}
        </div>

        {closed
          ? <div>
              <button type="button" disabled={busy} onClick={() => { void revert(); }}
                style={{ border: "1px solid var(--border-strong, #d1d5db)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 10px", fontSize: 13, cursor: "pointer" }}>
                {busy ? "Повертаю…" : "Повернути на етап"}</button>
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Угоду закрито в CRM — щоб змінити рішення, спершу поверніть її.</div>
            </div>
          : <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(Object.keys(DECISION_UI) as HumanDecisionT[]).map((v) => {
                  const on = current === v;
                  return (
                    <button key={v} type="button" className="cq-btn" title={DECISION_UI[v].hint} disabled={busy} aria-pressed={on}
                      onClick={() => { if (v === "other") setPickOther(!pickOther); else void decide(v); }}
                      style={{ flex: "1 1 0", minWidth: 96, border: `1px solid ${DECISION_UI[v].fg}`, background: on ? DECISION_UI[v].bg : "transparent", color: "var(--text)",
                        borderRadius: 8, padding: "8px 6px", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
                      {on ? "✓ " : ""}{DECISION_UI[v].icon} {DECISION_UI[v].label}</button>
                  );
                })}
              </div>
              {pickOther && (
                <div className="cq-fade" role="group" aria-label="Підтип «Інше»" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ alignSelf: "center" }}><InfoHint text={OTHER_TYPES_HINT} /></span>
                  {(Object.keys(OTHER_TYPE_UI) as CarrierOtherTypeT[]).map((t) => (
                    <button key={t} type="button" disabled={busy} onClick={() => { void decide("other", t); }}
                      style={{ border: "1px solid var(--border)", background: t === deal.otherType ? "var(--info-bg)" : "transparent", color: "var(--text)",
                        borderRadius: 999, padding: "3px 10px", fontSize: 12.5, cursor: "pointer" }}>{OTHER_TYPE_UI[t]}</button>
                  ))}
                </div>
              )}
              <div style={{ ...muted, fontSize: 12 }}>«Перевізник» і «Інше» закриємо в CRM, «Клієнт» лишиться на етапі. Тімлід і керівник можуть змінити ваше рішення.</div>
              {noteOpen
                ? <textarea id={`carrier-note-${String(deal.kommoId)}`} autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Коментар"
                    style={{ fontSize: 13, minHeight: 44, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", background: "var(--card-bg)", color: "var(--text)", resize: "vertical" }} />
                : <button type="button" onClick={() => setNoteOpen(true)} style={{ alignSelf: "flex-start", border: 0, background: "none", color: "var(--info)", cursor: "pointer", fontSize: 12.5, padding: 0 }}>+ коментар</button>}
            </>}

        {journal.length > 0 && (
          <div>
            <div style={label}><LabelHint t="Журнал рішень" h="Усі рішення людей по цій угоді, старі теж: хто, коли, що вирішив і що в цей момент казав AI. Діє останнє." /></div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 2 }}>
              {journal.map((j, i) => (
                <li key={i} style={i < journal.length - 1 ? muted : undefined}>
                  {fmtTime(j.at)} · {j.by} ({deciderLabel(j.role)}): <b>{DECISION_UI[j.decision].label}</b>{j.otherType ? ` · ${OTHER_TYPE_UI[j.otherType]}` : ""}
                  {j.aiRole && <span style={muted}> · AI казав «{ROLE_UI[j.aiRole]?.label ?? j.aiRole}», {pctLabel(j.aiConfidence)}</span>}
                  {j.note && <span> · «{j.note}»</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ім'я без пошти: `ivan@uts.ua` → `ivan` (у журналі пошта — лише якщо користувач не привʼязаний до менеджера). */
function deviceName(by: string): string {
  return by.includes("@") ? by.split("@")[0] : by;
}
