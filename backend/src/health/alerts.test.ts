import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsApi, API_BASE } from "../testMode.js";

/**
 * ТЕСТИ СИГНАЛІЗАЦІЇ (Крок 2).
 *
 * 🔴 Головне, що тут перевіряється, — не «чи ловить поломку», а **чи не вміє мовчати**.
 * Порожній список тривог мусить означати «перевірено і чисто», а не «нічого не
 * перевірено». Тому кожен тест окремо стверджує, що перевірки РЕАЛЬНО відпрацювали.
 */

const load = async () => ({
  alerts: await import("./alerts.js"),
  signToken: (await import("../auth/auth.js")).signToken,
});

test("#10.1 СИГНАЛІЗАЦІЯ: усі оголошені перевірки відпрацювали", needsDb(), async () => {
  const { alerts } = await load();
  const state = await alerts.collectAlerts();
  assert.equal(state.checksDeclared, alerts.DECLARED_CHECKS.length,
    "лічильник оголошених перевірок розійшовся зі списком");
  assert.ok(state.checksDeclared >= 5, `оголошено ${state.checksDeclared} перевірок, очікували щонайменше 5`);
  assert.equal(state.checksRan, state.checksDeclared,
    `🔴 виконалось ${state.checksRan} із ${state.checksDeclared} — «немає тривог» було б хибним`);
  assert.ok(state.checkedAt && !Number.isNaN(Date.parse(state.checkedAt)), "checkedAt має бути валідною датою");
});

test("#10.2 СИГНАЛІЗАЦІЯ: кожна тривога каже ЩО, КОЛИ і ЩО РОБИТИ", needsDb(), async () => {
  const { alerts } = await load();
  const state = await alerts.collectAlerts();
  for (const a of state.alerts) {
    assert.ok(a.id && a.id.length > 3, `тривога без стабільного id: ${JSON.stringify(a)}`);
    assert.ok(["critical", "warning"].includes(a.severity), `невідома важливість: ${a.severity}`);
    assert.ok(a.title && a.title.length > 5, `тривога «${a.id}» без зрозумілого заголовка`);
    assert.ok(a.detail && a.detail.length > 5, `тривога «${a.id}» без деталей`);
    assert.ok(a.action && a.action.length > 5, `тривога «${a.id}» без дії — «розберіться» не рахується`);
    if (a.since) assert.ok(!Number.isNaN(Date.parse(a.since)), `тривога «${a.id}»: since не дата`);
  }
});

test("#10.3 СИГНАЛІЗАЦІЯ: збій перевірки дає ТРИВОГУ, а не тишу", needsDb(), async () => {
  const { alerts } = await load();
  const { pool } = await import("../db/pool.js");
  // Ламаємо БД під ногами перевірок: усі, що ходять у неї, мають кинути — і кожна
  // з них зобов'язана перетворитись на тривогу check_failed, а не зникнути.
  const orig = pool.query.bind(pool) as typeof pool.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = () => Promise.reject(new Error("САБОТАЖ: БД недоступна"));
  let state;
  try { state = await alerts.collectAlerts(); }
  finally { /* eslint-disable-next-line @typescript-eslint/no-explicit-any */ (pool as any).query = orig; }

  const failed = state.alerts.filter((a) => a.id.startsWith("check_failed:"));
  assert.ok(failed.length > 0,
    "🔴 перевірки впали, а тривог немає — сигналізація вміє мовчати через власну поломку");
  for (const f of failed) {
    assert.match(f.detail, /НЕ означає|невідом/i, `«${f.id}» не пояснює, що стан НЕВІДОМИЙ`);
    assert.equal(f.severity, "critical", `«${f.id}» має бути critical: невідомий стан — не дрібниця`);
  }
  assert.equal(state.checksRan, state.checksDeclared, "лічильник має рахувати і провалені перевірки");
});

test("#10.4 ЕНДПОІНТ: керівництво бачить тривоги", needsApi(), async () => {
  const { signToken } = await load();
  for (const roleKey of ["admin", "ceo", "opdir", "kvp"]) {
    const t = signToken({ userId: 0, role: "admin", roleKey, managerId: null, teamId: null });
    const r = await fetch(`${API_BASE}/api/health/alerts`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 200, `${roleKey}: /health/alerts віддав ${r.status}`);
    const j = (await r.json()) as { alerts?: unknown[]; checksRan?: number; checksDeclared?: number };
    assert.ok(Array.isArray(j.alerts), `${roleKey}: поле alerts відсутнє`);
    assert.equal(j.checksRan, j.checksDeclared,
      `${roleKey}: виконались не всі перевірки (${j.checksRan}/${j.checksDeclared})`);
  }
});

/** Дзеркало до #10.4: заборона без дозволу нічого не варта, і навпаки. */
test("#10.5 ЕНДПОІНТ: менеджер/тімлід/HR тривог НЕ бачать (це не їхній шум)", needsApi(), async () => {
  const { signToken } = await load();
  const cases: [string, string][] = [["manager", "manager"], ["team_lead", "team_lead"], ["hr", "manager"], ["financier", "company"]];
  for (const [roleKey, scope] of cases) {
    const t = signToken({ userId: 0, role: scope as "manager", roleKey, managerId: 1, teamId: 1 });
    const r = await fetch(`${API_BASE}/api/health/alerts`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 403, `🔴 ${roleKey} отримав ${r.status} — банер показувався б не тим`);
  }
});

test("#10.6 ДЖОБИ під наглядом: реєстр не порожній і має інтервали", async () => {
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.ok(MONITORED_JOBS.length >= 5, `під наглядом лише ${MONITORED_JOBS.length} джоб — замало`);
  for (const j of MONITORED_JOBS) {
    assert.ok(j.name && j.everyMin > 0, `джоба без імені або частоти: ${JSON.stringify(j)}`);
    assert.ok(j.why && j.why.length > 10, `джоба «${j.name}» без пояснення, чому її мовчання важливе`);
  }
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});

test("#10.7 РОЛЬ-КЕШ: перевірка зареєстрована в сигналізації", needsDb(), async () => {
  // Джерело мало бути ДОДАНО в банер, а не лише написане. Без цього твердження
  // checkRoleCache міг би існувати у файлі й ніколи не викликатись.
  const mod = await import("./alerts.js");
  const declared = mod.declaredCheckIds ? mod.declaredCheckIds() : null;
  assert.ok(declared, "alerts.ts не віддає перелік перевірок — нема що звіряти");
  assert.ok(declared.includes("roles"),
    `🔴 перевірки «roles» немає серед джерел банера: ${declared.join(", ")}`);
});
