import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsDb, API_BASE } from "../testMode.js";

/**
 * ТЕСТ #5 — RBAC-МАТРИЦЯ. Найважливіше в наборі.
 *
 * Перевіряє СЕРВЕР, а не фронт. Питання не «чи показує UI вкладку», а «чи віддасть
 * бекенд дані тому, кому не можна» — фронт можна обійти curl-ом, сервер ні.
 *
 * 🔴 НАВІЩО САМЕ ЗАРАЗ: далі за спринтом ідемо прибирати ~100 розсипаних
 * `role === 'admin'`. Без цієї матриці така правка робиться наосліп — вона і є
 * страховка під неї: зафіксувати ПОТОЧНУ поведінку, щоб рефакторинг не розширив
 * доступ мовчки.
 *
 * Три рівні:
 *  1. МАТРИЦЯ ЕКРАНІВ — чисті резолвери (`roleHasTab`), без мережі.
 *  2. МАТРИЦЯ ЕНДПОІНТІВ — живі HTTP-виклики токеном КОЖНОЇ ролі: 2xx там, де можна,
 *     403/404 там, де ні. Саме тут ловиться «фронт сховав, сервер віддав».
 *  3. СКОУП ДАНИХ — тімлід бачить СВОЮ команду, менеджер СЕБЕ: не просто «дозволено»,
 *     а «віддано рівно стільки, скільки належить».
 */

const load = async () => ({
  rbac: await import("./rbac.js"),
  signToken: (await import("./auth.js")).signToken,
  pool: (await import("../db/pool.js")).pool,
});

/** Ролі з БД: вбудовані + кастомні, які реально роздані людям. */
const ROLES = ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager"] as const;
type Role = (typeof ROLES)[number];

/**
 * ОЧІКУВАНА МАТРИЦЯ ЕКРАНІВ. Це зліпок ПОТОЧНОЇ політики, а не побажання: тест має
 * впасти, якщо рефакторинг її змінить — навіть «на краще». Зміну політики роблять
 * свідомо, разом із правкою цієї таблиці.
 */
const TAB_MATRIX: Record<Role, { allow: string[]; deny: string[] }> = {
  admin:     { allow: ["overview", "report", "kvp", "settings", "teams"], deny: [] },
  ceo:       { allow: ["overview", "report", "kvp"], deny: [] },
  opdir:     { allow: ["overview", "report", "kvp", "settings"], deny: [] },
  kvp:       { allow: ["overview", "report", "kvp", "settings"], deny: [] },
  // 🟢 ЗМІНА ПОЛІТИКИ 31.07.2026 (рішення власника): ФІНАНСИСТ = РІВЕНЬ АДМІНА.
  // Було `deny: ["kvp","settings","overview","report"]` — тепер усе це ДОЗВОЛЕНО.
  // Не регресія і не «розширився доступ мовчки»: роль вирівняно до admin навмисно,
  // замість попереднього плану «немає вкладки → закрити ендпоінт», який скасовано.
  // Винятки лишились правами, а не екранами: reset_passwords і manage_users.
  financier: { allow: ["receivables", "kvp", "settings", "overview", "report", "bank"], deny: [] },
  hr:        { allow: ["tasks", "training"], deny: ["overview", "report", "kvp", "settings", "receivables", "teams", "managers", "loyalty"] },
  team_lead: { allow: ["overview", "report", "teams", "managers"], deny: ["kvp", "settings"] },
  manager:   { allow: ["overview", "report", "tasks"], deny: ["kvp", "settings", "teams", "managers"] },
};

test("#5.1 МАТРИЦЯ ЕКРАНІВ: кожна роль бачить рівно свої вкладки", needsDb(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  const problems: string[] = [];
  for (const role of ROLES) {
    const def = rbac.getRoleDef(role);
    assert.ok(def, `ролі «${role}» немає в БД — матриця перевіряє неіснуюче`);
    for (const tab of TAB_MATRIX[role].allow) {
      if (!rbac.roleHasTab(role, tab)) problems.push(`${role} МАЄ бачити «${tab}», але не бачить`);
    }
    for (const tab of TAB_MATRIX[role].deny) {
      if (rbac.roleHasTab(role, tab)) problems.push(`🔴 ${role} НЕ має бачити «${tab}», а бачить`);
    }
  }
  assert.deepEqual(problems, [], "розбіжності з матрицею:\n  " + problems.join("\n  "));
});

