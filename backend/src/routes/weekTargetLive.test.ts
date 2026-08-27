import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * 🗓 #221–#221b — ЖИВІ ДАНІ ПЕРЕВІРЯЮТЬСЯ РІВНІСТЮ, А НЕ КІЛЬКІСТЮ.
 *
 * 🔴 ЩО БУЛО НЕ ТАК. `#56b` і `#61b` вимагали «≥3 ручних тижневих цілей ПРЯМО ЗАРАЗ».
 * Заміряно на бойовій базі 25.08.2026: 92.4% тижневих парасольок (85 із 92)
 * закінчуються В ПʼЯТНИЦЮ, а нові тімліди заводять щопонеділка о 08:44-09:24 — тобто
 * щосуботи, щонеділі й у понеділок до ~09:00 їх НУЛЬ. Реконструкція по днях за шість
 * тижнів дала цей візерунок без жодного винятку. Гейти були червоні ~30% часу не
 * через дефект, а через день тижня, і саме тому їх починали гортати очима.
 *
 * ✅ ЯК ТЕПЕР. Скільки тижневих парасольок покриває сьогодні в БАЗІ — стільки
 * менеджерів мусять мати `isManual` в API, з тим самим числом, і в кожного
 * `target == manual`. Порожнє покриття — це `skip` із НАЗВАНОЮ причиною, ніколи не
 * тихий pass: правило проєкту «порожній результат = провал» тут виконується тим, що
 * порожнеча оголошується вголос, а не читається як успіх.
 *
 * 🔴 МЕХАНІЗМ ЖИВЕ НЕ ТУТ. Підміну `manual ?? dynamic` ловлять `#220`-`#220c` на
 * scratch-БД із власною фікстурою — вони не залежать ні від дня тижня, ні від того,
 * чи встиг тімлід поставити ціль. Цей файл стереже ІНШЕ: що механізм доїжджає до
 * живого API на справжніх даних.
 */

/** Рядок БД: парасолька `period_kind='week'`, що покриває сьогодні. */
export interface WeekUmbrella { assigneeId: number; manual: number; periodStart: string; taskId: number }
/** Менеджер із відповіді `/report-plan`. */
export interface ApiManager {
  managerId: number; name: string;
  week: { target: number; manual: number | null; dynamic: number; isManual: boolean };
}
export type Decision =
  | { kind: "skip"; reason: string }
  | { kind: "check"; compared: { db: WeekUmbrella; api: ApiManager }[]; outOfRoster: number[] };

/**
 * Рішення «перевіряти чи чесно пропустити» — ОКРЕМА чиста функція, щоб обидва стани
 * даних можна було показати на приймальні, не чекаючи потрібного дня тижня.
 *
 * 🔴 ПОРІВНЮЮТЬСЯ ЛИШЕ ТІ, ХТО Є В ОБОХ. Парасолька може висіти на менеджері, якого
 * немає в ростері `/report-plan` (деактивований або без місячного плану — у `dyn` він
 * не потрапляє за побудовою). Вимагати рівності множин означало б червоніти на
 * законному стані. Але якщо в перетині НІКОГО — це вже не «порожньо», це «фільтр
 * зрізав усіх», і воно мусить впасти, а не проскочити.
 */
export function decideWeekTargetCheck(
  db: WeekUmbrella[], api: ApiManager[], todayIso: string, weekday: string
): Decision {
  if (db.length === 0) {
    return { kind: "skip", reason:
      `тижневих парасольок, що покривають ${todayIso} (${weekday}), у базі немає — `
      + "перевіряти нічого. Покриття рветься у ДВОХ місцях, і обидва законні: "
      + "тижневі задачі живуть Пн-Пт (вихідні порожні), і вони ж обриваються "
      + "на межі МІСЯЦЯ — заміряно 25.08.2026: 16 → 5 з 29.08 (period_end=31.08) "
      + "→ 0 з 01.09, аж поки тімліди не виставлять нові цілі. Це очікуваний "
      + "стан, а не дефект; механізм стережуть #220-#220c, яким день тижня байдужий." };
  }
  const byId = new Map(api.map((m) => [m.managerId, m]));
  const compared: { db: WeekUmbrella; api: ApiManager }[] = [];
  const outOfRoster: number[] = [];
  for (const row of pickEffectiveUmbrella(db)) {
    const m = byId.get(row.assigneeId);
    if (m) compared.push({ db: row, api: m }); else outOfRoster.push(row.assigneeId);
  }
  return { kind: "check", compared, outOfRoster };
}

