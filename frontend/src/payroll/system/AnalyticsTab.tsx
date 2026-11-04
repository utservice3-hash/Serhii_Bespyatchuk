/**
 * 💰 «Аналітика» — «ЗП до результату» (ТЗ §8.1, макет p07d-an.js, рушій `deptStats`): скільки з кожних 100 ₴ маржі йде на
 * зарплату — по відділах і командах. Команда — до маржі її менеджерів; відділи й компанія — до маржі компанії.
 * Поточний місяць — «при виконанні плану» (перемикач «на сьогодні»): ставки нараховуються за весь місяць, маржа ще набирається.
 */
import { useState } from "react";
import type { PayrollCtx } from "../PayrollSection";
import { payrollApi, type Obj } from "../api";
import { Card, Empty, Loading, money, monthTitle, pct, useLoad } from "../ui";
import { Seg, plural } from "./common";

const ppt = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1).replace(".", ",")} п. п.`;
const short = (mk: string) => monthTitle(mk).slice(0, 3).toLowerCase();

function Spark({ vals }: { vals: Array<number | null> }) {
  const ok = vals.filter((x): x is number => x !== null);
  if (ok.length < 2) return null;
  const W = 120, H = 30, lo = Math.min(...ok), hi = Math.max(...ok), span = hi - lo || 1;
  const X = (i: number) => 4 + (i * (W - 8)) / (vals.length - 1), Y = (x: number) => H - 5 - ((x - lo) / span) * (H - 10);
  const pts = vals.map((x, i) => (x === null ? null : [X(i), Y(x)])).filter((p): p is number[] => !!p);
  const last = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Тренд: ${ok.map((x) => pct(x, 1)).join(", ")}`}>
      <polyline points={pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")} fill="none" stroke="var(--text-muted)" strokeWidth={1.6} />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill="var(--text)" />
    </svg>
  );
}

