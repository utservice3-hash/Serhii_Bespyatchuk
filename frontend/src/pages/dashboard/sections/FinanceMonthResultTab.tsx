import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchMonthResult, setMonthResultOverride, downloadMonthResultXlsx, hiringError, type MonthResultData, type MRDeal, type MRManager } from "../../../api";

/**
 * 🏁 «РЕЗУЛЬТАТ МІСЯЦЯ» (#5583, Тетяна; прохід 1 — 23.10.2026). Замість ручного аркуша «09.26»: успішні угоди «Повного
 * циклу», закриті в місяці (і мінусові теж), сума бюджетів Kommo — за менеджером, який був відповідальним У МОМЕНТ
 * ЗАКРИТТЯ (перепризначення після закриття не переносить угоду). Угоди без рахунку, без фактичного приходу, валютні й
 * з готівковим розходом поза запитами — «на перевірці»: у результаті вони Є, позначка лише просить подивитись. Рішення
 * Тетяни — «не рахувати», «в інший місяць», «свій профіт» — з обовʼязковою приміткою; «Повернути» знімає рішення.
 * Рахує сервер (`core/monthResult.ts`); що дозволено — каже сервер (`canEdit`).
 */
type Toast = (text: string, opts?: { error?: boolean }) => void;
type Field = { id: string; label: string; value?: string; type?: "text" | "select"; options?: [string, string][]; placeholder?: string };
type DialogButton = { label: string; tone?: "p" | "dg"; run?: (v: Record<string, string>) => Promise<boolean | void> | boolean | void };
type Ask = (d: { title: string; text?: string; fields?: Field[]; buttons: DialogButton[] }) => void;
const CANCEL: DialogButton = { label: "Скасувати" };

