import { Fragment, useEffect, useState } from "react";
import {
  fetchBaTtn, fetchBaTtnDeals, setBaTtnMismatch, clearBaTtnMismatch, saveBaTtn, hiringError,
  type BaMeta, type BaTtnRow, type BaTtnDeal,
} from "../../../api";
import { fmtDate, fmtTs, type Toast } from "./BaShared";

/**
 * 🗂 «ТТН-МОНІТОРИНГ» (Бізнес-асистент). З 05.10.2026 рахується АВТОМАТИЧНО (рішення Романа):
 *  • «Угод, де потрібна ТТН» — з CRM за фільтром Даші; поруч посилання на той самий фільтр у Kommo;
 *  • «Прикріплено ТТН» — з поля Kommo «ТТН» серед тих самих угод;
 *  • «Маршрут не збігся» — позначки Даші на угодах (звірку документа робить людина);
 *  • «Наявні» = прикріплено − не збігся; % = наявні ÷ угоди, норма 70%; без угод — «—».
 * Розкриття менеджера — його угоди: де ТТН немає, і кнопка «маршрут не збігся» біля прикріплених.
 * «Зафіксувати місяць» — знімок трьох чисел; пізніші зміни в CRM видно поруч.
 */
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const ymName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};

export function BaTtn({ meta, toast }: { meta: BaMeta; toast: Toast }) {
  const [month, setMonth] = useState(meta.ttnDefaultMonth);
  const [rows, setRows] = useState<BaTtnRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setRows(null); setErr(null);
    fetchBaTtn(month).then((d) => setRows(d.rows)).catch((e) => setErr(hiringError(e)));
  }, [month, nonce]);
  const refresh = () => setNonce((n) => n + 1);

  const fix = async (r: BaTtnRow) => {
    setBusy(r.managerId);
    try { await saveBaTtn(month, r.managerId, { note: "" }); toast(`Зафіксовано: ${r.name}, ${ymName(month)}`); refresh(); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(null); }
  };

  const norm = meta.ttnNormPct;
  const tot = (rows ?? []).reduce((s, r) => ({ needed: s.needed + r.live.needed, present: s.present + r.live.present, unsynced: s.unsynced + r.live.unsynced }), { needed: 0, present: 0, unsynced: 0 });
  const totPct = tot.needed ? Math.round((tot.present / tot.needed) * 100) : null;
  const tone = (p: number | null) => (p == null ? undefined : p < norm ? "var(--danger)" : "var(--ok)");
  return (
    <div className="hr-card">
      <div className="hd">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="hr-nav" aria-label="Попередній місяць" onClick={() => setMonth((m) => shift(m, -1))}>‹</button>
          <b style={{ minWidth: 140, textAlign: "center" }}>{ymName(month)}</b>
          <button className="hr-nav" aria-label="Наступний місяць" onClick={() => setMonth((m) => shift(m, 1))}>›</button>
          {month !== meta.ttnDefaultMonth && <button className="hr-link" onClick={() => setMonth(meta.ttnDefaultMonth)}>до місяця перевірки</button>}
        </div>
        <span>{rows && rows.length > 0 && <>Разом наявні <b>{tot.present}</b> з <b>{tot.needed}</b> · <b style={{ color: tone(totPct) }}>{totPct == null ? "—" : `${totPct}%`}</b>{tot.unsynced > 0 && <span className="hr-muted"> · не синхронізовано: {tot.unsynced}</span>}</>}</span>
      </div>
      {err && <div className="hr-sect" style={{ color: "var(--danger)" }}>{err}</div>}
      {!rows && !err && <p className="loading-text" style={{ padding: 16 }}>Завантаження…</p>}
      {rows && (
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr>
              <th>Менеджер</th><th className="num">Угод, де потрібна ТТН</th><th className="num">Прикріплено ТТН</th>
              <th className="num">Маршрут не збігся</th><th className="num">Наявні</th><th>% відповідності</th><th>Динаміка · 6 міс.</th><th>Знімок</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.managerId}>
                  <tr className="row" tabIndex={0} aria-expanded={open === r.managerId}
                    onClick={(e) => { if ((e.target as HTMLElement).closest("a, button")) return; setOpen((o) => (o === r.managerId ? null : r.managerId)); }}>
                    <td><span className="hr-muted">{open === r.managerId ? "▾" : "▸"}</span> <b>{r.name}</b>{!r.active && <><br /><span className="hr-muted">неактивний</span></>}</td>
                    <td className="num"><b>{r.live.needed}</b>{r.kommoUrl && <><br /><a className="hr-link" href={r.kommoUrl} target="_blank" rel="noopener noreferrer">фільтр у Kommo ↗</a></>}</td>
                    <td className="num">{r.live.attached}{r.live.unsynced > 0 && <><br /><span className="hr-muted">не синхронізовано: {r.live.unsynced}</span></>}</td>
                    <td className="num">{r.live.mismatched || <span className="hr-muted">0</span>}</td>
                    <td className="num"><b>{r.live.present}</b></td>
                    <td>
                      {r.live.pct == null ? <span className="hr-muted">—</span> : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
                          <div className="hr-bar" style={{ flex: 1, marginTop: 0 }}><i style={{ width: `${Math.min(100, r.live.pct)}%`, background: tone(r.live.pct) }} /></div>
                          <b style={{ color: tone(r.live.pct) }}>{r.live.pct}%</b>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="hr-trend" style={{ height: 28, minWidth: 90 }}>
                        {r.history.map((h, i) => (
                          <i key={h.month} className={i === r.history.length - 1 ? "last" : ""} title={`${ymName(h.month)}: ${h.pct == null ? "угод немає" : `${h.pct}%`}`}
                            style={{ height: `${h.pct == null ? 3 : Math.max(3, Math.round(Math.min(100, h.pct) * 0.28))}px`, background: tone(h.pct) }} />
                        ))}
                      </div>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.saved
                        ? <><b style={{ color: tone(r.saved.pct) }}>{r.saved.pct == null ? "—" : `${r.saved.pct}%`}</b> <span className="hr-muted">({r.saved.ttnPresent} з {r.saved.dealsNeeded})</span><br /><span className="hr-muted">{fmtTs(r.saved.checkedAt)}{r.saved.checkedBy ? ` · ${r.saved.checkedBy}` : ""}</span><br /></>
                        : <span className="hr-muted">не зафіксовано<br /></span>}
                      <button className="hr-btn xs" disabled={busy === r.managerId || r.live.needed === 0} onClick={() => void fix(r)}>{r.saved ? "Перезафіксувати" : "Зафіксувати місяць"}</button>
                    </td>
                  </tr>
                  {open === r.managerId && <tr><td colSpan={8} style={{ background: "var(--surface-2, var(--bg))" }}><TtnDeals month={month} managerId={r.managerId} toast={toast} onChanged={refresh} /></td></tr>}
                </Fragment>
              ))}
              {!rows.length && <tr><td colSpan={8} className="hr-muted" style={{ padding: 16 }}>У цьому місяці в CRM немає успішних безготівкових угод — перевіряти нема що.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="hr-sect hr-muted">
        Усе рахується з CRM: угоди — успішні безготівкові (з ПДВ і без), закриті в цьому місяці, по відповідальному; «прикріплено» — є файл у полі «ТТН».
        Звірку маршруту робить людина: розкрийте менеджера й позначте угоду «маршрут не збігся» — її віднімуть із наявних. Норма — {norm}%.
      </div>
    </div>
  );
}

