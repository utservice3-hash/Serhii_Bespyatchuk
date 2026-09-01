import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi } from "../testMode.js";
import { kyivMonthBounds, monthEndOf } from "./dates.js";

/**
 * 🔀 #170–#173 — ДОБІР ЗА РЕЄСТРОМ ЛІДОГЕН-БОТА (24.08.2026, рішення власника).
 *
 * 🔴 ЩО ЛИШАЛОСЬ ПІСЛЯ `aa183de`. Перехід «лідген = канал» тоді закрив ТРИ місця
 * (факт Звіту, факт KPI-задачі, знаменник лайфтайм-конверсії РПК) — і саме тому
 * решта читалась як зроблена. Аудит показав ЧОТИРИ живі читачі реєстру, кожен на
 * екрані, який ніхто не звіряв із Звітом:
 *   · `conversionLeadgenByManager` — знаменник рекомендації «скільки взяти лідів»;
 *   · лідген-гілка `maxMonthlyLeadsByManager` — позначка «ціль недосяжна»;
 *   · `statisticsSeries.lg_transfers` — ряд «Прорахунки лідгенів» у Статистиках;
 *   · опис інструмента AI `conversion_leadgen_by_manager`.
 * Плюс дві МЕРТВІ функції (`leadgenByManager` без читачів після `aa183de`,
 * `leadgenByManagerBucket` без них ніколи).
 *
 * 🔴 ЧОМУ ЦЕ НЕ «ОХАЙНІСТЬ». Реєстр (`leadgen_registry` → `leadgen_touch`) веде лише
 * з 15.06.2026, а `syncLeadgenRegistry` робить першій `TRUNCATE` щосинку. Тобто
 * знаменник, узятий звідти, ділив канальний чисельник (історія з 2024) на пʼять
 * тижнів даних — і давав завищення в рази, мовчки. Рівно це ми вже виправили в
 * РПК-конверсії (997 проти 4290, ×4.3) і рівно це лишалось у рекомендації.
 *
 * ⚠️ ТАБЛИЦЮ `leadgen_touch` НЕ ЧІПАЄМО. Її пише `syncKommo` і читає
 * `reclassifyAdChannel` — саме вона й перетворює дотик бота на `lead_channel`.
 * Прибрано ЧИТАЧІВ у метриках, а не джерело.
 */

const src = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело ${rel} — гейт не має права мовчки пропускатись`);
};
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const fnBody = (code: string, name: string): string => {
  const re = new RegExp(`export async function ${name}\\b[\\s\\S]*?\\n\\}`);
  const m = re.exec(code);
  assert.ok(m, `🔴 не знайдено \`${name}\` — гейт втратив предмет`);
  return m![0];
};

const MONTH = { from: "2026-07-01", to: "2026-07-31" };

/**
 * #170 — ЗНАМЕННИК РЕКОМЕНДАЦІЇ БІЛЬШЕ НЕ З РЕЄСТРУ.
 *
 * Читається ДЖЕРЕЛО, бо перевіряється саме вибір множини, а не значення: реєстрова
 * й канальна форми на серпні дають схожі порядки чисел, тож «однакове число» тут
 * нічого б не довело — розходяться вони на історії, куди тест не дивиться.
 *
 * 🧨 САБОТАЖ (виконано): повернути `FROM leadgen_touch lt` у тіло функції →
 * червоніє з обома твердженнями.
 */
test("#170 conversionLeadgenByManager рахує знаменник за КАНАЛОМ, не за реєстром", () => {
  const fn = stripComments(fnBody(src("core/metrics.ts"), "conversionLeadgenByManager"));

  assert.match(fn, /d\.lead_channel\s*=\s*'leadgen'/,
    "🔴 знаменник не канальний — рекомендація «скільки взяти лідів» знову ділить на реєстр");
  assert.match(fn, /d\.created_at_kommo/,
    "🔴 зник анкер `created_at_kommo` — знаменник поїхав на іншу дату, ніж факт Звіту");
  assert.doesNotMatch(fn, /leadgen_touch|transfer_date/,
    "🔴 у знаменник повернувся реєстр лідоген-бота (історія з 15.06.2026 + TRUNCATE щосинку)");
});

