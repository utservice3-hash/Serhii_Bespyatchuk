import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  fetchFinKpiPeriod, fetchFinKpiCard, saveFinKpiValues, saveFinKpiNote, setFinKpiClosed, createFinKpi, updateFinKpi, deleteFinKpi,
  restoreFinKpi, setFinKpiOff, finErrorData, hiringError,
  type FinKpiPeriod, type FinKpi, type FinKpiCard, type FinPeriodKind, type FinKpiRefSource, type FinKpiThing,
} from "../../../api";
import { asInput } from "./financeView";

/**
 * 💰 «ТИЖДЕНЬ І МІСЯЦЬ» (прохід 2а, 01.10.2026) — аркуш «ФМ» у дашборді. Показники вносяться руками; «Комісійні» й
 * «Разом» рахуються самі; біля рядків «Поставлені», «По вигрузці» й «Дебіторка» — ДОВІДКА з CRM / 1С поруч, яка
 * число не підміняє. Закритий період незмінний (відкривається тією ж кнопкою). Що дозволено — каже сервер (`canEdit`).
 */
type Toast = (text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }) => void;
type Field = { id: string; label: string; value?: string; type?: "text" | "select"; options?: [string, string][] };
type DialogButton = { label: string; tone?: "p" | "dg"; run?: (v: Record<string, string>) => Promise<boolean | void> | boolean | void };
type Ask = (d: { title: string; text?: string; fields?: Field[]; buttons: DialogButton[] }) => void;
const CANCEL: DialogButton = { label: "Скасувати" };

const money = (v: number | null | undefined, unit = "UAH") =>
  v == null ? "—" : `${v.toLocaleString("uk-UA", { maximumFractionDigits: 2 })}${unit === "USD" ? " $" : unit === "EUR" ? " €" : ""}`;
const fmtTs = (ts: string) => new Date(ts).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const kyivToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
const shift = (kind: FinPeriodKind, start: string, n: number) => {
  const d = new Date(`${start}T00:00:00Z`);
  if (kind === "week") d.setUTCDate(d.getUTCDate() + 7 * n); else { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); }
  return d.toISOString().slice(0, 10);
};
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const title = (p: FinKpiPeriod) => (p.kind === "week" ? `Тиждень ${p.label}` : `${MONTHS[Number(p.start.slice(5, 7)) - 1]} ${p.start.slice(0, 4)}`);

/** Як рахується довідка — підпис поруч із числом (правило: дві різні величини без підпису читаються як поломка). */
export const REF_HINT: Record<FinKpiRefSource, string> = {
  delivered_income: "Фільтр фінансиста в Kommo: «Повний цикл», 8 етапів від «Контролю перед завантаженням» до «Успішної», «Дата загрузки» в періоді; сума «Приход 1–5»",
  delivered_expense: "Ті самі угоди; сума «Расход 1–5», крім типу оплати «Оплата на выгрузке»",
  unloaded_income: "Два фільтри фінансиста: «Очікуємо оплату» / «Оплата отримана» за датою створення + «Успішна» за датою закриття; сума «Приход 1–5»",
  unloaded_expense: "Ті самі два фільтри; сума «Расход 1–5», крім типу оплати «Оплата на выгрузке»",
  receivables: "Дебіторка в дашборді ЗАРАЗ (знімок без історії) — фіксується в ніч після кінця періоду",
};

/** Підпис автоматичного рядка: звідки зараз число. */
const AUTO_STATE: Record<NonNullable<FinKpi["autoState"]>, [string, string]> = {
  live: ["авто · наживо", "Рахується з CRM зараз; у ніч після кінця періоду зафіксується й більше не змінюватиметься"],
  frozen: ["авто · зафіксовано", "Число зафіксовано після кінця періоду; CRM могла змінитись після цього — поточне видно в довідці"],
  closed: ["з «ФМ»", "Період закрито; число перенесене з аркуша «ФМ»"],
  saved: ["збережене", "Живого числа для цього періоду немає — показано збережене"],
};