/**
 * 🗓 ПРИ ПЕРЕКРИТТІ ЧИННА ОСТАННЯ ЗАВЕДЕНА ПАРАСОЛЬКА — рішення власника 27.08.2026.
 *
 * 🔴 ЦЕ ПРАВИЛО, А НЕ СОРТУВАННЯ ЗАРАДИ ЗРУЧНОСТІ. Тімлід може завести вужчу
 * парасольку поверх ширшої на спільні дні — це УТОЧНЕННЯ цілі, і чинним є
 * уточнення. Через місяць `ORDER BY period_start` унизу читатиметься як
 * випадковість, якщо не написати тут, що це рішення.
 *
 * 📐 ЖИВИЙ ВИПАДОК, НА ЯКОМУ ЦЕ ЗНАЙШЛОСЬ (27.08.2026, Пехньо Олександра):
 *     id 1890 · 24-28.08 · 8000
 *     id 2109 · 27-28.08 · 6000   ← заведена того ж дня
 * Обидві покривають 27.08. API брав ОСТАННЮ (6000) і був ПРАВИЙ; гейт брав усі
 * підряд і червонів на першій. Тобто відстав гейт, а не роут.
 *
 * 🔴 ГЕЙТ КОДУЄ ПРАВИЛО САМ І НЕ ПИТАЄ В API, ЯКА ПАРАСОЛЬКА ЧИННА. Перевірка,
 * що годується виходом перевіряного, зеленіє на зламаному писарі — це рівно та
 * пастка, через яку golden-master колись дав «403/403 → 0 розбіжностей».
 *
 * ⚠️ НЕОДНОЗНАЧНІСТЬ НЕ ЗНИКЛА, лише отримала правило читання: ніщо не заважає
 * завести ТРЕТЮ парасольку на ті самі дні. Це борг на боці Задачника, і він
 * названий окремо — тут ми домовились, ЯК читати, а не прибрали причину.
 *
 * Вхід уже впорядкований `period_start ASC, id ASC`, тож «остання» — це остання
 * зустрінута; сортування дублюємо явно, щоб правило не залежало від чужого ORDER BY.
 */
export function pickEffectiveUmbrella(db: WeekUmbrella[]): WeekUmbrella[] {
  // Сортуємо САМІ, а не покладаємось на `ORDER BY` виклику: інакше правило
  // жило б у чужому запиті, і зміна порядку там тихо змінила б сенс тут.
  const sorted = [...db].sort((a, b) =>
    a.periodStart === b.periodStart ? a.taskId - b.taskId : a.periodStart < b.periodStart ? -1 : 1);
  const byAssignee = new Map<number, WeekUmbrella>();
  for (const row of sorted) byAssignee.set(row.assigneeId, row);
  return [...byAssignee.values()];
}

/** Розбіжності «база проти екрана» — переліком, а не лічильником. */
export function weekTargetMismatches(compared: { db: WeekUmbrella; api: ApiManager }[]): string[] {
  const out: string[] = [];
  for (const { db, api } of compared) {
    const w = api.week;
    if (!w.isManual) out.push(`${api.name}: у базі ручна ціль ${db.manual}, а API каже isManual=false`);
    else if (Number(w.manual) !== Number(db.manual)) out.push(`${api.name}: API manual ${w.manual} ≠ база ${db.manual}`);
    else if (Number(w.target) !== Number(w.manual)) out.push(`${api.name}: target ${w.target} ≠ manual ${w.manual} — ручна ціль не перекриває`);
  }
  return out;
}

const WEEKDAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

/**
 * #221 — ЖИВІ ДАНІ: БАЗА І ЕКРАН КАЖУТЬ ОДНЕ.
 *
 * 🧨 САБОТАЖ (виконано в `#221b`, бо тут вхід приходить із прода): подати
 * компаратору відповідь, де в одного менеджера `target ≠ manual` — з'являється
 * розбіжність, і `skip` її НЕ ковтає.
 */
