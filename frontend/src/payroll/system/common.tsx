/**
 * 💰 «Зарплата» · системні вкладки — спільне: довідники рушія (тексти 1:1 з `engine/zarplata-engine.mjs`: LEAVE_TYPES,
 * PAY_MODES макета), модальне вікно, поле форми, дрібні формати. Суми не рахуємо — лише показуємо те, що віддав сервер.
 */
import { useEffect, type ReactNode } from "react";
import "./system.css";

/** Звільнення (п. 11 оферу) — `LEAVE_TYPES` рушія: [назва, правило]. */
export const LEAVE_TYPES: Record<string, [string, string]> = {
  own: ["за власним бажанням (з попередженням)", "ставка за неповний місяць не нараховується — лише відсоток від маржі"],
  ownNow: ["за власним бажанням, без 2 тижнів", "лише відсоток від маржі; розрахунок — після обхідного листа"],
  probation: ["під час / після випробувального", "ставка за перший місяць не нараховується; відсоток і бонус — за відпрацьований період"],
  company: ["з ініціативи компанії", "ставка — пропорційно відпрацьованим дням"],
  gross: ["грубе порушення", "лише відсоток від маржі"],
};

/** «Чи впливає оплата клієнта на ЗП» — `payMode` (макет, p01a-base.js). */
export const PAY_MODES: Array<[string, string, string]> = [
  ["success", "За «Успішно реалізовано»", "Маржа йде в ЗП того місяця, коли угода перейшла в «Успішно реалізовано». Борг клієнта на ЗП не впливає."],
  ["paid", "Лише оплачені", "Маржа угоди йде в ЗП, коли клієнт повністю заплатив. Неоплачені переходять на місяць оплати."],
  ["overdue", "Утримання за прострочку", "Нараховуємо за «Успішно реалізовано», але угода з прострочкою клієнта понад узгоджені дні переходить на місяць оплати."],
];

export const OFFER_NAMES: Record<string, string> = { std: "Стандартний офер", ls: "Офер команди Лілії Шаврової" };
export const ROLE_NAMES: Record<string, string> = { manager: "менеджер", lead: "тім-лід", staff: "ставка" };
export const LEVEL_NAMES: Record<string, string> = { start: "«Старт»", profi: "«Профі»" };

/** українська множина: plural(5, 'день', 'дні', 'днів') */
export function plural(n: number, a: string, b: string, c: string): string {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
}
/** '2026-11-20' → «20.11.2026»; '2026-11-20T15:10' → «20.11 15:10». */
export const ddy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
export const dt = (iso: string | null | undefined) => {
  if (!iso) return "—";
  if (iso.length <= 10) return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  if (/Z$|[+-]\d\d:\d\d$/.test(iso)) {   // справжній момент часу (ISO із сервера) — показуємо за Києвом
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d).replace(",", "");
  }
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`;   // київський рядок рушія «РРРР-ММ-ДДTгг:хх»
};
/** «ММ-ДД» → «ДД.ММ». */
export const bday = (md: string | null | undefined) => (md ? `${md.slice(3, 5)}.${md.slice(0, 2)}` : "—");
/** Сьогодні за Києвом, «РРРР-ММ-ДД». */
export const kyivToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

/** Модальне вікно (Esc і клік по тлу — закрити). */
export function Modal({ title, onClose, children, foot, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="zp-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`zp-modal ${wide ? "zp-modal--wide" : ""}`} role="dialog" aria-modal="true">
        <div className="zp-row"><h3 className="zp-grow">{title}</h3><button className="zp-btn zp-btn--ghost zp-btn--sm" onClick={onClose} aria-label="Закрити">✕</button></div>
        {children}
        {foot && <div className="zp-row">{foot}</div>}
      </div>
    </div>
  );
}

export function Field({ label, req, hint, children, err }: { label: ReactNode; req?: boolean; hint?: ReactNode; children: ReactNode; err?: string | null }) {
  return (
    <label className="zp-field">
      <span>{label}{req && <span className="req"> *</span>}</span>
      {children}
      {hint && <span className="zp-hint">{hint}</span>}
      {err && <span className="zp-err">{err}</span>}
    </label>
  );
}

/** Сегментований перемикач (місяць аналітики, «з якого місяця діє»). */
export function Seg<K extends string>({ items, value, onChange, disabled }: { items: Array<[K, ReactNode]>; value: K; onChange: (k: K) => void; disabled?: boolean }) {
  return (
    <div className="zps-seg" role="group">
      {items.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={k === value} disabled={disabled} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}
