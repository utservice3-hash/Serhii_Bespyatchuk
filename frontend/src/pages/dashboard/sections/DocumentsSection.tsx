import { useEffect, useMemo, useState } from "react";
import {
  fetchDocTree, createDocFolder, renameDocFolder, deleteDocFolder,
  uploadDocFile, updateDocFile, deleteDocFile, fetchDocFileBlobUrl,
  DOC_CATEGORIES, type DocFolder, type DocFile,
} from "../../../api";

const MAX_MB = 50;

function fmtBytes(n: string | number | null): string {
  const b = Number(n ?? 0);
  if (!b) return "—";
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}
function fmtDate(s: string): string {
  try { return new Date(s).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return "—"; }
}
function iconFor(name: string, mime: string | null): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime?.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["doc", "docx"].includes(ext)) return "📘";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📗";
  if (["ppt", "pptx"].includes(ext)) return "📙";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
  return "📄";
}
const CAT_COLOR: Record<string, string> = {
  "Регламент": "#c5141c", "Шаблон": "#1971c2", "Інструкція": "#2f9e44", "Інше": "#868e96",
};

export function DocumentsSection({ isAdmin }: { isAdmin: boolean }) {
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [files, setFiles] = useState<DocFile[]>([]);
  const [cwd, setCwd] = useState<number | null>(null); // null = корінь
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [uploadCat, setUploadCat] = useState<string>("Регламент");
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [dragOver, setDragOver] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const t = await fetchDocTree();
      setFolders(t.folders);
      setFiles(t.files);
      setErr(null);
    } catch { setErr("Не вдалося завантажити документи."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const breadcrumb = useMemo(() => {
    const path: DocFolder[] = [];
    let cur = cwd != null ? byId.get(cwd) : undefined;
    while (cur) { path.unshift(cur); cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined; }
    return path;
  }, [cwd, byId]);

  const q = search.trim().toLowerCase();
  const subFolders = folders
    .filter((f) => f.parent_id === cwd)
    .filter((f) => !q || f.name.toLowerCase().includes(q));
  const curFiles = files
    .filter((f) => f.folder_id === cwd)
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .filter((f) => !catFilter || f.category === catFilter);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg ?? "Дію не вдалося виконати.");
    } finally { setBusy(false); }
  };

  const onNewFolder = () => {
    const name = window.prompt("Назва нової папки:")?.trim();
    if (name) void guard(() => createDocFolder(name, cwd));
  };
  const onRenameFolder = (f: DocFolder) => {
    const name = window.prompt("Нова назва папки:", f.name)?.trim();
    if (name && name !== f.name) void guard(() => renameDocFolder(f.id, name));
  };
  const onDeleteFolder = (f: DocFolder) => {
    if (window.confirm(`Видалити папку «${f.name}» з усім вмістом? Дію не відмінити.`))
      void guard(() => deleteDocFolder(f.id));
  };
  const onRenameFile = (f: DocFile) => {
    const name = window.prompt("Нова назва файла:", f.name)?.trim();
    if (name && name !== f.name) void guard(() => updateDocFile(f.id, { name }));
  };
  const onChangeCategory = (f: DocFile, category: string) => {
    void guard(() => updateDocFile(f.id, { category: category || null }));
  };
  const onDeleteFile = (f: DocFile) => {
    if (window.confirm(`Видалити файл «${f.name}»?`)) void guard(() => deleteDocFile(f.id));
  };

  const uploadFiles = (fileList: FileList | File[] | null) => {
    if (!fileList) return;
    const items = Array.from(fileList);
    if (!items.length) return;
    void guard(async () => {
      for (const file of items) {
        if (file.size > MAX_MB * 1024 * 1024) { setErr(`«${file.name}» більше ${MAX_MB} МБ — пропущено.`); continue; }
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        setProgress((p) => ({ ...p, [file.name]: 0 }));
        await uploadDocFile(
          { folderId: cwd, filename: file.name, mime: file.type || null, category: uploadCat, dataBase64 },
          (pct) => setProgress((p) => ({ ...p, [file.name]: pct }))
        );
        setProgress((p) => { const { [file.name]: _drop, ...rest } = p; return rest; });
      }
    });
  };

  const openFile = async (f: DocFile, download: boolean) => {
    try {
      const url = await fetchDocFileBlobUrl(f.id);
      if (download) {
        const a = document.createElement("a");
        a.href = url; a.download = f.name; a.click();
      } else { window.open(url, "_blank", "noopener"); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setErr("Не вдалося відкрити файл."); }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (isAdmin) uploadFiles(e.dataTransfer.files);
  };

  const catChip = (label: string, active: boolean, onClick: () => void, color?: string) => (
    <button key={label} onClick={onClick}
      style={{
        border: `1px solid ${active ? (color ?? "#c5141c") : "#ddd"}`, borderRadius: 999,
        background: active ? (color ?? "#c5141c") : "transparent", color: active ? "#fff" : "#555",
        fontSize: 12, padding: "3px 10px", cursor: "pointer", fontWeight: active ? 700 : 500,
      }}>
      {label}
    </button>
  );

  return (
    <div>
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h2 className="page-title">📁 Регламенти та документи</h2>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={uploadCat} onChange={(e) => setUploadCat(e.target.value)}
              title="Категорія для нових файлів"
              style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd", fontSize: 13 }}>
              {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn-secondary" onClick={onNewFolder} disabled={busy}>➕ Папка</button>
            <label className="btn-secondary" style={{ cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
              ⬆️ Завантажити файл
              <input type="file" multiple hidden disabled={busy}
                onChange={(e) => { uploadFiles(e.target.files); e.currentTarget.value = ""; }} />
            </label>
          </div>
        )}
      </div>

      {!isAdmin && (
        <p className="loading-text" style={{ marginTop: -4 }}>
          Перегляд і завантаження. Керування (додавання/зміна) — у керівника відділу продажу.
        </p>
      )}

      {/* Хлібні крихти */}
      <div className="chart-card" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 14 }}>
        <button onClick={() => setCwd(null)}
          style={{ background: "none", border: "none", cursor: "pointer", color: cwd === null ? "#111" : "#c5141c", fontWeight: cwd === null ? 700 : 500, padding: 0 }}>
          🏠 Головна
        </button>
        {breadcrumb.map((f) => (
          <span key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#999" }}>/</span>
            <button onClick={() => setCwd(f.id)}
              style={{ background: "none", border: "none", cursor: "pointer", color: f.id === cwd ? "#111" : "#c5141c", fontWeight: f.id === cwd ? 700 : 500, padding: 0 }}>
              {f.name}
            </button>
          </span>
        ))}
      </div>

      {/* Пошук + фільтр категорій */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", margin: "4px 2px 10px" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Пошук за назвою…"
          style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #ddd", fontSize: 14, minWidth: 220, flex: "0 1 320px" }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {catChip("Усі", catFilter === null, () => setCatFilter(null))}
          {DOC_CATEGORIES.map((c) => catChip(c, catFilter === c, () => setCatFilter(catFilter === c ? null : c), CAT_COLOR[c]))}
        </div>
      </div>

      {err && <p style={{ color: "#c5141c", fontSize: 13 }}>{err}</p>}

      {/* Прогрес завантаження */}
      {Object.keys(progress).length > 0 && (
        <div className="chart-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {Object.entries(progress).map(([name, pct]) => (
            <div key={name} style={{ fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>⬆️ {name}</span><span>{pct}%</span></div>
              <div style={{ height: 6, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "#c5141c", transition: "width .2s" }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="loading-text">Завантаження…</p>
      ) : (
        <div className="chart-card"
          onDragOver={(e) => { if (isAdmin) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{ outline: dragOver ? "2px dashed #c5141c" : "none", outlineOffset: -6 }}>
          {isAdmin && (
            <p className="loading-text" style={{ margin: "0 0 8px", fontSize: 12 }}>
              💡 Перетягніть файли сюди для завантаження в поточну папку (категорія: {uploadCat}).
            </p>
          )}
          {subFolders.length === 0 && curFiles.length === 0 && (
            <p className="loading-text" style={{ margin: 0 }}>
              {q || catFilter ? "Нічого не знайдено за фільтром." : isAdmin ? "Порожньо. Створіть папку або завантажте файл." : "Тут поки немає документів."}
            </p>
          )}
          <table className="data-table compact" style={{ width: "100%" }}>
            <tbody>
              {subFolders.map((f) => (
                <tr key={`d${f.id}`}>
                  <td style={{ width: "42%" }}>
                    <button onClick={() => setCwd(f.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, fontWeight: 600, color: "#111", display: "inline-flex", gap: 8, alignItems: "center", padding: 0 }}>
                      📁 {f.name}
                    </button>
                  </td>
                  <td colSpan={2} style={{ color: "#999" }}>папка</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {isAdmin && (
                      <>
                        <button title="Перейменувати" onClick={() => onRenameFolder(f)} disabled={busy}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>✏️</button>
                        <button title="Видалити" onClick={() => onDeleteFolder(f)} disabled={busy}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>🗑️</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {curFiles.map((f) => (
                <tr key={`f${f.id}`}>
                  <td>
                    <button onClick={() => openFile(f, false)} title="Відкрити"
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "#111", display: "inline-flex", gap: 8, alignItems: "center", padding: 0, textAlign: "left" }}>
                      {iconFor(f.name, f.mime)} {f.name}
                    </button>
                  </td>
                  <td>
                    {isAdmin ? (
                      <select value={f.category ?? ""} disabled={busy}
                        onChange={(e) => onChangeCategory(f, e.target.value)}
                        style={{ fontSize: 12, padding: "2px 4px", borderRadius: 6, border: "1px solid #eee" }}>
                        <option value="">— без категорії —</option>
                        {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : f.category ? (
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: CAT_COLOR[f.category] ?? "#868e96", borderRadius: 999, padding: "2px 8px" }}>
                        {f.category}
                      </span>
                    ) : <span style={{ color: "#ccc" }}>—</span>}
                  </td>
                  <td style={{ color: "#999", whiteSpace: "nowrap", fontSize: 12 }}>
                    {fmtBytes(f.size_bytes)} · {fmtDate(f.created_at)}{f.author ? ` · ${f.author}` : ""}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button title="Завантажити" onClick={() => openFile(f, true)}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>⬇️</button>
                    {isAdmin && (
                      <>
                        <button title="Перейменувати" onClick={() => onRenameFile(f)} disabled={busy}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>✏️</button>
                        <button title="Видалити" onClick={() => onDeleteFile(f)} disabled={busy}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>🗑️</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
