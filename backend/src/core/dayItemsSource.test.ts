import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";
import { kyivMonthBounds } from "./dates.js";

/**
 * 🔎 #175 — РОЗКРИТТЯ ПОЯСНЮЄ ЧИСЛО ДЖЕРЕЛА, А НЕ СПЕРЕЧАЄТЬСЯ З НИМ (Е2, 24.08.2026).
 *
 * 🔴 ЦЕЙ КЛАС ПОМИЛКИ МИ ВЖЕ ДОПУСТИЛИ, І САМЕ ТУТ. 07.08.2026 рядок дня казав
 * «створено 3 · 3н · 0п», а розкриття ТОГО САМОГО числа показувало 1 нового і 2
 * постійних: лічильник рахував повним правилом, а чип — власною двогілковою
 * копією. Розходились 12.6% угод серпня, 15.8% за 12 місяців. Правило звели в
 * одне (`createdKlassCase` / `dealKlassSql`), і `#66b` це тримає — але ДЛЯ
 * НОВИЗНИ. Для ДЖЕРЕЛА такого замка не було.
 *
 * 🔴 І дірка була не теоретична. Е1 зробив джерело партицією з чотирьох кошиків,
 * а розкриття вміло показати рівно два: `sourceOf` зводив `'undef'` у `null`, а
 * чип малювався лише для `ad`/`leadgen`. Тобто 43.2% створених угод («без
 * джерела») стояли в списку БЕЗ ЖОДНОЇ позначки — так само, як угоди, про які
 * нічого не відомо. Число в колонці було, склад на екрані — ні.
 *
 * ⚠️ Приймання Е2 — саме ця рівність, а не «у дрилі зʼявився новий кошик».
 */

const SRC = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело ${rel} — гейт не має права мовчки пропускатись`);
};
const FE = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../frontend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело фронта ${rel}`);
};

/**
 * #175 — ПОРЯДКОВА РІВНІСТЬ ПО КОЖНОМУ ДНЮ: склад розкриття == числу колонки.
 *
 * 🧨 САБОТАЖ: повернути `'undef' → null` у `sourceOf` (тобто злити два кошики) →
 * склад дня перестає збігатись із числом, гейт червоніє з датою й обома числами.
 */
test("#175 склад розкриття за ДЖЕРЕЛОМ == числу дня, по кожному дню", needsDb(), async () => {
  const { dayItems } = await import("./dayItems.js");
  const metrics = await import("./metrics.js");
  const { pool } = await import("../db/pool.js");

  const now = new Date();
  const ym = kyivMonthBounds().ym;
  const from = `${ym}-01`, to = now.toISOString().slice(0, 10);

  // Менеджер із НАЙБІЛЬШОЮ кількістю створених угод місяця: вибірка не випадкова —
  // саме там найбільше шансів зустріти всі кошики одночасно.
  const cand = await pool.query<{ manager_id: number }>(
    `SELECT d.manager_id, COUNT(*) n
       FROM deals d
      WHERE d.pipeline_id = ANY($1) AND d.manager_id IS NOT NULL
        AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3
      GROUP BY d.manager_id ORDER BY n DESC LIMIT 1`,
    [metrics.FC_PIPELINES, from, to]);
  const managerId = cand.rows[0]?.manager_id;
  assert.ok(managerId, "🔴 у базі немає створених угод цього місяця — перевіряти нема на чому");

  const byDay = (await metrics.createdSplitByBucket({ from, to, managerId }, "day"))
    .filter((d) => d.created > 0);
  assert.ok(byDay.length > 0, "🔴 у менеджера немає жодного дня зі створеними — вибірка порожня");

  const bad: string[] = [];
  let sawOther = 0;
  for (const d of byDay) {
    const items = await dayItems("created", managerId, d.bucket);
    const cnt = { ad: 0, leadgen: 0, other: 0, undef: 0, none: 0 };
    for (const it of items.items) {
      const k = (it.source ?? "none") as keyof typeof cnt;
      cnt[k] = (cnt[k] ?? 0) + 1;
    }
    sawOther += cnt.other;
    const want = `${d.adCount}/${d.leadgenCount}/${d.otherCount}/${d.noChannelCount}`;
    const got = `${cnt.ad}/${cnt.leadgen}/${cnt.other}/${cnt.undef}`;
    if (want !== got) bad.push(`${d.bucket}: число ${want} проти складу ${got} (без позначки: ${cnt.none})`);
  }
  assert.deepEqual(bad, [],
    "🔴 РОЗКРИТТЯ СПЕРЕЧАЄТЬСЯ З ЧИСЛОМ ДЖЕРЕЛА. Людина клікає, щоб перевірити цифру, "
    + "і бачить інший розклад — рівно те, що вже сталось із «новий/постійний» 07.08.2026");

  // 🪞 Дзеркало: без нього рівність нулів була б тривіально зелена.
  assert.ok(sawOther > 0,
    "🔴 у складі жодного дня немає кошика «без джерела» — або він не доїжджає до розкриття, "
    + "або вибірка вироджена; заміряно 25.07-24.08: 43.2% усіх створених угод");
});