/**
 * #170b — 🪞 ЗНАМЕННИК КОНВЕРСІЇ == ФАКТ ЛІДГЕНУ ЗІ ЗВІТУ, ПО КОЖНОМУ МЕНЕДЖЕРУ.
 *
 * 🔴 НАВІЩО САМЕ ЦЕ ТВЕРДЖЕННЯ. Людина бачить на сусідніх екранах «взяв N лідгенів»
 * (Звіт, `createdSplitByManager`) і «конверсія лідгену X% з N заявок» (рекомендація).
 * Поки N були з різних джерел, розбіжність читалась як поломка одного з екранів —
 * і саме так ми прийшли до «лідген 1/15». Тепер це ЗАМОК: обидва N зобовʼязані бути
 * тим самим числом.
 *
 * 🪞 Дзеркало: вибірка не порожня — інакше рівність нулів була б тривіально зелена
 * («порожній результат = провал, а не успіх»).
 *
 * 🧨 САБОТАЖ (виконано): прибрати `d.pipeline_id = ANY($2)` у знаменнику → у видачу
 * заходять лідген-угоди поза Повним циклом, числа розходяться, гейт червоніє.
 */
test("#170b знаменник конверсії лідгену == факт лідгену Звіту, по кожному менеджеру",
  { ...needsApi() }, async () => {
    const m = await import("./metrics.js");
    const [conv, split] = await Promise.all([
      m.conversionLeadgenByManager(MONTH),
      m.createdSplitByManager(MONTH),
    ]);

    const byConv = new Map(conv.map((x) => [x.managerId, x.entered]));
    const bad: string[] = [];
    for (const s of split) {
      const c = byConv.get(s.managerId) ?? 0;
      if (c !== s.leadgenCount) bad.push(`${s.name}: Звіт=${s.leadgenCount} конверсія=${c}`);
    }
    for (const [id, entered] of byConv) {
      if (entered > 0 && !split.some((s) => s.managerId === id)) {
        bad.push(`mgr ${id}: є в конверсії (${entered}), немає у Звіті`);
      }
    }
    assert.deepEqual(bad, [],
      "🔴 знаменник рекомендації і факт Звіту розійшлись — у системі знову ДВА лідгени");

    const total = split.reduce((s, x) => s + x.leadgenCount, 0);
    assert.ok(total > 0,
      "🔴 за період нуль лідген-угод — рівність тривіальна, гейту нема що перевіряти");
  });

/**
 * #170c — У МЕТРИКАХ НЕ ЛИШИЛОСЬ ЖОДНОГО ЧИТАЧА РЕЄСТРУ.
 *
 * Ширше за #170: воно про ФАЙЛ, а не про одну функцію. Наступний, хто додасть
 * лідген-метрику, найпростішим шляхом візьме реєстрову таблицю — і заведе третє
 * означення. Гейт це ловить одразу.
 *
 * 🔴 ГЕЙТ ОНОВЛЕНО 25.08.2026 (Е6) — І ЦЕ НЕ ПОСЛАБЛЕННЯ, А ПЕРЕВЕДЕННЯ СТРІЛКИ.
 * Він писався САМЕ як застава під цей прохід: «перевести в один рядок НЕ МОЖНА…
 * окремий прохід зі своїм прийманням». Прохід відбувся, приймання є, тож тепер:
 *   • `leadgen_registry` у метриках — **нуль** читачів (було «рівно 1»);
 *   • `leadgen_touch` — **рівно один**, когортна гілка `entry='transferred'`
 *     (було «жодного»).
 * Заборона «нового реєстрового означення» лишається чинною — вона просто показує
 * на іншу таблицю. Обійти цей гейт мовчки було неможливо: перехід червонить його
 * сам, і саме так він і спрацював.
 *
 * 🪞 Дзеркало обовʼязкове: сама таблиця й ПИСАР до неї мусять лишитись. Без цієї
 * половини гейт зеленів би й тоді, коли `leadgen_touch` знесли б узагалі — а вона
 * живить і `reclassifyAdChannel` (той самий `lead_channel`, на який ми перейшли),
 * і тепер ще й когортний знаменник.
 *
 * 🧨 САБОТАЖ (виконано): дописати ДРУГИЙ `FROM leadgen_touch` у будь-яку функцію
 * `core/metrics.ts` → червоніє; повернути `FROM leadgen_registry` → червоніє;
 * прибрати `upsertLeadgenTouch` із `syncKommo.ts` → червоніє дзеркало.
 */
