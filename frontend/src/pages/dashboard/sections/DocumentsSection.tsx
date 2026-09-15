import { useEffect, useMemo, useState } from "react";
import {
  fetchDocTree, fetchDocCard, fetchDocViewers, fetchDocPeople, createDocFolder, renameDocFolder, deleteDocFolder,
  uploadDocFile, uploadDocVersion, updateDocFile, archiveDocFile, restoreDocFile, signDocFile, requestDocAccess,
  fetchDocFolderAccess, saveDocFolderAccess, fetchDocFileBlobUrl, DOC_TYPES, fetchTelegramStatus, createTelegramLink, unlinkTelegram,
  type DocTree, type DocFile, type DocFolder, type DocCard, type DocSection, type DocFolderAccess, type TelegramStatus,
} from "../../../api";

/**
 * 📁 РЕГЛАМЕНТИ ТА ДОКУМЕНТИ v2 — екран за макетами 15.09.2026 (7 екранів).
 * Чотири розділи (Загальні · Особисті · 🔒 Офери · Архів), рейка типів і папок, список із
 * групуванням, картка документа праворуч, матриця доступів, діалог підпису.
 *
 * 🔴 ТРИ СТАНИ, ЯКІ НЕ ЗМІШУЮТЬСЯ (розділ 8 ТЗ): «порожньо» · «помилка» · «немає доступу».
 * Поки запит падає — рядок «порожньо» НЕ показується взагалі. Стан «немає доступу» дає
 * сервер (403 з `reason: no_access`), а не здогад фронту.
 *
 * 🔴 ДОСТУП вирішує СЕРВЕР (`core/docAccess.ts`): фронт лише малює те, що йому віддали,
 * і ховає кнопки за прапорцями `canEdit`/`canSign`/`viewer.*` з відповіді. Жодної власної
 * думки про права тут немає — інакше кнопка й роут розійшлися б.
 */

type Section = DocSection | "archive";
type GroupBy = "type" | "folder" | "date";

const MAX_MB = 100;
const TYPE_META: Record<string, { color: string; action: string; icon: string }> = {
  "Регламент": { color: "#c5141c", action: "виконувати", icon: "§" },
  "Інструкція": { color: "#2f9e44", action: "робити за кроками", icon: "↳" },
  "Шаблон": { color: "#6f42c1", action: "взяти й заповнити", icon: "▤" },
  "Офер": { color: "#1d4ed8", action: "надіслати й підписати", icon: "✎" },
  "Матеріал для клієнта": { color: "#d97706", action: "надіслати клієнту", icon: "◇" },
  "Інше": { color: "#6b7280", action: "зберігати", icon: "•" },
};
const SECTION_HINT: Record<Section, string> = {
  general: "Загальні бачить уся команда. Публікувати сюди може лише керівництво — решта завантажує в «Особисті» й надсилає на публікацію.",
  personal: "Особисті бачать адресат, той, хто виклав, і керівництво.",
  offer: "Офери — окрема закрита папка. Керівництво бачить усі, менеджер — тільки свій. Керівник відділу сюди не заходить.",
  archive: "Архів — документи звільнених. Тільки читання: видалити не можна, підписи лишаються чинними.",
};

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return "—"; }
}
function extOf(name: string, mime: string | null): string {
  const ext = name.split(".").pop()?.toUpperCase() ?? "";
  if (ext && ext.length <= 5) return ext;
  if (mime?.startsWith("image/")) return "IMG";
  return "FILE";
}
function previewKind(f: DocFile): "pdf" | "image" | "html" | "none" {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || f.mime === "application/pdf") return "pdf";
  if (f.mime?.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["html", "htm"].includes(ext) || f.mime === "text/html") return "html";
  return "none";
}
const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file);
});
const errOf = (e: unknown, fb: string) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fb;

const card: React.CSSProperties = { background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, padding: 14 };
const pill = (bg: string, color: string): React.CSSProperties => ({ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: bg, color, whiteSpace: "nowrap" });
const btn = (kind: "primary" | "ghost" | "danger" = "ghost"): React.CSSProperties => ({
  border: kind === "ghost" ? "1px solid var(--border-strong)" : "none", borderRadius: 10, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  background: kind === "primary" ? "var(--brand)" : kind === "danger" ? "var(--danger-bg)" : "var(--card-bg)",
  color: kind === "primary" ? "#fff" : kind === "danger" ? "var(--danger)" : "var(--text)",
});
const inp: React.CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border-strong)", fontSize: 13, background: "var(--card-bg)", color: "var(--text)" };

function SigBadge({ f }: { f: DocFile }) {
  const s = f.signature;
  if (s.kind === "not_required") return null;
  if (s.kind === "signed") return <span style={pill("var(--ok-bg)", "var(--ok)")}>● Підписано</span>;
  if (s.kind === "outdated") return <span style={pill("var(--warn-bg)", "var(--warn)")}>● Потребує підпису · нова версія</span>;
  if (s.kind === "overdue") return <span style={pill("var(--danger-bg)", "var(--danger)")}>● Прострочено · {s.days} дн.</span>;
  return <span style={pill("var(--warn-bg)", "var(--warn)")}>● Чекає підпису{s.days != null ? ` · ${s.days} дн.` : ""}</span>;
}

