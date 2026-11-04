/**
 * 💰 «Перевірка» — робочі вікна фінансиста (ТЗ §7.1, §5.2; макет v6 `verifyPage` / `verifyWin`). Ліворуч — черга закритого
 * місяця групами («Потрібна ваша дія», «Чекаємо працівника», «Подали форму / виплачено», «Перевіряє ОД»), праворуч — вікно
 * працівника: автоматично з ядра → істинне (зміна — лише з внутрішнім коментарем), ДН, ТТН, премії й утримання, офіційна ЗП,
 * підсумок і «що побачить працівник». Свою ЗП і ЗП фінансиста без «останнього слова» сервер не дасть змінити (403) —
 * тут лише не показуємо кнопок. Рішення ОД по незгоді — «лишити перевірене» / «повернути орієнтовні».
 */
import { useMemo, useState } from "react";
import { payrollApi, errText, errField, type Obj } from "../api";
import type { PayrollCtx } from "../PayrollSection";
import { Card, Empty, Loading, Pill, StatusPill, Stat, Line, money, num, pct, useLoad } from "../ui";
import { useToast } from "../../components/Toasts";
import { Lbl, LevelTag } from "./common";
import { dt, dd, dayGen, monthGen, monthLow, plural, shortRole, signed, signTone, parseNum } from "./fmt";

