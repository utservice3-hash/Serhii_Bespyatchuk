import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend, Cell, ReferenceArea,
} from "recharts";
import type { LeadgenStatsResp, LeadgenTrendResp, LeadgenGrain, LeadgenBucket, LeadgenHandoffMoney } from "../../../api";
import { formatAmountFull } from "../format";
import { COLORS } from "./StatisticsChartsSection";
import { unitsOf, fillBuckets, bucketLabel } from "./LeadgenPersonRow";
import { monthEnd } from "../periodRules";

const MUTED = "var(--text-muted)";
/** Кольори показників — з палітри «Статистик», однакові на всіх трьох графіках. */
const C = { leads: COLORS[0], opr: COLORS[2], quotes: COLORS[1], calls: "#94a3b8", conv: "#c5141c" };
/**
 * Гроші з передач на графіках — ДВІ ОКРЕМІ серії, не стек: «успішні» (гроші ① ядра) і поруч «оплачено + зона
 * «Очікуємо»» (ще не успіх, знімок зараз). Складати їх в одну смугу не можна — така сума ніде не визначена, а
 * сортування за нею винагороджувало б не гроші, а рано проставлений бюджет. «В роботі» на графіках немає:
 * бюджет там здебільшого не проставлений (86 %), тож смуга брехала б про масштаб.
 */
const MONEY = [
  { k: "success", name: "Успішні", fill: "#16a34a" },
  { k: "pipe", name: "Оплачено + зона «Очікуємо» (ще не успіх)", fill: "#d97706" },
] as const;
const moneyRow = (m: LeadgenHandoffMoney | undefined) => ({ success: m ? m.success.sum : 0, pipe: m ? m.paid.sum + m.expect.sum : 0 });
const moneyLabel = (l: unknown, m: LeadgenHandoffMoney | undefined) => !m ? `${String(l)} · передач немає`
  : `${String(l)} · передано ${n(m.handoffs)}: успішні ${n(m.success.n)}, оплачено ${n(m.paid.n)}, «Очікуємо» ${n(m.expect.n)}, в роботі ${n(m.work.n)}, програно ${n(m.lost)}${m.unlinked ? `, без угоди ${n(m.unlinked)}` : ""}`;
/** Рівні поділки для грошей: 4 кроки по 1 / 2 / 2,5 / 5 × 10^k, щоб підписи не були «19тис · 29тис». */
function moneyTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= raw) ?? 10 * p;
  return [0, 1, 2, 3, 4].map((i) => i * step);
}
/** Підпис поділки: з десятковою, коли крок дробовий (1,5 тис ₴), — formatAmount округлив би 1 500 і 2 000 в однакове «2тис». */
const fmtTick = (v: number) => {
  const d = (x: number, u: string) => `${x.toLocaleString("uk-UA", { maximumFractionDigits: 1 })} ${u}`;
  return v >= 1_000_000 ? d(v / 1_000_000, "млн ₴") : v >= 1_000 ? d(v / 1_000, "тис ₴") : `${v} ₴`;
};
/** Текст легенди — кольором тексту теми: колір серії лишається на значку, а не на словах (інакше 3:1 на білому). */
const legendText = (v: unknown) => <span style={{ color: "var(--text)" }}>{String(v)}</span>;
const seriesMax = (rows: { success: number; pipe: number }[]) => Math.max(0, ...rows.flatMap((r) => [r.success, r.pipe]));
const moneyTip = (v: unknown, name: unknown) => [formatAmountFull(Number(v)), String(name)] as [string, string];
const MON = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const n = (v: number) => v.toLocaleString("uk-UA");
/**
 * Місяць `ym` («2026-09») перетинає період. Кінець місяця — з КАЛЕНДАРЯ (`monthEnd`), а не
 * рядком «-31»: день місяця, зашитий літералом, — клас дефекту `#239` (у вересні 30 днів).
 */
const monthTouches = (ym: string, p: { from: string; to: string }) => ym + "-01" <= p.to && p.from <= monthEnd(ym + "-01");

