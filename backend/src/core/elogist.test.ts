import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🟣 eLogist — ОКРЕМИЙ КАНАЛ, НЕ РЕКЛАМА UTS (рішення власника 27.10.2026, «варіант А»).
 *
 * Гейти цього файла ЧИСТІ: жодного живого API й жодного scratch-кластера (рішення власника
 * 26.10.2026 — повний `npm test` локально не ганяємо, тож гейт, що вимагає БД, тут не виконався б
 * ніде). Там, де предикат живе в модулі з пулом, пул ПІДМІНЯЄТЬСЯ: ми перехоплюємо SQL, який
 * функція ядра РЕАЛЬНО віддає, — а не читаємо копію в тесті (урок `#214c`: «ліворуч має стояти
 * виклик ядра»). Підміна прибирається у `finally`, тож у бойову базу не йде жоден запит.
 *
 * ⚠️ Межа, названа вголос: виконання SQL на справжньому Postgres тут НЕ перевіряється (немає БД).
 * Синтаксис і семантику нових фрагментів треба прогнати на сервері до/після викату — це стоїть у
 * звіті проходу, а не прикидається покритим.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "core/elogist.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const src = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(SRC, "../../frontend/src", rel), "utf8");

/** Заглушки оточення: `config.js` кидає без них ще на імпорті. У БД ніхто не ходить — пул підмінено. */
function stubEnv(): void {
  process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  process.env.DATABASE_URL ??= "postgres://unused.invalid/x";
}

type Captured = { sql: string; params: unknown[] }[];
/** Підміняє `pool.query`: віддає `reply(sql)` і складає кожен запит у `log`. Повертає «відновити». */
async function capturePool(reply: (sql: string) => { rows: unknown[]; rowCount?: number }): Promise<{ log: Captured; restore: () => void }> {
  stubEnv();
  const { pool } = await import("../db/pool.js");
  const orig = pool.query;
  const log: Captured = [];
  (pool as unknown as { query: unknown }).query = async (sql: unknown, params?: unknown[]) => {
    const text = typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? sql);
    log.push({ sql: text, params: params ?? [] });
    const r = reply(text);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  };
  return { log, restore: () => { (pool as unknown as { query: unknown }).query = orig; } };
}

const QUAL = 8921928, QUAL_OLD = 7336928, FC = 8921932;
const lead = (o: Partial<{ pipelineId: number; statusId: number; name: string; clientSource: string | null }>) =>
  ({ pipelineId: QUAL, statusId: 69693652, name: "Іван — +380501112233", clientSource: "uts.ua", ...o });

/**
 * #2490 — ОЗНАЧЕННЯ ВЛАСНИКА: кожна з трьох ознак ОКРЕМО робить лід Кваліфікації eLogist-лідом;
 * звичайна заявка uts.ua — ні. І те саме означення ставить канал на апсерті (`extractLeadSource`).
 *
 * 🔴 Фікстура по ОБИДВА боки кожної межі (правило 11): назва «eLogist — …» так / «eLogistics …» ні;
 * етап 108581472 у Кваліфікації так / той самий id поза нею ні; FC-угода з «Источник клиента» —
 * eLogist-угода (`isElogistMark`), але НЕ «лід Кваліфікації» (`isElogistLead`).
 *
 * 🧨 САБОТАЖ: прибрати `|| NAME_RE.test(...)` з `ownMark` у `core/elogist.ts` → червоніє на
 * «назва без поля й етапу» (історичні ліди серпня–жовтня знову стали б рекламою); прибрати гілку
 * `isElogistMark` з `extractLeadSource` → червоніє на каналі апсерту.
 */
