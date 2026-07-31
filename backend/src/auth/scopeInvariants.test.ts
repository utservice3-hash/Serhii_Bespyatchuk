import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * #18 — СКОУП-ІНВАРІАНТИ. Ворота проти того, що матриця доступу пропускає за побудовою.
 *
 * 🔴 НАВІЩО. `#11` міряє КОДИ ВІДПОВІДЕЙ, а не ВМІСТ. Коли HR отримав company-scope,
 * жодна з 436 клітинок не зрушила — і це було правдою: HR як віддавав 200, так і
 * віддає, просто тепер із даними замість порожнечі. Тобто розширення ОБСЯГУ даних
 * матриця не бачить у принципі.
 *
 * 🔑 ЧОМУ ВІДНОШЕННЯ, А НЕ ЧИСЛА. Зафіксувати «менеджер бачить 42 рядки» означало б
 * червоніти щоразу, коли міняються дані — тобто щодня. Такий тест за тиждень вимкнули б.
 * Відношення («менеджер ⊆ тімлід ⊆ адмін») переживає будь-яку зміну даних і ламається
 * рівно тоді, коли комусь РОЗШИРИЛИ скоуп.
 *
 * Порожній результат = ПРОВАЛ: якщо адмін не бачить нічого, підмножина тривіальна й
 * тест нічого не доводить.
 */

const load = async () => ({
  rbac: await import("./rbac.js"),
  signToken: (await import("./auth.js")).signToken,
});

/** Ендпоінти, де видно рядки з ідентифікаторами — на них і міряємо обсяг. */
const PERIOD = "from=2026-07-01&to=2026-07-31";

/**
 * Ендпоінти, де видно РЯДКИ З ІДЕНТИФІКАТОРАМИ — на них і міряємо обсяг.
 *
 * ⚠️ `/managers` вимагає `teamId`, і саме це робить його найкращим зразком: питаємо
 * ЧУЖУ команду. Адмін має побачити її склад, тімлід іншої команди — ні. Якщо колись
 * scope-кламп зникне, коди відповідей не зміняться (обидва 200), а обсяг — так.
 */
// РЕАЛЬНА чужа команда (список: 6,5,15,13,14,36283,11; у токені тімліда — 5).
// ⚠️ Спершу тут стояла неіснуюча 9 — адмін бачив 0 рядків, і тест падав на власній
// умові «порожній результат = провал». Правильно, але не про те: перевіряти треба
// на команді, яка існує.
const OTHER_TEAM = 6;
const SCOPED: { path: string; pick: (j: unknown) => string[]; note: string }[] = [
  {
    path: `/api/dashboard/teams?${PERIOD}`,
    note: "рейтинг команд — тімлід бачить рейтинг цілком (це рейтинг), менеджер не має вкладки",
    pick: (j) => ((j as { teams?: { teamId?: number }[] }).teams ?? []).map((t) => String(t.teamId)),
  },
];

/**
 * Склад ЧУЖОЇ команди — окремий інваріант (#18a), а НЕ підмножина.
 *
 * 🔑 Чому не підмножина: на запит `teamId=6` адмін бачить склад команди 6, а тімлід
 * команди 5 — свій власний (кламп ігнорує параметр). Це різні множини, і «⊆» тут
 * хибне за формою. Правильне твердження: перетин ПОРОЖНІЙ — тімлід не побачив
 * жодного менеджера чужої команди.
 */
const OTHER_TEAM_PATH = `/api/dashboard/managers?teamId=${OTHER_TEAM}&${PERIOD}`;
const pickManagers = (j: unknown) =>
  ((j as { managers?: { id?: number }[] }).managers ?? []).map((m) => String(m.id));

async function idsWith(role: string, path: string, pick: (j: unknown) => string[]): Promise<string[] | null> {
  const { rbac, signToken } = await load();
  const t = signToken({
    userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)), roleKey: role,
    managerId: role === "manager" ? 8 : null, teamId: role === "team_lead" ? 5 : null,
  });
  const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  if (r.status !== 200) return null;
  return pick(await r.json()).filter((x) => x && x !== "undefined");
}

