import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLinkedinStats, setLinkedinQueuePaused, type LinkedinOutcome, type LinkedinStats } from "../../../api";
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
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" }) : "запуску бота");
const err = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Помилка";
const PRESETS: { key: Preset; label: string }[] = [{ key: "week", label: "Цей тиждень" }, { key: "month", label: "Місяць" }, { key: "custom", label: "з – по" }];

const STATE: Record<string, { label: string; color: string; bg: string }> = {
  offered: { label: "у менеджера", color: AMBER, bg: "rgba(180,83,9,0.10)" },
  taken: { label: "взяв", color: GREEN, bg: "rgba(22,163,74,0.10)" },
  dispatcher: { label: "на Операційному директорі", color: RED, bg: "rgba(179,38,30,0.08)" },
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
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{data?.scope === "own" ? "Моя статистика: заявки з LinkedIn, які бот мені пропонував"
            : data?.scope === "team" ? "Статистика моєї команди: заявки з LinkedIn, які бот пропонував її менеджерам"
            : "Усі угоди з LinkedIn у Kommo і заявки з етапу «LinkedIn» у Кваліфікації менеджерам по колу"}</div>
        </div>
        <div className="cl-tabs">
          <button type="button" className="cl-tab" aria-pressed={tab === "stats"} onClick={() => setTab("stats")}>Статистика</button>
          {canEdit && <button type="button" className="cl-tab" aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>Черга</button>}
        </div>
      </div>
      {error && <p className="loading-text" style={{ color: RED }}>{error}</p>}
      {data && data.scope === "all" && <BotStatus q={data.queue} canEdit={canEdit} busy={busy} onToggle={() => void togglePause()} />}
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
  // Один рядок замість картки (макет 9363): зміст той самий — стан, пояснення, коло, наступний, з якого часу.
  return (
    <div className="li-bot" style={{ borderLeft: `4px solid ${tone}` }}>
      <span className="li-dot" style={{ background: tone, boxShadow: `0 0 0 4px color-mix(in srgb, ${tone} 18%, transparent)` }} />
      <b style={{ color: tone }}>{head}</b>
      <span style={{ color: MUTED, flex: "1 1 300px" }}>
        {line} · у колі <b style={{ color: "var(--text)" }}>{q.members}</b> · наступний — <b style={{ color: "var(--text)" }}>{q.nextName ?? "нікого"}</b>
        {q.launchedAt && <> · рахуємо з {fmtAt(q.launchedAt)}</>}
      </span>
      {canEdit && !off && (
        <button type="button" className="hr-btn" disabled={busy} onClick={onToggle}
          style={q.paused ? { background: GREEN, color: "#fff", borderColor: GREEN } : { color: RED, borderColor: RED }}>
          {q.paused ? "▶ Запустити бота" : "⏸ Зупинити бота"}
        </button>
      )}
    </div>
  );
}

/** Кольори стану угоди: у роботі — бурштин, успішна — зелений, закрита — сірий (ті самі токени, що в решті дашборду). */
const OUTCOME: Record<LinkedinOutcome, { label: string; color: string; bg: string; bar: string }> = {
  open: { label: "У роботі", color: "var(--warn)", bg: "var(--warn-bg)", bar: "#f59e0b" },
  won: { label: "Успішні", color: "var(--ok)", bg: "var(--ok-bg)", bar: "#16a34a" },
  lost: { label: "Закриті", color: MUTED, bg: "color-mix(in srgb, var(--border) 55%, transparent)", bar: "#c4c8cf" },
};
const OUTCOMES: LinkedinOutcome[] = ["open", "won", "lost"];
type Deal = LinkedinStats["deals"]["deals"][number];
const NO_MANAGER = "менеджера немає в дашборді";
/** Назва без жодної літери чи цифри («–», порожньо) — у Kommo назви немає; так і пишемо, а не лишаємо прочерк. */
const hasName = (n: string | null): n is string => n != null && /[\p{L}\p{N}]/u.test(n);
const pct = (n: number, of: number) => (of ? `${String((n / of) * 100)}%` : "0%");
const PAGE = 12, MGR_PAGE = 10;

