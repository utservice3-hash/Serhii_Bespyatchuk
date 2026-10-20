/**
 * 💸 ЕКРАН «ОПЛАТИ ПЕРЕВІЗНИКАМ» («Фінанси», 16.10.2026) — чиста логіка без БД. Рішення системи беруться з журналу
 * `payment_file_log` (джоба `buildPaymentFile`), реквізити й статус — з Kommo в мить відкриття (картки в базі не лежать).
 *
 * Розбіжність — те, що ми 15.10 звіряли з Тетяною руками: система сказала «перевірити», а запит уже закрито «Оплачено»,
 * або сказала «до оплати», а запит відмовлено. «До оплати» + ще висить — не розбіжність (Тетяна ще не дійшла).
 */
import { cardOf, PAY_CATEGORY } from "./paymentRun.js";

export type KommoState = "paid" | "rejected" | "open";
export const kommoStateOf = (statusId: number | null | undefined): KommoState =>
  statusId === 142 ? "paid" : statusId === 143 ? "rejected" : "open";
export const discrepancyOf = (ok: boolean, k: KommoState): boolean => (!ok && k === "paid") || (ok && k === "rejected");

export interface ScreenRow {
  mainId: number | null; requestId: number; createdAt: string | null; amount: number | null;
  ok: boolean; paidBy: string | null; reasons: string[]; notes: string[];
  card: string; owner: string; category: string; kommo: KommoState; diff: boolean;
  /** Етап запиту у воронці «Оплата перевозчикам» словами («Заявка на оплату», «Оплачено»…) — де Тетяна його закриває. */
  stage: string;
  /** Запит у фільтрі, якого прогін ще не бачив (подали після останнього :40) — рішення немає. */
  pending?: boolean;
}

/**
 * «Закрити в Kommo» (Роман 16.10.2026: «рядок з угодою, де саме треба змінити етап на оплату — щоб Таня просто клікала»):
 * затверджені системою запити, які ще не переведені в «Оплачено» і не відмовлені. Система сама нічого не закриває —
 * лише показує, де клікнути.
 */
export const toCloseOf = (rows: readonly ScreenRow[]): ScreenRow[] => rows.filter((r) => r.ok && r.kommo === "open");

/** Рядок для Таниного файлу «Обработка выгрузки»: ID | Номер карти | Власник карти | Сума | Категорії. */
export const fileRow = (r: ScreenRow): (string | number)[] => [r.mainId ?? "", r.card, r.owner, r.amount ?? 0, r.category || PAY_CATEGORY];

/** «Копіювати для файлу»: лише затверджені, табуляцією — вставляється в Google-таблицю рівно в її колонки. */
export const clipboardTsv = (rows: readonly ScreenRow[]): string =>
  rows.filter((r) => r.ok).map((r) => fileRow(r).map((v) => String(v).replace(/[\t\n\r]+/g, " ")).join("\t")).join("\n");

/** Номер картки для екрана — у форматі файлу; не 16 цифр — як вніс менеджер (щоб було видно, що з ним не так). */
export const screenCard = (raw: string | null | undefined): string => cardOf(raw) ?? (raw ?? "").trim();

export interface ScreenTotals { total: number; ok: number; okSum: number; check: number; diff: number; toClose: number }
export function totalsOf(rows: readonly ScreenRow[]): ScreenTotals {
  const ok = rows.filter((r) => r.ok);
  return { total: rows.length, ok: ok.length, okSum: Math.round(ok.reduce((a, r) => a + (r.amount ?? 0), 0) * 100) / 100,
    check: rows.length - ok.length, diff: rows.filter((r) => r.diff).length, toClose: toCloseOf(rows).length };
}

/** Підсумки екрана за фільтром (16.10.2026): «у фільтрі зараз» — головне; «архів» — що вже вийшло з фільтра за день. */
export interface ScreenSplit { active: number; activeOk: number; activeOkSum: number; activeCheck: number; pending: number; archive: number; diff: number }
export function splitTotals(active: readonly ScreenRow[], archive: readonly ScreenRow[]): ScreenSplit {
  const ok = active.filter((r) => r.ok);
  return { active: active.length, activeOk: ok.length, activeOkSum: Math.round(ok.reduce((a, r) => a + (r.amount ?? 0), 0) * 100) / 100,
    activeCheck: active.filter((r) => !r.ok && !r.pending).length, pending: active.filter((r) => r.pending).length,
    archive: archive.length, diff: archive.filter((r) => r.diff).length };
}

/**
 * 🗓 ДЕНЬ АРХІВУ (Тетяна через Романа 20.10.2026: «в архів сьогоднішнього дня мають попадати усі закриті запити цього ж
 * дня»). Закритий у Kommo запит («Оплачено» / «Отказано») — у день ЗАКРИТТЯ за Києвом, хоч би коли його подали (поданий
 * 19.10 о 17:06 і закритий о 17:07 — це 19.10, а не файл 20.10). Запит, що вийшов із фільтра без закриття (переїхав в
 * інший етап), закриття не має — лишається в дні свого файлу, щоб нічого не зникло.
 */
export function archiveDayOf(closedAtUnix: number | null | undefined, fileDay: string): string {
  if (!closedAtUnix) return fileDay;
  return new Date(closedAtUnix * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}
