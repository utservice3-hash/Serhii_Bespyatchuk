import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchReportPlan, fetchReportPlanDeals, fetchManagerDetail, fetchStuckGrouped, saveDealNote,
  type ReportPlan, type ReportPlanManager, type ReportPlanDeal, type KvpManagerDetail, type Team,
  type StuckGrouped, type StuckManagerGroup, type StuckGroupDeal,
} from "../../../api";
import { DatePicker } from "../../../components/DatePicker";
import { InfoHint } from "../widgets";
import { ResponseTimeCard } from "./ResponseTimeCard";
import { ReportSummary } from "./ReportSummary";

// ─────────────────────────────────────────────────────────────────────────────
// Кольори беруться зі СКОУП-ТОКЕНІВ `.rpt` (index.css) — не хардкод. Тому:
//  • темна тема перемикається сама (в скоупі є `[data-theme=dark]`-перекриття);
//  • пілот не тягне за собою інші екрани (умова власника до коміту 2).
// Статуси — ЗАРЕЗЕРВОВАНІ й ніколи не «ще один колір серії»; подаються КРАПКОЮ
// + ПІДПИСОМ, тобто ніколи кольором наодинці (нуль емодзі — принцип макета).
// ─────────────────────────────────────────────────────────────────────────────
const GREEN = "var(--rpt-ok)", AMBER = "var(--rpt-warn)", RED = "var(--rpt-bad)";
const ACC = "var(--rpt-accent)", LINK = "var(--rpt-link)", MUTED = "var(--rpt-muted)";
const INK = "var(--rpt-ink)", SOFT = "var(--rpt-soft)", LINE = "var(--rpt-line)";
const SCOL: Record<string, string> = { g: GREEN, a: AMBER, r: RED };
const SBG: Record<string, string> = { g: "var(--rpt-ok-bg)", a: "var(--rpt-warn-bg)", r: "var(--rpt-bad-bg)" };
const SLBL: Record<string, string> = { g: "В нормі", a: "Відстає", r: "Зрив" };
// Тег команди — НЕЙТРАЛЬНА плашка (як у макеті): він ідентифікує, а не сигналізує,
// тож не має конкурувати за увагу з єдиним акцентом і статусами.
const TAG_LBL: Record<string, string> = { rpk: "РПК", rnk: "РНК", self: "САМ" };
const Dot = ({ c }: { c: string }) => <span className="rpt-dot" style={{ background: c }} />;
const Tag = ({ children, c, bg }: { children: React.ReactNode; c?: string; bg?: string }) => (
  <span className="rpt-tag" style={{ color: c ?? "var(--rpt-ink-soft)", background: bg ?? SOFT }}>{children}</span>
);

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
  // Вибрана команда в підсумку — фільтр списку менеджерів нижче (клік по рядку).
  const [pickedTeam, setPickedTeam] = useState<string | null>(null);

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
    <div className="rpt">
      {/* Хедер: хлібні крихти · заголовок · підпис — і ВЕСЬ період-контроль праворуч,
          одним рядом (макет: сегментований перемикач замість розсипу кнопок). */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <div className="rpt-crumb">Аналітика · Звіт</div>
          <h1 className="rpt-h1">Звіт{teamName ? ` — ${teamName}` : ""}</h1>
          <div className="rpt-sub">Грошовий план 2,7 млн — вкладка «Плани» · KPI-активність — задачник · {monLbl(anchor)}</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", paddingTop: 22 }}>
          <div className="rpt-seg">
            {(["day", "week", "month", "range"] as Mode[]).map((mo) => (
              <button key={mo} onClick={() => setMode(mo)} aria-pressed={mode === mo}>
                {mo === "day" ? "День" : mo === "week" ? "Тиждень" : mo === "month" ? "Місяць" : "Період"}
              </button>
            ))}
          </div>
          {mode === "range" ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, color: MUTED }}>
              <DatePicker value={rangeFrom} onChange={(v) => v && setRangeFrom(v)} mode="day" minWidth={130} />–
              <DatePicker value={rangeTo} onChange={(v) => v && setRangeTo(v)} mode="day" minWidth={130} />
            </span>
          ) : (
            <DatePicker value={anchor} onChange={(v) => v && (setAnchor(v), setFocusDay(v))} mode="day" minWidth={140} />
          )}
          {auth.role === "admin" && (
            <select className="rpt-btn" value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Усі команди</option>
              {teams.filter((t) => !HIDE_TEAMS.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <span className="rpt-chip">бачиш: <b style={{ color: INK }}>{roleChip}</b></span>
        </div>
      </div>

      {/* Смуга днів (тиждень фокус-дня, Пн–Нд) + навігація періодом.
          Навігація стоїть ПОРЯД зі смугою, а не в шапці: обидва рухають ту саму вісь часу. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
        {weekOfFocus.map((d, i) => {
          const isF = d === focusDay, future = d > today;
          return (
            <div key={d} className="rpt-day" data-on={isF ? "1" : "0"} data-dim={future || (i >= 5 && !isF) ? "1" : "0"}
              onClick={() => !future && setFocusDay(d)} style={{ cursor: future ? "default" : "pointer" }}>
              <small>{WD[i]}</small>
              <b>{d.slice(8)}</b>
            </div>
          );
        })}
        <span style={{ display: "inline-flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
          <button className="rpt-btn" onClick={() => nav(-1)} disabled={mode === "range"}>←</button>
          <button className="rpt-btn" onClick={() => { setAnchor(today); setFocusDay(today); }}>Сьогодні</button>
          {/* #15 — швидко на поточний тиждень */}
          <button className="rpt-btn" onClick={() => { setMode("week"); setAnchor(today); setFocusDay(today); }}>Поточний тиждень</button>
          <button className="rpt-btn" onClick={() => nav(1)} disabled={mode === "range"}>→</button>
        </span>
      </div>

      {err && !data ? (
        <div className="rpt-card" style={{ textAlign: "center", padding: 32, color: MUTED }}>
          <div style={{ fontWeight: 700, color: RED, marginBottom: 6 }}>Звіт не завантажився</div>
          <div style={{ marginBottom: 14 }}>Тимчасовий збій зʼєднання.</div>
          <button className="rpt-btn" onClick={() => setRetryNonce((n) => n + 1)}
            style={{ background: INK, borderColor: INK, color: "var(--rpt-card)" }}>
            Спробувати знову
          </button>
        </div>
      ) : loading && !data ? <div style={{ color: MUTED, padding: 20 }}>Завантаження…</div> : data && (
        <>
          {/* 🔴 ВЕРХНІЙ ПІДСУМОК ЗА МАКЕТОМ `zvit-2` (06.08.2026): п'ять плиток, де
              «виконано» тижня й місяця обовʼязково несуть «% від необхідного» — єдину
              величину, яку МОЖНА порівнювати між періодами різної довжини. Без неї
              користувач порівняє −35.2 і −7.0 п.п. і зробить хибний висновок. */}
          <ReportSummary data={data} weekLabel={`${ddmm(weekPeriod.from)}–${ddmm(weekPeriod.to)}`}
            pickedTeam={pickedTeam} onPickTeam={setPickedTeam} />
          {/* Стара плитка фокус-дня лишається під підсумком — вона про ІНШЕ питання
              («що сталось саме сьогодні») і жодну з п'яти плиток не дублює. */}
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
          <div style={{ fontSize: 12, color: MUTED, margin: "20px 2px 10px" }}>
            {auth.role === "manager" ? "Твоя команда" : "Відсортовано"} за <b>місячним</b> станом — хто відстає, той угорі
          </div>
          {data.managers.filter((m) => !pickedTeam || (m.teamName ?? "Поза командами") === pickedTeam).map((m) => (
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

function Glance({ data, focus, focusDay, today }: { data: ReportPlan; focus: ReportPlan | null; focusDay: string; today: string }) {
  const g = data.glance;
  const pct = g.plan > 0 ? Math.round((g.fact / g.plan) * 100) : 0;
  const fg = focus?.glance;
  const st = g.statusCounts;
  const futureFocus = focusDay > today;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr 1fr", gap: 16, marginBottom: 18 }}>
      {/* ① Команда за місяць — головна цифра екрана, тому єдина, що несе акцент. */}
      <div className="rpt-card" style={{ padding: "20px 22px" }}>
        <div className="rpt-lab">Команда за місяць <InfoHint text="Грошовий план — стратегічна ціль із вкладки «Плани» (відділ 2.7 млн). Факт — отримані кошти (успішно 142 ⊎ оплачено етап 9)." /></div>
        <div className="rpt-big">
          {fmt(g.fact)} <span className="rpt-unit">/ {fmt(g.plan)} ₴ · {pct}%</span>
        </div>
        {/* Смуга замість кільця: лінійний прогрес читається одним поглядом і не
            змагається з числом за увагу. Число повне, смуга візуально ≤100%. */}
        <div className="rpt-track" style={{ margin: "14px 0 10px" }}
          title={`Факт (отримані кошти): ${fmt(g.fact)} ₴\n= успішно реалізовано (виграно 142): ${fmt(g.factSuccess)} ₴\n+ оплачено (етап 9, ще не закрито): ${fmt(g.factPaid)} ₴`}>
          <div className="rpt-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
        <div className="rpt-note">
          успішно {fmt(g.factSuccess)} + оплачено {fmt(g.factPaid)} · середній чек {g.avgCheck == null ? "—" : fmt(g.avgCheck) + " ₴"}
          {" "}<InfoHint text="Ср. чек Звіту = пул «угоди ЗАРАЗ у роботі (авто працює→оплата отримана) + виграні за місяць»; Σ суми ÷ Σ угод (не середнє середніх)." />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <Tag c={RED} bg={SBG.r}><Dot c={RED} />{st.r} зрив</Tag>
          <Tag c={AMBER} bg={SBG.a}><Dot c={AMBER} />{st.a} відстає</Tag>
          <Tag c={GREEN} bg={SBG.g}><Dot c={GREEN} />{st.g} у нормі</Tag>
        </div>
      </div>

      {/* ② Очікуємо за плановою датою */}
      <div className="rpt-card" style={{ padding: "20px 22px" }}>
        <div className="rpt-lab">Очікуємо за план. датою <InfoHint text="За плановою датою оплати (коли має надійти); зміна дати переносить угоду між місяцями. Цей / наступний КАЛЕНДАРНИЙ місяць, знімок «зараз». Σ per-manager == КВП." /></div>
        <div className="rpt-big">{fmt(g.expectThisMonth)} <span className="rpt-unit">₴ цього міс.</span></div>
        <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
          <Sub l="наст. міс." v={`${fmt(g.expectNextMonth)} ₴`} />
          <Sub l="авто за місяць" v={`${g.dispatched} · ${fmt(g.dispatchedRevenue)} ₴`} />
        </div>
      </div>

      {/* ③ Фокус-день */}
      <div className="rpt-card" style={{ padding: "20px 22px" }}>
        <div className="rpt-lab">Фокус-день · {ddmm(focusDay)}</div>
        {futureFocus ? (
          <div className="rpt-big" style={{ color: MUTED }}>— <span className="rpt-unit">ще попереду</span></div>
        ) : (
          <div className="rpt-big">{fg?.dispatched ?? 0} <span className="rpt-unit">авто · {fmt(fg?.fact ?? 0)} ₴ отримано</span></div>
        )}
        <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
          <Sub l="створено угод" v={futureFocus ? "—" : String(fg?.created ?? 0)} />
          {/* TODO (крок 3, Ringostat): друга цифра «дзвінки за день». У макеті вона є,
              але поля в `/report-plan` НЕМА, а вигадувати метрику заборонено. Джерело
              зʼявиться, коли `linkCalls()` звʼяже `ringostat_calls` з `client_key`/менеджером
              (потрібні телефони контактів — їх наливає backfillContactPhones).
              Тоді: додати в glance `calls` (COUNT по `ringostat_calls` за київський день
              у скоупі ролі) і зняти цей TODO. Деталі — docs/RINGOSTAT_CALLS.md. */}
        </div>
      </div>
    </div>
  );
}
// Друга за важливістю цифра картки: підпис зверху дрібним, значення знизу — щоб
// око спускалось від головного числа до контексту, а не читало «підпис: число».
function Sub({ l, v }: { l: string; v: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: MUTED }}>{l}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, letterSpacing: "-.3px" }}>{v}</div>
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
    <div className="rpt-card" style={{ background: isSelf ? "var(--rpt-tint)" : undefined, borderLeft: `3px solid ${SCOL[s]}`, marginBottom: 12, overflow: "hidden" }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: "196px 1fr 1fr 392px 26px", gap: 18, alignItems: "center", padding: "17px 20px", cursor: "pointer" }}>
        {/* who + status */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 15.5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", letterSpacing: "-.2px" }}>
            {m.name}<Tag>{TAG_LBL[m.tag] ?? m.tag.toUpperCase()}</Tag>
            {isSelf && <Tag c={ACC}>ТИ</Tag>}
          </span>
          <Tag c={SCOL[s]} bg={SBG[s]}><Dot c={SCOL[s]} />{SLBL[s]} · міс</Tag>
        </div>
        {/* ТИЖДЕНЬ — ДИНАМІЧНА ціль (Variant A: manual ?? dynamic) */}
        <TrajBlock title={`Тиждень ${weekLabel}`} fact={m.week.fact} plan={m.week.target}
          pct={m.week.target > 0 ? Math.round((m.week.fact / m.week.target) * 100) : 0}
          status={m.week.target <= 0 ? "g" : m.week.fact >= m.week.target ? "g" : m.week.fact >= m.week.target * (elapsed || 1) ? "a" : "r"}
          footer={<div title={"Динамічний план тижня = залишок місяця × робочі дні цього тижня ÷ робочі дні від початку тижня до кінця місяця. "
            + "Базис — РОБОЧІ ДНІ, а не «тижні, що лишились»: інакше останній тиждень місяця (буває одноденним) отримав би повну тижневу норму. "
            + "Ціль фіксується в понеділок 00:00 за Києвом і всередині тижня не змінюється."
            + (m.week.reconstructed ? " ⚠️ Знімок цього тижня ВІДНОВЛЕНО ретроспективно, а не збережено в момент." : "")}>
            {m.week.isManual
              ? <>вручну задано у Задачнику · <b style={{ color: AMBER }}>вручну</b></>
              : <>динамічний план · залишок ÷ робочі дні, що лишились{m.week.workingDaysWeek > 0 ? ` (${m.week.workingDaysWeek} роб. дн. у тижні)` : ""}</>}
            {m.week.overPlan > 0 && <> · <b style={{ color: GREEN }}>понад план +{k(m.week.overPlan)} ₴</b></>}
            {m.week.reconstructed && <> · <span style={{ color: MUTED }}>знімок відновлено</span></>}
          </div>} />
        {/* МІСЯЦЬ — план-бар (сирий план) + #16 очікуємо + #17 прогноз */}
        <TrajBlock title="Місяць" fact={m.fact} plan={m.plan} pct={pct} status={s} elapsed={elapsed}
          footer={<>
            <div>треба <b style={{ color: INK }}>{fmt(m.needPerDay)} ₴/д</b> ({remWd} дн.) · прогноз <b style={{ color: INK }} title={`Прогноз місяця = гроші місяця + очікування з плановою датою оплати В ЦЬОМУ місяці.\nДобір нового бізнесу (${k(m.dobir)}) у прогноз НЕ входить — рішення власника 06.08.2026.`}>{k(m.projected)}</b>{m.plan > 0 && m.monthInProgress ? ` (${Math.round((m.projected / m.plan) * 100)}%)` : ""}</div>
            {/* 🔴 ДВА «ОЧІКУЄМО» РОЗРІЗНЕНО ПІДПИСАМИ (формули не змінено): нижній рядок —
                ДАТОВАНЕ очікування (за плановою датою оплати), і саме воно входить у
                прогноз; `m.expect` у банері «Чому + Дія» — НЕДАТОВАНИЙ знімок усієї зони.
                Доти обидва звались «очікуємо», і 44к проти 52к читались як поломка. */}
            <div style={{ marginTop: 3, fontSize: 12.5, color: INK }} title="Очікування за ПЛАНОВОЮ датою оплати (коли має надійти). Цей / наступний календарний місяць. Це НЕ те саме, що «зона очікування» в банері нижче — та без прив'язки до дати.">
              за план. датою <b style={{ color: GREEN }}>{k(m.expectThisMonth)}</b> цей · <b style={{ color: INK }}>{k(m.expectNextMonth)}</b> наст. міс
              {m.expectNoDate > 0 && <> · <span style={{ color: MUTED }} title="Угоди в зоні очікування БЕЗ планової дати оплати. У ЖОДНУ суму не входять — вони не належать жодному місяцю.">без дати {k(m.expectNoDate)}</span></>}
            </div>
            {/* 🔴 ТРИ ЧИСЛА «СКІЛЬКИ ВИЙДЕ» — ТРИ РІЗНІ НАЗВИ. Саме з однакових назв і
                почалась уся історія, тож вони стоять поруч і кожне підписане своїм сенсом:
                «з рахунками» = документи · «за темпом» = екстраполяція · «зазвичай
                добирає» = середнє за 3 міс. Складати їх між собою не можна. */}
            <div style={{ marginTop: 3, fontSize: 12.5, color: MUTED }}>
              з рахунками <b style={{ color: INK }} title="Факт ② + рахунки з плановою датою оплати цього місяця. Підкріплене документами; добір сюди НЕ входить.">{k(m.fact + m.expectThisMonth)}</b>
              {" "}· за темпом <b style={{ color: INK }} title="Факт ÷ робочі дні, що минули × усі робочі дні місяця. Це ЕКСТРАПОЛЯЦІЯ, а не прогноз.">{k(m.byPace)}</b>
              {m.byPaceEarly && <span style={{ color: AMBER, fontWeight: 700 }} title="Екстраполяція перевищує 150% плану — на початку місяця вона нестабільна і не є прогнозом."> ⚠ рано</span>}
              {" "}· зазвичай добирає <b style={{ color: INK }} title="Середнє за 3 завершені місяці — скільки людина зазвичай приносить угодами, створеними й закритими вже після цього числа. У прогноз НЕ входить.">{k(m.dobir)}</b>
            </div>
            {m.jam > 0 && (
              <div style={{ marginTop: 3, fontSize: 12, color: AMBER }}
                title="Скільки з очікувань стоїть на стадії «Виставлення рахунку». Поки рахунок не виставлений, дата оплати — намір, а не домовленість.">
                затор на виставленні рахунку: {k(m.jam)} ₴ · {m.jamDeals} угод
              </div>
            )}
          </>} showTempo />
        {/* місячні стати + spark */}
        <div style={{ display: "flex", gap: 14, alignItems: "center", justifyContent: "flex-end" }}>
          <Stat v={m.created} l="створено" sub={`${m.new}нов · ${m.rep}пост`} />
          <Stat v={m.kpi.dispatch.fact ?? 0} l="авто ₴" sub={`${k(m.kpi.dispatch.revenue ?? 0)} ₴`} />
          {/* 📞 РОЗМОВИ Й СПРОБИ — ДВІ ЦИФРИ, складати заборонено (рішення власника
              04.08.2026): «розмова» відповідає на питання «чи був контакт», «спроба» —
              «чи людина працює». Одна сума відповіла б на жодне з них. */}
          <Stat v={m.talks} l="розмов" sub={m.attempts ? `${m.attempts} спроб` : "без недодзвонів"} />
          <Stat v={chekFact ?? 0} l="ср. чек" money />
          {/* 🔴 ПЕРЕЙМЕНОВАНО (рішення власника 06.08.2026). «Отримано» на цій плитці
              означало ① «успішно реалізовано» — тобто НЕ те, що це слово означає на
              решті екранів (② «оплата отримана» ∪ «успішна»). Тепер число справді ②,
              і назва мала б збігтись сама — але «отримано ₴» лишає невидимим головне:
              це СУМА ДВОХ РІЗНИХ СТАНІВ. «Гроші місяця» + підпис розкладу каже і
              скільки, і чим саме воно зібране. */}
          <Stat v={m.fact} l="гроші місяця" money sub={`закрито ${k(m.factSuccess)} · оплачено ${k(m.factPaid)}`} />
          <div title="отримано по тижнях (5)" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34 }}>
            {m.spark.map((v, ix) => (
              <div key={ix} style={{ width: 6, borderRadius: 2, background: ix === m.spark.length - 1 ? ACC : LINE, height: Math.max(3, (v / smax) * 34) }} />
            ))}
          </div>
        </div>
        <div style={{ color: MUTED, textAlign: "center", fontSize: 13, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</div>
      </div>
      {/* Розвантаження картки: активність РОЗДІЛЕНО на «Тиждень·задача» і «Місяць».
          УВАГА: ПОРЯДОК КОЛОНОК ДЗЕРКАЛИТЬ ВЕРХНІЙ РЯД: тиждень ЛІВОРУЧ, місяць ПРАВОРУЧ —
          кожен нижній блок стоїть рівно під своїм зведенням (було навхрест).
          auto-fit/minmax(420px): на вузькому екрані колонка одна — блоки лягають
          ОДИН ПІД ОДНИМ у тій самій послідовності (спершу Тиждень, тоді Місяць),
          замість стискатись і рвати KPI переносами. НЕ повертати фіксовані "1fr 1fr". */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))", gap: 12, padding: "0 20px 16px" }}>
        {/* Тиждень · задача з Задачника — дзеркалить РЕАЛЬНІ метрики задачника (тижнева ціль) */}
        <div style={{ border: `1px solid ${LINE}`, borderRadius: "var(--rpt-r-sm)", padding: "12px 14px", background: SOFT }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
            <b className="rpt-lab">Тиждень · задача з Задачника</b>
            <span title="Тижнева ціль = задачник (вручну) або динамічна ціль. Одна цифра у Звіті й Задачнику." style={{ fontSize: 10.5, fontWeight: 700, color: MUTED, whiteSpace: "nowrap" }}>синхронізовано із Задачником</span>
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
        {/* Місяць — показники факт/план за місяць */}
        <div style={{ border: `1px solid ${LINE}`, borderRadius: "var(--rpt-r-sm)", padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <b className="rpt-lab">Місяць · показники</b><span style={{ fontSize: 10.5, color: MUTED }}>факт / план за місяць</span>
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
      <div className="rpt-lab" style={{ marginBottom: 5 }}>{title}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7 }}>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.3px" }}>{fmt(fact)} <small style={{ color: MUTED, fontWeight: 600, fontSize: 12 }}>/ {plan > 0 ? fmt(plan) : "—"} ₴</small></span>
        <span style={{ fontWeight: 700, fontSize: 15, color: SCOL[status] }}>{plan > 0 ? `${pct}%` : "—"}</span>
      </div>
      <div className="rpt-track" style={{ position: "relative", overflow: "visible" }}>
        <div className="rpt-fill" style={{ width: `${Math.min(100, pct)}%`, background: SCOL[status] }} />
        {showTempo && elapsed != null && <div title="темп «сьогодні»" style={{ position: "absolute", top: -3, bottom: -3, width: 2, left: `${Math.min(100, elapsed * 100)}%`, background: INK, opacity: 0.55 }} />}
      </div>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6 }}>{footer}</div>
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
    <div style={{ textAlign: "center", minWidth: 62 }}>
      <div style={{ fontWeight: 800, fontSize: 17, lineHeight: 1.1, letterSpacing: "-.3px", color: v ? INK : MUTED }}>{money ? (v ? fmt(v) : "0") : v}</div>
      <div style={{ fontSize: 10, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".3px", marginTop: 4, whiteSpace: "nowrap" }}>{l}</div>
      {sub && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>{sub}</div>}
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
  /**
   * 🔴 «ЗІБРАВ, АЛЕ НЕ ЗАКРИВ» — ОКРЕМИЙ СТАН, А НЕ «ЗРИВ» (рішення власника 06.08.2026).
   *
   * Привід — картка Антипенка за серпень: ① «успішно реалізовано» = 0, при цьому
   * десять угод на 23 632 ₴ уже ОПЛАЧЕНІ (етап 9). Банер писав «Зрив темпу: факт 0»
   * — тобто звинувачував людину в бездіяльності рівно тоді, коли вона зібрала гроші
   * й не встигла лише перевести угоди в 142. Це не відтінок формулювання: «Зрив» —
   * привід для розмови з тімлідом, і привід був хибний.
   *
   * Умова НАВМИСНО вузька — `factSuccess === 0 && factPaid > 0`. Ширша («оплачених
   * багато») перетворила б банер на виправдання для будь-кого, хто відстає: гроші в
   * дорозі є майже завжди. Тут же йдеться про однозначний випадок, коли ЖОДНА угода
   * не закрита, а гроші прийшли — і дія з нього випливає одна й конкретна.
   */
  const collectedNotClosed = m.factSuccess === 0 && m.factPaid > 0;
  const why = collectedNotClosed
    ? `Гроші зібрані (${k(m.factPaid)}), але угоди не закриті — ${m.factPaidDeals} шт. на етапі «оплата отримана».`
    : activityOnPlan
      ? `Активність по плану, але гроші відстають — потрібне втручання (факт ${k(m.fact)} / ${k(m.plan)}, ${m.pct ?? 0}%).`
      : m.status === "r"
        ? `Зрив темпу: факт ${k(m.fact)} при плані ${k(m.plan)} (${m.pct ?? 0}%).`
        : `Відстає: факт ${k(m.fact)} (${m.pct ?? 0}% плану), нижче темпу.`;
  /**
   * 🔴 ДВА РІЗНІ «ОЧІКУЄМО» — РІЗНІ ПІДПИСИ (рішення власника 06.08.2026; ФОРМУЛИ
   * не змінено, змінено лише те, як вони НАЗВАНІ).
   *   · `m.expect`          — ЗНІМОК усієї зони визнання, БЕЗ прив'язки до дати
   *                           (Антипенко: 51 782 ₴);
   *   · `m.expectThisMonth` — те, що обіцяно надійти ЦЬОГО місяця, за плановою
   *                           датою оплати (Антипенко: 44 282 ₴).
   * Обидві правильні й обидві звались «очікуємо» — тож 52к і 44к на одному екрані
   * читались як розбіжність, а це просто дві різні речі.
   */
  const act = m.expect > behind
    ? (forMe
      ? `Пайплайн здоровий (у зоні очікування ${k(m.expect)}, без прив'язки до дати). Дотисни угоди з «Перевезення завершено» / «Дзвінок після розвантаж.».`
      : `Пайплайн здоровий (у зоні очікування ${k(m.expect)}, без прив'язки до дати). Дія: дотиснути угоди на грошових стадіях.`)
    : lowLeads
      ? (forMe
        ? `Лідів мало. Підніми оплати й додай нові ліди. Треба ${fmt(m.needPerDay)} ₴/день.`
        : `Лідів мало (реклама/лідоген нижче цілі). Дія: замовити лідогенів + підняти оплати. Треба ${fmt(m.needPerDay)} ₴/день.`)
      : (forMe
        ? `Пайплайну бракує (у зоні очікування ${k(m.expect)}, без прив'язки до дати). Наростай нові ліди й прискорюй закриття. Треба ${fmt(m.needPerDay)} ₴/день.`
        : `Пайплайну бракує (у зоні очікування лише ${k(m.expect)}, без прив'язки до дати). Дія: наростити ліди + прискорити закриття. Треба ${fmt(m.needPerDay)} ₴/день.`);
  // «Зібрав, але не закрив» — не червоний: це стан, а не провал.
  const c = collectedNotClosed ? AMBER : m.status === "r" ? RED : AMBER;
  return (
    <div style={{ padding: "0 20px 16px" }}>
      <div style={{ borderRadius: "var(--rpt-r-sm)", padding: "13px 16px", fontSize: 13, display: "flex", gap: 11, alignItems: "flex-start", background: SBG[m.status] }}>
        <span style={{ paddingTop: 6 }}><Dot c={c} /></span>
        <div><b style={{ color: c }}>{why}</b><div style={{ marginTop: 4, color: INK }}>{act}</div></div>
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
    <div style={{ borderTop: `1px solid ${LINE}`, background: SOFT, padding: "16px 20px 20px" }}>
      <div className="rpt-lab" style={{ margin: "0 0 10px" }}>По днях періоду ({ddmm(period.from)}–{ddmm(period.to)}) · клік на день → угоди</div>
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
                  <tr onClick={() => !future && openDeals(x.day)} style={{ cursor: future ? "default" : "pointer", background: isF ? "var(--rpt-tint)" : weekend ? SOFT : "var(--rpt-card)", color: dim ? MUTED : undefined }}>
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
                    <tr><td colSpan={6} style={{ padding: 0, background: SOFT }}>
                      {(deals[x.day] ?? []).length === 0 ? <div style={{ padding: "9px 14px", color: MUTED, fontSize: 12 }}>{deals[x.day] ? "Немає угод." : "Завантаження…"}</div>
                        : (deals[x.day] ?? []).map((dl, i) => (
                          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 92px 100px", gap: 10, padding: "8px 14px", borderBottom: `1px solid ${LINE}`, fontSize: 12, alignItems: "center" }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dl.name || "—"}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: "var(--r-pill)", textAlign: "center", background: dl.src === "new" ? "var(--rpt-card)" : SBG.g, color: dl.src === "new" ? MUTED : GREEN }}>{dl.src === "new" ? "новий" : "постійний"}</span>
                            <span style={{ textAlign: "right", fontWeight: 700, color: dl.price ? INK : MUTED }}>{dl.price ? fmt(dl.price) + " ₴" : dl.status}</span>
                          </div>
                        ))}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
            <tr style={{ background: SOFT, fontWeight: 800, borderTop: `2px solid ${LINE}` }}>
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
// Тег команди → лише ПІДПИС: він ідентифікує команду, а не сигналізує стан, тож
// у макеті це нейтральна плашка. Кольори лишаються за статусами (зарезервовані).
const STUCK_TAG: Record<string, string> = { rpk: "РПК", rnk: "РНК", leadgen: "ЛГ" };
// Простій → ключ статусу (не «свій» колір, а той самий зарезервований набір).
const idleKey = (d: number): "r" | "a" | "m" => (d >= 90 ? "r" : d >= 21 ? "a" : "m");
const idleColor = (d: number) => (d >= 90 ? RED : d >= 21 ? AMBER : MUTED);
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
  // Підсумок ІНЛАЙНОМ у шапці (макет): цифра велика, підпис дрібний поруч — блок
  // читається одним рядком, замість окремої стрічки з чотирьох «кубиків».
  const stat = (v: React.ReactNode, l: string, color?: string) => (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <b style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.4px", color: color ?? INK }}>{v}</b>
      <span style={{ fontSize: 12, color: MUTED, fontWeight: 500 }}>{l}</span>
    </span>
  );

  return (
    <div style={{ marginTop: 20 }}>
      <div className="rpt-card" style={{ overflow: "hidden" }}>
        {/* Шапка — клікабельна кнопка згортання ВСІЄЇ секції (обгортка над per-manager акордеоном) */}
        <div onClick={() => setSectionOpen((o) => !o)} role="button" aria-expanded={sectionOpen}
             style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "18px 22px", flexWrap: "wrap", cursor: "pointer", userSelect: "none" }}>
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-.3px", display: "inline-flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ color: MUTED, fontSize: 12 }}>{sectionOpen ? "▾" : "▸"}</span>
              Застряглі угоди
            </span>
            {data && stat(data.total, "угоди")}
            {data && data.total > 0 && stat(<>{fmt(data.sumRisk)} ₴</>, "у ризику", ACC)}
            {data && stat(data.managers, "менеджерів")}
            {data && stat(data.over90, "> 90 днів", data.over90 > 0 ? RED : undefined)}
            <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
              <InfoHint text="Критерій — ВІДСУТНІСТЬ РУХУ, а не стадія: усі відкриті угоди повного циклу без реальної людської активності понад поріг. Поріг 7 дн. — «Авто працює» і «Очікуємо оплату»; 21 дн. — ранні стадії, включно з «Виставлення рахунку». Межа вибірки — funnel_stage <> 'paid', тобто «Оплата отримана» / «Успішна» / «Злито» НЕ входять, а «Авто працює» ВХОДИТЬ. Анкер — остання активність (нотатки людини, не Salesbot). Сума в ризику — signed (сторно нетиться). Вікно створення 180 днів." />
            </span>
          </span>
          {sectionOpen && data && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }} onClick={(e) => e.stopPropagation()}>
              <span className="rpt-chip">{scopeLbl[data.scope]}</span>
              {data.scope !== "own" && (
                <select className="rpt-btn" value={sortBy} onChange={(e) => setSortBy(e.target.value as StuckSort)} style={{ padding: "7px 11px", fontSize: 12.5 }}>
                  <option value="count">за кількістю</option>
                  <option value="sum">за сумою в ризику</option>
                  <option value="idle">за простоєм</option>
                </select>
              )}
            </span>
          )}
        </div>
        {sectionOpen && (data == null ? <div style={{ padding: "0 22px 20px", color: MUTED }}>Завантаження…</div> : (
          <>
            {/* Критерій — тонкою смугою під шапкою (макет): він пояснює, а не сперечається за увагу */}
            {/* 🔴 ПІДПИС ЗВІРЕНО З КОДОМ (замір 04.08.2026), а не з макетом. Було двічі неточно:
                (а) макет казав «до „Авто працює"» — насправді ця стадія ВХОДИТЬ (у наборі 4 угоди);
                (б) наш власний підпис казав «≥7 дн. рахунок/гроші» — насправді поріг 7 дн. дістається
                    `funnel_stage='invoiced'` (це «Очікуємо оплату», 60 угод) і «Авто працює», а
                    «Виставлення рахунку» (статус 100274340) лежить в `approved` і має поріг ×3 = 21 дн. */}
            <div className="rpt-strip">
              без руху ≥ 7 дн. («Авто працює» · «Очікуємо оплату») · ≥ 21 дн. (ранні стадії, включно з «Виставлення рахунку») · усі відкриті стадії до «Оплата отримана» · дата = остання активність
            </div>

            {data.groups.length === 0 ? (
              <div style={{ padding: 20, color: MUTED, fontSize: 13 }}>Немає застряглих угод ✓</div>
            ) : [...data.groups].sort((a, b) =>
                  sortBy === "sum" ? b.sumAtRisk - a.sumAtRisk : sortBy === "idle" ? b.longestIdleDays - a.longestIdleDays : b.count - a.count
                ).map((g) => (
              <StuckMgrRow key={g.managerId} g={g} open={openMgr.has(g.managerId)} onToggle={() => toggleMgr(g.managerId)} single={data.scope === "own"} />
            ))}
          </>
        ))}
      </div>

      {/* Пояснення — лише коли секція розкрита */}
      {sectionOpen && <div style={{ background: SOFT, border: `1px solid ${LINE}`, borderRadius: "var(--rpt-r-sm)", padding: "13px 16px", fontSize: 12, color: "var(--rpt-ink-soft)", lineHeight: 1.6, marginTop: 12 }}>
        <b>Що рахуємо:</b> критерій — <b>відсутність руху</b>, а не стадія: усі відкриті угоди без активності понад поріг, <b>включно з «Авто працює»</b> (машина, що «працює» 175 днів, насправді стоїть) <b>і «Очікуємо оплату»</b>. Не входять «Оплата отримана», «Успішна», «Злито». Список — по менеджерах (згорнуті), згори — <b>чесний підсумок</b> без «стелі 50»: реальна к-сть, сума в ризику (signed), критичні &gt;90 дн. <b>Роль-скоуп:</b> адмін/КВП — вся компанія, тімлід — свій відділ, менеджер — лише свої. Дата простою — від останньої активності; всередині менеджера сортування від найдовшого.
      </div>}
    </div>
  );
}

