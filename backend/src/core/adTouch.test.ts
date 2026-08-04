import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #33 — ГЕЙТ РЕКЛАМНОГО ДОТИКУ ПРАЦЮЄ НА ОБИДВА ШЛЯХИ.
 *
 * 🔴 ПИТАННЯ, НА ЯКЕ ВІДПОВІДАЄ ТЕСТ. У «рекламу» ведуть ДВА шляхи:
 * `lead_channel='ad'` (його ставить `reclassifyAdChannel`) і
 * `client_source ∈ adSources` (перевіряється прямо в `adDealSql`). Правило
 * власника від 04.08.2026 — «мітка АБО новий клієнт» — накрите лише на першому,
 * лишило б другий обхідним, і правило діяло б ЧЕРЕЗ РАЗ залежно від того, яким
 * шляхом угода зайшла. Саме тому перевіряються обидва, а не «один як зразок».
 *
 * 🔴 І ОБОВʼЯЗКОВЕ ДЗЕРКАЛО. Односторонній тест («постійний без мітки не
 * рахується») зеленів би й тоді, якби гейт різав ВСІХ підряд — тобто якби
 * реклама зникла з дашборду взагалі. Тому кожній забороні тут відповідає дозвіл.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const AD_SOURCES = ["uts.ua"];

test("#33 РЕКЛАМНИЙ ДОТИК: мітка АБО новий клієнт — на ОБОХ шляхах", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(scratch.unavailable);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  const { pool } = await import("../db/pool.js");
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'М',1,true) ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage)
                   VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);

    // ПОПЕРЕДНЯ оплата робить клієнта «постійним» для угод, створених ПІЗНІШЕ.
    const seedDeal = async (id: number, o: Record<string, unknown>) => {
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,
                            client_source,lead_channel,utm_source,traf_type,created_at_kommo,closed_at_kommo)
         VALUES ($1,'d',10,8921932,$2,1000,$3,$3,$4,$5,$6,$7,$8,$9)`,
        [id, o.status ?? 69693668, o.key, o.source ?? null, o.channel ?? null,
         o.utm ?? null, o.traf ?? null, o.created, o.closed ?? null]);
    };
    // Стара оплата двох клієнтів — вони стають «постійними».
    await seedDeal(1, { key: "постійнийА", status: 142, created: daysAgo(400), closed: daysAgo(400) });
    await seedDeal(2, { key: "постійнийБ", status: 142, created: daysAgo(400), closed: daysAgo(400) });

    // ШЛЯХ 1 — через lead_channel='ad'
    await seedDeal(11, { key: "постійнийА", channel: "ad", created: daysAgo(5) });               // ❌ постійний, без мітки
    await seedDeal(12, { key: "постійнийА", channel: "ad", utm: "google", created: daysAgo(5) }); // ✅ постійний, АЛЕ з міткою
    await seedDeal(13, { key: "новийА", channel: "ad", created: daysAgo(5) });                    // ✅ новий, без мітки
    // ШЛЯХ 2 — через client_source ∈ adSources (саме він раніше був обхідним)
    await seedDeal(21, { key: "постійнийБ", source: "uts.ua", created: daysAgo(5) });             // ❌ постійний, без мітки
    await seedDeal(22, { key: "постійнийБ", source: "uts.ua", traf: "cpc", created: daysAgo(5) }); // ✅ мітка traf_type
    await seedDeal(23, { key: "новийБ", source: "uts.ua", created: daysAgo(5) });                 // ✅ новий

    const { adDealSql } = await import("./metrics.js");
    const ids = async (): Promise<number[]> => (await pool.query<{ kommo_id: string }>(
      `SELECT d.kommo_id FROM deals d
        WHERE d.status_id <> 142 AND ${adDealSql("$1")} ORDER BY d.kommo_id`, [AD_SOURCES]
    )).rows.map((r) => Number(r.kommo_id));

    const got = await ids();
    assert.ok(got.length > 0,
      "🔴 порожньо — це ПРОВАЛ, а не «реклами немає»: рекламних угод засіяно шість");

    // ЗАБОРОНА — на ОБОХ шляхах.
    assert.ok(!got.includes(11),
      "🔴 ШЛЯХ lead_channel: постійний клієнт без мітки лишився рекламою");
    assert.ok(!got.includes(21),
      "🔴 ШЛЯХ client_source: постійний клієнт без мітки лишився рекламою — саме цей "
      + "шлях і був обхідним, поки гейт стояв лише в reclassifyAdChannel");

    // 🪞 ДЗЕРКАЛО — те, що МАЄ лишатись рекламою. Без цієї половини тест зеленів
    // би й тоді, якби гейт вирізав узагалі все.
    assert.deepEqual(got, [12, 13, 22, 23],
      `🔴 набір рекламних угод не той: ${got.join(",")} — очікували 12,13,22,23`);
  } finally {
    await pool.end().catch(() => {});
    await c.end();
    scratch.dispose();
  }
});
