import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #66/#67 — НОВИЗНА КЛІЄНТА Й ДЖЕРЕЛО УГОДИ: ОДНЕ ПРАВИЛО, ТРИ ФОРМИ, ДВА ВИМІРИ.
 *
 * 🔴 ПРИВІД №1 — СКРІНШОТ ВЛАСНИКА (07.08.2026): рядок дня казав «створено 3 · 3н · 0п»,
 * а розкриття ТОГО САМОГО числа показувало 1 нового і 2 постійних, бо правило було
 * переписане скорочено у двох місцях. Звідси вимога: форми звіряються ПОРЯДКОВО.
 *
 * 🔴 ПРИВІД №2 — ЗАМІР 18.08.2026, і він більший за перший. Сигнал історії шукав
 * `status_id=142` У БУДЬ-ЯКІЙ воронці, тож «постійним» робив донор із Продзвону
 * (там 142 = «заявку на прорахунок отримано») і з Автосделки (оплата ПЕРЕВІЗНИКА):
 * хибний сигнал у 4 612 угод із 28 403 за 12 міс, перевернута мітка — 2 505.
 * А перша гілка класифікатора форсувала `ad|leadgen → new`, тобто ЗВІДКИ прийшла
 * угода відповідало на питання, ЧИ ВПЕРШЕ в нас клієнт: ще 296 угод постійних
 * клієнтів читались як нові.
 *
 * 🔴 ГЕЙТ НА ПРАВИЛІ, А НЕ НА ЖИВІЙ ВИБІРЦІ (вимога власника): фікстура накриває
 * КОЖНУ гілку канону й кожен клас, включно з донорами поза FC — тими самими, що
 * дали 4 612 хибних сигналів на проді.
 *
 * 🪞 ДЗЕРКАЛА ОБОВʼЯЗКОВІ: «постійних не побільшало» зеленіло б і тоді, якби ми
 * зробили новими ГЕТЬ УСІХ. Тому поруч — вимоги, що постійний лишається постійним,
 * що зона тримає, і що won-гілка канону жива навіть із порожньою зоною.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
/**
 * ⚠️ Тест біжить із `dist`, а звіряти треба ДЖЕРЕЛО — тому шлях будується від
 * `dist/core` у `src/core` (той самий прийом, що в `#41`: `import.meta.dirname +
 * "metrics.ts"` дав би ENOENT, бо в `dist` лежить `.js`).
 */
const METRICS_SRC = path.join(import.meta.dirname, "..", "..", "src", "core", "metrics.ts");
const KVP_SECTION = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src",
  "pages", "dashboard", "sections", "KvpReportSection.tsx");
const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const FC = 8921932;          // Перевозки повний цикл (New)
const PRODZVIN = 8921936;    // Продзвін — 142 тут означає «заявку на прорахунок отримано»
const AUTODEAL = 7341740;    // Автосделка — запит на оплату ПЕРЕВІЗНИКА
const INVOICE = 100274340;   // «Виставлення рахунку» — зона визнання, ще НЕ виграно
const AWAITING = 69716312;   // «Очікуємо оплату» — зона визнання
const WORKING = 69693668;    // робочий статус цільових угод фікстури

/** Донори — «історія клієнта», яку читає канон. Кожен названий тим, що доводить. */
const DONORS: { id: number; key: string; pipeline: number; status: number; closedDaysAgo: number | null; why: string }[] = [
  { id: 1, key: "постійнийfc", pipeline: FC, status: 142, closedDaysAgo: 400,
    why: "виграна угода повного циклу — канонічний постійний" },
  { id: 2, key: "названиенеуказано", pipeline: FC, status: 142, closedDaysAgo: 400,
    why: "виграна на ДЖЕНЕРИК-ключі — навантажує глушник, інакше чужа історія успадкується" },
  { id: 3, key: "продзвінлише", pipeline: PRODZVIN, status: 142, closedDaysAgo: 300,
    why: "142 у ПРОДЗВОНІ — маркер передачі, а не перевезення (4 480 угод хибного сигналу на проді)" },
  { id: 4, key: "автосделкалише", pipeline: AUTODEAL, status: 142, closedDaysAgo: 300,
    why: "142 в АВТОСДЕЛЦІ — оплата перевізника, до клієнта стосунку не має" },
  { id: 5, key: "зонабезвиграшу", pipeline: FC, status: INVOICE, closedDaysAgo: null,
    why: "стоїть у зоні визнання ЗАРАЗ, не вигравав — постійний за станом" },
  { id: 6, key: "зоналишеподія", pipeline: FC, status: 143, closedDaysAgo: 10,
    why: "зараз закрита-нереалізована, але ПОДІЯ входу в зону була — постійний за подією" },
];