test("#170c core/metrics.ts не читає реєстр, а слід — рівно раз; писар таблиці живий", () => {
  const metricsSrc = stripComments(src("core/metrics.ts"));

  const regReads = (metricsSrc.match(/FROM leadgen_registry/g) ?? []).length;
  assert.equal(regReads, 0,
    `🔴 читачів \`leadgen_registry\` у метриках ${regReads}, а має бути 0: реєстр `
    + "`TRUNCATE`-иться щосинку, тож метрика за 12 місяців із нього тихо обрізається "
    + "(Е6, 25.08.2026)");

  // 🧾 ЄДИНИЙ ЧИТАЧ ПЕРСИСТЕНТНОГО СЛІДУ — НАЗВАНИЙ ЧИСЛОМ, А НЕ ЗАМОВЧАНИЙ.
  // Це когортна гілка `conversionByCohort(entry='transferred')`: вона, як і
  // `lg_transfers`, міряє ПЕРЕДАЧІ, тож канал (`lead_channel='leadgen'`) їй не
  // підходить — саме тому вона й лишилась поза переходом `aa183de`/`564bee0`.
  // Побільшає — зʼявилось друге означення передач; поменшає — гілку перевели
  // назад на реєстр або на канал, і в обох випадках мовчки.
  const touchReads = (metricsSrc.match(/FROM leadgen_touch/g) ?? []).length;
  assert.equal(touchReads, 1,
    `🔴 читачів \`leadgen_touch\` у метриках ${touchReads}, а має бути рівно 1 (когортні передачі)`);

  // 🪞 Дзеркало: прибрано читачів, а не джерело.
  //
  // 🔴 МЕЖА СЛОВА `\b` — НЕ ПРИДИРКА, ЦЕ ДІРА, ЗНАЙДЕНА САБОТАЖЕМ 25.08.2026.
  // Було `/INSERT INTO leadgen_touch/` без межі, і перейменування писаря на
  // `leadgen_touch_OFF` дзеркало ПРОПУСКАЛО: підрядок збігався. Тобто воно ловило
  // лише повне видалення рядка — а найімовірніша поломка тут якраз перейменування
  // таблиці. Гейт читався сильнішим, ніж був; спіймалось тільки тим, що саботаж
  // мав почервоніти й не почервонів.
  const sync = src("jobs/syncKommo.ts");
  assert.match(sync, /INSERT INTO leadgen_touch\b(?!_)/,
    "🔴 зник писар `leadgen_touch` — разом із ним зникне лідоген-дотик, з якого `reclassifyAdChannel` робить `lead_channel='leadgen'`");
  assert.match(src("db/schema.sql"), /CREATE TABLE IF NOT EXISTS leadgen_touch/,
    "🔴 таблицю `leadgen_touch` знесли зі схеми — прибирали читачів, а не джерело");
});

/**
 * #171 — «НЕДОСЯЖНА ЦІЛЬ» МІРЯЄТЬСЯ ТІЄЮ САМОЮ МНОЖИНОЮ, ЩО Й КОНВЕРСІЯ.
 *
 * 🔴 ЧОМУ ЦІ ДВІ ПРАВКИ НЕРОЗДІЛЬНІ. `/lead-recommendation` рахує потребу як
 * `залишок ÷ (конверсія × чек)` і ПОРІВНЮЄ її з історичним максимумом
 * (`maxMonthlyLeadsByManager`). Перевести на канал лише конверсію означало б
 * порівнювати потребу, пораховану по каналу, з максимумом, порахованим по реєстру,
 * — тобто позначка «недосяжно» спалахувала б за арифметикою двох різних сутностей.
 * Саме так «треба 601, максимум 0» виглядало правдоподібно.
 *
 * Перевірка ПОВЕДІНКОЮ: максимум за вікном мусить ДОРІВНЮВАТИ найбільшому
 * місячному `entered` тієї самої конверсії — бо тепер це буквально одна множина.
 *
 * 🧨 САБОТАЖ (виконано): лишити в лідген-гілці `FROM leadgen_touch` → числа
 * розходяться на кожному менеджері з лідгеном, гейт червоніє.
 */
test("#171 максимум лідгену за місяць — канальний (джерело)", () => {
  const fn = stripComments(fnBody(src("core/metrics.ts"), "maxMonthlyLeadsByManager"));
  const lg = fn.slice(fn.indexOf("per_month"));
  assert.match(lg, /d\.lead_channel\s*=\s*'leadgen'/,
    "🔴 лідген-гілка максимуму не канальна — позначка «недосяжно» рахується іншою множиною, ніж потреба");
  assert.doesNotMatch(fn, /leadgen_touch|lt\.transfer_date/,
    "🔴 у максимум повернувся реєстр лідоген-бота");
});

