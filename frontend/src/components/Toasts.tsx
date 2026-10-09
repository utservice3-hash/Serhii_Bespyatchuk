import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { mutationFailureText } from "../actionFeedback";
import { exitDelay, toastLifetime, upsertToast, visibleToasts, type ToastTone } from "./toastRules";

/**
 * 🔔 ОДНЕ ПОВІДОМЛЕННЯ НА ВЕСЬ ДАШБОРД — стандарт «Еволюція бренду UTS» (Роман, 07.10.2026).
 *
 * Історія: 30.09 три копії (Найм, Фінанси, Бізнес-асистент) звели в цю одну. 07.10 сюди ж переїхали
 * останні дві окремі реалізації — тости задачника й месенджера (`Dashboard.tsx`, угорі праворуч,
 * зникали за 7 с разом із помилками) і тост Опитувань (внизу по центру, 3,2 с). Тепер місце одне.
 *
 * Виклик лишився той самий — `toast(text, { error, action, head })`, тож 151 наявний виклик не
 * змінився. Нові можливості — додаткові поля опцій:
 * - `tone` — ok / info / warn / err (за замовчуванням ok, з `error: true` — err);
 * - `key` — тост із тим самим ключем ЗАМІНЮЄ попередній («Зберігаю…» → «Збережено»; серія подій);
 * - `src` — рядок джерела над заголовком («Задачник · Олена Коваль»);
 * - `event` — подія ззовні: зникає за 8 с (пауза під курсором і на прихованій вкладці);
 * - `loading` — триває операція, крутилка замість іконки, закрити не можна;
 * - `onDismiss` — коли тост пішов з екрана (закрили, дія, таймер).
 *
 * Скільки висить — `toastRules.ts` (одне правило й для показу, і для гейтів `#1290`, `#1231`, `#1232`):
 * успіх без кнопки 3 с, подія 8 с (08.10.2026) — обидва з паузою, поки курсор чи фокус на тості або вкладка
 * прихована; помилка й кнопка дії — до закриття. Видно до трьох; решта під «Ще N», помилки ховаються останніми.
 * Іконки чотирьох форм (коло, квадрат, трикутник, восьмикутник), щоб тон читався без кольору.
 *
 * 🛟 СТРАХОВКА. Непіймана помилка ЗАПИСУ сама стає червоним повідомленням з причиною
 * (`mutationFailureText`: читання, 401 і не-серверні помилки мовчать). Тримає `#1101`/`#1101b`.
 */
export type ToastAction = { label: string; run: () => void };
export type ToastOpts = {
  error?: boolean;
  action?: ToastAction;
  head?: string;
  tone?: ToastTone;
  key?: string;
  src?: string;
  event?: boolean;
  loading?: boolean;
  onDismiss?: () => void;
};
export type Toast = (text: string, opts?: ToastOpts) => void;

type Item = {
  id: number; rev: number; text: string; tone: ToastTone; head?: string; src?: string;
  action?: ToastAction; key?: string; event?: boolean; loading?: boolean; hasAction?: boolean;
  count?: number; onDismiss?: () => void;
  /** Тост зникає (програється анімація); з масиву його прибере таймер `exitDelay`. */
  leaving?: boolean;
};

