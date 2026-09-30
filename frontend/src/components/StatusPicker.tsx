import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskStatus } from "../api";
import { STATUS_GROUPS, STATUS_LABELS, STATUS_DOT_COLORS } from "../pages/dashboard/constants";

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/**
 * 🔝 ШАР МЕНЮ — ВИЩЕ ЗА БІЧНУ КАРТКУ ЗАДАЧІ (`zIndex: 2600`) І ЇЇ ПІДКЛАДКУ (2500).
 * Доти меню стояло на 1000: у рядку списку воно відкривалось, а в картці
 * монтувалось ПІД нею — клік «нічого не робив». Заміряно на проді 30.09.2026
 * (задача 4312): поповер у DOM є, `elementFromPoint` у його центрі — картка.
 * Число — одне на файл і експортується: його звіряє гейт `#1080g` з карткою.
 */
export const STATUS_MENU_Z = 3000;

/**
 * ✅ ПРАВА НА СТАТУС — ЛИШЕ ДЗЕРКАЛО СЕРВЕРА (`statusRights` у `GET /tasks`).
 * Не передано — меню повне (оптимістичний рядок до першого рефетчу; сервер усе
 * одно відмовить 403, і тост назве причину).
 */
export type StatusRightsView = { canChange: boolean; canDone: boolean };

/**
 * Kommo-style status picker: a coloured pill trigger (dot + label) opening a
 * grouped popover (To-do / In progress / Complete) where every status carries
 * its own coloured dot, like the CRM. Replaces the plain native <select> whose
 * options browsers won't let us colour. The popover is portalled to <body> with
 * fixed positioning so it is never clipped by a table cell's overflow:hidden.
 */
export function StatusPicker({
  value, onChange, fullWidth = false, rights, reviewerName,
}: {
  value: TaskStatus;
  onChange: (s: TaskStatus) => void;
  fullWidth?: boolean;
  rights?: StatusRightsView;
  /** Хто може закрити — для підказки на сірому «Готово». */
  reviewerName?: string | null;
}) {
  const canChange = rights?.canChange ?? true;
  const canDone = rights?.canDone ?? true;
  const closer = reviewerName ? `Закрити може: ${reviewerName}` : "Закрити може той, хто приймає задачу";
  // 🔴 Відмова називає себе ДО кліку: кнопка без прав не відкриває меню, яке нічого не зробить.
  const lockedTitle = canChange ? undefined
    : `Статус змінюють виконавець, «Приймає»${reviewerName ? ` (${reviewerName})` : ""} або адмін`;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Оцінка висоти до монтування — з реальної повної висоти меню (9 пунктів, 3 групи
    // і підпис «Закрити може: …» ≈ 440 px). Стара оцінка 320 ставила меню внизу
    // картки так, що нижні пункти — саме «Готово» з причиною — виходили за екран.
    const popW = 240, popH = popRef.current?.offsetHeight ?? 460;
    // Не вилазимо за правий край; якщо знизу не влазить — відкриваємось вгору.
    const left = Math.max(8, Math.min(r.left, vw - popW - 8));
    const top = r.bottom + 6 + popH > vh - 8 && r.top - popH - 6 > 8
      ? r.top - popH - 6
      : Math.min(r.bottom + 6, vh - popH - 8);
    setPos({ top: Math.max(8, top), left });
  };
  // Дві фази: 1) відкрили — оцінка позиції; 2) поповер змонтувався (popRef є) —
  // уточнюємо за реальною висотою, щоб не вилазив за низ/правий край екрана.
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useLayoutEffect(() => { if (open && pos && popRef.current) place(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, popRef.current]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const color = STATUS_DOT_COLORS[value] ?? "#94a3b8";
  const dot = (c: string, size = 9) => (
    <span style={{ width: size, height: size, borderRadius: "50%", background: c, flex: "0 0 auto", display: "inline-block" }} />
  );

  return (
    <div style={{ display: fullWidth ? "block" : "inline-block", width: fullWidth ? "100%" : undefined, maxWidth: "100%" }}>
      <button ref={btnRef} type="button" onClick={() => { if (canChange) setOpen((o) => !o); }}
        disabled={!canChange} title={lockedTitle} aria-disabled={!canChange}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, width: fullWidth ? "100%" : undefined, maxWidth: "100%",
          background: hexA(color, 0.16), color: "var(--text)", border: "none", borderRadius: 999,
          padding: "4px 12px", fontWeight: 600, fontSize: 12, cursor: canChange ? "pointer" : "not-allowed" }}>
        {dot(color)}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{STATUS_LABELS[value]}</span>
        {!canChange && <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>🔒</span>}
      </button>
      {open && pos && createPortal(
        <div ref={popRef} style={{ position: "fixed", zIndex: STATUS_MENU_Z, top: pos.top, left: pos.left, minWidth: 240,
          background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: 8 }}>
          {STATUS_GROUPS.map((group, gi) => (
            <div key={group.label} style={{ marginTop: gi === 0 ? 0 : 6, paddingTop: gi === 0 ? 0 : 6, borderTop: gi === 0 ? "none" : "1px solid var(--border)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4, padding: "4px 8px 6px" }}>
                {group.label}
              </div>
              {group.statuses.map((s) => {
                const c = STATUS_DOT_COLORS[s] ?? "#94a3b8";
                const sel = s === value;
                // ✅ «Готово» без права закривати — сірий пункт із причиною, а не кнопка-пустушка.
                const off = s === "done" && !canDone && !sel;
                return (
                  <button key={s} type="button" disabled={off} title={off ? closer : undefined}
                    onClick={() => { if (off) return; onChange(s); setOpen(false); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", border: "none",
                      background: sel ? hexA(c, 0.16) : "transparent", color: off ? "var(--text-muted)" : "var(--text)",
                      cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.6 : 1,
                      borderRadius: 999, padding: "6px 10px", fontSize: 13, fontWeight: sel ? 700 : 500, marginBottom: 2 }}
                    onMouseEnter={(e) => { if (!sel && !off) (e.currentTarget.style.background = hexA(c, 0.10)); }}
                    onMouseLeave={(e) => { if (!sel && !off) (e.currentTarget.style.background = "transparent"); }}>
                    {dot(off ? "#94a3b8" : c)}
                    <span style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                      <span>{STATUS_LABELS[s]}{off ? " 🔒" : ""}</span>
                      {off && <span style={{ fontSize: 11, fontWeight: 400 }}>{closer}</span>}
                    </span>
                    {sel && <span style={{ color: c, fontWeight: 700 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
