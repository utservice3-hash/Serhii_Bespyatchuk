import { useEffect, useMemo, useState } from "react";
import {
  fetchTrainingTree, createTrainingFolder, updateTrainingFolder, deleteTrainingFolder,
  createTrainingMaterial, updateTrainingMaterial, deleteTrainingMaterial, fetchTrainingFileBlobUrl,
  type TrainingFolder, type TrainingMaterial, type TrainingKind, publishTrainingMaterial } from "../../../api";

const MAX_MB = 45;
const ACC = "#c5141c";

const KIND_META: Record<TrainingKind, { icon: string; label: string }> = {
  video_embed: { icon: "🎬", label: "Відео (посилання)" },
  file: { icon: "📄", label: "Файл" },
  link: { icon: "🔗", label: "Посилання" },
  text: { icon: "📝", label: "Текст" },
};

function fmtBytes(n: string | number | null): string {
  const b = Number(n ?? 0);
  if (!b) return "";
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}

/** YouTube/Vimeo/пряме відео → URL для <iframe>, або null якщо це пряме відео-файлове посилання. */
function embedUrl(raw: string): { iframe?: string; direct?: string } {
  const url = raw.trim();
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { iframe: `https://www.youtube.com/embed/${yt[1]}` };
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return { iframe: `https://player.vimeo.com/video/${vimeo[1]}` };
  if (/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(url)) return { direct: url };
  return { iframe: url }; // інший embed — пробуємо як iframe
}

function MaterialViewer({ material, onClose, isAdmin, onChanged }: { material: TrainingMaterial; onClose: () => void; isAdmin?: boolean; onChanged?: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (material.kind !== "file") return;
    let u: string | null = null;
    fetchTrainingFileBlobUrl(material.id).then((url) => { u = url; setBlobUrl(url); }).catch(() => setBlobUrl(null));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [material.id, material.kind]);

  const isVideoFile = material.kind === "file" && (material.mime?.startsWith("video/") ?? false);
  const isImageFile = material.kind === "file" && (material.mime?.startsWith("image/") ?? false);
  const isPdf = material.kind === "file" && material.mime === "application/pdf";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 20, width: "92vw", maxWidth: 920, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>{KIND_META[material.kind].icon} {material.title}</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>

        {material.kind === "video_embed" && material.url && (() => {
          const e = embedUrl(material.url);
          if (e.direct) return <video src={e.direct} controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />;
          return (
            <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden", background: "#000" }}>
              <iframe src={e.iframe} title={material.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }} />
            </div>
          );
        })()}

        {isVideoFile && blobUrl && <video src={blobUrl} controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />}
        {isImageFile && blobUrl && <img src={blobUrl} alt={material.title} style={{ maxWidth: "100%", borderRadius: 8 }} />}
        {isPdf && blobUrl && <iframe src={blobUrl} title={material.title} style={{ width: "100%", height: "70vh", border: 0, borderRadius: 8 }} />}
        {material.kind === "file" && !isVideoFile && !isImageFile && !isPdf && (
          <div style={{ padding: 20, textAlign: "center" }}>
            {blobUrl ? (
              <a href={blobUrl} download={material.title} style={{ color: ACC, fontWeight: 600, fontSize: 15 }}>⬇️ Завантажити «{material.title}»</a>
            ) : <span className="loading-text">Завантаження…</span>}
          </div>
        )}

        {material.kind === "link" && material.url && (
          <div style={{ padding: 16 }}>
            <a href={material.url} target="_blank" rel="noreferrer" style={{ color: ACC, fontWeight: 600, fontSize: 15 }}>🔗 Відкрити: {material.url}</a>
          </div>
        )}

        {material.status === "draft" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12,
                        padding: "9px 12px", borderRadius: 10, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.3)" }}>
            <b style={{ fontSize: 12, color: "#d97706" }}>
              ✎ ЧЕРНЕТКА{material.created_by_ai ? " · створено АІ" : ""}
            </b>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Бачить лише адмін. Перевір текст і встав скріни там, де стоїть позначка [СКРІН: …], тоді публікуй.
            </span>
            {isAdmin && (
              <button onClick={() => { void publishTrainingMaterial(material.id).then(() => { onChanged?.(); onClose(); }); }}
                style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 8, border: "none",
                         background: "#16a34a", color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 12.5 }}>
                ✓ Опублікувати
              </button>
            )}
          </div>
        )}

        {material.kind === "text" && (
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 }}>{material.content}</div>
        )}

        {material.content && material.kind !== "text" && (
          <p style={{ marginTop: 12, color: "var(--text-muted)", fontSize: 13, whiteSpace: "pre-wrap" }}>{material.content}</p>
        )}
      </div>
    </div>
  );
}

