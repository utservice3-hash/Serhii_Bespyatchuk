/**
 * 💳 «Виписка» — розшифровка вихідних ФОП і картки (задача Тетяни 03.11.2026). Під платежем — рядок стану; клік —
 * блок «Розшифровка платежу»: рядки «№ угоди / № операційного запиту / категорія — сума» (угода — з назвою й менеджером), «Розписано X з Y», «Скопіювати»,
 * «Змінити» (з причиною → «Відкориговані»), історія. Правила рахує сервер (`backend/src/bankIdent/outBreakdown.ts`);
 * тут лише показ і живий підрахунок суми під час введення (підказка, не рішення).
 */
import { useEffect, useState } from "react";
import { outApi, outErr, type OutEvent, type OutFilter, type OutLineView, type OutState } from "./outBreakdownApi";

const MUTED = "var(--text-muted)";
export const OUT_CORRECTED_COLOR = "#7c3aed";
const fmt = (n: number) => {
  const [i, d] = Math.abs(n).toFixed(2).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (d === "00" ? "" : "," + d) + " ₴";
};
const amountOf = (s: string) => {
  const t = s.replace(/(грн\.?|uah|₴)/gi, "").replace(/[\s\u00a0]/g, "").replace(",", ".");
  return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) > 0 ? Number(t) : NaN;
};
/** Підказка під полем: скільки рядків і яка сума розпізнались. Ті самі три види, що на сервері (`parseLine`); рішення — за сервером. */
function liveSum(text: string): { lines: number; sum: number; bad: number } {
  let lines = 0, sum = 0, bad = 0;
  for (const raw of text.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean)) {
    const body = raw.replace(/\s*\([^()]{0,120}\)\s*$/, "").trim();
    const n = /^(\d{1,9})\s*(?:[-–—:=\t]\s*)?(.+)$/.exec(body);
    const t = /^(.*?\p{L}.*?)\s*(?:[-–—:=\t]\s*)?(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?\s*(?:грн\.?|uah|₴)?)$/iu.exec(body);
    const a = n && Number.isFinite(amountOf(n[2])) ? amountOf(n[2]) : t ? amountOf(t[2]) : NaN;
    if (Number.isFinite(a)) { lines++; sum += a; } else bad++;
  }
  return { lines, sum: Math.round(sum * 100) / 100, bad };
}
const KIND_TAG: Record<OutLineView["kind"], string> = { deal: "угода", op: "опер. запит", text: "категорія" };

const FILTERS: Array<[OutFilter, string]> = [["all", "Усі"], ["ok", "З номером"], ["wait", "Чекають"], ["unidentified", "Неідентифіковані"], ["corrected", "Відкориговані"]];

