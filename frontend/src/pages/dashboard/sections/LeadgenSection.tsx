import { useEffect, useMemo, useState } from "react";
import { fetchLeadgenStats, fetchLeadgenTrend, type LeadgenStatsResp, type LeadgenTrendResp, type LeadgenGrain, type LeadgenPersonRow as PersonRow, type LeadgenHandoffMoney } from "../../../api";
import { formatAmount } from "../format";
import { InfoHint } from "../widgets";
import { PeriodNav, navBtn } from "../PeriodNav";
import {
  periodOf, periodLabelOf, navBy, monthStart, monthEnd, addMonth, todayKyiv, mondayOf, addDays, dow, spanDays, type PeriodState,
} from "../periodRules";
import {
  LeadgenPersonRow, pct1, bucketLabel, convStatus, StatusRing, unitsOf, fillBuckets, BucketNote, dateLbl,
} from "./LeadgenPersonRow";
import { LeadgenCharts } from "./LeadgenCharts";
import { plural } from "../receivablesView";

const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", MUTED = "var(--text-muted)";
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const WD_LO = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"];
const MON = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];

/**
 * 🔴 ЛОГІКА ПЕРІОДУ (уточнення 22.09.2026): «натиснув Місяць — обираєш серед місяців,
 * Тиждень — серед тижнів, День — серед днів». Смуга під навігатором — ОДИНИЦІ ОБРАНОГО
 * РЕЖИМУ, і клік по ній змінює САМ звіт:
 *   місяць → 12 місяців року, розбивка по тижнях;
 *   тиждень → тижні місяця, розбивка по днях;
 *   день → дні тижня, без розбивки;
 *   період → смуги немає; розбивка по днях, якщо відрізок ≤ 14 днів, інакше по тижнях.
 */
const grainOf = (nav: PeriodState, period: { from: string; to: string }): LeadgenGrain | null =>
  nav.mode === "day" ? null : nav.mode === "week" ? "day" : nav.mode === "month" ? "week"
    : spanDays(period.from, period.to) <= 14 ? "day" : "week";

/** Перший будній день від `d` (сб/нд → понеділок): відкривати період на вихідному — показати порожнечу. */
const workday = (d: string) => (dow(d) === 6 ? addDays(d, 2) : dow(d) === 7 ? addDays(d, 1) : d);
const minS = (a: string, b: string) => (a < b ? a : b);
const maxS = (a: string, b: string) => (a > b ? a : b);

type Cmp =
  | { kind: "future" }
  | { kind: "today" }
  | { kind: "none" }
  | { kind: "cmp"; cur: { from: string; to: string }; prev: { from: string; to: string }; text: string };

/**
 * 🔴 ПОРІВНЯННЯ «ЯБЛУКО З ЯБЛУКОМ» — лише ПОВНИМИ днями з обох боків:
 *   • період ще не настав → «ще попереду» (без червоних «падінь» проти минулого);
 *   • день = сьогодні → «день ще триває»: неповний день проти повного — неправда;
 *   • день у минулому → той самий день тижня тиждень тому (вівторок із вівторком);
 *   • тиждень/місяць/період, що ТРИВАЄ → повні дні до вчора проти тих самих днів
 *     попереднього (місяць/тиждень) або того самого відрізка на цілі тижні раніше (період);
 *   • завершений тиждень/місяць → попередній повний; завершений період → той самий
 *     відрізок на цілі тижні раніше (щоб збігся набір днів тижня: пт–нд не порівнюється з вт–чт).
 */
