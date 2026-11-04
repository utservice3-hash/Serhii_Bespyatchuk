/**
 * 💰 «Обхідні листи» (ТЗ §5.4, макет p07b-clr.js) — електронний бланк компанії: 8 пунктів підписують відповідальні (тім-лід,
 * бізнес-асистент, бухгалтерія, HR), 9-й «Розрахунок та видача ЗП» — ОД, лише після всіх восьми. Хто що може підписати —
 * вирішує сервер (`canSign`); тут — позначки, чернетки (`draft`) і кнопка. П. 1 — новий відповідальний по кожному клієнту
 * (переприв'язка в дебіторці робить сервер при підписі). Звільнення оформлює фінансист (`payroll_edit`).
 */
import { useEffect, useMemo, useState } from "react";
import type { PayrollCtx } from "../PayrollSection";
import { errText, payrollApi, type Obj } from "../api";
import { Card, Empty, Loading, Pill, money, monthTitle, useLoad } from "../ui";
import { useToast } from "../../components/Toasts";
import { Field, LEAVE_TYPES, Modal, ddy, dt, kyivToday } from "./common";

type Item = { n: number; key: string; title: string; desc: string | null; checks: string[] | null; final: boolean; role: string; roleLabel: string;
  responsible: { id: string; name: string } | null; signature: { at: string; by: string; name: string; data: unknown } | null; canSign: boolean };

/** Чи готовий пункт до підпису — те саме правило, що `clearanceReady` рушія (сервер перевіряє вдруге). */
function ready(it: Item, data: unknown, sheet: Obj): boolean {
  if (it.final) return !!sheet.ok;
  if (it.key === "clients") { const d = (data ?? {}) as Record<string, string>; return (sheet.clients as string[]).every((c) => d[c]); }
  if (it.key === "notify") return !!(sheet.shots && sheet.shots.n >= (sheet.clients as string[]).length);
  const d = (Array.isArray(data) ? data : []) as boolean[];
  return d.length === (it.checks ?? []).length && d.every(Boolean);
}

