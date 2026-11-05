/**
 * 💰 «Прогноз» для ОД (ТЗ §8.2, макет p07c-fc.js): фонд «зараз / при плані», календар готівки (аванси з 25-го, виплата до 8-го,
 * офіційна окремо), ризики від найбільшої суми, команди й офери — без зарплат окремих людей. Усі суми — `forecast` рушія.
 */
import type { PayrollCtx } from "../PayrollSection";
import { payrollApi, type Obj } from "../api";
import { Card, Empty, Loading, Pill, RECORD_STATUS, money, monthTitle, nextMonth, pct, useLoad, type Tone } from "../ui";
import { OFFER_NAMES, kyivToday, plural } from "./common";

const MGEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const gen = (mk: string) => MGEN[Number(mk.slice(5, 7)) - 1] ?? "";
const low = (mk: string) => monthTitle(mk).split(" ")[0].toLowerCase();
const lastDay = (mk: string) => { const [y, m] = mk.split("-").map(Number); return new Date(y, m, 0).getDate(); };

const KIND: Record<string, [string, Tone]> = { plan: ["План", "warn"], calls: ["Дзвінки", "warn"], ttn: ["ТТН", "warn"], clearance: ["Обхідний лист", "danger"], dispute: ["Не погоджується", "danger"] };
const STATUS_ORDER = ["review", "verified", "disputed", "agreed", "submitted", "paid"];
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

