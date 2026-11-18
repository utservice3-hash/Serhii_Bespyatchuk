import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * 🎯 ЗАДАЧА 9932 — «ПРИЙНЯТО РЕКЛАМИ» ЗА ПРАВИЛОМ СЕРГІЯ (TOP Weekly 16.11.2026; Юля 17.11: «і для „Прийнято
 * реклами“ теж»; Роман 17.11 — «роби», «викочуй»). Ядро — `metrics.adsAcceptedSql` / `adsAcceptedCte`.
 *
 * Що стережемо:
 *   • `#9932`  — `adDealSql` (рекламні гроші, CPL, ліди) НЕ змінився, гроші правила не бачать;
 *   • `#9932b` — поведінка правила на фікстурі ПО ОБИДВА БОКИ кожної межі (scratch-БД);
 *   • `#9932c` — роут `/report` (плитка «Прийнято реклами», actByMgr) кличе САМЕ нове правило (замість `#24q`).
 * Живий гейт «стара множина ⊆ нова» — `#9932d` у `core/priorPaid.test.ts` (там уже стоїть живий пул).
 */

const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

function stubEnv(): void {
  process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
  process.env.DATABASE_URL ??= "postgres://unused.invalid/x";
}

/** Одна scratch-БД на файл (пул `db/pool.js` — один на процес). Немає бінарів PostgreSQL — `skip` через `skipReason`. */
let shared: Promise<{ c: import("pg").Client } | { skip: string }> | null = null;
async function scratchDb(): Promise<{ c: import("pg").Client } | { skip: string }> {
  shared ??= (async () => {
    const { provisionScratch } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return { skip: skipReason(scratch) };
    process.env.DATABASE_URL = scratch.url;
    stubEnv();
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    await c.query(SRC("db/schema.sql"));
    return { c };
  })();
  return shared;
}
after(async () => {
  const s = shared ? await shared : null;
  if (!s || !("c" in s)) return;
  await s.c.end().catch(() => undefined);
  const { pool } = await import("../db/pool.js");
  await pool.end().catch(() => undefined);
});

/**
 * #9932 — ПРАВИЛО ДОДАНО ДО «ПРИЙНЯТО РЕКЛАМИ», А НЕ ДО `adDealSql`.
 * 🧨 Червоніє, якщо правило потрапить у `adDealSql` (тоді постійний клієнт стане платним лідом, а його гроші —
 * рекламними), якщо гроші почнуть брати нове правило, або якщо з другої половини зникне лідоген / реактивація /
 * eLogist / порядок у часі. Дзеркало: обидві половини в предикаті є (інакше він став би старим `adDealSql`).
 */
test("#9932 ПРАВИЛО СЕРГІЯ — ЛИШЕ В «ПРИЙНЯТО РЕКЛАМИ»: adDealSql і гроші не зачеплені, винятки на місці", async () => {
  // Спершу scratch (якщо є): пул `db/pool.js` створюється на першому імпорті й привʼязується до тієї адреси.
  await scratchDb();
  stubEnv();
  const m = await import("./metrics.js");
  const e = await import("./elogist.js");
  for (const mode of ["correlated", "joined"] as const) {
    assert.doesNotMatch(m.adDealSqlMode("$1", mode), /\bao\.|ad_origin|ad_paid_at/,
      `🔴 adDealSql (${mode}) читає правило Сергія — постійний клієнт став би рекламним лідом у грошах, CPL і списках дзвінків`);
  }
  const s = m.adsAcceptedSql("$7");
  assert.ok(s.startsWith(`(${m.adDealSqlMode("$7", "joined")} OR `),
    "🔴 «Прийнято реклами» не містить старого рекламного предиката — угоди, що рекламні вже зараз, випали б");
  assert.ok(s.includes(m.AD_ORIGIN_SQL), "🔴 «Прийнято реклами» без правила Сергія — стара метрика");
  const o = m.AD_ORIGIN_SQL;
  assert.match(o, /ao\.ad_paid_at < d\.created_at_kommo/, "🔴 зник порядок у часі: угода ДО оплати стала б рекламою");
  assert.match(o, /d\.lead_channel IS DISTINCT FROM 'leadgen'/, "🔴 лідоген більше не має пріоритету над правилом (глосарій §3a)");
  assert.match(o, /NOT ILIKE '%реактив%'/, "🔴 реактивація пройшла б за правилом Сергія");
  assert.ok(o.includes(e.notElogistSql("d")), "🔴 eLogist пройшов би за правилом Сергія");
  const cte = m.adsAcceptedCte("$7");
  assert.match(cte, /funnel_stage = 'paid'/, "🔴 «клієнт з реклами» без оплати — правило Сергія вимагає «і оплатив»");
  assert.match(cte, /GENERIC_CLIENT_KEYS_SQL|названиенеуказано/, "🔴 заглушки «Название не указано» склеїли б чужих клієнтів");
  // Гроші — лише core/money.ts, і правило їх не стосується (план, розділ «що НЕ робимо»).
  for (const f of ["core/money.ts", "core/adClients.ts"]) {
    assert.doesNotMatch(SRC(f), /\badsAccepted(Sql|Cte)\b|\bAD_ORIGIN_SQL\b|\bADS_ACCEPTED_JOINS\b/,
      `🔴 ${f} бере правило Сергія — рекламні гроші / екран «Реклама» зрушать`);
  }
});

