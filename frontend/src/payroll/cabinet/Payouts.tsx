/**
 * Вкладка «Виплати» (макет `c04-pay.js`): найближчі дати, аванс, мої виплати по місяцях, мої карти (додати / прибрати).
 * Карти шифрує сервер; без ключа шифрування (`PAYROLL_CARD_KEY`) він відповідає 503 з поясненням — показуємо його текст.
 */
import { useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Pill, StatusPill, money, monthTitle, nextMonth } from "../ui";
import { useToast } from "../../components/Toasts";
import { Block } from "./Block";
import { ADV_STATUS, dd, lastDay, monthGen, monthLow, monthShort, payHow, limitRule } from "./format";
import { AdvanceBlock } from "./Advance";

const d2 = (n: number, mk: string) => `${String(n).padStart(2, "0")}.${mk.slice(5)}`;

function closedLine(me: Obj): string {
  const r = me.closed as Obj, f = r.settlement as Obj | null, S = me.settings as Obj, nm = monthGen(nextMonth(r.month));
  const pay = f ? money(f.pay) : null;
  switch (r.status) {
    case "review": return `фінансист перевіряє до ${S.verifyByDay} ${nm}`;
    case "verified": return `потрібна ваша згода — розрахунковий лист в «Огляді»${pay ? ` · ${pay}` : ""}`;
    case "disputed": return "ви не погодились — чекаємо відповідь фінансиста";
    case "agreed": return r.payBlocked ? "форма — після всіх підписів обхідного листа" : `заповніть форму на виплату${pay ? ` · ${pay}` : ""}`;
    default: { const pl = r.payout as Obj | null; return `${pay ?? ""} · ${payHow(pl && pl.diff && r.status !== "paid" ? pl : r.form)}`; }
  }
}

/** Найближчі дати (і для простого кабінету на «Огляді»). */
export function CalendarBlock({ me }: { me: Obj }) {
  const S = me.settings as Obj, lv = me.live as Obj | null, r = me.closed as Obj | null, today = String(me.today ?? "");
  const T: Array<{ d: string; cls: string; b: string; s: string }> = [];
  if (lv) T.push({ d: dd(today), cls: "is-now", b: "Сьогодні", s: `нараховано ${money(lv.calc?.now?.total)} · орієнтовно` });
  if (r && r.status !== "paid") T.push({ d: `до ${d2(S.payByDay, nextMonth(r.month))}`, cls: "is-next", b: `Виплата за ${monthLow(r.month)}`, s: closedLine(me) });
  if (lv) {
    const mk = lv.month as string, A = lv.advance as Obj, req = A.request as Obj | null, nmk = nextMonth(mk);
    const advItem = { d: d2(A.fromDay, mk), cls: A.open && !req ? "is-next" : "", b: "Аванс",
      s: req ? `${money(req.amount)} · ${(ADV_STATUS[req.status]?.[0] ?? req.status).toLowerCase()}` : A.open ? `заявки відкрито — до ${money(A.limit?.amount)}` : `заявка з ${A.fromDay} числа; на сьогодні — до ${money(A.limit?.amount)}` };
    // аванс уже був (сьогодні після його дня) — ставимо перед «Сьогодні»
    if (+today.slice(8, 10) >= A.fromDay) { advItem.cls = ""; T.splice(0, 0, advItem); } else T.push(advItem);
    T.push({ d: d2(lastDay(mk), mk), cls: "", b: "Закриття місяця", s: me.employee?.role === "manager" ? `ТТН від ${S.ttn?.minPct} % угод — щоб ${money(S.ttn?.hold)} не утримали` : "нарахування фіксуються" });
    T.push({ d: `до ${d2(S.verifyByDay, nmk)}`, cls: "", b: "Перевірка фінансиста", s: "розрахунковий лист у кабінеті: погоджуєте або пишете, з чим не згодні" });
    T.push({ d: `до ${d2(S.payByDay, nmk)}`, cls: "", b: "Виплата", s: "готівкою або на карти — як вкажете у формі" });
  }
  return (
    <Block title="Найближчі дати">
      {T.length ? (
        <ol className="zc-tl">
          {T.map((x, i) => <li key={i} className={x.cls}><span className="zc-tl__d zp-num">{x.d}</span><span className="zc-tl__dot" aria-hidden="true" /><span><b>{x.b}</b><small>{x.s}</small></span></li>)}
        </ol>
      ) : <p className="zp-hint">Дат немає — ви не працюєте цього місяця.</p>}
    </Block>
  );
}

