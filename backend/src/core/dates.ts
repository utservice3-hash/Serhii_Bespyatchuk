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
