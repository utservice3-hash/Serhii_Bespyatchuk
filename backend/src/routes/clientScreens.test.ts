import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * ГЕЙТИ ЕКРАНІВ КЛІЄНТІВ — те, що не видно з ядра, бо живе в роуті:
 *   #30  живий пошук клієнта (форми обʼєднання/передачі);
 *   #30c ієрархія «команда → менеджер → клієнти» — ПОДАЧА, не скоуп.
 *
 * Питання, на яке вони відповідають: чи можна тепер знайти клієнта, не знаючи
 * канонічного ключа напамʼять, і чи не загубився хтось, коли список згорнули в
 * дерево. Обидва — проти ЖИВОГО API: SQL пошуку в ядрі не живе, тож перевірити
 * його «з боку функції» неможливо.
 */
const load = async () => ({
  signToken: (await import("../auth/auth.js")).signToken,
  rbac: await import("../auth/rbac.js"),
});

async function adminToken(): Promise<string> {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  // Роль-скоуп беремо ТИМ САМИМ резолвером, що й решта тестів (`scopeCompatRole`),
  // а не зашитим рядком: інакше тест перевіряв би свою уяву про адміна.
  return signToken({ userId: 0, role: rbac.scopeCompatRole("admin", rbac.getRoleDef("admin")),
                     roleKey: "admin", managerId: null, teamId: null });
}
const get = async (path: string, token: string) =>
  fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });

test("#30 ПОШУК КЛІЄНТА: знаходить за НАЗВОЮ і за КЛЮЧЕМ — і це та сама людина", needsApi(), async () => {
  const token = await adminToken();
  // Шукаємо за шматком НАЗВИ, як шукала б людина: канонічний ключ («вкавтострада»)
  // з екрана дізнатись було нізвідки — саме через це формою не могли скористатись.
  const byName = await (await get("/api/dashboard/client-search?q=" + encodeURIComponent("автострада"), token)).json();
  assert.ok(Array.isArray(byName) && byName.length > 0,
    "🔴 пошук за назвою нічого не знайшов — перевіряти НЕМА ЧОГО, це провал, а не успіх");
  const hit = byName[0];
  assert.ok(hit.clientKey && hit.clientName, "рядок пошуку без ключа або назви");
  assert.ok("managerName" in hit,
    "🔴 у видачі немає менеджера — саме він і був суттю правки «менеджер біля кожного клієнта»");

  // А тепер за самим КЛЮЧЕМ — має знайтись той самий клієнт.
  const byKey = await (await get("/api/dashboard/client-search?q=" + encodeURIComponent(hit.clientKey), token)).json();
  assert.ok(byKey.some((h: { clientKey: string }) => h.clientKey === hit.clientKey),
    `🔴 за власним ключем «${hit.clientKey}» клієнт не знаходиться — пошук працює лише в один бік`);
});

test("#30b ДЗЕРКАЛО: пошук НЕ віддає всіх підряд", needsApi(), async () => {
  // Без цієї пари #30 зеленів би й тоді, якби роут повертав перші 20 клієнтів на
  // будь-який запит: «знайшлось» виглядало б однаково.
  const token = await adminToken();
  const junk = await (await get("/api/dashboard/client-search?q=zzzqqq__nemaje_takogo__", token)).json();
  assert.deepEqual(junk, [], "🔴 на сміттєвий запит повернулись клієнти — фільтр не застосовується");
  // Один символ — теж порожньо: інакше кожне натискання клавіші тягнуло б повний скан.
  const tooShort = await (await get("/api/dashboard/client-search?q=а", token)).json();
  assert.deepEqual(tooShort, [], "🔴 запит з однієї літери щось повернув — поріг довжини не діє");
});

