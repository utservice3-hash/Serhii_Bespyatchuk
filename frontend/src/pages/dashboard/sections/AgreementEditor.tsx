import { useEffect, useRef, useState } from "react";
import { saveReceivableNote, type ReceivableClient } from "../../../api";
import { usePopoverClamp } from "../usePopoverClamp";
import { NOTE_MAX, agreementLine, formatDateSafe } from "../receivablesView";

/**
 * 🗓 РЕДАКТОР ДОМОВЛЕНОСТІ (макет v6.1, прохід B).
 *
 * 🔴 НАВІЩО ВІН ІСНУЄ. Дата й коментар жили ПРЯМО В РЯДКУ таблиці —
 * `span 16 + input 27 + CommentField 42 + button 32 = 117px`, і саме вони
 * задавали ритм УСІЙ таблиці: заміряно 117..156 при даних на 18px. На екран
 * влазило 7 боржників із 78, сторінка була 11 721px. Форма нікуди не зникає —
 * вона просто перестає жити всередині рядка.
 *
 * 🔴 ТИЖНЕВА МЕЖА НЕ ПЕРЕЇЖДЖАЄ РАЗОМ ІЗ РЕДАГУВАННЯМ (вимога, повторена
 * двічі). Поповер править запис ПОТОЧНОГО тижня, а не «останній узагалі»:
 * `note` приходить уже звуженим через `activeNote(...)` тим самим виразом, що
 * малює рядок. Якби поповер брав `client.comment` напряму, він відкривав би на
 * редагування торішню обіцянку, яку рядок свідомо ховає, — і людина
 * переписувала б історію, думаючи, що додає запис.
 *
 * ⚠️ ЗБЕРЕЖЕННЯ — ТИМ САМИМ ВИКЛИКОМ, ЩО Й РАНІШЕ (`saveReceivableNote`), з
 * тим самим тілом. Прохід верстки не має права зрушити ані формат запису, ані
 * журнал: `receivable_note_history` наповнюється сервером, і про переїзд
 * редагування він не знає й знати не мусить.
 *
 * ⌨️ ESC ЗАКРИВАЄ І ПОВЕРТАЄ ФОКУС на кнопку, що відкрила. Без повернення
 * клавіатурний шлях обривається: поповер зник, а фокус лишився на `body`, тож
 * наступний `Tab` починає обхід таблиці спочатку. Це той самий дефект, що
 * `#193` упіймав у діалозі обʼєднання, лише в інший бік.
 */
