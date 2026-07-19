import { Fragment, useEffect, useState } from "react";
import { fetchKvpReport, fetchKvpPlan, saveKvpPlan, fetchManagerDaily, type KvpReport, type KvpPlans, type KvpTeam, type KvpManager, type KvpManagerDaily, type KvpWeek } from "../../../api";
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
            <h2 className="chart-title">🏅 Команди — план / факт {rep.weekBlocks.length > 0 && <span style={{ fontSize: 12, color: MUTED }}>(+ тижні Т1–Т{rep.weekBlocks.length}) </span>}<InfoHint text="Клік по команді → менеджери → клік менеджера → денний дрил. Т1–Т5 = фіксовані блоки місяця (1-7/8-14/15-21/22-28/29-кінець). Тижневий факт = отримано за датою оплати; ✓/✗ = факт ≥ план тижня; майбутні тижні = план+очікування (у виконання НЕ входить). Наведи на клітинку для деталей." /></h2>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ width: "100%" }}>
                <thead><tr><th>Команда</th><th style={{ textAlign: "right" }}>План</th><th style={{ textAlign: "right" }}>Факт</th><th style={{ minWidth: 110 }}>Вик. %</th><th style={{ textAlign: "right" }}>Очікуємо</th><th style={{ textAlign: "right" }}>Конв.</th>{rep.weekBlocks.map((w) => <th key={w.idx} style={{ textAlign: "right", fontSize: 10, background: w.isCurrent ? "rgba(37,99,235,0.08)" : undefined }}>Т{w.idx}<div style={{ color: MUTED, fontWeight: 400 }}>{w.from.slice(8)}–{w.to.slice(8)}</div></th>)}</tr></thead>
                <tbody>
                  {rep.teams.map((t) => (
                    <Fragment key={t.teamId}>
                      <tr onClick={() => setOpenTeam(openTeam === t.teamId ? null : t.teamId)} style={{ cursor: "pointer" }}>
                        <td>{openTeam === t.teamId ? "▾" : "▸"} <b>{t.name}</b> <span style={{ fontSize: 11, color: MUTED }}>{teamKindLabel[t.kind]}{t.kind === "leadgen" && <InfoHint text="Відділ лідогенерації — показано у списку команд, але його метрики продажів рахуються окремою логікою (задача на потім, не плутати з РПК/повним циклом)." />}</span></td>
                        <td style={{ textAlign: "right" }}>{fmtMoney(t.plan)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(t.revenue)}</td>
                        <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><Bar pct={t.pct ?? 0} color={pctColor(t.pct)} /><span style={{ color: pctColor(t.pct), fontWeight: 600, minWidth: 42, textAlign: "right" }}>{fmtPct(t.pct)}</span></div></td>
                        <td style={{ textAlign: "right", color: MUTED }}>{fmtMoney(t.expected)}</td>
                        <td style={{ textAlign: "right" }}>{t.kind === "rnk" ? fmtPct(t.conversion) : "—"}</td>
                        {rep.weekBlocks.map((w) => <WeekCell key={w.idx} w={t.weeks?.find((x) => x.idx === w.idx)} />)}
                      </tr>
                      {openTeam === t.teamId && <ManagerDrill team={t} from={rep.scope.from} to={rep.scope.to} weekBlocks={rep.weekBlocks} />}
                    </Fragment>
                  ))}
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
        </>
      )}
    </>
  );
}

