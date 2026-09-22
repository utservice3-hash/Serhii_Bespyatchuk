import { useEffect, useRef, useState } from "react";
import {
  employeePhotoUrl, uploadEmployeePhoto, removeEmployeePhoto, restoreEmployeePhoto, hiringError,
  type PersonPhoto, type PhotoRef,
} from "../../../api";
import type { Toast } from "./HiringShared";
import "./photos.css";

/**
 * 📷 ФОТО СПІВРОБІТНИКІВ (22.09.2026). Одне фірмове фото на людину з реєстру — живе в «Найм →
 * Співробітники», а показується в номінаціях і на слайдах зустрічі. Завантажують ті, хто має право
 * сейфу; бачать — усі залогінені. Кожна дія скасовна тут же: «Прибрати» ↔ «Повернути попереднє».
 */

/** Ініціали для кола без фото: перші літери двох перших слів ПІБ. */
export const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase() || "?";

/**
 * Коло з фото або ініціалами. `photo` нема — одразу ініціали, без запиту. `size` не задано — розмір
 * бере CSS класу (так роблять слайди, де коло міняється від кількості людей).
 */
export function EmployeePhoto({ photo, name, size, className = "" }: { photo: PhotoRef | null | undefined; name: string; size?: number; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (photo) void employeePhotoUrl(photo).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [photo?.id, photo?.v]); // eslint-disable-line react-hooks/exhaustive-deps
  const style = size ? { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.34)) } : undefined;
  return url
    ? <img className={`ep-av ${className}`} style={style} src={url} alt={name} />
    : <span className={`ep-av ep-ini ${className}`} style={style} aria-label={name}>{initialsOf(name)}</span>;
}

/** Блок «Фірмове фото» у картці людини (вкладка «Профіль»). */
export function PhotoPanel({ employeeId, name, dismissed, info, toast, onChanged }: {
  employeeId: number; name: string; dismissed: boolean; info: PersonPhoto | undefined; toast: Toast; onChanged: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string, undo?: { label: string; run: () => void }) => {
    setBusy(true);
    try { await fn(); toast(ok, undo ? { action: undo } : undefined); onChanged(); } catch (e) { toast(hiringError(e), { error: true }); }
    setBusy(false);
  };
  const photo = info?.hasPhoto ? { id: employeeId, v: info.v } : null;
  const restore = () => void act(() => restoreEmployeePhoto(employeeId), `${name}: повернуто попереднє фото`);
  return (
    <div className="ep-panel">
      <EmployeePhoto photo={photo} name={name} size={96} className="ep-ring" />
      <div className="ep-panel-body">
        <b>Фірмове фото</b>
        <span className="hr-muted">
          Зʼявляється в презентації зустрічі, у номінаціях тижня і на дошці пошани.
          {info?.updatedAt && <> {info.hasPhoto ? "Завантажено" : "Змінено"} {info.updatedAt}{info.updatedBy ? ` · ${info.updatedBy}` : ""}.</>}
        </span>
        <div className="ep-btns">
          {!dismissed && <button className="hr-btn p" disabled={busy} onClick={() => setUploading(true)}>{photo ? "Замінити фото" : "Завантажити фото"}</button>}
          {photo && <button className="hr-btn" disabled={busy}
            onClick={() => void act(() => removeEmployeePhoto(employeeId), `${name}: фото прибрано`, { label: "Повернути", run: restore })}>Прибрати</button>}
          {info?.hasPrev && <button className="hr-btn" disabled={busy} title="Поточне й попереднє фото міняються місцями — натисніть ще раз, щоб повернути як було"
            onClick={restore}>Повернути попереднє</button>}
        </div>
        <span className="hr-muted ep-note">
          {dismissed ? "Людина звільнена — нове фото не завантажується; прибрати чи повернути попереднє можна." : "JPEG, PNG або WebP · фото зменшується до 800 px ще в браузері"}
        </span>
      </div>
      {uploading && <PhotoUploadDialog name={name} onClose={() => setUploading(false)}
        onSave={async (dataUrl) => {
          await uploadEmployeePhoto(employeeId, dataUrl);
          setUploading(false);
          toast(`${name}: фото збережено`);
          onChanged();
        }} />}
    </div>
  );
}

const MAX_SIDE = 800;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** Зменшення в браузері: довша сторона ≤ 800 px, JPEG на білому тлі (прозорий PNG не стане чорним). */
async function shrink(file: File): Promise<string> {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("не вдалося прочитати фото")); i.src = src;
    });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("браузер не дав намалювати фото");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.88);
  } finally { URL.revokeObjectURL(src); }
}

/** Діалог завантаження: перетягнути або обрати файл → одразу видно, як фото ляже в коло. */
export function PhotoUploadDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (dataUrl: string) => Promise<void> }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const take = async (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { setErr("Потрібне фото JPEG, PNG або WebP"); return; }
    if (f.size > MAX_SOURCE_BYTES) { setErr("Файл завеликий — понад 25 МБ"); return; }
    try { setDataUrl(await shrink(f)); } catch (e) { setErr(e instanceof Error ? e.message : "не вдалося прочитати фото"); }
  };
  const save = async () => {
    if (!dataUrl) return;
    setBusy(true); setErr(null);
    try { await onSave(dataUrl); } catch (e) { setErr(hiringError(e)); setBusy(false); }
  };
  return (
    <div className="hr-modal-back" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="hr-modal ep-dlg" role="dialog" aria-label={`Фото: ${name}`} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Фото: {name}</h3>
        <div className="ep-up">
          <div className={`ep-drop ${over ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files?.[0]); }}>
            <b>Перетягніть фото сюди</b>
            <span className="hr-muted">або</span>
            <button className="hr-btn" onClick={() => input.current?.click()}>Обрати файл</button>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void take(e.target.files?.[0])} />
            <span className="hr-muted ep-note">JPEG, PNG або WebP</span>
          </div>
          <div className="ep-prev">
            <span className="hr-muted">Так фото виглядатиме:</span>
            <div className="ep-pv-row">
              <div className="ep-pv">{dataUrl ? <img className="ep-pv-big" src={dataUrl} alt="" /> : <span className="ep-pv-big ep-ini">{initialsOf(name)}</span>}<span>слайд</span></div>
              <div className="ep-pv">{dataUrl ? <img className="ep-pv-small" src={dataUrl} alt="" /> : <span className="ep-pv-small ep-ini">{initialsOf(name)}</span>}<span>таблиця</span></div>
            </div>
            <span className="hr-muted ep-note">Обріжеться по колу від центру. Перед відправкою фото зменшується до 800 px.</span>
          </div>
        </div>
        {err && <div style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="hr-btn" onClick={onClose}>Скасувати</button>
          <button className="hr-btn p" disabled={!dataUrl || busy} onClick={() => void save()}>{busy ? "Зберігаю…" : "Зберегти фото"}</button>
        </div>
      </div>
    </div>
  );
}
