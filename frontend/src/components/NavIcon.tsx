/**
 * 🧭 МОНОХРОМНІ ЛІНІЙНІ ІКОНКИ НАВІГАЦІЇ (рішення власника 04.08.2026).
 *
 * 🔴 НАВІЩО ОКРЕМИЙ КОМПОНЕНТ, А НЕ РЯДОК-ЕМОДЗІ В `NAV_GROUPS`.
 * Емодзі рендериться шрифтом операційної системи: на Windows «🧑‍💼» — кольорова
 * картинка, на Linux-сервері скріншотів — прямокутник, у частині збірок ZWJ-склейка
 * розпадається на два символи. Тобто вигляд меню залежав від машини глядача, і ми
 * не могли ані пофарбувати іконку в активний стан, ані зробити її приглушеною.
 * Лінійна SVG успадковує `currentColor`, тож підсвітка активного пункту стає
 * ВЛАСТИВІСТЮ СТИЛЮ, а не окремою картинкою.
 *
 * 🔒 ФОЛБЕК НАВМИСНО ВИДИМИЙ, АЛЕ НЕ ПОРОЖНІЙ: невідомий ключ дає нейтральну
 * крапку-коло, а не `null`. Порожнеча зсунула б підпис і виглядала б як «іконка
 * не завантажилась»; коло чесно каже «пункт є, іконки для нього не описано».
 */
const P: Record<string, React.ReactNode> = {
  // Аналітика
  overview: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 15v-3M12 15V9M17 15v-5" /></>,
  report: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>,
  "manager-report": <><circle cx="12" cy="12" r="9" /><path d="M15 9l-2 5-4 2 2-5z" /></>,
  kvp: <><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" /><path d="M12 14v4M9 21h6" /></>,
  plans: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  statistics: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  depstats: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  teams: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 6a3 3 0 0 1 0 6M17 20a6 6 0 0 0-2-4" /></>,
  managers: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  reports: <><path d="M6 3h12v18l-6-4-6 4z" /></>,
  // Клієнти
  loyalty: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M17 5l3 3-3 3" /><path d="M20 8h-4a3 3 0 0 0-3 3" /></>,
  receivables: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  leadgen: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>,
  // Робота
  tasks: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 12l3 3 5-6" /></>,
  duty: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M8 14h3" /></>,
  bank: <><path d="M3 10h18M4 10l8-6 8 6" /><path d="M6 10v7M10 10v7M14 10v7M18 10v7" /><path d="M3 20h18" /></>,
  oneonone: <><circle cx="7" cy="9" r="2.5" /><circle cx="17" cy="9" r="2.5" /><path d="M2 19a5 5 0 0 1 10 0M12 19a5 5 0 0 1 10 0" /></>,
  rates: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 12h2M14 12h2M8 16h2M14 16h2" /></>,
  goals: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /></>,
  messenger: <><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z" /></>,
  news: <><rect x="3" y="5" width="14" height="15" rx="1.5" /><path d="M17 9h3a1 1 0 0 1 1 1v8a2 2 0 0 1-4 0z" /><path d="M6 9h8M6 13h8M6 17h5" /></>,
  documents: <><path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></>,
  training: <><path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 0-2 2z" /><path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 1 2 2z" /></>,
  // Система
  dataquality: <><circle cx="11" cy="11" r="7" /><path d="M16 16l5 5" /></>,
  feedback: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>,
  aiwork: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" /></>,
  // Clock: readable without a label in the collapsed sidebar, where there is no label.
  tracker: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" /></>,
};

export function NavIcon({ k, size = 18 }: { k: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: "none", display: "block" }}>
      {P[k] ?? <circle cx="12" cy="12" r="7" />}
    </svg>
  );
}

/** Ключі, для яких іконку описано. Використовує тест-дзеркало: пункт меню без
 *  своєї іконки мовчки їде на фолбек-коло, і в UI це майже непомітно. */
export const NAV_ICON_KEYS = Object.keys(P);
