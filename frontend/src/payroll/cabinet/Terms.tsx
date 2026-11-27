/**
 * Вкладка «Умови» (макет `c05-terms.js`): мій офер і формула з моїми цифрами; для команди Лілії — порівняння зі
 * стандартним офером; рівень («Профі» за вибором — `chooseProfi`, або автоматично в офері Лілії); правила; мої документи (офери).
 * Блок «Дні народження · місяць» прибрано в усіх (задача 10723, Тетяна 23.11.2026: «від нього нічого не залежить»); правило ДН — у «Правилах».
 */
import { useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Pill, money, nextMonth, prevMonth } from "../ui";
import { useToast } from "../../components/Toasts";
import { Block } from "./Block";
import { bdayV2, dd, ddy, levelName, levelWho, monthGen, monthLow, nf, pc } from "./format";

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthName = (mk: string) => MONTHS[+mk.slice(5, 7) - 1] ?? mk;
const OFFER_T: Record<string, string> = { start: "Офер «Старт»", profi: "Офер «Профі»" };

function OfferBlock({ me }: { me: Obj }) {
  const S = me.settings as Obj, e = me.employee as Obj, c = me.live?.calc as Obj | undefined, mk = (me.live?.month ?? me.liveMonth) as string;
  const of = e.offerInfo as Obj, ls = e.offer === "ls", lad = (S.kpi?.ladder ?? []) as Array<[number, number]>;
  const o = e.official as Obj | null;
  const lv = e.level as string | null;
  const doc = ((me.offers ?? []) as Obj[]).filter((d) => !d.voidAt).sort((a, b) => String(b.from).localeCompare(String(a.from)))[0];
  const title = e.role === "manager" ? (ls ? of.name : OFFER_T[lv ?? "start"] ?? "Офер") : e.role === "lead" ? "Умови тім-ліда" : `Умови · ${e.title ?? "ставка"}`;
  const sub = doc ? (doc.signedAt ? `підписано ${dd(doc.signedAt)}` : "очікує підпису") : "ставку й умови задає фінансист у налаштуваннях";
  let cells: Array<[string, string, string]>;
  if (e.role === "manager" && lv !== "profi") cells = [
    ["Ставка", money(e.startRate), "за повний місяць; неповний — пропорційно робочим дням"],
    ["Відсоток від маржі", `${S.start.pctLow} → ${S.start.pctHigh} %`, `${S.start.pctHigh} % — коли виконано план ${ls ? `${nf(of.startPlan ?? 0)} ₴ за офером` : `місяця (${money(c?.plan ?? 0)} з «Планів»)`}; до всієї маржі`],
    e.hasKpi ? ["Бонус за КПІ", lad.length ? `${nf(lad[0][1])}–${nf(lad[lad.length - 1][1])} ₴` : "—", S.kpi.offerFrom
      ? `конверсія від ${lad[0]?.[0] ?? "—"} % (рахується від ${S.kpi.minLeads} цільових звернень); ${S.kpi.normCalls} дзвінків щодня і від ${nf(S.kpi.minSuccessCalls)} успішних (понад 10 с) за місяць — обидві умови; нараховується лише після виконання`
      : `конверсія від ${lad[0]?.[0] ?? "—"} % і норма дзвінків ${S.kpi.normCalls}+; маржа від ${nf(S.kpi.waiveFrom)} ₴ — без дзвінків`]
      : ["Бонус за КПІ", "немає", "в офері команди Лілії — зате ставка вдвічі більша"],
  ];
  else if (e.role === "manager") cells = [
    ["Ставка", "немає", "«Профі» — дохід повністю від результату"],
    ["Відсоток від маржі", `${S.profi.pct1} → ${S.profi.pct2} → ${S.profi.pct3} %`, `${S.profi.pct2} % — від ${nf(S.profi.threshold)} ₴; ${S.profi.pct3} % — виконано план керівника; до всієї маржі`],
    ["План керівника", c?.plan ? money(c.plan) : "немає", c?.plan ? `індивідуальний, на ${monthLow(mk)}` : `без плану — ${S.profi.pct1} / ${S.profi.pct2} %`],
  ];
  else if (e.role === "lead") cells = [
    ["Ставка", money(e.rate), "за повний місяць"],
    ["Відсоток від маржі команди", `${S.lead.pctLow} → ${S.lead.pctHigh} %`, `${S.lead.pctHigh} % — виконано план команди`],
    // власні угоди тімліда — за шкалою його рівня, як у менеджера, без особистого плану (Тетяна 27.11)
    ["Відсоток від власних угод", lv === "profi" ? `${S.profi.pct1} → ${S.profi.pct2} %` : `${S.start.pctLow} %`,
      lv === "profi" ? `шкала «Профі»: ${S.profi.pct2} % — від ${nf(S.profi.threshold)} ₴ вашої маржі` : "шкала «Старт», без особистого плану"],
    ["План команди", money(c?.plan ?? 0), "сума планів менеджерів з «Планів»"],
  ];
  else cells = [
    ["Ставка", money(e.rate), "за повний місяць; неповний — пропорційно робочим дням"],
    ["Відсоток", e.pctRule ? pc(e.pctRule.value) : "немає", e.pctRule ? "від маржі компанії" : "ставка без відсотка"],
    ["Офіційна ЗП", o ? money(o.amount) : "немає", o ? (o.deduct ? "щомісяця; вираховується з загальної ЗП" : "щомісяця; окремо, понад загальну ЗП") : "—"],
  ];
  const src = e.role === "manager" ? (ls ? (lv !== "profi" ? "постійні клієнти компанії, холодна база й лідогенерація; кого залучили — лишаються за вами" : "власна база постійних клієнтів і таблиця реактивації") : lv !== "profi" ? "звернення з реклами" : "лідгени") : null;
  const x = c?.now as Obj | undefined, parts: string[] = [];
  if (x) {
    if (x.rate) parts.push(nf(x.rate));
    if (c!.kind !== "staff" || c!.pctRule) parts.push(`${pc(x.pct)} × ${nf(c!.margin)}`);
    if (x.bonus) parts.push(nf(x.bonus));
  }
  const bd = x?.birthday ? ` ${x.birthday < 0 ? "−" : "+"} ${nf(Math.abs(x.birthday))}` : "";
  return (
    <Block title={title} sub={sub}>
      <div className="zc-terms">{cells.map((t, i) => <div key={i}><small>{t[0]}</small><b>{t[1]}</b><small>{t[2]}</small></div>)}</div>
      {src && <p className="zc-p"><span className="zp-k">Звідки клієнти</span><br />{src}</p>}
      {x && (
        <p className="zc-calcline">
          <span className="zp-k">Ваш розрахунок зараз</span>
          <span className="zp-num">{parts.join(" + ")}{bd} = <b>{money(x.total)}</b></span>
          {x.birthday ? <small className="zp-hint">{bdayV2(S, mk) ? `± — дні народження: ваш (+) і фонд днів народження (−${nf(S.birthday.each)} ₴ щомісяця)` : `± — дні народження: ваш (+) і колег (−${nf(S.birthday.each)} ₴ з кожного)`}</small> : null}
        </p>
      )}
    </Block>
  );
}

