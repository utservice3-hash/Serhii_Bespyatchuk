import { useEffect, useRef, useState } from "react";
import { adoptsExternal } from "./commentDraft";

/**
 * Єдине поле коментаря по всьому проєкту: текст ВИДНО ПОВНІСТЮ (перенос рядків,
 * автовисота), не обрізається в один рядок. Редаговане — авто-textarea зі
 * збереженням на blur; лише-читання — повний текст із переносами.
 *
 * Заміняє одно-рядкові <input> для коментарів (дебіторка, задачі, плани тощо).
 */
export function CommentField({
  value,
  onSave,
  editable = true,
  placeholder = "коментар…",
  minWidth = 160,
}: {
  value: string | null | undefined;
  onSave?: (next: string) => void;
  editable?: boolean;
  placeholder?: string;
  minWidth?: number;
}) {
  const [v, setV] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  /**
   * 🔴 «Брудна» чернетка = людина щось набрала й ще не зберегла (збереження на `blur`).
   * Прапорець у ref, а не в state: він не має спричиняти перемальовування, і мусить
   * бути актуальним у момент, коли прилітає зовнішнє значення.
   */
  const dirty = useRef(false);

  // Синхронізуємось із зовнішнім значенням — але НЕ поверх незбереженої чернетки.
  useEffect(() => {
    if (adoptsExternal(dirty.current, value ?? "", v)) setV(value ?? "");
    // `v` навмисно не в залежностях: реагуємо на зміну ЗОВНІШНЬОГО значення,
    // а не на власний набір — інакше ефект бігав би на кожну літеру.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(grow, [v]);

  if (!editable) {
    return (
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.4, fontSize: 12 }}>
        {value?.trim() ? value : <span style={{ color: "var(--text-muted)" }}>—</span>}
      </div>
    );
  }

  const commit = () => { dirty.current = false; if (v !== (value ?? "")) onSave?.(v); };
  return (
    <textarea
      ref={ref}
      value={v}
      placeholder={placeholder}
      onChange={(e) => { dirty.current = true; setV(e.target.value); }}
      onInput={grow}
      onBlur={commit}
      rows={1}
      style={{
        font: "inherit", fontSize: 12, lineHeight: 1.4, padding: "4px 6px",
        borderRadius: 6, border: "1px solid var(--border)", background: "var(--card-bg)",
        color: "var(--text)", width: "100%", minWidth, resize: "vertical",
        overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}
    />
  );
}
