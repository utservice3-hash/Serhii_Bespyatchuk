import type { ReactNode } from "react";
import { InfoHint } from "../widgets";

/**
 * 📊 ЧОТИРИ СМУГИ ЗВІТУ (макет 06.08.2026) — спільні примітиви для рядка менеджера,
 * рядка команди й верхнього підсумку.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ. Смуга «ТЕМП І ПЛАН» малюється у ТРЬОХ місцях (менеджер,
 * команда, компанія). Три копії однієї шкали розійдуться мовчки — і тоді «-35.2 п.п.»
 * у рядку означатиме не те саме, що «-35.2 п.п.» у підсумку. Це рівно той клас
 * поломки, що ми ловили весь тиждень: два правильні числа під однією назвою.
 */

export const GREEN = "var(--rpt-ok)", AMBER = "var(--rpt-warn)", RED = "var(--rpt-bad)";
export const MUTED = "var(--rpt-muted)", INK = "var(--rpt-ink)";
export const SOFT = "var(--rpt-soft)", LINE = "var(--rpt-line)";

export const fmt = (n: number): string =>
  !Number.isFinite(n) ? "—" : (n === 0 ? "0" : Math.round(n).toLocaleString("uk-UA").replace(/,/g, " "));
export const kk = (n: number): string => (!Number.isFinite(n) ? "—" : Math.abs(n) >= 1000 ? Math.round(n / 1000) + "к" : String(Math.round(n)));
export const ddmm = (s: string): string => s.slice(8) + "." + s.slice(5, 7);

/** Порожнє значення читається як «—», а не як нуль: невідоме має читатись як невідоме. */
export const dash = (n: number, render: (x: number) => string = fmt): string => (n ? render(n) : "—");

/**
 * ⓘ ДЛЯ ТРЬОХ ЧИСЕЛ «СКІЛЬКИ ВИЙДЕ». Вони мусять зватись по-різному і пояснювати
 * себе — саме з однакових назв і почалась уся історія: «отримано» на одному екрані
 * означало ①, на іншому ②.
 */
export const HINTS = {
  closed: "«Закрито ①» — угоди, доведені до кінця (статус «успішно реалізовано», 142). "
    + "Анкер — дата закриття. Це РЕЗУЛЬТАТ менеджера: саме він іде в оцінку роботи.",
  paid: "«Прийшло ⑨» — гроші вже на рахунку, але угода ще НЕ переведена в «успішно реалізовано» "
    + "(стадія «оплата отримана»). Анкер — дата входу в стадію. Це не борг і не обіцянка: кошти в компанії.",
  fact: "«Факт ②» = Закрито ① + Прийшло ⑨, з дедупом (одна угода рахується РАЗ). "
    + "Саме від нього рахуються відсоток, світлофор, «треба ₴/день» і прогноз.",
  noDate: "Угоди в зоні очікування БЕЗ планової дати оплати. У ЖОДНУ суму не входять — "
    + "вони не належать жодному місяцю. Показані окремо, щоб не читались як «нема очікувань».",
  withInvoices: "«З рахунками» = Факт ② + рахунки з ПЛАНОВОЮ ДАТОЮ ОПЛАТИ в цьому місяці. "
    + "Це підкріплене документами: добір сюди НЕ входить.",
  byPace: "«За темпом» = факт ÷ робочі дні, що минули × усі робочі дні місяця. Це ЕКСТРАПОЛЯЦІЯ, "
    + "а не прогноз: на 4-й день місяця вона нестабільна, тому при перевищенні 150% плану стоїть «⚠ рано».",
  dobir: "«Зазвичай добирає» — СЕРЕДНЄ за 3 завершені місяці: скільки людина зазвичай "
    + "приносить угодами, створеними й закритими вже після цього числа. Це не угоди й не документи, "
    + "тому в прогноз НЕ входить. Розкладено на менеджерів за історичною часткою, тож Σ = відділу.",
  week: "Динамічний план тижня = залишок місяця × робочі дні цього тижня ÷ робочі дні від "
    + "початку тижня до кінця місяця. Базис — РОБОЧІ ДНІ, а не «тижні, що лишились»: інакше "
    + "останній тиждень місяця (буває одноденним) отримав би повну тижневу норму. "
    + "Ціль ФІКСУЄТЬСЯ в понеділок 00:00 за Києвом і всередині тижня не змінюється.",
  month: "Факт ② / план місяця. Мітка на смузі — частка робочих днів місяця, що минули. "
    + "⚠️ Відхилення в п.п. тижня й місяця НЕ порівнюються між собою: мітки стоять на різних "
    + "місцях, бо періоди різної довжини. Порівнювати можна лише «% від необхідного».",
  stuck: "Активні угоди повного циклу БЕЗ реальної людської активності понад поріг "
    + "(7 дн. — грошові стадії, 21 дн. — ранні). Активність — нотатки людини, не Salesbot.",
  expectAsOf: "Зона очікування — знімок «зараз» за поточною плановою датою оплати. "
    + "⚠️ Чесна межа: історії змін цього поля в CRM немає, тож за МИНУЛІ періоди стадію "
    + "відновлено на кінець періоду, а планову дату взято ПОТОЧНУ.",
} as const;

