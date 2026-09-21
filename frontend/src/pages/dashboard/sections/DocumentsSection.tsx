import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchDocTree, fetchDocCard, fetchDocViewers, fetchDocPeople, createDocFolder, renameDocFolder, deleteDocFolder,
  uploadDocFile, uploadDocVersion, updateDocFile, archiveDocFile, restoreDocFile, activateDocFile, deleteDocFile, fetchDocTrash, undeleteDocFile, ackDocFile, fetchDocAcks, remindDocAcks, signDocFile, fetchSigEvidenceBlobUrl, approveDocSignature, rejectDocSignature,
  moveDocFolder, orderDocFolders, presignDocFile, undoPresignDocFile, fetchDocFolderAccess, saveDocFolderAccess, fetchDocFileAccess, saveDocFileAccess, fetchDocRender, searchDocText, fetchDocFileBlobUrl, DOC_TYPES, fetchTelegramStatus, createTelegramLink, unlinkTelegram,
  type DocTree, type DocFile, type DocFolder, type DocCard, type DocSection, type DocFolderAccess, type DocFileAccess, type DocRender, type DocTextSearch, type DocxRun, type TelegramStatus, type DocTrashFile,
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
function previewKind(f: DocFile): "pdf" | "image" | "html" | "docx" | "xlsx" | "none" {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf" || f.mime === "application/pdf") return "pdf";
  if (f.mime?.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["html", "htm"].includes(ext) || f.mime === "text/html") return "html";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  return "none";
}
const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file);
});
const errOf = (e: unknown, fb: string) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fb;

/* Стиль — той самий, що в Задачнику/Навчанні: chart-card, data-table, kpi-card, orph-chip,
   btn-primary; поля вводу — глобальні (index.css), без власних радіусів і тіней. */
/** 🆕 «нове» — яскраве, щоб не губилось серед статусів підпису. */
const newPill: React.CSSProperties = { display: "inline-block", flexShrink: 0, fontSize: 10.5, fontWeight: 800, letterSpacing: ".03em", padding: "2px 7px", borderRadius: "var(--r-pill)", background: "var(--brand)", color: "#fff", lineHeight: 1.3 };
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
  if (s.kind === "signed") return <span style={pill("var(--ok-bg)", "var(--ok)")} title={s.earlier ? "Підписано на папері раніше — відмітило керівництво" : undefined}>● {s.earlier ? "Підписано раніше" : "Підписано"}</span>;
  if (s.kind === "review") return <span style={pill("var(--info-bg)", "var(--info)")}>● Фото на підтвердженні</span>;
  if (s.kind === "outdated") return <span style={pill("var(--warn-bg)", "var(--warn)")}>● Потребує підпису · нова версія</span>;
  if (s.kind === "overdue") return <span style={pill("var(--danger-bg)", "var(--danger)")}>● Прострочено · {s.days} дн.</span>;
  return <span style={pill("var(--warn-bg)", "var(--warn)")}>● Чекає підпису{s.days != null ? ` · ${s.days} дн.` : ""}</span>;
}

/**
 * 🗂 ФАЙЛОВИЙ МЕНЕДЖЕР (затверджено власником 21.09.2026 за демо «поведінка Syncfusion, вигляд дашборда»).
 * Два екрани, і перемикача між ними немає: хто не має права редагувати — лише перегляд; керівництво —
 * перегляд і редагування на тому самому екрані (панель зверху, права кнопка миші, перетягування,
 * вибір кількох, архів і кошик). Зліва дерево, по центру вміст ПОТОЧНОЇ папки (папки, потім документи),
 * справа деталі — наявна картка документа з підписом, ознайомленням і переглядом.
 */
type Loc = { kind: "reg" | "work"; folder: number | null } | { kind: "offer" | "personal" | "archive" | "trash" };
type ItemKey = string; // "d:12" | "f:3"
type MenuItem = "-" | { icon: string; label: string; run?: () => void; disabled?: boolean; hint?: string; danger?: boolean; kbd?: string };
type ToastT = string | { t: string; undo?: () => void } | null;
const REG_TYPES = new Set(["Регламент", "Інструкція"]);
const kOf = (k: "d" | "f", id: number): ItemKey => `${k}:${id}`;
const parseKey = (k: ItemKey) => ({ k: k.slice(0, 1) as "d" | "f", id: Number(k.slice(2)) });
const cleanName = (n: string) => n.replace(/^\d+\.\s*/, "");

