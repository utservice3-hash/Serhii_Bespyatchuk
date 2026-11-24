import { useState } from "react";
import { transferGonePlan, dropGonePlan, type PFGone, type PFManager, type PFTeam, type PFTransferEvent } from "../../../api";
import { splitEqually, transferAmount, transferReady, type TransferMode } from "../planTransferRule";

/**
 * 🔁 ПЛАН МЕНЕДЖЕРА, ЯКИЙ ПІШОВ (задача 10477). Три частини одного екрана:
 *  - `GonePool` - блок «не розподілено» над картками команди з кнопками «Передати» і «Зняти план»;
 *  - `PlanTransferDialog` - кому і скільки, порівну або вручну, увесь план або лише залишок;
 *  - `GoneCards` - картки тих, хто пішов, щоб було видно, куди подівся їхній план.
 * Передає і знімає лише КВП і адмін (`canTransfer` з сервера); решта бачить блок без кнопок.
 */
const GREEN = "#16a34a", AMBER = "#d97706", RED = "#dc2626", BLUE = "#2f6fdb", MUTED = "var(--text-muted)";
const fmt = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ");
const shortName = (n: string) => { const p = n.trim().split(/\s+/); return p[0] + (p[1] ? ` ${p[1][0]}.` : ""); };
const when = (at: string) => /^\d{4}-\d{2}-\d{2}/.test(at) ? `${at.slice(8, 10)}.${at.slice(5, 7)}${at.length > 10 ? ` ${at.slice(11, 16)}` : ""}` : at;
const explain = (e: unknown): string => {
  const r = (e as { response?: { status?: number; data?: { error?: unknown } } }).response;
  const raw = r?.data?.error;
  return typeof raw === "string" ? raw : r?.status ? `Сервер відмовив (код ${r.status}).` : "Не вдалося звʼязатися з сервером.";
};
const darkBtn: React.CSSProperties = { padding: "7px 13px", borderRadius: 9, border: "none", background: "var(--text)", color: "var(--card-bg)", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const lineBtn: React.CSSProperties = { padding: "7px 13px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card-bg)", color: MUTED, fontWeight: 700, fontSize: 13, cursor: "pointer" };

export function GonePool({ team, month, canTransfer, open, onChanged }: {
  team: PFTeam; month: string; canTransfer: boolean; open: boolean; onChanged: () => void;
}) {
  const gone = (team.gone ?? []).filter((g) => g.pool > 0);
  const history = team.history ?? [];
  const [dlg, setDlg] = useState<PFGone | null>(null);
  const [ask, setAsk] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (gone.length === 0 && history.length === 0) return null;

  const drop = async (g: PFGone) => {
    setBusy(true); setErr(null);
    try { await dropGonePlan({ month, fromManagerId: g.managerId }); setAsk(null); onChanged(); }
    catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  const teamPlan = team.managers.reduce((a, m) => a + m.currentPlan, 0) + (team.gonePlan ?? 0);

  return (
    <div style={{ marginTop: 12 }}>
      {gone.length > 0 ? (
        <div style={{ border: `1px solid ${AMBER}55`, borderLeft: `4px solid ${AMBER}`, borderRadius: 12, background: AMBER + "0f", padding: "13px 15px" }}>
          <div style={{ fontWeight: 750, fontSize: 15 }}>
            План менеджера, який пішов, не розподілено · <span style={{ color: AMBER }}>{fmt(team.unassigned ?? 0)} ₴</span>
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
            Ця сума входить у план команди, але ні на кому не лежить, поки КВП її не передасть або не зніме.
          </div>
          {gone.map((g) => (
            <div key={g.managerId} style={{ marginTop: 9, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <b>{g.name}</b> · <b>{fmt(g.pool)} ₴</b>
                  <div style={{ fontSize: 12, color: MUTED }}>факт за місяць {fmt(g.fact)} ₴ лишається в команді</div>
                </div>
                {canTransfer && open ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button style={darkBtn} onClick={() => { setErr(null); setDlg(g); }}>Передати</button>
                    <button style={lineBtn} onClick={() => { setErr(null); setAsk(g.managerId); }}>Зняти план</button>
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: MUTED }}>{canTransfer ? "місяць закрито - план не передається" : "передає КВП"}</span>
                )}
              </div>
              {ask === g.managerId && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 9, fontSize: 13 }}>
                  <span>Зняти <b>{fmt(g.pool)} ₴</b>? План команди стане <b>{fmt(teamPlan - g.pool)} ₴</b>.</span>
                  <button style={darkBtn} disabled={busy} onClick={() => drop(g)}>{busy ? "…" : "Так, зняти"}</button>
                  <button style={lineBtn} disabled={busy} onClick={() => setAsk(null)}>Ні</button>
                </div>
              )}
            </div>
          ))}
          {err && <div style={{ color: RED, fontSize: 13, marginTop: 8 }}>{err}</div>}
        </div>
      ) : (
        <div style={{ border: `1px solid ${GREEN}44`, borderLeft: `4px solid ${GREEN}`, borderRadius: 12, background: GREEN + "0d", padding: "10px 15px", fontSize: 13, fontWeight: 600, color: GREEN }}>
          ✓ План тих, хто пішов, розподілено або знято
        </div>
      )}
      <TransferHistory events={history} />
      {dlg && <PlanTransferDialog gone={dlg} roster={team.managers} month={month}
        onClose={() => setDlg(null)} onDone={() => { setDlg(null); onChanged(); }} />}
    </div>
  );
}

