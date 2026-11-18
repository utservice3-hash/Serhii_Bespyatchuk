import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🔗🏛 ЗАДАЧА 9230 — «зі створених: LinkedIn» і «зі створених: Prozorro» у Звіті (Роман 18.11.2026:
 * «добре давай додавати ці цифри у звіт»). Правила: LinkedIn — глосарій §20 (`linkedinDealSql`),
 * Prozorro — §21 (`prozorroDealSql`: джерело «AI тендер» АБО тег «AI тендер» / «Prozorro», старий «тендер» — ні).
 *
 * Партиція «зі створених» тепер із СЕМИ кошиків: реклама · лідоген · eLogist · LinkedIn · Prozorro · без джерела ·
 * канал не вказано. Нові кошики вирізаються ЛИШЕ з «без джерела»: канал («останній дотик») старший за мітку.
 * Живу рівність Σ == «Створено» на справжніх даних і далі тримає `#174` (`test:prod`); тут — механізм без БД.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
  for (const p of [path.resolve(here, "../../src"), path.resolve(here, "../../../backend/src")]) {
    try { statSync(path.join(p, "core/prozorroSource.ts")); return p; } catch { /* далі */ }
  }
  assert.fail("не знайдено backend/src — гейт не має права мовчки пропускатись");
})();
const src = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(SRC, "../../frontend/src", rel), "utf8");

function stubEnv(): void {
  process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  process.env.DATABASE_URL ??= "postgres://unused.invalid/x";
}

type Captured = { sql: string; params: unknown[] }[];
async function capturePool(reply: (sql: string) => { rows: unknown[] }): Promise<{ log: Captured; restore: () => void }> {
  stubEnv();
  const { pool } = await import("../db/pool.js");
  const orig = pool.query;
  const log: Captured = [];
  (pool as unknown as { query: unknown }).query = async (sql: unknown, params?: unknown[]) => {
    const text = typeof sql === "string" ? sql : String((sql as { text?: string })?.text ?? sql);
    log.push({ sql: text, params: params ?? [] });
    const r = reply(text);
    return { rows: r.rows, rowCount: r.rows.length };
  };
  return { log, restore: () => { (pool as unknown as { query: unknown }).query = orig; } };
}

/**
 * #9230 — Σ СЕМИ КОШИКІВ == СТВОРЕНО, і LinkedIn/Prozorro доїжджають із SQL у рядок ядра (і в зріз класу).
 *
 * 🧨 САБОТАЖ: прибрати `li` із суми `slice` у `createdSplitByManager` → червоніє зріз «нові».
 */
test("#9230 ПАРТИЦІЯ «ЗІ СТВОРЕНИХ» З LinkedIn І Prozorro: Σ семи кошиків == створено, у рядку й у зрізі класу", async () => {
  const z = { undef_ad: "0", undef_lg: "0", undef_el: "0", undef_li: "0", undef_pz: "0", undef_oth: "0", undef_nch: "0" };
  const fx = { manager_id: 7, name: "Тест", team_id: 1, created: "20", new_count: "12", repeat_count: "8", undef_count: "0",
    ad_count: "4", leadgen_count: "3", elogist_count: "2", linkedin_count: "5", prozorro_count: "3", other_count: "3", no_channel_count: "0",
    new_ad: "2", new_lg: "1", new_el: "1", new_li: "4", new_pz: "2", new_oth: "2", new_nch: "0",
    repeat_ad: "2", repeat_lg: "2", repeat_el: "1", repeat_li: "1", repeat_pz: "1", repeat_oth: "1", repeat_nch: "0", ...z };
  const cap = await capturePool(() => ({ rows: [fx] }));
  let rows: Awaited<ReturnType<typeof import("./metrics.js")["createdSplitByManager"]>> = [];
  try {
    const m = await import("./metrics.js");
    rows = await m.createdSplitByManager({ from: "2026-11-01", to: "2026-11-18" });
  } finally { cap.restore(); }
  const r = rows[0];
  assert.ok(r, "🔴 ядро не повернуло рядок — гейт втратив предмет");
  assert.equal(r.linkedinCount, 5, "🔴 кошик LinkedIn не доїхав із SQL у рядок ядра");
  assert.equal(r.prozorroCount, 3, "🔴 кошик Prozorro не доїхав із SQL у рядок ядра");
  assert.equal(r.adCount + r.leadgenCount + r.elogistCount + r.linkedinCount + r.prozorroCount + r.otherCount + r.noChannelCount,
    r.created, "🔴 Σ семи кошиків ≠ створено");
  assert.equal(r.sourceByKlass.new.created, 12, "🔴 зріз «нові»: Σ кошиків губить LinkedIn або Prozorro — перемикач покаже менше, ніж створено");
  assert.equal(r.sourceByKlass.rep.created, 8, "🔴 зріз «постійні»: Σ кошиків губить LinkedIn або Prozorro");
  const sql = cap.log[0]?.sql ?? "";
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE source = 'linkedin'\) AS linkedin_count/, "🔴 SQL не рахує кошик LinkedIn");
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE source = 'prozorro'\) AS prozorro_count/, "🔴 SQL не рахує кошик Prozorro");
  assert.match(sql, /klass = 'new' AND source = 'prozorro'\) AS new_pz/, "🔴 зріз класу не рахує Prozorro");
});

