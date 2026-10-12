import { useEffect, useState } from "react";
import { useDialogs } from "../../../components/Dialogs";
import { fetchCarrierCandidates, archiveCarriers, type CarrierCandidate } from "../../../api";

/**
 * 🚚 ПЛАШКА «ПЕРЕВІЗНИК У КОМЕНТАРІ» (05.10.2026, зворотний звʼязок #104/#69).
 *
 * Менеджер пише в коментарі клієнта «перевізник», але архівувати не може. Тімлід (і керівництво)
 * бачить тут таких клієнтів своєї команди й архівує вибраних одним кліком із причиною «Перевізник».
 * Галочки УВІМКНЕНІ за замовчуванням (рішення Романа 05.10): здебільшого це справді перевізники,
 * текст коментаря стоїть поруч, і тімлід знімає зайві. Скасовується «↩ повернути з архіву».
 * Немає кандидатів або немає права — плашки немає зовсім (сервер віддає 403 менеджеру й HR).
 */
export function CarrierCommentBanner({ onArchived }: { onArchived: () => void }) {
  const dlg = useDialogs();
  const [rows, setRows] = useState<CarrierCandidate[] | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => fetchCarrierCandidates()
    .then((d) => { setRows(d.clients); setPicked(new Set(d.clients.map((c) => c.clientKey))); })
    .catch(() => setRows([]));
  useEffect(() => { void load(); }, []);

  if (!rows || (rows.length === 0 && !msg)) return null;

  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOn = rows.length > 0 && picked.size === rows.length;
  const submit = async () => {
    if (picked.size === 0) return;
    if (!(await dlg.confirm(`Архівувати ${picked.size} клієнт(ів) з причиною «Перевізник»?\nПовернути можна в «Архіві» кнопкою «↩ повернути з архіву».`))) return;
    setBusy(true); setMsg(null);
    try {
      const r = await archiveCarriers([...picked]);
      setMsg(`Заархівовано ${r.archived}` + (r.skipped.length ? ` · пропущено ${r.skipped.length} (уже в архіві або не з вашої команди)` : ""));
      await load();
      onArchived();
    } catch (e) {
      setMsg((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Не вдалося заархівувати");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: "1px solid #f59e0b", background: "rgba(245,158,11,0.08)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>⚠ {rows.length} клієнт(ів) з коментарем «перевізник» ще в списку</span>
        {rows.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} style={{ padding: "4px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 12.5 }}>
            {open ? "сховати" : "переглянути й архівувати"}
          </button>
        )}
        {msg && <span style={{ fontSize: 12.5, color: "#2f6fdb" }}>{msg}</span>}
      </div>
      {open && rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ minWidth: 640 }}>
              <thead><tr>
                <th style={{ width: 28 }}><input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((c) => c.clientKey)))} title="усі / жодного" /></th>
                <th style={{ textAlign: "left" }}>Клієнт</th>
                <th style={{ textAlign: "left" }}>Менеджер</th>
                <th style={{ textAlign: "left" }}>Коментар</th>
              </tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.clientKey}>
                    <td><input type="checkbox" checked={picked.has(c.clientKey)} onChange={() => toggle(c.clientKey)} /></td>
                    <td style={{ textAlign: "left" }}><b>{c.clientName}</b></td>
                    <td style={{ textAlign: "left", fontSize: 12.5 }}>{c.managerName ?? "—"}{c.teamName ? <span style={{ color: "#6b7280" }}> · {c.teamName}</span> : null}</td>
                    <td style={{ textAlign: "left", fontSize: 12.5 }}>
                      «{c.comment}»
                      <div style={{ color: "#6b7280", fontSize: 11.5 }}>{c.commentBy ?? "—"} · {c.commentedAt}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            <button disabled={busy || picked.size === 0} onClick={() => void submit()}
              style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#c8102e", color: "#fff", fontWeight: 700, cursor: picked.size ? "pointer" : "not-allowed", opacity: picked.size ? 1 : 0.5 }}>
              {busy ? "Архівую…" : `Архівувати вибрані (${picked.size}) як «Перевізник»`}
            </button>
            <span style={{ fontSize: 12, color: "#6b7280" }}>Зніміть галочки з тих, хто не перевізник. Клієнт іде в «Архів» і зникає з постійних і реактивації.</span>
          </div>
        </div>
      )}
    </div>
  );
}
