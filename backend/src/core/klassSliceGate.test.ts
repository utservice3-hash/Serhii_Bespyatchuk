import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";
import { keepByKlass, KLASS_SLICES, klassOf, SLICE_LABEL, type KlassSlice, type DealKlassState } from "./klassFilter.js";

/**
 * 🔀 Е3 — ЗРІЗ ЗА НОВИЗНОЮ КЛІЄНТА (25.08.2026).
 *
 * Перемикач «усі / лише нові / лише постійні» звужує ЧИСЛО «Створено» разом із
 * ПАРТИЦІЄЮ його джерела — і СКЛАД розкриття того самого числа. Гейти нижче
 * стережуть рівно те, що ламається тихо.
 *
 * 📐 Розмір червоного відомий НАПЕРЕД (заміряно на проді 25.08.2026, серпень):
 * «лише нові» = 1 513 із 2 151 створених, тобто фільтр, застосований лише до
 * числа, розійшовся б із розкриттям на **638 угод (29.7%)**. Для порівняння: той
 * випадок Е2, який власник побачив на скріншоті, — 12.6%.
 */

const FE = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/", import.meta.url));
const SRC = (f: string): string => readFileSync(FE + f, "utf8");
/** Коментарі вирізаються: у доках я цитую саме те, що заборонено (той самий прийом, що #203). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const KYIV_MONTH = (d: Date): { from: string; to: string } => {
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { from: `${ym}-01`, to: `${ym}-31` };
};

/**
 * #206 — ЧИСЛО РЯДКА == СКЛАД РОЗКРИТТЯ ПРИ КОЖНОМУ ПОЛОЖЕННІ, а не лише при «усі».
 *
 * 🔴 Перевіряється ПОРЯДКОВО, по парах (менеджер, день). Сумарна рівність зеленіла б
 * і тоді, коли зріз поїхав не тому менеджеру: Σ по відділу зійшлася б, а конкретна
 * людина бачила б чужі угоди у своєму розкритті.
 *
 * 🧨 САБОТАЖ: застосувати зріз до числа й не застосувати до розкриття (тобто
 * порівнювати `slice`-число з НЕфільтрованим складом) — червоніє на 638 угодах.
 */
test("#206 зріз: число рядка == склад розкриття при КОЖНОМУ положенні (жива БД)", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const metrics = await import("./metrics.js");
  const { from, to } = KYIV_MONTH(new Date());
  const FC = [8921932, 155304];

  const days = (await pool.query<{ manager_id: number; d_day: string }>(
    `SELECT d.manager_id, (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date::text AS d_day
       FROM deals d WHERE d.pipeline_id = ANY($1) AND d.manager_id IS NOT NULL
        AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3
      GROUP BY 1,2 HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC LIMIT 10`, [FC, from, to])).rows;
  assert.ok(days.length >= 3,
    `🔴 знайшлось лише ${days.length} пар (менеджер, день) з ≥3 угодами — перевіряти нема на чому`);

  const bad: string[] = [];
  let sawNew = 0, sawRep = 0;
  for (const d of days) {
    const rows = (await pool.query<{ klass: string | null; n: string }>(
      `SELECT (${metrics.dealKlassSql("dd")}) AS klass, COUNT(*)::int AS n
         FROM deals dd WHERE dd.manager_id = $1 AND dd.pipeline_id = ANY($2)
          AND (dd.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = $3::date
        GROUP BY 1`, [d.manager_id, FC, d.d_day])).rows;
    // Склад розкриття: той самий вираз ядра, що живить мітку рядка розкриття.
    const items: DealKlassState[] = rows.flatMap((r) => Array<DealKlassState>(Number(r.n)).fill(klassOf(r.klass)));
    for (const slice of KLASS_SLICES) {
      // ЧИСЛО рядка при цьому положенні — з ЯДРА (агрегат), а не з того ж масиву.
      const num = slice === "all" ? items.length
        : rows.filter((r) => klassOf(r.klass) === slice).reduce((a, r) => a + Number(r.n), 0);
      const shown = items.filter((it) => keepByKlass(it, slice)).length;
      if (num !== shown) bad.push(`мгр ${d.manager_id} ${d.d_day} «${slice}»: число ${num} ≠ склад ${shown}`);
    }
    sawNew += items.filter((x) => x === "new").length;
    sawRep += items.filter((x) => x === "rep").length;
  }
  assert.deepEqual(bad, [], "🔴 ЧИСЛО СПЕРЕЧАЄТЬСЯ ЗІ СКЛАДОМ:\n  " + bad.join("\n  "));
  // Дзеркало всередині гейта: обидва класи справді трапились, інакше рівність
  // трималась би на тому, що один із них завжди порожній.
  assert.ok(sawNew > 0 && sawRep > 0,
    `🔴 у вибірці лише один клас (нових ${sawNew}, постійних ${sawRep}) — зріз не перевірено`);
});

