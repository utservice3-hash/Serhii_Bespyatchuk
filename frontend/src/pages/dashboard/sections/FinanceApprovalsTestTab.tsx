import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { fetchFinApprovalsTest, syncFinApprovals, type FinApprCompare, type FinApprItem, type FinApprLine, type FinApprPot, type FinApprSection, type FinApprOutside } from "../../../api";
import { getAuthPayload } from "../../../auth";

/**
 * 🧪 «План/факт · авто (тест)» (Роман 20.10.2026: «паралельна таблиця план-факту… має бути повністю готовий до
 * приймання екран, щоб коли треба — швидко замінили»). Вигляд — той самий, що «План/факт витрат» (картка, плитки,
 * відповідальний → група → стаття, `fin-table`), але ФАКТ — із таблиці «UTS Утверждение оплат» (за датою оплати), а
 * ручний факт стоїть поруч колонкою «Вручну» з різницею: таблиця − вручну. Нічого не змінює ні в «План/факт», ні в
 * «Тиждень і місяць». Усе, що правило не віднесло до статті, — окремими блоками з сумою, щоб гроші не зникали мовчки.
 * Лише `view_private_finance`: у рядках ЗП — прізвища.
 */
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const monthShort = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1].slice(0, 3).toLowerCase()}.`;
const shift = (m: string, d: number) => { const x = new Date(`${m}-15T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + d); return x.toISOString().slice(0, 7); };
const kyivMonth = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
const money = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("uk-UA", { maximumFractionDigits: 2 }));
const signed = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const same = (v: number) => Math.abs(v) < 0.005;
const SEC: Record<FinApprSection, string> = { commercial: "Комерційні", admin: "Адміністративні", general: "Загальні" };
const dm = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");
const hhmm = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Виконання плану — як у «План/факт витрат»: смуга й відсоток, понад план — червоним. */
function Execution({ plan, fact }: { plan: number | null; fact: number }) {
  if (plan == null || plan === 0) return fact ? <span className="hr-pill wn">без плану</span> : <span className="hr-muted">—</span>;
  if (!fact) return <span className="hr-muted">факту ще немає</span>;
  const pct = Math.round((fact / plan) * 100);
  return pct > 100
    ? <><span className="fin-bar x"><i style={{ width: "100%" }} /></span><span className="fin-bad">{pct}%</span></>
    : <><span className="fin-bar"><i style={{ width: `${pct}%` }} /></span>{pct}%</>;
}

/** Рядки таблиці оплат під статтею чи кошиком — без реквізитів і отримувача. */
export function Lines({ lines }: { lines: FinApprLine[] }) {
  return (
    <table className="hr-table" style={{ fontSize: 12.5, margin: "2px 0 6px" }}>
      <thead><tr><th>Дата оплати</th><th>Що купили</th><th className="num">Сума</th><th>Напрямок</th><th>Оплачено</th></tr></thead>
      <tbody>{lines.map((l, i) => (
        <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{dm(l.payDate)}</td><td>{l.what || <span className="hr-muted">—</span>}</td><td className="num">{money(l.amount)}</td>
          <td>{l.direction || <span className="hr-muted">не вказано</span>}</td><td>{l.paid ? "так" : <span className="hr-pill wn">ні</span>}</td></tr>
      ))}</tbody>
    </table>
  );
}

