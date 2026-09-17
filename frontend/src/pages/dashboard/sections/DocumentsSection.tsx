import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchDocTree, fetchDocCard, fetchDocViewers, fetchDocPeople, createDocFolder, renameDocFolder, deleteDocFolder,
  uploadDocFile, uploadDocVersion, updateDocFile, archiveDocFile, restoreDocFile, activateDocFile, deleteDocFile, fetchDocTrash, undeleteDocFile, ackDocFile, fetchDocAcks, remindDocAcks, signDocFile, fetchSigEvidenceBlobUrl, approveDocSignature, rejectDocSignature,
  fetchDocFolderAccess, saveDocFolderAccess, fetchDocFileBlobUrl, DOC_TYPES, fetchTelegramStatus, createTelegramLink, unlinkTelegram,
  type DocTree, type DocFile, type DocFolder, type DocCard, type DocSection, type DocFolderAccess, type TelegramStatus, type DocTrashFile,
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

/* Стиль — той самий, що в Задачнику/Навчанні: chart-card, data-table, kpi-card, orph-chip,
   btn-primary; поля вводу — глобальні (index.css), без власних радіусів і тіней. */
const pill = (bg: string, color: string): React.CSSProperties => ({ display: "inline-block", fontSize: 11.5, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "middle", fontWeight: 700, padding: "3px 10px", borderRadius: "var(--r-pill)", background: bg, color, whiteSpace: "nowrap" });
const btn = (kind: "primary" | "ghost" | "danger" = "ghost"): React.CSSProperties => ({
  border: kind === "ghost" ? "1px solid var(--border)" : "none", borderRadius: "var(--r-lg)", padding: "var(--sp-3) var(--sp-6)", fontWeight: 600, cursor: "pointer",
  background: kind === "primary" ? "var(--brand)" : kind === "danger" ? "var(--danger-bg)" : "var(--card-bg)",
  color: kind === "primary" ? "#fff" : kind === "danger" ? "var(--danger)" : "var(--text)",
});
const inp: React.CSSProperties = {};
const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 };
/* Рядок рейки (папки/типи): одна висота, назва в один рядок з обрізанням, лічильник у своїй колонці,
   іконки дій однакової ширини — щоб відстані навколо були рівні незалежно від довжини назви. */
const noteBox: React.CSSProperties = { fontSize: "var(--fs-sm)", color: "var(--text-muted)", background: "var(--surface-2)", borderRadius: "var(--r-md)", padding: "var(--sp-3) var(--sp-4)" };

function AckBadge({ f }: { f: DocFile }) {
  const a = f.ack;
  if (a.total != null) return <span style={pill(a.done === a.total ? "var(--ok-bg)" : "var(--info-bg)", a.done === a.total ? "var(--ok)" : "var(--info)")}>ознайомились {a.done}/{a.total}</span>;
  if (a.mine === "acked") return <span style={pill("var(--ok-bg)", "var(--ok)")}>✓ ознайомлений</span>;
  return <span style={pill("var(--warn-bg)", "var(--warn)")}>● ознайомтесь</span>;
}

function SigBadge({ f }: { f: DocFile }) {
  const s = f.signature;
  if (s.kind === "not_required") return null;
  if (s.kind === "signed") return <span style={pill("var(--ok-bg)", "var(--ok)")}>● Підписано</span>;
  if (s.kind === "review") return <span style={pill("var(--info-bg)", "var(--info)")}>● Фото на підтвердженні</span>;
  if (s.kind === "outdated") return <span style={pill("var(--warn-bg)", "var(--warn)")}>● Потребує підпису · нова версія</span>;
  if (s.kind === "overdue") return <span style={pill("var(--danger-bg)", "var(--danger)")}>● Прострочено · {s.days} дн.</span>;
  return <span style={pill("var(--warn-bg)", "var(--warn)")}>● Чекає підпису{s.days != null ? ` · ${s.days} дн.` : ""}</span>;
}