test("#30c ІЄРАРХІЯ — ЦЕ ПОДАЧА: жоден клієнт не зник і не роздвоївся", needsApi(), async () => {
  // 🔴 Групування живе у фронті, але ГРУПУВАТИ НЕМА ЧИМ, якщо бекенд не назвав
  // команду. Перевіряємо саме те, на чому стоїть дерево: команда є в КОЖНОГО
  // рядка, і сума по командах дорівнює сумі плоского списку — до гривні.
  const token = await adminToken();
  const res = await get("/api/dashboard/client-plans", token);
  assert.equal(res.status, 200, `client-plans віддав ${res.status}`);
  const data = await res.json() as {
    clients: { clientKey: string; teamName: string; managerId: number; fact: number; plan: number }[];
    totals: { factTotal: number; totalClients: number };
  };
  assert.ok(data.clients.length > 0, "🔴 клієнтів немає — інваріант нічого не доводить");

  const noTeam = data.clients.filter((c) => !c.teamName);
  assert.deepEqual(noTeam.map((c) => c.clientKey), [],
    "🔴 є рядки без назви команди — у дереві вони провалились би в порожній вузол");

  const byTeam = new Map<string, number>();
  const keys = new Set<string>();
  for (const c of data.clients) {
    byTeam.set(c.teamName, (byTeam.get(c.teamName) ?? 0) + c.fact);
    keys.add(c.clientKey);
  }
  assert.equal(keys.size, data.clients.length,
    "🔴 клієнт трапляється двічі — у дереві він потрапив би у дві гілки й подвоїв підсумок");
  const sumTeams = [...byTeam.values()].reduce((s, v) => s + v, 0);
  const sumFlat = data.clients.reduce((s, c) => s + c.fact, 0);
  assert.equal(Math.round(sumTeams), Math.round(sumFlat),
    `🔴 Σ по командах ${Math.round(sumTeams)} ≠ Σ плоского списку ${Math.round(sumFlat)}`);
  assert.equal(data.totals.totalClients, data.clients.length,
    "🔴 підсумок «клієнтів» розійшовся з кількістю рядків");
});

test("#30d КАРТКА КЛІЄНТА віддає 12 місяців і НАЗИВАЄ анкер", needsApi(), async () => {
  const token = await adminToken();
  const list = await (await get("/api/dashboard/client-plans", token)).json() as {
    clients: { clientKey: string; fact: number }[];
  };
  const target = [...list.clients].sort((a, b) => b.fact - a.fact)[0];
  assert.ok(target, "🔴 немає жодного клієнта — перевірка порожня");
  const card = await (await get("/api/dashboard/client-card?clientKey=" + encodeURIComponent(target.clientKey), token)).json() as {
    months: { month: string; revenue: number }[]; deals: unknown[]; anchorNote: string; monthsTotal: number;
  };
  assert.equal(card.months.length, 12, `🔴 у картці ${card.months.length} місяців замість 12`);
  // 🔴 Підпис якоря — не косметика: без нього стовпчики ① і список угод (журнал
  // сутностей) читались би як одна сума, і «чому не сходиться» стало б багом.
  assert.ok(/анкер/i.test(card.anchorNote), "🔴 картка не називає анкер — дві різні суми без підпису");
  assert.equal(Math.round(card.monthsTotal), Math.round(card.months.reduce((s, m) => s + m.revenue, 0)),
    "🔴 підсумок 12 міс. не дорівнює сумі стовпчиків");
});

/**
 * Тімлід із РЕАЛЬНОЇ команди — беремо з БД, а не зашиваємо id: зашитий id
 * одного дня стане чужим/видаленим, і тест почне перевіряти порожнечу.
 */
async function someTeamLead(): Promise<{ token: string; teamId: number; teamName: string }> {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ team_id: number; name: string; n: string }>(
    `SELECT m.team_id, t.name, COUNT(*) AS n
       FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND m.team_id IS NOT NULL
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`);
  const row = r.rows[0];
  assert.ok(row, "🔴 у базі немає жодної команди з оплатами — скоуп-перевірці нема на чому працювати");
  return {
    token: signToken({ userId: 0, role: rbac.scopeCompatRole("team_lead", rbac.getRoleDef("team_lead")),
                       roleKey: "team_lead", managerId: null, teamId: row.team_id }),
    teamId: row.team_id, teamName: row.name,
  };
}

test("#30f СКОУП: тімлід у пошуку НЕ бачить чужу команду", needsApi(), async () => {
  // 🔴 Кламп мусить жити на СЕРВЕРІ. Фільтр у браузері не межа: той самий запит
  // curl-ом віддав би чужих клієнтів. Тому питаємо API напряму токеном тімліда.
  const lead = await someTeamLead();
  const { pool } = await import("../db/pool.js");
  const mine = await (await get("/api/dashboard/client-search?q=" + encodeURIComponent("ТОВ"), lead.token)).json() as
    { clientKey: string; managerName: string | null }[];
  assert.ok(Array.isArray(mine),
    `🔴 тімлід дістав не список: ${JSON.stringify(mine).slice(0, 120)}`);
  assert.ok(mine.length > 0,
    `🔴 тімлід команди «${lead.teamName}» не знайшов ЖОДНОГО клієнта — порожнеча доводить не межу, а поломку`);
  // Кожен знайдений клієнт мусить вести до менеджера ЦІЄЇ команди.
  const owners = await pool.query<{ name: string; team_id: number | null }>(
    `SELECT name, team_id FROM managers WHERE name = ANY($1)`,
    [mine.map((h) => h.managerName).filter(Boolean)]);
  const foreign = owners.rows.filter((o) => o.team_id !== lead.teamId).map((o) => o.name);
  assert.deepEqual(foreign, [],
    `🔴 у видачі тімліда команди «${lead.teamName}» є клієнти менеджерів з ІНШИХ команд: ${foreign.join(", ")}`);
});

