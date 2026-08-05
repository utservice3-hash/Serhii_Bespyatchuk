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
               segment: "vip" | "regular" | "episodic" | "unknown";
               lastPaid: string | null; daysSince: number; lastTalk: string | null; lastTalkDays: number | null }[];
    thresholds: { sleepingDays: number; lostDays: number;
                  bySegment: Record<string, number>; longLapsedDays: number; segmentMinPayments: number };
  };
  assert.ok(data.clients.length > 0, "🔴 клієнтів немає — інваріант нічого не доводить");

  const rules = await import("../core/reactivationRules.js");
  assert.equal(data.thresholds.sleepingDays, rules.SLEEPING_DAYS,
    "🔴 поріг «сплячий» у відповіді розійшовся з ядром — підпис на екрані брехатиме");
  assert.equal(data.thresholds.lostDays, rules.LOST_DAYS,
    "🔴 поріг «втрачений» у відповіді розійшовся з ядром");

  // 🔴 ТУТ БУЛА ПОМИЛКА В САМОМУ ТЕСТІ, і прод її спіймав на першому ж прогоні.
  // Спершу вимагалось «жодного рядка без команди» — переписано з #30c для екрана
  // планів. Але на реактивації це НЕПРАВДА за даними, а не за багом: 34 клієнти
  // ведуться «Операційним директором» (371 клієнт з оплатами), який СВІДОМО не
  // входить у жодну команду. Їхні угоди давні, тому вони спливають саме тут, а не
  // в планах. Екран це вже вміє — вузол «Без команди»; вимагати нуля означало б
  // підганяти дані під тест.
  //
  // Тому перевіряємо ІНВАРІАНТ ІЄРАРХІЇ, який справді має триматись: групування —
  // це ПОДАЧА, тож жоден клієнт не зник і не роздвоївся. Безкомандних НЕ ховаємо,
  // а НАЗИВАЄМО: тихий нуль тут виглядав би як «таких немає».
  const noTeam = data.clients.filter((c) => !c.teamName);
  console.log(`   ℹ без команди: ${noTeam.length} із ${data.clients.length} — вузол «Без команди»`);
  const keys = new Set(data.clients.map((c) => c.clientKey));
  assert.equal(keys.size, data.clients.length,
    "🔴 клієнт трапляється двічі — у дереві він потрапив би у дві гілки й подвоїв підсумок");
  const byTeam = new Map<string, number>();
  for (const c of data.clients) {
    const k = c.teamName ?? "Без команди";
    byTeam.set(k, (byTeam.get(k) ?? 0) + 1);
  }
  assert.equal([...byTeam.values()].reduce((s, v) => s + v, 0), data.clients.length,
    "🔴 Σ по вузлах дерева ≠ плоскому списку — хтось загубився при групуванні");
  assert.ok(data.clients.every((c) => c.managerId > 0),
    "🔴 рядок без менеджера — у дереві він не має куди лягти навіть у «Без команди»");

  // 🔴 ПОРОГИ ПО СЕГМЕНТАХ — теж із ЯДРА. Без цього підпис «⚡ ВІП 14+ днів» на
  // екрані став би другою редакцією правила і почав би брехати мовчки, щойно
  // поріг у `reactivationRules.ts` зрушить.
  assert.deepEqual(data.thresholds.bySegment, rules.SEGMENT_SLEEPING_DAYS,
    "🔴 пороги по сегментах у відповіді розійшлись із ядром");
  assert.equal(data.thresholds.longLapsedDays, rules.LONG_LAPSED_DAYS);
  assert.equal(data.thresholds.segmentMinPayments, rules.SEGMENT_MIN_PAYMENTS);

  // 🔴 СТАН — ВІД ОПЛАТИ І ВІД СЕГМЕНТА. Звіряємо КОЖЕН рядок із чистою функцією
  // ядра, а не «схоже на правду»: якби дзвінок почав впливати на стан, розійшлись
  // би саме ті рядки, де контакт свіжий, а оплати давно немає — тобто найцікавіші.
  //
  // ⚠️ АРГУМЕНТ `segment` ТУТ ОБОВʼЯЗКОВИЙ. Виклик `stateOf(daysSince)` без нього
  // перевіряв би СТАРЕ правило (єдиний поріг 60) — і саме на цьому тест червонів у
  // хвилі 1: правило стало сегментним, а гейт лишився з попередньою сигнатурою.
  // Заміряно на проді: 38 рядків із 842 розходились.
  const wrong = data.clients.filter((c) => c.state !== rules.stateOf(c.daysSince, c.segment));
  assert.deepEqual(wrong.map((c) => `${c.clientKey}: ${c.state} при ${c.daysSince} дн. (${c.segment})`), [],
    "🔴 стан рахується НЕ від останньої оплати або НЕ за порогом сегмента");

  // 🔴 ДОКАЗ, ЩО ПОПЕРЕДНЯ ПЕРЕВІРКА НЕ ПОРОЖНЯ. Якби сегментні пороги не
  // застосовувались, `stateOf(days, segment)` збігався б із `stateOf(days)` на
  // ВСІХ рядках — і тест був би зеленим, нічого не перевіряючи. Вимагаємо, щоб
  // хоч один рядок відрізняв дві редакції правила.
  const segmentMattered = data.clients.filter((c) => rules.stateOf(c.daysSince, c.segment)
    !== rules.stateOf(c.daysSince));
  assert.ok(segmentMattered.length > 0,
    "🔴 сегментний поріг не змінив стан ЖОДНОГО клієнта — перевірка вище нічого не доводить");

  // Друга дата присутня як поле в кожного (значення може бути null — це відповідь).
  // ⚠️ Поле зветься `lastTalk` (КОНТАКТ = РОЗМОВА), НЕ `lastCall`: перейменування
  // приїхало з ядром, а гейт лишався зі старою назвою — і `lastCall` був `undefined`
  // у ВСІХ, тобто перевірка «хоч у когось є дзвінок» падала на порожньому місці.
  assert.ok(data.clients.every((c) => "lastTalk" in c && "lastTalkDays" in c),
    "🔴 у рядку немає полів останньої розмови — довідкова дата не доїхала до фронту");
  const withCall = data.clients.filter((c) => c.lastTalk != null);
  assert.ok(withCall.length > 0,
    `🔴 ЖОДЕН із ${data.clients.length} клієнтів не має розмови — порожній результат це ПРОВАЛ, `
    + "а не «дзвінків немає»: звʼязка ringostat_calls.client_key не працює");
  assert.ok(withCall.every((c) => c.lastTalkDays != null && c.lastTalkDays >= 0),
    "🔴 є дата розмови без коректної кількості днів");
});

