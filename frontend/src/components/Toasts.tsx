import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { mutationFailureText } from "../actionFeedback";

/**
 * 🔔 ОДНЕ ПОВІДОМЛЕННЯ «ЗРОБЛЕНО / ПОМИЛКА» НА ВЕСЬ ДАШБОРД (30.09.2026).
 *
 * Було три однакові копії — у «Наймі», «Фінансах» і «Бізнес-асистенті», кожна зі своїм станом,
 * таймером і порталом; решта дашборда повідомлень не мала зовсім. Тепер копія одна, а виклик —
 * той самий `toast(text, { error, action })`, тож секції, що вже ним користуються, не змінились.
 *
 * Правила показу (затверджено Романом 30.09 за макетом):
 * - внизу праворуч, до трьох одночасно, нове знизу — нове більше не ЗАТИРАЄ попереднє (раніше успіх
 *   міг перекрити помилку, а нове повідомлення знищувало кнопку «Повернути» старого);
 * - успіх зникає сам: 5 с, із кнопкою дії — 8 с;
 * - ПОМИЛКА ВИСИТЬ, доки її не закриють: вона зникала за 4 с, і людина, що відвернулась, її не бачила.
 *
 * 🛟 СТРАХОВКА. Кнопка, чий обробник не має `catch`, при помилці сервера нічого не показувала —
 * таких аудит знайшов ~40. Непіймана помилка ЗАПИСУ тепер сама стає червоним повідомленням з
 * причиною (`mutationFailureText`: читання, 401 і не-серверні помилки мовчать). Тримає `#1101`/`#1101b`.
 */
export type ToastAction = { label: string; run: () => void };
export type Toast = (text: string, opts?: { error?: boolean; action?: ToastAction; head?: string }) => void;

type Item = { key: number; text: string; head?: string; error?: boolean; action?: ToastAction };

const MAX_SHOWN = 3;
const ToastContext = createContext<Toast | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((key: number) => setItems((xs) => xs.filter((x) => x.key !== key)), []);

  const toast: Toast = useCallback((text, opts) => {
    const key = ++seq.current;
    setItems((xs) => [...xs, { text, ...opts, key }].slice(-MAX_SHOWN));
    if (!opts?.error) window.setTimeout(() => dismiss(key), opts?.action ? 8000 : 5000);
  }, [dismiss]);

  useEffect(() => {
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      const msg = mutationFailureText(ev.reason);
      if (msg) toast(msg.text, { error: true, head: msg.head });
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => window.removeEventListener("unhandledrejection", onUnhandled);
  }, [toast]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {items.length > 0 && createPortal(
        <div className="app-toasts" aria-live="polite">
          {items.map((it) => (
            <div key={it.key} className={`app-toast${it.error ? " err" : ""}`} role={it.error ? "alert" : "status"}>
              <span className="app-toast-icon" aria-hidden="true">{it.error ? "!" : "✓"}</span>
              <div className="app-toast-body">
                {it.head && <b>{it.head}</b>}
                <span>{it.text}</span>
              </div>
              {it.action && <button className="app-toast-act" onClick={() => { it.action!.run(); dismiss(it.key); }}>{it.action.label}</button>}
              {it.error && <button className="app-toast-x" aria-label="Закрити" onClick={() => dismiss(it.key)}>×</button>}
            </div>
          ))}
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
