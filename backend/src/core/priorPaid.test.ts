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
    assert.deepEqual(badSolo.map((x) => x.status), [],
      `🔴 ${p} віддав не-200 на одиночному запиті (усі: ${tries.map((x) => x.status).join(", ")})`);
    const solo = tries.reduce((a, b) => (a.ms <= b.ms ? a : b));
    const soloLimit = p.endsWith("/report") ? 2000 : 3000;
    assert.ok(solo.ms < soloLimit,
      `🔴 ${p} поодинці ${solo.ms} мс — поріг ${soloLimit} мс (див. обґрунтування над тестом)`);

    const par = await Promise.all([hit(p), hit(p), hit(p), hit(p)]);
    const bad = par.filter((x) => x.status !== 200);
    assert.deepEqual(bad.map((x) => x.status), [],
      `🔴 ${p} під 4 паралельними віддав не-200 — це той самий 503, від якого йшли`);
    const parLimit = p.endsWith("/report") ? 3000 : 5000;
    const worst = Math.max(...par.map((x) => x.ms));
    assert.ok(worst < parLimit,
      `🔴 ${p} під 4 паралельними найгірший ${worst} мс — поріг ${parLimit} мс `
      + `(усі: ${par.map((x) => x.ms).join(", ")})`);
  }
});
