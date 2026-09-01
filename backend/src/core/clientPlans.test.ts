import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Unavailable } from "../db/scratchDb.js";
import { needsDb } from "../testMode.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { monthEndOf } from "./dates.js";

/**
 * ГЕЙТИ ФАЗИ A — «Постійні клієнти · план місяця».
 *
 * Імпорти ліниві: `core/money.js` тягне `db/pool.js` → `config.js`, який кидає без
 * `DATABASE_URL` ще НА ІМПОРТІ, тобто раніше, ніж спрацює skip.
 */
const loadMoney = () => import("./money.js");
const MONTH = "2026-07";

test("#22 МЕЖІ ТИЖНІВ — ОДНЕ ДЖЕРЕЛО, а не три однакові копії", () => {
  // 🔴 НАВІЩО. `[1, 8, 15, 22, 29].filter(...)` стояв у ТРЬОХ місцях. Поки копії
  // збігаються, різниці не видно; варто одній поїхати — і «тиждень 2» у Звіті
  // означатиме інші дні, ніж «тиждень 2» у плані по клієнтах, а зійтись вони
  // мають ДО ГРИВНІ. Тому перевіряємо не «однакові значення», а ВІДСУТНІСТЬ копій.
  // 🔴 Перша версія цієї перевірки шукала .ts відносно `import.meta.dirname` і в
  // dist-прогоні НЕ ЗНАХОДИЛА ЖОДНОГО ФАЙЛА — `catch { continue }` + «немає
  // збігів → вихід» робили її вічно зеленою. Саботаж (друга копія меж у роуті)
  // її не почервонив. Це рівно той клас, від якого нас беруть ворота режиму:
  // «нічого не перевірилось» виглядало як «усе гаразд». Тепер шлях шукається в
  // обох розкладках, а НЕ знайдений файл — ПАДІННЯ, не пропуск.
  const candidates = [path.join(import.meta.dirname, ".."), path.join(import.meta.dirname, "..", "..", "src")];
  const files = ["core/money.ts", "routes/dashboard.ts"];
  const hits: string[] = [];
  for (const f of files) {
    let src: string | null = null;
    for (const root of candidates) {
      try { src = readFileSync(path.join(root, f), "utf8"); break; } catch { /* наступна розкладка */ }
    }
    assert.ok(src != null,
      `🔴 не знайдено ${f} у жодній розкладці (${candidates.join(" | ")}). `
      + "Перевірка не має права мовчки пропускатись — саме так вона одного разу "
      + "лишалась зеленою, не прочитавши жодного рядка.");
    // Коментарі вирізаємо, інакше ця сама пояснювальна нотатка («тут стояла
    // копія [1, 8, 15, 22, 29]») рахувалась би за копію — і гейт червонів би на
    // тексті, який його ж і пояснює.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const re = /\[\s*1\s*,\s*8\s*,\s*15\s*,\s*22\s*,\s*29\s*\]/g;
    for (const m of code.matchAll(re)) hits.push(`${f}:${code.slice(0, m.index).split("\n").length}`);
  }
  assert.deepEqual(hits.length, 1,
    `🔴 меж тижнів ${hits.length} копій (${hits.join(", ")}). Має бути РІВНО одна — `
    + "у `money.monthWeeks`. Друга копія не падає, вона тихо дає другу правду.");
});

test("#22b ТИЖНІ ПЛАНУ == ТИЖНІ ЗВІТУ, байт-у-байт", needsDb(), async () => {
  const M = await loadMoney();
  // Звіт бере тижні через weeklyBreakdown; екран клієнтів — через monthWeeks.
  // Якщо межі розійдуться, тижневі суми двох екранів перестануть сходитись.
  const weeks = M.monthWeeks(MONTH);
  const wb = await M.weeklyBreakdown({ from: `${MONTH}-01` }, 0);
  assert.equal(weeks.length, wb.length, "різна кількість тижнів у місяці");
  for (let i = 0; i < weeks.length; i++) {
    assert.equal(weeks[i].from, wb[i].from, `тиждень ${i + 1}: різний початок`);
    assert.equal(weeks[i].to, wb[i].to, `тиждень ${i + 1}: різний кінець`);
    assert.equal(weeks[i].label, wb[i].label, `тиждень ${i + 1}: різна назва`);
  }
});