export function DocumentsSection({ isAdmin: _legacyIsAdmin }: { isAdmin: boolean }) {
  const [tree, setTree] = useState<DocTree | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loc, setLocRaw] = useState<Loc>({ kind: "reg", folder: null });
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: "n" | "dt"; dir: 1 | -1 }>({ k: "n", dir: 1 });
  const [view, setView] = useState<"list" | "tiles">("list");
  const [details, setDetails] = useState(true);
  const [sel, setSel] = useState<Set<ItemKey>>(() => new Set());
  const anchor = useRef<ItemKey | null>(null);
  const [exp, setExp] = useState<Set<string>>(() => new Set(["reg", "work"]));
  const [cm, setCm] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [drag, setDrag] = useState<ItemKey[] | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  // Відкритий документ живе в адресі (?doc=25): переживає оновлення сторінки й пересилається посиланням.
  const [selected, setSelectedRaw] = useState<number | null>(() => { const v = Number(new URLSearchParams(window.location.search).get("doc")); return Number.isInteger(v) && v > 0 ? v : null; });
  const setSelected = (id: number | null) => {
    setSelectedRaw(id);
    const u = new URL(window.location.href);
    if (id == null) u.searchParams.delete("doc"); else u.searchParams.set("doc", String(id));
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  };
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1000px)").matches);
  useEffect(() => { const m = window.matchMedia("(max-width: 1000px)"); const on = () => setNarrow(m.matches); m.addEventListener("change", on); return () => m.removeEventListener("change", on); }, []);
  const [navOpen, setNavOpen] = useState(false);
  const [paneW, setPaneW] = useState<{ nav: number; det: number }>(() => {
    try { const v = JSON.parse(localStorage.getItem("docs.paneW2") ?? "null"); if (v && Number.isFinite(v.nav) && Number.isFinite(v.det)) return { nav: clampPane("nav", v.nav), det: clampPane("det", v.det) }; } catch { /* немає сховища — дефолт */ }
    return { ...PANE_DEFAULT };
  });
  useEffect(() => { try { localStorage.setItem("docs.paneW2", JSON.stringify(paneW)); } catch { /* приватне вікно */ } }, [paneW]);
  const [trash, setTrash] = useState<DocTrashFile[] | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [accessFolder, setAccessFolder] = useState<DocFolder | null>(null);
  const [rightsFile, setRightsFile] = useState<DocFile | null>(null);
  const [toast, setToastRaw] = useState<ToastT>(null);
  const setToast = (t: ToastT) => setToastRaw(t);
  const [seenLocal, setSeenLocal] = useState<Set<string>>(() => new Set());
  const [moveDlg, setMoveDlg] = useState<ItemKey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const versionInput = useRef<HTMLInputElement | null>(null);
  const versionFor = useRef<number | null>(null);
  // 🔎 Пошук по тексту: сервер шукає лише серед видимих документів; назву й опис фільтруємо тут.
  const [textSearch, setTextSearch] = useState<{ q: string; res: DocTextSearch | null; err: boolean } | null>(null);
  useEffect(() => {
    const qq = q.trim();
    if (qq.length < 2) { setTextSearch(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      setTextSearch((prev) => ({ q: qq, res: prev?.q === qq ? prev.res : null, err: false }));
      searchDocText(qq).then((res) => { if (alive) setTextSearch({ q: qq, res, err: false }); })
        .catch(() => { if (alive) setTextSearch({ q: qq, res: null, err: true }); });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const load = async () => {
    setLoading(true);
    try { setTree(await fetchDocTree()); setLoadErr(null); }
    catch (e) { setLoadErr(errOf(e, "Сервер відповів помилкою.")); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const loadTrash = () => fetchDocTrash().then(setTrash).catch(() => setTrash(null));
  useEffect(() => { if (tree?.viewer.isManagement) void loadTrash(); }, [tree?.viewer.isManagement]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToastRaw(null), 5000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (!cm) return;
    const close = () => setCm(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setCm(null); };
    window.addEventListener("click", close); window.addEventListener("scroll", close, true); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", key); };
  }, [cm]);

  const viewer = tree?.viewer;
  const folderName = (id: number | null) => id == null ? "Без папки" : (tree?.folders.find((x) => x.id === id)?.name ?? `Папка #${id}`);
  const selectedFile = tree?.files.find((f) => f.id === selected) ?? null;
  useEffect(() => {
    if (!selectedFile?.isNew) return;
    const k = `${selectedFile.id}:${selectedFile.version}`;
    setSeenLocal((s) => s.has(k) ? s : new Set(s).add(k));
  }, [selectedFile?.id, selectedFile?.version, selectedFile?.isNew]);
  // Документ із посилання (?doc=) — відкриваємо там, де він лежить.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !tree || selected == null) return;
    const f = tree.files.find((x) => x.id === selected); if (!f) return;
    jumped.current = true; setLocRaw(locOfFile(f)); setSel(new Set([kOf("d", f.id)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  // ── Три стани ────────────────────────────────────────────────────────────
  if (loading && !tree) return <div className="chart-card"><p className="loading-text">Завантаження документів…</p></div>;
  if (loadErr && !tree) return (
    <StateBlock icon="⚠" title="Не вдалося завантажити список" text={`Сервер відповів помилкою. Файли на місці — це збій відображення. ${loadErr}`}
      action={<button style={btn("primary")} onClick={() => void load()}>Спробувати ще раз</button>} />
  );
  if (!tree || !viewer) return null;

  const mgmt = viewer.isManagement;
  const canUploadHere = viewer.isManagement || viewer.canUploadRoot || viewer.uploadFolders.length > 0;
  const files = tree.files;
  const isNewF = (f: DocFile) => f.isNew && !seenLocal.has(`${f.id}:${f.version}`);
  function locOfFile(f: DocFile): Loc {
    if (f.archivedAt) return { kind: "archive" };
    if (f.section === "offer") return { kind: "offer" };
    if (f.section === "personal") return { kind: "personal" };
    return { kind: REG_TYPES.has(f.category ?? "Інше") ? "reg" : "work", folder: f.folderId };
  }
  const shelfOf = (f: DocFile) => locOfFile(f).kind;
  const kidsOf = (id: number | null) => tree.folders.filter((x) => (x.parentId ?? null) === id).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "uk"));
  const subtree = (id: number): number[] => { const out: number[] = []; const walk = (x: number) => { if (out.includes(x)) return; out.push(x); kidsOf(x).forEach((k) => walk(k.id)); }; walk(id); return out; };
  const pathOf = (id: number | null): DocFolder[] => { const out: DocFolder[] = []; for (let f = tree.folders.find((x) => x.id === id); f && out.length < 64; f = tree.folders.find((x) => x.id === f!.parentId)) out.unshift(f); return out; };
  const deepCount = (fid: number, shelf: "reg" | "work") => { const ids = subtree(fid); return files.filter((f) => shelfOf(f) === shelf && f.folderId != null && ids.includes(f.folderId)).length; };
  const deepNew = (fid: number, shelf: "reg" | "work") => { const ids = subtree(fid); return files.filter((f) => shelfOf(f) === shelf && f.folderId != null && ids.includes(f.folderId) && isNewF(f)).length; };
  // Папку в розділі показуємо, якщо в ній є документи цього розділу; керівництво бачить і порожні — щоб їх наповнити.
  // Порожню папку (без жодного документа) керівництво бачить в обох розділах — щоб її наповнити.
  const folderShown = (fid: number, shelf: "reg" | "work") => { if (deepCount(fid, shelf) > 0) return true; if (!mgmt) return false; const ids = subtree(fid); return !files.some((f) => f.folderId != null && ids.includes(f.folderId)); };
  const setLoc = (l: Loc) => { setLocRaw(l); setSel(new Set()); setQ(""); setTypeFilter(null); setNavOpen(false); if ("folder" in l && l.folder != null) setExp((s) => { const n = new Set(s); pathOf(l.folder).forEach((f) => n.add(`f${f.id}`)); n.add(l.kind); return n; }); };
  const inTrash = loc.kind === "trash";

  // ── Вміст поточного місця ───────────────────────────────────────────────
  const textHits = new Map((textSearch?.q === q.trim() ? textSearch.res?.hits ?? [] : []).map((h) => [h.id, h]));
  const metaMatch = (f: DocFile) => { const qq = q.trim().toLowerCase(); return !qq || f.name.toLowerCase().includes(qq) || (f.description ?? "").toLowerCase().includes(qq) || (f.addressee ?? "").toLowerCase().includes(qq); };
  const searching = q.trim().length > 0;
  const locFiles = files.filter((f) => shelfOf(f) === loc.kind);
  const levelDocs = searching ? locFiles.filter((f) => metaMatch(f) || textHits.has(f.id))
    : locFiles.filter((f) => !("folder" in loc) || (f.folderId ?? null) === loc.folder);
  const typeCounts = new Map<string, number>(); levelDocs.forEach((f) => typeCounts.set(f.category ?? "Інше", (typeCounts.get(f.category ?? "Інше") ?? 0) + 1));
  const docsHere = levelDocs.filter((f) => !typeFilter || (f.category ?? "Інше") === typeFilter)
    .sort((a, b) => sort.k === "n" ? sort.dir * a.name.localeCompare(b.name, "uk") : sort.dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()));
  const foldersHere = !searching && "folder" in loc ? kidsOf(loc.folder).filter((f) => folderShown(f.id, loc.kind as "reg" | "work")) : [];
  const keysHere: ItemKey[] = [...foldersHere.map((f) => kOf("f", f.id)), ...docsHere.map((f) => kOf("d", f.id))];
  const selDocs = [...sel].map(parseKey).filter((x) => x.k === "d").map((x) => files.find((f) => f.id === x.id)).filter(Boolean) as DocFile[];
  const selFolders = [...sel].map(parseKey).filter((x) => x.k === "f").map((x) => tree.folders.find((f) => f.id === x.id)).filter(Boolean) as DocFolder[];

  const todo = {
    offers: files.filter((f) => f.section === "offer" && !f.archivedAt && f.addresseeUserId === viewer.userId && f.signature.kind !== "signed" && f.signature.kind !== "not_required").length,
    regs: files.filter((f) => f.ack.required && f.ack.mine === "pending").length,
    review: files.filter((f) => f.signature.kind === "review").length,
    fresh: files.filter(isNewF).length,
  };
  const openDoc = (f: DocFile) => { setLocRaw(locOfFile(f)); setQ(""); setTypeFilter(null); setSel(new Set([kOf("d", f.id)])); setSelected(f.id); setDetails(true); };

  // ── Дії ──────────────────────────────────────────────────────────────────
  const runBulk = async (ids: number[], one: (id: number) => Promise<void>, done: (ok: number) => string, undo?: () => Promise<void>) => {
    setBusy(true); let ok = 0; const errs: string[] = [];
    for (const id of ids) { try { await one(id); ok++; } catch (e) { errs.push(errOf(e, "помилка")); } }
    setBusy(false); setSel(new Set());
    setToast({ t: done(ok) + (errs.length ? ` Не вдалося: ${errs.length} (${[...new Set(errs)].join("; ")}).` : ""), undo: undo ? () => { void undo().then(load); } : undefined });
    await load();
  };
  const download = async (f: DocFile) => { try { const url = await fetchDocFileBlobUrl(f.id); const a = document.createElement("a"); a.href = url; a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); } catch (e) { setToast(errOf(e, "Не вдалося завантажити")); } };
  const copyLink = (f: DocFile) => { const url = `${window.location.origin}${window.location.pathname}?doc=${f.id}`; void navigator.clipboard?.writeText(url).then(() => setToast("Посилання скопійовано"), () => setToast(url)); };
  const renameFile = (f: DocFile) => { const n = window.prompt("Нова назва:", f.name)?.trim(); if (n && n !== f.name) void updateDocFile(f.id, { name: n }).then(load).catch((e) => setToast(errOf(e, "Не перейменовано"))); };
  const renameFolder = (f: DocFolder) => { const n = window.prompt("Нова назва папки:", f.name)?.trim(); if (n && n !== f.name) void renameDocFolder(f.id, n).then(load).catch((e) => setToast(errOf(e, "Не перейменовано"))); };
  const newFolder = (parent: number | null) => { const n = window.prompt(parent == null ? "Назва нової папки:" : `Назва підпапки в «${folderName(parent)}»:`)?.trim(); if (n) void createDocFolder(n, parent).then(async () => { setToast(`Папку «${n}» створено`); await load(); }).catch((e) => setToast(errOf(e, "Не вдалося створити папку"))); };
  const stepFolder = (f: DocFolder, dir: -1 | 1) => {
    const sibs = kidsOf(f.parentId ?? null); const i = sibs.findIndex((x) => x.id === f.id); const j = i + dir;
    if (i < 0 || j < 0 || j >= sibs.length) return;
    const ids = sibs.map((x) => x.id); [ids[i], ids[j]] = [ids[j], ids[i]];
    void orderDocFolders(f.parentId ?? null, ids).then(load).catch((e) => setToast(errOf(e, "Порядок не змінено")));
  };
  const deleteFolder = (f: DocFolder) => { if (window.confirm(`Видалити папку «${f.name}»? Видаляється лише порожня папка.`)) void deleteDocFolder(f.id).then(async () => { setSel(new Set()); await load(); }).catch((e) => setToast(errOf(e, "Не вдалося"))); };
  const archiveFiles = (fs: DocFile[]) => { if (fs.length && window.confirm(fs.length === 1 ? `Прибрати «${fs[0].name}» в архів? Файл лишається.` : `Прибрати в архів ${fs.length} ${plural(fs.length, "документ", "документи", "документів")}? Файли лишаються.`)) void runBulk(fs.map((f) => f.id), (id) => archiveDocFile(id), (ok) => `В архіві: ${ok}.`); };
  const deleteFiles = (fs: DocFile[]) => { if (fs.length && window.confirm(fs.length === 1 ? `Видалити «${fs[0].name}»? Документ піде в кошик; файл, версії й підписи в системі лишаються.` : `Видалити ${fs.length} ${plural(fs.length, "документ", "документи", "документів")} у кошик?`)) void runBulk(fs.map((f) => f.id), (id) => deleteDocFile(id), (ok) => `У кошику: ${ok}.`).then(loadTrash); };
  const presign = (fs: DocFile[]) => {
    const open = fs.filter((f) => f.section === "offer" && !f.archivedAt && !f.inactiveAt && sigKindOpen(f.signature.kind)); if (!open.length) return;
    const d = window.prompt(`Позначити ${open.length} ${plural(open.length, "офер", "офери", "оферів")} підписаними раніше на папері? Людям нічого не надсилається, нагадування припиняться.\n\nДата підпису РРРР-ММ-ДД або порожньо, якщо невідомо:`, "");
    if (d == null) return;
    void runBulk(open.map((f) => f.id), (id) => presignDocFile(id, d.trim() || null), (ok) => `Позначено «підписано раніше»: ${ok}.`, async () => { for (const f of open) await undoPresignDocFile(f.id).catch(() => {}); });
  };
  const moveKeys = (keys: ItemKey[], to: number | null) => {
    const docs = keys.map(parseKey).filter((x) => x.k === "d").map((x) => files.find((f) => f.id === x.id)).filter((f): f is DocFile => !!f && f.section === "general" && !f.archivedAt);
    const flds = keys.map(parseKey).filter((x) => x.k === "f").map((x) => tree.folders.find((f) => f.id === x.id)).filter((f): f is DocFolder => !!f && (to == null || !subtree(f.id).includes(to)));
    const prevDocs = docs.map((f) => [f.id, f.folderId] as const); const prevFlds = flds.map((f) => [f.id, f.parentId ?? null] as const);
    const n = docs.length + flds.length; if (!n) return;
    void (async () => {
      setBusy(true); const errs: string[] = [];
      for (const f of docs) await updateDocFile(f.id, { folderId: to }).catch((e) => { errs.push(errOf(e, "помилка")); });
      for (const f of flds) await moveDocFolder(f.id, to).catch((e) => { errs.push(errOf(e, "помилка")); });
      setBusy(false); setSel(new Set());
      setToast({ t: `Перенесено ${n} ${plural(n, "елемент", "елементи", "елементів")} у «${to == null ? (loc.kind === "reg" ? "Регламенти" : "Робочі документи") : folderName(to)}».${errs.length ? ` Не вдалося: ${errs.join("; ")}` : ""}`,
        undo: () => { void (async () => { for (const [id, f] of prevDocs) await updateDocFile(id, { folderId: f }).catch(() => {}); for (const [id, p] of prevFlds) await moveDocFolder(id, p).catch(() => {}); await load(); })(); } });
      await load();
    })();
  };
  const pickVersion = (f: DocFile) => { versionFor.current = f.id; versionInput.current?.click(); };
  const onVersionFile = (fl: FileList | null) => {
    const f = fl?.[0]; const id = versionFor.current; if (!f || id == null) return;
    if (f.size > MAX_MB * 1024 * 1024) { setToast(`Файл більше ${MAX_MB} МБ`); return; }
    setBusy(true);
    readAsDataUrl(f).then((dataBase64) => uploadDocVersion(id, { filename: f.name, mime: f.type || null, dataBase64 }))
      .then(async (r) => { setToast(`Нова версія v${r.version}`); await load(); })
      .catch((e) => setToast(errOf(e, "Нову версію не вдалося зберегти"))).finally(() => setBusy(false));
  };

  // ── Меню правої кнопки ───────────────────────────────────────────────────
  const menuFor = (target: ItemKey | "bg", keys: Set<ItemKey>, shelfHint?: "reg" | "work"): { title: string; items: MenuItem[] } => {
    const sh: "reg" | "work" = shelfHint ?? (loc.kind === "work" ? "work" : "reg");
    const tree2 = loc.kind === "reg" || loc.kind === "work";
    if (target === "bg") return { title: "folder" in loc && loc.folder != null ? cleanName(folderName(loc.folder)) : SHELF_TITLE[loc.kind], items: [
      ...(mgmt && tree2 ? [{ icon: "📁", label: "Нова папка", run: () => newFolder("folder" in loc ? loc.folder : null) }] : []),
      ...(canUploadHere && !inTrash && loc.kind !== "archive" ? [{ icon: "⤒", label: "Завантажити сюди", run: () => setUploadOpen(true) }] : []),
      "-", { icon: "☰", label: "Таблиця", run: () => setView("list") }, { icon: "⊞", label: "Плитки", run: () => setView("tiles") },
      { icon: "ⓘ", label: details ? "Сховати деталі" : "Показати деталі", run: () => setDetails(!details) },
      "-", { icon: "⇅", label: "Сортувати за назвою", run: () => setSort({ k: "n", dir: 1 }) }, { icon: "⇅", label: "Сортувати за датою", run: () => setSort({ k: "dt", dir: -1 }) },
      ...(mgmt ? ["-" as const, { icon: "☑", label: "Вибрати все", kbd: "Ctrl A", run: () => setSel(new Set(keysHere)) }] : []),
    ] };
    const many = keys.size > 1;
    if (many) {
      const docs = [...keys].map(parseKey).filter((x) => x.k === "d").map((x) => files.find((f) => f.id === x.id)).filter(Boolean) as DocFile[];
      const movable = [...keys].filter((k) => k.startsWith("f:") || docs.some((d) => kOf("d", d.id) === k && d.section === "general" && !d.archivedAt));
      const pend = docs.filter((f) => f.section === "offer" && !f.archivedAt && !f.inactiveAt && sigKindOpen(f.signature.kind));
      return { title: `${keys.size} вибрано`, items: [
        { icon: "⤓", label: `Завантажити ${docs.length}`, disabled: !docs.length, run: () => { void (async () => { for (const f of docs) await download(f); })(); } },
        ...(mgmt ? [
          ...(tree2 ? [{ icon: "📂", label: `Перенести ${movable.length} в…`, disabled: !movable.length, run: () => setMoveDlg(movable) }] : []),
          ...(pend.length ? [{ icon: "✍", label: `Позначити «підписано раніше» (${pend.length})`, run: () => presign(pend) }] : []),
          "-" as const,
          { icon: "🗄", label: `В архів (${docs.filter((f) => !f.archivedAt).length})`, disabled: !docs.some((f) => !f.archivedAt), run: () => archiveFiles(docs.filter((f) => !f.archivedAt)) },
          { icon: "✕", label: `Видалити (${docs.length})…`, danger: true, disabled: !docs.length, run: () => deleteFiles(docs) },
        ] : []),
      ] };
    }
    const { k, id } = parseKey(target);
    if (k === "f") {
      const f = tree.folders.find((x) => x.id === id)!; const sibs = kidsOf(f.parentId ?? null); const i = sibs.findIndex((x) => x.id === f.id);
      const inside = kidsOf(f.id).length + files.filter((x) => x.folderId === f.id).length;
      if (!mgmt) return { title: cleanName(f.name), items: [{ icon: "↗", label: "Відкрити", run: () => setLoc({ kind: sh, folder: f.id }) }] };
      return { title: cleanName(f.name), items: [
        { icon: "↗", label: "Відкрити", kbd: "Enter", run: () => setLoc({ kind: sh, folder: f.id }) }, "-",
        { icon: "📁", label: "Нова підпапка", run: () => newFolder(f.id) },
        { icon: "✎", label: "Перейменувати", kbd: "F2", run: () => renameFolder(f) },
        { icon: "📂", label: "Перенести в…", run: () => setMoveDlg([kOf("f", f.id)]) },
        { icon: "↑", label: "Вище", disabled: i <= 0, run: () => stepFolder(f, -1) },
        { icon: "↓", label: "Нижче", disabled: i < 0 || i >= sibs.length - 1, run: () => stepFolder(f, 1) },
        "-", { icon: "⚙", label: "Доступи до папки…", run: () => setAccessFolder(f) },
        "-", inside ? { icon: "✕", label: "Видалити папку", disabled: true, hint: `Спершу перенесіть: ${inside} ${plural(inside, "елемент", "елементи", "елементів")} всередині` } : { icon: "✕", label: "Видалити папку", danger: true, run: () => deleteFolder(f) },
      ] };
    }
    const f = files.find((x) => x.id === id);
    if (!f) return { title: "", items: [] };
    const off = f.section === "offer";
    if (f.archivedAt) return { title: f.name, items: [
      { icon: "↗", label: "Відкрити", run: () => openDoc(f) }, { icon: "⤓", label: "Завантажити", run: () => void download(f) },
      ...(mgmt ? ["-" as const, { icon: "↩", label: "Повернути з архіву", run: () => void restoreDocFile(f.id).then(async () => { setToast("Повернуто з архіву"); await load(); }).catch((e) => setToast(errOf(e, "Не вдалося"))) },
        { icon: "✕", label: "Видалити…", danger: true, run: () => deleteFiles([f]) }] : []),
    ] };
    return { title: f.name, items: [
      { icon: "↗", label: "Відкрити", kbd: "Enter", run: () => openDoc(f) },
      { icon: "⤓", label: "Завантажити", run: () => void download(f) },
      { icon: "🔗", label: "Копіювати посилання", run: () => copyLink(f) },
      ...(f.ack.required && f.ack.mine === "pending" ? [{ icon: "📖", label: "Ознайомився", run: () => void ackDocFile(f.id).then(async () => { setToast("Ознайомлення зафіксовано для цієї версії"); await load(); }).catch((e) => setToast(errOf(e, "Не вдалося"))) }] : []),
      ...(f.canSign ? [{ icon: "🔏", label: "Підписати…", run: () => openDoc(f) }] : []),
      ...(f.canEdit || mgmt ? ["-" as const] : []),
      ...(mgmt && off && sigKindOpen(f.signature.kind) && !f.inactiveAt ? [{ icon: "✍", label: "Позначити «підписано раніше»…", run: () => presign([f]) }] : []),
      ...(mgmt && f.signature.earlier ? [{ icon: "↺", label: "Зняти «підписано раніше»", run: () => { if (window.confirm("Зняти позначку? Офер знову чекатиме підпису.")) void undoPresignDocFile(f.id).then(load).catch((e) => setToast(errOf(e, "Не вдалося"))); } }] : []),
      ...(f.canEdit ? [{ icon: "✎", label: "Перейменувати", kbd: "F2", run: () => renameFile(f) }, { icon: "⬆", label: "Нова версія…", run: () => pickVersion(f) }] : []),
      ...(mgmt && f.section === "general" ? [{ icon: "📂", label: "Перенести в…", run: () => setMoveDlg([kOf("d", f.id)]) }, { icon: "🔐", label: "Права документа…", run: () => setRightsFile(f) }] : []),
      ...(mgmt && f.inactiveAt ? [{ icon: "✓", label: "Активувати", run: () => void activateDocFile(f.id).then(load).catch((e) => setToast(errOf(e, "Не вдалося"))) }] : []),
      ...(mgmt ? ["-" as const, { icon: "🗄", label: "В архів", run: () => archiveFiles([f]) }, { icon: "✕", label: "Видалити…", danger: true, run: () => deleteFiles([f]) }] : []),
    ] };
  };
  const openMenu = (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, target: ItemKey | "bg", shelfHint?: "reg" | "work") => {
    e.preventDefault(); e.stopPropagation();
    let keys = sel;
    if (target !== "bg" && !sel.has(target)) { keys = new Set([target]); setSel(keys); anchor.current = target; const p = parseKey(target); if (p.k === "d") setSelected(p.id); }
    if (target === "bg") { keys = new Set(); setSel(keys); }
    const m = menuFor(target, keys, shelfHint);
    if (!m.items.length) return;
    setCm({ x: Math.min(e.clientX, window.innerWidth - 280), y: Math.min(e.clientY, window.innerHeight - 40 - m.items.length * 32), ...m });
  };

  // ── Вибір ───────────────────────────────────────────────────────────────
  const clickItem = (e: React.MouseEvent, key: ItemKey) => {
    if (mgmt && e.shiftKey && anchor.current && keysHere.includes(anchor.current)) {
      const a = keysHere.indexOf(anchor.current), b = keysHere.indexOf(key); setSel(new Set(keysHere.slice(Math.min(a, b), Math.max(a, b) + 1))); return;
    }
    if (mgmt && (e.metaKey || e.ctrlKey)) { toggleKey(key); return; }
    setSel(new Set([key])); anchor.current = key;
    const p = parseKey(key); if (p.k === "d") setSelected(p.id);
  };
  const toggleKey = (key: ItemKey) => setSel((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); anchor.current = key; return n; });
  const openKey = (key: ItemKey) => { const p = parseKey(key); if (p.k === "f") setLoc({ kind: loc.kind as "reg" | "work", folder: p.id }); else { const f = files.find((x) => x.id === p.id); if (f) openDoc(f); } };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const one = sel.size === 1 ? [...sel][0] : null;
    if (e.key === "Escape") { setSel(new Set()); return; }
    if (mgmt && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(new Set(keysHere)); return; }
    if (e.key === "Enter" && one) { openKey(one); return; }
    if (e.key === "F2" && one && mgmt) { e.preventDefault(); const p = parseKey(one); if (p.k === "f") { const f = tree.folders.find((x) => x.id === p.id); if (f) renameFolder(f); } else { const f = files.find((x) => x.id === p.id); if (f?.canEdit) renameFile(f); } }
  };

  // ── Перетягування (лише керівництво, лише загальні документи й папки) ────
  const canDrag = (key: ItemKey) => { if (!mgmt) return false; const p = parseKey(key); if (p.k === "f") return true; const f = files.find((x) => x.id === p.id); return !!f && f.section === "general" && !f.archivedAt; };
  const dragStart = (e: React.DragEvent, key: ItemKey) => {
    const keys = sel.has(key) ? [...sel].filter(canDrag) : [key];
    if (!sel.has(key)) { setSel(new Set([key])); anchor.current = key; }
    setDrag(keys); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", key); } catch { /* Safari */ }
  };
  const dropOk = (to: number | null) => !!drag && drag.every((k) => { const p = parseKey(k); return p.k === "d" || (to == null || !subtree(p.id).includes(to)); }) && !drag.includes(kOf("f", to ?? -1));
  const dropProps = (to: number | null, id: string) => mgmt ? {
    onDragOver: (e: React.DragEvent) => { if (!drag || !dropOk(to)) return; e.preventDefault(); if (dropOn !== id) setDropOn(id); },
    onDragLeave: () => { if (dropOn === id) setDropOn(null); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); const ks = drag; setDrag(null); setDropOn(null); if (ks && dropOk(to)) moveKeys(ks, to); },
  } : {};

  // ── Розмітка ─────────────────────────────────────────────────────────────
  const navItem = (key: string, label: React.ReactNode, on: boolean, onClick: () => void, extra?: { count?: number; fresh?: number; depth?: number; chev?: React.ReactNode; menu?: (e: React.MouseEvent) => void; drop?: [number | null, string]; dragKey?: ItemKey }) => (
    <button key={key} type="button" onClick={onClick} onContextMenu={extra?.menu} className="docs-ni"
      draggable={!!extra?.dragKey && mgmt} onDragStart={extra?.dragKey ? (e) => dragStart(e, extra.dragKey!) : undefined} onDragEnd={() => { setDrag(null); setDropOn(null); }}
      {...(extra?.drop ? dropProps(extra.drop[0], extra.drop[1]) : {})}
      style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", border: "none", textAlign: "left", padding: `6px 8px 6px ${8 + (extra?.depth ?? 0) * 16}px`, borderRadius: "var(--r-md)", cursor: "pointer", fontSize: "var(--fs-13)", minHeight: 30, position: "relative",
        background: extra?.drop && dropOn === extra.drop[1] ? "var(--info-bg)" : on ? "var(--brand-soft, var(--surface-2))" : "transparent", boxShadow: extra?.drop && dropOn === extra.drop[1] ? "inset 0 0 0 1.5px var(--info)" : on ? "inset 3px 0 0 var(--brand)" : undefined,
        color: "var(--text)", fontWeight: on ? 600 : 400 }}>
      <span style={{ width: 14, flex: "0 0 auto", fontSize: 9, color: "var(--text-muted)", textAlign: "center" }}>{extra?.chev}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {!!extra?.fresh && <span style={{ ...newPill, fontSize: 10, padding: "0 6px" }} title={`${extra.fresh} ${plural(extra.fresh, "новий документ", "нові документи", "нових документів")}`}>{extra.fresh}</span>}
      {extra?.count != null && <span style={{ fontSize: 11.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{extra.count || ""}</span>}
    </button>
  );
  const chev = (key: string, has: boolean) => has ? <span role="button" aria-label={exp.has(key) ? "Згорнути" : "Розгорнути"} onClick={(e) => { e.stopPropagation(); setExp((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }); }}>{exp.has(key) ? "▾" : "▸"}</span> : null;
  const folderNodes = (shelf: "reg" | "work", parent: number | null, depth: number): React.ReactNode[] => kidsOf(parent).filter((f) => folderShown(f.id, shelf)).flatMap((f) => {
    const kids = kidsOf(f.id).filter((x) => folderShown(x.id, shelf)); const key = `f${f.id}`;
    const on = loc.kind === shelf && "folder" in loc && loc.folder === f.id && !searching;
    return [navItem(`${shelf}-f${f.id}`, <>📁 {cleanName(f.name)}</>, on, () => setLoc({ kind: shelf, folder: f.id }), { count: deepCount(f.id, shelf), fresh: deepNew(f.id, shelf), depth, chev: chev(key, kids.length > 0), menu: (e) => openMenu(e, kOf("f", f.id), shelf), drop: [f.id, `${shelf}-${f.id}`], dragKey: kOf("f", f.id) }),
      ...(exp.has(key) ? folderNodes(shelf, f.id, depth + 1) : [])];
  });
  const shelfCount = (k: Loc["kind"]) => files.filter((f) => shelfOf(f) === k).length;
  const shelfNew = (k: Loc["kind"]) => files.filter((f) => shelfOf(f) === k && isNewF(f)).length;
  const nav = (
    <nav aria-label="Розділи й папки" style={{ padding: "10px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
      <div style={{ ...label, margin: "4px 8px 4px" }}>Бібліотека</div>
      {navItem("reg", <>📕 Регламенти</>, loc.kind === "reg" && "folder" in loc && loc.folder == null && !searching, () => setLoc({ kind: "reg", folder: null }), { count: shelfCount("reg"), fresh: shelfNew("reg"), chev: chev("reg", true), drop: [null, "reg-root"] })}
      {exp.has("reg") && folderNodes("reg", null, 1)}
      {navItem("work", <>🗂 Робочі документи</>, loc.kind === "work" && "folder" in loc && loc.folder == null && !searching, () => setLoc({ kind: "work", folder: null }), { count: shelfCount("work"), fresh: shelfNew("work"), chev: chev("work", true), drop: [null, "work-root"] })}
      {exp.has("work") && folderNodes("work", null, 1)}
      <div style={{ ...label, margin: "12px 8px 4px" }}>{mgmt ? "Особисті та офери" : "Мої документи"}</div>
      {tree.sections.offer && navItem("offer", <>🔒 {mgmt ? "Офери" : "Мій офер"}</>, loc.kind === "offer", () => setLoc({ kind: "offer" }), { count: shelfCount("offer"), fresh: shelfNew("offer") })}
      {navItem("personal", <>👤 Особисті</>, loc.kind === "personal", () => setLoc({ kind: "personal" }), { count: shelfCount("personal"), fresh: shelfNew("personal") })}
      {mgmt && <><div style={{ ...label, margin: "12px 8px 4px" }}>Службове</div>
        {tree.sections.archive && navItem("archive", <>🗄 Архів</>, loc.kind === "archive", () => setLoc({ kind: "archive" }), { count: shelfCount("archive") })}
        {navItem("trash", <>🗑 Кошик</>, inTrash, () => { setLoc({ kind: "trash" }); void loadTrash(); }, { count: trash?.length ?? 0 })}</>}
    </nav>
  );
  const crumbs = searching ? [{ t: `Пошук «${q.trim()}» у «${SHELF_TITLE[loc.kind]}»`, go: undefined as undefined | (() => void) }]
    : [{ t: SHELF_TITLE[loc.kind], go: "folder" in loc ? () => setLoc({ kind: loc.kind as "reg" | "work", folder: null }) : undefined },
       ...("folder" in loc ? pathOf(loc.folder).map((f) => ({ t: cleanName(f.name), go: () => setLoc({ kind: loc.kind as "reg" | "work", folder: f.id }) })) : [])];
  const tbBtn: React.CSSProperties = { border: "none", background: "transparent", borderRadius: "var(--r-md)", padding: "6px 10px", fontWeight: 600, fontSize: "var(--fs-13)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text)" };
  const tbOn = (on: boolean): React.CSSProperties => ({ ...tbBtn, background: on ? "var(--surface-2)" : "transparent", boxShadow: on ? "inset 0 0 0 1px var(--border)" : undefined });
  const pendSel = selDocs.filter((f) => f.section === "offer" && !f.archivedAt && !f.inactiveAt && sigKindOpen(f.signature.kind));
  const movableSel = [...sel].filter((k) => k.startsWith("f:") || selDocs.some((d) => kOf("d", d.id) === k && d.section === "general" && !d.archivedAt));
  const multi = sel.size > 1;
  const toolbar = multi ? (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--border)", background: "var(--brand-soft, var(--surface-2))", minHeight: 50 }}>
      <button style={tbBtn} aria-label="Скасувати вибір" onClick={() => setSel(new Set())}>✕</button>
      <b style={{ marginRight: 6 }}>{sel.size} вибрано</b>
      <button style={tbBtn} disabled={!selDocs.length || busy} onClick={() => void (async () => { for (const f of selDocs) await download(f); })()}>⤓ Завантажити</button>
      {mgmt && (loc.kind === "reg" || loc.kind === "work" || searching) && <button style={tbBtn} disabled={!movableSel.length || busy} onClick={() => setMoveDlg(movableSel)}>📂 Перенести…</button>}
      {mgmt && pendSel.length > 0 && <button style={tbBtn} disabled={busy} onClick={() => presign(pendSel)}>✍ Підписано раніше ({pendSel.length})</button>}
      {mgmt && selDocs.some((f) => !f.archivedAt) && <button style={tbBtn} disabled={busy} onClick={() => archiveFiles(selDocs.filter((f) => !f.archivedAt))}>🗄 В архів</button>}
      <span style={{ flex: 1 }} />
      <button style={tbBtn} onClick={() => setSel(new Set(keysHere))}>Вибрати все</button>
    </div>
  ) : (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--border)", minHeight: 50 }}>
      {narrow && <button style={tbBtn} onClick={() => setNavOpen(!navOpen)}>☰ Розділи</button>}
      {mgmt && (loc.kind === "reg" || loc.kind === "work") && <button style={tbBtn} onClick={() => newFolder("folder" in loc ? loc.folder : null)}>📁 Нова папка</button>}
      {canUploadHere && !inTrash && loc.kind !== "archive" && <button style={tbBtn} onClick={() => setUploadOpen(true)}>⤒ Завантажити</button>}
      {!inTrash && <><span style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
        <button style={tbBtn} onClick={() => setSort(sort.k === "n" ? { k: "dt", dir: -1 } : { k: "n", dir: 1 })}>⇅ {sort.k === "n" ? "За назвою" : "За датою"}</button>
        {(typeCounts.size > 1 || typeFilter) && <select value={typeFilter ?? ""} onChange={(e) => setTypeFilter(e.target.value || null)} aria-label="Тип документа" style={{ fontSize: 13, padding: "4px 8px" }}>
          <option value="">Усі типи</option>{[...DOC_TYPES].filter((t) => typeCounts.has(t) || typeFilter === t).map((t) => <option key={t} value={t}>{t} · {typeCounts.get(t) ?? 0}</option>)}</select>}</>}
      <span style={{ flex: 1 }} />
      {!inTrash && <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setSel(new Set()); }} placeholder="🔍 Пошук за назвою і текстом" aria-label="Пошук" style={{ flex: "0 1 240px", minWidth: 130 }} />}
      <span style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
      <button style={tbOn(view === "list")} title="Таблиця" aria-label="Таблиця" onClick={() => setView("list")}>☰</button>
      <button style={tbOn(view === "tiles")} title="Плитки" aria-label="Плитки" onClick={() => setView("tiles")}>⊞</button>
      {!narrow && <button style={tbOn(details)} title="Панель деталей" onClick={() => setDetails(!details)}>ⓘ Деталі</button>}
    </div>
  );
  const statusOf = (f: DocFile) => f.archivedAt ? <span style={pill("var(--surface-2)", "var(--text-muted)")}>{f.archivedReason === "dismissed" ? "звільнено" : "в архіві"}</span>
    : f.inactiveAt ? <span style={pill("var(--warn-bg)", "var(--warn)")}>неактивний</span> : f.ack.required ? <AckBadge f={f} /> : <SigBadge f={f} />;
  const fileIcon = (f: DocFile, big = false) => { const t = TYPE_META[f.category ?? "Інше"] ?? TYPE_META["Інше"]; return <span style={{ width: big ? 44 : 28, height: big ? 52 : 32, borderRadius: 5, border: `1px solid ${t.color}66`, background: t.color + "12", color: t.color, display: "inline-grid", placeItems: "center", fontSize: big ? 10 : 8, fontWeight: 800, flex: "0 0 auto" }}>{extOf(f.name, f.mime)}</span>; };
  const rowBg = (key: ItemKey, drop?: string) => drop && dropOn === drop ? "var(--info-bg)" : sel.has(key) ? "var(--brand-soft, var(--surface-2))" : undefined;
  const hoverActs = (f: DocFile) => (
    <span className="docs-hov" style={{ display: "inline-flex", gap: 2 }}>
      <button className="docs-ib" title="Завантажити" aria-label="Завантажити" onClick={(e) => { e.stopPropagation(); void download(f); }}>⤓</button>
      <button className="docs-ib" title="Копіювати посилання" aria-label="Копіювати посилання" onClick={(e) => { e.stopPropagation(); copyLink(f); }}>🔗</button>
      <button className="docs-ib" title="Ще дії" aria-label="Ще дії" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu({ clientX: r.right - 250, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() }, kOf("d", f.id)); }}>⋯</button>
    </span>
  );
  const nameCell = (f: DocFile) => (
    <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
      {fileIcon(f)}
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontWeight: isNewF(f) ? 700 : 500, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3, wordBreak: "break-word" }} title={f.name}>{f.name.replace(/\.[a-z0-9]+$/i, "")}</span>
          {isNewF(f) && <span style={newPill} title="Ви ще не відкривали цю версію">нове</span>}
          {f.ownRights && <span style={pill("var(--info-bg)", "var(--info)")} title="Права цього документа відрізняються від прав папки">власні права</span>}
        </span>
        {textHits.has(f.id) && !metaMatch(f) && <span className="orph-dim" style={{ display: "block", fontSize: 12, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>🔎 <Highlight text={textHits.get(f.id)!.snippet} q={q} /></span>}
        {searching && f.folderId != null && !textHits.has(f.id) && <span className="orph-dim" style={{ display: "block", fontSize: 11.5 }}>📁 {pathOf(f.folderId).map((x) => cleanName(x.name)).join(" › ")}</span>}
      </span>
    </span>
  );
  const th: React.CSSProperties = { position: "sticky", top: 0, zIndex: 1, background: "var(--card-bg)", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--text-muted)", padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "7px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "middle", overflow: "hidden" };
  // Вузький екран: лишаємо назву й статус; дата й автор — у деталях документа.
  const showBy = !narrow && (!details || loc.kind === "offer" || loc.kind === "personal");
  const showDate = !narrow;
  const sortTh = (k: "n" | "dt", l: string) => <th style={{ ...th, cursor: "pointer" }} onClick={() => setSort({ k, dir: sort.k === k ? (sort.dir === 1 ? -1 : 1) : (k === "dt" ? -1 : 1) })}>{l}{sort.k === k && <span style={{ fontSize: 10, marginLeft: 3 }}>{sort.dir > 0 ? "▲" : "▼"}</span>}</th>;
  const allSel = keysHere.length > 0 && keysHere.every((k) => sel.has(k));
  const emptyState = inTrash ? null : shelfCount(loc.kind) === 0
    ? <StateBlock icon="🗀" title={loc.kind === "archive" ? "В архіві ще нічого немає" : "Тут ще нічого немає"} text={loc.kind === "archive" ? "Сюди потрапляють документи звільнених і те, що керівництво прибрало в архів." : canUploadHere ? "Натисніть «Завантажити»." : "Документи сюди викладає керівництво."} inline />
    : searching ? <div style={{ margin: 16 }}><p className="loading-text" style={{ margin: "0 0 8px" }}>Нічого не знайдено за фільтром.</p><button style={{ ...btn(), fontSize: 12, padding: "4px 10px" }} onClick={() => { setQ(""); setTypeFilter(null); }}>Скинути фільтри</button></div>
    : <StateBlock icon="📂" title="Папка порожня" text={mgmt ? "Перетягніть сюди документи або натисніть «Завантажити»." : "Документи сюди викладає керівництво."} inline />;

  const trashView = (
    <div>
      <div style={{ padding: "10px 14px 0" }}><div style={{ ...noteBox, background: "var(--danger-bg)", color: "var(--danger)" }}>🗑 Кошик бачить лише керівництво. «Відновити» повертає документ туди, де він був: у той самий розділ, папку й стан підпису.</div></div>
      {trash == null ? <p className="loading-text" style={{ margin: 14 }}>Завантаження…</p> : trash.length === 0 ? <StateBlock icon="🗑" title="Кошик порожній" text="Тут зʼявляться документи, які керівництво видалило." inline /> : (
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", fontSize: "var(--fs-13)" }}>
          <colgroup><col /><col style={{ width: 170 }} /><col style={{ width: 150 }} /><col style={{ width: 130 }} /></colgroup>
          <thead><tr><th style={th}>Назва</th><th style={th}>Де був</th><th style={th}>Видалив</th><th style={th} /></tr></thead>
          <tbody>{trash.map((f) => { const t = TYPE_META[f.category ?? "Інше"] ?? TYPE_META["Інше"]; return (
            <tr key={f.id} onContextMenu={(e) => { e.preventDefault(); setCm({ x: Math.min(e.clientX, window.innerWidth - 280), y: e.clientY, title: f.name, items: [{ icon: "↩", label: "Відновити", run: () => void undeleteDocFile(f.id).then(async () => { setToast(`«${f.name}» відновлено`); await Promise.all([load(), loadTrash()]); }).catch((er) => setToast(errOf(er, "Не вдалося повернути"))) }] }); }}>
              <td style={td}><span style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={{ width: 28, height: 32, borderRadius: 5, border: `1px solid ${t.color}66`, color: t.color, display: "inline-grid", placeItems: "center", fontSize: 8, fontWeight: 800, opacity: .7 }}>{extOf(f.name, f.mime)}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name}</span></span></td>
              <td style={{ ...td, color: "var(--text-muted)" }}>{f.section === "offer" ? "🔒 Офери" : f.section === "personal" ? "Особисті" : cleanName(folderName(f.folderId))}</td>
              <td style={{ ...td, color: "var(--text-muted)" }}>{f.deletedBy ?? "невідомо"} · {fmtDate(f.deletedAt)}</td>
              <td style={td}><button style={{ ...btn(), fontSize: 12, padding: "4px 10px" }} onClick={() => void undeleteDocFile(f.id).then(async () => { setToast(`«${f.name}» відновлено`); await Promise.all([load(), loadTrash()]); }).catch((er) => setToast(errOf(er, "Не вдалося повернути")))}>↩ Відновити</button></td>
            </tr>); })}</tbody>
        </table>)}
    </div>
  );
  const center = inTrash ? trashView : (!foldersHere.length && !docsHere.length) ? emptyState : view === "tiles" ? (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, padding: 14 }} onContextMenu={(e) => { if (e.target === e.currentTarget) openMenu(e, "bg"); }}>
      {foldersHere.map((f) => { const key = kOf("f", f.id); return (
        <div key={key} role="button" tabIndex={0} onClick={(e) => clickItem(e, key)} onDoubleClick={() => openKey(key)} onContextMenu={(e) => openMenu(e, key)}
          draggable={mgmt} onDragStart={(e) => dragStart(e, key)} onDragEnd={() => { setDrag(null); setDropOn(null); }} {...dropProps(f.id, `t-${f.id}`)}
          style={{ border: `1px solid ${sel.has(key) ? "var(--brand)" : "var(--border)"}`, borderRadius: "var(--r-lg)", padding: 12, display: "flex", flexDirection: "column", gap: 6, background: rowBg(key, `t-${f.id}`) ?? "var(--card-bg)", userSelect: "none", cursor: "default" }}>
          <div style={{ height: 80, borderRadius: "var(--r-md)", background: "var(--surface-2)", display: "grid", placeItems: "center", fontSize: 42 }}>📁</div>
          <b style={{ fontSize: 13, lineHeight: 1.3 }}>{cleanName(f.name)}</b><span className="orph-dim">{deepCount(f.id, loc.kind as "reg" | "work")} {plural(deepCount(f.id, loc.kind as "reg" | "work"), "документ", "документи", "документів")}</span>
        </div>); })}
      {docsHere.map((f) => { const key = kOf("d", f.id); return (
        <div key={key} role="button" tabIndex={0} onClick={(e) => clickItem(e, key)} onDoubleClick={() => openDoc(f)} onContextMenu={(e) => openMenu(e, key)}
          draggable={canDrag(key)} onDragStart={(e) => dragStart(e, key)} onDragEnd={() => { setDrag(null); setDropOn(null); }}
          style={{ border: `1px solid ${sel.has(key) ? "var(--brand)" : "var(--border)"}`, borderRadius: "var(--r-lg)", padding: 12, display: "flex", flexDirection: "column", gap: 6, background: rowBg(key) ?? "var(--card-bg)", userSelect: "none", cursor: "default" }}>
          <div style={{ height: 80, borderRadius: "var(--r-md)", background: "var(--surface-2)", display: "grid", placeItems: "center" }}>{fileIcon(f, true)}</div>
          <b style={{ fontSize: 13, lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }} title={f.name}>{f.name.replace(/\.[a-z0-9]+$/i, "")}</b>
          <span className="orph-dim">{fmtDate(f.updatedAt)} · {fmtBytes(f.sizeBytes)}</span>
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{statusOf(f)}{isNewF(f) && <span style={newPill}>нове</span>}</span>
        </div>); })}
    </div>
  ) : (
    <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", fontSize: "var(--fs-13)" }}>
      <colgroup>{mgmt && <col style={{ width: 36 }} />}<col /><col style={{ width: narrow ? 118 : loc.kind === "offer" ? 170 : 140 }} />{showDate && <col style={{ width: 88 }} />}{showBy && <col style={{ width: 160 }} />}<col style={{ width: narrow ? 36 : 76 }} /></colgroup>
      <thead><tr>
        {mgmt && <th style={th}><input type="checkbox" aria-label="Вибрати все" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(keysHere))} /></th>}
        {sortTh("n", "Назва")}<th style={th}>{loc.kind === "offer" ? "Підпис" : "Статус"}</th>{showDate && sortTh("dt", "Змінено")}{showBy && <th style={th}>{loc.kind === "offer" || loc.kind === "personal" ? "Адресат" : "Автор"}</th>}<th style={th} />
      </tr></thead>
      <tbody>
        {foldersHere.map((f) => { const key = kOf("f", f.id); const n = deepCount(f.id, loc.kind as "reg" | "work"); return (
          <tr key={key} className="docs-row" onClick={(e) => clickItem(e, key)} onDoubleClick={() => openKey(key)} onContextMenu={(e) => openMenu(e, key)}
            draggable={mgmt} onDragStart={(e) => dragStart(e, key)} onDragEnd={() => { setDrag(null); setDropOn(null); }} {...dropProps(f.id, `r-${f.id}`)}
            style={{ background: rowBg(key, `r-${f.id}`), boxShadow: sel.has(key) ? "inset 3px 0 0 var(--brand)" : undefined, userSelect: "none", cursor: "default" }}>
            {mgmt && <td style={td}><input type="checkbox" className="docs-cb" aria-label={`Вибрати «${f.name}»`} checked={sel.has(key)} onClick={(e) => e.stopPropagation()} onChange={() => toggleKey(key)} /></td>}
            <td style={td}><span style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={{ fontSize: 22, lineHeight: 1 }}>📁</span><span style={{ fontWeight: 500 }}>{cleanName(f.name)}</span></span></td>
            <td style={{ ...td, color: "var(--text-muted)" }}>Папка · {n} {plural(n, "документ", "документи", "документів")}</td>{showDate && <td style={td} />}{showBy && <td style={td} />}
            <td style={{ ...td, textAlign: "right" }}>{mgmt && <span className="docs-hov"><button className="docs-ib" title="Ще дії" aria-label="Ще дії" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu({ clientX: r.right - 250, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() }, key); }}>⋯</button></span>}</td>
          </tr>); })}
        {docsHere.map((f) => { const key = kOf("d", f.id); return (
          <tr key={key} className="docs-row" onClick={(e) => clickItem(e, key)} onDoubleClick={() => openDoc(f)} onContextMenu={(e) => openMenu(e, key)}
            draggable={canDrag(key)} onDragStart={(e) => dragStart(e, key)} onDragEnd={() => { setDrag(null); setDropOn(null); }}
            style={{ background: rowBg(key), boxShadow: sel.has(key) ? "inset 3px 0 0 var(--brand)" : undefined, userSelect: "none", cursor: "default" }}>
            {mgmt && <td style={td}><input type="checkbox" className="docs-cb" aria-label={`Вибрати «${f.name}»`} checked={sel.has(key)} onClick={(e) => e.stopPropagation()} onChange={() => toggleKey(key)} /></td>}
            <td style={td}>{nameCell(f)}</td>
            <td style={td}>{statusOf(f)}</td>
            {showDate && <td style={{ ...td, color: "var(--text-muted)" }}>{fmtDate(f.updatedAt)}</td>}
            {showBy && <td style={{ ...td, color: "var(--text-muted)", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{f.addressee ?? f.author ?? "автор не вказаний"}</td>}
            <td style={{ ...td, textAlign: "right" }}>{narrow ? <button className="docs-ib" aria-label="Дії" onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu({ clientX: r.right - 250, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => {} }, kOf("d", f.id)); }}>⋯</button> : hoverActs(f)}</td>
          </tr>); })}
        <tr><td colSpan={(mgmt ? 1 : 0) + 3 + (showDate ? 1 : 0) + (showBy ? 1 : 0)} style={{ height: 80, border: "none" }} onClick={() => setSel(new Set())} onContextMenu={(e) => openMenu(e, "bg")} /></tr>
      </tbody>
    </table>
  );
  const detailsBody = (() => {
    if (inTrash) return <div style={{ padding: 16 }}><p style={noteBox}>Щоб переглянути видалений документ, спершу відновіть його.</p></div>;
    if (sel.size === 1 && selDocs.length === 1) return <DocCardPanel key={selDocs[0].id} file={selDocs[0]} tree={tree} onChanged={async () => { await load(); if (mgmt) await loadTrash(); }} onClose={() => { setSel(new Set()); setSelected(null); }} onToast={(s) => setToast(s)} folderName={folderName} />;
    if (sel.size === 1 && selFolders.length === 1) { const f = selFolders[0]; const n = deepCount(f.id, loc.kind as "reg" | "work"); return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ textAlign: "center", padding: "8px 0" }}><div style={{ fontSize: 52 }}>📁</div><b style={{ fontSize: 16 }}>{cleanName(f.name)}</b><div className="orph-dim">{n} {plural(n, "документ", "документи", "документів")}</div></div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={btn("primary")} onClick={() => openKey(kOf("f", f.id))}>Відкрити</button>{mgmt && <><button style={{ ...btn(), fontSize: 12.5, padding: "4px 10px" }} onClick={() => renameFolder(f)}>✎ Перейменувати</button><button style={{ ...btn(), fontSize: 12.5, padding: "4px 10px" }} onClick={() => setAccessFolder(f)}>⚙ Доступи</button></>}</div>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Шлях: {[SHELF_TITLE[loc.kind], ...pathOf(f.id).slice(0, -1).map((x) => cleanName(x.name))].join(" › ")}</div>
      </div>); }
    const n = sel.size; const cur = "folder" in loc && loc.folder != null ? cleanName(folderName(loc.folder)) : SHELF_TITLE[loc.kind];
    return (
      <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>
        <div style={{ fontSize: 44, marginBottom: 6, opacity: n ? 1 : .6 }}>{n ? "🗂" : "📄"}</div>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{n ? `${n} вибрано` : cur}</div>
        <div style={{ fontSize: 13 }}>{n ? "Дії — на панелі зверху або правою кнопкою миші." : `${keysHere.length} ${plural(keysHere.length, "елемент", "елементи", "елементів")}. Виберіть документ, щоб побачити перегляд, підпис і ознайомлення.`}</div>
        {!n && mgmt && <div style={{ fontSize: 12, marginTop: 10 }}>Права кнопка миші — дії з документом чи папкою. Документи можна перетягувати на папки.</div>}
      </div>
    );
  })();
  const toastObj = toast == null ? null : typeof toast === "string" ? { t: toast } : toast;

  return (
    <div>
      <style>{`.docs-row:hover td{background:var(--surface-2)}.docs-row .docs-hov{opacity:0}.docs-row:hover .docs-hov{opacity:1}.docs-row .docs-cb{opacity:.35}.docs-row:hover .docs-cb,.docs-row .docs-cb:checked{opacity:1}
.docs-ib{border:none;background:transparent;width:28px;height:26px;border-radius:6px;font-size:14px;color:var(--text-muted);cursor:pointer}.docs-ib:hover{background:var(--border);color:var(--text)}
.docs-ni:hover{background:var(--surface-2)!important}.docs-acts button,.docs-acts label{padding:5px 11px!important;font-size:12.5px!important;border-radius:var(--r-md)!important}.docs-cm button:hover:not([disabled]){background:var(--surface-2)}`}</style>
      {toastObj && <div role="status" style={{ position: "fixed", left: "50%", bottom: 22, transform: "translateX(-50%)", zIndex: 2900, background: "var(--text)", color: "var(--card-bg)", borderRadius: "var(--r-lg)", padding: "9px 10px 9px 16px", display: "flex", gap: 14, alignItems: "center", boxShadow: "var(--shadow-lg, 0 8px 24px rgba(0,0,0,.2))", fontSize: 13.5, maxWidth: "92vw" }}>
        <span>{toastObj.t}</span>{"undo" in toastObj && toastObj.undo && <button style={{ border: "none", background: "rgba(255,255,255,.16)", color: "inherit", borderRadius: 6, padding: "5px 10px", fontWeight: 600, cursor: "pointer" }} onClick={() => { toastObj.undo!(); setToastRaw(null); }}>Скасувати</button>}
      </div>}
      <div className="page-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 className="page-title">📁 Регламенти та документи</h1>
        <div className="page-filters"><TelegramChip onToast={(s) => setToast(s)} /></div>
      </div>
      {/* «Мої справи» — смугою над менеджером (Сергій 17.09.2026). */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <span className="orph-dim" style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", marginRight: 4 }}>Мої справи</span>
        {([
          ["🔏 Офер чекає підпису", todo.offers, "var(--warn)", () => setLoc({ kind: "offer" }), !mgmt],
          ["📖 Ознайомитись", todo.regs, "var(--warn)", () => setLoc({ kind: "reg", folder: null }), true],
          ["📷 Фото на підтвердженні", todo.review, "var(--info)", () => setLoc({ kind: "offer" }), mgmt],
          ["🆕 Нові документи", todo.fresh, "var(--brand)", () => { const f = files.find(isNewF); if (f) openDoc(f); }, true],
        ] as [string, number, string, () => void, boolean][]).filter((x) => x[4]).map(([l, n, c, go]) => (
          <button key={l} className="orph-chip" onClick={go} style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 13, color: n ? c : "var(--text-muted)", borderColor: n ? c : "var(--border)" }}>
            {l}<b style={{ fontVariantNumeric: "tabular-nums" }}>{n}</b>
          </button>
        ))}
      </div>
      <input ref={versionInput} type="file" hidden onChange={(e) => { onVersionFile(e.target.files); e.currentTarget.value = ""; }} />
      <div className="chart-card" onKeyDown={onKey} style={{ padding: 0, display: "grid", overflow: "hidden", minHeight: 460,
        gridTemplateColumns: narrow ? "minmax(0,1fr)" : `${paneW.nav}px 0px minmax(0,1fr)${details ? ` 0px ${paneW.det}px` : ""}`,
        gridTemplateRows: narrow ? "auto" : "minmax(0,1fr)", height: narrow ? "auto" : "calc(100vh - 200px)" }}>
        {(!narrow || navOpen) && <div style={{ borderRight: narrow ? "none" : "1px solid var(--border)", borderBottom: narrow ? "1px solid var(--border)" : "none", overflowY: "auto", minHeight: 0, maxHeight: narrow ? 320 : undefined }}>{nav}</div>}
        {!narrow && <PaneDivider label="Ширина дерева" value={paneW.nav} onChange={(v) => setPaneW((w) => ({ ...w, nav: clampPane("nav", v) }))} onReset={() => setPaneW((w) => ({ ...w, nav: PANE_DEFAULT.nav }))} />}
        <div style={{ display: narrow && selDocs.length === 1 && sel.size === 1 ? "none" : "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          {toolbar}
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 14px", borderBottom: "1px solid var(--border)", fontSize: "var(--fs-13)", minHeight: 40 }}>
            {crumbs.map((c, i) => <React.Fragment key={i}>{i > 0 && <span style={{ color: "var(--border-strong, var(--text-muted))" }}>›</span>}
              {c.go ? <button onClick={c.go} style={{ border: "none", background: "transparent", padding: "3px 6px", borderRadius: 6, fontWeight: 600, cursor: "pointer", color: i === crumbs.length - 1 ? "var(--text)" : "var(--text-muted)" }}>{c.t}</button> : <b style={{ padding: "3px 6px" }}>{c.t}</b>}</React.Fragment>)}
            <span className="orph-dim" style={{ marginLeft: "auto" }}>{inTrash ? `${trash?.length ?? 0} у кошику` : `${keysHere.length} ${plural(keysHere.length, "елемент", "елементи", "елементів")}`}</span>
          </div>
          {searching && q.trim().length >= 2 && <div className="orph-dim" style={{ fontSize: 11.5, padding: "6px 14px 0" }}>
            {!textSearch || textSearch.q !== q.trim() || (!textSearch.res && !textSearch.err) ? "Шукаю в тексті документів…"
              : textSearch.err ? <span style={{ color: "var(--danger)" }}>Пошук по тексту не відповів — показано лише збіги в назвах.</span>
              : <>У тексті: {docsHere.filter((f) => textHits.has(f.id)).length} тут.{textSearch.res!.notSearchable ? ` Без тексту (скани, фото): ${textSearch.res!.notSearchable}, у них шукається лише назва.` : ""}{textSearch.res!.pending ? ` Ще обробляються: ${textSearch.res!.pending}.` : ""}</>}
          </div>}
          {loc.kind === "archive" && <div style={{ padding: "10px 14px 0" }}><div style={noteBox}>🗄 {SECTION_HINT.archive} «Повернути» — правою кнопкою миші або в деталях.</div></div>}
          <div tabIndex={0} aria-label="Вміст папки" style={{ flex: 1, overflow: "auto", minHeight: narrow ? 380 : 0, outline: "none" }} onContextMenu={(e) => { if (e.target === e.currentTarget) openMenu(e, "bg"); }}>{center}</div>
        </div>
        {!narrow && details && <PaneDivider invert label="Ширина деталей" value={paneW.det} onChange={(v) => setPaneW((w) => ({ ...w, det: clampPane("det", v) }))} onReset={() => setPaneW((w) => ({ ...w, det: PANE_DEFAULT.det }))} />}
        {(narrow ? sel.size === 1 && selDocs.length === 1 : details) && (
          <div style={{ borderLeft: narrow ? "none" : "1px solid var(--border)", overflowY: "auto", minWidth: 0, minHeight: 0 }}>
            {narrow && <button style={{ ...btn(), margin: "10px 16px 0", fontSize: 12, padding: "4px 10px" }} onClick={() => { setSel(new Set()); setSelected(null); }}>← До списку</button>}
            {detailsBody}
          </div>
        )}
      </div>

      {cm && createPortal(
        <div role="menu" className="docs-cm" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}
          style={{ position: "fixed", left: Math.max(8, cm.x), top: Math.max(8, cm.y), zIndex: 2750, minWidth: 250, maxWidth: 320, background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,.18))", padding: 5, fontSize: 13.5 }}>
          {cm.title && <div style={{ padding: "5px 10px 6px", fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600, borderBottom: "1px solid var(--border)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cm.title}</div>}
          {cm.items.map((it, i) => it === "-" ? <div key={i} style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} /> : (
            <React.Fragment key={i}>
              <button role="menuitem" disabled={it.disabled} onClick={() => { setCm(null); it.run?.(); }}
                style={{ display: "flex", width: "100%", gap: 10, alignItems: "center", border: "none", background: "transparent", textAlign: "left", padding: "7px 10px", borderRadius: 6, cursor: it.disabled ? "not-allowed" : "pointer", opacity: it.disabled ? .45 : 1, color: it.danger ? "var(--danger)" : "var(--text)", font: "inherit" }}>
                <span style={{ width: 18, textAlign: "center" }}>{it.icon}</span>{it.label}{it.kbd && <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>{it.kbd}</span>}
              </button>
              {it.hint && <div style={{ fontSize: 11.5, color: "var(--text-muted)", padding: "0 10px 6px 38px", lineHeight: 1.35 }}>{it.hint}</div>}
            </React.Fragment>))}
        </div>, document.body)}
      {uploadOpen && <UploadDialog tree={tree} section={loc.kind === "offer" ? "offer" : loc.kind === "personal" ? "personal" : "general"} defaultFolder={"folder" in loc ? loc.folder : null}
        onClose={() => setUploadOpen(false)} onDone={(msg) => { setUploadOpen(false); setToast(msg); void load(); }} />}
      {moveDlg && <FolderPickDialog folders={tree.folders}
        title={`Перенести ${moveDlg.length} ${plural(moveDlg.length, "елемент", "елементи", "елементів")}`}
        rootLabel={loc.kind === "reg" ? "📕 Регламенти (без папки)" : "🗂 Робочі документи (без папки)"}
        exclude={moveDlg.filter((k) => k.startsWith("f:")).flatMap((k) => subtree(parseKey(k).id))}
        note="Документ отримає доступи нової папки; папка без власних доступів — доступи нової батьківської. Власні права лишаються."
        onClose={() => setMoveDlg(null)} onPick={(to) => { const ks = moveDlg; setMoveDlg(null); moveKeys(ks, to); }} />}
      {accessFolder && <AccessDialog folder={accessFolder} onClose={() => setAccessFolder(null)} onSaved={() => { setAccessFolder(null); setToast("Доступи збережено, зміну записано в журнал"); void load(); }} />}
      {rightsFile && <FileAccessDialog file={rightsFile} folderName={folderName(rightsFile.folderId)} onClose={() => setRightsFile(null)} onSaved={async () => { setRightsFile(null); setToast("Права документа збережено, зміну записано в журнал"); await load(); }} />}
    </div>
  );
}

const SHELF_TITLE: Record<Loc["kind"], string> = { reg: "Регламенти", work: "Робочі документи", offer: "Офери", personal: "Особисті", archive: "Архів", trash: "Кошик" };
const PANE_DEFAULT = { nav: 230, det: 340 };
const PANE_LIMITS = { nav: [200, 420], det: [320, 680] } as const;
function clampPane(k: "nav" | "det", v: number): number { const [lo, hi] = PANE_LIMITS[k]; return Math.round(Math.min(hi, Math.max(lo, v))); }

/**
 * Роздільник між панелями: нульова доріжка сітки, а сама ручка 10 px поверх межі. Тягнути мишею чи
 * пальцем, стрілки ← → з фокусу (Shift — крок 50), подвійний клік — ширина за замовчуванням.
 */
function PaneDivider({ label, value, onChange, onReset, invert }: { label: string; value: number; onChange: (v: number) => void; onReset: () => void; invert?: boolean }) {
  const dir = invert ? -1 : 1;
  const [drag, setDrag] = useState(false);
  const start = useRef<{ x: number; v: number } | null>(null);
  return (
    <div style={{ position: "relative", zIndex: 3 }}>
      <div role="separator" aria-orientation="vertical" aria-label={`${label}: тягніть або стрілки, подвійний клік — як було`} aria-valuenow={value} tabIndex={0}
        title="Тягніть, щоб змінити ширину. Подвійний клік — як було."
        onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, v: value }; setDrag(true); }}
        onPointerMove={(e) => { if (start.current) onChange(start.current.v + dir * (e.clientX - start.current.x)); }}
        onPointerUp={() => { start.current = null; setDrag(false); }}
        onPointerCancel={() => { start.current = null; setDrag(false); }}
        onDoubleClick={onReset}
        onKeyDown={(e) => { const step = e.shiftKey ? 50 : 10; if (e.key === "ArrowLeft") { e.preventDefault(); onChange(value - dir * step); } else if (e.key === "ArrowRight") { e.preventDefault(); onChange(value + dir * step); } }}
        className="docs-pane-divider"
        style={{ position: "absolute", top: 0, bottom: 0, left: -5, width: 10, cursor: "col-resize", touchAction: "none", outlineOffset: -2,
          background: drag ? "linear-gradient(to right, transparent 3px, var(--brand) 3px, var(--brand) 7px, transparent 7px)" : undefined }} />
      <style>{`.docs-pane-divider:hover, .docs-pane-divider:focus-visible { background: linear-gradient(to right, transparent 4px, var(--border-strong, var(--text-muted)) 4px, var(--border-strong, var(--text-muted)) 6px, transparent 6px); }`}</style>
    </div>
  );
}