export function DocumentsSection({ isAdmin: _legacyIsAdmin }: { isAdmin: boolean }) {
  const [tree, setTree] = useState<DocTree | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("general");
  const [shelfState, setShelfState] = useState<"reg" | "work">("reg");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<number | null | "none" | "all">("all");
  const [q, setQ] = useState("");
  // Відкритий документ живе в адресі (?doc=25): переживає оновлення сторінки й пересилається посиланням.
  const [selected, setSelectedRaw] = useState<number | null>(() => { const v = Number(new URLSearchParams(window.location.search).get("doc")); return Number.isInteger(v) && v > 0 ? v : null; });
  const setSelected = (id: number | null) => {
    setSelectedRaw(id);
    const u = new URL(window.location.href);
    if (id == null) u.searchParams.delete("doc"); else u.searchParams.set("doc", String(id));
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  };
  // Вузький екран (< 1000 px): одна панель за раз — навігація → список → документ, з «← Назад».
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1000px)").matches);
  useEffect(() => { const m = window.matchMedia("(max-width: 1000px)"); const on = () => setNarrow(m.matches); m.addEventListener("change", on); return () => m.removeEventListener("change", on); }, []);
  const [narrowPane, setNarrowPane] = useState<"nav" | "list">("list");
  const [trash, setTrash] = useState<DocTrashFile[] | null>(null);
  const [inTrash, setInTrash] = useState(false);
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
  const loadTrash = () => fetchDocTrash().then(setTrash).catch(() => setTrash(null));
  useEffect(() => { if (tree?.viewer.isManagement) void loadTrash(); }, [tree?.viewer.isManagement]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const viewer = tree?.viewer;
  const folderName = (id: number | null) => id == null ? "Без папки" : (tree?.folders.find((x) => x.id === id)?.name ?? `Папка #${id}`);

  const selectedFile = tree?.files.find((f) => f.id === selected) ?? null;

  // ── Три стани ────────────────────────────────────────────────────────────
  if (loading && !tree) return <div className="chart-card"><p className="loading-text">Завантаження документів…</p></div>;
  if (loadErr && !tree) return (
    <StateBlock icon="⚠" title="Не вдалося завантажити список" text={`Сервер відповів помилкою. Файли на місці — це збій відображення. ${loadErr}`}
      action={<button style={btn("primary")} onClick={() => void load()}>Спробувати ще раз</button>} />
  );
  if (!tree || !viewer) return null;

  const canUploadHere = viewer.isManagement || viewer.canUploadRoot || viewer.uploadFolders.length > 0;

  const REG_TYPES = new Set(["Регламент", "Інструкція"]);
  // Розділи навігації (макет «Documents Split View», обраний власником 16.09.2026):
  // регламенти окремо від робочих документів, мої документи, архів.
  type Shelf = "reg" | "work" | "mine" | "archive";
  const shelfOf = (f: DocFile): Shelf => f.archivedAt ? "archive" : f.section !== "general" ? "mine" : REG_TYPES.has(f.category ?? "Інше") ? "reg" : "work";
  const visibleAll = tree.files;
  const shelfCount = (k: Shelf) => visibleAll.filter((f) => shelfOf(f) === k).length;
  const shelf: Shelf = section === "archive" ? "archive" : section !== "general" ? "mine" : (typeFilter && !REG_TYPES.has(typeFilter)) ? "work" : (typeFilter ? "reg" : (shelfState));
  const setShelf = (k: Shelf) => { setInTrash(false); setNarrowPane("list"); setShelfState(k === "mine" ? "reg" : k === "archive" ? "reg" : k); setSection(k === "archive" ? "archive" : k === "mine" ? (tree.sections.offer && visibleAll.some((f) => f.section === "offer" && !f.archivedAt) ? "offer" : "personal") : "general"); setTypeFilter(null); setFolderFilter("all"); setSelected(null); };
  const shelfFiles = visibleAll.filter((f) => shelfOf(f) === shelf && (shelf !== "mine" || f.section === section || section === "general"));
  const listFiles = shelfFiles
    .filter((f) => !typeFilter || (f.category ?? "Інше") === typeFilter)
    .filter((f) => folderFilter === "all" || (folderFilter === "none" ? f.folderId == null : f.folderId === folderFilter))
    .filter((f) => { const qq = q.trim().toLowerCase(); return !qq || f.name.toLowerCase().includes(qq) || (f.description ?? "").toLowerCase().includes(qq) || (f.addressee ?? "").toLowerCase().includes(qq); });
  const shelfFolderCounts = new Map<number | null, number>(); shelfFiles.forEach((f) => shelfFolderCounts.set(f.folderId, (shelfFolderCounts.get(f.folderId) ?? 0) + 1));
  const shelfTypeCounts = new Map<string, number>(); shelfFiles.forEach((f) => shelfTypeCounts.set(f.category ?? "Інше", (shelfTypeCounts.get(f.category ?? "Інше") ?? 0) + 1));
  const uidMine = viewer.userId;
  const todo = {
    offers: visibleAll.filter((f) => f.section === "offer" && !f.archivedAt && f.addresseeUserId === uidMine && f.signature.kind !== "signed" && f.signature.kind !== "not_required").length,
    regs: visibleAll.filter((f) => f.ack.required && f.ack.mine === "pending").length,
    review: visibleAll.filter((f) => f.signature.kind === "review").length,
  };
  // Папки для розділу — рахуються для КОЖНОГО розділу окремо, щоб згорнутий список не змінював висоту
  // при перемиканні (стрибки навігації, власник 17.09.2026). Дії з папкою — іконками в тому ж рядку.
  const folderRows = (k: Shelf) => {
    const counts = new Map<number | null, number>();
    visibleAll.forEach((f) => { if (shelfOf(f) === k) counts.set(f.folderId, (counts.get(f.folderId) ?? 0) + 1); });
    return [...tree.folders.filter((f) => f.parentId == null), null].map((f) => {
      const id = f?.id ?? null; const n = counts.get(id) ?? 0; if (!n) return null;
      const on = shelf === k && folderFilter === (f ? id : "none");
      const icon: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", fontSize: 12, width: 22, height: 22, padding: 0, flex: "0 0 auto" };
      return (
        <div key={f?.id ?? "none"} style={{ display: "flex", alignItems: "center", borderRadius: "var(--r-md)", background: on ? "var(--surface-2)" : "transparent" }}>
          <button style={{ ...subBtn(on), background: "transparent", flex: 1, minWidth: 0 }} onClick={() => { setFolderFilter(on ? "all" : (f ? id : "none")); setInTrash(false); setNarrowPane("list"); }} title={f ? f.name : "Без папки"}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f ? f.name.replace(/^\d+\.\s*/, "") : "Без папки"}</span>{!(on && f && viewer.canManageAccess) && <span style={cnt(n)}>{n}</span>}
          </button>
          {on && f && viewer.canManageAccess && (
            <>
              <button title="Доступи до папки" style={icon} onClick={() => setAccessFolder(f)}>⚙</button>
              <button title="Перейменувати" style={icon} onClick={() => { const nn = window.prompt("Нова назва папки:", f.name)?.trim(); if (nn && nn !== f.name) void renameDocFolder(f.id, nn).then(load).catch((e) => setToast(errOf(e, "Не перейменовано"))); }}>✎</button>
              <button title="Прибрати папку (файли лишаються на диску)" style={icon} onClick={() => { if (window.confirm(`Прибрати папку «${f.name}»? Її документи зникнуть з екрана; файли на диску лишаються.`)) void deleteDocFolder(f.id).then(load).catch((e) => setToast(errOf(e, "Не вдалося"))); }}>✕</button>
            </>
          )}
        </div>
      );
    });
  };
  const paneH = "calc(100vh - 150px)";
  const navBtn = (on: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", textAlign: "left", padding: "8px 10px", borderRadius: "var(--r-lg)", cursor: "pointer", fontSize: "var(--fs-base)", background: on ? "var(--brand)" : "transparent", color: on ? "#fff" : "var(--text)", fontWeight: on ? 600 : 400 });
  const subBtn = (on: boolean): React.CSSProperties => ({ display: "flex", alignItems: "center", gap: 6, width: "100%", border: "none", textAlign: "left", padding: "6px 10px 6px 26px", borderRadius: "var(--r-md)", cursor: "pointer", fontSize: "var(--fs-13)", background: on ? "var(--surface-2)" : "transparent", color: "var(--text)", fontWeight: on ? 600 : 400 });
  const cnt = (_n: number, on = false): React.CSSProperties => ({ marginLeft: "auto", fontSize: 12, opacity: on ? .85 : .7, fontVariantNumeric: "tabular-nums" });

  return (
    <div>
      {toast && <div className="chart-card" style={{ position: "fixed", top: 16, right: 16, zIndex: 80, background: "var(--ok-bg)", color: "var(--ok)", fontWeight: 600, padding: "10px 14px" }}>{toast}</div>}
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 className="page-title">📁 Регламенти та документи</h1>
        <div className="page-filters">
          <TelegramChip onToast={setToast} />
          {viewer.isManagement && <button style={btn()} onClick={() => { const n = window.prompt("Назва нової папки:")?.trim(); if (n) void createDocFolder(n, null).then(load).catch((e) => setToast(errOf(e, "Не вдалося створити папку"))); }}>➕ Папка</button>}
          {canUploadHere && <button className="btn-primary" onClick={() => setUploadOpen(true)}>+ Завантажити</button>}
        </div>
      </div>

      {/* Три панелі: навігація · список · перегляд (макет Documents Split View) */}
      <div className="chart-card" style={{ padding: 0, display: "grid", gridTemplateColumns: narrow ? "minmax(0,1fr)" : "220px 380px minmax(0,1fr)", minHeight: 420, height: narrow ? "auto" : paneH, overflow: "hidden" }}>
        {/* Навігація */}
        <div style={{ borderRight: narrow ? "none" : "1px solid var(--border)", padding: 12, overflowY: "auto", display: narrow && (narrowPane !== "nav" || selectedFile) ? "none" : "flex", flexDirection: "column", gap: 2 }}>
          <div style={label}>Мої справи</div>
          <button style={{ ...subBtn(false), paddingLeft: 10, color: todo.offers ? "var(--warn)" : "var(--text-muted)" }} onClick={() => setShelf("mine")}>🔏 Офер чекає підпису<span style={cnt(todo.offers)}>{todo.offers}</span></button>
          <button style={{ ...subBtn(false), paddingLeft: 10, color: todo.regs ? "var(--warn)" : "var(--text-muted)" }} onClick={() => setShelf("reg")}>📖 Ознайомитись<span style={cnt(todo.regs)}>{todo.regs}</span></button>
          {viewer.isManagement && <button style={{ ...subBtn(false), paddingLeft: 10, color: todo.review ? "var(--info)" : "var(--text-muted)" }} onClick={() => setShelf("mine")}>📷 Фото на підтвердженні<span style={cnt(todo.review)}>{todo.review}</span></button>}
          <div style={{ ...label, marginTop: 12 }}>Розділи</div>
          <button style={navBtn(!inTrash && shelf === "reg")} onClick={() => setShelf("reg")}>📕 Регламенти<span style={cnt(shelfCount("reg"), shelf === "reg")}>{shelfCount("reg")}</span></button>
          <Collapse open={!inTrash && shelf === "reg"}>{folderRows("reg")}</Collapse>
          <button style={navBtn(!inTrash && shelf === "work")} onClick={() => setShelf("work")}>🗂 Робочі документи<span style={cnt(shelfCount("work"), shelf === "work")}>{shelfCount("work")}</span></button>
          <Collapse open={!inTrash && shelf === "work"}>{folderRows("work")}</Collapse>
          <button style={navBtn(!inTrash && shelf === "mine")} onClick={() => setShelf("mine")}>🔒 {viewer.isManagement ? "Особисті та офери" : "Мої документи"}<span style={cnt(shelfCount("mine"), shelf === "mine")}>{shelfCount("mine")}</span></button>
          <Collapse open={!inTrash && shelf === "mine"}>
            {tree.sections.offer && <button style={subBtn(section === "offer")} onClick={() => { setSection("offer"); setSelected(null); setInTrash(false); setNarrowPane("list"); }}>🔒 Офери<span style={cnt(0)}>{visibleAll.filter((f) => f.section === "offer" && !f.archivedAt).length}</span></button>}
            <button style={subBtn(section === "personal")} onClick={() => { setSection("personal"); setSelected(null); setInTrash(false); setNarrowPane("list"); }}>Особисті<span style={cnt(0)}>{visibleAll.filter((f) => f.section === "personal" && !f.archivedAt).length}</span></button>
          </Collapse>
          {tree.sections.archive && <button style={navBtn(!inTrash && shelf === "archive")} onClick={() => setShelf("archive")}>🗄 Архів<span style={cnt(shelfCount("archive"), shelf === "archive")}>{shelfCount("archive")}</span></button>}
          {viewer.isManagement && <button style={navBtn(inTrash)} onClick={() => { setInTrash(true); setSelected(null); setNarrowPane("list"); void loadTrash(); }}>🗑 Кошик<span style={cnt(trash?.length ?? 0, inTrash)}>{trash?.length ?? 0}</span></button>}
          <p className="loading-text" style={{ marginTop: "auto", paddingTop: 10, fontSize: 11.5, lineHeight: 1.4, minHeight: 64 }}>{shelf === "reg" ? "Регламенти виконують, інструкції роблять за кроками. У кожного регламенту є «Ознайомився»." : shelf === "work" ? "Шаблони беруть і заповнюють, матеріали надсилають клієнту." : shelf === "mine" ? SECTION_HINT[section] : SECTION_HINT.archive}</p>
        </div>

        {/* Список */}
        <div style={{ borderRight: narrow ? "none" : "1px solid var(--border)", display: narrow && (narrowPane !== "list" || selectedFile) ? "none" : "flex", flexDirection: "column", minWidth: 0, minHeight: narrow ? 420 : undefined }}>
          {narrow && <button style={{ ...btn(), margin: "10px 12px 0", alignSelf: "flex-start", fontSize: 12, padding: "4px 10px" }} onClick={() => setNarrowPane("nav")}>☰ Розділи й папки</button>}
          {inTrash ? (
            <>
              <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}><h2 className="chart-title" style={{ margin: 0 }}>🗑 Кошик</h2><span className="orph-dim">{trash?.length ?? 0}</span></div>
                <p className="loading-text" style={{ margin: "6px 0 0", fontSize: 12 }}>Видалені документи бачить лише керівництво. «Повернути» ставить документ туди, де він був: у той самий розділ, папку й стан підпису.</p>
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {trash == null ? <p className="loading-text" style={{ margin: 12 }}>Завантаження…</p>
                  : trash.length === 0 ? <StateBlock icon="🗑" title="Кошик порожній" text="Тут зʼявляться документи, які керівництво видалило." inline />
                  : trash.map((f) => { const t = TYPE_META[f.category ?? "Інше"] ?? TYPE_META["Інше"]; return (
                    <div key={f.id} style={{ display: "grid", gridTemplateColumns: "40px minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                      <span style={{ width: 40, height: 44, borderRadius: "var(--r-md)", border: `1px solid ${t.color}55`, background: t.color + "10", color: t.color, display: "grid", placeItems: "center", fontSize: 9, fontWeight: 800, opacity: .7 }}>{extOf(f.name, f.mime)}</span>
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name.replace(/\.[a-z0-9]+$/i, "")}</div>
                        <div className="orph-dim">{f.section === "offer" ? "🔒 Офер" : f.section === "personal" ? "Особистий" : folderName(f.folderId)}{f.addressee ? ` · ${f.addressee}` : ""} · v{f.version}</div>
                        <div className="orph-dim">видалив {f.deletedBy ?? "невідомо"} · {fmtDate(f.deletedAt)}</div>
                      </span>
                      <button style={btn()} onClick={() => void undeleteDocFile(f.id).then(async () => { setToast(`«${f.name}» повернуто`); await Promise.all([load(), loadTrash()]); }).catch((e) => setToast(errOf(e, "Не вдалося повернути")))}>↩ Повернути</button>
                    </div>); })}
              </div>
            </>
          ) : (<>
          <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}><h2 className="chart-title" style={{ margin: 0 }}>{shelf === "reg" ? "Регламенти та інструкції" : shelf === "work" ? "Робочі документи" : shelf === "mine" ? (section === "offer" ? "🔒 Офери" : "Особисті") : "Архів"}</h2><span className="orph-dim">{listFiles.length} {listFiles.length === 1 ? "документ" : listFiles.length < 5 ? "документи" : "документів"}</span></div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Пошук за назвою, описом, адресатом" style={{ width: "100%" }} />
            {shelfTypeCounts.size > 1 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="orph-chip" aria-pressed={typeFilter === null} onClick={() => setTypeFilter(null)} style={{ padding: "4px 10px", fontSize: 12 }}>Усі</button>
                {[...DOC_TYPES].filter((t) => shelfTypeCounts.has(t)).map((t) => <button key={t} className="orph-chip" aria-pressed={typeFilter === t} onClick={() => setTypeFilter(typeFilter === t ? null : t)} style={{ padding: "4px 10px", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}><span className="task-status-dot" style={{ background: TYPE_META[t].color }} />{t} · {shelfTypeCounts.get(t)}</button>)}
              </div>
            )}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {listFiles.length === 0 ? (
              shelfFiles.length === 0
                ? <StateBlock icon="🗀" title={shelf === "archive" ? "В архіві ще нічого немає" : "Тут ще нічого немає"} text={canUploadHere ? "Натисніть «Завантажити»." : "Документи сюди викладає керівництво."} action={canUploadHere ? <button style={btn()} onClick={() => setUploadOpen(true)}>Завантажити файл</button> : undefined} inline />
                : <p className="loading-text" style={{ margin: 12 }}>Нічого не знайдено за фільтром.</p>
            ) : listFiles.map((f) => { const t = TYPE_META[f.category ?? "Інше"] ?? TYPE_META["Інше"]; const sel = f.id === selected; return (
              <div key={f.id} onClick={() => setSelected(f.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSelected(f.id); }}
                style={{ display: "grid", gridTemplateColumns: "40px minmax(0,1fr)", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--border)", cursor: "pointer", background: sel ? "var(--surface-2)" : undefined, boxShadow: sel ? "inset 3px 0 0 var(--brand)" : undefined }}>
                <span style={{ width: 40, height: 44, borderRadius: "var(--r-md)", border: `1px solid ${t.color}55`, background: t.color + "10", color: t.color, display: "grid", placeItems: "center", fontSize: 9, fontWeight: 800 }}>{extOf(f.name, f.mime)}</span>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: sel ? 700 : 600, fontSize: "var(--fs-base)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name.replace(/\.[a-z0-9]+$/i, "")}</div>
                  <div className="orph-dim" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.description || `${f.category ?? "Інше"} · ${t.action}`}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                    <span className="orph-dim">{f.addressee ?? f.author ?? "автор не вказаний"} · {fmtDate(f.updatedAt)} · v{f.version}</span>
                    {f.archivedAt ? <span style={pill("var(--surface-2)", "var(--text-muted)")}>{f.archivedReason === "dismissed" ? "звільнено" : "в архіві"}</span> : f.inactiveAt ? <span style={pill("var(--warn-bg)", "var(--warn)")}>неактивний</span> : f.ack.required ? <AckBadge f={f} /> : <SigBadge f={f} />}
                  </div>
                </span>
              </div>); })}
          </div>
          </>)}
        </div>

        {/* Перегляд */}
        {selectedFile && !inTrash ? (
          <div style={{ overflowY: "auto", minWidth: 0 }}>
            {narrow && <button style={{ ...btn(), margin: "10px 16px 0", fontSize: 12, padding: "4px 10px" }} onClick={() => setSelected(null)}>← До списку</button>}
            <DocCardPanel key={selectedFile.id} file={selectedFile} tree={tree} onChanged={async () => { await load(); if (viewer.isManagement) await loadTrash(); }} onClose={() => setSelected(null)} onToast={setToast} folderName={folderName} />
          </div>
        ) : !narrow && (
          <div style={{ display: "grid", placeItems: "center", padding: 24, color: "var(--text-muted)", textAlign: "center" }}>
            <div>
              <div style={{ fontSize: 34, marginBottom: 8, opacity: .5 }}>📄</div>
              <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{inTrash ? "Кошик" : "Оберіть документ"}</div>
              <div style={{ fontSize: 13, maxWidth: 260 }}>{inTrash ? "Щоб переглянути видалений документ, спершу поверніть його." : "Тут зʼявиться перегляд, підпис, ознайомлення й дії з документом."}</div>
            </div>
          </div>
        )}
      </div>

      {uploadOpen && <UploadDialog tree={tree} section={section === "archive" ? "general" : section} defaultFolder={typeof folderFilter === "number" ? folderFilter : null}
        onClose={() => setUploadOpen(false)} onDone={(msg) => { setUploadOpen(false); setToast(msg); void load(); }} />}
      {accessFolder && <AccessDialog folder={accessFolder} onClose={() => setAccessFolder(null)} onSaved={() => { setAccessFolder(null); setToast("Доступи збережено, зміну записано в журнал"); void load(); }} />}
    </div>
  );
}

