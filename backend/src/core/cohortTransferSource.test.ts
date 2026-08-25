import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsDb } from "../testMode.js";

/**
 * 🔀 #214c–#214e — Е6: ПʼЯТИЙ ЧИТАЧ РЕЄСТРУ ПЕРЕВЕДЕНО НА ПЕРСИСТЕНТНИЙ СЛІД.
 *
 * Предмет: гілка `client/transferred` у `core/metrics.conversionByCohort` —
 * знаменник «Конверсії лідогену» в `/overview` (`leadgenConversion`, `monthlyHistory`)
 * і `transferred` у `/kvp-report`. Вона одна лишалась на `leadgen_registry`, який
 * `syncLeadgenRegistry` `TRUNCATE`-ить щосинку, тимчасом як графік малює 12 місяців.
 *
 * 🔴 ЧОМУ ТУТ ТРИ ГЕЙТИ, А НЕ ОДИН — І ЧОМУ САМЕ ТАКИЙ ПОДІЛ. Заміряно 25.08.2026:
 * перехід НЕ РУХАЄ ЖОДНОГО ЧИСЛА (Δ0 у 36 із 36), і НАЇВНА редакція без каста дає
 * ті самі 36 чисел. Тобто гейт на рівність чисел стереже перехід, але пастку `DATE`
 * не ловить ЗА ПОБУДОВОЮ — на наявних даних вона коштує 0 рядків. Один гейт тут
 * створив би саме те, від чого нас береже правило «перевірка, яка не може
 * провалитись, у прийманні не рахується»: зелений колір без предмета.
 *   • `#214c` — числа не зрушили (жива БД, порядково, з контролем непорожності);
 *   • `#214d` — каст стоїть у виразі, І дві редакції справді РІЗНІ (чиста проба);
 *   • `#214e` — слід не вужчий за реєстр (будильник на випадок, коли писар відстане).
 */

const src = (rel: string): string => {
  for (const p of [
    fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)),
    fileURLToPath(new URL(`../../../backend/src/${rel}`, import.meta.url)),
  ]) { try { return readFileSync(p, "utf8"); } catch { /* далі */ } }
  assert.fail(`не знайдено джерело ${rel} — гейт не має права мовчки пропускатись`);
};

const KY = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * 🔴 `MONEY_ZONE`/`FC_PIPELINES` БЕРУТЬСЯ З ЯДРА, А НЕ ПЕРЕПИСУЮТЬСЯ СЮДИ.
 *
 * Перша редакція зашила `[69716460, 60412544, 142]` — і гейт червонів на ЧИСТОМУ
 * коді, бо справжня `MONEY_ZONE` = `[...EXPECT_ZONE, 69716460, 60412544, 142]`,
 * тобто ширша. Це те саме «друге означення», через яке гейт і переписувався на
 * виклик ядра: я прибрав копію SQL і тут-таки завів копію КОНСТАНТИ. Імпорт
 * лінивий (усередині тесту) — `metrics.js` тягне `config.js`, який без
 * `DATABASE_URL` кидає ще НА ІМПОРТІ, тобто раніше, ніж спрацює `skip`.
 */

/** Хвіст когортного запиту — БАЙТ-У-БАЙТ той самий для обох джерел, різниться лише `entered`. */
const TAIL = `,
 won AS (
   SELECT en.client_key, MIN(e.changed_at) AS won_at
     FROM entered en
     JOIN deals d ON d.client_key = en.client_key
     JOIN deal_stage_events e ON e.kommo_id = d.kommo_id
    WHERE e.status_id = ANY($1) AND e.pipeline_id = ANY($2) AND e.changed_at >= en.entered_at
    GROUP BY en.client_key),
 pop AS (SELECT en.entered_at, w.won_at FROM entered en LEFT JOIN won w ON w.client_key = en.client_key),
 months AS (SELECT generate_series(date_trunc('month', (now() ${KY})) - INTERVAL '11 months',
                                   date_trunc('month', (now() ${KY})), INTERVAL '1 month') AS m)
 SELECT to_char(mo.m, 'YYYY-MM') AS ym,
   COUNT(*) FILTER (WHERE p.entered_at IS NOT NULL AND date_trunc('month', (p.entered_at ${KY})) = mo.m)::int AS entered,
   COUNT(*) FILTER (WHERE p.entered_at IS NOT NULL AND p.won_at IS NOT NULL
                      AND date_trunc('month', (p.entered_at ${KY})) = mo.m)::int AS won_ev,
   COUNT(*) FILTER (WHERE p.won_at IS NOT NULL AND date_trunc('month', (p.won_at ${KY})) = mo.m)::int AS won_in
 FROM months mo LEFT JOIN pop p ON TRUE GROUP BY mo.m ORDER BY mo.m`;