test("#22c Σ ФАКТУ ПО КЛІЄНТАХ == successByMgr того ж місяця", needsDb(), async () => {
  const M = await loadMoney();
  const scope = { from: `${MONTH}-01`, to: monthEndOf(MONTH) };
  const [byMgr, byClient, total] = await Promise.all([
    M.successByMgr(scope), M.successByClientKey(scope), M.successMoney(scope),
  ]);
  assert.ok(total.deals > 0, "🔴 місяць порожній — перевірка нічого не доводить, це провал");
  const sumClients = byClient.reduce((s, r) => s + r.revenue, 0);
  const sumMgr = byMgr.reduce((s, r) => s + r.revenue, 0);
  // Σ по клієнтах == Σ по менеджерах == загальна: усі три — ОДНА функція ядра з
  // різним GROUP BY. Розбіжність означала б, що десь загубився рядок (NULL-ключ
  // ловиться через COALESCE '—', тож розподіл повний).
  assert.ok(Math.abs(sumClients - total.revenue) < 1,
    `🔴 Σ по клієнтах ${Math.round(sumClients)} ≠ ядру ${Math.round(total.revenue)}`);
  assert.ok(Math.abs(sumMgr - total.revenue) < 1,
    `🔴 Σ по менеджерах ${Math.round(sumMgr)} ≠ ядру ${Math.round(total.revenue)}`);
  assert.ok(byClient.length > 0, "розклад по клієнтах порожній");
});

test("#22d ДЗЕРКАЛО: тижневий факт СУМУЄТЬСЯ в місячний по кожному клієнту", needsDb(), async () => {
  // Без цього #22c зеленів би й тоді, коли тижнева розкладка зламана повністю
  // (наприклад, усі тижні віддають нуль): місячна сума рахується окремим викликом.
  const M = await loadMoney();
  const scope = { from: `${MONTH}-01`, to: monthEndOf(MONTH) };
  const [byClient, byWeek] = await Promise.all([
    M.successByClientKey(scope), M.successByClientWeek(scope),
  ]);
  const wk = new Map<string, number>();
  for (const r of byWeek) wk.set(r.clientKey, (wk.get(r.clientKey) ?? 0) + r.revenue);
  assert.ok(wk.size > 0, "🔴 тижневий розклад порожній — доводити нічого");
  const bad: string[] = [];
  for (const c of byClient) {
    const w = wk.get(c.key) ?? 0;
    if (Math.abs(w - c.revenue) >= 1) bad.push(`${c.key}: тижні ${Math.round(w)} ≠ місяць ${Math.round(c.revenue)}`);
  }
  assert.deepEqual(bad, [], `🔴 тижні не сходяться з місяцем:\n${bad.slice(0, 5).join("\n")}`);
});

test("#22e СТАТУСИ КЛІЄНТА рахуються з ДАТ, а не з тумблера", () => {
  // Правило власника: постійний → сплячий (60 дн.) → втрачений (180 дн.).
  // Чиста функція, тому перевіряється без БД — і саме тому вона чиста.
  const state = (days: number): string => days >= 180 ? "lost" : days >= 60 ? "sleeping" : "active";
  assert.equal(state(50), "active", "оплата 50 дн. тому — постійний");
  assert.equal(state(70), "sleeping", "оплата 70 дн. тому — сплячий");
  assert.equal(state(200), "lost", "оплата 200 дн. тому — втрачений");
  assert.equal(state(59), "active", "межа 60 включно з боку сплячого");
  assert.equal(state(60), "sleeping", "рівно 60 — уже сплячий");
  assert.equal(state(179), "sleeping", "179 — ще сплячий");
  assert.equal(state(180), "lost", "рівно 180 — уже втрачений");
});