test("#5.2 SCOPE-COMPAT: до admin піднімається рівно той, хто має admin_scope", needsDb(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  const got = Object.fromEntries(ROLES.map((r) => [r, rbac.scopeCompatRole(r, rbac.getRoleDef(r))]));
  assert.deepEqual(got, {
    admin: "admin", ceo: "admin", opdir: "admin", kvp: "admin",
    // 🟢 ЗМІНА ПОЛІТИКИ 31.07.2026: financier піднято до admin (рішення власника).
    financier: "admin",
    // 🔴 hr — company-scope з 31.07.2026, але НЕ адмін. Саме тут ловиться blanket-правило
    // «company → admin», яке відкрило б їй усе: підняття вирішує ПРАВО admin_scope,
    // якого в HR немає. Значення 'company' збігається з тим, що мав фінансист до підйому —
    // і це рівно те, що доводить #5.13.
    hr: "company", team_lead: "team_lead", manager: "manager",
  }, "піднесення ролі до admin змінилось — перевір scopeCompatRole");
});

test("#5.2b ЕКВІВАЛЕНТНІСТЬ: перехід зі списку ключів на право нікого не зрушив", needsDb(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  // Було: `key === "ceo" || key === "opdir" || key === "kvp"` зашито в rbac.ts.
  // Стало: право `admin_scope` у БД. Це РЕФАКТОРИНГ поверх зміни політики, і його
  // легко зробити непомітно шкідливим — тому звіряємо стару логіку з новою для КОЖНОЇ
  // ролі. Розбіжність дозволена РІВНО одна: financier, і саме її власник і замовив.
  const legacy = (key: string, def: ReturnType<typeof rbac.getRoleDef>) => {
    if (key === "admin" || key === "ceo" || key === "opdir" || key === "kvp") return "admin";
    if (key === "team_lead") return "team_lead";
    if (key === "manager") return "manager";
    const scope = def?.dataScope ?? "own";
    return scope === "own" ? "manager" : scope === "team" ? "team_lead" : "company";
  };
  const diffs = ROLES
    .map((r) => ({ r, was: legacy(r, rbac.getRoleDef(r)), now: rbac.scopeCompatRole(r, rbac.getRoleDef(r)) }))
    .filter((x) => x.was !== x.now);
  assert.deepEqual(diffs, [{ r: "financier", was: "company", now: "admin" }],
    "перехід на admin_scope зрушив НЕ ту роль (або не зрушив ту, що мав): "
      + JSON.stringify(diffs));
});

// ─────────────────────── 2. ЖИВІ ЕНДПОІНТИ ───────────────────────

interface EndpointCase {
  path: string;
  /** Ролі, яким сервер МАЄ віддати 2xx. Решта — має відмовити. */
  allow: Role[];
  note: string;
}

const ENDPOINTS: EndpointCase[] = [
  { path: "/api/dashboard/overview?from=2026-06-01&to=2026-06-30",
    // 🟢 financier доданий 31.07.2026 — зміна політики, не регресія.
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"],
    note: "огляд: фінансист відкритий (рівень адміна); HR сюди не ходить" },
  { path: "/api/settings",
    allow: ["admin", "ceo", "opdir", "kvp", "financier"],
    note: "налаштування: підняті до admin через admin_scope — задокументовано" },
  { path: "/api/settings/users",
    // kvp сюди НЕ пускають (403), хоч він і admin за скоупом: керування людьми
    // гейтиться окремим правом, не роллю. Це навмисно — фіксуємо.
    allow: ["admin", "ceo", "opdir"],
    note: "керування користувачами — окреме право поверх ролі" },
  { path: "/api/bank/accounts",
    // Реєстр рахунків відкритий усім автентифікованим НАВМИСНО (чипи фільтра у Виписці).
    // HR не має вкладки «bank» узагалі → 403. Питання не «хто може викликати»,
    // а «що саме віддається» — див. окремий тест #5.6 нижче.
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"],
    note: "реєстр рахунків — доступ по вкладці, HR не має" },
  { path: "/api/dashboard/receivables",
    allow: ["admin", "ceo", "opdir", "kvp", "financier", "team_lead", "manager"],
    note: "дебіторка: фінансист відкритий 31.07.2026; HR не має" },
];

