import { useState } from "react";
import { setClientSeasonal } from "../../../api";

/**
 * 🌙 СЕЗОННИЙ КЛІЄНТ — КНОПКА КВП У КАРТЦІ (задача 8351, ТЗ Юлі 06.11; Роман 10.11 «роби»).
 * КВП ставить позначку, місяці, коли клієнт возить, і примітку. Поза цими місяцями клієнт не сплячий, не в реактивації
 * і не «Немає роботи» — правило на сервері (`reactivationRules.offSeason`), тут лише ввід. Право віддає сервер (`canSeason`).
 */
export const MONTHS_SHORT = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
export const monthsLabel = (m: readonly number[]) => m.map((x) => MONTHS_SHORT[x - 1]).join(", ");

export function ClientSeasonBlock({ clientKey, seasonal, months, note, offSeason, onSaved }: {
  clientKey: string; seasonal: boolean; months: number[]; note: string | null; offSeason: boolean; onSaved: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState<number[]>(months);
  const [text, setText] = useState(note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (on: boolean) => {
    setBusy(true); setErr(null);
    try { await setClientSeasonal({ clientKey, seasonal: on, months: on ? pick : [], note: on ? text.trim() : "" }); setEdit(false); onSaved(); }
    catch (e) { setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? "Не збережено: сервер відмовив."); }
    finally { setBusy(false); }
  };
  const btn = (bg: string) => ({ fontSize: 12, padding: "5px 11px", borderRadius: 8, border: "none", background: bg, color: "#fff", cursor: "pointer" } as const);
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {!edit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {seasonal && months.length > 0
            ? <span style={{ fontSize: 12 }}>🌙 <b>Сезонний</b>: возить {monthsLabel(months)}{note ? ` · «${note}»` : ""} — {offSeason ? "зараз не сезон: не сплячий і не в реактивації" : "зараз сезон, правила звичайні"}</span>
            : seasonal
              ? <span style={{ fontSize: 12, color: "#b45309" }}>🌙 Позначений сезонним, але місяців немає — позначка не діє. Вкажіть місяці.</span>
              : <span style={{ fontSize: 11, color: "#6b7280" }}>Сезонний клієнт (возить лише в певні місяці) у міжсезоння не падатиме в сплячі.</span>}
          <button type="button" disabled={busy} style={btn("#4338ca")} onClick={() => { setPick(months); setText(note ?? ""); setEdit(true); }}>
            🌙 {seasonal ? "змінити сезон" : "сезонний клієнт"}
          </button>
          {seasonal && <button type="button" disabled={busy} style={btn("#6b7280")} onClick={() => void save(false)}>зняти позначку</button>}
        </div>
      )}
      {edit && (
        <div style={{ border: "1px solid #c7d2fe", borderRadius: 8, padding: 10, background: "#eef2ff", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Місяці, коли клієнт возить:</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {MONTHS_SHORT.map((m, i) => {
              const on = pick.includes(i + 1);
              return (
                <button key={m} type="button" aria-pressed={on}
                  onClick={() => setPick((p) => (on ? p.filter((x) => x !== i + 1) : [...p, i + 1].sort((a, b) => a - b)))}
                  style={{ fontSize: 12, padding: "4px 9px", borderRadius: 999, cursor: "pointer", border: `1px solid ${on ? "#4338ca" : "#d1d5db"}`, background: on ? "#4338ca" : "#fff", color: on ? "#fff" : "#374151" }}>
                  {m}
                </button>
              );
            })}
          </div>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="примітка: що возить, чому сезонний (необовʼязково)"
            style={{ fontSize: 12, padding: "5px 9px", border: "1px solid #d1d5db", borderRadius: 8 }} />
          {err && <div role="alert" style={{ fontSize: 12, color: "#b91c1c" }}>⚠️ {err}</div>}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" disabled={busy || pick.length === 0 || pick.length === 12} style={btn("#4338ca")} onClick={() => void save(true)}>Зберегти</button>
            <button type="button" disabled={busy} style={{ ...btn("#fff"), color: "#374151", border: "1px solid #d1d5db" }} onClick={() => { setEdit(false); setErr(null); }}>Скасувати</button>
          </div>
        </div>
      )}
    </div>
  );
}