function TransferHistory({ events }: { events: PFTransferEvent[] }) {
  if (events.length === 0) return null;
  return (
    <details style={{ marginTop: 8, fontSize: 13 }}>
      <summary style={{ cursor: "pointer", color: BLUE, width: "max-content" }}>історія змін ({events.length})</summary>
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, marginTop: 8 }}>
        {events.map((e, i) => (
          <div key={e.batchId} style={{ padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none" }}>
            <span style={{ color: MUTED, marginRight: 8 }}>{when(e.at)}</span>
            <b>{e.by ?? "невідомо хто"}</b>{" · "}
            {e.kind === "drop"
              ? <>знято план {shortName(e.fromName)} {fmt(e.amount)} ₴</>
              : <>передано план {shortName(e.fromName)} {fmt(e.amount)} ₴: {e.parts.map((p) => `${shortName(p.name)} +${fmt(p.amount)}`).join(", ")}
                  {e.keep > 0 && <> · {fmt(e.keep)} ₴ лишено за ним як виконане</>}</>}
          </div>
        ))}
      </div>
    </details>
  );
}

export function PlanTransferDialog({ gone, roster, month, onClose, onDone }: {
  gone: PFGone; roster: PFManager[]; month: string; onClose: () => void; onDone: () => void;
}) {
  const [mode, setMode] = useState<TransferMode>("all");
  const [sel, setSel] = useState<number[]>([]);
  const [amounts, setAmounts] = useState<Record<number, number>>({});
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const total = transferAmount(gone.pool, gone.fact, mode);
  const rest = transferAmount(gone.pool, gone.fact, "rest");
  const equal = (ids: number[], sum: number) => { const parts = splitEqually(sum, ids.length); return Object.fromEntries(ids.map((id, i) => [id, parts[i]])); };
  const toggle = (id: number) => {
    const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    setSel(next);
    if (auto) setAmounts(equal(next, total));
    else setAmounts((a) => { const b = { ...a }; if (next.includes(id)) b[id] = b[id] ?? 0; else delete b[id]; return b; });
  };
  const pickMode = (m: TransferMode) => { setMode(m); if (auto) setAmounts(equal(sel, transferAmount(gone.pool, gone.fact, m))); };
  const list = sel.map((id) => amounts[id] ?? 0);
  const given = list.reduce((s, a) => s + a, 0);
  const diff = total - given;
  const ready = transferReady(total, list);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await transferGonePlan({ month, fromManagerId: gone.managerId, mode, parts: sel.map((id) => ({ managerId: id, amount: amounts[id] ?? 0 })) });
      onDone();
    } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  const seg = (m: TransferMode, label: string) => (
    <button onClick={() => pickMode(m)} style={{ border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 13.5, fontWeight: 600, cursor: "pointer",
      background: mode === m ? "var(--card-bg)" : "transparent", color: mode === m ? "var(--text)" : MUTED, boxShadow: mode === m ? "0 1px 3px rgba(20,30,50,.1)" : "none" }}>{label}</button>
  );
  const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 };
  const fact3 = (l: string, v: number) => (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px" }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: ".4px" }}>{l}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(v)} ₴</div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2600, background: "rgba(20,22,28,.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "28px 12px", overflow: "auto" }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Передати план менеджера, який пішов"
        style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 14, width: "100%", maxWidth: 640, boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <b style={{ fontSize: 17 }}>Передати план менеджера, який пішов</b>
          <button style={lineBtn} disabled={busy} onClick={onClose}>Закрити</button>
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div><div style={lbl}>Хто пішов · місяць</div><b>{gone.name}</b> · {month.slice(5, 7)}.{month.slice(0, 4)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {fact3("Не розподілено", gone.pool)}{fact3("Факт", gone.fact)}{fact3("Лишилось", rest)}
          </div>
          <div>
            <div style={lbl}>Що ділимо</div>
            <div style={{ display: "inline-flex", background: "var(--bg)", borderRadius: 10, padding: 3, gap: 2 }}>
              {seg("all", `Весь план · ${fmt(gone.pool)}`)}{seg("rest", `Тільки залишок · ${fmt(rest)}`)}
            </div>
            {mode === "rest" && (
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
                {rest > 0
                  ? <>{fmt(gone.pool - rest)} ₴ лишається за {shortName(gone.name)} як уже виконаний план. План команди не змінюється.</>
                  : <>Залишку немає: факт уже покрив план.</>}
              </div>
            )}
          </div>
          <div>
            <div style={lbl}>Кому передати · тільки менеджери його команди</div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, maxHeight: 300, overflow: "auto" }}>
              {roster.map((m, i) => {
                const on = sel.includes(m.managerId), a = amounts[m.managerId] ?? 0;
                return (
                  <label key={m.managerId} style={{ display: "grid", gridTemplateColumns: "20px 1fr 120px", gap: 10, alignItems: "center", padding: "7px 12px", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 14, cursor: "pointer" }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(m.managerId)} />
                    <span>{m.name}<br />
                      <span style={{ fontSize: 12, color: MUTED }}>зараз {fmt(m.currentPlan)} ₴{on && a > 0 ? ` → ${fmt(m.currentPlan + a)} ₴` : ""}</span>
                    </span>
                    <input type="number" min={0} step={500} disabled={!on} value={on ? String(a || "") : ""} aria-label={`Сума для ${m.name}`}
                      onChange={(e) => { setAuto(false); setAmounts((p) => ({ ...p, [m.managerId]: Math.max(0, Math.round(Number(e.target.value) || 0)) })); }}
                      style={{ width: "100%", textAlign: "right", fontWeight: 700, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: on ? "var(--card-bg)" : "var(--bg)", color: "var(--text)" }} />
                  </label>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", borderRadius: 10, padding: "9px 12px", fontSize: 13.5,
            background: sel.length === 0 ? "var(--bg)" : diff === 0 ? GREEN + "1a" : RED + "17", color: sel.length === 0 ? MUTED : diff === 0 ? GREEN : RED }}>
            <span>Роздано <b>{fmt(given)}</b> з <b>{fmt(total)} ₴</b>
              {sel.length === 0 ? " · оберіть хоча б одного" : diff > 0 ? ` · ще ${fmt(diff)} ₴` : diff < 0 ? ` · забагато на ${fmt(-diff)} ₴` : " · сходиться"}</span>
            <button style={lineBtn} disabled={sel.length === 0} onClick={() => { setAuto(true); setAmounts(equal(sel, total)); }}>Порівну</button>
          </div>
          {err && <div style={{ color: RED, fontSize: 13 }}>{err}</div>}
        </div>
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, color: MUTED, maxWidth: 320 }}>
            {ready ? "Нові плани одразу діють скрізь. План команди не змінюється." : "Сума має дорівнювати плану, який передаємо."}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={lineBtn} disabled={busy} onClick={onClose}>Скасувати</button>
            <button style={{ ...darkBtn, padding: "9px 16px", opacity: ready && !busy ? 1 : 0.35, cursor: ready && !busy ? "pointer" : "not-allowed" }}
              disabled={!ready || busy} onClick={save}>{busy ? "…" : "Зберегти"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Картки тих, хто пішов: що було на них за місяць і що з цим планом зараз. */
export function GoneCards({ team }: { team: PFTeam }) {
  const gone = team.gone ?? [];
  if (gone.length === 0) return null;
  const pill = (c: string, t: string) => <span style={{ fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: c + "22", color: c }}>{t}</span>;
  return (
    <>
      {gone.map((g) => {
        const dropped = (team.history ?? []).some((e) => e.fromManagerId === g.managerId && e.kind === "drop");
        return (
          <div key={g.managerId} style={{ border: "1px solid var(--border)", borderLeft: `4px solid ${g.pool > 0 ? AMBER : "var(--border)"}`, borderRadius: 12, marginTop: 12, padding: "13px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 750, fontSize: 15 }}>{g.name}</span>
              {pill(RED, "пішов")}
              {g.pool > 0 ? pill(AMBER, `не розподілено ${fmt(g.pool)} ₴`) : dropped && g.plan === 0 ? pill("#6b7280", "план знято") : pill(GREEN, "план передано")}
              <span style={{ marginLeft: "auto", fontSize: 13, color: MUTED }}>
                факт за місяць <b style={{ color: "var(--text)" }}>{fmt(g.fact)} ₴</b> · лишається в команді
                {g.kept > 0 && <> · за ним лишено <b style={{ color: "var(--text)" }}>{fmt(g.kept)} ₴</b> як виконане</>}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
