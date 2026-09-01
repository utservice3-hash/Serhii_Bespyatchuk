/**
 * 🔗 ЗВЕДЕННЯ ЛІМІТІВ ПРИ ОБʼЄДНАННІ КЛІЄНТІВ (рішення власника 27.08.2026).
 *
 * Дві юрособи виявились одним клієнтом. У кожної могли бути СВОЇ ліміти —
 * і після злиття рядок мусить мати ОДИН. Тут живе правило, яким саме.
 *
 * 🔴 ЧОМУ ЧИСТІ ФУНКЦІЇ, А НЕ SQL У РОУТІ. Правило про гроші, яке існує лише
 * всередині транзакції, перевіряється тільки прогоном проти живої бази — тобто
 * саботаж (єдиний спосіб довести, що гейт справді ловить) вимагав би другого
 * сервера. Той самий прийом, що `auth/mergeScope.ts` і `core/creditLimits.ts`:
 * рішення відокремлене від походу в БД.
 *
 * ⚠️ ФАЙЛ НІЧОГО НЕ ІМПОРТУЄ З `db/pool.js`. Він читає `config.js`, який кидає
 * без `DATABASE_URL` ще НА ІМПОРТІ — гейт не дістав би звідси навіть чистої
 * функції (прецедент: `moneyBuckets` не імпортує `money`).
 */

/** Рядок `client_credit_limits` однієї зі сторін злиття. */
export interface MergeLimitRow {
  clientKey: string;
  limitDays: number | null;
  limitAmount: number | null;
}

/**
 * 🗓 ДНІ — БЕРЕМО МЕНШИЙ (рішення власника 27.08.2026).
 *
 * Відстрочка не складається: якщо одній юрособі дали 30 днів, а другій 10, то
 * після злиття клієнт має 10. Складання дало б 40 — відстрочку, якої ніхто
 * ніколи не погоджував.
 *
 * 🔴 `limit_days = 0` («розглянули і ВІДМОВИЛИ») ВИГРАЄ САМ, і це не окрема
 * гілка, а властивість мінімуму: `min(0, 30) = 0`. Тому слід відмови по днях
 * НЕ гине при зведенні — на відміну від суми, де його доводиться писати
 * словами (див. `mergedLimitNote`).
 *
 * 🔴 NULL — НЕ НУЛЬ, І ТУТ ЦЕ ДОРОЖЧЕ, НІЖ ЗДАЄТЬСЯ. `null` означає «ліміт
 * НІКОЛИ не ставили», а `0` — «подивились і не дали». Наївний `Math.min(...)`
 * по `Number(null)` перетворив би перше на друге і зробив би відмовою кожне
 * злиття, де хоч одна сторона ліміту не мала. Та сама пастка, що коштувала
 * заміру в `limitState` (54 клієнти замість девʼяти).
 *
 * Усі сторони без ліміту → `null`: клієнту його справді не ставили.
 */
export function mergedLimitDays(rows: readonly MergeLimitRow[]): number | null {
  const set = rows.map((r) => r.limitDays).filter((d): d is number => d != null);
  if (!set.length) return null;
  return Math.min(...set.map(Number));
}

/**
 * 💰 СУМА — СКЛАДАЄТЬСЯ, ВКЛЮЧНО З НУЛЕМ (рішення власника 27.08.2026).
 *
 * 🔴 ЦЕ ВИГЛЯДАТИМЕ ЯК НЕДОГЛЯД, І ТОМУ ПРИЧИНА ЗАПИСАНА ТУТ, А НЕ В ЧАТІ.
 * Дослівно: **«Відмова · 0 ₴» складається, як і решта. 0 + 40 000 = 40 000.**
 * Ліміт суми — це стеля БОРГУ, а борг після злиття складається; отже стеля
 * мусить складатись разом із ним. Взяти мінімум (як у днях) означало б, що
 * клієнт, якому дозволили 40 000, після приєднання другої юрособи з відмовою
 * миттєво стає перелімітником, не зробивши нічого.
 *
 * 🔴 САМЕ ТОМУ ГЕЙТ `#240c` СТВЕРДЖУЄ ПРОТИЛЕЖНЕ ДО ДНІВ. Він написаний
 * навмисно «догори ногами» відносно `#240`, і без цього абзацу наступний читач
 * вирішить, що це помилка, і «полагодить».
 *
 * ⚠️ АЛЕ СЛІД ВІДМОВИ ЗНИКАЄ З ЧИСЛА — і ось де він лишається: `mergedLimitNote`
 * зобовʼязана назвати його СЛОВАМИ. Без цього рішення «розглянули і не дали»
 * випаровується без жодного знаку, і через місяць ніхто не пояснить, звідки в
 * клієнта взялась стеля, якої йому не давали.
 *
 * Усі сторони без суми → `null` («ніколи не ставили»), а не `0` («відмовили»).
 */
