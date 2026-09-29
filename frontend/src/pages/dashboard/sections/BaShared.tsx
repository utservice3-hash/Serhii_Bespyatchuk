import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { uploadBaFile, fetchBaFileBlobUrl, hiringError, type BaDocType, type BaEvent, type BaFile, type BaFileKind } from "../../../api";

/** Файл картки: у справи він може бути «з претензії», у видачі — ні. */
type CardFile = Omit<BaFile, "fromClaim"> & { fromClaim?: boolean };

/**
 * 🗂 БІЗНЕС-АСИСТЕНТ — спільне для вкладок: формати, спливаюче повідомлення, документи картки,
 * історія, закриття Escape. Винесено з `BusinessAssistantSection.tsx` у проході 2 (29.09.2026),
 * щоб «Облік техніки» (договори до видачі) брав той самий блок документів, а не копію.
 */
export type Toast = (text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }) => void;
export const money = (n: number | null) => (n == null ? "—" : `${n.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} ₴`);
export const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
export const fmtTs = (ts: string) => new Date(ts).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** Сьогодні за Києвом, `YYYY-MM-DD` — для дат видачі й повернення за замовчуванням. */
export const todayKyiv = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

/** Документи картки: список, перегляд (blob з токеном), додавання з типом. Видалення немає — документ справи є доказом. */
export function Docs({ kind, ownerId, files, types, maxBytes, toast, onAdded }: {
  kind: BaFileKind; ownerId: number; files: CardFile[]; types: { key: BaDocType; label: string }[];
  maxBytes: number; toast: Toast; onAdded: () => void;
}) {
  const [docType, setDocType] = useState<BaDocType>(types[0]?.key ?? "other");
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!file) { toast("Оберіть файл", { error: true }); return; }
    if (file.size > maxBytes) { toast("Файл більший за 10 МБ", { error: true }); return; }
    setBusy(true);
    try { await uploadBaFile(kind, ownerId, file, docType); setFile(null); setInputKey((k) => k + 1); onAdded(); toast("Документ додано"); }
    catch (e) { toast(hiringError(e), { error: true }); } finally { setBusy(false); }
  };
  // Перегляд — на місці, а не новою вкладкою: вкладку, відкриту після очікування, блокувальник
  // гасить мовчки (так «не клікався» скрин у задачі 4310). DOCX браузер не показує — лише «Завантажити».
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const view = async (f: CardFile) => {
    try { setPreview({ url: await fetchBaFileBlobUrl(kind, ownerId, f.id), name: f.name, mime: f.mime }); }
    catch (e) { toast(hiringError(e), { error: true }); }
  };
  const closePreview = () => { if (preview) URL.revokeObjectURL(preview.url); setPreview(null); };
  return (
    <div className="hr-sect" style={{ marginTop: 14, paddingLeft: 0, paddingRight: 0 }}>
      <h4>{kind === "claims" ? "Документи" : "Файли"} · {files.length}</h4>
      {!files.length && <p className="hr-muted" style={{ margin: "0 0 8px" }}>Документів ще немає.</p>}
      {files.map((f) => (
        <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
          <span className="hr-pill gr">{f.docTypeLabel}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}{f.fromClaim && <span className="hr-muted"> · з претензії</span>}</span>
          <span className="hr-muted">{fmtTs(f.createdAt).slice(0, 10)}</span>
          <button className="hr-btn xs" onClick={() => void view(f)}>Переглянути</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <select className="hr-inp" value={docType} onChange={(e) => setDocType(e.target.value as BaDocType)} aria-label="Тип документа">
          {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <input key={inputKey} type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Файл" />
        <button className="hr-btn xs" disabled={busy || !file} onClick={() => void add()}>Додати документ</button>
      </div>
      <p className="hr-muted" style={{ margin: "6px 0 0" }}>PDF, DOCX, PNG, JPG або WEBP, до 10 МБ.</p>
      {preview && createPortal(
        <div className="hr-modal-back" onClick={closePreview}>
          <div className="hr-modal" style={{ maxWidth: 900, width: "94vw" }} role="dialog" aria-label={`Документ ${preview.name}`} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.name}</b>
              <a className="hr-btn xs" href={preview.url} download={preview.name}>Завантажити</a>
              <button className="hr-btn xs" onClick={closePreview} aria-label="Закрити перегляд">×</button>
            </div>
            {preview.mime.startsWith("image/")
              ? <img src={preview.url} alt={preview.name} style={{ maxWidth: "100%", maxHeight: "75vh", display: "block", margin: "0 auto" }} />
              : preview.mime === "application/pdf"
                ? <iframe src={preview.url} title={preview.name} style={{ width: "100%", height: "75vh", border: 0 }} />
                : <p className="hr-muted" style={{ margin: 0 }}>Цей формат браузер не показує. Натисніть «Завантажити», щоб відкрити файл.</p>}
          </div>
        </div>, document.body)}
    </div>
  );
}

export function History({ events }: { events: BaEvent[] }) {
  return (
    <div className="hr-sect" style={{ paddingLeft: 0, paddingRight: 0 }}>
      <h4>Історія</h4>
      {!events.length ? <p className="hr-muted" style={{ margin: 0 }}>Подій ще немає.</p> : (
        <ul className="hr-hist">
          {events.map((e, i) => <li key={i}><span className="hr-muted">{fmtTs(e.at)}{e.actor ? ` · ${e.actor}` : ""}</span><br />{e.what}</li>)}
        </ul>
      )}
    </div>
  );
}