test("#2490 eLogist-ЛІД: поле, назва й етап КОЖНЕ позначає лід Кваліфікації; заявка uts.ua — ні; апсерт ставить канал elogist", async () => {
  const e = await import("./elogist.js");
  // ✅ кожна ознака окремо (решта — від звичайної заявки uts.ua)
  assert.equal(e.isElogistLead(lead({ clientSource: "elogist.com.ua" })), true, "🔴 «Источник клиента» = elogist.com.ua не позначає лід");
  assert.equal(e.isElogistLead(lead({ name: "eLogist — +380501112233" })), true, "🔴 назва «eLogist — …» (історія з серпня) не позначає лід");
  assert.equal(e.isElogistLead(lead({ statusId: 108581472 })), true, "🔴 етап «Заявки eLogist (сайт)» не позначає лід");
  assert.equal(e.isElogistLead(lead({ pipelineId: QUAL_OLD, clientSource: "elogist.com.ua" })), true, "🔴 стара Кваліфікація 7336928 випала з означення");
  // ❌ дзеркало: звичайна заявка й межі
  assert.equal(e.isElogistLead(lead({})), false, "🔴 звичайна заявка uts.ua позначена як eLogist — реклама UTS зникне");
  assert.equal(e.isElogistLead(lead({ name: "eLogistics ТОВ — перевезення" })), false, "🔴 назва, що лише ПОЧИНАЄТЬСЯ так само, позначена як eLogist");
  assert.equal(e.isElogistLead(lead({ name: "Клієнт eLogist" })), false, "🔴 «eLogist» усередині назви — не префікс");
  assert.equal(e.isElogistLead(lead({ clientSource: null, name: "" })), false);
  // Воронка: FC-угода з ознакою — eLogist-угода, але не «лід Кваліфікації»; етап поза Кваліфікацією — не ознака.
  assert.equal(e.isElogistMark(lead({ pipelineId: FC, clientSource: "elogist.com.ua" })), true, "🔴 лід, що переїхав у FC, загубив ознаку eLogist");
  assert.equal(e.isElogistLead(lead({ pipelineId: FC, clientSource: "elogist.com.ua" })), false, "🔴 угода FC прочиталась як лід Кваліфікації");
  assert.equal(e.isElogistMark(lead({ pipelineId: FC, statusId: 108581472 })), false, "🔴 id етапу поза Кваліфікацією став ознакою");

  // Апсерт: канал ставить ТЕ САМЕ означення; лідоген лишається першим, eLogist — перед рекламою.
  stubEnv();
  const { extractLeadSource } = await import("../kommo/client.js");
  const deal = (o: { name?: string; status?: number; pipeline?: number; fields?: [number, string][] }) => ({
    id: 1, name: o.name ?? "Іван — +380", price: 0, pipeline_id: o.pipeline ?? QUAL, status_id: o.status ?? 69693652,
    responsible_user_id: 0, created_at: 0, updated_at: 0, closed_at: null,
    custom_fields_values: (o.fields ?? []).map(([field_id, value]) => ({ field_id, values: [{ value }] })),
  });
  const UTM = 481993, LG = 2098037, CS = 2098035;
  assert.equal(extractLeadSource(deal({ fields: [[CS, "elogist.com.ua"]] }) as never).channel, "elogist", "🔴 апсерт: поле eLogist не дало каналу elogist");
  assert.equal(extractLeadSource(deal({ name: "eLogist — +380", fields: [[UTM, "google"]] }) as never).channel, "elogist",
    "🔴 апсерт: eLogist-лід з utm-міткою знову став «рекламою» — eLogist мусить стояти ПЕРЕД рекламою");
  assert.equal(extractLeadSource(deal({ status: 108581472 }) as never).channel, "elogist", "🔴 апсерт: етап eLogist не дав каналу");
  assert.equal(extractLeadSource(deal({ status: 108581472, fields: [[LG, "Ковтонюк"]] }) as never).channel, "leadgen",
    "🔴 апсерт: лідоген перестав бути першим — eLogist-ознака перебила «Лидогенератор»");
  assert.equal(extractLeadSource(deal({ fields: [[UTM, "google"], [CS, "uts.ua"]] }) as never).channel, "ad",
    "🔴 апсерт: звичайна заявка з utm більше не реклама — дзеркало зламане");
});

/**
 * #2490b — ОДНЕ МІСЦЕ ОЗНАЧЕННЯ. SQL-фрагмент збудовано з тих самих констант, що TS-предикат, і
 * ЖОДЕН інший файл бекенду не тримає власної копії ознаки (текст `elogist.com.ua` / id етапу
 * `108581472` / префікс назви в SQL).
 *
 * 🔴 Чому скан ФАЙЛІВ, а не «ми ж винесли»: друга копія умови — це рівно той клас, що «новий/
 * постійний» у двох місцях (12.6% угод серпня розходились). Критерій — від предмета: «будь-який
 * не-тестовий .ts бекенду, що пише ознаку eLogist», а не «файли зі словом eLogist» (правило 12).
 *
 * 🧨 САБОТАЖ: вписати в `core/leadTake.ts` власне `d.client_source = 'elogist.com.ua'` → червоніє
 * з іменем файла; прибрати етап із `elogistMarkSql` → червоніє перша половина.
 */
