import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 🔔 ОДНЕ ПОВІДОМЛЕННЯ «ЗРОБЛЕНО / ПОМИЛКА» НА ВЕСЬ ДАШБОРД (30.09.2026).
 *
 * Було три однакові копії — у «Наймі», «Фінансах» і «Бізнес-асистенті», кожна зі своїм станом,
 * таймером і порталом; решта дашборда повідомлень не мала зовсім. Тепер копія одна, а виклик —
 * той самий `toast(text, { error, action })`, тож секції, що вже ним користуються, не змінились.
 */
export type ToastAction = { label: string; run: () => void };
export type Toast = (text: string, opts?: { error?: boolean; action?: ToastAction }) => void;

type Item = { key: number; text: string; error?: boolean; action?: ToastAction };

const ToastContext = createContext<Toast | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<Item | null>(null);

  const toast: Toast = useCallback((text, opts) => {
    const key = Date.now();
    setItem({ text, ...opts, key });
    window.setTimeout(() => setItem((t) => (t && t.key === key ? null : t)), opts?.action ? 8000 : 4000);
  }, []);

  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {item && createPortal(
        <div className={`hr-toast ${item.error ? "err" : ""}`} role="status">
          <span>{item.text}</span>
          {item.action && <button onClick={() => { item.action!.run(); setItem(null); }}>{item.action.label}</button>}
        </div>, document.body)}
    </ToastContext.Provider>
  );
}

/** Функція показу. Поза `ToastProvider` — помилка розробника, а не тихий no-op: інакше повідомлення зникли б мовчки. */
export function useToast(): Toast {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast() поза <ToastProvider>");
  return t;
}