/** Цільові угоди = гілки правила × виміри. Кожна названа тим, що саме доводить. */
const CASES: { id: number; why: string; key: string | null; channel: string | null; sales?: string | null;
  klass: "new" | "repeat" | "undef"; source: "ad" | "leadgen" | "other" | "undef" }[] = [
  { id: 201, why: "ключ + виграна у FC → постійний", key: "постійнийfc", channel: "other",
    klass: "repeat", source: "other" },
  { id: 202, why: "РЕКЛАМА від клієнта з історією → постійний (джерело не вирішує новизну)",
    key: "постійнийfc", channel: "ad", klass: "repeat", source: "ad" },
  { id: 203, why: "ЛІДОГЕН від клієнта з історією → постійний (лідоген — вимір джерела)",
    key: "постійнийfc", channel: "leadgen", klass: "repeat", source: "leadgen" },
  { id: 204, why: "ключ є, історії немає → новий", key: "свіжий", channel: "other",
    sales: "Нові клієнти", klass: "new", source: "other" },
  { id: 205, why: "донор лише в ПРОДЗВОНІ → НОВИЙ (фільтр воронки — частина правила)",
    key: "продзвінлише", channel: "other", klass: "new", source: "other" },
  { id: 206, why: "донор лише в АВТОСДЕЛЦІ → новий", key: "автосделкалише", channel: "other",
    klass: "new", source: "other" },
  { id: 207, why: "донор у зоні визнання ЗА СТАНОМ → постійний без виграшу",
    key: "зонабезвиграшу", channel: "other", klass: "repeat", source: "other" },
  { id: 208, why: "донор у зоні визнання ЗА ПОДІЄЮ → постійний, хоч зараз угода закрита",
    key: "зоналишеподія", channel: "other", klass: "repeat", source: "other" },
  { id: 209, why: "ключа немає → вирішує декларація CRM «Постійні клієнти»", key: null,
    channel: "other", sales: "Постійні клієнти", klass: "repeat", source: "other" },
  { id: 210, why: "ключа немає → декларація «Нові клієнти»", key: null, channel: "other",
    sales: "Нові клієнти", klass: "new", source: "other" },
  { id: 211, why: "ні ключа, ні декларації → 'undef', а не мовчазний постійний", key: null,
    channel: "other", sales: null, klass: "undef", source: "other" },
  { id: 212, why: "дженерик-ключ глушиться → ЧУЖА історія не читається", key: "названиенеуказано",
    channel: "other", sales: "Нові клієнти", klass: "new", source: "other" },
  // 🎯 САМЕ ЦЕЙ РЯДОК ловить стару першу гілку: раніше канал робив його 'new'.
  { id: 213, why: "РЕКЛАМА без ключа й без декларації → 'undef' (раніше канал давав 'new')",
    key: null, channel: "ad", sales: null, klass: "undef", source: "ad" },
  // 🔴 АНОМАЛІЯ «ЗАКРИТО РАНІШЕ ЗА СТВОРЕННЯ» — саме тут і працює самовиключення.
  // Перша редакція фікстури ставила угоду просто в зону, і гейт НЕ ЧЕРВОНІВ на
  // саботажі: її тримала строга нерівність дат (`created_at < created_at` хибне),
  // а не умова `kommo_id <>`. Тобто гейт доводив не те, що на ньому написано.
  // На проді така аномалія існує (замір 18.08.2026: 1 угода зі 149 982).
  { id: 214, why: "угода закрита РАНІШЕ за власне створення → не робить себе постійною",
    key: "самотній", channel: "other", sales: "Нові клієнти", klass: "new", source: "other" },
  { id: 215, why: "канал не заповнено → джерело 'undef', а новизна рахується як усім",
    key: "постійнийfc", channel: null, klass: "repeat", source: "undef" },
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
                   VALUES (${FC},142,'paid') ON CONFLICT DO NOTHING`);
    for (const d of DONORS)
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,
                            lead_channel,sales_channel,created_at_kommo,closed_at_kommo)
         VALUES ($1,$2,10,$3,$4,1000,$5,$5,'other',NULL,$6,$7)`,
        [d.id, d.why, d.pipeline, d.status, d.key, daysAgo(500),
         d.closedDaysAgo == null ? null : daysAgo(d.closedDaysAgo)]);
    // Донор №6: сама угода зараз 143, але подія входу в зону визнання БУЛА.
    await c.query(
      `INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at)
       VALUES (6,$1,$2,$3)`, [AWAITING, FC, daysAgo(250)]);
    // Цільова 214 — ЄДИНА угода свого ключа, ВИГРАНА і з `closed_at` РАНІШЕ за власне
    // `created_at` (аномалія з прода). Без самовиключення канон побачив би її саму як
    // «попередню виграну» й зробив клієнта постійним на порожньому місці.
    for (const cs of CASES)
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,
                            lead_channel,sales_channel,created_at_kommo,closed_at_kommo)
         VALUES ($1,$2,10,${FC},$3,500,$4,$4,$5,$6,$7,$8)`,
        [cs.id, cs.why, cs.id === 214 ? 142 : WORKING, cs.key, cs.channel, cs.sales ?? null,
         daysAgo(5), cs.id === 214 ? daysAgo(6) : null]);
    await fn(c);
  } finally { await c.end(); }
}

/** CTE-форма правила — дослівно те, що будують `classifyCte` і `wonSplitCte`. */
async function cteKlass(c: import("pg").Client, m: typeof import("./metrics.js")): Promise<Map<number, string>> {
  const r = await c.query<{ kommo_id: string; klass: string }>(
    `WITH base AS (
       SELECT d.kommo_id, d.created_at_kommo, d.sales_channel, d.lead_channel,
              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($1)
                   THEN NULL ELSE d.client_key END AS vkey
         FROM deals d WHERE d.kommo_id >= 200),
     classed AS (
       SELECT b.*, ${m.priorClientSql({ vkey: "b.vkey", createdAt: "b.created_at_kommo", selfId: "b.kommo_id" })} AS has_prior
         FROM base b)
     SELECT kommo_id, (${m.createdKlassCase({
       vkey: "vkey", hasPrior: "has_prior", salesChannel: "sales_channel",
     })}) AS klass FROM classed ORDER BY kommo_id`, [m.GENERIC_CLIENT_KEYS]);
  return new Map(r.rows.map((x) => [Number(x.kommo_id), x.klass]));
}

test("#66 НОВИЗНА дає очікуваний клас на ВСІХ гілках канону", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ kommo_id: string; klass: string; source: string }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass, (${m.dealSourceSql("d")}) AS source
         FROM deals d WHERE d.kommo_id >= 200 ORDER BY d.kommo_id`);
    assert.equal(r.rows.length, CASES.length,
      `🔴 у вибірці ${r.rows.length} угод замість ${CASES.length} — фікстура не засіялась, `
      + "а порожній результат це ПРОВАЛ, не успіх");
    const got = new Map(r.rows.map((x) => [Number(x.kommo_id), x]));
    for (const cs of CASES)
      assert.equal(got.get(cs.id)?.klass, cs.klass,
        `🔴 ${cs.why}: очікували '${cs.klass}', отримали '${got.get(cs.id)?.klass}'`);
    assert.equal(new Set(r.rows.map((x) => x.klass)).size, 3,
      "🔴 правило видало не всі три класи — воно вироджене, і гейт порожній");
  });
});