/** Смуга з міткою «де мав би бути» — ЄДИНА реалізація на всі три рівні. */
export function PaceBar({ pct, markPct, color }: { pct: number; markPct: number; color: string }) {
  return (
    <div style={{ position: "relative", height: 6, background: LINE, borderRadius: 3, margin: "5px 0 3px" }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", background: color, borderRadius: 3 }} />
      {/* Мітка темпу — вертикальна риска, а не другий колір: вона показує МІСЦЕ, не величину. */}
      <div title={`Мітка = ${Math.round(markPct)}% — де мав би бути за темпом`}
        style={{ position: "absolute", left: `${Math.min(100, Math.max(0, markPct))}%`, top: -3, width: 2, height: 12, background: INK, borderRadius: 1 }} />
    </div>
  );
}

/**
 * Колонка «факт / план · % · смуга · відхилення в п.п.» — одна на тиждень і на місяць.
 * `markPct` різний (частка тижня vs частка місяця), і саме тому відхилення двох колонок
 * НЕ можна порівнювати напряму: про це прямо каже ⓘ, а не дрібний шрифт унизу.
 */
export function PaceCell({ fact, plan, markPct, hint, extra }: {
  fact: number; plan: number; markPct: number; hint: string; extra?: ReactNode;
}) {
  const pct = plan > 0 ? (fact / plan) * 100 : 0;
  const dev = pct - markPct;                       // відхилення в ПУНКТАХ, не у відсотках
  const color = plan <= 0 ? MUTED : dev >= 0 ? GREEN : dev >= -10 ? AMBER : RED;
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ fontWeight: 800, fontSize: 15, color, textAlign: "right" }}>
        {plan > 0 ? `${pct.toFixed(1)}%` : "—"} <InfoHint text={hint} />
      </div>
      <div style={{ fontSize: 11, color: MUTED, textAlign: "right" }}>{fmt(fact)} / {fmt(plan)}</div>
      <PaceBar pct={pct} markPct={markPct} color={color} />
      <div style={{ fontSize: 10.5, color, textAlign: "right", fontWeight: 700 }}>
        {plan > 0 ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)} п.п.` : "плану немає"}
      </div>
      {extra}
    </div>
  );
}

/**
 * «% ВІД НЕОБХІДНОГО» — ЄДИНА величина, яку МОЖНА порівнювати між тижнем і місяцем.
 *
 * 🔴 Без неї користувач порівняє −35.2 і −7.0 п.п. і зробить хибний висновок, що
 * тиждень провалено вп'ятеро гірше за місяць. Насправді мітки стоять на 80% і 19%,
 * бо з тижня минуло 4 дні з 5, а з місяця — 4 з 21. Приведення до «скільки % від
 * того, що мало б бути на СЬОГОДНІ» знімає різницю довжини періодів.
 */
export function pctOfNeeded(fact: number, plan: number, markPct: number): number | null {
  const needed = plan * (markPct / 100);
  if (needed <= 0) return null;
  return Math.round((fact / needed) * 100);
}

/** Заголовок смуги — колірна плашка групи колонок, як у макеті. */
export function BandHead({ children, bg }: { children: ReactNode; bg: string }) {
  return (
    <div style={{
      background: bg, color: "#fff", fontSize: 10, fontWeight: 800, letterSpacing: ".5px",
      textTransform: "uppercase", padding: "5px 12px", borderRadius: 4, textAlign: "center",
    }}>{children}</div>
  );
}
export const BAND_BG = {
  activity: "var(--rpt-band-activity, #4b5563)",
  money: "var(--rpt-band-money, #15803d)",
  invoices: "var(--rpt-band-invoices, #a16207)",
  pace: "var(--rpt-band-pace, #1e3a5f)",
} as const;
