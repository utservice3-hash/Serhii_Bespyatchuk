import { useEffect, useState } from "react";
import { fetchLeadgenStats, type LeadgenStatsResp } from "../../../api";
import { formatAmount } from "../format";
import { InfoHint } from "../widgets";

/**
 * 📞 «ЛІДОГЕНЕРАЦІЯ» — дзеркало таблиці лідгенів із подій CRM (ТЗ v2, 07.09.2026).
 *
 * Форма навмисно та сама, що в їхньому Google-листі: блок відділу зверху, рядок на
 * кожного лідгена, конверсії між сходинками з цільовими. Ручного вводу немає — усе
 * рахується з подій.
 *
 * 🔴 ЧОМУ МАШИНИ Й ГРОШІ ТІЛЬКИ ПО ВІДДІЛУ. Звʼязку «машина → конкретний лідген» у CRM
 * немає: поле «Лидогенератор» заповнене в 11 зі 103 машин серпня (`docs/LEADGEN_ETAP0.md`).
 * Показати його поіменно означало б вигадати число.
 */
export function LeadgenSection({ from, to }: { from: string; to: string }) {
  const [d, setD] = useState<LeadgenStatsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    setD(null); setErr(null);
    fetchLeadgenStats({ from, to })
      .then(setD)
      .catch((e) => setErr(e instanceof Error ? e.message : "Не вдалося завантажити"));
  }, [from, to]);

  if (err) return <div className="chart-card"><p style={{ margin: 0, color: "var(--danger, #c8102e)" }}>{err}</p></div>;
  if (!d) return <div className="chart-card"><p className="loading-text" style={{ margin: 0 }}>Завантаження…</p></div>;

  const t = d.totals;
  const conv = d.conversions;
  const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12.5, color: "var(--text-muted)" };

  /** «—», а не «0 %»: нульовий знаменник — це «нема з чого рахувати», а не провал. */
  const showPct = (v: number | null, target?: number) =>
    v == null ? "—" : <span style={{ color: target != null && v < target ? "#c8102e" : "inherit" }}>{v}%</span>;

  return (
    <>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
          🏢 Відділ лідогенерації
          <InfoHint text={
            "Показники рахуються з подій CRM (входи угод у стадії), без ручного вводу. "
            + "Ростер визначається діями за період, а не списком команди — тому тут видно "
            + "всіх, хто реально працював, включно з людьми з інших команд."
          } />
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          <Tile label="Успішні дзвінки" value={t.calls.toLocaleString("uk-UA")} hint={d.callRule} />
          <Tile label="Цільові / нові ліди" value={t.leads.toLocaleString("uk-UA")} hint="Входи угод у стадію «Взято в роботу» воронки Продзвін." />
          <Tile label="Отримано контактів ОПР" value={t.opr.toLocaleString("uk-UA")} hint="Входи у стадію «Отримано контакти ОПР»." />
          <Tile label="Передано на прорахунок" value={t.quotes.toLocaleString("uk-UA")} hint="Входи у «Кваліфіковано» — момент, коли CRM створює угоду менеджеру." />
          <Tile label="Клієнт підігрівається" value={t.warming.toLocaleString("uk-UA")} hint="Воронка Реактивації: клієнт попросив повернутись пізніше." />
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 14, fontSize: 14 }}>
          <span>Ліди → ОПР: <b>{showPct(conv.oprOfLeads, conv.targets.oprOfLeads)}</b> <span style={{ color: "var(--text-muted)" }}>ціль {conv.targets.oprOfLeads}%</span></span>
          <span>ОПР → прорахунок: <b>{showPct(conv.quotesOfOpr, conv.targets.quotesOfOpr)}</b> <span style={{ color: "var(--text-muted)" }}>ціль {conv.targets.quotesOfOpr}%</span></span>
        </div>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 4px" }}>🚚 Машини й гроші відділу</h3>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>{d.department.note}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
          <Tile label="Машини (відправлені)" value={d.department.machines.toLocaleString("uk-UA")} hint="Якір — дата відправлення (load_at)." />
          <Tile label="Сума відправлених" value={formatAmount(d.department.machinesRevenue)} hint="Той самий якір, що й машини." />
          <Tile label="Отримані кошти" value={formatAmount(d.department.receivedRevenue)} hint={`${d.department.receivedDeals} угод. Датований анкер ядра — той самий, що на Звіті.`} />
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>⚓ {d.department.anchors}</p>
      </div>

      <div className="chart-card" style={{ marginBottom: 16, overflowX: "auto" }}>
        <h3 style={{ margin: "0 0 12px" }}>👥 По людях</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: "left" }}>Лідген</th>
              <th style={head}>Дзвінки</th>
              <th style={head}>Ліди</th>
              <th style={head}>ОПР</th>
              <th style={head}>Прорахунки</th>
              <th style={head}>Підігрів</th>
              <th style={head}>Ліди→ОПР</th>
              <th style={head}>ОПР→прор.</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.managerId} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px" }}>
                  {r.name}
                  {!r.isActive && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> · деактивований</span>}
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.teamName ?? "поза командою"}</div>
                </td>
                <td style={cell}>{r.calls.toLocaleString("uk-UA")}</td>
                <td style={cell}>{r.leads.toLocaleString("uk-UA")}</td>
                <td style={cell}>{r.opr.toLocaleString("uk-UA")}</td>
                <td style={cell}>{r.quotes.toLocaleString("uk-UA")}</td>
                <td style={cell}>{r.warming.toLocaleString("uk-UA")}</td>
                <td style={cell}>{showPct(r.leads > 0 ? Math.round((r.opr / r.leads) * 1000) / 10 : null)}</td>
                <td style={cell}>{showPct(r.opr > 0 ? Math.round((r.quotes / r.opr) * 1000) / 10 : null)}</td>
              </tr>
            ))}
            {d.rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 14, color: "var(--text-muted)" }}>За цей період лідгенівських дій у CRM немає.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="chart-card">
        <h3 style={{ margin: "0 0 12px" }}>🧊 Звідки ліди</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <tbody>
            {d.bySource.map((s) => (
              <tr key={s.source} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px" }}>{s.source}</td>
                <td style={cell}>{s.leads.toLocaleString("uk-UA")}</td>
                <td style={{ ...cell, color: "var(--text-muted)" }}>
                  {t.leads > 0 ? `${Math.round((s.leads / t.leads) * 100)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
        {label} <InfoHint text={hint} />
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}
