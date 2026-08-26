import { useEffect, useState } from "react";
import { fetchReceivableNoteHistory, type ReceivableNoteEntry } from "../../../api";
import { weekStartKyiv, parseDateSafe } from "../receivablesView";

/**
 * 🗓 ЖУРНАЛ ДОМОВЛЕНОСТЕЙ — доказ того, що «очищення» нічого не втратило.
 *
 * Поле в рядку показує лише запис ПОТОЧНОГО тижня; усе старіше живе тут. Без
 * цього вікна тижнева межа читалась би як зникнення даних — а вона саме тим і
 * відрізняється від джоби, що не видаляє нічого.
 *
 * Записи групуються ПО ТИЖНЯХ (київський понеділок), бо саме тиждень — одиниця
 * правила. Групувати по днях означало б показувати межу, якої в правилі немає.
 */
export function NoteHistoryDialog({ clientKey, clientName, onClose }: {
  clientKey: string; clientName: string; onClose: () => void;
}) {
  const [rows, setRows] = useState<ReceivableNoteEntry[] | "loading" | "error">("loading");
  useEffect(() => {
    fetchReceivableNoteHistory(clientKey).then(setRows).catch(() => setRows("error"));
  }, [clientKey]);

  const box: React.CSSProperties = {
    position: "fixed", zIndex: 70, left: "50%", top: "50%", transform: "translate(-50%,-50%)",
    width: "min(460px, calc(100vw - 32px))", maxHeight: "calc(100vh - 48px)", overflowY: "auto",
    padding: 16, background: "var(--card-bg)", border: "1px solid var(--border)",
    borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,0.45)", textAlign: "left",
  };
  const thisWeek = weekStartKyiv(new Date());
  // 🔴 Сторож і тут: журнал дістає дати з БД, і одна нерозбірна серед них
  // убила б ВЕСЬ діалог. Той самий механізм, що поклав розділ 26.08.2026.
  const weekOf = (at: string) => { const d = parseDateSafe(at); return d ? weekStartKyiv(d) : ""; };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 69, background: "rgba(0,0,0,0.45)" }} />
      <div style={box} role="dialog" aria-label={`Історія домовленостей: ${clientName}`}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 700 }}>Історія домовленостей</div>
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", margin: "2px 0 10px", lineHeight: 1.4 }}>
          {clientName} · поле в рядку показує лише запис поточного тижня, решта лежить тут.
          Нічого не видаляється — просто перестає вважатись актуальним.
        </div>
        {rows === "loading" && <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>Завантаження…</div>}
        {rows === "error" && <div style={{ fontSize: "var(--fs-sm)", color: "var(--danger)" }}>Не вдалось завантажити журнал</div>}
        {Array.isArray(rows) && rows.length === 0 && (
          /* Порожній стан — ВІДПОВІДЬ, а не порожнє місце. */
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
            Записів ще немає — з цим клієнтом домовленостей не фіксували.
          </div>
        )}
        {Array.isArray(rows) && rows.map((e, i) => {
          const w = weekOf(e.at);
          const head = i === 0 || weekOf(rows[i - 1].at) !== w;
          return (
            <div key={i} style={{ marginBottom: 10 }}>
              {head && (
                <div style={{ fontSize: "var(--fs-xs)", fontWeight: 600, color: "var(--text-muted)", marginBottom: 2 }}>
                  {w ? `Тиждень із ${new Date(w).toLocaleDateString("uk-UA")}` : "Дата запису невідома"}
                  {w === thisWeek && <span style={{ color: "var(--info, #1d4ed8)" }}> · поточний</span>}
                </div>
              )}
              <div style={{ fontSize: "var(--fs-sm)" }}>{e.comment}</div>
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
                {parseDateSafe(e.at)?.toLocaleString("uk-UA") ?? "дата невідома"} · {e.author ?? "автор невідомий"}
              </div>
            </div>
          );
        })}
        <button onClick={onClose}
          style={{ font: "inherit", fontSize: "var(--fs-13)", fontWeight: 600, padding: "6px 10px",
                   borderRadius: 8, border: "1px solid var(--border)", background: "transparent",
                   color: "var(--text)", cursor: "pointer", marginTop: 4 }}>Закрити</button>
      </div>
    </>
  );
}