/**
 * 📊 ЗАГАЛЬНА СТАТИСТИКА (прохання 22.09.2026) — три графіки над рядками людей:
 *   1. «Динаміка» — обраний період на одиницю нижче (тиждень по днях, місяць по тижнях),
 *      та сама розбивка й ті самі нулі, що в таблицях: графік і таблиця не можуть розійтись;
 *   2. «По людях» — хто скільки дав за період (обрана у фільтрі людина підсвічена);
 *   3. «Тренд за 12 місяців» — контекст, у якому видно, чи обраний місяць — норма чи виняток.
 * Якщо у фільтрі людина — графіки 1 і 3 показують ЇЇ числа (підпис каже, чиї).
 *
 * ⚠️ Конверсія «ліди → ОПР» понад 100 % на тренді не малюється (розрив лінії): такої
 * конверсії не буває, це межа місяця або зміна процесу (вересень 2026). Під графіком — чому.
 */
export function LeadgenCharts({ d, trend, trendErr, who, whoName, grain, period, today, periodLabel }: {
  d: LeadgenStatsResp; trend: LeadgenTrendResp | null; trendErr: boolean;
  who: number | "all"; whoName: string; grain: LeadgenGrain | null;
  period: { from: string; to: string }; today: string; periodLabel: string;
}) {
  const scopeName = who === "all" ? (d.scopedTo != null ? "команда" : "відділ") : whoName;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))", gap: 16, marginBottom: 16 }}>
        <Dynamics d={d} who={who} grain={grain} period={period} today={today} periodLabel={periodLabel} scopeName={scopeName} />
        <ByPerson d={d} who={who} periodLabel={periodLabel} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))", gap: 16, marginBottom: 16 }}>
        <MoneyByPerson d={d} who={who} periodLabel={periodLabel} />
        <MoneyTrend trend={trend} trendErr={trendErr} who={who} scopeName={scopeName} period={period} today={today} />
      </div>
      <Trend trend={trend} trendErr={trendErr} who={who} scopeName={scopeName} period={period} today={today} />
    </div>
  );
}

