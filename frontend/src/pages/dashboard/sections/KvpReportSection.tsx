import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { fetchKvpReport, fetchKvpPlan, saveKvpPlan, fetchManagerDetail, type KvpReport, type KvpPlans, type KvpTeam, type KvpManager, type KvpManagerDetail } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";
import { LeadgenRegularsCard } from "./LeadgenRegularsCard";

// ── Статус-палітра (зарезервована, НЕ дата-серія): good/warning/serious/critical ──
const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", BLUE = "#2563eb", MUTED = "var(--text-muted)";
const pctColor = (p: number | null) => (p == null ? MUTED : p >= 100 ? GREEN : p >= 85 ? BLUE : p >= 70 ? AMBER : RED);
const sevColor: Record<string, string> = { critical: RED, serious: RED, warning: AMBER, info: BLUE };
const fmtMoney = (v: number) => formatAmount(v);
const fmtFull = (v: number) => formatAmountFull(v);
const fmtNum = (v: number | null) => (v == null ? "—" : Number(v).toLocaleString("uk-UA"));
const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);

/** ⓘ на кожній метриці: що рахує / якір / включено / чому. */
const HINT: Record<string, string> = {
  received: "«Отримані кошти» = угоди, що ввійшли в етап 9 (Оплата отримана) АБО 10 (Успішна) у періоді, РАЗ (дедуп). Ядро core/money.ts.",
  strategic: "🔒 Стратегічний план виручки = Σ планів менеджерів (plans.payment_amount). Read-only — редагується у грід-редакторі планів, не тут.",
  projection: "Прогноз місяця = факт + зона визнання (виставлено→оплата за плановою датою) + добір нового бізнесу. «Станом на зараз».",
  lifecycle: "Життєвий цикл грошей: Відправлено (авто поїхало, дата загрузки load_at) → Очікуємо (зона виставлено→оплата, знімок) → Отримано (кошти в періоді). Три РІЗНІ якорі.",
  sent: "Відправлено = угоди з проставленою «Датою загрузки» (load_at) у періоді. Фактичне відправлення авто, окремо від дати грошей.",
  awaiting: "Очікуємо = зона визнання доходу (виставлено рахунок→оплата), знімок «зараз». НЕ входить у виручку періоду.",
  teamPlan: "План команди = Σ планів її менеджерів (plans). Факт = отримані кошти команди. Σ команд = відділ (інваріант).",
  conversion: "Конверсія = вхідна когорта періоду → дійшли до грошей (MONEY_ZONE) у Повному циклі. Стеля ≤100%. Поточний місяць ⏳ (когорта <90 днів).",
  romi: "ROMI = дохід з реклами (отримані кошти каналу) ÷ рекламний бюджет × 100%.",
  cpa: "CPA = бюджет ÷ рекламні угоди, що дійшли до грошей (MONEY_ZONE). Поточний період ⏳ (незріла когорта).",
  cplGa: "CPL(GA) = бюджет ÷ заявки Google Ads (конверсії з таблиці).",
  cplCrm: "CPL(CRM) = бюджет ÷ рекламні ліди у зоні «взято в роботу».",
  transferred: "Передані заявки = «Реєстр» лідоген-бота (transferred_at). Дедуп по клієнту.",
  lgDispatched: "Поїхали (лідоген) = лідоген-угоди з «Датою загрузки» (load_at) у періоді.",
  lgRevenue: "Дохід лідогену = отримані кошти каналу «лідоген» (дата отримання коштів).",
  newToRepeat: "% нових→постійних = із когорти клієнтів, чия перша оплата в місяці M, скільки стали постійними (≥2 оплати lifetime). Зрілість 90 днів → свіжі місяці ⏳.",
  activeBase: "Активність бази = DISTINCT клієнтів з оплатою в місяці. «Замовили цей місяць».",
  weeklyRegulars: "Постійні щотижня = клієнти з оплатами у ≥4 з останніх 8 тижнів (евристика).",
  nonTarget: "Нецільові = рекламні ліди з причиною відмови «Дубль»/«Перевізник». Місяці до горизонту синку reject_reason → «—» (немає даних, не «0»).",
  receivablesPaidOff: "Погашено дебіторки — джерела історії погашень немає (receivables це знімок) → «—».",
  newRepeat: "Нові/постійні (client-grain лінз): клієнт з першою оплатою в періоді = новий. ОКРЕМО від team-based РПК/РНК (то ознака команди). Кожен клієнт → primary-менеджер, Σ = відділ.",
  structReceived: "«Отримано» = ТА САМА каса, що у вердикті (receivedMoney: 142⊎оплата, дедуп), розкладена по сегменту клієнта. Σ(нові+постійні+залишок) звіряється з загальним received.",
  structExpected: "«В очікуванні» = зона визнання доходу (виставлено→оплата, EXPECT_ZONE), знімок «зараз», по сегменту клієнта. Σ = загальна зона очікування.",
  avgCheck: "Середній чек = виручка успішних угод ÷ к-ть успішних угод менеджера.",
  expected: "Очікування менеджера = його угоди в зоні виставлено→оплата (знімок).",
};

const teamKindLabel: Record<string, string> = { rpk: "РПК · повний цикл", rnk: "РНК · реклама", leadgen: "Лідогенерація" };