test("#66b ТРИ ФОРМИ ПРАВИЛА (інлайн, CTE, «Плани») збігаються порядково", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const inline = await c.query<{ kommo_id: string; klass: string }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass
         FROM deals d WHERE d.kommo_id >= 200 ORDER BY d.kommo_id`);
    const cte = await cteKlass(c, m);
    assert.ok(inline.rows.length > 0, "🔴 форми повернули порожньо — порівнювати нічого");
    for (const row of inline.rows)
      assert.equal(cte.get(Number(row.kommo_id)), row.klass,
        `🔴 угода ${row.kommo_id}: CTE-форма '${cte.get(Number(row.kommo_id))}', інлайн '${row.klass}' `
        + "— рядок і його розкриття знову розійшлись");
    // 🔴 ТРЕТЯ ФОРМА — «Плани» (D). Її не можна звірити цим самим SELECT-ом (інша
    // когорта: лише виграні), тож звіряємо ДЖЕРЕЛО: обидві CTE-форми зобовʼязані
    // кликати ОДИН канон. Саме тут торік і розʼїхались копії — не в поведінці, а
    // в тому, що одну з них правили, а другу забули.
    const src = readFileSync(METRICS_SRC, "utf8");
    const calls = src.match(/priorClientSql\(\{ vkey: "b\.vkey"/g) ?? [];
    assert.equal(calls.length, 2,
      `🔴 канон у CTE-формах викликається ${calls.length} раз(и) замість 2 — одна з форм `
      + "(classifyCte / wonSplitCte) знову рахує історію сама");
    assert.equal(src.includes("PLAN_KLASS_CASE = CREATED_KLASS_CASE"), true,
      "🔴 «Плани» більше не беруть вираз новизни зі Звіту — тотожність Плани↔Звіт зламана");
    assert.equal(/p\.status_id = 142\s+AND p\.closed_at_kommo/.test(src), false,
      "🔴 у ядрі знову зʼявився рукописний сигнал «попередня 142» повз `priorClientSql`");
  });
});

test("#66c ПОСТІЙНИЙ ЛИШАЄТЬСЯ ПОСТІЙНИМ — поділ не зрізано в один бік", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM deals d
        WHERE d.kommo_id >= 200 AND (${m.dealKlassSql("d")}) = 'repeat'`);
    assert.equal(Number(r.rows[0].n), CASES.filter((x) => x.klass === "repeat").length,
      "🔴 постійних не стало — правило зрізали в один бік, і мітка більше нічого не розрізняє");
  });
});

