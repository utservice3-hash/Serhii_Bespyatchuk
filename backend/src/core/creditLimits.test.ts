import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb, needsApi } from "../testMode.js";
import {
  ANCIENT_DEBT_DAYS, IMPORT_NOTE, isAncientDebt, isOverdue, limitHint, limitLabel, limitState,
  mayOverwriteImported, splitOverdue,
} from "./creditLimits.js";

// Шлях у ДЖЕРЕЛА, а не в `dist`: гейти читають .ts, якого в збірці немає.
// Той самий прийом, що в `receivablesActions.test.ts` — не свій, щоб два
// однотипні набори не розійшлись у тому, ЩО саме вони читають.
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => srcOf(`../${p}`);
const FE = (p: string) => srcOf(`../../../frontend/src/${p}`);

/* ─────────────────────────── чисті правила ─────────────────────────── */

test("#187 NULL ≠ 0: один підпис у колонці, РІЗНА відповідь на «чому» в підказці", () => {
  // 🔴 ЦЕ БІЗНЕС-СЕНС, А НЕ ТЕХНІЧНА ДРІБНИЦЯ (наголос власника 24.08.2026).
  // Обидва означають «ліміт не узгоджено» → перевізника не сплачуємо. Але один
  // прийшов від «клієнта ніколи не розглядали», другий — від «розглянули і
  // відмовили». Звести їх до одного підпису означає стерти відповідь на «чому».
  assert.equal(limitState(null), "never-set");
  assert.equal(limitState(undefined), "never-set");
  assert.equal(limitState(0), "declined");
  assert.equal(limitState(14), "agreed");

  // 🔴 У КОЛОНЦІ підпис ОДИН — так у макеті власника: для людини обидва стани
  // означають рівно одне (відстрочки немає, перевізника не сплачуємо).
  assert.equal(limitLabel(null), limitLabel(0),
    "🔴 у вузькій клітинці зʼявилось два схожі слова про одне й те саме");
  // 🔴 А ВІДПОВІДЬ НА «ЧОМУ» МУСИТЬ ЛИШИТИСЬ РІЗНОЮ. Саме тут і живе `#187`:
  // якщо злити ще й підказку, різниця «не дивились» / «подивились і відмовили»
  // зникне назавжди, і повернути її буде нізвідки.
  assert.notEqual(limitHint(null), limitHint(0),
    "🔴 підказки двох станів збіглись — відповідь на «чому» втрачено");
  assert.equal(limitLabel(14), "14 дн.");

  // 🔴 І НІДЕ НЕ «0 днів»: число нуль у колонці читається як незаповнена комірка.
  assert.ok(!/^0\b/.test(limitLabel(0)), "🔴 підпис починається з «0» — це читається як порожньо");
  assert.match(limitLabel(0), /не узгоджено/);
  assert.match(limitHint(null), /не встановлювали/, "🔴 підказка не пояснює, що ліміт не розглядали");
  assert.match(limitHint(0), /не дали/, "🔴 підказка не пояснює, що ліміт розглянули і відмовили");

  // ⚠️ NULL-ПАСТКА, на якій я спіймався у власному замірі: `Number(null) === 0`.
  // Якби `limitState` порівнював з нулем ДО перевірки на null, усі 45 клієнтів
  // без ліміту стали б «declined» — я саме так і нарахував «54 нулі» замість 9.
  assert.notEqual(limitState(null), limitState(0),
    "🔴 Number(null)===0 — стани злились, перевірка на null має стояти ПЕРШОЮ");
});

test("#188 прострочка — ОДИН вираз, і неузгоджений ліміт поводиться як нульовий", () => {
  // Правило власника 24.08.2026: ліміту немає → будь-який несплачений рахунок
  // прострочений. До Е4 такий клієнт не потрапляв у прострочку НІЯК
  // (`NULL > NULL` = NULL), і плитка мовчки рахувала 39% дебіторки.
  assert.equal(isOverdue(1, null), true, "🔴 клієнт без ліміту знову невидимий для плитки");
  assert.equal(isOverdue(1, 0), true);
  assert.equal(isOverdue(0, null), false, "🔴 нульовий вік не є прострочкою");
  assert.equal(isOverdue(14, 14), false, "🔴 рівно в межах ліміту — ще не прострочка");
  assert.equal(isOverdue(15, 14), true);
  assert.equal(isOverdue(null, 14), false, "🔴 невідомий вік не є прострочкою");

  // Дзеркало: СТАРЕ правило на тих самих даних дає ІНШУ відповідь. Без цього
  // тест зеленів би й на невиправленому виразі.
  const old = (age: number | null, lim: number | null) => age != null && lim != null && age > lim;
  assert.notEqual(isOverdue(5, null), old(5, null),
    "🔴 нове правило збіглося зі старим — заміна не відбулась");
});

