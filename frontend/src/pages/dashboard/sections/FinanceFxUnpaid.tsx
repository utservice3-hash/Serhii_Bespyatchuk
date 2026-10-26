import { useState } from "react";
import { fetchFxUnpaid, hiringError, type FxUnpaid, type FinKpiPeriod } from "../../../api";

/**
 * 💱 «ВАЛЮТНА ДЕБІТОРКА» — примітка під «Тиждень і місяць» і список рахунків (задача #5297, 26.10.2026; Роман: «роби лише
 * 2026 рік і щоб можна було глянути, що там не так»). З 26.10.2026 число — неоплачені рахунки 1С 2026 року у валюті
 * (сервіс `unpaid-invoices`), гривня — за курсом НБУ. Минулі періоди можуть мати підсумок старого джерела (рахунок 362) —
 * тоді й підпис старий: два різні джерела під одним підписом читаються як поломка.
 */
type Fx = NonNullable<FinKpiPeriod["receivablesFx"]>;
const money = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));
const at = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dmy = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

export function FxNote({ fx }: { fx: Fx }) {
  const [list, setList] = useState<FxUnpaid | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = () => {
    setOpen((o) => !o);
    if (!list) fetchFxUnpaid().then((d) => { setList(d); setErr(null); }).catch((e) => setErr(hiringError(e)));
  };

  if (fx.source !== "unpaid-2026") return (
    <div className="hr-sect hr-muted" style={{ fontSize: 12.5 }}>
      Валютна дебіторка з 1С (рахунок 362 — джерело до 26.10.2026) на {at(fx.at)}: {money(fx.uah)} у гривні
      {fx.usd != null && <> · у валюті: <b>{money(fx.usd)} USD</b> · <b>{money(fx.eur)} EUR</b></>}
      {" "}— 362 бачив лише рахунки з проведеною реалізацією.
    </div>
  );
  return (
    <div className="hr-sect" style={{ fontSize: 12.5 }}>
      <span className="hr-muted">Валютна дебіторка — неоплачені рахунки 1С 2026 року на {at(fx.at)}: </span>
      <b>{money(fx.eur)} EUR</b>{fx.usd ? <> · <b>{money(fx.usd)} USD</b></> : null}{fx.unknownVal ? <> · інша валюта <b>{money(fx.unknownVal)}</b></> : null}
      <span className="hr-muted"> ({fx.rows} рах.) · у гривні за курсом НБУ {money(fx.uah)}</span>
      {fx.zeroUah > 0 && <span style={{ color: "#b45309" }}> · для {fx.zeroUah} рах. курсу НБУ не було — у гривневу суму вони не ввійшли</span>}
      <button className="fin-link" style={{ marginLeft: 8 }} onClick={toggle} aria-expanded={open}>{open ? "Сховати рахунки ▴" : "Які рахунки ▾"}</button>
      {open && <div style={{ marginTop: 8 }}>
        {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
        {!list && !err && <span className="hr-muted">Завантаження…</span>}
        {list && <>
          {list.error && <div className="hr-note" style={{ marginBottom: 6 }}>Останній синк 1С не вдався: {list.error}. Нижче — останній вдалий список{list.syncedAt ? ` (${at(list.syncedAt)})` : ""}.</div>}
          <div style={{ overflowX: "auto" }}>
            <table className="hr-table" style={{ width: "100%", fontSize: 12.5 }}>
              <thead><tr><th>Дата</th><th>Рахунок</th><th>Організація</th><th>Покупець</th><th style={{ textAlign: "right" }}>Сума</th><th style={{ textAlign: "right" }}>Оплачено</th>
                <th style={{ textAlign: "right" }}>Залишок</th><th>Стан</th><th>Оплатити до</th><th>Менеджер</th><th>Угода</th></tr></thead>
              <tbody>
                {list.invoices.map((r) => (
                  <tr key={`${r.organization}·${r.number}`}>
                    <td style={{ whiteSpace: "nowrap" }}>{dmy(r.date)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>№ {r.number.replace(/^0+/, "")}</td>
                    <td>{r.organization}</td>
                    <td>{r.contractor}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(r.invoiceSum)} {r.currency}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.paidSum ? `${money(r.paidSum)} ${r.currency}` : "—"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}><b>{money(r.remaining)} {r.currency}</b></td>
                    <td>
                      {r.realized ? <span style={pill("rgba(37,99,235,0.10)", "#2563eb")} title={r.debtAccount ? `Борг на рахунку ${r.debtAccount}` : undefined}>реалізація є{r.debtAccount ? ` · ${r.debtAccount}` : ""}</span>
                        : <span style={pill("rgba(217,119,6,0.14)", "#b45309")} title="У 1С ще немає реалізації за цим рахунком — тому 362 його не бачив">реалізації немає</span>}
                      {r.partiallyPaid && <span style={{ ...pill("rgba(22,163,74,0.12)", "#16a34a"), marginLeft: 4 }}>частково оплачено</span>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{dmy(r.dueDate)}</td>
                    <td>{r.manager ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{r.dealId ? <a href={`${list.kommoBase}/leads/detail/${r.dealId}`} target="_blank" rel="noreferrer">{r.dealId}</a> : <span className="hr-muted" title={r.comment ?? undefined}>без угоди</span>}</td>
                  </tr>
                ))}
                {!list.invoices.length && <tr><td colSpan={11} className="hr-muted">Валютних неоплачених рахунків 2026 року немає.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="hr-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            Лише рахунки з {dmy(list.from)} (рішення 26.10.2026: старіші висячі рахунки 1С сюди не йдуть). Рахунок вважається оплаченим, коли в платежі вказано саме його;
            оплата без привʼязки до рахунку в 1С лишає його тут — тоді правити треба в 1С.
          </div>
        </>}
      </div>}
    </div>
  );
}
