import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../../../components/Dialogs";
import { rejectNote, failureReason } from "../../../actionFeedback";
import {
  fetchFeedback,
  submitFeedback,
  updateFeedback,
  uploadFeedbackFile,
  deleteFeedbackFile,
  fetchFeedbackFileBlobUrl,
  FEEDBACK_FILE_MAX_BYTES,
  FEEDBACK_FILES_PER_ITEM,
  type FeedbackItem,
  type FeedbackFile,
  type FeedbackStatus,
} from "../../../api";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Відсіює те, що сервер однаково відхилить, — щоб людина дізналась ДО надсилання, а не після. */
function acceptImages(files: File[], room: number): { ok: File[]; problems: string[] } {
  const ok: File[] = [];
  const problems: string[] = [];
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) { problems.push(`«${f.name}» — не фото (можна JPG, PNG, WEBP)`); continue; }
    if (f.size > FEEDBACK_FILE_MAX_BYTES) { problems.push(`«${f.name}» — більше 5 МБ`); continue; }
    if (ok.length >= room) { problems.push(`не більше ${FEEDBACK_FILES_PER_ITEM} фото на звернення`); break; }
    ok.push(f);
  }
  return { ok, problems };
}

/** Мініатюра фото: байти тягнемо з токеном (blob), бо тека фото не публічна. Клік — повний розмір. */
function FeedbackThumb({ itemId, file, onDelete }: { itemId: number; file: FeedbackFile; onDelete?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    fetchFeedbackFileBlobUrl(itemId, file.id)
      .then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [itemId, file.id]);
  return (
    <div style={{ position: "relative", width: 76, height: 76, borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", background: "var(--card-bg)", flex: "0 0 auto" }}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title={file.name}>
          <img src={url} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </a>
      ) : (
        <span style={{ fontSize: 10, color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center", padding: 4 }}>
          {failed ? "фото недоступне" : "…"}
        </span>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} title="Прибрати фото" aria-label="Прибрати фото"
          style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, cursor: "pointer", lineHeight: "20px", padding: 0 }}>✕</button>
      )}
    </div>
  );
}

/** Зона додавання фото: кнопка, перетягування, Ctrl+V. Кладе файли через `onFiles`, решту вирішує власник. */
function PhotoDrop({ onFiles, room, compact = false }: { onFiles: (f: File[]) => void; room: number; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  if (room <= 0) return null;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}
      onClick={() => input.current?.click()}
      role="button"
      style={{ border: `1px dashed ${over ? "#c5141c" : "var(--border)"}`, borderRadius: 8, padding: compact ? "6px 10px" : "10px 12px", fontSize: 12, color: "var(--text-muted)", cursor: "pointer", textAlign: "center", background: over ? "rgba(197,20,28,0.05)" : "transparent" }}
    >
      📷 {compact ? "Додати фото" : "Додати фото — перетягніть, вставте з буфера (Ctrl+V) або натисніть"} · JPG/PNG/WEBP до 5 МБ · ще {room}
      <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden
        onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    </div>
  );
}

const STATUS_META: Record<FeedbackStatus, { label: string; color: string; bg: string }> = {
  pending: { label: "На розгляді", color: "#b45309", bg: "rgba(245,158,11,0.15)" },
  approved: { label: "Схвалено", color: "#1d4ed8", bg: "rgba(37,99,235,0.15)" },
  rejected: { label: "Відхилено", color: "#b91c1c", bg: "rgba(220,38,38,0.15)" },
  resolved: { label: "Вирішено", color: "#15803d", bg: "rgba(22,163,74,0.15)" },
};

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const m = STATUS_META[status];
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color: m.color, background: m.bg, padding: "2px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {m.label}
    </span>
  );
}

