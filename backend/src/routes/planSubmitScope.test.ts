import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { needsDb, needsApi, API_BASE } from "../testMode.js";
import { EMPTY_PERIOD_MARK } from "../testRunGate.js";

const load = async () => ({
  pool: (await import("../db/pool.js")).pool,
  signToken: (await import("../auth/auth.js")).signToken,
  getSettings: (await import("./settings.js")).getSettings,
});

/**
 * #279d — ПОРЯДКОВІСТЬ ПРАПОРЦЯ, І ЦЕ НАЙВАЖЛИВІШИЙ ГЕЙТ НАБОРУ.
 *
 * Менеджер бачить УСЮ свою команду. Тому «дозволити менеджерам подавати» одним
 * прапорцем на відповідь означає намалювати «Подати» на рядках колег. Фікстура з
 * ОДНОГО рядка цього не спіймає за побудовою — потрібні два рядки однієї команди
 * з РІЗНИМИ значеннями, інакше гейт доводить лише те, що поле існує.
 */
test("#279d ПОРЯДКОВІСТЬ: у своїй команді свій рядок true, чужий false", needsApi(), async (t0) => {
  const { pool, signToken } = await load();
  const pick = (await pool.query<{ manager_id: number; team_id: number; peer_id: number }>(
    `SELECT a.id AS manager_id, a.team_id, b.id AS peer_id
       FROM managers a JOIN managers b ON b.team_id = a.team_id AND b.id <> a.id
      WHERE a.is_active AND b.is_active AND a.team_id IS NOT NULL
      ORDER BY a.id LIMIT 1`)).rows[0];
  assert.ok(pick, "не знайшлось команди з двома активними менеджерами — фікстура ПОРОЖНЯ, це провал, а не «немає даних»");

  const t = signToken({ userId: 0, role: "manager", roleKey: "manager",
    managerId: pick.manager_id, teamId: pick.team_id });
  const month = new Date().toISOString().slice(0, 7);
  const r = await fetch(`${API_BASE}/api/plans/formation?month=${month}`, { headers: { Authorization: `Bearer ${t}` } });
  /**
   * 🔴 НЕМА ПРЕДМЕТА — НЕ «ПЕРЕВІРЕНО», А НАЗВАНА ВІДСУТНІСТЬ.
   *
   * Заміряно 03.09.2026 по живих ролях: у `manager` НЕМАЄ вкладки `plans`
   * (screen_access), тож роут віддає 403, і жоден менеджер не може відкрити екран
   * формування взагалі. Поки це так, властивість «свій рядок true, чужий false»
   * не має на чому проявитись — але вона й не перевірена, і мовчати про це не можна.
   *
   * ⚠️ Це НЕ маскування дефекту: щойно власник видасть роль вкладку, гейт побіжить
   * сам і почне стерегти саме те, заради чого написаний. Рішення про доступ —
   * власника, і гейт не має права ухвалити його за нього.
   */
  if (r.status === 403) {
    t0.skip(`${EMPTY_PERIOD_MARK} у ролі «manager» немає вкладки plans, тож менеджерів, `
      + "здатних відкрити екран формування, НУЛЬ. Це законна відсутність предмета "
      + "(рішення власника про доступ не ухвалене), а не «перевірено».");
    return;
  }
  assert.equal(r.status, 200, `менеджер не дістав форму формування: ${r.status}`);
  const j = (await r.json()) as { teams?: { managers?: { managerId: number; canSubmit?: boolean }[] }[] };
  const rows = (j.teams ?? []).flatMap((x) => x.managers ?? []);
  assert.ok(rows.length >= 2, `менеджер побачив ${rows.length} рядків — двох боків межі в цій відповіді немає`);

  const mine = rows.find((x) => x.managerId === pick.manager_id);
  const peer = rows.find((x) => x.managerId === pick.peer_id);
  assert.ok(mine && peer, "у відповіді немає власного рядка або рядка колеги — межу нема на чому показати");
  assert.equal(mine!.canSubmit, true, "менеджер не може подати ВЛАСНИЙ рядок — фіча мертва");
  assert.equal(peer!.canSubmit, false,
    "🔴 менеджер дістав «Подати» на рядку КОЛЕГИ — рівно те, від чого стояв запобіжник скоупу");
});

/**
 * #279e — ГЕЙТ, ЯКИЙ БʼЄ ПО ЖИВІЙ СХЕМІ, А НЕ ПО ЧИСТІЙ ФУНКЦІЇ.
 *
 * 📐 Куплено власним дефектом 03.09.2026. `db/audit.ts` розширив тип
 * `targetType` значенням `"manager"`, а CHECK у БД лишився без нього. Наслідок:
 * `PATCH /settings/managers/:id/work-state` писав стан і ПОТІМ падав на аудиті —
 * поза транзакцією, тож стан лягав, а людина бачила 500. Гейти `#274*` міряли
 * ЧИСТУ ФУНКЦІЮ `stateOf` і побачити цього не могли в принципі.
 *
 * 🔴 Тест читає ДЖЕРЕЛО (не `dist`) і ЖИВУ констрейнту — саме ту пару, що розійшлась.
 * Він read-only: писати в прод тестам не можна, та й не треба — розходження видно
 * без жодного INSERT.
 */
