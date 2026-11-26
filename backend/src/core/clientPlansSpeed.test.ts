import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { needsBackendEnv } from "../testMode.js";
import { limiter, limitedDb, early, type QueryDb } from "./limitAll.js";
import { ScopeCache, SCOPE_TTL_MS, MACHINE_WRITE_PREFIXES, invalidateOnWrite } from "./scopeCache.js";

/**
 * ⏱ #11240–#11240i — ШВИДКІСТЬ СПИСКУ ПОСТІЙНИХ КЛІЄНТІВ (`GET /dashboard/client-plans`, 26.11.2026).
 *
 * Список збирався 5-7 с: 45 читань одне за одним і без пам'яті (замір прода 26.11.2026). Тепер читання стартують
 * наперед зі стелею одночасності, а готова відповідь пам'ятається 60 с і скидається записом. Обидві речі небезпечні
 * по-своєму, і стережеться саме небезпечне:
 *   · стеля — щоб один екран не забрав усі з'єднання пулу в решти (так `/overview` уже клав сайт);
 *   · ключ пам'яті — щоб один користувач не побачив список іншого;
 *   · скидання записом — щоб людина бачила власну зміну одразу, а не через хвилину.
 */

const src = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело ${rel} — гейт не має права мовчки пропускатись`);
};
const srcDir = (rel: string): string => {
  for (const p of [fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url))]) {
    try { readdirSync(p); return p; } catch { /* далі */ }
  }
  assert.fail(`не знайдено каталог ${rel}`);
};
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const tick = () => new Promise<void>((r) => setImmediate(r));

/** Задача, яку тест завершує сам: видно, скільки їх летить у кожну мить. */
function gate<T>(value: T) {
  let open!: () => void; let fail!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => { open = () => res(value); fail = rej; });
  return { p, open, fail };
}

/**
 * #11240 — СТЕЛЯ ОДНОЧАСНОСТІ. Із 20 задач при стелі 6 одночасно летить рівно 6, решта чекає; звільнилось місце —
 * стартує наступна; усі 20 доходять до кінця. Дзеркало: задач менше за стелю — летять усі одразу (стеля не гальмує
 * малий екран). Термінова задача стає в голову черги, а не в хвіст.
 * 🧨 Червоніє, якщо стеля перестане тримати (`flying >= max` → `flying > max`), черга загубить задачу або термінове
 * піде у хвіст.
 */
test("#11240 СТЕЛЯ: одночасно летить не більше стелі, черга нічого не губить, термінове — в голову черги", async () => {
  const lim = limiter(6);
  const gates = Array.from({ length: 20 }, (_, i) => gate(i));
  let flying = 0, seenPeak = 0;
  const started: number[] = [];
  const all = gates.map((g, i) => lim.run(async () => {
    flying++; seenPeak = Math.max(seenPeak, flying); started.push(i);
    try { return await g.p; } finally { flying--; }
  }));
  await tick();
  assert.equal(flying, 6, "🔴 одразу мусить летіти рівно стільки, скільки дозволяє стеля");
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5], "🔴 черга стартує не в порядку надходження");
  // Термінове читання приходить, коли в черзі вже 14 звичайних: воно мусить стартувати ПЕРШИМ із тих, що чекають.
  const urgentGate = gate("терміново");
  let urgentStartedAfter = -1;
  const urgent = lim.urgent(async () => { urgentStartedAfter = started.length; return urgentGate.p; });
  gates[0].open(); await tick(); await tick();
  assert.equal(urgentStartedAfter, 6, "🔴 термінове читання стало у хвіст черги, а не в голову");
  assert.equal(flying, 5, "звичайних летить п'ять: шосте місце зайняло термінове");
  urgentGate.open();
  for (const g of gates) g.open();
  assert.deepEqual(await Promise.all(all), gates.map((_, i) => i), "🔴 черга загубила або переплутала результат");
  assert.equal(await urgent, "терміново");
  assert.equal(seenPeak, 6, "🔴 у якусь мить летіло більше за стелю");
  assert.equal(lim.peak(), 6, "🔴 лічильник піку бреше: гейт на живий екран спирається саме на нього");

  // 🪞 Дзеркало: чотири задачі при стелі шість летять усі одразу.
  const small = limiter(6); const g4 = Array.from({ length: 4 }, (_, i) => gate(i)); let f2 = 0;
  const r4 = g4.map((g) => small.run(async () => { f2++; return g.p; }));
  await tick();
  assert.equal(f2, 4, "🔴 стеля гальмує екран, якому місця вистачає");
  for (const g of g4) g.open(); await Promise.all(r4);

  // Стеля не може бути нулем чи дробом: такий екран не стартував би взагалі або тримав би стелю «приблизно».
  assert.throws(() => limiter(0)); assert.throws(() => limiter(2.5));
});

/**
 * #11240b — ВІДМОВА ЗАДАЧІ: місце звільняється (інакше одна помилка назавжди зменшила б стелю, а шість помилок
 * зупинили б екран), відмова доходить до того, хто чекає; `limitedDb` проводить запит через ту саму стелю й не міняє
 * ні SQL, ні параметри; `early` не дає ранньому старту стати «необробленою відмовою», яка валить процес Node.
 * 🧨 Червоніє, якщо `finally` перестане звільняти місце, `limitedDb` піде повз чергу або `early` проковтне відмову.
 */
test("#11240b СТЕЛЯ: відмова звільняє місце й доходить до того, хто чекає; запит їде через стелю без змін; ранній старт не валить процес", async () => {
  const lim = limiter(2);
  const boom = new Error("база відмовила");
  await assert.rejects(lim.run(async () => { throw boom; }), boom);
  await assert.rejects(lim.run(() => { throw boom; }), boom, "🔴 синхронний виняток задачі не став відмовою");
  const g = [gate(1), gate(2), gate(3)]; let flying = 0;
  const rs = g.map((x) => lim.run(async () => { flying++; try { return await x.p; } finally { flying--; } }));
  await tick();
  assert.equal(flying, 2, "🔴 після двох відмов стеля зменшилась: місця не звільнились");
  for (const x of g) x.open(); await Promise.all(rs);

  const seen: { sql: string; params?: unknown[] }[] = [];
  const fake: QueryDb = { query: async <R>(sql: string, params?: unknown[]) => { seen.push({ sql, params }); return { rows: [{ ok: 1 }] as unknown as R[], rowCount: 1 }; } };
  const one = limiter(1); const ldb = limitedDb(fake, one.run);
  const hold = gate(0); const blocker = one.run(() => hold.p);
  const q = ldb.query<{ ok: number }>("SELECT $1::int AS ok", [7]);
  await tick();
  assert.equal(seen.length, 0, "🔴 запит пішов у базу повз стелю, поки місце було зайняте");
  hold.open(); await blocker;
  assert.deepEqual((await q).rows, [{ ok: 1 }]);
  assert.deepEqual(seen, [{ sql: "SELECT $1::int AS ok", params: [7] }], "🔴 обгортка змінила SQL або параметри");

  // Ранній старт, результат якого забирають пізніше: до того часу відмова вже сталась. Процес мусить жити,
  // а той, хто нарешті чекає, мусить отримати саме цю відмову.
  let unhandled = 0; const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = early(Promise.reject(boom));
    await tick(); await tick(); await new Promise((r) => setTimeout(r, 5));
    assert.equal(unhandled, 0, "🔴 ранній старт дав необроблену відмову — у бойовому процесі це падіння сервера");
    await assert.rejects(p, boom, "🔴 `early` проковтнув відмову: екран віддав би порожнє замість помилки");
  } finally { process.off("unhandledRejection", onUnhandled); }
});

/**
 * #11240c — КЛЮЧ ПАМ'ЯТІ З АРГУМЕНТІВ. Той самий виклик удруге — з пам'яті (функція не кличеться). Будь-який інший
 * аргумент — менеджер, команда, місяць, право бачити плани без клієнта, доступ до пулу лідгенів — це ІНШИЙ запис:
 * функція кличеться знову й отримує саме свої аргументи. Тобто список команди 5 ніколи не віддається команді 6.
 * Свіжість — 60 с за годинником-параметром: на 59-й секунді з пам'яті, на 61-й рахується заново.
 * 🧨 Червоніє, якщо ключ втратить аргумент (`JSON.stringify(args)` → `args.length`), або термін перестане діяти.
 */
test("#11240c ПАМ'ЯТЬ: ключ — усі аргументи збирача (чуже охоплення не віддається), свіжість 60 с, одночасні запити — одне збирання", async () => {
  const cache = new ScopeCache();
  const calls: unknown[][] = [];
  const build = async (month: string, managerId: number | null, teamId: number | null, canSee: boolean, pool: { canSee: boolean; canTake: boolean }) => {
    calls.push([month, managerId, teamId, canSee, pool]);
    return { who: `${month}/${managerId}/${teamId}/${canSee}/${pool.canSee}/${pool.canTake}` };
  };
  const P = { canSee: false, canTake: false };
  const base = ["2026-11", null, 5, false, P] as const;
  const first = await cache.call("clientPlans", build, ...base);
  assert.equal(first.who, "2026-11/null/5/false/false/false");
  assert.equal(await cache.call("clientPlans", build, ...base), first, "🔴 повторний виклик не з пам'яті");
  assert.equal(calls.length, 1, "🔴 той самий виклик рахувався двічі — пам'ять не працює");

  // Кожен аргумент окремо міняє запис. Якби ключ губив хоч один, тут повернулась би чужа відповідь.
  const variants: (readonly [string, number | null, number | null, boolean, { canSee: boolean; canTake: boolean }])[] = [
    ["2026-11", null, 6, false, P],                           // інша команда
    ["2026-11", 41, null, false, P],                          // менеджер
    ["2026-11", null, null, false, P],                        // усі
    ["2026-10", null, 5, false, P],                           // інший місяць
    ["2026-11", null, 5, true, P],                            // право бачити плани без клієнта
    ["2026-11", null, 5, false, { canSee: true, canTake: false }],  // бачить пул лідгенів
    ["2026-11", null, 5, false, { canSee: true, canTake: true }],   // і може брати з нього
  ];
  for (const v of variants) {
    const got = await cache.call("clientPlans", build, ...v);
    assert.equal(got.who, `${v[0]}/${v[1]}/${v[2]}/${v[3]}/${v[4].canSee}/${v[4].canTake}`, `🔴 охопленню ${JSON.stringify(v)} віддано чужу відповідь`);
  }
  assert.equal(calls.length, 1 + variants.length, "🔴 різні охоплення злиплись в один запис");
  assert.equal(cache.liveKeys().length, 1 + variants.length, "🔴 живих ключів не стільки, скільки різних охоплень");
  assert.equal((await cache.call("clientPlans", build, ...base)).who, first.who, "🔴 прогрів чужими охопленнями змінив відповідь свого");
  assert.equal(calls.length, 1 + variants.length);

  // Свіжість: годинник — параметр, чекати хвилину не треба.
  const ttl = new ScopeCache(); let n = 0; const produce = async () => ++n;
  assert.equal(SCOPE_TTL_MS, 60_000, "🔴 термін пам'яті змінено — це рішення про свіжість екрана, а не технічна правка");
  assert.equal(await ttl.memo("k", produce, 1_000), 1);
  assert.equal(await ttl.memo("k", produce, 1_000 + 59_000), 1, "🔴 на 59-й секунді відповідь уже не з пам'яті");
  assert.equal(await ttl.memo("k", produce, 1_000 + 61_000), 2, "🔴 на 61-й секунді віддано протухлу відповідь");

  // Четверо відкрили екран одночасно: одне збирання на всіх (саме це клало пул під «×4»).
  const herd = new ScopeCache(); const g = gate("відповідь"); let builds = 0;
  const four = Array.from({ length: 4 }, () => herd.memo("k", () => { builds++; return g.p; }, 0));
  g.open();
  assert.deepEqual(await Promise.all(four), ["відповідь", "відповідь", "відповідь", "відповідь"]);
  assert.equal(builds, 1, "🔴 одночасні запити з тим самим ключем збирали відповідь кожен окремо");

  // Помилка збирання в пам'ять не кладеться: наступний запит рахує заново, а не отримує ту саму помилку хвилину.
  const bad = new ScopeCache(); let tries = 0;
  await assert.rejects(bad.memo("k", async () => { tries++; throw new Error("база лягла"); }, 0));
  assert.equal(await bad.memo("k", async () => { tries++; return "ок"; }, 1), "ок");
  assert.equal(tries, 2, "🔴 помилку запам'ятали замість відповіді");

  // Стеля записів: найстаріший іде геть, найсвіжіші лишаються.
  const small = new ScopeCache(60_000, 3);
  for (let i = 0; i < 5; i++) await small.memo(`k${i}`, async () => i, i);
  assert.deepEqual(small.liveKeys(10), ["k2", "k3", "k4"], "🔴 стеля записів не тримає або викидає не найстаріші");
});

/**
 * #11240d — ЗАПИС СКИДАЄ ПАМ'ЯТЬ, І ЧИТАННЯ, ЩО ПЕРЕЖИЛО ЗАПИС, У ПАМ'ЯТЬ НЕ ЛЯГАЄ. Людина поставила план і одразу
 * відкрила список: вона мусить побачити план. Найгірший випадок — список збирався 2 с, план записали на першій
 * секунді: зібрана відповідь уже стара. Той, хто її чекав, отримує її (він питав ДО запису), але наступний запит
 * рахує заново. 🪞 Дзеркало: без запису та сама відповідь у пам'ять лягає — інакше пам'ять не працювала б ніколи.
 * 🧨 Червоніє, якщо `invalidate` перестане міняти покоління або перевірку покоління приберуть.
 */
test("#11240d ПАМ'ЯТЬ І ЗАПИС: після запису рахується заново; відповідь, зібрана поверх запису, у пам'ять не лягає; без запису — лягає", async () => {
  const cache = new ScopeCache(); let n = 0;
  assert.equal(await cache.memo("k", async () => ++n, 0), 1);
  cache.invalidate();
  assert.equal(await cache.memo("k", async () => ++n, 1), 2, "🔴 після запису віддано стару відповідь з пам'яті");

  // Політ стартував ДО запису, завершився ПІСЛЯ.
  const race = new ScopeCache(); const slow = gate("стара");
  const flying = race.memo("k", () => slow.p, 0);
  race.invalidate();                       // запис, поки список збирається
  slow.open();
  assert.equal(await flying, "стара", "той, хто питав до запису, отримує свою відповідь");
  let rebuilt = 0;
  assert.equal(await race.memo("k", async () => { rebuilt++; return "нова"; }, 1), "нова", "🔴 відповідь, зібрана поверх запису, лягла в пам'ять на хвилину");
  assert.equal(rebuilt, 1);
  // Новий запит під час старого польоту після запису не чіпляється до старого польоту.
  const race2 = new ScopeCache(); const old = gate("стара");
  const f1 = race2.memo("k", () => old.p, 0);
  race2.invalidate();
  const f2 = race2.memo("k", async () => "нова", 0);
  old.open();
  assert.equal(await f2, "нова", "🔴 запит після запису приєднався до читання, що стартувало до запису");
  assert.equal(await f1, "стара");
  assert.equal(await race2.memo("k", async () => "ще раз", 1), "нова", "🔴 нова відповідь після запису в пам'ять не лягла");

  // 🪞 Дзеркало: без запису відповідь повільного польоту лягає в пам'ять.
  const calm = new ScopeCache(); const g = gate("відповідь"); let again = 0;
  const p = calm.memo("k", () => g.p, 0); g.open(); await p;
  assert.equal(await calm.memo("k", async () => { again++; return "інша"; }, 1), "відповідь", "🔴 без запису відповідь у пам'ять не лягла — пам'ять не працює");
  assert.equal(again, 0);
});

/**
 * #11240e — ЯКИЙ ЗАПИТ СКИДАЄ ПАМ'ЯТЬ. Читання (GET) — ні. Успішний запис будь-яким роутером — так, і лише ПІСЛЯ
 * того, як відповідь на запис пішла. Невдалий запис (4xx/5xx) — ні: він нічого не змінив. Серцебиття трекера часу —
 * ні (інакше пам'ять жила б секунди); сусідній шлях зі схожою назвою — так.
 * 🧨 Червоніє, якщо GET почне скидати (пам'ять не житиме), успішний POST перестане (людина не побачить своєї зміни),
 * або виняток для трекера розповзеться на сусідні шляхи.
 */
test("#11240e МІДЛВАР: успішний запис скидає пам'ять після відповіді; читання, невдалий запис і серцебиття трекера — ні", () => {
  let drops = 0;
  const mw = invalidateOnWrite({ invalidate: () => { drops++; } });
  const run = (method: string, originalUrl: string, statusCode: number) => {
    const before = drops; let finish: (() => void) | null = null; let nexted = false;
    mw({ method, originalUrl }, { statusCode, on: (_e, cb) => { finish = cb; return undefined; } }, () => { nexted = true; });
    assert.ok(nexted, "🔴 мідлвар не передав запит далі");
    const beforeFinish = drops - before;
    (finish as (() => void) | null)?.();
    return { beforeFinish, after: drops - before };
  };
  assert.deepEqual(run("GET", "/api/dashboard/client-plans?month=2026-11", 200), { beforeFinish: 0, after: 0 }, "🔴 читання скинуло пам'ять — вона не проживе й секунди");
  assert.deepEqual(run("HEAD", "/api/health", 200), { beforeFinish: 0, after: 0 });
  assert.deepEqual(run("POST", "/api/dashboard/repeat-client-plan", 200), { beforeFinish: 0, after: 1 }, "🔴 успішний запис не скинув пам'ять або скинув ДО відповіді");
  assert.deepEqual(run("PUT", "/api/tasks/15", 200), { beforeFinish: 0, after: 1 }, "🔴 запис в іншому роутері (задача) не скинув пам'ять списку");
  assert.deepEqual(run("PATCH", "/api/settings/app", 204), { beforeFinish: 0, after: 1 });
  assert.deepEqual(run("DELETE", "/api/dashboard/client-comment/3", 200), { beforeFinish: 0, after: 1 });
  assert.deepEqual(run("POST", "/api/dashboard/repeat-client-plan", 400), { beforeFinish: 0, after: 0 }, "🔴 невдалий запис скинув пам'ять");
  assert.deepEqual(run("POST", "/api/tasks", 500), { beforeFinish: 0, after: 0 });
  // Трекер: виняток рівно на його префікс.
  assert.deepEqual([...MACHINE_WRITE_PREFIXES], ["/api/tracker/", "/api/messages/heartbeat"],
    "🔴 перелік машинних записів змінено — кожен новий запис доводиться власним гейтом (#11240f трекер, #11240i «я онлайн»)");
  assert.deepEqual(run("POST", "/api/tracker/heartbeat", 200), { beforeFinish: 0, after: 0 }, "🔴 серцебиття трекера скидає пам'ять списку");
  assert.deepEqual(run("POST", "/api/tracker-report/save", 200), { beforeFinish: 0, after: 1 }, "🔴 виняток трекера накрив сусідній шлях");
  assert.deepEqual(run("POST", "/api/dashboard/tracker/x", 200), { beforeFinish: 0, after: 1 }, "🔴 виняток спрацьовує не за початком шляху");
  // «Я онлайн» месенджера: виняток рівно на цей шлях (з рядком запиту чи без), решта месенджера скидає.
  assert.deepEqual(run("POST", "/api/messages/heartbeat", 200), { beforeFinish: 0, after: 0 }, "🔴 «я онлайн» скидає пам'ять списку — при людях онлайн вона не проживе й секунди");
  assert.deepEqual(run("POST", "/api/messages/heartbeat?t=1", 200), { beforeFinish: 0, after: 0 }, "🔴 рядок запиту зламав упізнавання «я онлайн»");
  assert.deepEqual(run("POST", "/api/messages/heartbeats", 200), { beforeFinish: 0, after: 1 }, "🔴 виняток «я онлайн» накрив сусідній шлях");
  assert.deepEqual(run("POST", "/api/messages/heartbeat/x", 200), { beforeFinish: 0, after: 1 }, "🔴 виняток «я онлайн» став префіксом");
  assert.deepEqual(run("POST", "/api/messages/17", 200), { beforeFinish: 0, after: 1 }, "🔴 виняток «я онлайн» накрив увесь месенджер");
});

/**
 * #11240f — ВИНЯТОК ДЛЯ ТРЕКЕРА ЧЕСНИЙ: його роутер пише ЛИШЕ у власні таблиці `tracker_*`, а збирач списку жодної
 * з них не читає. Якщо трекер почне писати щось, що читає список (або список почне читати трекер), серцебиття
 * мусить знову скидати пам'ять — і цей гейт про це скаже.
 * 🧨 Червоніє, якщо в `routes/tracker.ts` чи `tracker/` з'явиться запис у чужу таблицю, або збирач згадає `tracker_`.
 */
test("#11240f ТРЕКЕР ПИШЕ ЛИШЕ СВОЇ ТАБЛИЦІ, і список постійних клієнтів їх не читає — тому його серцебиття пам'ять не скидає", () => {
  const files = [src("routes/tracker.ts"), ...readdirSync(srcDir("tracker")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(path.join(srcDir("tracker"), f), "utf8"))].map(codeOnly);
  const writes = files.flatMap((f) => [...f.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(writes.length >= 3, `🔴 записів трекера знайдено ${writes.length} — гейт втратив предмет (очікуємо щонайменше пристрої й інтервали)`);
  const foreign = writes.filter((t) => !t.startsWith("tracker_"));
  assert.deepEqual(foreign, [], `🔴 трекер пише у чужі таблиці: ${foreign.join(", ")} — виняток у MACHINE_WRITE_PREFIXES більше не чесний`);
  const dash = src("routes/dashboard.ts");
  const start = dash.indexOf("\nasync function buildClientPlans(");
  assert.ok(start > 0, "🔴 збирач списку не знайдено");
  const builder = codeOnly(dash.slice(start, dash.indexOf("\ndashboardRouter.", start)));
  assert.ok(builder.length > 20_000, "🔴 зріз збирача підозріло короткий — перевіряти нічого");
  assert.doesNotMatch(builder, /\btracker_[a-z]/, "🔴 список читає таблицю трекера — серцебиття мусить скидати пам'ять");
});

/**
 * #11240i — ВИНЯТОК ДЛЯ «Я ОНЛАЙН» ЧЕСНИЙ. `POST /api/messages/heartbeat` шле кожна відкрита вкладка раз на 30 с
 * (`frontend/src/components/Layout.tsx`); він пише ЛИШЕ `users.last_seen`. Жоден модуль, до якого дотягується роутер
 * дашборда (усі його імпорти, прямі й через інших, включно з лінивими), цієї колонки не згадує — отже список її не
 * читає й відповідь від серцебиття не залежить. Знайдено перевіркою в браузері 27.11.2026: без винятку власне
 * серцебиття вкладки чистило пам'ять одразу після відкриття.
 * 🧨 Червоніє, якщо серцебиття почне писати ще щось, або будь-який модуль у досяжності роутера дашборда прочитає
 * `last_seen` — тоді виняток більше не чесний і «я онлайн» мусить знову скидати пам'ять.
 */
test("#11240i «Я ОНЛАЙН» ПИШЕ ЛИШЕ users.last_seen, і жоден модуль у досяжності роутера дашборда його не читає — тому серцебиття вкладки пам'ять не скидає", () => {
  const msg = codeOnly(src("routes/messages.ts"));
  const hStart = msg.indexOf('messagesRouter.post("/heartbeat"');
  assert.ok(hStart > 0, "🔴 обробник «я онлайн» не знайдено — гейт втратив предмет");
  const handler = msg.slice(hStart, msg.indexOf("\nmessagesRouter.", hStart + 10));
  const writes = [...handler.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)([^`]*)/g)].map((m) => `${m[1].replace(/\s+/g, " ")} ${m[2]}${m[3]}`.trim());
  assert.deepEqual(writes, ["UPDATE users SET last_seen = now() WHERE id = $1"], "🔴 «я онлайн» пише не лише users.last_seen — виняток у MACHINE_WRITE_PREFIXES більше не чесний");

  // Досяжність: від routes/dashboard.ts по всіх відносних імпортах (статичних і `await import`).
  const root = srcDir("routes");
  const seen = new Set<string>(); const queue = [path.join(root, "dashboard.ts")];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    let text: string; try { text = readFileSync(f, "utf8"); } catch { continue; }
    seen.add(f);
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)\.js["']/g)) queue.push(path.resolve(path.dirname(f), `${m[1]}.ts`));
  }
  const rel = (f: string) => path.relative(path.dirname(root), f).split(path.sep).join("/");
  const reach = [...seen].map(rel);
  assert.ok(reach.length >= 150, `🔴 у досяжності роутера дашборда лише ${reach.length} модулів — обхід імпортів зламався, перевіряти нічого`);
  for (const must of ["core/reactivation.ts", "core/clientLeadFacts.ts", "core/clientSegments.ts", "core/money.ts"]) {
    assert.ok(reach.includes(must), `🔴 ${must} не в досяжності — обхід імпортів губить модулі, з яких збирається список`);
  }
  const readers = [...seen].filter((f) => /\blast_seen\b(?!_)/.test(codeOnly(readFileSync(f, "utf8")))).map(rel);
  assert.deepEqual(readers, [], `🔴 модуль у досяжності роутера дашборда читає last_seen: ${readers.join(", ")} — «я онлайн» мусить скидати пам'ять`);
  // Дзеркало: сам пошук колонку бачить (інакше порожній список вище нічого не означав би).
  assert.match(codeOnly(src("routes/messages.ts")), /\blast_seen\b(?!_)/, "🔴 пошук last_seen не знаходить її навіть у месенджері — регулярка сліпа");
});

