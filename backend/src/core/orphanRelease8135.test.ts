import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LEADGEN_POOL_ENABLED, LEADGEN_POOL_SCREEN, poolAccess, poolAccessNow, poolTransferOpen, transferWindowOpen,
  decisionsNow, statusNow, allowedDecisions, poolRevived, planSweep, inReact, type CycleRow,
} from "./reactCycleRules.js";
import { orphanPoolAccess, ORPHAN_CLOSE_REASON_KEYS } from "./orphanClients.js";
import { CLOSE_REASONS, CLOSE_REASON_KEYS } from "./reactivationRules.js";
import {
  releaseDeadline, releaseDue, releaseRevived, releaseAction, cleanReleaseNote, RELEASE_NOTE_MIN, HANDED_OFF_SQL,
} from "./orphanRelease.js";
import { skipReason } from "../db/scratchDb.js";

/**
 * 🧭 «В НІЧИЙНІ» → ПУЛ ЛІДГЕНІВ (задачі 8135 + 8349; ТЗ Юлі 06.11/09.11.2026 у 8850 і «Нові правила лідогенерації»,
 * розділ 2; Роман 11.11.2026 — «так» на план: усі менеджери бачать і беруть, день робочий, коментар обовʼязковий,
 * старий пул закрити). Наступники `#3441`/`#3442` (вимикач пулу), `#1367` (доступ до нічийних), `#3330`/`#3330b`
 * («Закрити»): їхні твердження змінились — див. `RETIRED_GATES`.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";
/** Код без коментарів — щоб гейт не зеленів від слова в поясненні. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const row = (p: Partial<CycleRow> & { cycleMonth: string }): CycleRow => ({
  decision: null, decidedDate: null, pooled: false, poolReason: null, closed: false, closeReason: null, ...p,
});

/**
 * #3801 🪞 — ДВА ВИМИКАЧІ: стара передача з реактивації ВИМКНЕНА (`LEADGEN_POOL_ENABLED`), екран пулу ВИДНО
 * (`LEADGEN_POOL_SCREEN`). Пул бачать лідгени й керівництво; у понеділок о 09:00 передачі немає; «Передати лідгенам»
 * не пропонується; рядок старого пулу показується реактивацією, а рядок `orphan` — «у пулі»; закритий `pool_off` —
 * без кнопок (інакше «Реактивую сам» вів би в 409).
 * 🧨 Червоніє, якщо ввімкнути стару передачу, сховати екран пулу, або якщо `statusNow` сховає рядок `orphan`.
 */
test("#3801 🪞 ДВА ВИМИКАЧІ: стара передача вимкнена, екран пулу видно; рядок «з нічийних» — у пулі", () => {
  assert.equal(LEADGEN_POOL_ENABLED, false, "🔴 передачу з реактивації знову ввімкнено — рішення Сергія 31.10 було вимкнути");
  assert.equal(LEADGEN_POOL_SCREEN, true, "🔴 екран пулу сховано — клієнти з «Нічийних» не дійдуть до лідгенів");
  const mon9 = ["2026-11-09", 9] as const;
  assert.equal(transferWindowOpen(...mon9), true, "фікстура: о 09:00 понеділка вікно саме по собі відкрите");
  assert.equal(poolTransferOpen(...mon9), false, "🔴 у понеділок о 09:00 передача відкрита попри вимикач");
  for (const [lg, adm] of [[true, false], [false, true], [true, true], [false, false]] as const) {
    assert.deepEqual(poolAccessNow(lg, adm), poolAccess(lg, adm), `🔴 доступ до пулу (лідген ${lg}, керівництво ${adm}) не за правилом`);
    assert.deepEqual(poolAccessNow(lg, adm, false), { canSee: false, canTake: false }, "🔴 вимкнений екран не ховає пул");
  }
  assert.deepEqual(decisionsNow(null), ["self"], "🔴 «Передати лідгенам» пропонується попри вимикач");
  const cm = "2026-11";
  assert.equal(statusNow(row({ cycleMonth: cm, pooled: true, poolReason: "auto" })), "waiting", "🔴 старий пул показується пулом");
  assert.equal(statusNow(row({ cycleMonth: cm, pooled: true, poolReason: "orphan" })), "pool", "🔴 клієнт із «Нічийних» не «у пулі»");
  assert.equal(statusNow(row({ cycleMonth: cm, decision: "self", decidedDate: "2026-11-02" })), "self");
  const off = row({ cycleMonth: cm, pooled: true, poolReason: "auto", closed: true, closeReason: "pool_off" });
  assert.deepEqual(allowedDecisions(off), [], "🔴 після закриття старого пулу пропонується кнопка, яку відхилить ON CONFLICT");
  assert.deepEqual(allowedDecisions(null), ["self", "leadgen"], "дзеркало: без рядка правило те саме");
});

/**
 * #3802 — ПРОВОДКА ВИМИКАЧІВ (наступник `#3442`): роут «лідгенам» відхиляє ДО запису; доступ до пулу — через
 * `poolAccessNow`; вигляд циклу — `decisionsNow`/`statusNow`, строк лише з увімкненою передачею, причина пулу — коли
 * пул справжній; «ожив» у пулі й при «Взяти» — `poolRevived`, а не голе «рахунок за 3 місяці»; фронт знає про вимикач.
 * 🧨 Червоніє, якщо будь-яке місце повернеться до голого правила — тоді рядок `orphan` закриватиметься тієї ж ночі
 * (клієнт мав рахунок місяць тому) і до лідгена не дійде.
 */
