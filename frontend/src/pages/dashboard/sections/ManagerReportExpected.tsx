import type { ManagerReport } from "../../../api";

const uah = (n: number) => Math.round(n).toLocaleString("uk-UA") + " ₴";

/**
 * «Очікування надходжень» — самостійний блок із CRM, ПОВНІСТЮ окремий від дебіторки
 * (жодного зв'язку/дублювання боргу). «Загальні» великим (уся грошова зона), під ним
 * три картки за планованою датою: цей місяць · наступний · протерміновані (з CRM, НЕ
 * борг). «Пізніше»/«без дати» — рядок звірки під «Загальні», щоб чотири числа сходились
 * у загальну суму без залишку.
 */
export function ManagerReportExpected({ expected }: Pick<ManagerReport, "expected">) {
  const e = expected;
  return (
    <div className="chart-card">
      <h2 className="chart-title" style={{ marginBottom: 4 }}>
        Очікування надходжень <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>· з CRM</span>
      </h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px" }}>
        Розклад за «Запланованою датою оплати» (грошова зона: виставлено рахунок → очікуємо оплату).
        Джерело — CRM; самостійний блок. Відповідає на «КОЛИ за планом надійде»;
        «Прогноз місяця» у шапці бере ПОВНУ зону («де сяде у фінал») — числа навмисно різні.
      </p>

      {/* ── Загальні — великим ── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 16px", paddingBottom: 12, marginBottom: 12, borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Загальні (уся зона)</span>
        <span style={{ fontSize: 30, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>{uah(e.total.sum)}</span>
        <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{e.total.deals} угод</span>
        {(e.later.deals > 0 || e.noDate.deals > 0) && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexBasis: "100%" }}>
            у т.ч. пізніше (далі наст. місяця): {e.later.deals} угод / {uah(e.later.sum)}
            {e.noDate.deals > 0 && <> · без дати: {e.noDate.deals} / {uah(e.noDate.sum)}</>}
          </span>
        )}
      </div>

      {/* ── Три картки за планованою датою ── */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Tile label="Цей місяць" bucket={e.thisMonth} />
        <Tile label="Наступний місяць" bucket={e.nextMonth} />
        <Tile label="Протерміновані" bucket={e.overdue} accent tag="з CRM · не борг" />
      </div>
    </div>
  );
}

function Tile({ label, bucket, accent, tag }: { label: string; bucket: { deals: number; sum: number }; accent?: boolean; tag?: string }) {
  return (
    <div className="kpi-card" style={accent ? { borderLeft: "4px solid #d97706" } : undefined}>
      <span className="kpi-label" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {label}
        {tag && <span style={{ fontSize: 10, fontWeight: 600, color: "#b45309", background: "rgba(217,119,6,0.14)", borderRadius: 999, padding: "1px 8px" }}>{tag}</span>}
      </span>
      <span className="kpi-value" style={accent ? { color: "#b45309" } : undefined}>{uah(bucket.sum)}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{bucket.deals} угод</span>
    </div>
  );
}