function StatsTab({ s }: { s: LinkedinStats }) {
  const k = s.kpi, d = s.deals;
  return (
    <>
      <div className="li-kpis">
        <div className="kpi-card li-hero" title="Джерело LinkedIn або тег LinkedIn у Kommo, будь-яка воронка, крім «Оплата перевозчикам». Від періоду не залежить">
          <span className="kpi-label">Угоди з LinkedIn · за весь час</span><span className="kpi-value">{d.total}</span>
          <span className="li-hint">у роботі {d.open} · успішні {d.won} · закриті {d.lost}</span>
          <div className="li-split">{OUTCOMES.map((o) => <span key={o} style={{ width: pct(d[o], d.total), background: o === "lost" ? "#6b7280" : OUTCOME[o].bar }} />)}</div>
        </div>
        <div className="kpi-card"><span className="kpi-label">{s.stage ? "Нових на етапі «LinkedIn»" : "Заявок отримано"}</span><span className="kpi-value">{s.stage ? s.stage.created : k.created}</span>
          <span className="li-hint">{s.stage ? `за період${s.stage.firstDay ? ` · етап з ${ddmm(s.stage.firstDay)}` : ""}` : s.scope === "own" ? "бот пропонував мені" : "бот пропонував команді"}</span></div>
        <div className="kpi-card"><span className="kpi-label">Взяли через бота</span><span className="kpi-value">{k.taken}</span>
          <span className="li-hint">{k.created ? `${String(Math.round((k.taken / k.created) * 100))}% із ${String(k.created)}${s.stage ? " у черзі бота" : ""}` : "—"}</span></div>
        {k.dispatcher != null && <div className="kpi-card" style={k.dispatcher ? { borderLeft: `4px solid ${RED}` } : undefined}><span className="kpi-label">Пішли на Операційного директора</span><span className="kpi-value">{k.dispatcher}</span>
          <span className="li-hint">{k.dispatcherDup} дублі · {k.dispatcherNobody} ніхто не взяв</span></div>}
        <div className="kpi-card"><span className="kpi-label">Сер. час взяття</span><span className="kpi-value">{k.avgTakeMin == null ? "—" : `${String(k.avgTakeMin)} хв`}</span>
          <span className="li-hint">від пропозиції до «Взяти»</span></div>
        <div className="kpi-card" title="Машини рахуються з каналу LinkedIn: потрібне джерело «LinkedIn» у Kommo і прохід «канал LinkedIn»"><span className="kpi-label">Машин поїхало</span><span className="kpi-value">—</span>
          <span className="li-hint">зʼявиться з каналом LinkedIn</span></div>
      </div>

      <div className="li-grid2">
        <StagesCard d={d} stage={s.stage} launchedAt={s.queue.launchedAt} />
        <ManagersCard deals={d.deals} own={s.scope === "own"} />
      </div>

      <AllDeals d={d} scope={s.scope} />

      <BotTables s={s} />
    </>
  );
}

