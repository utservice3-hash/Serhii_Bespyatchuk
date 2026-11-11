import { useState } from "react";
import { releaseOrphanClient, unreleaseOrphanClient, type ClientCard } from "../../../api";
import { useToast } from "../../../components/Toasts";

/**
 * 🧭 «В НІЧИЙНІ» — КНОПКА В КАРТЦІ КЛІЄНТА (задача 8135; ТЗ Юлі «Нові правила лідогенерації», розділ 2 «Постійні
 * клієнти»: «менеджер тисне кнопку — клієнт переходить у «Нічийні»; центр сповіщень повідомляє всіх менеджерів;
 * хтось бере — клієнт переходить до нього; за 1 день ніхто не взяв — клієнт іде лідгенам»). Роман 11.11.2026:
 * коментар обовʼязковий, «день» — робочий.
 *
 * Право й стан віддає сервер (`canRelease`, `released`, `inLeadgenPool`) — тут лише ввід і показ.
 */
const fmt = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function ClientReleaseBlock({ card, onSaved }: { card: ClientCard; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const min = card.releaseNoteMin ?? 5;
  const errOf = (e: unknown) => (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? "Не збережено: сервер відмовив.";

  const release = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await releaseOrphanClient(card.clientKey, note.trim());
      toast(`Клієнта віддано в «Нічийні». Сповіщення отримали ${r.notified ? "усі менеджери" : "—"}; до ${fmt(r.deadline)} його можуть узяти.`);
      setOpen(false); setNote(""); onSaved();
    } catch (e) { setErr(errOf(e)); }
    finally { setBusy(false); }
  };
  const unrelease = async () => {
    setBusy(true); setErr(null);
    try { await unreleaseOrphanClient(card.clientKey); toast("Клієнта повернуто — він знову у вашому списку."); onSaved(); }
    catch (e) { setErr(errOf(e)); }
    finally { setBusy(false); }
  };
  const btn = (bg: string, fg = "#fff", border = "none") =>
    ({ fontSize: 12, padding: "5px 11px", borderRadius: 8, border, background: bg, color: fg, cursor: "pointer" } as const);

  if (card.inLeadgenPool) {
    return (
      <div style={{ marginTop: 10, fontSize: 12, padding: "8px 10px", borderRadius: 8, background: "#f5f3ff", border: "1px solid #ddd6fe" }}>
        🧭 <b>У пулі лідгенів</b> з {card.inLeadgenPool.pooledDay.split("-").reverse().join(".")}
        {card.inLeadgenPool.reason === "orphan" ? " — прийшов із «Нічийних»: менеджер віддав, за робочий день ніхто не взяв." : "."}
        {" "}У списку й лічильниках менеджера його немає.
      </div>
    );
  }
  if (card.released) {
    const r = card.released;
    return (
      <div style={{ marginTop: 10, fontSize: 12, padding: "8px 10px", borderRadius: 8, background: "#fff7ed", border: "1px solid #fed7aa", display: "flex", flexDirection: "column", gap: 6 }}>
        <div>
          🧭 <b>У «Нічийних»</b> з {fmt(r.at)}{r.fromManagerName ? ` · від ${r.fromManagerName}` : ""}{r.byName && r.byName !== r.fromManagerName ? ` (віддав ${r.byName})` : ""}
          {" "}· «{r.note}»
        </div>
        <div style={{ color: "#9a3412" }}>
          Чекає до <b>{fmt(r.deadline)}</b>: хто з менеджерів візьме — клієнт перейде до нього; ніхто — піде лідгенам.
          Зараз у списку й лічильниках менеджера його немає.
        </div>
        <div>
          <button type="button" disabled={busy} style={btn("#fff", "#374151", "1px solid #d1d5db")} onClick={() => void unrelease()}>
            ↩ Повернути — лишаю за собою
          </button>
        </div>
        {err && <div role="alert" style={{ color: "#b91c1c" }}>⚠️ {err}</div>}
      </div>
    );
  }
  if (!card.canRelease) return null;
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {!open ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" style={btn("#c2410c")} onClick={() => { setOpen(true); setErr(null); }}>🧭 В нічийні</button>
          <span style={{ fontSize: 11, color: "#6b7280" }}>
            Не спрацювались із клієнтом — віддайте: усі менеджери отримають сповіщення, хто хоче — візьме; за робочий день ніхто не взяв — клієнт піде лідгенам.
          </span>
        </div>
      ) : (
        <div style={{ border: "1px solid #fed7aa", borderRadius: 8, padding: 10, background: "#fff7ed", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Чому віддаєте клієнта? (обовʼязково — це побачить той, хто візьме)</div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} autoFocus
            placeholder="наприклад: два місяці не відповідає, контактна особа змінилась, не домовились по ціні…"
            style={{ fontSize: 12, padding: "6px 9px", border: "1px solid #d1d5db", borderRadius: 8, resize: "vertical" }} />
          {err && <div role="alert" style={{ fontSize: 12, color: "#b91c1c" }}>⚠️ {err}</div>}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button type="button" disabled={busy || note.trim().length < min} style={btn("#c2410c")} onClick={() => void release()}>Віддати в нічийні</button>
            <button type="button" disabled={busy} style={btn("#fff", "#374151", "1px solid #d1d5db")} onClick={() => { setOpen(false); setErr(null); }}>Скасувати</button>
            {note.trim().length < min && <span style={{ fontSize: 11, color: "#6b7280" }}>щонайменше {min} символів</span>}
          </div>
        </div>
      )}
    </div>
  );
}