function ItemRow({ it, sheet, onSigned }: { it: Item; sheet: Obj; onSigned: (s: Obj) => void }) {
  const toast = useToast();
  const sig = it.signature;
  const lock = it.final && !sheet.ok;
  const mine = it.canSign && !sig && !lock;
  const initial = sig ? sig.data : sheet.drafts?.[it.key] ?? (it.key === "clients" ? {} : (it.checks ?? []).map(() => false));
  const [data, setData] = useState<unknown>(initial);
  const [busy, setBusy] = useState(false);
  const heirs = (sheet.heirs ?? []) as Array<{ id: string; name: string }>;
  const heirName = (id: string) => heirs.find((h) => h.id === id)?.name ?? (id ? `#${id}` : "—");

  async function save(next: unknown) {
    setData(next);
    try { await payrollApi.draftClearance(sheet.userId, it.key, next); } catch (e) { toast(errText(e), { error: true }); }
  }
  async function sign() {
    setBusy(true);
    try {
      const s = await payrollApi.signClearance(sheet.userId, it.key, it.key === "notify" || it.final ? null : data);
      toast(it.final ? "Розрахунок погоджено — фінансист виплатить." : `Пункт ${it.n} підписано.`);
      onSigned(s);
    } catch (e) { toast(errText(e), { error: true }); } finally { setBusy(false); }
  }

  let sub = null;
  if (it.key === "clients") {
    const d = (data ?? {}) as Record<string, string>;
    const clients = sheet.clients as string[];
    sub = (
      <>
        {clients.length ? (
          <div className="zps-clr-cl">
            {clients.map((cl) => (
              <div key={cl}>
                <span>{cl}</span>
                {mine ? (
                  <select className="zp-select" value={d[cl] ?? ""} aria-label={`Новий відповідальний: ${cl}`} onChange={(e) => void save({ ...d, [cl]: e.target.value })}>
                    <option value="">новий відповідальний…</option>
                    {heirs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                ) : <b>{d[cl] ? `→ ${heirName(d[cl])}` : "—"}</b>}
              </div>
            ))}
          </div>
        ) : <small>Клієнтів у угодах працівника немає — призначати нікого.</small>}
        {mine && !heirs.length && clients.length > 0 && <small className="zp-tone--warn">У команді немає інших менеджерів у зарплаті — передати нікому. Додайте їх у «Налаштуваннях».</small>}
        {sig && <small className="zp-tone--ok">Новий відповідальний — у дебіторці (ручне призначення); CRM і реєстр постійних — за процедурою бізнес-асистента.</small>}
      </>
    );
  } else if (it.key === "notify") {
    const n = (sheet.clients as string[]).length, sh = sheet.shots as { at: string; n: number } | null;
    const files = (sheet.shotsFiles ?? []) as Array<{ id: number; url: string; at: string }>;
    sub = (
      <>
        <small>{sh ? `Скріншоти: ${sh.n} з ${n} клієнтів — надіслав менеджер ${dt(sh.at)}${sig ? " · архівовано" : ""}.` : `Скріншоти: 0 з ${n} — менеджер ще не надіслав (кнопка в його кабінеті).`}</small>
        {files.length > 0 && <div className="zps-shots">{files.map((f) => <a key={f.id} href={f.url} target="_blank" rel="noreferrer" title={`Скріншот ${dt(f.at)}`}><img src={f.url} alt="Скріншот повідомлення клієнту" /></a>)}</div>}
      </>
    );
  } else if (it.checks) {
    const d = (Array.isArray(data) ? data : []) as boolean[];
    sub = (
      <div className="zps-checks">
        {it.checks.map((t, j) => (
          <label key={t} className="zp-check">
            <input type="checkbox" checked={!!d[j]} disabled={!mine} onChange={(e) => { const nx = it.checks!.map((_, k) => (k === j ? e.target.checked : !!d[k])); void save(nx); }} />{t}
          </label>
        ))}
      </div>
    );
  } else if (it.final) {
    const fp = sheet.finalPay as { month: string; status: string; estimate: boolean; total: number; pay: number } | null | undefined;
    const m = fp ? monthTitle(fp.month).toLowerCase() : "";
    const text = !fp ? "Фінальний розрахунок — у вкладці «Перевірка» за місяць звільнення."
      : fp.estimate ? `Орієнтовно за ${m}: ${money(fp.total)} — місяць ще йде; остаточно — після закриття й перевірки.`
      : `Нараховано за ${m}: ${money(fp.total)}, до виплати ${money(fp.pay)}. Деталі — у вкладці «Перевірка».`;
    sub = <small>{text}{lock ? ` Відкриється після всіх ${sheet.total} підписів (зараз ${sheet.done}).` : ""}</small>;
  }

  const ok = mine && ready(it, data, sheet);
  const why = it.key === "clients" ? "призначте всіх клієнтів" : it.key === "notify" ? "чекаємо скріншоти" : "позначте всі пункти";
  return (
    <li className={`${sig ? "is-ok" : lock ? "is-lock" : mine ? "is-now" : ""} ${it.final ? "is-last" : ""}`}>
      <span className="no">{it.n}</span>
      <div className="tx"><b>{it.title}</b>{it.desc && <small>{it.desc}</small>}{sub}</div>
      <div className="rs"><span>{it.roleLabel}</span><b>{it.responsible?.name ?? "не призначено"}</b></div>
      <div className="sg">
        {sig ? (<><span className="zp-tone--ok">підписано {dt(sig.at)}</span><span className="zp-muted">{sig.name}</span></>)
          : mine ? (<><button className={`zp-btn zp-btn--sm ${ok ? "zp-btn--primary" : ""}`} disabled={!ok || busy} onClick={() => void sign()}>{it.final ? "Погодити розрахунок" : "Підписати"}</button>{!ok && <span className="zp-hint">{why}</span>}</>)
          : <span className="zp-tone--warn">{lock ? "після всіх підписів" : "чекає підпису"}</span>}
      </div>
    </li>
  );
}

function Sheet({ userId, focus }: { userId: string; focus: boolean }) {
  const toast = useToast();
  const { data, err, reload, setData } = useLoad(() => payrollApi.clearance(userId), [userId]);
  useEffect(() => { if (focus && data) document.getElementById(`clr-${userId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [focus, data, userId]);
  if (!data) return <Card><Loading err={err} onRetry={reload} /></Card>;
  const s = data as Obj;
  const finalSig = (s.items as Item[]).find((x) => x.final)?.signature;
  const pill = s.final ? <Pill tone="ok">Закрито {finalSig ? dt(finalSig.at).slice(0, 5) : ""}</Pill> : s.ok ? <Pill tone="info">Чекає погодження ОД</Pill> : <Pill tone="warn">Підписано {s.done} з {s.total}</Pill>;

  async function print() {
    const w = window.open("", "_blank");   // синхронно — інакше браузер заблокує вікно після await
    try {
      const html = await payrollApi.clearancePrint(userId);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      if (w) { w.opener = null; w.location.href = url; } else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { w?.close(); toast(errText(e), { error: true }); }
  }

  return (
    <section className="zp-card" id={`clr-${userId}`}>
      <header className="zp-card__head"><h3>Обхідний лист · {s.name}</h3><div className="zp-row"><span className="zp-card__aside">{s.title}</span>{pill}</div></header>
      <div className="zp-grid" style={{ gap: 12 }}>
        <div>Дата звільнення <b>{ddy(s.leave?.date)}</b> — {s.leave?.label ?? "тип не вказано"}. <span className="zp-muted">{s.leave?.rule}.</span> Створено {dt(s.createdAt)}.</div>
        <ol className="zps-clr">{(s.items as Item[]).map((it) => <ItemRow key={`${it.key}-${it.signature ? 1 : 0}`} it={it} sheet={s} onSigned={(x) => setData(x)} />)}</ol>
        <div className="zp-row">
          <button className="zp-btn zp-btn--sm" onClick={() => void print()}>Завантажити PDF — як паперовий бланк</button>
          <span className="zp-hint">Підпис — дія відповідального в дашборді з датою й часом; кожен підпис — в історії змін.</span>
        </div>
        {(s.history as Obj[] | undefined)?.length ? (
          <details><summary className="zp-hint">Історія ({s.history.length})</summary>
            <ul className="zps-hist">{(s.history as Obj[]).map((h) => <li key={h.id}><b>{h.what}</b> <span className="w">— {h.by}, {dt(h.at)}</span>{h.note && <><br /><span className="w">{h.note}</span></>}</li>)}</ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function LeaveModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data } = useLoad(() => payrollApi.employees(), []);
  const people = useMemo(() => ((data?.people ?? []) as Obj[]).filter((p) => !p.leave), [data]);
  const [userId, setUserId] = useState("");
  const [date, setDate] = useState(kyivToday());
  const [type, setType] = useState("own");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setErr(null);
    if (!userId) { setErr("Оберіть працівника."); return; }
    setBusy(true);
    try { await payrollApi.createLeave(userId, { date, type, reason }); toast("Звільнення оформлено — обхідний лист створено, відповідальні отримали сповіщення."); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Оформити звільнення" onClose={onClose}
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Створити обхідний лист</button><button className="zp-btn" onClick={onClose}>Скасувати</button></>}>
      <Field label="Працівник" req>
        <select className="zp-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">оберіть…</option>
          {people.map((p) => <option key={p.userId} value={p.userId}>{p.name} · {p.title}</option>)}
        </select>
      </Field>
      <div className="zps-g2">
        <Field label="Дата звільнення" req><input className="zp-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Тип звільнення (п. 11 оферу)" req hint={LEAVE_TYPES[type]?.[1]}>
          <select className="zp-select" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(LEAVE_TYPES).map(([k, [t]]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Причина" req><textarea className="zp-textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="напр. вирішив піти після випробувального місяця" /></Field>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

export default function ClearancesTab({ ctx }: { ctx: PayrollCtx }) {
  const { data, err, reload } = useLoad(() => payrollApi.clearances(), []);
  const [leave, setLeave] = useState(false);
  const focusId = ctx.goExtra?.userId ? String(ctx.goExtra.userId) : null;
  if (!data) return <Loading err={err} onRetry={reload} />;
  const list = data as Obj[];
  return (
    <div className="zp-grid">
      <Card title="Обхідні листи" aside="електронний бланк компанії: кожен відповідальний підписує свої пункти">
        <div className="zp-grid" style={{ gap: 10 }}>
          <div className="zp-note">
            Створюється, щойно у фінансиста оформлено звільнення. Тім-лід, бізнес-асистент, бухгалтерія й HR підписують свої пункти (1–8);
            форма на виплату — після всіх восьми підписів. Пункт 9 «Розрахунок та видача заробітної плати» погоджує ОД — і фінансист виплачує.
            Кожен відповідальний отримує сповіщення про свої пункти.
          </div>
          {ctx.perms.has("payroll_edit") && <div><button className="zp-btn" onClick={() => setLeave(true)}>Оформити звільнення</button></div>}
        </div>
      </Card>
      {list.length ? list.map((c) => <Sheet key={c.userId} userId={String(c.userId)} focus={focusId === String(c.userId)} />)
        : <Card><Empty>Обхідних листів немає.</Empty></Card>}
      {leave && <LeaveModal onClose={() => setLeave(false)} onDone={() => { setLeave(false); void reload(); }} />}
    </div>
  );
}