const MUTED = "var(--text-muted)";
const money = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ");
const kyivYm = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
const shiftYm = (ym: string, n: number) => { const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const ymName = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("uk-UA", { month: "long", year: "numeric", timeZone: "UTC" });
const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const stamp = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const pill = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" });

/** Підпис рішення Тетяни — однаковий у таблиці й у підказці. */
export const overrideLabel = (d: MRDeal) => {
  const o = d.override; if (!o) return null;
  return o.action === "exclude" ? "не рахуємо" : o.action === "move" ? `перенесено в ${ymName(o.targetMonth!.slice(0, 7))}` : `свій профіт ${money(o.profit!)}`;
};

export function FinanceMonthResultTab({ ask, toast }: { ask: Ask; toast: Toast }) {
  const [ym, setYm] = useState(() => shiftYm(kyivYm(), -1));
  const [data, setData] = useState<MonthResultData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null | undefined>(undefined);
  const [onlyReview, setOnlyReview] = useState(false);

  const load = useCallback((refresh = false) => {
    setBusy(true);
    fetchMonthResult(ym, refresh).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(hiringError(e))).finally(() => setBusy(false));
  }, [ym]);
  useEffect(() => { setData(null); setOpen(undefined); load(); }, [load]);

  const excel = async () => {
    try {
      const { blob, filename } = await downloadMonthResultXlsx(ym);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast(`Excel не завантажено: ${hiringError(e)}`, { error: true }); }
  };

  const decide = (d: MRDeal) => ask({
    title: `Угода ${d.id} — рішення`,
    text: `${d.client ?? d.name} · бюджет ${money(d.price)} ₴ · закрито ${dmy(d.closedAt)}. Примітку видно в таблиці й в Excel.`,
    fields: [
      { id: "a", label: "Що зробити", type: "select", value: d.override?.action ?? "exclude", options: [["exclude", "Не рахувати в результаті"], ["move", "Рахувати в іншому місяці"], ["profit", "Рахувати свій профіт замість бюджету"]] },
      { id: "m", label: "Місяць (для «в іншому місяці»), РРРР-ММ", value: d.override?.targetMonth?.slice(0, 7) ?? shiftYm(d.closedMonth.slice(0, 7), 1), placeholder: "2026-10" },
      { id: "p", label: "Профіт, ₴ (для «свій профіт»; мінус можна)", value: d.override?.profit != null ? String(d.override.profit) : "", placeholder: "напр. 12500" },
      { id: "n", label: "Чому (обовʼязково)", value: d.override?.note ?? "", placeholder: "напр. оплата прийшла в жовтні" },
    ],
    buttons: [CANCEL, { label: "Зберегти", tone: "p", run: async (v) => {
      await setMonthResultOverride({ kommoId: d.id, action: v.a as "exclude" | "move" | "profit", targetMonth: v.m, profit: v.p, note: v.n });
      toast("Рішення збережено"); load();
    } }],
  });
  const undo = async (d: MRDeal) => {
    try { await setMonthResultOverride({ kommoId: d.id, action: null }); toast("Рішення знято — угода рахується як у Kommo"); load(); }
    catch (e) { toast(hiringError(e), { error: true }); }
  };

  if (err && !data) return <div className="chart-card"><b>Результат місяця</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Рахую {ymName(ym)} — тягну поля угод із Kommo…</p>;

  const link = (id: number) => <a href={`${data.kommoBase}/leads/detail/${id}`} target="_blank" rel="noreferrer">{id}</a>;
  const name = (id: number | null) => data.managers.find((m) => m.kommoUserId === id)?.name ?? (id == null ? "без відповідального" : `id ${id}`);
  const tile = (label: string, value: string, color?: string, sub?: string) => (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px" }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED }}>{sub}</div>}
    </div>
  );
  const dealsOf = (m: MRManager) => data.deals.filter((d) => d.closer === m.kommoUserId && (!onlyReview || (d.included && d.checks.length) || d.override));
  const rows = onlyReview ? data.managers.filter((m) => m.review.n || m.overrides) : data.managers;

  const dealTable = (m: MRManager) => (
    <table className="hr-table" style={{ width: "100%", fontSize: 12.5, margin: "4px 0 10px" }}>
      <thead><tr><th>Угода</th><th>Клієнт</th><th>Закрито</th><th style={{ textAlign: "right" }}>Бюджет</th><th style={{ textAlign: "right" }}>У результаті</th><th>Перевірити</th><th>Рішення</th>{data.canEdit && <th />}</tr></thead>
      <tbody>{dealsOf(m).map((d) => (
        <tr key={d.id} style={!d.included ? { color: MUTED } : d.checks.length ? { background: "rgba(217,119,6,0.06)" } : undefined}>
          <td style={{ whiteSpace: "nowrap" }}>{link(d.id)}{d.reassigned && <div style={{ fontSize: 11, color: MUTED }} title="Відповідального змінили після закриття — угода рахується тому, хто закривав">зараз: {name(d.current)}</div>}</td>
          <td>{d.client ?? d.name}{d.paymentType && <div style={{ fontSize: 11, color: MUTED }}>{d.paymentType}</div>}</td>
          <td style={{ whiteSpace: "nowrap" }}>{dmy(d.closedAt)}{d.closedMonth.slice(0, 7) !== ym && <div style={{ fontSize: 11, color: MUTED }}>з {ymName(d.closedMonth.slice(0, 7))}</div>}</td>
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.isMinus ? <span style={{ color: "#dc2626" }}>{money(d.price)}</span> : money(d.price)}</td>
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.included ? <b>{money(d.profit)}</b> : "—"}</td>
          <td>{d.checks.length ? d.checks.map((c) => <div key={c} style={{ color: "#b45309" }}>{c}</div>) : <span style={{ color: MUTED }}>—</span>}</td>
          <td>{d.override ? <><span style={pill("rgba(37,99,235,0.10)", "#2563eb")}>{overrideLabel(d)}</span><div style={{ fontSize: 11, color: MUTED }}>{d.override.note}{d.override.setBy ? ` — ${d.override.setBy}` : ""}</div></> : <span style={{ color: MUTED }}>—</span>}</td>
          {data.canEdit && <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            <button className="hr-btn" onClick={() => decide(d)}>{d.override ? "Змінити" : "Рішення…"}</button>
            {d.override && <button className="hr-btn" style={{ marginLeft: 4 }} onClick={() => void undo(d)}>Повернути</button>}
          </td>}
        </tr>
      ))}</tbody>
    </table>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button className="hr-btn" onClick={() => setYm(shiftYm(ym, -1))} aria-label="Попередній місяць">◀</button>
        <b style={{ minWidth: 130, textAlign: "center" }}>{ymName(ym)}</b>
        <button className="hr-btn" onClick={() => setYm(shiftYm(ym, 1))} disabled={ym >= kyivYm()} aria-label="Наступний місяць">▶</button>
        <label style={{ fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> лише на перевірці й з рішенням
        </label>
        <span style={{ fontSize: 12, color: MUTED, marginLeft: "auto" }}>пораховано {stamp(data.computedAt)}</span>
        <button className="hr-btn" disabled={busy} onClick={() => load(true)}>{busy ? "Рахую…" : "↻ Оновити з Kommo"}</button>
        <button className="hr-btn" onClick={() => void excel()}>⬇ Excel</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        {tile("Угод", String(data.totals.deals))}
        {tile("Результат", `${money(data.totals.result)} ₴`, "#16a34a")}
        {tile("На перевірці", String(data.totals.review.n), data.totals.review.n ? "#b45309" : undefined, data.totals.review.n ? `${money(data.totals.review.sum)} ₴ — у результаті є` : undefined)}
        {tile("Мінусові", String(data.totals.minus.n), data.totals.minus.n ? "#dc2626" : undefined, data.totals.minus.n ? `${money(data.totals.minus.sum)} ₴` : undefined)}
      </div>

      <div className="chart-card">
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          Успішні угоди «Повного циклу», закриті в місяці (разом із мінусовими), сума бюджетів Kommo. Угода — тому, хто був відповідальним у момент закриття
          {data.eventsSince ? ` (перепризначення звірено ${stamp(data.eventsSince)})` : " (перепризначення ще не звірялись — рахується поточний відповідальний)"}. Клік по менеджеру — його угоди.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="hr-table fin-table" style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th>Менеджер</th><th style={{ textAlign: "right" }}>Угод</th><th style={{ textAlign: "right" }}>Результат</th><th style={{ textAlign: "right" }}>На перевірці</th><th style={{ textAlign: "right" }}>Мінусові</th><th style={{ textAlign: "right" }}>Рішень</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <Fragment key={String(m.kommoUserId)}>
                  <tr className="it" onClick={() => setOpen(open === m.kommoUserId ? undefined : m.kommoUserId)} aria-expanded={open === m.kommoUserId}>
                    <td>{open === m.kommoUserId ? "▾" : "▸"} {m.name}{!m.active && <span style={{ fontSize: 11, color: MUTED, marginLeft: 6 }}>неактивний</span>}</td>
                    <td style={{ textAlign: "right" }}>{m.deals}</td>
                    <td style={{ textAlign: "right" }}><b>{money(m.result)}</b></td>
                    <td style={{ textAlign: "right", color: m.review.n ? "#b45309" : MUTED }}>{m.review.n ? `${m.review.n} · ${money(m.review.sum)}` : "—"}</td>
                    <td style={{ textAlign: "right", color: m.minus.n ? "#dc2626" : MUTED }}>{m.minus.n ? `${m.minus.n} · ${money(m.minus.sum)}` : "—"}</td>
                    <td style={{ textAlign: "right", color: m.overrides ? "#2563eb" : MUTED }}>{m.overrides || "—"}</td>
                  </tr>
                  {open === m.kommoUserId && <tr><td colSpan={6} style={{ padding: "0 0 0 18px" }}>{dealTable(m)}</td></tr>}
                </Fragment>
              ))}
              {!rows.length && <tr><td colSpan={6} className="hr-muted">{onlyReview ? "Нічого на перевірці й жодного рішення." : "У цьому місяці немає успішних угод «Повного циклу»."}</td></tr>}
              <tr><td><b>Разом</b></td><td style={{ textAlign: "right" }}><b>{data.totals.deals}</b></td><td style={{ textAlign: "right" }}><b>{money(data.totals.result)}</b></td><td /><td /><td /></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