test("#30g ДЗЕРКАЛО: адмін бачить те, чого не бачить тімлід", needsApi(), async () => {
  // Без цієї пари #30f зеленів би й тоді, якби пошук був зламаний для всіх:
  // «нічого чужого» і «нічого взагалі» ззовні виглядають однаково.
  const lead = await someTeamLead();
  const [asAdmin, asLead] = await Promise.all([
    (await get("/api/dashboard/client-search?q=" + encodeURIComponent("ТОВ"), await adminToken())).json(),
    (await get("/api/dashboard/client-search?q=" + encodeURIComponent("ТОВ"), lead.token)).json(),
  ]) as { clientKey: string }[][];
  const leadKeys = new Set(asLead.map((h) => h.clientKey));
  const onlyAdmin = asAdmin.filter((h) => !leadKeys.has(h.clientKey));
  assert.ok(onlyAdmin.length > 0,
    `🔴 адмін і тімлід бачать ОДНЕ Й ТЕ САМЕ (${asAdmin.length} рядків) — або кламп не діє, `
    + "або пошук віддає порожнечу обом");
});

/** Пара реальних клієнтів: один — команди тімліда, другий — ЧУЖОЇ. */
async function crossTeamPair(teamId: number): Promise<{ mine: string; foreign: string }> {
  const { pool } = await import("../db/pool.js");
  const pick = async (sameTeam: boolean) => (await pool.query<{ client_key: string }>(
    `SELECT d.client_key
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       JOIN managers m ON m.id = d.manager_id
      WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
        AND m.team_id IS ${sameTeam ? "NOT" : ""} DISTINCT FROM $1
        AND m.team_id IS NOT NULL
      GROUP BY d.client_key ORDER BY COUNT(*) DESC LIMIT 1`, [teamId])).rows[0]?.client_key;
  const [mine, foreign] = await Promise.all([pick(true), pick(false)]);
  assert.ok(mine && foreign, "🔴 не знайшлось пари «свій + чужий» — перевірці нема на чому працювати");
  return { mine: mine!, foreign: foreign! };
}

test("#30h СКОУП ЗЛИТТЯ: тімлід НЕ може злити пару, де один бік чужий", needsApi(), async () => {
  // 🔴 Проба РЕАЛЬНИМИ ключами, а не привидами: привид відхиляється з будь-якої
  // причини й нічого не доводить про КОМАНДУ. Запис при цьому неможливий двічі —
  // кламп віддає 403 до вставки, а прогін іде під роллю test_readonly.
  const lead = await someTeamLead();
  const { mine, foreign } = await crossTeamPair(lead.teamId);
  const body = JSON.stringify({ alias: foreign, canonical: mine, reason: "перевірка межі" });
  const res = await fetch(`${API_BASE}/api/dashboard/client-merge`, {
    method: "POST", headers: { Authorization: `Bearer ${lead.token}`, "Content-Type": "application/json" }, body,
  });
  assert.equal(res.status, 403,
    `🔴 тімлід команди «${lead.teamName}» зміг подати міжкомандне злиття (${foreign} → ${mine}): ${res.status}`);
  // Те саме для передпоказу: цифри чужої команди теж не віддаємо.
  const pre = await get(`/api/dashboard/client-merge/preview?alias=${encodeURIComponent(foreign)}`
    + `&canonical=${encodeURIComponent(mine)}`, lead.token);
  assert.equal(pre.status, 403, `🔴 передпоказ чужої пари віддав ${pre.status} — межа лише на кнопці`);
});