export function AgreementEditor({ client, note, onPatch, onDone, onClose }: {
  client: ReceivableClient;
  /** Запис ПОТОЧНОГО тижня — уже звужений `activeNote`, не `client.comment`. */
  note: string;
  /** Оптимістичний патч рядка — та сама сигнатура, що в секції: порожній
   *  `comment` означає «запис цього тижня прибрати». */
  onPatch: (patch: { comment?: string; dueDate?: string | null }) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const [dueDate, setDueDate] = useState(client.dueDate ?? "");
  const [comment, setComment] = useState(note);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ⌨️ Фокус усередину — інакше «Enter відкрив» і нічого не сталось: поповер є,
  // а вводити нікуди, поки не клацнеш мишею.
  const firstRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true); setErr(null);
    const next = comment.trim();
    const nextDate = dueDate || null;
    try {
      // Оптимістичне оновлення — те саме, що робив рядок: сервер відповідає
      // порожнім тілом, тож без нього значення повернулось би лише на рефреші.
      onPatch({ comment: next, dueDate: nextDate });
      await saveReceivableNote({ clientKey: client.clientKey, comment: next, dueDate: nextDate });
      onDone();
    } catch (e) {
      const r = e as { response?: { data?: { error?: string } } };
      setErr(r?.response?.data?.error ?? "Не вдалось зберегти");
      setBusy(false);
    }
  };

  // Той самий затискач, що в `LimitEditor`/`OwnerEditor`: поповер, який не
  // вміщається у вікні, ховає власні кнопки — заміряно 300×561 при вікні 736.
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const clamp = usePopoverClamp(320);
  const box: React.CSSProperties = narrow
    ? { position: "fixed", zIndex: 60, left: "50%", top: "50%", transform: "translate(-50%, -50%)",
        width: "min(360px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 32px)", overflowY: "auto",
        padding: 14, background: "var(--card-bg)", border: "1px solid var(--border)",
        borderRadius: 12, boxShadow: "0 18px 50px rgba(0,0,0,0.45)", textAlign: "left" }
    : { ...clamp.style, padding: 12,
        background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)", textAlign: "left" };

  const field: React.CSSProperties = {
    font: "inherit", fontSize: "var(--fs-13)", padding: "5px 8px", borderRadius: 8, width: "100%",
    border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)",
  };
  const btn = (bg: string): React.CSSProperties => ({
    font: "inherit", fontSize: "var(--fs-13)", fontWeight: 600, padding: "6px 10px", borderRadius: 8,
    border: "1px solid var(--border)", background: bg, color: "var(--text)",
    cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
  });

  const line = agreementLine(client.dueDate ?? null, note);

  return (
    <>
      {narrow && (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 59, background: "rgba(0,0,0,0.45)" }} />
      )}
      <div ref={narrow ? undefined : clamp.ref} style={box} role="dialog"
           aria-label={`Домовленість: ${client.clientName}`}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 700, marginBottom: 2 }}>Домовленість з клієнтом</div>
        {/* 🔴 ЩО САМЕ ПРАВИМО — СКАЗАНО ВГОЛОС. Поле показує запис поточного
            тижня; без цього підпису людина вирішить, що бачить «останній
            коментар», і не зрозуміє, куди подівся торішній. */}
        <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.4 }}>
          Зараз: {line.empty ? "записів за поточний тиждень немає" : line.tip.replace(" Натисніть, щоб змінити.", "")}
          <div style={{ marginTop: 2 }}>
            Правиться запис ПОТОЧНОГО тижня (від понеділка 00:00 за Києвом). Попередні лишаються в історії.
          </div>
        </div>

        <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
          Обіцяна дата оплати
        </label>
        <input ref={firstRef} type="date" value={dueDate} disabled={busy}
          aria-label={`Обіцяна дата ${client.clientName}`}
          onChange={(e) => setDueDate(e.target.value)}
          style={{ ...field, marginBottom: 8 }} />

        <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: 3 }}>
          Суть домовленості
        </label>
        <textarea value={comment} disabled={busy}
          aria-label={`Домовленість ${client.clientName}`}
          onChange={(e) => setComment(e.target.value.slice(0, NOTE_MAX))}
          placeholder="Про що домовились цього тижня"
          style={{ ...field, fontSize: "var(--fs-sm)", minHeight: 60, resize: "vertical", marginBottom: 4 }} />
        {/* Той самий слот із підлогою висоти, що в редакторі ліміту: лічильник
            зʼявляється й зникає, а кнопки під ним не сміють їхати. */}
        <div className="recv-hintslot" style={{ color: "var(--text-muted)", marginBottom: 8 }}>
          {comment.trim() ? `${comment.trim().length}/${NOTE_MAX}`
                          : "Порожнє поле = запис цього тижня прибрати"}
        </div>

        {err && <div style={{ fontSize: "var(--fs-xs)", color: "var(--danger)", marginBottom: 6 }}>{err}</div>}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button disabled={busy} style={btn("var(--accent-soft)")} onClick={save}>Зберегти</button>
          <button disabled={busy} style={{ ...btn("transparent"), border: "none", color: "var(--text-muted)" }}
            onClick={onClose}>Скасувати</button>
        </div>

        {client.dueDate && (
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginTop: 8 }}>
            Поточна обіцяна дата: {formatDateSafe(client.dueDate)}
          </div>
        )}
      </div>
    </>
  );
}
