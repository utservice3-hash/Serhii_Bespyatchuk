import { useEffect, useState } from "react";
import { fetchProzorroSettings, saveProzorroSettings, hiringError, type ProzorroSettingsResp } from "../../../api";

/**
 * 🏛 PROZORRO-ЛІДИ У НАЛАШТУВАННЯХ (задача #5299, прохід 2; лише адмін). Хто веде тендерні ліди — ОДИН лідоген
 * (Роман 22.10.2026). Не вибрано або неактивний — джоба нічого не пише в Kommo, ліди чекають (лічильник нижче).
 * Режим і стеля — лише показуються: їх міняють змінними на сервері.
 */
const inp = { display: "block", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", minWidth: 260,
  background: "var(--card-bg)", color: "var(--text)" } as const;
const fmt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const MODE_UA: Record<ProzorroSettingsResp["mode"], string> = {
  off: "вимкнено — збору немає",
  dry: "пробний — збираємо, у Kommo нічого не пишемо",
  live: "бойовий — нові переможці йдуть у Kommo",
};

export function ProzorroSettingsCard() {
  const [d, setD] = useState<ProzorroSettingsResp | null>(null);
  const [pick, setPick] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetchProzorroSettings().then((x) => { setD(x); setPick(x.current ? String(x.current.managerId) : ""); })
      .catch((e) => setMsg({ ok: false, text: hiringError(e) }));
  }, []);
  if (!d) return msg ? <div className="chart-card" style={{ marginTop: 16, color: "var(--danger, #b3261e)" }}>{msg.text}</div> : null;
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const r = await saveProzorroSettings(pick === "" ? null : Number(pick)); setD(r); setPick(r.current ? String(r.current.managerId) : ""); setMsg({ ok: true, text: "Збережено. Діє з наступного проходу (щодня о 06:05)." }); }
    catch (e) { setMsg({ ok: false, text: hiringError(e) }); }
    setBusy(false);
  };
  const changed = pick !== (d.current ? String(d.current.managerId) : "");
  const cur = d.current;
  const curInOptions = cur ? d.options.some((o) => o.id === cur.managerId) : false;
  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <h2 className="chart-title">Тендерні ліди (Prozorro)</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 12px", maxWidth: 820 }}>
        Переможці тендерів від {d.minAmount.toLocaleString("uk-UA")} ₴ щодня йдуть у Kommo: воронка «Продзвін», етап «Тендер AI», джерело «AI тендер».
        Веде їх один лідоген — виберіть його тут.
      </p>
      <label htmlFor="pz-resp" style={{ fontSize: 13, fontWeight: 600 }}>Хто веде тендерні ліди
        <select id="pz-resp" value={pick} onChange={(e) => setPick(e.target.value)} style={inp}>
          <option value="">— не вибрано (ліди чекають) —</option>
          {cur && !curInOptions && <option value={String(cur.managerId)}>{cur.name} (неактивний — виберіть іншого)</option>}
          {d.options.map((o) => <option key={o.id} value={String(o.id)}>{o.name} · {o.team}</option>)}
        </select>
      </label>
      {d.options.length === 0 && <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--danger, #b3261e)" }}>Активних лідогенів з акаунтом Kommo не знайдено — вибрати нікого.</div>}
      <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void save()} disabled={busy || !changed} className="hr-btn p">{busy ? "Збереження…" : "Зберегти"}</button>
        {msg && <span style={{ color: msg.ok ? "#16a34a" : "var(--danger, #b3261e)", fontSize: 13 }}>{msg.text}</span>}
      </div>
      <div style={{ marginTop: 14, fontSize: 13, display: "grid", gap: 4 }}>
        <div><b>Режим:</b> {MODE_UA[d.mode]}{d.mode === "live" ? ` · не більше ${String(d.pushLimit)} угод за прохід` : ""}</div>
        <div><b>Записано в Kommo:</b> {d.queue.pushed} · <b>чекають запису:</b> {d.queue.waiting}
          {d.queue.exhausted > 0 && <span style={{ color: "var(--danger, #b3261e)" }}> · не вдалось після 3 спроб: {d.queue.exhausted}</span>}
          {d.queue.dryCollected > 0 && <span style={{ color: "var(--text-muted)" }}> · зібрано в пробному режимі (у Kommo не йдуть): {d.queue.dryCollected}</span>}
        </div>
        {d.mode === "live" && !cur && d.queue.waiting > 0 && <div style={{ color: "var(--danger, #b3261e)" }}>Лідоген не вибраний — {d.queue.waiting} лідів не потрапляють у Kommo.</div>}
      </div>
      <div style={{ marginTop: 14, fontSize: 12.5 }}>
        <b>Історія змін</b>
        {d.history.length === 0
          ? <div style={{ color: "var(--text-muted)" }}>Ще не вибирали.</div>
          : d.history.map((h, i) => <div key={i} style={{ color: "var(--text-muted)" }}>{fmt(h.setAt)} · {h.setByName ?? "невідомо хто"} · {h.oldName ?? "не вибрано"} → {h.newName ?? "не вибрано"}</div>)}
      </div>
    </div>
  );
}