export default function AnalyticsTab({ ctx }: { ctx: PayrollCtx }) {
  const [mk, setMk] = useState<string>(ctx.closedMonth ?? ctx.liveMonth);
  const [plan, setPlan] = useState(true);
  const [people, setPeople] = useState(false);
  const { data, err, reload } = useLoad(() => payrollApi.analytics(mk, plan), [mk, plan]);
  if (!data) return <Loading err={err} onRetry={reload} />;
  const A = data as Obj;
  const series = (A.series ?? []) as Obj[];
  const months = series.map((s) => s.month as string);
  const live = mk === ctx.liveMonth;
  const prevPct = (key: string): number | null => {
    if (!A.prev) return null;
    if (key === "all") return A.prev.all?.pct ?? null;
    const [kind, k] = key.split(":");
    const list = (kind === "t" ? A.prev.teams : A.prev.depts) as Obj[];
    return list?.find((x) => x.k === k)?.pct ?? null;
  };
  const hasPrev = months.indexOf(mk) > 0;
  const dAll = hasPrev && A.all?.pct != null && prevPct("all") != null ? A.all.pct - (prevPct("all") as number) : null;
  const sales = (A.depts as Obj[]).find((d) => d.k === "sales");
  const sup = A.support as { n: number; pay: number };
  const supPct = A.comp > 0 ? (sup.pay / A.comp) * 100 : null;
  const teams = [...(A.teams as Obj[])].filter((t) => t.pct != null).sort((a, b) => b.pct - a.pct);
  const hi = teams[0], lo = teams[teams.length - 1];

  const row = (key: string, x: Obj | undefined, name: string, sub: string, cls = "") => {
    if (!x) return null;
    const pv = hasPrev ? prevPct(key) : null, d = pv !== null && x.pct != null ? x.pct - pv : null;
    const resLabel = key.startsWith("t:") ? "маржа команди" : "маржа компанії";
    const ps = (x.people ?? []) as Array<{ id: string; name: string }>;
    return [
      <tr key={key} className={cls}>
        <td><b>{name}</b>{sub && <span className="zp-hint"> · {sub}</span>}</td>
        <td className="r">{x.n}</td>
        <td className="r">{money(x.pay)}</td>
        <td className="r">{money(x.res ?? A.comp)} <span className="zp-hint">{resLabel}</span></td>
        <td className="r"><div className="zps-anbar"><b>{x.pct == null ? "—" : pct(x.pct, 1)}</b><i style={{ width: `${Math.min(100, ((x.pct ?? 0) / 70) * 100).toFixed(1)}%` }} /></div></td>
        <td className={`r ${d === null ? "" : d > 0.05 ? "zp-tone--warn" : d < -0.05 ? "zp-tone--ok" : "zp-tone--muted"}`}>{d === null ? "—" : ppt(d)}</td>
        <td>{key === "all" ? <Spark vals={series.map((s) => (s.pct ?? null) as number | null)} /> : null}</td>
      </tr>,
      ...(people && key !== "all" && key !== "d:sales" ? ps.map((p) => (
        <tr key={`${key}-${p.id}`} className="zps-an-person"><td colSpan={7}>{p.name || `#${p.id}`}</td></tr>
      )) : []),
    ];
  };

  const notes = [
    A.all?.pct != null ? `Компанія: ${pct(A.all.pct, 1)} — з кожних 100 ₴ маржі ${Math.round(A.all.pct)} ₴ іде на зарплату${dAll === null ? "" : ` (${ppt(dAll)} до попереднього місяця)`}.` : "Маржі компанії за місяць немає — частку не порахувати.",
    hi && lo && hi !== lo ? `Найвища частка серед команд — «${hi.name}» (${pct(hi.pct, 1)}), найнижча — «${lo.name}» (${pct(lo.pct, 1)}). Різниця — ставки «Старту» й бонуси за КПІ при меншій маржі.` : "",
    `Відділи, що не продають (${sup.n} ${plural(sup.n, "людина", "людини", "людей")}, лише ставка), — ${supPct == null ? "—" : pct(supPct, 1)} від маржі компанії: фонд ${money(sup.pay)}.`,
    live && plan ? `${monthTitle(mk)} — прогноз: якщо всі виконають план. Ставки нараховуються за весь місяць, маржа ще набирається — «на сьогодні» частка була б завищена.` : "",
  ].filter(Boolean);

  return (
    <Card title="ЗП до результату — по відділах" aside="скільки з кожних 100 ₴ маржі йде на зарплату">
      <div className="zp-grid" style={{ gap: 14 }}>
        <div className="zp-row">
          {months.length > 0 && <Seg items={months.map((m) => [m, `${short(m)}${m === ctx.liveMonth ? " · прогноз" : ""}`] as [string, string])} value={mk} onChange={setMk} />}
          {live && <Seg items={[["plan", "при виконанні плану"], ["now", "на сьогодні"]]} value={plan ? "plan" : "now"} onChange={(k) => setPlan(k === "plan")} />}
          {!live && mk === ctx.closedMonth && <span className="zp-hint">закритий місяць — перевірені суми</span>}
          <span className="zp-grow" />
          <label className="zp-check"><input type="checkbox" checked={people} onChange={(e) => setPeople(e.target.checked)} />Показати людей</label>
        </div>
        <div className="zp-grid zp-grid--stats">
          <div className="zp-stat"><div className="zp-stat__label">Компанія — ЗП до маржі</div><div className="zp-stat__value">{A.all?.pct == null ? "—" : pct(A.all.pct, 1)}</div><div className="zp-stat__sub">фонд {money(A.all?.pay)} з маржі {money(A.comp)}</div></div>
          <div className="zp-stat"><div className="zp-stat__label">Відділ продажу</div><div className="zp-stat__value">{sales?.pct == null ? "—" : pct(sales.pct, 1)}</div><div className="zp-stat__sub">{sales ? `${sales.n} ${plural(sales.n, "людина", "людини", "людей")} · фонд ${money(sales.pay)}` : "у зарплаті ще немає"}</div></div>
          <div className="zp-stat"><div className="zp-stat__label">Відділи, що не продають</div><div className="zp-stat__value">{supPct == null ? "—" : pct(supPct, 1)}</div><div className="zp-stat__sub">{sup.n} {plural(sup.n, "людина", "людини", "людей")} · фонд {money(sup.pay)}</div></div>
          <div className="zp-stat"><div className="zp-stat__label">До попереднього місяця</div><div className="zp-stat__value">{dAll === null ? "—" : ppt(dAll)}</div><div className="zp-stat__sub">{hasPrev && prevPct("all") != null ? `було ${pct(prevPct("all"), 1)}` : "перший місяць у даних"}</div></div>
        </div>
        {A.all?.n ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Відділ / команда</th><th className="r">Людей</th><th className="r">Фонд ЗП</th><th className="r">Результат</th><th className="r">ЗП до результату</th><th className="r">До попер. місяця</th><th>{months.length > 1 ? `Тренд · ${short(months[0])}–${short(months[months.length - 1])}` : "Тренд"}</th></tr></thead>
              <tbody>
                {row("d:sales", sales, "Відділ продажу", "менеджери й тім-ліди", "zps-an-grp")}
                {(A.teams as Obj[]).map((t) => row(`t:${t.k}`, t, t.name ?? t.k, "команда", "zps-an-tm"))}
                {(A.depts as Obj[]).filter((d) => !d.sales).map((d) => row(`d:${d.k}`, d, d.name ?? d.k, "не продає — ставка"))}
              </tbody>
              <tfoot>{row("all", A.all, "Компанія разом", "")}</tfoot>
            </table>
          </div>
        ) : <Empty>За {monthTitle(mk).toLowerCase()} у зарплаті нікого немає — нема з чого рахувати.</Empty>}
        <ul className="zps-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
        <div className="zp-hint">
          Результат: для команди — маржа її менеджерів («Успішно реалізовано»; у закритому місяці — перевірена фінансистом), для відділу продажу
          й відділів, що не продають, — маржа компанії. Фонд ЗП — нараховано (ставка, %, бонуси, дні народження) + офіційна ЗП, що виплачується
          окремо; податки не враховано. Тренд — частка компанії по місяцях.
        </div>
      </div>
    </Card>
  );
}
