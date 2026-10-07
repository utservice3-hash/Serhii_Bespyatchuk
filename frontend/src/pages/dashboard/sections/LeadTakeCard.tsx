import { useEffect, useState } from "react";
import {
  fetchLeadTake, fetchLeadTakeDeals, downloadLeadTakeXlsx,
  type LeadTakeTable, type LeadTakeRow, type LeadTakeDeal, type LeadTakeSource, type LeadTakeTime, type LeadTakeColumn,
} from "../../../api";
import { todayKyiv } from "../periodRules";

/**
 * ⏱ ВІКНО «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ» (ТЗ Юлії 24.09.2026). Щодня відповідає на три питання: хто порушує
 * норматив, скільки заявок ми через це втратили і по якому джерелу.
 *
 * Числа рахує сервер (`core/leadTake.ts`); тут лише показ. Клік по будь-якій цифрі відкриває угоди, які дали
 * САМЕ цю цифру (той самий відбір на сервері). Червоне — гірше за норматив: «до 1 хв» < 90%, «до 5 хв» < 100%,
 * «не взято» > 0.
 */
const RED_BG = "rgba(220,38,38,0.10)", RED_FG = "#dc2626", MUTED = "var(--text-muted)";

/**
 * 🎨 ВИГЛЯД (06.10.2026, Роман: «це погано виглядає, пофікси»). Було: кожна клітинка гірша за норматив — червоним
 * ФОНОМ, а «до 1 хв» не досягає 90% майже ні в кого, тож клітинки злипались у суцільні рожеві стовпці й червоне
 * перестало щось означати; плюс пунктир під кожним числом. Стало: у рядках менеджерів червоне — лише ТЕКСТОМ, фон
 * лишився тільки в рядках команди й відділу (там він і має кричати); число клікабельне без постійного підкреслення;
 * нулі сірі; норматив — у шапці колонки, а не окремим рядком унизу. Жодне число не змінилось — лише показ.
 */
const LT_CSS = `
.lt-tbl{font-variant-numeric:tabular-nums}
.lt-tbl th{text-align:right;white-space:nowrap;vertical-align:bottom;padding-left:14px}
.lt-tbl td{padding-left:14px;white-space:nowrap}
.lt-tbl td:first-child{white-space:normal;min-width:170px}
.lt-tbl th:first-child{text-align:left}
.lt-tbl .lt-norm{display:block;font-size:10.5px;font-weight:500;color:var(--text-muted);margin-top:1px}
.lt-tbl td{padding-top:6px;padding-bottom:6px}
.lt-tbl tr.lt-team td{background:rgba(127,127,127,0.07);font-weight:700;border-top:1px solid var(--border)}
.lt-tbl tr.lt-dept td{background:rgba(99,102,241,0.09);font-weight:700;border-top:2px solid var(--border)}
.lt-tbl tr.lt-mgr td:first-child{padding-left:22px}
.lt-tbl .lt-zero{color:var(--text-muted)}
.lt-tbl .lt-bad{color:${RED_FG};font-weight:700}
.lt-tbl tr.lt-team td.lt-badbg,.lt-tbl tr.lt-dept td.lt-badbg{background:${RED_BG}}
.lt-tbl .lt-link{all:unset;cursor:pointer;border-radius:3px}
.lt-tbl .lt-link:hover,.lt-tbl .lt-link:focus-visible{text-decoration:underline;color:#2f6fdb}
`;

function weekOf(ymd: string, offset: number): { from: string; to: string } {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow - 1) + offset * 7);
  const e = new Date(d); e.setUTCDate(e.getUTCDate() + 6);
  return { from: d.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
}

