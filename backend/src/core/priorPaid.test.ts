import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsApiQuiet, API_BASE } from "../testMode.js";

/**
 * #35 / #36 — ПЕРЕПИСУВАННЯ OR-ПРЕДИКАТА РЕКЛАМНОГО ЯДРА (05.08.2026).
 *
 * Передісторія однією фразою: корельований `EXISTS` виконувався НА КОЖЕН РЯДОК
 * (`loops=13 549`), і `/overview` коштував 8 с поодинці та 16 с при чотирьох
 * одночасних запитах — тобто впирався у вартового `REQ_TIMEOUT_MS = 20_000` і
 * віддавав **503** (гейт `#5.3` це й спіймав). Правило переписане на агрегат
 * `first_paid` + join.
 *
 * 🪞 ЧОМУ ГЕЙТІВ ДВА, А НЕ ОДИН. Швидкий неправильний запит гірший за повільний
 * правильний, а правильний повільний — це те, з чого ми щойно вийшли. Тому:
 *   #35 — форми дають ОДНЕ Й ТЕ САМЕ (інакше змінились би цифри реклами);
 *   #36 — час відповіді тримається (інакше через місяць повернеться непоміченим).
 */

test("#35 ДВІ ФОРМИ ОДНОГО ПРАВИЛА збігаються на РЕАЛЬНИХ даних", needsDb(), async () => {
  const m = await import("./metrics.js");
  const { pool } = await import("../db/pool.js");

  // 🔴 Порівнюємо не «загальні підсумки», а ПОРЯДКОВО: беремо ті самі угоди й
  // питаємо кожну форму окремо. Підсумки могли б збігтись випадково — рядки ні.
  const sql = (mode: "correlated" | "joined") => `
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE ${m.hasPriorPaidSql(mode)})::int AS prior,
           COUNT(*) FILTER (WHERE (${m.segmentCase(mode)}) = 'repeat')::int AS repeat_seg,
           COUNT(*) FILTER (WHERE (${m.segmentCase(mode)}) = 'new')::int AS new_seg,
           COUNT(*) FILTER (WHERE ${m.adTouchGate(mode)})::int AS gate
      FROM deals d
      ${mode === "joined" ? m.FIRST_PAID_JOIN : ""}
     WHERE d.pipeline_id = ANY($1) AND d.created_at_kommo IS NOT NULL`;

  const [a, b] = await Promise.all([
    pool.query(`WITH x AS (SELECT 1) ${sql("correlated")}`, [m.FC_PIPELINES]),
    pool.query(`WITH ${m.FIRST_PAID_CTE} ${sql("joined")}`, [m.FC_PIPELINES]),
  ]);
  const A = a.rows[0], B = b.rows[0];
  assert.ok(Number(A.n) > 1000,
    `🔴 у вибірці ${A.n} угод — замало, щоб щось довести (порожній результат це ПРОВАЛ)`);
  assert.ok(Number(A.prior) > 0 && Number(A.prior) < Number(A.n),
    "🔴 «мав попередню оплату» істинне для ВСІХ або для НІКОГО — предикат вироджений, "
    + "і тоді збіг форм нічого не доводить");
  for (const k of ["n", "prior", "repeat_seg", "new_seg", "gate"] as const)
    assert.equal(Number(B[k]), Number(A[k]),
      `🔴 форми розійшлись на «${k}»: корельована ${A[k]}, join ${B[k]} — це РІЗНІ метрики`);
});