function Dynamics({ d, who, grain, period, today, periodLabel, scopeName }: {
  d: LeadgenStatsResp; who: number | "all"; grain: LeadgenGrain | null; period: { from: string; to: string };
  today: string; periodLabel: string; scopeName: string;
}) {
  const src: LeadgenBucket[] = who === "all" ? d.buckets ?? [] : (d.bucketsByPerson ?? []).filter((b) => b.managerId === who);
  const rows = grain ? fillBuckets(unitsOf(grain, period, today), src).map((b) => ({ ...b, label: bucketLabel(b.bucket, grain, period) })) : [];
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 2 }}>Динаміка · {periodLabel}</h2>
      <p style={{ fontSize: 12, color: MUTED, margin: "0 0 8px" }}>
        {grain === "day" ? "По днях" : grain === "week" ? "По тижнях" : ""}{grain ? ` · ${scopeName}. Ліди, ОПР і прорахунки — стовпчики, дзвінки — лінія (права шкала).` : ""}
      </p>
      {!grain ? (
        <p className="loading-text">За один день динаміки немає — оберіть тиждень чи місяць.</p>
      ) : rows.length === 0 ? (
        <p className="loading-text">Період ще не почався.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={rows} margin={{ top: 10, right: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} interval="preserveStartEnd" minTickGap={6} angle={rows.length > 7 ? -20 : 0} textAnchor={rows.length > 7 ? "end" : "middle"} height={rows.length > 7 ? 46 : 28} />
            <YAxis yAxisId="l" tick={{ fontSize: 11, fill: MUTED }} allowDecimals={false} />
            <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: MUTED }} allowDecimals={false} />
            <Tooltip formatter={(v, name) => [n(Number(v)), String(name)]} />
            <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} formatter={legendText} />
            <Bar yAxisId="l" dataKey="leads" name="Ліди" fill={C.leads} radius={[3, 3, 0, 0]} />
            <Bar yAxisId="l" dataKey="opr" name="ОПР" fill={C.opr} radius={[3, 3, 0, 0]} />
            <Bar yAxisId="l" dataKey="quotes" name="Прорахунки" fill={C.quotes} radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" type="monotone" dataKey="calls" name="Дзвінки" stroke={C.calls} strokeWidth={2} dot={{ r: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function ByPerson({ d, who, periodLabel }: { d: LeadgenStatsResp; who: number | "all"; periodLabel: string }) {
  const rows = d.rows
    .filter((r) => r.leads || r.opr || r.quotes)
    .map((r) => ({ id: r.managerId, name: shortName(r.name), leads: r.leads, opr: r.opr, quotes: r.quotes }));
  const hidden = d.rows.length - rows.length;
  const dim = (id: number) => (who !== "all" && who !== id ? 0.3 : 1);
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 2 }}>По людях · {periodLabel}</h2>
      <p style={{ fontSize: 12, color: MUTED, margin: "0 0 8px" }}>
        Ліди, ОПР, прорахунки кожного лідгена.{hidden > 0 ? ` Без лідів, ОПР і прорахунків (лише дзвінки/підігрів) — ${hidden} ${hidden === 1 ? "людина" : "людей"}, не показано.` : ""}
      </p>
      {rows.length === 0 ? (
        <p className="loading-text">За цей період лідгенівських дій немає.</p>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(160, 44 + rows.length * 40)}>
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.35} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11, fill: MUTED }} allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={118} tick={{ fontSize: 11.5, fill: MUTED }} />
            <Tooltip formatter={(v, name) => [n(Number(v)), String(name)]} />
            <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} formatter={legendText} />
            {(["leads", "opr", "quotes"] as const).map((k) => (
              <Bar key={k} dataKey={k} name={k === "leads" ? "Ліди" : k === "opr" ? "ОПР" : "Прорахунки"} fill={C[k]} radius={[0, 3, 3, 0]}>
                {rows.map((r) => <Cell key={r.id} fillOpacity={dim(r.id)} />)}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function Trend({ trend, trendErr, who, scopeName, period, today }: {
  trend: LeadgenTrendResp | null; trendErr: boolean; who: number | "all"; scopeName: string;
  period: { from: string; to: string }; today: string;
}) {
  const src: LeadgenBucket[] = !trend ? [] : who === "all" ? trend.buckets : trend.bucketsByPerson.filter((b) => b.managerId === who);
  const by = new Map(src.map((b) => [b.bucket.slice(0, 7), b]));
  const months: string[] = [];
  if (trend) {
    const [y, m] = trend.to.slice(0, 7).split("-").map(Number);
    for (let i = trend.months - 1; i >= 0; i--) {
      const t = y * 12 + (m - 1) - i;
      months.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
    }
  }
  const rows = months.filter((ym) => ym + "-01" <= today).map((ym) => {
    const b = by.get(ym) ?? { calls: 0, leads: 0, opr: 0, quotes: 0, warming: 0 };
    const conv = b.leads > 0 ? Math.round((b.opr / b.leads) * 1000) / 10 : null;
    return { ym, label: `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`, leads: b.leads, quotes: b.quotes, calls: b.calls,
      conv: conv != null && conv <= 100 ? conv : null, over: conv != null && conv > 100 };
  });
  const overMonths = rows.filter((r) => r.over).map((r) => r.label);
  // Підсвітка місяців, що перетинають обраний період.
  const sel = rows.filter((r) => monthTouches(r.ym, period)).map((r) => r.label);
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 2 }}>Тренд за 12 місяців</h2>
      <p style={{ fontSize: 12, color: MUTED, margin: "0 0 8px" }}>
        По місяцях · {scopeName}. Ліди й прорахунки — стовпчики; конверсія «ліди → ОПР» — лінія (права шкала, %). Обраний період підсвічено.
      </p>
      {trendErr ? <p className="loading-text">Не вдалося завантажити тренд.</p>
        : !trend ? <p className="loading-text">Завантаження…</p>
        : (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={rows} margin={{ top: 10, right: 4, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                {sel.length > 0 && <ReferenceArea yAxisId="l" x1={sel[0]} x2={sel[sel.length - 1]} fill="var(--text)" fillOpacity={0.06} />}
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} interval="preserveStartEnd" minTickGap={6} />
                <YAxis yAxisId="l" tick={{ fontSize: 11, fill: MUTED }} allowDecimals={false} />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
                <Tooltip formatter={(v, name) => [String(name).startsWith("Ліди →") ? `${Number(v).toLocaleString("uk-UA")} %` : n(Number(v)), String(name)]} />
                <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} formatter={legendText} />
                <Bar yAxisId="l" dataKey="leads" name="Ліди" fill={C.leads} radius={[3, 3, 0, 0]} />
                <Bar yAxisId="l" dataKey="quotes" name="Прорахунки" fill={C.quotes} radius={[3, 3, 0, 0]} />
                <Line yAxisId="r" type="monotone" dataKey="conv" name="Ліди → ОПР" stroke={C.conv} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
            {overMonths.length > 0 && (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: MUTED }}>
                ⚠ Конверсію за {overMonths.join(", ")} не показано: ОПР там більше, ніж лідів, — такої конверсії не буває (межа місяця або зміна процесу).
              </p>
            )}
          </>
        )}
    </div>
  );
}

