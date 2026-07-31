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
  // ✅ 31.07.2026, рішення власника: дебіторка — буквально робота фінансиста, 403 був
  // конфіг-недоглядом. Відкрито ЕКРАНОМ (screen_access), не хардкодом по ролі.
  financier: { allow: ["receivables"], deny: ["kvp", "settings", "overview", "report"] },
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

test("#5.2 SCOPE-COMPAT: тільки ceo/opdir/kvp піднімаються до admin", needsDb(), async () => {
  const { rbac } = await load();
  await rbac.refreshRoles();
  const got = Object.fromEntries(ROLES.map((r) => [r, rbac.scopeCompatRole(r, rbac.getRoleDef(r))]));
  assert.deepEqual(got, {
    admin: "admin", ceo: "admin", opdir: "admin", kvp: "admin",
    // 🔴 financier і hr теж company/own-scope, але АДМІНАМИ бути не мають.
    // Саме тут ловиться blanket-правило «company → admin», яке відкрило б їм усе.
    financier: "company", hr: "manager", team_lead: "team_lead", manager: "manager",
  }, "піднесення ролі до admin змінилось — перевір scopeCompatRole");
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
    allow: ["admin", "ceo", "opdir", "kvp", "team_lead", "manager"],
    note: "огляд: фінансист і HR сюди не ходять" },
  { path: "/api/settings",
    allow: ["admin", "ceo", "opdir", "kvp"],
    note: "налаштування: ceo/opdir/kvp підняті до admin через scopeCompatRole — задокументовано" },
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
test("#5.6 РЕКВІЗИТИ: сервер не віддає IBAN/ключ-карту тим, хто не веде фінанси", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  const SENSITIVE = ["iban", "key_card", "edrpou_ipn", "vat_ipn", "director", "legal_address", "bank_edrpou", "mfo"] as const;
  const leaks: string[] = [];
  for (const role of ["manager", "team_lead"] as Role[]) {
    const t = signToken({ userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)),
      roleKey: role, managerId: role === "manager" ? 8 : null, teamId: role === "team_lead" ? 5 : null });
    const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: { Authorization: `Bearer ${t}` } });
    if (r.status !== 200) continue; // немає доступу до ендпоінта — питання зняте
    const j = (await r.json()) as { accounts?: Record<string, unknown>[] };
    assert.ok(j.accounts && j.accounts.length > 0,
      "список рахунків порожній — тест нічого не доводить (порожній результат = провал)");
    for (const acc of j.accounts) {
      for (const f of SENSITIVE) {
        const v = acc[f];
        if (v != null && String(v).length > 0) leaks.push(`${role} бачить ${f} рахунку «${acc.label}»`);
      }
    }
  }
  assert.deepEqual([...new Set(leaks)], [],
    "🔴 фінансові реквізити віддаються поза фінансовими ролями:\n  " + [...new Set(leaks)].join("\n  "));
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
test("#5.7 РЕКВІЗИТИ: хто веде фінанси — отримує їх повністю", needsApi(), async () => {
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
test("#5.8 КЛЮЧ-КАРТА: номерів карток немає у відповіді менеджера й тімліда", needsApi(), async () => {
  const { signToken, rbac } = await load();
  await rbac.refreshRoles();
  let checked = 0;
  for (const role of ["manager", "team_lead"] as Role[]) {
    const t = signToken({ userId: 0, role: rbac.scopeCompatRole(role, rbac.getRoleDef(role)),
      roleKey: role, managerId: role === "manager" ? 8 : null, teamId: role === "team_lead" ? 5 : null });
    const r = await fetch(`${API_BASE}/api/bank/accounts`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 200, `${role}: /bank/accounts віддав ${r.status}`);
    const j = (await r.json()) as { accounts?: Record<string, unknown>[] };
    assert.ok(j.accounts && j.accounts.length > 0, `${role}: список порожній — тест нічого не доводить`);
    checked += j.accounts.length;
    const leaked = j.accounts.filter((a) => "key_card" in a && a.key_card != null);
    assert.deepEqual(leaked.map((a) => a.label), [],
      `🔴 ${role} отримав номери ключ-карт — це номери платіжних карток`);
  }
  assert.ok(checked > 0, "жодного рахунку не перевірено");
});