/** Українська множина: 1 документ · 2–4 документи · 5–20 документів · 21 документ … */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
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
  const [rightsOpen, setRightsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [render, setRender] = useState<DocRender | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const t = TYPE_META[file.category ?? "Інше"] ?? TYPE_META["Інше"];
  const kind = previewKind(file);
  const mgmt = tree.viewer.isManagement;

  useEffect(() => {
    let alive = true; let url: string | null = null;
    setCardData(null); setViewers(null); setPreview(null); setErr(null); setNoAccess(false); setRender(null); setRenderErr(null);
    fetchDocCard(file.id).then((d) => { if (alive) setCardData(d); })
      .catch((e) => { const r = (e as { response?: { status?: number; data?: { reason?: string } } }).response; if (!alive) return; if (r?.status === 403) setNoAccess(true); else setErr(errOf(e, "Картку не вдалося завантажити")); });
    if (mgmt) fetchDocViewers(file.id).then((v) => { if (alive) setViewers(v); }).catch(() => {});
    if (kind === "docx" || kind === "xlsx") fetchDocRender(file.id).then((r) => { if (alive) setRender(r); }).catch((e) => { if (alive) setRenderErr(errOf(e, "Перегляд не вдався — завантажте файл.")); });
    else if (kind !== "none") fetchDocFileBlobUrl(file.id, { inline: true }).then((u) => { url = u; if (alive) setPreview(u); }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    // Перечитуємо й після підпису / ознайомлення / активації — інакше таймлайн показує стан
    // на момент відкриття картки («Відкрито: ще ні» при вже підписаному, заміряно 16.09.2026).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.version, file.signature.kind, file.ack.mine, file.inactiveAt, file.archivedAt, file.ownRights]);

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
  const presign = () => {
    const d = window.prompt("Коли офер підписано на папері? Дата РРРР-ММ-ДД, або лишіть порожнім, якщо невідомо.", "");
    if (d == null) return;
    void presignDocFile(file.id, d.trim() || null).then(async () => { onToast("Відмічено «підписано раніше» — офер більше не чекає підпису"); await onChanged(); }).catch((e) => setErr(errOf(e, "Не вдалося відмітити")));
  };
  const undoPresign = () => { if (window.confirm("Зняти позначку «підписано раніше»? Офер знову чекатиме підпису, нагадування відновляться.")) void undoPresignDocFile(file.id).then(async () => { onToast("Позначку знято"); await onChanged(); }).catch((e) => setErr(errOf(e, "Не вдалося"))); };
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
        {file.ownRights && <span style={pill("var(--info-bg)", "var(--info)")} title="Права цього документа відрізняються від прав папки">🔐 власні права</span>}
        <button onClick={onClose} title="Закрити" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "var(--text-muted)" }}>✕</button>
      </div>
      <h2 className="chart-title" style={{ marginBottom: 0, lineHeight: 1.3 }}>{file.name}</h2>
      {/* Дії — ЗВЕРХУ, під назвою: перегляд PDF перехоплює прокрутку, і знизу до кнопок не догорнути (власник 17.09.2026). */}
      <div className="docs-acts" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {kind !== "none" && <button style={{ ...btn("primary"), fontSize: 14, padding: "9px 16px" }} onClick={() => setFull(true)} disabled={!preview && !render}>⤢ На весь екран</button>}
        {kind !== "none" && kind !== "docx" && kind !== "xlsx" && <button style={btn()} onClick={() => void open(false)}>У новій вкладці</button>}
        <button style={btn()} onClick={() => void open(true)}>Завантажити</button>
        {file.canEdit && (
          <label style={{ ...btn(), cursor: busy ? "default" : "pointer", opacity: busy ? .6 : 1 }}>Нова версія<input type="file" hidden disabled={busy} onChange={(e) => { newVersion(e.target.files); e.currentTarget.value = ""; }} /></label>
        )}
        {file.canEdit && <button style={btn()} onClick={rename}>Перейменувати</button>}
        {mgmt && file.section === "general" && !file.archivedAt && <button style={btn()} onClick={() => setRightsOpen(true)} title="Права цього документа ширші або вужчі за папку">🔐 Права документа</button>}
        {mgmt && !file.archivedAt && <button style={btn("danger")} onClick={archive}>В архів</button>}
        {mgmt && file.archivedAt && <button style={btn()} onClick={restore}>Повернути з архіву</button>}
        {mgmt && <button style={btn("danger")} onClick={remove} title="Зникне звідусіль; файл і підписи лишаються в системі">Видалити</button>}
        {mgmt && !file.archivedAt && file.inactiveAt && <button style={btn("primary")} onClick={activate}>Активувати</button>}
        {mgmt && file.section === "general" && !file.archivedAt && <button style={btn()} onClick={() => setMoveOpen(true)}>📂 Перенести</button>}
        {mgmt && file.section === "offer" && !file.archivedAt && !file.inactiveAt && sigKindOpen(file.signature.kind) && <button style={btn()} title="Офер уже підписано на папері — повторний підпис не потрібен" onClick={presign}>✍ Підписано раніше</button>}
        {mgmt && file.signature.earlier && <button style={btn()} title="Позначку поставлено помилково — офер знову чекатиме підпису" onClick={undoPresign}>Зняти «підписано раніше»</button>}
      </div>

      {err && <div style={{ fontSize: 12, color: "var(--danger)" }}>{err}</div>}
      {moveOpen && <FolderPickDialog folders={tree.folders} title={`Перенести «${file.name}»`} rootLabel="Без папки" exclude={[]} current={file.folderId}
        note="Документ отримає права нової папки. Власні права документа лишаються." onClose={() => setMoveOpen(false)}
        onPick={(to) => { setMoveOpen(false); void updateDocFile(file.id, { folderId: to }).then(async () => { onToast("Документ перенесено, зміну записано в журнал"); await onChanged(); }).catch((e) => setErr(errOf(e, "Не перенесено"))); }} />}
      {rightsOpen && <FileAccessDialog file={file} folderName={folderName(file.folderId)} onClose={() => setRightsOpen(false)} onSaved={async () => { setRightsOpen(false); onToast("Права документа збережено, зміну записано в журнал"); await onChanged(); }} />}
      {file.inactiveAt && !file.archivedAt && <p style={noteBox}>Документ повернувся з архіву після повернення людини в команду. Поки він неактивний: підписати чи редагувати не можна.{mgmt ? " Натисніть «Активувати», якщо він знову потрібен." : ""}</p>}

      {/* Прев'ю. PDF — без бічних мініатюр і на ширину панелі (параметри вбудованого переглядача
          браузера: navpanes=0, view=FitH), висота на весь екран панелі; «⤢ На весь екран» — оверлей.
          Файл без перегляду — один рядок, а не порожній блок (власник 17.09.2026). */}
      {kind === "none" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: "var(--text-muted)", background: "var(--surface-2)", borderRadius: "var(--r-lg)", padding: "8px 12px" }}>
          <span>📄 {extOf(file.name, file.mime)} не переглядається в дашборді</span>
          <button style={{ ...btn(), fontSize: 12, padding: "4px 10px", marginLeft: "auto" }} onClick={() => void open(true)}>Завантажити</button>
        </div>
      ) : kind === "docx" || kind === "xlsx" ? (
        renderErr ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: "var(--text-muted)", background: "var(--surface-2)", borderRadius: "var(--r-lg)", padding: "8px 12px" }}>
            <span>⚠ {renderErr}</span>
            <button style={{ ...btn(), fontSize: 12, padding: "4px 10px", marginLeft: "auto" }} onClick={() => void open(true)}>Завантажити</button>
          </div>
        ) : (
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
            {!render ? <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>завантаження перегляду…</div> : <OfficeView r={render} height="min(62vh, 720px)" />}
          </div>
        )
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", background: "var(--surface-2)", overflow: "hidden", position: "relative" }}>
          {!preview ? <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>завантаження прев'ю…</div>
            : kind === "image" ? <img src={preview} alt={file.name} style={{ width: "100%", display: "block" }} />
            : <iframe title={file.name} src={kind === "pdf" ? `${preview}#navpanes=0&view=FitH&zoom=page-width` : preview} style={{ width: "100%", height: "min(62vh, 720px)", minHeight: 360, border: "none", background: "#fff", display: "block" }} />}
        </div>
      )}
      {full && (preview || render) && createPortal(
        <div onClick={() => setFull(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 2800, display: "flex", flexDirection: "column", padding: 16, gap: 8 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 10, color: "#fff" }}>
            <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</b>
            <button onClick={() => void open(true)} style={{ ...btn(), marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}>Завантажити</button>
            <button onClick={() => setFull(false)} style={{ ...btn(), fontSize: 12, padding: "4px 10px" }}>✕ Закрити</button>
          </div>
          <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, background: "#fff", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
            {render ? <OfficeView r={render} height="100%" />
              : kind === "image" ? <img src={preview!} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
              : <iframe title={file.name} src={kind === "pdf" ? `${preview}#view=FitH&zoom=page-width` : preview!} style={{ width: "100%", height: "100%", border: "none", display: "block" }} />}
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
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.management ? "повний доступ, змінює права" : r.inheritedFrom ? "успадковано від батьківської папки; збереження зробить права власними" : r.key === "team_lead" ? "тімлід своєї команди" : r.key === "manager" ? "лише свій документ в оферах" : ""}</div>
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

/* ── Перегляд Word / Excel і підсвітка пошуку ──────────────────────────── */
/** Та сама згортка, що на сервері (`core/docSearch.ts`): регістр, латинські двійники, апострофи; довжина не змінюється. */
const HOMO: Record<string, string> = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у", k: "к", "’": "'", "ʼ": "'", "`": "'", "‘": "'" };
function foldText(s: string): string {
  let out = "";
  for (const ch of s) { const lc = ch.toLocaleLowerCase("uk"); const one = lc.length === ch.length ? lc : ch; out += /\s/.test(one) ? " ".repeat(one.length) : (HOMO[one] ?? one); }
  return out;
}
function Highlight({ text, q }: { text: string; q: string }) {
  const terms = [...new Set(foldText(q).split(" ").filter((t) => t.length >= 2))];
  const folded = foldText(text);
  const marks: [number, number][] = [];
  for (const t of terms) for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  marks.sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = []; let at = 0;
  marks.forEach(([s, e], k) => { if (s < at) return; if (s > at) parts.push(text.slice(at, s)); parts.push(<mark key={k} style={{ background: "var(--warn-bg)", color: "var(--text)", borderRadius: 3, padding: "0 1px" }}>{text.slice(s, e)}</mark>); at = e; });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

const colName = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const Runs = ({ runs }: { runs: DocxRun[] }) => <>{runs.map((r, i) => <span key={i} style={{ fontWeight: r.b ? 700 : undefined, fontStyle: r.i ? "italic" : undefined, textDecoration: r.u ? "underline" : undefined, whiteSpace: "pre-wrap" }}>{r.text}</span>)}</>;

/**
 * Word — «аркуш» для читання: заголовки, абзаци, списки, таблиці. Excel — аркуші вкладками й сітка
 * з літерами колонок і номерами рядків. Текст ніколи не стає розміткою: React екранує все сам.
 */
function OfficeView({ r, height }: { r: DocRender; height: string }) {
  const [sheet, setSheet] = useState(0);
  // ↔ Ширини колонок Excel по аркушах: тягнути край заголовка, подвійний клік — під найдовше значення.
  const [colW, setColW] = useState<Record<number, number[]>>({});
  const drag = useRef<{ ci: number; x: number; w: number } | null>(null);
  const note: React.CSSProperties = { fontSize: 11.5, color: "var(--text-muted)", padding: "6px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)" };
  if (r.kind === "docx") {
    const groups: React.ReactNode[] = [];
    for (let i = 0; i < r.blocks.length; i++) {
      const b = r.blocks[i];
      if (b.t === "li") {
        const items = []; while (i < r.blocks.length && r.blocks[i].t === "li") { items.push(<li key={i} style={{ margin: "2px 0" }}><Runs runs={(r.blocks[i] as { runs: DocxRun[] }).runs} /></li>); i++; } i--;
        groups.push(<ul key={`u${i}`} style={{ margin: "6px 0", paddingLeft: 22 }}>{items}</ul>);
      } else if (b.t === "h") {
        const size = b.level === 1 ? 20 : b.level === 2 ? 17 : 15;
        groups.push(<div key={i} role="heading" aria-level={b.level} style={{ fontSize: size, fontWeight: 700, margin: "16px 0 6px", lineHeight: 1.3 }}><Runs runs={b.runs} /></div>);
      } else if (b.t === "table") {
        groups.push(<div key={i} style={{ overflowX: "auto", margin: "8px 0" }}><table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "60%" }}><tbody>
          {b.rows.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "1px solid #c9ccd2", padding: "4px 8px", verticalAlign: "top", whiteSpace: "pre-wrap", fontWeight: ri === 0 ? 600 : undefined, background: ri === 0 ? "#f3f4f6" : undefined }}>{c}</td>)}</tr>)}
        </tbody></table></div>);
      } else groups.push(<p key={i} style={{ margin: "0 0 8px", minHeight: b.runs.length ? undefined : 8 }}><Runs runs={b.runs} /></p>);
    }
    return (
      <div style={{ height, display: "flex", flexDirection: "column", minHeight: 360 }}>
        <div style={note}>Перегляд для читання: поля, колонтитули й розриви сторінок можуть відрізнятись від Word.{r.hasImages ? " Зображення тут не показуються." : ""}{r.truncated ? " Документ довгий — показано початок, повністю в Word." : ""}</div>
        <div style={{ flex: 1, overflowY: "auto", background: "#e9ebef", padding: "16px 12px" }}>
          <div style={{ background: "#fff", color: "#1c1e21", maxWidth: 820, margin: "0 auto", padding: "28px 36px", boxShadow: "0 1px 3px rgba(0,0,0,.15)", fontSize: 14, lineHeight: 1.55, fontFamily: "Calibri, 'Segoe UI', Arial, sans-serif" }}>
            {groups.length ? groups : <p style={{ color: "#6b7280" }}>У документі немає тексту{r.hasImages ? " — лише зображення. Завантажте файл, щоб їх побачити" : ""}.</p>}
          </div>
        </div>
      </div>
    );
  }
  const si = Math.min(sheet, r.sheets.length - 1);
  const sh = r.sheets[si];
  const cols = sh ? Math.max(0, ...sh.rows.map((x) => x.length)) : 0;
  const fit = (ci: number) => { let n = 0; for (const row of sh?.rows ?? []) n = Math.max(n, (row[ci] ?? "").length); return Math.round(Math.min(600, Math.max(60, n * 7.4 + 20))); };
  const widths = colW[si] ?? Array.from({ length: cols }, (_, ci) => Math.min(240, fit(ci)));
  const setWidth = (ci: number, w: number) => setColW((m) => { const cur = [...(m[si] ?? widths)]; cur[ci] = Math.round(Math.min(900, Math.max(40, w))); return { ...m, [si]: cur }; });
  const ROWNUM_W = 52;
  // border-collapse: separate — із collapse закріплена колонка номерів пропускає текст сусідніх клітинок під собою.
  const cell: React.CSSProperties = { borderRight: "1px solid #d4d7dd", borderBottom: "1px solid #d4d7dd", padding: "3px 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", background: "#fff" };
  const head: React.CSSProperties = { ...cell, background: "#f1f3f5", color: "#5f6670", fontWeight: 600, textAlign: "center", position: "sticky", top: 0, zIndex: 1 };
  return (
    <div style={{ height, display: "flex", flexDirection: "column", minHeight: 360, background: "#fff", color: "#1c1e21" }}>
      {r.sheets.length > 1 && (
        <div role="tablist" style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: "1px solid #d4d7dd", overflowX: "auto", background: "#f7f8fa" }}>
          {r.sheets.map((s, i) => <button key={i} role="tab" aria-selected={i === sheet} onClick={() => setSheet(i)} style={{ border: "1px solid " + (i === sheet ? "#1f7a45" : "#d4d7dd"), background: i === sheet ? "#e7f4ec" : "#fff", color: i === sheet ? "#1f7a45" : "#1c1e21", fontWeight: i === sheet ? 700 : 400, borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>{s.name}</button>)}
        </div>
      )}
      {sh?.truncated && <div style={{ ...note, background: "#fff8e6", color: "#8a5a00" }}>Показано перші {sh.rows.length} рядків і до 60 колонок із {sh.totalRows} × {sh.totalCols}. Повністю — в Excel.</div>}
      <style>{`.docs-col-grip:hover { background: linear-gradient(to right, transparent 6px, #1f7a45 6px, #1f7a45 8px, transparent 8px); }`}</style>
      <div style={{ flex: 1, overflow: "auto" }}>
        {!sh || !sh.rows.length ? <p style={{ padding: 16, color: "#6b7280", fontSize: 13 }}>Аркуш порожній.</p> : (
          <table style={{ borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", width: ROWNUM_W + widths.reduce((a, b) => a + b, 0), fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
            <colgroup><col style={{ width: ROWNUM_W }} />{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
            <thead><tr><th style={{ ...head, left: 0, zIndex: 3 }} />{Array.from({ length: cols }, (_, i) => (
              <th key={i} style={head}>
                {colName(i)}
                <span role="separator" aria-orientation="vertical" aria-label={`Ширина колонки ${colName(i)}`} title="Тягніть, щоб змінити ширину. Подвійний клік — під найдовше значення."
                  onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { ci: i, x: e.clientX, w: widths[i] }; }}
                  onPointerMove={(e) => { const d = drag.current; if (d && d.ci === i) setWidth(i, d.w + e.clientX - d.x); }}
                  onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
                  onDoubleClick={() => setWidth(i, fit(i))}
                  className="docs-col-grip"
                  // Ручка ВСЕРЕДИНІ заголовка: клітинка обрізає переповнення, а сусідній заголовок перекривав половину
                  // ручки — ловилось лише 4 px (заміряно на проді 17.09.2026).
                  style={{ position: "absolute", top: 0, right: 0, width: 10, height: "100%", cursor: "col-resize", touchAction: "none", zIndex: 2 }} />
              </th>))}</tr></thead>
            <tbody>
              {sh.rows.map((row, ri) => (
                <tr key={ri}>
                  <td style={{ ...head, top: undefined, position: "sticky", left: 0, zIndex: 2 }}>{ri + 1}</td>
                  {Array.from({ length: cols }, (_, ci) => { const v = row[ci] ?? ""; return <td key={ci} title={v.length > 40 ? v : undefined} style={{ ...cell, textAlign: /^-?[\d.,\s]+$/.test(v) && v.trim() ? "right" : "left" }}>{v}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const sigKindOpen = (k: DocFile["signature"]["kind"]) => k === "pending" || k === "overdue" || k === "outdated";

/* ── Вибір папки призначення ────────────────────────────────────────────── */
function FolderPickDialog({ folders, title, rootLabel, exclude, current, note, onPick, onClose }: { folders: DocFolder[]; title: string; rootLabel: string; exclude: number[]; current?: number | null; note: string; onPick: (to: number | null) => void; onClose: () => void }) {
  const [to, setTo] = useState<string>(current == null ? "" : String(current));
  const opts: { id: number; label: string }[] = [];
  const walk = (parent: number | null, depth: number, seen: number[]) => folders.filter((f) => (f.parentId ?? null) === parent && !seen.includes(f.id)).forEach((f) => {
    if (exclude.includes(f.id)) return;
    opts.push({ id: f.id, label: `${"\u00a0\u00a0\u00a0".repeat(depth)}${depth ? "↳ " : ""}${f.name}` }); walk(f.id, depth + 1, [...seen, f.id]);
  });
  walk(null, 0, []);
  return (
    <Modal title={title} onClose={onClose} width={480}>
      <Field label="Куди">
        <select id="doc-folder-pick" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inp, width: "100%" }}>
          <option value="">{rootLabel}</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </Field>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "10px 0 0" }}>{note}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button style={btn()} onClick={onClose}>Скасувати</button>
        <button style={btn("primary")} onClick={() => onPick(to === "" ? null : Number(to))}>Перенести</button>
      </div>
    </Modal>
  );
}

/* ── Власні права документа ─────────────────────────────────────────────── */
/**
 * По кожній ролі: «як у папці» (показуємо, що це означає) або власні «бачить / редагує».
 * Власні права можуть бути ширші за папку (відкрити документ у закритій папці) і вужчі (закрити
 * документ у відкритій). Керівництво бачить усе й не звужується.
 */
function FileAccessDialog({ file, folderName, onClose, onSaved }: { file: DocFile; folderName: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [data, setData] = useState<DocFileAccess | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchDocFileAccess(file.id).then(setData).catch((e) => setErr(errOf(e, "Права не завантажились"))); }, [file.id]);
  const setOwn = (key: string, own: { canView: boolean; canEdit: boolean } | null) =>
    setData((d) => d && { ...d, roles: d.roles.map((r) => r.key === key && !r.management ? { ...r, own } : r) });
  const save = async () => {
    if (!data) return; setBusy(true); setErr(null);
    try { await saveDocFileAccess(file.id, data.roles.filter((r) => !r.management).map((r) => ({ key: r.key, own: r.own }))); await onSaved(); }
    catch (e) { setErr(errOf(e, "Не збережено")); setBusy(false); }
  };
  const yesNo = (v: boolean) => <span style={{ color: v ? "var(--ok)" : "var(--text-muted)" }}>{v ? "так" : "ні"}</span>;
  const changed = data?.roles.filter((r) => r.own && (r.own.canView !== r.folder.canView || r.own.canEdit !== r.folder.canEdit)).length ?? 0;
  return (
    <Modal title="Права документа" onClose={onClose} width={680}>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
        «{file.name}» у папці «{folderName}». Без позначки роль має права папки. Власні права можуть відкрити документ ролі, якій папка закрита, або закрити його в відкритій папці.
      </div>
      {err && <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>{err}</div>}
      {!data ? <p className="loading-text">Завантаження…</p> : !data.applicable ? <p style={noteBox}>Власні права бувають лише в загальних документів поза архівом.</p> : (
        <>
          <table className="data-table" style={{ fontSize: "var(--fs-13)" }}>
            <thead><tr>
              <th>Роль</th>
              <th style={{ textAlign: "center", fontSize: 11 }}>У папці: бачить · редагує</th>
              <th style={{ textAlign: "center", fontSize: 11 }}>Власні права</th>
              <th style={{ textAlign: "center", fontSize: 11 }}>Бачить</th>
              <th style={{ textAlign: "center", fontSize: 11 }}>Редагує</th>
            </tr></thead>
            <tbody>
              {data.roles.map((r) => {
                const eff = r.management ? { canView: true, canEdit: true } : (r.own ?? r.folder);
                const diff = !!r.own && (r.own.canView !== r.folder.canView || r.own.canEdit !== r.folder.canEdit);
                return (
                  <tr key={r.key} style={diff ? { background: "var(--info-bg)" } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.name}{r.management && <span style={{ ...pill("var(--info-bg)", "var(--info)"), marginLeft: 8 }}>керівництво</span>}</div>
                      {diff && <div style={{ fontSize: 11, color: "var(--info)" }}>{r.own!.canView && !r.folder.canView ? "ширше за папку: бачить" : !r.own!.canView && r.folder.canView ? "вужче за папку: не бачить" : r.own!.canEdit ? "ширше за папку: редагує" : "вужче за папку: не редагує"}</div>}
                    </td>
                    <td style={{ textAlign: "center" }}>{yesNo(r.folder.canView)} · {yesNo(r.folder.canEdit)}</td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" aria-label={`Власні права для ролі ${r.name}`} checked={!!r.own} disabled={r.management}
                        onChange={() => setOwn(r.key, r.own ? null : { ...r.folder })} />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" aria-label={`${r.name} бачить`} checked={eff.canView} disabled={r.management || !r.own}
                        onChange={() => r.own && setOwn(r.key, { canView: !r.own.canView, canEdit: !r.own.canView ? r.own.canEdit : false })} />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" aria-label={`${r.name} редагує`} checked={eff.canEdit} disabled={r.management || !r.own || !r.own.canView}
                        onChange={() => r.own && setOwn(r.key, { ...r.own, canEdit: !r.own.canEdit })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
            {changed ? `Відрізняється від папки: ${changed} ${plural(changed, "роль", "ролі", "ролей")}.` : "Зараз усі ролі мають права папки."} Персональні винятки для людей налаштовуються в «⚙ Доступи» папки. Зміни пишуться в журнал.
            {data.log.length ? ` Останній запис: ${fmtDate(data.log[0].at)} · ${data.log[0].actor ?? "—"}.` : ""}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
            <button style={btn()} onClick={() => data && setData({ ...data, roles: data.roles.map((r) => ({ ...r, own: null })) })} disabled={busy}>Усім як у папці</button>
            <button style={btn()} onClick={onClose} disabled={busy}>Скасувати</button>
            <button style={btn("primary")} onClick={() => void save()} disabled={busy}>{busy ? "Зберігаю…" : "Зберегти права"}</button>
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
