import { useCallback, useEffect, useState } from "react";
import { fetchLinkedinQueue, saveLinkedinQueueMembers, type LinkedinQueueScreen } from "../../../api";
import { useToast } from "../../../components/Toasts";

/**
 * 🔗 Вкладка «Черга» екрана «Клієнти → LinkedIn» (задача 7361; рішення Юлі 03.11.2026). Порядок кола — «кожна нова
 * заявка йде наступному за списком». У пулі — менеджери від 1 місяця (зустріч 28.10): кнопка підставляє таких, але
 * список остаточно той, що тут. Сервер гейтить право `manage_linkedin_queue` незалежно від показу.
 */
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";
const MUTED = "var(--text-muted)";
const inp = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", maxWidth: 360 } as const;
const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "невідомо");
const dark = { background: "#1f2330", color: "#fff", borderColor: "#1f2330" } as const;

export default function LinkedinQueueTab({ onSaved }: { onSaved?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<LinkedinQueueScreen | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const d = await fetchLinkedinQueue(); setData(d); setOrder(d.members.map((m) => m.managerId)); }
    catch (e) { toast(err(e), { error: true }); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return <p className="loading-text">Завантаження…</p>;
  const byId = new Map([...data.members, ...data.candidates].map((p) => [p.managerId, p]));
  const absent = new Set(data.members.filter((m) => m.absentToday).map((m) => m.managerId));
  const bot = new Set(data.members.filter((m) => m.botLinked).map((m) => m.managerId));
  const noBot = order.filter((id) => !bot.has(id)).length;
  const saved = data.members.map((m) => m.managerId);
  const dirty = order.join(",") !== saved.join(",");
  const outside = data.candidates.filter((c) => !order.includes(c.managerId));
  const suggested = outside.filter((c) => c.suggested);
  const move = (i: number, d: -1 | 1) => setOrder((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return o; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = async () => {
    setBusy(true);
    try { await saveLinkedinQueueMembers(order); toast("Порядок кола збережено"); await load(); onSaved?.(); }
    catch (e) { toast(err(e), { error: true }); }
    setBusy(false);
  };

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      <div className="chart-card">
        <h2 className="chart-title">Як працює черга</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
          <li>Нова угода на етапі «LinkedIn» іде наступному менеджеру за списком нижче — одночасно лише одному.</li>
          <li>На «Взяти» — 15 хвилин робочого часу (пн–пт 8:00–18:00). Після 18:00 і у вихідні заявка чекає.</li>
          <li>Не взяв за 15 хвилин — заявка йде наступному, а він пропускає свою чергу.</li>
          <li>Двоє підряд не взяли або клієнт уже в іншого менеджера — заявка лишається на «Операційному директорі», її призначає Даша.</li>
          <li>Відпустку, вихідний, лікарняний із «Календаря команди» бот пропускає сам.</li>
          <li>Менеджер без підключеного бота заявок не отримує — коло його пропускає. Підключити: плашка вгорі дашборда в нього самого.</li>
        </ul>
      </div>


      <div className="chart-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <h2 className="chart-title" style={{ margin: 0 }}>Порядок кола · {order.length}{noBot > 0 && <span style={{ fontSize: 12, fontWeight: 400, color: "#b3261e" }}> · без бота {noBot}</span>}</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {suggested.length > 0 && <button type="button" className="hr-btn" onClick={() => setOrder((o) => [...o, ...suggested.map((c) => c.managerId)])}>+ Усі від 1 місяця ({suggested.length})</button>}
            {dirty && <button type="button" className="hr-btn" disabled={busy} onClick={() => setOrder(saved)}>Скасувати</button>}
            <button type="button" className="hr-btn" disabled={!dirty || busy} onClick={() => void save()} style={dirty ? dark : undefined}>Зберегти</button>
          </div>
        </div>
        {order.length === 0 ? <p className="loading-text">Список порожній — кожна заявка лишиться на «Операційному директорі» для Даші.</p> : (
          <table className="data-table">
            <thead><tr><th style={{ width: 40 }}>№</th><th>Менеджер</th><th>Команда</th><th>Працює з</th><th>Бот</th><th>Сьогодні</th><th style={{ textAlign: "right" }}>Порядок</th></tr></thead>
            <tbody>
              {order.map((id, i) => {
                const p = byId.get(id);
                return (
                  <tr key={id}>
                    <td style={{ color: MUTED }}>{i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{p?.name ?? `Менеджер #${String(id)}`}</td>
                    <td>{p?.team ?? "—"}</td>
                    <td>{dmy(p?.hiredAt ?? null)}</td>
                    <td style={{ color: bot.has(id) ? "#16a34a" : "#b3261e" }}>{bot.has(id) ? "підключено" : "не підключено — пропуститься"}</td>
                    <td style={{ color: absent.has(id) ? "#b45309" : MUTED }}>{absent.has(id) ? "відсутній — пропуститься" : "у черзі"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="hr-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Вище">↑</button>{" "}
                      <button type="button" className="hr-btn" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label="Нижче">↓</button>{" "}
                      <button type="button" className="hr-btn" onClick={() => setOrder((o) => o.filter((x) => x !== id))}>Прибрати</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {outside.length > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: 13 }}>
            <span style={{ color: MUTED }}>Додати в чергу:</span>
            <select style={inp} value="" onChange={(e) => { const v = Number(e.target.value); if (v) setOrder((o) => [...o, v]); }} aria-label="Додати менеджера в чергу">
              <option value="">— менеджер —</option>
              {outside.map((c) => <option key={c.managerId} value={c.managerId}>{c.name}{c.team ? ` · ${c.team}` : ""}{c.suggested ? "" : c.hiredAt ? " · менше місяця" : " · дата виходу невідома"}</option>)}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}