test("#5.3 МАТРИЦЯ ЕНДПОІНТІВ: сервер відмовляє тим, кому не можна", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const tok = (role: Role) => signToken({
    userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)), roleKey: role,
    managerId: role === "manager" ? 8 : null, teamId: role === "team_lead" ? 5 : null,
  });
  const problems: string[] = [];
  let checked = 0;
  for (const ep of ENDPOINTS) {
    for (const role of ROLES) {
      const res = await fetch(`${API_BASE}${ep.path}`, { headers: { Authorization: `Bearer ${tok(role)}` } });
      const ok2xx = res.status >= 200 && res.status < 300;
      const shouldAllow = ep.allow.includes(role);
      checked++;
      if (shouldAllow && !ok2xx) problems.push(`${role} МАЄ доступ до ${ep.path} → отримав ${res.status} (${ep.note})`);
      if (!shouldAllow && ok2xx) problems.push(`🔴 ${role} НЕ має доступу до ${ep.path} → сервер віддав ${res.status} (${ep.note})`);
    }
  }
  assert.ok(checked > 0, "жодного виклику не зроблено — тест нічого не довів");
  assert.deepEqual(problems, [], `порушення матриці (перевірено ${checked} пар роль×ендпоінт):\n  ` + problems.join("\n  "));
});

test("#5.4 БЕЗ ТОКЕНА — жодних даних", needsApi(), async () => {
  for (const p of ENDPOINTS.map((e) => e.path)) {
    const res = await fetch(`${API_BASE}${p}`);
    assert.ok(res.status === 401 || res.status === 403,
      `${p} без токена віддав ${res.status} — має бути 401/403`);
  }
});

// ─────────────────────── 3. СКОУП ДАНИХ ───────────────────────

test("#5.5 СКОУП: тімлід бачить лише свою команду, менеджер — лише себе", needsApi(), async () => {
  const { signToken, rbac, pool } = await load();
  await rbac.refreshRoles();
  const q = "from=2026-06-01&to=2026-06-30";
  // Менеджера й команду беремо З ДАНИХ, а не хардкодом: захардкоджений id одного дня
  // виявляється тімлідом без власних угод, тест падає — і виглядає як зламаний скоуп.
  // ⚠️ Вибірка має збігатися з тією ПОПУЛЯЦІЄЮ, яку рахує /overview: воронка Повного
  // циклу. Перший підхід брав будь-які угоди 142 — і витягнув фінвідділ (754 угоди
  // поза FC), у якого гроші в огляді = 0. Тест падав так, ніби зламано скоуп, хоча
  // зламаний був сам підбір. Некомерційні команди (лідоген 11, фінанси 12) виключено.
  const pick = await pool.query<{ manager_id: number; team_id: number }>(
    `SELECT d.manager_id, m.team_id FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE d.status_id = 142 AND m.team_id IS NOT NULL AND m.team_id NOT IN (11, 12)
        AND d.pipeline_id = ANY($1)
        AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN '2026-06-01' AND '2026-06-30'
      GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 1`, [[8921932, 155304]]);
  assert.ok(pick.rows[0], "у червні 2026 немає жодного менеджера з угодами — тест нічого не доведе");
  const { manager_id, team_id } = pick.rows[0];

  const get = async (roleKey: Role, managerId: number | null, teamId: number | null) => {
    const t = signToken({ userId: 0, role: rbac.scopeCompatRole(roleKey, rbac.getRoleDef(roleKey)),
      roleKey, managerId, teamId });
    const r = await fetch(`${API_BASE}/api/dashboard/overview?${q}`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 200, `${roleKey}: overview віддав ${r.status}`);
    return (await r.json()) as { closedRevenue?: number };
  };
  const all = await get("admin", null, null);
  const lead = await get("team_lead", null, team_id);
  const mgr = await get("manager", manager_id, null);

  assert.ok(Number(all.closedRevenue) > 0, "адмін бачить порожній період — тест нічого не доводить");
  assert.ok(Number(lead.closedRevenue) > 0, `тімлід команди #${team_id} бачить 0 — скоуп зламано`);
  assert.ok(Number(mgr.closedRevenue) > 0, `менеджер #${manager_id} бачить 0, хоча має угоди — скоуп зламано`);
  assert.ok(Number(lead.closedRevenue) < Number(all.closedRevenue),
    `🔴 тімлід бачить ${lead.closedRevenue} при відділі ${all.closedRevenue} — скоуп команди НЕ звужує`);
  assert.ok(Number(mgr.closedRevenue) <= Number(lead.closedRevenue),
    `🔴 менеджер бачить ${mgr.closedRevenue} більше за свою команду ${lead.closedRevenue}`);
  assert.ok(Number(mgr.closedRevenue) < Number(all.closedRevenue),
    `🔴 менеджер бачить стільки ж, скільки відділ — власний скоуп НЕ звужує`);
});

