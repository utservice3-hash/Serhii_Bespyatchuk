import { useEffect, useRef } from "react";

/**
 * Періодичний виклик `fn`, який:
 *  • ПАУЗИТЬСЯ, коли вкладка у фоні (Page Visibility) — фоновий дашборд не б'є по API;
 *  • при поверненні фокуса робить ОДИН refetch і відновлює цикл;
 *  • додає ДЖИТЕР ±25% до періоду — щоб вкладки різних юзерів не стріляли синхронно
 *    (саме синхронні піки тригерять хостинговий «I'm Under Attack»).
 * Логіку даних не міняє — лише частоту/умови мережевого виклику.
 *
 * @param immediate — викликати одразу на монтуванні (як старий `poll(); setInterval(...)`).
 * @param enabled   — вимикач (зберігає наявні section-guard'и).
 */
export function usePolling(fn: () => void, baseMs: number, opts: { enabled?: boolean; immediate?: boolean } = {}): void {
  const { enabled = true, immediate = false } = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const jittered = () => baseMs * (0.75 + Math.random() * 0.5); // ±25%
    const run = () => { if (!document.hidden) fnRef.current(); };  // на фоні — тік пропускаємо
    const tick = () => { run(); if (!stopped) timer = setTimeout(tick, jittered()); };
    if (immediate) run();
    timer = setTimeout(tick, jittered());
    const onVis = () => { if (!document.hidden) fnRef.current(); }; // refetch при поверненні фокуса
    document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [baseMs, enabled]);
}