test("#30i ДЗЕРКАЛО: своя пара тімліду ДОСТУПНА, чужа — адміну", needsApi(), async () => {
  // Без цієї пари #30h зеленів би й тоді, якби роут відмовляв тімліду ЗАВЖДИ:
  // «не може чуже» і «не може нічого» ззовні виглядають однаково.
  const lead = await someTeamLead();
  const { mine, foreign } = await crossTeamPair(lead.teamId);
  const own = await get(`/api/dashboard/client-merge/preview?alias=${encodeURIComponent(mine)}`
    + `&canonical=${encodeURIComponent(mine)}`, lead.token);
  // Однакові ключі → 400 «Ключі однакові»: гейт пройдено, далі валідація. Саме це
  // й треба — 403 тут означав би, що тімлід не проходить межу навіть на СВОЇХ.
  assert.equal(own.status, 400,
    `🔴 тімлід не проходить межу на власному клієнті (${own.status}) — право видано лише на папері`);
  const asAdmin = await get(`/api/dashboard/client-merge/preview?alias=${encodeURIComponent(foreign)}`
    + `&canonical=${encodeURIComponent(mine)}`, await adminToken());
  assert.equal(asAdmin.status, 200,
    `🔴 адмін не може порахувати міжкомандну пару (${asAdmin.status}) — зламався не кламп, а сам передпоказ`);
});

