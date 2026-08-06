import { useState } from "react";
import { addClientComment, type LastComment } from "../../../api";

/**
 * 💬 КОМЕНТАР ПРЯМО В РЯДКУ — «чому клієнт не замовляє».
 *
 * 🔴 ПРИВІД (рішення власника 05.08.2026). Епізодичний клієнт мовчить 55 днів і
 * формально ще «активний» (поріг 60) — записати причину НЕМА ДЕ. Поки поле живе
 * лише в картці, його не заповнює ніхто: заради одного речення ніхто не
 * розгортає рядок. Дія, до якої треба два кліки, на практиці не існує — це той
 * самий урок, що з формою обʼєднання під таблицею на 610 рядків.
 *
 * 🔴 ТЕ САМЕ ПОЛЕ, ЩО В КАРТЦІ (`client_comments`), а не друге поруч. Два
 * «коментарі» з однаковою назвою розійшлися б за місяць, і ніхто б не знав, який
 * із них бачить клієнт. Тут — ОСТАННІЙ запис; уся стрічка лишається в картці.
 *
 * ⚠️ СКОРОЧУЄМО ПОКАЗ, А НЕ ТЕКСТ. У рядку видно початок, повний текст — у
 * `title`. Обрізати сам текст при збереженні не можна: людина написала його
 * повністю й розраховує, що він таким і лишиться.
 */
export function RowComment({ clientKey, value, canWrite, onSaved }: {
  clientKey: string;
  value: LastComment | null;
  canWrite: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body = draft.trim();
    if (!body) { setEditing(false); return; }
    setBusy(true);
    try { await addClientComment({ clientKey, body }); setDraft(""); setEditing(false); onSaved(); }
    finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {/* 🔴 textarea, а не input: причина «чому не замовляє» рідко вміщується в
            один рядок, і переноси мусять зберігатись. */}
        <textarea
          autoFocus value={draft} disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter зберігає, Shift+Enter — новий рядок, Esc скасовує.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); }
            if (e.key === "Escape") { setEditing(false); setDraft(""); }
          }}
          placeholder="чому не замовляє…"
          rows={2}
          style={{ fontSize: 12, padding: "4px 7px", border: "1px solid #d1d5db", borderRadius: 7,
                   width: 210, resize: "vertical", fontFamily: "inherit" }} />
        <button onClick={() => void save()} disabled={busy}
          style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #d1d5db",
                   background: "#fff", cursor: "pointer" }}>OK</button>
      </div>
    );
  }

  const text = value?.body ?? "";
  const short = text.length > 34 ? text.slice(0, 34) + "…" : text;
  const tip = text
    ? `${text}\n\n— ${value?.author ?? "невідомо"}, ${value?.createdAt ?? ""}`
    : "коментаря ще немає";

  return (
    <span
      title={tip}
      onClick={canWrite ? () => { setDraft(text); setEditing(true); } : undefined}
      style={{ fontSize: 12, color: text ? "#374151" : "#9ca3af",
               cursor: canWrite ? "pointer" : "default", display: "inline-block", maxWidth: 220 }}>
      {short || (canWrite ? "+ коментар" : "—")}
    </span>
  );
}