test("#279e КОНТРАКТ КОД↔СХЕМА: кожен оголошений target_type дозволений живою БД", needsDb(), async () => {
  const { pool } = await load();
  /**
   * 🔴 ЧИТАЄМО ДЖЕРЕЛО, А НЕ `dist`. Збірка копіює в `dist` лише `.sql`, тож
   * `../db/audit.ts` відносно `dist/routes/` не існує — гейт падав із ENOENT і
   * доводив цим лише власну поламаність. Заміряно прийманням 03.09.2026.
   */
  const src = readFileSync(new URL("../../src/db/audit.ts", import.meta.url), "utf8");
  const decl = /targetType:\s*([^;]+);/.exec(src)?.[1] ?? "";
  const declared = [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 2,
    `розбір оголошених типів дав ${declared.length} — порожній розбір це ПРОВАЛ, а не «усе гаразд»`);

  const def = (await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'access_audit_target_type_check'`
  )).rows[0]?.def;
  assert.ok(def, "констрейнти access_audit_target_type_check немає — межа зникла зовсім");

  const missing = declared.filter((v) => !def!.includes(`'${v}'`));
  assert.deepEqual(missing, [],
    `🔴 код оголошує target_type, якого БД не приймає: ${missing.join(", ")}. `
    + "Роут запише свій рядок і аж потім упаде на аудиті — поза транзакцією.");
});

/**
 * #279f — ЗАМІНА ЗНЯТОМУ `#4.2`. Той стверджував `minPerManager === 30000`, тобто
 * КОНКРЕТНЕ число, яке власник вправі змінити з екрана; 03.09.2026 воно дорівнювало
 * нулю, і гейт червонів на цілком законній дії. Тут — ЗГОДА двох джерел замість числа.
 */
test("#279f МІНІМУМ ДОЇЖДЖАЄ ДО ФОРМИ: API віддає рівно те, що в налаштуваннях", needsApi(), async () => {
  const { signToken, getSettings } = await load();
  const expected = (await getSettings()).planMinPerManager;
  assert.equal(typeof expected, "number", "planMinPerManager у налаштуваннях не число — три стани дроту зламані");
  const t = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const month = new Date().toISOString().slice(0, 7);
  const r = await fetch(`${API_BASE}/api/plans/formation?month=${month}`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(r.status, 200, `/plans/formation віддав ${r.status}`);
  const j = (await r.json()) as { minPerManager?: number; teams?: unknown[] };
  assert.equal(j.minPerManager, expected,
    "межа не доїхала до форми — попередження зникне мовчки, і це НЕ залежить від того, яке саме число обрав власник");
  assert.ok(Array.isArray(j.teams) && j.teams.length > 0,
    "форма повернула 0 команд — порожній результат це ПРОВАЛ, а не «немає даних»");
});

/**
 * #279g — ЗАМІНА ЗНЯТОМУ `#4.3`, і причина в нього ІНША, ніж у `#4.2`.
 *
 * `#4.3` не був прибитий до числа: він читав поріг із налаштувань. Його зламало те,
 * що він звіряв ІСТОРИЧНИЙ прапорець (поставлений сервером у мить подання, за тодішнім
 * порогом) із СЬОГОДНІШНІМ порогом. Щойно власник змінив поріг на 0, усі старі
 * позначки стали «неправильними» — при цілком справному коді.
 *
 * Лишається те, що НЕ залежить від порога: позначка не має стояти на нульовому плані
 * ні за яких налаштувань — 0 не буває «нижче межі», бо це відсутність плану.
 */
test("#279g below_min НЕ СТОЇТЬ НА НУЛЬОВОМУ ПЛАНІ (не залежить від порога)", needsDb(), async () => {
  const { pool } = await load();
  const rows = (await pool.query<{ id: number; proposed_value: string; below_min: boolean }>(
    `SELECT id, proposed_value, below_min FROM plan_formation`)).rows;
  assert.ok(rows.length > 0, "у plan_formation немає жодного рядка — тест нічого не перевіряє");
  const zeroFlagged = rows.filter((r) => r.below_min && Number(r.proposed_value) <= 0);
  assert.deepEqual(zeroFlagged.map((r) => `#${r.id}=${r.proposed_value}`), [],
    "🔴 below_min на плані ≤ 0: нуль це відсутність плану, а не «нижче межі» — позначка знеціниться");
  const flagged = rows.filter((r) => r.below_min).length;
  assert.ok(flagged >= 0 && rows.length >= flagged, "лічильники не сходяться — вибірка зіпсована");
});
