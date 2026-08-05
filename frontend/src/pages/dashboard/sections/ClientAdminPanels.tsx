import { useCallback, useEffect, useState } from "react";
import {
  fetchMergePreview, mergeClients, revokeMerge, fetchMergeJournal,
  assignClientManager, fetchClientManagerHistory, fetchManagerOptions,
  type MergePreview, type MergeJournalRow, type ManagerHistoryRow,
  type ManagerOption, type ReactivationRow,
} from "../../../api";
import { formatAmountFull } from "../format";
import { ClientPicker, type ClientPickerValue } from "../ClientPicker";

/**
 * 🛠 ПАНЕЛІ КЕРУВАННЯ КЛІЄНТОМ — ОДНЕ ОГОЛОШЕННЯ НА ВСІ ЕКРАНИ.
 *
 * 🔴 ЧОМУ ВИНЕСЕНО. Обидві панелі жили ВСЕРЕДИНІ `ReactivationSection`, унизу
 * сторінки під таблицею на 610 рядків. Формально вони були на екрані — практично
 * власник їх не знаходив і повідомив, що обʼєднання «зникло». Це той самий клас,
 * що кнопка «прибрати з постійних», яка колись лишилась без входу: **дія існує в
 * коді, але дістатись до неї людина не може**.
 *
 * Тепер це модуль, який рендерять І реактивація, І картка клієнта. Копії немає —
 * саме тому винесення, а не другий такий самий блок поруч: дві копії форми
 * обʼєднання через півроку розійшлись би в правилах, і ніхто б не знав, яка з них
 * правильна.
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

export /** 🔗 Обʼєднання клієнтів — UI поверх client_key_alias. Механіка вже на проді. */
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

export /** 👤 Відповідальний менеджер — межа місяця, історія, розбіжність із CRM. */
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