/**
 * #5.6 — 🔴 ЗНАЙДЕНО 31.07.2026. Питання не «хто може викликати ендпоінт», а «що саме
 * сервер поклав у відповідь». `/api/bank/accounts` відкритий усім автентифікованим
 * навмисно (чипи фільтра у «Виписці»), АЛЕ віддає повні реквізити компанії — IBAN,
 * ЄДРПОУ, директора, юридичну адресу, МФО і `key_card` — рядовому менеджеру.
 * Гейтиться лише `env_key_name` (назва змінної), а не самі реквізити.
 *
 * Для чипів фільтра потрібні label/company/bank/currency. Решта — фінансові дані.
 * Тест ЧЕРВОНИЙ навмисно: це знахідка до рішення власника, а не привід тихо
 * записати «менеджеру можна». Зелений він стане, коли реквізити віддаватимуться
 * лише за правом (manage_bank_accounts / view_balances), або коли власник свідомо
 * підтвердить, що так і треба — тоді правимо очікування разом із рішенням.
 */
test("#5.6 РЕКВІЗИТИ: менеджер і тімлід їх ОТРИМУЮТЬ", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  // 🟢 ЗМІНА ПОЛІТИКИ 31.07.2026 (рішення власника). Тест НЕ видалено, а ПЕРЕВЕРНУТО:
  // раніше він вимагав, щоб цих полів у менеджера НЕ було. Тепер вимагає протилежного —
  // менеджер щодня виставляє клієнту рахунок, ключ-карту й заводили, щоб він її давав
  // клієнту на оплату. Факт «поля їдуть усім» був поданий правильно; помилковим був
  // ВИРОК «це витік». Перевернутий тест — щоб обмеження не повернули «як фікс».
  const REQUISITES = ["iban", "key_card", "edrpou_ipn", "director", "legal_address", "mfo"] as const;
  const missing: string[] = [];
  let checked = 0;
  for (const role of ["manager", "team_lead"] as Role[]) {
    const t = signToken({ userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)),
      roleKey: role, managerId: role === "manager" ? 8 : null, teamId: role === "team_lead" ? 5 : null });
    const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 200, `${role}: /bank/accounts віддав ${r.status}`);
    const j = (await r.json()) as { accounts?: Record<string, unknown>[] };
    assert.ok(j.accounts && j.accounts.length > 0,
      `${role}: список рахунків порожній — тест нічого не доводить (порожній результат = провал)`);
    checked += j.accounts.length;
    // Поле МАЄ бути присутнім у відповіді. Значення може бути порожнім у конкретного
    // рахунку (не всі мають ключ-карту) — тому перевіряємо наявність КЛЮЧА, а окремо
    // вимагаємо, щоб хоч десь було непорожнє значення: інакше «відсів зрізав усе»
    // виглядало б як «політика застосована».
    for (const f of REQUISITES) {
      if (!j.accounts.some((a) => f in a)) missing.push(`${role} не отримує поле ${f} ЖОДНОГО рахунку`);
      if (!j.accounts.some((a) => a[f] != null && String(a[f]).length > 0)) {
        missing.push(`${role}: поле ${f} присутнє, але порожнє в УСІХ рахунках`);
      }
    }
  }
  assert.ok(checked > 0, "жодного рахунку не перевірено");
  assert.deepEqual([...new Set(missing)], [],
    "🔴 реквізити НЕ доходять до менеджера/тімліда — це ламає виставлення рахунку клієнту:\n  "
      + [...new Set(missing)].join("\n  "));
});
test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});