/**
 * #67a — ФІЛЬТР ВОРОНКИ. Дзеркало ОБОВʼЯЗКОВЕ: без нього тест зеленів би й тоді,
 * коли донорів поза FC у фікстурі просто немає, — тобто перевіряв би порожнечу.
 */
test("#67a ДОНОР ПОЗА ПОВНИМ ЦИКЛОМ НЕ РОБИТЬ КЛІЄНТА ПОСТІЙНИМ", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ kommo_id: string; klass: string; naive: boolean }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass,
              EXISTS (SELECT 1 FROM deals p WHERE p.client_key = d.client_key
                        AND p.status_id = 142 AND p.kommo_id <> d.kommo_id
                        AND p.closed_at_kommo < d.created_at_kommo) AS naive
         FROM deals d WHERE d.kommo_id IN (205, 206) ORDER BY d.kommo_id`);
    assert.equal(r.rows.length, 2, "🔴 фікстура донорів поза FC не засіялась");
    for (const row of r.rows) {
      assert.equal(row.klass, "new",
        `🔴 угода ${row.kommo_id}: донор поза повним циклом знову зробив клієнта постійним`);
      assert.equal(row.naive, true,
        `🔴 дзеркало: угода ${row.kommo_id} НЕ має донора «142 будь-де» — фікстура порожня, `
        + "і гейт не може провалитись у принципі");
    }
  });
});

test("#67b ЗОНА ВИЗНАННЯ РОБИТЬ ПОСТІЙНИМ БЕЗ ВИГРАШУ — і саме вона", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const withZone = await c.query<{ kommo_id: string; klass: string }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass
         FROM deals d WHERE d.kommo_id IN (207, 208) ORDER BY d.kommo_id`);
    for (const row of withZone.rows)
      assert.equal(row.klass, "repeat",
        `🔴 угода ${row.kommo_id}: зона визнання перестала зараховуватись`);
    // 🪞 Дзеркало: з ПОРОЖНЬОЮ зоною ті самі угоди мусять стати новими — інакше їх
    // тримає щось інше, і гейт доводив би не те, що написано на ньому.
    const noZone = await c.query<{ kommo_id: string; prior: boolean }>(
      `SELECT d.kommo_id, ${m.priorClientSql(
        { vkey: m.vkeySql("d"), createdAt: "d.created_at_kommo", selfId: "d.kommo_id" }, [])} AS prior
         FROM deals d WHERE d.kommo_id IN (207, 208) ORDER BY d.kommo_id`);
    for (const row of noZone.rows)
      assert.equal(row.prior, false,
        `🔴 угода ${row.kommo_id} лишилась постійною з ПОРОЖНЬОЮ зоною — тримає не зона`);
  });
});

