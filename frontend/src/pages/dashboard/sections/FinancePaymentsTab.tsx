import { useCallback, useEffect, useState } from "react";
import { fetchCarrierPayments, runCarrierPayments, downloadCarrierPaymentsXlsx, markCarrierPayment, type PayScreenDay, type PayScreenRow } from "../../../api";
import { useDialogs } from "../../../components/Dialogs";
import { getAuthPayload } from "../../../auth";
import { useToast } from "../../../components/Toasts";

/**
 * 💸 «Оплати перевізникам» (16.10.2026). Головне — ФІЛЬТР Тетяни в Kommo (Роман: «угоди, які досі у фільтрі, мають
 * підсвічуватися; ті, що вже не в фільтрі, — архів; немає активних — пусто»):
 *  · «У фільтрі зараз» — запити, що прямо зараз у її фільтрі, з рішенням системи і кнопкою на сам запит у Kommo;
 *  · «До оплати» — файл «Обработка выгрузки» лише із затверджених у фільтрі (копіювати / Excel);
 *  · «Архів» — запити, ЗАКРИТІ в Kommo цього дня (за Києвом, хоч би коли подані; Тетяна 20.10.2026): перекреслені, з етапом
 *    і розбіжностями; що вийшло з фільтра без закриття — у дні свого файлу.
 * Номери карток → лише `view_private_finance` (Адмін, фінансист). Система нічого не закриває в Kommo.
 */
const MUTED = "var(--text-muted)";
const money = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("uk-UA").replace(/ /g, " "));
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const BASIS = (r: PayScreenRow) => (r.paidBy === "вручну" ? `погоджено вручну — ${r.manual?.by ?? "?"}${r.manual?.at ? `, ${hhmm(r.manual.at)}` : ""}` : r.paidBy === "1С" ? "оплата є — галочка 1С" : r.paidBy === "Виписка" ? "оплата є — у Виписці" : "у межах ліміту");
const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });
/** Закритий у Kommo запит («Оплачено» / «Отказано») — перекреслений і приглушений (Роман 16.10.2026). */
const closedStyle = (r: PayScreenRow): React.CSSProperties | undefined =>
  r.kommo === "open" ? undefined : { textDecoration: "line-through", color: "var(--text-muted)" };

/** «Копіювати для файлу»: рядки «До оплати» табуляцією — вставляються в Google-таблицю рівно в колонки файлу Тетяни. */
export const tsvOf = (rows: PayScreenRow[]) =>
  rows.filter((r) => r.ok).map((r) => [r.mainId ?? "", r.card, r.owner, r.amount ?? 0, r.category].map((v) => String(v).replace(/[\t\n\r]+/g, " ")).join("\t")).join("\n");