test("#171b максимум лідгену == найбільший місячний знаменник конверсії",
  { ...needsApi() }, async () => {
    const m = await import("./metrics.js");
    // Те саме вікно, що в ядрі: 3 ПОВНІ місяці назад, поточний виключено.
    /**
     * 🇺🇦 Місяці відлічуємо від КИЇВСЬКОГО «сьогодні», як і ядро. `getUTC*` тут
     * зсувало б вікно на добу з 21:00 UTC до опівночі — рівно те, що 01.09 змусило
     * три гейти вимагати, щоб СЕРПЕНЬ був поточним місяцем.
     */
    const [cy, cm] = kyivMonthBounds().ym.split("-").map(Number);
    const months: { from: string; to: string }[] = [];
    for (let i = 3; i >= 1; i--) {
      const ym = `${new Date(Date.UTC(cy, cm - 1 - i, 1)).toISOString().slice(0, 7)}`;
      months.push({ from: `${ym}-01`, to: monthEndOf(ym) });
    }
    const perMonth = await Promise.all(months.map((p) => m.conversionLeadgenByManager(p)));
    const expected = new Map<number, number>();
    for (const rows of perMonth) {
      for (const r of rows) expected.set(r.managerId, Math.max(expected.get(r.managerId) ?? 0, r.entered));
    }

    const maxLeads = await m.maxMonthlyLeadsByManager([], 3);
    const bad: string[] = [];
    for (const [id, want] of expected) {
      const got = maxLeads.get(id)?.leadgen ?? 0;
      if (got !== want) bad.push(`mgr ${id}: максимум=${got} найбільший місяць конверсії=${want}`);
    }
    assert.deepEqual(bad, [],
      "🔴 максимум і знаменник конверсії рахуються різними множинами — позначка «недосяжно» бреше");

    assert.ok([...expected.values()].some((v) => v > 0),
      "🔴 за три повні місяці нуль лідген-угод — рівність тривіальна, перевіряти нема чого");
  });

/**
 * #172 — РЯД «ПРОРАХУНКИ ЛІДГЕНІВ» БІЛЬШЕ НЕ ОБРІЗАЄТЬСЯ, І ПРИ ЦЬОМУ МІРЯЄ ТЕ САМЕ.
 *
 * 🔴 РОЗБІЖНІСТЬ ІЗ ФОРМУЛЮВАННЯМ ЗАДАЧІ, НАЗВАНА ВГОЛОС. Задача перелічила цей ряд
 * серед «реєстрових місць → канал». Але він міряє ПЕРЕДАЧІ (дію лідоген-бота), а не
 * угоди з лідоген-каналом: перевівши його на `lead_channel`, ми зробили б назву
 * «Прорахунки лідгенів» неправдою і СХОВАЛИ б операційний обвал передач (з ~130 на
 * тиждень до 11/20/1 з 10.08.2026) за рівним каналом. Тому виправлено ПРИЧИНУ, яку
 * назвав власник («історія коротша за екран»), не змінюючи метрики:
 * `leadgen_registry` (TRUNCATE щосинку, з 15.06.2026) → `leadgen_touch` (append-only).
 *
 * 📐 Сьогодні обидві таблиці дають той самий ряд, тож Δ0 — це ОЧІКУВАНИЙ результат,
 * а не доказ, що правка мертва. Дзеркало (ряд непорожній) не дає «0 == 0» зеленіти.
 *
 * 🧨 САБОТАЖ (виконано): перевести ряд на `deals.lead_channel` → числа розходяться
 * (передачі ≠ угоди каналу), гейт червоніє.
 */
test("#172 lg_transfers читає append-only leadgen_touch, а не обрізаний реєстр", () => {
  const s = stripComments(src("routes/statisticsSeries.ts"));
  const block = /lg_transfers:[\s\S]*?\n  \},/.exec(s)?.[0] ?? "";
  assert.ok(block, "🔴 не знайдено ряд `lg_transfers` — гейт втратив предмет");

  assert.match(block, /FROM leadgen_touch/,
    "🔴 ряд знову читає `leadgen_registry`, який TRUNCATE-иться щосинку → історія глибше 5 тижнів читається як НУЛЬ");
  assert.doesNotMatch(block, /leadgen_registry/,
    "🔴 у ряд повернувся обрізаний реєстр");
  // Метрика лишається ПЕРЕДАЧАМИ: канал сюди підставляти не можна.
  assert.doesNotMatch(block, /lead_channel/,
    "🔴 ряд «Прорахунки лідгенів» перевели на канал — він почав міряти угоди замість передач, а назва лишилась стара");
  // `transfer_date` — уже DATE за Києвом; друга TZ-конверсія зсунула б ряд на добу.
  assert.doesNotMatch(block, /transfer_date AT TIME ZONE/,
    "🔴 над готовою київською датою застосували TZ вдруге — ряд зсунеться на день");
});

