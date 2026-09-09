import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";
import { NEWS_ALIVE, andAlive, DELETE_SQL, newsScope } from "./newsVisibility.js";
import { unreadSinceQuery, unreadByIdQuery, maxVisibleIdQuery } from "./newsSeen.js";
// 🎯 Три запити стали білдерами разом з адресністю (09.09.2026). Гейти нижче про
//    ЖИВЕ/ВИДАЛЕНЕ, тож вкладки їм байдужі — передаємо порожні свідомо.
const UNREAD_COUNT_SQL = unreadSinceQuery(null, []).text;

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
/** Корінь зібраних джерел — для гейтів, що читають сусідні модулі. */
const SRC = path.join(import.meta.dirname, "..");

/**
 * #361 — ВИДАЛЕНА НОВИНА ЗНИКАЄ З УСІХ ЧИТАЧІВ, А НЕ ЛИШЕ ЗІ СПИСКУ.
 *
 * ⚠️ НОМЕР МІНЯВСЯ ДВІЧІ ЗА ОДИН ВИКАТ — #357 → #359 → #361 (08.09.2026), і це вже не
 * курйоз, а діагноз: борг 17 (номер гейта — домовленість до мержу, адреса після) вкусив
 * ДВІЧІ поспіль. Гейт народився як #357; поки гілка жила окремо, у прод поїхав чужий #357
 * («минулі місяці»); я перейменував на #359 — і того ж дня в прод поїхав ще один чужий
 * прохід уже з #359 («нічийні плани»). #358* тримає звільнення цього ж пакета, #360 теж
 * зайнято, тож вільний — #361. Правило 13: назву не уточнюють, беруть НОВИЙ номер.
 * 🔴 Урок для координатора: поки номери роздаються по змердженому стану, кожна гілка
 * бере той самий вільний номер незалежно; справжнє лікування — спільний лічильник поза
 * гілками. Ціна поки — перенумерація в тому, хто мержиться пізніше (тобто в мені).
 *
 * 📐 Куплено 07.09.2026: хрестик робив `DELETE FROM news` — фізично, для всіх, без сліду.
 * Новина про викат зникла за годину, і єдиним доказом її існування була памʼять про id.
 *
 * 🔴 ЧИТАЧІВ ДВОЄ, І ДРУГИЙ ВАЖЛИВІШИЙ. Якби фільтр стояв лише в списку, лічильник
 * непрочитаного рахував би те, чого людина НЕ МОЖЕ відкрити, — і значок не згас би
 * ніколи. Позначка, що не гасне, гірша за її відсутність: її перестають помічати.
 */
