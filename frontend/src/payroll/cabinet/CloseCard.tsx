/**
 * Закриття минулого місяця в кабінеті (макет `c02-home.js`, `closeCard`): кроки «закрито → перевірка → згода →
 * (обхідний) → форма → виплата», розрахунковий лист, згода / незгода з текстом, форма на виплату (готівка + карти),
 * утримання за ТТН. Працівник бачить лише підсумкові суми — без внутрішніх коментарів фінансиста (так віддає сервер).
 */
import { useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Pill, StatusPill, money, monthTitle, nextMonth } from "../ui";
import { useToast } from "../../components/Toasts";
import { Block } from "./Block";
import { ceilE, dd, dt, lastDay, monthGen, monthLow, pc, payHow } from "./format";
import { ClearanceList } from "./ClearanceMine";
import { PayLines } from "./PayLines";
import { draftBody, initDraft, type PayDraft } from "./payDraft";

function Slip({ f, kind, lines = [] }: { f: Obj; kind: string; lines?: Obj[] }) {
  const v = f.values as Obj, a = f.auto as Obj;
  const was = (k: string) => (a[k] !== undefined && v[k] !== undefined && Math.abs(Number(v[k]) - Number(a[k])) > 0.001 ? a[k] : null);
  const of = kind === "lead" ? "маржі команди" : kind === "staff" ? "маржі компанії" : "маржі";
  const c = f.calc as Obj;
  const bl = (c.birthdays ?? []) as Obj[];
  const gift = bl.find((b) => b.kind === "gift"), gives = bl.filter((b) => b.kind === "give");
  const rows: Array<{ k: string; v: string; cls?: string; was?: string }> = [];
  if (kind !== "staff" || c.pctRule) {
    const wm = was("margin"), wp = was("pct");
    rows.push({ k: `Відсоток · ${pc(v.pct)} від ${of} ${money(v.margin)}`, v: money(f.pctAmount),
      was: wm !== null || wp !== null ? `у кабінеті було: ${[wm !== null ? `маржа ${money(wm)}` : "", wp !== null ? pc(wp) : ""].filter(Boolean).join(", ")} — пояснення у фінансиста` : undefined });
  }
  if (v.rate || a.rate) { const w = was("rate"); rows.push({ k: "Ставка", v: money(v.rate), was: w !== null ? `у кабінеті було ${money(w)}` : undefined }); }
  if (kind === "manager" && c.kpi) { const w = was("bonus"); rows.push({ k: "Бонус за КПІ", v: money(v.bonus), was: w !== null ? `у кабінеті було ${money(w)}` : undefined }); }
  if (gift) rows.push({ k: `Ваш день народження · ${dd(gift.date)}`, v: money(gift.amount, { sign: true }), cls: "zp-tone--ok" });
  if (gives.length) rows.push({ k: gives.length > 1 ? `Збір на ДН колег · ${gives.map((b) => String(b.who?.name ?? "").split(" ")[0]).join(", ")}` : `Збір на ДН колеги · ${gives[0].who?.name ?? ""}`, v: money(gives.reduce((s, b) => s + Number(b.amount), 0)), cls: "zp-tone--muted" });
  // премії / утримання — рядками з сервера (вид і сума; коментар фінансиста внутрішній); старий сервер — однією сумою
  if (lines.length) for (const x of lines) rows.push({ k: String(x.label), v: money(x.amount, { sign: true }), cls: Number(x.amount) > 0 ? "zp-tone--ok" : "zp-tone--danger" });
  else if (Number(f.extras)) rows.push({ k: "Премії, утримання й корекції", v: money(f.extras, { sign: true }), cls: Number(f.extras) > 0 ? "zp-tone--ok" : "zp-tone--danger" });
  return (
    <ul className="zc-slip">
      {rows.map((r, i) => <li key={i}><span>{r.k}{r.was && <small className="zc-was">{r.was}</small>}</span><b className={`zp-num ${r.cls ?? ""}`}>{r.v}</b></li>)}
      <li className="zc-slip__tt"><span>Нараховано</span><b className="zp-num">{money(f.total)}</b></li>
    </ul>
  );
}