function HistoryBlock({ me }: { me: Obj }) {
  type Row = { mk: string; total: number; pay?: number; adv?: number; how?: string; st: string; single?: boolean };
  const rows: Row[] = ((me.payouts ?? []) as Obj[]).map((p) => ({ mk: p.month, total: Number(p.total), pay: Number(p.pay), how: p.how ? String(p.how) : undefined, st: "paid" })).reverse();
  const r = me.closed as Obj | null;
  if (r && r.status !== "paid" && r.settlement) rows.push({ mk: r.month, total: Number(r.settlement.total), adv: Number(r.settlement.advance), pay: Number(r.settlement.pay), how: r.form ? payHow(r.payout && r.payout.diff ? r.payout : r.form) : undefined, st: r.status });
  else if (r && r.status === "review") rows.push({ mk: r.month, total: NaN, st: "review" });
  const lv = me.live as Obj | null;
  if (lv) { const c = lv.calc as Obj; const single = !c.plan || c.planDone || me.simple; rows.push({ mk: lv.month, total: Number(single ? c.now.total : c.atPlan.total), st: "live", single }); }
  const vis = rows.filter((x) => Number.isFinite(x.total)).slice(-6), max = Math.max(1, ...vis.map((x) => x.total));
  return (
    <Block title="Мої виплати по місяцях">
      {vis.length > 1 && (
        <div className="zc-bars" role="img" aria-label={`Нараховано по місяцях: ${vis.map((x) => `${monthLow(x.mk)} ${Math.round(x.total)}`).join(", ")}`}>
          {vis.map((x) => (
            <div key={x.mk} className={x.st === "live" ? "is-cur" : ""}>
              <b className="zp-num">{(Math.round(x.total / 100) / 10).toString().replace(".", ",")}к</b>
              <i style={{ height: `${Math.max(4, Math.round(x.total / max * 104))}px` }} />
              <span>{monthShort(x.mk)}</span>
            </div>
          ))}
        </div>
      )}
      {rows.length ? (
        <ul className="zc-hist">
          {rows.slice().reverse().map((x) => (
            <li key={x.mk}>
              <span className="zc-hist__m">{monthTitle(x.mk)}</span>
              {x.st === "live" ? <Pill tone="warn">{x.single ? "іде · зараз" : "іде · при плані"}</Pill> : <StatusPill status={x.st} />}
              <b className="zp-num">{Number.isFinite(x.total) ? money(x.total) : "перевіряється"}</b>
              {x.pay !== undefined && <small>{x.adv ? `аванс −${money(x.adv)} · ` : ""}до виплати {money(x.pay)}{x.how ? ` · ${x.how}` : ""}</small>}
            </li>
          ))}
        </ul>
      ) : <p className="zp-hint">Виплат ще не було.</p>}
      <p className="zp-hint">Місяці до запуску системи — в архіві фінансиста; тут показано виплати з кабінету.</p>
    </Block>
  );
}

