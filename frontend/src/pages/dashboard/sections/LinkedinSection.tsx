import { useCallback, useEffect, useState } from "react";
import { fetchLinkedinStats, type LinkedinStats } from "../../../api";
import { getAuthPayload } from "../../../auth";
import { useToast } from "../../../components/Toasts";
import LinkedinQueueTab, { kyivDt, MODE, STATE } from "./LinkedinQueueTab";

/**
 * 🔗 «Клієнти → LinkedIn» (задача 7361; макет погоджено Романом 03.11.2026). Статистика черги за період: плитки,
 * по менеджерах (отримав / взяв / проігнорував / за скільки взяв), заявки зі станом і рядок черги. «Налаштувати
 * чергу» — лише з правом `manage_linkedin_queue` (Юля, адмін); сервер гейтить і вкладку, і право незалежно від показу.
 */
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";
const MUTED = "var(--text-muted)";
const kyivToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const card = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 14 } as const;
const tile = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" } as const;
const STATE_COLOR: Record<string, string> = { offered: "#b7791f", taken: "#2f855a", dispatcher: "#c8102e", waiting: "var(--text-muted)", gone: "var(--text-muted)" };

export function LinkedinSection() {
  const toast = useToast();
  const today = kyivToday();
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [data, setData] = useState<LinkedinStats | null>(null);
  const [editing, setEditing] = useState(false);
  const canEdit = (getAuthPayload()?.perms ?? []).includes("manage_linkedin_queue");

  const load = useCallback(async () => {
    try { setData(await fetchLinkedinStats(from, to)); } catch (e) { toast(err(e), { error: true }); }
  }, [from, to, toast]);
  useEffect(() => { void load(); }, [load]);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };
  const k = data?.kpi;
  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1 className="page-title">🔗 LinkedIn</h1>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <button onClick={() => preset(mondayOf(today), today)}>Цей тиждень</button>
          <button onClick={() => preset(today.slice(0, 8) + "01", today)}>Місяць</button>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Від" />
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="До" />
        </div>
      </div>
      {!data || !k ? <div style={{ color: MUTED }}>Завантаження…</div> : (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
          <div style={tile}><div style={{ fontSize: 12, color: MUTED }}>Заявок створено</div><div style={{ fontSize: 22, fontWeight: 700 }}>{k.created}</div></div>
          <div style={tile}><div style={{ fontSize: 12, color: MUTED }}>Взяли через бота</div><div style={{ fontSize: 22, fontWeight: 700 }}>{k.taken}</div></div>
          <div style={tile}><div style={{ fontSize: 12, color: MUTED }}>Пішли Даші</div><div style={{ fontSize: 22, fontWeight: 700 }}>{k.dispatcher}</div>
            <div style={{ fontSize: 11, color: MUTED }}>{k.dispatcherDup} дублі · {k.dispatcherNobody} ніхто не взяв</div></div>
          <div style={tile}><div style={{ fontSize: 12, color: MUTED }}>Сер. час взяття</div><div style={{ fontSize: 22, fontWeight: 700 }}>{k.avgTakeMin == null ? "—" : `${String(k.avgTakeMin)} хв`}</div></div>
          <div style={tile} title="Машини рахуються з каналу LinkedIn, а його ще немає: потрібне джерело «LinkedIn» у Kommo (Василь) і прохід «канал LinkedIn»">
            <div style={{ fontSize: 12, color: MUTED }}>Машин поїхало</div><div style={{ fontSize: 22, fontWeight: 700 }}>—</div>
            <div style={{ fontSize: 11, color: MUTED }}>зʼявиться з каналом LinkedIn</div></div>
        </div>

        <div style={card}>
          <b>По менеджерах</b>
          {data.perManager.length === 0 ? <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>За період бот нікому не пропонував заявок.</div> : (
            <table className="data-table" style={{ width: "100%", marginTop: 8 }}>
              <thead><tr><th>Менеджер</th><th style={{ textAlign: "right" }}>Отримав</th><th style={{ textAlign: "right" }}>Взяв</th>
                <th style={{ textAlign: "right" }}>Проігнорував</th><th style={{ textAlign: "right" }}>Взяв за</th><th style={{ textAlign: "right" }}>Машин</th></tr></thead>
              <tbody>{data.perManager.map((s) => (
                <tr key={s.managerId}><td>{s.name}</td><td style={{ textAlign: "right" }}>{s.received}</td><td style={{ textAlign: "right" }}>{s.taken}</td>
                  <td style={{ textAlign: "right", color: s.ignored ? "#c8102e" : undefined }}>{s.ignored}</td>
                  <td style={{ textAlign: "right" }}>{s.avgTakeMin == null ? "—" : `${String(s.avgTakeMin)} хв`}</td>
                  <td style={{ textAlign: "right", color: MUTED }}>—</td></tr>
              ))}</tbody>
            </table>
          )}
          {data.queue.mode !== "live" && <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>Пробний режим: кнопки «Взяти» ще немає, тож «взяв» — нуль, а кожна пропозиція спливає через 15 хв.</div>}
        </div>

        <div style={card}>
          <b>Заявки</b>
          {data.items.length === 0 ? <div style={{ color: MUTED, fontSize: 13, marginTop: 6 }}>За період нових угод на етапі «LinkedIn» не було.</div> : (
            <table className="data-table" style={{ width: "100%", marginTop: 8 }}>
              <thead><tr><th>Угода</th><th>Стан</th><th>Менеджер</th><th>Створено</th><th>Причина</th></tr></thead>
              <tbody>{data.items.map((it) => (
                <tr key={it.kommoId}><td>{it.dealName ?? `#${String(it.kommoId)}`}</td>
                  <td style={{ color: STATE_COLOR[it.state] }}>{STATE[it.state] ?? it.state}{it.state === "offered" && it.deadlineAt ? ` · до ${kyivDt(it.deadlineAt)}` : ""}{it.misses ? ` · не взяли ${String(it.misses)}` : ""}</td>
                  <td>{it.managerName ?? "—"}</td><td>{kyivDt(it.seenAt)}</td><td style={{ color: MUTED, fontSize: 12 }}>{it.reason ?? ""}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>

        <div style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
          <span><b>Черга:</b> {data.queue.members} менеджерів · наступний — {data.queue.nextName ?? "нікого"} · відповідальна — {data.queue.dispatcherName ?? "не вибрано"} · режим {MODE[data.queue.mode]?.split(" — ")[0] ?? data.queue.mode}
            {data.queue.launchedAt && <span style={{ color: MUTED }}> · рахуємо з {kyivDt(data.queue.launchedAt)}</span>}</span>
          {canEdit && <button onClick={() => setEditing((v) => !v)}>{editing ? "Сховати налаштування" : "Налаштувати чергу"}</button>}
        </div>
        {canEdit && editing && <LinkedinQueueTab onSaved={() => void load()} />}
      </>)}
    </div>
  );
}
