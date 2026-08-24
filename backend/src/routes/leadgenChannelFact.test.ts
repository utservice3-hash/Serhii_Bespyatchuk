import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsApi } from "../testMode.js";

/**
 * 🔀 #141–#143 — ЛІДГЕН МАЄ ОДНЕ ОЗНАЧЕННЯ: КАНАЛ (рішення власника 24.08.2026).
 *
 * 🔴 ЩО БУЛО. Факт лідгену у Звіті рахувався з `leadgen_touch` ← `leadgen_registry`
 * (аркуш лідоген-бота) за `transfer_date`, а конверсія того самого лідгену — за
 * `d.lead_channel`. Два означення жили поруч і роз'їхались, щойно джерело одного
 * з них просіло:
 *   · реєстр веде лише від 15.06.2026 → бер/кві/тра Звіт показував НУЛЬ (не «мало»,
 *     а «нема даних») при 107/134/121 за каналом;
 *   · з 10.08 реєстр обвалився зі ~130 передач на тиждень до 11-20, і факт поїхав за
 *     ним: у Матюніна 1 при цілі 15, тимчасом як за каналом у нього 5.
 *
 * ✅ ЩО СТАЛО. Факт Звіту, факт KPI-задачі й знаменник лайфтайм-конверсії РПК —
 * усі три беруть КАНАЛ. Реєстр лишається жити (він живить `reclassifyAdChannel`),
 * але жодне число на екрані від нього більше не залежить.
 *
 * ⚠️ ЦІ ГЕЙТИ ХОДЯТЬ У БАЗУ, тож у `npm test` чесно скіпаються і зареєстровані в
 * `ALLOWED_PROD_SKIPS`. Без реєстрації `#19c` справедливо завалив би `test:prod`
 * як «несподіваний скіп» — на цьому вже витрачено прохід (`#117*`).
 */