export function mergedLimitAmount(rows: readonly MergeLimitRow[]): number | null {
  const set = rows.map((r) => r.limitAmount).filter((a): a is number => a != null);
  if (!set.length) return null;
  return set.reduce((a, b) => a + Number(b), 0);
}

/** Чи була серед злитих сторін ВІДМОВА по сумі (`limit_amount = 0`). */
export function hadAmountRefusal(rows: readonly MergeLimitRow[]): boolean {
  return rows.some((r) => r.limitAmount != null && Number(r.limitAmount) === 0);
}

/** Чи була серед злитих сторін відмова по ДНЯХ (`limit_days = 0`). */
export function hadDaysRefusal(rows: readonly MergeLimitRow[]): boolean {
  return rows.some((r) => r.limitDays != null && Number(r.limitDays) === 0);
}

/** `2026-08-27` → `27.08`. Дата приходить аргументом: функція лишається чистою. */
export function mergeDateLabel(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}` : isoDate;
}

/**
 * 🧾 ЖУРНАЛ ЛІМІТУ ПІСЛЯ ЗВЕДЕННЯ — обовʼязкова вимога власника 27.08.2026.
 *
 * `client_credit_limits.note` — єдине місце, де записано, ЧОМУ ліміт такий
 * (`CHECK (length(btrim(note)) > 0)` не дає лишити його порожнім). Після злиття
 * число в рядку більше не дорівнює жодному з погоджених — тож примітка мусить
 * сказати, що це ЗВЕДЕНЕ значення й коли воно зведене.
 *
 * 🔴 ВІДМОВА ПО СУМІ НАЗИВАЄТЬСЯ ОКРЕМИМ РЕЧЕННЯМ, бо саме її слід зникає з
 * числа (0 розчиняється в сумі безслідно). Відмова по ДНЯХ теж названа — але
 * вона, на відміну від суми, ще й ВИДНА в самому значенні (мінімум = 0).
 */
export function mergedLimitNote(rows: readonly MergeLimitRow[], isoDate: string): string {
  const d = mergeDateLabel(isoDate);
  const parts = [`зведено при обʼєднанні ${d}: ліміти ${rows.length} юросіб`];
  if (hadAmountRefusal(rows)) parts.push(`серед злитих була відмова (0 ₴)`);
  if (hadDaysRefusal(rows)) parts.push(`серед злитих була відмова по днях (0 дн.)`);
  return parts.join("; ");
}

/**
 * 🧾 РЯДОК ЗЛИТОГО КЛІЄНТА — ОДИН ТЕКСТ ЗАПИТУ, ДОСТУПНИЙ ГЕЙТУ.
 *
 * 🔴 ЧОМУ КОНСТАНТА, А НЕ РЯДОК УСЕРЕДИНІ РОУТА. Дефект, який цей запит
 * лагодить, був НЕ в логіці, а в переліку колонок: `limit_amount` у ньому не
 * було взагалі, а `limit_days` вставлявся як NULL. Тобто до наступного синку
 * (до 15 хв) злитий клієнт стояв «ліміт не узгоджено» і — за правилом власника
 * «неузгоджений ліміт поводиться як нульовий» — ПЕРЕЛІМІТНИКОМ. Перевірити таке
 * можна лише ВИКОНАННЯМ проти справжньої схеми; переписаний «схоже» SQL — доказ
 * ні про що (урок `#21c`, прецедент `#198g`).
 *
 * $1 — канонічний ключ · $2 — зведені дні · $3 — зведена сума.
 */
export const MERGED_RECEIVABLE_ROW_SQL = `
  INSERT INTO receivables (client_key, client_name, manager_id, manager_name_raw,
                           amount, limit_days, limit_amount, overdue_days)
  SELECT ri.client_key,
         COALESCE(MIN(ri.client_name) FILTER (WHERE ri.client_key_raw = ri.client_key), MIN(ri.client_name)),
         NULL, '', SUM(ri.amount), $2, $3, NULL
    FROM receivable_invoices ri
   WHERE ri.client_key = $1
   GROUP BY ri.client_key`;

/* ═══════════════════════════════════════════════════════════════════════════
   📸 ЗНІМОК ЛІМІТІВ ДО ЗЛИТТЯ (01.09.2026, рішення власника)

   🔴 ЧОМУ ЦЕ ЗАВЕДЕНО. Заміряно на проді: зведення лімітів перезаписує рядок
   канонічного клієнта `ON CONFLICT (client_key) DO UPDATE`, а таблиці історії
   лімітів у базі НЕМАЄ (87 таблиць; контроль — чотири інші таблиці історії
   існують, тобто пошуку було що знаходити). Різниця між `set_at` канонічного
   рядка й моментом злиття — РІВНО 0 секунд у обох живих випадках.

   І попереднє число не виводиться навіть теоретично: `mergedLimitDays` — це
   мінімум, а серед злитих буває відмова (0), тож `min(x, 0) = 0` при будь-якому
   `x ≥ 0`. Зведений нуль не несе про канонічного ЖОДНОЇ інформації.

   Наслідок, названий прямо: для двох уже злитих груп ліміт до злиття втрачено
   НАЗАВЖДИ. Цей знімок не лікує минуле — він робить так, щоб наступне злиття
   більше не створювало тієї самої незворотності.

   🔴 ОДИН ЗАПИС НА КОЖНУ СТОРОНУ, ЗАВЖДИ — І ЦЕ ГОЛОВНА ВЛАСТИВІСТЬ.
   Порожній масив мусить означати РІВНО ОДНЕ: «знімок не робився». Тому сторона
   БЕЗ ліміту теж отримує запис, із `hadNoRow: true` — це ФАКТ («ліміту не було»),
   а не прогалина («не записали»). Інакше два різні стани злились би в один
   порожній обʼєкт, і наступний читач не відрізнив би «нічого не було» від
   «нічого не зберегли» — та сама хвороба, що «порожній результат = pass».
   ═══════════════════════════════════════════════════════════════════════════ */

