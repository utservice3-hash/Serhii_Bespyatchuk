import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchManagerReport, type ManagerReport, type Team, type ManagerOption } from "../../../api";
import { DatePicker } from "../../../components/DatePicker";
import { previousRange, formatAmount } from "../format";
import { InfoHint } from "../widgets";
import { ManagerReportHero } from "./ManagerReportHero";
import { ManagerReportExpected, TeamManagerBreakdown, type ScopeBreakdownRow } from "./ManagerReportExpected";
import { TrafficLight, type TrafficRow } from "./TeamsTrafficLight";

type Level = "department" | "team" | "manager";
type Auth = { role: "admin" | "team_lead" | "manager"; managerId: number | null; teamId: number | null };

const shiftMonth = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + by, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const curMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; };
const monthBounds = (ym: string) => { const [y, m] = ym.split("-").map(Number); const last = new Date(y, m, 0).getDate(); return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` }; };
const todayKyiv = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
const MONTHS_SHORT = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const fmtRange = (f: string, t: string) => {
  const fd = new Date(f + "T00:00:00"), td = new Date(t + "T00:00:00");
  return `${fd.getDate()}–${td.getDate()} ${MONTHS_SHORT[td.getMonth()]}`;
};
// Уніфікація рядків світлофора (команда/менеджер → TrafficRow).
const teamToRow = (t: NonNullable<ManagerReport["teams"]>[number]): TrafficRow => ({ id: t.teamId, name: t.teamName, plan: t.plan, fact: t.fact, pctPlan: t.pctPlan, remaining: t.remaining, expectedThisMonth: t.expectedThisMonth, flowCur: t.flowCur, flowPrev: t.flowPrev });
const mgrToRow = (m: NonNullable<ManagerReport["managers"]>[number]): TrafficRow => ({ id: m.managerId, name: m.name, plan: m.plan, fact: m.fact, pctPlan: m.pctPlan, remaining: m.remaining, expectedThisMonth: m.expectedThisMonth, flowCur: m.flowCur, flowPrev: m.flowPrev });

/**
 * Р4b — ЄДИНИЙ звіт (менеджер + КВП) з фільтром рівня. Каркас + головне (рівень 1
 * піраміди). Кожна секція — окремий компонент (не моноліт). Решта — заглушки.
 */
export function ManagerReportSection({ auth, teams, managerOptions }: { auth: Auth; teams: Team[]; managerOptions: ManagerOption[] }) {
  // Доступні рівні за роллю (бекенд усе одно жорстко обмежує; тут — UX).
  const levels: Level[] = auth.role === "manager" ? ["manager"] : auth.role === "team_lead" ? ["team", "manager"] : ["department", "team", "manager"];
  const [level, setLevel] = useState<Level>(levels[0]);
  const [teamId, setTeamId] = useState<number | null>(auth.role === "team_lead" ? auth.teamId : teams[0]?.id ?? null);
  const [managerId, setManagerId] = useState<number | null>(auth.role === "manager" ? auth.managerId : null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [granularity, setGranularity] = useState<"month" | "week">("month");
  const [compareOn, setCompareOn] = useState(true);
  const [tlMode, setTlMode] = useState<"teams" | "managers">("teams"); // світлофор: Команди / Усі менеджери (лише на рівні «Відділ»)

  const [data, setData] = useState<ManagerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 🔴 Джерело manager-picker'а — той самий масив `managers` із відповіді звіту (не
  // окремий `managerOptions`, який на цій секції не вантажиться → був порожній). Кеш
  // мерджить менеджерів по id у міру завантаження (department-рівень дає повний список,
  // admin стартує з нього); скидається при зміні періоду. Fallback — `managerOptions`.
  type MgrRow = NonNullable<ManagerReport["managers"]>[number];
  const [mgrCache, setMgrCache] = useState<Record<number, MgrRow>>({});
  useEffect(() => { setMgrCache({}); }, [month, compareOn]);
  useEffect(() => {
    const ms = data?.managers;
    if (!ms) return;
    setMgrCache((prev) => { const next = { ...prev }; for (const m of ms) next[m.managerId] = m; return next; });
  }, [data]);
  const pickerManagers = useMemo(() => {
    const cached = Object.values(mgrCache);
    if (cached.length) return cached.map((m) => ({ id: m.managerId, name: m.name, teamId: m.teamId, noPlan: m.plan <= 0 }));
    return managerOptions.map((m) => ({ id: m.id, name: m.name, teamId: m.teamId, noPlan: false }));
  }, [mgrCache, managerOptions]);

  const id = level === "team" ? teamId : level === "manager" ? managerId : undefined;

  // Like-for-like порівняння: для ПОТОЧНОГО (неповного) місяця — MTD vs ті самі дні
  // попереднього (1–17 vs 1–17, `previousRange`); для завершених — ПОВНИЙ vs ПОВНИЙ
  // (не same-day-span — інакше різали б 31-ше число попереднього).
  // Раніше порівнювали MTD з ПОВНИМ минулим місяцем → фейкові −50% посеред місяця.
  const { from, to } = monthBounds(month);
  const isPartial = to > todayKyiv();
  const effTo = isPartial ? todayKyiv() : to;
  const cmp = compareOn ? (isPartial ? previousRange(from, effTo) : monthBounds(shiftMonth(month, -1))) : null;
  const compareLabel = cmp ? `${fmtRange(from, effTo)} vs ${fmtRange(cmp.from, cmp.to)} · за датованим потоком` : null;

  useEffect(() => {
    if (level !== "department" && !id) { setData(null); setError("Оберіть " + (level === "team" ? "команду" : "менеджера")); setLoading(false); return; }
    setLoading(true); setError(null);
    fetchManagerReport({ level, id: id ?? undefined, from, to, granularity, compareFrom: cmp?.from, compareTo: cmp?.to })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e?.response?.data?.error ?? "Помилка завантаження"); setData(null); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, id, month, granularity, compareOn]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Контроли (стиль дашборду) ── */}
      <div className="page-header">
        <h1 className="page-title">🧭 Звіт 2.0</h1>
        <div className="page-filters" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {levels.length > 1 && (
            <Seg value={level} onChange={(v) => setLevel(v as Level)}
                 options={levels.map((l) => ({ value: l, label: l === "department" ? "Відділ" : l === "team" ? "Команда" : "Менеджер" }))} />
          )}
          {level === "team" && auth.role === "admin" && (
            <Pick value={teamId} onChange={setTeamId} placeholder="команда" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
          )}
          {level === "manager" && auth.role !== "manager" && (
            <ManagerPicker value={managerId} onChange={setManagerId} managers={pickerManagers} teams={teams} />
          )}
          <span style={{ width: 1, height: 24, background: "var(--border)", margin: "0 2px" }} />
          <NavBtn onClick={() => setMonth((m) => shiftMonth(m, -1))} title="Попередній місяць">←</NavBtn>
          <DatePicker mode="month" value={month} onChange={(v) => v && setMonth(v)} minWidth={150} />
          <NavBtn onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= curMonth()} title="Наступний місяць">→</NavBtn>
          <Seg value={granularity} onChange={(v) => setGranularity(v as "month" | "week")}
               options={[{ value: "month", label: "Місяць" }, { value: "week", label: "Тиждень" }]} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", color: "var(--text)" }}>
            <input type="checkbox" checked={compareOn} onChange={(e) => setCompareOn(e.target.checked)} />
            Порівняти з попереднім
          </label>
        </div>
      </div>

      {loading && <div className="chart-card"><p className="loading-text">Завантаження…</p></div>}
      {error && !loading && <div className="chart-card"><p style={{ color: "#dc2626" }}>{error}</p></div>}

      {data && !loading && (
        <>
          <ManagerReportHero revenue={data.revenue} compare={data.compare} compareLabel={compareLabel} />
          <ManagerReportExpected expected={data.expected} expectedByTeam={data.expectedByTeam} expectedByManager={data.expectedByManager} />

          {/* ── Р4c.1 — світлофор (рівне-залежний + плоский рейтинг менеджерів) ── */}
          {level === "department" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ alignSelf: "flex-start" }}>
                <Seg value={tlMode} onChange={(v) => setTlMode(v as "teams" | "managers")}
                     options={[{ value: "teams", label: "Команди" }, { value: "managers", label: "Усі менеджери" }]} />
              </div>
              {tlMode === "teams" && data.teams && (
                <TrafficLight
                  title="🚦 Світлофор команд" hint="клік → звіт по команді"
                  rows={data.teams.map(teamToRow)} compareLabel={compareLabel}
                  onRowClick={(id) => { setTeamId(id); setLevel("team"); }}
                  clickTitle={(n) => `Відкрити звіт по команді «${n}»`}
                />
              )}
              {tlMode === "managers" && data.managers && (
                <TrafficLight
                  title="🚦 Рейтинг менеджерів (усі)" hint="клік → звіт менеджера"
                  rows={data.managers.map(mgrToRow)} compareLabel={compareLabel}
                  onRowClick={(id) => { if (id <= 0) return; setManagerId(id); setLevel("manager"); }}
                  clickTitle={(n) => `Відкрити звіт менеджера «${n}»`}
                />
              )}
            </div>
          )}
          {level === "team" && data.managers && (
            <TrafficLight
              title="🚦 Менеджери команди" hint="клік → звіт менеджера"
              rows={data.managers.map(mgrToRow)} compareLabel={compareLabel}
              onRowClick={(id) => { setManagerId(id); setLevel("manager"); }}
              clickTitle={(n) => `Відкрити звіт менеджера «${n}»`}
            />
          )}

          {/* ── Р4c.2 — когортна воронка · конверсії+цілі · тижнева+перенесені ── */}
          <MRFunnel funnel={data.funnel} compare={data.compare} />
          <MRConversions conv={data.conversions} compare={data.compare} />
          <MRDailyWeekly revenue={data.revenue} expected={data.expected} weekly={data.weekly} daily={data.daily} expectedByDay={data.expectedByDay} planPerDay={data.planPerDay} />
          <MRCarryover carryover={data.carryover} teams={data.teams} managers={data.managers} teamNames={teams} />
        </>
      )}
    </div>
  );
}

// Сегмент-перемикач — стиль дашборду (як granularity-тумблер у Звіті).
function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            style={{ padding: "6px 13px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: active ? 700 : 500,
              border: `1px solid ${active ? "#c5141c" : "var(--border)"}`,
              background: active ? "#c5141c" : "var(--card-bg)", color: active ? "#fff" : "var(--text)" }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function NavBtn({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ padding: "6px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)",
        color: "var(--text)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}

type MgrOpt = { id: number; name: string; teamId: number | null; noPlan: boolean };

/** Пошуковий згрупований picker менеджерів (по командах; без плану → «— без плану»). */
function ManagerPicker({ value, onChange, managers, teams }: { value: number | null; onChange: (v: number) => void; managers: MgrOpt[]; teams: Team[] }) {
  const [open, setOpen] = useState(false);
  const [qtext, setQtext] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const teamName = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);
  const selected = managers.find((m) => m.id === value);
  const q = qtext.trim().toLowerCase();
  const groups = useMemo(() => {
    const filtered = q ? managers.filter((m) => m.name.toLowerCase().includes(q)) : managers;
    const byTeam = new Map<number | null, MgrOpt[]>();
    for (const m of filtered) { const k = m.teamId; if (!byTeam.has(k)) byTeam.set(k, []); byTeam.get(k)!.push(m); }
    return [...byTeam.entries()]
      .map(([tid, ms]) => ({ tid, label: tid == null ? "Без команди" : (teamName.get(tid) ?? "—"), ms: ms.sort((a, b) => a.name.localeCompare(b.name, "uk")) }))
      .sort((a, b) => a.label.localeCompare(b.label, "uk"));
  }, [managers, q, teamName]);

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)}
        style={{ padding: "7px 10px", fontSize: 13, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: selected ? "var(--text)" : "var(--text-muted)", cursor: "pointer", minWidth: 180, textAlign: "left" }}>
        {selected ? selected.name : "— менеджер —"} <span style={{ color: "var(--text-muted)" }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0, width: 280, maxHeight: 360, overflowY: "auto", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}>
          <div style={{ position: "sticky", top: 0, background: "var(--card-bg)", padding: 8, borderBottom: "1px solid var(--border)" }}>
            <input autoFocus value={qtext} onChange={(e) => setQtext(e.target.value)} placeholder="Пошук менеджера…"
              style={{ width: "100%", padding: "6px 8px", fontSize: 13, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg, transparent)", color: "var(--text)" }} />
          </div>
          {groups.length === 0 && <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--text-muted)" }}>Нічого не знайдено.</div>}
          {groups.map((g) => (
            <div key={String(g.tid)}>
              <div style={{ padding: "6px 12px 2px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>{g.label}</div>
              {g.ms.map((m) => (
                <button key={m.id} onClick={() => { onChange(m.id); setOpen(false); setQtext(""); }}
                  style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%", padding: "7px 12px", fontSize: 13, border: "none", background: m.id === value ? "rgba(37,99,235,0.12)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                  {m.noPlan && <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>— без плану</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pick({ value, onChange, placeholder, options }: { value: number | null; onChange: (v: number) => void; placeholder: string; options: { value: number; label: string }[] }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}
      style={{ padding: "7px 10px", fontSize: 13, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
      <option value="" disabled>— {placeholder} —</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ─────────────────────── Р4c.2 — chartless секції піраміди ───────────────────────
// Спільні хелпери. pctCell — cohort-% з BE (вже «чесний» ≤100%, тому рендеримо як є,
// без перерахунку). ddmm — «DD.MM» із YYYY-MM-DD.
const pctCell = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);
const ddmm = (iso: string) => { const [, m, d] = iso.split("-"); return `${d}.${m}`; };

// §1 — Когортна воронка (чесна ≤100%). Джерело: data.funnel (MRFunnelBucket[]).
const FUNNEL_STAGES: { key: keyof ManagerReport["funnel"][number]["reached"]; label: string }[] = [
  { key: "lead_taken", label: "Взято в роботу" },
  { key: "quote_requested", label: "Запит на прорахунок" },
  { key: "approved", label: "Погоджено" },
  { key: "invoiced", label: "Виставлено рахунок" },
  { key: "paid", label: "Оплата" },
];
function MRFunnel({ funnel, compare }: { funnel: ManagerReport["funnel"]; compare: ManagerReport["compare"] }) {
  if (!funnel.length) return null;
  const cmp = compare?.funnelPaidPct;
  // Δ показуємо ЛИШЕ коли когорти співмірні за зрілістю (інакше оманливо).
  const dPct = cmp && !cmp.maturityMismatch ? cmp.deltaPct : null;
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>Воронка (когорта створених, чесна ≤100%)</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
        Когорта = ліди, що зайшли у «Взято в роботу» в бакеті; кожна стадія — скільки з ТІЄЇ САМОЇ когорти її досягли (стеля ≤100%).
      </p>
      {funnel.map((b) => (
        <div key={b.bucket} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 12px", marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{b.bucket} · когорта {b.cohort}</span>
            <span style={{ fontSize: 26, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>{pctCell(b.pct.paid)}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>дійшли до оплати</span>
            {b.mature === false && <span style={{ fontSize: 11, color: "#b45309", fontWeight: 600 }}>⏳ дозріває</span>}
            {b.midfunnel > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)", background: "var(--hover-bg, rgba(127,127,127,0.08))", borderRadius: 999, padding: "1px 8px" }}>
                + {b.midfunnel} зайшли посередині
              </span>
            )}
            {dPct != null && (
              <span style={{ fontSize: 12, fontWeight: 600, color: dPct >= 0 ? "#16a34a" : "#dc2626" }}>
                {dPct >= 0 ? "↑" : "↓"} {Math.abs(dPct)}% до попер.
              </span>
            )}
          </div>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr><th>Стадія</th><th style={{ textAlign: "right" }}>Досягли</th><th style={{ textAlign: "right" }}>% когорти</th></tr>
            </thead>
            <tbody>
              {FUNNEL_STAGES.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td style={{ textAlign: "right", fontWeight: s.key === "paid" ? 700 : 400 }}>{b.reached[s.key]}</td>
                  <td style={{ textAlign: "right" }}>{pctCell(b.pct[s.key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// §2 — Конверсії + цілі. Реюз ідіому плиток Огляду (kpi-card). Джерело: data.conversions.
function MRConversions({ conv, compare }: { conv: ManagerReport["conversions"]; compare: ManagerReport["compare"] }) {
  const tiles = [
    { label: "Конверсія реклами", c: conv.ads, headline: conv.ads.cohort, sub: undefined as string | undefined, cmpKey: "adsCohort" },
    { label: "Конверсія Продзвін", c: conv.prodzvin, headline: conv.prodzvin.won, sub: `передано ${pctCell(conv.prodzvin.handoff)}`, cmpKey: "prodzvinWon" },
    { label: "Конверсія Реактивація", c: conv.reactivation, headline: conv.reactivation.won, sub: `передано ${pctCell(conv.reactivation.handoff)}`, cmpKey: "reactivationWon" },
  ];
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>Конверсії + цілі</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
        Когортні наскрізні конверсії (стеля ≤100%). «⏳ дозріває» — когорта молодша 90 днів (частина ще не закрилась). «—» — замало входів (&lt;10).
      </p>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        {tiles.map((t) => {
          const low = t.c.entered < 10;
          const value = low || t.headline == null ? "—" : `${t.headline}%`;
          const cmp = compare?.[t.cmpKey];
          const dPct = cmp && !cmp.maturityMismatch ? cmp.deltaPct : null;
          const vsColor = t.c.vsTarget == null ? "var(--text-muted)" : t.c.vsTarget >= 0 ? "#16a34a" : "#dc2626";
          return (
            <div key={t.label} className="kpi-card">
              <span className="kpi-label">{t.label}</span>
              <span className="kpi-value">{value}</span>
              {t.sub && !low && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.sub}</span>}
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                ціль {t.c.target}% · <span style={{ color: vsColor, fontWeight: 600 }}>vs {t.c.vsTarget == null ? "—" : `${t.c.vsTarget >= 0 ? "+" : ""}${t.c.vsTarget}`}</span>
              </span>
              {t.c.mature === false && <span style={{ fontSize: 11, color: "#b45309", fontWeight: 600 }}>⏳ дозріває</span>}
              {dPct != null && (
                <span style={{ fontSize: 12, fontWeight: 600, color: dPct >= 0 ? "#16a34a" : "#dc2626" }}>
                  {dPct >= 0 ? "↑" : "↓"} {Math.abs(dPct)}% до попер.
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// §3 — Тижнева розбивка + Перенесені (carryover). Джерело: data.weekly, data.carryover.
const WEEK_STATUS: Record<"past" | "current" | "future", { bg: string; label: string }> = {
  past: { bg: "transparent", label: "минув" },
  current: { bg: "rgba(197,20,28,0.06)", label: "поточний" },
  future: { bg: "transparent", label: "попереду" },
};
// ⓘ-тексти (що рахує / за якою датою / чому таке число).
const HINT = {
  leads: "Унікальні нові ліди за період — кожну угоду рахуємо РАЗ, за ПЕРШИМ входом у «Взято в роботу». Спліт по каналу (lead_channel): реклама / лідген / інше. Тому день сходиться в тиждень і місяць.",
  created: "Створені угоди за ДАТОЮ СТВОРЕННЯ. Постійні клієнти = вже виконана робота (заходять посеред воронки), тому конверсію тут НЕ рахуємо — це лічильник.",
  dispatched: "Авто відправлено = угоди у стадії «Успішна» (142), за ДАТОЮ ЗАКРИТТЯ.",
  received: "«Успішно реалізовано» — угоди, що перейшли в статус 142, за датою закриття (не планова й не актова дата). Частково оплачені, але ще не закриті угоди сюди НЕ входять: вони переносяться в наступний місяць. Ширшу картину («гроші в компанії») показує картка «Отримані кошти» на Огляді.",
  expected: "Грошова зона за ПЛАНОВОЮ ДАТОЮ оплати — очікуване, ще не в касі.",
  plan: "Місячний план ÷ робочі дні = денний темп. Відставання = план-темп (наростаюче) мінус факт.",
};

// §3a — Місяць · тиждень · день (chartless). Заміна старої тижневої таблиці.
function MRDailyWeekly({ revenue, expected, weekly, daily, expectedByDay, planPerDay }: {
  revenue: ManagerReport["revenue"];
  expected: ManagerReport["expected"];
  weekly: ManagerReport["weekly"];
  daily: ManagerReport["daily"];
  expectedByDay: ManagerReport["expectedByDay"];
  planPerDay: ManagerReport["planPerDay"];
}) {
  const [weekSel, setWeekSel] = useState<string>("all");   // "all" | index у weekly
  const [openDays, setOpenDays] = useState(false);

  const plan = revenue.plan, fact = revenue.fact;
  const elapsed = revenue.projection.elapsedWorkingDays, totalWd = revenue.projection.totalWorkingDays;
  const planToDate = Math.round(planPerDay.perWorkingDay * elapsed);   // наростаючий план-темп
  const lag = Math.max(0, planToDate - fact);
  const expNextThis = expected.thisMonth.sum + expected.nextMonth.sum;
  const pctPlan = plan > 0 ? Math.round((fact / plan) * 100) : null;
  const factW = plan > 0 ? Math.min(100, Math.round((fact / plan) * 100)) : 0;
  const paceW = plan > 0 ? Math.min(100, Math.round((planToDate / plan) * 100)) : 0;

  const expInRange = (from: string, to: string) =>
    expectedByDay.filter((d) => d.date >= from && d.date <= to).reduce((a, d) => a + d.sum, 0);

  const selW = weekSel !== "all" ? weekly[Number(weekSel)] : null;
  const shownDays = selW ? daily.filter((d) => d.date >= selW.from && d.date <= selW.to) : daily;

  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 8 }}>Місяць · тиждень · день</h2>

      {/* ── Місячна смуга: план · факт · відставання · очікування ── */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", marginBottom: 10 }}>
        <div className="kpi-card"><span className="kpi-label">План<InfoHint text={HINT.plan} /></span><span className="kpi-value">{formatAmount(plan)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Факт (оплачено)<InfoHint text={HINT.received} /></span><span className="kpi-value" style={{ color: "#16a34a" }}>{formatAmount(fact)}</span>{pctPlan != null && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{pctPlan}% плану</span>}</div>
        <div className="kpi-card" style={{ borderLeft: "4px solid #d97706" }}><span className="kpi-label">Відставання (темп)<InfoHint text={HINT.plan} /></span><span className="kpi-value" style={{ color: lag > 0 ? "#dc2626" : "#16a34a" }}>{formatAmount(lag)}</span><span style={{ fontSize: 11, color: "var(--text-muted)" }}>план-темп {formatAmount(planToDate)} ({elapsed}/{totalWd} р.д.)</span></div>
        <div className="kpi-card" style={{ borderLeft: "4px solid #2563eb" }}><span className="kpi-label">Очікування (цей+наст.)<InfoHint text={HINT.expected} /></span><span className="kpi-value" style={{ color: "#2563eb" }}>{formatAmount(expNextThis)}</span><span style={{ fontSize: 11, color: "var(--text-muted)" }}>цей {formatAmount(expected.thisMonth.sum)} · наст. {formatAmount(expected.nextMonth.sum)}</span></div>
      </div>
      {/* смуга факт vs план + маркер темпу */}
      <div style={{ position: "relative", height: 16, background: "var(--hover-bg, rgba(127,127,127,0.12))", borderRadius: 999, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${factW}%`, background: "#16a34a", borderRadius: 999 }} />
        <div title={`План-темп: ${formatAmount(planToDate)}`} style={{ position: "absolute", left: `${paceW}%`, top: -2, bottom: -2, width: 2, background: "#dc2626" }} />
      </div>

      {/* ── Фільтр тижня ── */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        <WeekBtn active={weekSel === "all"} onClick={() => setWeekSel("all")} label="Місяць" />
        {weekly.map((w, i) => (
          <WeekBtn key={w.label} active={weekSel === String(i)} onClick={() => setWeekSel(String(i))}
            label={`${w.label} (${ddmm(w.from)}–${ddmm(w.to)})`} status={w.status} />
        ))}
      </div>
      {selW && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 12 }}>
          <div className="kpi-card"><span className="kpi-label">План тижня<InfoHint text={HINT.plan} /></span><span className="kpi-value">{formatAmount(selW.plan)}</span></div>
          <div className="kpi-card"><span className="kpi-label">Факт тижня<InfoHint text={HINT.received} /></span><span className="kpi-value" style={{ color: "#16a34a" }}>{formatAmount(selW.fact)}</span></div>
          <div className="kpi-card"><span className="kpi-label">Очікування тижня<InfoHint text={HINT.expected} /></span><span className="kpi-value" style={{ color: "#2563eb" }}>{formatAmount(expInRange(selW.from, selW.to))}</span></div>
        </div>
      )}

      {/* ── Поденний розкривний список ── */}
      <button onClick={() => setOpenDays((v) => !v)}
        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer", fontSize: 13, marginBottom: openDays ? 8 : 0 }}>
        {openDays ? "▾" : "▸"} Поденно {selW ? `(${selW.label})` : "(увесь місяць)"}
      </button>
      {openDays && (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ fontSize: 12.5 }}>
            <thead>
              <tr>
                <th>День</th>
                <th style={{ textAlign: "right" }}>Взято лідів<InfoHint text={HINT.leads} /></th>
                <th style={{ textAlign: "right" }}>Створено<InfoHint text={HINT.created} /></th>
                <th style={{ textAlign: "right" }}>Авто<InfoHint text={HINT.dispatched} /></th>
                <th style={{ textAlign: "right" }}>Отримано<InfoHint text={HINT.received} /></th>
                <th style={{ textAlign: "right" }}>План/Факт/Відст.<InfoHint text={HINT.plan} /></th>
              </tr>
            </thead>
            <tbody>
              {shownDays.map((d) => {
                const dLag = Math.max(0, d.plan - d.received);
                const empty = d.leadsTotal === 0 && d.created === 0 && d.dispatched === 0 && d.received === 0;
                return (
                  <tr key={d.date} style={{ opacity: d.working ? (empty ? 0.6 : 1) : 0.4 }}>
                    <td>{ddmm(d.date)}{!d.working && <span style={{ fontSize: 10, color: "var(--text-muted)" }}> вих.</span>}</td>
                    <td style={{ textAlign: "right" }}>
                      {d.leadsTotal}
                      {d.leadsTotal > 0 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}> (р{d.leadsAd}/лг{d.leadsLeadgen}/і{d.leadsOther})</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>{d.created}</td>
                    <td style={{ textAlign: "right" }}>{d.dispatched}{d.dispatchedSum ? <span style={{ fontSize: 10, color: "var(--text-muted)" }}> · {formatAmount(d.dispatchedSum)}</span> : null}</td>
                    <td style={{ textAlign: "right", fontWeight: d.received > 0 ? 700 : 400, color: d.received > 0 ? "#16a34a" : undefined }}>{formatAmount(d.received)}</td>
                    <td style={{ textAlign: "right", fontSize: 11, color: "var(--text-muted)" }}>
                      {d.plan > 0 ? `${formatAmount(d.plan)} / ${formatAmount(d.received)} / ` : "— / — / "}
                      <span style={{ color: dLag > 0 ? "#dc2626" : "#16a34a", fontWeight: 600 }}>{d.plan > 0 ? formatAmount(dLag) : "—"}</span>
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

function WeekBtn({ active, onClick, label, status }: { active: boolean; onClick: () => void; label: string; status?: "past" | "current" | "future" }) {
  return (
    <button onClick={onClick} title={status ? WEEK_STATUS[status].label : undefined}
      style={{ padding: "5px 11px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500,
        border: `1px solid ${active ? "#c5141c" : "var(--border)"}`,
        background: active ? "#c5141c" : status === "current" ? WEEK_STATUS.current.bg : "var(--card-bg)",
        color: active ? "#fff" : "var(--text)" }}>
      {label}
    </button>
  );
}

// §3b — Перенесені (carryover): плитка + дрілдаун команди→менеджери (реюз матрьошки).
function MRCarryover({ carryover, teams, managers, teamNames }: {
  carryover: ManagerReport["carryover"];
  teams: ManagerReport["teams"];
  managers: ManagerReport["managers"];
  teamNames: Team[];
}) {
  const coManagers: ScopeBreakdownRow[] = (managers ?? [])
    .filter((m) => m.carryover.deals > 0)
    .map((m) => ({ id: m.managerId, name: m.name, teamId: m.teamId, deals: m.carryover.deals, sum: m.carryover.amount }));
  const teamNameById = new Map(teamNames.map((t) => [t.id, t.name]));
  const coTeams: ScopeBreakdownRow[] = teams
    ? teams.filter((t) => t.carryover.deals > 0).map((t) => ({ id: t.teamId, name: t.teamName, teamId: t.teamId, deals: t.carryover.deals, sum: t.carryover.amount }))
    : [...coManagers.reduce((acc, m) => {
        const k = m.teamId ?? -1;
        const e = acc.get(k) ?? { id: k, name: teamNameById.get(k) ?? "Команда", teamId: m.teamId, deals: 0, sum: 0 };
        e.deals += m.deals; e.sum += m.sum; acc.set(k, e); return acc;
      }, new Map<number, ScopeBreakdownRow>()).values()];
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>Перенесені (carryover)</h2>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 12 }}>
        <div className="kpi-card" style={{ borderLeft: "4px solid #2563eb" }}>
          <span className="kpi-label">Перенесені</span>
          <span className="kpi-value">{formatAmount(carryover.amount)}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{carryover.deals} угод · display-only (не в план/факт)</span>
        </div>
      </div>
      {coTeams.length > 0 && (
        <>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 2px" }}>Розріз перенесених (display-only) — команди → менеджери:</p>
          <TeamManagerBreakdown byTeam={coTeams} byManager={coManagers} emptyText="Немає перенесених у цьому зрізі." />
        </>
      )}
    </div>
  );
}
