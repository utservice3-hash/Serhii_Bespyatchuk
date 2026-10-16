import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchCarrierPayments, runCarrierPayments, downloadCarrierPaymentsXlsx, type PayScreenDay, type PayScreenRow } from "../../../api";
import { getAuthPayload } from "../../../auth";
import { useToast } from "../../../components/Toasts";

/**
 * 💸 «Оплати перевізникам» (16.10.2026): файл на оплату (формат «Обработка выгрузки» Тетяни) + усі запити з її фільтра
 * з рішенням системи, причиною і статусом у Kommo; розбіжність — «перевірити», а запит закрито «Оплачено» (або навпаки).
 * Номери карток → лише `view_private_finance` (Адмін, фінансист); право тут — косметика, сервер гейтить роути сам.
 * Система нічого не закриває в Kommo: це порадник.
 */
const MUTED = "var(--text-muted)";
const money = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("uk-UA").replace(/ /g, " "));
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const prevDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
const KOMMO_WORD = { paid: "оплачено", rejected: "відмовлено", open: "висить" } as const;
const BASIS = (r: PayScreenRow) => (r.paidBy === "1С" ? "оплата є — галочка 1С" : r.paidBy === "Виписка" ? "оплата є — у Виписці" : "у межах ліміту");
type Filter = "all" | "ok" | "check" | "diff";
const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

/** «Копіювати для файлу»: рядки «До оплати» табуляцією — вставляються в Google-таблицю рівно в колонки файлу Тетяни. */
export const tsvOf = (rows: PayScreenRow[]) =>
  rows.filter((r) => r.ok).map((r) => [r.mainId ?? "", r.card, r.owner, r.amount ?? 0, r.category].map((v) => String(v).replace(/[\t\n\r]+/g, " ")).join("\t")).join("\n");