/** ЕТАЛОН — стара, реєстрова редакція. Живе ЛИШЕ тут: у проді її більше немає. */
const ENT_REGISTRY = `entered AS (
   SELECT d.client_key, MIN(lr.transferred_at) AS entered_at
     FROM leadgen_registry lr
     JOIN deals d ON d.kommo_id = lr.lead_id
     JOIN managers m ON m.id = d.manager_id
     JOIN teams t ON t.id = m.team_id
    WHERE t.name NOT ILIKE '%лідоген%' AND d.client_key IS NOT NULL
    GROUP BY d.client_key)`;

/**
 * #214c — ПЕРЕХІД НЕ ЗРУШИВ ЖОДНОГО ЧИСЛА, І ЦЕ ДОВЕДЕНО ПОРЯДКОВО.
 *
 * 🔴 ПОРІВНЮЄТЬСЯ СПРАВЖНЯ `conversionTransferredByMonth`, А НЕ КОПІЯ ЇЇ SQL.
 * Перша редакція цього гейта тримала ОБИДВІ гілки всередині тесту — і була
 * непридатна: вона доводила рівність двох рядків, написаних поруч, а про те, що
 * саме виконує прод, не свідчила нічого. Рівно те «друге означення», яке ми
 * ловимо в чипах новизни й у зрізі Е3. Тепер ліворуч — виклик ядра, праворуч —
 * реєстровий еталон, і він живе тільки тут, бо в проді його вже немає.
 *
 * 🪞 КОНТРОЛЬ НЕПОРОЖНОСТІ ОБОВʼЯЗКОВИЙ: 12 місяців нулів дали б «Δ0» без жодної
 * перевіреної рівності. Вимагаємо Σ entered > 0 І Σ wonEv > 0 — заміряно 814 і 73.
 *
 * ⚠️ ЧОГО ЦЕЙ ГЕЙТ НЕ ДОВОДИТЬ, І ЦЕ НАЗВАНО ВГОЛОС: він НЕ ловить повернення
 * ядра на реєстр — числа сьогодні однакові, тож обидва джерела дали б зелене.
 * «Яка саме таблиця» стереже `#170c`, «яким саме виразом» — `#214d`. Троє разом
 * покривають перехід; поодинці кожен має дірку, і саме тому їх троє.
 *
 * 🧨 САБОТАЖ (виконано): дописати `+ INTERVAL '1 day'` до анкера в `metrics.ts` →
 * червоніє на 2026-06/07/08; прибрати `t.name NOT ILIKE '%лідоген%'` з гілки →
 * червоніє теж. Тобто гейт дивиться і на анкер, і на склад когорти — у ПРОДІ.
 */
test("#214c когортні передачі: слід дає ТІ САМІ числа, що реєстр (жива БД)", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const { conversionTransferredByMonth, MONEY_ZONE, FC_PIPELINES } = await import("./metrics.js");

  const live = await conversionTransferredByMonth({});
  const reg = (await pool.query<{ ym: string; entered: number; won_ev: number; won_in: number }>(
    `WITH ${ENT_REGISTRY}${TAIL}`, [MONEY_ZONE, FC_PIPELINES])).rows;

  assert.equal(live.length, reg.length,
    `🔴 ядро віддало ${live.length} місяців, еталон ${reg.length} — порівнюються різні горизонти`);

  const sumEnt = reg.reduce((s, x) => s + x.entered, 0);
  const sumWon = reg.reduce((s, x) => s + x.won_ev, 0);
  assert.ok(sumEnt > 0 && sumWon > 0,
    `🔴 когорта порожня (entered ${sumEnt}, wonEv ${sumWon}) — «Δ0» нічого не доводить`);

  for (let i = 0; i < reg.length; i++) {
    const a = reg[i], b = live[i];
    assert.deepEqual(
      { ym: b.ym, entered: b.entered, wonEv: b.wonEventually, wonIn: b.wonInMonth },
      { ym: a.ym, entered: a.entered, wonEv: a.won_ev, wonIn: a.won_in },
      `🔴 ${a.ym}: перехід реєстр→слід зрушив числа. Еталон (реєстр) ${a.entered}/${a.won_ev}/${a.won_in}, `
      + `ядро (слід) ${b.entered}/${b.wonEventually}/${b.wonInMonth}. Заміряно 25.08.2026: Δ0 у всіх 36`);
  }
});

