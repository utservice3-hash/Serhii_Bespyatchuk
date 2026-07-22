import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchReportPlan, fetchReportPlanDeals, fetchManagerDetail,
  type ReportPlan, type ReportPlanManager, type ReportPlanDeal, type KvpManagerDetail, type Team,
} from "../../../api";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";

// Статуси-кольори (зарезервовані, з іконкою+підписом — не колір-наодинці). Тема-безпечні.
const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", BAR = "#2f6fdb", MUTED = "var(--text-muted)";
const SCOL: Record<string, string> = { g: GREEN, a: AMBER, r: RED };
const SLBL: Record<string, string> = { g: "В нормі", a: "Відстає", r: "Зрив" };
const SICON: Record<string, string> = { g: "🟢", a: "🟠", r: "🔴" };
const TAGCOL: Record<string, string> = { rpk: BAR, rnk: "#7a52c7", self: GREEN };

// Комерційний скоуп (A1): у перемикачі команд не показуємо Финансовый(12) і
// лідоген-генератор Ковтонюк(11) — вони не в продажному звіті (= бекенд KVP_FINANCE/LEADGEN).
const HIDE_TEAMS = new Set([11, 12]);
const fmt = (n: number) => (n === 0 ? "0" : Math.round(n).toLocaleString("uk-UA").replace(/,/g, " "));
const k = (n: number) => Math.round(n / 1000) + "к";
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

// ── дати (Пн–Нд, локально) ──
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(s + "T00:00:00Z");
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const dow = (s: string) => { const w = parse(s).getUTCDay(); return w === 0 ? 7 : w; }; // Пн=1..Нд=7
const mondayOf = (s: string) => addDays(s, -(dow(s) - 1));
const sundayOf = (s: string) => addDays(mondayOf(s), 6);
const monthStart = (s: string) => s.slice(0, 7) + "-01";
const monthEnd = (s: string) => { const [y, m] = s.split("-").map(Number); return iso(new Date(Date.UTC(y, m, 0))); };
const todayKyiv = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const ddmm = (s: string) => s.slice(8) + "." + s.slice(5, 7);

type Mode = "day" | "week" | "month";