const ToastContext = createContext<Toast | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [docHidden, setDocHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const seq = useRef(0);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  /**
   * Зникнення у ДВА кроки (08.10.2026): спершу тост позначається `leaving` і програє анімацію, потім
   * таймер прибирає його з масиву — але лише якщо він досі `leaving`: той самий ключ міг тим часом
   * принести новий вміст («Зберігаю…» → «Збережено»), і тоді тост лишається. Тримає `#1290b`.
   */
  const dismiss = useCallback((id: number) => {
    const gone = itemsRef.current.find((x) => x.id === id);
    if (!gone || gone.leaving) return;
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    gone.onDismiss?.();
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => setItems((xs) => xs.filter((x) => !(x.id === id && x.leaving))), exitDelay(!!reduce));
  }, []);

  const toast: Toast = useCallback((text, opts) => {
    const tone: ToastTone = opts?.tone ?? (opts?.error ? "err" : "ok");
    const next: Item = {
      id: ++seq.current, rev: seq.current, text, tone, head: opts?.head, src: opts?.src, action: opts?.action,
      key: opts?.key, event: opts?.event, loading: opts?.loading, hasAction: !!opts?.action, onDismiss: opts?.onDismiss,
    };
    setItems((xs) => upsertToast(xs, next));
  }, []);

  useEffect(() => {
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      const msg = mutationFailureText(ev.reason);
      if (msg) toast(msg.text, { error: true, head: msg.head });
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => window.removeEventListener("unhandledrejection", onUnhandled);
  }, [toast]);

  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Тост, що зникає, у «Ще N» не рахується, але домальовує свою анімацію на місці.
  const live = items.filter((x) => !x.leaving);
  const vis = expanded ? { shown: live, hidden: 0 } : visibleToasts(live);
  const keep = new Set(vis.shown.map((x) => x.id));
  const shown = items.filter((x) => keep.has(x.id) || x.leaving);
  const hidden = vis.hidden;
  useEffect(() => { if (items.length <= 3 && expanded) setExpanded(false); }, [items.length, expanded]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Регіон є в DOM від старту — інакше перше повідомлення читач екрана не оголосить. */}
      {createPortal(
        <div className="app-toasts" aria-live="polite" aria-label="Сповіщення">
          {(hidden > 0 || expanded) && (
            <button type="button" className="app-toast-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Згорнути" : `Ще ${hidden} ${hidden >= 5 ? "сповіщень" : "сповіщення"}`}
            </button>
          )}
          {shown.map((it) => (
            <ToastView key={it.id} it={it} docHidden={docHidden} onClose={() => dismiss(it.id)} />
          ))}
        </div>, document.body)}
    </ToastContext.Provider>
  );
}

function ToastView({ it, docHidden, onClose }: { it: Item; docHidden: boolean; onClose: () => void }) {
  const life = toastLifetime(it);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const paused = hover || focus || docHidden;
  const left = useRef<number | null>(life);
  const close = useRef(onClose);
  close.current = onClose;

  // Новий вміст під тим самим ключем — таймер починається заново.
  useEffect(() => { left.current = life; }, [it.rev, life]);
  useEffect(() => {
    if (left.current == null || paused) return;
    const startedAt = Date.now();
    const t = window.setTimeout(() => close.current(), Math.max(1200, left.current));
    return () => {
      window.clearTimeout(t);
      if (left.current != null) left.current -= Date.now() - startedAt;
    };
  }, [paused, it.rev, life]);

  const err = it.tone === "err";
  return (
    <div
      className={`app-toast t-${it.tone}${it.event ? " ev" : ""}${it.leaving ? " leaving" : ""}`}
      role={err ? "alert" : "status"}
      tabIndex={-1}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onKeyDown={(e) => { if (e.key === "Escape" && !it.loading) onClose(); }}
    >
      {it.loading ? <span className="app-toast-spin" aria-hidden="true" /> : <ToneIcon tone={it.tone} />}
      <div className="app-toast-body">
        {it.src && <span className="app-toast-src">{it.src}</span>}
        {it.head && <b>{it.head}</b>}
        <span>{it.text}</span>
      </div>
      {it.action && (
        <button type="button" className="app-toast-act" onClick={() => { it.action!.run(); onClose(); }}>{it.action.label}</button>
      )}
      {!it.loading && <button type="button" className="app-toast-x" aria-label="Закрити" onClick={onClose}>×</button>}
    </div>
  );
}

/** Іконки чотирьох форм — тон читається без кольору (Carbon, Primer). */
function ToneIcon({ tone }: { tone: ToastTone }) {
  return (
    <svg className="app-toast-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {tone === "ok" && (<><circle cx="10" cy="10" r="9" fill="currentColor" /><path d="M5.8 10.2l2.7 2.7 5.7-5.8" fill="none" stroke="var(--sidebar-bg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>)}
      {tone === "info" && (<><rect x="1.5" y="1.5" width="17" height="17" rx="3" fill="currentColor" /><path d="M10 9v5M10 6.2v.1" stroke="var(--sidebar-bg)" strokeWidth="2" strokeLinecap="round" /></>)}
      {tone === "warn" && (<><path d="M10 1.8l8.6 15.4H1.4z" fill="currentColor" /><path d="M10 7.5v4.2M10 14.2v.1" stroke="var(--sidebar-bg)" strokeWidth="2" strokeLinecap="round" /></>)}
      {tone === "err" && (<><path d="M6.3 1.5h7.4l4.8 4.8v7.4l-4.8 4.8H6.3l-4.8-4.8V6.3z" fill="currentColor" /><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></>)}
    </svg>
  );
}

/** Функція показу. Поза `ToastProvider` — помилка розробника, а не тихий no-op: інакше повідомлення зникли б мовчки. */
export function useToast(): Toast {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast() поза <ToastProvider>");
  return t;
}
