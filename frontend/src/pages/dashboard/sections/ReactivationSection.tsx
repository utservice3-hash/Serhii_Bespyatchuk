import { useCallback, useEffect, useState } from "react";
import type { AuthPayload } from "../../../auth";
import {
  fetchReactivationList, setClientSeasonal, fetchMergePreview, mergeClients, revokeMerge,
  fetchMergeJournal, assignClientManager, fetchClientManagerHistory, fetchManagerOptions,
  type ReactivationResp, type ReactivationRow, type MergePreview, type MergeJournalRow,
  type ManagerHistoryRow, type ManagerOption,
} from "../../../api";
import { formatAmountFull } from "../format";

/**
 * ФАЗА B · «РЕАКТИВАЦІЯ · СПЛЯЧІ ТА ВТРАЧЕНІ» (макет 2).
 *
 * 🔴 Стани НЕ перемикаються руками: постійний → сплячий (60 дн.) → втрачений
 * (180 дн.) → повернений — усе з дат замовлень, рахує ядро. Руками ставиться
 * рівно одне — «сезонний»: з дат його вивести неможливо.
 */

const S = {
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px" } as const,
  th: { textAlign: "left", fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280",
        fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" } as const,
  td: { padding: "12px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 13, verticalAlign: "top" } as const,
  chip: (bg: string, fg: string) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 999,
        fontSize: 11, fontWeight: 700, background: bg, color: fg, whiteSpace: "nowrap" } as const),
  btn: (primary?: boolean) => ({ fontSize: 12, fontWeight: primary ? 700 : 500, padding: "6px 12px",
        borderRadius: 8, cursor: "pointer", border: primary ? "none" : "1px solid #d1d5db",
        background: primary ? "#111827" : "#fff", color: primary ? "#fff" : "#374151" } as const),
  input: { fontSize: 12, padding: "6px 9px", border: "1px solid #d1d5db", borderRadius: 8, width: "100%",
           boxSizing: "border-box" } as const,
};