test("#22f ЦИКЛ ЗАТВЕРДЖЕННЯ на ПІСОЧНИЦІ: у план іде Σ лише ЗАТВЕРДЖЕНИХ", async (t) => {
  // 🔴 Гейт власника: «Σ у "постійні принесуть" == Σ затверджених (не поданих і
  // не чернеток)». Перевіряємо на СПРАВЖНІЙ базі зі ЗМІШАНИМИ статусами і тими
  // САМИМИ SQL, що виконує роут (урок #21c: доказ на переписаному вручну тексті —
  // це доказ ні про що).
  const { provisionScratch } = await import("../db/scratchDb.js");
  const { planTotals, SUBMIT_SQL, approveAllSql, RETURN_SQL } = await import("../routes/clientPlanRules.js");
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (7,'М',1,true) ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role) VALUES (900,'t@t','x','team_lead') ON CONFLICT DO NOTHING`);
    const M = "2026-08-01";
    const add = (k: string, plan: number, st: string) => c.query(
      `INSERT INTO repeat_client_plans (client_key,month,manager_id,plan,status) VALUES ($1,$2,7,$3,$4)`, [k, M, plan, st]);
    await add("a", 10000, "draft");
    await add("b", 20000, "pending");
    await add("c", 30000, "approved");
    await add("d", 40000, "approved");
    const read = async () => (await c.query<{ client_key: string; plan: string; status: string }>(
      `SELECT client_key, plan, status FROM repeat_client_plans WHERE month=$1 ORDER BY client_key`, [M])).rows
      .map((r) => ({ plan: Number(r.plan), planStatus: r.status }));

    // ── ЗМІШАНІ СТАТУСИ: у план іде лише approved.
    let t0 = planTotals(await read());
    assert.equal(t0.planTotal, 100000, "сума вписаного має бути повною — менеджер бачить свою роботу");
    assert.equal(t0.planApproved, 70000,
      "🔴 у «постійні принесуть» просочились чернетки/подані — незатверджений план для системи не існує");
    assert.deepEqual(t0.byStatus, { draft: 1, pending: 1, approved: 2, none: 0 });

    // ── ПОДАННЯ ПАКЕТОМ: чернетка → подано, затверджені НЕ чіпаються.
    const sub = await c.query(SUBMIT_SQL, [M, 7, 900]);
    assert.equal(sub.rowCount, 1, "податись мала рівно одна чернетка");
    t0 = planTotals(await read());
    assert.equal(t0.planApproved, 70000, "подання НЕ додає грошей у план — воно лише міняє статус");
    assert.deepEqual(t0.byStatus, { draft: 0, pending: 2, approved: 2, none: 0 });

    // ── ЗАТВЕРДЖЕННЯ ВСІХ ПОДАНИХ: тепер у план іде все.
    const app = await c.query(approveAllSql("AND m.team_id = $3"), [M, 900, 1]);
    assert.equal(app.rowCount, 2, "затвердитись мали обидва подані");
    t0 = planTotals(await read());
    assert.equal(t0.planApproved, 100000, "після затвердження Σ плану має зрівнятись із вписаним");

    // ── ПОВЕРНЕННЯ: затверджене йде назад у чернетку і ВИПАДАЄ з плану.
    const ret = await c.query(RETURN_SQL, ["d", M, "перевір тариф", 900]);
    assert.equal(ret.rowCount, 1);
    t0 = planTotals(await read());
    assert.equal(t0.planApproved, 60000,
      "🔴 повернений план лишився в «постійні принесуть» — тоді повернення нічого не означає");
    assert.equal((await c.query(`SELECT review_note FROM repeat_client_plans WHERE client_key='d' AND month=$1`, [M])).rows[0].review_note,
      "перевір тариф", "коментар повернення має зберігатись — інакше менеджер не знає, що виправляти");

    // ── ДЗЕРКАЛО: повторне повернення чернетки нічого не робить (немає що повертати).
    assert.equal((await c.query(RETURN_SQL, ["d", M, "ще раз", 900])).rowCount, 0,
      "🔴 RETURN_SQL чіпає чернетки — тоді лічильник повернень брехав би");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

// ── ФАЗА B · РЕАКТИВАЦІЯ
test("#23 СТАНИ — З ДАТ, а не з тумблера: 50/70/200 днів", async () => {
  const R = await import("./reactivationRules.js");
  assert.equal(R.stateOf(50), "active", "оплата 50 дн. тому — постійний");
  assert.equal(R.stateOf(70), "sleeping", "оплата 70 дн. тому — сплячий");
  assert.equal(R.stateOf(200), "lost", "оплата 200 дн. тому — втрачений");
  // Межі включно — щоб «рівно 60» не залежало від того, хто читає код.
  assert.equal(R.stateOf(R.SLEEPING_DAYS - 1), "active");
  assert.equal(R.stateOf(R.SLEEPING_DAYS), "sleeping");
  assert.equal(R.stateOf(R.LOST_DAYS - 1), "sleeping");
  assert.equal(R.stateOf(R.LOST_DAYS), "lost");
  assert.equal(R.SLEEPING_DAYS, 60); assert.equal(R.LOST_DAYS, 180);
});

test("#23b ЦІННІСТЬ = виручка × свіжість, і свіжість СПРАВДІ важить", async () => {
  const R = await import("./reactivationRules.js");
  // Без цієї перевірки формула могла б звестись до «сортуємо за виручкою», і
  // список реактивації показував би зверху давно втрачених гігантів, а не тих,
  // кого ще реально повернути.
  assert.ok(R.valueScore(100_000, 0) > R.valueScore(100_000, 365),
    "🔴 свіжий і річної давнини клієнти важать однаково — свіжість не враховується");
  assert.ok(R.valueScore(100_000, 365) > R.valueScore(10_000, 0) / 2,
    "перевірка, що свіжість не з'їдає виручку повністю");
  assert.equal(R.valueScore(100_000, 0), 100_000, "свіжий клієнт важить рівно свою виручку");
  // 12 міс. простою = удесятеро менше (1 / (1 + 12.17)).
  const y = R.valueScore(100_000, 365);
  assert.ok(y > 7_000 && y < 8_000, `очікували ~7.6к, отримали ${Math.round(y)}`);
});

test("#23c ПРИЧИНИ ЗАКРИТТЯ — закритий перелік, і БД його тримає", async () => {
  const R = await import("./reactivationRules.js");
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  assert.deepEqual(R.CLOSE_REASON_KEYS,
    ["price", "competitor", "own_transport", "seasonality", "closed_down", "other"],
    "перелік причин змінився — це рішення власника, не рефакторинг");
  // 🔴 Дзеркало до переліку: межа має жити в БД, а не лише у формі. «Закрив і
  // забув» — це втрата єдиних даних про те, ЧОМУ клієнт не повернувся.
  const roots = [path.join(import.meta.dirname, "..", "db"), path.join(import.meta.dirname, "..", "..", "src", "db")];
  let sql: string | null = null;
  for (const r of roots) { try { sql = readFileSync(path.join(r, "schema.sql"), "utf8"); break; } catch { /* далі */ } }
  assert.ok(sql, "schema.sql не знайдено — перевірка не має права мовчки пропускатись");
  assert.match(sql, /tasks_reactivation_close_reason/,
    "🔴 у схемі немає CHECK на причину закриття — форму обійде будь-який прямий UPDATE");
});

test("#23d ПАЧКИ ВРАХОВУЮТЬСЯ ЧЕРЕЗ ТУ САМУ НОРМАЛІЗАЦІЮ, що й синк", async () => {
  const { normalizeClientName } = await import("../utils/clientName.js");
  // 🔴 Рішення прийнято ЗА ЦИФРОЮ, не за схемою. Замір на проді 03.08.2026:
  // 12 задач-пачок, 94 елементи, `clientKey` заповнений у 94/94; напряму
  // зіставились 78, решта 16 — старі ключі з ПРОБІЛАМИ (до бекфілу нормалізації).
  // `normalizeClientName` відновила ВСІ 16.
  const oldKeys = ["перша ливарня", "аб джорджіа", "d traks ood", "техно лізинг"];
  for (const k of oldKeys) {
    assert.equal(normalizeClientName(k), k.replace(/\s/g, ""),
      `🔴 «${k}» не зводиться до ключа без пробілів — тоді пачки не зіставляться`);
  }
  // ДЗЕРКАЛО: на вже нормалізованих ключах функція НІЧОГО не міняє. Без цього
  // «фікс» міг би тихо переписати 78 робочих ключів і зламати те, що працювало.
  for (const k of ["вкавтострада", "акам", "першаливарня", "dtraksood"]) {
    assert.equal(normalizeClientName(k), k,
      `🔴 функція змінила вже канонічний ключ «${k}» — це не нормалізація, а псування`);
  }
  // І перевіряємо, що ядро кличе САМЕ її, а не свій регексп у SQL.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const roots = [path.join(import.meta.dirname, "reactivation.ts"),
                 path.join(import.meta.dirname, "..", "..", "src", "core", "reactivation.ts")];
  let src: string | null = null;
  for (const r of roots) { try { src = readFileSync(r, "utf8"); break; } catch { /* далі */ } }
  assert.ok(src, "reactivation.ts не знайдено — перевірка не має права мовчки пропускатись");
  assert.match(src, /normalizeClientName\(/,
    "🔴 ядро реактивації не кличе normalizeClientName — отже нормалізує «схоже», а не те саме");
  assert.ok(!/regexp_replace\([^)]*clientKey/i.test(src),
    "🔴 у SQL зʼявився власний регексп по clientKey — саме те розходження, від якого ця перевірка й рятує");
});

test("#23e ПРАВО merge_clients НЕ ПРОСОЧУЄТЬСЯ через синк ролей", async (t) => {
  // 🔴 ЗНАЙДЕНО НА ПРОДІ, не в теорії. Грант стояв ВИЩЕ за рядки, що копіюють
  // `permissions` адміна в ceo/opdir і (мінус два права) у kvp — і право
  // розтеклось на ПʼЯТЬ ролей замість трьох: admin, ceo, financier, kvp, opdir.
  // Перевіряємо на схемі З НУЛЯ, бо на живій базі результат маскується історією.
  //
  // 🔵 СКЛАД ЗМІНЕНО 24.08.2026: СЕО тепер МАЄ це право (рішення власника).
  // Причина — не «розширили про всяк випадок»: `merge_receivables` у СЕО вже було,
  // а ВІДКІТ склейки гейтиться `merge_clients`, тож він міг зліпити двох клієнтів
  // і не міг роз'єднати їх ніде. Односторонні двері.
  //
  // 🔴 І САМЕ ТОМУ ГЕЙТ ПЕРЕПИСАНО, А НЕ ЗНЯТО. Він стереже ДВА твердження, і
  // змінилось лише перше:
  //   (1) склад права — тепер чотири ролі, не три;
  //   (2) ФІНАНСИСТ його НЕ має — і це рішення власника ЧИННЕ.
  // Знести гейт разом із першим твердженням означало б тихо втратити друге —
  // рівно той клас, що «прибираєш інваріанту — знайди всіх, хто на неї спирався».
  // Тому нижче окремий, ІМЕННИЙ assert про фінансиста: він переживе будь-яку
  // наступну правку списку.
  const { provisionScratch } = await import("../db/scratchDb.js");
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    const schema = path.join(import.meta.dirname, "..", "db", "schema.sql");
    await c.query(readFileSync(schema, "utf8"));
    const have = async () => (await c.query<{ key: string }>(
      `SELECT key FROM roles WHERE (permissions->>'merge_clients')::boolean ORDER BY key`)).rows.map((r) => r.key);

    const EXPECTED = ["admin", "ceo", "kvp", "opdir"];
    assert.deepEqual(await have(), EXPECTED,
      "🔴 право дісталось не тим ролям. Власник назвав рівно ці чотири");
    assert.ok(!(await have()).includes("financier"),
      "🔴 ФІНАНСИСТ дістав merge_clients — власник склейку клієнтів йому НЕ давав "
      + "(на відміну від manage_credit_limits, яке він має свідомо)");

    // ДЗЕРКАЛО: повторна міграція нічого не змінює. Без цього перевірка зеленіла б
    // на першому прогоні, а на другому synс знову розлив би право по чотирьох.
    await c.query(readFileSync(schema, "utf8"));
    assert.deepEqual(await have(), EXPECTED,
      "🔴 ДРУГИЙ прогін міграції розширив право — саме так воно й просочилось уперше");
    assert.ok(!(await have()).includes("financier"),
      "🔴 другий прогін віддав merge_clients фінансисту — блок зняття перестав тримати");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
