/**
 * 💰 «Нарахування» — усі за місяць (ТЗ §7.1; макет v6 `accruals`). Поточний місяць — «зараз / при виконанні плану»
 * (орієнтовно), закритий — орієнтовно → перевірено → до виплати зі станом листа. Клік по рядку закритого місяця —
 * вікно працівника у «Перевірці». Тім-ліду / працівнику ця вкладка не показується (право `payroll_view_all`).
 */
import { useMemo, useState } from "react";
import { payrollApi, type Obj } from "../api";
import type { PayrollCtx } from "../PayrollSection";
import { Card, Empty, Loading, Stat, StatusPill, money, num, pct, useLoad, Tabs } from "../ui";
import { AdvCell, MonthSwitch, TtnCell } from "./common";
import { dayGen, monthGen, shortRole, signed, signTone } from "./fmt";
import { accrualGroups, type AccrualGroup } from "./accrualGroups";

const FILTERS: Array<[string, string]> = [["all", "Усі"], ["review", "На перевірці"], ["verified", "Чекають згоди"], ["disputed", "Не погоджуються"], ["agreed", "Чекаємо форму"], ["submitted", "Подано"], ["paid", "Виплачено"]];

export default function AccrualsTab({ ctx }: { ctx: PayrollCtx }) {
  const months = [ctx.closedMonth, ctx.liveMonth].filter(Boolean) as string[];
  const [mk, setMk] = useState<string>(months[0]);
  const live = mk === ctx.liveMonth;
  const { data, err, reload } = useLoad<Obj[]>(() => payrollApi.accruals(mk), [mk]);
  const { data: st } = useLoad<Obj | null>(() => payrollApi.settings(mk).catch(() => null), [mk]);
  const { data: q } = useLoad<Obj | null>(() => (live ? Promise.resolve(null) : payrollApi.queue(mk).catch(() => null)), [mk, live]);
  const [filter, setFilter] = useState("all");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setShut((x) => { const n = new Set(x); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const S = st?.settings as Obj | undefined;
  const rows = useMemo(() => (data ?? []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "uk")), [data]);

  if (!data) return <Loading err={err} onRetry={reload} />;

  const fundNow = rows.reduce((s, x) => s + Number(x.calc?.now?.total ?? 0), 0);
  const fundPlan = rows.reduce((s, x) => s + Number(x.calc?.atPlan?.total ?? 0), 0);
  const mgrs = rows.filter((x) => x.role === "manager");
  const cm = mgrs.reduce((s, x) => s + Number(x.calc?.margin ?? 0), 0), cp = mgrs.reduce((s, x) => s + Number(x.calc?.plan ?? 0), 0);
  const advs = rows.map((x) => x.advance).filter(Boolean) as Obj[];
  const advPaid = advs.filter((a) => a.status === "paid").reduce((s, a) => s + Number(a.amount), 0);
  const n = (s: string) => rows.filter((x) => x.record?.status === s).length;
  const list = live || filter === "all" ? rows : rows.filter((x) => x.record?.status === filter);
  const next = (m: string) => { const [y, mm] = m.split("-").map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`; };
  const qById = new Map(((q?.rows ?? []) as Obj[]).map((x) => [x.userId, x]));
  const mP = Math.max(cm, cp);

  return (
    <>
      <div className="zf-toolbar">
        <MonthSwitch months={months} value={mk} onChange={(m) => { setMk(m); setFilter("all"); }} live={ctx.liveMonth} />
        <span className="zp-grow" />
        {live ? <span className="zp-note zp-note--warn" style={{ padding: "4px 10px" }}>Місяць іде — дані орієнтовні</span>
          : <span className="zp-hint">Клік по рядку — вікно перевірки працівника</span>}
      </div>

      <div className="zp-grid zp-grid--stats">
        {live ? (
          <>
            <Stat label="Фонд ЗП зараз" value={money(fundNow)} sub="за угодами на сьогодні" />
            <Stat label="Фонд ЗП при виконанні плану" value={money(fundPlan)} sub={`коли маржа = план ${money(cp)}`} />
            <Stat label="Маржа менеджерів" value={money(cm)} sub={cp ? `${pct(cm / cp * 100)} плану` : "плану немає"} />
            <Stat label="ФЗП / маржа" value={mP ? pct(fundPlan / mP * 100) : "—"} sub="при виконанні плану" />
            <Stat label="Аванси" value={money(advPaid)} sub={advs.length ? `виплачено · заявок ${advs.length}` : `заявки з ${S?.advance?.fromDay ?? 25} ${monthGen(mk)}`} />
          </>
        ) : (
          <>
            <Stat label="Фонд ЗП" value={money(q?.fund ?? rows.reduce((s, x) => s + Number(x.record?.total ?? 0), 0))} sub={`орієнтовно було ${money(q?.autoFund ?? fundNow)}`} />
            <Stat label="До виплати" value={money(rows.reduce((s, x) => s + Number(x.record?.pay ?? 0), 0))} sub={`аванси −${money(advPaid)}`} />
            <Stat label="Перевірено" value={`${rows.filter((x) => x.record && x.record.status !== "review").length} з ${rows.length}`} sub={`до ${dayGen(`${next(mk)}-${String(S?.verifyByDay ?? 6).padStart(2, "0")}`)}`} />
            <Stat label="Погоджено / подано" value={`${n("agreed") + n("submitted") + n("paid")} / ${n("submitted") + n("paid")}`} sub={n("disputed") ? `не погоджуються: ${n("disputed")}` : "спорів немає"} tone={n("disputed") ? "danger" : undefined} />
            <Stat label="Виплачено" value={`${n("paid")} з ${rows.length}`} sub={`до ${dayGen(`${next(mk)}-${String(S?.payByDay ?? 8).padStart(2, "0")}`)}`} />
          </>
        )}
      </div>

      <Card pad={false}>
        {!live && (
          <div style={{ padding: "14px 16px 0" }} className="zf-filter">
            <Tabs small items={FILTERS.map(([k, l]) => ({ key: k, label: <>{l} <span className="zp-muted">{k === "all" ? rows.length : n(k)}</span></> }))} value={filter} onChange={setFilter} />
          </div>
        )}
        <AccrualsRule S={S} />
        <div className="zp-table-wrap" style={{ padding: "0 4px 4px" }}>
          {!list.length ? <div style={{ padding: 16 }}><Empty>{rows.length ? "За цим фільтром нікого." : "У зарплаті за цей місяць нікого немає — людей і умови додає фінансист у «Налаштуваннях»."}</Empty></div> : (
            <table className="zp-table zf-table zf-acc">
              <thead>
                <tr className="zf-acc__grp">
                  <th />
                  <th colSpan={2} className="zf-acc__sep"><span>Маржа</span></th>
                  <th colSpan={3} className="zf-acc__sep zf-acc__pct"><span>Відсоток</span></th>
                  <th colSpan={live ? 5 : 5} className="zf-acc__sep"><span>Нарахування за місяць</span></th>
                  <th colSpan={live ? 3 : 5} className="zf-acc__sep"><span>{live ? "Утримання й виплати" : "Утримання, виплата, стан"}</span></th>
                </tr>
                <tr className="zf-acc__col">
                  <th>Працівник</th>
                  <th className="r zf-acc__sep">Власна</th><th className="r">Команди</th>
                  <th className="zf-acc__sep zf-acc__pz">Від чого</th><th className="r zf-acc__pz">Ставка %</th><th className="r zf-acc__pz">Сума %</th>
                  <th className="r zf-acc__sep">Оклад</th><th className="r"><i className="zf-acc__op">+</i>Бонус</th><th className="r"><i className="zf-acc__op">±</i>ДН</th>
                  {live ? <><th className="r"><i className="zf-acc__op">=</i>Зараз</th><th className="r">При плані</th></>
                    : <><th className="r"><i className="zf-acc__op">=</i>Орієнтовно</th><th className="r">Перевірено</th></>}
                  <th className="r zf-acc__sep">Аванс</th><th className="r">Офіційна ЗП</th><th className="r">ТТН</th>
                  {!live && <><th className="r">До виплати</th><th>Стан</th></>}
                </tr>
              </thead>
              <tbody>
                {accrualGroups(list).map((g) => {
                  const open = !shut.has(g.key);
                  return [
                    g.kind === "team" ? (
                      <tr key={`g-${g.key}`} className="zf-acc__band" onClick={() => toggle(g.key)} aria-expanded={open}>
                        <td colSpan={live ? 14 : 16}><TeamBand g={g} live={live} open={open} /></td>
                      </tr>
                    ) : (
                      <tr key={`g-${g.key}`} className="zf-acc__other"><td colSpan={live ? 14 : 16}>Поза командами продажу</td></tr>
                    ),
                    ...(open ? g.rows.map((x) => <AccrualRow key={x.userId} x={x} live={live} S={S} q={qById.get(x.userId)} member={g.kind === "team" && x.role !== "lead"} onOpen={live ? undefined : () => ctx.go("verify", { userId: x.userId })} />) : []),
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="zp-hint" style={{ padding: "0 16px 14px" }}>
          ТТН — {live ? `частка угод з ТТН зараз (на закриття потрібно від ${S?.ttn?.minPct ?? 70} %)` : `утримання ${money(S?.ttn?.hold ?? 3000)} до закриття ТТН або повернення за минулий місяць`}.
          ДН — дні народження за правилом ({S?.birthday?.v2From ? <>з {String(S.birthday.v2From).slice(5, 7)}.{String(S.birthday.v2From).slice(0, 4)} — −{num(S?.birthday?.each ?? 100)} ₴ щомісяця у фонд з кожного, іменинникові — стаж і подарунок компанії</> : <>−{num(S?.birthday?.each ?? 100)} ₴ за колегу, іменинникові — збір і подарунок компанії</>}). Аванс — заявка цього місяця.
        </div>
      </Card>
    </>
  );
}

// ---------- таблиця: команда → тімлід першим → менеджери; поза командами — окремо (макет 27.11.2026, «роби» Романа) ----------
/** Ставка лише окладом: відсотка від маржі немає */
const flat = (x: Obj) => x.role === "staff" && !x.calc?.pctRule;
function AccrualsRule({ S }: { S?: Obj }) {
  const st = (S?.start ?? {}) as Obj, pr = (S?.profi ?? {}) as Obj, ld = (S?.lead ?? {}) as Obj;
  return (
    <div className="zf-acc__rule">
      <p><span className="zf-acc__chip zf-acc__chip--own">власна маржа</span> Менеджер отримує відсоток від своїх угод за офером. Стандартний: «Старт» {st.pctLow ?? 10} % ({st.pctHigh ?? 20} % при плані), «Профі» {pr.pct1 ?? 25} / {pr.pct2 ?? 30} / {pr.pct3 ?? 35} %.</p>
      <p><span className="zf-acc__chip zf-acc__chip--team">маржа команди</span> Тімлід отримує {ld.pctLow ?? 3} % від суми маржі своїх менеджерів, {ld.pctHigh ?? 6} % якщо команда виконала план. Його власні угоди у відсоток не йдуть, лише в ліміт авансу.</p>
    </div>
  );
}

function TeamBand({ g, live, open }: { g: AccrualGroup; live: boolean; open: boolean }) {
  const c = (g.lead?.calc ?? null) as Obj | null;
  const mgrs = g.rows.filter((x) => x.role === "manager");
  const margin = c ? Number(c.margin) : mgrs.reduce((s, x) => s + Number(x.calc?.margin ?? 0), 0);
  const plan = c ? Number(c.plan) : mgrs.reduce((s, x) => s + Number(x.calc?.plan ?? 0), 0);
  const fund = g.rows.reduce((s, x) => s + Number(live || !x.record ? x.calc?.now?.total ?? 0 : x.record.total), 0);
  const done = plan ? margin / plan * 100 : 0;
  return (
    <div className="zf-acc__bandin">
      <span className="zf-acc__chev" aria-hidden>{open ? "▾" : "▸"}</span>
      <b className="zf-acc__team">{g.lead ? `Команда ${g.lead.name}` : g.name}</b>
      <span className="zf-acc__meta">маржа <b>{money(margin)}</b>{plan ? <> з плану <b>{money(plan)}</b> · {pct(done)}</> : " · плану немає"}</span>
      {plan > 0 && <span className="zf-acc__road" role="img" aria-label={`${pct(done)} плану`}><i style={{ width: `${Math.min(100, done)}%` }} /></span>}
      {g.lead && plan > margin && <span className="zf-acc__meta">до {String(c?.atPlan?.pct ?? 6)} % тімліду бракує <b>{money(plan - margin)}</b></span>}
      {g.lead && plan > 0 && margin >= plan && <span className="zf-acc__meta">план команди виконано</span>}
      <span className="zf-acc__sum">{live ? "фонд команди зараз" : "фонд команди"} <b>{money(fund)}</b> · {g.rows.length} {g.rows.length === 1 ? "людина" : g.rows.length < 5 ? "людини" : "людей"}</span>
    </div>
  );
}

function AccrualRow({ x, live, S, q, member, onOpen }: { x: Obj; live: boolean; S?: Obj; q?: Obj; member: boolean; onOpen?: () => void }) {
  const c = x.calc as Obj, lead = x.role === "lead", mgr = x.role === "manager";
  const changed = x.record && x.record.status !== "review" && Math.round(x.record.total) !== Math.round(c.now.total);
  const atPlanPct = Number(c.atPlan?.pct ?? c.now.pct);
  const cls = [lead ? "zf-acc__lead" : "", member ? "zf-acc__mem" : "", onOpen ? "is-click" : ""].filter(Boolean).join(" ");
  return (
    <tr className={cls} onClick={onOpen}>
      <td className="zf-who"><b>{x.name}{lead && <span className="zf-acc__lvl">тімлід</span>}</b>
        <div className="zp-hint">{lead ? `${(c.members as Obj[] | undefined)?.length ?? 0} у команді` : shortRole({ role: x.role, level: c.level, title: x.title })}{x.official ? " · офіційно" : ""}{mgr && c.plan ? ` · план ${num(c.plan)}` : ""}</div>
        {c.dismissZero && <div className="zp-hint zp-tone--danger">звільнення без угод — 0</div>}</td>
      <td className="r zf-acc__sep">{mgr ? <b>{money(c.margin)}</b> : lead ? <span className="zp-muted">{money(c.ownMargin ?? 0)}<div className="zp-hint">у % не йде</div></span> : <span className="zp-muted">—</span>}</td>
      <td className="r">{lead ? <b>{money(c.margin)}</b> : member ? <span className="zp-hint">у команду</span> : <span className="zp-muted">—</span>}</td>
      <td className="zf-acc__sep zf-acc__pz">{lead ? <span className="zf-acc__chip zf-acc__chip--team">маржа команди</span>
        : mgr ? <><span className="zf-acc__chip zf-acc__chip--own">власна маржа</span>{c.special?.lines?.length ? <div className="zp-hint">+ свої клієнти</div> : null}</>
        : c.pctRule ? <><span className="zf-acc__chip zf-acc__chip--co">маржа компанії</span><div className="zp-hint">{money(c.margin)}</div></>
        : <span className="zf-acc__chip">лише оклад</span>}</td>
      <td className="r zf-acc__pz">{flat(x) || c.dismissZero ? <span className="zp-muted">—</span> : <><b>{pct(c.now.pct)}</b>{live && atPlanPct !== Number(c.now.pct) ? <div className="zp-hint">{pct(atPlanPct)} при плані</div> : null}</>}</td>
      <td className="r zf-acc__pz">{flat(x) || c.dismissZero ? <span className="zp-muted">—</span> : <b>{money(c.now.pctAmount)}</b>}</td>
      <td className="r zf-acc__sep">{c.now.rate ? money(c.now.rate) : <span className="zp-muted">—</span>}</td>
      <td className="r">{c.now.bonus ? money(c.now.bonus) : c.kpi?.bonusPending ? <span className="zp-hint" title="бонус за офером — лише після виконання КПІ; у «Зараз» не входить">умовно {money(c.kpi.bonusPending)}</span> : <span className="zp-muted">—</span>}</td>
      <td className={`r zp-tone--${signTone(c.now.birthday) ?? "muted"}`}>{signed(c.now.birthday)}</td>
      {live ? (
        <>
          <td className="r"><b>{money(c.now.total)}</b></td>
          <td className="r zp-tone--ok">{money(c.atPlan.total)}</td>
        </>
      ) : (
        <>
          <td className="r zp-muted">{money(c.now.total)}</td>
          <td className="r">{x.record ? <b className={changed ? "zp-tone--warn" : ""} title={changed ? "змінено при перевірці" : undefined}>{money(x.record.total)}</b> : "—"}</td>
        </>
      )}
      <td className="r zf-acc__sep"><AdvCell a={x.advance} /></td>
      <td className="r">{x.official ? <span>{money(x.official.amount)}<div className="zp-hint">{x.official.deduct ? "вираховується" : "окремо"}</div></span> : <span className="zp-muted">—</span>}</td>
      <td className="r"><TtnCell ttn={x.ttn} minPct={S?.ttn?.minPct ?? 70} /></td>
      {!live && <td className="r"><b>{x.record ? money(x.record.pay) : "—"}</b></td>}
      {!live && <td>{x.record ? <StatusPill status={x.record.status} /> : <span className="zp-muted">листа немає</span>}{q?.odOnly ? <div className="zp-hint">перевіряє ОД</div> : null}</td>}
    </tr>
  );
}
