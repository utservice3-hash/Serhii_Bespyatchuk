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