/**
 * #5.7 — ДЗЕРКАЛО до #5.6. Заборона без дозволу нічого не варта: якщо «полагодити»
 * витік, вирізавши поля ВСІМ, тест #5.6 позеленіє, а Виписка зламається мовчки.
 * Тому окремо перевіряємо, що той, кому МОЖНА, реквізити ОТРИМУЄ.
 *
 * ⚠️ Історія: у першій спробі цей тест не потрапив у файл (правка не застосувалась,
 * я цього не помітив), і фікс #5.6 поїхав у прод із перевіреною лише однією гілкою.
 */
test("#5.7 РЕКВІЗИТИ: адмін і фінансист теж отримують (дзеркало до #5.6)", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  for (const role of ["admin", "financier"] as Role[]) {
    const t = signToken({ userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)),
      roleKey: role, managerId: null, teamId: null });
    const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 200, `${role}: /bank/accounts віддав ${r.status}`);
    const j = (await r.json()) as { accounts?: Record<string, unknown>[] };
    assert.ok(j.accounts && j.accounts.length > 0, `${role}: список рахунків порожній — провал`);
    const withIban = j.accounts.filter((a) => a.iban != null && String(a.iban).length > 0);
    assert.ok(withIban.length > 0,
      `🔴 ${role} МАЄ бачити реквізити, а IBAN не прийшов у жодному рахунку — відсів зрізав зайве`);
  }
});

/** #5.8 Ключ-карта — номер платіжної картки. Окреме твердження, щоб не загубилось. */
test("#5.8 КЛЮЧ-КАРТА видима всім автентифікованим", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  // 🟢 ЗМІНА ПОЛІТИКИ 31.07.2026: ключ-карта — це РЕКВІЗИТ для оплати від фізосіб,
  // а не секрет. Її й додавали, щоб менеджер давав номер клієнту. Тест перевернуто.
  let checked = 0;
  const blind: string[] = [];
  for (const role of ROLES) {
    const t = signToken({ userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)),
      roleKey: role, managerId: role === "manager" ? 8 : null, teamId: role === "team_lead" ? 5 : null });
    const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: { Authorization: `Bearer ${t}` } });
    if (r.status === 403) continue; // немає вкладки «bank» (hr) — питання не про поля
    assert.equal(r.status, 200, `${role}: /bank/accounts віддав ${r.status}`);
    const j = (await r.json()) as { accounts?: Record<string, unknown>[] };
    assert.ok(j.accounts && j.accounts.length > 0, `${role}: список порожній — тест нічого не доводить`);
    checked += j.accounts.length;
    if (!j.accounts.some((a) => a.key_card != null && String(a.key_card).length > 0)) {
      blind.push(`${role} не бачить ключ-карти в ЖОДНОМУ рахунку`);
    }
  }
  assert.ok(checked > 0, "жодного рахунку не перевірено");
  assert.deepEqual(blind, [], "🔴 ключ-карта не доходить до ролі, яка має її бачити:\n  " + blind.join("\n  "));
});