test("#361 фільтр видимості стоїть і в списку, і в лічильнику непрочитаного", () => {
  assert.match(UNREAD_COUNT_SQL, new RegExp(NEWS_ALIVE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "🔴 лічильник рахує видалені — значок не згасне ніколи, і його перестануть помічати");
  assert.equal(andAlive(false), `WHERE ${NEWS_ALIVE}`,
    "🔴 без інших умов фільтр не стає WHERE — запит або зламається, або втратить фільтр");
  assert.equal(andAlive(true), `AND ${NEWS_ALIVE}`,
    "🔴 при наявному WHERE фільтр не дописується — видалені повернуться у видачу");
});

/**
 * #361b — 🪞 ДЗЕРКАЛО: видалення МʼЯКЕ й повторне нічого не ламає.
 *
 * Без цієї половини `#361` лишався б зеленим при `DELETE FROM` — фільтр стояв би, але
 * фільтрувати вже не було б чого. Плюс `AND deleted_at IS NULL` у самому оновленні:
 * дві відкриті вкладки не перезапишуть автора й час першого видалення.
 */
test("#361b 🪞 видалення оновлює рядок, а не зносить його, і не перезаписує себе", () => {
  assert.match(DELETE_SQL, /^UPDATE news SET/,
    "🔴 видалення знову фізичне — рядок зникає назавжди, і сліду не лишається");
  assert.doesNotMatch(DELETE_SQL, /DELETE FROM/,
    "🔴 у запиті лишився фізичний DELETE");
  assert.match(DELETE_SQL, /deleted_by = \$2/,
    "🔴 автор видалення не записується — «хто прибрав новину» знову не матиме відповіді");
  assert.match(DELETE_SQL, /AND deleted_at IS NULL/,
    "🔴 повторне видалення перезапише час і автора першого — дві вкладки затруть історію");
});

/**
 * 🔔 #362/#362b — НЕПРОЧИТАНЕ ПО id БРАУЗЕРА, А НЕ ПО КОЛОНЦІ АКАУНТА (08.09.2026).
 *
 * Привід власника: «коли хтось один читає новину, вона для всіх перестає підсвічуватися».
 * Мітка «побачив» жила в `users.news_seen_at` — один рядок на логін, тож спільний акаунт
 * ділив підсвітку. Тепер лічильник рахує проти id, який тримає БРАУЗЕР (`sinceId`).
 *
 * 🔴 ПОВЕДІНКОВО, А НЕ ПО ТЕКСТУ SQL: вставляємо новини, одну мʼяко видаляємо, і міряємо
 * САМ підрахунок. Так ловиться і `id >= $1` замість `id > $1` (побачене рахувалось би
 * знову), і втрата `NEWS_ALIVE` (значок рахував би те, чого не відкрити).
 *
 * 🧨 САБОТАЖ: `id > $1` → `id >= $1` (червоніє #362, бо мітка `a` дала б 2 замість 1);
 *    прибрати `NEWS_ALIVE` (червоніє #362, бо видалена рахувалась би).
 */
test("#362 лічильник рахує ЖИВІ новини з id > мітки браузера", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    const ins = async (title: string) => (await c.query<{ id: number }>(
      `INSERT INTO news (category, title, body, author) VALUES ('company',$1,'x','Дашборд') RETURNING id`,
      [title])).rows[0].id;
    const a = await ins("перша");
    const b = await ins("друга");
    const cc = await ins("третя");

    // мітка = a: живих із id > a → тільки b і c → 2
    let n = (await c.query<{ n: number }>(unreadByIdQuery(a, []).text, unreadByIdQuery(a, []).params)).rows[0].n;
    assert.equal(n, 2, "🔴 з мітки a має бути 2 непрочитані (b,c), а не інше");

    // третю мʼяко видаляємо — вона зникає з лічильника
    await c.query(DELETE_SQL, [cc, null]);
    n = (await c.query<{ n: number }>(unreadByIdQuery(a, []).text, unreadByIdQuery(a, []).params)).rows[0].n;
    assert.equal(n, 1, "🔴 видалена новина досі рахується — значок рахує те, чого не відкрити");

    // «побачене» (id == b) більше не рахується: строге `>`, не `>=`
    n = (await c.query<{ n: number }>(unreadByIdQuery(b, []).text, unreadByIdQuery(b, []).params)).rows[0].n;
    assert.equal(n, 0, "🔴 мітка на останній живій дала непрочитані — це `>=` замість `>`");

    // максимум ЖИВОГО id == b (третю видалено)
    const maxId = (await c.query<{ max_id: number }>(maxVisibleIdQuery([]).text, maxVisibleIdQuery([]).params)).rows[0].max_id;
    assert.equal(maxId, b, "🔴 max живого id враховує видалену — браузер запамʼятає не те");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #362b — 🪞 ДЗЕРКАЛО: свіжа мітка (0 = браузер нічого не бачив) рахує ВСІ живі, тобто
 * лічильник справді реагує на появу новин, а не «завжди 0». Без цієї половини #362
 * лишався б зеленим на коді, що повертає нуль завжди.
 */
test("#362b 🪞 мітка 0 рахує всі живі — лічильник не «завжди нуль»", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    for (const tl of ["одна", "дві", "три"]) await c.query(
      `INSERT INTO news (category, title, body, author) VALUES ('company',$1,'x','Дашборд')`, [tl]);
    const n = (await c.query<{ n: number }>(unreadByIdQuery(0, []).text, unreadByIdQuery(0, []).params)).rows[0].n;
    assert.equal(n, 3, "🔴 з міткою 0 (нічого не бачив) лічильник має дати всі 3 — інакше він мертвий");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #375* / #376* / #377 — АДРЕСНІСТЬ НОВИН
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🎯 #375 — БІЛДЕР ВОЛОДІЄ ВСІМА УМОВАМИ, І НУМЕРАЦІЯ ПАРАМЕТРІВ НЕ ПЛАВАЄ.
 *
 * 📐 Привід технічний і заміряний: у списку новин фільтр за категорією НЕОБОВʼЯЗКОВИЙ,
 * тож параметр аудиторії опиняється то в `$1`, то в `$2`. Сталий рядок SQL такого не
 * вміє — і саме там народилася б друга умова, яка розійдеться з першою.
 */
test("#375 білдер: аудиторія завжди ОСТАННІМ параметром, і «живе» на місці", () => {
  const bez = newsScope(["report"]);
  assert.match(bez.where, /audience_tabs IS NULL OR audience_tabs && \$1::text\[\]/,
    "🔴 без попередніх умов аудиторія має бути $1");
  assert.match(bez.where, new RegExp(NEWS_ALIVE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "🔴 з умов зникло «живе» — мʼяко видалені новини знову в стрічці");
  assert.deepEqual(bez.params, [["report"]], "🔴 параметром має їхати САМЕ масив вкладок");

  const z = newsScope(["report"], ["category = $1"], ["company"]);
  assert.match(z.where, /audience_tabs && \$2::text\[\]/,
    "🔴 з однією попередньою умовою аудиторія має зсунутись на $2 — інакше запит візьме "
    + "категорію за вкладки й мовчки покаже не те");
  assert.deepEqual(z.params, ["company", ["report"]], "🔴 порядок параметрів розійшовся з номерами");

  // 🪞 Порожні вкладки НЕ означають «без умови»: параметр однаково їде, інакше читач без
  //    вкладок отримав би стрічку цілком (див. #376b).
  assert.equal(newsScope([]).params.length, 1,
    "🔴 для читача без вкладок умову прибрали — це і є falsy-колапс, від якого гейт стереже");
});

/**
 * 🤖 #375b — МАШИННІ ЧИТАЧІ НЕ ФІЛЬТРУЮТЬСЯ, І ЦЕ НАВМИСНО.
 *
 * Їх двоє: дедуп RSS (`jobs/syncNews.ts`) і перевірка «той самий блок»
 * (`tools/publishReleaseNews.ts`). Читача-людини в них немає. Дати їм фільтр означало б:
 * перший почне заводити ДУБЛІ статей, другий — публікувати повтори.
 */
test("#375b 🪞 машинні читачі новин фільтра НЕ мають", () => {
  for (const rel of [["jobs", "syncNews.ts"], ["tools", "publishReleaseNews.ts"]]) {
    const src = readFileSync(path.join(SRC, ...rel), "utf8");
    assert.doesNotMatch(src, /newsScope\s*\(/,
      `🔴 ${rel.join("/")} почав фільтрувати новини аудиторією — у нього немає читача, `
      + "тож фільтр там означає дублі (RSS) або повторні публікації (викат)");
  }
});

/**
 * 🎯 #376 / #376b — АДРЕСНА НОВИНА ДОХОДИТЬ ДО СВОГО Й НЕ ДОХОДИТЬ ДО ЧУЖОГО.
 *
 * 🟢 Рішення власника 09.09.2026: статистики для адмінів бачать лише вони; зміна для
 * менеджерів — усі. Джерело правди — `roles.screen_access`, а не другий перелік ролей.
 *
 * 🔴 ДВА ГЕЙТИ, А НЕ ОДИН, І ДРУГИЙ ВАЖЛИВІШИЙ. Односторонній («чужий не бачить»)
 * зеленів би й на коді, що не показує НІКОМУ НІЧОГО — тобто на мертвій стрічці.
 */
test("#376 адресна новина: свій бачить, чужий — ні; «для всіх» бачать обидва", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    const ins = async (title: string, aud: string[] | null) => (await c.query<{ id: number }>(
      `INSERT INTO news (category, title, body, author, audience_tabs)
       VALUES ('company',$1,'x','Дашборд',$2::text[]) RETURNING id`, [title, aud])).rows[0].id;
    await ins("для всіх", null);
    await ins("лише статистики", ["depstats"]);

    const count = async (tabs: string[]) => {
      const { where, params } = newsScope(tabs);
      return (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM news ${where}`, params)).rows[0].n;
    };
    assert.equal(await count(["depstats"]), 2, "🔴 читач ІЗ вкладкою має бачити обидві");
    assert.equal(await count(["report"]), 1, "🔴 читач БЕЗ вкладки має бачити лише «для всіх»");
    // 🪞 Перетин, а не рівність: достатньо ОДНІЄЇ спільної вкладки з переліку новини.
    await ins("дві вкладки", ["depstats", "bank"]);
    assert.equal(await count(["bank"]), 2, "🔴 перетин не працює — новина з кількома вкладками "
      + "має доходити до того, хто має ХОЧ ОДНУ з них");
  } finally { await c.end(); }
});

test("#376b 🪞 читач БЕЗ жодної вкладки бачить лише «для всіх», а не все", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO news (category,title,body,author,audience_tabs)
      VALUES ('company','всім','x','Дашборд',NULL), ('company','адресна','x','Дашборд',ARRAY['depstats'])`);
    const { where, params } = newsScope([]);
    const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM news ${where}`, params)).rows[0].n;
    // 🔴 ЦЕ САМЕ ТА ПОМИЛКА, ЯКОЇ ЛЕГКО ПРИПУСТИТИСЬ: порожній перелік вкладок читача —
    //    стан «кеш ролей не піднявся / роль невідома», і він мусить ЗВУЖУВАТИ, а не
    //    відкривати. Правило проєкту: порожній скоуп не можна виражати нулем.
    assert.equal(n, 1, "🔴 читач без вкладок побачив адресну новину — збій кеша ролей "
      + "відкриває стрічку цілком замість того, щоб її звузити (fail-open замість fail-closed)");
  } finally { await c.end(); }
});

/**
 * 🔔 #377 — ЛІЧИЛЬНИК І «ДОЛИСТАВ ДОСЮДИ» БАЧАТЬ РІВНО ТЕ, ЩО СПИСОК.
 *
 * 🔴 Найтихіше місце всієї зміни. Якщо `maxVisibleIdQuery` лишити глобальним, людина,
 * відкривши стрічку, перестрибне через адресні рядки, яких не бачила, — і якщо її роль
 * ПОТІМ отримає ту вкладку, ті новини вже вважатимуться прочитаними. Назавжди.
 */
test("#377 лічильник == список, і maxId не ковтає невидимого", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO news (category,title,body,author,audience_tabs) VALUES
      ('company','всім-1','x','Д',NULL), ('company','адресна','x','Д',ARRAY['depstats']),
      ('company','всім-2','x','Д',NULL)`);
    const tabs: string[] = ["report"];               // вкладки depstats НЕМАЄ

    const { where, params } = newsScope(tabs);
    const list = (await c.query<{ id: number }>(
      `SELECT id FROM news ${where} ORDER BY id`, params)).rows.map((r) => r.id);
    const bq = unreadByIdQuery(0, tabs);
    const unread = (await c.query<{ n: number }>(bq.text, bq.params)).rows[0].n;
    const mq = maxVisibleIdQuery(tabs);
    const maxId = (await c.query<{ max_id: number }>(mq.text, mq.params)).rows[0].max_id;

    assert.equal(unread, list.length,
      `🔴 лічильник ${unread} ≠ довжина списку ${list.length}: значок рахує те, чого людина `
      + "не може відкрити, і не згасне ніколи");
    assert.equal(maxId, Math.max(...list),
      "🔴 «долистав досюди» більший за найбільший ВИДИМИЙ id — відкривши стрічку, людина "
      + "перестрибне через адресні новини, і вони не спливуть, навіть коли роль отримає вкладку");
    // 🪞 Дзеркало: вибірка не вироджена — адресна новина в базі Є, просто не для цього читача.
    assert.equal(list.length, 2, "🔴 у фікстурі не лишилось невидимої новини — гейт перевіряє порожнечу");
  } finally { await c.end(); }
});