/**
 * #9230b — ПОРЯДОК ГІЛОК: канал старший за мітку, невідомий канал лишається невідомим.
 *
 * Перевіряється ВИХІД `dealSourceCase` (структура гілок CASE), а не позиція тексту у файлі. Обидва боки межі:
 * угода з тегом LinkedIn і каналом «реклама» — це реклама (інакше LinkedIn обікрав би рекламу, і «Прийнято реклами»
 * розійшлось би з «зі створених: реклама»); угода з тегом і каналом «інше» — LinkedIn.
 * Заміряно на scratch-базі 18.11.2026 (11 угод): ad+тег LinkedIn → ad, leadgen+тег Prozorro → leadgen,
 * NULL+тег LinkedIn → undef, LinkedIn+Prozorro → linkedin, тег «тендер» → other.
 *
 * 🧨 САБОТАЖ: переставити гілку LinkedIn вище за `= 'ad'` → червоніє.
 */
test("#9230b dealSourceCase: реклама / лідоген / eLogist / «не вказано» старші за LinkedIn і Prozorro, а ті — за «без джерела»", async () => {
  stubEnv();
  const m = await import("./metrics.js");
  const out = m.dealSourceCase("CH", { linkedin: "LI_MARK", prozorro: "PZ_MARK" });
  const branches = [...out.matchAll(/WHEN\s+(.+?)\s+THEN\s+'(\w+)'/g)].map((x) => `${x[1]} → ${x[2]}`);
  assert.deepEqual(branches, [
    "CH = 'ad' → ad", "CH = 'leadgen' → leadgen", "CH = 'elogist' → elogist", "CH IS NULL → undef",
    "LI_MARK → linkedin", "PZ_MARK → prozorro",
  ], "🔴 порядок гілок `dealSourceCase` змінився: мітка LinkedIn/Prozorro перебиває канал або невідомий канал");
  assert.match(out, /ELSE\s+'other'\s+END/, "🔴 «без джерела» перестав бути залишком");

  const { linkedinDealSql } = await import("./linkedinDeals.js");
  const { prozorroDealSql } = await import("./prozorroSource.js");
  const inline = m.dealSourceSql("d");
  assert.ok(inline.includes(`WHEN ${linkedinDealSql("d")} THEN 'linkedin'`), "🔴 інлайн-форма (розкриття дня) бере не правило LinkedIn з ядра");
  assert.ok(inline.includes(`WHEN ${prozorroDealSql("d")} THEN 'prozorro'`), "🔴 інлайн-форма (розкриття дня) бере не правило Prozorro з ядра");
  // CTE-форма: класифікатор мусить готувати ті самі ознаки, інакше Звіт і розкриття дня розійдуться.
  const met = src("core/metrics.ts");
  assert.equal((met.match(/\$\{linkedinDealSql\("dd?"\)\} AS is_li, \$\{prozorroDealSql\("dd?"\)\} AS is_pz/g) ?? []).length, 2,
    "🔴 `classifyCte` або `wonSplitCte` не готує ознаки is_li / is_pz з ядра");
});