export function FinancePaymentsTab() {
  const canView = (getAuthPayload()?.perms ?? []).includes("view_private_finance");
  const toast = useToast();
  const [day, setDay] = useState<string | undefined>(undefined);
  const [data, setData] = useState<PayScreenDay | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!canView) return;
    fetchCarrierPayments(day).then((d) => { setData(d); setErr(null); }).catch((e) => setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося завантажити"));
  }, [canView, day]);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => (data?.rows ?? []).filter((r) => filter === "all" || (filter === "ok" ? r.ok : filter === "check" ? !r.ok : r.diff)), [data, filter]);

  if (!canView) return <div className="chart-card"><b>Оплати перевізникам</b> <span className="hr-muted">Бачать лише Адмін і фінансист: тут номери карток отримувачів.</span></div>;
  if (err && !data) return <div className="chart-card"><b>Оплати перевізникам</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Завантаження…</p>;

  const ok = data.rows.filter((r) => r.ok);
  const run = async () => {
    setBusy(true);
    try { await runCarrierPayments(); toast("Файл перераховано", { tone: "ok" }); load(); }
    catch (e) { toast(`Не перераховано: ${(e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "помилка"}`, { error: true }); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(tsvOf(data.rows)); toast(`Скопійовано ${ok.length} рядків для файлу`, { tone: "ok" }); }
    catch { toast("Не вдалося скопіювати", { error: true }); }
  };
  const excel = async () => {
    try {
      const { blob, filename } = await downloadCarrierPaymentsXlsx(data.day);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    } catch { toast("Excel не завантажено", { error: true }); }
  };
  const link = (id: number | null) => (id ? <a href={`${data.kommoBase}/leads/detail/${id}`} target="_blank" rel="noreferrer">{id}</a> : "—");
  const tile = (label: string, value: string, color?: string, sub?: string) => (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px" }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED }}>{sub}</div>}
    </div>
  );
  const dayOptions = [...new Set([data.today, data.day, ...data.days.map((d) => d.day)])].sort().reverse();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <select className="hr-inp" aria-label="День файлу" value={data.day} onChange={(e) => setDay(e.target.value)}>
          {dayOptions.map((d) => <option key={d} value={d}>Файл на {dm(d)} (запити {dm(prevDay(d))} 17:00 – {dm(d)} 17:00){d === data.today ? " · поточний" : ""}</option>)}
        </select>
        <span style={{ fontSize: 13, color: MUTED }}>Сформовано {hhmm(data.at)}</span>
        {data.day === data.today && <button className="hr-btn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void run()}>{busy ? "Рахую…" : "↻ Оновити зараз"}</button>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        {tile("Запитів у фільтрі", String(data.totals.total))}
        {tile("До оплати", String(data.totals.ok), "#16a34a", `${money(data.totals.okSum)} ₴`)}
        {tile("На перевірку", String(data.totals.check), "#b45309")}
        {tile("Розбіжності з Kommo", String(data.totals.diff), data.totals.diff ? "#dc2626" : undefined)}
      </div>

      <div className="chart-card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 className="chart-title" style={{ margin: 0 }}>До оплати</h3>
          <span style={{ fontSize: 12, color: MUTED }}>у форматі файлу «Обработка выгрузки»</span>
          <button className="hr-btn" style={{ marginLeft: "auto" }} onClick={() => void copy()} disabled={!ok.length}>Копіювати для файлу</button>
          <button className="hr-btn" onClick={() => void excel()}>⬇ Excel</button>
        </div>
        {!ok.length ? <p className="hr-muted" style={{ margin: 0 }}>Затверджених запитів поки немає.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="hr-table" style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th>ID</th><th>Номер карти</th><th>Власник карти</th><th style={{ textAlign: "right" }}>{money(data.totals.okSum)}</th><th>Категорії</th></tr></thead>
              <tbody>{ok.map((r) => <tr key={r.requestId}><td>{link(r.mainId)}</td><td style={{ whiteSpace: "nowrap" }}>{r.card}</td><td>{r.owner}</td><td style={{ textAlign: "right" }}>{money(r.amount)}</td><td>{r.category}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="chart-card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 className="chart-title" style={{ margin: 0, marginRight: "auto" }}>Усі запити</h3>
          {([["all", `Усі ${data.totals.total}`], ["ok", `До оплати ${data.totals.ok}`], ["check", `На перевірку ${data.totals.check}`], ["diff", `Розбіжності ${data.totals.diff}`]] as [Filter, string][]).map(([k, l]) => (
            <button key={k} className={`hr-btn${filter === k ? " p" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {!shown.length ? <p className="hr-muted" style={{ margin: 0 }}>Немає запитів у цьому фільтрі.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="hr-table" style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th>Угода · запит</th><th>Подано</th><th>Отримувач</th><th style={{ textAlign: "right" }}>Сума</th><th>Система</th><th>Підстава / причина</th><th>Kommo зараз</th></tr></thead>
              <tbody>{shown.map((r) => (
                <tr key={r.requestId} style={r.diff ? { background: "rgba(220,38,38,0.08)" } : undefined}>
                  <td style={{ whiteSpace: "nowrap" }}>{link(r.mainId)}<div style={{ fontSize: 11.5, color: MUTED }}>запит {link(r.requestId)}</div></td>
                  <td style={{ whiteSpace: "nowrap" }}>{hhmm(r.createdAt)}</td>
                  <td>{r.owner || <span style={{ color: MUTED }}>не вказано</span>}<div style={{ fontSize: 11.5, color: MUTED, whiteSpace: "nowrap" }}>{r.card || "картка не вказана"}</div></td>
                  <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                  <td>{r.ok ? <span style={pill("rgba(22,163,74,0.14)", "#16a34a")}>до оплати</span> : <span style={pill("rgba(217,119,6,0.14)", "#b45309")}>перевірити</span>}</td>
                  <td>{r.ok ? BASIS(r) : r.reasons.join("; ")}{r.notes.length > 0 && <div style={{ fontSize: 11.5, color: MUTED }}>{r.notes.join("; ")}</div>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span style={r.kommo === "paid" ? pill("rgba(22,163,74,0.14)", "#16a34a") : r.kommo === "rejected" ? pill("rgba(220,38,38,0.12)", "#dc2626") : pill("var(--hover-bg, rgba(0,0,0,0.05))", "var(--text-muted)")}>{KOMMO_WORD[r.kommo]}</span>
                    {r.diff && <div style={{ fontSize: 11.5, color: "#dc2626", marginTop: 3 }}>⚠ розбіжність</div>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

      {data.days.length > 0 && (
        <div className="chart-card">
          <h3 className="chart-title" style={{ marginTop: 0 }}>Останні дні</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {data.days.map((d) => (
              <button key={d.day} className={`hr-btn${d.day === data.day ? " p" : ""}`} onClick={() => setDay(d.day)}>
                {dm(d.day)} · {d.total} · до оплати {d.ok} на {money(d.okSum)}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="hr-muted" style={{ fontSize: 12, marginTop: 10 }}>🔒 Бачать лише Адмін і фінансист. Система нічого не закриває в Kommo — рішення за фінансистом.</p>
    </div>
  );
}