test("#221 ручна тижнева ціль доходить від бази до API — поіменно", needsApi(), async (t) => {
  const { pool } = await import("../db/pool.js");
  const { signToken } = await import("../auth/auth.js");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const weekday = WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];

  // Той самий предикат, що в `core/plans.effectiveWeekTargets` — тільки читання.
  const dbRows = (await pool.query<{ assignee_id: number; task_id: number; period_start: string; target: string }>(
    `SELECT t.assignee_id, t.id AS task_id,
            to_char(t.period_start, 'YYYY-MM-DD') AS period_start,
            (SELECT x->>'target' FROM jsonb_array_elements(t.metrics_json) x
              WHERE x->>'metric' = 'payment_amount' LIMIT 1) AS target
       FROM tasks t
      WHERE t.auto AND t.task_type = 'kpi_period' AND t.assignee_id IS NOT NULL
        AND t.metrics_json IS NOT NULL AND t.period_kind = 'week'
        AND t.period_start <= $1 AND COALESCE(t.period_end, t.period_start) >= $1
      ORDER BY t.period_start ASC, t.id ASC`, [today])).rows
    .filter((r) => r.target != null)
    .map((r) => ({ assigneeId: r.assignee_id, taskId: r.task_id, periodStart: r.period_start,
                   manual: Number(r.target) || 0 }));

  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const monthStart = today.slice(0, 7) + "-01";
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0))
    .toISOString().slice(0, 10);
  const r = await fetch(`${API_BASE}/api/dashboard/report-plan?from=${monthStart}&to=${monthEnd}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /report-plan віддав ${r.status}`);
  const api = ((await r.json()) as { managers: ApiManager[] }).managers ?? [];

  const d = decideWeekTargetCheck(dbRows, api, today, weekday);
  if (d.kind === "skip") return t.skip(d.reason);

  assert.ok(d.compared.length > 0,
    `🔴 у базі ${dbRows.length} тижневих цілей, а в ростері /report-plan — жодного з цих менеджерів. `
    + `Поза ростером: ${d.outOfRoster.join(", ")}. Саме це й означало б «фільтр зрізав їх усі».`);
  assert.deepEqual(weekTargetMismatches(d.compared), [],
    "🔴 ручна тижнева ціль не доходить від бази до екрана");
});

/**
 * #221b — ОБИДВА СТАНИ ДАНИХ ДАЮТЬ ПЕРЕДБАЧУВАНИЙ РЕЗУЛЬТАТ (і скіп нічого не ковтає).
 *
 * Тут же й доказ, якого вимагав власник на прийманні: при порожньому покритті —
 * `skip` із причиною, при зламаному вході — `check` І падіння.
 */
