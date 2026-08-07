import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #66 — РЯДОК І ЙОГО РОЗКРИТТЯ КЛАСИФІКУЮТЬ ОДНАКОВО.
 *
 * 🔴 ПРИВІД — СКРІНШОТ ВЛАСНИКА (07.08.2026). Рядок дня казав «створено 3 · 3н · 0п»,
 * а розкриття ТОГО САМОГО числа показувало 1 нового і 2 постійних. Причина не в
 * даних і не в анкері: `core/dayItems.ts` і `/report-plan/deals` писали правило
 * заново, СКОРОЧЕНО — «реклама/лідоген → новий, УСЕ ІНШЕ → постійний». Дві гілки
 * замість шести, історія клієнта не читалась зовсім. Тому угода `lead_channel='other'`
 * БЕЗ попередньої виграної ставала «постійною» в чипі й «новою» в лічильнику.
 * Заміряно на проді: розходились 12.6% угод серпня, 11.0% липня, 15.8% за 12 міс.
 *
 * 🔴 ГЕЙТ НА ПРАВИЛІ, А НЕ НА ЖИВІЙ ВИБІРЦІ (вимога власника). Живих порушниць було
 * дві; гейт на двох записах червонів би від чужої правки в CRM, а не від регресії.
 * Тому — фікстура, що накриває ВСІ ШІСТЬ гілок правила, і звірка двох його форм
 * порядково. Той самий прийом, що `#35` для `hasPriorPaidSql`.
 *
 * 🪞 ДЗЕРКАЛО ОБОВʼЯЗКОВЕ (`#66b`). «Чип не бреше про постійного» зеленіло б і тоді,
 * якби ми зробили НОВИМИ геть усіх — тобто зламали б поділ повністю. Тому поруч
 * стоїть вимога, щоб справжній постійний лишався постійним.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** Шість випадків = шість гілок правила. Кожен названий тим, що саме він доводить. */
const CASES: { id: number; why: string; o: Record<string, unknown>; want: "new" | "repeat" | "undef" }[] = [
  { id: 101, why: "реклама — новий незалежно від історії клієнта",
    o: { key: "постійний", channel: "ad", sales: "Постійні клієнти" }, want: "new" },
  { id: 102, why: "лідоген — новий незалежно від історії",
    o: { key: "постійний", channel: "leadgen", sales: "Постійні клієнти" }, want: "new" },
  { id: 103, why: "other + ключ + БУЛА виграна → постійний",
    o: { key: "постійний", channel: "other" }, want: "repeat" },
  // 🎯 САМЕ ЦЕЙ РЯДОК ЛОВИТЬ БАГ: скорочена форма робила його 'repeat'.
  { id: 104, why: "other + ключ + виграної НЕ було → НОВИЙ (тут і ламалось)",
    o: { key: "свіжий", channel: "other", sales: "Нові клієнти" }, want: "new" },
  { id: 105, why: "ключ порожній → вирішує декларація CRM «Постійні клієнти»",
    o: { key: null, channel: "other", sales: "Постійні клієнти" }, want: "repeat" },
  { id: 106, why: "ні каналу, ні ключа, ні декларації → 'undef', а не мовчазний постійний",
    o: { key: null, channel: "other", sales: null }, want: "undef" },
  /**
   * 🔴 ДЖЕНЕРИК-КЛЮЧ МУСИТЬ БУТИ НАВАНТАЖЕНИЙ, інакше рядок декоративний.
   * В історії нижче є ВИГРАНА угода з тим самим `названиенеуказано`. Приберуть
   * глушник `GENERIC_CLIENT_KEYS` — ця угода «успадкує» ЧУЖУ історію й стане
   * 'repeat'; саме так 1.3к угод різних клієнтів злиплися б в одного. З глушником
   * `vkey=NULL`, історія не читається, вирішує декларація CRM → 'new'.
   * Перша редакція фікстури цього не ловила: без історії на дженерик-ключі обидві
   * версії давали 'new' однаково — тобто саботаж операнда не червонів.
   */
  { id: 107, why: "дженерик-ключ глушиться (vkey=NULL) → ЧУЖА історія не читається",
    o: { key: "названиенеуказано", channel: "other", sales: "Нові клієнти" }, want: "new" },
];