function LsCompare({ me }: { me: Obj }) {
  const S = me.settings as Obj, of = me.employee.offerInfo as Obj, lad = (S.kpi?.ladder ?? []) as Array<[number, number]>;
  const R: Array<[string, string, string]> = [
    ["Ставка «Старт»", money(S.start.rate), money(of.startRate ?? S.start.rate)],
    ["План «Старту»", "з «Планів», ставить керівник", `${nf(of.startPlan ?? 0)} ₴ — фіксований`],
    ["Відсоток «Старт»", `${S.start.pctLow} / ${S.start.pctHigh} %`, `${S.start.pctLow} / ${S.start.pctHigh} %`],
    ["Бонус за КПІ", lad.length ? `${nf(lad[0][1])}–${nf(lad[lad.length - 1][1])} ₴` : "—", of.kpi === false ? "немає" : "як у стандартному"],
    ["Клієнти на «Старті»", "реклама", "постійні клієнти компанії, холодна база, лідогенерація"],
    ["Перехід на «Профі»", "за вибором менеджера або керівництва", `автоматично: 2 місяці поспіль понад ${nf(of.autoProfiFrom ?? 0)} ₴`],
    ["Клієнти на «Профі»", "лідгени", "власна база й таблиця реактивації"],
    ["Відсоток «Профі»", `${S.profi.pct1} / ${S.profi.pct2} / ${S.profi.pct3} %`, `${S.profi.pct1} / ${S.profi.pct2} / ${S.profi.pct3} %`],
  ];
  return (
    <Block title="Ваша система — команда Лілії Шаврової">
      <div className="zp-table-wrap">
        <table className="zp-table zc-cmp">
          <thead><tr><th /><th>Стандартний офер</th><th className="zc-you">Ваш офер</th></tr></thead>
          <tbody>{R.map((r) => <tr key={r[0]} className={r[1] === r[2] ? "is-same" : ""}><th scope="row">{r[0]}</th><td>{r[1]}</td><td className="zc-you">{r[2]}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="zp-hint">Аванс, ТТН, дні народження, виплата до {S.payByDay}-го й обхідний лист — однакові для всіх.</p>
    </Block>
  );
}

function LevelBlock({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const S = me.settings as Obj, e = me.employee as Obj, lv = me.live as Obj | null, c = lv?.calc as Obj | undefined;
  const mk = (lv?.month ?? me.liveMonth) as string, nx = nextMonth(mk), ls = e.offer === "ls", level = e.level as string | null;
  const ln = e.levelChange as Obj | null;
  const doc = ((me.offers ?? []) as Obj[]).find((d) => !d.voidAt && d.level === "profi");
  const lr = me.levelRequest as Obj | null;   // заявка на «Профі» (В1, 27.11.2026): рішення за керівництвом
  async function choose() {
    setBusy(true);
    try { await payrollApi.chooseProfi(); toast("Заявку на «Профі» подано. Рішення — за керівництвом, вам прийде сповіщення."); setAsk(false); await onChanged(); }
    catch (x) { toast(errText(x), { error: true }); }
    finally { setBusy(false); }
  }
  let body;
  const profiRule = `${S.profi.pct1} % — маржа до ${nf(S.profi.threshold)} ₴, ${S.profi.pct2} % — від ${nf(S.profi.threshold)} ₴, ${S.profi.pct3} % — виконано план керівника. Без ставки — і назад на «Старт» не повертаємось.`;
  if (ls) {
    const A = Number(e.offerInfo?.autoProfiFrom ?? 0), pm = prevMonth(mk);
    if (level === "profi") body = <p className="zc-p">{profiRule}</p>;
    else {
      const mPrev = (lv?.autoProfi ?? null) as number | null, okPrev = mPrev !== null && mPrev > A, okNow = !!c && c.margin > A;
      const row = (m: string, v: number | null, ok: boolean, live: boolean) => (
        <li key={m}><span>{monthName(m)}{live ? " · зараз" : ""}</span><b className="zp-num">{v === null ? "—" : money(v)}</b>
          {ok ? <Pill tone="ok">понад {nf(A)}</Pill> : <Pill>{v === null ? "немає даних" : live ? `ще ${money(Math.max(0, A - v))}` : `менше ${nf(A)}`}</Pill>}</li>
      );
      const msg = okPrev && okNow ? <><b>Обидва місяці понад {nf(A)} ₴</b> — якщо {monthLow(mk)} так і закриється, з 1 {monthGen(nx)} «Профі» автоматично.</>
        : okPrev ? <>Ще <b>{money(Math.max(0, A - (c?.margin ?? 0)))}</b> маржі цього місяця — і з 1 {monthGen(nx)} «Профі» автоматично.</>
          : okNow ? <>{monthName(mk)} — перший місяць понад {nf(A)} ₴. Ще один такий — і «Профі».</> : <>Потрібно два місяці поспіль із маржею понад {nf(A)} ₴.</>;
      body = (
        <>
          <p className="zc-p">Перехід — автоматичний: маржа понад {nf(A)} ₴ два місяці поспіль → «Профі» з наступного місяця й назавжди. Заява не потрібна, офер той самий.</p>
          <ul className="zc-hist">{row(pm, mPrev, okPrev, false)}{row(mk, c?.margin ?? null, okNow, true)}</ul>
          <p className={`zp-note ${okPrev && okNow ? "zp-note--ok" : ""}`}>{msg}</p>
        </>
      );
    }
  } else if (level === "profi") body = <p className="zc-p">{profiRule}</p>;
  else if (ln && ln.from > mk) {
    body = (
      <>
        <p className="zp-note zp-note--ok"><b>З 1 {monthGen(ln.from)} — {levelName(ln.level)}.</b> Цього місяця діє «Старт».{me.levelChangeInfo ? <> Рішення: {levelWho(me.levelChangeInfo as Obj)}.</> : null}</p>
        {doc && <p className={`zp-note ${doc.signedAt ? "zp-note--ok" : "zp-note--warn"}`}>{doc.signedAt ? <b>Новий офер «Профі» підписано {dd(doc.signedAt)}.</b> : <><b>Новий офер «Профі» — у ваших документах.</b> Рекрутер зв’яжеться для підпису.</>}</p>}
      </>
    );
  } else {
    const mP = Number(c?.marginPlan ?? 0), prof = mP >= S.profi.threshold ? S.profi.pct2 : S.profi.pct1;
    body = (
      <>
        <p className="zc-p">«Профі» — без ставки й бонусу, зате {S.profi.pct1}–{S.profi.pct3} % від маржі і дохід без стелі. Перейти можна з наступного місяця: ви подаєте заявку, рішення за керівництвом; назад не повертаємось.</p>
        {c && <p className="zp-hint">При виконанні плану (маржа {money(mP)}) на «Профі» було б {pc(prof)} = <b>{money(mP * prof / 100)}</b>; на «Старті» — {money(c.atPlan.total - c.atPlan.birthday)}. {S.profi.pct3} % — з індивідуальним планом керівника.</p>}
        {ask ? (
          <div className="zp-note zp-note--warn">
            <b>Подати заявку на «Профі» з 1 {monthGen(nx)}?</b> Рішення приймає керівництво. Якщо погодять: ставки не буде, відсоток {S.profi.pct1}–{S.profi.pct3} %, назад на «Старт» не повертаємось, новий офер з’явиться у ваших документах.
            <div className="zp-row" style={{ marginTop: 8 }}>
              <button type="button" className="zp-btn zp-btn--dark" disabled={busy} onClick={() => void choose()}>Подати заявку</button>
              <button type="button" className="zp-btn" disabled={busy} onClick={() => setAsk(false)}>Ні, лишаюсь на «Старті»</button>
            </div>
          </div>
        ) : lr && !lr.decidedAt ? <p className="zp-note"><b>Заявку на «Профі» подано {dd(lr.requestedAt)}.</b> Чекає рішення керівництва, вам прийде сповіщення.</p>
          : <>
            {lr?.decision === "rejected" && <p className="zp-note zp-note--warn">Заявку на «Профі» відхилено {dd(lr.decidedAt)}.{lr.note ? ` Коментар: ${lr.note}` : ""}</p>}
            <div className="zp-row"><button type="button" className="zp-btn" onClick={() => setAsk(true)}>Подати заявку на «Профі» з 1 {monthGen(nx)}</button></div>
          </>}
      </>
    );
  }
  return <Block title={`Рівень ${levelName(level)}`} aside={ls ? <Pill tone="info">офер команди Лілії</Pill> : undefined}>{body}</Block>;
}

function RulesBlock({ me }: { me: Obj }) {
  const S = me.settings as Obj, e = me.employee as Obj, o = e.official as Obj | null;
  const comp = e.role === "lead" ? S.birthday.lead : S.birthday.company;
  const advRule = e.role === "manager" ? `до ${S.advance.managerPct} % маржі «Успішно реалізовано»` : e.role === "lead" ? `до ${S.advance.leadPct} % вашої маржі` : `до ${S.advance.staffPct} % ставки`;
  const R: Array<[string, string] | null> = [
    ["Аванс", `з ${S.advance.fromDay} числа, ${advRule}, не більше нарахованого; на одну чи кілька карт або готівкою. Вираховується при закритті місяця.`],
    e.role === "manager" ? ["ТТН", `якщо в закритому місяці ТТН є менш ніж у ${S.ttn.minPct} % угод — ${money(S.ttn.hold)} утримуємо з виплати. Закрили ТТН до виплати — сума в цій виплаті; після виплати — у наступному місяці.`] : null,
    e.role === "manager" ? ["Оплата клієнта", S.payMode === "success" ? "маржа йде в ЗП місяця, коли угода перейшла в «Успішно реалізовано» — борг клієнта на ЗП не впливає." : S.payMode === "paid" ? "маржа йде в ЗП, лише коли клієнт оплатив угоду." : "маржа йде в ЗП місяця «Успішно реалізовано», крім угод із простроченою оплатою."] : null,
    bdayV2(S, me.live?.month)
      ? ["Дні народження", `щомісяця з кожного — ${nf(S.birthday.each)} ₴ у фонд днів народження, автоматично, скільки б не було іменинників. У ваш — ${nf(S.birthday.perMonth)} ₴ × повні місяці стажу (від року — ${nf(12 * S.birthday.perMonth)} ₴) + ${nf(comp)} ₴ від компанії, нараховуємо самі.`]
      : ["Дні народження", `з кожного — ${nf(S.birthday.each)} ₴ на колегу, автоматично, просто фіксуємо в розрахунку. У ваш — збір колег + ${nf(comp)} ₴ від компанії, нараховуємо самі; стаж до року — ${nf(S.birthday.perMonth)} ₴ × місяці + ${nf(comp)} ₴ від компанії, без збору.`],
    ["Офіційна ЗП", o ? `${money(o.amount)} щомісяця — ${o.deduct ? "вираховується з загальної ЗП: решту отримуєте готівкою або на карту" : "окремо, понад загальну ЗП"}.` : "немає."],
    ["Перевірка й виплата", `фінансист перевіряє до ${S.verifyByDay}-го — ви бачите розрахунковий лист і погоджуєте або пишете, з чим не згодні; далі форма на виплату, виплата до ${S.payByDay}-го.`],
    ["Звільнення", "попередити за 2 тижні. Обхідний лист обов’язковий: бухгалтерія, бізнес-асистент, керівник відділу продажу або ОД. Розрахунок — лише після всіх підписів."],
  ];
  return (
    <Block title="Правила" sub="однакові для всіх">
      <dl className="zc-rules">{R.filter((r): r is [string, string] => !!r).map((r) => <div key={r[0]}><dt>{r[0]}</dt><dd>{r[1]}</dd></div>)}</dl>
    </Block>
  );
}

function DocsBlock({ me }: { me: Obj }) {
  const ds = ((me.offers ?? []) as Obj[]).filter((d) => !d.voidAt).sort((a, b) => String(b.from).localeCompare(String(a.from)));
  if (!ds.length) return null;
  return (
    <Block title="Мої документи">
      <ul className="zc-hist">
        {ds.map((d, i) => (
          <li key={i}>
            <span><b>{d.title ?? OFFER_T[d.level] ?? "Офер"}</b><small>з {ddy(String(d.from).slice(0, 10))}</small></span>
            {d.signedAt ? <Pill tone="ok">підписано {dd(d.signedAt)}</Pill> : <Pill tone="warn">очікує підпису</Pill>}
          </li>
        ))}
      </ul>
      <p className="zp-hint">Підписаний офер зберігає рекрутер; нову версію він принесе на підпис сам.</p>
    </Block>
  );
}

export default function Terms({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> }) {
  const e = me.employee as Obj;
  return (
    <div className="zp-grid zp-grid--2">
      <div className="zc-col">
        <OfferBlock me={me} />
        {e.offer === "ls" && e.role === "manager" && <LsCompare me={me} />}
        {e.role === "manager" && <LevelBlock me={me} onChanged={onChanged} />}
      </div>
      <div className="zc-col">
        <RulesBlock me={me} />
        <DocsBlock me={me} />
      </div>
    </div>
  );
}
