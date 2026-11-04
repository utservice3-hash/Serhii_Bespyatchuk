import { useCallback, useEffect, useState } from "react";
import { fetchLinkedinStats, setLinkedinQueuePaused, type LinkedinStats } from "../../../api";
import { getAuthPayload } from "../../../auth";
import { useDialogs } from "../../../components/Dialogs";
import { todayKyiv } from "../periodRules";
import LinkedinQueueTab from "./LinkedinQueueTab";

/**
 * 🔗 «Клієнти → LinkedIn» (задача 7361). Вигляд — як у сусіднього «Тендери Prozorro» (Роман 03.11.2026: «зроби в стилі
 * дашборду»): дві вкладки «Статистика» / «Черга», плитки `kpi-card`, картки `chart-card`, таблиці `data-table`.
 * Смуга стану бота з кнопкою «Зупинити бота» — над обома вкладками. «Черга» й кнопка — лише з правом
 * `manage_linkedin_queue` (Юля, адмін); сервер гейтить і вкладку, і право незалежно від показу.
 */

type Preset = "week" | "month" | "custom";
const MUTED = "var(--text-muted)";
const RED = "#b3261e", GREEN = "#16a34a", AMBER = "#b45309";
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));
export const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";
const PRESETS: { key: Preset; label: string }[] = [{ key: "week", label: "Цей тиждень" }, { key: "month", label: "Місяць" }, { key: "custom", label: "з – по" }];

const STATE: Record<string, { label: string; color: string; bg: string }> = {
  offered: { label: "у менеджера", color: AMBER, bg: "rgba(180,83,9,0.10)" },
  taken: { label: "взяв", color: GREEN, bg: "rgba(22,163,74,0.10)" },
  dispatcher: { label: "у Даші", color: RED, bg: "rgba(179,38,30,0.08)" },
  waiting: { label: "чекає", color: MUTED, bg: "var(--bg)" },
  gone: { label: "пішла з черги", color: MUTED, bg: "var(--bg)" },
};
function Pill({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, color: MUTED, bg: "var(--bg)" };
  return <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, color: s.color, background: s.bg, whiteSpace: "nowrap" }}>{s.label}</span>;
}

export function LinkedinSection() {
  const dialogs = useDialogs();
  const today = todayKyiv();
  const [tab, setTab] = useState<"stats" | "queue">("stats");
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState({ from: addDays(today, -13), to: today });
  const period = preset === "week" ? { from: mondayOf(today), to: today } : preset === "month" ? { from: `${today.slice(0, 8)}01`, to: today } : custom;
  const [data, setData] = useState<LinkedinStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = (getAuthPayload()?.perms ?? []).includes("manage_linkedin_queue");

  const load = useCallback(async () => {
    setError(null);
    try { setData(await fetchLinkedinStats(period.from, period.to)); } catch (e) { setError(err(e)); }
  }, [period.from, period.to]);
  useEffect(() => { void load(); }, [load]);

  const togglePause = async () => {
    if (!data) return;
    const stop = !data.queue.paused;
    const yes = await dialogs.confirm(stop
      ? { title: "Зупинити бота?", okLabel: "Зупинити", danger: true,
        text: "Нові заявки з LinkedIn нікому не надходитимуть і чекатимуть на етапі. Поточні пропозиції завмруть: 15 хвилин не спливають, доки бота не запустять." }
      : { title: "Запустити бота?", okLabel: "Запустити",
        text: "Черга знову роздаватиме заявки по колу. Поточні пропозиції отримають свіжі 15 хвилин робочого часу." });
    if (!yes) return;
    setBusy(true);
    try { await setLinkedinQueuePaused(stop); await load(); } catch (e) { setError(err(e)); }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>LinkedIn</h1>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>Заявки з етапу «LinkedIn» у Кваліфікації — менеджерам по колу</div>
        </div>
        <div className="cl-tabs">
          <button type="button" className="cl-tab" aria-pressed={tab === "stats"} onClick={() => setTab("stats")}>Статистика</button>
          {canEdit && <button type="button" className="cl-tab" aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>Черга</button>}
        </div>
      </div>
      {error && <p className="loading-text" style={{ color: RED }}>{error}</p>}
      {data && <BotStatus q={data.queue} canEdit={canEdit} busy={busy} onToggle={() => void togglePause()} />}
      {tab === "queue" && canEdit ? <LinkedinQueueTab onSaved={() => void load()} /> : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "14px 0" }}>
            {PRESETS.map((x) => (
              <button key={x.key} type="button" className="hr-btn" onClick={() => setPreset(x.key)}
                style={preset === x.key ? { background: "#1f2330", color: "#fff", borderColor: "#1f2330" } : undefined}>{x.label}</button>
            ))}
            {preset === "custom" && <>
              <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="з" />
              <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="по" />
            </>}
          </div>
          {!data ? <p className="loading-text">Завантаження…</p> : <StatsTab s={data} />}
        </>
      )}
    </div>
  );
}

