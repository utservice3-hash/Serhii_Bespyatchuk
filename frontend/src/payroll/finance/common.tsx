/**
 * 💰 Спільні компоненти фінансових вкладок «Зарплати» (Перевірка, Нарахування, Аванси, Відомість): рівень, клітинки
 * ТТН і авансу, перемикач місяця, підзаголовок. Функції форматування — у `fmt.ts`.
 */
import type { ReactNode } from "react";
import type { Obj } from "../api";
import { money, monthTitle, pct, Pill, type Tone } from "../ui";
import { ADV_STATUS, LEVEL } from "./fmt";
import "./finance.css";

export function LevelTag({ level }: { level: string | null | undefined }) {
  if (!level) return null;
  return <Pill tone={level === "profi" ? "violet" : "muted"}>{LEVEL[level] ?? level}</Pill>;
}

/** ТТН: частка угод з ТТН (на закриття потрібно від minPct). */
export function TtnCell({ ttn, minPct = 70 }: { ttn: Obj | null | undefined; minPct?: number }) {
  if (!ttn) return <span className="zp-muted">—</span>;
  if (!ttn.total) return <span className="zp-muted" title="угод ще немає">—</span>;
  const ok = Number(ttn.pct) >= minPct;
  return (
    <span title={ok ? "норма" : `менше ${minPct} % — утримання до закриття ТТН`}>
      <span className={ok ? "" : "zp-tone--warn"}>{pct(ttn.pct, 1)}</span>
      <div className="zp-hint">{ttn.done} з {ttn.total}</div>
    </span>
  );
}

/** Аванс у таблиці: сума + стан. */
export function AdvCell({ a }: { a: Obj | null | undefined }) {
  if (!a) return <span className="zp-muted">—</span>;
  const [label, tone] = ADV_STATUS[a.status] ?? [a.status, "muted" as Tone];
  return <span>{money(a.amount)}<div className={`zp-hint zp-tone--${tone}`}>{label}</div></span>;
}

/** Перемикач місяця: закритий («закриття») і поточний («іде»). */
export function MonthSwitch({ months, value, onChange, live }: { months: string[]; value: string; onChange: (m: string) => void; live: string }) {
  if (months.length < 2) return <span className="zp-month">{monthTitle(value)} · {value === live ? "іде" : "закриття"}</span>;
  return (
    <div className="zp-tabs zp-tabs--sm" role="group" aria-label="Місяць">
      {months.map((m) => (
        <button key={m} type="button" className={`zp-tab ${m === value ? "is-active" : ""}`} aria-pressed={m === value} onClick={() => onChange(m)}>
          {monthTitle(m)} · {m === live ? "іде" : "закриття"}
        </button>
      ))}
    </div>
  );
}

/** Підзаголовок-розділювач у вікні («РОЗРАХУНОК: АВТОМАТИЧНО З ЯДРА → ІСТИННЕ»). */
export function Lbl({ children }: { children: ReactNode }) { return <div className="zp-k zf-lbl">{children}</div>; }
