/**
 * 💰 Фінансові вкладки «Зарплати» — чисті функції форматування й підписи. Окремо від компонентів (`common.tsx`), щоб
 * не ламати fast refresh. Поля — рівно як їх віддає `backend/src/payroll/service.ts`.
 */
import { money, type Tone } from "../ui";

/** Дата-час рушія — київський рядок «РРРР-ММ-ДДTГГ:ХХ» без поясу (kyivIso) або ISO з поясом (історія). → «03.12 17:20». */
export function dt(s: string | null | undefined): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s.slice(0, 16));
  if (m && !/[zZ+]/.test(s.slice(16))) return `${m[3]}.${m[2]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d).replace(",", "");
}
/** «2026-12-06» → «06.12». */
export const dd = (s: string | null | undefined): string => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : "—");

const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MONTHS_LOW = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
/** «2026-11» → «листопада». */
export const monthGen = (mk: string) => MONTHS_GEN[Number(mk.slice(5, 7)) - 1] ?? mk;
/** «2026-11» → «листопад». */
export const monthLow = (mk: string) => MONTHS_LOW[Number(mk.slice(5, 7)) - 1] ?? mk;
/** «2026-12-06» → «6 грудня». */
export const dayGen = (s: string) => `${Number(s.slice(8, 10))} ${monthGen(s.slice(0, 7))}`;

export const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};

/** Рівень менеджера → підпис. */
export const LEVEL: Record<string, string> = { start: "Старт", profi: "Профі" };
/** Коротко: «Менеджер · Профі» / «Тім-лід» / посада. */
export function shortRole(x: { role?: string; level?: string | null; title?: string | null }): string {
  if (x.role === "manager") return `Менеджер · ${LEVEL[x.level ?? ""] ?? "рівень не задано"}`;
  if (x.role === "lead") return "Тім-лід";
  return x.title || "Ставка";
}

/** Сума зі знаком або «—», якщо нуль (ДН, ±). */
export const signed = (v: unknown): string => (Number(v) ? money(Number(v), { sign: true }) : "—");
export const signTone = (v: unknown): Tone | undefined => (Number(v) < 0 ? "danger" : Number(v) > 0 ? "ok" : undefined);

/** Стан заявки на аванс → підпис і тон. */
export const ADV_STATUS: Record<string, [string, Tone]> = { requested: ["заявка", "warn"], paid: ["виплачено", "ok"], rejected: ["відхилено", "danger"] };

/** Число з поля (пробіли, кома, ₴, %). null — порожньо; NaN — помилка. */
export function parseNum(s: string): number | null {
  const t = s.replace(/\s/g, "").replace(",", ".").replace(/[₴%]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