const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);
const fmtMin = (v: number | null) => (v == null ? "—" : `${v} хв`);
const fmtUah = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("uk-UA")} ₴`);
const fmtDt = (iso: string | null) => (iso == null ? "—"
  : new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));

const SOURCES: [LeadTakeSource, string][] = [["all", "Все"], ["ad", "Реклама"], ["leadgen", "Лідгени"], ["site", "Сайт"]];
const TIMES: [LeadTakeTime, string][] = [["work", "Робочий"], ["off", "Неробочий"], ["all", "Все"]];

export function LeadTakeCard({ from: initFrom, to: initTo, teamId }: { from: string; to: string; teamId?: number }) {
  const [period, setPeriod] = useState({ from: initFrom, to: initTo });
  useEffect(() => { setPeriod({ from: initFrom, to: initTo }); }, [initFrom, initTo]);
  const [source, setSource] = useState<LeadTakeSource>("all");
  const [campaign, setCampaign] = useState("");
  const [time, setTime] = useState<LeadTakeTime>("all");
  const [data, setData] = useState<LeadTakeTable | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<{ title: string; deals: LeadTakeDeal[] | null } | null>(null);
  const params = { from: period.from, to: period.to, source, time, campaign: source === "ad" && campaign ? campaign : undefined, teamId };

  useEffect(() => {
    let alive = true;
    setBusy(true); setErr(null);
    fetchLeadTake(params)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e?.response?.data?.error ?? "Не вдалось завантажити"); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.from, period.to, source, campaign, time, teamId]);

  const open = (row: LeadTakeRow, col: LeadTakeColumn, what: string) => {
    setDrill({ title: `${row.label} · ${what}`, deals: null });
    fetchLeadTakeDeals({ ...params, row: row.key, col })
      .then((deals) => setDrill({ title: `${row.label} · ${what}`, deals }))
      .catch(() => setDrill({ title: `${row.label} · ${what}`, deals: [] }));
  };

  const today = todayKyiv();
  const btn = (active: boolean) => ({ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)",
    background: active ? "#2f6fdb" : "transparent", color: active ? "#fff" : "inherit", cursor: "pointer", fontSize: 12.5 });
  const thisW = weekOf(today, 0), lastW = weekOf(today, -1);
  const isW = (w: { from: string; to: string }) => w.from === period.from && w.to === period.to;

  const cell = (row: LeadTakeRow, col: LeadTakeColumn, text: string, red: boolean, what: string, count: number) => {
    const zero = !red && (text === "0" || text === "0%");
    return (
      <td style={{ textAlign: "right" }} className={[red ? "lt-bad lt-badbg" : "", zero ? "lt-zero" : ""].join(" ").trim() || undefined}
        title={red ? "Гірше за норматив" : undefined}>
        {count > 0 ? <button className="lt-link" onClick={() => open(row, col, what)} title="Показати угоди">{text}</button> : text}
      </td>
    );
  };
  const cnt = (r: LeadTakeRow, pct: number | null) => (pct == null ? 0 : Math.round((pct / 100) * r.n));

  return (
    <div className="chart-card" style={{ marginBottom: 16, borderLeft: "4px solid #6366f1" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="chart-title" style={{ margin: 0 }}>⏱ Час опрацювання заявки</h2>
        <button style={btn(false)} disabled={busy || !data} onClick={() => downloadLeadTakeXlsx(params).catch(() => setErr("Не вдалось вивантажити"))}>
          ⬇ Excel
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "10px 0 6px", fontSize: 12.5 }}>
        <span style={{ color: MUTED }}>Період:</span>
        <button style={btn(isW(thisW))} onClick={() => setPeriod(thisW)}>Цей тиждень</button>
        <button style={btn(isW(lastW))} onClick={() => setPeriod(lastW)}>Минулий тиждень</button>
        <input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && setPeriod({ ...period, from: e.target.value })} />
        <span>–</span>
        <input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && setPeriod({ ...period, to: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontSize: 12.5 }}>
        <span style={{ color: MUTED }}>Джерело:</span>
        {SOURCES.map(([k, l]) => <button key={k} style={btn(source === k)} onClick={() => { setSource(k); setCampaign(""); }}>{l}</button>)}
        {source === "ad" && (
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)} style={{ fontSize: 12.5 }}>
            <option value="">усі кампанії</option>
            {(data?.campaigns ?? []).map((c) => <option key={c.campaign} value={c.campaign}>{c.campaign} ({c.n})</option>)}
            {campaign && !(data?.campaigns ?? []).some((c) => c.campaign === campaign) && <option value={campaign}>{campaign}</option>}
          </select>
        )}
        <span style={{ color: MUTED, marginLeft: 12 }}>Час:</span>
        {TIMES.map(([k, l]) => <button key={k} style={btn(time === k)} onClick={() => setTime(k)}>{l}</button>)}
      </div>

      {err && <p style={{ color: RED_FG, fontSize: 12.5 }}>{err}</p>}
      {busy && !data && <p className="loading-text">Завантаження…</p>}
      {data && (
        <div style={{ overflowX: "auto", opacity: busy ? 0.6 : 1 }}>
          <style>{LT_CSS}</style>
          <table className="data-table lt-tbl" style={{ width: "100%", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th>Менеджер</th><th>Заявок</th>
                <th>до 1 хв<span className="lt-norm">норма ≥ {data.norm.m1Pct}%</span></th>
                <th>до 5 хв<span className="lt-norm">норма {data.norm.m5Pct}%</span></th>
                <th>5–30</th><th>30–60</th><th>&gt;1 год</th>
                <th>Не взято<span className="lt-norm">норма {data.norm.notTaken}</span></th>
                <th>Медіана</th><th>Повільні<span className="lt-norm">без результату</span></th><th>Втрати, ₴</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                return (
                  <tr key={r.key} className={r.kind === "manager" ? "lt-mgr" : r.kind === "dept" ? "lt-dept" : "lt-team"}>
                    <td>{r.label}</td>
                    {cell(r, "all", String(r.n), false, "усі заявки", r.n)}
                    {cell(r, "m1", fmtPct(r.m1Pct), r.red.m1, "взято до 1 хв", cnt(r, r.m1Pct))}
                    {cell(r, "m5", fmtPct(r.m5Pct), r.red.m5, "взято до 5 хв", cnt(r, r.m5Pct))}
                    {cell(r, "m30", fmtPct(r.m30Pct), false, "взято за 5–30 хв", cnt(r, r.m30Pct))}
                    {cell(r, "m60", fmtPct(r.m60Pct), false, "взято за 30–60 хв", cnt(r, r.m60Pct))}
                    {cell(r, "h1", fmtPct(r.h1Pct), false, "взято понад годину", cnt(r, r.h1Pct))}
                    {cell(r, "none", String(r.notTaken), r.red.notTaken, "не взято", r.notTaken)}
                    <td style={{ textAlign: "right" }}>{fmtMin(r.medianMin)}</td>
                    {cell(r, "slowLost", String(r.slowLost), false, "повільні без результату", r.slowLost)}
                    <td style={{ textAlign: "right" }}>{fmtUah(r.loss)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={{ fontSize: 11.5, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
            «Взято в роботу» — перша з подій: зміна етапу (не в закриття), вихідний дзвінок (Ringostat), поле «Взято в работу» в Kommo.
            Жодної — «не взято», навіть якщо угоду закрили. Для «Дублів» — лише дзвінок або поле: зміна етапу там часто автоматична. «До 5 хв» включає «до 1 хв». Робочий час — пн–пт 8:00–18:00; заявку з
            неробочого часу рахуємо від 08:15 наступного робочого дня (свята не враховуються). «Повільні без результату» — взято пізніше
            5 хв або не взято, і закрито «Не реалізовано». Втрати = їх кількість × середній чек рекламної угоди
            {data.avgCheck != null ? ` (${fmtUah(data.avgCheck)} — за ${data.avgCheckDeals} успішними рекламними угодами періоду)` : " (успішних рекламних угод у періоді немає — втрати не рахуються)"}.
            Реклама — заявки з uts.ua; сайт — yalogist.com.ua; лідгени — канал «лідоген». Команда — на дату заявки.
          </p>
        </div>
      )}

      {drill && (
        <div role="dialog" onClick={() => setDrill(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="chart-card"
            style={{ maxWidth: 1100, width: "100%", maxHeight: "85vh", overflow: "auto", margin: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <h3 style={{ margin: 0 }}>{drill.title}{drill.deals ? ` — ${drill.deals.length}` : ""}</h3>
              <button style={btn(false)} onClick={() => setDrill(null)}>✕</button>
            </div>
            {drill.deals == null ? <p className="loading-text">Завантаження…</p> : (
              <table className="data-table" style={{ width: "100%", fontSize: 12.5, marginTop: 10 }}>
                <thead><tr><th style={{ textAlign: "left" }}>Угода</th><th>Менеджер</th><th>Створено</th><th>Взято</th><th>Подія</th><th>Хв</th><th>Стан / причина закриття</th></tr></thead>
                <tbody>
                  {drill.deals.map((d) => (
                    <tr key={d.kommoId}>
                      <td><a href={d.url} target="_blank" rel="noreferrer">{d.name || `#${d.kommoId}`}</a></td>
                      <td>{d.manager ?? "—"}</td>
                      <td>{fmtDt(d.createdAt)}{d.offHours ? " 🌙" : ""}</td>
                      <td>{fmtDt(d.takenAt)}</td>
                      <td>{d.event ?? "не взято"}</td>
                      <td style={{ textAlign: "right" }}>{d.minutes ?? "—"}</td>
                      <td>{d.status === "won" ? "успішна" : d.status === "lost" ? `не реалізовано${d.rejectReason ? `: ${d.rejectReason}` : ""}` : "в роботі"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