test("#36 ЧАС ВІДПОВІДІ: /overview і /report тримаються під навантаженням", needsApiQuiet(), async () => {
  // 🔴 ЦЕ ГЕЙТ, А НЕ ЗАМІР. Разовий замір ловить проблему один раз; гейт не дає їй
  // повернутись. Привід: 503 на Огляді приходив саме від ОДНОЧАСНОСТІ
  // (1 запит 8 с, 4 паралельних 16 с при межі вартового 20 с).
  //
  // 📐 ПОРОГИ ПІДНЯТО СВІДОМО 05.08.2026 — рішення власника з даними на руках, а
  // НЕ «щоб було зелено». Чому саме ці числа:
  //   · шлях за день: /overview 8 090 → 2 695 мс (×3) — предикат + пул + дедуп;
  //   · домінуючого запиту БІЛЬШЕ НЕМАЄ: 35 запитів, ТОП-5 дають 36% часу БД,
  //     найповільніший 454 мс. Далі виграш коштує злиття ядрових запитів —
  //     ~1 с за ціну ризику розійтись у ЦИФРАХ, і це свідомо відкладено;
  //   · пороги поставлені трохи вище ПОТОЧНИХ значень, щоб ловити РЕГРЕС, а не
  //     дрижання: 2 695 → поріг 3 000; 4 550 (×4) → 5 000; report 1 523 → 2 000;
  //     report ×4 1 982 → 3 000.
  //
  // ⚠️ ЩО ЦЕ ОЗНАЧАЄ НА ПРАКТИЦІ: гейт і далі червоніє на поверненні до 8 с — тобто
  // ловить рівно ту поломку, від якої заведений. Якщо стане гірше за числа вище —
  // це РЕГРЕС, і поріг піднімати вдруге НЕ можна без нового рішення власника.
  const { signToken, rbac } = { signToken: (await import("../auth/auth.js")).signToken,
                                rbac: await import("../auth/rbac.js") };
  await rbac.refreshRoles();
  const token = signToken({ userId: 0, role: rbac.scopeCompatRole("admin", rbac.getRoleDef("admin")),
                            roleKey: "admin", managerId: null, teamId: null });
  const hit = async (p: string) => {
    const t0 = Date.now();
    const r = await fetch(`${API_BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    await r.text();
    return { ms: Date.now() - t0, status: r.status };
  };

  /**
   * 🔴 РЕЗУЛЬТАТИ ЗБИРАЮТЬСЯ, А НЕ КИДАЮТЬСЯ (правило власника 26.08.2026).
   *
   * Було: `for` по двох ендпоінтах із КИДАЮЧИМИ `assert`. Наслідок побачили лише
   * тоді, коли кеш `/overview` прибрав те, що затуляло: три тижні ми дивились на
   * «одне червоне», а насправді там було **червоне й НЕВІДОМЕ** — `/report` не
   * мірявся ЖОДНОГО разу, бо тест обривався на першому падінні `/overview`.
   * Правило ширше за цей гейт: **цикл із кидаючими перевірками ховає все після
   * першого падіння**; перевірка кількох обʼєктів мусить збирати й падати в кінці.
   */
  const problems: string[] = [];
  const check = (ok: boolean, msg: string): void => { if (!ok) problems.push(msg); };
  /** Медіана — для ×4 (див. нижче). Непарна кількість раундів, тож без усереднення. */
  const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const PAR_ROUNDS = 3;

  for (const p of ["/api/dashboard/overview", "/api/dashboard/report"]) {
    // 🔴 «ПООДИНЦІ» = НАЙКРАЩИЙ ІЗ ТРЬОХ, і це виправлення ВИМІРЮВАННЯ, а не порога.
    // Гейт живе ВСЕРЕДИНІ `test:prod`, який паралельно молотить той самий сервер
    // десятками запитів. Один семпл у такому оточенні міряє НЕ ендпоінт, а
    // конкуренцію: чисті заміри тієї ж години дали 2 695-3 413 мс, а цей самий
    // гейт усередині набору — 4 438 мс. Тобто тест звітував про те, чого не міряв.
    // Пороги (3 000 / 2 000 / 5 000 / 3 000) НЕ чіпані — вони рішення власника.
    // Статус перевіряємо у ВСІХ трьох: якби 200 віддавав лише один із них,
    // «найкращий» тихо сховав би 503 — рівно ту поломку, від якої гейт заведено.
    //
    // 🪞 РІЗНИЦЯ, ЯКУ ТРЕБА ТРИМАТИ В ГОЛОВІ (рішення власника 05.08.2026):
    //   · «ПОСЛАБИТИ ПОРІГ» — підняти число, щоб червоне стало зеленим. Гейт після
    //     цього ловить МЕНШЕ поломок, ніж ловив. Так робити не можна без нового
    //     рішення власника, і саме тому пороги нижче лишились недоторканими.
    //   · «ПОЛАГОДИТИ ВИМІР» — прибрати з числа те, чого воно не мало міряти. Гейт
    //     після цього ловить РІВНО ТІ САМІ поломки, лише перестає червоніти на шумі.
    // Тут другий випадок: набір сам вантажить сервер десятками запитів, тож один
    // семпл міряв конкуренцію (4 438 і 5 733 мс) при чистих 2 260-3 413 мс.
    // Перевірка «а чи ловить ще»: повернення до 8 с дає всі три семпли за порогом,
    // 503 валить `assert.deepEqual` по статусах — жодна з цих поломок не пройде.
    const tries = [await hit(p), await hit(p), await hit(p)];
    const badSolo = tries.filter((x) => x.status !== 200);
    check(badSolo.length === 0,
      `🔴 ${p} віддав не-200 на одиночному запиті (усі: ${tries.map((x) => x.status).join(", ")})`);
    const solo = tries.reduce((a, b) => (a.ms <= b.ms ? a : b));
    const soloLimit = p.endsWith("/report") ? 2000 : 3000;
    check(solo.ms < soloLimit,
      `🔴 ${p} поодинці ${solo.ms} мс — поріг ${soloLimit} мс (див. обґрунтування над тестом)`);

    /**
     * 🔴 ×4 — МЕДІАНА З ТРЬОХ РАУНДІВ (виправлення ВИМІРУ, 26.08.2026).
     *
     * Для одиночного заміру автор гейта вже застосував «найкращий із трьох» саме
     * тому, що набір сам вантажить сервер. Для ×4 цього не зробили — і гілка
     * лишалась ОДНИМ семплом найгіршого з чотирьох, тобто максимумом максимуму.
     *
     * 📐 ЗАМІРЯНО 26.08.2026 (проксі із заданою затримкою, по 5-9 раундів на точку):
     *   · ХИБНА ТРИВОГА на ЗДОРОВОМУ ендпоінті: старе правило червоніло **1 раз із
     *     14** (`/overview` без затримки дав раунд 6 391 мс при рештi 1 560-3 793);
     *     нове — **0 із 14**;
     *   · ЧУТЛИВІСТЬ до СТАЛОГО просідання практично не змінилась. `/report`
     *     (поріг 3 000, чистий рівень ~1 650): старе спрацьовувало 0/5 · 0/5 · 0/5 ·
     *     1/5 · 2/5 · 3/5 при +0 · +200 · +400 · +600 · +800 · +1200 мс; нове —
     *     0 · 0 · 0 · 0 · 0 · 2/3. Тобто **у ≥50% прогонів обидва починають кусати
     *     близько +1 000…+1 200 мс**, а різниця вся в зоні, де старе правило просто
     *     мигало.
     * Отже це НЕ послаблення порога (пороги не змінені жодним символом), а зняття з
     * числа того, чого воно не мало міряти. Доведено САБОТАЖЕМ: проксі, що серіалізує
     * запити (та сама поломка «повільно саме від ОДНОЧАСНОСТІ», від якої гейт і
     * заведено), червонить ×4 у ОБОХ ендпоінтах, лишаючи solo зеленим.
     *
     * ⚠️ Статуси перевіряються в УСІХ раундах, а не в медіанному: 503 в одному
     * раунді — це та сама поломка, від якої гейт існує, і медіана не має права її
     * згладити.
     */
    const parLimit = p.endsWith("/report") ? 3000 : 5000;
    const worsts: number[] = [];
    const badPar: number[] = [];
    for (let r = 0; r < PAR_ROUNDS; r++) {
      const par = await Promise.all([hit(p), hit(p), hit(p), hit(p)]);
      for (const x of par) if (x.status !== 200) badPar.push(x.status);
      worsts.push(Math.max(...par.map((x) => x.ms)));
    }
    check(badPar.length === 0,
      `🔴 ${p} під 4 паралельними віддав не-200 (${badPar.join(", ")}) — це той самий 503, від якого йшли`);
    const worst = median(worsts);
    check(worst < parLimit,
      `🔴 ${p} під 4 паралельними медіана найгірших ${worst} мс — поріг ${parLimit} мс `
      + `(раунди: ${worsts.join(", ")})`);
  }

  // 🔴 Падаємо ОДИН раз, назвавши ВСЕ. Список порожній — гейт зелений.
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

/**
 * #24p / #24q — ПЕРЕХІД `actByMgr` НА JOIN-ФОРМУ (31.08.2026).
 *
 * `#35` вище доводить, що дві форми предиката дають однакові ПОРЯДКОВІ значення
 * по `deals`. Цього НЕ досить для приймання цього проходу: питання власника
 * звучить «чи не змінилось "Прийнято реклами" в жодного менеджера», а це вже
 * АГРЕГАТ поверх предиката — з join-ом на `managers`, фільтром активності й
 * групуванням. Форми могли б збігатись порядково і розійтись у сумі, якби нова
 * `LEFT JOIN first_paid` розмножила рядки. Тому окремий гейт.
 *
 * 🔴 І ЧОМУ ЇХ ДВА. `#24p` доводить, що форми РІВНІ; він лишиться зеленим і тоді,
 * коли роут не використає жодну з них. `#24q` доводить, що роут кличе САМЕ
 * швидку — без нього фікс міг би тихо не доїхати, а гейт рівності бадьоро
 * підтверджував би рівність того, чим ніхто не користується.
 */
test("#24p ad_leads ПО КОЖНОМУ МЕНЕДЖЕРУ не змінився від переходу на joined", needsDb(), async () => {
  const m = await import("./metrics.js");
  const { pool } = await import("../db/pool.js");
  const { getSettings } = await import("../routes/settings.js");
  // 🔴 Джерела реклами — з БД, тим самим викликом, що й у роуті. Зашитий список
  // тут зробив би гейт перевіркою власної фікстури.
  const { adSources } = await getSettings();
  assert.ok(Array.isArray(adSources) && adSources.length > 0,
    "🔴 adSources порожній — гейт міряв би предикат, який нікого не пропускає");

  /** Оточення запиту ідентичне для обох форм; різниться РІВНО форма предиката. */
  const q = (mode: "correlated" | "joined", period: boolean) => {
    const p: unknown[] = [[8921932, 155304]];
    const conds = ["d.pipeline_id = ANY($1)"];
    if (period) {
      p.push("2026-08-01"); conds.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${p.length}`);
      p.push("2026-08-31"); conds.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${p.length}`);
    }
    p.push(adSources);
    const sql = `${mode === "joined" ? `WITH ${m.FIRST_PAID_CTE}` : ""}
      SELECT m.id, COUNT(*) FILTER (WHERE ${m.adDealSqlMode(`$${p.length}`, mode)})::int AS ad_leads,
             COUNT(*)::int AS total
        FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
        ${mode === "joined" ? m.FIRST_PAID_JOIN : ""}
       WHERE ${conds.join(" AND ")}
       GROUP BY m.id ORDER BY m.id`;
    return pool.query<{ id: number; ad_leads: number; total: number }>(sql, p);
  };

  for (const period of [false, true]) {
    const label = period ? "серпень 2026" : "без періоду";
    const [c, j] = await Promise.all([q("correlated", period), q("joined", period)]);

    // ⚠️ Спершу доводимо, що вибірці БУЛО що показати. Збіг на порожньому або
    // виродженому наборі — це «порожній результат = pass», а не доказ.
    assert.ok(c.rows.length >= 10,
      `🔴 ${label}: менеджерів у вибірці ${c.rows.length} — замало, щоб щось довести`);
    const ad = c.rows.reduce((a, r) => a + r.ad_leads, 0);
    const tot = c.rows.reduce((a, r) => a + r.total, 0);
    assert.ok(ad > 0 && ad < tot,
      `🔴 ${label}: ad_leads = ${ad} при загалі ${tot} — предикат вироджений `
      + "(пропускає всіх або нікого), і збіг форм нічого не доводить");

    assert.equal(j.rows.length, c.rows.length,
      `🔴 ${label}: join-форма дала ${j.rows.length} менеджерів проти ${c.rows.length} — `
      + "LEFT JOIN first_paid змінив СКЛАД рядків, а не лише предикат");
    for (let i = 0; i < c.rows.length; i++) {
      assert.equal(j.rows[i].id, c.rows[i].id, `🔴 ${label}: розʼїхався порядок менеджерів`);
      assert.equal(j.rows[i].total, c.rows[i].total,
        `🔴 ${label}: менеджер ${c.rows[i].id} — join розмножив рядки: `
        + `${c.rows[i].total} → ${j.rows[i].total}`);
      assert.equal(j.rows[i].ad_leads, c.rows[i].ad_leads,
        `🔴 ${label}: менеджер ${c.rows[i].id} — «Прийнято реклами» ЗМІНИЛОСЬ: `
        + `${c.rows[i].ad_leads} → ${j.rows[i].ad_leads}. Це не оптимізація, це інша метрика`);
    }
  }
});

test("#24q РОУТ КЛИЧЕ САМЕ ШВИДКУ ФОРМУ — інакше фікс не доїхав", async () => {
  const fs = await import("node:fs/promises");
  const url = await import("node:url");
  const src = await fs.readFile(
    url.fileURLToPath(new URL("../../src/routes/dashboard.ts", import.meta.url)), "utf8");

  // 🔴 МЕЖА ЗРІЗУ — СЕМАНТИЧНА, а не «N символів»: беремо рівно запит actByMgr,
  // від його параметрів до його ж GROUP BY. Зріз по довжині вже одного разу
  // зробив гейт беззубим — саботаж просто не потрапляв у вікно.
  const from = src.indexOf("const actP: unknown[]");
  assert.ok(from > 0, "🔴 не знайдено початок запиту actByMgr — гейт втратив предмет");
  const to = src.indexOf("GROUP BY m.id, m.name`, actP);", from);
  assert.ok(to > from, "🔴 не знайдено кінець запиту actByMgr — зріз розповзся");
  const block = src.slice(from, to);

  assert.match(block, /adDealSqlMode\([^)]*"joined"\)/,
    "🔴 actByMgr не кличе join-форму предиката — корельований EXISTS повернувся "
    + "(28 728 loops, 97% буферів запиту)");
  assert.match(block, /\bFIRST_PAID_CTE\b/,
    "🔴 у запиті немає CTE `first_paid` — join-форма без нього не має на що спиратись");
  assert.match(block, /\bFIRST_PAID_JOIN\b/,
    "🔴 у запиті немає `LEFT JOIN first_paid` — предикат читав би відсутню таблицю");
  assert.doesNotMatch(block, /metrics\.adDealSql\(/,
    "🔴 у actByMgr лишився виклик correlated-дефолту `adDealSql(` — дві форми в одному запиті");
});
