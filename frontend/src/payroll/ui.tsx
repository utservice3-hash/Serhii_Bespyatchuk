/**
 * 💰 «Зарплата» — спільні дрібниці екранів: гроші, місяці, статуси, картки, завантаження. Кольори — змінні дашборда
 * (`--text`, `--card-bg`, `--border`…), тож темна тема працює сама. Класи — з префіксом `zp-` (payroll.css).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errText } from "./api";

const nf = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
/** 13 240 ₴ (мінус — справжнім мінусом). Невідоме — «—». */
export function money(n: unknown, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || n === "" || !Number.isFinite(Number(n))) return "—";
  const v = Math.round(Number(n));
  const s = nf.format(Math.abs(v)).replace(/ /g, " ");
  return `${v < 0 ? "−" : opts.sign && v > 0 ? "+" : ""}${s} ₴`;
}
export const num = (n: unknown): string => (Number.isFinite(Number(n)) ? nf.format(Math.round(Number(n))).replace(/ /g, " ") : "—");
/** Відсотки рушія — цілі числа (10 = 10 %), конверсія — теж у відсотках (17.1). */
export const pct = (x: unknown, digits = 0): string => (Number.isFinite(Number(x)) ? `${Number(x).toFixed(digits).replace(".", ",")} %` : "—");

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
/** «2026-11» → «Листопад 2026». */
export function monthTitle(mk: string | null | undefined): string {
  if (!mk) return "—";
  const [y, m] = mk.split("-").map(Number);
  const name = MONTHS[m - 1] ?? mk;
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}
/** «2026-12-06» → «6 грудня»; з часом — «03.12 17:20». */
export function dayTitle(d: string | null | undefined): string {
  if (!d) return "—";
  const [, m, dd] = d.slice(0, 10).split("-").map(Number);
  return `${dd} ${MONTHS_GEN[m - 1] ?? ""}`.trim();
}
export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10).split("-").reverse().slice(0, 2).join(".");
  const k = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
  return k.replace(",", "");
}
export const prevMonth = (mk: string) => { const [y, m] = mk.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
export const nextMonth = (mk: string) => { const [y, m] = mk.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };

/** Статуси розрахункового листа (`RECORD_FLOW` рушія) — підпис і тон пігулки. */
export const RECORD_STATUS: Record<string, [string, Tone]> = {
  review: ["Перевірити", "warn"],
  verified: ["Чекає згоди", "info"],
  disputed: ["Не погоджується", "danger"],
  agreed: ["Чекаємо форму", "violet"],
  submitted: ["Форму подано", "ok"],
  paid: ["Виплачено", "ok"],
};
export type Tone = "ok" | "warn" | "danger" | "info" | "violet" | "muted";
export function Pill({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`zp-pill zp-pill--${tone}`} title={title}>{children}</span>;
}
export function StatusPill({ status }: { status: string }) {
  const [label, tone] = RECORD_STATUS[status] ?? [status, "muted" as Tone];
  return <Pill tone={tone}>{label}</Pill>;
}

export function Card({ title, aside, children, className = "", pad = true }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`zp-card ${pad ? "" : "zp-card--flush"} ${className}`}>
      {(title || aside) && <header className="zp-card__head"><h3>{title}</h3>{aside && <div className="zp-card__aside">{aside}</div>}</header>}
      {children}
    </section>
  );
}
export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`zp-stat ${tone ? `zp-stat--${tone}` : ""}`}>
      <div className="zp-stat__label">{label}</div>
      <div className="zp-stat__value">{value}</div>
      {sub && <div className="zp-stat__sub">{sub}</div>}
    </div>
  );
}
/** Порожній стан — словами, а не порожнім місцем (правило фронту «невідоме читається як невідоме»). */
export function Empty({ children }: { children: ReactNode }) { return <div className="zp-empty">{children}</div>; }
export function Muted({ children }: { children: ReactNode }) { return <span className="zp-muted">{children}</span>; }

/** Рядок «підпис … сума» для розкладів («З чого складається», підсумок місяця). */
export function Line({ label, sub, value, tone, strong }: { label: ReactNode; sub?: ReactNode; value: ReactNode; tone?: Tone; strong?: boolean }) {
  return (
    <div className={`zp-line ${strong ? "zp-line--strong" : ""}`}>
      <div><div className="zp-line__label">{label}</div>{sub && <div className="zp-line__sub">{sub}</div>}</div>
      <div className={`zp-line__value ${tone ? `zp-tone--${tone}` : ""}`}>{value}</div>
    </div>
  );
}

/** Вкладки-перемикач (у стилі дашборда). */
export function Tabs<K extends string>({ items, value, onChange, small }: { items: Array<{ key: K; label: ReactNode; badge?: number }>; value: K; onChange: (k: K) => void; small?: boolean }) {
  return (
    <div className={`zp-tabs ${small ? "zp-tabs--sm" : ""}`} role="tablist">
      {items.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} className={`zp-tab ${t.key === value ? "is-active" : ""}`} onClick={() => onChange(t.key)}>
          {t.label}{t.badge ? <span className="zp-tab__badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Завантаження з помилкою й перезапитом: `const { data, err, loading, reload } = useLoad(() => payrollApi.me(), [])`. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setErr(null);
    try { const d = await fn(); if (my === seq.current) setData(d); }
    catch (e) { if (my === seq.current) setErr(errText(e)); }
    finally { if (my === seq.current) setLoading(false); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, loading, reload, setData };
}
export function Loading({ err, onRetry }: { err?: string | null; onRetry?: () => void }) {
  if (err) return <div className="zp-error">{err}{onRetry && <button className="zp-btn zp-btn--ghost" onClick={onRetry}>Спробувати ще</button>}</div>;
  return <div className="zp-loading">Завантаження…</div>;
}

/** Зберегти файл (Excel відомості / авансів). */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Файл → data URL (скріншоти обхідного, імпорт архіву). */
export function readDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}
