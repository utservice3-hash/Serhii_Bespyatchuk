/**
 * 🛑 ДВА ПРАВИЛА ЛІМІТІВ КЛІЄНТІВ (рішення Романа 03.11.2026) — чисті функції, без БД (БД — `limitRulesDb.ts`).
 *
 * 1. ЗМІНИВСЯ ВЛАСНИК / ДИРЕКТОР → ліміт зупиняється до переузгодження Сергієм. «Змінився» = у засновниках чи бенефіціарах
 *    з'явилась або зникла людина, або інший директор. Зміна частки в тих самих людей — лише позначка «зміни в YouControl».
 *    Є попередня перевірка — порівнюємо з нею. Немає (перша перевірка коду) — зупиняємо, лише якщо дата зміни в ЄДР пізніша
 *    за дату ліміту: зміна до погодження — це стан, з яким Сергій погоджував.
 * 2. 3 МІСЯЦІ БЕЗ УГОД → ліміт скидається, потрібен новий запит. Від останньої створеної угоди клієнта, крім програних (143);
 *    угод немає — від дати ліміту. Поки є борг — не скидаємо. Клієнта не зіставлено з CRM — не скидаємо (угод не видно, а
 *    вони можуть бути), рядок підписано «перевірте вручну».
 */
import type { CheckSubject } from "./shared/cpCheck.js";
import { ownerKey } from "./server/youscore/parse.js";

const names = (xs: string[]) => new Map(xs.map((n) => [n.trim().toLowerCase(), n.trim()]));
const diff = (a: Map<string, string>, b: Map<string, string>) => ({
  came: [...b].filter(([k]) => !a.has(k)).map(([, n]) => n),
  gone: [...a].filter(([k]) => !b.has(k)).map(([, n]) => n),
});
const line = (what: string, d: { came: string[]; gone: string[] }) =>
  d.came.length || d.gone.length ? `${what}: ${[...d.came.map((n) => `увійшов ${n}`), ...d.gone.map((n) => `вийшов ${n}`)].join(", ")}` : "";

/** Що змінилось у людях клієнта після погодження ліміту; null — нічого (або ФОП, або даних про власників немає). */
export function peopleChange(prev: CheckSubject | null, cur: CheckSubject, limitAt: string): string | null {
  const o = cur.own;
  if (cur.fop || !o) return null;
  const po = prev && !prev.fop ? prev.own : null;
  const out: string[] = [];
  if (po) {
    // порожній список у свіжій перевірці при непорожньому в попередній — YouScore не віддав власників, а не «всі вийшли»
    if (o.owners.length || !po.owners.length) {
      out.push(line("власники", diff(new Map(po.owners.map((x) => [ownerKey(x), x.name])), new Map(o.owners.map((x) => [ownerKey(x), x.name])))));
    }
    if (o.bens.length || !po.bens.length) out.push(line("бенефіціари", diff(names(po.bens), names(o.bens))));
    const pd = po.director?.name.trim() || "", cd = o.director?.name.trim() || "";
    if (pd && cd && pd.toLowerCase() !== cd.toLowerCase()) out.push(`директор: ${pd} → ${cd}`);
  } else {
    const since = Date.parse(limitAt);
    if (o.peopleAt && Date.parse(o.peopleAt) > since) out.push(`власники: ${o.ownersWhat}`);
    if (o.dirAt && Date.parse(o.dirAt) > since) out.push(`директор: ${o.dirWhat}`);
  }
  const s = out.filter(Boolean).join("; ");
  return s || null;
}

export const INACTIVE_MONTHS = 3;
/** Та сама дата N календарних місяців тому; 31-ше в коротшому місяці — його останній день (без переповнення в наступний). */
export function monthsAgo(now: Date, n: number): Date {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() - n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(now.getUTCDate(), last), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
}
export interface ResetInput { matched: boolean; lastDealAt: string | null; limitAt: string; debt: number }
/** Чи скидати ліміт за неактивністю. */
export function resetDue(x: ResetInput, now: Date): boolean {
  if (!x.matched || x.debt > 0) return false;
  return Date.parse(x.lastDealAt ?? x.limitAt) < monthsAgo(now, INACTIVE_MONTHS).getTime();
}
