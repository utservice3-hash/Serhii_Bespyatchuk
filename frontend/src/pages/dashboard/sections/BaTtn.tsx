import { useEffect, useState } from "react";
import { fetchBaTtn, saveBaTtn, hiringError, type BaMeta, type BaTtnRow } from "../../../api";
import { fmtTs, type Toast } from "./BaShared";

/**
 * 🗂 «ТТН-МОНІТОРИНГ» (Бізнес-асистент, прохід 2, 29.09.2026). Рядок на менеджера й місяць:
 *  • «Угод, де потрібна ТТН» — АВТОМАТИЧНО з CRM за фільтром Даші; поруч посилання на той самий
 *    фільтр у Kommo — звірка одним кліком;
 *  • «Наявні ТТН» — Даша вносить руками (маршрут у вкладенні звіряє людина);
 *  • % — автоматично, норма 70%; без угод — «—».
 * Збережене число угод — знімок на момент перевірки; якщо CRM потім змінилась, це видно поруч.
 */
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const ymName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};
const pctOf = (present: number, needed: number) => (needed > 0 ? Math.round((present / needed) * 100) : null);

export function BaTtn({ meta, toast }: { meta: BaMeta; toast: Toast }) {
  const [month, setMonth] = useState(meta.ttnDefaultMonth);
  const [rows, setRows] = useState<BaTtnRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<number, { present: string; note: string }>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setRows(null); setErr(null);
    fetchBaTtn(month).then((d) => {
      setRows(d.rows);
      setDraft(Object.fromEntries(d.rows.map((r) => [r.managerId, { present: r.saved ? String(r.saved.ttnPresent) : "", note: r.saved?.note ?? "" }])));
    }).catch((e) => setErr(hiringError(e)));
  }, [month, nonce]);

  const save = async (r: BaTtnRow) => {
    const d = draft[r.managerId];
    const present = Number(d?.present);
    if (d?.present === "" || !Number.isInteger(present) || present < 0) { toast("Наявні ТТН — ціле невідʼємне число", { error: true }); return; }
    setBusy(r.managerId);
    try { await saveBaTtn(month, r.managerId, { ttnPresent: present, note: d.note }); toast(`Збережено: ${r.name}, ${ymName(month)}`); setNonce((n) => n + 1); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(null); }
  };

  const norm = meta.ttnNormPct;
  const savedRows = (rows ?? []).filter((r) => r.saved);
  const totNeeded = savedRows.reduce((s, r) => s + r.saved!.dealsNeeded, 0);
  const totPresent = savedRows.reduce((s, r) => s + r.saved!.ttnPresent, 0);
  const totPct = pctOf(totPresent, totNeeded);
  return (
    <div className="hr-card">
      <div className="hd">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="hr-nav" aria-label="Попередній місяць" onClick={() => setMonth((m) => shift(m, -1))}>‹</button>
          <b style={{ minWidth: 140, textAlign: "center" }}>{ymName(month)}</b>
          <button className="hr-nav" aria-label="Наступний місяць" onClick={() => setMonth((m) => shift(m, 1))}>›</button>
          {month !== meta.ttnDefaultMonth && <button className="hr-link" onClick={() => setMonth(meta.ttnDefaultMonth)}>до місяця перевірки</button>}
        </div>
        <span>{rows && (savedRows.length
          ? <>Перевірено {savedRows.length} з {rows.length} · разом <b>{totPresent}</b> з <b>{totNeeded}</b> · <b style={{ color: totPct != null && totPct < norm ? "var(--danger)" : undefined }}>{totPct == null ? "—" : `${totPct}%`}</b></>
          : <span className="hr-muted">Місяць ще не перевірено</span>)}</span>
      </div>
      {err && <div className="hr-sect" style={{ color: "var(--danger)" }}>{err}</div>}
      {!rows && !err && <p className="loading-text" style={{ padding: 16 }}>Завантаження…</p>}
      {rows && (
        <div className="hr-tw">
          <table className="hr-table">
            <thead><tr><th>Менеджер</th><th className="num">Угод, де потрібна ТТН</th><th>Наявні ТТН</th><th>% відповідності</th><th>Динаміка · 6 міс.</th><th>Примітка</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const d = draft[r.managerId] ?? { present: "", note: "" };
                const needed = r.saved?.dealsNeeded ?? r.dealsNow;
                const pct = d.present === "" ? null : pctOf(Number(d.present), needed);
                const drift = r.saved && r.saved.dealsNeeded !== r.dealsNow;
                return (
                  <tr key={r.managerId}>
                    <td><b>{r.name}</b>{!r.active && <><br /><span className="hr-muted">неактивний</span></>}</td>
                    <td className="num">
                      <b>{needed}</b>
                      {drift && <><br /><span className="hr-muted" title="Число зафіксовано на момент перевірки; CRM відтоді змінилась">зараз у CRM {r.dealsNow}</span></>}
                      {r.kommoUrl && <><br /><a className="hr-link" href={r.kommoUrl} target="_blank" rel="noopener noreferrer">фільтр у Kommo ↗</a></>}
                    </td>
                    <td>
                      <input className="hr-inp" style={{ width: 80 }} type="number" min={0} max={needed} inputMode="numeric" aria-label={`Наявні ТТН · ${r.name}`}
                        value={d.present} onChange={(e) => setDraft((x) => ({ ...x, [r.managerId]: { ...d, present: e.target.value } }))} />
                    </td>
                    <td>
                      {pct == null ? <span className="hr-muted">—</span> : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
                          <div className="hr-bar" style={{ flex: 1, marginTop: 0 }}><i style={{ width: `${Math.min(100, pct)}%`, background: pct < norm ? "var(--danger)" : "var(--ok)" }} /></div>
                          <b style={{ color: pct < norm ? "var(--danger)" : "var(--ok)" }}>{pct}%</b>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="hr-trend" style={{ height: 28, minWidth: 90 }}>
                        {r.history.map((h, i) => (
                          <i key={h.month} className={i === r.history.length - 1 ? "last" : ""} title={`${ymName(h.month)}: ${h.pct == null ? "не перевірено" : `${h.pct}%`}`}
                            style={{ height: `${h.pct == null ? 3 : Math.max(3, Math.round(Math.min(100, h.pct) * 0.28))}px`, background: h.pct == null ? undefined : h.pct < norm ? "var(--danger)" : "var(--ok)" }} />
                        ))}
                      </div>
                    </td>
                    <td><input className="hr-inp" placeholder="напр., маршрут не збігся" value={d.note} onChange={(e) => setDraft((x) => ({ ...x, [r.managerId]: { ...d, note: e.target.value } }))} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="hr-btn xs p" disabled={busy === r.managerId} onClick={() => void save(r)}>Зберегти</button>
                      {r.saved && <><br /><span className="hr-muted">{fmtTs(r.saved.checkedAt)}{r.saved.checkedBy ? ` · ${r.saved.checkedBy}` : ""}</span></>}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="hr-muted" style={{ padding: 16 }}>У цьому місяці в CRM немає успішних безготівкових угод — перевіряти нема що.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="hr-sect hr-muted">
        «Угод, де потрібна ТТН» — успішні безготівкові угоди (з ПДВ і без), закриті в цьому місяці, по відповідальному — рівно фільтр у Kommo.
        «Наявні» вносяться вручну після перевірки маршруту. Норма — {norm}%, нижче — червоним. Число угод фіксується на момент збереження.
      </div>
    </div>
  );
}