export function FinancePaymentsTab() {
  const canView = (getAuthPayload()?.perms ?? []).includes("view_private_finance");
  const toast = useToast();
  const dlg = useDialogs();
  const [day, setDay] = useState<string | undefined>(undefined);
  const [data, setData] = useState<PayScreenDay | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!canView) return;
    fetchCarrierPayments(day).then((d) => { setData(d); setErr(null); }).catch((e) => setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося завантажити"));
  }, [canView, day]);
  useEffect(() => { load(); }, [load]);

  if (!canView) return <div className="chart-card"><b>Оплати перевізникам</b> <span className="hr-muted">Бачать лише Адмін і фінансист: тут номери карток отримувачів.</span></div>;
  if (err && !data) return <div className="chart-card"><b>Оплати перевізникам</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Завантаження…</p>;

  const ok = data.active.filter((r) => r.ok);
  const run = async () => {
    setBusy(true);
    try { await runCarrierPayments(); toast("Фільтр перевірено", { tone: "ok" }); load(); }
    catch (e) { toast(`Не перевірено: ${(e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "помилка"}`, { error: true }); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(tsvOf(data.active)); toast(`Скопійовано ${ok.length} рядків для файлу`, { tone: "ok" }); }
    catch { toast("Не вдалося скопіювати", { error: true }); }
  };
  const excel = async () => {
    try {
      const { blob, filename } = await downloadCarrierPaymentsXlsx(data.day);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    } catch { toast("Excel не завантажено", { error: true }); }
  };
  const link = (id: number | null) => (id ? <a href={`${data.kommoBase}/leads/detail/${id}`} target="_blank" rel="noreferrer">{id}</a> : "—");
  const openReq = (r: PayScreenRow) => (
    <a className="hr-btn" style={{ whiteSpace: "nowrap", textDecoration: "none" }} href={`${data.kommoBase}/leads/detail/${r.requestId}`} target="_blank" rel="noreferrer">Відкрити запит →</a>
  );
  const stagePill = (r: PayScreenRow) => (
    <span style={r.kommo === "paid" ? pill("rgba(22,163,74,0.14)", "#16a34a") : r.kommo === "rejected" ? pill("rgba(220,38,38,0.12)", "#dc2626") : pill("rgba(37,99,235,0.10)", "#2563eb")}>{r.stage}</span>
  );
  const decision = (r: PayScreenRow) => (r.pending ? <span style={pill("rgba(0,0,0,0.06)", MUTED)}>ще не перевірено</span>
    : r.paidBy === "вручну" ? <span style={pill("rgba(37,99,235,0.12)", "#2563eb")}>погоджено</span>
    : r.ok ? <span style={pill("rgba(22,163,74,0.14)", "#16a34a")}>до оплати</span> : <span style={pill("rgba(217,119,6,0.14)", "#b45309")}>перевірити</span>);
  // Погоджений вручну: підстава — хто погодив, а причина СИСТЕМИ лишається видно під нею.
  const why = (r: PayScreenRow) => (<>{r.ok ? BASIS(r) : r.reasons.join("; ")}
    {r.paidBy === "вручну" && r.reasons.length > 0 && <div style={{ fontSize: 11.5, color: MUTED }}>система: {r.reasons.join("; ")}</div>}
    {r.notes.length > 0 && <div style={{ fontSize: 11.5, color: MUTED }}>{r.notes.join("; ")}</div>}
    {r.comment && <div style={{ fontSize: 12, marginTop: 2 }}>💬 {r.comment}{r.commentBy && <span style={{ color: MUTED }}> — {r.commentBy}</span>}</div>}</>);
  // ✋ «Погоджено» (Тетяна 26.10.2026): лише для «перевірити»; коментар необовʼязковий. Погоджується сума, що зараз у запиті.
  const mark = async (body: { requestId: number; approved?: boolean; comment?: string | null }, ok: string) => {
    try { await markCarrierPayment(body); toast(ok, { tone: "ok" }); load(); }
    catch (e) { toast(`Не збережено: ${(e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "помилка"}`, { error: true }); }
  };
  const approve = async (r: PayScreenRow) => {
    const c = await dlg.prompt({ title: `Погодити запит ${r.requestId} на ${money(r.amount)} ₴?`, label: "Коментар (необовʼязково)", initial: r.comment ?? "", okLabel: "Погоджено", multiline: true });
    if (c === null) return;
    await mark({ requestId: r.requestId, approved: true, comment: c }, "Погоджено — запит у «До оплати»");
  };
  const unapprove = async (r: PayScreenRow) => {
    if (!(await dlg.confirm({ title: "Скасувати погодження?", text: `Запит ${r.requestId} повернеться в «перевірити». Коментар лишиться.`, okLabel: "Скасувати погодження" }))) return;
    await mark({ requestId: r.requestId, approved: false }, "Погодження знято — запит знову «перевірити»");
  };
  const comment = async (r: PayScreenRow) => {
    const c = await dlg.prompt({ title: `Коментар до запиту ${r.requestId}`, label: "Коментар (порожньо — прибрати)", initial: r.comment ?? "", multiline: true });
    if (c === null) return;
    await mark({ requestId: r.requestId, comment: c }, c.trim() ? "Коментар збережено" : "Коментар прибрано");
  };
  const actions = (r: PayScreenRow) => (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {!r.pending && !r.ok && <button className="hr-btn p" style={{ whiteSpace: "nowrap" }} onClick={() => void approve(r)} title="Перенести в «До оплати» — рішення людини поверх системи">✓ Погоджено</button>}
      {r.paidBy === "вручну" && <button className="hr-btn" style={{ whiteSpace: "nowrap" }} onClick={() => void unapprove(r)}>Скасувати</button>}
      <button className="hr-btn" onClick={() => void comment(r)} title={r.comment ? "Змінити коментар" : "Додати коментар"} aria-label="Коментар">💬</button>
    </span>
  );
  const tile = (label: string, value: string, color?: string, sub?: string) => (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px" }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED }}>{sub}</div>}
    </div>
  );
  const dayOptions = [...new Set([data.todayCal, data.day, ...data.days.map((d) => d.day)])].filter((d) => d <= data.todayCal).sort().reverse();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: MUTED }}>Фільтр Тетяни в Kommo · рішення перевірено {hhmm(data.at)}</span>
        <button className="hr-btn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void run()}>{busy ? "Перевіряю…" : "↻ Перевірити зараз"}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        {tile("У фільтрі зараз", String(data.totals.active), data.totals.active ? "#2563eb" : undefined)}
        {tile("До оплати", String(data.totals.activeOk), "#16a34a", `${money(data.totals.activeOkSum)} ₴`)}
        {tile("Перевірити", String(data.totals.activeCheck), data.totals.activeCheck ? "#b45309" : undefined, data.totals.pending ? `ще не перевірено: ${data.totals.pending}` : undefined)}
        {tile(`Архів за ${dm(data.day)}`, String(data.totals.archive), undefined, data.totals.diff ? `розбіжностей: ${data.totals.diff}` : undefined)}
      </div>

      <div className="chart-card" style={{ marginBottom: 14, border: "2px solid #2563eb" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 className="chart-title" style={{ margin: 0 }}>У фільтрі зараз · {data.active.length}</h3>
          <span style={{ fontSize: 12, color: MUTED }}>розібрав запит — відкрий його й зміни етап; після цього він піде в архів</span>
        </div>
        {!data.active.length ? <p className="hr-muted" style={{ margin: "8px 0" }}>У фільтрі зараз немає запитів — усе розібрано.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="hr-table" style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th>Угода</th><th>Подано</th><th>Отримувач</th><th style={{ textAlign: "right" }}>Сума</th><th>Система</th><th>Підстава / причина</th><th>Етап</th><th /></tr></thead>
              <tbody>{data.active.map((r) => (
                <tr key={r.requestId} style={r.ok ? { background: "rgba(22,163,74,0.06)" } : undefined}>
                  <td style={{ whiteSpace: "nowrap" }}>{link(r.mainId)}<div style={{ fontSize: 11.5, color: MUTED }}>запит {link(r.requestId)}</div></td>
                  <td style={{ whiteSpace: "nowrap" }}>{hhmm(r.createdAt)}</td>
                  <td>{r.owner || <span style={{ color: MUTED }}>не вказано</span>}<div style={{ fontSize: 11.5, color: MUTED, whiteSpace: "nowrap" }}>{r.card || "картка не вказана"}</div></td>
                  <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                  <td>{decision(r)}</td>
                  <td>{why(r)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{stagePill(r)}</td>
                  <td style={{ textAlign: "right" }}><div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>{actions(r)}{openReq(r)}</div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="chart-card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 className="chart-title" style={{ margin: 0 }}>До оплати · {ok.length}</h3>
          <span style={{ fontSize: 12, color: MUTED }}>затверджені з фільтра, у форматі «Обработка выгрузки»</span>
          <button className="hr-btn" style={{ marginLeft: "auto" }} onClick={() => void copy()} disabled={!ok.length}>Копіювати для файлу</button>
          <button className="hr-btn" onClick={() => void excel()}>⬇ Excel</button>
        </div>
        {!ok.length ? <p className="hr-muted" style={{ margin: 0 }}>У фільтрі зараз немає затверджених запитів.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="hr-table" style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th>ID</th><th>Номер карти</th><th>Власник карти</th><th style={{ textAlign: "right" }}>{money(data.totals.activeOkSum)}</th><th>Категорії</th></tr></thead>
              <tbody>{ok.map((r) => <tr key={r.requestId}><td>{link(r.mainId)}</td><td style={{ whiteSpace: "nowrap" }}>{r.card}</td><td>{r.owner}</td><td style={{ textAlign: "right" }}>{money(r.amount)}</td><td>{r.category}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="chart-card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h3 className="chart-title" style={{ margin: 0 }}>Архів · {data.archive.length}</h3>
          <span style={{ fontSize: 12, color: MUTED }}>закриті в Kommo {dm(data.day)} — хоч би коли їх подали; що вийшло з фільтра без закриття — у день свого файлу</span>
          <select className="hr-inp" style={{ marginLeft: "auto" }} aria-label="День архіву" value={data.day} onChange={(e) => setDay(e.target.value)}>
            {dayOptions.map((d) => <option key={d} value={d}>{dm(d)}{d === data.todayCal ? " · сьогодні" : ""}</option>)}
          </select>
        </div>
        {!data.archive.length ? <p className="hr-muted" style={{ margin: 0 }}>За цей день в архіві нічого немає.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="hr-table" style={{ width: "100%", fontSize: 13 }}>
              <thead><tr><th>Угода · запит</th><th>Отримувач</th><th style={{ textAlign: "right" }}>Сума</th><th>Система</th><th>Підстава / причина</th><th>Етап у Kommo</th></tr></thead>
              <tbody>{data.archive.map((r) => (
                <tr key={r.requestId} style={{ ...closedStyle(r), ...(r.diff ? { background: "rgba(220,38,38,0.08)" } : {}) }}>
                  <td style={{ whiteSpace: "nowrap" }}>{link(r.mainId)}<div style={{ fontSize: 11.5 }}>запит {link(r.requestId)}</div></td>
                  <td>{r.owner}<div style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{r.card}</div></td>
                  <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                  <td>{decision(r)}</td>
                  <td>{why(r)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{stagePill(r)}{r.diff && <div style={{ fontSize: 11.5, color: "#dc2626", marginTop: 3, textDecoration: "none" }}>⚠ розбіжність</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      <p className="hr-muted" style={{ fontSize: 12, marginTop: 10 }}>🔒 Бачать лише Адмін і фінансист. Система нічого не закриває в Kommo — рішення за фінансистом.</p>
    </div>
  );
}