test("#67c ДОНОР ≠ САМА УГОДА — угода не робить постійним сама себе", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ klass: string; would_match_self: boolean }>(
      `SELECT (${m.dealKlassSql("d")}) AS klass,
              (d.status_id = 142 AND d.closed_at_kommo < d.created_at_kommo) AS would_match_self
         FROM deals d WHERE d.kommo_id = 214`);
    // 🪞 Дзеркало: без цієї перевірки гейт зеленів би через строгу нерівність дат, а
    // не через самовиключення — саме так перша редакція й не ловила саботаж.
    assert.equal(r.rows[0]?.would_match_self, true,
      "🔴 дзеркало: угода 214 більше не підходить під власний предикат — фікстура порожня, "
      + "і саботаж самовиключення пройшов би непоміченим");
    assert.equal(r.rows[0]?.klass, "new",
      "🔴 угода зарахувала САМУ СЕБЕ в історію клієнта — прибрано умову `kommo_id <>`");
  });
});

test("#67d ДЖЕРЕЛО НЕ ВИРІШУЄ НОВИЗНУ — обидва виміри віддаються окремо", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ kommo_id: string; klass: string; source: string }>(
      `SELECT d.kommo_id, (${m.dealKlassSql("d")}) AS klass, (${m.dealSourceSql("d")}) AS source
         FROM deals d WHERE d.kommo_id >= 200 ORDER BY d.kommo_id`);
    const got = new Map(r.rows.map((x) => [Number(x.kommo_id), x]));
    for (const cs of CASES)
      assert.equal(got.get(cs.id)?.source, cs.source,
        `🔴 ${cs.why}: джерело '${got.get(cs.id)?.source}' замість '${cs.source}'`);
    // Головне твердження: реклама й лідоген від клієнта з історією — ПОСТІЙНІ.
    for (const id of [202, 203])
      assert.equal(got.get(id)?.klass, "repeat",
        `🔴 угода ${id}: канал знову форсує «новий» — джерело й новизна злиплись назад`);
    assert.equal(got.get(213)?.klass, "undef",
      "🔴 реклама без ключа й декларації знову читається як «новий», а не «невизначено»");
  });
});

/**
 * #67e — ПІДПИС НА ЕКРАНІ ОПИСУЄ ЧИННЕ ПРАВИЛО. Той самий прийом, що `#56`: гейт
 * читає ДЖЕРЕЛО компонента. Правило без підпису — це екран, який упевнено пояснює
 * логіку, якої вже немає; таке ми вже ловили на «синхронізовано із Задачником».
 */
