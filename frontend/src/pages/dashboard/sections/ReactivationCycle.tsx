import { useCallback, useEffect, useState } from "react";
import {
  reactDecision, fetchLeadgenPool, takeFromLeadgenPool,
  type ReactCycleView, type LeadgenPoolRow,
} from "../../../api";
import { formatAmountFull } from "../format";

/**
 * 🔁 ЦИКЛ РЕАКТИВАЦІЇ І ПУЛ ЛІДГЕНІВ (ТЗ Юлі 22.09.2026, блок 4; задача 4313).
 *
 * 🔴 ФРОНТ НЕ МАЄ ВЛАСНОГО ПРАВИЛА. Стан, строк і які кнопки можна тиснути приходять із сервера
 * (`reactCycle.status` / `deadline` / `allowed`, ядро `core/reactCycleRules.ts`). Кнопка, якої немає в
 * `allowed`, не малюється — інакше фронт обіцяв би дію, яку сервер відхилить.
 */

const btn = (primary?: boolean) => ({ fontSize: 11, fontWeight: primary ? 700 : 500, padding: "4px 9px",
  borderRadius: 8, cursor: "pointer", border: primary ? "none" : "1px solid #d1d5db",
  background: primary ? "#111827" : "#fff", color: primary ? "#fff" : "#374151" } as const);

const ddmm = (ymd: string) => ymd.slice(5, 10).split("-").reverse().join(".");
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

export const POOL_REASON: Record<string, string> = {
  manager: "передав менеджер",
  auto: "автоматично: ні рахунку, ні рішення",
  self_expired: "автоматично: минув строк «реактивую сам»",
};

/** Стан циклу словами + строк. Порожнім не буває: кожен стан названо. */
export function ReactCycleStatus({ cycle }: { cycle: ReactCycleView }) {
  const inv = cycle.lastInvoice ? `останній рахунок ${ddmm(cycle.lastInvoice)}.${cycle.lastInvoice.slice(2, 4)}` : "рахунків не було";
  if (cycle.status === "pool") {
    return <div style={{ fontSize: 11, color: "#6d28d9", fontWeight: 600 }} title={inv}>
      🎯 у пулі лідгенів{cycle.poolReason ? ` · ${POOL_REASON[cycle.poolReason] ?? cycle.poolReason}` : ""}
    </div>;
  }
  if (cycle.status === "taken") {
    return <div style={{ fontSize: 11, color: "#047857", fontWeight: 600 }} title={inv}>🎯 взяв лідген</div>;
  }
  const dl = cycle.deadline ? lastDay(cycle.deadline) : null;
  return (
    <div style={{ fontSize: 11, color: cycle.daysLeft != null && cycle.daysLeft <= 7 ? "#b91c1c" : "#374151" }}
      title={`${inv}. Без рахунку до ${dl ? ddmm(dl) : "—"} клієнт автоматично піде в пул лідгенів.`}>
      {cycle.status === "self" ? "🙋 реактивую сам · " : "⏳ чекає рішення · "}
      {dl ? <>до автопередачі <b>{cycle.daysLeft} дн.</b> (до {ddmm(dl)})</> : "без строку"}
    </div>
  );
}

/** Дві кнопки 4.2 — лише ті, що дозволив сервер. `onDone` перезавантажує екран. */
export function ReactCycleButtons({ clientKey, cycle, onDone, onError }: {
  clientKey: string; cycle: ReactCycleView; onDone: () => void; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!cycle.allowed.length) return null;
  const go = async (decision: "self" | "leadgen") => {
    if (decision === "leadgen" && !window.confirm("Передати клієнта в пул лідгенів? Відповідальним він лишиться, доки лідген його не візьме.")) return;
    setBusy(true);
    try { await reactDecision({ clientKey, decision }); onDone(); }
    catch (e) {
      const r = (e as { response?: { status?: number; data?: { error?: string } } }).response;
      onError(r?.data?.error ?? (r?.status ? `Сервер відмовив (код ${r.status}). Рішення НЕ збережено.` : "Немає звʼязку з сервером. Рішення НЕ збережено."));
    } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
      {cycle.allowed.includes("self") && (
        <button type="button" disabled={busy} style={btn(true)} onClick={() => go("self")}
          title="Лишається за вами. Якщо рахунку не буде до кінця наступного місяця — клієнт піде лідгенам автоматично; продовжити строк повторним натисканням не можна">
          🙋 Реактивую сам
        </button>
      )}
      {cycle.allowed.includes("leadgen") && (
        <button type="button" disabled={busy} style={btn()} onClick={() => go("leadgen")}
          title="Клієнт іде в пул лідгенів; хто з лідгенів візьме — за тим і закріпиться">
          🎯 Передати лідгенам
        </button>
      )}
    </div>
  );
}