/**
 * #9932b — ФІКСТУРА ПО ОБИДВА БОКИ (scratch-БД). Кожна угода — свій менеджер (`manager_id = MGR + kommo_id`), тож
 * `adsAcceptedByMgr` віддає МНОЖИНУ угод, а не число: збіг числа при різному складі тут неможливий.
 *   A прийшов з реклами (1, оплачено) → 2 і 7 — реклама; 4 лідоген, 5 реактивація, 6 eLogist — ні.
 *   B: реклама 10 (не оплачено) → 11 ДО оплати — ні; 12 сама оплата (та сама мить) — ні; 13 після оплати — так.
 *   C: реклама 20, оплати немає → 21 — ні.   D: постійний не з реклами → 31 — ні.
 *   G: заглушка «Название не указано» → 41 — ні (чужі клієнти не склеюються).
 * 🧨 Прибрати «оплатив» → 21 стане рекламою; `<` → `<=` → 12; без дати → 11; без лідогену → 4.
 */
test("#9932b ФІКСТУРА: клієнт з реклами оплатив → далі реклама; без оплати, до оплати, лідоген, реактивація, eLogist, заглушка — ні", async (t) => {
  const db = await scratchDb();
  if ("skip" in db) { t.skip(db.skip); return; }
  const { c } = db;
  const FC = 8921932, PAID = 142, OPEN = 69693700;
  await c.query(`INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES ($1, $2, 'paid'), ($1, $3, 'lead_taken')
                 ON CONFLICT DO NOTHING`, [FC, PAID, OPEN]);
  type D = { id: number; key: string; at: string; paid?: boolean; src?: string; ch?: string; name?: string };
  const deals: D[] = [
    { id: 1, key: "a", at: "2026-10-01", paid: true, src: "uts.ua", ch: "ad" },
    { id: 2, key: "a", at: "2026-10-10", src: "Постоянный клиент", ch: "other" },
    { id: 4, key: "a", at: "2026-10-12", ch: "leadgen" },
    { id: 5, key: "a", at: "2026-10-13", src: "Реактивация звонком", ch: "other" },
    { id: 6, key: "a", at: "2026-10-14", name: "eLogist заявка", ch: "other" },
    { id: 7, key: "a", at: "2026-10-15", src: "uts.ua", ch: "other" },
    { id: 10, key: "b", at: "2026-10-01", src: "uts.ua", ch: "ad" },
    { id: 11, key: "b", at: "2026-10-03", ch: "other" },
    { id: 12, key: "b", at: "2026-10-05", paid: true, ch: "other" },
    { id: 13, key: "b", at: "2026-10-08", ch: "other" },
    { id: 20, key: "c", at: "2026-10-01", src: "uts.ua", ch: "ad" },
    { id: 21, key: "c", at: "2026-10-10", ch: "other" },
    { id: 30, key: "d", at: "2026-09-01", paid: true, ch: "other" },
    { id: 31, key: "d", at: "2026-10-10", ch: "other" },
    { id: 40, key: "названиенеуказано", at: "2026-10-01", paid: true, src: "uts.ua", ch: "ad" },
    { id: 41, key: "названиенеуказано", at: "2026-10-10", ch: "other" },
  ];
  // Менеджери — з власними id (зсув MGR), без TRUNCATE managers: на ній висять тригери інших таблиць схеми.
  const MGR = 993200;
  await c.query("TRUNCATE deals CASCADE");
  for (const d of deals) {
    await c.query("INSERT INTO managers (id, name, is_active) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING", [MGR + d.id, `m${d.id}`]);
    await c.query(`INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, created_at_kommo, client_key, client_source, lead_channel)
                   VALUES ($1, $2, $9, $3, $4, ($5 || ' 12:00+03')::timestamptz, $6, $7, $8)`,
      [d.id, d.name ?? `угода ${d.id}`, FC, d.paid ? PAID : OPEN, d.at, d.key, d.src ?? null, d.ch ?? null, MGR + d.id]);
  }
  const m = await import("./metrics.js");
  const got = (await m.adsAcceptedByMgr({ from: "2026-10-01", to: "2026-10-31" }, ["uts.ua"]))
    
    .map((r) => r.managerId - MGR).filter((id) => id > 0 && id < 1000).sort((x, y) => x - y);
  // Рекламні вже зараз (adDealSql): 1, 10, 20, 40. За правилом Сергія: 2, 7, 13.
  assert.deepEqual(got, [1, 2, 7, 10, 13, 20, 40],
    "🔴 «Прийнято реклами» на фікстурі розійшлось із правилом Сергія (очікування — у доккоментарі гейта)");
  // Дзеркало: та сама множина через `adsAccepted` (плитка) — одне правило, не два.
  assert.equal(await m.adsAccepted({ from: "2026-10-01", to: "2026-10-31", activeOnly: true }, ["uts.ua"]), got.length,
    "🔴 adsAccepted і adsAcceptedByMgr рахують різне");
});

