/**
 * 💰 «Налаштування» (ТЗ §5.5, макет p08-set.js): загальні правила (коли маржа йде в ЗП), шкали / аванс / ДН / ТТН, офери,
 * працівники й умови, оргструктура, сповіщення (подія → канали), історія змін.
 * 🔒 Будь-яка зміна правил — НОВА ВЕРСІЯ з 1-го наступного місяця (або пізніше) і з причиною: поточний місяць рахується за
 * старими правилами (`saveSettings`). Змінюють — `payroll_settings`; умови людей — `payroll_edit`; правила сповіщень — `notify_rules`.
 * Без `payroll_view_all` (адмін лише з `notify_rules`) — лише блок «Сповіщення».
 */
import { useState, type ReactNode } from "react";
import type { PayrollCtx } from "../PayrollSection";
import { errText, notificationsApi, payrollApi, type Obj } from "../api";
import { Card, Empty, Loading, Pill, money, monthTitle, nextMonth, num, useLoad } from "../ui";
import { useToast } from "../../components/Toasts";
import { Field, Modal, OFFER_NAMES, PAY_MODES, Seg, dt } from "./common";
import { PeopleSettings } from "./PeopleSettings";
import { OrgSettings } from "./OrgSettings";

/* eslint-disable @typescript-eslint/no-explicit-any */
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const getP = (o: Obj, path: string): any => path.split(".").reduce((a: any, k) => (a == null ? a : a[k]), o);
const setP = (o: Obj, path: string, v: unknown) => { const ks = path.split("."); let a: any = o; ks.slice(0, -1).forEach((k) => { a[k] = a[k] ?? {}; a = a[k]; }); a[ks[ks.length - 1]] = v; };
const ladderText = (l: number[][] | undefined) => (l ?? []).map(([c, b]) => `${c}:${b}`).join(", ");
const ladderParse = (s: string): number[][] | null => {
  const out: number[][] = [];
  for (const part of s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+(?:[.,]\d+)?)\s*[:→-]+\s*(\d+)$/.exec(part.replace(/\s(?=\d{3}\b)/g, ""));
    if (!m) return null;
    out.push([Number(m[1].replace(",", ".")), Number(m[2])]);
  }
  return out.length ? out.sort((a, b) => a[0] - b[0]) : null;
};

/** Поля «шкали, аванс, ДН, ТТН» — шляхи в `DEFAULT_SETTINGS` рушія. */
const SCALES: Array<[string, Array<[string, string]>]> = [
  ["«Старт»", [["start.rate", "Ставка, ₴"], ["start.pctLow", "% — план не виконано"], ["start.pctHigh", "% — план виконано"], ["start.minPlanForHigh", "Вищий % — якщо план від, ₴"]]],
  ["«Профі»", [["profi.threshold", "Поріг, ₴"], ["profi.pct1", "% — до порогу"], ["profi.pct2", "% — від порогу"], ["profi.pct3", "% — план керівника виконано"]]],
  ["Тім-лід", [["lead.pctLow", "% — план команди не виконано"], ["lead.pctHigh", "% — виконано"]]],
  ["Бонус за КПІ («Старт»)", [["kpi.waiveFrom", "Без дзвінків від маржі, ₴"], ["kpi.missDaysAllowed", "Днів без норми без втрати бонусу"]]],
  ["Аванс", [["advance.fromDay", "Заявки з числа"], ["advance.managerPct", "Менеджер, % маржі"], ["advance.leadPct", "Тім-лід, % маржі команди"], ["advance.staffPct", "Ставка, % ставки"]]],
  ["Дні народження", [["birthday.each", "З кожного колеги, ₴"], ["birthday.company", "Від компанії, ₴"], ["birthday.lead", "Тім-ліду від компанії, ₴"], ["birthday.perMonth", "Стаж до року: за місяць, ₴"]]],
  ["ТТН", [["ttn.minPct", "Мінімум угод з ТТН, %"], ["ttn.hold", "Утримання, ₴"]]],
  ["Офер команди Лілії Шаврової", [["offers.ls.startRate", "Ставка «Старту», ₴"], ["offers.ls.startPlan", "План «Старту», ₴"], ["offers.ls.autoProfiFrom", "Автоперехід: маржа понад, ₴"]]],
];