/**
 * 🎯 ПУЛ ЛІДГЕНІВ (п.4.2–4.4). Бачать лідгени й керівництво; брати — лише лідген, собі.
 * Список ще раз звіряє сервер: клієнт із рахунком за 3 місяці тут не показується й не береться.
 */
export function LeadgenPoolPanel({ onTaken }: { onTaken: () => void }) {
  const [data, setData] = useState<{ canTake: boolean; rows: LeadgenPoolRow[]; revivedClosed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchLeadgenPool().then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити пул"));
  }, []);
  useEffect(load, [load]);
  const take = async (r: LeadgenPoolRow) => {
    setBusy(r.clientKey); setErr(null);
    try { await takeFromLeadgenPool(r.clientKey); load(); onTaken(); }
    catch (e) { setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? "Не вдалося взяти клієнта"); load(); }
    finally { setBusy(null); }
  };
  const S = { th: { textAlign: "left", fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e5e7eb" } as const,
              td: { padding: "9px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 13 } as const };
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 0, overflowX: "auto" }}>
      <div style={{ padding: "10px 14px", fontSize: 12.5, color: "#4b5563", lineHeight: 1.55, borderBottom: "1px solid #f1f5f9" }}>
        <b>🎯 Пул лідгенів.</b> Клієнти без виставленого рахунку 3 повні місяці, яких менеджер передав
        або які пішли сюди автоматично. {data?.canTake ? "«Взяти» закріплює клієнта за вами з поточного місяця." : "Брати можуть лише лідгени."}
        {" "}Клієнта, у якого зʼявився рахунок, тут немає — він лишається за менеджером.
        {data && data.revivedClosed > 0 && <span style={{ color: "#047857" }}> Щойно прибрано ожилих: {data.revivedClosed}.</span>}
      </div>
      {err && <div role="alert" style={{ padding: "8px 14px", color: "#b91c1c", fontWeight: 600, fontSize: 13 }}>⚠️ {err}</div>}
      {!data ? <div style={{ padding: 14, color: "#6b7280" }}>завантаження…</div> : !data.rows.length ? (
        <div style={{ padding: 14, color: "#6b7280" }}>У пулі зараз нікого. Автопередача — щоночі; перша можлива — 01.11.2026.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead><tr>
            <th style={S.th}>Клієнт</th><th style={S.th}>Останній рахунок</th><th style={S.th}>Успішно за весь час</th>
            <th style={S.th}>Звідки</th><th style={S.th}>У пулі з</th><th style={S.th} />
          </tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.clientKey}>
                <td style={S.td}><b>{r.clientName}</b></td>
                <td style={S.td}>{r.lastInvoice ? `${ddmm(r.lastInvoice)}.${r.lastInvoice.slice(0, 4)}` : "рахунків не було"}</td>
                <td style={S.td}>{formatAmountFull(r.successRevenue)} <span style={{ color: "#6b7280" }}>· {r.successDeals} угод</span></td>
                <td style={S.td}>👤 {r.fromManagerName ?? "менеджер невідомий"}<div style={{ fontSize: 11, color: "#6b7280" }}>{POOL_REASON[r.poolReason] ?? r.poolReason}</div></td>
                <td style={S.td}>{ddmm(r.pooledAt)}</td>
                <td style={S.td}>
                  {data.canTake && (
                    <button type="button" disabled={busy != null} style={btn(true)} onClick={() => take(r)}>
                      {busy === r.clientKey ? "…" : "Взяти"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

