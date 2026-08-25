import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";
import { LazyCache } from "./lazyCache.js";

/**
 * ⏱ #211c–#211e — ЛІНИВИЙ КЕШ `/overview` (варіант A, обсяг V3′, 25.08.2026).
 *
 * 🔴 НАЙНЕБЕЗПЕЧНІШЕ МІСЦЕ ВСЬОГО ПРОХОДУ — КЛЮЧ. Кеш, чий ключ не містить усього,
 * що змінює відповідь, не «трохи неточний»: він показує ОДНІЙ людині числа ІНШОЇ.
 * Правило власника дослівно: «у ключі мусить бути все, що змінює відповідь. Не
 * „схоже, що досить“ — а перелічено й засаботажовано».
 *
 * Тому `#211c` перевіряє не «адмін проти тімліда», а **тімлід A проти тімліда B**.
 * Різниця принципова: перевірка «адмін ≠ тімлід» пройшла б і тоді, коли ключ містить
 * лише ознаку «чи є обмеження», а не ЯКЕ саме — і тоді один тімлід бачив би числа
 * іншого, а гейт лишався б зеленим.
 */

const src = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело ${rel} — гейт не має права мовчки пропускатись`);
};

/** Дві РІЗНІ живі команди з різними даними (заміряно 25.08: won 9237 і 6426). */
const TEAM_A = 6, TEAM_B = 5;

type Res = Record<string, unknown>;
const overviewHandler = async () => {
  const { dashboardRouter } = await import("../routes/dashboard.js");
  const layer = (dashboardRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>;
    stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => void }[] } }[] })
    .stack.find((l) => l.route?.path === "/overview" && l.route.methods.get);
  assert.ok(layer?.route, "🔴 роут /overview не знайдено — гейт втратив предмет");
  const handle = layer!.route!.stack[layer!.route!.stack.length - 1].handle;
  return (auth: Record<string, unknown>, from: string, to: string): Promise<Res> =>
    new Promise((done, fail) => {
      let body: Res | null = null;
      handle({ auth, query: { from, to }, params: {} },
        { json(b: Res) { body = b; done(b); }, status() { return this; },
          send() { done(body ?? {}); }, setHeader() {} },
        (e?: unknown) => fail(e ?? new Error("роут пішов у next() без відповіді")));
    });
};
const asLead = (teamId: number) => ({ role: "team_lead", roleKey: "team_lead", managerId: null, teamId, userId: 0 });
const ADMIN = { role: "admin", roleKey: "admin", managerId: null, teamId: null, userId: 0 };

/**
 * #211c — ЧУЖИЙ ТЕПЛИЙ КЕШ НЕ МІНЯЄ ВІДПОВІДІ, І ЦЕ ПЕРЕВІРЯЄТЬСЯ ПОРІВНЯННЯМ
 * «З КЕШЕМ» ПРОТИ «БЕЗ КЕШУ», А НЕ «A ПРОТИ B».
 *
 * 🔴 ПЕРША РЕДАКЦІЯ ЦЬОГО ГЕЙТА БУЛА НЕПРИДАТНА, І ЦЕ ДОВЕДЕНО САБОТАЖЕМ, А НЕ
 * ЧИТАННЯМ. Вона стверджувала `A ≠ B` — мовляв, якби ключ не містив `teamId`,
 * команда B отримала б відповідь A. Насправді `A ≠ B` тримається НЕЗАЛЕЖНО від
 * кешу: більшість `/overview` (18 із 29 запитів) не кешується взагалі й сама
 * залежить від скоупу, тож дві команди дадуть різні тіла навіть при повністю
 * зламаному ключі. Саботаж власника (булеве `isScoped` замість значень) залишив
 * гейт ЗЕЛЕНИМ — тобто перевірка виглядала як перевірка й нею не була.
 *
 * ✅ ПРАВИЛЬНЕ ТВЕРДЖЕННЯ: для КОЖНОГО скоупу відповідь на ЧИСТОМУ кеші мусить
 * дорівнювати відповіді на кеші, ПРОГРІТОМУ ЧУЖИМ скоупом. Воно не залежить від
 * того, які саме поля різняться, і падає рівно тоді, коли ключ недостатній.
 *
 * 🪞 Дзеркало обовʼязкове: скоупи мусять справді давати різні тіла — інакше
 * «прогрів чужим» нічого не міняє за побудовою, і рівність тривіальна.
 *
 * 🧨 САБОТАЖ (виконано): `argKey` → `String(JSON.stringify(args).includes("teamId"))`
 * (той самий «булеве isScoped замість teamId», який назвав власник) → червоніє.
 */
test("#211c чужий теплий кеш не міняє відповіді жодного скоупу (жива БД)", needsDb(), async () => {
  const { overviewCache } = await import("./lazyCache.js");
  const call = await overviewHandler();
  const FROM = "2026-08-01", TO = "2026-08-25";
  const J = (x: Res) => JSON.stringify(x);

  const clean = async (auth: Record<string, unknown>) => { overviewCache.clear(); return J(await call(auth, FROM, TO)); };
  /** Відповідь для `auth` на кеші, прогрітому ЧУЖИМ скоупом `warmer`. */
  const afterWarm = async (warmer: Record<string, unknown>, auth: Record<string, unknown>) => {
    overviewCache.clear();
    await call(warmer, FROM, TO);
    return J(await call(auth, FROM, TO));
  };

  const [cleanA, cleanB, cleanAdm] = [await clean(asLead(TEAM_A)), await clean(asLead(TEAM_B)), await clean(ADMIN)];

  // 🪞 Дзеркало: три скоупи справді різні, інакше все нижче тривіально зелене.
  assert.ok(cleanA.length > 200, "🔴 /overview віддав майже порожнє тіло — порівнювати нема чого");
  assert.notEqual(cleanA, cleanB, `🔴 команди ${TEAM_A} і ${TEAM_B} дають ОДНАКОВЕ тіло — гейт не має що розрізняти`);
  assert.notEqual(cleanA, cleanAdm, "🔴 тімлід і адмін дають однакове тіло — скоуп ніде не проявляється");

  // 🔑 Саме тут падає недостатній ключ: B бачить те, що поклав у кеш A.
  assert.equal(await afterWarm(asLead(TEAM_A), asLead(TEAM_B)), cleanB,
    `🔴 команда ${TEAM_B} на кеші, прогрітому командою ${TEAM_A}, отримала ІНШУ відповідь, ніж на чистому. `
    + "Ключ кешу не розрізняє тімлідів — один бачить числа іншого");
  assert.equal(await afterWarm(asLead(TEAM_B), asLead(TEAM_A)), cleanA,
    `🔴 дзеркально: команда ${TEAM_A} після прогріву командою ${TEAM_B} зіпсувалась`);
  assert.equal(await afterWarm(ADMIN, asLead(TEAM_A)), cleanA,
    `🔴 команда ${TEAM_A} на кеші, прогрітому АДМІНОМ, побачила загальнокомпанійні числа`);
  assert.equal(await afterWarm(asLead(TEAM_A), ADMIN), cleanAdm,
    `🔴 адмін на кеші, прогрітому командою ${TEAM_A}, побачив числа однієї команди замість компанії`);
});

/**
 * #211d — TTL І SINGLE-FLIGHT, ЧИСТИМ ТЕСТОМ БЕЗ БД.
 *
 * 🔴 ГОДИННИК — ПАРАМЕТР. Інакше «протухання» перевірялось би реальним очікуванням,
 * тобто на практиці ніяк, і гейт мовчки виродився б у «значення повертається».
 *
 * 🔴 SINGLE-FLIGHT — НЕ ПРИКРАСА. Без нього чотири одночасні `/overview` на
 * холодному кеші дають чотири однакові важкі запити, тобто рівно той сплеск, від
 * якого лікуємось, і саме після рестарту, коли й так важко.
 *
 * 🧨 САБОТАЖ (виконано): прибрати перевірку `now - hit.at < ttl` → падає
 * «протухле віддане»; прибрати мапу `inflight` → падає «викликів 10 замість 1».
 */
test("#211d кеш дотримує TTL і не дублює політ (чистий)", async () => {
  const c = new LazyCache(60_000);
  const T0 = 1_000_000;

  let calls = 0;
  const produce = () => { calls++; return Promise.resolve({ v: calls }); };

  assert.deepEqual(await c.memo("k", produce, T0), { v: 1 });
  assert.deepEqual(await c.memo("k", produce, T0 + 59_999), { v: 1 });
  assert.equal(calls, 1, "🔴 у межах TTL значення перерахували — кеш не кешує");

  assert.deepEqual(await c.memo("k", produce, T0 + 60_000), { v: 2 });
  assert.equal(calls, 2, "🔴 на межі TTL віддали ПРОТУХЛЕ — перевірки віку немає");

  // single-flight: десять одночасних промахів на повільному продюсері
  const c2 = new LazyCache(60_000);
  let slow = 0;
  const slowProduce = () => { slow++; return new Promise((r) => setTimeout(() => r({ ok: true }), 30)); };
  const all = await Promise.all(Array.from({ length: 10 }, () => c2.memo("s", slowProduce, T0)));
  assert.equal(slow, 1, `🔴 одночасні промахи дали ${slow} викликів замість 1 — single-flight не працює`);
  assert.ok(all.every((x) => JSON.stringify(x) === JSON.stringify(all[0])), "🔴 паралельні промахи дали різні значення");

  // помилка НЕ кешується: інакше одна невдача заморозила б роут на цілий TTL
  const c3 = new LazyCache(60_000);
  let n = 0;
  const flaky = () => { n++; return n === 1 ? Promise.reject(new Error("бах")) : Promise.resolve("ок"); };
  await assert.rejects(() => c3.memo("f", flaky, T0));
  assert.equal(await c3.memo("f", flaky, T0), "ок", "🔴 після помилки ключ лишився зайнятим — роут завис би на TTL");

  // стан для health: протухле не рахується
  const c4 = new LazyCache(60_000);
  await c4.memo("x", () => Promise.resolve(1), T0);
  assert.equal(c4.stats(T0 + 1_000).entries, 1);
  assert.equal(c4.stats(T0 + 61_000).entries, 0, "🔴 health рахує протухлі записи як живі");
});

/**
 * #211e — КЕШУЄТЬСЯ ЛИШЕ ТЕ, ЩО НЕ ЗАЛЕЖИТЬ ВІД ПЕРІОДУ.
 *
 * Твердження структурне й перевіряється поведінкою: **набір ключів, які `/overview`
 * поклав у кеш, мусить бути ОДНАКОВИЙ для двох різних періодів**, тоді як самі
 * відповіді — різні. Якщо хтось обгорне періодозалежний виклик, набори розійдуться.
 *
 * 🔴 ДРУГА ПОЛОВИНА — ЗВУЖЕННЯ АРГУМЕНТІВ, І ВОНО ДОВОДИТЬСЯ РІВНІСТЮ, А НЕ
 * ЧИТАННЯМ ТІЛА. `awaitingNowSnapshot` кличеться `{ managerId, teamId }` замість
 * повного `moneyScope` — бо `from`/`to` вона не читає, а поклавши їх у ключ, ми
 * зробили б кеш таким, що не влучає НІКОЛИ (тобто тихо вимкнули б його). Що
 * звуження безпечне — доводить рівність результатів на живих даних.
 *
 * 🧨 САБОТАЖ (виконано): обгорнути `money.moneyTotals(moneyScope)` (періодозалежний)
 * → набори ключів розходяться, червоніє; передати `moneyScope` у звужений виклик →
 * червоніє друга половина (там зʼявиться період і рівність наборів упаде).
 */
test("#211e кешуються лише періодонезалежні виклики, звуження скоупу безпечне (жива БД)", needsDb(), async () => {
  const { overviewCache } = await import("./lazyCache.js");
  const money = await import("./money.js");
  const call = await overviewHandler();

  overviewCache.clear();
  const rAug = await call(ADMIN, "2026-08-01", "2026-08-25");
  const kAug = overviewCache.liveKeys();

  overviewCache.clear();
  const rJun = await call(ADMIN, "2026-06-01", "2026-06-30");
  const kJun = overviewCache.liveKeys();

  assert.ok(kAug.length > 0, "🔴 у кеш не потрапило нічого — гейт не має що звіряти");
  assert.deepEqual(kJun, kAug,
    "🔴 набір ключів кешу РІЗНИЙ для серпня і червня — тобто закешовано щось періодозалежне. "
    + `Тільки в серпні: ${kAug.filter((k) => !kJun.includes(k)).join(", ") || "—"}; `
    + `тільки в червні: ${kJun.filter((k) => !kAug.includes(k)).join(", ") || "—"}`);
  assert.notEqual(JSON.stringify(rAug), JSON.stringify(rJun),
    "🔴 відповіді за серпень і червень ІДЕНТИЧНІ — рівність ключів тоді нічого не доводить");

  // звуження скоупу для «станом на зараз» — рівність на живих даних
  const full = await money.awaitingNowSnapshot({ from: "2026-08-01", to: "2026-08-25", managerId: null, teamId: null });
  const narrow = await money.awaitingNowSnapshot({ managerId: null, teamId: null });
  assert.ok(full.deals > 0 || full.revenue !== 0,
    "🔴 знімок очікувань порожній — рівність тривіальна, звуження не доведене");
  assert.deepEqual(narrow, full,
    "🔴 `awaitingNowSnapshot` віддає РІЗНЕ з періодом і без нього — отже вона таки читає `from`/`to`, "
    + "і звужений виклик у /overview змінює число");

  // і межа проходу: `buildProjection` свідомо НЕ обгорнута (вона приймає planMonthTotal,
  // залежний від `to`) — читаємо ДЖЕРЕЛО, бо це рішення, а не властивість даних
  const route = src("routes/dashboard.ts").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  assert.doesNotMatch(route, /overviewCache\.call\(\s*"buildProjection"/,
    "🔴 `buildProjection` обгорнули в кеш — вона приймає `planMonthTotal`, залежний від `to`, "
    + "тож її ключ порушив би інваріант «набір ключів однаковий для будь-яких двох періодів»");
});