function SaveVersionModal({ base, draft, live, title, children, onClose, onDone }: { base: Obj; draft: Obj; live: string; title: string; children?: ReactNode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [validFrom, setFrom] = useState(nextMonth(live));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const opts = [nextMonth(live), nextMonth(nextMonth(live)), nextMonth(nextMonth(nextMonth(live)))];
  async function save() {
    setErr(null);
    if (reason.trim().length < 3) { setErr("Вкажіть причину зміни."); return; }
    const settings = clone(draft); delete settings.teamOffers;   // офер команди — з «Оргструктури», не з версії правил
    setBusy(true);
    try { await payrollApi.saveSettings({ validFrom, reason: reason.trim(), settings }); toast(`Нова версія правил — з 1 ${monthTitle(validFrom).toLowerCase()}.`); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  void base;
  return (
    <Modal title={title} onClose={onClose} wide
      foot={<><button className="zp-btn zp-btn--primary" disabled={busy} onClick={() => void save()}>Зберегти · діє з 1 {monthTitle(validFrom).split(" ")[0].toLowerCase()}</button><button className="zp-btn" onClick={onClose}>Скасувати</button><span className="zp-hint">Поточний місяць рахується за старими правилами.</span></>}>
      {children}
      <div className="zps-g2">
        <Field label="Діє з місяця" req><select className="zp-select" value={validFrom} onChange={(e) => setFrom(e.target.value)}>{opts.map((m) => <option key={m} value={m}>з 1-го — {monthTitle(m)}</option>)}</select></Field>
        <Field label="Причина" req><input className="zp-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="напр. новий офер з 1 грудня" /></Field>
      </div>
      {err && <div className="zp-err">{err}</div>}
    </Modal>
  );
}

function ScalesModal({ base, live, onClose, onDone }: { base: Obj; live: string; onClose: () => void; onDone: () => void }) {
  const [draft, setDraft] = useState<Obj>(() => clone(base));
  const [lad, setLad] = useState(ladderText(base.kpi?.ladder));
  const [ladErr, setLadErr] = useState<string | null>(null);
  const setV = (path: string, raw: string) => { const d = clone(draft); const n = Number(raw.replace(/\s/g, "").replace(",", ".")); setP(d, path, raw.trim() === "" ? null : Number.isFinite(n) ? n : raw); setDraft(d); };
  const onLad = (s: string) => { setLad(s); const p = ladderParse(s); if (!p) { setLadErr("Формат: конверсія:бонус через кому, напр. 12:3000, 15:5000"); return; } setLadErr(null); const d = clone(draft); setP(d, "kpi.ladder", p); setDraft(d); };
  return (
    <SaveVersionModal base={base} draft={ladErr ? base : draft} live={live} title="Шкали, аванс, дні народження, ТТН" onClose={onClose} onDone={onDone}>
      {SCALES.map(([group, fields]) => (
        <div key={group} className="zp-grid" style={{ gap: 6 }}>
          <div className="zps-lbl">{group}</div>
          <div className="zps-g3">
            {fields.map(([path, label]) => (
              <Field key={path} label={label}><input className={`zp-input zp-input--num ${getP(draft, path) !== getP(base, path) ? "is-changed" : ""}`} inputMode="decimal" value={getP(draft, path) ?? ""} onChange={(e) => setV(path, e.target.value)} /></Field>
            ))}
          </div>
        </div>
      ))}
      <Field label="Сходинки бонусу за КПІ — конверсія % : бонус ₴" err={ladErr}><input className="zp-input" value={lad} onChange={(e) => onLad(e.target.value)} /></Field>
      <div className="zp-hint">Норма дзвінків на день (зараз {base.kpi?.normCalls}) — у «Планах» дашборда, одна на всіх менеджерів.</div>
    </SaveVersionModal>
  );
}

function Rules({ S }: { S: Obj }) {
  const rows: Array<[string, string]> = [
    ["«Старт»", `ставка ${num(S.start?.rate)} ₴ · ${S.start?.pctLow} % — план не виконано · ${S.start?.pctHigh} % — виконано (план від ${num(S.start?.minPlanForHigh)})`],
    ["«Профі»", `${S.profi?.pct1} % — до ${num(S.profi?.threshold)} · ${S.profi?.pct2} % — від ${num(S.profi?.threshold)} · ${S.profi?.pct3} % — план керівника виконано`],
    ["Бонус за КПІ («Старт»)", `норма ${S.kpi?.normCalls} дзвінків на день — з «Планів» дашборда · днів: усі робочі мінус ${S.kpi?.missDaysAllowed} · від ${num(S.kpi?.waiveFrom)} маржі — без дзвінків · ${(S.kpi?.ladder ?? []).map((s: number[]) => `${s[0]} % → ${num(s[1])}`).join(", ")}`],
    ["Тім-лід", `ставка — у кожного своя · ${S.lead?.pctLow} % / ${S.lead?.pctHigh} % від маржі команди без власних угод (план команди — з «Планів»)`],
    ["Аванс", `заявка з ${S.advance?.fromDay} числа до кінця місяця · менеджер — до ${S.advance?.managerPct} % маржі «Успішно реалізовано» · тім-лід — до ${S.advance?.leadPct} % маржі команди · ставка — до ${S.advance?.staffPct} % ставки · не більше нарахованого на дату заявки · при закритті місяця аванс вираховується`],
    ["Дні народження", `з кожного колеги ${num(S.birthday?.each)} ₴, автоматично (у місяці дня народження) · іменинник — збір + ${num(S.birthday?.company)} ₴ від компанії, тім-лід — ${num(S.birthday?.lead)} ₴ · стаж до року — ${num(S.birthday?.perMonth)} ₴ × відпрацьовані місяці + ${num(S.birthday?.company)} ₴ від компанії, без збору`],
    ["ТТН", `якщо в закритому місяці ТТН є менш ніж у ${S.ttn?.minPct} % угод (дані — «Бізнес-асистент → ТТН моніторинг»), ${money(S.ttn?.hold)} утримуємо з виплати · закрили ТТН до виплати — сума йде в цю виплату · після виплати — переходить на наступний місяць`],
    ["Обхідний лист", "при звільненні — обовʼязково; створюється, щойно фінансист оформив звільнення · підписують тім-лід, бізнес-асистент, бухгалтерія, HR; останній пункт — ОД · поки не підписали всі — форма на виплату й виплата заблоковані (п. 11 оферу)"],
    ["Офіційна ЗП", "у кожного своя — у картці працівника; повторюється щомісяця, поки фінансист або операційний директор не змінить · «вираховувати з загальної ЗП»: так — решту доплачуємо готівкою або на карту; ні — офіційна окремо, понад загальну"],
  ];
  return (
    <div className="zp-table-wrap">
      <table className="zp-table zps-rules"><thead><tr><th>Правило</th><th>Зараз</th></tr></thead>
        <tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Offers({ S, teams }: { S: Obj; teams: Obj[] }) {
  const ofTeams = (code: string) => teams.filter((t) => (t.offer ?? "std") === code).map((t) => t.name).join(", ") || "—";
  const ladder = (S.kpi?.ladder ?? []).map((x: number[]) => `${x[0]} % → ${num(x[1])}`).join(", ");
  return (
    <Card title="Офери менеджерів" aside="офер — за командою; умови однакові для всіх у команді">
      <div className="zp-table-wrap">
        <table className="zp-table zps-rules">
          <thead><tr><th>Офер</th><th>Команди</th><th>«Старт»</th><th>Бонус за КПІ</th><th>«Профі»</th><th>Перехід на «Профі»</th></tr></thead>
          <tbody>
            <tr><td>{OFFER_NAMES.std}</td><td>{ofTeams("std")}</td><td>ставка {num(S.start?.rate)} ₴ + {S.start?.pctLow} / {S.start?.pctHigh} % · план — з «Планів»</td><td>так — {ladder}</td>
              <td>{S.profi?.pct1} / {S.profi?.pct2} / {S.profi?.pct3} % · поріг {num(S.profi?.threshold)} · план керівника</td><td>рішення менеджера або керівництва, з 1-го числа · новий офер + задача рекрутеру</td></tr>
            <tr><td>{OFFER_NAMES.ls}</td><td>{ofTeams("ls")}</td><td>ставка {num(S.offers?.ls?.startRate)} ₴ + {S.start?.pctLow} / {S.start?.pctHigh} % · план {num(S.offers?.ls?.startPlan)} ₴ за офером</td><td>немає</td>
              <td>{S.profi?.pct1} / {S.profi?.pct2} / {S.profi?.pct3} % · поріг {num(S.profi?.threshold)} · власна база й реактивація</td><td>автоматично: маржа понад {num(S.offers?.ls?.autoProfiFrom)} ₴ два місяці поспіль → з наступного місяця, назавжди · офер той самий</td></tr>
          </tbody>
        </table>
      </div>
      <div className="zp-hint" style={{ marginTop: 8 }}>Офер команди змінюється в «Оргструктурі» (команда → офер); умови оферів — кнопкою «Змінити шкали…» вище.</div>
    </Card>
  );
}

function NotifyRules() {
  const toast = useToast();
  const { data, err, reload, setData } = useLoad(() => notificationsApi.rules(), []);
  if (!data) return <Card title="Сповіщення"><Loading err={err} onRetry={reload} /></Card>;
  async function upd(type: string, body: { channels?: string[]; enabled?: boolean }) {
    try { await notificationsApi.setRule(type, body); setData((xs) => (xs ?? []).map((r) => (r.type === type ? { ...r, ...body, channels: body.channels ? ["dashboard", ...body.channels.filter((c) => c !== "dashboard")] : r.channels } : r))); }
    catch (e) { toast(errText(e), { error: true }); }
  }
  const rules = data as Obj[];
  return (
    <Card title="Сповіщення" aside="центр сповіщень — спільний для всього дашборда; зарплата — перший модуль">
      {rules.length ? (
        <div className="zp-table-wrap">
          <table className="zp-table">
            <thead><tr><th>Модуль</th><th>Подія</th><th>Кому</th><th>Дія</th><th>Канали</th><th>Увімкнено</th></tr></thead>
            <tbody>
              {rules.map((r) => {
                const ch = (r.channels ?? []) as string[];
                const toggle = (c: string, on: boolean) => void upd(r.type, { channels: on ? [...ch, c] : ch.filter((x) => x !== c) });
                return (
                  <tr key={r.type}>
                    <td>{r.module}</td><td>{r.event}</td><td className="zp-hint">{r.recipients}</td>
                    <td>{r.act ? <Pill tone="warn">потрібна дія</Pill> : <span className="zp-hint">до відома</span>}</td>
                    <td>
                      <div className="zp-row" style={{ gap: 10 }}>
                        <span className="zp-hint">дашборд</span>
                        <label className="zp-check"><input type="checkbox" checked={ch.includes("telegram")} onChange={(e) => toggle("telegram", e.target.checked)} />Telegram</label>
                        <label className="zp-check" title={r.emailReady ? "лист на пошту з акаунта дашборда" : "email не налаштовано — позначка збережеться, листи підуть, коли на сервері зʼявиться SMTP_URL"}><input type="checkbox" checked={ch.includes("email")} onChange={(e) => toggle("email", e.target.checked)} />email</label>
                      </div>
                      {!r.emailReady && ch.includes("email") && <div className="zp-hint zp-tone--warn">email не налаштовано — потрібен SMTP_URL у .env сервера; до того листи не підуть</div>}
                    </td>
                    <td><input type="checkbox" checked={!!r.enabled} onChange={(e) => void upd(r.type, { enabled: e.target.checked })} aria-label={`Увімкнено: ${r.event}`} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>Правил сповіщень немає.</Empty>}
      <div className="zp-hint" style={{ marginTop: 8 }}>«Потрібна дія» висить, поки її не виконано, і закривається сама: підписали, погодили, виплатили. Чекає понад 2 дні — позначка «чекає N днів». Telegram — бот «UTS Підпис», якщо людина привʼязала Telegram.</div>
    </Card>
  );
}

export default function SettingsTab({ ctx }: { ctx: PayrollCtx }) {
  const canView = ctx.perms.has("payroll_view_all"), canSet = ctx.perms.has("payroll_settings"), canEdit = ctx.perms.has("payroll_edit"), canNotify = ctx.perms.has("notify_rules");
  const live = ctx.liveMonth;
  const { data, err, reload } = useLoad(async () => {
    if (!canView) return null;
    const [cur, next, emp, hist] = await Promise.all([payrollApi.settings(live), payrollApi.settings(nextMonth(live)), payrollApi.employees(), payrollApi.history()]);
    return { cur, next, emp, hist: hist as Obj[] };
  }, [live, canView]);
  const [scales, setScales] = useState(false);
  const [general, setGeneral] = useState<Obj | null>(null);

  if (!canView) return canNotify ? <NotifyRules /> : <Empty>Налаштування зарплати — для фінансистів і операційного директора.</Empty>;
  if (!data) return <Loading err={err} onRetry={reload} />;
  const S = data.cur.settings as Obj, N = data.next.settings as Obj;
  const pending = (data.cur.versions as Obj[]).filter((v) => v.validFrom > live);
  const mode = PAY_MODES.find((m) => m[0] === S.payMode) ?? PAY_MODES[0];
  const done = () => { setScales(false); setGeneral(null); void reload(); void ctx.reloadMe(); };

  return (
    <div className="zp-grid">
      <Card title="Загальні правила" aside={canSet ? "змінюють фінансисти й операційний директор; кожна зміна — нова версія з наступного місяця й в історії" : "лише перегляд"}>
        <div className="zp-grid" style={{ gap: 12 }}>
          {pending.length > 0 && (
            <div className="zp-note zp-note--info">
              {pending.map((v) => <div key={v.id}>Нова версія з 1 {monthTitle(v.validFrom).toLowerCase()} — «{v.reason}» ({v.by ?? "—"}, {dt(v.at)}).</div>)}
            </div>
          )}
          <div>
            <div className="zps-lbl" style={{ marginBottom: 6 }}>Чи впливає оплата клієнта на ЗП</div>
            <Seg items={PAY_MODES.map(([k, l]) => [k, l] as [string, string])} value={S.payMode} disabled={!canSet} onChange={(k) => { if (k !== S.payMode) setGeneral({ ...clone(N), payMode: k }); }} />
            <div className="zp-hint" style={{ marginTop: 6 }}>{mode[2]}</div>
          </div>
          <div className="zps-g3">
            <div className="zp-stat"><div className="zp-stat__label">Фінансист перевіряє до, число</div><div className="zp-stat__value">{S.verifyByDay}</div></div>
            <div className="zp-stat"><div className="zp-stat__label">Виплата до, число</div><div className="zp-stat__value">{S.payByDay}</div></div>
          </div>
          <Rules S={S} />
          {canSet && (
            <div className="zp-row">
              <button className="zp-btn zp-btn--sm" onClick={() => setScales(true)}>Змінити шкали, аванс, дні народження, ТТН</button>
              <button className="zp-btn zp-btn--sm" onClick={() => setGeneral(clone(N))}>Змінити дати перевірки й виплати</button>
            </div>
          )}
        </div>
      </Card>
      <Offers S={S} teams={data.cur.teams as Obj[]} />
      <PeopleSettings emp={data.emp} org={data.cur} settings={S} canEdit={canEdit} onChanged={() => { void reload(); }} />
      <OrgSettings org={data.cur} people={(data.emp.people ?? []) as Obj[]} canEdit={canSet} onChanged={() => { void reload(); }} />
      {canNotify && <NotifyRules />}
      <Card title="Історія змін" aside="умови, шкали, офіційна ЗП, перевірки, аванси, згоди, виплати">
        {data.hist.length ? (
          <ul className="zps-hist">
            {data.hist.slice(0, 60).map((h) => <li key={h.id}><b>{h.what}</b> <span className="w">— {h.by}, {dt(h.at)}</span>{h.internal && <span className="w"> · внутрішнє</span>}{h.note && <><br /><span className="w">{h.note}</span></>}</li>)}
          </ul>
        ) : <Empty>Змін ще не було.</Empty>}
        {(data.cur.versions as Obj[]).length > 0 && (
          <details style={{ marginTop: 10 }}><summary className="zp-hint">Версії правил ({data.cur.versions.length})</summary>
            <ul className="zps-hist">{(data.cur.versions as Obj[]).map((v) => <li key={v.id}><b>з 1 {monthTitle(v.validFrom).toLowerCase()}</b> — {v.reason} <span className="w">— {v.by ?? "—"}, {dt(v.at)}</span></li>)}</ul>
          </details>
        )}
      </Card>
      {scales && <ScalesModal base={N} live={live} onClose={() => setScales(false)} onDone={done} />}
      {general && (
        <GeneralModal base={N} draft={general} live={live} onClose={() => setGeneral(null)} onDone={done} />
      )}
    </div>
  );
}

function GeneralModal({ base, draft, live, onClose, onDone }: { base: Obj; draft: Obj; live: string; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState<Obj>(draft);
  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  return (
    <SaveVersionModal base={base} draft={d} live={live} title="Загальні правила" onClose={onClose} onDone={onDone}>
      <div>
        <div className="zps-lbl" style={{ marginBottom: 6 }}>Чи впливає оплата клієнта на ЗП</div>
        <Seg items={PAY_MODES.map(([k, l]) => [k, l] as [string, string])} value={d.payMode} onChange={(k) => set("payMode", k)} />
        <div className="zp-hint" style={{ marginTop: 6 }}>{PAY_MODES.find((m) => m[0] === d.payMode)?.[2]}</div>
      </div>
      <div className="zps-g3">
        <Field label="Фінансист перевіряє до, число"><input className="zp-input zp-input--num" inputMode="numeric" value={d.verifyByDay ?? ""} onChange={(e) => set("verifyByDay", Number(e.target.value) || e.target.value)} /></Field>
        <Field label="Виплата до, число"><input className="zp-input zp-input--num" inputMode="numeric" value={d.payByDay ?? ""} onChange={(e) => set("payByDay", Number(e.target.value) || e.target.value)} /></Field>
      </div>
    </SaveVersionModal>
  );
}
