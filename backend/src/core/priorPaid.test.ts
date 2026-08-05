import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsApi, API_BASE } from "../testMode.js";

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

test("#36 ЧАС ВІДПОВІДІ: /overview і /report тримаються під навантаженням", needsApi(), async () => {
  // 🔴 ЦЕ ГЕЙТ, А НЕ ЗАМІР. Разовий замір ловить проблему один раз; гейт не дає їй
  // повернутись. Пороги — з реального інциденту: до появи корельованої форми
  // /overview коштував ~2.5 с поодинці, а 503 приходив саме від ОДНОЧАСНОСТІ
  // (1 запит 8 с, 4 паралельних 16 с при межі 20 с).
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
    const solo = await hit(p);
    assert.equal(solo.status, 200, `🔴 ${p} віддав ${solo.status} на ОДИН запит`);
    assert.ok(solo.ms < 2500,
      `🔴 ${p} поодинці ${solo.ms} мс — поріг 2500 мс (стільки коштувало ДО появи проблеми)`);

    const par = await Promise.all([hit(p), hit(p), hit(p), hit(p)]);
    const bad = par.filter((x) => x.status !== 200);
    assert.deepEqual(bad.map((x) => x.status), [],
      `🔴 ${p} під 4 паралельними віддав не-200 — це той самий 503, від якого йшли`);
    const worst = Math.max(...par.map((x) => x.ms));
    assert.ok(worst < 4000,
      `🔴 ${p} під 4 паралельними найгірший ${worst} мс — поріг 4000 мс `
      + `(усі: ${par.map((x) => x.ms).join(", ")})`);
  }
});
