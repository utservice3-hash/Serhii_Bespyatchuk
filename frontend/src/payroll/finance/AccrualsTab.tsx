/**
 * 💰 «Нарахування» — усі за місяць (ТЗ §7.1; макет v6 `accruals`). Поточний місяць — «зараз / при виконанні плану»
 * (орієнтовно), закритий — орієнтовно → перевірено → до виплати зі станом листа. Клік по рядку закритого місяця —
 * вікно працівника у «Перевірці». Тім-ліду / працівнику ця вкладка не показується (право `payroll_view_all`).
 */
import { useMemo, useState } from "react";
import { payrollApi, type Obj } from "../api";
import type { PayrollCtx } from "../PayrollSection";
import { Card, Empty, Loading, Stat, StatusPill, money, num, pct, useLoad, Tabs } from "../ui";
import { AdvCell, MonthSwitch, TtnCell, LevelTag } from "./common";
import { dayGen, monthGen, shortRole, signed, signTone } from "./fmt";

const FILTERS: Array<[string, string]> = [["all", "Усі"], ["review", "На перевірці"], ["verified", "Чекають згоди"], ["disputed", "Не погоджуються"], ["agreed", "Чекаємо форму"], ["submitted", "Подано"], ["paid", "Виплачено"]];

export default function AccrualsTab({ ctx }: { ctx: PayrollCtx }) {
  const months = [ctx.closedMonth, ctx.liveMonth].filter(Boolean) as string[];
  const [mk, setMk] = useState<string>(months[0]);
  const live = mk === ctx.liveMonth;
  const { data, err, reload } = useLoad<Obj[]>(() => payrollApi.accruals(mk), [mk]);
  const { data: st } = useLoad<Obj | null>(() => payrollApi.settings(mk).catch(() => null), [mk]);
  const { data: q } = useLoad<Obj | null>(() => (live ? Promise.resolve(null) : payrollApi.queue(mk).catch(() => null)), [mk, live]);
  const [filter, setFilter] = useState("all");
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
  const flat = (x: Obj) => x.role === "staff" && !x.calc?.pctRule;
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
        <div className="zp-table-wrap" style={{ padding: "6px 4px 4px" }}>
          {!list.length ? <div style={{ padding: 16 }}><Empty>{rows.length ? "За цим фільтром нікого." : "У зарплаті за цей місяць нікого немає — людей і умови додає фінансист у «Налаштуваннях»."}</Empty></div> : (
            <table className="zp-table zf-table">
              <thead>
                {live ? (
                  <tr><th>Працівник</th><th className="r">Маржа (база %)</th><th className="r">Ставка</th><th className="r">%</th><th className="r">Бонус</th><th className="r">ДН</th><th className="r">Зараз</th><th className="r">При виконанні плану</th><th className="r">Аванс</th><th className="r">Офіційна ЗП</th><th className="r">ТТН</th></tr>
                ) : (
                  <tr><th>Працівник</th><th className="r">Маржа (база %)</th><th className="r">Ставка</th><th className="r">%</th><th className="r">Бонус</th><th className="r">ДН</th><th className="r">Орієнтовно</th><th className="r">Перевірено</th><th className="r">Аванс</th><th className="r">Офіційна ЗП</th><th className="r">ТТН</th><th className="r">До виплати</th><th>Стан</th></tr>
                )}
              </thead>
              <tbody>
                {list.map((x) => {
                  const c = x.calc as Obj, qr = qById.get(x.userId);
                  const changed = x.record && x.record.status !== "review" && Math.round(x.record.total) !== Math.round(c.now.total);
                  return (
                    <tr key={x.userId} className={live ? "" : "is-click"} onClick={live ? undefined : () => ctx.go("verify", { userId: x.userId })}>
                      <td className="zf-who"><b>{x.name}</b><div className="zp-hint">{shortRole({ role: x.role, level: c.level, title: x.title })}{x.teamName ? ` · ${x.teamName}` : ""}{x.official ? " · офіційно" : ""}</div>
                        {x.role === "manager" && c.level === "profi" && <LevelTag level="profi" />}</td>
                      <td className="r">{flat(x) ? "—" : money(c.margin)}{x.role === "manager" && c.plan ? <div className="zp-hint">план {num(c.plan)}</div> : null}</td>
                      <td className="r">{c.now.rate ? money(c.now.rate) : "—"}</td>
                      <td className="r">{flat(x) ? "—" : pct(c.now.pct)}</td>
                      <td className="r">{c.now.bonus ? money(c.now.bonus) : "—"}</td>
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
                      <td className="r"><AdvCell a={x.advance} /></td>
                      <td className="r">{x.official ? <span>{money(x.official.amount)}<div className="zp-hint">{x.official.deduct ? "вираховується" : "окремо"}</div></span> : "—"}</td>
                      <td className="r"><TtnCell ttn={x.ttn} minPct={S?.ttn?.minPct ?? 70} /></td>
                      {!live && <td className="r"><b>{x.record ? money(x.record.pay) : "—"}</b></td>}
                      {!live && <td>{x.record ? <StatusPill status={x.record.status} /> : <span className="zp-muted">листа немає</span>}{qr?.odOnly ? <div className="zp-hint">перевіряє ОД</div> : null}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="zp-hint" style={{ padding: "0 16px 14px" }}>
          ТТН — {live ? `частка угод з ТТН зараз (на закриття потрібно від ${S?.ttn?.minPct ?? 70} %)` : `утримання ${money(S?.ttn?.hold ?? 3000)} до закриття ТТН або повернення за минулий місяць`}.
          ДН — дні народження за правилом (−{num(S?.birthday?.each ?? 100)} ₴ за колегу, іменинникові — збір і подарунок компанії). Аванс — заявка цього місяця.
        </div>
      </Card>
    </>
  );
}