test("#67e ПІДПИС У КВП НЕ ОПИСУЄ СТАРЕ ПРАВИЛО", () => {
  const src = readFileSync(KVP_SECTION, "utf8");
  const tip = src.split("createdSplit:")[1]?.split("\n")[0] ?? "";
  assert.ok(tip.length > 0, "🔴 підказки `createdSplit` більше немає — перевіряти нічого");
  assert.equal(/B→C→A|реклама\/лідоген → новий/.test(tip), false,
    "🔴 на екрані знову стоїть опис СТАРОГО правила (канал вирішує новизну)");
  assert.ok(/ДЖЕРЕЛО|джерело/.test(tip) && /НОВИЗНА|новизна/.test(tip),
    "🔴 підпис не називає два виміри — читач не дізнається, що реклама більше не означає «новий»");
});

/**
 * #67f — ГІЛКА «ВИГРАВ У FC» ЖИВА. Сьогодні вона вкладена в гілку зони (142 входить
 * у `MONEY_ZONE`), тож виглядає як дубль і спокуса прибрати її велика. Гейт кличе
 * канон із ПОРОЖНЬОЮ зоною: там працює ЛИШЕ won-гілка, і без неї тест червоніє.
 */
test("#67f ГІЛКА «ВИГРАВ У ПОВНОМУ ЦИКЛІ» ПРАЦЮЄ НАВІТЬ ІЗ ПОРОЖНЬОЮ ЗОНОЮ", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ kommo_id: string; prior: boolean }>(
      `SELECT d.kommo_id, ${m.priorClientSql(
        { vkey: m.vkeySql("d"), createdAt: "d.created_at_kommo", selfId: "d.kommo_id" }, [])} AS prior
         FROM deals d WHERE d.kommo_id IN (201, 205) ORDER BY d.kommo_id`);
    const got = new Map(r.rows.map((x) => [Number(x.kommo_id), x.prior]));
    assert.equal(got.get(201), true,
      "🔴 виграна угода повного циклу перестала робити клієнта постійним — гілку won-FC прибрали "
      + "як «дубль зони», і разом із нею зникла страховка формулювання");
    assert.equal(got.get(205), false,
      "🔴 дзеркало: донор із Продзвону пройшов навіть повз won-гілку — фільтр воронки не діє");
  });
});

/**
 * #67g — ПАРТИЦІЯ Й НАКЛАДКА. `new+repeat+undef` мусить покривати ВСІ угоди, а
 * джерело — НЕ додаватись до них: саме на цьому побудовані «Плани» (там лідоген був
 * четвертим класом і ховав постійних) і рядок Звіту.
 */
test("#67g НОВИЗНА — ПАРТИЦІЯ, ДЖЕРЕЛО — НАКЛАДКА (у суму не додається)", async (t) => {
  await withScratch(t, async (c) => {
    const m = await import("./metrics.js");
    const r = await c.query<{ total: string; part: string; overlay: string; overlay_repeat: string }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE (${m.dealKlassSql("d")}) IN ('new','repeat','undef'))::int AS part,
              COUNT(*) FILTER (WHERE (${m.dealSourceSql("d")}) IN ('ad','leadgen'))::int AS overlay,
              COUNT(*) FILTER (WHERE (${m.dealSourceSql("d")}) IN ('ad','leadgen')
                                 AND (${m.dealKlassSql("d")}) = 'repeat')::int AS overlay_repeat
         FROM deals d WHERE d.kommo_id >= 200`);
    const row = r.rows[0];
    assert.equal(Number(row.part), Number(row.total),
      "🔴 партиція новизни не покриває всі угоди — зʼявився клас поза new/repeat/undef");
    assert.ok(Number(row.overlay) > 0,
      "🔴 у фікстурі немає жодної угоди з рекламою/лідогеном — накладку перевіряти нічим");
    assert.ok(Number(row.overlay_repeat) > 0,
      "🔴 жодна угода з реклами/лідогену не є постійною — фікстура не навантажує саме той "
      + "випадок, заради якого виміри й розділили");
  });
});