/**
 * #11240g — ПРОВОДКА ПАМ'ЯТІ Й СТЕЛІ В РОУТІ. (1) Обробник віддає `clientPlansCache.call(…)`, і в ключ їдуть УСІ
 * п'ять аргументів збирача. (2) Збирач — функція рівня модуля з рівно цими п'ятьма параметрами, без `req` / `res` /
 * `auth`: він фізично не може порахувати щось із того, чого немає в ключі. (3) Відмова доступу (403 тімліду на чужого
 * менеджера) стоїть ДО пам'яті. (4) У збирачі база трапляється рівно двічі — в обгортках стелі; голого `pool.query`
 * чи `(pool, …)` немає. (5) Стеля — 6 із 15 з'єднань пулу. (6) Сегменти читаються раз і передаються в стан
 * реактивації готовими. (7) `index.ts` ставить скидання записом ПЕРЕД роутерами.
 * 🧨 Червоніє, якщо в ключ не потрапить аргумент, збирач полізе в `auth`, читання піде повз стелю, сегменти знову
 * читатимуться двічі або мідлвар опиниться після роутерів (тоді він не бачитиме жодного запису).
 */
test("#11240g ПРОВОДКА: у ключі пам'яті всі аргументи збирача; збирач не бачить auth; читання лише через стелю; запис скидає пам'ять перед роутерами", () => {
  const dash = codeOnly(src("routes/dashboard.ts"));
  const start = dash.indexOf('dashboardRouter.get("/client-plans"');
  const bStart = dash.indexOf("\nasync function buildClientPlans(", start);
  const end = dash.indexOf("\ndashboardRouter.", start + 10);
  assert.ok(start > 0 && bStart > start && end > bStart, "🔴 обробник і збирач /client-plans не впізнано — гейт втратив предмет");
  const handler = dash.slice(start, bStart), builder = dash.slice(bStart, end);

  assert.match(handler, /res\.json\(await clientPlansCache\.call\("clientPlans", buildClientPlans, monthStr, managerId, teamId, isAdminScope\(auth\), leadgenPool\)\);/,
    "🔴 обробник віддає відповідь не через пам'ять або в ключ їдуть не всі аргументи");
  assert.match(builder, /^\nasync function buildClientPlans\(monthStr: string, managerId: number \| null, teamId: number \| null,\s*canSeeUnattached: boolean, leadgenPool: \{ canSee: boolean; canTake: boolean \}\) \{/,
    "🔴 параметри збирача змінились — звір із тим, що обробник кладе в ключ (кожен новий параметр мусить бути в `call`)");
  assert.doesNotMatch(builder, /\b(?:req|auth)\b|\bres\./, "🔴 збирач читає req / res / auth — відповідь залежить від того, чого немає в ключі пам'яті");
  assert.ok(handler.indexOf('return res.status(403).json({ error: "Лише своя команда" })') > 0
    && handler.indexOf('return res.status(403)') < handler.indexOf("clientPlansCache.call"), "🔴 відмова тімліду на чужого менеджера стоїть не перед пам'яттю");

  // Ідентифікатор `pool`, а не слово в лапках (статус циклу реактивації "pool" — це дані, не база).
  const poolUses = [...builder.matchAll(/(?<!["'.\w])pool(?!["'\w])/g)].length;
  assert.equal(poolUses, 2, `🔴 у збирачі база згадана ${poolUses} раз(и), а має рівно двічі — в обгортках стелі; читання повз стелю забирає з'єднання в решти`);
  assert.match(builder, /const ldb = limitedDb\(pool, lim\.run\);/);
  assert.match(builder, /const udb = limitedDb\(pool, lim\.urgent\);/);
  assert.match(dash, /\nconst CLIENT_PLANS_PARALLEL = 6;\n/, "🔴 стеля одночасності списку змінена — пул має 15 з'єднань на ВЕСЬ процес");
  assert.match(builder, /const lim = limiter\(CLIENT_PLANS_PARALLEL\);/);
  assert.match(codeOnly(src("db/pool.ts")), /\bmax: 15\b/, "🔴 розмір пулу змінено — перевір стелю списку (вона мусить лишати з'єднання решті екранів)");

  assert.equal([...builder.matchAll(/\bloadClientSegments\(/g)].length, 1, "🔴 сегменти у збирачі читаються не один раз");
  assert.match(builder, /reactivation\.clientStates\(\{[^}]*\},\s*\{ includeActive: true, segments: segP \}\)/, "🔴 стан реактивації знову читає сегменти сам (друге читання на 0,2 с)");
  assert.match(codeOnly(src("core/reactivation.ts")), /const seg = await \(opts\.segments \?\? loadClientSegments\(\)\);/, "🔴 ядро не бере передані сегменти");

  const index = codeOnly(src("index.ts"));
  const mw = index.indexOf('app.use("/api", invalidateOnWrite(clientPlansCache));');
  const firstRouter = index.search(/app\.use\("\/api\/[a-z-]+", [a-zA-Z]+Router\)/);
  assert.ok(mw > 0, "🔴 скидання пам'яті записом не підключено — людина хвилину не бачитиме власної зміни");
  assert.ok(firstRouter > 0 && mw < firstRouter, "🔴 скидання пам'яті стоїть ПІСЛЯ роутерів — жодного запису воно не побачить");
});

/**
 * #11240h — ЖИВИЙ ЕКРАН: одне відкриття списку не тримає більше 6 читань одночасно; друге відкриття — з пам'яті, без
 * жодного читання списку; після запису — знову рахується. Міряється на справжньому обробнику, бо гейт на джерело
 * (#11240g) не бачить читань, які роблять модулі ядра всередині себе.
 * 🧨 Червоніє, якщо хтось додасть читання повз стелю (у збирач чи в модуль ядра, що всередині йде `Promise.all`),
 * або пам'ять перестане працювати наскрізь.
 */
test("#11240h ЖИВИЙ ЕКРАН: відкриття списку — не більше 6 читань одночасно; повторне — з пам'яті; після запису рахується заново (жива БД)", needsBackendEnv(), async () => {
  const { pool } = await import("../db/pool.js");
  const { dashboardRouter } = await import("../routes/dashboard.js");
  const { clientPlansCache } = await import("./scopeCache.js");
  const layer = (dashboardRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }[] })
    .stack.find((l) => l.route?.path === "/client-plans" && l.route.methods.get);
  assert.ok(layer?.route, "🔴 роут /client-plans не знайдено — гейт втратив предмет");
  const handle = layer!.route!.stack[layer!.route!.stack.length - 1].handle;

  let flying = 0, peak = 0, reads = 0;
  const orig = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: unknown }).query = (...a: unknown[]) => {
    if (typeof a[a.length - 1] === "function") return orig(...a);
    reads++; flying++; if (flying > peak) peak = flying;
    return orig(...a).finally(() => { flying--; });
  };
  const open = (): Promise<{ clients?: unknown[] }> => new Promise((done, fail) => {
    Promise.resolve(handle({ auth: { role: "admin", roleKey: "admin", managerId: null, teamId: null, userId: 0 }, query: {}, params: {} },
      { json(b: { clients?: unknown[] }) { done(b); return this; }, status() { return this; }, setHeader() { return this; } },
      (e?: unknown) => fail(e ?? new Error("роут пішов у next() без відповіді")))).catch(fail);
  });
  try {
    clientPlansCache.invalidate();
    const first = await open();
    const firstReads = reads;
    assert.ok(Array.isArray(first.clients) && first.clients.length > 0, "🔴 список порожній — міряти одночасність нема на чому");
    assert.ok(firstReads >= 20, `🔴 відкриття зробило лише ${firstReads} читань — обгортка лічильника не бачить читань екрана`);
    assert.ok(peak <= 6, `🔴 одночасно летіло ${peak} читань при стелі 6 — якесь читання йде повз стелю`);
    assert.ok(peak >= 3, `🔴 одночасно летіло щонайбільше ${peak} — читання знову йдуть по черзі`);

    reads = 0;
    const second = await open();
    assert.equal(second, first, "🔴 повторне відкриття в межах хвилини віддало не ту саму відповідь з пам'яті");
    assert.ok(reads <= 2, `🔴 повторне відкриття зробило ${reads} читань — список зібрано заново, пам'ять не працює`);

    clientPlansCache.invalidate();
    reads = 0;
    await open();
    assert.ok(reads >= 20, "🔴 після запису список віддано з пам'яті — людина не побачить власної зміни");
  } finally {
    (pool as unknown as { query: unknown }).query = orig;
    clientPlansCache.invalidate();
  }
});

// ───────────────────────────── браузер: одна копія списку на вкладку ─────────────────────────────

const FE = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../../frontend/src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../frontend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело фронту ${rel} — гейт не має права мовчки пропускатись`);
};
interface FeStore {
  CLIENT_PLANS_FRESH_MS: number;
  clientPlansKey: (p: { userId: number | null; month: string }) => string;
  isWriteMethod: (m: string | undefined) => boolean;
  MACHINE_WRITE_URLS: readonly string[];
  clearsClientPlans: (m: string | undefined, url: string | undefined) => boolean;
  ClientPlansMemory: new (freshMs?: number, clock?: () => number) => {
    peek: (key: string) => unknown;
    load: <T>(key: string, fetch: () => Promise<T>, force?: boolean) => Promise<T>;
    clear: () => void;
  };
}
async function loadStore(): Promise<FeStore> {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE("pages/dashboard/clientPlansStore.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`) as Promise<FeStore>;
}
const fakeClock = () => { let t = 0; return { now: () => t, set: (v: number) => { t = v; } }; };