function SlipPay({ f, hold, adv }: { f: Obj; hold: number; adv: Obj | null }) {
  const rows: Array<{ k: string; v: string; cls?: string }> = [];
  if (Number(f.advance)) rows.push({ k: `Аванс${adv?.paidAt ? `, виплачено ${dd(adv.paidAt)}` : ""}`, v: money(-f.advance), cls: "zp-tone--danger" });
  const o = f.official as Obj | null;
  if (o) rows.push(o.deduct ? { k: "Офіційна ЗП — отримуєте окремо, тут вираховуємо", v: money(-o.amount), cls: "zp-tone--danger" } : { k: "Офіційна ЗП — окремо, понад цю суму", v: money(o.amount), cls: "zp-tone--muted" });
  for (const x of (f.ttnLines ?? []) as Obj[]) {
    if (x.kind === "hold") rows.push({ k: `Утримано до закриття ТТН · ${x.ttn?.done} з ${x.ttn?.total}`, v: money(x.amount), cls: "zp-tone--danger" });
    else if (x.kind === "release") rows.push({ k: `Повернення утримання за ТТН ${monthGen(x.month)}`, v: money(x.amount, { sign: true }), cls: "zp-tone--ok" });
    else rows.push({ k: `ТТН ${monthGen(x.month)} ще не закрито — утримання переходить далі`, v: money(hold), cls: "zp-tone--muted" });
  }
  return (
    <>
      {rows.length > 0 && <ul className="zc-slip zc-slip--pay">{rows.map((r, i) => <li key={i}><span>{r.k}</span><b className={`zp-num ${r.cls ?? ""}`}>{r.v}</b></li>)}</ul>}
      <div className="zc-topay">
        <span>До виплати<small>готівкою або на карти — як вкажете у формі</small></span>
        <b className={`zp-num ${f.pay < 0 ? "zp-tone--danger" : ""}`}>{money(f.pay)}</b>
      </div>
    </>
  );
}

