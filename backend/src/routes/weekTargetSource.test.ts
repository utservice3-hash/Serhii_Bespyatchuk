import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsDb, API_BASE } from "../testMode.js";

/**
 * #61 — ТИЖНЕВА ЦІЛЬ БЕРЕТЬСЯ ТІЛЬКИ З ТИЖНЕВОЇ ЗАДАЧІ.
 *
 * 🔴 ПРИВІД, ЗНАЙДЕНИЙ ОКОМ ВЛАСНИКА НА ЖИВОМУ ЕКРАНІ 07.08.2026. Блок «Тиждень ·
 * задача з Задачника» показував Андрусенко «гроші тижня 0 / 135к», де 135 000 ₴ —
 * це її МІСЯЧНИЙ план, до копійки. Причина: `effectiveWeekTargets` фільтрував
 * парасольку ЛИШЕ за датами, а місячна покриває будь-який день місяця.
 *
 * 🔴 ДРУГИЙ ДЕФЕКТ, ГІРШИЙ ЗА ПЕРШИЙ. У запиті не було `ORDER BY`, а `manual.set()`
 * затирає попереднє значення — отже при ДВОХ парасольках на сьогодні вигравав той
 * рядок, який Postgres віддав останнім. Заміряно на проді 07.08: таких менеджерів
 * **6**, і числа в них РІЗНІ (Ворошилова 12 500 тижнева проти 50 000 місячної).
 * Ціль могла стрибати між запитами без жодної зміни в даних — а виглядало б це як
 * «дашборд бреше», без відтворення.
 *
 * 🧨 САБОТАЖ: прибрати `period_kind = 'week'` із запиту → гейт червоніє, показуючи
 * ОБИДВА числа (тижневу ціль і місячний план) поруч.
 */

interface Mgr {
  managerId: number; name: string; plan: number;
  week: { target: number; dynamic: number; manual: number | null; isManual: boolean };
}

async function managers(): Promise<Mgr[]> {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${ym}-01&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  return ((await r.json()) as { managers: Mgr[] }).managers ?? [];
}

test("#61 місячний план не підставляється як тижнева ціль", needsApi(), async () => {
  const mgrs = await managers();
  assert.ok(mgrs.length >= 3, "🔴 менш як три менеджери — перевіряти нема на кому");

  /**
   * Ознака бага в чистому вигляді: ціль ПОЗНАЧЕНА як ручна і при цьому дорівнює
   * місячному плану до копійки. Тижнева ціль, що випадково збіглася з місячним
   * планом, теоретично можлива — але тоді вона дорівнює й `dynamic`, тож окремо
   * виключаємо лише повний збіг усіх трьох, щоб не ловити збіг замість помилки.
   */
  const suspects = mgrs.filter((m) =>
    m.week.isManual && m.plan > 0 && m.week.manual === m.plan && m.week.dynamic !== m.plan);

  assert.deepEqual(suspects.map((m) => `${m.name}: тижнева ${m.week.target} == місячний план ${m.plan} (динамічна була б ${m.week.dynamic})`), [],
    "🔴 МІСЯЧНИЙ ПЛАН ПІДСТАВЛЕНО ЯК ТИЖНЕВУ ЦІЛЬ — саме той баг, що бачив власник "
    + "07.08 у Андрусенко (0 / 135к). Парасолька фільтрується не за типом періоду.");

  // ⚠️ Порожній результат = ПРОВАЛ: доводимо, що умови для бага існують.
  const couldBreak = mgrs.filter((m) => m.plan > 0);
  assert.ok(couldBreak.length >= 5,
    `🔴 лише ${couldBreak.length} менеджерів мають місячний план — на такій вибірці підміна невидима`);
});

/**
 * #61b — ДЗЕРКАЛО: ручна тижнева ціль НЕ зникла разом із фільтром.
 *
 * Без цього `#61` зеленів би й тоді, коли ми відрізали ручні цілі ВЗАГАЛІ: «жодна
 * ціль не дорівнює місячному плану» — бо жодної ручної цілі більше немає. Це та
 * сама пастка, що з реквізитами: заборона без парного дозволу зеленіє на мертвій
 * фічі.
 */
test("#61b ручні тижневі цілі лишились і відрізняються від динамічних", needsApi(), async () => {
  const mgrs = await managers();
  const manual = mgrs.filter((m) => m.week.isManual && m.week.manual != null);
  assert.ok(manual.length >= 3,
    `🔴 ручних тижневих цілей лишилось ${manual.length} — фільтр за типом періоду зрізав їх усі, `
    + "а не лише місячні. Тижневі задачі в Задачнику є, і вони мусять доходити.");

  const differ = manual.filter((m) => m.week.manual !== m.week.dynamic);
  assert.ok(differ.length >= 1,
    "🔴 у жодного менеджера ручна ціль не відрізняється від динамічної — на такій вибірці "
    + "не видно, чи вона взагалі перекриває");

  // І кожна з них мусить перекривати динамічну — інакше «ручна» лише слово.
  const notOverriding = manual.filter((m) => m.week.target !== m.week.manual)
    .map((m) => `${m.name}: target ${m.week.target} ≠ manual ${m.week.manual}`);
  assert.deepEqual(notOverriding, [], "🔴 ручна ціль перестала перекривати динамічну");
});

/**
 * #61c — ТИП ПЕРІОДУ Є В ДАНИХ, А НЕ В ТЕКСТІ ЗАГОЛОВКА.
 *
 * Доти тиждень від місяця відрізняло лише слово в `title`. Гейт вимагає, щоб у
 * кожної авто-парасольки був заповнений `period_kind` — інакше наступна така
 * задача знову стане невидимою для фільтра, а помилка повернеться мовчки.
 *
 * ⚠️ Перевіряється БД, не HTTP: `period_kind` — властивість запису, і жоден
 * ендпоінт її не віддає.
 */
test("#61c у кожної парасольки заповнений period_kind", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ n: string; total: string }>(
    `SELECT COUNT(*) FILTER (WHERE period_kind IS NULL) AS n, COUNT(*) AS total
       FROM tasks WHERE auto AND task_type = 'kpi_period'`);
  const { n, total } = r.rows[0];
  assert.ok(Number(total) > 0, "🔴 парасольок немає взагалі — перевіряти нічого");
  assert.equal(Number(n), 0,
    `🔴 ${n} із ${total} парасольок без \`period_kind\` — для них тип періоду знову невідомий, `
    + "і місячна задача може підставитись як тижнева. Бекфіл у schema.sql не покрив ці рядки.");

  // Дзеркало: значення саме ті, які розуміє фільтр, а не довільний текст.
  const k = await pool.query<{ period_kind: string | null; n: string }>(
    `SELECT period_kind, COUNT(*) AS n FROM tasks
      WHERE auto AND task_type = 'kpi_period' GROUP BY 1 ORDER BY 2 DESC`);
  const unknown = k.rows.filter((x) => x.period_kind !== "week" && x.period_kind !== "month");
  assert.deepEqual(unknown.map((x) => `${x.period_kind}: ${x.n}`), [],
    "🔴 у `period_kind` є значення, яких фільтр не розуміє — вони поводитимуться як NULL");
});
