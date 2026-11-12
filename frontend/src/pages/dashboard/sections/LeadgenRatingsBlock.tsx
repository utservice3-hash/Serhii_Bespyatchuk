import type { LeadgenQuoteRating, LeadgenStatsResp } from "../../../api";
import { InfoHint } from "../widgets";

/**
 * ⭐ «ОЦІНКИ ПРОРАХУНКІВ» (задача 7537, ТЗ Юлі 30.10.2026) — як менеджери оцінюють прорахунки кожного лідгена.
 * Усе рахує сервер (`core/leadgenRatings.ts`) з тих самих передач, що «Гроші з передач»; тут лише показ.
 * Період — спільний фільтр екрана. Середньої без жодної оцінки немає: «—», а не нуль.
 */
const MUTED = "var(--text-muted)";
const RULES = "Менеджер ставить «Оцінку прорахунку» 1–5 у своїй угоді в Kommo, що виросла з передачі лідгена. "
  + "Рахуються передачі вибраного періоду, де є угода менеджера; «не оцінено» — угода є, оцінки в ній ще немає. "
  + "«Поїхало» — з цих самих передач угоди з «Датою загрузки». Оцінки оновлюються з Kommo щогодини.";
const avgText = (v: number | null) => (v == null ? "—" : v.toFixed(2).replace(".", ","));
const pctText = (v: number | null) => (v == null ? "—" : `${String(v).replace(".", ",")}%`);
const avgColor = (v: number | null) => (v == null ? "inherit" : v < 3 ? "var(--danger)" : v >= 4 ? "var(--success, #15803d)" : "inherit");

export function LeadgenRatingsBlock({ d, who, periodLabel }: { d: LeadgenStatsResp; who: number | "all"; periodLabel: string }) {
  const q = d.quoteRatings;
  if (!q) return null;
  const names = new Map([...d.rows, ...(d.others ?? [])].map((r) => [r.managerId, r.name]));
  const people = q.byPerson
    .filter((p) => (who === "all" || p.managerId === who) && p.deals + p.noDeal > 0)
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.rated - a.rated);
  const cell: React.CSSProperties = { padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: MUTED };
  const left: React.CSSProperties = { ...cell, textAlign: "left" };
  const row = (key: string, label: React.ReactNode, s: LeadgenQuoteRating, bold = false) => (
    <tr key={key} style={{ borderTop: "1px solid var(--border)", fontWeight: bold ? 600 : 400 }}>
      <td style={left}>{label}</td>
      <td style={{ ...cell, color: avgColor(s.avg), fontWeight: 600 }}>{avgText(s.avg)}</td>
      <td style={cell}>{s.rated}</td>
      <td style={{ ...cell, color: s.unrated > 0 ? "inherit" : MUTED }}>{s.unrated}</td>
      {s.dist.map((n, i) => <td key={i} style={{ ...cell, color: n ? "inherit" : MUTED }}>{n}</td>)}
      <td style={cell}>{s.machines} <span style={{ color: MUTED }}>· {pctText(s.machinesPct)}</span></td>
    </tr>
  );
  return (
    <details className="chart-card" style={{ margin: "4px 0 14px" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        ⭐ Оцінки прорахунків · {periodLabel}
        <span style={{ fontWeight: 400, color: MUTED, fontSize: 13 }}>
          {" "}· середня {avgText(q.totals.avg)} · оцінено {q.totals.rated} з {q.totals.deals}
        </span>
        <InfoHint text={RULES} />
      </summary>
      {people.length === 0
        ? <div style={{ color: MUTED, fontSize: 13, marginTop: 10 }}>За цей період передач з угодою менеджера немає.</div>
        : (
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th style={{ ...head, textAlign: "left" }}>Лідген</th>
                  <th style={head}>Середня</th><th style={head}>Оцінено</th><th style={head}>Не оцінено</th>
                  {[1, 2, 3, 4, 5].map((n) => <th key={n} style={head}>«{n}»</th>)}
                  <th style={head} title="З цих самих передач — угоди з «Датою загрузки»">Поїхало</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => row(String(p.managerId), names.get(p.managerId) ?? `#${p.managerId}`, p))}
                {who === "all" && row("total", "Відділ", q.totals, true)}
              </tbody>
            </table>
            {q.totals.noDeal > 0 && who === "all" && (
              <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>Ще {q.totals.noDeal} передач без угоди менеджера — оцінити нема де.</div>
            )}
          </div>
        )}
    </details>
  );
}
