/**
 * 🎨 СПІЛЬНЕ ДЛЯ ЕКРАНА «РЕКЛАМА» — стилі, формати й підказки, якими користуються `AdsSection` і `AdsCampaigns`.
 * Винесено 11.11.2026 разом із вкладкою кампаній (#8709): одна редакція підпису/порогу, а не дві копії.
 */

/* Числа ПРАВОРУЧ — не смак: числа різної довжини, вирівняні ліворуч, неможливо
   порівнювати оком по стовпчику. */
export const TH: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: ".9px", textTransform: "uppercase",
  color: "var(--rpt-muted, #8a8f98)", textAlign: "right", padding: "0 14px 10px", whiteSpace: "nowrap",
};
export const TH_L: React.CSSProperties = { ...TH, textAlign: "left" };
export const TD: React.CSSProperties = {
  textAlign: "right", padding: "12px 14px",
  borderTop: "1px solid var(--rpt-line, #e8e6e3)", whiteSpace: "nowrap",
};
export const TD_L: React.CSSProperties = { ...TD, textAlign: "left" };
export const LAB: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: ".9px", textTransform: "uppercase",
  color: "var(--rpt-muted, #8a8f98)",
};
export const BIG: React.CSSProperties = { fontSize: 38, fontWeight: 800, letterSpacing: "-1.4px", lineHeight: 1.05, marginTop: 10 };
export const UNIT: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--rpt-ink-soft, #3f434b)", letterSpacing: 0 };
export const DIM: React.CSSProperties = { color: "var(--rpt-muted, #8a8f98)" };
export const CARD: React.CSSProperties = {
  background: "var(--rpt-card, #fff)", border: "1px solid var(--rpt-line, #e8e6e3)", borderRadius: 14,
};
export const STRIP: React.CSSProperties = {
  fontSize: 12, color: "var(--rpt-muted, #8a8f98)", background: "var(--rpt-soft, #f6f5f3)",
  padding: "10px 20px", borderTop: "1px solid var(--rpt-line, #e8e6e3)",
  borderBottom: "1px solid var(--rpt-line, #e8e6e3)",
};

export const money = (n: number) => n.toLocaleString("uk-UA", { maximumFractionDigits: 0 });
/** `2026-07-14` → `14.07`. Рік зайвий: період обрано зверху. */
export const dayLabel = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}` : iso;
};
/** «× до витрат» — у скільки разів маржа більша за витрати; без витрат — нічого не ділимо. */
export const times = (earned: number, cost: number) => (cost > 0 ? `×${(earned / cost).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}` : null);

/**
 * 💰 #8702 (зустріч 09.11.2026, Сергій: «надходження грошей привʼязуємо до місяця створення угоди»). Гроші ліда йдуть
 * у день, коли лід ПРИЙШОВ, а не коли закрилась угода — тож число минулого місяця ще росте, поки його угоди в роботі.
 */
export const HINT_EARNED = "Заробили ліди: маржа угод з реклами, створених у цей день/період, які вже оплачені («Успішно» або «Оплата отримана»), "
  + "хоч би коли надійшли гроші. Показує, чи окупилась реклама саме цього періоду. Число росте, поки угоди в роботі — "
  + "«дозріло» каже, по скількох лідах уже є результат.";

/**
 * Ключ кампанії: без хвоста дати перейменування («…_TochkaB 19/06», «… 11.01»), пробіли й «_» — одне («Gruzoperevozky
 * UKR _TochkaB» у Google = «Gruzoperevozky_UKR_TochkaB» у мітці угоди, замір 11.11.2026), без регістру.
 */
export const campKey = (name: string) => name.trim()
  .replace(/\s+\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?$/, "")
  .replace(/[\s_]+/g, "_")
  .toLowerCase();