test("#3802 ПРОВОДКА: роут, доступ, вигляд циклу, «ожив» за правилом рядка, джоба, фронт", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const dec = dash.slice(dash.indexOf('dashboardRouter.post("/react-decision"'));
  const guard = dec.indexOf('if (decision === "leadgen" && !reactCycleRules.LEADGEN_POOL_ENABLED)');
  assert.ok(guard > 0 && guard < dec.indexOf("reactCycle.decide("), "🔴 «лідгенам» доходить до запису попри вимикач");
  assert.match(dash, /return reactCycleRules\.poolAccessNow\(isLeadgen, isAdminScope\(auth\)\);/, "🔴 пул віддається без вимикача");
  assert.doesNotMatch(dash, /reactCycleRules\.poolAccess\(/, "🔴 десь пул відкривається голим правилом");
  assert.match(dash, /leadgenPool: reactCycleRules\.LEADGEN_POOL_ENABLED/, "🔴 фронт не знає, що передачу вимкнено");
  const lp = dash.slice(dash.indexOf('dashboardRouter.get("/leadgen-pool"'), dash.indexOf('dashboardRouter.post("/leadgen-pool/take"'));
  assert.match(lp, /reactCycleRules\.poolRevived\(/, "🔴 пул закриває «ожилих» голим правилом реактивації");
  assert.doesNotMatch(lp, /reactCycleRules\.inReact\(/, "🔴 пул досі фільтрує за «рахунок за 3 місяці»");
  const tk = dash.slice(dash.indexOf('dashboardRouter.post("/leadgen-pool/take"'));
  assert.match(tk.slice(0, 2500), /reactCycleRules\.poolRevived\(/, "🔴 «Взяти» перевіряє «ожив» голим правилом");
  const core = codeOnly(read("backend/src/core/reactCycle.ts"));
  const view = core.slice(core.indexOf("export function cycleView"));
  assert.match(view, /const dl = LEADGEN_POOL_ENABLED \? transferMonday\(cm, row\) : null;/, "🔴 строк передачі показується попри вимикач");
  assert.match(view, /status: statusNow\(row\)/);
  assert.match(view, /allowed: decisionsNow\(row\)/, "🔴 кнопки циклу — з голого правила");
  const take = core.slice(core.indexOf("export async function take"), core.indexOf("export async function isLeadgenManager"));
  assert.match(take, /poolRevived\(/, "🔴 ядро «Взяти» перевіряє «ожив» голим правилом");
  const job = codeOnly(read("backend/src/jobs/reactCycleSweep.ts"));
  assert.match(job, /poolReason: o\.poolReason, pooledDay: o\.pooledAt/, "🔴 нічний прохід не передає правилу причину й день пулу");
  const list = codeOnly(read(`${SECTIONS}/ClientPlansSection.tsx`));
  assert.match(list, /data\.reactRules\?\.leadgenPool === false/, "🔴 екран не перемикає пояснення за сервером");
});

/**
 * #3803 — ДОСТУП ДО «НІЧИЙНИХ» (наступник `#1367`; Роман 11.11: групу «Віддали менеджери» бачать і беруть ВСІ
 * менеджери): без прапорця — `released` (лише ця група, лише собі, без «Закрити»), з прапорцем — `self`, керівники —
 * `full`. Роути: межа першою дією; `released` бере лише собі й лише відданого; «Закрити» йому — 403.
 * 🧨 Червоніє, якщо менеджер без прапорця знову не бачить відданих (`none`) або побачить увесь пул / закриє клієнта.
 */
test("#3803 ДОСТУП ДО НІЧИЙНИХ: без прапорця — лише «Віддали менеджери» і лише собі; з прапорцем — пул; керівники — повний", () => {
  assert.equal(orphanPoolAccess({ role: "manager", orphanPoolFlag: false }), "released", "🔴 менеджер без прапорця не бачить відданих");
  assert.equal(orphanPoolAccess({ role: "manager", orphanPoolFlag: true }), "self", "🔴 прапорець не відкриває пул менеджеру");
  for (const role of ["admin", "team_lead", "company"]) {
    assert.equal(orphanPoolAccess({ role, orphanPoolFlag: false }), "full", `🔴 керівник (${role}) втратив пул`);
  }
  const src = codeOnly(read("backend/src/routes/dashboard.ts"));
  const get = src.slice(src.indexOf('dashboardRouter.get("/orphan-clients"'), src.indexOf('dashboardRouter.post("/orphan-clients/claim"'));
  assert.match(get, /const rows = access === "released" \? \[\] : found\.filter\(\(r\) => r\.releasedAt == null\);/,
    "🔴 менеджер без прапорця бачить увесь пул, а не лише відданих");
  const claim = src.slice(src.indexOf('dashboardRouter.post("/orphan-clients/claim"'), src.indexOf('dashboardRouter.post("/orphan-clients/close"'));
  assert.match(claim, /^dashboardRouter\.post\("\/orphan-clients\/claim", async \(req, res\) => \{\s*const auth = req\.auth!;\s*const access = await poolAccessOf\(auth\);\s*if \(access === "none"\) return res\.status\(403\)/,
    "🔴 межа «Взяти» не першою дією");
  assert.match(claim, /if \(access === "released" && managerId !== auth\.managerId\)\s*\{\s*return res\.status\(403\)/, "🔴 менеджер без прапорця закріплює за іншим");
  assert.match(claim, /if \(access === "released" && !wasReleased\)\s*\{\s*return res\.status\(403\)/, "🔴 менеджер без прапорця бере не відданого");
  const close = src.slice(src.indexOf('dashboardRouter.post("/orphan-clients/close"'));
  assert.match(close, /^dashboardRouter\.post\("\/orphan-clients\/close", async \(req, res\) => \{\s*const auth = req\.auth!;\s*const access = await poolAccessOf\(auth\);\s*if \(access === "none" \|\| access === "released"\) return res\.status\(403\)/,
    "🔴 «Закрити» доступне менеджеру без прапорця або межа не першою");
  const loy = codeOnly(read(`${SECTIONS}/LoyaltySection.tsx`));
  assert.match(loy, /const canSeePool = auth != null;/, "🔴 вкладку «Нічийні» сховано від менеджерів без прапорця");
});

/**
 * #3804 — «ЗАКРИТИ» («Розібрано», задача 8135: разовий, закрились, перевізник): шість причин зі спільного словника,
 * підписи — звідти ж; `CHECK` у БД == словник (наступник `#3330`).
 * 🧨 Червоніє, якщо причину кнопки не внести в словник, словник і CHECK розійдуться, або кнопка покаже не ті причини.
 */
test("#3804 «ЗАКРИТИ» В НІЧИЙНИХ: шість причин — зі спільного словника; CHECK у БД == словник", () => {
  assert.deepEqual([...ORPHAN_CLOSE_REASON_KEYS], ["carrier", "one_off", "closed_down", "not_interested", "not_relevant", "duplicate"]);
  for (const k of ORPHAN_CLOSE_REASON_KEYS) assert.ok(CLOSE_REASON_KEYS.includes(k), `🔴 причини «${k}» немає в спільному словнику`);
  assert.deepEqual(CLOSE_REASONS.filter((r) => ORPHAN_CLOSE_REASON_KEYS.includes(r.key)).map((r) => r.label),
    ["Закрились", "Перевізник", "Разове перевезення", "Не цікаво", "Не актуально", "Дубль"]);
  const schema = read("backend/src/db/schema.sql");
  const m = /loyalty_overrides_archive_reason_chk[\s\S]*?archive_reason IN\s*\(([^)]*)\)/.exec(schema);
  assert.ok(m, "🔴 CHECK причин архіву не знайдено в schema.sql");
  const inCheck = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(inCheck, [...CLOSE_REASON_KEYS].sort(), "🔴 CHECK у БД і словник причин розійшлися");
});

/**
 * #3805 — РОУТ «ЗАКРИТИ» (наступник `#3330b`): причина — лише зі словника кнопки, «клієнт ЗАРАЗ у пулі» ДО запису,
 * запис — спільним `ARCHIVE_UPSERT_SQL`; розібраний відданий — позначка й сповіщення «візьміть» знімаються.
 * 🧨 Червоніє, якщо запис піде без перевірки пулу, «Закрити» заведе власний SQL архіву або лишить позначку
 * (тоді джоба віддасть архівного клієнта лідгенам).
 */
test("#3805 РОУТ «ЗАКРИТИ»: причина зі словника, «зараз у пулі» до запису, спільний SQL архіву, позначку знято", () => {
  const src = read("backend/src/routes/dashboard.ts");
  const at = src.indexOf('dashboardRouter.post("/orphan-clients/close"');
  assert.ok(at > 0, "🔴 роуту «Закрити» немає");
  const body = src.slice(at, src.indexOf("\ndashboardRouter.", at + 10));
  assert.match(body, /if \(!ORPHAN_CLOSE_REASON_KEYS\.includes\(reason\)\)/, "🔴 причина не звужена до словника кнопки");
  const pool = body.indexOf("metrics.orphanClients("), write = body.indexOf("ARCHIVE_UPSERT_SQL");
  assert.ok(pool > 0 && write > pool, "🔴 запис в архів не після перевірки «клієнт зараз у пулі»");
  assert.ok(!/INSERT INTO loyalty_overrides/.test(body), "🔴 «Закрити» пише архів власним SQL, а не спільним");
  assert.match(body, /if \(await orphanRelease\.clearRelease\(pool, clientKey\)\) await orphanRelease\.closeReleaseNotices\(pool, clientKey\)/,
    "🔴 розібраний відданий лишився з позначкою — джоба віддасть архівного лідгенам");
});

/**
 * #3806 🪞 — РОБОЧИЙ ДЕНЬ, «ОЖИВ», КОМЕНТАР (Роман 11.11: «1 день» = робочий; коментар обовʼязковий).
 * Межі по обидва боки: вт → ср тієї ж години; пт 17:00 → пн 17:00; сб і нд → пн; за хвилину до строку — ще чекає,
 * у строк — лідгенам; рахунок того ж дня — не «ожив», наступного — «ожив»; коментар коротший за мінімум — ні.
 * 🧨 Червоніє, якщо строк стане 24 годинами календаря (пт ввечері → сб, у вихідний ніхто не візьме), або «ожив»
 * почне рахувати рахунок, виставлений ДО передачі.
 */
test("#3806 🪞 РОБОЧИЙ ДЕНЬ і «ОЖИВ»: пт→пн, вихідні→пн, межа строку й рахунку по обидва боки; коментар обовʼязковий", () => {
  // Київ у листопаді — UTC+2. 10:00 Києва = 08:00Z.
  assert.equal(releaseDeadline("2026-11-10T08:00:00.000Z"), "2026-11-11T08:00:00.000Z", "🔴 вт 10:00 → не ср 10:00");
  assert.equal(releaseDeadline("2026-11-13T15:00:00.000Z"), "2026-11-16T15:00:00.000Z", "🔴 пт 17:00 → не пн 17:00 (строк упав на вихідні)");
  assert.equal(releaseDeadline("2026-11-14T08:00:00.000Z"), "2026-11-16T08:00:00.000Z", "🔴 сб 10:00 → не пн 10:00");
  assert.equal(releaseDeadline("2026-11-15T21:00:00.000Z"), "2026-11-16T21:00:00.000Z", "🔴 нд 23:00 → не пн 23:00");
  // 22:30Z пт = 00:30 сб за Києвом → пн 00:30 Києва (= нд 22:30Z). День тижня — за Києвом: читання за UTC
  // («пʼятниця») дало б пн 22:30Z = ВІВТОРОК 00:30 за Києвом — зайва доба.
  assert.equal(releaseDeadline("2026-11-13T22:30:00.000Z"), "2026-11-15T22:30:00.000Z", "🔴 субота за Києвом прочитана як пʼятниця за UTC");
  assert.equal(releaseDue("2026-11-10T08:00:00.000Z", "2026-11-11T07:59:00.000Z"), false, "🔴 за хвилину до строку вже лідгенам");
  assert.equal(releaseDue("2026-11-10T08:00:00.000Z", "2026-11-11T08:00:00.000Z"), true, "🔴 у строк не йде лідгенам");
  assert.equal(releaseRevived("2026-11-10", "2026-11-10"), false, "🔴 рахунок того ж дня (до передачі) «оживив» клієнта");
  assert.equal(releaseRevived("2026-11-10", "2026-11-11"), true, "🔴 рахунок після передачі не повернув клієнта менеджеру");
  assert.equal(releaseRevived("2026-11-10", null), false);
  const at = "2026-11-10T08:00:00.000Z", day = "2026-11-10";
  assert.equal(releaseAction({ releasedAt: at, releasedDay: day, lastInvoice: "2026-10-01" }, "2026-11-10T20:00:00.000Z"), "wait");
  assert.equal(releaseAction({ releasedAt: at, releasedDay: day, lastInvoice: "2026-10-01" }, "2026-11-11T09:00:00.000Z"), "to_leadgen");
  assert.equal(releaseAction({ releasedAt: at, releasedDay: day, lastInvoice: "2026-11-11" }, "2026-11-11T09:00:00.000Z"), "revived",
    "🔴 ожилого віддали лідгенам — «ожив» має йти ПЕРШИМ");
  assert.equal(cleanReleaseNote("x".repeat(RELEASE_NOTE_MIN - 1)), null, "🔴 прийнято коментар коротший за мінімум");
  assert.equal(cleanReleaseNote("   " + "x".repeat(RELEASE_NOTE_MIN) + "  "), "x".repeat(RELEASE_NOTE_MIN));
  assert.equal(cleanReleaseNote(undefined), null);
});

/**
 * #3807 🪞 — «ОЖИВ» У ПУЛІ ЗА ПРАВИЛОМ РЯДКА. Рядок `orphan`: рахунок до/в день пулу — живе; після — закривається.
 * Рядок старого пулу (`auto`): рахунок за 3 місяці — закривається. Нічний прохід закриває саме за цим правилом.
 * 🧨 Червоніє, якщо `orphan` закриватиметься «рахунком за 3 місяці» — тоді віддані менеджерами (вони ж нещодавно
 * замовляли) зникатимуть із пулу тієї ж ночі, не дійшовши до лідгена.
 */
test("#3807 🪞 «ОЖИВ» У ПУЛІ: orphan — лише від рахунку після дня пулу; старий пул — за 3 місяці; нічний прохід так само", () => {
  const nowYm = "2026-11";
  assert.equal(inReact("2026-10-20", nowYm), false, "фікстура: рахунок у жовтні — за правилом реактивації клієнт «живий»");
  assert.equal(poolRevived({ poolReason: "orphan", pooledDay: "2026-11-11", lastInvoice: "2026-10-20" }, nowYm), false,
    "🔴 рядок «з нічийних» закривається старим рахунком");
  assert.equal(poolRevived({ poolReason: "orphan", pooledDay: "2026-11-11", lastInvoice: "2026-11-11" }, nowYm), false);
  assert.equal(poolRevived({ poolReason: "orphan", pooledDay: "2026-11-11", lastInvoice: "2026-11-12" }, nowYm), true,
    "🔴 новий рахунок після пулу не повернув клієнта");
  assert.equal(poolRevived({ poolReason: "auto", pooledDay: "2026-10-05", lastInvoice: "2026-10-20" }, nowYm), true,
    "🔴 старий пул перестав закриватись рахунком за 3 місяці");
  assert.equal(poolRevived({ poolReason: "auto", pooledDay: "2026-10-05", lastInvoice: "2026-06-01" }, nowYm), false);
  const a = planSweep([], new Map(), [
    { clientKey: "orph-old-inv", cycleMonth: nowYm, lastInvoice: "2026-10-20", poolReason: "orphan", pooledDay: "2026-11-11" },
    { clientKey: "orph-new-inv", cycleMonth: nowYm, lastInvoice: "2026-11-12", poolReason: "orphan", pooledDay: "2026-11-11" },
    { clientKey: "auto-alive", cycleMonth: "2026-10", lastInvoice: "2026-10-20", poolReason: "auto", pooledDay: "2026-10-05" },
  ], "2026-11-13", { transfer: false, pooledThisWeek: 0 });
  assert.deepEqual(a.close.map((x) => x.clientKey).sort(), ["auto-alive", "orph-new-inv"], "🔴 нічний прохід закриває не тих");
});

/**
 * #3808 — ПРОВОДКА 8349 І 8135: «Клієнти та реактивація» викидає відданих і тих, хто в пулі, ДО всіх лічильників;
 * множина — одна (`HANDED_OFF_SQL`, обидва джерела); пул нічийних бачить відданих попри закріплення і не показує тих,
 * хто вже в пулі лідгенів; «В нічийні» — межа першою, коментар до запису, сповіщення; «Взяти» знімає позначку одним
 * запитом; джоба — щогодини, під наглядом (60 хв), у стартовому списку; картка показує блок; фронт іде за посиланням.
 * 🧨 Червоніє, якщо фільтр переїде ПІСЛЯ `clientKeys` (лічильники порахують відданих), джерело множини зникне, або
 * якийсь крок ланцюга (кнопка → сповіщення → джоба → пул) випаде.
 */
test("#3808 ПРОВОДКА: список без відданих і пулу, пул нічийних, «В нічийні», «Взяти», джоба, картка, сповіщення", () => {
  assert.match(HANDED_OFF_SQL, /FROM loyalty_overrides WHERE released_at IS NOT NULL/, "🔴 віддані не в множині «немає в менеджера»");
  assert.match(HANDED_OFF_SQL, /FROM client_react_cycles WHERE pooled_at IS NOT NULL AND closed_at IS NULL/, "🔴 пул лідгенів не в множині");
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'));
  const f = plans.indexOf("clientsRes.rows = clientsRes.rows.filter((c) => !handedOff.has(c.client_key));");
  assert.ok(f > 0 && f < plans.indexOf("const clientKeys = clientsRes.rows.map((c) => c.client_key);"),
    "🔴 8349: відданих і тих, хто в пулі, не прибрано ДО лічильників");
  const metrics = read("backend/src/core/metrics.ts");
  const oc = metrics.slice(metrics.indexOf("export async function orphanClients"));
  assert.match(oc, /WHERE \(\$\{orphanManagerSql\("m"\)\} OR lo\.released_at IS NOT NULL\)\s*AND \(lo\.pinned_manager_id IS NULL OR lo\.released_at IS NOT NULL\)/,
    "🔴 пул нічийних не бачить відданих менеджером (або бачить закріплених)");
  assert.match(oc, /AND NOT EXISTS \(SELECT 1 FROM client_react_cycles cy\s+WHERE cy\.client_key = a\.ck AND cy\.pooled_at IS NOT NULL AND cy\.closed_at IS NULL\)/,
    "🔴 клієнт у пулі лідгенів досі в нічийних — одночасно у двох місцях");
  const rel = dash.slice(dash.indexOf('dashboardRouter.post("/orphan-clients/release"'), dash.indexOf('dashboardRouter.post("/orphan-clients/unrelease"'));
  assert.match(rel, /^dashboardRouter\.post\("\/orphan-clients\/release", async \(req, res\) => \{\s*const auth = req\.auth!;\s*const clientKey = [^\n]+\n\s*if \(!clientKey \|\| !\(await canSeeClient\(auth, clientKey\)\)\) return res\.status\(403\)/,
    "🔴 «В нічийні»: межа не першою дією");
  const note = rel.indexOf("orphanRelease.cleanReleaseNote("), write = rel.indexOf("orphanRelease.release(pool");
  assert.ok(note > 0 && write > note, "🔴 коментар не перевірено до запису");
  assert.ok(rel.indexOf("orphanRelease.notifyReleased(") > write, "🔴 після «В нічийні» сповіщення не йде");
  const un = dash.slice(dash.indexOf('dashboardRouter.post("/orphan-clients/unrelease"'));
  assert.match(un, /^dashboardRouter\.post\("\/orphan-clients\/unrelease", async \(req, res\) => \{\s*const auth = req\.auth!;\s*const clientKey = [^\n]+\n\s*if \(!clientKey \|\| !\(await canSeeClient\(auth, clientKey\)\)\) return res\.status\(403\)/,
    "🔴 «Відкликати»: межа не першою дією");
  const claim = dash.slice(dash.indexOf('dashboardRouter.post("/orphan-clients/claim"'), dash.indexOf('dashboardRouter.post("/orphan-clients/close"'));
  assert.match(claim, /released_at = NULL, released_by = NULL, released_note = NULL, released_from_manager_id = NULL/, "🔴 «Взяти» не знімає позначку тим самим запитом");
  assert.match(claim, /orphanRelease\.closeReleaseNotices\(pool, clientKey\)/, "🔴 після «Взяти» сповіщення «візьміть» висить далі");
  const idx = codeOnly(read("backend/src/index.ts"));
  assert.match(idx, /cron\.schedule\("10 \* \* \* \*", \(\) => \{\n\s*void runJob\("orphanToLeadgen", \(\) => runOrphanToLeadgen\(\)\);/, "🔴 джоба не щогодини");
  assert.match(idx, /\["orphanToLeadgen", \(\) => runOrphanToLeadgen\(\)\]/, "🔴 джоби немає в стартовому списку");
  assert.match(read("backend/src/jobs/monitoredJobs.ts"), /\{ name: "orphanToLeadgen", everyMin: 60,/, "🔴 джоба не під наглядом — замовкне мовчки");
  const job = codeOnly(read("backend/src/jobs/orphanToLeadgen.ts"));
  assert.match(job, /releaseAction\(/, "🔴 джоба вирішує сама, а не чистим правилом");
  assert.match(job, /await moveToLeadgen\(c, /, "🔴 перехід у пул не в транзакції");
  assert.match(read("backend/src/db/schema.sql"), /\('client\.orphan', 'Клієнти', true,/, "🔴 немає типу сповіщення — `emitAll` мовчки пропустить");
  const card = codeOnly(read(`${SECTIONS}/ClientCardPanel.tsx`));
  assert.match(card, /<ClientReleaseBlock card=\{card\}/, "🔴 у картці немає кнопки «В нічийні»");
  const bell = codeOnly(read("frontend/src/components/NotificationBell.tsx"));
  assert.match(bell, /if \(typeof go\.section === "string"\) return \{ section: go\.section/, "🔴 сповіщення не веде в «Нічийні»");
  const orph = codeOnly(read(`${SECTIONS}/OrphanPoolSection.tsx`));
  assert.match(orph, /<ReleasedBlock rows=\{released\}/, "🔴 у «Нічийних» немає групи «Віддали менеджери»");
});

/**
 * #3810 — РОУТИ ЦИКЛУ (наступник `#845b`): межа — першим оператором, матриця й вкладка; пул звіряє «ожив» перед
 * показом і взяттям — тепер правилом рядка (`poolRevived`), бо рядок `orphan` живе за власним «ожив».
 * 🧨 Червоніє, якщо межу перенести після валідації, перевірку «ожив» — у транзакцію (ROLLBACK відкотить закриття),
 * або роут повернеться до голого «рахунку за 3 місяці».
 */
test("#3810 РОУТИ ЦИКЛУ: межа першим оператором, матриця й вкладка; пул звіряє «ожив» за правилом рядка перед показом і взяттям", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const body = (sig: string) => {
    const s = dash.indexOf(sig);
    assert.ok(s > 0, `🔴 обробник ${sig} не знайдено`);
    return dash.slice(s, dash.indexOf("\ndashboardRouter.", s + 10));
  };
  const dec = body('dashboardRouter.post("/react-decision"');
  assert.match(dec, /^[^\n]*\n\s*const auth = req\.auth!;\n\s*const clientKey = [^\n]*\n\s*if \(!clientKey \|\| !\(await canSeeClient\(auth, clientKey\)\)\) return res\.status\(403\)/,
    "🔴 /react-decision: межа не першим оператором — тіло валідовано до гейта (400 замість 403 ламає зліпок #11)");
  const list = body('dashboardRouter.get("/leadgen-pool"');
  assert.match(list, /const access = await leadgenPoolAccess\(auth\);\n\s*if \(!access\.canSee\) return res\.status\(403\)/, "🔴 пул віддається без межі");
  assert.match(list, /reactCycleRules\.poolRevived\(/, "🔴 пул показує клієнтів, не звіривши рахунки (4.4)");
  const take = body('dashboardRouter.post("/leadgen-pool/take"');
  assert.match(take, /const access = await leadgenPoolAccess\(auth\);\n\s*if \(!access\.canTake\) return res\.status\(403\)/, "🔴 брати може не лише лідген");
  assert.ok(take.indexOf("reactCycleRules.poolRevived(") > 0 && take.indexOf("reactCycleRules.poolRevived(") < take.indexOf('client.query("BEGIN")'),
    "🔴 перевірка «ожив» не ДО транзакції — ROLLBACK відкотить закриття рядка пулу");
  assert.match(take, /reactCycle\.take\(client,/, "🔴 взяття не в транзакції");
  const matrix = read("backend/src/auth/accessMatrix.ts");
  for (const p of ["/api/dashboard/react-decision", "/api/dashboard/leadgen-pool", "/api/dashboard/leadgen-pool/take"]) {
    assert.match(matrix, new RegExp(`path: "${p.replace(/\//g, "\\/")}"`), `🔴 ${p} немає в матриці доступу`);
  }
  const rt = read("backend/src/auth/routeTab.ts");
  assert.match(rt, /pre\("\/api\/dashboard\/react-decision"\), tabs: \["loyalty"\]/);
  assert.match(rt, /pre\("\/api\/dashboard\/leadgen-pool"\), tabs: \["loyalty"\]/);
});

// ─────────────────────────────── ЖИВИЙ SQL ───────────────────────────────

/**
 * #3809 🪞 — НАСКРІЗНО НА СПРАВЖНІЙ СХЕМІ: роути в процесі + джоба + ядро.
 * Чужий менеджер віддати не може (403); короткий коментар — 400; віддав → сповіщення ЛИШЕ іншим менеджерам (не собі,
 * не лідгену), клієнт у множині «немає в менеджера» і в «Нічийних» групою «віддав менеджер»; повторно — 409; інший
 * менеджер без прапорця бере собі → закріплення з поточного місяця, позначки й сповіщення немає, історія записана;
 * віддали знову, строк минув → джоба кладе в пул `orphan` (з нічийних зник, у пулі є); ожилий (рахунок після передачі)
 * → позначку знято, у пул не йде; CHECK не пускає позначку без коментаря; старий пул до 07.11 закрито `pool_off`.
 * 🧨 Червоніє, якщо будь-яка ланка ланцюга зламається на справжній БД (SQL у шаблоні не типізується — `db-sql.md`).
 */
test("#3809 🪞 ЖИВИЙ ЛАНЦЮГ: віддав → сповіщення → взяв; віддав → строк → пул; ожив → лишився; CHECK; старий пул закрито", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  try {
    // Старий пул ДО схеми: рядок, покладений 01.11, має закритись `pool_off`; свіжий (після 07.11) — ні.
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    await c.query(`INSERT INTO client_react_cycles (client_key, cycle_month, pooled_at, pool_reason) VALUES
      ('старий', '2026-10-01', '2026-11-01T10:00:00Z', 'auto'), ('свіжий', '2026-11-01', '2026-11-10T10:00:00Z', 'auto')`);
    await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
    const old = (await c.query<{ client_key: string; close_reason: string | null }>(
      `SELECT client_key, close_reason FROM client_react_cycles ORDER BY client_key`)).rows;
    assert.deepEqual(old, [{ client_key: "свіжий", close_reason: null }, { client_key: "старий", close_reason: "pool_off" }],
      "🔴 старий пул не закрито (або закрито й свіжий)");
    await c.query(`DELETE FROM client_react_cycles`);

    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК'),(50011,'Лідогенерація') ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage) VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'Віддає',1,true),(11,'Бере',1,true),(31,'Лідген',50011,true)
                   ON CONFLICT (id) DO NOTHING`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,is_active,orphan_pool) VALUES
      (1,'m@x','x','manager',10,true,false),(2,'n@x','x','manager',11,true,false),(3,'l@x','x','manager',31,true,false)`);
    const paid = (id: number, ck: string, mgr: number, ago: string) => c.query(
      `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,created_at_kommo,closed_at_kommo)
       VALUES ($1,$2,$3,8921932,142,1000,$2,$2,$2, now() - interval '${ago}' - interval '5 days', now() - interval '${ago}')`, [id, ck, mgr]);
    await paid(1, "відданий", 10, "40 days"); await paid(2, "відданий", 10, "80 days");
    await paid(3, "ожилий", 10, "40 days"); await paid(4, "ожилий", 10, "80 days");

    const { dashboardRouter } = await import("../routes/dashboard.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const route = (p: string) => (dashboardRouter as any).stack.find((l: any) => l.route?.path === p && l.route.methods.post);
    const call = async (p: string, user: { id: number; managerId: number }, body: Record<string, unknown>) => {
      let status = 200, json: Record<string, unknown> = {};
      const res = { status(x: number) { status = x; return res; }, json(b: Record<string, unknown>) { json = b; return res; }, setHeader() {} };
      const req = { auth: { userId: user.id, role: "manager", roleKey: "manager", managerId: user.managerId, teamId: 1 }, body };
      for (const l of route(p).route.stack) await l.handle(req, res, () => {});
      return { status, json };
    };
    const U1 = { id: 1, managerId: 10 }, U2 = { id: 2, managerId: 11 };
    const note = "не відповідає два місяці";

    assert.equal((await call("/orphan-clients/release", U2, { clientKey: "відданий", note })).status, 403, "🔴 чужий менеджер віддав клієнта");
    assert.equal((await call("/orphan-clients/release", U1, { clientKey: "відданий", note: "ой" })).status, 400, "🔴 прийнято короткий коментар");
    const r1 = await call("/orphan-clients/release", U1, { clientKey: "відданий", note });
    assert.equal(r1.status, 200, `🔴 «В нічийні» не пройшло: ${String(r1.json.error ?? "")}`);
    const rcp = (await c.query<{ user_id: number }>(
      `SELECT r.user_id FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
        WHERE n.type = 'client.orphan' AND n.done_at IS NULL ORDER BY r.user_id`)).rows.map((x) => x.user_id);
    assert.deepEqual(rcp, [2], "🔴 сповіщення отримав не той: має бути лише інший менеджер — не сам, не лідген");
    const R = await import("./orphanRelease.js");
    const { pool } = await import("../db/pool.js");
    assert.ok((await R.handedOffKeys(pool)).has("відданий"), "🔴 відданий лишився у списку менеджера (8349)");
    const M = await import("./metrics.js");
    const orph = (await M.orphanClients(18)).find((x) => x.clientKey === "відданий");
    assert.equal(orph?.reason, "released", "🔴 відданого немає в «Нічийних»");
    assert.equal((await call("/orphan-clients/release", U1, { clientKey: "відданий", note })).status, 409, "🔴 віддали вдруге — не 409");

    const tk = await call("/orphan-clients/claim", U2, { clientKey: "відданий", managerId: 11 });
    assert.equal(tk.status, 200, `🔴 менеджер без прапорця не взяв відданого: ${String(tk.json.error ?? "")}`);
    const lo = (await c.query<{ pinned_manager_id: number; released: boolean; from_month: boolean }>(
      `SELECT pinned_manager_id, released_at IS NOT NULL AS released,
              pinned_from_month = date_trunc('month', now() AT TIME ZONE 'Europe/Kyiv')::date AS from_month
         FROM loyalty_overrides WHERE client_key = 'відданий'`)).rows[0];
    assert.deepEqual(lo, { pinned_manager_id: 11, released: false, from_month: true }, "🔴 після «Взяти» не той стан закріплення/позначки");
    const open = await c.query(`SELECT 1 FROM notifications WHERE type = 'client.orphan' AND done_at IS NULL`);
    assert.equal(open.rowCount, 0, "🔴 сповіщення «візьміть» висить після «Взяти»");
    const hist = await c.query(`SELECT 1 FROM client_manager_history WHERE client_key = 'відданий' AND to_manager_id = 11 AND kind = 'fix'`);
    assert.equal(hist.rowCount, 1, "🔴 передачу не записано в історію");
    assert.equal((await R.handedOffKeys(pool)).has("відданий"), false, "🔴 взятий досі «немає в менеджера»");

    // Віддав новий власник; строк минув → джоба кладе в пул.
    assert.equal((await call("/orphan-clients/release", U2, { clientKey: "відданий", note })).status, 200);
    await c.query(`UPDATE loyalty_overrides SET released_at = now() - interval '5 days' WHERE client_key = 'відданий'`);
    // «ожилий»: віддали 5 днів тому, рахунок — 1 день тому (після передачі).
    assert.equal((await call("/orphan-clients/release", U1, { clientKey: "ожилий", note })).status, 200);
    await c.query(`UPDATE loyalty_overrides SET released_at = now() - interval '5 days' WHERE client_key = 'ожилий'`);
    await c.query(`INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,created_at_kommo)
                   VALUES (5,'ожилий',10,8921932,69716300,1000,'ожилий','ожилий','ожилий', now() - interval '2 days')`);
    await c.query(`INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at) VALUES (5,100274340,8921932, now() - interval '1 day')`);
    const { runOrphanToLeadgen } = await import("../jobs/orphanToLeadgen.js");
    const j = await runOrphanToLeadgen();
    assert.deepEqual({ moved: j.moved, revived: j.revived }, { moved: 1, revived: 1 }, "🔴 джоба: не той результат (лідгенам / ожили)");
    const pl = (await c.query<{ client_key: string; pool_reason: string; from_manager_id: number }>(
      `SELECT client_key, pool_reason, from_manager_id FROM client_react_cycles WHERE pooled_at IS NOT NULL AND closed_at IS NULL`)).rows;
    assert.deepEqual(pl, [{ client_key: "відданий", pool_reason: "orphan", from_manager_id: 11 }], "🔴 у пулі не той клієнт / причина / від кого");
    const left = (await c.query(`SELECT client_key FROM loyalty_overrides WHERE released_at IS NOT NULL`)).rowCount;
    assert.equal(left, 0, "🔴 після джоби в нічийних хтось лишився з позначкою");
    assert.ok((await R.handedOffKeys(pool)).has("відданий"), "🔴 клієнт у пулі лідгенів повернувся в список менеджера (8349)");
    assert.equal((await R.handedOffKeys(pool)).has("ожилий"), false, "🔴 ожилий не повернувся до менеджера");
    assert.equal((await M.orphanClients(18)).some((x) => x.clientKey === "відданий"), false, "🔴 клієнт у пулі лідгенів досі в нічийних");

    await assert.rejects(c.query(`UPDATE loyalty_overrides SET released_at = now(), released_by = 1, released_note = '  ' WHERE client_key = 'ожилий'`),
      /loyalty_overrides_released_note_chk/, "🔴 БД пустила позначку без коментаря");
    await pool.end().catch(() => {});
  } finally {
    await c.end();
    scratch.dispose();
  }
});
