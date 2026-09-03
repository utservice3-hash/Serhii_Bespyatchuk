import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsApi, API_BASE } from "../testMode.js";

/**
 * ТЕСТ #4 — ПЛАНИ.
 *
 * Три речі, кожна з яких уже ламалась:
 *  1. МІНІМУМ 30 000 ₴ на менеджера — з НАЛАШТУВАНЬ, не з хардкоду. Якщо значення
 *     зникне з відповіді або стане 0, форма мовчки перестане попереджати.
 *  2. `below_min` БЕЗ ХИБНИХ СПРАЦЮВАНЬ — прапорець має стояти рівно там, де план
 *     реально нижчий за мінімум. Хибне спрацювання знецінює позначку швидше, ніж
 *     її відсутність: на неї перестають дивитись.
 *  3. 🔴 ЗНІМОК СУМ ПО МІСЯЦЯХ — ловить автоперерозподіл. Був випадок: план
 *     звільненого менеджера АВТОМАТИЧНО розкидався на решту, і сума місяця мінялась
 *     сама собою. Минулі місяці НЕ МАЮТЬ рухатись ніколи.
 */

const load = async () => ({
  pool: (await import("../db/pool.js")).pool,
  signToken: (await import("../auth/auth.js")).signToken,
  getSettings: (await import("./settings.js")).getSettings,
});

/**
 * 🔒 ЗНІМОК ЗАКРИТИХ МІСЯЦІВ (зафіксовано 31.07.2026 з прода). Цифри тут — НЕ
 * «поточне значення», а закріплений факт. Якщо тест почервонів — хтось змінив план
 * закритого місяця, і це треба пояснити, а не оновити знімок.
 */
const PLAN_SNAPSHOT: Record<string, { managers: number; total: number }> = {
  "2026-06": { managers: 25, total: 2_674_000 },
  "2026-07": { managers: 32, total: 2_700_000 },
  // 📐 Додано 01.09.2026, щойно серпень закрився. Заміряно того ж дня 22:15 за Києвом:
  //    30 рядків / 2 754 000 ₴. ⚠️ Число 2 759 000, що півмісяця їздило в промтах як
  //    факт, — це замір 06.08 у ВІДКРИТОМУ місяці; воно протухло, а не помилкове.
  "2026-08": { managers: 30, total: 2_754_000 },
};

/**
 * 🗑 #4.1 ЗНЯТО 02.09.2026 (див. `RETIRED_GATES`). Він стверджував, що межа дорівнює
 * САМЕ 30 000 — а власник тепер може змінити її з екрана Налаштувань, і «0» означає
 * «межу свідомо знято». Гейт червонів би на законній дії.
 * А ДЕ ЦЕ ТЕПЕР: `#276d` (дефолт існує й у діапазоні), `#276b` («очистити» повертає
 * саме його), `#276e` (бекфіл читає поріг лише з налаштувань).
 */
