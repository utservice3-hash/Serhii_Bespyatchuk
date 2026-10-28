import { useState } from "react";
import type { RecvFx } from "../../../api";

/**
 * 💱 ВАЛЮТНА ДЕБІТОРКА — вкладка «Дебіторки» (задача 7136; Сергій на TOP Weekly 26.10.2026 — «виведи окремо в лист
 * дебіторки»; Роман 28.10 — «роби як пропонуєш»). Ті самі неоплачені валютні рахунки 1С з 2026 року, що в «Фінансах»
 * (рядок «Валютна дебіторка»), тож суми там і тут однакові. У валюті — скільки ще мають заплатити; ≈ грн — довідково за
 * курсом НБУ синку й до гривневої дебіторки НЕ додається. Скоуп — як у всій вкладці (менеджер — свої, тімлід — команда).
 */
const MUTED = "var(--text-muted)";
const money = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ");
const SIGN: Record<string, string> = { EUR: "€", USD: "$" };
const cur = (n: number, c: string) => `${money(n)} ${SIGN[c] ?? c}`;
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const curList = (r: Record<string, number>) => Object.entries(r).filter(([, v]) => v).map(([c, v]) => cur(v, c)).join(" + ") || "—";
const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11.5, padding: "1px 7px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

/** Рядок над «Активною дебіторкою»: валютний борг не губиться, але й не додається до гривні. */
export function FxBanner({ fx, onOpen }: { fx: RecvFx | null; onOpen: () => void }) {
  if (!fx || !fx.totals.invoices) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "0 0 12px", padding: "8px 12px", border: "1px dashed var(--border)", borderRadius: 8, fontSize: "var(--fs-sm)" }}>
      <span>+ валютна дебіторка: <b>{curList(fx.totals.byCurrency)}</b>{fx.totals.uah ? <span style={{ color: MUTED }}> (≈ {money(fx.totals.uah)} ₴)</span> : null} · {fx.totals.invoices} рах.</span>
      <button type="button" className="fin-link" onClick={onOpen} style={{ background: "none", border: "none", color: "var(--brand, #c5141c)", cursor: "pointer", font: "inherit", padding: 0 }}>Дивитись →</button>
    </div>
  );
}

export function ReceivablesFxTab({ fx, loading, error }: { fx: RecvFx | null; loading: boolean; error: string | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (error && !fx) return <div className="chart-card"><b>Валютна дебіторка</b> <span style={{ color: MUTED }}>{error}</span></div>;
  if (loading && !fx) return <p className="loading-text">Завантаження…</p>;
  if (!fx) return null;
  const t = fx.totals;
  const tiles: [string, string, string][] = [
    ...Object.entries(t.byCurrency).filter(([, v]) => v).map(([c, v]): [string, string, string] =>
      [`Винні в ${c === "EUR" ? "євро" : c === "USD" ? "доларах" : c}`, cur(v, c), fx.rates[c] ? `≈ ${money(v * (fx.rates[c] ?? 0))} ₴ за НБУ` : "курсу НБУ ще немає"]),
    ["Рахунків", String(t.invoices), t.notRealized ? `${t.notRealized} без реалізації` : "усі з реалізацією"],
  ];
  return (
    <div className="chart-card">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <h2 className="chart-title" style={{ margin: 0 }}>Валютна дебіторка ({t.clients})</h2>
        <span style={{ fontSize: "var(--fs-sm)", color: MUTED }}>
          {fx.error ? <span style={{ color: "var(--danger)" }}>Останній синк 1С з помилкою: {fx.error}</span>
            : fx.syncedAt ? `Оновлено з 1С: ${new Date(fx.syncedAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "Ще не синхронізовано"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 10 }}>
        {tiles.map(([l, v, s]) => (
          <div key={l} style={{ background: "var(--surface-2, rgba(127,127,127,0.06))", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: "var(--fs-sm)", color: MUTED }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{v}</div>
            <div style={{ fontSize: "var(--fs-xs)", color: MUTED }}>{s}</div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: "var(--fs-sm)", color: MUTED, margin: "0 0 10px" }}>
        Неоплачені рахунки 1С у валюті з {dm(fx.from)}.{fx.from.slice(0, 4)}. У валюті — скільки ще мають заплатити; ≈ грн — довідково, до гривневої дебіторки
        не додається. Клік по клієнту — його рахунки. Днів — від дати рахунку.
      </p>
      {!fx.clients.length ? <p style={{ color: MUTED, margin: 0 }}>Валютних неоплачених рахунків у вашому скоупі немає.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%", minWidth: 640 }}>
            <thead><tr><th>Клієнт · менеджер</th><th className="num">Днів</th><th className="num">Залишок</th><th className="num">≈ грн</th></tr></thead>
            <tbody>
              {fx.clients.map((c) => (
                <FxClientRows key={c.key} c={c} open={!!open[c.key]} toggle={() => setOpen((o) => ({ ...o, [c.key]: !o[c.key] }))} kommoBase={fx.kommoBase} />
              ))}
              <tr style={{ fontWeight: 600 }}><td>Разом</td><td /><td className="num">{curList(t.byCurrency)}</td><td className="num">{t.uah ? money(t.uah) : "—"}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FxClientRows({ c, open, toggle, kommoBase }: { c: RecvFx["clients"][number]; open: boolean; toggle: () => void; kommoBase: string }) {
  return (
    <>
      <tr onClick={toggle} style={{ cursor: "pointer" }} aria-expanded={open}>
        <td>
          <b>{c.name}</b> <span style={{ color: MUTED }}>{open ? "▴" : "▾"}</span>
          <div style={{ fontSize: "var(--fs-xs)", color: MUTED }}>{c.managers.join(", ") || "менеджер невідомий"} · {c.invoices.length} рах. · {c.organizations.join(", ")}</div>
        </td>
        <td className="num" style={{ color: c.days > 30 ? "var(--danger)" : undefined }}>{c.days}</td>
        <td className="num"><b>{curList(c.remaining)}</b></td>
        <td className="num" style={{ color: MUTED }}>{c.uah == null ? "—" : money(c.uah)}</td>
      </tr>
      {open && c.invoices.map((i) => (
        <tr key={`${i.number}@${i.date}`} style={{ fontSize: "var(--fs-sm)", background: "var(--surface-2, rgba(127,127,127,0.04))" }}>
          <td style={{ paddingLeft: 24 }}>
            № {i.number} від {dm(i.date)}.{i.date.slice(0, 4)}{" "}
            {!i.realized && <span style={pill("#fff4dc", "#8a5300")}>без реалізації</span>}{" "}
            {i.partiallyPaid && <span style={pill("#e6f1fb", "#0c447c")}>частково: {cur(i.paidSum, i.currency)} з {cur(i.invoiceSum, i.currency)}</span>}{" "}
            {i.dealId ? <a href={`${kommoBase}/leads/detail/${i.dealId}`} target="_blank" rel="noreferrer">угода {i.dealId}</a>
              : <span style={{ color: MUTED }}>без угоди</span>}
            <span style={{ color: MUTED }}> · {i.organization}{i.manager ? ` · ${i.manager}` : ""}{i.dueDate ? ` · сплатити до ${dm(i.dueDate)}` : ""}</span>
          </td>
          <td className="num">{i.days}</td>
          <td className="num">{cur(i.remaining, i.currency)}</td>
          <td className="num" style={{ color: MUTED }}>{i.uah == null ? "—" : money(i.uah)}</td>
        </tr>
      ))}
    </>
  );
}
