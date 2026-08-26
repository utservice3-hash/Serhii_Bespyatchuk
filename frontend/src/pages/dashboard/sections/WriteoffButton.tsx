/**
 * 🗑 КНОПКА З ПІДПИСОМ, А НЕ ЗНАЧОК КОШИКА (рішення власника 26.08.2026).
 *
 * Кошик читається як «видалити назавжди», а дія оборотна й із журналом —
 * підпис каже, що саме станеться. Зʼявляється при наведенні на рядок
 * (`.recv-row:hover .recv-wo`), бо 74 постійно видимі червоні кнопки
 * перетворили б екран на попередження про небезпеку.
 *
 * ⚠️ Видимість керується CSS, а не станом React: `onMouseEnter` на кожному з 74
 * рядків — це 74 перерендери таблиці на кожен рух миші.
 */
export function WriteoffButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="recv-wo" onClick={onClick}
      title="Списати безнадійний борг в архів — оборотно, з причиною й автором"
      style={{
        font: "inherit", fontSize: "var(--fs-xs)", fontWeight: 500,
        padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap",
        border: "1px solid var(--border)", background: "transparent",
        color: "var(--danger, #b91c1c)", cursor: "pointer",
      }}>
      Списати
    </button>
  );
}
