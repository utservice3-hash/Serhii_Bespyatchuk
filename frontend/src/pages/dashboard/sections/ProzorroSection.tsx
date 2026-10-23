import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetchProzorroSettings, fetchProzorroStats, hiringError, saveProzorroSettings,
  type ProzorroSettingsResp, type ProzorroStatsResp, type PzConfigT, type PzModeT } from "../../../api";
import { todayKyiv } from "../periodRules";
import { useDialogs } from "../../../components/Dialogs";

/**
 * 🏛 «ТЕНДЕРИ PROZORRO» — екран у групі «Клієнти» (задача #5299). Дві вкладки:
 *  · «Статистика» — по днях, скільки знайдено переможців і скільки записано в Kommo (Роман 23.10.2026: «просто загальна
 *    статистика по днях»). Етапи угод (взято в роботу / передано / перевезення) — прохід 3.
 *  · «Налаштування» — адмін і операційний директор (сервер перевіряє сам, `SETTINGS_ROLES`): режим, хто веде, ліміт на день,
 *    мінімальна сума, ніші, журнал.
 * `ProzorroSection` ходить у сервер; `ProzorroScreen` лише малює — тому показ-прототип може дати йому прикладові дані.
 */

type Preset = "week" | "month" | "all" | "custom";
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export function presetPeriod(p: Preset, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  if (p === "week") return { from: addDays(today, -6), to: today };
  if (p === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === "all") return { from: "2026-10-24", to: today }; // перший прохід збору на проді (точка відліку)
  return custom;
}

export function ProzorroSection({ roleKey }: { roleKey: string | null }) {
  const today = todayKyiv();
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState({ from: addDays(today, -13), to: today });
  const period = presetPeriod(preset, today, custom);
  const [stats, setStats] = useState<ProzorroStatsResp | null>(null);
  const [settings, setSettings] = useState<ProzorroSettingsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Дзеркало серверного `SETTINGS_ROLES` (core/prozorroSettings.ts): адмін і ОД (у Сергія роль opdir).
  const isAdmin = roleKey === "admin" || roleKey === "opdir";
  useEffect(() => {
    setErr(null);
    fetchProzorroStats(period.from, period.to).then(setStats).catch((e) => setErr(hiringError(e)));
  }, [period.from, period.to]);
  useEffect(() => { if (isAdmin) fetchProzorroSettings().then(setSettings).catch((e) => setErr(hiringError(e))); }, [isAdmin]);
  return (
    <ProzorroScreen stats={stats} settings={settings} canEdit={isAdmin} err={err}
      preset={preset} onPreset={setPreset} custom={custom} onCustom={setCustom}
      onSave={async (c) => { const r = await saveProzorroSettings(c); setSettings(r); }} />
  );
}

export interface ProzorroScreenProps {
  stats: ProzorroStatsResp | null;
  settings: ProzorroSettingsResp | null;
  canEdit: boolean;
  err: string | null;
  preset: Preset;
  onPreset: (p: Preset) => void;
  custom: { from: string; to: string };
  onCustom: (c: { from: string; to: string }) => void;
  onSave: (c: PzConfigT) => Promise<void>;
}

export function ProzorroScreen(p: ProzorroScreenProps) {
  const [tab, setTab] = useState<"stats" | "settings">("stats");
  const min = p.settings?.config.minAmount;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Тендери Prozorro</h1>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            Переможці тендерів{min != null ? ` від ${Math.round(min).toLocaleString("uk-UA")} ₴` : ""} у «Продзвін» · «Тендер AI»
          </div>
        </div>
        <div className="cl-tabs">
          <button type="button" className="cl-tab" aria-pressed={tab === "stats"} onClick={() => setTab("stats")}>Статистика</button>
          {p.canEdit && <button type="button" className="cl-tab" aria-pressed={tab === "settings"} onClick={() => setTab("settings")}>Налаштування</button>}
        </div>
      </div>
      {p.err && <p className="loading-text" style={{ color: "#b3261e" }}>{p.err}</p>}
      {tab === "stats" || !p.canEdit ? <StatsTab {...p} /> : p.settings ? <SettingsTab view={p.settings} onSave={p.onSave} /> : <p className="loading-text">Завантаження…</p>}
    </div>
  );
}