export function CloseCard({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const r = me.closed as Obj;
  const mk = r.month as string;
  const S = me.settings as Obj;
  const nm = monthGen(nextMonth(mk));
  const [disp, setDisp] = useState<string | null>(null);
  const [form, setForm] = useState<PayDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const st = r.status as string;
  const f = r.settlement as Obj | null;
  const kind = (f?.calc as Obj | undefined)?.kind ?? (me.employee?.role === "lead" ? "lead" : me.employee?.role === "staff" ? "staff" : "manager");
  const fin = !!r.isFinal;
  const cs = fin ? (me.clearance as Obj | null) : null;
  const blocked = !!r.payBlocked;
  const advReq = ((me.advances ?? []) as Obj[]).find((a) => a.month === mk && a.status === "paid") ?? null;

  let idx = ({ review: 1, verified: 2, disputed: 2, agreed: 3, submitted: 4, paid: 5 } as Record<string, number>)[st] ?? 1;
  if (fin) { if (st === "agreed") idx = blocked ? 3 : 4; else if (idx >= 4) idx += 1; }
  const steps: Array<[string, string]> = [["Місяць закрито", `${lastDay(mk)}.${mk.slice(5)}`], ["Перевірка фінансиста", `до ${S.verifyByDay} ${nm}`], ["Ваша згода", ""],
    ...(fin ? [["Обхідний лист", cs ? `${cs.done} з ${cs.total}` : ""] as [string, string]] : []), ["Форма на виплату", ""], ["Виплата", `до ${S.payByDay} ${nm}`]];
  const cur = st === "paid" ? steps.length - 1 : Math.min(idx, steps.length - 1);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok); await onChanged(); return true; }
    catch (e) { toast(errText(e), { error: true }); return false; }
    finally { setBusy(false); }
  }

  let body;
  if (st === "review" || !f) {
    body = (
      <>
        <div className="zp-note zp-note--warn"><b>Фінансист перевіряє {monthLow(mk)} — до {S.verifyByDay} {nm}.</b> Щойно перевірить, тут зʼявиться розрахунковий лист: погодите його або напишете, з чим не згодні.</div>
        {fin && cs && <ClearanceList c={cs} onSent={onChanged} />}
      </>
    );
  } else {
    body = (
      <>
        <div className="zc-sliph"><span>Розрахунковий лист · {monthTitle(mk)}</span>{r.verifiedAt && <small>Перевірено {dt(r.verifiedAt)}</small>}</div>
        <Slip f={f} kind={kind} lines={(r.extraLines ?? []) as Obj[]} />
        <SlipPay f={f} hold={S.ttn?.hold ?? 0} adv={advReq} />
        {r.reply && <div className="zp-note"><b>Відповідь фінансиста:</b> {r.reply}</div>}
        {st === "verified" && (disp !== null ? (
          <div className="zc-form">
            <label className="zp-field"><span>З чим не погоджуєтесь?</span>
              <textarea className="zp-textarea" rows={3} value={disp} placeholder="напр. не врахована угода 62793564 від 27.11" onChange={(e) => setDisp(e.target.value)} />
            </label>
            <div className="zp-row">
              <button type="button" className="zp-btn zp-btn--dark" disabled={busy || disp.trim().length < 3}
                onClick={() => void run(() => payrollApi.dispute(mk, disp.trim()), "Надіслано фінансисту — відповідь зʼявиться тут.").then((ok) => ok && setDisp(null))}>Надіслати фінансисту</button>
              <button type="button" className="zp-btn" onClick={() => setDisp(null)}>Скасувати</button>
            </div>
          </div>
        ) : (
          <>
            <div className="zp-row">
              <button type="button" className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void run(() => payrollApi.agree(mk), "Погоджено. Далі — форма на виплату.")}>Погоджуюсь</button>
              <button type="button" className="zp-btn" disabled={busy} onClick={() => setDisp("")}>Не погоджуюсь</button>
            </div>
            <p className="zp-hint">Є питання до суми — «Не погоджуюсь» і напишіть чому. Після згоди — форма на виплату.</p>
          </>
        ))}
        {st === "disputed" && <div className="zp-note zp-note--danger"><b>Ви не погодились {dt(r.dispute?.at)}:</b> «{r.dispute?.text}». Фінансист відповість тут; якщо не домовитесь — вирішить ОД.</div>}
        {st === "agreed" && (blocked ? (
          <>
            <div className="zp-note zp-note--warn"><b>Погоджено {dt(r.agreedAt)}.</b> Форму на виплату можна подати після обхідного листа.</div>
            {cs && <ClearanceList c={cs} onSent={onChanged} />}
          </>
        ) : form ? (
          <div className="zc-form" id="payform">
            <div className="zp-k">Форма на виплату · {money(f.pay)}</div>
            <PayLines cards={(me.cards ?? []) as Obj[]} draft={form} onChange={setForm} due={Math.round(f.pay)} dueLabel="exact" defaultHolder={me.employee?.name ?? ""} />
            <div className="zp-row">
              <button type="button" className="zp-btn zp-btn--primary" disabled={busy}
                onClick={() => void run(() => payrollApi.submitForm(mk, draftBody(form)), `Форму подано. Виплата до ${S.payByDay} ${nm}.`).then((ok) => ok && setForm(null))}>Подати форму</button>
              <button type="button" className="zp-btn" disabled={busy} onClick={() => setForm(null)}>Скасувати</button>
            </div>
            <p className="zp-hint">Карта може бути будь-яка і на будь-кого — вкажіть отримувача, як у банку. На екрані — лише останні 4 цифри.</p>
          </div>
        ) : (
          <>
            <div className="zp-note zp-note--ok"><b>Погоджено {dt(r.agreedAt)}.</b>{fin && cs ? " Обхідний лист підписано всіма." : ""} Залишилось вказати, куди виплатити {money(f.pay)}: готівкою, на одну чи кілька карт. Виплата до {S.payByDay} {nm}.</div>
            <div className="zp-row"><button type="button" className="zp-btn zp-btn--dark" onClick={() => setForm(initDraft((me.cards ?? []) as Obj[], f.pay, me.employee?.name ?? ""))}>Заповнити форму на виплату</button></div>
          </>
        ))}
        {(st === "submitted" || st === "paid") && (() => {
          const pl = r.payout as Obj | null, useDiff = pl && pl.diff && st !== "paid";
          return (
            <div className="zp-note zp-note--ok">
              <b>{st === "paid" ? `Виплачено ${dt(r.paidAt)}` : `Форму подано ${dt(r.form?.at)}`}:</b> {payHow(useDiff ? pl : r.form)}.
              {st === "submitted" && (fin && r.payNeedsOd ? " Виплата — після погодження розрахунку ОД (п. 9 обхідного листа)." : ` Виплата до ${S.payByDay} ${nm}.`)}
              {useDiff ? ` ТТН закрито після подання форми — ${money(pl!.diff, { sign: true })} додано до виплати.` : ""}
            </div>
          );
        })()}
      </>
    );
  }

  // утримання за ТТН цього місяця
  const hold = ((f?.ttnLines ?? []) as Obj[]).find((x) => x.kind === "hold");
  let ttnNote = null;
  if (hold && me.employee?.role === "manager") {
    const t = hold.ttn as Obj, min = S.ttn?.minPct ?? 70;
    const need = Math.max(1, ceilE(min * t.total / 100) - t.done);
    ttnNote = (
      <div className="zp-note zp-note--warn" id="ttnclose">
        <b>{money(S.ttn?.hold)} утримано до закриття ТТН.</b> ТТН є в {t.done} з {t.total} угод ({pc(t.pct)}), потрібно від {min} % — ще {need}.
        {" "}Додасте ТТН до виплати (до {S.payByDay} {nm}) — сума піде в цю виплату; пізніше — у виплату за {monthLow(nextMonth(mk))}.
      </div>
    );
  }
  return (
    <Block id="close" title={`${monthTitle(mk)} — закриття${fin ? " й фінальний розрахунок" : ""}`} aside={st === "review" ? <Pill tone="warn">перевіряє фінансист</Pill> : <StatusPill status={st} />}>
      <ol className="zc-stepper" style={{ ["--n" as string]: steps.length }}>
        {steps.map((s, i) => <li key={i} className={i < idx || st === "paid" ? "is-done" : i === idx ? "is-now" : ""}><b>{s[0]}</b>{s[1] && <span>{s[1]}</span>}</li>)}
      </ol>
      <div className="zc-stepcap">{st === "paid" ? "Усі кроки пройдено" : `Крок ${cur + 1} з ${steps.length}`} — <b>{steps[cur][0]}</b></div>
      {body}
      {ttnNote}
    </Block>
  );
}
