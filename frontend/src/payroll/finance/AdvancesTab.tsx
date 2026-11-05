/**
 * 💰 «Аванси» (ТЗ §4.13, §7.1; макет v6 `advPage`). Заявки поточного місяця: виплатити / відхилити (з причиною — працівник
 * її побачить); «ще не подали» з лімітами на сьогодні; Excel з повними номерами карт — лише з правом `payroll_export_cards`.
 * Виплачений аванс вираховується автоматично при закритті місяця (у вікні перевірки).
 */
import { useState } from "react";
import { payrollApi, errText, type Obj } from "../api";
import type { PayrollCtx } from "../PayrollSection";
import { Card, Empty, Loading, Pill, Stat, money, useLoad, saveBlob } from "../ui";
import { useToast } from "../../components/Toasts";
import { MonthSwitch } from "./common";
import { ADV_STATUS, dt, monthGen } from "./fmt";

export default function AdvancesTab({ ctx }: { ctx: PayrollCtx }) {
  const toast = useToast();
  const months = [ctx.closedMonth, ctx.liveMonth].filter(Boolean) as string[];
  const [mk, setMk] = useState(ctx.liveMonth);
  const { data, err, reload } = useLoad<Obj>(() => payrollApi.advances(mk), [mk]);
  const [busy, setBusy] = useState<number | null>(null);
  const [rej, setRej] = useState<{ id: number; reason: string } | null>(null);
  const [payAsk, setPayAsk] = useState<number | null>(null);
  const canEdit = ctx.perms.has("payroll_edit"), canXlsx = ctx.perms.has("payroll_export_cards");

  if (!data) return <Loading err={err} onRetry={reload} />;
  const reqs = (data.requests ?? []) as Obj[], notYet = (data.notYet ?? []) as Obj[];
  const waiting = reqs.filter((r) => r.status === "requested"), paid = reqs.filter((r) => r.status === "paid");
  const sum = (xs: Obj[], k = "amount") => xs.reduce((s, x) => s + Number(x[k] ?? 0), 0);

  async function pay(id: number) {
    setBusy(id);
    try { await payrollApi.payAdvance(id); setPayAsk(null); toast("Аванс позначено виплаченим — працівник отримає сповіщення."); await reload(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(null); }
  }
  async function reject() {
    if (!rej) return;
    if (rej.reason.trim().length < 3) { toast("Напишіть причину — працівник її побачить.", { error: true }); return; }
    setBusy(rej.id);
    try { await payrollApi.rejectAdvance(rej.id, rej.reason.trim()); setRej(null); toast("Заявку відхилено — працівник побачить причину й зможе подати нову."); await reload(); }
    catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(null); }
  }
  async function xlsx() {
    try { saveBlob(await payrollApi.advancesXlsx(mk), `Avans_${mk}.xlsx`); toast("Excel завантажено — вивантаження записано в історію змін."); }
    catch (e) { toast(errText(e), { error: true }); }
  }
  const how = (r: Obj) => [Number(r.cash) ? `готівка ${money(r.cash)}` : "", ...((r.lines ?? []) as Obj[]).map((l) => `•••• ${l.last4} — ${money(l.amount)}`)].filter(Boolean).join(" · ") || "—";

  return (
    <>
      <div className="zf-toolbar">
        <MonthSwitch months={months} value={mk} onChange={setMk} live={ctx.liveMonth} />
        <span className="zp-grow" />
        {mk === ctx.liveMonth && (data.open
          ? <Pill tone="ok">заявки відкрито з {data.fromDay}-го</Pill>
          : <Pill tone="warn">заявки — з {data.fromDay} {monthGen(mk)}</Pill>)}
      </div>

      <div className="zp-grid zp-grid--stats">
        <Stat label="Чекають виплати" value={money(sum(waiting))} sub={`${waiting.length} заявок`} tone={waiting.length ? "warn" : undefined} />
        <Stat label="Виплачено" value={money(sum(paid))} sub={`${paid.length} заявок`} />
        {mk === ctx.liveMonth && <Stat label="Ще можуть взяти" value={money(sum(notYet, "limit"))} sub={`${notYet.length} людей · ліміти на сьогодні`} />}
      </div>

      <Card title={`Заявки · ${monthGen(mk)}`} aside={canXlsx ? <button type="button" className="zp-btn zp-btn--sm" onClick={() => void xlsx()} disabled={!reqs.length}>Завантажити Excel</button> : undefined}>
        {!reqs.length ? <Empty>Заявок немає.{mk === ctx.liveMonth && !data.open ? ` Працівники подають їх у кабінеті з ${data.fromDay}-го числа.` : ""}</Empty> : (
          <div className="zp-table-wrap">
            <table className="zp-table zf-table">
              <thead><tr><th>Працівник</th><th className="r">Сума</th><th>Куди</th><th className="r">Ліміт на день заявки</th><th>Подано</th><th>Стан</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {reqs.map((r) => {
                  const [label, tone] = ADV_STATUS[r.status] ?? [r.status, "muted" as const];
                  return (
                    <tr key={r.id}>
                      <td className="zf-who"><b>{r.name || "—"}</b></td>
                      <td className="r"><b>{money(r.amount)}</b></td>
                      <td className="zf-cards">{how(r)}</td>
                      <td className="r zp-muted">{money(r.limit)}</td>
                      <td>{dt(r.requestedAt)}</td>
                      <td><Pill tone={tone}>{label}</Pill>
                        {r.status === "paid" && r.paidAt && <div className="zp-hint">{dt(r.paidAt)}</div>}
                        {r.status === "rejected" && <div className="zp-hint">{r.reason}</div>}</td>
                      {canEdit && (
                        <td style={{ minWidth: 220 }}>
                          {r.status === "requested" && rej?.id !== r.id && (
                            payAsk === r.id
                              ? <span className="zf-confirm">Виплачено {money(r.amount)}?<button type="button" className="zp-btn zp-btn--sm zp-btn--primary" disabled={busy === r.id} onClick={() => void pay(r.id)}>Так</button><button type="button" className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setPayAsk(null)}>Ні</button></span>
                              : <div className="zp-row">
                                  <button type="button" className="zp-btn zp-btn--sm zp-btn--primary" disabled={busy === r.id} onClick={() => setPayAsk(r.id)}>Виплатити</button>
                                  <button type="button" className="zp-btn zp-btn--sm zp-btn--danger" disabled={busy === r.id} onClick={() => setRej({ id: r.id, reason: "" })}>Відхилити</button>
                                </div>
                          )}
                          {rej?.id === r.id && (
                            <div className="zf-reject">
                              <input className="zp-input" autoFocus placeholder="Причина — працівник її побачить" value={rej?.reason ?? ""} onChange={(e) => setRej({ id: r.id, reason: e.target.value })} />
                              <button type="button" className="zp-btn zp-btn--sm zp-btn--danger" disabled={busy === r.id} onClick={() => void reject()}>Відхилити</button>
                              <button type="button" className="zp-btn zp-btn--sm zp-btn--ghost" onClick={() => setRej(null)}>Скасувати</button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="zp-hint" style={{ marginTop: 10 }}>
          Номер карти повністю — у Excel для виплати{canXlsx ? "" : " (право «Excel з повними номерами карт» — у фінансиста й ОД)"}. При закритті місяця виплачений аванс автоматично вираховується у вікні перевірки.
        </div>
      </Card>

      {mk === ctx.liveMonth && (
        <Card title="Ще не подали" aside="ліміти на сьогодні">
          {!notYet.length ? <Empty>Заявки подали всі, хто працює цього місяця.</Empty> : (
            <div className="zp-table-wrap">
              <table className="zp-table zf-table">
                <thead><tr><th>Працівник</th><th>Посада</th><th className="r">Можна взяти на сьогодні</th></tr></thead>
                <tbody>
                  {notYet.slice().sort((a, b) => Number(b.limit) - Number(a.limit)).map((x) => (
                    <tr key={x.userId}><td><b>{x.name}</b></td><td className="zp-muted">{x.title || "—"}</td><td className="r">{Number(x.limit) > 0 ? money(x.limit) : <span className="zp-muted">0 ₴ — ще нічого не нараховано</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