/**
 * #11241 — ПАМ'ЯТЬ ВКЛАДКИ БРАУЗЕРА (виконанням, годинник — фікстура). Друга вкладка («Плани» після «З ким говорити»)
 * бере список без запиту; на 59-й секунді — ще з пам'яті, на 61-й — новий запит; інший користувач чи місяць —
 * інший запис (після виходу й входу іншої людини в тій самій вкладці чужий список не показується); дві вкладки,
 * що відкрились одночасно, роблять один запит.
 * 🧨 Червоніє, якщо з ключа зникне користувач або місяць, свіжість перестане діяти, або одночасні відкриття підуть
 * на сервер кожне окремо.
 */
test("#11241 ПАМ'ЯТЬ ВКЛАДКИ: друга вкладка бере список без запиту; свіжість 60 с; у ключі користувач і місяць; одночасні відкриття — один запит", async () => {
  const m = await loadStore();
  assert.equal(m.CLIENT_PLANS_FRESH_MS, 60_000, "🔴 свіжість списку у вкладці змінено — це рішення про екран, а не технічна правка");
  const clock = fakeClock();
  const mem = new m.ClientPlansMemory(m.CLIENT_PLANS_FRESH_MS, clock.now);
  const k = m.clientPlansKey({ userId: 7, month: "2026-11" });
  let fetches = 0; const fetch = async () => ({ n: ++fetches });
  assert.equal(mem.peek(k), undefined, "порожня пам'ять нічого не віддає");
  const first = await mem.load(k, fetch);
  assert.equal(fetches, 1);
  assert.equal(mem.peek(k), first, "🔴 щойно завантажений список не видно синхронно — друга вкладка намалює «завантаження…»");
  clock.set(59_000);
  assert.equal(await mem.load(k, fetch), first, "🔴 на 59-й секунді список уже не з пам'яті");
  assert.equal(fetches, 1, "🔴 друга вкладка пішла на сервер, хоча список свіжий");
  clock.set(61_000);
  assert.equal(mem.peek(k), undefined, "🔴 на 61-й секунді віддано протухлий список");
  assert.deepEqual(await mem.load(k, fetch), { n: 2 });

  // Ключ: інший користувач і інший місяць — інші записи; порядок полів не змішує їх.
  const keys = [m.clientPlansKey({ userId: 7, month: "2026-11" }), m.clientPlansKey({ userId: 8, month: "2026-11" }),
    m.clientPlansKey({ userId: 7, month: "2026-10" }), m.clientPlansKey({ userId: null, month: "2026-11" })];
  assert.equal(new Set(keys).size, 4, "🔴 різні користувачі чи місяці дали один ключ — людина побачить чужий список");
  const other = await mem.load(keys[1], fetch);
  assert.deepEqual(other, { n: 3 }, "🔴 іншому користувачеві віддано список попереднього");

  // Дві вкладки стартували разом: один запит на обох.
  const mem2 = new m.ClientPlansMemory(60_000, clock.now); const g = gate("список"); let n2 = 0;
  const a = mem2.load("k", () => { n2++; return g.p; }), b = mem2.load("k", () => { n2++; return g.p; });
  g.open();
  assert.deepEqual(await Promise.all([a, b]), ["список", "список"]);
  assert.equal(n2, 1, "🔴 одночасні відкриття зробили два запити");
});

