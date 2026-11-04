/**
 * 💰 «Відомість» (ТЗ §5.3, §7.1; макет v6 `statement`). Хто подав форму на виплату: рядок на людину з картами всередині
 * (в Excel — рядок на кожну карту), вибір колонок, Excel із повними номерами карт (право `payroll_export_cards`;
 * кожне вивантаження — в історії змін), «Позначити виплаченим» для вибраних. Кого сервер не виплатить — показуємо причину.
 * На екрані номер карти — лише останні 4 цифри: повний номер іде тільки в Excel.
 */
import { useMemo, useState } from "react";
import { payrollApi, errText, type Obj } from "../api";
import type { PayrollCtx } from "../PayrollSection";
import { Card, Empty, Loading, Pill, money, monthTitle, useLoad, saveBlob } from "../ui";
import { useToast } from "../../components/Toasts";
import "./finance.css";
import { dt, dayGen, monthLow } from "./fmt";

/** Колонки — ті самі ключі, що `COLS` у `service.ts` (Excel рахує сервер). */
const COLS: Array<[string, string]> = [["n", "№"], ["name", "ПІБ"], ["title", "Посада"], ["team", "Команда"], ["acc", "Нараховано"], ["adv", "Аванс"], ["off", "Офіційна ЗП"],
  ["ttn", "ТТН"], ["pay", "До виплати"], ["cash", "Готівка"], ["card", "На карти"], ["cardNo", "Карти"], ["who", "Отримувач"], ["st", "Стан"], ["sign", "Підпис"]];
const DEFAULT_COLS = COLS.map(([k]) => k).filter((k) => k !== "team" && k !== "sign");
const LS_KEY = "zp.statement.cols";
const loadCols = (): string[] => {
  try { const x = JSON.parse(localStorage.getItem(LS_KEY) ?? "null"); if (Array.isArray(x) && x.every((k) => typeof k === "string")) return x; } catch { /* приватне вікно */ }
  return DEFAULT_COLS;
};

interface Person { userId: string; n: number; name: string; title: string; team: string | null; accrued: number; advance: number; official: number; ttn: number; pay: number;
  status: string; blocked: boolean; needsOd: boolean; paidAt: string | null; cash: number; cards: Array<{ last4: string | null; holder: string | null; amount: number }> }