export function ReportPlanSection({ auth, teams }: {
  auth: { role: string; managerId: number | null; teamId: number | null };
  teams: Team[];
}) {
  const today = todayKyiv();
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(today);        // якір періоду
  const [focusDay, setFocusDay] = useState(today);    // фокус-день (кластер «вчора»)
  const [teamId, setTeamId] = useState<number | "">(auth.role === "admin" ? "" : "");
  const [data, setData] = useState<ReportPlan | null>(null);
  const [focus, setFocus] = useState<ReportPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [openMgr, setOpenMgr] = useState<number | null>(null);

  const period = useMemo(() => {
    if (mode === "day") return { from: anchor, to: anchor };
    if (mode === "month") return { from: monthStart(anchor), to: monthEnd(anchor) };
    return { from: mondayOf(anchor), to: sundayOf(anchor) };
  }, [mode, anchor]);

  // фокус-день у межах поточного тижня (для day-strip + кластера)
  const weekOfFocus = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(mondayOf(focusDay), i)), [focusDay]);
  const scopeParams = teamId ? { teamId: Number(teamId) } : {};

  useEffect(() => {
    let a = true; setLoading(true);
    Promise.all([
      fetchReportPlan({ ...period, ...scopeParams }),
      fetchReportPlan({ from: focusDay, to: focusDay, ...scopeParams }),
    ]).then(([p, f]) => { if (!a) return; setData(p); setFocus(f); }).catch(() => a && setData(null)).finally(() => a && setLoading(false));
    return () => { a = false; };
  }, [period.from, period.to, focusDay, teamId]);

  const focusByMgr = useMemo(() => new Map((focus?.managers ?? []).map((m) => [m.managerId, m])), [focus]);
  // E7: менеджер бачить свою КОМАНДУ; його рядок підсвічений, «Ти» = особисте.
  const viewerId = data?.viewerManagerId ?? auth.managerId;
  const selfRow = data?.managers.find((m) => m.managerId === viewerId) ?? null;
  const selfFocus = viewerId != null ? focusByMgr.get(viewerId) ?? null : null;
  const roleChip = auth.role === "manager" ? "свою команду" : auth.role === "team_lead" ? "свою команду" : "усі команди";
  const periodLabel = mode === "day" ? anchor : mode === "month" ? anchor.slice(0, 7) : `${ddmm(period.from)}–${ddmm(period.to)}`;

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto" }}>
      {/* Хедер */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Звіт{teamId && teams.find((t) => t.id === Number(teamId)) ? ` — ${teams.find((t) => t.id === Number(teamId))!.name}` : ""}</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>План із задачника · факт з CRM · {periodLabel}</div>
        </div>
        <div style={{ fontSize: 12, color: MUTED, background: "var(--card-bg)", border: "1px solid var(--border)", padding: "4px 11px", borderRadius: 20 }}>
          Ти бачиш: <b style={{ color: "var(--text)" }}>{roleChip}</b>
        </div>
      </div>

      {/* Нав: режим + період + календар + команда(admin) */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 11 }}>
          {(["day", "week", "month"] as Mode[]).map((mo) => (
            <button key={mo} onClick={() => setMode(mo)} style={{
              padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600,
              background: mode === mo ? "var(--card-bg)" : "transparent", color: mode === mo ? "var(--text)" : MUTED,
              boxShadow: mode === mo ? "0 1px 3px rgba(20,30,50,.1)" : "none",
            }}>{mo === "day" ? "День" : mo === "week" ? "Тиждень" : "Місяць"}</button>
          ))}
        </div>
        <button onClick={() => setAnchor(addDays(anchor, mode === "day" ? -1 : mode === "week" ? -7 : -30))} style={navBtn}>←</button>
        <button onClick={() => { setAnchor(today); setFocusDay(today); }} style={navBtn}>Сьогодні</button>
        <button onClick={() => setAnchor(addDays(anchor, mode === "day" ? 1 : mode === "week" ? 7 : 30))} style={navBtn}>→</button>
        <DatePicker value={anchor} onChange={(v) => v && (setAnchor(v), setFocusDay(v))} mode="day" minWidth={140} />
        {auth.role === "admin" && (
          <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")} style={{ ...navBtn, cursor: "pointer" }}>
            <option value="">Усі команди</option>
            {teams.filter((t) => !HIDE_TEAMS.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </div>

      {/* День-strip (тиждень фокус-дня, Пн–Нд) */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 16 }}>
        {weekOfFocus.map((d, i) => {
          const isF = d === focusDay, future = d > today;
          return (
            <div key={d} onClick={() => !future && setFocusDay(d)} style={{
              minWidth: 60, textAlign: "center", padding: "7px 10px", borderRadius: 10, cursor: future ? "default" : "pointer",
              border: `1px solid ${isF ? "var(--text)" : "var(--border)"}`, background: isF ? "var(--text)" : "var(--card-bg)",
              color: isF ? "var(--card-bg)" : "var(--text)", opacity: future ? 0.4 : 1,
            }}>
              <small style={{ display: "block", fontSize: 11, textTransform: "uppercase", letterSpacing: ".4px", color: isF ? "var(--card-bg)" : MUTED }}>
                {WD[i]}{d === today ? " •" : ""}
              </small>
              <b style={{ fontSize: 15, color: i >= 5 && !isF ? MUTED : undefined }}>{d.slice(8)}</b>
            </div>
          );
        })}
      </div>

      {loading && !data ? <div style={{ color: MUTED, padding: 20 }}>Завантаження…</div> : data && (
        <>
          <Glance data={data} focus={focus} focusDay={focusDay} today={today} />
          {/* E7: у вигляді менеджера — особистий блок «Ти» (свої числа) поруч з агрегатом команди */}
          {auth.role === "manager" && selfRow && (
            <MgrStrip m={selfRow} fy={selfFocus ?? undefined} focusDay={focusDay} today={today}
              elapsed={data.elapsed} remWd={data.remainingWorkdays} period={period} role={auth.role} isSelf
              open={openMgr === selfRow.managerId} onToggle={() => setOpenMgr(openMgr === selfRow.managerId ? null : selfRow.managerId)} />
          )}
          <div style={{ fontSize: 12, color: MUTED, margin: "0 2px 10px" }}>
            {auth.role === "manager" ? "↓ Твоя команда — хто відстає, той угорі" : "↓ Відсортовано за станом — хто відстає, той угорі"}
          </div>
          {data.managers.map((m) => (
            <MgrStrip key={m.managerId} m={m} fy={focusByMgr.get(m.managerId)} focusDay={focusDay} today={today}
              elapsed={data.elapsed} remWd={data.remainingWorkdays} period={period} role={auth.role}
              isSelf={m.managerId === viewerId}
              open={openMgr === m.managerId} onToggle={() => setOpenMgr(openMgr === m.managerId ? null : m.managerId)} />
          ))}
          {data.managers.length === 0 && <div style={{ color: MUTED, padding: 20 }}>Немає менеджерів у цьому розрізі.</div>}
          <Legend />
        </>
      )}
    </div>
  );
}

const navBtn: React.CSSProperties = { border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 8, padding: "7px 12px", fontSize: 13, cursor: "pointer" };

function Glance({ data, focus, focusDay, today }: { data: ReportPlan; focus: ReportPlan | null; focusDay: string; today: string }) {
  const g = data.glance;
  const pct = g.plan > 0 ? Math.round((g.fact / g.plan) * 100) : 0;
  const fg = focus?.glance;
  const st = g.statusCounts;
  const futureFocus = focusDay > today; // A2: факт майбутнього дня не показуємо
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 15, padding: "16px 18px", marginBottom: 16, display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr", gap: 20, alignItems: "center" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <Donut pct={pct} />
        <div>
          <div style={lab}>Команда до плану</div>
          <div style={val}>{fmt(g.fact)} <small style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>/ {fmt(g.plan)} ₴</small></div>
          {/* D5: усі ТРИ лічильники завжди (зрив / відстає / у нормі) */}
          <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
            <Pill c={RED}>{st.r} зрив</Pill>
            <Pill c={AMBER}>{st.a} відстає</Pill>
            <Pill c={GREEN}>{st.g} у нормі</Pill>
          </div>
        </div>
      </div>
      <div>
        <div style={lab}>Очікуємо цей період <InfoHint text="Живий пайплайн у зоні визнання доходу (виставлено→оплата), знімок «зараз». Без мінусу." /></div>
        <div style={val}>{fmt(g.expect)} <small style={{ fontSize: 12, color: MUTED }}>₴</small></div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>живий пайплайн, без мінусу</div>
      </div>
      <div>
        <div style={lab}>Фокус-день {ddmm(focusDay)}</div>
        {futureFocus ? (
          <div style={{ ...val, color: MUTED }}>— <small style={{ fontSize: 12, fontWeight: 600 }}>ще попереду</small></div>
        ) : (
          <div style={val}>{fg?.dispatched ?? 0} <small style={{ fontSize: 12, color: MUTED }}>авто · </small>{k(fg?.fact ?? 0)}<small style={{ fontSize: 12, color: MUTED }}> отримано</small></div>
        )}
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{futureFocus ? "день ще не настав" : `створено ${fg?.created ?? 0} угод`}</div>
      </div>
    </div>
  );
}
const lab: React.CSSProperties = { fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px" };
const val: React.CSSProperties = { fontSize: 19, fontWeight: 750, letterSpacing: "-.3px" };
function Pill({ c, children }: { c: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: c + "22", color: c }}>{children}</span>;
}
function Donut({ pct }: { pct: number }) {
  const col = pct >= 100 ? GREEN : pct >= 70 ? AMBER : RED;
  const ring = Math.min(100, Math.max(0, pct)); // D6: кільце ≤100% візуально, число повне
  return (
    <div style={{ width: 58, height: 58, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", position: "relative", background: `conic-gradient(${col} ${ring}%, var(--border) 0)` }}>
      <div style={{ width: 42, height: 42, background: "var(--card-bg)", borderRadius: "50%", position: "absolute" }} />
      <span style={{ position: "relative", fontWeight: 750, fontSize: 13 }}>{pct}%</span>
    </div>
  );
}

function MgrStrip({ m, fy, focusDay, today, elapsed, remWd, period, role, isSelf, open, onToggle }: {
  m: ReportPlanManager; fy: ReportPlanManager | undefined; focusDay: string; today: string; elapsed: number; remWd: number;
  period: { from: string; to: string }; role: string; isSelf?: boolean; open: boolean; onToggle: () => void;
}) {
  const s = m.status;
  const pct = m.plan > 0 ? Math.round((m.fact / m.plan) * 100) : 0;
  const smax = Math.max(...m.spark, 1);
  const futureFocus = focusDay > today; // A2: факт майбутнього дня не показуємо
  const cr = fy?.created ?? 0, nw = fy?.new ?? 0, rp = fy?.rep ?? 0, disp = fy?.kpi.dispatch.fact ?? 0, recv = fy?.fact ?? 0;
  const showWhy = s !== "g"; // «чому+дія» лише не-зеленим
  return (
    <div style={{ background: isSelf ? BAR + "0d" : "var(--card-bg)", border: `1px solid ${isSelf ? BAR + "88" : "var(--border)"}`, borderLeft: `4px solid ${SCOL[s]}`, borderRadius: 14, marginBottom: 11, overflow: "hidden" }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: "210px 1fr 320px 34px", gap: 18, alignItems: "center", padding: "15px 17px", cursor: "pointer" }}>
        {/* who + status */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15.5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {m.name}<span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: TAGCOL[m.tag] + "22", color: TAGCOL[m.tag] }}>{m.tag.toUpperCase()}</span>
            {isSelf && <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 20, background: BAR + "22", color: BAR }}>ТИ</span>}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 750, fontSize: 12.5, padding: "3px 10px", borderRadius: 20, width: "max-content", background: SCOL[s] + "22", color: SCOL[s] }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: SCOL[s] }} />{SLBL[s]}
          </span>
        </div>
        {/* plan bar */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontWeight: 750, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>{fmt(m.fact)} <small style={{ color: MUTED, fontWeight: 600, fontSize: 12.5 }}>/ {m.plan > 0 ? fmt(m.plan) : "—"} ₴</small></span>
            <span style={{ fontWeight: 750, fontSize: 15, color: SCOL[s] }}>{m.plan > 0 ? `${pct}%` : "—"}</span>
          </div>
          <div style={{ height: 9, background: "var(--border)", borderRadius: 6, overflow: "hidden", position: "relative" }}>
            <div style={{ height: "100%", borderRadius: 6, width: `${Math.min(100, pct)}%`, background: SCOL[s] }} />
            <div title="темп «сьогодні»" style={{ position: "absolute", top: -3, bottom: -3, width: 2, left: `${Math.min(100, elapsed * 100)}%`, background: "var(--text)", opacity: 0.55 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: MUTED, marginTop: 5 }}>
            <span>треба <b style={{ color: "var(--text)" }}>{fmt(m.needPerDay)} ₴/день</b> (лишилось {remWd} дн.)</span>
            <span>очікуємо <b style={{ color: "var(--text)" }}>{k(m.expect)}</b></span>
          </div>
          {/* KPI X/ціль — компактні індикатори */}
          <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
            <Kpi lbl="реклама" fact={m.kpi.ads.fact} target={m.kpi.ads.target} />
            <Kpi lbl="лідоген" fact={m.kpi.leadgen.fact} target={m.kpi.leadgen.target} />
            <Kpi lbl="авто" fact={m.kpi.dispatch.fact} target={m.kpi.dispatch.target} />
            <Kpi lbl="чек" fact={m.kpi.avgCheck.fact} target={m.kpi.avgCheck.target} money />
            <Kpi lbl="конв" fact={m.kpi.conversion.fact} target={m.kpi.conversion.target} pctUnit second />
          </div>
        </div>
        {/* focus-day cluster + spark — майбутній день без факту (A2) */}
        <div style={{ display: "flex", gap: 14, alignItems: "center", justifyContent: "flex-end" }}>
          {futureFocus ? (
            <div style={{ fontSize: 11.5, color: MUTED, textAlign: "right", minWidth: 120 }}>{ddmm(focusDay)}<br />ще попереду</div>
          ) : (
            <>
              <Stat v={cr} l="створено" sub={`${nw}нов · ${rp}пост`} />
              <Stat v={disp} l="авто" />
              <Stat v={recv} l="отримано ₴" money />
            </>
          )}
          <div title="отримано по тижнях (5)" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34 }}>
            {m.spark.map((v, ix) => (
              <div key={ix} style={{ width: 7, borderRadius: 2, background: ix === m.spark.length - 1 ? BAR : "var(--border)", height: Math.max(3, (v / smax) * 34) }} />
            ))}
          </div>
        </div>
        <div style={{ color: MUTED, textAlign: "center", fontSize: 13, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</div>
      </div>
      {showWhy && <WhyBox m={m} role={role} isSelf={!!isSelf} />}
      {open && <DayDrill managerId={m.managerId} period={period} focusDay={focusDay} today={today} />}
    </div>
  );
}