/**
 * #11241b — ПІСЛЯ ДІЇ КОРИСТУВАЧА. `force` іде на сервер, навіть коли список свіжий (людина поставила план і мусить
 * його побачити). Якщо старе читання стартувало ДО дії, а прийшло ПІСЛЯ нового — у пам'яті лишається нове. Запис
 * будь-де (`clear`) забуває все, і читання, що летіло під час запису, у пам'ять не лягає. Дзеркало: GET пам'ять
 * не чіпає — інакше вона не жила б.
 * 🧨 Червоніє, якщо `force` почне брати з пам'яті, перевірку номера читання приберуть, або читання стане «записом».
 */
test("#11241b ПАМ'ЯТЬ ВКЛАДКИ ПІСЛЯ ДІЇ: перечитування завжди з сервера; обігнана відповідь у пам'ять не лягає; запис забуває все, читання — ні", async () => {
  const m = await loadStore();
  const clock = fakeClock();
  const mem = new m.ClientPlansMemory(60_000, clock.now);
  let fetches = 0;
  await mem.load("k", async () => `v${++fetches}`);
  assert.equal(await mem.load("k", async () => `v${++fetches}`, true), "v2", "🔴 після дії список узято з пам'яті — людина не бачить своєї зміни");
  assert.equal(mem.peek("k"), "v2", "🔴 перечитаний список не замінив старий у пам'яті");

  // Старе читання (до дії) приходить ПІСЛЯ нового (після дії): у пам'яті мусить лишитись нове.
  const race = new m.ClientPlansMemory(60_000, clock.now);
  const old = gate("до дії"), fresh = gate("після дії");
  const p1 = race.load("k", () => old.p);
  const p2 = race.load("k", () => fresh.p, true);
  fresh.open(); await p2;
  old.open(); await p1;
  assert.equal(race.peek("k"), "після дії", "🔴 відповідь, що стартувала до дії, затерла свіжу — у вкладці хвилину висітиме старий список");
  // І навпаки: старе прийшло першим — теж не лягає, бо вже є новіше читання.
  const race2 = new m.ClientPlansMemory(60_000, clock.now);
  const old2 = gate("до дії"), fresh2 = gate("після дії");
  const q1 = race2.load("k", () => old2.p); const q2 = race2.load("k", () => fresh2.p, true);
  old2.open(); await q1;
  assert.equal(race2.peek("k"), undefined, "🔴 відповідь, яку вже обганяє новіше читання, лягла в пам'ять");
  fresh2.open(); await q2;
  assert.equal(race2.peek("k"), "після дії");
  // Звичайне відкриття під час перечитування чіпляється до НОВОГО читання, а не стартує третє.
  const join = new m.ClientPlansMemory(60_000, clock.now); const jg = gate("нове"); let jn = 0;
  const j1 = join.load("k", () => { jn++; return jg.p; }, true), j2 = join.load("k", () => { jn++; return jg.p; });
  jg.open(); assert.deepEqual(await Promise.all([j1, j2]), ["нове", "нове"]); assert.equal(jn, 1);

  // Запис будь-де: пам'ять порожня, а читання, що летіло під час запису, у неї не лягає.
  const wr = new m.ClientPlansMemory(60_000, clock.now); const flying = gate("старе");
  await wr.load("a", async () => 1);
  const pf = wr.load("b", () => flying.p);
  wr.clear();
  assert.equal(wr.peek("a"), undefined, "🔴 після запису список лишився в пам'яті");
  flying.open(); await pf;
  assert.equal(wr.peek("b"), undefined, "🔴 читання, що летіло під час запису, лягло в пам'ять");

  for (const w of ["post", "POST", "put", "patch", "delete"]) assert.equal(m.isWriteMethod(w), true, `🔴 ${w} не вважається записом — пам'ять переживе зміну`);
  for (const r of ["get", "GET", "head", "options", undefined]) assert.equal(m.isWriteMethod(r), false, `🔴 ${String(r)} вважається записом — пам'ять не проживе й секунди`);
});