// Крок Д фінал #1 — ЛІНИВИЙ денний дрил менеджера (fetch при розкритті). Денна
// таблиця (ліди р/лг · авто · отримано [· конв]) + плитки.
function ManagerDailyDrill({ managerId, from, to, isRnk }: { managerId: number; from: string; to: string; isRnk: boolean }) {
  const [d, setD] = useState<KvpManagerDaily | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { let a = true; setD(null); setErr(false); fetchManagerDaily({ managerId, from, to }).then((x) => a && setD(x)).catch(() => a && setErr(true)); return () => { a = false; }; }, [managerId, from, to]);
  if (err) return <div style={{ fontSize: 12, color: RED }}>Не вдалося завантажити деталь.</div>;
  if (!d) return <div style={{ fontSize: 12, color: MUTED }}>Завантаження деталі…</div>;
  const t = d.tiles;
  const days = d.days.filter((x) => x.leadsAd || x.leadsLeadgen || x.leadsOther || x.dispatched.deals || x.received.deals || x.converted);
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <Tile label="Відправлено авто" val={`${t.dispatched.deals} · ${fmtMoney(t.dispatched.revenue)}`} />
        <Tile label="Середній чек" val={fmtFull(t.avgCheck)} />
        <Tile label="Очікується цей міс" val={fmtMoney(t.expectedThis.sum)} color={AMBER} />
        <Tile label="Очікується наст." val={fmtMoney(t.expectedNext.sum)} color={AMBER} />
        {isRnk && <Tile label="Конверсія лід→оплата" val={t.conversion == null ? "—" : `${t.conversion}%`} />}
        {t.gap > 0 && <Tile label="Розрив до плану" val={fmtMoney(t.gap)} color={RED} />}
      </div>
      {days.length === 0 ? <div style={{ fontSize: 12, color: MUTED }}>Немає активності у періоді.</div> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%", margin: 0, fontSize: 12 }}>
            <thead><tr><th>День</th><th style={{ textAlign: "right" }}>Ліди рекл.</th><th style={{ textAlign: "right" }}>Ліди лідоген</th><th style={{ textAlign: "right" }}>Авто (сума)</th><th style={{ textAlign: "right" }}>Отримано</th>{isRnk && <th style={{ textAlign: "right" }}>Сконв.→оплата</th>}</tr></thead>
            <tbody>
              {days.map((x) => (
                <tr key={x.day}>
                  <td>{x.day.slice(8)}.{x.day.slice(5, 7)}</td>
                  <td style={{ textAlign: "right" }}>{x.leadsAd || "—"}</td>
                  <td style={{ textAlign: "right" }}>{x.leadsLeadgen || "—"}</td>
                  <td style={{ textAlign: "right" }}>{x.dispatched.deals ? `${x.dispatched.deals} · ${fmtMoney(x.dispatched.revenue)}` : "—"}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{x.received.deals ? fmtMoney(x.received.revenue) : "—"}</td>
                  {isRnk && <td style={{ textAlign: "right" }}>{x.converted || "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function Tile({ label, val, color }: { label: string; val: string; color?: string }) {
  return (
    <div style={{ padding: "6px 10px", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, minWidth: 120 }}>
      <div style={{ fontSize: 10, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color ?? "var(--text)" }}>{val}</div>
    </div>
  );
}

function WeekCell({ w }: { w: KvpWeek | undefined }) {
  if (!w) return <td style={{ textAlign: "right", color: MUTED, fontSize: 11 }}>—</td>;
  if (w.isFuture) return <td style={{ textAlign: "right", fontSize: 10, color: MUTED }} title={`план ${fmtMoney(w.plan)} · очік ${fmtMoney(w.expected)}`}>{fmtMoney(w.plan)}<div>очік {fmtMoney(w.expected)}</div></td>;
  return <td style={{ textAlign: "right", fontSize: 11, background: w.isCurrent ? "rgba(37,99,235,0.08)" : undefined }} title={`факт ${fmtMoney(w.fact)} / план ${fmtMoney(w.plan)} · очік ${fmtMoney(w.expected)}`}>
    <span style={{ color: w.met ? GREEN : RED, fontWeight: 700 }}>{w.met ? "✓" : "✗"}</span> {fmtMoney(w.fact)}
  </td>;
}

function ManagerDrill({ team, from, to, weekBlocks }: { team: KvpTeam; from: string; to: string; weekBlocks: KvpReport["weekBlocks"] }) {
  const [openMgr, setOpenMgr] = useState<number | null>(null);
  const cols = (team.kind === "rnk" ? 7 : 6) + weekBlocks.length;
  return (
    <tr><td colSpan={6 + weekBlocks.length} style={{ padding: 0, background: "var(--bg)" }}>
      <table className="data-table" style={{ width: "100%", margin: 0 }}>
        <thead><tr><th style={{ paddingLeft: 28 }}>Менеджер (клік = дні)</th><th style={{ textAlign: "right" }}>План</th><th style={{ textAlign: "right" }}>Факт</th><th style={{ minWidth: 90 }}>%</th><th style={{ textAlign: "right" }}>Чек</th><th style={{ textAlign: "right" }}>Очікує</th>{team.kind === "rnk" && <th style={{ textAlign: "right" }}>Конв.</th>}{weekBlocks.map((w) => <th key={w.idx} style={{ textAlign: "right", fontSize: 10 }}>Т{w.idx}</th>)}</tr></thead>
        <tbody>
          {team.managers.map((m: KvpManager) => {
            const lagging = m.pct != null && m.pct < 70 && m.plan > 0;
            const open = openMgr === m.managerId;
            return (
              <Fragment key={m.managerId}>
                <tr onClick={() => setOpenMgr(open ? null : m.managerId)} style={{ cursor: "pointer" }}>
                  <td style={{ paddingLeft: 28 }}>{open ? "▾" : "▸"} {m.name}</td>
                  <td style={{ textAlign: "right" }}>{fmtMoney(m.plan)}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{fmtMoney(m.revenue)}</td>
                  <td><span style={{ color: pctColor(m.pct), fontWeight: 600 }}>{fmtPct(m.pct)}</span></td>
                  <td style={{ textAlign: "right" }}>{fmtFull(m.avgCheck)}</td>
                  <td style={{ textAlign: "right", color: MUTED }}>{fmtMoney(m.expected)}</td>
                  {team.kind === "rnk" && <td style={{ textAlign: "right" }}>{m.conversion == null ? "—" : `${m.conversion}%`}</td>}
                  {weekBlocks.map((w) => <WeekCell key={w.idx} w={m.weeks?.find((x) => x.idx === w.idx)} />)}
                </tr>
                {lagging && (
                  <tr><td colSpan={cols} style={{ paddingLeft: 28, background: "rgba(220,38,38,0.06)", fontSize: 12, color: RED }}>
                    ⚠️ {m.name} відстає ({m.pct}% плану). {m.successDeals < 3 ? "Мало закритих угод" : "Є угоди, але недобір суми"}{team.kind === "rnk" && m.conversion != null && m.conversion < (team.conversion ?? 0) ? ` · конверсія ${m.conversion}% нижча за команду` : ""}. → перевірити пайплайн і темп по днях.
                  </td></tr>
                )}
                {open && (
                  <tr><td colSpan={cols} style={{ padding: "8px 8px 12px 40px", background: "var(--card-bg)" }}>
                    <ManagerDailyDrill managerId={m.managerId} from={from} to={to} isRnk={team.kind === "rnk"} />
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

function FullTable({ rep, plans, onSave }: { rep: KvpReport; plans: KvpPlans; onSave: (k: string, v: number | null) => void }) {
  const m = rep.money, rs = rep.revenueStructure, en = rep.engines, lifecycle = rep.verdict.lifecycle;
  const editCell = (k: string) => (
    <input type="number" defaultValue={plans[k] ?? ""} onBlur={(e) => onSave(k, e.target.value === "" ? null : Number(e.target.value))}
      style={{ width: 100, textAlign: "right", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "2px 6px" }} />
  );
  // group → rows: [label, value, hint?, editKey?]
  const groups: [string, [string, string, string?, string?][]][] = [
    ["💰 Дохід", [
      ["Отримано (каса)", fmtMoney(m.received.revenue), HINT.received],
      ["Дохід в очікуванні (зона)", fmtMoney(m.expectedZoneTotal.sum), HINT.structExpected],
      ["Успішно закриті (142)", fmtMoney(m.success.revenue), "Угоди в статусі «Успішна угода» (142), за датою закриття в періоді."],
      ["Поставлені машини (авто)", `${lifecycle.sent.deals} авто · ${fmtMoney(lifecycle.sent.revenue)}`, HINT.sent],
      ["Перенесені (в роботі)", fmtMoney(m.paidOnly.revenue), "Оплата отримана (знімок етап 9) — ще не 142."],
      ["Стратегічний план 🔒", fmtMoney(rep.strategicPlan), HINT.strategic],
      ["Середній чек (ціль)", plans.avg_check != null ? fmtFull(plans.avg_check) : "—", "КВП-ручна ціль.", "avg_check"],
    ]],
    ["🆕 Нові клієнти", [
      ["Отримано", fmtMoney(rs.received.new.revenue), HINT.structReceived],
      ["В очікуванні", fmtMoney(rs.expected.new.sum), HINT.structExpected],
    ]],
    ["🔁 Постійні клієнти", [
      ["Отримано", fmtMoney(rs.received.repeat.revenue), HINT.structReceived],
      ["В очікуванні", fmtMoney(rs.expected.repeat.sum), HINT.structExpected],
    ]],
    ["🎯 Реклама", [
      ["Бюджет (Google)", fmtMoney(en.ad.budget), HINT.romi, "ad_budget"],
      ["Ліди (у зоні)", fmtNum(en.ad.entered), HINT.cplCrm],
      ["Нецільові", rep.retention.nonTarget == null ? "—" : fmtNum(rep.retention.nonTarget), HINT.nonTarget],
      ["Конверсія", en.ad.conversion == null ? "—" : `${en.ad.conversion}%${en.ad.mature ? "" : " ⏳"}`, HINT.conversion],
      ["Середній чек реклами (ціль)", plans.ad_avg_check != null ? fmtFull(plans.ad_avg_check) : "—", "КВП-ручна ціль.", "ad_avg_check"],
    ]],
    ["📞 Лідогенератори", [
      ["Передані заявки", fmtNum(en.leadgen.transferred), HINT.transferred],
      ["Поїхали (успіх→рахунок)", `${fmtNum(en.leadgen.dispatched)} · ${fmtMoney(en.leadgen.dispatchedRevenue)}`, HINT.lgDispatched],
      ["Дохід лідогену", fmtMoney(en.leadgen.revenue), HINT.lgRevenue],
    ]],
  ];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%" }}>
        <thead><tr><th>Показник</th><th style={{ textAlign: "right" }}>Значення</th><th style={{ textAlign: "right" }}>Ручний план ✎</th></tr></thead>
        <tbody>
          {groups.map(([grp, rows]) => (
            <Fragment key={grp}>
              <tr><td colSpan={3} style={{ fontWeight: 700, background: "var(--bg)", paddingTop: 8 }}>{grp}</td></tr>
              {rows.map(([label, val, hint, editKey]) => (
                <tr key={grp + label}>
                  <td><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}{hint && <InfoHint text={hint} />}</span></td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{val}</td>
                  <td style={{ textAlign: "right" }}>{editKey ? editCell(editKey) : <span style={{ color: MUTED }}>—</span>}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