/**
 * #206b — ДЗЕРКАЛО: при «усі» зріз НЕ РІЖЕ НІЧОГО.
 *
 * Без нього `#206` лишався б зеленим і тоді, коли фільтр викидає геть усе: нуль
 * дорівнює нулю в обох частинах рівності. Це той самий клас, що «порожній
 * результат = pass».
 *
 * 🧨 САБОТАЖ: змінити `keepByKlass` так, щоб `'all'` теж звужував — червоніє.
 */
test("#206b дзеркало: положення «усі» не звужує жодного стану", () => {
  const states: DealKlassState[] = ["new", "rep", "undef", null];
  for (const st of states) assert.equal(keepByKlass(st, "all"), true, `🔴 «усі» відкинуло стан ${String(st)}`);
  // І навпаки: звужені положення пропускають РІВНО свій стан, а `null` — жодне.
  for (const slice of KLASS_SLICES.filter((s) => s !== "all")) {
    for (const st of states) {
      assert.equal(keepByKlass(st, slice), st === slice,
        `🔴 положення «${slice}» неправильно повелось зі станом ${String(st)}`);
    }
  }
});

/**
 * #207 — ПАРТИЦІЯ ЗБЕРІГАЄТЬСЯ: Σ трьох класів == «Створено», і зріз джерела
 * всередині класу теж партиція.
 *
 * 🔴 Це перевірка ЯДРА, а не екрана: `sourceByKlass` — нове поле, і якби воно
 * рахувалось по іншому набору рядків, ніж плоскі лічильники, розбіжність
 * зʼявилась би рівно там, де перемикач і показує.
 *
 * 🧨 САБОТАЖ: викинути `undef` із зрізу — червоніє на 6 угодах серпня; порахувати
 * `sourceByKlass` без фільтра по класу — червоніє на кожному менеджері.
 */
test("#207 зріз джерела за класом — партиція, і Σ класів == створено (жива БД)", needsDb(), async () => {
  const metrics = await import("./metrics.js");
  const { from, to } = KYIV_MONTH(new Date());
  const rows = await metrics.createdSplitByManager({ from, to });
  assert.ok(rows.length > 0, "🔴 у розкладі створених жодного менеджера — перевіряти нема на чому");

  const bad: string[] = [];
  for (const m of rows) {
    if (m.newCount + m.repeatCount + m.undefCount !== m.created)
      bad.push(`мгр ${m.managerId}: ${m.newCount}+${m.repeatCount}+${m.undefCount} ≠ ${m.created}`);
    const k = m.sourceByKlass;
    if (k.new.created + k.rep.created + k.undef.created !== m.created)
      bad.push(`мгр ${m.managerId}: Σ зрізів ${k.new.created + k.rep.created + k.undef.created} ≠ ${m.created}`);
    if (k.new.created !== m.newCount) bad.push(`мгр ${m.managerId}: зріз «нові» ${k.new.created} ≠ ${m.newCount}`);
    if (k.rep.created !== m.repeatCount) bad.push(`мгр ${m.managerId}: зріз «постійні» ${k.rep.created} ≠ ${m.repeatCount}`);
    if (k.undef.created !== m.undefCount) bad.push(`мгр ${m.managerId}: зріз «невизн» ${k.undef.created} ≠ ${m.undefCount}`);
    for (const [nm, v] of [["new", k.new], ["rep", k.rep], ["undef", k.undef]] as const) {
      const s = v.adCount + v.leadgenCount + v.otherCount + v.noChannelCount;
      if (s !== v.created) bad.push(`мгр ${m.managerId} «${nm}»: джерела ${s} ≠ ${v.created}`);
    }
    // Плоскі поля — це зріз «усі»: Σ по класах кожного джерела має дорівнювати їм.
    if (k.new.adCount + k.rep.adCount + k.undef.adCount !== m.adCount)
      bad.push(`мгр ${m.managerId}: реклама по класах ≠ плоскій`);
  }
  assert.deepEqual(bad, [], "🔴 ПАРТИЦІЯ РОЗʼЇХАЛАСЬ:\n  " + bad.join("\n  "));
});