function TtnDeals({ month, managerId, toast, onChanged }: { month: string; managerId: number; toast: Toast; onChanged: () => void }) {
  const [deals, setDeals] = useState<BaTtnDeal[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => { fetchBaTtnDeals(month, managerId).then(setDeals).catch((e) => toast(hiringError(e), { error: true })); }, [month, managerId, nonce, toast]);
  const toggle = async (d: BaTtnDeal) => {
    let note = "";
    if (!d.mismatch) {
      const v = window.prompt(`Маршрут у ТТН не збігся з угодою «${d.name || d.kommoId}». Коментар (необовʼязково):`, "");
      if (v === null) return;
      note = v;
    }
    setBusy(d.kommoId);
    try {
      if (d.mismatch) await clearBaTtnMismatch(d.kommoId); else await setBaTtnMismatch(d.kommoId, note);
      setNonce((n) => n + 1); onChanged();
    } catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(null); }
  };
  if (!deals) return <p className="loading-text" style={{ margin: 8 }}>Завантаження угод…</p>;
  const without = deals.filter((d) => d.ttnFiles === 0).length;
  return (
    <div style={{ padding: "4px 8px 8px" }}>
      <div className="hr-muted" style={{ marginBottom: 6 }}>Угод: {deals.length} · без ТТН: <b style={{ color: without ? "var(--danger)" : undefined }}>{without}</b></div>
      <table className="hr-table">
        <thead><tr><th>Угода</th><th>Клієнт</th><th>Закрито</th><th>ТТН</th><th>Маршрут</th></tr></thead>
        <tbody>
          {deals.map((d) => (
            <tr key={d.kommoId}>
              <td><a className="hr-link" href={d.url} target="_blank" rel="noopener noreferrer">{d.name || `№${d.kommoId}`} ↗</a></td>
              <td>{d.client || <span className="hr-muted">не вказано</span>}</td>
              <td>{fmtDate(d.closedOn)}</td>
              <td>{d.ttnFiles == null ? <span className="hr-muted">не синхронізовано</span> : d.ttnFiles > 0 ? <span className="hr-pill ok">є{d.ttnFiles > 1 ? ` · ${d.ttnFiles}` : ""}</span> : <span className="hr-pill dg">немає</span>}</td>
              <td>{d.ttnFiles && d.ttnFiles > 0 ? (d.mismatch
                ? <><span className="hr-pill wn">не збігся</span>{d.mismatch.note && <span className="hr-muted"> {d.mismatch.note}</span>} <button className="hr-link" disabled={busy === d.kommoId} onClick={() => void toggle(d)}>зняти</button></>
                : <button className="hr-btn xs" disabled={busy === d.kommoId} onClick={() => void toggle(d)}>маршрут не збігся</button>)
                : <span className="hr-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