test("#2490b ОДНЕ МІСЦЕ: SQL-фрагмент із тих самих констант, що TS-предикат; копій ознаки eLogist поза core/elogist.ts немає", async () => {
  const e = await import("./elogist.js");
  const sql = e.elogistMarkSql("d");
  for (const [what, needle] of [
    ["«Источник клиента»", `'${e.ELOGIST_CLIENT_SOURCE}'`], ["етап", String(e.ELOGIST_STAGE_ID)],
    ["префікс назви з межею слова", `'^${e.ELOGIST_NAME_PREFIX}\\M'`], ["Кваліфікація", `ARRAY[${QUAL}, ${QUAL_OLD}]`],
  ] as const) assert.ok(sql.includes(needle), `🔴 SQL-форма ознаки втратила ${what} (${needle})`);
  assert.ok(e.elogistLeadSql("q").includes(e.elogistMarkSql("q")), "🔴 означення ліда більше не будується з ознаки — їх стало дві");
  assert.equal(e.ELOGIST_CLIENT_SOURCE_ENUM_ID, 6348933);

  const ALLOWED = new Set(["core/elogist.ts", "core/stageNames.ts"]); // stageNames — підпис етапу, не ознака
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!n.endsWith(".ts") || n.endsWith(".test.ts")) continue;
      const rel = path.relative(SRC, p).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const t = readFileSync(p, "utf8");
      if (/'elogist\.com\.ua'|"elogist\.com\.ua"/.test(t) || /\b108581472\b/.test(t) || /ILIKE\s+'elogist|~\s*'\^eLogist/i.test(t)) bad.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(bad, [], "🔴 ВЛАСНА копія ознаки eLogist поза core/elogist.ts — друге означення розійдеться з першим мовчки");
});

/**
 * #2491 — РЕКЛАСИФІКАЦІЯ: eLogist-дотик окремо від рекламного, eLogist стоїть ПЕРЕД рекламою, а
 * лідоген — РІВНО ЯК БУВ.
 *
 * Перехоплюється SQL, який `reclassifyAdChannel` РЕАЛЬНО відправляє (пул підмінено), — не джерело.
 * Твердження змістові, не позиційні по файлу (правило 9): порядок гілок — у тексті CASE запиту.
 *
 * 🔴 Чому лідоген порівнюється з GREATEST(ad_t, el_t): до 27.10 eLogist-ліди сиділи в `adq`, і
 * старий `ad_t` = MAX по них теж. Порівняння з одним новим `ad_t` перевело б частину угод
 * «реклама/eLogist → лідоген» — тобто змінило б лідоген, чого власник не просив.
 *
 * 🧨 САБОТАЖ: `adq AS (SELECT client_key, t FROM touchq WHERE NOT is_el)` → `WHERE true` (eLogist
 * знову рекламний дотик) → червоніє; переставити гілки `'elogist'` нижче `'ad'` → червоніє;
 * `GREATEST(ad_t, el_t)` → `ad_t` → червоніє.
 */