test("#172b ряд передач непорожній і збігається з реєстровим за перекритий період",
  { ...needsApi() }, async () => {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query<{ period: string; touch: string; reg: string }>(
      `WITH t AS (
         SELECT to_char(date_trunc('month', transfer_date::timestamp)::date,'YYYY-MM-DD') AS period,
                COUNT(DISTINCT lead_kommo_id) AS n
           FROM leadgen_touch GROUP BY 1),
       r AS (
         SELECT to_char(date_trunc('month', (transferred_at AT TIME ZONE 'Europe/Kyiv'))::date,'YYYY-MM-DD') AS period,
                COUNT(DISTINCT lead_id) AS n
           FROM leadgen_registry GROUP BY 1)
       SELECT COALESCE(t.period, r.period) AS period,
              COALESCE(t.n, 0) AS touch, COALESCE(r.n, 0) AS reg
         FROM t FULL OUTER JOIN r ON r.period = t.period
        WHERE r.period IS NOT NULL          -- лише період, який реєстр іще тримає
        ORDER BY 1`
    );
    assert.ok(r.rows.length > 0,
      "🔴 реєстр порожній — порівнювати нема з чим (перевірка стала б тривіальною)");

    const drift = r.rows.filter((x) => Number(x.touch) !== Number(x.reg))
      .map((x) => `${x.period}: touch=${x.touch} registry=${x.reg}`);
    assert.deepEqual(drift, [],
      "🔴 append-only слід розійшовся з реєстром на періоді, який реєстр іще тримає — "
      + "заміна джерела ЗМІНИЛА метрику, а мала лише подовжити історію");
  });

/**
 * #173 — МЕРТВІ РЕЄСТРОВІ ФУНКЦІЇ ЗНЯТО, А НЕ ЛИШЕНО «ПРО ЗАПАС».
 *
 * 🔴 Мертва функція з правильною назвою і зеленим `tsc` читається як робоча — так у
 * нас прожив `expected` у `/teams` і наперед написаний `BandHead`. Наступний, кому
 * знадобиться «лідген по менеджеру», узяв би саме `leadgenByManager` і отримав
 * реєстр із історією у пʼять тижнів.
 *
 * 🧨 САБОТАЖ (виконано): повернути `export async function leadgenByManager` →
 * червоніє.
 */
test("#173 leadgenByManager / leadgenByManagerBucket не існують і ніким не кличуться", () => {
  const metricsSrc = stripComments(src("core/metrics.ts"));
  for (const name of ["leadgenByManager", "leadgenByManagerBucket"]) {
    assert.doesNotMatch(metricsSrc, new RegExp(`export async function ${name}\\b`),
      `🔴 \`${name}\` повернулась у ядро — мертвий реєстровий шлях читається як робочий`);
  }
  for (const f of ["routes/dashboard.ts", "jobs/evaluateKpiTasks.ts", "ai/metricTools.ts", "routes/statisticsSeries.ts"]) {
    assert.doesNotMatch(stripComments(src(f)), /metrics\.leadgenByManager/,
      `🔴 ${f} кличе знято́ функцію — збірка б упала, отже гейт спрацював раніше за неї`);
  }
});

/**
 * #173b — ОПИС AI-ІНСТРУМЕНТА НЕ ОБІЦЯЄ ТОГО, ЧОГО ФУНКЦІЯ БІЛЬШЕ НЕ РОБИТЬ.
 *
 * 🔴 Опис — це те, за чим модель ОБИРАЄ інструмент і чим ПОЯСНЮЄ відповідь. Поки він
 * казав «знаменник leadgen_touch за transfer_date», AI чесно переказував би
 * неправду користувачеві — той самий клас, що підпис «синхронізовано із Задачником»
 * над статичним `<span>`: підпис правдоподібний, а величина за ним інша.
 *
 * 🧨 САБОТАЖ (виконано): повернути `leadgen_touch` в опис → червоніє.
 */
test("#173b опис conversion_leadgen_by_manager описує КАНАЛ, а не реєстр", () => {
  const s = src("ai/metricTools.ts");
  const entry = /\{\s*name:\s*"conversion_leadgen_by_manager"[\s\S]*?\},/.exec(s)?.[0] ?? "";
  assert.ok(entry, "🔴 не знайдено інструмент `conversion_leadgen_by_manager`");
  assert.match(entry, /lead_channel/,
    "🔴 опис не називає канал — модель переказуватиме користувачеві неактуальне джерело");
  assert.doesNotMatch(entry, /leadgen_touch|transfer_date/,
    "🔴 в описі лишилось обіцяння реєстру, якого функція вже не читає");
});