/**
 * #207b — ТРЕТІЙ КЛАС ВИДНО, КОЛИ ВІН НЕПОРОЖНІЙ (рішення власника 25.08.2026,
 * умовна форма).
 *
 * 🧨 САБОТАЖ: прибрати `undefCount > 0` і ховати положення завжди — червоніє на
 * серпні (6 угод, −18 004 ₴ сторно без `client_key`).
 */
test("#207b умовний показ: у джерелі перемикача є гілка «показати, коли клас непорожній»", () => {
  const s = stripComments(SRC("sections/ReportPlanSection.tsx"));
  assert.match(s, /undefCount\s*>\s*0/,
    "🔴 перемикач не має умови на непорожність третього класу — або він завжди видимий, або завжди схований");
  assert.match(s, /SLICES\.filter/,
    "🔴 перелік положень не фільтрується — умовність не реалізована");
  assert.match(s, /srcByKlass\?\.undef\.created/,
    "🔴 кількість третього класу береться не з відповіді сервера");
});

/**
 * #207c — ДЗЕРКАЛО ДО #207b: КОЛИ КЛАС ПОРОЖНІЙ, ПОЛОЖЕННЯ НЕ ВИДНО.
 *
 * 🔴 Без цього «умовно» тихо перетворилось би на «завжди», і в чистому місяці на
 * екрані стояла б порожня колонка з нулем — рівно той клас брехні, що заголовок
 * плитки «(понад ліміт)» над списком, куди входять і клієнти без ліміту.
 *
 * Обидва боки беруться з ЖИВИХ даних, а не з фікстури: липень дає нуль, серпень —
 * шість. Фікстура моделювала б мою гіпотезу, а не продукт (урок `#75b`).
 *
 * 🧨 САБОТАЖ: показувати положення завжди — червоніє на липні.
 */
test("#207c дзеркало: місяць без третього класу існує, і саме там положення не показується (жива БД)", needsDb(), async () => {
  const metrics = await import("./metrics.js");
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const cnt = async (d: Date): Promise<number> =>
    (await metrics.createdSplitByManager(KYIV_MONTH(d))).reduce((a, m) => a + m.sourceByKlass.undef.created, 0);
  const [cur, old] = [await cnt(now), await cnt(prev)];
  // Предикат екрана — той самий вираз, що в `SliceSwitch`: гілка існує в коді
  // (це доводить #207b), а тут перевіряється, що вона РОЗРІЗНЯЄ два реальні місяці.
  const visible = (n: number): boolean => n > 0;
  assert.notEqual(visible(cur), visible(old),
    `🔴 обидва місяці дали однакову видимість (поточний ${cur}, минулий ${old}) — умовність не перевірена: `
    + "потрібен один місяць із третім класом і один без нього");
});

