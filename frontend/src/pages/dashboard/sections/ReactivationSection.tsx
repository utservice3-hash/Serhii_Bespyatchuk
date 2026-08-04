import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthPayload } from "../../../auth";
import {
  fetchReactivationList, setClientSeasonal, fetchMergePreview, mergeClients, revokeMerge,
  fetchMergeJournal, assignClientManager, fetchClientManagerHistory, fetchManagerOptions,
  createClientReactivationTask, closeReactivationTask,
  type ReactivationResp, type ReactivationRow, type MergePreview, type MergeJournalRow,
  type ManagerHistoryRow, type ManagerOption,
} from "../../../api";
import { formatAmountFull } from "../format";
import { ClientPicker, type ClientPickerValue } from "../ClientPicker";

/**
 * ФАЗА B · «РЕАКТИВАЦІЯ · СПЛЯЧІ ТА ВТРАЧЕНІ» (макет 2).
 *
 * 🔴 Стани НЕ перемикаються руками: постійний → сплячий (60 дн.) → втрачений
 * (180 дн.) → повернений — усе з дат замовлень, рахує ядро. Руками ставиться
 * рівно одне — «сезонний»: з дат його вивести неможливо.
 */

/**
 * Менеджер без команди в `managers.team_id` — це стан бази, а не помилка екрана.
 * Ховати такі рядки не можна: клієнт зник би зі списку реактивації мовчки.
 */
const BEZ_KOMANDY = "Без команди";

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

/**
 * 🔴 ДВІ ДАТИ В РЯДКУ, І ПІДПИСАНО, ЯКА З НИХ РАХУЄ СТАН.
 *
 * Стан («сплячий»/«втрачений») рахується ВИКЛЮЧНО від останньої ОПЛАТИ — так у
 * ядрі, і так лишається. Але власник бачив «без контакту 120 днів» серед
 * активних і «з контактом» серед сплячих і не міг зрозуміти, від чого екран
 * рахує. Обидві причини правильні; невидимою була сама відповідь.
 *
 * Тому: оплата — з підписом «джерело стану», дзвінок — з підписом «довідка».
 * Дзвінок НЕ впливає на стан і не має впливати: розмова не робить клієнта
 * платником.
 */
