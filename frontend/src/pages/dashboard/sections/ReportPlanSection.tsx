import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchReportPlan, fetchReportPlanDeals, fetchManagerDetail, fetchStuckGrouped,
  type ReportPlan, type ReportPlanManager, type ReportPlanDeal, type KvpManagerDetail, type Team,
  type StuckGrouped, type StuckManagerGroup,
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
          // Челендж/429 → довший експоненційний backoff з cap (не тайт-петля, щоб не «годувати»
          // хостинговий захист); звичайна помилка — коротший. base·2^i, cap 8с.
          const challenge = (e as { isChallenge?: boolean })?.isChallenge === true;
          await new Promise((r) => setTimeout(r, Math.min((challenge ? 2000 : 400) * 2 ** i, 8000)));
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
            <MgrStrip m={selfRow} mWeek={weekByMgr.get(selfRow.managerId)}
              focusDay={focusDay} today={today} elapsed={data.elapsed} remWd={data.remainingWorkdays}
              weekLabel={`${ddmm(weekPeriod.from)}–${ddmm(weekPeriod.to)}`} drillPeriod={drillPeriod} role={auth.role} isSelf
              open={openMgr === selfRow.managerId} onToggle={() => setOpenMgr(openMgr === selfRow.managerId ? null : selfRow.managerId)} />
          )}
          <div style={{ fontSize: 12, color: MUTED, margin: "0 2px 10px" }}>
            ↓ {auth.role === "manager" ? "Твоя команда" : "Відсортовано"} за <b>місячним</b> станом — хто відстає, той угорі
          </div>
          {data.managers.map((m) => (
            <MgrStrip key={m.managerId} m={m} mWeek={weekByMgr.get(m.managerId)}
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
        <Donut pct={pct} title={`Круг оплати — факт (отримані кошти): ${fmt(g.fact)} ₴\n= успішно реалізовано (виграно 142): ${fmt(g.factSuccess)} ₴\n+ оплачено (етап 9, ще не закрито): ${fmt(g.factPaid)} ₴\nКільце — % виконання плану.`} />
        <div>
          <div style={lab}>Команда за місяць <InfoHint text="Грошовий план — стратегічна ціль із вкладки «Плани» (відділ 2.7 млн). Факт — отримані кошти (успішно 142 ⊎ оплачено етап 9). Наведи на круг — розклад факту." /></div>
          <div style={val}>{fmt(g.fact)} <small style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>/ {fmt(g.plan)} ₴</small></div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>= успішно {k(g.factSuccess)} + оплачено {k(g.factPaid)} · чек {g.avgCheck == null ? "—" : fmt(g.avgCheck) + " ₴"} <InfoHint text="Ср. чек Звіту = пул «угоди ЗАРАЗ у роботі (авто працює→оплата отримана) + виграні за місяць»; Σ суми ÷ Σ угод (не середнє середніх)." /></div>
          <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
            <Pill c={RED}>{st.r} зрив</Pill>
            <Pill c={AMBER}>{st.a} відстає</Pill>
            <Pill c={GREEN}>{st.g} у нормі</Pill>
          </div>
        </div>
      </div>
      <div>
        <div style={lab}>💰 Очікуємо за план. датою <InfoHint text="За плановою датою оплати (коли має надійти); зміна дати переносить угоду між місяцями. Цей / наступний КАЛЕНДАРНИЙ місяць, знімок «зараз». Σ per-manager == КВП." /></div>
        <div style={{ ...val, color: g.expectThisMonth > 0 ? GREEN : MUTED }}>{fmt(g.expectThisMonth)} <small style={{ fontSize: 12, color: MUTED }}>₴ цей міс</small></div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>наст. міс: {fmt(g.expectNextMonth)} ₴</div>
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
function Donut({ pct, title }: { pct: number; title?: string }) {
  const col = pct >= 100 ? GREEN : pct >= 70 ? AMBER : RED;
  const ring = Math.min(100, Math.max(0, pct)); // кільце ≤100% візуально, число повне
  return (
    <div title={title} style={{ width: 58, height: 58, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", position: "relative", cursor: title ? "help" : undefined, background: `conic-gradient(${col} ${ring}%, var(--border) 0)` }}>
      <div style={{ width: 42, height: 42, background: "var(--card-bg)", borderRadius: "50%", position: "absolute" }} />
      <span style={{ position: "relative", fontWeight: 750, fontSize: 13 }}>{pct}%</span>
    </div>
  );
}

// Смуга менеджера: МІСЯЦЬ (головна траєкторія, статус+сортування) + ТИЖДЕНЬ (поточний), обидва завжди (#11).
function MgrStrip({ m, mWeek, focusDay, today, elapsed, remWd, weekLabel, drillPeriod, role, isSelf, open, onToggle }: {
  m: ReportPlanManager; mWeek: ReportPlanManager | undefined;
  focusDay: string; today: string; elapsed: number; remWd: number; weekLabel: string;
  drillPeriod: { from: string; to: string }; role: string; isSelf?: boolean; open: boolean; onToggle: () => void;
}) {
  const s = m.status; // статус за МІСЯЦЕМ
  const pct = m.plan > 0 ? Math.round((m.fact / m.plan) * 100) : 0;
  const smax = Math.max(...m.spark, 1);
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
        {/* ТИЖДЕНЬ — ДИНАМІЧНА ціль (Variant A: manual ?? dynamic) */}
        <TrajBlock title={`Тиждень ${weekLabel}`} fact={m.week.fact} plan={m.week.target}
          pct={m.week.target > 0 ? Math.round((m.week.fact / m.week.target) * 100) : 0}
          status={m.week.target <= 0 ? "g" : m.week.fact >= m.week.target ? "g" : m.week.fact >= m.week.target * (elapsed || 1) ? "a" : "r"}
          footer={<div title="Динамічна тижнева ціль = (місячний план − факт місяця) ÷ тижнів, що лишились. Присутні робочі дні враховують погоджені відсутності.">
            {m.week.isManual ? <>вручну задано у Задачнику · <b style={{ color: AMBER }}>вручну</b></> : <>динамічний план тижня · залишок ÷ тижнів, що лишились</>}
          </div>} />
        {/* МІСЯЦЬ — план-бар (сирий план) + #16 очікуємо + #17 прогноз */}
        <TrajBlock title="Місяць" fact={m.fact} plan={m.plan} pct={pct} status={s} elapsed={elapsed}
          footer={<>
            <div>треба <b style={{ color: "var(--text)" }}>{fmt(m.needPerDay)} ₴/д</b> ({remWd} дн.) · прогноз <b style={{ color: "var(--text)" }} title="факт + зона визнання + добір нового бізнесу (як у КВП)">{k(m.projected)}</b>{m.plan > 0 && m.monthInProgress ? ` (${Math.round((m.projected / m.plan) * 100)}%)` : ""}</div>
            <div style={{ marginTop: 3, fontSize: 12.5, color: "var(--text)" }} title="Очікування за ПЛАНОВОЮ датою оплати. Цей / наступний календарний місяць.">
              💰 очікуємо <b style={{ color: GREEN }}>{k(m.expectThisMonth)}</b> цей · <b style={{ color: "var(--text)" }}>{k(m.expectNextMonth)}</b> наст. міс
            </div>
          </>} showTempo />
        {/* місячні стати + spark */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-end" }}>
          <Stat v={m.created} l="створено" sub={`${m.new}нов · ${m.rep}пост`} />
          <Stat v={m.kpi.dispatch.fact ?? 0} l="авто ₴" sub={`${k(m.kpi.dispatch.revenue ?? 0)} ₴`} />
          <Stat v={chekFact ?? 0} l="ср. чек" money />
          <Stat v={m.fact} l="отримано ₴" money />
          <div title="отримано по тижнях (5)" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34 }}>
            {m.spark.map((v, ix) => (
              <div key={ix} style={{ width: 6, borderRadius: 2, background: ix === m.spark.length - 1 ? BAR : "var(--border)", height: Math.max(3, (v / smax) * 34) }} />
            ))}
          </div>
        </div>
        <div style={{ color: MUTED, textAlign: "center", fontSize: 13, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</div>
      </div>
      {/* Розвантаження картки: активність РОЗДІЛЕНО на 🗓 Тиждень·задача і 📅 Місяць.
          ⚠️ ПОРЯДОК КОЛОНОК ДЗЕРКАЛИТЬ ВЕРХНІЙ РЯД: тиждень ЛІВОРУЧ, місяць ПРАВОРУЧ —
          кожен нижній блок стоїть рівно під своїм зведенням (було навхрест). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "0 17px 13px" }}>
        {/* 🗓 Тиждень · задача з Задачника — дзеркалить РЕАЛЬНІ метрики задачника (тижнева ціль) */}
        <div style={{ border: `1px solid ${BAR}44`, borderRadius: 10, padding: "10px 12px", background: BAR + "08" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
            <b style={{ fontSize: 12 }}>🗓 Тиждень · задача з Задачника</b>
            <span title="Тижнева ціль = задачник (вручну) або динамічна ціль. Одна цифра у Звіті й Задачнику." style={{ fontSize: 10, fontWeight: 700, color: BAR, background: BAR + "1a", padding: "2px 8px", borderRadius: 12, whiteSpace: "nowrap" }}>↔ синхронізовано із Задачником</span>
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {mWeek ? (
              <>
                <Kpi lbl="реклама" fact={mWeek.kpi.ads.fact} target={mWeek.kpi.ads.target} />
                <Kpi lbl="лідоген" fact={mWeek.kpi.leadgen.fact} target={mWeek.kpi.leadgen.target} />
                <Kpi lbl="авто" fact={mWeek.kpi.dispatch.fact} target={mWeek.kpi.dispatch.target} />
                <Kpi lbl="чек" fact={mWeek.kpi.avgCheck.fact} target={mWeek.kpi.avgCheck.target} money />
                <Kpi lbl="конв" fact={mWeek.kpi.conversion.fact} target={mWeek.kpi.conversion.target} pctUnit />
              </>
            ) : <span style={{ fontSize: 11.5, color: MUTED }}>тижнева задача не задана</span>}
            <Kpi lbl="гроші тижня" fact={m.week.fact} target={m.week.target} money hintTitle="Тижнева грошова ціль = вручну (Задачник) або динамічна (залишок місяця ÷ тижнів). Факт — отримано за цей тиждень." />
          </div>
        </div>
        {/* 📅 Місяць — показники факт/план за місяць */}
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ fontSize: 12 }}>📅 Місяць · показники</b><span style={{ fontSize: 10.5, color: MUTED }}>факт / план за місяць</span>
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Kpi lbl="реклама" fact={m.kpi.ads.fact} target={m.kpi.ads.target} />
            <Kpi lbl="лідоген" fact={m.kpi.leadgen.fact} target={m.kpi.leadgen.target} />
            <Kpi lbl="авто" fact={m.kpi.dispatch.fact} target={m.kpi.dispatch.target} extra={`${k(m.kpi.dispatch.revenue ?? 0)} ₴`}
              hintTitle={`Авто за джерелом: ${autoSplit(m.kpi.dispatch.repeat ?? 0, m.kpi.dispatch.leadgen ?? 0, m.kpi.dispatch.ad ?? 0, m.kpi.dispatch.undef ?? 0) || "—"}`} />
            <Kpi lbl="чек" fact={chekFact} target={m.kpi.avgCheck.target} money altMark={chekAlt ? "*відпр." : undefined} altTitle="по відправлених авто, ще не закриті (сума÷авто)"
              hintTitle={chekAlt ? undefined : "Ср. чек = пул «угоди ЗАРАЗ у роботі (авто працює→оплата отримана) + виграні за місяць». Σ signed ÷ Σ угод."} />
            <Kpi lbl="конв" fact={m.kpi.conversion.fact} target={m.kpi.conversion.target} pctUnit />
          </div>
        </div>
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
function Kpi({ lbl, fact, target, money, pctUnit, extra, altMark, altTitle, hintTitle }: { lbl: string; fact: number | null; target: number; money?: boolean; pctUnit?: boolean; extra?: string; altMark?: string; altTitle?: string; hintTitle?: string }) {
  const ok = target > 0 && fact != null && fact >= target;
  const has = target > 0;
  const col = !has ? MUTED : ok ? GREEN : AMBER;
  const f = fact == null ? "—" : money ? fmt(fact) : pctUnit ? `${fact}%` : String(fact);
  return (
    <span style={{ fontSize: 11.5, color: MUTED, cursor: hintTitle ? "help" : undefined }} title={altMark ? altTitle : hintTitle ?? `${lbl}: факт ${f} / ${has ? "ціль " + (money ? fmt(target) : pctUnit ? target + "%" : target) : "план не задано"}`}>
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
// Тег команди → підпис + колір (РПК/РНК/лідоген).
const STUCK_TAG: Record<string, { label: string; c: string }> = { rpk: { label: "РПК", c: BAR }, rnk: { label: "РНК", c: "#7a52c7" }, leadgen: { label: "ЛГ", c: GREEN } };
// Стадія → чип-колір.
const STUCK_STAGE_C = (s: string) => s === "Авто працює" ? GREEN : s === "Взято в роботу" ? BAR : AMBER;
const idleColor = (d: number) => d >= 90 ? RED : d >= 21 ? AMBER : MUTED;
const scopeLbl: Record<string, string> = { company: "вся компанія", team: "свій відділ", own: "свої угоди" };

/**
 * #18 — Застряглі угоди, ЗГРУПОВАНІ по менеджерах (переробка, без «стелі 50»): справжня
 * к-сть, company-summary, роль-скоуп за токеном; дропдауни по менеджерах, на розкритті —
 * ПОВНИЙ список угод менеджера (скрол при довгому), найдовший простій угорі. Реюз core.
 */
type StuckSort = "count" | "sum" | "idle";
export function StuckBlock({ teamId }: { teamId?: number }) {
  const [data, setData] = useState<StuckGrouped | null>(null);
  const [openMgr, setOpenMgr] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<StuckSort>("count");
  const [sectionOpen, setSectionOpen] = useState(false); // ВСЯ секція згорнута за замовчуванням (обгортка над per-manager акордеоном)
  useEffect(() => {
    let a = true; setData(null); setOpenMgr(new Set());
    fetchStuckGrouped(teamId ? { teamId } : {})
      .then((d) => {
        if (!a) return;
        setData(d);
        // Авто-відкриття/розгортання — ЛИШЕ РНК (рішення власника 24.07): секція авто-розкривається
        // й авто-розгортаються менеджери тільки для критичних RNK-команд. РПК/Самостійний стартують
        // згорнуті (лише ручний клік). Ручний тоггл далі перекриває. Червоний чип/акцент — для всіх.
        const criticalRnk = d.groups.filter((g) => g.teamTag === "rnk" && g.longestIdleDays >= 90);
        setSectionOpen(criticalRnk.length > 0);
        setOpenMgr(new Set(criticalRnk.map((g) => g.managerId)));
      })
      .catch(() => a && setData({ minDays: 7, role: "", scope: "company", total: 0, sumRisk: 0, managers: 0, over90: 0, groups: [] }));
    return () => { a = false; };
  }, [teamId]);

  const toggleMgr = (id: number) => setOpenMgr((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const stat = (v: React.ReactNode, l: string, color?: string) => (
    <div style={{ minWidth: 78 }}>
      <div style={{ fontWeight: 800, fontSize: 20, lineHeight: 1.1, color: color ?? "var(--text)" }}>{v}</div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{l}</div>
    </div>
  );

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
        {/* Шапка — клікабельна кнопка згортання ВСІЄЇ секції (обгортка над per-manager акордеоном) */}
        <div onClick={() => setSectionOpen((o) => !o)} role="button" aria-expanded={sectionOpen}
             style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "15px 18px", flexWrap: "wrap", cursor: "pointer", userSelect: "none" }}>
          <span style={{ fontWeight: 750, fontSize: 16, display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: MUTED, fontSize: 13, width: 12, display: "inline-block" }}>{sectionOpen ? "▾" : "▸"}</span>
            🕐 Застряглі угоди {data && <span style={{ color: data.total ? RED : GREEN, fontWeight: 800 }}>· {data.total}</span>}
            {data && data.total > 0 && <span style={{ color: MUTED, fontWeight: 700, fontSize: 14 }}>· {k(data.sumRisk)} ₴ в ризику</span>}
            {data && data.over90 > 0 && <span style={{ fontSize: 11.5, fontWeight: 800, color: "#fff", background: RED, padding: "2px 9px", borderRadius: 20 }}>⚠️ {data.over90} &gt;90 дн</span>}
            <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
              <InfoHint text="Критерій — ВІДСУТНІСТЬ РУХУ, а не стадія: усі відкриті угоди без реальної людської активності понад поріг (гроші/рахунок ≥7 дн., «взято в роботу» ≥21 дн.), включно з «Авто працює». Виключено лише успіх/оплату отримано/злив. Анкер — остання активність (нотатки людини, не Salesbot). Сума в ризику — signed (сторно нетиться). Вікно створення 180 днів." />
            </span>
          </span>
          {sectionOpen && (
            <div style={{ textAlign: "right", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
              без руху ≥7 дн. (рахунок/гроші) · ≥21 дн. («взято в роботу»)<br />
              усі відкриті стадії, включно з «Авто працює» · дата = остання активність
            </div>
          )}
        </div>
        {sectionOpen && (data == null ? <div style={{ padding: "0 18px 18px", color: MUTED }}>Завантаження…</div> : (
          <>
            {/* Summary-стрічка */}
            <div style={{ display: "flex", alignItems: "center", gap: 26, flexWrap: "wrap", padding: "0 18px 15px", borderBottom: "1px solid var(--border)" }}>
              {stat(data.total, "застряглих угод", RED)}
              {stat(<>{k(data.sumRisk)} <span style={{ fontSize: 13 }}>₴</span></>, "сума в ризику", RED)}
              {stat(data.managers, "менеджерів")}
              {stat(data.over90, ">90 днів")}
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: MUTED, background: "var(--bg)", border: "1px solid var(--border)", padding: "5px 11px", borderRadius: 20 }}>
                  Ти бачиш: <b style={{ color: "var(--text)" }}>{scopeLbl[data.scope]}</b>
                </span>
                {data.scope !== "own" && (
                  <label style={{ fontSize: 12, color: MUTED, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    Сортувати:
                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value as StuckSort)}
                      style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", cursor: "pointer" }}>
                      <option value="count">за к-стю</option>
                      <option value="sum">за сумою в ризику</option>
                      <option value="idle">за простоєм</option>
                    </select>
                  </label>
                )}
              </div>
            </div>

            {data.groups.length === 0 ? (
              <div style={{ padding: 18, color: MUTED, fontSize: 13 }}>Немає застряглих угод ✓</div>
            ) : [...data.groups].sort((a, b) =>
                  sortBy === "sum" ? b.sumAtRisk - a.sumAtRisk : sortBy === "idle" ? b.longestIdleDays - a.longestIdleDays : b.count - a.count
                ).map((g) => (
              <StuckMgrRow key={g.managerId} g={g} open={openMgr.has(g.managerId)} onToggle={() => toggleMgr(g.managerId)} single={data.scope === "own"} />
            ))}
          </>
        ))}
      </div>

      {/* Пояснення (макет) — лише коли секція розкрита */}
      {sectionOpen && <div style={{ background: "rgba(47,111,219,0.06)", border: "1px solid rgba(47,111,219,0.25)", borderRadius: 12, padding: "12px 15px", fontSize: 12, color: "var(--text)", lineHeight: 1.55, marginTop: 10 }}>
        <b>Що рахуємо:</b> критерій — <b>відсутність руху</b>, а не стадія: усі відкриті угоди без активності понад поріг, <b>включно з «Авто працює»</b> (машина, що «працює» 175 днів, насправді стоїть). Список — по менеджерах (згорнуті), згори — <b>чесний підсумок</b> без «стелі 50»: реальна к-сть, сума в ризику (signed), критичні &gt;90 дн. <b>Роль-скоуп:</b> адмін/КВП — вся компанія, тімлід — свій відділ, менеджер — лише свої. Дата простою — від останньої активності; всередині менеджера сортування від найдовшого.
      </div>}
    </div>
  );
}

const STUCK_COLS: { h: string; r?: boolean; hint?: string }[] = [
  { h: "Угода" }, { h: "Клієнт" }, { h: "Стадія" }, { h: "Сума", r: true }, { h: "Днів без руху", r: true },
  { h: "Остання розмова", r: true, hint: "Дата останнього ДЗВІНКА клієнту (call_in/call_out у CRM), а не будь-якої активності. 🚩 — свіжа активність є, але місяць без дзвінка (метушня без контакту)." },
];

function StuckMgrRow({ g, open, onToggle, single }: { g: StuckManagerGroup; open: boolean; onToggle: () => void; single: boolean }) {
  const tag = g.teamTag ? STUCK_TAG[g.teamTag] : null;
  const hasCritical = g.longestIdleDays >= 90; // ≥1 критична угода (>90 дн) → червоний акцент рядка
  return (
    <div style={{ borderBottom: "1px solid var(--border)", borderLeft: hasCritical ? `3px solid ${RED}` : "3px solid transparent", background: hasCritical ? RED + "0a" : undefined }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", cursor: "pointer", flexWrap: "wrap" }}>
        <span style={{ color: MUTED, fontSize: 12 }}>{open ? "▼" : "▶"}</span>
        {hasCritical && <span title="має критичні угоди >90 дн">⚠️</span>}
        <span style={{ fontWeight: 700, fontSize: 14.5, color: hasCritical ? RED : "var(--text)" }}>{single ? "Мої застряглі" : g.manager}</span>
        {tag && !single && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: tag.c + "22", color: tag.c }}>{tag.label}</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: 16 }}>
          <span><b style={{ color: RED, fontSize: 16 }}>{g.count}</b> <span style={{ fontSize: 11, color: MUTED }}>угод</span></span>
          <span><b style={{ fontSize: 16 }}>{k(g.sumAtRisk)} ₴</b> <span style={{ fontSize: 11, color: MUTED }}>в ризику</span></span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: idleColor(g.longestIdleDays), background: idleColor(g.longestIdleDays) + "18", padding: "3px 10px", borderRadius: 20 }}>найдовша {g.longestIdleDays} дн</span>
        </span>
      </div>
      {open && (
        <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
          <table className="data-table" style={{ width: "100%", fontSize: 12.5 }}>
            <thead><tr>{STUCK_COLS.map((c) => <th key={c.h} style={{ textAlign: c.r ? "right" : "left", position: "sticky", top: 0, background: "var(--card-bg)", zIndex: 1 }}>{c.h}{c.hint && <> <InfoHint text={c.hint} /></>}</th>)}</tr></thead>
            <tbody>
              {g.deals.map((d) => {
                const sc = STUCK_STAGE_C(d.stage);
                const crit = d.days >= 90;
                return (
                  <tr key={d.kommoId}>
                    <td style={{ textAlign: "left" }}><a href={d.crmUrl} target="_blank" rel="noreferrer" style={{ color: BAR }}>{d.name || "—"}</a></td>
                    <td style={{ textAlign: "left", color: MUTED }}>{d.client || "—"}</td>
                    <td style={{ textAlign: "left" }}><span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: sc + "1e", color: sc }}>{d.stage}</span></td>
                    <td style={{ textAlign: "right", fontWeight: 650, color: d.price < 0 ? RED : "var(--text)" }}>{d.price ? fmt(d.price) + " ₴" : "—"}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: idleColor(d.days) }}>{crit && <span title="критична: >90 дн">⚠️ </span>}{d.days}</td>
                    <td style={{ textAlign: "right", fontWeight: 650 }}>
                      {d.daysSinceLastCall == null
                        ? <span style={{ color: MUTED }}>дзвінка не було</span>
                        : <span style={{ color: d.daysSinceLastCall >= 30 ? AMBER : "var(--text)" }}>{d.daysSinceLastCall} дн</span>}
                      {d.noCallFlag && <span title="метушня без контакту: свіжа активність, але місяць без дзвінка"> 🚩</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