test("#30n ЖОРСТКИЙ ПОДІЛ: активні + сплячі + втрачені = кваліфікована база, разові НАЗВАНІ", needsApi(), async () => {
  // 🔴 ПИТАННЯ, НА ЯКЕ ВІДПОВІДАЄ ЦЕЙ ГЕЙТ. Екран планів показує ~164 клієнти
  // замість 1 137 — і це ПРАВИЛЬНО: спрацювали дві різні зміни правил (жорсткий
  // поділ за станом + двошляхова кваліфікація). Але рівно так само виглядало б,
  // якби сотні клієнтів просто загубились у джойні. Різницю робить одне: сума
  // частин має дорівнювати цілому, і кожна відрізана купка має бути НАЗВАНА.
  //
  // Такий випадок уже був, і не гіпотетично: внутрішній `JOIN` до сегментів
  // викидав клієнта, у якого 2+ оплат, але в жодної не проставлена дата закриття
  // (на проді `0674673308`, 3 оплати, 0 дат). Він зникав з ОБОХ екранів мовчки.
  const token = await adminToken();
  const plans = await (await get("/api/dashboard/client-plans", token)).json() as {
    clients: { clientKey: string; segment: string }[];
    totals: { totalClients: number; inReactivation: number;
              inReactivationSleeping: number; inReactivationLost: number;
              longLapsedCount: number; oneOff: number; skippedGeneric: number;
              activeBySegment: Record<string, number> };
  };
  const t = plans.totals;
  assert.ok(plans.clients.length > 0, "🔴 активних немає — інваріант нічого не доводить");
  assert.equal(t.inReactivation, t.inReactivationSleeping + t.inReactivationLost,
    "🔴 місток не дорівнює сумі своїх частин");
  assert.ok(t.inReactivation > 0,
    "🔴 місток порожній — або поділу немає, або сплячих не порахували; і те, і те приховало б клієнтів");
  assert.ok(t.oneOff > 0,
    "🔴 разових НУЛЬ — кваліфікація не застосувалась, або її результат не названо числом");

  // 🗄 Архів — ПІДМНОЖИНА втрачених, а не четверта купка. Якби його додавали в Σ,
  // втрачені порахувались би двічі; тому перевіряємо саме вкладеність.
  assert.ok(t.longLapsedCount <= t.inReactivationLost,
    `🔴 архівних ${t.longLapsedCount} більше за втрачених ${t.inReactivationLost} — `
    + "архів перестав бути підмножиною, і Σ почне подвоюватись");
  assert.ok(t.longLapsedCount > 0, "🔴 архів порожній — межа 365 днів не застосувалась");

  // Розбивка активних по сегментах = кількості активних. Інакше «ВІП 60 · Регулярних 25»
  // під таблицею описувало б якийсь інший набір.
  const segSum = Object.values(t.activeBySegment).reduce((s, v) => s + v, 0);
  assert.equal(segSum, t.totalClients, `🔴 Σ сегментів ${segSum} ≠ активних ${t.totalClients}`);

  // ГОЛОВНЕ: активні + сплячі + втрачені + разові = УСІ клієнти з 2+ оплатами.
  // Знаменник рахуємо НЕЗАЛЕЖНО від роуту — прямо з БД.
  const { pool } = await import("../db/pool.js");
  const metrics = await import("../core/metrics.js");
  const whole = Number((await pool.query<{ n: string }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND NOT (d.client_key = ANY($1))
     ),
     agg AS (SELECT client_key FROM paid GROUP BY client_key HAVING COUNT(*) >= 2),
     per_cm AS (SELECT client_key, manager_id, COUNT(*) n FROM paid GROUP BY 1,2),
     pm AS (SELECT DISTINCT ON (client_key) client_key, manager_id FROM per_cm ORDER BY client_key, n DESC)
     SELECT COUNT(*) AS n FROM agg a
       JOIN pm ON pm.client_key = a.client_key
       LEFT JOIN loyalty_overrides lo ON lo.client_key = a.client_key
       JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id) AND mm.is_active
      WHERE COALESCE(lo.hidden, false) = false`, [metrics.GENERIC_CLIENT_KEYS])).rows[0].n);
  assert.equal(t.totalClients + t.inReactivation + t.oneOff + t.skippedGeneric, whole,
    `🔴 активні ${t.totalClients} + місток ${t.inReactivation} + разові ${t.oneOff}`
    + ` + дженерики ${t.skippedGeneric} ≠ база ${whole} — хтось зник між екранами, і без цієї`
    + " перевірки це виглядало б як «клієнтів стало менше»");
  console.log(`   ℹ активних ${t.totalClients} · сплячих ${t.inReactivationSleeping}`
    + ` · втрачених ${t.inReactivationLost} (з них архів ${t.longLapsedCount})`
    + ` · разових ${t.oneOff} · дженериків ${t.skippedGeneric} · разом ${whole}`);
});

test("#30p МІСТОК == ВКЛАДЦІ: обіцяне число дорівнює тому, що в реактивації лежить", needsApi(), async () => {
  // 🔴 РЕАЛЬНА РОЗБІЖНІСТЬ, ЗНАЙДЕНА СКРІНШОТОМ, А НЕ ЧИТАННЯМ. Місток на екрані
  // планів обіцяв **631**, а вкладка «Реактивація» показувала **456**. Обидві цифри
  // рахувались правильно — просто місток брав їх ДО фільтра телефонних дженериків,
  // а список ПІСЛЯ. Поруч це читається як поломка, і саме так його читав власник.
  //
  // Перевіряємо не «схоже», а РІВНІСТЬ: скільки місток обіцяє — стільки сплячих і
  // втрачених має віддати `/reactivation-list` у тому самому скоупі.
  const token = await adminToken();
  const plans = await (await get("/api/dashboard/client-plans", token)).json() as {
    totals: { inReactivation: number; inReactivationSleeping: number; inReactivationLost: number };
  };
  const react = await (await get("/api/dashboard/reactivation-list", token)).json() as {
    clients: { state: string }[];
  };
  const sleeping = react.clients.filter((c) => c.state === "sleeping").length;
  const lost = react.clients.filter((c) => c.state === "lost").length;
  assert.ok(sleeping + lost > 0, "🔴 у реактивації порожньо — порівнювати нема з чим");
  assert.equal(plans.totals.inReactivationSleeping, sleeping,
    `🔴 місток обіцяє ${plans.totals.inReactivationSleeping} сплячих, у вкладці ${sleeping}`);
  assert.equal(plans.totals.inReactivationLost, lost,
    `🔴 місток обіцяє ${plans.totals.inReactivationLost} втрачених, у вкладці ${lost}`);
  assert.equal(plans.totals.inReactivation, sleeping + lost,
    "🔴 підсумок містка не дорівнює сумі рядків вкладки");
});

test("#30o ДЖЕНЕРИКИ-ТЕЛЕФОНИ: без безналу — геть, із безналом — ЗАЛИШАЮТЬСЯ", needsApi(), async () => {
  // 🪞 ДЗЕРКАЛЬНА ПАРА до правила «телефонні дженерики геть із реактивації».
  // Односторонній тест («ключів-телефонів немає») зеленів би й тоді, якби фільтр
  // вирізав ВСІХ — а серед них є справжні фірми з кривим ключем, і саме тому
  // виняток для безготівкових узагалі існує.
  const token = await adminToken();
  const data = await (await get("/api/dashboard/reactivation-list", token)).json() as {
    clients: { clientKey: string; paymentType?: string | null }[];
  };
  const phoneKeys = data.clients.filter((c) => /^[0-9]+$/.test(c.clientKey));
  assert.ok(phoneKeys.length > 0,
    "🔴 у списку НЕМАЄ жодного ключа-телефона — виняток для безготівкових не працює, "
    + "фільтр вирізає всіх підряд (порожній результат це ПРОВАЛ, а не «таких немає»)");

  // Другий бік: у БД таких ключів помітно більше, ніж у видачі — тобто фільтр
  // справді щось прибирає, а не пропускає все.
  const { pool } = await import("../db/pool.js");
  const metrics = await import("../core/metrics.js");
  const inDb = Number((await pool.query<{ n: string }>(
    `WITH paid AS (
       SELECT d.client_key FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND NOT (d.client_key = ANY($1))
     )
     SELECT COUNT(*) AS n FROM (
       SELECT client_key FROM paid GROUP BY client_key HAVING COUNT(*) >= 2
     ) q WHERE client_key ~ '^[0-9]+$'`, [metrics.GENERIC_CLIENT_KEYS])).rows[0].n);
  assert.ok(inDb > phoneKeys.length,
    `🔴 у видачі ${phoneKeys.length} ключів-телефонів із ${inDb} у базі — фільтр не прибрав нікого`);
  console.log(`   ℹ ключів-телефонів: у базі ${inDb}, у видачі ${phoneKeys.length} (решта — без безналу)`);
});

test("#30l КАРТКА: дії керування видно ТОМУ, кому роут їх дозволяє", needsApi(), async () => {
  // 🪞 ДЗЕРКАЛЬНА ПАРА, і вона тут обовʼязкова. Односторонній тест («менеджер не
  // бачить кнопки») зеленів би й тоді, якби кнопки не бачив НІХТО — тобто саме в
  // стані, який ми щойно виправляли: дія без входу.
  //
  // 🗄 ПЕРЕЦІЛЕНО 05.08.2026 з `canHide` на `canArchive`. Причина — не косметика:
  // `hidden` хвиля 2 перестала писати, роут перестав його віддавати, і кнопка в
  // картці мовчки нічого не робила. Гейт мусить дивитись на ДІЮ, яка справді
  // існує, інакше він стереже привид. Звіряємось із тим самим `isAdminScope`,
  // що гейтить POST /dashboard/client-archive.
  const token = await adminToken();
  const list = await (await get("/api/dashboard/client-plans", token)).json() as { clients: { clientKey: string }[] };
  const key = list.clients[0]?.clientKey;
  assert.ok(key, "🔴 немає жодного клієнта — перевірка порожня");

  const asAdmin = await (await get("/api/dashboard/client-card?clientKey=" + encodeURIComponent(key), token)).json() as
    { canArchive?: boolean; archived?: boolean; archiveReasons?: unknown[] };
  assert.equal(asAdmin.canArchive, true,
    "🔴 адмін не бачить дії «в архів» — вхід так і лишився втраченим");
  assert.equal(typeof asAdmin.archived, "boolean",
    "🔴 картка не каже, чи клієнт уже в архіві — кнопка не знатиме, який бік показати");
  assert.ok(Array.isArray(asAdmin.archiveReasons) && asAdmin.archiveReasons.length > 0,
    "🔴 картка не дала словника причин — селектор був би порожній, а причина ОБОВʼЯЗКОВА");

  // Другий бік: тімлід картку бачить (вкладка `loyalty` в нього є), але права
  // архівувати не має — і сервер мусить сказати це сам, а не покластись на те,
  // що фронт «не намалює». При цьому обʼєднання в межах СВОЄЇ команди йому
  // відкрито, тож дзеркало перевіряє обидва боки однієї картки.
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
    { canArchive?: boolean; canMerge?: boolean; mergeScope?: string; months?: unknown[] };
  assert.equal(asLead.canArchive, false,
    "🔴 тімлід бачить кнопку архівації, яка на сервері дасть 403 — дозвіл і кнопка розійшлись");
  assert.equal(asLead.canMerge, true,
    "🔴 тімліду закрили обʼєднання — це вже не межа, а втрачена дія (дзеркало до рядка вище: "
    + "якби ми різали права всім підряд, перша перевірка теж зеленіла б)");
  assert.equal(asLead.mergeScope, "team",
    "🔴 тімліду віддали скоуп обʼєднання «all» — форма пропонувала б пари, на яких сервер дасть 403");
  assert.ok(Array.isArray(asLead.months) && asLead.months.length === 12,
    "🔴 тімліду не віддалась сама картка — це вже не межа, а поломка екрана");
});

test("#30m ЛІДОГЕНЕРАЦІЯ: менеджеру 403, тімліду — ЛИШЕ його команда", needsApi(), async () => {
  // 🪞 ДЗЕРКАЛЬНА ТРІЙКА. Односторонній тест («менеджер не бачить») зеленів би й
  // тоді, якби екран був зламаний для всіх — тобто в стані, гіршому за проблему.
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const lead = await someTeamLead();

  // (а) МЕНЕДЖЕР — 403. Екран показує розподіл заявок МІЖ менеджерами.
  const mgrToken = signToken({ userId: 0, role: rbac.scopeCompatRole("manager", rbac.getRoleDef("manager")),
    roleKey: "manager", managerId: 1, teamId: lead.teamId });
  const asMgr = await get("/api/dashboard/leadgen", mgrToken);
  assert.equal(asMgr.status, 403, `🔴 менеджер дістав екран лідогенерації: ${asMgr.status}`);

  // (б) ДЗЕРКАЛО: адмін бачить УСІ команди — інакше (а) нічого не доводить.
  const all = await (await get("/api/dashboard/leadgen", await adminToken())).json() as
    { groups: { teamName: string; leads: number }[]; unit: string; dimensionNote: string };
  assert.ok(all.groups.length > 0,
    "🔴 адмін не бачить жодної групи — порожнеча доводить не межу, а поломку");
  assert.ok(/передач/i.test(all.unit),
    "🔴 відповідь не називає одиницю лічби — 358 і 260 читались би як та сама цифра");
  assert.ok(/отримал|ЯКОМУ/i.test(all.dimensionNote),
    "🔴 відповідь не називає розріз — стара назва над іншою цифрою");

  // (в) ТІМЛІД — лише своя команда, і кламп мусить бути на СЕРВЕРІ.
  const asLead = await (await get("/api/dashboard/leadgen", lead.token)).json() as
    { groups: { teamName: string }[] };
  const foreign = asLead.groups.map((g) => g.teamName).filter((n) => n !== lead.teamName);
  assert.deepEqual(foreign, [],
    `🔴 тімлід команди «${lead.teamName}» бачить чужі команди: ${foreign.join(", ")}`);
  if (all.groups.length > 1) {
    assert.ok(asLead.groups.length < all.groups.length,
      "🔴 тімлід і адмін бачать однаково — кламп не діє");
  }
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