export function FinanceWeekTab({ ask, toast }: { ask: Ask; toast: Toast }) {
  const [kind, setKind] = useState<FinPeriodKind>("week");
  const [p, setP] = useState(kyivToday);
  const [data, setData] = useState<FinKpiPeriod | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [bad, setBad] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetchFinKpiPeriod(kind, p).then((d) => { if (live) { setData(d); setErr(null); } }).catch((e) => { if (live) setErr(hiringError(e)); });
    return () => { live = false; };
  }, [kind, p, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const changed = Object.keys(draft);
  const leave = (fn: () => void) => () => {
    if (edit && changed.length && !window.confirm("Є незбережені зміни. Вийти без збереження?")) return;
    setEdit(false); setDraft({}); setBad(new Set()); fn();
  };
  const undo = (k: FinKpiThing, id: number, text: string) =>
    toast(text, { action: { label: "Повернути", run: () => { restoreFinKpi(k, id).then(() => { reload(); toast("Повернуто"); }).catch((e) => toast(hiringError(e), { error: true })); } } });

  const act = useMemo(() => {
    const sections = data?.sections ?? [];
    const nameDialog = (t: string, label: string, value: string, save: (n: string) => Promise<unknown>, ok: string) => ask({
      title: t, fields: [{ id: "n", label, value }],
      buttons: [CANCEL, { label: value ? "Зберегти" : "Додати", tone: "p", run: async (v) => { await save(v.n); reload(); toast(ok); } }],
    });
    return {
      addSection: () => nameDialog("Новий розділ", "Назва розділу (напр. «Гроші»)", "", (n) => createFinKpi("section", { name: n }), "Розділ додано"),
      renameSection: (s: { id: number; name: string }) => nameDialog("Перейменувати розділ", "Назва", s.name, (n) => updateFinKpi("section", s.id, { name: n }), "Перейменовано"),
      delSection: async (s: { id: number; name: string }) => {
        try { await deleteFinKpi("section", s.id); reload(); undo("section", s.id, `Розділ «${s.name}» видалено`); }
        catch (e) { ask({ title: "Не можна видалити", text: hiringError(e), buttons: [{ label: "Зрозуміло", tone: "p" }] }); }
      },
      addKpi: (s: { id: number; name: string; kpis: FinKpi[] }) => ask({
        title: `Новий показник · ${s.name}`,
        fields: [
          { id: "n", label: "Назва показника" },
          { id: "kind", label: "Як рахується", type: "select", value: "manual", options: [["manual", "Вносять руками"], ["sum", "Сума інших показників розділу"], ["diff", "Різниця двох показників"]] },
          { id: "a", label: "Для різниці: від чого", type: "select", value: "", options: [["", "—"], ...s.kpis.map((k) => [String(k.id), k.name] as [string, string])] },
          { id: "b", label: "Для різниці: мінус що", type: "select", value: "", options: [["", "—"], ...s.kpis.map((k) => [String(k.id), k.name] as [string, string])] },
          { id: "unit", label: "Валюта", type: "select", value: "UAH", options: [["UAH", "гривня"], ["USD", "долар"], ["EUR", "євро"]] },
        ],
        buttons: [CANCEL, { label: "Додати", tone: "p", run: async (v) => {
          await createFinKpi("kpi", { sectionId: s.id, name: v.n, kind: v.kind, unit: v.unit, ...(v.kind === "diff" ? { argA: Number(v.a), argB: Number(v.b) } : {}) });
          reload(); toast("Показник додано");
        } }],
      }),
      renameKpi: (k: FinKpi) => nameDialog("Перейменувати показник", "Назва", k.name, (n) => updateFinKpi("kpi", k.id, { name: n }), "Перейменовано"),
      moveKpi: (k: FinKpi, from: number) => ask({
        title: `Перенести «${k.name}»`, fields: [{ id: "to", label: "До розділу", type: "select", value: String(from), options: sections.map((s) => [String(s.id), s.name]) }],
        buttons: [CANCEL, { label: "Перенести", tone: "p", run: async (v) => { if (Number(v.to) === from) return; await updateFinKpi("kpi", k.id, { sectionId: Number(v.to) }); reload(); toast("Показник перенесено"); } }],
      }),
      toggleKpi: async (k: FinKpi) => {
        try {
          const r = await setFinKpiOff(k.id, k.offFrom == null); reload();
          toast(r.offFrom ? `Показник вимкнено з ${r.offFrom.split("-").reverse().join(".")} — минулі періоди не змінились` : "Показник увімкнено");
        } catch (e) { toast(hiringError(e), { error: true }); }
      },
      delKpi: async (k: FinKpi) => {
        const go = async (confirm: boolean) => { await deleteFinKpi("kpi", k.id, confirm); reload(); undo("kpi", k.id, `Показник «${k.name}» видалено`); };
        try { await go(false); } catch (e) {
          const r = finErrorData(e);
          if (r?.status !== 409 || r.data?.periods == null) { ask({ title: "Не можна видалити", text: hiringError(e), buttons: [{ label: "Зрозуміло", tone: "p" }] }); return; }
          ask({ title: `Видалити «${k.name}»?`, text: `У показника є значення за ${r.data.periods} періодів. Краще вимкнути: із наступних періодів зникне, історія лишиться.`,
            buttons: [CANCEL, { label: "Видалити з історією", tone: "dg", run: () => go(true) }] });
        }
      },
    };
  }, [data, ask, toast, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!data || !changed.length) { setEdit(false); return; }
    setBusy(true);
    try {
      const r = await saveFinKpiValues(data.kind, data.start, changed.map((id) => ({ kpiId: Number(id), value: draft[Number(id)] })));
      setEdit(false); setDraft({}); setBad(new Set()); reload();
      toast(r.changed ? `Збережено змін: ${r.changed}` : "Змін немає");
    } catch (e) {
      const list = (finErrorData(e)?.data?.bad as number[] | undefined) ?? [];
      if (list.length) setBad(new Set(list));
      toast(hiringError(e), { error: true });
    } finally { setBusy(false); }
  };
  const close = (on: boolean) => {
    if (!data) return;
    ask({
      title: on ? `Закрити ${data.kind === "week" ? "тиждень" : "місяць"} ${data.label}?` : `Відкрити ${data.label}?`,
      text: on ? "Цифри цього періоду стануть незмінними. Відкрити можна тією ж кнопкою — і це буде видно в історії." : "Цифри знову можна буде змінювати.",
      buttons: [CANCEL, { label: on ? "Закрити" : "Відкрити", tone: "p", run: async () => { await setFinKpiClosed(data.kind, data.start, on); reload(); toast(on ? "Період закрито" : "Період відкрито"); } }],
    });
  };

  if (err && !data) return <div className="chart-card"><span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Завантаження…</p>;
  const isCurrent = data.start === data.current;
  return (
    <div className="hr-card">
      <div className="hd">
        <div className="hr-daynav" style={{ marginBottom: 0 }}>
          <div className="hr-seg" role="group" aria-label="Період">
            {(["week", "month"] as const).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={leave(() => { setKind(k); setP(kyivToday()); })}>{k === "week" ? "Тиждень" : "Місяць"}</button>
            ))}
          </div>
          <button className="hr-btn xs" onClick={leave(() => setP(shift(data.kind, data.start, -1)))} aria-label="Попередній період">‹</button>
          <b style={{ minWidth: 170, textAlign: "center" }}>{title(data)}</b>
          <button className="hr-btn xs" onClick={leave(() => setP(shift(data.kind, data.start, 1)))} aria-label="Наступний період">›</button>
          {!isCurrent && <button className="hr-btn xs" onClick={leave(() => setP(kyivToday()))}>поточний</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {data.closed ? <span className="hr-pill ok" title={fmtTs(data.closed.at)}>закрито{data.closed.by ? ` · ${data.closed.by}` : data.closed.note ? ` · ${data.closed.note}` : ""}</span>
            : <span className="hr-pill wn">{isCurrent ? "триває" : "відкрито"}</span>}
          {data.importedInterim && <span className="hr-pill pl" title="У таблиці «ФМ» для цього періоду були лише проміжні цифри — фінальних Тетяна ще не вносила">проміжні з «ФМ»</span>}
          {data.canEdit && !edit && <button className="hr-btn xs" onClick={() => close(!data.closed)}>{data.closed ? "Відкрити період" : `Закрити ${data.kind === "week" ? "тиждень" : "місяць"}`}</button>}
          {data.canEdit && !edit && !data.closed && <button className="hr-btn p" onClick={() => setEdit(true)}>Вносити цифри</button>}
        </div>
      </div>
      {edit && (
        <div className="fin-editbar">
          <b>Внесення · {data.label}</b>
          <span>Змінені клітинки підсвічуються. Порожня — «не внесено», не нуль. «Комісійні» й «Разом» рахуються самі.</span>
          <span style={{ flex: 1 }} />
          <span>змін: {changed.length}</span>
          <button className="hr-btn" disabled={busy} onClick={leave(() => undefined)}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>Зберегти</button>
        </div>
      )}
      <div className="hr-tw">
        <table className="hr-table fin-table">
          <thead><tr><th>Показник</th><th className="num">{data.prevLabel}</th><th className="num">{data.label}</th><th className="num">Зміна</th><th>Довідка CRM / 1С</th><th>Нотатка</th>{data.canEdit && !edit && <th className="num">Дії</th>}</tr></thead>
          <tbody>
            {data.sections.map((s) => (
              <SectionRows key={s.id} s={s} canEdit={data.canEdit && !edit} act={act}>
                {s.kpis.filter((k) => k.active || k.value != null).map((k) => {
                  const d = k.value != null && k.prevValue != null ? k.value - k.prevValue : null;
                  const input = edit && k.kind === "manual" && k.active;
                  const cur = draft[k.id] ?? asInput(k.value);
                  return (
                    <tr key={k.id} className={`it ${k.active ? "" : "off"}`} onClick={() => !edit && setCard(k.id)}>
                      <td className="ind1">{k.name}{(k.kind === "sum" || k.kind === "diff") && <span className="hr-muted" style={{ fontSize: 11, marginLeft: 6 }}>{k.kind === "sum" ? "сума" : "різниця"}</span>}
                        {k.kind === "auto" && <span className={`hr-pill ${k.autoState === "live" ? "pl" : ""}`} style={{ fontSize: 11, marginLeft: 6 }}
                          title={k.autoState ? AUTO_STATE[k.autoState][1] : "Рахується з CRM; для цього періоду числа немає"}>{k.autoState ? AUTO_STATE[k.autoState][0] : "авто"}</span>}</td>
                      <td className="num hr-muted">{money(k.prevValue, k.unit)}</td>
                      <td className="num">{input
                        ? <input className={`fin-cell ${draft[k.id] !== undefined ? "ch" : ""} ${bad.has(k.id) ? "bad" : ""}`} inputMode="decimal" aria-label={`${k.name}: ${data.label}`}
                            value={cur} onClick={(e) => e.stopPropagation()}
                            onChange={(e) => { const v = e.target.value; setDraft((dr) => { const n = { ...dr }; if (v === asInput(k.value)) delete n[k.id]; else n[k.id] = v; return n; }); }} />
                        : <b>{money(k.value, k.unit)}</b>}</td>
                      <td className="num">{d == null ? "—" : <span className={d < 0 ? "fin-bad" : "fin-good"}>{d > 0 ? "+" : d < 0 ? "−" : ""}{money(Math.abs(d), k.unit)}</span>}</td>
                      <td><RefCell k={k} /></td>
                      <td>{k.note ? <span className="hr-pill pl" title={k.note}>{k.note.length > 24 ? `${k.note.slice(0, 24)}…` : k.note}</span> : null}</td>
                      {data.canEdit && !edit && <td className="num" onClick={(e) => e.stopPropagation()}><span className="acts">
                        <button className="hr-btn xs" onClick={() => act.renameKpi(k)} aria-label={`Перейменувати ${k.name}`}>✎</button>
                        <button className="hr-btn xs" onClick={() => act.moveKpi(k, s.id)} aria-label={`Перенести ${k.name}`}>⇄</button>
                        <button className="hr-btn xs" onClick={() => void act.toggleKpi(k)} aria-label={k.offFrom ? `Увімкнути ${k.name}` : `Вимкнути ${k.name}`}>{k.offFrom ? "▶" : "⊘"}</button>
                        <button className="hr-btn xs" style={{ color: "var(--danger)" }} onClick={() => void act.delKpi(k)} aria-label={`Видалити ${k.name}`}>🗑</button>
                      </span></td>}
                    </tr>
                  );
                })}
              </SectionRows>
            ))}
            {!data.sections.length && <tr><td colSpan={7} className="hr-muted" style={{ padding: 16 }}>Показників ще немає. Їх переносимо з аркуша «ФМ»; можна додати й вручну — «+ Розділ».</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="hr-sect hr-muted" style={{ fontSize: 12.5, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span>Тиждень — з понеділка по неділю за Києвом. Рядки «авто» рахуються за фільтрами Kommo і фіксуються в ніч після кінця періоду — далі CRM може змінитись, а число тижня ні. Довідка CRM / 1С біля ручних рядків не підміняє внесене число.</span>
        {data.canEdit && !edit && <button className="fin-link" onClick={act.addSection}>+ Розділ</button>}
      </div>
      {card != null && <KpiDrawer id={card} kind={data.kind} periodStart={data.start} closed={!!data.closed} canEdit={data.canEdit} toast={toast} onChanged={reload} onClose={() => setCard(null)} />}
    </div>
  );
}

function SectionRows({ s, canEdit, act, children }: { s: { id: number; name: string; kpis: FinKpi[] }; canEdit: boolean;
  act: { addKpi: (s: { id: number; name: string; kpis: FinKpi[] }) => void; renameSection: (s: { id: number; name: string }) => void; delSection: (s: { id: number; name: string }) => Promise<void> };
  children: ReactNode }) {
  return (<>
    <tr className="resp" style={{ cursor: "default" }}>
      <td colSpan={canEdit ? 6 : 6}>{s.name}</td>
      {canEdit && <td className="num"><span className="acts">
        <button className="hr-btn xs" onClick={() => act.addKpi(s)}>+ показник</button>
        <button className="hr-btn xs" onClick={() => act.renameSection(s)} aria-label={`Перейменувати ${s.name}`}>✎</button>
        <button className="hr-btn xs" style={{ color: "var(--danger)" }} onClick={() => void act.delSection(s)} aria-label={`Видалити ${s.name}`}>🗑</button>
      </span></td>}
    </tr>
    {children}
  </>);
}

/** Довідка: живе число (для дебіторки — лише в поточному періоді) і збережене при внесенні; різниця з числом людини. */
function RefCell({ k }: { k: FinKpi }) {
  if (!k.refSource) return null;
  // Авто-рядок: число І є ядро. Довідка має сенс лише тоді, коли показане не живе — тоді видно, куди CRM поїхала після.
  if (k.kind === "auto") {
    const now = k.autoState !== "live" ? k.liveRef : null;
    const d = now != null && k.value != null ? k.value - now : null;
    return (
      <span title={REF_HINT[k.refSource]} style={{ fontSize: 12.5 }}>
        {now != null ? <span>у CRM зараз {money(now)}{d ? <span className="hr-muted"> ({d > 0 ? "−" : "+"}{money(Math.abs(d))})</span> : null}</span>
          : <span className="hr-muted">фільтр Kommo</span>}
      </span>
    );
  }
  const live = k.liveRef, saved = k.savedRef;
  const diff = (r: number) => (k.value == null ? null : k.value - r);
  const pct = (r: number) => (k.value == null || !r ? "" : ` (${k.value >= r ? "+" : "−"}${Math.abs(Math.round(((k.value - r) / r) * 1000) / 10)}%)`);
  return (
    <span title={REF_HINT[k.refSource]} style={{ fontSize: 12.5 }}>
      {live != null && <span>зараз {money(live)}{diff(live) != null && <span className="hr-muted">{pct(live)}</span>}</span>}
      {saved && <span className="hr-muted">{live != null ? " · " : ""}при внесенні {money(saved.value)}</span>}
      {live == null && !saved && <span className="hr-muted">—</span>}
    </span>
  );
}

function KpiDrawer({ id, kind, periodStart, closed, canEdit, toast, onChanged, onClose }: {
  id: number; kind: FinPeriodKind; periodStart: string; closed: boolean; canEdit: boolean; toast: Toast; onChanged: () => void; onClose: () => void;
}) {
  const [card, setCard] = useState<FinKpiCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetchFinKpiCard(id, kind).then((c) => { setCard(c); setNote(c.periods.find((x) => x.start === periodStart)?.note ?? ""); }).catch((e) => setErr(hiringError(e)));
  }, [id, kind, periodStart]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  const saveNote = async () => {
    setBusy(true);
    try { await saveFinKpiNote(id, kind, periodStart, note); onChanged(); toast(note.trim() ? "Нотатку збережено" : "Нотатку прибрано"); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <aside className="hr-drawer" role="dialog" aria-label="Картка показника" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <div><div className="hr-muted">{card?.section ?? "Показник"}</div><h2 style={{ margin: "2px 0 12px", fontSize: 19 }}>{card?.name ?? "…"}</h2></div>
          <button className="hr-btn xs" onClick={onClose} aria-label="Закрити картку">×</button>
        </div>
        {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
        {!card && !err && <p className="loading-text">Завантаження…</p>}
        {card && (<>
          {card.refSource && <div className="hr-note" style={{ marginTop: 0, marginBottom: 10 }}>Довідка: {REF_HINT[card.refSource as FinKpiRefSource]}</div>}
          <label className="hr-muted" style={{ fontSize: 12.5 }} htmlFor="fin-kpi-note">Нотатка до періоду (напр. сума у валюті)</label>
          <textarea id="fin-kpi-note" className="hr-inp" style={{ width: "100%", minHeight: 60, boxSizing: "border-box", marginTop: 4 }} disabled={!canEdit || closed}
            value={note} onChange={(e) => setNote(e.target.value)} placeholder={closed ? "Період закрито" : ""} />
          {canEdit && !closed && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}><button className="hr-btn p xs" disabled={busy} onClick={() => void saveNote()}>Зберегти нотатку</button></div>}
          <div className="hr-sect" style={{ padding: "14px 0 0" }}>
            <h4>Останні {kind === "week" ? "тижні" : "місяці"}</h4>
            <table className="hr-table"><tbody>{card.periods.map((x) => (
              <tr key={x.start}><td>{x.start.split("-").reverse().join(".")}</td><td className="num">{money(x.value)}</td><td className="hr-muted">{x.note ?? ""}</td></tr>))}
              {!card.periods.length && <tr><td className="hr-muted">Значень ще немає.</td></tr>}</tbody></table>
          </div>
          <div className="hr-sect" style={{ padding: "14px 0 0" }}>
            <h4>Історія змін</h4>
            {card.log.length ? <ul className="hr-hist">{card.log.map((l, i) => <li key={i}>{l.what} <span className="hr-muted">· {l.actor ?? "система"} · {fmtTs(l.at)}</span></li>)}</ul>
              : <p className="hr-muted" style={{ fontSize: 12.5, margin: 0 }}>Змін ще не було.</p>}
          </div>
        </>)}
      </aside>
    </div>, document.body);
}
