/**
 * Вкладка «Огляд» кабінету (макет `c02-home.js`, `homeView`): закриття минулого місяця → «асфальт» поточного місяця
 * (вантажівка на смузі маржі, зупинки — пороги відсотка) → аванс / ДН / звільнення / «Що зробити, щоб отримати більше» →
 * «З чого складається» (зараз / при виконанні плану) → мої угоди (менеджер) або команда (тім-лід).
 * Простий кабінет (відділ не продає): без «Що зробити», плану, угод — замість них найближчі дати.
 * Усі суми — з рушія на сервері (`/payroll/me`); тут лише показ і порядок підказок (`todoItems` макета).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { payrollApi, type Obj } from "../api";
import { Pill, money, nextMonth, prevMonth, useLoad } from "../ui";
import { Block } from "./Block";
import { ceilE, dd, ddy, levelName, levelWho, monthGen, monthLow, nf, pc, plural, limitRule } from "./format";
import { CloseCard } from "./CloseCard";
import { AdvanceBlock } from "./Advance";
import { LeaveBlock } from "./ClearanceMine";
import { CalendarBlock } from "./Payouts";
import { DEALS_NO_TTN, useAdvanceRemind } from "./remind";

export type CabTab = "home" | "goal" | "pay" | "terms";
type Go = (tab: CabTab, focus?: string) => void;

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthName = (mk: string) => MONTHS[+mk.slice(5, 7) - 1] ?? mk;
const sumOf = (xs: Obj[], k = "amount") => xs.reduce((s, x) => s + Number(x[k] ?? 0), 0);

// ---------- маршрут місяця ----------
function stopsOf(c: Obj, S: Obj, ls: boolean): Array<[number, string, string, boolean?]> {
  if (c.kind === "lead") return [[c.plan, `План команди ${nf(c.plan)}`, `→ ${S.lead.pctHigh} %`]];
  if (c.kind === "staff") return c.plan ? [[c.plan, `План компанії ${nf(c.plan)}`, ""]] : [];
  if (c.level === "start") {
    const s: Array<[number, string, string, boolean?]> = [[c.plan, `План ${nf(c.plan)}`, `→ ${S.start.pctHigh} %${ls ? " · крок до «Профі»" : ""}`]];
    if (c.kpi && Math.abs(S.kpi.waiveFrom - c.plan) > c.plan * 0.12) s.push([S.kpi.waiveFrom, nf(S.kpi.waiveFrom), "· бонус без дзвінків", true]);
    return s;
  }
  const s: Array<[number, string, string, boolean?]> = [[S.profi.threshold, nf(S.profi.threshold), `→ ${S.profi.pct2} %`]];
  if (c.plan) s.push([c.plan, `План ${nf(c.plan)}`, `→ ${S.profi.pct3} %`]);
  return s;
}
function Road({ c, S, ls }: { c: Obj; S: Obj; ls: boolean }) {
  const stops = stopsOf(c, S, ls).filter((s) => s[0] > 0).sort((a, b) => a[0] - b[0]);
  if (!stops.length) return null;
  const max = Math.max(stops[stops.length - 1][0] * 1.12, c.margin * 1.06, 10000);
  const x = (v: number) => Math.max(0, Math.min(100, v / max * 100));
  return (
    <div className="zp-road" role="img" aria-label={`Маржа ${money(c.margin)}; зупинки: ${stops.map((s) => `${s[1]} ${s[2]}`).join(", ")}`}>
      <div className="zp-road__done" style={{ width: `${x(c.margin)}%` }} />
      <div className="zp-road__lane" />
      {stops.map((s, i) => {
        const xx = x(s[0]);
        return (
          <div key={i}>
            <div className={`zp-road__stop ${s[3] ? "zp-road__stop--dash" : ""}`} style={{ left: `${xx}%` }} />
            <div className={`zp-road__label ${i % 2 ? "zp-road__label--bot" : "zp-road__label--top"}`} style={{ left: `${Math.min(88, Math.max(12, xx))}%` }}><b>{s[1]}</b> {s[2]}</div>
          </div>
        );
      })}
      <div className="zp-road__truck" style={{ left: `max(40px, ${x(c.margin)}%)` }} aria-hidden="true">🚚</div>
    </div>
  );
}

function Hero({ me }: { me: Obj }) {
  const lv = me.live as Obj, c = lv.calc as Obj, S = me.settings as Obj, e = me.employee as Obj, dy = c.days as Obj;
  const mk = lv.month as string;
  const flat = me.simple || (c.kind === "staff" && !c.pctRule);
  const used = c.kind === "manager" ? ((c.deals ?? []) as Obj[]).filter((d) => d.counts).length : 0;
  let nowS: ReactNode;
  if (c.kind === "manager") nowS = used ? <>за {used} {plural(used, "угодою", "угодами", "угодами")} «Успішно реалізовано» · маржа <b>{money(c.margin)}</b></> : "угод «Успішно реалізовано» цього місяця ще немає";
  else if (c.kind === "lead") nowS = <>маржа команди <b>{money(c.margin)}</b> · без ваших власних угод</>;
  else if (flat) nowS = `${dy.total < dy.full ? `ставка за ${dy.total} з ${dy.full} робочих днів` : "ставка за повний місяць"}${c.pctRule ? ` + ${pc(c.pctRule.value)} маржі компанії` : ""}${c.now.birthday ? ` · ${money(c.now.birthday)} — дні народження` : ""}`;
  else nowS = <>маржа компанії <b>{money(c.margin)}</b></>;
  let k2: string, big2: string, s2: ReactNode, cls2 = "zp-hero__sum--plan";
  if (flat) {
    const o = e.official as Obj | null, ded = o && o.deduct ? Number(o.amount) : 0, adv = lv.advance?.request?.status === "paid" ? Number(lv.advance.request.amount) : 0;
    if (ded || adv) { k2 = "До виплати за місяць"; big2 = money(c.now.total - ded - adv); s2 = [ded ? `офіційну ${money(ded)} отримуєте окремо — тут її вирахуємо` : "", adv ? `аванс ${money(adv)} уже виплачено` : ""].filter(Boolean).join(" · "); }
    else { k2 = "Ставка за місяць"; big2 = money(e.rate); s2 = "без плану й відсотка — стабільно"; }
  } else if (c.planDone) { k2 = "План виконано"; big2 = money(10000 * c.now.pct / 100, { sign: true }); s2 = `за кожні наступні 10 000 ₴ маржі${c.kind === "lead" ? " команди" : ""} — ${pc(c.now.pct)}`; cls2 = "zc-ok"; }
  else if (c.kind === "manager" && !c.plan) { k2 = "Плану керівника немає"; big2 = pc(c.now.pct); s2 = `${S.profi.pct2} % — від ${money(S.profi.threshold)} маржі`; }
  else {
    k2 = "При виконанні плану"; big2 = money(c.atPlan.total);
    s2 = c.kind === "lead" ? `маржа команди ${money(c.marginPlan)} = план · ${S.lead.pctHigh} %`
      : c.level === "start" ? <>ще <b>{money(c.plan - c.margin)}</b> маржі — і {S.start.pctHigh} % на всю маржу</> : `маржа ${money(c.marginPlan)} = план керівника · ${S.profi.pct3} %`;
  }
  const late = e.startDate?.slice(0, 7) === mk ? ` · вийшли ${dd(e.startDate)}` : "";
  return (
    <section className="zp-hero" aria-label="Маршрут місяця">
      <div className="zp-hero__cols">
        <div><div className="zp-k">Нараховано зараз</div><div className="zp-hero__sum">{money(c.now.total)}</div><div className="zp-hero__sub">{nowS}</div></div>
        <div><div className="zp-k">{k2}</div><div className={`zp-hero__sum ${cls2}`}>{big2}</div><div className="zp-hero__sub">{s2}</div></div>
      </div>
      {!flat && <Road c={c} S={S} ls={e.offer === "ls"} />}
      <div className="zp-days">
        <span>{dy.elapsed}-й робочий день із {dy.total}{dy.left ? ` · лишилось ${dy.left}` : ""}{late}</span>
        <span className="zc-ticks" aria-hidden="true">{Array.from({ length: dy.total }, (_, i) => <i key={i} className={i + 1 === dy.elapsed ? "is-today" : i + 1 > dy.elapsed ? "is-left" : ""} />)}</span>
      </div>
      <div className="zp-hero__sub">орієнтовно · остаточно — після перевірки фінансиста до {S.verifyByDay} {monthGen(nextMonth(mk))}</div>
    </section>
  );
}

function LsStrip({ me, go }: { me: Obj; go: Go }) {
  const S = me.settings as Obj, of = me.employee.offerInfo as Obj, lv = me.employee.level;
  return (
    <section className="zc-ls" aria-label="Ваш офер — команда Лілії Шаврової">
      <div className="zc-ls__h"><span className="zp-k">Ваш офер</span><b>{of.name}</b><span className="zp-hint">своя система оплати — інша, ніж у решти відділу продажу</span></div>
      <div className="zc-ls__g">
        <div className={`zc-ls__lv ${lv === "start" ? "is-on" : ""}`}><small>«Старт»{lv === "start" ? " · ви тут" : ""}</small><b>{nf(of.startRate ?? S.start.rate)} ₴ + {S.start.pctLow} / {S.start.pctHigh} %</b><span>план {nf(of.startPlan ?? 0)} ₴ · без бонусу за КПІ</span></div>
        <div className="zc-ls__arr" aria-hidden="true"><span>2 місяці поспіль понад {nf(of.autoProfiFrom ?? 0)} ₴</span></div>
        <div className={`zc-ls__lv ${lv === "profi" ? "is-on" : ""}`}><small>«Профі»{lv === "profi" ? " · ви тут" : ""}</small><b>{S.profi.pct1} / {S.profi.pct2} / {S.profi.pct3} %</b><span>без ставки · автоматично й назавжди</span></div>
      </div>
      <button type="button" className="zp-btn zp-btn--ghost zp-btn--sm" onClick={() => go("terms")}>Чим відрізняється від стандартного офера →</button>
    </section>
  );
}

// ---------- що зробити, щоб отримати більше (макет: `todoItems`) ----------
type Act = { label: string; run: () => void; busy?: boolean };
type Todo = { v: number; cls: "risk" | "gain" | "done" | "info"; imp: string; lbl: string; h: string; p: string; bar?: number; color?: string; act?: Act; act2?: Act };
/** Дії поза кабінетом: інший розділ дашборда, фільтр «без ТТН» у моїх угодах, «Нагадати» про аванс. */
type Ex = { nav: (section: string) => void; dealsNoTtn: () => void; remind: { label: string; toggle: () => void; busy: boolean } };
function todoItems(me: Obj, go: Go, ex: Ex): Todo[] {
  const lv = me.live as Obj, c = lv.calc as Obj, S = me.settings as Obj, e = me.employee as Obj, mk = lv.month as string;
  const it: Todo[] = [], left = c.days.left as number;
  const toDeals = { label: "Мої угоди", run: () => go("home", "deals") };
  const cl = me.clearance as Obj | null;
  if (e.leave && e.leave.date?.slice(0, 7) === mk && cl && !cl.ok)
    it.push({ v: 1e9, cls: "risk", imp: `${cl.done} з ${cl.total}`, lbl: "обхідний лист", h: "Обхідний лист — до фінального розрахунку", p: "Повідомте клієнтів письмово (месенджер) і надішліть скріншоти тім-ліду; допоможіть новому відповідальному з машинами; поверніть техніку бізнес-асистенту за актом ТМЦ. Без усіх підписів розрахунок не проводимо.", act: { label: "Хто підписав", run: () => go("home", "leave") } });
  if (c.kind === "manager") {
    const start = c.level === "start", ls = e.offer === "ls";
    const counted = ((c.deals ?? []) as Obj[]).filter((d) => d.counts);
    const avg = counted.length ? sumOf(counted, "margin") / counted.length : 0;
    const perDay = (gap: number) => (left && avg > 0 ? ` Це ~${money(gap / left)} на день, ≈ ${ceilE(gap / avg)} авто з вашим середнім чеком ${money(avg)}.` : left ? ` Це ~${money(gap / left)} на день.` : "");
    if (start) {
      if (c.plan && c.margin < c.plan) it.push({ v: c.atPlan.total - c.now.total, cls: "gain", imp: money(c.atPlan.total - c.now.total, { sign: true }), lbl: "до ЗП", h: `Добрати ${money(c.plan - c.margin)} маржі до плану`, p: `План ${nf(c.plan)}${ls ? " за офером" : ""} → ${S.start.pctHigh} % на всю маржу замість ${S.start.pctLow} %.${perDay(c.plan - c.margin)}`, bar: c.margin / c.plan, act: toDeals });
      else if (c.plan) it.push({ v: 1, cls: "done", imp: `${c.now.pct} %`, lbl: "план виконано", h: `План ${nf(c.plan)} виконано`, p: `${c.now.pct} % на всю маржу місяця: кожні наступні 10 000 ₴ маржі — +${money(10000 * c.now.pct / 100)} до ЗП.` });
    } else {
      if (c.margin < S.profi.threshold) { const g = S.profi.threshold * S.profi.pct2 / 100 - c.margin * c.now.pct / 100; it.push({ v: g, cls: "gain", imp: money(g, { sign: true }), lbl: `до ${S.profi.pct2} %`, h: `Добрати ${money(S.profi.threshold - c.margin)} маржі до ${nf(S.profi.threshold)}`, p: `Від ${nf(S.profi.threshold)} ₴ — ${S.profi.pct2} % на всю маржу замість ${S.profi.pct1} %.${perDay(S.profi.threshold - c.margin)}`, bar: c.margin / S.profi.threshold, act: toDeals }); }
      if (c.plan && c.margin < c.plan) it.push({ v: c.atPlan.total - c.now.total - 1, cls: "gain", imp: money(c.atPlan.total - c.now.total, { sign: true }), lbl: `до ${S.profi.pct3} %`, h: `Виконати план керівника ${nf(c.plan)}`, p: `Ще ${money(c.plan - c.margin)} маржі — і ${S.profi.pct3} % на всю маржу.${perDay(c.plan - c.margin)}`, bar: c.margin / c.plan, act: toDeals });
      else if (c.plan) it.push({ v: 1, cls: "done", imp: `${S.profi.pct3} %`, lbl: "план виконано", h: `План керівника ${nf(c.plan)} виконано`, p: `Кожні наступні 10 000 ₴ маржі — +${money(10000 * S.profi.pct3 / 100)}.` });
    }
    // бонус за КПІ («Старт» стандартного оферу)
    const k = c.kpi as Obj | null;
    if (k && !k.noBonus) {
      const ladder = (S.kpi.ladder ?? []) as Array<[number, number]>;
      const curB = k.step ? k.step[1] : 0, nx = ladder.find((s) => s[0] > k.conv);
      if (nx && k.leads) { const need = Math.max(1, ceilE(nx[0] * k.leads / 100) - k.targetDeals); it.push({ v: nx[1] - curB, cls: "gain", imp: money(nx[1] - curB, { sign: true }), lbl: "до бонусу", h: `Ще ${need} ${plural(need, "цільова угода", "цільові угоди", "цільових угод")} — конверсія ${nx[0]} %`, p: `Зараз ${pc(k.conv)}: ${k.targetDeals} з ${k.leads} цільових звернень. Бонус ${money(nx[1])} замість ${money(curB)}.`, bar: k.conv / nx[0], color: "var(--info)", act: { label: "Мої звернення", run: () => ex.nav("ai-calls") } }); }
      if (k.step && k.waived) it.push({ v: 2, cls: "done", imp: money(k.step[1]), lbl: "бонус", h: `Маржа від ${nf(S.kpi.waiveFrom)} ₴ — дзвінки не враховуються`, p: `Бонус за КПІ — лише за конверсією: ${pc(k.conv)} → сходинка ${k.step[0]} %.` });
      else if (k.step && !k.done && k.reach) { const rest = k.need - k.normDays; it.push({ v: k.step[1], cls: "risk", imp: money(k.step[1]), lbl: "зберегти", h: `Норма дзвінків ${S.kpi.normCalls}+ ще в ${rest} ${plural(rest, "день", "дні", "днів")} із ${k.left}`, p: `${k.normDays} з ${k.need} потрібних днів.${c.margin < S.kpi.waiveFrom ? ` Або маржа від ${nf(S.kpi.waiveFrom)} ₴ — ще ${money(S.kpi.waiveFrom - c.margin)}, тоді дзвінки не враховуються.` : ""}`, bar: k.need ? k.normDays / k.need : 0, color: "var(--warn)", act: { label: "Дзвінки сьогодні", run: () => ex.nav("report") } }); }
      else if (k.step && !k.done) it.push({ v: k.step[1], cls: "risk", imp: money(k.step[1]), lbl: "під ризиком", h: "Норму дзвінків цього місяця вже не набрати", p: `${k.normDays} з ${k.need} днів, лишилось ${k.left} ${plural(k.left, "день", "дні", "днів")}. Бонус ${money(k.step[1])} буде, лише якщо маржа дійде до ${nf(S.kpi.waiveFrom)} ₴ — ще ${money(Math.max(0, S.kpi.waiveFrom - c.margin))}.`, bar: c.margin / S.kpi.waiveFrom, color: "var(--warn)", act: toDeals });
    }
    // ТТН поточного місяця: без ТТН понад 7 днів після перевезення
    const t = lv.ttn as Obj | null, min = S.ttn.minPct;
    if (t && t.total && t.pct < min) {
      const today = String(me.today ?? ""), weekAgo = (iso: string) => { const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); };
      const late = ((t.missing ?? []) as Obj[]).filter((d) => weekAgo(String(d.date)) < today);
      if (late.length) { const need = Math.max(1, ceilE(min * t.total / 100) - t.done), d = late[0]; it.push({ v: S.ttn.hold, cls: "risk", imp: money(S.ttn.hold), lbl: "не втратити", h: `Додати ТТН: ${d.client}, ${dd(d.date)}`, p: `ТТН є в ${t.done} з ${t.total} угод. На закриття місяця потрібно від ${min} % — ще ${need}, інакше ${money(S.ttn.hold)} утримаємо з виплати до закриття ТТН.`, bar: t.done / t.total, color: "var(--warn)", act: { label: "Угоди без ТТН", run: ex.dealsNoTtn } }); }
    }
    // утримання ТТН попереднього місяця
    const pv = lv.ttnPrev as Obj | null;
    if (pv && pv.released) it.push({ v: 3, cls: "done", imp: money(S.ttn.hold, { sign: true }), lbl: "повернемо", h: `ТТН ${monthGen(pv.month)} закрито${pv.at ? ` ${dd(pv.at)}` : ""}`, p: `Утримані ${money(S.ttn.hold)} додамо до виплати за ${monthLow(mk)}.` });
    else if (pv) { const need = Math.max(1, ceilE(min * pv.ttn.total / 100) - pv.ttn.done); it.push({ v: S.ttn.hold + 1, cls: "risk", imp: money(S.ttn.hold, { sign: true }), lbl: "повернути", h: `Закрити ТТН ${monthGen(pv.month)}`, p: `${pv.ttn.done} з ${pv.ttn.total} (${pc(pv.ttn.pct)}) — потрібно від ${min} %: ще ${need}. Закриєте до виплати — ${money(S.ttn.hold)} додамо до неї; ні — переходить далі.`, bar: pv.ttn.total ? pv.ttn.done / pv.ttn.total : 0, color: "var(--warn)" }); }
    // команда Лілії: автоматичний перехід на «Профі»
    if (ls && start) {
      const A = Number(e.offerInfo?.autoProfiFrom ?? 0), pm = prevMonth(mk), mPrev = lv.autoProfi as number | null, nx = monthGen(nextMonth(mk));
      if (A) {
        if (mPrev != null && mPrev > A && c.margin > A) it.push({ v: 5, cls: "done", imp: "«Профі»", lbl: `з 1 ${nx}`, h: `Обидва місяці понад ${nf(A)} ₴`, p: `${monthName(pm)} — ${money(mPrev)}, ${monthLow(mk)} — ${money(c.margin)}. Якщо місяць так і закриється, з 1 ${nx} — «Профі» автоматично й назавжди. Заява не потрібна.` });
        else if (mPrev != null && mPrev > A) it.push({ v: 4e4, cls: "gain", imp: "«Профі»", lbl: `з 1 ${nx}`, h: `Ще ${money(Math.max(0, A - c.margin))} маржі — і «Профі» автоматично`, p: `${monthName(pm)} уже понад ${nf(A)} ₴ (${money(mPrev)}). Другий такий місяць — і з 1 ${nx} «Профі»: ${S.profi.pct1}–${S.profi.pct3} % без ставки.`, bar: c.margin / A, color: "var(--zp-ls)", act: { label: "Як рахується", run: () => go("terms") } });
        else it.push({ v: 4, cls: "info", imp: `${nf(A / 1000)} тис.`, lbl: "2 місяці", h: c.margin > A ? `${monthName(mk)} — перший місяць понад ${nf(A)} ₴` : `До «Профі» — два місяці поспіль понад ${nf(A)} ₴`, p: c.margin > A ? "Ще один такий місяць — і «Профі» автоматично." : `${monthName(pm)}: ${mPrev == null ? "немає даних" : money(mPrev)}; зараз — ${money(c.margin)}.`, bar: c.margin / A, color: "var(--zp-ls)", act: { label: "Як рахується", run: () => go("terms") } });
      }
    }
    // стандартний офер: рівень за вибором
    if (!ls && start) {
      const ln = e.levelChange as Obj | null;
      if (ln && ln.from > mk) it.push({ v: 6, cls: "info", imp: levelName(ln.level), lbl: `з 1 ${monthGen(ln.from)}`, h: `З 1 ${monthGen(ln.from)} — ${levelName(ln.level)}`, p: `${me.levelChangeInfo ? `${levelWho(me.levelChangeInfo as Obj)[0].toUpperCase()}${levelWho(me.levelChangeInfo as Obj).slice(1)}. ` : ""}Новий офер — у ваших документах, рекрутер зв’яжеться для підпису.`, act: { label: "Умови «Профі»", run: () => go("terms") } });
      else if (c.margin >= S.profi.threshold && lv.autoProfi != null && lv.autoProfi >= S.profi.threshold) it.push({ v: 7, cls: "info", imp: `${S.profi.pct2} %`, lbl: "на «Профі»", h: `Маржа від ${nf(S.profi.threshold)} ₴ другий місяць поспіль`, p: `Можна перейти на «Профі» з наступного місяця: без ставки, ${S.profi.pct1}–${S.profi.pct3} %. Рішення ваше або керівництва.`, act: { label: "Порівняти", run: () => go("terms") } });
    }
    const held = ((c.deals ?? []) as Obj[]).filter((d) => !d.counts && String(d.date) <= String(me.today));
    if (held.length) it.push({ v: 8, cls: "info", imp: money(sumOf(held, "margin")), lbl: "не в цьому місяці", h: `${held.length} ${plural(held.length, "угода", "угоди", "угод")} чекають оплати клієнта`, p: "За налаштуваннями маржа піде в ЗП місяця, коли клієнт заплатить.", act: toDeals });
  }
  if (c.kind === "lead") {
    if (c.plan && c.margin < c.plan) it.push({ v: c.atPlan.total - c.now.total, cls: "gain", imp: money(c.atPlan.total - c.now.total, { sign: true }), lbl: "до ЗП", h: `Команді — ще ${money(c.plan - c.margin)} маржі до плану`, p: `План команди ${nf(c.plan)} → ${S.lead.pctHigh} % від маржі команди замість ${S.lead.pctLow} %.${left ? ` Це ~${money((c.plan - c.margin) / left)} маржі команди на день.` : ""}`, bar: c.margin / c.plan, act: { label: "Команда", run: () => go("home", "team") } });
    else if (c.plan) it.push({ v: 1, cls: "done", imp: `${S.lead.pctHigh} %`, lbl: "план виконано", h: `План команди ${nf(c.plan)} виконано`, p: `Кожні наступні 10 000 ₴ маржі команди — +${money(10000 * S.lead.pctHigh / 100)}.` });
  }
  // аванс — ще не відкрито
  const A = lv.advance as Obj, L = A.limit as Obj | null;
  if (!A.request && !A.open && L && L.amount > 0) it.push({ v: 0, cls: "info", imp: money(L.amount), lbl: "аванс", h: `Аванс — з ${A.fromDay} ${monthGen(mk)}`, p: `На сьогодні можна було б взяти до ${money(L.amount)} (${limitRule(L)}). Вираховується при закритті місяця.`, act: { label: ex.remind.label, run: ex.remind.toggle, busy: ex.remind.busy }, act2: { label: "Виплати", run: () => go("pay", "adv") } });
  const rank = (x: Todo) => (x.cls === "risk" || x.cls === "gain" ? 0 : x.cls === "info" ? 1 : 2);
  return it.sort((x, y) => rank(x) - rank(y) || y.v - x.v);
}
function TodoBlock({ me, go, onChanged }: { me: Obj; go: Go; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();
  const rm = useAdvanceRemind(me, onChanged);
  const it = todoItems(me, go, {
    nav: (section) => navigate(`/${section}`),
    dealsNoTtn: () => { window.dispatchEvent(new CustomEvent(DEALS_NO_TTN)); go("home", "deals"); },
    remind: { label: rm.label, toggle: () => void rm.toggle(), busy: rm.busy },
  });
  return (
    <Block title="Що зробити, щоб отримати більше" sub="від найвигіднішого · оновлюється щодня">
      {it.length ? it.map((x, i) => (
        <div key={i} className={`zp-todo zc-todo--${x.cls} ${x.cls === "risk" ? "zp-todo--risk" : ""}`}>
          <div><div className={`zp-todo__amt zc-imp--${x.cls}`}>{x.imp}</div><div className="zp-todo__kind">{x.lbl}</div></div>
          <div>
            <div className="zp-todo__title">{x.h}</div>
            <div className="zp-todo__text">{x.p}</div>
            {x.bar !== undefined && Number.isFinite(x.bar) && <div className="zp-bar"><i style={{ width: `${Math.min(100, Math.max(0, x.bar * 100))}%`, background: x.color ?? "var(--ok)" }} /></div>}
            {(x.act || x.act2) && (
              <div className="zp-row">
                {x.act && <button type="button" className="zp-btn zp-btn--sm" disabled={x.act.busy} onClick={x.act.run}>{x.act.label}</button>}
                {x.act2 && <button type="button" className="zp-btn zp-btn--ghost zp-btn--sm" onClick={x.act2.run}>{x.act2.label}</button>}
              </div>
            )}
          </div>
        </div>
      )) : <p className="zp-note">Зараз нічого робити не треба — ставка нараховується щодня, аванс і виплата — за календарем у «Виплатах».</p>}
    </Block>
  );
}

// ---------- з чого складається ----------
function partsOf(me: Obj, c: Obj, plan: boolean): Array<{ k: string; s: string; v: number; color: string }> {
  const S = me.settings as Obj, e = me.employee as Obj, x = plan ? c.atPlan : c.now, out: Array<{ k: string; s: string; v: number; color: string }> = [];
  const dy = c.days as Obj, ls = e.offer === "ls";
  if (c.kind !== "manager" || c.level === "start")
    out.push({ k: c.kind === "manager" ? `Ставка «Старт»${ls ? " · офер Лілії" : ""}` : c.kind === "lead" ? "Ставка тім-ліда" : "Ставка",
      s: !x.rate ? (e.leave && e.leave.date?.slice(0, 7) === c.month ? "звільнення: ставка не нараховується (п. 11 оферу)" : "—") : dy.total < dy.full ? `пропорційно: ${dy.total} з ${dy.full} робочих днів` : "за повний місяць", v: x.rate, color: "var(--text-muted)" });
  if (c.kind !== "staff" || c.pctRule) out.push({ k: `Відсоток · ${pc(x.pct)}`, s: `від ${c.kind === "lead" ? "маржі команди" : c.kind === "staff" ? "маржі компанії" : "маржі"} ${money(plan ? c.marginPlan : c.margin)}`, v: x.pctAmount, color: "var(--brand)" });
  if (c.kind === "manager" && c.kpi) { const k = c.kpi as Obj; out.push({ k: "Бонус за КПІ", s: k.noBonus ? "звільнення — без бонусу" : k.step ? `конверсія ${pc(k.conv)} → сходинка ${k.step[0]} %${x.bonus ? "" : " · без норми дзвінків — 0"}` : `конверсія ${pc(k.conv)} — нижче ${S.kpi.ladder?.[0]?.[0]} %`, v: x.bonus, color: "var(--info)" }); }
  const bl = (c.birthdays ?? []) as Obj[], g = bl.find((b) => b.kind === "gift"), gv = bl.filter((b) => b.kind === "give");
  if (g) out.push({ k: `Ваш день народження · ${dd(g.date)}`, s: "нараховуємо автоматично", v: Number(g.amount), color: "var(--zp-gift)" });
  if (gv.length) out.push({ k: gv.length > 1 ? `Збір на дні народження колег · ${gv.length}` : "Збір на день народження колеги", s: `${gv.map((b) => `${b.who?.name ?? ""}, ${dd(b.date)}`).join("; ")} — ${nf(S.birthday.each)} ₴ з кожного, автоматично`, v: sumOf(gv), color: "var(--text-muted)" });
  return out;
}
function PartsBlock({ me }: { me: Obj }) {
  const lv = me.live as Obj, c = lv.calc as Obj, e = me.employee as Obj;
  const single = me.simple || (c.kind === "staff" && !c.pctRule) || c.planDone || (c.kind === "manager" && !c.plan);
  const [sc, setSc] = useState<"now" | "plan">("now");
  const plan = !single && sc === "plan";
  const ps = partsOf(me, c, plan), pos = ps.filter((x) => x.v > 0), sp = pos.reduce((s, x) => s + x.v, 0) || 1;
  const total = plan ? c.atPlan.total : c.now.total;
  const o = e.official as Obj | null, adv = lv.advance?.request?.status === "paid" ? Number(lv.advance.request.amount) : 0, extra: string[] = [];
  if (adv) extra.push(`аванс ${money(adv)} уже виплачено — вирахуємо`);
  if (o) extra.push(o.deduct ? `офіційну ЗП ${money(o.amount)} отримуєте окремо — з цієї суми її вирахуємо` : `офіційна ЗП ${money(o.amount)} — окремо, понад цю суму`);
  return (
    <Block title="З чого складається" aside={single ? undefined : (
      <div className="zc-seg" role="group" aria-label="Сценарій">
        <button type="button" aria-pressed={!plan} onClick={() => setSc("now")}>Зараз</button>
        <button type="button" aria-pressed={plan} onClick={() => setSc("plan")}>При виконанні плану</button>
      </div>
    )}>
      {!me.simple && <div className="zp-stack" aria-hidden="true">{pos.map((x, i) => <i key={i} style={{ width: `${x.v / sp * 100}%`, background: x.color }} />)}</div>}
      <ul className="zc-legend">
        {ps.map((x, i) => (
          <li key={i}><span className="zp-dot" style={{ background: x.color }} /><span className="zp-grow">{x.k}<small>{x.s}</small></span><b className={`zp-num ${x.v < 0 ? "zp-tone--muted" : ""}`}>{x.v > 0 && x.color === "var(--zp-gift)" ? "+" : ""}{money(x.v)}</b></li>
        ))}
      </ul>
      <div className="zc-total"><span>Разом{plan ? " при виконанні плану" : " зараз"}</span><b className="zp-num">{money(total)}</b></div>
      {extra.length > 0 && <p className="zp-hint">У виплаті: {extra.join("; ")}.</p>}
    </Block>
  );
}

// ---------- мої угоди ----------
const PAY: Record<string, [string, "ok" | "muted" | "danger"]> = { paid: ["оплачено", "ok"], wait: ["чекаємо оплату", "muted"], over: ["прострочено", "danger"] };
function DealsBlock({ me }: { me: Obj }) {
  const lv = me.live as Obj, S = me.settings as Obj, t = lv.ttn as Obj | null, mk = lv.month as string;
  const [month, setMonth] = useState(mk);
  const [all, setAll] = useState(false);
  const [noTtn, setNoTtn] = useState(false);
  // «Угоди без ТТН» з «Що зробити» — вмикає фільтр на поточному місяці
  useEffect(() => {
    const on = () => { setMonth(mk); setNoTtn(true); setAll(true); };
    window.addEventListener(DEALS_NO_TTN, on);
    return () => window.removeEventListener(DEALS_NO_TTN, on);
  }, [mk]);
  const live = month === mk;
  const { data } = useLoad(() => (live ? Promise.resolve(null) : payrollApi.myDeals(month)), [month, live]);
  const today = String(me.today ?? "");
  const ds = ((live ? lv.calc.deals : data) ?? []) as Obj[];
  const hasTtn = (d: Obj) => !!d.ttnAt && String(d.ttnAt).slice(0, 10) <= today;
  const listAll = ds.filter((d) => String(d.date) <= today || !live).slice().reverse();
  const withoutTtn = listAll.filter((d) => !hasTtn(d)).length;
  const list = noTtn ? listAll.filter((d) => !hasTtn(d)) : listAll;
  const n = all ? list.length : Math.min(5, list.length);
  return (
    <Block id="deals" title="Угоди «Успішно реалізовано»" aside={
      <>
        <select className="zp-select zc-mini-select" value={month} onChange={(e) => { setMonth(e.target.value); setAll(false); }} aria-label="Місяць">
          {[mk, prevMonth(mk), prevMonth(prevMonth(mk))].map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
        {live && t && <Pill tone={!t.total || t.pct >= S.ttn.minPct ? "ok" : "warn"}>ТТН {t.done} з {t.total}</Pill>}
        {(withoutTtn > 0 || noTtn) && (
          <button type="button" className={`zp-tab ${noTtn ? "is-active" : ""}`} style={{ padding: "3px 10px", fontSize: 12.5, borderRadius: 8 }} aria-pressed={noTtn} onClick={() => setNoTtn(!noTtn)}>
            без ТТН · {withoutTtn}
          </button>
        )}
      </>
    }>
      {list.length ? (
        <>
          <ul className="zc-deals">
            {list.slice(0, n).map((d) => {
              const has = !!d.ttnAt && String(d.ttnAt).slice(0, 10) <= today;
              const p = PAY[String(d.pay)] ?? ["—", "muted"];
              return (
                <li key={d.id} className={d.counts ? "" : "is-off"}>
                  <span className="zc-deals__d zp-num">{dd(d.date)}</span>
                  <span className="zc-deals__cl">{d.client}{!d.counts && <small className="zp-tone--warn">не в ЗП цього місяця</small>}</span>
                  <b className={`zp-num ${d.margin < 0 ? "zp-tone--danger" : ""}`}>{money(d.margin)}</b>
                  <span className="zc-deals__ch"><Pill tone={p[1]}>{p[0]}</Pill><Pill tone={has ? "ok" : "warn"}>{has ? "ТТН є" : "без ТТН"}</Pill></span>
                </li>
              );
            })}
          </ul>
          {list.length > 5 && <button type="button" className="zp-btn zp-btn--ghost zp-btn--sm" onClick={() => setAll(!all)}>{all ? "Згорнути" : `Усі ${list.length} ${plural(list.length, "угода", "угоди", "угод")}`}</button>}
        </>
      ) : <p className="zp-note">{noTtn ? "Угод без ТТН немає — усі з документами." : live ? "Цього місяця угод ще немає." : `За ${monthLow(month)} угод немає.`}</p>}
      <p className="zp-hint">Маржа — як рахує ядро дашборда; ТТН — з «Бізнес-асистент → ТТН моніторинг», зазвичай за 5–7 днів після перевезення. На закриття місяця потрібно від {S.ttn.minPct} % угод з ТТН.</p>
    </Block>
  );
}

function TeamBlock({ me }: { me: Obj }) {
  const c = me.live.calc as Obj, members = (c.members ?? []) as Obj[];
  return (
    <Block id="team" title={`Команда${me.employee.teamName ? ` «${me.employee.teamName}»` : ""}`} sub="маржа й план — без зарплат менеджерів">
      {members.length ? (
        <ul className="zc-team">
          {members.map((m) => {
            const pcnt = m.plan ? m.margin / m.plan : 0;
            return (
              <li key={m.empId}>
                <span className="zc-team__nm">{m.name || "Менеджер без імені"} <small>{levelName(m.level)}</small></span>
                <b className="zp-num">{money(m.margin)}</b>
                <small className="zp-num">{m.plan ? `з ${money(m.plan)}` : "плану немає"}</small>
                <div className="zp-bar"><i style={{ width: `${Math.min(100, pcnt * 100)}%`, background: pcnt >= 1 ? "var(--ok)" : "var(--text-muted)" }} /></div>
              </li>
            );
          })}
        </ul>
      ) : <p className="zp-note">У команді цього місяця немає менеджерів у зарплаті.</p>}
      <div className="zc-total"><span>Команда разом</span><b className="zp-num">{money(c.margin)} <small className="zp-muted">з {money(c.plan)}</small></b></div>
    </Block>
  );
}

function BdayBlock({ me }: { me: Obj }) {
  const g = me.live?.birthdayGift as Obj | null;
  if (!g) return null;
  const S = me.settings as Obj, mk = me.live.month as string;
  const done = String(g.date) <= String(me.today);
  const how = g.young ? `стаж ${g.months} ${plural(g.months, "місяць", "місяці", "місяців")}: ${g.months} × ${nf(S.birthday.perMonth)} + ${nf(g.company)} ₴ від компанії`
    : `збір колег ${(g.givers ?? []).length} × ${nf(S.birthday.each)} ₴ + ${nf(g.company)} ₴ від компанії`;
  return (
    <Block id="bday" tone="gift">
      <div className="zc-bday">
        <span className="zc-bday__d zp-num">{dd(g.date)}</span>
        <div>
          <b>{done ? "Вітаємо з днем народження!" : "Скоро ваш день народження"}</b>
          <div>За день народження {done ? "нараховано" : "буде нараховано"} <b className="zp-num">{money(g.amount, { sign: true })}</b> — автоматично, у виплаті за {monthLow(mk)}.</div>
        </div>
      </div>
      <p className="zp-hint">{how[0].toUpperCase() + how.slice(1)}. Фінансисту рядок додається сам — нічого подавати не треба.</p>
    </Block>
  );
}

export default function Overview({ me, go, onChanged }: { me: Obj; go: Go; onChanged: () => Promise<void> }) {
  const lv = me.live as Obj | null, e = me.employee as Obj;
  const simple = !!me.simple;
  const out: ReactNode[] = [];
  if (me.closed) out.push(<CloseCard key="close" me={me} onChanged={onChanged} />);
  if (!lv) {
    out.push(
      <Block key="gone" title={monthName(me.liveMonth)} aside={<Pill>не працюєте</Pill>}>
        <p className="zc-p">{e.leave ? `Ви не працюєте з ${ddy(e.leave.date)}.` : `Ваш перший робочий день — ${ddy(e.startDate)}.`} {me.closed ? "Фінальний розрахунок — вище." : ""}</p>
      </Block>,
    );
    return <div className="zc-col">{out}</div>;
  }
  out.push(<Hero key="hero" me={me} />);
  if (e.offer === "ls" && e.role === "manager") out.push(<LsStrip key="ls" me={me} go={go} />);
  const showAdv = lv.advance?.open || lv.advance?.request;
  const left: ReactNode[] = [
    showAdv ? <AdvanceBlock key="adv" me={me} onChanged={onChanged} /> : null,
    <BdayBlock key="bday" me={me} />,
    e.leave && e.leave.date?.slice(0, 7) === lv.month ? <LeaveBlock key="leave" me={me} onChanged={onChanged} /> : null,
    simple ? <CalendarBlock key="cal" me={me} /> : <TodoBlock key="todo" me={me} go={go} onChanged={onChanged} />,
  ];
  const right: ReactNode[] = [
    <PartsBlock key="parts" me={me} />,
    simple ? null : e.role === "manager" ? <DealsBlock key="deals" me={me} /> : e.role === "lead" ? <TeamBlock key="team" me={me} /> : null,
  ];
  out.push(<div key="grid" className="zp-grid zp-grid--2"><div className="zc-col">{left}</div><div className="zc-col">{right}</div></div>);
  return <div className="zc-col">{out}</div>;
}