const PRESETS: { key: Preset; label: string }[] = [{ key: "week", label: "Тиждень" }, { key: "month", label: "Місяць" }, { key: "all", label: "З запуску" }, { key: "custom", label: "з – по" }];
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const fmtAt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function StatsTab(p: ProzorroScreenProps) {
  const s = p.stats;
  const dayCount = s ? s.days.length : 0;
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {PRESETS.map((x) => (
          <button key={x.key} type="button" className="hr-btn" onClick={() => p.onPreset(x.key)}
            style={p.preset === x.key ? { background: "#1f2330", color: "#fff", borderColor: "#1f2330" } : undefined}>{x.label}</button>
        ))}
        {p.preset === "custom" && <>
          <input type="date" value={p.custom.from} max={p.custom.to} onChange={(e) => p.onCustom({ ...p.custom, from: e.target.value })} aria-label="з" />
          <input type="date" value={p.custom.to} min={p.custom.from} onChange={(e) => p.onCustom({ ...p.custom, to: e.target.value })} aria-label="по" />
        </>}
      </div>
      {!s ? <p className="loading-text">Завантаження…</p> : (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-label">Знайдено переможців</span><span className="kpi-value">{s.totals.found.toLocaleString("uk-UA")}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>~{dayCount ? Math.round(s.totals.found / dayCount) : 0} на день</span></div>
            <div className="kpi-card"><span className="kpi-label">Записано в Kommo</span><span className="kpi-value">{s.totals.pushed.toLocaleString("uk-UA")}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>угоди в «Продзвін» · «Тендер AI»</span></div>
            <div className="kpi-card" style={{ borderLeft: `4px solid ${s.lastError ? "#b3261e" : "#16a34a"}` }}>
              <span className="kpi-label">Останній збір</span>
              <span className="kpi-value" style={{ fontSize: 20 }}>{s.lastRunAt ? fmtAt(s.lastRunAt) : "ще не було"}</span>
              <span style={{ fontSize: 11, color: s.lastError ? "#b3261e" : "var(--text-muted)" }}>{s.lastError ?? "щодня о 06:05"}</span></div>
          </div>
          <div className="chart-card" style={{ marginTop: 16 }}>
            <h2 className="chart-title">По днях</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={s.days.map((d) => ({ ...d, date: ddmm(d.date) }))} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="found" name="знайдено переможців" fill="#B5D4F4" radius={[3, 3, 0, 0]} />
                <Bar dataKey="pushed" name="записано в Kommo" fill="#378ADD" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-card" style={{ marginTop: 16 }}>
            <h2 className="chart-title">Таблиця по днях</h2>
            <table className="data-table">
              <thead><tr><th>Дата</th><th style={{ textAlign: "right" }}>Знайдено переможців</th><th style={{ textAlign: "right" }}>Записано в Kommo</th></tr></thead>
              <tbody>
                {[...s.days].reverse().map((d) => (
                  <tr key={d.date}><td>{ddmm(d.date)}</td><td style={{ textAlign: "right" }}>{d.found}</td><td style={{ textAlign: "right" }}>{d.pushed}</td></tr>
                ))}
                <tr style={{ fontWeight: 700 }}><td>Разом</td><td style={{ textAlign: "right" }}>{s.totals.found}</td><td style={{ textAlign: "right" }}>{s.totals.pushed}</td></tr>
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              Що далі з цими угодами (взято в роботу, передано менеджеру, перевезення) — додамо наступним оновленням екрана.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const MODE_UI: { key: PzModeT; label: string; hint: string }[] = [
  { key: "off", label: "Вимкнено", hint: "Збору немає. Нічого не шукаємо й нічого не пишемо." },
  { key: "dry", label: "Пробний", hint: "Збираємо переможців і рахуємо статистику, але в Kommo нічого не пишемо." },
  { key: "live", label: "Бойовий", hint: "Нові переможці щоранку йдуть у Kommo на вибраного лідогена." },
];
const field = { display: "grid", gap: 4, fontSize: 13, fontWeight: 600 } as const;
const inp = { padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", maxWidth: 320 } as const;
const hintS = { fontSize: 11.5, fontWeight: 400, color: "var(--text-muted)" } as const;

const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const plusDay = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const uahS = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} ₴`;

/**
 * «Що буде далі» — людською мовою з ФОРМИ (тобто з незбереженими змінами теж) і живої готовності з сервера.
 * Сама нічого не вирішує: ті самі правила виконує джоба (`jobs/prozorroLeads.ts`).
 */
export function whatNext(c: PzConfigT, v: ProzorroSettingsResp): { tone: "ok" | "warn" | "off"; lines: string[] } {
  const r = v.readiness;
  const when = `${dmy(r.nextRun.date)} о ${r.nextRun.time}`;
  const who = v.options.find((o) => o.id === c.responsibleManagerId)?.name ?? null;
  const lines: string[] = [];
  if (c.mode === "off") return { tone: "off", lines: ["Збір вимкнено — вранці нічого не відбудеться: ні пошуку, ні записів у Kommo."] };
  lines.push(`Наступний збір: ${when}.`);
  if (!r.baselineDone) lines.push(`Це буде перший збір — точка відліку: лише запамʼятаємо наявні тендери, лідів не буде. Перші ліди — ${dmy(plusDay(r.nextRun.date))} о ${r.nextRun.time}.`);
  const avg = r.avgFoundPerDay != null ? `зараз знаходимо ~${String(r.avgFoundPerDay)} на день` : "за заміром — ~28 на день при 500 000 ₴";
  if (c.mode === "dry") {
    lines.push(`Режим пробний: переможців від ${uahS(c.minAmount)} лише рахуємо в статистиці (${avg}). У Kommo нічого не піде.`);
    return { tone: "ok", lines };
  }
  if (!who) {
    lines.push(c.responsibleManagerId == null ? "⚠️ Бойовий режим, але лідоген не вибраний — у Kommo нічого не піде, ліди чекатимуть."
      : "⚠️ Вибраний лідоген неактивний — у Kommo нічого не піде, доки не виберете іншого.");
    return { tone: "warn", lines };
  }
  if (!r.kommo.ok) {
    lines.push(`⚠️ У Kommo не все на місці: ${r.kommo.problems.join("; ")} — угоди не запишуться.`);
    return { tone: "warn", lines };
  }
  lines.push(`Режим бойовий: нові переможці від ${uahS(c.minAmount)} підуть у Kommo («Продзвін» → «Тендер AI», джерело «AI тендер») на ${who}, ${c.dailyLimit ? `не більше ${String(c.dailyLimit)} угод за ранок` : "без ліміту"} (${avg}).`);
  if (c.nichesOff.length) lines.push(`Не шукаємо: ${c.nichesOff.join(", ")}.`);
  return { tone: "ok", lines };
}

function Check({ state, title, text }: { state: "ok" | "wait" | "bad"; title: string; text: string }) {
  const col = state === "ok" ? "#16a34a" : state === "wait" ? "#b45309" : "#b3261e";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0,1fr)", gap: 8, alignItems: "start", fontSize: 13, padding: "4px 0" }}>
      <span style={{ color: col, fontWeight: 700 }}>{state === "ok" ? "✓" : state === "wait" ? "⏳" : "✗"}</span>
      <span><b>{title}</b> — <span style={{ color: state === "bad" ? col : "var(--text-muted)" }}>{text}</span></span>
    </div>
  );
}

/**
 * Текст підтвердження зміни режиму (Роман 23.10.2026: «коли змінюєш режим — вікно „ви дійсно впевнені“, так чи ні»).
 * Кожен перехід питає окремо й каже, ЩО зміниться; уже створених угод не чіпає жоден режим.
 */
export function modeConfirm(target: PzModeT, c: PzConfigT, whoName: string | null, time: string, otherChanges: boolean):
  { title: string; text: string; okLabel: string; danger: boolean } {
  const label = MODE_UI.find((m) => m.key === target)!.label;
  const tail = otherChanges ? " Разом із режимом збережуться й інші зміни на цій вкладці." : "";
  const text = target === "live"
    ? `Щоранку о ${time} нові переможці тендерів від ${uahS(c.minAmount)} підуть у Kommo («Продзвін» → «Тендер AI») на ${whoName ?? "— лідоген не вибраний: у Kommo нічого не піде, доки його не виберете —"}, ${c.dailyLimit ? `не більше ${String(c.dailyLimit)} угод за ранок` : "без ліміту"}. Наявних угод, компаній і контактів у Kommo це не змінює.`
    : target === "dry"
      ? "Збір і статистика тривають, але нові переможці більше НЕ йдуть у Kommo. Уже створені угоди лишаються, як є."
      : "Вранці нічого не шукаємо й нічого не пишемо в Kommo, статистика зупиниться. Уже створені угоди лишаються, як є.";
  return { title: `Ви дійсно хочете змінити режим на «${label}»?`, text: text + tail, okLabel: "Так, змінити", danger: target === "off" };
}

function SettingsTab({ view, onSave }: { view: ProzorroSettingsResp; onSave: (c: PzConfigT) => Promise<void> }) {
  const dialogs = useDialogs();
  const [c, setC] = useState<PzConfigT>(view.config);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setC(view.config); }, [view]);
  const changed = JSON.stringify(c) !== JSON.stringify(view.config);
  const liveNoOne = c.mode === "live" && c.responsibleManagerId == null;
  const cur = view.responsible;
  const curMissing = c.responsibleManagerId != null && !view.options.some((o) => o.id === c.responsibleManagerId);
  const r = view.readiness;
  const next = whatNext(c, view);
  const whoName = view.options.find((o) => o.id === c.responsibleManagerId)?.name ?? null;
  const save = async (cfg: PzConfigT = c) => {
    setBusy(true); setMsg(null);
    try { await onSave(cfg); setMsg({ ok: true, text: "Збережено. Діє з наступного ранкового збору (06:05)." }); }
    catch (e) { setMsg({ ok: false, text: hiringError(e) }); }
    setBusy(false);
  };
  /** Зміна режиму — ЗАВЖДИ через «Ви дійсно хочете…?»; «Так» — режим змінено й одразу збережено, «Скасувати» — нічого. */
  const changeMode = async (target: PzModeT) => {
    if (target === c.mode) return;
    const yes = await dialogs.confirm(modeConfirm(target, c, whoName, r.nextRun.time, changed));
    if (!yes) return;
    const nextCfg = { ...c, mode: target };
    setC(nextCfg);
    await save(nextCfg);
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="chart-card" style={{ borderLeft: `4px solid ${next.tone === "ok" ? "#16a34a" : next.tone === "warn" ? "#b3261e" : "var(--border)"}` }}>
        <h2 className="chart-title">Що буде далі{changed ? " (з урахуванням незбережених змін)" : ""}</h2>
        {next.lines.map((l, i) => <div key={i} style={{ fontSize: 13.5, padding: "2px 0", color: l.startsWith("⚠️") ? "#b3261e" : undefined }}>{l}</div>)}
      </div>

      <div className="chart-card">
        <h2 className="chart-title">Перевірка готовності</h2>
        <Check state={r.lastRun.error ? "bad" : r.lastRun.at ? "ok" : "wait"} title="Prozorro"
          text={r.lastRun.error ? `останній збір упав: ${r.lastRun.error}` : r.lastRun.at ? `останній збір ${fmtAt(r.lastRun.at)} — без помилок` : `ще не запускався — перший збір ${dmy(r.nextRun.date)} о ${r.nextRun.time}`} />
        <Check state={whoName ? "ok" : c.mode === "live" ? "bad" : "wait"} title="Лідоген"
          text={whoName ? `${whoName} — активний, має акаунт Kommo` : c.responsibleManagerId == null ? "не вибраний" : "вибраний лідоген неактивний — виберіть іншого"} />
        <Check state={r.kommo.ok ? "ok" : "bad"} title="Kommo"
          text={r.kommo.ok ? "етап «Тендер AI» у «Продзвоні» і джерело «AI тендер» на місці" : r.kommo.problems.join("; ")} />
        <Check state={r.baselineDone ? "ok" : "wait"} title="Точка відліку"
          text={r.baselineDone && r.baselineAt ? `пройдено ${fmtAt(r.baselineAt)} — далі беремо лише нових переможців` : `буде ${dmy(r.nextRun.date)} о ${r.nextRun.time}; перші ліди — наступного ранку`} />
      </div>

      <div className="chart-card">
        <h2 className="chart-title">Робота</h2>
        <div style={{ display: "grid", gap: 16 }}>
          <div style={field}>Режим
            <div className="cl-tabs" style={{ width: "fit-content" }}>
              {MODE_UI.map((m) => <button key={m.key} type="button" className="cl-tab" aria-pressed={c.mode === m.key} disabled={busy} onClick={() => void changeMode(m.key)}>{m.label}</button>)}
            </div>
            <span style={hintS}>{MODE_UI.find((m) => m.key === c.mode)!.hint} Зміна режиму — лише після підтвердження і зберігається одразу.</span>
          </div>
          <label style={field}>Хто веде тендерні ліди
            <select value={c.responsibleManagerId ?? ""} onChange={(e) => setC({ ...c, responsibleManagerId: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— не вибрано —</option>
              {curMissing && cur && <option value={c.responsibleManagerId!}>{cur.name} (неактивний — виберіть іншого)</option>}
              {view.options.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.team}</option>)}
            </select>
            <span style={hintS}>Один лідоген. Список — активні лідогени з акаунтом Kommo.</span>
          </label>
          {view.options.length === 0 && <div style={{ color: "#b3261e", fontSize: 13 }}>Активних лідогенів з акаунтом Kommo не знайдено — вибрати нікого.</div>}
          {liveNoOne && <div style={{ color: "#b3261e", fontSize: 13 }}>Бойовий режим без лідогена: ліди збиратимуться, але в Kommo не підуть, доки когось не виберете.</div>}
          <div style={{ fontSize: 13 }}>
            Записано в Kommo: <b>{view.queue.pushed}</b> · чекають запису: <b>{view.queue.waiting}</b>
            {view.queue.exhausted > 0 && <span style={{ color: "#b3261e" }}> · не вдалось після 3 спроб: {view.queue.exhausted}</span>}
            {view.queue.dryCollected > 0 && <span style={{ color: "var(--text-muted)" }}> · зібрано в пробному режимі (у Kommo не йдуть): {view.queue.dryCollected}</span>}
          </div>
        </div>
      </div>

      <div className="chart-card">
        <h2 className="chart-title">Ліміти</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
          <label style={field}>Мінімальна сума тендера, ₴
            <input type="number" min={0} step={50000} value={c.minAmount} onChange={(e) => setC({ ...c, minAmount: Number(e.target.value) || 0 })} style={inp} />
            <span style={hintS}>Менші тендери не стають лідами. За заміром 21.10: 500 000 ₴ — ~28 лідів на день, 200 000 — ~57, 100 000 — ~90.</span>
          </label>
          <label style={field}>Ліміт нових угод у Kommo на день
            <input type="number" min={1} max={500} placeholder="без ліміту" value={c.dailyLimit ?? ""}
              onChange={(e) => setC({ ...c, dailyLimit: e.target.value ? Math.trunc(Number(e.target.value)) : null })} style={inp} />
            <span style={hintS}>Що понад ліміт — чекає наступного дня, нічого не губиться. Порожньо — без ліміту.</span>
          </label>
        </div>
      </div>

      <div className="chart-card">
        <h2 className="chart-title">Ніші</h2>
        <div style={{ ...hintS, marginBottom: 8 }}>Вимкнена ніша не шукається. Слова кожної ніші — з ТЗ.</div>
        <table className="data-table">
          <thead><tr><th>Ніша</th><th style={{ textAlign: "right" }}>Слів</th><th style={{ textAlign: "right" }}>Лідів за 30 днів</th><th style={{ textAlign: "center" }}>Шукати</th></tr></thead>
          <tbody>
            {view.niches.map((n) => {
              const on = !c.nichesOff.includes(n.name);
              return (
                <tr key={n.name}>
                  <td style={{ color: on ? undefined : "var(--text-muted)" }}>{n.name}</td>
                  <td style={{ textAlign: "right" }}>{n.words}</td>
                  <td style={{ textAlign: "right" }}>{n.leads30d}</td>
                  <td style={{ textAlign: "center" }}><input type="checkbox" checked={on} aria-label={`Шукати: ${n.name}`}
                    onChange={() => setC({ ...c, nichesOff: on ? [...c.nichesOff, n.name].sort() : c.nichesOff.filter((x) => x !== n.name) })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="hr-btn p" disabled={busy || !changed} onClick={() => void save()}>{busy ? "Збереження…" : "Зберегти"}</button>
        {msg ? <span style={{ fontSize: 13, color: msg.ok ? "#16a34a" : "#b3261e" }}>{msg.text}</span>
          : changed && <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Є незбережені зміни.</span>}
      </div>

      <div className="chart-card">
        <h2 className="chart-title">Історія змін</h2>
        {view.history.length === 0
          ? <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Ще не змінювали — діють початкові: пробний режим, лідоген не вибраний, 500 000 ₴, без ліміту, усі ніші.</div>
          : view.history.map((h, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "2px 0" }}>
              {fmtAt(h.setAt)} · {h.setByName ?? "невідомо хто"} · {h.field}: {h.oldValue ?? "—"} → {h.newValue ?? "—"}
            </div>
          ))}
      </div>
    </div>
  );
}
