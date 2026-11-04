/**
 * 💰 «Задачі» рекрутера (ТЗ §7.1, макет p08b-tasks.js): «Перепідписати офер» — створюються автоматично, коли змінюється рівень
 * менеджера (рішення керівництва або вибір «Профі» самим менеджером). Закриває HR (`payroll_offer_tasks`) або ОД.
 * Строк — до 5-го числа місяця, з якого діє новий офер (так його ставить сервер).
 */
import { useState } from "react";
import type { PayrollCtx } from "../PayrollSection";
import { errText, payrollApi, type Obj } from "../api";
import { Card, Empty, Loading, Pill, useLoad } from "../ui";
import { useToast } from "../../components/Toasts";
import { ddy, dt, kyivToday } from "./common";

export default function OfferTasksTab({ ctx }: { ctx: PayrollCtx }) {
  void ctx;
  const toast = useToast();
  const { data, err, reload } = useLoad(() => payrollApi.offerTasks(), []);
  const [busy, setBusy] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  if (!data) return <Loading err={err} onRetry={reload} />;
  const ts = [...(data as Obj[])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const open = ts.filter((t) => !t.signedAt), done = ts.filter((t) => t.signedAt);
  const today = kyivToday();

  async function close(id: number) {
    setBusy(id);
    try { await payrollApi.offerTaskDone(id); toast("Офер позначено підписаним — працівник отримав сповіщення."); setConfirm(null); await reload(); }
    catch (e) { toast(errText(e), { error: true }); } finally { setBusy(null); }
  }

  return (
    <div className="zp-grid">
      <Card title="Задачі" aside="створюються автоматично, коли змінюється рівень менеджера">
        {open.length ? (
          <div className="zps-tasks">
            {open.map((t) => {
              const due = t.from ? `${String(t.from).slice(0, 7)}-05` : null, over = !!due && today > due;
              return (
                <div className="zps-task" key={t.id}>
                  <div className="zp-row"><b className="zp-grow">Перепідписати офер</b>{due && <Pill tone={over ? "danger" : "warn"}>{over ? "прострочено · " : ""}строк до {ddy(due)}</Pill>}</div>
                  <div><b>{t.name || `#${t.empId}`}</b></div>
                  <div className="zp-row"><span>{t.title}</span><span className="zp-muted">діє з {ddy(t.from)}</span></div>
                  <div className="zp-hint">Створено автоматично {dt(t.createdAt)}. Новий офер — у документах працівника (очікує підпису).</div>
                  <div className="zp-row">
                    {confirm === t.id ? (
                      <>
                        <span className="zp-hint">Працівник підписав новий офер?</span>
                        <button className="zp-btn zp-btn--sm zp-btn--primary" disabled={busy === t.id} onClick={() => void close(t.id)}>Так, підписано</button>
                        <button className="zp-btn zp-btn--sm" onClick={() => setConfirm(null)}>Ні</button>
                      </>
                    ) : <button className="zp-btn zp-btn--sm zp-btn--primary" onClick={() => setConfirm(t.id)}>Офер підписано</button>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <Empty>Відкритих задач немає.</Empty>}
      </Card>
      {done.length > 0 && (
        <Card title="Закриті">
          <div className="zp-table-wrap">
            <table className="zp-table">
              <thead><tr><th>Працівник</th><th>Документ</th><th>Діє з</th><th>Стан</th></tr></thead>
              <tbody>
                {done.map((t) => (
                  <tr key={t.id}><td>{t.name || `#${t.empId}`}</td><td>{t.title}</td><td>{ddy(t.from)}</td><td><Pill tone="ok">підписано {dt(t.signedAt).slice(0, 5)}</Pill></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