const GROUPS: Array<[string, string]> = [["action", "Потрібна ваша дія"], ["employee", "Чекаємо працівника"], ["done", "Подали форму / виплачено"], ["od", "Перевіряє ОД"]];
const ORDER: Record<string, number> = { disputed: 0, review: 1, verified: 2, agreed: 3, submitted: 4, paid: 5 };
const kyivToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export default function VerifyTab({ ctx }: { ctx: PayrollCtx }) {
  const mk = ctx.closedMonth;
  const { data: q, err, reload } = useLoad<Obj | null>(() => (mk ? payrollApi.queue(mk) : Promise.resolve(null)), [mk]);
  const { data: st } = useLoad<Obj | null>(() => payrollApi.settings(mk ?? undefined).catch(() => null), [mk]);
  const S = (st?.settings ?? null) as Obj | null;
  // Хто відкритий: вибір у черзі → перехід зі сповіщення (`goExtra.userId`; новий перехід скидає ручний вибір) → перший,
  // хто чекає дії. Обчислюється, а не синхронізується ефектом.
  const [pick, setPick] = useState<{ id: string | null; via: Obj | null }>({ id: null, via: ctx.goExtra });
  const setSel = (id: string) => setPick({ id, via: ctx.goExtra });

  const rows = useMemo(() => {
    const xs = ((q?.rows ?? []) as Obj[]).slice();
    return GROUPS.flatMap(([g]) => xs.filter((x) => x.group === g).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)));
  }, [q]);
  const goId = ctx.goExtra?.userId ? String(ctx.goExtra.userId) : null;
  const sel = [pick.via === ctx.goExtra ? pick.id : null, goId].find((id) => id && rows.some((x) => x.userId === id))
    ?? (rows.find((x) => x.group === "action") ?? rows[0])?.userId ?? null;

  if (!mk) {
    return (
      <Card title="Перевірка" aside="робочі вікна фінансиста">
        <div className="zp-note">
          Перевірка відкривається 1-го числа за попередній місяць — місяць закривається автоматично 1-го о 04:45 (після нічної
          синхронізації з CRM), перевірити до {S?.verifyByDay ?? 6}-го. Зараз іде {monthLow(ctx.liveMonth)}: орієнтовні суми — у «Нарахуваннях»,
          заявки на аванс — в «Авансах».
        </div>
      </Card>
    );
  }
  if (!q) return <Loading err={err} onRetry={reload} />;
  if (!rows.length) return <Empty>За {monthLow(mk)} розрахункових листів немає — у зарплаті ще нікого не було в цьому місяці.</Empty>;

  const n = (g: string) => rows.filter((x) => x.group === g).length;
  const verifyBy = String(q.verifyBy), payBy = String(q.payBy), today = kyivToday();
  const left = Math.round((Date.parse(verifyBy) - Date.parse(today)) / 864e5);
  const idx = rows.findIndex((x) => x.userId === sel);
  const prev = idx > 0 ? rows[idx - 1] : null, next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
  const isOd = ctx.perms.has("payroll_final_word");

  return (
    <>
      <div className="zp-grid zp-grid--stats">
        <Stat label="Потрібна ваша дія" value={n("action") + (isOd ? n("od") : 0)}
          sub={`перевірити до ${dayGen(verifyBy)}${left > 0 ? ` · лишилось ${left} ${plural(left, "день", "дні", "днів")}` : left === 0 ? " · сьогодні" : " · термін минув"}`} tone={left < 0 && n("action") ? "danger" : undefined} />
        <Stat label="Чекаємо працівника" value={n("employee")} sub="згода або форма на виплату" />
        <Stat label="Подали форму" value={rows.filter((x) => x.status === "submitted").length} sub={`→ «Відомість», виплата до ${dayGen(payBy)}`} />
        <Stat label={`Фонд ЗП · ${monthLow(mk)}`} value={money(q.fund)} sub={`орієнтовно було ${money(q.autoFund)}`} />
      </div>
      <div className="zf-vpage">
        <nav className="zp-card zp-card--flush zf-queue zp-queue" aria-label="Черга перевірки">
          {GROUPS.map(([g, title]) => {
            const xs = rows.filter((x) => x.group === g);
            if (!xs.length) return null;
            return (
              <div key={g}>
                <div className="zp-queue__group zp-k">{g === "od" && isOd ? "ЗП фінансистів — перевіряєте ви" : title} · {xs.length}</div>
                {xs.map((x) => (
                  <button key={x.userId} type="button" className={`zp-queue__item ${x.userId === sel ? "is-active" : ""}`} aria-current={x.userId === sel} onClick={() => setSel(x.userId)}>
                    <span className="zf-qrow"><span className="zp-queue__name">{x.name}</span>
                      <span className="zf-qamt">{x.status === "review" ? <span className="zp-muted" title="орієнтовно">{money(x.autoTotal)}</span> : money(x.total)}</span></span>
                    <span className="zf-qrow"><span className="zp-queue__sub">{shortRole(x)}{x.mine ? " · ви" : ""}</span>
                      {g === "od" && !isOd ? <Pill>у ОД</Pill> : <StatusPill status={x.status} />}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        {sel && (
          <VerifyWindow key={`${mk}-${sel}`} mk={mk} userId={sel} S={S} ctx={ctx} onSaved={() => void reload()}
            prev={prev ? { id: prev.userId, name: prev.name } : null} next={next ? { id: next.userId, name: next.name } : null} onGo={setSel} />
        )}
      </div>
    </>
  );
}

type Field = "margin" | "pct" | "rate" | "bonus";
const LABEL: Record<Field, string> = { margin: "Маржа", pct: "Відсоток", rate: "Ставка", bonus: "Бонус за КПІ" };
const EXTRA_KINDS: Array<[string, string, number]> = [["prem", "Премія", 1], ["corrP", "Корекція +", 1], ["ded", "Утримання", -1], ["corrM", "Корекція −", -1], ["tax", "Податки", -1]];

/** Відсоток менеджера — те саме правило, що в рушії (`managerPct`): лише для попереднього перегляду до збереження. */
function managerPct(S: Obj | null, level: string, plan: number, m: number): number | null {
  if (!S) return null;
  if (level === "start") return plan >= S.start.minPlanForHigh && m >= plan ? S.start.pctHigh : S.start.pctLow;
  return plan && m >= plan ? S.profi.pct3 : m >= S.profi.threshold ? S.profi.pct2 : S.profi.pct1;
}

function VerifyWindow({ mk, userId, S, ctx, onSaved, prev, next, onGo }: {
  mk: string; userId: string; S: Obj | null; ctx: PayrollCtx; onSaved: () => void;
  prev: { id: string; name: string } | null; next: { id: string; name: string } | null; onGo: (id: string) => void;
}) {
  const toast = useToast();
  const { data: r, err, reload, setData } = useLoad<Obj>(() => payrollApi.record(mk, userId), [mk, userId]);
  const [vals, setVals] = useState<Record<Field, string>>({ margin: "", pct: "", rate: "", bonus: "" });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reply, setReply] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ex, setEx] = useState({ kind: "prem", amount: "", note: "" });
  const [delId, setDelId] = useState<number | null>(null);
  const [odReply, setOdReply] = useState("");

  const init = (x: Obj) => {
    const v = x.settlement?.values ?? {};
    setVals({ margin: String(Math.round(v.margin ?? 0)), pct: String(v.pct ?? ""), rate: String(Math.round(v.rate ?? 0)), bonus: String(Math.round(v.bonus ?? 0)) });
    setTouched({}); setNotes({ ...(x.notes ?? {}) }); setReply(""); setBad(null);
  };
  // новий лист із сервера (відкрили / зберегли) → поля з нього; похідний стан під час рендеру, без ефекту
  const [seen, setSeen] = useState<Obj | null>(null);
  if (r && r !== seen) { setSeen(r); init(r); }

  if (!r) return <div className="zp-card"><Loading err={err} onRetry={reload} /></div>;
  if (!r.status || !r.settlement) {
    return <Card title={r.name}><Empty>Розрахункового листа за {monthLow(mk)} немає — людина не працювала в цьому місяці або місяць ще не закрито.</Empty></Card>;
  }

  const f = r.settlement as Obj, c = f.calc as Obj, auto = f.auto as Obj, cur = f.values as Obj;
  const ro = !r.canEdit || ["submitted", "paid"].includes(r.status);
  const kind = c.kind as string, level = (c.level ?? r.level) as string | null;
  const fields: Field[] = kind === "manager" ? (level === "start" ? ["margin", "pct", "rate", "bonus"] : ["margin", "pct"])
    : kind === "lead" ? ["pct", "rate"] : c.pctRule ? ["pct", "rate"] : ["rate"];

  // ---------- попередній перегляд до збереження (правила рушія; остаточно рахує сервер) ----------
  const p = (k: Field): number => { const x = parseNum(vals[k]); return x === null || Number.isNaN(x) ? Number(auto[k] ?? 0) : x; };
  const margin = fields.includes("margin") ? p("margin") : Number(cur.margin ?? 0);
  const overriddenPct = touched.pct ? p("pct") !== Number(auto.pct) : (r.overrides ?? {}).pct !== undefined;
  const derivedPct = kind === "manager" ? managerPct(S, level ?? "start", Number(c.plan ?? 0), margin)
    : kind === "lead" && S ? (c.plan && margin >= c.plan ? S.lead.pctHigh : S.lead.pctLow) : Number(cur.pct ?? 0);
  const pctV = overriddenPct ? p("pct") : touched.margin && derivedPct !== null ? derivedPct : Number(cur.pct ?? 0);
  const shownPct = touched.pct ? vals.pct : String(pctV);
  const rate = fields.includes("rate") ? p("rate") : Number(cur.rate ?? 0), bonus = fields.includes("bonus") ? p("bonus") : Number(cur.bonus ?? 0);
  const total = rate + margin * pctV / 100 + bonus + Number(f.birthday ?? 0) + Number(f.extras ?? 0);
  const pay = total - Number(f.advance ?? 0) - Number(f.officialDeducted ?? 0) + Number(f.ttn ?? 0);
  const changed = fields.filter((k) => touched[k] && Math.round(p(k) * 100) !== Math.round(Number(cur[k] ?? 0) * 100));
  const dirty = changed.length > 0;

  const sub: Record<Field, string> = {
    margin: kind === "manager" ? `${(c.deals?.length ?? 0) - (c.held ?? 0)} ${plural((c.deals?.length ?? 0) - (c.held ?? 0), "угода", "угоди", "угод")} «Успішно реалізовано» · план ${num(c.plan)}` : "",
    pct: kind === "manager" ? (level === "start" ? (S ? `«Старт»: ${S.start.pctLow} / ${S.start.pctHigh} %` : "«Старт»") : S ? `«Профі»: ${S.profi.pct1} / ${S.profi.pct2} / ${S.profi.pct3} %` : "«Профі»")
      : kind === "lead" ? (S ? `від маржі команди: ${S.lead.pctLow} % — план не виконано, ${S.lead.pctHigh} % — виконано` : "від маржі команди") : "від маржі компанії",
    rate: c.days && c.days.total < c.days.full ? `${c.days.total} з ${c.days.full} днів` : "повний місяць",
    bonus: c.kpi ? `конверсія ${pct(c.kpi.conv, 1)} (${c.kpi.targetDeals} з ${c.kpi.leads}) · норма ${c.kpi.normDays} з ${c.kpi.need} днів${c.kpi.waived ? ` · маржа від ${num(S?.kpi?.waiveFrom ?? 50000)} — без дзвінків` : ""}${c.kpi.noBonus ? " · звільнення: без бонусу" : ""}` : "",
  };

  async function save() {
    setBad(null);
    const overrides: Obj = {}, nn: Obj = {};
    for (const k of changed) {
      const x = parseNum(vals[k]);
      if (x !== null && Number.isNaN(x)) { setBad(k); toast(`${LABEL[k]}: число з помилкою.`, { error: true }); return; }
      overrides[k] = x;
      const differsAuto = x !== null && Math.round(x * 100) !== Math.round(Number(auto[k]) * 100);
      if (differsAuto && !String(notes[k] ?? "").trim()) { setBad(k); toast(`${LABEL[k]}: кожна зміна — з внутрішнім коментарем (працівник його не бачить).`, { error: true }); return; }
      nn[k] = notes[k] ?? "";
    }
    if (r!.status === "disputed" && !reply.trim()) { setBad("reply"); toast("Працівник не погоджується — напишіть відповідь, яку він побачить.", { error: true }); return; }
    setBusy(true);
    try {
      const out = await payrollApi.verify(mk, userId, { overrides, notes: nn, ...(reply.trim() ? { reply: reply.trim() } : {}) });
      setData(out); onSaved();
      toast(out.reAgree ? "Збережено — працівник погодить підсумок ще раз." : "Перевірено — працівник побачить підсумок у кабінеті й погодить або ні.");
    } catch (e) { setBad(errField(e)); toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  async function addExtra() {
    const a = parseNum(ex.amount);
    if (!a || Number.isNaN(a) || a <= 0) { setBad("amount"); toast("Сума — більше нуля.", { error: true }); return; }
    if (!ex.note.trim()) { setBad("note"); toast("Коментар обовʼязковий.", { error: true }); return; }
    setBusy(true);
    try { const out = await payrollApi.addExtra(mk, userId, { kind: ex.kind, amount: a, note: ex.note.trim() }); setData(out); setEx({ kind: ex.kind, amount: "", note: "" }); onSaved(); toast("Рядок додано."); }
    catch (e) { setBad(errField(e)); toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  async function delExtra(id: number) {
    setBusy(true);
    try { await payrollApi.deleteExtra(mk, userId, id); setDelId(null); await reload(); onSaved(); toast("Рядок прибрано."); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }
  async function resolve(decision: "keep" | "auto") {
    setBusy(true);
    try { const out = await payrollApi.resolve(mk, userId, { decision, ...(odReply.trim() ? { reply: odReply.trim() } : {}) }); setData(out); onSaved(); toast(decision === "keep" ? "Лишили перевірені суми — працівник побачить рішення." : "Повернули орієнтовні суми з кабінету."); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }

  const extras = (r.extras ?? []) as Obj[];
  const bdays = (c.birthdays ?? []) as Obj[];
  const deals = (c.deals ?? []) as Obj[];
  // ТТН — з сервера тим самим правилом рушія (враховує й місяці до запуску); з угод — лише якщо сервер не віддав
  const ttnSrv = r.ttn as Obj | null | undefined;
  const ttnTotal = ttnSrv ? Number(ttnSrv.total) : deals.length, ttnDone = ttnSrv ? Number(ttnSrv.done) : deals.filter((d) => d.ttnAt).length;
  const minTtn = Number(S?.ttn?.minPct ?? 70);
  const official = f.official as Obj | null;
  const hasTax = !!official;
  const readOnlyWhy = r.status === "submitted" || r.status === "paid" ? "Працівник уже погодив і подав форму — зміни лише корекцією наступного місяця."
    : ctx.me.employee?.id !== undefined && String(ctx.me.employee.id) === r.userId ? "Свою ЗП перевіряє інший фінансист або ОД — тут лише перегляд."
    : r.isFinance && !ctx.perms.has("payroll_final_word") ? "ЗП фінансиста перевіряє ОД — тут лише перегляд."
    : !ctx.perms.has("payroll_edit") ? "Лише перегляд." : !r.canEdit ? "Свою ЗП перевіряє інший фінансист або ОД — тут лише перегляд." : null;
  const verdict = r.status === "disputed" ? "Відповісти й зберегти" : r.status === "review" ? "Зберегти й надіслати працівнику" : "Зберегти зміни";

  return (
    <section className="zp-card zf-win">
      <header className="zf-win__head">
        <div>
          <div className="zf-win__name"><h2>{r.name}</h2><StatusPill status={r.status} />{r.role === "manager" && <LevelTag level={r.level} />}</div>
          <div className="zp-hint">
            {[r.title, r.teamName, `${monthLow(mk)} ${mk.slice(0, 4)}`, r.offerName].filter(Boolean).join(" · ")}
            {r.unsignedOffer && <b className="zp-tone--warn"> · новий офер ще не підписано — рахуємо за рівнем, задача в рекрутера</b>}
          </div>
        </div>
        <div className="zp-row">
          <button type="button" className="zp-btn zp-btn--sm" disabled={!prev} onClick={() => prev && onGo(prev.id)}>← {prev ? prev.name.split(" ")[0] : "Попередній"}</button>
          <button type="button" className="zp-btn zp-btn--sm" disabled={!next} onClick={() => next && onGo(next.id)}>{next ? next.name.split(" ")[0] : "Наступний"} →</button>
        </div>
      </header>

      <div className="zf-win__body">
        <div>
          {r.dispute && (
            <div className="zp-note zp-note--danger" style={{ marginBottom: 12 }}>
              <b>{r.name} не погоджується ({dt(r.dispute.at)}):</b> «{r.dispute.text}»
            </div>
          )}
          {r.reply && r.status !== "disputed" && <div className="zp-note" style={{ marginBottom: 12 }}><b>Відповідь працівнику:</b> {r.reply}</div>}
          {readOnlyWhy && <div className="zp-note zp-note--info" style={{ marginBottom: 12 }}>{readOnlyWhy}</div>}
          {r.payBlocked && <div className="zp-note zp-note--warn" style={{ marginBottom: 12 }}>Виплату заблоковано, доки обхідний лист не підпишуть усі.</div>}
          {!r.payBlocked && r.payNeedsOd && <div className="zp-note zp-note--warn" style={{ marginBottom: 12 }}>Обхідний лист підписано — виплата після погодження ОД (п. 9).</div>}

          {r.status === "disputed" && !ro && (
            <label className="zp-field" style={{ marginBottom: 14 }}>
              <span>Відповідь працівнику <span className="req">*</span></span>
              <textarea className={`zp-textarea ${bad === "reply" ? "is-changed" : ""}`} value={reply} onChange={(e) => setReply(e.target.value)}
                placeholder="що перевірили і що вирішили — працівник побачить цю відповідь" />
            </label>
          )}

          <Lbl>Розрахунок: автоматично з ядра → істинне</Lbl>
          <div className="zf-ovr">
            <span className="zf-ovr__h">Показник</span><span className="zf-ovr__h zf-ovr__h--r zf-ovr__h--auto">Автоматично</span><span className="zf-ovr__h zf-ovr__h--r">Істинне</span>
            {kind === "lead" && (
              <>
                <div className="zf-ovr__name">Маржа команди<small>з перевірених даних менеджерів · план {num(c.plan)}</small></div>
                <div className="zf-ovr__auto">{money(auto.margin)}</div>
                <input className="zp-input zp-input--num" value={num(cur.margin)} disabled aria-label="Маржа команди" />
                <div className="zf-ovr__note zp-hint">{((c.members ?? []) as Obj[]).filter((m) => m.changed).map((m) => `${m.name}: маржу змінено при перевірці`).join("; ") || "Змінюється через перевірку менеджерів команди."}</div>
              </>
            )}
            {kind === "staff" && c.pctRule && (
              <>
                <div className="zf-ovr__name">Маржа компанії<small>база відсотка · план {num(c.plan)}</small></div>
                <div className="zf-ovr__auto">{money(auto.margin)}</div>
                <input className="zp-input zp-input--num" value={num(cur.margin)} disabled aria-label="Маржа компанії" />
                <div className="zf-ovr__note zp-hint">Сума маржі менеджерів — змінюється через їхню перевірку.</div>
              </>
            )}
            {fields.map((k) => {
              // відсоток, що лише перерахувався від нової маржі, — не зміна (його виведе рушій); зміна — те, що ввели руками
              const isChanged = k === "pct" ? overriddenPct : Math.round(p(k) * 100) !== Math.round(Number(auto[k] ?? 0) * 100);
              return (
                <FieldRow key={k} label={k === "rate" && kind === "lead" ? "Ставка тім-ліда" : k === "pct" && kind === "lead" ? "Відсоток від маржі команди" : k === "pct" && kind === "staff" ? "Відсоток від маржі компанії" : LABEL[k]}
                  sub={sub[k]} auto={k === "pct" ? pct(auto.pct) : money(auto[k])} value={k === "pct" ? shownPct : vals[k]}
                  changed={isChanged} bad={bad === k} disabled={ro}
                  onChange={(v) => { setVals((s) => ({ ...s, [k]: v })); setTouched((t) => ({ ...t, [k]: true })); }}
                  note={notes[k] ?? ""} onNote={(v) => setNotes((s) => ({ ...s, [k]: v }))} showNote={isChanged || !!notes[k]} />
              );
            })}
          </div>

          <Lbl>Дні народження — автоматично за правилом</Lbl>
          <div className="zf-box">
            {bdays.length ? bdays.map((b, i) => (
              <Line key={i} label={b.kind === "gift" ? "Ваш день народження" : `ДН колеги: ${b.who?.name || "колега"}`}
                sub={b.kind === "gift" ? `${dd(b.date)} · збір колег і подарунок компанії${b.gift?.young ? " · стаж до року" : ""}` : dd(b.date)}
                value={signed(b.amount)} tone={signTone(b.amount)} />
            )) : <div className="zp-hint" style={{ padding: "8px 0" }}>Немає днів народження цього місяця.</div>}
          </div>

          {kind === "manager" && (
            <>
              <Lbl>ТТН — автоматично з «ТТН моніторинг»</Lbl>
              <div className="zf-box">
                <div className="zf-exrow">
                  <span>ТТН {monthGen(mk)}: <b>{ttnDone} з {ttnTotal}</b> ({pct(ttnTotal ? ttnDone / ttnTotal * 100 : 100, 1)})</span>
                  {!ttnTotal || ttnDone / ttnTotal * 100 >= minTtn ? <Pill tone="ok">норма</Pill> : <Pill tone="warn">менше {minTtn} %</Pill>}
                </div>
                {((f.ttnLines ?? []) as Obj[]).map((t, i) => (
                  <div className="zf-exrow" key={i}>
                    {t.kind === "hold" && <span><b>Утримання до закриття ТТН</b> <span className="zp-tone--danger">{money(t.amount)}</span> · <span className="zp-muted">{t.ttn.done} з {t.ttn.total} ({pct(t.ttn.pct, 1)}), потрібно від {minTtn} %{r.form ? " · зафіксовано при поданні форми" : ""}</span></span>}
                    {t.kind === "release" && <span><b>Повернення утримання за ТТН {monthGen(t.month)}</b> <span className="zp-tone--ok">{money(t.amount, { sign: true })}</span> · <span className="zp-muted">{t.ttn.done} з {t.ttn.total} ({pct(t.ttn.pct, 1)}){t.at ? `, закрито ${dd(t.at)}` : ""}</span></span>}
                    {t.kind === "carry" && <span><b>Утримання за ТТН {monthGen(t.month)}</b> · <span className="zp-muted">{t.ttn.done} з {t.ttn.total} ({pct(t.ttn.pct, 1)}) — ще не закрито, переходить далі</span></span>}
                  </div>
                ))}
              </div>
            </>
          )}

          <Lbl>Премії, утримання, корекції, офіційна ЗП</Lbl>
          <div className="zf-box">
            {!extras.length && !official && <div className="zp-hint" style={{ padding: "8px 0" }}>Немає.</div>}
            {extras.map((x) => (
              <div className="zf-exrow" key={x.id}>
                <span><b>{x.label}</b> <span className={x.sign < 0 ? "zp-tone--danger" : "zp-tone--ok"}>{x.sign < 0 ? money(-x.amount) : money(x.amount, { sign: true })}</span> · <span className="zp-muted">{x.note} — {x.by}, {dt(x.at)}</span></span>
                {!ro && (delId === x.id
                  ? <span className="zf-confirm">Прибрати рядок?<button type="button" className="zp-btn zp-btn--sm zp-btn--danger" disabled={busy} onClick={() => void delExtra(x.id)}>Так, прибрати</button><button type="button" className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setDelId(null)}>Ні</button></span>
                  : <button type="button" className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setDelId(x.id)}>Прибрати</button>)}
              </div>
            ))}
            {official && (
              <div className="zf-exrow">
                <span><b>Офіційна ЗП (щомісяця)</b> {money(official.amount)} · <span className="zp-muted">{official.deduct ? "виплачується окремо й вираховується з цієї суми" : "окремо, не вираховується"} · діє з {official.from}</span></span>
                <span className="zp-hint">змінюється в «Налаштуваннях → Працівники»</span>
              </div>
            )}
          </div>
          {!ro && (
            <div className="zf-exadd" style={{ marginTop: 10 }}>
              <label className="zp-field"><span>Що</span>
                <select className="zp-select" value={ex.kind} onChange={(e) => setEx({ ...ex, kind: e.target.value })}>
                  {EXTRA_KINDS.filter(([k]) => k !== "tax" || hasTax).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label className="zp-field"><span>Сума, ₴</span>
                <input className={`zp-input zp-input--num ${bad === "amount" ? "is-changed" : ""}`} inputMode="decimal" placeholder="напр. 2000" value={ex.amount} onChange={(e) => setEx({ ...ex, amount: e.target.value })} />
              </label>
              <label className="zp-field"><span>Внутрішній коментар</span>
                <input className={`zp-input ${bad === "note" ? "is-changed" : ""}`} placeholder="за що / чому" value={ex.note} onChange={(e) => setEx({ ...ex, note: e.target.value })} />
              </label>
              <button type="button" className="zp-btn" disabled={busy} onClick={() => void addExtra()}>Додати рядок</button>
            </div>
          )}

          <div className={`zf-sum ${pay < 0 ? "zf-sum--neg" : ""}`} style={{ marginTop: 16 }}>
            <div><b>Нараховано: {money(total)}</b> · орієнтовно {money(f.autoTotal)}{dirty ? " · до збереження — попередньо" : ""}</div>
            <div>
              {[Number(f.advance) ? `аванс −${money(f.advance)}` : "",
                ...((f.ttnLines ?? []) as Obj[]).map((t) => (t.kind === "hold" ? `ТТН ${money(t.amount)} (утримано до закриття)` : t.kind === "release" ? `ТТН ${monthGen(t.month)} ${money(t.amount, { sign: true })} (повернення)` : "")),
                official ? (official.deduct ? `офіційна ЗП −${money(official.amount)} (виплачується окремо)` : `офіційна ЗП ${money(official.amount)} — окремо, не вираховується`) : ""]
                .filter(Boolean).join(" · ")}
              {(Number(f.advance) || (f.ttnLines ?? []).length || official) ? " → " : ""}<b>До виплати (готівка / карта): {money(pay)}</b>
            </div>
            {pay < 0 && <div>До виплати відʼємне: аванс і офіційна ЗП більші за нараховане. Перенесіть різницю утриманням на наступний місяць.</div>}
          </div>

          {!ro && (
            <div className="zf-actions" style={{ marginTop: 14 }}>
              <button type="button" className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>{busy ? "Зберігаємо…" : verdict}</button>
              {r.status === "agreed" && <span className="zp-hint">Працівник уже погодив — після змін погодить ще раз.</span>}
            </div>
          )}
          {!ro && <div className="zp-hint" style={{ marginTop: 6 }}>Працівник побачить підсумок у кабінеті й погодить або ні. Далі — наступний у черзі.</div>}

          {r.status === "disputed" && r.canResolve && (
            <div className="zp-card" style={{ marginTop: 16, boxShadow: "none" }}>
              <Lbl>Рішення ОД — останнє слово</Lbl>
              <textarea className="zp-textarea" value={odReply} onChange={(e) => setOdReply(e.target.value)} placeholder="Відповідь працівнику (необовʼязково — інакше стандартний текст)" />
              <div className="zf-actions" style={{ marginTop: 8 }}>
                <button type="button" className="zp-btn zp-btn--dark" disabled={busy} onClick={() => void resolve("keep")}>Лишити перевірене</button>
                <button type="button" className="zp-btn" disabled={busy} onClick={() => void resolve("auto")}>Повернути орієнтовні з кабінету</button>
              </div>
            </div>
          )}
        </div>

        <aside>
          <div className="zf-preview">
            <div className="zp-k">Що побачить працівник</div>
            <div className="zf-preview__sum">{money(pay)}</div>
            <div className="zf-box">
              {(kind === "manager" || kind === "lead" || c.pctRule) && <Line label={kind === "lead" ? "Маржа команди" : kind === "staff" ? "Маржа компанії" : "Маржа"} value={money(margin)} />}
              {(kind !== "staff" || c.pctRule) && <Line label="Відсоток" value={`${pct(pctV)} = ${money(margin * pctV / 100)}`} />}
              {rate ? <Line label="Ставка" value={money(rate)} /> : null}
              {bonus ? <Line label="Бонус за КПІ" value={money(bonus)} /> : null}
              {bdays.map((b, i) => <Line key={i} label={b.kind === "gift" ? "День народження" : `ДН колеги: ${b.who?.name || "колега"}`} value={signed(b.amount)} tone={signTone(b.amount)} />)}
              {extras.map((x) => <Line key={x.id} label={x.label} value={x.sign < 0 ? money(-x.amount) : money(x.amount, { sign: true })} tone={x.sign < 0 ? "danger" : "ok"} />)}
            </div>
            <div className="zf-box">
              <Line label="Нараховано" value={money(total)} />
              {Number(f.advance) ? <Line label="Аванс, виплачено" value={money(-f.advance)} tone="danger" /> : null}
              {Number(f.officialDeducted) ? <Line label="Офіційна ЗП (окремо)" value={money(-f.officialDeducted)} tone="danger" /> : null}
              {Number(f.ttn) ? <Line label="ТТН" value={signed(f.ttn)} tone={signTone(f.ttn)} /> : null}
              <Line label={<b>До виплати — готівка / карти</b>} value={money(pay)} strong />
            </div>
            <div className="zp-hint">Лише підсумкові суми — без «було → стало» і без ваших коментарів.</div>
          </div>

          {kind === "manager" && (
            <details className="zf-details" open style={{ marginTop: 16 }}>
              <summary>Угоди «Успішно реалізовано» · {deals.length}</summary>
              {deals.length ? (
                <table className="zf-deals"><tbody>
                  {deals.map((d) => (
                    <tr key={d.id}>
                      <td>{dd(d.date)}<div className="id">{d.id}</div></td>
                      <td>{d.client}{!d.counts && <div className="zp-hint">не йде в ЗП за правилом місяця</div>}</td>
                      <td className="r">{money(d.margin)}</td>
                      <td>{d.pay === "paid" ? <Pill tone="ok">оплачено</Pill> : d.pay === "over" ? <Pill tone="danger">прострочено</Pill> : <Pill>чекаємо оплату</Pill>}
                        {!d.ttnAt && <div style={{ marginTop: 3 }}><Pill tone="warn">без ТТН</Pill></div>}</td>
                    </tr>
                  ))}
                </tbody></table>
              ) : <div className="zp-hint">Угод «Успішно реалізовано» за місяць немає.</div>}
            </details>
          )}
          {kind === "lead" && (
            <details className="zf-details" open style={{ marginTop: 16 }}>
              <summary>Команда · {(c.members ?? []).length}</summary>
              <table className="zf-deals"><tbody>
                {((c.members ?? []) as Obj[]).map((m) => (
                  <tr key={m.empId}>
                    <td>{m.name}<div className="id">{LEVEL_SHORT(m.level)}{m.changed ? " · маржу змінено при перевірці" : ""}</div></td>
                    <td className="r">{money(m.margin)}<div className="id">план {num(m.plan)}</div></td>
                    <td>{m.planDone ? <Pill tone="ok">план є</Pill> : <Pill>план ні</Pill>}</td>
                  </tr>
                ))}
              </tbody></table>
            </details>
          )}

          <div className="zp-k zf-lbl">Історія змін</div>
          {((r.history ?? []) as Obj[]).length ? (
            <div className="zp-history">
              {((r.history ?? []) as Obj[]).slice(0, 40).map((h) => (
                <div key={h.id}>
                  <b>{h.what}</b> <span className="zp-muted">— {h.by}, {dt(h.at)}{h.internal ? " · внутрішнє" : ""}</span>
                  {h.note && <div className="zp-muted">{h.note}</div>}
                </div>
              ))}
            </div>
          ) : <div className="zp-hint">Ще нічого не змінювали.</div>}
        </aside>
      </div>
    </section>
  );
}

const LEVEL_SHORT = (l: string | null | undefined) => (l === "profi" ? "Профі" : l === "start" ? "Старт" : "рівень не задано");

function FieldRow({ label, sub, auto, value, changed, bad, disabled, onChange, note, onNote, showNote }: {
  label: string; sub: string; auto: string; value: string; changed: boolean; bad: boolean; disabled: boolean;
  onChange: (v: string) => void; note: string; onNote: (v: string) => void; showNote: boolean;
}) {
  return (
    <>
      <div className="zf-ovr__name">{label}{sub && <small>{sub}</small>}</div>
      <div className="zf-ovr__auto">{auto}</div>
      <input className={`zp-input zp-input--num ${changed || bad ? "is-changed" : ""}`} inputMode="decimal" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} aria-label={`${label} — істинне значення`} />
      {(showNote || bad) && (
        <div className="zf-ovr__note">
          <textarea className={`zp-textarea ${bad ? "is-changed" : ""}`} rows={2} value={note} disabled={disabled} onChange={(e) => onNote(e.target.value)}
            placeholder="Внутрішній коментар — обовʼязково, якщо змінили. Працівник його не бачить." />
        </div>
      )}
    </>
  );
}
