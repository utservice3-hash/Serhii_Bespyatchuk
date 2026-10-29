import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchFinCalendar, createFinRecurring, updateFinRecurring, payFinRecurring, undoFinRecurringPaid, downloadFinCalendarHistory,
  type RecCalendar, type RecEvent, type RecItem, type RecPaid, type RecPeriod,
} from "../../../api";
import { useDialogs } from "../../../components/Dialogs";
import { getAuthPayload } from "../../../auth";
import { useToast } from "../../../components/Toasts";

/**
 * 📅 «Календар оплат» (задача Тетяни #6369, 27.10.2026; макет «Г» — Роман). Періодичні витрати: оплата — це СТАТТЯ
 * «План/факту» і МІСЯЦЬ (прохід 2, Тетяна 27.10.2026). Зверху — смуга місяців (ліворуч минулий, далі поточний і майбутні;
 * гортається назад до першої оплати), під нею — оплати обраного місяця з «✓ Оплачено» і деталями; поруч — «Історія оплат»
 * (нічого не стирається, скасоване лишається з позначкою). Нагадування — підказка біля статті в «План/факті» з кнопкою
 * «додати в план». Усе рахує сервер (`core/finRecurring.ts`). Вкладку бачать і ведуть Тетяна й адмін (`view_private_finance`).
 */
