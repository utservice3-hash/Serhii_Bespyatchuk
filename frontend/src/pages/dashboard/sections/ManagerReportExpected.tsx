import { useState } from "react";
import type { ManagerReport } from "../../../api";

const uah = (n: number) => Math.round(n).toLocaleString("uk-UA") + " ₴";

/**
 * «Очікування надходжень» — самостійний блок із CRM, ПОВНІСТЮ окремий від дебіторки.
 * «Загальні» великим; три картки за планованою датою. Картка «Цей місяць» —
 * РОЗГОРТАНА МАТРЬОШКА (Р4c.1b): клік → команди (найбільші зверху) → менеджери
 * команди. Джерело = expected.thisMonth → Σ менеджерів = команда = відділ (інваріант).
 */
export function ManagerReportExpected({
  expected,
  expectedByTeam,
  expectedByManager,
}: Pick<ManagerReport, "expected" | "expectedByTeam" | "expectedByManager">) {
  const e = expected;
  const [openThis, setOpenThis] = useState(false);

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
        <Tile
          label="Цей місяць"
          bucket={e.thisMonth}
          chevron={openThis ? "▾" : "▸"}
          onClick={() => setOpenThis((v) => !v)}
          sub={expectedByTeam.length > 0 ? "клік — розріз по командах" : undefined}
        />
        <Tile label="Наступний місяць" bucket={e.nextMonth} />
        <Tile label="Протерміновані" bucket={e.overdue} accent tag="з CRM · не борг" />
      </div>

      {/* ── Матрьошка: команди → менеджери (тільки для «Цей місяць») ── */}
      {openThis && (
        <TeamManagerBreakdown byTeam={expectedByTeam} byManager={expectedByManager} emptyText="Немає очікувань цього місяця в цьому зрізі." />
      )}
    </div>
  );
}

/** Спільна матрьошка «команди → менеджери» (Row/Tile). Реюз: очікування (тут) і
 *  carryover-розріз у Звіті 2.0 §3. `byTeam`/`byManager` — {id, name, teamId, deals, sum}. */
export interface ScopeBreakdownRow { id: number; name: string; teamId: number | null; deals: number; sum: number }
export function TeamManagerBreakdown({ byTeam, byManager, emptyText }: { byTeam: ScopeBreakdownRow[]; byManager: ScopeBreakdownRow[]; emptyText: string }) {
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  return (
    <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      {byTeam.length === 0 && (
        <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--text-muted)" }}>{emptyText}</div>
      )}
      {byTeam.map((t) => {
        const isOpen = openTeam === t.id;
        const mgrs = byManager.filter((m) => m.teamId === t.id).sort((a, b) => b.sum - a.sum);
        return (
          <div key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
            <Row
              chevron={mgrs.length > 0 ? (isOpen ? "▾" : "▸") : ""}
              name={t.name}
              sum={t.sum}
              deals={t.deals}
              strong
              onClick={mgrs.length > 0 ? () => setOpenTeam(isOpen ? null : t.id) : undefined}
            />
            {isOpen && mgrs.map((m) => (
              <Row key={m.id} name={m.name} sum={m.sum} deals={m.deals} indent />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Row({ name, sum, deals, chevron, onClick, strong, indent }: { name: string; sum: number; deals: number; chevron?: string; onClick?: () => void; strong?: boolean; indent?: boolean }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      style={{
        display: "grid", gridTemplateColumns: "18px 1fr auto auto", alignItems: "center", gap: 10, width: "100%",
        padding: indent ? "8px 12px 8px 30px" : "10px 12px",
        background: indent ? "var(--bg, transparent)" : "var(--card-bg)",
        border: "none", borderTop: indent ? "1px dashed var(--border)" : undefined,
        cursor: onClick ? "pointer" : "default", textAlign: "left", color: "var(--text)",
        opacity: indent ? 0.92 : 1,
      }}
    >
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{chevron ?? ""}</span>
      <span style={{ fontWeight: strong ? 600 : 400, fontSize: indent ? 13 : 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{uah(sum)}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 64, textAlign: "right" }}>{deals} угод</span>
    </Tag>
  );
}

function Tile({ label, bucket, accent, tag, chevron, onClick, sub }: { label: string; bucket: { deals: number; sum: number }; accent?: boolean; tag?: string; chevron?: string; onClick?: () => void; sub?: string }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className="kpi-card"
      style={{
        ...(accent ? { borderLeft: "4px solid #d97706" } : {}),
        ...(onClick ? { cursor: "pointer", textAlign: "left", border: "1px solid var(--border)", borderLeft: "4px solid #2563eb" } : {}),
      }}
    >
      <span className="kpi-label" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {chevron && <span style={{ color: "var(--text-muted)" }}>{chevron}</span>}
        {label}
        {tag && <span style={{ fontSize: 10, fontWeight: 600, color: "#b45309", background: "rgba(217,119,6,0.14)", borderRadius: 999, padding: "1px 8px" }}>{tag}</span>}
      </span>
      <span className="kpi-value" style={accent ? { color: "#b45309" } : undefined}>{uah(bucket.sum)}</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{bucket.deals} угод{sub ? ` · ${sub}` : ""}</span>
    </Tag>
  );
}