/**
 * #9230c — ПРАВИЛО PROZORRO, фікстура по обидва боки: джерело «AI тендер», тег «AI тендер», тег «Prozorro» — так;
 * старий тег «тендер» (закритий тендерний відділ, 992 угоди), порожньо, LinkedIn — ні. SQL бере ті самі значення.
 *
 * 🧨 САБОТАЖ: додати «тендер» у `PROZORRO_TAGS` → червоніє.
 */
test("#9230c Prozorro = джерело «AI тендер» або тег «AI тендер» / «Prozorro»; старий тег «тендер» — ні", async () => {
  const p = await import("./prozorroSource.js");
  const yes = [
    { clientSource: "AI тендер", tags: null }, { clientSource: " AI тендер ", tags: [] },
    { clientSource: null, tags: ["AI тендер"] }, { clientSource: null, tags: ["Холодна_261026", "Prozorro"] },
  ];
  const no = [
    { clientSource: null, tags: ["тендер"] }, { clientSource: null, tags: null }, { clientSource: "", tags: [] },
    { clientSource: "LinkedIn", tags: ["LinkedIn"] }, { clientSource: "Prozorro", tags: null },
    { clientSource: null, tags: ["тендери-переможці-2026-06-02"] },
  ];
  for (const d of yes) assert.equal(p.isProzorroDeal(d), true, `🔴 не Prozorro, хоча мусить: ${JSON.stringify(d)}`);
  for (const d of no) assert.equal(p.isProzorroDeal(d), false, `🔴 Prozorro, хоча не мусить: ${JSON.stringify(d)}`);

  const sql = p.prozorroDealSql("x");
  for (const t of p.PROZORRO_TAGS) assert.ok(sql.includes(`'${t}'`), `🔴 SQL-правило не бере тег «${t}»`);
  assert.ok(sql.includes(`'${p.PROZORRO_CLIENT_SOURCE}'`), "🔴 SQL-правило не бере джерело «AI тендер»");
  assert.doesNotMatch(sql, /'тендер'/, "🔴 SQL-правило бере старий тег «тендер» — історія роздується закритим відділом");
  assert.match(sql, /x\.client_source/, "🔴 SQL-правило не на тому аліасі");
});

/**
 * #9230d — СВОГО SQL «ЩО ТАКЕ LinkedIn / Prozorro» ПОЗА ЯДРОМ НЕМАЄ. Критерій від предмета: рядок коду (без коментарів),
 * що звіряє `client_source` або `tags` з «LinkedIn» / «AI тендер» / «Prozorro». Дозволено лише двом файлам правила.
 *
 * 🧨 САБОТАЖ: дописати в `routes/dashboard.ts` `d.client_source = 'LinkedIn'` → червоніє з адресою.
 */
test("#9230d правило LinkedIn / Prozorro живе лише в linkedinDeals.ts і prozorroSource.ts", () => {
  const ALLOWED = new Set(["core/linkedinDeals.ts", "core/prozorroSource.ts"]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) files.push(p);
    }
  };
  walk(SRC);
  assert.ok(files.length > 200, `🔴 просканувано лише ${files.length} файлів — гейт осліп`);
  const bad: string[] = [];
  const RULE = /(client_source|tags)[^\n]*(LinkedIn|AI тендер|Prozorro)|(LinkedIn|AI тендер|Prozorro)[^\n]*(client_source|tags)/;
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join("/");
    if (ALLOWED.has(rel)) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (RULE.test(code)) bad.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `🔴 власна копія правила LinkedIn / Prozorro поза ядром: ${bad.join(", ")}`);
  // дзеркало: критерій бачить саме правило в дозволеному файлі, тобто він не беззубий
  assert.ok(RULE.test("COALESCE(btrim(d.client_source), '') = 'LinkedIn'"), "🔴 критерій гейта не впізнає правило");
});