/** Сирий рядок `client_credit_limits` — як його віддає БД. */
export interface RawLimitRow {
  client_key: string;
  limit_days: number | string | null;
  limit_amount: number | string | null;
  note?: string | null;
  set_by?: number | null;
  set_at?: string | Date | null;
}

export interface LimitBeforeSide {
  clientKey: string;
  limitDays: number | null;
  limitAmount: number | null;
  note: string | null;
  setBy: number | null;
  setAt: string | null;
  /** `true` — рядка в `client_credit_limits` не було ВЗАГАЛІ. Це факт, не прогалина. */
  hadNoRow: boolean;
}

export interface LimitsBefore {
  /** Коли знімок зроблено (ISO). Дозволяє відрізнити його від `set_at` сторін. */
  capturedAt: string;
  /** Рівно один запис на КОЖЕН переданий ключ, у тому самому порядку. */
  sides: LimitBeforeSide[];
}

const numOrNull = (v: unknown): number | null =>
  v == null || v === "" ? null : Number(v);

/**
 * Знімок лімітів усіх сторін ДО зведення.
 *
 * @param keys       усі учасники злиття — канонічний ПЕРШИМ, далі псевдоніми.
 * @param rows       те, що віддала `client_credit_limits` по цих ключах.
 * @param capturedAt мить знімка (ISO).
 */
export function limitsBeforeSnapshot(
  keys: readonly string[], rows: readonly RawLimitRow[], capturedAt: string,
): LimitsBefore {
  const byKey = new Map(rows.map((r) => [r.client_key, r]));
  return {
    capturedAt,
    sides: keys.map((clientKey) => {
      const r = byKey.get(clientKey);
      if (!r) {
        return { clientKey, limitDays: null, limitAmount: null, note: null,
                 setBy: null, setAt: null, hadNoRow: true };
      }
      return {
        clientKey,
        limitDays: numOrNull(r.limit_days),
        limitAmount: numOrNull(r.limit_amount),
        note: r.note ?? null,
        setBy: r.set_by ?? null,
        setAt: r.set_at == null ? null
             : (r.set_at instanceof Date ? r.set_at.toISOString() : String(r.set_at)),
        hadNoRow: false,
      };
    }),
  };
}

/**
 * 📄 ЩО АРКУШ МАВ БИ ПОКАЗАТИ ДЛЯ ЗЛИТОЇ ГРУПИ — за тим самим правилом зведення.
 *
 * 🔴 НАВІЩО. `#181` звіряв нашу таблицю з Лист20 НАВПРОСТЕЦЬ і показував
 * «автострадавк: аркуш 10 / наше 0» як розбіжність. Насправді він порівнював дві
 * різні речі: в аркуші ліміт кожної ЮРОСОБИ окремо, у нас — ліміт ГРУПИ після
 * обʼєднання. Заміряно 01.09.2026 на живому проді:
 *   автострадавк = [10, 0] → зведено 0 ✅ збігається з нашим
 *   смартекс     = [15, 0, 10] → зведено 0 ✅ збігається з нашим
 * Тобто наш нуль ВИВОДИТЬСЯ з чисел самого аркуша, щойно застосувати правило.
 * Це прогалина в знаннях гейта, а не розходження по суті — інакше це був би СТОП
 * і питання власнику, а не тиха правка.
 *
 * ⚠️ ЗВЕДЕННЯ РАХУЄ `mergedLimitDays`, А НЕ КОПІЯ ТУТ. Друга редакція правила
 * розійшлася б із першою рівно тоді, коли хтось поправить одну; саме тому нуль-як-
 * властивість-мінімуму лишається там, де його вже пояснено.
 */
export function sheetExpectedDays(
  canonical: string,
  sheetDays: (key: string) => number | null | undefined,
  aliasesOf: (canonical: string) => readonly string[],
): number | null {
  const members = [canonical, ...aliasesOf(canonical)];
  const rows: MergeLimitRow[] = members.map((clientKey) => ({
    clientKey, limitDays: sheetDays(clientKey) ?? null, limitAmount: null,
  }));
  return mergedLimitDays(rows);
}