/** Плавне розгортання списку папок (grid-template-rows 0fr↔1fr); без анімації, якщо в системі вимкнено рух. */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <div style={{ display: "grid", gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transition: reduce ? "none" : "grid-template-rows .22s ease, opacity .18s ease" }} aria-hidden={!open}>
      <div style={{ overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column", gap: 2, visibility: open ? "visible" : "hidden", transition: reduce ? "none" : "visibility .22s" }}>{children}</div>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button type="button" className="orph-chip" aria-pressed={active} onClick={onClick} style={{ padding: "5px 12px", fontSize: 12 }}>{label}</button>;
}

function StateBlock({ icon, title, text, action, inline }: { icon: string; title: string; text: string; action?: React.ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? undefined : "chart-card"} style={{ textAlign: "center", padding: inline ? "28px 12px" : 40 }}>
      <div style={{ width: 52, height: 52, borderRadius: "var(--r-2xl)", background: "var(--surface-2)", display: "grid", placeItems: "center", margin: "0 auto 12px", fontSize: 22 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: "var(--fs-lg)", marginBottom: 6 }}>{title}</div>
      <p className="loading-text" style={{ fontSize: "var(--fs-13)", maxWidth: 420, margin: "0 auto 14px" }}>{text}</p>
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
  const [full, setFull] = useState(false);
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
    // Перечитуємо й після підпису / ознайомлення / активації — інакше таймлайн показує стан
    // на момент відкриття картки («Відкрито: ще ні» при вже підписаному, заміряно 16.09.2026).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.version, file.signature.kind, file.ack.mine, file.inactiveAt, file.archivedAt]);

  const open = async (download: boolean) => {
    // Вкладку відкриваємо СИНХРОННО в кліку: після await браузер блокує window.open як спливашку
    // (заміряно 16.09.2026: «Відкрити» мовчала). Файл довантажується вже у відкриту вкладку.
    const win = download ? null : window.open("about:blank", "_blank");
    try {
      const url = await fetchDocFileBlobUrl(file.id, { inline: !download });
      if (download) { const a = document.createElement("a"); a.href = url; a.download = file.name; a.click(); }
      else if (win) { win.location.href = url; }
      else { setErr("Браузер заблокував нову вкладку — дозвольте спливаючі вікна для дашборда або скористайтесь «Завантажити»."); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { win?.close(); setErr(errOf(e, "Не вдалося відкрити файл.")); }
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
  const activate = () => void activateDocFile(file.id).then(async () => { onToast("Документ активовано"); await onChanged(); }).catch((e) => setErr(errOf(e, "Не вдалося")));
  const remove = () => { if (window.confirm(`Видалити «${file.name}»? Документ зникне з усіх розділів, включно з архівом. Файл, версії й підписи в системі лишаються.`)) void deleteDocFile(file.id).then(async () => { onToast("Документ видалено"); await onChanged(); onClose(); }).catch((e) => setErr(errOf(e, "Не вдалося видалити"))); };
  const restore = () => void restoreDocFile(file.id).then(async () => { onToast("Повернуто з архіву"); await onChanged(); }).catch((e) => setErr(errOf(e, "Не вдалося")));

  if (noAccess) return (
    <StateBlock icon="🔒" title="Документ не для вас" text="Доступ мають адресат і керівництво. Якщо документ потрібен вам по роботі — зверніться до керівника." />
  );

  const sig = file.signature;
  const events = cardData?.events ?? [];
  // Таймлайн — для ПОТОЧНОЇ версії: «Надіслано» = останній sent, «Відкрито» = перший opened після нього.
  const lastSentIdx = events.map((e) => e.kind).lastIndexOf("sent");
  const sentAt = lastSentIdx >= 0 ? events[lastSentIdx].at : null;
  const openedAt = events.slice(lastSentIdx + 1).find((e) => e.kind === "opened")?.at ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={pill(t.color + "22", t.color)}>● {file.category ?? "Інше"}</span>
        <span style={pill("var(--surface-2)", "var(--text-muted)")}>{extOf(file.name, file.mime)}</span>
        <span style={pill("var(--surface-2)", "var(--text-muted)")}>v{file.version}</span>
        {file.section === "offer" && !file.archivedAt && <span style={pill("var(--info-bg)", "var(--info)")}>🔒 закрита папка</span>}
        {file.archivedAt && <span style={pill("var(--surface-2)", "var(--text-muted)")}>архів · {file.archivedReason === "dismissed" ? "звільнено" : "прибрано"} {fmtDate(file.archivedAt)}</span>}
        {file.inactiveAt && !file.archivedAt && <span style={pill("var(--warn-bg)", "var(--warn)")}>неактивний · повернуто з архіву {fmtDate(file.inactiveAt)}</span>}
        <button onClick={onClose} title="Закрити" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "var(--text-muted)" }}>✕</button>
      </div>
      <h2 className="chart-title" style={{ marginBottom: 0, lineHeight: 1.3 }}>{file.name}</h2>
      {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}
      {file.inactiveAt && !file.archivedAt && <p style={noteBox}>Документ повернувся з архіву після повернення людини в команду. Поки він неактивний: підписати чи редагувати не можна.{mgmt ? " Натисніть «Активувати», якщо він знову потрібен." : ""}</p>}

      {/* Прев'ю. PDF — без бічних мініатюр і на ширину панелі (параметри вбудованого переглядача
          браузера: navpanes=0, view=FitH), висота на весь екран панелі; «⤢ На весь екран» — оверлей.
          Файл без перегляду — один рядок, а не порожній блок (власник 17.09.2026). */}
      {kind === "none" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: "var(--text-muted)", background: "var(--surface-2)", borderRadius: "var(--r-lg)", padding: "8px 12px" }}>
          <span>📄 {extOf(file.name, file.mime)} не переглядається в дашборді</span>
          <button style={{ ...btn(), fontSize: 12, padding: "4px 10px", marginLeft: "auto" }} onClick={() => void open(true)}>Завантажити</button>
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", background: "var(--surface-2)", overflow: "hidden", position: "relative" }}>
          {!preview ? <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>завантаження прев'ю…</div>
            : kind === "image" ? <img src={preview} alt={file.name} style={{ width: "100%", display: "block" }} />
            : <iframe title={file.name} src={kind === "pdf" ? `${preview}#navpanes=0&view=FitH&zoom=page-width` : preview} style={{ width: "100%", height: "calc(100vh - 230px)", minHeight: 480, border: "none", background: "#fff", display: "block" }} />}
          {preview && <button onClick={() => setFull(true)} title="Відкрити перегляд на весь екран" style={{ ...btn(), position: "absolute", right: 10, bottom: 10, fontSize: 12, padding: "4px 10px", boxShadow: "var(--shadow)" }}>⤢ На весь екран</button>}
        </div>
      )}
      {full && preview && createPortal(
        <div onClick={() => setFull(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 2800, display: "flex", flexDirection: "column", padding: 16, gap: 8 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 10, color: "#fff" }}>
            <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</b>
            <button onClick={() => void open(true)} style={{ ...btn(), marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}>Завантажити</button>
            <button onClick={() => setFull(false)} style={{ ...btn(), fontSize: 12, padding: "4px 10px" }}>✕ Закрити</button>
          </div>
          <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, background: "#fff", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
            {kind === "image" ? <img src={preview} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
              : <iframe title={file.name} src={kind === "pdf" ? `${preview}#view=FitH&zoom=page-width` : preview} style={{ width: "100%", height: "100%", border: "none", display: "block" }} />}
          </div>
        </div>,
        document.body,
      )}

      {file.description ? <div style={{ fontSize: 13 }}>{file.description}</div> : file.canEdit && <button onClick={editDescription} style={{ ...btn(), fontSize: 12, padding: "4px 10px", alignSelf: "flex-start" }}>+ опис</button>}

      <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", rowGap: 6, fontSize: "var(--fs-13)" }}>
        <span style={{ color: "var(--text-muted)" }}>Папка</span><span>{file.section === "offer" ? "🔒 Офери" : file.archivedAt ? "Архів" : folderName(file.folderId)}</span>
        <span style={{ color: "var(--text-muted)" }}>Виклав</span><span>{file.author ?? "невідомо"}</span>
        {file.addressee && <><span style={{ color: "var(--text-muted)" }}>Адресат</span><span>{file.addressee}</span></>}
        <span style={{ color: "var(--text-muted)" }}>Оновлено</span><span>{fmtDate(file.updatedAt)}</span>
        <span style={{ color: "var(--text-muted)" }}>Розмір</span><span>{fmtBytes(file.sizeBytes)}</span>
        <span style={{ color: "var(--text-muted)" }}>Хеш</span><span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-muted)" }} title={file.sha256 ?? ""}>{file.sha256 ? `sha256 · ${file.sha256.slice(0, 12)}…${file.sha256.slice(-6)}` : "хеша немає (старий файл)"}</span>
        {file.canEdit && <><span style={{ color: "var(--text-muted)" }}>Тип</span>
          <select value={file.category ?? "Інше"} onChange={(e) => changeType(e.target.value)} style={{ padding: "3px 6px", fontSize: 12 }}>{DOC_TYPES.map((c) => <option key={c}>{c}</option>)}</select></>}
      </div>

      {/* Підпис */}
      {file.section === "offer" && (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 12 }}>
          <div style={label}>Підпис</div>
          <Timeline steps={[
            { label: "Надіслано", at: sentAt ?? file.createdAt, done: true, note: file.addressee ?? undefined },
            { label: "Відкрито", at: openedAt, done: !!openedAt },
            { label: "Підписано", at: sig.kind === "signed" ? (cardData?.signatures.find((s) => s.current && !s.rejectedAt)?.signedAt ?? null) : null, done: sig.kind === "signed",
              note: sig.kind === "signed" ? ({ paper_photo: "фото паперового варіанта, підтверджено", email_code: "код на пошту", telegram_code: "код у Telegram", diia: "Дія.Підпис" } as Record<string, string>)[cardData?.signatures.find((s) => s.current && !s.rejectedAt)?.method ?? ""] : sig.kind === "review" ? "фото на підтвердженні" : undefined },
          ]} />
          {sig.kind === "signed" && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Відбиток підпису привʼязано до версії {file.version}.</div>}
          {(() => {
            const cur = cardData?.signatures.find((s) => s.current && !s.rejectedAt);
            const lastRejected = cardData?.signatures.find((s) => s.version === file.version && s.rejectedAt);
            const showEvidence = async (sid: number) => { const win = window.open("about:blank", "_blank"); try { const u = await fetchSigEvidenceBlobUrl(file.id, sid); if (win) win.location.href = u; } catch (e) { win?.close(); setErr(errOf(e, "Фото не відкрилось")); } };
            const decide = async (approve: boolean) => {
              if (!cur) return;
              const reason = approve ? "" : (window.prompt("Причина відхилення (побачить підписант):") ?? "").trim();
              if (!approve && !reason) return;
              setBusy(true);
              try { if (approve) await approveDocSignature(file.id, cur.id); else await rejectDocSignature(file.id, cur.id, reason); onToast(approve ? "Підпис підтверджено" : "Підпис відхилено, підписанту повідомлено"); await onChanged(); }
              catch (e) { setErr(errOf(e, "Не вдалося")); } finally { setBusy(false); }
            };
            return (
              <>
                {cur?.hasEvidence && <button style={{ ...btn(), fontSize: 12, padding: "4px 10px", marginTop: 8 }} onClick={() => void showEvidence(cur.id)}>📷 Переглянути фото підпису</button>}
                {sig.kind === "review" && <div style={{ fontSize: 12, color: "var(--info)", marginTop: 6 }}>Фото паперового варіанта завантажено{cur?.signer ? ` (${cur.signer})` : ""}. Підпис стане чинним після підтвердження керівництвом.</div>}
                {sig.kind === "review" && mgmt && cur && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button style={btn("primary")} onClick={() => void decide(true)} disabled={busy}>Підтвердити підпис</button>
                    <button style={btn("danger")} onClick={() => void decide(false)} disabled={busy}>Відхилити</button>
                  </div>
                )}
                {!cur && lastRejected && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>Попередній підпис відхилено{lastRejected.rejectedReason ? `: ${lastRejected.rejectedReason}` : ""}. Потрібен новий.</div>}
              </>
            );
          })()}
          {sig.kind === "outdated" && <div style={{ fontSize: 12, color: "var(--warn)", marginTop: 6 }}>Файл замінено новою версією — попередній підпис стосується іншої версії й лишився в історії.</div>}
          {sig.kind === "overdue" && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>Прострочено на {sig.days} дн. Нічого не блокується: статус і нагадування.</div>}
          {file.canSign && <button style={{ ...btn("primary"), marginTop: 10, width: "100%" }} onClick={() => setSignOpen(true)}>Підписати</button>}
          {cardData && cardData.signatures.some((s) => !s.current) && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>Історія: {cardData.signatures.filter((s) => !s.current).map((s) => `v${s.version} · ${fmtDate(s.signedAt)} · ${s.signer ?? ""}`).join("; ")}</div>
          )}
        </div>
      )}

      {/* Ознайомлення (лише загальні регламенти) */}
      {file.ack.required && <AckBlock file={file} mgmt={mgmt} onChanged={onChanged} onToast={onToast} />}

      {/* Хто бачить */}
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 12 }}>
        <div style={label}>Хто бачить цей документ</div>
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
        {mgmt && <button style={btn("danger")} onClick={remove} title="Зникне звідусіль; файл і підписи лишаються в системі">Видалити</button>}
        {mgmt && !file.archivedAt && file.inactiveAt && <button style={btn("primary")} onClick={activate}>Активувати</button>}
      </div>

      {signOpen && <SignDialog key={`${file.id}:${file.version}`} file={file} onClose={() => setSignOpen(false)} onDone={async () => { setSignOpen(false); onToast("Підписано. Відбиток привʼязано до поточної версії."); await onChanged(); }} />}
    </div>
  );
}

