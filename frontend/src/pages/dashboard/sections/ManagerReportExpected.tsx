import type { ManagerReport } from "../../../api";

const uah = (n: number) => Math.round(n).toLocaleString("uk-UA") + " ₴";

/**
 * Р4b — Очікування оплат: три числа (цей / наступний / 🔴 прострочені).
 * Прострочені підсвічені окремо — «застрягли після обіцяної дати».
 */
export function ManagerReportExpected({ expected }: Pick<ManagerReport, "expected">) {
  const e = expected;
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>Очікування надходжень</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
        Прогноз надходжень за «Запланованою датою оплати» (грошова зона: виставлено рахунок → очікуємо оплату).
        Прострочене/борг — у розділі «Дебіторська заборгованість» (окреме джерело), тут не дублюється.
      </p>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Tile label="Цей місяць" bucket={e.thisMonth} />
        <Tile label="Наступний місяць" bucket={e.nextMonth} />
      </div>
    </div>
  );
}

function Tile({ label, bucket, danger }: { label: string; bucket: { deals: number; sum: number }; danger?: boolean }) {
  return (
    <div
      className="kpi-card"
      style={danger ? { borderLeft: "4px solid #dc2626", background: "rgba(220,38,38,0.05)" } : undefined}
    >
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" style={danger ? { color: "#dc2626" } : undefined}>{uah(bucket.sum)}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{bucket.deals} угод</span>
    </div>
  );
}