function comparisonOf(nav: PeriodState, today: string): Cmp {
  const cur = periodOf(nav);
  if (cur.from > cur.to) return { kind: "none" };
  if (cur.from > today) return { kind: "future" };
  const yesterday = addDays(today, -1);
  if (nav.mode === "day") {
    if (cur.from === today) return { kind: "today" };
    const d = addDays(cur.from, -7);
    return { kind: "cmp", cur, prev: { from: d, to: d }, text: `з тим самим днем тиждень тому — ${WD_LO[dow(d) - 1]} ${dateLbl(d, { from: d, to: d })}` };
  }
  const running = cur.to >= today;
  if (running && cur.from === today) return { kind: "today" };
  const c = running ? { from: cur.from, to: yesterday } : cur;
  const span = spanDays(c.from, c.to);
  let prev: { from: string; to: string }, head: string;
  if (nav.mode === "range" && !running && cur.from.slice(8) === "01" && cur.to === monthEnd(cur.to)) {
    // Відрізок рівно з цілих місяців (01.07–31.07, 01.07–30.09) — порівнюємо з тими самими
    // кількома місяцями перед ним, а не «на 5 тижнів раніше».
    const k = (Number(cur.to.slice(0, 4)) * 12 + Number(cur.to.slice(5, 7))) - (Number(cur.from.slice(0, 4)) * 12 + Number(cur.from.slice(5, 7))) + 1;
    prev = { from: addMonth(cur.from, -k), to: addDays(cur.from, -1) };
    head = k === 1 ? "з попереднім місяцем" : `з попередніми ${k} міс.`;
  } else if (nav.mode === "range") {
    const shift = Math.ceil(spanDays(cur.from, cur.to) / 7) * 7;
    prev = { from: addDays(c.from, -shift), to: addDays(c.to, -shift) };
    head = `з тим самим відрізком ${shift / 7} тиж. тому`;
  } else {
    const patch = navBy(nav, -1);
    if (!patch) return { kind: "none" };
    const p = periodOf({ ...nav, ...patch });
    prev = running ? { from: p.from, to: minS(addDays(p.from, span - 1), p.to) } : p;
    head = nav.mode === "month" ? (running ? "з тими самими днями попереднього місяця" : "з попереднім місяцем")
      : (running ? "з тими самими днями попереднього тижня" : "з попереднім тижнем");
  }
  const lbl = (r: { from: string; to: string }) => (r.from === r.to ? dateLbl(r.from, r) : `${dateLbl(r.from, r)}–${dateLbl(r.to, r)}`);
  const text = running
    ? `${head}: повні дні ${lbl(c)} проти ${lbl(prev)} (сьогодні ще триває — не враховано)`
    : `${head}: ${lbl(prev)}`;
  return { kind: "cmp", cur: c, prev, text };
}

interface Unit { key: string; top: string; main: string; active: boolean; future: boolean; dim?: boolean; now?: boolean; patch: Partial<PeriodState> }

/** Одиниці смуги для режиму. Майбутні — сірі й не клікаються (як дні у Звіті). */
function stripUnits(nav: PeriodState, today: string): Unit[] {
  if (nav.mode === "day") {
    const mon = mondayOf(nav.focusDay);
    return Array.from({ length: 7 }, (_, i) => {
      const dd = addDays(mon, i);
      return { key: dd, top: WD[i] + (dd === today ? " •" : ""), main: dd.slice(8), active: dd === nav.focusDay,
        future: dd > today, dim: i >= 5, patch: { focusDay: dd, anchor: dd } };
    });
  }
  if (nav.mode === "week") {
    // Тижні, що перетинають місяць смуги. Клік ставить фокус НА ДЕНЬ ЦЬОГО МІСЯЦЯ (не на
    // понеділок): інакше тиждень 31.08–06.09 перекинув би смугу вересня на серпень.
    const m0 = monthStart(nav.focusDay), m1 = monthEnd(nav.focusDay), sel = mondayOf(nav.focusDay);
    const out: Unit[] = [];
    for (let w = mondayOf(m0); w <= m1; w = addDays(w, 7)) {
      const e = addDays(w, 6), inMonth = maxS(w, m0);
      out.push({ key: w, top: w <= today && today <= e ? "зараз •" : "Пн–Нд", main: `${w.slice(8)}.${w.slice(5, 7)}–${e.slice(8)}.${e.slice(5, 7)}`,
        active: w === sel, future: w > today, patch: { focusDay: inMonth, anchor: inMonth } });
    }
    return out;
  }
  if (nav.mode === "month") {
    const y = nav.anchor.slice(0, 4), sel = nav.anchor.slice(0, 7);
    return MON.map((lbl, i) => {
      const m = `${y}-${String(i + 1).padStart(2, "0")}`;
      // Рік НЕ пишеться над «Січ», а поточний місяць не несе самотньої крапки у верхньому рядку:
      // порожній «поверх» над десятьма з дванадцяти чипів робив рядок нерівним (зауваження власника 23.09).
      return { key: m, top: "", main: lbl, active: m === sel, now: today.slice(0, 7) === m,
        future: m + "-01" > today, patch: { anchor: m + "-01" } };
    });
  }
  return [];
}

/**
 * 📞 «ЛІДОГЕНЕРАЦІЯ» — у формі вкладки «Звіт» (рішення Сергія 09.09.2026 + уточнення 22.09).
 * Той самий навігатор (`PeriodNav`), смуга одиниць під ним, верхня картка у три колонки,
 * розкривний рядок на кожного лідгена.
 *
 * ⚠️ ПЛАНІВ У ЛІДГЕНІВ ЩЕ НЕМАЄ (крок 3). Кільце — конверсія «ліди → ОПР» до цілі 40 %.
 * 🔴 ЧИСЛА НЕ ЗМІНЮЮТЬСЯ — лише вигляд. Той самий `/leadgen-stats` + розбивка за `grain`.
 */