/** 📖 Блок ознайомлення: людині — кнопка «Ознайомився»; керівництву — хто прочитав, хто ні, «Нагадати в Telegram». */
function AckBlock({ file, mgmt, onChanged, onToast }: { file: DocFile; mgmt: boolean; onChanged: () => Promise<void>; onToast: (s: string) => void }) {
  const [list, setList] = useState<{ people: { userId: number; name: string; ackedAt: string | null; hasTelegram: boolean }[]; done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (mgmt) fetchDocAcks(file.id).then(setList).catch(() => setList(null)); }, [mgmt, file.id, file.version, file.ack.done]);
  const ack = async () => { setBusy(true); try { await ackDocFile(file.id); onToast("Ознайомлення зафіксовано для цієї версії"); await onChanged(); } finally { setBusy(false); } };
  const remind = async () => { setBusy(true); try { const r = await remindDocAcks(file.id); onToast(`Нагадано в Telegram: ${r.sent}${r.noTelegram ? `, без Telegram: ${r.noTelegram}` : ""}`); } catch (e) { onToast(errOf(e, "Не вдалося нагадати")); } finally { setBusy(false); } };
  const missing = list?.people.filter((p) => !p.ackedAt) ?? [];
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 12 }}>
      <div style={{ ...label, display: "flex", justifyContent: "space-between" }}><span>Ознайомлення</span>{list && <span style={{ textTransform: "none", letterSpacing: 0 }}>{list.done} із {list.total}</span>}</div>
      {file.ack.mine === "acked"
        ? <div style={{ fontSize: 13, color: "var(--ok)" }}>✓ Ви ознайомлені з версією v{file.version}.</div>
        : <button style={btn("primary")} onClick={() => void ack()} disabled={busy}>Ознайомився</button>}
      {mgmt && list && (
        <div style={{ marginTop: 10 }}>
          {list.total > 0 && <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${Math.round((list.done / list.total) * 100)}%`, height: "100%", background: list.done === list.total ? "var(--ok)" : "var(--info)" }} /></div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            <button style={{ ...btn(), fontSize: 12, padding: "4px 10px" }} onClick={() => setOpen((v) => !v)}>{open ? "Сховати" : `Не прочитали: ${missing.length}`}</button>
            {missing.length > 0 && <button style={{ ...btn(), fontSize: 12, padding: "4px 10px" }} onClick={() => void remind()} disabled={busy}>🤖 Нагадати в Telegram</button>}
          </div>
          {open && <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>{missing.length ? missing.map((p) => `${p.name}${p.hasTelegram ? "" : " (без Telegram)"}`).join(", ") : "усі прочитали"}</div>}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Нова версія регламенту — ознайомлення заново. Нічого не блокується.</div>
    </div>
  );
}

function Timeline({ steps }: { steps: { label: string; at: string | null; done: boolean; note?: string }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: s.done ? "var(--ok)" : "var(--border-strong)", color: "#fff", display: "grid", placeItems: "center", fontSize: 11, flex: "0 0 auto" }}>{s.done ? "✓" : ""}</span>
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
          style={{ border: `2px dashed ${drag ? "var(--brand)" : "var(--border-strong)"}`, borderRadius: "var(--r-lg)", padding: 18, textAlign: "center", fontSize: "var(--fs-13)", color: "var(--text-muted)" }}>
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
  const [linkCode, setLinkCode] = useState<{ code: string; bot: string } | null>(null);
  const link = async () => {
    setErr(null);
    try { const r = await createTelegramLink(); setLinkCode({ code: r.code, bot: r.botUsername }); window.open(r.url, "_blank", "noopener"); }
    catch (e) { setErr(errOf(e, "Не вдалося створити код")); }
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
          <label key={k} style={{ display: "flex", gap: 10, alignItems: "flex-start", border: `1px solid ${method === k ? "var(--brand)" : "var(--border)"}`, borderRadius: "var(--r-lg)", padding: 10, cursor: on ? "pointer" : "not-allowed", opacity: on ? 1 : .6 }}>
            <input type="radio" checked={method === k} disabled={!on} onChange={() => { setMethod(k); setErr(null); }} />
            <span><div style={{ fontWeight: 700, fontSize: 13 }}>{l}</div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>{d}</div></span>
          </label>
        ))}
      </div>
      {method === "telegram_code" && tg?.configured && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {!tg.linked && <button style={btn("primary")} onClick={() => void link()}>Привʼязати Telegram</button>}
          {!tg.linked && (linkCode
            ? <div style={{ fontSize: 13 }}>Відкрийте бота <b>@{linkCode.bot}</b> і надішліть йому код <b style={{ fontSize: 18, letterSpacing: 3 }}>{linkCode.code}</b> <span className="orph-dim">(діє 10 хв)</span>. Щойно бот відповість «Привʼязано», кнопка «Надіслати код» зʼявиться тут сама.</div>
            : <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Натисніть кнопку: зʼявиться 6-значний код, який треба надіслати боту @{tg.botUsername}.</div>)}
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
  const [linkCode, setLinkCode] = useState<{ code: string; bot: string } | null>(null);
  const load = () => fetchTelegramStatus().then(setTg).catch(() => setTg(null));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { fetchTelegramStatus().then((s) => { setTg(s); if (s.linked) { setWaiting(false); setLinkCode(null); onToast("Telegram привʼязано"); } }).catch(() => { /* ще раз через 3 с */ }); }, 3000);
    const stop = setTimeout(() => setWaiting(false), 10 * 60_000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [waiting, onToast]);
  if (!tg || !tg.configured) return null;
  if (tg.linked) {
    return <button title="Telegram привʼязано. Натисніть, щоб відвʼязати" style={{ ...btn(), fontSize: 12, padding: "5px 10px", color: "var(--ok)" }}
      onClick={() => { if (window.confirm("Відвʼязати Telegram? Коди підпису й нагадування перестануть приходити.")) void unlinkTelegram().then(load); }}>🤖 Telegram ✓</button>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button title="Привʼязати Telegram для підпису й нагадувань" style={{ ...btn(), fontSize: 12, padding: "5px 10px" }}
        onClick={() => { createTelegramLink().then((r) => { setLinkCode({ code: r.code, bot: r.botUsername }); window.open(r.url, "_blank", "noopener"); setWaiting(true); }).catch(() => onToast("Не вдалося створити код")); }}>
        {waiting ? "🤖 чекаю код у боті…" : "🤖 Привʼязати Telegram"}</button>
      {waiting && linkCode && <span style={{ fontSize: 12 }}>надішліть боту <b>@{linkCode.bot}</b> код <b style={{ fontSize: 15, letterSpacing: 2 }}>{linkCode.code}</b></span>}
    </span>
  );
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
          <table className="data-table" style={{ fontSize: "var(--fs-13)" }}>
            <thead><tr>
              <th>Роль</th>
              {cols.map(([k, l]) => <th key={k} style={{ textAlign: "center", fontSize: 11 }}>{l.charAt(0) + l.slice(1).toLowerCase()}</th>)}
            </tr></thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.key}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}{r.management && <span style={{ ...pill("var(--info-bg)", "var(--info)"), marginLeft: 8 }}>керівництво</span>}</div>
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
          <div className="section-heading">Персональні винятки</div>
          {data.grants.map((g, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "8px 10px", marginBottom: 6, fontSize: "var(--fs-13)" }}>
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

function Field({ label: l, children }: { label: string; children: React.ReactNode }) {
  return <div><label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{l}</label>{children}</div>;
}
/** Модалка — той самий вигляд, що вкладення в Задачнику: темна підкладка, картка з chart-title і ✕. */
function Modal({ title, width, onClose, children }: { title: string; width: number; onClose: () => void; children: React.ReactNode }) {
  // Портал у body: картка документа має обмежену висоту з прокруткою, і діалог усередині неї
  // обрізався (заміряно 16.09.2026: «потемнів екран і нічого не можу зробити»).
  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2700, padding: 20 }}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ background: "var(--card-bg)", color: "var(--text)", borderRadius: "var(--r-lg)", padding: "var(--sp-5)", width: "92vw", maxWidth: width, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--sp-4)", gap: 12 }}>
          <h2 className="chart-title" style={{ marginBottom: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: "var(--r-md)", padding: "4px 12px", cursor: "pointer" }}>✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