/** «Де зараз угоди»: поточний етап у Kommo смугами (відкриті, потім за рискою закриті) + нові на етапі «LinkedIn» по днях. */
function StagesCard({ d, stage, launchedAt }: { d: LinkedinStats["deals"]; stage: LinkedinStats["stage"]; launchedAt: string | null }) {
  const max = Math.max(1, ...d.byStage.map((r) => r.count));
  const firstClosed = d.byStage.findIndex((r) => r.outcome !== "open");
  const dayMax = Math.max(1, ...(stage?.byDay ?? []).map((x) => x.count));
  return (
    <div className="chart-card">
      <h2 className="chart-title">Де зараз угоди</h2>
      <div className="li-sub">Поточний етап у Kommo · оновлюється з кожним синком</div>
      {d.total === 0 ? <p className="loading-text">Угод із джерелом чи тегом «LinkedIn» у Kommo немає.</p> : d.byStage.map((r, i) => (
        <div key={`${r.pipeline}|${r.stage}`}>
          {i === firstClosed && i > 0 && <div className="li-sep" />}
          <div className="li-row" title={`${r.pipeline} · ${r.stage}`}>
            <div className="li-name">{r.pipeline === "Повний цикл" ? r.stage : <><span style={{ color: MUTED }}>{r.pipeline} · </span>{r.stage}</>}</div>
            <div className="li-track"><span style={{ width: pct(r.count, max), background: OUTCOME[r.outcome].bar, borderRadius: 999 }} /></div>
            <div className="li-n" style={{ color: OUTCOME[r.outcome].color }}>{r.count}</div>
          </div>
        </div>
      ))}
      {stage && (
        <>
          <div className="li-sep" style={{ margin: "16px 0 10px" }} />
          <h3 style={{ fontSize: 13, margin: 0 }}>Нові на етапі «LinkedIn» по днях</h3>
          <div className="li-sub" style={{ margin: 0 }}>за період · за датою створення угоди в Kommo · разом {stage.created}</div>
          {stage.byDay.length === 0 ? <p className="loading-text">За період нових угод на етапі «LinkedIn» не було.</p> : (
            <div className="li-spark">
              {stage.byDay.map((x) => (
                <div key={x.day} title={`${ddmm(x.day)}: ${String(x.count)}`}>
                  <i style={{ height: x.count ? pct(x.count, dayMax) : "3%", background: x.count ? "var(--brand)" : "var(--border)" }} />
                  <span>{x.day.slice(8, 10)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="li-hint" style={{ marginTop: 8 }}>Хто взяв і скільки проігнорував — лише через бота, з {fmtDay(launchedAt)}.</div>
        </>
      )}
    </div>
  );
}

/** «По менеджерах»: скільки LinkedIn-угод у кожного, смуга у роботі / успішні / закриті. Рахується з того самого списку угод. */
function ManagersCard({ deals, own }: { deals: Deal[]; own: boolean }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const m = new Map<string, Record<LinkedinOutcome, number>>();
    for (const x of deals) {
      const key = x.managerName ?? NO_MANAGER;
      const r = m.get(key) ?? { open: 0, won: 0, lost: 0 };
      r[x.outcome]++;
      m.set(key, r);
    }
    return [...m.entries()].map(([name, r]) => ({ name, ...r, total: r.open + r.won + r.lost }))
      .sort((a, b) => b.total - a.total || b.won - a.won || a.name.localeCompare(b.name, "uk"));
  }, [deals]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const shown = all ? rows : rows.slice(0, MGR_PAGE);
  return (
    <div className="chart-card">
      <h2 className="chart-title">{own ? "Мої угоди" : "По менеджерах"}</h2>
      <div className="li-sub">Скільки угод з LinkedIn у кожного, за весь час</div>
      {rows.length === 0 ? <p className="loading-text">Угод немає.</p> : shown.map((r) => (
        <div key={r.name} className="li-row li-mgr" title={`у роботі ${String(r.open)} · успішні ${String(r.won)} · закриті ${String(r.lost)}`}>
          <div className="li-name" style={r.name === NO_MANAGER ? { color: MUTED, fontStyle: "italic" } : undefined}>{r.name}</div>
          <div className="li-track">{OUTCOMES.map((o) => <span key={o} style={{ width: pct(r[o], max), background: OUTCOME[o].bar }} />)}</div>
          <div className="li-n" style={{ fontWeight: 600 }}>{r.total}</div>
        </div>
      ))}
      <div className="li-leg">{OUTCOMES.map((o) => <span key={o}><i style={{ background: OUTCOME[o].bar }} />{OUTCOME[o].label.toLowerCase()}</span>)}</div>
      {rows.length > MGR_PAGE && <button type="button" className="li-link" onClick={() => setAll(!all)}>{all ? "Згорнути" : `Показати всіх ${String(rows.length)} →`}</button>}
    </div>
  );
}

/**
 * 🔗 «Усі угоди з LinkedIn» (задача 9363): «Источник клиента» = LinkedIn або тег LinkedIn у Kommo, будь-яка воронка й етап, включно із
 * закритими, крім «Оплата перевозчикам». Не залежить від періоду: це поточний стан CRM на останній синк. Правило — `core/linkedinDeals.ts`.
 * Фільтр і пошук — на фронті над тим самим списком: числа на чипах = лічильники ядра.
 */
function AllDeals({ d, scope }: { d: LinkedinStats["deals"]; scope: LinkedinStats["scope"] }) {
  const who = scope === "own" ? "мої" : scope === "team" ? "моєї команди" : "усі";
  const [f, setF] = useState<LinkedinOutcome | "all">("all");
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const needle = q.trim().toLowerCase();
  const list = d.deals.filter((x) => (f === "all" || x.outcome === f)
    && (!needle || [x.name, x.managerName, x.stage, x.pipeline, String(x.kommoId)].some((v) => v?.toLowerCase().includes(needle))));
  const shown = all ? list : list.slice(0, PAGE);
  const src = d.deals.filter((x) => x.bySource && !x.byTag).length, tag = d.deals.filter((x) => !x.bySource && x.byTag).length;
  const both = d.deals.filter((x) => x.bySource && x.byTag).length;
  const chips: { key: LinkedinOutcome | "all"; label: string; n: number }[] = [{ key: "all", label: "Усі", n: d.total }, ...OUTCOMES.map((o) => ({ key: o, label: OUTCOME[o].label, n: d[o] }))];
  return (
    <div className="chart-card" style={{ marginBottom: 16 }}>
      <div className="li-bar">
        <div>
          <h2 className="chart-title" style={{ margin: 0 }}>Усі угоди з LinkedIn · {d.total}</h2>
          <div className="li-sub" style={{ margin: 0 }}>Джерело LinkedIn або тег LinkedIn у Kommo ({who}), будь-яка воронка, крім «Оплата перевозчикам». Від періоду не залежить</div>
        </div>
        {d.total > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div className="li-chips">{chips.map((c) => (
              <button key={c.key} type="button" className="li-chip" aria-pressed={f === c.key} onClick={() => { setF(c.key); setAll(false); }}>{c.label}<em>{c.n}</em></button>
            ))}</div>
            <input className="li-search" type="search" placeholder="🔍 Угода, менеджер, етап" value={q} onChange={(e) => { setQ(e.target.value); setAll(false); }} aria-label="Пошук угоди" />
          </div>
        )}
      </div>
      {d.total === 0 ? <p className="loading-text">Угод із джерелом чи тегом «LinkedIn» у Kommo немає.</p> : list.length === 0 ? <p className="loading-text">Під фільтр нічого не підходить.</p> : (
        <table className="li-table">
          <colgroup><col style={{ width: "36%" }} /><col style={{ width: "24%" }} /><col style={{ width: "17%" }} /><col className="li-c-src" style={{ width: "11%" }} /><col style={{ width: "12%" }} /></colgroup>
          <thead><tr><th>Угода</th><th>Етап зараз</th><th>Менеджер</th><th className="li-c-src">Звідки LinkedIn</th><th style={{ textAlign: "right" }}>Створено</th></tr></thead>
          <tbody>{shown.map((x) => {
            const title = hasName(x.name) ? x.name : null;
            const label = title ?? <><span className="li-noname">Без назви в Kommo</span> <span className="li-id">#{x.kommoId}</span></>;
            const o = OUTCOME[x.outcome];
            return (
              <tr key={x.kommoId}>
                <td className="li-deal" title={title ?? `Без назви в Kommo #${String(x.kommoId)}`}>{x.url ? <a href={x.url} target="_blank" rel="noreferrer">{label}</a> : label}</td>
                <td title={`${x.pipeline} · ${x.stage}`}><span className="li-pill" style={{ color: o.color, background: o.bg }}>{x.pipeline === "Повний цикл" ? x.stage : `${x.pipeline} · ${x.stage}`}</span></td>
                <td title={x.managerName ?? NO_MANAGER} style={x.managerName ? undefined : { color: MUTED, fontStyle: "italic" }}>{x.managerName ?? NO_MANAGER}</td>
                <td className="li-c-src">{x.bySource && x.byTag ? <span className="li-src both">джерело + тег</span> : x.bySource ? <span className="li-src src">джерело</span> : <span className="li-src">тег</span>}</td>
                <td style={{ textAlign: "right", color: MUTED }}>{fmtAt(x.createdAt)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      {d.total > 0 && (
        <div className="li-foot">
          <span>Показано {shown.length} із {list.length} · джерело {src} · лише тег {tag} · джерело + тег {both}</span>
          {list.length > PAGE && <button type="button" className="li-link" style={{ margin: 0 }} onClick={() => setAll(!all)}>{all ? "Згорнути" : `Показати всі ${String(list.length)} →`}</button>}
        </div>
      )}
    </div>
  );
}

/** Таблиці бота (пробний режим): пропозиції по менеджерах і заявки. Зміст як був, лише згорнуто під кінець екрана (макет 9363). */
function BotTables({ s }: { s: LinkedinStats }) {
  const k = s.kpi;
  const tot = s.perManager.reduce((a, m) => ({ received: a.received + m.received, taken: a.taken + m.taken, ignored: a.ignored + m.ignored }), { received: 0, taken: 0, ignored: 0 });
  return (
    <details className="chart-card li-details">
      <summary>
        <span><span className="li-caret">▸</span> Бот: {s.scope === "own" ? "мої пропозиції" : "пропозиції по менеджерах"} і заявки з етапу «LinkedIn» <span style={{ color: MUTED, fontWeight: 400 }}>· заявок {s.items.length}</span></span>
        <span className="li-link" style={{ margin: 0 }}><span className="li-closed">Розгорнути</span><span className="li-opened">Згорнути</span></span>
      </summary>
      <h2 className="chart-title">{s.scope === "own" ? "Мої показники" : "По менеджерах"}</h2>
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

      <h2 className="chart-title" style={{ marginTop: 20 }}>Заявки</h2>
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
    </details>
  );
}