export default function ForecastTab({ ctx }: { ctx: PayrollCtx }) {
  const mk = ctx.liveMonth;
  const { data, err, reload } = useLoad(async () => {
    const [f, s] = await Promise.all([payrollApi.forecast(mk), payrollApi.settings(mk)]);
    return { f, s: s.settings as Obj };
  }, [mk]);
  if (!data) return <Loading err={err} onRetry={reload} />;
  const { f: F, s: S } = data;
  const nm = gen(nextMonth(mk));
  const advFrom = F.dates?.advanceFrom ?? S.advance?.fromDay, payBy = F.dates?.payBy ?? S.payByDay;
  const today = kyivToday(), open = today.slice(0, 7) === mk ? Number(today.slice(8, 10)) >= advFrom : today.slice(0, 7) > mk;
  const mP = Math.max(F.margin ?? 0, F.plan ?? 0);
  // незгоди закритого місяця — теж ризик (сума виплати під питанням), сортуються разом з рештою за сумою
  const disputes = ((F.disputes ?? []) as Obj[]).map((d) => ({ kind: "dispute", empId: d.empId, name: d.name, text: d.text, at: d.at, loss: d.pay, month: d.month }));
  const risks = [...(F.risks as Obj[]), ...disputes].sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0));
  const CP = F.closedPay as Obj | null;
  const ttnRisk = risks.filter((x) => x.kind === "ttn");

  const tiles: Array<[string, string, string]> = [
    [`Фонд ЗП · ${low(mk)}`, money(F.fundNow), `при виконанні плану ${money(F.fundPlan)}`],
    [`Аванси · з ${advFrom} ${gen(mk)}`, money(F.advPaid + F.advRequested), open ? `виплачено ${money(F.advPaid)} · заявлено ${money(F.advRequested)} · ще до ${money(F.advLeft)}` : `заявок ще немає · ліміти на сьогодні ${money(F.advLeft)}`],
    [`Виплата 5–${payBy} ${nm}`, money(F.payNow), `при виконанні плану ${money(F.payPlan)} · фонд − аванси − офіційна ЗП`],
    ["Офіційна ЗП", money(F.officialDeducted + F.officialSeparate), `з неї вираховується ${money(F.officialDeducted)} · окремо ${money(F.officialSeparate)}`],
    ["ФЗП / маржа", mP ? pct((F.fundPlan / mP) * 100, 1) : "—", `при виконанні плану · маржа ${money(F.margin)} з ${money(F.plan)}`],
  ];

  const cal: Array<{ d: string; t: string; s: string; v: number; now?: boolean }> = [
    { d: `${advFrom}–${lastDay(mk)} ${gen(mk)}`, t: "Аванси", s: open ? `виплачено ${money(F.advPaid)}, заявлено ${money(F.advRequested)}, ще можуть взяти до ${money(F.advLeft)}` : `заявки з ${advFrom}-го; на сьогодні ліміти разом ${money(F.advLeft)}`, v: F.advPaid + F.advRequested + F.advLeft, now: open },
    { d: `${lastDay(mk)} ${gen(mk)}`, t: "Закриття місяця", s: ttnRisk.length ? `ТТН нижче ${S.ttn?.minPct ?? "—"} % і без ТТН понад тиждень: ${ttnRisk.map((x) => x.name ?? "—").join(", ")} — до ${money(ttnRisk.length * (S.ttn?.hold ?? 0))} утримань` : "ТТН — у нормі", v: 0 },
    { d: `до ${S.verifyByDay} ${nm}`, t: "Перевірка фінансиста", s: "кожен працівник погоджує суму або не погоджується", v: 0 },
    ...(CP ? [{ d: `до ${ddmm(CP.payBy)}`, t: `Виплата за ${low(CP.month)}`, now: !open,
      s: `${STATUS_ORDER.filter((k) => CP.byStatus?.[k]).map((k) => `${(RECORD_STATUS[k]?.[0] ?? k).toLowerCase()} — ${CP.byStatus[k].n} (${money(CP.byStatus[k].pay)})`).join(" · ") || "записів немає"}${CP.blocked ? ` · ${CP.blocked} ${plural(CP.blocked, "чекає", "чекають", "чекають")} обхідного листа чи рішення ОД` : ""}`,
      v: CP.total }] : [{ d: "—", t: "Виплата закритого місяця", s: "закритого місяця немає — закриття 1-го о 04:45", v: 0 }]),
    { d: `5–${payBy} ${nm}`, t: "Виплата ЗП", s: `зараз ~${money(F.payNow)}, при виконанні плану ~${money(F.payPlan)}; готівкою й на карти — за формами`, v: F.payPlan },
    { d: "щомісяця", t: "Офіційна ЗП — окремо, через бухгалтерію", s: `${money(F.officialDeducted + F.officialSeparate)}, з неї вираховується з загальної ${money(F.officialDeducted)}`, v: F.officialDeducted + F.officialSeparate },
  ];

  const detail = (x: Obj) => x.kind === "plan" ? `до плану ще ${money(x.gap)}: потрібно ~${money(x.need)} маржі на день, зараз у середньому ~${money(x.avg)}`
    : x.kind === "calls" ? `норму дзвінків уже не набрати (${x.calls?.normDays ?? "—"} з ${x.calls?.need ?? "—"} днів) — бонус лише якщо маржа дійде до ${money(S.kpi?.waiveFrom)}`
    : x.kind === "ttn" ? `ТТН ${x.ttn?.done ?? "—"} з ${x.ttn?.total ?? "—"} (${pct(x.ttn?.pct, 1)}), є угоди без ТТН понад тиждень`
    : x.kind === "clearance" ? `підписано ${x.clearance?.done ?? 0} з ${x.clearance?.total ?? 8} пунктів обхідного листа — фінальна виплата заблокована`
    : x.kind === "dispute" ? `${low(x.month)}: ${x.text ? `«${x.text}»` : "не погоджується з розрахунковим листом"}${x.at ? ` · ${ddmm(x.at)}` : ""} — чекає відповіді фінансиста або рішення ОД`
    : "—";
  const stake = (x: Obj) => x.kind === "dispute" ? `виплата ${money(x.loss)}` : x.kind === "plan" ? `недоотримає до ${money(x.loss)}` : x.kind === "calls" ? `бонус ${money(x.loss)}` : x.kind === "ttn" ? `утримання ${money(x.loss)}` : "виплата чекає підписів";

  const teams = F.teams as Obj[];
  const teamsNow = teams.reduce((a, t) => a + (t.fundNow ?? 0), 0), teamsPlan = teams.reduce((a, t) => a + (t.fundPlan ?? 0), 0);

  return (
    <div className="zp-grid">
      <div className="zp-row">
        <span className="zps-badge">{monthTitle(mk)} іде — прогноз на сьогодні, {today.slice(8, 10)}.{today.slice(5, 7)}</span>
        <span className="zp-grow" />
        <span className="zp-hint">«Зараз» — за угодами на сьогодні; «при виконанні плану» — коли маржа = план.</span>
      </div>
      <div className="zp-grid zp-grid--stats">
        {tiles.map(([l, v, s]) => (
          <div className="zp-stat" key={l}><div className="zp-stat__label">{l}</div><div className="zp-stat__value">{v}</div><div className="zp-stat__sub">{s}</div></div>
        ))}
      </div>
      <div className="zps-cols">
        <Card title="Календар готівки" aside="що й коли виплачувати">
          <ol className="zps-cal">
            {cal.map((c) => (
              <li key={c.t} className={c.now ? "is-now" : ""}>
                <span className="d">{c.d}</span>
                <span><b>{c.t}</b><small>{c.s}</small></span>
                <span className="v">{c.v ? money(c.v) : ""}</span>
              </li>
            ))}
          </ol>
          <div className="zp-hint" style={{ marginTop: 10 }}>Аванси — до верхньої межі лімітів; виплата — «зараз» і «при виконанні плану»; офіційна ЗП іде окремо, через бухгалтерію.</div>
        </Card>
        <Card title="Ризики" aside={risks.length ? `${risks.length} — від найбільшої суми` : "немає"}>
          {risks.length ? (
            <div className="zp-table-wrap">
              <table className="zp-table">
                <thead><tr><th>Що</th><th>Хто</th><th>Деталі</th><th className="r">Під ризиком</th></tr></thead>
                <tbody>
                  {risks.map((x, i) => {
                    const [l, tone] = KIND[x.kind] ?? [x.kind, "muted" as Tone];
                    return (
                      <tr key={`${x.kind}-${x.empId}-${i}`} className={x.kind === "dispute" ? "is-click" : ""} title={x.kind === "dispute" ? "Відкрити в «Перевірці»" : undefined}
                        onClick={x.kind === "dispute" ? () => ctx.go("verify", { userId: String(x.empId) }) : undefined}>
                        <td><Pill tone={tone}>{l}</Pill></td>
                        <td><b>{x.name ?? `#${x.empId}`}</b></td>
                        <td>{detail(x)}</td>
                        <td className="r">{stake(x)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <Empty>Ризиків немає.</Empty>}
        </Card>
      </div>
      <Card title="Команди й офери" aside={`${monthTitle(mk)} · без зарплат окремих людей`}>
        {teams.length ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Команда</th><th>Офер</th><th className="r">Менеджерів</th><th className="r">Маржа / план</th><th className="r">Фонд ЗП зараз</th><th className="r">При виконанні плану</th><th className="r">ФЗП / маржа</th></tr></thead>
              <tbody>
                {teams.map((t) => {
                  const base = Math.max(t.margin ?? 0, t.plan ?? 0);
                  return (
                    <tr key={t.team}>
                      <td><b>{t.name ?? t.team}</b></td>
                      <td>{OFFER_NAMES[t.offer] ?? t.offer}</td>
                      <td className="r">{t.n}</td>
                      <td className="r">{money(t.margin)} / {money(t.plan)}<div className={`zp-hint ${t.plan && t.margin >= t.plan ? "zp-tone--ok" : ""}`}>{t.plan ? pct((t.margin / t.plan) * 100, 1) : "плану немає"}</div></td>
                      <td className="r">{money(t.fundNow)}</td>
                      <td className="r zp-tone--ok">{money(t.fundPlan)}</td>
                      <td className="r">{base ? pct((t.fundPlan / base) * 100, 1) : "—"}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td>Поза командами — відділи, що не продають</td><td>ставки</td><td className="r">—</td><td className="r">—</td>
                  <td className="r">{money(F.fundNow - teamsNow)}</td><td className="r zp-tone--ok">{money(F.fundPlan - teamsPlan)}</td><td className="r">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : <Empty>Команд у зарплаті ще немає — їх заводять у «Налаштуваннях».</Empty>}
        <div className="zp-hint" style={{ marginTop: 8 }}>
          Фонд команди — менеджери й тім-лід. Команда Лілії рахується за своїм офером
          (ставка {money(S.offers?.ls?.startRate)}, план {money(S.offers?.ls?.startPlan)}, без бонусу за КПІ).
          {F.rows?.length ? ` У прогнозі ${F.rows.length} ${plural(F.rows.length, "людина", "людини", "людей")}.` : ""}
        </div>
      </Card>
    </div>
  );
}