/** Один кошик «не потрапило у статті» — рядки в спільній таблиці (`Outside`), щоб числа стояли в одній колонці. */
interface Bucket { title: string; hint: string; pots: FinApprPot[] }
/** «Не потрапило у статті»: усі кошики однією таблицею — назва кошика й пояснення, далі категорії; клік — рядки таблиці. */
export function Outside({ buckets }: { buckets: Bucket[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const live = buckets.filter((b) => b.pots.length);
  if (!live.length) return <div className="hr-sect hr-muted" style={{ fontSize: 12.5 }}>Усе з таблиці оплат за цей місяць потрапило у статті.</div>;
  return (
    <div className="hr-sect">
      <h4>Не потрапило у статті</h4>
      <div className="hr-tw">
        <table className="hr-table fin-table">
          <thead><tr><th>Категорія з таблиці оплат</th><th className="num">Сума</th><th className="num">Рядків</th><th /></tr></thead>
          <tbody>{live.map((b) => (
            <Fragment key={b.title}>
              <tr className="grp"><td colSpan={4} className="ind1">{b.title} · {money(r2(b.pots.reduce((s, p) => s + p.sum, 0)))} ₴
                <div style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, fontSize: 12 }}>{b.hint}</div></td></tr>
              {b.pots.map((p) => {
                const k = `${b.title}:${p.key}`;
                return (
                  <Fragment key={k}>
                    <tr className={`it ${open === k ? "sel" : ""}`} onClick={() => setOpen(open === k ? null : k)}>
                      <td className="ind2"><span style={{ display: "inline-block", width: 16 }}>{open === k ? "▾" : "▸"}</span>{p.label}</td>
                      <td className="num">{money(p.sum)}</td><td className="num">{p.rows}</td>
                      <td>{p.unpaid ? <span className="hr-pill wn">не оплачено: {p.unpaid}</span> : null}</td>
                    </tr>
                    {open === k && <tr><td colSpan={4} className="ind2"><Lines lines={p.lines} /></td></tr>}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/** Кошики «Не потрапило у статті» — один перелік для тестової вкладки й «План/факт витрат». */
export const outsideBuckets = (o: FinApprOutside): Bucket[] => [
  { title: "ЗП за назвою", hint: "Статей для ЗП немає — розділ береться з назви категорії. В операційні йдуть, у «План/факт» — ні.", pots: o.payroll },
  { title: "Лише для статистики", hint: "Категорія йде в операційні у свій розділ (Консалтинг СЕО → Комерційні), у «План/факт» — ні (Тетяна 21.10).", pots: o.statsOnly },
  { title: "Не розпізнано", hint: "Категорії немає серед статей — ні в «План/факт», ні в операційні не йде (Дивіденди — так і задумано, для інформації).", pots: o.unrecognized },
  { title: "Кілька статей з однією назвою", hint: "Категорія збігається з двома статтями — не вгадуємо, куди. Перейменуйте одну зі статей.", pots: o.ambiguous },
  { title: "Не UA", hint: "Напрямок не UA — у факт не йде (Тетяна 13.10: «беремо лише UA»).", pots: o.notUa },
  { title: "Сума не число", hint: "Сума в таблиці не читається як число — у факт не йде.", pots: o.badSum },
  { title: "Дата оплати не дата", hint: "У «Даті оплати» не дата (показано в місяці внесення) — у факт не йде.", pots: o.badPayDate },
  { title: "Ще без дати оплати", hint: "Внесено цього місяця, дати оплати ще немає — у факт піде, щойно її поставлять.", pots: o.noPayDate },
];

type Resp = { id: number; name: string; groups: { id: number; name: string; items: FinApprItem[] }[] };
const treeOf = (items: FinApprItem[]): Resp[] => {
  const out: Resp[] = [];
  for (const it of items) {
    let r = out.find((x) => x.id === it.respId);
    if (!r) out.push(r = { id: it.respId, name: it.resp, groups: [] });
    let g = r.groups.find((x) => x.id === it.groupId);
    if (!g) r.groups.push(g = { id: it.groupId, name: it.group, items: [] });
    g.items.push(it);
  }
  return out;
};

export function FinanceApprovalsTestTab() {
  const canView = (getAuthPayload()?.perms ?? []).includes("view_private_finance");
  const [month, setMonth] = useState(kyivMonth);
  const [data, setData] = useState<FinApprCompare | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<number | "all">("all");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [onlyOver, setOnlyOver] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback((refresh = false) => {
    if (!canView) return;
    setBusy(true);
    (refresh ? syncFinApprovals().then(() => fetchFinApprovalsTest(month)) : fetchFinApprovalsTest(month)).then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося прочитати таблицю «Утверждение оплат»"))
      .finally(() => setBusy(false));
  }, [canView, month]);
  useEffect(() => { load(); }, [load]);
  const tree = useMemo(() => treeOf(data?.month.slice(0, 7) === month ? data.items : []), [data, month]);

  if (!canView) return <div className="chart-card"><b>План/факт · авто (тест)</b> <span className="hr-muted">Бачать лише Адмін і фінансист: у рядках ЗП — прізвища.</span></div>;

  const current = month === kyivMonth(), future = month > kyivMonth();
  const shown = data?.month.slice(0, 7) === month ? data : null;
  /** «Понад план» — як у «План/факт витрат»: факт із таблиці більший за план, або факт є, а плану немає. */
  const overPlan = (x: FinApprItem) => (x.plan != null && x.plan !== 0 ? x.auto > x.plan : x.auto > 0);
  const visible = (x: FinApprItem) => (!onlyDiff || !same(x.diff)) && (!onlyOver || overPlan(x))
    && (showEmpty || onlyDiff || onlyOver || x.plan != null || x.manual != null || x.rows > 0);
  const t = shown?.totals;
  const left = t ? r2(t.plan - t.autoArticles) : 0;
  let rowsShown = 0;
  return (
    <div className="hr-card">
      <div className="hd">
        <div className="hr-daynav" style={{ marginBottom: 0 }}>
          <button className="hr-btn xs" onClick={() => setMonth(shift(month, -1))} aria-label="Попередній місяць">‹</button>
          <b style={{ minWidth: 130, textAlign: "center" }}>{monthLabel(month)}</b>
          <button className="hr-btn xs" onClick={() => setMonth(shift(month, 1))} aria-label="Наступний місяць">›</button>
          {!current && <button className="hr-btn xs" onClick={() => setMonth(kyivMonth())}>поточний</button>}
          <select className="hr-inp" value={String(resp)} onChange={(e) => setResp(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Відповідальний">
            <option value="all">Усі відповідальні</option>
            {tree.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label className="hr-muted" style={{ fontSize: 13 }}><input type="checkbox" checked={onlyOver} onChange={(e) => setOnlyOver(e.target.checked)} /> лише понад план</label>
          <label className="hr-muted" style={{ fontSize: 13 }}><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> лише розбіжності з ручним</label>
          <label className="hr-muted" style={{ fontSize: 13 }}><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> показати порожні</label>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="hr-pill pl" title="Нічого не змінює ні в «План/факт», ні в «Тиждень і місяць»">🧪 тест · лише читання</span>
          {shown && <span className="hr-muted" style={{ fontSize: 12.5 }}>{shown.syncedAt ? `таблицю прочитано ${hhmm(shown.syncedAt)}` : "таблицю ще не синхронізовано"}</span>}
          <button className="hr-btn xs" disabled={busy} onClick={() => load(true)}>{busy ? "Читаю…" : "↻ Оновити з таблиці"}</button>
        </div>
      </div>

      {err && <div className="hr-sect"><div className="hr-note" style={{ marginTop: 0, background: "var(--danger-bg)", color: "var(--danger)" }}>{err}</div></div>}
      {!shown ? (!err && <p className="loading-text" style={{ padding: 16 }}>Читаю таблицю «Утверждение оплат»…</p>) : (<>
        <div className="hr-tiles">
          <div className="hr-tile"><div className="lb">План · {monthShort(month)}</div><div className="vl">{money(t!.plan)} ₴</div><div className="sb">статей: {shown.items.filter((x) => x.plan != null).length}</div></div>
          <div className="hr-tile"><div className="lb">Факт з таблиці</div><div className="vl">{future ? "—" : `${money(t!.autoArticles)} ₴`}</div>
            <div className="sb">{future ? "місяць не почався" : current ? "місяць триває" : "місяць закрито"}{t!.plan && !future ? ` · ${Math.round((t!.autoArticles / t!.plan) * 100)}% плану` : ""}</div></div>
          <div className="hr-tile"><div className="lb">{left >= 0 ? "Лишилось" : "Понад план"}</div>
            <div className="vl" style={{ color: left < 0 ? "var(--danger)" : undefined }}>{future ? "—" : `${money(Math.abs(left))} ₴`}</div><div className="sb">план − факт з таблиці</div></div>
          <div className="hr-tile"><div className="lb">Розбіжність з ручним</div>
            <div className="vl" style={{ color: same(t!.autoArticles - t!.manual) ? "var(--ok)" : "var(--warn)" }}>{signed(r2(t!.autoArticles - t!.manual))} ₴</div>
            <div className="sb">вручну {money(t!.manual)} ₴ · статей з різницею: {t!.diffItems}</div></div>
        </div>

        <div className="hr-sect hr-muted" style={{ fontSize: 12.5, paddingTop: 10, paddingBottom: 10 }}>
          Факт — з таблиці «UTS Утверждение оплат» (вкладка «На оплату»): категорія = назва статті, місяць — за <b>датою оплати</b>, лише напрямок UA
          («Украина» до жовтня — теж UA). Колонка «Вручну» — те, що внесено у «План/факт витрат»; різниця = таблиця − вручну.
        </div>

        <div className="hr-tw">
          <table className="hr-table fin-table">
            <thead><tr><th>Стаття</th><th className="num">План</th><th className="num">Факт з таблиці</th><th className="num">Різниця</th><th>Виконання</th>
              <th className="num">Вручну</th><th className="num">Таблиця − вручну</th></tr></thead>
            <tbody>
              {tree.filter((r) => resp === "all" || r.id === resp).map((r) => {
                const groups = r.groups.map((g) => ({ g, items: g.items.filter(visible) })).filter((x) => x.items.length);
                if (!groups.length) return null;
                return (
                  <Fragment key={r.id}>
                    <tr className="resp" onClick={() => setClosed((c) => ({ ...c, [r.id]: !c[r.id] }))}>
                      <td colSpan={7}><span style={{ display: "inline-block", width: 16 }}>{closed[r.id] ? "▸" : "▾"}</span>{r.name}</td>
                    </tr>
                    {!closed[r.id] && groups.map(({ g, items }) => (
                      <Fragment key={g.id}>
                        <tr className="grp"><td colSpan={7} className="ind1">{g.name}</td></tr>
                        {items.map((x) => {
                          rowsShown++;
                          const d = x.plan == null ? null : r2(x.plan - x.auto);
                          const over = overPlan(x);
                          return (
                            <Fragment key={x.id}>
                              <tr className={`it ${over ? "over" : ""} ${open === x.id ? "sel" : ""} ${x.off ? "off" : ""}`} tabIndex={0}
                                onClick={() => setOpen(open === x.id ? null : x.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(open === x.id ? null : x.id); }}>
                                <td className="ind2">{x.name}{x.off && <span className="hr-muted"> · вимкнена</span>}{!x.section && <span className="hr-pill wn" style={{ marginLeft: 6 }}>без розділу</span>}</td>
                                <td className="num">{x.plan == null ? <span className="hr-muted">не задано</span> : money(x.plan)}</td>
                                <td className="num">{x.rows ? money(x.auto) : <span className="hr-muted">—</span>}</td>
                                <td className="num">{d == null || !x.rows ? "—" : <span className={d < 0 ? "fin-bad" : "fin-good"}>{signed(d)}</span>}</td>
                                <td style={{ whiteSpace: "nowrap" }}>{future ? <span className="hr-muted">—</span> : <Execution plan={x.plan} fact={x.auto} />}</td>
                                <td className="num">{x.manual == null ? <span className="hr-muted">не внесено</span> : money(x.manual)}</td>
                                <td className="num">{same(x.diff) ? <span className="fin-good">✓ збігається</span> : <span className="fin-bad">{signed(x.diff)}</span>}</td>
                              </tr>
                              {open === x.id && (
                                <tr><td colSpan={7} className="ind2">
                                  {x.rows ? <Lines lines={x.lines} /> : <span className="hr-muted">У таблиці оплат за {monthLabel(month).toLowerCase()} рядків із категорією «{x.name}» немає.</span>}
                                </td></tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    ))}
                  </Fragment>
                );
              })}
              {!rowsShown && <tr><td colSpan={7} className="hr-muted" style={{ padding: 16 }}>{onlyOver ? "Статей понад план немає." : onlyDiff ? "Розбіжностей немає — кожна стаття збігається з таблицею." : "Статей із планом чи фактом за цей місяць немає."}</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="hr-sect">
          <h4>Операційні витрати за розділами</h4>
          <div className="hr-tw">
            <table className="hr-table">
              <thead><tr><th>Розділ</th><th className="num">Статті з таблиці</th><th className="num">+ ЗП і поза статтями</th><th className="num">Разом з таблиці</th>
                <th className="num">Внесено в «Тиждень і місяць»</th><th className="num">Різниця</th></tr></thead>
              <tbody>{shown.sections.map((s) => (
                <tr key={s.section}>
                  <td>{SEC[s.section]}{same(s.autoArticles - s.manualArticles) ? null
                    : <div className="hr-muted" style={{ fontSize: 11.5 }}>статті вручну {money(s.manualArticles)} · різниця <span className="fin-bad">{signed(Math.round((s.autoArticles - s.manualArticles) * 100) / 100)}</span></div>}</td>
                  <td className="num">{money(s.autoArticles)}</td><td className="num">{money(s.autoPayroll)}</td><td className="num"><b>{money(s.autoTotal)}</b></td>
                  <td className="num">{s.manualOpex == null ? <span className="hr-muted">не внесено</span> : money(s.manualOpex)}</td>
                  <td className="num">{s.manualOpex == null ? "—" : same(s.autoTotal - s.manualOpex) ? <span className="fin-good">✓</span> : <span className="fin-bad">{signed(Math.round((s.autoTotal - s.manualOpex) * 100) / 100)}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>

        <Outside buckets={outsideBuckets(shown)} />
        <div className="hr-sect hr-muted" style={{ fontSize: 12.5 }}>
          Клік по статті показує рядки таблиці оплат, з яких складено факт. Реквізити й отримувачі сюди не потрапляють.
        </div>
      </>)}
    </div>
  );
}
