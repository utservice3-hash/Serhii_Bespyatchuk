/**
 * Аванс поточного місяця (макет `c02-home.js`, `advBlock`): ліміт на сьогодні, заявка на одну чи кілька карт + готівка,
 * скасування поданої. Ліміт і вікно (з `fromDay`-го) рахує рушій на сервері; понад ліміт сервер відмовить текстом.
 */
import { useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Pill, money } from "../ui";
import { useToast } from "../../components/Toasts";
import { Block } from "./Block";
import { ADV_STATUS, ADVANCE_BLOCK_ID, dt, monthGen, monthLow, payHow, limitRule } from "./format";
import { PayLines } from "./PayLines";
import { useAdvanceRemind } from "./remind";
import { draftBody, draftTotal, initDraft, type PayDraft } from "./payDraft";
import { monthTitle } from "../ui";

export function AdvanceBlock({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const lv = me.live as Obj | null;
  const [draft, setDraft] = useState<PayDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const rm = useAdvanceRemind(me, onChanged);
  if (!lv) return null;
  const mk = lv.month as string;
  const A = lv.advance as Obj, L = A.limit as Obj | null, req = A.request as Obj | null;
  const st = req?.status as string | undefined;
  const cards = (me.cards ?? []) as Obj[];

  async function submit() {
    if (!draft) return;
    if (draftTotal(draft) <= 0) { toast("Вкажіть суму авансу.", { error: true }); return; }
    setBusy(true);
    try { await payrollApi.requestAdvance(draftBody(draft)); toast("Заявку на аванс подано — фінансист розгляне й позначить «Схвалено»."); setDraft(null); await onChanged(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try { await payrollApi.cancelAdvance(Number(req!.id)); toast("Заявку скасовано."); setAskCancel(false); await onChanged(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }

  let body;
  if (!req || st === "rejected") {
    body = (
      <>
        {st === "rejected" && <div className="zp-note zp-note--danger"><b>Заявку на {money(req!.amount)} відхилено {dt(req!.rejectedAt)}.</b> {req!.reason ?? ""}</div>}
        {draft ? (
          <div className="zc-form">
            <PayLines cards={cards} draft={draft} onChange={setDraft} due={L?.amount ?? 0} dueLabel="max" defaultHolder={me.employee?.name ?? ""} />
            <div className="zp-row">
              <button type="button" className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void submit()}>{busy ? "Подаємо…" : "Подати заявку"}</button>
              <button type="button" className="zp-btn" disabled={busy} onClick={() => setDraft(null)}>Скасувати</button>
            </div>
          </div>
        ) : (
          <div className="zc-avans-row">
            <div>
              <div className="zp-k">Можна взяти до</div>
              <div className="zc-mid zp-num">{money(L?.amount ?? 0)}</div>
              <div className="zp-hint">{limitRule(L)}{L?.capped ? ` · обмежено нарахованим ${money(L.cap)}` : ""}</div>
            </div>
            {A.open
              ? <button type="button" className="zp-btn zp-btn--dark" disabled={!(L?.amount > 0)} onClick={() => setDraft(initDraft(cards, L?.amount ?? 0, me.employee?.name ?? ""))}>Подати заявку на аванс</button>
              : (
                <span className="zp-row">
                  <span className="zp-hint">заявки — з {A.fromDay} {monthGen(mk)}</span>
                  <button type="button" className={`zp-btn zp-btn--sm ${rm.on ? "" : "zp-btn--dark"}`} disabled={rm.busy} onClick={() => void rm.toggle()}>{rm.label}</button>
                </span>
              )}
          </div>
        )}
        {!draft && <p className="zp-hint">На одну чи кілька карт або готівкою. Аванс вирахуємо із ЗП за {monthLow(mk)} при закритті місяця.</p>}
      </>
    );
  } else if (st === "requested") {
    body = (
      <>
        <div className="zp-note zp-note--warn"><b>Заявку подано {dt(req.requestedAt)}: {money(req.amount)}</b> — {payHow(req)}. Фінансист розгляне й позначить «Схвалено».</div>
        <div className="zp-row">
          {askCancel ? (
            <>
              <span>Скасувати заявку на {money(req.amount)}?</span>
              <button type="button" className="zp-btn zp-btn--danger zp-btn--sm" disabled={busy} onClick={() => void cancel()}>Так, скасувати</button>
              <button type="button" className="zp-btn zp-btn--sm" onClick={() => setAskCancel(false)}>Ні</button>
            </>
          ) : <button type="button" className="zp-btn" onClick={() => setAskCancel(true)}>Скасувати заявку</button>}
        </div>
      </>
    );
  } else {
    body = <div className="zp-note zp-note--ok"><b>Аванс {money(req.amount)} схвалено {dt(req.paidAt)}</b> — {payHow(req)}. Гроші надійдуть після переказу, строк залежить від банку. Вирахуємо із ЗП за {monthLow(mk)} при закритті місяця.</div>;
  }
  const chip = st ? <Pill tone={ADV_STATUS[st]?.[1] ?? "muted"}>{ADV_STATUS[st]?.[0] ?? st}</Pill>
    : <Pill tone={A.open ? "info" : "muted"}>{A.open ? "заявки відкрито" : `з ${A.fromDay} ${monthGen(mk)}`}</Pill>;
  const fm = A.fm as Obj | undefined;
  return (
    <>
      <Block id={ADVANCE_BLOCK_ID} title={`Аванс · ${monthTitle(mk)}`} aside={chip}>{body}</Block>
      {fm?.allowed && <FmAdvance me={me} mk={mk} fm={fm} onChanged={onChanged} />}
    </>
  );
}

/**
 * 🆘 «Аванс форс-мажор» (задача 10723, Тетяна 27.11; Роман: «ліміти такі самі, як і звичайного авансу. Тільки Сергій погоджує»).
 * Будь-коли в місяці, кілька разів, з причиною; ліміт спільний зі звичайним авансом. Спершу погоджує ОД, далі виплачує фінансист.
 */
function FmAdvance({ me, mk, fm, onChanged }: { me: Obj; mk: string; fm: Obj; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<PayDraft | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState<number | null>(null);
  const cards = (me.cards ?? []) as Obj[], list = (fm.list ?? []) as Obj[], limit = Number(fm.limit ?? 0);

  async function submit() {
    if (!draft) return;
    if (draftTotal(draft) <= 0) { toast("Вкажіть суму авансу.", { error: true }); return; }
    if (note.trim().length < 3) { toast("Напишіть причину — її побачить ОД.", { error: true }); return; }
    setBusy(true);
    try { await payrollApi.requestFmAdvance({ ...draftBody(draft), note: note.trim() }); toast("Заявку на аванс форс-мажор подано — її погодить ОД."); setDraft(null); setNote(""); await onChanged(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  async function cancel(id: number) {
    setBusy(true);
    try { await payrollApi.cancelAdvance(id); toast("Заявку скасовано."); setAskCancel(null); await onChanged(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  const open = list.filter((a) => a.status === "pending" || a.status === "requested");
  return (
    <Block title="Аванс форс-мажор" aside={open.length ? <Pill tone="warn">{open.length} в роботі</Pill> : undefined}>
      {list.map((a) => (
        <div key={a.id} className={`zp-note ${a.status === "rejected" ? "zp-note--danger" : a.status === "paid" ? "zp-note--ok" : "zp-note--warn"}`}>
          <b>{money(a.amount)} — {ADV_STATUS[a.status]?.[0] ?? a.status}</b> · подано {dt(a.requestedAt)} · {payHow(a)}
          <div className="zp-hint">Причина: {a.note}{a.status === "rejected" && a.reason ? ` · відхилено: ${a.reason}` : ""}</div>
          {(a.status === "pending" || a.status === "requested") && (
            <div className="zp-row">
              {askCancel === a.id ? (
                <>
                  <span>Скасувати заявку на {money(a.amount)}?</span>
                  <button type="button" className="zp-btn zp-btn--danger zp-btn--sm" disabled={busy} onClick={() => void cancel(Number(a.id))}>Так, скасувати</button>
                  <button type="button" className="zp-btn zp-btn--sm" onClick={() => setAskCancel(null)}>Ні</button>
                </>
              ) : <button type="button" className="zp-btn zp-btn--sm" onClick={() => setAskCancel(Number(a.id))}>Скасувати заявку</button>}
            </div>
          )}
        </div>
      ))}
      {draft ? (
        <div className="zc-form">
          <PayLines cards={cards} draft={draft} onChange={setDraft} due={limit} dueLabel="max" defaultHolder={me.employee?.name ?? ""} />
          <label className="zp-k" htmlFor="zc-fm-note">Причина — її побачить ОД</label>
          <textarea id="zc-fm-note" className="zp-textarea" rows={2} value={note} placeholder="напр. лікування, ремонт авто" onChange={(e) => setNote(e.target.value)} />
          <div className="zp-row">
            <button type="button" className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void submit()}>{busy ? "Подаємо…" : "Подати на погодження"}</button>
            <button type="button" className="zp-btn" disabled={busy} onClick={() => { setDraft(null); setNote(""); }}>Скасувати</button>
          </div>
        </div>
      ) : (
        <div className="zc-avans-row">
          <div>
            <div className="zp-k">Можна взяти до</div>
            <div className="zc-mid zp-num">{money(limit)}</div>
            <div className="zp-hint">ліміт спільний зі звичайним авансом</div>
          </div>
          <button type="button" className="zp-btn" disabled={!(limit > 0)} onClick={() => setDraft(initDraft(cards, limit, me.employee?.name ?? ""))}>Аванс форс-мажор</button>
        </div>
      )}
      {!draft && <p className="zp-hint">Коли гроші потрібні терміново — будь-коли в місяці, можна кілька разів. Спершу погоджує ОД, потім фінансист виплачує. Вирахуємо із ЗП за {monthLow(mk)}.</p>}
    </Block>
  );
}