/**
 * #175b — ПРАВИЛО ДЖЕРЕЛА ЖИВЕ В ОДНОМУ ВИРАЗІ, І РОЗКРИТТЯ РАХУЄ НИМ САМИМ.
 *
 * 🔴 ЧОМУ НЕ ДОСИТЬ #175. Рівність чисел зійдеться й тоді, коли розкриття рахує
 * ВЛАСНОЮ копією правила, яка сьогодні випадково дає ті самі відповіді. Саме так
 * і було з новизною: копія збігалась із ІНШОЮ копією, а не з правилом, і мій же
 * коментар «той самий сенс, що в списку угод дня» був правдою — і тому нешкідливо
 * виглядав. Тому гейт вимагає СПІЛЬНОГО ДЖЕРЕЛА, а не однакового результату.
 *
 * 🧨 САБОТАЖ: вписати в `dayItems` власний CASE по `lead_channel` → червоніє.
 */
test("#175b джерело в розкритті — з ядра, а не власною копією правила", () => {
  const day = SRC("core/dayItems.ts");
  const route = SRC("routes/dashboard.ts");
  const met = SRC("core/metrics.ts");

  // Обидва читачі беруть інлайн-форму ядра.
  assert.match(day, /dealSourceSql\(/,
    "🔴 `dayItems` більше не кличе `dealSourceSql` — значить рахує джерело сам");
  assert.match(route, /metrics\.dealSourceSql\(/,
    "🔴 `/report-plan/deals` більше не кличе `dealSourceSql`");

  // Інлайн-форма — та сама функція, що й CTE-форма агрегату (одне правило, дві подачі).
  assert.match(met, /export const dealSourceSql\s*=\s*\(alias[^)]*\)\s*:\s*string\s*=>\s*dealSourceCase\(/,
    "🔴 інлайн-форма більше не похідна від `dealSourceCase` — правило роздвоїлось");
  assert.match(met, /CREATED_SOURCE_CASE = dealSourceCase\(/,
    "🔴 CTE-форма більше не похідна від `dealSourceCase` — агрегат і розкриття розійдуться");

  // 🔴 І ЖОДНОЇ ВЛАСНОЇ КОПІЇ поруч: у читачів не має бути свого CASE по каналу.
  for (const [name, s] of [["core/dayItems.ts", day]] as const)
    assert.equal(/CASE[\s\S]{0,200}lead_channel\s*=\s*'(ad|leadgen)'/.test(s), false,
      `🔴 у ${name} зʼявився ВЛАСНИЙ розбір каналу — друга копія правила, як це вже було з новизною`);

  // Предикат СТАНУ живе в чистому модулі, і `dayItems` бере його звідти, а не пише свій.
  assert.match(day, /from "\.\/dealSourceState\.js"/,
    "🔴 `dayItems` більше не бере предикат стану з чистого модуля — гілку «канал не вказано» "
    + "стане неможливо саботувати без живої БД, а на проді таких угод нуль");
  assert.equal(/const sourceOf\s*=/.test(day), false,
    "🔴 у `dayItems` знову зʼявився ВЛАСНИЙ `sourceOf` — друга копія предиката стану");
});

/**
 * #175c — ЧОТИРИ СТАНИ ДОЇЖДЖАЮТЬ ДО ЕКРАНА, і «не знаємо» не читається як «немає».
 *
 * 🔴 ДЗЕРКАЛЬНА ПАСТКА (#56 ловить її в Задачнику): поле лишається у відповіді й
 * зникає з верстки. Саме це й було: `source: 'other'` приходив з API, а `SrcChip`
 * малював позначку лише для `ad`/`leadgen`, тож на екрані третій кошик не існував.
 *
 * ⚠️ І «без джерела» ≠ «канал не вказано»: перше — дотику не було, друге — ми не
 * знаємо. Зводити їх в одну позначку означає видати незнання за факт.
 *
 * 🧨 САБОТАЖ: прибрати гілку «без джерела» з чипа → червоніє.
 */
test("#175c чип малює всі чотири джерела, а «не знаємо» підписане окремо", () => {
  const api = FE("api.ts");
  assert.match(api, /export type DealSource\s*=\s*"ad"\s*\|\s*"leadgen"\s*\|\s*"other"\s*\|\s*"undef"\s*\|\s*null/,
    "🔴 тип `DealSource` не має стану «канал не вказано» — він зіллється з «немає даних»");

  const rp = FE("pages/dashboard/sections/ReportPlanSection.tsx");
  const chip = /function SrcChip[\s\S]*?\n\}/.exec(rp)?.[0] ?? "";
  assert.ok(chip, "🔴 не знайдено `SrcChip` — гейт втратив предмет");
  for (const [v, label] of [["ad", "рекл"], ["leadgen", "лідог"], ["other", "без джерела"], ["undef", "канал не вказано"]])
    assert.ok(new RegExp(`"${v}"`).test(chip) && chip.includes(label),
      `🔴 чип не малює джерело «${v}» (${label}) — кошик є в даних і невидимий на екрані`);
});

/**
 * #175d — ГІЛКА «КАНАЛ НЕ ВКАЗАНО» ПЕРЕВІРЯЄТЬСЯ ЧИСТОЮ ФУНКЦІЄЮ, А НЕ ДАНИМИ.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ ГЕЙТ, А НЕ ЧАСТИНА #175. Заміряно: на проді НУЛЬ угод із
 * `lead_channel IS NULL`. Тому саботаж «повернути `'undef' → null`» — тобто рівно
 * той стан, що був до Е2, — лишає #175 ЗЕЛЕНИМ: усі числа ті самі. Перевірка,
 * яка не може провалитись на наявних даних, у прийманні не рахується («порожній
 * результат = провал, а не успіх»), тож гілка стережеться там, де вона є —
 * у предикаті.
 *
 * ⚠️ І це не тимчасовий милиця: щойн `#174e` задзвонить, дані зʼявляться, і #175
 * почне покривати гілку сам. Цей гейт лишається як страховка на порожнечу.
 *
 * 🧨 САБОТАЖ (виконано): `v === "undef" ? null` → червоніє.
 */
test("#175d sourceOf розводить усі чотири стани, і жоден не зводиться в null", async () => {
  const { sourceOf } = await import("./dealSourceState.js");
  assert.equal(sourceOf("ad"), "ad");
  assert.equal(sourceOf("leadgen"), "leadgen");
  assert.equal(sourceOf("other"), "other",
    "🔴 «без джерела» зникло — 43.2% створених угод лишаться без позначки");
  assert.equal(sourceOf("undef"), "undef",
    "🔴 «канал не вказано» злито в null — незнання знову читається як «питання незастосовне»");
  // `null` лишається РІВНО за одним сенсом: рядок — не угода (дзвінок).
  assert.equal(sourceOf(null), null);
  assert.equal(sourceOf("щось-нове-з-ядра"), null,
    "🔴 незнайоме значення мовчки прикинулось відомим станом");
});