test("#4.2 МІНІМУМ доходить до API формування плану", needsApi(), async () => {
  const { signToken } = await load();
  const t = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const r = await fetch(`${API_BASE}/api/plans/formation?month=2026-08`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(r.status, 200, `/plans/formation віддав ${r.status}`);
  const j = (await r.json()) as { minPerManager?: number; teams?: unknown[] };
  assert.equal(j.minPerManager, 30000, "мінімум не доїхав до форми — попередження зникне мовчки");
  assert.ok(Array.isArray(j.teams) && j.teams.length > 0,
    "форма формування повернула 0 команд — порожній результат це ПРОВАЛ, а не «немає даних»");
});

/**
 * #4.3 — ПРАВИЛО below_min (рішення власника 31.07.2026):
 * прапорець ставиться ЛИШЕ для АКТИВНИХ менеджерів із планом > 0.
 *
 * 🔴 Чому не «будь-який план < мінімуму»: план 0 ми ставимо СВІДОМО — так прибирали
 * звільненого з перерозподілу. Це стан «виключений із плану», а не «нижче мінімуму».
 * Якби прапорець ловив і нулі, звіт кричав би про навмисне рішення, і за тиждень на
 * позначку перестали б дивитись — гірше, ніж її відсутність.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 🔴 ЧОМУ ГЕЙТ ПЕРЕПИСАНО (21.08.2026, борг «Рибенко»).
 *
 * Він падав на проді, і падав ПРАВИЛЬНО за своєю логікою й НЕПРАВИЛЬНО по суті.
 * Заміряно: рядок `plan_formation #15`, Рибенко Анна, місяць **2026-08**, план
 * **20 000** (< 30 000), `below_min = true`, коментар є, `status = approved`,
 * подано 31.07, затверджено 03.08. Менеджера деактивували ПІЗНІШЕ — сьогодні
 * `is_active = false`.
 *
 * Гейт брав ЗАМОРОЖЕНИЙ запис і перераховував його СЬОГОДНІШНІМ `is_active`, тобто
 * питав «чи поставили б ми цей прапорець зараз», хоча запис відповідає на інше
 * питання — «яким було судження на момент затвердження». Той самий клас, що ми
 * лікуємо весь час: два різні правила на одне поле. Писач знав `value < min`, гейт —
 * `active && value > 0 && value < min`; збігались вони рівно доти, доки всі, хто
 * подав план, лишались активними.
 *
 * 🔒 ТОМУ ВИМІРИ РОЗДІЛЕНО, а не послаблено:
 *   • ЗНАЧЕННЄВИЙ (`0 < value < min`) — не залежить від часу, тож перевіряється на
 *     ВСІХ рядках і в ОБИДВА боки. Заміряно 21.08: порушень нуль (32 рядки).
 *   • АКТИВНІСТЬ — властивість, що змінюється, тож вимога «мусить бути помічений»
 *     ставиться ЛИШЕ тим, хто активний СЬОГОДНІ. Для решти заморожене значення
 *     ПОВАЖАЄТЬСЯ — реконструювати стан на момент затвердження ми не можемо.
 *
 * ⚠️ І щоб виняток не зʼїв гейт цілком, кількість «заморожених» рядків названа
 * ЧИСЛОМ: якщо колись під нього підпаде все, перевірка стане порожньою — а
 * порожній результат ми домовились вважати провалом, а не успіхом.
 */
test("#4.3 below_min БЕЗ ХИБНИХ СПРАЦЮВАНЬ (лише активні, план > 0)", needsDb(), async () => {
  const { pool, getSettings } = await load();
  const min = (await getSettings()).planMinPerManager;
  const rows = (await pool.query<{ id: number; proposed_value: string; below_min: boolean; active: boolean }>(
    `SELECT pf.id, pf.proposed_value, pf.below_min, COALESCE(m.is_active, false) AS active
       FROM plan_formation pf LEFT JOIN managers m ON m.id = pf.manager_id`)).rows;
  assert.ok(rows.length > 0, "у plan_formation немає жодного рядка — тест нічого не перевіряє");

  /** ЗНАЧЕННЄВИЙ вимір — не залежить від часу, тож дійсний і для закритих місяців. */
  const belowByValue = (r: typeof rows[number]) =>
    Number(r.proposed_value) > 0 && Number(r.proposed_value) < min;

  // ── 1. Прапорець стоїть на значенні, яке НЕ МОГЛО бути нижче мінімуму. Це помилка
  //      завжди, незалежно від того, працює людина сьогодні чи ні.
  const wrongValue = rows.filter((r) => r.below_min && !belowByValue(r));
  assert.deepEqual(wrongValue.map((r) => `#${r.id}=${r.proposed_value}`), [],
    `🔴 below_min стоїть там, де значення ≥ ${min} або дорівнює нулю — позначка знеціниться`);

  // ── 2. Активний СЬОГОДНІ менеджер із планом нижче мінімуму мусить бути помічений.
  //      Саме тут живе вимога «лише активним»: на живих даних, а не на замороженому записі.
  const falseNeg = rows.filter((r) => !r.below_min && r.active && belowByValue(r));
  assert.deepEqual(falseNeg.map((r) => `#${r.id}=${r.proposed_value}`), [],
    `🔴 активний менеджер із планом 0 < план < ${min} без позначки — виняток пройде непоміченим`);

  // ── 3. Нулі СВІДОМО не позначені (обидва боки: і що не позначені, і що вони є).
  const zeros = rows.filter((r) => Number(r.proposed_value) === 0);
  assert.deepEqual(zeros.filter((r) => r.below_min).map((r) => r.id), [],
    "план 0 позначено як below_min — це стан «виключений із плану», не «нижче мінімуму»");

  // ── 4. 🧊 ЗАМОРОЗКА НЕ СМІЄ ЗʼЇСТИ ГЕЙТ. Рядки, де прапорець стоїть, а людина вже
  //      неактивна, — це історичні судження, і ми їх поважаємо. Але якщо під цей
  //      виняток підпаде ВЕСЬ набір, перевіряти стане нічого.
  const frozen = rows.filter((r) => r.below_min && !r.active && belowByValue(r));
  const judgeable = rows.filter((r) => r.active).length;
  assert.ok(judgeable > 0,
    `🔴 жодного активного рядка (${rows.length} усього, ${frozen.length} заморожених) — `
    + "вимога «мусить бути помічений» не перевіряється НІ НА ЧОМУ");
  assert.ok(frozen.length < rows.length,
    "🔴 заморожені всі рядки до єдиного — гейт став порожнім");
});

test("#4.4 🔴 ЗНІМОК: суми планів закритих місяців НЕ рухаються", needsDb(), async () => {
  const { pool } = await load();
  const rows = (await pool.query<{ m: string; n: string; total: string }>(
    `SELECT to_char(plan_date,'YYYY-MM') m, COUNT(*) n, COALESCE(SUM(planned_value),0) total
       FROM plans WHERE metric = 'payment_amount' GROUP BY 1`)).rows;
  assert.ok(rows.length > 0, "планів немає взагалі — порожній результат це провал");
  const drift: string[] = [];
  for (const [ym, exp] of Object.entries(PLAN_SNAPSHOT)) {
    const got = rows.find((r) => r.m === ym);
    if (!got) { drift.push(`${ym}: місяць зник із planів`); continue; }
    if (Number(got.n) !== exp.managers) drift.push(`${ym}: менеджерів ${got.n}, було ${exp.managers}`);
    if (Number(got.total) !== exp.total) drift.push(`${ym}: сума ${Number(got.total).toLocaleString("uk")}, було ${exp.total.toLocaleString("uk")}`);
  }
  assert.deepEqual(drift, [],
    "🔴 план закритого місяця зрушив — саме так виглядав автоперерозподіл плану звільненого:\n  " + drift.join("\n  "));
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});