test("#2491 РЕКЛАСИФІКАЦІЯ: eLogist-дотик не рекламний, eLogist перед рекламою, лідоген порівнюється з тим самим, що до 27.10", async () => {
  const cap = await capturePool((sql) => (/FROM app_settings/.test(sql)
    ? { rows: [{ data: { adSources: ["uts.ua"] } }] } : { rows: [], rowCount: 0 }));
  let sql = "";
  try {
    const { reclassifyAdChannel } = await import("../jobs/syncKommo.js");
    await reclassifyAdChannel();
    sql = cap.log.find((q) => /UPDATE deals d SET lead_channel/.test(q.sql))?.sql ?? "";
  } finally { cap.restore(); }
  assert.ok(sql, "🔴 запит рекласифікації не перехоплено — гейт втратив предмет");
  const e = await import("./elogist.js");
  const flat = sql.replace(/\s+/g, " ");

  assert.ok(flat.includes(`${e.elogistLeadSql("q").replace(/\s+/g, " ")} AS is_el`), "🔴 дотик Кваліфікації більше не розрізняє eLogist спільним означенням");
  assert.match(flat, /adq AS \(SELECT client_key, t FROM touchq WHERE NOT is_el\)/, "🔴 eLogist-ліди знову рекламні дотики (adq їх не виключає)");
  assert.match(flat, /elq AS \(SELECT client_key, t FROM touchq WHERE is_el\)/, "🔴 немає eLogist-дотику (elq)");
  assert.ok(flat.includes(`${e.elogistMarkSql("f").replace(/\s+/g, " ")} AS own_el`), "🔴 угода, що сама прийшла з eLogist у FC, не впізнається");
  // Спільні умови дотику (143, лідоген-маркери) стоять ОДИН раз — у touchq, тож adq ∪ elq = старий adq.
  const touch = flat.slice(flat.indexOf("touchq AS ("), flat.indexOf("adq AS ("));
  assert.ok(touch.includes("q.status_id <> 143"), "🔴 «Сміття» 143 більше не виключене з дотиків");

  const caseBody = flat.slice(flat.indexOf("CASE WHEN lead_generator"), flat.indexOf("END AS target"));
  assert.ok(caseBody, "🔴 не знайдено CASE каналу");
  assert.match(caseBody, /WHEN lg_t IS NOT NULL AND \(GREATEST\(ad_t, el_t\) IS NULL OR lg_t >= GREATEST\(ad_t, el_t\)\) THEN 'leadgen'/,
    "🔴 лідоген порівнюється не з тим, що до 27.10 — частина угод тихо змінить канал лідогену");
  const lastLg = caseBody.lastIndexOf("THEN 'leadgen'"), firstEl = caseBody.indexOf("THEN 'elogist'"), firstAd = caseBody.indexOf("THEN 'ad'");
  assert.ok(lastLg >= 0 && firstEl > lastLg, "🔴 eLogist стоїть ВИЩЕ за лідоген — лідоген втратив пріоритет");
  assert.ok(firstAd > firstEl, "🔴 реклама стоїть вище за eLogist — eLogist-лід знову забере реклама");
  assert.match(caseBody, /WHEN own_el THEN 'elogist'/);
  assert.match(caseBody, /WHEN el_t IS NOT NULL AND \(ad_t IS NULL OR el_t >= ad_t\) THEN 'elogist'/, "🔴 «останній дотик» eLogist проти реклами зламаний");
  // Гейт власника «мітка АБО новий» — лише для реклами (рішення 27.10): у гілках eLogist його немає.
  const elBranches = caseBody.slice(caseBody.indexOf("WHEN own_el"), caseBody.indexOf("WHEN ad_t IS NOT NULL"));
  assert.ok(elBranches.length > 0, "🔴 не знайдено гілок eLogist перед рекламною");
  assert.doesNotMatch(elBranches, /is_repeat|has_tag/, "🔴 рекламний гейт власника потрапив у гілки eLogist");
  // Дзеркало: реклама на місці і під своїм гейтом.
  assert.match(caseBody, /WHEN ad_t IS NOT NULL AND COALESCE\(client_source, ''\) NOT ILIKE '%реактив%' AND \(has_tag OR NOT is_repeat\) THEN 'ad'/,
    "🔴 рекламна гілка зникла або втратила гейт — дзеркало зламане");
});

/**
 * #2491b — `adDealSql` / `paidAdSql`: eLogist НЕ реклама UTS на ОБОХ шляхах у «рекламу».
 *
 * Шляхів два: `lead_channel='ad'` і `client_source ∈ adSources` (+ cpc-мітка в `paidAdSql`).
 * eLogist-лід із `client_source='uts.ua'` чи міткою своєї кампанії пройшов би другим — тому
 * виключення стоїть доданком на ВЕСЬ предикат (той самий прийом, що гейт дотику `#33`).
 * Перевіряється рядок, який повертає ФУНКЦІЯ ядра, а не текст файла.
 *
 * 🧨 САБОТАЖ: прибрати `AND ${notElogistSql("d")}` з `adDealSqlMode` → червоніє; прибрати його з
 * `paidAdSql` → червоніє друга половина.
 */
