import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { skipReason, type Scratch, type Unavailable } from "../db/scratchDb.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🔑 #373–#373b — КАМПАНІЯ В ДВОХ КАНАЛАХ НЕ ЗАТИРАЄ САМУ СЕБЕ.
 *
 * 🔴 БАГ, ЩО ЦЕ ПОРОДИВ (прод, 09.09.2026, гроші на екрані). GA4 віддає рядок на
 * (`date`, `sessionCampaignName`, `sessionDefaultChannelGroup`) — ТРИ виміри, — а
 * ключ таблиці був на ДВА: `PRIMARY KEY (day, campaign)`. Performance Max живе
 * одночасно в `Cross-network` і `Paid Search`, тож приходив двома рядками, і
 * `ON CONFLICT (day, campaign) DO UPDATE SET cost = EXCLUDED.cost` затирав перший
 * другим замість зберегти обидва.
 *
 * 📐 ЗАМІРЯНО НА БОЙОВИХ ДАНИХ, а не оцінено: бекфіл доповів **1 122** рядки,
 * у таблиці лишилось **969** — зникло 153 рядки з витратами. Гірше за саму втрату
 * те, що сума стала НЕДЕТЕРМІНОВАНОЮ: перемагає той рядок, який GA4 віддав
 * останнім, а порядок не гарантований. Той самий день між двома бекфілами:
 * 25.08 — 9 563 → 8 504, 01.09 — 8 369 → 6 985.
 *
 * ⚠️ ЧОМУ ГЕЙТ ХОДИТЬ У СПРАВЖНЮ БАЗУ, А НЕ ПЕРЕВІРЯЄ ТЕКСТ SQL. Затирання — це
 * властивість ПАРИ «ключ таблиці + `ON CONFLICT`», і жодна з половин поодинці про
 * неї не свідчить. Регулярка на `ON CONFLICT (day, campaign, channel_group)` була б
 * зеленою при ключі з двох колонок — тобто рівно в тому стані, який ми лікуємо.
 * Тому тест накочує `schema.sql` на одноразовий кластер і кличе ПРОДАКШН-функцію
 * `upsertGa4Rows`, а не свою копію запиту (урок `#214c`: ліворуч має стояти ядро).
 *
 * 🔴 ОДИН КЛАСТЕР І ОДИН ПУЛ НА ВЕСЬ ФАЙЛ — не стиль, а правило, куплене чужою
 * аварією. `db/pool.js` — модульний синглтон, тож `pool.end()` у першому тесті
 * закриває пул ДРУГОМУ. Перша редакція цього файла піднімала scratch у кожному
 * тесті окремо й падала з `Cannot use a pool after calling end on the pool` —
 * рівно той симптом, що колись поклав 13 чужих тестів.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/** Рядок GA4 у формі, яку віддає `parseGa4Report`. */
const row = (campaign: string, channelGroup: string, cost: number) => ({
  day: "2026-09-02", campaign, channelGroup,
  sessions: 10, conversions: 1, cost, clicks: 5,
});

let scratch: Scratch | Unavailable;
let client: { query: (q: string) => Promise<{ rows: Record<string, string>[] }>; end: () => Promise<void> } | null = null;
let closePool: (() => Promise<void>) | null = null;
let upsert: ((rows: unknown[]) => Promise<number>) | null = null;

before(async () => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  scratch = provisionScratch();
  if ("unavailable" in scratch) return;
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(SCHEMA, "utf8"));
  client = c as unknown as typeof client;
  const { pool } = await import("../db/pool.js");
  closePool = () => pool.end();
  ({ upsertGa4Rows: upsert } = await import("../jobs/syncGa4Ads.js") as never);
});

after(async () => {
  await client?.end().catch(() => {});
  await closePool?.().catch(() => {});
  if (scratch && !("unavailable" in scratch)) scratch.dispose();
});

test("#373 ОДНА КАМПАНІЯ, ДВА КАНАЛИ — обидва рядки живі, і сума не втрачає жодної гривні", async (t) => {
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  await client!.query(`DELETE FROM ad_ga4_daily`);

  // Рівно той випадок із прода: та сама кампанія того самого дня у двох каналах.
  await upsert!([
    row("PMax-Vidy.Transporta_TochkaB", "Cross-network", 247),
    row("PMax-Vidy.Transporta_TochkaB", "Paid Search", 1015),
  ]);

  const all = await client!.query(`SELECT count(*) AS n, sum(cost) AS total FROM ad_ga4_daily`);
  assert.equal(Number(all.rows[0].n), 2,
    "🔴 два канали однієї кампанії злились в один рядок — ключ знову на дві колонки, і витрати зникають");
  assert.equal(Number(all.rows[0].total), 1262,
    "🔴 сума витрат не дорівнює 247+1015 — рядок затерто, і на екрані буде занижене число");

  // 🪞 ДЗЕРКАЛО ІДЕМПОТЕНТНОСТІ: повтор ТОГО САМОГО ключа мусить ОНОВИТИ, а не
  // додати. Без цієї половини гейт зеленів би й на ключі, який не ловить конфлікт
  // узагалі — тоді щоденний синк плодив би дублікати й роздував витрати.
  await upsert!([row("PMax-Vidy.Transporta_TochkaB", "Paid Search", 1500)]);
  const again = await client!.query(`SELECT count(*) AS n, sum(cost) AS total FROM ad_ga4_daily`);
  assert.equal(Number(again.rows[0].n), 2,
    "🔴 повторний синк створив ДУБЛІКАТ замість оновити — витрати подвоюються з кожним прогоном");
  assert.equal(Number(again.rows[0].total), 1747,
    "🔴 оновлення не замінило вартість того самого ключа (247 + 1500)");
});

test("#373b 🪞 КАНАЛ БЕЗ ІМЕНІ теж має ключ — інакше рядки без каналу плодяться безмежно", async (t) => {
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  await client!.query(`DELETE FROM ad_ga4_daily`);

  // GA4 може віддати рядок без назви каналу. У складеному ключі NULL ніколи не
  // дорівнює NULL, тож без нормалізації до "" цей рядок не ловився б `ON CONFLICT`
  // і додавався б заново на КОЖНОМУ прогоні синку.
  const noChannel = { ...row("(not set)", "", 0), channelGroup: null };
  await upsert!([noChannel]);
  await upsert!([noChannel]);

  const r = await client!.query(`SELECT count(*) AS n FROM ad_ga4_daily WHERE campaign = '(not set)'`);
  assert.equal(Number(r.rows[0].n), 1,
    "🔴 рядок без каналу продублювався — NULL у складеному ключі не дорівнює сам собі, "
    + "тож кожен синк додавав би ще одну копію");
});
