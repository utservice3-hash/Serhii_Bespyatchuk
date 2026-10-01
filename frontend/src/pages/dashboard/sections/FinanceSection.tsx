import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useToast, type Toast } from "../../../components/Toasts";
import {
  fetchFinMonth, fetchFinItem, createFin, updateFin, deleteFin, restoreFin, setFinItemOff, saveFinValues, saveFinNote,
  setFinApproval, finErrorData, hiringError,
  type FinMonth, type FinItem, type FinGroup, type FinResp, type FinItemCard, type FinKind, type FinCell,
} from "../../../api";
import { rowVisible, asInput, planFromPrevious } from "./financeView";
import { FinanceWeekTab } from "./FinanceWeekTab";
import "./hiring.css";
import "./finance.css";

/**
 * 💰 «ФІНАНСИ», прохід 1 (29.09.2026): «План/факт витрат» і «Статті».
 * Те, що фінансист вела в Excel-таблиці «Витрати План/Факт», вноситься тут. Макет затверджено 28.09.2026
 * (artifact TjMcb2LTWjpGjojH1sAMwv). Що дозволено — вирішує СЕРВЕР (`canEdit`/`canApprove` у відповіді),
 * тут лише рендер. «Тиждень і місяць», «Каса» й «Огляд» — наступні проходи; до того їхні вкладки
 * пояснюють, що буде (той самий прийом, що в «Бізнес-асистенті»).
 * Стилі — `hiring.css` (`.hr-*`) + `finance.css` (`.fin-*`).
 */
type Tab = "pf" | "art" | "week" | "cash" | "overview";

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const monthShort = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3).toLowerCase()}.`;
const addMonths = (m: string, n: number) => {
  const k = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-01`;
};
const kyivMonthNow = () => `${new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7)}-01`;
const money = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));
const fmtTs = (ts: string) => new Date(ts).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const LS_TAB = "fin.tab";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* приватне вікно */ } };

// ── Діалог: поля + кнопки. Кнопка повертає false — діалог лишається відкритим. ────────
type Field = { id: string; label: string; value?: string; type?: "text" | "select"; options?: [string, string][]; placeholder?: string };
type DialogButton = { label: string; tone?: "p" | "dg"; run?: (v: Record<string, string>) => Promise<boolean | void> | boolean | void };
interface DialogSpec { title: string; text?: string; fields?: Field[]; buttons: DialogButton[] }