export function LeadgenSection() {
  const today = todayKyiv();
  const [nav, setNav] = useState<PeriodState>({
    mode: "month", anchor: today, focusDay: today, rangeFrom: monthStart(today), rangeTo: today,
  });
  const period = useMemo(() => periodOf(nav), [nav]);
  const periodLabel = periodLabelOf(nav);
  const grain = grainOf(nav, period);
  /** Статус (колір кільця й пілюлі) — лише за місяць і довше: див. `convStatus`. */
  const statusful = spanDays(period.from, period.to) >= 28;
  const cmp = useMemo(() => comparisonOf(nav, today), [nav, today]);

  const [who, setWho] = useState<number | "all">("all");
  const [whoName, setWhoName] = useState<string>("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [d, setD] = useState<LeadgenStatsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [retry, setRetry] = useState(0);
  const [cmpData, setCmpData] = useState<{ cur: LeadgenStatsResp; prev: LeadgenStatsResp } | null>(null);
  const [cmpErr, setCmpErr] = useState(false);
  const [trend, setTrend] = useState<LeadgenTrendResp | null>(null);
  const [trendErr, setTrendErr] = useState(false);

  const { from, to } = period;
  /** Період, що ще не почався, не запитуємо: у CRM за нього нічого немає й бути не може. */
  const future = from > today;
  // Як у Звіті: попередні дані лишаються на екрані, поки вантажаться нові (екран не «схлопується»),
  // три спроби з паузою, далі — видима помилка з кнопкою «Спробувати знову».
  useEffect(() => {
    let cancelled = false;
    if (future) { setLoading(false); setErr(false); return; }
    setLoading(true); setErr(false);
    (async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetchLeadgenStats(grain ? { from, to, grain } : { from, to });
          if (!cancelled) { setD(r); setLoading(false); }
          return;
        } catch {
          if (cancelled) return;
          if (i < 2) await new Promise((res) => setTimeout(res, 400 * 2 ** i));
        }
      }
      if (!cancelled) { setErr(true); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [from, to, grain, retry, future]);

  const cmpKey = cmp.kind === "cmp" ? `${cmp.cur.from}|${cmp.cur.to}|${cmp.prev.from}|${cmp.prev.to}` : "";
  useEffect(() => {
    let cancelled = false;
    setCmpData(null); setCmpErr(false);
    if (cmp.kind !== "cmp") return;
    Promise.all([fetchLeadgenStats(cmp.cur), fetchLeadgenStats(cmp.prev)])
      .then(([cur, prev]) => { if (!cancelled) setCmpData({ cur, prev }); })
      .catch(() => { if (!cancelled) setCmpErr(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpKey]);

  // Тренд — 12 місяців, що закінчуються місяцем кінця обраного періоду (не пізніше поточного).
  const trendTo = monthEnd(minS(monthStart(period.to), monthStart(today)));
  useEffect(() => {
    let cancelled = false;
    setTrendErr(false);
    fetchLeadgenTrend({ to: trendTo, months: 12 })
      .then((r) => { if (!cancelled) setTrend(r); })
      .catch(() => { if (!cancelled) setTrendErr(true); });
    return () => { cancelled = true; };
  }, [trendTo]);

  /**
   * Єдиний вхід змін навігатора — тримає ПОЗИЦІЮ В ЧАСІ при зміні режиму:
   *   • вибір місяця (смуга, ← → у «Місяці») зсуває лише `anchor` — підтягуємо `focusDay`
   *     на сьогодні (поточний місяць) або перший будній день місяця;
   *   • «Період» стартує з того, що зараз на екрані (обрізано сьогоднішнім днем);
   *   • з «Періоду» в інші режими — від кінця відрізка (не далі за сьогодні).
   */
  const patchNav = (p: Partial<PeriodState>) => setNav((s) => {
    const n = { ...s, ...p };
    if (p.mode !== undefined && p.mode !== s.mode) {
      const cur = periodOf(s);
      if (p.mode === "range") { n.rangeFrom = cur.from; n.rangeTo = minS(cur.to, today); }
      else if (s.mode === "range") { const base = minS(s.rangeTo || today, today); n.focusDay = base; n.anchor = base; }
    }
    // «Сьогодні» у режимі «Період» інакше нічого не міняв би на екрані: ставимо місяць по сьогодні.
    if (s.mode === "range" && p.mode === undefined && p.anchor === today && p.focusDay === today) { n.rangeFrom = monthStart(today); n.rangeTo = today; }
    if (p.anchor !== undefined && p.focusDay === undefined)
      n.focusDay = p.anchor.slice(0, 7) === today.slice(0, 7) ? today : workday(monthStart(p.anchor));
    return n;
  });

  const pickWho = (v: string) => {
    if (v === "all") { setWho("all"); return; }
    const id = Number(v);
    setWho(id);
    setWhoName(d?.rows.find((r) => r.managerId === id)?.name ?? whoName);
    setOpen(new Set([id]));
  };
  const toggle = (id: number) => setOpen((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const units = useMemo(() => stripUnits(nav, today), [nav, today]);
  const whoAbsent = who !== "all" && !!d && !d.rows.some((r) => r.managerId === who);

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto" }}>
      {/* Хедер — як у Звіті */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Лідогенерація</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
            Дзвінки, ліди, ОПР, прорахунки — з подій CRM · <b style={{ color: "var(--text)" }}>{periodLabel}</b>
            {loading && d && <span> · оновлюю…</span>}
          </div>
        </div>
        {d && (
          <div style={{ fontSize: 12, color: MUTED, background: "var(--card-bg)", border: "1px solid var(--border)", padding: "4px 11px", borderRadius: 20 }}>
            Ти бачиш: <b style={{ color: "var(--text)" }}>{d.scopedTo != null ? "свою команду" : "весь відділ"}</b>
          </div>
        )}
      </div>

      <PeriodNav state={nav} onPatch={patchNav} today={today}>
        <select value={who} onChange={(e) => pickWho(e.target.value)} style={{ ...navBtn, cursor: "pointer" }} aria-label="Лідген">
          <option value="all">Усі лідгени{d ? ` (${d.rows.length})` : ""}</option>
          {(d?.rows ?? []).map((r) => <option key={r.managerId} value={r.managerId}>{r.name}</option>)}
          {whoAbsent && <option value={who}>{whoName} — без дій у періоді</option>}
        </select>
      </PeriodNav>

      {/* Смуга одиниць обраного режиму — розмітка дня-strip зі Звіту, одиниці — від режиму */}
      {units.length > 0 && (
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "stretch", marginBottom: 16 }}>
          {nav.mode === "month" && (
            <div style={{ display: "flex", alignItems: "center", padding: "0 10px 0 2px", fontSize: 13, fontWeight: 700, color: MUTED, letterSpacing: ".5px" }}>
              {nav.anchor.slice(0, 4)}
            </div>
          )}
          {units.map((u, i) => (
            <div key={u.key} onClick={() => !u.future && patchNav(u.patch)} title={u.now ? "поточний місяць" : undefined} style={{
              minWidth: nav.mode === "month" ? 64 : 60, textAlign: "center", borderRadius: 10, cursor: u.future ? "default" : "pointer",
              padding: nav.mode === "month" ? "9px 12px" : "7px 10px",
              // Квартали — ледь помітною прогалиною: дванадцять однакових чипів підряд читаються як суцільна стрічка.
              marginRight: nav.mode === "month" && i % 3 === 2 && i < units.length - 1 ? 9 : 0,
              border: `1px solid ${u.active ? "var(--text)" : "var(--border)"}`, background: u.active ? "var(--text)" : "var(--card-bg)",
              color: u.active ? "var(--card-bg)" : "var(--text)", opacity: u.future ? 0.4 : 1,
              display: "flex", flexDirection: "column", justifyContent: "center", gap: 1,
            }}>
              {u.top !== "" && <small style={{ display: "block", fontSize: 11, textTransform: "uppercase", letterSpacing: ".4px", color: u.active ? "var(--card-bg)" : MUTED }}>{u.top}</small>}
              <b style={{ fontSize: 15, color: u.dim && !u.active ? MUTED : undefined }}>{u.main}</b>
              {/* Поточний місяць — тонка позначка ПІД назвою, а не крапка в порожньому рядку над нею.
                  Місце під неї тримають УСІ чипи: інакше рядок, у якому поточного місяця немає (смуга
                  переноситься на вузькому екрані), виходив на 4 px нижчим — та сама нерівність, менша. */}
              {nav.mode === "month" && (
                <span aria-hidden="true" style={{ display: "block", width: 16, height: 2, borderRadius: 2, margin: "1px auto 0",
                  background: !u.now ? "transparent" : u.active ? "var(--card-bg)" : "var(--lg-link)" }} />
              )}
            </div>
          ))}
        </div>
      )}

      {err && (
        <div style={{ textAlign: "center", padding: 28, color: MUTED }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>⚠️</div>
          <div style={{ marginBottom: 12 }}>Не вдалося завантажити лідогенерацію за {periodLabel} (тимчасовий збій зʼєднання).</div>
          <button onClick={() => setRetry((x) => x + 1)}
            style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: "#2f6fdb", color: "#fff", fontWeight: 700, cursor: "pointer" }}>
            Спробувати знову
          </button>
        </div>
      )}
      {future && <div style={{ padding: 20, color: MUTED }}>Період {periodLabel} ще не настав — дій у CRM за нього немає.</div>}
      {!future && !d && !err && <div style={{ padding: 20, color: MUTED }}>Завантаження…</div>}
      {!future && d && !err && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .15s" }}>
          <Glance d={d} cmp={cmp} cmpData={cmpData} cmpErr={cmpErr} who={who} whoName={whoName} whoAbsent={whoAbsent}
            periodLabel={periodLabel} statusful={statusful} />
          <h3 style={{ margin: "4px 0 10px" }}>📊 Загальна статистика</h3>
          <LeadgenCharts d={d} trend={trend} trendErr={trendErr} who={who} whoName={whoName} grain={grain}
            period={period} today={today} periodLabel={periodLabel} />
          <h3 style={{ margin: "4px 0 10px" }}>👥 Лідгени · {periodLabel} <span style={{ fontSize: 12, fontWeight: 400, color: MUTED }}>· гроші — з лідів, переданих у періоді, стан угод — зараз</span></h3>
          <People d={d} who={who} whoName={whoName} whoAbsent={whoAbsent} grain={grain} period={period} today={today}
            statusful={statusful} open={open} onToggle={toggle} />
          <Details d={d} grain={grain} period={period} today={today} open={detailsOpen} onToggle={setDetailsOpen} />
        </div>
      )}
    </div>
  );
}

function People({ d, who, whoName, whoAbsent, grain, period, today, statusful, open, onToggle }: {
  d: LeadgenStatsResp; who: number | "all"; whoName: string; whoAbsent: boolean; grain: LeadgenGrain | null;
  period: { from: string; to: string }; today: string; statusful: boolean; open: Set<number>; onToggle: (id: number) => void;
}) {
  const rows = who === "all" ? d.rows : d.rows.filter((r) => r.managerId === who);
  const units = unitsOf(grain, period, today);
  const byPerson = d.bucketsByPerson ?? [];
  if (whoAbsent) return <div style={{ padding: "8px 2px 16px", color: MUTED }}>У {whoName} у цьому періоді немає дій у CRM (жодного входу угоди в етапи лідогенерації).</div>;
  if (rows.length === 0) return <div style={{ padding: "8px 2px 16px", color: MUTED }}>За цей період лідгенівських дій у CRM немає.</div>;
  return (
    <>
      {rows.map((r) => (
        <LeadgenPersonRow key={r.managerId} row={r} units={units}
          money={d.handoffMoney?.byPerson.find((x) => x.managerId === r.managerId)}
          dataPeriod={{ from: d.from, to: d.to }}
          buckets={byPerson.filter((w) => w.managerId === r.managerId)} grain={grain}
          targets={d.conversions.targets} period={period} statusful={statusful}
          open={open.has(r.managerId)} onToggle={() => onToggle(r.managerId)} />
      ))}
    </>
  );
}

function Details({ d, grain, period, today, open, onToggle }: {
  d: LeadgenStatsResp; grain: LeadgenGrain | null; period: { from: string; to: string }; today: string;
  open: boolean; onToggle: (v: boolean) => void;
}) {
  const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED };
  const rows = fillBuckets(unitsOf(grain, period, today), d.buckets ?? []);
  const unitName = grain === "day" ? "по днях" : grain === "week" ? "по тижнях" : "";
  return (
    <details className="chart-card" style={{ marginTop: 16 }} open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", fontWeight: 650 }}>
        Деталі {d.scopedTo != null ? "команди" : "відділу"} · {unitName}{grain ? ", " : ""}причини закриття, передані прорахунки, джерела
      </summary>

      {grain && (
        <>
          <h3 style={{ margin: "16px 0 12px" }}>📅 {grain === "day" ? "По днях" : "По тижнях"}</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ ...head, textAlign: "left" }}>{grain === "day" ? "День" : "Тиждень"}</th>
                  <th style={head}>Дзвінки</th><th style={head}>Ліди</th><th style={head}>ОПР</th><th style={head}>Прорахунки</th><th style={head}>Підігрів</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const empty = !w.calls && !w.leads && !w.opr && !w.quotes && !w.warming;
                  return (
                    <tr key={w.bucket} style={{ borderTop: "1px solid var(--border)", color: empty ? MUTED : undefined }}>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{bucketLabel(w.bucket, grain, period)}</td>
                      <td style={cell}>{w.calls.toLocaleString("uk-UA")}</td>
                      <td style={cell}>{w.leads.toLocaleString("uk-UA")}</td>
                      <td style={cell}>{w.opr.toLocaleString("uk-UA")}</td>
                      <td style={cell}>{w.quotes.toLocaleString("uk-UA")}</td>
                      <td style={cell}>{w.warming.toLocaleString("uk-UA")}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={6} style={{ padding: 14, color: MUTED }}>Період ще не почався.</td></tr>}
              </tbody>
            </table>
          </div>
          {rows.length > 0 && <BucketNote total={d.totals} rows={rows} grain={grain} period={period} />}
        </>
      )}

      <h3 style={{ margin: "20px 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        🚚 Канал «лідоген» загалом <InfoHint text={`${d.department.note} ⚓ ${d.department.anchors}`} />
      </h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: MUTED }}>
        Усі угоди каналу «лідоген» (не лише з передач цього періоду): відправлено {d.department.machines.toLocaleString("uk-UA")} авто на {formatAmount(d.department.machinesRevenue)},
        отримано {formatAmount(d.department.receivedRevenue)}.
      </p>

      {d.scopedTo != null && (
        <p style={{ margin: "14px 0 0", fontSize: 12.5, color: "var(--warn)" }}>⚠ Причини закриття, передані прорахунки й джерела нижче — по всьому відділу, не лише по вашій команді.</p>
      )}
      <h3 style={{ margin: "20px 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
        ❌ Чому закривали
        <InfoHint text="Причина з поля угоди, яке лідген проставляє руками при закритті. Рядок «Причину не проставили» показуємо навмисно: невидима прогалина читається як «таких немає»." />
      </h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: MUTED }}>
        Разом {d.closures.reduce((a, c) => a + c.deals, 0).toLocaleString("uk-UA")} закриттів ·
        зараз висить у «Клієнт підігрівається»: <b>{d.warmingNow.toLocaleString("uk-UA")}</b>
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <tbody>
          {d.closures.map((c) => (
            <tr key={c.reason} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 10px" }}>{c.reason}</td>
              <td style={cell}>{c.deals.toLocaleString("uk-UA")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ margin: "20px 0 4px" }}>📋 Передані прорахунки</h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: MUTED }}>
        Те, що тімліди вклеюють у журнал руками. Показано {d.handoffs.length.toLocaleString("uk-UA")}
        {d.handoffs.length >= d.handoffsLimit && ` (стеля ${d.handoffsLimit} — за період їх більше)`}.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: "left" }}>Дата</th>
              <th style={{ ...head, textAlign: "left" }}>Угода</th>
              <th style={{ ...head, textAlign: "left" }}>Відповідальний</th>
              <th style={head}>Kommo</th>
            </tr>
          </thead>
          <tbody>
            {d.handoffs.map((h, i) => (
              <tr key={`${h.kommoId}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{h.day}</td>
                <td style={{ padding: "8px 10px" }}>{h.name ?? "без назви"}</td>
                <td style={{ padding: "8px 10px" }}>{h.manager ?? "—"}</td>
                <td style={cell}><a href={h.url} target="_blank" rel="noreferrer" style={{ color: "var(--lg-link)" }}>відкрити ↗</a></td>
              </tr>
            ))}
            {d.handoffs.length === 0 && <tr><td colSpan={4} style={{ padding: 14, color: MUTED }}>За цей період прорахунків не передавали.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: "20px 0 12px" }}>🧊 Звідки ліди</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <tbody>
          {d.bySource.map((s) => (
            <tr key={s.source} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 10px" }}>{s.source}</td>
              <td style={cell}>{s.leads.toLocaleString("uk-UA")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

type Totals = { calls: number; leads: number; opr: number; quotes: number; warming: number };

/**
 * Верхня картка — сітка Звіту у три колонки: відділ/команда (або обрана людина) за період ·
 * машини й гроші відділу за період · порівняння «яблуко з яблуком». Машини й гроші — лише
 * відділом, бо звʼязку «машина → лідген» у CRM немає.
 */
function Glance({ d, cmp, cmpData, cmpErr, who, whoName, whoAbsent, periodLabel, statusful }: {
  d: LeadgenStatsResp; cmp: Cmp; cmpData: { cur: LeadgenStatsResp; prev: LeadgenStatsResp } | null; cmpErr: boolean;
  who: number | "all"; whoName: string; whoAbsent: boolean; periodLabel: string; statusful: boolean;
}) {
  const conv = d.conversions;
  const zero: Totals = { calls: 0, leads: 0, opr: 0, quotes: 0, warming: 0 };
  const person = who === "all" ? null : d.rows.find((r) => r.managerId === who) ?? null;
  const t: Totals = who === "all" ? d.totals : person ?? zero;
  const title = who === "all" ? (d.scopedTo != null ? "Команда" : "Відділ") : person?.name ?? whoName;
  const st = convStatus(t.opr, t.leads, conv.targets.oprOfLeads, statusful);
  const pills = { g: 0, a: 0, r: 0, n: 0 };
  for (const r of d.rows) {
    const s = convStatus(r.opr, r.leads, conv.targets.oprOfLeads, statusful);
    if (s.level) pills[s.level]++; else pills.n++;
  }
  const qConv = conv.quotesOfOpr;
  /** Числа сторони порівняння: для людини без рядка в тому періоді дзвінки невідомі (ростер — з подій), тож «—», а не 0. */
  const sideOf = (r: LeadgenStatsResp) => {
    if (who === "all") return { ...r.totals, known: true };
    const row = r.rows.find((x: PersonRow) => x.managerId === who);
    return row ? { ...row, known: true } : { ...zero, known: false };
  };
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 15, padding: "16px 18px", marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 20, alignItems: "center" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <StatusRing st={st} target={conv.targets.oprOfLeads}
          title={st.overfull ? `ОПР (${t.opr}) більше, ніж лідів (${t.leads}) — конверсія цього періоду нічого не каже`
            : st.conv == null ? "Лідів у періоді немає" : !statusful ? "Статус — лише за місяць і довше." : undefined} />
        <div>
          <div style={lab}>{title} · {periodLabel} <InfoHint text={d.callRule + " Ліди — входи в «Взято в роботу», ОПР — «Отримано контакти ОПР», прорахунки — «Кваліфіковано», підігрів — воронка Реактивації."} /></div>
          <div style={val}>{t.leads.toLocaleString("uk-UA")} <small style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{plural(t.leads, "лід", "ліди", "лідів")} · {t.quotes.toLocaleString("uk-UA")} {plural(t.quotes, "прорахунок", "прорахунки", "прорахунків")}</small></div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
            дзвінки {whoAbsent ? "—" : t.calls.toLocaleString("uk-UA")} · ОПР {t.opr.toLocaleString("uk-UA")} · підігрів {t.warming.toLocaleString("uk-UA")}
            {" · "}ліди → ОПР {st.conv == null ? "—" : pct1(st.conv)}{st.overfull ? " ⚠" : ""} (ціль {conv.targets.oprOfLeads} %)
            {who === "all" && <> · ОПР → прорахунок {qConv == null ? "—" : pct1(qConv)}{qConv != null && qConv > 100 ? " ⚠" : ""} (ціль {conv.targets.quotesOfOpr} %)</>}
          </div>
          {who === "all" && (statusful ? (
            <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
              <Pill c={RED}>{pills.r} нижче цілі</Pill>
              <Pill c={AMBER}>{pills.a} близько</Pill>
              <Pill c={GREEN}>{pills.g} у цілі</Pill>
              {pills.n > 0 && <Pill c="#6b7280">{pills.n} без оцінки</Pill>}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 5 }}>статуси людей — за місяць і довше</div>
          ))}
        </div>
      </div>
      <HandoffMoneyCol m={who === "all" ? d.handoffMoney?.totals : d.handoffMoney?.byPerson.find((x) => x.managerId === who)} />
      <div>
        <div style={lab}>Порівняння</div>
        {cmp.kind === "future" && <><div style={{ ...val, color: MUTED }}>— <small style={{ fontSize: 12, fontWeight: 600 }}>ще попереду</small></div><div style={{ fontSize: 11, color: MUTED }}>період ще не настав</div></>}
        {cmp.kind === "today" && <><div style={{ ...val, color: MUTED }}>— <small style={{ fontSize: 12, fontWeight: 600 }}>день ще триває</small></div><div style={{ fontSize: 11, color: MUTED }}>неповний день із повним не порівнюємо</div></>}
        {cmp.kind === "none" && <div style={{ ...val, color: MUTED }}>—</div>}
        {cmp.kind === "cmp" && (
          <>
            <div style={{ fontSize: 11.5, color: MUTED, margin: "1px 0 4px" }}>{cmp.text}</div>
            {cmpErr ? <div style={{ fontSize: 12.5, color: MUTED }}>— не вдалося завантажити порівняння</div>
              : !cmpData ? <div style={{ ...val, color: MUTED }}>…</div>
              : (() => {
                const a = sideOf(cmpData.cur), b = sideOf(cmpData.prev);
                const ca = a.leads > 0 ? Math.round((a.opr / a.leads) * 1000) / 10 : null;
                const cb = b.leads > 0 ? Math.round((b.opr / b.leads) * 1000) / 10 : null;
                return (
                  <>
                    <Delta label={plural(a.leads, "лід", "ліди", "лідів")} now={a.leads} was={b.leads} big />
                    <Delta label={plural(a.quotes, "прорахунок", "прорахунки", "прорахунків")} now={a.quotes} was={b.quotes} />
                    <Delta label={a.known ? plural(a.calls, "дзвінок", "дзвінки", "дзвінків") : "дзвінків"} now={a.known ? a.calls : null} was={b.known ? b.calls : null} />
                    <div style={{ fontSize: 12, marginTop: 2, color: MUTED }}>
                      ліди → ОПР: <b style={{ color: "var(--text)" }}>{ca == null ? "—" : pct1(ca)}{ca != null && ca > 100 ? " ⚠" : ""}</b> (було {cb == null ? "—" : pct1(cb)}{cb != null && cb > 100 ? " ⚠" : ""})
                    </div>
                  </>
                );
              })()}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 💰 «Гроші з переданих лідів» — що сталося з угодами, які лідген передав менеджеру в цьому
 * періоді, СТАНОМ НА ЗАРАЗ. Успішні — головне число; оплачено/очікуємо/в роботі — нижче;
 * передачі без угоди менеджера — окремо й чесно (їхні гроші не привʼязати).
 */
function HandoffMoneyCol({ m }: { m: LeadgenHandoffMoney | undefined }) {
  const hint = "Передача — угода, яку лідген кваліфікував у Продзвоні. З неї Kommo створює угоду менеджеру (той самий клієнт, у межах 2 хв від передачі). "
    + "Гроші — за ДАТОЮ ПЕРЕДАЧІ: угоди з лідів, переданих у цьому періоді, в якому б місяці вони не закрились. Тому це НЕ «Дохід лідогену» КВП і не «отримано» в блоці «Канал «лідоген» загалом»: там — отримані кошти (успіх + оплата отримана) угод із каналом «лідоген», за датою оплати. "
    + "Стан угоди — ЗАРАЗ: успішна (142), оплата отримана, у зоні «Очікуємо» Звіту (від виставлення рахунку до очікуємо оплату), ще в роботі (не закрита грошима й не програна — зокрема «Кваліфіковано» у Кваліфікації), програна (143, у Кваліфікації — «Не цільові»/«Сміття», або борг по ній списано). "
    + `Сума — бюджет (price) угоди менеджера. В успішних цього періоду він проставлений у ${m ? m.success.priced : "—"} з ${m ? m.success.n : "—"}; у програних і тих, що в роботі, здебільшого ні — тому для них головне число — кількість. `
    + "«Передано» — те саме, що «Прорахунки» (входи в «Кваліфіковано» Продзвону); це не «Передані» КВП (там — реєстр бота). "
    + "Передачі без угоди менеджера показано окремо: їхні гроші не привʼязати.";
  if (!m) return <div><div style={lab}>💰 Гроші з переданих лідів</div><div style={{ ...val, color: MUTED }}>—</div></div>;
  const line = (label: string, c: { n: number; sum: number }, color?: string) =>
    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{label}: <b style={{ color: color ?? "var(--text)" }}>{formatAmount(c.sum)}</b> · {c.n.toLocaleString("uk-UA")} {plural(c.n, "угода", "угоди", "угод")}</div>;
  return (
    <div>
      <div style={lab}>💰 Гроші з переданих лідів <InfoHint text={hint} /></div>
      <div style={{ fontSize: 11, color: MUTED, margin: "1px 0 2px" }}>за датою передачі · стан — зараз · не «Дохід лідогену» КВП</div>
      <div style={val}>{formatAmount(m.success.sum)} <small style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>успішні · {m.success.n.toLocaleString("uk-UA")} {plural(m.success.n, "угода", "угоди", "угод")}</small></div>
      {m.paid.n > 0 && line("оплачено, ще не закрито", m.paid, "var(--info)")}
      {line("у зоні «Очікуємо»", m.expect, "var(--warn)")}
      <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>ще в роботі: <b style={{ color: "var(--text)" }}>{m.work.n.toLocaleString("uk-UA")} {plural(m.work.n, "угода", "угоди", "угод")}</b> · бюджет є у {m.work.priced.toLocaleString("uk-UA")}: {formatAmount(m.work.sum)}</div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
        передано (= прорахунки) {m.handoffs.toLocaleString("uk-UA")} · програно {m.lost.toLocaleString("uk-UA")}
        {m.unlinked > 0 && <> · без угоди менеджера {m.unlinked.toLocaleString("uk-UA")}</>}{m.sameDeal > 0 && <> · у ту саму угоду {m.sameDeal}</>}
      </div>
    </div>
  );
}

/** «98 лідів ▼ 12 (було 110)»; «—», коли число невідоме (не нуль!). */
function Delta({ label, now, was, big }: { label: string; now: number | null; was: number | null; big?: boolean }) {
  const dlt = now != null && was != null ? now - was : null;
  const col = dlt == null || dlt === 0 ? MUTED : dlt > 0 ? "var(--ok)" : "var(--danger)";
  return (
    <div style={big ? { ...val, marginBottom: 2 } : { fontSize: 12.5, marginTop: 2 }}>
      {now == null ? "—" : now.toLocaleString("uk-UA")} <small style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</small>{" "}
      {dlt != null && <span style={{ fontSize: 12, fontWeight: 700, color: col }}>{dlt > 0 ? "▲" : dlt < 0 ? "▼" : "="} {Math.abs(dlt).toLocaleString("uk-UA")}</span>}
      <small style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}> (було {was == null ? "—" : was.toLocaleString("uk-UA")})</small>
    </div>
  );
}
const lab: React.CSSProperties = { fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px" };
const val: React.CSSProperties = { fontSize: 19, fontWeight: 750, letterSpacing: "-.3px" };
function Pill({ c, children }: { c: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: c + "22", color: c }}>{children}</span>;
}