test("#189 розклад плитки на дві причини == самій плитці", () => {
  const rows = [
    { ageDays: 20, limitDays: 14 },   // понад узгоджений
    { ageDays: 3,  limitDays: null }, // ліміту не встановлювали
    { ageDays: 40, limitDays: 0 },    // ліміт не дали
    { ageDays: 5,  limitDays: 30 },   // у межах
    { ageDays: null, limitDays: 7 },  // вік невідомий
  ];
  const s = splitOverdue(rows);
  assert.equal(s.total, 3);
  assert.equal(s.beyondAgreed, 1);
  assert.equal(s.noLimitAgreed, 2);
  // 🔴 ГОЛОВНЕ ТВЕРДЖЕННЯ: сума часток == числу. Саме тут «дві копії правила»
  // розійшлися б непомітно — кожна половина виглядала б правдоподібно.
  assert.equal(s.beyondAgreed + s.noLimitAgreed, rows.filter((r) => isOverdue(r.ageDays, r.limitDays)).length);
});

test("#195 заголовок плитки не стверджує «понад ліміт», бо це вже неправда", () => {
  // 🔴 ЗНАЙДЕНО ОКОМ на скріншоті приймання Е4, не гейтом. Плитка звалась
  // «Прострочено (понад ліміт)», а після зміни правила туди входять і клієнти,
  // у яких ліміту НЕМАЄ — заголовок стверджував те, чого число не означає.
  //
  // Той самий клас, що «сер.чек ÷ авто» і «синхронізовано із Задачником»:
  // підпис правдоподібний, а величина за ним інша. Гейт стереже саме підпис,
  // бо жоден інший його не бачить.
  const tiles = readFileSync(FE("pages/dashboard/sections/ReceivablesTiles.tsx"), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.ok(!/Прострочено \(понад ліміт\)/.test(tiles),
    "🔴 заголовок знову обіцяє «понад ліміт», хоч у число входять клієнти без ліміту");
  assert.match(tiles, /kpi-label">Прострочено</,
    "🔴 плитки «Прострочено» немає взагалі");
  // 🪞 ДЗЕРКАЛО: розклад на місці — інакше «просто Прострочено» лишилось би
  // числом без пояснення, і 68 читалось би як 68 боржників у біді.
  assert.match(tiles, /понад узгоджений ліміт/, "🔴 зник розклад — число без пояснення");
  assert.match(tiles, /ліміт не узгоджено/, "🔴 зникла друга половина розкладу");
});

test("#190 висяк підписаний окремо, і поріг НЕ дублює свій сенс", () => {
  // УКРЕНЕРГО-АЛЬЯНС: рахунок із 2023-го, вік 1126 днів. У колонці «днів без
  // оплати» таке число читається як збій розрахунку — власник погодився, що
  // його треба підписати.
  assert.equal(isAncientDebt(1126), true);
  assert.equal(isAncientDebt(364), false);
  assert.equal(isAncientDebt(null), false);
  assert.equal(ANCIENT_DEBT_DAYS, 365, "🔴 поріг змінився — звірте з LONG_LAPSED_DAYS у лояльності");
});

/* ─────────────────────── межі, які тримає БД і сервер ─────────────────────── */

test("#185 примітка обовʼязкова на рівні БД, а не лише роуту", needsDb(), async (t) => {
  // Роут обходить будь-який скрипт; `CHECK` — ні. Той самий прецедент, що
  // `loyalty_overrides.archive_reason` і `receivable_manager_override.note`.
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SRC("db/schema.sql"), "utf8"));
    // 🔴 ТЕСТ НА ВІДХИЛЕННЯ, а не «очима». `CHECK` виглядає бездоганно й тоді,
    // коли не стереже нічого — на цьому ми вже спіймались із NULL у `IN`.
    await assert.rejects(
      () => c.query(`INSERT INTO client_credit_limits (client_key, limit_days, note)
                     VALUES ('т', 14, '   ')`),
      /check|порушує/i, "🔴 БД прийняла ліміт із порожньою приміткою");
    await assert.rejects(
      () => c.query(`INSERT INTO client_credit_limits (client_key, limit_days, note)
                     VALUES ('т', -1, 'причина')`),
      /check|порушує/i, "🔴 БД прийняла відʼємний ліміт");
    // 🪞 ДЗЕРКАЛО: правильний рядок ПРОХОДИТЬ. Інакше `CHECK` міг би різати все
    // підряд, а тест читався б як надійність.
    await c.query(`INSERT INTO client_credit_limits (client_key, limit_days, note)
                   VALUES ('т', 0, 'розглянули і не дали')`);
    const r = await c.query(`SELECT limit_days FROM client_credit_limits WHERE client_key='т'`);
    assert.equal(Number(r.rows[0].limit_days), 0, "🔴 нуль не зберігся — а це повноцінне значення");
  } finally { await c.end(); scratch.dispose(); }
});