function TwoDates({ c }: { c: ReactivationRow }) {
  const callTone = c.lastCallDays == null ? "#9ca3af"
    : c.lastCallDays <= 30 ? "#166534" : c.lastCallDays <= 90 ? "#b45309" : "#b91c1c";
  return (
    <div style={{ lineHeight: 1.45 }}>
      <div>
        <span style={{ fontSize: 10, letterSpacing: .3, textTransform: "uppercase", color: "#6b7280" }}>
          остання оплата
        </span>
        <div>
          <b>{c.lastPaid ?? "—"}</b>
          <span style={{ color: "#6b7280" }}> · {c.daysSince} дн. тому</span>
        </div>
        <div style={{ fontSize: 10, color: "#9ca3af" }}>джерело стану</div>
      </div>
      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed #e5e7eb" }}>
        <span style={{ fontSize: 10, letterSpacing: .3, textTransform: "uppercase", color: "#6b7280" }}>
          останній дзвінок
        </span>
        {c.lastCall == null ? (
          // Порожньо — це відповідь, а не діра: звʼязка дзвінок→клієнт іде через
          // телефон контакту Kommo і покриває не всіх. Мовчазний прочерк читався
          // б як «не дзвонили», а це різні твердження.
          <div style={{ color: "#9ca3af" }}>дзвінків не знайдено</div>
        ) : (
          <>
            <div>
              <b style={{ color: callTone }}>{c.lastCall}</b>
              <span style={{ color: "#6b7280" }}> · {c.lastCallDays} дн. тому</span>
            </div>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>
              {c.lastCallDirection === "out" ? "вихідний" : "вхідний"}
              {c.lastCallAnswered === false && <span style={{ color: "#b45309" }}> · без відповіді</span>}
              {" · довідка, на стан не впливає"}
            </div>
          </>
        )}
      </div>
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
function MergePanel({ onDone, teamOnly }: { onDone: () => void; teamOnly?: boolean }) {
  // 🔴 Тепер це ВИБІР зі списку, а не два поля вільного тексту: канонічний ключ
  // (`вкавтострада`) дізнатись із екрана було нізвідки, тож формою не могли
  // скористатись. Ключ підставляє пошук, людина шукає за назвою або номером.
  const [aliasSel, setAliasSel] = useState<ClientPickerValue | null>(null);
  const [canonSel, setCanonSel] = useState<ClientPickerValue | null>(null);
  const alias = aliasSel?.clientKey ?? "";
  const canonical = canonSel?.clientKey ?? "";
  const [reason, setReason] = useState("");
  const [pre, setPre] = useState<MergePreview | null>(null);
  const [journal, setJournal] = useState<MergeJournalRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reloadJournal = useCallback(() => { fetchMergeJournal().then(setJournal).catch(() => setJournal([])); }, []);
  useEffect(reloadJournal, [reloadJournal]);

  // Передпоказ рахується САМ, щойно обрано обидві сторони: раніше він висів на
  // `onBlur` поля, і його легко було не побачити взагалі.
  useEffect(() => {
    setErr(null); setPre(null);
    if (!alias || !canonical) return;
    let dead = false;
    setBusy(true);
    fetchMergePreview(alias, canonical)
      .then((r) => { if (!dead) setPre(r); })
      .catch((e) => { if (!dead) setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "не вдалося порахувати"); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [alias, canonical]);
  const doMerge = async () => {
    setBusy(true); setErr(null);
    try { await mergeClients({ alias, canonical, reason: reason.trim() });
          setAliasSel(null); setCanonSel(null); setReason(""); setPre(null); reloadJournal(); onDone(); }
    catch (e) { setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "не вдалося обʼєднати"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...S.card, flex: "1 1 460px", minWidth: 420 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>🔗 Обʼєднати клієнтів</b>
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {teamOnly ? "лише в межах вашої команди" : "за правом · КВП, Опер. директор, адмін"}
        </span>
      </div>

      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Приєднати (псевдонім)</div>
      <ClientPicker value={aliasSel} onPick={setAliasSel} placeholder="назва або номер — напр. «0977086747»" disabled={busy} />
      <div style={{ textAlign: "center", color: "#9ca3af", fontSize: 12, margin: "6px 0" }}>▼ стане частиною</div>
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Основний клієнт</div>
      <ClientPicker value={canonSel} onPick={setCanonSel} placeholder="назва або номер — напр. «Автострада»" disabled={busy} />

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
        <button style={S.btn()} disabled={busy} onClick={() => { setAliasSel(null); setCanonSel(null); setReason(""); setPre(null); setErr(null); }}>Скасувати</button>
      </div>

      {teamOnly && (
        // Кажемо ПРАВИЛО, а не «щось пішло не так»: інакше 403 на міжкомандній парі
        // читався б як збій системи, і тімлід ішов би шукати баг, а не КВП.
        <div style={{ marginTop: 10, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8,
                      padding: "8px 10px", fontSize: 12, color: "#1e3a8a", lineHeight: 1.5 }}>
          Ви обʼєднуєте клієнтів <b>своєї команди</b>. Якщо хоч один бік належить іншій команді —
          обʼєднання зробить КВП або Опер. директор. Перевіряє сервер, а не ця форма.
        </div>
      )}
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
  // Був `<select>` із перших 300 клієнтів — тобто решта була недосяжна, і хто
  // саме випав, з екрана не читалось. Тепер той самий пошук, що в обʼєднанні.
  const [sel, setSel] = useState<ClientPickerValue | null>(null);
  const clientKey = sel?.clientKey ?? "";
  const [managerId, setManagerId] = useState<number | "">("");
  const [reason, setReason] = useState("");
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [history, setHistory] = useState<ManagerHistoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { fetchManagerOptions().then(setManagers).catch(() => setManagers([])); }, []);
  useEffect(() => { if (clientKey) fetchClientManagerHistory(clientKey).then(setHistory).catch(() => setHistory([])); }, [clientKey]);
  // «Зараз веде» беремо з рядка списку, а якщо клієнта в поточному зрізі немає —
  // з самого пошуку: обидва джерела — COALESCE(закріплений, основний за оплатами).
  const cur = clients.find((c) => c.clientKey === clientKey);
  const curManager = cur?.managerName ?? sel?.managerName ?? null;

  const nextMonth = (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toLocaleDateString("uk-UA", { month: "long", year: "numeric" }); })();

  return (
    <div style={{ ...S.card, flex: "1 1 460px", minWidth: 420 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>👤 Відповідальний менеджер</b>
        <span style={{ fontSize: 11, color: "#6b7280" }}>за правом · КВП, Опер. директор, адмін</span>
      </div>

      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Клієнт</div>
      <ClientPicker value={sel} onPick={setSel} placeholder="назва або номер клієнта…" disabled={busy} />
      {curManager && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 5 }}>Зараз веде: <b>{curManager}</b>{cur?.pinned ? " 📌" : ""}</div>}

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
        <button style={S.btn()} disabled={busy} onClick={() => { setSel(null); setManagerId(""); setReason(""); setMsg(null); }}>Скасувати</button>
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


/**
 * Підсумок рівня ієрархії — З ТИХ САМИХ рядків, що показані нижче. Той самий
 * інваріант, що на екрані планів: «згорнути» ховає рядки й не змінює жодної
 * цифри. Якби рівень рахувався окремим запитом, згорнутий і розгорнутий вигляд
 * могли б розійтись, і ніхто не сказав би, який із них правильний.
 */
function levelTotals(rows: ReactivationRow[]) {
  return {
    clients: rows.length,
    sleeping: rows.filter((c) => c.state === "sleeping" && !c.seasonal).length,
    lost: rows.filter((c) => c.state === "lost" && !c.seasonal).length,
    inWork: rows.filter((c) => c.taskId != null && c.taskStatus !== "done").length,
    potential: rows.reduce((s, c) => s + c.lifetimeRevenue, 0),
    value: rows.reduce((s, c) => s + c.value, 0),
  };
}

/** Рядок-шапка рівня (команда / менеджер) з підсумками й «розгорнути». */
function GroupRow({ level, title, sub, open, onToggle, totals }: {
  level: "team" | "manager"; title: string; sub?: string; open: boolean;
  onToggle: () => void; totals: ReturnType<typeof levelTotals>;
}) {
  const isTeam = level === "team";
  return (
    <tr onClick={onToggle}
      style={{ background: isTeam ? "#f1f5f9" : "#fafcff", cursor: "pointer",
               borderTop: isTeam ? "2px solid #e2e8f0" : "1px solid #eef2f7" }}>
      <td style={{ ...S.td, paddingLeft: isTeam ? 10 : 28, fontWeight: isTeam ? 800 : 700,
                   fontSize: isTeam ? 14 : 13, borderBottom: "none", verticalAlign: "middle" }}>
        <span style={{ color: "#64748b", marginRight: 6 }}>{open ? "▾" : "▸"}</span>
        {isTeam ? "🏢 " : "👤 "}{title}
        <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>
          {sub ? ` · ${sub}` : ""} · {totals.clients} {totals.clients === 1 ? "клієнт" : "клієнтів"}
        </span>
      </td>
      {/* Підсумки станів — на рівні «Стан», тобто рівно під тим стовпчиком, який
          вони підсумовують. Показуємо лише ненульові: рядок «💤 0 · ❌ 0 · 🔧 0»
          нічого не каже, а місце займає. */}
      <td style={{ ...S.td, borderBottom: "none", verticalAlign: "middle" }} colSpan={2}>
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {totals.sleeping > 0 && <span style={S.chip("#fef3c7", "#92400e")}>💤 {totals.sleeping}</span>}
          {totals.lost > 0 && <span style={S.chip("#fee2e2", "#b91c1c")}>❌ {totals.lost}</span>}
          {totals.inWork > 0 && <span style={S.chip("#dbeafe", "#1d4ed8")}>🔧 {totals.inWork}</span>}
          <span style={{ fontSize: 11, color: "#6b7280" }}>потенціал {formatAmountFull(totals.potential)}</span>
        </span>
      </td>
      <td style={{ ...S.td, borderBottom: "none" }} colSpan={3} />
    </tr>
  );
}

/** Модалка — спільна оболонка, щоб обидва діалоги виглядали однаково. */
function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex",
                  alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ ...S.card, width: 460, maxWidth: "92vw", boxShadow: "0 18px 48px rgba(0,0,0,.22)" }}>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function CreateTaskDialog({ client, busy, onCancel, onSubmit }: {
  client: { clientKey: string; name: string }; busy: boolean;
  onCancel: () => void; onSubmit: (deadline: string, comment: string) => void;
}) {
  const inWeek = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const [deadline, setDeadline] = useState(inWeek);
  const [comment, setComment] = useState("");
  return (
    <Modal title={`＋ Задача реактивації · ${client.name}`}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>
        Одна задача = один клієнт. Виконавець — основний менеджер цього клієнта.
        Закрити її буде можна лише з причиною.
      </div>
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", marginBottom: 4 }}>Строк</div>
      <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={S.input} />
      <div style={{ fontSize: 10, letterSpacing: .4, textTransform: "uppercase", color: "#6b7280", margin: "10px 0 4px" }}>Що зробити (не обовʼязково)</div>
      <input value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder="подзвонити, запропонувати серпневі тарифи" style={S.input} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={S.btn(true)} disabled={busy} onClick={() => onSubmit(deadline, comment)}>Створити</button>
        <button style={S.btn()} disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </Modal>
  );
}

function CloseTaskDialog({ task, reasons, busy, onCancel, onSubmit }: {
  task: { taskId: number; name: string }; reasons: { key: string; label: string }[];
  busy: boolean; onCancel: () => void; onSubmit: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  // 🔴 «Інше» без пояснення — це та сама відсутність причини під іншою назвою.
  const needNote = reason === "other";
  const ready = reason !== "" && (!needNote || note.trim() !== "");
  return (
    <Modal title={`Закрити задачу · ${task.name}`}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, lineHeight: 1.5 }}>
        Причина обовʼязкова. Це єдине джерело даних про те, ЧОМУ клієнт не повернувся —
        без неї через півроку список покаже тих самих людей, і ніхто не згадає, чим скінчилась розмова.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {reasons.map((r) => (
          <button key={r.key} onClick={() => setReason(r.key)}
            style={{ ...S.btn(reason === r.key), fontSize: 12 }}>{r.label}</button>
        ))}
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={needNote ? "Поясніть — для «Інше» обовʼязково" : "Деталі (не обовʼязково)"}
        style={{ ...S.input, marginTop: 10, borderColor: needNote && !note.trim() ? "#fca5a5" : "#d1d5db" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={S.btn(true)} disabled={busy || !ready} onClick={() => onSubmit(reason, note.trim())}>Закрити задачу</button>
        <button style={S.btn()} disabled={busy} onClick={onCancel}>Скасувати</button>
      </div>
    </Modal>
  );
}

export function ReactivationSection({ auth }: { auth: AuthPayload }) {
  const [data, setData] = useState<ReactivationResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"sleeping" | "lost" | "inwork" | "returned">("sleeping");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ clientKey: string; name: string } | null>(null);
  const [closing, setClosing] = useState<{ taskId: number; name: string } | null>(null);
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  const [openMgrs, setOpenMgrs] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    setErr(null);
    fetchReactivationList().then(setData).catch((e) => setErr(e?.response?.data?.error ?? "не вдалося завантажити"));
  }, []);
  useEffect(load, [load]);

  /**
   * Стартовий вигляд — той самий, що на екрані планів (те саме рішення власника,
   * тому й та сама поведінка, а не «схожа»):
   *   тімлід       — його команда РОЗГОРНУТА одразу (вона в нього одна);
   *   адмін/ОД/КВП — усе згорнуто до команд;
   *   менеджер     — плаский список, ієрархія додала б лише два кліки.
   */
  useEffect(() => {
    if (!data || auth.role !== "team_lead") return;
    setOpenTeams(new Set(data.clients.map((c) => c.teamName ?? BEZ_KOMANDY)));
  }, [data, auth.role]);

  if (err) return <div style={{ ...S.card, color: "#dc2626" }}>{err}</div>;
  if (!data) return <div style={{ ...S.card, color: "#6b7280" }}>завантаження…</div>;

  const t = data.tiles;
  const rows = data.clients.filter((c) => {
    if (view === "sleeping") return c.state === "sleeping";
    if (view === "lost") return c.state === "lost";
    if (view === "inwork") return c.taskId != null && c.taskStatus !== "done";
    return c.returned;
  });

  /**
   * 🔴 ІЄРАРХІЯ — ЦЕ ПОДАЧА, А НЕ СКОУП. Групуємо ТІ САМІ рядки, що прийшли з
   * бекенду й пройшли той самий фільтр вкладки: жоден клієнт не додається і не
   * зникає. Клієнт кріпиться до ОДНОГО менеджера (`COALESCE(закріплений,
   * основний за оплатами)` з ядра), тож роздвоїтись між командами не може.
   * Порядок усередині — той, що прийшов із бекенду (за цінністю); рівні —
   * за Σ цінності, щоб «найважчі» команди були зверху.
   */
  const grouped = auth.role !== "manager";
  const teams = (() => {
    if (!grouped) return [];
    const byTeam = new Map<string, Map<number, { name: string; rows: ReactivationRow[] }>>();
    for (const c of rows) {
      const tk = c.teamName ?? BEZ_KOMANDY;
      const mgrs = byTeam.get(tk) ?? new Map();
      const m = mgrs.get(c.managerId) ?? { name: c.managerName, rows: [] };
      m.rows.push(c);
      mgrs.set(c.managerId, m);
      byTeam.set(tk, mgrs);
    }
    const byValue = <T extends { rows: ReactivationRow[] }>(a: T, b: T) =>
      levelTotals(b.rows).value - levelTotals(a.rows).value;
    return [...byTeam.entries()]
      .map(([teamName, mgrs]) => ({
        teamName,
        rows: [...mgrs.values()].flatMap((m) => m.rows),
        mgrs: [...mgrs.entries()].map(([id, m]) => ({ id, name: m.name, rows: m.rows })).sort(byValue),
      }))
      .sort(byValue);
  })();

  const renderRow = (c: ReactivationRow) => (
    <tr key={c.clientKey} style={{ background: c.seasonal ? "#fafafa" : undefined }}>
      <td style={S.td}>
        <div style={{ fontWeight: 700 }}>{c.clientName}</div>
        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>
          {c.orders} зам. · сер. чек {formatAmountFull(Math.round(c.lifetimeRevenue / Math.max(1, c.orders)))}
          {" · "}
          <span title={c.pinned ? "закріплений за менеджером вручну" : "основний менеджер за оплатами"}>
            👤 {c.managerName}{c.pinned ? " 📌" : ""}
          </span>
        </div>
      </td>
      <td style={S.td}><StateChip c={c} /></td>
      <td style={S.td}>
        <b>{formatAmountFull(c.lifetimeRevenue)}</b>
        <div style={{ fontSize: 11, color: "#9ca3af" }}>lifetime · вага {Math.round(c.value).toLocaleString("uk-UA")}</div>
      </td>
      <td style={S.td}>
        {c.taskId && c.taskStatus !== "done" ? (
          <div>
            <b>{c.taskAssignee ?? "—"}</b>
            {c.taskDeadline && <span style={{ color: "#b45309" }}> · до {c.taskDeadline.slice(5)}</span>}
            <div>
              <button disabled={busy} style={{ ...S.btn(), marginTop: 5, fontSize: 11, padding: "4px 9px" }}
                onClick={() => setClosing({ taskId: c.taskId!, name: c.clientName })}>Закрити…</button>
            </div>
          </div>
        ) : c.taskId ? (
          <span style={{ color: "#6b7280" }}>закрита</span>
        ) : c.seasonal ? (
          // 🔴 Сезонним задачі НЕ ставимо: їхній «простій» — це не втрата
          // клієнта, а календар. Смикати їх означає вчити менеджера, що
          // список реактивації можна ігнорувати.
          <span style={{ color: "#9ca3af" }}>сезонний — задача не потрібна</span>
        ) : (
          <button disabled={busy} style={{ ...S.btn(true), fontSize: 11, padding: "5px 10px" }}
            onClick={() => setCreating({ clientKey: c.clientKey, name: c.clientName })}>＋ Задача</button>
        )}
      </td>
      <td style={S.td}><TwoDates c={c} /></td>
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
  );

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

        {/* 🔴 ПРАВИЛО НАПИСАНЕ НАД СПИСКОМ, А ПОРОГИ ПРИЇХАЛИ З ЯДРА
            (`data.thresholds` ← `SLEEPING_DAYS`/`LOST_DAYS`). Зашити «60/180»
            текстом означало б завести другу редакцію правила: підкрутили б поріг
            у ядрі — і підпис почав би брехати, причому мовчки. */}
        <div style={{ margin: "0 14px 10px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8,
                      padding: "8px 11px", fontSize: 12, color: "#1e3a8a", lineHeight: 1.55 }}>
          <b>Стан — від останньої ОПЛАТИ:</b> сплячий {data.thresholds.sleepingDays}+ днів,
          втрачений {data.thresholds.lostDays}+ днів. Дзвінки на стан <b>не впливають</b> —
          вони показані поруч як довідка, щоб було видно, чи є контакт із клієнтом, який не платить.
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr>
              <th style={S.th}>Клієнт</th><th style={S.th}>Стан</th><th style={S.th}>Цінність</th>
              <th style={S.th}>Задача</th>
              <th style={S.th}>Оплата · дзвінок</th>
              <th style={S.th}>Причина (при закритті)</th>
            </tr>
          </thead>
          <tbody>
            {!grouped && rows.map(renderRow)}
            {grouped && teams.map((tm) => {
              const tOpen = openTeams.has(tm.teamName);
              return (
                <Fragment key={tm.teamName}>
                  <GroupRow level="team" title={tm.teamName} open={tOpen}
                    sub={`${tm.mgrs.length} ${tm.mgrs.length === 1 ? "менеджер" : "менеджерів"}`}
                    totals={levelTotals(tm.rows)}
                    onToggle={() => setOpenTeams((prev) => {
                      const n = new Set(prev); n.has(tm.teamName) ? n.delete(tm.teamName) : n.add(tm.teamName); return n;
                    })} />
                  {tOpen && tm.mgrs.map((mg) => {
                    const mOpen = openMgrs.has(mg.id);
                    return (
                      <Fragment key={mg.id}>
                        <GroupRow level="manager" title={mg.name} open={mOpen} totals={levelTotals(mg.rows)}
                          onToggle={() => setOpenMgrs((prev) => {
                            const n = new Set(prev); n.has(mg.id) ? n.delete(mg.id) : n.add(mg.id); return n;
                          })} />
                        {mOpen && mg.rows.map(renderRow)}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
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

      {/* Обʼєднання — тімліду теж (у межах його команди); передача відповідального
          лишилась за правом merge_clients. Тому дві різні умови, а не одна. */}
      {(data.canMerge || data.canAssign) && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {data.canMerge && <MergePanel onDone={load} teamOnly={data.mergeScope === "team"} />}
          {data.canAssign && <ManagerPanel clients={data.clients} onDone={load} />}
        </div>
      )}

      {creating && (
        <CreateTaskDialog client={creating} busy={busy}
          onCancel={() => setCreating(null)}
          onSubmit={async (deadline, comment) => {
            setBusy(true);
            try { await createClientReactivationTask({ clientKey: creating.clientKey, deadline, comment }); setCreating(null); load(); }
            finally { setBusy(false); }
          }} />
      )}
      {closing && (
        <CloseTaskDialog task={closing} reasons={data.closeReasons} busy={busy}
          onCancel={() => setClosing(null)}
          onSubmit={async (reason, note) => {
            setBusy(true);
            try { await closeReactivationTask({ taskId: closing.taskId, reason, note }); setClosing(null); load(); }
            finally { setBusy(false); }
          }} />
      )}
    </div>
  );
}