/**
 * 💰 УСПІШНІ УГОДИ З ПЕРЕДАЧ ПО ЛЮДЯХ — за датою передачі, стан — зараз. Сортування — за успішними (①),
 * поруч окремою смугою «оплачено + «Очікуємо»». Решта станів — у підказці.
 */
function MoneyByPerson({ d, who, periodLabel }: { d: LeadgenStatsResp; who: number | "all"; periodLabel: string }) {
  const hm = d.handoffMoney;
  const rows = (hm?.byPerson ?? [])
    .filter((m) => m.handoffs > 0)
    .map((m) => ({ id: m.managerId, name: shortName(d.rows.find((r) => r.managerId === m.managerId)?.name ?? `#${m.managerId}`), m, ...moneyRow(m) }))
    .sort((a, b) => b.success - a.success || b.pipe - a.pipe);
  const dim = (id: number) => (who !== "all" && who !== id ? 0.3 : 1);
  const ticks = moneyTicks(seriesMax(rows));
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 2 }}>💰 Успішні угоди з переданих лідів · {periodLabel}</h2>
      <p style={{ fontSize: 12, color: MUTED, margin: "0 0 8px" }}>
        За датою передачі ліда, стан угоди — зараз; це не «Дохід лідогену» КВП (там — отримані кошти за датою оплати). Поруч — оплачені й у зоні «Очікуємо» (ще не успіх). Угод у роботі тут немає: бюджет у них здебільшого не проставлений.
      </p>
      {!hm ? <p className="loading-text">Немає даних про гроші.</p>
        : rows.length === 0 ? <p className="loading-text">За цей період передач немає.</p>
        : (
          <ResponsiveContainer width="100%" height={Math.max(160, 44 + rows.length * 40)}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.35} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => fmtTick(Number(v))} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} />
              <YAxis type="category" dataKey="name" width={118} tick={{ fontSize: 11.5, fill: MUTED }} />
              <Tooltip formatter={moneyTip} labelFormatter={(l, p) => moneyLabel(l, (p?.[0]?.payload as { m?: LeadgenHandoffMoney } | undefined)?.m)} />
              <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} formatter={legendText} />
              {MONEY.map(({ k, name, fill }) => (
                <Bar key={k} dataKey={k} name={name} fill={fill} radius={[0, 3, 3, 0]}>
                  {rows.map((r) => <Cell key={r.id} fillOpacity={dim(r.id)} />)}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
    </div>
  );
}

/**
 * 💰 ГРОШІ ПО МІСЯЦЯХ ПЕРЕДАЧІ (когорта): лід переданий у травні — його гроші стоять у травні, коли б угода
 * не закрилась. Тому старі місяці майже цілком «успішні/програні», а свіжі — ще «в роботі»: це не спад, а вік.
 */
function MoneyTrend({ trend, trendErr, who, scopeName, period, today }: {
  trend: LeadgenTrendResp | null; trendErr: boolean; who: number | "all"; scopeName: string;
  period: { from: string; to: string }; today: string;
}) {
  const src = !trend ? [] : who === "all" ? trend.handoffMoney ?? [] : (trend.handoffMoneyByPerson ?? []).filter((m) => m.managerId === who);
  const by = new Map(src.map((m) => [m.bucket.slice(0, 7), m]));
  const months: string[] = [];
  if (trend) {
    const [y, mo] = trend.to.slice(0, 7).split("-").map(Number);
    for (let i = trend.months - 1; i >= 0; i--) {
      const t = y * 12 + (mo - 1) - i;
      months.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
    }
  }
  const rows = months.filter((ym) => ym + "-01" <= today).map((ym) => {
    const m = by.get(ym);
    return { ym, label: `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`, m, ...moneyRow(m) };
  });
  const sel = rows.filter((r) => monthTouches(r.ym, period)).map((r) => r.label);
  const ticks = moneyTicks(seriesMax(rows));
  // Місяці, де понад п'яту частину передач не знайшли угоди менеджера: гроші там занижені, і це треба сказати.
  const blind = rows.filter((r) => r.m && r.m.handoffs > 0 && r.m.unlinked / r.m.handoffs > 0.2)
    .map((r) => `${r.label} — ${Math.round((r.m!.unlinked / r.m!.handoffs) * 100)} %`);
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 2 }}>💰 Успішні угоди з передач по місяцях</h2>
      <p style={{ fontSize: 12, color: MUTED, margin: "0 0 8px" }}>
        {scopeName}. Місяць — коли лід передали, а не коли закрили чи оплатили угоду (у «Доході лідогену» КВП — за датою оплати). Свіжі місяці ще не закрились: низька смуга там — вік угод, а не спад.
      </p>
      {trendErr ? <p className="loading-text">Не вдалося завантажити.</p>
        : !trend ? <p className="loading-text">Завантаження…</p>
        : !trend.handoffMoney ? <p className="loading-text">Немає даних про гроші.</p>
        : (
          <ResponsiveContainer width="100%" height={Math.max(160, 44 + 6 * 40)}>
            <BarChart data={rows} margin={{ top: 10, right: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
              {sel.length > 0 && <ReferenceArea x1={sel[0]} x2={sel[sel.length - 1]} fill="var(--text)" fillOpacity={0.06} />}
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} interval="preserveStartEnd" minTickGap={6} />
              <YAxis tick={{ fontSize: 11, fill: MUTED }} tickFormatter={(v) => fmtTick(Number(v))} width={82} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} />
              <Tooltip formatter={moneyTip} labelFormatter={(l, p) => moneyLabel(l, (p?.[0]?.payload as { m?: LeadgenHandoffMoney } | undefined)?.m)} />
              <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} formatter={legendText} />
              {MONEY.map(({ k, name, fill }) => <Bar key={k} dataKey={k} name={name} fill={fill} radius={[3, 3, 0, 0]} />)}
            </BarChart>
          </ResponsiveContainer>
        )}
      {trend?.handoffMoney && blind.length > 0 && (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: MUTED }}>
          ⚠ Суми занижені там, де понад п'ята частина передач не має угоди менеджера (їхні гроші не прив'язати): {blind.join(", ")}.
        </p>
      )}
    </div>
  );
}

/** «Сердюк Ярослав Миколайович» → «Сердюк Я.» — щоб підписи осі не з'їдали графік. */
function shortName(full: string): string {
  const p = full.trim().split(/\s+/);
  return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : full;
}