const MUTED = "var(--text-muted)";
const MON = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const MONF = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const PERIOD: Record<RecPeriod, string> = { month: "щомісяця", quarter: "щокварталу", halfyear: "раз на пів року", year: "раз на рік", once: "одноразово" };
const TONE: Record<RecEvent["kind"], [string, string]> = { paid: ["#e6f4ea", "#1e7a3c"], overdue: ["#fdecea", "#b42318"], soon: ["#fff4dc", "#8a5300"], plan: ["#eef1f5", "#3d4552"] };
const CELL = 104; // ширина місяця в смузі + проміжок
const money = (n: number) => `${Math.round(n).toLocaleString("uk-UA").replace(/ /g, " ")} ₴`;
const short = (n: number) => (!n ? "—" : n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString("uk-UA")} тис` : String(Math.round(n)));
const monthName = (d: string) => `${MONF[+d.slice(5, 7) - 1].toLowerCase()} ${d.slice(0, 4)}`;
const STATUS: Record<RecEvent["kind"], string> = { paid: "оплачено", overdue: "не оплачено", soon: "цього місяця", plan: "заплановано" };
const plural = (n: number, a: string, b: string, c: string) => { const t = n % 10, h = n % 100; return t === 1 && h !== 11 ? a : t >= 2 && t <= 4 && (h < 12 || h > 14) ? b : c; };
const oplat = (n: number) => `${n} ${plural(n, "оплата", "оплати", "оплат")}`;
const meta = (i: RecItem) => (i.period === "month" ? PERIOD.month : i.period === "once" ? `одноразово · ${monthName(i.next)}` : `${PERIOD[i.period]} · наступна — ${monthName(i.next)}`);
const title = (i: RecItem | undefined) => (i ? (i.note ? `${i.name} · ${i.note}` : i.name) : "—");
const at = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const errText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "помилка";
const chip = (k: RecEvent["kind"]): React.CSSProperties => ({ display: "inline-block", padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", background: TONE[k][0], color: TONE[k][1] });
const pill = (on: boolean): React.CSSProperties => ({ minHeight: 34, padding: "0 12px", borderRadius: 999, fontWeight: 600, fontSize: 13, cursor: "pointer",
  border: `1px solid ${on ? "var(--brand)" : "var(--border-strong)"}`, background: on ? "var(--brand)" : "var(--card-bg)", color: on ? "#fff" : "var(--text)" });
const card: React.CSSProperties = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 18px" };
const label: React.CSSProperties = { fontSize: 12, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" };

type Form = { id: number | null; itemId: string; amount: string; period: RecPeriod; month: string; note: string };

export function FinanceCalendarTab() {
  const canView = (getAuthPayload()?.perms ?? []).includes("view_private_finance");
  const toast = useToast();
  const dlg = useDialogs();
  const [data, setData] = useState<RecCalendar | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"cal" | "hist">("cal");
  const [ym, setYm] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [payAmt, setPayAmt] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Form | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [histItem, setHistItem] = useState<number | "all">("all");
  const [histMonths, setHistMonths] = useState(6);
  const [busy, setBusy] = useState(false);
  const strip = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);

  const load = useCallback(() => {
    if (!canView) return;
    fetchFinCalendar().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(errText(e)));
  }, [canView]);
  useEffect(() => { load(); }, [load]);
  // Смуга відкривається з МИНУЛОГО місяця ліворуч (Роман 27.10.2026) — один раз, а не після кожної дії.
  useEffect(() => {
    if (!data || view !== "cal" || scrolled.current || !strip.current) return;
    strip.current.scrollLeft = Math.max(0, data.months.findIndex((m) => m.offset === -1)) * CELL;
    scrolled.current = true;
  }, [data, view]);

  const items = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);

  if (!canView) return <div className="chart-card"><b>Календар оплат</b> <span className="hr-muted">Бачать і ведуть лише Тетяна й адмін.</span></div>;
  if (err && !data) return <div className="chart-card"><b>Календар оплат</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Завантаження…</p>;

  const today = data.today, curYm = today.slice(0, 7), selYm = ym ?? curYm;
  const month = data.months.find((m) => m.ym === selYm) ?? data.months.find((m) => m.offset === 0)!;
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, { tone: "ok" }); load(); return true; }
    catch (e) { toast(`Не збережено: ${errText(e)}`, { error: true }); load(); return false; }
    finally { setBusy(false); }
  };
  const undo = (paidId: number, name: string) => act(() => undoFinRecurringPaid(paidId), `«${name}»: позначку скасовано, дата повернулась`);
  const pay = async (it: RecItem, amount?: string) => {
    setBusy(true);
    try {
      const r = await payFinRecurring(it.id, { due: it.next, ...(amount != null ? { amount } : {}) });
      toast(it.period === "once" ? `«${title(it)}» — оплачено, одноразову оплату закрито` : `«${title(it)}» — оплачено. Наступна оплата: ${monthName(r.next)}`, { tone: "ok", action: { label: "Скасувати", run: () => void undo(r.paidId, title(it)) } });
      load();
    } catch (e) { toast(`Не позначено: ${errText(e)}`, { error: true }); load(); }
    finally { setBusy(false); }
  };
  const disable = async (it: RecItem) => {
    if (!(await dlg.confirm({ title: `Більше не нагадувати про «${title(it)}»?`, text: "Нагадування вимкнеться, історія оплат лишиться. Увімкнути можна будь-коли.", okLabel: "Вимкнути" }))) return;
    await act(() => updateFinRecurring(it.id, { active: false }), `«${title(it)}»: нагадування вимкнено`);
  };
  const newForm = (): Form => ({ id: null, itemId: "", amount: "", period: "month", month: curYm, note: "" });
  const editForm = (it: RecItem): Form => ({ id: it.id, itemId: String(it.itemId), amount: String(it.amount), period: it.period, month: it.next.slice(0, 7), note: it.note ?? "" });
  const articleName = (id: string) => data.articles.find((a) => String(a.id) === id)?.name ?? "";
  const save = async () => {
    if (!form) return;
    if (!form.itemId) return setFormErr("Оберіть статтю.");
    if (!(Number(form.amount.replace(/\s/g, "").replace(",", ".")) > 0)) return setFormErr("Сума має бути більшою за нуль.");
    if (!/^\d{4}-\d{2}$/.test(form.month)) return setFormErr("Вкажіть місяць оплати.");
    const base = { itemId: Number(form.itemId), amount: form.amount, note: form.note };
    const was = form.id != null ? items.get(form.id) : undefined;
    const ok = await act(
      () => (was ? updateFinRecurring(was.id, { ...base, ...(form.period !== was.period ? { period: form.period } : {}), ...(form.month !== was.next.slice(0, 7) ? { month: form.month } : {}) })
        : createFinRecurring({ ...base, period: form.period, month: form.month })),
      was ? `«${articleName(form.itemId)}»: збережено` : `Додано «${articleName(form.itemId)}» з ${monthName(`${form.month}-01`)}`);
    if (ok) { if (!was) setYm(form.month); setForm(null); setFormErr(null); }
  };
  const excel = async () => {
    try {
      const { blob, filename } = await downloadFinCalendarHistory();
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast(`Excel не завантажився: ${errText(e)}`, { error: true }); }
  };
  const scrollBy = (dx: number) => strip.current?.scrollBy({ left: dx, behavior: "smooth" });
  const home = () => { setYm(curYm); strip.current?.scrollTo({ left: Math.max(0, data.months.findIndex((m) => m.offset === -1)) * CELL, behavior: "smooth" }); };

  const overdueElsewhere = data.items.filter((i) => i.active && i.next.slice(0, 7) < curYm && i.next.slice(0, 7) !== month.ym);
  const maxSum = Math.max(1, ...data.months.map((m) => m.sum));
  // Закрита одноразова — не «вимкнене нагадування»: вона оплачена й лежить в історії.
  const off = data.items.filter((i) => !i.active && i.period !== "once");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <p className="hr-muted" style={{ margin: 0, fontSize: 13, maxWidth: 720 }}>
            Періодичні витрати по статтях. Нагадування — у «План/факті» відповідного місяця: біля статті сума й кнопка
            «додати в план». Сам календар нічого не рахує в результаті.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div role="group" aria-label="Вигляд" style={{ display: "flex", gap: 4, background: "var(--border)", borderRadius: 10, padding: 3 }}>
            {(["cal", "hist"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); if (v === "cal") scrolled.current = false; }}
                style={{ minHeight: 34, padding: "0 14px", border: 0, borderRadius: 8, fontWeight: 600, cursor: "pointer", background: view === v ? "var(--card-bg)" : "transparent", color: "var(--text)" }}>
                {v === "cal" ? "Календар" : "Історія оплат"}
              </button>
            ))}
          </div>
          <button type="button" className="hr-btn p" onClick={() => { setForm(form ? null : newForm()); setFormErr(null); }}>{form ? "Закрити" : "+ Оплата"}</button>
        </div>
      </div>

      {form && (
        <section aria-label={form.id ? "Змінити оплату" : "Нова періодична оплата"} style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <b>{form.id ? `Змінити «${title(items.get(form.id))}»` : "Нова періодична оплата"}</b>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px 14px" }}>
            <label style={{ fontSize: 13 }}>Стаття<br />
              <select className="hr-inp" style={{ width: "100%" }} value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })}>
                <option value="">— оберіть статтю —</option>
                {[...new Set(data.articles.map((a) => `${a.resp} · ${a.group}`))].map((g) => (
                  <optgroup key={g} label={g}>
                    {data.articles.filter((a) => `${a.resp} · ${a.group}` === g && (!a.offFrom || String(a.id) === form.itemId)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </optgroup>
                ))}
              </select></label>
            <label style={{ fontSize: 13 }}>Сума, ₴<br /><input className="hr-inp" style={{ width: "100%" }} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            <label style={{ fontSize: 13 }}>Як часто<br />
              <select className="hr-inp" style={{ width: "100%" }} value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value as RecPeriod })}>
                <option value="month">щомісяця</option><option value="quarter">щокварталу</option><option value="halfyear">раз на пів року</option><option value="year">раз на рік</option><option value="once">одноразово</option>
              </select></label>
            <label style={{ fontSize: 13 }}>{form.period === "once" ? "Плановий місяць оплати" : form.id ? "Найближчий місяць" : "Перший місяць"}<br /><input className="hr-inp" style={{ width: "100%" }} type="month" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} /></label>
            <label style={{ fontSize: 13 }}>Примітка (необовʼязково)<br /><input className="hr-inp" style={{ width: "100%" }} value={form.note} placeholder="Напр., ФОП Коваль — щоб розрізнити дві оплати однієї статті" onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          </div>
          <span className="hr-muted" style={{ fontSize: 12.5 }}>Нагадування — у «План/факті» відповідного місяця: біля статті сума й кнопка «додати в план».</span>
          {formErr && <span role="alert" style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13.5 }}>{formErr}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="hr-btn p" disabled={busy} onClick={() => void save()}>{form.id ? "Зберегти" : "Додати"}</button>
            <button type="button" className="hr-btn" onClick={() => { setForm(null); setFormErr(null); }}>Скасувати</button>
          </div>
        </section>
      )}

      {overdueElsewhere.length > 0 && view === "cal" && (
        <div role="status" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", background: "#fdecea", border: "1px solid #f4c7c2", borderRadius: 10, padding: "6px 8px 6px 14px", color: "#8f1c13" }}>
          <b style={{ fontSize: 13.5 }}>Не оплачено: {overdueElsewhere.map((i) => `«${title(i)}» за ${monthName(i.next)} (${money(i.amount)})`).join(", ")}</b>
          <button type="button" className="hr-btn xs" onClick={() => { const i = overdueElsewhere[0]; setYm(i.next.slice(0, 7)); setOpen((o) => ({ ...o, [`${i.id}@${i.next}`]: true })); }}>Перейти</button>
        </div>
      )}

      {view === "cal" && (<>
        <section aria-labelledby="fc-months" style={card}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <b id="fc-months">Місяці</b>
              <div className="hr-muted" style={{ fontSize: 12.5 }}>ліворуч — історія, праворуч — майбутнє · зелене — вже оплачено</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="hr-btn xs" aria-label="Раніше" onClick={() => scrollBy(-3 * CELL)}>‹</button>
              <button type="button" className="hr-btn xs" onClick={home}>Поточний</button>
              <button type="button" className="hr-btn xs" aria-label="Пізніше" onClick={() => scrollBy(3 * CELL)}>›</button>
            </div>
          </div>
          <div ref={strip} style={{ overflowX: "auto", scrollSnapType: "x proximity", paddingBottom: 6 }}>
            <div style={{ display: "flex", gap: 8, width: "max-content" }}>
              {data.months.map((m) => {
                const on = m.ym === month.ym, hp = Math.round((m.paid / maxSum) * 64), hr = Math.max(m.sum ? 4 : 0, Math.round((m.sum / maxSum) * 64) - hp);
                const tag = m.offset === -1 ? "минулий" : m.offset === 0 ? "поточний" : m.offset === 1 ? "наступний" : m.offset < 0 ? "історія" : " ";
                return (
                  <button key={m.ym} type="button" aria-pressed={on} onClick={() => setYm(m.ym)}
                    style={{ width: CELL - 8, flex: "none", boxSizing: "border-box", scrollSnapAlign: "start", display: "flex", flexDirection: "column", gap: 5, textAlign: "center", cursor: "pointer",
                      padding: on ? 7 : 8, borderRadius: 10, border: on ? "2px solid var(--brand)" : "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, minHeight: 14, color: m.offset === 0 ? "var(--brand)" : m.offset < 0 ? "#1e7a3c" : MUTED }}>{tag}</span>
                    <span style={{ fontSize: 12, display: "flex", justifyContent: "center", alignItems: "center", gap: 4 }}>
                      {MON[+m.ym.slice(5, 7) - 1]} {m.ym.slice(0, 4)}
                      {m.overdue > 0 && <span title="є прострочені" style={{ width: 7, height: 7, borderRadius: "50%", background: "#b42318" }} />}
                    </span>
                    <span style={{ height: 64, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                      <span style={{ height: hr, borderRadius: hp ? "4px 4px 0 0" : 4, background: on ? "var(--brand)" : "#a9bde6" }} />
                      <span style={{ height: hp, borderRadius: hr ? 0 : "4px 4px 0 0", background: "#5fae7a" }} />
                    </span>
                    <b style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{short(m.sum)}</b>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section aria-labelledby="fc-month" style={card}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <b id="fc-month" style={{ fontSize: 16 }}>{MONF[+month.ym.slice(5, 7) - 1]} {month.ym.slice(0, 4)} · {oplat(month.events.length)}</b>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 13.5, fontVariantNumeric: "tabular-nums" }}>
              <span>усього <b>{money(month.sum)}</b></span>
              <span style={{ color: "#1e7a3c" }}>оплачено <b>{money(month.paid)}</b></span>
              <span>лишилось <b>{money(month.sum - month.paid)}</b></span>
              {month.overdue > 0 && <span style={{ color: "#b42318" }}>прострочено <b>{money(month.overdue)}</b></span>}
            </div>
          </div>
          <div aria-hidden="true" style={{ height: 6, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${month.sum ? Math.round((month.paid / month.sum) * 100) : 0}%`, background: "#5fae7a" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {month.events.map((e) => <EventCard key={`${e.recurringId}@${e.date}@${e.paidId ?? ""}`} e={e} it={items.get(e.recurringId)} history={data.history} busy={busy}
              open={!!open[`${e.recurringId}@${e.date}`]} toggle={() => setOpen((o) => ({ ...o, [`${e.recurringId}@${e.date}`]: !o[`${e.recurringId}@${e.date}`] }))}
              amt={payAmt[`${e.recurringId}@${e.date}`]} setAmt={(v) => setPayAmt((a) => ({ ...a, [`${e.recurringId}@${e.date}`]: v }))}
              pay={pay} undo={undo} disable={disable} edit={(it) => { setForm(editForm(it)); setFormErr(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              openHistory={(id) => { setHistItem(id); setHistMonths(0); setView("hist"); }} />)}
          </div>
          {month.events.length === 0 && <p className="hr-muted" style={{ margin: "12px 0 4px" }}>{data.items.length ? "У цьому місяці оплат немає." : "Ще немає жодної періодичної оплати — додайте першу кнопкою «+ Оплата»."}</p>}
        </section>

        {off.length > 0 && (
          <section aria-labelledby="fc-off" style={card}>
            <b id="fc-off">Вимкнені нагадування</b>
            {off.map((i) => (
              <div key={i.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--border)", marginTop: 6 }}>
                <span>{title(i)} · {money(i.amount)} <span className="hr-muted" style={{ fontSize: 12.5 }}>· {meta(i)}</span></span>
                <button type="button" className="hr-btn xs" disabled={busy} onClick={() => void act(() => updateFinRecurring(i.id, { active: true }), `«${title(i)}»: нагадування увімкнено`)}>Увімкнути</button>
              </div>
            ))}
          </section>
        )}
      </>)}

      {view === "hist" && <History data={data} item={histItem} setItem={setHistItem} months={histMonths} setMonths={setHistMonths} undo={undo} excel={excel} busy={busy} />}
    </div>
  );
}