const SRC = fileURLToPath(new URL("./dashboard.ts", import.meta.url).href.replace("/dist/", "/src/"));
const readDash = (): string => {
  for (const p of [
    fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)),
    fileURLToPath(new URL("../../../backend/src/routes/dashboard.ts", import.meta.url)),
    SRC,
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail("не знайдено джерело routes/dashboard.ts — гейт не має права мовчки пропускатись");
};
const readKpiJob = (): string => {
  for (const p of [
    fileURLToPath(new URL("../../src/jobs/evaluateKpiTasks.ts", import.meta.url)),
    fileURLToPath(new URL("../../../backend/src/jobs/evaluateKpiTasks.ts", import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail("не знайдено джерело jobs/evaluateKpiTasks.ts");
};
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const WEEK = { from: "2026-08-17", to: "2026-08-23" };

/**
 * #141 — ФАКТ ЗВІТУ БЕРЕТЬСЯ З КАНАЛУ, А НЕ З РЕЄСТРУ.
 *
 * Перевіряється ДЖЕРЕЛО в коді роута, бо саме підміна джерела і є зміною: число
 * на екрані однакове в обох випадках рівно доти, доки реєстр не просів.
 *
 * 🧨 САБОТАЖ (виконано): повернути `lgM.get(m.id)?.deals` у рядок факту → червоніє.
 */
test("#141 лідген-факт Звіту рахується за каналом (lead_channel), не за реєстром", async () => {
  const src = stripComments(readDash());

  const line = /leadgen:\s*\{\s*fact:([^,]+),/.exec(src)?.[1] ?? "";
  assert.ok(line, "🔴 не знайдено рядок лідген-факту — гейт втратив предмет");
  assert.match(line, /splitM\.get\(m\.id\)\?\.leadgenCount/,
    "🔴 факт не з канального виразу — повернулась залежність від аркуша лідоген-бота");
  assert.doesNotMatch(line, /lgM/,
    "🔴 факт знову читає реєстр (`leadgen_touch`), який сліпий до 15.06.2026 і обвалився з 10.08");

  // Мертвий виклик реєстру не має лишитись у роуті: живий виклик до джерела,
  // якого ніхто не читає, з часом читається як робочий (урок мертвого `expected`).
  assert.doesNotMatch(src, /metrics\.leadgenByManager\(scope\)/,
    "🔴 у /report-plan лишився виклик `leadgenByManager` — зайвий запит і оманливий слід");
});

/**
 * #141b — 🪞 ДВА КАНАЛЬНІ ВИРАЗИ — ЦЕ ОДНЕ ОЗНАЧЕННЯ, А НЕ ДВА СХОЖІ.
 *
 * 🔴 НАВІЩО. Факт Звіту бере `createdSplitByManager().leadgenCount`, а знаменник
 * конверсії — `conversionByManager(…,'leadgen').taken`. Сьогодні вони тотожні
 * (заміряно: 0 розбіжностей по менеджерах, однакові суми в усіх тижнях), і саме
 * ця тотожність робить перехід безпечним. Але «сьогодні збігається» — не
 * гарантія: варто комусь зсунути фільтр в одному з них, і в системі знову буде
 * два лідгени, тепер уже обидва «канальні». Гейт перетворює збіг на замок.
 *
 * 🧨 САБОТАЖ (виконано): прибрати `m.is_active` в одному з виразів → числа
 * розходяться, гейт червоніє з обома.
 */
test("#141b канальний факт == канальний знаменник конверсії, по кожному менеджеру",
  { ...needsApi() }, async () => {
    const m = await import("../core/metrics.js");
    const split = await m.createdSplitByManager(WEEK);
    const conv = await m.conversionByManager(WEEK, "leadgen");

    const byConv = new Map(conv.map((x) => [x.managerId, x.taken]));
    const bad: string[] = [];
    for (const s of split) {
      const c = byConv.get(s.managerId) ?? 0;
      if (c !== s.leadgenCount) bad.push(`${s.name}: split=${s.leadgenCount} conv=${c}`);
    }
    for (const [id, taken] of byConv) {
      if (taken > 0 && !split.some((s) => s.managerId === id)) bad.push(`mgr ${id}: є в conv (${taken}), немає в split`);
    }
    assert.deepEqual(bad, [],
      "🔴 два канальні вирази розійшлись — у системі знову ДВА означення лідгену");

    // 🪞 Дзеркало: вибірка не має бути порожньою, інакше рівність тривіальна.
    const total = split.reduce((s, x) => s + x.leadgenCount, 0);
    assert.ok(total > 0,
      `🔴 за тиждень ${WEEK.from}..${WEEK.to} канальних лідген-угод нуль — перевіряти нема чого`);
  });

/**
 * #142 — ФАКТ ЗАДАЧІ == ФАКТ ЗВІТУ.
 *
 * 🔴 Задачник і Звіт задумані як ОДНЕ число (принцип «єдине джерело факту KPI»).
 * Поки факт Звіту переїжджав на канал, `evaluateKpiTasks` міг лишитись на реєстрі —
 * і задача рахувала б одне, а екран поруч інше. Саме так і виглядав вихідний баг,
 * лише з іншого боку: ціль 15 проти факту 1.
 *
 * 🧨 САБОТАЖ (виконано): повернути `leadgenByManager` у `factFor` → червоніє.
 */
test("#142 факт KPI-задачі бере те саме канальне джерело, що й Звіт", async () => {
  const job = stripComments(readKpiJob());
  const branch = /case\s+"leadgen_count":[\s\S]{0,240}?;/.exec(job)?.[0] ?? "";
  assert.ok(branch, "🔴 не знайдено гілку `leadgen_count` — гейт втратив предмет");
  assert.match(branch, /createdSplitByManager/,
    "🔴 задача рахує лідген НЕ канальним виразом — розійдеться зі Звітом");
  assert.doesNotMatch(branch, /leadgenByManager/,
    "🔴 у задачі повернувся реєстр — факт задачі й факт Звіту стануть різними числами");
});

/**
 * #142b — ФАКТ БІЛЬШЕ НЕ ЗАЛЕЖИТЬ ВІД `leadgen_touch`.
 *
 * 🔴 Перевірка ПОВЕДІНКОЮ, а не текстом: підміняємо вміст реєстру в транзакції з
 * гарантованим ROLLBACK і вимагаємо, щоб канальне число не зрушило. Це те, чого
 * жоден grep не доводить — і рівно те, що зламалось у серпні.
 *
 * 🧨 САБОТАЖ (виконано): порахувати факт реєстровим виразом → число падає, червоніє.
 */
test("#142b підміна leadgen_touch не рухає канальний факт", { ...needsApi() }, async () => {
  const { pool } = await import("../db/pool.js");
  const m = await import("../core/metrics.js");

  const before = (await m.createdSplitByManager(WEEK)).reduce((s, x) => s + x.leadgenCount, 0);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Зносимо ВЕСЬ реєстр у межах транзакції — найжорсткіша перевірка незалежності.
    await client.query("DELETE FROM leadgen_touch");
    const after = (await m.createdSplitByManager(WEEK)).reduce((s, x) => s + x.leadgenCount, 0);
    assert.equal(after, before,
      "🔴 канальний факт змінився від підміни `leadgen_touch` — залежність від реєстру лишилась");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  // Реєстр на місці після відкату — інакше гейт лишив би по собі порожню таблицю.
  const left = await pool.query<{ n: string }>("SELECT COUNT(*) n FROM leadgen_touch");
  assert.ok(Number(left.rows[0].n) > 0,
            "🔴 після ROLLBACK реєстр порожній — тест зіпсував прод-дані");
});

/**
 * #143 — РПК-КОНВЕРСІЯ: ЧИСЕЛЬНИК І ЗНАМЕННИК З ОДНОГО ОЗНАЧЕННЯ.
 *
 * 🔴 ЦЕ ЛАГОДИТЬ ОКРЕМИЙ, СТАРШИЙ ДЕФЕКТ. Чисельник (`reachedAutoByManager`)
 * рахував за `lead_channel` ЗАВЖДИ, а знаменник брався з `leadgen_touch`, який
 * веде лише від 15.06.2026 — велика верхівка ділилась на куций низ, і лайфтайм-
 * конверсія РПК була ЗАВИЩЕНА. Заміряно: знаменник 997 (реєстр) проти 4289
 * (канал), тобто ×4.3. Коментар над кодом при цьому стверджував «чисельник того
 * самого каналу, що знаменник» — підпис був правдоподібний, а величина за ним інша.
 *
 * 🧨 САБОТАЖ (виконано): повернути `leadgenByManager({})` у знаменник → червоніє.
 */
test("#143 знаменник лайфтайм-конверсії РПК — канальний, як і чисельник", async () => {
  const src = stripComments(readDash());
  const block = /reachedAutoByManager[\s\S]{0,420}?\]\);/.exec(src)?.[0] ?? "";
  assert.ok(block, "🔴 не знайдено блок лайфтайм-конверсії — гейт втратив предмет");

  assert.match(block, /conversionByManager\(\{\},\s*"leadgen"\)/,
    "🔴 знаменник РПК не канальний — конверсія знову ділитиме канальний чисельник на реєстровий низ");
  assert.doesNotMatch(block, /leadgenByManager/,
    "🔴 у знаменник повернувся реєстр: до 15.06.2026 він порожній, тож конверсія завищується");

  // Чисельник і був канальним — фіксуємо це, щоб «вирівняли» не в той бік.
  const num = stripComments(readFileSync(
    fileURLToPath(new URL("../../src/core/metrics.ts", import.meta.url)), "utf8"));
  const fn = /export async function reachedAutoByManager[\s\S]{0,900}?\n\}/.exec(num)?.[0] ?? "";
  assert.ok(fn, "🔴 не знайдено `reachedAutoByManager`");
  assert.match(fn, /lead_channel\s*=\s*'leadgen'/,
    "🔴 чисельник більше не канальний — вирівнювання пішло в бік реєстру, а не каналу");
});
