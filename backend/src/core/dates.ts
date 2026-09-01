// ─────────────────────────── ДАТИ (core) ───────────────────────────
// Спільні календарні хелпери — ЄДИНЕ джерело для роутів і core-метрик. Раніше жили
// інлайн у routes/dashboard.ts; винесено в core, щоб «Плани» (і будь-хто) реюзали ту
// саму логіку робочих днів / меж тижня / місяців БЕЗ дублювання. Усе date-only (UTC),
// TZ-незалежне — вхід/вихід рядки 'YYYY-MM-DD'.

/** Місяці (перше число) у діапазоні [from,to] по-київськи — для помісячних core-серій. */
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split("-").map(Number);
  const end = to.slice(0, 7);
  let y = fy, m = fm;
  for (let i = 0; i < 60; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym + "-01");
    if (ym >= end) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// РЕАЛЬНІ календарні тижні Пн–Нд (ISO), обрізані по місяцю: Т1 = 1-ше число → перша
// неділя (частковий), далі повні Пн–Нд, останній — до кінця місяця (частковий). К-ть
// тижнів = 5 або 6 (НЕ фіксовано). ЄДИНЕ джерело меж тижня для всіх споживачів.
// День тижня календарної дати — TZ-незалежний (date-only), рахуємо через Date.UTC.
export function fixedWeekBlocks(monthStart: string): { idx: number; from: string; to: string }[] {
  const ym = monthStart.slice(0, 7);
  const [y, mo] = ym.split("-").map(Number);
  const dim = new Date(y, mo, 0).getDate();
  const pad = (d: number) => String(d).padStart(2, "0");
  const isoDow = (day: number) => { const w = new Date(Date.UTC(y, mo - 1, day)).getUTCDay(); return w === 0 ? 7 : w; }; // Пн=1..Нд=7
  const blocks: { idx: number; from: string; to: string }[] = [];
  let cursor = 1, idx = 1;
  while (cursor <= dim) {
    const end = Math.min(cursor + (7 - isoDow(cursor)), dim); // до найближчої неділі АБО кінця місяця
    blocks.push({ idx, from: `${ym}-${pad(cursor)}`, to: `${ym}-${pad(end)}` });
    cursor = end + 1; idx++;
  }
  return blocks;
}

/**
 * 🗓 ТИЖНЕВІ БЛОКИ, ЩО ПОКРИВАЮТЬ ДОВІЛЬНИЙ ДІАПАЗОН (20.08.2026).
 *
 * Ті самі Пн–Нд, що й `fixedWeekBlocks`, але обрізані межами ДІАПАЗОНУ, а не місяця.
 * Для повного місяця обидві функції дають БАЙТ-У-БАЙТ однакові блоки (межа місяця і є
 * межею діапазону) — саме тому заміна безпечна там, де раніше стояв місяць.
 *
 * 🔴 НАВІЩО ОКРЕМА ФУНКЦІЯ, А НЕ ПРАВКА `fixedWeekBlocks`. Та живить заморожені
 * знімки тижневого плану (`weekly_plan_snapshots`), де блок ЗОБОВʼЯЗАНИЙ бути
 * місячним: знімок кріпиться до понеділка всередині свого місяця. Розширити її
 * означало б заднім числом зрушити ключі вже заморожених тижнів.
 */
export function weekBlocksForRange(from: string, to: string): { idx: number; from: string; to: string }[] {
  const blocks: { idx: number; from: string; to: string }[] = [];
  const end = new Date(to + "T00:00:00Z");
  const cur = new Date(from + "T00:00:00Z");
  for (let idx = 1; cur.getTime() <= end.getTime() && idx <= 200; idx++) {
    const dow = cur.getUTCDay() === 0 ? 7 : cur.getUTCDay();   // Пн=1..Нд=7
    const stop = new Date(cur.getTime());
    stop.setUTCDate(stop.getUTCDate() + (7 - dow));            // найближча неділя
    const clipped = stop.getTime() > end.getTime() ? end : stop;
    blocks.push({ idx, from: cur.toISOString().slice(0, 10), to: clipped.toISOString().slice(0, 10) });
    cur.setTime(clipped.getTime());
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return blocks;
}

/** Робочі дні (Пн–Пт) у [from,to] включно. */
export function workingDaysBetween(from: string, to: string): number {
  let n = 0; const d = new Date(from + "T00:00:00Z"); const end = new Date(to + "T00:00:00Z");
  while (d.getTime() <= end.getTime()) { const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) n++; d.setUTCDate(d.getUTCDate() + 1); }
  return n;
}

/** Останній день місяця `mo` ('YYYY-MM' або 'YYYY-MM-01') → 'YYYY-MM-DD'. */
export function monthEndOf(mo: string): string {
  const [y, mm] = mo.split("-").map(Number);
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
}

/**
 * Сьогоднішня дата ЗА КИЄВОМ, `YYYY-MM-DD`.
 *
 * 🔴 ЖИВЕ ТУТ, БО КОПІЙ УЖЕ ТРИ (`ai/oracle.ts`, `jobs/evaluateKpiTasks.ts` і
 * далі), і четверта — це той самий спосіб, яким у нас народжувалась друга копія
 * правила. Нові споживачі беруть звідси; старі перевести окремою правкою, бо це
 * зміна поведінки в місцях, які цим проходом не приймаються.
 *
 * ⚠️ `sv-SE` дає рівно `YYYY-MM-DD` — саме тому він, а не `toISOString()`, який
 * віддає UTC і в Києві до 03:00 показує ВЧОРАШНЮ добу.
 */
export function kyivToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

/**
 * 🇺🇦 МЕЖІ ПОТОЧНОГО МІСЯЦЯ ЗА КИЄВОМ — один вираз на всіх.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ. Гейти рахували місяць через `getUTCFullYear/getUTCMonth`
 * (29 місць), а продукт живе по-київськи. Прогін о 21:07 UTC = 00:07 EEST питав
 * про СЕРПЕНЬ і вимагав, щоб той був поточним; продукт правий — серпень уже не
 * поточний, вересень так. Тобто гейт червонів від власного календаря.
 * Дві копії правила про час — це майбутнє розходження, і воно в нас уже було.
 */
export function kyivMonthBounds(today: string = kyivToday()): { ym: string; from: string; to: string } {
  const ym = today.slice(0, 7);
  return { ym, from: `${ym}-01`, to: monthEndOf(ym) };
}

/**
 * 🗓 ВІКНО ЗАВЕДЕННЯ ПЛАНІВ — доменний факт власника, дослівно: «плани у нас
 * виставляються на протязі 2х днів, це норма».
 *
 * 🔴 ЧОМУ ЦЕ НЕ ЗВИЧАЙНИЙ ПОРОЖНІЙ ПЕРІОД. Глухий скіп «планів немає» сховав би
 * аварію «плани ЗАБУЛИ завести»: різниця між нормою і аварією тут не в даних, а в
 * ДАТІ. Тому перші `workdays` робочих днів місяця — скіп, а після вікна нуль
 * планів це СПРАВЖНЄ червоне.
 */
export function withinPlanGrace(today: string = kyivToday(), workdays = 2): boolean {
  const monthStart = `${today.slice(0, 7)}-01`;
  return workingDaysBetween(monthStart, today) <= workdays;
}

/**
 * Чи існує така календарна дата. `new Date("2026-09-31")` не кидає — воно
 * НОРМАЛІЗУЄ у 1 жовтня; тому порівнюємо зворотний рядок, а не ловимо виняток.
 */
export function isRealDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}
