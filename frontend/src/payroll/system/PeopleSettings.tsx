/**
 * 💰 Налаштування → «Працівники й умови» (макет p08-set.js `personDrawer`): хто в зарплаті, рівень, ставка, %, офіційна ЗП,
 * ДН, дата виходу. Зміна умов — з поточного або наступного місяця + причина (`updateEmployee`); додати людину — з кандидатів
 * (користувачі дашборда, ще не в зарплаті; дані підставляються з реєстру співробітників). Право — `payroll_edit`.
 * Звільнення — у вкладці «Обхідні листи» (там же створюється лист).
 */
import { useEffect, useMemo, useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Card, Empty, money, monthTitle, nextMonth, pct } from "../ui";
import { useToast } from "../../components/Toasts";
import { Field, LEVEL_NAMES, Modal, OFFER_NAMES, ROLE_NAMES, Seg, bday, ddy, kyivToday } from "./common";

const toNum = (s: string): number | null => { const t = s.replace(/\s/g, "").replace(",", "."); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
/** «ДД.ММ» ↔ «ММ-ДД» (сервер зберігає ММ-ДД). */
const bdayIn = (s: string): string | null => { const m = /^(\d{1,2})\.(\d{1,2})$/.exec(s.trim()); return m ? `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : s.trim() ? "bad" : null; };

/** Документ оферу (`offerDoc` сервера): підписано / чекає підпису (червоне, коли строк минув) / «—», коли документа немає. */
function OfferDocCell({ d }: { d: Obj | null | undefined }) {
  if (!d) return <span className="zp-hint">—</span>;
  const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  if (d.signedAt) return <><span className="zp-tone--ok">підписано {dm(String(d.signedAt))}</span><div className="zp-hint">{d.title}</div></>;
  const over = !!d.due && kyivToday() > String(d.due);
  return <><span className={over ? "zp-tone--danger" : "zp-tone--warn"}>{over ? "прострочено · " : ""}чекає підпису{d.due ? ` до ${dm(String(d.due))}` : ""}</span><div className="zp-hint">{d.title}{d.from ? ` · з ${ddy(String(d.from))}` : ""}</div></>;
}

function LevelTag({ level }: { level: string | null }) {
  if (!level) return <>—</>;
  return <span className={`zps-lvl ${level === "profi" ? "zps-lvl--profi" : ""}`}>{level === "profi" ? "Профі" : "Старт"}</span>;
}

const ADJ_KIND: Record<string, string> = { bonus: "Бонус", correction: "Корекція" };
const ym = (m: string) => `${m.slice(5, 7)}.${m.slice(0, 4)}`;
/**
 * Постійний «Бонус» / «Корекція» на період (задача 10723, ТЗ Тетяни): сума щомісяця з/по, коментар «за що» бачить людина в кабінеті.
 * Бонус — лише до ЗП, не до авансу; корекція зменшує нараховане, але не нижче нуля. Початок — не раніше поточного місяця.
 */
function Adjustments({ p, live, onDone }: { p: Obj; live: string; onDone: () => void }) {
  const toast = useToast();
  const list = ((p.adjustments ?? []) as Obj[]).filter((a) => !a.to || a.to >= live);
  const [kind, setKind] = useState<"bonus" | "correction">("bonus");
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [from, setFrom] = useState(live);
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function add() {
    setErr(null);
    const v = toNum(amt);
    if (!(v != null && v > 0)) { setErr("Сума — більше нуля."); return; }
    if (!note.trim()) { setErr("Напишіть, за що — це бачить людина в кабінеті."); return; }
    if (!from || from < live) { setErr(`Початок — не раніше поточного місяця (${monthTitle(live)}).`); return; }
    if (to && to < from) { setErr("Місяць кінця — не раніше початку."); return; }
    setBusy(true);
    try { await payrollApi.addAdjustment(p.userId, { kind, amount: v, note: note.trim(), from, to: to || null }); toast(`${ADJ_KIND[kind]} збережено.`); setAmt(""); setNote(""); setTo(""); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  async function remove(a: Obj) {
    setBusy(true);
    try { await payrollApi.removeAdjustment(p.userId, a.id); toast(a.from < live ? `${ADJ_KIND[a.kind]} завершено: у закритих місяцях лишається.` : `${ADJ_KIND[a.kind]} знято.`); onDone(); }
    catch (e) { toast(errText(e), { error: true }); } finally { setBusy(false); }
  }
  return (
    <Field label="Постійний бонус / корекція" hint="Сума щомісяця на період. Бонус — лише до ЗП, не до авансу; корекція зменшує нараховане, але не нижче нуля. Коментар бачить людина в кабінеті.">
      {list.length ? (
        <table className="zp-table"><tbody>
          {list.map((a) => (
            <tr key={a.id}><td><b>{ADJ_KIND[a.kind] ?? a.kind}</b><div className="zp-hint">{a.note}</div></td>
              <td className="r">{a.kind === "correction" ? "−" : "+"}{money(a.amount)}<div className="zp-hint">з {ym(String(a.from))}{a.to ? ` по ${ym(String(a.to))}` : " · безстроково"}</div></td>
              <td className="r"><button className="zp-btn zp-btn--sm" disabled={busy} onClick={() => void remove(a)}>{a.from < live ? "Завершити" : "Зняти"}</button></td></tr>
          ))}
        </tbody></table>
      ) : <div className="zp-hint">Немає.</div>}
      <div className="zp-row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <Seg items={[["bonus", "Бонус"], ["correction", "Корекція"]]} value={kind} onChange={setKind} />
        <input className="zp-input zp-input--num" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="₴ щомісяця" />
        <input className="zp-input" type="month" value={from} min={live} onChange={(e) => setFrom(e.target.value)} title="з місяця" />
        <input className="zp-input" type="month" value={to} min={from} onChange={(e) => setTo(e.target.value)} title="по місяць (порожньо — безстроково)" />
      </div>
      <div className="zp-row" style={{ gap: 8, marginTop: 8 }}>
        <input className="zp-input" style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="за що (бачить людина)" />
        <button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void add()}>Додати</button>
      </div>
      {err && <div className="zp-err">{err}</div>}
    </Field>
  );
}

/** Окремий відсоток за своїми клієнтами менеджера (без розголосу: задають фінансист і ОД). Діє одразу після збереження. */
function ClientRates({ p, live, onDone }: { p: Obj; live: string; onDone: () => void }) {
  const toast = useToast();
  const rates = (p.clientRates ?? []) as Obj[];
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Obj[] | null>(null);
  const [pick, setPick] = useState<Obj | null>(null);
  const [val, setVal] = useState("45");
  const [from, setFrom] = useState<"now" | "next">("now");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function search() {
    setErr(null); setPick(null);
    if (q.trim().length < 2) { setErr("Введіть щонайменше 2 літери назви клієнта."); return; }
    try { setFound(await payrollApi.clientSearch(q.trim())); } catch (e) { setErr(errText(e)); }
  }
  async function add() {
    setErr(null);
    const v = Number(val.replace(",", "."));
    if (!pick) { setErr("Оберіть клієнта зі списку."); return; }
    if (!(v > 0 && v <= 100)) { setErr("Відсоток — від 0 до 100."); return; }
    setBusy(true);
    try { await payrollApi.addClientRate(p.userId, { clientKey: pick.clientKey, clientName: pick.clientName, pct: v, from }); toast(`Окремий відсоток збережено: ${pick.clientName} — ${v} %.`); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  async function remove(r: Obj) {
    setBusy(true);
    try { await payrollApi.removeClientRate(p.userId, r.id); toast(`Знято: ${r.name}.`); onDone(); }
    catch (e) { toast(errText(e), { error: true }); } finally { setBusy(false); }
  }
  return (
    <Field label="Окремий відсоток за своїми клієнтами" hint="Маржа цих клієнтів рахується за своїм відсотком, решта — за шкалою рівня. Бачать фінансист, ОД, СЕО і сам менеджер у кабінеті.">
      {rates.length ? (
        <table className="zp-table"><tbody>
          {rates.map((r) => (
            <tr key={r.id ?? r.client}><td><b>{r.name}</b><div className="zp-hint">з {String(r.from).slice(5, 7)}.{String(r.from).slice(0, 4)}</div></td><td className="r">{pct(r.pct, 1)}</td>
              <td className="r"><button className="zp-btn zp-btn--sm" disabled={busy || r.id == null} onClick={() => void remove(r)}>Зняти</button></td></tr>
          ))}
        </tbody></table>
      ) : <div className="zp-hint">Немає — уся маржа за шкалою рівня.</div>}
      <div className="zp-row" style={{ gap: 8, marginTop: 8 }}>
        <input className="zp-input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} placeholder="назва клієнта" />
        <button className="zp-btn" onClick={() => void search()}>Знайти</button>
      </div>
      {found && (found.length ? (
        <select className="zp-select" value={pick?.clientKey ?? ""} onChange={(e) => setPick(found.find((x) => x.clientKey === e.target.value) ?? null)}>
          <option value="">оберіть клієнта…</option>
          {found.map((c) => <option key={c.clientKey} value={c.clientKey}>{c.clientName} · угод {c.deals}</option>)}
        </select>
      ) : <div className="zp-hint">Клієнтів з такою назвою в угодах немає.</div>)}
      {pick && (
        <div className="zp-row" style={{ gap: 8, marginTop: 8 }}>
          <input className="zp-input zp-input--num" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} style={{ maxWidth: 90 }} /> <span>%</span>
          <Seg items={[["now", `з ${monthTitle(live)}`], ["next", `з ${monthTitle(nextMonth(live))}`]]} value={from} onChange={setFrom} />
          <button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void add()}>Додати</button>
        </div>
      )}
      {err && <div className="zp-err">{err}</div>}
    </Field>
  );
}

function PersonModal({ p, org, live, settings, onClose, onDone }: { p: Obj; org: Obj; live: string; settings: Obj; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    title: p.title ?? "", dept: p.dept ?? "", team: p.team ?? "", leadsTeam: p.leadsTeam ?? "", startDate: p.startDate ?? "", birthday: p.birthday ? bday(p.birthday) : "",
    isFinance: !!p.isFinance, level: p.level ?? "start", rate: p.role === "manager" ? "" : String(p.rate ?? ""), pct: p.pctRule ? String(p.pctRule.value) : "",
    offAmt: p.official ? String(p.official.amount) : "", offDed: p.official ? !!p.official.deduct : true,
  });
  const [from, setFrom] = useState<"cur" | "next">("next");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  /** Місяць, з якого діятимуть ставка, рівень, % і офіційна ЗП, — як його вибрано внизу. */
  const effMonth = from === "next" ? nextMonth(live) : live;

  async function save() {
    setErr(null);
    const body: Obj = { reason, from };
    if (f.title !== (p.title ?? "")) body.title = f.title;
    if (f.dept !== (p.dept ?? "")) body.dept = f.dept;
    if (f.team !== (p.team ?? "")) body.team = f.team;
    if (p.role === "lead" && f.leadsTeam !== (p.leadsTeam ?? "")) body.leadsTeam = f.leadsTeam;
    if (f.startDate !== (p.startDate ?? "")) body.startDate = f.startDate;
    const bd = bdayIn(f.birthday);
    if (bd === "bad") { setErr("День народження — ДД.ММ."); return; }
    if ((bd ?? null) !== (p.birthday ?? null)) body.birthday = bd ?? "";
    if (f.isFinance !== !!p.isFinance) body.isFinance = f.isFinance;
    // рівень тімліда — шкала % його власних угод (Тетяна 27.11); офера не перепідписуємо — це лише для менеджерів
    if ((p.role === "manager" || p.role === "lead") && f.level !== (p.level ?? "start")) body.level = f.level;
    if (p.role !== "manager") {
      const r = toNum(f.rate); if (Number.isNaN(r)) { setErr("Ставка — число."); return; }
      if (r !== null && r !== Number(p.rate ?? 0)) body.rate = r;
    }
    if (p.role === "staff") {
      const v = toNum(f.pct); if (Number.isNaN(v)) { setErr("Відсоток — число."); return; }
      const was = p.pctRule ? Number(p.pctRule.value) : null;
      if (v !== was) body.pct = v === null || v === 0 ? null : { base: "company", value: v };
    }
    const amt = toNum(f.offAmt); if (Number.isNaN(amt)) { setErr("Офіційна ЗП — число."); return; }
    const wasAmt = p.official ? Number(p.official.amount) : null, wasDed = p.official ? !!p.official.deduct : true;
    if ((amt ?? 0) !== (wasAmt ?? 0) || (amt && f.offDed !== wasDed)) body.official = { amount: amt ?? 0, deduct: f.offDed };
    if (Object.keys(body).length <= 2) { setErr("Нічого не змінено."); return; }
    if (reason.trim().length < 3) { setErr("Вкажіть причину зміни."); return; }
    setBusy(true);
    try {
      const r = await payrollApi.updateEmployee(p.userId, body) as { saved?: number; from?: string };
      // Звернення №120 (12.11.2026): з якого місяця діє зміна — словами, інакше «зберегла, а у відомості без змін».
      const mk = r.from || effMonth, money = "level" in body || "rate" in body || "pct" in body || "official" in body;
      // Спільні сповіщення дашборда (`components/Toasts`): «змін немає» — інформаційне, вікно лишається відкритим.
      if (r.saved === 0) { toast(`Це вже записано з місяця «${monthTitle(mk)}».`, { head: "Змін немає", tone: "info" }); return; }
      const when = money ? `Ставка, рівень, % і офіційна ЗП діють з місяця «${monthTitle(mk)}»${mk !== live ? ` — у відомості «${monthTitle(live)}» їх не буде` : ""}.` : "";
      const offer = body.level && p.role === "manager" ? "Новий офер — у документах, рекрутер отримав задачу." : "";
      toast([when, offer].filter(Boolean).join(" ") || p.name, { head: "Умови збережено" }); onDone();
    }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  const depts = (org.departments ?? []) as Obj[], teams = (org.teams ?? []) as Obj[];
  const S = settings;
  return (
    <Modal title={`Умови · ${p.name}`} onClose={onClose} wide
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Зберегти</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <div className="zp-hint">{p.title} · {ROLE_NAMES[p.role] ?? p.role}{p.role === "manager" ? ` · ${OFFER_NAMES[p.offer] ?? p.offer}` : ""}</div>
      {(p.role === "manager" || p.role === "lead") && (
        <Field label={p.role === "lead" ? "Рівень — шкала % власних угод" : "Рівень"}>
          <select className="zp-select" value={f.level} onChange={(e) => set("level", e.target.value)}>
            {p.role === "lead" ? <>
              <option value="start">«Старт» — {S.start?.pctLow} % від власних угод</option>
              <option value="profi">«Профі» — {S.profi?.pct1} / {S.profi?.pct2} % від власних угод</option>
            </> : <>
              <option value="start">«Старт» — ставка + {S.start?.pctLow} / {S.start?.pctHigh} %</option>
              <option value="profi">«Профі» — {S.profi?.pct1} / {S.profi?.pct2} / {S.profi?.pct3} % від маржі</option>
            </>}
          </select>
        </Field>
      )}
      <div className="zps-g3">
        {p.role !== "manager" && <Field label="Ставка, ₴"><input className="zp-input zp-input--num" inputMode="numeric" value={f.rate} onChange={(e) => set("rate", e.target.value)} /></Field>}
        {p.role === "staff" && <Field label="% від маржі компанії" hint="порожньо — без відсотка"><input className="zp-input zp-input--num" inputMode="decimal" value={f.pct} onChange={(e) => set("pct", e.target.value)} /></Field>}
        <Field label="Офіційна ЗП, ₴ щомісяця" hint={`0 або порожньо — немає · діятиме з місяця «${monthTitle(effMonth)}»`}><input className="zp-input zp-input--num" inputMode="numeric" value={f.offAmt} onChange={(e) => set("offAmt", e.target.value)} placeholder="немає" /></Field>
        <Field label="Як рахуємо офіційну"><label className="zp-check"><input type="checkbox" checked={f.offDed} onChange={(e) => set("offDed", e.target.checked)} />вираховувати з загальної ЗП</label></Field>
      </div>
      <div className="zps-g3">
        <Field label="Посада"><input className="zp-input" value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
        <Field label="Відділ"><select className="zp-select" value={f.dept} onChange={(e) => set("dept", e.target.value)}>{depts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></Field>
        <Field label="Команда"><select className="zp-select" value={f.team} onChange={(e) => set("team", e.target.value)}><option value="">поза командою</option>{teams.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
        {p.role === "lead" && <Field label="Веде команду"><select className="zp-select" value={f.leadsTeam} onChange={(e) => set("leadsTeam", e.target.value)}><option value="">—</option>{teams.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>}
        <Field label="Працює з"><input className="zp-input" type="date" value={f.startDate} onChange={(e) => set("startDate", e.target.value)} /></Field>
        <Field label="День народження"><input className="zp-input" value={f.birthday} onChange={(e) => set("birthday", e.target.value)} placeholder="дд.мм" /></Field>
      </div>
      <label className="zp-check"><input type="checkbox" checked={f.isFinance} onChange={(e) => set("isFinance", e.target.checked)} />Фінансист (його ЗП перевіряє ОД)</label>
      {p.role === "manager" && <ClientRates p={p} live={live} onDone={onDone} />}
      <Adjustments p={p} live={live} onDone={onDone} />
      <Field label="З якого місяця діють ставка, рівень, % і офіційна ЗП" hint="Посада, відділ, команда й дати змінюються одразу.">
        <Seg items={[["cur", `з поточного — ${monthTitle(live)}`], ["next", `з наступного — ${monthTitle(nextMonth(live))}`]]} value={from} onChange={setFrom} />
      </Field>
      <Field label="Причина" req><textarea className="zp-textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="напр. рішення керівництва, новий офер, офіційне працевлаштування" /></Field>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

function AddModal({ candidates, org, live, initial, onClose, onDone }: { candidates: Obj[]; org: Obj; live: string; initial?: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [uid, setUid] = useState("");
  const [f, setF] = useState({ role: "manager", title: "", dept: "sales", team: "", leadsTeam: "", startDate: "", birthday: "", level: "start", rate: "", pct: "", offAmt: "", offDed: true, isFinance: false });
  const [from, setFrom] = useState<"cur" | "next">("cur");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  function pick(id: string) {
    setUid(id);
    const c = candidates.find((x) => x.userId === id);
    // відділ — з «Найму» (блок «Оргструктури» за таблицею відповідності, задача 10723); немає — як було
    if (c) setF((x) => ({ ...x, role: c.role ?? x.role, title: c.title ?? "", team: c.team ?? "", leadsTeam: c.role === "lead" ? c.team ?? "" : "", startDate: c.startDate ?? "",
      birthday: c.birthday ? bday(c.birthday) : "", level: c.level ?? "start", dept: c.dept ?? (c.role === "staff" ? (x.dept === "sales" ? "" : x.dept) : "sales") }));
  }
  // «Додати в зарплату» з блоку «Зміни з «Найму»» — людина вже обрана (задача 10723)
  useEffect(() => { if (initial) pick(initial); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    setErr(null);
    if (!uid) { setErr("Оберіть людину."); return; }
    const bd = bdayIn(f.birthday); if (bd === "bad") { setErr("День народження — ДД.ММ."); return; }
    const rate = toNum(f.rate), pv = toNum(f.pct), amt = toNum(f.offAmt);
    if ([rate, pv, amt].some((x) => Number.isNaN(x))) { setErr("Ставка, відсоток і офіційна ЗП — числа."); return; }
    const body: Obj = { userId: Number(uid), role: f.role, title: f.title, dept: f.dept, team: f.team || null, startDate: f.startDate, birthday: bd, isFinance: f.isFinance,
      from: from === "next" ? nextMonth(live) : live };
    if (f.role === "lead") body.leadsTeam = f.leadsTeam || f.team;
    if (f.role === "manager") body.level = f.level; else if (rate !== null) body.rate = rate;
    if (f.role === "staff" && pv) body.pct = { base: "company", value: pv };
    if (amt) body.official = { amount: amt, deduct: f.offDed };
    setBusy(true);
    try { await payrollApi.addEmployee(body); toast("Додано в зарплату — кабінет «Моя зарплата» відкрито працівнику."); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  const depts = (org.departments ?? []) as Obj[], teams = (org.teams ?? []) as Obj[];
  return (
    <Modal title="Додати в зарплату" onClose={onClose} wide
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Додати</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <Field label="Людина" req hint="Користувачі дашборда, яких ще немає в зарплаті; посада, команда, дати й рівень — з реєстру співробітників, якщо вони там є.">
        <select className="zp-select" value={uid} onChange={(e) => pick(e.target.value)}>
          <option value="">оберіть…</option>
          {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name}{c.title ? ` · ${c.title}` : ""}</option>)}
        </select>
      </Field>
      <div className="zps-g3">
        <Field label="Як платимо" req>
          <select className="zp-select" value={f.role} onChange={(e) => set("role", e.target.value)}>
            <option value="manager">менеджер з продажу — рівень і % від маржі</option>
            <option value="lead">тім-лід — ставка + % маржі команди</option>
            <option value="staff">ставка (відділ не продає)</option>
          </select>
        </Field>
        <Field label="Посада"><input className="zp-input" value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
        <Field label="Відділ" req><select className="zp-select" value={f.dept} onChange={(e) => set("dept", e.target.value)}><option value="">оберіть…</option>{depts.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></Field>
        {f.role !== "staff" && <Field label="Команда" req><select className="zp-select" value={f.team} onChange={(e) => set("team", e.target.value)}><option value="">оберіть…</option>{teams.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>}
        {f.role === "lead" && <Field label="Веде команду"><select className="zp-select" value={f.leadsTeam} onChange={(e) => set("leadsTeam", e.target.value)}><option value="">ту саму</option>{teams.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>}
        {f.role === "manager" ? (
          <Field label="Рівень"><select className="zp-select" value={f.level} onChange={(e) => set("level", e.target.value)}><option value="start">«Старт»</option><option value="profi">«Профі»</option></select></Field>
        ) : <Field label="Ставка, ₴" req><input className="zp-input zp-input--num" inputMode="numeric" value={f.rate} onChange={(e) => set("rate", e.target.value)} /></Field>}
        {f.role === "staff" && <Field label="% від маржі компанії" hint="порожньо — без відсотка"><input className="zp-input zp-input--num" inputMode="decimal" value={f.pct} onChange={(e) => set("pct", e.target.value)} /></Field>}
        <Field label="Працює з" req><input className="zp-input" type="date" value={f.startDate} onChange={(e) => set("startDate", e.target.value)} /></Field>
        <Field label="День народження"><input className="zp-input" value={f.birthday} onChange={(e) => set("birthday", e.target.value)} placeholder="дд.мм" /></Field>
        <Field label="Офіційна ЗП, ₴" hint="порожньо — немає"><input className="zp-input zp-input--num" inputMode="numeric" value={f.offAmt} onChange={(e) => set("offAmt", e.target.value)} /></Field>
      </div>
      <div className="zp-row">
        <label className="zp-check"><input type="checkbox" checked={f.offDed} onChange={(e) => set("offDed", e.target.checked)} />офіційну вираховувати з загальної ЗП</label>
        <label className="zp-check"><input type="checkbox" checked={f.isFinance} onChange={(e) => set("isFinance", e.target.checked)} />фінансист (його ЗП перевіряє ОД)</label>
      </div>
      <Field label="Умови діють">
        <Seg items={[["cur", `з поточного — ${monthTitle(live)}`], ["next", `з наступного — ${monthTitle(nextMonth(live))}`]]} value={from} onChange={setFrom} />
      </Field>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

/**
 * «Зміни з «Найму», які ще не внесені в «Зарплату»» (задача 10723, Тетяна 23.11.2026: «як відображати всі ці зміни —
 * звільнення, нові офери»). Сервер лише ПОРІВНЮЄ (`payroll/naimSync.ts`), нічого не пише сам; дія — кнопкою в рядку.
 * Люди без акаунта — одним рядком-числом з розгортанням: їх може бути багато, і в кожному рядку той самий підпис став би шпалерами.
 */
const NAIM_TAG: Record<string, [string, string]> = { dismissed: ["у «Наймі» звільнений", "zps-tag--warn"], new: ["новий у «Наймі»", "zps-tag--ok"], level: ["інший рівень", "zps-tag--lvl"], move: ["інший відділ чи команда", "zps-tag--lvl"] };
/** «Було → у «Наймі»» для рядка переведення: лише те, що різниться. Невідомий код — самим кодом, не порожнім місцем. */
function moveText(r: Obj, names: { dept: Record<string, string>; team: Record<string, string> }): string {
  const d = (c: string | null) => (c ? names.dept[c] ?? c : "без відділу"), t = (c: string | null) => (c ? names.team[c] ?? c : "поза командою");
  const parts: string[] = [];
  if (r.naimDept !== r.payrollDept) parts.push(`відділ: ${d(r.payrollDept)} → ${d(r.naimDept)}`);
  if (r.naimTeam !== r.payrollTeam) parts.push(`команда: ${t(r.payrollTeam)} → ${t(r.naimTeam)}`);
  return `У «Наймі» — блок «${r.unit}». ${parts.join("; ")}. Зміна команди міняє офер, тому переводимо кнопкою.`;
}
function NaimBlock({ rows, canEdit, onLeave, onAdd, onLevel, onMove, names }: { rows: Obj[]; canEdit: boolean; onLeave: ((r: Obj) => void) | null; onAdd: (r: Obj) => void; onLevel: (r: Obj) => void;
  onMove: (r: Obj) => void; names: { dept: Record<string, string>; team: Record<string, string> } }) {
  const [openNo, setOpenNo] = useState(false);
  const main = rows.filter((r) => r.kind !== "noAccount"), noAcc = rows.filter((r) => r.kind === "noAccount");
  if (!rows.length) return <div className="zp-hint">Змін з «Найму», не внесених у «Зарплату», немає.</div>;
  const lvl = (l: string) => LEVEL_NAMES[l] ?? l;
  return (
    <div className="zps-naim">
      <div><b>Зміни з «Найму», які ще не внесені в «Зарплату» · {rows.length}</b> <span className="zp-hint">порівнюємо при кожному відкритті; самі нічого не змінюємо</span></div>
      {main.length > 0 && (
        <table className="zp-table zps-naim__t"><tbody>
          {main.map((r) => (
            <tr key={`${r.kind}-${r.employeeId}`}>
              <td><b>{r.name}</b><div className="zp-hint">{r.position || "посада не вказана в «Наймі»"}</div></td>
              <td>
                <span className={`zps-tag ${NAIM_TAG[r.kind]?.[1] ?? ""}`}>{r.kind === "dismissed" ? `у «Наймі» звільнений${r.date ? ` ${ddy(r.date)}` : ", дату не вказано"}` : r.kind === "level" ? `${lvl(r.naimLevel)} у «Наймі»` : NAIM_TAG[r.kind]?.[0]}</span>
                <div className="zp-hint">{r.kind === "dismissed" ? "У «Зарплаті» рахуємо до дати з «Найму»: лише відсоток, без ставки. Без угод у місяці звільнення — 0. Тип звільнення й обхідний оформлює HR."
                  : r.kind === "new" ? "У «Зарплаті» немає."
                  : r.kind === "move" ? moveText(r, names)
                  : `У «Зарплаті» — ${lvl(r.payrollLevel)}. Рівні ведуться окремо; гроші рахуються за «Зарплатою».`}</div>
              </td>
              <td className="r">{r.kind === "dismissed" ? (onLeave ? <button className="zp-btn zp-btn--sm" onClick={() => onLeave(r)}>Оформити обхідний лист</button> : <span className="zp-hint">оформлює HR</span>) : canEdit && (
                r.kind === "new" ? <button className="zp-btn zp-btn--sm" onClick={() => onAdd(r)}>Додати в зарплату</button>
                : r.kind === "move" ? <button className="zp-btn zp-btn--sm" onClick={() => onMove(r)}>Перевести</button>
                : <button className="zp-btn zp-btn--sm" onClick={() => onLevel(r)}>Змінити рівень</button>)}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {noAcc.length > 0 && (
        <div className="zps-naim__no">
          <button className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setOpenNo(!openNo)}>{openNo ? "▾" : "▸"} Працюють у «Наймі» без акаунта в дашборді · {noAcc.length}</button>
          <span className="zp-hint"> у зарплату не додати, поки немає акаунта; акаунт створює адмін у «Налаштуваннях»</span>
          {openNo && <ul className="zps-naim__list">{noAcc.map((r) => <li key={r.employeeId}>{r.name} <span className="zp-hint">· {r.position || "посада не вказана"}{r.reason === "inactive" ? " · акаунт вимкнено" : ""}</span></li>)}</ul>}
        </div>
      )}
    </div>
  );
}

/**
 * «Перевести» з рядка «Змін з «Найму»» (задача 10723, прохід 3): відділ і команда «Зарплати» — як у «Наймі». Тім-ліду міняється команда,
 * яку він веде. Причина — у журнал; зміна діє одразу (як правка відділу й команди в картці людини).
 */
function MoveModal({ r, person, names, onClose, onDone }: { r: Obj; person: Obj | null; names: { dept: Record<string, string>; team: Record<string, string> }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState(`переведення за «Наймом»: блок «${r.unit}»`);
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const lead = person?.role === "lead";
  async function save() {
    setErr(null); if (reason.trim().length < 3) { setErr("Вкажіть причину."); return; }
    const body: Obj = { reason: reason.trim() };
    if (r.naimDept && r.naimDept !== r.payrollDept) body.dept = r.naimDept;
    if (r.naimTeam !== r.payrollTeam) body[lead ? "leadsTeam" : "team"] = r.naimTeam ?? "";
    setBusy(true);
    try { await payrollApi.updateEmployee(r.userId, body); toast(`${r.name}: переведено.`); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Перевести · ${r.name}`} onClose={onClose}
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Перевести</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <div className="zp-hint">{moveText(r, names)}</div>
      {r.naimTeam !== r.payrollTeam && <div className="zp-hint">Зміна команди міняє офер людини на офер нової команди — так само, як правка команди в картці людини.</div>}
      <Field label="Причина" req><input className="zp-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

export function PeopleSettings({ emp, org, settings, canEdit, onChanged, onLeave }: { emp: Obj; org: Obj; settings: Obj; canEdit: boolean; onChanged: () => void; onLeave: ((userId: string, date: string | null) => void) | null }) {
  const [edit, setEdit] = useState<Obj | null>(null);
  const [add, setAdd] = useState<false | { uid: string | null }>(false);
  const [move, setMove] = useState<Obj | null>(null);
  // за замовчуванням — лише ті, хто працює; звільнені — окремим фільтром (задача 10723)
  const [show, setShow] = useState<"work" | "left">("work");
  const all = (emp.people ?? []) as Obj[];
  const people = all.filter((p) => (show === "left" ? !!p.leave : !p.leave));
  const nLeft = all.filter((p) => !!p.leave).length;
  const teamName = useMemo(() => Object.fromEntries(((org.teams ?? []) as Obj[]).map((t) => [t.code, t.name])), [org]);
  const names = useMemo(() => ({ team: teamName as Record<string, string>, dept: Object.fromEntries(((org.departments ?? []) as Obj[]).map((d) => [d.code, d.name])) as Record<string, string> }), [org, teamName]);
  const S = settings;
  return (
    <Card title="Працівники й умови" aside={canEdit ? "клік — змінити умови: рівень, ставка, %, офіційна ЗП, день народження" : "лише перегляд"}>
      <div className="zp-grid" style={{ gap: 10 }}>
        <NaimBlock rows={(emp.naim ?? []) as Obj[]} canEdit={canEdit}
          onLeave={onLeave ? (r) => onLeave(String(r.userId), r.date ?? null) : null}
          onAdd={(r) => setAdd({ uid: String(r.userId) })}
          onLevel={(r) => { const p = all.find((x) => String(x.userId) === String(r.userId)); if (p) setEdit(p); }}
          onMove={(r) => setMove(r)} names={names} />
        {canEdit && <div className="zp-row"><button className="zp-btn" onClick={() => setAdd({ uid: null })}>Додати в зарплату</button><span className="zp-hint">Кандидатів: {(emp.candidates ?? []).length}. Звільнення — у вкладці «Обхідні листи».</span></div>}
        <Seg<"work" | "left"> value={show} onChange={setShow} items={[["work", `Працюють · ${all.length - nLeft}`], ["left", `Звільнені · ${nLeft}`]]} />
        {people.length ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Працівник</th><th>Рівень</th><th className="r">Ставка</th><th>Відсоток</th><th>Офіційна ЗП</th><th>Офер</th><th>ДН</th><th>Працює з</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.userId} className={canEdit ? "is-click" : ""} tabIndex={canEdit ? 0 : -1} onClick={() => canEdit && setEdit(p)} onKeyDown={(e) => { if (canEdit && e.key === "Enter") setEdit(p); }}>
                    <td><b>{p.name}</b><div className="zp-hint">{p.title}{p.team ? ` · ${teamName[p.team] ?? p.team}` : ""}{p.isFinance ? " · фінансист" : ""}{p.simple ? " · простий кабінет" : ""}</div></td>
                    <td>
                      {p.role === "manager" ? <><LevelTag level={p.level} />{p.levelChange && <span className="zp-hint"> → {LEVEL_NAMES[p.levelChange.level] ?? p.levelChange.level} з {String(p.levelChange.from).slice(5, 7)}.{String(p.levelChange.from).slice(0, 4)}</span>}
                        {p.offer === "ls" && <div className="zp-hint">офер Лілії Шаврової</div>}</> : p.role === "lead" ? <><LevelTag level={p.level ?? "start"} /><div className="zp-hint">шкала власних угод</div></> : "—"}
                    </td>
                    <td className="r">{p.role === "manager" ? (p.level === "start" ? money(p.offer === "ls" ? S.offers?.ls?.startRate : S.start?.rate) : "—") : money(p.rate)}</td>
                    <td>{p.role === "manager" ? <>за рівнем{(p.clientRates ?? []).length ? <div className="zp-hint">+ окремий % за {(p.clientRates ?? []).length} {(p.clientRates ?? []).length === 1 ? "клієнтом" : "клієнтами"}</div> : null}</> : p.role === "lead" ? `${S.lead?.pctLow} / ${S.lead?.pctHigh} % маржі команди` : p.pctRule ? `${pct(p.pctRule.value, 1)} маржі компанії` : "—"}</td>
                    <td>{p.official ? <><b>{money(p.official.amount)}</b><div className="zp-hint">{p.official.deduct ? "вираховується з загальної" : "окремо, не вираховується"}</div></> : <span className="zp-hint">немає</span>}</td>
                    <td><OfferDocCell d={p.offerDoc as Obj | null} /></td>
                    <td>{bday(p.birthday)}</td>
                    <td>{ddy(p.startDate)}{p.leave && <div className="zp-tone--danger zp-hint">звільнення {ddy(p.leave.date)}{p.leave.type === "naim" ? " (з «Найму», обхідного ще немає)" : ""}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : show === "left" ? <Empty>Звільнених у «Зарплаті» немає.</Empty> : <Empty>У зарплаті ще нікого немає. {canEdit ? "Додайте людей кнопкою вище — кабінет «Моя зарплата» зʼявиться в них одразу." : ""}</Empty>}
        <div className="zp-hint">Плани — у вкладці «Плани» дашборда (тім-лід подає, КВП / адмін затверджує); тут не змінюються. Зміна рівня → новий офер у документах працівника й задача рекрутеру.</div>
      </div>
      {edit && <PersonModal p={edit} org={org} live={emp.month} settings={S} onClose={() => setEdit(null)} onDone={() => { setEdit(null); onChanged(); }} />}
      {add && <AddModal candidates={(emp.candidates ?? []) as Obj[]} org={org} live={emp.month} initial={add.uid} onClose={() => setAdd(false)} onDone={() => { setAdd(false); onChanged(); }} />}
      {move && <MoveModal r={move} person={all.find((x) => String(x.userId) === String(move.userId)) ?? null} names={names} onClose={() => setMove(null)} onDone={() => { setMove(null); onChanged(); }} />}
    </Card>
  );
}
