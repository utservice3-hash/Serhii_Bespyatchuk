/**
 * Вкладка «Ціль» — лише менеджер з продажу (макет `c03-goal.js`): бажана сума → маржа → постійні клієнти (з історії або вручну)
 * + нові → авто → звернення; «Старт» / «Профі». Розрахунок — рушій на сервері (`/payroll/me/goal`): перший виклик без цілі
 * віддає підстановки (ціль, конверсія, середній чек, історія клієнтів), далі — `goalRun` на кожну зміну (з затримкою).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Loading, Pill, money, useLoad } from "../ui";
import { Block } from "./Block";
import { monthLow, monthShort, nf, pc, plural } from "./format";

type Mode = "hist" | "manual";
interface St { level: "start" | "profi"; target: number; conv: number; avgCheck: number; calls: boolean; mode: Mode; manual: number; sel: Set<string>; exp: Record<string, number> }

const toNum = (s: string) => { const n = Number(String(s).replace(/[\s ₴%]/g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const n1 = (x: number) => String(Math.round(x * 10) / 10).replace(".", ",");
const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function fromDefaults(d: Obj): St {
  const D = d.defaults as Obj;
  return { level: D.level === "profi" ? "profi" : "start", target: D.target, conv: D.conv, avgCheck: D.avgCheck, calls: true, mode: "hist", manual: 0,
    sel: new Set<string>(D.regular?.selected ?? []), exp: { ...(D.regular?.expected ?? {}) } };
}

export default function Goal({ me }: { me: Obj }) {
  const { data: defs, err, reload } = useLoad(() => payrollApi.myGoal({}), []);
  // поля калькулятора: поки людина нічого не міняла — підстановки з її даних
  const [over, setSt] = useState<St | null>(null);
  const base = useMemo(() => (defs ? fromDefaults(defs) : null), [defs]);
  const st = over ?? base;
  const [res, setRes] = useState<{ main: Obj | null; alt: Obj | null; nextConv: Obj | null; withCalls: Obj | null; err: string | null } | null>(null);
  const seq = useRef(0);

  const S = me.settings as Obj, lv = me.live as Obj | null, e = me.employee as Obj;
  const c = lv?.calc as Obj | undefined;
  const regAllowed = st ? !!defs?.regularAllowed?.[st.level] : false;
  const regSum = useMemo(() => (!st ? 0 : st.mode === "manual" ? st.manual : [...st.sel].reduce((s, k) => s + (st.exp[k] || 0), 0)), [st]);
  const kpiOn = !!st && st.level === "start" && !!e.hasKpi;
  const ladder = (S.kpi?.ladder ?? []) as Array<[number, number]>;

  const invalid = !st ? null : !(st.target > 0) ? "Вкажіть бажану суму." : !(st.conv > 0 && st.conv <= 100) ? "Конверсія — від 0,1 до 100 %." : !(st.avgCheck > 0) ? "Середній чек має бути більший за 0 ₴." : null;
  useEffect(() => {
    if (!st || invalid) return;
    const my = ++seq.current;
    const q = (o: Partial<{ level: string; conv: number; calls: boolean; regular: number }> = {}) => {
      const level = o.level ?? st.level, calls = level === "start" && e.hasKpi ? (o.calls ?? st.calls) : true;
      return payrollApi.myGoal({ level, target: st.target, conv: o.conv ?? st.conv, avgCheck: st.avgCheck, calls: String(calls), regular: o.regular ?? (regAllowed ? regSum : 0) });
    };
    const t = setTimeout(async () => {
      try {
        const other = st.level === "start" ? "profi" : "start";
        const nx = kpiOn ? ladder.find((s) => s[0] > st.conv) : null;
        const [main, alt, nextConv, withCalls] = await Promise.all([
          q(),
          c?.level === "start" ? q({ level: other, regular: defs?.regularAllowed?.[other] ? regSum : 0 }) : Promise.resolve(null),
          nx ? q({ conv: nx[0] }) : Promise.resolve(null),
          kpiOn && !st.calls ? q({ calls: true }) : Promise.resolve(null),
        ]);
        if (my === seq.current) setRes({ main, alt, nextConv, withCalls, err: null });
      } catch (x) { if (my === seq.current) setRes({ main: null, alt: null, nextConv: null, withCalls: null, err: errText(x) }); }
    }, 300);
    return () => clearTimeout(t);
  }, [st, regSum, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!defs || !st) return <Loading err={err} onRetry={reload} />;
  if (!lv || !c) return <Block title="Ціль"><p className="zp-note">Калькулятор працює для місяця, в якому ви працюєте.</p></Block>;
  const D = defs.defaults as Obj, src = D.source as Obj;
  const SRC = (defs.sources?.[st.level] ?? {}) as Obj;
  const mk = lv.month as string, full = c.days.full as number;
  const mx = Math.max(50000, Math.ceil(c.atPlan.total * 2.5 / 5000) * 5000);
  const set = (p: Partial<St>) => setSt({ ...st, ...p });
  const span = (src.months ?? []).length > 1 ? `${monthShort(src.months[0])} + ${monthShort(src.months[1])}` : monthLow(mk);
  const H = (D.regular?.history ?? { months: [], rows: [] }) as Obj;
  const ls = e.offer === "ls";
  const planShown = st.level === "start" ? `план ${money(res?.main?.plan ?? c.plan)}${ls ? " — за офером" : " — з «Планів»"}` : defs.regularAllowed?.profi ? "«Профі»: власна база й таблиця реактивації" : "«Профі» — лише лідгени";
  const needDays = Math.max(0, full - (S.kpi?.missDaysAllowed ?? 2));

  const R = res?.main;
  const pctNote = !R || R.margin == null ? "" : st.level === "start"
    ? (R.plan >= S.start.minPlanForHigh && R.margin >= R.plan ? `план ${nf(R.plan)} виконано → ${S.start.pctHigh} %` : `план ${nf(R.plan)} не виконано → ${S.start.pctLow} %`)
    : R.plan && R.margin >= R.plan ? `план керівника ${nf(R.plan)} → ${S.profi.pct3} %` : R.margin >= S.profi.threshold ? `від ${nf(S.profi.threshold)} → ${S.profi.pct2} %` : `до ${nf(S.profi.threshold)} → ${S.profi.pct1} %`;
  const counted = ((c.deals ?? []) as Obj[]).filter((d) => d.counts && String(d.date) <= String(me.today));
  const earned = c.now.total - c.now.birthday;
  const tips: string[] = [];
  if (R && R.margin != null) {
    const nx = kpiOn ? ladder.find((s) => s[0] > st.conv) : null;
    const A = res?.nextConv;
    if (nx && A && A.margin != null && (A.margin < R.margin || A.leads < R.leads)) tips.push(`Конверсія ${nx[0]} % → бонус ${money(nx[1])}: досить ${money(A.margin)} маржі — ${A.cars} авто, ${A.leads} звернень.`);
    const W = res?.withCalls;
    if (W && R.step && W.margin != null && W.margin < R.margin) tips.push(`З нормою дзвінків — бонус ${money(R.step[1])}: досить ${money(W.margin)} маржі — ${W.cars} авто.`);
    const O = res?.alt;
    if (O) tips.push(O.margin == null ? `На «${st.level === "start" ? "Профі" : "Старті"}» цю суму не набрати.` : `На «${st.level === "start" ? "Профі" : "Старті"}» ця сума — від ${money(O.margin)} маржі: ${O.cars} авто${st.level === "start" && !defs.regularAllowed?.profi ? " (лише лідгени)" : ""}${st.level === "start" ? `; без індивідуального плану керівника — ${S.profi.pct1} / ${S.profi.pct2} %` : ""}.`);
  }

  return (
    <div className="zp-grid zp-grid--2">
      <div className="zc-col">
        <Block id="calc" title={`Моя ціль на ${monthLow(mk)}`} sub={ls ? "за офером команди Лілії Шаврової" : "«Старт» — реклама, «Профі» — лідгени"}>
          <div className="zc-goal-in">
            <label htmlFor="zcT" className="zp-k">Хочу заробити за місяць</label>
            <div className="zc-goal-tgt"><input id="zcT" className="zp-input zp-input--num" inputMode="numeric" value={st.target ? nf(st.target) : ""} onChange={(x) => set({ target: toNum(x.target.value) })} /><span>₴</span></div>
            <input type="range" min={5000} max={mx} step={500} value={Math.max(5000, Math.min(mx, st.target))} onChange={(x) => set({ target: Number(x.target.value) })} aria-label="Бажана сума" />
            <div className="zc-goal-scale" aria-hidden="true"><span>5 000 ₴</span><span>{nf(mx / 2)} ₴</span><span>{nf(mx)} ₴</span></div>
          </div>
          <div className="zc-goal-fields">
            <div className="zp-field"><span>Рівень</span>
              <div className="zc-seg" role="group" aria-label="Рівень">
                {(["start", "profi"] as const).map((l) => (
                  <button key={l} type="button" aria-pressed={st.level === l} disabled={c.level === "profi" && l === "start"} title={c.level === "profi" && l === "start" ? "З «Профі» на «Старт» не повертаємось" : undefined} onClick={() => set({ level: l })}>{l === "start" ? "Старт" : "Профі"}</button>
                ))}
              </div>
              <small className="zp-hint">{planShown}</small>
            </div>
            <label className="zp-field"><span>Конверсія, %</span>
              <input className="zp-input zp-input--num" inputMode="decimal" value={n1(st.conv)} onChange={(x) => set({ conv: toNum(x.target.value) })} />
              <small className="zp-hint">{SRC.short ?? ""} · ваша: {src.targetDeals} з {src.leads} цільових звернень, {span}</small>
            </label>
            <label className="zp-field"><span>Середній чек, ₴</span>
              <input className="zp-input zp-input--num" inputMode="numeric" value={st.avgCheck ? String(st.avgCheck) : ""} onChange={(x) => set({ avgCheck: toNum(x.target.value) })} />
              <small className="zp-hint">маржа з авто · ваш: {money(src.margin)} ÷ {src.cars} авто, {span}</small>
            </label>
          </div>
          {kpiOn && <label className="zp-check"><input type="checkbox" checked={st.calls} onChange={(x) => set({ calls: x.target.checked })} /><span>Норму дзвінків виконаю — {S.kpi.normCalls}+ щонайменше {needDays} з {full} робочих днів</span></label>}
          {ls && <p className="zp-hint">Офер команди Лілії Шаврової: бонусу за КПІ немає; «Профі» — автоматично після двох місяців поспіль понад {nf(e.offerInfo?.autoProfiFrom ?? 0)} ₴.</p>}
          {regAllowed && (
            <div className="zc-reg">
              <div className="zc-reg__h">
                <span className="zp-k">{cap1(String(SRC.regular ?? "постійні клієнти"))}</span>
                <div className="zc-seg" role="group" aria-label="Як рахувати постійних">
                  <button type="button" aria-pressed={st.mode === "hist"} onClick={() => set({ mode: "hist" })}>З історії</button>
                  <button type="button" aria-pressed={st.mode === "manual"} onClick={() => set({ mode: "manual" })}>Вручну</button>
                </div>
              </div>
              {st.mode === "manual" ? (
                <label className="zp-field"><span>Приносять маржі на місяць, ₴</span><input className="zp-input zp-input--num" inputMode="numeric" value={st.manual ? String(st.manual) : ""} placeholder="напр. 20000" onChange={(x) => set({ manual: toNum(x.target.value) })} /></label>
              ) : !(H.rows ?? []).length ? <p className="zp-hint">Історії клієнтів ще немає — вкажіть суму вручну.</p> : (
                <>
                  <ul className="zc-reg__list">
                    {(H.rows as Obj[]).map((r) => {
                      const on = st.sel.has(r.client);
                      return (
                        <li key={r.client} className={on ? "is-on" : ""}>
                          <label className="zp-check"><input type="checkbox" checked={on} onChange={() => { const s = new Set(st.sel); if (on) s.delete(r.client); else s.add(r.client); set({ sel: s }); }} /><span>{r.client}{r.n >= 2 && <> <Pill tone="info">постійний</Pill></>}</span></label>
                          <span className="zp-hint zp-num">{(r.a as number[]).map((v, j) => `${monthShort(H.months[j])} ${v ? nf(v) : "—"}`).join(" · ")} · сер. {nf(r.avg)}</span>
                          <label className="zc-reg__ex"><span>очікую</span><input className="zp-input zp-input--num" inputMode="numeric" disabled={!on} value={st.exp[r.client] ? String(st.exp[r.client]) : "0"} aria-label={`Очікую від ${r.client}, ₴`} onChange={(x) => set({ exp: { ...st.exp, [r.client]: toNum(x.target.value) } })} /><span>₴</span></label>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="zc-total"><span>Разом від постійних на місяць</span><b className="zp-num">{money(regSum)}</b></div>
                  <p className="zp-hint">«Постійний» — угоди щонайменше у 2 з 3 останніх місяців; позначити можна будь-кого з історії.</p>
                </>
              )}
            </div>
          )}
          <div className="zp-row">
            <button type="button" className="zp-btn" onClick={() => setSt(fromDefaults(defs))}>Підставити мої дані</button>
            <span className="zp-hint">Конверсія — з КПІ, середній чек — маржа ÷ авто, постійні — з історії угод. Дні народження, аванс і офіційна ЗП сюди не входять.</span>
          </div>
        </Block>
      </div>
      <div className="zc-col">
        <Block title="Що для цього потрібно">
          <div aria-live="polite">
            {invalid ? <p className="zp-err">{invalid}</p> : !res ? <div className="zp-loading">Рахуємо…</div> : res.err ? <p className="zp-err">{res.err}</p> : !R || R.margin == null ? <p className="zp-err">Цю суму на цьому рівні не набрати.</p> : (
              <>
                <div className={`zc-flow ${regAllowed ? "" : "zc-flow--3"}`}>
                  <div><span className="zp-k">Маржа разом</span><b className="zp-num">{money(R.margin)}</b><small>{pctNote}</small></div>
                  {regAllowed && <div><span className="zp-k">{cap1(String(SRC.regular ?? "постійні"))}</span><b className="zp-num">{money(R.fromRegular)}</b><small>{st.mode === "manual" ? "вказано вручну" : `${st.sel.size} ${plural(st.sel.size, "клієнт", "клієнти", "клієнтів")} з історії`}{regSum > R.margin ? " · більше, ніж потрібно" : ""}</small></div>}
                  <div><span className="zp-k">{SRC.cars ?? "Авто"}</span><b className="zp-num">{nf(R.cars)}</b><small>~{n1(R.cars / full)} на день · чек {money(st.avgCheck)}</small></div>
                  <div className="zc-flow__hot"><span className="zp-k">{SRC.leads ?? "Звернення"}</span><b className="zp-num">{nf(R.leads)}</b><small>~{n1(R.leads / full)} на день · конверсія {pc(st.conv)}</small></div>
                </div>
                <ul className="zc-slip">
                  {st.level === "start" && <li><span>Ставка «Старт»{ls ? " · офер Лілії" : ""}</span><b className="zp-num">{money(R.salary.rate)}</b></li>}
                  <li><span>{pc(R.salary.pct)} від маржі {money(R.margin)}{regAllowed && R.fromRegular ? ` (постійні ${money(R.fromRegular)} + ${SRC.short ?? "нові"} ${money(R.fromNew)})` : ""}</span><b className="zp-num">{money(R.margin * R.salary.pct / 100)}</b></li>
                  {kpiOn && <li><span>Бонус за КПІ · {R.step ? `сходинка ${R.step[0]} %${R.salary.bonus ? (!st.calls ? ` · маржа від ${nf(S.kpi.waiveFrom)} — без дзвінків` : "") : " · без норми дзвінків — 0"}` : `конверсія нижче ${ladder[0]?.[0]} %`}</span><b className="zp-num">{money(R.salary.bonus)}</b></li>}
                  <li className="zc-slip__tt"><span>Зарплата</span><b className="zp-num">{money(R.salary.total)}</b></li>
                </ul>
                {earned >= st.target
                  ? <p className="zp-note zp-note--ok"><b>Цю суму вже заробили</b> — зараз нараховано {money(earned)}.</p>
                  : <p className="zp-note">Цього місяця вже: <b>{counted.length} авто</b>, {money(c.margin)} маржі{c.kpi?.leads ? `, ${c.kpi.leads} ${plural(c.kpi.leads, "цільове звернення", "цільові звернення", "цільових звернень")}` : ""}. До цілі — ще ~<b>{money(Math.max(0, R.margin - c.margin))}</b> маржі.</p>}
                {tips.length > 0 && <div className="zc-tips"><span className="zp-k">Як дійти легше</span><ul>{tips.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
              </>
            )}
          </div>
        </Block>
      </div>
    </div>
  );
}
