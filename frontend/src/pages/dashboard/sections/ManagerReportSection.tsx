import { useEffect, useMemo, useState } from "react";
import { fetchManagerReport, type ManagerReport, type Team, type ManagerOption } from "../../../api";
import { ManagerReportHero } from "./ManagerReportHero";
import { ManagerReportExpected } from "./ManagerReportExpected";

type Level = "department" | "team" | "manager";
type Auth = { role: "admin" | "team_lead" | "manager"; managerId: number | null; teamId: number | null };

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const shiftMonth = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + by, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const monthBounds = (ym: string) => { const [y, m] = ym.split("-").map(Number); const last = new Date(y, m, 0).getDate(); return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` }; };

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

  const [data, setData] = useState<ManagerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Менеджери у скоупі рівня «Команда» (для team_lead — своя команда).
  const mgrsForPick = useMemo(
    () => managerOptions.filter((m) => (auth.role === "team_lead" ? m.teamId === auth.teamId : level === "team" && teamId ? m.teamId === teamId : true)),
    [managerOptions, auth.role, auth.teamId, level, teamId]
  );

  const id = level === "team" ? teamId : level === "manager" ? managerId : undefined;

  useEffect(() => {
    if (level !== "department" && !id) { setData(null); setError("Оберіть " + (level === "team" ? "команду" : "менеджера")); setLoading(false); return; }
    setLoading(true); setError(null);
    const { from, to } = monthBounds(month);
    const cmp = compareOn ? monthBounds(shiftMonth(month, -1)) : null;
    fetchManagerReport({ level, id: id ?? undefined, from, to, granularity, compareFrom: cmp?.from, compareTo: cmp?.to })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e?.response?.data?.error ?? "Помилка завантаження"); setData(null); setLoading(false); });
  }, [level, id, month, granularity, compareOn]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Контроли ── */}
      <div className="chart-card" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        {levels.length > 1 && (
          <Seg label="Рівень" value={level} onChange={(v) => setLevel(v as Level)}
               options={levels.map((l) => ({ value: l, label: l === "department" ? "Відділ" : l === "team" ? "Команда" : "Менеджер" }))} />
        )}
        {level === "team" && auth.role === "admin" && (
          <Pick label="Команда" value={teamId} onChange={setTeamId} options={teams.map((t) => ({ value: t.id, label: t.name }))} />
        )}
        {level === "manager" && auth.role !== "manager" && (
          <Pick label="Менеджер" value={managerId} onChange={setManagerId} options={mgrsForPick.map((m) => ({ value: m.id, label: m.name }))} />
        )}
        <Seg label="Розбивка" value={granularity} onChange={(v) => setGranularity(v as "month" | "week")}
             options={[{ value: "month", label: "Місяць" }, { value: "week", label: "Тиждень" }]} />
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Період</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button className="btn-ghost" onClick={() => setMonth((m) => shiftMonth(m, -1))}>◀</button>
            <b style={{ minWidth: 130, textAlign: "center" }}>{monthLabel(month)}</b>
            <button className="btn-ghost" onClick={() => setMonth((m) => shiftMonth(m, 1))}>▶</button>
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={compareOn} onChange={(e) => setCompareOn(e.target.checked)} />
          Порівняти з попереднім місяцем
        </label>
      </div>

      {loading && <div className="chart-card"><p className="loading-text">Завантаження…</p></div>}
      {error && !loading && <div className="chart-card"><p style={{ color: "#dc2626" }}>{error}</p></div>}

      {data && !loading && (
        <>
          <ManagerReportHero revenue={data.revenue} compare={data.compare} />
          <ManagerReportExpected expected={data.expected} />

          {/* ── Заглушки решти піраміди (Р4c+) ── */}
          <Placeholder title="Воронка продажів (чесна, ≤100%)" note="funnelCohortHonest — тут буде 5 стадій + «зайшли посередині»" />
          {data.teams && <Placeholder title="Світлофор команд" note="teams — найгірші зверху, % плану, залишок" />}
          <Placeholder title="Конверсії + цілі" note="ads / Продзвін / Реактивація vs цільові (15 / 7-8 / 10%)" />
          <Placeholder title="Тижнева розбивка · Перенесені · Деталі" note="weekly · carryover · дрилл-даун" />
        </>
      )}
    </div>
  );
}

function Seg<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={value === o.value ? "btn-primary" : "btn-ghost"} style={{ padding: "5px 12px", fontSize: 13 }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Pick({ label, value, onChange, options }: { label: string; value: number | null; onChange: (v: number) => void; options: { value: number; label: string }[] }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
      <select value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} style={{ padding: "6px 10px", fontSize: 13 }}>
        <option value="" disabled>— обрати —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="chart-card" style={{ opacity: 0.7, border: "1px dashed var(--border)" }}>
      <h2 className="chart-title" style={{ marginBottom: 4 }}>{title}</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>🚧 тут буде: {note}</p>
    </div>
  );
}