test("#2491b РЕКЛАМА UTS: adDealSql і paidAdSql виключають eLogist доданком на весь предикат; реклама при цьому лишається", async () => {
  stubEnv();
  const m = await import("./metrics.js");
  const e = await import("./elogist.js");
  const excl = e.notElogistSql("d");
  for (const mode of ["correlated", "joined"] as const) {
    const s = m.adDealSqlMode("$1", mode);
    assert.ok(s.trimEnd().endsWith(`AND ${excl})`), `🔴 adDealSql (${mode}): eLogist не виключений на весь предикат`);
    // Дзеркало: обидва шляхи реклами живі.
    assert.match(s, /d\.client_source = ANY\(\$1\) OR d\.lead_channel = 'ad'/, `🔴 adDealSql (${mode}): зник шлях у рекламу — реклама зникне цілком`);
  }
  assert.match(excl, /lead_channel IS DISTINCT FROM 'elogist'/, "🔴 виключення не бачить канал (і NULL-пастка: `<>` при NULL дав би NULL)");
  assert.ok(excl.includes(`NOT ${e.elogistMarkSql("d")}`), "🔴 виключення не бачить ознаку — старі ліди до бекфілу лишаться рекламою");
  // paidAdSql не експортований — його тіло читаємо з джерела, але межі змістові (ім'я константи).
  const met = src("core/metrics.ts");
  const paid = /const paidAdSql = [\s\S]*?`;\n/.exec(met)?.[0] ?? "";
  assert.ok(paid, "🔴 не знайдено paidAdSql — гейт втратив предмет");
  assert.match(paid, /AND \$\{notElogistSql\("d"\)\}\)`;/, "🔴 paidAdSql: веб-платна гілка пускає eLogist у знаменник конверсії реклами UTS");
});

/**
 * #2492 — ПАРТИЦІЯ `#174` З eLogist: ad + leadgen + elogist + other + noChannel == created.
 *
 * Перевіряється РЕАЛЬНИЙ маппінг `createdSplitByManager` (пул віддає рядок-фікстуру), тобто як
 * ядро складає кошики, — плюс те, що SQL справді рахує `source = 'elogist'`, а `dealSourceCase`
 * має для нього власну гілку (інакше eLogist тихо осів би в catch-all «без джерела» і сума
 * зійшлась би, ховаючи канал). Живий `#174` робить те саме на справжніх даних — у `test:prod`.
 *
 * 🧨 САБОТАЖ: прибрати `el` із суми `slice` → червоніє «зріз класу»; прибрати гілку `'elogist'` з
 * `dealSourceCase` → червоніє; прибрати `srcElogist` з `/report-plan` чи з колонок таблиці → червоніє.
 */
test("#2492 ПАРТИЦІЯ ДЖЕРЕЛА З eLogist: Σ п'яти кошиків == створено — у ядрі, роуті й таблиці", async () => {
  const fx = { manager_id: 7, name: "Тест", team_id: 1, created: "15", new_count: "9", repeat_count: "6", undef_count: "0",
    ad_count: "4", leadgen_count: "3", elogist_count: "5", other_count: "3", no_channel_count: "0",
    new_ad: "2", new_lg: "1", new_el: "4", new_oth: "2", new_nch: "0",
    repeat_ad: "2", repeat_lg: "2", repeat_el: "1", repeat_oth: "1", repeat_nch: "0",
    undef_ad: "0", undef_lg: "0", undef_el: "0", undef_oth: "0", undef_nch: "0" };
  const cap = await capturePool(() => ({ rows: [fx] }));
  let rows: Awaited<ReturnType<typeof import("./metrics.js")["createdSplitByManager"]>> = [];
  try {
    const m = await import("./metrics.js");
    rows = await m.createdSplitByManager({ from: "2026-10-01", to: "2026-10-27" });
  } finally { cap.restore(); }
  const r = rows[0];
  assert.ok(r, "🔴 ядро не повернуло рядок — гейт втратив предмет");
  assert.equal(r.elogistCount, 5, "🔴 кошик eLogist не доїхав із SQL у рядок ядра");
  assert.equal(r.adCount + r.leadgenCount + r.elogistCount + r.otherCount + r.noChannelCount, r.created, "🔴 Σ п'яти кошиків ≠ створено");
  assert.equal(r.sourceByKlass.new.created, 9, "🔴 зріз «нові»: Σ кошиків без eLogist — перемикач покаже менше, ніж створено");
  assert.equal(r.sourceByKlass.rep.created, 6, "🔴 зріз «постійні»: Σ кошиків без eLogist");
  const sql = cap.log[0]?.sql ?? "";
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE source = 'elogist'\) AS elogist_count/, "🔴 SQL не рахує кошик eLogist");
  assert.match(sql, /klass = 'new' AND source = 'elogist'\) AS new_el/, "🔴 зріз класу не рахує eLogist");

  const met = src("core/metrics.ts");
  const fn = /export function dealSourceCase[\s\S]*?\n\}/.exec(met)?.[0] ?? "";
  assert.match(fn, /= 'elogist' THEN 'elogist'[\s\S]*ELSE\s+'other'/, "🔴 `dealSourceCase` без власної гілки eLogist — канал осяде в «без джерела»");

  assert.match(src("routes/dashboard.ts"), /srcElogist:\s*splitM\.get\(m\.id\)\?\.elogistCount/, "🔴 `/report-plan` не віддає кошик eLogist");
  const cols = FE("pages/dashboard/reportTableCols.ts");
  assert.ok(cols.includes('key: "srcElogist"'), "🔴 у таблиці Звіту немає колонки «зі створених: eLogist»");
  assert.match(FE("pages/dashboard/klassSlice.ts"), /srcElogist:\s*v\.elogistCount/, "🔴 перемикач зрізу губить кошик eLogist");
});