test("#186 право manage_credit_limits має РІВНО пʼять ролей, і фінансист серед них", needsDb(), async (t) => {
  // 🔴 ГЕЙТ-ДОКАЗ МІГРАЦІЇ, як `#159c`: до неї червоний, після — зелений.
  // Тиждень тому «Migration applied.» надрукувалось, а права не було — грант
  // стояв ВИЩЕ за блок зняття й гасився тим самим прогоном. Тому склад права
  // перевіряється на схемі З НУЛЯ і ДВІЧІ (друга міграція не має нічого змінити).
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = readFileSync(SRC("db/schema.sql"), "utf8");
    await c.query(schema);
    const have = async () => (await c.query<{ key: string }>(
      `SELECT key FROM roles WHERE (permissions->>'manage_credit_limits')::boolean ORDER BY key`)
    ).rows.map((r) => r.key);
    const EXPECTED = ["admin", "ceo", "financier", "kvp", "opdir"];
    assert.deepEqual(await have(), EXPECTED, "🔴 право дісталось не тим ролям");
    assert.ok((await have()).includes("financier"),
      "🔴 ФІНАНСИСТ втратив право — це скасовує рішення власника 24.08.2026 "
      + "(ліміт відстрочки — фінансове рішення, на відміну від склейки клієнтів)");
    await c.query(schema);
    assert.deepEqual(await have(), EXPECTED, "🔴 другий прогін міграції змінив склад права");
  } finally { await c.end(); scratch.dispose(); }
});

test("#196 вік боргу рахується ПІСЛЯ готівки — інакше готівкові лишаються без віку", async () => {
  // 🔴 ТРЕТІЙ РАЗ НА ОДНІЙ ПАСТЦІ, ТОМУ ГЕЙТ.
  //
  // `insertCashReceivables` додає рядки й рахунки готівкових клієнтів. Усе, що
  // рахується ДО нього, їх фізично не бачить. 23.08 так втратив готівку
  // `recomputeOwners`; 24.08 я повторив це з віком боргу — «МГЕР (готівка)»,
  // 11 рахунків із датами, 225 тис ₴, вік 101 день, а в клітинці порожньо, і
  // рядок випадав із прострочки.
  //
  // Перевіряємо ПОРЯДОК у джерелі: обидва перерахунки мусять стояти ПІСЛЯ
  // вставки готівки. Тест на живих даних цього не спіймав би — він побачив би
  // лише «у МГЕР порожньо», не сказавши чому.
  const src = readFileSync(SRC("jobs/syncReceivables.ts"), "utf8");
  const cash = src.indexOf("await insertCashReceivables(client)");
  const age = src.indexOf("SET overdue_days = a.max_age");
  const owners = src.indexOf("await recomputeOwners(client)");
  assert.ok(cash > 0 && age > 0 && owners > 0, "🔴 один із трьох кроків зник із синку");
  assert.ok(age > cash,
    "🔴 вік боргу рахується ДО вставки готівки — готівкові клієнти лишаться без віку "
    + "і випадуть із плитки «Прострочено»");
  assert.ok(owners > cash,
    "🔴 відповідальний перераховується ДО готівки — регрес, уже виправлений 23.08.2026");
  // 🪞 ДЗЕРКАЛО: вік справді рахується З РАХУНКІВ, а не приходить ззовні.
  // Інакше порядок був би правильний, а джерело — знову гугл-аркуш.
  assert.match(src, /MAX\(\(CURRENT_DATE - invoice_date\)\)/,
    "🔴 вік більше не рахується з дат рахунків");
});