export function DocumentsSection({ isAdmin: _legacyIsAdmin }: { isAdmin: boolean }) {
  const [tree, setTree] = useState<DocTree | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("general");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<number | null | "none" | "all">("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [accessFolder, setAccessFolder] = useState<DocFolder | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setTree(await fetchDocTree()); setLoadErr(null); }
    catch (e) { setLoadErr(errOf(e, "Сервер відповів помилкою.")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const viewer = tree?.viewer;
  const files = useMemo(() => {
    if (!tree) return [];
    const inSection = tree.files.filter((f) => section === "archive" ? !!f.archivedAt : (!f.archivedAt && f.section === section));
    const qq = q.trim().toLowerCase();
    return inSection
      .filter((f) => !typeFilter || (f.category ?? "Інше") === typeFilter)
      .filter((f) => folderFilter === "all" || (folderFilter === "none" ? f.folderId == null : f.folderId === folderFilter))
      .filter((f) => !qq || f.name.toLowerCase().includes(qq) || (f.description ?? "").toLowerCase().includes(qq) || (f.addressee ?? "").toLowerCase().includes(qq));
  }, [tree, section, typeFilter, folderFilter, q]);

  const sectionFiles = useMemo(() => tree ? tree.files.filter((f) => section === "archive" ? !!f.archivedAt : (!f.archivedAt && f.section === section)) : [], [tree, section]);
  const typeCounts = useMemo(() => { const m = new Map<string, number>(); for (const f of sectionFiles) m.set(f.category ?? "Інше", (m.get(f.category ?? "Інше") ?? 0) + 1); return m; }, [sectionFiles]);
  const folderCounts = useMemo(() => { const m = new Map<number | null, number>(); for (const f of sectionFiles) m.set(f.folderId, (m.get(f.folderId) ?? 0) + 1); return m; }, [sectionFiles]);
  const folderName = (id: number | null) => id == null ? "Без папки" : (tree?.folders.find((x) => x.id === id)?.name ?? `Папка #${id}`);

  const groups = useMemo(() => {
    const g = new Map<string, DocFile[]>();
    const keyOf = (f: DocFile) => groupBy === "type" ? (f.category ?? "Інше") : groupBy === "folder" ? folderName(f.folderId) : (f.updatedAt ?? f.createdAt).slice(0, 7);
    for (const f of files) { const k = keyOf(f); g.set(k, [...(g.get(k) ?? []), f]); }
    const order = groupBy === "type" ? [...DOC_TYPES] : [...g.keys()].sort((a, b) => groupBy === "date" ? b.localeCompare(a) : a.localeCompare(b));
    return order.filter((k) => g.has(k)).map((k) => ({ key: k, items: g.get(k)! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, groupBy, tree]);

  const selectedFile = tree?.files.find((f) => f.id === selected) ?? null;

  // ── Три стани ────────────────────────────────────────────────────────────
  if (loading && !tree) return <div className="chart-card"><p className="loading-text">Завантаження документів…</p></div>;
  if (loadErr && !tree) return (
    <StateBlock icon="⚠" title="Не вдалося завантажити список" text={`Сервер відповів помилкою. Файли на місці — це збій відображення. ${loadErr}`}
      action={<button style={btn("primary")} onClick={() => void load()}>Спробувати ще раз</button>} />
  );
  if (!tree || !viewer) return null;

  const canUploadHere = viewer.isManagement || viewer.canUploadRoot || viewer.uploadFolders.length > 0;

  return (
    <div>
      {toast && <div style={{ position: "fixed", top: 16, right: 16, zIndex: 80, ...card, background: "var(--ok-bg)", color: "var(--ok)", fontWeight: 600 }}>{toast}</div>}
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h2 className="page-title">📁 Регламенти та документи</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <TelegramChip onToast={setToast} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Пошук за назвою, описом, адресатом" style={{ ...inp, minWidth: 260 }} />
          {viewer.isManagement && <button style={btn()} onClick={() => { const n = window.prompt("Назва нової папки:")?.trim(); if (n) void createDocFolder(n, null).then(load).catch((e) => setToast(errOf(e, "Не вдалося створити папку"))); }}>➕ Папка</button>}
          {canUploadHere && <button style={btn("primary")} onClick={() => setUploadOpen(true)}>+ Завантажити</button>}
        </div>
      </div>

      {/* Розділи */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 4, background: "var(--bg, #f3f4f6)", borderRadius: 12, padding: 4 }}>
          {([["general", "Загальні"], ["personal", "Особисті"], ["offer", "🔒 Офери"], ["archive", "Архів"]] as [Section, string][])
            .filter(([k]) => tree.sections[k])
            .map(([k, label]) => (
              <button key={k} onClick={() => { setSection(k); setTypeFilter(null); setFolderFilter("all"); setSelected(null); }}
                style={{ border: "none", borderRadius: 9, padding: "7px 14px", cursor: "pointer", fontWeight: section === k ? 700 : 500, fontSize: 14,
                  background: section === k ? "var(--card-bg)" : "transparent", color: "var(--text)", boxShadow: section === k ? "0 1px 3px rgba(0,0,0,.12)" : "none", display: "flex", gap: 8, alignItems: "center" }}>
                {label}
                <span style={pill(section === k && k === "offer" ? "var(--danger)" : "var(--border)", section === k && k === "offer" ? "#fff" : "var(--text-muted)")}>{tree.counts[k]}</span>
              </button>
            ))}
        </div>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}><b style={{ color: "var(--text)" }}>{({ general: "Загальні", personal: "Особисті", offer: "Офери", archive: "Архів" })[section]}</b> — {SECTION_HINT[section]}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "230px minmax(0,1fr) 340px", gap: 12, alignItems: "start" }}>
        {/* Рейка */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={card}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--text-muted)", marginBottom: 8 }}>ТИПИ ДОКУМЕНТІВ</div>
            {[...DOC_TYPES].filter((t) => typeCounts.has(t)).map((t) => (
              <button key={t} onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", border: "none", background: typeFilter === t ? "var(--bg, #f3f4f6)" : "transparent", borderRadius: 8, padding: "6px 6px", cursor: "pointer", textAlign: "left" }}>
                <span style={{ width: 26, height: 26, borderRadius: 8, background: TYPE_META[t].color + "22", color: TYPE_META[t].color, display: "grid", placeItems: "center", fontWeight: 800 }}>{TYPE_META[t].icon}</span>
                <span style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t}</div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>{TYPE_META[t].action}</div></span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{typeCounts.get(t)}</span>
              </button>
            ))}
            {typeCounts.size === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>у розділі поки нічого</div>}
          </div>
          {section !== "offer" && (
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--text-muted)", marginBottom: 8 }}>
                <span>ПАПКИ</span>{viewer.canManageAccess && section === "general" && <span style={{ color: "var(--brand)" }}>доступи ⚙</span>}
              </div>
              {[...tree.folders.filter((f) => f.parentId == null), null].map((f) => {
                const id = f?.id ?? null; const n = folderCounts.get(id) ?? 0;
                if (!f && n === 0) return null;
                const active = folderFilter === (f ? id : "none");
                return (
                  <div key={f?.id ?? "none"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button onClick={() => setFolderFilter(active ? "all" : (f ? id : "none"))}
                      style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, border: "none", background: active ? "var(--bg, #f3f4f6)" : "transparent", borderRadius: 8, padding: "6px 6px", cursor: "pointer", textAlign: "left", fontSize: 13, color: "var(--text)" }}>
                      <span>🗀</span><span style={{ flex: 1 }}>{f ? f.name : "Без папки"}</span><span style={{ fontSize: 12, color: "var(--text-muted)" }}>{n}</span>
                    </button>
                    {f && viewer.canManageAccess && section === "general" && (
                      <>
                        <button title="Доступи до папки" onClick={() => setAccessFolder(f)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 14, color: "var(--text-muted)" }}>⚙</button>
                        <button title="Перейменувати" onClick={() => { const n = window.prompt("Нова назва папки:", f.name)?.trim(); if (n && n !== f.name) void renameDocFolder(f.id, n).then(load).catch((e) => setToast(errOf(e, "Не перейменовано"))); }}
                          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>✎</button>
                        <button title="Прибрати папку (файли лишаються на диску)" onClick={() => { if (window.confirm(`Прибрати папку «${f.name}»? Її документи зникнуть з екрана; файли на диску лишаються.`)) void deleteDocFolder(f.id).then(load).catch((e) => setToast(errOf(e, "Не вдалося"))); }}
                          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>✕</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Список */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Усі документи <span style={{ color: "var(--text-muted)", fontWeight: 500, fontSize: 13 }}>{files.length} {files.length === 1 ? "файл" : files.length < 5 ? "файли" : "файлів"}</span></div>
            <div style={{ display: "flex", gap: 2, background: "var(--bg, #f3f4f6)", borderRadius: 10, padding: 3 }}>
              {([["type", "за типом"], ["folder", "за папкою"], ["date", "за датою"]] as [GroupBy, string][]).map(([k, l]) => (
                <button key={k} onClick={() => setGroupBy(k)} style={{ border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: groupBy === k ? 700 : 500, background: groupBy === k ? "var(--card-bg)" : "transparent", color: "var(--text)" }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <Chip label="Усі" active={typeFilter === null} onClick={() => setTypeFilter(null)} />
            {[...DOC_TYPES].filter((t) => typeCounts.has(t)).map((t) => <Chip key={t} label={t} active={typeFilter === t} onClick={() => setTypeFilter(typeFilter === t ? null : t)} />)}
          </div>
          {section === "offer" && (
            <div style={{ fontSize: 13, background: "var(--bg, #f3f4f6)", borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
              🔒 <b>Закрита папка.</b> {viewer.isManagement ? "Ви бачите всі офери, бо ви керівництво. Менеджер бачить лише свій, керівник відділу — жодного." : "Вам видно тільки ваш власний офер. Чужі сюди не потрапляють навіть у пошук."}
            </div>
          )}
          {section === "archive" && (
            <div style={{ fontSize: 13, background: "var(--bg, #f3f4f6)", borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
              ⏳ <b>Архів формується при звільненні.</b> Офер і особисті документи людини переїжджають сюди; видалення недоступне нікому.
            </div>
          )}
          {files.length === 0 ? (
            sectionFiles.length === 0
              ? <StateBlock icon="🗀" title={section === "archive" ? "В архіві ще нічого немає" : "У папці ще нічого немає"} text={canUploadHere ? "Перетягніть файли сюди або натисніть «Завантажити»." : "Документи сюди викладає керівництво."}
                  action={canUploadHere ? <button style={btn()} onClick={() => setUploadOpen(true)}>Завантажити файл</button> : undefined} inline />
              : <p className="loading-text" style={{ margin: 0 }}>Нічого не знайдено за фільтром.</p>
          ) : groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".06em", color: groupBy === "type" ? TYPE_META[g.key]?.color ?? "var(--text)" : "var(--text)" }}>
                  <span style={{ display: "inline-block", width: 18, height: 3, background: "currentColor", marginRight: 8, verticalAlign: "middle" }} />{g.key.toUpperCase()} · {g.items.length}
                </span>
                {groupBy === "type" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{TYPE_META[g.key]?.action}</span>}
              </div>
              {g.items.map((f) => {
                const t = TYPE_META[f.category ?? "Інше"] ?? TYPE_META["Інше"]; const sel = f.id === selected;
                return (
                  <div key={f.id} onClick={() => setSelected(f.id)}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 8px", borderRadius: 10, cursor: "pointer", background: sel ? t.color + "12" : "transparent", borderLeft: sel ? `3px solid ${t.color}` : "3px solid transparent" }}>
                    <span style={{ width: 42, height: 46, borderRadius: 8, border: `1px solid ${t.color}55`, background: t.color + "10", color: t.color, display: "grid", placeItems: "center", fontSize: 9, fontWeight: 800 }}>{extOf(f.name, f.mime)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {section === "offer" ? "🔒 Офери" : section === "archive" ? "Архів" : folderName(f.folderId)} · v{f.version} · {fmtDate(f.updatedAt)} · {f.addressee ?? f.author ?? "автор невідомий"}
                      </div>
                    </span>
                    {f.archivedAt && <span style={pill("var(--border)", "var(--text-muted)")}>звільнено {fmtDate(f.archivedAt)}</span>}
                    <SigBadge f={f} />
                    <span style={pill("var(--bg, #f3f4f6)", "var(--text-muted)")}>{fmtBytes(f.sizeBytes)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Картка */}
        <div>
          {selectedFile
            ? <DocCardPanel key={selectedFile.id} file={selectedFile} tree={tree} onChanged={load} onClose={() => setSelected(null)} onToast={setToast} folderName={folderName} />
            : <div style={{ ...card, color: "var(--text-muted)", fontSize: 13 }}>Оберіть документ у списку, щоб побачити картку: прев'ю, версії, хто бачить, підпис.</div>}
        </div>
      </div>

      {uploadOpen && <UploadDialog tree={tree} section={section === "archive" ? "general" : section} defaultFolder={typeof folderFilter === "number" ? folderFilter : null}
        onClose={() => setUploadOpen(false)} onDone={(msg) => { setUploadOpen(false); setToast(msg); void load(); }} />}
      {accessFolder && <AccessDialog folder={accessFolder} onClose={() => setAccessFolder(null)} onSaved={() => { setAccessFolder(null); setToast("Доступи збережено, зміну записано в журнал"); void load(); }} />}
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} style={{ border: `1px solid ${active ? "var(--text)" : "var(--border-strong)"}`, borderRadius: 999, background: active ? "var(--text)" : "transparent", color: active ? "var(--card-bg)" : "var(--text)", fontSize: 12, padding: "4px 12px", cursor: "pointer", fontWeight: active ? 700 : 500 }}>{label}</button>;
}

function StateBlock({ icon, title, text, action, inline }: { icon: string; title: string; text: string; action?: React.ReactNode; inline?: boolean }) {
  return (
    <div style={{ ...(inline ? {} : card), textAlign: "center", padding: inline ? "28px 12px" : 40 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--bg, #f3f4f6)", display: "grid", placeItems: "center", margin: "0 auto 12px", fontSize: 22 }}>{icon}</div>
      <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 420, margin: "0 auto 14px" }}>{text}</div>
      {action}
    </div>
  );
}

/* ── Картка документа ───────────────────────────────────────────────────── */
function DocCardPanel({ file, tree, onChanged, onClose, onToast, folderName }: { file: DocFile; tree: DocTree; onChanged: () => Promise<void>; onClose: () => void; onToast: (s: string) => void; folderName: (id: number | null) => string }) {
  const [cardData, setCardData] = useState<DocCard | null>(null);
  const [viewers, setViewers] = useState<{ who: { label: string; note: string }[]; exceptions: { name: string; until: string | null }[] } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noAccess, setNoAccess] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = TYPE_META[file.category ?? "Інше"] ?? TYPE_META["Інше"];
  const kind = previewKind(file);
  const mgmt = tree.viewer.isManagement;

  useEffect(() => {
    let alive = true; let url: string | null = null;
    setCardData(null); setViewers(null); setPreview(null); setErr(null); setNoAccess(false);
    fetchDocCard(file.id).then((d) => { if (alive) setCardData(d); })
      .catch((e) => { const r = (e as { response?: { status?: number; data?: { reason?: string } } }).response; if (!alive) return; if (r?.status === 403) setNoAccess(true); else setErr(errOf(e, "Картку не вдалося завантажити")); });
    if (mgmt) fetchDocViewers(file.id).then((v) => { if (alive) setViewers(v); }).catch(() => {});
    if (kind !== "none") fetchDocFileBlobUrl(file.id, { inline: true }).then((u) => { url = u; if (alive) setPreview(u); }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.version]);

  const open = async (download: boolean) => {
    try {
      const url = await fetchDocFileBlobUrl(file.id, { inline: !download });
      if (download) { const a = document.createElement("a"); a.href = url; a.download = file.name; a.click(); }
      else window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setErr(errOf(e, "Не вдалося відкрити файл.")); }
  };
  const newVersion = (fl: FileList | null) => {
    const f = fl?.[0]; if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) { setErr(`Файл більше ${MAX_MB} МБ`); return; }
    setBusy(true);
    readAsDataUrl(f).then((dataBase64) => uploadDocVersion(file.id, { filename: f.name, mime: f.type || null, dataBase64 }))
      .then(async (r) => { onToast(`Нова версія v${r.version}${file.section === "offer" ? " — офер знову потребує підпису" : ""}`); await onChanged(); })
      .catch((e) => setErr(errOf(e, "Нову версію не вдалося зберегти"))).finally(() => setBusy(false));
  };
  const rename = () => { const n = window.prompt("Нова назва:", file.name)?.trim(); if (n && n !== file.name) void updateDocFile(file.id, { name: n }).then(onChanged).catch((e) => setErr(errOf(e, "Не перейменовано"))); };
  const changeType = (category: string) => void updateDocFile(file.id, { category }).then(onChanged).catch((e) => setErr(errOf(e, "Тип не змінено")));
  const editDescription = () => { const d = window.prompt("Опис документа:", file.description ?? ""); if (d != null) void updateDocFile(file.id, { description: d }).then(onChanged).catch((e) => setErr(errOf(e, "Опис не збережено"))); };
  const archive = () => { if (window.confirm(`Прибрати «${file.name}» з екрана в архів? Файл лишається, видалення не існує.`)) void archiveDocFile(file.id).then(async () => { onToast("Перенесено в архів"); await onChanged(); onClose(); }).catch((e) => setErr(errOf(e, "Не вдалося"))); };
  const restore = () => void restoreDocFile(file.id).then(async () => { onToast("Повернуто з архіву"); await onChanged(); }).catch((e) => setErr(errOf(e, "Не вдалося")));

  if (noAccess) return (
    <StateBlock icon="🔒" title="Документ не для вас" text="Доступ мають адресат і керівництво. Запит піде керівнику, а не в порожнечу."
      action={<button style={btn()} onClick={() => void requestDocAccess(file.id, "").then((r) => onToast(r.message)).catch((e) => setErr(errOf(e, "Запит не відправлено")))}>Запитати доступ</button>} />
  );

  const sig = file.signature;
  const events = cardData?.events ?? [];
  const evAt = (k: string) => events.find((e) => e.kind === k)?.at ?? null;

  return (
    <div style={{ ...card, position: "sticky", top: 12, display: "flex", flexDirection: "column", gap: 12, maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={pill(t.color + "22", t.color)}>● {file.category ?? "Інше"}</span>
        <span style={pill("var(--bg, #f3f4f6)", "var(--text-muted)")}>{extOf(file.name, file.mime)}</span>
        <span style={pill("var(--bg, #f3f4f6)", "var(--text-muted)")}>v{file.version}</span>
        {file.section === "offer" && !file.archivedAt && <span style={pill("#dbeafe", "#1d4ed8")}>🔒 закрита папка</span>}
        {file.archivedAt && <span style={pill("var(--border)", "var(--text-muted)")}>архів · {file.archivedReason === "dismissed" ? "звільнено" : "прибрано"} {fmtDate(file.archivedAt)}</span>}
        <button onClick={onClose} title="Закрити" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "var(--text-muted)" }}>✕</button>
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.25 }}>{file.name}</div>
      {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}

      {/* Прев'ю */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg, #f3f4f6)", minHeight: 120, overflow: "hidden" }}>
        {kind === "none" ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>{extOf(file.name, file.mime)} у дашборді не показується — відкривається завантаженням. PDF, зображення й HTML показуються тут.</div>
        ) : !preview ? <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>завантаження прев'ю…</div>
          : kind === "image" ? <img src={preview} alt={file.name} style={{ width: "100%", display: "block" }} />
          : <iframe title={file.name} src={preview} style={{ width: "100%", height: 260, border: "none", background: "#fff" }} />}
      </div>

      {file.description ? <div style={{ fontSize: 13 }}>{file.description}</div> : file.canEdit && <button onClick={editDescription} style={{ ...btn(), fontSize: 12, padding: "4px 10px", alignSelf: "flex-start" }}>+ опис</button>}

      <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", rowGap: 6, fontSize: 13 }}>
        <span style={{ color: "var(--text-muted)" }}>Папка</span><span>{file.section === "offer" ? "🔒 Офери" : file.archivedAt ? "Архів" : folderName(file.folderId)}</span>
        <span style={{ color: "var(--text-muted)" }}>Виклав</span><span>{file.author ?? "невідомо"}</span>
        {file.addressee && <><span style={{ color: "var(--text-muted)" }}>Адресат</span><span>{file.addressee}</span></>}
        <span style={{ color: "var(--text-muted)" }}>Оновлено</span><span>{fmtDate(file.updatedAt)}</span>
        <span style={{ color: "var(--text-muted)" }}>Розмір</span><span>{fmtBytes(file.sizeBytes)}</span>
        <span style={{ color: "var(--text-muted)" }}>Хеш</span><span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-muted)" }} title={file.sha256 ?? ""}>{file.sha256 ? `sha256 · ${file.sha256.slice(0, 12)}…${file.sha256.slice(-6)}` : "хеша немає (старий файл)"}</span>
        {file.canEdit && <><span style={{ color: "var(--text-muted)" }}>Тип</span>
          <select value={file.category ?? "Інше"} onChange={(e) => changeType(e.target.value)} style={{ ...inp, padding: "3px 6px", fontSize: 12 }}>{DOC_TYPES.map((c) => <option key={c}>{c}</option>)}</select></>}
      </div>

      {/* Підпис */}
      {file.section === "offer" && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--text-muted)", marginBottom: 8 }}>ПІДПИС</div>
          <Timeline steps={[
            { label: "Надіслано", at: evAt("sent") ?? file.createdAt, done: true, note: file.addressee ?? undefined },
            { label: "Відкрито", at: evAt("opened"), done: !!evAt("opened") },
            { label: "Підписано", at: sig.kind === "signed" ? (cardData?.signatures.find((s) => s.current)?.signedAt ?? null) : null, done: sig.kind === "signed",
              note: sig.kind === "signed" ? ({ paper_photo: "фото паперового варіанта", email_code: "код на пошту", telegram_code: "код у Telegram", diia: "Дія.Підпис" } as Record<string, string>)[cardData?.signatures.find((s) => s.current)?.method ?? ""] : undefined },
          ]} />
          {sig.kind === "signed" && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Відбиток підпису привʼязано до версії {file.version}.</div>}
          {sig.kind === "outdated" && <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 6 }}>Файл замінено новою версією — попередній підпис стосується іншої версії й лишився в історії.</div>}
          {sig.kind === "overdue" && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>Прострочено на {sig.days} дн. Нічого не блокується: статус і нагадування.</div>}
          {file.canSign && <button style={{ ...btn("primary"), marginTop: 10, width: "100%" }} onClick={() => setSignOpen(true)}>Підписати</button>}
          {cardData && cardData.signatures.some((s) => !s.current) && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>Історія: {cardData.signatures.filter((s) => !s.current).map((s) => `v${s.version} · ${fmtDate(s.signedAt)} · ${s.signer ?? ""}`).join("; ")}</div>
          )}
        </div>
      )}

      {/* Хто бачить */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--text-muted)", marginBottom: 8 }}>
          <span>ХТО БАЧИТЬ ЦЕЙ ДОКУМЕНТ</span>
        </div>
        {mgmt ? (viewers ? (
          <>
            {viewers.who.map((w, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}><span>{w.label}</span><span style={{ color: "var(--text-muted)", fontSize: 12 }}>{w.note}</span></div>)}
            {viewers.exceptions.map((e, i) => <div key={`e${i}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}><span>{e.name}</span><span style={{ color: "var(--text-muted)", fontSize: 12 }}>виняток{e.until ? ` · до ${fmtDate(e.until)}` : " · безстроково"}</span></div>)}
            {file.section === "offer" && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Керівник відділу до цієї папки доступу не має за рішенням від 15.09.</div>}
          </>
        ) : <div style={{ fontSize: 12, color: "var(--text-muted)" }}>…</div>)
          : <div style={{ fontSize: 13 }}>{file.section === "general" ? "Уся команда" : file.section === "offer" ? "Ви та керівництво" : "Адресат, автор і керівництво"}</div>}
      </div>

      {/* Версії */}
      {cardData && cardData.versions.length > 1 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Версії: {cardData.versions.map((v) => `v${v.version} · ${fmtDate(v.created_at)}${v.author ? ` · ${v.author}` : ""}`).join(" | ")}
        </div>
      )}

      {/* Дії */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {kind !== "none" && <button style={btn("primary")} onClick={() => void open(false)}>Відкрити</button>}
        <button style={btn()} onClick={() => void open(true)}>Завантажити</button>
        {file.canEdit && (
          <label style={{ ...btn(), cursor: busy ? "default" : "pointer", opacity: busy ? .6 : 1 }}>Нова версія<input type="file" hidden disabled={busy} onChange={(e) => { newVersion(e.target.files); e.currentTarget.value = ""; }} /></label>
        )}
        {file.canEdit && <button style={btn()} onClick={rename}>Перейменувати</button>}
        {mgmt && !file.archivedAt && <button style={btn("danger")} onClick={archive}>В архів</button>}
        {mgmt && file.archivedAt && <button style={btn()} onClick={restore}>Повернути з архіву</button>}
      </div>

      {signOpen && <SignDialog file={file} onClose={() => setSignOpen(false)} onDone={async () => { setSignOpen(false); onToast("Підписано. Відбиток привʼязано до поточної версії."); await onChanged(); window.dispatchEvent(new Event("uts:offer-signed")); }} />}
    </div>
  );
}

function Timeline({ steps }: { steps: { label: string; at: string | null; done: boolean; note?: string }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: s.done ? "var(--ok)" : "var(--border)", color: "#fff", display: "grid", placeItems: "center", fontSize: 11, flex: "0 0 auto" }}>{s.done ? "✓" : ""}</span>
          <span><div style={{ fontWeight: 700, fontSize: 13 }}>{s.label}</div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.at ? `${fmtDate(s.at)}${s.note ? ` · ${s.note}` : ""}` : "ще ні"}</div></span>
        </div>
      ))}
    </div>
  );
}

/* ── Завантаження ───────────────────────────────────────────────────────── */
function UploadDialog({ tree, section: initial, defaultFolder, onClose, onDone }: { tree: DocTree; section: DocSection; defaultFolder: number | null; onClose: () => void; onDone: (msg: string) => void }) {
  const mgmt = tree.viewer.isManagement;
  const [section, setSection] = useState<DocSection>(mgmt ? initial : "general");
  const [folderId, setFolderId] = useState<number | null>(defaultFolder);
  const [category, setCategory] = useState<string>(initial === "offer" ? "Офер" : "Регламент");
  const [addressee, setAddressee] = useState<number | "">("");
  const [people, setPeople] = useState<{ userId: number; name: string; role: string; team: string | null }[]>([]);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  useEffect(() => { if (mgmt) fetchDocPeople().then(setPeople).catch(() => {}); }, [mgmt]);
  useEffect(() => { if (section === "offer") setCategory("Офер"); }, [section]);
  const allowedFolders = tree.folders.filter((f) => mgmt || tree.viewer.uploadFolders.includes(f.id));

  const submit = async () => {
    if (!files.length) { setErr("Оберіть файл"); return; }
    if (section !== "general" && !addressee) { setErr("Вкажіть адресата: особистий документ і офер належать людині"); return; }
    setBusy(true); setErr(null);
    try {
      for (const f of files) {
        if (f.size > MAX_MB * 1024 * 1024) throw new Error(`«${f.name}» більше ${MAX_MB} МБ`);
        const dataBase64 = await readAsDataUrl(f);
        await uploadDocFile({ folderId: section === "general" ? folderId : null, filename: f.name, mime: f.type || null, category, dataBase64, section, addresseeUserId: addressee === "" ? null : Number(addressee), description: description || null });
      }
      onDone(section === "offer" ? "Офер надіслано адресату — він побачить його у своїх «Оферах»" : `Завантажено: ${files.length}`);
    } catch (e) { setErr((e as Error).message?.startsWith("«") ? (e as Error).message : errOf(e, "Не вдалося завантажити")); setBusy(false); }
  };
  return (
    <Modal title="Завантажити документ" onClose={onClose} width={560}>
      <div style={{ display: "grid", gap: 10 }}>
        {mgmt && (
          <Field label="Розділ">
            <div style={{ display: "flex", gap: 6 }}>
              {([["general", "Загальні"], ["personal", "Особисті"], ["offer", "🔒 Офер"]] as [DocSection, string][]).map(([k, l]) => <Chip key={k} label={l} active={section === k} onClick={() => setSection(k)} />)}
            </div>
          </Field>
        )}
        {section === "general" && (
          <Field label="Папка">
            <select value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)} style={inp}>
              {(mgmt || tree.viewer.canUploadRoot) && <option value="">Без папки</option>}
              {allowedFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
        )}
        {section !== "general" && (
          <Field label="Адресат">
            <select value={addressee} onChange={(e) => setAddressee(e.target.value ? Number(e.target.value) : "")} style={inp}>
              <option value="">— оберіть людину —</option>
              {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.team ? ` · ${p.team}` : ""}</option>)}
            </select>
          </Field>
        )}
        <Field label="Тип">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{DOC_TYPES.map((c) => <Chip key={c} label={c} active={category === c} onClick={() => setCategory(c)} />)}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{TYPE_META[category]?.action}</div>
        </Field>
        <Field label="Опис (необовʼязково)"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="одним реченням: про що документ" style={inp} /></Field>
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); setFiles(Array.from(e.dataTransfer.files)); }}
          style={{ border: `2px dashed ${drag ? "var(--brand)" : "var(--border-strong)"}`, borderRadius: 12, padding: 18, textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
          {files.length ? files.map((f) => <div key={f.name} style={{ color: "var(--text)", fontWeight: 600 }}>{f.name} · {fmtBytes(f.size)}</div>) : "Перетягніть файли сюди або"}
          <div style={{ marginTop: 8 }}><label style={{ ...btn(), cursor: "pointer" }}>Обрати файл<input type="file" multiple={section === "general"} hidden onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></label></div>
          <div style={{ fontSize: 11, marginTop: 6 }}>до {MAX_MB} МБ · PDF, зображення і HTML відкриваються в дашборді, решта — завантаженням</div>
        </div>
        {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={btn()} onClick={onClose} disabled={busy}>Скасувати</button>
          <button style={btn("primary")} onClick={() => void submit()} disabled={busy}>{busy ? "Завантаження…" : "Завантажити"}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Підпис ─────────────────────────────────────────────────────────────── */
function SignDialog({ file, onClose, onDone }: { file: DocFile; onClose: () => void; onDone: () => Promise<void> }) {
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [method, setMethod] = useState<"telegram_code" | "paper_photo" | "diia">("telegram_code");
  const [photo, setPhoto] = useState<File | null>(null);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetchTelegramStatus().then((t) => { setTg(t); if (!t.configured) setMethod("paper_photo"); }).catch(() => setTg({ configured: false, linked: false, linkedAt: null, botUsername: null })); }, []);
  // Поки діалог відкритий і Telegram не привʼязаний — опитуємо стан, щоб після «Старт» у боті
  // кнопка «Надіслати код» зʼявилась сама, без перезавантаження.
  useEffect(() => {
    if (!tg || tg.linked || !tg.configured || method !== "telegram_code") return;
    const t = setInterval(() => { fetchTelegramStatus().then(setTg).catch(() => { /* спробуємо наступного разу */ }); }, 3000);
    return () => clearInterval(t);
  }, [tg, method]);
  const link = async () => {
    setErr(null);
    try { const { url } = await createTelegramLink(); window.open(url, "_blank", "noopener"); }
    catch (e) { setErr(errOf(e, "Не вдалося створити посилання")); }
  };
  const sendCode = async () => {
    setBusy(true); setErr(null);
    try { await signDocFile(file.id, { method: "telegram_code", step: "send" }); setSent(true); }
    catch (e) { setErr(errOf(e, "Код не надіслано")); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    setErr(null);
    if (method === "diia") { setErr("Дія.Підпис підключається окремо: договір, сертифікат, тест."); return; }
    setBusy(true);
    try {
      if (method === "paper_photo") {
        if (!photo) { setErr("Додайте фото або скан підписаного документа"); setBusy(false); return; }
        await signDocFile(file.id, { method: "paper_photo", filename: photo.name, dataBase64: await readAsDataUrl(photo) });
      } else {
        if (!/^\d{6}$/.test(code.trim())) { setErr("Введіть 6 цифр із повідомлення бота"); setBusy(false); return; }
        await signDocFile(file.id, { method: "telegram_code", step: "verify", code: code.trim() });
      }
      await onDone();
    } catch (e) { setErr(errOf(e, "Підпис не збережено")); setBusy(false); }
  };
  const tgHint = !tg ? "Перевіряю…" : !tg.configured ? "Бот ще не налаштований на сервері." : tg.linked ? "Код прийде в бот «UTS Підпис»." : "Спершу привʼяжіть Telegram — одна кнопка нижче.";
  return (
    <Modal title={`Підписати: ${file.name}`} onClose={onClose} width={520}>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>Підпис привʼязується до версії v{file.version} і її відбитка. Якщо файл замінять, підписати доведеться знову.</div>
      <div style={{ display: "grid", gap: 8 }}>
        {([
          ["telegram_code", "Одноразовий код у Telegram", tgHint, !!tg?.configured],
          ["paper_photo", "Фото паперового варіанта", "Роздрукуй, підпиши, сфотографуй або відскануй і додай сюди.", true],
          ["diia", "Дія.Підпис (КЕП)", "Після підключення до Дії — договір, сертифікат, тест.", false],
        ] as [typeof method, string, string, boolean][]).map(([k, l, d, on]) => (
          <label key={k} style={{ display: "flex", gap: 10, alignItems: "flex-start", border: `1px solid ${method === k ? "var(--brand)" : "var(--border)"}`, borderRadius: 10, padding: 10, cursor: on ? "pointer" : "not-allowed", opacity: on ? 1 : .6 }}>
            <input type="radio" checked={method === k} disabled={!on} onChange={() => { setMethod(k); setErr(null); }} />
            <span><div style={{ fontWeight: 700, fontSize: 13 }}>{l}</div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{d}</div></span>
          </label>
        ))}
      </div>
      {method === "telegram_code" && tg?.configured && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {!tg.linked && <button style={btn("primary")} onClick={() => void link()}>Привʼязати Telegram</button>}
          {!tg.linked && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Відкриється бот @{tg.botUsername}. Натисніть у ньому «Старт» — і повертайтесь сюди, кнопка «Надіслати код» зʼявиться сама.</div>}
          {tg.linked && !sent && <button style={btn("primary")} onClick={() => void sendCode()} disabled={busy}>{busy ? "Надсилаю…" : "Надіслати код у Telegram"}</button>}
          {tg.linked && sent && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 цифр із бота" inputMode="numeric" style={{ ...inp, width: 140, letterSpacing: 4, fontWeight: 700 }} autoFocus />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Код діє 5 хвилин.</span>
              <button style={{ ...btn(), fontSize: 12, padding: "4px 10px" }} onClick={() => void sendCode()} disabled={busy}>Надіслати ще раз</button>
            </div>
          )}
        </div>
      )}
      {method === "paper_photo" && (
        <div style={{ marginTop: 10 }}>
          <label style={{ ...btn(), cursor: "pointer" }}>{photo ? `📎 ${photo.name}` : "Додати фото / скан"}<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></label>
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button style={btn()} onClick={onClose} disabled={busy}>Скасувати</button>
        <button style={btn("primary")} onClick={() => void submit()} disabled={busy || (method === "telegram_code" && (!tg?.linked || !sent))}>{busy ? "Зберігаю…" : "Підписати"}</button>
      </div>
    </Modal>
  );
}

/** 🤖 Чип у шапці: привʼязано / привʼязати Telegram. Потрібен усім, не лише підписантам — сюди йдуть нагадування. */
function TelegramChip({ onToast }: { onToast: (t: string) => void }) {
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const load = () => fetchTelegramStatus().then(setTg).catch(() => setTg(null));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { fetchTelegramStatus().then((s) => { setTg(s); if (s.linked) { setWaiting(false); onToast("Telegram привʼязано"); } }).catch(() => { /* ще раз через 3 с */ }); }, 3000);
    const stop = setTimeout(() => setWaiting(false), 10 * 60_000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [waiting, onToast]);
  if (!tg || !tg.configured) return null;
  if (tg.linked) {
    return <button title="Telegram привʼязано. Натисніть, щоб відвʼязати" style={{ ...btn(), fontSize: 12, padding: "5px 10px", color: "var(--ok)" }}
      onClick={() => { if (window.confirm("Відвʼязати Telegram? Коди підпису й нагадування перестануть приходити.")) void unlinkTelegram().then(load); }}>🤖 Telegram ✓</button>;
  }
  return <button title="Привʼязати Telegram для підпису й нагадувань" style={{ ...btn(), fontSize: 12, padding: "5px 10px" }}
    onClick={() => { createTelegramLink().then(({ url }) => { window.open(url, "_blank", "noopener"); setWaiting(true); }).catch(() => onToast("Не вдалося створити посилання")); }}>
    {waiting ? "🤖 чекаю «Старт» у боті…" : "🤖 Привʼязати Telegram"}</button>;
}

/* ── Матриця доступів ───────────────────────────────────────────────────── */
function AccessDialog({ folder, onClose, onSaved }: { folder: DocFolder; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<DocFolderAccess | null>(null);
  const [people, setPeople] = useState<{ userId: number; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newUser, setNewUser] = useState<number | "">("");
  const [newUntil, setNewUntil] = useState("");
  useEffect(() => {
    fetchDocFolderAccess(folder.id).then(setData).catch((e) => setErr(errOf(e, "Доступи не завантажились")));
    fetchDocPeople().then(setPeople).catch(() => {});
  }, [folder.id]);
  const toggle = (key: string, field: "canView" | "canUpload" | "canEdit" | "canPublish") =>
    setData((d) => d && { ...d, roles: d.roles.map((r) => r.key === key && !r.management ? { ...r, [field]: !r[field] } : r) });
  const addGrant = () => {
    if (!newUser || !data) return;
    const p = people.find((x) => x.userId === Number(newUser)); if (!p) return;
    setData({ ...data, grants: [...data.grants, { id: 0, userId: p.userId, name: p.name, canView: true, canUpload: false, expiresAt: newUntil ? new Date(newUntil).toISOString() : null }] });
    setNewUser(""); setNewUntil("");
  };
  const save = async () => {
    if (!data) return; setBusy(true); setErr(null);
    try { await saveDocFolderAccess(folder.id, { roles: data.roles.map((r) => ({ key: r.key, canView: r.canView, canUpload: r.canUpload, canEdit: r.canEdit, canPublish: r.canPublish })), grants: data.grants.map((g) => ({ userId: g.userId, canView: g.canView, canUpload: g.canUpload, expiresAt: g.expiresAt })) }); onSaved(); }
    catch (e) { setErr(errOf(e, "Не збережено")); setBusy(false); }
  };
  const cols: [keyof DocFolderAccess["roles"][number], string][] = [["canView", "БАЧИТЬ"], ["canUpload", "ЗАВАНТАЖУЄ"], ["canEdit", "РЕДАГУЄ"], ["canPublish", "ПУБЛІКУЄ В ЗАГАЛЬНІ"], ["canManage", "КЕРУЄ ДОСТУПОМ"]];
  return (
    <Modal title="Доступи до папки" onClose={onClose} width={720}>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>Папка «{folder.name}». Права наслідуються всіма файлами всередині.</div>
      {err && <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>{err}</div>}
      {!data ? <p className="loading-text">Завантаження…</p> : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>
              <th style={{ textAlign: "left", fontSize: 11, color: "var(--text-muted)", padding: "6px 4px", letterSpacing: ".06em" }}>РОЛЬ</th>
              {cols.map(([k, l]) => <th key={k} style={{ fontSize: 10, color: "var(--text-muted)", padding: "6px 4px", letterSpacing: ".06em", textAlign: "center" }}>{l}</th>)}
            </tr></thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.key} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 4px" }}>
                    <div style={{ fontWeight: 700 }}>{r.name}{r.management && <span style={{ ...pill("#dbeafe", "#1d4ed8"), marginLeft: 8 }}>керівництво</span>}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.management ? "повний доступ, змінює права" : r.key === "team_lead" ? "тімлід своєї команди" : r.key === "manager" ? "лише свій документ в оферах" : ""}</div>
                  </td>
                  {cols.map(([k]) => (
                    <td key={k} style={{ textAlign: "center" }}>
                      <input type="checkbox" checked={!!r[k]} disabled={r.management || k === "canManage"} onChange={() => k !== "canManage" && toggle(r.key, k as "canView")} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--text-muted)", margin: "16px 0 8px" }}>ПЕРСОНАЛЬНІ ВИНЯТКИ</div>
          {data.grants.map((g, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px", marginBottom: 6, fontSize: 13 }}>
              <b>{g.name}</b>
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={g.canView} onChange={() => setData({ ...data, grants: data.grants.map((x, j) => j === i ? { ...x, canView: !x.canView } : x) })} /> бачить</label>
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={g.canUpload} onChange={() => setData({ ...data, grants: data.grants.map((x, j) => j === i ? { ...x, canUpload: !x.canUpload } : x) })} /> завантажує</label>
              <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: "auto" }}>{g.expiresAt ? `до ${fmtDate(g.expiresAt)}` : "безстроково"}</span>
              <button onClick={() => setData({ ...data, grants: data.grants.filter((_, j) => j !== i) })} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select value={newUser} onChange={(e) => setNewUser(e.target.value ? Number(e.target.value) : "")} style={inp}><option value="">+ Додати людину</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select>
            <input type="date" value={newUntil} onChange={(e) => setNewUntil(e.target.value)} style={inp} title="Строк дії (порожньо = безстроково)" />
            <button style={btn()} onClick={addGrant} disabled={!newUser}>Додати</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>Зміни доступів пишуться в журнал: хто, коли, що змінив. Журнал не редагується.{data.log.length ? ` Останній запис: ${fmtDate(data.log[0].at)} · ${data.log[0].actor ?? "—"} · ${data.log[0].action}.` : ""}</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button style={btn()} onClick={onClose} disabled={busy}>Скасувати</button>
            <button style={btn("primary")} onClick={() => void save()} disabled={busy}>{busy ? "Зберігаю…" : "Зберегти доступи"}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>{children}</div>;
}
function Modal({ title, width, onClose, children }: { title: string; width: number; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59, background: "rgba(0,0,0,0.45)" }} />
      <div role="dialog" aria-label={title} style={{ position: "fixed", zIndex: 60, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: `min(${width}px, 94vw)`, maxHeight: "90vh", overflowY: "auto", ...card, padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "var(--text-muted)" }}>✕</button>
        </div>
        {children}
      </div>
    </>
  );
}
