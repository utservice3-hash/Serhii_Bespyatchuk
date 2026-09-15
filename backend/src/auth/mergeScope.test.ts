import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePairAllowed, mergeDenyReason } from "./mergeScope.js";

/**
 * #31 — ПРАВО ТІМЛІДА ЗЛИВАТИ КЛІЄНТІВ У МЕЖАХ СВОЄЇ КОМАНДИ.
 *
 * 🔴 Ці перевірки НЕ ходять у мережу й не потребують БД — навмисно. Рішення про
 * доступ мусить бути доказовним у кожному `npm test`, а не лише в прод-прогоні:
 * інакше єдиний спосіб довести, що тест справді ловить (саботаж), вимагав би
 * другого живого сервера — а його цей хостинг убиває по памʼяті (заміряно
 * 04.08.2026: SIGKILL за ~40 с). Наскрізну поведінку доводять #30h/#30i.
 */
const LEAD = 5, OTHER = 9;

test("#31 ТІМЛІД ЗЛИВАЄ ЛИШЕ СВОЇХ: обидва боки його команди", () => {
  const lead = (aliasTeamId: number | null, canonicalTeamId: number | null) =>
    mergePairAllowed({ canAll: false, leadTeamId: LEAD, aliasTeamId, canonicalTeamId });
  assert.equal(lead(LEAD, LEAD), true, "🔴 своя пара має зливатись — інакше право видано на папері");
  assert.equal(lead(OTHER, LEAD), false, "🔴 чужий ПСЕВДОНІМ пройшов кламп");
  assert.equal(lead(LEAD, OTHER), false, "🔴 чужий ОСНОВНИЙ пройшов кламп");
  assert.equal(lead(OTHER, OTHER), false, "🔴 повністю чужа пара пройшла кламп");
  // 🔴 Невідома команда — ЗАБОРОНА, а не «мабуть, своя». Невизначений бік у
  // реєстрі псевдонімів коштує ручного відкоту, тож дефолт тут закритий.
  assert.equal(lead(null, LEAD), false, "🔴 невідома команда псевдоніма прийнята за свою");
  assert.equal(lead(LEAD, null), false, "🔴 невідома команда основного прийнята за свою");
});

test("#31b ДЗЕРКАЛО: право merge_clients і далі зливає МІЖ командами", () => {
  // Без цієї пари #31 зеленів би й тоді, якби кламп заблокував геть усіх —
  // «тімлід не може чуже» і «ніхто не може нічого» ззовні виглядають однаково.
  assert.equal(mergePairAllowed({ canAll: true, leadTeamId: null, aliasTeamId: OTHER, canonicalTeamId: LEAD }), true,
    "🔴 КВП/ОД/адмін втратили міжкомандне обʼєднання — це вже не звуження, а поломка");
  assert.equal(mergePairAllowed({ canAll: true, leadTeamId: null, aliasTeamId: null, canonicalTeamId: null }), true,
    "🔴 право merge_clients залежить від того, чи визначилась команда — воно не має від неї залежати");
  // І навпаки: без права і без команди — відмова (звичайний менеджер, HR).
  assert.equal(mergePairAllowed({ canAll: false, leadTeamId: null, aliasTeamId: LEAD, canonicalTeamId: LEAD }), false,
    "🔴 роль без права й без команди зливає клієнтів");
});

test("#31c ВІДМОВА НАЗИВАЄ, ЩО САМЕ ПОЗА МЕЖЕЮ", () => {
  // Голий 403 змушує вгадувати, який із двох боків чужий, — а вгадування тут
  // коштує зайвого звернення до КВП.
  const r = (a: number | null, c: number | null) =>
    mergeDenyReason({ canAll: false, leadTeamId: LEAD, aliasTeamId: a, canonicalTeamId: c });
  assert.match(r(OTHER, LEAD), /приєднують/, "не сказано, що чужий саме псевдонім");
  assert.match(r(LEAD, OTHER), /основний/, "не сказано, що чужий саме основний");
  assert.match(r(OTHER, OTHER), /приєднують і основний/, "не сказано, що чужі обидва");
  assert.match(mergeDenyReason({ canAll: false, leadTeamId: null, aliasTeamId: null, canonicalTeamId: null }),
    /КВП/, "ролі без команди не сказано, до кого йти");
});