test("#5.8b МЕЖА ЛИШИЛАСЬ: без токена не віддається НІЧОГО", needsApi(), async () => {
  // Дзеркало до #5.8. «Реквізити бачать усі» = усі АВТЕНТИФІКОВАНІ, а не «усі в
  // інтернеті». Без цієї пари попередній тест зеленів би й тоді, якби ендпоінт став
  // публічним — і ми б це прочитали як «політику застосовано».
  // ⚠️ Значення заголовка МАЄ бути ASCII: `new Headers()` кидає ByteString-помилку на
  // кирилиці ще до запиту, і тест падав би не на тому, що перевіряє. Спіймано на
  // прийманні 31.07.2026 — перша версія цього тесту мала «Bearer не-токен».
  for (const headers of [{}, { Authorization: "Bearer invalid.jwt.value" }]) {
    const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: headers as HeadersInit });
    assert.ok(r.status === 401 || r.status === 403,
      `🔴 /bank/accounts без валідного токена віддав ${r.status} — реквізити стали публічними`);
    const body = await r.text();
    assert.ok(!/iban|key_card/i.test(body),
      "🔴 у відповіді неавтентифікованому є реквізити");
  }
});
// ─────────────────── HR · COMPANY-SCOPE (зміна політики 31.07.2026) ───────────────────
/**
 * HR отримав `data_scope='company'` — те, що ухвалили ще 29.07, але що не доїхало
 * через `ON CONFLICT DO NOTHING`. Наслідок: `auth.role` став `'company'` замість
 * `'manager'`, і зник кламп `managerId=-1`, який робив усі екрани HR порожніми.
 *
 * 🔴 Кожна межа — ОКРЕМЕ твердження. Найважливіше — #5.13: `'company'` це РІВНО те
 * значення, яке мав фінансист, доки не піднявся до адміна. Треба довести, що HR не
 * поїхав за ним.
 */

test("#5.9 HR НЕ бачить ЧУЖІ особисті задачі (приватність не залежить від scope)", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const t = signToken({ userId: 0, role: rbac.scopeCompatRole("hr", rbac.getRoleDef("hr")),
    roleKey: "hr", managerId: null, teamId: null });
  const r = await fetch(`${API_BASE}/api/tasks`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(r.status, 200, `HR: /tasks віддав ${r.status}`);
  const j = (await r.json()) as { tasks?: { id: number; assigneeId: number | null }[] };
  assert.ok(j.tasks && j.tasks.length > 0,
    "HR не отримав ЖОДНОЇ задачі — тест нічого не доводить (порожній результат = провал)");
  // Особиста задача = БЕЗ виконавця. Приватність тримається на `assignee_id IS NULL`
  // у SQL-гілці, а НЕ на scope — саме тому company-scope її не відкриває. Токен має
  // userId=0, тож жодна чужа особиста сюди потрапити не може.
  const foreignPersonal = j.tasks.filter((x) => x.assigneeId == null);
  assert.deepEqual(foreignPersonal.map((x) => x.id), [],
    "🔴 HR отримав особисті задачі інших акаунтів — приватність протекла");
});

test("#5.10 HR НЕ бачить 1×1 інших кондукторів", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const t = signToken({ userId: 0, role: rbac.scopeCompatRole("hr", rbac.getRoleDef("hr")),
    roleKey: "hr", managerId: null, teamId: null });
  // HR має право `view_all_1x1` — наскрізний доступ вирішує САМЕ воно, не scope.
  // Тут перевіряємо межу: без вказаного суб'єкта записів чужих зустрічей не видають.
  const r = await fetch(`${API_BASE}/api/one-on-ones/record/A/999999`,
    { headers: { Authorization: `Bearer ${t}` } });
  assert.ok(r.status === 200 || r.status === 404,
    `HR: несподіваний статус ${r.status} на 1×1 неіснуючого менеджера`);
  if (r.status === 200) {
    const j = (await r.json()) as { answers?: unknown[]; record?: unknown };
    assert.ok(!j.record || (Array.isArray(j.answers) && j.answers.length === 0),
      "🔴 HR отримав вміст 1×1 по неіснуючому суб'єкту — скоуп зустрічей протікає");
  }
});

test("#5.11 HR НЕ має вкладки «bank» — ні до зміни scope, ні після", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  assert.equal(rbac.roleHasTab("hr", "bank"), false,
    "🔴 HR отримав вкладку «bank» — реквізити й Виписка не її робота");
  const t = signToken({ userId: 0, role: rbac.scopeCompatRole("hr", rbac.getRoleDef("hr")),
    roleKey: "hr", managerId: null, teamId: null });
  const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(r.status, 403, `🔴 сервер віддав HR /bank/accounts зі статусом ${r.status}`);
  const body = await r.text();
  assert.ok(!/iban|key_card/i.test(body), "🔴 у відповіді HR є реквізити");
});