async function withScratch(t: { skip: (m: string) => void },
  fn: (c: import("pg").Client) => Promise<void>): Promise<void> {
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
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК') ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'М',1,true) ON CONFLICT DO NOTHING`);
    await c.query(`INSERT INTO pipeline_stage_map (pipeline_id,status_id,funnel_stage)
                   VALUES (8921932,142,'paid') ON CONFLICT DO NOTHING`);
    // Історія: клієнт «постійний» має ВИГРАНУ угоду, закриту рік тому.
    await c.query(
      `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,
                          lead_channel,sales_channel,created_at_kommo,closed_at_kommo)
       VALUES (1,'стара',10,8921932,142,1000,'постійний','постійний','other',NULL,$1,$1)`,
      [daysAgo(400)]);
    // ⚠️ ВИГРАНА угода на ДЖЕНЕРИК-ключі — навантажує глушник (див. коментар до #107).
    await c.query(
      `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,
                          lead_channel,sales_channel,created_at_kommo,closed_at_kommo)
       VALUES (2,'чужа',10,8921932,142,1000,'названиенеуказано','названиенеуказано','other',NULL,$1,$1)`,
      [daysAgo(400)]);
    for (const cs of CASES)
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,
                            lead_channel,sales_channel,created_at_kommo,closed_at_kommo)
         VALUES ($1,$2,10,8921932,69693668,500,$3,$3,$4,$5,$6,NULL)`,
        [cs.id, cs.why, cs.o.key, cs.o.channel, cs.o.sales ?? null, daysAgo(5)]);
    await fn(c);
  } finally { await c.end(); }
}

/** Інлайн-форма (та, якою тепер живиться розкриття) на кожній із шести гілок. */
test("#66 ПРАВИЛО «новий/постійний» дає очікуваний клас на ВСІХ шести гілках", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ kommo_id: string; klass: string }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass
         FROM deals d WHERE d.kommo_id >= 100 ORDER BY d.kommo_id`);
    assert.equal(r.rows.length, CASES.length,
      `🔴 у вибірці ${r.rows.length} угод замість ${CASES.length} — фікстура не засіялась, `
      + "а порожній результат це ПРОВАЛ, не успіх");
    const got = new Map(r.rows.map((x) => [Number(x.kommo_id), x.klass]));
    for (const cs of CASES)
      assert.equal(got.get(cs.id), cs.want,
        `🔴 ${cs.why}: очікували '${cs.want}', отримали '${got.get(cs.id)}'`);
    // Правило не вироджене: якби всі гілки давали одне й те саме, збіг форм нижче
    // нічого б не доводив.
    assert.equal(new Set(r.rows.map((x) => x.klass)).size, 3,
      "🔴 правило видало не всі три класи — воно вироджене, і гейт порожній");
  });
});

/** 🪞 Дзеркало: обидві форми правила — CTE й інлайн — мусять збігтись ПОРЯДКОВО. */
test("#66b ДВІ ФОРМИ ПРАВИЛА (CTE і інлайн) збігаються порядково", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const inline = await c.query<{ kommo_id: string; klass: string }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass
         FROM deals d WHERE d.kommo_id >= 100 ORDER BY d.kommo_id`);
    // CTE-форма — дослівно те, що будує `classifyCte` для лічильника рядка.
    const cte = await c.query<{ kommo_id: string; klass: string }>(
      `WITH base AS (
         SELECT d.kommo_id, d.created_at_kommo, d.sales_channel, d.lead_channel,
                CASE WHEN d.client_key IS NULL OR d.client_key = ANY($1)
                     THEN NULL ELSE d.client_key END AS vkey
           FROM deals d WHERE d.kommo_id >= 100),
       classed AS (
         SELECT b.*, (b.vkey IS NOT NULL AND EXISTS (
                  SELECT 1 FROM deals p
                   WHERE p.client_key = b.vkey AND p.status_id = 142
                     AND p.closed_at_kommo < b.created_at_kommo AND p.kommo_id <> b.kommo_id
                )) AS has_prior FROM base b)
       SELECT kommo_id, (${m.createdKlassCase({
         channel: "lead_channel", vkey: "vkey", hasPrior: "has_prior", salesChannel: "sales_channel",
       })}) AS klass FROM classed ORDER BY kommo_id`, [m.GENERIC_CLIENT_KEYS]);
    assert.ok(inline.rows.length > 0 && cte.rows.length === inline.rows.length,
      "🔴 форми повернули різну кількість рядків — порівнювати нічого");
    for (let i = 0; i < inline.rows.length; i++)
      assert.equal(cte.rows[i].klass, inline.rows[i].klass,
        `🔴 угода ${inline.rows[i].kommo_id}: CTE-форма '${cte.rows[i].klass}', `
        + `інлайн '${inline.rows[i].klass}' — рядок і його розкриття знову розійшлись`);
  });
});

/**
 * 🪞 Дзеркало до #66: перевіряємо, що фікс НЕ зробив усіх новими. Якби `dealKlassSql`
 * почав повертати 'new' завжди, #66 упав би — але лише на одному рядку, і спокуса
 * «підправити очікування» була б велика. Тут вимога сформульована окремо й прямо.
 */
test("#66c ПОСТІЙНИЙ ЛИШАЄТЬСЯ ПОСТІЙНИМ — поділ не зрізано в один бік", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM deals d
        WHERE d.kommo_id >= 100 AND (${m.dealKlassSql("d")}) = 'repeat'`);
    assert.equal(Number(r.rows[0].n), CASES.filter((x) => x.want === "repeat").length,
      "🔴 постійних не стало — правило зрізали в один бік, і чип більше нічого не розрізняє");
  });
});
