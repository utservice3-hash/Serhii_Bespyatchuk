import { useLayoutEffect, useRef, useState } from "react";

/**
 * 📐 ПОПОВЕР, ЯКИЙ ЗАВЖДИ ВМІЩАЄТЬСЯ У ВІКНІ.
 *
 * 🔴 ЗАМІРЯНО В БРАУЗЕРІ, А НЕ ОЦІНЕНО (26.08.2026). Редактор ліміту — 300×561.
 * При вікні 1600×736:
 *   верхній рядок  → top 388, bottom 949 → вилазить ЗНИЗУ на 213px
 *   нижній рядок   → top −535           → вилазить ЗВЕРХУ на 535px
 * При 1600×900 — 535px униз і 535px угору відповідно. Тобто кнопка «Зберегти»
 * була за межею екрана в ЧОТИРЬОХ випадках із чотирьох, а `max-height` і
 * `overflow-y` дорівнювали `none`/`visible` — обмеження не було взагалі.
 *
 * 🔴 І САМЕ ЦЕ РОБИЛО ВІДМОВУ НЕЗРОЗУМІЛОЮ. Кнопки вимкнені, поки немає причини
 * — це задум. Але пояснення «обовʼязково: через місяць ліміт без причини не
 * відрізнити від помилки» лежало ПІД полем, тобто в тій частині, що за екраном.
 * Людина бачила мертву кнопку й жодного слова чому. Власник: «не можу надати
 * ліміт по сумі та к-сті днів».
 *
 * ⚠️ ЧОМУ ХУК, А НЕ ДВІ КОПІЇ. Дефект спільний для `LimitEditor` і
 * `OwnerEditor` — це один поповер, написаний двічі. Полагодити один і лишити
 * другий означало б рівно те, від чого береже правило «одне правило — одне
 * місце»; а два затискачі з однаковим наміром розійшлися б мовчки.
 *
 * ⚠️ МЕЖА, НАЗВАНА ПЕРШИМ РЯДКОМ: хук рахує ГЕОМЕТРІЮ, а бачить її лише екран.
 * Гейт може перевірити, що стеля висоти й прокрутка задані; що поповер справді
 * влазить — доводить ЗНІМОК із відкритим редактором у нижній третині сторінки.
 */
export interface ClampedPopover {
  ref: React.RefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
}

/** Відступ від краю вікна — щоб поповер не торкався межі й не читався як обрізаний. */
export const POPOVER_GAP = 12;

export function usePopoverClamp(width = 300): ClampedPopover {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      // Якір — клітинка, у якій поповер оголошений: саме біля неї він і має
      // стояти. Беремо її ДО того, як зробимо поповер `fixed`.
      const anchor = el.parentElement?.getBoundingClientRect();
      const w = el.offsetWidth || width;
      const h = el.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      const aLeft = anchor?.left ?? vw / 2 - w / 2;
      const aBottom = anchor?.bottom ?? vh / 2;
      const aTop = anchor?.top ?? vh / 2;
      // По горизонталі: не вилазимо за правий край, не заходимо за лівий.
      const left = Math.max(POPOVER_GAP, Math.min(aLeft, vw - w - POPOVER_GAP));
      // По вертикалі: під якорем; не влазить — над ним; не влазить і там —
      // притискаємо до верху. Прокрутка всередині вже задана стилем.
      let top = aBottom + 4;
      if (top + h > vh - POPOVER_GAP) top = aTop - h - 4;
      if (top < POPOVER_GAP) top = POPOVER_GAP;
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();
    window.addEventListener("resize", place);
    // 🔴 Прокрутка теж рухає якір: без цього поповер «відклеївся» б від рядка,
    // щойно людина крутнула таблицю, і вказував би в порожнє місце.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [width]);

  return {
    ref,
    style: {
      position: "fixed",
      zIndex: 60,
      left: pos?.left ?? 0,
      top: pos?.top ?? 0,
      // Поки не поміряли — не показуємо: інакше перший кадр малюється в кутку
      // й поповер «стрибає» на місце вже після появи.
      visibility: pos ? "visible" : "hidden",
      width,
      // 🔴 СТЕЛЯ + ВЛАСНА ПРОКРУТКА. `dvh`, а не `vh`: на мобільному vh не
      // враховує панель браузера, і низ поповера ховається під нею.
      maxHeight: `calc(100dvh - ${POPOVER_GAP * 2}px)`,
      overflowY: "auto",
    },
  };
}