test("#5.12 duty: HR ЧИТАЄ, але редагувати не може", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const t = signToken({ userId: 0, role: rbac.scopeCompatRole("hr", rbac.getRoleDef("hr")),
    roleKey: "hr", managerId: null, teamId: null });
  // Читання — так: це календар відділу, свідоме розширення (рішення власника).
  const read = await fetch(`${API_BASE}/api/duty/`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(read.status, 200, `🔴 HR не читає duty (${read.status}) — company-scope не спрацював`);
  // Запис — ні: canEdit = admin | team_lead. Ціль свідомо неіснуюча + тіло невалідне,
  // тож навіть якби гейт впав, записати нема чого.
  const write = await fetch(`${API_BASE}/api/duty/`, {
    method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ __probe__: "невалідне тіло" }),
  });
  assert.equal(write.status, 403, `🔴 HR дозволено писати в duty (${write.status}) — має бути 403`);
});

test("#5.13 🔴 HR НЕ успадкував нічого з того, що отримав фінансист", needsDb(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  const hr = rbac.getRoleDef("hr")!;
  const fin = rbac.getRoleDef("financier")!;
  // Обидві ролі тепер company-scope, але фінансист піднятий до АДМІНА правом
  // `admin_scope`, а HR — ні. Значення `auth.role='company'` збіглося; профілі — ні.
  // HR тепер РІВНО 'company' — те саме значення, що мав фінансист до підйому.
  // ⚠️ Перша версія цього рядка вимагала 'manager' (стара поведінка при own-scope) —
  // тест почервонів і тим довів, що читає реальний резолвер, а не мій намір.
  const hrCompat = rbac.scopeCompatRole("hr", hr);
  assert.equal(hrCompat, "company",
    `HR має бути 'company' після зміни scope, а не '${hrCompat}'`);
  assert.notEqual(hrCompat, "admin",
    "🔴 HR піднявся до admin — company-scope НЕ дає цього без права admin_scope");
  const perms = Object.entries(hr.permissions).filter(([, v]) => v === true).map(([k]) => k).sort();
  assert.deepEqual(perms, ["edit_1x1_forms", "view_all_1x1"],
    `🔴 набір прав HR змінився: ${perms.join(", ")} — очікували рівно два 1×1-права`);
  // Жодного з прав, які фінансист дістав при підйомі до адміна.
  const gained = ["admin_scope", "approve_plans", "enter_manual_stats", "export",
    "manage_bank_accounts", "manage_bank_hidden", "manage_goals", "submit_plans",
    "view_hidden_payments", "view_balances", "view_bank_totals", "view_cashflow"];
  const leaked = gained.filter((p) => hr.permissions[p] === true);
  assert.deepEqual(leaked, [],
    `🔴 HR отримав права фінансиста: ${leaked.join(", ")}`);
  const screens = Object.entries(hr.screenAccess).filter(([, v]) => v === true).map(([k]) => k).sort();
  assert.deepEqual(screens,
    ["documents", "duty", "feedback", "messenger", "news", "oneonone", "tasks", "training"],
    `🔴 набір екранів HR змінився: ${screens.join(", ")}`);
  // Дзеркало: фінансист МАЄ бути адміном — інакше тест зеленів би й тоді, коли
  // підйом фінансиста зламався, і «HR не успадкував» не доводило б нічого.
  assert.equal(rbac.scopeCompatRole("financier", fin), "admin",
    "фінансист більше не адмін — порівняння втратило сенс");
});