/**
 * #2493 — СТАН ДЖЕРЕЛА «eLogist» доїжджає до чипа розкриття дня.
 *
 * 🔴 `sourceOf` незнайоме значення зводить у `null` (свідомо, `#175d`). Отже без гілки eLogist
 * чип eLogist-угоди тихо став би «питання незастосовне» — як рядок-дзвінок.
 *
 * 🧨 САБОТАЖ: прибрати `v === "elogist"` з `sourceOf` → червоніє; прибрати `"elogist"` з білого
 * списку `/report-plan/deals` або з `SrcChip` → червоніє.
 */
test("#2493 sourceOf і чип знають eLogist: стан не зводиться в null, підпис «eLogist» є", async () => {
  const { sourceOf } = await import("./dealSourceState.js");
  assert.equal(sourceOf("elogist"), "elogist", "🔴 стан eLogist зведено в null — чип угоди зникне");
  assert.equal(sourceOf("ad"), "ad", "🔴 дзеркало: реклама перестала розпізнаватись");
  const chip = /function SrcChip[\s\S]*?\n\}/.exec(FE("pages/dashboard/sections/ReportPlanSection.tsx"))?.[0] ?? "";
  assert.match(chip, /"elogist":\s*\{\s*l:\s*"eLogist"/, "🔴 чип не малює джерело eLogist");
  assert.match(src("routes/dashboard.ts"), /x\.source === "elogist"/, "🔴 білий список `/report-plan/deals` відкидає eLogist у null");
});

/**
 * #2494 — ВІКНО «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ»: eLogist — окреме джерело; із «Реклами» й «Сайту» він
 * виключений, «Все» — чотири джерела. Екран «Відповідь на заявку» лишається про заявки UTS.
 *
 * 🧨 САБОТАЖ: прибрати `AND NOT ${el}` з `ad()` у `leadSelection` → червоніє (одна заявка в двох
 * джерелах, eLogist у рекламі); прибрати `NOT elogistMarkSql` з `leadResponse.ts` → червоніє.
 */
test("#2494 ВІКНО ЗАЯВОК: джерело eLogist окреме, у «Рекламі» й «Сайті» його немає, «Все» = чотири", async () => {
  stubEnv();
  const lt = await import("./leadTake.js");
  const e = await import("./elogist.js");
  const mark = e.elogistMarkSql("d");
  const conds = (source: "ad" | "site" | "leadgen" | "elogist" | "all") =>
    lt.leadSelection({ from: "2026-10-01", to: "2026-10-27", source }).conds.join(" AND ");
  assert.ok(conds("ad").includes(`NOT ${mark}`), "🔴 «Реклама» вікна включає eLogist");
  assert.ok(conds("site").includes(`NOT ${mark}`), "🔴 «Сайт» вікна включає eLogist");
  assert.ok(conds("elogist").includes(mark) && !conds("elogist").includes(`NOT ${mark}`), "🔴 джерело «eLogist» не відбирає eLogist");
  assert.ok(conds("all").includes(` OR ${mark})`), "🔴 «Все» не включає eLogist");
  assert.ok(!conds("leadgen").includes(mark), "🔴 дзеркало: «Лідгени» несподівано залежать від eLogist");
  assert.match(src("routes/dashboard.ts"), /\["all", "ad", "site", "leadgen", "elogist"\]\.includes\(source\)/, "🔴 роут відхиляє джерело eLogist");
  assert.match(FE("pages/dashboard/sections/LeadTakeCard.tsx"), /\["elogist", "eLogist"\]/, "🔴 у вікні немає перемикача «eLogist»");
  assert.match(src("core/leadResponse.ts"), /sel\.conds\.push\(`NOT \$\{elogistMarkSql\("d"\)\}`\)/,
    "🔴 «Відповідь на заявку» почала рахувати eLogist — і як «лідгени», бо джерело не основне");
});

