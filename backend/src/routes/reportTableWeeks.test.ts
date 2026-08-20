import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsDb, needsApi, API_BASE } from "../testMode.js";
import { fixedWeekBlocks } from "../core/dates.js";
import { sumDaysIntoBlocks } from "../core/weekFacts.js";

/**
 * #85 / #85b / #89 / #57c — РОЗКРИТТЯ ТИЖНІВ І ЧАС РЕАКЦІЇ ПО МЕНЕДЖЕРАХ.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const ROUTE = path.join(ROOT, "backend", "src", "routes", "dashboard.ts");
const TABLE_TSX = path.join(ROOT, "frontend", "src", "pages", "dashboard", "sections", "ReportTableSection.tsx");

// ─────────────────── #85 · факт не губиться на межах тижнів ───────────────────

test("#85 Σ ТИЖНІВ == Σ ДНІВ МІСЯЦЯ, і жодна доба не випадає між блоками", () => {
  // Серпень 2026 починається в СУБОТУ, тож перший блок — 01–02.08. Це найгірший
  // випадок і водночас той самий, на якому `date_trunc('week')` віднесла б гроші
  // 1 серпня до 27 липня — тобто в місяць, якого в запиті немає.
  const blocks = fixedWeekBlocks("2026-08-01");
  assert.equal(blocks[0].from, "2026-08-01");
  assert.equal(blocks[0].to, "2026-08-02", "перший блок серпня 2026 — сб+нд, до найближчої неділі");

  const days = [
    { day: "2026-08-01", value: 1000 },   // перший блок, «незручна» доба
    { day: "2026-08-02", value: 500 },
    { day: "2026-08-03", value: 2000 },   // початок другого блоку
    { day: "2026-08-31", value: 7000 },   // останній день місяця
  ];
  const { byBlock, outside } = sumDaysIntoBlocks(days, blocks);
  assert.equal(outside, 0, "🔴 доба не потрапила в жоден блок — гроші зникли б із розкриття мовчки");
  assert.equal(byBlock.reduce((s, v) => s + v, 0), 10500, "🔴 Σ блоків ≠ Σ днів");
  assert.equal(byBlock[0], 1500, "🔴 перший (обрізаний) блок втратив свої дні — рівно та поломка, "
    + "яку дав би тижневий бакет ядра");
  assert.equal(byBlock[byBlock.length - 1], 7000, "🔴 останній день місяця випав з останнього блоку");

  // Дзеркало: доба ПОЗА місяцем мусить бути ПОМІЧЕНА, а не тихо влитись у крайній блок.
  const spill = sumDaysIntoBlocks([{ day: "2026-07-31", value: 999 }], blocks);
  assert.equal(spill.outside, 999, "🔴 чужа доба влилась у блок замість того, щоб бути названою");
  assert.equal(spill.byBlock.reduce((s, v) => s + v, 0), 0);
});

test("#85b ПЛАН ТИЖНЯ — ЗІ ЗНІМКА, А НЕ ПЕРЕРАХОВУЄТЬСЯ ФОРМУЛОЮ", () => {
  const s = readFileSync(ROUTE, "utf8");
  const body = s.split('dashboardRouter.get("/report-plan/manager-weeks"')[1]?.split("dashboardRouter.get(")[0] ?? "";
  assert.ok(body.length > 0, "🔴 роут /report-plan/manager-weeks зник");
  assert.ok(/weekPlansForMonth\(/.test(body),
    "🔴 план тижня більше не береться з `weekPlansForMonth` (тобто зі `weekly_plan_snapshots`)");
  assert.ok(/snap\?\.plan/.test(body), "🔴 у відповідь іде не план зі знімка");
  // 🔴 Проста декомпозиція «план × робочі дні тижня ÷ робочі дні місяця» — це ЧЕТВЕРТЕ
  // означення тижневої цілі поруч із `effectiveWeekTargets` і переписування історії:
  // за минулі тижні воно показало б не те, що було заморожене в понеділок.
  assert.equal(/monthPlan\s*\*\s*\w+\s*\/|plan\s*\*\s*wd\w*\s*\//.test(body), false,
    "🔴 у роуті зʼявилась власна формула декомпозиції плану — знімок перестав бути джерелом");
  assert.ok(/reconstructed/.test(body) && /source/.test(body),
    "🔴 роут більше не віддає походження знімка — UI не зможе зізнатись, що план відновлено заднім числом");

  // 🔴 КОМЕНТАРІ ЗРІЗАЄМО ПЕРЕД ПЕРЕВІРКОЮ. Перша редакція цього гейта червоніла на
  // ВЛАСНІЙ прозі: у файлі стоїть пояснення, чому твердження «сума тижневих = місячний
  // план» неправдиве, і регулярка ловила саме його. Гейт, що читає джерело, мусить
  // відрізняти код від прози — той самий урок, що вже записаний у #79.
  const stripComments = (x: string) =>
    x.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const fe = stripComments(readFileSync(TABLE_TSX, "utf8"));
  // 🔴 ПЕРЕВІРЯЄМО ВИДИМИЙ ТЕКСТ, А НЕ `title`. Перша редакція шукала підрядок будь-де —
  // і лишалась зеленою, коли видимий підпис прибрали, бо та сама фраза стояла в
  // `title=""` (підказці на наведення). Тобто гейт стеріг те, чого людина не бачить.
  assert.ok(/>\s*знімок відновлено\s*</.test(fe),
    "🔴 з розкриття зник ВИДИМИЙ підпис «знімок відновлено» — реконструйоване число "
    + "читається як зафіксоване тоді (підказки в title недостатньо: її не видно)");
  assert.ok(/зафіксовано в понеділок/.test(fe), "🔴 зник підпис про заморожування плану");
  // Макетне твердження, яке НЕПРАВДИВЕ: динамічна ціль рахується від залишку, тож
  // Σ тижнів не зобовʼязана дорівнювати місяцю. Повернути його — значить збрехати.
  assert.equal(/сума тижневих[^\n]{0,40}місячн/i.test(fe), false,
    "🔴 повернулось твердження «сума тижневих = місячний план» — воно неправдиве для динамічної цілі");
});

// ─────────────────── #89 · час реакції: розріз == агрегат ───────────────────

test("#89 ЧАСТКА ПОВІЛЬНИХ == НЕЗАЛЕЖНОМУ ПІДРАХУНКУ НА ТОМУ САМОМУ СКОУПІ", needsDb(), async () => {
  const m = await import("../core/metrics.js");
  const { pool } = await import("../db/pool.js");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`, to = now.toISOString().slice(0, 10);

  const rows = await m.responseTimeByManager({ from, to });
  assert.ok(rows.length > 0,
    "🔴 розріз порожній — або вхідних лідів немає взагалі, або предикат зламався. "
    + "Порожній результат тут це ПРОВАЛ, а не «немає даних»");

  /**
   * 🔴 ЗВІРКА ЗОВНІШНЯ, А НЕ «A = A». Порівнювати розріз із самим собою (той самий
   * виклик, звужений до менеджера) означало б перевіряти, що функція детермінована,
   * — а не що вона рахує правильно. Тому очікуване значення рахується ТУТ, окремим
   * простим запитом: якщо в ядрі зсунути поріг «повільно», числа розійдуться.
   */
  const ctrl = await pool.query<{ manager_id: number; n: string; slow: string }>(
    `SELECT d.manager_id,
            COUNT(*) AS n,
            COUNT(*) FILTER (
              WHERE d.first_activity_at > d.created_at_kommo + interval '60 minutes') AS slow
       FROM deals d JOIN managers mm ON mm.id = d.manager_id AND mm.is_active
      WHERE d.pipeline_id = ANY($1) AND d.first_activity_at IS NOT NULL
        AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2
        AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $3
      GROUP BY d.manager_id`, [[8921928, 7336928], from, to]);
  const want = new Map(ctrl.rows.map((r) => [r.manager_id, { n: Number(r.n), slow: Number(r.slow) }]));

  // Найактивніші: у менеджера з одним лідом частка збіглася б випадково.
  const top = [...rows].sort((a, b) => b.n - a.n).slice(0, 5);
  assert.ok(top.some((r) => r.n >= 20),
    "🔴 у найактивнішого менеджера менше 20 лідів — вибірка замала, щоб гейт щось доводив");
  for (const r of top) {
    const w = want.get(r.managerId);
    assert.ok(w, `🔴 менеджер ${r.managerId} є в розрізі, але не в контрольному запиті`);
    assert.equal(r.n, w!.n, `🔴 менеджер ${r.managerId}: лідів ${r.n} проти ${w!.n} у контролі`);
    assert.equal(r.slow, w!.slow,
      `🔴 менеджер ${r.managerId}: повільних ${r.slow} проти ${w!.slow} у контролі — `
      + "поріг «повільно» в ядрі більше не 60 хвилин");
    assert.equal(r.pctSlow, Math.round((w!.slow / w!.n) * 1000) / 10,
      `🔴 менеджер ${r.managerId}: частка не дорівнює slow/n`);
  }

  // Дзеркало: сама метрика не вироджена — хоча б в одного менеджера повільні Є.
  // Інакше гейт лишався б зеленим і у світі, де фільтр не працює взагалі.
  assert.ok(rows.some((r) => r.slow > 0),
    "🔴 у ЖОДНОГО менеджера немає лідів, що чекали понад годину. Заміряно 19.08.2026: "
    + "185 із 1 076 лідів серпня (17%) саме такі, тож нуль тут означає зламаний фільтр");
});

