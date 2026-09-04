import { useEffect, useState } from "react";
import { fetchClientStale } from "../api";

/**
 * 🖥 ПЛАШКА «ВИЙШЛА НОВА ВЕРСІЯ». Зʼявляється ТІЛЬКИ тоді, коли ця вкладка
 * справді крутить стару збірку.
 *
 * 📐 Куплено 04.09.2026, ціна — пів дня трьох людей. Кнопку «Подати план»
 * полагодили 02.09 і викотили; о 14:51 користувачка написала «кнопка сіра,
 * ніхто не може» — і була права щодо того, що бачила: її вкладка крутила стару
 * збірку. Симптому не існувало: сайт відкривається, health 200, версія
 * правильна — просто НЕ ТА, що в браузері.
 *
 * 🔴 ПОКАЗУЄТЬСЯ ВСІМ, НА ВІДМІНУ ВІД `HealthBanner`. Той — про несправність
 * системи, і його бачить лише керівництво (менеджерам це шум). Цей — про
 * КОНКРЕТНУ вкладку конкретної людини, і найчастіше в старій збірці сидить саме
 * менеджер, який тримає дашборд відкритим тижнями. Сховати від нього цю плашку
 * означало б зробити її марною рівно там, де вона потрібна.
 *
 * 🔴 НЕ ПЕРЕЗАВАНТАЖУЄМО САМІ, і це рішення, а не лінь: у людини може бути
 * недописане обґрунтування плану чи коментар. Автоперезавантаження стерло б
 * роботу — тобто лікувало б наш недогляд її даними. Кнопка є, натискає людина.
 *
 * ⚠️ Плашка не зникає сама після появи: поки не перезавантажили, стан не
 * змінився. Але й не блокує екран — з нею можна далі працювати.
 */
const POLL_MS = 2 * 60 * 1000;

export function VersionBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await fetchClientStale();
      // `null` (не знаю) НЕ гасить уже показану плашку: версія від «не знаю» назад
      // не помолодшала. Гасить лише перезавантаження.
      if (alive && r === true) setStale(true);
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!stale) return null;

  return (
    <div role="status" style={{
      background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10,
      padding: "10px 14px", marginBottom: 14, fontSize: 13.5, color: "#1e3a8a",
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    }}>
      <span style={{ flex: 1, lineHeight: 1.5 }}>
        <b>Вийшла нова версія дашборда.</b>{" "}
        Ви бачите стару — частина виправлень у ній ще відсутня. Оновіть сторінку.
      </span>
      <button onClick={() => location.reload()} style={{
        border: "none", background: "#1d4ed8", color: "#fff", borderRadius: 8,
        padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600,
      }}>
        Оновити
      </button>
    </div>
  );
}
