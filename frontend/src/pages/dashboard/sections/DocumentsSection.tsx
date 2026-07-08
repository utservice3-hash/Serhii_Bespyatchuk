import { useEffect, useMemo, useState } from "react";
import {
  fetchDocTree, createDocFolder, renameDocFolder, deleteDocFolder,
  uploadDocFile, renameDocFile, deleteDocFile, fetchDocFileBlobUrl,
  type DocFolder, type DocFile,
} from "../../../api";

const MAX_MB = 50;

function fmtBytes(n: string | number | null): string {
  const b = Number(n ?? 0);
  if (!b) return "—";
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
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

export function DocumentsSection({ isAdmin }: { isAdmin: boolean }) {
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [files, setFiles] = useState<DocFile[]>([]);
  const [cwd, setCwd] = useState<number | null>(null); // null = корінь
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const t = await fetchDocTree();
      setFolders(t.folders);
      setFiles(t.files);
      setErr(null);
    } catch {
      setErr("Не вдалося завантажити документи.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const breadcrumb = useMemo(() => {
    const path: DocFolder[] = [];
    let cur = cwd != null ? byId.get(cwd) : undefined;
    while (cur) { path.unshift(cur); cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined; }
    return path;
  }, [cwd, byId]);

  const subFolders = folders.filter((f) => f.parent_id === cwd);
  const curFiles = files.filter((f) => f.folder_id === cwd);

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
    if (name && name !== f.name) void guard(() => renameDocFile(f.id, name));
  };
  const onDeleteFile = (f: DocFile) => {
    if (window.confirm(`Видалити файл «${f.name}»?`)) void guard(() => deleteDocFile(f.id));
  };

  const onUpload = (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const items = Array.from(fileList);
    void guard(async () => {
      for (const file of items) {
        if (file.size > MAX_MB * 1024 * 1024) { setErr(`«${file.name}» більше ${MAX_MB} МБ — пропущено.`); continue; }
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        await uploadDocFile({ folderId: cwd, filename: file.name, mime: file.type || null, dataBase64 });
      }
    });
  };

  const openFile = async (f: DocFile, download: boolean) => {
    try {
      const url = await fetchDocFileBlobUrl(f.id);
      if (download) {
        const a = document.createElement("a");
        a.href = url; a.download = f.name; a.click();
      } else {
        window.open(url, "_blank", "noopener");
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setErr("Не вдалося відкрити файл."); }
  };

  return (
    <div>
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h2 className="page-title">📁 Регламенти та документи</h2>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-secondary" onClick={onNewFolder} disabled={busy}>➕ Папка</button>
            <label className="btn-secondary" style={{ cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
              ⬆️ Завантажити файл
              <input type="file" multiple hidden disabled={busy}
                onChange={(e) => { onUpload(e.target.files); e.currentTarget.value = ""; }} />
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
        <button className="crumb-link" onClick={() => setCwd(null)}
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

      {err && <p style={{ color: "#c5141c", fontSize: 13 }}>{err}</p>}

      {loading ? (
        <p className="loading-text">Завантаження…</p>
      ) : (
        <div className="chart-card">
          {subFolders.length === 0 && curFiles.length === 0 && (
            <p className="loading-text" style={{ margin: 0 }}>
              Порожньо. {isAdmin ? "Створіть папку або завантажте файл." : "Тут поки немає документів."}
            </p>
          )}
          <table className="data-table compact" style={{ width: "100%" }}>
            <tbody>
              {subFolders.map((f) => (
                <tr key={`d${f.id}`}>
                  <td style={{ width: "60%" }}>
                    <button onClick={() => setCwd(f.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, fontWeight: 600, color: "#111", display: "inline-flex", gap: 8, alignItems: "center", padding: 0 }}>
                      📁 {f.name}
                    </button>
                  </td>
                  <td style={{ color: "#999" }}>папка</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {isAdmin && (
                      <>
                        <button className="icon-btn" title="Перейменувати" onClick={() => onRenameFolder(f)} disabled={busy}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>✏️</button>
                        <button className="icon-btn" title="Видалити" onClick={() => onDeleteFolder(f)} disabled={busy}
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
                  <td style={{ color: "#999", whiteSpace: "nowrap" }}>{fmtBytes(f.size_bytes)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="icon-btn" title="Завантажити" onClick={() => openFile(f, true)}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>⬇️</button>
                    {isAdmin && (
                      <>
                        <button className="icon-btn" title="Перейменувати" onClick={() => onRenameFile(f)} disabled={busy}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>✏️</button>
                        <button className="icon-btn" title="Видалити" onClick={() => onDeleteFile(f)} disabled={busy}
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
