/**
 * 📈 ВИГЛЯД РОЗГОРНУТОГО ГРАФІКА «СТАТИСТИК» — правила, які виконують гейти (огляд графіків за методом dataviz,
 * Роман 23.11.2026: «роби фікси і викочуй»). Той самий прийом, що `statsGran.ts` / `statsMulti.ts` / `statsCards.ts`:
 * правило — функцією, бо функцію гейт може ВИКОНАТИ, а вираз у JSX — лише прочитати очима.
 *
 *   • `splitCurrent` — період, що йде, малюється ОКРЕМОЮ пунктирною лінією від останнього повного періоду. Суцільна
 *     лінія, що падає в неповний місяць, читалась як обвал (на проді 23.11: «Отримані кошти» 3,14 → 2,38 млн
 *     суцільною лінією, хоча листопад просто ще не скінчився).
 *   • `teamKeys` — «Усі команди» вмикає КОМАНДИ, без лінії компанії: компанія (~3 млн) на одній осі з командами
 *     (0,1–1 млн) притискала їх до нуля, і п'ять ліній злипались.
 *   • `periodTick` / `periodTitle` — місяць підписується місяцем («лис 26»), а не датою першого числа («01.11.26»).
 *   • `fmt` — дробова частина через кому, як на осі: «3,14 млн ₴», а не «3.14 млн ₴».
 */

export type Gran = "day" | "week" | "month";

const MON_SHORT = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const MON_FULL = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

/** Суфікси ключів лінії: `_f` — повні періоди (суцільна), `_c` — останній повний + той, що йде (пунктир). */
export const FULL_SUFFIX = "_f";
export const CUR_SUFFIX = "_c";

/**
 * Рядки графіка з двома додатковими ключами на кожну серію. Вихідні ключі НЕ чіпаються: їх читають таблиця значень,
 * поділки осі й позначки аномалій. Довжина й порядок рядків ті самі — вікно брашу лишається тим самим.
 *   `${k}_f` — значення лише для періодів, що вже закінчились (`period < curStart`);
 *   `${k}_c` — значення для періоду, що йде (`period >= curStart`), і для ОСТАННЬОГО повного перед ним, щоб пунктир
 *             починався з тієї самої точки, де обривається суцільна лінія.
 * Якщо періоду, що йде, у рядах немає — `_c` порожній, і пунктиру немає.
 */
export type ChartRow = { period: string } & Record<string, unknown>;
export function splitCurrent(rows: readonly ChartRow[], keys: readonly string[], curStart: string): ChartRow[] {
  const out: ChartRow[] = rows.map((r) => ({ ...r }));
  const firstCur = out.findIndex((r) => r.period >= curStart);
  for (const k of keys) {
    for (let i = 0; i < out.length; i++) {
      const v = out[i][k];
      if (typeof v !== "number") continue;
      if (out[i].period < curStart) out[i][k + FULL_SUFFIX] = v;
      else out[i][k + CUR_SUFFIX] = v;
    }
    // Місток: останній повний період перед тим, що йде, — і на суцільній, і на пунктирі.
    if (firstCur > 0 && typeof out[firstCur][k] === "number") {
      for (let i = firstCur - 1; i >= 0; i--) {
        const v = out[i][k];
        if (typeof v === "number") { out[i][k + CUR_SUFFIX] = v; break; }
      }
    }
  }
  return out;
}

export type ScopeSeries = { scopeKey: string; scopeType?: string; archived?: boolean; benchmark?: boolean };

/**
 * Що вмикає «Усі команди»: усі серії легенди, КРІМ компанії (і бенчмарка-компанії в тімліда). Розформовані — лише з
 * «показати архівні», як у легенді. Компанію можна повернути кліком по ній у легенді.
 */
export function teamKeys(series: readonly ScopeSeries[], showArchived: boolean): string[] {
  return series
    .filter((s) => (showArchived || !s.archived) && s.scopeType !== "company" && !s.benchmark)
    .map((s) => s.scopeKey);
}

/** Підпис поділки осі X: місяць — «лис 26»; тиждень і день — «17.11.26». */
export function periodTick(p: string, g: Gran): string {
  const [y, m, d] = p.split("-");
  if (g === "month") return `${MON_SHORT[Number(m) - 1]} ${y.slice(2)}`;
  return `${d}.${m}.${y.slice(2)}`;
}

/** Підпис періоду в підказці й таблиці: «листопад 2026» · «тиждень 17.11–23.11.26» · «17.11.26». */
export function periodTitle(p: string, g: Gran): string {
  const [y, m, d] = p.split("-");
  if (g === "month") return `${MON_FULL[Number(m) - 1]} ${y}`;
  if (g === "week") {
    const e = new Date(`${p}T00:00:00Z`); e.setUTCDate(e.getUTCDate() + 6);
    const ed = e.toISOString().slice(0, 10);
    return `тиждень ${d}.${m}–${ed.slice(8, 10)}.${ed.slice(5, 7)}.${ed.slice(2, 4)}`;
  }
  return `${d}.${m}.${y.slice(2)}`;
}

/** Число з одиницею: 0,2% — не «0%» (до 10% один знак); мільйони — до двох знаків через КОМУ; тисячі — пробілом. */
export function fmt(n: number, unit?: string): string {
  if (unit === "%") return n.toLocaleString("uk-UA", { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 }) + "%";
  if (unit === "хв") return `${(Math.round(n * 10) / 10).toLocaleString("uk-UA")} хв`;
  const r = Math.abs(n) >= 1e6
    ? (n / 1e6).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " млн"
    : Math.abs(n) >= 1e3 ? Math.round(n).toLocaleString("uk-UA").replace(/,/g, " ") : String(Math.round(n));
  return unit === "₴" ? r + " ₴" : r;
}
