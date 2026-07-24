import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchReportPlan, fetchReportPlanDeals, fetchManagerDetail, fetchStuckDeals,
  type ReportPlan, type ReportPlanManager, type ReportPlanDeal, type KvpManagerDetail, type Team,
  type StuckDeal,
} from "../../../api";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";
import { ResponseTimeCard } from "./ResponseTimeCard";

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
const addMonth = (s: string, n: number) => { const [y, m] = s.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return iso(d); };
const todayKyiv = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const ddmm = (s: string) => s.slice(8) + "." + s.slice(5, 7);
const monLbl = (s: string) => { const M = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"]; return M[Number(s.slice(5, 7)) - 1] + " " + s.slice(0, 4); };
// Компактна розбивка авто за джерелом (пост/лід/рекл/невз), нулі приховані. «5пост · 3лід · 1рекл».
const autoSplit = (repeat: number, leadgen: number, ad: number, undef: number): string =>
  ([[repeat, "пост"], [leadgen, "лід"], [ad, "рекл"], [undef, "невз"]] as [number, string][])
    .filter(([n]) => n > 0).map(([n, l]) => `${n}${l}`).join(" · ");

type Mode = "day" | "week" | "month" | "range";

export function ReportPlanSection({ auth, teams }: {
  auth: { role: string; managerId: number | null; teamId: number | null };
  teams: Team[];
}) {
  const today = todayKyiv();
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState(today);        // якір (місяць + навігація)
  const [focusDay, setFocusDay] = useState(today);    // активний день (тиждень-контекст + кластер)
  const [rangeFrom, setRangeFrom] = useState(monthStart(today));
  const [rangeTo, setRangeTo] = useState(today);
  const [teamId, setTeamId] = useState<number | "">("");
  const [monthData, setMonthData] = useState<ReportPlan | null>(null); // головна траєкторія + сортування + glance
  const [weekData, setWeekData] = useState<ReportPlan | null>(null);   // тиждень-контекст смуги
  const [focus, setFocus] = useState<ReportPlan | null>(null);         // кластер фокус-дня
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);        // місяць не піднявся навіть після ретраїв → видима помилка
  const [retryNonce, setRetryNonce] = useState(0); // ручний «Спробувати знову» перезапускає ефект
  const [openMgr, setOpenMgr] = useState<number | null>(null);

  // Місяць + тиждень видно ЗАВЖДИ у шапці смуги (#11). Селектор керує лише дрилом унизу.
  const monthPeriod = useMemo(() => ({ from: monthStart(anchor), to: monthEnd(anchor) }), [anchor]);
  const weekPeriod = useMemo(() => ({ from: mondayOf(focusDay), to: sundayOf(focusDay) }), [focusDay]);
  const drillPeriod = useMemo(() => {
    if (mode === "day") return { from: focusDay, to: focusDay };
    if (mode === "week") return weekPeriod;
    if (mode === "range") return { from: rangeFrom, to: rangeTo };
    return monthPeriod;
  }, [mode, focusDay, weekPeriod, monthPeriod, rangeFrom, rangeTo]);

  const weekOfFocus = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(mondayOf(focusDay), i)), [focusDay]);
  const scopeParams = teamId ? { teamId: Number(teamId) } : {};

  // САМОВІДНОВЛЕННЯ (фікс порожнечі при транзієнтному відхиленні):
  //  • cancelled-guard: жоден перерваний/застарілий виклик не пише стан (антигонка).
  //  • МІСЯЦЬ (головне тіло) — з авто-ретраєм (2 спроби + backoff); транзієнтний блимок
  //    піднімається САМ, без ручного refresh. Провал ПІСЛЯ ретраїв → err (видима помилка+ретрай).
  //  • ТИЖДЕНЬ/ФОКУС — best-effort (allSettled): їхня невдача НЕ обнуляє звіт (не «все або нічого»).
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(false);
    const withRetry = async (params: { from: string; to: string; teamId?: number }, attempts = 3) => {
      for (let i = 0; ; i++) {
        try { return await fetchReportPlan(params); }
        catch (e) {
          if (cancelled) throw e;
          if (i >= attempts - 1) throw e;
          await new Promise((r) => setTimeout(r, 300 * (i + 1))); // 300мс, 600мс backoff
        }
      }
    };
    (async () => {
      try {
        const m = await withRetry({ ...monthPeriod, ...scopeParams });
        if (cancelled) return;
        setMonthData(m);
        const [w, f] = await Promise.allSettled([
          fetchReportPlan({ ...weekPeriod, ...scopeParams }),
          fetchReportPlan({ from: focusDay, to: focusDay, ...scopeParams }),
        ]);
        if (cancelled) return;
        if (w.status === "fulfilled") setWeekData(w.value);
        if (f.status === "fulfilled") setFocus(f.value);
      } catch {
        if (!cancelled) setErr(true);   // ніколи не лишаємо мовчазну порожнечу
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [monthPeriod.from, monthPeriod.to, weekPeriod.from, weekPeriod.to, focusDay, teamId, retryNonce]);

  const data = monthData; // список/сортування/glance — за МІСЯЦЕМ (стабільно, без стрибків)
  const weekByMgr = useMemo(() => new Map((weekData?.managers ?? []).map((m) => [m.managerId, m])), [weekData]);
  const focusByMgr = useMemo(() => new Map((focus?.managers ?? []).map((m) => [m.managerId, m])), [focus]);
  const viewerId = data?.viewerManagerId ?? auth.managerId;
  const selfRow = data?.managers.find((m) => m.managerId === viewerId) ?? null;
  const roleChip = auth.role === "admin" ? "усі команди" : "свою команду";
  const teamName = teamId ? teams.find((t) => t.id === Number(teamId))?.name : "";

  // Навігація ←/→ за одиницею режиму; синхронізує anchor+focusDay.
  const nav = (dir: number) => {
    if (mode === "month") setAnchor(addMonth(anchor, dir));
    else if (mode === "range") { /* діапазон — лише через календар */ }
    else { const step = mode === "day" ? dir : dir * 7; const nd = addDays(focusDay, step); setFocusDay(nd); setAnchor(nd); }
  };

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto" }}>
      {/* Хедер */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
        <div>
          <h1 style={{ fontSize: 21, margin: 0 }}>Звіт{teamName ? ` — ${teamName}` : ""}</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>Грошовий план — вкладка «Плани» (2.7 млн) · KPI-активність — задачник · {monLbl(anchor)}</div>
        </div>
        <div style={{ fontSize: 12, color: MUTED, background: "var(--card-bg)", border: "1px solid var(--border)", padding: "4px 11px", borderRadius: 20 }}>
          Ти бачиш: <b style={{ color: "var(--text)" }}>{roleChip}</b>
        </div>
      </div>

      {/* Нав: режим (дрил) + період + календар + команда(admin) */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 4, background: "var(--bg)", padding: 4, borderRadius: 11 }}>
          {(["day", "week", "month", "range"] as Mode[]).map((mo) => (
            <button key={mo} onClick={() => setMode(mo)} style={{
              padding: "7px 15px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600,
              background: mode === mo ? "var(--card-bg)" : "transparent", color: mode === mo ? "var(--text)" : MUTED,
              boxShadow: mode === mo ? "0 1px 3px rgba(20,30,50,.1)" : "none",
            }}>{mo === "day" ? "День" : mo === "week" ? "Тиждень" : mo === "month" ? "Місяць" : "Період"}</button>
          ))}
        </div>
        <button onClick={() => nav(-1)} disabled={mode === "range"} style={{ ...navBtn, opacity: mode === "range" ? 0.4 : 1 }}>←</button>
        <button onClick={() => { setAnchor(today); setFocusDay(today); }} style={navBtn}>Сьогодні</button>
        {/* #15 — швидко на поточний тиждень */}
        <button onClick={() => { setMode("week"); setAnchor(today); setFocusDay(today); }} style={navBtn}>Поточний тиждень</button>
        <button onClick={() => nav(1)} disabled={mode === "range"} style={{ ...navBtn, opacity: mode === "range" ? 0.4 : 1 }}>→</button>
        {mode === "range" ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, color: MUTED }}>
            <DatePicker value={rangeFrom} onChange={(v) => v && setRangeFrom(v)} mode="day" minWidth={130} />–
            <DatePicker value={rangeTo} onChange={(v) => v && setRangeTo(v)} mode="day" minWidth={130} />
          </span>
        ) : (
          <DatePicker value={anchor} onChange={(v) => v && (setAnchor(v), setFocusDay(v))} mode="day" minWidth={140} />
        )}
        {auth.role === "admin" && (
          <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")} style={{ ...navBtn, cursor: "pointer" }}>
            <option value="">Усі команди</option>
            {teams.filter((t) => !HIDE_TEAMS.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </div>

      {/* День-strip (тиждень фокус-дня, Пн–Нд) — вибір активного тижня/дня */}
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

      {err && !data ? (
        <div style={{ textAlign: "center", padding: 28, color: MUTED }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>⚠️</div>
          <div style={{ marginBottom: 12 }}>Не вдалося завантажити звіт (тимчасовий збій зʼєднання).</div>
          <button onClick={() => setRetryNonce((n) => n + 1)}
            style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: BAR, color: "#fff", fontWeight: 700, cursor: "pointer" }}>
            Спробувати знову
          </button>
        </div>
      ) : loading && !data ? <div style={{ color: MUTED, padding: 20 }}>Завантаження…</div> : data && (
        <>
          <Glance data={data} focus={focus} focusDay={focusDay} today={today} />
          {/* Блоки як у КВП — ВГОРУ, перед списком менеджерів (на видноті). Роль-скоуп на
              бекенді за токеном; teamId впливає лише на admin (manager/team_lead форсяться роллю). */}
          <StuckBlock teamId={teamId ? Number(teamId) : undefined} />
          <ResponseTimeCard from={monthPeriod.from} to={monthPeriod.to} teamId={teamId ? Number(teamId) : undefined} />
          {auth.role === "manager" && selfRow && (
            <MgrStrip m={selfRow} mWeek={weekByMgr.get(selfRow.managerId)} fy={focusByMgr.get(selfRow.managerId)}
              focusDay={focusDay} today={today} elapsed={data.elapsed} remWd={data.remainingWorkdays}
              weekLabel={`${ddmm(weekPeriod.from)}–${ddmm(weekPeriod.to)}`} drillPeriod={drillPeriod} role={auth.role} isSelf
              open={openMgr === selfRow.managerId} onToggle={() => setOpenMgr(openMgr === selfRow.managerId ? null : selfRow.managerId)} />
          )}
          <div style={{ fontSize: 12, color: MUTED, margin: "0 2px 10px" }}>
            ↓ {auth.role === "manager" ? "Твоя команда" : "Відсортовано"} за <b>місячним</b> станом — хто відстає, той угорі
          </div>
          {data.managers.map((m) => (
            <MgrStrip key={m.managerId} m={m} mWeek={weekByMgr.get(m.managerId)} fy={focusByMgr.get(m.managerId)}
              focusDay={focusDay} today={today} elapsed={data.elapsed} remWd={data.remainingWorkdays}
              weekLabel={`${ddmm(weekPeriod.from)}–${ddmm(weekPeriod.to)}`} drillPeriod={drillPeriod} role={auth.role}
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
  const futureFocus = focusDay > today;
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 15, padding: "16px 18px", marginBottom: 16, display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr", gap: 20, alignItems: "center" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <Donut pct={pct} />
        <div>
          <div style={lab}>Команда за місяць <InfoHint text="Грошовий план — стратегічна ціль із вкладки «Плани» (відділ 2.7 млн). Факт — отримані кошти (success⊎paidOnly)." /></div>
          <div style={val}>{fmt(g.fact)} <small style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>/ {fmt(g.plan)} ₴</small></div>
          <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
            <Pill c={RED}>{st.r} зрив</Pill>
            <Pill c={AMBER}>{st.a} відстає</Pill>
            <Pill c={GREEN}>{st.g} у нормі</Pill>
          </div>
        </div>
      </div>
      <div>
        <div style={lab}>💰 Очікуємо (Σ команди) <InfoHint text="Сума очікуваних коштів по всіх менеджерах у зоні визнання доходу (виставлено→оплата), знімок «зараз». Без мінусу. Σ per-manager == КВП." /></div>
        <div style={{ ...val, color: g.expect > 0 ? GREEN : MUTED }}>{fmt(g.expect)} <small style={{ fontSize: 12, color: MUTED }}>₴</small></div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>авто за місяць: {g.dispatched} · {k(g.dispatchedRevenue)} ₴</div>
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
  const ring = Math.min(100, Math.max(0, pct)); // кільце ≤100% візуально, число повне
  return (
    <div style={{ width: 58, height: 58, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", position: "relative", background: `conic-gradient(${col} ${ring}%, var(--border) 0)` }}>
      <div style={{ width: 42, height: 42, background: "var(--card-bg)", borderRadius: "50%", position: "absolute" }} />
      <span style={{ position: "relative", fontWeight: 750, fontSize: 13 }}>{pct}%</span>
    </div>
  );
}

// Смуга менеджера: МІСЯЦЬ (головна траєкторія, статус+сортування) + ТИЖДЕНЬ (поточний), обидва завжди (#11).
function MgrStrip({ m, mWeek, fy, focusDay, today, elapsed, remWd, weekLabel, drillPeriod, role, isSelf, open, onToggle }: {
  m: ReportPlanManager; mWeek: ReportPlanManager | undefined; fy: ReportPlanManager | undefined;
  focusDay: string; today: string; elapsed: number; remWd: number; weekLabel: string;
  drillPeriod: { from: string; to: string }; role: string; isSelf?: boolean; open: boolean; onToggle: () => void;
}) {
  const s = m.status; // статус за МІСЯЦЕМ
  const pct = m.plan > 0 ? Math.round((m.fact / m.plan) * 100) : 0;
  const smax = Math.max(...m.spark, 1);
  const futureFocus = focusDay > today;
  const cr = fy?.created ?? 0, nw = fy?.new ?? 0, rp = fy?.rep ?? 0;
  const dispN = fy?.kpi.dispatch.fact ?? 0, dispRev = fy?.kpi.dispatch.revenue ?? 0, recv = fy?.fact ?? 0;
  const showWhy = s !== "g";
  // Сер.чек: виграно_дохід÷виграно_угод (==КВП); нема виграних, а є відправлені авто →
  // Σ сума відправлених÷авто (load_at, signed) з поміткою «*відпр.»; нема й авто → «—».
  const dispCnt = m.kpi.dispatch.fact ?? 0;
  const chekAlt = m.kpi.avgCheck.fact == null && dispCnt > 0;
  const chekFact = m.kpi.avgCheck.fact != null ? m.kpi.avgCheck.fact
    : (chekAlt ? Math.round((m.kpi.dispatch.revenue ?? 0) / dispCnt) : null);
  return (
    <div style={{ background: isSelf ? BAR + "0d" : "var(--card-bg)", border: `1px solid ${isSelf ? BAR + "88" : "var(--border)"}`, borderLeft: `4px solid ${SCOL[s]}`, borderRadius: 14, marginBottom: 11, overflow: "hidden" }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: "196px 1.1fr 1.1fr 300px 30px", gap: 14, alignItems: "center", padding: "15px 17px", cursor: "pointer" }}>
        {/* who + status */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {m.name}<span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: TAGCOL[m.tag] + "22", color: TAGCOL[m.tag] }}>{m.tag.toUpperCase()}</span>
            {isSelf && <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 7px", borderRadius: 20, background: BAR + "22", color: BAR }}>ТИ</span>}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 750, fontSize: 12, padding: "3px 10px", borderRadius: 20, width: "max-content", background: SCOL[s] + "22", color: SCOL[s] }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: SCOL[s] }} />{SLBL[s]} · міс
          </span>
        </div>
        {/* МІСЯЦЬ — план-бар (головна траєкторія) + #16 очікуємо + #17 прогноз */}
        <TrajBlock title="Місяць" fact={m.fact} plan={m.plan} pct={pct} status={s} elapsed={elapsed}
          footer={<>
            <div>треба <b style={{ color: "var(--text)" }}>{fmt(m.needPerDay)} ₴/д</b> ({remWd} дн.) · прогноз <b style={{ color: "var(--text)" }} title="факт + зона визнання + добір нового бізнесу (як у КВП)">{k(m.projected)}</b>{m.plan > 0 && m.monthInProgress ? ` (${Math.round((m.projected / m.plan) * 100)}%)` : ""}</div>
            <div style={{ marginTop: 3, fontSize: 12.5, color: "var(--text)" }} title="Сума очікуваних коштів у зоні визнання (виставлено→оплата, без мінусу) — == КВП per-manager «Очікуємо»">
              💰 очікуємо <b style={{ color: GREEN }}>{fmt(m.expect)} ₴</b>
            </div>
          </>} showTempo />
        {/* ТИЖДЕНЬ — поточний */}
        {mWeek ? (
          <TrajBlock title={`Тиждень ${weekLabel}`} fact={mWeek.fact} plan={mWeek.plan}
            pct={mWeek.plan > 0 ? Math.round((mWeek.fact / mWeek.plan) * 100) : 0} status={mWeek.status}
            footer={<>очікуємо <b style={{ color: "var(--text)" }}>{k(mWeek.expect)}</b></>} />
        ) : <div style={{ fontSize: 11.5, color: MUTED }}>тиждень —</div>}
        {/* focus-day cluster + spark */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-end" }}>
          {futureFocus ? (
            <div style={{ fontSize: 11.5, color: MUTED, textAlign: "right" }}>{ddmm(focusDay)}<br />ще попереду</div>
          ) : (
            <>
              <Stat v={cr} l="створено" sub={`${nw}нов · ${rp}пост`} />
              <Stat v={dispN} l="авто" sub={dispN ? (autoSplit(fy?.kpi.dispatch.repeat ?? 0, fy?.kpi.dispatch.leadgen ?? 0, fy?.kpi.dispatch.ad ?? 0, fy?.kpi.dispatch.undef ?? 0) || `${k(dispRev)} ₴`) : "0 ₴"} />
              <Stat v={recv} l="отримано ₴" money />
            </>
          )}
          <div title="отримано по тижнях (5)" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34 }}>
            {m.spark.map((v, ix) => (
              <div key={ix} style={{ width: 6, borderRadius: 2, background: ix === m.spark.length - 1 ? BAR : "var(--border)", height: Math.max(3, (v / smax) * 34) }} />
            ))}
          </div>
        </div>
        <div style={{ color: MUTED, textAlign: "center", fontSize: 13, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</div>
      </div>
      {/* KPI-рядок (місячний контекст) — усі факт/ціль, «план не задано» де немає (#13) */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "0 17px 13px", marginTop: -4 }}>
        <Kpi lbl="реклама" fact={m.kpi.ads.fact} target={m.kpi.ads.target} />
        <Kpi lbl="лідоген" fact={m.kpi.leadgen.fact} target={m.kpi.leadgen.target} />
        <Kpi lbl="авто" fact={m.kpi.dispatch.fact} target={m.kpi.dispatch.target}
          extra={`${k(m.kpi.dispatch.revenue ?? 0)} ₴${(() => { const s = autoSplit(m.kpi.dispatch.repeat ?? 0, m.kpi.dispatch.leadgen ?? 0, m.kpi.dispatch.ad ?? 0, m.kpi.dispatch.undef ?? 0); return s ? " · " + s : ""; })()}`} />
        <Kpi lbl="чек" fact={chekFact} target={m.kpi.avgCheck.target} money altMark={chekAlt ? "*відпр." : undefined} altTitle="по відправлених авто, ще не закриті (сума÷авто)" />
        <Kpi lbl="конв" fact={m.kpi.conversion.fact} target={m.kpi.conversion.target} pctUnit />
      </div>
      {showWhy && <WhyBox m={m} role={role} isSelf={!!isSelf} />}
      {open && <DayDrill managerId={m.managerId} period={drillPeriod} focusDay={focusDay} today={today} />}
    </div>
  );
}

// План-бар одного контексту (місяць або тиждень).
function TrajBlock({ title, fact, plan, pct, status, elapsed, footer, showTempo }: {
  title: string; fact: number; plan: number; pct: number; status: string; elapsed?: number;
  footer: React.ReactNode; showTempo?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".3px", marginBottom: 3 }}>{title}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <span style={{ fontWeight: 750, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{fmt(fact)} <small style={{ color: MUTED, fontWeight: 600, fontSize: 11.5 }}>/ {plan > 0 ? fmt(plan) : "—"} ₴</small></span>
        <span style={{ fontWeight: 750, fontSize: 14, color: SCOL[status] }}>{plan > 0 ? `${pct}%` : "—"}</span>
      </div>
      <div style={{ height: 8, background: "var(--border)", borderRadius: 6, overflow: "hidden", position: "relative" }}>
        <div style={{ height: "100%", borderRadius: 6, width: `${Math.min(100, pct)}%`, background: SCOL[status] }} />
        {showTempo && elapsed != null && <div title="темп «сьогодні»" style={{ position: "absolute", top: -3, bottom: -3, width: 2, left: `${Math.min(100, elapsed * 100)}%`, background: "var(--text)", opacity: 0.55 }} />}
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{footer}</div>
    </div>
  );
}

// C4/#13: усі KPI «факт/ціль»; де цілі нема → «план не задано» (не ховаємо факт). extra = ₴ авто (#12).
function Kpi({ lbl, fact, target, money, pctUnit, extra, altMark, altTitle }: { lbl: string; fact: number | null; target: number; money?: boolean; pctUnit?: boolean; extra?: string; altMark?: string; altTitle?: string }) {
  const ok = target > 0 && fact != null && fact >= target;
  const has = target > 0;
  const col = !has ? MUTED : ok ? GREEN : AMBER;
  const f = fact == null ? "—" : money ? fmt(fact) : pctUnit ? `${fact}%` : String(fact);
  return (
    <span style={{ fontSize: 11.5, color: MUTED }} title={altMark ? altTitle : `${lbl}: факт ${f} / ${has ? "ціль " + (money ? fmt(target) : pctUnit ? target + "%" : target) : "план не задано"}`}>
      {lbl} <b style={{ color: altMark ? AMBER : col }}>{f}</b>{altMark ? <sup style={{ fontSize: 8.5, color: AMBER, marginLeft: 1 }}>{altMark}</sup> : null}{extra ? <span style={{ color: MUTED }}> · {extra}</span> : null}
      {has ? <span style={{ color: MUTED }}> / {money ? k(target) : pctUnit ? target + "%" : target}{ok ? " ✓" : ""}</span>
           : <span style={{ color: MUTED, fontStyle: "italic" }}> · план не задано</span>}
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

// «Чому + Дія» — F8: світлофор ПО ГРОШАХ; активність по плану = сигнал, не «провал». F9: дія рольова.
function WhyBox({ m, role, isSelf }: { m: ReportPlanManager; role: string; isSelf: boolean }) {
  const behind = m.plan > 0 ? Math.max(0, m.plan - m.fact) : 0;
  const met = (x: { fact: number | null; target: number }) => x.target > 0 && x.fact != null && x.fact >= x.target;
  const low = (x: { fact: number | null; target: number }) => x.target > 0 && x.fact != null && x.fact < x.target;
  const activityOnPlan = met(m.kpi.ads) || met(m.kpi.leadgen) || met(m.kpi.dispatch);
  const lowLeads = low(m.kpi.ads) || low(m.kpi.leadgen);
  const forMe = role === "manager" || isSelf;
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

// Дрил: період селектора → дні → угоди. День-клітинки з manager-detail; угоди — лінивий фетч.
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
      <div style={{ fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px", margin: "0 0 9px" }}>По днях періоду ({ddmm(period.from)}–{ddmm(period.to)}) · клік на день → угоди</div>
      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
          <thead><tr>{["День", "Створено", "Авто", "Отримано", "Сер.чек", "Нові/Пост."].map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left" }}>{h}</th>)}</tr></thead>
          <tbody>
            {days.map((x) => {
              const chk = x.dispatched ? Math.round(x.received.revenue / x.dispatched) : 0;
              const isF = x.day === focusDay;
              const future = x.day > today;
              const weekend = dow(x.day) >= 6;
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
                        <td style={{ textAlign: "right" }}>{x.dispatched || "—"} {x.dispatched ? <span style={{ color: MUTED, fontSize: 11 }}>({autoSplit(x.dispRepeat, x.dispLeadgen, x.dispAd, x.dispUndef)})</span> : null}</td>
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
              <td style={{ textAlign: "left" }}>Σ період</td>
              <td style={{ textAlign: "right" }}>{d.monthTotals.created}</td>
              <td style={{ textAlign: "right" }}>{d.monthTotals.dispatched} {d.monthTotals.dispatched ? <span style={{ color: MUTED, fontSize: 11, fontWeight: 600 }}>({autoSplit(d.monthTotals.dispRepeat, d.monthTotals.dispLeadgen, d.monthTotals.dispAd, d.monthTotals.dispUndef)})</span> : null}</td>
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

// #18 — застряглі угоди (реюз КВП /stuck-deals, роль-скоуп за токеном; найдовші вгорі).
function StuckBlock({ teamId }: { teamId?: number }) {
  const [deals, setDeals] = useState<StuckDeal[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { let a = true; setDeals(null); fetchStuckDeals(teamId ? { teamId } : {}).then((r) => a && setDeals(r.deals)).catch(() => a && setDeals([])); return () => { a = false; }; }, [teamId]);
  const n = deals?.length ?? 0;
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, marginTop: 18, overflow: "hidden" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 17px", cursor: "pointer" }}>
        <b style={{ fontSize: 14.5 }}>🕗 Застряглі угоди {deals && <span style={{ color: n ? RED : GREEN, fontWeight: 750 }}>· {n}</span>}</b>
        <span style={{ color: MUTED, fontSize: 12 }}>{deals == null ? "…" : `без активності: гроші/рахунок ≥7 дн., «взято в роботу» ≥21 дн. ${open ? "▲" : "▼"}`}</span>
      </div>
      {open && deals && (
        <div style={{ borderTop: "1px solid var(--border)", overflowX: "auto" }}>
          {n === 0 ? <div style={{ padding: 16, color: MUTED, fontSize: 13 }}>Немає застряглих угод ✓</div> : (
            <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
              <thead><tr>{["Угода", "Клієнт", "Менеджер", "Стадія", "Сума", "Днів без руху"].map((h, i) => <th key={h} style={{ textAlign: i > 3 ? "right" : "left" }}>{h}</th>)}</tr></thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.kommoId}>
                    <td style={{ textAlign: "left" }}><a href={d.crmUrl} target="_blank" rel="noreferrer" style={{ color: BAR }}>{d.name || "—"}</a></td>
                    <td style={{ textAlign: "left", color: MUTED }}>{d.client || "—"}</td>
                    <td style={{ textAlign: "left" }}>{d.manager}</td>
                    <td style={{ textAlign: "left", color: MUTED }}>{d.stage}</td>
                    <td style={{ textAlign: "right" }}>{d.price ? fmt(d.price) + " ₴" : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: d.days >= 21 ? RED : AMBER }}>{d.activityDays ?? d.days} дн.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: MUTED, margin: "22px 2px 0", paddingTop: 15, borderTop: "1px solid var(--border)" }}>
      {(["g", "a", "r"] as const).map((s) => <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: SCOL[s] }} /> {SICON[s]} {SLBL[s]}</span>)}
      <span>│ смуга: «Місяць» — головна траєкторія (сортування за нею), «Тиждень» — поточний; │ на місяці — позначка «сьогодні»</span>
    </div>
  );
}
