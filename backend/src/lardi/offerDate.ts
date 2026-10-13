/**
 * 📅 ДАТА ПРОПОЗИЦІЇ LARDI → «YYYY-MM-DD» за Києвом (13.10.2026). Lardi віддає `dateFrom` ЧИСЛОМ у мілісекундах
 * (`1791849600000`), а код різав його `slice(0, 10)` — і в колонці «Дата» стояло «1791849600». Так записано весь
 * архів `lardi_offers.dt` (секунди рядком), тож розбір один на обидва джерела: живу відповідь і архів.
 * Невідоме — порожній рядок, а не вигадана дата.
 */
const KYIV_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" });

export function offerDate(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (!/^\d{9,13}$/.test(s)) return "";
  const n = Number(s);
  // ≥ 1e11 — мілісекунди (живий Lardi); менше — секунди (архів до 13.10.2026).
  const ms = n >= 1e11 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : KYIV_DAY.format(d);
}