test("#89b МЕНЕДЖЕР БЕЗ ЛІДІВ ВІДСУТНІЙ У ВИДАЧІ, А НЕ СТОЇТЬ ІЗ НУЛЕМ", needsDb(), async () => {
  const m = await import("../core/metrics.js");
  // Вигаданий id: лідів у нього бути не може за побудовою.
  const rows = await m.responseTimeByManager({ from: "2026-01-01", to: "2026-12-31", managerId: -424242 });
  assert.deepEqual(rows, [],
    "🔴 менеджеру без вхідних лідів домальовано рядок. Нуль відсотків тут читався б як "
    + "«жодного простроченого ліда», тобто приписав би заслугу там, де її нема з чого взяти");
});

// ─────────────────── #57c · smoke кліком по новому вигляду ───────────────────

test("#57c SMOKE: розкриття тижнів і час реакції відповідають ДАНИМИ", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = `${ym}-01`;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const rp = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${from}&to=${to}`, { headers: H });
  assert.equal(rp.status, 200, `🔴 /report-plan віддав ${rp.status}`);
  const body = await rp.json() as { managers: { managerId: number; name: string }[] };
  const mgrs = (body.managers ?? []).slice(0, 3);
  assert.ok(mgrs.length > 0, "🔴 у звіті нема жодного менеджера — розкривати нема кого");

  for (const mg of mgrs) {
    const r = await fetch(`${API_BASE}/api/dashboard/report-plan/manager-weeks?managerId=${mg.managerId}&month=${ym}`, { headers: H });
    assert.equal(r.status, 200, `🔴 manager-weeks для ${mg.name} віддав ${r.status}`);
    const w = await r.json() as { weeks: { from: string; plan: number; fact: number }[] };
    // 200 із порожнім тілом виглядав би так само зелено, як робоче розкриття.
    assert.ok(Array.isArray(w.weeks) && w.weeks.length >= 4,
      `🔴 у ${mg.name} розкриття повернуло ${w.weeks?.length ?? 0} тижнів — місяць не буває коротшим за 4 блоки`);
    assert.ok(w.weeks.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.from)), "🔴 межі тижнів не дати");
  }

  const rt = await fetch(`${API_BASE}/api/dashboard/response-time/by-manager?from=${from}&to=${to}`, { headers: H });
  assert.equal(rt.status, 200, `🔴 response-time/by-manager віддав ${rt.status}`);
  const rtb = await rt.json() as { managers: { managerId: number; count: number }[] };
  assert.ok((rtb.managers ?? []).length > 0,
    "🔴 розріз часу реакції порожній — колонка показуватиме «—» усім, тобто мовчки зникне");
});