/**
 * #11241c — ПРОВОДКА ФРОНТУ. Список тягне ОДИН хук (`useClientPlans`), обидві вкладки беруть його звідти, і більше
 * ніхто `fetchClientPlans` не кличе: друга копія з'явилась би саме так. Хук читає через спільну пам'ять із ключем
 * «користувач + місяць», початковий стан бере з неї синхронно, а `load` (після дії) перечитує з сервера. Успішний
 * запис будь-де чистить пам'ять, і цей перехоплювач стоїть після того, що відсіює відповіді-заглушки.
 * 🧨 Червоніє, якщо вкладка знову тягтиме список сама, з ключа зникне користувач, або запис перестане чистити пам'ять.
 */
test("#11241c ПРОВОДКА ФРОНТУ: список тягне один хук для обох вкладок через спільну пам'ять; успішний запис її чистить", () => {
  const hook = codeOnly(FE("hooks/useClientPlans.ts"));
  assert.match(hook, /const key = clientPlansKey\(\{ userId, month \}\);/, "🔴 ключ пам'яті — не «користувач + місяць»");
  assert.match(hook, /useState<ClientPlansResp \| null>\(\(\) => \(clientPlansMemory\.peek\(key\) as ClientPlansResp \| undefined\) \?\? null\)/,
    "🔴 початковий стан не з пам'яті — друга вкладка блимне «завантаження…»");
  assert.match(hook, /clientPlansMemory\.load\(key, \(\) => fetchClientPlans\(\{ month \}\), force\)/, "🔴 хук тягне список повз спільну пам'ять");
  assert.match(hook, /\.then\(\(d\) => \{ if \(n === req\.current\) setData\(d\); \}\)/, "🔴 обігнана відповідь потрапляє на екран (швидка зміна місяця покаже не той місяць)");
  assert.match(hook, /const load = useCallback\(\(\) => pull\(true\), \[pull\]\);/, "🔴 `load` після дії не перечитує з сервера");
  assert.match(hook, /useEffect\(\(\) => pull\(false\), \[pull\]\);/, "🔴 відкриття вкладки перечитує з сервера, хоча список свіжий");
  for (const f of ["pages/dashboard/sections/ClientLeadSection.tsx", "pages/dashboard/sections/ClientPlansSection.tsx"]) {
    const s = codeOnly(FE(f));
    assert.match(s, /const \{ data, err, load \} = useClientPlans\(auth\.userId, month\);/, `🔴 ${f} бере список не зі спільного хука`);
    assert.doesNotMatch(s, /\bfetchClientPlans\b/, `🔴 ${f} знову тягне список сам — друга копія й друге завантаження`);
  }
  const api = codeOnly(FE("api.ts"));
  const challenge = api.indexOf("if (looksLikeChallenge(res))");
  const clear = api.indexOf("if (clearsClientPlans(res.config?.method, res.config?.url)) clientPlansMemory.clear();");
  assert.ok(clear > 0, "🔴 успішний запис не чистить пам'ять списку у вкладці");
  assert.ok(challenge > 0 && challenge < clear, "🔴 чищення пам'яті стоїть перед відсівом відповідей-заглушок");
  assert.equal([...api.matchAll(/"\/dashboard\/client-plans"/g)].length, 1, "🔴 список тягнуть з більш ніж одного місця в api.ts");
});