test("#194 право є в ЖИВІЙ базі прода — доказ міграції, а не «Migration applied»", needsApi(), async () => {
  // 🔴 ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ, А НЕ `#186`.
  //
  // `#186` перевіряє схему З НУЛЯ і потребує бінарів PostgreSQL для тимчасового
  // кластера. На прод-сервері їх НЕМАЄ (БД зовнішня, Neon), тож там він чесно
  // пропускається — і доказом того, що міграція ЗАСТОСУВАЛАСЬ НА ПРОДІ, бути не
  // може в принципі. Два різні твердження, два різні гейти:
  //   `#186` — «схема, накочена з нуля, дає правильний склад права»;
  //   `#194` — «на ЦІЙ базі право справді є».
  //
  // Тиждень тому саме друге твердження й провалилось: `migrate` надрукував
  // «Migration applied.», а `ceo.merge_clients` лишився `null`, бо грант стояв
  // вище за блок зняття. Спіймав це окремий запит, а не рядок у виводі.
  const { refreshRoles, rolesCacheSize, roleHasPerm } = await import("../auth/rbac.js");
  await refreshRoles();
  // Роль-кеш модульний і в окремому процесі порожній, а `roleHasPerm` fail-closed.
  // Без цієї перевірки гейт порівнював би відмови — пастка «403/403 → сходиться».
  assert.ok(rolesCacheSize() > 0, "🔴 роль-кеш порожній — усі відповіді fail-closed");

  const MUST = ["admin", "ceo", "financier", "kvp", "opdir"];
  const MUST_NOT = ["manager", "team_lead", "hr"];
  for (const r of MUST) {
    assert.ok(roleHasPerm(r, "manage_credit_limits"),
      `🔴 «${r}» НЕ має manage_credit_limits на живій базі — міграція не застосувалась, `
      + "хоч би що надрукував npm run migrate");
  }
  // 🪞 ДЗЕРКАЛО: право не розтеклось. Без цього гейт зеленів би й тоді, коли
  // воно дісталось УСІМ — а саме так `merge_clients` колись просочився на пʼять
  // ролей замість трьох.
  for (const r of MUST_NOT) {
    assert.ok(!roleHasPerm(r, "manage_credit_limits"),
      `🔴 «${r}» дістав manage_credit_limits — право розтеклось повз рішення власника`);
  }
});

test("#183 повторний імпорт не затирає ручні правки", async () => {
  // Імпортуємо з ЯДРА, не зі скрипта: скрипт тягне `pool` → `config`, який
  // кидає без DATABASE_URL ще на імпорті, і гейт падав би не на суті.
  // Рядок, якого торкалась людина, впізнається за приміткою і НЕ переписується.
  assert.equal(mayOverwriteImported(IMPORT_NOTE), true, "🔴 власний імпортний рядок не можна дозаписати");
  assert.equal(mayOverwriteImported(null), true);
  assert.equal(mayOverwriteImported("КВП погодив 30 днів після дзвінка"), false,
    "🔴 --force затер би рішення людини старим значенням з аркуша, який ніхто не веде");
  assert.equal(mayOverwriteImported(" " + IMPORT_NOTE + " "), true, "🔴 пробіли зробили рядок «ручним»");
});

/* ─────────────────── джерела: фронт і бек кажуть одне ─────────────────── */

test("#180 ліміт у синку береться З ТАБЛИЦІ, а гугл-аркуш більше не джерело", () => {
  const src = readFileSync(SRC("jobs/syncReceivables.ts"), "utf8");
  assert.match(src, /FROM client_credit_limits/,
    "🔴 синк не читає таблицю лімітів — редактор писатиме в порожнечу");
  // 🔴 Аркуш лишився ЛИШЕ для звірки, і його ім'я це каже. Якщо колись його
  // результат знову підставлять у `receivables` — гугл-таблиця повернулась
  // у контур, а власник прибирав її свідомо.
  assert.match(src, /fetchSheetLimitsForReconcile/, "🔴 звірочне читання зникло — #181 нема з чим порівнювати");
  const insertIdx = src.indexOf("INSERT INTO receivables (client_key, client_name");
  const around = src.slice(insertIdx - 1200, insertIdx + 600);
  assert.ok(!/limitsByKey|sheetLimits/.test(around),
    "🔴 у запис `receivables` повернулись ліміти з аркуша");
  // Вік боргу рахується з дат рахунків, а не приходить ззовні.
  assert.match(src, /MAX\(\(CURRENT_DATE - invoice_date\)\)/,
    "🔴 вік боргу більше не рахується з рахунків — він знову звідкись приходить");
});