export default function StatementTab({ ctx }: { ctx: PayrollCtx }) {
  const toast = useToast();
  const mk = ctx.closedMonth;
  const { data, err, reload } = useLoad<Obj[] | null>(() => (mk ? payrollApi.statement(mk) : Promise.resolve(null)), [mk]);
  const { data: q, reload: reloadQ } = useLoad<Obj | null>(() => (mk ? payrollApi.queue(mk).catch(() => null) : Promise.resolve(null)), [mk]);
  const [cols, setCols] = useState<string[]>(loadCols);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<Array<{ userId: string; reason: string }>>([]);
  const canEdit = ctx.perms.has("payroll_edit"), canXlsx = ctx.perms.has("payroll_export_cards");

  const people = useMemo(() => {
    const m = new Map<string, Person>();
    for (const r of (data ?? []) as Obj[]) {
      let p = m.get(r.userId);
      if (!p) {
        p = { userId: r.userId, n: r.n, name: r.name, title: r.title, team: r.team, accrued: r.accrued, advance: r.advance, official: r.official, ttn: r.ttn, pay: r.pay,
          status: r.status, blocked: !!r.blocked, needsOd: !!r.needsOd, paidAt: r.paidAt, cash: 0, cards: [] };
        m.set(r.userId, p);
      }
      p.cash += Number(r.cash ?? 0);
      if (r.cardLast4 || Number(r.card)) p.cards.push({ last4: r.cardLast4, holder: r.holder, amount: Number(r.card ?? 0) });
    }
    return [...m.values()].sort((a, b) => a.n - b.n);
  }, [data]);

  if (!mk) {
    return <Card title="Відомість"><div className="zp-note">Відомість зʼявляється після закриття місяця (1-го о 04:45) і першої поданої форми на виплату. Зараз іде {monthLow(ctx.liveMonth)}.</div></Card>;
  }
  if (!data) return <Loading err={err} onRetry={reload} />;

  const on = (k: string) => cols.includes(k);
  const toggleCol = (k: string) => {
    const nx = on(k) ? cols.filter((x) => x !== k) : COLS.map(([x]) => x).filter((x) => x === k || cols.includes(x));
    setCols(nx);
    try { localStorage.setItem(LS_KEY, JSON.stringify(nx)); } catch { /* приватне вікно */ }
  };
  const payable = (p: Person) => p.status === "submitted" && !p.blocked && !p.needsOd;
  const why = (p: Person) => (p.status === "paid" ? `виплачено ${dt(p.paidAt)}` : p.blocked ? "обхідний лист не підписано всіма" : p.needsOd ? "ОД ще не погодив розрахунок (п. 9 обхідного листа)" : "");
  const waiting = ((q?.rows ?? []) as Obj[]).filter((x) => !["submitted", "paid"].includes(x.status));
  const nCards = people.reduce((s, p) => s + p.cards.length, 0);
  const T = (k: keyof Person) => people.reduce((s, p) => s + Number(p[k] ?? 0), 0);
  const totalCard = people.reduce((s, p) => s + p.cards.reduce((a, c) => a + c.amount, 0), 0);
  const selPay = people.filter((p) => sel.has(p.userId)).reduce((s, p) => s + p.pay, 0);
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.name ?? `#${id}`;
  const allPayable = people.filter(payable);

  async function xlsx() {
    try { saveBlob(await payrollApi.statementXlsx(mk!, cols), `Vidomist_ZP_${mk}.xlsx`); toast("Excel завантажено — вивантаження записано в історію змін."); }
    catch (e) { toast(errText(e), { error: true }); }
  }
  async function markPaid() {
    setBusy(true);
    try {
      const r = await payrollApi.markPaid(mk!, [...sel]);
      setSkipped(r.skipped ?? []); setSel(new Set()); setAsk(false);
      toast(r.paid?.length ? `Позначено виплаченим: ${r.paid.length}. Працівники отримають сповіщення.` : "Нікого не позначено — дивіться причини нижче.", { error: !r.paid?.length });
      await reload(); await reloadQ();
    } catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); }
  }

  return (
    <Card title={`Відомість · ${monthTitle(mk)}`}>
      <div className="zp-hint" style={{ marginBottom: 12 }}>
        {people.length} з {people.length + waiting.length} подали форму · переказів на карти: {nCards}
        {waiting.length ? ` · чекаємо: ${waiting.map((x) => x.name).join(", ")}` : ""}
        {q?.payBy ? ` · виплата до ${dayGen(q.payBy)}` : ""}
      </div>

      <div className="zp-k" style={{ marginBottom: 6 }}>Колонки у відомості й Excel</div>
      <div className="zf-cols" style={{ marginBottom: 14 }}>
        {COLS.map(([k, l]) => <label key={k}><input type="checkbox" checked={on(k)} onChange={() => toggleCol(k)} />{l}</label>)}
      </div>

      {!people.length ? <Empty>Ще ніхто не подав форму на виплату. Форма зʼявляється після згоди працівника з розрахунковим листом.</Empty> : (
        <div className="zp-table-wrap">
          <table className="zp-table zf-table">
            <thead>
              <tr>
                {canEdit && <th><input type="checkbox" aria-label="Вибрати всіх, кого можна виплатити" checked={!!allPayable.length && allPayable.every((p) => sel.has(p.userId))}
                  onChange={(e) => setSel(e.target.checked ? new Set(allPayable.map((p) => p.userId)) : new Set())} disabled={!allPayable.length} /></th>}
                {on("n") && <th>№</th>}{on("name") && <th>ПІБ</th>}{on("title") && <th>Посада</th>}{on("team") && <th>Команда</th>}
                {on("acc") && <th className="r">Нараховано</th>}{on("adv") && <th className="r">Аванс</th>}{on("off") && <th className="r">Офіційна ЗП</th>}
                {on("ttn") && <th className="r">ТТН</th>}{on("pay") && <th className="r">До виплати</th>}{on("cash") && <th className="r">Готівка</th>}
                {on("card") && <th className="r">На карти</th>}{on("cardNo") && <th>Карти</th>}{on("who") && <th>Отримувач</th>}{on("st") && <th>Стан</th>}{on("sign") && <th>Підпис</th>}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className={sel.has(p.userId) ? "is-sel" : ""}>
                  {canEdit && <td><input type="checkbox" checked={sel.has(p.userId)} disabled={!payable(p)} title={why(p) || undefined} aria-label={`Вибрати ${p.name}`}
                    onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(p.userId); else n.delete(p.userId); return n; })} /></td>}
                  {on("n") && <td>{p.n}</td>}
                  {on("name") && <td><b>{p.name}</b></td>}
                  {on("title") && <td>{p.title || "—"}</td>}
                  {on("team") && <td>{p.team || "—"}</td>}
                  {on("acc") && <td className="r">{money(p.accrued)}</td>}
                  {on("adv") && <td className="r">{p.advance ? money(-p.advance) : "—"}</td>}
                  {on("off") && <td className="r">{p.official ? money(-p.official) : "—"}</td>}
                  {on("ttn") && <td className="r">{p.ttn ? money(p.ttn, { sign: true }) : "—"}</td>}
                  {on("pay") && <td className="r"><b>{money(p.pay)}</b></td>}
                  {on("cash") && <td className="r">{p.cash ? money(p.cash) : "—"}</td>}
                  {on("card") && <td className="r">{p.cards.length ? money(p.cards.reduce((s, c) => s + c.amount, 0)) : "—"}</td>}
                  {on("cardNo") && <td className="zf-cards">{p.cards.length ? p.cards.map((c, i) => <div key={i}>•••• {c.last4 ?? "????"} — {money(c.amount)}</div>) : "—"}</td>}
                  {on("who") && <td>{[...new Set(p.cards.map((c) => c.holder).filter(Boolean))].join(", ") || (p.cash ? "готівкою" : "—")}</td>}
                  {on("st") && <td>{p.status === "paid" ? <Pill tone="ok">Виплачено</Pill> : p.blocked || p.needsOd ? <Pill tone="warn">Чекає обхідного</Pill> : <Pill tone="ok">Форму подано</Pill>}
                    {why(p) && p.status !== "paid" && <div className="zp-hint">{why(p)}</div>}</td>}
                  {on("sign") && <td style={{ minWidth: 90 }} />}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {canEdit && <td />}{on("n") && <td />}{on("name") && <td>Разом</td>}{on("title") && <td />}{on("team") && <td />}
                {on("acc") && <td className="r">{money(T("accrued"))}</td>}{on("adv") && <td className="r">{money(-T("advance"))}</td>}{on("off") && <td className="r">{money(-T("official"))}</td>}
                {on("ttn") && <td className="r">{money(T("ttn"))}</td>}{on("pay") && <td className="r">{money(T("pay"))}</td>}{on("cash") && <td className="r">{money(T("cash"))}</td>}
                {on("card") && <td className="r">{money(totalCard)}</td>}{on("cardNo") && <td />}{on("who") && <td />}{on("st") && <td />}{on("sign") && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="zf-actions" style={{ marginTop: 14 }}>
        {canXlsx && <button type="button" className="zp-btn" disabled={!people.length} onClick={() => void xlsx()}>Завантажити Excel</button>}
        {canEdit && (ask
          ? <span className="zf-confirm">Позначити виплаченим {sel.size} ({money(selPay)})? Працівники отримають сповіщення.
              <button type="button" className="zp-btn zp-btn--sm zp-btn--primary" disabled={busy} onClick={() => void markPaid()}>{busy ? "Зберігаємо…" : "Так, виплачено"}</button>
              <button type="button" className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setAsk(false)}>Ні</button></span>
          : <button type="button" className="zp-btn zp-btn--primary" disabled={!sel.size} onClick={() => setAsk(true)}>Позначити виплаченим ({sel.size})</button>)}
      </div>
      {!!skipped.length && (
        <div className="zp-note zp-note--warn" style={{ marginTop: 10 }}>
          Не позначено: {skipped.map((s) => `${nameOf(s.userId)} — ${s.reason}`).join("; ")}.
        </div>
      )}
      <div className="zp-hint" style={{ marginTop: 10 }}>
        До виплати = нараховано − аванс − офіційна ЗП (якщо вираховується) ± ТТН. В Excel — рядок на кожну карту.
        Номер карти повністю — лише в Excel{canXlsx ? "" : " (право «Excel з повними номерами карт»)"}; кожне вивантаження — в історії змін.
      </div>
    </Card>
  );
}
