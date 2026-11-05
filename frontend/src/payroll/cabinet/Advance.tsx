/**
 * Аванс поточного місяця (макет `c02-home.js`, `advBlock`): ліміт на сьогодні, заявка на одну чи кілька карт + готівка,
 * скасування поданої. Ліміт і вікно (з `fromDay`-го) рахує рушій на сервері; понад ліміт сервер відмовить текстом.
 */
import { useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Pill, money } from "../ui";
import { useToast } from "../../components/Toasts";
import { Block } from "./Block";
import { ADV_STATUS, dt, monthGen, monthLow, payHow, limitRule } from "./format";
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
    try { await payrollApi.requestAdvance(draftBody(draft)); toast("Заявку на аванс подано — фінансист виплатить і позначить «Виплачено»."); setDraft(null); await onChanged(); }
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
          <div className="zc-adv">
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
        {!draft && <p className="zp-hint">На одну чи кілька карт, частину можна готівкою. Аванс вирахуємо із ЗП за {monthLow(mk)} при закритті місяця.</p>}
      </>
    );
  } else if (st === "requested") {
    body = (
      <>
        <div className="zp-note zp-note--warn"><b>Заявку подано {dt(req.requestedAt)}: {money(req.amount)}</b> — {payHow(req)}. Фінансист виплатить і позначить «Виплачено».</div>
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
    body = <div className="zp-note zp-note--ok"><b>Аванс {money(req.amount)} виплачено {dt(req.paidAt)}</b> — {payHow(req)}. Вирахуємо із ЗП за {monthLow(mk)} при закритті місяця.</div>;
  }
  const chip = st ? <Pill tone={ADV_STATUS[st]?.[1] ?? "muted"}>{ADV_STATUS[st]?.[0] ?? st}</Pill>
    : <Pill tone={A.open ? "info" : "muted"}>{A.open ? "заявки відкрито" : `з ${A.fromDay} ${monthGen(mk)}`}</Pill>;
  return <Block id="adv" title={`Аванс · ${monthTitle(mk)}`} aside={chip}>{body}</Block>;
}