test("#184 кнопки ліміту немає БЕЗ ПРАВА — умова у фронті, а не 403 після кліку", () => {
  const route = readFileSync(SRC("routes/dashboard.ts"), "utf8");
  assert.match(route, /canSetLimit:\s*roleHasPerm\(auth\.roleKey,\s*"manage_credit_limits"\)/,
    "🔴 сервер не віддає canSetLimit тим самим виразом, що гейтить роут");
  const sec = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(sec, /\{canSetLimit &&/, "🔴 кнопка ліміту малюється без перевірки права");
  assert.match(sec, /<LimitEditor/, "🔴 редактор не підключений");
});

test("#182 фронт і бек рахують прострочку ОДНАКОВО (дзеркало двох мов)", () => {
  const fe = readFileSync(FE("pages/dashboard/receivablesView.ts"), "utf8");
  // Той самий вираз двома мовами. Порівнюємо ПОВЕДІНКУ на спільних випадках,
  // а не текст: текст збігався б і в двох різних правилах.
  const feRule = /overdueDays != null && c\.overdueDays > \(c\.limitDays \?\? 0\)/;
  assert.match(fe, feRule, "🔴 фронт лишився на старому правилі — екран розійдеться з API");
  assert.match(fe, /limitLabel/, "🔴 фронт не має підписів станів ліміту");
  // 🔴 І ЖОДНОЇ ДРУГОЇ КОПІЇ. Інлайн-дубль у секції пережив би зміну правила
  // й показував би стару прострочку поруч із новою плиткою.
  const sec = readFileSync(FE("pages/dashboard/sections/ReceivablesSection.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/overdueDays != null && c\.limitDays != null/.test(sec),
    "🔴 у секції лишилась власна копія правила прострочки");
});

test("#181 нове джерело лімітів НЕ розходиться з Лист20 (перехідний період)", needsApi(), async () => {
  // 🕰 СТРАХОВКА НА ДВА ТИЖНІ, не процес. Після 07.09.2026 цей гейт і читання
  // аркуша прибираються одним комітом — читання «про всяк випадок» через місяць
  // читається як джерело.
  const { pool } = await import("../db/pool.js");
  const { fetchSheetLimitsForReconcile } = await import("../jobs/syncReceivables.js");
  const sheet = await fetchSheetLimitsForReconcile();
  const ours = await pool.query<{ client_key: string; limit_days: number }>(
    `SELECT client_key, limit_days FROM client_credit_limits`);

  // 🪞 ДЗЕРКАЛО ПЕРШИМ: перевіряти має БУТИ ЩО. Порожня таблиця дала б «0
  // розбіжностей» — той самий фальшивий зелений, що «403/403 → сходиться».
  assert.ok((ours.rowCount ?? 0) > 10,
    `🔴 у client_credit_limits лише ${ours.rowCount} рядків — імпорт не відпрацював, і порівнювати нічого`);
  assert.ok(sheet.size > 10, `🔴 аркуш віддав ${sheet.size} рядків — читання зламалось`);

  const diffs: string[] = [];
  for (const [key, lim] of sheet) {
    if (lim.limitDays == null) continue;
    const row = ours.rows.find((r) => r.client_key === key);
    // Клієнта може не бути в нашій таблиці лише тому, що його вже прибрали
    // руками — це РІШЕННЯ людини, а не розходження.
    if (!row) continue;
    if (Number(row.limit_days) !== Number(lim.limitDays)) {
      diffs.push(`${key}: аркуш ${lim.limitDays} / наше ${row.limit_days}`);
    }
  }
  assert.deepEqual(diffs, [],
    `🔴 ${diffs.length} лімітів розійшлись із Лист20 у день викату: ${diffs.slice(0, 5).join(" · ")}`);
});
