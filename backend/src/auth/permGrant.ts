/**
 * БІЛЕ СИТО ПРАВ: що взагалі можна видати, і хто саме може це видати.
 *
 * 🔴 Привід — заміряна дірка (27.08.2026). `validRolePayload` пропускав обʼєкт прав
 * далі БЕЗ жодної перевірки ключів, а в БД на `roles.permissions` немає обмежень
 * (єдиний `CHECK` — на `data_scope`). Отже носій `manage_users` (admin/ceo/opdir)
 * міг створити кастомну роль із будь-яким набором прав і призначити її СОБІ:
 * самозахист у `PATCH /users/:id` блокує лише ПОНИЖЕННЯ, не підвищення.
 * Так адмін діставав `write_off_debt` і `view_all_1x1` — рівно ті два права, яких
 * власник йому свідомо не давав.
 *
 * 🔴 КАТАЛОГ ЖИВЕ В КОДІ, А НЕ В БД — і це не дрібниця, а напрямок перевірки.
 * Якби джерелом істини була таблиця `roles`, будь-який ключ, що колись у ній
 * опиниться, ставав би дозволеним АВТОМАТИЧНО: сито узаконювало б те, від чого
 * захищає, і робило б це тихо. Тому каталог тут, а гейт стверджує ВКЛЮЧЕННЯ:
 * кожен ключ, наявний у `roles`, мусить бути в цьому списку. Сміття в базі
 * червонить гейт замість того, щоб розширювати дозвіл.
 *
 * 📐 Заміряно ПЕРЕД написанням: у `roles.permissions` рівно 20 різних ключів, і всі
 * 20 нижче. Жодного «оголошений, але нікому не виданий» теж немає. Тобто гейт
 * зелений на здоровому проді з першого дня — інакше він був би тим самим шумом,
 * що й перевірка на підрядок «localhost» у бандлі.
 */
export const PERMISSION_CATALOG = [
  "admin_scope",
  "approve_plans",
  "edit_1x1_forms",
  "enter_manual_stats",
  "export",
  "manage_bank_accounts",
  "manage_bank_hidden",
  "manage_credit_limits",
  "manage_goals",
  "manage_users",
  "merge_clients",
  "merge_receivables",
  "reset_passwords",
  "submit_plans",
  "view_all_1x1",
  "view_balances",
  "view_bank_totals",
  "view_cashflow",
  "view_hidden_payments",
  "write_off_debt",
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOG)[number];

const CATALOG: ReadonlySet<string> = new Set<string>(PERMISSION_CATALOG);

export type GrantVerdict =
  | { ok: true; perms: Record<string, boolean> }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Перевіряє набір прав, який хочуть записати ролі.
 *
 * Два різні коди — бо це два різні твердження, і плутати їх не можна:
 * **400** = «такого права не існує» (зіпсоване тіло), **403** = «право є, але не ваше».
 *
 * ⚠️ ЗНЯТТЯ права (значення не `true`) дозволене навіть тому, хто його не має.
 * Свідомо: сито стереже ПІДВИЩЕННЯ привілеїв, а не зменшення. Заборонити зняття
 * означало б, що адмін без `write_off_debt` не може прибрати це право чужій ролі.
 */
export function validateGrant(requested: unknown, actorPerms: Iterable<string>): GrantVerdict {
  if (requested == null || typeof requested !== "object" || Array.isArray(requested)) {
    return { ok: false, status: 400, error: "permissions має бути обʼєктом" };
  }
  const held = new Set(actorPerms);
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(requested as Record<string, unknown>)) {
    if (!CATALOG.has(key)) {
      return { ok: false, status: 400, error: `Невідоме право «${key}» — його немає в каталозі прав` };
    }
    const on = raw === true;
    if (on && !held.has(key)) {
      return { ok: false, status: 403, error: `Не можна видати право «${key}»: у вас самих його немає` };
    }
    out[key] = on;
  }
  return { ok: true, perms: out };
}

/**
 * Ключі, що є в БД і яких НЕМАЄ в каталозі. Порожньо = дрейфу немає.
 * Саме в цей бік, а не навпаки: каталог може містити право, ще нікому не видане, —
 * це нормально; а от ключ у базі, про який код не знає, означає, що хтось завів
 * право повз каталог, і сито його не стереже.
 */
export function catalogGaps(dbKeys: Iterable<string>): string[] {
  return [...new Set(dbKeys)].filter((k) => !CATALOG.has(k)).sort();
}