/**
 * #9230e — КОШИКИ ДОЇЖДЖАЮТЬ ДО ЕКРАНА: `/report-plan` віддає, таблиця Звіту має колонки й клітинки, перемикач зрізу
 * їх не губить, чип розкриття дня має підписи, Звіт КВП показує в «Канал ств.».
 *
 * 🔴 Дзеркальна пастка `#175c`: поле є у відповіді й зникає з верстки.
 * 🧨 САБОТАЖ: прибрати `case "srcProzorro"` з таблиці → червоніє.
 */
test("#9230e LinkedIn і Prozorro видно на екрані: /report-plan, колонки Звіту, перемикач зрізу, чип дня, Звіт КВП", () => {
  const dash = src("routes/dashboard.ts");
  assert.match(dash, /srcLinkedin:\s*splitM\.get\(m\.id\)\?\.linkedinCount/, "🔴 `/report-plan` не віддає кошик LinkedIn");
  assert.match(dash, /srcProzorro:\s*splitM\.get\(m\.id\)\?\.prozorroCount/, "🔴 `/report-plan` не віддає кошик Prozorro");

  const cols = FE("pages/dashboard/reportTableCols.ts");
  for (const [k, t] of [["srcLinkedin", "зі створених: LinkedIn"], ["srcProzorro", "зі створених: Prozorro"]]) {
    assert.ok(cols.includes(`key: "${k}", title: "${t}"`), `🔴 у таблиці Звіту немає колонки «${t}»`);
    assert.match(cols, new RegExp(`${k}: "src"`), `🔴 колонка ${k} не в групі «джерело»`);
  }
  const table = FE("pages/dashboard/sections/ReportTableSection.tsx");
  for (const k of ["srcLinkedin", "srcProzorro"])
    assert.match(table, new RegExp(`case "${k}": return <td style=\\{st\\}>\\{m\\.${k} \\|\\| none\\}</td>`), `🔴 колонка ${k} є в переліку, але клітинка порожня`);

  const slice = FE("pages/dashboard/klassSlice.ts");
  assert.match(slice, /srcLinkedin:\s*v\.linkedinCount/, "🔴 перемикач зрізу губить кошик LinkedIn");
  assert.match(slice, /srcProzorro:\s*v\.prozorroCount/, "🔴 перемикач зрізу губить кошик Prozorro");

  const rp = FE("pages/dashboard/sections/ReportPlanSection.tsx");
  const chip = /function SrcChip[\s\S]*?\n\}/.exec(rp)?.[0] ?? "";
  assert.ok(chip, "🔴 не знайдено `SrcChip` — гейт втратив предмет");
  for (const [v, label] of [["linkedin", "LinkedIn"], ["prozorro", "Prozorro"]])
    assert.ok(chip.includes(`"${v}": { l: "${label}"`), `🔴 чип розкриття дня не малює «${label}»`);
  assert.match(src("core/dealSourceState.ts"), /v === "linkedin"[\s\S]*v === "prozorro"/, "🔴 `sourceOf` зводить LinkedIn / Prozorro у null");

  const kvp = FE("pages/dashboard/sections/KvpReportSection.tsx");
  assert.ok(kvp.includes("${c.crLinkedin || 0} / ${c.crProzorro || 0}"), "🔴 Звіт КВП: «Канал ств.» по тижнях без LinkedIn / Prozorro — сума не збіжеться зі «Створено»");
  assert.ok(kvp.includes('chip("LinkedIn", cs.linkedin)') && kvp.includes('chip("Prozorro", cs.prozorro)'), "🔴 Звіт КВП: рядок факту менеджера без LinkedIn / Prozorro");
});
