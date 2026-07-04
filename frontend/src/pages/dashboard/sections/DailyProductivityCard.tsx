import { useEffect, useState } from "react";
import { fetchDailyProductivity, type DailyProductivity } from "../../../api";
import { formatAmount, formatAmountFull } from "../format";

const fmtDay = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  const wd = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()];
  return `${wd}, ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const shift = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
const todayKyiv = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

/** "Продуктивність за день" — a manager's daily pulse (self, or a picked manager). */
export function DailyProductivityCard({ managerId }: { managerId?: number }) {
  const [date, setDate] = useState(todayKyiv());
  const [data, setData] = useState<DailyProductivity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchDailyProductivity({ managerId, date })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [managerId, date]);

  const isToday = date === todayKyiv();
  const maxTrend = data ? Math.max(1, ...data.trend.map((t) => t.amount)) : 1;
  const pct = data?.planPct;
  const pctColor = pct == null ? "var(--text-muted)" : pct >= 100 ? "#16a34a" : pct >= 70 ? "#d97706" : "#dc2626";

  const tile = (label: string, value: React.ReactNode, sub: string, extra?: React.ReactNode) => (
    <div style={{ background: "var(--card-bg)", padding: "14px 16px" }}>
      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>{label}</span>
      <div style={{ fontSize: 25, fontWeight: 680, marginTop: 4, letterSpacing: "-0.02em", display: "flex", alignItems: "baseline", gap: 8 }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
      {extra}
    </div>
  );

  return (
    <div className="chart-card" style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <div>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>Продуктивність за день</h2>
          {data && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{data.managerName}{data.teamName ? ` · ${data.teamName}` : ""}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={() => setDate(shift(date, -1))} title="Попередній день" style={navBtn}>‹</button>
          <button onClick={() => setDate(todayKyiv())} style={{ ...navBtn, fontWeight: 650, padding: "0 12px" }}>{isToday ? "Сьогодні" : fmtDay(date)}</button>
          <button onClick={() => setDate(shift(date, 1))} disabled={isToday} title="Наступний день" style={{ ...navBtn, opacity: isToday ? 0.4 : 1 }}>›</button>
        </div>
      </div>

      {loading || !data ? (
        <p className="loading-text" style={{ padding: 16 }}>{loading ? "Завантаження…" : "Немає даних."}</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 1, background: "var(--border)" }}>
            {tile("Прорахунків взято", <>{data.taken}</>, "Взято в роботу цього дня")}
            {tile("Авто відправлено", <>{data.avto}</>, "Перейшли в «Авто працює»")}
            {tile(
              "Оплат отримано",
              <>{data.paidCount} <span style={{ fontSize: 15, fontWeight: 650, color: "#16a34a" }}>{formatAmount(data.paidSum)}</span></>,
              "Оплата отримана + успішно"
            )}
            {tile(
              "Денний план (виручка)",
              <>{pct != null ? <>{pct}<span style={{ fontSize: 15, color: "var(--text-muted)" }}>%</span></> : "—"}</>,
              data.planDay > 0 ? `Факт ${formatAmountFull(data.paidSum)} / план ${formatAmountFull(data.planDay)}` : "План на місяць не виставлено",
              data.planDay > 0 ? (
                <div style={{ height: 7, borderRadius: 999, background: "var(--border)", overflow: "hidden", marginTop: 9 }}>
                  <div style={{ height: "100%", width: `${Math.min(100, pct ?? 0)}%`, background: pctColor, borderRadius: 999 }} />
                </div>
              ) : null
            )}
          </div>

          <div style={{ padding: "14px 16px", borderTop: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", margin: "0 0 10px" }}>Динаміка оплат — останні 14 днів</h3>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 56 }}>
              {data.trend.map((t, i) => {
                const last = i === data.trend.length - 1;
                return (
                  <div
                    key={t.day}
                    title={`${fmtDay(t.day)}: ${formatAmountFull(t.amount)}`}
                    style={{ flex: 1, height: `${Math.max(4, (t.amount / maxTrend) * 100)}%`, background: last ? "#c5141c" : "rgba(197,20,28,.16)", borderRadius: "3px 3px 0 0" }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-muted)", marginTop: 6 }}>
              <span>{fmtDay(data.trend[0].day)}</span>
              <span>{isToday ? "сьогодні" : fmtDay(data.date)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const navBtn: React.CSSProperties = {
  border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)",
  borderRadius: 8, height: 30, minWidth: 30, padding: "0 8px", fontSize: 14, cursor: "pointer",
};