/**
 * #214d — КАСТ ДО КИЇВСЬКОЇ ПІВНОЧІ СТОЇТЬ, І ВІН НЕ КОСМЕТИКА.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ ГЕЙТ, А НЕ ЧАСТИНА `#214c`. Ціна пастки на живих даних —
 * **0 рядків** (заміряно: передач у вікні 00:00-03:00 за Києвом — 0; виграшів між
 * північчю й моментом передачі — 0). Тобто наївна редакція `MIN(lt.transfer_date)`
 * дає ТІ САМІ 36 чисел, і `#214c` на ній зелений. Поведінкою це не спіймати доти,
 * доки бот не передасть заявку вночі, — а тоді ми дізнаємось про це з чужого
 * питання «чому конверсія просіла».
 *
 * 📐 І ПАСТКА ВУЖЧА, НІЖ БУЛО ЗАПИСАНО В `#170c` («зсув до доби»). Заміряно:
 *   • `TimeZone` сесії GMT, `pg_typeof(DATE … AT TIME ZONE …)` = `timestamp`, тож
 *     МІСЯЧНЕ групування наївна редакція НЕ зсуває (01.08 і 24.08 → `2026-08-01`);
 *   • зсув рівно один — у `changed_at >= entered_at`: голий `DATE` = опівночі GMT
 *     = 03:00 Києва. Три години, а не доба.
 * Друге твердження гейта прогонить саме цю пробу в БД: якщо редакції перестануть
 * різнитись (наприклад, `TimeZone` сесії поїде на Київ), гейт стереже вже косметику,
 * і про це треба дізнатись від нього, а не з чисел через півроку.
 *
 * 🧨 САБОТАЖ (виконано): прибрати `::timestamp` із виразу → червоніє перша половина;
 * замінити пробу на `DATE >= DATE` → червоніє друга.
 */
test("#214d анкер сліду зводиться до КИЇВСЬКОЇ ПІВНОЧІ, і це не косметика", needsDb(), async () => {
  const body = src("core/metrics.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  assert.match(body, /MIN\(lt\.transfer_date\)::timestamp \$\{KYIV\}/,
    "🔴 анкер когортних передач більше не зводиться до київської півночі. `transfer_date` — це "
    + "DATE, і голий він порівнюється з `changed_at` як опівніч GMT = 03:00 Києва: виграші "
    + "першої нічної тригодини дня передачі тихо випадуть із чисельника");
  assert.doesNotMatch(body, /MIN\(lt\.transfer_date\)\s*AS entered_at/,
    "🔴 у гілку повернулась наївна редакція без каста");

  // 🧨 Друга половина: довести, що редакції РІЗНІ. Чиста проба, без таблиць —
  // працює будь-де, де є зʼєднання, і не залежить від наявних даних.
  const { pool } = await import("../db/pool.js");
  const [p] = (await pool.query<{ naive: boolean; kyiv: boolean }>(
    `SELECT (TIMESTAMPTZ '2026-08-01 01:30:00+03' >= DATE '2026-08-01') AS naive,
            (TIMESTAMPTZ '2026-08-01 01:30:00+03' >= (DATE '2026-08-01')::timestamp ${KY}) AS kyiv`)).rows;
  assert.equal(p.naive, false, "🔴 наївна редакція вже не відкидає нічний виграш — проба втратила предмет");
  assert.equal(p.kyiv, true, "🔴 київська північ відкидає нічний виграш — каст поставлений неправильно");
});

/**
 * #214e — СЛІД НЕ ВУЖЧИЙ ЗА РЕЄСТР (будильник на писаря).
 *
 * Реєстр лишається ДЖЕРЕЛОМ ПРАВДИ передач, слід — його персистом: `upsertLeadgenTouch`
 * переливає одне в друге всередині `syncKommo`. Обидві джоби ходять кожні 30 хв, тож
 * між ними є вікно; сьогодні лаг **0 лідів**, але якщо писар відстане чи зламається,
 * пʼятий читач почне ТИХО занижувати — жодне окреме число не виглядатиме дивним.
 *
 * 🪞 Дзеркало: реєстр непорожній. Без нього «0 лідів поза слідом» було б зелене й
 * тоді, коли реєстр порожній сам — рівно «порожній результат читається як норма».
 *
 * 🧨 САБОТАЖ (виконано): звузити вибірку сліду вікном `transfer_date > now() - 10d`
 * → червоніє з числом; підмінити реєстр порожньою вибіркою → червоніє дзеркало.
 */
test("#214e слід не вужчий за реєстр — писар не відстав", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const [r] = (await pool.query<{ registry_leads: number; orphans: number; newest: string | null }>(
    `SELECT (SELECT COUNT(DISTINCT lead_id) FROM leadgen_registry)::int AS registry_leads,
            COUNT(DISTINCT lr.lead_id)::int AS orphans,
            MAX((lr.transferred_at ${KY})::date)::text AS newest
       FROM leadgen_registry lr
       LEFT JOIN leadgen_touch lt ON lt.lead_kommo_id = lr.lead_id
      WHERE lt.lead_kommo_id IS NULL`)).rows;

  assert.ok(r.registry_leads > 0,
    "🔴 реєстр порожній — «0 лідів поза слідом» тут нічого не доводить (дзеркало)");
  assert.equal(r.orphans, 0,
    `🔴 ${r.orphans} лідів реєстру немає у сліді (найсвіжіший ${r.newest}) — `
    + "`upsertLeadgenTouch` відстав або зламався, і когортний знаменник тихо занижує");
});