function Tile({ title, value, sub, tone }: { title: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div style={{ ...S.card, flex: "1 1 200px", minWidth: 190 }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.05,
                    color: tone === "good" ? "#166534" : tone === "warn" ? "#b45309" : "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function StateChip({ c }: { c: ReactivationRow }) {
  if (c.seasonal) return <span style={S.chip("#eef2ff", "#4338ca")}>сезонний{c.seasonalNote ? ` · ${c.seasonalNote}` : ""}</span>;
  if (c.returned) return <span style={S.chip("#dcfce7", "#166534")}>повернено · +{formatAmountFull(c.returnedRevenue)}</span>;
  if (c.state === "lost") return <span style={S.chip("#fee2e2", "#b91c1c")}>втрачено {c.daysSince} дн.</span>;
  if (c.state === "sleeping") return <span style={S.chip("#fef3c7", "#92400e")}>спить {c.daysSince} дн.</span>;
  return <span style={S.chip("#f1f5f9", "#475569")}>активний · {c.daysSince} дн.</span>;
}

/** 🔗 Обʼєднання клієнтів — UI поверх client_key_alias. Механіка вже на проді. */
function MergePanel({ onDone }: { onDone: () => void }) {
  const [alias, setAlias] = useState("");
  const [canonical, setCanonical] = useState("");
  const [reason, setReason] = useState("");
  const [pre, setPre] = useState<MergePreview | null>(null);
  const [journal, setJournal] = useState<MergeJournalRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reloadJournal = useCallback(() => { fetchMergeJournal().then(setJournal).catch(() => setJournal([])); }, []);
  useEffect(reloadJournal, [reloadJournal]);

  const preview = async () => {
    setErr(null); setPre(null);
    if (!alias.trim() || !canonical.trim()) return;
    setBusy(true);
    try { setPre(await fetchMergePreview(alias.trim(), canonical.trim())); }
    catch (e) { setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "не вдалося порахувати"); }
    finally { setBusy(false); }
  };
  const doMerge = async () => {
    setBusy(true); setErr(null);
    try { await mergeClients({ alias: alias.trim(), canonical: canonical.trim(), reason: reason.trim() });
          setAlias(""); setCanonical(""); setReason(""); setPre(null); reloadJournal(); onDone(); }
    catch (e) { setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "не вдалося обʼєднати"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...S.card, flex: "1 1 460px", minWidth: 420 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>🔗 Обʼєднати клієнтів</b>
        <span style={{ fontSize: 11, color: "#6b7280" }}>за правом · КВП, Опер. директор, адмін</span>
      </div>

      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Приєднати (псевдонім)</div>
      <input value={alias} onChange={(e) => setAlias(e.target.value)} onBlur={preview} placeholder="напр. 0977086747" style={S.input} />
      <div style={{ textAlign: "center", color: "#9ca3af", fontSize: 12, margin: "6px 0" }}>▼ стане частиною</div>
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Основний клієнт</div>
      <input value={canonical} onChange={(e) => setCanonical(e.target.value)} onBlur={preview} placeholder="напр. вкавтострада" style={S.input} />

      {err && <div style={{ marginTop: 10, fontSize: 12, color: "#b91c1c" }}>{err}</div>}

      {pre && (
        <div style={{ marginTop: 10, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: "9px 11px", fontSize: 12, lineHeight: 1.6 }}>
          <div><b>Після обʼєднання:</b> один клієнт · {pre.after.orders} замовлень · {formatAmountFull(pre.after.revenue)}
            {pre.after.regular && <> · статус «постійний»</>} · переїде {pre.dealsToMove} угод.</div>
          <div style={{ color: "#6b7280", marginTop: 3 }}>
            {pre.alias.name ?? pre.alias.key}: {pre.alias.orders} опл · {formatAmountFull(pre.alias.revenue)}
            {" → "}{pre.canonical.name ?? pre.canonical.key}: {pre.canonical.orders} опл · {formatAmountFull(pre.canonical.revenue)}
          </div>
          {pre.chainBlocked.length > 0 && (
            <div style={{ marginTop: 6, color: "#b91c1c", fontWeight: 600 }}>
              🔴 Ланцюжок заборонено: один із ключів уже бере участь в іншому обʼєднанні. БД цього не пропустить.
            </div>
          )}
          {pre.plans.filter((p) => p.side === "alias").length > 0 && (
            <div style={{ marginTop: 6, color: "#b45309" }}>
              ⚠️ На псевдонімі є план ({pre.plans.filter((p) => p.side === "alias").map((p) => `${p.month} · ${formatAmountFull(p.plan)}`).join(", ")}).
              Перерахунок планів НЕ чіпає — рядок осиротіє і зникне з екрана, переносити треба руками.
              {pre.planConflictMonths.length > 0 && <> Місяці, де план є з обох боків: {pre.planConflictMonths.join(", ")}.</>}
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", margin: "10px 0 4px" }}>Причина (обовʼязково)</div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="одна юр. особа, замовляють з двох назв…" style={S.input} />

      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <button style={S.btn(true)} disabled={busy || !pre || !reason.trim() || (pre?.chainBlocked.length ?? 0) > 0} onClick={doMerge}>Обʼєднати</button>
        <button style={S.btn()} disabled={busy} onClick={() => { setAlias(""); setCanonical(""); setReason(""); setPre(null); setErr(null); }}>Скасувати</button>
      </div>

      <div style={{ marginTop: 10, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: "#78350f", lineHeight: 1.5 }}>
        Обʼєднання зворотне: у журналі зʼявиться запис із «↺ роз'єднати» — усе повернеться,
        історія не втрачається (сирий ключ угоди не змінюється ніколи).
      </div>

      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", margin: "12px 0 4px" }}>Журнал обʼєднань</div>
      <div style={{ maxHeight: 190, overflowY: "auto" }}>
        {journal.length === 0 && <div style={{ fontSize: 12, color: "#9ca3af" }}>записів немає</div>}
        {journal.map((j) => (
          <div key={j.aliasKey} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "5px 0", borderBottom: "1px dashed #e5e7eb" }}>
            <span style={{ color: "#6b7280", minWidth: 74 }}>{j.createdAt}</span>
            <span style={{ flex: 1 }}>
              <b>{j.aliasKey}</b> → {j.canonicalKey}
              <span style={{ color: "#9ca3af" }}> · {j.approvedBy ?? "—"}</span>
            </span>
            {j.revokedAt
              ? <span style={S.chip("#f3f4f6", "#6b7280")}>роз'єднано {j.revokedAt}</span>
              : <button style={{ border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", fontSize: 12 }}
                  disabled={busy}
                  onClick={async () => { if (!confirm(`Роз'єднати ${j.aliasKey} від ${j.canonicalKey}?`)) return;
                    setBusy(true); try { await revokeMerge(j.aliasKey); reloadJournal(); onDone(); } finally { setBusy(false); } }}>
                  ↺ роз'єднати
                </button>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 👤 Відповідальний менеджер — межа місяця, історія, розбіжність із CRM. */
function ManagerPanel({ clients, onDone }: { clients: ReactivationRow[]; onDone: () => void }) {
  const [clientKey, setClientKey] = useState("");
  const [managerId, setManagerId] = useState<number | "">("");
  const [reason, setReason] = useState("");
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [history, setHistory] = useState<ManagerHistoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { fetchManagerOptions().then(setManagers).catch(() => setManagers([])); }, []);
  useEffect(() => { if (clientKey) fetchClientManagerHistory(clientKey).then(setHistory).catch(() => setHistory([])); }, [clientKey]);
  const cur = clients.find((c) => c.clientKey === clientKey);

  const nextMonth = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toLocaleDateString("uk-UA", { month: "long", year: "numeric" }); })();

  return (
    <div style={{ ...S.card, flex: "1 1 460px", minWidth: 420 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>👤 Відповідальний менеджер</b>
        <span style={{ fontSize: 11, color: "#6b7280" }}>за правом · КВП, Опер. директор, адмін</span>
      </div>

      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Клієнт</div>
      <select value={clientKey} onChange={(e) => setClientKey(e.target.value)} style={{ ...S.input, cursor: "pointer" }}>
        <option value="">— оберіть клієнта —</option>
        {clients.slice(0, 300).map((c) => (
          <option key={c.clientKey} value={c.clientKey}>{c.clientName} · {c.orders} зам.</option>
        ))}
      </select>
      {cur && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 5 }}>Зараз веде: <b>{cur.managerName}</b></div>}

      <div style={{ textAlign: "center", color: "#9ca3af", fontSize: 12, margin: "8px 0" }}>▼ передати</div>
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Новий відповідальний</div>
      <select value={managerId} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : "")} style={{ ...S.input, cursor: "pointer" }}>
        <option value="">— оберіть менеджера —</option>
        {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>

      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Причина передачі (не обовʼязково)" style={{ ...S.input, marginTop: 8 }} />

      <div style={{ marginTop: 10, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: "#1e3a8a", lineHeight: 1.55 }}>
        <b>Правило передачі:</b> поточний місяць лишається за старим менеджером —
        план і факт не рухаються посеред місяця. Новий планує з <b>{nextMonth}</b>.
        Зміна лишається в історії клієнта.
      </div>

      <div style={{ marginTop: 8, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: "#78350f", lineHeight: 1.55 }}>
        ⚠️ Якщо нові угоди в CRM прийдуть з іншим відповідальним, ніж призначений тут, —
        клієнт буде позначений розбіжністю. Ми показуємо конфлікт, а не ховаємо його.
      </div>

      {msg && <div style={{ marginTop: 8, fontSize: 12, color: "#166534" }}>{msg}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button style={S.btn(true)} disabled={busy || !clientKey || !managerId}
          onClick={async () => { setBusy(true);
            try { const r = await assignClientManager({ clientKey, managerId: Number(managerId), reason: reason.trim() || undefined });
                  setMsg(`Передано. Діє з ${r.effectiveFrom}. ${r.note}`); setReason("");
                  setHistory(await fetchClientManagerHistory(clientKey)); onDone(); }
            finally { setBusy(false); } }}>Передати</button>
        <button style={S.btn()} disabled={busy} onClick={() => { setClientKey(""); setManagerId(""); setReason(""); setMsg(null); }}>Скасувати</button>
      </div>

      {history.length > 0 && (
        <>
          <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", margin: "12px 0 4px" }}>Історія передач</div>
          {history.map((h, i) => (
            <div key={i} style={{ fontSize: 12, padding: "5px 0", borderBottom: "1px dashed #e5e7eb" }}>
              <span style={{ color: "#6b7280" }}>{h.effectiveFrom}</span> · {h.fromManager ?? "—"} → <b>{h.toManager}</b>
              <span style={{ color: "#9ca3af" }}> · {h.changedBy ?? "—"}</span>
              {h.reason && <span style={{ color: "#6b7280" }}> · {h.reason}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function ReactivationSection({ auth }: { auth: AuthPayload }) {
  const [data, setData] = useState<ReactivationResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"sleeping" | "lost" | "inwork" | "returned">("sleeping");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    fetchReactivationList().then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, []);
  useEffect(load, [load]);

  if (err) return <div style={{ ...S.card, color: "#dc2626" }}>{err}</div>;
  if (!data) return <div style={{ ...S.card, color: "#6b7280" }}>завантаження…</div>;

  const t = data.tiles;
  const rows = data.clients.filter((c) => {
    if (view === "sleeping") return c.state === "sleeping";
    if (view === "lost") return c.state === "lost";
    if (view === "inwork") return c.taskId != null && c.taskStatus !== "done";
    return c.returned;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Реактивація · сплячі та втрачені</h2>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {auth.role === "manager" ? "мої клієнти" : auth.role === "team_lead" ? "моя команда" : "усі команди"}
            {" · ранжовано за цінністю клієнта (виручка за життя × свіжість)"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {([["sleeping", "Сплячі"], ["lost", "Втрачені"], ["inwork", "У роботі"], ["returned", "Повернені"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)} style={{ ...S.btn(view === k), minWidth: 92 }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Tile title={`Сплячих (${data.thresholds.sleepingDays}–${data.thresholds.lostDays} дн.)`} value={String(t.sleeping)}
          sub={`потенціал ${formatAmountFull(t.sleepingPotential)} за історією`} tone={t.sleeping ? "warn" : undefined} />
        <Tile title={`Втрачених (${data.thresholds.lostDays}+ дн.)`} value={String(t.lost)}
          sub={t.seasonal ? `з них ${t.seasonal} сезонних — не смикаємо` : "сезонних немає"} />
        <Tile title="Задач у роботі" value={String(t.inWork)} sub="реактиваційні задачі без закриття" />
        <Tile title="Повернено за 30 дн." value={`${t.returned30} · +${formatAmountFull(t.returned30Revenue)}`}
          sub="замовили ПІСЛЯ реактиваційної задачі" tone="good" />
      </div>

      <div style={{ ...S.card, padding: 0, overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px 8px" }}>
          <b style={{ fontSize: 15 }}>Кандидати на реактивацію</b>
          <span style={{ fontSize: 11, color: "#6b7280" }}>цінність = виручка за життя × свіжість · сезонні внизу</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr>
              <th style={S.th}>Клієнт</th><th style={S.th}>Стан</th><th style={S.th}>Цінність</th>
              <th style={S.th}>Задача</th><th style={S.th}>Остання оплата</th><th style={S.th}>Причина (при закритті)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.clientKey} style={{ background: c.seasonal ? "#fafafa" : undefined }}>
                <td style={S.td}>
                  <div style={{ fontWeight: 700 }}>{c.clientName}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>
                    {c.orders} зам. · сер. чек {formatAmountFull(Math.round(c.lifetimeRevenue / Math.max(1, c.orders)))} · {c.managerName}
                  </div>
                </td>
                <td style={S.td}><StateChip c={c} /></td>
                <td style={S.td}>
                  <b>{formatAmountFull(c.lifetimeRevenue)}</b>
                  <div style={{ fontSize: 11, color: "#9ca3af" }}>lifetime · вага {Math.round(c.value).toLocaleString("uk-UA")}</div>
                </td>
                <td style={S.td}>
                  {c.taskId
                    ? <span>{c.taskStatus === "done" ? "закрита" : <b>{c.taskAssignee ?? "—"}</b>}
                        {c.taskDeadline && <span style={{ color: "#b45309" }}> · до {c.taskDeadline.slice(5)}</span>}</span>
                    : c.seasonal
                      ? <span style={{ color: "#9ca3af" }}>сезонний — задача не потрібна</span>
                      : <span style={{ color: "#9ca3af" }}>задачі немає</span>}
                </td>
                <td style={S.td}>{c.lastPaid ?? "—"}<div style={{ fontSize: 11, color: "#9ca3af" }}>{c.daysSince} дн. тому</div></td>
                <td style={S.td}>
                  {c.closeReason
                    ? <span style={S.chip("#f3f4f6", "#4b5563")}>{data.closeReasons.find((r) => r.key === c.closeReason)?.label ?? c.closeReason}</span>
                    : <span style={{ color: "#d1d5db" }}>—</span>}
                  {(auth.role === "team_lead" || auth.role === "admin") && (
                    <button title={c.seasonal ? "Зняти позначку «сезонний»" : "Позначити сезонним"}
                      disabled={busy}
                      onClick={async () => { setBusy(true);
                        try { await setClientSeasonal({ clientKey: c.clientKey, seasonal: !c.seasonal }); load(); }
                        finally { setBusy(false); } }}
                      style={{ marginLeft: 8, border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>
                      {c.seasonal ? "↩" : "🌱"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: "#9ca3af", padding: 26 }}>у цій категорії порожньо</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ padding: "10px 14px", fontSize: 12, color: "#4b5563", lineHeight: 1.6, borderTop: "1px solid #f1f5f9" }}>
          <b>Стани рахуються з дат замовлень автоматично</b> — постійний → сплячий ({data.thresholds.sleepingDays} дн.)
          → втрачений ({data.thresholds.lostDays} дн.) → повернений (замовив після задачі). Тумблера «зробити сплячим»
          немає: збережений стан довелося б комусь оновлювати, і клієнт, що вчора замовив, лишався б «сплячим».
          Причина обовʼязкова при закритті задачі: {data.closeReasons.map((r) => r.label).join(" · ")}.
        </div>
      </div>

      {data.canAssign && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <MergePanel onDone={load} />
          <ManagerPanel clients={data.clients} onDone={load} />
        </div>
      )}
    </div>
  );
}