function EventCard({ e, it, history, open, toggle, amt, setAmt, pay, undo, disable, edit, openHistory, busy }: {
  e: RecEvent; it: RecItem | undefined; history: RecPaid[]; open: boolean; toggle: () => void; amt: string | undefined; setAmt: (v: string) => void;
  pay: (it: RecItem, amount?: string) => void; undo: (paidId: number, name: string) => void; disable: (it: RecItem) => void; edit: (it: RecItem) => void;
  openHistory: (id: number) => void; busy: boolean;
}) {
  const name = title(it);
  const status = STATUS[e.kind];
  const canPay = !!it && it.active && e.due;
  const off = e.planned != null && Math.abs(e.amount - e.planned) >= 1;
  const hist = history.filter((p) => p.recurringId === e.recurringId).slice(0, 4);
  const border = e.kind === "overdue" ? "#f4c7c2" : e.kind === "soon" ? "#f0d9a8" : "var(--border)";
  return (
    <div style={{ borderRadius: 10, padding: "10px 12px", border: `1px solid ${border}`, background: e.kind === "paid" ? "rgba(30,122,60,.05)" : "var(--card-bg)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", alignItems: "center" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <b>{name}</b>
          <div className="hr-muted" style={{ fontSize: 12.5 }}>{it ? meta(it) : ""}{e.kind === "paid" && e.by ? ` · позначив ${e.by}${e.at ? `, ${at(e.at)}` : ""}` : ""}</div>
        </div>
        <span style={chip(e.kind)}>{status}</span>
        <b style={{ minWidth: 100, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(e.amount)}{off && <span className="hr-muted" style={{ fontWeight: 400, fontSize: 12 }}> (план {money(e.planned!)})</span>}</b>
        {canPay && <button type="button" className="hr-btn p" disabled={busy} onClick={() => pay(it!)}>✓ Оплачено</button>}
        <button type="button" className="hr-btn xs" aria-expanded={open} onClick={toggle}>{open ? "Згорнути ▴" : "Деталі ▾"}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border-strong)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px 18px", fontSize: 13.5 }}>
            <div><div style={label}>Стаття «План/факту»</div>{it?.name ?? "—"}</div>
            <div><div style={label}>Примітка</div>{it?.note || <span className="hr-muted">немає</span>}</div>
            <div><div style={label}>Наступні місяці</div>{it && it.active ? it.upcoming.map((x) => <div key={x}>{monthName(x)}</div>) : <span className="hr-muted">{it?.period === "once" ? "одноразову оплату закрито" : "нагадування вимкнене"}</span>}</div>
            <div>
              <div style={label}>Історія оплат</div>
              {hist.map((p) => <div key={p.id} style={p.cancelledAt ? { textDecoration: "line-through", color: MUTED } : undefined}>{monthName(p.due)} — {money(p.amount)}{p.by ? ` · ${p.by}` : ""}</div>)}
              {!hist.length && <span className="hr-muted">ще не оплачувалась</span>}
              <div><button type="button" className="hr-btn xs" style={{ marginTop: 4 }} onClick={() => openHistory(e.recurringId)}>Уся історія →</button></div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            {canPay && (<>
              <label style={{ fontSize: 13 }}>Фактична сума, ₴<br />
                <input className="hr-inp" inputMode="decimal" style={{ width: 150 }} value={amt ?? String(e.amount)} onChange={(x) => setAmt(x.target.value)} /></label>
              <button type="button" className="hr-btn" disabled={busy} onClick={() => pay(it!, amt ?? String(e.amount))}>Оплачено цією сумою</button>
            </>)}
            {!canPay && e.kind !== "paid" && it && it.active && <span className="hr-muted" style={{ fontSize: 12.5 }}>Позначити можна після попередньої — {monthName(it.next)}.</span>}
            {e.canUndo && e.paidId != null && <button type="button" className="hr-btn" disabled={busy} onClick={() => undo(e.paidId!, name)}>Скасувати оплату</button>}
            <span style={{ flex: 1 }} />
            {it && <button type="button" className="hr-btn xs" onClick={() => edit(it)}>Змінити</button>}
            {it?.active && <button type="button" className="hr-btn xs" onClick={() => disable(it)}>Більше не нагадувати</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function History({ data, item, setItem, months, setMonths, undo, excel, busy }: {
  data: RecCalendar; item: number | "all"; setItem: (v: number | "all") => void; months: number; setMonths: (n: number) => void;
  undo: (paidId: number, name: string) => void; excel: () => void; busy: boolean;
}) {
  const from = months ? (() => { const y = +data.today.slice(0, 4), m = +data.today.slice(5, 7) - 1 - months; return new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 7); })() : "0000-00";
  const rows = data.history.filter((p) => p.due.slice(0, 7) >= from && (item === "all" || p.recurringId === item));
  const live = rows.filter((p) => !p.cancelledAt);
  const dev = live.reduce((a, p) => a + p.amount - p.planned, 0);
  const groups = new Map<string, RecPaid[]>();
  for (const p of rows) groups.set(p.due.slice(0, 7), [...(groups.get(p.due.slice(0, 7)) ?? []), p]);
  const cols = "96px minmax(170px, 2fr) 120px minmax(130px, 1fr) minmax(180px, 1.4fr) 100px";
  return (
    <section aria-labelledby="fc-hist" style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <b id="fc-hist" style={{ fontSize: 16 }}>Історія оплат</b>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {[3, 6, 12, 0].map((n) => <button key={n} type="button" aria-pressed={months === n} style={pill(months === n)} onClick={() => setMonths(n)}>{n ? `${n} міс.` : "усе"}</button>)}
          <button type="button" className="hr-btn" onClick={excel}>Завантажити Excel</button>
        </div>
      </div>
      <div role="group" aria-label="Яка оплата" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button type="button" aria-pressed={item === "all"} style={pill(item === "all")} onClick={() => setItem("all")}>Усі оплати</button>
        {data.items.map((i) => <button key={i.id} type="button" aria-pressed={item === i.id} style={pill(item === i.id)} onClick={() => setItem(i.id)}>{i.name}</button>)}
      </div>
      <span style={{ fontSize: 13.5, fontVariantNumeric: "tabular-nums" }}>
        {months ? `За ${months} міс.` : "За весь час"}: {oplat(live.length)} · {money(live.reduce((a, p) => a + p.amount, 0))} · проти плану {Math.abs(dev) < 1 ? "0 ₴" : `${dev > 0 ? "+" : "−"}${money(Math.abs(dev))}`}
        {rows.length > live.length && <span className="hr-muted"> · скасованих позначок {rows.length - live.length}</span>}
      </span>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 760 }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, ...label, padding: "4px 0" }}>
            <span>Місяць</span><span>Оплата</span><span style={{ textAlign: "right" }}>Сплачено</span><span>Проти плану</span><span>Хто позначив</span><span />
          </div>
          {[...groups.entries()].map(([g, list]) => (
            <Fragment key={g}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "10px 0 4px", borderTop: "1px solid var(--border-strong)" }}>
                <b style={{ fontSize: 13.5 }}>{MONF[+g.slice(5, 7) - 1]} {g.slice(0, 4)}</b>
                <span className="hr-muted" style={{ fontSize: 12.5 }}>{oplat(list.filter((p) => !p.cancelledAt).length)} · {money(list.filter((p) => !p.cancelledAt).reduce((a, p) => a + p.amount, 0))}</span>
              </div>
              {list.map((p) => {
                const dv = p.amount - p.planned, x = p.cancelledAt ? { textDecoration: "line-through", color: MUTED } as React.CSSProperties : undefined;
                return (
                  <div key={p.id} style={{ display: "grid", gridTemplateColumns: cols, gap: 12, alignItems: "center", padding: "5px 0", borderTop: "1px solid var(--border)", fontSize: 13.5 }}>
                    <span style={{ ...x, fontVariantNumeric: "tabular-nums" }}>{p.due.slice(5, 7)}.{p.due.slice(0, 4)}</span>
                    <b style={x}>{p.name}</b>
                    <b style={{ ...x, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(p.amount)}</b>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: Math.abs(dv) < 1 ? MUTED : dv > 0 ? "#8a5300" : "#1e7a3c" }}>{Math.abs(dv) < 1 ? "за планом" : `${dv > 0 ? "+" : "−"}${money(Math.abs(dv))} ${dv > 0 ? "більше" : "менше"}`}</span>
                    <span className="hr-muted" style={{ fontSize: 12.5 }}>
                      {p.by ?? "—"}, {at(p.at)}
                      {p.cancelledAt && <><br />скасовано: {p.cancelledBy ?? "?"}, {at(p.cancelledAt)}</>}
                    </span>
                    <span style={{ textAlign: "right" }}>{p.canUndo && <button type="button" className="hr-btn xs" disabled={busy} onClick={() => undo(p.id, p.name)}>Скасувати</button>}</span>
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      {!rows.length && <p className="hr-muted" style={{ margin: 0 }}>За цей період оплат не позначено.</p>}
    </section>
  );
}
