import { useCallback, useEffect, useState } from "react";
import { fetchLinkedinQueue, saveLinkedinQueueDispatcher, saveLinkedinQueueMembers, type LinkedinQueueScreen } from "../../../api";
import { useToast } from "../../../components/Toasts";

/**
 * 🔗 Редактор черги LinkedIn («Клієнти → LinkedIn» → «Налаштувати чергу»; задача 7361, рішення Юлі 03.11.2026). Порядок —
 * «кожна нова заявка йде наступному за списком». У пулі — менеджери від 1 місяця (зустріч 28.10); кнопка підставляє
 * таких, але список остаточно той, що тут. Сервер гейтить право `manage_linkedin_queue` незалежно від показу.
 */
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";
const MUTED = "var(--text-muted)";
export const kyivDt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
export const STATE: Record<string, string> = {
  waiting: "чекає", offered: "запропоновано", taken: "взяли", dispatcher: "відповідальній", gone: "пішла з черги",
};
export const MODE: Record<string, string> = {
  off: "вимкнено", dry: "пробний — бот лише пише в журнал, кому віддав би; у Kommo й Telegram нічого", live: "бойовий",
};

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

  if (!data) return <div style={{ color: MUTED }}>Завантаження…</div>;
  const byId = new Map([...data.members, ...data.candidates].map((p) => [p.managerId, p]));
  const saved = data.members.map((m) => m.managerId);
  const dirty = order.join(",") !== saved.join(",");
  const outside = data.candidates.filter((c) => !order.includes(c.managerId));
  const move = (i: number, d: -1 | 1) => setOrder((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return o; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = async () => {
    setBusy(true);
    try { await saveLinkedinQueueMembers(order); toast("Список черги збережено"); await load(); onSaved?.(); }
    catch (e) { toast(err(e), { error: true }); } finally { setBusy(false); }
  };
  const setDispatcher = async (v: string) => {
    try { await saveLinkedinQueueDispatcher(v ? Number(v) : null); toast("Відповідальну збережено"); await load(); onSaved?.(); }
    catch (e) { toast(err(e), { error: true }); }
  };
  const box = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 14 } as const;

  return (
    <div>
      <div style={box}>
        <b>🔗 Черга LinkedIn</b>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
          Угода на етапі «LinkedIn» (Кваліфікація) йде менеджерам по колу, за цим списком: одночасно лише в одного, 15 хв
          робочого часу (пн–пт 8:00–18:00) на «Взяти». Хто не взяв — пропускає свою чергу. Двоє підряд не взяли або клієнт
          уже в іншого менеджера — заявка йде відповідальній. Відпустку, вихідний, лікарняний з «Календаря команди» бот
          пропускає сам.
        </div>
        <div style={{ fontSize: 13, marginTop: 8 }}>Режим: <b>{MODE[data.mode] ?? data.mode}</b>{data.launchedAt && <span style={{ color: MUTED }}> · рахуємо угоди з {kyivDt(data.launchedAt)}</span>}</div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 8 }}>
          Відповідальна (дублі й «двоє не взяли»):
          <select value={data.dispatcherUserId ?? ""} onChange={(e) => void setDispatcher(e.target.value)} aria-label="Відповідальна за чергу">
            <option value="">— не вибрано —</option>
            {data.dispatchers.map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}
          </select>
        </label>
      </div>

      <div style={box}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <b>Порядок кола ({order.length})</b>
          <span style={{ display: "flex", gap: 8 }}>
            <button disabled={!outside.some((c) => c.suggested)} onClick={() => setOrder((o) => [...o, ...outside.filter((c) => c.suggested).map((c) => c.managerId)])}>
              + Додати всіх від 1 місяця
            </button>
            <button disabled={!dirty || busy} onClick={() => void save()} style={{ fontWeight: 700 }}>Зберегти</button>
            {dirty && <button disabled={busy} onClick={() => setOrder(saved)}>Скасувати</button>}
          </span>
        </div>
        {order.length === 0 && <div style={{ color: MUTED, fontSize: 13, marginTop: 8 }}>Список порожній — заявки йдуть відповідальній.</div>}
        <table className="data-table" style={{ width: "100%", marginTop: 8 }}>
          <tbody>
            {order.map((id, i) => {
              const p = byId.get(id);
              const absent = data.members.find((m) => m.managerId === id)?.absentToday;
              return (
                <tr key={id}>
                  <td style={{ width: 32, color: MUTED }}>{i + 1}</td>
                  <td><b>{p?.name ?? `Менеджер #${String(id)}`}</b> <span style={{ color: MUTED, fontSize: 12 }}>{p?.team ?? "без команди"}{absent ? " · сьогодні відсутній — пропуститься" : ""}</span></td>
                  <td style={{ color: MUTED, fontSize: 12 }}>{p?.hiredAt ? `з ${p.hiredAt.slice(8, 10)}.${p.hiredAt.slice(5, 7)}.${p.hiredAt.slice(0, 4)}` : "дата виходу невідома"}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Вище">↑</button>
                    <button onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label="Нижче">↓</button>
                    <button onClick={() => setOrder((o) => o.filter((x) => x !== id))} aria-label="Прибрати">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {outside.length > 0 && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10 }}>
            Додати:
            <select value="" onChange={(e) => { const v = Number(e.target.value); if (v) setOrder((o) => [...o, v]); }} aria-label="Додати менеджера в чергу">
              <option value="">— менеджер —</option>
              {outside.map((c) => <option key={c.managerId} value={c.managerId}>{c.name}{c.team ? ` · ${c.team}` : ""}{c.suggested ? "" : c.hiredAt ? " · менше місяця" : " · дата виходу невідома"}</option>)}
            </select>
          </label>
        )}
      </div>

    </div>
  );
}
