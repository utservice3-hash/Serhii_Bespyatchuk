import { useEffect, useState } from "react";
import { fetchClientStale } from "../api";

/**
 * 🖥 МОДАЛЬНЕ ВІКНО «ВИЙШЛА НОВА ВЕРСІЯ». Зʼявляється ТІЛЬКИ тоді, коли ця вкладка
 * справді крутить стару збірку.
 *
 * 📐 Куплено 04.09.2026, ціна — пів дня трьох людей. Кнопку «Подати план»
 * полагодили 02.09 і викотили; о 14:51 користувачка написала «кнопка сіра, ніхто
 * не може» — і була права щодо того, що бачила: її вкладка крутила стару збірку.
 * Симптому не існувало: сайт відкривається, health 200, версія правильна — просто
 * НЕ ТА, що в браузері. Підтверджено власником 05.09: `Cmd+Shift+R` полагодив.
 *
 * 🔴 ЧОМУ МОДАЛКА, А НЕ СМУЖКА (рішення власника 05.09.2026). Перша редакція була
 * банером угорі екрана — його можна не помітити й працювати далі у старій версії,
 * тобто рівно те, від чого ми лікуємось. Вікно на весь екран не помітити не можна.
 * Ціна — воно перекриває роботу, і саме тому «Закрити» є ОБОВʼЯЗКОВОЮ частиною
 * рішення, а не поступкою: людина мусить мати змогу дописати абзац і оновитись сама.
 *
 * 🔴 НЕ ПЕРЕЗАВАНТАЖУЄМО САМІ: у полі може бути недописане обґрунтування плану чи
 * коментар. Автоперезавантаження стерло б роботу — тобто лікувало б наш недогляд
 * її даними. Кнопка є, натискає людина.
 *
 * 🔔 «ОДИН РАЗ» — і це про ВІКНО, не про опитування. Спокуса прочитати «один раз»
 * як «спитати на завантаженні й забути» вбиває фічу цілком: у момент відкриття
 * вкладки збірка СВІЖА, тож єдина перевірка завжди сказала б «усе гаразд». А
 * потрібна вона рівно тому, хто тримає вкладку відкритою ЧЕРЕЗ викат — відповідь
 * мусить прийти ПІЗНІШЕ за завантаження. Тому: показали → опитування спиняється;
 * закрив → не повертається до перезавантаження сторінки.
 */
const POLL_MS = 2 * 60 * 1000;

/**
 * 🧱 ШАР. Заміряно по фронту: тости — 9999, найвищі живі діалоги — 2100 (решта
 * 2000 і нижче). Отже 2500 — вище за БУДЬ-ЯКИЙ діалог застосунку (інакше вікно
 * про версію ховалося б за екраном, з якого його викликали) і нижче за тости
 * (вони транзитні, перекривати їх нема потреби).
 */
const Z = 2500;

export function VersionBanner() {
  const [stale, setStale] = useState(false);
  const [closed, setClosed] = useState(false);
  const open = stale && !closed;

  useEffect(() => {
    if (stale) return;   // ← показали один раз: більше не питаємо
    let alive = true;
    const load = async () => {
      const r = await fetchClientStale();
      // `null` (не знаю) НЕ гасить уже показане вікно: версія від «не знаю» назад
      // не помолодшала. Гасить лише перезавантаження.
      if (alive && r === true) setStale(true);
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [stale]);

  /**
   * Esc закриває — те саме, що «Закрити». Вікно перекриває екран, тож у людини має
   * бути звичний спосіб прибрати його, не шукаючи кнопку очима.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setClosed(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog" aria-modal="true" aria-labelledby="version-modal-title"
      // Клік по підкладці = «Закрити». Той самий жест, що в діалогах розділу
      // «Клієнти», — щоб вікно поводилось як решта вікон застосунку.
      onClick={(e) => { if (e.target === e.currentTarget) setClosed(true); }}
      style={{
        position: "fixed", inset: 0, zIndex: Z, background: "rgba(15,23,42,.55)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px",
      }}
    >
      <div style={{
        background: "#fff", borderRadius: 16, padding: "26px 26px 22px",
        maxWidth: 460, width: "100%", boxShadow: "0 18px 48px rgba(15,23,42,.28)",
        color: "#0f172a", lineHeight: 1.55,
      }}>
        <div id="version-modal-title" style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>
          Вийшла нова версія дашборда
        </div>
        <div style={{ fontSize: 14, color: "#475467" }}>
          Ви працюєте зі старою — частина виправлень у ній ще відсутня, і кнопки можуть
          поводитись не так, як мають. Оновіть сторінку, щоб перейти на актуальну версію.
        </div>
        <div style={{ fontSize: 12.5, color: "#667085", marginTop: 10 }}>
          Якщо в полях є незбережений текст — закрийте це вікно, збережіть і оновіть самі.
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={() => setClosed(true)} style={{
            border: "1px solid #d0d5dd", background: "#fff", color: "#344054",
            borderRadius: 9, padding: "9px 18px", cursor: "pointer", fontSize: 14,
          }}>
            Закрити
          </button>
          <button onClick={() => location.reload()} autoFocus style={{
            border: "none", background: "#1d4ed8", color: "#fff", borderRadius: 9,
            padding: "9px 22px", cursor: "pointer", fontSize: 14, fontWeight: 600,
          }}>
            Оновити
          </button>
        </div>
      </div>
    </div>
  );
}