export function FeedbackSection({ isAdmin }: { isAdmin: boolean }) {
  const dlg = useDialogs();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [section, setSection] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<FeedbackStatus | "all">("all");
  // 📷 Фото, вибрані до надсилання (ще не на сервері), і їхні прев'ю.
  const [pending, setPending] = useState<File[]>([]);
  const [pendingUrls, setPendingUrls] = useState<string[]>([]);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  useEffect(() => {
    const urls = pending.map((f) => URL.createObjectURL(f));
    setPendingUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [pending]);

  function addPending(files: File[]) {
    const { ok, problems } = acceptImages(files, FEEDBACK_FILES_PER_ITEM - pending.length);
    setPhotoErr(problems.length ? problems.join("; ") : null);
    if (ok.length) setPending((p) => [...p, ...ok]);
  }

  async function addToItem(item: FeedbackItem, files: File[]) {
    const { ok, problems } = acceptImages(files, FEEDBACK_FILES_PER_ITEM - item.files.length);
    const errs = [...problems];
    for (const f of ok) {
      try { await uploadFeedbackFile(item.id, f); } catch (e) { errs.push(`«${f.name}»: ${failureReason(e, "не завантажилось")}`); }
    }
    setPhotoErr(errs.length ? errs.join("; ") : null);
    if (ok.length) load();
  }

  async function removeFile(itemId: number, fileId: number) {
    if (!(await dlg.confirm("Прибрати це фото?"))) return;
    try {
      await deleteFeedbackFile(itemId, fileId);
      setItems((prev) => prev.map((x) => (x.id === itemId ? { ...x, files: x.files.filter((f) => f.id !== fileId) } : x)));
    } catch (e) {
      setPhotoErr(failureReason(e, "Фото не прибралось"));
    }
  }

  const load = () => {
    setLoading(true);
    fetchFeedback().then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  async function send() {
    if (!message.trim()) return;
    setSaving(true);
    try {
      const created = await submitFeedback({ message: message.trim(), section: section.trim() || undefined });
      setItems((prev) => [created, ...prev]);
      setMessage("");
      setSection("");
      // Фото — після створення: їм потрібен id звернення. Невдале фото називаємо, текст уже збережено.
      const errs: string[] = [];
      for (const f of pending) {
        try { await uploadFeedbackFile(created.id, f); } catch (e) { errs.push(`«${f.name}»: ${failureReason(e, "не завантажилось")}`); }
      }
      setPending([]);
      setPhotoErr(errs.length ? `Звернення надіслано, але не всі фото: ${errs.join("; ")}` : null);
      if (pending.length) load();
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id: number, status: FeedbackStatus) {
    // «Скасувати» у вікні коментаря — нічого не робимо. Було `?? undefined`, і скасування однаково
    // ВІДХИЛЯЛО звернення (30.09.2026, `#1103`).
    let note: string | undefined;
    if (status === "rejected") {
      const r = rejectNote((await dlg.prompt("Коментар (необовʼязково):")));
      if (!r.reject) return;
      note = r.note;
    }
    const updated = await updateFeedback(id, { status, adminNote: note });
    setItems((prev) => prev.map((x) => (x.id === id ? updated : x)));
  }

  const shown = filter === "all" ? items : items.filter((x) => x.status === filter);
  const counts = items.reduce((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {} as Record<string, number>);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Зворотний звʼязок</h1>
      </div>

      <div className="chart-card" style={{ marginBottom: 16 }}>
        <h2 className="chart-title">Повідомити про баг або запропонувати правку</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0 }}>
          Опишіть, що не так або що варто змінити, і за потреби додайте скриншот. Адміністратор схвалить чи відхилить, після чого правку буде виконано.
          Закриті звернення («вирішено», «відхилено») разом із фото видаляються через 30 днів.
        </p>
        <input
          value={section}
          onChange={(e) => setSection(e.target.value)}
          placeholder="Розділ (напр. «Огляд», «Звіт») — необовʼязково"
          style={{ width: "100%", marginBottom: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)" }}
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Опишіть проблему або пропозицію…"
          rows={4}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (imgs.length) { e.preventDefault(); addPending(imgs); }
          }}
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", resize: "vertical" }}
        />
        <div style={{ marginTop: 8 }}>
          <PhotoDrop onFiles={addPending} room={FEEDBACK_FILES_PER_ITEM - pending.length} />
          {pending.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {pending.map((f, i) => (
                <div key={i} style={{ position: "relative", width: 76, height: 76, borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden" }}>
                  {pendingUrls[i] && <img src={pendingUrls[i]} alt={f.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  <button type="button" onClick={() => setPending((p) => p.filter((_, j) => j !== i))} title="Прибрати" aria-label="Прибрати"
                    style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, cursor: "pointer", padding: 0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          {photoErr && <div role="alert" style={{ color: "#b91c1c", fontSize: 12, marginTop: 6 }}>{photoErr}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn-primary" onClick={send} disabled={saving || !message.trim()}
            style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: saving || !message.trim() ? "#94a3b8" : "#c5141c", color: "#fff", fontWeight: 600, cursor: saving || !message.trim() ? "default" : "pointer" }}>
            {saving ? "Надсилання…" : "Надіслати"}
          </button>
        </div>
      </div>

      <div className="chart-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>{isAdmin ? "Усі звернення" : "Мої звернення"}</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as FeedbackStatus | "all")}>
            <option value="all">Усі ({items.length})</option>
            <option value="pending">На розгляді ({counts.pending ?? 0})</option>
            <option value="approved">Схвалено ({counts.approved ?? 0})</option>
            <option value="resolved">Вирішено ({counts.resolved ?? 0})</option>
            <option value="rejected">Відхилено ({counts.rejected ?? 0})</option>
          </select>
        </div>
        {loading ? (
          <p className="loading-text">Завантаження…</p>
        ) : shown.length === 0 ? (
          <p className="loading-text">Немає звернень.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
            {shown.map((f) => (
              <div key={f.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <StatusBadge status={f.status} />
                    {f.section && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {f.section}</span>}
                    {isAdmin && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {f.authorName}</span>}
                  </div>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(f.createdAt).toLocaleString("uk-UA")}</span>
                </div>
                <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{f.message}</div>
                {f.files.length > 0 && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {f.files.map((file) => (
                      <FeedbackThumb key={file.id} itemId={f.id} file={file} onDelete={() => removeFile(f.id, file.id)} />
                    ))}
                  </div>
                )}
                {f.files.length < FEEDBACK_FILES_PER_ITEM && (
                  <div style={{ marginTop: 8, maxWidth: 360 }}>
                    <PhotoDrop compact onFiles={(fs) => addToItem(f, fs)} room={FEEDBACK_FILES_PER_ITEM - f.files.length} />
                  </div>
                )}
                {f.purgeAt && (
                  <div data-testid="feedback-purge-at" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                    🗑 Видалиться {new Date(f.purgeAt).toLocaleDateString("uk-UA")} разом із фото — через 30 днів після закриття
                  </div>
                )}
                {f.adminNote && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontStyle: "italic" }}>Коментар адміна: {f.adminNote}</div>
                )}
                {isAdmin && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    {f.status === "pending" && (
                      <>
                        <button onClick={() => setStatus(f.id, "approved")} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#1d4ed8", color: "#fff", fontWeight: 600, cursor: "pointer" }}>✓ Схвалити</button>
                        <button onClick={() => setStatus(f.id, "rejected")} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>✕ Відхилити</button>
                      </>
                    )}
                    {f.status === "approved" && (
                      <button onClick={() => setStatus(f.id, "resolved")} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#16a34a", color: "#fff", fontWeight: 600, cursor: "pointer" }}>✔ Позначити вирішеним</button>
                    )}
                    {(f.status === "rejected" || f.status === "resolved") && (
                      <button onClick={() => setStatus(f.id, "pending")} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", cursor: "pointer" }}>↩ Повернути на розгляд</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