/**
 * #413 — ТІМЛІД ПЕРЕДАЄ КЛІЄНТА ЛИШЕ В МЕЖАХ СВОЄЇ КОМАНДИ: клієнт його команди →
 * менеджеру його команди. Чужий клієнт або чужий менеджер — відмова з названою
 * причиною; невідома команда (`null`) — теж відмова. Червоніє, якщо прибрати будь-яку
 * з двох рівностей або трактувати `null` як «своя».
 */
test("#413 ТІМЛІД ПЕРЕДАЄ ЛИШЕ СВОЇХ СВОЇМ: клієнт і новий менеджер — його команда", async () => {
  const { assignAllowed, assignDenyReason } = await import("./mergeScope.js");
  const lead = { canAll: false, leadTeamId: 7 };
  assert.equal(assignAllowed({ ...lead, clientTeamId: 7, targetTeamId: 7 }), true, "свій → своєму мусить проходити");
  assert.equal(assignAllowed({ ...lead, clientTeamId: 7, targetTeamId: 9 }), false, "свій → чужому");
  assert.equal(assignAllowed({ ...lead, clientTeamId: 9, targetTeamId: 7 }), false, "чужий → своєму");
  assert.equal(assignAllowed({ ...lead, clientTeamId: null, targetTeamId: 7 }), false, "невідома команда клієнта = заборона");
  assert.equal(assignAllowed({ ...lead, clientTeamId: 7, targetTeamId: null }), false, "невідома команда менеджера = заборона");
  assert.match(assignDenyReason({ ...lead, clientTeamId: 9, targetTeamId: 7 }), /клієнт/);
  assert.match(assignDenyReason({ ...lead, clientTeamId: 7, targetTeamId: 9 }), /новий менеджер/);
  assert.doesNotMatch(assignDenyReason({ ...lead, clientTeamId: 9, targetTeamId: 7 }), /новий менеджер/, "причина називає лише те, що справді поза межею");
});

/**
 * #413b 🪞 — ПРАВО `merge_clients` і далі передає МІЖ командами, а не-тімлід без права —
 * ні. Без дзеркала правило «лише своїх» можна було б виконати, заборонивши всім.
 */
test("#413b ДЗЕРКАЛО: merge_clients передає між командами; без права й без команди — ні", async () => {
  const { assignAllowed, assignDenyReason } = await import("./mergeScope.js");
  assert.equal(assignAllowed({ canAll: true, leadTeamId: null, clientTeamId: 3, targetTeamId: 9 }), true);
  assert.equal(assignAllowed({ canAll: true, leadTeamId: null, clientTeamId: null, targetTeamId: null }), true, "з правом команди не питаємо");
  assert.equal(assignAllowed({ canAll: false, leadTeamId: null, clientTeamId: 7, targetTeamId: 7 }), false, "менеджер без команди тімліда — ні");
  assert.match(assignDenyReason({ canAll: false, leadTeamId: null, clientTeamId: 7, targetTeamId: 7 }), /КВП/);
});

/**
 * #413c — РОУТ СПРАВДІ КЛИЧЕ ПРЕДИКАТ, а не лише експортує його: у `POST /client-manager`
 * немає `requirePerm("merge_clients")` (він відсік би тімліда до будь-якої перевірки),
 * є виклик `assignAllowed(` і відповідь `assignDenyReason(`. Читає джерело, межа слова.
 * Червоніє, якщо повернути `requirePerm` на роут або прибрати виклик предиката.
 */
test("#413c РОУТ /client-manager кличе assignAllowed і не сидить за requirePerm(merge_clients)", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "routes", "dashboard.ts"), "utf8");
  const start = src.indexOf('dashboardRouter.post("/client-manager"');
  assert.ok(start > 0, "роут не знайдено");
  const end = src.indexOf("\n});", start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body.split("\n")[0], /requirePerm\(/, "requirePerm на роуті відсікає тімліда до перевірки команди");
  assert.match(body, /\bassignAllowed\(/, "предикат не викликається");
  assert.match(body, /\bassignDenyReason\(/, "причина відмови не віддається");
  assert.match(body, /\bclientOwnerTeam\(clientKey\)/, "команда клієнта рахується не по клієнту");
});
