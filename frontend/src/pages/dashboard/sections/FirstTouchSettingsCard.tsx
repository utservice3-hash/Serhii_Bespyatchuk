import { useEffect, useState } from "react";
import { fetchFirstTouchSettings, saveFirstTouchSettings, hiringError, type FirstTouchSettingsResp, type FirstTouchTunablesT } from "../../../api";

/**
 * 🎛 «ПЕРШИЙ ДОТИК» У НАЛАШТУВАННЯХ (05.10.2026, лише адмін). Старт — поточна поведінка; рекомендовані значення
 * лише підписані поруч: ставить їх людина після погодження з Сергієм. Сервер перевіряє межі й право сам.
 */
const inp = { display: "block", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", width: 140,
  background: "var(--card-bg)", color: "var(--text)" } as const;
const hint = { display: "block", marginTop: 4, fontSize: 11, fontWeight: 400, color: "var(--text-muted)" } as const;
const fmt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const describe = (t: FirstTouchTunablesT) =>
  `вікно ${t.repeatWindowDays == null ? "без обмеження" : `${String(t.repeatWindowDays)} дн.`} · допуск ${String(t.callbackGraceMin)} хв · мінімум ${String(t.callbackMinDeadlineMin)} хв · блок ${t.bannerTone === "alert" ? "червоний" : "сірий"}`;

export function FirstTouchSettingsCard() {
  const [d, setD] = useState<FirstTouchSettingsResp | null>(null);
  const [form, setForm] = useState<FirstTouchTunablesT | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetchFirstTouchSettings().then((x) => { setD(x); setForm(x.current); }).catch((e) => setMsg({ ok: false, text: hiringError(e) }));
  }, []);
  if (!d || !form) return msg ? <div className="chart-card" style={{ marginTop: 16, color: "var(--danger, #b3261e)" }}>{msg.text}</div> : null;
  const num = (v: string): number => Number(v.trim() === "" ? NaN : v);
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await saveFirstTouchSettings(form); setD({ ...d, current: r.current, history: r.history }); setForm(r.current); setMsg({ ok: true, text: "Збережено. Діє з наступного оновлення екрана." }); }
    catch (e) { setMsg({ ok: false, text: hiringError(e) }); }
    setBusy(false);
  };
  const changed = JSON.stringify(form) !== JSON.stringify(d.current);
  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h2 className="chart-title">Перший дотик · AI</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px", maxWidth: 820 }}>
        Зміна діє на всі розмови, і на вже розібрані теж: статуси передзвону рахуються під час показу, тож зсунуться й минулі тижні звіту тімліда.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 }}>
        <label htmlFor="ft-window" style={{ fontSize: 13, fontWeight: 600 }}>Вікно повторного дзвінка, днів
          <input id="ft-window" type="number" min={d.bounds.repeatWindowDays.min} max={d.bounds.repeatWindowDays.max} placeholder="без обмеження"
            value={form.repeatWindowDays ?? ""} onChange={(e) => setForm({ ...form, repeatWindowDays: e.target.value.trim() === "" ? null : num(e.target.value) })} style={inp} />
          <span style={hint}>Розмова не аналізується як повторна, лише якщо попередня з цим номером була не раніше ніж за стільки днів. Порожньо — без обмеження (як зараз). Рекомендовано: {d.recommended.repeatWindowDays}.</span>
        </label>
        <label htmlFor="ft-grace" style={{ fontSize: 13, fontWeight: 600 }}>Допуск на передзвін, хв
          <input id="ft-grace" type="number" min={d.bounds.callbackGraceMin.min} max={d.bounds.callbackGraceMin.max}
            value={Number.isFinite(form.callbackGraceMin) ? form.callbackGraceMin : ""} onChange={(e) => setForm({ ...form, callbackGraceMin: num(e.target.value) })} style={inp} />
          <span style={hint}>Скільки хвилин після обіцяного часу передзвін ще «вчасно». 0 — як зараз. Рекомендовано: {d.recommended.callbackGraceMin}.</span>
        </label>
        <label htmlFor="ft-min" style={{ fontSize: 13, fontWeight: 600 }}>Мінімальний дедлайн, хв
          <input id="ft-min" type="number" min={d.bounds.callbackMinDeadlineMin.min} max={d.bounds.callbackMinDeadlineMin.max}
            value={Number.isFinite(form.callbackMinDeadlineMin) ? form.callbackMinDeadlineMin : ""} onChange={(e) => setForm({ ...form, callbackMinDeadlineMin: num(e.target.value) })} style={inp} />
          <span style={hint}>Пообіцяв «дві хвилини» — дедлайн однаково не коротший за це. Лише для обіцянок у хвилинах. 0 — як зараз. Рекомендовано: {d.recommended.callbackMinDeadlineMin}.</span>
        </label>
        <label htmlFor="ft-tone" style={{ fontSize: 13, fontWeight: 600 }}>Колір блоку «дзвінка в телефонії немає»
          <select id="ft-tone" value={form.bannerTone} onChange={(e) => setForm({ ...form, bannerTone: e.target.value === "alert" ? "alert" : "neutral" })} style={inp}>
            <option value="neutral">сірий</option>
            <option value="alert">червоний</option>
          </select>
          <span style={hint}>Змінюється лише колір, заголовок той самий. Червоний — коли хибні «не передзвонив» розібрано.</span>
        </label>
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void save()} disabled={busy || !changed} className="hr-btn p">{busy ? "Збереження…" : "Зберегти"}</button>
        {msg && <span style={{ color: msg.ok ? "#16a34a" : "var(--danger, #b3261e)", fontSize: 13 }}>{msg.text}</span>}
      </div>
      <div style={{ marginTop: 14, fontSize: 12.5 }}>
        <b>Історія змін</b>
        {d.history.length === 0
          ? <div style={{ color: "var(--text-muted)" }}>Ще не змінювали — діє поточна поведінка ({describe(d.current)}).</div>
          : d.history.map((h, i) => <div key={i} style={{ color: "var(--text-muted)" }}>{fmt(h.setAt)} · {h.setByName ?? "невідомо хто"} · {describe(h)}</div>)}
      </div>
    </div>
  );
}