// Блок B — секція «Логістика». Чесні мітки: ✓ пряме джерело · ~ проксі/наближення · ✗ нема даних.
function LogisticsSection({ rep }: { rep: KvpReport }) {
  const L = rep.logistics;
  const days = (d: { avg: number | null; median: number | null; n: number }) => d.n === 0 ? "—" : `сер ${d.avg} · медіана ${d.median} дн (${d.n})`;
  const mark = (m: "ok" | "proxy" | "none", text: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: m === "ok" ? GREEN : m === "proxy" ? AMBER : RED }}>
      {m === "ok" ? "✓" : m === "proxy" ? "~" : "✗"}<InfoHint text={text} />
    </span>
  );
  const splitTable = (rows: { key: string; revenue: number; deals: number }[]) => (
    <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}>
      <thead><tr><th>Значення</th><th style={{ textAlign: "right" }}>Виручка</th><th style={{ textAlign: "right" }}>Авто</th><th style={{ textAlign: "right" }}>Сер. чек</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.key}><td style={clip}>{r.key}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(r.revenue)}</td><td style={{ textAlign: "right" }}>{fmtNum(r.deals)}</td><td style={{ textAlign: "right" }}>{r.deals > 0 ? fmtFull(Math.round(r.revenue / r.deals)) : "—"}</td></tr>
      ))}</tbody>
    </table>
  );
  const card = (title: string, badge: ReactNode, body: ReactNode) => (
    <div style={{ padding: 12, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}><b style={{ fontSize: 13 }}>{title}</b>{badge}</div>
      {body}
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
      {card(`🧭 Напрямок (Тип запиту)`, mark(L.fillRates.requestType >= 90 ? "ok" : "proxy", `Fill-rate поля «Тип запиту»: ${L.fillRates.requestType}%. Виручка розкладена з ядра (Σ == отримано).`), splitTable(L.direction))}
      {card(`🏷 Канал продажу`, mark(L.fillRates.salesChannel >= 90 ? "ok" : "proxy", `Fill-rate поля «Канал продажу»: ${L.fillRates.salesChannel}%. Σ == отримано.`), splitTable(L.salesChannel))}
      {card("⏱ Транзитний час", mark("proxy", "load_at → unload_at. ⓘ unload = ДАТА АКТА (бухгалтерська), не фізичне розвантаження → трохи завищує."),
        <div style={{ fontSize: 14, fontWeight: 700 }}>{days(L.transit)}</div>)}
      {card("💳 DSO (проксі)", mark("proxy", "unload (дата акта) → closed (оплата/142). ⓘ Реальної банк-дати оплати в CRM НЕМА → проксі по даті закриття."),
        <div style={{ fontSize: 14, fontWeight: 700 }}>{days(L.dso)}</div>)}
      {card("🧮 Концентрація клієнтів", mark("ok", `Топ-${L.concentration.topN} клієнтів як % отриманої виручки (${L.concentration.clients} клієнтів з іменем).`),
        <div><div style={{ fontSize: 20, fontWeight: 700, color: (L.concentration.pct ?? 0) > 50 ? AMBER : "var(--text)" }}>{L.concentration.pct == null ? "—" : `${L.concentration.pct}%`}</div><div style={{ fontSize: 11, color: MUTED }}>топ-{L.concentration.topN} {fmtMoney(L.concentration.topRevenue)} з {fmtMoney(L.concentration.totalRevenue)}</div></div>)}
      {card("🔁 Повторні рейси", mark("ok", "Клієнти з оплатою в періоді, згруповані за к-тю оплачених рейсів."),
        <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}><thead><tr><th>Рейсів</th><th style={{ textAlign: "right" }}>Клієнтів</th><th style={{ textAlign: "right" }}>Виручка</th></tr></thead>
          <tbody>{L.repeatRides.map((r) => <tr key={r.bucket}><td>{r.bucket}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmtNum(r.clients)}</td><td style={{ textAlign: "right" }}>{fmtMoney(r.revenue)}</td></tr>)}</tbody></table>)}
      {card("📅 Прострочена дебіторка (aging)", mark("ok", "Неоплачені угоди з простроченою планова датою оплати, по кошиках днів прострочки."),
        <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}><thead><tr><th>Днів</th><th style={{ textAlign: "right" }}>Угод</th><th style={{ textAlign: "right" }}>Сума</th></tr></thead>
          <tbody>{L.aging.map((a) => <tr key={a.bucket}><td>{a.bucket}</td><td style={{ textAlign: "right", fontWeight: 600 }}>{fmtNum(a.count)}</td><td style={{ textAlign: "right" }}>{fmtMoney(a.sum)}</td></tr>)}</tbody></table>)}
      {card("💰 Маржа на авто", mark("none", "🔒 Заблоковано: собівартість (Видаток/Оплата перевізнику) заповнена ~0%. Поле в Kommo Є — потрібне заповнення менеджерами, не нове поле."),
        <div style={{ fontSize: 12, color: MUTED }}>Недоступно — заповніть собівартість рейсу в CRM.</div>)}
    </div>
  );
}

/** Горизонтальний div-бар (magnitude), 4px заокруглені кінці, статус-колір по %. */
function Bar({ pct, color, h = 8 }: { pct: number; color?: string; h?: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ background: "var(--border)", borderRadius: 4, height: h, width: "100%", overflow: "hidden" }}>
      <div style={{ width: `${w}%`, height: "100%", background: color ?? BLUE, borderRadius: 4 }} />
    </div>
  );
}