test("#30j ГЕЙТ ПЕРЕД ВАЛІДАЦІЄЮ: порожнє тіло дає 403, а не 400", needsApi(), async () => {
  // 🔴 ЦЕ РЕГРЕСІЯ, ЯКУ ЗЛОВИЛА МАТРИЦЯ ПІСЛЯ ПЕРШОГО ВИКАТУ (04.08.2026, відкат
  // за процедурою). Перевірка «alias і canonical обовʼязкові» стояла ПЕРЕД
  // клампом, тож запит помирав на валідації й повертав 400 — доступу це не
  // відкривало, але ламало гарантію, на якій стоїть увесь зліпок #11: «403 у
  // deny-рядку означає, що спрацював гейт». Тепер тримаємо це окремим рядком, а
  // не лише матрицею: 1024 проби ганяють раз на реліз, а цей тест — щоразу.
  const lead = await someTeamLead();
  for (const p of ["/api/dashboard/client-merge", "/api/dashboard/client-merge/revoke"]) {
    const res = await fetch(`${API_BASE}${p}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${lead.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ __probe__: "невалідне тіло" }),
    });
    assert.equal(res.status, 403,
      `🔴 ${p} з порожнім тілом віддав ${res.status} — межа стоїть ПІСЛЯ валідації`);
  }
});

test("#30k РЕАКТИВАЦІЯ: команда в кожному рядку, ДВІ дати, пороги — з ЯДРА", needsApi(), async () => {
  // 🔴 Питання: чи можна побудувати ту саму ієрархію, що на екрані планів, і чи
  // підпис правила над списком каже те саме, що рахує ядро. Другий пункт —
  // окрема пастка: «60/180» легко зашити текстом, і підпис почне брехати мовчки,
  // щойно поріг у ядрі зрушить.
  const token = await adminToken();
  const res = await get("/api/dashboard/reactivation-list", token);
  assert.equal(res.status, 200, `reactivation-list віддав ${res.status}`);
  const data = await res.json() as {
    clients: { clientKey: string; teamName: string | null; managerId: number; state: string;
               lastPaid: string | null; daysSince: number; lastCall: string | null; lastCallDays: number | null }[];
    thresholds: { sleepingDays: number; lostDays: number };
  };
  assert.ok(data.clients.length > 0, "🔴 клієнтів немає — інваріант нічого не доводить");

  const rules = await import("../core/reactivationRules.js");
  assert.equal(data.thresholds.sleepingDays, rules.SLEEPING_DAYS,
    "🔴 поріг «сплячий» у відповіді розійшовся з ядром — підпис на екрані брехатиме");
  assert.equal(data.thresholds.lostDays, rules.LOST_DAYS,
    "🔴 поріг «втрачений» у відповіді розійшовся з ядром");

  assert.deepEqual(data.clients.filter((c) => !c.teamName).map((c) => c.clientKey), [],
    "🔴 є рядки без команди — у дереві вони провалились би в порожній вузол");
  const keys = new Set(data.clients.map((c) => c.clientKey));
  assert.equal(keys.size, data.clients.length,
    "🔴 клієнт трапляється двічі — у дереві він потрапив би у дві гілки й подвоїв підсумок");

  // 🔴 СТАН — ВІД ОПЛАТИ. Звіряємо КОЖЕН рядок із чистою функцією ядра, а не
  // «схоже на правду»: якби дзвінок почав впливати на стан, розійшлись би саме ті
  // рядки, де контакт свіжий, а оплати давно немає — тобто найцікавіші.
  const wrong = data.clients.filter((c) => c.state !== rules.stateOf(c.daysSince));
  assert.deepEqual(wrong.map((c) => `${c.clientKey}: ${c.state} при ${c.daysSince} дн.`), [],
    "🔴 стан рахується НЕ від останньої оплати");

  // Друга дата присутня як поле в кожного (значення може бути null — це відповідь).
  assert.ok(data.clients.every((c) => "lastCall" in c && "lastCallDays" in c),
    "🔴 у рядку немає полів останнього дзвінка — довідкова дата не доїхала до фронту");
  const withCall = data.clients.filter((c) => c.lastCall != null);
  assert.ok(withCall.length > 0,
    `🔴 ЖОДЕН із ${data.clients.length} клієнтів не має дзвінка — порожній результат це ПРОВАЛ, `
    + "а не «дзвінків немає»: звʼязка ringostat_calls.client_key не працює");
  assert.ok(withCall.every((c) => c.lastCallDays != null && c.lastCallDays >= 0),
    "🔴 є дата дзвінка без коректної кількості днів");
});

test("#30l КАРТКА: «прибрати з постійних» видно ТОМУ, кому роут це дозволяє", needsApi(), async () => {
  // 🪞 ДЗЕРКАЛЬНА ПАРА, і вона тут обовʼязкова. Односторонній тест («менеджер не
  // бачить кнопки») зеленів би й тоді, якби кнопки не бачив НІХТО — тобто саме в
  // стані, який ми щойно виправляли: дія без входу. Тому перевіряємо обидва боки
  // і звіряємо з тим самим гейтом, що стоїть на POST /loyalty-override.
  const token = await adminToken();
  const list = await (await get("/api/dashboard/client-plans", token)).json() as { clients: { clientKey: string }[] };
  const key = list.clients[0]?.clientKey;
  assert.ok(key, "🔴 немає жодного клієнта — перевірка порожня");

  const asAdmin = await (await get("/api/dashboard/client-card?clientKey=" + encodeURIComponent(key), token)).json() as
    { canHide?: boolean; hidden?: boolean };
  assert.equal(asAdmin.canHide, true,
    "🔴 адмін не бачить дії «прибрати з постійних» — вхід так і лишився втраченим");
  assert.equal(typeof asAdmin.hidden, "boolean",
    "🔴 картка не каже, чи клієнт уже прибраний — кнопка не знатиме, який бік показати");

  // Другий бік: тімлід картку бачить (вкладка `loyalty` в нього є), але права
  // прибирати з постійних не має — і сервер мусить сказати це сам, а не
  // покластись на те, що фронт «не намалює».
  const lead = await someTeamLead();
  const { pool } = await import("../db/pool.js");
  const own = (await pool.query<{ client_key: string }>(
    `SELECT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       JOIN managers m ON m.id = d.manager_id
      WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND m.team_id = $1
      GROUP BY d.client_key ORDER BY COUNT(*) DESC LIMIT 1`, [lead.teamId])).rows[0]?.client_key;
  assert.ok(own, "🔴 у команди тімліда немає клієнтів — дзеркало нема на чому перевіряти");
  const asLead = await (await get("/api/dashboard/client-card?clientKey=" + encodeURIComponent(own!), lead.token)).json() as
    { canHide?: boolean; months?: unknown[] };
  assert.equal(asLead.canHide, false,
    "🔴 тімлід бачить кнопку, яка на сервері дасть 403 — дозвіл і кнопка розійшлись");
  assert.ok(Array.isArray(asLead.months) && asLead.months.length === 12,
    "🔴 тімліду не віддалась сама картка — це вже не межа, а поломка екрана");
});

test("#30e МЕЖА: без токена екрани клієнтів не віддають нічого", needsApi(), async () => {
  // Дзеркало до #30/#30d: «доступно КВП/ОД/адміну» має означати «не всьому
  // інтернету». Матриця #11 перевіряє ролі, цей рядок — відсутність ролі взагалі.
  for (const p of ["/api/dashboard/client-search?q=автострада", "/api/dashboard/client-card?clientKey=zzz"]) {
    const res = await fetch(`${API_BASE}${p}`);
    assert.ok(res.status === 401 || res.status === 403,
      `🔴 ${p} без токена віддав ${res.status}`);
  }
});