function BotStatus({ q, canEdit, busy, onToggle }: { q: LinkedinStats["queue"]; canEdit: boolean; busy: boolean; onToggle: () => void }) {
  const off = q.mode === "off";
  const tone = off || q.paused ? RED : q.mode === "dry" ? AMBER : GREEN;
  const head = off ? "Бот вимкнений на сервері" : q.paused ? "Бот зупинено" : q.mode === "dry" ? "Бот працює · пробний режим" : "Бот працює";
  const line = off ? "Черга не працює зовсім (налаштування сервера LINKEDIN_QUEUE=off) — увімкнути можна лише там."
    : q.paused ? `Зупинив ${q.pausedBy ?? "—"} ${fmtAt(q.pausedAt)}. Нові заявки чекають на етапі, 15 хвилин не спливають.`
    : q.mode === "dry" ? "Лише записує, кому віддав би заявку. У Kommo й Telegram нічого не пише."
    : "Роздає заявки менеджерам у Telegram по колу.";
  return (
    <div className="chart-card" style={{ borderLeft: `4px solid ${tone}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontWeight: 700, color: tone }}>{head}</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{line}</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          У колі <b>{q.members}</b> · наступний — <b>{q.nextName ?? "нікого"}</b>
          {q.launchedAt && <span style={{ color: MUTED }}> · рахуємо з {fmtAt(q.launchedAt)}</span>}
        </div>
      </div>
      {canEdit && !off && (
        <button type="button" className="hr-btn" disabled={busy} onClick={onToggle}
          style={q.paused ? { background: GREEN, color: "#fff", borderColor: GREEN } : { color: RED, borderColor: RED }}>
          {q.paused ? "▶ Запустити бота" : "⏸ Зупинити бота"}
        </button>
      )}
    </div>
  );
}

function StatsTab({ s }: { s: LinkedinStats }) {
  const k = s.kpi;
  const tot = s.perManager.reduce((a, m) => ({ received: a.received + m.received, taken: a.taken + m.taken, ignored: a.ignored + m.ignored }), { received: 0, taken: 0, ignored: 0 });
  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <div className="kpi-card"><span className="kpi-label">Заявок створено</span><span className="kpi-value">{k.created}</span>
          <span style={{ fontSize: 11, color: MUTED }}>нові угоди на етапі «LinkedIn»</span></div>
        <div className="kpi-card"><span className="kpi-label">Взяли через бота</span><span className="kpi-value">{k.taken}</span>
          <span style={{ fontSize: 11, color: MUTED }}>{k.created ? `${String(Math.round((k.taken / k.created) * 100))}% заявок` : "—"}</span></div>
        <div className="kpi-card" style={k.dispatcher ? { borderLeft: `4px solid ${RED}` } : undefined}><span className="kpi-label">Пішли Даші</span><span className="kpi-value">{k.dispatcher}</span>
          <span style={{ fontSize: 11, color: MUTED }}>{k.dispatcherDup} дублі · {k.dispatcherNobody} ніхто не взяв</span></div>
        <div className="kpi-card"><span className="kpi-label">Сер. час взяття</span><span className="kpi-value">{k.avgTakeMin == null ? "—" : `${String(k.avgTakeMin)} хв`}</span>
          <span style={{ fontSize: 11, color: MUTED }}>від пропозиції до «Взяти»</span></div>
        <div className="kpi-card" title="Машини рахуються з каналу LinkedIn: потрібне джерело «LinkedIn» у Kommo і прохід «канал LinkedIn»"><span className="kpi-label">Машин поїхало</span><span className="kpi-value">—</span>
          <span style={{ fontSize: 11, color: MUTED }}>зʼявиться з каналом LinkedIn</span></div>
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h2 className="chart-title">По менеджерах</h2>
        {s.perManager.length === 0 ? <p className="loading-text">За період бот нікому не пропонував заявок.</p> : (
          <table className="data-table">
            <thead><tr><th>Менеджер</th><th style={{ textAlign: "right" }}>Отримав</th><th style={{ textAlign: "right" }}>Взяв</th>
              <th style={{ textAlign: "right" }}>Проігнорував</th><th style={{ textAlign: "right" }}>Сер. час взяття</th><th style={{ textAlign: "right" }}>Машин</th></tr></thead>
            <tbody>
              {s.perManager.map((m) => (
                <tr key={m.managerId}><td>{m.name}</td><td style={{ textAlign: "right" }}>{m.received}</td><td style={{ textAlign: "right" }}>{m.taken}</td>
                  <td style={{ textAlign: "right", color: m.ignored ? RED : undefined, fontWeight: m.ignored ? 600 : undefined }}>{m.ignored}</td>
                  <td style={{ textAlign: "right" }}>{m.avgTakeMin == null ? "—" : `${String(m.avgTakeMin)} хв`}</td>
                  <td style={{ textAlign: "right", color: MUTED }}>—</td></tr>
              ))}
              <tr style={{ fontWeight: 700 }}><td>Разом</td><td style={{ textAlign: "right" }}>{tot.received}</td><td style={{ textAlign: "right" }}>{tot.taken}</td>
                <td style={{ textAlign: "right" }}>{tot.ignored}</td><td style={{ textAlign: "right" }}>{k.avgTakeMin == null ? "—" : `${String(k.avgTakeMin)} хв`}</td><td style={{ textAlign: "right", color: MUTED }}>—</td></tr>
            </tbody>
          </table>
        )}
        {s.queue.mode !== "live" && <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Пробний режим: кнопки «Взяти» в боті ще немає, тож «взяв» — нуль, а кожна пропозиція спливає через 15 хв.</div>}
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <h2 className="chart-title">Заявки</h2>
        {s.items.length === 0 ? <p className="loading-text">За період нових угод на етапі «LinkedIn» не було.</p> : (
          <table className="data-table">
            <thead><tr><th>Угода</th><th>Стан</th><th>Менеджер</th><th>Створено</th><th>Деталі</th></tr></thead>
            <tbody>{s.items.map((it) => (
              <tr key={it.kommoId}>
                <td>{it.dealName ?? `#${String(it.kommoId)}`}</td>
                <td><Pill state={it.state} /></td>
                <td>{it.managerName ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtAt(it.seenAt)}</td>
                <td style={{ fontSize: 12, color: MUTED }}>
                  {[it.state === "offered" && it.deadlineAt ? `до ${fmtAt(it.deadlineAt)}` : null, it.misses ? `не взяли ${String(it.misses)}` : null, it.reason].filter(Boolean).join(" · ") || "—"}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
