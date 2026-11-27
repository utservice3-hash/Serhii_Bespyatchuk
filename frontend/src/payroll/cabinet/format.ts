/**
 * Кабінет «Моя зарплата» — спільні функції вкладок: дати в стилі макета, множина, «як виплачено», статуси авансу.
 * Дати рушія — київські рядки «РРРР-ММ-ДД» / «РРРР-ММ-ДДTГГ:ХХ»; дати з БД (`paidAt` виплат, заявок) — ISO з часовою зоною.
 */
import type { Obj } from "../api";
import { money, type Tone } from "../ui";

/**
 * Якір блоку «Аванс» у кабінеті. НЕ «adv»: у RuAdList (стандартний список блокувальників реклами в укр/рос браузерах)
 * є загальне правило `###adv` — блок із кнопкою заявки зникав у менеджерів з блокувальником (25.11.2026). Тримає #10940.
 */
export const ADVANCE_BLOCK_ID = "zc-avans";
/** Старі посилання сповіщень (`focus=adv`) → новий якір. */
export const FOCUS_ALIAS: Record<string, string> = { adv: ADVANCE_BLOCK_ID };
export const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const MONTHS_LOC = ["січні", "лютому", "березні", "квітні", "травні", "червні", "липні", "серпні", "вересні", "жовтні", "листопаді", "грудні"];
/** «2026-11» → «листопада» */
export const monthGen = (mk: string) => MONTHS_GEN[+mk.slice(5, 7) - 1] ?? mk;
/** «2026-11» → «листопад» */
export const monthLow = (mk: string) => (MONTHS[+mk.slice(5, 7) - 1] ?? mk).toLowerCase();
/** «2026-11» → «листопаді» */
export const monthLoc = (mk: string) => MONTHS_LOC[+mk.slice(5, 7) - 1] ?? mk;
/** «2026-11» → «лис» */
export const monthShort = (mk: string) => (MONTHS[+mk.slice(5, 7) - 1] ?? mk).slice(0, 3).toLowerCase();
/** Рядок рушія або ISO → «20.11». ISO з зоною переводимо в Київ. */
export function dd(s: string | null | undefined): string {
  if (!s) return "—";
  if (/[zZ]|[+-]\d\d:\d\d$/.test(s)) return new Date(s).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" });
  return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
}
/** «20.11.2026» */
export const ddy = (s: string | null | undefined) => (s ? `${dd(s)}.${s.slice(0, 4)}` : "—");
/** «20.11 15:10» */
export function dt(s: string | null | undefined): string {
  if (!s) return "—";
  if (/[zZ]|[+-]\d\d:\d\d$/.test(s)) {
    const d = new Date(s);
    return `${dd(s)} ${d.toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" })}`;
  }
  return dd(s) + (s.length > 10 ? ` ${s.slice(11, 16)}` : "");
}
export const lastDay = (mk: string) => new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)).getUTCDate();
export const nf = (n: number) => Math.round(n).toLocaleString("uk-UA").replace(/\s/g, " ");
export const pc = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${String(Math.round(x * 10) / 10).replace(".", ",")} %`);
export const ceilE = (x: number) => Math.ceil(x - 1e-9);
/** Нове правило днів народження діє для місяця mk (задача 10723, з листопада 2026: фонд 100 ₴ з кожного щомісяця, без збору на іменинника). */
export const bdayV2 = (S: Obj | null | undefined, mk: string | null | undefined) => !!(S?.birthday?.v2From && mk && mk >= S.birthday.v2From);
export const levelName = (lv: string | null | undefined) => (lv === "profi" ? "«Профі»" : lv === "start" ? "«Старт»" : "без рівня");

/** Як виплачено / як подано: «готівкою 1 000 ₴ і на карту •••• 1111 — 5 000 ₴». */
export function payHow(f: Obj | null | undefined): string {
  if (!f) return "—";
  const cards = ((f.cards ?? []) as Obj[]).filter((c) => Number(c.amount));
  const tail = (c: Obj) => String(c.last4 ?? String(c.no ?? "").slice(-4));
  const parts: string[] = [];
  const bank = (c: Obj) => (c.bank ? ` · ${c.bank}` : "");
  if (cards.length === 1 && !Number(f.cash)) return `на карту •••• ${tail(cards[0])}${bank(cards[0])}`;
  cards.forEach((c) => parts.push(`•••• ${tail(c)}${bank(c)} — ${money(c.amount)}`));
  if (Number(f.cash)) parts.push(`готівкою ${money(f.cash)}`);
  return parts.length ? parts.join(", ") : "—";
}

export const ADV_STATUS: Record<string, [string, Tone]> = {
  pending: ["Чекає погодження ОД", "warn"], requested: ["Подано", "warn"], paid: ["Схвалено", "ok"], rejected: ["Відхилено", "danger"], cancelled: ["Скасовано", "muted"],
};

/** «15 % від маржі «Успішно реалізовано» 33 400 ₴» — правило ліміту авансу. */
export function limitRule(L: Obj | null | undefined): string {
  if (!L) return "";
  const basis = L.basis === "margin" ? "маржі «Успішно реалізовано»" : L.basis === "ownMargin" ? "вашої маржі «Успішно реалізовано»" : L.basis === "teamMargin" ? "маржі команди" : "ставки";
  return `${L.pct} % від ${basis} ${money(L.base)}`;
}

/** Хто й коли запланував зміну рівня (`me.levelChangeInfo`): «ваш вибір, 04.11» / «рішення керівництва — Сергій, 04.11» / «автоматично». */
export function levelWho(info: Obj | null | undefined): string {
  if (!info) return "";
  if (info.auto) return "автоматично";
  const at = info.at ? dd(String(info.at)) : "";
  if (info.reason === "вибір менеджера") return `ваш вибір${at ? `, ${at}` : ""}`;
  return `рішення керівництва${info.by ? ` — ${info.by}` : ""}${at ? `, ${at}` : ""}`;
}
