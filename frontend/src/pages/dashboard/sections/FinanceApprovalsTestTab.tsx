import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchFinApprovalsTest, type FinApprCompare, type FinApprLine, type FinApprPot, type FinApprSection } from "../../../api";
import { getAuthPayload } from "../../../auth";

/**
 * 🧪 «План/факт · авто (тест)» (Роман 20.10.2026: «паралельна таблиця план-факту, щоб розуміти різницю і що
 * виправляти»). Факт кожної статті з таблиці «UTS Утверждение оплат» (за датою оплати) поруч із тим, що внесено руками,
 * і різниця = таблиця − вручну. Нічого не змінює ні в «План/факт», ні в «Тиждень і місяць». Усе, що правило не змогло
 * віднести до статті, — окремими блоками з сумою, щоб гроші не зникали мовчки. Лише `view_private_finance`: у ЗП прізвища.
 */
const MUTED = "var(--text-muted)";
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shift = (m: string, d: number) => { const x = new Date(`${m}-15T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + d); return x.toISOString().slice(0, 7); };
const money = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));
const signed = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v));
const SEC: Record<FinApprSection, string> = { commercial: "Комерційні", admin: "Адміністративні", general: "Загальні" };
const secName = (s: string | null) => (s && s in SEC ? SEC[s as FinApprSection] : s === "payroll" ? "ЗП" : "без розділу");
const dm = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");
const hhmm = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const diffStyle = (v: number) => (Math.abs(v) < 0.005 ? { color: MUTED } : { color: "#b45309", fontWeight: 700 });

function Lines({ lines }: { lines: FinApprLine[] }) {
  return (
    <table className="hr-tw" style={{ fontSize: 12.5, margin: "4px 0 8px" }}>
      <thead><tr><th>Дата оплати</th><th>Що купили</th><th className="num">Сума</th><th>Напрямок</th><th>Оплачено</th></tr></thead>
      <tbody>{lines.map((l, i) => (
        <tr key={i}><td>{dm(l.payDate)}</td><td>{l.what || "—"}</td><td className="num">{money(l.amount)}</td><td>{l.direction || "—"}</td>
          <td style={l.paid ? undefined : { color: "#b45309" }}>{l.paid ? "так" : "ні"}</td></tr>
      ))}</tbody>
    </table>
  );
}

function Pots({ title, hint, pots }: { title: string; hint: string; pots: FinApprPot[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!pots.length) return null;
  const sum = pots.reduce((s, p) => s + p.sum, 0), rows = pots.reduce((s, p) => s + p.rows, 0);
  return (
    <div className="chart-card" style={{ marginBottom: 12 }}>
      <b>{title}</b> <span style={{ color: MUTED }}>· {rows} рядк. · {money(Math.round(sum * 100) / 100)} ₴</span>
      <div style={{ fontSize: 12.5, color: MUTED, margin: "2px 0 6px" }}>{hint}</div>
      <table className="hr-tw"><tbody>{pots.map((p) => (
        <Fragment key={p.key}>
          <tr style={{ cursor: "pointer" }} onClick={() => setOpen(open === p.key ? null : p.key)}>
            <td>{open === p.key ? "▾" : "▸"} {p.label}</td><td className="num">{p.rows} рядк.</td><td className="num">{money(p.sum)}</td>
            <td style={{ color: "#b45309" }}>{p.unpaid ? `не оплачено: ${p.unpaid}` : ""}</td>
          </tr>
          {open === p.key && <tr><td colSpan={4}><Lines lines={p.lines} /></td></tr>}
        </Fragment>
      ))}</tbody></table>
    </div>
  );
}

export function FinanceApprovalsTestTab() {
  const canView = (getAuthPayload()?.perms ?? []).includes("view_private_finance");
  const [month, setMonth] = useState(() => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7));
  const [data, setData] = useState<FinApprCompare | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback((refresh = false) => {
    if (!canView) return;
    setBusy(true);
    fetchFinApprovalsTest(month, refresh).then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося прочитати таблицю"))
      .finally(() => setBusy(false));
  }, [canView, month]);
  useEffect(() => { load(); }, [load]);

  if (!canView) return <div className="chart-card"><b>План/факт · авто (тест)</b> <span className="hr-muted">Бачать лише Адмін і фінансист: у рядках ЗП — прізвища.</span></div>;

  const items = (data?.items ?? []).filter((x) => !onlyDiff || Math.abs(x.diff) >= 0.005);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <button className="hr-btn" onClick={() => setMonth(shift(month, -1))}>‹</button>
        <b style={{ minWidth: 130, textAlign: "center" }}>{monthLabel(month)}</b>
        <button className="hr-btn" onClick={() => setMonth(shift(month, 1))}>›</button>
        <span style={{ fontSize: 13, color: MUTED }}>{data ? `таблицю прочитано ${hhmm(data.fetchedAt)} · ${data.sheetLines} рядків` : ""}</span>
        <button className="hr-btn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => load(true)}>{busy ? "Читаю…" : "↻ Оновити з таблиці"}</button>
      </div>
      <div className="chart-card" style={{ marginBottom: 12, fontSize: 13, color: MUTED }}>
        🧪 <b style={{ color: "var(--text)" }}>Тест — нічого не змінює.</b> Факт із таблиці «UTS Утверждение оплат» (вкладка «На оплату»):
        категорія = назва статті, місяць — за <b>датою оплати</b>, лише напрямок UA («Украина» до жовтня — теж UA).
        «ЗП - Комерційні / Адміністративні / Загальні» статей не мають — йдуть у розділ за назвою.
        Різниця = таблиця − вручну.
      </div>
      {err && <div className="chart-card" style={{ marginBottom: 12, color: "#b91c1c" }}>{err}</div>}
      {!data ? (!err && <p className="loading-text">Читаю таблицю…</p>) : (
        <>
          <div className="chart-card" style={{ marginBottom: 12 }}>
            <h3 className="chart-title" style={{ margin: "0 0 6px" }}>Операційні за розділами</h3>
            <table className="hr-tw">
              <thead><tr><th>Розділ</th><th className="num">Статті вручну</th><th className="num">Статті з таблиці</th><th className="num">Різниця</th>
                <th className="num">+ ЗП з таблиці</th><th className="num">Разом з таблиці</th><th className="num">Операційні вручну («Тиждень і місяць»)</th><th className="num">Різниця</th></tr></thead>
              <tbody>{data.sections.map((s) => (
                <tr key={s.section}>
                  <td>{SEC[s.section]}</td><td className="num">{money(s.manualArticles)}</td><td className="num">{money(s.autoArticles)}</td>
                  <td className="num" style={diffStyle(s.autoArticles - s.manualArticles)}>{signed(Math.round((s.autoArticles - s.manualArticles) * 100) / 100)}</td>
                  <td className="num">{money(s.autoPayroll)}</td><td className="num"><b>{money(s.autoTotal)}</b></td><td className="num">{money(s.manualOpex)}</td>
                  <td className="num" style={s.manualOpex == null ? { color: MUTED } : diffStyle(s.autoTotal - s.manualOpex)}>{s.manualOpex == null ? "не внесено" : signed(Math.round((s.autoTotal - s.manualOpex) * 100) / 100)}</td>
                </tr>
              ))}</tbody>
            </table>
            {(data.withoutSection.manual || data.withoutSection.auto) ? (
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
                Без розділу ({data.withoutSection.names.join(", ") || "—"}): вручну {money(data.withoutSection.manual)} · з таблиці {money(data.withoutSection.auto)} — у «План/факт» є, в операційні не йдуть.
              </div>
            ) : null}
          </div>

          <div className="chart-card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 className="chart-title" style={{ margin: 0 }}>Статті · {items.length}</h3>
              <span style={{ fontSize: 13, color: MUTED }}>усього вручну {money(data.totals.manual)} · з таблиці {money(data.totals.autoArticles)}</span>
              <label style={{ marginLeft: "auto", fontSize: 13 }}><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> лише розбіжності</label>
            </div>
            {!items.length ? <p className="hr-muted" style={{ margin: "8px 0" }}>{onlyDiff ? "Розбіжностей немає — кожна стаття збігається з таблицею." : "Статей немає."}</p> : (
              <table className="hr-tw">
                <thead><tr><th>Стаття</th><th>Розділ</th><th className="num">Вручну</th><th className="num">З таблиці</th><th className="num">Різниця</th><th className="num">Рядків</th></tr></thead>
                <tbody>{items.map((x) => (
                  <Fragment key={x.id}>
                    <tr style={{ cursor: x.rows ? "pointer" : undefined }} onClick={() => x.rows && setOpen(open === x.id ? null : x.id)}>
                      <td>{x.rows ? (open === x.id ? "▾ " : "▸ ") : ""}{x.name}<div style={{ fontSize: 11.5, color: MUTED }}>{x.resp} · {x.group}{x.off ? " · вимкнена" : ""}</div></td>
                      <td>{secName(x.section)}</td><td className="num">{x.manual == null ? <span style={{ color: MUTED }}>не внесено</span> : money(x.manual)}</td>
                      <td className="num">{money(x.auto)}</td><td className="num" style={diffStyle(x.diff)}>{signed(x.diff)}</td>
                      <td className="num">{x.rows}{x.unpaid ? <span style={{ color: "#b45309" }}> · не опл. {x.unpaid}</span> : ""}</td>
                    </tr>
                    {open === x.id && <tr><td colSpan={6}><Lines lines={x.lines} /></td></tr>}
                  </Fragment>
                ))}</tbody>
              </table>
            )}
          </div>

          <Pots title="ЗП за назвою" hint="Статей для ЗП немає — у розділ за назвою категорії. В операційні йдуть, у «План/факт» — ні." pots={data.payroll} />
          <Pots title="Кілька статей з цією назвою" hint="Категорія збігається з двома статтями — не вгадуємо, куди. Перейменуйте одну зі статей." pots={data.ambiguous} />
          <Pots title="Не розпізнано" hint="Категорії немає серед статей «План/факт» — у факт не йде. Додати статтю чи це не витрата для статистики?" pots={data.unrecognized} />
          <Pots title="Не UA" hint="Напрямок не UA — у факт не йде (Тетяна 13.10: «беремо лише UA»)." pots={data.notUa} />
          <Pots title="Сума не число" hint="Сума в таблиці не читається як число — у факт не йде." pots={data.badSum} />
          <Pots title="Дата оплати не дата" hint="У колонці «Дата оплати» не дата (за датою внесення в цьому місяці) — у факт не йде." pots={data.badPayDate} />
          <Pots title="Ще без дати оплати" hint="Внесено цього місяця, дати оплати ще немає — у факт не йде, доки її не поставлять." pots={data.noPayDate} />
        </>
      )}
    </div>
  );
}