const STUCK_COLS: { h: string; r?: boolean; hint?: string }[] = [
  { h: "Угода" }, { h: "Клієнт" }, { h: "Стадія" }, { h: "Сума", r: true }, { h: "Днів без руху", r: true },
  { h: "Остання розмова", r: true, hint: "Дата останнього ДЗВІНКА клієнту (call_in/call_out у CRM), а не будь-якої активності. «без контакту» — свіжа активність є, але місяць без дзвінка (метушня без контакту)." },
  { h: "Коментар", hint: "Робоча позначка: чому стоїть / що зроблено. Наша анотація — у CRM НЕ пишеться і на метрики не впливає. Зберігається автоматично (втрата фокуса або Ctrl+Enter). Редагує відповідальний менеджер, тімлід і адмін; бачать усі, хто бачить цю угоду." },
];

// Інлайн-нотатка по угоді: автозбереження на blur / Ctrl+Enter, лише коли текст ЗМІНИВСЯ.
// Не редактор — короткі позначки; сервер ріже до 2000 символів і сам перевіряє право.
function DealNote({ d }: { d: StuckGroupDeal }) {
  const [val, setVal] = useState(d.note ?? "");
  const [saved, setSaved] = useState<string>(d.note ?? "");
  const [state, setState] = useState<"" | "saving" | "ok" | "err">("");
  const [meta, setMeta] = useState<{ author: string | null; at: string | null }>({ author: d.noteAuthor, at: d.noteAt });
  const commit = async () => {
    const next = val.trim();
    if (next === saved.trim()) return; // без змін — не смикаємо сервер
    setState("saving");
    try {
      const r = await saveDealNote(d.kommoId, next);
      setSaved(next); setMeta({ author: r.noteAuthor, at: r.noteAt }); setState("ok");
      setTimeout(() => setState((s) => (s === "ok" ? "" : s)), 1800);
    } catch { setState("err"); }
  };
  if (!d.canEditNote) {
    return d.note
      ? <span title={meta.author ? `${meta.author}${meta.at ? " · " + meta.at.slice(0, 10) : ""}` : undefined} style={{ fontSize: 12 }}>{d.note}</span>
      : <span style={{ color: MUTED }}>—</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%" }}>
      <input value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        placeholder="позначка…" maxLength={2000}
        title={meta.author ? `останнє: ${meta.author}${meta.at ? " · " + meta.at.slice(0, 10) : ""}` : undefined}
        style={{ flex: 1, minWidth: 120, fontSize: 12, padding: "6px 10px", borderRadius: "var(--rpt-r-xs)", color: INK,
          background: "var(--rpt-card)", border: `1px solid ${state === "err" ? RED : LINE}` }} />
      <span style={{ fontSize: 11, width: 14, color: state === "err" ? RED : state === "ok" ? GREEN : MUTED }}
        title={state === "err" ? "не збережено — спробуй ще раз" : undefined}>
        {state === "saving" ? "…" : state === "ok" ? "✓" : state === "err" ? "✗" : ""}
      </span>
    </span>
  );
}