/**
 * #9932c — РОУТ `/report` (actByMgr: плитка «Прийнято реклами» і ad_leads менеджера) КЛИЧЕ ПРАВИЛО 9932.
 * Заміна `#24q`: той вимагав `adDealSqlMode(…"joined")` + `FIRST_PAID_*`, а тепер правильний вираз — новий.
 * Межа зрізу змістова (параметри actByMgr → його GROUP BY), як у `#24q`.
 * 🧨 Повернути `adDealSqlMode(…)` у FILTER → червоніє: плитка розійшлась би з колонкою Звіту.
 */
test("#9932c /report actByMgr рахує «Прийнято реклами» тим самим правилом 9932, у join-формі", () => {
  const src = SRC("routes/dashboard.ts");
  const from = src.indexOf("const actP: unknown[]");
  assert.ok(from > 0, "🔴 не знайдено початок запиту actByMgr — гейт втратив предмет");
  const to = src.indexOf("GROUP BY m.id, m.name`, actP);", from);
  assert.ok(to > from, "🔴 не знайдено кінець запиту actByMgr — зріз розповзся");
  const block = src.slice(from, to);
  assert.match(block, /FILTER \(WHERE \$\{metrics\.adsAcceptedSql\(/, "🔴 ad_leads у /report рахується не правилом 9932");
  assert.match(block, /WITH \$\{metrics\.adsAcceptedCte\(/, "🔴 у запиті немає CTE правила (first_paid + ad_origin)");
  assert.match(block, /\$\{metrics\.ADS_ACCEPTED_JOINS\}/, "🔴 у запиті немає join-ів first_paid / ad_origin");
  assert.doesNotMatch(block, /metrics\.adDealSql(Mode)?\(/, "🔴 у actByMgr лишився старий рекламний предикат — дві метрики в одному запиті");
});