/**
 * #2495 — ЕКРАН «РЕКЛАМА»: eLogist окремим рядком; гроші — `receivedByChannel` по каналу 'elogist',
 * а в рекламні гроші він не входить.
 *
 * 🧨 САБОТАЖ: у `receivedByChannel` віддати `elogist` з `lg_rev` → червоніє; прибрати рядок
 * `data.elogist` з `AdsSection` → червоніє.
 */
test("#2495 «РЕКЛАМА»: eLogist окремим рядком; гроші каналу elogist, у рекламні гроші не входять", async () => {
  const cap = await capturePool(() => ({ rows: [{ ad_rev: "1000", ad_deals: "3", lg_rev: "200", lg_deals: "1", el_rev: "500", el_deals: "2" }] }));
  let got: Awaited<ReturnType<typeof import("./money.js")["receivedByChannel"]>> | null = null;
  try {
    const money = await import("./money.js");
    got = await money.receivedByChannel({ from: "2026-10-01", to: "2026-10-27" }, ["uts.ua"]);
  } finally { cap.restore(); }
  assert.deepEqual(got?.elogist, { revenue: 500, deals: 2 }, "🔴 гроші eLogist беруться не зі свого стовпця");
  assert.deepEqual(got?.ad, { revenue: 1000, deals: 3 }, "🔴 дзеркало: рекламні гроші зламані");
  const sql = (cap.log[0]?.sql ?? "").replace(/\s+/g, " ");
  assert.match(sql, /FILTER \(WHERE d\.lead_channel = 'elogist'\),0\) AS el_rev/, "🔴 гроші eLogist рахуються не по каналу elogist");
  const e = await import("./elogist.js");
  assert.ok(sql.includes(e.notElogistSql("d").replace(/\s+/g, " ")), "🔴 рекламні гроші не виключають eLogist");
  const route = src("routes/dashboard.ts");
  assert.match(route, /elogist: \{ leads: elogistLeads, revenue: revenue\.elogist\.revenue, revenueDeals: revenue\.elogist\.deals \}/,
    "🔴 `/ads` не віддає рядок eLogist");
  assert.match(FE("pages/dashboard/sections/AdsSection.tsx"), /data\.elogist\.leads/, "🔴 екран «Реклама» не показує ліди eLogist");
});

/**
 * #2496 — РАЗОВИЙ БЕКФІЛ: лише ліди Кваліфікації з ознакою, лідоген не чіпає, ідемпотентний.
 *
 * 🧨 САБОТАЖ: прибрати `lead_generator IS NULL` → червоніє (лідоген став би eLogist); прибрати
 * `IS DISTINCT FROM 'elogist'` → червоніє (повтор переписував би ті самі рядки й не був би нулем).
 */
test("#2496 БЕКФІЛ eLogist: лише ліди Кваліфікації з ознакою, без лідогену, повтор — нуль рядків", async () => {
  const e = await import("./elogist.js");
  const sql = e.elogistBackfillSql().replace(/\s+/g, " ");
  assert.match(sql, /^UPDATE deals d SET lead_channel = 'elogist' WHERE /, "🔴 бекфіл пише не той канал або не в ту таблицю");
  assert.ok(sql.includes(e.elogistLeadSql("d").replace(/\s+/g, " ")), "🔴 бекфіл бере не означення ліда Кваліфікації — зачепить FC або чужі угоди");
  assert.match(sql, /d\.lead_generator IS NULL/, "🔴 бекфіл переписав би лідоген на eLogist");
  assert.match(sql, /d\.lead_channel IS DISTINCT FROM 'leadgen'/, "🔴 бекфіл переписав би канал лідогену");
  assert.match(sql, /d\.lead_channel IS DISTINCT FROM 'elogist'/, "🔴 бекфіл не ідемпотентний: повтор чіпає вже перемічені рядки");
  assert.match(src("tools/backfillElogistChannel.ts"), /process\.argv\.includes\("--write"\)/, "🔴 інструмент пише без прапорця --write — сухого прогону немає");
});