/**
 * #208 — ОЗНАЧЕННЯ ЗРІЗУ ОДНЕ: фронт і ядро вирішують однаково, і жодна поверхня
 * не порівнює клас самотужки.
 *
 * 🔴 Копія на фронті НЕОБХІДНА (перемикач не ходить на сервер), але копія без
 * звірки — це наступні «два означення новизни». Тут транспілюється СПРАВЖНІЙ
 * модуль фронту, а не його переказ (той самий прийом, що `#145c`).
 *
 * 🧨 САБОТАЖ (виконано): вписати в `DayDrill` власне `it.src === "new"` — червоніє
 * на другій половині; змінити гілку в `klassSlice.ts` — червоніє на першій.
 */
test("#208 зріз вирішується ОДНИМ означенням: фронт == ядро, і копій немає", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(SRC("klassSlice.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const fe = await import(`data:text/javascript,${encodeURIComponent(js)}`);

  const states: DealKlassState[] = ["new", "rep", "undef", null];
  let checked = 0;
  for (const st of states) {
    for (const slice of KLASS_SLICES) {
      assert.equal(fe.keepByKlass(st, slice), keepByKlass(st, slice as KlassSlice),
        `🔴 стан ${String(st)} × положення «${slice}»: фронт vs ядро`);
      checked++;
    }
  }
  assert.equal(checked, 16, `🔴 перевірено лише ${checked} комбінацій із 16 — розбір зламався`);
  assert.deepEqual({ ...fe.SLICE_LABEL }, { ...SLICE_LABEL }, "🔴 підписи положень на фронті інші, ніж у ядрі");

  // Друга половина: поверхні НЕ мають власного порівняння класу.
  const day = stripComments(SRC("sections/ReportPlanSection.tsx"));
  assert.match(day, /keepByKlass\(/, "🔴 розкриття дня не кличе `keepByKlass` — значить вирішує саме");
  assert.doesNotMatch(day, /it\.src\s*===\s*"(new|rep|undef)"/,
    "🔴 у розкритті дня зʼявилось ВЛАСНЕ порівняння класу — це друге означення новизни");
  const tbl = stripComments(SRC("sections/ReportTableSection.tsx"));
  assert.match(tbl, /narrowToSlice\(/, "🔴 таблиця не кличе `narrowToSlice` — значить звужує рядок сама");
  assert.doesNotMatch(tbl, /srcByKlass\s*\[/,
    "🔴 таблиця лізе в `srcByKlass` напряму — звуження мусить бути в одному місці");
});

/**
 * #209 — ПІДПИС У ВВІМКНЕНОМУ СТАНІ ОБОВʼЯЗКОВИЙ, і він називає ПРИЧИНУ.
 *
 * 🔴 Без підпису три звужені числа читаються як повні — той самий клас, що дві
 * правильні метрики без підпису, які читаються як поломка. А підпис «невизначено»
 * без причини нічого не пояснює тому, хто бачить −18 004 ₴ і не знає, чи це баг.
 *
 * 🧨 САБОТАЖ: прибрати блок `slice !== "all" && (…)` — червоніє; скоротити підпис
 * третього класу до самого слова «невизначено» — червоніє на перевірці причини.
 */
test("#209 звужений стан підписаний, і третій клас називає причину", () => {
  const s = stripComments(SRC("sections/ReportPlanSection.tsx"));
  assert.match(s, /slice\s*!==\s*"all"\s*&&/,
    "🔴 у ввімкненому стані немає підпису — звужені числа читатимуться як повні");
  assert.match(s, /SLICE_LABEL\[slice\]/, "🔴 підпис не будується з реєстру положень, тобто застаріє мовчки");
  assert.match(SLICE_LABEL.undef, /сторно/,
    "🔴 підпис третього положення не називає ПРИЧИНУ — «невизначено» саме по собі нічого не пояснює");
  // Розкриття теж мусить казати, що воно звужене: інакше порожній список читається
  // як «того дня нічого не було», а не як «у цьому зрізі нічого немає».
  assert.match(s, /view\.narrowed/, "🔴 розкриття не позначає, що склад звужено");
});