function AddMaterialModal({ folderId, onClose, onAdded }: { folderId: number | null; onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<TrainingKind>("video_embed");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim()) { setErr("Вкажіть назву"); return; }
    setBusy(true); setErr(null);
    try {
      if (kind === "file") {
        if (!file) { setErr("Оберіть файл"); setBusy(false); return; }
        if (file.size > MAX_MB * 1024 * 1024) { setErr(`Файл більше ${MAX_MB} МБ — для великих відео вставте посилання (YouTube/Vimeo)`); setBusy(false); return; }
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file);
        });
        await createTrainingMaterial({ folderId, title: title.trim(), kind: "file", filename: file.name, mime: file.type || null, dataBase64, content: content.trim() || null });
      } else if (kind === "text") {
        await createTrainingMaterial({ folderId, title: title.trim(), kind: "text", content: content.trim() });
      } else {
        await createTrainingMaterial({ folderId, title: title.trim(), kind, url: url.trim(), content: content.trim() || null });
      }
      onAdded();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg ?? "Не вдалося зберегти");
    } finally { setBusy(false); }
  };

  const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", fontSize: 14 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: 12, padding: 22, width: "92vw", maxWidth: 520, maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>➕ Новий матеріал</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "4px 12px" }}>✕</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(Object.keys(KIND_META) as TrainingKind[]).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: kind === k ? 700 : 500,
                  border: `1px solid ${kind === k ? ACC : "var(--border)"}`, background: kind === k ? ACC : "var(--card-bg)", color: kind === k ? "#fff" : "var(--text)" }}>
                {KIND_META[k].icon} {KIND_META[k].label}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>Назва
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Напр. «Скрипт першого дзвінка»" style={inp} autoFocus />
          </label>

          {kind === "video_embed" && (
            <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>Посилання на відео (YouTube / Vimeo / пряме .mp4)
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…" style={inp} />
            </label>
          )}
          {kind === "link" && (
            <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>Посилання
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={inp} />
            </label>
          )}
          {kind === "file" && (
            <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>Файл (до {MAX_MB} МБ; великі відео — через посилання)
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={inp} />
            </label>
          )}
          <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            {kind === "text" ? "Текст матеріалу" : "Опис (необовʼязково)"}
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={kind === "text" ? 8 : 3} style={{ ...inp, resize: "vertical" }} />
          </label>

          {err && <div style={{ color: ACC, fontSize: 13 }}>{err}</div>}
          <button onClick={save} disabled={busy}
            style={{ padding: "10px 14px", borderRadius: 8, border: "none", background: ACC, color: "#fff", fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Збереження…" : "Додати матеріал"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Навчання — навчальна база. Адмін (КВП) будує структуру папок і розміщує
 * матеріали (відео/файли/посилання/текст). Решта — переглядають.
 */
export function TrainingSection({ isAdmin }: { isAdmin: boolean }) {
  const [folders, setFolders] = useState<TrainingFolder[]>([]);
  const [materials, setMaterials] = useState<TrainingMaterial[]>([]);
  const [cwd, setCwd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<TrainingMaterial | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const t = await fetchTrainingTree(); setFolders(t.folders); setMaterials(t.materials); setErr(null); }
    catch { setErr("Не вдалося завантажити навчання."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const breadcrumb = useMemo(() => {
    const p: TrainingFolder[] = [];
    let cur = cwd != null ? byId.get(cwd) : undefined;
    while (cur) { p.unshift(cur); cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined; }
    return p;
  }, [cwd, byId]);

  const subFolders = folders.filter((f) => f.parent_id === cwd);
  const curMaterials = materials.filter((m) => m.folder_id === cwd);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e) { const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error; setErr(msg ?? "Дію не вдалося виконати."); }
    finally { setBusy(false); }
  };

  const onNewFolder = () => { const name = window.prompt("Назва нової папки:")?.trim(); if (name) void guard(() => createTrainingFolder(name, cwd)); };
  const onRenameFolder = (f: TrainingFolder) => { const name = window.prompt("Нова назва папки:", f.name)?.trim(); if (name && name !== f.name) void guard(() => updateTrainingFolder(f.id, { name })); };
  const onDeleteFolder = (f: TrainingFolder) => { if (window.confirm(`Видалити папку «${f.name}» з усім вмістом?`)) void guard(() => deleteTrainingFolder(f.id)); };
  const onRenameMaterial = (m: TrainingMaterial) => { const title = window.prompt("Нова назва:", m.title)?.trim(); if (title && title !== m.title) void guard(() => updateTrainingMaterial(m.id, { title })); };
  const onDeleteMaterial = (m: TrainingMaterial) => { if (window.confirm(`Видалити «${m.title}»?`)) void guard(() => deleteTrainingMaterial(m.id)); };

  return (
    <div>
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 className="page-title">📚 Навчання</h1>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-secondary" onClick={onNewFolder} disabled={busy}>➕ Папка</button>
            <button className="btn-secondary" onClick={() => setAdding(true)} disabled={busy} style={{ background: ACC, color: "#fff", border: "none" }}>➕ Матеріал</button>
          </div>
        )}
      </div>

      {!isAdmin && <p className="loading-text" style={{ marginTop: -4 }}>Навчальні відео та матеріали. Керування — у керівника відділу продажу.</p>}

      {/* Хлібні крихти */}
      <div className="chart-card" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 14 }}>
        <button onClick={() => setCwd(null)} style={{ background: "none", border: "none", cursor: "pointer", color: cwd === null ? "var(--text)" : ACC, fontWeight: cwd === null ? 700 : 500, padding: 0 }}>🏠 Головна</button>
        {breadcrumb.map((f) => (
          <span key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#999" }}>/</span>
            <button onClick={() => setCwd(f.id)} style={{ background: "none", border: "none", cursor: "pointer", color: f.id === cwd ? "var(--text)" : ACC, fontWeight: f.id === cwd ? 700 : 500, padding: 0 }}>{f.name}</button>
          </span>
        ))}
      </div>

      {err && <p style={{ color: ACC, fontSize: 13 }}>{err}</p>}

      {loading ? <p className="loading-text">Завантаження…</p> : (
        <>
          {/* Папки */}
          {subFolders.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginBottom: 14 }}>
              {subFolders.map((f) => (
                <div key={f.id} className="chart-card" style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", margin: 0 }}>
                  <button onClick={() => setCwd(f.id)} style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer", fontSize: 15, fontWeight: 600, color: "var(--text)", display: "flex", gap: 8, alignItems: "center", padding: 0 }}>📁 {f.name}</button>
                  {isAdmin && (<>
                    <button title="Перейменувати" onClick={() => onRenameFolder(f)} disabled={busy} style={{ background: "none", border: "none", cursor: "pointer" }}>✏️</button>
                    <button title="Видалити" onClick={() => onDeleteFolder(f)} disabled={busy} style={{ background: "none", border: "none", cursor: "pointer" }}>🗑️</button>
                  </>)}
                </div>
              ))}
            </div>
          )}

          {/* Матеріали */}
          {curMaterials.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
              {curMaterials.map((m) => (
                <div key={m.id} className="chart-card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  <button onClick={() => setViewing(m)} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "var(--text)" }}>
                    <div style={{ fontSize: 30, marginBottom: 4 }}>{KIND_META[m.kind].icon}</div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{m.title}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                      {KIND_META[m.kind].label}{m.size_bytes ? ` · ${fmtBytes(m.size_bytes)}` : ""}{m.author ? ` · ${m.author}` : ""}
                    </div>
                    {m.content && m.kind !== "text" && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{m.content}</div>}
                  </button>
                  {isAdmin && (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                      <button title="Перейменувати" onClick={() => onRenameMaterial(m)} disabled={busy} style={{ background: "none", border: "none", cursor: "pointer" }}>✏️</button>
                      <button title="Видалити" onClick={() => onDeleteMaterial(m)} disabled={busy} style={{ background: "none", border: "none", cursor: "pointer" }}>🗑️</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : subFolders.length === 0 && (
            <div className="chart-card"><p className="loading-text" style={{ margin: 0 }}>{isAdmin ? "Порожньо. Створіть папку або додайте матеріал." : "Тут поки немає матеріалів."}</p></div>
          )}
        </>
      )}

      {viewing && <MaterialViewer material={viewing} onClose={() => setViewing(null)} isAdmin={isAdmin} onChanged={load} />}
      {adding && <AddMaterialModal folderId={cwd} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />}
    </div>
  );
}