function StuckMgrRow({ g, open, onToggle, single }: { g: StuckManagerGroup; open: boolean; onToggle: () => void; single: boolean }) {
  const tag = g.teamTag ? STUCK_TAG[g.teamTag] : null;
  const hasCritical = g.longestIdleDays >= 90; // ≥1 критична угода (>90 дн) → червоний акцент рядка
  return (
    <div style={{ borderTop: `1px solid ${LINE}`, borderLeft: hasCritical ? `3px solid ${ACC}` : "3px solid transparent" }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 11, padding: "15px 22px", cursor: "pointer", flexWrap: "wrap", background: hasCritical ? "var(--rpt-tint)" : undefined }}>
        <span style={{ color: hasCritical ? ACC : MUTED, fontSize: 12 }}>{open ? "▼" : "▶"}</span>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.2px" }}>{single ? "Мої застряглі" : g.manager}</span>
        {tag && !single && <Tag>{tag}</Tag>}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
          <span><b style={{ fontSize: 16, fontWeight: 800 }}>{g.count}</b> <span style={{ fontSize: 12, color: MUTED }}>{g.count === 1 ? "угода" : "угод"}</span></span>
          <span><b style={{ fontSize: 16, fontWeight: 800 }}>{fmt(g.sumAtRisk)} ₴</b> <span style={{ fontSize: 12, color: MUTED }}>у ризику</span></span>
          <Tag c={idleColor(g.longestIdleDays)} bg={idleKey(g.longestIdleDays) === "m" ? SOFT : SBG[idleKey(g.longestIdleDays)]}>
            найдовша · {g.longestIdleDays} дн.
          </Tag>
        </span>
      </div>
      {/* overflow-x: клітинки тримають колонки в один рядок (nowrap), тож на вузькому
          екрані таблиця має ПРОКРУЧУВАТИСЬ, а не обрізатись — інакше «Коментар»
          просто зникав за краєм картки. */}
      {open && (
        <div style={{ maxHeight: 460, overflowY: "auto", overflowX: "auto", borderTop: `1px solid ${LINE}` }}>
          <table className="data-table" style={{ width: "100%" }}>
            <thead><tr>{STUCK_COLS.map((c) => <th key={c.h} style={{ textAlign: c.r ? "right" : "left", position: "sticky", top: 0, zIndex: 1 }}>{c.h}{c.hint && <> <InfoHint text={c.hint} /></>}</th>)}</tr></thead>
            <tbody>
              {g.deals.map((d) => (
                  <tr key={d.kommoId}>
                    <td style={{ textAlign: "left" }}><a href={d.crmUrl} target="_blank" rel="noreferrer" style={{ color: LINK, fontWeight: 600 }}>{d.name || "—"}</a></td>
                    <td style={{ textAlign: "left", color: "var(--rpt-ink-soft)" }}>{d.client || "—"}</td>
                    <td style={{ textAlign: "left" }}><Tag>{d.stage}</Tag></td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: d.price < 0 ? RED : INK }}>{d.price ? fmt(d.price) + " ₴" : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <Tag c={idleColor(d.days)} bg={idleKey(d.days) === "m" ? SOFT : SBG[idleKey(d.days)]}>{d.days} дн.</Tag>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {d.daysSinceLastCall == null
                        ? <span style={{ color: MUTED }}>дзвінка не було</span>
                        : <span style={{ color: d.daysSinceLastCall >= 30 ? AMBER : "var(--rpt-ink-soft)" }}>{d.daysSinceLastCall} дн. тому</span>}
                      {/* Прапорець замінено ПІДПИСОМ: сигнал не має триматись на піктограмі */}
                      {d.noCallFlag && <span title="метушня без контакту: свіжа активність, але місяць без дзвінка" style={{ color: AMBER, fontWeight: 700 }}> · без контакту</span>}
                    </td>
                    <td style={{ textAlign: "left", minWidth: 190 }}><DealNote d={d} /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: MUTED, margin: "24px 2px 0", paddingTop: 16, borderTop: `1px solid ${LINE}` }}>
      {(["g", "a", "r"] as const).map((s) => <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Dot c={SCOL[s]} />{SLBL[s]}</span>)}
      <span>смуга: «Місяць» — головна траєкторія (сортування за нею), «Тиждень» — поточний; │ на місяці — позначка «сьогодні»</span>
    </div>
  );
}