function AdvancesHistory({ me }: { me: Obj }) {
  const list = ((me.advances ?? []) as Obj[]).filter((a) => a.status !== "cancelled");
  if (!list.length) return null;
  return (
    <Block title="Мої аванси">
      <ul className="zc-hist">
        {list.map((a) => (
          <li key={a.id}>
            <span className="zc-hist__m">{monthTitle(a.month)}</span>
            <Pill tone={ADV_STATUS[a.status]?.[1] ?? "muted"}>{ADV_STATUS[a.status]?.[0] ?? a.status}</Pill>
            <b className="zp-num">{money(a.amount)}</b>
            <small>подано {dd(a.requestedAt)}{a.paidAt ? ` · виплачено ${dd(a.paidAt)}` : ""}{a.reason ? ` · ${a.reason}` : ""}</small>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function CardsBlock({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const cards = (me.cards ?? []) as Obj[];
  const [add, setAdd] = useState<{ number: string; holder: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<number | null>(null);
  async function save() {
    if (!add) return;
    setBusy(true); setErr(null);
    try { await payrollApi.addCard(add.number.replace(/\s/g, ""), add.holder.trim()); toast("Карту збережено."); setAdd(null); await onChanged(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }
  async function archive(id: number) {
    setBusy(true);
    try { await payrollApi.archiveCard(id); toast("Карту прибрано."); setDel(null); await onChanged(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  return (
    <Block id="cards" title="Куди виплачувати" sub="для авансу й ЗП">
      {!me.cardsAvailable && <div className="zp-note zp-note--warn">Збереження карт ще не налаштоване — фінансист увімкне його. Поки можна отримати готівкою.</div>}
      {cards.length ? (
        <ul className="zc-cards">
          {cards.map((c) => (
            <li key={c.id} className="zc-card">
              <span className="zc-card__plate" aria-hidden="true" />
              <div className="zp-grow"><span className="zp-num zc-card__no">•••• {c.last4}</span><small>{c.holder}</small></div>
              {del === c.id ? (
                <span className="zp-row">
                  <button type="button" className="zp-btn zp-btn--danger zp-btn--sm" disabled={busy} onClick={() => void archive(c.id)}>Прибрати</button>
                  <button type="button" className="zp-btn zp-btn--sm" onClick={() => setDel(null)}>Ні</button>
                </span>
              ) : <button type="button" className="zp-btn zp-btn--ghost zp-btn--sm" onClick={() => setDel(c.id)}>Прибрати</button>}
            </li>
          ))}
        </ul>
      ) : <p className="zp-note">Карт ще немає — додайте тут або прямо у формі на виплату.</p>}
      {add ? (
        <div className="zc-form">
          <label className="zp-field"><span>Номер карти</span>
            <input className="zp-input zp-num" inputMode="numeric" autoComplete="off" placeholder="0000 0000 0000 0000" value={add.number.replace(/\D/g, "").slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ")} onChange={(e) => setAdd({ ...add, number: e.target.value.replace(/\D/g, "") })} />
          </label>
          <label className="zp-field"><span>Отримувач — прізвище, імʼя (як у банку)</span>
            <input className="zp-input" autoComplete="off" value={add.holder} onChange={(e) => setAdd({ ...add, holder: e.target.value })} />
          </label>
          {err && <p className="zp-err">{err}</p>}
          <div className="zp-row">
            <button type="button" className="zp-btn zp-btn--dark" disabled={busy || !add.number || !add.holder.trim()} onClick={() => void save()}>Зберегти карту</button>
            <button type="button" className="zp-btn" onClick={() => { setAdd(null); setErr(null); }}>Скасувати</button>
          </div>
        </div>
      ) : <div className="zp-row"><button type="button" className="zp-btn" onClick={() => setAdd({ number: "", holder: me.employee?.name ?? "" })}>+ Додати карту</button></div>}
      <p className="zp-hint">Карта може бути будь-яка і на будь-кого — вкажіть отримувача, як у банку. На екрані — лише останні 4 цифри; повний номер бачить фінансист у відомості.</p>
    </Block>
  );
}

export default function Payouts({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> }) {
  const lv = me.live as Obj | null;
  return (
    <div className="zp-grid zp-grid--2">
      <div className="zc-col">
        <CalendarBlock me={me} />
        {lv && <AdvanceBlock me={me} onChanged={onChanged} />}
        {lv && !lv.advance?.open && !lv.advance?.request && lv.advance?.limit && <p className="zp-hint">Ліміт авансу: {limitRule(lv.advance.limit)}, не більше нарахованого.</p>}
      </div>
      <div className="zc-col">
        <HistoryBlock me={me} />
        <AdvancesHistory me={me} />
        <CardsBlock me={me} onChanged={onChanged} />
      </div>
    </div>
  );
}