// C4: усі KPI однаково «факт/ціль». Де цілі нема → «—» (не ховати). Формат ціль/факт спільний.
function Kpi({ lbl, fact, target, money, pctUnit, second }: { lbl: string; fact: number | null; target: number; money?: boolean; pctUnit?: boolean; second?: boolean }) {
  const ok = target > 0 && fact != null && fact >= target;
  const has = target > 0;
  const col = !has ? MUTED : ok ? GREEN : AMBER;
  const f = fact == null ? "—" : money ? fmt(fact) : pctUnit ? `${fact}%` : String(fact);
  const t = has ? (money ? k(target) : pctUnit ? target + "%" : String(target)) : "—";
  return (
    <span style={{ fontSize: 11.5, color: MUTED, fontWeight: second ? 700 : 400 }} title={`${lbl}: факт ${f} / ціль ${has ? (money ? fmt(target) : pctUnit ? target + "%" : target) : "не задано"}`}>
      {lbl} <b style={{ color: col }}>{f}</b><span style={{ color: MUTED }}>/{t}</span>{has && ok ? " ✓" : ""}
    </span>
  );
}
function Stat({ v, l, sub, money }: { v: number; l: string; sub?: string; money?: boolean }) {
  return (
    <div style={{ textAlign: "center", minWidth: 52 }}>
      <div style={{ fontWeight: 750, fontSize: 16, fontVariantNumeric: "tabular-nums", lineHeight: 1.1, color: v ? "var(--text)" : MUTED }}>{money ? (v ? fmt(v) : "0") : v}</div>
      <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: ".3px", marginTop: 2 }}>{l}</div>
      {sub && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// «Чому + Дія» — детермінований діагноз (не зелений). F8: світлофор ПО ГРОШАХ; де
// активність по плану, а гроші відстають — це СИГНАЛ тімліду, не «провал». F9: дія
// рольова (менеджеру — під нього; «замовити лідогенів» лишити тімліду/адміну).
function WhyBox({ m, role, isSelf }: { m: ReportPlanManager; role: string; isSelf: boolean }) {
  const behind = m.plan > 0 ? Math.max(0, m.plan - m.fact) : 0;
  const met = (x: { fact: number | null; target: number }) => x.target > 0 && x.fact != null && x.fact >= x.target;
  const low = (x: { fact: number | null; target: number }) => x.target > 0 && x.fact != null && x.fact < x.target;
  const activityOnPlan = met(m.kpi.ads) || met(m.kpi.leadgen) || met(m.kpi.dispatch); // хоч одна активність по плану
  const lowLeads = low(m.kpi.ads) || low(m.kpi.leadgen);
  const forMe = role === "manager" || isSelf; // формулювати під менеджера
  const why = activityOnPlan
    ? `Активність по плану, але гроші відстають — потрібне втручання (факт ${k(m.fact)} / ${k(m.plan)}, ${m.pct ?? 0}%).`
    : m.status === "r"
      ? `Зрив темпу: факт ${k(m.fact)} при плані ${k(m.plan)} (${m.pct ?? 0}%).`
      : `Відстає: факт ${k(m.fact)} (${m.pct ?? 0}% плану), нижче темпу.`;
  const act = m.expect > behind
    ? (forMe
      ? `Пайплайн здоровий (очікуємо ${k(m.expect)}). Дотисни угоди з «Перевезення завершено» / «Дзвінок після розвантаж.».`
      : `Пайплайн здоровий (очікуємо ${k(m.expect)}). Дія: дотиснути угоди на грошових стадіях.`)
    : lowLeads
      ? (forMe
        ? `Лідів мало. Підніми оплати й додай нові ліди. Треба ${fmt(m.needPerDay)} ₴/день.`
        : `Лідів мало (реклама/лідоген нижче цілі). Дія: замовити лідогенів + підняти оплати. Треба ${fmt(m.needPerDay)} ₴/день.`)
      : (forMe
        ? `Пайплайну бракує (очікуємо ${k(m.expect)}). Наростай нові ліди й прискорюй закриття. Треба ${fmt(m.needPerDay)} ₴/день.`
        : `Пайплайну бракує (очікуємо лише ${k(m.expect)}). Дія: наростити ліди + прискорити закриття. Треба ${fmt(m.needPerDay)} ₴/день.`);
  const c = m.status === "r" ? RED : AMBER;
  return (
    <div style={{ padding: "0 17px 15px" }}>
      <div style={{ borderRadius: 10, padding: "11px 14px", fontSize: 13, display: "flex", gap: 12, alignItems: "flex-start", background: c + "18" }}>
        <span style={{ fontSize: 15 }}>{SICON[m.status]}</span>
        <div><b>{why}</b><div style={{ marginTop: 3, color: "var(--text)" }}>{act}</div></div>
      </div>
    </div>
  );
}

// Дрил: тиждень→день→угоди. День-клітинки з manager-detail; угоди — лінивий фетч.
function DayDrill({ managerId, period, focusDay, today }: { managerId: number; period: { from: string; to: string }; focusDay: string; today: string }) {
  const [d, setD] = useState<KvpManagerDetail | null>(null);
  const [err, setErr] = useState(false);
  const [dealsOpen, setDealsOpen] = useState<string | null>(null);
  const [deals, setDeals] = useState<Record<string, ReportPlanDeal[]>>({});
  useEffect(() => {
    let a = true; setD(null); setErr(false);
    fetchManagerDetail({ managerId, from: period.from, to: period.to }).then((x) => a && setD(x)).catch(() => a && setErr(true));
    return () => { a = false; };
  }, [managerId, period.from, period.to]);
  const openDeals = (day: string) => {
    setDealsOpen(dealsOpen === day ? null : day);
    if (!deals[day]) fetchReportPlanDeals({ managerId, date: day }).then((ds) => setDeals((p) => ({ ...p, [day]: ds }))).catch(() => setDeals((p) => ({ ...p, [day]: [] })));
  };
  if (err) return <div style={{ padding: "0 17px 16px", color: RED, fontSize: 12 }}>Не вдалося завантажити деталь.</div>;
  if (!d) return <div style={{ padding: "0 17px 16px", color: MUTED, fontSize: 12 }}>Завантаження деталі…</div>;
  const days = d.weeks.flatMap((w) => w.days);
  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg)", padding: "14px 17px 18px" }}>
      <div style={{ fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px", margin: "0 0 9px" }}>По днях періоду · клік на день → угоди</div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
          <thead><tr>{["День", "Створено", "Авто", "Отримано", "Сер.чек", "Нові/Пост."].map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left" }}>{h}</th>)}</tr></thead>
          <tbody>
            {days.map((x) => {
              const chk = x.dispatched ? Math.round(x.received.revenue / x.dispatched) : 0;
              const isF = x.day === focusDay;
              const future = x.day > today;          // A2: факт майбутнього не показуємо
              const weekend = dow(x.day) >= 6;       // A2: вихідні притлумити
              const dim = future || weekend;
              return (
                <Fragment key={x.day}>
                  <tr onClick={() => !future && openDeals(x.day)} style={{ cursor: future ? "default" : "pointer", background: isF ? AMBER + "18" : weekend ? "var(--border)" + "44" : undefined, color: dim ? MUTED : undefined }}>
                    <td style={{ textAlign: "left", fontWeight: 600, color: dim ? MUTED : undefined }}>{future ? "" : "▸ "}{WD[dow(x.day) - 1]} {ddmm(x.day)}{isF ? " •" : ""}</td>
                    {future ? (
                      <td colSpan={5} style={{ textAlign: "right", color: MUTED, fontStyle: "italic" }}>ще попереду</td>
                    ) : (
                      <>
                        <td style={{ textAlign: "right" }}>{x.created || "—"} {x.created ? <span style={{ color: MUTED, fontSize: 11 }}>({x.newCount}н·{x.repeatCount}п)</span> : null}</td>
                        <td style={{ textAlign: "right" }}>{x.dispatched || "—"}</td>
                        <td style={{ textAlign: "right" }}>{x.received.revenue ? fmt(x.received.revenue) + " ₴" : "—"}</td>
                        <td style={{ textAlign: "right" }}>{chk ? fmt(chk) : "—"}</td>
                        <td style={{ textAlign: "right" }}>{x.newCount}/{x.repeatCount}</td>
                      </>
                    )}
                  </tr>
                  {dealsOpen === x.day && (
                    <tr><td colSpan={6} style={{ padding: 0, background: "var(--card-bg)" }}>
                      {(deals[x.day] ?? []).length === 0 ? <div style={{ padding: "8px 12px", color: MUTED, fontSize: 12 }}>{deals[x.day] ? "Немає угод." : "Завантаження…"}</div>
                        : (deals[x.day] ?? []).map((dl, i) => (
                          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 92px 100px", gap: 10, padding: "7px 12px", borderBottom: "1px solid var(--border)", fontSize: 12, alignItems: "center" }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dl.name || "—"}</span>
                            <span style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 5, textAlign: "center", background: (dl.src === "new" ? BAR : GREEN) + "22", color: dl.src === "new" ? BAR : GREEN }}>{dl.src === "new" ? "новий" : "постійний"}</span>
                            <span style={{ textAlign: "right", fontWeight: 650, color: dl.price ? "var(--text)" : MUTED }}>{dl.price ? fmt(dl.price) + " ₴" : dl.status}</span>
                          </div>
                        ))}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
            <tr style={{ background: "var(--bg)", fontWeight: 750, borderTop: "2px solid var(--border)" }}>
              <td style={{ textAlign: "left" }}>Σ {period.from === period.to ? "день" : "період"}</td>
              <td style={{ textAlign: "right" }}>{d.monthTotals.created}</td>
              <td style={{ textAlign: "right" }}>{d.monthTotals.dispatched}</td>
              <td style={{ textAlign: "right" }}>{fmt(d.monthTotals.received.revenue)} ₴</td>
              <td style={{ textAlign: "right" }}>{d.monthTotals.dispatched ? fmt(Math.round(d.monthTotals.received.revenue / d.monthTotals.dispatched)) : "—"}</td>
              <td style={{ textAlign: "right" }}>{d.monthTotals.newCount}/{d.monthTotals.repeatCount}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: MUTED, margin: "22px 2px 0", paddingTop: 15, borderTop: "1px solid var(--border)" }}>
      {(["g", "a", "r"] as const).map((s) => <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: SCOL[s] }} /> {SICON[s]} {SLBL[s]}</span>)}
      <span>│ на смузі — позначка «сьогодні» (де мав би бути темп)</span>
    </div>
  );
}