function Stat({ label, value, sub, hint, color }: { label: string; value: string; sub?: string; hint?: string; color?: string }) {
  return (
    <div style={{ padding: "12px 14px", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12 }}>
      <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 4 }}>{label}{hint && <InfoHint text={hint} />}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? "var(--text)", lineHeight: 1.2, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const curMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export function KvpReportSection() {
  const [preset, setPreset] = useState<string>(() => localStorage.getItem("kvpDPreset") || "month");
  const [monthSel, setMonthSel] = useState<string>(() => localStorage.getItem("kvpDMonth") || curMonth());
  const [range, setRange] = useState<{ from: string; to: string }>(() => { try { return JSON.parse(localStorage.getItem("kvpDRange") || "null") || { from: "", to: "" }; } catch { return { from: "", to: "" }; } });
  const [rep, setRep] = useState<KvpReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plans, setPlans] = useState<KvpPlans>({});
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [showLogi, setShowLogi] = useState(false);
  const [weekMode, setWeekMode] = useState<"money" | "activity">("money");
  // #6: тижнево-скоупований дрил — клік по клітинці тижня команди → менеджери ЦЬОГО тижня.
  const [openWeekDrill, setOpenWeekDrill] = useState<{ teamId: number; weekIdx: number } | null>(null);
  const [openMgr, setOpenMgr] = useState<number | null>(null);   // денний дрил менеджера (weeks→days)

  const rangeMode = !!(range.from && range.to);
  useEffect(() => {
    let alive = true; setRep(null); setErr(null);
    const params = rangeMode ? { from: range.from, to: range.to } : { preset, date: monthSel + "-01" };
    fetchKvpReport(params).then((r) => { if (alive) setRep(r); }).catch(() => { if (alive) setErr("Не вдалося завантажити звіт КВП."); });
    return () => { alive = false; };
  }, [preset, monthSel, rangeMode, range.from, range.to]);
  useEffect(() => { fetchKvpPlan(monthSel).then(setPlans).catch(() => setPlans({})); }, [monthSel]);

  const setPresetP = (p: string) => { setPreset(p); localStorage.setItem("kvpDPreset", p); setRange({ from: "", to: "" }); localStorage.removeItem("kvpDRange"); };
  const setRangeP = (r: { from: string; to: string }) => { setRange(r); localStorage.setItem("kvpDRange", JSON.stringify(r)); };
  const pickMonth = (v: string) => { const mm = v.slice(0, 7); setMonthSel(mm); localStorage.setItem("kvpDMonth", mm); };

  const v = rep?.verdict;
  const delta = v ? v.received.revenue - v.receivedPrev.revenue : 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 Звіт КВП</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {[["day", "День"], ["week", "Тиждень"], ["month", "Місяць"], ["quarter", "Квартал"], ["year", "Рік"]].map(([k, lbl]) => (
            <button key={k} onClick={() => setPresetP(k)}
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer",
                background: !rangeMode && preset === k ? "#c5141c" : "var(--card-bg)", color: !rangeMode && preset === k ? "#fff" : "var(--text)", fontWeight: !rangeMode && preset === k ? 600 : 400 }}>{lbl}</button>
          ))}
          <DatePicker mode="month" value={monthSel} onChange={(x) => x && pickMonth(x)} minWidth={140} />
          <span style={{ color: MUTED, margin: "0 2px" }}>|</span>
          <DatePicker value={range.from} onChange={(x) => setRangeP({ ...range, from: x })} placeholder="від" minWidth={120} />
          <span style={{ color: MUTED }}>—</span>
          <DatePicker value={range.to} onChange={(x) => setRangeP({ ...range, to: x })} placeholder="до" minWidth={120} />
          {rangeMode && <button onClick={() => { setRange({ from: "", to: "" }); localStorage.removeItem("kvpDRange"); }} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>✕</button>}
        </div>
      </div>

      {err && <p className="loading-text" style={{ color: RED }}>{err}</p>}
      {!rep && !err && <p className="loading-text">Завантаження…</p>}

      {rep && v && (
        <>
          {/* ── ВЕРДИКТ: де ми зараз ── */}
          <div className="chart-card" style={{ marginBottom: 16, borderTop: "3px solid #c5141c" }}>
            <h2 className="chart-title">📍 {rep.scope.label} — де ми зараз {rep.scope.isCurrent && <span style={{ fontSize: 12, color: MUTED }}>(період триває)</span>}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
              <Stat label="Отримані кошти" value={fmtMoney(v.received.revenue)} hint={HINT.received}
                sub={`${delta >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(delta))} до мин. періоду`} color={delta >= 0 ? GREEN : RED} />
              <Stat label="Стратегічний план 🔒" value={fmtMoney(v.strategicPlan)} hint={HINT.strategic}
                sub={`виконання ${fmtPct(v.planPct)}`} color={pctColor(v.planPct)} />
              <Stat label="Прогноз місяця" value={fmtMoney(v.projection.projected)} hint={HINT.projection}
                sub={`факт ${fmtMoney(v.projection.fact)} · ${v.projection.projectedPct}% плану`} />
              <Stat label="Робочі дні" value={`${v.projection.elapsedWorkingDays}/${v.projection.totalWorkingDays}`}
                sub="минуло / всього" />
            </div>
            {/* прогрес до плану */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: MUTED, marginBottom: 4 }}>
                <span>Виконання плану</span><span style={{ color: pctColor(v.planPct), fontWeight: 600 }}>{fmtPct(v.planPct)}</span>
              </div>
              <Bar pct={v.planPct ?? 0} color={pctColor(v.planPct)} h={10} />
            </div>
            {/* lifecycle-смуга */}
            <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>Життєвий цикл грошей<InfoHint text={HINT.lifecycle} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {([["Відправлено", v.lifecycle.sent, BLUE, HINT.sent], ["Очікуємо", v.lifecycle.awaiting, AMBER, HINT.awaiting], ["Отримано", v.lifecycle.received, GREEN, HINT.received]] as const).map(([lbl, agg, col, h]) => (
                <div key={lbl} style={{ padding: 10, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>{lbl}<InfoHint text={h} /></div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: col }}>{fmtMoney(agg.revenue)}</div>
                  <div style={{ fontSize: 11, color: MUTED }}>{agg.deals} авто</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── СИГНАЛИ ── */}
          {rep.signals.length > 0 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h2 className="chart-title">🚨 Сигнали (за гостротою)</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rep.signals.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 12px", borderLeft: `3px solid ${sevColor[s.severity]}`, background: "var(--card-bg)", borderRadius: 8 }}>
                    <span style={{ fontSize: 18 }}>{s.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: sevColor[s.severity] }}>{s.title}</div>
                      <div style={{ fontSize: 13, color: "var(--text)" }}>{s.detail}</div>
                      {s.expectedThisMonth != null && <div style={{ fontSize: 12, color: AMBER, marginTop: 2 }}>Очікування: цей міс {fmtMoney(s.expectedThisMonth)} · наступний {fmtMoney(s.expectedNextMonth ?? 0)}</div>}
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>→ {s.action}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ДВИГУНИ (4) ── */}
          <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginBottom: 16 }}>
            {([["🏭 РПК", rep.engines.rpk, false], ["📢 РНК", rep.engines.rnk, true]] as const).map(([lbl, e, showConv]) => (
              <div key={lbl} className="chart-card">
                <h2 className="chart-title">{lbl}</h2>
                <Stat label="Факт / план" value={`${fmtMoney(e.revenue)}`} sub={`план ${fmtMoney(e.plan)} · ${fmtPct(e.pct)}`} color={pctColor(e.pct)} hint={HINT.teamPlan} />
                <div style={{ margin: "8px 0" }}><Bar pct={e.pct ?? 0} color={pctColor(e.pct)} /></div>
                <div style={{ fontSize: 12, color: MUTED }}>Очікуємо: {fmtMoney(e.expected)}</div>
                {showConv && <div style={{ fontSize: 12, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>Конверсія: {fmtPct(e.conversion)} {e.entered < 10 && "(<10 лідів)"}<InfoHint text={HINT.conversion} /></div>}
              </div>
            ))}
            <div className="chart-card">
              <h2 className="chart-title">🎯 Реклама</h2>
              <Stat label="ROMI" value={fmtPct(rep.engines.ad.romi)} sub={`бюджет ${fmtMoney(rep.engines.ad.budget)} · дохід ${fmtMoney(rep.engines.ad.revenue)}`} hint={HINT.romi} />
              <div style={{ fontSize: 12, color: MUTED, marginTop: 6, display: "grid", gap: 2 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>CPA: {rep.engines.ad.cpa == null ? "—" : fmtMoney(rep.engines.ad.cpa)} {!rep.engines.ad.mature && "⏳"}<InfoHint text={HINT.cpa} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>CPL(GA): {rep.engines.ad.cplGa == null ? "—" : fmtMoney(rep.engines.ad.cplGa)}<InfoHint text={HINT.cplGa} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Конверсія: {fmtPct(rep.engines.ad.conversion)} {!rep.engines.ad.mature && "⏳"}<InfoHint text={HINT.conversion} /></span>
              </div>
            </div>
            <div className="chart-card">
              <h2 className="chart-title">📞 Лідген (3 якорі)</h2>
              <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Передані: <b>{fmtNum(rep.engines.leadgen.transferred)}</b><InfoHint text={HINT.transferred} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Поїхали: <b>{fmtNum(rep.engines.leadgen.dispatched)}</b> ({fmtMoney(rep.engines.leadgen.dispatchedRevenue)})<InfoHint text={HINT.lgDispatched} /></span>
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Дохід: <b>{fmtMoney(rep.engines.leadgen.revenue)}</b><InfoHint text={HINT.lgRevenue} /></span>
              </div>
              <p style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Три якорі не зводяться в межах місяця.</p>
            </div>
          </div>

          {/* ── КОМАНДИ → менеджери drill ── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <h2 className="chart-title" style={{ margin: 0 }}>🏅 Команди — план / факт {rep.weekBlocks.length > 0 && <span style={{ fontSize: 12, color: MUTED }}>(+ тижні Т1–Т{rep.weekBlocks.length}) </span>}<InfoHint text="Клік по команді → менеджери → клік менеджера → денний дрил. Клік по клітинці тижня → менеджери саме цього тижня → денний дрил тижня. Т1–Т5 = фіксовані блоки місяця (1-7/8-14/15-21/22-28/29-кінець). Тижневий факт = отримано за датою оплати; ✓/✗ = факт ≥ план тижня; майбутні тижні = план+очікування (у виконання НЕ входить). Вертикальна риска на смузі = темп (де мали б бути на сьогодні)." /></h2>
              {rep.weekBlocks.length > 0 && (
                <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", fontSize: 12 }}>
                  {([["money", "💰 Гроші"], ["activity", "⚙️ Активність"]] as const).map(([k, lbl]) => (
                    <button key={k} onClick={() => setWeekMode(k)}
                      style={{ padding: "5px 12px", border: "none", cursor: "pointer", background: weekMode === k ? "#c5141c" : "var(--card-bg)", color: weekMode === k ? "#fff" : "var(--text)", fontWeight: weekMode === k ? 600 : 400 }}>{lbl}</button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ width: "100%", tableLayout: "fixed", minWidth: 640 + rep.weekBlocks.length * WK_W }}>
                <colgroup>
                  <col style={{ width: 216 }} />
                  <col style={{ width: 84 }} /><col style={{ width: 84 }} /><col style={{ width: 108 }} /><col style={{ width: 88 }} /><col style={{ width: 56 }} />
                  {rep.weekBlocks.map((w) => <col key={w.idx} style={{ width: WK_W }} />)}
                </colgroup>
                <thead><tr>
                  <th>Команда / менеджер</th>
                  <th style={{ textAlign: "right" }}>План</th><th style={{ textAlign: "right" }}>Факт</th><th>Вик. %</th><th style={{ textAlign: "right" }}>Очікуємо</th><th style={{ textAlign: "right" }}>Конв.</th>
                  {rep.weekBlocks.map((w) => <th key={w.idx} style={{ textAlign: "right", fontSize: 10, background: w.isCurrent ? "rgba(37,99,235,0.08)" : undefined }}>Т{w.idx}<div style={{ color: MUTED, fontWeight: 400 }}>{w.from.slice(8)}–{w.to.slice(8)}</div></th>)}
                </tr></thead>
                <tbody>
                  {rep.teams.map((t) => (
                    <Fragment key={t.teamId}>
                      <tr onClick={() => setOpenTeam(openTeam === t.teamId ? null : t.teamId)} style={{ cursor: "pointer" }}>
                        <td style={clip}>{openTeam === t.teamId ? "▾" : "▸"} <b>{t.name}</b> <span style={{ fontSize: 11, color: MUTED }}>{teamKindLabel[t.kind]}{t.kind === "leadgen" && <InfoHint text="Відділ лідогенерації — показано у списку команд, але його метрики продажів рахуються окремою логікою (задача на потім, не плутати з РПК/повним циклом)." />}</span></td>
                        <td style={{ textAlign: "right" }}>{fmtMoney(t.plan)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(t.revenue)}</td>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><Bar pct={t.pct ?? 0} color={pctColor(t.pct)} /><span style={{ color: pctColor(t.pct), fontWeight: 600, minWidth: 38, textAlign: "right" }}>{fmtPct(t.pct)}</span></div></td>
                        <td style={{ textAlign: "right", color: MUTED }}>{fmtMoney(t.expected)}</td>
                        <td style={{ textAlign: "right" }}>{t.kind === "rnk" ? fmtPct(t.conversion) : "—"}</td>
                        {rep.weekBlocks.map((w) => (
                          <WeekCell key={w.idx} mode={weekMode}
                            w={t.weeks?.find((x) => x.idx === w.idx)}
                            prev={t.weeks?.find((x) => x.idx === w.idx - 1)}
                            active={openWeekDrill?.teamId === t.teamId && openWeekDrill?.weekIdx === w.idx}
                            onClick={() => setOpenWeekDrill((cur) => cur?.teamId === t.teamId && cur?.weekIdx === w.idx ? null : { teamId: t.teamId, weekIdx: w.idx })} />
                        ))}
                      </tr>
                      {openWeekDrill?.teamId === t.teamId && <WeekManagerDrill team={t} weekIdx={openWeekDrill.weekIdx} weekBlocks={rep.weekBlocks} />}
                      {/* Менеджери — ІНЛАЙН у тій самій таблиці (той самий <colgroup>) → тижневі колонки
                          збігаються попіксельно з командними. Клік по імені = денний дрил weeks→days. */}
                      {openTeam === t.teamId && t.managers.map((m: KvpManager) => {
                        const lagging = m.pct != null && m.pct < 70 && m.plan > 0;
                        const open = openMgr === m.managerId;
                        return (
                          <Fragment key={m.managerId}>
                            <tr onClick={() => setOpenMgr(open ? null : m.managerId)} style={{ cursor: "pointer", background: "var(--bg)" }}>
                              <td style={{ ...clip, paddingLeft: 26 }}>{open ? "▾" : "▸"} {m.name}</td>
                              <td style={{ textAlign: "right" }}>{fmtMoney(m.plan)}</td>
                              <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(m.revenue)}</td>
                              <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><Bar pct={m.pct ?? 0} color={pctColor(m.pct)} /><span style={{ color: pctColor(m.pct), fontWeight: 600, minWidth: 38, textAlign: "right" }}>{fmtPct(m.pct)}</span></div></td>
                              <td style={{ textAlign: "right", color: MUTED }}>{fmtMoney(m.expected)}</td>
                              <td style={{ textAlign: "right" }}>{t.kind === "rnk" ? (m.conversion == null ? "—" : `${m.conversion}%`) : "—"}</td>
                              {rep.weekBlocks.map((w) => <WeekCell key={w.idx} mode={weekMode} w={m.weeks?.find((x) => x.idx === w.idx)} prev={m.weeks?.find((x) => x.idx === w.idx - 1)} />)}
                            </tr>
                            {lagging && (
                              <tr><td colSpan={6 + rep.weekBlocks.length} style={{ paddingLeft: 26, background: "rgba(220,38,38,0.06)", fontSize: 12, color: RED }}>
                                ⚠️ {m.name} відстає ({m.pct}% плану). {m.successDeals < 3 ? "Мало закритих угод" : "Є угоди, але недобір суми"}{t.kind === "rnk" && m.conversion != null && m.conversion < (t.conversion ?? 0) ? ` · конверсія ${m.conversion}% нижча за команду` : ""}. → перевірити пайплайн і темп по днях.
                              </td></tr>
                            )}
                            {open && (
                              <tr><td colSpan={6 + rep.weekBlocks.length} style={{ padding: "8px 8px 12px 40px", background: "var(--card-bg)" }}>
                                <ManagerDetailDrill managerId={m.managerId} from={rep.scope.from} to={rep.scope.to} isRnk={t.kind === "rnk"} />
                              </td></tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                  {/* #5: розріз відділу по тижнях = Σ команд (гейт Σ Dept == Σ teams == Σ days) */}
                  {rep.deptWeeks.length > 0 && (
                    <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 600 }}>
                      <td style={clip}>Σ Відділ</td>
                      <td style={{ textAlign: "right" }}>{fmtMoney(rep.teams.reduce((s, t) => s + t.plan, 0))}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{fmtMoney(rep.teams.reduce((s, t) => s + t.revenue, 0))}</td>
                      <td colSpan={3}></td>
                      {rep.deptWeeks.map((w) => (
                        <WeekCell key={w.idx} mode={weekMode} w={w} prev={rep.deptWeeks.find((x) => x.idx === w.idx - 1)} />
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── ЯКІСТЬ / ЛОЯЛЬНІСТЬ + РИЗИКИ ── */}
          <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginBottom: 16 }}>
            <div className="chart-card"><StructureBlock rep={rep} /></div>
            <div className="chart-card">
              <h2 className="chart-title">🔁 Ризики / retention</h2>
              <RetentionBlock rep={rep} />
            </div>
          </div>

          <LeadgenRegularsCard />

          {/* ── ПОВНА ТАБЛИЦЯ (під катом) ── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title" style={{ cursor: "pointer" }} onClick={() => setShowFull(!showFull)}>{showFull ? "▾" : "▸"} 📋 Повна таблиця</h2>
            {showFull && <FullTable rep={rep} plans={plans} onSave={(k, val) => { setPlans((p) => { const n = { ...p }; if (val == null) delete n[k]; else n[k] = val; return n; }); saveKvpPlan(monthSel, { [k]: val }).catch(() => {}); }} />}
          </div>

          {/* ── 🚚 ЛОГІСТИКА (під катом) ── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <h2 className="chart-title" style={{ cursor: "pointer" }} onClick={() => setShowLogi(!showLogi)}>{showLogi ? "▾" : "▸"} 🚚 Логістика</h2>
            {showLogi && <LogisticsSection rep={rep} />}
          </div>
        </>
      )}
    </>
  );
}

// Крок Д фінал A — ЛІНИВИЙ ДЕТАЛЬНИЙ дрил менеджера weeks→days (fetch при розкритті).
// Тижні Т1–Т5, «Разом» = Σ днів; клік тижня → дні. Поточний тиждень відкрито; майбутні
// — лише очікування. Колонки: створено · ліди р/лг · авто · отримано · очікування.
function ManagerDetailDrill({ managerId, from, to }: { managerId: number; from: string; to: string; isRnk: boolean }) {
  const [d, setD] = useState<KvpManagerDetail | null>(null);
  const [err, setErr] = useState(false);
  const [openW, setOpenW] = useState<Set<number>>(new Set());
  useEffect(() => {
    let a = true; setD(null); setErr(false);
    fetchManagerDetail({ managerId, from, to }).then((x) => { if (!a) return; setD(x); setOpenW(new Set(x.weeks.filter((w) => w.isCurrent).map((w) => w.idx))); }).catch(() => a && setErr(true));
    return () => { a = false; };
  }, [managerId, from, to]);
  if (err) return <div style={{ fontSize: 12, color: RED }}>Не вдалося завантажити деталь.</div>;
  if (!d) return <div style={{ fontSize: 12, color: MUTED }}>Завантаження деталі…</div>;
  // Середній чек = отримано ÷ авто (ПОХІДНИЙ, не сумується — перераховується на кожному
  // рівні з received.revenue ÷ dispatched; «—» де авто=0).
  const cell = (c: { created: number; leadsAd: number; leadsLeadgen: number; dispatched: number; received: { revenue: number; deals: number }; expected: { sum: number } }, future: boolean) => (<>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.created || "—")}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.leadsAd || "—")}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.leadsLeadgen || "—")}</td>
    <td style={{ textAlign: "right" }}>{future ? "—" : (c.dispatched || "—")}</td>
    <td style={{ textAlign: "right", fontWeight: 600 }}>{future ? "—" : (c.received.deals ? fmtMoney(c.received.revenue) : "—")}</td>
    <td style={{ textAlign: "right" }}>{future || c.dispatched === 0 ? "—" : fmtFull(Math.round(c.received.revenue / c.dispatched))}</td>
    <td style={{ textAlign: "right", color: AMBER }}>{c.expected.sum ? fmtMoney(c.expected.sum) : "—"}</td>
  </>);
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}>
        <thead><tr><th>Тиждень / день</th><th style={{ textAlign: "right" }}>Створено</th><th style={{ textAlign: "right" }}>Ліди рекл.</th><th style={{ textAlign: "right" }}>Ліди лідоген</th><th style={{ textAlign: "right" }}>Авто</th><th style={{ textAlign: "right" }}>Отримано</th><th style={{ textAlign: "right" }}>Чек</th><th style={{ textAlign: "right" }}>Очікування</th></tr></thead>
        <tbody>
          {d.weeks.map((w) => {
            const open = openW.has(w.idx);
            return (
              <Fragment key={w.idx}>
                <tr onClick={() => setOpenW((s) => { const n = new Set(s); n.has(w.idx) ? n.delete(w.idx) : n.add(w.idx); return n; })}
                  style={{ cursor: "pointer", background: w.isCurrent ? "rgba(37,99,235,0.08)" : "var(--bg)", fontWeight: 600 }}>
                  <td>{open ? "▾" : "▸"} Т{w.idx} <span style={{ color: MUTED, fontWeight: 400 }}>{w.from.slice(8)}–{w.to.slice(8)}</span> Разом{w.isCurrent && " ●"}</td>
                  {cell(w.total, w.isFuture)}
                </tr>
                {open && w.days.map((x) => (
                  <tr key={x.day}>
                    <td style={{ paddingLeft: 24, color: MUTED }}>{x.day.slice(8)}.{x.day.slice(5, 7)}</td>
                    {cell(x, w.isFuture)}
                  </tr>
                ))}
                {open && w.days.length === 0 && <tr><td colSpan={8} style={{ paddingLeft: 24, color: MUTED, fontSize: 11 }}>Немає активності.</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const wkPct = (fact: number, plan: number) => (plan > 0 ? Math.round((fact / plan) * 100) : null);
const pctOf = (fact: number, plan: number | null): number | null => (plan && plan > 0 ? Math.round((fact / plan) * 100) : null);
const barColor = (p: number | null) => (p == null ? MUTED : p >= 100 ? GREEN : p >= 70 ? AMBER : RED);
type WeekLike = { plan: number; fact: number; expected: number; auto: number; leadsAd: number; leadsLeadgen: number; isCurrent: boolean; isFuture: boolean; pace: number | null };
// Фіксована ширина КОЖНОЇ тижневої колонки (команди, відділ, менеджери) — одна вертикальна
// сітка. table-layout:fixed + <colgroup> кріплять ці ширини, contain обрізає переповнення.
const WK_W = 94;
const wkTd = (bg?: string, clickable?: boolean): CSSProperties => ({
  width: WK_W, maxWidth: WK_W, boxSizing: "border-box", padding: "3px 7px", textAlign: "right",
  background: bg, cursor: clickable ? "pointer" : undefined, overflow: "hidden", verticalAlign: "middle",
});
const clip: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
// Компактна клітинка тижня — max 3 рядки: «факт /план» · бар(колір+темп) · «% ✓/✗ ↑↓».
// Очікування ЛИШЕ на майбутніх тижнях (минуле/поточне не дублює колонку «Очікуємо»).
// mode 'activity' → авто·ліди. onClick (лише командні) → менеджери цього тижня.
function WeekCell({ w, prev, mode, onClick, active }: { w: WeekLike | undefined; prev?: WeekLike; mode: "money" | "activity"; onClick?: () => void; active?: boolean }) {
  const bg = active ? "rgba(197,20,28,0.12)" : w?.isCurrent ? "rgba(37,99,235,0.07)" : undefined;
  const handle = onClick ? (e: { stopPropagation: () => void }) => { e.stopPropagation(); onClick(); } : undefined;
  if (!w) return <td style={{ ...wkTd(bg), textAlign: "center", color: MUTED, fontSize: 11 }}>—</td>;
  if (mode === "activity") return (
    <td onClick={handle} style={{ ...wkTd(bg, !!onClick), fontSize: 11 }}>
      {w.isFuture ? <span style={{ color: MUTED }}>—</span> : <>
        <div style={{ ...clip, fontWeight: 700 }}>{w.auto}<span style={{ fontWeight: 400, color: MUTED, fontSize: 10 }}> авто</span></div>
        <div style={{ ...clip, color: MUTED, fontSize: 10 }}>{w.leadsAd}р · {w.leadsLeadgen}лг</div>
      </>}
    </td>
  );
  if (w.isFuture) return (
    <td onClick={handle} style={{ ...wkTd(bg, !!onClick), fontSize: 10, color: MUTED }}>
      <div style={clip}>план {fmtMoney(w.plan)}</div>
      {w.expected > 0 && <div style={{ ...clip, color: AMBER }}>очік {fmtMoney(w.expected)}</div>}
    </td>
  );
  const p = wkPct(w.fact, w.plan), pp = prev ? wkPct(prev.fact, prev.plan) : null, col = barColor(p);
  const trend = p != null && pp != null ? (p > pp ? "↑" : p < pp ? "↓" : "") : "";
  return (
    <td onClick={handle} style={{ ...wkTd(bg, !!onClick), fontSize: 11 }}>
      <div style={{ ...clip, lineHeight: 1.25 }}><b>{fmtMoney(w.fact)}</b><span style={{ color: MUTED, fontSize: 10 }}> /{fmtMoney(w.plan)}</span></div>
      <div style={{ position: "relative", height: 5, background: "var(--border)", borderRadius: 3, margin: "2px 0" }}>
        <div style={{ width: `${Math.min(100, p ?? 0)}%`, height: "100%", background: col, borderRadius: 3 }} />
        {w.isCurrent && w.pace != null && <span title="темп: де мали б бути на сьогодні" style={{ position: "absolute", left: `${Math.min(100, Math.max(0, w.pace * 100))}%`, top: -1, bottom: -1, width: 1.5, background: "var(--text)", opacity: 0.65 }} />}
      </div>
      <div style={{ ...clip, color: col, fontWeight: 600, fontSize: 10, lineHeight: 1.1 }}>{p == null ? "—" : `${p >= 100 ? "✓" : "✗"} ${p}%`}{trend && <span style={{ color: trend === "↑" ? GREEN : RED, marginLeft: 3 }}>{trend}</span>}</div>
    </td>
  );
}

// #6: тижнево-скоупований дрил — менеджери ЦЬОГО тижня (факт/план тижня), клік → денний дрил
// саме цього тижня (ManagerDetailDrill з from/to = межі тижня). Не ламає «клік по команді».
function WeekManagerDrill({ team, weekIdx, weekBlocks }: { team: KvpTeam; weekIdx: number; weekBlocks: KvpReport["weekBlocks"] }) {
  const [openMgr, setOpenMgr] = useState<number | null>(null);
  const wb = weekBlocks.find((x) => x.idx === weekIdx);
  const cols = 4 + (team.kind === "rnk" ? 1 : 0);
  if (!wb) return null;
  const from = wb.from, to = wb.to;
  const rows = team.managers.map((m) => {
    const w = m.weeks?.find((x) => x.idx === weekIdx);
    return { m, plan: w?.plan ?? 0, fact: w?.fact ?? 0, expected: w?.expected ?? 0, isFuture: w?.isFuture ?? false };
  });
  return (
    <tr><td colSpan={6 + weekBlocks.length} style={{ padding: 0, background: "rgba(197,20,28,0.04)" }}>
      <div style={{ padding: "6px 12px", fontSize: 12, color: MUTED }}>📅 Т{weekIdx} ({from.slice(8)}–{to.slice(8)}) — менеджери цього тижня <span style={{ color: MUTED }}>(клік = дні тижня)</span></div>
      <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}>
        <thead><tr><th style={{ paddingLeft: 28 }}>Менеджер</th><th style={{ textAlign: "right" }}>План тижня</th><th style={{ textAlign: "right" }}>Факт тижня</th><th style={{ minWidth: 70 }}>%</th></tr></thead>
        <tbody>
          {rows.map(({ m, plan, fact, expected, isFuture }) => {
            const pct = plan > 0 ? Math.round((fact / plan) * 100) : null;
            const open = openMgr === m.managerId;
            return (
              <Fragment key={m.managerId}>
                <tr onClick={() => setOpenMgr(open ? null : m.managerId)} style={{ cursor: "pointer" }}>
                  <td style={{ paddingLeft: 28 }}>{open ? "▾" : "▸"} {m.name}</td>
                  <td style={{ textAlign: "right", color: MUTED }}>{fmtMoney(plan)}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{isFuture ? <span style={{ color: AMBER, fontWeight: 400 }}>очік {fmtMoney(expected)}</span> : fmtMoney(fact)}</td>
                  <td>{isFuture ? "—" : <span style={{ color: pctColor(pct), fontWeight: 600 }}>{pct == null ? "—" : `${pct >= 100 ? "✓" : "✗"} ${pct}%`}</span>}</td>
                </tr>
                {open && (
                  <tr><td colSpan={cols} style={{ padding: "8px 8px 12px 40px", background: "var(--card-bg)" }}>
                    <ManagerDetailDrill managerId={m.managerId} from={from} to={to} isRnk={team.kind === "rnk"} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </td></tr>
  );
}

function StructureBlock({ rep }: { rep: KvpReport }) {
  const rs = rep.revenueStructure;
  const rTotal = rs.received.total.revenue;
  const sumSeg = rs.received.new.revenue + rs.received.repeat.revenue + rs.received.unattributed.revenue;
  const reconcilesOk = Math.abs(sumSeg - rTotal) < 1;
  const seg = (label: string, recv: { deals: number; revenue: number }, exp: { deals: number; sum: number }, color: string) => (
    <div style={{ padding: 10, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
      <div style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 11, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>Отримано<InfoHint text={HINT.structReceived} /></span>
        <span style={{ fontWeight: 700, color }}>{fmtMoney(recv.revenue)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>В очікуванні<InfoHint text={HINT.structExpected} /></span>
        <span style={{ fontWeight: 600, color: AMBER }}>{fmtMoney(exp.sum)}</span>
      </div>
    </div>
  );
  return (
    <>
      <h2 className="chart-title">💎 Структура виручки — 2 етапи <InfoHint text={HINT.newRepeat} /></h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {seg("Нові клієнти", rs.received.new, rs.expected.new, BLUE)}
        {seg("Постійні клієнти", rs.received.repeat, rs.expected.repeat, GREEN)}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: MUTED, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>Не віднесено (без клієнта): отримано <b style={{ color: "var(--text)" }}>{fmtMoney(rs.received.unattributed.revenue)}</b> · в очікуванні <b style={{ color: "var(--text)" }}>{fmtMoney(rs.expected.unattributed.sum)}</b><InfoHint text="Угоди без client_key — немає по чому віднести до нового/постійного. Показано ЯВНО, не сховано." /></span>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: reconcilesOk ? GREEN : RED }}>
        {reconcilesOk ? "✅" : "⚠️"} Σ отримано (нові {fmtMoney(rs.received.new.revenue)} + постійні {fmtMoney(rs.received.repeat.revenue)} + залишок {fmtMoney(rs.received.unattributed.revenue)}) = {fmtMoney(sumSeg)} {reconcilesOk ? "==" : "≠"} каса {fmtMoney(rTotal)}
      </div>
    </>
  );
}

function RetentionBlock({ rep }: { rep: KvpReport }) {
  const mature = rep.retention.newToRepeat.filter((r) => r.mature).slice(-1)[0];
  const ab = rep.retention.activeBase.slice(-1)[0];
  return (
    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>% нових→постійних: <b>{mature ? fmtPct(mature.pct) : "⏳"}</b> {mature && <span style={{ color: MUTED }}>({mature.ym}, зрілий)</span>}<InfoHint text={HINT.newToRepeat} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Активність бази: <b>{fmtNum(ab?.activeClients ?? null)}</b> <span style={{ color: MUTED }}>клієнтів ({ab?.ym})</span><InfoHint text={HINT.activeBase} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Постійні щотижня: <b>{fmtNum(rep.retention.weeklyRegulars.clients)}</b><InfoHint text={HINT.weeklyRegulars} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Нецільові: <b>{rep.retention.nonTarget == null ? "—" : fmtNum(rep.retention.nonTarget)}</b><InfoHint text={HINT.nonTarget} /></span>
      <span style={{ display: "flex", alignItems: "center", gap: 4, color: MUTED }}>Погашено дебіторки: <b>—</b><InfoHint text={HINT.receivablesPaidOff} /></span>
    </div>
  );
}

// Блок A — повна таблиця: місяць (факт/план/%) + Т1–Т5 (факт/план) для показників з
// тижневою природою; ратіо/знімки — місяць-онлі (тижневі «—»). Місячний план ✎ КВП-ручних
// живо декомпозується на тижні за робочими днями. Нові метрики — окрема група.
function FullTable({ rep, plans, onSave }: { rep: KvpReport; plans: KvpPlans; onSave: (k: string, v: number | null) => void }) {
  const m = rep.money, rs = rep.revenueStructure, en = rep.engines, nm = rep.newMetrics, wb = rep.weekBlocks;
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const planVal = (k: string): number | null => (k in draft ? draft[k] : (plans[k] ?? null));
  const wdMonth = wb.reduce((a, w) => a + w.workingDays, 0) || 1;
  const dw = (wi: number) => rep.deptWeeks.find((x) => x.idx === wi);
  const decomp = (monthPlan: number | null, wi: number) => (monthPlan == null ? null : monthPlan * (wb.find((w) => w.idx === wi)?.workingDays ?? 0) / wdMonth);
  const editCell = (k: string) => (
    <input type="number" value={planVal(k) ?? ""} placeholder="—"
      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value === "" ? null : Number(e.target.value) }))}
      onBlur={(e) => onSave(k, e.target.value === "" ? null : Number(e.target.value))}
      style={{ width: 76, textAlign: "right", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "1px 5px", fontSize: 12 }} />
  );
  // weekly cell: fact над plan (компактно, фікс.ширина). money/num formatter.
  const wkCell = (f: number | null, p: number | null, money: boolean) => {
    const fmt = money ? fmtMoney : (v: number) => fmtNum(Math.round(v));
    return (
      <td style={{ ...wkTd(), fontSize: 10 }}>
        {f == null && p == null ? <span style={{ color: MUTED }}>—</span> : <>
          <div style={{ ...clip, fontWeight: 700 }}>{f == null ? "—" : fmt(f)}</div>
          <div style={{ ...clip, color: MUTED }}>{p == null ? "" : `/${fmt(p)}`}</div>
        </>}
      </td>
    );
  };
  const dash = <td style={{ ...wkTd(), color: MUTED, fontSize: 10 }}>—</td>;
  type Row = { label: string; hint?: string; fact: string; pct?: number | null; planKey?: string; planFixed?: string;
    // weekly: per-idx {f,p} у сирих числах + money-прапор; null → «—»
    wk?: null | { money: boolean; f: (wi: number) => number | null; p: (wi: number) => number | null } };
  const groups: [string, Row[]][] = [
    ["💰 Дохід (тижнева природа)", [
      { label: "Отримано (каса)", hint: HINT.received, fact: fmtMoney(m.received.revenue), planFixed: fmtMoney(rep.strategicPlan) + " 🔒", pct: rep.verdict.planPct,
        wk: { money: true, f: (wi) => dw(wi)?.fact ?? null, p: (wi) => dw(wi)?.plan ?? null } },
      { label: "Поставлені авто", hint: HINT.sent, fact: fmtNum(rep.verdict.lifecycle.sent.deals), planKey: "dispatched_cars",
        pct: pctOf(rep.verdict.lifecycle.sent.deals, planVal("dispatched_cars")),
        wk: { money: false, f: (wi) => dw(wi)?.auto ?? null, p: (wi) => decomp(planVal("dispatched_cars"), wi) } },
      { label: "Ліди реклама", hint: HINT.conversion, fact: fmtNum(rep.deptWeeks.reduce((a, w) => a + w.leadsAd, 0)), planKey: "ad_leads",
        pct: pctOf(rep.deptWeeks.reduce((a, w) => a + w.leadsAd, 0), planVal("ad_leads")),
        wk: { money: false, f: (wi) => dw(wi)?.leadsAd ?? null, p: (wi) => decomp(planVal("ad_leads"), wi) } },
      { label: "Ліди лідоген", hint: HINT.transferred, fact: fmtNum(rep.deptWeeks.reduce((a, w) => a + w.leadsLeadgen, 0)),
        wk: { money: false, f: (wi) => dw(wi)?.leadsLeadgen ?? null, p: () => null } },
    ]],
    ["📸 Ратіо / знімки (місяць-онлі)", [
      { label: "Дохід в очікуванні (зона)", hint: HINT.structExpected, fact: fmtMoney(m.expectedZoneTotal.sum), wk: null },
      { label: "Успішно закриті (142)", hint: "Статус 142 за датою закриття в періоді.", fact: fmtMoney(m.success.revenue), wk: null },
      { label: "Середній чек (ціль)", hint: "КВП-ручна ціль (звірка з листом 2600–2900).", fact: en.ad.conversion != null ? "—" : "—", planKey: "avg_check", wk: null },
      { label: "Конверсія реклами", hint: HINT.conversion, fact: en.ad.conversion == null ? "—" : `${en.ad.conversion}%${en.ad.mature ? "" : " ⏳"}`, wk: null },
    ]],
    ["🔮 Нові метрики (місяць-онлі)", [
      { label: "Прогноз місяця", hint: HINT.projection, fact: `${fmtMoney(nm.forecast.projected)}${nm.forecast.projectedPct == null ? "" : ` (${nm.forecast.projectedPct}%)`}`, wk: null },
      { label: "Потрібний темп/день", hint: `Залишок плану ${fmtMoney(nm.remainingPlan)} ÷ ${nm.remainingWorkingDays} роб. днів, що лишились.`, fact: nm.neededPacePerDay == null ? "—" : `${fmtMoney(nm.neededPacePerDay)}/день`, wk: null },
      { label: "Прострочена оплата", hint: "planned_payment_at минув, а угода ще не оплачена (не 142/143, не етап 9). Знімок «зараз».", fact: `${fmtMoney(nm.overduePayments.sum)} · ${nm.overduePayments.count} угод`, wk: null },
      { label: "CAC (вартість клієнта)", hint: `Рекламний бюджет ${fmtMoney(nm.cacBudget)} ÷ ${nm.cacNewClients} нових клієнтів.`, fact: nm.cac == null ? "—" : fmtFull(nm.cac), wk: null },
      { label: "Середній цикл угоди", hint: "Днів від створення (лід) до закриття (142). ⓘ created≈лід, closed≈оплата — банк-дати нема.", fact: nm.avgCycleDays == null ? "—" : `${nm.avgCycleDays} днів`, wk: null },
      { label: "Втрачені", hint: "Відмови (143 у періоді) + нецільові ліди.", fact: `${nm.lost.deals} угод · ${fmtMoney(nm.lost.sum)}${nm.lost.nonTargetLeads != null ? ` · ${nm.lost.nonTargetLeads} нецільових` : ""}`, wk: null },
    ]],
    ["🆕 / 🔁 Клієнти (місяць-онлі)", [
      { label: "Нові — отримано / очікування", hint: HINT.structReceived, fact: `${fmtMoney(rs.received.new.revenue)} / ${fmtMoney(rs.expected.new.sum)}`, wk: null },
      { label: "Постійні — отримано / очікування", hint: HINT.structReceived, fact: `${fmtMoney(rs.received.repeat.revenue)} / ${fmtMoney(rs.expected.repeat.sum)}`, wk: null },
    ]],
  ];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%", tableLayout: "fixed", minWidth: 520 + wb.length * WK_W }}>
        <colgroup><col style={{ width: 210 }} /><col style={{ width: 128 }} /><col style={{ width: 96 }} /><col style={{ width: 64 }} />{wb.map((w) => <col key={w.idx} style={{ width: WK_W }} />)}</colgroup>
        <thead><tr>
          <th>Показник</th><th style={{ textAlign: "right" }}>Місяць (факт)</th><th style={{ textAlign: "right" }}>План ✎</th><th>%</th>
          {wb.map((w) => <th key={w.idx} style={{ textAlign: "right", fontSize: 10, background: w.isCurrent ? "rgba(37,99,235,0.08)" : undefined }}>Т{w.idx}</th>)}
        </tr></thead>
        <tbody>
          {groups.map(([grp, rows]) => (
            <Fragment key={grp}>
              <tr><td colSpan={4 + wb.length} style={{ fontWeight: 700, background: "var(--bg)", paddingTop: 8 }}>{grp}</td></tr>
              {rows.map((r) => (
                <tr key={grp + r.label}>
                  <td style={clip}><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{r.label}{r.hint && <InfoHint text={r.hint} />}</span></td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{r.fact}</td>
                  <td style={{ textAlign: "right" }}>{r.planKey ? editCell(r.planKey) : r.planFixed ? <span style={{ color: MUTED, fontSize: 12 }}>{r.planFixed}</span> : <span style={{ color: MUTED }}>—</span>}</td>
                  <td>{r.pct == null ? <span style={{ color: MUTED }}>—</span> : <span style={{ color: pctColor(r.pct), fontWeight: 600, fontSize: 12 }}>{r.pct}%</span>}</td>
                  {wb.map((w) => r.wk ? wkCell(r.wk.f(w.idx), r.wk.p(w.idx), r.wk.money) : <Fragment key={w.idx}>{dash}</Fragment>)}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