function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((spec.fields ?? []).map((f) => [f.id, f.value ?? ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscape(onClose);
  const press = async (b: DialogButton) => {
    if (!b.run) { onClose(); return; }
    setBusy(true); setErr(null);
    try { if ((await b.run(vals)) !== false) onClose(); } catch (e) { setErr(hiringError(e)); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="hr-modal-back" onClick={onClose}>
      <div className="hr-modal" role="dialog" aria-label={spec.title} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{spec.title}</h3>
        {spec.text && <p style={{ margin: "0 0 10px", fontSize: 13 }}>{spec.text}</p>}
        {(spec.fields ?? []).map((f, i) => (
          <label key={f.id} className="hr-muted" style={{ display: "block", marginBottom: 10, fontSize: 12.5 }}>{f.label}<br />
            {f.type === "select"
              ? <select className="hr-inp" style={{ width: "100%" }} value={vals[f.id]} onChange={(e) => setVals((v) => ({ ...v, [f.id]: e.target.value }))}>
                  {(f.options ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              : <input className="hr-inp" style={{ width: "100%", boxSizing: "border-box" }} autoFocus={i === 0} placeholder={f.placeholder}
                  value={vals[f.id]} onChange={(e) => setVals((v) => ({ ...v, [f.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") { const p = spec.buttons.find((b) => b.tone === "p"); if (p) void press(p); } }} />}
          </label>
        ))}
        {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)", marginTop: 0, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          {spec.buttons.map((b) => <button key={b.label} className={`hr-btn ${b.tone ?? ""}`} disabled={busy} onClick={() => void press(b)}>{b.label}</button>)}
        </div>
      </div>
    </div>, document.body);
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

const CANCEL: DialogButton = { label: "Скасувати" };

// ── Дії зі структурою — спільні для «План/факт» і «Статей» ─────────────────────────
function useStructureActions(data: FinMonth | null, reload: () => void, ask: (d: DialogSpec) => void, toast: Toast) {
  return useMemo(() => {
    const tree = data?.tree ?? [];
    const undo = (kind: FinKind, id: number, text: string) =>
      toast(text, { action: { label: "Повернути", run: () => { restoreFin(kind, id).then(() => { reload(); toast("Повернуто"); }).catch((e) => toast(hiringError(e), { error: true })); } } });
    const nameDialog = (title: string, label: string, value: string, save: (n: string) => Promise<unknown>, ok: string, text?: string) => ask({
      title, text, fields: [{ id: "n", label, value }],
      buttons: [CANCEL, { label: value ? "Зберегти" : "Додати", tone: "p", run: async (v) => { await save(v.n); reload(); toast(ok); } }],
    });
    const groupOptions = (): [string, string][] => tree.flatMap((r) => r.groups.map((g) => [String(g.id), `${g.name} · ${r.name}`] as [string, string]));
    return {
      addResp: () => nameDialog("Новий відповідальний", "Назва (напр. «Керівник відділу продажів»)", "", (n) => createFin("resp", { name: n }), "Відповідального додано — тепер додайте йому групу"),
      renameResp: (r: FinResp) => nameDialog("Перейменувати відповідального", "Назва", r.name, (n) => updateFin("resp", r.id, { name: n }), "Перейменовано"),
      delResp: async (r: FinResp) => {
        try { await deleteFin("resp", r.id); reload(); undo("resp", r.id, `Відповідального «${r.name}» видалено`); }
        catch (e) { ask({ title: "Не можна видалити", text: hiringError(e), buttons: [{ label: "Зрозуміло", tone: "p" }] }); }
      },
      addGroup: (r: FinResp) => nameDialog(`Нова група · ${r.name}`, "Назва групи (напр. «Транспорт»)", "", (n) => createFin("group", { respId: r.id, name: n }), "Групу додано"),
      renameGroup: (g: FinGroup) => nameDialog("Перейменувати групу", "Назва", g.name, (n) => updateFin("group", g.id, { name: n }), "Перейменовано"),
      moveGroup: (g: FinGroup, from: FinResp) => ask({
        title: `Перенести групу «${g.name}»`, fields: [{ id: "to", label: "До відповідального", type: "select", value: String(from.id), options: tree.map((r) => [String(r.id), r.name]) }],
        buttons: [CANCEL, { label: "Перенести", tone: "p", run: async (v) => { if (Number(v.to) === from.id) return; await updateFin("group", g.id, { respId: Number(v.to) }); reload(); toast("Групу перенесено"); } }],
      }),
      delGroup: async (g: FinGroup) => {
        const go = async (confirm: boolean) => { await deleteFin("group", g.id, confirm); reload(); undo("group", g.id, `Групу «${g.name}» видалено`); };
        try { await go(false); } catch (e) {
          const r = finErrorData(e);
          if (r?.status !== 409) { toast(hiringError(e), { error: true }); return; }
          const withData = Number(r.data?.withData ?? 0);
          ask({ title: `Видалити групу «${g.name}»?`,
            text: withData ? `У групі статей: ${r.data?.items}, з них ${withData} мають цифри. Разом із групою вони зникнуть і з підсумків минулих місяців (повернути можна кнопкою «Повернути» одразу після видалення). Якщо група більше не потрібна — краще перенести статті або вимкнути їх.`
              : `У групі статей без цифр: ${r.data?.items}. Вони видаляться разом із групою.`,
            buttons: [CANCEL, { label: "Видалити разом зі статтями", tone: "dg", run: () => go(true) }] });
        }
      },
      addItem: (g: FinGroup, month: string) => ask({
        title: "Нова стаття", text: `Група «${g.name}»`,
        fields: [{ id: "n", label: "Назва статті (напр. «Курʼєрські послуги»)" }, { id: "p", label: `План на ${monthLabel(month).toLowerCase()} (можна пізніше)` }],
        buttons: [CANCEL, { label: "Додати", tone: "p", run: async (v) => { await createFin("item", { groupId: g.id, name: v.n, plan: v.p, month }); reload(); toast("Статтю додано"); } }],
      }),
      renameItem: (it: FinItem) => nameDialog("Перейменувати статтю", "Назва", it.name, (n) => updateFin("item", it.id, { name: n }), "Перейменовано", "Цифри й історія лишаться при статті."),
      moveItem: (it: FinItem, from: FinGroup) => ask({
        title: `Перенести «${it.name}»`, fields: [{ id: "to", label: "До групи", type: "select", value: String(from.id), options: groupOptions() }],
        buttons: [CANCEL, { label: "Перенести", tone: "p", run: async (v) => { if (Number(v.to) === from.id) return; await updateFin("item", it.id, { groupId: Number(v.to) }); reload(); toast("Статтю перенесено"); } }],
      }),
      toggleItem: async (it: FinItem) => {
        try {
          const r = await setFinItemOff(it.id, it.offFrom == null);
          reload();
          toast(r.offFrom ? `Статтю вимкнено з ${monthLabel(r.offFrom).toLowerCase()} — попередні місяці не змінились` : "Статтю увімкнено");
        } catch (e) { toast(hiringError(e), { error: true }); }
      },
      delItem: async (it: FinItem) => {
        const go = async (confirm: boolean) => { await deleteFin("item", it.id, confirm); reload(); undo("item", it.id, `Статтю «${it.name}» видалено`); };
        try { await go(false); } catch (e) {
          const r = finErrorData(e);
          if (r?.status !== 409) { toast(hiringError(e), { error: true }); return; }
          ask({ title: `Видалити «${it.name}»?`,
            text: `У статті є цифри за ${r.data?.months} міс. Якщо видалити — вони зникнуть і з підсумків минулих місяців. Якщо стаття більше не потрібна, її краще вимкнути: із наступних місяців зникне, історія лишиться.`,
            buttons: [CANCEL, { label: "Видалити з історією", tone: "dg", run: () => go(true) },
              ...(it.offFrom == null ? [{ label: "Вимкнути", tone: "p" as const, run: async () => { const x = await setFinItemOff(it.id, true); reload(); toast(`Статтю вимкнено з ${monthLabel(x.offFrom!).toLowerCase()}`); } }] : [])] });
        }
      },
    };
  }, [data, reload, ask, toast]);
}
type Actions = ReturnType<typeof useStructureActions>;

// ── Розділ ───────────────────────────────────────────────────────────────────
export function FinanceSection() {
  const [tab, setTab] = useState<Tab>(() => (["pf", "art", "week", "cash", "overview"].includes(lsGet(LS_TAB) ?? "") ? lsGet(LS_TAB) as Tab : "pf"));
  const [month, setMonth] = useState(kyivMonthNow);
  const [data, setData] = useState<FinMonth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetchFinMonth(month.slice(0, 7)).then((d) => { if (live) { setData(d); setErr(null); } }).catch((e) => { if (live) setErr(hiringError(e)); });
    return () => { live = false; };
  }, [month, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // 🔔 Спільне повідомлення дашборда (`components/Toasts.tsx`) — раніше тут жила своя копія.
  const toast: Toast = useToast();
  const ask = useCallback((d: DialogSpec) => setDialog(d), []);
  const act = useStructureActions(data, reload, ask, toast);
  const pick = (t: Tab) => { setTab(t); lsSet(LS_TAB, t); };

  if (err && !data) return <div className="chart-card"><b>Розділ «Фінанси» недоступний.</b> <span className="hr-muted">{err}</span></div>;
  if (!data) return <p className="loading-text">Завантаження…</p>;

  const tabs: [Tab, string, boolean][] = [["pf", "План/факт витрат", false], ["art", "Статті", false], ["week", "Тиждень і місяць", false], ["cash", "Каса", true], ["overview", "Огляд", true]];
  return (
    <div>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Фінанси</h1>
      <p className="hr-muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
        План і факт витрат по статтях — замість Excel-таблиці «Витрати План/Факт». Історію з січня 2026 перенесено з неї.
      </p>
      <div className="hr-tabs" role="tablist" aria-label="Блоки фінансів">
        {tabs.map(([k, l, soon]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => pick(k)}
            title={soon ? "Ще не зроблено — усередині пояснення, що буде" : undefined}>
            {l}{soon && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.75 }}>скоро</span>}
          </button>
        ))}
      </div>
      {tab === "pf" && <PlanFactTab data={data} month={month} setMonth={setMonth} act={act} reload={reload} toast={toast} ask={ask} sel={sel} setSel={setSel} />}
      {tab === "art" && <ArticlesTab data={data} act={act} />}
      {tab === "week" && <FinanceWeekTab ask={ask} toast={toast} />}
      {tab === "cash" && <PlannedCard title="Каса" will={[
        "Рух готівки по місцях зберігання (сейф) і валютах: прихід, видача, обмін — з коментарем.",
        "Залишок на дату рахується з руху, а не вноситься руками.",
      ]} waits="Проходу 3 — після «Тижня і місяця»." />}
      {tab === "overview" && <PlannedCard title="Огляд" will={[
        "Головні числа місяця на одному екрані: план/факт витрат, надходження, маржа, залишки.",
        "Графік за рік і статті, що найбільше вийшли за план.",
      ]} waits="Проходу 3 — коли будуть «Тиждень і місяць» і «Каса»." />}

      {sel != null && <ItemDrawer id={sel} month={month} canEdit={data.canEdit} act={act} data={data} reloadKey={nonce} toast={toast} onChanged={reload} onClose={() => setSel(null)} />}
      {dialog && <Dialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function PlannedCard({ title, will, waits }: { title: string; will: string[]; waits: string }) {
  return (
    <div className="hr-card">
      <div className="hd"><h3>{title} · наступний етап</h3></div>
      <div className="hr-sect" style={{ borderTop: 0 }}>
        <h4>Що тут буде</h4>
        <ul className="hr-hist">{will.map((w) => <li key={w}>{w}</li>)}</ul>
        <h4 style={{ marginTop: 12 }}>Чого чекаємо</h4>
        <p style={{ margin: 0, fontSize: 13 }}>{waits}</p>
      </div>
    </div>
  );
}

// ── План/факт ────────────────────────────────────────────────────────────────
function Execution({ it }: { it: FinItem }) {
  if (it.state === "over") return <><span className="fin-bar x"><i style={{ width: "100%" }} /></span><span className="fin-bad">{Math.round(it.fact! / it.plan! * 100)}%</span></>;
  if (it.state === "ok") return <><span className="fin-bar"><i style={{ width: `${Math.min(100, (it.fact ?? 0) / it.plan! * 100)}%` }} /></span>{Math.round((it.fact ?? 0) / it.plan! * 100)}%</>;
  if (it.state === "noplan") return <span className="hr-pill wn">без плану</span>;
  if (it.state === "nofact") return <span className="hr-muted">факту ще немає</span>;
  return <span className="hr-muted">—</span>;
}

function PlanFactTab({ data, month, setMonth, act, reload, toast, ask, sel, setSel }: {
  data: FinMonth; month: string; setMonth: (m: string) => void; act: Actions; reload: () => void; toast: Toast;
  ask: (d: DialogSpec) => void; sel: number | null; setSel: (id: number | null) => void;
}) {
  const [resp, setResp] = useState<number | "all">("all");
  const [onlyOver, setOnlyOver] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  const future = month > data.currentMonth;
  const current = month === data.currentMonth;
  const shownData = data.month === month ? data : null;
  const changedKeys = Object.keys(draft);
  const leave = (fn: () => void) => () => {
    if (edit && changedKeys.length && !window.confirm("Є незбережені зміни. Вийти без збереження?")) return;
    setEdit(false); setDraft({}); setBad(new Set()); fn();
  };
  const orig = (it: FinItem, f: "plan" | "fact") => asInput(it[f]);
  const onCell = (it: FinItem, f: "plan" | "fact", v: string) => setDraft((d) => {
    const k = `${it.id}:${f}`; const next = { ...d };
    if (v === orig(it, f)) delete next[k]; else next[k] = v;
    return next;
  });
  // «Взяти план із попереднього місяця»: лише чернетки в порожні клітинки плану; записує звичайне «Зберегти».
  const takePrevPlan = async () => {
    const prev = addMonths(month, -1);
    setBusy(true);
    try {
      const p = await fetchFinMonth(prev.slice(0, 7));
      const prevPlan = new Map(p.tree.flatMap((r) => r.groups.flatMap((g) => g.items.map((i) => [i.id, i.plan] as [number, number | null]))));
      const items = data.tree.flatMap((r) => r.groups.flatMap((g) => g.items));
      const add = planFromPrevious(items, prevPlan, draft);
      const n = Object.keys(add).length;
      setDraft((d) => ({ ...d, ...add }));
      toast(n ? `Підставлено план за ${monthLabel(prev).toLowerCase()}: статей ${n}. Перевірте й натисніть «Зберегти».`
        : `Нічого підставляти: за ${monthLabel(prev).toLowerCase()} немає плану для порожніх статей`);
    } catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!changedKeys.length) { setEdit(false); return; }
    const cells: FinCell[] = changedKeys.map((k) => { const [id, f] = k.split(":"); return { itemId: Number(id), field: f as "plan" | "fact", value: draft[k] }; });
    setBusy(true);
    try {
      const r = await saveFinValues(month.slice(0, 7), cells);
      setEdit(false); setDraft({}); setBad(new Set()); reload();
      toast(r.changed ? `Збережено змін: ${r.changed}` : "Змін немає");
    } catch (e) {
      const d = finErrorData(e);
      const list = (d?.data?.bad as { itemId: number; field: string }[] | undefined) ?? [];
      if (list.length) setBad(new Set(list.map((b) => `${b.itemId}:${b.field}`)));
      toast(hiringError(e), { error: true });
    } finally { setBusy(false); }
  };
  const approve = (on: boolean) => ask({
    title: on ? `Погодити план · ${monthLabel(month).toLowerCase()}` : "Зняти погодження плану?",
    text: on ? `План ${money(data.totals.plan)} ₴ по ${data.totals.items} статтях. Після погодження план можна змінювати й далі — кожна зміна буде видна поруч із позначкою «погоджено».`
      : "План знову стане чернеткою. Цифри не зміняться.",
    buttons: [CANCEL, { label: on ? "Погодити" : "Зняти", tone: "p", run: async () => { await setFinApproval(month.slice(0, 7), on); reload(); toast(on ? "План погоджено" : "Погодження знято"); } }],
  });

  if (!shownData) return <p className="loading-text">Завантаження…</p>;
  const t = data.totals;
  const left = t.plan - t.fact;
  const im = data.imported;
  const imDiff = im && ((im.filePlan != null && Math.abs(im.filePlan - im.rowsPlan) >= 0.01) || (im.fileFact != null && Math.abs(im.fileFact - im.rowsFact) >= 0.01));
  const visible = (it: FinItem) => rowVisible(it, { month, currentMonth: data.currentMonth, edit, onlyOver, showEmpty });
  let shown = 0;
  return (
    <div className="hr-card">
      <div className="hd">
        <div className="hr-daynav" style={{ marginBottom: 0 }}>
          <button className="hr-btn xs" onClick={leave(() => setMonth(addMonths(month, -1)))} aria-label="Попередній місяць">‹</button>
          <b style={{ minWidth: 130, textAlign: "center" }}>{monthLabel(month)}</b>
          <button className="hr-btn xs" onClick={leave(() => setMonth(addMonths(month, 1)))} aria-label="Наступний місяць">›</button>
          {!current && <button className="hr-btn xs" onClick={leave(() => setMonth(data.currentMonth))}>поточний</button>}
          <select className="hr-inp" value={String(resp)} onChange={(e) => setResp(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Відповідальний">
            <option value="all">Усі відповідальні</option>
            {data.tree.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label className="hr-muted" style={{ fontSize: 13 }}><input type="checkbox" checked={onlyOver} onChange={(e) => setOnlyOver(e.target.checked)} /> лише понад план</label>
          <label className="hr-muted" style={{ fontSize: 13 }}><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> показати порожні</label>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {data.approval
            ? <span className="hr-pill ok" title={fmtTs(data.approval.at)}>план погоджено{data.approval.by ? ` · ${data.approval.by}` : ""}</span>
            : <span className="hr-pill wn">план — чернетка</span>}
          {data.approval && data.approval.changedAfter > 0 && <span className="hr-pill dg">змін після погодження: {data.approval.changedAfter}</span>}
          {data.canApprove && <button className="hr-btn xs" onClick={() => approve(!data.approval)}>{data.approval ? "Зняти погодження" : "Погодити план"}</button>}
          {data.canEdit && !edit && <button className="hr-btn p" onClick={() => setEdit(true)}>Вносити план і факт</button>}
        </div>
      </div>
      <div className="hr-tiles">
        <div className="hr-tile"><div className="lb">План · {monthShort(month)}</div><div className="vl">{money(t.plan)} ₴</div><div className="sb">статей: {t.items}</div></div>
        <div className="hr-tile"><div className="lb">Факт</div><div className="vl">{future ? "—" : `${money(t.fact)} ₴`}</div>
          <div className="sb">{future ? "місяць не почався" : current ? "місяць триває" : "місяць закрито"}{t.plan && !future ? ` · ${Math.round(t.fact / t.plan * 100)}% плану` : ""}</div></div>
        <div className="hr-tile"><div className="lb">{left >= 0 ? "Лишилось" : "Понад план"}</div>
          <div className="vl" style={{ color: left < 0 ? "var(--danger)" : undefined }}>{future ? "—" : `${money(Math.abs(left))} ₴`}</div><div className="sb">план − факт</div></div>
        <div className="hr-tile"><div className="lb">Статей понад план</div><div className="vl">{future ? "—" : t.over}</div>
          <div className="sb">{future ? "" : `на ${money(t.overSum)} ₴`}{t.noplan && !future ? ` · ще ${t.noplan} без плану` : ""}</div></div>
      </div>
      {imDiff && im && (
        <div className="hr-sect" style={{ paddingTop: 10, paddingBottom: 10 }}>
          <div className="hr-note" style={{ marginTop: 0, background: "var(--warn-bg)", color: "var(--warn)" }}>
            <b>Підсумок у таблиці Excel розходився з сумою статей.</b> Там план {money(im.filePlan)} ₴, факт {money(im.fileFact)} ₴; сума рядків — план {money(im.rowsPlan)} ₴, факт {money(im.rowsFact)} ₴.
            Тут підсумок завжди рахується з рядків, тому число на плитці — сума статей.
          </div>
        </div>
      )}
      {edit && (
        <div className="fin-editbar">
          <b>Внесення · {monthLabel(month).toLowerCase()}</b>
          <span>Змінені клітинки підсвічуються. Порожня клітинка — «не внесено», не нуль.{future ? " Факт майбутнього місяця внести не можна." : ""}</span>
          <span style={{ flex: 1 }} />
          <button className="hr-btn" disabled={busy} onClick={() => void takePrevPlan()}
            title={`Підставить у порожні клітинки плану суми за ${monthLabel(addMonths(month, -1)).toLowerCase()}. Записується лише після «Зберегти».`}>Взяти план попереднього місяця</button>
          <span>змін: {changedKeys.length}</span>
          <button className="hr-btn" disabled={busy} onClick={leave(() => undefined)}>Скасувати</button>
          <button className="hr-btn p" disabled={busy} onClick={() => void save()}>Зберегти</button>
        </div>
      )}
      <div className="hr-tw">
        <table className="hr-table fin-table">
          <thead><tr><th>Стаття</th><th className="num">План</th><th className="num">Факт</th><th className="num">Різниця</th><th>Виконання</th><th>Чому</th></tr></thead>
          <tbody>
            {data.tree.filter((r) => resp === "all" || r.id === resp).map((r) => (
              <RespRows key={r.id} r={r} closed={!!closed[r.id]} toggle={() => setClosed((c) => ({ ...c, [r.id]: !c[r.id] }))}
                canEdit={data.canEdit} act={act}>
                {r.groups.map((g) => {
                  const items = g.items.filter(visible);
                  shown += items.length;
                  if (!items.length && (onlyOver || !data.canEdit)) return null;
                  return (
                    <GroupRows key={g.id} g={g}>
                      {items.map((it) => {
                        const d = (it.plan ?? 0) - (it.fact ?? 0);
                        const cell = (f: "plan" | "fact") => {
                          const k = `${it.id}:${f}`;
                          if (f === "fact" && future) return <span className="hr-muted">—</span>;
                          return <input className={`fin-cell ${draft[k] !== undefined ? "ch" : ""} ${bad.has(k) ? "bad" : ""}`} inputMode="decimal"
                            aria-label={`${f === "plan" ? "План" : "Факт"}: ${it.name}`} value={draft[k] ?? orig(it, f)}
                            onClick={(e) => e.stopPropagation()} onChange={(e) => onCell(it, f, e.target.value)} />;
                        };
                        return (
                          <tr key={it.id} className={`it ${it.state === "over" || it.state === "noplan" ? "over" : ""} ${sel === it.id ? "sel" : ""}`} tabIndex={0}
                            onClick={() => setSel(it.id)} onKeyDown={(e) => { if (e.key === "Enter" && !(e.target as HTMLElement).closest("input")) setSel(it.id); }}>
                            <td className="ind2">{it.name}</td>
                            <td className="num">{edit ? cell("plan") : it.plan == null ? <span className="hr-muted">не задано</span> : money(it.plan)}</td>
                            <td className="num">{edit ? cell("fact") : money(it.fact)}</td>
                            <td className="num">{it.state === "noplan" ? <span className="fin-bad">−{money(it.fact)}</span>
                              : it.plan == null || it.fact == null ? "—" : <span className={d < 0 ? "fin-bad" : "fin-good"}>{d > 0 ? "+" : d < 0 ? "−" : ""}{money(Math.abs(d))}</span>}</td>
                            <td style={{ whiteSpace: "nowrap" }}><Execution it={it} /></td>
                            <td>{it.note ? <span className="hr-pill pl" title={it.note}>● є</span> : it.state === "over" || it.state === "noplan" ? <span className="hr-muted">+ додати</span> : null}</td>
                          </tr>
                        );
                      })}
                      {data.canEdit && !onlyOver && !edit && (
                        <tr className="add"><td colSpan={6} className="ind2"><button className="fin-link" onClick={() => act.addItem(g, month)}>+ стаття в «{g.name}»</button></td></tr>
                      )}
                    </GroupRows>
                  );
                })}
              </RespRows>
            ))}
            {!data.tree.length && <tr><td colSpan={6} className="hr-muted" style={{ padding: 16 }}>Статей ще немає. Їх додають на вкладці «Статті».</td></tr>}
            {!!data.tree.length && !shown && onlyOver && <tr><td colSpan={6} className="hr-muted" style={{ padding: 16 }}>Статей понад план немає.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="hr-sect hr-muted" style={{ fontSize: 12.5 }}>
        Підсумок — завжди сума рядків, що діють у цьому місяці. Клік по рядку відкриває коментар, історію змін і дії зі статтею.
      </div>
    </div>
  );
}

function RespRows({ r, closed, toggle, canEdit, act, children }: { r: FinResp; closed: boolean; toggle: () => void; canEdit: boolean; act: Actions; children: ReactNode }) {
  return (<>
    <tr className="resp" onClick={toggle}>
      <td colSpan={6}>
        <span style={{ display: "inline-block", width: 16 }}>{closed ? "▸" : "▾"}</span>{r.name}
        {canEdit && <span style={{ float: "right" }}><button className="fin-link" onClick={(e) => { e.stopPropagation(); act.addGroup(r); }}>+ група</button></span>}
      </td>
    </tr>
    {!closed && children}
  </>);
}
function GroupRows({ g, children }: { g: FinGroup; children: ReactNode }) {
  return (<><tr className="grp"><td colSpan={6} className="ind1">{g.name}</td></tr>{children}</>);
}

// ── Картка статті ────────────────────────────────────────────────────────────
function ItemDrawer({ id, month, canEdit, act, data, reloadKey, toast, onChanged, onClose }: {
  id: number; month: string; canEdit: boolean; act: Actions; data: FinMonth; reloadKey: number; toast: Toast; onChanged: () => void; onClose: () => void;
}) {
  const [card, setCard] = useState<FinItemCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const year = Number(month.slice(0, 4));
  useEffect(() => {
    fetchFinItem(id, year).then((c) => { setCard(c); setNote(c.months.find((m) => m.month === month)?.note ?? ""); setErr(null); }).catch((e) => setErr(hiringError(e)));
  }, [id, year, month, reloadKey]);
  useEscape(onClose);

  // Рядок і його група — з дерева місяця (для дій); картка — з окремого запиту (рік, історія).
  const found = useMemo(() => {
    for (const r of data.tree) for (const g of r.groups) { const it = g.items.find((x) => x.id === id); if (it) return { r, g, it }; }
    return null;
  }, [data, id]);
  const cur = card?.months.find((m) => m.month === month);
  const saveNote = async () => {
    setBusy(true);
    try { await saveFinNote(id, month.slice(0, 7), note); onChanged(); toast(note.trim() ? "Коментар збережено" : "Коментар прибрано"); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  const mx = Math.max(1, ...(card?.months ?? []).map((m) => Math.max(m.plan ?? 0, m.fact ?? 0)));
  const over = cur && cur.fact != null && (cur.plan == null || cur.plan === 0 ? cur.fact > 0 : cur.fact > cur.plan);
  return createPortal(
    <div className="hr-overlay" onClick={onClose}>
      <aside className="hr-drawer" role="dialog" aria-label="Картка статті" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
          <div>
            <div className="hr-muted">{card ? `${card.resp.name} · ${card.group.name} · ${monthLabel(month).toLowerCase()}` : "Стаття"}</div>
            <h2 style={{ margin: "2px 0 12px", fontSize: 19 }}>{card?.name ?? "…"}</h2>
          </div>
          <button className="hr-btn xs" onClick={onClose} aria-label="Закрити картку">×</button>
        </div>
        {err && <div className="hr-note" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div>}
        {!card && !err && <p className="loading-text">Завантаження…</p>}
        {card && (<>
          {card.offFrom && <div className="hr-note" style={{ marginTop: 0, marginBottom: 10 }}>Стаття вимкнена з {monthLabel(card.offFrom).toLowerCase()}. Попередні місяці її цифри враховують.</div>}
          {canEdit && found && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              <button className="hr-btn xs" onClick={() => act.renameItem(found.it)}>✎ Перейменувати</button>
              <button className="hr-btn xs" onClick={() => act.moveItem(found.it, found.g)}>⇄ Перенести</button>
              <button className="hr-btn xs" onClick={() => void act.toggleItem(found.it)}>{found.it.offFrom ? "▶ Увімкнути" : "⊘ Вимкнути"}</button>
              <button className="hr-btn xs" style={{ color: "var(--danger)" }} onClick={() => { onClose(); void act.delItem(found.it); }}>🗑 Видалити</button>
            </div>
          )}
          <div className="fin-mm">
            <div><span>План</span><b>{money(cur?.plan)}</b></div>
            <div><span>Факт</span><b>{money(cur?.fact)}</b></div>
            <div><span>{over ? "Понад план" : "Різниця"}</span><b className={over ? "fin-bad" : ""}>{cur?.plan == null && cur?.fact == null ? "—" : money(Math.abs((cur?.plan ?? 0) - (cur?.fact ?? 0)))}</b></div>
          </div>
          <label className="hr-muted" style={{ fontSize: 12.5 }} htmlFor="fin-note">{over ? "Чому перевитрата?" : "Коментар"}</label>
          <textarea id="fin-note" className="hr-inp" style={{ width: "100%", minHeight: 70, boxSizing: "border-box", marginTop: 4 }} disabled={!canEdit}
            placeholder="Пояснення побачать усі, хто відкриє цю статтю" value={note} onChange={(e) => setNote(e.target.value)} />
          {canEdit && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}><button className="hr-btn p xs" disabled={busy} onClick={() => void saveNote()}>Зберегти коментар</button></div>}
          <div className="hr-sect" style={{ padding: "14px 0 0" }}>
            <h4>Факт по місяцях {year} · червоне — понад план</h4>
            <div className="fin-spark">{card.months.map((m) => (
              <div key={m.month} className={m.fact != null && m.plan != null && m.fact > m.plan ? "x" : ""} title={`${monthLabel(m.month)}: план ${money(m.plan)}, факт ${money(m.fact)}`}>
                <i style={{ height: `${((m.fact ?? 0) / mx) * 100}%` }} />
              </div>))}
            </div>
            <div className="fin-spark-l">{card.months.map((m) => <span key={m.month}>{MONTHS[Number(m.month.slice(5, 7)) - 1].slice(0, 3)}</span>)}</div>
          </div>
          <div className="hr-sect" style={{ padding: "14px 0 0" }}>
            <h4>Історія змін</h4>
            {card.log.length ? <ul className="hr-hist">{card.log.map((l, i) => (
              <li key={i}>{l.what} <span className="hr-muted">· {l.actor ?? "система"} · {fmtTs(l.at)}</span></li>))}</ul>
              : <p className="hr-muted" style={{ fontSize: 12.5, margin: 0 }}>Змін ще не було.</p>}
          </div>
        </>)}
      </aside>
    </div>, document.body);
}

// ── Статті: повна структура ──────────────────────────────────────────────────
function ArticlesTab({ data, act }: { data: FinMonth; act: Actions }) {
  const [q, setQ] = useState("");
  const [showOff, setShowOff] = useState(false);
  const ql = q.trim().toLowerCase();
  let n = 0;
  return (
    <div className="hr-card">
      <div className="hd">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label className="hr-muted">Пошук статті<br />
            <input className="hr-inp" type="search" placeholder="Назва статті" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <label className="hr-muted" style={{ fontSize: 13 }}><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> показати вимкнені</label>
        </div>
        {data.canEdit && <button className="hr-btn p" onClick={act.addResp}>+ Відповідальний</button>}
      </div>
      <div className="hr-tw">
        <table className="hr-table fin-table">
          <thead><tr><th>Назва</th><th className="num">План · {monthShort(data.month)}</th><th className="num">Факт · {monthShort(data.month)}</th><th>Стан</th><th className="num">{data.canEdit ? "Дії" : ""}</th></tr></thead>
          <tbody>
            {data.tree.map((r) => (
              <ArticleResp key={r.id} r={r} canEdit={data.canEdit} act={act}>
                {r.groups.map((g) => {
                  const its = g.items.filter((i) => (showOff || i.offFrom == null) && (!ql || i.name.toLowerCase().includes(ql)));
                  if (ql && !its.length) return null;
                  n += its.length;
                  return (<ArticleGroup key={g.id} g={g} r={r} canEdit={data.canEdit} act={act} month={data.month}>
                    {its.map((i) => (
                      <tr key={i.id} className={i.offFrom ? "off" : ""}>
                        <td className="ind2">{i.name}</td>
                        <td className="num">{money(i.plan)}</td>
                        <td className="num">{money(i.fact)}</td>
                        <td>{i.offFrom ? <span className="hr-pill gr">вимкнено з {monthShort(i.offFrom)} {i.offFrom.slice(0, 4)}</span> : <span className="hr-pill ok">діє</span>}</td>
                        <td className="num">{data.canEdit && <span className="acts">
                          <button className="hr-btn xs" onClick={() => act.renameItem(i)} aria-label={`Перейменувати ${i.name}`}>✎</button>
                          <button className="hr-btn xs" onClick={() => act.moveItem(i, g)} aria-label={`Перенести ${i.name}`}>⇄</button>
                          <button className="hr-btn xs" onClick={() => void act.toggleItem(i)} aria-label={i.offFrom ? `Увімкнути ${i.name}` : `Вимкнути ${i.name}`}>{i.offFrom ? "▶" : "⊘"}</button>
                          <button className="hr-btn xs" style={{ color: "var(--danger)" }} onClick={() => void act.delItem(i)} aria-label={`Видалити ${i.name}`}>🗑</button>
                        </span>}</td>
                      </tr>
                    ))}
                  </ArticleGroup>);
                })}
              </ArticleResp>
            ))}
            {!n && ql && <tr><td colSpan={5} className="hr-muted" style={{ padding: 16 }}>Нічого не знайдено.</td></tr>}
            {!data.tree.length && <tr><td colSpan={5} className="hr-muted" style={{ padding: 16 }}>Статей ще немає. Почніть із «+ Відповідальний».</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="hr-sect hr-muted" style={{ fontSize: 12.5 }}>
        Вимкнена стаття зникає з місяців після своєї останньої цифри — минулі підсумки не змінюються. Видалення можна скасувати кнопкою «Повернути».
      </div>
    </div>
  );
}

function ArticleResp({ r, canEdit, act, children }: { r: FinResp; canEdit: boolean; act: Actions; children: ReactNode }) {
  return (<>
    <tr className="resp" style={{ cursor: "default" }}>
      <td colSpan={4}>{r.name} <span className="hr-muted" style={{ fontWeight: 400 }}>· груп: {r.groups.length}</span></td>
      <td className="num">{canEdit && <span className="acts">
        <button className="hr-btn xs" onClick={() => act.addGroup(r)}>+ група</button>
        <button className="hr-btn xs" onClick={() => act.renameResp(r)} aria-label={`Перейменувати ${r.name}`}>✎</button>
        <button className="hr-btn xs" style={{ color: "var(--danger)" }} onClick={() => void act.delResp(r)} aria-label={`Видалити ${r.name}`}>🗑</button>
      </span>}</td>
    </tr>
    {children}
  </>);
}
function ArticleGroup({ g, r, canEdit, act, month, children }: { g: FinGroup; r: FinResp; canEdit: boolean; act: Actions; month: string; children: ReactNode }) {
  return (<>
    <tr>
      <td className="ind1" colSpan={4}><b>{g.name}</b> <span className="hr-muted">· статей: {g.items.length}</span></td>
      <td className="num">{canEdit && <span className="acts">
        <button className="hr-btn xs" onClick={() => act.addItem(g, month)}>+ стаття</button>
        <button className="hr-btn xs" onClick={() => act.renameGroup(g)} aria-label={`Перейменувати ${g.name}`}>✎</button>
        <button className="hr-btn xs" onClick={() => act.moveGroup(g, r)} aria-label={`Перенести ${g.name}`}>⇄</button>
        <button className="hr-btn xs" style={{ color: "var(--danger)" }} onClick={() => void act.delGroup(g)} aria-label={`Видалити ${g.name}`}>🗑</button>
      </span>}</td>
    </tr>
    {children}
  </>);
}
