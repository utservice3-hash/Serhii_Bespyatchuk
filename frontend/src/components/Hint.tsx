import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 💬 ПІДКАЗКА, ЯКУ НЕ РІЖЕ КОНТЕЙНЕР ПРОКРУТКИ.
 *
 * 🔴 ЄДИНИЙ ПРИЙОМ, УЗЯТИЙ З МАКЕТА ДОСЛІВНО, і причина технічна: таблиця
 * дебіторки живе всередині `overflow-x: auto`, а будь-який `position:absolute`
 * усередині такого контейнера обрізається його межами. Тобто підказка над
 * правою колонкою була б обрізана рівно там, де вона потрібна. Тому вона
 * рендериться В `body` через портал і позиціюється `position:fixed` —
 * координатами з `getBoundingClientRect()` елемента-власника.
 *
 * 🔴 ТЕКСТ, А НЕ HTML. Макет підставляє сирий HTML, і для статичного файлу це
 * нормально; у нас у підказки їдуть назви клієнтів і суми з БД, тож сирий HTML
 * означав би ін'єкцію з даних. Заголовок і тіло — окремі поля, обидва
 * рендеряться як текст.
 *
 * ⚠️ Один шар на весь екран, а не по одному на клітинку: 74 рядки × 8 підказок
 * дали б 592 приховані вузли в DOM. Показується завжди рівно одна.
 */

interface TipState { title?: string; body: string; rect: DOMRect }

let show: ((s: TipState) => void) | null = null;
let hide: (() => void) | null = null;

/** Шар підказки. Монтується ОДИН раз на екран — усередині секції, поруч з таблицею. */
export function TipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    show = setTip;
    hide = () => setTip(null);
    // Прокрутка зсуває власника, а `fixed` за ним не йде — тож ховаємо.
    // `capture: true` обовʼязково: прокручується ВНУТРІШНІЙ контейнер таблиці,
    // і без capture подія до вікна не дійде.
    const off = () => setTip(null);
    window.addEventListener("scroll", off, true);
    window.addEventListener("resize", off);
    return () => {
      show = null; hide = null;
      window.removeEventListener("scroll", off, true);
      window.removeEventListener("resize", off);
    };
  }, []);

  // Позицію рахуємо ПІСЛЯ рендеру: до нього ширина/висота підказки невідомі,
  // а без них її не втримати в межах вікна.
  useEffect(() => {
    if (!tip || !box.current) { setPos(null); return; }
    const w = box.current.offsetWidth, h = box.current.offsetHeight;
    const r = tip.rect;
    const left = Math.max(10, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 10));
    const top = r.top - h - 8 < 10 ? r.bottom + 8 : r.top - h - 8;
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} role="tooltip"
      style={{
        position: "fixed", zIndex: 99, maxWidth: 290,
        left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        background: "var(--tip-bg, #1f2330)", color: "var(--tip-text, #f4f3f1)",
        fontSize: "var(--fs-sm)", lineHeight: 1.45,
        padding: "8px 10px", borderRadius: 8,
        boxShadow: "0 8px 24px rgba(15,23,42,0.24)", pointerEvents: "none",
        opacity: pos ? 1 : 0, transition: "opacity .12s",
      }}>
      {tip.title && <b style={{ fontWeight: 600, display: "block" }}>{tip.title}</b>}
      {tip.body}
    </div>,
    document.body
  );
}

/**
 * Обробники для БУДЬ-ЯКОГО елемента, що має нести підказку.
 *
 * Клавіатура нарівні з мишею (`focus`/`blur`): підказка — єдине місце, де
 * написано, звідки число, і сховати її від того, хто ходить табом, означало б
 * лишити його без пояснення зовсім.
 */
export function tipProps(body: string, title?: string) {
  const open = (e: { currentTarget: Element }) =>
    show?.({ title, body, rect: e.currentTarget.getBoundingClientRect() });
  return {
    onMouseEnter: open, onFocus: open,
    onMouseLeave: () => hide?.(), onBlur: () => hide?.(),
    tabIndex: 0,
  };
}

/**
 * Значок «i» біля показника.
 *
 * 🔴 ПРАВИЛО ВЛАСНИКА: якщо на екрані є число, має бути пояснення, звідки воно.
 * Значок — не прикраса, а те, що робить пояснення знайденим: `title`-атрибут
 * бачить лише той, хто здогадався навести саме на текст.
 */
export function Hint({ body, title, label }: { body: string; title?: string; label?: string }) {
  return (
    <i {...tipProps(body, title)}
      aria-label={label ?? "пояснення"}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 13, height: 13, borderRadius: 999, marginLeft: 4,
        border: "1px solid var(--border-strong, #d1d5db)", color: "var(--text-muted)",
        fontSize: "var(--fs-xs)", fontWeight: 700, fontStyle: "normal", lineHeight: 1,
        cursor: "help", flex: "none", verticalAlign: "middle",
      }}>i</i>
  );
}

/** Обгортка для елемента, який САМ несе підказку (чип, прочерк, число). */
export function Tip({ body, title, children, style }: {
  body: string; title?: string; children: ReactNode; style?: React.CSSProperties;
}) {
  return <span {...tipProps(body, title)} style={{ cursor: "help", ...style }}>{children}</span>;
}