/**
 * #11241d — «Я ОНЛАЙН» НЕ ЧИСТИТЬ ПАМ'ЯТЬ ВКЛАДКИ. Вкладка сама шле `POST /messages/heartbeat` раз на 30 с і одразу
 * на відкритті (`Layout.tsx`). Якби цей запис чистив пам'ять, перший же перехід між «З ким говорити» і «План місяця»
 * тягнув би список заново — рівно те, що показала перевірка в браузері 27.11.2026. Дзеркало: будь-який інший запис,
 * включно з рештою месенджера, пам'ять чистить; читання не чистить ніколи.
 * 🧨 Червоніє, якщо серцебиття знову чиститиме пам'ять, виняток розповзеться на інші записи, або `Layout.tsx`
 * почне слати серцебиття на іншу адресу (тоді виняток стереже порожнє місце).
 */
test("#11241d «Я ОНЛАЙН» НЕ ЧИСТИТЬ ПАМ'ЯТЬ ВКЛАДКИ: серцебиття раз на 30 с список не чіпає; будь-який інший запис чистить", async () => {
  const m = await loadStore();
  assert.deepEqual([...m.MACHINE_WRITE_URLS], ["/messages/heartbeat"], "🔴 перелік машинних записів вкладки змінено — кожен новий доводиться так само, як серверний");
  assert.equal(m.clearsClientPlans("post", "/messages/heartbeat"), false, "🔴 «я онлайн» чистить пам'ять списку — вона не проживе й 30 с");
  assert.equal(m.clearsClientPlans("POST", "/messages/heartbeat?t=1"), false, "🔴 рядок запиту зламав упізнавання «я онлайн»");
  for (const [method, url] of [["post", "/messages/17"], ["post", "/messages/heartbeats"], ["post", "/messages/heartbeat/x"], ["post", "/dashboard/repeat-client-plan"],
    ["put", "/tasks/15"], ["patch", "/settings/app"], ["delete", "/dashboard/client-comment/3"], ["post", undefined]] as const) {
    assert.equal(m.clearsClientPlans(method, url), true, `🔴 запис ${method} ${String(url)} не чистить пам'ять списку — людина не побачить зміни`);
  }
  for (const [method, url] of [["get", "/dashboard/client-plans"], ["get", "/messages/heartbeat"], [undefined, "/tasks"], ["head", "/health"]] as const) {
    assert.equal(m.clearsClientPlans(method, url), false, `🔴 читання ${String(method)} ${url} чистить пам'ять списку`);
  }
  // Адреса у винятку — та сама, на яку вкладка справді шле серцебиття, і шле його саме оболонка сторінки.
  const api = codeOnly(FE("api.ts"));
  assert.match(api, /export async function heartbeat\(\): Promise<void> \{\s*await api\.post\("\/messages\/heartbeat"\)/, "🔴 серцебиття шлеться на іншу адресу — виняток стереже порожнє місце");
  assert.match(codeOnly(FE("components/Layout.tsx")), /usePolling\(heartbeat, 30000, \{ immediate: true \}\);/, "🔴 серцебиття оболонки змінилось — звір період і адресу з винятком");
});
