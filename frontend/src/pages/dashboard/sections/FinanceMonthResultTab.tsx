import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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

/**
 * 📒 Колонки угоди «як у таблиці Тетяни» (прохід 2): блоки Kommo, 1С, оплати клієнтів з 1С — у порядку її «Сделки».
 * `main` — колонка, що лишається, коли блок згорнуто (бюджет / разом).
 */
type Block = "kommo" | "onec" | "paid";
export const BLOCKS: [Block, string][] = [["kommo", "Kommo"], ["onec", "1С"], ["paid", "Оплати клієнтів (1С)"]];
const BLOCK_BG: Record<Block, string> = { kommo: "rgba(37,99,235,0.07)", onec: "rgba(124,58,237,0.07)", paid: "rgba(22,163,74,0.07)" };
type Col = { k: string; g: Block | null; h: string; v: (d: MRDeal) => number | string | null; main?: boolean; text?: boolean };
export const COLS: Col[] = [
  { k: "kb", g: "kommo", h: "Бюджет", v: (d) => d.price, main: true },
  { k: "ki1", g: "kommo", h: "Прих. з ПДВ", v: (d) => d.kommo?.in.vat ?? null },
  { k: "ki2", g: "kommo", h: "Прих. без ПДВ", v: (d) => d.kommo?.in.novat ?? null },
  { k: "ki3", g: "kommo", h: "Прих. нал", v: (d) => d.kommo?.in.cash ?? null },
  { k: "ko1", g: "kommo", h: "Розх. з ПДВ", v: (d) => d.kommo?.out.vat ?? null },
  { k: "ko2", g: "kommo", h: "Розх. без ПДВ", v: (d) => d.kommo?.out.novat ?? null },
  { k: "ko3", g: "kommo", h: "На вигрузці", v: (d) => d.kommo?.out.unload ?? null },
  { k: "ko4", g: "kommo", h: "Розх. нал", v: (d) => d.kommo?.out.cash ?? null },
  { k: "ob", g: "onec", h: "Бюджет 1С", v: (d) => d.onec?.budget ?? null, main: true },
  { k: "oo", g: "onec", h: "Організація", v: (d) => d.onec?.organization ?? null, text: true },
  { k: "oi1", g: "onec", h: "Прих. з ПДВ", v: (d) => d.onec?.flows.in.vat ?? null },
  { k: "oi2", g: "onec", h: "Прих. без ПДВ", v: (d) => d.onec?.flows.in.novat ?? null },
  { k: "oi3", g: "onec", h: "Прих. нал", v: (d) => d.onec?.flows.in.cash ?? null },
  { k: "oo1", g: "onec", h: "Розх. з ПДВ", v: (d) => d.onec?.flows.out.vat ?? null },
  { k: "oo2", g: "onec", h: "Розх. без ПДВ", v: (d) => d.onec?.flows.out.novat ?? null },
  { k: "oo3", g: "onec", h: "На вигрузці", v: (d) => d.onec?.flows.out.unload ?? null },
  { k: "oo4", g: "onec", h: "Розх. нал", v: (d) => d.onec?.flows.out.cash ?? null },
  { k: "p1", g: "paid", h: "з ПДВ", v: (d) => d.paid?.vat ?? null },
  { k: "p2", g: "paid", h: "без ПДВ", v: (d) => d.paid?.novat ?? null },
  { k: "p3", g: "paid", h: "нал", v: (d) => d.paid?.cash ?? null },
  { k: "pt", g: "paid", h: "Разом", v: (d) => d.paid?.total ?? null, main: true },
];
const LS_BLOCKS = "fin.monthResult.blocks";
const readBlocks = (): Record<Block, boolean> => {
  try { const v = JSON.parse(localStorage.getItem(LS_BLOCKS) ?? "null"); if (v && typeof v === "object") return { kommo: v.kommo !== false, onec: v.onec !== false, paid: v.paid !== false }; } catch { /* приватне вікно */ }
  return { kommo: true, onec: true, paid: true };
};
const STICKY_TH: React.CSSProperties = { position: "sticky", left: 0, zIndex: 2, background: "var(--card-bg)", minWidth: 200 };
const STICKY_TD: React.CSSProperties = { position: "sticky", left: 0, zIndex: 1, background: "var(--card-bg)", minWidth: 200, maxWidth: 260, boxShadow: "1px 0 0 var(--border)" };

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
  const [blocks, setBlocks] = useState(readBlocks);
  const toggleBlock = (b: Block) => setBlocks((x) => { const n = { ...x, [b]: !x[b] }; try { localStorage.setItem(LS_BLOCKS, JSON.stringify(n)); } catch { /* приватне вікно */ } return n; });

  const [pending, setPending] = useState(false);
  const poll = useRef<number | undefined>(undefined);
  const load = useCallback((refresh = false) => {
    window.clearTimeout(poll.current);
    setBusy(true);
    fetchMonthResult(ym, refresh)
      .then((d) => {
        // Сервер ще рахує (перший розрахунок місяця довший за 20 с) — перепитуємо, поки не буде готово.
        if ("pending" in d) { setPending(true); poll.current = window.setTimeout(() => load(false), 4000); return; }
        setPending(false); setData(d); setErr(null); setBusy(false);
      })
      .catch((e) => { setPending(false); setErr(hiringError(e)); setBusy(false); });
  }, [ym]);
  useEffect(() => { setData(null); setOpen(undefined); load(); return () => window.clearTimeout(poll.current); }, [load]);

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
  if (!data) return <p className="loading-text">Рахую {ymName(ym)} — тягну поля угод із Kommo{pending ? " (перший розрахунок місяця — до хвилини)" : ""}…</p>;

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

  const dealTable = (m: MRManager) => {
    const list = dealsOf(m);
    const cols = COLS.filter((c) => !c.g || blocks[c.g] || c.main);
    const groups: { g: Block; n: number }[] = [];
    for (const c of cols) if (c.g) { const last = groups[groups.length - 1]; if (last && last.g === c.g) last.n++; else groups.push({ g: c.g, n: 1 }); }
    const firstOf = new Set(groups.map((g) => cols.find((c) => c.g === g.g)!.k));
    const edge = (k: string): React.CSSProperties | null => (firstOf.has(k) ? { borderLeft: "2px solid var(--border)" } : null);
    const sum = (c: Col) => (c.text ? null : list.reduce((a, d) => a + (Number(c.v(d)) || 0), 0));
    const cell = (c: Col, d: MRDeal) => {
      const v = c.v(d);
      const off = c.g === "onec" && c.main && d.onec?.budget != null && Math.abs(d.price - d.onec.budget) >= 1;
      return <td key={c.k} style={{ textAlign: c.text ? "left" : "right", whiteSpace: "nowrap", ...edge(c.k), ...(off ? { background: "rgba(217,119,6,0.14)" } : null), ...(c.main ? { fontWeight: 600 } : null) }}
        title={off ? `Бюджет Kommo ${money(d.price)} ≠ 1С ${money(d.onec!.budget!)}` : undefined}>
        {v == null || v === "" ? <span style={{ color: MUTED }}>—</span> : typeof v === "string" ? <span style={{ fontSize: 11.5 }}>{v}</span> : v === 0 ? <span style={{ color: MUTED }}>0</span> : money(v)}</td>;
    };
    return (
      <div style={{ margin: "4px 0 12px" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "6px 0" }}>
          <span style={{ fontSize: 12, color: MUTED }}>Блоки як у таблиці «Сделки»:</span>
          {BLOCKS.map(([b, l]) => (
            <button key={b} className={`hr-btn ${blocks[b] ? "p" : ""}`} style={{ padding: "2px 10px", fontSize: 12 }} aria-pressed={blocks[b]} onClick={() => toggleBlock(b)}>{blocks[b] ? "▾" : "▸"} {l}</button>
          ))}
        </div>
        <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
          <table className="hr-table mr-deals" style={{ width: "100%", fontSize: 12.5, margin: 0 }}>
            <thead>
              <tr>
                <th rowSpan={2} style={STICKY_TH}>Угода</th>
                <th rowSpan={2}>Закрито</th>
                {groups.map((g) => <th key={g.g} colSpan={g.n} style={{ textAlign: "left", background: BLOCK_BG[g.g], borderBottom: 0, borderLeft: "2px solid var(--border)" }}>{BLOCKS.find((b) => b[0] === g.g)![1]}</th>)}
                <th rowSpan={2} style={{ textAlign: "right" }} title="Прихід 1С + розхід 1С без «оплати на вигрузці» — колонка «Плановий профіт PNL»">Плановий PNL</th>
                <th rowSpan={2} style={{ textAlign: "right" }}>У результаті</th>
                <th rowSpan={2}>Перевірити</th>
                <th rowSpan={2}>Рішення</th>
                {data.canEdit && <th rowSpan={2} />}
              </tr>
              <tr>{cols.filter((c) => c.g).map((c) => <th key={c.k} style={{ textAlign: c.text ? "left" : "right", ...edge(c.k), background: BLOCK_BG[c.g!], fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" }}>{c.h}</th>)}</tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} style={!d.included ? { color: MUTED } : d.checks.length ? { background: "rgba(217,119,6,0.06)" } : undefined}>
                  <td style={STICKY_TD}>
                    <div style={{ whiteSpace: "nowrap" }}>{link(d.id)}{d.isMinus && <span style={{ ...pill("rgba(220,38,38,0.12)", "#dc2626"), marginLeft: 6 }}>мінус</span>}</div>
                    <div style={{ fontSize: 11.5 }}>{d.client ?? d.name}</div>
                    {d.paymentType && <div style={{ fontSize: 11, color: MUTED }}>{d.paymentType}</div>}
                    {d.reassigned && <div style={{ fontSize: 11, color: MUTED }} title="Відповідального змінили після закриття — угода рахується тому, хто закривав">зараз: {name(d.current).split(" ")[0]}</div>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{dmy(d.closedAt)}{d.closedMonth.slice(0, 7) !== ym && <div style={{ fontSize: 11, color: MUTED }}>з {ymName(d.closedMonth.slice(0, 7))}</div>}</td>
                  {cols.filter((c) => c.g).map((c) => cell(c, d))}
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.planPnl == null ? <span style={{ color: MUTED }}>—</span> : money(d.planPnl)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{d.included ? <b>{money(d.profit)}</b> : "—"}</td>
                  <td style={{ minWidth: 220 }}>{d.checks.length ? d.checks.map((c) => <div key={c} style={{ color: "#b45309" }}>{c}</div>) : <span style={{ color: MUTED }}>—</span>}</td>
                  <td style={{ minWidth: 150 }}>{d.override ? <><span style={pill("rgba(37,99,235,0.10)", "#2563eb")}>{overrideLabel(d)}</span><div style={{ fontSize: 11, color: MUTED }}>{d.override.note}{d.override.setBy ? ` — ${d.override.setBy}` : ""}</div></> : <span style={{ color: MUTED }}>—</span>}</td>
                  {data.canEdit && <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="hr-btn" onClick={() => decide(d)}>{d.override ? "Змінити" : "Рішення…"}</button>
                    {d.override && <button className="hr-btn" style={{ marginLeft: 4 }} onClick={() => void undo(d)}>Повернути</button>}
                  </td>}
                </tr>
              ))}
              <tr style={{ fontWeight: 700, background: "var(--surface-2, var(--bg))" }}>
                <td style={{ ...STICKY_TD, background: "var(--surface-2, var(--bg))" }}>Разом · {list.length}</td>
                <td />
                {cols.filter((c) => c.g).map((c) => { const v = sum(c); return <td key={c.k} style={{ textAlign: "right", whiteSpace: "nowrap", ...edge(c.k) }}>{v == null ? "" : money(v)}</td>; })}
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(list.reduce((a, d) => a + (d.planPnl ?? 0), 0))}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{money(list.reduce((a, d) => a + (d.included ? d.profit : 0), 0))}</td>
                <td /><td />{data.canEdit && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

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
        <button className="hr-btn" disabled={busy} onClick={() => load(true)}>{busy ? (pending ? "Рахую… до хвилини" : "Рахую…") : "↻ Оновити з Kommo"}</button>
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
          {data.eventsSince ? ` (перепризначення звірено ${stamp(data.eventsSince)})` : " (перепризначення ще не звірялись — рахується поточний відповідальний)"}.
          {" "}{data.onecSince ? `1С по угодах — станом на ${stamp(data.onecSince)}.` : "1С по угодах ще не завантажено — блоки 1С порожні."}
          {data.onecError && <span style={{ color: "#b45309" }}> Останній синк 1С не вдався: {data.onecError}</span>} Клік по менеджеру — його угоди.
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
                  {open === m.kommoUserId && <tr><td colSpan={6} style={{ padding: "0 0 0 18px", maxWidth: 0 }}>{dealTable(m)}</td></tr>}
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