test("#5.14 ЕКВІВАЛЕНТНІСТЬ: isAdminScope == старий вираз по ролі, для КОЖНОЇ ролі", needsDb(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  // Партії рефакторингу міняють 51 рядок у роутах. Заміна вважається безпечною лише
  // тому, що нова функція дає ТОЙ САМИЙ вердикт, що й вираз, який вона заміняє.
  // Перевіряємо це для кожної ролі, а не «на око по одній».
  const diffs: string[] = [];
  for (const role of ROLES) {
    const compat = rbac.scopeCompatRole(role, rbac.getRoleDef(role));
    const auth = { role: compat, roleKey: role };
    const was = compat === "admin";                       // рівно старий вираз у роутах
    const now = rbac.isAdminScope(auth);
    if (was !== now) diffs.push(`${role}: було ${was}, стало ${now}`);
    const wasLead = compat === "admin" || compat === "team_lead";
    const nowLead = rbac.isAdminOrLead(auth);
    if (wasLead !== nowLead) diffs.push(`${role} (з тімлідом): було ${wasLead}, стало ${nowLead}`);
  }
  assert.deepEqual(diffs, [],
    "🔴 хелпер дає ІНШИЙ вердикт, ніж вираз, який він заміняє — рефакторинг змінив би поведінку:\n  "
      + diffs.join("\n  "));
  // Дзеркало: функція має вміти казати «ні». Інакше `return true` пройшов би цей тест
  // для ролей-адмінів і мовчки відкрив би все іншим.
  assert.equal(rbac.isAdminScope({ role: "manager", roleKey: "manager" }), false,
    "🔴 isAdminScope каже «так» менеджеру");
  assert.equal(rbac.isAdminOrLead({ role: "manager", roleKey: "manager" }), false,
    "🔴 isAdminOrLead каже «так» менеджеру");
  assert.equal(rbac.isAdminScope({ role: "manager", roleKey: "__немає_такої_ролі__" }), false,
    "🔴 невідома роль дає адмінський рівень");
});

/**
 * #16 — FAIL-CLOSED РОЛЬ-КЕШУ. Найсерйозніша знахідка спринту.
 *
 * Було: `roleHasTab`/`roleHasPerm` при порожньому кеші віддавали `true` ВСІМ. Разом із
 * `.finally(listen)` це означало, що збій `refreshRoles` на старті лишав сервер
 * працювати з відкритими гейтами — включно з `reset_passwords`, `manage_users`,
 * `view_balances`. І не лікувалось: періодичного refresh не існувало.
 */
test("#16 FAIL-CLOSED: порожній роль-кеш ВІДМОВЛЯЄ, а не дозволяє", needsDb(), async () => {
  // Свіжий модуль без жодного refreshRoles — кеш гарантовано порожній.
  const fresh = await import(`./rbac.js?empty=${Date.now()}`);
  assert.equal(fresh.rolesCacheSize(), 0, "кеш мав бути порожнім — тест не про те");
  assert.equal(fresh.roleHasTab("manager", "settings"), false,
    "🔴 порожній кеш дозволив вкладку — це старий fail-open");
  assert.equal(fresh.roleHasPerm("manager", "reset_passwords"), false,
    "🔴 порожній кеш дозволив reset_passwords — рівно та дірка, яку закривали");
  assert.equal(fresh.roleHasPerm("admin", "manage_users"), false,
    "🔴 порожній кеш дозволив manage_users навіть без завантажених ролей");
});

test("#16b ДЗЕРКАЛО: із завантаженим кешем гейти працюють як раніше", needsDb(), async () => {
  // Без цієї пари #16 зеленів би й тоді, якби функції почали віддавати false ЗАВЖДИ —
  // тобто повністю зламаний RBAC виглядав би як «надійно закрито».
  const { rbac } = await load();
  await rbac.refreshRoles();
  assert.ok(rbac.rolesCacheSize() > 0, "кеш не завантажився — далі перевіряти нема що");
  assert.equal(rbac.roleHasTab("admin", "settings"), true, "🔴 адмін втратив «Налаштування»");
  assert.equal(rbac.roleHasTab("manager", "settings"), false, "менеджер не має бачити налаштування");
  assert.equal(rbac.roleHasPerm("admin", "manage_users"), true, "🔴 адмін втратив manage_users");
  assert.equal(rbac.roleHasPerm("manager", "reset_passwords"), false, "менеджер не має скидати паролі");
});

test("#16c СИГНАЛІЗАЦІЯ знає про порожній кеш", needsDb(), async () => {
  const fresh = await import(`./rbac.js?state=${Date.now()}`);
  const st = fresh.rolesCacheState();
  assert.equal(st.size, 0);
  assert.equal(st.ageMinutes, null, "кеш ніколи не завантажувався → вік має бути null");
});