test("#221b порожнє покриття → skip із причиною; зламаний вхід → розбіжність", () => {
  const mk = (id: number, name: string, manual: number | null, target: number, dynamic = 30000): ApiManager =>
    ({ managerId: id, name, week: { target, manual, dynamic, isManual: manual != null } });

  // 1 · СТАН «ПАРАСОЛЬОК НЕМАЄ» — skip, і причина НАЗВАНА (день + чому так буває).
  const empty = decideWeekTargetCheck([], [mk(1, "А", null, 30000)], "2026-08-29", "субота");
  assert.equal(empty.kind, "skip");
  assert.match(empty.reason, /2026-08-29/);
  assert.match(empty.reason, /субота/);
  assert.match(empty.reason, /Пн-Пт|понеділка/, "🔴 причина не пояснює, ЧОМУ порожньо — це знову тиха порожнеча");
  // 🔴 ДРУГА ПРИЧИНА МУСИТЬ БУТИ НАЗВАНА ТЕЖ. Заміряно 25.08.2026: покриття 16 → 5 з
  //    29.08 → 0 з 01.09, тобто найближча порожнеча настане у ВІВТОРОК, а не у вихідні.
  //    Причина, що згадує лише «Пн-Пт», у цей день читалась би як опис ДЕФЕКТУ.
  assert.match(empty.reason, /МІСЯЦ|місяц/, "🔴 причина мовчить про межу місяця — на 01.09 вона вводитиме в оману");
  assert.match(empty.reason, /#220/, "🔴 причина не каже, ХТО тепер стереже механізм — читач вирішить, що не стереже ніхто");

  // 2 · СТАН «ПАРАСОЛЬКИ Є» — перевіряємо, а не скіпаємо.
  const u = (assigneeId: number, manual: number, periodStart = "2026-08-24", taskId = assigneeId): WeekUmbrella =>
    ({ assigneeId, manual, periodStart, taskId });
  const db = [u(1, 15000), u(2, 7000)];
  const good = decideWeekTargetCheck(db, [mk(1, "А", 15000, 15000), mk(2, "Б", 7000, 7000)], "2026-08-25", "вівторок");
  assert.equal(good.kind, "check");
  if (good.kind !== "check") return;
  assert.equal(good.compared.length, 2, "🔴 порівняно не всіх — гейт вироджений");
  assert.deepEqual(weekTargetMismatches(good.compared), []);

  // 3 · 🧨 ЗЛАМАНИЙ ВХІД: ручна ціль перестала перекривати (`manual ?? dynamic → dynamic`).
  //     Мусить бути САМЕ `check` і САМЕ розбіжність — інакше skip ковтав би дефект.
  const broken = decideWeekTargetCheck(db, [mk(1, "А", 15000, 30000), mk(2, "Б", 7000, 7000)], "2026-08-25", "вівторок");
  assert.equal(broken.kind, "check", "🔴 зламаний стан прочитано як «нічого перевіряти»");
  if (broken.kind !== "check") return;
  const bad = weekTargetMismatches(broken.compared);
  assert.equal(bad.length, 1, `🔴 розбіжність не помічена: ${JSON.stringify(bad)}`);
  assert.match(bad[0], /не перекриває/);

  // 4 · Ще два способи зламати: API забув позначку і API дає інше число.
  const badCount = (api: ApiManager[]): number => {
    const d = decideWeekTargetCheck(db, api, "2026-08-25", "вівторок");
    return d.kind === "check" ? weekTargetMismatches(d.compared).length : -1;
  };
  assert.equal(badCount([mk(1, "А", null, 30000), mk(2, "Б", 7000, 7000)]), 1,
    "🔴 зникла позначка isManual не помічена");
  // 5 · 🗓 ПЕРЕКРИТТЯ ПАРАСОЛЬОК: чинна ОСТАННЯ (рішення власника 27.08.2026).
  //     Живий випадок: Пехньо, 1890 (24-28.08, 8000) проти 2109 (27-28.08, 6000).
  //     Гейт мусить брати 6000 — і, головне, ЧЕРВОНІТИ, якщо API віддасть 8000.
  const overlap = [u(1, 8000, "2026-08-24", 1890), u(1, 6000, "2026-08-27", 2109)];
  const eff = pickEffectiveUmbrella(overlap);
  assert.equal(eff.length, 1, "🔴 дві парасольки одного менеджера дали дві пари — правило не застосоване");
  assert.equal(eff[0].manual, 6000, "🔴 чинною визнано НЕ останню — це протилежне рішенню власника");
  // 🪞 ДЗЕРКАЛО, БЕЗ ЯКОГО ЦЕ БУЛО Б ПІДГАНЯННЯМ ПІД СЬОГОДНІШНЮ ВІДПОВІДЬ:
  //     API, що віддає СТАРУ парасольку, мусить дати розбіжність.
  const okNew = decideWeekTargetCheck(overlap, [mk(1, "Пехньо", 6000, 6000)], "2026-08-27", "четвер");
  assert.equal(okNew.kind, "check");
  if (okNew.kind !== "check") return;
  assert.deepEqual(weekTargetMismatches(okNew.compared), [],
    "🔴 API з ОСТАННЬОЮ парасолькою визнано розбіжністю — гейт вимагає неправильного");
  const oldOne = decideWeekTargetCheck(overlap, [mk(1, "Пехньо", 8000, 8000)], "2026-08-27", "четвер");
  assert.equal(oldOne.kind, "check");
  if (oldOne.kind !== "check") return;
  assert.equal(weekTargetMismatches(oldOne.compared).length, 1,
    "🔴 API, що віддає СТАРУ парасольку, пройшов — гейт перестав бути оракулом і став дзеркалом");
  // 🔴 І порядок у вході не має значення: правило сортує САМЕ, а не довіряє ORDER BY.
  assert.equal(pickEffectiveUmbrella([...overlap].reverse())[0].manual, 6000,
    "🔴 результат залежить від порядку рядків — тоді правило живе в чужому запиті, а не тут");

  assert.equal(badCount([mk(1, "А", 12345, 12345), mk(2, "Б", 7000, 7000)]), 1,
    "🔴 інше число в API не помічене");

  // 5 · 🔴 ПЕРЕТИН ПОРОЖНІЙ — це НЕ «порожньо», це «зрізало всіх»: рішення `check`,
  //     і сам гейт впаде на `compared.length > 0`.
  const noRoster = decideWeekTargetCheck(db, [mk(9, "Чужий", null, 1)], "2026-08-25", "вівторок");
  assert.equal(noRoster.kind, "check");
  if (noRoster.kind !== "check") return;
  assert.equal(noRoster.compared.length, 0);
  assert.deepEqual(noRoster.outOfRoster, [1, 2]);
});