test("#18 ІНВАРІАНТ: менеджер ⊆ тімлід ⊆ адмін (обсяг, а не коди)", needsApi(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  const problems: string[] = [];
  let checked = 0;

  for (const ep of SCOPED) {
    const admin = await idsWith("admin", ep.path, ep.pick);
    const lead = await idsWith("team_lead", ep.path, ep.pick);
    const mgr = await idsWith("manager", ep.path, ep.pick);
    assert.ok(admin, `${ep.path}: адмін не отримав 200 — інваріант нема з чим звіряти`);
    assert.ok(admin.length > 0,
      `${ep.path}: адмін бачить 0 рядків — підмножина тривіальна, тест нічого не доводить`);
    checked++;

    // Підмножина, НЕ строга: рівність законна (рейтинг команд однаковий для всіх, кому
    // він відкритий). Ламається рівно тоді, коли нижча роль бачить ЩОСЬ ПОЗА обсягом вищої.
    const A = new Set(admin);
    if (lead) {
      const outside = lead.filter((x) => !A.has(x));
      if (outside.length) problems.push(`${ep.path}: тімлід бачить поза адмінським обсягом: ${outside.slice(0, 5)}`);
    }
    if (mgr) {
      const L = new Set(lead ?? admin);
      const outside = mgr.filter((x) => !L.has(x));
      if (outside.length) problems.push(`${ep.path}: менеджер бачить поза обсягом тімліда: ${outside.slice(0, 5)}`);
    }
  }

  assert.ok(checked > 0, "жодного ендпоінта не перевірено — тест порожній");
  assert.deepEqual(problems, [],
    "🔴 СКОУП РОЗІЙШОВСЯ. Коди відповідей могли не змінитись — саме тому ці ворота й "
    + "існують окремо від #11:\n  " + problems.join("\n  "));
});

test("#18a ІНВАРІАНТ: тімлід НЕ бачить складу чужої команди", needsApi(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  // Найгостріша форма: адмін і тімлід питають ОДНЕ Й ТЕ САМЕ — склад команди 6.
  // Обидва отримують 200, тож #11 тут сліпа за побудовою. Різниця лише в ОБСЯЗІ.
  const admin = await idsWith("admin", OTHER_TEAM_PATH, pickManagers);
  const lead = await idsWith("team_lead", OTHER_TEAM_PATH, pickManagers);
  assert.ok(admin && admin.length > 0,
    `адмін не побачив складу команди ${OTHER_TEAM} — нема з чим звіряти (порожній результат = провал)`);
  if (lead === null) return;                       // 403 — питання зняте
  const A = new Set(admin);
  const leaked = lead.filter((x) => A.has(x));
  assert.deepEqual(leaked, [],
    `🔴 тімлід команди 5 отримав ${leaked.length} менеджерів команди ${OTHER_TEAM} — `
    + "scope-кламп не спрацював, а коди відповідей однакові (200/200)");
});

test("#18b ІНВАРІАНТ: роль БЕЗ екрана не бачить звідти жодного рядка", needsApi(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  // HR не має вкладок «managers»/«teams». Це не про код відповіді (він 403), а про
  // твердження «нуль рядків» — те, що лишиться правильним, навіть якщо гейт колись
  // почне віддавати 200 з порожнім тілом.
  const problems: string[] = [];
  for (const ep of SCOPED) {
    const tab = ep.path.includes("managers") ? "managers" : "teams";
    assert.equal(rbac.roleHasTab("hr", tab), false, `тест припускає, що HR не має «${tab}»`);
    const got = await idsWith("hr", ep.path, ep.pick);
    if (got && got.length > 0) problems.push(`${ep.path}: HR бачить ${got.length} рядків без вкладки «${tab}»`);
  }
  assert.deepEqual(problems, [],
    "🔴 роль без екрана отримала рядки звідти:\n  " + problems.join("\n  "));
});

test("#18c ДЗЕРКАЛО: інваріант ВМІЄ впасти (перевіряємо на підробленому обсязі)", () => {
  // Без цієї пари #18 зеленів би й тоді, коли порівняння порожнє з обох боків —
  // «підмножина» тривіально виконується, і ворота перетворюються на прикрасу.
  const subsetOk = (sub: string[], sup: string[]) => sub.every((x) => new Set(sup).has(x));
  assert.equal(subsetOk(["1", "2"], ["1", "2", "3"]), true, "детектор не бачить коректної підмножини");
  assert.equal(subsetOk(["1", "9"], ["1", "2", "3"]), false,
    "🔴 детектор вважає підмножиною те, що нею не є — #18 зеленів би при розширенні скоупу");
});
