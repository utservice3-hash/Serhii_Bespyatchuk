/**
 * 💰 Налаштування → «Працівники й умови» (макет p08-set.js `personDrawer`): хто в зарплаті, рівень, ставка, %, офіційна ЗП,
 * ДН, дата виходу. Зміна умов — з поточного або наступного місяця + причина (`updateEmployee`); додати людину — з кандидатів
 * (користувачі дашборда, ще не в зарплаті; дані підставляються з реєстру співробітників). Право — `payroll_edit`.
 * Звільнення — у вкладці «Обхідні листи» (там же створюється лист).
 */
import { useMemo, useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Card, Empty, money, monthTitle, nextMonth, pct } from "../ui";
import { useToast } from "../../components/Toasts";
import { Field, LEVEL_NAMES, Modal, OFFER_NAMES, ROLE_NAMES, Seg, bday, ddy } from "./common";

const toNum = (s: string): number | null => { const t = s.replace(/\s/g, "").replace(",", "."); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
/** «ДД.ММ» ↔ «ММ-ДД» (сервер зберігає ММ-ДД). */
const bdayIn = (s: string): string | null => { const m = /^(\d{1,2})\.(\d{1,2})$/.exec(s.trim()); return m ? `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : s.trim() ? "bad" : null; };

function LevelTag({ level }: { level: string | null }) {
  if (!level) return <>—</>;
  return <span className={`zps-lvl ${level === "profi" ? "zps-lvl--profi" : ""}`}>{level === "profi" ? "Профі" : "Старт"}</span>;
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
    if (p.role === "manager" && f.level !== p.level) body.level = f.level;
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
    try { await payrollApi.updateEmployee(p.userId, body); toast(body.level ? "Умови збережено. Новий офер — у документах, рекрутер отримав задачу." : "Умови збережено."); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  const depts = (org.departments ?? []) as Obj[], teams = (org.teams ?? []) as Obj[];
  const S = settings;
  return (
    <Modal title={`Умови · ${p.name}`} onClose={onClose} wide
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Зберегти</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <div className="zp-hint">{p.title} · {ROLE_NAMES[p.role] ?? p.role}{p.role === "manager" ? ` · ${OFFER_NAMES[p.offer] ?? p.offer}` : ""}</div>
      {p.role === "manager" && (
        <Field label="Рівень">
          <select className="zp-select" value={f.level} onChange={(e) => set("level", e.target.value)}>
            <option value="start">«Старт» — ставка + {S.start?.pctLow} / {S.start?.pctHigh} %</option>
            <option value="profi">«Профі» — {S.profi?.pct1} / {S.profi?.pct2} / {S.profi?.pct3} % від маржі</option>
          </select>
        </Field>
      )}
      <div className="zps-g3">
        {p.role !== "manager" && <Field label="Ставка, ₴"><input className="zp-input zp-input--num" inputMode="numeric" value={f.rate} onChange={(e) => set("rate", e.target.value)} /></Field>}
        {p.role === "staff" && <Field label="% від маржі компанії" hint="порожньо — без відсотка"><input className="zp-input zp-input--num" inputMode="decimal" value={f.pct} onChange={(e) => set("pct", e.target.value)} /></Field>}
        <Field label="Офіційна ЗП, ₴ щомісяця" hint="0 або порожньо — немає"><input className="zp-input zp-input--num" inputMode="numeric" value={f.offAmt} onChange={(e) => set("offAmt", e.target.value)} placeholder="немає" /></Field>
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
      <Field label="З якого місяця діють ставка, рівень, % і офіційна ЗП" hint="Посада, відділ, команда й дати змінюються одразу.">
        <Seg items={[["cur", `з поточного — ${monthTitle(live)}`], ["next", `з наступного — ${monthTitle(nextMonth(live))}`]]} value={from} onChange={setFrom} />
      </Field>
      <Field label="Причина" req><textarea className="zp-textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="напр. рішення керівництва, новий офер, офіційне працевлаштування" /></Field>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

function AddModal({ candidates, org, live, onClose, onDone }: { candidates: Obj[]; org: Obj; live: string; onClose: () => void; onDone: () => void }) {
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
    if (c) setF((x) => ({ ...x, role: c.role ?? x.role, title: c.title ?? "", team: c.team ?? "", leadsTeam: c.role === "lead" ? c.team ?? "" : "", startDate: c.startDate ?? "",
      birthday: c.birthday ? bday(c.birthday) : "", level: c.level ?? "start", dept: c.role === "staff" ? (x.dept === "sales" ? "" : x.dept) : "sales" }));
  }
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

export function PeopleSettings({ emp, org, settings, canEdit, onChanged }: { emp: Obj; org: Obj; settings: Obj; canEdit: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState<Obj | null>(null);
  const [add, setAdd] = useState(false);
  const people = (emp.people ?? []) as Obj[];
  const teamName = useMemo(() => Object.fromEntries(((org.teams ?? []) as Obj[]).map((t) => [t.code, t.name])), [org]);
  const S = settings;
  return (
    <Card title="Працівники й умови" aside={canEdit ? "клік — змінити умови: рівень, ставка, %, офіційна ЗП, день народження" : "лише перегляд"}>
      <div className="zp-grid" style={{ gap: 10 }}>
        {canEdit && <div className="zp-row"><button className="zp-btn" onClick={() => setAdd(true)}>Додати в зарплату</button><span className="zp-hint">Кандидатів: {(emp.candidates ?? []).length}. Звільнення — у вкладці «Обхідні листи».</span></div>}
        {people.length ? (
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Працівник</th><th>Рівень</th><th className="r">Ставка</th><th>Відсоток</th><th>Офіційна ЗП</th><th>ДН</th><th>Працює з</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.userId} className={canEdit ? "is-click" : ""} tabIndex={canEdit ? 0 : -1} onClick={() => canEdit && setEdit(p)} onKeyDown={(e) => { if (canEdit && e.key === "Enter") setEdit(p); }}>
                    <td><b>{p.name}</b><div className="zp-hint">{p.title}{p.team ? ` · ${teamName[p.team] ?? p.team}` : ""}{p.isFinance ? " · фінансист" : ""}{p.simple ? " · простий кабінет" : ""}</div></td>
                    <td>
                      {p.role === "manager" ? <><LevelTag level={p.level} />{p.levelChange && <span className="zp-hint"> → {LEVEL_NAMES[p.levelChange.level] ?? p.levelChange.level} з {String(p.levelChange.from).slice(5, 7)}.{String(p.levelChange.from).slice(0, 4)}</span>}
                        {p.offer === "ls" && <div className="zp-hint">офер Лілії Шаврової</div>}</> : "—"}
                    </td>
                    <td className="r">{p.role === "manager" ? (p.level === "start" ? money(p.offer === "ls" ? S.offers?.ls?.startRate : S.start?.rate) : "—") : money(p.rate)}</td>
                    <td>{p.role === "manager" ? "за рівнем" : p.role === "lead" ? `${S.lead?.pctLow} / ${S.lead?.pctHigh} % маржі команди` : p.pctRule ? `${pct(p.pctRule.value, 1)} маржі компанії` : "—"}</td>
                    <td>{p.official ? <><b>{money(p.official.amount)}</b><div className="zp-hint">{p.official.deduct ? "вираховується з загальної" : "окремо, не вираховується"}</div></> : <span className="zp-hint">немає</span>}</td>
                    <td>{bday(p.birthday)}</td>
                    <td>{ddy(p.startDate)}{p.leave && <div className="zp-tone--danger zp-hint">звільнення {ddy(p.leave.date)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>У зарплаті ще нікого немає. {canEdit ? "Додайте людей кнопкою вище — кабінет «Моя зарплата» зʼявиться в них одразу." : ""}</Empty>}
        <div className="zp-hint">Плани — у вкладці «Плани» дашборда (тім-лід подає, КВП / адмін затверджує); тут не змінюються. Зміна рівня → новий офер у документах працівника й задача рекрутеру.</div>
      </div>
      {edit && <PersonModal p={edit} org={org} live={emp.month} settings={S} onClose={() => setEdit(null)} onDone={() => { setEdit(null); onChanged(); }} />}
      {add && <AddModal candidates={(emp.candidates ?? []) as Obj[]} org={org} live={emp.month} onClose={() => setAdd(false)} onDone={() => { setAdd(false); onChanged(); }} />}
    </Card>
  );
}