export function OutFilterBar({ counts, value, onChange }: { counts: Record<OutFilter, number> | null; value: OutFilter; onChange: (v: OutFilter) => void }) {
  return (
    <div role="group" aria-label="Розшифровка вихідних" style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
      {FILTERS.map(([k, l]) => {
        const on = value === k;
        return (
          <button key={k} type="button" aria-pressed={on} onClick={() => onChange(k)} style={{
            padding: "5px 10px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            border: `1px solid ${on ? (k === "corrected" ? OUT_CORRECTED_COLOR : "var(--accent, #2f6fdb)") : "var(--border)"}`,
            background: on ? (k === "corrected" ? "rgba(124,58,237,0.12)" : "rgba(47,111,219,0.12)") : "transparent", color: "inherit",
          }}>
            {l}{counts && k !== "all" ? <span style={{ marginLeft: 5, color: MUTED, fontWeight: 700 }}>{counts[k]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Підсумок під платежем (без розгортання). */
function summaryOf(s: OutState): { icon: string; text: string; color: string } {
  if (s.status === "own") return { icon: "↔", text: "свій переказ — розшифровка не потрібна", color: MUTED };
  if (s.status === "wait") return { icon: "🧾", text: "Чекає розшифровки", color: "#b45309" };
  if (s.status === "unidentified") return { icon: "❓", text: `Неідентифікований${s.reason ? ` · ${s.reason}` : ""}`, color: "#dc2626" };
  const n = s.lines.length, word = n === 1 ? "рядок" : n < 5 ? "рядки" : "рядків";
  if (s.status === "mismatch") {
    const diff = Math.round((s.amount - s.sum) * 100) / 100;
    return { icon: "⚠", text: `${n} ${word} · розписано ${fmt(s.sum)} з ${fmt(s.amount)} — ${diff > 0 ? `бракує ${fmt(diff)}` : `зайве ${fmt(-diff)}`}`, color: "#dc2626" };
  }
  return { icon: "✅", text: `${n} ${word} · ${fmt(s.sum)} з ${fmt(s.amount)}`, color: "#16a34a" };
}

export function OutLine({ state, canEdit, onChange }: { state: OutState; canEdit: boolean; onChange: (s: OutState) => void }) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(state.text);
  const [reason, setReason] = useState("");
  const [unid, setUnid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hist, setHist] = useState<OutEvent[] | null>(null);
  useEffect(() => { if (!edit) setText(state.text); }, [state.text, edit]);
  if (state.status === "own") {
    return <div style={{ marginTop: 5, fontSize: 12, color: MUTED }}>↔ свій переказ — розшифровка не потрібна</div>;
  }
  const sm = summaryOf(state);
  const existing = state.status !== "wait";
  const live = liveSum(text);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const s = unid ? await outApi.unidentify(state.txId, reason) : await outApi.save(state.txId, text, existing ? reason : undefined);
      onChange(s); setEdit(false); setUnid(false); setReason(""); setHist(null);
    } catch (e) { setErr(outErr(e)); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(state.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setErr("Не вдалося скопіювати — виділіть текст вручну."); }
  };
  const btn = { padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" } as const;
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: 0, border: 0, background: "transparent", color: sm.color, fontSize: 12.5, fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
        <span>{sm.icon}</span><span>{sm.text}</span>
        {state.corrected && <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 6, background: "rgba(124,58,237,0.14)", color: OUT_CORRECTED_COLOR }}>змінено</span>}
        <span style={{ color: MUTED, fontWeight: 400 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-subtle, rgba(127,127,127,0.04))" }}>
          {!edit && state.lines.length > 0 && (
            <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
              <tbody>
                {state.lines.map((l) => (
                  <tr key={`${l.kind}:${l.ref}`} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "4px 6px 4px 0", fontFamily: l.kind === "text" ? "inherit" : "var(--mono, monospace)", whiteSpace: "nowrap" }}>
                      {l.ref} <span style={{ fontFamily: "inherit", fontSize: 10.5, color: MUTED }}>{KIND_TAG[l.kind]}</span>
                    </td>
                    <td style={{ padding: "4px 6px", color: l.known ? "inherit" : "#b45309" }}>
                      {l.kind !== "deal" ? null : l.known ? (l.name || "без назви") : "угоди немає в базі дашборда — перевірте №"}
                      {l.manager ? <span style={{ color: MUTED }}> · {l.manager}</span> : null}
                      {l.note ? <span style={{ color: MUTED }}>{l.kind === "deal" ? " · " : ""}{l.note}</span> : null}
                    </td>
                    <td style={{ padding: "4px 0", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>{fmt(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!edit && state.by && <div style={{ marginTop: 6, fontSize: 11.5, color: MUTED }}>{state.by}{state.at ? ` · ${new Date(state.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" })}` : ""}{state.reason ? ` · причина: ${state.reason}` : ""}</div>}
          {!edit && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {state.lines.length > 0 && <button type="button" style={btn} onClick={() => void copy()}>{copied ? "✓ Скопійовано" : "📋 Скопіювати"}</button>}
              {canEdit && <button type="button" style={{ ...btn, borderColor: existing ? OUT_CORRECTED_COLOR : "var(--border)" }} onClick={() => { setEdit(true); setUnid(false); setErr(null); }}>{existing ? "✏ Змінити" : "＋ Розписати"}</button>}
              {canEdit && state.status !== "unidentified" && <button type="button" style={btn} onClick={() => { setEdit(true); setUnid(true); setErr(null); }}>❓ Неідентифікований</button>}
              <button type="button" style={{ ...btn, color: MUTED }} onClick={() => void outApi.history(state.txId).then(setHist).catch((e) => setErr(outErr(e)))}>Історія</button>
            </div>
          )}
          {edit && (
            <div>
              {!unid && (
                <>
                  <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Рядками «№ угоди сума» (62788851 3000), «№ операційного запиту сума» (4445 5000) або «категорія сума» (зп 20000); у дужках — примітка</label>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
                    placeholder={"62788851 3000\n4445 5000 (Операційний запит)\nзп 20000"} style={{ width: "100%", boxSizing: "border-box", fontFamily: "var(--mono, monospace)", fontSize: 13, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg, #fff)", color: "inherit" }} />
                  <div style={{ fontSize: 12, marginTop: 3, color: Math.abs(live.sum - state.amount) < 0.005 && !live.bad ? "#16a34a" : "#b45309" }}>
                    Розписано {fmt(live.sum)} з {fmt(state.amount)} · рядків {live.lines}{live.bad ? ` · не розпізнано ${live.bad}` : ""}
                  </div>
                </>
              )}
              {(existing || unid) && (
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={unid ? "Причина: чому не можна розписати" : "Причина зміни (обовʼязково)"}
                  style={{ width: "100%", boxSizing: "border-box", marginTop: 6, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg, #fff)", color: "inherit", fontSize: 12.5 }} />
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button type="button" disabled={busy} onClick={() => void save()} style={{ ...btn, background: "#2f6fdb", borderColor: "#2f6fdb", color: "#fff" }}>{busy ? "Зберігаю…" : unid ? "Позначити неідентифікованим" : "Зберегти"}</button>
                <button type="button" disabled={busy} style={btn} onClick={() => { setEdit(false); setUnid(false); setErr(null); setText(state.text); }}>Скасувати</button>
              </div>
            </div>
          )}
          {err && <div style={{ marginTop: 6, fontSize: 12, color: "#dc2626", fontWeight: 600 }}>{err}</div>}
          {hist && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: MUTED }}>
              {hist.length === 0 ? "Історії ще немає." : hist.map((h) => (
                <div key={h.id} style={{ padding: "3px 0", borderTop: "1px dashed var(--border)" }}>
                  {new Date(h.at).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" })} · {h.by ?? "—"} · {h.act === "set" ? "розписано" : h.act === "change" ? "змінено" : "неідентифікований"}
                  {h.linesAfter.length ? ` · ${h.linesAfter.map((l) => `${l.ref} ${l.amount}`).join(", ")}` : ""}{h.reason ? ` · причина: ${h.reason}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
